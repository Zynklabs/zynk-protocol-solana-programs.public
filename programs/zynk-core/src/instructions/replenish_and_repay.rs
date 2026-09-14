use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_error::ProgramError;
use anchor_spl::token_interface::{self, TokenAccount, TransferChecked};

use crate::*;

pub(crate) fn replenish_and_repay<'info>(
    ctx: Context<'_, '_, '_, 'info, ReplenishAndRepay<'info>>,
    zov_id: [u8; 32],
    amount: u64,
    repay_amount: u64,
    repay_shares: Vec<u64>,
    meta: Option<Vec<EventArg>>,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, CoreError::ContractPaused);
    require!(amount > 0 && repay_amount > 0, CoreError::InvalidOrder);
    require!(repay_amount <= amount, CoreError::InvalidOrder);

    let order_tracker = &mut ctx.accounts.order_tracker;
    let outstanding = order_tracker
        .amount_out
        .checked_sub(order_tracker.amount_in)
        .ok_or(CoreError::InvalidOrder)?;
    require!(repay_amount <= outstanding, CoreError::InvalidOrder);

    // Compute position-level and ZOV-level outstanding amounts.
    let position_outstanding = order_tracker
        .amount_borrowed
        .checked_sub(order_tracker.amount_repaid)
        .ok_or(CoreError::InvalidOrder)?;

    let pdv_seeds: &[&[u8]] = &[
        PARTNER_DEPOSIT_VAULT_SEED,
        order_tracker.partner_id.as_ref(),
        &[ctx.bumps.partner_deposit_vault],
    ];
    let replenish_accounts = TransferChecked {
        from: ctx.accounts.pdv_token_account.to_account_info(),
        to: ctx.accounts.zov_token_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        authority: ctx.accounts.partner_deposit_vault.to_account_info(),
    };
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            replenish_accounts,
            &[pdv_seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    let zov_seeds: &[&[u8]] = &[
        ZYNK_OP_VAULT_SEED,
        zov_id.as_ref(),
        &[ctx.bumps.zynk_op_vault],
    ];

    require!(
        repay_shares.len() == ctx.remaining_accounts.len(),
        CoreError::InvalidAccount
    );
    let total_shares = repay_shares.iter().try_fold(0u64, |acc, &s| {
        acc.checked_add(s).ok_or(ProgramError::ArithmeticOverflow)
    })?;

    // total_shares is the amount going to position holders.
    // It must not exceed the aggregate position outstanding.
    require!(
        total_shares <= position_outstanding,
        CoreError::InvalidOrder
    );

    // The remainder (repay_amount - total_shares) settles direct-ZOV debt.
    let zov_settlement = repay_amount
        .checked_sub(total_shares)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    if zov_settlement > 0 {
        // ZOV settlement is only permitted when all position debt is fully repaid
        // by this transaction (i.e., total_shares == position_outstanding).
        require!(
            total_shares == position_outstanding,
            CoreError::InvalidOrder
        );

        // ZOV borrowed = amount_out - amount_borrowed.
        // ZOV already repaid = amount_in - amount_repaid.
        // ZOV outstanding = ZOV borrowed - ZOV already repaid.
        let zov_borrowed = order_tracker
            .amount_out
            .checked_sub(order_tracker.amount_borrowed)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let zov_already_repaid = order_tracker
            .amount_in
            .checked_sub(order_tracker.amount_repaid)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        zov_borrowed
            .checked_sub(zov_already_repaid)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }

    for (dest_info, &share) in ctx.remaining_accounts.iter().zip(repay_shares.iter()) {
        if share == 0 {
            continue;
        }
        let dest_data = dest_info.try_borrow_data()?;
        let dest_token_account = TokenAccount::try_deserialize_unchecked(
            &mut &dest_data[..],
        )
        .map_err(|_| CoreError::InvalidAccount)?;
        require!(
            dest_token_account.mint == ctx.accounts.mint.key(),
            CoreError::InvalidTokenMint
        );
        require!(
            dest_info.key() != ctx.accounts.zov_token_account.key(),
            CoreError::InvalidAccount
        );
        drop(dest_data);

        let repay_accounts = TransferChecked {
            from: ctx.accounts.zov_token_account.to_account_info(),
            to: dest_info.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.zynk_op_vault.to_account_info(),
        };
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                repay_accounts,
                &[zov_seeds],
            ),
            share,
            ctx.accounts.mint.decimals,
        )?;
    }

    // Update position repaid tracking.
    order_tracker.amount_repaid = order_tracker
        .amount_repaid
        .checked_add(total_shares)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    // Update overall order repaid tracking (position shares + ZOV settlement).
    order_tracker.amount_in = order_tracker
        .amount_in
        .checked_add(repay_amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let order_closed = order_tracker.amount_in == order_tracker.amount_out;
    let order_id = order_tracker.order_id;
    let zynk_op_vault = order_tracker.zynk_op_vault.to_string();
    let partner_deposit_vault = ctx.accounts.partner_deposit_vault.key().to_string();

    emit!(OrderReplenished {
        order_id,
        zynk_op_vault,
        token: ctx.accounts.mint.key().to_string(),
        partner_deposit_vault,
        amount,
        order_closed,
        domain_separator: DOMAIN_SEPARATOR,
        meta,
    });

    if order_closed {
        close_account(order_tracker, &ctx.accounts.manager)?;
    }

    Ok(())
}

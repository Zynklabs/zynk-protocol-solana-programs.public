use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_error::ProgramError;
use anchor_spl::token_interface::{self, TransferChecked};

use crate::*;

pub(crate) fn replenish_and_repay(
    ctx: Context<ReplenishAndRepay>,
    zov_id: [u8; 32],
    amount: u64,
    repay_amount: u64,
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
    let repay_accounts = TransferChecked {
        from: ctx.accounts.zov_token_account.to_account_info(),
        to: ctx.accounts.destination_token_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        authority: ctx.accounts.zynk_op_vault.to_account_info(),
    };
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            repay_accounts,
            &[zov_seeds],
        ),
        repay_amount,
        ctx.accounts.mint.decimals,
    )?;

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

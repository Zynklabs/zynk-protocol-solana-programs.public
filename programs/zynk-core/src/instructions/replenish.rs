use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_error::ProgramError;
use anchor_spl::token_interface::{self, TransferChecked};

use crate::*;

pub(crate) fn replenish(
    ctx: Context<Replenish>,
    amount: u64,
    close_order: bool,
    meta: Option<Vec<EventArg>>
) -> Result<()> {
    // Check if program is paused.
    require!(!ctx.accounts.config.paused, CoreError::ContractPaused);

    let order_tracker = &mut ctx.accounts.order_tracker;
    let partner_deposit_vault = &ctx.accounts.partner_deposit_vault;

    if amount > 0 {
        // Perform token transfer from pdv_token_account to zov_token_account.
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.pdv_token_account.to_account_info(),
            to: ctx.accounts.zov_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: partner_deposit_vault.to_account_info(),
        };
        let seeds = &[
            PARTNER_DEPOSIT_VAULT_SEED,
            order_tracker.partner_id.as_ref(),
            &[ctx.bumps.partner_deposit_vault],
        ];
        let signer_seeds = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        order_tracker.amount_in = order_tracker.amount_in
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    } else {
        require!(order_tracker.amount_in >= order_tracker.amount_out, CoreError::DeficientOrder);
    }

    // If close_order flag is true, perform order closure
    if close_order {
        // Check if order_tracker's amount_in is greater than or equal to the order_tracker's amount_out
        require!(order_tracker.amount_in >= order_tracker.amount_out, CoreError::DeficientOrder);

        // Close the order_tracker account (transfer lamports to manager and clear data)
        close_account(&mut *order_tracker, &ctx.accounts.manager)?;
    }

    emit!(OrderReplenished {
        order_id: order_tracker.order_id,
        zynk_op_vault: order_tracker.zynk_op_vault.to_string(),
        token: ctx.accounts.mint.key().to_string(),
        partner_deposit_vault: partner_deposit_vault.key().to_string(),
        amount,
        order_closed: close_order,
        domain_separator: DOMAIN_SEPARATOR,
        meta
    });

    Ok(())
}

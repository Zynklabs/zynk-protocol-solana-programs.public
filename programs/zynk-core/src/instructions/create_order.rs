use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TransferChecked};

use crate::*;

pub(crate) fn create_order(
    ctx: Context<CreateOrder>,
    partner_id: [u8; 32],
    order_id: [u8; 32],
    zov_id: [u8; 32],
    transient: bool,
    amount: u64,
    meta: Option<Vec<EventArg>>
) -> Result<()> {
    // Check if program is paused.
    let config = &ctx.accounts.config;
    require!(!config.paused, CoreError::ContractPaused);
    require!(
        ctx.accounts.beneficiary.allow_transient || !transient,
        CoreError::InvalidBeneficiary
    );

    let beneficiary_wallet = ctx.accounts.beneficiary_token_account.owner.key();
    let partner_deposit_vault = ctx.accounts.partner_deposit_vault.key();
    let zynk_op_vault = ctx.accounts.zynk_op_vault.key();

    if amount != 0 {
        // Perform token transfer from zov_token_account to beneficiary_token_account.
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.zov_token_account.to_account_info(),
            to: ctx.accounts.beneficiary_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.zynk_op_vault.to_account_info(),
        };

        let seeds = &[
            ZYNK_OP_VAULT_SEED,
            zov_id.as_ref(),
            &[ctx.bumps.zynk_op_vault],
        ];
        let signer_seeds = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;
    }

    let order_tracker = &mut ctx.accounts.order_tracker;
    if transient {
        close_account(order_tracker, &ctx.accounts.manager)?;
    } else {
        order_tracker.partner_id = partner_id;
        order_tracker.order_id = order_id;
        order_tracker.amount_out = amount;
        order_tracker.zynk_op_vault = zynk_op_vault;
        order_tracker.beneficiary_wallet = beneficiary_wallet;
        order_tracker.partner_deposit_vault = partner_deposit_vault;
        order_tracker.mint = ctx.accounts.mint.key();
    }

    emit!(OrderCreated {
        order_id,
        zynk_op_vault: zynk_op_vault.to_string(),
        beneficiary_wallet: beneficiary_wallet.to_string(),
        token: ctx.accounts.mint.key().to_string(),
        partner_deposit_vault: partner_deposit_vault.to_string(),
        amount,
        transient,
        domain_separator: DOMAIN_SEPARATOR,
        meta
    });

    Ok(())
}

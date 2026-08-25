use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TransferChecked};

use crate::*;

pub(crate) fn pull_and_create_order(
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
    require!(amount > 0, CoreError::InvalidOrder);

    let beneficiary_wallet = ctx.accounts.beneficiary_token_account.owner.key();
    let partner_deposit_vault = &ctx.accounts.partner_deposit_vault;
    let zynk_op_vault = &ctx.accounts.zynk_op_vault;
    let pdv_token_account = ctx.accounts.pdv_token_account.as_ref().ok_or(CoreError::InvalidAccount)?;

    require!(pdv_token_account.owner == partner_deposit_vault.key(), CoreError::InvalidAccount);
    require!(pdv_token_account.mint == ctx.accounts.zov_token_account.mint, CoreError::InvalidTokenMint);

    // Perform token transfer from pdv_token_account to zov_token_account.
    let cpi_accounts = TransferChecked {
        from: pdv_token_account.to_account_info(),
        to: ctx.accounts.zov_token_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        authority: partner_deposit_vault.to_account_info(),
    };

    let seeds = &[
        PARTNER_DEPOSIT_VAULT_SEED,
        partner_id.as_ref(),
        &[ctx.bumps.partner_deposit_vault],
    ];
    let signer_seeds = &[&seeds[..]];
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

    // Perform token transfer from zov_token_account to beneficiary_token_account.
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.zov_token_account.to_account_info(),
        to: ctx.accounts.beneficiary_token_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        authority: zynk_op_vault.to_account_info(),
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

    let order_tracker = &mut ctx.accounts.order_tracker;
    if transient {
        close_account(order_tracker, &ctx.accounts.manager)?;
    } else {
        order_tracker.partner_id = partner_id;
        order_tracker.order_id = order_id;
        order_tracker.amount_in = amount;
        order_tracker.amount_out = amount;
        order_tracker.zynk_op_vault = zynk_op_vault.key();
        order_tracker.beneficiary_wallet = beneficiary_wallet;
        order_tracker.partner_deposit_vault = partner_deposit_vault.key();
        order_tracker.mint = ctx.accounts.mint.key();
    }

    emit!(OrderCreated {
        order_id,
        zynk_op_vault: zynk_op_vault.key().to_string(),
        beneficiary_wallet: beneficiary_wallet.to_string(),
        token: ctx.accounts.mint.key().to_string(),
        partner_deposit_vault: partner_deposit_vault.key().to_string(),
        amount,
        transient,
        domain_separator: DOMAIN_SEPARATOR,
        meta
    });

    Ok(())
}

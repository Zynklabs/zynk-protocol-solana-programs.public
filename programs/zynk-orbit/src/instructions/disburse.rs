use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TransferChecked};
use zynk_core;

use crate::*;
use crate::utils::*;

pub(crate) fn disburse(ctx: Context<Disburse>, vault_id: [u8; 32], amount: u64) -> Result<()> {
    let user = &mut ctx.accounts.user;

    let config = &ctx.accounts.config;
    require!(
        ctx.accounts.manager.key() == config.manager,
        zynk_core::CoreError::Unauthorized
    );

    require!(
        config.whitelisted_token_mints.contains(&ctx.accounts.mint.key()),
        zynk_core::CoreError::InvalidTokenMint
    );

    require!(
        is_whitelisted_wallet(user, &ctx.accounts.destination_token_account.owner),
        zynk_core::CoreError::InvalidAccount
    );

    let seeds: &[&[u8]] = &[VAULT_SEED, vault_id.as_ref(), &[ctx.bumps.spender]];
    let signer_seeds = &[&seeds[..]];

    let cpi_accounts = TransferChecked {
        from: ctx.accounts.source_token_account.to_account_info(),
        to: ctx.accounts.destination_token_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        authority: ctx.accounts.spender.to_account_info(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

    emit!(TxEvent {
        event_name: "Disburse".to_string(),
        user_id: user.user_id,
        from_owner: ctx.accounts.source_token_account.owner.key(),
        to_owner: ctx.accounts.destination_token_account.owner.key(),
        from: ctx.accounts.source_token_account.key(),
        to: ctx.accounts.destination_token_account.key(),
        amount,
        token: ctx.accounts.mint.key(),
        domain_separator: DOMAIN_SEPARATOR,
        order_id: [0u8; 32],
    });

    Ok(())
}

use anchor_lang::prelude::*;
use zynk_core;

use crate::*;
use crate::utils::*;

pub(crate) fn disburse(ctx: Context<Disburse>, amount: u64) -> Result<()> {
    require!(amount > 0, OrbitError::ZeroAmount);

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

    let ovault_bump_ref = [ctx.bumps.ovault];
    let signer_seeds = &[&[VAULT_SEED, b"orbit", &ovault_bump_ref][..]];

    transfer_with_signer_seeds(
        &ctx.accounts.token_program,
        &ctx.accounts.source_token_account.to_account_info(),
        &ctx.accounts.destination_token_account.to_account_info(),
        &ctx.accounts.mint,
        &ctx.accounts.ovault.to_account_info(),
        signer_seeds,
        amount,
    )?;

    emit!(TxEvent {
        event_name: "Disburse".to_string(),
        user_id: user.user_id,
        from_owner: ctx.accounts.ovault.key(),
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

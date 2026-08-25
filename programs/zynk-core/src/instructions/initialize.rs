use anchor_lang::prelude::*;

use crate::*;

pub(crate) fn initialize(
    ctx: Context<Initialize>,
    admin: Pubkey,
    guardian: Pubkey,
    whitelisted_token_mints: Vec<Pubkey>
) -> Result<()> {
    validate_address(&admin)?;
    validate_address(&guardian)?;

    let config = &mut ctx.accounts.config;
    config.paused = false;

    config.manager = ctx.accounts.manager.key();
    config.admin = admin;
    config.guardian = guardian;

    require!(whitelisted_token_mints.len() > 0, CoreError::EmptyWhitelistedTokenMints);
    for token_mint in whitelisted_token_mints.iter() {
        validate_address(token_mint)?;
    }
    validate_unique_token_mints(&whitelisted_token_mints)?;
    config.whitelisted_token_mints = whitelisted_token_mints;

    Ok(())
}

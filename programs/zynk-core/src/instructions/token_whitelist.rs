use anchor_lang::prelude::*;

use crate::*;

pub(crate) fn update_whitelisted_token_mint(
    ctx: Context<UpdateWhitelistedTokenMint>,
    action: WhitelistAction,
    mint: Pubkey,
) -> Result<()> {
    validate_address(&mint)?;

    let config = &mut ctx.accounts.config;

    match action {
        WhitelistAction::Add => {
            require!(
                !config.whitelisted_token_mints.contains(&mint),
                CoreError::TokenMintAlreadyWhitelisted
            );
            config.whitelisted_token_mints.push(mint);
        }
        WhitelistAction::Remove => {
            let pos = config
                .whitelisted_token_mints
                .iter()
                .position(|&m| m == mint)
                .ok_or(CoreError::TokenMintNotWhitelisted)?;
            require!(
                config.whitelisted_token_mints.len() > 1,
                CoreError::EmptyWhitelistedTokenMints
            );
            config.whitelisted_token_mints.swap_remove(pos);
        }
    }

    emit!(WhitelistedTokenMintsUpdated {
        action: match action {
            WhitelistAction::Add => String::from("add"),
            WhitelistAction::Remove => String::from("remove"),
        },
        mint,
        domain_separator: DOMAIN_SEPARATOR,
        whitelisted_token_mints: config.whitelisted_token_mints.clone(),
    });

    Ok(())
}

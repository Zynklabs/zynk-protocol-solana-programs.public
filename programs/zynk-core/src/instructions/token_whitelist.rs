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

            if let Some(ref acc) = ctx.accounts.mint {
                require!(acc.key() == mint, CoreError::InvalidTokenMint);
                validate_not_fee_bearing(acc)?;
            } else if let Some(acc) = ctx.remaining_accounts.iter().find(|acc| acc.key() == mint) {
                validate_not_fee_bearing(acc)?;
            } else {
                return Err(CoreError::InvalidTokenMint.into());
            }

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

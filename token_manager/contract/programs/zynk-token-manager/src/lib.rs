use anchor_lang::prelude::*;

declare_id!("GTN8hxXgSS34ChaDWDiyKp9R9oa6DWDTGyJotL6uou46");

// The chain id constant, as provided.
pub const CHAIN_ID: u64 = 1151111081099710;

#[program]
pub mod zynk_token_manager {
    use super::*;

    /// Initializes the TokenManager account.
    /// Sets the admin and starts with an empty token whitelist.
    pub fn initialize(ctx: Context<InitializeTokenManager>) -> Result<()> {
        let token_manager = &mut ctx.accounts.token_manager;
        token_manager.admin = *ctx.accounts.admin.key;
        token_manager.tokens = Vec::new();
        Ok(())
    }

    /// Adds a token to the whitelist.
    /// Only the current admin can add tokens.
    pub fn add_token(ctx: Context<ModifyTokenManager>, token: Pubkey) -> Result<()> {
        // Verify admin
        require_keys_eq!(
            ctx.accounts.token_manager.admin,
            ctx.accounts.admin.key(),
            ErrorCode::UnauthorizedAccess
        );

        let token_manager = &mut ctx.accounts.token_manager;
        if token_manager.tokens.contains(&token) {
            return Err(ErrorCode::TokenAlreadyExists.into());
        }
        token_manager.tokens.push(token);
        emit!(TokenAdded {
            token,
            chain_id: CHAIN_ID,
        });
        Ok(())
    }

    /// Removes a token from the whitelist.
    /// Only the current admin can remove tokens.
    pub fn remove_token(ctx: Context<ModifyTokenManager>, token: Pubkey) -> Result<()> {
        // Verify admin
        require_keys_eq!(
            ctx.accounts.token_manager.admin,
            ctx.accounts.admin.key(),
            ErrorCode::UnauthorizedAccess
        );

        let token_manager = &mut ctx.accounts.token_manager;
        let pos = token_manager
            .tokens
            .iter()
            .position(|x| *x == token)
            .ok_or(ErrorCode::TokenNotFound)?;
        token_manager.tokens.swap_remove(pos);
        emit!(TokenRemoved {
            token,
            chain_id: CHAIN_ID,
        });
        Ok(())
    }

    /// Updates the admin address.
    /// Only the current admin can update the admin address.
    pub fn update_admin(ctx: Context<UpdateAdminToken>, new_admin: Pubkey) -> Result<()> {
        // Verify admin
        require_keys_eq!(
            ctx.accounts.token_manager.admin,
            ctx.accounts.admin.key(),
            ErrorCode::UnauthorizedAccess
        );

        let token_manager = &mut ctx.accounts.token_manager;
        token_manager.admin = new_admin;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeTokenManager<'info> {
    /// The TokenManager account, initialized with a fixed space.
    #[account(init, payer = admin, space = TokenManager::LEN)]
    pub token_manager: Account<'info, TokenManager>,
    /// The admin initializing this account.
    #[account(mut)]
    pub admin: Signer<'info>,
    /// The system program.
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ModifyTokenManager<'info> {
    /// The TokenManager account (must be mutable and have the correct admin).
    #[account(mut)]
    pub token_manager: Account<'info, TokenManager>,
    /// The admin must sign.
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateAdminToken<'info> {
    /// The TokenManager account (must be mutable and have the correct admin).
    #[account(mut)]
    pub token_manager: Account<'info, TokenManager>,
    /// The admin must sign.
    pub admin: Signer<'info>,
}

/// The TokenManager account holds the admin and a whitelist of token mints.
#[account]
pub struct TokenManager {
    pub admin: Pubkey,
    pub tokens: Vec<Pubkey>,
}

impl TokenManager {
    /// Maximum number of tokens allowed.
    pub const MAX_TOKENS: usize = 300;
    /// Length of the account in bytes.
    pub const LEN: usize = 8 + // discriminator
        32 + // admin pubkey
        4 + (32 * Self::MAX_TOKENS); // vec len + vec data
}

#[event]
pub struct TokenAdded {
    pub token: Pubkey,
    pub chain_id: u64,
}

#[event]
pub struct TokenRemoved {
    pub token: Pubkey,
    pub chain_id: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Token already exists in the whitelist")]
    TokenAlreadyExists,
    #[msg("Token not found in the whitelist")]
    TokenNotFound,
    #[msg("Unauthorized: Only the current admin can perform this action")]
    UnauthorizedAccess,
}

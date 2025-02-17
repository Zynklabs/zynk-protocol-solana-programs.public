use anchor_lang::prelude::*;
use anchor_lang::solana_program::clock::Clock;
use anchor_lang::solana_program::keccak::hash;

declare_id!("FC5bGixHvLLTY4YzMw2LHNozj9JnnEeX3AUiKtcVDuvY");

// The chain id constant.
pub const CHAIN_ID: u64 = 1151111081099710;

#[program]
pub mod zynk_wallet_manager {
    use super::*;

    /// Initializes the WalletManager account.
    /// Sets the admin and starts with empty partner deposit and operational mappings.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let wallet_manager = &mut ctx.accounts.wallet_manager;
        wallet_manager.admin = *ctx.accounts.admin.key;
        wallet_manager.partner_deposit_wallets = Vec::new();
        wallet_manager.partner_operational_wallets = Vec::new();
        Ok(())
    }

    /// Adds (sets) a deposit wallet mapping for a given identifier.
    ///
    /// If a mapping with the provided identifier already exists, it returns an error.
    pub fn add_deposit_wallet(
        ctx: Context<ModifyMapping>,
        identifier: String,
        deposit_wallet: Pubkey,
    ) -> Result<()> {
        // Verify admin
        require_keys_eq!(
            ctx.accounts.wallet_manager.admin,
            ctx.accounts.admin.key(),
            ErrorCode::UnauthorizedAccess
        );

        let wallet_manager = &mut ctx.accounts.wallet_manager;

        // Enforce maximum identifier length.
        if identifier.len() > DepositMapping::MAX_IDENTIFIER_LENGTH {
            return Err(ErrorCode::IdentifierTooLong.into());
        }
        // Check if a deposit mapping with this identifier already exists.
        if wallet_manager
            .partner_deposit_wallets
            .iter()
            .any(|m| m.identifier == identifier)
        {
            return Err(ErrorCode::DepositMappingAlreadyExists.into());
        }
        // Check capacity.
        if wallet_manager.partner_deposit_wallets.len() >= WalletManager::MAX_DEPOSIT_MAPPINGS {
            return Err(ErrorCode::DepositMappingFull.into());
        }

        wallet_manager.partner_deposit_wallets.push(DepositMapping {
            identifier: identifier.clone(),
            deposit_wallet,
        });

        // Emit event: calculate the partner_id hash and get current time.
        let clock = Clock::get()?;
        let partner_id_hash = hash(identifier.as_bytes()).to_bytes();
        emit!(PartnerDepositWalletAdded {
            partner_id: partner_id_hash,
            wallet: deposit_wallet,
            time: clock.unix_timestamp as u64,
            chain_id: CHAIN_ID,
        });
        Ok(())
    }

    /// Removes (clears) the deposit wallet mapping for a given identifier.
    pub fn remove_deposit_wallet(ctx: Context<ModifyMapping>, identifier: String) -> Result<()> {
        // Verify admin
        require_keys_eq!(
            ctx.accounts.wallet_manager.admin,
            ctx.accounts.admin.key(),
            ErrorCode::UnauthorizedAccess
        );

        let wallet_manager = &mut ctx.accounts.wallet_manager;
        let pos = wallet_manager
            .partner_deposit_wallets
            .iter()
            .position(|m| m.identifier == identifier)
            .ok_or(ErrorCode::DepositMappingNotFound)?;
        // swap_remove returns the removed mapping.
        let removed = wallet_manager.partner_deposit_wallets.swap_remove(pos);
        let clock = Clock::get()?;
        let partner_id_hash = hash(removed.identifier.as_bytes()).to_bytes();
        emit!(PartnerDepositWalletRemoved {
            partner_id: partner_id_hash,
            wallet: removed.deposit_wallet,
            time: clock.unix_timestamp as u64,
            chain_id: CHAIN_ID,
        });
        Ok(())
    }

    /// Adds (sets) an operational wallet mapping for a given identifier.
    ///
    /// If a mapping with the provided identifier already exists, it returns an error.
    pub fn add_operational_wallet(
        ctx: Context<ModifyMapping>,
        identifier: String,
        operational_wallet: Pubkey,
    ) -> Result<()> {
        // Verify admin
        require_keys_eq!(
            ctx.accounts.wallet_manager.admin,
            ctx.accounts.admin.key(),
            ErrorCode::UnauthorizedAccess
        );

        let wallet_manager = &mut ctx.accounts.wallet_manager;

        // Enforce maximum identifier length.
        if identifier.len() > OperationalMapping::MAX_IDENTIFIER_LENGTH {
            return Err(ErrorCode::IdentifierTooLong.into());
        }
        // Check if an operational mapping with this identifier already exists.
        if wallet_manager
            .partner_operational_wallets
            .iter()
            .any(|m| m.identifier == identifier)
        {
            return Err(ErrorCode::OperationalMappingAlreadyExists.into());
        }
        // Check capacity.
        if wallet_manager.partner_operational_wallets.len()
            >= WalletManager::MAX_OPERATIONAL_MAPPINGS
        {
            return Err(ErrorCode::OperationalMappingFull.into());
        }

        wallet_manager
            .partner_operational_wallets
            .push(OperationalMapping {
                identifier: identifier.clone(),
                operational_wallet,
            });
        let clock = Clock::get()?;
        let partner_id_hash = hash(identifier.as_bytes()).to_bytes();
        emit!(PartnerOperationalWalletAdded {
            partner_id: partner_id_hash,
            wallet: operational_wallet,
            time: clock.unix_timestamp as u64,
            chain_id: CHAIN_ID,
        });
        Ok(())
    }

    /// Removes (clears) the operational wallet mapping for a given identifier.
    pub fn remove_operational_wallet(
        ctx: Context<ModifyMapping>,
        identifier: String,
    ) -> Result<()> {
        // Verify admin
        require_keys_eq!(
            ctx.accounts.wallet_manager.admin,
            ctx.accounts.admin.key(),
            ErrorCode::UnauthorizedAccess
        );

        let wallet_manager = &mut ctx.accounts.wallet_manager;
        let pos = wallet_manager
            .partner_operational_wallets
            .iter()
            .position(|m| m.identifier == identifier)
            .ok_or(ErrorCode::OperationalMappingNotFound)?;
        let removed = wallet_manager.partner_operational_wallets.swap_remove(pos);
        let clock = Clock::get()?;
        let partner_id_hash = hash(removed.identifier.as_bytes()).to_bytes();
        emit!(PartnerOperationalWalletRemoved {
            partner_id: partner_id_hash,
            wallet: removed.operational_wallet,
            time: clock.unix_timestamp as u64,
            chain_id: CHAIN_ID,
        });
        Ok(())
    }

    /// Updates the admin.
    /// Only the current admin can call this instruction.
    pub fn update_admin(ctx: Context<UpdateAdmin>, new_admin: Pubkey) -> Result<()> {
        // Verify admin
        require_keys_eq!(
            ctx.accounts.wallet_manager.admin,
            ctx.accounts.admin.key(),
            ErrorCode::UnauthorizedAccess
        );

        let wallet_manager = &mut ctx.accounts.wallet_manager;
        wallet_manager.admin = new_admin;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = WalletManager::LEN
    )]
    pub wallet_manager: Account<'info, WalletManager>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ModifyMapping<'info> {
    /// The WalletManager account must be mutable.
    #[account(mut)]
    pub wallet_manager: Account<'info, WalletManager>,
    /// The admin must sign the transaction.
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateAdmin<'info> {
    /// The WalletManager account must be mutable.
    #[account(mut)]
    pub wallet_manager: Account<'info, WalletManager>,
    /// The admin must sign the transaction.
    pub admin: Signer<'info>,
}

/// The account that stores the admin and the two separate mappings.
#[account]
pub struct WalletManager {
    /// The admin's public key.
    pub admin: Pubkey,
    /// Vector of partner deposit wallet mappings.
    pub partner_deposit_wallets: Vec<DepositMapping>,
    /// Vector of partner operational wallet mappings.
    pub partner_operational_wallets: Vec<OperationalMapping>,
}

impl WalletManager {
    /// Maximum allowed deposit mappings.
    pub const MAX_DEPOSIT_MAPPINGS: usize = 10;
    /// Maximum allowed operational mappings.
    pub const MAX_OPERATIONAL_MAPPINGS: usize = 10;
    /// Total account space needed:
    /// - 8 bytes for discriminator
    /// - 32 bytes for admin pubkey
    /// - 4 bytes for deposit mappings vec length
    /// - 10 * 100 bytes for deposit mappings (1000 bytes)
    /// - 4 bytes for operational mappings vec length
    /// - 10 * 100 bytes for operational mappings (1000 bytes)
    /// Total: 8 + 32 + 4 + 1000 + 4 + 1000 = 2048 bytes
    pub const LEN: usize = 8 +  // discriminator
        32 + // admin
        4 + (Self::MAX_DEPOSIT_MAPPINGS * DepositMapping::SIZE) + // deposit mappings vector
        4 + (Self::MAX_OPERATIONAL_MAPPINGS * OperationalMapping::SIZE); // operational mappings vector
}

/// A deposit mapping: identifier (a string) associated with a deposit wallet.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DepositMapping {
    pub identifier: String,
    pub deposit_wallet: Pubkey,
}

impl DepositMapping {
    /// Maximum allowed length for the identifier.
    pub const MAX_IDENTIFIER_LENGTH: usize = 64;
    // 4 bytes for length + 64 bytes max + 32 bytes for Pubkey.
    pub const SIZE: usize = 68 + 32; // 100 bytes total.
}

/// An operational mapping: identifier (a string) associated with an operational wallet.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OperationalMapping {
    pub identifier: String,
    pub operational_wallet: Pubkey,
}

impl OperationalMapping {
    /// Maximum allowed length for the identifier.
    pub const MAX_IDENTIFIER_LENGTH: usize = 64;
    pub const SIZE: usize = 68 + 32; // 100 bytes total.
}

#[error_code]
pub enum ErrorCode {
    #[msg("Identifier length exceeds the maximum allowed.")]
    IdentifierTooLong,
    #[msg("A deposit mapping with this identifier already exists.")]
    DepositMappingAlreadyExists,
    #[msg("Deposit mapping not found.")]
    DepositMappingNotFound,
    #[msg("The deposit mapping list is full.")]
    DepositMappingFull,
    #[msg("An operational mapping with this identifier already exists.")]
    OperationalMappingAlreadyExists,
    #[msg("Operational mapping not found.")]
    OperationalMappingNotFound,
    #[msg("The operational mapping list is full.")]
    OperationalMappingFull,
    #[msg("Unauthorized: Only the current admin can perform this action")]
    UnauthorizedAccess,
}

// =================================================================
// EVENTS

#[event]
pub struct PartnerDepositWalletAdded {
    pub partner_id: [u8; 32],
    pub wallet: Pubkey,
    pub time: u64,
    pub chain_id: u64,
}

#[event]
pub struct PartnerDepositWalletRemoved {
    pub partner_id: [u8; 32],
    pub wallet: Pubkey,
    pub time: u64,
    pub chain_id: u64,
}

#[event]
pub struct PartnerOperationalWalletAdded {
    pub partner_id: [u8; 32],
    pub wallet: Pubkey,
    pub time: u64,
    pub chain_id: u64,
}

#[event]
pub struct PartnerOperationalWalletRemoved {
    pub partner_id: [u8; 32],
    pub wallet: Pubkey,
    pub time: u64,
    pub chain_id: u64,
}

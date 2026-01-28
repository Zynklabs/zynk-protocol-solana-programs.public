use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_lang::solana_program::{
    pubkey::Pubkey,
    sysvar::instructions::{ ID as SYSVAR_IX_ID, load_instruction_at_checked },
    ed25519_program::ID as ED25519_ID,
    program_error::ProgramError,
    hash::hash
};

declare_id!("EMNqHAmpFnLsQdmoDbcDYJe9fny6Q42ALoNdH1Z5XZ3e");

pub const DOMAIN_SEPARATOR: u64 = 1151111081099710;

/// Stores the admin, zynk_op_wallet, the guardian, the manager,
/// along with the global paused flag.
#[account]
pub struct Config {
    pub admin: Pubkey,
    pub manager: Pubkey,
    pub guardian: Pubkey,
    pub zynk_op_wallet: Pubkey,
    pub whitelisted_token_mints: Vec<Pubkey>,
    pub paused: bool,
}

impl Config {
    pub fn space(n: u32) -> usize {
        return 8  + // discriminator
        32 + // admin
        32 + // manager
        32 + // guardian
        32 + // zynk_op_wallet
        4 + (32 * n as usize) + // whitelisted_token_mints
        1;   // paused
    }
}

#[account]
pub struct OrderTracker {
    pub order_id: [u8; 32],
    pub partner_id: [u8; 32],
    pub amount_in: u64,
    pub amount_out: u64,
    pub beneficiary_wallet: Pubkey,
    pub partner_deposit_vault: Pubkey,
}

impl OrderTracker {
    pub const LEN: usize = 8  + // discriminator
        32 + // order_id
        32 + // partner_id
        8  + // amount_in
        8  + // amount_out
        32 + // beneficiary_wallet
        32;  // partner_deposit_vault
}


#[account]
pub struct Request {
    pub action: u8,             // Enum tag for the action
    pub value: Pubkey       ,   // New value (wallet address)
    pub eta: i64,               // Earliest time the action can be executed
    pub executed: bool,         // Prevent double execution
    pub ack: bool,              // Acknowledgement flag (only by guardian)
    pub consensus: bool,        // Is consensus request?
}

impl Request {
    pub const LEN: usize = 8 + // discriminator
        1  + // action
        32 + // value
        8  + // eta
        1  + // executed
        1  + // ack
        1;   // consensus
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
#[repr(u8)]
pub enum ActionStatus {
    Initiated,
    Acked,
    Executed,
    Revoked
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
#[repr(u8)]
pub enum TimelockAction {
    TransferAdmin,
    UpdateManager,
    UpdateGuardian,
    UpdateZynkOpWallet,
    Unpause,
}

impl TimelockAction {
    pub fn delay(&self) -> i64 {
        match self {
            TimelockAction::TransferAdmin => 24 * 60 * 60,         // 24 hours
            TimelockAction::UpdateManager => 12 * 60 * 60,         // 12 hours
            TimelockAction::UpdateGuardian => 48 * 60 * 60,        // 48 hours
            TimelockAction::UpdateZynkOpWallet => 12 * 60 * 60,    // 12 hours
            TimelockAction::Unpause => 6 * 60 * 60,                // 6 hours
        }
    }
}

impl TryFrom<u8> for TimelockAction {
    type Error = CustomError;
    
    fn try_from(value: u8) -> std::result::Result<Self, Self::Error> {
        match value {
            0 => Ok(TimelockAction::TransferAdmin),
            1 => Ok(TimelockAction::UpdateManager),
            2 => Ok(TimelockAction::UpdateGuardian),
            3 => Ok(TimelockAction::UpdateZynkOpWallet),
            4 => Ok(TimelockAction::Unpause),
            _ => Err(CustomError::InvalidAction.into()),
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EventArg {
    pub key: String,
    pub value: String,
}

#[event]
pub struct OrderCreated {
    pub order_id: [u8; 32],
    pub beneficiary_wallet: Pubkey,
    pub token: Pubkey,
    pub partner_deposit_vault: Pubkey,
    pub amount: u64,
    pub transient: bool,
    pub domain_separator: u64,
    pub meta: Option<Vec<EventArg>>
}

#[event]
pub struct OrderReplenished {
    pub order_id: [u8; 32],
    pub token: Pubkey,
    pub partner_deposit_vault: Pubkey,
    pub amount: u64,
    pub order_closed: bool,
    pub domain_separator: u64,
    pub meta: Option<Vec<EventArg>>
}

#[event]
pub struct OrdersClosed {
    pub order_ids: Vec<[u8; 32]>,
    pub domain_separator: u64,
    pub meta: Option<Vec<EventArg>>
}

#[event]
pub struct OrderAttested {
    pub order_id: [u8; 32],
    pub origin_chain: String,
    pub target_chain: String,
    pub origin: String,
    pub proxy: String,
    pub target: String,
    pub txn: String,
    pub proxy_txn: Option<String>,
    pub asset: String,
    pub proxy_asset: Option<String>,
    pub amount: u64,
    pub domain_separator: u64,
    pub meta: Option<Vec<EventArg>>
}

#[event]
pub struct Action {
    pub action: u8,
    pub timelock: Pubkey,
    pub status: ActionStatus,
    pub timestamp: i64,
}


#[error_code]
pub enum CustomError {
    #[msg("Unauthorized signer")]
    UnauthorizedSigner,
    #[msg("Invalid address: cannot use null address")]
    InvalidAddress,
    #[msg("Contract is paused")]
    ContractPaused,
    #[msg("Unauthorized admin")]
    UnauthorizedAdmin,
    #[msg("Unauthorized manager")]
    UnauthorizedManager,
    #[msg("Unauthorized guardian")]
    UnauthorizedGuardian,
    #[msg("Invalid order")]
    InvalidOrder,
    #[msg("Invalid token mint")]
    InvalidTokenMint,
    #[msg("Validity must be in future")]
    ValidityMustBeFuture,
    #[msg("Deployed amount must be replenished")]
    DeficientOrder,
    #[msg("Invalid message in Ed25519 instruction")]
    InvalidEd25519Message,
    #[msg("Action under review")]
    ActionUnderReview,
    #[msg("Action already executed")]
    AlreadyExecuted,
    #[msg("Invalid action")]
    InvalidAction,
    #[msg("Invalid partner deposit vault authority")]
    InvalidPdvAuthority,
    #[msg("Whitelisted token mints must be non-empty")]
    EmptyWhitelistedTokenMints
}


/// Verifies an Ed25519 signature using the Solana Ed25519 program via sysvar instructions.
/// This function checks that the previous instruction was an Ed25519 signature verification
/// and validates the signer, message, and signature match the expected values.
pub fn verify_signature_syscall(
    ix_sysvar_account: &AccountInfo,
    signer_pubkey: &Pubkey,
    msg: String,
    signature: [u8; 64]
) -> Result<()> {
    let ed25519_instruction_result = load_instruction_at_checked(0, ix_sysvar_account);
    if ed25519_instruction_result.is_err() {
        return Err(ed25519_instruction_result.unwrap_err().into());
    }
    let ed25519_instruction = ed25519_instruction_result.unwrap();
    let data = &ed25519_instruction.data;

    let message: Vec<u8> = msg.into_bytes();
    if ed25519_instruction.program_id != ED25519_ID || ed25519_instruction.accounts.len() != 0 || data.len() != 16 + 32 + 64 + message.len() {
        return Err(ProgramError::InvalidInstructionData.into());
    }

    let data_pubkey = &data[16..48];
    let data_signature = &data[48..112];
    let data_message = &data[112..];
    if data_pubkey != &signer_pubkey.to_bytes() || data_signature != signature || data_message != message {
        return Err(CustomError::InvalidEd25519Message.into());
    }

    Ok(())
}

/// Helper function to validate an address is not the null address
pub fn validate_address(address: &Pubkey) -> Result<()> {
    require!(*address != Pubkey::default(), CustomError::InvalidAddress);
    Ok(())
}

/// Closes an account and transfers lamports to the given destination.
/// Also zeroes out the account data to prevent reuse.
pub fn close_account<'a, 'b>(from: impl ToAccountInfo<'a>, to: impl ToAccountInfo<'b>) -> Result<()> {
    let from = from.to_account_info();
    let to = to.to_account_info();

    **to.try_borrow_mut_lamports()? += **from.try_borrow_lamports()?;
    **from.try_borrow_mut_lamports()? = 0;
    from.try_borrow_mut_data()?.fill(0);
    
    Ok(())
}

#[program]
pub mod zynk_core {
    use super::*;

    /// Initializes the program configuration and core authority roles.
    ///
    /// # Arguments
    /// * `ctx` - The [`Initialize`] context containing the config and admin accounts.
    /// * `zynk_op_wallet` - The operator wallet authorized to move protocol funds.
    /// * `whitelisted_token_mints` - A non-empty list of SPL token mints allowed by the program.
    /// * `guardian` - The guardian address with emergency and oversight privileges.
    /// * `manager` - The manager address authorized for operational signatures.
    ///
    /// # Behavior
    /// - Sets the admin to the transaction signer.
    /// - Validates that at least one token mint is whitelisted.
    /// - Ensures all provided token mint addresses are valid.
    /// - Stores program's authority roles and configuration.
    /// - Initializes the program in an unpaused state.
    ///
    /// # Errors
    /// - `EmptyWhitelistedTokenMints` if no token mints are provided.
    /// - Any error returned by address validation.
    pub fn initialize(
        ctx: Context<Initialize>,
        zynk_op_wallet: Pubkey,
        whitelisted_token_mints: Vec<Pubkey>,
        guardian: Pubkey,
        manager: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.zynk_op_wallet = zynk_op_wallet;
        config.guardian = guardian;
        config.manager = manager;
        require!(whitelisted_token_mints.len() > 0, CustomError::EmptyWhitelistedTokenMints);
        for token_mint in whitelisted_token_mints.iter() {
            validate_address(token_mint)?;
        }
        config.whitelisted_token_mints = whitelisted_token_mints;
        config.paused = false;
        
        Ok(())
    }


    /// Pulls tokens from a partner deposit vault, forwards them to a beneficiary,
    /// and creates a corresponding order.
    ///
    /// # Arguments
    /// * `ctx` - The [`CreateOrder`] context containing all required accounts.
    /// * `partner_id` - The unique identifier of the partner.
    /// * `order_id` - The unique identifier of the order (32 bytes, hashed off-chain).
    /// * `amount` - The amount of tokens to transfer.
    /// * `signature` - Optional manager signature enabling transient execution.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the program is paused.
    /// - Validates the partner deposit vault token authority and token mint.
    /// - Optionally verifies a manager signature for transient execution.
    /// - Transfers tokens from the partner deposit vault to the operator wallet.
    /// - Transfers tokens from the operator wallet to the beneficiary.
    /// - Records order details in an `OrderTracker` PDA unless executed transiently.
    /// - Immediately closes the order tracker for transient orders.
    /// - Emits an `OrderCreated` event.
    ///
    /// # Notes
    /// - Transient orders do not persist on-chain state.
    /// - `order_id` must be exactly 32 bytes.
    pub fn pull_and_create_order(
        ctx: Context<CreateOrder>,
        partner_id: [u8; 32],
        order_id: [u8; 32],
        amount: u64,
        signature: Option<[u8; 64]>,
        meta: Option<Vec<EventArg>>
    ) -> Result<()> {
        // Check if program is paused.
        let config = &ctx.accounts.config;
        require!(!config.paused, CustomError::ContractPaused);

        let beneficiary_wallet = ctx.accounts.beneficiary_token_account.owner.key();
        let partner_deposit_vault = &ctx.accounts.partner_deposit_vault;
        let pdv_token_account = ctx.accounts.pdv_token_account.as_ref().ok_or(CustomError::InvalidPdvAuthority)?;

        require!(pdv_token_account.owner == ctx.accounts.partner_deposit_vault.key(), CustomError::InvalidPdvAuthority);
        require!(pdv_token_account.mint == ctx.accounts.zow_token_account.mint, CustomError::InvalidTokenMint);
        
        let mut transient = false;
        if let Some(signature) = signature {
            let message = format!("{}::{}::{}", DOMAIN_SEPARATOR, beneficiary_wallet, partner_deposit_vault.key());
            verify_signature_syscall(
                ctx.accounts.sysvar_instructions.as_ref().ok_or(ProgramError::MissingRequiredSignature)?,
                &config.manager,
                message,
                signature
            )?;
            transient = true;
        }

        // Perform token transfer from pdv_token_account to zow_token_account.
        let pull_accounts = Transfer {
            from: pdv_token_account.to_account_info(),
            to: ctx.accounts.zow_token_account.to_account_info(),
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
            pull_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;

        // Perform token transfer from zow_token_account to beneficiary_token_account.
        let send_accounts = Transfer {
            from: ctx.accounts.zow_token_account.to_account_info(),
            to: ctx.accounts.beneficiary_token_account.to_account_info(),
            authority: ctx.accounts.zynk_op_wallet.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), send_accounts);
        token::transfer(cpi_ctx, amount)?;
        
        let order_tracker = &mut ctx.accounts.order_tracker;
        if transient {
            close_account(order_tracker, &ctx.accounts.manager)?;
        } else {
            order_tracker.partner_id = partner_id;
            order_tracker.order_id = order_id;
            order_tracker.amount_in = amount;
            order_tracker.amount_out = amount;
            order_tracker.beneficiary_wallet = beneficiary_wallet;
            order_tracker.partner_deposit_vault = partner_deposit_vault.key();
        }
        
        emit!(OrderCreated {
            order_id,
            beneficiary_wallet,
            token: pdv_token_account.mint,
            partner_deposit_vault: partner_deposit_vault.key(),
            amount,
            transient,
            domain_separator: DOMAIN_SEPARATOR,
            meta
        });

        Ok(())
    }

    /// Creates an order and optionally transfers tokens from the operator
    /// wallet to the beneficiary.
    ///
    /// # Arguments
    /// * `ctx` - The [`CreateOrder`] context containing all required accounts.
    /// * `partner_id` - The unique identifier of the partner.
    /// * `order_id` - The unique identifier of the order (32 bytes, hashed off-chain).
    /// * `amount` - The amount of tokens to transfer.
    /// * `signature` - Optional manager signature enabling transient execution.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the program is paused.
    /// - Optionally verifies a manager signature for transient execution.
    /// - Transfers tokens from the operator wallet to the beneficiary if `amount > 0`.
    /// - Records order details in an `OrderTracker` PDA unless executed transiently.
    /// - Immediately closes the order tracker for transient orders.
    /// - Emits an `OrderCreated` event.
    ///
    /// # Notes
    /// - Transient orders do not persist on-chain state.
    /// - `order_id` must be exactly 32 bytes.
    pub fn create_order(
        ctx: Context<CreateOrder>,
        partner_id: [u8; 32],
        order_id: [u8; 32],
        amount: u64,
        signature: Option<[u8; 64]>,
        meta: Option<Vec<EventArg>>
    ) -> Result<()> {
        // Check if program is paused.
        let config = &ctx.accounts.config;
        require!(!config.paused, CustomError::ContractPaused);

        let beneficiary_wallet = ctx.accounts.beneficiary_token_account.owner.key();
        let partner_deposit_vault = ctx.accounts.partner_deposit_vault.key();

        let mut transient = false;
        if let Some(signature) = signature {
            let message = format!("{}::{}::{}", DOMAIN_SEPARATOR, beneficiary_wallet, partner_deposit_vault);
            verify_signature_syscall(
                ctx.accounts.sysvar_instructions.as_ref().ok_or(ProgramError::MissingRequiredSignature)?,
                &config.manager,
                message,
                signature
            )?;
            transient = true;
        }

        if amount != 0 {
            // Perform token transfer from zow_token_account to beneficiary_token_account.
            let cpi_accounts = Transfer {
                from: ctx.accounts.zow_token_account.to_account_info(),
                to: ctx.accounts.beneficiary_token_account.to_account_info(),
                authority: ctx.accounts.zynk_op_wallet.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
            token::transfer(cpi_ctx, amount)?;
        }

        let order_tracker = &mut ctx.accounts.order_tracker;
        if transient {
            close_account(order_tracker, &ctx.accounts.manager)?;
        } else {
            order_tracker.partner_id = partner_id;
            order_tracker.order_id = order_id;
            order_tracker.amount_out = amount;
            order_tracker.beneficiary_wallet = beneficiary_wallet;
            order_tracker.partner_deposit_vault = partner_deposit_vault;
        }

        emit!(OrderCreated {
            order_id,
            beneficiary_wallet,
            token: ctx.accounts.zow_token_account.mint,
            partner_deposit_vault,
            amount,
            transient,
            domain_separator: DOMAIN_SEPARATOR,
            meta
        });

        Ok(())
    }

    /// Replenishes an existing order by transferring tokens into the Zynk operational wallet.
    ///
    /// # Arguments
    /// * `ctx` - The [`Replenish`] context containing all required accounts.
    /// * `order_id` - The unique identifier of the order being replenished.
    /// * `validity` - A Unix timestamp that must be in the future to validate the replenishment.
    /// * `amount` - The amount of tokens to transfer into the order.
    /// * `close_order` - Whether the order should be closed after replenishment.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the contract is paused.
    /// - Ensures the provided validity timestamp is in the future.
    /// - Transfers tokens from the partner deposit vault to the Zynk operational wallet.
    /// - Updates the tracked input amount for the order.
    /// - Optionally closes the order if conditions are met.
    /// - Emits an `OrderReplenished` event.
    pub fn replenish(
        ctx: Context<Replenish>,
        order_id: [u8; 32],
        validity: i64,
        amount: u64,
        close_order: bool,
        meta: Option<Vec<EventArg>>
    ) -> Result<()> {
        // Check if program is paused.
        require!(!ctx.accounts.config.paused, CustomError::ContractPaused);
        
        // Validate that validity is in future
        let now = Clock::get()?.unix_timestamp;
        require!(validity > now, CustomError::ValidityMustBeFuture);

        let order_tracker = &mut ctx.accounts.order_tracker;
            
        if amount > 0 {
            // Perform token transfer from pdv_token_account to zow_token_account.
            let cpi_accounts = Transfer {
                from: ctx.accounts.pdv_token_account.to_account_info(),
                to: ctx.accounts.zow_token_account.to_account_info(),
                authority: ctx.accounts.partner_deposit_vault.to_account_info(),
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
            token::transfer(cpi_ctx, amount)?;
    
            order_tracker.amount_in += amount;
        } else {
            require!(order_tracker.amount_in >= order_tracker.amount_out, CustomError::DeficientOrder);
        }
        
        // If close_order flag is true, perform order closure
        if close_order {
            // Check if order_tracker's amount_in is greater than or equal to the order_tracker's amount_out
            require!(order_tracker.amount_in >= order_tracker.amount_out, CustomError::DeficientOrder);

            // Close the order_tracker account (transfer lamports to manager and clear data)
            close_account(order_tracker, &ctx.accounts.manager)?;
        }
        
        emit!(OrderReplenished {
            order_id,
            token: ctx.accounts.pdv_token_account.mint,
            partner_deposit_vault: ctx.accounts.partner_deposit_vault.key(),
            amount,
            order_closed: close_order,
            domain_separator: DOMAIN_SEPARATOR,
            meta
        });

        Ok(())
    }
    
    /// Attests an order using an off-chain signature and records or settles the order state.
    ///
    /// # Arguments
    /// * `ctx` - The [`AttestOrder`] context.
    /// * `order_id` - The unique identifier of the order.
    /// * `origin_chain` - The source blockchain identifier.
    /// * `target_chain` - The destination blockchain identifier.
    /// * `origin` - The originating address.
    /// * `proxy` - The proxy address involved in the transfer.
    /// * `target` - The target address on the destination chain.
    /// * `txn` - The originating transaction hash.
    /// * `proxy_txn` - Optional proxy transaction hash.
    /// * `asset` - The asset identifier.
    /// * `proxy_asset` - Optional proxy asset identifier.
    /// * `amount` - The amount attested for the order.
    /// * `signature` - The ed25519 signature authorizing the attestation.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Verifies the manager signature via the sysvar instructions account.
    /// - Initializes or updates the order tracker.
    /// - Closes the order if sufficient input has already been provided.
    /// - Emits an `OrderAttested` event.
    pub fn attest_order(
        ctx: Context<AttestOrder>,
        order_id: [u8; 32],
        origin_chain: String,
        target_chain: String,
        origin: String,
        proxy: String,
        target: String,
        txn: String,
        proxy_txn: Option<String>,
        asset: String,
        proxy_asset: Option<String>,
        amount: u64,
        signature: [u8; 64],
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(!config.paused, CustomError::ContractPaused);

        let message = format!("{}::{}::{}::{}::{}", DOMAIN_SEPARATOR, origin, proxy, target, txn);
        verify_signature_syscall(
            &ctx.accounts.sysvar_instructions,
            &config.manager,
            message,
            signature
        )?;

        let order_tracker = &mut ctx.accounts.order_tracker;

        let hashed_proxy = hash(proxy.as_bytes()).to_bytes();
        if order_tracker.order_id != [0u8; 32] {
            require!(
                order_tracker.partner_id == hashed_proxy, 
                CustomError::InvalidOrder);

            require!(
                order_tracker.amount_in + amount >= order_tracker.amount_out,
                CustomError::DeficientOrder
            );

            close_account(order_tracker, &ctx.accounts.manager)?;
        } else {
            order_tracker.partner_id = hashed_proxy;
            order_tracker.order_id = order_id;
            order_tracker.amount_out = amount;
        }

        emit!(OrderAttested {
            order_id,
            origin_chain,
            target_chain,
            origin,
            proxy,
            target,
            txn,
            proxy_txn,
            asset,
            proxy_asset,
            amount,
            domain_separator: DOMAIN_SEPARATOR,
            meta
        });

        Ok(())
    }

    /// Closes multiple order tracker accounts in a single instruction.
    ///
    /// # Arguments
    /// * `ctx` - The [`CloseOrders`] context.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the contract is paused.
    /// - Iterates over remaining accounts and closes each unique order tracker.
    /// - Emits an `OrdersClosed` event with all closed order IDs.
    pub fn close_orders(ctx: Context<CloseOrders>, meta: Option<Vec<EventArg>>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(!config.paused, CustomError::ContractPaused);

        let mut order_ids = Vec::<[u8; 32]>::new();
        for account_info in ctx.remaining_accounts.iter() {
            require!(account_info.owner == ctx.program_id, CustomError::InvalidOrder);

            let order_tracker = OrderTracker::try_deserialize(&mut &account_info.data.borrow()[..])?;
            let order_id = order_tracker.order_id;
            if order_ids.contains(&order_id) { continue; }
            order_ids.push(order_id);
            
            close_account(account_info, &ctx.accounts.admin)?;
        }

        emit!(OrdersClosed {
            order_ids,
            domain_separator: DOMAIN_SEPARATOR,
            meta
        });

        Ok(())
    }


    ////////////////////////////////////////////////////////////////
    /////////////////// critical functionalities ///////////////////
    ////////////////////////////////////////////////////////////////


    /// Requests a timelocked administrative action.
    ///
    /// # Arguments
    /// * `ctx` - The [`TimelockRequest`] context.
    /// * `action_u8` - The encoded timelock action.
    /// * `value` - Optional value associated with the action.
    ///
    /// # Behavior
    /// - Computes the ETA based on the action delay.
    /// - Stores the request in a timelock account.
    /// - Emits an `Action::Initiated` event.
    pub fn request_timelock(
        ctx: Context<TimelockRequest>,
        action_u8: u8,
        value: Option<Pubkey>,
    ) -> Result<()> {
        let timestamp = Clock::get()?.unix_timestamp;
        let req = &mut ctx.accounts.timelock;
        let action: TimelockAction = action_u8.try_into()?;

        req.action = action_u8;
        req.value = value.unwrap_or(Pubkey::default());
        req.eta = timestamp + action.delay();

        emit!(Action {
            action: action_u8,
            timelock: req.key(),
            status: ActionStatus::Initiated,
            timestamp,
        });

        Ok(())
    }

    /// Revokes a pending timelock action before it is executed.
    ///
    /// # Arguments
    /// * `ctx` - The [`Execute`] context containing the timelock account.
    ///
    /// # Behavior
    /// - Fails if the timelock action has already been executed.
    /// - Fails if the action is still under review (not acknowledged).
    /// - Emits an `Action::Revoked` event.
    pub fn revoke_timelock(ctx: Context<Execute>) -> Result<()> {
        let req = &mut ctx.accounts.timelock;

        require!(!req.executed, CustomError::AlreadyExecuted);
        require!(req.ack, CustomError::ActionUnderReview);

        emit!(Action {
            action: req.action,
            timelock: req.key(),
            status: ActionStatus::Revoked,
            timestamp: Clock::get()?.unix_timestamp,
        });
        
        Ok(())
    }

    /// Acknowledges a timelock action, marking it as reviewed.
    ///
    /// # Arguments
    /// * `ctx` - The [`Ack`] context containing the timelock account.
    ///
    /// # Behavior
    /// - Fails if the action has already been executed.
    /// - Marks the timelock request as acknowledged.
    /// - Emits an `Action::Acked` event.
    pub fn ack_timelock(ctx: Context<Ack>) -> Result<()> {
        let req = &mut ctx.accounts.timelock;
        require!(!req.executed, CustomError::AlreadyExecuted);

        req.ack = true;

        emit!(Action {
            action: req.action,
            timelock: req.key(),
            status: ActionStatus::Acked,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Executes a timelocked wallet or role update after conditions are met.
    ///
    /// # Arguments
    /// * `ctx` - The [`Execute`] context containing the timelock and config accounts.
    ///
    /// # Behavior
    /// - Validates timelock execution conditions based on action type.
    /// - Requires acknowledgment for guardian updates.
    /// - Updates the corresponding configuration field.
    /// - Marks the timelock action as executed.
    /// - Emits an `Action::Executed` event.
    pub fn execute_wallet_update(ctx: Context<Execute>) -> Result<()> {
        let timestamp = Clock::get()?.unix_timestamp;
        let req = &mut ctx.accounts.timelock;
        let action: TimelockAction = req.action.try_into()?;

        require!(!req.executed, CustomError::AlreadyExecuted);
        require!(!req.consensus, CustomError::InvalidAction);

        let acked = req.ack;
        let eta_ready = timestamp >= req.eta;

        let ok = if action == TimelockAction::UpdateGuardian {
            eta_ready && acked
        } else {
            eta_ready || acked
        };

        require!(ok, CustomError::ActionUnderReview);

        let value = req.value;
        validate_address(&value)?;

        let config = &mut ctx.accounts.config;

        match action {
            TimelockAction::TransferAdmin => config.admin = value,
            TimelockAction::UpdateManager => config.manager = value,
            TimelockAction::UpdateGuardian => config.guardian = value,
            TimelockAction::UpdateZynkOpWallet => config.zynk_op_wallet = value,
            _ => return Err(error!(CustomError::InvalidAction)),
        }

        req.executed = true;

        emit!(Action {
            action: req.action,
            timelock: req.key(),
            status: ActionStatus::Executed,
            timestamp,
        });

        Ok(())
    }

    /// Executes an unpause action after timelock conditions are satisfied.
    ///
    /// # Arguments
    /// * `ctx` - The [`Execute`] context containing the timelock and config accounts.
    ///
    /// # Behavior
    /// - Ensures the action corresponds to `Unpause`.
    /// - Requires ETA expiration or prior acknowledgment.
    /// - Sets the contract paused state to `false`.
    /// - Marks the timelock action as executed.
    /// - Emits an `Action::Executed` event.
    pub fn execute_unpause(ctx: Context<Execute>) -> Result<()> {
        let timestamp = Clock::get()?.unix_timestamp;
        let req = &mut ctx.accounts.timelock;

        require!(!req.executed, CustomError::AlreadyExecuted);
        require!(TimelockAction::try_from(req.action)? == TimelockAction::Unpause, CustomError::InvalidAction);

        let acked = req.ack;
        let eta_ready = timestamp >= req.eta;
        require!(eta_ready || acked, CustomError::ActionUnderReview);

        let config = &mut ctx.accounts.config;

        config.paused = false;
        req.executed = true;

        emit!(Action {
            action: req.action,
            timelock: req.key(),
            status: ActionStatus::Executed,
            timestamp,
        });

        Ok(())
    }

    /// Immediately pauses the contract.
    ///
    /// # Arguments
    /// * `ctx` - The [`Pause`] context containing the authority and config accounts.
    ///
    /// # Authorization
    /// May be called by the admin, manager, or guardian.
    ///
    /// # Behavior
    /// - Sets the contract paused state to `true`.
    /// - Fails if the signer is not an authorized role.
    ///
    /// # Authorization
    /// May be called by the admin, manager, or guardian.
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let authority = ctx.accounts.authority.key;

        if authority != &config.admin && authority != &config.manager && authority != &config.guardian {
            return Err(error!(CustomError::UnauthorizedSigner));
        }

        config.paused = true;
        Ok(())
    }

    /// Requests a consensus-based administrative action.
    ///
    /// # Arguments
    /// * `ctx` - The [`Consensus`] context containing the timelock account.
    /// * `action_u8` - The encoded consensus action.
    /// * `value` - The value associated with the action.
    ///
    /// # Behavior
    /// - Marks the timelock request as consensus-based.
    /// - Stores the requested action and value.
    /// - Emits an `Action::Initiated` event.
    pub fn request_consensus(
        ctx: Context<Consensus>,
        action_u8: u8,
        value: Pubkey,
    ) -> Result<()> {
        let req = &mut ctx.accounts.timelock;
        let _: TimelockAction = action_u8.try_into()?;

        req.action = action_u8;
        req.value = value;
        req.consensus = true;

        emit!(Action {
            action: action_u8,
            timelock: req.key(),
            status: ActionStatus::Initiated,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Executes a consensus-approved administrative action.
    ///
    /// # Arguments
    /// * `ctx` - The [`Ack`] context containing the timelock and config accounts.
    ///
    /// # Behavior
    /// - Fails if the action has already been executed.
    /// - Applies the approved configuration update.
    /// - Marks the timelock as acknowledged and executed.
    /// - Closes the timelock account.
    /// - Emits an `Action::Executed` event.
    pub fn execute_consensus(ctx: Context<Ack>) -> Result<()> {
        let req = &mut ctx.accounts.timelock;
        let action: TimelockAction = req.action.try_into()?;

        require!(!req.executed, CustomError::AlreadyExecuted);
        require!(req.consensus, CustomError::InvalidAction);

        let value = req.value;
        validate_address(&value)?;

        let config = &mut ctx.accounts.config;

        match action {
            TimelockAction::TransferAdmin => config.admin = value,
            TimelockAction::UpdateManager => config.manager = value,
            TimelockAction::UpdateZynkOpWallet => config.zynk_op_wallet = value,
            _ => return Err(error!(CustomError::InvalidAction)),
        }

        req.ack = true;
        req.executed = true;

        emit!(Action {
            action: req.action,
            timelock: req.key(),
            status: ActionStatus::Executed,
            timestamp: Clock::get()?.unix_timestamp,
        });

        // Close the timelock account (transfer lamports back to guardian)
        close_account(req, &ctx.accounts.guardian)?;
        
        Ok(())
    }

    /// Logs the domain separator used for signature construction.
    ///
    /// # Arguments
    /// * `_ctx` - The [`Null`] context.
    ///
    /// # Behavior
    /// - Emits the domain separator via program logs for off-chain consumers.
    pub fn domain_separator(_ctx: Context<Null>) -> Result<()> {
        msg!("DOMAIN_SEPARATOR: {}", DOMAIN_SEPARATOR);
        Ok(())
    }
}

/// Seed for the global config PDA
pub const CONFIG_SEED: &[u8] = b"config";
/// Seed for the global timelock PDA
pub const TIMELOCK_SEED: &[u8] = b"timelock";
/// Seed for order tracker PDAs
pub const ORDER_TRACKER_SEED: &[u8] = b"order_tracker";
/// Seed for partner deposit vault PDA
pub const PARTNER_DEPOSIT_VAULT_SEED: &[u8] = b"partner_deposit_vault";

#[derive(Accounts)]
pub struct Null {}

#[derive(Accounts)]
#[instruction(zynk_op_wallet: Pubkey, whitelisted_token_mints: Vec<Pubkey>, guardian: Pubkey, manager: Pubkey)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = Config::space(whitelisted_token_mints.len() as u32),
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(partner_id: [u8; 32], order_id: [u8; 32])]
pub struct CreateOrder<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CustomError::UnauthorizedManager
    )]
    pub config: Account<'info, Config>,
    
    #[account(mut)]
    pub manager: Signer<'info>,

    // Tokens pulled in from
    /// CHECK: Partner deposit vault PDA - verified by seeds
    #[account(
        seeds = [PARTNER_DEPOSIT_VAULT_SEED, partner_id.as_ref()],
        bump
    )]
    pub partner_deposit_vault: UncheckedAccount<'info>,
    // optional - used only for pull_and_create_order
    #[account(mut)]
    pub pdv_token_account: Option<Box<Account<'info, TokenAccount>>>,

    // Admin-controlled signer to transfer tokens
    #[account(
        mut,
        constraint = zynk_op_wallet.key() == config.zynk_op_wallet @ CustomError::UnauthorizedSigner
    )]
    pub zynk_op_wallet: Signer<'info>,
    #[account(
        mut,
        constraint = zow_token_account.owner == config.zynk_op_wallet @ CustomError::UnauthorizedSigner,
        constraint = config.whitelisted_token_mints.contains(&zow_token_account.mint) @ CustomError::InvalidTokenMint
    )]
    pub zow_token_account: Box<Account<'info, TokenAccount>>,
    
    // Tokens sent out to
    #[account(
        mut,
        constraint = beneficiary_token_account.mint == zow_token_account.mint @ CustomError::InvalidTokenMint,
    )]
    pub beneficiary_token_account: Box<Account<'info, TokenAccount>>,
    
    // Order tracker PDA
    #[account(
        init,
        payer = manager,
        space = OrderTracker::LEN,
        seeds = [ORDER_TRACKER_SEED, beneficiary_token_account.owner.key().as_ref(), order_id.as_ref()],
        bump
    )]
    pub order_tracker: Account<'info, OrderTracker>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    
    /// CHECK: This is the Sysvar Instructions account used for ed25519 signature verification
    #[account(address = SYSVAR_IX_ID)]
    pub sysvar_instructions: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 32])]
pub struct Replenish<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CustomError::UnauthorizedManager
    )]
    pub config: Account<'info, Config>,
    
    #[account(mut)]
    pub manager: Signer<'info>,
    
    // Order tracker PDA
    #[account(
        mut,
        seeds = [ORDER_TRACKER_SEED, order_tracker.beneficiary_wallet.as_ref(), order_tracker.order_id.as_ref()],
        bump,
    )]
    pub order_tracker: Account<'info, OrderTracker>,

    // Tokens pulled in from
    /// CHECK: Partner deposit vault PDA - verified by seeds
    #[account(
        seeds = [PARTNER_DEPOSIT_VAULT_SEED, order_tracker.partner_id.as_ref()],
        bump,
        constraint = partner_deposit_vault.key() == order_tracker.partner_deposit_vault @ CustomError::InvalidPdvAuthority,
    )]
    pub partner_deposit_vault: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = pdv_token_account.owner == partner_deposit_vault.key() @ CustomError::InvalidPdvAuthority,
        constraint = pdv_token_account.mint == zow_token_account.mint @ CustomError::InvalidTokenMint
    )]
    pub pdv_token_account: Box<Account<'info, TokenAccount>>,

    // Tokens pulled in to
    #[account(
        mut,
        constraint = zow_token_account.owner == config.zynk_op_wallet @ CustomError::InvalidTokenMint,
        constraint = config.whitelisted_token_mints.contains(&zow_token_account.mint) @ CustomError::InvalidTokenMint
    )]
    pub zow_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseOrders<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = admin @ CustomError::UnauthorizedAdmin
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 32])]
pub struct AttestOrder<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CustomError::UnauthorizedManager
    )]
    pub config: Account<'info, Config>,
    
    #[account(mut)]
    pub manager: Signer<'info>,
    
    #[account(
        init_if_needed,
        payer = manager,
        space = OrderTracker::LEN,
        seeds = [ORDER_TRACKER_SEED, b"attest", order_id.as_ref()],
        bump
    )]
    pub order_tracker: Account<'info, OrderTracker>,
    
    pub system_program: Program<'info, System>,
    
    /// CHECK: This is the Sysvar Instructions account used for ed25519 signature verification
    #[account(address = SYSVAR_IX_ID)]
    pub sysvar_instructions: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(action: u8)]
pub struct TimelockRequest<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CustomError::UnauthorizedManager
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = manager,
        space = Request::LEN,
        seeds = [TIMELOCK_SEED, &[action]],
        bump
    )]
    pub timelock: Account<'info, Request>,

    #[account(mut)]
    pub manager: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = admin @ CustomError::UnauthorizedAdmin
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [TIMELOCK_SEED, &[timelock.action]],
        bump,
        close = admin
    )]
    pub timelock: Account<'info, Request>,

    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct Ack<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = guardian @ CustomError::UnauthorizedGuardian
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [TIMELOCK_SEED, &[timelock.action]],
        bump
    )]
    pub timelock: Account<'info, Request>,

    #[account(mut)]
    pub guardian: Signer<'info>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(action: u8)]
pub struct Consensus<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CustomError::UnauthorizedManager,
        has_one = zynk_op_wallet @ CustomError::UnauthorizedSigner
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = manager,
        space = Request::LEN,
        seeds = [TIMELOCK_SEED, &[action]],
        bump
    )]
    pub timelock: Account<'info, Request>,

    #[account(mut)]
    pub manager: Signer<'info>,
    pub zynk_op_wallet: Signer<'info>,

    pub system_program: Program<'info, System>,
}
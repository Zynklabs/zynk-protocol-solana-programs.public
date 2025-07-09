use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_lang::solana_program::{
    pubkey::Pubkey,
    sysvar::instructions::load_instruction_at_checked,
    ed25519_program::ID as ED25519_ID,
    program_error::ProgramError
};

declare_id!("AHPfQdfzNVS7vLA8Lqqo75XaVGwDjQBobqwvDqBZ5njX");

pub const DOMAIN_SEPARATOR: u64 = 1151111081099710;

/// Stores the admin, the designated operator (zynk_op_wallet), the manager wallet,
/// and current nonce for send operations.
#[account]
pub struct Config {
    pub admin: Pubkey,
    pub manager: Pubkey,
    pub zynk_op_wallet: Pubkey,
    pub paused: bool,
    pub current_nonce: u64,
    pub guardian: Pubkey
}

impl Config {
    pub const LEN: usize = 8  + // discriminator
        32 + // admin
        32 + // manager
        32 + // zynk_op_wallet
        1  + // paused
        8  + // current_nonce
        32;  // guardian
}

/// Tracks order details including the designated partner_deposit_wallet
#[account]
pub struct OrderTracker {
    pub order_id: u64,
    pub amount_out: u64,
    pub amount_in: u64,
    pub partner_deposit_wallet: Pubkey,
}

impl OrderTracker {
    pub const LEN: usize = 8  + // discriminator
        8  + // order_id (u64)
        8  + // amount_out (u64)
        8  + // amount_in (u64)
        32; // partner_deposit_wallet
}


#[account]
pub struct TimelockRequest {
    pub action: u8,             // Enum tag for the action
    pub value: Pubkey       ,   // New value (wallet or admin address)
    pub eta: i64,               // Earliest time the action can be executed
    pub executed: bool,         // Prevent double execution
}

impl TimelockRequest {
    pub const LEN: usize = 8 + // discriminator
        1  + // action
        32 + // value
        8  + // eta
        1;   // executed
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
#[repr(u8)]
pub enum TimelockAction {
    TransferAdmin,
    UpdateManager,
    UpdateGuardian,
    Unpause,
    UpdateZynkOpWallet,
}

impl TimelockAction {
    pub fn delay(&self) -> i64 {
        match self {
            TimelockAction::TransferAdmin => 24 * 60 * 60,         // 24 hours
            TimelockAction::UpdateManager => 12 * 60 * 60,         // 12 hours
            TimelockAction::UpdateZynkOpWallet => 12 * 60 * 60,    // 12 hours
            TimelockAction::Unpause => 6 * 60 * 60,                // 6 hours
            TimelockAction::UpdateGuardian => 48 * 60 * 60,        // 48 hours
        }
    }
}

impl TryFrom<u8> for TimelockAction {
    type Error = CustomError;
    
    fn try_from(value: u8) -> std::result::Result<Self, Self::Error> {
        match value {
            0 => Ok(TimelockAction::TransferAdmin),
            1 => Ok(TimelockAction::UpdateManager),
            2 => Ok(TimelockAction::UpdateZynkOpWallet),
            3 => Ok(TimelockAction::Unpause),
            4 => Ok(TimelockAction::UpdateGuardian),
            _ => Err(CustomError::InvalidTimelockAction.into()),
        }
    }
}

#[event]
pub struct PullAndSend {
    pub order_id: u64,
    pub token: Pubkey,
    pub partner_deposit_wallet: Pubkey,
    pub beneficiary_wallet: Pubkey,
    pub amount: u64,
    pub domain_separator: u64,
}

#[event]
pub struct Send {
    pub order_id: u64,
    pub token: Pubkey,
    pub beneficiary_wallet: Pubkey,
    pub amount: u64,
    pub domain_separator: u64,
}

#[event]
pub struct Replenish {
    pub order_id: u64,
    pub token: Pubkey,
    pub partner_deposit_wallet: Pubkey,
    pub amount: u64,
    pub domain_separator: u64,
}

#[event]
pub struct OrderClosure {
    pub order_id: u64,
    pub order_tracker: Pubkey,
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
    #[msg("Nonce overflow")]
    NonceOverflow,
    #[msg("Unauthorized admin")]
    UnauthorizedAdmin,
    #[msg("Unauthorized manager")]
    UnauthorizedManager,
    #[msg("Unauthorized guardian")]
    UnauthorizedGuardian,
    #[msg("Invalid order ID")]
    InvalidOrderId,
    #[msg("Invalid token mint")]
    InvalidTokenMint,
    #[msg("Validity must be in future")]
    ValidityMustBeFuture,
    #[msg("Amount must be positive")]
    AmountMustBePositive,
    #[msg("Deployed amount must be replenished")]
    DeficientOrder,
    #[msg("Invalid message in Ed25519 instruction")]
    InvalidEd25519Message,
    #[msg("Timelock not yet ready")]
    TimelockNotReady,
    #[msg("Action already executed")]
    AlreadyExecuted,
    #[msg("Invalid timelock action")]
    InvalidTimelockAction,
}


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
    if address == &Pubkey::default() {
        return Err(error!(CustomError::InvalidAddress));
    }
    Ok(())
}

/// Closes an account and transfers lamports to the given destination.
/// Also zeroes out the account data to prevent reuse.
pub fn close_account<'a>(from: impl ToAccountInfo<'a>, to: impl ToAccountInfo<'a>) -> Result<()> {
    let from = from.to_account_info();
    let to = to.to_account_info();

    **to.try_borrow_mut_lamports()? += **from.try_borrow_lamports()?;
    **from.try_borrow_mut_lamports()? = 0;
    from.try_borrow_mut_data()?.fill(0);
    
    Ok(())
}

#[program]
pub mod zynk_protocol {
    use super::*;

    /// Initialize the protocol with admin, zynk operator wallet, and manager wallet.
    pub fn initialize(
        ctx: Context<Initialize>,
        zynk_op_wallet: Pubkey,
        manager: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.zynk_op_wallet = zynk_op_wallet;
        config.manager = manager;
        config.paused = false;
        config.current_nonce = 0;
        Ok(())
    }


    /// Pulls tokens from the partner_deposit_wallet into zynk_op_wallet (operator) and then,
    /// Sends tokens from the zynk_op_wallet (operator) to the beneficiary_wallet.
    /// The user provides the amount, whitelist signature and the partner_deposit_wallet (to be used later for replenish).
    /// This function:
    /// - Checks that the protocol isn’t paused.
    /// - Verifies manager-signed message to check if beneficiary is whitelisted
    /// - Increments the nonce (to derive a unique, nonzero order ID).
    /// - Pulls in tokens from the pdw_token_account (owned by partner_deposit_wallet) to the zow_token_account.
    /// - Transfers tokens from the zow_token_account (owned by zynk_op_wallet) to the beneficiary_wallet.
    /// - Records the order details (order_id, partner_deposit_wallet, amount_out and amount_in) in a new OrderTracker account.
    /// - Emits a PullAndSend event.
    pub fn pull_and_send(
        ctx: Context<PullAndSendTokens>,
        amount: u64,
        signature: [u8; 64],
    ) -> Result<()> {
        // Check if program is paused.
        let config = &mut ctx.accounts.config;
        require!(!config.paused, CustomError::ContractPaused);

        let beneficiary_wallet = ctx.accounts.beneficiary_token_account.owner.key();
        let partner_deposit_wallet = ctx.accounts.partner_deposit_wallet.key();
        let message = format!("{}::{}", DOMAIN_SEPARATOR, beneficiary_wallet);
        verify_signature_syscall(
            &ctx.accounts.sysvar_instructions,
            &config.manager,
            message,
            signature
        )?;

        // Increment the nonce first, then use it as the order ID.
        config.current_nonce = config
            .current_nonce
            .checked_add(1)
            .ok_or(CustomError::NonceOverflow)?;
        let nonce = config.current_nonce;

        // Perform token transfer from pdw_token_account to zow_token_account.
        let pull_accounts = Transfer {
            from: ctx.accounts.pdw_token_account.to_account_info(),
            to: ctx.accounts.zow_token_account.to_account_info(),
            authority: ctx.accounts.partner_deposit_wallet.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), pull_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Perform token transfer from zow_token_account to beneficiary_token_account.
        let send_accounts = Transfer {
            from: ctx.accounts.zow_token_account.to_account_info(),
            to: ctx.accounts.beneficiary_token_account.to_account_info(),
            authority: ctx.accounts.zynk_op_wallet.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), send_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Store order details with the new (nonzero) order ID.
        let order_tracker = &mut ctx.accounts.order_tracker;
        order_tracker.order_id = nonce;
        order_tracker.partner_deposit_wallet = partner_deposit_wallet;
        order_tracker.amount_out = amount;
        order_tracker.amount_in = amount;

        emit!(PullAndSend {
            order_id: nonce,
            token: ctx.accounts.pdw_token_account.mint,
            partner_deposit_wallet,
            beneficiary_wallet,
            amount,
            domain_separator: DOMAIN_SEPARATOR,
        });

        Ok(())
    }

    /// Sends tokens from the zynk_op_wallet (operator) to the beneficiary_wallet.
    /// The user provides the amount, signature and the partner_deposit_wallet (to be used later for replenish).
    /// This function:
    /// - Checks that the protocol isn’t paused.
    /// - Verifies manager-signed message to check if beneficiary is whitelisted
    /// - Increments the nonce (to derive a unique, nonzero order ID).
    /// - Transfers tokens from the zow_token_account (owned by zynk_op_wallet) to the beneficiary_wallet.
    /// - Records the order details (order_id, partner_deposit_wallet and amount_out) in a new OrderTracker account.
    /// - Emits a Send event.
    pub fn send(
        ctx: Context<SendTokens>,
        amount: u64,
        partner_deposit_wallet: Pubkey,
        signature: [u8; 64],
    ) -> Result<()> {        
        // Check if program is paused.
        let config = &mut ctx.accounts.config;
        require!(!config.paused, CustomError::ContractPaused);

        validate_address(&partner_deposit_wallet)?;

        let beneficiary_wallet = ctx.accounts.beneficiary_token_account.owner.key();
        let message = format!("{}::{}", DOMAIN_SEPARATOR, beneficiary_wallet);
        verify_signature_syscall(
            &ctx.accounts.sysvar_instructions,
            &config.manager,
            message,
            signature
        )?;

        // Increment the nonce first, then use it as the order ID.
        config.current_nonce = config
            .current_nonce
            .checked_add(1)
            .ok_or(CustomError::NonceOverflow)?;
        let nonce = config.current_nonce;

        // Perform token transfer from zow_token_account to beneficiary_token_account.
        let cpi_accounts = Transfer {
            from: ctx.accounts.zow_token_account.to_account_info(),
            to: ctx.accounts.beneficiary_token_account.to_account_info(),
            authority: ctx.accounts.zynk_op_wallet.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Store order details with the new (nonzero) order ID.
        let order_tracker = &mut ctx.accounts.order_tracker;
        order_tracker.order_id = nonce;
        order_tracker.partner_deposit_wallet = partner_deposit_wallet;
        order_tracker.amount_out = amount;

        emit!(Send {
            order_id: nonce,
            token: ctx.accounts.zow_token_account.mint,
            beneficiary_wallet: ctx.accounts.beneficiary_token_account.owner.key(),
            amount,
            domain_separator: DOMAIN_SEPARATOR,
        });

        Ok(())
    }

    /// Replenishes tokens by transferring them from the partner_deposit_wallet
    /// to the zynk_op_wallet.
    /// This function:
    /// - Checks that the protocol isn’t paused.
    /// - Verifies the order_id matches.
    /// - Checks if validity is in future.
    /// - Transfers tokens from the pdw_token_account (owned by partner_deposit_wallet) to the zow_token_account (owned by zynk_op_wallet).
    /// - Records amount_in in the dedicated OrderTracker account.
    /// - Emits a Replenish event.
    pub fn replenish(
        ctx: Context<ReplenishTokens>,
        order_id: u64,
        validity: i64,
        amount: u64,
    ) -> Result<()> {
        // Check if program is paused.
        require!(!ctx.accounts.config.paused, CustomError::ContractPaused);

        let order_tracker = &mut ctx.accounts.order_tracker;

        // Verify the order_id matches.
        require!(
            order_tracker.order_id == order_id,
            CustomError::InvalidOrderId
        );

        // Validate that validity is in future
        let now = Clock::get()?.unix_timestamp;
        require!(validity > now, CustomError::ValidityMustBeFuture);

        // Validate amount is positive
        require!(amount > 0, CustomError::AmountMustBePositive);

        let partner_deposit_wallet = ctx.accounts.partner_deposit_wallet.key();
        // Verify that the partner_deposit_wallet is authorized by comparing it with the stored partner_deposit_wallet.
        require!(
            partner_deposit_wallet == order_tracker.partner_deposit_wallet,
            CustomError::UnauthorizedSigner
        );

        // Perform token transfer from pdw_token_account to zow_token_account.
        let cpi_accounts = Transfer {
            from: ctx.accounts.pdw_token_account.to_account_info(),
            to: ctx.accounts.zow_token_account.to_account_info(),
            authority: ctx.accounts.partner_deposit_wallet.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        order_tracker.amount_in += amount;

        emit!(Replenish {
            order_id,
            token: ctx.accounts.pdw_token_account.mint,
            partner_deposit_wallet,
            amount,
            domain_separator: DOMAIN_SEPARATOR,
        });

        Ok(())
    }

    /// Closes the order account and emits closure events.
    /// Only callable by manager.
    /// This function:
    /// - Verify the order_id matches.
    /// - Checks if order_tracker's amount_in is greater than or equal to the order_tracker's amount_out.
    /// - Emits a OrderClosure event.
    /// - Transfers lamports to manager
    /// - Clears the account data
    pub fn close_order(ctx: Context<CloseOrder>, order_id: u64) -> Result<()> {
        // Verify that the order_id matches.
        require!(
            ctx.accounts.order_tracker.order_id == order_id,
            CustomError::InvalidOrderId
        );

        require!(
            ctx.accounts.order_tracker.amount_in >= ctx.accounts.order_tracker.amount_out,
            CustomError::DeficientOrder
        );

        emit!(OrderClosure {
            order_id,
            order_tracker: ctx.accounts.order_tracker.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        // Close the order account (transfer lamports back to manager)
        close_account(&ctx.accounts.order_tracker, &ctx.accounts.manager)?;

        Ok(())
    }

    ////////////////////////////////////////////////////////////////
    /////////////////// critical functionalities ///////////////////
    ////////////////////////////////////////////////////////////////

    pub fn request_timelock(
        ctx: Context<RequestTimelock>,
        action: u8,
        value: Option<Pubkey>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let req = &mut ctx.accounts.timelock;
        let action_enum = TimelockAction::try_from(action)?;

        req.action = action;
        req.value = value.unwrap_or(Pubkey::default());
        req.eta = clock.unix_timestamp + action_enum.delay();
        req.executed = false;

        Ok(())
    }

    pub fn revoke_timelock(ctx: Context<ExecuteByAdminAndGuardian>) -> Result<()> {
        let req = &mut ctx.accounts.timelock;
        require!(!req.executed, CustomError::AlreadyExecuted);

        // Close the timelock account (transfer lamports back to admin)
        close_account(req, &ctx.accounts.admin)?;

        Ok(())
    }

    pub fn execute_wallet_update(ctx: Context<ExecuteByAdmin>) -> Result<()> {
        let clock = Clock::get()?;
        let req = &mut ctx.accounts.timelock;

        require!(!req.executed, CustomError::AlreadyExecuted);

        let config_guardian = ctx.accounts.config.guardian;
        let mut bypass_ready = false;
        if let Some(guardian) = &ctx.accounts.guardian {
            if (guardian.key() == config_guardian) {
                bypass_ready = true
            }
        }

        let eta_ready = clock.unix_timestamp >= req.eta;
        require!(eta_ready || bypass_ready, CustomError::TimelockNotReady);

        let value = req.value;
        validate_address(&value)?;

        let config = &mut ctx.accounts.config;

        match req.action {
            0 => config.admin = value,
            1 => config.manager = value,
            2 => config.zynk_op_wallet = value,
            _ => return Err(error!(CustomError::InvalidTimelockAction)),
        }

        req.executed = true;

        // Close the timelock account (transfer lamports back to admin)
        close_account(req, &ctx.accounts.admin)?;
        
        Ok(())
    }

    pub fn execute_guardian_update(ctx: Context<ExecuteByAdminAndGuardian>) -> Result<()> {
        let clock = Clock::get()?;
        let req = &mut ctx.accounts.timelock;
        let config = &mut ctx.accounts.config;

        require!(!req.executed, CustomError::AlreadyExecuted);

        let eta_ready = clock.unix_timestamp >= req.eta;
        require!(eta_ready, CustomError::TimelockNotReady);

        let value = req.value;
        validate_address(&value)?;

        config.guardian = value;
        req.executed = true;

        // Close the timelock account (transfer lamports back to admin)
        close_account(req, &ctx.accounts.admin)?;
        
        Ok(())
    }

    pub fn set_guardian(ctx: Context<Misc>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(config.guardian == Pubkey::default(), CustomError::AlreadyExecuted);
        
        let authority = ctx.accounts.authority.key;
        config.guardian = *authority;
        Ok(())
    }

    pub fn execute_unpause(ctx: Context<ExecuteByAdmin>) -> Result<()> {
        let clock = Clock::get()?;
        let req = &mut ctx.accounts.timelock;

        require!(!req.executed, CustomError::AlreadyExecuted);

        let config_guardian = ctx.accounts.config.guardian;
        let mut bypass_ready = false;
        if let Some(guardian) = &ctx.accounts.guardian {
            if (guardian.key() == config_guardian) {
                bypass_ready = true
            }
        }

        let eta_ready = clock.unix_timestamp >= req.eta;
        require!(eta_ready || bypass_ready, CustomError::TimelockNotReady);

        let config = &mut ctx.accounts.config;

        config.paused = false;
        req.executed = true;

        // Close the timelock account (transfer lamports back to admin)
        close_account(req, &ctx.accounts.admin)?;

        Ok(())
    }

    // Pause functionality
    pub fn pause(ctx: Context<Misc>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let authority = ctx.accounts.authority.key;

        if authority != &config.admin && authority != &config.manager && authority != &config.guardian {
            return Err(error!(CustomError::UnauthorizedSigner));
        }

        config.paused = true;
        Ok(())
    }

    /// Logs the DOMAIN_SEPARATOR
    pub fn domain_separator(_ctx: Context<Null>) -> Result<()> {
        msg!("DOMAIN_SEPARATOR: {}", DOMAIN_SEPARATOR);
        Ok(())
    }
}

/// Seed for the global config PDA
pub const CONFIG_SEED: &[u8] = b"config";
/// Seed for the global timelock PDA
pub const TIMELOCK_SEED: &[u8] = b"timelock";

#[derive(Accounts)]
pub struct Null {}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = Config::LEN,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PullAndSendTokens<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    // Tokens pulled in from
    pub partner_deposit_wallet: Signer<'info>,
    #[account(
        mut,
        constraint = pdw_token_account.owner == partner_deposit_wallet.key() @ CustomError::UnauthorizedSigner,
        constraint = pdw_token_account.mint == beneficiary_token_account.mint @ CustomError::InvalidTokenMint
    )]
    pub pdw_token_account: Box<Account<'info, TokenAccount>>,

    // Admin-controlled signer to transfer tokens
    #[account(
        mut,
        constraint = zynk_op_wallet.key() == config.zynk_op_wallet @ CustomError::UnauthorizedSigner
    )]
    pub zynk_op_wallet: Signer<'info>,
    #[account(
        mut,
        constraint = zow_token_account.owner == config.zynk_op_wallet @ CustomError::UnauthorizedSigner,
        constraint = zow_token_account.mint == beneficiary_token_account.mint @ CustomError::InvalidTokenMint
    )]
    pub zow_token_account: Box<Account<'info, TokenAccount>>,
    
    // Tokens sent out to
    #[account(mut)]
    pub beneficiary_token_account: Box<Account<'info, TokenAccount>>,
    
    #[account(
        init,
        payer = zynk_op_wallet,
        space = OrderTracker::LEN
    )]
    pub order_tracker: Account<'info, OrderTracker>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,

    /// CHECK: This is the Sysvar Instructions account used for ed25519 signature verification
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub sysvar_instructions: AccountInfo<'info>,
}


#[derive(Accounts)]
pub struct SendTokens<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        constraint = zynk_op_wallet.key() == config.zynk_op_wallet @ CustomError::UnauthorizedSigner
    )]

    // Tokens sent out from
    pub zynk_op_wallet: Signer<'info>,
    #[account(
        mut,
        constraint = zow_token_account.owner == config.zynk_op_wallet @ CustomError::UnauthorizedSigner,
        constraint = zow_token_account.mint == beneficiary_token_account.mint @ CustomError::InvalidTokenMint
    )]
    pub zow_token_account: Box<Account<'info, TokenAccount>>,

    // Tokens sent out to
    #[account(mut)]
    pub beneficiary_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = zynk_op_wallet,
        space = OrderTracker::LEN
    )]
    pub order_tracker: Account<'info, OrderTracker>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,

    /// CHECK: This is the Sysvar Instructions account used for ed25519 signature verification
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub sysvar_instructions: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ReplenishTokens<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    // Tokens pulled in from
    pub partner_deposit_wallet: Signer<'info>,
    #[account(
        mut,
        constraint = pdw_token_account.owner == partner_deposit_wallet.key() @ CustomError::UnauthorizedSigner,
        constraint = pdw_token_account.mint == zow_token_account.mint @ CustomError::InvalidTokenMint
    )]
    pub pdw_token_account: Box<Account<'info, TokenAccount>>,

    // Tokens pulled in to
    #[account(
        mut,
        constraint = zow_token_account.owner == config.zynk_op_wallet @ CustomError::InvalidTokenMint
    )]
    pub zow_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = order_tracker.partner_deposit_wallet == partner_deposit_wallet.key() @ CustomError::UnauthorizedSigner
    )]
    pub order_tracker: Account<'info, OrderTracker>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(action: u8)]
pub struct RequestTimelock<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = admin @ CustomError::UnauthorizedAdmin
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = TimelockRequest::LEN,
        seeds = [TIMELOCK_SEED, &[action]],
        bump
    )]
    pub timelock: Account<'info, TimelockRequest>,

    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteByAdmin<'info> {
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
        bump
    )]
    pub timelock: Account<'info, TimelockRequest>,

    #[account(mut)]
    pub admin: Signer<'info>,

    // Optional signer — must match config.guardian
    pub guardian: Option<Signer<'info>>,
}

#[derive(Accounts)]
pub struct ExecuteByAdminAndGuardian<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = admin @ CustomError::UnauthorizedAdmin,
        has_one = guardian @ CustomError::UnauthorizedGuardian
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [TIMELOCK_SEED, &[timelock.action]],
        bump
    )]
    pub timelock: Account<'info, TimelockRequest>,

    #[account(mut)]
    pub admin: Signer<'info>,
    pub guardian: Signer<'info>,
}

#[derive(Accounts)]
pub struct Misc<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseOrder<'info> {
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
        mut,
        close = manager
    )]
    pub order_tracker: Account<'info, OrderTracker>,
    pub system_program: Program<'info, System>,
}

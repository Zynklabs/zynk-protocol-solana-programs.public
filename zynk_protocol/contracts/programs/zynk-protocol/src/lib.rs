use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_lang::solana_program::{
    pubkey::Pubkey,
    sysvar::instructions::load_instruction_at_checked,
    ed25519_program::ID as ED25519_ID,
    program_error::ProgramError
};

declare_id!("7UAhcDLNRpKa4HuCk5MkCLxRGLeRnbjqGxhjePdxPcqB");

pub const DOMAIN_SEPARATOR: u64 = 1151111081099710;

/// Stores the admin, the designated operator (zynk_op_wallet), the payback wallet,
/// and current nonce for send operations.
#[account]
pub struct Config {
    pub admin: Pubkey,
    pub zynk_op_wallet: Pubkey,
    pub payback_wallet: Pubkey,
    pub paused: bool,
    pub current_nonce: u64
}

impl Config {
    pub const LEN: usize = 8  + // discriminator
        32 + // admin
        32 + // zynk_op_wallet
        32 + // payback_wallet
        1  + // paused
        8; // current_nonce
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
pub struct ReplenishClosure {
    pub order_id: u64,
    pub order_tracker: Pubkey,
    pub timestamp: i64,
}

#[error_code]
pub enum CustomError {
    #[msg("Unauthorized sender")]
    UnauthorizedSender,
    #[msg("Invalid address: cannot use null address")]
    InvalidAddress,
    #[msg("Contract is paused")]
    ContractPaused,
    #[msg("Nonce overflow")]
    NonceOverflow,
    #[msg("Unauthorized admin")]
    UnauthorizedAdmin,
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
}

pub fn verify_admin_signature_syscall(
    ix_sysvar_account: &AccountInfo,
    admin_pubkey: &Pubkey,
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
    if data_pubkey != &admin_pubkey.to_bytes() || data_signature != signature || data_message != message {
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

#[program]
pub mod zynk_protocol {
    use super::*;

    /// Initialize the protocol with admin, zynk operator wallet, and payback wallet.
    pub fn initialize(
        ctx: Context<Initialize>,
        zynk_op_wallet: Pubkey,
        payback_wallet: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.zynk_op_wallet = zynk_op_wallet;
        config.payback_wallet = payback_wallet;
        config.paused = false;
        config.current_nonce = 0;
        Ok(())
    }


    /// Pulls tokes from the partner deposit wallet (deposit_wallet) into zynk_op_wallet (operator) and then,
    /// Sends tokens from the zynk_op_wallet (operator) to the beneficiary_wallet.
    /// The user provides the token mint, amount, and the partner_deposit_wallet (to be used later for replenish).
    /// This function:
    /// - Checks that the protocol isn’t paused.
    /// - Increments the nonce (to derive a unique, nonzero order ID).
    /// - Transfers tokens from the source token account (owned by zynk_op_wallet) to the beneficiary_wallet.
    /// - Records the order details (order_id and partner_deposit_wallet) in a new OrderTracker account.
    /// - Emits a Send event.
    pub fn pull_and_send(
        ctx: Context<PullAndSendTokens>,
        amount: u64,
        signature: [u8; 64],
    ) -> Result<()> {
        // Check if contract is paused.
        let config = &mut ctx.accounts.config;
        require!(!config.paused, CustomError::ContractPaused);

        let beneficiary_wallet = ctx.accounts.beneficiary_token_account.owner.key();
        let partner_deposit_wallet = ctx.accounts.partner_deposit_wallet.key();
        let message = format!("{}::{}", DOMAIN_SEPARATOR, beneficiary_wallet);
        verify_admin_signature_syscall(
            &ctx.accounts.sysvar_instructions,
            &config.admin,
            message,
            signature
        )?;

        // Increment the nonce first, then use it as the order ID.
        config.current_nonce = config
            .current_nonce
            .checked_add(1)
            .ok_or(CustomError::NonceOverflow)?;
        let nonce = config.current_nonce;

        // Perform token transfer from deposit token account to payback token account.
        let pull_accounts = Transfer {
            from: ctx.accounts.pdw_token_account.to_account_info(),
            to: ctx.accounts.zow_token_account.to_account_info(),
            authority: ctx.accounts.partner_deposit_wallet.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), pull_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Perform token transfer from zow_token_account to beneficiary_wallet.
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
    /// The user provides the token mint, amount, and the partner_deposit_wallet (to be used later for replenish).
    /// This function:
    /// - Checks that the protocol isn’t paused.
    /// - Increments the nonce (to derive a unique, nonzero order ID).
    /// - Transfers tokens from the source token account (owned by zynk_op_wallet) to the beneficiary_wallet.
    /// - Records the order details (order_id and partner_deposit_wallet) in a new OrderTracker account.
    /// - Emits a Send event.
    pub fn send(
        ctx: Context<SendTokens>,
        amount: u64,
        partner_deposit_wallet: Pubkey,
    ) -> Result<()> {
        // Check if contract is paused.
        let config = &mut ctx.accounts.config;
        require!(!config.paused, CustomError::ContractPaused);

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

    /// Replenishes tokens by transferring them from the partner_deposit_wallet (deposit_wallet)
    /// to the payback_wallet.
    /// The deposit wallet must match the partner_deposit_wallet recorded in the OrderTracker.
    pub fn replenish(
        ctx: Context<ReplenishTokens>,
        order_id: u64,
        validity: i64,
        payback_amount: u64,
    ) -> Result<()> {
        // Check if contract is paused.
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
        require!(payback_amount > 0, CustomError::AmountMustBePositive);

        let partner_deposit_wallet = ctx.accounts.partner_deposit_wallet.key();
        // Verify that the deposit wallet is authorized by comparing it with the stored partner_deposit_wallet.
        require!(
            partner_deposit_wallet == order_tracker.partner_deposit_wallet,
            CustomError::UnauthorizedSender
        );

        // Perform token transfer from pdw_token_account to payback token account.
        let cpi_accounts = Transfer {
            from: ctx.accounts.pdw_token_account.to_account_info(),
            to: ctx.accounts.payback_token_account.to_account_info(),
            authority: ctx.accounts.partner_deposit_wallet.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, payback_amount)?;

        order_tracker.amount_in += payback_amount;

        emit!(Replenish {
            order_id,
            token: ctx.accounts.pdw_token_account.mint,
            partner_deposit_wallet,
            amount: payback_amount,
            domain_separator: DOMAIN_SEPARATOR,
        });

        Ok(())
    }

    /// Closes the order account and emits closure events.
    /// Only callable by admin.
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

        emit!(ReplenishClosure {
            order_id,
            order_tracker: ctx.accounts.order_tracker.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        let order_tracker_account = &ctx.accounts.order_tracker.to_account_info();
        let dest_account = &ctx.accounts.admin.to_account_info();

        // Close the order account by transferring its lamports to the admin.
        **dest_account.try_borrow_mut_lamports()? +=
            **order_tracker_account.try_borrow_lamports()?;
        **order_tracker_account.try_borrow_mut_lamports()? = 0;

        // Clear the account data.
        order_tracker_account.try_borrow_mut_data()?.fill(0);

        Ok(())
    }

    /// Updates the zynk_op_wallet (operator) address. Only callable by admin.
    pub fn update_zynk_op_wallet(
        ctx: Context<UpdateConfigAddress>,
        new_zynk_op_wallet: Pubkey,
    ) -> Result<()> {
        validate_address(&new_zynk_op_wallet)?;
        ctx.accounts.config.zynk_op_wallet = new_zynk_op_wallet;
        Ok(())
    }

    /// Updates the payback_wallet address. Only callable by admin.
    pub fn update_payback_wallet(
        ctx: Context<UpdateConfigAddress>,
        new_payback_wallet: Pubkey,
    ) -> Result<()> {
        validate_address(&new_payback_wallet)?;
        ctx.accounts.config.payback_wallet = new_payback_wallet;
        Ok(())
    }

    /// Transfers admin rights to a new admin address. Only callable by the current admin.
    pub fn transfer_admin(ctx: Context<UpdateConfigAddress>, new_admin: Pubkey) -> Result<()> {
        validate_address(&new_admin)?;
        ctx.accounts.config.admin = new_admin;
        Ok(())
    }

    /// Sets the emergency pause state. When paused, send and replenish operations are disabled.
    /// Only callable by admin.
    pub fn set_pause_state(ctx: Context<UpdateConfigAddress>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    pub fn domain_separator(_ctx: Context<Null>) -> Result<()> {
        msg!("DOMAIN_SEPARATOR: {}", DOMAIN_SEPARATOR);
        Ok(())
    }
}

/// Seed for the global config PDA
pub const CONFIG_SEED: &[u8] = b"config";

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
        constraint = pdw_token_account.owner == partner_deposit_wallet.key() @ CustomError::UnauthorizedSender,
        constraint = pdw_token_account.mint == beneficiary_token_account.mint @ CustomError::InvalidTokenMint
    )]
    pub pdw_token_account: Box<Account<'info, TokenAccount>>,

    // Admin-controlled signer to transfer tokens
    #[account(
        mut,
        constraint = zynk_op_wallet.key() == config.zynk_op_wallet @ CustomError::UnauthorizedSender
    )]
    pub zynk_op_wallet: Signer<'info>,
    #[account(
        mut,
        constraint = zow_token_account.owner == config.zynk_op_wallet @ CustomError::UnauthorizedSender,
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
        constraint = zynk_op_wallet.key() == config.zynk_op_wallet @ CustomError::UnauthorizedSender
    )]

    // Tokens sent out from
    pub zynk_op_wallet: Signer<'info>,
    #[account(
        mut,
        constraint = zow_token_account.owner == config.zynk_op_wallet @ CustomError::UnauthorizedSender,
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
        constraint = pdw_token_account.owner == partner_deposit_wallet.key() @ CustomError::UnauthorizedSender,
        constraint = pdw_token_account.mint == payback_token_account.mint @ CustomError::InvalidTokenMint
    )]
    pub pdw_token_account: Box<Account<'info, TokenAccount>>,

    // Tokens pulled in to
    #[account(
        mut,
        constraint = payback_token_account.owner == config.payback_wallet @ CustomError::InvalidTokenMint
    )]
    pub payback_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = order_tracker.partner_deposit_wallet == partner_deposit_wallet.key() @ CustomError::UnauthorizedSender
    )]

    pub order_tracker: Account<'info, OrderTracker>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateConfigAddress<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = admin @ CustomError::UnauthorizedAdmin
    )]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseOrder<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = admin @ CustomError::UnauthorizedAdmin
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        close = admin
    )]
    pub order_tracker: Account<'info, OrderTracker>,
    pub system_program: Program<'info, System>,
}

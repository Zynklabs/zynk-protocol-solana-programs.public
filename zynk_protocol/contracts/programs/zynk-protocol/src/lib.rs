use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("7UAhcDLNRpKa4HuCk5MkCLxRGLeRnbjqGxhjePdxPcqB");

pub const CHAIN_ID: u64 = 1151111081099710;

/// Stores the admin, the designated operator (ZYNK_OP_WALLET), a payback wallet,
/// and current nonce for send operations.
#[account]
pub struct Config {
    pub admin: Pubkey,
    pub zynk_op_wallet: Pubkey,
    pub payback_wallet: Pubkey,
    pub paused: bool,
    pub current_nonce: u64,
}

impl Config {
    pub const LEN: usize = 8 + // discriminator
        32 + // admin
        32 + // zynk_op_wallet
        32 + // payback_wallet
        1 + // paused
        8; // current_nonce
}

/// Tracks order details including the designated replenishment wallet
#[account]
pub struct OrderTracker {
    pub order_id: u64,
    pub replenishment_wallet: Pubkey,
}

impl OrderTracker {
    pub const LEN: usize = 8 + // discriminator
        8 + // order_id (u64)
        32; // replenishment_wallet
}

#[event]
pub struct Send {
    pub order_id: u64,
    pub token: Pubkey,
    pub from: Pubkey,                 // ZYNK_OP_WALLET
    pub to: Pubkey,                   // Destination token account owner
    pub replenishment_wallet: Pubkey, // Wallet that must be used for replenishment
    pub amount: u64,
    pub chain_id: u64,
}

#[event]
pub struct Replenish {
    pub order_id: u64,
    pub token: Pubkey,
    pub from: Pubkey, // Deposit wallet (sender)
    pub to: Pubkey,   // Payback wallet (recipient)
    pub amount: u64,
    pub status: bool,
    pub chain_id: u64,
}

#[event]
pub struct ReplenishStatus {
    pub order_id: u64,
    pub status: bool,
}

#[event]
pub struct ReplenishClosure {
    pub order_id: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum CustomError {
    #[msg("Unauthorized sender")]
    UnauthorizedSender,
    #[msg("Contract is paused")]
    ContractPaused,
    #[msg("Nonce overflow")]
    NonceOverflow,
    #[msg("Unauthorized admin")]
    UnauthorizedAdmin,
    #[msg("Invalid order ID")]
    InvalidOrderId,
    #[msg("Validity period expired")]
    ValidityExpired,
    #[msg("Invalid token mint")]
    InvalidTokenMint,
}

#[program]
pub mod zynk_protocol {
    use super::*;

    /// Sends tokens from the stored ZYNK_OP_WALLET to a destination.
    /// It verifies that the source token account is owned by ZYNK_OP_WALLET,
    /// performs the token transfer, computes a unique order id (using auto-incrementing nonce),
    /// and emits a Send event.
    pub fn send(
        ctx: Context<SendTokens>,
        token_mint: Pubkey,
        amount: u64,
        replenishment_wallet: Pubkey,
    ) -> Result<()> {
        // Check if contract is paused
        let config = &mut ctx.accounts.config;
        require!(!config.paused, CustomError::ContractPaused);

        // Get and increment nonce with overflow protection
        let nonce = config.current_nonce;
        config.current_nonce = nonce.checked_add(1).ok_or(CustomError::NonceOverflow)?;

        // Perform token transfer
        let cpi_accounts = Transfer {
            from: ctx.accounts.source_token_account.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            authority: ctx.accounts.zynk_op_wallet.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Store order details
        let order_tracker = &mut ctx.accounts.order_tracker;
        order_tracker.order_id = nonce;
        order_tracker.replenishment_wallet = replenishment_wallet;

        emit!(Send {
            order_id: nonce,
            token: token_mint,
            from: ctx.accounts.zynk_op_wallet.key(),
            to: ctx.accounts.destination_token_account.owner,
            replenishment_wallet,
            amount,
            chain_id: CHAIN_ID,
        });

        Ok(())
    }

    /// Replenishes tokens by transferring them from a deposit wallet to the payback wallet.
    /// It verifies a validity period, performs the transfer, and emits a Replenish event.
    pub fn replenish(
        ctx: Context<ReplenishTokens>,
        order_id: u64,
        validity: i64,
        payback_amount: u64,
    ) -> Result<()> {
        // Check if contract is paused
        require!(!ctx.accounts.config.paused, CustomError::ContractPaused);

        // Verify order_id matches
        require!(
            ctx.accounts.order_tracker.order_id == order_id,
            CustomError::InvalidOrderId
        );

        // Check validity period
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp < validity,
            CustomError::ValidityExpired
        );

        // Perform token transfer
        let cpi_accounts = Transfer {
            from: ctx.accounts.deposit_token_account.to_account_info(),
            to: ctx.accounts.payback_token_account.to_account_info(),
            authority: ctx.accounts.deposit_wallet.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, payback_amount)?;

        emit!(Replenish {
            order_id,
            token: ctx.accounts.deposit_token_account.mint,
            from: ctx.accounts.deposit_wallet.key(),
            to: ctx.accounts.payback_token_account.owner,
            amount: payback_amount,
            status: false, // Default status
            chain_id: CHAIN_ID,
        });

        Ok(())
    }

    /// Closes the order account and emits closure events.
    /// Only callable by admin.
    pub fn close_order(ctx: Context<CloseOrder>, order_id: u64) -> Result<()> {
        // Verify order_id matches
        require!(
            ctx.accounts.order_tracker.order_id == order_id,
            CustomError::InvalidOrderId
        );

        emit!(ReplenishStatus {
            order_id,
            status: true
        });

        emit!(ReplenishClosure {
            order_id,
            timestamp: Clock::get()?.unix_timestamp,
        });

        let order_tracker_account = &ctx.accounts.order_tracker.to_account_info();
        let dest_account = &ctx.accounts.admin.to_account_info();

        // Close the account and transfer lamports
        **dest_account.try_borrow_mut_lamports()? +=
            **order_tracker_account.try_borrow_lamports()?;
        **order_tracker_account.try_borrow_mut_lamports()? = 0;

        // Clear the data
        order_tracker_account.try_borrow_mut_data()?.fill(0);

        Ok(())
    }

    /// Updates the ZYNK operator wallet address. Only callable by admin.
    pub fn update_zynk_op_wallet(
        ctx: Context<UpdateConfigAddress>,
        new_zynk_op_wallet: Pubkey,
    ) -> Result<()> {
        ctx.accounts.config.zynk_op_wallet = new_zynk_op_wallet;
        Ok(())
    }

    /// Updates the payback wallet address. Only callable by admin.
    pub fn update_payback_wallet(
        ctx: Context<UpdateConfigAddress>,
        new_payback_wallet: Pubkey,
    ) -> Result<()> {
        ctx.accounts.config.payback_wallet = new_payback_wallet;
        Ok(())
    }

    /// Transfers admin rights to a new admin address. Only callable by current admin.
    pub fn transfer_admin(ctx: Context<UpdateConfigAddress>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.admin = new_admin;
        Ok(())
    }

    /// Sets the emergency pause state. When paused, send and replenish operations are disabled.
    /// Only callable by admin.
    pub fn set_pause_state(ctx: Context<UpdateConfigAddress>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct SendTokens<'info> {
    #[account(mut)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        constraint = zynk_op_wallet.key() == config.zynk_op_wallet @ CustomError::UnauthorizedSender
    )]
    pub zynk_op_wallet: Signer<'info>,
    #[account(
        mut,
        constraint = source_token_account.owner == config.zynk_op_wallet @ CustomError::UnauthorizedSender,
        constraint = source_token_account.mint == destination_token_account.mint @ CustomError::InvalidTokenMint
    )]
    pub source_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub destination_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(
        init,
        payer = zynk_op_wallet,
        space = OrderTracker::LEN
    )]
    pub order_tracker: Account<'info, OrderTracker>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReplenishTokens<'info> {
    #[account(mut)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        constraint = deposit_token_account.mint == payback_token_account.mint @ CustomError::InvalidTokenMint
    )]
    pub deposit_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = payback_token_account.owner == config.payback_wallet @ CustomError::InvalidTokenMint
    )]
    pub payback_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub deposit_wallet: Signer<'info>,
    #[account(
        mut,
        close = deposit_wallet,
        constraint = order_tracker.replenishment_wallet == deposit_wallet.key() @ CustomError::UnauthorizedSender
    )]
    pub order_tracker: Account<'info, OrderTracker>,
}

#[derive(Accounts)]
pub struct UpdateConfigAddress<'info> {
    #[account(
        mut,
        has_one = admin @ CustomError::UnauthorizedAdmin
    )]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseOrder<'info> {
    #[account(
        mut,
        has_one = admin @ CustomError::UnauthorizedAdmin
    )]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    #[account(mut)]
    pub order_tracker: Account<'info, OrderTracker>,
    pub system_program: Program<'info, System>,
}

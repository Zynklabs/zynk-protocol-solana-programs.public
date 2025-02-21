use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("7UAhcDLNRpKa4HuCk5MkCLxRGLeRnbjqGxhjePdxPcqB");

pub const CHAIN_ID: u64 = 1151111081099710;

/// Stores the admin, the designated operator (zynk_op_wallet), the payback wallet,
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
    pub partner_deposit_wallet: Pubkey,
}

impl OrderTracker {
    pub const LEN: usize = 8  + // discriminator
        8  + // order_id (u64)
        32; // partner_deposit_wallet
}

#[event]
pub struct Send {
    pub order_id: u64,
    pub token: Pubkey,
    pub partner_deposit_wallet: Pubkey, // wallet that will be used later for replenish
    pub amount: u64,
    pub chain_id: u64,
}

#[event]
pub struct Replenish {
    pub order_id: u64,
    pub token: Pubkey,
    pub amount: u64,
    pub status: bool,
    pub chain_id: u64,
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

    /// Sends tokens from the zynk_op_wallet (operator) to the partner_operational_wallet.
    /// The user provides the token mint, amount, and the partner_deposit_wallet (to be used later for replenish).
    /// This function:
    /// - Checks that the protocol isn’t paused.
    /// - Increments the nonce (to derive a unique, nonzero order ID).
    /// - Transfers tokens from the source token account (owned by zynk_op_wallet) to the partner_operational_wallet.
    /// - Records the order details (order_id and partner_deposit_wallet) in a new OrderTracker account.
    /// - Emits a Send event.
    pub fn send(
        ctx: Context<SendTokens>,
        token_mint: Pubkey,
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

        // Perform token transfer from source_token_account to partner_operational_wallet.
        let cpi_accounts = Transfer {
            from: ctx.accounts.source_token_account.to_account_info(),
            to: ctx.accounts.partner_operational_wallet.to_account_info(),
            authority: ctx.accounts.zynk_op_wallet.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Store order details with the new (nonzero) order ID.
        let order_tracker = &mut ctx.accounts.order_tracker;
        order_tracker.order_id = nonce;
        order_tracker.partner_deposit_wallet = partner_deposit_wallet;

        emit!(Send {
            order_id: nonce,
            token: token_mint,
            partner_deposit_wallet,
            amount,
            chain_id: CHAIN_ID,
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

        // Verify the order_id matches.
        require!(
            ctx.accounts.order_tracker.order_id == order_id,
            CustomError::InvalidOrderId
        );

        // Check the validity period.
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp < validity,
            CustomError::ValidityExpired
        );

        // Verify that the deposit wallet is authorized by comparing it with the stored partner_deposit_wallet.
        require!(
            ctx.accounts.deposit_wallet.key() == ctx.accounts.order_tracker.partner_deposit_wallet,
            CustomError::UnauthorizedSender
        );

        // Perform token transfer from deposit token account to payback token account.
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
            amount: payback_amount,
            status: false, // Default status
            chain_id: CHAIN_ID,
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

        emit!(ReplenishClosure {
            order_id,
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
        ctx.accounts.config.zynk_op_wallet = new_zynk_op_wallet;
        Ok(())
    }

    /// Updates the payback_wallet address. Only callable by admin.
    pub fn update_payback_wallet(
        ctx: Context<UpdateConfigAddress>,
        new_payback_wallet: Pubkey,
    ) -> Result<()> {
        ctx.accounts.config.payback_wallet = new_payback_wallet;
        Ok(())
    }

    /// Transfers admin rights to a new admin address. Only callable by the current admin.
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
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = Config::LEN
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
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
        constraint = source_token_account.mint == partner_operational_wallet.mint @ CustomError::InvalidTokenMint
    )]
    pub source_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        // We assume partner_operational_wallet is the token account associated with the partner's wallet.
        // Its mint should match the source's mint.
    )]
    pub partner_operational_wallet: Box<Account<'info, TokenAccount>>,
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
        constraint = deposit_token_account.owner == deposit_wallet.key() @ CustomError::UnauthorizedSender,
        constraint = deposit_token_account.mint == payback_token_account.mint @ CustomError::InvalidTokenMint
    )]
    pub deposit_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = payback_token_account.owner == config.payback_wallet @ CustomError::InvalidTokenMint
    )]
    pub payback_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: This account must be mutable since it receives lamports from the closed order_tracker
    #[account(mut)]
    pub deposit_wallet: Signer<'info>,
    #[account(
        mut,
        close = deposit_wallet,
        constraint = order_tracker.partner_deposit_wallet == deposit_wallet.key() @ CustomError::UnauthorizedSender
    )]
    pub order_tracker: Account<'info, OrderTracker>,
    pub system_program: Program<'info, System>,
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

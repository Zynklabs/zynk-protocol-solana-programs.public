use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use zynk_core::program::ZynkCore;

use crate::*;

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct Deposit<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
        constraint = user.wallets.contains(&signer.key()) @ zynk_core::CoreError::Unauthorized,
    )]
    pub user: Account<'info, User>,

    #[account(mut, constraint = source_token_account.owner == signer.key() @ zynk_core::CoreError::InvalidAccount)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = config.whitelisted_token_mints.contains(&mint.key()) @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == source_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == destination_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,

    pub zynk_core_program: Program<'info, ZynkCore>,

    pub signer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(partner_id: String, order_id: [u8; 32], zov_id: [u8; 32])]
pub struct Borrow<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = manager @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    /// CHECK: Core ZOV PDA validated by Core program seeds and `zov_id`.
    #[account(
        seeds = [zynk_core::ZYNK_OP_VAULT_SEED, zov_id.as_ref()],
        seeds::program = ZynkCore::id(),
        bump,
        constraint = zynk_op_vault.key() == zov_token_account.owner @ zynk_core::CoreError::InvalidAccount,
    )]
    pub zynk_op_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub zov_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub beneficiary_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = config.whitelisted_token_mints.contains(&mint.key()) @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == zov_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == beneficiary_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        constraint = beneficiary.public_key == beneficiary_token_account.owner @ zynk_core::CoreError::InvalidBeneficiary,
    )]
    pub beneficiary: Account<'info, zynk_core::Beneficiary>,

    /// CHECK: Core validates and initializes this order tracker during the CPI.
    #[account(mut)]
    pub order_tracker: UncheckedAccount<'info>,

    /// CHECK: Core validates this partner deposit vault during the CPI.
    pub partner_deposit_vault: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,

    #[account(mut)]
    pub manager: Signer<'info>,

    /// CHECK: Orbit-owned capability PDA used to authenticate create_order CPI to zynk-core.
    #[account(
        seeds = [zynk_core::ORBIT_CPI_AUTHORITY_SEED],
        bump,
    )]
    pub orbit_authority: UncheckedAccount<'info>,

    // Remaining accounts (4 per position):
    // [source_token_account, authority_account, user, position_pda]
}

#[derive(Accounts)]
#[instruction(zov_id: [u8; 32])]
pub struct Repay<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = manager @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(mut, constraint = zov_token_account.owner == zynk_op_vault.key() @ zynk_core::CoreError::InvalidAccount)]
    pub zov_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = mint.key() == zov_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,

    /// CHECK: Core order tracker validated by Core program seeds and the CPI.
    #[account(
        mut,
        seeds = [zynk_core::ORDER_TRACKER_SEED, order_tracker.partner_id.as_ref(), order_tracker.order_id.as_ref()],
        seeds::program = ZynkCore::id(),
        bump,
    )]
    pub order_tracker: Account<'info, zynk_core::OrderTracker>,

    /// CHECK: Core partner deposit vault validated by Core program seeds and the CPI.
    #[account(
        seeds = [zynk_core::PARTNER_DEPOSIT_VAULT_SEED, order_tracker.partner_id.as_ref()],
        seeds::program = ZynkCore::id(),
        bump,
    )]
    pub partner_deposit_vault: UncheckedAccount<'info>,

    /// CHECK: Core validates this PDV token account's authority and mint during the CPI.
    #[account(mut)]
    pub pdv_token_account: UncheckedAccount<'info>,

    /// CHECK: Orbit-owned capability PDA used to authenticate this CPI to zynk-core.
    #[account(
        seeds = [zynk_core::ORBIT_CPI_AUTHORITY_SEED],
        bump,
    )]
    pub orbit_authority: UncheckedAccount<'info>,

    /// CHECK: Core ZOV PDA validated by Core program seeds and the CPI.
    #[account(
        seeds = [zynk_core::ZYNK_OP_VAULT_SEED, zov_id.as_ref()],
        seeds::program = ZynkCore::id(),
        bump,
    )]
    pub zynk_op_vault: UncheckedAccount<'info>,

    // Remaining accounts (3 per position):
    // [destination_token_account, user, position_pda]
}

#[derive(Accounts)]
pub struct Disburse<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = manager @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        constraint = source_token_account.owner == ovault.key() @ zynk_core::CoreError::InvalidAccount,
    )]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = config.whitelisted_token_mints.contains(&mint.key()) @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == source_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == destination_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Orbit vault PDA validated by seeds and used as transfer authority.
    #[account(
        seeds = [VAULT_SEED, b"orbit"],
        bump
    )]
    pub ovault: UncheckedAccount<'info>,

    pub user: Account<'info, User>,

    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(
    user_id: [u8; 32],
    user_type: UserType,
    wallets: [Pubkey; 3],
    cliff_period: Option<i64>,
    max_principal: Option<u64>,
    whitelisted_partners: Vec<u32>,
    cctp_recipients: Vec<CctpRecipient>
)]
pub struct RegisterUser<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        init,
        payer = admin,
        space = User::space_for_lengths(
            whitelisted_partners.len(),
            cctp_recipients.len(),
        ),
        seeds = [USER_SEED, user_id.as_ref()],
        bump
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct UpdateWallets<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
pub struct Revoke<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct UpdateCliffPeriod<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        init,
        payer = admin,
        space = 8 + UpdateCliffPeriodRequest::INIT_SPACE,
        seeds = [USER_UPDATE_REQUEST_SEED, user_id.as_ref()],
        bump
    )]
    pub request_user: Account<'info, UpdateCliffPeriodRequest>,

    #[account(
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct UpdateMaxPrincipal<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32], action: WhitelistAction)]
pub struct UpdatePartnerWhitelist<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
        realloc = User::space_for_lengths(
            match action {
                WhitelistAction::Add    => user.whitelisted_partners.len().saturating_add(1),
                WhitelistAction::Remove => user.whitelisted_partners.len().saturating_sub(1),
            },
            user.cctp_recipients.len(),
        ),
        realloc::payer = admin,
        realloc::zero = false,
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32], action: WhitelistAction, recipient: CctpRecipient)]
pub struct UpdateCctpRecipient<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
        realloc = User::space_for_lengths(
            user.whitelisted_partners.len(),
            match action {
                WhitelistAction::Add => user.cctp_recipients.len().saturating_add(1),
                WhitelistAction::Remove => user.cctp_recipients.len().saturating_sub(1),
            },
        ),
        realloc::payer = admin,
        realloc::zero = false,
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct RequestWithdraw<'info> {
    #[account(
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub signer_user: Account<'info, User>,

    #[account(
        init,
        payer = signer,
        space = 8 + WithdrawRequest::INIT_SPACE,
        seeds = [WITHDRAW_REQUEST_SEED, user_id.as_ref()],
        bump
    )]
    pub withdraw_request: Account<'info, WithdrawRequest>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct ApproveWithdraw<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    /// CHECK: The handler deserializes this account as a withdrawal request.
    #[account(mut)]
    pub request: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Optional Orbit vault PDA validated by seeds for LP withdrawals.
    #[account(
        seeds = [VAULT_SEED, b"orbit"],
        bump
    )]
    pub ovault: Option<UncheckedAccount<'info>>,

    #[account(
        constraint = config.whitelisted_token_mints.contains(&mint.key()) @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == source_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == destination_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct RevokeWithdraw<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        seeds = [WITHDRAW_REQUEST_SEED, user_id.as_ref()],
        bump,
        constraint = request.user_id == user_id @ OrbitError::UserIdMismatch
    )]
    pub request: Account<'info, WithdrawRequest>,

    #[account(
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct ApproveCliffPeriod<'info> {
    #[account(
        mut,
        seeds = [USER_UPDATE_REQUEST_SEED, user_id.as_ref()],
        bump,
        constraint = request.user_id == user_id @ OrbitError::UserIdMismatch
    )]
    pub request: Account<'info, UpdateCliffPeriodRequest >,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct RejectCliffPeriod<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        seeds = [USER_UPDATE_REQUEST_SEED, user_id.as_ref()],
        bump,
        constraint = request.user_id == user_id @ OrbitError::UserIdMismatch
    )]
    pub request: Account<'info, UpdateCliffPeriodRequest >,

    #[account(
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32], operations: Vec<ClaimOperation>)]
pub struct Claim<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
        constraint = user.user_type != UserType::LP @ OrbitError::InvalidOperation,
    )]
    pub user: Account<'info, User>,

    /// ICV custody ATA of the User PDA for `mint`. Pass None for NCW claims.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub icv_token_account: Option<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = mint.key() == destination_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    pub signer: Signer<'info>,

    /// CHECK: Core manager receives rent from closed Core trackers and Orbit positions.
    #[account(mut, address = config.manager @ zynk_core::CoreError::Unauthorized)]
    pub core_manager: UncheckedAccount<'info>,

    /// CHECK: Orbit-owned capability PDA used to authenticate Core CPIs.
    #[account(seeds = [zynk_core::ORBIT_CPI_AUTHORITY_SEED], bump)]
    pub orbit_authority: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct Pledge<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = manager @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(mut)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    #[account(
        constraint = mint.key() == source_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == destination_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    pub manager: Signer<'info>,

    /// CHECK: Orbit vault PDA validated by seeds and used as transfer authority.
    #[account(
        seeds = [VAULT_SEED, b"orbit"],
        bump
    )]
    pub ovault: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(id: [u8; 32])]
pub struct Cctp<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = manager @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        constraint = source_token_account.owner == authority.key() @ zynk_core::CoreError::InvalidAccount,
        constraint = source_token_account.mint == mint.key() @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Handler validates the authority as the Orbit vault, derived spender, or supplied User PDA.
    pub authority: UncheckedAccount<'info>,

    /// Optional User account. Pass Some when transferring from an ICV User.
    #[account(
        mut,
        seeds = [USER_SEED, id.as_ref()],
        bump,
    )]
    pub user: Option<Account<'info, User>>,

    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,

    /// CHECK: Manager-authorized instruction forwards this account as the CCTP CPI target.
    #[account(
        constraint = cfg!(feature = "testing") || cctp_token_messenger_minter_program.key() == CCTP_TOKEN_MESSENGER_MINTER_PROGRAM
    )]
    pub cctp_token_messenger_minter_program: UncheckedAccount<'info>,

    /// CHECK: Core order tracker initialized during create_order CPI for ICV transfers.
    #[account(mut)]
    pub order_tracker: Option<UncheckedAccount<'info>>,

    /// CHECK: Core partner deposit vault validated during create_order CPI for ICV transfers.
    pub partner_deposit_vault: Option<UncheckedAccount<'info>>,

    /// CHECK: Core ZOV validated during create_order CPI for ICV transfers.
    pub zynk_op_vault: Option<UncheckedAccount<'info>>,
}

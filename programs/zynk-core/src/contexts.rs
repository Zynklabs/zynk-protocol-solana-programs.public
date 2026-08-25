use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::*;

#[derive(Accounts)]
#[instruction(admin: Pubkey, guardian: Pubkey, whitelisted_token_mints: Vec<Pubkey>)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = manager,
        space = Config::space_for_len(whitelisted_token_mints.len()),
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        constraint = cfg!(feature = "testing") || manager.key() == INITIAL_MANAGER @ CoreError::Unauthorized
    )]
    pub manager: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(partner_id: [u8; 32], order_id: [u8; 32], zov_id: [u8; 32], transient: bool)]
pub struct CreateOrder<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CoreError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub manager: Signer<'info>,

    /// CHECK: Partner deposit vault PDA validated by seeds.
    #[account(
        seeds = [PARTNER_DEPOSIT_VAULT_SEED, partner_id.as_ref()],
        bump
    )]
    pub partner_deposit_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub pdv_token_account: Option<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Zynk Operational vault PDA validated by seeds.
    #[account(
        seeds = [ZYNK_OP_VAULT_SEED, zov_id.as_ref()],
        bump,
    )]
    pub zynk_op_vault: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = zov_token_account.owner == zynk_op_vault.key() @ CoreError::InvalidAccount,
        constraint = zov_token_account.mint == mint.key() @ CoreError::InvalidTokenMint
    )]
    pub zov_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        seeds = [BENEFICIARY_SEED, partner_id.as_ref(), beneficiary_token_account.owner.as_ref()],
        bump,
        constraint = beneficiary.is_active @ CoreError::InvalidBeneficiary,
        constraint = beneficiary.public_key == beneficiary_token_account.owner @ CoreError::InvalidBeneficiary,
    )]
    pub beneficiary: Account<'info, Beneficiary>,

    #[account(
        mut,
        constraint = beneficiary_token_account.mint == zov_token_account.mint @ CoreError::InvalidAccount,
        constraint = beneficiary_token_account.owner != zynk_op_vault.key() @ CoreError::InvalidAccount,
    )]
    pub beneficiary_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = manager,
        space = 8 + OrderTracker::INIT_SPACE,
        seeds = [ORDER_TRACKER_SEED, partner_id.as_ref(), order_id.as_ref()],
        bump
    )]
    pub order_tracker: Account<'info, OrderTracker>,

    #[account(
        constraint = config.whitelisted_token_mints.contains(&mint.key()) @ CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Replenish<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CoreError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        mut,
        seeds = [ORDER_TRACKER_SEED, order_tracker.partner_id.as_ref(), order_tracker.order_id.as_ref()],
        bump,
    )]
    pub order_tracker: Account<'info, OrderTracker>,

    /// CHECK: Partner deposit vault PDA validated by seeds.
    #[account(
        seeds = [PARTNER_DEPOSIT_VAULT_SEED, order_tracker.partner_id.as_ref()],
        bump,
        constraint = partner_deposit_vault.key() == order_tracker.partner_deposit_vault @ CoreError::InvalidAccount,
    )]
    pub partner_deposit_vault: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = pdv_token_account.owner == partner_deposit_vault.key() @ CoreError::InvalidAccount,
        constraint = pdv_token_account.mint == zov_token_account.mint @ CoreError::InvalidTokenMint
    )]
    pub pdv_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = zov_token_account.owner == order_tracker.zynk_op_vault @ CoreError::InvalidAccount,
        constraint = zov_token_account.mint == mint.key() @ CoreError::InvalidTokenMint
    )]
    pub zov_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = config.whitelisted_token_mints.contains(&mint.key()) @ CoreError::InvalidTokenMint,
        constraint = mint.key() == order_tracker.mint @ CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(zov_id: [u8; 32])]
pub struct ReplenishAndRepay<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    /// CHECK: Orbit-owned PDA capability; only zynk-orbit can sign for it.
    #[account(
        signer,
        seeds = [ORBIT_CPI_AUTHORITY_SEED],
        seeds::program = ZYNK_ORBIT_ID,
        bump,
    )]
    pub orbit_authority: UncheckedAccount<'info>,

    /// CHECK: Receives rent when a fully repaid order tracker is closed.
    #[account(mut, address = config.manager @ CoreError::Unauthorized)]
    pub manager: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [ORDER_TRACKER_SEED, order_tracker.partner_id.as_ref(), order_tracker.order_id.as_ref()],
        bump,
    )]
    pub order_tracker: Account<'info, OrderTracker>,

    /// CHECK: Core partner deposit vault PDA.
    #[account(
        seeds = [PARTNER_DEPOSIT_VAULT_SEED, order_tracker.partner_id.as_ref()],
        bump,
        constraint = partner_deposit_vault.key() == order_tracker.partner_deposit_vault @ CoreError::InvalidAccount,
    )]
    pub partner_deposit_vault: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = pdv_token_account.owner == partner_deposit_vault.key() @ CoreError::InvalidAccount,
        constraint = pdv_token_account.mint == mint.key() @ CoreError::InvalidTokenMint,
    )]
    pub pdv_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Core ZOV PDA bound to this order.
    #[account(
        seeds = [ZYNK_OP_VAULT_SEED, zov_id.as_ref()],
        bump,
        constraint = zynk_op_vault.key() == order_tracker.zynk_op_vault @ CoreError::InvalidAccount,
    )]
    pub zynk_op_vault: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = zov_token_account.owner == zynk_op_vault.key() @ CoreError::InvalidAccount,
        constraint = zov_token_account.mint == mint.key() @ CoreError::InvalidTokenMint,
    )]
    pub zov_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = destination_token_account.mint == mint.key() @ CoreError::InvalidTokenMint,
        constraint = destination_token_account.key() != zov_token_account.key() @ CoreError::InvalidAccount,
    )]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = config.whitelisted_token_mints.contains(&mint.key()) @ CoreError::InvalidTokenMint,
        constraint = mint.key() == order_tracker.mint @ CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseOrders<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        constraint = authority.key() == config.admin || authority.key() == config.guardian @ CoreError::Unauthorized,
    )]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(partner_id: [u8; 32], order_id: [u8; 32])]
pub struct RecordOrder<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CoreError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        init_if_needed,
        payer = manager,
        space = 8 + OrderTracker::INIT_SPACE,
        seeds = [ORDER_TRACKER_SEED, partner_id.as_ref(), order_id.as_ref()],
        bump
    )]
    pub order_tracker: Account<'info, OrderTracker>,

    pub system_program: Program<'info, System>,
}


#[derive(Accounts)]
#[instruction(partner_id: [u8; 32], public_key: Pubkey)]
pub struct WhitelistBeneficiary<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = authority,
        space = 8 + Beneficiary::INIT_SPACE,
        seeds = [BENEFICIARY_SEED, partner_id.as_ref(), public_key.as_ref()],
        bump
    )]
    pub beneficiary: Account<'info, Beneficiary>,

    #[account(
        mut,
        constraint = authority.key() == config.admin || authority.key() == config.guardian @ CoreError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ToggleBeneficiary<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [BENEFICIARY_SEED, beneficiary.partner_id.as_ref(), beneficiary.public_key.as_ref()],
        bump
    )]
    pub beneficiary: Account<'info, Beneficiary>,

    #[account(
        constraint = authority.key() == config.admin || authority.key() == config.guardian @ CoreError::Unauthorized,
    )]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RevokeBeneficiary<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [BENEFICIARY_SEED, beneficiary.partner_id.as_ref(), beneficiary.public_key.as_ref()],
        bump,
        close = authority
    )]
    pub beneficiary: Account<'info, Beneficiary>,

    #[account(
        mut,
        constraint = authority.key() == config.admin || authority.key() == config.guardian @ CoreError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(action: WhitelistAction, mint: Pubkey)]
pub struct UpdateWhitelistedTokenMint<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        // Dynamically resize the account buffer before the handler runs:
        //   • Add    → grow by one Pubkey slot (32 bytes)
        //   • Remove → shrink by one Pubkey slot (32 bytes)
        // Anchor automatically tops up (or refunds) rent to/from `authority`.
        realloc = Config::space_for_len(
            match action {
                WhitelistAction::Add    => config.whitelisted_token_mints.len().saturating_add(1),
                WhitelistAction::Remove => config.whitelisted_token_mints.len().saturating_sub(1),
            }
        ),
        realloc::payer = authority,
        // false → do NOT zero-fill new bytes; Anchor re-serialises the whole
        // account on exit anyway, so zeroing is wasted compute.
        realloc::zero = false,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        constraint = authority.key() == config.admin || authority.key() == config.guardian @ CoreError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(action: u8)]
pub struct RequestTimelock<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = authority,
        space = 8 + Timelock::INIT_SPACE,
        seeds = [TIMELOCK_SEED, &[action]],
        bump
    )]
    pub timelock: Account<'info, Timelock>,

    #[account(
        mut,
        constraint = authority.key() == config.admin || authority.key() == config.manager @ CoreError::Unauthorized
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SignTimelock<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [TIMELOCK_SEED, &[timelock.action]],
        bump,
        // close = authority
    )]
    pub timelock: Account<'info, Timelock>,

    #[account(
        mut,
        constraint = authority.key() == config.admin || authority.key() == config.guardian @ CoreError::Unauthorized
    )]
    pub authority: Signer<'info>,
}


#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        constraint = authority.key() == config.manager || authority.key() == config.admin @ CoreError::Unauthorized
    )]
    pub authority: Signer<'info>,
}

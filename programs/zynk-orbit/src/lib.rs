use anchor_lang::prelude::*;
use zynk_core::EventArg;

mod contexts;
mod constants;
mod error;
mod events;
mod instructions;
mod state;
mod utils;

pub use contexts::*;
pub use constants::*;
pub use error::*;
pub use events::*;
pub use state::*;
pub use utils::close_account;

declare_id!("ZYNKopsYjG6gaGqdwz8HLAgvCAEFwCET56kRQKkjxfc");

#[program]
pub mod zynk_orbit {
    use super::*;

    /// Deposits principal for a registered LP or ICV user.
    ///
    /// LP funds are sent to the canonical Core ZOV, while ICV funds are held by
    /// the User PDA. NCW deposits are rejected and net principal is capped by
    /// `max_principal`.
    pub fn deposit(ctx: Context<Deposit>, user_id: [u8; 32], amount: u64) -> Result<()> {
        instructions::deposit::deposit(ctx, user_id, amount)
    }

    /// Creates one Core order funded by one or more NCW/ICV positions.
    ///
    /// Position amounts must exactly equal the order amount. Funds are transferred
    /// into the selected ZOV before Core sends the aggregate amount to the
    /// beneficiary and records the order.
    pub fn borrow<'info>(
        ctx: Context<'_, '_, '_, 'info, Borrow<'info>>,
        partner_id: String,
        order_id: [u8; 32],
        zov_id: [u8; 32],
        amount: u64,
        positions: Vec<PositionOperation>,
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        instructions::borrow::borrow(ctx, partner_id, order_id, zov_id, amount, positions, meta)
    }

    /// Replenishes a Core order and settles its Orbit positions.
    ///
    /// The Core CPI retains replenishment above outstanding principal in the ZOV.
    /// Repayable principal is distributed proportionally through the Orbit vault;
    /// fully repaid positions and the corresponding Core order are closed.
    pub fn repay<'info>(
        ctx: Context<'_, '_, '_, 'info, Repay<'info>>,
        partner_id: [u8; 32],
        order_id: [u8; 32],
        zov_id: [u8; 32],
        amount: u64,
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        instructions::repay::repay(ctx, partner_id, order_id, zov_id, amount, meta)
    }

    /// Claims unlocked principal for an ICV or NCW user.
    ///
    /// ICV custody is consumed first. Supplied positions may then recover up to
    /// the available amount from matching Core PDVs. User and position accounting
    /// advance only by funds actually paid.
    pub fn claim<'info>(
        ctx: Context<'_, '_, '_, 'info, Claim<'info>>,
        user_id: [u8; 32],
        operations: Vec<ClaimOperation>,
    ) -> Result<()> {
        instructions::claim::claim(ctx, user_id, operations)
    }

    /// Disburses a PDA vault balance to a registered user wallet.
    ///
    /// Only the Core-configured manager may authorize the transfer.
    pub fn disburse(ctx: Context<Disburse>, vault_id: [u8; 32], amount: u64) -> Result<()> {
        instructions::disburse::disburse(ctx, vault_id, amount)
    }

    /// Registers a user and initializes their protocol limits and allowlists.
    ///
    /// Only the Core-configured admin may create the User PDA. Duplicate partner
    /// or CCTP recipient entries are rejected.
    pub fn register_user(
        ctx: Context<RegisterUser>,
        user_id: [u8; 32],
        user_type: UserType,
        wallets: [Pubkey; 3],
        cliff_period: Option<i64>,
        max_principal: Option<u64>,
        whitelisted_partners: Vec<u32>,
        cctp_recipients: Vec<CctpRecipient>,
    ) -> Result<()> {
        instructions::users::register_user(ctx, user_id, user_type, wallets, cliff_period, max_principal, whitelisted_partners, cctp_recipients)
    }

    /// Replaces the wallet allowlist for a registered user.
    ///
    /// Only the Core-configured admin may perform this update.
    pub fn update_wallets(
        ctx: Context<UpdateWallets>,
        user_id: [u8; 32],
        wallets: [Pubkey; 3],
    ) -> Result<()> {
        instructions::users::update_wallets(ctx, user_id, wallets)
    }

    /// Adds or removes a partner from a user's allowlist.
    ///
    /// The User PDA is resized while preserving its CCTP recipient entries.
    pub fn update_partner_whitelist(
        ctx: Context<UpdatePartnerWhitelist>,
        user_id: [u8; 32],
        action: WhitelistAction,
        partner_id: u32,
    ) -> Result<()> {
        instructions::users::update_partner_whitelist(ctx, user_id, action, partner_id)
    }

    /// Adds or removes a typed CCTP recipient from a user's allowlist.
    ///
    /// The User PDA is resized while preserving its partner entries.
    pub fn update_cctp_recipient(
        ctx: Context<UpdateCctpRecipient>,
        _user_id: [u8; 32],
        action: WhitelistAction,
        recipient: CctpRecipient,
    ) -> Result<()> {
        instructions::users::update_cctp_recipient(ctx, _user_id, action, recipient)
    }

    /// Revokes Orbit state supplied through remaining accounts.
    ///
    /// Only the Core-configured admin may close these accounts.
    pub fn revoke(ctx: Context<Revoke>) -> Result<()> {
        instructions::revoke::revoke(ctx)
    }

    /// Creates a pending cliff-period update for a registered user.
    ///
    /// Only the Core-configured admin may create the request. The requested
    /// cliff must be in the future; `None` preserves the user's current value.
    pub fn update_cliff_period(
        ctx: Context<UpdateCliffPeriod>,
        user_id: [u8; 32],
        cliff_period: Option<i64>,
    ) -> Result<()> {
        instructions::cliff::update_cliff_period(ctx, user_id, cliff_period)
    }

    /// Updates the maximum net principal allowed for a registered user.
    ///
    /// Only the Core-configured admin may update the limit, and the new limit
    /// cannot be lower than the user's current `principal_in - principal_out`.
    pub fn update_max_principal(
        ctx: Context<UpdateMaxPrincipal>,
        user_id: [u8; 32],
        max_principal: u64,
    ) -> Result<()> {
        instructions::users::update_max_principal(ctx, user_id, max_principal)
    }

    /// Creates a pending principal withdrawal request.
    ///
    /// NCW users are not eligible. The requested amount is capped by the user's
    /// recorded net principal and the request is stored until approved or rejected.
    pub fn request_withdraw(
        ctx: Context<RequestWithdraw>,
        user_id: [u8; 32],
        destination: Pubkey,
        amount: u32,
    ) -> Result<()> {
        instructions::withdrawals::request_withdraw(ctx, user_id, destination, amount)
    }

    /// Executes an approved principal withdrawal.
    ///
    /// The Core admin transfers the requested amount from ICV custody or the
    /// Orbit vault, updates `principal_out`, and closes the request account.
    pub fn approve_withdraw(
        ctx: Context<ApproveWithdraw>,
        user_id: [u8; 32],
    ) -> Result<()> {
        instructions::withdrawals::approve_withdraw(ctx, user_id)
    }

    /// Rejects a pending principal withdrawal request.
    ///
    /// Only the Core-configured admin may reject the request. Closing it returns
    /// the account rent to the admin without changing user principal accounting.
    pub fn reject_withdraw(ctx: Context<RejectWithdraw>, user_id: [u8; 32]) -> Result<()> {
        instructions::withdrawals::reject_withdraw(ctx, user_id)
    }

    /// Applies a pending cliff-period update.
    ///
    /// A registered user wallet must sign. The request is closed after its value
    /// is written to the user account.
    pub fn approve_cliff_period(ctx: Context<ApproveCliffPeriod>, user_id: [u8; 32]) -> Result<()> {
        instructions::cliff::approve_cliff_period(ctx, user_id)
    }

    /// Reject (cancel) a pending cliff period update request.
    ///
    /// The Core admin or any whitelisted wallet of the associated user may
    /// reject the request. Rent is returned to the authorized signer.
    pub fn reject_cliff_period(ctx: Context<RejectCliffPeriod>, user_id: [u8; 32]) -> Result<()> {
        instructions::cliff::reject_cliff_period(ctx, user_id)
    }

    /// Reinvests funds held by the Orbit vault.
    ///
    /// The manager sends ICV funds to User-PDA custody and other user funds to
    /// the canonical Core ZOV, then credits the user's principal balance.
    pub fn pledge(
        ctx: Context<Pledge>,
        user_id: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        instructions::pledge::pledge(ctx, user_id, amount)
    }

    /// Burns tokens through Circle CCTP for transfer to another domain.
    ///
    /// The Core-configured manager may transfer from the Orbit vault, a derived
    /// spender vault, or an ICV User PDA. ICV transfers require an elapsed cliff
    /// and an allowed recipient or deployment-time destination caller, and are
    /// recorded in `principal_out`.
    pub fn cctp<'info>(
        ctx: Context<'_, '_, '_, 'info, Cctp<'info>>,
        id: [u8; 32],
        amount: u64,
        destination_domain: u32,
        mint_recipient: [u8; 32],
        destination_caller: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::cctp::cctp(ctx, id, amount, destination_domain, mint_recipient, destination_caller)
    }
}

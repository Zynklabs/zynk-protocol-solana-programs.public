use anchor_lang::prelude::*;

mod constants;
mod contexts;
mod error;
mod events;
mod instructions;
mod state;
mod utils;

pub use constants::*;
pub use contexts::*;
pub use error::*;
pub use events::*;
pub use state::*;
pub use utils::*;

declare_id!("ZYNKctWoaYeAdN9szq1joeu6rRPf7LK72pUurkcBpBY");

#[program]
pub mod zynk_core {
    use super::*;

    /// Initializes the program configuration and core authority roles.
    ///
    /// # Arguments
    /// * `ctx` - The [`Initialize`] context containing the config and admin accounts.
    /// * `admin` - The admin address authorized for administrative operations.
    /// * `guardian` - The guardian address with emergency and oversight privileges.
    /// * `whitelisted_token_mints` - A non-empty list of SPL token mints allowed by the program.
    ///
    /// # Behavior
    /// - Sets the manager to the transaction signer.
    /// - Validates that at least one token mint is whitelisted.
    /// - Ensures all provided token mint addresses are valid.
    /// - Stores program's authority roles and configuration.
    /// - Initializes the program in an unpaused state.
    ///
    /// # Errors
    /// - `EmptyWhitelistedTokenMints` if no token mints are provided.
    /// - `DuplicateWhitelistedTokenMint` if duplicate token mints are provided.
    /// - Any error returned by address validation.
    pub fn initialize(
        ctx: Context<Initialize>,
        admin: Pubkey,
        guardian: Pubkey,
        whitelisted_token_mints: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::initialize::initialize(ctx, admin, guardian, whitelisted_token_mints)
    }

    /// Pulls tokens from a partner deposit vault, forwards them to a beneficiary,
    /// and creates a corresponding order.
    ///
    /// # Arguments
    /// * `ctx` - The [`CreateOrder`] context containing all required accounts.
    /// * `partner_id` - The unique identifier of the partner (32 bytes, hashed off-chain).
    /// * `order_id` - The unique identifier of the order (32 bytes, hashed off-chain).
    /// * `zov_id` - The unique identifier of the ZOV to use (32 bytes, hashed off-chain).
    /// * `transient` - Flag to create (and close) transient orders.
    /// * `amount` - The amount of tokens to transfer.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the program is paused.
    /// - Validates the partner deposit vault token authority and token mint.
    /// - Transfers tokens from the partner deposit vault to the Zynk Operational vault.
    /// - Transfers tokens from the Zynk Operational vault to the beneficiary.
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
        zov_id: [u8; 32],
        transient: bool,
        amount: u64,
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        instructions::pull_and_create_order::pull_and_create_order(
            ctx, partner_id, order_id, zov_id, transient, amount, meta,
        )
    }

    /// Creates an order and optionally transfers tokens from the Zynk Operational vault
    /// to the beneficiary.
    ///
    /// # Arguments
    /// * `ctx` - The [`CreateOrder`] context containing all required accounts.
    /// * `partner_id` - The unique identifier of the partner (32 bytes, hashed off-chain).
    /// * `order_id` - The unique identifier of the order (32 bytes, hashed off-chain).
    /// * `zov_id` - The unique identifier of the ZOV to use (32 bytes, hashed off-chain).
    /// * `transient` - Flag to create (and close) transient orders.
    /// * `amount` - The amount of tokens to transfer.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the program is paused.
    /// - Optionally verifies a manager signature for transient execution.
    /// - Transfers tokens from the Zynk Operational vault to the beneficiary if `amount > 0`.
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
        zov_id: [u8; 32],
        transient: bool,
        amount: u64,
        borrowed_amount: u64,
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        instructions::create_order::create_order(
            ctx,
            partner_id,
            order_id,
            zov_id,
            transient,
            amount,
            borrowed_amount,
            meta,
        )
    }

    /// Replenishes an existing order by transferring tokens into the Zynk Operational vault.
    ///
    /// # Arguments
    /// * `ctx` - The [`Replenish`] context containing all required accounts.
    /// * `amount` - The amount of tokens to transfer into the order.
    /// * `close_order` - Whether the order should be closed after replenishment.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the contract is paused.
    /// - Transfers tokens from the partner deposit vault to the Zynk Operational vault.
    /// - Updates the tracked input amount for the order.
    /// - Optionally closes the order if conditions are met.
    /// - Emits an `OrderReplenished` event.
    pub fn replenish(
        ctx: Context<Replenish>,
        amount: u64,
        close_order: bool,
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        instructions::replenish::replenish(ctx, amount, close_order, meta)
    }

    /// Atomically replenishes a ZOV from a partner deposit vault and distributes outstanding
    /// principal back to Orbit lenders in a single transaction.
    ///
    /// # Arguments
    /// * `ctx` - The [`ReplenishAndRepay`] context containing all required accounts.
    /// * `zov_id` - The unique identifier of the ZOV to replenish (32 bytes, hashed off-chain).
    /// * `amount` - The total amount of tokens to transfer from the partner deposit vault into the ZOV.
    /// * `repay_amount` - The portion of `amount` to distribute back to Orbit lenders; must be ≤ `amount`.
    /// * `repay_shares` - A per-lender breakdown of `repay_amount`; must sum exactly to `repay_amount`
    ///   and match the length of `remaining_accounts`.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the contract is paused or any amount is zero.
    /// - Validates that `repay_amount ≤ outstanding` balance on the order.
    /// - Transfers `amount` from the partner deposit vault into the ZOV token account.
    /// - Distributes `repay_amount` from the ZOV to each Orbit lender account according to `repay_shares`.
    /// - Updates `amount_in` on the `OrderTracker`; closes the tracker if the order is fully repaid.
    /// - Emits an `OrderReplenished` event.
    ///
    /// # Errors
    /// - `ContractPaused` if the program is paused.
    /// - `InvalidOrder` if amounts are invalid or exceed the outstanding balance.
    /// - `InvalidAccount` if remaining accounts count does not match `repay_shares` length,
    ///    or if a destination account is the ZOV itself.
    /// - `InvalidTokenMint` if a destination token account mint does not match the order mint.
    pub fn replenish_and_repay<'info>(
        ctx: Context<'_, '_, '_, 'info, ReplenishAndRepay<'info>>,
        zov_id: [u8; 32],
        amount: u64,
        repay_amount: u64,
        repay_shares: Vec<u64>,
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        instructions::replenish_and_repay::replenish_and_repay(
            ctx,
            zov_id,
            amount,
            repay_amount,
            repay_shares,
            meta,
        )
    }

    /// Records an order executed on an external chain (e.g. EVM) and logs the corresponding event.
    ///
    /// # Arguments
    /// * `ctx` - The [`RecordOrder`] context.
    /// * `partner_id` - The unique identifier of the partner (32 bytes, hashed off-chain).
    /// * `order_id` - The unique identifier of the order (32 bytes, hashed off-chain).
    /// * `token` - The token address/identifier string.
    /// * `zynk_op_vault` - The Zynk Operational vault address/identifier string.
    /// * `partner_deposit_vault` - The partner deposit vault address/identifier string.
    /// * `beneficiary_wallet` - The beneficiary wallet address/identifier string.
    /// * `amount` - The amount of tokens for the order.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the program is paused or amount is zero.
    /// - If the `OrderTracker` does not exist (open order), initializes it and emits `OrderCreated`.
    /// - If the `OrderTracker` already exists (replenishing/closing order), updates tracked amounts,
    ///   closes the `OrderTracker` PDA if replenished (`amount_in >= amount_out`), and emits `OrderReplenished`.
    pub fn record_order(
        ctx: Context<RecordOrder>,
        partner_id: [u8; 32],
        order_id: [u8; 32],
        token: String,
        zynk_op_vault: String,
        partner_deposit_vault: String,
        beneficiary_wallet: String,
        amount: u64,
        domain_separator: Option<u64>,
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        instructions::record_order::record_order(
            ctx,
            partner_id,
            order_id,
            token,
            zynk_op_vault,
            partner_deposit_vault,
            beneficiary_wallet,
            amount,
            domain_separator,
            meta,
        )
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
        instructions::close_orders::close_orders(ctx, meta)
    }

    ////////////////////////////////////////////////////////////////
    //////////////////// beneficiary whitelist /////////////////////
    ////////////////////////////////////////////////////////////////


    /// Registers a beneficiary wallet for a given partner and makes it eligible to receive funds.
    ///
    /// # Arguments
    /// * `ctx` - The [`WhitelistBeneficiary`] context containing the beneficiary PDA and authority.
    /// * `partner_id` - The unique identifier of the partner (32 bytes, hashed off-chain).
    /// * `public_key` - The wallet address to whitelist as a beneficiary.
    /// * `allow_transient` - Whether this beneficiary may receive funds via transient orders.
    ///
    /// # Behavior
    /// - Initializes the beneficiary PDA with the provided details.
    /// - Sets the beneficiary as active immediately upon registration.
    /// - Emits a `BeneficiaryAction::whitelist` event.
    pub fn whitelist_beneficiary(ctx: Context<WhitelistBeneficiary>, partner_id: [u8; 32], public_key: Pubkey, allow_transient: bool) -> Result<()> {
        instructions::beneficiaries::whitelist_beneficiary(ctx, partner_id, public_key, allow_transient)
    }

    /// Toggles the active state of an existing beneficiary.
    ///
    /// # Arguments
    /// * `ctx` - The [`ToggleBeneficiary`] context containing the beneficiary PDA and authority.
    ///
    /// # Behavior
    /// - Flips `is_active` on the beneficiary account.
    /// - An inactive beneficiary cannot receive funds until re-activated.
    /// - Emits a `BeneficiaryAction::toggle` event.
    pub fn toggle_beneficiary(ctx: Context<ToggleBeneficiary>) -> Result<()> {
        instructions::beneficiaries::toggle_beneficiary(ctx)
    }

    /// Permanently removes a beneficiary by closing its PDA account.
    ///
    /// # Arguments
    /// * `ctx` - The [`RevokeBeneficiary`] context containing the beneficiary PDA and authority.
    ///
    /// # Behavior
    /// - Closes the beneficiary PDA, returning lamports to the authority.
    /// - Emits a `BeneficiaryAction::revoke` event with `is_active: false`.
    pub fn revoke_beneficiary(ctx: Context<RevokeBeneficiary>) -> Result<()> {
        instructions::beneficiaries::revoke_beneficiary(ctx)
    }

    ////////////////////////////////////////////////////////////////
    //////////////// token mints whitelist /////////////////////////
    ////////////////////////////////////////////////////////////////

    /// Updates the whitelisted token mints list in the program config.
    ///
    /// # Arguments
    /// * `ctx` - The [`UpdateWhitelistedTokenMint`] context.
    /// * `action` - The action to perform (`Add` or `Remove`).
    /// * `mint` - The SPL token mint address to add or remove.
    ///
    /// # Behavior
    /// - Validates the token mint address is not the default/null address.
    /// - On `Add`: ensures the token mint is not already whitelisted, then appends it.
    /// - On `Remove`: ensures the token mint is present, ensures at least one token mint remains, and removes it.
    /// - Dynamically resizes the `Config` account buffer via Anchor `realloc`.
    /// - Emits a [`WhitelistedTokenMintsUpdated`] event.
    pub fn update_whitelisted_token_mint(
        ctx: Context<UpdateWhitelistedTokenMint>,
        action: WhitelistAction,
        mint: Pubkey,
    ) -> Result<()> {
        instructions::token_whitelist::update_whitelisted_token_mint(ctx, action, mint)
    }

    /// Requests a timelocked administrative action.
    ///
    /// # Arguments
    /// * `ctx` - The [`RequestTimelock`] context.
    /// * `action_u8` - The encoded timelock action.
    /// * `value` - Optional value associated with the action.
    ///
    /// # Behavior
    /// - Computes the ETA based on the action delay.
    /// - Stores the request in a timelock account.
    /// - Emits an `Action::Initiated` event.
    pub fn request_timelock(
        ctx: Context<RequestTimelock>,
        action_u8: u8,
        value: Option<Pubkey>,
    ) -> Result<()> {
        instructions::governance::request_timelock(ctx, action_u8, value)
    }

    /// Revokes a pending timelock action
    ///
    /// # Arguments
    /// * `ctx` - The [`SignTimelock`] context containing the timelock account.
    ///
    /// # Behavior
    /// - Verifies the authority is not the requester.
    /// - Closes the timelock account.
    /// - Emits an `Action::Revoked` event.
    pub fn revoke_timelock(ctx: Context<SignTimelock>) -> Result<()> {
        instructions::governance::revoke_timelock(ctx)
    }

    /// Acknowledges a timelock action, marking it as reviewed.
    ///
    /// # Arguments
    /// * `ctx` - The [`SignTimelock`] context containing the timelock account.
    ///
    /// # Behavior
    /// - Verifies the timelock is not already acknowledged.
    /// - Verifies the authority is not the requester.
    /// - Marks the timelock request as acknowledged.
    /// - Emits an `Action::Acked` event.
    pub fn ack_timelock(ctx: Context<SignTimelock>) -> Result<()> {
        instructions::governance::ack_timelock(ctx)
    }

    /// Executes a timelocked request after conditions are met.
    ///
    /// # Arguments
    /// * `ctx` - The [`SignTimelock`] context containing the timelock and config accounts.
    ///
    /// # Behavior
    /// - Validates timelock execution conditions based on action type.
    /// - Requires acknowledgment for guardian updates.
    /// - Updates the corresponding configuration field.
    /// - Closes the timelock account.
    /// - Emits an `Action::Executed` event.
    pub fn execute_request(ctx: Context<SignTimelock>) -> Result<()> {
        instructions::governance::execute_request(ctx)
    }

    /// Executes an unpause action after timelock conditions are satisfied.
    ///
    /// # Arguments
    /// * `ctx` - The [`SignTimelock`] context containing the timelock and config accounts.
    ///
    /// # Behavior
    /// - Ensures the action corresponds to `Unpause`.
    /// - Requires ETA expiration or prior acknowledgment.
    /// - Sets the contract paused state to `false`.
    /// - Closes the timelock account.
    /// - Emits an `Action::Executed` event.
    pub fn unpause(ctx: Context<SignTimelock>) -> Result<()> {
        instructions::governance::unpause(ctx)
    }

    /// Immediately pauses the contract.
    ///
    /// # Arguments
    /// * `ctx` - The [`Pause`] context containing the authority and config accounts.
    ///
    /// # Authorization
    /// May be called by the admin or manager.
    ///
    /// # Behavior
    /// - Sets the contract paused state to `true`.
    /// - Fails if the signer is not an authorized role.
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::governance::pause(ctx)
    }
}

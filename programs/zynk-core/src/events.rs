use anchor_lang::prelude::*;

use crate::ActionStatus;

/// A generic key-value pair for attaching arbitrary metadata to events.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EventArg {
    /// The metadata field name.
    pub key: String,
    /// The metadata field value (serialized as a string).
    pub value: String,
}

/// Emitted whenever a governance timelock action changes state
/// (initiated, acked, executed, or revoked).
#[event]
pub struct Action {
    /// The raw `u8` discriminant of the [`TimelockAction`](crate::TimelockAction).
    pub action: u8,
    /// The address of the [`Timelock`](crate::Timelock) PDA.
    pub timelock: Pubkey,
    /// The new lifecycle status of the timelock.
    pub status: ActionStatus,
    /// Unix timestamp of the state change.
    pub timestamp: i64,
    /// The authority that signed the state-changing transaction.
    pub signer: Pubkey,
}

/// Emitted whenever a beneficiary is whitelisted, toggled, or revoked.
#[event]
pub struct BeneficiaryAction {
    /// The action performed: `"whitelist"`, `"toggle"`, or `"revoke"`.
    pub action: String,
    /// The partner that owns this beneficiary.
    pub partner_id: [u8; 32],
    /// The beneficiary's wallet address.
    pub public_key: Pubkey,
    /// The active state of the beneficiary after the action.
    pub is_active: bool,
    /// Chain domain separator for cross-chain event indexing.
    pub domain_separator: u64,
}

/// Emitted when a new order is created, either persistent or transient.
#[event]
pub struct OrderCreated {
    /// Unique identifier of the created order.
    pub order_id: [u8; 32],
    /// The SPL token mint address used for this order.
    pub token: String,
    /// The Zynk Operational Vault that holds the deployed tokens.
    pub zynk_op_vault: String,
    /// The beneficiary wallet that received the tokens.
    pub beneficiary_wallet: String,
    /// The partner deposit vault that funded the order.
    pub partner_deposit_vault: String,
    /// The amount of tokens deployed to the beneficiary.
    pub amount: u64,
    /// Whether this was a transient (non-persistent) order.
    pub transient: bool,
    /// Chain domain separator for cross-chain event indexing.
    pub domain_separator: u64,
    /// Optional metadata attached by the caller.
    pub meta: Option<Vec<EventArg>>
}

/// Emitted when tokens are returned to a ZOV to replenish an existing order.
#[event]
pub struct OrderReplenished {
    /// Unique identifier of the replenished order.
    pub order_id: [u8; 32],
    /// The SPL token mint address used for this order.
    pub token: String,
    /// The Zynk Operational Vault that received the replenishment.
    pub zynk_op_vault: String,
    /// The partner deposit vault that funded the replenishment.
    pub partner_deposit_vault: String,
    /// The amount of tokens transferred in this replenishment.
    pub amount: u64,
    /// Whether the order tracker was closed because `amount_in >= amount_out`.
    pub order_closed: bool,
    /// Chain domain separator for cross-chain event indexing.
    pub domain_separator: u64,
    /// Optional metadata attached by the caller.
    pub meta: Option<Vec<EventArg>>
}

/// Emitted when one or more order tracker accounts are explicitly closed by an authority.
#[event]
pub struct OrdersClosed {
    /// The list of order IDs whose trackers were closed.
    pub order_ids: Vec<[u8; 32]>,
    /// Chain domain separator for cross-chain event indexing.
    pub domain_separator: u64,
    /// Optional metadata attached by the caller.
    pub meta: Option<Vec<EventArg>>
}

/// Emitted when the set of whitelisted token mints is modified.
#[event]
pub struct WhitelistedTokenMintsUpdated {
    /// The action performed: `"Add"` or `"Remove"`.
    pub action: String,
    /// The mint address that was added or removed.
    pub mint: Pubkey,
    /// Chain domain separator for cross-chain event indexing.
    pub domain_separator: u64,
    /// The complete updated list of whitelisted mints after the change.
    pub whitelisted_token_mints: Vec<Pubkey>,
}

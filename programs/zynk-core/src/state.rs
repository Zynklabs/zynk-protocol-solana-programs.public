use anchor_lang::prelude::*;

use crate::CoreError;

/// Action to perform on the whitelisted token mints.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum WhitelistAction {
    /// Add a new mint to the whitelist.
    Add,
    /// Remove an existing mint from the whitelist.
    Remove,
}

/// Global program configuration storing authority roles and protocol settings.
#[account]
pub struct Config {
    /// Whether the contract is currently paused; paused contracts reject most instructions.
    pub paused: bool,
    /// The admin address authorized for administrative timelock actions.
    pub admin: Pubkey,
    /// The manager address that initiates operational actions.
    pub manager: Pubkey,
    /// The guardian address with emergency oversight and ack privileges.
    pub guardian: Pubkey,
    /// The set of SPL token mints accepted by the protocol.
    pub whitelisted_token_mints: Vec<Pubkey>,
}

impl Config {
    /// Fixed byte cost of every field except the vector's element storage:
    ///   8   discriminator
    /// + 1   paused
    /// + 32  admin
    /// + 32  manager
    /// + 32  guardian
    /// + 4   Vec<Pubkey> length prefix
    /// = 109 bytes
    pub const BASE_SIZE: usize = 8 + 1 + 32 + 32 + 32 + 4;

    /// Total account space required to hold exactly `len` whitelisted token mints.
    /// Each `Pubkey` token mint occupies 32 bytes.
    #[inline]
    pub fn space_for_len(len: usize) -> usize {
        Self::BASE_SIZE + len * 32
    }
}

/// Tracks the state of an active or partially-replenished order on-chain.
///
/// Created when an order is initiated and closed once `amount_in >= amount_out`
/// (i.e. the order has been fully replenished).
#[account]
#[derive(InitSpace)]
pub struct OrderTracker {
    /// Unique identifier of the order (32 bytes, hashed off-chain).
    pub order_id: [u8; 32],
    /// Unique identifier of the partner that initiated the order.
    pub partner_id: [u8; 32],
    /// Total tokens replenished into the ZOV so far.
    pub amount_in: u64,
    /// Total tokens deployed to the beneficiary.
    pub amount_out: u64,
    /// The Zynk Operational Vault that received the deployed tokens.
    pub zynk_op_vault: Pubkey,
    /// The final recipient of the deployed tokens.
    pub beneficiary_wallet: Pubkey,
    /// The partner's deposit vault that funds replenishments.
    pub partner_deposit_vault: Pubkey,
    /// The SPL token mint used for this order.
    pub mint: Pubkey,
    pub amount_borrowed: u64,
    pub amount_repaid: u64,
}

/// PDA account representing a pending governance action under a time-lock.
///
/// A timelock is created via [`request_timelock`](crate::zynk_core::request_timelock),
/// optionally acknowledged by a second authority, and finally executed once
/// conditions (ETA and/or ack) are satisfied. The account is closed on execution or revocation.
#[account]
#[derive(InitSpace)]
pub struct Timelock {
    pub action: u8,             // Enum tag for the action
    pub value: Pubkey,          // New value (wallet address)
    pub eta: i64,               // Earliest time the action can be executed
    pub req_by: Pubkey,         // Requested by
    pub ack_by: Option<Pubkey>, // Acknowledged by - Optional
}

/// PDA account representing an approved beneficiary for a specific partner.
///
/// Created by [`whitelist_beneficiary`](crate::zynk_core::whitelist_beneficiary) and
/// used during order creation to validate the destination wallet.
#[account]
#[derive(InitSpace)]
pub struct Beneficiary {
    /// The partner this beneficiary belongs to.
    pub partner_id: [u8; 32],
    /// The beneficiary's wallet address.
    pub public_key: Pubkey,
    /// Whether this beneficiary can currently receive funds.
    pub is_active: bool,
    /// Whether this beneficiary may be used in transient (non-persistent) orders.
    pub allow_transient: bool
}


/// The lifecycle status of a governance timelock action.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
#[repr(u8)]
pub enum ActionStatus {
    /// The action has been requested but not yet reviewed.
    Initiated,
    /// The action has been acknowledged by a second authority.
    Acked,
    /// The action has been successfully executed and the timelock closed.
    Executed,
    /// The action was revoked before execution and the timelock closed.
    Revoked
}

/// The set of administrative actions that can be submitted through the timelock mechanism.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
#[repr(u8)]
pub enum TimelockAction {
    /// Replace the current admin address.
    UpdateAdmin,
    /// Replace the current manager address.
    UpdateManager,
    /// Replace the current guardian address.
    UpdateGuardian,
    /// Resume normal contract operation after a pause.
    Unpause,
}

impl TimelockAction {
    /// Returns the minimum time delay (in seconds) that must elapse before this action
    /// can be executed without an explicit acknowledgment.
    pub fn delay(&self) -> i64 {
        match self {
            TimelockAction::UpdateAdmin => 24 * 60 * 60,           // 24 hours
            TimelockAction::UpdateManager => 12 * 60 * 60,         // 12 hours
            TimelockAction::UpdateGuardian => 48 * 60 * 60,        // 48 hours
            TimelockAction::Unpause => 6 * 60 * 60,                // 6 hours
        }
    }
}

impl TryFrom<u8> for TimelockAction {
    type Error = CoreError;

    /// Converts a raw `u8` discriminant into the corresponding [`TimelockAction`] variant.
    ///
    /// # Errors
    /// Returns [`CoreError::InvalidAction`] if the value does not map to a known action.
    fn try_from(value: u8) -> std::result::Result<Self, Self::Error> {
        match value {
            0 => Ok(TimelockAction::UpdateAdmin),
            1 => Ok(TimelockAction::UpdateManager),
            2 => Ok(TimelockAction::UpdateGuardian),
            3 => Ok(TimelockAction::Unpause),
            _ => Err(CoreError::InvalidAction.into()),
        }
    }
}

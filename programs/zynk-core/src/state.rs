use anchor_lang::prelude::*;

use crate::CoreError;

/// Action to perform on the whitelisted token mints.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum WhitelistAction {
    Add,
    Remove,
}

#[account]
pub struct Config {
    pub paused: bool,
    pub admin: Pubkey,
    pub manager: Pubkey,
    pub guardian: Pubkey,
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

#[account]
#[derive(InitSpace)]
pub struct OrderTracker {
    pub order_id: [u8; 32],
    pub partner_id: [u8; 32],
    pub amount_in: u64,
    pub amount_out: u64,
    pub zynk_op_vault: Pubkey,
    pub beneficiary_wallet: Pubkey,
    pub partner_deposit_vault: Pubkey,
    pub mint: Pubkey,
    pub amount_borrowed: u64,
    pub amount_repaid: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Timelock {
    pub action: u8,             // Enum tag for the action
    pub value: Pubkey,          // New value (wallet address)
    pub eta: i64,               // Earliest time the action can be executed
    pub req_by: Pubkey,         // Requested by
    pub ack_by: Option<Pubkey>, // Acknowledged by - Optional
}

#[account]
#[derive(InitSpace)]
pub struct Beneficiary {
    pub partner_id: [u8; 32],
    pub public_key: Pubkey,
    pub is_active: bool,
    pub allow_transient: bool
}


#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
#[repr(u8)]
pub enum ActionStatus {
    Initiated,
    Acked,
    Executed,
    Revoked
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
#[repr(u8)]
pub enum TimelockAction {
    UpdateAdmin,
    UpdateManager,
    UpdateGuardian,
    Unpause,
}

impl TimelockAction {
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

use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
#[repr(u8)]
pub enum UserType {
    LP = 0,
    NCW = 1,
    ICV = 2,
}

/// Action to perform on the partner whitelist.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum WhitelistAction {
    Add,
    Remove,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub struct CctpRecipient {
    pub destination_domain: u32,
    pub mint_recipient: [u8; 32],
}

#[account]
pub struct User {
    pub wallets: [Pubkey; 3],           // 96 bytes (3 × 32)
    pub user_id: [u8; 32],              // 32 bytes
    pub user_type: UserType,            // 1  byte  (repr u8)
    pub allowed_mint: Pubkey,           // 32 bytes
    pub cliff_period: i64,              // 8  bytes
    pub principal_in: u64,              // 8  bytes
    pub principal_out: u64,             // 8  bytes
    pub max_principal: u64,                    // 8 bytes
    pub whitelisted_partners: Vec<u32>,        // 4-byte length prefix + (len × 4) bytes
    pub cctp_recipients: Vec<CctpRecipient>,   // 4-byte length prefix + (len × 36) bytes
}

impl User {
    /// Fixed byte cost of every field except the vector's element storage:
    ///   8   discriminator
    /// + 96  wallets ([Pubkey; 3])
    /// + 32  user_id
    /// + 1   user_type
    /// + 32  allowed_mint
    /// + 8   cliff_period
    /// + 8   principal_in
    /// + 8   principal_out
    /// + 8   max_principal
    /// + 4   Vec<u32> length prefix
    /// + 4   Vec<CctpRecipient> length prefix
    /// = 209 bytes
    pub const BASE_SIZE: usize = 8 + 96 + 32 + 1 + 32 + 8 + 8 + 8 + 8 + 4 + 4;

    #[inline]
    pub fn space_for_lengths(partner_len: usize, cctp_recipient_len: usize) -> usize {
        Self::BASE_SIZE
            + partner_len * 4
            + cctp_recipient_len * CctpRecipient::INIT_SPACE
    }
}

#[account]
#[derive(InitSpace)]
pub struct WithdrawRequest {
    pub user_id: [u8; 32],
    pub amount: u64,
    pub destination: Pubkey,
    pub mint: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct UpdateCliffPeriodRequest {
    pub user_id: [u8; 32],
    pub cliff_period: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub order_id: [u8; 32],
    pub partner_id: [u8; 32],
    pub amount_borrowed: u64,
    pub amount_repaid: u64,
    pub user_id: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PositionOperation {
    pub amount: u64,
    pub vault_id: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimOperation {
    pub zov_id: [u8; 32],
}

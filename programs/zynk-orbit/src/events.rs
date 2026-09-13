use anchor_lang::prelude::*;

#[event]
pub struct TxEvent {
    pub event_name: String,
    pub user_id: [u8; 32],
    pub from_owner: Pubkey,
    pub to_owner: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
    pub token: Pubkey,
    pub domain_separator: u64,
    pub order_id: [u8; 32],
    /// The wallet that signed this state-changing transaction.
    pub signer: Pubkey,
    /// Unix timestamp of the state change.
    pub timestamp: i64,
}

#[event]
pub struct AxEvent {
    pub event_name: String,
    pub user_id: [u8; 32],
    pub public_key: Pubkey,
    pub domain_separator: u64,
    pub partners: Vec<u32>,
    /// The wallet that signed this state-changing transaction.
    pub signer: Pubkey,
    /// Unix timestamp of the state change.
    pub timestamp: i64,
    /// Generic numeric value associated with the action (e.g. cliff_period, partner_id,
    /// max_principal). Zero when the action carries no meaningful numeric payload.
    pub value: i64,
}

#[event]
pub struct CctpEvent {
    pub event_name: String,
    pub vault: Pubkey,
    pub user_id: [u8; 32],
    pub amount: u64,
    pub token: Pubkey,
    pub destination_domain: u32,
    pub mint_recipient: [u8; 32],
    pub destination_caller: [u8; 32],
    pub domain_separator: u64,
    /// The manager wallet that authorised this CCTP burn.
    pub signer: Pubkey,
    /// Unix timestamp of the burn.
    pub timestamp: i64,
}

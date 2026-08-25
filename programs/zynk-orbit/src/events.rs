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
}

#[event]
pub struct AxEvent {
    pub event_name: String,
    pub user_id: [u8; 32],
    pub public_key: Pubkey,
    pub domain_separator: u64,
    pub partners: Vec<u32>,
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
}

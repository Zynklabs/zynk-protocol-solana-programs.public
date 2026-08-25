use anchor_lang::prelude::*;

use crate::ActionStatus;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EventArg {
    pub key: String,
    pub value: String,
}

#[event]
pub struct Action {
    pub action: u8,
    pub timelock: Pubkey,
    pub status: ActionStatus,
    pub timestamp: i64,
    pub signer: Pubkey,
}

#[event]
pub struct BeneficiaryAction {
    pub action: String,
    pub partner_id: [u8; 32],
    pub public_key: Pubkey,
    pub is_active: bool,
    pub domain_separator: u64,
}

#[event]
pub struct OrderCreated {
    pub order_id: [u8; 32],
    pub token: String,
    pub zynk_op_vault: String,
    pub beneficiary_wallet: String,
    pub partner_deposit_vault: String,
    pub amount: u64,
    pub transient: bool,
    pub domain_separator: u64,
    pub meta: Option<Vec<EventArg>>
}

#[event]
pub struct OrderReplenished {
    pub order_id: [u8; 32],
    pub token: String,
    pub zynk_op_vault: String,
    pub partner_deposit_vault: String,
    pub amount: u64,
    pub order_closed: bool,
    pub domain_separator: u64,
    pub meta: Option<Vec<EventArg>>
}

#[event]
pub struct OrdersClosed {
    pub order_ids: Vec<[u8; 32]>,
    pub domain_separator: u64,
    pub meta: Option<Vec<EventArg>>
}

#[event]
pub struct WhitelistedTokenMintsUpdated {
    pub action: String,
    pub mint: Pubkey,
    pub domain_separator: u64,
    pub whitelisted_token_mints: Vec<Pubkey>,
}

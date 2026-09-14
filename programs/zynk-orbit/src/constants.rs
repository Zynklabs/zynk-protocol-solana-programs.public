use anchor_lang::prelude::*;

pub const DOMAIN_SEPARATOR: u64 = 115131153410997;

pub const USER_SEED: &[u8] = b"user";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POSITION_SEED: &[u8] = b"position";
pub const WITHDRAW_REQUEST_SEED: &[u8] = b"withdraw_request";
pub const USER_UPDATE_REQUEST_SEED: &[u8] = b"user_update_request";

pub const CCTP_TOKEN_MESSENGER_MINTER_PROGRAM: Pubkey = pubkey!("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");

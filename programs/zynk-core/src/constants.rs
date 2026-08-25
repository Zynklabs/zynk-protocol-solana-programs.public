use anchor_lang::prelude::*;

pub const DOMAIN_SEPARATOR: u64 = 115111123810997;
pub const INITIAL_MANAGER: Pubkey = pubkey!("FnN6veEuyCr3R88iHxZYFRPwq22CZQwPMXzaTomeWWX5");
pub const ZYNK_ORBIT_ID: Pubkey = pubkey!("ZYNKopsYjG6gaGqdwz8HLAgvCAEFwCET56kRQKkjxfc");
pub const ORBIT_CPI_AUTHORITY_SEED: &[u8] = b"orbit<>core";

/// Seed for the global config PDA
pub const CONFIG_SEED: &[u8] = b"config";
/// Seed for the global timelock PDA
pub const TIMELOCK_SEED: &[u8] = b"timelock";
/// Seed for order tracker PDAs
pub const ORDER_TRACKER_SEED: &[u8] = b"order_tracker";
/// Seed for partner deposit vault PDA
pub const PARTNER_DEPOSIT_VAULT_SEED: &[u8] = b"partner_deposit_vault";
/// Seed for Zynk Operational vault PDA
pub const ZYNK_OP_VAULT_SEED: &[u8] = b"zynk_op_vault";
/// Seed for Beneficiary PDA
pub const BENEFICIARY_SEED: &[u8] = b"beneficiary";

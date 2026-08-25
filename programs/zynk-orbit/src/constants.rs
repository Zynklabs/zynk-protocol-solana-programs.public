pub const DOMAIN_SEPARATOR: u64 = 115131153410997;

pub const USER_SEED: &[u8] = b"user";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POSITION_SEED: &[u8] = b"position";
pub const WITHDRAW_REQUEST_SEED: &[u8] = b"withdraw_request";
pub const USER_UPDATE_REQUEST_SEED: &[u8] = b"user_update_request";

/// Destination callers that may bypass a user's CCTP recipient whitelist.
/// This deployment-time allowlist is intentionally not mutable on-chain.
pub const CCTP_WHITELISTED_DESTINATION_CALLERS: [[u8; 32]; 1] = [[2u8; 32]];

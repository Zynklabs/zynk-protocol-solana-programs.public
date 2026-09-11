use anchor_lang::prelude::*;

#[error_code]
pub enum CoreError {
    #[msg("Unauthorized signer")]
    Unauthorized,
    #[msg("Invalid address: cannot use null address")]
    InvalidAddress,
    #[msg("Contract is paused")]
    ContractPaused,
    #[msg("Invalid order")]
    InvalidOrder,
    #[msg("Invalid account")]
    InvalidAccount,
    #[msg("Invalid token mint")]
    InvalidTokenMint,
    #[msg("Invalid beneficiary or it's state")]
    InvalidBeneficiary,
    #[msg("Deployed amount must be replenished")]
    DeficientOrder,
    #[msg("Action under review")]
    ActionUnderReview,
    #[msg("Action already executed")]
    AlreadyExecuted,
    #[msg("Invalid action")]
    InvalidAction,
    #[msg("Whitelisted token mints must be non-empty")]
    EmptyWhitelistedTokenMints,
    #[msg("Whitelisted token mints must be unique")]
    DuplicateWhitelistedTokenMint,
    #[msg("Token mint is already whitelisted")]
    TokenMintAlreadyWhitelisted,
    #[msg("Token mint is not whitelisted")]
    TokenMintNotWhitelisted,
    #[msg("Fee-bearing mints are not supported")]
    FeeBearingMintNotSupported,
}

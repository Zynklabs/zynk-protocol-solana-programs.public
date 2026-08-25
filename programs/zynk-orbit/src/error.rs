use anchor_lang::prelude::*;

#[error_code]
pub enum OrbitError {
    #[msg("Amount should not be zero")]
    ZeroAmount,
    #[msg("Cliff period must be in the future")]
    CliffPeriodInPast,
    #[msg("Pda is not owned by this contract")]
    PdaNotOwnedByContract,
    #[msg("User ID mismatch between signer and destination users")]
    UserIdMismatch,
    #[msg("Insufficient balance deposited")]
    InsufficientBalance,
    #[msg("Operation no permitted")]
    InvalidOperation,
    #[msg("Total position amounts do not match borrow amount")]
    AmountMismatch,
    #[msg("Invalid request account type")]
    InvalidRequestAccount,
    #[msg("Positions list cannot be empty")]
    EmptyPositions,
    #[msg("Invalid position operation")]
    InvalidPositionOperation,
    #[msg("Position order IDs do not match")]
    PositionOrderMismatch,
    #[msg("Cliff period is over, operation not permitted")]
    CliffPeriodOver,
    #[msg("Cliff period is not over yet")]
    CliffPeriodNotOver,
    #[msg("Deposit would exceed max deposit cap")]
    MaxDepositExceeded,
    #[msg("Max deposit cannot be reduced below current net balance")]
    MaxPrincipalBelowBalance,
    #[msg("Partner is not in the whitelist")]
    PartnerNotWhitelisted,
    #[msg("Partner is already in the whitelist")]
    PartnerAlreadyWhitelisted,
    #[msg("Invalid partner ID format")]
    InvalidPartnerId,
    #[msg("Repay amount exceeds remaining order amount")]
    ExcessiveRepay,
    #[msg("Source token account has insufficient token balance for withdrawal")]
    InsufficientTokenBalance,
    #[msg("CCTP recipient is not whitelisted")]
    CctpRecipientNotWhitelisted,
    #[msg("CCTP recipient is already whitelisted")]
    CctpRecipientAlreadyWhitelisted,
}

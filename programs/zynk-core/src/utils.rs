use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_program::ID as SYSTEM_PROGRAM_ID;

use crate::CoreError;

/// Helper function to validate an address is not the null address
pub fn validate_address(address: &Pubkey) -> Result<()> {
    require!(*address != Pubkey::default(), CoreError::InvalidAddress);
    Ok(())
}

/// Helper to validate there are no duplicate mints.
pub fn validate_unique_token_mints(token_mints: &[Pubkey]) -> Result<()> {
    let mut sorted = token_mints.to_vec();
    sorted.sort_unstable();

    for pair in sorted.windows(2) {
        require!(pair[0] != pair[1], CoreError::DuplicateWhitelistedTokenMint);
    }

    Ok(())
}


/// Closes an account and transfers lamports to the given destination.
/// Also zeroes out the account data to prevent reuse.
pub fn close_account<'a, 'b>(from: impl ToAccountInfo<'a>, to: impl ToAccountInfo<'b>) -> Result<()> {
    let from = from.to_account_info();
    let to = to.to_account_info();

    let to_lamports = to.lamports();
    **to.lamports.borrow_mut() = to_lamports.checked_add(from.lamports()).unwrap();
    **from.lamports.borrow_mut() = 0;

    from.assign(&SYSTEM_PROGRAM_ID);
    from.resize(0).map_err(Into::into)
}

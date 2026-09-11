use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_program::ID as SYSTEM_PROGRAM_ID;
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions,
    ExtensionType,
    StateWithExtensions,
};

use crate::CoreError;

use anchor_spl::token::spl_token::solana_program::program_pack::Pack;

/// Validates that a token mint is valid and is not fee-bearing.
pub fn validate_not_fee_bearing(mint_account: &AccountInfo) -> Result<()> {
    if mint_account.owner == &anchor_spl::token::ID {
        require!(
            mint_account.data_len() == anchor_spl::token::spl_token::state::Mint::LEN,
            CoreError::InvalidTokenMint
        );
        anchor_spl::token::spl_token::state::Mint::unpack(&mint_account.try_borrow_data()?)
            .map_err(|_| CoreError::InvalidTokenMint)?;
        return Ok(());
    }

    if mint_account.owner == &anchor_spl::token_2022::spl_token_2022::ID {
        let mint_data = mint_account.try_borrow_data()?;
        let mint_state = StateWithExtensions::<anchor_spl::token_2022::spl_token_2022::state::Mint>::unpack(&mint_data)
            .map_err(|_| CoreError::InvalidTokenMint)?;
        let extension_types = mint_state
            .get_extension_types()
            .map_err(|_| CoreError::InvalidTokenMint)?;
        for ext in extension_types {
            match ext {
                ExtensionType::TransferFeeConfig | ExtensionType::ConfidentialTransferFeeConfig => {
                    return Err(CoreError::FeeBearingMintNotSupported.into());
                }
                _ => {}
            }
        }
        return Ok(());
    }

    Err(CoreError::InvalidTokenMint.into())
}

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

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash::hash,
    instruction::AccountMeta,
    program_error::ProgramError,
    pubkey::Pubkey,
    system_program::ID as SYSTEM_PROGRAM_ID,
};
use anchor_spl::token_interface::{self, Mint, TokenInterface, TransferChecked};

use crate::{OrbitError, User};

/// Closes an account and transfers all lamports to the given destination,
/// assigning the account to the system program, and resizing its data to zero length.
pub fn close_account<'a, 'b>(
    from: impl ToAccountInfo<'a>,
    to: impl ToAccountInfo<'b>,
) -> Result<()> {
    let from = from.to_account_info();
    let to = to.to_account_info();


    let to_lamports = to
        .lamports()
        .checked_add(from.lamports())
        .ok_or(ProgramError::ArithmeticOverflow)?;
    **to.lamports.borrow_mut() = to_lamports;
    **from.lamports.borrow_mut() = 0;

    from.assign(&SYSTEM_PROGRAM_ID);
    from.resize(0).map_err(Into::into)
}

/// Returns true if `wallet` is present in `user.wallets`.
pub(crate) fn is_whitelisted_wallet(user: &User, wallet: &Pubkey) -> bool {
    user.wallets.contains(wallet)
}

/// Extracts the six-digit numeric partner ID from values such as
/// `zp_123456::context`.
pub(crate) fn extract_partner_number(partner_id: &str) -> Result<u32> {
    let base = if let Some(colon_idx) = partner_id.find("::") {
        &partner_id[..colon_idx]
    } else {
        partner_id
    };
    let digits = base
        .strip_prefix("zp_")
        .ok_or(OrbitError::InvalidPartnerId)?;
    require!(digits.len() == 6, OrbitError::InvalidPartnerId);
    let num = digits
        .parse::<u32>()
        .map_err(|_| OrbitError::InvalidPartnerId)?;
    Ok(num)
}

/// Derives a 32-byte on-chain identifier from any string input.
///
/// Computes the SHA-256 digest of `s`, hex-encodes it into a 64-character lowercase
/// string, then copies the first 32 hex character bytes into the returned array.
/// Use this wherever `zynk-core` expects a hex-encoded identifier (e.g. `partner_id`
/// in `OrderTracker` seeds).
pub(crate) fn hashed(s: &str) -> [u8; 32] {
    let digest = hash(s.as_bytes()).to_bytes();
    let mut hex_string = String::with_capacity(64);
    for byte in digest.iter() {
        hex_string.push_str(&format!("{:02x}", byte));
    }
    let mut res = [0u8; 32];
    res.copy_from_slice(&hex_string.as_bytes()[..32]);
    res
}

/// Transfers tokens from a source to a destination using a PDA authority with signer seeds.
pub(crate) fn transfer_with_signer_seeds<'info>(
    token_program: &Interface<'info, TokenInterface>,
    source_token_account: &AccountInfo<'info>,
    destination_token_account: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    let cpi_accounts = TransferChecked {
        from: source_token_account.to_account_info(),
        to: destination_token_account.to_account_info(),
        mint: mint.to_account_info(),
        authority: authority.to_account_info(),
    };

    let cpi_ctx =
        CpiContext::new_with_signer(token_program.to_account_info(), cpi_accounts, signer_seeds);
    token_interface::transfer_checked(cpi_ctx, amount, mint.decimals)
}

/// Invokes Circle CCTP's `deposit_for_burn` instruction
pub(crate) fn cpi_cctp_deposit_for_burn<'info>(
    cctp_program: &AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    authority_account: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
    destination_domain: u32,
    mint_recipient: [u8; 32],
    dest_caller_bytes: [u8; 32],
    max_fee: u64,
    min_finality_threshold: u32,
    hook_data: Option<Vec<u8>>
) -> Result<()> {
    require!(amount > 0, OrbitError::ZeroAmount);

    let (disc_name, hook_bytes) = match hook_data {
        Some(hook_data) if !hook_data.is_empty() => {
            ("global:deposit_for_burn_with_hooks", hook_data)
        }
        _ => ("global:deposit_for_burn", Vec::new()),
    };

    let disc = hash(disc_name.as_bytes()).to_bytes();
    // 8+8+4+32+32+8+4 = 96 fixed bytes + up to len(hook_data) for the extension
    let mut ix_data = Vec::with_capacity(96 + hook_bytes.len());

    ix_data.extend_from_slice(&disc[..8]);
    ix_data.extend_from_slice(&amount.to_le_bytes());
    ix_data.extend_from_slice(&destination_domain.to_le_bytes());
    ix_data.extend_from_slice(&mint_recipient);

    ix_data.extend_from_slice(&dest_caller_bytes);
    ix_data.extend_from_slice(&max_fee.to_le_bytes());
    ix_data.extend_from_slice(&min_finality_threshold.to_le_bytes());

    if !hook_bytes.is_empty() {
        ix_data.extend_from_slice(&(hook_bytes.len() as u32).to_le_bytes());
        ix_data.extend_from_slice(&hook_bytes);
    }

    let mut account_metas = Vec::with_capacity(remaining_accounts.len());
    let mut account_infos = Vec::with_capacity(remaining_accounts.len() + 1);
    account_infos.push(cctp_program.clone());

    for acc in remaining_accounts {
        let is_signer = acc.key == authority_account.key || acc.is_signer;
        if acc.is_writable {
            account_metas.push(AccountMeta::new(*acc.key, is_signer));
        } else {
            account_metas.push(AccountMeta::new_readonly(*acc.key, is_signer));
        }
        account_infos.push(acc.clone());
    }

    let instruction = anchor_lang::solana_program::instruction::Instruction {
        program_id: *cctp_program.key,
        accounts: account_metas,
        data: ix_data,
    };

    anchor_lang::solana_program::program::invoke_signed(
        &instruction,
        &account_infos,
        signer_seeds,
    )?;

    Ok(())
}

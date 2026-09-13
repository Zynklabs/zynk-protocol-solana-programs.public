use anchor_lang::prelude::*;
use anchor_lang::solana_program::{hash::hash, program_error::ProgramError};
use anchor_spl::token_interface::{self, TransferChecked};
use zynk_core::{self, program::ZynkCore};

use crate::*;

pub(crate) fn deposit(ctx: Context<Deposit>, user_id: [u8; 32], amount: u64) -> Result<()> {
    require!(amount != 0, OrbitError::ZeroAmount);

    let user = &mut ctx.accounts.user;

    require!(user.user_type != UserType::NCW, OrbitError::InvalidOperation);

    require!(
        user.principal_in
            .checked_sub(user.principal_out)
            .ok_or(ProgramError::ArithmeticOverflow)?
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?
            <= user.max_principal,
        OrbitError::MaxDepositExceeded
    );

    let expected_destination = if user.user_type == UserType::LP {
        Pubkey::find_program_address(
            &[zynk_core::ZYNK_OP_VAULT_SEED, hash(b"0001").as_ref()],
            &ZynkCore::id()
        ).0
    } else {
        user.key()  // ICV — NCW is already rejected above
    };

    require!(
        ctx.accounts.destination_token_account.owner == expected_destination,
        zynk_core::CoreError::InvalidAccount
    );

    let cpi_accounts = TransferChecked {
        from: ctx.accounts.source_token_account.to_account_info(),
        to: ctx.accounts.destination_token_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(),
    };

    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

    user.principal_in = user.principal_in
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    emit!(TxEvent {
        event_name: "Deposit".to_string(),
        user_id,
        from_owner: ctx.accounts.source_token_account.owner.key(),
        to_owner: ctx.accounts.destination_token_account.owner.key(),
        from: ctx.accounts.source_token_account.key(),
        to: ctx.accounts.destination_token_account.key(),
        amount,
        token: ctx.accounts.mint.key(),
        domain_separator: DOMAIN_SEPARATOR,
        order_id: [0u8; 32],
        signer: ctx.accounts.signer.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

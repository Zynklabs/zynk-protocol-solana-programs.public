use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_error::ProgramError;
use zynk_core::{self, program::ZynkCore};

use crate::*;
use crate::utils::*;

pub(crate) fn pledge(
    ctx: Context<Pledge>,
    user_id: [u8; 32],
    amount: u64,
) -> Result<()> {
    require!(amount != 0, OrbitError::ZeroAmount);

    let user = &ctx.accounts.user;

    require!(
        user.principal_in
            .checked_sub(user.principal_out)
            .ok_or(ProgramError::ArithmeticOverflow)?
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?
            <= user.max_principal as u64,
        OrbitError::MaxDepositExceeded
    );

    let ovault_bump_ref = [ctx.bumps.ovault];
    let signer_seeds = &[&[VAULT_SEED, b"orbit", &ovault_bump_ref][..]];

    let expected_destination = if user.user_type == UserType::ICV {
        user.key()
    } else {
        Pubkey::find_program_address(
            &[zynk_core::ZYNK_OP_VAULT_SEED, hashed("0001").as_ref()],
            &ZynkCore::id()
        ).0
    };

    require!(
        ctx.accounts.destination_token_account.owner == expected_destination,
        zynk_core::CoreError::InvalidAccount
    );

    transfer_with_signer_seeds(
        &ctx.accounts.token_program,
        &ctx.accounts.source_token_account.to_account_info(),
        &ctx.accounts.destination_token_account.to_account_info(),
        &ctx.accounts.mint,
        &ctx.accounts.ovault.to_account_info(),
        signer_seeds,
        amount,
    )?;

    let user = &mut ctx.accounts.user;
    user.principal_in = user
        .principal_in
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    emit!(TxEvent {
        event_name: "Pledge".to_string(),
        user_id,
        from_owner: ctx.accounts.source_token_account.owner.key(),
        to_owner: ctx.accounts.destination_token_account.owner.key(),
        from: ctx.accounts.source_token_account.key(),
        to: ctx.accounts.destination_token_account.key(),
        amount,
        token: ctx.accounts.mint.key(),
        domain_separator: DOMAIN_SEPARATOR,
        order_id: [0u8; 32],
        signer: ctx.accounts.manager.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

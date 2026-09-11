use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_error::ProgramError;
use zynk_core;

use crate::*;
use crate::utils::*;

pub(crate) fn request_withdraw(
    ctx: Context<RequestWithdraw>,
    user_id: [u8; 32],
    destination: Pubkey,
    amount: u64,
) -> Result<()> {
    require!(amount != 0, OrbitError::ZeroAmount);

    let signer_user = &ctx.accounts.signer_user;
    require!(
        signer_user.user_type != UserType::NCW,
        OrbitError::InvalidOperation
    );

    require!(
        is_whitelisted_wallet(signer_user, &ctx.accounts.signer.key()),
        zynk_core::CoreError::InvalidAccount
    );
    require!(
        is_whitelisted_wallet(signer_user, &destination),
        zynk_core::CoreError::InvalidAccount
    );

    require!(
        signer_user
            .principal_in
            .checked_sub(signer_user.principal_out)
            .ok_or(ProgramError::ArithmeticOverflow)?
            >= amount,
        OrbitError::InsufficientBalance
    );

    let withdraw_request = &mut ctx.accounts.withdraw_request;
    withdraw_request.user_id = user_id;
    withdraw_request.amount = amount;
    withdraw_request.destination = destination;

    emit!(AxEvent {
        event_name: "WithdrawRequested".to_string(),
        user_id,
        public_key: ctx.accounts.signer.key(),
        domain_separator: DOMAIN_SEPARATOR,
        partners: Vec::new(),
    });
    Ok(())
}

pub(crate) fn approve_withdraw(
    ctx: Context<ApproveWithdraw>,
    user_id: [u8; 32],
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(
        ctx.accounts.admin.key() == config.admin,
        zynk_core::CoreError::Unauthorized
    );

    let request_data = ctx.accounts.request.try_borrow_data()?;
    let withdraw_request = WithdrawRequest::try_deserialize(&mut &request_data[..])
        .map_err(|_| OrbitError::InvalidRequestAccount)?;
    drop(request_data);

    let user = &mut ctx.accounts.user;

    user.principal_out = user
        .principal_out
        .checked_add(withdraw_request.amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    require!(
        ctx.accounts.destination_token_account.owner == withdraw_request.destination,
        zynk_core::CoreError::InvalidAccount
    );

    require!(
        ctx.accounts.source_token_account.amount >= withdraw_request.amount,
        OrbitError::InsufficientTokenBalance
    );

    match user.user_type {
        UserType::ICV => {
            require!(
                ctx.accounts.source_token_account.owner == user.key(),
                zynk_core::CoreError::InvalidAccount
            );

            let seeds: &[&[u8]] = &[
                USER_SEED,
                user_id.as_ref(),
                &[ctx.bumps.user],
            ];
            let signer_seeds = &[&seeds[..]];
            transfer_with_signer_seeds(
                &ctx.accounts.token_program,
                &ctx.accounts.source_token_account.to_account_info(),
                &ctx.accounts.destination_token_account.to_account_info(),
                &ctx.accounts.mint,
                &ctx.accounts.user.to_account_info(),
                signer_seeds,
                withdraw_request.amount as u64,
            )?;
        }
        UserType::LP => {
            let ovault = ctx
                .accounts
                .ovault
                .as_ref()
                .ok_or(zynk_core::CoreError::InvalidAccount)?;
            let ovault_bump = ctx.bumps.ovault.ok_or(zynk_core::CoreError::InvalidAccount)?;
            let ovault_bump_ref = [ovault_bump];
            let signer_seeds = &[&[VAULT_SEED, b"orbit", &ovault_bump_ref][..]];
            transfer_with_signer_seeds(
                &ctx.accounts.token_program,
                &ctx.accounts.source_token_account.to_account_info(),
                &ctx.accounts.destination_token_account.to_account_info(),
                &ctx.accounts.mint,
                &ovault.to_account_info(),
                signer_seeds,
                withdraw_request.amount,
            )?;
        }
        UserType::NCW => {
            return Err(OrbitError::InvalidOperation.into());
        }
    }

    close_account(
        ctx.accounts.request.to_account_info(),
        ctx.accounts.admin.to_account_info(),
    )?;

    emit!(TxEvent {
        event_name: "WithdrawApproved".to_string(),
        user_id,
        from_owner: ctx.accounts.source_token_account.owner.key(),
        to_owner: ctx.accounts.destination_token_account.owner.key(),
        from: ctx.accounts.source_token_account.key(),
        to: ctx.accounts.destination_token_account.key(),
        amount: withdraw_request.amount as u64,
        token: ctx.accounts.mint.key(),
        domain_separator: DOMAIN_SEPARATOR,
        order_id: [0u8; 32],
    });

    Ok(())
}

pub(crate) fn reject_withdraw(ctx: Context<RejectWithdraw>, user_id: [u8; 32]) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(
        ctx.accounts.admin.key() == config.admin,
        zynk_core::CoreError::Unauthorized
    );

    close_account(
        ctx.accounts.request.to_account_info(),
        ctx.accounts.admin.to_account_info(),
    )?;

    emit!(AxEvent {
        event_name: "WithdrawRejected".to_string(),
        user_id,
        public_key: ctx.accounts.admin.key(),
        domain_separator: DOMAIN_SEPARATOR,
        partners: Vec::new(),
    });

    Ok(())
}

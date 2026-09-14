use anchor_lang::prelude::*;
use zynk_core;

use crate::*;
use crate::utils::*;

pub(crate) fn update_cliff_period(
    ctx: Context<UpdateCliffPeriod>,
    user_id: [u8; 32],
    cliff_period: Option<i64>,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(
        ctx.accounts.admin.key() == config.admin,
        zynk_core::CoreError::Unauthorized
    );

    let now = Clock::get()?.unix_timestamp;
    let resolved_cliff = cliff_period.unwrap_or(ctx.accounts.user.cliff_period);
    require!(resolved_cliff > now, OrbitError::CliffPeriodInPast);

    let request_user = &mut ctx.accounts.request_user;
    request_user.user_id = user_id;
    request_user.cliff_period = resolved_cliff;

    emit!(AxEvent {
        event_name: "CliffPeriodUpdated".to_string(),
        user_id,
        public_key: ctx.accounts.user.wallets[0],
        domain_separator: DOMAIN_SEPARATOR,
        partners: Vec::new(),
        signer: ctx.accounts.admin.key(),
        timestamp: now,
        value: resolved_cliff,
    });
    Ok(())
}

pub(crate) fn approve_cliff_period(ctx: Context<ApproveCliffPeriod>, user_id: [u8; 32]) -> Result<()> {
    let user = &mut ctx.accounts.user;

    require!(
        is_whitelisted_wallet(user, &ctx.accounts.signer.key()),
        zynk_core::CoreError::InvalidAccount
    );

    let new_cliff_period = ctx.accounts.request.cliff_period;
    user.cliff_period = new_cliff_period;

    close_account(
        ctx.accounts.request.to_account_info(),
        ctx.accounts.signer.to_account_info(),
    )?;

    emit!(AxEvent {
        event_name: "CliffPeriodApproved".to_string(),
        user_id: user_id,
        public_key: ctx.accounts.signer.key(),
        domain_separator: DOMAIN_SEPARATOR,
        partners: Vec::new(),
        signer: ctx.accounts.signer.key(),
        timestamp: Clock::get()?.unix_timestamp,
        value: new_cliff_period,
    });

    Ok(())
}

pub(crate) fn reject_cliff_period(ctx: Context<RejectCliffPeriod>, user_id: [u8; 32]) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    require!(
        signer == ctx.accounts.config.admin
            || is_whitelisted_wallet(&ctx.accounts.user, &signer),
        zynk_core::CoreError::Unauthorized
    );

    // Capture the rejected value before close_account zeroes the account data.
    let rejected_cliff = ctx.accounts.request.cliff_period;
    let timestamp = Clock::get()?.unix_timestamp;

    close_account(
        ctx.accounts.request.to_account_info(),
        ctx.accounts.signer.to_account_info(),
    )?;

    emit!(AxEvent {
        event_name: "CliffPeriodRejected".to_string(),
        user_id,
        public_key: signer,
        domain_separator: DOMAIN_SEPARATOR,
        partners: Vec::new(),
        signer,
        timestamp,
        value: rejected_cliff,
    });

    Ok(())
}

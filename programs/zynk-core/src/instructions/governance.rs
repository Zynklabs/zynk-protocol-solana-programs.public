use anchor_lang::prelude::*;

use crate::*;

pub(crate) fn request_timelock(
    ctx: Context<RequestTimelock>,
    action_u8: u8,
    value: Option<Pubkey>,
) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let timestamp = Clock::get()?.unix_timestamp;
    let timelock = &mut ctx.accounts.timelock;
    let action: TimelockAction = action_u8.try_into()?;

    timelock.action = action_u8;
    timelock.value = value.unwrap_or(Pubkey::default());
    timelock.eta = timestamp + action.delay();
    timelock.req_by = authority;

    emit!(Action {
        action: action_u8,
        timelock: timelock.key(),
        status: ActionStatus::Initiated,
        timestamp,
        signer: authority,
    });

    Ok(())
}

pub(crate) fn revoke_timelock(ctx: Context<SignTimelock>) -> Result<()> {
    let authority = &ctx.accounts.authority;
    let timelock = &ctx.accounts.timelock;

    require!(timelock.req_by != authority.key(), CoreError::Unauthorized);

    close_account(timelock, authority)?;

    emit!(Action {
        action: timelock.action,
        timelock: timelock.key(),
        status: ActionStatus::Revoked,
        timestamp: Clock::get()?.unix_timestamp,
        signer: authority.key(),
    });

    Ok(())
}

pub(crate) fn ack_timelock(ctx: Context<SignTimelock>) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let timelock = &mut ctx.accounts.timelock;

    require!(timelock.req_by != authority, CoreError::Unauthorized);
    require!(timelock.ack_by.is_none(), CoreError::Unauthorized);

    timelock.ack_by = Some(authority);

    emit!(Action {
        action: timelock.action,
        timelock: timelock.key(),
        status: ActionStatus::Acked,
        timestamp: Clock::get()?.unix_timestamp,
        signer: authority,
    });

    Ok(())
}

pub(crate) fn execute_request(ctx: Context<SignTimelock>) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let timestamp = Clock::get()?.unix_timestamp;
    let timelock = &mut ctx.accounts.timelock;
    let action: TimelockAction = timelock.action.try_into()?;

    require!(timelock.req_by != authority, CoreError::Unauthorized);
    require!(timelock.ack_by != Some(authority), CoreError::Unauthorized);

    let acked = timelock.ack_by.is_some();
    let eta_ready = timestamp >= timelock.eta;

    let ok = if action == TimelockAction::UpdateGuardian {
        eta_ready && acked
    } else {
        eta_ready || acked
    };

    require!(ok, CoreError::ActionUnderReview);

    let value = timelock.value;
    validate_address(&value)?;

    let config = &mut ctx.accounts.config;

    match action {
        TimelockAction::UpdateAdmin => config.admin = value,
        TimelockAction::UpdateManager => config.manager = value,
        TimelockAction::UpdateGuardian => config.guardian = value,
        _ => return Err(error!(CoreError::InvalidAction)),
    }

    // Capture fields before closing the account, as close_account zeroes the data.
    let action_u8 = timelock.action;
    let timelock_key = timelock.key();

    close_account(timelock, &ctx.accounts.authority)?;

    emit!(Action {
        action: action_u8,
        timelock: timelock_key,
        status: ActionStatus::Executed,
        timestamp,
        signer: authority,
    });

    Ok(())
}

pub(crate) fn unpause(ctx: Context<SignTimelock>) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let timestamp = Clock::get()?.unix_timestamp;
    let timelock = &mut ctx.accounts.timelock;

    require!(TimelockAction::try_from(timelock.action)? == TimelockAction::Unpause, CoreError::InvalidAction);

    let acked = timelock.ack_by.is_some();
    let eta_ready = timestamp >= timelock.eta;
    require!(eta_ready || acked, CoreError::ActionUnderReview);

    let config = &mut ctx.accounts.config;

    config.paused = false;

    // Capture fields before closing the account, as close_account zeroes the data.
    let action_u8 = timelock.action;
    let timelock_key = timelock.key();

    close_account(timelock, &ctx.accounts.authority)?;

    emit!(Action {
        action: action_u8,
        timelock: timelock_key,
        status: ActionStatus::Executed,
        timestamp,
        signer: authority,
    });

    Ok(())
}

pub(crate) fn pause(ctx: Context<Pause>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    config.paused = true;
    Ok(())
}

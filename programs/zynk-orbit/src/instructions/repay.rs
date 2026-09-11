use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_error::ProgramError;
use anchor_spl::token_interface::TokenAccount;
use zynk_core::{self, EventArg};

use crate::*;
use crate::utils::*;

pub(crate) fn repay<'info>(
    ctx: Context<'_, '_, '_, 'info, Repay<'info>>,
    partner_id: [u8; 32],
    order_id: [u8; 32],
    zov_id: [u8; 32],
    amount: u64,
    meta: Option<Vec<EventArg>>,
) -> Result<()> {
    // Each position is supplied as
    // [destination_token_account, user, position_pda].
    let num_positions = ctx.remaining_accounts.len() / 3;
    require!(
        ctx.remaining_accounts.len() % 3 == 0,
        OrbitError::InvalidPositionOperation
    );
    require!(amount > 0, OrbitError::ZeroAmount);

    let config = &ctx.accounts.config;
    require!(
        ctx.accounts.manager.key() == config.manager,
        zynk_core::CoreError::Unauthorized
    );

    require!(
        config.whitelisted_token_mints.contains(&ctx.accounts.mint.key()),
        zynk_core::CoreError::InvalidTokenMint
    );

    let order_tracker_data = ctx.accounts.order_tracker.try_borrow_data()?;
    let order_tracker = zynk_core::OrderTracker::try_deserialize(&mut &order_tracker_data[..])
        .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
    require!(
        ctx.accounts.mint.key() == order_tracker.mint,
        zynk_core::CoreError::InvalidTokenMint
    );
    let amount_out = order_tracker.amount_out;
    let amount_in = order_tracker.amount_in;
    let amount_borrowed = order_tracker.amount_borrowed;
    let amount_repaid_tracker = order_tracker.amount_repaid;
    drop(order_tracker_data);

    let remaining_order = amount_out
        .checked_sub(amount_in)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    // Aggregate position outstanding across ALL positions (not just supplied ones).
    let aggregate_position_outstanding = amount_borrowed
        .checked_sub(amount_repaid_tracker)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let prepared_amount = amount.min(remaining_order);
    let remaining_accounts = ctx.remaining_accounts;

    // First pass: validate all users and positions, cache user_type and remaining amount.
    // Second pass: distribute shares and execute transfers using cached data.
    struct PositionInfo {
        user_type: UserType,
        user_key: Pubkey,
        remaining: u64,
        share: u64,
    }
    let mut position_infos = Vec::with_capacity(num_positions);

    for i in 0..num_positions {
        let base_idx = i * 3;
        let _dst_token_account: &AccountInfo = &remaining_accounts[base_idx];
        let user_account: &AccountInfo = &remaining_accounts[base_idx + 1];
        let position_pda: &AccountInfo = &remaining_accounts[base_idx + 2];

        let user_data = user_account.data.borrow();
        let user = User::try_deserialize(&mut &user_data[..])
            .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
        let user_type = user.user_type;
        let user_id = user.user_id;
        let user_key = user_account.key();
        require!(user_account.owner == ctx.program_id, zynk_core::CoreError::InvalidAccount);
        let (expected_user_key, _) = Pubkey::find_program_address(
            &[USER_SEED, user_id.as_ref()],
            ctx.program_id,
        );
        require!(user_key == expected_user_key, zynk_core::CoreError::InvalidAccount);
        drop(user_data);

        require!(
            user_type != UserType::LP,
            zynk_core::CoreError::Unauthorized
        );

        let position_data = position_pda.data.borrow();
        let position = Position::try_deserialize(&mut &position_data[..])
            .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
        require!(position_pda.owner == ctx.program_id, zynk_core::CoreError::InvalidAccount);
        require!(position.order_id == order_id, OrbitError::PositionOrderMismatch);
        require!(position.partner_id == partner_id, OrbitError::PositionOrderMismatch);
        require!(position.user_id == user_id, OrbitError::UserIdMismatch);
        let (expected_position_key, _) = Pubkey::find_program_address(
            &[POSITION_SEED, order_id.as_ref(), user_id.as_ref()],
            ctx.program_id,
        );
        require!(position_pda.key() == expected_position_key, zynk_core::CoreError::InvalidAccount);
        let remaining = position
            .amount_borrowed
            .checked_sub(position.amount_repaid)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        drop(position_data);

        position_infos.push(PositionInfo {
            user_type: user_type,
            user_key,
            remaining,
            share: 0,
        });
    }

    // Sum of outstanding amounts for the supplied positions only.
    let supplied_position_total = position_infos.iter().try_fold(0u64, |total, info| {
        total.checked_add(info.remaining).ok_or(ProgramError::ArithmeticOverflow)
    })?;

    // Cap the amount that goes to position repayments: cannot exceed supplied
    // position total, cannot exceed aggregate position outstanding, cannot exceed
    // the prepared amount.
    let position_repay_cap = supplied_position_total
        .min(aggregate_position_outstanding)
        .min(prepared_amount);

    // Determine how much goes to ZOV settlement (excess after position repays).
    // ZOV settlement is only allowed when ALL position debt is fully repaid.
    let position_repay_amount;
    let zov_settlement;
    if prepared_amount > position_repay_cap {
        let excess = prepared_amount
            .checked_sub(position_repay_cap)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        // remaining unsupplied position debt after this repayment
        let remaining_unsupplied_debt = aggregate_position_outstanding
            .checked_sub(position_repay_cap)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        if remaining_unsupplied_debt == 0 {
            // All position debt is settled; excess can go to ZOV.
            position_repay_amount = position_repay_cap;
            zov_settlement = excess;
        } else {
            // There are still open positions not supplied in this call.
            // Excess cannot go to ZOV — cap the total at position repay cap.
            position_repay_amount = position_repay_cap;
            zov_settlement = 0;
        }
    } else {
        position_repay_amount = prepared_amount;
        zov_settlement = 0;
    }

    let total_repay_for_core = position_repay_amount
        .checked_add(zov_settlement)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    // Allocate proportionally with ceiling division while capping each share
    // by both the position balance and the undistributed amount.
    let mut remaining_amount = position_repay_amount;
    for info in position_infos.iter_mut() {
        let share = if position_repay_amount > 0 && supplied_position_total > 0 {
            let prepared_128 = position_repay_amount as u128;
            let remaining_info_128 = info.remaining as u128;
            let total_128 = supplied_position_total as u128;

            // Perform intermediate math safely in 128-bit space
            let numerator = prepared_128
                .checked_mul(remaining_info_128)
                .ok_or(ProgramError::ArithmeticOverflow)?;

            // Ceiling division: ceil(A / B) = (A + B - 1) / B
            let numerator_ceil = numerator
                .checked_add(total_128.saturating_sub(1))
                .ok_or(ProgramError::ArithmeticOverflow)?;

            let raw_share_128 = numerator_ceil
                .checked_div(total_128)
                .ok_or(ProgramError::ArithmeticOverflow)?;

            // Safe downcast back to u64
            let raw_share = u64::try_from(raw_share_128)
                .map_err(|_| ProgramError::ArithmeticOverflow)?;

            raw_share.min(info.remaining).min(remaining_amount)
        } else {
            0
        };
        remaining_amount = remaining_amount.checked_sub(share).ok_or(ProgramError::ArithmeticOverflow)?;

        info.share = share;
    }

    let mut shares = Vec::with_capacity(num_positions);
    let mut cpi_destinations = Vec::with_capacity(num_positions);

    for i in 0..num_positions {
        let base_idx = i * 3;
        let dst_token_account: &AccountInfo = &remaining_accounts[base_idx];
        let info = &position_infos[i];
        shares.push(info.share);
        cpi_destinations.push(dst_token_account.clone());

        if info.share == 0 {
            continue;
        }

        // `AccountInfo::owner` identifies the Token Program; the token
        // authority must be read from the serialized token account.
        let dst_token_authority = {
            let data = dst_token_account.try_borrow_data()?;
            let token_account = TokenAccount::try_deserialize_unchecked(&mut &data[..])
                .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
            token_account.owner
        };

        match info.user_type {
            UserType::NCW => {
                let user_account: &AccountInfo = &remaining_accounts[base_idx + 1];
                let user_data = user_account.data.borrow();
                let user = User::try_deserialize(&mut &user_data[..])
                    .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
                require!(
                    is_whitelisted_wallet(&user, &dst_token_authority),
                    zynk_core::CoreError::InvalidAccount
                );
            }
            UserType::ICV => {
                require!(
                    dst_token_authority == info.user_key,
                    zynk_core::CoreError::InvalidAccount
                );
            }
            UserType::LP => {
                return Err(zynk_core::CoreError::Unauthorized.into());
            }
        }
    }

    // Atomically move the gross amount into Core's ZOV and transfer open-position
    // principal directly from the ZOV to each position's destination token account.
    // Any excess remains in the ZOV.
    let authority_bump = ctx.bumps.orbit_authority;
    let authority_seeds: &[&[u8]] = &[
        zynk_core::ORBIT_CPI_AUTHORITY_SEED,
        &[authority_bump],
    ];
    let core_accounts = zynk_core::cpi::accounts::ReplenishAndRepay {
        config: ctx.accounts.config.to_account_info(),
        orbit_authority: ctx.accounts.orbit_authority.to_account_info(),
        manager: ctx.accounts.manager.to_account_info(),
        order_tracker: ctx.accounts.order_tracker.to_account_info(),
        partner_deposit_vault: ctx.accounts.partner_deposit_vault.to_account_info(),
        pdv_token_account: ctx.accounts.pdv_token_account.to_account_info(),
        zynk_op_vault: ctx.accounts.zynk_op_vault.to_account_info(),
        zov_token_account: ctx.accounts.zov_token_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };
    zynk_core::cpi::replenish_and_repay(
        CpiContext::new_with_signer(
            ctx.accounts.zynk_core_program.to_account_info(),
            core_accounts,
            &[authority_seeds],
        )
        .with_remaining_accounts(cpi_destinations),
        zov_id,
        amount,
        total_repay_for_core,
        shares,
        meta,
    )?;

    for i in 0..num_positions {
        let base_idx = i * 3;
        let position_pda: &AccountInfo = &remaining_accounts[base_idx + 2];

        let info = &position_infos[i];
        if info.share == 0 {
            continue;
        }

        let is_position_closed = {
            let mut position_data = position_pda.try_borrow_mut_data()?;
            let mut position =
                Position::try_deserialize_unchecked(&mut &position_data[..])?;
            position.amount_repaid = position
                .amount_repaid
                .checked_add(info.share)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            let closed = position.amount_repaid >= position.amount_borrowed;
            position.try_serialize(&mut &mut position_data[..])?;
            closed
        };

        if info.user_type == UserType::NCW {
            let user_account = &remaining_accounts[base_idx + 1];
            let mut user_data = user_account.try_borrow_mut_data()?;
            let mut user = User::try_deserialize_unchecked(&mut &user_data[..])?;
            user.principal_out = user
                .principal_out
                .checked_add(info.share)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            user.try_serialize(&mut &mut user_data[..])?;
        }

        if is_position_closed {
            close_account(position_pda, &ctx.accounts.manager)?;
        }
    }

    emit!(TxEvent {
        event_name: "Repay".to_string(),
        user_id: [0u8; 32],
        from_owner: ctx.accounts.zynk_op_vault.key(),
        to_owner: Pubkey::default(),
        from: ctx.accounts.zov_token_account.key(),
        to: Pubkey::default(),
        amount: total_repay_for_core,
        token: ctx.accounts.mint.key(),
        domain_separator: DOMAIN_SEPARATOR,
        order_id,
    });

    Ok(())
}

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_error::ProgramError;
use anchor_spl::token_interface::{self, TokenAccount, TransferChecked};
use zynk_core;

use crate::*;
use crate::utils::*;

pub(crate) fn claim<'info>(
    ctx: Context<'_, '_, '_, 'info, Claim<'info>>,
    user_id: [u8; 32],
    operations: Vec<ClaimOperation>,
) -> Result<()> {
    require!(
        ctx.remaining_accounts.len() == operations.len() * 6,
        OrbitError::InvalidPositionOperation
    );

    let user = &ctx.accounts.user;
    require!(
        ctx.accounts.config.whitelisted_token_mints.contains(&ctx.accounts.mint.key()),
        zynk_core::CoreError::InvalidTokenMint
    );
    require!(
        is_whitelisted_wallet(user, &ctx.accounts.signer.key()),
        zynk_core::CoreError::InvalidAccount
    );
    require!(
        Clock::get()?.unix_timestamp >= user.cliff_period,
        OrbitError::CliffPeriodNotOver
    );
    require!(
        is_whitelisted_wallet(user, &ctx.accounts.destination_token_account.owner),
        zynk_core::CoreError::InvalidAccount
    );

    let claimable = user
        .principal_in
        .checked_sub(user.principal_out)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    require!(claimable > 0, OrbitError::ZeroAmount);

    let mut total_paid = 0u64;
    if user.user_type == UserType::ICV {
        let icv_token_account = ctx
            .accounts
            .icv_token_account
            .as_ref()
            .ok_or(zynk_core::CoreError::InvalidAccount)?;
        require!(icv_token_account.owner == user.key(), zynk_core::CoreError::InvalidAccount);
        require!(icv_token_account.mint == ctx.accounts.mint.key(), zynk_core::CoreError::InvalidTokenMint);

        let liquid_payment = icv_token_account.amount.min(claimable);
        if liquid_payment > 0 {
            let user_seeds: &[&[u8]] = &[
                USER_SEED,
                user_id.as_ref(),
                &[ctx.bumps.user],
            ];
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: icv_token_account.to_account_info(),
                        to: ctx.accounts.destination_token_account.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                    &[user_seeds],
                ),
                liquid_payment,
                ctx.accounts.mint.decimals,
            )?;
            total_paid = liquid_payment;
        }
    } else {
        require!(user.user_type == UserType::NCW, OrbitError::InvalidOperation);
        require!(ctx.accounts.icv_token_account.is_none(), zynk_core::CoreError::InvalidAccount);
    }

    for (index, operation) in operations.iter().enumerate() {
        if total_paid >= claimable {
            break;
        }

        // [position, core_order_tracker, partner_deposit_vault,
        //  pdv_token_account, zynk_op_vault, zov_token_account]
        let base = index * 6;
        let position_account = &ctx.remaining_accounts[base];
        let order_tracker_account = &ctx.remaining_accounts[base + 1];
        let partner_deposit_vault = &ctx.remaining_accounts[base + 2];
        let pdv_token_account = &ctx.remaining_accounts[base + 3];
        let zynk_op_vault = &ctx.remaining_accounts[base + 4];
        let zov_token_account = &ctx.remaining_accounts[base + 5];

        require!(position_account.owner == ctx.program_id, zynk_core::CoreError::InvalidAccount);
        let position_data = position_account.try_borrow_data()?;
        let position = Position::try_deserialize(&mut &position_data[..])
            .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
        require!(position.user_id == user_id, OrbitError::UserIdMismatch);
        let (expected_position, _) = Pubkey::find_program_address(
            &[POSITION_SEED, position.order_id.as_ref(), user_id.as_ref()],
            ctx.program_id,
        );
        require!(position_account.key() == expected_position, zynk_core::CoreError::InvalidAccount);
        let position_outstanding = position
            .amount_borrowed
            .checked_sub(position.amount_repaid)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let position_order_id = position.order_id;
        let position_partner_id = position.partner_id;
        drop(position_data);

        if position_outstanding == 0 {
            continue;
        }

        let tracker_data = order_tracker_account.try_borrow_data()?;
        let tracker = zynk_core::OrderTracker::try_deserialize(&mut &tracker_data[..])
            .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
        require!(tracker.order_id == position_order_id, OrbitError::PositionOrderMismatch);
        require!(tracker.partner_id == position_partner_id, OrbitError::PositionOrderMismatch);
        require!(tracker.mint == ctx.accounts.mint.key(), zynk_core::CoreError::InvalidTokenMint);
        let core_outstanding = tracker
            .amount_out
            .checked_sub(tracker.amount_in)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        drop(tracker_data);

        let pdv_data = pdv_token_account.try_borrow_data()?;
        let pdv = TokenAccount::try_deserialize_unchecked(&mut &pdv_data[..])
            .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
        require!(pdv.mint == ctx.accounts.mint.key(), zynk_core::CoreError::InvalidTokenMint);
        let remaining_claimable = claimable
            .checked_sub(total_paid)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let recovered = remaining_claimable
            .min(position_outstanding)
            .min(core_outstanding)
            .min(pdv.amount);
        drop(pdv_data);

        if recovered == 0 {
            continue;
        }

        let authority_seeds: &[&[u8]] = &[
            zynk_core::ORBIT_CPI_AUTHORITY_SEED,
            &[ctx.bumps.orbit_authority],
        ];
        let core_accounts = zynk_core::cpi::accounts::ReplenishAndRepay {
            config: ctx.accounts.config.to_account_info(),
            orbit_authority: ctx.accounts.orbit_authority.to_account_info(),
            manager: ctx.accounts.core_manager.to_account_info(),
            order_tracker: order_tracker_account.to_account_info(),
            partner_deposit_vault: partner_deposit_vault.to_account_info(),
            pdv_token_account: pdv_token_account.to_account_info(),
            zynk_op_vault: zynk_op_vault.to_account_info(),
            zov_token_account: zov_token_account.to_account_info(),
            destination_token_account: ctx.accounts.destination_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        };
        zynk_core::cpi::replenish_and_repay(
            CpiContext::new_with_signer(
                ctx.accounts.zynk_core_program.to_account_info(),
                core_accounts,
                &[authority_seeds],
            ),
            operation.zov_id,
            recovered,
            recovered,
            None,
        )?;

        let is_closed = {
            let mut position_data = position_account.try_borrow_mut_data()?;
            let mut position = Position::try_deserialize_unchecked(&mut &position_data[..])?;
            position.amount_repaid = position
                .amount_repaid
                .checked_add(recovered)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            let closed = position.amount_repaid == position.amount_borrowed;
            position.try_serialize(&mut &mut position_data[..])?;
            closed
        };
        if is_closed {
            close_account(position_account, &ctx.accounts.core_manager)?;
        }
        total_paid = total_paid
            .checked_add(recovered)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }

    require!(total_paid > 0, OrbitError::ZeroAmount);
    let user = &mut ctx.accounts.user;
    user.principal_out = user
        .principal_out
        .checked_add(total_paid)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    emit!(TxEvent {
        event_name: "Claim".to_string(),
        user_id,
        from_owner: ctx.accounts.user.key(),
        to_owner: ctx.accounts.destination_token_account.owner,
        from: ctx.accounts.icv_token_account.as_ref().map(|account| account.key()).unwrap_or_default(),
        to: ctx.accounts.destination_token_account.key(),
        amount: total_paid,
        token: ctx.accounts.mint.key(),
        domain_separator: DOMAIN_SEPARATOR,
        order_id: [0u8; 32],
    });

    Ok(())
}

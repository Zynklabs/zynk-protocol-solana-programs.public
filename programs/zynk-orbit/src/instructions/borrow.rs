use anchor_lang::prelude::*;
use anchor_lang::solana_program::{hash::hash, program_error::ProgramError};
use anchor_spl::token_interface::TokenAccount;
use zynk_core::{self, cpi::accounts::CreateOrder, EventArg};

use crate::*;
use crate::utils::*;

pub(crate) fn borrow<'info>(
    ctx: Context<'_, '_, '_, 'info, Borrow<'info>>,
    partner_id: String,
    order_id: [u8; 32],
    zov_id: [u8; 32],
    amount: u64,
    positions: Vec<PositionOperation>,
    meta: Option<Vec<EventArg>>,
) -> Result<()> {
    require!(amount > 0, OrbitError::ZeroAmount);
    require!(!positions.is_empty(), OrbitError::EmptyPositions);
    require!(
        ctx.remaining_accounts.len() == positions.len() * 4,
        OrbitError::InvalidPositionOperation
    );

    // The numeric prefix is used for Orbit authorization; Core receives the
    // hash of the complete partner identifier.
    let partner_number = extract_partner_number(&partner_id)?;
    let partner_id_bytes = hash(partner_id.as_bytes()).to_bytes();

    let mut total_position_amount: u64 = 0;
    for pos in &positions {
        require!(pos.amount > 0, OrbitError::ZeroAmount);
        total_position_amount = total_position_amount
            .checked_add(pos.amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }

    require!(total_position_amount == amount, OrbitError::AmountMismatch);

    let remaining_accounts = ctx.remaining_accounts;

    for (i, pos) in positions.iter().enumerate() {
        // Each position requires 4 remaining accounts:
        // [source_token_account, authority_account, user, position_pda]
        let base_idx = i * 4;
        require!(
            base_idx + 3 < remaining_accounts.len(),
            OrbitError::InvalidPositionOperation
        );
        let source_token_account = &remaining_accounts[base_idx];
        let authority_account = &remaining_accounts[base_idx + 1];
        let user_account = &remaining_accounts[base_idx + 2];
        let position_pda = &remaining_accounts[base_idx + 3];

        let (user_id, user_type) = {
            let user_data = user_account.data.borrow();
            let user = User::try_deserialize(&mut &user_data[..])
                .map_err(|_| zynk_core::CoreError::InvalidAccount)?;

            // An empty partner list intentionally permits every partner.
            if !user.whitelisted_partners.is_empty() {
                require!(
                    user.whitelisted_partners.contains(&partner_number),
                    OrbitError::PartnerNotWhitelisted
                );
            }

            (user.user_id, user.user_type)
        };

        require!(user_type != UserType::LP, zynk_core::CoreError::Unauthorized);

        match user_type {
            UserType::NCW => {
                let seeds: &[&[u8]] = &[VAULT_SEED, pos.vault_id.as_ref()];
                let (expected_authority, bump) = Pubkey::find_program_address(seeds, ctx.program_id);
                require!(
                    authority_account.key() == expected_authority,
                    zynk_core::CoreError::InvalidAccount
                );

                let (is_valid_delegate, approved_amount) = {
                    let data = source_token_account.try_borrow_data()?;
                    let token_acc = TokenAccount::try_deserialize(&mut &data[..])
                        .map_err(|_| zynk_core::CoreError::InvalidAccount)?;

                    let has_delegate = token_acc.delegate.contains(&expected_authority);
                    (has_delegate, token_acc.delegated_amount)
                };

                require!(is_valid_delegate, zynk_core::CoreError::InvalidAccount);
                require!(approved_amount >= pos.amount, OrbitError::InsufficientBalance);

                let seeds_with_bump: &[&[u8]] = &[VAULT_SEED, pos.vault_id.as_ref(), &[bump]];
                let signer_seeds = &[&seeds_with_bump[..]];
                transfer_with_signer_seeds(
                    &ctx.accounts.token_program,
                    source_token_account,
                    &ctx.accounts.zov_token_account.to_account_info(),
                    &ctx.accounts.mint,
                    authority_account,
                    signer_seeds,
                    pos.amount,
                )?;
            }
            UserType::ICV => {
                let seeds: &[&[u8]] = &[USER_SEED, user_id.as_ref()];
                let (expected_authority, bump) = Pubkey::find_program_address(seeds, ctx.program_id);
                require!(
                    authority_account.key() == expected_authority,
                    zynk_core::CoreError::InvalidAccount
                );

                let seeds_with_bump: &[&[u8]] = &[USER_SEED, user_id.as_ref(), &[bump]];
                let signer_seeds = &[&seeds_with_bump[..]];
                transfer_with_signer_seeds(
                    &ctx.accounts.token_program,
                    source_token_account,
                    &ctx.accounts.zov_token_account.to_account_info(),
                    &ctx.accounts.mint,
                    authority_account,
                    signer_seeds,
                    pos.amount,
                )?;
            }
            UserType::LP => {
                return Err(zynk_core::CoreError::Unauthorized.into());
            }
        };

        let position_seeds: &[&[u8]] = &[POSITION_SEED, order_id.as_ref(), user_id.as_ref()];
        let (expected_position_key, position_bump) = Pubkey::find_program_address(position_seeds, ctx.program_id);
        require!(
            position_pda.key() == expected_position_key,
            zynk_core::CoreError::InvalidAccount
        );

        let position_seeds_with_bump: &[&[u8]] = &[
            POSITION_SEED,
            order_id.as_ref(),
            user_id.as_ref(),
            &[position_bump],
        ];
        let position_signer_seeds = &[&position_seeds_with_bump[..]];

        let position_space = 8 + Position::INIT_SPACE;
        let create_position_ix =
            anchor_lang::solana_program::system_instruction::create_account(
                &ctx.accounts.manager.key(),
                &expected_position_key,
                Rent::get()?.minimum_balance(position_space),
                position_space as u64,
                ctx.program_id,
            );

        anchor_lang::solana_program::program::invoke_signed(
            &create_position_ix,
            &[
                ctx.accounts.manager.to_account_info(),
                position_pda.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            position_signer_seeds,
        )?;

        let mut position_data = position_pda.try_borrow_mut_data()?;
        position_data[..8].copy_from_slice(&Position::DISCRIMINATOR);
        let position_account = Position {
            order_id,
            partner_id: partner_id_bytes,
            amount_borrowed: pos.amount,
            amount_repaid: 0,
            user_id,
        };
        position_account.try_serialize(&mut &mut position_data[..])?;
        drop(position_data);

        if user_type == UserType::NCW {
            let mut user_data = user_account.try_borrow_mut_data()?;
            let mut user = User::try_deserialize_unchecked(&mut &user_data[..])?;
            user.principal_in = user
                .principal_in
                .checked_add(pos.amount)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            user.try_serialize(&mut &mut user_data[..])?;
        }

        emit!(TxEvent {
            event_name: "Borrow".to_string(),
            user_id,
            from_owner: source_token_account.owner.key(),
            to_owner: ctx.accounts.zov_token_account.owner.key(),
            from: source_token_account.key(),
            to: ctx.accounts.zov_token_account.key(),
            amount,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id,
        });
    }

    let cpi_program = ctx.accounts.zynk_core_program.to_account_info();
    let cpi_accounts = CreateOrder {
        config: ctx.accounts.config.to_account_info(),
        manager: ctx.accounts.manager.to_account_info(),
        partner_deposit_vault: ctx.accounts.partner_deposit_vault.to_account_info(),
        pdv_token_account: None,
        zynk_op_vault: ctx.accounts.zynk_op_vault.to_account_info(),
        zov_token_account: ctx.accounts.zov_token_account.to_account_info(),
        beneficiary: ctx.accounts.beneficiary.to_account_info(),
        beneficiary_token_account: ctx
            .accounts
            .beneficiary_token_account
            .to_account_info(),
        order_tracker: ctx.accounts.order_tracker.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    };

    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    zynk_core::cpi::create_order(
        cpi_ctx,
        partner_id_bytes,
        order_id,
        zov_id,
        false, // transient = false
        amount,
        meta,
    )?;

    Ok(())
}

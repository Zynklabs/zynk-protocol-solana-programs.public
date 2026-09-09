use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_error::ProgramError;
use zynk_core;

use crate::*;
use crate::utils::*;

pub(crate) fn cctp<'info>(
    ctx: Context<'_, '_, '_, 'info, Cctp<'info>>,
    id: [u8; 32],
    amount: u64,
    destination_domain: u32,
    mint_recipient: [u8; 32],
    destination_caller: Option<[u8; 32]>,
    partner_id: Option<[u8; 32]>,
    order_id: Option<[u8; 32]>,
    zov_id: Option<[u8; 32]>,
) -> Result<()> {
    require!(amount > 0, OrbitError::ZeroAmount);

    let config = &ctx.accounts.config;
    require!(
        config.whitelisted_token_mints.contains(&ctx.accounts.mint.key()),
        zynk_core::CoreError::InvalidTokenMint
    );

    let event_user_id: [u8; 32];
    let (seed_a, seed_b, bump_val): (&[u8], &[u8], u8) = match &mut ctx.accounts.user {
        Some(user) => {
            require!(
                user.user_type == UserType::ICV,
                OrbitError::InvalidOperation
            );

            require!(
                ctx.accounts.authority.key() == user.key(),
                zynk_core::CoreError::InvalidAccount
            );

            require!(
                Clock::get()?.unix_timestamp >= user.cliff_period,
                OrbitError::CliffPeriodNotOver
            );

            let recipient = CctpRecipient {
                destination_domain,
                mint_recipient,
            };
            let destination_caller_is_whitelisted = destination_caller
                .map(|caller| CCTP_WHITELISTED_DESTINATION_CALLERS.contains(&caller))
                .unwrap_or(false);
            require!(
                user.cctp_recipients.contains(&recipient)
                    || destination_caller_is_whitelisted,
                OrbitError::CctpRecipientNotWhitelisted
            );

            user.principal_out = user
                .principal_out
                .checked_add(amount)
                .ok_or(ProgramError::ArithmeticOverflow)?;

            let p_id = partner_id.ok_or(OrbitError::InvalidOperation)?;
            let o_id = order_id.ok_or(OrbitError::InvalidOperation)?;
            let z_id = zov_id.ok_or(OrbitError::InvalidOperation)?;

            let order_tracker = ctx
                .accounts
                .order_tracker
                .as_ref()
                .ok_or(zynk_core::CoreError::InvalidAccount)?;
            let partner_deposit_vault = ctx
                .accounts
                .partner_deposit_vault
                .as_ref()
                .ok_or(zynk_core::CoreError::InvalidAccount)?;
            let zynk_op_vault = ctx
                .accounts
                .zynk_op_vault
                .as_ref()
                .ok_or(zynk_core::CoreError::InvalidAccount)?;

            let cpi_program = ctx.accounts.zynk_core_program.to_account_info();
            let cpi_accounts = zynk_core::cpi::accounts::CreateOrder {
                config: ctx.accounts.config.to_account_info(),
                manager: ctx.accounts.manager.to_account_info(),
                partner_deposit_vault: partner_deposit_vault.to_account_info(),
                pdv_token_account: None,
                zynk_op_vault: zynk_op_vault.to_account_info(),
                zov_token_account: None,
                beneficiary: None,
                beneficiary_token_account: None,
                order_tracker: order_tracker.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            };

            let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
            let meta = Some(vec![zynk_core::EventArg {
                key: "txAmount".to_string(),
                value: amount.to_string(),
            }]);

            zynk_core::cpi::create_order(
                cpi_ctx,
                p_id,
                o_id,
                z_id,
                false,
                0,
                meta,
            )?;

            event_user_id = id;
            let bump = ctx.bumps.user.ok_or(zynk_core::CoreError::InvalidAccount)?;
            (USER_SEED, id.as_ref(), bump)
        }
        None => {
            let (expected_ovault, ovault_bump) = Pubkey::find_program_address(
                &[VAULT_SEED, b"orbit"],
                ctx.program_id,
            );
            let (expected_spender, spender_bump) = Pubkey::find_program_address(
                &[VAULT_SEED, id.as_ref()],
                ctx.program_id,
            );

            if ctx.accounts.authority.key() == expected_ovault {
                event_user_id = [0u8; 32];
                (VAULT_SEED, b"orbit", ovault_bump)
            } else if ctx.accounts.authority.key() == expected_spender {
                event_user_id = id;
                (VAULT_SEED, id.as_ref(), spender_bump)
            } else {
                return Err(zynk_core::CoreError::InvalidAccount.into());
            }
        }
    };

    let bump_arr = [bump_val];
    let seeds: &[&[u8]] = &[seed_a, seed_b, &bump_arr];
    let signer_seeds = &[&seeds[..]];

    cpi_cctp_deposit_for_burn(
        &ctx.accounts.cctp_token_messenger_minter_program.to_account_info(),
        ctx.remaining_accounts,
        &ctx.accounts.authority.to_account_info(),
        signer_seeds,
        amount,
        destination_domain,
        mint_recipient,
        destination_caller,
    )?;

    let dest_caller_bytes = destination_caller.unwrap_or([0u8; 32]);
    emit!(CctpEvent {
        event_name: "Cctp".to_string(),
        vault: ctx.accounts.authority.key(),
        user_id: event_user_id,
        amount,
        token: ctx.accounts.mint.key(),
        destination_domain,
        mint_recipient,
        destination_caller: dest_caller_bytes,
        domain_separator: DOMAIN_SEPARATOR,
    });

    Ok(())
}

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
    max_fee: u64,
    min_finality_threshold: u32,
    destination_caller: Option<[u8; 32]>,
    hook_data: Option<Vec<u8>>,
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

    let recipient = CctpRecipient {
        destination_domain,
        mint_recipient,
    };

    let event_user_id: [u8; 32];
    let (seed_a, seed_b, bump_val, authority_account): (&[u8], &[u8], u8, AccountInfo<'info>) =  match (&mut ctx.accounts.user, &mut ctx.accounts.ovault) {
        (Some(user), _) => {
            require!(
                user.user_type == UserType::ICV,
                OrbitError::InvalidOperation
            );

            require!(
                user.allowed_mint == ctx.accounts.mint.key(),
                zynk_core::CoreError::InvalidTokenMint
            );

            require!(
                user.cctp_recipients.contains(&recipient),
                OrbitError::CctpRecipientNotWhitelisted
            );

            require!(
                ctx.accounts.source_token_account.owner.key() == user.key(),
                zynk_core::CoreError::InvalidAccount
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
                orbit_authority: None,
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
                0,
                meta,
            )?;

            event_user_id = id;
            let bump = ctx.bumps.user.ok_or(zynk_core::CoreError::InvalidAccount)?;
            (USER_SEED, id.as_ref(), bump, user.to_account_info())
        }
        (_, Some(ovault)) => {
            require!(
                ctx.accounts.source_token_account.owner.key() == ovault.key(),
                zynk_core::CoreError::InvalidAccount
            );

            require!(
                ovault.cctp_recipients.contains(&recipient),
                OrbitError::CctpRecipientNotWhitelisted
            );

            event_user_id = [0u8; 32];
            let bump = ctx.bumps.ovault.ok_or(zynk_core::CoreError::InvalidAccount)?;
            (VAULT_SEED, b"orbit", bump, ovault.to_account_info())
        }
        (None, None) => {
            return Err(OrbitError::InvalidOperation.into());
        }
    };

    let bump_arr = [bump_val];
    let seeds: &[&[u8]] = &[seed_a, seed_b, &bump_arr];
    let signer_seeds = &[&seeds[..]];

    let dest_caller_bytes = destination_caller.unwrap_or([0u8; 32]);
    cpi_cctp_deposit_for_burn(
        &ctx.accounts.cctp_token_messenger_minter_program.to_account_info(),
        ctx.remaining_accounts,
        &authority_account,
        signer_seeds,
        amount,
        destination_domain,
        mint_recipient,
        dest_caller_bytes,
        max_fee,
        min_finality_threshold,
        hook_data
    )?;

    emit!(CctpEvent {
        event_name: "Cctp".to_string(),
        vault: authority_account.key(),
        user_id: event_user_id,
        amount,
        token: ctx.accounts.mint.key(),
        destination_domain,
        mint_recipient,
        destination_caller: dest_caller_bytes,
        domain_separator: DOMAIN_SEPARATOR,
        signer: ctx.accounts.manager.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

pub(crate) fn add_ovault_cctp_recipient(
    ctx: Context<AddOvaultCctpRecipient>,
    recipient: CctpRecipient,
) -> Result<()> {
    let ovault = &mut ctx.accounts.ovault;

    require!(
        !ovault.cctp_recipients.contains(&recipient),
        OrbitError::CctpRecipientAlreadyWhitelisted
    );

    ovault.cctp_recipients.push(recipient);

    emit!(AxEvent {
        event_name: "OvaultCctpRecipientAdded".to_string(),
        user_id: ovault.user_id,
        public_key: ctx.accounts.admin.key(),
        domain_separator: DOMAIN_SEPARATOR,
        partners: Vec::new(),
        signer: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
        value: recipient.destination_domain as i64,
    });

    Ok(())
}

pub(crate) fn remove_ovault_cctp_recipient(
    ctx: Context<RemoveOvaultCctpRecipient>,
    recipient: CctpRecipient,
) -> Result<()> {
    let ovault = &mut ctx.accounts.ovault;

    let position = ovault
        .cctp_recipients
        .iter()
        .position(|entry| entry == &recipient)
        .ok_or(OrbitError::CctpRecipientNotWhitelisted)?;
    ovault.cctp_recipients.swap_remove(position);

    emit!(AxEvent {
        event_name: "OvaultCctpRecipientRemoved".to_string(),
        user_id: ovault.user_id,
        public_key: ctx.accounts.admin.key(),
        domain_separator: DOMAIN_SEPARATOR,
        partners: Vec::new(),
        signer: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
        value: recipient.destination_domain as i64,
    });

    Ok(())
}

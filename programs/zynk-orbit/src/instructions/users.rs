use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_error::ProgramError;
use zynk_core;

use crate::*;

pub(crate) fn register_user(
    ctx: Context<RegisterUser>,
    user_id: [u8; 32],
    user_type: UserType,
    allowed_mint: Pubkey,
    wallets: [Pubkey; 3],
    cliff_period: Option<i64>,
    max_principal: Option<u64>,
    whitelisted_partners: Vec<u32>,
    cctp_recipients: Vec<CctpRecipient>,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(
        ctx.accounts.admin.key() == config.admin,
        zynk_core::CoreError::Unauthorized
    );

    let user = &mut ctx.accounts.user;

    if let Some(cp) = cliff_period {
        let now = Clock::get()?.unix_timestamp;
        require!(cp > now, OrbitError::CliffPeriodInPast);
    }

    user.wallets = wallets;
    user.user_id = user_id;
    user.user_type = user_type;
    user.allowed_mint = allowed_mint;
    user.cliff_period = cliff_period.unwrap_or(i64::MAX);
    user.principal_in = 0;
    user.principal_out = 0;
    require!(
        whitelisted_partners.iter().enumerate().all(|(index, partner)|
            !whitelisted_partners[..index].contains(partner)
        ),
        OrbitError::PartnerAlreadyWhitelisted
    );
    require!(
        cctp_recipients.iter().enumerate().all(|(index, recipient)|
            !cctp_recipients[..index].contains(recipient)
        ),
        OrbitError::CctpRecipientAlreadyWhitelisted
    );

    user.max_principal = max_principal.unwrap_or(u64::MAX);
    user.whitelisted_partners = whitelisted_partners;
    user.cctp_recipients = cctp_recipients;

    emit!(AxEvent {
        event_name: "Whitelist".to_string(),
        user_id,
        public_key: wallets[0],
        domain_separator: DOMAIN_SEPARATOR,
        partners: user.whitelisted_partners.clone(),
        signer: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
        // Emit the cliff period that was set; i64::MAX means "no cliff".
        value: user.cliff_period,
    });

    Ok(())
}

pub(crate) fn update_wallets(
    ctx: Context<UpdateWallets>,
    user_id: [u8; 32],
    wallets: [Pubkey; 3],
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(
        ctx.accounts.admin.key() == config.admin,
        zynk_core::CoreError::Unauthorized
    );

    let user = &mut ctx.accounts.user;
    user.wallets = wallets;

    emit!(AxEvent {
        event_name: "WalletsUpdated".to_string(),
        user_id,
        public_key: wallets[0],
        domain_separator: DOMAIN_SEPARATOR,
        partners: Vec::new(),
        signer: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
        value: 0,
    });

    Ok(())
}

pub(crate) fn update_partner_whitelist(
    ctx: Context<UpdatePartnerWhitelist>,
    user_id: [u8; 32],
    action: WhitelistAction,
    partner_id: u32,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(
        ctx.accounts.admin.key() == config.admin,
        zynk_core::CoreError::Unauthorized
    );

    let user = &mut ctx.accounts.user;

    match action {
        WhitelistAction::Add => {
            require!(
                !user.whitelisted_partners.contains(&partner_id),
                OrbitError::PartnerAlreadyWhitelisted
            );
            user.whitelisted_partners.push(partner_id);
        }
        WhitelistAction::Remove => {
            let pos = user
                .whitelisted_partners
                .iter()
                .position(|&id| id == partner_id)
                .ok_or(OrbitError::PartnerNotWhitelisted)?;
            user.whitelisted_partners.swap_remove(pos);
        }
    }

    emit!(AxEvent {
        event_name: "UpdatePartnerWhitelist".to_string(),
        user_id,
        public_key: user.wallets[0],
        domain_separator: DOMAIN_SEPARATOR,
        partners: user.whitelisted_partners.clone(),
        signer: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
        value: partner_id as i64,
    });

    Ok(())
}

pub(crate) fn update_cctp_recipient(
    ctx: Context<UpdateCctpRecipient>,
    user_id: [u8; 32],
    action: WhitelistAction,
    recipient: CctpRecipient,
) -> Result<()> {
    let user = &mut ctx.accounts.user;

    match action {
        WhitelistAction::Add => {
            require!(
                !user.cctp_recipients.contains(&recipient),
                OrbitError::CctpRecipientAlreadyWhitelisted
            );
            user.cctp_recipients.push(recipient);
        }
        WhitelistAction::Remove => {
            let position = user
                .cctp_recipients
                .iter()
                .position(|entry| entry == &recipient)
                .ok_or(OrbitError::CctpRecipientNotWhitelisted)?;
            user.cctp_recipients.swap_remove(position);
        }
    }

    emit!(AxEvent {
        event_name: "CctpRecipientUpdated".to_string(),
        user_id,
        public_key: ctx.accounts.admin.key(),
        domain_separator: DOMAIN_SEPARATOR,
        partners: Vec::new(),
        signer: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
        // destination_domain identifies which chain's recipient changed.
        value: recipient.destination_domain as i64,
    });

    Ok(())
}


pub(crate) fn update_max_principal(
    ctx: Context<UpdateMaxPrincipal>,
    user_id: [u8; 32],
    max_principal: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(
        ctx.accounts.admin.key() == config.admin,
        zynk_core::CoreError::Unauthorized
    );

    let user = &mut ctx.accounts.user;

    let net_balance = user
        .principal_in
        .checked_sub(user.principal_out)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    require!(
        max_principal as u64 >= net_balance,
        OrbitError::MaxPrincipalBelowBalance
    );

    user.max_principal = max_principal;

    emit!(AxEvent {
        event_name: "MaxDepositUpdated".to_string(),
        user_id,
        public_key: user.wallets[0],
        domain_separator: DOMAIN_SEPARATOR,
        partners: Vec::new(),
        signer: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
        value: max_principal as i64,
    });
    Ok(())
}

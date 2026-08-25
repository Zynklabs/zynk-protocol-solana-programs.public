use anchor_lang::prelude::*;

use crate::*;

pub(crate) fn whitelist_beneficiary(ctx: Context<WhitelistBeneficiary>, partner_id: [u8; 32], public_key: Pubkey, allow_transient: bool) -> Result<()> {
    let beneficiary = &mut ctx.accounts.beneficiary;

    let is_active = true;
    beneficiary.public_key = public_key;
    beneficiary.partner_id = partner_id;
    beneficiary.is_active = is_active;
    beneficiary.allow_transient = allow_transient;

    emit!(BeneficiaryAction {
        action: String::from("whitelist"),
        partner_id,
        public_key,
        is_active,
        domain_separator: DOMAIN_SEPARATOR
    });

    Ok(())
}

pub(crate) fn toggle_beneficiary(ctx: Context<ToggleBeneficiary>) -> Result<()> {
    let beneficiary = &mut ctx.accounts.beneficiary;

    let is_active = !beneficiary.is_active;
    beneficiary.is_active = is_active;

    emit!(BeneficiaryAction {
        action: String::from("toggle"),
        partner_id: beneficiary.partner_id,
        public_key: beneficiary.public_key,
        is_active,
        domain_separator: DOMAIN_SEPARATOR
    });

    Ok(())
}

pub(crate) fn revoke_beneficiary(ctx: Context<RevokeBeneficiary>) -> Result<()> {
    let beneficiary = &ctx.accounts.beneficiary;

    emit!(BeneficiaryAction {
        action: String::from("revoke"),
        partner_id: beneficiary.partner_id,
        public_key: beneficiary.public_key,
        is_active: false,
        domain_separator: DOMAIN_SEPARATOR
    });

    Ok(())
}

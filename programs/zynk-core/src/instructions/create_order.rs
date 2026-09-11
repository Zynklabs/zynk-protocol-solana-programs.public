use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TransferChecked};

use crate::*;

pub(crate) fn create_order(
    ctx: Context<CreateOrder>,
    partner_id: [u8; 32],
    order_id: [u8; 32],
    zov_id: [u8; 32],
    transient: bool,
    amount: u64,
    borrowed_amount: u64,
    meta: Option<Vec<EventArg>>,
) -> Result<()> {
    // Check if program is paused.
    let config = &ctx.accounts.config;
    require!(!config.paused, CoreError::ContractPaused);
    let partner_deposit_vault = ctx.accounts.partner_deposit_vault.key();
    let zynk_op_vault = ctx.accounts.zynk_op_vault.key();

    let (beneficiary_wallet, allow_transient) = match (
        &ctx.accounts.beneficiary,
        &ctx.accounts.beneficiary_token_account,
    ) {
        (Some(beneficiary), Some(bta)) => {
            let (expected_beneficiary, _bump) = Pubkey::find_program_address(
                &[BENEFICIARY_SEED, partner_id.as_ref(), bta.owner.as_ref()],
                &crate::ID,
            );
            require!(
                beneficiary.key() == expected_beneficiary,
                CoreError::InvalidBeneficiary
            );
            require!(beneficiary.is_active, CoreError::InvalidBeneficiary);
            require!(
                beneficiary.public_key == bta.owner,
                CoreError::InvalidBeneficiary
            );
            if let Some(ref zov_ta) = ctx.accounts.zov_token_account {
                require!(bta.mint == zov_ta.mint, CoreError::InvalidAccount);
            } else {
                require!(
                    bta.mint == ctx.accounts.mint.key(),
                    CoreError::InvalidAccount
                );
            }
            require!(bta.owner != zynk_op_vault, CoreError::InvalidAccount);
            (bta.owner.key(), beneficiary.allow_transient)
        }
        (None, None) => {
            require!(amount == 0, CoreError::InvalidBeneficiary);
            (Pubkey::default(), true)
        }
        _ => return err!(CoreError::InvalidBeneficiary),
    };

    require!(allow_transient || !transient, CoreError::InvalidBeneficiary);

    let mut effective_amount = amount;
    if amount != 0 {
        let zov_token_account = ctx
            .accounts
            .zov_token_account
            .as_ref()
            .ok_or(CoreError::InvalidAccount)?;
        let bta = ctx
            .accounts
            .beneficiary_token_account
            .as_ref()
            .ok_or(CoreError::InvalidAccount)?;
        require!(
            zov_token_account.owner == zynk_op_vault,
            CoreError::InvalidAccount
        );
        require!(
            zov_token_account.mint == ctx.accounts.mint.key(),
            CoreError::InvalidTokenMint
        );

        // Perform token transfer from zov_token_account to beneficiary_token_account.
        let cpi_accounts = TransferChecked {
            from: zov_token_account.to_account_info(),
            to: bta.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.zynk_op_vault.to_account_info(),
        };

        let seeds = &[
            ZYNK_OP_VAULT_SEED,
            zov_id.as_ref(),
            &[ctx.bumps.zynk_op_vault],
        ];
        let signer_seeds = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;
    } else {
        if let Some(ref zov_token_account) = ctx.accounts.zov_token_account {
            require!(
                zov_token_account.owner == zynk_op_vault,
                CoreError::InvalidAccount
            );
            require!(
                zov_token_account.mint == ctx.accounts.mint.key(),
                CoreError::InvalidTokenMint
            );
        }
        if let Some(ref meta_args) = meta {
            effective_amount = match meta_args
                .iter()
                .find(|arg| arg.key == "txAmount")
                .map(|arg| u64::from_str_radix(&arg.value, 10))
            {
                Some(Ok(v)) => v,
                _ => return err!(CoreError::InvalidOrder),
            };
        }
    }

    // Determine position_borrowed based on whether the call is from Orbit.
    // Only when the Orbit authority PDA is present (and validated by Anchor)
    // do we honour the supplied borrowed_amount.
    let is_orbit_call = ctx.accounts.orbit_authority.is_some();
    let effective_borrowed = if is_orbit_call {
        require!(borrowed_amount <= effective_amount, CoreError::InvalidOrder);
        borrowed_amount
    } else {
        // Non-Orbit callers must not set a position borrowed amount.
        require!(borrowed_amount == 0, CoreError::InvalidOrder);
        0
    };

    let order_tracker = &mut ctx.accounts.order_tracker;
    if transient {
        close_account(order_tracker, &ctx.accounts.manager)?;
    } else {
        order_tracker.partner_id = partner_id;
        order_tracker.order_id = order_id;
        order_tracker.amount_out = effective_amount;
        order_tracker.zynk_op_vault = zynk_op_vault;
        order_tracker.beneficiary_wallet = beneficiary_wallet;
        order_tracker.partner_deposit_vault = partner_deposit_vault;
        order_tracker.mint = ctx.accounts.mint.key();
        order_tracker.amount_borrowed = effective_borrowed;
        order_tracker.amount_repaid = 0;
    }

    emit!(OrderCreated {
        order_id,
        zynk_op_vault: zynk_op_vault.to_string(),
        beneficiary_wallet: beneficiary_wallet.to_string(),
        token: ctx.accounts.mint.key().to_string(),
        partner_deposit_vault: partner_deposit_vault.to_string(),
        amount,
        transient,
        domain_separator: DOMAIN_SEPARATOR,
        meta
    });

    Ok(())
}

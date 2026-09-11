use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_error::ProgramError;

use crate::*;

pub(crate) fn record_order(
    ctx: Context<RecordOrder>,
    partner_id: [u8; 32],
    order_id: [u8; 32],
    token: String,
    zynk_op_vault: String,
    partner_deposit_vault: String,
    beneficiary_wallet: String,
    amount: u64,
    domain_separator: Option<u64>,
    meta: Option<Vec<EventArg>>,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, CoreError::ContractPaused);
    require!(amount > 0, CoreError::InvalidOrder);

    let order_tracker = &mut ctx.accounts.order_tracker;

    if order_tracker.order_id != [0u8; 32] {
        require!(order_tracker.partner_id == partner_id, CoreError::InvalidOrder);
        require!(order_tracker.order_id == order_id, CoreError::InvalidOrder);

        order_tracker.amount_in = order_tracker.amount_in
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        let order_closed = order_tracker.amount_in >= order_tracker.amount_out;
        if order_closed {
            close_account(order_tracker, &ctx.accounts.manager)?;
        }

        emit!(OrderReplenished {
            order_id,
            token,
            zynk_op_vault,
            partner_deposit_vault,
            amount,
            order_closed,
            domain_separator: domain_separator.unwrap_or(DOMAIN_SEPARATOR),
            meta
        });


    } else {
        order_tracker.partner_id = partner_id;
        order_tracker.order_id = order_id;
        order_tracker.amount_out = amount;
        order_tracker.amount_borrowed = 0;
        order_tracker.amount_repaid = 0;

        emit!(OrderCreated {
            order_id,
            token,
            zynk_op_vault,
            beneficiary_wallet,
            partner_deposit_vault,
            amount,
            transient: false,
            domain_separator: domain_separator.unwrap_or(DOMAIN_SEPARATOR),
            meta
        });
    }

    Ok(())
}

use anchor_lang::prelude::*;

use crate::*;

pub(crate) fn close_orders(ctx: Context<CloseOrders>, meta: Option<Vec<EventArg>>) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, CoreError::ContractPaused);

    let mut seen_accounts = Vec::<Pubkey>::new();
    let mut order_ids = Vec::<[u8; 32]>::new();
    for account_info in ctx.remaining_accounts.iter() {
        require!(account_info.owner == ctx.program_id, CoreError::InvalidOrder);

        let account_key = account_info.key();
        if seen_accounts.contains(&account_key) { continue; }
        seen_accounts.push(account_key);

        let order_tracker = OrderTracker::try_deserialize(&mut &account_info.data.borrow()[..])?;
        order_ids.push(order_tracker.order_id);

        close_account(account_info, &ctx.accounts.authority)?;
    }

    emit!(OrdersClosed {
        order_ids,
        domain_separator: DOMAIN_SEPARATOR,
        meta
    });

    Ok(())
}

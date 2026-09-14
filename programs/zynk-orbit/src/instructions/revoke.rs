use anchor_lang::prelude::*;
use zynk_core;

use crate::*;
use crate::utils::*;

pub(crate) fn revoke(ctx: Context<Revoke>) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(
        ctx.accounts.admin.key() == config.admin,
        zynk_core::CoreError::Unauthorized
    );

    let revoke_signer = ctx.accounts.admin.key();
    let revoke_timestamp = Clock::get()?.unix_timestamp;

    macro_rules! try_revoke {
        ($data:expr, $pda_key:expr, $ty:ty, $event:expr) => {
            if let Ok(account) = <$ty>::try_deserialize(&mut &$data[..]) {
                emit!(AxEvent {
                    event_name: $event.to_string(),
                    user_id: account.user_id,
                    public_key: $pda_key,
                    domain_separator: DOMAIN_SEPARATOR,
                    partners: Vec::new(),
                    signer: revoke_signer,
                    timestamp: revoke_timestamp,
                    value: 0,
                });
                true
            } else {
                false
            }
        };
    }

    for account_info in ctx.remaining_accounts.iter() {
        require!(
            account_info.owner == ctx.program_id,
            OrbitError::PdaNotOwnedByContract
        );

        // Deserialize and emit inside its own block so the immutable borrow
        // of `account_info.data` (a RefCell) is dropped before close_account()
        // needs a mutable borrow of the same account (assign + realloc).
        {
            let data = account_info.data.borrow();
            let pda_key = account_info.key();

            if data.len() >= 8 {
                let _ = try_revoke!(data, pda_key, User, "RevokeWhitelist")
                    || try_revoke!(data, pda_key, WithdrawRequest, "RevokeWithdrawRequest")
                    || try_revoke!(
                        data,
                        pda_key,
                        UpdateCliffPeriodRequest,
                        "DenyUpdateRequest"
                    );
            }
        }

        close_account(account_info, &ctx.accounts.admin)?;
    }

    Ok(())
}

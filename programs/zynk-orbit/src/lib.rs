use anchor_lang::prelude::*;
use anchor_lang::solana_program::{pubkey::Pubkey, system_program::ID as SYSTEM_PROGRAM_ID};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("ZYNKopsYjG6gaGqdwz8HLAgvCAEFwCET56kRQKkjxfc");

pub const DOMAIN_SEPARATOR: u64 = 115131153410997;

pub const ZOV: Pubkey = pubkey!("2FUNdgyGtGQAffBJ1UYPZrhgu4FSUStsohEzkPbUctnu");
pub const ADMIN: Pubkey = pubkey!("Dyrq5TihL4q6XtekdkfnrZjBzSk5qJFWDAphKJYW86ru");
pub const MANAGER: Pubkey = pubkey!("CMyxj35ckba59ELYaRsi7bxNghrnTkkwxR2nAoGM2yfQ");

pub const ALLOWED_MINTS: [Pubkey; 2] = [
    pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // USDC
    pubkey!("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"), // USDT
];

pub const VAULT_SEED: &[u8] = b"vault";
pub const ORDER_SEED: &[u8] = b"order";
pub const RECORD_SEED: &[u8] = b"record";
pub const WITHDRAW_REQUEST_SEED: &[u8] = b"withdraw_request";
pub const RECORD_UPDATE_REQUEST_SEED: &[u8] = b"record_update_request";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
#[repr(u8)]
pub enum UserType {
    LP = 0,
    NCW = 1,
    ICV = 2,
}

#[account]
#[derive(InitSpace)]
pub struct Record {
    pub interaction_wallet: Pubkey,
    pub user_id: [u8; 32],
    pub user_type: UserType,
    pub cliff_period: i64,
    pub principle_in: u64,
    pub principle_out: u64,
    pub max_deposit: u32,
    pub claim_wallet: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct WithdrawRequest {
    pub interaction_wallet: Pubkey,
    pub user_id: [u8; 32],
    pub amount: u32,
    pub destination: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct UpdateCliffPeriodRequest {
    pub interaction_wallet: Pubkey,
    pub user_id: [u8; 32],
    pub cliff_period: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Order {
    pub order_id: [u8; 32],
    pub amount: u64,
    pub public_key: Pubkey,
}

#[event]
pub struct TxEvent {
    pub event_name: String,
    pub user_id: [u8; 32],
    pub from_owner: Pubkey,
    pub to_owner: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
    pub token: Pubkey,
    pub domain_separator: u64,
    pub order_id: Option<[u8; 32]>,
}

#[event]
pub struct AxEvent {
    pub event_name: String,
    pub user_id: [u8; 32],
    pub public_key: Pubkey,
    pub domain_separator: u64,
}

pub fn close_account<'a, 'b>(
    from: impl ToAccountInfo<'a>,
    to: impl ToAccountInfo<'b>,
) -> Result<()> {
    let from = from.to_account_info();
    let to = to.to_account_info();

    let to_lamports = to.lamports();
    **to.lamports.borrow_mut() = to_lamports.checked_add(from.lamports()).unwrap();
    **from.lamports.borrow_mut() = 0;

    from.assign(&SYSTEM_PROGRAM_ID);
    from.realloc(0, false).map_err(Into::into)
}

#[program]
pub mod zynk_orbit {
    use super::*;

    // External (whitelisted) signers -> ZOV
    pub fn deposit(ctx: Context<Deposit>, user_id: [u8; 32], amount: u64) -> Result<()> {
        require!(amount != 0, OrbitError::ZeroAmount);

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.source_token_account.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.signer.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        let record = &mut ctx.accounts.record;
        record.principle_in = record
            .principle_in
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        emit!(TxEvent {
            event_name: String::from("deposit"),
            user_id,
            from_owner: ctx.accounts.source_token_account.owner.key(),
            to_owner: ctx.accounts.destination_token_account.owner.key(),
            from: ctx.accounts.source_token_account.key(),
            to: ctx.accounts.destination_token_account.key(),
            amount,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id: None,
        });

        Ok(())
    }

    // External signers + delegated vault -> ZOV
    // Any vault -> ZOV
    pub fn collect(
        ctx: Context<Collect>,
        vault_id: [u8; 32],
        order_id: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        let seeds: &[&[u8]] = &[VAULT_SEED, vault_id.as_ref(), &[ctx.bumps.spender]];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.source_token_account.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.spender.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        let order = &mut ctx.accounts.order;
        order.order_id = order_id;
        order.amount = order
            .amount
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        order.public_key = ctx.accounts.source_token_account.owner;

        emit!(TxEvent {
            event_name: String::from("collect"),
            user_id: ctx.accounts.record.user_id,
            from_owner: ctx.accounts.source_token_account.owner.key(),
            to_owner: ctx.accounts.destination_token_account.owner.key(),
            from: ctx.accounts.source_token_account.key(),
            to: ctx.accounts.destination_token_account.key(),
            amount,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id: Some(order_id),
        });

        Ok(())
    }

    // Ovault -> Whitelisted beneficiary / Order source
    pub fn disburse(ctx: Context<Disburse>, amount: u64) -> Result<()> {
        let record = &mut ctx.accounts.record;

        if let Some(order) = ctx.accounts.order.as_ref() {
            require!(
                order.public_key == record.interaction_wallet,
                OrbitError::InvalidAccount
            );
            require!(order.amount == amount, OrbitError::Inequality);
            close_account(order, &ctx.accounts.manager)?;
        }

        let seeds: &[&[u8]] = &[VAULT_SEED, b"orbit", &[ctx.bumps.ovault]];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.source_token_account.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.ovault.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        emit!(TxEvent {
            event_name: String::from("disburse"),
            user_id: record.user_id,
            from_owner: ctx.accounts.source_token_account.owner.key(),
            to_owner: ctx.accounts.destination_token_account.owner.key(),
            from: ctx.accounts.source_token_account.key(),
            to: ctx.accounts.destination_token_account.key(),
            amount,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id: ctx.accounts.order.as_ref().map(|o| o.order_id),
        });

        Ok(())
    }

    pub fn whitelist(
        ctx: Context<Whitelist>,
        user_id: [u8; 32],
        user_type: UserType,
        interaction_wallet: Pubkey,
        cliff_period: Option<i64>,
        max_deposit: Option<u32>,
        claim_wallet: Option<Pubkey>,
    ) -> Result<()> {
        let record = &mut ctx.accounts.record;

        // Validate cliff_period is in the future if provided
        if let Some(cp) = cliff_period {
            let now = Clock::get()?.unix_timestamp;
            require!(cp > now, OrbitError::CliffPeriodInPast);
        }

        record.interaction_wallet = interaction_wallet;
        record.user_id = user_id;
        record.user_type = user_type;
        record.cliff_period = cliff_period.unwrap_or(i64::MAX);
        record.principle_in = 0;
        record.principle_out = 0;
        record.max_deposit = max_deposit.unwrap_or(u32::MAX);
        record.claim_wallet = claim_wallet.unwrap_or(interaction_wallet);

        emit!(AxEvent {
            event_name: String::from("whitelist"),
            user_id,
            public_key: interaction_wallet,
            domain_separator: DOMAIN_SEPARATOR,
        });

        Ok(())
    }

    pub fn revoke(ctx: Context<Revoke>) -> Result<()> {
        macro_rules! try_revoke {
            ($data:expr, $pda_key:expr, $ty:ty, $event:literal) => {
                if let Ok(account) = <$ty>::try_deserialize(&mut &$data[..]) {
                    emit!(AxEvent {
                        event_name: String::from($event),
                        user_id: account.user_id,
                        public_key: $pda_key,
                        domain_separator: DOMAIN_SEPARATOR,
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

            let data = account_info.data.borrow();
            let pda_key = account_info.key();

            if data.len() >= 8 {
                let _ = try_revoke!(data, pda_key, Record, "revoke_whitelist")
                    || try_revoke!(data, pda_key, WithdrawRequest, "revoke_withdraw_request")
                    || try_revoke!(
                        data,
                        pda_key,
                        UpdateCliffPeriodRequest,
                        "deny_update_request"
                    );
            }

            close_account(account_info, &ctx.accounts.admin)?;
        }

        Ok(())
    }

    pub fn update_cliff_period(
        ctx: Context<UpdateCliffPeriod>,
        user_id: [u8; 32],
        interaction_wallet: Pubkey,
        cliff_period: Option<i64>,
    ) -> Result<()> {
        let request_record = &mut ctx.accounts.request_record;
        let user_record = &ctx.accounts.user_record;
        if let Some(cp) = cliff_period {
            let now = Clock::get()?.unix_timestamp;
            require!(cp > now, OrbitError::CliffPeriodInPast);
        }
        request_record.interaction_wallet = interaction_wallet;
        request_record.user_id = user_id;
        request_record.cliff_period = cliff_period.unwrap_or(user_record.cliff_period);

        emit!(AxEvent {
            event_name: String::from("cliff_period_updated"),
            user_id: user_id,
            public_key: interaction_wallet,
            domain_separator: DOMAIN_SEPARATOR,
        });
        Ok(())
    }

    pub fn update_max_deposit(
        ctx: Context<UpdateMaxDeposit>,
        user_id: [u8; 32],
        interaction_wallet: Pubkey,
        max_deposit: u32,
    ) -> Result<()> {
        let record = &mut ctx.accounts.record;
        record.max_deposit = max_deposit;

        emit!(AxEvent {
            event_name: String::from("max_deposit_updated"),
            user_id,
            public_key: interaction_wallet,
            domain_separator: DOMAIN_SEPARATOR,
        });
        Ok(())
    }

    pub fn request_withdraw(
        ctx: Context<RequestWithdraw>,
        user_id: [u8; 32],
        interaction_wallet: Pubkey,
        destination: Pubkey,
        amount: u32,
    ) -> Result<()> {
        require!(amount != 0, OrbitError::ZeroAmount);

        let signer_record = &ctx.accounts.signer_record;
        let destination_record = &ctx.accounts.destination_record;

        // Verify both records belong to the same user_id
        require!(
            signer_record.user_id == user_id && destination_record.user_id == user_id,
            OrbitError::UserIdMismatch
        );

        require!(
            signer_record.principle_in - signer_record.principle_out > amount as u64,
            OrbitError::InsufficientBalance
        );

        require!(
            signer_record.user_type != UserType::ICV,
            OrbitError::InvalidOperation
        );

        let withdraw_request = &mut ctx.accounts.withdraw_request;
        withdraw_request.interaction_wallet = interaction_wallet;
        withdraw_request.user_id = user_id;
        withdraw_request.amount = amount;
        withdraw_request.destination = destination;

        emit!(AxEvent {
            event_name: String::from("withdraw_requested"),
            user_id,
            public_key: interaction_wallet,
            domain_separator: DOMAIN_SEPARATOR,
        });
        Ok(())
    }

    pub fn approve_withdraw(ctx: Context<ApproveWithdraw>) -> Result<()> {
        let request_data = ctx.accounts.request.try_borrow_data()?;
        let withdraw_request = WithdrawRequest::try_deserialize(&mut &request_data[8..])
            .map_err(|_| OrbitError::InvalidRequestAccount)?;

        let record = &mut ctx.accounts.record;

        // Verify the record matches the withdraw request
        require!(
            record.user_id == withdraw_request.user_id
                && record.interaction_wallet == withdraw_request.interaction_wallet,
            OrbitError::InvalidAccount
        );

        // Update principle_out on the record
        record.principle_out = record
            .principle_out
            .checked_add(withdraw_request.amount as u64)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        // Transfer tokens from ovault to destination
        let seeds: &[&[u8]] = &[VAULT_SEED, b"orbit", &[ctx.bumps.ovault]];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.source_token_account.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.ovault.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(
            cpi_ctx,
            withdraw_request.amount as u64,
            ctx.accounts.mint.decimals,
        )?;

        // Close the withdraw request account, move lamports to interaction wallet
        close_account(
            ctx.accounts.request.to_account_info(),
            ctx.accounts.interaction_wallet.to_account_info(),
        )?;

        emit!(TxEvent {
            event_name: String::from("withdraw_approved"),
            user_id: withdraw_request.user_id,
            from_owner: ctx.accounts.source_token_account.owner.key(),
            to_owner: ctx.accounts.destination_token_account.owner.key(),
            from: ctx.accounts.source_token_account.key(),
            to: ctx.accounts.destination_token_account.key(),
            amount: withdraw_request.amount as u64,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id: None,
        });

        Ok(())
    }

    pub fn approve_cliff_period(ctx: Context<ApproveCliffPeriod>) -> Result<()> {
        let request_data = ctx.accounts.request.try_borrow_data()?;
        let update_request = UpdateCliffPeriodRequest::try_deserialize(&mut &request_data[8..])
            .map_err(|_| OrbitError::InvalidRequestAccount)?;

        let record = &mut ctx.accounts.record;

        // Verify the record matches the update request
        require!(
            record.user_id == update_request.user_id
                && record.interaction_wallet == update_request.interaction_wallet,
            OrbitError::InvalidAccount
        );

        // Update the cliff period on the record
        record.cliff_period = update_request.cliff_period;

        // Close the update request account, move lamports to interaction wallet
        close_account(
            ctx.accounts.request.to_account_info(),
            ctx.accounts.interaction_wallet.to_account_info(),
        )?;

        emit!(AxEvent {
            event_name: String::from("cliff_period_approved"),
            user_id: update_request.user_id,
            public_key: update_request.interaction_wallet,
            domain_separator: DOMAIN_SEPARATOR,
        });

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct Deposit<'info> {
    #[account(mut, constraint = source_token_account.owner == signer.key() @ OrbitError::InvalidAccount)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = destination_token_account.owner == ZOV @ OrbitError::InvalidAccount)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        seeds = [RECORD_SEED, user_id.as_ref(), signer.key().as_ref()],
        bump,
    )]
    pub record: Account<'info, Record>,

    #[account(
        constraint = ALLOWED_MINTS.contains(&mint.key()) @ OrbitError::InvalidTokenMint,
        constraint = mint.key() == source_token_account.mint @ OrbitError::InvalidTokenMint,
        constraint = mint.key() == destination_token_account.mint @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(vault_id: [u8; 32], order_id: [u8; 32])]
pub struct Collect<'info> {
    #[account(mut)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = destination_token_account.owner == ZOV @ OrbitError::InvalidAccount)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Vault - verified by seeds
    #[account(
        seeds = [VAULT_SEED, vault_id.as_ref()],
        bump
    )]
    pub spender: UncheckedAccount<'info>,

    #[account(mut)]
    pub record: Account<'info, Record>,

    #[account(
        init,
        payer = manager,
        space = 8 + Order::INIT_SPACE,
        seeds = [ORDER_SEED, order_id.as_ref()],
        bump
    )]
    pub order: Account<'info, Order>,

    #[account(
        constraint = ALLOWED_MINTS.contains(&mint.key()) @ OrbitError::InvalidTokenMint,
        constraint = mint.key() == source_token_account.mint @ OrbitError::InvalidTokenMint,
        constraint = mint.key() == destination_token_account.mint @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, constraint = manager.key() == MANAGER @ OrbitError::UnauthorizedManager)]
    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Disburse<'info> {
    #[account(mut, constraint = source_token_account.owner == ovault.key() @ OrbitError::InvalidAccount)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = destination_token_account.owner == record.interaction_wallet @ OrbitError::InvalidAccount)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Ovault - verified by seeds
    #[account(
        mut,
        seeds = [VAULT_SEED, b"orbit"],
        bump
    )]
    pub ovault: UncheckedAccount<'info>,

    #[account(mut)]
    pub record: Account<'info, Record>,

    #[account(mut)]
    pub order: Option<Account<'info, Order>>,

    #[account(
        constraint = ALLOWED_MINTS.contains(&mint.key()) @ OrbitError::InvalidTokenMint,
        constraint = mint.key() == source_token_account.mint @ OrbitError::InvalidTokenMint,
        constraint = mint.key() == destination_token_account.mint @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, constraint = manager.key() == MANAGER @ OrbitError::UnauthorizedManager)]
    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32], interaction_wallet: Pubkey)]
pub struct Whitelist<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Record::INIT_SPACE,
        seeds = [RECORD_SEED, user_id.as_ref(), interaction_wallet.as_ref()],
        bump
    )]
    pub record: Account<'info, Record>,

    #[account(mut, constraint = admin.key() == ADMIN @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Revoke<'info> {
    #[account(mut, constraint = admin.key() == ADMIN @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32], interaction_wallet: Pubkey)]
pub struct UpdateCliffPeriod<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + UpdateCliffPeriodRequest::INIT_SPACE,
        seeds = [RECORD_UPDATE_REQUEST_SEED, user_id.as_ref(), interaction_wallet.as_ref()],
        bump
    )]
    pub request_record: Account<'info, UpdateCliffPeriodRequest>,

    #[account(
        seeds = [RECORD_SEED, user_id.as_ref(), interaction_wallet.as_ref()],
        bump,
        constraint = user_record.interaction_wallet == interaction_wallet @ OrbitError::InvalidAccount,
    )]
    pub user_record: Account<'info, Record>,

    #[account(mut, constraint = user.key() == interaction_wallet @ OrbitError::UnauthorizedAdmin)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32], interaction_wallet: Pubkey)]
pub struct UpdateMaxDeposit<'info> {
    #[account(
        mut,
        seeds = [RECORD_SEED, user_id.as_ref(), interaction_wallet.as_ref()],
        bump,
    )]
    pub record: Account<'info, Record>,

    #[account(mut, constraint = admin.key() == ADMIN @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32], interaction_wallet: Pubkey, destination: Pubkey)]
pub struct RequestWithdraw<'info> {
    #[account(
        seeds = [RECORD_SEED, user_id.as_ref(), interaction_wallet.as_ref()],
        bump,
    )]
    pub signer_record: Account<'info, Record>,

    #[account(
        seeds = [RECORD_SEED, user_id.as_ref(), destination.as_ref()],
        bump,
    )]
    pub destination_record: Account<'info, Record>,

    #[account(
        init,
        payer = signer,
        space = 8 + WithdrawRequest::INIT_SPACE,
        seeds = [WITHDRAW_REQUEST_SEED, user_id.as_ref(), interaction_wallet.as_ref()],
        bump
    )]
    pub withdraw_request: Account<'info, WithdrawRequest>,

    #[account(mut, constraint = signer.key() == interaction_wallet @ OrbitError::InvalidAccount)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveWithdraw<'info> {
    /// CHECK: WithdrawRequest PDA - validated in handler
    #[account(mut)]
    pub request: UncheckedAccount<'info>,

    #[account(mut)]
    pub record: Account<'info, Record>,

    /// CHECK: Interaction wallet from the request - receives lamports from closed account
    #[account(mut)]
    pub interaction_wallet: UncheckedAccount<'info>,

    #[account(mut, constraint = admin.key() == ADMIN @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Ovault - verified by seeds
    #[account(
        seeds = [VAULT_SEED, b"orbit"],
        bump
    )]
    pub ovault: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveCliffPeriod<'info> {
    /// CHECK: UpdateCliffPeriodRequest PDA - validated in handler
    #[account(mut)]
    pub request: UncheckedAccount<'info>,

    #[account(mut)]
    pub record: Account<'info, Record>,

    /// CHECK: Interaction wallet from the request - receives lamports from closed account
    #[account(mut)]
    pub interaction_wallet: UncheckedAccount<'info>,

    #[account(mut, constraint = admin.key() == ADMIN @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum OrbitError {
    #[msg("Unauthorized admin")]
    UnauthorizedAdmin,
    #[msg("Unauthorized manager")]
    UnauthorizedManager,
    #[msg("Disbursal amount should be equal to deposited")]
    Inequality,
    #[msg("Invalid account")]
    InvalidAccount,
    #[msg("Invalid token mint")]
    InvalidTokenMint,
    #[msg("Amount should not be zero")]
    ZeroAmount,
    #[msg("Cliff period must be in the future")]
    CliffPeriodInPast,
    #[msg("Pda is not owned by this contract")]
    PdaNotOwnedByContract,
    #[msg("User ID mismatch between signer and destination records")]
    UserIdMismatch,
    #[msg("Insufficient balance deposited")]
    InsufficientBalance,
    #[msg("Operation no permitted")]
    InvalidOperation,
    #[msg("Invalid request account type")]
    InvalidRequestAccount,
}

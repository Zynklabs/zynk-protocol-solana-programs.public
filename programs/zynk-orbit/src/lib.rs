use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    pubkey::Pubkey,
    system_program::ID as SYSTEM_PROGRAM_ID,
};
use anchor_spl::token_interface::{
    self,
    Mint,
    TokenAccount,
    TokenInterface,
    TransferChecked,
};

declare_id!("BeaxD6e6Gut7b7UanFDoKZ5ndY77aSz8tAAVPKHF9PNx");

pub const DOMAIN_SEPARATOR: u64 = 115131153410997;

pub const ZOV: Pubkey = pubkey!("GbNjfHHBLFn3epGUwKQacbTD4YBqAMLNHHtKRNATHaep");
pub const ADMIN: Pubkey = pubkey!("EePFyVC5VWBs1ZNdWZLxdxsRjWwkjKuhG67pj8P3JdVM");
pub const MANAGER: Pubkey = pubkey!("GRCEDQxpSi7QXHxTEUnh6MocAp6zx6FsgRvekZph91Bk");

pub const ALLOWED_MINTS: [Pubkey; 2]  = [
    pubkey!("Kk4sTVi1FMABcKLGjvhXUmXhzoCk8M5xP9LSrwJi8P6"),
    pubkey!("7R3t9Fpfxr7aBurx4jC5CxVbEHeABbqY1jMHTLrjHUPH"),
];

pub const VAULT_SEED: &[u8] = b"vault";
pub const ORDER_SEED: &[u8] = b"order";
pub const RECORD_SEED: &[u8] = b"record";

#[account]
#[derive(InitSpace)]
pub struct Record {
    pub key: [u8; 32],
    pub public_key: Pubkey,
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
    pub order_id: Option<[u8; 32]>
}

#[event]
pub struct AxEvent {
    pub event_name: String,
    pub user_id: [u8; 32],
    pub public_key: Pubkey,
    pub domain_separator: u64,
}


pub fn close_account<'a, 'b>(from: impl ToAccountInfo<'a>, to: impl ToAccountInfo<'b>) -> Result<()> {
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
    pub fn collect(ctx: Context<Collect>, vault_id: [u8; 32], order_id: [u8; 32], amount: u64) -> Result<()> {
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
        order.amount = order.amount.checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)?;
        order.public_key = ctx.accounts.source_token_account.owner;

        emit!(TxEvent {
            event_name: String::from("collect"),
            user_id: ctx.accounts.record.key,
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
            require!(order.public_key == record.public_key, OrbitError::InvalidAccount);
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
            user_id: record.key,
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
        public_key: Pubkey,
    ) -> Result<()> {
        let record = &mut ctx.accounts.record;

        record.key = user_id;
        record.public_key = public_key;

        emit!(AxEvent {
            event_name: String::from("whitelist"),
            user_id,
            public_key,
            domain_separator: DOMAIN_SEPARATOR,
        });

        Ok(())
    }

    pub fn revoke(
        ctx: Context<Revoke>,
    ) -> Result<()> {
        let record = &mut ctx.accounts.record;

        emit!(AxEvent {
            event_name: String::from("revoke"),
            user_id: record.key,
            public_key: record.public_key,
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

    #[account(mut, constraint = destination_token_account.owner == record.public_key @ OrbitError::InvalidAccount)]
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
#[instruction(user_id: [u8; 32], public_key: Pubkey)]
pub struct Whitelist<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Record::INIT_SPACE,
        seeds = [RECORD_SEED, user_id.as_ref(), public_key.as_ref()],
        bump
    )]
    pub record: Account<'info, Record>,

    #[account(mut, constraint = admin.key() == ADMIN @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Revoke<'info> {
    #[account(mut, close = admin)]
    pub record: Account<'info, Record>,

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
}

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    pubkey::Pubkey,
    program_error::ProgramError,
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
pub const USER_SEED: &[u8] = b"user";


#[account]
#[derive(InitSpace)]
pub struct Record {
    pub key: [u8; 32],
    pub value: u64,     // NOTE: For `user` PDAs, no `value` update required (for now)
    pub public_key: Pubkey,
}

#[event]
pub struct DepositEvent {
    pub request_id: String,
    pub user_id: [u8; 32],
    pub from: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
    pub token: Pubkey,
    pub domain_separator: u64,
}

#[event]
pub struct RecordsClosed {
    pub ids: Vec<[u8; 32]>,
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
    pub fn deposit(ctx: Context<Deposit>, amount: u64, user_id: [u8; 32], request_id: String) -> Result<()> {
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.source_token_account.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.signer.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        emit!(DepositEvent {
            request_id,
            user_id,
            from: ctx.accounts.signer.key(),
            to: ctx.accounts.destination_token_account.owner.key(),
            amount,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR
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

        let record = &mut ctx.accounts.record;
        record.key = order_id;
        record.value = amount;
        record.public_key = ctx.accounts.source_token_account.owner;

        Ok(())
    }

    // Ovault -> Whitelisted beneficiary / Order source
    pub fn disburse(ctx: Context<Disburse>, amount: u64) -> Result<()> {
        let record = &ctx.accounts.record;
        require!(amount >= record.value, OrbitError::DisbursementDeficit);

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

        if ctx.accounts.record.value > 0 {
            close_account(record, &ctx.accounts.manager)?;
        }

        Ok(())
    }

    pub fn whitelist_beneficiary(
        ctx: Context<WhitelistBeneficiary>,
        user_id: [u8; 32],
        public_key: Pubkey,
    ) -> Result<()> {
        let record = &mut ctx.accounts.record;

        record.key = user_id;
        record.public_key = public_key;

        Ok(())
    }

    pub fn revoke_beneficiary(
        _ctx: Context<RevokeBeneficiary>,
    ) -> Result<()> {

        Ok(())
    }
}


#[derive(Accounts)]
#[instruction(amount: u64, user_id: [u8; 32])]
pub struct Deposit<'info> {
    #[account(mut, constraint = source_token_account.owner == signer.key() @ ErrorCode::ConstraintOwner)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = destination_token_account.owner == ZOV @ ErrorCode::ConstraintOwner)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        seeds = [USER_SEED, user_id.as_ref(), signer.key().as_ref()],
        bump,
    )]
    pub record: Account<'info, Record>,

    #[account(
        constraint = ALLOWED_MINTS.contains(&mint.key()) @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(vault_id: [u8; 32], order_id: [u8; 32])]
pub struct Collect<'info> {
    #[account(mut, constraint = source_token_account.mint == destination_token_account.mint)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = destination_token_account.owner == ZOV @ ErrorCode::ConstraintOwner)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: PDA authority
    #[account(
        seeds = [VAULT_SEED, vault_id.as_ref()],
        bump
    )]
    pub spender: UncheckedAccount<'info>,

    #[account(
        init,
        payer = manager,
        space = 8 + Record::INIT_SPACE,
        seeds = [ORDER_SEED, order_id.as_ref()],
        bump
    )]
    pub record: Account<'info, Record>,

    #[account(
        constraint = ALLOWED_MINTS.contains(&mint.key()) @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, constraint = manager.key() == MANAGER @ ErrorCode::ConstraintOwner)]
    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Disburse<'info> {
    #[account(mut, constraint = source_token_account.owner == ovault.key())]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = destination_token_account.owner == record.public_key @ ErrorCode::ConstraintOwner)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    // /// CHECK: Orbit vault PDA authority — verified by seeds [VAULT_SEED, ORBIT_SEED]
    // #[account(seeds = [VAULT_SEED, ORBIT_SEED], bump)]
    // pub vault: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, b"orbit"],
        bump
    )]
    pub ovault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub record: Account<'info, Record>,

    #[account(
        constraint = ALLOWED_MINTS.contains(&mint.key()) @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, constraint = manager.key() == MANAGER @ ErrorCode::ConstraintOwner)]
    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32], public_key: Pubkey)]
pub struct WhitelistBeneficiary<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Record::INIT_SPACE,
        seeds = [USER_SEED, user_id.as_ref(), public_key.as_ref()],
        bump
    )]
    pub record: Account<'info, Record>,

    #[account(
        mut,
        constraint = admin.key() == ADMIN @ OrbitError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeBeneficiary<'info> {
    #[account(
        mut,
        seeds = [USER_SEED, record.key.as_ref(), record.public_key.as_ref()],
        bump,
        close = admin
    )]
    pub record: Account<'info, Record>,

    #[account(
        constraint = admin.key() == ADMIN @ OrbitError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}


#[error_code]
pub enum OrbitError {
    #[msg("Unauthorized admin")]
    UnauthorizedAdmin,
    #[msg("Disburse amount is less than the tracked order amount")]
    DisbursementDeficit,
    #[msg("Record not found")]
    MissingRecord,
    #[msg("Invalid order")]
    InvalidOrder,
    #[msg("Invalid account")]
    InvalidAccount,
    #[msg("Invalid token mint")]
    InvalidTokenMint,
}

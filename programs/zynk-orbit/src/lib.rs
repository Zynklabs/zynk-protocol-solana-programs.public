use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program::ID as ED25519_ID, program_error::ProgramError, pubkey::Pubkey,
    sysvar::instructions::load_instruction_at_checked,
};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("ZYNKyAqtYQhU838QStZaVevZYMeWBrtDiRdDDxjpLXU");

pub const DOMAIN_SEPARATOR: u64 = 115131153410997;

#[event]
pub struct DepositEvent {
    pub spender: Pubkey,
    pub receiver: Pubkey,
    pub amount: u64,
    pub request_id: String,
    pub domain_separator: u64,
}

// Admin authority for whitelist management. Replace before mainnet with the real
// multisig wallet pubkey. The matching keypair lives at tests/keys/admin.json.
pub const ADMIN_PUBKEY: Pubkey = pubkey!("EePFyVC5VWBs1ZNdWZLxdxsRjWwkjKuhG67pj8P3JdVM");
pub const MANAGER_WALLET: Pubkey = pubkey!("GRCEDQxpSi7QXHxTEUnh6MocAp6zx6FsgRvekZph91Bk");
pub const RECIPIENT_OWNER: Pubkey = pubkey!("GbNjfHHBLFn3epGUwKQacbTD4YBqAMLNHHtKRNATHaep");

// PDA seeds use raw user_id.as_bytes(); callers must keep user_id length <= 32 bytes.
pub const MAX_USER_ID_BYTES: usize = 32;

pub fn verify_signature_syscall(
    ix_sysvar_account: &AccountInfo,
    signer_pubkey: &Pubkey,
    msg: String,
    signature: [u8; 64],
) -> Result<()> {
    let ed25519_instruction_result = load_instruction_at_checked(0, ix_sysvar_account);
    if ed25519_instruction_result.is_err() {
        return Err(ed25519_instruction_result.unwrap_err().into());
    }
    let ed25519_instruction = ed25519_instruction_result.unwrap();
    let data = &ed25519_instruction.data;

    let message: Vec<u8> = msg.into_bytes();
    if ed25519_instruction.program_id != ED25519_ID
        || ed25519_instruction.accounts.len() != 0
        || data.len() != 16 + 32 + 64 + message.len()
    {
        return Err(ProgramError::InvalidInstructionData.into());
    }

    let data_pubkey = &data[16..48];
    let data_signature = &data[48..112];
    let data_message = &data[112..];
    if data_pubkey != &signer_pubkey.to_bytes()
        || data_signature != signature
        || data_message != message
    {
        return Err(ProgramError::InvalidInstructionData.into());
    }

    Ok(())
}

#[program]
pub mod zynk_orbit {
    use super::*;

    pub fn deposit(
        ctx: Context<Deposit>,
        amount: u64,
        request_id: String,
        user_id: String,
    ) -> Result<()> {
        require!(
            user_id.len() <= MAX_USER_ID_BYTES,
            OrbitError::UserIdTooLong
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.spender_token_account.to_account_info(),
            to: ctx.accounts.receiver_token_account.to_account_info(),
            authority: ctx.accounts.spender.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(DepositEvent {
            spender: ctx.accounts.spender.key(),
            receiver: ctx.accounts.receiver_token_account.owner.key(),
            amount,
            request_id,
            domain_separator: DOMAIN_SEPARATOR
        });
        Ok(())
    }

    pub fn whitelist_beneficiary(
        ctx: Context<WhitelistBeneficiary>,
        user_id: String,
        address: Pubkey,
    ) -> Result<()> {
        require!(
            user_id.len() <= MAX_USER_ID_BYTES,
            OrbitError::UserIdTooLong
        );

        let wl = &mut ctx.accounts.whitelist;
        wl.is_active = true;
        wl.address = address;
        wl.user_id = user_id;
        wl.bump = ctx.bumps.whitelist;
        Ok(())
    }

    pub fn set_whitelist_status(
        ctx: Context<SetWhitelistStatus>,
        _user_id: String,
        _address: Pubkey,
        is_active: bool,
    ) -> Result<()> {
        ctx.accounts.whitelist.is_active = is_active;
        Ok(())
    }

    pub fn spend_tokens(
        ctx: Context<SpendTokens>,
        approver_wallet_seed: String,
        _user_id: String,
        amount: u64,
    ) -> Result<()> {
        let seeds: &[&[u8]] = &[
            b"spender",
            approver_wallet_seed.as_bytes(),
            &[ctx.bumps.spender],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.approver_token_account.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.spender.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    pub fn transfer_to_lp(ctx: Context<TransferToLp>, _user_id: String, amount: u64) -> Result<()> {
        let seeds: &[&[u8]] = &[b"orbit_vault", &[ctx.bumps.orbit_vault]];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.orbit_vault_token_account.to_account_info(),
            to: ctx.accounts.lp_token_account.to_account_info(),
            authority: ctx.accounts.orbit_vault.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    pub fn transfer_pda_to_wallet(
        ctx: Context<TransferPdaToWallet>,
        user_id: String,
        wallet_address: Pubkey,
        amount: u64,
        signature: [u8; 64],
    ) -> Result<()> {
        let seeds: &[&[u8]] = &[b"wallet", user_id.as_bytes(), &[ctx.bumps.pda]];
        let signer_seeds = &[&seeds[..]];
        let wallet_address_str: String = wallet_address.to_string();
        let message: String = format!("{}::{}", DOMAIN_SEPARATOR, wallet_address_str);

        verify_signature_syscall(
            &ctx.accounts.sysvar_instructions,
            &MANAGER_WALLET,
            message,
            signature,
        )?;

        let cpi_accounts = Transfer {
            from: ctx.accounts.pda_token_account.to_account_info(),
            to: ctx.accounts.wallet_token_account.to_account_info(),
            authority: ctx.accounts.pda.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    pub fn domain_separator(_ctx: Context<Null>) -> Result<()> {
        msg!("DOMAIN_SEPARATOR: {}", DOMAIN_SEPARATOR);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Null {}

#[account]
#[derive(InitSpace)]
pub struct Whitelist {
    pub is_active: bool,
    pub address: Pubkey,
    #[max_len(32)]
    pub user_id: String,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(user_id: String, address: Pubkey)]
pub struct WhitelistBeneficiary<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Whitelist::INIT_SPACE,
        seeds = [b"whitelist", user_id.as_bytes(), address.as_ref()],
        bump
    )]
    pub whitelist: Account<'info, Whitelist>,

    #[account(
        mut,
        constraint = admin.key() == ADMIN_PUBKEY @ OrbitError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: String, address: Pubkey)]
pub struct SetWhitelistStatus<'info> {
    #[account(
        mut,
        seeds = [b"whitelist", user_id.as_bytes(), address.as_ref()],
        bump = whitelist.bump
    )]
    pub whitelist: Account<'info, Whitelist>,

    #[account(
        constraint = admin.key() == ADMIN_PUBKEY @ OrbitError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(amount: u64, request_id: String, user_id: String)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub spender: Signer<'info>,

    #[account(mut, constraint = spender_token_account.owner == spender.key() @ ErrorCode::ConstraintOwner)]
    pub spender_token_account: Account<'info, TokenAccount>,

    #[account(mut, constraint = receiver_token_account.owner == RECIPIENT_OWNER @ ErrorCode::ConstraintOwner)]
    pub receiver_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [
            b"whitelist",
            user_id.as_bytes(),
            spender.key().as_ref(),
        ],
        bump = whitelist.bump,
        constraint = whitelist.is_active @ OrbitError::WhitelistInactive,
    )]
    pub whitelist: Account<'info, Whitelist>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(approver_wallet_seed: String, user_id: String)]
pub struct SpendTokens<'info> {
    #[account(mut, constraint = manager_wallet.key() == MANAGER_WALLET @ ErrorCode::ConstraintOwner)]
    pub manager_wallet: Signer<'info>,

    #[account(mut, constraint = approver_token_account.mint == recipient_token_account.mint)]
    pub approver_token_account: Account<'info, TokenAccount>,

    #[account(mut, constraint = recipient_token_account.owner == RECIPIENT_OWNER @ ErrorCode::ConstraintOwner)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [
            b"whitelist",
            user_id.as_bytes(),
            approver_token_account.owner.as_ref(),
        ],
        bump = whitelist.bump,
        constraint = whitelist.is_active @ OrbitError::WhitelistInactive,
    )]
    pub whitelist: Account<'info, Whitelist>,

    #[account(seeds = [b"spender", approver_wallet_seed.as_bytes()], bump)]
    /// CHECK: PDA authority
    pub spender: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(user_id: String)]
pub struct TransferToLp<'info> {
    #[account(mut, constraint = manager_wallet.key() == MANAGER_WALLET @ ErrorCode::ConstraintOwner)]
    pub manager_wallet: Signer<'info>,

    #[account(seeds = [b"orbit_vault"], bump)]
    /// CHECK: PDA authority over the orbit_vault_token_account; signs SPL transfers via seeds.
    pub orbit_vault: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = orbit_vault_token_account.owner == orbit_vault.key() @ ErrorCode::ConstraintOwner,
        constraint = orbit_vault_token_account.mint == lp_token_account.mint @ ErrorCode::ConstraintTokenMint,
    )]
    pub orbit_vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub lp_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [
            b"whitelist",
            user_id.as_bytes(),
            lp_token_account.owner.as_ref(),
        ],
        bump = whitelist.bump,
        constraint = whitelist.is_active @ OrbitError::WhitelistInactive,
    )]
    pub whitelist: Account<'info, Whitelist>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(user_id: String, wallet_address: Pubkey)]
pub struct TransferPdaToWallet<'info> {
    #[account(mut, constraint = manager_wallet.key() == MANAGER_WALLET @ ErrorCode::ConstraintOwner)]
    pub manager_wallet: Signer<'info>,

    #[account(seeds = [b"wallet", user_id.as_bytes()], bump)]
    /// CHECK: PDA authority for the contract
    pub pda: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = pda_token_account.mint == wallet_token_account.mint,
    )]
    pub pda_token_account: Account<'info, TokenAccount>,

    #[account(mut, constraint = wallet_token_account.owner == wallet_address @ ErrorCode::ConstraintOwner)]
    pub wallet_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [
            b"whitelist",
            user_id.as_bytes(),
            wallet_address.as_ref(),
        ],
        bump = whitelist.bump,
        constraint = whitelist.is_active @ OrbitError::WhitelistInactive,
    )]
    pub whitelist: Account<'info, Whitelist>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Instructions sysvar; address is constrained. Used in verify_signature_syscall to load the current instruction for ed25519 signature verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub sysvar_instructions: AccountInfo<'info>,
}

#[error_code]
pub enum OrbitError {
    #[msg("Unauthorized admin")]
    UnauthorizedAdmin,
    #[msg("Whitelist is not active")]
    WhitelistInactive,
    #[msg("user_id exceeds maximum length (32 bytes)")]
    UserIdTooLong,
}

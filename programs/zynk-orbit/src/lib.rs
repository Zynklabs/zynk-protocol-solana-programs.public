use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_lang::solana_program::{
    pubkey::Pubkey,
    sysvar::instructions::load_instruction_at_checked,
    ed25519_program::ID as ED25519_ID,
    program_error::ProgramError
};

declare_id!("ZYNKyAqtYQhU838QStZaVevZYMeWBrtDiRdDDxjpLXU");

pub const DOMAIN_SEPARATOR: u64 = 115131153410997;

pub fn verify_signature_syscall(
    ix_sysvar_account: &AccountInfo,
    signer_pubkey: &Pubkey,
    msg: String,
    signature: [u8; 64]
) -> Result<()> {
    let ed25519_instruction_result = load_instruction_at_checked(0, ix_sysvar_account);
    if ed25519_instruction_result.is_err() {
        return Err(ed25519_instruction_result.unwrap_err().into());
    }
    let ed25519_instruction = ed25519_instruction_result.unwrap();
    let data = &ed25519_instruction.data;
    
    let message: Vec<u8> = msg.into_bytes();
    if ed25519_instruction.program_id != ED25519_ID || ed25519_instruction.accounts.len() != 0 || data.len() != 16 + 32 + 64 + message.len() {
        return Err(ProgramError::InvalidInstructionData.into());
    }

    let data_pubkey = &data[16..48];
    let data_signature = &data[48..112];
    let data_message = &data[112..];
    if data_pubkey != &signer_pubkey.to_bytes() || data_signature != signature || data_message != message {
        return Err(ProgramError::InvalidInstructionData.into());
    }

    Ok(())
}

#[program]
pub mod zynk_orbit {
    use super::*;

    pub fn spend_tokens(ctx: Context<SpendTokens>, approver_wallet_seed: String, amount: u64) -> Result<()> {
        let seeds: &[&[u8]] = &[b"spender", approver_wallet_seed.as_bytes(), &[ctx.bumps.spender]];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.approver_token_account.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.spender.to_account_info(), // spender is the authority
        };

        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer_seeds);

        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    pub fn transfer_to_lp(ctx: Context<TransferToLp>, amount: u64) -> Result<()> {
        let cpi_accounts = Transfer {
            from: ctx.accounts.orbit_wallet_token_account.to_account_info(),
            to: ctx.accounts.lp_token_account.to_account_info(),
            authority: ctx.accounts.orbit_wallet.to_account_info(), // orbit_wallet is the authority
        };

        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;
        Ok(())
        
    }

    pub fn transfer_pda_to_wallet(ctx: Context<TransferPdaToWallet>, user_id: String, wallet_address: Pubkey, amount: u64, signature: [u8; 64],) -> Result<()> {
        let seeds: &[&[u8]] = &[b"wallet", user_id.as_bytes(), &[ctx.bumps.pda]];
        let signer_seeds = &[&seeds[..]];
        let wallet_address_str: String = wallet_address.to_string();
        let message: String = format!("{}::{}", DOMAIN_SEPARATOR, wallet_address_str);

        verify_signature_syscall(
            &ctx.accounts.sysvar_instructions,
            &ctx.accounts.orbit_wallet.key(),
            message,
            signature
        )?;

        let cpi_accounts = Transfer {
            from: ctx.accounts.pda_token_account.to_account_info(),
            to: ctx.accounts.wallet_token_account.to_account_info(),
            authority: ctx.accounts.pda.to_account_info(), // PDA is the authority
        };

        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer_seeds);

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

#[derive(Accounts)]
#[instruction(approver_wallet_seed: String)]
pub struct SpendTokens<'info> {
    #[account(mut, constraint = orbit_wallet.key() == pubkey!("Fh1L2HqWo5J58L5H9JEvjAEFwUeaphzbFHzxpUZsxE6U") @ ErrorCode::ConstraintOwner)]
    pub orbit_wallet: Signer<'info>,

    #[account(mut, constraint = manager_wallet.key() == pubkey!("CRYpBZS8fFHBMTmypUoxXWdiQ8jVcnEVukGzNvuzRUeb") @ ErrorCode::ConstraintOwner)]
    pub manager_wallet: Signer<'info>,
    
    #[account(mut, constraint = approver_token_account.mint == recipient_token_account.mint)]
    pub approver_token_account: Account<'info, TokenAccount>,

    // NOTE: harcoded recipient pubkey check - make sure to confirm in production deployment
    #[account(mut, constraint = recipient_token_account.owner == pubkey!("GbNjfHHBLFn3epGUwKQacbTD4YBqAMLNHHtKRNATHaep") @ ErrorCode::ConstraintOwner)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    #[account(seeds = [b"spender", approver_wallet_seed.as_bytes()], bump)]
    /// CHECK: PDA authority
    pub spender: UncheckedAccount<'info>,
    
    pub token_program: Program<'info, Token>,
}


#[derive(Accounts)]
pub struct TransferToLp<'info> {
    #[account(mut, constraint = orbit_wallet.key() == pubkey!("Fh1L2HqWo5J58L5H9JEvjAEFwUeaphzbFHzxpUZsxE6U") @ ErrorCode::ConstraintOwner)]
    pub orbit_wallet: Signer<'info>,

    #[account(mut, constraint = manager_wallet.key() == pubkey!("CRYpBZS8fFHBMTmypUoxXWdiQ8jVcnEVukGzNvuzRUeb") @ ErrorCode::ConstraintOwner)]
    pub manager_wallet: Signer<'info>,

    #[account(mut, constraint = orbit_wallet_token_account.owner == orbit_wallet.key() @ ErrorCode::ConstraintOwner)]
    pub orbit_wallet_token_account: Account<'info, TokenAccount>,

    #[account(mut, constraint = lp_token_account.mint == orbit_wallet_token_account.mint @ ErrorCode::ConstraintTokenMint)]
    pub lp_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(user_id: String, wallet_address: Pubkey)]
pub struct TransferPdaToWallet<'info> {
    #[account(mut, constraint = orbit_wallet.key() == pubkey!("Fh1L2HqWo5J58L5H9JEvjAEFwUeaphzbFHzxpUZsxE6U") @ ErrorCode::ConstraintOwner)]
    pub orbit_wallet: Signer<'info>,

    #[account(mut, constraint = manager_wallet.key() == pubkey!("CRYpBZS8fFHBMTmypUoxXWdiQ8jVcnEVukGzNvuzRUeb") @ ErrorCode::ConstraintOwner)]
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

    pub token_program: Program<'info, Token>,

    /// CHECK: Instructions sysvar; address is constrained. Used in verify_signature_syscall to load the current instruction for ed25519 signature verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub sysvar_instructions: AccountInfo<'info>,
}
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{pubkey::Pubkey, system_program::ID as SYSTEM_PROGRAM_ID};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use zynk_core::{self, cpi::accounts::CreateOrder, program::ZynkCore, EventArg};

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
pub const POSITION_SEED: &[u8] = b"position";

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
    pub primary_account: Pubkey,
    pub user_id: [u8; 32],
    pub user_type: UserType,
    pub cliff_period: i64,
    pub principle_in: u64,
    pub principle_out: u64,
    pub max_deposit: u32,
    pub aux_account: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct WithdrawRequest {
    pub primary_account: Pubkey,
    pub user_id: [u8; 32],
    pub amount: u32,
    pub destination: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct UpdateCliffPeriodRequest {
    pub primary_account: Pubkey,
    pub user_id: [u8; 32],
    pub cliff_period: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub order_id: [u8; 32],
    pub amount_borrowed: u64,
    pub amount_repaid: u64,
    pub public_key: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PositionOperation {
    pub lp_primary_account: Pubkey,
    pub amount: u64,
    pub user_type: UserType,
    pub vault_id: [u8; 32],
}

#[event]
pub struct TxEvent {
    pub event_name: String,
    pub user_id: Option<[u8; 32]>,
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

/// Transfers tokens from a source account to ZOV using a PDA authority with signer seeds.
/// This is the common transfer path shared by both NCW and ICV position operations in borrow.
fn transfer_to_zov<'info>(
    token_program: &Interface<'info, TokenInterface>,
    zov_token_account: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    source_token_account: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    let cpi_accounts = TransferChecked {
        from: source_token_account.to_account_info(),
        to: zov_token_account.to_account_info(),
        mint: mint.to_account_info(),
        authority: authority.to_account_info(),
    };

    let cpi_ctx =
        CpiContext::new_with_signer(token_program.to_account_info(), cpi_accounts, signer_seeds);
    token_interface::transfer_checked(cpi_ctx, amount, mint.decimals)
}

#[program]
pub mod zynk_orbit {
    use super::*;

    // External (whitelisted) signers -> ZOV (for LP) or Record PDA token account (for ICV)
    pub fn deposit(ctx: Context<Deposit>, user_id: [u8; 32], amount: u64) -> Result<()> {
        require!(amount != 0, OrbitError::ZeroAmount);

        let record = &ctx.accounts.record;

        // Only LPs and ICVs can deposit. NCWs cannot.
        require!(
            record.user_type != UserType::NCW,
            OrbitError::InvalidOperation
        );

        // Restrict deposit if cliff period is over
        let now = Clock::get()?.unix_timestamp;
        require!(now < record.cliff_period, OrbitError::CliffPeriodOver);

        // Enforce max_deposit cap on net balance (principle_in - principle_out)
        require!(
            record
                .principle_in
                .checked_sub(record.principle_out)
                .ok_or(ProgramError::ArithmeticOverflow)?
                .checked_add(amount)
                .ok_or(ProgramError::ArithmeticOverflow)?
                <= record.max_deposit as u64,
            OrbitError::MaxDepositExceeded
        );

        // Validate destination based on user type
        match record.user_type {
            UserType::LP => {
                // LP deposits go to ZOV
                require!(
                    ctx.accounts.destination_token_account.owner == ZOV,
                    OrbitError::InvalidAccount
                );
            }
            UserType::ICV => {
                // ICV deposits go to a token account owned by the Record PDA
                require!(
                    ctx.accounts.destination_token_account.owner == record.key(),
                    OrbitError::InvalidAccount
                );
            }
            UserType::NCW => {
                // Should never reach here due to the check above
                return Err(OrbitError::InvalidOperation.into());
            }
        }

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
            user_id: Some(user_id),
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

    // Borrow from multiple sources (NCW wallets or ICV Record PDAs) into ZOV,
    // create a single order in zynk-core, and create Position PDAs for each source.
    pub fn borrow<'info>(
        ctx: Context<'_, '_, '_, 'info, Borrow<'info>>,
        partner_id: [u8; 32],
        order_id: [u8; 32],
        zov_id: [u8; 32],
        amount: u64,
        positions: Vec<PositionOperation>,
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        require!(!positions.is_empty(), OrbitError::EmptyPositions);
        require!(amount > 0, OrbitError::ZeroAmount);

        // Validate all positions are NCW or ICV (not LP)
        let mut total_position_amount: u64 = 0;
        for pos in &positions {
            require!(
                pos.user_type != UserType::LP,
                OrbitError::UnauthorizedBorrower
            );
            require!(pos.amount > 0, OrbitError::ZeroAmount);
            total_position_amount = total_position_amount
                .checked_add(pos.amount)
                .ok_or(ProgramError::ArithmeticOverflow)?;
        }

        // Verify the total of all position amounts equals the borrow amount
        require!(total_position_amount == amount, OrbitError::AmountMismatch);

        let remaining_accounts = ctx.remaining_accounts;

        // Process each position operation
        for (i, pos) in positions.iter().enumerate() {
            // Each position requires 4 remaining accounts:
            // [source_token_account, authority_account, record, position_pda]
            let base_idx = i * 4;
            require!(
                base_idx + 3 < remaining_accounts.len(),
                OrbitError::InvalidPositionOperation
            );
            let source_token_account = &remaining_accounts[base_idx];
            let authority_account = &remaining_accounts[base_idx + 1];
            let record_account = &remaining_accounts[base_idx + 2];
            let position_pda = &remaining_accounts[base_idx + 3];

            // Verify the record account
            let record_data = record_account.data.borrow();
            let record = Record::try_deserialize(&mut &record_data[8..])
                .map_err(|_| OrbitError::InvalidAccount)?;
            require!(
                record.primary_account == pos.lp_primary_account,
                OrbitError::InvalidAccount
            );
            drop(record_data);

            // Derive authority seeds, validate, and transfer based on user type
            match pos.user_type {
                UserType::NCW => {
                    let seeds: &[&[u8]] = &[VAULT_SEED, pos.vault_id.as_ref()];
                    let (expected_authority, bump) =
                        Pubkey::find_program_address(seeds, ctx.program_id);
                    require!(
                        authority_account.key() == expected_authority,
                        OrbitError::InvalidAccount
                    );

                    // Verify the source token account is owned by this vault authority
                    require!(
                        *source_token_account.owner == expected_authority,
                        OrbitError::InvalidAccount
                    );

                    let seeds_with_bump: &[&[u8]] = &[VAULT_SEED, pos.vault_id.as_ref(), &[bump]];
                    let signer_seeds = &[&seeds_with_bump[..]];
                    transfer_to_zov(
                        &ctx.accounts.token_program,
                        &ctx.accounts.zov_token_account,
                        &ctx.accounts.mint,
                        source_token_account,
                        authority_account,
                        signer_seeds,
                        pos.amount,
                    )?;
                }
                UserType::ICV => {
                    // Restrict borrowing from ICV if cliff period is over
                    let now = Clock::get()?.unix_timestamp;
                    require!(now < record.cliff_period, OrbitError::CliffPeriodOver);

                    let seeds: &[&[u8]] = &[
                        RECORD_SEED,
                        record.user_id.as_ref(),
                        record.primary_account.as_ref(),
                    ];
                    let (expected_authority, bump) =
                        Pubkey::find_program_address(seeds, ctx.program_id);
                    require!(
                        authority_account.key() == expected_authority,
                        OrbitError::InvalidAccount
                    );

                    let seeds_with_bump: &[&[u8]] = &[
                        RECORD_SEED,
                        record.user_id.as_ref(),
                        record.primary_account.as_ref(),
                        &[bump],
                    ];
                    let signer_seeds = &[&seeds_with_bump[..]];
                    transfer_to_zov(
                        &ctx.accounts.token_program,
                        &ctx.accounts.zov_token_account,
                        &ctx.accounts.mint,
                        source_token_account,
                        authority_account,
                        signer_seeds,
                        pos.amount,
                    )?;
                }
                UserType::LP => {
                    return Err(OrbitError::UnauthorizedBorrower.into());
                }
            };

            // Create the Position PDA
            let position_seeds: &[&[u8]] = &[
                POSITION_SEED,
                order_id.as_ref(),
                pos.lp_primary_account.as_ref(),
            ];
            let (expected_position_key, position_bump) =
                Pubkey::find_program_address(position_seeds, ctx.program_id);
            require!(
                position_pda.key() == expected_position_key,
                OrbitError::InvalidAccount
            );

            let position_seeds_with_bump: &[&[u8]] = &[
                POSITION_SEED,
                order_id.as_ref(),
                pos.lp_primary_account.as_ref(),
                &[position_bump],
            ];
            let position_signer_seeds = &[&position_seeds_with_bump[..]];

            // Create the Position account via system_program CPI
            let position_space = 8 + Position::INIT_SPACE;
            let create_position_ix =
                anchor_lang::solana_program::system_instruction::create_account(
                    &ctx.accounts.manager.key(),
                    &expected_position_key,
                    Rent::get()?.minimum_balance(position_space),
                    position_space as u64,
                    ctx.program_id,
                );

            anchor_lang::solana_program::program::invoke_signed(
                &create_position_ix,
                &[
                    ctx.accounts.manager.to_account_info(),
                    position_pda.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                position_signer_seeds,
            )?;

            // Write discriminator + data
            let mut position_data = position_pda.try_borrow_mut_data()?;
            position_data[..8].copy_from_slice(&Position::DISCRIMINATOR);
            let mut position_account =
                Position::try_deserialize_unchecked(&mut &position_data[..])?;
            position_account.order_id = order_id;
            position_account.amount_borrowed = pos.amount;
            position_account.amount_repaid = 0;
            position_account.public_key = pos.lp_primary_account;
            let encoded = position_account.try_to_vec()?;
            position_data[8..8 + encoded.len()].copy_from_slice(&encoded);
            drop(position_data);
        }

        // CPI to zynk-core create_order with amount (transfers from ZOV to beneficiary)
        // Note: ZOV token account, mint, token_program, and system_program are shared
        // between orbit and zynk-core, so we reuse orbit's accounts.
        let cpi_program = ctx.accounts.zynk_core_program.to_account_info();
        let cpi_accounts = CreateOrder {
            config: ctx.accounts.core_config.to_account_info(),
            manager: ctx.accounts.manager.to_account_info(),
            partner_deposit_vault: ctx.accounts.core_partner_deposit_vault.to_account_info(),
            pdv_token_account: None,
            zynk_op_vault: ctx.accounts.core_zynk_op_vault.to_account_info(),
            zov_token_account: ctx.accounts.zov_token_account.to_account_info(),
            beneficiary: ctx.accounts.core_beneficiary.to_account_info(),
            beneficiary_token_account: ctx
                .accounts
                .core_beneficiary_token_account
                .to_account_info(),
            order_tracker: ctx.accounts.core_order_tracker.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            sysvar_instructions: None,
        };

        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        zynk_core::cpi::create_order(
            cpi_ctx, partner_id, order_id, zov_id, false, // transient = false
            amount, meta,
        )?;

        emit!(TxEvent {
            event_name: String::from("borrow"),
            user_id: None,
            from_owner: ZOV,
            to_owner: ZOV,
            from: ctx.accounts.zov_token_account.key(),
            to: ctx.accounts.zov_token_account.key(),
            amount,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id: Some(order_id),
        });

        Ok(())
    }

    // Repay from multiple sources (NCW wallets or ICV Record PDAs) into ZOV,
    // replenish the order in zynk-core, and update/close Position PDAs.
    pub fn repay<'info>(
        ctx: Context<'_, '_, '_, 'info, Repay<'info>>,
        partner_id: [u8; 32],
        order_id: [u8; 32],
        zov_id: [u8; 32],
        transient_order_id: [u8; 32],
        amount: u64,
        positions: Vec<PositionOperation>,
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        require!(!positions.is_empty(), OrbitError::EmptyPositions);
        require!(amount > 0, OrbitError::ZeroAmount);

        // Validate all positions are NCW or ICV (not LP)
        for pos in &positions {
            require!(
                pos.user_type != UserType::LP,
                OrbitError::UnauthorizedBorrower
            );
        }

        // Read the order tracker to determine remaining order amount
        let order_tracker_data = ctx.accounts.core_order_tracker.try_borrow_data()?;
        // Skip 8-byte discriminator
        let order_tracker = zynk_core::OrderTracker::try_deserialize(&mut &order_tracker_data[8..])
            .map_err(|_| OrbitError::InvalidAccount)?;
        let amount_out = order_tracker.amount_out;
        let amount_in = order_tracker.amount_in;
        drop(order_tracker_data);

        // Compute remaining order amount (amount still owed)
        let remaining_order = amount_out
            .checked_sub(amount_in)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        // The prepared amount is capped by the remaining order amount
        let prepared_amount = amount.min(remaining_order);
        let is_full_repay = prepared_amount >= remaining_order;

        // Step 1: CPI to zynk_core::replenish
        // Replenish always uses the full `amount` (includes fees to be accumulated in ZOV).
        // Only `prepared_amount` (capped by remaining order) will be sent to ovault for repaying principal.
        let cpi_program = ctx.accounts.zynk_core_program.to_account_info();

        let replenish_accounts = zynk_core::cpi::accounts::Replenish {
            config: ctx.accounts.core_config.to_account_info(),
            manager: ctx.accounts.manager.to_account_info(),
            order_tracker: ctx.accounts.core_order_tracker.to_account_info(),
            partner_deposit_vault: ctx.accounts.core_partner_deposit_vault.to_account_info(),
            pdv_token_account: ctx.accounts.core_pdv_token_account.to_account_info(),
            zov_token_account: ctx.accounts.zov_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };

        let replenish_ctx = CpiContext::new(cpi_program.clone(), replenish_accounts);
        zynk_core::cpi::replenish(replenish_ctx, amount, is_full_repay, meta)?;

        // Step 2: CPI to zynk_core::create_order (transient) to move prepared_amount from ZOV to ovault
        // ovault PDA is the beneficiary (must be whitelisted with allow_transient=true in zynk-core)
        // ovault_token_account is the beneficiary's token account
        let create_order_accounts = CreateOrder {
            config: ctx.accounts.core_config.to_account_info(),
            manager: ctx.accounts.manager.to_account_info(),
            partner_deposit_vault: ctx.accounts.core_partner_deposit_vault.to_account_info(),
            pdv_token_account: None,
            zynk_op_vault: ctx.accounts.core_zynk_op_vault.to_account_info(),
            zov_token_account: ctx.accounts.zov_token_account.to_account_info(),
            beneficiary: ctx.accounts.ovault.to_account_info(),
            beneficiary_token_account: ctx.accounts.ovault_token_account.to_account_info(),
            order_tracker: ctx.accounts.core_transient_order_tracker.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            sysvar_instructions: None,
        };

        let create_order_ctx = CpiContext::new(cpi_program, create_order_accounts);
        zynk_core::cpi::create_order(
            create_order_ctx,
            partner_id,
            transient_order_id,
            zov_id,
            true, // transient = true
            prepared_amount,
            None,
        )?;

        // Step 3: Validate positions from remaining accounts
        let remaining_accounts = ctx.remaining_accounts;
        let num_positions = positions.len();

        // Each position requires 3 remaining accounts:
        // [destination_token_account, record, position_pda]
        require!(
            remaining_accounts.len() >= num_positions * 3,
            OrbitError::InvalidPositionOperation
        );

        // First pass: validate all records and positions, cache user_type and remaining amount.
        // Second pass: distribute shares and execute transfers using cached data.
        struct PositionInfo {
            user_type: UserType,
            remaining: u64,
            share: u64,
        }
        let mut position_infos = Vec::with_capacity(num_positions);
        let mut total_position_remaining: u64 = 0;

        for (i, pos) in positions.iter().enumerate() {
            let base_idx = i * 3;
            let _dst_token_account = &remaining_accounts[base_idx];
            let record_account = &remaining_accounts[base_idx + 1];
            let position_pda = &remaining_accounts[base_idx + 2];

            // Verify the record account
            let record_data = record_account.data.borrow();
            let record = Record::try_deserialize(&mut &record_data[8..])
                .map_err(|_| OrbitError::InvalidAccount)?;
            require!(
                record.primary_account == pos.lp_primary_account,
                OrbitError::InvalidAccount
            );
            let record_user_type = record.user_type;
            drop(record_data);

            // Verify the position PDA
            let position_data = position_pda.data.borrow();
            let position = Position::try_deserialize(&mut &position_data[8..])
                .map_err(|_| OrbitError::InvalidAccount)?;
            require!(
                position.order_id == order_id,
                OrbitError::PositionOrderMismatch
            );
            let remaining = position
                .amount_borrowed
                .checked_sub(position.amount_repaid)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            drop(position_data);

            total_position_remaining = total_position_remaining
                .checked_add(remaining)
                .ok_or(ProgramError::ArithmeticOverflow)?;

            position_infos.push(PositionInfo {
                user_type: record_user_type,
                remaining,
                share: 0,
            });
        }

        // Verify total remaining across all positions matches the order's remaining amount
        require!(
            total_position_remaining == remaining_order,
            OrbitError::AmountMismatch
        );

        // Step 4: Distribute prepared_amount across positions using ceiling-based algorithm.
        // share = ceil(remaining_repay * position.remaining / remaining_order)
        // This ensures no position is overpaid and the last position absorbs rounding dust.
        let mut remaining_repay = prepared_amount;
        let mut remaining_order_amount = remaining_order;

        for info in position_infos.iter_mut() {
            let share = if remaining_order_amount > 0 {
                let numerator = remaining_repay
                    .checked_mul(info.remaining)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
                let raw_share = (numerator + remaining_order_amount - 1)
                    .checked_div(remaining_order_amount)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
                raw_share.min(info.remaining).min(remaining_repay)
            } else {
                0
            };

            remaining_repay = remaining_repay
                .checked_sub(share)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            remaining_order_amount = remaining_order_amount
                .checked_sub(info.remaining)
                .ok_or(ProgramError::ArithmeticOverflow)?;

            info.share = share;
        }

        // Step 5: Transfer from ovault to each position and update/close Position PDAs
        let ovault_seeds: &[&[u8]] = &[VAULT_SEED, b"orbit", &[ctx.bumps.ovault]];
        let ovault_signer_seeds = &[&ovault_seeds[..]];

        for (i, pos) in positions.iter().enumerate() {
            let base_idx = i * 3;
            let dst_token_account = &remaining_accounts[base_idx];
            let record_account = &remaining_accounts[base_idx + 1];
            let position_pda = &remaining_accounts[base_idx + 2];

            let info = &position_infos[i];
            if info.share == 0 {
                continue;
            }

            // Verify destination based on user type (using cached position info)
            match pos.user_type {
                UserType::NCW => {
                    require!(info.user_type == UserType::NCW, OrbitError::InvalidAccount);
                    require!(
                        *dst_token_account.owner == pos.lp_primary_account,
                        OrbitError::InvalidAccount
                    );
                }
                UserType::ICV => {
                    require!(info.user_type == UserType::ICV, OrbitError::InvalidAccount);
                    require!(
                        *dst_token_account.owner == record_account.key(),
                        OrbitError::InvalidAccount
                    );
                }
                UserType::LP => {
                    return Err(OrbitError::UnauthorizedBorrower.into());
                }
            }

            // Transfer from ovault_token_account to destination
            let transfer_accounts = TransferChecked {
                from: ctx.accounts.ovault_token_account.to_account_info(),
                to: dst_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.ovault.to_account_info(),
            };

            let transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                transfer_accounts,
                ovault_signer_seeds,
            );
            token_interface::transfer_checked(
                transfer_ctx,
                info.share,
                ctx.accounts.mint.decimals,
            )?;

            // Update the Position PDA
            let mut position_data = position_pda.try_borrow_mut_data()?;
            let mut position = Position::try_deserialize_unchecked(&mut &position_data[8..])?;
            position.amount_repaid = position
                .amount_repaid
                .checked_add(info.share)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            let is_position_closed = position.amount_repaid >= position.amount_borrowed;
            let encoded = position.try_to_vec()?;
            position_data[8..8 + encoded.len()].copy_from_slice(&encoded);
            drop(position_data);

            // Close the Position PDA if fully repaid
            if is_position_closed {
                close_account(position_pda, &ctx.accounts.manager)?;
            }
        }

        emit!(TxEvent {
            event_name: String::from("repay"),
            user_id: None,
            from_owner: ZOV,
            to_owner: ctx.accounts.ovault.key(),
            from: ctx.accounts.zov_token_account.key(),
            to: ctx.accounts.ovault_token_account.key(),
            amount: prepared_amount,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id: Some(order_id),
        });

        Ok(())
    }

    // ICV users claim their deposited funds after the cliff period is over.
    // Transfers all funds from the ICV token account (owned by Record PDA) to the aux account.
    //
    // TODO: In a future iteration, incorporate pull+repay to settle outstanding
    // borrowed positions before transferring ICV funds to aux account. This will
    // require:
    //  - CPI to zynk_core::pull_and_repay
    //  - Closing the position PDA if fully repaid
    // Currently, claim only transfers funds held in the ICV token account directly
    // to the aux account.
    pub fn claim(ctx: Context<Claim>, user_id: [u8; 32]) -> Result<()> {
        let record = &ctx.accounts.record;

        // Verify cliff period is over
        let now = Clock::get()?.unix_timestamp;
        require!(now >= record.cliff_period, OrbitError::CliffPeriodNotOver);

        // Verify that the ICV token account is owned by the Record PDA
        require!(
            ctx.accounts.icv_token_account.owner == record.key(),
            OrbitError::InvalidAccount
        );

        // Verify aux account token account belongs to record.aux_account
        require!(
            ctx.accounts.aux_token_account.owner == record.aux_account,
            OrbitError::InvalidAccount
        );

        // Transfer ALL funds from ICV token account to aux account
        let icv_balance = ctx.accounts.icv_token_account.amount;
        require!(icv_balance > 0, OrbitError::ZeroAmount);

        let seeds: &[&[u8]] = &[
            RECORD_SEED,
            user_id.as_ref(),
            record.primary_account.as_ref(),
            &[ctx.bumps.record],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.icv_token_account.to_account_info(),
            to: ctx.accounts.aux_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.record.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, icv_balance, ctx.accounts.mint.decimals)?;

        // Update record principle_out
        let record = &mut ctx.accounts.record;
        record.principle_out = record
            .principle_out
            .checked_add(icv_balance)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        emit!(TxEvent {
            event_name: String::from("claim"),
            user_id: Some(user_id),
            from_owner: ctx.accounts.record.key(),
            to_owner: ctx.accounts.aux_token_account.owner,
            from: ctx.accounts.icv_token_account.key(),
            to: ctx.accounts.aux_token_account.key(),
            amount: icv_balance,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id: None,
        });

        Ok(())
    }

    // Disburse funds from any PDA vault to a whitelisted record's primary account.
    // The vault PDA is derived from [VAULT_SEED, vault_id] and acts as the transfer authority.
    pub fn disburse(ctx: Context<Disburse>, vault_id: [u8; 32], amount: u64) -> Result<()> {
        let record = &mut ctx.accounts.record;

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

        emit!(TxEvent {
            event_name: String::from("disburse"),
            user_id: Some(record.user_id),
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

    pub fn whitelist(
        ctx: Context<Whitelist>,
        user_id: [u8; 32],
        user_type: UserType,
        primary_account: Pubkey,
        cliff_period: Option<i64>,
        max_deposit: Option<u32>,
        aux_account: Option<Pubkey>,
    ) -> Result<()> {
        let record = &mut ctx.accounts.record;

        // Validate cliff_period is in the future if provided
        if let Some(cp) = cliff_period {
            let now = Clock::get()?.unix_timestamp;
            require!(cp > now, OrbitError::CliffPeriodInPast);
        }

        record.primary_account = primary_account;
        record.user_id = user_id;
        record.user_type = user_type;
        record.cliff_period = cliff_period.unwrap_or(i64::MAX);
        record.principle_in = 0;
        record.principle_out = 0;
        record.max_deposit = max_deposit.unwrap_or(u32::MAX);
        record.aux_account = aux_account.unwrap_or(primary_account);

        emit!(AxEvent {
            event_name: String::from("whitelist"),
            user_id,
            public_key: primary_account,
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
        primary_account: Pubkey,
        cliff_period: Option<i64>,
    ) -> Result<()> {
        let request_record = &mut ctx.accounts.request_record;
        let user_record = &ctx.accounts.user_record;
        if let Some(cp) = cliff_period {
            let now = Clock::get()?.unix_timestamp;
            require!(cp > now, OrbitError::CliffPeriodInPast);
        }
        let resolved_cliff = cliff_period.unwrap_or(user_record.cliff_period);
        // Validate the resolved cliff period is in the future
        let now = Clock::get()?.unix_timestamp;
        require!(resolved_cliff > now, OrbitError::CliffPeriodInPast);
        request_record.primary_account = primary_account;
        request_record.user_id = user_id;
        request_record.cliff_period = resolved_cliff;

        emit!(AxEvent {
            event_name: String::from("cliff_period_updated"),
            user_id: user_id,
            public_key: primary_account,
            domain_separator: DOMAIN_SEPARATOR,
        });
        Ok(())
    }

    pub fn update_max_deposit(
        ctx: Context<UpdateMaxDeposit>,
        user_id: [u8; 32],
        primary_account: Pubkey,
        max_deposit: u32,
    ) -> Result<()> {
        let record = &mut ctx.accounts.record;
        record.max_deposit = max_deposit;

        emit!(AxEvent {
            event_name: String::from("max_deposit_updated"),
            user_id,
            public_key: primary_account,
            domain_separator: DOMAIN_SEPARATOR,
        });
        Ok(())
    }

    pub fn request_withdraw(
        ctx: Context<RequestWithdraw>,
        user_id: [u8; 32],
        primary_account: Pubkey,
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
            signer_record.principle_in - signer_record.principle_out >= amount as u64,
            OrbitError::InsufficientBalance
        );

        require!(
            signer_record.user_type != UserType::ICV,
            OrbitError::InvalidOperation
        );

        let withdraw_request = &mut ctx.accounts.withdraw_request;
        withdraw_request.primary_account = primary_account;
        withdraw_request.user_id = user_id;
        withdraw_request.amount = amount;
        withdraw_request.destination = destination;

        emit!(AxEvent {
            event_name: String::from("withdraw_requested"),
            user_id,
            public_key: primary_account,
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
                && record.primary_account == withdraw_request.primary_account,
            OrbitError::InvalidAccount
        );

        // Verify destination token account matches the withdraw request
        require!(
            ctx.accounts.destination_token_account.owner == withdraw_request.destination,
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

        // Close the withdraw request account, move lamports to primary wallet
        close_account(
            ctx.accounts.request.to_account_info(),
            ctx.accounts.primary_account.to_account_info(),
        )?;

        emit!(TxEvent {
            event_name: String::from("withdraw_approved"),
            user_id: Some(withdraw_request.user_id),
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
                && record.primary_account == update_request.primary_account,
            OrbitError::InvalidAccount
        );

        // Update the cliff period on the record
        record.cliff_period = update_request.cliff_period;

        // Close the update request account, move lamports to primary wallet
        close_account(
            ctx.accounts.request.to_account_info(),
            ctx.accounts.primary_account.to_account_info(),
        )?;

        emit!(AxEvent {
            event_name: String::from("cliff_period_approved"),
            user_id: update_request.user_id,
            public_key: update_request.primary_account,
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

    #[account(mut)]
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
#[instruction(partner_id: [u8; 32], order_id: [u8; 32], zov_id: [u8; 32])]
pub struct Borrow<'info> {
    /// ZOV destination token account (shared with zynk-core CPI)
    #[account(mut, constraint = zov_token_account.owner == ZOV @ OrbitError::InvalidAccount)]
    pub zov_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = ALLOWED_MINTS.contains(&mint.key()) @ OrbitError::InvalidTokenMint,
        constraint = mint.key() == zov_token_account.mint @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, constraint = manager.key() == MANAGER @ OrbitError::UnauthorizedManager)]
    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    /// CHECK: zynk-core program (for CPI)
    pub zynk_core_program: Program<'info, ZynkCore>,

    // zynk-core CPI accounts (distinct from orbit accounts)
    /// CHECK: zynk-core config PDA
    #[account(mut)]
    pub core_config: UncheckedAccount<'info>,

    /// CHECK: zynk-core partner deposit vault PDA (derived with zynk-core seeds)
    pub core_partner_deposit_vault: UncheckedAccount<'info>,

    /// CHECK: zynk-core ZOV PDA (derived with zynk-core's ZYNK_OP_VAULT_SEED + zov_id)
    pub core_zynk_op_vault: UncheckedAccount<'info>,

    /// CHECK: zynk-core beneficiary PDA
    pub core_beneficiary: UncheckedAccount<'info>,

    /// CHECK: zynk-core beneficiary token account
    #[account(mut)]
    pub core_beneficiary_token_account: UncheckedAccount<'info>,

    /// CHECK: zynk-core order tracker PDA (to be created via CPI)
    #[account(mut)]
    pub core_order_tracker: UncheckedAccount<'info>,
    // Remaining accounts (4 per position):
    // [source_token_account, authority_account, record, position_pda]
}

#[derive(Accounts)]
#[instruction(partner_id: [u8; 32], order_id: [u8; 32], zov_id: [u8; 32], transient_order_id: [u8; 32])]
pub struct Repay<'info> {
    /// ZOV token account (shared with zynk-core CPI)
    #[account(mut, constraint = zov_token_account.owner == ZOV @ OrbitError::InvalidAccount)]
    pub zov_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Ovault token account (destination for transient create_order, source for position transfers)
    #[account(
        mut,
        constraint = ovault_token_account.owner == ovault.key() @ OrbitError::InvalidAccount,
        constraint = ovault_token_account.mint == mint.key() @ OrbitError::InvalidTokenMint,
    )]
    pub ovault_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = ALLOWED_MINTS.contains(&mint.key()) @ OrbitError::InvalidTokenMint,
        constraint = mint.key() == zov_token_account.mint @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, constraint = manager.key() == MANAGER @ OrbitError::UnauthorizedManager)]
    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    /// CHECK: zynk-core program (for CPI)
    pub zynk_core_program: Program<'info, ZynkCore>,

    // --- Replenish CPI accounts ---
    /// CHECK: zynk-core config PDA
    #[account(mut)]
    pub core_config: UncheckedAccount<'info>,

    /// CHECK: zynk-core order tracker PDA (existing, updated by replenish)
    #[account(mut)]
    pub core_order_tracker: UncheckedAccount<'info>,

    /// CHECK: zynk-core partner deposit vault PDA
    pub core_partner_deposit_vault: UncheckedAccount<'info>,

    /// CHECK: zynk-core PDV token account (source for replenish)
    #[account(mut)]
    pub core_pdv_token_account: UncheckedAccount<'info>,

    // --- Transient CreateOrder CPI accounts ---
    /// CHECK: zynk-core ZOV PDA (derived with zynk-core's ZYNK_OP_VAULT_SEED + zov_id)
    pub core_zynk_op_vault: UncheckedAccount<'info>,

    /// CHECK: zynk-core transient order tracker PDA (created and closed by create_order)
    #[account(mut)]
    pub core_transient_order_tracker: UncheckedAccount<'info>,

    // --- Ovault PDA (signer for ovault → position transfers, and beneficiary for transient create_order) ---
    /// CHECK: Ovault - verified by seeds. Must be whitelisted as a beneficiary in zynk-core with allow_transient=true.
    #[account(
        seeds = [VAULT_SEED, b"orbit"],
        bump
    )]
    pub ovault: UncheckedAccount<'info>,
    // Remaining accounts (3 per position):
    // [destination_token_account, record, position_pda]
}

#[derive(Accounts)]
#[instruction(vault_id: [u8; 32])]
pub struct Disburse<'info> {
    #[account(mut)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = destination_token_account.owner == record.primary_account @ OrbitError::InvalidAccount)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Vault PDA - verified by seeds, acts as the transfer authority
    #[account(
        seeds = [VAULT_SEED, vault_id.as_ref()],
        bump
    )]
    pub spender: UncheckedAccount<'info>,

    #[account(mut)]
    pub record: Account<'info, Record>,

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
#[instruction(user_id: [u8; 32], primary_account: Pubkey)]
pub struct Whitelist<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Record::INIT_SPACE,
        seeds = [RECORD_SEED, user_id.as_ref(), primary_account.as_ref()],
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
#[instruction(user_id: [u8; 32], primary_account: Pubkey)]
pub struct UpdateCliffPeriod<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + UpdateCliffPeriodRequest::INIT_SPACE,
        seeds = [RECORD_UPDATE_REQUEST_SEED, user_id.as_ref(), primary_account.as_ref()],
        bump
    )]
    pub request_record: Account<'info, UpdateCliffPeriodRequest>,

    #[account(
        seeds = [RECORD_SEED, user_id.as_ref(), primary_account.as_ref()],
        bump,
        constraint = user_record.primary_account == primary_account @ OrbitError::InvalidAccount,
    )]
    pub user_record: Account<'info, Record>,

    #[account(mut, constraint = user.key() == primary_account @ OrbitError::UnauthorizedAdmin)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32], primary_account: Pubkey)]
pub struct UpdateMaxDeposit<'info> {
    #[account(
        mut,
        seeds = [RECORD_SEED, user_id.as_ref(), primary_account.as_ref()],
        bump,
    )]
    pub record: Account<'info, Record>,

    #[account(mut, constraint = admin.key() == ADMIN @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32], primary_account: Pubkey, destination: Pubkey)]
pub struct RequestWithdraw<'info> {
    #[account(
        seeds = [RECORD_SEED, user_id.as_ref(), primary_account.as_ref()],
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
        seeds = [WITHDRAW_REQUEST_SEED, user_id.as_ref(), primary_account.as_ref()],
        bump
    )]
    pub withdraw_request: Account<'info, WithdrawRequest>,

    #[account(mut, constraint = signer.key() == primary_account @ OrbitError::InvalidAccount)]
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

    /// CHECK: primary wallet from the request - receives lamports from closed account
    #[account(mut)]
    pub primary_account: UncheckedAccount<'info>,

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

    /// CHECK: primary wallet from the request - receives lamports from closed account
    #[account(mut)]
    pub primary_account: UncheckedAccount<'info>,

    #[account(mut, constraint = admin.key() == ADMIN @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct Claim<'info> {
    #[account(
        mut,
        seeds = [RECORD_SEED, user_id.as_ref(), signer.key().as_ref()],
        bump,
        constraint = record.user_type == UserType::ICV @ OrbitError::InvalidOperation,
    )]
    pub record: Account<'info, Record>,

    /// ICV token account — owned by Record PDA, holds all deposited funds
    #[account(mut)]
    pub icv_token_account: InterfaceAccount<'info, TokenAccount>,

    /// aux account token account — destination for claimed funds
    #[account(mut)]
    pub aux_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = ALLOWED_MINTS.contains(&mint.key()) @ OrbitError::InvalidTokenMint,
        constraint = mint.key() == icv_token_account.mint @ OrbitError::InvalidTokenMint,
        constraint = mint.key() == aux_token_account.mint @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
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
    #[msg("Total position amounts do not match borrow amount")]
    AmountMismatch,
    #[msg("Invalid request account type")]
    InvalidRequestAccount,
    #[msg("Positions list cannot be empty")]
    EmptyPositions,
    #[msg("LPs are not authorized to borrow")]
    UnauthorizedBorrower,
    #[msg("Invalid position operation")]
    InvalidPositionOperation,
    #[msg("Position order IDs do not match")]
    PositionOrderMismatch,
    #[msg("Cliff period is over, operation not permitted")]
    CliffPeriodOver,
    #[msg("Cliff period is not over yet")]
    CliffPeriodNotOver,
    #[msg("Deposit would exceed max deposit cap")]
    MaxDepositExceeded,
}

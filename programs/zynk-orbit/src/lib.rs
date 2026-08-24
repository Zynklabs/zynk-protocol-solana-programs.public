use anchor_lang::prelude::*;
use anchor_lang::solana_program::{pubkey::Pubkey, system_program::ID as SYSTEM_PROGRAM_ID};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use zynk_core::{self, cpi::accounts::CreateOrder, program::ZynkCore, EventArg};

declare_id!("ZYNKopsYjG6gaGqdwz8HLAgvCAEFwCET56kRQKkjxfc");

pub const DOMAIN_SEPARATOR: u64 = 115131153410997;

pub const ZOV: Pubkey = pubkey!("2FUNdgyGtGQAffBJ1UYPZrhgu4FSUStsohEzkPbUctnu");

pub const VAULT_SEED: &[u8] = b"vault";
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

/// Action to perform on the partner whitelist.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum WhitelistAction {
    Add,
    Remove,
}

#[account]
pub struct Record {
    pub wallets: [Pubkey; 3],          // 96 bytes (3 × 32)
    pub user_id: [u8; 32],             // 32 bytes
    pub user_type: UserType,           // 1  byte  (repr u8)
    pub cliff_period: i64,             // 8  bytes
    pub principle_in: u64,             // 8  bytes
    pub principle_out: u64,            // 8  bytes
    pub max_deposit: u32,              // 4  bytes
    pub whitelisted_partners: Vec<u32>, // 4-byte length prefix + (len × 4) bytes
}

impl Record {
    /// Fixed byte cost of every field except the vector's element storage:
    ///   8   discriminator
    /// + 96  wallets ([Pubkey; 3])
    /// + 32  user_id
    /// + 1   user_type
    /// + 8   cliff_period
    /// + 8   principle_in
    /// + 8   principle_out
    /// + 4   max_deposit
    /// + 4   Vec<u32> length prefix
    /// = 169 bytes
    pub const BASE_SIZE: usize = 8 + 96 + 32 + 1 + 8 + 8 + 8 + 4 + 4;

    /// Total account space required to hold exactly `len` partner IDs.
    /// Each `u32` partner ID occupies 4 bytes.
    #[inline]
    pub fn space_for_len(len: usize) -> usize {
        Self::BASE_SIZE + len * 4
    }
}

#[account]
#[derive(InitSpace)]
pub struct WithdrawRequest {
    pub user_id: [u8; 32],
    pub amount: u32,
    pub destination: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct UpdateCliffPeriodRequest {
    pub user_id: [u8; 32],
    pub cliff_period: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub order_id: [u8; 32],
    pub partner_id: [u8; 32],
    pub amount_borrowed: u64,
    pub amount_repaid: u64,
    pub user_id: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PositionOperation {
    pub amount: u64,
    pub vault_id: [u8; 32],
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
    pub order_id: [u8; 32],
}

#[event]
pub struct AxEvent {
    pub event_name: String,
    pub user_id: [u8; 32],
    pub public_key: Pubkey,
    pub domain_separator: u64,
    pub partners: Vec<u32>,
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

/// Returns true if `wallet` is present in `record.wallets`.
fn is_whitelisted_wallet(record: &Record, wallet: &Pubkey) -> bool {
    record.wallets.contains(wallet)
}

/// Extracts the 6-digit numeric partner ID from a partner_id string.
/// E.g., "zp_123456:context" -> 123456u32
fn extract_partner_number(partner_id: &str) -> Result<u32> {
    let base = if let Some(colon_idx) = partner_id.find(':') {
        &partner_id[..colon_idx]
    } else {
        partner_id
    };
    // base is e.g. "zp_123456"
    // Strip the "zp_" prefix and parse the remaining digits
    let digits = base
        .strip_prefix("zp_")
        .ok_or(OrbitError::InvalidPartnerId)?;
    require!(digits.len() == 6, OrbitError::InvalidPartnerId);
    let num = digits
        .parse::<u32>()
        .map_err(|_| OrbitError::InvalidPartnerId)?;
    Ok(num)
}

/// Transfers tokens from a source to a destination using a PDA authority with signer seeds.
fn transfer_with_signer<'info>(
    token_program: &Interface<'info, TokenInterface>,
    source_token_account: &AccountInfo<'info>,
    destination_token_account: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    let cpi_accounts = TransferChecked {
        from: source_token_account.to_account_info(),
        to: destination_token_account.to_account_info(),
        mint: mint.to_account_info(),
        authority: authority.to_account_info(),
    };

    let cpi_ctx =
        CpiContext::new_with_signer(token_program.to_account_info(), cpi_accounts, signer_seeds);
    token_interface::transfer_checked(cpi_ctx, amount, mint.decimals)
}

/// Reads and validates the zynk-core Config account from a cross-program PDA.
/// Derives the expected PDA from zynk-core's CONFIG_SEED + program ID,
/// validates the provided account matches, and deserializes into Config.
fn read_core_config<'info>(
    core_config: &AccountInfo<'info>,
    zynk_core_program_id: &Pubkey,
) -> Result<zynk_core::Config> {
    let (expected_pda, _) =
        Pubkey::find_program_address(&[zynk_core::CONFIG_SEED], zynk_core_program_id);
    require!(
        core_config.key() == expected_pda,
        OrbitError::InvalidCoreConfig
    );
    let data = core_config.try_borrow_data()?;
    zynk_core::Config::try_deserialize(&mut &data[..])
        .map_err(|_| error!(OrbitError::InvalidCoreConfig))
}

#[program]
pub mod zynk_orbit {
    use super::*;

    // External (whitelisted) signers -> ZOV (for LP) or Record PDA token account (for ICV)
    pub fn deposit(ctx: Context<Deposit>, user_id: [u8; 32], amount: u64) -> Result<()> {
        require!(amount != 0, OrbitError::ZeroAmount);

        // Validate token mint against zynk-core's whitelisted token mints
        let config = read_core_config(&ctx.accounts.core_config, &ctx.accounts.zynk_core_program.key())?;
        require!(
            config.whitelisted_token_mints.contains(&ctx.accounts.mint.key()),
            OrbitError::InvalidTokenMint
        );

        let record = &ctx.accounts.record;

        // Verify the signer is one of the whitelisted wallets on this record
        require!(
            is_whitelisted_wallet(record, &ctx.accounts.signer.key()),
            OrbitError::InvalidAccount
        );

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
            event_name: "Deposit".to_string(),
            user_id,
            from_owner: ctx.accounts.source_token_account.owner.key(),
            to_owner: ctx.accounts.destination_token_account.owner.key(),
            from: ctx.accounts.source_token_account.key(),
            to: ctx.accounts.destination_token_account.key(),
            amount,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id: [0u8; 32],
        });

        Ok(())
    }

    // Borrow from multiple sources (NCW wallets or ICV Record PDAs) into ZOV,
    // create a single order in zynk-core, and create Position PDAs for each source.
    pub fn borrow<'info>(
        ctx: Context<'_, '_, '_, 'info, Borrow<'info>>,
        partner_id: String,
        order_id: [u8; 32],
        zov_id: [u8; 32],
        amount: u64,
        positions: Vec<PositionOperation>,
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        require!(amount > 0, OrbitError::ZeroAmount);

        // Validate manager against zynk-core config
        let config = read_core_config(&ctx.accounts.core_config, &ctx.accounts.zynk_core_program.key())?;
        require!(
            ctx.accounts.manager.key() == config.manager,
            OrbitError::UnauthorizedManager
        );

        // Validate token mint against zynk-core's whitelisted token mints
        require!(
            config.whitelisted_token_mints.contains(&ctx.accounts.mint.key()),
            OrbitError::InvalidTokenMint
        );

        // Parse partner_id: extract the numeric portion (e.g., "zp_123456:onramp" -> 123456)
        // for whitelist check. The full partner_id string is hashed for the create_order CPI.
        let partner_number = extract_partner_number(&partner_id)?;
        let partner_id_bytes =
            anchor_lang::solana_program::hash::hash(partner_id.as_bytes()).to_bytes();

        // Pre-validate amounts and sum them up.
        // LP/NCW/ICV type validation is deferred to per-position processing
        // where record data is available.
        let mut total_position_amount: u64 = 0;
        for pos in &positions {
            require!(pos.amount > 0, OrbitError::ZeroAmount);
            total_position_amount = total_position_amount
                .checked_add(pos.amount)
                .ok_or(ProgramError::ArithmeticOverflow)?;
        }

        // Verify the total of all position amounts is less than or equal to the borrow amount
        require!(total_position_amount <= amount, OrbitError::AmountMismatch);

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

            // Deserialise record and capture all fields needed later before dropping the borrow.
            let (record_user_id, record_user_type) = {
                let record_data = record_account.data.borrow();
                let record = Record::try_deserialize(&mut &record_data[..])
                    .map_err(|_| OrbitError::InvalidAccount)?;

                // Check partner whitelist: if whitelisted_partners is non-empty,
                // verify partner_number is present.
                if !record.whitelisted_partners.is_empty() {
                    require!(
                        record.whitelisted_partners.contains(&partner_number),
                        OrbitError::PartnerNotWhitelisted
                    );
                }

                (record.user_id, record.user_type)
                // record_data Ref is dropped here
            };

            // Validate that this position is not an LP borrow.
            require!(
                record_user_type != UserType::LP,
                OrbitError::UnauthorizedBorrower
            );

            // Derive authority seeds, validate, and transfer based on user type
            match record_user_type {
                UserType::NCW => {
                    let seeds: &[&[u8]] = &[VAULT_SEED, pos.vault_id.as_ref()];
                    let (expected_authority, bump) =
                        Pubkey::find_program_address(seeds, ctx.program_id);
                    require!(
                        authority_account.key() == expected_authority,
                        OrbitError::InvalidAccount
                    );

                    // Deserialize the SPL token account data to read its authority (owner field).
                    // AccountInfo.owner is the Token Program address, not the token account's authority.
                    // The authority is stored inside the account data at bytes 32–64.
                    let src_token_authority = {
                        let data = source_token_account.try_borrow_data()?;
                        let token_account = TokenAccount::try_deserialize_unchecked(&mut &data[..])
                            .map_err(|_| OrbitError::InvalidAccount)?;
                        token_account.owner
                    };

                    // Verify the source token account is owned by this vault authority
                    require!(
                        src_token_authority == expected_authority,
                        OrbitError::InvalidAccount
                    );

                    let seeds_with_bump: &[&[u8]] = &[VAULT_SEED, pos.vault_id.as_ref(), &[bump]];
                    let signer_seeds = &[&seeds_with_bump[..]];
                    transfer_with_signer(
                        &ctx.accounts.token_program,
                        source_token_account,
                        &ctx.accounts.zov_token_account.to_account_info(),
                        &ctx.accounts.mint,
                        authority_account,
                        signer_seeds,
                        pos.amount,
                    )?;
                }
                UserType::ICV => {
                    let seeds: &[&[u8]] = &[
                        RECORD_SEED,
                        record_user_id.as_ref(),
                    ];
                    let (expected_authority, bump) =
                        Pubkey::find_program_address(seeds, ctx.program_id);
                    require!(
                        authority_account.key() == expected_authority,
                        OrbitError::InvalidAccount
                    );

                    let seeds_with_bump: &[&[u8]] = &[
                        RECORD_SEED,
                        record_user_id.as_ref(),
                        &[bump],
                    ];
                    let signer_seeds = &[&seeds_with_bump[..]];
                    transfer_with_signer(
                        &ctx.accounts.token_program,
                        source_token_account,
                        &ctx.accounts.zov_token_account.to_account_info(),
                        &ctx.accounts.mint,
                        authority_account,
                        signer_seeds,
                        pos.amount,
                    )?;
                }
                UserType::LP => {
                    return Err(OrbitError::UnauthorizedBorrower.into());
                }
            };

            // Create the Position PDA using [POSITION_SEED, order_id, user_id]
            let position_seeds: &[&[u8]] = &[
                POSITION_SEED,
                order_id.as_ref(),
                record_user_id.as_ref(),
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
                record_user_id.as_ref(),
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
            let position_account = Position {
                order_id,
                partner_id: partner_id_bytes,
                amount_borrowed: pos.amount,
                amount_repaid: 0,
                user_id: record_user_id,
            };
            position_account.try_serialize(&mut &mut position_data[..])?;
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
        };

        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        zynk_core::cpi::create_order(
            cpi_ctx,
            partner_id_bytes,
            order_id,
            zov_id,
            false, // transient = false
            amount,
            meta,
        )?;

        emit!(TxEvent {
            event_name: "Borrow".to_string(),
            user_id: [0u8; 32],
            from_owner: ZOV,
            to_owner: ZOV,
            from: ctx.accounts.zov_token_account.key(),
            to: ctx.accounts.zov_token_account.key(),
            amount,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id,
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
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        // Derive the number of positions from remaining_accounts (3 accounts per position:
        // [destination_token_account, record, position_pda])
        let num_positions = ctx.remaining_accounts.len() / 3;
        require!(num_positions > 0, OrbitError::EmptyPositions);
        require!(
            ctx.remaining_accounts.len() % 3 == 0,
            OrbitError::InvalidPositionOperation
        );
        require!(amount > 0, OrbitError::ZeroAmount);

        // Validate manager against zynk-core config
        let config = read_core_config(&ctx.accounts.core_config, &ctx.accounts.zynk_core_program.key())?;
        require!(
            ctx.accounts.manager.key() == config.manager,
            OrbitError::UnauthorizedManager
        );

        // Validate token mint against zynk-core's whitelisted token mints
        require!(
            config.whitelisted_token_mints.contains(&ctx.accounts.mint.key()),
            OrbitError::InvalidTokenMint
        );

        // LP/NCW/ICV type validation is deferred to per-position processing
        // where record data (from remaining_accounts) is available.

        // Read the order tracker to determine remaining order amount
        let order_tracker_data = ctx.accounts.core_order_tracker.try_borrow_data()?;
        // Skip 8-byte discriminator
        let order_tracker = zynk_core::OrderTracker::try_deserialize(&mut &order_tracker_data[..])
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
            beneficiary: ctx.accounts.ovaults_beneficiary_pda.to_account_info(),
            beneficiary_token_account: ctx.accounts.ovault_token_account.to_account_info(),
            order_tracker: ctx.accounts.core_transient_order_tracker.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
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

        // First pass: validate all records and positions, cache user_type and remaining amount.
        // Second pass: distribute shares and execute transfers using cached data.
        struct PositionInfo {
            user_type: UserType,
            record_key: Pubkey,
            remaining: u64,
            share: u64,
        }
        let mut position_infos = Vec::with_capacity(num_positions);

        for i in 0..num_positions {
            let base_idx = i * 3;
            let _dst_token_account: &AccountInfo = &remaining_accounts[base_idx];
            let record_account: &AccountInfo = &remaining_accounts[base_idx + 1];
            let position_pda: &AccountInfo = &remaining_accounts[base_idx + 2];

            // Verify the record account
            let record_data = record_account.data.borrow();
            let record = Record::try_deserialize(&mut &record_data[..])
                .map_err(|_| OrbitError::InvalidAccount)?;
            let record_user_type = record.user_type;
            let record_key = record_account.key();
            drop(record_data);

            // Validate that this position is not an LP repay.
            require!(
                record_user_type != UserType::LP,
                OrbitError::UnauthorizedBorrower
            );

            // Verify the position PDA
            let position_data = position_pda.data.borrow();
            let position = Position::try_deserialize(&mut &position_data[..])
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

            position_infos.push(PositionInfo {
                user_type: record_user_type,
                record_key,
                remaining,
                share: 0,
            });
        }

        // Step 4: Distribute prepared_amount across positions using ceiling-based algorithm.
        // share = ceil(amount * position.remaining / remaining_total)
        let mut remaining_amount = prepared_amount;
        for info in position_infos.iter_mut() {
            //Ceiling division
            let share = if prepared_amount > 0 {
                let numerator = prepared_amount
                    .checked_mul(info.remaining)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
                let raw_share = (numerator + remaining_order - 1)
                    .checked_div(remaining_order)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
                raw_share.min(info.remaining).min(remaining_amount)
            } else {
                0
            };
            remaining_amount = remaining_amount.checked_sub(share).ok_or(ProgramError::ArithmeticOverflow)?;

            info.share = share;
        }

        // Step 5: Transfer from ovault to each position and update/close Position PDAs
        let ovault_seeds: &[&[u8]] = &[VAULT_SEED, b"orbit", &[ctx.bumps.ovault]];
        let ovault_signer_seeds = &[&ovault_seeds[..]];

        for i in 0..num_positions {
            let base_idx = i * 3;
            let dst_token_account: &AccountInfo = &remaining_accounts[base_idx];
            let position_pda: &AccountInfo = &remaining_accounts[base_idx + 2];

            let info = &position_infos[i];
            if info.share == 0 {
                continue;
            }

            // Deserialize the SPL token account data to read its authority (owner field).
            // AccountInfo.owner is the Token Program address, not the token account's authority.
            // The authority is stored inside the account data at bytes 32–64.
            let dst_token_authority = {
                let data = dst_token_account.try_borrow_data()?;
                let token_account = TokenAccount::try_deserialize_unchecked(&mut &data[..])
                    .map_err(|_| OrbitError::InvalidAccount)?;
                token_account.owner
            };

            // Verify destination based on user type (from cached record data in PositionInfo)
            match info.user_type {
                UserType::NCW => {
                    // NCW: destination token account must be owned by one of the record's
                    // whitelisted wallets. Read wallets from the record account.
                    let record_account: &AccountInfo = &remaining_accounts[base_idx + 1];
                    let record_data = record_account.data.borrow();
                    let record = Record::try_deserialize(&mut &record_data[..])
                        .map_err(|_| OrbitError::InvalidAccount)?;
                    require!(
                        is_whitelisted_wallet(&record, &dst_token_authority),
                        OrbitError::InvalidAccount
                    );
                }
                UserType::ICV => {
                    // ICV: destination token account must be owned by the Record PDA
                    require!(
                        dst_token_authority == info.record_key,
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

            // Update the Position PDA — deserialize, mutate, re-serialize in place.
            let is_position_closed = {
                let mut position_data = position_pda.try_borrow_mut_data()?;
                let mut position =
                    Position::try_deserialize_unchecked(&mut &position_data[..])?;
                position.amount_repaid = position
                    .amount_repaid
                    .checked_add(info.share)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
                let closed = position.amount_repaid >= position.amount_borrowed;
                position.try_serialize(&mut &mut position_data[..])?;
                closed
            };

            // Close the Position PDA if fully repaid
            if is_position_closed {
                close_account(position_pda, &ctx.accounts.manager)?;
            }
        }

        emit!(TxEvent {
            event_name: "Repay".to_string(),
            user_id: [0u8; 32],
            from_owner: ZOV,
            to_owner: ctx.accounts.ovault.key(),
            from: ctx.accounts.zov_token_account.key(),
            to: ctx.accounts.ovault_token_account.key(),
            amount: prepared_amount,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id,
        });

        Ok(())
    }

    // ICV users claim their deposited funds after the cliff period is over.
    // Transfers all funds from the ICV token account (owned by Record PDA) to the
    // destination token account (owned by one of record.wallets).
    //
    // TODO: In a future iteration, incorporate pull+repay to settle outstanding
    // borrowed positions before transferring ICV funds to destination. This will
    // require:
    //  - CPI to zynk_core::pull_and_repay
    //  - Closing the position PDA if fully repaid
    // Currently, claim only transfers funds held in the ICV token account directly
    // to the destination token account.
    pub fn claim(ctx: Context<Claim>, user_id: [u8; 32]) -> Result<()> {
        let record = &ctx.accounts.record;

        // Validate token mint against zynk-core's whitelisted token mints
        let config = read_core_config(&ctx.accounts.core_config, &ctx.accounts.zynk_core_program.key())?;
        require!(
            config.whitelisted_token_mints.contains(&ctx.accounts.mint.key()),
            OrbitError::InvalidTokenMint
        );

        // Verify the signer is one of the whitelisted wallets on this record
        require!(
            is_whitelisted_wallet(record, &ctx.accounts.signer.key()),
            OrbitError::InvalidAccount
        );

        // Verify cliff period is over
        let now = Clock::get()?.unix_timestamp;
        require!(now >= record.cliff_period, OrbitError::CliffPeriodNotOver);

        // Verify that the ICV token account is owned by the Record PDA
        require!(
            ctx.accounts.icv_token_account.owner == record.key(),
            OrbitError::InvalidAccount
        );

        // Verify destination token account belongs to one of record.wallets
        require!(
            is_whitelisted_wallet(record, &ctx.accounts.destination_token_account.owner),
            OrbitError::InvalidAccount
        );

        // Transfer ALL funds from ICV token account to destination
        let icv_balance = ctx.accounts.icv_token_account.amount;
        require!(icv_balance > 0, OrbitError::ZeroAmount);

        let seeds: &[&[u8]] = &[
            RECORD_SEED,
            user_id.as_ref(),
            &[ctx.bumps.record],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.icv_token_account.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
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
            event_name: "Claim".to_string(),
            user_id,
            from_owner: ctx.accounts.record.key(),
            to_owner: ctx.accounts.destination_token_account.owner,
            from: ctx.accounts.icv_token_account.key(),
            to: ctx.accounts.destination_token_account.key(),
            amount: icv_balance,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id: [0u8; 32],
        });

        Ok(())
    }

    // Disburse funds from any PDA vault to a whitelisted record wallet.
    // The vault PDA is derived from [VAULT_SEED, vault_id] and acts as the transfer authority.
    pub fn disburse(ctx: Context<Disburse>, vault_id: [u8; 32], amount: u64) -> Result<()> {
        let record = &mut ctx.accounts.record;

        // Validate manager against zynk-core config
        let config = read_core_config(&ctx.accounts.core_config, &ctx.accounts.zynk_core_program.key())?;
        require!(
            ctx.accounts.manager.key() == config.manager,
            OrbitError::UnauthorizedManager
        );

        // Validate token mint against zynk-core's whitelisted token mints
        require!(
            config.whitelisted_token_mints.contains(&ctx.accounts.mint.key()),
            OrbitError::InvalidTokenMint
        );

        // Verify destination token account is owned by one of the record's whitelisted wallets
        require!(
            is_whitelisted_wallet(record, &ctx.accounts.destination_token_account.owner),
            OrbitError::InvalidAccount
        );

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
            event_name: "Disburse".to_string(),
            user_id: record.user_id,
            from_owner: ctx.accounts.source_token_account.owner.key(),
            to_owner: ctx.accounts.destination_token_account.owner.key(),
            from: ctx.accounts.source_token_account.key(),
            to: ctx.accounts.destination_token_account.key(),
            amount,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id: [0u8; 32],
        });

        Ok(())
    }

    pub fn whitelist(
        ctx: Context<Whitelist>,
        user_id: [u8; 32],
        user_type: UserType,
        wallets: [Pubkey; 3],
        cliff_period: Option<i64>,
        max_deposit: Option<u32>,
    ) -> Result<()> {
        // Validate admin signer against zynk-core config.
        let config = read_core_config(&ctx.accounts.core_config, &ctx.accounts.zynk_core_program.key())?;
        require!(
            ctx.accounts.admin.key() == config.admin,
            OrbitError::UnauthorizedAdmin
        );

        let record = &mut ctx.accounts.record;

        // Validate cliff_period is in the future if provided.
        if let Some(cp) = cliff_period {
            let now = Clock::get()?.unix_timestamp;
            require!(cp > now, OrbitError::CliffPeriodInPast);
        }

        record.wallets = wallets;
        record.user_id = user_id;
        record.user_type = user_type;
        record.cliff_period = cliff_period.unwrap_or(i64::MAX);
        record.principle_in = 0;
        record.principle_out = 0;
        record.max_deposit = max_deposit.unwrap_or(u32::MAX);
        // Always start with an empty whitelist; add partners via
        // update_partner_whitelist, which reallocs the account on demand.
        record.whitelisted_partners = Vec::new();

        emit!(AxEvent {
            event_name: "Whitelist".to_string(),
            user_id,
            public_key: wallets[0],
            domain_separator: DOMAIN_SEPARATOR,
            partners: Vec::new(),
        });

        Ok(())
    }

    /// Update the whitelisted wallets array for a user's record.
    /// Only the admin can call this.
    pub fn update_wallets(
        ctx: Context<UpdateWallets>,
        user_id: [u8; 32],
        wallets: [Pubkey; 3],
    ) -> Result<()> {
        // Validate admin signer against zynk-core config.
        let config = read_core_config(&ctx.accounts.core_config, &ctx.accounts.zynk_core_program.key())?;
        require!(
            ctx.accounts.admin.key() == config.admin,
            OrbitError::UnauthorizedAdmin
        );

        let record = &mut ctx.accounts.record;
        record.wallets = wallets;

        emit!(AxEvent {
            event_name: "WalletsUpdated".to_string(),
            user_id,
            public_key: wallets[0],
            domain_separator: DOMAIN_SEPARATOR,
            partners: Vec::new(),
        });

        Ok(())
    }

    pub fn update_partner_whitelist(
        ctx: Context<UpdatePartnerWhitelist>,
        user_id: [u8; 32],
        action: WhitelistAction,
        partner_id: u32,
    ) -> Result<()> {
        // Validate admin signer against zynk-core config.
        let config = read_core_config(&ctx.accounts.core_config, &ctx.accounts.zynk_core_program.key())?;
        require!(
            ctx.accounts.admin.key() == config.admin,
            OrbitError::UnauthorizedAdmin
        );

        let record = &mut ctx.accounts.record;

        match action {
            WhitelistAction::Add => {
                // Prevent duplicates — realloc already grew the buffer; an
                // early error here lets Solana roll the whole tx back cleanly.
                require!(
                    !record.whitelisted_partners.contains(&partner_id),
                    OrbitError::PartnerAlreadyWhitelisted
                );
                record.whitelisted_partners.push(partner_id);
            }
            WhitelistAction::Remove => {
                // locate the element; error if it doesn't exist.
                let pos = record
                    .whitelisted_partners
                    .iter()
                    .position(|&id| id == partner_id)
                    .ok_or(OrbitError::PartnerNotWhitelisted)?;
                // swap_remove is O(1) and order doesn't matter for a whitelist.
                record.whitelisted_partners.swap_remove(pos);
            }
        }

        emit!(AxEvent {
            event_name: "UpdatePartnerWhitelist".to_string(),
            user_id,
            public_key: record.wallets[0],
            domain_separator: DOMAIN_SEPARATOR,
            partners: record.whitelisted_partners.clone(),
        });

        Ok(())
    }

    pub fn revoke(ctx: Context<Revoke>) -> Result<()> {
        // Validate admin signer against zynk-core config
        let config = read_core_config(&ctx.accounts.core_config, &ctx.accounts.zynk_core_program.key())?;
        require!(
            ctx.accounts.admin.key() == config.admin,
            OrbitError::UnauthorizedAdmin
        );

        macro_rules! try_revoke {
            ($data:expr, $pda_key:expr, $ty:ty, $event:expr) => {
                if let Ok(account) = <$ty>::try_deserialize(&mut &$data[..]) {
                    emit!(AxEvent {
                        event_name: $event.to_string(),
                        user_id: account.user_id,
                        public_key: $pda_key,
                        domain_separator: DOMAIN_SEPARATOR,
                        partners: Vec::new(),
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
                    let _ = try_revoke!(data, pda_key, Record, "RevokeWhitelist")
                        || try_revoke!(data, pda_key, WithdrawRequest, "RevokeWithdrawRequest")
                        || try_revoke!(
                            data,
                            pda_key,
                            UpdateCliffPeriodRequest,
                            "DenyUpdateRequest"
                        );
                }
                // `data` (Ref<[u8]>) is dropped here — RefCell is fully released
            }

            close_account(account_info, &ctx.accounts.admin)?;
        }

        Ok(())
    }

    pub fn update_cliff_period(
        ctx: Context<UpdateCliffPeriod>,
        user_id: [u8; 32],
        cliff_period: Option<i64>,
    ) -> Result<()> {
        // Validate admin signer against zynk-core config
        let config = read_core_config(&ctx.accounts.core_config, &ctx.accounts.zynk_core_program.key())?;
        require!(
            ctx.accounts.admin.key() == config.admin,
            OrbitError::UnauthorizedAdmin
        );

        let now = Clock::get()?.unix_timestamp;
        let resolved_cliff = cliff_period.unwrap_or(ctx.accounts.user_record.cliff_period);
        require!(resolved_cliff > now, OrbitError::CliffPeriodInPast);

        let request_record = &mut ctx.accounts.request_record;
        request_record.user_id = user_id;
        request_record.cliff_period = resolved_cliff;

        emit!(AxEvent {
            event_name: "CliffPeriodUpdated".to_string(),
            user_id,
            public_key: ctx.accounts.user_record.wallets[0],
            domain_separator: DOMAIN_SEPARATOR,
            partners: Vec::new(),
        });
        Ok(())
    }

    pub fn update_max_deposit(
        ctx: Context<UpdateMaxDeposit>,
        user_id: [u8; 32],
        max_deposit: u32,
    ) -> Result<()> {
        // Validate admin signer against zynk-core config
        let config = read_core_config(&ctx.accounts.core_config, &ctx.accounts.zynk_core_program.key())?;
        require!(
            ctx.accounts.admin.key() == config.admin,
            OrbitError::UnauthorizedAdmin
        );

        let record = &mut ctx.accounts.record;

        // When reducing max_deposit, ensure it does not go below the current net balance
        let net_balance = record
            .principle_in
            .checked_sub(record.principle_out)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        require!(
            max_deposit as u64 >= net_balance,
            OrbitError::MaxDepositBelowBalance
        );

        record.max_deposit = max_deposit;

        emit!(AxEvent {
            event_name: "MaxDepositUpdated".to_string(),
            user_id,
            public_key: record.wallets[0],
            domain_separator: DOMAIN_SEPARATOR,
            partners: Vec::new(),
        });
        Ok(())
    }

    pub fn request_withdraw(
        ctx: Context<RequestWithdraw>,
        user_id: [u8; 32],
        destination: Pubkey,
        amount: u32,
    ) -> Result<()> {
        require!(amount != 0, OrbitError::ZeroAmount);

        let signer_record = &ctx.accounts.signer_record;
        // NCW users are not permitted to raise withdraw requests
        require!(
            signer_record.user_type != UserType::NCW,
            OrbitError::InvalidOperation
        );

        // Verify signer is one of the whitelisted wallets on the signer record
        require!(
            is_whitelisted_wallet(signer_record, &ctx.accounts.signer.key()),
            OrbitError::InvalidAccount
        );
        // Make sure that destination is whitelisted
        require!(
            is_whitelisted_wallet(signer_record, &destination),
            OrbitError::InvalidAccount
        );

        require!(
            signer_record
                .principle_in
                .checked_sub(signer_record.principle_out)
                .ok_or(ProgramError::ArithmeticOverflow)?
                >= amount as u64,
            OrbitError::InsufficientBalance
        );

        let withdraw_request = &mut ctx.accounts.withdraw_request;
        withdraw_request.user_id = user_id;
        withdraw_request.amount = amount;
        withdraw_request.destination = destination;

        emit!(AxEvent {
            event_name: "WithdrawRequested".to_string(),
            user_id,
            public_key: ctx.accounts.signer.key(),
            domain_separator: DOMAIN_SEPARATOR,
            partners: Vec::new(),
        });
        Ok(())
    }

    pub fn approve_withdraw(
        ctx: Context<ApproveWithdraw>,
        user_id: [u8; 32],
    ) -> Result<()> {
        // Validate admin signer against zynk-core config
        let config = read_core_config(&ctx.accounts.core_config, &ctx.accounts.zynk_core_program.key())?;
        require!(
            ctx.accounts.admin.key() == config.admin,
            OrbitError::UnauthorizedAdmin
        );

        let request_data = ctx.accounts.request.try_borrow_data()?;
        let withdraw_request = WithdrawRequest::try_deserialize(&mut &request_data[..])
            .map_err(|_| OrbitError::InvalidRequestAccount)?;
        drop(request_data);

        let record = &mut ctx.accounts.record;

        // Update principle_out on the record
        record.principle_out = record
            .principle_out
            .checked_add(withdraw_request.amount as u64)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        // Verify destination token account matches the withdraw request
        require!(
            ctx.accounts.destination_token_account.owner == withdraw_request.destination,
            OrbitError::InvalidAccount
        );

        // Verify the source token account holds enough tokens for the withdrawal
        require!(
            ctx.accounts.source_token_account.amount >= withdraw_request.amount as u64,
            OrbitError::InsufficientTokenBalance
        );

        // Handle transfer based on user type
        match record.user_type {
            UserType::ICV => {
                // For ICVs, transfer from the ICV token account (owned by Record PDA)
                // to the destination, using Record PDA seeds as authority
                require!(
                    ctx.accounts.source_token_account.owner == record.key(),
                    OrbitError::InvalidAccount
                );

                let seeds: &[&[u8]] = &[
                    RECORD_SEED,
                    user_id.as_ref(),
                    &[ctx.bumps.record],
                ];
                let signer_seeds = &[&seeds[..]];
                transfer_with_signer(
                    &ctx.accounts.token_program,
                    &ctx.accounts.source_token_account.to_account_info(),
                    &ctx.accounts.destination_token_account.to_account_info(),
                    &ctx.accounts.mint,
                    &ctx.accounts.record.to_account_info(),
                    signer_seeds,
                    withdraw_request.amount as u64,
                )?;
            }
            UserType::LP => {
                // For LPs transfer from ovault to destination
                let ovault = ctx
                    .accounts
                    .ovault
                    .as_ref()
                    .ok_or(OrbitError::InvalidAccount)?;
                let ovault_bump = ctx.bumps.ovault.ok_or(OrbitError::InvalidAccount)?;
                let ovault_bump_ref = [ovault_bump];
                let signer_seeds = &[&[VAULT_SEED, b"orbit", &ovault_bump_ref][..]];
                transfer_with_signer(
                    &ctx.accounts.token_program,
                    &ctx.accounts.source_token_account.to_account_info(),
                    &ctx.accounts.destination_token_account.to_account_info(),
                    &ctx.accounts.mint,
                    &ovault.to_account_info(),
                    signer_seeds,
                    withdraw_request.amount as u64,
                )?;
            }
            UserType::NCW => {
                return Err(OrbitError::InvalidOperation.into());
            }
        }

        // Close the withdraw request account, move lamports to admin
        close_account(
            ctx.accounts.request.to_account_info(),
            ctx.accounts.admin.to_account_info(),
        )?;

        emit!(TxEvent {
            event_name: "WithdrawApproved".to_string(),
            user_id,
            from_owner: ctx.accounts.source_token_account.owner.key(),
            to_owner: ctx.accounts.destination_token_account.owner.key(),
            from: ctx.accounts.source_token_account.key(),
            to: ctx.accounts.destination_token_account.key(),
            amount: withdraw_request.amount as u64,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id: [0u8; 32],
        });

        Ok(())
    }

    /// Reject (cancel) a pending withdraw request.
    /// Only the admin can reject a withdraw request.
    pub fn reject_withdraw(ctx: Context<RejectWithdraw>, user_id: [u8; 32]) -> Result<()> {
        // Validate admin signer against zynk-core config
        let config = read_core_config(&ctx.accounts.core_config, &ctx.accounts.zynk_core_program.key())?;
        require!(
            ctx.accounts.admin.key() == config.admin,
            OrbitError::UnauthorizedAdmin
        );

        // Close the WithdrawRequest PDA and return lamports to the admin
        close_account(
            ctx.accounts.request.to_account_info(),
            ctx.accounts.admin.to_account_info(),
        )?;

        emit!(AxEvent {
            event_name: "WithdrawRejected".to_string(),
            user_id,
            public_key: ctx.accounts.admin.key(),
            domain_separator: DOMAIN_SEPARATOR,
            partners: Vec::new(),
        });

        Ok(())
    }

    pub fn approve_cliff_period(ctx: Context<ApproveCliffPeriod>, user_id: [u8; 32]) -> Result<()> {
        // Validate that the request belongs to this user.

        let record = &mut ctx.accounts.record;

        // Verify signer is one of the whitelisted wallets on the record
        require!(
            is_whitelisted_wallet(record, &ctx.accounts.signer.key()),
            OrbitError::InvalidAccount
        );

        // Capture the new cliff period before the borrow ends
        let new_cliff_period = ctx.accounts.request.cliff_period;

        // Update the cliff period on the record
        record.cliff_period = new_cliff_period;

        // Close the update request account, move lamports to signer.
        close_account(
            ctx.accounts.request.to_account_info(),
            ctx.accounts.signer.to_account_info(),
        )?;

        emit!(AxEvent {
            event_name: "CliffPeriodApproved".to_string(),
            user_id: user_id,
            public_key: ctx.accounts.signer.key(),
            domain_separator: DOMAIN_SEPARATOR,
            partners: Vec::new(),
        });

        Ok(())
    }

    /// Reject (cancel) a pending cliff period update request.
    ///
    /// Any whitelisted wallet of the associated record may reject it.
    /// The UpdateCliffPeriodRequest PDA is closed and its rent-exempt
    /// lamports are returned to the signer.
    pub fn reject_cliff_period(ctx: Context<RejectCliffPeriod>, user_id: [u8; 32]) -> Result<()> {
        // Verify the signer is one of the whitelisted wallets on the record
        require!(
            is_whitelisted_wallet(&ctx.accounts.record, &ctx.accounts.signer.key()),
            OrbitError::InvalidAccount
        );

        // Close the UpdateCliffPeriodRequest PDA — return lamports to the signer
        close_account(
            ctx.accounts.request.to_account_info(),
            ctx.accounts.signer.to_account_info(),
        )?;

        emit!(AxEvent {
            event_name: "CliffPeriodRejected".to_string(),
            user_id,
            public_key: ctx.accounts.signer.key(),
            domain_separator: DOMAIN_SEPARATOR,
            partners: Vec::new(),
        });

        Ok(())
    }

    // Pledge: deposit yield back into the system. Same validations as deposit.
    // For LP: moves funds from ovault to ZOV (ovault PDA is the authority).
    // For ICV: moves funds from ovault to ICV's ATA (token account owned by Record PDA).
    pub fn pledge(
        ctx: Context<Pledge>,
        user_id: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        require!(amount != 0, OrbitError::ZeroAmount);

        // Validate manager against zynk-core config
        let config = read_core_config(&ctx.accounts.core_config, &ctx.accounts.zynk_core_program.key())?;
        require!(
            ctx.accounts.manager.key() == config.manager,
            OrbitError::UnauthorizedManager
        );

        // Validate token mint against zynk-core's whitelisted token mints
        require!(
            config.whitelisted_token_mints.contains(&ctx.accounts.mint.key()),
            OrbitError::InvalidTokenMint
        );

        let record = &ctx.accounts.record;

        // Only LPs and ICVs can pledge. NCWs cannot.
        require!(
            record.user_type != UserType::NCW,
            OrbitError::InvalidOperation
        );

        // Restrict pledge if cliff period is over
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

        // Validate destination and perform transfer based on user type.
        // Source is always ovault for both LP and ICV.
        // Anchor provides ctx.bumps.ovault from the seed-constrained account — no find_program_address needed.
        let ovault_bump_ref = [ctx.bumps.ovault];
        let signer_seeds = &[&[VAULT_SEED, b"orbit", &ovault_bump_ref][..]];

        match record.user_type {
            UserType::LP => {
                // LP pledge: move funds from ovault to ZOV
                require!(
                    ctx.accounts.destination_token_account.owner == ZOV,
                    OrbitError::InvalidAccount
                );
            }
            UserType::ICV => {
                // ICV pledge: move funds from ovault to ICV's ATA (owned by Record PDA)
                require!(
                    ctx.accounts.destination_token_account.owner == record.key(),
                    OrbitError::InvalidAccount
                );
            }
            UserType::NCW => {
                return Err(OrbitError::InvalidOperation.into());
            }
        }

        transfer_with_signer(
            &ctx.accounts.token_program,
            &ctx.accounts.source_token_account.to_account_info(),
            &ctx.accounts.destination_token_account.to_account_info(),
            &ctx.accounts.mint,
            &ctx.accounts.ovault.to_account_info(),
            signer_seeds,
            amount,
        )?;

        let record = &mut ctx.accounts.record;
        record.principle_in = record
            .principle_in
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        emit!(TxEvent {
            event_name: "Pledge".to_string(),
            user_id,
            from_owner: ctx.accounts.source_token_account.owner.key(),
            to_owner: ctx.accounts.destination_token_account.owner.key(),
            from: ctx.accounts.source_token_account.key(),
            to: ctx.accounts.destination_token_account.key(),
            amount,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id: [0u8; 32],
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
        mut,
        seeds = [RECORD_SEED, user_id.as_ref()],
        bump,
    )]
    pub record: Account<'info, Record>,

    #[account(
        constraint = mint.key() == source_token_account.mint @ OrbitError::InvalidTokenMint,
        constraint = mint.key() == destination_token_account.mint @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    /// CHECK: zynk-core config PDA — validated via read_core_config()
    pub core_config: UncheckedAccount<'info>,

    /// CHECK: zynk-core program for PDA derivation
    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(partner_id: [u8; 32], order_id: [u8; 32], zov_id: [u8; 32])]
pub struct Borrow<'info> {
    /// ZOV destination token account (shared with zynk-core CPI)
    #[account(mut, constraint = zov_token_account.owner == ZOV @ OrbitError::InvalidAccount)]
    pub zov_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = mint.key() == zov_token_account.mint @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
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
        constraint = mint.key() == zov_token_account.mint @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
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

    // --- Ovault PDA (signer for ovault → position transfers) ---
    /// CHECK: Ovault - verified by seeds.
    #[account(
        seeds = [VAULT_SEED, b"orbit"],
        bump
    )]
    pub ovault: UncheckedAccount<'info>,

    /// CHECK: zynk-core Beneficiary PDA for ovault (whitelisted with allow_transient=true)
    pub ovaults_beneficiary_pda: UncheckedAccount<'info>,
    // Remaining accounts (3 per position):
    // [destination_token_account, record, position_pda]
}

#[derive(Accounts)]
#[instruction(vault_id: [u8; 32])]
pub struct Disburse<'info> {
    #[account(mut)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
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
        constraint = mint.key() == source_token_account.mint @ OrbitError::InvalidTokenMint,
        constraint = mint.key() == destination_token_account.mint @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    /// CHECK: zynk-core config PDA — validated via read_core_config()
    pub core_config: UncheckedAccount<'info>,

    /// CHECK: zynk-core program for PDA derivation
    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct Whitelist<'info> {
    #[account(
        init,
        payer = admin,
        // Allocate only baseline space (empty whitelist). Partners are added
        // later via update_partner_whitelist, which reallocs on demand.
        space = Record::space_for_len(0),
        seeds = [RECORD_SEED, user_id.as_ref()],
        bump
    )]
    pub record: Account<'info, Record>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: zynk-core config PDA — validated via read_core_config()
    pub core_config: UncheckedAccount<'info>,

    /// CHECK: zynk-core program for PDA derivation
    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct UpdateWallets<'info> {
    #[account(
        mut,
        seeds = [RECORD_SEED, user_id.as_ref()],
        bump,
    )]
    pub record: Account<'info, Record>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: zynk-core config PDA — validated via read_core_config()
    pub core_config: UncheckedAccount<'info>,

    /// CHECK: zynk-core program for PDA derivation
    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
pub struct Revoke<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: zynk-core config PDA — validated via read_core_config()
    pub core_config: UncheckedAccount<'info>,

    /// CHECK: zynk-core program for PDA derivation
    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct UpdateCliffPeriod<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + UpdateCliffPeriodRequest::INIT_SPACE,
        seeds = [RECORD_UPDATE_REQUEST_SEED, user_id.as_ref()],
        bump
    )]
    pub request_record: Account<'info, UpdateCliffPeriodRequest>,

    #[account(
        seeds = [RECORD_SEED, user_id.as_ref()],
        bump,
    )]
    pub user_record: Account<'info, Record>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: zynk-core config PDA — validated via read_core_config()
    pub core_config: UncheckedAccount<'info>,

    /// CHECK: zynk-core program for PDA derivation
    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct UpdateMaxDeposit<'info> {
    #[account(
        mut,
        seeds = [RECORD_SEED, user_id.as_ref()],
        bump,
    )]
    pub record: Account<'info, Record>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: zynk-core config PDA — validated via read_core_config()
    pub core_config: UncheckedAccount<'info>,

    /// CHECK: zynk-core program for PDA derivation
    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
// `action` is bound here so the realloc expression below can reference it.
#[instruction(user_id: [u8; 32], action: WhitelistAction)]
pub struct UpdatePartnerWhitelist<'info> {
    #[account(
        mut,
        seeds = [RECORD_SEED, user_id.as_ref()],
        bump,
        // Dynamically resize the account buffer before the handler runs:
        //   • Add    → grow by one u32 slot (4 bytes)
        //   • Remove → shrink by one u32 slot, floored at 0 via saturating_sub
        // Anchor automatically tops up (or refunds) rent to/from `admin`.
        realloc = Record::space_for_len(
            match action {
                WhitelistAction::Add    => record.whitelisted_partners.len().saturating_add(1),
                WhitelistAction::Remove => record.whitelisted_partners.len().saturating_sub(1),
            }
        ),
        realloc::payer = admin,
        // false → do NOT zero-fill new bytes; Anchor re-serialises the whole
        // account on exit anyway, so zeroing is wasted compute.
        realloc::zero = false,
    )]
    pub record: Account<'info, Record>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: zynk-core config PDA — validated via read_core_config()
    pub core_config: UncheckedAccount<'info>,

    /// CHECK: zynk-core program for PDA derivation
    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct RequestWithdraw<'info> {
    #[account(
        seeds = [RECORD_SEED, user_id.as_ref()],
        bump,
    )]
    pub signer_record: Account<'info, Record>,

    #[account(
        init,
        payer = signer,
        space = 8 + WithdrawRequest::INIT_SPACE,
        seeds = [WITHDRAW_REQUEST_SEED, user_id.as_ref()],
        bump
    )]
    pub withdraw_request: Account<'info, WithdrawRequest>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct ApproveWithdraw<'info> {
    /// CHECK: WithdrawRequest PDA - validated in handler
    #[account(mut)]
    pub request: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [RECORD_SEED, user_id.as_ref()],
        bump,
    )]
    pub record: Account<'info, Record>,

    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Ovault PDA — seed-constrained so Anchor populates ctx.bumps.ovault.
    /// Only required for LP withdrawals; pass None for ICV/NCW paths.
    #[account(
        seeds = [VAULT_SEED, b"orbit"],
        bump
    )]
    pub ovault: Option<UncheckedAccount<'info>>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,

    /// CHECK: zynk-core config PDA — validated via read_core_config()
    pub core_config: UncheckedAccount<'info>,

    /// CHECK: zynk-core program for PDA derivation
    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
pub struct RejectWithdraw<'info> {
    /// CHECK: WithdrawRequest PDA - validated in handler
    #[account(mut)]
    pub request: UncheckedAccount<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: zynk-core config PDA — validated via read_core_config()
    pub core_config: UncheckedAccount<'info>,

    /// CHECK: zynk-core program for PDA derivation
    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct ApproveCliffPeriod<'info> {
    /// UpdateCliffPeriodRequest PDA.
    /// user_id ownership and record PDA derivation are validated in the handler
    /// after converting the String user_id to its 32-byte on-chain representation.
    #[account(
        mut,
        constraint = request.user_id == user_id @ OrbitError::UserIdMismatch
    )]
    pub request: Account<'info, UpdateCliffPeriodRequest >,

    #[account(
        mut,
        seeds = [RECORD_SEED, user_id.as_ref()],
        bump,
    )]
    pub record: Account<'info, Record>,


    /// A whitelisted wallet that is approving the cliff period update
    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct RejectCliffPeriod<'info> {
    /// CHECK: UpdateCliffPeriodRequest PDA - validated in handler
    #[account(
        mut,
        constraint = request.user_id == user_id @ OrbitError::UserIdMismatch
    )]
    pub request: Account<'info, UpdateCliffPeriodRequest >,

    /// Record PDA for wallet membership verification
    #[account(
        seeds = [RECORD_SEED, user_id.as_ref()],
        bump,
    )]
    pub record: Account<'info, Record>,

    /// A whitelisted wallet that is rejecting the cliff period update
    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct Claim<'info> {
    #[account(
        mut,
        seeds = [RECORD_SEED, user_id.as_ref()],
        bump,
        constraint = record.user_type == UserType::ICV @ OrbitError::InvalidOperation,
    )]
    pub record: Account<'info, Record>,

    /// ICV token account — owned by Record PDA, holds all deposited funds
    #[account(mut)]
    pub icv_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Token account to receive claimed funds — must be owned by record.primary_account or record.aux_account
    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = mint.key() == icv_token_account.mint @ OrbitError::InvalidTokenMint,
        constraint = mint.key() == destination_token_account.mint @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    /// CHECK: zynk-core config PDA — validated via read_core_config()
    pub core_config: UncheckedAccount<'info>,

    /// CHECK: zynk-core program for PDA derivation
    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct Pledge<'info> {
    #[account(mut)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [RECORD_SEED, user_id.as_ref()],
        bump,
    )]
    pub record: Account<'info, Record>,

    #[account(
        constraint = mint.key() == source_token_account.mint @ OrbitError::InvalidTokenMint,
        constraint = mint.key() == destination_token_account.mint @ OrbitError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub manager: Signer<'info>,

    /// CHECK: Ovault - verified by seeds. Must be whitelisted as a beneficiary in zynk-core with allow_transient=true.
    #[account(
        seeds = [VAULT_SEED, b"orbit"],
        bump
    )]
    pub ovault: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    /// CHECK: zynk-core config PDA — validated via read_core_config()
    pub core_config: UncheckedAccount<'info>,

    /// CHECK: zynk-core program for PDA derivation
    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[error_code]
pub enum OrbitError {
    #[msg("Unauthorized admin")]
    UnauthorizedAdmin,
    #[msg("Unauthorized manager")]
    UnauthorizedManager,
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
    #[msg("Max deposit cannot be reduced below current net balance")]
    MaxDepositBelowBalance,
    #[msg("Partner is not in the whitelist")]
    PartnerNotWhitelisted,
    #[msg("Partner is already in the whitelist")]
    PartnerAlreadyWhitelisted,
    #[msg("Invalid partner ID format")]
    InvalidPartnerId,
    #[msg("Invalid zynk-core config account")]
    InvalidCoreConfig,
    #[msg("Repay amount exceeds remaining order amount")]
    ExcessiveRepay,
    #[msg("Source token account has insufficient token balance for withdrawal")]
    InsufficientTokenBalance,
}

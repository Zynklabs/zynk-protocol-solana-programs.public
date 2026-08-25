use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    pubkey::Pubkey,
    system_program::ID as SYSTEM_PROGRAM_ID,
    instruction::AccountMeta,
    hash::hash,
};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use zynk_core::{self, cpi::accounts::CreateOrder, program::ZynkCore, EventArg};

declare_id!("ZYNKopsYjG6gaGqdwz8HLAgvCAEFwCET56kRQKkjxfc");

pub const DOMAIN_SEPARATOR: u64 = 115131153410997;

pub const USER_SEED: &[u8] = b"user";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POSITION_SEED: &[u8] = b"position";
pub const WITHDRAW_REQUEST_SEED: &[u8] = b"withdraw_request";
pub const USER_UPDATE_REQUEST_SEED: &[u8] = b"user_update_request";

/// Destination callers that may bypass a user's CCTP recipient whitelist.
/// This deployment-time allowlist is intentionally not mutable on-chain.
pub const CCTP_WHITELISTED_DESTINATION_CALLERS: [[u8; 32]; 1] = [[2u8; 32]];

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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub struct CctpRecipient {
    pub destination_domain: u32,
    pub mint_recipient: [u8; 32],
}

#[account]
pub struct User {
    pub wallets: [Pubkey; 3],           // 96 bytes (3 × 32)
    pub user_id: [u8; 32],              // 32 bytes
    pub user_type: UserType,            // 1  byte  (repr u8)
    pub cliff_period: i64,              // 8  bytes
    pub principal_in: u64,              // 8  bytes
    pub principal_out: u64,             // 8  bytes
    pub max_principal: u64,                    // 8 bytes
    pub whitelisted_partners: Vec<u32>,        // 4-byte length prefix + (len × 4) bytes
    pub cctp_recipients: Vec<CctpRecipient>,   // 4-byte length prefix + (len × 36) bytes
}

impl User {
    /// Fixed byte cost of every field except the vector's element storage:
    ///   8   discriminator
    /// + 96  wallets ([Pubkey; 3])
    /// + 32  user_id
    /// + 1   user_type
    /// + 8   cliff_period
    /// + 8   principal_in
    /// + 8   principal_out
    /// + 8   max_principal
    /// + 4   Vec<u32> length prefix
    /// + 4   Vec<CctpRecipient> length prefix
    /// = 177 bytes
    pub const BASE_SIZE: usize = 8 + 96 + 32 + 1 + 8 + 8 + 8 + 8 + 4 + 4;

    #[inline]
    pub fn space_for_lengths(partner_len: usize, cctp_recipient_len: usize) -> usize {
        Self::BASE_SIZE
            + partner_len * 4
            + cctp_recipient_len * CctpRecipient::INIT_SPACE
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimOperation {
    pub zov_id: [u8; 32],
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

#[event]
pub struct CctpEvent {
    pub event_name: String,
    pub vault: Pubkey,
    pub user_id: [u8; 32],
    pub amount: u64,
    pub token: Pubkey,
    pub destination_domain: u32,
    pub mint_recipient: [u8; 32],
    pub destination_caller: [u8; 32],
    pub domain_separator: u64,
}

/// Closes a program-owned account and transfers its lamports to `to`.
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
    from.resize(0).map_err(Into::into)
}

/// Returns true if `wallet` is present in `user.wallets`.
fn is_whitelisted_wallet(user: &User, wallet: &Pubkey) -> bool {
    user.wallets.contains(wallet)
}

/// Extracts the six-digit numeric partner ID from values such as
/// `zp_123456::context`.
fn extract_partner_number(partner_id: &str) -> Result<u32> {
    let base = if let Some(colon_idx) = partner_id.find("::") {
        &partner_id[..colon_idx]
    } else {
        partner_id
    };
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
fn transfer_with_signer_seeds<'info>(
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

/// Invokes Circle CCTP's `deposit_for_burn` instruction, selecting the
/// destination-caller variant when a nonzero caller is supplied.
fn cpi_cctp_deposit_for_burn<'info>(
    cctp_program: &AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    authority_account: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
    destination_domain: u32,
    mint_recipient: [u8; 32],
    destination_caller: Option<[u8; 32]>,
) -> Result<()> {
    require!(amount > 0, OrbitError::ZeroAmount);

    let (disc_name, caller_bytes) = match destination_caller {
        Some(caller) if caller != [0u8; 32] => {
            ("global:deposit_for_burn_with_caller", Some(caller))
        }
        _ => ("global:deposit_for_burn", None),
    };

    let disc = hash(disc_name.as_bytes()).to_bytes();
    let mut ix_data = Vec::with_capacity(8 + 8 + 4 + 32 + 32);
    ix_data.extend_from_slice(&disc[..8]);
    ix_data.extend_from_slice(&amount.to_le_bytes());
    ix_data.extend_from_slice(&destination_domain.to_le_bytes());
    ix_data.extend_from_slice(&mint_recipient);
    if let Some(caller) = caller_bytes {
        ix_data.extend_from_slice(&caller);
    }

    let mut account_metas = Vec::with_capacity(remaining_accounts.len());
    let mut account_infos = Vec::with_capacity(remaining_accounts.len() + 1);
    account_infos.push(cctp_program.clone());

    for acc in remaining_accounts {
        let is_signer = acc.key == authority_account.key || acc.is_signer;
        if acc.is_writable {
            account_metas.push(AccountMeta::new(*acc.key, is_signer));
        } else {
            account_metas.push(AccountMeta::new_readonly(*acc.key, is_signer));
        }
        account_infos.push(acc.clone());
    }

    let instruction = anchor_lang::solana_program::instruction::Instruction {
        program_id: *cctp_program.key,
        accounts: account_metas,
        data: ix_data,
    };

    anchor_lang::solana_program::program::invoke_signed(
        &instruction,
        &account_infos,
        signer_seeds,
    )?;

    Ok(())
}

#[program]
pub mod zynk_orbit {
    use super::*;

    /// Deposits principal for a registered LP or ICV user.
    ///
    /// LP funds are sent to the canonical Core ZOV, while ICV funds are held by
    /// the User PDA. NCW deposits are rejected and net principal is capped by
    /// `max_principal`.
    pub fn deposit(ctx: Context<Deposit>, user_id: [u8; 32], amount: u64) -> Result<()> {
        require!(amount != 0, OrbitError::ZeroAmount);

        let user = &mut ctx.accounts.user;

        require!(user.user_type != UserType::NCW, OrbitError::InvalidOperation);

        require!(
            user.principal_in
                .checked_sub(user.principal_out)
                .ok_or(ProgramError::ArithmeticOverflow)?
                .checked_add(amount)
                .ok_or(ProgramError::ArithmeticOverflow)?
                <= user.max_principal,
            OrbitError::MaxDepositExceeded
        );

        let expected_destination = if user.user_type == UserType::LP {
            Pubkey::find_program_address(
                &[zynk_core::ZYNK_OP_VAULT_SEED, hash(b"0001").as_ref()],
                &ZynkCore::id()
            ).0
        } else {
            user.key()  // ICV — NCW is already rejected above
        };

        require!(
            ctx.accounts.destination_token_account.owner == expected_destination,
            zynk_core::CoreError::InvalidAccount
        );

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.source_token_account.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.signer.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        user.principal_in = user.principal_in
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

    /// Creates one Core order funded by one or more NCW/ICV positions.
    ///
    /// Position amounts must exactly equal the order amount. Funds are transferred
    /// into the selected ZOV before Core sends the aggregate amount to the
    /// beneficiary and records the order.
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
        require!(!positions.is_empty(), OrbitError::EmptyPositions);
        require!(
            ctx.remaining_accounts.len() == positions.len() * 4,
            OrbitError::InvalidPositionOperation
        );

        // The numeric prefix is used for Orbit authorization; Core receives the
        // hash of the complete partner identifier.
        let partner_number = extract_partner_number(&partner_id)?;
        let partner_id_bytes = hash(partner_id.as_bytes()).to_bytes();

        let mut total_position_amount: u64 = 0;
        for pos in &positions {
            require!(pos.amount > 0, OrbitError::ZeroAmount);
            total_position_amount = total_position_amount
                .checked_add(pos.amount)
                .ok_or(ProgramError::ArithmeticOverflow)?;
        }

        require!(total_position_amount == amount, OrbitError::AmountMismatch);

        let remaining_accounts = ctx.remaining_accounts;

        for (i, pos) in positions.iter().enumerate() {
            // Each position requires 4 remaining accounts:
            // [source_token_account, authority_account, user, position_pda]
            let base_idx = i * 4;
            require!(
                base_idx + 3 < remaining_accounts.len(),
                OrbitError::InvalidPositionOperation
            );
            let source_token_account = &remaining_accounts[base_idx];
            let authority_account = &remaining_accounts[base_idx + 1];
            let user_account = &remaining_accounts[base_idx + 2];
            let position_pda = &remaining_accounts[base_idx + 3];

            let (user_id, user_type) = {
                let user_data = user_account.data.borrow();
                let user = User::try_deserialize(&mut &user_data[..])
                    .map_err(|_| zynk_core::CoreError::InvalidAccount)?;

                // An empty partner list intentionally permits every partner.
                if !user.whitelisted_partners.is_empty() {
                    require!(
                        user.whitelisted_partners.contains(&partner_number),
                        OrbitError::PartnerNotWhitelisted
                    );
                }

                (user.user_id, user.user_type)
            };

            require!(user_type != UserType::LP, zynk_core::CoreError::Unauthorized);

            match user_type {
                UserType::NCW => {
                    let seeds: &[&[u8]] = &[VAULT_SEED, pos.vault_id.as_ref()];
                    let (expected_authority, bump) = Pubkey::find_program_address(seeds, ctx.program_id);
                    require!(
                        authority_account.key() == expected_authority,
                        zynk_core::CoreError::InvalidAccount
                    );

                    let (is_valid_delegate, approved_amount) = {
                        let data = source_token_account.try_borrow_data()?;
                        let token_acc = TokenAccount::try_deserialize(&mut &data[..])
                            .map_err(|_| zynk_core::CoreError::InvalidAccount)?;

                        let has_delegate = token_acc.delegate.contains(&expected_authority);
                        (has_delegate, token_acc.delegated_amount)
                    };

                    require!(is_valid_delegate, zynk_core::CoreError::InvalidAccount);
                    require!(approved_amount >= pos.amount, OrbitError::InsufficientBalance);

                    let seeds_with_bump: &[&[u8]] = &[VAULT_SEED, pos.vault_id.as_ref(), &[bump]];
                    let signer_seeds = &[&seeds_with_bump[..]];
                    transfer_with_signer_seeds(
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
                    let seeds: &[&[u8]] = &[USER_SEED, user_id.as_ref()];
                    let (expected_authority, bump) = Pubkey::find_program_address(seeds, ctx.program_id);
                    require!(
                        authority_account.key() == expected_authority,
                        zynk_core::CoreError::InvalidAccount
                    );

                    let seeds_with_bump: &[&[u8]] = &[USER_SEED, user_id.as_ref(), &[bump]];
                    let signer_seeds = &[&seeds_with_bump[..]];
                    transfer_with_signer_seeds(
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
                    return Err(zynk_core::CoreError::Unauthorized.into());
                }
            };

            let position_seeds: &[&[u8]] = &[POSITION_SEED, order_id.as_ref(), user_id.as_ref()];
            let (expected_position_key, position_bump) = Pubkey::find_program_address(position_seeds, ctx.program_id);
            require!(
                position_pda.key() == expected_position_key,
                zynk_core::CoreError::InvalidAccount
            );

            let position_seeds_with_bump: &[&[u8]] = &[
                POSITION_SEED,
                order_id.as_ref(),
                user_id.as_ref(),
                &[position_bump],
            ];
            let position_signer_seeds = &[&position_seeds_with_bump[..]];

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

            let mut position_data = position_pda.try_borrow_mut_data()?;
            position_data[..8].copy_from_slice(&Position::DISCRIMINATOR);
            let position_account = Position {
                order_id,
                partner_id: partner_id_bytes,
                amount_borrowed: pos.amount,
                amount_repaid: 0,
                user_id,
            };
            position_account.try_serialize(&mut &mut position_data[..])?;
            drop(position_data);

            if user_type == UserType::NCW {
                let mut user_data = user_account.try_borrow_mut_data()?;
                let mut user = User::try_deserialize_unchecked(&mut &user_data[..])?;
                user.principal_in = user
                    .principal_in
                    .checked_add(pos.amount)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
                user.try_serialize(&mut &mut user_data[..])?;
            }

            emit!(TxEvent {
                event_name: "Borrow".to_string(),
                user_id,
                from_owner: source_token_account.owner.key(),
                to_owner: ctx.accounts.zov_token_account.owner.key(),
                from: source_token_account.key(),
                to: ctx.accounts.zov_token_account.key(),
                amount,
                token: ctx.accounts.mint.key(),
                domain_separator: DOMAIN_SEPARATOR,
                order_id,
            });
        }

        let cpi_program = ctx.accounts.zynk_core_program.to_account_info();
        let cpi_accounts = CreateOrder {
            config: ctx.accounts.config.to_account_info(),
            manager: ctx.accounts.manager.to_account_info(),
            partner_deposit_vault: ctx.accounts.partner_deposit_vault.to_account_info(),
            pdv_token_account: None,
            zynk_op_vault: ctx.accounts.zynk_op_vault.to_account_info(),
            zov_token_account: ctx.accounts.zov_token_account.to_account_info(),
            beneficiary: ctx.accounts.beneficiary.to_account_info(),
            beneficiary_token_account: ctx
                .accounts
                .beneficiary_token_account
                .to_account_info(),
            order_tracker: ctx.accounts.order_tracker.to_account_info(),
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

        Ok(())
    }

    /// Replenishes a Core order and settles its Orbit positions.
    ///
    /// The Core CPI retains replenishment above outstanding principal in the ZOV.
    /// Repayable principal is distributed proportionally through the Orbit vault;
    /// fully repaid positions and the corresponding Core order are closed.
    pub fn repay<'info>(
        ctx: Context<'_, '_, '_, 'info, Repay<'info>>,
        partner_id: [u8; 32],
        order_id: [u8; 32],
        zov_id: [u8; 32],
        amount: u64,
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        // Each position is supplied as
        // [destination_token_account, user, position_pda].
        let num_positions = ctx.remaining_accounts.len() / 3;
        require!(num_positions > 0, OrbitError::EmptyPositions);
        require!(
            ctx.remaining_accounts.len() % 3 == 0,
            OrbitError::InvalidPositionOperation
        );
        require!(amount > 0, OrbitError::ZeroAmount);

        let config = &ctx.accounts.config;
        require!(
            ctx.accounts.manager.key() == config.manager,
            zynk_core::CoreError::Unauthorized
        );

        require!(
            config.whitelisted_token_mints.contains(&ctx.accounts.mint.key()),
            zynk_core::CoreError::InvalidTokenMint
        );

        let order_tracker_data = ctx.accounts.order_tracker.try_borrow_data()?;
        let order_tracker = zynk_core::OrderTracker::try_deserialize(&mut &order_tracker_data[..])
            .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
        require!(
            ctx.accounts.mint.key() == order_tracker.mint,
            zynk_core::CoreError::InvalidTokenMint
        );
        let amount_out = order_tracker.amount_out;
        let amount_in = order_tracker.amount_in;
        drop(order_tracker_data);

        let remaining_order = amount_out
            .checked_sub(amount_in)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        let prepared_amount = amount.min(remaining_order);
        let remaining_accounts = ctx.remaining_accounts;

        // First pass: validate all users and positions, cache user_type and remaining amount.
        // Second pass: distribute shares and execute transfers using cached data.
        struct PositionInfo {
            user_type: UserType,
            user_key: Pubkey,
            remaining: u64,
            share: u64,
        }
        let mut position_infos = Vec::with_capacity(num_positions);

        for i in 0..num_positions {
            let base_idx = i * 3;
            let _dst_token_account: &AccountInfo = &remaining_accounts[base_idx];
            let user_account: &AccountInfo = &remaining_accounts[base_idx + 1];
            let position_pda: &AccountInfo = &remaining_accounts[base_idx + 2];

            let user_data = user_account.data.borrow();
            let user = User::try_deserialize(&mut &user_data[..])
                .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
            let user_type = user.user_type;
            let user_id = user.user_id;
            let user_key = user_account.key();
            require!(user_account.owner == ctx.program_id, zynk_core::CoreError::InvalidAccount);
            let (expected_user_key, _) = Pubkey::find_program_address(
                &[USER_SEED, user_id.as_ref()],
                ctx.program_id,
            );
            require!(user_key == expected_user_key, zynk_core::CoreError::InvalidAccount);
            drop(user_data);

            require!(
                user_type != UserType::LP,
                zynk_core::CoreError::Unauthorized
            );

            let position_data = position_pda.data.borrow();
            let position = Position::try_deserialize(&mut &position_data[..])
                .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
            require!(position_pda.owner == ctx.program_id, zynk_core::CoreError::InvalidAccount);
            require!(position.order_id == order_id, OrbitError::PositionOrderMismatch);
            require!(position.partner_id == partner_id, OrbitError::PositionOrderMismatch);
            require!(position.user_id == user_id, OrbitError::UserIdMismatch);
            let (expected_position_key, _) = Pubkey::find_program_address(
                &[POSITION_SEED, order_id.as_ref(), user_id.as_ref()],
                ctx.program_id,
            );
            require!(position_pda.key() == expected_position_key, zynk_core::CoreError::InvalidAccount);
            let remaining = position
                .amount_borrowed
                .checked_sub(position.amount_repaid)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            drop(position_data);

            position_infos.push(PositionInfo {
                user_type: user_type,
                user_key,
                remaining,
                share: 0,
            });
        }

        let open_position_total = position_infos.iter().try_fold(0u64, |total, info| {
            total.checked_add(info.remaining).ok_or(ProgramError::ArithmeticOverflow)
        })?;
        require!(open_position_total == remaining_order, OrbitError::AmountMismatch);

        // Allocate proportionally with ceiling division while capping each share
        // by both the position balance and the undistributed amount.
        let mut remaining_amount = prepared_amount;
        for info in position_infos.iter_mut() {
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

        // Atomically move the gross amount into Core's ZOV and only the open-position
        // principal into Orbit's distribution vault. Any excess remains in the ZOV.
        let authority_bump = ctx.bumps.orbit_authority;
        let authority_seeds: &[&[u8]] = &[
            zynk_core::ORBIT_CPI_AUTHORITY_SEED,
            &[authority_bump],
        ];
        let core_accounts = zynk_core::cpi::accounts::ReplenishAndRepay {
            config: ctx.accounts.config.to_account_info(),
            orbit_authority: ctx.accounts.orbit_authority.to_account_info(),
            manager: ctx.accounts.manager.to_account_info(),
            order_tracker: ctx.accounts.order_tracker.to_account_info(),
            partner_deposit_vault: ctx.accounts.partner_deposit_vault.to_account_info(),
            pdv_token_account: ctx.accounts.pdv_token_account.to_account_info(),
            zynk_op_vault: ctx.accounts.zynk_op_vault.to_account_info(),
            zov_token_account: ctx.accounts.zov_token_account.to_account_info(),
            destination_token_account: ctx.accounts.ovault_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        };
        zynk_core::cpi::replenish_and_repay(
            CpiContext::new_with_signer(
                ctx.accounts.zynk_core_program.to_account_info(),
                core_accounts,
                &[authority_seeds],
            ),
            zov_id,
            amount,
            prepared_amount,
            meta,
        )?;

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

            // `AccountInfo::owner` identifies the Token Program; the token
            // authority must be read from the serialized token account.
            let dst_token_authority = {
                let data = dst_token_account.try_borrow_data()?;
                let token_account = TokenAccount::try_deserialize_unchecked(&mut &data[..])
                    .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
                token_account.owner
            };

            match info.user_type {
                UserType::NCW => {
                    let user_account: &AccountInfo = &remaining_accounts[base_idx + 1];
                    let user_data = user_account.data.borrow();
                    let user = User::try_deserialize(&mut &user_data[..])
                        .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
                    require!(
                        is_whitelisted_wallet(&user, &dst_token_authority),
                        zynk_core::CoreError::InvalidAccount
                    );
                }
                UserType::ICV => {
                    require!(
                        dst_token_authority == info.user_key,
                        zynk_core::CoreError::InvalidAccount
                    );
                }
                UserType::LP => {
                    return Err(zynk_core::CoreError::Unauthorized.into());
                }
            }

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

            if info.user_type == UserType::NCW {
                let user_account = &remaining_accounts[base_idx + 1];
                let mut user_data = user_account.try_borrow_mut_data()?;
                let mut user = User::try_deserialize_unchecked(&mut &user_data[..])?;
                user.principal_out = user
                    .principal_out
                    .checked_add(info.share)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
                user.try_serialize(&mut &mut user_data[..])?;
            }

            if is_position_closed {
                close_account(position_pda, &ctx.accounts.manager)?;
            }
        }

        emit!(TxEvent {
            event_name: "Repay".to_string(),
            user_id: [0u8; 32],
            from_owner: Pubkey::default(),
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

    /// Claims unlocked principal for an ICV or NCW user.
    ///
    /// ICV custody is consumed first. Supplied positions may then recover up to
    /// the available amount from matching Core PDVs. User and position accounting
    /// advance only by funds actually paid.
    pub fn claim<'info>(
        ctx: Context<'_, '_, '_, 'info, Claim<'info>>,
        user_id: [u8; 32],
        operations: Vec<ClaimOperation>,
    ) -> Result<()> {
        require!(
            ctx.remaining_accounts.len() == operations.len() * 6,
            OrbitError::InvalidPositionOperation
        );

        let user = &ctx.accounts.user;
        require!(
            ctx.accounts.config.whitelisted_token_mints.contains(&ctx.accounts.mint.key()),
            zynk_core::CoreError::InvalidTokenMint
        );
        require!(
            is_whitelisted_wallet(user, &ctx.accounts.signer.key()),
            zynk_core::CoreError::InvalidAccount
        );
        require!(
            Clock::get()?.unix_timestamp >= user.cliff_period,
            OrbitError::CliffPeriodNotOver
        );
        require!(
            is_whitelisted_wallet(user, &ctx.accounts.destination_token_account.owner),
            zynk_core::CoreError::InvalidAccount
        );

        let claimable = user
            .principal_in
            .checked_sub(user.principal_out)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        require!(claimable > 0, OrbitError::ZeroAmount);

        let mut total_paid = 0u64;
        if user.user_type == UserType::ICV {
            let icv_token_account = ctx
                .accounts
                .icv_token_account
                .as_ref()
                .ok_or(zynk_core::CoreError::InvalidAccount)?;
            require!(icv_token_account.owner == user.key(), zynk_core::CoreError::InvalidAccount);
            require!(icv_token_account.mint == ctx.accounts.mint.key(), zynk_core::CoreError::InvalidTokenMint);

            let liquid_payment = icv_token_account.amount.min(claimable);
            if liquid_payment > 0 {
                let user_seeds: &[&[u8]] = &[
                    USER_SEED,
                    user_id.as_ref(),
                    &[ctx.bumps.user],
                ];
                token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        TransferChecked {
                            from: icv_token_account.to_account_info(),
                            to: ctx.accounts.destination_token_account.to_account_info(),
                            mint: ctx.accounts.mint.to_account_info(),
                            authority: ctx.accounts.user.to_account_info(),
                        },
                        &[user_seeds],
                    ),
                    liquid_payment,
                    ctx.accounts.mint.decimals,
                )?;
                total_paid = liquid_payment;
            }
        } else {
            require!(user.user_type == UserType::NCW, OrbitError::InvalidOperation);
            require!(ctx.accounts.icv_token_account.is_none(), zynk_core::CoreError::InvalidAccount);
        }

        for (index, operation) in operations.iter().enumerate() {
            if total_paid >= claimable {
                break;
            }

            // [position, core_order_tracker, partner_deposit_vault,
            //  pdv_token_account, zynk_op_vault, zov_token_account]
            let base = index * 6;
            let position_account = &ctx.remaining_accounts[base];
            let order_tracker_account = &ctx.remaining_accounts[base + 1];
            let partner_deposit_vault = &ctx.remaining_accounts[base + 2];
            let pdv_token_account = &ctx.remaining_accounts[base + 3];
            let zynk_op_vault = &ctx.remaining_accounts[base + 4];
            let zov_token_account = &ctx.remaining_accounts[base + 5];

            require!(position_account.owner == ctx.program_id, zynk_core::CoreError::InvalidAccount);
            let position_data = position_account.try_borrow_data()?;
            let position = Position::try_deserialize(&mut &position_data[..])
                .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
            require!(position.user_id == user_id, OrbitError::UserIdMismatch);
            let (expected_position, _) = Pubkey::find_program_address(
                &[POSITION_SEED, position.order_id.as_ref(), user_id.as_ref()],
                ctx.program_id,
            );
            require!(position_account.key() == expected_position, zynk_core::CoreError::InvalidAccount);
            let position_outstanding = position
                .amount_borrowed
                .checked_sub(position.amount_repaid)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            let position_order_id = position.order_id;
            let position_partner_id = position.partner_id;
            drop(position_data);

            if position_outstanding == 0 {
                continue;
            }

            let tracker_data = order_tracker_account.try_borrow_data()?;
            let tracker = zynk_core::OrderTracker::try_deserialize(&mut &tracker_data[..])
                .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
            require!(tracker.order_id == position_order_id, OrbitError::PositionOrderMismatch);
            require!(tracker.partner_id == position_partner_id, OrbitError::PositionOrderMismatch);
            require!(tracker.mint == ctx.accounts.mint.key(), zynk_core::CoreError::InvalidTokenMint);
            let core_outstanding = tracker
                .amount_out
                .checked_sub(tracker.amount_in)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            drop(tracker_data);

            let pdv_data = pdv_token_account.try_borrow_data()?;
            let pdv = TokenAccount::try_deserialize_unchecked(&mut &pdv_data[..])
                .map_err(|_| zynk_core::CoreError::InvalidAccount)?;
            require!(pdv.mint == ctx.accounts.mint.key(), zynk_core::CoreError::InvalidTokenMint);
            let remaining_claimable = claimable
                .checked_sub(total_paid)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            let recovered = remaining_claimable
                .min(position_outstanding)
                .min(core_outstanding)
                .min(pdv.amount);
            drop(pdv_data);

            if recovered == 0 {
                continue;
            }

            let authority_seeds: &[&[u8]] = &[
                zynk_core::ORBIT_CPI_AUTHORITY_SEED,
                &[ctx.bumps.orbit_authority],
            ];
            let core_accounts = zynk_core::cpi::accounts::ReplenishAndRepay {
                config: ctx.accounts.config.to_account_info(),
                orbit_authority: ctx.accounts.orbit_authority.to_account_info(),
                manager: ctx.accounts.core_manager.to_account_info(),
                order_tracker: order_tracker_account.to_account_info(),
                partner_deposit_vault: partner_deposit_vault.to_account_info(),
                pdv_token_account: pdv_token_account.to_account_info(),
                zynk_op_vault: zynk_op_vault.to_account_info(),
                zov_token_account: zov_token_account.to_account_info(),
                destination_token_account: ctx.accounts.destination_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            };
            zynk_core::cpi::replenish_and_repay(
                CpiContext::new_with_signer(
                    ctx.accounts.zynk_core_program.to_account_info(),
                    core_accounts,
                    &[authority_seeds],
                ),
                operation.zov_id,
                recovered,
                recovered,
                None,
            )?;

            let is_closed = {
                let mut position_data = position_account.try_borrow_mut_data()?;
                let mut position = Position::try_deserialize_unchecked(&mut &position_data[..])?;
                position.amount_repaid = position
                    .amount_repaid
                    .checked_add(recovered)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
                let closed = position.amount_repaid == position.amount_borrowed;
                position.try_serialize(&mut &mut position_data[..])?;
                closed
            };
            if is_closed {
                close_account(position_account, &ctx.accounts.core_manager)?;
            }
            total_paid = total_paid
                .checked_add(recovered)
                .ok_or(ProgramError::ArithmeticOverflow)?;
        }

        require!(total_paid > 0, OrbitError::ZeroAmount);
        let user = &mut ctx.accounts.user;
        user.principal_out = user
            .principal_out
            .checked_add(total_paid)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        emit!(TxEvent {
            event_name: "Claim".to_string(),
            user_id,
            from_owner: ctx.accounts.user.key(),
            to_owner: ctx.accounts.destination_token_account.owner,
            from: ctx.accounts.icv_token_account.as_ref().map(|account| account.key()).unwrap_or_default(),
            to: ctx.accounts.destination_token_account.key(),
            amount: total_paid,
            token: ctx.accounts.mint.key(),
            domain_separator: DOMAIN_SEPARATOR,
            order_id: [0u8; 32],
        });

        Ok(())
    }

    /// Disburses a PDA vault balance to a registered user wallet.
    ///
    /// Only the Core-configured manager may authorize the transfer.
    pub fn disburse(ctx: Context<Disburse>, vault_id: [u8; 32], amount: u64) -> Result<()> {
        let user = &mut ctx.accounts.user;

        let config = &ctx.accounts.config;
        require!(
            ctx.accounts.manager.key() == config.manager,
            zynk_core::CoreError::Unauthorized
        );

        require!(
            config.whitelisted_token_mints.contains(&ctx.accounts.mint.key()),
            zynk_core::CoreError::InvalidTokenMint
        );

        require!(
            is_whitelisted_wallet(user, &ctx.accounts.destination_token_account.owner),
            zynk_core::CoreError::InvalidAccount
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
            user_id: user.user_id,
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

    /// Registers a user and initializes their protocol limits and allowlists.
    ///
    /// Only the Core-configured admin may create the User PDA. Duplicate partner
    /// or CCTP recipient entries are rejected.
    pub fn register_user(
        ctx: Context<RegisterUser>,
        user_id: [u8; 32],
        user_type: UserType,
        wallets: [Pubkey; 3],
        cliff_period: Option<i64>,
        max_principal: Option<u64>,
        whitelisted_partners: Vec<u32>,
        cctp_recipients: Vec<CctpRecipient>,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(
            ctx.accounts.admin.key() == config.admin,
            zynk_core::CoreError::Unauthorized
        );

        let user = &mut ctx.accounts.user;

        if let Some(cp) = cliff_period {
            let now = Clock::get()?.unix_timestamp;
            require!(cp > now, OrbitError::CliffPeriodInPast);
        }

        user.wallets = wallets;
        user.user_id = user_id;
        user.user_type = user_type;
        user.cliff_period = cliff_period.unwrap_or(i64::MAX);
        user.principal_in = 0;
        user.principal_out = 0;
        require!(
            whitelisted_partners.iter().enumerate().all(|(index, partner)|
                !whitelisted_partners[..index].contains(partner)
            ),
            OrbitError::PartnerAlreadyWhitelisted
        );
        require!(
            cctp_recipients.iter().enumerate().all(|(index, recipient)|
                !cctp_recipients[..index].contains(recipient)
            ),
            OrbitError::CctpRecipientAlreadyWhitelisted
        );

        user.max_principal = max_principal.unwrap_or(u64::MAX);
        user.whitelisted_partners = whitelisted_partners;
        user.cctp_recipients = cctp_recipients;

        emit!(AxEvent {
            event_name: "Whitelist".to_string(),
            user_id,
            public_key: wallets[0],
            domain_separator: DOMAIN_SEPARATOR,
            partners: user.whitelisted_partners.clone(),
        });

        Ok(())
    }

    /// Replaces the wallet allowlist for a registered user.
    ///
    /// Only the Core-configured admin may perform this update.
    pub fn update_wallets(
        ctx: Context<UpdateWallets>,
        user_id: [u8; 32],
        wallets: [Pubkey; 3],
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(
            ctx.accounts.admin.key() == config.admin,
            zynk_core::CoreError::Unauthorized
        );

        let user = &mut ctx.accounts.user;
        user.wallets = wallets;

        emit!(AxEvent {
            event_name: "WalletsUpdated".to_string(),
            user_id,
            public_key: wallets[0],
            domain_separator: DOMAIN_SEPARATOR,
            partners: Vec::new(),
        });

        Ok(())
    }

    /// Adds or removes a partner from a user's allowlist.
    ///
    /// The User PDA is resized while preserving its CCTP recipient entries.
    pub fn update_partner_whitelist(
        ctx: Context<UpdatePartnerWhitelist>,
        user_id: [u8; 32],
        action: WhitelistAction,
        partner_id: u32,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(
            ctx.accounts.admin.key() == config.admin,
            zynk_core::CoreError::Unauthorized
        );

        let user = &mut ctx.accounts.user;

        match action {
            WhitelistAction::Add => {
                require!(
                    !user.whitelisted_partners.contains(&partner_id),
                    OrbitError::PartnerAlreadyWhitelisted
                );
                user.whitelisted_partners.push(partner_id);
            }
            WhitelistAction::Remove => {
                let pos = user
                    .whitelisted_partners
                    .iter()
                    .position(|&id| id == partner_id)
                    .ok_or(OrbitError::PartnerNotWhitelisted)?;
                user.whitelisted_partners.swap_remove(pos);
            }
        }

        emit!(AxEvent {
            event_name: "UpdatePartnerWhitelist".to_string(),
            user_id,
            public_key: user.wallets[0],
            domain_separator: DOMAIN_SEPARATOR,
            partners: user.whitelisted_partners.clone(),
        });

        Ok(())
    }

    /// Adds or removes a typed CCTP recipient from a user's allowlist.
    ///
    /// The User PDA is resized while preserving its partner entries.
    pub fn update_cctp_recipient(
        ctx: Context<UpdateCctpRecipient>,
        _user_id: [u8; 32],
        action: WhitelistAction,
        recipient: CctpRecipient,
    ) -> Result<()> {
        let user = &mut ctx.accounts.user;

        match action {
            WhitelistAction::Add => {
                require!(
                    !user.cctp_recipients.contains(&recipient),
                    OrbitError::CctpRecipientAlreadyWhitelisted
                );
                user.cctp_recipients.push(recipient);
            }
            WhitelistAction::Remove => {
                let position = user
                    .cctp_recipients
                    .iter()
                    .position(|entry| entry == &recipient)
                    .ok_or(OrbitError::CctpRecipientNotWhitelisted)?;
                user.cctp_recipients.swap_remove(position);
            }
        }

        Ok(())
    }

    /// Revokes Orbit state supplied through remaining accounts.
    ///
    /// Only the Core-configured admin may close these accounts.
    pub fn revoke(ctx: Context<Revoke>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(
            ctx.accounts.admin.key() == config.admin,
            zynk_core::CoreError::Unauthorized
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

    /// Creates a pending cliff-period update for a registered user.
    ///
    /// Only the Core-configured admin may create the request. The requested
    /// cliff must be in the future; `None` preserves the user's current value.
    pub fn update_cliff_period(
        ctx: Context<UpdateCliffPeriod>,
        user_id: [u8; 32],
        cliff_period: Option<i64>,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(
            ctx.accounts.admin.key() == config.admin,
            zynk_core::CoreError::Unauthorized
        );

        let now = Clock::get()?.unix_timestamp;
        let resolved_cliff = cliff_period.unwrap_or(ctx.accounts.user.cliff_period);
        require!(resolved_cliff > now, OrbitError::CliffPeriodInPast);

        let request_user = &mut ctx.accounts.request_user;
        request_user.user_id = user_id;
        request_user.cliff_period = resolved_cliff;

        emit!(AxEvent {
            event_name: "CliffPeriodUpdated".to_string(),
            user_id,
            public_key: ctx.accounts.user.wallets[0],
            domain_separator: DOMAIN_SEPARATOR,
            partners: Vec::new(),
        });
        Ok(())
    }

    /// Updates the maximum net principal allowed for a registered user.
    ///
    /// Only the Core-configured admin may update the limit, and the new limit
    /// cannot be lower than the user's current `principal_in - principal_out`.
    pub fn update_max_principal(
        ctx: Context<UpdateMaxPrincipal>,
        user_id: [u8; 32],
        max_principal: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(
            ctx.accounts.admin.key() == config.admin,
            zynk_core::CoreError::Unauthorized
        );

        let user = &mut ctx.accounts.user;

        let net_balance = user
            .principal_in
            .checked_sub(user.principal_out)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        require!(
            max_principal as u64 >= net_balance,
            OrbitError::MaxPrincipalBelowBalance
        );

        user.max_principal = max_principal;

        emit!(AxEvent {
            event_name: "MaxDepositUpdated".to_string(),
            user_id,
            public_key: user.wallets[0],
            domain_separator: DOMAIN_SEPARATOR,
            partners: Vec::new(),
        });
        Ok(())
    }

    /// Creates a pending principal withdrawal request.
    ///
    /// NCW users are not eligible. The requested amount is capped by the user's
    /// recorded net principal and the request is stored until approved or rejected.
    pub fn request_withdraw(
        ctx: Context<RequestWithdraw>,
        user_id: [u8; 32],
        destination: Pubkey,
        amount: u32,
    ) -> Result<()> {
        require!(amount != 0, OrbitError::ZeroAmount);

        let signer_user = &ctx.accounts.signer_user;
        require!(
            signer_user.user_type != UserType::NCW,
            OrbitError::InvalidOperation
        );

        require!(
            is_whitelisted_wallet(signer_user, &ctx.accounts.signer.key()),
            zynk_core::CoreError::InvalidAccount
        );
        require!(
            is_whitelisted_wallet(signer_user, &destination),
            zynk_core::CoreError::InvalidAccount
        );

        require!(
            signer_user
                .principal_in
                .checked_sub(signer_user.principal_out)
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

    /// Executes an approved principal withdrawal.
    ///
    /// The Core admin transfers the requested amount from ICV custody or the
    /// Orbit vault, updates `principal_out`, and closes the request account.
    pub fn approve_withdraw(
        ctx: Context<ApproveWithdraw>,
        user_id: [u8; 32],
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(
            ctx.accounts.admin.key() == config.admin,
            zynk_core::CoreError::Unauthorized
        );

        let request_data = ctx.accounts.request.try_borrow_data()?;
        let withdraw_request = WithdrawRequest::try_deserialize(&mut &request_data[..])
            .map_err(|_| OrbitError::InvalidRequestAccount)?;
        drop(request_data);

        let user = &mut ctx.accounts.user;

        user.principal_out = user
            .principal_out
            .checked_add(withdraw_request.amount as u64)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        require!(
            ctx.accounts.destination_token_account.owner == withdraw_request.destination,
            zynk_core::CoreError::InvalidAccount
        );

        require!(
            ctx.accounts.source_token_account.amount >= withdraw_request.amount as u64,
            OrbitError::InsufficientTokenBalance
        );

        match user.user_type {
            UserType::ICV => {
                require!(
                    ctx.accounts.source_token_account.owner == user.key(),
                    zynk_core::CoreError::InvalidAccount
                );

                let seeds: &[&[u8]] = &[
                    USER_SEED,
                    user_id.as_ref(),
                    &[ctx.bumps.user],
                ];
                let signer_seeds = &[&seeds[..]];
                transfer_with_signer_seeds(
                    &ctx.accounts.token_program,
                    &ctx.accounts.source_token_account.to_account_info(),
                    &ctx.accounts.destination_token_account.to_account_info(),
                    &ctx.accounts.mint,
                    &ctx.accounts.user.to_account_info(),
                    signer_seeds,
                    withdraw_request.amount as u64,
                )?;
            }
            UserType::LP => {
                let ovault = ctx
                    .accounts
                    .ovault
                    .as_ref()
                    .ok_or(zynk_core::CoreError::InvalidAccount)?;
                let ovault_bump = ctx.bumps.ovault.ok_or(zynk_core::CoreError::InvalidAccount)?;
                let ovault_bump_ref = [ovault_bump];
                let signer_seeds = &[&[VAULT_SEED, b"orbit", &ovault_bump_ref][..]];
                transfer_with_signer_seeds(
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

    /// Rejects a pending principal withdrawal request.
    ///
    /// Only the Core-configured admin may reject the request. Closing it returns
    /// the account rent to the admin without changing user principal accounting.
    pub fn reject_withdraw(ctx: Context<RejectWithdraw>, user_id: [u8; 32]) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(
            ctx.accounts.admin.key() == config.admin,
            zynk_core::CoreError::Unauthorized
        );

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

    /// Applies a pending cliff-period update.
    ///
    /// A registered user wallet must sign. The request is closed after its value
    /// is written to the user account.
    pub fn approve_cliff_period(ctx: Context<ApproveCliffPeriod>, user_id: [u8; 32]) -> Result<()> {
        let user = &mut ctx.accounts.user;

        require!(
            is_whitelisted_wallet(user, &ctx.accounts.signer.key()),
            zynk_core::CoreError::InvalidAccount
        );

        let new_cliff_period = ctx.accounts.request.cliff_period;
        user.cliff_period = new_cliff_period;

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
    /// The Core admin or any whitelisted wallet of the associated user may
    /// reject the request. Rent is returned to the authorized signer.
    pub fn reject_cliff_period(ctx: Context<RejectCliffPeriod>, user_id: [u8; 32]) -> Result<()> {
        let signer = ctx.accounts.signer.key();
        require!(
            signer == ctx.accounts.config.admin
                || is_whitelisted_wallet(&ctx.accounts.user, &signer),
            zynk_core::CoreError::Unauthorized
        );

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

    /// Reinvests funds held by the Orbit vault.
    ///
    /// The manager sends ICV funds to User-PDA custody and other user funds to
    /// the canonical Core ZOV, then credits the user's principal balance.
    pub fn pledge(
        ctx: Context<Pledge>,
        user_id: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        require!(amount != 0, OrbitError::ZeroAmount);

        let user = &ctx.accounts.user;

        require!(
            user.principal_in
                .checked_sub(user.principal_out)
                .ok_or(ProgramError::ArithmeticOverflow)?
                .checked_add(amount)
                .ok_or(ProgramError::ArithmeticOverflow)?
                <= user.max_principal as u64,
            OrbitError::MaxDepositExceeded
        );

        let ovault_bump_ref = [ctx.bumps.ovault];
        let signer_seeds = &[&[VAULT_SEED, b"orbit", &ovault_bump_ref][..]];

        let expected_destination = if user.user_type == UserType::ICV {
            user.key()
        } else {
            Pubkey::find_program_address(
                &[zynk_core::ZYNK_OP_VAULT_SEED, hash(b"0001").as_ref()],
                &ZynkCore::id()
            ).0
        };

        require!(
            ctx.accounts.destination_token_account.owner == expected_destination,
            zynk_core::CoreError::InvalidAccount
        );

        transfer_with_signer_seeds(
            &ctx.accounts.token_program,
            &ctx.accounts.source_token_account.to_account_info(),
            &ctx.accounts.destination_token_account.to_account_info(),
            &ctx.accounts.mint,
            &ctx.accounts.ovault.to_account_info(),
            signer_seeds,
            amount,
        )?;

        let user = &mut ctx.accounts.user;
        user.principal_in = user
            .principal_in
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

    /// Burns tokens through Circle CCTP for transfer to another domain.
    ///
    /// The Core-configured manager may transfer from the Orbit vault, a derived
    /// spender vault, or an ICV User PDA. ICV transfers require an elapsed cliff
    /// and an allowed recipient or deployment-time destination caller, and are
    /// recorded in `principal_out`.
    pub fn cctp<'info>(
        ctx: Context<'_, '_, '_, 'info, Cctp<'info>>,
        id: [u8; 32],
        amount: u64,
        destination_domain: u32,
        mint_recipient: [u8; 32],
        destination_caller: Option<[u8; 32]>,
    ) -> Result<()> {
        require!(amount > 0, OrbitError::ZeroAmount);

        let config = &ctx.accounts.config;
        require!(
            config.whitelisted_token_mints.contains(&ctx.accounts.mint.key()),
            zynk_core::CoreError::InvalidTokenMint
        );

        let event_user_id: [u8; 32];
        let (seed_a, seed_b, bump_val): (&[u8], &[u8], u8) = match &mut ctx.accounts.user {
            Some(user) => {
                require!(
                    user.user_type == UserType::ICV,
                    OrbitError::InvalidOperation
                );

                require!(
                    ctx.accounts.authority.key() == user.key(),
                    zynk_core::CoreError::InvalidAccount
                );

                require!(
                    Clock::get()?.unix_timestamp >= user.cliff_period,
                    OrbitError::CliffPeriodNotOver
                );

                let recipient = CctpRecipient {
                    destination_domain,
                    mint_recipient,
                };
                let destination_caller_is_whitelisted = destination_caller
                    .map(|caller| CCTP_WHITELISTED_DESTINATION_CALLERS.contains(&caller))
                    .unwrap_or(false);
                require!(
                    user.cctp_recipients.contains(&recipient)
                        || destination_caller_is_whitelisted,
                    OrbitError::CctpRecipientNotWhitelisted
                );

                user.principal_out = user
                    .principal_out
                    .checked_add(amount)
                    .ok_or(ProgramError::ArithmeticOverflow)?;

                event_user_id = id;
                let bump = ctx.bumps.user.ok_or(zynk_core::CoreError::InvalidAccount)?;
                (USER_SEED, id.as_ref(), bump)
            }
            None => {
                let (expected_ovault, ovault_bump) = Pubkey::find_program_address(
                    &[VAULT_SEED, b"orbit"],
                    ctx.program_id,
                );
                let (expected_spender, spender_bump) = Pubkey::find_program_address(
                    &[VAULT_SEED, id.as_ref()],
                    ctx.program_id,
                );

                if ctx.accounts.authority.key() == expected_ovault {
                    event_user_id = [0u8; 32];
                    (VAULT_SEED, b"orbit", ovault_bump)
                } else if ctx.accounts.authority.key() == expected_spender {
                    event_user_id = id;
                    (VAULT_SEED, id.as_ref(), spender_bump)
                } else {
                    return Err(zynk_core::CoreError::InvalidAccount.into());
                }
            }
        };

        let bump_arr = [bump_val];
        let seeds: &[&[u8]] = &[seed_a, seed_b, &bump_arr];
        let signer_seeds = &[&seeds[..]];

        cpi_cctp_deposit_for_burn(
            &ctx.accounts.cctp_token_messenger_minter_program.to_account_info(),
            ctx.remaining_accounts,
            &ctx.accounts.authority.to_account_info(),
            signer_seeds,
            amount,
            destination_domain,
            mint_recipient,
            destination_caller,
        )?;

        let dest_caller_bytes = destination_caller.unwrap_or([0u8; 32]);
        emit!(CctpEvent {
            event_name: "Cctp".to_string(),
            vault: ctx.accounts.authority.key(),
            user_id: event_user_id,
            amount,
            token: ctx.accounts.mint.key(),
            destination_domain,
            mint_recipient,
            destination_caller: dest_caller_bytes,
            domain_separator: DOMAIN_SEPARATOR,
        });

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct Deposit<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
        constraint = user.wallets.contains(&signer.key()) @ zynk_core::CoreError::Unauthorized,
    )]
    pub user: Account<'info, User>,

    #[account(mut, constraint = source_token_account.owner == signer.key() @ zynk_core::CoreError::InvalidAccount)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = config.whitelisted_token_mints.contains(&mint.key()) @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == source_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == destination_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,

    pub zynk_core_program: Program<'info, ZynkCore>,

    pub signer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(partner_id: String, order_id: [u8; 32], zov_id: [u8; 32])]
pub struct Borrow<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = manager @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    /// CHECK: Core ZOV PDA validated by Core program seeds and `zov_id`.
    #[account(
        seeds = [zynk_core::ZYNK_OP_VAULT_SEED, zov_id.as_ref()],
        seeds::program = ZynkCore::id(),
        bump,
        constraint = zynk_op_vault.key() == zov_token_account.owner @ zynk_core::CoreError::InvalidAccount,
    )]
    pub zynk_op_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub zov_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub beneficiary_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = config.whitelisted_token_mints.contains(&mint.key()) @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == zov_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == beneficiary_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        constraint = beneficiary.public_key == beneficiary_token_account.owner @ zynk_core::CoreError::InvalidBeneficiary,
    )]
    pub beneficiary: Account<'info, zynk_core::Beneficiary>,

    /// CHECK: Core validates and initializes this order tracker during the CPI.
    #[account(mut)]
    pub order_tracker: UncheckedAccount<'info>,

    /// CHECK: Core validates this partner deposit vault during the CPI.
    pub partner_deposit_vault: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,

    #[account(mut)]
    pub manager: Signer<'info>,

    // Remaining accounts (4 per position):
    // [source_token_account, authority_account, user, position_pda]
}

#[derive(Accounts)]
#[instruction(partner_id: [u8; 32], order_id: [u8; 32], zov_id: [u8; 32])]
pub struct Repay<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = manager @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(mut, constraint = zov_token_account.owner == zynk_op_vault.key() @ zynk_core::CoreError::InvalidAccount)]
    pub zov_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = ovault_token_account.owner == ovault.key() @ zynk_core::CoreError::InvalidAccount,
        constraint = ovault_token_account.mint == mint.key() @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub ovault_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = mint.key() == zov_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,

    /// CHECK: Core order tracker validated by Core program seeds and the CPI.
    #[account(
        mut,
        seeds = [zynk_core::ORDER_TRACKER_SEED, partner_id.as_ref(), order_id.as_ref()],
        seeds::program = ZynkCore::id(),
        bump,
    )]
    pub order_tracker: UncheckedAccount<'info>,

    /// CHECK: Core partner deposit vault validated by Core program seeds and the CPI.
    #[account(
        seeds = [zynk_core::PARTNER_DEPOSIT_VAULT_SEED, partner_id.as_ref()],
        seeds::program = ZynkCore::id(),
        bump,
    )]
    pub partner_deposit_vault: UncheckedAccount<'info>,

    /// CHECK: Core validates this PDV token account's authority and mint during the CPI.
    #[account(mut)]
    pub pdv_token_account: UncheckedAccount<'info>,

    /// CHECK: Orbit-owned capability PDA used to authenticate this CPI to zynk-core.
    #[account(
        seeds = [zynk_core::ORBIT_CPI_AUTHORITY_SEED],
        bump,
    )]
    pub orbit_authority: UncheckedAccount<'info>,

    /// CHECK: Core ZOV PDA validated by Core program seeds and the CPI.
    #[account(
        seeds = [zynk_core::ZYNK_OP_VAULT_SEED, zov_id.as_ref()],
        seeds::program = ZynkCore::id(),
        bump,
    )]
    pub zynk_op_vault: UncheckedAccount<'info>,

    /// CHECK: Orbit vault PDA validated by seeds and used as transfer authority.
    #[account(
        seeds = [VAULT_SEED, b"orbit"],
        bump
    )]
    pub ovault: UncheckedAccount<'info>,

    // Remaining accounts (3 per position):
    // [destination_token_account, user, position_pda]
}

#[derive(Accounts)]
#[instruction(vault_id: [u8; 32])]
pub struct Disburse<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = manager @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(mut)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = config.whitelisted_token_mints.contains(&mint.key()) @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == source_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == destination_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Vault PDA validated by seeds and used as transfer authority.
    #[account(
        seeds = [VAULT_SEED, vault_id.as_ref()],
        bump
    )]
    pub spender: UncheckedAccount<'info>,

    pub user: Account<'info, User>,

    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(
    user_id: [u8; 32],
    user_type: UserType,
    wallets: [Pubkey; 3],
    cliff_period: Option<i64>,
    max_principal: Option<u64>,
    whitelisted_partners: Vec<u32>,
    cctp_recipients: Vec<CctpRecipient>
)]
pub struct RegisterUser<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        init,
        payer = admin,
        space = User::space_for_lengths(
            whitelisted_partners.len(),
            cctp_recipients.len(),
        ),
        seeds = [USER_SEED, user_id.as_ref()],
        bump
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct UpdateWallets<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
pub struct Revoke<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct UpdateCliffPeriod<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        init,
        payer = admin,
        space = 8 + UpdateCliffPeriodRequest::INIT_SPACE,
        seeds = [USER_UPDATE_REQUEST_SEED, user_id.as_ref()],
        bump
    )]
    pub request_user: Account<'info, UpdateCliffPeriodRequest>,

    #[account(
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct UpdateMaxPrincipal<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32], action: WhitelistAction)]
pub struct UpdatePartnerWhitelist<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
        realloc = User::space_for_lengths(
            match action {
                WhitelistAction::Add    => user.whitelisted_partners.len().saturating_add(1),
                WhitelistAction::Remove => user.whitelisted_partners.len().saturating_sub(1),
            },
            user.cctp_recipients.len(),
        ),
        realloc::payer = admin,
        realloc::zero = false,
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32], action: WhitelistAction, recipient: CctpRecipient)]
pub struct UpdateCctpRecipient<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
        realloc = User::space_for_lengths(
            user.whitelisted_partners.len(),
            match action {
                WhitelistAction::Add => user.cctp_recipients.len().saturating_add(1),
                WhitelistAction::Remove => user.cctp_recipients.len().saturating_sub(1),
            },
        ),
        realloc::payer = admin,
        realloc::zero = false,
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct RequestWithdraw<'info> {
    #[account(
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub signer_user: Account<'info, User>,

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
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    /// CHECK: The handler deserializes this account as a withdrawal request.
    #[account(mut)]
    pub request: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Optional Orbit vault PDA validated by seeds for LP withdrawals.
    #[account(
        seeds = [VAULT_SEED, b"orbit"],
        bump
    )]
    pub ovault: Option<UncheckedAccount<'info>>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
pub struct RejectWithdraw<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = admin @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    /// CHECK: The admin-authorized handler closes this supplied request account.
    #[account(mut)]
    pub request: UncheckedAccount<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct ApproveCliffPeriod<'info> {
    #[account(
        mut,
        constraint = request.user_id == user_id @ OrbitError::UserIdMismatch
    )]
    pub request: Account<'info, UpdateCliffPeriodRequest >,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct RejectCliffPeriod<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        constraint = request.user_id == user_id @ OrbitError::UserIdMismatch
    )]
    pub request: Account<'info, UpdateCliffPeriodRequest >,

    #[account(
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32], operations: Vec<ClaimOperation>)]
pub struct Claim<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
        constraint = user.user_type != UserType::LP @ OrbitError::InvalidOperation,
    )]
    pub user: Account<'info, User>,

    /// ICV custody account. Pass None for NCW claims.
    #[account(mut)]
    pub icv_token_account: Option<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = mint.key() == destination_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    pub signer: Signer<'info>,

    /// CHECK: Core manager receives rent from closed Core trackers and Orbit positions.
    #[account(mut, address = config.manager @ zynk_core::CoreError::Unauthorized)]
    pub core_manager: UncheckedAccount<'info>,

    /// CHECK: Orbit-owned capability PDA used to authenticate Core CPIs.
    #[account(seeds = [zynk_core::ORBIT_CPI_AUTHORITY_SEED], bump)]
    pub orbit_authority: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(user_id: [u8; 32])]
pub struct Pledge<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = manager @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(mut)]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [USER_SEED, user_id.as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,

    #[account(
        constraint = mint.key() == source_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
        constraint = mint.key() == destination_token_account.mint @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    pub manager: Signer<'info>,

    /// CHECK: Orbit vault PDA validated by seeds and used as transfer authority.
    #[account(
        seeds = [VAULT_SEED, b"orbit"],
        bump
    )]
    pub ovault: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    pub zynk_core_program: Program<'info, ZynkCore>,
}

#[derive(Accounts)]
#[instruction(id: [u8; 32])]
pub struct Cctp<'info> {
    #[account(
        seeds = [zynk_core::CONFIG_SEED],
        seeds::program = ZynkCore::id(),
        bump,
        has_one = manager @ zynk_core::CoreError::Unauthorized
    )]
    pub config: Account<'info, zynk_core::Config>,

    #[account(
        mut,
        constraint = source_token_account.owner == authority.key() @ zynk_core::CoreError::InvalidAccount,
        constraint = source_token_account.mint == mint.key() @ zynk_core::CoreError::InvalidTokenMint,
    )]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Handler validates the authority as the Orbit vault, derived spender, or supplied User PDA.
    pub authority: UncheckedAccount<'info>,

    /// Optional User account. Pass Some when transferring from an ICV User.
    #[account(
        mut,
        seeds = [USER_SEED, id.as_ref()],
        bump,
    )]
    pub user: Option<Account<'info, User>>,

    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    pub zynk_core_program: Program<'info, ZynkCore>,

    /// CHECK: Manager-authorized instruction forwards this account as the CCTP CPI target.
    pub cctp_token_messenger_minter_program: UncheckedAccount<'info>,
}

#[error_code]
pub enum OrbitError {
    #[msg("Amount should not be zero")]
    ZeroAmount,
    #[msg("Cliff period must be in the future")]
    CliffPeriodInPast,
    #[msg("Pda is not owned by this contract")]
    PdaNotOwnedByContract,
    #[msg("User ID mismatch between signer and destination users")]
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
    MaxPrincipalBelowBalance,
    #[msg("Partner is not in the whitelist")]
    PartnerNotWhitelisted,
    #[msg("Partner is already in the whitelist")]
    PartnerAlreadyWhitelisted,
    #[msg("Invalid partner ID format")]
    InvalidPartnerId,
    #[msg("Repay amount exceeds remaining order amount")]
    ExcessiveRepay,
    #[msg("Source token account has insufficient token balance for withdrawal")]
    InsufficientTokenBalance,
    #[msg("CCTP recipient is not whitelisted")]
    CctpRecipientNotWhitelisted,
    #[msg("CCTP recipient is already whitelisted")]
    CctpRecipientAlreadyWhitelisted,
}

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self,
    Mint,
    TokenAccount,
    TokenInterface,
    TransferChecked,
};
use anchor_lang::solana_program::{
    pubkey::Pubkey,
    system_program::ID as SYSTEM_PROGRAM_ID,
    program_error::ProgramError,
};

declare_id!("ZYNKctWoaYeAdN9szq1joeu6rRPf7LK72pUurkcBpBY");

pub const DOMAIN_SEPARATOR: u64 = 115111123810997;
pub const INITIAL_MANAGER: Pubkey = pubkey!("FnN6veEuyCr3R88iHxZYFRPwq22CZQwPMXzaTomeWWX5");


#[error_code]
pub enum CustomError {
    #[msg("Unauthorized signer")]
    Unauthorized,
    #[msg("Invalid address: cannot use null address")]
    InvalidAddress,
    #[msg("Contract is paused")]
    ContractPaused,
    #[msg("Invalid order")]
    InvalidOrder,
    #[msg("Invalid account")]
    InvalidAccount,
    #[msg("Invalid token mint")]
    InvalidTokenMint,
    #[msg("Invalid beneficiary or it's state")]
    InvalidBeneficiary,
    #[msg("Deployed amount must be replenished")]
    DeficientOrder,
    #[msg("Action under review")]
    ActionUnderReview,
    #[msg("Action already executed")]
    AlreadyExecuted,
    #[msg("Invalid action")]
    InvalidAction,
    #[msg("Whitelisted token mints must be non-empty")]
    EmptyWhitelistedTokenMints,
    #[msg("Whitelisted token mints must be unique")]
    DuplicateWhitelistedTokenMint
}


#[account]
#[derive(InitSpace)]
pub struct Config {
    pub paused: bool,
    pub admin: Pubkey,
    pub manager: Pubkey,
    pub guardian: Pubkey,
    #[max_len(8)]
    pub whitelisted_token_mints: Vec<Pubkey>,
}

#[account]
#[derive(InitSpace)]
pub struct OrderTracker {
    pub order_id: [u8; 32],
    pub partner_id: [u8; 32],
    pub amount_in: u64,
    pub amount_out: u64,
    pub zynk_op_vault: Pubkey,
    pub beneficiary_wallet: Pubkey,
    pub partner_deposit_vault: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Timelock {
    pub action: u8,             // Enum tag for the action
    pub value: Pubkey,          // New value (wallet address)
    pub eta: i64,               // Earliest time the action can be executed
    pub req_by: Pubkey,         // Requested by
    pub ack_by: Option<Pubkey>, // Acknowledged by - Optional
}

#[account]
#[derive(InitSpace)]
pub struct Beneficiary {
    pub partner_id: [u8; 32],
    pub public_key: Pubkey,
    pub is_active: bool,
    pub allow_transient: bool
}


#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
#[repr(u8)]
pub enum ActionStatus {
    Initiated,
    Acked,
    Executed,
    Revoked
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
#[repr(u8)]
pub enum TimelockAction {
    UpdateAdmin,
    UpdateManager,
    UpdateGuardian,
    Unpause,
}

impl TimelockAction {
    pub fn delay(&self) -> i64 {
        match self {
            TimelockAction::UpdateAdmin => 24 * 60 * 60,           // 24 hours
            TimelockAction::UpdateManager => 12 * 60 * 60,         // 12 hours
            TimelockAction::UpdateGuardian => 48 * 60 * 60,        // 48 hours
            TimelockAction::Unpause => 6 * 60 * 60,                // 6 hours
        }
    }
}

impl TryFrom<u8> for TimelockAction {
    type Error = CustomError;

    fn try_from(value: u8) -> std::result::Result<Self, Self::Error> {
        match value {
            0 => Ok(TimelockAction::UpdateAdmin),
            1 => Ok(TimelockAction::UpdateManager),
            2 => Ok(TimelockAction::UpdateGuardian),
            3 => Ok(TimelockAction::Unpause),
            _ => Err(CustomError::InvalidAction.into()),
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EventArg {
    pub key: String,
    pub value: String,
}

#[event]
pub struct Action {
    pub action: u8,
    pub timelock: Pubkey,
    pub status: ActionStatus,
    pub timestamp: i64,
    pub signer: Pubkey,
}

#[event]
pub struct BeneficiaryAction {
    pub action: String,
    pub partner_id: [u8; 32],
    pub public_key: Pubkey,
    pub is_active: bool,
    pub domain_separator: u64,
}

#[event]
pub struct OrderCreated {
    pub order_id: [u8; 32],
    pub token: String,
    pub zynk_op_vault: String,
    pub beneficiary_wallet: String,
    pub partner_deposit_vault: String,
    pub amount: u64,
    pub transient: bool,
    pub domain_separator: u64,
    pub meta: Option<Vec<EventArg>>
}

#[event]
pub struct OrderReplenished {
    pub order_id: [u8; 32],
    pub token: String,
    pub zynk_op_vault: String,
    pub partner_deposit_vault: String,
    pub amount: u64,
    pub order_closed: bool,
    pub domain_separator: u64,
    pub meta: Option<Vec<EventArg>>
}

#[event]
pub struct OrdersClosed {
    pub order_ids: Vec<[u8; 32]>,
    pub domain_separator: u64,
    pub meta: Option<Vec<EventArg>>
}

/// Helper function to validate an address is not the null address
pub fn validate_address(address: &Pubkey) -> Result<()> {
    require!(*address != Pubkey::default(), CustomError::InvalidAddress);
    Ok(())
}

/// Helper to validate there are no duplicate mints.
pub fn validate_unique_token_mints(token_mints: &[Pubkey]) -> Result<()> {
    let mut sorted = token_mints.to_vec();
    sorted.sort_unstable();

    for pair in sorted.windows(2) {
        require!(pair[0] != pair[1], CustomError::DuplicateWhitelistedTokenMint);
    }

    Ok(())
}


/// Closes an account and transfers lamports to the given destination.
/// Also zeroes out the account data to prevent reuse.
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
pub mod zynk_core {
    use super::*;

    /// Initializes the program configuration and core authority roles.
    ///
    /// # Arguments
    /// * `ctx` - The [`Initialize`] context containing the config and admin accounts.
    /// * `admin` - The admin address authorized for administrative operations.
    /// * `guardian` - The guardian address with emergency and oversight privileges.
    /// * `whitelisted_token_mints` - A non-empty list of SPL token mints allowed by the program.
    ///
    /// # Behavior
    /// - Sets the manager to the transaction signer.
    /// - Validates that at least one token mint is whitelisted.
    /// - Ensures all provided token mint addresses are valid.
    /// - Stores program's authority roles and configuration.
    /// - Initializes the program in an unpaused state.
    ///
    /// # Errors
    /// - `EmptyWhitelistedTokenMints` if no token mints are provided.
    /// - `DuplicateWhitelistedTokenMint` if duplicate token mints are provided.
    /// - Any error returned by address validation.
    pub fn initialize(
        ctx: Context<Initialize>,
        admin: Pubkey,
        guardian: Pubkey,
        whitelisted_token_mints: Vec<Pubkey>
    ) -> Result<()> {
        validate_address(&admin)?;
        validate_address(&guardian)?;

        let config = &mut ctx.accounts.config;
        config.paused = false;

        config.manager = ctx.accounts.manager.key();
        config.admin = admin;
        config.guardian = guardian;

        require!(whitelisted_token_mints.len() > 0, CustomError::EmptyWhitelistedTokenMints);
        for token_mint in whitelisted_token_mints.iter() {
            validate_address(token_mint)?;
        }
        validate_unique_token_mints(&whitelisted_token_mints)?;
        config.whitelisted_token_mints = whitelisted_token_mints;

        Ok(())
    }


    /// Pulls tokens from a partner deposit vault, forwards them to a beneficiary,
    /// and creates a corresponding order.
    ///
    /// # Arguments
    /// * `ctx` - The [`CreateOrder`] context containing all required accounts.
    /// * `partner_id` - The unique identifier of the partner (32 bytes, hashed off-chain).
    /// * `order_id` - The unique identifier of the order (32 bytes, hashed off-chain).
    /// * `zov_id` - The unique identifier of the ZOV to use (32 bytes, hashed off-chain).
    /// * `transient` - Flag to create (and close) transient orders.
    /// * `amount` - The amount of tokens to transfer.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the program is paused.
    /// - Validates the partner deposit vault token authority and token mint.
    /// - Transfers tokens from the partner deposit vault to the Zynk Operational vault.
    /// - Transfers tokens from the Zynk Operational vault to the beneficiary.
    /// - Records order details in an `OrderTracker` PDA unless executed transiently.
    /// - Immediately closes the order tracker for transient orders.
    /// - Emits an `OrderCreated` event.
    ///
    /// # Notes
    /// - Transient orders do not persist on-chain state.
    /// - `order_id` must be exactly 32 bytes.
    pub fn pull_and_create_order(
        ctx: Context<CreateOrder>,
        partner_id: [u8; 32],
        order_id: [u8; 32],
        zov_id: [u8; 32],
        transient: bool,
        amount: u64,
        meta: Option<Vec<EventArg>>
    ) -> Result<()> {
        // Check if program is paused.
        let config = &ctx.accounts.config;
        require!(!config.paused, CustomError::ContractPaused);
        require!(amount > 0, CustomError::InvalidOrder);

        let beneficiary_wallet = ctx.accounts.beneficiary_token_account.owner.key();
        let partner_deposit_vault = &ctx.accounts.partner_deposit_vault;
        let zynk_op_vault = &ctx.accounts.zynk_op_vault;
        let pdv_token_account = ctx.accounts.pdv_token_account.as_ref().ok_or(CustomError::InvalidAccount)?;

        require!(pdv_token_account.owner == partner_deposit_vault.key(), CustomError::InvalidAccount);
        require!(pdv_token_account.mint == ctx.accounts.zov_token_account.mint, CustomError::InvalidTokenMint);

        // Perform token transfer from pdv_token_account to zov_token_account.
        let cpi_accounts = TransferChecked {
            from: pdv_token_account.to_account_info(),
            to: ctx.accounts.zov_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: partner_deposit_vault.to_account_info(),
        };

        let seeds = &[
            PARTNER_DEPOSIT_VAULT_SEED,
            partner_id.as_ref(),
            &[ctx.bumps.partner_deposit_vault],
        ];
        let signer_seeds = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        // Perform token transfer from zov_token_account to beneficiary_token_account.
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.zov_token_account.to_account_info(),
            to: ctx.accounts.beneficiary_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: zynk_op_vault.to_account_info(),
        };

        let seeds = &[
            ZYNK_OP_VAULT_SEED,
            zov_id.as_ref(),
            &[ctx.bumps.zynk_op_vault],
        ];
        let signer_seeds = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        let order_tracker = &mut ctx.accounts.order_tracker;
        if transient {
            close_account(order_tracker, &ctx.accounts.manager)?;
        } else {
            order_tracker.partner_id = partner_id;
            order_tracker.order_id = order_id;
            order_tracker.amount_in = amount;
            order_tracker.amount_out = amount;
            order_tracker.zynk_op_vault = zynk_op_vault.key();
            order_tracker.beneficiary_wallet = beneficiary_wallet;
            order_tracker.partner_deposit_vault = partner_deposit_vault.key();
        }

        emit!(OrderCreated {
            order_id,
            zynk_op_vault: zynk_op_vault.key().to_string(),
            beneficiary_wallet: beneficiary_wallet.to_string(),
            token: ctx.accounts.mint.key().to_string(),
            partner_deposit_vault: partner_deposit_vault.key().to_string(),
            amount,
            transient,
            domain_separator: DOMAIN_SEPARATOR,
            meta
        });

        Ok(())
    }

    /// Creates an order and optionally transfers tokens from the Zynk Operational vault
    /// to the beneficiary.
    ///
    /// # Arguments
    /// * `ctx` - The [`CreateOrder`] context containing all required accounts.
    /// * `partner_id` - The unique identifier of the partner (32 bytes, hashed off-chain).
    /// * `order_id` - The unique identifier of the order (32 bytes, hashed off-chain).
    /// * `zov_id` - The unique identifier of the ZOV to use (32 bytes, hashed off-chain).
    /// * `transient` - Flag to create (and close) transient orders.
    /// * `amount` - The amount of tokens to transfer.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the program is paused.
    /// - Optionally verifies a manager signature for transient execution.
    /// - Transfers tokens from the Zynk Operational vault to the beneficiary if `amount > 0`.
    /// - Records order details in an `OrderTracker` PDA unless executed transiently.
    /// - Immediately closes the order tracker for transient orders.
    /// - Emits an `OrderCreated` event.
    ///
    /// # Notes
    /// - Transient orders do not persist on-chain state.
    /// - `order_id` must be exactly 32 bytes.
    pub fn create_order(
        ctx: Context<CreateOrder>,
        partner_id: [u8; 32],
        order_id: [u8; 32],
        zov_id: [u8; 32],
        transient: bool,
        amount: u64,
        meta: Option<Vec<EventArg>>
    ) -> Result<()> {
        // Check if program is paused.
        let config = &ctx.accounts.config;
        require!(!config.paused, CustomError::ContractPaused);
        require!(
            ctx.accounts.beneficiary.allow_transient || !transient,
            CustomError::InvalidBeneficiary
        );

        let beneficiary_wallet = ctx.accounts.beneficiary_token_account.owner.key();
        let partner_deposit_vault = ctx.accounts.partner_deposit_vault.key();
        let zynk_op_vault = ctx.accounts.zynk_op_vault.key();

        if amount != 0 {
            // Perform token transfer from zov_token_account to beneficiary_token_account.
            let cpi_accounts = TransferChecked {
                from: ctx.accounts.zov_token_account.to_account_info(),
                to: ctx.accounts.beneficiary_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.zynk_op_vault.to_account_info(),
            };

            let seeds = &[
                ZYNK_OP_VAULT_SEED,
                zov_id.as_ref(),
                &[ctx.bumps.zynk_op_vault],
            ];
            let signer_seeds = &[&seeds[..]];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;
        }

        let order_tracker = &mut ctx.accounts.order_tracker;
        if transient {
            close_account(order_tracker, &ctx.accounts.manager)?;
        } else {
            order_tracker.partner_id = partner_id;
            order_tracker.order_id = order_id;
            order_tracker.amount_out = amount;
            order_tracker.zynk_op_vault = zynk_op_vault;
            order_tracker.beneficiary_wallet = beneficiary_wallet;
            order_tracker.partner_deposit_vault = partner_deposit_vault;
        }

        emit!(OrderCreated {
            order_id,
            zynk_op_vault: zynk_op_vault.to_string(),
            beneficiary_wallet: beneficiary_wallet.to_string(),
            token: ctx.accounts.mint.key().to_string(),
            partner_deposit_vault: partner_deposit_vault.to_string(),
            amount,
            transient,
            domain_separator: DOMAIN_SEPARATOR,
            meta
        });

        Ok(())
    }

    /// Replenishes an existing order by transferring tokens into the Zynk Operational vault.
    ///
    /// # Arguments
    /// * `ctx` - The [`Replenish`] context containing all required accounts.
    /// * `amount` - The amount of tokens to transfer into the order.
    /// * `close_order` - Whether the order should be closed after replenishment.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the contract is paused.
    /// - Transfers tokens from the partner deposit vault to the Zynk Operational vault.
    /// - Updates the tracked input amount for the order.
    /// - Optionally closes the order if conditions are met.
    /// - Emits an `OrderReplenished` event.
    pub fn replenish(
        ctx: Context<Replenish>,
        amount: u64,
        close_order: bool,
        meta: Option<Vec<EventArg>>
    ) -> Result<()> {
        // Check if program is paused.
        require!(!ctx.accounts.config.paused, CustomError::ContractPaused);

        let order_tracker = &mut ctx.accounts.order_tracker;
        let partner_deposit_vault = &ctx.accounts.partner_deposit_vault;

        if amount > 0 {
            // Perform token transfer from pdv_token_account to zov_token_account.
            let cpi_accounts = TransferChecked {
                from: ctx.accounts.pdv_token_account.to_account_info(),
                to: ctx.accounts.zov_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: partner_deposit_vault.to_account_info(),
            };
            let seeds = &[
                PARTNER_DEPOSIT_VAULT_SEED,
                order_tracker.partner_id.as_ref(),
                &[ctx.bumps.partner_deposit_vault],
            ];
            let signer_seeds = &[&seeds[..]];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

            order_tracker.amount_in = order_tracker.amount_in
                .checked_add(amount)
                .ok_or(ProgramError::ArithmeticOverflow)?;
        } else {
            require!(order_tracker.amount_in >= order_tracker.amount_out, CustomError::DeficientOrder);
        }

        // If close_order flag is true, perform order closure
        if close_order {
            // Check if order_tracker's amount_in is greater than or equal to the order_tracker's amount_out
            require!(order_tracker.amount_in >= order_tracker.amount_out, CustomError::DeficientOrder);

            // Close the order_tracker account (transfer lamports to manager and clear data)
            close_account(&mut *order_tracker, &ctx.accounts.manager)?;
        }

        emit!(OrderReplenished {
            order_id: order_tracker.order_id,
            zynk_op_vault: order_tracker.zynk_op_vault.to_string(),
            token: ctx.accounts.mint.key().to_string(),
            partner_deposit_vault: partner_deposit_vault.key().to_string(),
            amount,
            order_closed: close_order,
            domain_separator: DOMAIN_SEPARATOR,
            meta
        });

        Ok(())
    }

    /// Records an order executed on an external chain (e.g. EVM) and logs the corresponding event.
    ///
    /// # Arguments
    /// * `ctx` - The [`RecordOrder`] context.
    /// * `partner_id` - The unique identifier of the partner (32 bytes, hashed off-chain).
    /// * `order_id` - The unique identifier of the order (32 bytes, hashed off-chain).
    /// * `token` - The token address/identifier string.
    /// * `zynk_op_vault` - The Zynk Operational vault address/identifier string.
    /// * `partner_deposit_vault` - The partner deposit vault address/identifier string.
    /// * `beneficiary_wallet` - The beneficiary wallet address/identifier string.
    /// * `amount` - The amount of tokens for the order.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the program is paused or amount is zero.
    /// - If the `OrderTracker` does not exist (open order), initializes it and emits `OrderCreated`.
    /// - If the `OrderTracker` already exists (replenishing/closing order), updates tracked amounts,
    ///   closes the `OrderTracker` PDA if replenished (`amount_in >= amount_out`), and emits `OrderReplenished`.
    pub fn record_order(
        ctx: Context<RecordOrder>,
        partner_id: [u8; 32],
        order_id: [u8; 32],
        token: String,
        zynk_op_vault: String,
        partner_deposit_vault: String,
        beneficiary_wallet: String,
        amount: u64,
        domain_separator: Option<u64>,
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, CustomError::ContractPaused);
        require!(amount > 0, CustomError::InvalidOrder);

        let order_tracker = &mut ctx.accounts.order_tracker;

        if order_tracker.order_id != [0u8; 32] {
            require!(order_tracker.partner_id == partner_id, CustomError::InvalidOrder);
            require!(order_tracker.order_id == order_id, CustomError::InvalidOrder);

            order_tracker.amount_in = order_tracker.amount_in
                .checked_add(amount)
                .ok_or(ProgramError::ArithmeticOverflow)?;

            let order_closed = order_tracker.amount_in >= order_tracker.amount_out;
            if order_closed {
                close_account(order_tracker, &ctx.accounts.manager)?;
            }

            emit!(OrderReplenished {
                order_id,
                token,
                zynk_op_vault,
                partner_deposit_vault,
                amount,
                order_closed,
                domain_separator: domain_separator.unwrap_or(DOMAIN_SEPARATOR),
                meta
            });


        } else {
            order_tracker.partner_id = partner_id;
            order_tracker.order_id = order_id;
            order_tracker.amount_out = amount;

            emit!(OrderCreated {
                order_id,
                token,
                zynk_op_vault,
                beneficiary_wallet,
                partner_deposit_vault,
                amount,
                transient: false,
                domain_separator: domain_separator.unwrap_or(DOMAIN_SEPARATOR),
                meta
            });
        }

        Ok(())
    }

    /// Closes multiple order tracker accounts in a single instruction.
    ///
    /// # Arguments
    /// * `ctx` - The [`CloseOrders`] context.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the contract is paused.
    /// - Iterates over remaining accounts and closes each unique order tracker.
    /// - Emits an `OrdersClosed` event with all closed order IDs.
    pub fn close_orders(ctx: Context<CloseOrders>, meta: Option<Vec<EventArg>>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(!config.paused, CustomError::ContractPaused);

        let mut seen_accounts = Vec::<Pubkey>::new();
        let mut order_ids = Vec::<[u8; 32]>::new();
        for account_info in ctx.remaining_accounts.iter() {
            require!(account_info.owner == ctx.program_id, CustomError::InvalidOrder);

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

    ////////////////////////////////////////////////////////////////
    //////////////////// beneficiary whitelist /////////////////////
    ////////////////////////////////////////////////////////////////


    pub fn whitelist_beneficiary(ctx: Context<WhitelistBeneficiary>, partner_id: [u8; 32], public_key: Pubkey, allow_transient: bool) -> Result<()> {
        let beneficiary = &mut ctx.accounts.beneficiary;

        let is_active = true;
        beneficiary.public_key = public_key;
        beneficiary.partner_id = partner_id;
        beneficiary.is_active = is_active;
        beneficiary.allow_transient = allow_transient;

        emit!(BeneficiaryAction {
            action: String::from("whitelist"),
            partner_id,
            public_key,
            is_active,
            domain_separator: DOMAIN_SEPARATOR
        });

        Ok(())
    }

    pub fn toggle_beneficiary(ctx: Context<ToggleBeneficiary>) -> Result<()> {
        let beneficiary = &mut ctx.accounts.beneficiary;

        let is_active = !beneficiary.is_active;
        beneficiary.is_active = is_active;

        emit!(BeneficiaryAction {
            action: String::from("toggle"),
            partner_id: beneficiary.partner_id,
            public_key: beneficiary.public_key,
            is_active,
            domain_separator: DOMAIN_SEPARATOR
        });

        Ok(())
    }

    pub fn revoke_beneficiary(ctx: Context<RevokeBeneficiary>) -> Result<()> {
        let beneficiary = &ctx.accounts.beneficiary;

        emit!(BeneficiaryAction {
            action: String::from("revoke"),
            partner_id: beneficiary.partner_id,
            public_key: beneficiary.public_key,
            is_active: false,
            domain_separator: DOMAIN_SEPARATOR
        });

        Ok(())
    }


    ////////////////////////////////////////////////////////////////
    /////////////////// critical functionalities ///////////////////
    ////////////////////////////////////////////////////////////////


    /// Requests a timelocked administrative action.
    ///
    /// # Arguments
    /// * `ctx` - The [`RequestTimelock`] context.
    /// * `action_u8` - The encoded timelock action.
    /// * `value` - Optional value associated with the action.
    ///
    /// # Behavior
    /// - Computes the ETA based on the action delay.
    /// - Stores the request in a timelock account.
    /// - Emits an `Action::Initiated` event.
    pub fn request_timelock(
        ctx: Context<RequestTimelock>,
        action_u8: u8,
        value: Option<Pubkey>,
    ) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let timestamp = Clock::get()?.unix_timestamp;
        let timelock = &mut ctx.accounts.timelock;
        let action: TimelockAction = action_u8.try_into()?;

        timelock.action = action_u8;
        timelock.value = value.unwrap_or(Pubkey::default());
        timelock.eta = timestamp + action.delay();
        timelock.req_by = authority;

        emit!(Action {
            action: action_u8,
            timelock: timelock.key(),
            status: ActionStatus::Initiated,
            timestamp,
            signer: authority,
        });

        Ok(())
    }

    /// Revokes a pending timelock action
    ///
    /// # Arguments
    /// * `ctx` - The [`SignTimelock`] context containing the timelock account.
    ///
    /// # Behavior
    /// - Verifies the authority is not the requester.
    /// - Closes the timelock account.
    /// - Emits an `Action::Revoked` event.
    pub fn revoke_timelock(ctx: Context<SignTimelock>) -> Result<()> {
        let authority = &ctx.accounts.authority;
        let timelock = &ctx.accounts.timelock;

        require!(timelock.req_by != authority.key(), CustomError::Unauthorized);

        close_account(timelock, authority)?;

        emit!(Action {
            action: timelock.action,
            timelock: timelock.key(),
            status: ActionStatus::Revoked,
            timestamp: Clock::get()?.unix_timestamp,
            signer: authority.key(),
        });

        Ok(())
    }

    /// Acknowledges a timelock action, marking it as reviewed.
    ///
    /// # Arguments
    /// * `ctx` - The [`SignTimelock`] context containing the timelock account.
    ///
    /// # Behavior
    /// - Verifies the timelock is not already acknowledged.
    /// - Verifies the authority is not the requester.
    /// - Marks the timelock request as acknowledged.
    /// - Emits an `Action::Acked` event.
    pub fn ack_timelock(ctx: Context<SignTimelock>) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let timelock = &mut ctx.accounts.timelock;

        require!(timelock.req_by != authority, CustomError::Unauthorized);
        require!(timelock.ack_by.is_none(), CustomError::Unauthorized);

        timelock.ack_by = Some(authority);

        emit!(Action {
            action: timelock.action,
            timelock: timelock.key(),
            status: ActionStatus::Acked,
            timestamp: Clock::get()?.unix_timestamp,
            signer: authority,
        });

        Ok(())
    }

    /// Executes a timelocked request after conditions are met.
    ///
    /// # Arguments
    /// * `ctx` - The [`SignTimelock`] context containing the timelock and config accounts.
    ///
    /// # Behavior
    /// - Validates timelock execution conditions based on action type.
    /// - Requires acknowledgment for guardian updates.
    /// - Updates the corresponding configuration field.
    /// - Marks the timelock action as executed.
    /// - Emits an `Action::Executed` event.
    pub fn execute_request(ctx: Context<SignTimelock>) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let timestamp = Clock::get()?.unix_timestamp;
        let timelock = &mut ctx.accounts.timelock;
        let action: TimelockAction = timelock.action.try_into()?;

        require!(timelock.req_by != authority, CustomError::Unauthorized);
        require!(timelock.ack_by != Some(authority), CustomError::Unauthorized);

        let acked = timelock.ack_by.is_some();
        let eta_ready = timestamp >= timelock.eta;

        let ok = if action == TimelockAction::UpdateGuardian {
            eta_ready && acked
        } else {
            eta_ready || acked
        };

        require!(ok, CustomError::ActionUnderReview);

        let value = timelock.value;
        validate_address(&value)?;

        let config = &mut ctx.accounts.config;

        match action {
            TimelockAction::UpdateAdmin => config.admin = value,
            TimelockAction::UpdateManager => config.manager = value,
            TimelockAction::UpdateGuardian => config.guardian = value,
            _ => return Err(error!(CustomError::InvalidAction)),
        }

        emit!(Action {
            action: timelock.action,
            timelock: timelock.key(),
            status: ActionStatus::Executed,
            timestamp,
            signer: authority,
        });

        Ok(())
    }

    /// Executes an unpause action after timelock conditions are satisfied.
    ///
    /// # Arguments
    /// * `ctx` - The [`SignTimelock`] context containing the timelock and config accounts.
    ///
    /// # Behavior
    /// - Ensures the action corresponds to `Unpause`.
    /// - Requires ETA expiration or prior acknowledgment.
    /// - Sets the contract paused state to `false`.
    /// - Marks the timelock action as executed.
    /// - Emits an `Action::Executed` event.
    pub fn unpause(ctx: Context<SignTimelock>) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let timestamp = Clock::get()?.unix_timestamp;
        let timelock = &mut ctx.accounts.timelock;

        require!(TimelockAction::try_from(timelock.action)? == TimelockAction::Unpause, CustomError::InvalidAction);

        let acked = timelock.ack_by.is_some();
        let eta_ready = timestamp >= timelock.eta;
        require!(eta_ready || acked, CustomError::ActionUnderReview);

        let config = &mut ctx.accounts.config;

        config.paused = false;

        emit!(Action {
            action: timelock.action,
            timelock: timelock.key(),
            status: ActionStatus::Executed,
            timestamp,
            signer: authority,
        });

        Ok(())
    }

    /// Immediately pauses the contract.
    ///
    /// # Arguments
    /// * `ctx` - The [`Pause`] context containing the authority and config accounts.
    ///
    /// # Authorization
    /// May be called by the admin or manager.
    ///
    /// # Behavior
    /// - Sets the contract paused state to `true`.
    /// - Fails if the signer is not an authorized role.
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        let config = &mut ctx.accounts.config;

        config.paused = true;
        Ok(())
    }
}


/// Seed for the global config PDA
pub const CONFIG_SEED: &[u8] = b"config::v4";
/// Seed for the global timelock PDA
pub const TIMELOCK_SEED: &[u8] = b"timelock";
/// Seed for order tracker PDAs
pub const ORDER_TRACKER_SEED: &[u8] = b"order_tracker";
/// Seed for partner deposit vault PDA
pub const PARTNER_DEPOSIT_VAULT_SEED: &[u8] = b"partner_deposit_vault";
/// Seed for Zynk Operational vault PDA
pub const ZYNK_OP_VAULT_SEED: &[u8] = b"zynk_op_vault";
/// Seed for Beneficiary PDA
pub const BENEFICIARY_SEED: &[u8] = b"beneficiary";


#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = manager,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        // constraint = manager.key() == INITIAL_MANAGER @ CustomError::Unauthorized
    )]
    pub manager: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(partner_id: [u8; 32], order_id: [u8; 32], zov_id: [u8; 32], transient: bool)]
pub struct CreateOrder<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CustomError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub manager: Signer<'info>,

    // Tokens pulled in from
    /// CHECK: Partner deposit vault PDA - verified by seeds
    #[account(
        seeds = [PARTNER_DEPOSIT_VAULT_SEED, partner_id.as_ref()],
        bump
    )]
    pub partner_deposit_vault: UncheckedAccount<'info>,
    // optional - used only for pull_and_create_order
    #[account(mut)]
    pub pdv_token_account: Option<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Zynk Operational vault PDA - verified by seeds
    #[account(
        seeds = [ZYNK_OP_VAULT_SEED, zov_id.as_ref()],
        bump,
    )]
    pub zynk_op_vault: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = zov_token_account.owner == zynk_op_vault.key() @ CustomError::InvalidAccount,
        constraint = zov_token_account.mint == mint.key() @ CustomError::InvalidTokenMint
    )]
    pub zov_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        seeds = [BENEFICIARY_SEED, partner_id.as_ref(), beneficiary_token_account.owner.as_ref()],
        bump,
        constraint = beneficiary.is_active @ CustomError::InvalidBeneficiary,
        constraint = beneficiary.public_key == beneficiary_token_account.owner @ CustomError::InvalidBeneficiary,
    )]
    pub beneficiary: Account<'info, Beneficiary>,

    // Tokens sent out to
    #[account(
        mut,
        constraint = beneficiary_token_account.mint == zov_token_account.mint @ CustomError::InvalidAccount,
        constraint = beneficiary_token_account.owner != zynk_op_vault.key() @ CustomError::InvalidAccount,
    )]
    pub beneficiary_token_account: InterfaceAccount<'info, TokenAccount>,

    // Order tracker PDA
    #[account(
        init,
        payer = manager,
        space = 8 + OrderTracker::INIT_SPACE,
        seeds = [ORDER_TRACKER_SEED, partner_id.as_ref(), order_id.as_ref()],
        bump
    )]
    pub order_tracker: Account<'info, OrderTracker>,

    #[account(
        constraint = config.whitelisted_token_mints.contains(&mint.key()) @ CustomError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Replenish<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CustomError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub manager: Signer<'info>,

    // Order tracker PDA
    #[account(
        mut,
        seeds = [ORDER_TRACKER_SEED, order_tracker.partner_id.as_ref(), order_tracker.order_id.as_ref()],
        bump,
    )]
    pub order_tracker: Account<'info, OrderTracker>,

    // Tokens pulled in from
    /// CHECK: Partner deposit vault PDA - verified by seeds
    #[account(
        seeds = [PARTNER_DEPOSIT_VAULT_SEED, order_tracker.partner_id.as_ref()],
        bump,
        constraint = partner_deposit_vault.key() == order_tracker.partner_deposit_vault @ CustomError::InvalidAccount,
    )]
    pub partner_deposit_vault: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = pdv_token_account.owner == partner_deposit_vault.key() @ CustomError::InvalidAccount,
        constraint = pdv_token_account.mint == zov_token_account.mint @ CustomError::InvalidTokenMint
    )]
    pub pdv_token_account: InterfaceAccount<'info, TokenAccount>,

    // Tokens pulled in to
    #[account(
        mut,
        constraint = zov_token_account.owner == order_tracker.zynk_op_vault @ CustomError::InvalidAccount,
        constraint = zov_token_account.mint == mint.key() @ CustomError::InvalidTokenMint
    )]
    pub zov_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = config.whitelisted_token_mints.contains(&mint.key()) @ CustomError::InvalidTokenMint,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseOrders<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        constraint = authority.key() == config.admin || authority.key() == config.guardian @ CustomError::Unauthorized,
    )]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(partner_id: [u8; 32], order_id: [u8; 32])]
pub struct RecordOrder<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CustomError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        init_if_needed,
        payer = manager,
        space = 8 + OrderTracker::INIT_SPACE,
        seeds = [ORDER_TRACKER_SEED, partner_id.as_ref(), order_id.as_ref()],
        bump
    )]
    pub order_tracker: Account<'info, OrderTracker>,

    pub system_program: Program<'info, System>,
}


#[derive(Accounts)]
#[instruction(partner_id: [u8; 32], public_key: Pubkey)]
pub struct WhitelistBeneficiary<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = authority,
        space = 8 + Beneficiary::INIT_SPACE,
        seeds = [BENEFICIARY_SEED, partner_id.as_ref(), public_key.as_ref()],
        bump
    )]
    pub beneficiary: Account<'info, Beneficiary>,

    #[account(
        mut,
        constraint = authority.key() == config.admin || authority.key() == config.guardian @ CustomError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ToggleBeneficiary<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [BENEFICIARY_SEED, beneficiary.partner_id.as_ref(), beneficiary.public_key.as_ref()],
        bump
    )]
    pub beneficiary: Account<'info, Beneficiary>,

    #[account(
        mut,
        constraint = authority.key() == config.admin || authority.key() == config.guardian @ CustomError::Unauthorized,
    )]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RevokeBeneficiary<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [BENEFICIARY_SEED, beneficiary.partner_id.as_ref(), beneficiary.public_key.as_ref()],
        bump,
        close = authority
    )]
    pub beneficiary: Account<'info, Beneficiary>,

    #[account(
        mut,
        constraint = authority.key() == config.admin || authority.key() == config.guardian @ CustomError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}


#[derive(Accounts)]
#[instruction(action: u8)]
pub struct RequestTimelock<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = authority,
        space = 8 + Timelock::INIT_SPACE,
        seeds = [TIMELOCK_SEED, &[action]],
        bump
    )]
    pub timelock: Account<'info, Timelock>,

    #[account(
        mut,
        constraint = authority.key() == config.admin || authority.key() == config.manager @ CustomError::Unauthorized
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SignTimelock<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [TIMELOCK_SEED, &[timelock.action]],
        bump,
        // close = authority
    )]
    pub timelock: Account<'info, Timelock>,

    #[account(
        mut,
        constraint = authority.key() == config.admin || authority.key() == config.guardian @ CustomError::Unauthorized
    )]
    pub authority: Signer<'info>,
}


#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        constraint = authority.key() == config.manager || authority.key() == config.admin @ CustomError::Unauthorized
    )]
    pub authority: Signer<'info>,
}

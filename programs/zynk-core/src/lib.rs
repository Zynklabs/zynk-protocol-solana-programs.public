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
    sysvar::instructions::{ ID as SYSVAR_IX_ID, load_instruction_at_checked },
    system_program::ID as SYSTEM_PROGRAM_ID,
    ed25519_program::ID as ED25519_ID,
    program_error::ProgramError,
    hash::hash,
};

declare_id!("CDhMbu6bYMLPxCEDv4V7AXBvgx4gqaMfLit4JTZFtd6y");

pub const DOMAIN_SEPARATOR: u64 = 1151111081099710;
pub const INITIAL_MANAGER: Pubkey = pubkey!("9MepxaatLd2EnwDJrEALaQQRJUtMY1rsF7GjXFgWeCbm");


#[error_code]
pub enum CustomError {
    #[msg("Unauthorized signer")]
    UnauthorizedSigner,
    #[msg("Invalid address: cannot use null address")]
    InvalidAddress,
    #[msg("Contract is paused")]
    ContractPaused,
    #[msg("Unauthorized admin")]
    UnauthorizedAdmin,
    #[msg("Unauthorized manager")]
    UnauthorizedManager,
    #[msg("Unauthorized guardian")]
    UnauthorizedGuardian,
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
    #[msg("Invalid message in Ed25519 instruction")]
    InvalidEd25519Message,
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
    pub attester: Pubkey,
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
pub struct Request {
    pub action: u8,             // Enum tag for the action
    pub value: Pubkey       ,   // New value (wallet address)
    pub eta: i64,               // Earliest time the action can be executed
    pub executed: bool,         // Prevent double execution
    pub ack: bool,              // Acknowledgement flag (only by guardian)
    pub consensus: bool,        // Is consensus request?
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
    UpdateAttester,
    Unpause,
}

impl TimelockAction {
    pub fn delay(&self) -> i64 {
        match self {
            TimelockAction::UpdateAdmin => 24 * 60 * 60,           // 24 hours
            TimelockAction::UpdateManager => 12 * 60 * 60,         // 12 hours
            TimelockAction::UpdateGuardian => 48 * 60 * 60,        // 48 hours
            TimelockAction::UpdateAttester => 12 * 60 * 60,        // 12 hours
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
            3 => Ok(TimelockAction::UpdateAttester),
            4 => Ok(TimelockAction::Unpause),
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
    pub token: Pubkey,
    pub zynk_op_vault: Pubkey,
    pub beneficiary_wallet: Pubkey,
    pub partner_deposit_vault: Pubkey,
    pub amount: u64,
    pub transient: bool,
    pub domain_separator: u64,
    pub meta: Option<Vec<EventArg>>
}

#[event]
pub struct OrderReplenished {
    pub order_id: [u8; 32],
    pub token: Pubkey,
    pub zynk_op_vault: Pubkey,
    pub partner_deposit_vault: Pubkey,
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

#[event]
pub struct OrderAttested {
    pub order_id: [u8; 32],
    pub origin_chain: String,
    pub target_chain: String,
    pub origin: String,
    pub proxy: String,
    pub target: String,
    pub txn: String,
    pub proxy_txn: Option<String>,
    pub asset: String,
    pub proxy_asset: Option<String>,
    pub amount: u64,
    pub domain_separator: u64,
    pub meta: Option<Vec<EventArg>>
}


/// Verifies an Ed25519 signature using the Solana Ed25519 program via sysvar instructions.
/// This function checks that the previous instruction was an Ed25519 signature verification
/// and validates the signer, message, and signature match the expected values.
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

    if data[0] != 1 {
        return Err(ProgramError::InvalidInstructionData.into());
    }

    let sig_offset = u16::from_le_bytes([data[2], data[3]]);
    let sig_ix_idx = u16::from_le_bytes([data[4], data[5]]);
    let pk_offset  = u16::from_le_bytes([data[6], data[7]]);
    let pk_ix_idx  = u16::from_le_bytes([data[8], data[9]]);
    let msg_offset = u16::from_le_bytes([data[10], data[11]]);
    let msg_size   = u16::from_le_bytes([data[12], data[13]]);
    let msg_ix_idx = u16::from_le_bytes([data[14], data[15]]);

    if !(pk_offset == 16
        && pk_ix_idx == 0xFFFF
        && sig_offset == 48
        && sig_ix_idx == 0xFFFF
        && msg_offset == 112
        && msg_ix_idx == 0xFFFF
        && msg_size == message.len() as u16)
    {
        return Err(ProgramError::InvalidInstructionData.into());
    }

    let data_pubkey = &data[16..48];
    let data_signature = &data[48..112];
    let data_message = &data[112..];
    if data_pubkey != &signer_pubkey.to_bytes() || data_signature != signature || data_message != message {
        return Err(CustomError::InvalidEd25519Message.into());
    }

    Ok(())
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

pub fn validate_beneficiary(
    program_id: &Pubkey,
    beneficiary: Option<&Account<Beneficiary>>,
    beneficiary_wallet: &Pubkey,
    partner_id: &[u8; 32],
    zov_id: &[u8; 32],
    transient: bool,
) -> Result<()> {
    if *zov_id == [0u8; 32] { return Ok(()) }

    let beneficiary = beneficiary.ok_or(CustomError::InvalidBeneficiary)?;

    require!(beneficiary.is_active, CustomError::InvalidBeneficiary);
    require!(beneficiary.allow_transient || !transient, CustomError::InvalidBeneficiary);
    require!(beneficiary.public_key == *beneficiary_wallet, CustomError::InvalidBeneficiary);

    let (expected, _) = Pubkey::find_program_address(
        &[
            BENEFICIARY_SEED,
            partner_id.as_ref(),
            beneficiary_wallet.as_ref(),
        ],
        program_id,
    );

    require!(beneficiary.key() == expected, CustomError::InvalidAccount);

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
    /// * `attester` - The attester address with attestations signing privileges.
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
        attester: Pubkey,
        whitelisted_token_mints: Vec<Pubkey>
    ) -> Result<()> {
        validate_address(&admin)?;
        validate_address(&guardian)?;
        validate_address(&attester)?;

        let config = &mut ctx.accounts.config;
        config.paused = false;

        config.manager = ctx.accounts.manager.key();
        config.admin = admin;
        config.guardian = guardian;
        config.attester = attester;

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
    /// * `signature` - Optional attested signature enabling explicit transient execution
    ///                 (irrespective of the `allow_transient` attribute in beneficiary PDA)
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Fails if the program is paused.
    /// - Validates the partner deposit vault token authority and token mint.
    /// - Optionally verifies a attester signature for transient execution.
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
        signature: Option<[u8; 64]>,
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

        validate_beneficiary(
            ctx.program_id,
            ctx.accounts.beneficiary.as_ref(),
            &beneficiary_wallet,
            &partner_id,
            &zov_id,
            transient,
        )?;

        require!(pdv_token_account.owner == partner_deposit_vault.key(), CustomError::InvalidAccount);
        require!(pdv_token_account.mint == ctx.accounts.zov_token_account.mint, CustomError::InvalidTokenMint);

        let mut is_transient = transient;
        if let Some(signature) = signature {
            let message = format!("{}::{}::{}::{}", DOMAIN_SEPARATOR, beneficiary_wallet, partner_deposit_vault.key(), zynk_op_vault.key());
            verify_signature_syscall(
                ctx.accounts.sysvar_instructions.as_ref().ok_or(ProgramError::MissingRequiredSignature)?,
                &config.attester,
                message,
                signature
            )?;
            is_transient = true;
        }

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
        if is_transient {
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
            zynk_op_vault: zynk_op_vault.key(),
            beneficiary_wallet,
            token: ctx.accounts.mint.key(),
            partner_deposit_vault: partner_deposit_vault.key(),
            amount,
            transient: is_transient,
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

        let beneficiary_wallet = ctx.accounts.beneficiary_token_account.owner.key();
        let partner_deposit_vault = ctx.accounts.partner_deposit_vault.key();
        let zynk_op_vault = ctx.accounts.zynk_op_vault.key();

        validate_beneficiary(
            ctx.program_id,
            ctx.accounts.beneficiary.as_ref(),
            &beneficiary_wallet,
            &partner_id,
            &zov_id,
            transient,
        )?;

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
            zynk_op_vault,
            beneficiary_wallet,
            token: ctx.accounts.mint.key(),
            partner_deposit_vault,
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
            zynk_op_vault: order_tracker.zynk_op_vault,
            token: ctx.accounts.mint.key(),
            partner_deposit_vault: partner_deposit_vault.key(),
            amount,
            order_closed: close_order,
            domain_separator: DOMAIN_SEPARATOR,
            meta
        });

        Ok(())
    }

    /// Attests an order using an off-chain signature and records or settles the order state.
    ///
    /// # Arguments
    /// * `ctx` - The [`AttestOrder`] context.
    /// * `order_id` - The unique identifier of the order.
    /// * `origin_chain` - The source blockchain identifier.
    /// * `target_chain` - The destination blockchain identifier.
    /// * `origin` - The originating address.
    /// * `proxy` - The proxy address involved in the transfer.
    /// * `target` - The target address on the destination chain.
    /// * `txn` - The originating transaction hash.
    /// * `proxy_txn` - Optional proxy transaction hash.
    /// * `asset` - The asset identifier.
    /// * `proxy_asset` - Optional proxy asset identifier.
    /// * `amount` - The amount attested for the order.
    /// * `signature` - The ed25519 signature authorizing the attestation.
    /// * `meta` - Optional metadata emitted with the event.
    ///
    /// # Behavior
    /// - Verifies the manager signature via the sysvar instructions account.
    /// - Initializes or updates the order tracker.
    /// - Closes the order if sufficient input has already been provided.
    /// - Emits an `OrderAttested` event.
    pub fn attest_order(
        ctx: Context<AttestOrder>,
        order_id: [u8; 32],
        origin_chain: String,
        target_chain: String,
        origin: String,
        proxy: String,
        target: String,
        txn: String,
        proxy_txn: Option<String>,
        asset: String,
        proxy_asset: Option<String>,
        amount: u64,
        signature: [u8; 64],
        meta: Option<Vec<EventArg>>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(!config.paused, CustomError::ContractPaused);

        require!(
            !origin.contains("::") && !proxy.contains("::") && !target.contains("::") && !txn.contains("::"),
            CustomError::InvalidOrder
        );

        let message = format!("{}::{}::{}::{}::{}::{}", DOMAIN_SEPARATOR, origin, proxy, target, txn, amount);
        verify_signature_syscall(
            &ctx.accounts.sysvar_instructions,
            &config.attester,
            message,
            signature
        )?;

        let order_tracker = &mut ctx.accounts.order_tracker;

        let hashed_proxy = hash(proxy.as_bytes()).to_bytes();
        if order_tracker.order_id != [0u8; 32] {
            require!(
                order_tracker.partner_id == hashed_proxy,
                CustomError::InvalidOrder);

            require!(
                order_tracker.amount_in
                    .checked_add(amount)
                    .ok_or(ProgramError::ArithmeticOverflow)?
                    >= order_tracker.amount_out,
                CustomError::DeficientOrder
            );

            close_account(order_tracker, &ctx.accounts.manager)?;
        } else {
            order_tracker.partner_id = hashed_proxy;
            order_tracker.order_id = order_id;
            order_tracker.amount_out = amount;
        }

        emit!(OrderAttested {
            order_id,
            origin_chain,
            target_chain,
            origin,
            proxy,
            target,
            txn,
            proxy_txn,
            asset,
            proxy_asset,
            amount,
            domain_separator: DOMAIN_SEPARATOR,
            meta
        });

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

            close_account(account_info, &ctx.accounts.admin)?;
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
    /// * `ctx` - The [`TimelockRequest`] context.
    /// * `action_u8` - The encoded timelock action.
    /// * `value` - Optional value associated with the action.
    ///
    /// # Behavior
    /// - Computes the ETA based on the action delay.
    /// - Stores the request in a timelock account.
    /// - Emits an `Action::Initiated` event.
    pub fn request_timelock(
        ctx: Context<TimelockRequest>,
        action_u8: u8,
        value: Option<Pubkey>,
    ) -> Result<()> {
        let timestamp = Clock::get()?.unix_timestamp;
        let req = &mut ctx.accounts.timelock;
        let action: TimelockAction = action_u8.try_into()?;

        req.action = action_u8;
        req.value = value.unwrap_or(Pubkey::default());
        req.eta = timestamp + action.delay();

        emit!(Action {
            action: action_u8,
            timelock: req.key(),
            status: ActionStatus::Initiated,
            timestamp,
        });

        Ok(())
    }

    /// Revokes a pending timelock action before it is executed.
    ///
    /// # Arguments
    /// * `ctx` - The [`Execute`] context containing the timelock account.
    ///
    /// # Behavior
    /// - Fails if the timelock action has already been executed.
    /// - Fails if the action is still under review (not acknowledged).
    /// - Emits an `Action::Revoked` event.
    pub fn revoke_timelock(ctx: Context<Execute>) -> Result<()> {
        let req = &mut ctx.accounts.timelock;

        require!(!req.executed, CustomError::AlreadyExecuted);
        require!(req.ack, CustomError::ActionUnderReview);

        emit!(Action {
            action: req.action,
            timelock: req.key(),
            status: ActionStatus::Revoked,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Acknowledges a timelock action, marking it as reviewed.
    ///
    /// # Arguments
    /// * `ctx` - The [`Ack`] context containing the timelock account.
    ///
    /// # Behavior
    /// - Fails if the action has already been executed.
    /// - Marks the timelock request as acknowledged.
    /// - Emits an `Action::Acked` event.
    pub fn ack_timelock(ctx: Context<Ack>) -> Result<()> {
        let req = &mut ctx.accounts.timelock;
        require!(!req.executed, CustomError::AlreadyExecuted);

        req.ack = true;

        emit!(Action {
            action: req.action,
            timelock: req.key(),
            status: ActionStatus::Acked,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Executes a timelocked request after conditions are met.
    ///
    /// # Arguments
    /// * `ctx` - The [`Execute`] context containing the timelock and config accounts.
    ///
    /// # Behavior
    /// - Validates timelock execution conditions based on action type.
    /// - Requires acknowledgment for guardian updates.
    /// - Updates the corresponding configuration field.
    /// - Marks the timelock action as executed.
    /// - Emits an `Action::Executed` event.
    pub fn execute_request(ctx: Context<Execute>) -> Result<()> {
        let timestamp = Clock::get()?.unix_timestamp;
        let req = &mut ctx.accounts.timelock;
        let action: TimelockAction = req.action.try_into()?;

        require!(!req.executed, CustomError::AlreadyExecuted);
        require!(!req.consensus, CustomError::InvalidAction);

        let acked = req.ack;
        let eta_ready = timestamp >= req.eta;

        let ok = if action == TimelockAction::UpdateGuardian {
            eta_ready && acked
        } else {
            eta_ready || acked
        };

        require!(ok, CustomError::ActionUnderReview);

        let value = req.value;
        validate_address(&value)?;

        let config = &mut ctx.accounts.config;

        match action {
            TimelockAction::UpdateAdmin => config.admin = value,
            TimelockAction::UpdateManager => config.manager = value,
            TimelockAction::UpdateGuardian => config.guardian = value,
            _ => return Err(error!(CustomError::InvalidAction)),
        }

        req.executed = true;

        emit!(Action {
            action: req.action,
            timelock: req.key(),
            status: ActionStatus::Executed,
            timestamp,
        });

        Ok(())
    }

    /// Executes an unpause action after timelock conditions are satisfied.
    ///
    /// # Arguments
    /// * `ctx` - The [`Execute`] context containing the timelock and config accounts.
    ///
    /// # Behavior
    /// - Ensures the action corresponds to `Unpause`.
    /// - Requires ETA expiration or prior acknowledgment.
    /// - Sets the contract paused state to `false`.
    /// - Marks the timelock action as executed.
    /// - Emits an `Action::Executed` event.
    pub fn unpause(ctx: Context<Execute>) -> Result<()> {
        let timestamp = Clock::get()?.unix_timestamp;
        let req = &mut ctx.accounts.timelock;

        require!(!req.executed, CustomError::AlreadyExecuted);
        require!(TimelockAction::try_from(req.action)? == TimelockAction::Unpause, CustomError::InvalidAction);

        let acked = req.ack;
        let eta_ready = timestamp >= req.eta;
        require!(eta_ready || acked, CustomError::ActionUnderReview);

        let config = &mut ctx.accounts.config;

        config.paused = false;
        req.executed = true;

        emit!(Action {
            action: req.action,
            timelock: req.key(),
            status: ActionStatus::Executed,
            timestamp,
        });

        Ok(())
    }

    /// Immediately pauses the contract.
    ///
    /// # Arguments
    /// * `ctx` - The [`Pause`] context containing the authority and config accounts.
    ///
    /// # Authorization
    /// May be called by the admin, manager, or attester.
    ///
    /// # Behavior
    /// - Sets the contract paused state to `true`.
    /// - Fails if the signer is not an authorized role.
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        let config = &mut ctx.accounts.config;

        config.paused = true;
        Ok(())
    }

    /// Requests a consensus-based administrative action.
    ///
    /// # Arguments
    /// * `ctx` - The [`Consensus`] context containing the timelock account.
    /// * `action_u8` - The encoded consensus action.
    /// * `value` - The value associated with the action.
    ///
    /// # Behavior
    /// - Marks the timelock request as consensus-based.
    /// - Stores the requested action and value.
    /// - Emits an `Action::Initiated` event.
    pub fn request_consensus(
        ctx: Context<Consensus>,
        action_u8: u8,
        value: Pubkey,
    ) -> Result<()> {
        let req = &mut ctx.accounts.timelock;
        let _: TimelockAction = action_u8.try_into()?;

        req.action = action_u8;
        req.value = value;
        req.consensus = true;

        emit!(Action {
            action: action_u8,
            timelock: req.key(),
            status: ActionStatus::Initiated,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Executes a consensus-approved administrative action.
    ///
    /// # Arguments
    /// * `ctx` - The [`Ack`] context containing the timelock and config accounts.
    ///
    /// # Behavior
    /// - Fails if the action has already been executed.
    /// - Applies the approved configuration update.
    /// - Marks the timelock as acknowledged and executed.
    /// - Closes the timelock account.
    /// - Emits an `Action::Executed` event.
    pub fn execute_consensus(ctx: Context<Ack>) -> Result<()> {
        let req = &mut ctx.accounts.timelock;
        let action: TimelockAction = req.action.try_into()?;

        require!(!req.executed, CustomError::AlreadyExecuted);
        require!(req.consensus, CustomError::InvalidAction);

        let value = req.value;
        validate_address(&value)?;

        let config = &mut ctx.accounts.config;

        match action {
            TimelockAction::UpdateAdmin => config.admin = value,
            TimelockAction::UpdateManager => config.manager = value,
            TimelockAction::UpdateAttester => config.attester = value,
            _ => return Err(error!(CustomError::InvalidAction)),
        }

        req.ack = true;
        req.executed = true;

        emit!(Action {
            action: req.action,
            timelock: req.key(),
            status: ActionStatus::Executed,
            timestamp: Clock::get()?.unix_timestamp,
        });

        // Close the timelock account (transfer lamports back to guardian)
        // Must not add `close = guardian` in the Ack context struct,
        // as the struct is being used for `ack_timelock()` method too
        // wherein account closure is not required.
        close_account(req, &ctx.accounts.guardian)?;

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
        constraint = manager.key() == INITIAL_MANAGER @ CustomError::UnauthorizedManager
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
        has_one = manager @ CustomError::UnauthorizedManager
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

    pub beneficiary: Option<Account<'info, Beneficiary>>,

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

    /// CHECK: This is the Sysvar Instructions account used for ed25519 signature verification
    #[account(address = SYSVAR_IX_ID)]
    pub sysvar_instructions: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
pub struct Replenish<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CustomError::UnauthorizedManager
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
        has_one = admin @ CustomError::UnauthorizedAdmin
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 32])]
pub struct AttestOrder<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CustomError::UnauthorizedManager
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        init_if_needed,
        payer = manager,
        space = 8 + OrderTracker::INIT_SPACE,
        seeds = [ORDER_TRACKER_SEED, b"attest", order_id.as_ref()],
        bump
    )]
    pub order_tracker: Account<'info, OrderTracker>,

    pub system_program: Program<'info, System>,

    /// CHECK: This is the Sysvar Instructions account used for ed25519 signature verification
    #[account(address = SYSVAR_IX_ID)]
    pub sysvar_instructions: AccountInfo<'info>,
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
        constraint = authority.key() == config.admin || authority.key() == config.guardian @ CustomError::UnauthorizedSigner,
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
        constraint = authority.key() == config.admin || authority.key() == config.guardian @ CustomError::UnauthorizedSigner,
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
        constraint = authority.key() == config.admin || authority.key() == config.guardian @ CustomError::UnauthorizedSigner,
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}


#[derive(Accounts)]
#[instruction(action: u8)]
pub struct TimelockRequest<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CustomError::UnauthorizedManager
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = manager,
        space = 8 + Request::INIT_SPACE,
        seeds = [TIMELOCK_SEED, &[action]],
        bump
    )]
    pub timelock: Account<'info, Request>,

    #[account(mut)]
    pub manager: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = admin @ CustomError::UnauthorizedAdmin
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [TIMELOCK_SEED, &[timelock.action]],
        bump,
        close = admin
    )]
    pub timelock: Account<'info, Request>,

    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct Ack<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = guardian @ CustomError::UnauthorizedGuardian
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [TIMELOCK_SEED, &[timelock.action]],
        bump
        // If adding `close = guardian` here, refer to the `execute_consensus()` method
    )]
    pub timelock: Account<'info, Request>,

    #[account(mut)]
    pub guardian: Signer<'info>,
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
        constraint = authority.key() == config.manager || authority.key() == config.admin || authority.key() == config.attester @ CustomError::UnauthorizedSigner,
    )]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(action: u8)]
pub struct Consensus<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = manager @ CustomError::UnauthorizedManager,
        has_one = attester @ CustomError::UnauthorizedSigner
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = manager,
        space = 8 + Request::INIT_SPACE,
        seeds = [TIMELOCK_SEED, &[action]],
        bump
    )]
    pub timelock: Account<'info, Request>,

    #[account(mut)]
    pub manager: Signer<'info>,
    pub attester: Signer<'info>,

    pub system_program: Program<'info, System>,
}

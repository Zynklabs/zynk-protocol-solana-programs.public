import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
    PublicKey,
    Keypair,
    SystemProgram,
    Ed25519Program,
    SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    createMint,
    mintTo,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getOrCreateAssociatedTokenAccount,
    createAssociatedTokenAccount,
} from "@solana/spl-token";
import { ZynkCore } from "../target/types/zynk_core";
import { assert, expect } from "chai";
import { createHash, randomUUID } from "crypto";
import { TextEncoder } from "util";
import { sha256 } from "@noble/hashes/sha2";
import nacl from "tweetnacl";
import {
    ZYNK_CORE_KEYPAIR,
    ZYNK_CORE_PROGRAM_ID,
    ZYNK_ORBIT_KEYPAIR,
    ZYNK_ORBIT_PROGRAM_ID,
    ZOV_KEYPAIR,
    ZOV,
    ADMIN_KEYPAIR,
    ADMIN,
    MANAGER_KEYPAIR,
    MANAGER,
    INITIAL_MANAGER_KEYPAIR,
    INITIAL_MANAGER,
} from "./addresses";
import { ZynkOrbit } from "../target/types/zynk_orbit";

// ─── Module-level helpers ─────────────────────────────────────────────────────
const zynkPartnerId = `zp_321420`; // 6-digit numeric suffix required by extract_partner_number
const generateOrderId = (): Buffer => {
    const transactionId = `txn_${randomUUID()}`;
    const orderKey = `${zynkPartnerId}::${transactionId}`;
    const hash = createHash("sha256").update(orderKey).digest("hex");
    return Buffer.from(hash.slice(0, 32));
};



describe("zynk-orbit", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const core_program = anchor.workspace.ZynkCore as Program<ZynkCore>;
    const program = anchor.workspace.ZynkOrbit as Program<ZynkOrbit>;

    const admin = ADMIN_KEYPAIR;
    const manager = INITIAL_MANAGER_KEYPAIR;
    const guardian = Keypair.generate();
    const attester = INITIAL_MANAGER_KEYPAIR;
    const partnerOperationalWallet = Keypair.generate();

    // ── ICV user ──────────────────────────────────────────────────────────────
    const icvUserId = Buffer.alloc(32);
    icvUserId.write("icv_user_1", 0, "utf-8");
    const icvUser = Keypair.generate();

    // ── zynk-core PDAs ────────────────────────────────────────────────────────
    const defaultZovId = Buffer.alloc(32);
    defaultZovId.write("default", 0, "utf-8");

    const zeroZovId = Buffer.alloc(32);

    const [zynkOpVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("zynk_op_vault"), defaultZovId],
        core_program.programId
    );

    const [zZynkOpVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("zynk_op_vault"), zeroZovId],
        core_program.programId
    );

    const partnerId = Buffer.alloc(32);
    partnerId.write(zynkPartnerId, 0, "utf-8");

    // On-chain borrow hashes partner_id string with solana sha256; replicate here.
    const borrowPartnerIdBytes = Buffer.from(
        sha256(new TextEncoder().encode(zynkPartnerId))
    );

    const [partnerDepositVaultPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("partner_deposit_vault"), borrowPartnerIdBytes],
        core_program.programId
    );

    const [configPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("config::v4")],
        core_program.programId
    );

    // ── zynk-orbit PDAs ───────────────────────────────────────────────────────
    // ovault – orbit's internal vault, beneficiary for repay transient create_order
    const [ovaultPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), Buffer.from("orbit")],
        program.programId
    );



    // Core beneficiary PDA: ovault whitelisted for this partner
    const [coreBeneficiaryPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("beneficiary"), borrowPartnerIdBytes, ovaultPDA.toBuffer()],
        core_program.programId
    );

    // ── Utility helpers ───────────────────────────────────────────────────────
    const deriveRecordPDA = (userId: Buffer, pk: PublicKey): PublicKey =>
        PublicKey.findProgramAddressSync(
            [Buffer.from("record"), userId, pk.toBuffer()],
            program.programId
        )[0];

    const deriveOrderTrackerPDA = (partnerIdBuf: Buffer, orderId: Buffer): PublicKey =>
        PublicKey.findProgramAddressSync(
            [Buffer.from("order_tracker"), partnerIdBuf, orderId],
            core_program.programId
        )[0];

    const derivePositionPDA = (orderId: Buffer, lpPrimaryAccount: PublicKey): PublicKey =>
        PublicKey.findProgramAddressSync(
            [Buffer.from("position"), orderId, lpPrimaryAccount.toBuffer()],
            program.programId
        )[0];

    const gocAta = async (owner: PublicKey, mint: PublicKey) => {
        const { address } = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            manager,
            mint,
            owner,
            true,
            undefined,
            undefined,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        return address;
    };

    const gocAtaAndMint = async (
        owner: PublicKey,
        mint: PublicKey,
        amount = 10_000_000_000_000
    ) => {
        const address = await gocAta(owner, mint);
        let done = false;
        while (!done) {
            try {
                await mintTo(
                    provider.connection,
                    manager,
                    mint,
                    address,
                    manager.publicKey,
                    amount
                );
                done = true;
            } catch (_) {
                await new Promise((r) => setTimeout(r, Math.random() * 2000));
            }
        }
        return address;
    };

    // ── Shared mutable state ──────────────────────────────────────────────────
    let tokenMint: PublicKey;
    let tokenMint2: PublicKey;
    let tokenMint3: PublicKey;
    let invalidTokenMint: PublicKey;

    let zovAta: PublicKey;          // zynkOpVault PDA's token account
    let ovaultAta: PublicKey;       // ovault PDA's token account
    let pdvAta: PublicKey;          // partnerDepositVault token account
    let icvUserAta: PublicKey;      // ICV user source token account
    let icvTokenAccount: PublicKey; // Record-PDA-owned ICV custody account

    // Shared across borrow → repay tests
    let borrowOrderId: Buffer;
    let borrowOrderTrackerPDA: PublicKey;

    let whitelistedTokenMints: PublicKey[] = [];

    // =========================================================================
    // BEFORE HOOK – initialise chain state once for the whole suite
    // =========================================================================
    before(async () => {
        // Airdrop SOL to every wallet that will sign transactions
        for (const kp of [admin, manager, guardian, icvUser, partnerOperationalWallet]) {
            try {
                const tx = await provider.connection.requestAirdrop(
                    kp.publicKey,
                    4 * anchor.web3.LAMPORTS_PER_SOL
                );
                await provider.connection.confirmTransaction(tx, "confirmed");
            } catch (_) {}
        }

        // ── Create token mints or reuse existing from config ──────────────────
        try {
            const configAccount = await core_program.account.config.fetch(configPDA);
            whitelistedTokenMints = configAccount.whitelistedTokenMints;
            [tokenMint, tokenMint2, tokenMint3] = whitelistedTokenMints;
        } catch (_) {
            tokenMint = await createMint(provider.connection, manager, manager.publicKey, null, 9);
            tokenMint2 = await createMint(provider.connection, manager, manager.publicKey, null, 9);
            tokenMint3 = await createMint(
                provider.connection, manager, manager.publicKey, null, 9,
                undefined, undefined, TOKEN_2022_PROGRAM_ID
            );
            whitelistedTokenMints = [tokenMint, tokenMint2, tokenMint3];

            await core_program.methods
                .initialize(
                    admin.publicKey,
                    guardian.publicKey,
                    attester.publicKey,
                    whitelistedTokenMints
                )
                .accounts({
                    manager: manager.publicKey,
                } as any)
                .signers([manager])
                .rpc();
        }

        invalidTokenMint = await createMint(
            provider.connection, manager, manager.publicKey, null, 9
        );

        // ── ATAs & token funding ──────────────────────────────────────────────
        // ZOV ATA – zynkOpVault PDA holds custody of borrowed funds
        zovAta = await gocAtaAndMint(zynkOpVault, tokenMint);

        // ovault ATA – owned by orbit ovault PDA (receives tokens on borrow, source for repay)
        ovaultAta = await gocAta(ovaultPDA, tokenMint);

        // PDV ATA – partnerDepositVault token account (source for repay replenish)
        pdvAta = await gocAtaAndMint(partnerDepositVaultPDA, tokenMint);

        // ICV user ATA – user's own wallet, deposits from here
        icvUserAta = await gocAtaAndMint(icvUser.publicKey, tokenMint, 1_000_000_000);

        // ── Whitelist ovaultPDA as beneficiary in zynk-core ──────────────────
        // Required so borrow's create_order (non-transient) and repay's
        // create_order (transient) CPIs succeed with ovault as the beneficiary.
        // allow_transient=true satisfies both paths.
        try {
            await core_program.account.beneficiary.fetch(coreBeneficiaryPDA);
            // already exists – skip
        } catch (_) {
            await core_program.methods
                .whitelistBeneficiary(
                    Array.from(borrowPartnerIdBytes) as any,
                    ovaultPDA,
                    true   // allow_transient = true
                )
                .accounts({
                    authority: admin.publicKey,
                } as any)
                .signers([admin])
                .rpc();
        }
    });

    // =========================================================================
    // TEST 1 – Whitelist ICV user
    // =========================================================================
    it("Should whitelist an ICV user", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);
        const now = Math.floor(Date.now() / 1000);
        // Cliff 2 years in the future (deposits allowed; cliff not yet reached)
        const futureCliffPeriod = new anchor.BN(now + 2 * 365 * 24 * 60 * 60);

        await program.methods
            .whitelist(
                Array.from(icvUserId),
                { icv: {} },
                icvUser.publicKey,
                futureCliffPeriod,
                1_000_000_000, // max_deposit: u32 — plain number
                null           // aux_account
                // NOTE: partners param removed — whitelist now always inits
                // with an empty vec; use updatePartnerWhitelist to add/remove.
            )
            .accounts({
                admin: admin.publicKey,
                coreConfig: configPDA,
            } as any)
            .signers([admin])
            .rpc();

        const record = await program.account.record.fetch(recordPDA);
        assert.ok(record.primaryAccount.equals(icvUser.publicKey), "Primary account should match");
        assert.isTrue(Buffer.from(record.userId).equals(icvUserId), "User ID should match");
        assert.equal(record.cliffPeriod.toNumber(), futureCliffPeriod.toNumber(), "Cliff period should match");
        assert.deepEqual(record.userType, { icv: {} }, "User type should be ICV");
        assert.equal(record.principleIn.toNumber(), 0, "principleIn should be 0");
        assert.equal(record.principleOut.toNumber(), 0, "principleOut should be 0");
        assert.equal(record.maxDeposit, 1_000_000_000, "maxDeposit should match");
        // Account is initialised at BASE_SIZE — empty whitelist
        assert.deepEqual(record.whitelistedPartners, [], "whitelistedPartners should start empty");

        // Verify the on-chain account size matches BASE_SIZE (137 bytes)
        const BASE_SIZE = 137; // 8 disc + 32 + 32 + 1 + 8 + 8 + 8 + 4 + 32 + 4
        const accountInfo = await provider.connection.getAccountInfo(recordPDA);
        assert.equal(accountInfo!.data.length, BASE_SIZE, `account data should be ${BASE_SIZE} bytes for empty whitelist`);

        console.log("✅ ICV user whitelisted:", recordPDA.toBase58());
    });

    // =========================================================================
    // TEST 2 – Admin approves by updating max deposit (approve = set cap)
    // =========================================================================
    it("Admin should update (approve) max deposit of whitelisted ICV user", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);
        const newMaxDeposit = 500_000_000; // reduce from 1e9 to 5e8

        await program.methods
            .updateMaxDeposit(
                Array.from(icvUserId),
                icvUser.publicKey,
                newMaxDeposit
            )
            .accounts({
                admin: admin.publicKey,
                coreConfig: configPDA,
            } as any)
            .signers([admin])
            .rpc();

        const record = await program.account.record.fetch(recordPDA);
        assert.equal(record.maxDeposit, newMaxDeposit, "maxDeposit should be updated");

        console.log("✅ Max deposit updated to:", newMaxDeposit);
    });

    // =========================================================================
    // TEST 3 – ICV user deposits funds
    // =========================================================================
    it("ICV user should deposit funds into the contract", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);
        const depositAmount = new anchor.BN(100_000_000); // 1e8 units

        // ICV custody token account — owned by the Record PDA
        icvTokenAccount = await gocAta(recordPDA, tokenMint);

        await program.methods
            .deposit(Array.from(icvUserId), depositAmount)
            .accounts({
                sourceTokenAccount: icvUserAta,
                destinationTokenAccount: icvTokenAccount,
                record: recordPDA,
                mint: tokenMint,
                signer: icvUser.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                coreConfig: configPDA,
            } as any)
            .signers([icvUser])
            .rpc();

        const record = await program.account.record.fetch(recordPDA);
        assert.equal(record.principleIn.toNumber(), depositAmount.toNumber(), "principleIn should equal deposit");
        assert.equal(record.principleOut.toNumber(), 0, "principleOut should still be 0");

        console.log("✅ ICV deposited:", depositAmount.toNumber(), "| custody:", icvTokenAccount.toBase58());
    });

    // =========================================================================
    // TEST 4 – Manager borrows (opens a position) against the ICV user
    // =========================================================================
    it("Manager should borrow (open position) against the ICV user", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);
        const borrowAmount = new anchor.BN(50_000_000);

        borrowOrderId = generateOrderId();
        borrowOrderTrackerPDA = deriveOrderTrackerPDA(borrowPartnerIdBytes, borrowOrderId);
        const positionPDA = derivePositionPDA(borrowOrderId, icvUser.publicKey);

        const [coreZovPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("zynk_op_vault"), defaultZovId],
            core_program.programId
        );

        await program.methods
            .borrow(
                zynkPartnerId,
                Array.from(borrowOrderId),
                Array.from(defaultZovId),
                borrowAmount,
                [{
                    lpPrimaryAccount: icvUser.publicKey,
                    amount: borrowAmount,
                    userType: { icv: {} },
                    vaultId: Array.from(zeroZovId),
                }],
                null
            )
            .accounts({
                zovTokenAccount: zovAta,
                mint: tokenMint,
                manager: manager.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                coreConfig: configPDA,
                corePartnerDepositVault: partnerDepositVaultPDA,
                coreZynkOpVault: coreZovPDA,
                coreBeneficiary: coreBeneficiaryPDA,
                coreBeneficiaryTokenAccount: ovaultAta,
                coreOrderTracker: borrowOrderTrackerPDA,
            } as any)
            .remainingAccounts([
                { pubkey: icvTokenAccount, isSigner: false, isWritable: true },
                { pubkey: recordPDA,        isSigner: false, isWritable: false },
                { pubkey: recordPDA,        isSigner: false, isWritable: false },
                { pubkey: positionPDA,      isSigner: false, isWritable: true },
            ])
            .signers([manager])
            .rpc();

        // Position is not in the IDL accounts namespace — verify via raw account existence
        const positionAccountInfo = await provider.connection.getAccountInfo(positionPDA);
        assert.isNotNull(positionAccountInfo, "Position PDA should have been created");
        assert.ok(positionAccountInfo!.owner.equals(program.programId), "Position PDA should be owned by orbit program");

        console.log("✅ Borrow position opened | positionPDA:", positionPDA.toBase58());
    });


    // // =========================================================================
    // // TEST 5 – Manager fully repays the position
    // // =========================================================================
    it("Manager should fully repay the position against the ICV user", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);
        const positionPDA = derivePositionPDA(borrowOrderId, icvUser.publicKey);
        // Position is not in IDL — use the known borrow amount directly
        const repayAmount = new anchor.BN(50_000_000); // same as borrowAmount

        const transientOrderId = generateOrderId();
        const [transientOrderTrackerPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("order_tracker"), borrowPartnerIdBytes, transientOrderId],
            core_program.programId
        );
        const [coreZovPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("zynk_op_vault"), defaultZovId],
            core_program.programId
        );

        await program.methods
            .repay(
                Array.from(borrowPartnerIdBytes),
                Array.from(borrowOrderId),
                Array.from(defaultZovId),
                Array.from(transientOrderId),
                repayAmount,
                [{
                    lpPrimaryAccount: icvUser.publicKey,
                    amount: repayAmount,
                    userType: { icv: {} },
                    vaultId: Array.from(zeroZovId),
                }],
                null
            )
            .accounts({
                zovTokenAccount: zovAta,
                ovaultTokenAccount: ovaultAta,
                mint: tokenMint,
                manager: manager.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                coreConfig: configPDA,
                coreOrderTracker: borrowOrderTrackerPDA,
                corePartnerDepositVault: partnerDepositVaultPDA,
                corePdvTokenAccount: pdvAta,
                coreZynkOpVault: coreZovPDA,
                coreTransientOrderTracker: transientOrderTrackerPDA,
                ovault: ovaultPDA,
                ovaultsBeneficiaryPda: coreBeneficiaryPDA,
            } as any)
            .remainingAccounts([
                { pubkey: icvTokenAccount, isSigner: false, isWritable: true },
                { pubkey: recordPDA,        isSigner: false, isWritable: false },
                { pubkey: positionPDA,      isSigner: false, isWritable: true },
            ])
            .signers([manager])
            .rpc();

        const positionInfo = await provider.connection.getAccountInfo(positionPDA);
        assert.isNull(positionInfo, "Position PDA should be closed after full repay");

        console.log("✅ Position fully repaid and closed | repayAmount:", repayAmount.toNumber());
    });


    // =========================================================================
    // TEST 6 – ICV user raises a partial withdrawal request
    // =========================================================================
    it("ICV user should raise a partial withdrawal request", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);
        const withdrawAmount = 10_000_000; // u32 — partial withdrawal

        const [withdrawRequestPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("withdraw_request"), icvUserId, icvUser.publicKey.toBuffer()],
            program.programId
        );

        await program.methods
            .requestWithdraw(
                Array.from(icvUserId),
                icvUser.publicKey, // primary_account
                icvUser.publicKey, // destination (same wallet for ICV self-withdraw)
                withdrawAmount
            )
            .accounts({
                signer: icvUser.publicKey,
            } as any)
            .signers([icvUser])
            .rpc();

        const request = await program.account.withdrawRequest.fetch(withdrawRequestPDA);
        assert.equal(request.amount, withdrawAmount, "Withdraw amount should match");
        assert.ok(request.destination.equals(icvUser.publicKey), "Destination should be ICV user");
        assert.isTrue(Buffer.from(request.userId).equals(icvUserId), "UserId in request should match");

        console.log("✅ Withdraw request raised | amount:", withdrawAmount, "| PDA:", withdrawRequestPDA.toBase58());
    });

    // =========================================================================
    // TEST 7 – Admin approves the withdrawal request
    // =========================================================================
    it("Admin should approve the withdrawal request", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);

        const [withdrawRequestPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("withdraw_request"), icvUserId, icvUser.publicKey.toBuffer()],
            program.programId
        );

        const destinationAta = await gocAta(icvUser.publicKey, tokenMint);

        await program.methods
            .approveWithdraw(Array.from(icvUserId), icvUser.publicKey)
            .accounts({
                request: withdrawRequestPDA,
                record: recordPDA,
                primaryAccount: icvUser.publicKey,
                admin: admin.publicKey,
                sourceTokenAccount: icvTokenAccount,
                destinationTokenAccount: destinationAta,
                ovault: null,   // not needed for ICV withdrawals (LP-only)
                mint: tokenMint,
                tokenProgram: TOKEN_PROGRAM_ID,
                coreConfig: configPDA,
            } as any)
            .signers([admin])
            .rpc();

        const record = await program.account.record.fetch(recordPDA);
        assert.equal(record.principleOut.toNumber(), 10_000_000, "principleOut should reflect withdrawn amount");

        const reqInfo = await provider.connection.getAccountInfo(withdrawRequestPDA);
        assert.isNull(reqInfo, "WithdrawRequest PDA should be closed after approval");

        console.log("✅ Withdrawal approved | principleOut:", record.principleOut.toNumber());
    });


    // =========================================================================
    // TEST 8 – Admin raises a cliff period update request
    // =========================================================================
    it("Admin should raise a cliff period update request", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);

        const [updateCliffRequestPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("record_update_request"), icvUserId, icvUser.publicKey.toBuffer()],
            program.programId
        );

        const now = Math.floor(Date.now() / 1000);
        const newCliffPeriod = new anchor.BN(now + 3 * 365 * 24 * 60 * 60);

        await program.methods
            .updateCliffPeriod(
                Array.from(icvUserId),
                icvUser.publicKey,
                newCliffPeriod
            )
            .accounts({
                admin: admin.publicKey,
                coreConfig: configPDA,
            } as any)
            .signers([admin])
            .rpc();

        const request = await program.account.updateCliffPeriodRequest.fetch(updateCliffRequestPDA);
        assert.equal(request.cliffPeriod.toNumber(), newCliffPeriod.toNumber(), "Request cliff period should match");
        assert.ok(request.primaryAccount.equals(icvUser.publicKey), "primaryAccount should match ICV user");

        console.log("✅ Cliff update request created | newCliff:", newCliffPeriod.toNumber());
    });

    // =========================================================================
    // TEST 9 – ICV user (LP / primary account holder) approves cliff update
    // =========================================================================
    it("ICV user (primary account) should approve the cliff period update", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);

        const [updateCliffRequestPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("record_update_request"), icvUserId, icvUser.publicKey.toBuffer()],
            program.programId
        );

        const requestBefore = await program.account.updateCliffPeriodRequest.fetch(updateCliffRequestPDA);
        const expectedNewCliff = requestBefore.cliffPeriod.toNumber();

        await program.methods
            .approveCliffPeriod()
            .accounts({
                request: updateCliffRequestPDA,
                record: recordPDA,
                primaryAccount: icvUser.publicKey,
                primaryAccountSigner: icvUser.publicKey,
            } as any)
            .signers([icvUser])
            .rpc();

        const record = await program.account.record.fetch(recordPDA);
        assert.equal(record.cliffPeriod.toNumber(), expectedNewCliff, "Record cliff period should be updated");

        const reqInfo = await provider.connection.getAccountInfo(updateCliffRequestPDA);
        assert.isNull(reqInfo, "UpdateCliffPeriodRequest PDA should be closed after approval");

        console.log("✅ Cliff period approved | cliffPeriod:", record.cliffPeriod.toNumber());
    });

    // =========================================================================
    // TEST 10a – Add first partner (realloc: BASE_SIZE → BASE_SIZE + 4)
    // =========================================================================
    it("Admin should add a partner to the whitelist (realloc grows account)", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);
        const partnerA = 321420; // numeric suffix from "zp_321420"

        const infoBefore = await provider.connection.getAccountInfo(recordPDA);
        const sizeBefore = infoBefore!.data.length; // should be BASE_SIZE = 137

        await program.methods
            .updatePartnerWhitelist(
                Array.from(icvUserId),
                icvUser.publicKey,
                { add: {} },   // WhitelistAction::Add
                partnerA
            )
            .accounts({
                record: recordPDA,
                admin: admin.publicKey,
                coreConfig: configPDA,
            } as any)
            .signers([admin])
            .rpc();

        const record = await program.account.record.fetch(recordPDA);
        assert.deepEqual(record.whitelistedPartners, [partnerA], "whitelist should contain partnerA");

        const infoAfter = await provider.connection.getAccountInfo(recordPDA);
        assert.equal(
            infoAfter!.data.length,
            sizeBefore + 4,
            "account should have grown by 4 bytes (one u32 slot)"
        );
        console.log("✅ Added partner", partnerA, "| bytes:", sizeBefore, "→", infoAfter!.data.length);
    });

    // =========================================================================
    // TEST 10b – Add second partner (realloc grows another 4 bytes)
    // =========================================================================
    it("Admin should add a second partner (realloc grows again)", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);
        const partnerB = 654321;

        const infoBefore = await provider.connection.getAccountInfo(recordPDA);
        const sizeBefore = infoBefore!.data.length; // BASE_SIZE + 4

        await program.methods
            .updatePartnerWhitelist(
                Array.from(icvUserId),
                icvUser.publicKey,
                { add: {} },
                partnerB
            )
            .accounts({
                record: recordPDA,
                admin: admin.publicKey,
                coreConfig: configPDA,
            } as any)
            .signers([admin])
            .rpc();

        const record = await program.account.record.fetch(recordPDA);
        assert.equal(record.whitelistedPartners.length, 2, "whitelist should have 2 entries");
        assert.include(record.whitelistedPartners, partnerB, "partnerB should be in the list");

        const infoAfter = await provider.connection.getAccountInfo(recordPDA);
        assert.equal(
            infoAfter!.data.length,
            sizeBefore + 4,
            "account should have grown by another 4 bytes"
        );
        console.log("✅ Added partner", partnerB, "| bytes:", sizeBefore, "→", infoAfter!.data.length);
    });

    // =========================================================================
    // TEST 10c – Add duplicate partner (must fail with PartnerAlreadyWhitelisted)
    // =========================================================================
    it("Admin should NOT be able to add a duplicate partner", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);
        const partnerA = 321420; // already in the list from 10a

        try {
            await program.methods
                .updatePartnerWhitelist(
                    Array.from(icvUserId),
                    icvUser.publicKey,
                    { add: {} },
                    partnerA
                )
                .accounts({
                    record: recordPDA,
                    admin: admin.publicKey,
                    coreConfig: configPDA,
                } as any)
                .signers([admin])
                .rpc();
            assert.fail("Expected transaction to fail with PartnerAlreadyWhitelisted");
        } catch (err: any) {
            assert.include(err.message, "PartnerAlreadyWhitelisted", "error should be PartnerAlreadyWhitelisted");
            console.log("✅ Correctly rejected duplicate partner add");
        }
    });

    // =========================================================================
    // TEST 10d – Remove a partner (realloc shrinks account, rent refunded)
    // =========================================================================
    it("Admin should remove a partner from the whitelist (realloc shrinks account)", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);
        const partnerA = 321420;

        const infoBefore = await provider.connection.getAccountInfo(recordPDA);
        const sizeBefore  = infoBefore!.data.length;    // BASE_SIZE + 8 (two partners)
        const lamportsBefore = infoBefore!.lamports;

        await program.methods
            .updatePartnerWhitelist(
                Array.from(icvUserId),
                icvUser.publicKey,
                { remove: {} },  // WhitelistAction::Remove
                partnerA
            )
            .accounts({
                record: recordPDA,
                admin: admin.publicKey,
                coreConfig: configPDA,
            } as any)
            .signers([admin])
            .rpc();

        const record = await program.account.record.fetch(recordPDA);
        assert.equal(record.whitelistedPartners.length, 1, "whitelist should have 1 entry after removal");
        assert.notInclude(record.whitelistedPartners, partnerA, "partnerA should no longer be in the list");

        const infoAfter = await provider.connection.getAccountInfo(recordPDA);
        assert.equal(
            infoAfter!.data.length,
            sizeBefore - 4,
            "account should have shrunk by 4 bytes (one u32 slot freed)"
        );
        assert.isBelow(
            infoAfter!.lamports,
            lamportsBefore,
            "excess rent-exempt lamports should have been refunded to admin"
        );
        console.log("✅ Removed partner", partnerA, "| bytes:", sizeBefore, "→", infoAfter!.data.length);
    });

    // =========================================================================
    // TEST 10e – Remove non-existent partner (must fail with PartnerNotWhitelisted)
    // =========================================================================
    it("Admin should NOT be able to remove a partner that is not in the whitelist", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);
        const nonExistent = 999999;

        try {
            await program.methods
                .updatePartnerWhitelist(
                    Array.from(icvUserId),
                    icvUser.publicKey,
                    { remove: {} },
                    nonExistent
                )
                .accounts({
                    record: recordPDA,
                    admin: admin.publicKey,
                    coreConfig: configPDA,
                } as any)
                .signers([admin])
                .rpc();
            assert.fail("Expected transaction to fail with PartnerNotWhitelisted");
        } catch (err: any) {
            assert.include(err.message, "PartnerNotWhitelisted", "error should be PartnerNotWhitelisted");
            console.log("✅ Correctly rejected removal of non-existent partner");
        }
    });

    // =========================================================================
    // TEST 11 – Admin revokes the ICV user whitelist
    // =========================================================================
    it("Admin should revoke the ICV user whitelist", async () => {
        const recordPDA = deriveRecordPDA(icvUserId, icvUser.publicKey);

        await program.methods
            .revoke()
            .accounts({
                admin: admin.publicKey,
                coreConfig: configPDA,
            } as any)
            .remainingAccounts([
                { pubkey: recordPDA, isSigner: false, isWritable: true },
            ])
            .signers([admin])
            .rpc();

        const accountInfo = await provider.connection.getAccountInfo(recordPDA);
        assert.isNull(accountInfo, "Record PDA should be closed after revoke");

        console.log("✅ Whitelist revoked | recordPDA:", recordPDA.toBase58(), "is now closed");
    });
});


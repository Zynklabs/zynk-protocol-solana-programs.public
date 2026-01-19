import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  createInitializeAccountInstruction,
  ACCOUNT_SIZE,
} from "@solana/spl-token";
import { ZynkProtocol } from "../target/types/zynk_protocol";
import { assert, expect } from "chai";
import { createHash, randomUUID } from "crypto";

const generateOrderId = (): Buffer => {
  const zynkPartnerId = `zp_32142`;
  const transactionId = `txn_${randomUUID()}`;
  
  const orderKey = `${zynkPartnerId}::${transactionId}`;
  const hash = createHash('sha256').update(orderKey).digest('hex');
  
  return Buffer.from(hash.slice(0, 32));
};

// Helper to derive order tracker PDA
const deriveOrderTrackerPDA = (
  programId: PublicKey,
  beneficiary: PublicKey,
  orderId: Buffer
): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("order_tracker"),
      beneficiary.toBuffer(),
      orderId,
    ],
    programId
  );
};

const DOMAIN_SEPARATOR = 1151111081099710

const TimelockAction = {
  TransferAdmin: 0,
  UpdateManager: 1,
  UpdateGuardian: 2,
  UpdateZynkOpWallet: 3,
  Unpause: 4,
} as const;

const timelockDelays = {
  [TimelockAction.TransferAdmin]: 24 * 60 * 60,
  [TimelockAction.UpdateManager]: 12 * 60 * 60,
  [TimelockAction.UpdateGuardian]: 48 * 60 * 60,
  [TimelockAction.UpdateZynkOpWallet]: 12 * 60 * 60,
  [TimelockAction.Unpause]: 6 * 60 * 60,
}

describe("zynk-protocol", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ZynkProtocol as Program<ZynkProtocol>;

  // Test wallets (keypairs)
  const admin = Keypair.generate();
  const zynkOpWallet = Keypair.generate();
  const manager = Keypair.generate();
  const guardian = Keypair.generate();
  const partnerOperationalWallet = Keypair.generate();
  const partnerDepositVault = Keypair.generate();
  
  // Partner ID for PDA derivation (32 bytes)
  const partnerId = Buffer.alloc(32);
  partnerId.write("zp_123456", 0, "utf-8");
  
  // Partner deposit wallet PDA
  const [partnerDepositWalletPDA, partnerDepositWalletBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("partner_deposit_wallet"), partnerId],
    program.programId
  );

  // Config account PDA (to be initialized)
  const [configPDA, _] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  // Token accounts
  let tokenMint: PublicKey;
  let zynkOpTokenAccount: PublicKey;
  let partnerOperationalTokenAccount: PublicKey;
  let partnerDepositTokenAccount: PublicKey;

  // Track order details between tests
  let currentOrderId: Buffer;
  let currentOrderTrackerPDA: PublicKey;
  let currentBeneficiary: PublicKey;
  let orderCounter = 0; // To generate unique order IDs

  let timelockPDA: PublicKey;

  before(async () => {
    // Airdrop SOL to test wallets for transactions
    for (const kp of [
      admin,
      manager,
      guardian,
      zynkOpWallet,
      partnerOperationalWallet,
    ]) {
      const tx = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(tx, 'confirmed');
    }
    
    // Airdrop to partner deposit wallet PDA (needs funding for rent)
    const tx = await provider.connection.requestAirdrop(
      partnerDepositWalletPDA,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(tx, 'confirmed');

    // Create test token (using admin as mint authority)
    tokenMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      9 // 9 decimals like SOL
    );

    // Create token accounts for all wallets
    zynkOpTokenAccount = await createAccount(
      provider.connection,
      zynkOpWallet,
      tokenMint,
      zynkOpWallet.publicKey
    );

    partnerOperationalTokenAccount = await createAccount(
      provider.connection,
      partnerOperationalWallet,
      tokenMint,
      partnerOperationalWallet.publicKey
    );

    // Create a regular token account for the PDA (not an ATA, since PDAs are off-curve)
    const partnerDepositTokenAccountKeypair = Keypair.generate();
    const rentExemptAmount = await provider.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
    
    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: manager.publicKey,
      newAccountPubkey: partnerDepositTokenAccountKeypair.publicKey,
      space: ACCOUNT_SIZE,
      lamports: rentExemptAmount,
      programId: TOKEN_PROGRAM_ID,
    });
    
    const initializeAccountIx = createInitializeAccountInstruction(
      partnerDepositTokenAccountKeypair.publicKey,
      tokenMint,
      partnerDepositWalletPDA // PDA is the owner
    );
    
    const createTokenAccountTx = new anchor.web3.Transaction().add(createAccountIx, initializeAccountIx);
    await provider.sendAndConfirm(createTokenAccountTx, [manager, partnerDepositTokenAccountKeypair]);
    partnerDepositTokenAccount = partnerDepositTokenAccountKeypair.publicKey;

    // Mint tokens to zynkOpWallet and partnerDepositVault
    await mintTo(
      provider.connection,
      admin,
      tokenMint,
      zynkOpTokenAccount,
      admin.publicKey,
      10000000000000 // Initial supply for zynk operator
    );

    await mintTo(
      provider.connection,
      admin,
      tokenMint,
      partnerDepositTokenAccount,
      admin.publicKey,
      10000000000000 // Initial supply for partner deposit
    );
  });

  it("Initializes the protocol", async () => {
    await program.methods
      .initialize(zynkOpWallet.publicKey, guardian.publicKey, manager.publicKey)
      .accounts({
        config: configPDA,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // Verify config account fields
    const configAccount = await program.account.config.fetch(configPDA);
    assert.ok(configAccount.admin.equals(admin.publicKey));
    assert.ok(configAccount.manager.equals(manager.publicKey));
    assert.ok(configAccount.guardian.equals(guardian.publicKey));
    assert.ok(configAccount.zynkOpWallet.equals(zynkOpWallet.publicKey));
    assert.equal(configAccount.paused, false);
  });

  it("Pulls tokens from partner_deposit_wallet to zynkOpWallet and sends tokens from zynkOpWallet to partner_operational_wallet", async () => {
    const amount = new anchor.BN(100000000000);
    
    // Generate unique order tracker ID and derive PDA
    orderCounter++;
    currentOrderId = generateOrderId();
    currentBeneficiary = partnerOperationalWallet.publicKey;
    [currentOrderTrackerPDA] = deriveOrderTrackerPDA(
      program.programId,
      currentBeneficiary,
      currentOrderId
    );

    const sourceBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerOperationalTokenAccount
    );

    await program.methods
      .pullAndCreateOrder(
        currentOrderId,
        Array.from(partnerId),
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVault.publicKey,
        pdvTokenAccount: partnerDepositTokenAccount,
        partnerDepositWallet: partnerDepositWalletPDA,
        pdwTokenAccount: partnerDepositTokenAccount,
        zynkOpWallet: zynkOpWallet.publicKey,
        zowTokenAccount: zynkOpTokenAccount,
        beneficiaryTokenAccount: partnerOperationalTokenAccount,
        orderTracker: currentOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([manager, zynkOpWallet, partnerDepositVault])
      .rpc();
    
    // Verify token pull
    const sourceBalance_postTx = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    assert.equal(+sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount, +amount)
    
    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      partnerOperationalTokenAccount
    );
    assert.equal(+destBalance_postTx.value.amount - +destBalance_preTx.value.amount, +amount)

    // Verify OrderTracker stores correct partner deposit wallet
    const orderTrackerAccount = await program.account.orderTracker.fetch(currentOrderTrackerPDA);
    assert.equal(orderTrackerAccount.partnerDepositVault.toBase58(), partnerDepositVault.publicKey.toBase58())
    assert.equal(orderTrackerAccount.beneficiaryWallet.toBase58(), partnerOperationalWallet.publicKey.toBase58())
    
    const orderAmountIn = orderTrackerAccount.amountIn
    const orderAmountOut = orderTrackerAccount.amountOut
    assert.equal(orderAmountIn.toNumber(), amount.toNumber());
    assert.equal(orderAmountOut.toNumber(), amount.toNumber());
  });


  it("Creates order without transferring tokens, in case of zero amount", async () => {
    const amount = new anchor.BN(0);
    
    // Generate unique order tracker ID and derive PDA
    orderCounter++;
    currentOrderId = generateOrderId();
    currentBeneficiary = partnerOperationalWallet.publicKey;
    [currentOrderTrackerPDA] = deriveOrderTrackerPDA(
      program.programId,
      currentBeneficiary,
      currentOrderId
    );

    const sourceBalance_preTx = await provider.connection.getTokenAccountBalance(
      zynkOpTokenAccount
    );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerOperationalTokenAccount
    );

    await program.methods
      .createOrder(
        currentOrderId,
        Array.from(partnerId),
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        pdvTokenAccount: partnerDepositTokenAccount,
        zynkOpWallet: zynkOpWallet.publicKey,
        zowTokenAccount: zynkOpTokenAccount,
        beneficiaryTokenAccount: partnerOperationalTokenAccount,
        orderTracker: currentOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([manager, zynkOpWallet])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx = await provider.connection.getTokenAccountBalance(
      zynkOpTokenAccount
    );
    assert.equal(+sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount, 0)
    
    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      partnerOperationalTokenAccount
    );
    assert.equal(+destBalance_postTx.value.amount - +destBalance_preTx.value.amount, 0)

    // Verify OrderTracker stores correct details
    const orderTrackerAccount = await program.account.orderTracker.fetch(currentOrderTrackerPDA);
    assert.equal(orderTrackerAccount.partnerDepositVault.toBase58(), partnerDepositVault.publicKey.toBase58())
    assert.equal(orderTrackerAccount.beneficiaryWallet.toBase58(), partnerOperationalWallet.publicKey.toBase58())
    
    const orderAmountIn = orderTrackerAccount.amountIn
    const orderAmountOut = orderTrackerAccount.amountOut
    assert.equal(orderAmountIn.toNumber(), 0);
    assert.equal(orderAmountOut.toNumber(), 0);
  });

  it("Should emit OrderCreation event with correct meta", async () => {
    const amount = new anchor.BN(0);
    const meta = [
      { key: "txType", value: "0" },
      { key: "txAmount", value: "100000000000" }
    ];

    // Generate unique order tracker ID and derive PDA
    orderCounter++;
    const tempOrderId = generateOrderId();
    const tempBeneficiary = partnerOperationalWallet.publicKey;
    const [tempOrderTrackerPDA] = deriveOrderTrackerPDA(
      program.programId,
      tempBeneficiary,
      tempOrderId
    );

    const listener = program.addEventListener("orderCreation", (event, _slot) => {
      if (event.orderId !== tempOrderId) return;

      try {
        assert.equal(event.orderId, tempOrderId);
        assert.equal(event.beneficiaryWallet.toBase58(), tempBeneficiary.toBase58());
        assert.equal(event.token.toBase58(), tokenMint.toBase58());
        assert.equal(event.partnerDepositVault.toBase58(), partnerDepositVault.publicKey.toBase58());
        assert.equal(event.amount.toNumber(), amount.toNumber());
        assert.equal(event.domainSeparator.toNumber(), DOMAIN_SEPARATOR);
        assert.equal(event.token.toBase58(), tokenMint.toBase58())
        assert.equal(event.partnerDepositWallet.toBase58(), partnerDepositWalletPDA.toBase58())
        assert.equal(event.beneficiaryWallet.toBase58(), partnerOperationalWallet.publicKey.toBase58())
        assert.equal(event.amount.toNumber(), amount.toNumber())
        assert.equal(event.domainSeparator.toNumber(), DOMAIN_SEPARATOR)

        assert.ok(event.meta, "Meta should be present");
        assert.lengthOf(event.meta, meta.length, `Meta should have ${meta.length} entries`);
        meta.forEach((item, idx) => {
          assert.strictEqual(event.meta[idx].key, item.key);
          assert.strictEqual(event.meta[idx].value, item.value);
        });
      } catch (err) {
        throw err;
      }
    });

    await program.methods
      .createOrder(
        tempOrderId,
        Array.from(partnerId),
        amount,
        meta
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        pdvTokenAccount: partnerDepositTokenAccount,
        zynkOpWallet: zynkOpWallet.publicKey,
        zowTokenAccount: zynkOpTokenAccount,
        beneficiaryTokenAccount: partnerOperationalTokenAccount,
        orderTracker: tempOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([manager, zynkOpWallet])
      .rpc();

    await new Promise((resolve) => setTimeout(resolve, 1000));
    await program.removeEventListener(listener);
  });

  it("Sends tokens from zynkOpWallet to partner_operational_wallet", async () => {
    const amount = new anchor.BN(100000000000);
    
    // Generate unique order tracker ID and derive PDA
    orderCounter++;
    currentOrderId = generateOrderId();
    currentBeneficiary = partnerOperationalWallet.publicKey;
    [currentOrderTrackerPDA] = deriveOrderTrackerPDA(
      program.programId,
      currentBeneficiary,
      currentOrderId
    );

    const sourceBalance_preTx = await provider.connection.getTokenAccountBalance(
      zynkOpTokenAccount
    );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerOperationalTokenAccount
    );

    await program.methods
      .createOrder(
        currentOrderId,
        Array.from(partnerId),
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        pdvTokenAccount: partnerDepositTokenAccount,
        zynkOpWallet: zynkOpWallet.publicKey,
        zowTokenAccount: zynkOpTokenAccount,
        beneficiaryTokenAccount: partnerOperationalTokenAccount,
        orderTracker: currentOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([manager, zynkOpWallet])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx = await provider.connection.getTokenAccountBalance(
      zynkOpTokenAccount
    );
    assert.equal(+sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount, +amount)
    
    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      partnerOperationalTokenAccount
    );
    assert.equal(+destBalance_postTx.value.amount - +destBalance_preTx.value.amount, +amount)

    // Verify OrderTracker stores correct details
    const orderTrackerAccount = await program.account.orderTracker.fetch(currentOrderTrackerPDA);
    assert.equal(orderTrackerAccount.partnerDepositVault.toBase58(), partnerDepositVault.publicKey.toBase58())
    assert.equal(orderTrackerAccount.beneficiaryWallet.toBase58(), partnerOperationalWallet.publicKey.toBase58())

    const orderAmountIn = orderTrackerAccount.amountIn
    const orderAmountOut = orderTrackerAccount.amountOut
    assert.equal(orderAmountIn.toNumber(), 0);
    assert.equal(orderAmountOut.toNumber(), amount.toNumber());
  });

  it("Should fail closing order with zero amount_in via replenish", async () => {
    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600;
    try {
      await program.methods
        .replenish(
          Array.from(partnerId),
          orderId,
          new anchor.BN(validity),
          new anchor.BN(0), // Zero amount
          true, // close_order = true
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositWallet: partnerDepositWalletPDA,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: orderTracker.publicKey,
          manager: manager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected close order to fail with zero amount_in");
    } catch (error) {
      assert.include(
        error.message,
        "AmountMustBePositive",
        "Expected AmountMustBePositive error (can't replenish with zero)"
      );
    }
  });

  it("Should fail closing order when amount_in is less than amount_out", async () => {
    const amount = new anchor.BN(50000000000);
    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600;

    await program.methods
        .replenish(
          Array.from(partnerId),
          orderId,
          new anchor.BN(validity),
          amount,
          false, // close_order = false (partial replenish)
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositWallet: partnerDepositWalletPDA,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: orderTracker.publicKey,
          manager: manager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();

     // Now try to close with close_order=true, but amount_in (50) < amount_out (100)
     // Use a small positive amount since amount must be > 0, but total will still be < amount_out
     try {
      await program.methods
        .replenish(
          Array.from(partnerId),
          orderId,
          new anchor.BN(validity),
          new anchor.BN(1), // Small amount, but total amount_in (50 + 1 = 51) < amount_out (100)
          true, // close_order = true
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositWallet: partnerDepositWalletPDA,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: orderTracker.publicKey,
          manager: manager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected close order to fail when amount_in is less than amount_out");
    } catch (error) {
      assert.include(
        error.message,
        "DeficientOrder",
        "Expected DeficientOrder error"
      );
    }
  });

  it("Replenishes tokens from partner_deposit_wallet to zynk_op_wallet", async () => {
    const amount = new anchor.BN(100000000000);
    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600; // Valid for 1 hour

    const sourceBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      zynkOpTokenAccount
    );

    let orderTrackerAccount = await program.account.orderTracker.fetch(currentOrderTrackerPDA);
    const orderAmountIn_preTx = orderTrackerAccount.amountIn

    await program.methods
      .replenish(Array.from(partnerId), orderId, new anchor.BN(validity), amount, false, null)
      .accounts({
        config: configPDA,
        partnerDepositWallet: partnerDepositWalletPDA,
        pdwTokenAccount: partnerDepositTokenAccount,
        zowTokenAccount: zynkOpTokenAccount,
        orderTracker: orderTracker.publicKey,
        manager: manager.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    assert.equal(+sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount, +amount)
    
    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      zynkOpTokenAccount
    );
    assert.equal(+destBalance_postTx.value.amount - +destBalance_preTx.value.amount, +amount)

    // Verify that orderTracker is still active
    const orderTrackerInfo = await provider.connection.getAccountInfo(
      currentOrderTrackerPDA
    );
    assert.isNotNull(
      orderTrackerInfo,
      "OrderTracker should still be active after replenish"
    );

    orderTrackerAccount = await program.account.orderTracker.fetch(currentOrderTrackerPDA);

    const orderAmountIn_postTx = orderTrackerAccount.amountIn
    assert.equal(orderAmountIn_postTx.toNumber() - orderAmountIn_preTx.toNumber(), amount.toNumber());
  });

  it("Should fail when replenishing with past validity timestamp", async () => {
    const amount = new anchor.BN(50000000000); // 50 token
    const pastTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

    try {
      await program.methods
        .replenish(Array.from(partnerId), orderId, new anchor.BN(pastTimestamp), amount, false, null)
        .accounts({
          config: configPDA,
          partnerDepositWallet: partnerDepositWalletPDA,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: orderTracker.publicKey,
          manager: manager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected replenish to fail with past timestamp");
    } catch (error) {
      // Anchor error codes are returned in a specific format
      // Either match on the error number or a more generic portion of the message
      assert.include(
        error.message,
        "Validity must be in future",
        "Expected 'Validity must be in future' error"
      );
    }
  });

  it("Should fail when replenishing with zero amount", async () => {
    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600;

    try {
      await program.methods
        .replenish(Array.from(partnerId), orderId, new anchor.BN(validity), new anchor.BN(0), false, null)
        .accounts({
          config: configPDA,
          partnerDepositWallet: partnerDepositWalletPDA,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: orderTracker.publicKey,
          manager: manager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected replenish to fail with zero amount");
    } catch (error) {
      assert.include(
        error.message,
        "AmountMustBePositive",
        "Expected AmountMustBePositive error"
      );
    }
  });

  it("Can replenish tokens multiple times before order is closed", async () => {
    const amount = new anchor.BN(50000000000);
    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600; // Valid for 1 hour

    const sourceBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      zynkOpTokenAccount
    );

    // Second replenish operation
    await program.methods
      .replenish(Array.from(partnerId), orderId, new anchor.BN(validity),amount, false, null)
      .accounts({
        config: configPDA,
        partnerDepositWallet: partnerDepositWalletPDA,
        pdwTokenAccount: partnerDepositTokenAccount,
        zowTokenAccount: zynkOpTokenAccount,
        orderTracker: orderTracker.publicKey,
        manager: manager.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    assert.equal(+sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount, +amount)
    
    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      zynkOpTokenAccount
    );
    assert.equal(+destBalance_postTx.value.amount - +destBalance_preTx.value.amount, +amount)

    // Verify that orderTracker is still active
    const orderTrackerInfo = await provider.connection.getAccountInfo(
      currentOrderTrackerPDA
    );
    assert.isNotNull(
      orderTrackerInfo,
      "OrderTracker should still be active after second replenish"
    );
  });

  it("Should fail when wrong signer tries to replenish", async () => {
    // Create a wrong token account (not the one stored in orderTracker)
    // Must manually create since PDA can't own an ATA
    const wrongTokenAccountKeypair = Keypair.generate();
    const rentExemptAmount = await provider.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
    
    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: manager.publicKey,
      newAccountPubkey: wrongTokenAccountKeypair.publicKey,
      space: ACCOUNT_SIZE,
      lamports: rentExemptAmount,
      programId: TOKEN_PROGRAM_ID,
    });
    
    const initializeAccountIx = createInitializeAccountInstruction(
      wrongTokenAccountKeypair.publicKey,
      tokenMint,
      partnerDepositWalletPDA // PDA is the owner
    );
    
    const createTokenAccountTx = new anchor.web3.Transaction().add(createAccountIx, initializeAccountIx);
    await provider.sendAndConfirm(createTokenAccountTx, [manager, wrongTokenAccountKeypair]);
    const wrongTokenAccount = wrongTokenAccountKeypair.publicKey;

    try {
      await program.methods
        .replenish(
          Array.from(partnerId),
          orderId,
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          new anchor.BN(1000000),
          false,
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositWallet: partnerDepositWalletPDA,
          pdwTokenAccount: wrongTokenAccount, // Wrong token account (not the one in orderTracker)
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: orderTracker.publicKey,
          manager: manager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected replenish to fail with wrong signer");
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedSigner",
        "Expected UnauthorizedSigner error"
      );
    }
  });

  it("Should be able close the order by manager via replenish", async () => {
    // First, replenish enough to meet amount_out requirement
    const orderTrackerAccount = await program.account.orderTracker.fetch(orderTracker.publicKey);
    const remainingAmount = orderTrackerAccount.amountOut.sub(orderTrackerAccount.amountIn);
    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600;
    
    // Replenish the remaining amount and close the order
    await program.methods
      .replenish(
        Array.from(partnerId),
        orderId,
        new anchor.BN(validity),
        remainingAmount,
        true, // close_order = true
        null
      )
      .accounts({
        config: configPDA,
        partnerDepositWallet: partnerDepositWalletPDA,
        pdwTokenAccount: partnerDepositTokenAccount,
        zowTokenAccount: zynkOpTokenAccount,
        orderTracker: orderTracker.publicKey,
        manager: manager.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Verify order is closed
    try {
      await program.account.orderTracker.fetch(currentOrderTrackerPDA);
      assert.fail("Expected order to be closed");
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected account to be closed"
      );
    }
  });

  it("Should fail when non-manager tries to close order", async () => {
    const amount = new anchor.BN(100000000000);

    // Create a new order since previous one is closed
    orderCounter++;
    const newOrderId = generateOrderId();
    const newBeneficiary = partnerOperationalWallet.publicKey;
    const [newOrderTrackerPDA] = deriveOrderTrackerPDA(
      program.programId,
      newBeneficiary,
      newOrderId
    );

    // Initialize new order
    await program.methods
      .createOrder(
        Array.from(partnerId),
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        pdvTokenAccount: partnerDepositTokenAccount,
        zynkOpWallet: zynkOpWallet.publicKey,
        zowTokenAccount: zynkOpTokenAccount,
        beneficiaryTokenAccount: partnerOperationalTokenAccount,
        orderTracker: newOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([manager, zynkOpWallet])
      .rpc();

    // Get the order ID
    const orderTrackerAccount = await program.account.orderTracker.fetch(newOrderTracker.publicKey);
    const newOrderId = orderTrackerAccount.orderId;

    // Create a new keypair for non-manager and fund it
    const nonManager = anchor.web3.Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      nonManager.publicKey,
      1000000000
    );
    await provider.connection.confirmTransaction(airdropSig, 'confirmed');

    // First, replenish enough to meet amount_out requirement (using correct manager)
    const remainingAmount = orderTrackerAccount.amountOut.sub(orderTrackerAccount.amountIn);
    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600;
    
    // Replenish the remaining amount (but don't close yet)
    await program.methods
      .replenish(
        Array.from(partnerId),
        newOrderId,
        new anchor.BN(validity),
        remainingAmount,
        false, // Don't close yet
        null
      )
      .accounts({
        config: configPDA,
        partnerDepositWallet: partnerDepositWalletPDA,
        pdwTokenAccount: partnerDepositTokenAccount,
        zowTokenAccount: zynkOpTokenAccount,
        orderTracker: newOrderTracker.publicKey,
        manager: manager.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();
    
    // Now try to close with a non-manager
    try {
      await program.methods
        .replenish(
          Array.from(partnerId),
          newOrderId,
          new anchor.BN(validity),
          new anchor.BN(1), // Small positive amount (amount must be > 0)
          true, // close_order = true (requires manager authorization)
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositWallet: partnerDepositWalletPDA,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: newOrderTracker.publicKey,
          manager: nonManager.publicKey, // Wrong manager
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([nonManager])
        .rpc();
      assert.fail("Expected close order to fail with non-manager signer");
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedManager",
        "Expected UnauthorizedManager error"
      );
    }
  });

  it("Should fail when trying to close an already closed order via replenish", async () => {
    // Attempt to close the already closed order
    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600;
    try {
      await program.methods
        .replenish(
          Array.from(partnerId),
          orderId,
          new anchor.BN(validity),
          new anchor.BN(0),
          true, // close_order = true
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositWallet: partnerDepositWalletPDA,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: orderTracker.publicKey,
          manager: manager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected close order to fail on already closed order");
    } catch (error) {
      assert.include(
        error.message,
        "AccountNotInitialized",
        "Expected AccountNotInitialized error when closing an already closed order"
      );
    }
  });

  it("Should fail when trying to replenish a closed order", async () => {
    const amount = new anchor.BN(1000000)
    // Attempt to replenish the closed order
    try {
      await program.methods
        .replenish(
          Array.from(partnerId),
          orderId,
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          amount,
          false,
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositWallet: partnerDepositWalletPDA,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: orderTracker.publicKey,
          manager: manager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected replenish to fail on closed order");
    } catch (error) {
      assert.include(
        error.message,
        "AccountNotInitialized",
        "Expected AccountNotInitialized error when replenishing a closed order"
      );
    }
  });

  it("Should fail when deposit wallet has insufficient balance", async () => {
    const amount = new anchor.BN(100000000000);
    
    // Create a new order since previous one is closed
    orderCounter++;
    const newOrderId = generateOrderId();
    const newBeneficiary = partnerOperationalWallet.publicKey;
    const [newOrderTrackerPDA] = deriveOrderTrackerPDA(
      program.programId,
      newBeneficiary,
      newOrderId
    );
    
    // Initialize new order
    await program.methods
      .createOrder(
        Array.from(partnerId),
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        pdvTokenAccount: partnerDepositTokenAccount,
        zynkOpWallet: zynkOpWallet.publicKey,
        zowTokenAccount: zynkOpTokenAccount,
        beneficiaryTokenAccount: partnerOperationalTokenAccount,
        orderTracker: newOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([manager, zynkOpWallet])
      .rpc();

    // First drain the deposit wallet by replenishing the maximum amount
    const currentBalance = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    await program.methods
      .replenish(
        Array.from(partnerId),
        newOrderId,
        new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
        new anchor.BN(currentBalance.value.amount),
        false,
        null
      )
      .accounts({
        config: configPDA,
        partnerDepositWallet: partnerDepositWalletPDA,
        pdwTokenAccount: partnerDepositTokenAccount,
        zowTokenAccount: zynkOpTokenAccount,
        orderTracker: newOrderTracker.publicKey,
        manager: manager.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Now try to replenish more than the available balance
    try {
      await program.methods
        .replenish(
          Array.from(partnerId),
          newOrderId,
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          new anchor.BN(1000000),
          false,
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositWallet: partnerDepositWalletPDA,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: newOrderTracker.publicKey,
          manager: manager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected replenish to fail with insufficient balance");
    } catch (error) {
      assert.include(
        error.message,
        "insufficient funds",
        "Expected insufficient funds error"
      );
    }
  });

  it("Should be able to pause by manager", async () => {
    await program.methods
      .pause()
      .accounts({
        config: configPDA,
        authority: manager.publicKey
      })
      .signers([manager])
      .rpc()

    const configAccount = await program.account.config.fetch(configPDA);
    assert.ok(configAccount.paused, "Expected program to be paused!")
  })

  it("Should be able to pause by admin", async () => {
    await program.methods
      .pause()
      .accounts({
        config: configPDA,
        authority: admin.publicKey
      })
      .signers([admin])
      .rpc()

    const configAccount = await program.account.config.fetch(configPDA);
    assert.ok(configAccount.paused, "Expected program to be paused!")
  })

  it("Should be able to pause by guardian", async () => {
    await program.methods
      .pause()
      .accounts({
        config: configPDA,
        authority: guardian.publicKey
      })
      .signers([guardian])
      .rpc()

    const configAccount = await program.account.config.fetch(configPDA);
    assert.ok(configAccount.paused, "Expected program to be paused!")
  })

  it("Should not be able to pause by non-authority", async () => {
    // Create a wrong keypair for this test
    const wrongAuthority = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      wrongAuthority.publicKey,
      1000000000
    );
    await provider.connection.confirmTransaction(airdropSig, 'confirmed');
    
    try {
      await program.methods
        .pause()
        .accounts({
          config: configPDA,
          authority: wrongAuthority.publicKey
        })
        .signers([wrongAuthority])
        .rpc()
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedSigner",
        "Expected UnauthorizedSigner error"
      )
    }
  })

  it("Should not be able to request timelock by non-manager", async () => {
    const action = TimelockAction.UpdateGuardian
    const [timelockPDA, _] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("timelock"),
        Buffer.from([action]),
      ],
      program.programId
    );

    try {
      await program.methods
        .requestTimelock(action, guardian.publicKey)
        .accounts({
          config: configPDA,
          timelock: timelockPDA,
          manager: guardian.publicKey
        })
        .signers([guardian])
        .rpc()
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedManager",
        "Expected UnauthorizedManager error"
      )
    }
  })

  it("Should be able to request timelock by manager", async () => {
    const action = TimelockAction.Unpause
    const result = PublicKey.findProgramAddressSync(
      [
        Buffer.from("timelock"),
        Buffer.from([action]),
      ],
      program.programId
    );
    timelockPDA = result[0]

    await program.methods
      .requestTimelock(action, guardian.publicKey)
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        manager: manager.publicKey
      })
      .signers([manager])
      .rpc()

    const timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.equal(timelockAccount.action, action);
    assert.ok(!timelockAccount.executed, "Timelock should not be in executed state");
    assert.ok(!timelockAccount.ack, "Timelock should not be in ack'ed state");
    assert.ok(!timelockAccount.consensus, "Timelock should not be a consensus request");
    assert.equal(timelockAccount.value.toBase58(), guardian.publicKey.toBase58());

    const expectedDelay = timelockDelays[action];
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(timelockAccount.eta.toNumber() - (now + expectedDelay)) < 10);
  })

  it("Should not be able to execute timelock before eta", async () => {
    const timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.ok(Math.floor(Date.now() / 1000) < timelockAccount.eta.toNumber(), "ETA elapsed already.");

    try {
      await program.methods
        .executeUnpause()
        .accounts({
          config: configPDA,
          timelock: timelockPDA,
          admin: admin.publicKey
        })
        .signers([admin])
        .rpc()
    } catch (error) {
      assert.include(
        error.message,
        "ActionUnderReview",
        "Expected ActionUnderReview error"
      )
    }
  })

  it("Should not be able to ack timelock by non-guardian", async () => {
    try {
      await program.methods
        .ackTimelock()
        .accounts({
          config: configPDA,
          timelock: timelockPDA,
          guardian: admin.publicKey
        })
        .signers([admin])
        .rpc()
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedGuardian",
        "Expected UnauthorizedGuardian error"
      )
    }
  })

  it("Should not be able to execute unpause using a wrong timelock request", async () => {
    let configAccount = await program.account.config.fetch(configPDA);
    assert.ok(configAccount.paused, "Expected program to be paused!")

    const action = TimelockAction.UpdateZynkOpWallet
    const [ wrongTimelockPDA, ] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("timelock"),
        Buffer.from([action]),
      ],
      program.programId
    );

    ///// Request wrong timelock /////
    await program.methods
      .requestTimelock(action, guardian.publicKey)
      .accounts({
        config: configPDA,
        timelock: wrongTimelockPDA,
        manager: manager.publicKey
      })
      .signers([manager])
      .rpc()

    ///// Guardian ack for execution readiness /////
    await program.methods
        .ackTimelock()
        .accounts({
          config: configPDA,
          timelock: wrongTimelockPDA,
          guardian: guardian.publicKey
        })
        .signers([guardian])
        .rpc()

    const timelockAccount = await program.account.request.fetch(wrongTimelockPDA);
    assert.ok(timelockAccount.ack, "Timelock not ack'ed!");

      
    try {
       ///// Execute unpause with wrong timelock /////
      await program.methods
        .executeUnpause()
        .accounts({
          config: configPDA,
          timelock: wrongTimelockPDA,
          admin: admin.publicKey
        })
        .signers([admin])
        .rpc()
    } catch (error) {
      assert.include(
        error.message,
        "InvalidAction",
        "Expected InvalidAction error"
      )
    }

    configAccount = await program.account.config.fetch(configPDA);
    assert.ok(configAccount.paused, "Expected program to be paused!")
  })

  it("Should be able to execute timelock by admin before eta, if guardian acks", async () => {
    let configAccount = await program.account.config.fetch(configPDA);
    assert.ok(configAccount.paused, "Expected program to be paused!")

    await program.methods
        .ackTimelock()
        .accounts({
          config: configPDA,
          timelock: timelockPDA,
          guardian: guardian.publicKey
        })
        .signers([guardian])
        .rpc()

    const timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.ok(timelockAccount.ack, "Timelock not ack'ed!");

    await program.methods
      .executeUnpause()
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        admin: admin.publicKey
      })
      .signers([admin])
      .rpc()

    configAccount = await program.account.config.fetch(configPDA);
    assert.ok(!configAccount.paused, "Expected program to be unpaused!")
    
    try {
      const timelockAccount = await program.account.request.fetch(timelockPDA);
      console.log(timelockAccount)
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected `Account does not exist` error"
      )
    }
  })

  it("Should be able to revoke timelock by admin, once guardian acks", async () => {
    const action = TimelockAction.UpdateGuardian
    const [timelockPDA, _] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("timelock"),
        Buffer.from([action]),
      ],
      program.programId
    );

    await program.methods
      .requestTimelock(action, guardian.publicKey)
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        manager: manager.publicKey
      })
      .signers([manager])
      .rpc()

    let timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.equal(timelockAccount.action, action);

    await program.methods
        .ackTimelock()
        .accounts({
          config: configPDA,
          timelock: timelockPDA,
          guardian: guardian.publicKey
        })
        .signers([guardian])
        .rpc()

    timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.ok(timelockAccount.ack, "Timelock not ack'ed!");

    await program.methods
      .revokeTimelock()
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        admin: admin.publicKey
      })
      .signers([admin])
      .rpc()
    
    try {
      const timelockAccount = await program.account.request.fetch(timelockPDA);
      console.log(timelockAccount)
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected `Account does not exist` error"
      )
    }
  })

  it("Should not be able to request consensus by non-manager", async () => {
    const action = TimelockAction.TransferAdmin
    const [timelockPDA, _] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("timelock"),
        Buffer.from([action]),
      ],
      program.programId
    );

    try {
      await program.methods
        .requestConsensus(action, guardian.publicKey)
        .accounts({
          config: configPDA,
          timelock: timelockPDA,
          manager: admin.publicKey,
          zynkOpWallet: zynkOpWallet.publicKey
        })
        .signers([admin, zynkOpWallet])
        .rpc()
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedManager",
        "Expected UnauthorizedManager error"
      )
    }
  })

  it("Should not be able to request consensus by non-zow", async () => {
    const action = TimelockAction.TransferAdmin
    const [timelockPDA, _] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("timelock"),
        Buffer.from([action]),
      ],
      program.programId
    );

    try {
      await program.methods
        .requestConsensus(action, guardian.publicKey)
        .accounts({
          config: configPDA,
          timelock: timelockPDA,
          manager: manager.publicKey,
          zynkOpWallet: manager.publicKey 
        })
        .signers([manager, manager])
        .rpc()
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedSigner",
        "Expected UnauthorizedSigner error"
      )
    }
  })

  it("Should be able to request consensus by valid signers", async () => {
    const action = TimelockAction.TransferAdmin
    const result = PublicKey.findProgramAddressSync(
      [
        Buffer.from("timelock"),
        Buffer.from([action]),
      ],
      program.programId
    );
    timelockPDA = result[0]

    await program.methods
      .requestConsensus(action, guardian.publicKey)
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        manager: manager.publicKey,
        zynkOpWallet: zynkOpWallet.publicKey
      })
      .signers([manager, zynkOpWallet])
      .rpc()

    let timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.equal(timelockAccount.action, action);
    assert.ok(timelockAccount.consensus, "Timelock should be a consensus request");
    assert.ok(!timelockAccount.executed, "Timelock should not be in executed state");
    assert.ok(!timelockAccount.ack, "Timelock should not be in ack'ed state");
    assert.equal(timelockAccount.value.toBase58(), guardian.publicKey.toBase58());
  })

  it("Should be able to execute consensus request by guardian", async () => {
    let timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.ok(timelockAccount.consensus, "Timelock should be a consensus request");

    await program.methods
      .executeConsensus()
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        guardian: guardian.publicKey,
      })
      .signers([guardian])
      .rpc()

    // timelock account must be closed
    try {
      timelockAccount = await program.account.request.fetch(timelockPDA);
      console.log(timelockAccount)
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected `Account does not exist` error"
      )
    }

    const configAccount = await program.account.config.fetch(configPDA);
    assert.equal(configAccount.admin.toBase58(), guardian.publicKey.toBase58())
  })

  it("Should not be able to execute non-consensus request by guardian", async () => {
    const action = TimelockAction.TransferAdmin
    const [timelockPDA, _] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("timelock"),
        Buffer.from([action]),
      ],
      program.programId
    );

   await program.methods
      .requestTimelock(action, guardian.publicKey)
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        manager: manager.publicKey
      })
      .signers([manager])
      .rpc()

    let timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.equal(timelockAccount.action, action);
    assert.ok(!timelockAccount.consensus, "Timelock should not be a consensus request");
    assert.equal(timelockAccount.value.toBase58(), guardian.publicKey.toBase58());

    try {
      await program.methods
        .executeConsensus()
        .accounts({
          config: configPDA,
          timelock: timelockPDA,
          guardian: guardian.publicKey,
        })
        .signers([guardian])
        .rpc()
    } catch (error) {
      assert.include(
        error.message,
        "InvalidAction",
        "Expected InvalidAction error"
      )
    }

    timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.ok(!timelockAccount.executed, "Timelock should not be in executed state");
    assert.ok(!timelockAccount.ack, "Timelock should not be in ack'ed state");
    assert.ok(!timelockAccount.consensus, "Timelock should not be a consensus request");
  })
});

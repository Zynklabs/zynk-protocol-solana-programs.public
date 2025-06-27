import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
} from "@solana/spl-token";
import { ZynkProtocol } from "../target/types/zynk_protocol";
import { assert, expect } from "chai";

describe("zynk-protocol", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ZynkProtocol as Program<ZynkProtocol>;

  // Test wallets (keypairs)
  const admin = Keypair.generate();
  const zynkOpWallet = Keypair.generate();
  const paybackWallet = Keypair.generate();
  const partnerOperationalWallet = Keypair.generate();
  const partnerDepositWallet = Keypair.generate();

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
  let paybackTokenAccount: PublicKey;

  // Track order details between tests
  let orderTracker: Keypair;
  let orderId: anchor.BN;

  before(async () => {
    // Airdrop SOL to test wallets for transactions
    for (const kp of [
      admin,
      zynkOpWallet,
      partnerOperationalWallet,
      partnerDepositWallet,
      paybackWallet,
    ]) {
      const tx = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(tx);
    }

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

    partnerDepositTokenAccount = await createAccount(
      provider.connection,
      partnerDepositWallet,
      tokenMint,
      partnerDepositWallet.publicKey
    );

    paybackTokenAccount = await createAccount(
      provider.connection,
      paybackWallet,
      tokenMint,
      paybackWallet.publicKey
    );

    // Mint tokens to zynkOpWallet and partnerDepositWallet
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
      .initialize(zynkOpWallet.publicKey, paybackWallet.publicKey)
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
    assert.ok(configAccount.zynkOpWallet.equals(zynkOpWallet.publicKey));
    assert.ok(configAccount.paybackWallet.equals(paybackWallet.publicKey));
    assert.equal(configAccount.paused, false);
    assert.equal(configAccount.currentNonce.toNumber(), 0);
  });

  it("Pulls tokens from partner_deposit_wallet to zynkOpWallet and sends tokens from zynkOpWallet to partner_operational_wallet", async () => {
    const amount = new anchor.BN(100000000000);
    orderTracker = Keypair.generate();

    const sourceBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerOperationalTokenAccount
    );

    await program.methods
      .pullAndSend(
        tokenMint,
        amount,
        partnerDepositWallet.publicKey 
      )
      .accounts({
        config: configPDA,
        zynkOpWallet: zynkOpWallet.publicKey,
        sourceTokenAccount: zynkOpTokenAccount,
        partnerOperationalWallet: partnerOperationalTokenAccount,
        depositWallet: partnerDepositWallet.publicKey,
        depositTokenAccount: partnerDepositTokenAccount,
        paybackTokenAccount: paybackTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        orderTracker: orderTracker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([orderTracker, zynkOpWallet, partnerDepositWallet])
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
    const orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTracker.publicKey
    );
    assert.ok(
      orderTrackerAccount.partnerDepositWallet.equals(
        partnerDepositWallet.publicKey
      )
    );
    orderId = orderTrackerAccount.orderId
    assert.ok(orderId.toNumber() > 0);
  });

  it("Sends tokens from zynkOpWallet to partner_operational_wallet", async () => {
    const amount = new anchor.BN(100000000000);
    orderTracker = Keypair.generate();

    const sourceBalance_preTx = await provider.connection.getTokenAccountBalance(
      zynkOpTokenAccount
    );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerOperationalTokenAccount
    );

    await program.methods
      .send(
        tokenMint,
        amount,
        partnerDepositWallet.publicKey // wallet that will be used later for replenish
      )
      .accounts({
        config: configPDA,
        zynkOpWallet: zynkOpWallet.publicKey,
        sourceTokenAccount: zynkOpTokenAccount,
        partnerOperationalWallet: partnerOperationalTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        orderTracker: orderTracker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([orderTracker, zynkOpWallet])
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

    // Verify OrderTracker stores correct partner deposit wallet
    const orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTracker.publicKey
    );
    assert.ok(
      orderTrackerAccount.partnerDepositWallet.equals(
        partnerDepositWallet.publicKey
      )
    );
    orderId = orderTrackerAccount.orderId;
    assert.ok(orderId.toNumber() > 0);
  });

  it("Replenishes tokens from partner_deposit_wallet to payback_wallet", async () => {
    const paybackAmount = new anchor.BN(100000000000);
    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600; // Valid for 1 hour

    const sourceBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+paybackAmount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      paybackTokenAccount
    );

    await program.methods
      .replenish(orderId, new anchor.BN(validity), paybackAmount)
      .accounts({
        config: configPDA,
        orderTracker: orderTracker.publicKey,
        depositWallet: partnerDepositWallet.publicKey,
        depositTokenAccount: partnerDepositTokenAccount,
        paybackTokenAccount: paybackTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([partnerDepositWallet])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx = await provider.connection.getTokenAccountBalance(
      zynkOpTokenAccount
    );
    assert.equal(+sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount, +paybackAmount)
    
    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      partnerOperationalTokenAccount
    );
    assert.equal(+destBalance_postTx.value.amount - +destBalance_preTx.value.amount, +paybackAmount)

    // Verify that orderTracker is still active
    const orderTrackerInfo = await provider.connection.getAccountInfo(
      orderTracker.publicKey
    );
    assert.isNotNull(
      orderTrackerInfo,
      "OrderTracker should still be active after replenish"
    );
  });

  it("Should fail when replenishing with past validity timestamp", async () => {
    const paybackAmount = new anchor.BN(50000000000); // 50 token
    const pastTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

    try {
      await program.methods
        .replenish(orderId, new anchor.BN(pastTimestamp), paybackAmount)
        .accounts({
          config: configPDA,
          orderTracker: orderTracker.publicKey,
          depositWallet: partnerDepositWallet.publicKey,
          depositTokenAccount: partnerDepositTokenAccount,
          paybackTokenAccount: paybackTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partnerDepositWallet])
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
        .replenish(orderId, new anchor.BN(validity), new anchor.BN(0))
        .accounts({
          config: configPDA,
          orderTracker: orderTracker.publicKey,
          depositWallet: partnerDepositWallet.publicKey,
          depositTokenAccount: partnerDepositTokenAccount,
          paybackTokenAccount: paybackTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partnerDepositWallet])
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
    const paybackAmount = new anchor.BN(50000000000);
    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600; // Valid for 1 hour

    const sourceBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+paybackAmount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      paybackTokenAccount
    );

    // Second replenish operation
    await program.methods
      .replenish(orderId, new anchor.BN(validity), paybackAmount)
      .accounts({
        config: configPDA,
        orderTracker: orderTracker.publicKey,
        depositWallet: partnerDepositWallet.publicKey,
        depositTokenAccount: partnerDepositTokenAccount,
        paybackTokenAccount: paybackTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([partnerDepositWallet])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    assert.equal(+sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount, +paybackAmount)
    
    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      paybackTokenAccount
    );
    assert.equal(+destBalance_postTx.value.amount - +destBalance_preTx.value.amount, +paybackAmount)

    // Verify that orderTracker is still active
    const orderTrackerInfo = await provider.connection.getAccountInfo(
      orderTracker.publicKey
    );
    assert.isNotNull(
      orderTrackerInfo,
      "OrderTracker should still be active after second replenish"
    );
  });

  it("Should fail when wrong signer tries to replenish", async () => {
    const wrongSigner = anchor.web3.Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      wrongSigner.publicKey,
      1000000000
    );
    await provider.connection.confirmTransaction(airdropSig);

    try {
      await program.methods
        .replenish(
          orderId,
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          new anchor.BN(1000000)
        )
        .accounts({
          config: configPDA,
          orderTracker: orderTracker.publicKey,
          depositWallet: wrongSigner.publicKey,
          depositTokenAccount: partnerDepositTokenAccount,
          paybackTokenAccount: paybackTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([wrongSigner])
        .rpc();
      assert.fail("Expected replenish to fail with wrong signer");
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedSender",
        "Expected UnauthorizedSender error"
      );
    }
  });

  it("Closes the replenish order by admin", async () => {
    // Admin closes the order
    await program.methods
      .closeOrder(orderId)
      .accounts({
        config: configPDA,
        admin: admin.publicKey,
        orderTracker: orderTracker.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // Verify order is closed
    try {
      await program.account.orderTracker.fetch(orderTracker.publicKey);
      assert.fail("Expected order to be closed");
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected account to be closed"
      );
    }
  });

  it("Should fail when non-admin tries to close order", async () => {
    // Create a new order since previous one is closed
    const newOrderTracker = Keypair.generate();

    // Initialize new order
    await program.methods
      .send(
        tokenMint,
        new anchor.BN(100000000000),
        partnerDepositWallet.publicKey
      )
      .accounts({
        config: configPDA,
        zynkOpWallet: zynkOpWallet.publicKey,
        sourceTokenAccount: zynkOpTokenAccount,
        partnerOperationalWallet: partnerOperationalTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        orderTracker: newOrderTracker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([newOrderTracker, zynkOpWallet])
      .rpc();

    // Create a new keypair for non-admin and fund it
    const nonAdmin = anchor.web3.Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      nonAdmin.publicKey,
      1000000000
    );
    await provider.connection.confirmTransaction(airdropSig);

    try {
      await program.methods
        .closeOrder(orderId)
        .accounts({
          config: configPDA,
          admin: nonAdmin.publicKey,
          orderTracker: newOrderTracker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([nonAdmin])
        .rpc();
      assert.fail("Expected close order to fail with non-admin signer");
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedAdmin",
        "Expected UnauthorizedAdmin error"
      );
    }
  });

  it("Fails when trying to close an already closed order", async () => {
    // Attempt to close the already closed order
    try {
      await program.methods
        .closeOrder(orderId)
        .accounts({
          config: configPDA,
          admin: admin.publicKey,
          orderTracker: orderTracker.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([admin])
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

  it("Fails when trying to replenish a closed order", async () => {
    // Attempt to replenish the closed order
    try {
      await program.methods
        .replenish(
          orderId,
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          new anchor.BN(1000000)
        )
        .accounts({
          config: configPDA,
          orderTracker: orderTracker.publicKey,
          depositWallet: partnerDepositWallet.publicKey,
          depositTokenAccount: partnerDepositTokenAccount,
          paybackTokenAccount: paybackTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partnerDepositWallet])
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
    // Create a new order since previous one is closed
    const newOrderTracker = Keypair.generate();

    // Initialize new order
    await program.methods
      .send(
        tokenMint,
        new anchor.BN(100000000000),
        partnerDepositWallet.publicKey
      )
      .accounts({
        config: configPDA,
        zynkOpWallet: zynkOpWallet.publicKey,
        sourceTokenAccount: zynkOpTokenAccount,
        partnerOperationalWallet: partnerOperationalTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        orderTracker: newOrderTracker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([newOrderTracker, zynkOpWallet])
      .rpc();

    // Get the order ID from the new order tracker
    const orderTrackerAccount = await program.account.orderTracker.fetch(
      newOrderTracker.publicKey
    );
    const newOrderId = orderTrackerAccount.orderId;

    // First drain the deposit wallet by replenishing the maximum amount
    const currentBalance = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    await program.methods
      .replenish(
        newOrderId,
        new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
        new anchor.BN(currentBalance.value.amount)
      )
      .accounts({
        config: configPDA,
        orderTracker: newOrderTracker.publicKey,
        depositWallet: partnerDepositWallet.publicKey,
        depositTokenAccount: partnerDepositTokenAccount,
        paybackTokenAccount: paybackTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([partnerDepositWallet])
      .rpc();

    // Now try to replenish more than the available balance
    try {
      await program.methods
        .replenish(
          newOrderId,
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          new anchor.BN(1000000)
        )
        .accounts({
          config: configPDA,
          orderTracker: newOrderTracker.publicKey,
          depositWallet: partnerDepositWallet.publicKey,
          depositTokenAccount: partnerDepositTokenAccount,
          paybackTokenAccount: paybackTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partnerDepositWallet])
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
});

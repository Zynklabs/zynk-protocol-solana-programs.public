import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
} from "@solana/spl-token";
import { ZynkProtocol } from "../target/types/zynk_protocol";
import { assert, expect } from "chai";
import { TextEncoder } from "util";
import nacl from 'tweetnacl';


const buildEd25519Ix = (msg: string, signer: Keypair) => {
  const message = new TextEncoder().encode(msg);
  const signature = nacl.sign.detached(message, signer.secretKey);

  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: signer.publicKey.toBuffer(),
    message,
    signature,
  });

  return { ed25519Ix, signature }
}

const DOMAIN_SEPARATOR = 1151111081099710

enum TimelockAction {
  TransferAdmin,
  UpdateManager,
  UpdateGuardian,
  UpdateZynkOpWallet,
  Unpause,
}

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

  // Track order details between tests
  let orderTracker: Keypair;
  let orderId: anchor.BN;

  let timelockPDA: PublicKey;

  before(async () => {
    // Airdrop SOL to test wallets for transactions
    for (const kp of [
      admin,
      manager,
      guardian,
      zynkOpWallet,
      partnerDepositWallet,
      partnerOperationalWallet,
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

    const message = `${DOMAIN_SEPARATOR}::${partnerOperationalWallet.publicKey.toBase58()}`
    const { ed25519Ix, signature } = buildEd25519Ix(message, manager)
    
    await program.methods
      .pullAndSend(
        amount,
        Buffer.from(signature).toJSON().data
      )
      .accounts({
        config: configPDA,
        partnerDepositWallet: partnerDepositWallet.publicKey,
        pdwTokenAccount: partnerDepositTokenAccount,
        zynkOpWallet: zynkOpWallet.publicKey,
        zowTokenAccount: zynkOpTokenAccount,
        beneficiaryTokenAccount: partnerOperationalTokenAccount,
        orderTracker: orderTracker.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
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

    const orderAmountIn = orderTrackerAccount.amountIn
    const orderAmountOut = orderTrackerAccount.amountOut
    assert.equal(orderAmountIn.toNumber(), amount.toNumber());
    assert.equal(orderAmountOut.toNumber(), amount.toNumber());
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

    const message = `${DOMAIN_SEPARATOR}::${partnerOperationalWallet.publicKey.toBase58()}`
    const { ed25519Ix, signature } = buildEd25519Ix(message, manager)

    await program.methods
      .send(
        amount,
        partnerDepositWallet.publicKey, // wallet that will be used later for replenish
        Buffer.from(signature).toJSON().data
      )
      .accounts({
        config: configPDA,
        zynkOpWallet: zynkOpWallet.publicKey,
        zowTokenAccount: zynkOpTokenAccount,
        beneficiaryTokenAccount: partnerOperationalTokenAccount,
        orderTracker: orderTracker.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
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

    // Verify OrderTracker stores correct details
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

    const orderAmountIn = orderTrackerAccount.amountIn
    const orderAmountOut = orderTrackerAccount.amountOut
    assert.equal(orderAmountIn.toNumber(), 0);
    assert.equal(orderAmountOut.toNumber(), amount.toNumber());
  });

  it("Should fail closing order with zero amount_in", async () => {
    try {
      await program.methods
        .closeOrder(orderId)
        .accounts({
          config: configPDA,
          manager: manager.publicKey,
          orderTracker: orderTracker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected close order to fail with zero amount_in");
    } catch (error) {
      assert.include(
        error.message,
        "DeficientOrder",
        "Expected DeficientOrder error"
      );
    }
  });

  it("Should fail closing order when amount_in is less than amount_out", async () => {
    const amount = new anchor.BN(50000000000);
    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600;

    await program.methods
        .replenish(orderId, new anchor.BN(validity), amount)
        .accounts({
          config: configPDA,
          partnerDepositWallet: partnerDepositWallet.publicKey,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: orderTracker.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([partnerDepositWallet])
        .rpc();

     try {
      await program.methods
        .closeOrder(orderId)
        .accounts({
          config: configPDA,
          manager: manager.publicKey,
          orderTracker: orderTracker.publicKey,
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

    let orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTracker.publicKey
    );
    const orderAmountIn_preTx = orderTrackerAccount.amountIn

    await program.methods
      .replenish(orderId, new anchor.BN(validity), amount)
      .accounts({
        config: configPDA,
        partnerDepositWallet: partnerDepositWallet.publicKey,
        pdwTokenAccount: partnerDepositTokenAccount,
        zowTokenAccount: zynkOpTokenAccount,
        orderTracker: orderTracker.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([partnerDepositWallet])
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
      orderTracker.publicKey
    );
    assert.isNotNull(
      orderTrackerInfo,
      "OrderTracker should still be active after replenish"
    );

    orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTracker.publicKey
    );

    const orderAmountIn_postTx = orderTrackerAccount.amountIn
    assert.equal(orderAmountIn_postTx.toNumber() - orderAmountIn_preTx.toNumber(), amount.toNumber());
  });

  it("Should fail when replenishing with past validity timestamp", async () => {
    const amount = new anchor.BN(50000000000); // 50 token
    const pastTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

    try {
      await program.methods
        .replenish(orderId, new anchor.BN(pastTimestamp), amount)
        .accounts({
          config: configPDA,
          partnerDepositWallet: partnerDepositWallet.publicKey,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: orderTracker.publicKey,
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
          partnerDepositWallet: partnerDepositWallet.publicKey,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: orderTracker.publicKey,
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
      .replenish(orderId, new anchor.BN(validity), amount)
      .accounts({
        config: configPDA,
        partnerDepositWallet: partnerDepositWallet.publicKey,
        pdwTokenAccount: partnerDepositTokenAccount,
        zowTokenAccount: zynkOpTokenAccount,
        orderTracker: orderTracker.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([partnerDepositWallet])
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
          partnerDepositWallet: wrongSigner.publicKey,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: orderTracker.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([wrongSigner])
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

  it("Closes the replenish order by manager", async () => {
    // Admin closes the order
    await program.methods
      .closeOrder(orderId)
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        orderTracker: orderTracker.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([manager])
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

  it("Should fail when non-manager tries to close order", async () => {
    // Create a new order since previous one is closed
    const newOrderTracker = Keypair.generate();

    const message = `${DOMAIN_SEPARATOR}::${partnerOperationalWallet.publicKey.toBase58()}`
    const { ed25519Ix, signature } = buildEd25519Ix(message, manager)

    // Initialize new order
    await program.methods
      .send(
        new anchor.BN(100000000000),
        partnerDepositWallet.publicKey,
        Buffer.from(signature).toJSON().data
      )
      .accounts({
        config: configPDA,
        zynkOpWallet: zynkOpWallet.publicKey,
        zowTokenAccount: zynkOpTokenAccount,
        beneficiaryTokenAccount: partnerOperationalTokenAccount,
        orderTracker: newOrderTracker.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
      .signers([newOrderTracker, zynkOpWallet])
      .rpc();

    // Create a new keypair for non-admin and fund it
    const nonManager = anchor.web3.Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      nonManager.publicKey,
      1000000000
    );
    await provider.connection.confirmTransaction(airdropSig);

    try {
      await program.methods
        .closeOrder(orderId)
        .accounts({
          config: configPDA,
          manager: nonManager.publicKey,
          orderTracker: newOrderTracker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([nonManager])
        .rpc();
      assert.fail("Expected close order to fail with non-admin signer");
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedManager",
        "Expected UnauthorizedManager error"
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
          manager: manager.publicKey,
          orderTracker: orderTracker.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
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
          partnerDepositWallet: partnerDepositWallet.publicKey,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: orderTracker.publicKey,
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

    const message = `${DOMAIN_SEPARATOR}::${partnerOperationalWallet.publicKey.toBase58()}`
    const { ed25519Ix, signature } = buildEd25519Ix(message, manager)
    
    // Initialize new order
    await program.methods
      .send(
        new anchor.BN(100000000000),
        partnerDepositWallet.publicKey,
        Buffer.from(signature).toJSON().data
      )
      .accounts({
        config: configPDA,
        zynkOpWallet: zynkOpWallet.publicKey,
        zowTokenAccount: zynkOpTokenAccount,
        beneficiaryTokenAccount: partnerOperationalTokenAccount,
        orderTracker: newOrderTracker.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
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
        partnerDepositWallet: partnerDepositWallet.publicKey,
        pdwTokenAccount: partnerDepositTokenAccount,
        zowTokenAccount: zynkOpTokenAccount,
        orderTracker: newOrderTracker.publicKey,
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
          partnerDepositWallet: partnerDepositWallet.publicKey,
          pdwTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: newOrderTracker.publicKey,
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
    try {
      await program.methods
        .pause()
        .accounts({
          config: configPDA,
          authority: partnerDepositWallet.publicKey
        })
        .signers([partnerDepositWallet])
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
        "UnauthorizedAdmin",
        "Expected UnauthorizedAdmin error"
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
          zynkOpWallet: partnerDepositWallet.publicKey
        })
        .signers([manager, partnerDepositWallet])
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

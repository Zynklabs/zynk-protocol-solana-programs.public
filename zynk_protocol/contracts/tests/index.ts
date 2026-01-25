import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
} from "@solana/spl-token";
import { ZynkProtocol } from "../target/types/zynk_protocol";
import { assert, expect } from "chai";
import { createHash, randomUUID } from "crypto";
import { TextEncoder } from "util";
import nacl from 'tweetnacl';
import { sha256 } from "@noble/hashes/sha2";

const zynkPartnerId = `zp_32142`;
const generateOrderId = (): Buffer => {
  const transactionId = `txn_${randomUUID()}`;
  
  const orderKey = `${zynkPartnerId}::${transactionId}`;
  const hash = createHash('sha256').update(orderKey).digest('hex');
  
  return Buffer.from(hash.slice(0, 32));
};

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
  Unpause
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
  
  // Partner ID for PDA derivation (32 bytes)
  const partnerId = Buffer.alloc(32);
  partnerId.write(zynkPartnerId, 0, "utf-8");
  
  // Partner deposit vault PDA
  const [partnerDepositVaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("partner_deposit_vault"), partnerId],
    program.programId
  );

  // Config account PDA (to be initialized)
  const [configPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  // Token accounts
  let tokenMint: PublicKey;
  let zynkOpTokenAccount: PublicKey;
  let partnerOperationalTokenAccount: PublicKey;
  let partnerDepositTokenAccount: PublicKey;
  
  let timelockPDA: PublicKey;

  let currentOrderId: Buffer;
  let currentOrderTrackerPDA: PublicKey;

  // Helper to derive order tracker PDA
  const deriveOrderTrackerPDA = (
    orderId: Buffer,
    target: PublicKey | string = partnerOperationalWallet.publicKey,
  ): PublicKey=> {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("order_tracker"),
        typeof target === "string" ? Buffer.from(target) : target.toBuffer(),
        orderId,
      ],
      program.programId
    )[0];
  };

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
    
    partnerDepositTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      partnerOperationalWallet,
      tokenMint,
      partnerDepositVaultPDA,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      true // allowOwnerOffCurve
    )
    
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

  it("Pulls tokens from partner_deposit_vault to zynkOpWallet and sends tokens from zynkOpWallet to partner_operational_wallet", async () => {
    const amount = new anchor.BN(100000000000);
    
    currentOrderId = generateOrderId();
    currentOrderTrackerPDA = deriveOrderTrackerPDA(currentOrderId);

    const sourceBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerOperationalTokenAccount
    );

    await program.methods
      .pullAndCreateOrder(
        Array.from(partnerId),
        Array.from(currentOrderId),
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
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
      partnerDepositTokenAccount
    );
    assert.equal(+sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount, +amount)
    
    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      partnerOperationalTokenAccount
    );
    assert.equal(+destBalance_postTx.value.amount - +destBalance_preTx.value.amount, +amount)

    // Verify OrderTracker stores correct partner deposit vault
    const orderTrackerAccount = await program.account.orderTracker.fetch(currentOrderTrackerPDA);
    assert.equal(orderTrackerAccount.partnerDepositVault.toBase58(), partnerDepositVaultPDA.toBase58())
    assert.equal(orderTrackerAccount.beneficiaryWallet.toBase58(), partnerOperationalWallet.publicKey.toBase58())
    
    const orderAmountIn = orderTrackerAccount.amountIn
    const orderAmountOut = orderTrackerAccount.amountOut
    assert.equal(orderAmountIn.toNumber(), amount.toNumber());
    assert.equal(orderAmountOut.toNumber(), amount.toNumber());
  });


  it("Creates order without transferring tokens, in case of zero amount", async () => {
    const amount = new anchor.BN(0);
    
    currentOrderId = generateOrderId();
    currentOrderTrackerPDA = deriveOrderTrackerPDA(currentOrderId);

    const sourceBalance_preTx = await provider.connection.getTokenAccountBalance(
      zynkOpTokenAccount
    );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerOperationalTokenAccount
    );

    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(currentOrderId),
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
    assert.equal(orderTrackerAccount.partnerDepositVault.toBase58(), partnerDepositVaultPDA.toBase58())
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

    const tempOrderId = generateOrderId();
    const tempOrderTrackerPDA = deriveOrderTrackerPDA(tempOrderId);

    const listener = program.addEventListener("orderCreation", (event, _slot) => {
      if (!Buffer.from(event.orderId).equals(Buffer.from(tempOrderId))) return;
      
      try {
        assert.equal(event.domainSeparator.toNumber(), DOMAIN_SEPARATOR)
        assert.equal(event.token.toBase58(), tokenMint.toBase58())
        assert.equal(event.amount.toNumber(), amount.toNumber())
        assert.equal(event.partnerDepositVault.toBase58(), partnerDepositVaultPDA.toBase58());
        assert.equal(event.beneficiaryWallet.toBase58(), partnerOperationalWallet.publicKey.toBase58())

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
        Array.from(partnerId),
        Array.from(tempOrderId),
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
    
    currentOrderId = generateOrderId();
    currentOrderTrackerPDA = deriveOrderTrackerPDA(currentOrderId);

    const sourceBalance_preTx = await provider.connection.getTokenAccountBalance(
      zynkOpTokenAccount
    );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      partnerOperationalTokenAccount
    );

    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(currentOrderId),
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
    assert.equal(orderTrackerAccount.partnerDepositVault.toBase58(), partnerDepositVaultPDA.toBase58())
    assert.equal(orderTrackerAccount.beneficiaryWallet.toBase58(), partnerOperationalWallet.publicKey.toBase58())

    const orderAmountIn = orderTrackerAccount.amountIn
    const orderAmountOut = orderTrackerAccount.amountOut
    assert.equal(orderAmountIn.toNumber(), 0);
    assert.equal(orderAmountOut.toNumber(), amount.toNumber());
  });

  it("Should fail closing order when amount_in is less than amount_out", async () => {
    const amount = new anchor.BN(50000000000);
    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600;

    await program.methods
        .replenish(
          Array.from(currentOrderId),
          new anchor.BN(validity),
          amount,
          false, // close_order = false (partial replenish)
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: currentOrderTrackerPDA,
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
          Array.from(currentOrderId),
          new anchor.BN(validity),
          new anchor.BN(1), // Small amount, but total amount_in (50 + 1 = 51) < amount_out (100)
          true, // close_order = true
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: currentOrderTrackerPDA,
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

  it("Replenishes tokens from partner_deposit_vault to zynk_op_wallet", async () => {
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
      .replenish(Array.from(currentOrderId), new anchor.BN(validity), amount, false, null)
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: partnerDepositTokenAccount,
        zowTokenAccount: zynkOpTokenAccount,
        orderTracker: currentOrderTrackerPDA,
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
        .replenish(Array.from(currentOrderId), new anchor.BN(pastTimestamp), amount, false, null)
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: currentOrderTrackerPDA,
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
        .replenish(Array.from(currentOrderId), new anchor.BN(validity), new anchor.BN(0), false, null)
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: currentOrderTrackerPDA,
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
        "DeficientOrder",
        "Expected DeficientOrder error"
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
      .replenish(Array.from(currentOrderId), new anchor.BN(validity),amount, false, null)
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: partnerDepositTokenAccount,
        zowTokenAccount: zynkOpTokenAccount,
        orderTracker: currentOrderTrackerPDA,
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

  it("Should fail when wrong PDV is used to replenish", async () => {
    // Create a wrong token account (not the one stored in orderTracker)
    // Must manually create since PDA can't own an ATA
    const partnerId = Buffer.alloc(32);
    partnerId.write("test-id", 0, "utf-8");
    
    const [wrongPartnerDepositVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("partner_deposit_vault"), partnerId],
      program.programId
    );
    
    const wrongTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      partnerOperationalWallet,
      tokenMint,
      wrongPartnerDepositVaultPDA,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      true // allowOwnerOffCurve
    )

    try {
      await program.methods
        .replenish(
          Array.from(currentOrderId),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          new anchor.BN(1000000),
          false,
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: wrongPartnerDepositVaultPDA,
          pdvTokenAccount: wrongTokenAccount, // Wrong token account (not the one in orderTracker)
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: currentOrderTrackerPDA,
          manager: manager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected replenish to fail with wrong PDV");
    } catch (error) {
      assert.include(
        error.message,
        "ConstraintSeeds",
        "Expected ConstraintSeeds error"
      );
    }
  });

  it("Should be able close the order by manager via replenish", async () => {
    // First, replenish enough to meet amount_out requirement
    const orderTrackerAccount = await program.account.orderTracker.fetch(currentOrderTrackerPDA);
    const remainingAmount = orderTrackerAccount.amountOut.sub(orderTrackerAccount.amountIn);
    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600;
    
    // Replenish the remaining amount and close the order
    await program.methods
      .replenish(
        Array.from(currentOrderId),
        new anchor.BN(validity),
        remainingAmount,
        true, // close_order = true
        null
      )
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: partnerDepositTokenAccount,
        zowTokenAccount: zynkOpTokenAccount,
        orderTracker: currentOrderTrackerPDA,
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

    const newOrderId = generateOrderId();
    const newOrderTrackerPDA = deriveOrderTrackerPDA(newOrderId);

    // Initialize new order
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(newOrderId),
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

    // Create a new keypair for non-manager and fund it
    const nonManager = anchor.web3.Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      nonManager.publicKey,
      1000000000
    );
    await provider.connection.confirmTransaction(airdropSig, 'confirmed');

    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600;
    
    try {
      await program.methods
        .replenish(
          Array.from(newOrderId),
          new anchor.BN(validity),
          new anchor.BN(1),
          true, // close_order = true (requires manager authorization)
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: newOrderTrackerPDA,
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
          Array.from(currentOrderId),
          new anchor.BN(validity),
          new anchor.BN(0),
          true, // close_order = true
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: currentOrderTrackerPDA,
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
          Array.from(currentOrderId),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          amount,
          false,
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: currentOrderTrackerPDA,
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

  it("Should fail when deposit vault has insufficient balance", async () => {
    const amount = new anchor.BN(100000000000);
    
    // Create a new order since previous one is closed
    const newOrderId = generateOrderId();
    const newOrderTrackerPDA = deriveOrderTrackerPDA(newOrderId);
    
    // Initialize new order
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(newOrderId),
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

    // First drain the deposit vault by replenishing the maximum amount
    const currentBalance = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    await program.methods
      .replenish(
        Array.from(newOrderId),
        new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
        new anchor.BN(currentBalance.value.amount),
        false,
        null
      )
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: partnerDepositTokenAccount,
        zowTokenAccount: zynkOpTokenAccount,
        orderTracker: newOrderTrackerPDA,
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
          Array.from(newOrderId),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          new anchor.BN(1000000),
          false,
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: partnerDepositTokenAccount,
          zowTokenAccount: zynkOpTokenAccount,
          orderTracker: newOrderTrackerPDA,
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
  
  const EthereumZynkOpWalletAddress = "0xy82t3g2v3263712863728g3281378232"
  const EthereumRecipientAddress = "0x12876382t3fg237623r75e121321e21"
  const EthereumTxnOut = "0xbsyuadgwgd816213f2v2g3v723f2tv327t323f27c1v"
  const EthereumTxnIn = "0x8723t4gvru3b2yr8327432gb8dy32ieuh38yeb38e382"
  const BridgeTxnOut = "jidabuibf871yeu3brg3vrg3v3t27vg3vsdfg3"
  const BridgeTxnIn = "0xjkb32f32d3wh87egy3u2vbrg3v3782dgihbdkjfh9273tg3"
  const attestOrderId = generateOrderId();
  const attestOrderTrackerPDA = deriveOrderTrackerPDA(attestOrderId, "attest");
  const amount = new anchor.BN(100);
  
  it("Should attest trans-chain order creation", async () => {
    const listener = program.addEventListener("attestation", (event, _slot) => {
      if (!Buffer.from(event.orderId).equals(Buffer.from(attestOrderId))) return;

      try {
        assert.equal(event.originChain, "Solana")
        assert.equal(event.targetChain, "Ethereum")
        assert.equal(event.origin, zynkOpWallet.publicKey.toString())
        assert.equal(event.proxy, EthereumZynkOpWalletAddress)
        assert.equal(event.target, EthereumRecipientAddress)
        assert.equal(event.txn, EthereumTxnOut)
        assert.equal(event.proxyTxn, BridgeTxnOut)
        assert.equal(event.asset, "USDC")
        assert.equal(event.proxyAsset, "USDT")
        assert.equal(event.amount.toNumber(), amount.toNumber())
      } catch (err) {
        throw err;
      }
    });
    
    const message = `${DOMAIN_SEPARATOR}::${zynkOpWallet.publicKey.toString()}::${EthereumZynkOpWalletAddress}::${EthereumRecipientAddress}::${EthereumTxnOut}`
    const { ed25519Ix, signature } = buildEd25519Ix(message, manager)
    
    // Initialize new order
    await program.methods
      .attestOrder(
        Array.from(attestOrderId),
        "Solana",
        "Ethereum",
        zynkOpWallet.publicKey.toString(),
        EthereumZynkOpWalletAddress,
        EthereumRecipientAddress,
        EthereumTxnOut,
        BridgeTxnOut,
        "USDC",
        "USDT",
        amount,
        Buffer.from(signature).toJSON().data,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        orderTracker: attestOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
      .signers([manager])
      .rpc();
    
    const orderTrackerAccount = await program.account.orderTracker.fetch(attestOrderTrackerPDA);
    assert.ok(Buffer.from(orderTrackerAccount.orderId).equals(Buffer.from(attestOrderId)))
   
    const orderAmountIn = orderTrackerAccount.amountIn
    const orderAmountOut = orderTrackerAccount.amountOut
    assert.equal(orderAmountOut.toNumber(), amount.toNumber());
    assert.equal(orderAmountIn.toNumber(), 0);
    
    assert.equal(orderTrackerAccount.partnerDepositVault.toBase58(), PublicKey.default.toBase58())
    assert.equal(orderTrackerAccount.beneficiaryWallet.toBase58(), PublicKey.default.toBase58())
    
    assert.ok(Buffer.from(orderTrackerAccount.partnerId).equals(sha256(Buffer.from(EthereumZynkOpWalletAddress))))
    
    await program.removeEventListener(listener);
  })
  
  it("Should attest trans-chain order closure", async () => {
    const orderTrackerAccount = await program.account.orderTracker.fetch(attestOrderTrackerPDA);
    assert.ok(Buffer.from(orderTrackerAccount.orderId).equals(Buffer.from(attestOrderId)))
    assert.ok(Buffer.from(orderTrackerAccount.partnerId).equals(sha256(Buffer.from(EthereumZynkOpWalletAddress))))
    
    const listener = program.addEventListener("attestation", (event, _slot) => {
      if (!Buffer.from(event.orderId).equals(Buffer.from(attestOrderId))) return;

      try {
        assert.equal(event.originChain, "Ethereum")
        assert.equal(event.targetChain, "Solana")
        assert.equal(event.origin, EthereumRecipientAddress)
        assert.equal(event.proxy, EthereumZynkOpWalletAddress)
        assert.equal(event.target, zynkOpWallet.publicKey.toString())
        assert.equal(event.txn, EthereumTxnIn)
        assert.equal(event.proxyTxn, BridgeTxnIn)
        assert.equal(event.asset, "USDT")
        assert.equal(event.proxyAsset, "USDG")
        assert.equal(event.amount.toNumber(), amount.toNumber())
      } catch (err) {
        throw err;
      }
    });
    
    const message = `${DOMAIN_SEPARATOR}::${EthereumRecipientAddress}::${EthereumZynkOpWalletAddress}::${zynkOpWallet.publicKey.toString()}::${EthereumTxnIn}`
    const { ed25519Ix, signature } = buildEd25519Ix(message, manager)
    
    // Initialize new order
    await program.methods
      .attestOrder(
        Array.from(attestOrderId),
        "Ethereum",
        "Solana",
        EthereumRecipientAddress,
        EthereumZynkOpWalletAddress,
        zynkOpWallet.publicKey.toString(),
        EthereumTxnIn,
        BridgeTxnIn,
        "USDT",
        "USDG",
        amount,
        Buffer.from(signature).toJSON().data,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        orderTracker: attestOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
      .signers([manager])
      .rpc();
    
    try {
      await program.account.request.fetch(attestOrderTrackerPDA);
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected `Account does not exist` error"
      )
    }
    
    await program.removeEventListener(listener);
  })
});

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
import { assert } from "chai";

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

  // Config account (to be initialized)
  const config = Keypair.generate();

  // Token accounts
  let mint: PublicKey;
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
    mint = await createMint(
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
      mint,
      zynkOpWallet.publicKey
    );

    partnerOperationalTokenAccount = await createAccount(
      provider.connection,
      partnerOperationalWallet,
      mint,
      partnerOperationalWallet.publicKey
    );

    partnerDepositTokenAccount = await createAccount(
      provider.connection,
      partnerDepositWallet,
      mint,
      partnerDepositWallet.publicKey
    );

    paybackTokenAccount = await createAccount(
      provider.connection,
      paybackWallet,
      mint,
      paybackWallet.publicKey
    );

    // Mint tokens to zynkOpWallet and partnerDepositWallet
    await mintTo(
      provider.connection,
      admin,
      mint,
      zynkOpTokenAccount,
      admin.publicKey,
      10000000000000 // Initial supply for zynk operator
    );

    await mintTo(
      provider.connection,
      admin,
      mint,
      partnerDepositTokenAccount,
      admin.publicKey,
      10000000000000 // Initial supply for partner deposit
    );
  });

  it("Initializes the protocol", async () => {
    await program.methods
      .initialize(zynkOpWallet.publicKey, paybackWallet.publicKey)
      .accounts({
        config: config.publicKey,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([config, admin])
      .rpc();

    // Verify config account fields
    const configAccount = await program.account.config.fetch(config.publicKey);
    assert.ok(configAccount.admin.equals(admin.publicKey));
    assert.ok(configAccount.zynkOpWallet.equals(zynkOpWallet.publicKey));
    assert.ok(configAccount.paybackWallet.equals(paybackWallet.publicKey));
    assert.equal(configAccount.paused, false);
    assert.equal(configAccount.currentNonce.toNumber(), 0);
  });

  it("Sends tokens from zynkOpWallet to partner_operational_wallet", async () => {
    const amount = new anchor.BN(100000000000); // 100 token
    orderTracker = Keypair.generate();

    await program.methods
      .send(
        mint,
        amount,
        partnerDepositWallet.publicKey // wallet that will be used later for replenish
      )
      .accounts({
        config: config.publicKey,
        zynkOpWallet: zynkOpWallet.publicKey,
        sourceTokenAccount: zynkOpTokenAccount,
        partnerOperationalWallet: partnerOperationalTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        orderTracker: orderTracker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([orderTracker, zynkOpWallet])
      .rpc();

    // Verify token transfer
    const destBalance = await provider.connection.getTokenAccountBalance(
      partnerOperationalTokenAccount
    );
    assert.equal(destBalance.value.amount, "100000000000");

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
    const paybackAmount = new anchor.BN(100000000000); // 100 token
    const now = Math.floor(Date.now() / 1000);
    const validity = now + 3600; // Valid for 1 hour

    await program.methods
      .replenish(orderId, new anchor.BN(validity), paybackAmount)
      .accounts({
        config: config.publicKey,
        orderTracker: orderTracker.publicKey,
        depositWallet: partnerDepositWallet.publicKey,
        depositTokenAccount: partnerDepositTokenAccount,
        paybackTokenAccount: paybackTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([partnerDepositWallet])
      .rpc();

    // Verify token transfer to payback wallet
    const paybackBalance =
      await provider.connection.getTokenAccountBalance(paybackTokenAccount);
    assert.equal(paybackBalance.value.amount, "100000000000");

    // Verify partner deposit wallet's balance was reduced
    const depositBalance = await provider.connection.getTokenAccountBalance(
      partnerDepositTokenAccount
    );
    assert.equal(depositBalance.value.amount, "9900000000000"); // Initial 10000 - 100 tokens

    // Verify that orderTracker is still active
    const orderTrackerInfo = await provider.connection.getAccountInfo(
      orderTracker.publicKey
    );
    assert.isNotNull(
      orderTrackerInfo,
      "OrderTracker should still be active after replenish"
    );
  });

  it("Closes the replenish order by admin", async () => {
    // Admin closes the order
    await program.methods
      .closeOrder(orderId)
      .accounts({
        config: config.publicKey,
        orderTracker: orderTracker.publicKey,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // Verify that orderTracker was closed
    const orderTrackerInfo = await provider.connection.getAccountInfo(
      orderTracker.publicKey
    );
    assert.isNull(
      orderTrackerInfo,
      "OrderTracker should be closed after admin calls close_order"
    );
  });
});

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

  // Test accounts
  const admin = Keypair.generate();
  const zynkOpWallet = Keypair.generate();
  const paybackWallet = Keypair.generate();
  const destinationWallet = Keypair.generate();

  // Config account (to be initialized)
  const config = Keypair.generate();

  // Token accounts
  let mint: PublicKey;
  let zynkOpTokenAccount: PublicKey;
  let destinationTokenAccount: PublicKey;

  before(async () => {
    // Airdrop SOL to admin, zynkOpWallet, and destinationWallet for transactions
    for (const kp of [admin, zynkOpWallet, destinationWallet]) {
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

    // Create token account for zynkOpWallet
    zynkOpTokenAccount = await createAccount(
      provider.connection,
      zynkOpWallet,
      mint,
      zynkOpWallet.publicKey // This is the owner
    );

    // Create token account for destination wallet
    destinationTokenAccount = await createAccount(
      provider.connection,
      destinationWallet,
      mint,
      destinationWallet.publicKey // This is the owner
    );

    // Mint some tokens to zynkOpWallet (1 token = 1e9 units)
    await mintTo(
      provider.connection,
      admin,
      mint,
      zynkOpTokenAccount,
      admin.publicKey,
      1000000000
    );
  });

  it("Initializes the protocol", async () => {
    // Call the initialize instruction to create the config account
    await program.methods
      .initialize(zynkOpWallet.publicKey, paybackWallet.publicKey)
      .accounts({
        config: config.publicKey,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([config, admin])
      .rpc();

    // Fetch the config account and verify its fields
    const configAccount = await program.account.config.fetch(config.publicKey);
    assert.ok(configAccount.admin.equals(admin.publicKey));
    assert.ok(configAccount.zynkOpWallet.equals(zynkOpWallet.publicKey));
    assert.ok(configAccount.paybackWallet.equals(paybackWallet.publicKey));
    assert.equal(configAccount.paused, false);
    assert.equal(configAccount.currentNonce.toNumber(), 0);
  });

  it("Sends tokens from zynkOpWallet to destination", async () => {
    const amount = new anchor.BN(100000000); // 0.1 token (in units of 1e-9)
    const orderTracker = Keypair.generate();

    // No need for an explicit approval if zynkOpWallet is signing the transfer.
    await program.methods
      .send(
        mint,
        amount,
        paybackWallet.publicKey // using paybackWallet as the designated replenishment wallet
      )
      .accounts({
        config: config.publicKey,
        zynkOpWallet: zynkOpWallet.publicKey,
        sourceTokenAccount: zynkOpTokenAccount,
        destinationTokenAccount: destinationTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        orderTracker: orderTracker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([orderTracker, zynkOpWallet])
      .rpc();

    // Verify that the destination account received the tokens
    const destBalance = await provider.connection.getTokenAccountBalance(
      destinationTokenAccount
    );
    assert.equal(destBalance.value.amount, "100000000");

    // Verify that the OrderTracker account was created and stores the correct replenishment wallet
    const orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTracker.publicKey
    );
    assert.ok(
      orderTrackerAccount.replenishmentWallet.equals(paybackWallet.publicKey)
    );
    // order_id should be nonzero (since it was derived from the config nonce)
    assert.ok(orderTrackerAccount.orderId.toNumber() > 0);
  });
});

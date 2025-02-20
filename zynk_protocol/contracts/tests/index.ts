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

  // Config account
  const config = Keypair.generate();

  before(async () => {
    // Airdrop SOL to admin for transactions
    const signature = await provider.connection.requestAirdrop(
      admin.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature);

    // Airdrop SOL to zynkOpWallet for transactions
    const signature2 = await provider.connection.requestAirdrop(
      zynkOpWallet.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature2);
  });

  it("Initializes the protocol", async () => {
    // Create config account
    await program.methods
      .initialize(zynkOpWallet.publicKey, paybackWallet.publicKey)
      .accounts({
        config: config.publicKey,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([config, admin])
      .rpc();

    // Fetch the created config account
    const configAccount = await program.account.config.fetch(config.publicKey);

    // Verify the config account was initialized correctly
    assert.ok(configAccount.admin.equals(admin.publicKey));
    assert.ok(configAccount.zynkOpWallet.equals(zynkOpWallet.publicKey));
    assert.ok(configAccount.paybackWallet.equals(paybackWallet.publicKey));
    assert.equal(configAccount.paused, false);
    assert.equal(configAccount.currentNonce.toNumber(), 0);
  });
});

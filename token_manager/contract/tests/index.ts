import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { ZynkTokenManager } from "../target/types/zynk_token_manager";

describe("zynk-token-manager", () => {
  // Configure the client to use the local cluster
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace
    .ZynkTokenManager as Program<ZynkTokenManager>;
  const provider = program.provider as anchor.AnchorProvider;

  // Generate a new keypair for the token manager account
  const tokenManagerKeypair = anchor.web3.Keypair.generate();

  // Create a mock token address
  const mockToken = anchor.web3.Keypair.generate().publicKey;
  const newAdmin = anchor.web3.Keypair.generate().publicKey;

  // Create an unauthorized user keypair
  const unauthorizedUser = anchor.web3.Keypair.generate();

  it("Initialize token manager", async () => {
    try {
      await program.methods
        .initialize()
        .accounts({
          tokenManager: tokenManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([tokenManagerKeypair])
        .rpc();

      // Fetch the created account
      const account = await program.account.tokenManager.fetch(
        tokenManagerKeypair.publicKey
      );

      expect(account.admin.toString()).to.equal(
        provider.wallet.publicKey.toString()
      );
      expect(account.tokens).to.be.empty;
    } catch (error) {
      console.error("Error:", error);
      throw error;
    }
  });

  it("Add token to whitelist", async () => {
    try {
      await program.methods
        .addToken(mockToken)
        .accounts({
          tokenManager: tokenManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      // Fetch the account and verify token was added
      const account = await program.account.tokenManager.fetch(
        tokenManagerKeypair.publicKey
      );
      expect(account.tokens).to.have.lengthOf(1);
      expect(account.tokens[0].toString()).to.equal(mockToken.toString());
    } catch (error) {
      console.error("Error:", error);
      throw error;
    }
  });

  it("Unauthorized user cannot add token to whitelist", async () => {
    try {
      // Request airdrop for the unauthorized user to pay for transaction fees
      const airdropSignature = await program.provider.connection.requestAirdrop(
        unauthorizedUser.publicKey,
        1 * anchor.web3.LAMPORTS_PER_SOL
      );
      await program.provider.connection.confirmTransaction(airdropSignature);

      // Attempt to add token as unauthorized user
      await program.methods
        .addToken(mockToken)
        .accounts({
          tokenManager: tokenManagerKeypair.publicKey,
          admin: unauthorizedUser.publicKey,
        })
        .signers([unauthorizedUser])
        .rpc();

      // If we reach here, the test should fail
      expect.fail("Expected error but transaction succeeded");
    } catch (error) {
      // Print the full error message
      // console.log("Full error message:", error.message);
      // Verify that the error is due to unauthorized access
      expect(error.message).to.include(
        "Unauthorized: Only the current admin can perform this action"
      );
    }
  });

  it("Remove token from whitelist", async () => {
    try {
      await program.methods
        .removeToken(mockToken)
        .accounts({
          tokenManager: tokenManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      // Fetch the account and verify token was removed
      const account = await program.account.tokenManager.fetch(
        tokenManagerKeypair.publicKey
      );
      expect(account.tokens).to.be.empty;
    } catch (error) {
      console.error("Error:", error);
      throw error;
    }
  });

  it("Unauthorized user cannot remove token from whitelist", async () => {
    try {
      // First add a token back to remove
      await program.methods
        .addToken(mockToken)
        .accounts({
          tokenManager: tokenManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      // Attempt to remove token as unauthorized user
      await program.methods
        .removeToken(mockToken)
        .accounts({
          tokenManager: tokenManagerKeypair.publicKey,
          admin: unauthorizedUser.publicKey,
        })
        .signers([unauthorizedUser])
        .rpc();

      // If we reach here, the test should fail
      expect.fail("Expected error but transaction succeeded");
    } catch (error) {
      // Print the full error message
      // console.log("Full error message:", error.message);
      // Verify that the error is due to unauthorized access
      expect(error.message).to.include(
        "Unauthorized: Only the current admin can perform this action"
      );
    }
  });

  it("Update admin", async () => {
    try {
      await program.methods
        .updateAdmin(newAdmin)
        .accounts({
          tokenManager: tokenManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      // Fetch the account and verify admin was updated
      const account = await program.account.tokenManager.fetch(
        tokenManagerKeypair.publicKey
      );
      expect(account.admin.toString()).to.equal(newAdmin.toString());
    } catch (error) {
      console.error("Error:", error);
      throw error;
    }
  });

  it("Unauthorized user cannot update admin", async () => {
    try {
      const fakeNewAdmin = anchor.web3.Keypair.generate().publicKey;

      // Attempt to update admin as unauthorized user
      await program.methods
        .updateAdmin(fakeNewAdmin)
        .accounts({
          tokenManager: tokenManagerKeypair.publicKey,
          admin: unauthorizedUser.publicKey,
        })
        .signers([unauthorizedUser])
        .rpc();

      // If we reach here, the test should fail
      expect.fail("Expected error but transaction succeeded");
    } catch (error) {
      // Print the full error message
      // console.log("Full error message:", error.message);
      // Verify that the error is due to unauthorized access
      expect(error.message).to.include(
        "Unauthorized: Only the current admin can perform this action"
      );
    }
  });
});

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { ZynkWalletManager } from "../target/types/zynk_wallet_manager";

describe("zynk-wallet-manager", () => {
  // Configure the client to use the local cluster
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace
    .ZynkWalletManager as Program<ZynkWalletManager>;
  const provider = program.provider as anchor.AnchorProvider;

  // Generate a new keypair for the wallet manager account
  const walletManagerKeypair = anchor.web3.Keypair.generate();

  // Create test wallets
  const testDepositWallet = anchor.web3.Keypair.generate().publicKey;
  const testOperationalWallet = anchor.web3.Keypair.generate().publicKey;
  const newAdmin = anchor.web3.Keypair.generate().publicKey;

  // Create an unauthorized user keypair
  const unauthorizedUser = anchor.web3.Keypair.generate();

  // Test identifiers
  const testIdentifier = "test-partner-1";
  const testIdentifier2 = "test-partner-2";
  const longIdentifier = "a".repeat(65); // Longer than MAX_IDENTIFIER_LENGTH (64)

  it("Initialize wallet manager", async () => {
    try {
      await program.methods
        .initialize()
        .accounts({
          walletManager: walletManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([walletManagerKeypair])
        .rpc();

      // Fetch the created account
      const account = await program.account.walletManager.fetch(
        walletManagerKeypair.publicKey
      );

      expect(account.admin.toString()).to.equal(
        provider.wallet.publicKey.toString()
      );
      expect(account.partnerDepositWallets).to.be.empty;
      expect(account.partnerOperationalWallets).to.be.empty;
    } catch (error) {
      console.error("Error:", error);
      throw error;
    }
  });

  it("Add deposit wallet", async () => {
    try {
      await program.methods
        .addDepositWallet(testIdentifier, testDepositWallet)
        .accounts({
          walletManager: walletManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      // Fetch the account and verify wallet was added
      const account = await program.account.walletManager.fetch(
        walletManagerKeypair.publicKey
      );
      expect(account.partnerDepositWallets).to.have.lengthOf(1);
      expect(account.partnerDepositWallets[0].identifier).to.equal(
        testIdentifier
      );
      expect(
        account.partnerDepositWallets[0].depositWallet.toString()
      ).to.equal(testDepositWallet.toString());
    } catch (error) {
      console.error("Error:", error);
      throw error;
    }
  });

  it("Cannot add deposit wallet with too long identifier", async () => {
    try {
      await program.methods
        .addDepositWallet(longIdentifier, testDepositWallet)
        .accounts({
          walletManager: walletManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      expect.fail("Expected error but transaction succeeded");
    } catch (error) {
      expect(error.message).to.include("IdentifierTooLong");
    }
  });

  it("Cannot add duplicate deposit wallet", async () => {
    try {
      await program.methods
        .addDepositWallet(testIdentifier, testDepositWallet)
        .accounts({
          walletManager: walletManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      expect.fail("Expected error but transaction succeeded");
    } catch (error) {
      expect(error.toString()).to.include("DepositMappingAlreadyExists");
    }
  });

  it("Unauthorized user cannot add deposit wallet", async () => {
    try {
      // Request airdrop for the unauthorized user to pay for transaction fees
      const airdropSignature = await program.provider.connection.requestAirdrop(
        unauthorizedUser.publicKey,
        1 * anchor.web3.LAMPORTS_PER_SOL
      );
      await program.provider.connection.confirmTransaction(airdropSignature);

      await program.methods
        .addDepositWallet(testIdentifier2, testDepositWallet)
        .accounts({
          walletManager: walletManagerKeypair.publicKey,
          admin: unauthorizedUser.publicKey,
        })
        .signers([unauthorizedUser])
        .rpc();

      expect.fail("Expected error but transaction succeeded");
    } catch (error) {
      expect(error.toString()).to.include(
        "Unauthorized: Only the current admin can perform this action"
      );
    }
  });

  it("Remove deposit wallet", async () => {
    try {
      await program.methods
        .removeDepositWallet(testIdentifier)
        .accounts({
          walletManager: walletManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      // Fetch the account and verify wallet was removed
      const account = await program.account.walletManager.fetch(
        walletManagerKeypair.publicKey
      );
      expect(account.partnerDepositWallets).to.be.empty;
    } catch (error) {
      console.error("Error:", error);
      throw error;
    }
  });

  it("Cannot remove non-existent deposit wallet", async () => {
    try {
      await program.methods
        .removeDepositWallet(testIdentifier2)
        .accounts({
          walletManager: walletManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      expect.fail("Expected error but transaction succeeded");
    } catch (error) {
      expect(error.toString()).to.include("DepositMappingNotFound");
    }
  });

  it("Add operational wallet", async () => {
    try {
      await program.methods
        .addOperationalWallet(testIdentifier, testOperationalWallet)
        .accounts({
          walletManager: walletManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      // Fetch the account and verify wallet was added
      const account = await program.account.walletManager.fetch(
        walletManagerKeypair.publicKey
      );
      expect(account.partnerOperationalWallets).to.have.lengthOf(1);
      expect(account.partnerOperationalWallets[0].identifier).to.equal(
        testIdentifier
      );
      expect(
        account.partnerOperationalWallets[0].operationalWallet.toString()
      ).to.equal(testOperationalWallet.toString());
    } catch (error) {
      console.error("Error:", error);
      throw error;
    }
  });

  it("Cannot add operational wallet with too long identifier", async () => {
    try {
      await program.methods
        .addOperationalWallet(longIdentifier, testOperationalWallet)
        .accounts({
          walletManager: walletManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      expect.fail("Expected error but transaction succeeded");
    } catch (error) {
      expect(error.toString()).to.include("IdentifierTooLong");
    }
  });

  it("Cannot add duplicate operational wallet", async () => {
    try {
      await program.methods
        .addOperationalWallet(testIdentifier, testOperationalWallet)
        .accounts({
          walletManager: walletManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      expect.fail("Expected error but transaction succeeded");
    } catch (error) {
      expect(error.toString()).to.include("OperationalMappingAlreadyExists");
    }
  });

  it("Remove operational wallet", async () => {
    try {
      await program.methods
        .removeOperationalWallet(testIdentifier)
        .accounts({
          walletManager: walletManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      // Fetch the account and verify wallet was removed
      const account = await program.account.walletManager.fetch(
        walletManagerKeypair.publicKey
      );
      expect(account.partnerOperationalWallets).to.be.empty;
    } catch (error) {
      console.error("Error:", error);
      throw error;
    }
  });

  it("Cannot remove non-existent operational wallet", async () => {
    try {
      await program.methods
        .removeOperationalWallet("non-existent")
        .accounts({
          walletManager: walletManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      expect.fail("Expected error but transaction succeeded");
    } catch (error) {
      expect(error.toString()).to.include("OperationalMappingNotFound");
    }
  });

  it("Update admin", async () => {
    try {
      await program.methods
        .updateAdmin(newAdmin)
        .accounts({
          walletManager: walletManagerKeypair.publicKey,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      // Fetch the account and verify admin was updated
      const account = await program.account.walletManager.fetch(
        walletManagerKeypair.publicKey
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

      await program.methods
        .updateAdmin(fakeNewAdmin)
        .accounts({
          walletManager: walletManagerKeypair.publicKey,
          admin: unauthorizedUser.publicKey,
        })
        .signers([unauthorizedUser])
        .rpc();

      expect.fail("Expected error but transaction succeeded");
    } catch (error) {
      expect(error.message).to.include("UnauthorizedAccess");
    }
  });
});

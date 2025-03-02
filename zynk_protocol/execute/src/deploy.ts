import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  SystemProgram,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { readFileSync, writeFileSync } from "fs";
import BN from "bn.js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { config } from "dotenv";
import path from "path";
import * as crypto from "crypto";

// Load environment variables
config();

// Import the IDL
import { IDL } from "./idl";

// Import wallet and airdrop functions
import { createKeypairFromEnv, ensureAccountHasSOL } from "./airdrop";

// Get current file path in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Helper function to generate a deterministic keypair from setup-wallets.ts
function generateDeterministicKeypair(seed: string): Keypair {
  // Create a deterministic seed using HMAC
  const hmac = crypto.createHmac("sha256", "zynk-protocol-seed");
  hmac.update(seed);
  const seedBytes = Buffer.from(hmac.digest("hex"), "hex");

  // Use the first 32 bytes as the seed for the keypair
  const keypairSeed = seedBytes.slice(0, 32);
  return Keypair.fromSeed(keypairSeed);
}

// Function to get program ID from keypair file
function getProgramId(): PublicKey {
  try {
    const programKeypairPath = resolve(
      __dirname,
      "../../contracts/target/deploy/zynk_protocol-keypair.json"
    );
    const programKeypair = JSON.parse(
      readFileSync(programKeypairPath, "utf-8")
    );
    return new PublicKey(
      Keypair.fromSecretKey(new Uint8Array(programKeypair)).publicKey
    );
  } catch (error) {
    console.error("Error reading program ID from keypair:", error);
    throw error;
  }
}

// Type definitions
interface DeployResult {
  programId: string;
  adminWallet: string;
  zynkOpWallet: string;
  paybackWallet: string;
  configAccount: string;
  partnerOperationalWallet: string;
  partnerDepositWallet: string;
  tokenMint: string;
  zynkOpTokenAccount: string;
  partnerOperationalTokenAccount: string;
}

// Main deployment function
export async function deploy(): Promise<DeployResult> {
  try {
    // Create wallets from private keys in .env file
    console.log("Loading wallets from environment variables...");

    // Create keypairs from .env or use deterministic generation from setup-wallets.ts
    const adminWallet =
      createKeypairFromEnv(process.env.ADMIN_WALLET_PRIVATE_KEY || "[]") ||
      generateDeterministicKeypair("admin-wallet");

    const zynkOpWallet =
      createKeypairFromEnv(process.env.ZYNK_OP_WALLET_PRIVATE_KEY || "[]") ||
      generateDeterministicKeypair("zynk-op-wallet");

    const paybackWallet =
      createKeypairFromEnv(process.env.PAYBACK_WALLET_PRIVATE_KEY || "[]") ||
      generateDeterministicKeypair("payback-wallet");

    const configAccount =
      createKeypairFromEnv(process.env.CONFIG_ACCOUNT_PRIVATE_KEY || "[]") ||
      generateDeterministicKeypair("config-account");

    const partnerOperationalWallet =
      createKeypairFromEnv(
        process.env.PARTNER_OPERATIONAL_WALLET_PRIVATE_KEY || "[]"
      ) || generateDeterministicKeypair("partner-op-wallet");

    const partnerDepositWallet =
      createKeypairFromEnv(
        process.env.PARTNER_DEPOSIT_WALLET_PRIVATE_KEY || "[]"
      ) || generateDeterministicKeypair("partner-deposit-wallet");

    // Log the generated wallet addresses
    console.log("Admin wallet:", adminWallet.publicKey.toString());
    console.log("Zynk operator wallet:", zynkOpWallet.publicKey.toString());
    console.log("Payback wallet:", paybackWallet.publicKey.toString());
    console.log("Config account:", configAccount.publicKey.toString());
    console.log(
      "Partner Operational Wallet:",
      partnerOperationalWallet.publicKey.toString()
    );
    console.log(
      "Partner Deposit Wallet:",
      partnerDepositWallet.publicKey.toString()
    );

    // Initialize provider with admin wallet
    const wallet = new anchor.Wallet(adminWallet);
    const connection = new Connection(
      process.env.RPC_URL || "http://localhost:8899",
      "confirmed"
    );
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);

    const amount = 0.1;
    const formattedAmountToAirdrop = amount * LAMPORTS_PER_SOL;

    // Airdrop SOL to wallets using the imported ensureAccountHasSOL function
    console.log("\nAirdropping SOL to wallets...");
    await ensureAccountHasSOL(
      connection,
      adminWallet.publicKey,
      formattedAmountToAirdrop
    );
    await ensureAccountHasSOL(
      connection,
      zynkOpWallet.publicKey,
      formattedAmountToAirdrop
    );
    await ensureAccountHasSOL(
      connection,
      partnerOperationalWallet.publicKey,
      formattedAmountToAirdrop
    );
    await ensureAccountHasSOL(
      connection,
      partnerDepositWallet.publicKey,
      formattedAmountToAirdrop
    );

    // Get program ID
    const programId = getProgramId();
    console.log("\nProgram ID:", programId.toString());

    // Define the program with proper types
    type ConfigAccount = {
      admin: PublicKey;
      zynkOpWallet: PublicKey;
      paybackWallet: PublicKey;
      paused: boolean;
      currentNonce: BN;
    };

    const program = new Program(IDL as any, programId, provider);

    // Initialize protocol
    console.log("\nInitializing protocol...");
    await program.methods
      .initialize(zynkOpWallet.publicKey, paybackWallet.publicKey)
      .accounts({
        config: configAccount.publicKey,
        admin: adminWallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([configAccount, adminWallet])
      .rpc();

    console.log("Protocol initialized successfully!");

    // Create test token
    console.log("\nCreating test token...");
    const tokenMint = await createMint(
      connection,
      zynkOpWallet,
      zynkOpWallet.publicKey,
      zynkOpWallet.publicKey,
      9
    );
    console.log("Token Mint created:", tokenMint.toString());

    // Create token accounts and mint tokens to the zynkOpWallet
    const zynkOpTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      zynkOpWallet,
      tokenMint,
      zynkOpWallet.publicKey
    );
    console.log(
      "Zynk Operator Token Account:",
      zynkOpTokenAccount.address.toString()
    );

    // Mint tokens to the zynkOpWallet
    await mintTo(
      connection,
      zynkOpWallet,
      tokenMint,
      zynkOpTokenAccount.address,
      zynkOpWallet.publicKey,
      1_000_000_000_000
    );
    console.log("Minted 1,000,000,000,000 tokens to Zynk Operator");

    // Create partner's operational token account
    const partnerOperationalTokenAccount =
      await getOrCreateAssociatedTokenAccount(
        connection,
        zynkOpWallet,
        tokenMint,
        partnerOperationalWallet.publicKey
      );
    console.log(
      "Partner Operational Token Account:",
      partnerOperationalTokenAccount.address.toString()
    );

    // Fetch the config account to confirm it has the correct zynkOpWallet
    const configData = (await program.account.config.fetch(
      configAccount.publicKey
    )) as ConfigAccount;
    console.log("\nConfig Data:");
    console.log("Admin:", configData.admin.toString());
    console.log("Zynk Op Wallet:", configData.zynkOpWallet.toString());
    console.log("Payback Wallet:", configData.paybackWallet.toString());
    console.log("Paused:", configData.paused);
    console.log("Current Nonce:", configData.currentNonce.toString());

    // Check if the zynkOpWallet matches what's in the config
    if (
      configData.zynkOpWallet.toString() !== zynkOpWallet.publicKey.toString()
    ) {
      throw new Error(
        "Error: zynkOpWallet in config doesn't match our wallet!"
      );
    }

    // Create result object
    const deployResult: DeployResult = {
      programId: programId.toString(),
      adminWallet: adminWallet.publicKey.toString(),
      zynkOpWallet: zynkOpWallet.publicKey.toString(),
      paybackWallet: paybackWallet.publicKey.toString(),
      configAccount: configAccount.publicKey.toString(),
      partnerOperationalWallet: partnerOperationalWallet.publicKey.toString(),
      partnerDepositWallet: partnerDepositWallet.publicKey.toString(),
      tokenMint: tokenMint.toString(),
      zynkOpTokenAccount: zynkOpTokenAccount.address.toString(),
      partnerOperationalTokenAccount:
        partnerOperationalTokenAccount.address.toString(),
    };

    // Save deployment result to JSON file
    const deploymentPath = path.resolve(__dirname, "../deployment.json");
    writeFileSync(deploymentPath, JSON.stringify(deployResult, null, 2));
    console.log(`\nDeployment data saved to ${deploymentPath}`);

    return deployResult;
  } catch (error) {
    console.error("Error in deployment:", error);
    throw error;
  }
}

// Run deployment if this file is executed directly
if (import.meta.url === fileURLToPath(process.argv[1])) {
  deploy()
    .then(() => {
      console.log("Deployment completed successfully!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Deployment failed:", error);
      process.exit(1);
    });
}

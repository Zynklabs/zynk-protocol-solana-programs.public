import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import {
  Connection,
  SystemProgram,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { writeFileSync } from "fs";
import BN from "bn.js";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { config } from "dotenv";
import path from "path";
import bs58 from "bs58";

// Load environment variables
config();

// Import the IDL
import { IDL } from "./idl.js";

// Import utility functions
import { createKeypairFromEnv, getProgramId } from "./utils.js";

// Get current file path in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Type definitions
interface DeployResult {
  programId: string;
  adminWallet: string;
  zynkOpWallet: string;
  paybackWallet: string;
  configAccount: string;
}

// Main deployment function for mainnet
export async function deployMainnet(): Promise<DeployResult> {
  try {
    // Create admin wallet from private key in .env file
    console.log("Loading admin wallet from environment variables...");
    const adminWallet = createKeypairFromEnv(
      "ADMIN_WALLET_PRIVATE_KEY",
      "admin-wallet"
    );
    console.log("Admin wallet:", adminWallet.publicKey.toString());

    // Get zynkOpWallet and paybackWallet public keys from environment variables
    // For these wallets, we only need the public keys, not the private keys
    if (!process.env.ZYNK_OP_WALLET_PUBLIC_KEY) {
      throw new Error(
        "ZYNK_OP_WALLET_PUBLIC_KEY is not defined in environment variables"
      );
    }

    if (!process.env.PAYBACK_WALLET_PUBLIC_KEY) {
      throw new Error(
        "PAYBACK_WALLET_PUBLIC_KEY is not defined in environment variables"
      );
    }

    console.log(
      "Attempting to create PublicKey from ZYNK_OP_WALLET_PUBLIC_KEY:",
      process.env.ZYNK_OP_WALLET_PUBLIC_KEY
    );
    const zynkOpWalletPubkey = new PublicKey(
      process.env.ZYNK_OP_WALLET_PUBLIC_KEY
    );

    console.log(
      "Attempting to create PublicKey from PAYBACK_WALLET_PUBLIC_KEY:",
      process.env.PAYBACK_WALLET_PUBLIC_KEY
    );
    const paybackWalletPubkey = new PublicKey(
      process.env.PAYBACK_WALLET_PUBLIC_KEY
    );

    console.log("Zynk operator wallet:", zynkOpWalletPubkey.toString());
    console.log("Payback wallet:", paybackWalletPubkey.toString());

    // Initialize provider with admin wallet
    const wallet = new anchor.Wallet(adminWallet);

    // Get RPC URL from environment or use mainnet default
    const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    console.log(`Using RPC URL: ${rpcUrl}`);

    const connection = new Connection(rpcUrl, "confirmed");
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);

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

    // Find PDA for config account
    const [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      programId
    );
    console.log("Config PDA:", configPda.toString());

    // Check if the config account already exists
    let configData: ConfigAccount | null = null;
    try {
      configData = (await program.account.config.fetch(
        configPda
      )) as ConfigAccount;
      console.log("\nConfig account already exists. Skipping initialization.");
      console.log("Config Data:");
      console.log("Admin:", configData.admin.toString());
      console.log("Zynk Op Wallet:", configData.zynkOpWallet.toString());
      console.log("Payback Wallet:", configData.paybackWallet.toString());
    } catch (error) {
      // Config account doesn't exist, proceed with initialization
      console.log("\nConfig account doesn't exist. Initializing protocol...");
      try {
        await program.methods
          .initialize(zynkOpWalletPubkey, paybackWalletPubkey)
          .accounts({
            config: configPda,
            admin: adminWallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([adminWallet])
          .instruction()
          .then((instruction) => {
            // To properly initialize a PDA, we need to tell Anchor about the seeds and bump
            instruction.keys.find((key) =>
              key.pubkey.equals(configPda)
            )!.isSigner = false;

            // Create and send transaction
            const transaction = new Transaction().add(instruction);
            return provider.sendAndConfirm(transaction, [adminWallet]);
          });

        console.log("Protocol initialized successfully!");

        // Fetch the config account to confirm it has the correct values
        configData = (await program.account.config.fetch(
          configPda
        )) as ConfigAccount;
        console.log("\nConfig Data:");
        console.log("Admin:", configData.admin.toString());
        console.log("Zynk Op Wallet:", configData.zynkOpWallet.toString());
        console.log("Payback Wallet:", configData.paybackWallet.toString());
      } catch (error: any) {
        console.error("Error in initialization:", error);
        throw new Error(`Error in initialization: ${error.message}`);
      }
    }

    // Create result object
    const deployResult: DeployResult = {
      programId: programId.toString(),
      adminWallet: adminWallet.publicKey.toString(),
      zynkOpWallet: zynkOpWalletPubkey.toString(),
      paybackWallet: paybackWalletPubkey.toString(),
      configAccount: configPda.toString(),
    };

    // Save deployment result to JSON file
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const deploymentPath = path.resolve(
      __dirname,
      `../deployment-mainnet-test-${timestamp}.json`
    );
    writeFileSync(deploymentPath, JSON.stringify(deployResult, null, 2));
    console.log(`\nDeployment data saved to ${deploymentPath}`);

    return deployResult;
  } catch (error) {
    console.error("Error in mainnet deployment:", error);
    throw error;
  }
}

// Run deployment if this file is executed directly
if (import.meta && import.meta.url && process.argv && process.argv[1]) {
  const url = new URL(import.meta.url);
  const filePath = fileURLToPath(url);

  if (filePath === process.argv[1]) {
    deployMainnet()
      .then(() => {
        console.log("Mainnet deployment completed successfully!");
        process.exit(0);
      })
      .catch((error) => {
        console.error("Mainnet deployment failed:", error);
        process.exit(1);
      });
  }
}

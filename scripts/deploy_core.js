import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import {
  Connection,
  SystemProgram,
  PublicKey,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { execSync } from "child_process";

// Load environment variables
config();

import { IDL } from "./idls/zynk_core.js";
import { ASSETS } from "./constants.js"

const forEURC = false;
const programKeypairName = "ZynkcJyxiBTs9ePTQzHh7ckDDnwrLjuNVUbisF6hC7K"
const managerKeypairPath = "manager-keypair.json"

export function createKeypairFromEnv(envVar, fallbackLabel) {
  const privateKeyStr = process.env[envVar];

  // If private key is provided, use it
  if (privateKeyStr) {
    try {
      // First try to parse as JSON array
      try {
        const privateKeyArray = JSON.parse(privateKeyStr);
        return Keypair.fromSecretKey(Uint8Array.from(privateKeyArray));
      } catch (jsonError) {
        // If JSON parsing fails, try as base58 encoded string
        try {
          const privateKeyBytes = bs58.decode(privateKeyStr);
          if (envVar.toLowerCase().includes('manager')) {
            writeFileSync(managerKeypairPath, JSON.stringify(Array.from(privateKeyBytes)));
          }
          return Keypair.fromSecretKey(privateKeyBytes);
        } catch (bs58Error) {
          console.log('bs', bs58Error)
          throw new Error(
            "Failed to parse private key in both JSON and base58 formats"
          );
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error parsing private key";

      console.warn(`Error parsing private key from ${envVar}: ${errorMessage}`);
    }
  } else {
    console.warn(
      `No private key found for ${envVar}. Generating a deterministic keypair for ${
        fallbackLabel || envVar
      } instead`
    );
  }
  throw new Error("Failed creating keypair")
}


// Main deployment function for mainnet
export async function deploy() {
  try {
    // Create admin wallet from private key in .env file
    console.log("Loading manager wallet from environment variables...");
    const manager = createKeypairFromEnv(
      "MANAGER_WALLET_PRIVATE_KEY",
      "manager-wallet"
    );
    console.log("Manager wallet:", manager.publicKey.toString());

    if (!process.env.ZYNK_OP_WALLET_PUBLIC_KEY) {
      throw new Error(
        "ZYNK_OP_WALLET_PUBLIC_KEY is not defined in environment variables"
      );
    }

    if (!process.env.ADMIN_MULTISIG_VAULT_PUBLIC_KEY) {
      throw new Error(
        "ADMIN_MULTISIG_VAULT_PUBLIC_KEY is not defined in environment variables"
      );
    }

    if (!process.env.GUARDIAN_MULTISIG_VAULT_PUBLIC_KEY) {
      throw new Error(
        "GUARDIAN_MULTISIG_VAULT_PUBLIC_KEY is not defined in environment variables"
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
      "Attempting to create PublicKey from ADMIN_MULTISIG_VAULT_PUBLIC_KEY:",
      process.env.ADMIN_MULTISIG_VAULT_PUBLIC_KEY
    );
    const adminWalletPubkey = new PublicKey(
      process.env.ADMIN_MULTISIG_VAULT_PUBLIC_KEY
    );

    console.log(
      "Attempting to create PublicKey from GUARDIAN_MULTISIG_VAULT_PUBLIC_KEY:",
      process.env.GUARDIAN_MULTISIG_VAULT_PUBLIC_KEY
    );
    const guardianWalletPubkey = new PublicKey(
      process.env.GUARDIAN_MULTISIG_VAULT_PUBLIC_KEY
    );

    console.log("Zynk operator wallet:", zynkOpWalletPubkey.toString());
    console.log("Admin wallet:", adminWalletPubkey.toString());
    console.log("Guardian wallet:", guardianWalletPubkey.toString());
    console.log("Manager wallet:", manager.publicKey.toString());
    
    // Initialize provider with admin wallet
    const wallet = new anchor.Wallet(manager);

    // Get RPC URL from environment or use mainnet default
    const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    console.log(`Using RPC URL: ${rpcUrl}`);

    const connection = new Connection(rpcUrl, "confirmed");
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);

    // Deploy the program
    let programId;
    console.log("\nDeploying program to blockchain...");

    // Check if the program binary exists
    const programPath = "target/deploy/zynk_core.so"

    // Load the program binary
    const programData = readFileSync(programPath);
    console.log(`Program size: ${programData.length} bytes`);

    // Create a new keypair for the program or use existing one
    let programKeypair;
    const programKeypairPath = `target/deploy/${ programKeypairName?.length ? programKeypairName : "zynk_core-keypair" }.json`

    console.log("Using existing program keypair");
    const programKeypairData = JSON.parse(
        readFileSync(programKeypairPath, "utf-8")
    );
    programKeypair = Keypair.fromSecretKey(
        new Uint8Array(programKeypairData)
    );

    programId = programKeypair.publicKey;
    console.log("Program ID:", programId.toString());

    
    console.log("Using transient manager keypair");
    const _ = JSON.parse(
        readFileSync(managerKeypairPath, "utf-8")
    );
    
    // try {
    //   console.log("Deploying program...");
    //   // For simplicity, we'll use Solana CLI to deploy
    //   // This is more reliable than using BpfLoader in code
    //   try {
    //     const deployCommand = `solana program deploy --keypair ${managerKeypairPath} --program-id ${programKeypairPath} ${programPath} --url ${rpcUrl}`;
    //     console.log(`Running: ${deployCommand}`);

    //     const deployOutput = execSync(deployCommand, { encoding: "utf8" });
    //     console.log(deployOutput);
    //   } catch (error) {
    //     console.error("Error deploying program:", error);
    //     throw new Error("Failed to deploy program using Solana CLI.");
    //   }
    // } catch (error) {
    //   console.error("Error checking program account:", error);
    //   throw error;
    // }

    const program = new Program(IDL, programId, provider);

    // Find PDA for config account
    const [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      programId
    );
    console.log("Config PDA:", configPda.toString());
    
    let configData;
    try {
      configData = await program.account.config.fetch(configPda);
      console.log("\nConfig account already exists. Skipping initialization.");
    } catch (error) {
      
      const whitelistedTokens = Object.entries(ASSETS).filter(([k, _]) => forEURC ? k === "EURC" : k != "EURC").map(([_, v]) => new PublicKey(v))
      console.log("whitelistedTokens", whitelistedTokens)
      
      console.log("\nConfig account doesn't exist. Initializing protocol...");
      try {
          await program.methods
              .initialize(zynkOpWalletPubkey, adminWalletPubkey, guardianWalletPubkey, whitelistedTokens)
              .accounts({
                config: configPda,
                manager: manager.publicKey,
                systemProgram: SystemProgram.programId,
              })
              .signers([manager])
              .instruction()
              .then((instruction) => {
                instruction.keys.find((key) =>
                    key.pubkey.equals(configPda)
                ).isSigner = false;
  
                // Create and send transaction
                const transaction = new Transaction().add(instruction);
                return provider.sendAndConfirm(transaction, [manager]);
              });
  
          console.log("Protocol initialized successfully!");
  
          // Fetch the config account to confirm it has the correct values
          configData = await program.account.config.fetch(configPda);
      } catch (error) {
          console.error("Error in initialization:", error);
          throw new Error(`Error in initialization: ${error.message}`);
      }
    } 

    console.log("Config Data:");
    
    console.table({
      ZOW: configData.zynkOpWallet.toString(),
      Admin: configData.admin.toString(),
      Manager: configData.manager.toString(),
      Guardian: configData.guardian.toString(),
    })
    

    // Create result object
    const deployResult = {
      programId: programId.toString(),
      adminWallet: adminWallet.publicKey.toString(),
      zynkOpWallet: zynkOpWalletPubkey.toString(),
      managerWallet: managerWalletPubkey.toString(),
      guardianWallet: guardianWalletPubkey.toString(),
      configAccount: configPda.toString(),
    };

    // Save deployment result to JSON file
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(`deployment-test-${timestamp}.json`, JSON.stringify(deployResult, null, 2));

    unlinkSync(managerKeypairPath)   

    return deployResult;
  } catch (error) {
    console.error("Error in deployment:", error);
    throw error;
  }
}

// Run deployment if this file is executed directly
if (import.meta && import.meta.url && process.argv && process.argv[1]) {
  const url = new URL(import.meta.url);
  const filePath = fileURLToPath(url);

  if (filePath === process.argv[1]) {
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
}

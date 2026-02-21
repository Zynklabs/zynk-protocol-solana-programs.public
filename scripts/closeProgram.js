import * as anchor from "@project-serum/anchor";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { execSync } from "child_process";
import { bs58 } from "@project-serum/anchor/dist/cjs/utils/bytes/index.js";
import { Connection, Keypair } from "@solana/web3.js";

config();

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

async function closeProgram() {

    const managerWallet = createKeypairFromEnv(
        "MANAGER_WALLET_PRIVATE_KEY",
        "manager-wallet"
    );
    console.log("Manager wallet:", managerWallet.publicKey.toString());

    const wallet = new anchor.Wallet(managerWallet);

    // Get RPC URL from environment or use mainnet default
    const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    console.log(`Using RPC URL: ${rpcUrl}`);

    const connection = new Connection(rpcUrl, "confirmed");
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);

    const programId = process.env.PROGRAM_ID
    console.log("Program ID:", programId.toString());

    console.log("Using transient manager keypair");
    const _ = JSON.parse(
        readFileSync(managerKeypairPath, "utf-8")
    );

    try {
      console.log("Closing program...");
      // For simplicity, we'll use Solana CLI to deploy
      // This is more reliable than using BpfLoader in code
      try {
        const closeCommand = `solana program close ${programId} --keypair ${managerKeypairPath} --bypass-warning`
        //  --program-id ${programKeypairPath} contracts/target/deploy/zynk_protocol.so --url ${rpcUrl}`;
        console.log(`Running: ${closeCommand}`);

        const closeOutput = execSync(closeCommand, { encoding: "utf8" });
        console.log(closeOutput);
      } catch (error) {
        console.error("Error closing program:", error);
        throw new Error("Failed to close program using Solana CLI.");
      }
    } catch (error) {
      console.error("Error checking program account:", error);
      throw error;
    }
    
    unlinkSync(managerKeypairPath)   
}

if (import.meta && import.meta.url && process.argv && process.argv[1]) {
  const url = new URL(import.meta.url);
  const filePath = fileURLToPath(url);

  if (filePath === process.argv[1]) {
    closeProgram()
      .then(() => {
        console.log("Program closed successfully!");
        process.exit(0);
      })
      .catch((error) => {
        console.error("Program closing failed:", error);
        process.exit(1);
      });
  }
}
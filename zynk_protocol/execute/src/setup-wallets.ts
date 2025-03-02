/**
 * This script generates deterministic keypairs for all wallets needed in the Zynk protocol
 * and writes them to the .env file. It will only update values that are not already set.
 *
 * Usage:
 * npx tsx src/setup-wallets.ts
 */
import * as fs from "fs";
import { Keypair } from "@solana/web3.js";
import * as crypto from "crypto";
import * as path from "path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";

// Get current file path in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to .env file
const envPath = path.resolve(__dirname, "../.env");

// Helper function to generate deterministic keypair
function generateDeterministicKeypair(seed: string): Keypair {
  // Create a deterministic seed using HMAC
  const hmac = crypto.createHmac("sha256", "zynk-protocol-seed");
  hmac.update(seed);
  const seedBytes = Buffer.from(hmac.digest("hex"), "hex");

  // Use the first 32 bytes as the seed for the keypair
  const keypairSeed = seedBytes.slice(0, 32);
  return Keypair.fromSeed(keypairSeed);
}

// Function to read existing .env file or create a new one
function readEnvFile(): Record<string, string> {
  try {
    if (fs.existsSync(envPath)) {
      // Load existing .env file
      dotenv.config({ path: envPath });
      return process.env as Record<string, string>;
    }
  } catch (error) {
    console.warn("Error reading .env file:", error);
  }

  return {};
}

// Function to write updated env variables to .env file
function writeEnvFile(envVars: Record<string, string>): void {
  // List of variables we want to include in the .env file
  const envVarKeys = [
    "ADMIN_WALLET_PRIVATE_KEY",
    "ZYNK_OP_WALLET_PRIVATE_KEY",
    "PAYBACK_WALLET_PRIVATE_KEY",
    "CONFIG_ACCOUNT_PRIVATE_KEY",
    "PARTNER_OPERATIONAL_WALLET_PRIVATE_KEY",
    "PARTNER_DEPOSIT_WALLET_PRIVATE_KEY",
    "RPC_URL",
  ];

  let envContent = "";

  // Add our wallet keys
  envVarKeys.forEach((key) => {
    if (envVars[key]) {
      envContent += `${key}=${envVars[key]}\n`;
    }
  });

  // Ensure RPC_URL is present
  if (!envVars["RPC_URL"]) {
    envContent += `RPC_URL=http://localhost:8899\n`;
  }

  // Write to .env file
  fs.writeFileSync(envPath, envContent);
  console.log(`Updated .env file at ${envPath}`);
}

// Main function to set up wallets
async function setupWallets(): Promise<void> {
  console.log("Setting up deterministic wallets for Zynk protocol...");

  // Read existing .env file
  const envVars = readEnvFile();
  let updated = false;

  // Wallet configuration with friendly names and environment variable names
  const wallets = [
    {
      name: "Admin Wallet",
      env: "ADMIN_WALLET_PRIVATE_KEY",
      seed: "admin-wallet",
    },
    {
      name: "Zynk Operator Wallet",
      env: "ZYNK_OP_WALLET_PRIVATE_KEY",
      seed: "zynk-op-wallet",
    },
    {
      name: "Payback Wallet",
      env: "PAYBACK_WALLET_PRIVATE_KEY",
      seed: "payback-wallet",
    },
    {
      name: "Config Account",
      env: "CONFIG_ACCOUNT_PRIVATE_KEY",
      seed: "config-account",
    },
    {
      name: "Partner Operational Wallet",
      env: "PARTNER_OPERATIONAL_WALLET_PRIVATE_KEY",
      seed: "partner-op-wallet",
    },
    {
      name: "Partner Deposit Wallet",
      env: "PARTNER_DEPOSIT_WALLET_PRIVATE_KEY",
      seed: "partner-deposit-wallet",
    },
  ];

  // Generate keypairs for each wallet
  wallets.forEach((wallet) => {
    // Only generate if not already set
    if (!envVars[wallet.env] || envVars[wallet.env] === "[]") {
      const keypair = generateDeterministicKeypair(wallet.seed);

      // Convert secret key to array of integers
      const secretKeyArray = Array.from(keypair.secretKey);

      // Update env variable
      envVars[wallet.env] = JSON.stringify(secretKeyArray);

      console.log(`Generated ${wallet.name} (${keypair.publicKey.toString()})`);
      updated = true;
    } else {
      console.log(`Skipping ${wallet.name} (already exists in .env)`);
    }
  });

  // Write updated env variables to .env file if changes were made
  if (updated) {
    writeEnvFile(envVars);
    console.log("Wallet setup complete!");
  } else {
    console.log("No changes needed. All wallets already set up.");
  }
}

// Run the setup
setupWallets().catch((error) => {
  console.error("Error setting up wallets:", error);
  process.exit(1);
});

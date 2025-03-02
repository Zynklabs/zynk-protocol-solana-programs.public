/**
 * This script loads a master wallet from your local system and uses it
 * to fund all wallets defined in the .env file with SOL.
 *
 * Usage:
 * npm run airdrop -- --amount 1 --wallet ~/.config/solana/id.json
 *
 * Options:
 *   --amount <number>   Amount of SOL to airdrop to each wallet (default: 0.1)
 *   --wallet <path>     Path to your master wallet keypair JSON file
 *   --rpc <url>         Solana RPC URL (defaults to value in .env or localhost)
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { homedir } from "os";

// Get current file path in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to .env file
const envPath = path.resolve(__dirname, "../.env");

// Parse command line arguments
const args = process.argv.slice(2);
let masterWalletPath = "";
let amountToAirdrop = 0.1; // Default 0.1 SOL
let rpcUrl = "";

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === "--wallet" && i + 1 < args.length) {
    masterWalletPath = args[++i];
    // Replace ~ with home directory if present
    if (masterWalletPath.startsWith("~")) {
      masterWalletPath = path.join(homedir(), masterWalletPath.slice(1));
    }
  } else if (arg === "--amount" && i + 1 < args.length) {
    amountToAirdrop = parseFloat(args[++i]);
    if (isNaN(amountToAirdrop)) {
      console.error("Invalid amount specified");
      process.exit(1);
    }
  } else if (arg === "--rpc" && i + 1 < args.length) {
    rpcUrl = args[++i];
  }
}

// Load master wallet
function loadMasterWallet(): Keypair {
  if (!masterWalletPath) {
    console.error("No master wallet specified. Use --wallet flag.");
    console.error(
      "Example: npm run airdrop -- --wallet ~/.config/solana/id.json --amount 1"
    );
    process.exit(1);
  }

  try {
    // Read the wallet file
    const walletData = fs.readFileSync(masterWalletPath, { encoding: "utf-8" });
    const secretKey = Uint8Array.from(JSON.parse(walletData));
    return Keypair.fromSecretKey(secretKey);
  } catch (error) {
    console.error(
      `Error loading master wallet from ${masterWalletPath}:`,
      error
    );
    process.exit(1);
  }
}

// Function to create a keypair from a private key array in .env
function createKeypairFromEnv(privateKeyStr: string): Keypair | null {
  if (!privateKeyStr || privateKeyStr === "[]") {
    return null;
  }

  try {
    const privateKeyArray = JSON.parse(privateKeyStr);
    return Keypair.fromSecretKey(Uint8Array.from(privateKeyArray));
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Unknown error parsing private key";

    console.warn(`Error parsing private key: ${errorMessage}`);
    return null;
  }
}

// Function to airdrops SOL
async function airdropSol(
  connection: Connection,
  from: Keypair,
  to: PublicKey,
  amountInSol: number
): Promise<string> {
  const amountInLamports = amountInSol * LAMPORTS_PER_SOL;

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: amountInLamports,
    })
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [
    from,
  ]);

  return signature;
}

// Main function
async function main() {
  // Load .env file
  dotenv.config({ path: envPath });

  // Load master wallet
  const masterWallet = loadMasterWallet();
  console.log(`Master wallet loaded: ${masterWallet.publicKey.toString()}`);

  // Setup connection
  const connectionUrl =
    rpcUrl || process.env.RPC_URL || "http://localhost:8899";
  const connection = new Connection(connectionUrl, "confirmed");

  console.log(`Connected to Solana RPC at ${connectionUrl}`);

  // Check master wallet balance
  const balance = await connection.getBalance(masterWallet.publicKey);
  const balanceInSol = balance / LAMPORTS_PER_SOL;
  console.log(`Master wallet balance: ${balanceInSol} SOL`);

  // Wallet configuration with friendly names and environment variable names
  const wallets = [
    { name: "Admin Wallet", env: "ADMIN_WALLET_PRIVATE_KEY" },
    { name: "Zynk Operator Wallet", env: "ZYNK_OP_WALLET_PRIVATE_KEY" },
    { name: "Payback Wallet", env: "PAYBACK_WALLET_PRIVATE_KEY" },
    { name: "Config Account", env: "CONFIG_ACCOUNT_PRIVATE_KEY" },
    {
      name: "Partner Operational Wallet",
      env: "PARTNER_OPERATIONAL_WALLET_PRIVATE_KEY",
    },
    {
      name: "Partner Deposit Wallet",
      env: "PARTNER_DEPOSIT_WALLET_PRIVATE_KEY",
    },
  ];

  // Total SOL needed
  const totalNeeded = wallets.length * amountToAirdrop;

  if (balanceInSol < totalNeeded) {
    console.error(
      `Insufficient balance in master wallet. Needed: ${totalNeeded} SOL, Available: ${balanceInSol} SOL`
    );
    process.exit(1);
  }

  console.log(`\nAirdropping ${amountToAirdrop} SOL to each wallet...`);

  // Airdrop to each wallet
  for (const wallet of wallets) {
    const walletPrivateKey = process.env[wallet.env];
    if (!walletPrivateKey) {
      console.warn(`No private key found for ${wallet.name}. Skipping...`);
      continue;
    }

    const keypair = createKeypairFromEnv(walletPrivateKey);
    if (!keypair) {
      console.warn(`Could not create keypair for ${wallet.name}. Skipping...`);
      continue;
    }

    try {
      const signature = await airdropSol(
        connection,
        masterWallet,
        keypair.publicKey,
        amountToAirdrop
      );

      console.log(
        `✅ Sent ${amountToAirdrop} SOL to ${
          wallet.name
        }: ${keypair.publicKey.toString()}`
      );
      console.log(`   Transaction: ${signature}`);
    } catch (error) {
      console.error(`❌ Failed to send SOL to ${wallet.name}:`, error);
    }
  }

  // Get updated balance
  const newBalance = await connection.getBalance(masterWallet.publicKey);
  const newBalanceInSol = newBalance / LAMPORTS_PER_SOL;
  console.log(
    `\nAirdrop complete! Master wallet remaining balance: ${newBalanceInSol} SOL`
  );
}

main().catch((error) => {
  console.error("Error in airdrop script:", error);
  process.exit(1);
});

import {
  Keypair,
  PublicKey,
  Connection,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as crypto from "crypto";
import { resolve } from "path";
import { readFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

// Get current file path in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Creates a keypair from a private key stored in environment variables.
 * Falls back to deterministic keypair generation if the private key is not found or invalid.
 *
 * @param envVar - The name of the environment variable containing the private key
 * @param fallbackLabel - Optional label for fallback keypair generation
 * @returns A Solana keypair
 */
export function createKeypairFromEnv(
  envVar: string,
  fallbackLabel?: string
): Keypair {
  const privateKeyStr = process.env[envVar];

  // If private key is provided, use it
  if (privateKeyStr) {
    try {
      const privateKeyArray = JSON.parse(privateKeyStr);
      return Keypair.fromSecretKey(Uint8Array.from(privateKeyArray));
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error parsing private key";

      console.warn(`Error parsing private key from ${envVar}: ${errorMessage}`);
      console.warn(
        `Generating a deterministic keypair for ${
          fallbackLabel || envVar
        } instead`
      );
    }
  } else {
    console.warn(
      `No private key found for ${envVar}. Generating a deterministic keypair for ${
        fallbackLabel || envVar
      } instead`
    );
  }

  // Fallback to generating a deterministic keypair
  return generateDeterministicKeypair(fallbackLabel || envVar);
}

/**
 * Generates a deterministic keypair based on a seed string.
 * This ensures that the same keypair is generated for the same seed across different runs.
 *
 * @param seed - Seed string to generate keypair from
 * @returns A Solana keypair
 */
export function generateDeterministicKeypair(seed: string): Keypair {
  // Create a deterministic seed using HMAC
  const hmac = crypto.createHmac("sha256", "zynk-protocol-seed");
  hmac.update(seed);
  const seedBytes = Buffer.from(hmac.digest("hex"), "hex");

  // Use the first 32 bytes as the seed for the keypair
  const keypairSeed = seedBytes.slice(0, 32);
  return Keypair.fromSeed(keypairSeed);
}

/**
 * Gets keypair JSON for storage or display
 *
 * @param keypair - Solana keypair to convert to JSON
 * @returns JSON string representation of the keypair's secret key
 */
export function getKeypairJson(keypair: Keypair): string {
  return JSON.stringify(Array.from(keypair.secretKey));
}

// Helper function to airdrop SOL
export async function airdropSol(
  connection: Connection,
  address: PublicKey,
  amount: number
): Promise<void> {
  try {
    const signature = await connection.requestAirdrop(
      address,
      amount * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(signature, "confirmed");
    console.log(`Airdropped ${amount} SOL to ${address.toString()}`);
    console.log(
      `New balance: ${(
        (await connection.getBalance(address)) / LAMPORTS_PER_SOL
      ).toFixed(6)} SOL`
    );
  } catch (error) {
    console.error("Error airdropping SOL:", error);
    throw error;
  }
}

// Helper function to ensure an account has enough SOL
export async function ensureAccountHasSOL(
  connection: Connection,
  address: PublicKey,
  minBalanceInLamports: number
): Promise<void> {
  const balance = await connection.getBalance(address);

  if (balance < minBalanceInLamports) {
    console.log(
      `Current balance too low. Airdropping ${
        minBalanceInLamports / LAMPORTS_PER_SOL
      } SOL to ${address.toString()}`
    );
    await airdropSol(
      connection,
      address,
      minBalanceInLamports / LAMPORTS_PER_SOL
    );

    // Wait for confirmation
    let newBalance = await connection.getBalance(address);
    let attempts = 0;
    while (newBalance < minBalanceInLamports && attempts < 10) {
      console.log("Waiting for airdrop confirmation...");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      newBalance = await connection.getBalance(address);
      attempts++;
    }

    if (newBalance < minBalanceInLamports) {
      throw new Error(`Failed to airdrop SOL to ${address.toString()}`);
    }

    console.log(
      `New balance: ${(newBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`
    );
  }
}

// Function to get program ID from keypair file
export function getProgramId(): PublicKey {
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

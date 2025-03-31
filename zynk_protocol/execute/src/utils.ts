import {
  Keypair,
  PublicKey,
  Connection,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as crypto from "crypto";
import { resolve } from "path";
import { readFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";
import bs58 from "bs58";

// Get current file path in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Creates a keypair from a private key stored in environment variables.
 * Supports both base58 encoded strings and JSON array formats.
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
      // First try to parse as JSON array
      try {
        const privateKeyArray = JSON.parse(privateKeyStr);
        return Keypair.fromSecretKey(Uint8Array.from(privateKeyArray));
      } catch (jsonError) {
        // If JSON parsing fails, try as base58 encoded string
        try {
          const privateKeyBytes = bs58.decode(privateKeyStr);
          return Keypair.fromSecretKey(privateKeyBytes);
        } catch (bs58Error) {
          throw new Error(
            "Failed to parse private key in both JSON and base58 formats"
          );
        }
      }
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

// Function to airdrop SOL from one wallet to another
export async function transferSol(
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

// Function to get program ID from keypair file or environment variable
export function getProgramId(): PublicKey {
  // First try to get program ID from environment variable
  if (process.env.PROGRAM_ID) {
    try {
      return new PublicKey(process.env.PROGRAM_ID);
    } catch (error) {
      console.warn("Invalid PROGRAM_ID in environment variables, falling back to keypair file.");
    }
  }

  // Fall back to reading from keypair file
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

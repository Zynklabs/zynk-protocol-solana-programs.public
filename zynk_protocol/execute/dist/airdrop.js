/**
 * This script loads a master wallet from your local system and uses it
 * to fund all wallets defined in the .env file with SOL.
 *
 * Usage:
 * npm run airdrop -- --amount 1 --wallet ~/.config/solana/id.json
 *
 * Options:
 *   --amount <number>   Amount of SOL to airdrop to each wallet (default: 0.2)
 *   --wallet <path>     Path to your master wallet keypair JSON file
 *   --rpc <url>         Solana RPC URL (defaults to value in .env or localhost)
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction, } from "@solana/web3.js";
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
// Minimum balance threshold in SOL
const MIN_BALANCE_THRESHOLD = 0.1;
// Only parse command line arguments when this file is run directly
let masterWalletPath = "";
let amountToAirdrop = 0.2; // Default 0.2 SOL
let rpcUrl = "";
// Check if this file is being run directly
const isRunningDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (isRunningDirectly) {
    // Parse command line arguments
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--wallet" && i + 1 < args.length) {
            masterWalletPath = args[++i];
            // Replace ~ with home directory if present
            if (masterWalletPath.startsWith("~")) {
                masterWalletPath = path.join(homedir(), masterWalletPath.slice(1));
            }
        }
        else if (arg === "--amount" && i + 1 < args.length) {
            amountToAirdrop = parseFloat(args[++i]);
            if (isNaN(amountToAirdrop)) {
                console.error("Invalid amount specified");
                process.exit(1);
            }
        }
        else if (arg === "--rpc" && i + 1 < args.length) {
            rpcUrl = args[++i];
        }
    }
}
// Load master wallet
function loadMasterWallet(walletPath) {
    const effectivePath = walletPath || masterWalletPath;
    if (!effectivePath && isRunningDirectly) {
        console.error("No master wallet specified. Use --wallet flag.");
        console.error("Example: npm run airdrop -- --wallet ~/.config/solana/id.json --amount 1");
        process.exit(1);
    }
    // If no path is provided and we're imported, try to use default
    if (!effectivePath && !isRunningDirectly) {
        const defaultPath = path.join(homedir(), ".config", "solana", "id.json");
        if (fs.existsSync(defaultPath)) {
            return loadWalletFromPath(defaultPath);
        }
        else {
            throw new Error("No master wallet path provided and default not found");
        }
    }
    return loadWalletFromPath(effectivePath);
}
// Helper to load wallet from a file path
function loadWalletFromPath(walletPath) {
    try {
        // Read the wallet file
        const walletData = fs.readFileSync(walletPath, { encoding: "utf-8" });
        const secretKey = Uint8Array.from(JSON.parse(walletData));
        return Keypair.fromSecretKey(secretKey);
    }
    catch (error) {
        console.error(`Error loading wallet from ${walletPath}:`, error);
        throw error;
    }
}
// Function to create a keypair from a private key array in .env
export function createKeypairFromEnv(privateKeyStr) {
    if (!privateKeyStr || privateKeyStr === "[]") {
        return null;
    }
    try {
        const privateKeyArray = JSON.parse(privateKeyStr);
        return Keypair.fromSecretKey(Uint8Array.from(privateKeyArray));
    }
    catch (error) {
        const errorMessage = error instanceof Error
            ? error.message
            : "Unknown error parsing private key";
        console.warn(`Error parsing private key: ${errorMessage}`);
        return null;
    }
}
// Function to airdrops SOL
export async function airdropSol(connection, from, to, amountInSol) {
    const amountInLamports = amountInSol * LAMPORTS_PER_SOL;
    const transaction = new Transaction().add(SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: to,
        lamports: amountInLamports,
    }));
    const signature = await sendAndConfirmTransaction(connection, transaction, [
        from,
    ]);
    return signature;
}
// Helper function to airdrop SOL from RPC node
export async function requestAirdropSol(connection, address, amount) {
    try {
        const signature = await connection.requestAirdrop(address, amount * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(signature, "confirmed");
        console.log(`Airdropped ${amount} SOL to ${address.toString()}`);
        console.log(`New balance: ${((await connection.getBalance(address)) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    }
    catch (error) {
        console.error("Error airdropping SOL:", error);
        throw error;
    }
}
// Helper function to ensure an account has enough SOL
export async function ensureAccountHasSOL(connection, address, minBalanceInLamports) {
    const balance = await connection.getBalance(address);
    if (balance < minBalanceInLamports) {
        console.table([
            {
                Action: "Airdropping",
                Amount: `${(minBalanceInLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
                Address: address.toString(),
                CurrentBalance: `${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
                MinimumRequired: `${(minBalanceInLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
            },
        ]);
        try {
            // First try to use master wallet if available
            try {
                const defaultWalletPath = path.join(homedir(), ".config", "solana", "id.json");
                const masterWallet = loadWalletFromPath(defaultWalletPath);
                console.table([
                    {
                        Action: "Using Master Wallet",
                        MasterWallet: masterWallet.publicKey.toString(),
                    },
                ]);
                const signature = await airdropSol(connection, masterWallet, address, minBalanceInLamports / LAMPORTS_PER_SOL);
                console.table([
                    {
                        Status: "Transfer Successful",
                        Signature: signature,
                    },
                ]);
            }
            catch (masterWalletError) {
                // Fall back to RPC airdrop if master wallet not available
                console.table([
                    {
                        Status: "Master Wallet Not Available",
                        Action: "Falling back to RPC airdrop",
                    },
                ]);
                await requestAirdropSol(connection, address, minBalanceInLamports / LAMPORTS_PER_SOL);
            }
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
            console.table([
                {
                    Status: "Airdrop Complete",
                    Address: address.toString(),
                    NewBalance: `${(newBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
                },
            ]);
        }
        catch (error) {
            console.error("Error ensuring account has SOL:", error);
            console.table([
                {
                    Status: "Error",
                    Action: "Continuing with current balance",
                    Address: address.toString(),
                    Balance: `${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
                    Warning: "This may cause transactions to fail if the balance is too low",
                },
            ]);
        }
    }
    else {
        console.table([
            {
                Status: "Balance Sufficient",
                Address: address.toString(),
                Balance: `${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
                MinimumRequired: `${(minBalanceInLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
            },
        ]);
    }
}
// Function to check wallet balance
async function getWalletBalance(connection, publicKey) {
    const balance = await connection.getBalance(publicKey);
    return balance / LAMPORTS_PER_SOL;
}
// Main function
async function main() {
    // Load .env file
    dotenv.config({ path: envPath });
    // Load master wallet
    const masterWallet = loadMasterWallet();
    console.log(`Master wallet loaded: ${masterWallet.publicKey.toString()}`);
    // Setup connection
    const connectionUrl = rpcUrl || process.env.RPC_URL || "http://localhost:8899";
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
    let walletsNeedingFunds = 0;
    let totalSolNeeded = 0;
    // First check how many wallets need funds
    console.log(`\nChecking wallet balances...`);
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
        // Check current wallet balance
        const walletBalance = await getWalletBalance(connection, keypair.publicKey);
        console.log(`${wallet.name}: ${walletBalance.toFixed(6)} SOL`);
        if (walletBalance < MIN_BALANCE_THRESHOLD) {
            walletsNeedingFunds++;
            totalSolNeeded += amountToAirdrop;
        }
    }
    if (walletsNeedingFunds === 0) {
        console.log(`\nAll wallets have at least ${MIN_BALANCE_THRESHOLD} SOL. No airdrops needed.`);
        return;
    }
    console.log(`\n${walletsNeedingFunds} wallets need funds. Total SOL required: ${totalSolNeeded}`);
    // Check if master wallet has enough funds
    if (balanceInSol < totalSolNeeded) {
        console.error(`Insufficient balance in master wallet. Needed: ${totalSolNeeded} SOL, Available: ${balanceInSol} SOL`);
        process.exit(1);
    }
    console.log(`\nAirdropping ${amountToAirdrop} SOL to each wallet with balance below ${MIN_BALANCE_THRESHOLD} SOL...`);
    // Airdrop to each wallet
    for (const wallet of wallets) {
        const walletPrivateKey = process.env[wallet.env];
        if (!walletPrivateKey) {
            continue; // Already logged warnings during balance check
        }
        const keypair = createKeypairFromEnv(walletPrivateKey);
        if (!keypair) {
            continue; // Already logged warnings during balance check
        }
        // Check current wallet balance again
        const walletBalance = await getWalletBalance(connection, keypair.publicKey);
        // Only airdrop if balance is below threshold
        if (walletBalance < MIN_BALANCE_THRESHOLD) {
            try {
                const signature = await airdropSol(connection, masterWallet, keypair.publicKey, amountToAirdrop);
                console.log(`✅ Sent ${amountToAirdrop} SOL to ${wallet.name}: ${keypair.publicKey.toString()}`);
                console.log(`   Transaction: ${signature}`);
            }
            catch (error) {
                console.error(`❌ Failed to send SOL to ${wallet.name}:`, error);
            }
        }
        else {
            console.log(`ℹ️ Skipped ${wallet.name}: already has ${walletBalance.toFixed(6)} SOL (above ${MIN_BALANCE_THRESHOLD} threshold)`);
        }
    }
    // Get updated balance
    const newBalance = await connection.getBalance(masterWallet.publicKey);
    const newBalanceInSol = newBalance / LAMPORTS_PER_SOL;
    console.log(`\nAirdrop complete! Master wallet remaining balance: ${newBalanceInSol} SOL`);
}
if (isRunningDirectly) {
    main().catch((error) => {
        console.error("Error in airdrop script:", error);
        process.exit(1);
    });
}

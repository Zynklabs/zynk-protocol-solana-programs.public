import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { Connection, LAMPORTS_PER_SOL, SystemProgram, } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, } from "@solana/spl-token";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { config } from "dotenv";
import path from "path";
// Load environment variables
config();
// Import the IDL
import { IDL } from "./idl";
// Import utility functions
import { createKeypairFromEnv, getProgramId } from "./utils";
import { ensureAccountHasSOL } from "./airdrop";
// Get current file path in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Main deployment function
export async function deploy() {
    try {
        // Create wallets from private keys in .env file
        console.log("Loading wallets from environment variables...");
        // Create keypairs from .env or use deterministic generation from setup-wallets.ts
        const adminWallet = createKeypairFromEnv("ADMIN_WALLET_PRIVATE_KEY", "admin-wallet");
        const zynkOpWallet = createKeypairFromEnv("ZYNK_OP_WALLET_PRIVATE_KEY", "zynk-op-wallet");
        const paybackWallet = createKeypairFromEnv("PAYBACK_WALLET_PRIVATE_KEY", "payback-wallet");
        const configAccount = createKeypairFromEnv("CONFIG_ACCOUNT_PRIVATE_KEY", "config-account");
        const partnerOperationalWallet = createKeypairFromEnv("PARTNER_OPERATIONAL_WALLET_PRIVATE_KEY", "partner-op-wallet");
        const partnerDepositWallet = createKeypairFromEnv("PARTNER_DEPOSIT_WALLET_PRIVATE_KEY", "partner-deposit-wallet");
        // Display all wallet information in a table
        console.table([
            { Name: "Admin wallet", Address: adminWallet.publicKey.toString() },
            { Name: "Zynk operator wallet", Address: zynkOpWallet.publicKey.toString() },
            { Name: "Payback wallet", Address: paybackWallet.publicKey.toString() },
            { Name: "Config account", Address: configAccount.publicKey.toString() },
            { Name: "Partner Operational Wallet", Address: partnerOperationalWallet.publicKey.toString() },
            { Name: "Partner Deposit Wallet", Address: partnerDepositWallet.publicKey.toString() }
        ]);
        // Initialize provider with admin wallet
        const wallet = new anchor.Wallet(adminWallet);
        const connection = new Connection(process.env.RPC_URL || "http://localhost:8899", "confirmed");
        const provider = new anchor.AnchorProvider(connection, wallet, {
            commitment: "confirmed",
        });
        anchor.setProvider(provider);
        const amount = 0.1;
        const formattedAmountToAirdrop = amount * LAMPORTS_PER_SOL;
        // Airdrop SOL to wallets using the imported ensureAccountHasSOL function
        console.log("\nAirdropping SOL to wallets...");
        await ensureAccountHasSOL(connection, adminWallet.publicKey, formattedAmountToAirdrop);
        await ensureAccountHasSOL(connection, zynkOpWallet.publicKey, formattedAmountToAirdrop);
        await ensureAccountHasSOL(connection, partnerOperationalWallet.publicKey, formattedAmountToAirdrop);
        await ensureAccountHasSOL(connection, partnerDepositWallet.publicKey, formattedAmountToAirdrop);
        // Get program ID
        const programId = getProgramId();
        console.log("\nProgram ID:", programId.toString());
        const program = new Program(IDL, programId, provider);
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
        const tokenMint = await createMint(connection, zynkOpWallet, zynkOpWallet.publicKey, zynkOpWallet.publicKey, 9);
        console.log("Token Mint created:", tokenMint.toString());
        // Create token accounts and mint tokens to the zynkOpWallet
        const zynkOpTokenAccount = await getOrCreateAssociatedTokenAccount(connection, zynkOpWallet, tokenMint, zynkOpWallet.publicKey);
        console.log("Zynk Operator Token Account:", zynkOpTokenAccount.address.toString());
        // Mint tokens to the zynkOpWallet
        await mintTo(connection, zynkOpWallet, tokenMint, zynkOpTokenAccount.address, zynkOpWallet.publicKey, 1000000000000);
        console.log("Minted 1,000,000,000,000 tokens to Zynk Operator");
        // Create partner's operational token account
        const partnerOperationalTokenAccount = await getOrCreateAssociatedTokenAccount(connection, zynkOpWallet, tokenMint, partnerOperationalWallet.publicKey);
        console.log("Partner Operational Token Account:", partnerOperationalTokenAccount.address.toString());
        // Fetch the config account to confirm it has the correct zynkOpWallet
        const configData = (await program.account.config.fetch(configAccount.publicKey));
        console.log("\nConfig Data:");
        console.log("Admin:", configData.admin.toString());
        console.log("Zynk Op Wallet:", configData.zynkOpWallet.toString());
        console.log("Payback Wallet:", configData.paybackWallet.toString());
        console.log("Paused:", configData.paused);
        console.log("Current Nonce:", configData.currentNonce.toString());
        // Check if the zynkOpWallet matches what's in the config
        if (configData.zynkOpWallet.toString() !== zynkOpWallet.publicKey.toString()) {
            throw new Error("Error: zynkOpWallet in config doesn't match our wallet!");
        }
        // Create result object
        const deployResult = {
            programId: programId.toString(),
            adminWallet: adminWallet.publicKey.toString(),
            zynkOpWallet: zynkOpWallet.publicKey.toString(),
            paybackWallet: paybackWallet.publicKey.toString(),
            configAccount: configAccount.publicKey.toString(),
            partnerOperationalWallet: partnerOperationalWallet.publicKey.toString(),
            partnerDepositWallet: partnerDepositWallet.publicKey.toString(),
            tokenMint: tokenMint.toString(),
            zynkOpTokenAccount: zynkOpTokenAccount.address.toString(),
            partnerOperationalTokenAccount: partnerOperationalTokenAccount.address.toString(),
        };
        // Save deployment result to JSON file
        const deploymentPath = path.resolve(__dirname, "../deployment.json");
        writeFileSync(deploymentPath, JSON.stringify(deployResult, null, 2));
        console.log(`\nDeployment data saved to ${deploymentPath}`);
        return deployResult;
    }
    catch (error) {
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

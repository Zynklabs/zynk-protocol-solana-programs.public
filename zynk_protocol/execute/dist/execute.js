import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { Keypair, Connection, LAMPORTS_PER_SOL, SystemProgram, PublicKey, } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, transfer, } from "@solana/spl-token";
import { readFileSync, existsSync } from "fs";
import BN from "bn.js";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { config } from "dotenv";
import path from "path";
import { IDL } from "./idl";
// Load environment variables
config();
// Import utility functions
import { createKeypairFromEnv } from "./utils";
// Import airdrop functionality
import { ensureAccountHasSOL } from "./airdrop";
// Import deployment function
import { deploy } from "./deploy";
// Get current file path in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Function to send tokens using the Zynk protocol
async function sendTokens(program, connection, config, zynkOpWallet, tokenMint, amount, partnerOperationalWallet, partnerDepositWallet) {
    try {
        console.log("\nSending tokens...");
        console.table([
            {
                Parameter: "Token Mint",
                Value: tokenMint.toString(),
            },
            {
                Parameter: "Amount",
                Value: amount.toString(),
            },
            {
                Parameter: "Partner Operational Wallet",
                Value: partnerOperationalWallet.toString(),
            },
            {
                Parameter: "Partner Deposit Wallet",
                Value: partnerDepositWallet.toString(),
            },
        ]);
        // Create a new provider with the zynkOpWallet
        const zynkOpProvider = new anchor.AnchorProvider(connection, new anchor.Wallet(zynkOpWallet), { commitment: "confirmed", skipPreflight: false });
        // Create a new program instance with the zynkOpWallet as provider
        const programWithZynkOp = new Program(program.idl, program.programId, zynkOpProvider);
        console.log("Created new provider with zynkOpWallet as signer");
        // Get or create the operator's token account
        const sourceTokenAccount = await getOrCreateAssociatedTokenAccount(connection, zynkOpWallet, tokenMint, zynkOpWallet.publicKey);
        // Get or create the partner's operational token account for receiving tokens
        const partnerOperationalTokenAccount = await getOrCreateAssociatedTokenAccount(connection, zynkOpWallet, tokenMint, partnerOperationalWallet);
        // Create a new order tracker account
        const orderTracker = Keypair.generate();
        // Convert amount to u64 with BN.js for proper handling
        const amountBN = new BN(amount.toString());
        // Print all accounts being sent for debugging
        console.log("\nAccounts being sent:");
        console.table([
            { Account: "Config", Address: config.toString() },
            { Account: "Zynk Op Wallet", Address: zynkOpWallet.publicKey.toString() },
            {
                Account: "Source Token Account",
                Address: sourceTokenAccount.address.toString(),
            },
            {
                Account: "Partner Operational Token Account",
                Address: partnerOperationalTokenAccount.address.toString(),
            },
            { Account: "Token Program", Address: TOKEN_PROGRAM_ID.toString() },
            { Account: "Order Tracker", Address: orderTracker.publicKey.toString() },
            {
                Account: "System Program",
                Address: SystemProgram.programId.toString(),
            },
        ]);
        // Build and send the transaction using the program with zynkOpWallet provider
        const tx = await programWithZynkOp.methods
            .send(tokenMint, amountBN, partnerDepositWallet)
            .accounts({
            config: config,
            zynkOpWallet: zynkOpWallet.publicKey,
            sourceTokenAccount: sourceTokenAccount.address,
            partnerOperationalWallet: partnerOperationalTokenAccount.address,
            tokenProgram: TOKEN_PROGRAM_ID,
            orderTracker: orderTracker.publicKey,
            systemProgram: SystemProgram.programId,
        })
            .signers([orderTracker]) // zynkOpWallet is already a signer via provider
            .rpc();
        console.table([
            { Status: "Transaction Status", Value: "Successful" },
            { Status: "Transaction Signature", Value: tx },
        ]);
        // Decode and display the Send event
        const decodedEvent = await decodeEvents(connection, tx, true);
        let eventOrderId;
        if (decodedEvent && decodedEvent.eventType === "Send") {
            console.log("\n=== SEND EVENT DATA ===");
            console.table(decodedEvent.data);
            eventOrderId = parseInt(decodedEvent.data.order_id);
            console.table([{ Parameter: "Extracted Order ID", Value: eventOrderId }]);
        }
        return {
            txid: tx,
            orderTracker: {
                publicKey: orderTracker.publicKey,
            },
            orderId: eventOrderId,
        };
    }
    catch (error) {
        console.error("Error sending tokens:", error);
        throw error;
    }
}
// Function to replenish tokens
async function replenishTokens(program, connection, config, orderTracker, depositWallet, depositTokenAccount, paybackWallet, orderId, paybackAmount, validityDuration = 3600 // Default 1 hour validity
) {
    try {
        console.log("\nReplenishing tokens...");
        console.table([
            { Parameter: "Order ID", Value: orderId.toString() },
            {
                Parameter: "Deposit Wallet",
                Value: depositWallet.publicKey.toString(),
            },
            { Parameter: "Payback Wallet", Value: paybackWallet.toString() },
            {
                Parameter: "Deposit Token Account",
                Value: depositTokenAccount.toString(),
            },
            { Parameter: "Amount", Value: paybackAmount.toString() },
        ]);
        // Find the payback token account for the deposit token mint
        const depositAccountInfo = await connection.getAccountInfo(depositTokenAccount);
        if (!depositAccountInfo) {
            throw new Error("Deposit token account not found");
        }
        // Parse the token account to get the mint
        const accountInfo = await connection.getParsedAccountInfo(depositTokenAccount);
        const parsedInfo = accountInfo.value?.data?.parsed;
        const tokenMint = new PublicKey(parsedInfo?.info?.mint);
        console.table([{ Parameter: "Token Mint", Value: tokenMint.toString() }]);
        // Get or create associated token account for the payback wallet
        const paybackTokenAccount = await getOrCreateAssociatedTokenAccount(connection, depositWallet, // payer
        tokenMint, paybackWallet);
        console.table([
            {
                Parameter: "Payback Token Account",
                Value: paybackTokenAccount.address.toString(),
            },
        ]);
        // Create a new provider using the deposit wallet as signer
        const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(depositWallet), { commitment: "confirmed" });
        console.log("Created new provider with depositWallet as signer");
        // Create a new program instance with the deposit wallet as provider
        const programWithSigner = new Program(program.idl, program.programId, provider);
        // Calculate validity timestamp (current time + validity duration in seconds)
        const now = Math.floor(Date.now() / 1000); // Current Unix timestamp
        const validity = now + validityDuration;
        // Convert amount to BN for the program
        const paybackAmountBN = new BN(paybackAmount);
        console.table([
            { Parameter: "Validity Timestamp", Value: validity.toString() },
            { Parameter: "Payback Amount (BN)", Value: paybackAmountBN.toString() },
        ]);
        // Log the accounts being used
        console.log("\nAccounts being sent:");
        console.table([
            { Account: "Config", Address: config.toString() },
            {
                Account: "Deposit Token Account",
                Address: depositTokenAccount.toString(),
            },
            {
                Account: "Payback Token Account",
                Address: paybackTokenAccount.address.toString(),
            },
            { Account: "Token Program", Address: TOKEN_PROGRAM_ID.toString() },
            {
                Account: "Deposit Wallet",
                Address: depositWallet.publicKey.toString(),
            },
            { Account: "Order Tracker", Address: orderTracker.toString() },
        ]);
        // Call the replenish function
        const tx = await programWithSigner.methods
            .replenish(new BN(orderId), // order_id
        new BN(validity), // validity timestamp
        paybackAmountBN // payback_amount
        )
            .accounts({
            config: config,
            depositTokenAccount: depositTokenAccount,
            paybackTokenAccount: paybackTokenAccount.address,
            tokenProgram: TOKEN_PROGRAM_ID,
            depositWallet: depositWallet.publicKey,
            orderTracker: orderTracker,
        })
            .signers([depositWallet])
            .rpc();
        console.table([
            { Status: "Transaction Status", Value: "Successful" },
            { Status: "Transaction Signature", Value: tx },
        ]);
        // Parse and display events
        await parseAndDisplayEvents(connection, tx, program.programId);
        return { txid: tx };
    }
    catch (error) {
        console.error("Error replenishing tokens:", error);
        throw error;
    }
}
// Function to close an order
async function closeOrder(program, connection, config, orderTracker, adminWallet, orderId) {
    try {
        console.log("\nClosing order...");
        console.log("Order ID:", orderId);
        console.log("Order Tracker:", orderTracker.toString());
        console.log("Admin Wallet:", adminWallet.publicKey.toString());
        // Create a new provider using the admin wallet as signer
        const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(adminWallet), { commitment: "confirmed" });
        console.log("Created new provider with adminWallet as signer");
        // Create a new program instance with the admin wallet as provider
        const programWithSigner = new Program(program.idl, program.programId, provider);
        // Log the accounts being used
        console.log("\nAccounts being sent:");
        console.table([
            { Account: "Config", Address: config.toString() },
            { Account: "Admin", Address: adminWallet.publicKey.toString() },
            { Account: "Order Tracker", Address: orderTracker.toString() },
            {
                Account: "System Program",
                Address: anchor.web3.SystemProgram.programId.toString(),
            },
        ]);
        // Call the close_order function
        const tx = await programWithSigner.methods
            .closeOrder(new BN(orderId))
            .accounts({
            config: config,
            admin: adminWallet.publicKey,
            orderTracker: orderTracker,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
            .signers([adminWallet])
            .rpc();
        console.table([
            { Status: "Transaction Status", Value: "Close Order Successful" },
            { Status: "Transaction Signature", Value: tx },
        ]);
        // Parse and display events
        await parseAndDisplayEvents(connection, tx, program.programId);
        return { txid: tx };
    }
    catch (error) {
        console.error("Error closing order:", error);
        throw error;
    }
}
// Function to display wallet balances
async function displayWalletBalances(connection, wallets) {
    console.log("\n=== WALLET BALANCES ===");
    const balanceData = await Promise.all(wallets.map(async (wallet) => {
        const solBalance = await connection.getBalance(wallet.pubkey);
        let tokenBalance = null;
        if (wallet.tokenAccount) {
            try {
                const tokenInfo = await connection.getTokenAccountBalance(wallet.tokenAccount);
                // Use raw amount for full precision
                tokenBalance =
                    parseFloat(tokenInfo.value.amount) / 10 ** tokenInfo.value.decimals;
            }
            catch (e) {
                tokenBalance = "N/A";
            }
        }
        return {
            "Wallet Name": wallet.name,
            Address: wallet.pubkey.toString(),
            "SOL Balance": `${(solBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
            "Token Balance": tokenBalance !== null
                ? tokenBalance.toLocaleString(undefined, {
                    maximumFractionDigits: 6,
                })
                : "N/A",
            "Token Account": wallet.tokenAccount
                ? wallet.tokenAccount.toString()
                : "N/A",
        };
    }));
    console.table(balanceData);
}
// Function to display order tracker details
async function displayOrderTrackerDetails(connection, orderTrackerPubkey) {
    console.log("\n=== ORDER TRACKER DETAILS ===");
    try {
        // Get account info directly from the connection (raw data)
        const accountInfo = await connection.getAccountInfo(orderTrackerPubkey);
        if (!accountInfo) {
            console.log("Order tracker account not found");
            return null;
        }
        // Get SOL balance (rent)
        const solBalance = accountInfo.lamports / LAMPORTS_PER_SOL;
        // Display the raw details in a table
        console.table({
            "Account Address": orderTrackerPubkey.toString(),
            "SOL Balance": `${solBalance.toFixed(6)} SOL`,
            "Data Size": `${accountInfo.data.length} bytes`,
            "Owner Program": accountInfo.owner.toString(),
            Executable: accountInfo.executable,
        });
        console.log("Raw data (base64):", accountInfo.data.slice(0, 40).toString("base64"));
        return accountInfo;
    }
    catch (error) {
        console.error("Error fetching order tracker details:", error);
        console.table({
            "Account Address": orderTrackerPubkey.toString(),
            Status: "Error fetching details",
        });
        return null;
    }
}
// Improved event parser function for Anchor program events
async function parseAndDisplayEvents(connection, txSignature, programId) {
    console.log("\n=== EVENT DATA ===");
    try {
        const tx = await connection.getTransaction(txSignature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });
        if (!tx) {
            console.log("Transaction not found");
            return;
        }
        const logMessages = tx.meta?.logMessages || [];
        // Extract instruction name
        let instructionName = "Unknown";
        for (const log of logMessages) {
            if (log.includes("Program log: Instruction:")) {
                instructionName = log.split("Program log: Instruction:")[1].trim();
                break;
            }
        }
        // Create table data
        const instructionData = {
            Instruction: instructionName,
            Signature: txSignature.substring(0, 16) + "...",
            Status: "Success",
            Timestamp: new Date().toISOString(),
        };
        // Display transaction details in a table
        console.table([instructionData]);
        // Add this block to decode the event
        const decodedEvent = await decodeEvents(connection, txSignature, false);
        if (decodedEvent) {
            console.log(`\n=== DECODED ${decodedEvent.eventType} EVENT ===`);
            console.table(decodedEvent.data);
        }
        // Extract relevant program data logs
        const programDataLogs = logMessages.filter((log) => log.includes("Program data:"));
        if (programDataLogs.length > 0) {
            console.log("\nProgram Data Logs:");
            programDataLogs.forEach((log, i) => {
                const data = log.replace("Program data:", "").trim();
                console.log(`Data ${i + 1}: ${data}`);
            });
        }
        // Extract and display any custom logs that might have been emitted by the program
        const customLogs = logMessages.filter((log) => log.includes("Program log:") &&
            !log.includes("Instruction:") &&
            !log.includes("Program data:") &&
            !log.includes("Program return:"));
        if (customLogs.length > 0) {
            console.log("\nCustom Logs:");
            customLogs.forEach((log, i) => {
                const customLog = log.replace("Program log:", "").trim();
                console.log(`Log ${i + 1}: ${customLog}`);
            });
        }
    }
    catch (error) {
        console.error("Error fetching transaction details:", error);
    }
}
/**
 * Standalone function to decode and display events from a transaction
 * @param connection Solana connection
 * @param txSignature Transaction signature (hash)
 * @param logToConsole Whether to log the event data to console (default: true)
 * @returns Promise with the decoded event data if found
 */
async function decodeEvents(connection, txSignature, logToConsole = true) {
    try {
        // Fetch the transaction data
        const tx = await connection.getTransaction(txSignature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });
        if (!tx) {
            if (logToConsole)
                console.log("Transaction not found");
            return null;
        }
        const logMessages = tx.meta?.logMessages || [];
        // Find the instruction that might have emitted the event
        const sendInstructionIndex = logMessages.findIndex((log) => log.includes("Instruction: Send"));
        const replenishInstructionIndex = logMessages.findIndex((log) => log.includes("Instruction: Replenish"));
        const closeOrderInstructionIndex = logMessages.findIndex((log) => log.includes("Instruction: CloseOrder"));
        // Determine which instruction we're processing
        let instructionType = "Unknown";
        let instructionIndex = -1;
        if (sendInstructionIndex !== -1) {
            instructionType = "Send";
            instructionIndex = sendInstructionIndex;
        }
        else if (replenishInstructionIndex !== -1) {
            instructionType = "Replenish";
            instructionIndex = replenishInstructionIndex;
        }
        else if (closeOrderInstructionIndex !== -1) {
            instructionType = "CloseOrder";
            instructionIndex = closeOrderInstructionIndex;
        }
        if (instructionIndex === -1) {
            if (logToConsole)
                console.log("No relevant instruction found in transaction logs");
            return null;
        }
        // Look for Program data logs that follow the instruction
        let programDataLog = null;
        for (let i = instructionIndex; i < logMessages.length; i++) {
            if (logMessages[i].includes("Program data:")) {
                programDataLog = logMessages[i];
                break;
            }
        }
        if (!programDataLog) {
            if (logToConsole) {
                console.log(`No Program data found for the ${instructionType} instruction`);
            }
            return null;
        }
        // Extract the base64 data
        const base64Data = programDataLog.split("Program data: ")[1].trim();
        try {
            // Decode base64 to a buffer
            const buffer = Buffer.from(base64Data, "base64");
            // The first 8 bytes should be the discriminator
            // Skip the first 8 bytes which might be the discriminator
            let offset = 8;
            // Decode the event data based on the instruction type
            if (instructionType === "Send") {
                // Extract Send event data
                // order_id: u64
                const order_id = buffer.readBigUInt64LE(offset).toString();
                offset += 8;
                // token: Pubkey
                const tokenBytes = buffer.slice(offset, offset + 32);
                offset += 32;
                const token = new PublicKey(tokenBytes).toString();
                // partner_deposit_wallet: Pubkey
                const partnerDepositWalletBytes = buffer.slice(offset, offset + 32);
                offset += 32;
                const partner_deposit_wallet = new PublicKey(partnerDepositWalletBytes).toString();
                // amount: u64
                const amount = buffer.readBigUInt64LE(offset).toString();
                offset += 8;
                // chain_id: u64
                const chain_id = buffer.readBigUInt64LE(offset).toString();
                // Create event data object
                const sendEventData = {
                    order_id,
                    token,
                    partner_deposit_wallet,
                    amount,
                    chain_id,
                };
                if (logToConsole) {
                    console.log("\n=== SEND EVENT DATA ===");
                    console.table({
                        "Order ID": sendEventData.order_id,
                        Token: sendEventData.token,
                        "Partner Deposit Wallet": sendEventData.partner_deposit_wallet,
                        Amount: sendEventData.amount,
                        "Chain ID": sendEventData.chain_id,
                    });
                }
                return {
                    eventType: "Send",
                    data: sendEventData,
                };
            }
            else if (instructionType === "Replenish") {
                // Extract Replenish event data
                // order_id: u64
                const order_id = buffer.readBigUInt64LE(offset).toString();
                offset += 8;
                // token: Pubkey
                const tokenBytes = buffer.slice(offset, offset + 32);
                offset += 32;
                const token = new PublicKey(tokenBytes).toString();
                // amount: u64
                const amount = buffer.readBigUInt64LE(offset).toString();
                offset += 8;
                // status: bool (1 byte)
                const status = buffer.readUInt8(offset) !== 0;
                offset += 1;
                // chain_id: u64
                const chain_id = buffer.readBigUInt64LE(offset).toString();
                // Create event data object
                const replenishEventData = {
                    order_id,
                    token,
                    amount,
                    status,
                    chain_id,
                };
                if (logToConsole) {
                    console.log("\n=== REPLENISH EVENT DATA ===");
                    console.table({
                        "Order ID": replenishEventData.order_id,
                        Token: replenishEventData.token,
                        Amount: replenishEventData.amount,
                        Status: replenishEventData.status,
                        "Chain ID": replenishEventData.chain_id,
                    });
                }
                return {
                    eventType: "Replenish",
                    data: replenishEventData,
                };
            }
            else if (instructionType === "CloseOrder") {
                // Extract ReplenishClosure event data
                // order_id: u64
                const order_id = buffer.readBigUInt64LE(offset).toString();
                offset += 8;
                // timestamp: i64
                const timestamp = buffer.readBigInt64LE(offset).toString();
                offset += 8;
                // Create event data object
                const replenishClosureEventData = {
                    order_id,
                    timestamp,
                    // Include a JavaScript Date object for convenience
                    date: new Date(Number(timestamp) * 1000).toISOString(),
                };
                if (logToConsole) {
                    console.log("\n=== REPLENISH CLOSURE EVENT DATA ===");
                    console.table({
                        "Order ID": replenishClosureEventData.order_id,
                        Timestamp: replenishClosureEventData.timestamp,
                        Date: replenishClosureEventData.date,
                    });
                }
                return {
                    eventType: "ReplenishClosure",
                    data: replenishClosureEventData,
                };
            }
            // If we get here, we couldn't determine the event type
            if (logToConsole) {
                console.log("\n=== UNKNOWN EVENT TYPE ===");
            }
            return {
                eventType: "Unknown",
                data: null,
            };
        }
        catch (decodeError) {
            if (logToConsole) {
                console.error("Error decoding Program data:", decodeError);
            }
            return null;
        }
    }
    catch (error) {
        if (logToConsole)
            console.error("Error fetching transaction details:", error);
        return null;
    }
}
async function main() {
    try {
        // Check if deployment.json exists
        const deploymentPath = path.resolve(__dirname, "../deployment.json");
        let deploymentData;
        if (!existsSync(deploymentPath)) {
            console.log("Deployment data not found. Running deployment...");
            // Run deployment
            deploymentData = await deploy();
            console.log("Deployment completed successfully!");
        }
        else {
            console.log("Loading existing deployment data...");
            deploymentData = JSON.parse(readFileSync(deploymentPath, "utf-8"));
            console.log("Loaded existing deployment data");
        }
        // Create wallets from private keys in .env file
        console.log("Loading wallets from environment variables...");
        // Create keypairs from .env or generate if not available
        const adminWallet = createKeypairFromEnv("ADMIN_WALLET_PRIVATE_KEY", "Admin wallet");
        const zynkOpWallet = createKeypairFromEnv("ZYNK_OP_WALLET_PRIVATE_KEY", "Zynk operator wallet");
        const paybackWallet = createKeypairFromEnv("PAYBACK_WALLET_PRIVATE_KEY", "Payback wallet");
        const configAccount = createKeypairFromEnv("CONFIG_ACCOUNT_PRIVATE_KEY", "Config account");
        const partnerOperationalWallet = createKeypairFromEnv("PARTNER_OPERATIONAL_WALLET_PRIVATE_KEY", "Partner Operational Wallet");
        const partnerDepositWallet = createKeypairFromEnv("PARTNER_DEPOSIT_WALLET_PRIVATE_KEY", "Partner Deposit Wallet");
        // Verify keypairs match deployment data
        if (adminWallet.publicKey.toString() !== deploymentData.adminWallet) {
            console.error("Admin wallet mismatch!");
            return;
        }
        // Display all wallet information in a table
        console.table([
            { Name: "Admin wallet", Address: adminWallet.publicKey.toString() },
            {
                Name: "Zynk operator wallet",
                Address: zynkOpWallet.publicKey.toString(),
            },
            { Name: "Payback wallet", Address: paybackWallet.publicKey.toString() },
            { Name: "Config account", Address: configAccount.publicKey.toString() },
            {
                Name: "Partner Operational Wallet",
                Address: partnerOperationalWallet.publicKey.toString(),
            },
            {
                Name: "Partner Deposit Wallet",
                Address: partnerDepositWallet.publicKey.toString(),
            },
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
        // Airdrop SOL to wallets
        console.log("\nAirdropping SOL to wallets...");
        await ensureAccountHasSOL(connection, adminWallet.publicKey, formattedAmountToAirdrop);
        console.log(`Airdropped ${amount} SOL to ${adminWallet.publicKey.toString()}`);
        await ensureAccountHasSOL(connection, zynkOpWallet.publicKey, formattedAmountToAirdrop);
        console.log(`Airdropped ${amount} SOL to ${zynkOpWallet.publicKey.toString()}`);
        await ensureAccountHasSOL(connection, partnerOperationalWallet.publicKey, formattedAmountToAirdrop);
        console.log(`Airdropped ${amount} SOL to ${partnerOperationalWallet.publicKey.toString()}`);
        await ensureAccountHasSOL(connection, partnerDepositWallet.publicKey, formattedAmountToAirdrop);
        console.log(`Airdropped ${amount} SOL to ${partnerDepositWallet.publicKey.toString()}`);
        // Get program ID from deployment data
        const programId = new PublicKey(deploymentData.programId);
        console.log("\nProgram ID:", programId.toString());
        const program = new Program(IDL, programId, provider);
        // Create token mint from deployment data
        const tokenMint = new PublicKey(deploymentData.tokenMint);
        console.log("Token Mint:", tokenMint.toString());
        // Use token accounts from deployment data
        const zynkOpTokenAccount = new PublicKey(deploymentData.zynkOpTokenAccount);
        console.log("Zynk Operator Token Account:", zynkOpTokenAccount.toString());
        const partnerOperationalTokenAccount = new PublicKey(deploymentData.partnerOperationalTokenAccount);
        console.log("Partner Operational Token Account:", partnerOperationalTokenAccount.toString());
        // Fetch the config account to confirm it has the correct zynkOpWallet
        const configData = (await program.account.config.fetch(new PublicKey(deploymentData.configAccount)));
        console.log("\nConfig Data:");
        console.table([
            { Key: "Admin", Value: configData.admin.toString() },
            { Key: "Zynk Op Wallet", Value: configData.zynkOpWallet.toString() },
            { Key: "Payback Wallet", Value: configData.paybackWallet.toString() },
            { Key: "Paused", Value: configData.paused },
            { Key: "Current Nonce", Value: configData.currentNonce.toString() },
        ]);
        // Check if the zynkOpWallet matches what's in the config
        if (configData.zynkOpWallet.toString() !== zynkOpWallet.publicKey.toString()) {
            console.error("Error: zynkOpWallet in config doesn't match our wallet!");
            return;
        }
        // Display initial wallet balances
        console.log("\nInitial Wallet States:");
        await displayWalletBalances(connection, [
            { name: "Admin", pubkey: adminWallet.publicKey },
            {
                name: "Zynk Operator",
                pubkey: zynkOpWallet.publicKey,
                tokenAccount: zynkOpTokenAccount,
            },
            { name: "Payback", pubkey: paybackWallet.publicKey },
            {
                name: "Partner Operational",
                pubkey: partnerOperationalWallet.publicKey,
                tokenAccount: partnerOperationalTokenAccount,
            },
            { name: "Partner Deposit", pubkey: partnerDepositWallet.publicKey },
        ]);
        // Test send function
        try {
            const result = await sendTokens(program, connection, new PublicKey(deploymentData.configAccount), zynkOpWallet, tokenMint, 1000000, partnerOperationalWallet.publicKey, partnerDepositWallet.publicKey);
            console.log("\nFinal Wallet States after Send:");
            await displayWalletBalances(connection, [
                { name: "Admin", pubkey: adminWallet.publicKey },
                {
                    name: "Zynk Operator",
                    pubkey: zynkOpWallet.publicKey,
                    tokenAccount: zynkOpTokenAccount,
                },
                { name: "Payback", pubkey: paybackWallet.publicKey },
                {
                    name: "Partner Operational",
                    pubkey: partnerOperationalWallet.publicKey,
                    tokenAccount: partnerOperationalTokenAccount,
                },
                { name: "Partner Deposit", pubkey: partnerDepositWallet.publicKey },
                { name: "Order Tracker", pubkey: result.orderTracker.publicKey },
            ]);
            // Display order tracker details
            await displayOrderTrackerDetails(connection, result.orderTracker.publicKey);
            // Create and fund Partner Deposit Token Account
            console.log("\nCreating Partner Deposit Token Account...");
            const partnerDepositTokenAccount = await getOrCreateAssociatedTokenAccount(connection, zynkOpWallet, // payer for account creation
            tokenMint, partnerDepositWallet.publicKey);
            console.log("Partner Deposit Token Account:", partnerDepositTokenAccount.address.toString());
            // Transfer some tokens from Partner Operational to Partner Deposit for testing
            console.log("\nTransferring tokens from Partner Operational to Partner Deposit...");
            await transfer(connection, partnerOperationalWallet, // payer
            partnerOperationalTokenAccount, // source
            partnerDepositTokenAccount.address, // destination
            partnerOperationalWallet, // authority
            500 // amount (half of what was sent)
            );
            console.log("\nWallet States before Replenish:");
            await displayWalletBalances(connection, [
                { name: "Admin", pubkey: adminWallet.publicKey },
                {
                    name: "Zynk Operator",
                    pubkey: zynkOpWallet.publicKey,
                    tokenAccount: zynkOpTokenAccount,
                },
                { name: "Payback", pubkey: paybackWallet.publicKey },
                {
                    name: "Partner Operational",
                    pubkey: partnerOperationalWallet.publicKey,
                    tokenAccount: partnerOperationalTokenAccount,
                },
                {
                    name: "Partner Deposit",
                    pubkey: partnerDepositWallet.publicKey,
                    tokenAccount: partnerDepositTokenAccount.address,
                },
                { name: "Order Tracker", pubkey: result.orderTracker.publicKey },
            ]);
            // Create Payback Token Account
            console.log("\nCreating Payback Token Account...");
            const paybackTokenAccount = await getOrCreateAssociatedTokenAccount(connection, zynkOpWallet, // payer for account creation
            tokenMint, paybackWallet.publicKey);
            console.log("Payback Token Account:", paybackTokenAccount.address.toString());
            // Test replenish function - First replenish with 100 tokens
            console.log("\nTesting Replenish function (First call - 100 tokens)...");
            const replenishResult1 = await replenishTokens(program, connection, new PublicKey(deploymentData.configAccount), result.orderTracker.publicKey, partnerDepositWallet, partnerDepositTokenAccount.address, paybackWallet.publicKey, result.orderId || configData.currentNonce.toNumber(), // Use orderId from Send event or fallback to currentNonce
            100, // first replenish of 100 tokens
            7200 // 2 hour validity
            );
            console.log("\nWallet States after First Replenish:");
            await displayWalletBalances(connection, [
                { name: "Admin", pubkey: adminWallet.publicKey },
                {
                    name: "Zynk Operator",
                    pubkey: zynkOpWallet.publicKey,
                    tokenAccount: zynkOpTokenAccount,
                },
                {
                    name: "Payback",
                    pubkey: paybackWallet.publicKey,
                    tokenAccount: paybackTokenAccount.address,
                },
                {
                    name: "Partner Operational",
                    pubkey: partnerOperationalWallet.publicKey,
                    tokenAccount: partnerOperationalTokenAccount,
                },
                {
                    name: "Partner Deposit",
                    pubkey: partnerDepositWallet.publicKey,
                    tokenAccount: partnerDepositTokenAccount.address,
                },
                { name: "Order Tracker", pubkey: result.orderTracker.publicKey },
            ]);
            // Second replenish with 100 more tokens
            console.log("\nTesting Replenish function (Second call - 100 more tokens)...");
            const replenishResult2 = await replenishTokens(program, connection, new PublicKey(deploymentData.configAccount), result.orderTracker.publicKey, partnerDepositWallet, partnerDepositTokenAccount.address, paybackWallet.publicKey, result.orderId || configData.currentNonce.toNumber(), // Use orderId from Send event or fallback to currentNonce
            100, // second replenish of 100 tokens
            7200 // 2 hour validity
            );
            console.log("\nWallet States after Second Replenish:");
            await displayWalletBalances(connection, [
                { name: "Admin", pubkey: adminWallet.publicKey },
                {
                    name: "Zynk Operator",
                    pubkey: zynkOpWallet.publicKey,
                    tokenAccount: zynkOpTokenAccount,
                },
                {
                    name: "Payback",
                    pubkey: paybackWallet.publicKey,
                    tokenAccount: paybackTokenAccount.address,
                },
                {
                    name: "Partner Operational",
                    pubkey: partnerOperationalWallet.publicKey,
                    tokenAccount: partnerOperationalTokenAccount,
                },
                {
                    name: "Partner Deposit",
                    pubkey: partnerDepositWallet.publicKey,
                    tokenAccount: partnerDepositTokenAccount.address,
                },
                { name: "Order Tracker", pubkey: result.orderTracker.publicKey },
            ]);
            // Test closing the order
            console.log("\nTesting Close Order function...");
            const closeResult = await closeOrder(program, connection, new PublicKey(deploymentData.configAccount), result.orderTracker.publicKey, adminWallet, result.orderId || configData.currentNonce.toNumber() // Use orderId from Send event or fallback to currentNonce
            );
            console.log("\nFinal Wallet States after Order Closure:");
            await displayWalletBalances(connection, [
                { name: "Admin", pubkey: adminWallet.publicKey },
                {
                    name: "Zynk Operator",
                    pubkey: zynkOpWallet.publicKey,
                    tokenAccount: zynkOpTokenAccount,
                },
                {
                    name: "Payback",
                    pubkey: paybackWallet.publicKey,
                    tokenAccount: paybackTokenAccount.address,
                },
                {
                    name: "Partner Operational",
                    pubkey: partnerOperationalWallet.publicKey,
                    tokenAccount: partnerOperationalTokenAccount,
                },
                {
                    name: "Partner Deposit",
                    pubkey: partnerDepositWallet.publicKey,
                    tokenAccount: partnerDepositTokenAccount.address,
                },
            ]);
            // Check if order tracker account still exists
            try {
                const orderTrackerInfo = await connection.getAccountInfo(result.orderTracker.publicKey);
                if (orderTrackerInfo) {
                    console.log("\nWARNING: Order Tracker account still exists after closure");
                }
                else {
                    console.log("\nSuccess: Order Tracker account has been closed");
                }
            }
            catch (error) {
                console.log("\nSuccess: Order Tracker account has been closed");
            }
        }
        catch (error) {
            console.error("Error in token operations:", error);
        }
        console.log("\nConfiguration Summary:");
        console.log("Admin:", adminWallet.publicKey.toString());
        console.log("Zynk Operator:", zynkOpWallet.publicKey.toString());
        console.log("Payback Wallet:", paybackWallet.publicKey.toString());
        console.log("Token Mint:", tokenMint.toString());
        console.log("Partner Operational Token Account:", partnerOperationalTokenAccount.toString());
    }
    catch (error) {
        console.error("Error:", error);
        throw error;
    }
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});

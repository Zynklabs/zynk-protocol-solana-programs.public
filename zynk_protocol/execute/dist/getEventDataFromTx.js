import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "dotenv";
// Load environment variables
config();
/**
 * Get event data from a transaction hash
 * @param txHash Transaction hash (signature)
 * @param connection Optional Solana connection, if not provided will create one from environment
 * @returns Promise with the decoded event data if found
 */
export async function getEventDataFromTx(txHash, connection) {
    // Create a connection if one is not provided
    if (!connection) {
        connection = new Connection(process.env.RPC_URL || "http://localhost:8899", "confirmed");
    }
    try {
        return await decodeEvents(connection, txHash, false);
    }
    catch (error) {
        console.error("Error extracting event data from transaction:", error);
        return null;
    }
}
/**
 * Decode events from a transaction hash
 * @param connection Solana connection
 * @param txSignature Transaction signature (hash)
 * @param logToConsole Whether to log the event data to console (default: false)
 * @returns Promise with the decoded event data if found
 */
async function decodeEvents(connection, txSignature, logToConsole = false) {
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
// Example usage:
// async function example() {
//   const txHash = "your_transaction_hash_here";
//   const eventData = await getEventDataFromTx(txHash);
//   console.log(eventData);
// }
// example().catch(console.error);

import { getEventDataFromTx } from "./getEventDataFromTx.js";
import { config } from "dotenv";
// Load environment variables
config();
/**
 * Get the order ID from a transaction hash
 * @param txHash Transaction hash/signature
 * @param connection Optional Solana connection
 * @returns The order ID as a number, or null if not found
 */
export async function getOrderId(txHash, connection) {
    try {
        // Get event data from transaction
        const eventData = await getEventDataFromTx(txHash, connection);
        // If event data exists and has an order_id property
        if (eventData?.data?.order_id) {
            return parseInt(eventData.data.order_id);
        }
        return null;
    }
    catch (error) {
        console.error("Error getting order ID from transaction:", error);
        return null;
    }
}
// Example usage:
// async function example() {
//   const txHash = "your_transaction_hash_here";
//   const orderId = await getOrderId(txHash);
//   console.log(`Order ID: ${orderId}`);
// }
// example().catch(console.error);

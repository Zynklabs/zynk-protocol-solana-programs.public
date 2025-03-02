import { getOrderId } from "../getOrderId.js";

/**
 * Example function to demonstrate getting an order ID from a transaction hash
 * @param txHash Transaction hash to get the order ID from
 */
async function exampleGetOrderId(txHash: string) {
  console.log(`Fetching order ID for transaction: ${txHash}`);

  try {
    const orderId = await getOrderId(txHash);

    if (orderId === null) {
      console.log("No order ID found for this transaction");
    } else {
      console.log(`Order ID: ${orderId}`);
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

// Run the example with a provided transaction hash
// You can pass a transaction hash as a command line argument
const txHash = process.argv[2];
if (txHash) {
  exampleGetOrderId(txHash)
    .catch(console.error)
    .finally(() => {
      console.log("Example completed");
    });
} else {
  console.log("Please provide a transaction hash as a command line argument");
  console.log("Example: ts-node getOrderIdExample.ts YOUR_TX_HASH");
}

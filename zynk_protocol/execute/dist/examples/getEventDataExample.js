import { getEventDataFromTx } from "../getEventDataFromTx.js";
/**
 * Example function that demonstrates how to use getEventDataFromTx
 * @param txHash Transaction hash (signature) to get event data from
 */
async function exampleGetEventData(txHash) {
    console.log(`Fetching event data for transaction: ${txHash}`);
    try {
        // Call the getEventDataFromTx function with the provided transaction hash
        const eventData = await getEventDataFromTx(txHash);
        if (!eventData) {
            console.log("No event data found for this transaction");
            return;
        }
        // Display the event type and data
        console.log(`Event Type: ${eventData.eventType}`);
        console.log("Event Data:");
        console.table(eventData.data);
        // Depending on the event type, you can process the data differently
        switch (eventData.eventType) {
            case "Send":
                console.log(`
          Order ID: ${eventData.data.order_id}
          Token: ${eventData.data.token}
          Partner Deposit Wallet: ${eventData.data.partner_deposit_wallet}
          Amount: ${eventData.data.amount}
          Chain ID: ${eventData.data.chain_id}
        `);
                break;
            case "Replenish":
                console.log(`
          Order ID: ${eventData.data.order_id}
          Token: ${eventData.data.token}
          Amount: ${eventData.data.amount}
          Status: ${eventData.data.status ? "Success" : "Failed"}
          Chain ID: ${eventData.data.chain_id}
        `);
                break;
            case "ReplenishClosure":
                console.log(`
          Order ID: ${eventData.data.order_id}
          Timestamp: ${eventData.data.timestamp}
          Date: ${eventData.data.date}
        `);
                break;
            default:
                console.log("Unknown event type");
        }
    }
    catch (error) {
        console.error("Error getting event data:", error);
    }
}
// Run the example with a provided transaction hash
// You can pass a transaction hash as a command line argument
const txHash = process.argv[2];
if (txHash) {
    exampleGetEventData(txHash)
        .catch(console.error)
        .finally(() => {
        console.log("Example completed");
    });
}
else {
    console.log("Please provide a transaction hash as a command line argument");
    console.log("Example: ts-node getEventDataExample.ts YOUR_TX_HASH");
}

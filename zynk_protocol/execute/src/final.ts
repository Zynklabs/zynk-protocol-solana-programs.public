import { Program } from "@project-serum/anchor";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import * as anchor from "@project-serum/anchor";
import { config } from "dotenv";
import fs from "fs";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  createMintToInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { IDL } from "./idl.js";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { getEventDataFromTx } from "./getEventDataFromTx.js";
import { getOrderId } from "./getOrderId.js";

// Create __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
config();

/**
 * Sends tokens from the Zynk operator wallet to a partner operational wallet
 * @param params Essential parameters for sending tokens
 * @returns Transaction signature, order tracker, and order ID
 */
async function sendTokens(params: {
  amount: number;
  tokenMint: PublicKey;
  partnerOperationalWallet: PublicKey;
  partnerDepositWallet: PublicKey;
}): Promise<{
  txid: string;
  orderTracker: { publicKey: PublicKey };
  orderId: number | undefined;
}> {
  // Load deployment data
  const deploymentPath = path.join(__dirname, "../deployment.json");
  const deploymentData = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));

  // Create connection from RPC_URL in environment
  const connection = new Connection(
    process.env.RPC_URL || "https://api.devnet.solana.com"
  );

  // Parse optional parameters or use defaults from deployment
  const {
    amount,
    tokenMint = new PublicKey(deploymentData.tokenMint),
    partnerOperationalWallet = new PublicKey(
      deploymentData.partnerOperationalWallet
    ),
    partnerDepositWallet = new PublicKey(deploymentData.partnerDepositWallet),
  } = params;

  // Load Zynk operator wallet from environment
  const zynkOpWalletPrivateKey = process.env.ZYNK_OP_WALLET_PRIVATE_KEY;
  if (!zynkOpWalletPrivateKey) {
    throw new Error(
      "Zynk operator wallet private key not found in environment variables"
    );
  }
  const zynkOpWallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(zynkOpWalletPrivateKey))
  );

  // Create provider with zynkOpWallet
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(zynkOpWallet),
    { commitment: "confirmed", skipPreflight: false }
  );

  // Initialize the program
  const programId = new PublicKey(deploymentData.programId);
  const program = new Program(IDL as any, programId, provider);

  // Config account
  const configAccount = new PublicKey(deploymentData.configAccount);

  console.table([
    { Parameter: "Token Mint", Value: tokenMint.toString() },
    { Parameter: "Amount", Value: amount.toString() },
    {
      Parameter: "Partner Operational Wallet",
      Value: partnerOperationalWallet.toString(),
    },
    {
      Parameter: "Partner Deposit Wallet",
      Value: partnerDepositWallet.toString(),
    },
  ]);

  // Get or create the operator's token account
  const sourceTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    zynkOpWallet,
    tokenMint,
    zynkOpWallet.publicKey
  );

  // Get or create the partner's operational token account for receiving tokens
  const partnerOperationalTokenAccount =
    await getOrCreateAssociatedTokenAccount(
      connection,
      zynkOpWallet,
      tokenMint,
      partnerOperationalWallet
    );

  // Create a new order tracker account
  const orderTracker = Keypair.generate();

  // Convert amount to BN for the program
  const amountBN = new BN(amount.toString());

  console.table([
    { Account: "Config", Address: configAccount.toString() },
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
  ]);

  try {
    // Build and send the transaction using the program
    const tx = await program.methods
      .send(tokenMint, amountBN, partnerDepositWallet)
      .accounts({
        config: configAccount,
        zynkOpWallet: zynkOpWallet.publicKey,
        sourceTokenAccount: sourceTokenAccount.address,
        partnerOperationalWallet: partnerOperationalTokenAccount.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        orderTracker: orderTracker.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([orderTracker]) // zynkOpWallet is already a signer via provider
      .rpc();

    console.table([
      { Status: "Transaction Status", Value: "Successful" },
      { Status: "Transaction Signature", Value: tx },
    ]);

    // Log event information from the send transaction
    try {
      const eventData = await getEventDataFromTx(tx, connection);
      console.log("\nSend Transaction Event Data:");
      if (eventData && eventData.data) {
        const flatEventData: Record<string, string> = {
          Event: eventData.eventType,
        };
        // Add all data properties to the flat object
        Object.entries(eventData.data).forEach(([key, value]) => {
          flatEventData[key] = String(value);
        });
        console.table([flatEventData]);
      } else {
        console.log("No event data found for this transaction.");
      }
    } catch (eventError) {
      console.error("Error extracting event data:", eventError);
    }

    // Extract the order_id from the events
    let orderId: number | undefined = undefined;
    try {
      // Use our getOrderId utility to extract the order ID from transaction
      const extractedOrderId = await getOrderId(tx, connection);
      if (extractedOrderId !== null) {
        orderId = extractedOrderId;
        console.log(`Extracted Order ID: ${orderId}`);
      }
    } catch (error) {
      console.error("Error extracting order ID:", error);
    }

    return {
      txid: tx,
      orderTracker,
      orderId,
    };
  } catch (error) {
    console.error("Error in sendTokens:", error);
    throw error;
  }
}

/**
 * Replenishes tokens as part of the token flow
 * @param params Parameters for replenishing tokens, matching Rust contract parameters
 * @returns Transaction signature
 */
async function replenish(params: {
  orderId: number; // order_id: u64
  validityTimestamp: number; // validity: i64 - Unix timestamp when validity ends
  paybackAmount: number; // payback_amount: u64
  depositWalletPrivateKey: string; // Private key for deposit wallet (JSON stringified array)
  orderTrackerPublicKey: PublicKey; // Public key of the order tracker
}): Promise<{ txid: string }> {
  // Verify that we have a valid private key
  if (
    !params.depositWalletPrivateKey ||
    params.depositWalletPrivateKey === "[]"
  ) {
    throw new Error(
      "Valid deposit wallet private key is required for replenish function"
    );
  }

  // Load deployment data
  const deploymentPath = path.join(__dirname, "../deployment.json");
  const deploymentData = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));

  // Create connection from RPC_URL in environment
  const connection = new Connection(
    process.env.RPC_URL || "https://api.devnet.solana.com"
  );

  const {
    orderId,
    validityTimestamp,
    paybackAmount,
    depositWalletPrivateKey,
    orderTrackerPublicKey,
  } = params;

  // Load orderTracker from deployment data and order ID
  const orderTracker = new PublicKey(orderTrackerPublicKey);

  // Create deposit wallet from provided private key
  const depositWallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(depositWalletPrivateKey))
  );

  // Load payback wallet from deployment
  const paybackWallet = new PublicKey(deploymentData.paybackWallet);

  // Create provider with deposit wallet
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(depositWallet),
    { commitment: "confirmed", skipPreflight: false }
  );

  // Initialize the program
  const programId = new PublicKey(deploymentData.programId);
  const program = new Program(IDL as any, programId, provider);

  // Config account
  const configAccount = new PublicKey(deploymentData.configAccount);

  // Token mint
  const tokenMint = new PublicKey(deploymentData.tokenMint);

  // Get or create payback token account
  const paybackTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    depositWallet,
    tokenMint,
    paybackWallet
  );

  // Convert amount to BN for the program
  const paybackAmountBN = new BN(paybackAmount.toString());

  // Get deposit token account
  const depositWalletPubkey = depositWallet.publicKey;
  const depositTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    depositWallet,
    tokenMint,
    depositWalletPubkey
  );

  console.table([
    { Parameter: "Order ID", Value: orderId.toString() },
    { Parameter: "Validity Timestamp", Value: validityTimestamp.toString() },
    { Parameter: "Payback Amount", Value: paybackAmount.toString() },
    { Parameter: "Order Tracker", Value: orderTracker.toString() },
    { Parameter: "Deposit Wallet", Value: depositWallet.publicKey.toString() },
    { Parameter: "Payback Wallet", Value: paybackWallet.toString() },
  ]);

  console.table([
    { Account: "Config", Address: configAccount.toString() },
    {
      Account: "Deposit Token Account",
      Address: depositTokenAccount.address.toString(),
    },
    {
      Account: "Payback Token Account",
      Address: paybackTokenAccount.address.toString(),
    },
    { Account: "Token Program", Address: TOKEN_PROGRAM_ID.toString() },
    { Account: "Deposit Wallet", Address: depositWallet.publicKey.toString() },
    { Account: "Order Tracker", Address: orderTracker.toString() },
  ]);

  try {
    // Call the replenish function with parameters in the same order as the Rust contract
    const tx = await program.methods
      .replenish(
        new BN(orderId), // order_id: u64
        new BN(validityTimestamp), // validity: i64
        paybackAmountBN // payback_amount: u64
      )
      .accounts({
        config: configAccount,
        depositTokenAccount: depositTokenAccount.address,
        paybackTokenAccount: paybackTokenAccount.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        depositWallet: depositWallet.publicKey,
        orderTracker: orderTracker,
      })
      .rpc();

    console.table([
      { Status: "Transaction Status", Value: "Successful" },
      { Status: "Transaction Signature", Value: tx },
    ]);

    // Log event information from the replenish transaction
    try {
      const eventData = await getEventDataFromTx(tx, connection);
      console.log("\nReplenish Transaction Event Data:");
      if (eventData && eventData.data) {
        const flatEventData: Record<string, string> = {
          Event: eventData.eventType,
        };
        // Add all data properties to the flat object
        Object.entries(eventData.data).forEach(([key, value]) => {
          flatEventData[key] = String(value);
        });
        console.table([flatEventData]);
      } else {
        console.log("No event data found for this transaction.");
      }
    } catch (eventError) {
      console.error("Error extracting event data:", eventError);
    }

    return { txid: tx };
  } catch (error) {
    console.error("Error in replenish:", error);
    throw error;
  }
}

/**
 * Closes an order using the admin wallet
 * @param params Parameters for closing an order
 * @returns Transaction signature
 */
async function closeOrders(params: {
  orderId: number; // order_id: u64
  adminWalletPrivateKey: string; // Admin wallet private key (JSON stringified array)
  orderTrackerPublicKey: PublicKey; // Public key of the order tracker
}): Promise<{ txid: string }> {
  // Verify that we have a valid private key
  if (!params.adminWalletPrivateKey || params.adminWalletPrivateKey === "[]") {
    throw new Error(
      "Valid admin wallet private key is required for closeOrders function"
    );
  }

  // Load deployment data
  const deploymentPath = path.join(__dirname, "../deployment.json");
  const deploymentData = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));

  // Create connection from RPC_URL in environment
  const connection = new Connection(
    process.env.RPC_URL || "https://api.devnet.solana.com"
  );

  // Parse parameters
  const { orderId, adminWalletPrivateKey, orderTrackerPublicKey } = params;

  // Load orderTracker from deployment data
  const orderTracker = new PublicKey(orderTrackerPublicKey);

  // Create admin wallet from provided private key
  const adminWallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(adminWalletPrivateKey))
  );

  // Create provider with admin wallet
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(adminWallet),
    { commitment: "confirmed", skipPreflight: false }
  );

  // Initialize the program
  const programId = new PublicKey(deploymentData.programId);
  const program = new Program(IDL as any, programId, provider);

  // Config account
  const configAccount = new PublicKey(deploymentData.configAccount);

  console.table([
    { Parameter: "Order ID", Value: orderId.toString() },
    { Parameter: "Admin Wallet", Value: adminWallet.publicKey.toString() },
    { Parameter: "Order Tracker", Value: orderTracker.toString() },
  ]);

  try {
    // Call the closeOrders function
    const tx = await program.methods
      .closeOrder(new BN(orderId))
      .accounts({
        config: configAccount,
        admin: adminWallet.publicKey,
        orderTracker: orderTracker,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.table([
      { Status: "Transaction Status", Value: "Successful" },
      { Status: "Transaction Signature", Value: tx },
    ]);

    // Log event information from the close order transaction
    try {
      const eventData = await getEventDataFromTx(tx, connection);
      console.log("\nClose Order Transaction Event Data:");
      if (eventData && eventData.data) {
        const flatEventData: Record<string, string> = {
          Event: eventData.eventType,
        };
        // Add all data properties to the flat object
        Object.entries(eventData.data).forEach(([key, value]) => {
          flatEventData[key] = String(value);
        });
        console.table([flatEventData]);
      } else {
        console.log("No event data found for this transaction.");
      }
    } catch (eventError) {
      console.error("Error extracting event data:", eventError);
    }

    return { txid: tx };
  } catch (error) {
    console.error("Error in closeOrders:", error);
    throw error;
  }
}

/**
 * Close an order after it's been processed
 */
async function closeOrdersWorkflow({
  orderId,
  adminWalletPrivateKey,
  orderTrackerPublicKey,
}: {
  orderId: number;
  adminWalletPrivateKey: string; // Admin wallet private key (JSON stringified array)
  orderTrackerPublicKey: PublicKey; // Public key of the order tracker
}) {
  console.log("\n3. CLOSING ORDER");
  const closeResult = await closeOrders({
    orderId,
    adminWalletPrivateKey,
    orderTrackerPublicKey,
  });

  console.log("\nClose Order Transaction Results:");
  console.table([{ Parameter: "Transaction ID", Value: closeResult.txid }]);

  return closeResult;
}

/**
 * Send tokens from the Zynk operator wallet to a partner operational wallet
 */
async function sendTokensWorkflow({
  amount,
  tokenMint,
  partnerOperationalWallet,
  partnerDepositWallet,
}: {
  amount: number;
  tokenMint: PublicKey;
  partnerOperationalWallet: PublicKey;
  partnerDepositWallet: PublicKey;
}) {
  console.log("\n1. SENDING TOKENS");
  // User provides amount directly in the smallest denomination
  const sendResult = await sendTokens({
    amount,
    tokenMint,
    partnerOperationalWallet,
    partnerDepositWallet,
  });

  console.log("\nSend Transaction Results:");
  console.table([
    { Parameter: "Transaction ID", Value: sendResult.txid },
    {
      Parameter: "Order Tracker",
      Value: sendResult.orderTracker.publicKey.toString(),
    },
    {
      Parameter: "Order ID",
      Value: sendResult.orderId?.toString() || "Unknown",
    },
  ]);

  return sendResult;
}

/**
 * Replenish tokens from the partner deposit wallet
 */
async function replenishTokensWorkflow({
  orderId,
  validityTimestamp,
  paybackAmount,
  depositWalletPrivateKey,
  orderTrackerPublicKey,
}: {
  orderId: number;
  validityTimestamp: number; // Required timestamp for validity
  paybackAmount: number;
  depositWalletPrivateKey: string; // Private key for deposit wallet (JSON stringified array)
  orderTrackerPublicKey: PublicKey; // Public key of the order tracker
}) {
  console.log("\n2. REPLENISHING TOKENS");

  console.table([
    { Parameter: "Order ID", Value: orderId.toString() },
    { Parameter: "Validity Timestamp", Value: validityTimestamp.toString() },
    { Parameter: "Payback Amount", Value: paybackAmount.toString() },
  ]);

  const replenishResult = await replenish({
    orderId,
    validityTimestamp,
    paybackAmount,
    depositWalletPrivateKey,
    orderTrackerPublicKey,
  });

  console.log("\nReplenish Transaction Results:");
  console.table([{ Parameter: "Transaction ID", Value: replenishResult.txid }]);

  return replenishResult;
}

/**
 * Initialize the environment for the demonstration
 * Sets up connections, wallets, and program instance
 */
async function initializeEnvironment() {
  // Load deployment data
  const deploymentPath = path.resolve(__dirname, "../deployment.json");
  const deploymentData = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  // Setup connection
  const rpcUrl = process.env.RPC_URL || "http://localhost:8899";
  const connection = new Connection(rpcUrl, "confirmed");

  // Load wallets from environment variables
  const adminWalletPrivateKey = JSON.parse(
    process.env.ADMIN_WALLET_PRIVATE_KEY || "[]"
  );
  const zynkOpWalletPrivateKey = JSON.parse(
    process.env.ZYNK_OP_WALLET_PRIVATE_KEY || "[]"
  );
  const partnerDepositWalletPrivateKey = JSON.parse(
    process.env.PARTNER_DEPOSIT_WALLET_PRIVATE_KEY || "[]"
  );

  // Create keypairs from private keys
  const adminWallet = Keypair.fromSecretKey(
    new Uint8Array(adminWalletPrivateKey)
  );
  const zynkOpWallet = Keypair.fromSecretKey(
    new Uint8Array(zynkOpWalletPrivateKey)
  );
  const partnerDepositWallet = Keypair.fromSecretKey(
    new Uint8Array(partnerDepositWalletPrivateKey)
  );

  // Create public keys from deployment data
  const programId = new PublicKey(deploymentData.programId);
  const configAccount = new PublicKey(deploymentData.configAccount);
  const tokenMint = new PublicKey(deploymentData.tokenMint);
  const partnerOperationalWallet = new PublicKey(
    deploymentData.partnerOperationalWallet
  );
  const partnerDepositWalletPubkey = new PublicKey(
    deploymentData.partnerDepositWallet
  );
  const paybackWallet = new PublicKey(deploymentData.paybackWallet);

  // Initialize provider with the admin wallet
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(adminWallet),
    { commitment: "confirmed" }
  );

  // Initialize the program
  const program = new Program(IDL as any, programId, provider);

  return {
    connection,
    program,
    configAccount,
    adminWallet,
    zynkOpWallet,
    partnerDepositWallet,
    tokenMint,
    partnerOperationalWallet,
    partnerDepositWalletPubkey,
    paybackWallet,
  };
}

/**
 * Main function to run the demonstration
 */
async function main() {
  try {
    await initializeEnvironment();

    console.log("\n===== STARTING DEMONSTRATION WORKFLOW =====\n");

    // Load deployment data for mint and wallet addresses
    const deploymentPath = path.join(__dirname, "../deployment.json");
    const deploymentData = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));

    // Load token mint and wallet addresses from deployment.json
    const tokenMint = new PublicKey(deploymentData.tokenMint);
    const partnerOperationalWallet = new PublicKey(
      deploymentData.partnerOperationalWallet
    );
    const partnerDepositWallet = new PublicKey(
      deploymentData.partnerDepositWallet
    );

    console.log("Using token mint:", tokenMint.toString());
    console.log(
      "Using partner operational wallet:",
      partnerOperationalWallet.toString()
    );
    console.log(
      "Using partner deposit wallet:",
      partnerDepositWallet.toString()
    );

    // For testing purposes, use the proper format from .env.example
    // In production, these would come from environment variables
    const depositWalletPrivateKey =
      process.env.PARTNER_DEPOSIT_WALLET_PRIVATE_KEY; // Using format from .env.example
    const adminWalletPrivateKey = process.env.ADMIN_WALLET_PRIVATE_KEY; // Using format from .env.example

    console.log(
      "\nNote: Using test private keys for demonstration. Replace with real keys for production use.\n"
    );

    // Run sending tokens workflow
    const sendResult = await sendTokensWorkflow({
      amount: 1000000, // Amount in smallest denomination
      tokenMint,
      partnerOperationalWallet,
      partnerDepositWallet,
    });

    // Check if order ID is available before proceeding
    // Use a hardcoded order ID for testing if it's not available
    const orderId = sendResult.orderId || 1; // Use 1 as a fallback order ID for testing

    if (!sendResult.orderId) {
      console.log("Warning: Order ID not found. Using fallback ID:", orderId);
    }

    // Check if we can run the full workflow with replenish and close operations
    // For these demo operations to work properly, we need valid keys AND empty arrays won't work
    const hasValidDepositKey =
      depositWalletPrivateKey && depositWalletPrivateKey !== "[]";
    const hasValidAdminKey =
      adminWalletPrivateKey && adminWalletPrivateKey !== "[]";

    if (hasValidDepositKey && hasValidAdminKey) {
      try {
        console.log("\n2. REPLENISHING TOKENS");

        // Run Replenishing Tokens workflow with a 2-day validity period
        const validityTimestamp =
          Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60; // 2 days from now

        // Mint some tokens for the replenish operation
        console.log(
          "\nMinting tokens for the deposit wallet to use in replenish operation..."
        );
        try {
          // Create deposit wallet from private key
          const depositWallet = Keypair.fromSecretKey(
            Uint8Array.from(JSON.parse(depositWalletPrivateKey))
          );

          // Setup a connection
          const conn = new Connection(
            process.env.RPC_URL || "https://api.devnet.solana.com"
          );

          // Check the balance of the deposit wallet
          const balance = await conn.getBalance(depositWallet.publicKey);
          console.log(
            `Current SOL balance of deposit wallet: ${
              balance / anchor.web3.LAMPORTS_PER_SOL
            } SOL`
          );

          // Airdrop some SOL to the deposit wallet if balance is low
          if (balance < 0.1 * anchor.web3.LAMPORTS_PER_SOL) {
            console.log("Deposit wallet balance is low. Airdropping 1 SOL...");
            try {
              const airdropSignature = await conn.requestAirdrop(
                depositWallet.publicKey,
                anchor.web3.LAMPORTS_PER_SOL
              );

              // Wait for airdrop to be confirmed
              await conn.confirmTransaction(airdropSignature);

              // Verify the new balance
              const newBalance = await conn.getBalance(depositWallet.publicKey);
              console.log(
                `New SOL balance after airdrop: ${
                  newBalance / anchor.web3.LAMPORTS_PER_SOL
                } SOL`
              );
            } catch (airdropError) {
              console.error("Failed to airdrop SOL:", airdropError);
            }
          }

          // Get the token mint authority from deployment data
          const tokenMintAuthority = Keypair.fromSecretKey(
            Uint8Array.from(
              JSON.parse(process.env.ZYNK_OP_WALLET_PRIVATE_KEY || "[]")
            )
          );

          // Get the deposit wallet token account
          const depositTokenAccount = await getOrCreateAssociatedTokenAccount(
            new Connection(
              process.env.RPC_URL || "https://api.devnet.solana.com"
            ),
            depositWallet,
            tokenMint,
            depositWallet.publicKey
          );

          // Mint tokens to the deposit wallet (using the mint authority)
          const mintTx = await new Connection(
            process.env.RPC_URL || "https://api.devnet.solana.com"
          ).sendTransaction(
            new Transaction().add(
              createMintToInstruction(
                tokenMint,
                depositTokenAccount.address,
                tokenMintAuthority.publicKey,
                1000000 // Amount to mint
              )
            ),
            [tokenMintAuthority]
          );

          console.log(
            `Minted tokens to deposit wallet. Transaction: ${mintTx}`
          );
        } catch (error) {
          console.error("Error minting tokens:", error);
          console.log("Continuing with replenish operation anyway...");
        }

        const replenishResult = await replenishTokensWorkflow({
          orderId,
          validityTimestamp,
          paybackAmount: 500000, // Same amount for simplicity
          depositWalletPrivateKey,
          orderTrackerPublicKey: sendResult.orderTracker.publicKey,
        });

        console.log("\n3. CLOSING ORDER");
        // Run Close Order workflow
        const closeResult = await closeOrdersWorkflow({
          orderId,
          adminWalletPrivateKey,
          orderTrackerPublicKey: sendResult.orderTracker.publicKey,
        });

        console.log("\nWorkflow completed successfully with full operations.");
      } catch (error) {
        console.error("Error in replenish/close workflow:", error);
        console.log("\nCould not complete full workflow due to an error.");
      }
    } else {
      console.log(
        "\nSkipping replenish and close operations due to missing valid private keys."
      );
      console.log(
        "To perform full workflow, provide valid private keys in environment variables:"
      );
      console.log(
        "- PARTNER_DEPOSIT_WALLET_PRIVATE_KEY (currently empty or invalid)"
      );
      console.log("- ADMIN_WALLET_PRIVATE_KEY (currently empty or invalid)");
    }

    console.log("\n===== DEMONSTRATION WORKFLOW COMPLETED SUCCESSFULLY =====");
  } catch (error) {
    console.error("Error in main:", error);
    process.exit(1);
  }
}

// Run the main function if this script is executed directly
// For ES modules, check if the current file is the main module being executed
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main();
}

// Export functions
export {
  sendTokens,
  replenish,
  closeOrders,
  initializeEnvironment,
  sendTokensWorkflow,
  replenishTokensWorkflow,
  closeOrdersWorkflow,
  main,
  getEventDataFromTx,
};

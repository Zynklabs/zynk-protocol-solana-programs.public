import { Program } from "@project-serum/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@project-serum/anchor";
import { config } from "dotenv";
import fs from "fs";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import BN from "bn.js";
import { IDL } from "./idl";
import path from "path";

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

    // Decode events to get order_id
    const confirmedTx = await connection.getTransaction(tx, {
      maxSupportedTransactionVersion: 0,
    });

    // Extract the order_id from the events
    let orderId: number | undefined = undefined;
    if (confirmedTx && confirmedTx.meta && confirmedTx.meta.logMessages) {
      for (const log of confirmedTx.meta.logMessages) {
        if (log.includes("order_id")) {
          try {
            const match = log.match(/order_id: (\d+)/);
            if (match && match[1]) {
              orderId = parseInt(match[1], 10);
              console.log(`Extracted Order ID: ${orderId}`);
            }
          } catch (error) {
            console.error("Error parsing order_id:", error);
          }
        }
      }
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
 * @param params Parameters for replenishing tokens
 * @returns Transaction signature
 */
async function replenish(params: {
  orderTracker: PublicKey;
  orderId: number;
  paybackAmount: number;
  validityDuration?: number; // Default 3600 (1 hour)
  depositWallet?: Keypair;
  paybackWallet?: PublicKey;
}): Promise<{ txid: string }> {
  // Load deployment data
  const deploymentPath = path.join(__dirname, "../deployment.json");
  const deploymentData = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));

  // Create connection from RPC_URL in environment
  const connection = new Connection(
    process.env.RPC_URL || "https://api.devnet.solana.com"
  );

  // Parse optional parameters or use defaults
  const {
    orderTracker,
    orderId,
    paybackAmount,
    validityDuration = 3600,
    paybackWallet = new PublicKey(deploymentData.paybackWallet),
  } = params;

  // Load deposit wallet from environment or use provided one
  let depositWallet = params.depositWallet;
  if (!depositWallet) {
    const depositWalletPrivateKey =
      process.env.PARTNER_DEPOSIT_WALLET_PRIVATE_KEY;
    if (!depositWalletPrivateKey) {
      throw new Error(
        "Partner deposit wallet private key not found in environment variables"
      );
    }
    depositWallet = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(depositWalletPrivateKey))
    );
  }

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

  // Calculate validity timestamp
  const now = Math.floor(Date.now() / 1000);
  const validity = now + validityDuration;

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
    // Call the replenish function
    const tx = await program.methods
      .replenish(new BN(orderId), paybackAmountBN, new BN(validity), tokenMint)
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
  orderTracker: PublicKey;
  orderId: number;
  adminWallet?: Keypair;
}): Promise<{ txid: string }> {
  // Load deployment data
  const deploymentPath = path.join(__dirname, "../deployment.json");
  const deploymentData = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));

  // Create connection from RPC_URL in environment
  const connection = new Connection(
    process.env.RPC_URL || "https://api.devnet.solana.com"
  );

  // Parse optional parameters or use defaults
  const { orderTracker, orderId } = params;

  // Load admin wallet from environment or use provided one
  let adminWallet = params.adminWallet;
  if (!adminWallet) {
    const adminWalletPrivateKey = process.env.ADMIN_WALLET_PRIVATE_KEY;
    if (!adminWalletPrivateKey) {
      throw new Error(
        "Admin wallet private key not found in environment variables"
      );
    }
    adminWallet = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(adminWalletPrivateKey))
    );
  }

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
      .closeOrders(new BN(orderId))
      .accounts({
        config: configAccount,
        adminWallet: adminWallet.publicKey,
        orderTracker: orderTracker,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.table([
      { Status: "Transaction Status", Value: "Successful" },
      { Status: "Transaction Signature", Value: tx },
    ]);

    return { txid: tx };
  } catch (error) {
    console.error("Error in closeOrders:", error);
    throw error;
  }
}

/**
 * Close an order using the admin wallet
 */
async function closeOrderWorkflow({
  orderTracker,
  orderId,
  adminWallet,
}: {
  orderTracker: PublicKey;
  orderId: number;
  adminWallet?: Keypair;
}) {
  console.log("\n3. CLOSING ORDER");
  const closeResult = await closeOrders({
    orderTracker,
    orderId,
    adminWallet,
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
  tokenMint?: PublicKey;
  partnerOperationalWallet?: PublicKey;
  partnerDepositWallet?: PublicKey;
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
  orderTrackerPubkey,
  orderId,
  paybackAmount,
  depositWallet,
  paybackWallet,
}: {
  orderTrackerPubkey: PublicKey;
  orderId: number;
  paybackAmount: number;
  depositWallet?: Keypair;
  paybackWallet?: PublicKey;
}) {
  console.log("\n2. REPLENISHING TOKENS");
  const replenishResult = await replenish({
    orderTracker: orderTrackerPubkey,
    orderId,
    paybackAmount,
    depositWallet,
    paybackWallet,
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
    console.log("\n===== STARTING DEMONSTRATION WORKFLOW =====");

    // Run Sending Tokens workflow
    const sendResult = await sendTokensWorkflow({
      amount: 1000000, // Amount in smallest denomination
      // All other parameters are optional and will be loaded from deployment.json and .env
    });

    // Check if order ID is available before proceeding
    if (!sendResult.orderId) {
      throw new Error("Order ID not found in the transaction logs");
    }

    // Run Replenishing Tokens workflow
    const replenishResult = await replenishTokensWorkflow({
      orderTrackerPubkey: sendResult.orderTracker.publicKey,
      orderId: sendResult.orderId,
      paybackAmount: 500000, // Half of the sent amount
    });

    // Run Close Order workflow
    const closeResult = await closeOrderWorkflow({
      orderTracker: sendResult.orderTracker.publicKey,
      orderId: sendResult.orderId,
    });

    console.log("\n===== DEMONSTRATION WORKFLOW COMPLETED SUCCESSFULLY =====");

    return {
      sendResult,
      replenishResult,
      closeResult,
    };
  } catch (error) {
    console.error("Error in main:", error);
    process.exit(1);
  }
}

// Run the main function if this script is executed directly
if (require.main === module) {
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
  closeOrderWorkflow,
  main,
};

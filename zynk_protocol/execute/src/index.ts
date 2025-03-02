import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  SystemProgram,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
} from "@solana/spl-token";
import { readFileSync } from "fs";
import BN from "bn.js";
import BigNumber from "bignumber.js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { table } from "console";
import { config } from "dotenv";

// Load environment variables
config();

// Function to create a keypair from a private key array in .env
const createKeypairFromEnv = (
  envVar: string,
  fallbackLabel?: string
): Keypair => {
  const privateKeyStr = process.env[envVar];

  // If private key is provided, use it
  if (privateKeyStr) {
    try {
      const privateKeyArray = JSON.parse(privateKeyStr);
      return Keypair.fromSecretKey(Uint8Array.from(privateKeyArray));
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error parsing private key";

      console.warn(`Error parsing private key from ${envVar}: ${errorMessage}`);
      console.warn(
        `Generating a random keypair for ${fallbackLabel || envVar} instead`
      );
    }
  } else {
    console.warn(
      `No private key found for ${envVar}. Generating a random keypair for ${
        fallbackLabel || envVar
      } instead`
    );
  }

  // Fallback to generating a new keypair
  return Keypair.generate();
};

// Get current file path in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Function to get program ID from keypair file
function getProgramId(): PublicKey {
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

// Helper function to airdrop SOL
async function airdropSol(
  connection: Connection,
  address: PublicKey,
  amount: number
): Promise<void> {
  try {
    const signature = await connection.requestAirdrop(
      address,
      amount * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(signature, "confirmed");
    console.log(`Airdropped ${amount} SOL to ${address.toString()}`);
    console.log(
      `New balance: ${(
        (await connection.getBalance(address)) / LAMPORTS_PER_SOL
      ).toFixed(6)} SOL`
    );
  } catch (error) {
    console.error("Error airdropping SOL:", error);
    throw error;
  }
}

// Helper function to ensure an account has enough SOL
async function ensureAccountHasSOL(
  connection: Connection,
  address: PublicKey,
  minBalanceInLamports: number
): Promise<void> {
  const balance = await connection.getBalance(address);

  if (balance < minBalanceInLamports) {
    console.log(
      `Current balance too low. Airdropping ${
        minBalanceInLamports / LAMPORTS_PER_SOL
      } SOL to ${address.toString()}`
    );
    await airdropSol(
      connection,
      address,
      minBalanceInLamports / LAMPORTS_PER_SOL
    );

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

    console.log(
      `New balance: ${(newBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`
    );
  }
}

// Function to send tokens using the Zynk protocol
async function sendTokens(
  program: Program,
  connection: Connection,
  config: PublicKey,
  zynkOpWallet: Keypair,
  tokenMint: PublicKey,
  amount: number,
  partnerOperationalWallet: PublicKey,
  partnerDepositWallet: PublicKey
): Promise<{
  txid: string;
  orderTracker: { publicKey: PublicKey };
}> {
  try {
    console.log("\nSending tokens...");
    console.log("Token Mint:", tokenMint.toString());
    console.log("Amount:", amount);
    console.log(
      "Partner Operational Wallet:",
      partnerOperationalWallet.toString()
    );
    console.log("Partner Deposit Wallet:", partnerDepositWallet.toString());

    // Create a new provider with the zynkOpWallet
    const zynkOpProvider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(zynkOpWallet),
      { commitment: "confirmed", skipPreflight: false }
    );

    // Create a new program instance with the zynkOpWallet as provider
    const programWithZynkOp = new Program(
      program.idl,
      program.programId,
      zynkOpProvider
    );

    console.log("Created new provider with zynkOpWallet as signer");

    // Get or create the operator's token account
    const sourceTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      zynkOpWallet,
      tokenMint,
      zynkOpWallet.publicKey
    );

    console.log("Source Token Account:", sourceTokenAccount.address.toString());

    // Get or create the partner's operational token account for receiving tokens
    const partnerOperationalTokenAccount =
      await getOrCreateAssociatedTokenAccount(
        connection,
        zynkOpWallet,
        tokenMint,
        partnerOperationalWallet
      );

    console.log(
      "Partner Operational Token Account:",
      partnerOperationalTokenAccount.address.toString()
    );

    // Create a new order tracker account
    const orderTracker = Keypair.generate();
    console.log("Order Tracker:", orderTracker.publicKey.toString());

    // Convert amount to u64 with BN.js for proper handling
    const amountBN = new BN(amount.toString());
    console.log("Amount (BN):", amountBN.toString());

    // Print all accounts being sent for debugging
    console.log("\nAccounts being sent:");
    console.log("Config:", config.toString());
    console.log("Zynk Op Wallet:", zynkOpWallet.publicKey.toString());
    console.log("Source Token Account:", sourceTokenAccount.address.toString());
    console.log(
      "Partner Operational Token Account:",
      partnerOperationalTokenAccount.address.toString()
    );
    console.log("Token Program:", TOKEN_PROGRAM_ID.toString());
    console.log("Order Tracker:", orderTracker.publicKey.toString());
    console.log("System Program:", SystemProgram.programId.toString());

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

    console.log("Send transaction successful!");
    console.log("Transaction signature:", tx);

    // Decode and display the Send event
    const decodedEvent = await decodeEvents(connection, tx, true);
    if (decodedEvent && decodedEvent.eventType === "Send") {
      console.log("\n=== SEND EVENT DATA ===");
      console.table(decodedEvent.data);
    }

    console.log("Order tracker account:", orderTracker.publicKey.toString());

    return {
      txid: tx,
      orderTracker: {
        publicKey: orderTracker.publicKey,
      },
    };
  } catch (error) {
    console.error("Error sending tokens:", error);
    throw error;
  }
}

// Function to replenish tokens
async function replenishTokens(
  program: Program,
  connection: Connection,
  config: PublicKey,
  orderTracker: PublicKey,
  depositWallet: Keypair,
  depositTokenAccount: PublicKey,
  paybackWallet: PublicKey,
  orderId: number,
  paybackAmount: number,
  validityDuration: number = 3600 // Default 1 hour validity
): Promise<{ txid: string }> {
  try {
    console.log("\nReplenishing tokens...");
    console.log("Order ID:", orderId);
    console.log("Deposit Wallet:", depositWallet.publicKey.toString());
    console.log("Payback Wallet:", paybackWallet.toString());
    console.log("Deposit Token Account:", depositTokenAccount.toString());
    console.log("Amount:", paybackAmount);

    // Find the payback token account for the deposit token mint
    const depositAccountInfo = await connection.getAccountInfo(
      depositTokenAccount
    );
    if (!depositAccountInfo) {
      throw new Error("Deposit token account not found");
    }

    // Parse the token account to get the mint
    const accountInfo = await connection.getParsedAccountInfo(
      depositTokenAccount
    );
    const parsedInfo = (accountInfo.value?.data as any)?.parsed;
    const tokenMint = new PublicKey(parsedInfo?.info?.mint);
    console.log("Token Mint:", tokenMint.toString());

    // Get or create associated token account for the payback wallet
    const paybackTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      depositWallet, // payer
      tokenMint,
      paybackWallet
    );
    console.log(
      "Payback Token Account:",
      paybackTokenAccount.address.toString()
    );

    // Create a new provider using the deposit wallet as signer
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(depositWallet),
      { commitment: "confirmed" }
    );
    console.log("Created new provider with depositWallet as signer");

    // Create a new program instance with the deposit wallet as provider
    const programWithSigner = new Program(
      program.idl,
      program.programId,
      provider
    );

    // Calculate validity timestamp (current time + validity duration in seconds)
    const now = Math.floor(Date.now() / 1000); // Current Unix timestamp
    const validity = now + validityDuration;
    console.log("Validity timestamp:", validity);

    // Convert amount to BN for the program
    const paybackAmountBN = new BN(paybackAmount);
    console.log("Payback Amount (BN):", paybackAmountBN.toString());

    // Log the accounts being used
    console.log("\nAccounts being sent:");
    console.log("Config:", config.toString());
    console.log("Deposit Token Account:", depositTokenAccount.toString());
    console.log(
      "Payback Token Account:",
      paybackTokenAccount.address.toString()
    );
    console.log("Token Program:", TOKEN_PROGRAM_ID.toString());
    console.log("Deposit Wallet:", depositWallet.publicKey.toString());
    console.log("Order Tracker:", orderTracker.toString());

    // Call the replenish function
    const tx = await programWithSigner.methods
      .replenish(
        new BN(orderId), // order_id
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

    console.log("Replenish transaction successful!");
    console.log("Transaction signature:", tx);

    // Parse and display events
    await parseAndDisplayEvents(connection, tx, program.programId);

    return { txid: tx };
  } catch (error) {
    console.error("Error replenishing tokens:", error);
    throw error;
  }
}

// Function to close an order
async function closeOrder(
  program: Program,
  connection: Connection,
  config: PublicKey,
  orderTracker: PublicKey,
  adminWallet: Keypair,
  orderId: number
): Promise<{ txid: string }> {
  try {
    console.log("\nClosing order...");
    console.log("Order ID:", orderId);
    console.log("Order Tracker:", orderTracker.toString());
    console.log("Admin Wallet:", adminWallet.publicKey.toString());

    // Create a new provider using the admin wallet as signer
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(adminWallet),
      { commitment: "confirmed" }
    );
    console.log("Created new provider with adminWallet as signer");

    // Create a new program instance with the admin wallet as provider
    const programWithSigner = new Program(
      program.idl,
      program.programId,
      provider
    );

    // Log the accounts being used
    console.log("\nAccounts being sent:");
    console.log("Config:", config.toString());
    console.log("Admin:", adminWallet.publicKey.toString());
    console.log("Order Tracker:", orderTracker.toString());
    console.log(
      "System Program:",
      anchor.web3.SystemProgram.programId.toString()
    );

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

    console.log("Close order transaction successful!");
    console.log("Transaction signature:", tx);

    // Parse and display events
    await parseAndDisplayEvents(connection, tx, program.programId);

    return { txid: tx };
  } catch (error) {
    console.error("Error closing order:", error);
    throw error;
  }
}

// Function to display wallet balances
async function displayWalletBalances(
  connection: Connection,
  wallets: Array<{ name: string; pubkey: PublicKey; tokenAccount?: PublicKey }>
) {
  console.log("\n=== WALLET BALANCES ===");

  const balanceData = await Promise.all(
    wallets.map(async (wallet) => {
      const solBalance = await connection.getBalance(wallet.pubkey);

      let tokenBalance = null;
      if (wallet.tokenAccount) {
        try {
          const tokenInfo = await connection.getTokenAccountBalance(
            wallet.tokenAccount
          );
          // Use raw amount for full precision
          tokenBalance =
            parseFloat(tokenInfo.value.amount) / 10 ** tokenInfo.value.decimals;
        } catch (e) {
          tokenBalance = "N/A";
        }
      }

      return {
        "Wallet Name": wallet.name,
        Address: wallet.pubkey.toString(),
        "SOL Balance": `${(solBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
        "Token Balance":
          tokenBalance !== null
            ? tokenBalance.toLocaleString(undefined, {
                maximumFractionDigits: 6,
              })
            : "N/A",
        "Token Account": wallet.tokenAccount
          ? wallet.tokenAccount.toString()
          : "N/A",
      };
    })
  );

  console.table(balanceData);
}

// Function to display order tracker details
async function displayOrderTrackerDetails(
  connection: Connection,
  orderTrackerPubkey: PublicKey
) {
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

    console.log(
      "Raw data (base64):",
      accountInfo.data.slice(0, 40).toString("base64")
    );

    return accountInfo;
  } catch (error) {
    console.error("Error fetching order tracker details:", error);
    console.table({
      "Account Address": orderTrackerPubkey.toString(),
      Status: "Error fetching details",
    });
    return null;
  }
}

// Improved event parser function for Anchor program events
async function parseAndDisplayEvents(
  connection: Connection,
  txSignature: string,
  programId: PublicKey
): Promise<void> {
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
    const programDataLogs = logMessages.filter((log) =>
      log.includes("Program data:")
    );
    if (programDataLogs.length > 0) {
      console.log("\nProgram Data Logs:");
      programDataLogs.forEach((log, i) => {
        const data = log.replace("Program data:", "").trim();
        console.log(`Data ${i + 1}: ${data}`);
      });
    }

    // Extract and display any custom logs that might have been emitted by the program
    const customLogs = logMessages.filter(
      (log) =>
        log.includes("Program log:") &&
        !log.includes("Instruction:") &&
        !log.includes("Program data:") &&
        !log.includes("Program return:")
    );

    if (customLogs.length > 0) {
      console.log("\nCustom Logs:");
      customLogs.forEach((log, i) => {
        const customLog = log.replace("Program log:", "").trim();
        console.log(`Log ${i + 1}: ${customLog}`);
      });
    }
  } catch (error) {
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
async function decodeEvents(
  connection: Connection,
  txSignature: string,
  logToConsole: boolean = true
): Promise<{
  eventType: "Send" | "Replenish" | "ReplenishClosure" | "Unknown";
  data: any;
} | null> {
  try {
    // Fetch the transaction data
    const tx = await connection.getTransaction(txSignature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      if (logToConsole) console.log("Transaction not found");
      return null;
    }

    const logMessages = tx.meta?.logMessages || [];

    // Find the instruction that might have emitted the event
    const sendInstructionIndex = logMessages.findIndex((log) =>
      log.includes("Instruction: Send")
    );

    const replenishInstructionIndex = logMessages.findIndex((log) =>
      log.includes("Instruction: Replenish")
    );

    const closeOrderInstructionIndex = logMessages.findIndex((log) =>
      log.includes("Instruction: CloseOrder")
    );

    // Determine which instruction we're processing
    let instructionType: "Send" | "Replenish" | "CloseOrder" | "Unknown" =
      "Unknown";
    let instructionIndex = -1;

    if (sendInstructionIndex !== -1) {
      instructionType = "Send";
      instructionIndex = sendInstructionIndex;
    } else if (replenishInstructionIndex !== -1) {
      instructionType = "Replenish";
      instructionIndex = replenishInstructionIndex;
    } else if (closeOrderInstructionIndex !== -1) {
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
        console.log(
          `No Program data found for the ${instructionType} instruction`
        );
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
        const partner_deposit_wallet = new PublicKey(
          partnerDepositWalletBytes
        ).toString();

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
      } else if (instructionType === "Replenish") {
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
      } else if (instructionType === "CloseOrder") {
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
    } catch (decodeError) {
      if (logToConsole) {
        console.error("Error decoding Program data:", decodeError);
      }
      return null;
    }
  } catch (error) {
    if (logToConsole)
      console.error("Error fetching transaction details:", error);
    return null;
  }
}

async function main() {
  try {
    // Create wallets from private keys in .env file
    console.log("Loading wallets from environment variables...");

    // Create keypairs from .env or generate if not available
    const adminWallet = createKeypairFromEnv(
      "ADMIN_WALLET_PRIVATE_KEY",
      "Admin wallet"
    );
    const zynkOpWallet = createKeypairFromEnv(
      "ZYNK_OP_WALLET_PRIVATE_KEY",
      "Zynk operator wallet"
    );
    const paybackWallet = createKeypairFromEnv(
      "PAYBACK_WALLET_PRIVATE_KEY",
      "Payback wallet"
    );
    const configAccount = createKeypairFromEnv(
      "CONFIG_ACCOUNT_PRIVATE_KEY",
      "Config account"
    );
    const partnerOperationalWallet = createKeypairFromEnv(
      "PARTNER_OPERATIONAL_WALLET_PRIVATE_KEY",
      "Partner Operational Wallet"
    );
    const partnerDepositWallet = createKeypairFromEnv(
      "PARTNER_DEPOSIT_WALLET_PRIVATE_KEY",
      "Partner Deposit Wallet"
    );

    // Log the generated wallet addresses
    console.log("Admin wallet:", adminWallet.publicKey.toString());
    console.log("Zynk operator wallet:", zynkOpWallet.publicKey.toString());
    console.log("Payback wallet:", paybackWallet.publicKey.toString());
    console.log("Config account:", configAccount.publicKey.toString());
    console.log(
      "Partner Operational Wallet:",
      partnerOperationalWallet.publicKey.toString()
    );
    console.log(
      "Partner Deposit Wallet:",
      partnerDepositWallet.publicKey.toString()
    );

    // Initialize provider with admin wallet
    const wallet = new anchor.Wallet(adminWallet);
    const connection = new Connection(
      process.env.RPC_URL || "http://localhost:8899",
      "confirmed"
    );
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);

    const amount = 0.1;

    const formattedAmountToAirdrop = amount * LAMPORTS_PER_SOL;

    // Airdrop SOL to wallets
    console.log("\nAirdropping SOL to wallets...");
    await ensureAccountHasSOL(
      connection,
      adminWallet.publicKey,
      formattedAmountToAirdrop
    );
    console.log(
      `Airdropped ${amount} SOL to ${adminWallet.publicKey.toString()}`
    );
    await ensureAccountHasSOL(
      connection,
      zynkOpWallet.publicKey,
      formattedAmountToAirdrop
    );
    console.log(
      `Airdropped ${amount} SOL to ${zynkOpWallet.publicKey.toString()}`
    );
    await ensureAccountHasSOL(
      connection,
      partnerOperationalWallet.publicKey,
      formattedAmountToAirdrop
    );
    console.log(
      `Airdropped ${amount} SOL to ${partnerOperationalWallet.publicKey.toString()}`
    );
    await ensureAccountHasSOL(
      connection,
      partnerDepositWallet.publicKey,
      formattedAmountToAirdrop
    );
    console.log(
      `Airdropped ${amount} SOL to ${partnerDepositWallet.publicKey.toString()}`
    );

    // Get program ID
    const programId = getProgramId();
    console.log("\nProgram ID:", programId.toString());

    // Define the program with proper types
    type ConfigAccount = {
      admin: PublicKey;
      zynkOpWallet: PublicKey;
      paybackWallet: PublicKey;
      paused: boolean;
      currentNonce: BN;
    };

    const program = new Program(IDL as any, programId, provider);

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
    const tokenMint = await createMint(
      connection,
      zynkOpWallet,
      zynkOpWallet.publicKey,
      zynkOpWallet.publicKey,
      9
    );
    console.log("Token Mint created:", tokenMint.toString());

    // Create token accounts and mint tokens to the zynkOpWallet
    const zynkOpTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      zynkOpWallet,
      tokenMint,
      zynkOpWallet.publicKey
    );
    console.log(
      "Zynk Operator Token Account:",
      zynkOpTokenAccount.address.toString()
    );

    // Mint tokens to the zynkOpWallet
    await mintTo(
      connection,
      zynkOpWallet,
      tokenMint,
      zynkOpTokenAccount.address,
      zynkOpWallet.publicKey,
      1_000_000_000_000
    );
    console.log("Minted 1,000,000,000,000 tokens to Zynk Operator");

    // Create partner's operational token account
    const partnerOperationalTokenAccount =
      await getOrCreateAssociatedTokenAccount(
        connection,
        zynkOpWallet,
        tokenMint,
        partnerOperationalWallet.publicKey
      );
    console.log(
      "Partner Operational Token Account:",
      partnerOperationalTokenAccount.address.toString()
    );

    // Fetch the config account to confirm it has the correct zynkOpWallet
    const configData = (await program.account.config.fetch(
      configAccount.publicKey
    )) as ConfigAccount;
    console.log("\nConfig Data:");
    console.log("Admin:", configData.admin.toString());
    console.log("Zynk Op Wallet:", configData.zynkOpWallet.toString());
    console.log("Payback Wallet:", configData.paybackWallet.toString());
    console.log("Paused:", configData.paused);
    console.log("Current Nonce:", configData.currentNonce.toString());

    // Check if the zynkOpWallet matches what's in the config
    if (
      configData.zynkOpWallet.toString() !== zynkOpWallet.publicKey.toString()
    ) {
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
        tokenAccount: zynkOpTokenAccount.address,
      },
      { name: "Payback", pubkey: paybackWallet.publicKey },
      {
        name: "Partner Operational",
        pubkey: partnerOperationalWallet.publicKey,
        tokenAccount: partnerOperationalTokenAccount.address,
      },
      { name: "Partner Deposit", pubkey: partnerDepositWallet.publicKey },
    ]);

    // Test send function
    try {
      const result = await sendTokens(
        program,
        connection,
        configAccount.publicKey,
        zynkOpWallet,
        tokenMint,
        1_000_000,
        partnerOperationalWallet.publicKey,
        partnerDepositWallet.publicKey
      );

      console.log("\nFinal Wallet States after Send:");
      await displayWalletBalances(connection, [
        { name: "Admin", pubkey: adminWallet.publicKey },
        {
          name: "Zynk Operator",
          pubkey: zynkOpWallet.publicKey,
          tokenAccount: zynkOpTokenAccount.address,
        },
        { name: "Payback", pubkey: paybackWallet.publicKey },
        {
          name: "Partner Operational",
          pubkey: partnerOperationalWallet.publicKey,
          tokenAccount: partnerOperationalTokenAccount.address,
        },
        { name: "Partner Deposit", pubkey: partnerDepositWallet.publicKey },
        { name: "Order Tracker", pubkey: result.orderTracker.publicKey },
      ]);

      // Display order tracker details
      await displayOrderTrackerDetails(
        connection,
        result.orderTracker.publicKey
      );

      // Create and fund Partner Deposit Token Account
      console.log("\nCreating Partner Deposit Token Account...");
      const partnerDepositTokenAccount =
        await getOrCreateAssociatedTokenAccount(
          connection,
          zynkOpWallet, // payer for account creation
          tokenMint,
          partnerDepositWallet.publicKey
        );
      console.log(
        "Partner Deposit Token Account:",
        partnerDepositTokenAccount.address.toString()
      );

      // Transfer some tokens from Partner Operational to Partner Deposit for testing
      console.log(
        "\nTransferring tokens from Partner Operational to Partner Deposit..."
      );
      await transfer(
        connection,
        partnerOperationalWallet, // payer
        partnerOperationalTokenAccount.address, // source
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
          tokenAccount: zynkOpTokenAccount.address,
        },
        { name: "Payback", pubkey: paybackWallet.publicKey },
        {
          name: "Partner Operational",
          pubkey: partnerOperationalWallet.publicKey,
          tokenAccount: partnerOperationalTokenAccount.address,
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
      const paybackTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        zynkOpWallet, // payer for account creation
        tokenMint,
        paybackWallet.publicKey
      );
      console.log(
        "Payback Token Account:",
        paybackTokenAccount.address.toString()
      );

      // Test replenish function - First replenish with 100 tokens
      console.log("\nTesting Replenish function (First call - 100 tokens)...");
      const replenishResult1 = await replenishTokens(
        program,
        connection,
        configAccount.publicKey,
        result.orderTracker.publicKey,
        partnerDepositWallet,
        partnerDepositTokenAccount.address,
        paybackWallet.publicKey,
        1, // orderId (should be 1 after initialization)
        100, // first replenish of 100 tokens
        7200 // 2 hour validity
      );

      console.log("\nWallet States after First Replenish:");
      await displayWalletBalances(connection, [
        { name: "Admin", pubkey: adminWallet.publicKey },
        {
          name: "Zynk Operator",
          pubkey: zynkOpWallet.publicKey,
          tokenAccount: zynkOpTokenAccount.address,
        },
        {
          name: "Payback",
          pubkey: paybackWallet.publicKey,
          tokenAccount: paybackTokenAccount.address,
        },
        {
          name: "Partner Operational",
          pubkey: partnerOperationalWallet.publicKey,
          tokenAccount: partnerOperationalTokenAccount.address,
        },
        {
          name: "Partner Deposit",
          pubkey: partnerDepositWallet.publicKey,
          tokenAccount: partnerDepositTokenAccount.address,
        },
        { name: "Order Tracker", pubkey: result.orderTracker.publicKey },
      ]);

      // Second replenish with 100 more tokens
      console.log(
        "\nTesting Replenish function (Second call - 100 more tokens)..."
      );
      const replenishResult2 = await replenishTokens(
        program,
        connection,
        configAccount.publicKey,
        result.orderTracker.publicKey,
        partnerDepositWallet,
        partnerDepositTokenAccount.address,
        paybackWallet.publicKey,
        1, // orderId (should be 1 after initialization)
        100, // second replenish of 100 tokens
        7200 // 2 hour validity
      );

      console.log("\nWallet States after Second Replenish:");
      await displayWalletBalances(connection, [
        { name: "Admin", pubkey: adminWallet.publicKey },
        {
          name: "Zynk Operator",
          pubkey: zynkOpWallet.publicKey,
          tokenAccount: zynkOpTokenAccount.address,
        },
        {
          name: "Payback",
          pubkey: paybackWallet.publicKey,
          tokenAccount: paybackTokenAccount.address,
        },
        {
          name: "Partner Operational",
          pubkey: partnerOperationalWallet.publicKey,
          tokenAccount: partnerOperationalTokenAccount.address,
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
      const closeResult = await closeOrder(
        program,
        connection,
        configAccount.publicKey,
        result.orderTracker.publicKey,
        adminWallet,
        1 // orderId (should be 1 after initialization)
      );

      console.log("\nFinal Wallet States after Order Closure:");
      await displayWalletBalances(connection, [
        { name: "Admin", pubkey: adminWallet.publicKey },
        {
          name: "Zynk Operator",
          pubkey: zynkOpWallet.publicKey,
          tokenAccount: zynkOpTokenAccount.address,
        },
        {
          name: "Payback",
          pubkey: paybackWallet.publicKey,
          tokenAccount: paybackTokenAccount.address,
        },
        {
          name: "Partner Operational",
          pubkey: partnerOperationalWallet.publicKey,
          tokenAccount: partnerOperationalTokenAccount.address,
        },
        {
          name: "Partner Deposit",
          pubkey: partnerDepositWallet.publicKey,
          tokenAccount: partnerDepositTokenAccount.address,
        },
      ]);

      // Check if order tracker account still exists
      try {
        const orderTrackerInfo = await connection.getAccountInfo(
          result.orderTracker.publicKey
        );
        if (orderTrackerInfo) {
          console.log(
            "\nWARNING: Order Tracker account still exists after closure"
          );
        } else {
          console.log("\nSuccess: Order Tracker account has been closed");
        }
      } catch (error) {
        console.log("\nSuccess: Order Tracker account has been closed");
      }
    } catch (error) {
      console.error("Error in token operations:", error);
    }

    console.log("\nConfiguration Summary:");
    console.log("Admin:", adminWallet.publicKey.toString());
    console.log("Zynk Operator:", zynkOpWallet.publicKey.toString());
    console.log("Payback Wallet:", paybackWallet.publicKey.toString());
    console.log("Token Mint:", tokenMint.toString());
    console.log(
      "Partner Operational Token Account:",
      partnerOperationalTokenAccount.address.toString()
    );
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// IDL for the smart contract
const IDL = {
  version: "0.1.0",
  name: "zynk_protocol",
  instructions: [
    {
      name: "initialize",
      accounts: [
        {
          name: "config",
          isMut: true,
          isSigner: true,
        },
        {
          name: "admin",
          isMut: true,
          isSigner: true,
        },
        {
          name: "systemProgram",
          isMut: false,
          isSigner: false,
        },
      ],
      args: [
        {
          name: "zynkOpWallet",
          type: "publicKey",
        },
        {
          name: "paybackWallet",
          type: "publicKey",
        },
      ],
    },
    {
      name: "send",
      accounts: [
        {
          name: "config",
          isMut: true,
          isSigner: false,
        },
        {
          name: "zynkOpWallet",
          isMut: true,
          isSigner: true,
        },
        {
          name: "sourceTokenAccount",
          isMut: true,
          isSigner: false,
        },
        {
          name: "partnerOperationalWallet",
          isMut: true,
          isSigner: false,
        },
        {
          name: "tokenProgram",
          isMut: false,
          isSigner: false,
        },
        {
          name: "orderTracker",
          isMut: true,
          isSigner: true,
        },
        {
          name: "systemProgram",
          isMut: false,
          isSigner: false,
        },
      ],
      args: [
        {
          name: "tokenMint",
          type: "publicKey",
        },
        {
          name: "amount",
          type: "u64",
        },
        {
          name: "partnerDepositWallet",
          type: "publicKey",
        },
      ],
    },
    {
      name: "replenish",
      accounts: [
        {
          name: "config",
          isMut: true,
          isSigner: false,
        },
        {
          name: "depositTokenAccount",
          isMut: true,
          isSigner: false,
        },
        {
          name: "paybackTokenAccount",
          isMut: true,
          isSigner: false,
        },
        {
          name: "tokenProgram",
          isMut: false,
          isSigner: false,
        },
        {
          name: "depositWallet",
          isMut: false,
          isSigner: true,
        },
        {
          name: "orderTracker",
          isMut: true,
          isSigner: false,
        },
      ],
      args: [
        {
          name: "orderId",
          type: "u64",
        },
        {
          name: "validity",
          type: "i64",
        },
        {
          name: "paybackAmount",
          type: "u64",
        },
      ],
    },
    {
      name: "closeOrder",
      accounts: [
        {
          name: "config",
          isMut: true,
          isSigner: false,
        },
        {
          name: "admin",
          isMut: true,
          isSigner: true,
        },
        {
          name: "orderTracker",
          isMut: true,
          isSigner: false,
        },
        {
          name: "systemProgram",
          isMut: false,
          isSigner: false,
        },
      ],
      args: [
        {
          name: "orderId",
          type: "u64",
        },
      ],
    },
  ],
  accounts: [
    {
      name: "Config",
      type: {
        kind: "struct",
        fields: [
          {
            name: "admin",
            type: "publicKey",
          },
          {
            name: "zynkOpWallet",
            type: "publicKey",
          },
          {
            name: "paybackWallet",
            type: "publicKey",
          },
          {
            name: "paused",
            type: "bool",
          },
          {
            name: "currentNonce",
            type: "u64",
          },
        ],
      },
    },
    {
      name: "OrderTracker",
      type: {
        kind: "struct",
        fields: [
          {
            name: "orderId",
            type: "u64",
          },
          {
            name: "partnerDepositWallet",
            type: "publicKey",
          },
          {
            name: "bump",
            type: "u8",
          },
        ],
      },
    },
  ],
  errors: [
    {
      code: 6000,
      name: "UnauthorizedSender",
      msg: "Unauthorized sender",
    },
    {
      code: 6001,
      name: "ContractPaused",
      msg: "Contract is paused",
    },
    {
      code: 6002,
      name: "NonceOverflow",
      msg: "Nonce overflow",
    },
    {
      code: 6003,
      name: "UnauthorizedAdmin",
      msg: "Unauthorized admin",
    },
  ],
};

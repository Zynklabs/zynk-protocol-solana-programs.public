import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { readFileSync } from "fs";

config();

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

// Get program ID from keypair
const PROGRAM_ID = getProgramId();
console.log("Program ID:", PROGRAM_ID.toString());

// Helper function to create associated token account
async function getOrCreateAssociatedTokenAccount(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
) {
  const associatedTokenAddress = await anchor.utils.token.associatedAddress({
    mint: mint,
    owner: owner,
  });

  try {
    await connection.getAccountInfo(associatedTokenAddress);
    return associatedTokenAddress;
  } catch {
    return await createAssociatedTokenAccount(connection, payer, mint, owner);
  }
}

// Helper function to airdrop SOL
async function requestAirdrop(
  connection: Connection,
  address: PublicKey,
  amount: number
) {
  const signature = await connection.requestAirdrop(address, amount);
  await connection.confirmTransaction(signature);
}

// Helper function to ensure an account has enough SOL
async function ensureAccountHasSOL(
  connection: Connection,
  address: PublicKey,
  minBalance: number = LAMPORTS_PER_SOL // 1 SOL by default
) {
  const balance = await connection.getBalance(address);
  if (balance < minBalance) {
    console.log(
      `Airdropping ${
        minBalance / LAMPORTS_PER_SOL
      } SOL to ${address.toString()}`
    );
    await requestAirdrop(connection, address, minBalance);
  }
}

async function main() {
  // Initialize connection to localhost
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");

  // Create all necessary wallets
  console.log("Creating wallets...");
  const zynkOpWallet = Keypair.generate(); // operator wallet
  const partnerDepositWallet = Keypair.generate(); // partner deposit wallet for replenish
  const orderTracker = Keypair.generate(); // order tracker account

  console.log("Zynk operator wallet:", zynkOpWallet.publicKey.toString());
  console.log(
    "Partner deposit wallet:",
    partnerDepositWallet.publicKey.toString()
  );
  console.log("Order tracker:", orderTracker.publicKey.toString());

  // Initialize provider with zynk operator wallet
  const wallet = new anchor.Wallet(zynkOpWallet);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  // Airdrop SOL to all wallets
  console.log("\nAirdropping SOL to wallets...");

  // Zynk operator needs more SOL as they'll be creating token mint and accounts
  await ensureAccountHasSOL(
    connection,
    zynkOpWallet.publicKey,
    2 * LAMPORTS_PER_SOL
  );
  await ensureAccountHasSOL(connection, partnerDepositWallet.publicKey);
  await ensureAccountHasSOL(
    connection,
    orderTracker.publicKey,
    LAMPORTS_PER_SOL / 2
  );

  // Print balances
  const opBalance = await connection.getBalance(zynkOpWallet.publicKey);
  const partnerBalance = await connection.getBalance(
    partnerDepositWallet.publicKey
  );
  console.log(
    `Zynk operator wallet balance: ${opBalance / LAMPORTS_PER_SOL} SOL`
  );
  console.log(
    `Partner deposit wallet balance: ${partnerBalance / LAMPORTS_PER_SOL} SOL`
  );

  // Create program interface
  const program = new Program(IDL as any, PROGRAM_ID, provider);

  try {
    // Create a new token mint
    console.log("\nCreating token mint...");
    const tokenMint = await createMint(
      connection,
      zynkOpWallet,
      zynkOpWallet.publicKey,
      zynkOpWallet.publicKey,
      9 // 9 decimals
    );
    console.log("Token mint created:", tokenMint.toString());

    // Create token accounts
    console.log("\nCreating token accounts...");

    // Create and fund source token account (owned by zynk operator)
    const sourceTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      zynkOpWallet,
      tokenMint,
      zynkOpWallet.publicKey
    );
    console.log("Source token account:", sourceTokenAccount.toString());

    // Create partner operational token account
    const partnerOperationalWallet = await getOrCreateAssociatedTokenAccount(
      connection,
      zynkOpWallet,
      tokenMint,
      partnerDepositWallet.publicKey
    );
    console.log(
      "Partner operational wallet:",
      partnerOperationalWallet.toString()
    );

    // Mint some tokens to the source account
    console.log("\nMinting tokens to source account...");
    await mintTo(
      connection,
      zynkOpWallet,
      tokenMint,
      sourceTokenAccount,
      zynkOpWallet,
      2000000 // Mint 2 tokens (assuming 9 decimals)
    );

    // Get the protocol's config address (you should have this from initialization)
    const configAddress = new PublicKey("YOUR_CONFIG_ADDRESS"); // Replace this with your actual config address

    console.log("\nSending tokens...");
    const amount = new anchor.BN(1000000); // 1 token (assuming 9 decimals)
    await program.methods
      .send(tokenMint, amount, partnerDepositWallet.publicKey)
      .accounts({
        config: configAddress,
        zynkOpWallet: zynkOpWallet.publicKey,
        sourceTokenAccount: sourceTokenAccount,
        partnerOperationalWallet: partnerOperationalWallet,
        tokenProgram: TOKEN_PROGRAM_ID,
        orderTracker: orderTracker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([orderTracker, zynkOpWallet])
      .rpc();

    console.log("Tokens sent!");
    console.log("Order Tracker:", orderTracker.publicKey.toString());

    // Create payback token account
    const paybackTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      zynkOpWallet,
      tokenMint,
      zynkOpWallet.publicKey // zynk operator is the payback wallet for this example
    );
    console.log("\nPayback token account:", paybackTokenAccount.toString());

    // Create deposit token account
    const depositTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      zynkOpWallet,
      tokenMint,
      partnerDepositWallet.publicKey
    );

    // Mint some tokens to the deposit account for replenishment
    await mintTo(
      connection,
      zynkOpWallet,
      tokenMint,
      depositTokenAccount,
      zynkOpWallet,
      1000000 // Same amount for replenishment
    );

    console.log("\nReplenishing tokens...");
    const orderId = new anchor.BN(1); // The order ID from the send operation
    const validity = new anchor.BN(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
    const paybackAmount = new anchor.BN(1000000);

    await program.methods
      .replenish(orderId, validity, paybackAmount)
      .accounts({
        config: configAddress,
        depositTokenAccount: depositTokenAccount,
        paybackTokenAccount: paybackTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        depositWallet: partnerDepositWallet.publicKey,
        orderTracker: orderTracker.publicKey,
      })
      .signers([partnerDepositWallet])
      .rpc();

    console.log("Tokens replenished!");

    // Save wallet info to file for future reference
    console.log("\nWallet Information Summary:");
    console.log("----------------------------");
    console.log("Zynk Operator Wallet:", zynkOpWallet.publicKey.toString());
    console.log(
      "Partner Deposit Wallet:",
      partnerDepositWallet.publicKey.toString()
    );
    console.log("Token Mint:", tokenMint.toString());
    console.log("Source Token Account:", sourceTokenAccount.toString());
    console.log(
      "Partner Operational Wallet:",
      partnerOperationalWallet.toString()
    );
    console.log("Payback Token Account:", paybackTokenAccount.toString());
    console.log("Deposit Token Account:", depositTokenAccount.toString());
    console.log("Order Tracker:", orderTracker.publicKey.toString());
  } catch (error) {
    console.error("Error:", error);
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
      name: "setPauseState",
      accounts: [
        {
          name: "config",
          isMut: true,
          isSigner: false,
        },
        {
          name: "admin",
          isMut: false,
          isSigner: true,
        },
      ],
      args: [
        {
          name: "paused",
          type: "bool",
        },
      ],
    },
    {
      name: "transferAdmin",
      accounts: [
        {
          name: "config",
          isMut: true,
          isSigner: false,
        },
        {
          name: "admin",
          isMut: false,
          isSigner: true,
        },
      ],
      args: [
        {
          name: "newAdmin",
          type: "publicKey",
        },
      ],
    },
    {
      name: "updatePaybackWallet",
      accounts: [
        {
          name: "config",
          isMut: true,
          isSigner: false,
        },
        {
          name: "admin",
          isMut: false,
          isSigner: true,
        },
      ],
      args: [
        {
          name: "newPaybackWallet",
          type: "publicKey",
        },
      ],
    },
    {
      name: "updateZynkOpWallet",
      accounts: [
        {
          name: "config",
          isMut: true,
          isSigner: false,
        },
        {
          name: "admin",
          isMut: false,
          isSigner: true,
        },
      ],
      args: [
        {
          name: "newZynkOpWallet",
          type: "publicKey",
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
        ],
      },
    },
  ],
  events: [
    {
      name: "Replenish",
      fields: [
        {
          name: "orderId",
          type: "u64",
          index: false,
        },
        {
          name: "token",
          type: "publicKey",
          index: false,
        },
        {
          name: "amount",
          type: "u64",
          index: false,
        },
        {
          name: "status",
          type: "bool",
          index: false,
        },
        {
          name: "chainId",
          type: "u64",
          index: false,
        },
      ],
    },
    {
      name: "ReplenishClosure",
      fields: [
        {
          name: "orderId",
          type: "u64",
          index: false,
        },
        {
          name: "timestamp",
          type: "i64",
          index: false,
        },
      ],
    },
    {
      name: "Send",
      fields: [
        {
          name: "orderId",
          type: "u64",
          index: false,
        },
        {
          name: "token",
          type: "publicKey",
          index: false,
        },
        {
          name: "partnerDepositWallet",
          type: "publicKey",
          index: false,
        },
        {
          name: "amount",
          type: "u64",
          index: false,
        },
        {
          name: "chainId",
          type: "u64",
          index: false,
        },
      ],
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
    {
      code: 6004,
      name: "InvalidOrderId",
      msg: "Invalid order ID",
    },
    {
      code: 6005,
      name: "ValidityExpired",
      msg: "Validity period expired",
    },
    {
      code: 6006,
      name: "InvalidTokenMint",
      msg: "Invalid token mint",
    },
    {
      code: 6007,
      name: "ValidityMustBeFuture",
      msg: "Validity must be in future",
    },
    {
      code: 6008,
      name: "AmountMustBePositive",
      msg: "Amount must be positive",
    },
  ],
};

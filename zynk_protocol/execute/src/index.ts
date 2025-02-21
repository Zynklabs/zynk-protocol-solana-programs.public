import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { config } from "dotenv";
import * as fs from "fs";
import * as os from "os";

config();

// Program ID from the smart contract
const PROGRAM_ID = new PublicKey(
  "GTN8hxXgSS34ChaDWDiyKp9R9oa6DWDTGyJotL6uou46"
);

function loadWalletKey(): Keypair {
  const home = os.homedir();
  const configFile = fs.readFileSync(`${home}/.config/solana/id.json`, "utf-8");
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(configFile)));
}

async function main() {
  // Initialize connection to devnet
  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  // Initialize provider with your wallet
  const wallet = new anchor.Wallet(loadWalletKey());
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  // print balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Wallet balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  // Create program interface
  const program = new Program(IDL as any, PROGRAM_ID, provider);

  try {
    // Example: Initialize token manager
    const tokenManager = Keypair.generate();

    console.log("Initializing token manager...");
    await program.methods
      .initialize()
      .accounts({
        tokenManager: tokenManager.publicKey,
        admin: wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([tokenManager])
      .rpc();

    console.log("Token manager initialized!");
    console.log("Token Manager address:", tokenManager.publicKey.toString());

    // Example: Add a token to whitelist
    const tokenToAdd = new PublicKey("11111111111111111111111111111111");

    console.log("Adding token to whitelist...");
    await program.methods
      .addToken(tokenToAdd)
      .accounts({
        tokenManager: tokenManager.publicKey,
        admin: wallet.publicKey,
      })
      .rpc();

    console.log("Token added to whitelist!");

    // Example: Remove a token from whitelist
    console.log("Removing token from whitelist...");
    await program.methods
      .removeToken(tokenToAdd)
      .accounts({
        tokenManager: tokenManager.publicKey,
        admin: wallet.publicKey,
      })
      .rpc();

    console.log("Token removed from whitelist!");

    // Example: Update admin
    const newAdmin = Keypair.generate();
    console.log("Updating admin...");
    await program.methods
      .updateAdmin(newAdmin.publicKey)
      .accounts({
        tokenManager: tokenManager.publicKey,
        admin: wallet.publicKey,
      })
      .rpc();

    console.log("Admin updated to:", newAdmin.publicKey.toString());
  } catch (error) {
    console.error("Error:", error);
  }
}

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

main().catch(console.error);

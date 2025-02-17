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
  name: "zynk_token_manager",
  instructions: [
    {
      name: "initialize",
      accounts: [
        {
          name: "tokenManager",
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
      args: [],
    },
    {
      name: "addToken",
      accounts: [
        {
          name: "tokenManager",
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
          name: "token",
          type: "publicKey",
        },
      ],
    },
    {
      name: "removeToken",
      accounts: [
        {
          name: "tokenManager",
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
          name: "token",
          type: "publicKey",
        },
      ],
    },
    {
      name: "updateAdmin",
      accounts: [
        {
          name: "tokenManager",
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
  ],
  accounts: [
    {
      name: "TokenManager",
      type: {
        kind: "struct",
        fields: [
          {
            name: "admin",
            type: "publicKey",
          },
          {
            name: "tokens",
            type: {
              vec: "publicKey",
            },
          },
        ],
      },
    },
  ],
};

main().catch(console.error);

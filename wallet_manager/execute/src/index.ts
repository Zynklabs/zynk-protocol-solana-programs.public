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
  "FC5bGixHvLLTY4YzMw2LHNozj9JnnEeX3AUiKtcVDuvY"
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
    // Example: Initialize wallet manager
    const walletManager = Keypair.generate();
    console.log(
      "New wallet manager address:",
      walletManager.publicKey.toString()
    );

    console.log("Initializing wallet manager...");
    // Space calculation from the Rust program:
    // 8 (discriminator) + 32 (admin) + 4 (vec len) + 1000 (deposit mappings) + 4 (vec len) + 1000 (operational mappings)
    const space = 2048;

    const rent = await connection.getMinimumBalanceForRentExemption(space);
    console.log(
      `Required SOL for rent exemption: ${rent / LAMPORTS_PER_SOL} SOL`
    );

    // First create the account
    const createAccountIx = anchor.web3.SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: walletManager.publicKey,
      space: space,
      lamports: rent,
      programId: program.programId,
    });

    // Then initialize it
    const tx = await program.methods
      .initialize()
      .accounts({
        walletManager: walletManager.publicKey,
        admin: wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([walletManager])
      .preInstructions([createAccountIx])
      .rpc();

    console.log("Transaction signature:", tx);
    console.log("Wallet manager initialized!");
    console.log("Wallet Manager address:", walletManager.publicKey.toString());

    // Example: Add a deposit wallet
    const partnerId = "partner1";
    const depositWallet = Keypair.generate();

    console.log("Adding deposit wallet...");
    await program.methods
      .addDepositWallet(partnerId, depositWallet.publicKey)
      .accounts({
        walletManager: walletManager.publicKey,
        admin: wallet.publicKey,
      })
      .rpc();

    console.log("Deposit wallet added!");

    // Example: Add an operational wallet
    const operationalWallet = Keypair.generate();

    console.log("Adding operational wallet...");
    await program.methods
      .addOperationalWallet(partnerId, operationalWallet.publicKey)
      .accounts({
        walletManager: walletManager.publicKey,
        admin: wallet.publicKey,
      })
      .rpc();

    console.log("Operational wallet added!");

    // Example: Remove deposit wallet
    console.log("Removing deposit wallet...");
    await program.methods
      .removeDepositWallet(partnerId)
      .accounts({
        walletManager: walletManager.publicKey,
        admin: wallet.publicKey,
      })
      .rpc();

    console.log("Deposit wallet removed!");

    // Example: Remove operational wallet
    console.log("Removing operational wallet...");
    await program.methods
      .removeOperationalWallet(partnerId)
      .accounts({
        walletManager: walletManager.publicKey,
        admin: wallet.publicKey,
      })
      .rpc();

    console.log("Operational wallet removed!");

    // Example: Update admin
    const newAdmin = Keypair.generate();
    console.log("Updating admin...");
    await program.methods
      .updateAdmin(newAdmin.publicKey)
      .accounts({
        walletManager: walletManager.publicKey,
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
  name: "zynk_wallet_manager",
  instructions: [
    {
      name: "addDepositWallet",
      accounts: [
        {
          name: "walletManager",
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
          name: "identifier",
          type: "string",
        },
        {
          name: "depositWallet",
          type: "publicKey",
        },
      ],
    },
    {
      name: "addOperationalWallet",
      accounts: [
        {
          name: "walletManager",
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
          name: "identifier",
          type: "string",
        },
        {
          name: "operationalWallet",
          type: "publicKey",
        },
      ],
    },
    {
      name: "initialize",
      accounts: [
        {
          name: "walletManager",
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
      name: "removeDepositWallet",
      accounts: [
        {
          name: "walletManager",
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
          name: "identifier",
          type: "string",
        },
      ],
    },
    {
      name: "removeOperationalWallet",
      accounts: [
        {
          name: "walletManager",
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
          name: "identifier",
          type: "string",
        },
      ],
    },
    {
      name: "updateAdmin",
      accounts: [
        {
          name: "walletManager",
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
      name: "WalletManager",
      type: {
        kind: "struct",
        fields: [
          {
            name: "admin",
            type: "publicKey",
          },
          {
            name: "partnerDepositWallets",
            type: {
              array: [
                {
                  defined: "DepositMapping",
                },
                32,
              ],
            },
          },
          {
            name: "partnerOperationalWallets",
            type: {
              array: [
                {
                  defined: "OperationalMapping",
                },
                32,
              ],
            },
          },
        ],
      },
    },
  ],
  types: [
    {
      name: "DepositMapping",
      type: {
        kind: "struct",
        fields: [
          {
            name: "identifier",
            type: "string",
          },
          {
            name: "depositWallet",
            type: "publicKey",
          },
        ],
      },
    },
    {
      name: "OperationalMapping",
      type: {
        kind: "struct",
        fields: [
          {
            name: "identifier",
            type: "string",
          },
          {
            name: "operationalWallet",
            type: "publicKey",
          },
        ],
      },
    },
  ],
};

main().catch(console.error);

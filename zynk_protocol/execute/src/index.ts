import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { readFileSync } from "fs";

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

// Function to create and initialize an SPL token
async function createSPLToken(
  connection: Connection,
  payer: Keypair,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
  decimals: number,
  initialSupply?: number
): Promise<{
  mint: PublicKey;
  tokenAccount?: PublicKey;
}> {
  try {
    console.log("Creating SPL Token...");

    // Create the token mint
    const mint = await createMint(
      connection,
      payer,
      mintAuthority,
      freezeAuthority,
      decimals
    );
    console.log("Token Mint created:", mint.toString());

    // If initial supply is specified, create a token account and mint tokens
    if (initialSupply) {
      // Create token account for mint authority
      const tokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        mintAuthority
      );
      console.log("Token Account created:", tokenAccount.address.toString());

      // Mint initial supply
      await mintTo(
        connection,
        payer,
        mint,
        tokenAccount.address,
        payer, // mint authority
        initialSupply * 10 ** decimals // adjust for decimals
      );
      console.log(
        `Minted ${initialSupply} tokens to ${tokenAccount.address.toString()}`
      );

      return { mint, tokenAccount: tokenAccount.address };
    }

    return { mint };
  } catch (error) {
    console.error("Error creating SPL token:", error);
    throw error;
  }
}

async function main() {
  // Initialize connection to localhost
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");

  // Create admin wallet (this will be the deployer)
  console.log("Creating wallets...");
  const adminWallet = Keypair.generate();
  const zynkOpWallet = Keypair.generate();
  const paybackWallet = Keypair.generate();
  const configAccount = Keypair.generate();

  console.log("Admin wallet:", adminWallet.publicKey.toString());
  console.log("Zynk operator wallet:", zynkOpWallet.publicKey.toString());
  console.log("Payback wallet:", paybackWallet.publicKey.toString());
  console.log("Config account:", configAccount.publicKey.toString());

  // Initialize provider with admin wallet
  const wallet = new anchor.Wallet(adminWallet);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  // Airdrop SOL to admin wallet
  console.log("\nAirdropping SOL to admin wallet...");
  await ensureAccountHasSOL(
    connection,
    adminWallet.publicKey,
    2 * LAMPORTS_PER_SOL
  );

  // Create program interface
  const PROGRAM_ID = getProgramId();
  console.log("\nProgram ID:", PROGRAM_ID.toString());
  const program = new Program(IDL as any, PROGRAM_ID, provider);

  try {
    // Initialize the protocol
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

    // Create an SPL token for testing
    console.log("\nCreating test token...");
    const { mint, tokenAccount } = await createSPLToken(
      connection,
      adminWallet,
      adminWallet.publicKey,
      null, // no freeze authority
      9, // 9 decimals like most SPL tokens
      1000000 // 1 million initial supply
    );

    console.log("\nConfiguration Summary:");
    console.log("----------------------------");
    console.log("Admin Wallet:", adminWallet.publicKey.toString());
    console.log("Zynk Operator Wallet:", zynkOpWallet.publicKey.toString());
    console.log("Payback Wallet:", paybackWallet.publicKey.toString());
    console.log("Config Account:", configAccount.publicKey.toString());
    console.log("Program ID:", PROGRAM_ID.toString());
    console.log("\nToken Information:");
    console.log("----------------------------");
    console.log("Token Mint:", mint.toString());
    console.log("Admin Token Account:", tokenAccount?.toString());
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

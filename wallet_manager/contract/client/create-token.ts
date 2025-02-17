import * as web3 from "@solana/web3.js";
import * as token from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";

async function main() {
  // Connect to devnet
  const connection = new web3.Connection(
    web3.clusterApiUrl("devnet"),
    "confirmed"
  );

  // Get wallet from local keypair
  const wallet = anchor.Wallet.local();
  console.log("Creating token with authority:", wallet.publicKey.toString());

  try {
    // Create new mint
    const mint = await token.createMint(
      connection,
      wallet.payer,
      wallet.publicKey, // mint authority
      wallet.publicKey, // freeze authority
      9 // decimals
    );

    console.log("Token created successfully!");
    console.log("Token Mint Address:", mint.toString());
    console.log(
      "View on Solana Explorer:",
      `https://explorer.solana.com/address/${mint.toString()}?cluster=devnet`
    );

    // Create associated token account for the wallet
    const tokenAccount = await token.createAssociatedTokenAccount(
      connection,
      wallet.payer,
      mint,
      wallet.publicKey
    );

    console.log("\nToken Account created:", tokenAccount.toString());

    // Mint some tokens to the wallet
    const mintAmount = 1000000000; // 1000 tokens with 9 decimals
    await token.mintTo(
      connection,
      wallet.payer,
      mint,
      tokenAccount,
      wallet.payer,
      mintAmount
    );

    console.log(
      `\nMinted ${mintAmount / 1e9} tokens to:`,
      tokenAccount.toString()
    );
  } catch (error) {
    console.error("Error creating token:", error);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);

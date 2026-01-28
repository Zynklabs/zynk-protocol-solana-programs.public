import * as anchor from "@coral-xyz/anchor";
import * as web3 from "@solana/web3.js";
import type { ZynkCore } from "../target/types/zynk_core";

// Configure the client to use the local cluster
anchor.setProvider(anchor.AnchorProvider.env());

const program = anchor.workspace.ZynkCore as anchor.Program<ZynkCore>;

// Client
async function main() {
  console.log("My address:", program.provider.publicKey.toString());
  const balance = await program.provider.connection.getBalance(program.provider.publicKey);
  console.log(`My balance: ${balance / web3.LAMPORTS_PER_SOL} SOL`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);

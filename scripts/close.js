import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { execSync } from "child_process";
import { loadKeypair } from "./utils.js";

config();

const managerKeypairPath = "manager-keypair.json"
const programId = "EMNqHAmpFnLsQdmoDbcDYJe9fny6Q42ALoNdH1Z5XZ3e"

async function close() {
  const { keyPair: manager, raw } = loadKeypair("manager", { getRawBytes: true })
  console.log("Manager wallet:", manager.publicKey.toBase58());
  
  writeFileSync(managerKeypairPath, JSON.stringify(raw));
  
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log(`Using RPC URL: ${rpcUrl}`);

  console.log("Using transient manager keypair");
  const _ = JSON.parse(
      readFileSync(managerKeypairPath, "utf-8")
  );

  try {
    console.log("Closing program...");
    // For simplicity, we'll use Solana CLI to deploy
    // This is more reliable than using BpfLoader in code
    try {
      const closeCommand = `solana program close ${programId} --keypair ${managerKeypairPath} --bypass-warning --url ${rpcUrl}`
      //  --program-id ${programKeypairPath} contracts/target/deploy/zynk_protocol.so --url ${rpcUrl}`;
      console.log(`Running: ${closeCommand}`);

      const closeOutput = execSync(closeCommand, { encoding: "utf8" });
      console.log(closeOutput);
    } catch (error) {
      console.error("Error closing program:", error);
      throw new Error("Failed to close program using Solana CLI.");
    }
  } catch (error) {
    console.error("Error checking program account:", error);
    throw error;
  }
  
  unlinkSync(managerKeypairPath)   
}

if (import.meta && import.meta.url && process.argv && process.argv[1]) {
  const url = new URL(import.meta.url);
  const filePath = fileURLToPath(url);

  if (filePath === process.argv[1]) {
    close()
      .then(() => {
        console.log("Program closed successfully!");
        process.exit(0);
      })
      .catch((error) => {
        console.error("Program closing failed:", error);
        process.exit(1);
      });
  }
}
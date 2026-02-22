import { Keypair } from "@solana/web3.js";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { config } from "dotenv";

config();

import { loadKeypair } from "./utils.js";

const programName = "zynk_orbit"
const programKeypairName = "ZYNKyAqtYQhU838QStZaVevZYMeWBrtDiRdDDxjpLXU"
const managerKeypairPath = "manager-keypair.json"

export async function deploy() {
  try {
    const { keyPair: manager, raw } = loadKeypair("manager", { getRawBytes: true })
    console.log("Manager wallet:", manager.publicKey.toBase58());
    
    writeFileSync(managerKeypairPath, JSON.stringify(raw));
    
    const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    console.log(`Using RPC URL: ${rpcUrl}`);

    console.log("\nDeploying program to blockchain...");

    const programPath = `target/deploy/${programName}.so`
    const programData = readFileSync(programPath);
    console.log(`Program size: ${programData.length} bytes`);

    const programKeypairPath = `target/deploy/${ programKeypairName?.length ? programKeypairName : programName + "-keypair" }.json`
    const programKeypairData = JSON.parse(readFileSync(programKeypairPath, "utf-8"));
    const programKeypair = Keypair.fromSecretKey(new Uint8Array(programKeypairData));

    const programId = programKeypair.publicKey;
    console.log("Program ID:", programId.toBase58());

    console.log("Using transient manager keypair");
    const _ = JSON.parse(
      readFileSync(managerKeypairPath, "utf-8")
    );
    
    try {
      console.log("Deploying program...");
      // For simplicity, we'll use Solana CLI to deploy
      // This is more reliable than using BpfLoader in code
      try {
        const deployCommand = `solana program deploy --keypair ${managerKeypairPath} --program-id ${programKeypairPath} ${programPath} --url ${rpcUrl}`;
        console.log(`Running: ${deployCommand}`);

        const deployOutput = execSync(deployCommand, { encoding: "utf8" });
        console.log(deployOutput);
      } catch (error) {
        console.error("Error deploying program:", error);
        throw new Error("Failed to deploy program using Solana CLI.");
      }
    } catch (error) {
      console.error("Error checking program account:", error);
      throw error;
    }

    unlinkSync(managerKeypairPath)   
  } catch (error) {
    console.error("Error in deployment:", error);
    throw error;
  }
}

// Run deployment if this file is executed directly
if (import.meta && import.meta.url && process.argv && process.argv[1]) {
  const url = new URL(import.meta.url);
  const filePath = fileURLToPath(url);

  if (filePath === process.argv[1]) {
    deploy()
      .then(() => {
        console.log("Deployment completed successfully!");
        process.exit(0);
      })
      .catch((error) => {
        console.error("Deployment failed:", error);
        process.exit(1);
      });
  }
}

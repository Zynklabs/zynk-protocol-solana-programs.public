import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ASSETS } from "./constants.js";
import { getConnector } from "./utils.js";

const {
  ZYNK_OP_WALLET_PUBLIC_KEY,
  ADMIN_MULTISIG_VAULT_PUBLIC_KEY,
  GUARDIAN_MULTISIG_VAULT_PUBLIC_KEY
} = process.env

const forEURC = false

const { keyPair: manager, program, provider } = getConnector()

const zynkOpWalletPubkey = new PublicKey(ZYNK_OP_WALLET_PUBLIC_KEY);

const adminWalletPubkey = new PublicKey(ADMIN_MULTISIG_VAULT_PUBLIC_KEY);

const guardianWalletPubkey = new PublicKey(GUARDIAN_MULTISIG_VAULT_PUBLIC_KEY);

const [configPda, configBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  program.programId
);

let configData;
try {
  configData = await program.account.config.fetch(configPda);
  console.log("\nConfig account already exists. Skipping initialization.");
} catch (error) {
  const whitelistedTokens = Object.entries(ASSETS).filter(([k, _]) => forEURC ? k === "EURC" : k != "EURC").map(([_, v]) => new PublicKey(v))
  console.log("whitelistedTokens", whitelistedTokens)
  
  await program.methods
    .initialize(zynkOpWalletPubkey, adminWalletPubkey, guardianWalletPubkey, whitelistedTokens)
    .accounts({
      config: configPda,
      manager: manager.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([manager])
    .instruction()
    .then((instruction) => {
      instruction.keys.find((key) =>
          key.pubkey.equals(configPda)
      ).isSigner = false;
  
      // Create and send transaction
      const transaction = new Transaction().add(instruction);
      return provider.sendAndConfirm(transaction, [manager]);
    });
  
  console.log("Protocol initialized successfully!");
  configData = await program.account.config.fetch(configPda);
}

console.log("** Config Data **");
console.table([
  { Account: "Program", Address: program.programId.toBase58() },
  { Account: "Config", Address: configPda.toBase58() },
  { Account: "ZOW", Address: configData.zynkOpWallet.toBase58() },
  { Account: "Admin", Address: configData.admin.toBase58() },
  { Account: "Manager", Address: configData.manager.toBase58() },
  { Account: "Guardian", Address: configData.guardian.toBase58() },
])
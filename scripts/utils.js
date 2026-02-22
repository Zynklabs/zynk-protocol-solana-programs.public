import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import IDL from "../target/idl/zynk_core.json" with { type: "json" }; 
import { rpcUrl } from "./constants.js";


function loadKeypair(walletKey = "manager", options = { getRawBytes: false }) {
    const envName = `${walletKey.toUpperCase()}_WALLET_PRIVATE_KEY`
    const raw = process.env[envName];
    if (!raw) throw new Error(`${envName} not set`);

    const secretKey = bs58.decode(raw.trim());
    const keyPair = Keypair.fromSecretKey(secretKey);
    
    if (options?.getRawBytes) {
      return { keyPair, raw: Array.from(secretKey) }
    }
    
    return keyPair;
}

function getConnector(walletKey = "manager", idl = IDL) {
    const keyPair = loadKeypair(walletKey)
    const wallet = new Wallet(keyPair)

    const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed")
    
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    
    const program = new Program(idl, provider);

    return { program, provider, keyPair, connection }
}


const { program } = getConnector("manager")

const [configPDA, _] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
);


async function readConfig() {
    const configAccount = await program.account.config.fetch(configPDA);
    console.log("current config", configAccount)

    return configAccount
}

export { loadKeypair, readConfig, getConnector, configPDA }
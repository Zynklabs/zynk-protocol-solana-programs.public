import { AnchorProvider, Program, setProvider } from "@project-serum/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58"
import { IDL } from "./idl.js"
import { programId, rpcUrl } from "./constants.js";
import { Wallet } from "@sqds/sdk";


function loadKeypair(walletKey) {
    const envName = `${walletKey.toUpperCase()}_WALLET_PRIVATE_KEY`
    const raw = process.env[envName];
    if (!raw) throw new Error(`${envName} not set`);

    const secretKey = bs58.decode(raw.trim());
    return Keypair.fromSecretKey(secretKey);
}

function getConnector(walletKey = "admin") {
    const keyPair = loadKeypair(walletKey)
    const wallet = new Wallet(keyPair)

    const connection = new Connection(rpcUrl, "confirmed")
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    setProvider(provider);

    const program = new Program(IDL, programId, provider);

    return { program, provider, keyPair, connection }
}


const { program } = getConnector("admin")

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
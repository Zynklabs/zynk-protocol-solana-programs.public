
import { configDotenv } from "dotenv";
configDotenv()

const rpcUrl = process.env.RPC_URL
const zynkOpWalletPubKey = process.env.ZYNK_OP_WALLET_PUBLIC_KEY
const guardianPubKey = process.env.GUARDIAN_WALLET_PUBLIC_KEY
const managerPubKey = process.env.MANAGER_WALLET_PUBLIC_KEY
const adminPubKey = process.env.ADMIN_WALLET_PUBLIC_KEY
const programId = process.env.PROGRAM_ID

const guardianMultisigPubKey = process.env.GUARDIAN_MULTISIG_PUBLIC_KEY
const guardianMultisigVaultPubKey = process.env.GUARDIAN_MULTISIG_VAULT_PUBLIC_KEY

const adminMultisigPubKey = process.env.ADMIN_MULTISIG_PUBLIC_KEY
const adminMultisigVaultPubKey = process.env.ADMIN_MULTISIG_VAULT_PUBLIC_KEY


const ASSETS = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  PyUSD: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
  // USAT: Either not available or not verified yet.,
  USD1: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
  RLUSD: "FMHpvrXeNPZieGVQTELkvVPRZRXMNgpMoSSW8wBc2v31",
  EURC: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr"
}
// 
// const ASSETS = {
//   USDC: "Kk4sTVi1FMABcKLGjvhXUmXhzoCk8M5xP9LSrwJi8P6",
//   USDT: "7R3t9Fpfxr7aBurx4jC5CxVbEHeABbqY1jMHTLrjHUPH"
// }


export { ASSETS, zynkOpWalletPubKey, managerPubKey, programId, rpcUrl, guardianMultisigPubKey, adminMultisigPubKey, adminPubKey, guardianPubKey, guardianMultisigVaultPubKey, adminMultisigVaultPubKey }
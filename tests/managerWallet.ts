import { Keypair } from "@solana/web3.js";

/**
 * Manager wallet keypair for program instructions that require manager_wallet signer.
 * Public key: GRCEDQxpSi7QXHxTEUnh6MocAp6zx6FsgRvekZph91Bk
 */
const MANAGER_PRIVATE_KEY = new Uint8Array([
  137, 245, 0, 203, 140, 69, 167, 75, 64, 61, 120, 101, 103, 251, 38, 122,
  225, 34, 198, 214, 112, 41, 120, 218, 71, 114, 149, 58, 77, 121, 182, 72,
  229, 17, 240, 75, 238, 5, 216, 25, 11, 80, 13, 24, 89, 119, 72, 134, 231,
  65, 205, 24, 23, 20, 68, 103, 48, 236, 255, 102, 124, 27, 193, 15,
]);

export const managerWalletKeypair = Keypair.fromSecretKey(MANAGER_PRIVATE_KEY);
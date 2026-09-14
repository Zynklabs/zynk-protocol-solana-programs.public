import { Keypair, PublicKey } from "@solana/web3.js";

export const ADMIN_KEYPAIR = Keypair.fromSecretKey(
  new Uint8Array([
    126, 107, 150, 33, 182, 94, 110, 60, 114, 206, 254, 24, 239, 162, 234, 67,
    205, 140, 165, 139, 247, 237, 172, 42, 19, 8, 4, 165, 159, 87, 234, 217,
    161, 178, 195, 93, 195, 139, 69, 187, 37, 17, 38, 231, 182, 3, 104, 21, 176,
    177, 142, 170, 1, 91, 82, 233, 74, 27, 72, 166, 107, 90, 62, 61,
  ])
);
export const ADMIN = ADMIN_KEYPAIR.publicKey;

export const GUARDIAN_KEYPAIR = Keypair.fromSecretKey(
  new Uint8Array([
    78, 50, 48, 23, 23, 174, 251, 222, 105, 223, 18, 208, 18, 216, 63, 163, 196,
    62, 165, 21, 167, 72, 246, 14, 24, 150, 26, 22, 247, 199, 121, 38, 208, 250,
    115, 48, 166, 148, 240, 200, 206, 131, 200, 90, 44, 160, 173, 112, 223, 180,
    253, 206, 146, 97, 46, 43, 62, 43, 156, 141, 177, 106, 246, 72,
  ])
);
export const GUARDIAN = GUARDIAN_KEYPAIR.publicKey;

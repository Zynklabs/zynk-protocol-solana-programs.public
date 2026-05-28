import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { managerWalletKeypair } from "./managerWallet";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
  approve,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { BN } from "bn.js";
import { assert } from "chai";
import nacl from "tweetnacl";
import * as fs from "fs";
import * as path from "path";

const DOMAIN_SEPARATOR = 115131153410997;

const loadKeypair = (file: string): Keypair => {
  const full = path.resolve(__dirname, "keys", file);
  const raw = JSON.parse(fs.readFileSync(full, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
};

const errMsg = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  return String(e);
};

let admin: Keypair;
let sharedProvider: anchor.AnchorProvider;

const deriveWhitelistPda = (
  programId: PublicKey,
  userId: string,
  wallet: PublicKey,
): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), Buffer.from(userId, "utf-8"), wallet.toBuffer()],
    programId,
  );

const deriveOrbitVaultPda = (programId: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync([Buffer.from("orbit_vault")], programId);

// Idempotent: create the Whitelist PDA if missing; otherwise reactivate it.
const whitelistBeneficiary = async (
  program: Program,
  userId: string,
  address: PublicKey,
): Promise<PublicKey> => {
  const [whitelistPda] = deriveWhitelistPda(program.programId, userId, address);
  try {
    await program.methods
      .whitelistBeneficiary(userId, address)
      .accountsPartial({
        whitelist: whitelistPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
  } catch (e) {
    if (!errMsg(e).toLowerCase().includes("already in use")) throw e;
    await program.methods
      .setWhitelistStatus(userId, address, true)
      .accountsPartial({
        whitelist: whitelistPda,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();
  }
  return whitelistPda;
};

const setWhitelistActive = async (
  program: Program,
  userId: string,
  address: PublicKey,
  isActive: boolean,
): Promise<void> => {
  const [whitelistPda] = deriveWhitelistPda(program.programId, userId, address);
  await program.methods
    .setWhitelistStatus(userId, address, isActive)
    .accountsPartial({
      whitelist: whitelistPda,
      admin: admin.publicKey,
    })
    .signers([admin])
    .rpc();
};

before(async () => {
  sharedProvider = anchor.AnchorProvider.env();
  anchor.setProvider(sharedProvider);

  admin = loadKeypair("admin.json");

  for (const kp of [admin, managerWalletKeypair]) {
    const sig = await sharedProvider.connection.requestAirdrop(
      kp.publicKey,
      5 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await sharedProvider.connection.confirmTransaction(sig, "confirmed");
  }
});

describe("zynk-orbit spend_tokens (delegate flow)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ZynkOrbit as Program;

  let mint: PublicKey;
  let approverTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;
  let delegatePda: PublicKey;
  let user2TokenAccount: PublicKey;
  let whitelistPda: PublicKey;

  const USER_ID = "u_zo_spend";
  const approver = Keypair.generate();
  const user2 = Keypair.generate();
  const recipientOwner = new PublicKey(
    "GbNjfHHBLFn3epGUwKQacbTD4YBqAMLNHHtKRNATHaep",
  );

  before(async () => {
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        approver.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        managerWalletKeypair.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );

    mint = await createMint(provider.connection, approver, approver.publicKey, null, 6);

    approverTokenAccount = await createAccount(
      provider.connection,
      approver,
      mint,
      approver.publicKey,
    );

    await mintTo(
      provider.connection,
      approver,
      mint,
      approverTokenAccount,
      approver,
      1_000_000,
    );

    recipientTokenAccount = await createAccount(
      provider.connection,
      approver,
      mint,
      recipientOwner,
    );
    user2TokenAccount = await createAccount(
      provider.connection,
      approver,
      mint,
      user2.publicKey,
    );
    await mintTo(provider.connection, approver, mint, user2TokenAccount, approver, 100);

    [delegatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("spender"), Buffer.from("delegate")],
      program.programId,
    );

    await approve(
      provider.connection,
      approver,
      approverTokenAccount,
      delegatePda,
      approver.publicKey,
      500_000,
    );

    whitelistPda = await whitelistBeneficiary(program, USER_ID, approver.publicKey);
  });

  it("Happy path: PDA spends within allowance", async () => {
    await program.methods
      .spendTokens("delegate", USER_ID, new BN(100_000))
      .accounts({
        managerWallet: managerWalletKeypair.publicKey,
        approverTokenAccount,
        recipientTokenAccount,
        whitelist: whitelistPda,
        spender: delegatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([managerWalletKeypair])
      .rpc();

    const approverAcc = await getAccount(provider.connection, approverTokenAccount);
    const recipientAcc = await getAccount(provider.connection, recipientTokenAccount);

    assert.equal(Number(approverAcc.amount), 900_000);
    assert.equal(Number(recipientAcc.amount), 100_000);
  });

  it("Sad path: no approve set (new ATA, PDA not delegated)", async () => {
    try {
      await program.methods
        .spendTokens("delegate", USER_ID, new BN(50))
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          approverTokenAccount: user2TokenAccount,
          recipientTokenAccount,
          whitelist: whitelistPda,
          spender: delegatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed without approve");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("failed")),
        "Expected SPL Token authority error",
      );
    }
  });

  it("Sad path: spend more than allowance", async () => {
    try {
      await program.methods
        .spendTokens("delegate", USER_ID, new BN(600_000))
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          approverTokenAccount,
          recipientTokenAccount,
          whitelist: whitelistPda,
          spender: delegatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed due to insufficient allowance");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("failed")),
        "Expected allowance exceeded error",
      );
    }
  });

  it("Sad path: wrong delegate PDA", async () => {
    const fakeDelegate = Keypair.generate().publicKey;

    try {
      await program.methods
        .spendTokens("delegate", USER_ID, new BN(10_000))
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          approverTokenAccount,
          recipientTokenAccount,
          whitelist: whitelistPda,
          spender: fakeDelegate,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed with wrong delegate");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("failed")),
        "Expected delegate authority mismatch",
      );
    }
  });

  it("Sad path: allowance exhausted", async () => {
    await program.methods
      .spendTokens("delegate", USER_ID, new BN(400_000))
      .accounts({
        managerWallet: managerWalletKeypair.publicKey,
        approverTokenAccount,
        recipientTokenAccount,
        whitelist: whitelistPda,
        spender: delegatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([managerWalletKeypair])
      .rpc();

    try {
      await program.methods
        .spendTokens("delegate", USER_ID, new BN(1))
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          approverTokenAccount,
          recipientTokenAccount,
          whitelist: whitelistPda,
          spender: delegatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed due to exhausted allowance");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("failed")),
        "Expected exhausted allowance error",
      );
    }
  });

  it("Sad path: signer is not the manager wallet", async () => {
    const otherSigner = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        otherSigner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );
    try {
      await program.methods
        .spendTokens("delegate", USER_ID, new BN(10_000))
        .accounts({
          managerWallet: otherSigner.publicKey,
          approverTokenAccount,
          recipientTokenAccount,
          whitelist: whitelistPda,
          spender: delegatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([otherSigner])
        .rpc();
      assert.fail("Should have failed with wrong manager wallet");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("ConstraintOwner")),
        "Expected manager wallet mismatch",
      );
    }
  });

  it("Sad path: operation on non-whitelisted user_id", async () => {
    const unknownUserId = "u_zo_unwhitelisted";
    const [unknownWhitelist] = deriveWhitelistPda(
      program.programId,
      unknownUserId,
      recipientOwner,
    );
    try {
      await program.methods
        .spendTokens("delegate", unknownUserId, new BN(10_000))
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          approverTokenAccount,
          recipientTokenAccount,
          whitelist: unknownWhitelist,
          spender: delegatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed for non-whitelisted user_id");
    } catch (err: unknown) {
      assert.include(errMsg(err).toLowerCase(), "accountnotinitialized");
    }
  });

  it("Sad path: spend with inactive whitelist", async () => {
    const inactiveUserId = `u_zo_inactive_${Math.random().toString(36).substring(7)}`;
    const wlPda = await whitelistBeneficiary(program, inactiveUserId, approver.publicKey);
    await setWhitelistActive(program, inactiveUserId, approver.publicKey, false);

    try {
      await program.methods
        .spendTokens("delegate", inactiveUserId, new BN(1_000))
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          approverTokenAccount,
          recipientTokenAccount,
          whitelist: wlPda,
          spender: delegatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed with WhitelistInactive");
    } catch (err: unknown) {
      assert.include(errMsg(err), "WhitelistInactive");
    }
  });
});

describe("PDA spend tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ZynkOrbit as Program;

  const USER_ID = "u_pda_spend";
  const approver = Keypair.generate();
  const recipientOwner = new PublicKey(
    "GbNjfHHBLFn3epGUwKQacbTD4YBqAMLNHHtKRNATHaep",
  );

  let testMint: PublicKey;
  let testRecipientTokenAccount: PublicKey;
  let customerPda3: PublicKey;
  let customerPda3TokenAccount: PublicKey;
  let randomSeed3: string;
  let whitelistPda: PublicKey;

  const pdaRoot = "spender";

  before(async () => {
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        approver.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        managerWalletKeypair.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );

    testMint = await createMint(provider.connection, approver, approver.publicKey, null, 6);

    testRecipientTokenAccount = await createAccount(
      provider.connection,
      approver,
      testMint,
      recipientOwner,
    );

    randomSeed3 = `customer_${Math.random().toString(36).substring(7)}`;
    [customerPda3] = PublicKey.findProgramAddressSync(
      [Buffer.from(pdaRoot), Buffer.from(randomSeed3)],
      program.programId,
    );

    customerPda3TokenAccount = getAssociatedTokenAddressSync(
      testMint,
      customerPda3,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    try {
      await getAccount(provider.connection, customerPda3TokenAccount);
    } catch {
      const createAtaIx = createAssociatedTokenAccountInstruction(
        approver.publicKey,
        customerPda3TokenAccount,
        customerPda3,
        testMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const createTx = new Transaction().add(createAtaIx);
      await provider.sendAndConfirm(createTx, [approver]);
    }

    await mintTo(
      provider.connection,
      approver,
      testMint,
      customerPda3TokenAccount,
      approver,
      1_500_000,
    );

    whitelistPda = await whitelistBeneficiary(program, USER_ID, customerPda3);
  });

  it("Happy path: Customer PDA ATA as approver_token_account", async () => {
    const initialBalance = await getAccount(provider.connection, customerPda3TokenAccount);
    const initialRecipientBalance = await getAccount(
      provider.connection,
      testRecipientTokenAccount,
    );

    const transferAmount = 200_000;

    await program.methods
      .spendTokens(randomSeed3, USER_ID, new BN(transferAmount))
      .accounts({
        managerWallet: managerWalletKeypair.publicKey,
        approverTokenAccount: customerPda3TokenAccount,
        recipientTokenAccount: testRecipientTokenAccount,
        whitelist: whitelistPda,
        spender: customerPda3,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([managerWalletKeypair])
      .rpc();

    const finalBalance = await getAccount(provider.connection, customerPda3TokenAccount);
    const finalRecipientBalance = await getAccount(
      provider.connection,
      testRecipientTokenAccount,
    );

    assert.equal(
      Number(finalBalance.amount),
      Number(initialBalance.amount) - transferAmount,
      "Customer ATA balance should decrease",
    );
    assert.equal(
      Number(finalRecipientBalance.amount),
      Number(initialRecipientBalance.amount) + transferAmount,
      "Recipient balance should increase",
    );
  });

  it("Sad path: wrong recipient token account", async () => {
    const transferAmount = 200_000;
    const wrongRecipientOwner = Keypair.generate().publicKey;
    const wrongRecipientTokenAccountAta = getAssociatedTokenAddressSync(
      testMint,
      wrongRecipientOwner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    try {
      await getAccount(provider.connection, wrongRecipientTokenAccountAta);
    } catch {
      const createAtaIx = createAssociatedTokenAccountInstruction(
        approver.publicKey,
        wrongRecipientTokenAccountAta,
        wrongRecipientOwner,
        testMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const createTx = new Transaction().add(createAtaIx);
      await provider.sendAndConfirm(createTx, [approver]);
    }

    try {
      await program.methods
        .spendTokens(randomSeed3, USER_ID, new BN(transferAmount))
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          approverTokenAccount: customerPda3TokenAccount,
          recipientTokenAccount: wrongRecipientTokenAccountAta,
          whitelist: whitelistPda,
          spender: customerPda3,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed with wrong recipient token account");
    } catch (err: any) {
      assert(
        err.logs.some((l: string) => l.includes("ConstraintOwner") || l.includes("failed")),
        "Expected recipient token account owner constraint violation",
      );
    }
  });

  it("Sad path: wrong PDA", async () => {
    const transferAmount = 200_000;
    const wrongSeed = `wrong_customer_${Math.random().toString(36).substring(7)}`;
    const [wrongPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(pdaRoot), Buffer.from(wrongSeed)],
      program.programId,
    );

    const wrongPdaTokenAccount = getAssociatedTokenAddressSync(
      testMint,
      wrongPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    try {
      await getAccount(provider.connection, wrongPdaTokenAccount);
    } catch {
      const createAtaIx = createAssociatedTokenAccountInstruction(
        approver.publicKey,
        wrongPdaTokenAccount,
        wrongPda,
        testMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const createTx = new Transaction().add(createAtaIx);
      await provider.sendAndConfirm(createTx, [approver]);
    }

    await mintTo(
      provider.connection,
      approver,
      testMint,
      wrongPdaTokenAccount,
      approver,
      1_000_000,
    );

    try {
      await program.methods
        .spendTokens(randomSeed3, USER_ID, new BN(transferAmount))
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          approverTokenAccount: wrongPdaTokenAccount,
          recipientTokenAccount: testRecipientTokenAccount,
          whitelist: whitelistPda,
          spender: wrongPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed with wrong PDA");
    } catch (err: any) {
      assert(
        err.logs.some(
          (l: string) =>
            l.includes("failed") || l.includes("ConstraintSeeds") || l.includes("seeds"),
        ),
        "Expected PDA mismatch",
      );
    }
  });
});

const buildEd25519Ix = (msg: string, signer: Keypair) => {
  const message = new TextEncoder().encode(msg);
  const signature = nacl.sign.detached(message, signer.secretKey);

  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: signer.publicKey.toBuffer(),
    message,
    signature,
  });

  return { ed25519Ix, signature };
};

describe("Transfer PDA to wallet tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ZynkOrbit as Program;

  const pdaRoot = "wallet";
  let userId: string;
  let pda: PublicKey;
  let pdaTokenAccount: PublicKey;
  let testMint: PublicKey;
  let destinationWallet: Keypair;
  let walletTokenAccount: PublicKey;
  let whitelistPda: PublicKey;

  // Funder for token-account creation and minting; unrelated to program authority.
  const funder = provider.wallet.payer!;

  before(async () => {
    userId = `user_${Math.random().toString(36).substring(7)}`;
    [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(pdaRoot), Buffer.from(userId)],
      program.programId,
    );

    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        funder.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        managerWalletKeypair.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );

    testMint = await createMint(provider.connection, funder, funder.publicKey, null, 6);

    pdaTokenAccount = getAssociatedTokenAddressSync(
      testMint,
      pda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    try {
      await getAccount(provider.connection, pdaTokenAccount);
    } catch {
      const createAtaIx = createAssociatedTokenAccountInstruction(
        funder.publicKey,
        pdaTokenAccount,
        pda,
        testMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const createTx = new Transaction().add(createAtaIx);
      await provider.sendAndConfirm(createTx, [funder]);
    }

    await mintTo(provider.connection, funder, testMint, pdaTokenAccount, funder, 2_000_000);

    destinationWallet = Keypair.generate();
    walletTokenAccount = getAssociatedTokenAddressSync(
      testMint,
      destinationWallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    try {
      await getAccount(provider.connection, walletTokenAccount);
    } catch {
      const createAtaIx = createAssociatedTokenAccountInstruction(
        funder.publicKey,
        walletTokenAccount,
        destinationWallet.publicKey,
        testMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const createTx = new Transaction().add(createAtaIx);
      await provider.sendAndConfirm(createTx, [funder]);
    }

    whitelistPda = await whitelistBeneficiary(program, userId, destinationWallet.publicKey);
  });

  it("Happy path: transfer from PDA token account to wallet token account", async () => {
    const transferAmount = 200_000;
    const initialPdaBalance = await getAccount(provider.connection, pdaTokenAccount);
    const initialWalletBalance = await getAccount(provider.connection, walletTokenAccount);

    const message = `${DOMAIN_SEPARATOR}::${destinationWallet.publicKey.toBase58()}`;
    const { ed25519Ix, signature } = buildEd25519Ix(message, managerWalletKeypair);

    await program.methods
      .transferPdaToWallet(
        userId,
        destinationWallet.publicKey,
        new BN(transferAmount),
        Buffer.from(signature).toJSON().data,
      )
      .accounts({
        managerWallet: managerWalletKeypair.publicKey,
        pda,
        pdaTokenAccount,
        walletTokenAccount,
        whitelist: whitelistPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
      .signers([managerWalletKeypair])
      .rpc();

    const finalPdaBalance = await getAccount(provider.connection, pdaTokenAccount);
    const finalWalletBalance = await getAccount(provider.connection, walletTokenAccount);

    assert.equal(
      Number(finalPdaBalance.amount),
      Number(initialPdaBalance.amount) - transferAmount,
      "PDA token account balance should decrease",
    );
    assert.equal(
      Number(finalWalletBalance.amount),
      Number(initialWalletBalance.amount) + transferAmount,
      "Destination wallet token account balance should increase",
    );
  });

  it("Sad path: ed25519 signature not produced by manager wallet", async () => {
    const transferAmount = 100_000;
    const wrongSigner = Keypair.generate();
    const message = `${DOMAIN_SEPARATOR}::${destinationWallet.publicKey.toBase58()}`;
    const { ed25519Ix, signature } = buildEd25519Ix(message, wrongSigner);

    try {
      await program.methods
        .transferPdaToWallet(
          userId,
          destinationWallet.publicKey,
          new BN(transferAmount),
          Buffer.from(signature).toJSON().data,
        )
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          pda,
          pdaTokenAccount,
          walletTokenAccount,
          whitelist: whitelistPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed when signer is not the manager wallet");
    } catch (err: unknown) {
      const logs = (err as { logs?: string[] })?.logs ?? [];
      const msg = (err as Error)?.message ?? "";
      assert(
        logs.some(
          (l: string) =>
            l.includes("InvalidInstructionData") || l.includes("failed") || l.includes("0x0"),
        ) ||
        msg.includes("InvalidInstructionData") ||
        msg.includes("failed"),
        "Expected signature verification to fail when signer is not manager wallet",
      );
    }
  });

  it("Sad path: insufficient funds in PDA", async () => {
    const pdaBalance = await getAccount(provider.connection, pdaTokenAccount);
    const transferAmount = Number(pdaBalance.amount) + 1_000_000;

    const message = `${DOMAIN_SEPARATOR}::${destinationWallet.publicKey.toBase58()}`;
    const { ed25519Ix, signature } = buildEd25519Ix(message, managerWalletKeypair);

    try {
      await program.methods
        .transferPdaToWallet(
          userId,
          destinationWallet.publicKey,
          new BN(transferAmount),
          Buffer.from(signature).toJSON().data,
        )
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          pda,
          pdaTokenAccount,
          walletTokenAccount,
          whitelist: whitelistPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed with insufficient funds in PDA");
    } catch (err: unknown) {
      const logs = (err as { logs?: string[] })?.logs ?? [];
      const msg = (err as Error)?.message ?? "";
      assert(
        logs.some(
          (l: string) =>
            l.includes("insufficient") || l.includes("0x1") || l.includes("failed"),
        ) ||
        msg.includes("insufficient") ||
        msg.includes("failed"),
        "Expected insufficient funds error",
      );
    }
  });

  it("Sad path: wallet_address not owner of wallet token account", async () => {
    const wrongWallet = Keypair.generate();
    const message = `${DOMAIN_SEPARATOR}::${wrongWallet.publicKey.toBase58()}`;
    const { ed25519Ix, signature } = buildEd25519Ix(message, managerWalletKeypair);
    const transferAmount = 100_000;
    try {
      await program.methods
        .transferPdaToWallet(
          userId,
          wrongWallet.publicKey,
          new BN(transferAmount),
          Buffer.from(signature).toJSON().data,
        )
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          pda,
          pdaTokenAccount,
          walletTokenAccount,
          whitelist: whitelistPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed with wrong wallet address");
    } catch (err: unknown) {
      const logs = (err as { logs?: string[] })?.logs ?? [];
      const msg = (err as Error)?.message ?? "";
      assert(
        logs.some((l: string) => l.includes("ConstraintOwner") || l.includes("failed")) ||
        msg.includes("ConstraintOwner") ||
        msg.includes("failed"),
        "Expected wallet address ownership constraint failure",
      );
    }
  });

  it("Sad path: transfer to non-whitelisted destination wallet", async () => {
    const ghostUserId = `u_tpw_unwhitelisted_${Math.random().toString(36).substring(7)}`;
    const transferAmount = 10_000;
    const [ghostWhitelist] = deriveWhitelistPda(
      program.programId,
      ghostUserId,
      destinationWallet.publicKey,
    );

    const message = `${DOMAIN_SEPARATOR}::${destinationWallet.publicKey.toBase58()}`;
    const { ed25519Ix, signature } = buildEd25519Ix(message, managerWalletKeypair);

    try {
      await program.methods
        .transferPdaToWallet(
          ghostUserId,
          destinationWallet.publicKey,
          new BN(transferAmount),
          Buffer.from(signature).toJSON().data,
        )
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          pda,
          pdaTokenAccount,
          walletTokenAccount,
          whitelist: ghostWhitelist,
          tokenProgram: TOKEN_PROGRAM_ID,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed for non-whitelisted destination");
    } catch (err: unknown) {
      assert(
        /accountnotinitialized|seeds|constraint/i.test(errMsg(err)),
        `Expected whitelist-related failure; got: ${errMsg(err)}`,
      );
    }
  });
});

describe("Transfer to LP tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ZynkOrbit as Program;
  let recipientAccount: Keypair;
  let recipientTokenAccount: PublicKey;

  const USER_ID = "u_lp";
  const funder = provider.wallet.payer!;
  let orbitVaultPda: PublicKey;
  let orbitVaultTokenAccount: PublicKey;
  let whitelistPda: PublicKey;

  let testMint: PublicKey;

  before(async () => {
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        funder.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        managerWalletKeypair.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );
    testMint = await createMint(provider.connection, funder, funder.publicKey, null, 6);

    [orbitVaultPda] = deriveOrbitVaultPda(program.programId);

    orbitVaultTokenAccount = getAssociatedTokenAddressSync(
      testMint,
      orbitVaultPda,
      true, // allowOwnerOffCurve for PDA
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    try {
      await getAccount(provider.connection, orbitVaultTokenAccount);
    } catch {
      const createAtaIx = createAssociatedTokenAccountInstruction(
        funder.publicKey,
        orbitVaultTokenAccount,
        orbitVaultPda,
        testMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const createTx = new Transaction().add(createAtaIx);
      await provider.sendAndConfirm(createTx, [funder]);
    }

    await mintTo(
      provider.connection,
      funder,
      testMint,
      orbitVaultTokenAccount,
      funder,
      2_000_000,
    );

    recipientAccount = Keypair.generate();
    recipientTokenAccount = await createAccount(
      provider.connection,
      funder,
      testMint,
      recipientAccount.publicKey,
    );

    whitelistPda = await whitelistBeneficiary(program, USER_ID, recipientAccount.publicKey);
  });

  it("Happy path: Transfer from orbit_vault to LP", async () => {
    const transferAmount = 200_000;
    const initialBalance = await getAccount(provider.connection, orbitVaultTokenAccount);
    const initialRecipientBalance = await getAccount(provider.connection, recipientTokenAccount);
    await program.methods
      .transferToLp(USER_ID, new BN(transferAmount))
      .accounts({
        managerWallet: managerWalletKeypair.publicKey,
        orbitVault: orbitVaultPda,
        orbitVaultTokenAccount,
        lpTokenAccount: recipientTokenAccount,
        whitelist: whitelistPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([managerWalletKeypair])
      .rpc();
    const finalBalance = await getAccount(provider.connection, orbitVaultTokenAccount);
    const finalRecipientBalance = await getAccount(provider.connection, recipientTokenAccount);
    assert.equal(
      Number(finalBalance.amount),
      Number(initialBalance.amount) - transferAmount,
      "Vault balance should decrease",
    );
    assert.equal(
      Number(finalRecipientBalance.amount),
      Number(initialRecipientBalance.amount) + transferAmount,
      "Recipient balance should increase",
    );
  });

  it("Sad path: wrong recipient mint address", async () => {
    const transferAmount = 200_000;

    try {
      const otherMint = await createMint(
        provider.connection,
        funder,
        funder.publicKey,
        null,
        6,
      );
      const otherRecipientTokenAccount = await createAccount(
        provider.connection,
        funder,
        otherMint,
        recipientAccount.publicKey,
      );
      await program.methods
        .transferToLp(USER_ID, new BN(transferAmount))
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          orbitVault: orbitVaultPda,
          orbitVaultTokenAccount,
          lpTokenAccount: otherRecipientTokenAccount,
          whitelist: whitelistPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed with wrong recipient mint address");
    } catch (err: any) {
      assert(
        err.logs.some((l: string) => l.includes("ConstraintTokenMint")),
        "Expected recipient mint address mismatch",
      );
    }
  });

  it("Sad path: signer is not the manager wallet", async () => {
    const transferAmount = 200_000;
    const otherSigner = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        otherSigner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );
    try {
      await program.methods
        .transferToLp(USER_ID, new BN(transferAmount))
        .accounts({
          managerWallet: otherSigner.publicKey,
          orbitVault: orbitVaultPda,
          orbitVaultTokenAccount,
          lpTokenAccount: recipientTokenAccount,
          whitelist: whitelistPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([otherSigner])
        .rpc();
      assert.fail("Should have failed: signer is not the manager wallet");
    } catch (err: any) {
      assert(
        err.logs.some((l: string) => l.includes("ConstraintOwner")),
        "Expected manager wallet mismatch",
      );
    }
  });

  it("Sad path: transfer to non-whitelisted LP destination", async () => {
    const ghostUserId = `u_lp_unwhitelisted_${Math.random().toString(36).substring(7)}`;
    const transferAmount = 10_000;
    const [ghostWhitelist] = deriveWhitelistPda(
      program.programId,
      ghostUserId,
      recipientAccount.publicKey,
    );
    try {
      await program.methods
        .transferToLp(ghostUserId, new BN(transferAmount))
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          orbitVault: orbitVaultPda,
          orbitVaultTokenAccount,
          lpTokenAccount: recipientTokenAccount,
          whitelist: ghostWhitelist,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed for non-whitelisted destination");
    } catch (err: unknown) {
      assert.include(errMsg(err).toLowerCase(), "accountnotinitialized");
    }
  });

  it("Sad path: transfer when whitelist is inactive", async () => {
    const inactiveUserId = `u_lp_inactive_${Math.random().toString(36).substring(7)}`;
    const wlPda = await whitelistBeneficiary(program, inactiveUserId, recipientAccount.publicKey);
    await setWhitelistActive(program, inactiveUserId, recipientAccount.publicKey, false);

    try {
      await program.methods
        .transferToLp(inactiveUserId, new BN(10_000))
        .accounts({
          managerWallet: managerWalletKeypair.publicKey,
          orbitVault: orbitVaultPda,
          orbitVaultTokenAccount,
          lpTokenAccount: recipientTokenAccount,
          whitelist: wlPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed with WhitelistInactive");
    } catch (err: unknown) {
      assert.include(errMsg(err), "WhitelistInactive");
    }
  });
});

describe("deposit tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ZynkOrbit as Program;

  const receiverOwner = new PublicKey("GbNjfHHBLFn3epGUwKQacbTD4YBqAMLNHHtKRNATHaep");
  const USER_ID = "u_dep";

  let mint: PublicKey;
  let spenderTokenAccount: PublicKey;
  let receiverTokenAccount: PublicKey;
  let whitelistPda: PublicKey;

  const spender = Keypair.generate();

  before(async () => {
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(spender.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
    );

    mint = await createMint(provider.connection, spender, spender.publicKey, null, 6);

    spenderTokenAccount = await createAccount(provider.connection, spender, mint, spender.publicKey);
    await mintTo(provider.connection, spender, mint, spenderTokenAccount, spender, 1_000_000);

    receiverTokenAccount = await createAccount(provider.connection, spender, mint, receiverOwner);

    whitelistPda = await whitelistBeneficiary(program, USER_ID, spender.publicKey);
  });

  it("Happy path: spender deposits tokens into receiver", async () => {
    const depositAmount = 250_000;

    const spenderBefore = await getAccount(provider.connection, spenderTokenAccount);
    const receiverBefore = await getAccount(provider.connection, receiverTokenAccount);

    const requestId = "req-1";

    const listener = program.addEventListener("depositEvent", (event: any, _slot) => {
      assert.equal(event.domainSeparator.toNumber(), DOMAIN_SEPARATOR);
      assert.equal(event.spender.toBase58(), spender.publicKey.toBase58());
      assert.equal(event.receiver.toBase58(), receiverOwner.toBase58());
      assert.equal(event.amount.toNumber(), depositAmount);
      assert.equal(event.requestId, requestId);
    });

    await program.methods
      .deposit(new BN(depositAmount), requestId, USER_ID)
      .accounts({
        spender: spender.publicKey,
        spenderTokenAccount,
        receiverTokenAccount,
        whitelist: whitelistPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([spender])
      .rpc();

    const spenderAfter = await getAccount(provider.connection, spenderTokenAccount);
    const receiverAfter = await getAccount(provider.connection, receiverTokenAccount);

    assert.equal(Number(spenderAfter.amount), Number(spenderBefore.amount) - depositAmount);
    assert.equal(Number(receiverAfter.amount), Number(receiverBefore.amount) + depositAmount);

    await program.removeEventListener(listener);
  });

  it("Happy path: anyone (not a special wallet) can call deposit", async () => {
    const depositAmount = 100_000;

    const randomSpender = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        randomSpender.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );
    const randomSpenderAta = await createAccount(
      provider.connection,
      randomSpender,
      mint,
      randomSpender.publicKey,
    );
    await mintTo(provider.connection, randomSpender, mint, randomSpenderAta, spender, 500_000);

    const randomSpenderWhitelistPda = await whitelistBeneficiary(
      program,
      USER_ID,
      randomSpender.publicKey,
    );

    const requestId = "req-2";

    const listener = program.addEventListener("depositEvent", (event: any, _slot) => {
      assert.equal(event.domainSeparator.toNumber(), DOMAIN_SEPARATOR);
      assert.equal(event.spender.toBase58(), randomSpender.publicKey.toBase58());
      assert.equal(event.receiver.toBase58(), receiverOwner.toBase58());
      assert.equal(event.amount.toNumber(), depositAmount);
      assert.equal(event.requestId, requestId);
    });

    await program.methods
      .deposit(new BN(depositAmount), requestId, USER_ID)
      .accounts({
        spender: randomSpender.publicKey,
        spenderTokenAccount: randomSpenderAta,
        receiverTokenAccount,
        whitelist: randomSpenderWhitelistPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([randomSpender])
      .rpc();

    const ata = await getAccount(provider.connection, randomSpenderAta);
    assert.equal(Number(ata.amount), 400_000);

    await program.removeEventListener(listener);
  });

  it("Sad path: spender does not own the source token account", async () => {
    const interloper = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        interloper.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );

    try {
      await program.methods
        .deposit(new BN(10_000), "req-3", USER_ID)
        .accounts({
          spender: interloper.publicKey,
          spenderTokenAccount,
          receiverTokenAccount,
          whitelist: whitelistPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([interloper])
        .rpc();
      assert.fail("Should have failed: interloper cannot sign for a token account they don't own");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("failed") || l.includes("ConstraintOwner")),
        "Expected owner constraint failure",
      );
    }
  });

  it("Sad path: receiver token account not owned by hardcoded receiver address", async () => {
    const fakeReceiverOwner = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        fakeReceiverOwner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );
    const fakeReceiverTokenAccount = await createAccount(
      provider.connection,
      fakeReceiverOwner,
      mint,
      fakeReceiverOwner.publicKey,
    );

    try {
      await program.methods
        .deposit(new BN(10_000), "req-4", USER_ID)
        .accounts({
          spender: spender.publicKey,
          spenderTokenAccount,
          receiverTokenAccount: fakeReceiverTokenAccount,
          whitelist: whitelistPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([spender])
        .rpc();
      assert.fail("Should have failed: receiver token account not owned by hardcoded receiver address");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("ConstraintOwner") || l.includes("failed")),
        "Expected receiver owner constraint failure",
      );
    }
  });

  it("Sad path: insufficient balance", async () => {
    const broke = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(broke.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
    );
    const brokeAta = await createAccount(provider.connection, broke, mint, broke.publicKey);
    await mintTo(provider.connection, broke, mint, brokeAta, spender, 50);

    try {
      await program.methods
        .deposit(new BN(1_000), "req-5", USER_ID)
        .accounts({
          spender: broke.publicKey,
          spenderTokenAccount: brokeAta,
          receiverTokenAccount,
          whitelist: whitelistPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([broke])
        .rpc();
      assert.fail("Should have failed: insufficient token balance");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("failed")),
        "Expected insufficient funds error",
      );
    }
  });

  it("Sad path: deposit with non-whitelisted user_id", async () => {
    const ghostUserId = `u_dep_unwhitelisted_${Math.random().toString(36).substring(7)}`;
    const [ghostWhitelist] = deriveWhitelistPda(program.programId, ghostUserId, receiverOwner);
    try {
      await program.methods
        .deposit(new BN(1_000), "req-ghost", ghostUserId)
        .accounts({
          spender: spender.publicKey,
          spenderTokenAccount,
          receiverTokenAccount,
          whitelist: ghostWhitelist,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([spender])
        .rpc();
      assert.fail("Should have failed for non-whitelisted user_id");
    } catch (err: unknown) {
      assert.include(errMsg(err).toLowerCase(), "accountnotinitialized");
    }
  });

  it("Sad path: deposit when whitelist is inactive", async () => {
    const inactiveUserId = `u_dep_inactive_${Math.random().toString(36).substring(7)}`;
    const wlPda = await whitelistBeneficiary(program, inactiveUserId, spender.publicKey);
    await setWhitelistActive(program, inactiveUserId, spender.publicKey, false);

    try {
      await program.methods
        .deposit(new BN(1_000), "req-inactive", inactiveUserId)
        .accounts({
          spender: spender.publicKey,
          spenderTokenAccount,
          receiverTokenAccount,
          whitelist: wlPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([spender])
        .rpc();
      assert.fail("Should have failed with WhitelistInactive");
    } catch (err: unknown) {
      assert.include(errMsg(err), "WhitelistInactive");
    }
  });
});

describe("whitelist_beneficiary instruction tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ZynkOrbit as Program;

  it("Happy path: admin creates whitelist with is_active=true, address, user_id", async () => {
    const userId = `wl_happy_${Math.random().toString(36).substring(7)}`;
    const wallet = Keypair.generate().publicKey;
    const [whitelistPda] = deriveWhitelistPda(program.programId, userId, wallet);

    await program.methods
      .whitelistBeneficiary(userId, wallet)
      .accountsPartial({
        whitelist: whitelistPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const wl: any = await (program.account as any).whitelist.fetch(whitelistPda);
    assert.equal(wl.isActive, true);
    assert.equal(wl.address.toBase58(), wallet.toBase58());
    assert.equal(wl.userId, userId);
    assert.isAbove(wl.bump, 0);
  });

  it("Sad path: non-admin signer is rejected", async () => {
    const userId = `wl_unauth_${Math.random().toString(36).substring(7)}`;
    const wallet = Keypair.generate().publicKey;
    const [whitelistPda] = deriveWhitelistPda(program.programId, userId, wallet);
    const interloper = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        interloper.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );

    try {
      await program.methods
        .whitelistBeneficiary(userId, wallet)
        .accountsPartial({
          whitelist: whitelistPda,
          admin: interloper.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([interloper])
        .rpc();
      assert.fail("expected UnauthorizedAdmin");
    } catch (e) {
      assert.include(errMsg(e), "UnauthorizedAdmin");
    }
  });

  it("Sad path: re-creating an existing whitelist fails", async () => {
    const userId = `wl_dup_${Math.random().toString(36).substring(7)}`;
    const wallet = Keypair.generate().publicKey;
    const [whitelistPda] = deriveWhitelistPda(program.programId, userId, wallet);

    await program.methods
      .whitelistBeneficiary(userId, wallet)
      .accountsPartial({
        whitelist: whitelistPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    try {
      await program.methods
        .whitelistBeneficiary(userId, wallet)
        .accountsPartial({
          whitelist: whitelistPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      assert.fail("expected init collision");
    } catch (e) {
      assert.include(errMsg(e).toLowerCase(), "already in use");
    }
  });
});

describe("set_whitelist_status instruction tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ZynkOrbit as Program;

  it("Happy path: admin toggles is_active to false then back to true", async () => {
    const userId = `wls_toggle_${Math.random().toString(36).substring(7)}`;
    const wallet = Keypair.generate().publicKey;
    const whitelistPda = await whitelistBeneficiary(program, userId, wallet);

    await program.methods
      .setWhitelistStatus(userId, wallet, false)
      .accountsPartial({
        whitelist: whitelistPda,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    let wl: any = await (program.account as any).whitelist.fetch(whitelistPda);
    assert.equal(wl.isActive, false);

    await program.methods
      .setWhitelistStatus(userId, wallet, true)
      .accountsPartial({
        whitelist: whitelistPda,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    wl = await (program.account as any).whitelist.fetch(whitelistPda);
    assert.equal(wl.isActive, true);
  });

  it("Sad path: non-admin cannot toggle status", async () => {
    const userId = `wls_unauth_${Math.random().toString(36).substring(7)}`;
    const wallet = Keypair.generate().publicKey;
    const whitelistPda = await whitelistBeneficiary(program, userId, wallet);

    const interloper = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        interloper.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );

    try {
      await program.methods
        .setWhitelistStatus(userId, wallet, false)
        .accountsPartial({
          whitelist: whitelistPda,
          admin: interloper.publicKey,
        })
        .signers([interloper])
        .rpc();
      assert.fail("expected UnauthorizedAdmin");
    } catch (e) {
      assert.include(errMsg(e), "UnauthorizedAdmin");
    }
  });

  it("Sad path: toggling a non-existent whitelist fails", async () => {
    const userId = `wls_missing_${Math.random().toString(36).substring(7)}`;
    const wallet = Keypair.generate().publicKey;
    const [whitelistPda] = deriveWhitelistPda(program.programId, userId, wallet);

    try {
      await program.methods
        .setWhitelistStatus(userId, wallet, false)
        .accountsPartial({
          whitelist: whitelistPda,
          admin: admin.publicKey,
        })
        .signers([admin])
        .rpc();
      assert.fail("expected AccountNotInitialized");
    } catch (e) {
      assert.include(errMsg(e).toLowerCase(), "accountnotinitialized");
    }
  });
});

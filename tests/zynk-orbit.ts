import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Transaction,Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY  } from "@solana/web3.js";
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

const DOMAIN_SEPARATOR = 115131153410997;

describe("zynk-orbit", () => {
  // Configure the client
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ZynkOrbit as Program;

  let mint: PublicKey;
  let approverTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;
  let delegatePda: PublicKey;
  let delegateBump: number;
  let user2TokenAccount: PublicKey;

  const approver = Keypair.generate(); // owns source ATA
  const user2 = Keypair.generate();
  const recipientOwner = new PublicKey(
    "GbNjfHHBLFn3epGUwKQacbTD4YBqAMLNHHtKRNATHaep"
  );

  before(async () => {
    // Airdrop to approver and manager wallet
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        approver.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      )
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        managerWalletKeypair.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      )
    );

    // Create mint
    mint = await createMint(
      provider.connection,
      approver,
      approver.publicKey,
      null,
      6 // decimals
    );

    // Create token accounts
    approverTokenAccount = await createAccount(
      provider.connection,
      approver,
      mint,
      approver.publicKey
    );
    
    // Mint some tokens to approver
    await mintTo(
      provider.connection,
      approver,
      mint,
      approverTokenAccount,
      approver,
      1_000_000 // 1,000 tokens
    );

    recipientTokenAccount = await createAccount(
      provider.connection,
      approver,
      mint,
      recipientOwner
    );
    user2TokenAccount = await createAccount(
      provider.connection,
      approver,
      mint,
      user2.publicKey
    );
    await mintTo(provider.connection, approver, mint, user2TokenAccount, approver, 100);

    // Find PDA
    [delegatePda, delegateBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("spender"), Buffer.from("delegate")],
      program.programId
    );

    // Approve PDA as delegate with 500_000 allowance
    await approve(
      provider.connection,
      approver,
      approverTokenAccount,
      delegatePda,
      approver.publicKey,
      500_000
    );
  });

  it("Happy path: PDA spends within allowance", async () => {
    await program.methods
      .spendTokens("delegate", new BN(100_000))
      .accounts({
        orbitWallet: provider.wallet.publicKey,
        managerWallet: managerWalletKeypair.publicKey,
        approverTokenAccount,
        recipientTokenAccount,
        spender: delegatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([provider.wallet.payer, managerWalletKeypair])
      .rpc();

    const approverAcc = await getAccount(provider.connection, approverTokenAccount);
    const recipientAcc = await getAccount(provider.connection, recipientTokenAccount);

    assert.equal(Number(approverAcc.amount), 900_000);
    assert.equal(Number(recipientAcc.amount), 100_000);
  });

  it("Sad path: no approve set (new ATA, PDA not delegated)", async () => {
    try {
      await program.methods
        .spendTokens("delegate", new BN(50))
        .accounts({
          orbitWallet: provider.wallet.publicKey,
          managerWallet: managerWalletKeypair.publicKey,
          approverTokenAccount: user2TokenAccount,
          recipientTokenAccount,
          spender: delegatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([provider.wallet.payer, managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed without approve");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("failed")),
        "Expected SPL Token authority error"
      );
    }
  });

  it("Sad path: spend more than allowance", async () => {
    try {
      await program.methods
        .spendTokens("delegate", new BN(600_000)) // allowance was 500_000
        .accounts({
          orbitWallet: provider.wallet.publicKey,
          managerWallet: managerWalletKeypair.publicKey,
          approverTokenAccount,
          recipientTokenAccount,
          spender: delegatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([provider.wallet.payer, managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed due to insufficient allowance");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("failed")),
        "Expected allowance exceeded error"
      );
    }
  });

  it("Sad path: wrong delegate PDA", async () => {
    const fakeDelegate = Keypair.generate().publicKey;

    try {
      await program.methods
        .spendTokens("delegate", new BN(10_000))
        .accounts({
          orbitWallet: provider.wallet.publicKey,
          managerWallet: managerWalletKeypair.publicKey,
          approverTokenAccount,
          recipientTokenAccount,
          spender: fakeDelegate, // not approved
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([provider.wallet.payer, managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed with wrong delegate");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("failed")),
        "Expected delegate authority mismatch"
      );
    }
  });

  it("Sad path: allowance exhausted", async () => {
    // Use up the remaining allowance (500k - 100k already spent = 400k left)
    await program.methods
      .spendTokens("delegate", new BN(400_000))
      .accounts({
        orbitWallet: provider.wallet.publicKey,
        managerWallet: managerWalletKeypair.publicKey,
        approverTokenAccount,
        recipientTokenAccount,
        spender: delegatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([provider.wallet.payer, managerWalletKeypair])
      .rpc();

    // Next attempt should fail
    try {
      await program.methods
        .spendTokens("delegate", new BN(1)) // nothing left
        .accounts({
          orbitWallet: provider.wallet.publicKey,
          managerWallet: managerWalletKeypair.publicKey,
          approverTokenAccount,
          recipientTokenAccount,
          spender: delegatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([provider.wallet.payer, managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed due to exhausted allowance");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("failed")),
        "Expected exhausted allowance error"
      );
    }
  });

  it("Sad path: signer is not the manager wallet", async () => {
    const otherSigner = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        otherSigner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      )
    );
    try {
      await program.methods
        .spendTokens("delegate", new BN(10_000))
        .accounts({
          orbitWallet: provider.wallet.publicKey,
          managerWallet: otherSigner.publicKey,
          approverTokenAccount,
          recipientTokenAccount,
          spender: delegatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([provider.wallet.payer, otherSigner])
        .rpc();
      assert.fail("Should have failed with wrong manager wallet");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("ConstraintOwner")),
        "Expected manager wallet mismatch"
      );
    }
  });
});

describe("PDA spend tests", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
  
    const program = anchor.workspace.ZynkOrbit as Program;
  
    let mint: PublicKey;
    let approverTokenAccount: PublicKey;
    let recipientTokenAccount: PublicKey;
    let delegatePda: PublicKey;
    let delegateBump: number;
    let user2TokenAccount: PublicKey;
  
    const approver = Keypair.generate(); // owns source ATA
    const user2 = Keypair.generate();
    const recipientOwner = new PublicKey(
      "GbNjfHHBLFn3epGUwKQacbTD4YBqAMLNHHtKRNATHaep"
    );
  
    let customerPda: PublicKey;
    let customerBump: number;
    let customerPdaTokenAccount: PublicKey;
    let testMint: PublicKey;
    let testRecipientTokenAccount: PublicKey;
    let customerPda3: PublicKey;
    let customerPda3TokenAccount: PublicKey;
    let customerPda3Bump: number;
    let randomSeed3: string;
  
    const pdaRoot = "spender";
  
    before(async () => {
      // Create a new customer PDA with a random seed
      const randomSeed = `customer_${Math.random().toString(36).substring(7)}`;
      [customerPda, customerBump] = PublicKey.findProgramAddressSync(
        [Buffer.from(randomSeed)],
        program.programId
      );
  
      // Airdrop to approver and manager wallet for transaction fees
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
          approver.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        )
      );
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
          managerWalletKeypair.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        )
      );
  
      // Create a new mint for this test
      testMint = await createMint(
        provider.connection,
        approver,
        approver.publicKey,
        null,
        6 // decimals
      );
  
      // Get the ATA address for the customer PDA
      // allowOwnerOffCurve must be true for PDAs (which are off-curve addresses)
      customerPdaTokenAccount = getAssociatedTokenAddressSync(
        testMint,
        customerPda,
        true, // allowOwnerOffCurve: true for PDA
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
  
      // Check if ATA exists, if not create it
      try {
        await getAccount(provider.connection, customerPdaTokenAccount);
      } catch (error: any) {
        // ATA doesn't exist, create it
        // createAssociatedTokenAccountInstruction creates an ATA owned by the customer PDA
        const createAtaIx = createAssociatedTokenAccountInstruction(
          approver.publicKey, // payer
          customerPdaTokenAccount, // ata
          customerPda, // owner (customer PDA)
          testMint, // mint
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
  
        const createTx = new Transaction().add(createAtaIx);
        await provider.sendAndConfirm(createTx, [approver]);
      }
  
      // Mint tokens directly to the customer PDA's ATA
      await mintTo(
        provider.connection,
        approver,
        testMint,
        customerPdaTokenAccount,
        approver, // mint authority
        2_000_000 // 2,000 tokens
      );
  
      // Create recipient token account for the test mint
      testRecipientTokenAccount = await createAccount(
        provider.connection,
        approver,
        testMint,
        recipientOwner
      );
  
      // Create a new customer PDA with pdaRoot seed for spendTokens tests
      randomSeed3 = `customer_${Math.random().toString(36).substring(7)}`;
      [customerPda3, customerPda3Bump] = PublicKey.findProgramAddressSync(
        [Buffer.from(pdaRoot), Buffer.from(randomSeed3)],
        program.programId
      );
  
      // Create ATA for this customer PDA
      customerPda3TokenAccount = getAssociatedTokenAddressSync(
        testMint,
        customerPda3, // owner is customer PDA
        true, // allowOwnerOffCurve: true for PDA
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
  
      // Check if ATA exists, if not create it
      try {
        await getAccount(provider.connection, customerPda3TokenAccount);
      } catch (error: any) {
        const createAtaIx = createAssociatedTokenAccountInstruction(
          approver.publicKey,
          customerPda3TokenAccount,
          customerPda3, // owned by customer PDA
          testMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
        const createTx = new Transaction().add(createAtaIx);
        await provider.sendAndConfirm(createTx, [approver]);
      }
  
      // Mint tokens to this ATA
      await mintTo(
        provider.connection,
        approver,
        testMint,
        customerPda3TokenAccount,
        approver,
        1_500_000
      );
    });
  
    it("Happy path: New customer PDA ATA as approver_token_account", async () => {
      const initialBalance = await getAccount(provider.connection, customerPda3TokenAccount);
      const initialRecipientBalance = await getAccount(provider.connection, testRecipientTokenAccount);
  
      const transferAmount = 200_000;
  
      // Transfer using customer's ATA as approver_token_account
      // The ATA is owned by delegate PDA, so it can transfer directly
      await program.methods
        .spendTokens(randomSeed3, new BN(transferAmount))
        .accounts({
          orbitWallet: provider.wallet.publicKey,
          managerWallet: managerWalletKeypair.publicKey,
          approverTokenAccount: customerPda3TokenAccount, // Customer's ATA owned by delegate
          recipientTokenAccount: testRecipientTokenAccount,
          spender: customerPda3,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([provider.wallet.payer, managerWalletKeypair])
        .rpc();
  
      const finalBalance = await getAccount(provider.connection, customerPda3TokenAccount);
      const finalRecipientBalance = await getAccount(provider.connection, testRecipientTokenAccount);
  
      assert.equal(
        Number(finalBalance.amount),
        Number(initialBalance.amount) - transferAmount,
        "Customer ATA balance should decrease"
      );
      assert.equal(
        Number(finalRecipientBalance.amount),
        Number(initialRecipientBalance.amount) + transferAmount,
        "Recipient balance should increase"
      );
    });
  
    it("Sad path: wrong recipient token account", async () => {
      const transferAmount = 200_000;
      // Create a wrong recipient (different from the expected recipientOwner)
      const wrongRecipientOwner = Keypair.generate().publicKey;
      const wrongRecipientTokenAccountAta = getAssociatedTokenAddressSync(
        testMint,
        wrongRecipientOwner,
        false, // allowOwnerOffCurve: false for regular keypair
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
  
      // Create and initialize the ATA for the wrong recipient
      try {
        await getAccount(provider.connection, wrongRecipientTokenAccountAta);
      } catch (error: any) {
        // ATA doesn't exist, create it
        const createAtaIx = createAssociatedTokenAccountInstruction(
          approver.publicKey, // payer
          wrongRecipientTokenAccountAta, // ata
          wrongRecipientOwner, // owner (wrong recipient)
          testMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
        const createTx = new Transaction().add(createAtaIx);
        await provider.sendAndConfirm(createTx, [approver]);
      }
  
      try {
        await program.methods
          .spendTokens(randomSeed3, new BN(transferAmount))
          .accounts({
            orbitWallet: provider.wallet.publicKey,
            managerWallet: managerWalletKeypair.publicKey,
            approverTokenAccount: customerPda3TokenAccount,
            recipientTokenAccount: wrongRecipientTokenAccountAta,
            spender: customerPda3,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([provider.wallet.payer, managerWalletKeypair])
          .rpc();
        assert.fail("Should have failed with wrong recipient token account");
      } catch (err: any) {
        assert(
          err.logs.some((l: string) => l.includes("ConstraintOwner") || l.includes("failed")),
          "Expected recipient token account owner constraint violation"
        );
      }
    });
  
    it("Sad path: wrong PDA", async () => {
      const transferAmount = 200_000;
      // Create a wrong PDA with different seeds (not matching the user_id)
      const wrongSeed = `wrong_customer_${Math.random().toString(36).substring(7)}`;
      const [wrongPda, _] = PublicKey.findProgramAddressSync(
        [Buffer.from(pdaRoot), Buffer.from(wrongSeed)],
        program.programId
      );
  
      // Create ATA for the wrong PDA
      const wrongPdaTokenAccount = getAssociatedTokenAddressSync(
        testMint,
        wrongPda,
        true, // allowOwnerOffCurve: true for PDA
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
  
      // Check if ATA exists, if not create it
      try {
        await getAccount(provider.connection, wrongPdaTokenAccount);
      } catch (error: any) {
        const createAtaIx = createAssociatedTokenAccountInstruction(
          approver.publicKey,
          wrongPdaTokenAccount,
          wrongPda, // owned by wrong PDA
          testMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
        const createTx = new Transaction().add(createAtaIx);
        await provider.sendAndConfirm(createTx, [approver]);
      }
  
      // Mint tokens to the wrong PDA's ATA
      await mintTo(
        provider.connection,
        approver,
        testMint,
        wrongPdaTokenAccount,
        approver,
        1_000_000 // 1,000 tokens
      );
      
      try {
        await program.methods
          .spendTokens(randomSeed3, new BN(transferAmount))
          .accounts({
            orbitWallet: provider.wallet.publicKey,
            managerWallet: managerWalletKeypair.publicKey,
            approverTokenAccount: wrongPdaTokenAccount,
            recipientTokenAccount: testRecipientTokenAccount,
            spender: wrongPda,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([provider.wallet.payer, managerWalletKeypair])
          .rpc();
        assert.fail("Should have failed with wrong PDA");
      } catch (err: any) {
        assert(
          err.logs.some((l: string) => l.includes("failed") || l.includes("ConstraintSeeds") || l.includes("seeds")),
          "Expected PDA mismatch"
        );
      }
  
      try {
        await program.methods
          .spendTokens(randomSeed3, new BN(transferAmount))
          .accounts({
            orbitWallet: provider.wallet.publicKey,
            managerWallet: managerWalletKeypair.publicKey,
            approverTokenAccount: customerPda3TokenAccount,
            recipientTokenAccount: testRecipientTokenAccount,
            spender: wrongPda,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([provider.wallet.payer, managerWalletKeypair])
          .rpc();
        assert.fail("Should have failed with wrong PDA");
      } catch (err: any) {
        const logs = err.logs ?? [];
        assert(
          logs.some((l: string) => l.includes("failed") || l.includes("ConstraintSeeds") || l.includes("seeds")),
          "Expected PDA mismatch"
        );
      }
  
      try {
        await program.methods
          .spendTokens(randomSeed3, new BN(transferAmount))
          .accounts({
            orbitWallet: provider.wallet.publicKey,
            managerWallet: managerWalletKeypair.publicKey,
            approverTokenAccount: wrongPdaTokenAccount,
            recipientTokenAccount: testRecipientTokenAccount,
            spender: customerPda3,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([provider.wallet.payer, managerWalletKeypair])
          .rpc();
        assert.fail("Should have failed with wrong PDA");
      } catch (err: any) {
        assert(
          err.logs.some((l: string) => l.includes("failed") || l.includes("ConstraintSeeds") || l.includes("seeds")),
          "Expected PDA mismatch"
        );
      }
    });
  
    it("Sad path: transaction not signed by the contract owner", async () => {
      const transferAmount = 200_000;
      // Create a capable signer (with funds) who is NOT the contract owner
      const capableSigner = Keypair.generate();
      const contractOwner = provider.wallet.publicKey;
      
      // Ensure the capable signer is not the contract owner
      assert.notEqual(
        capableSigner.publicKey.toString(),
        contractOwner.toString(),
        "Capable signer should be different from contract owner"
      );
      
      // Airdrop funds to the capable signer so they can sign transactions
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
          capableSigner.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        )
      );
      
      try {
        // Build the instruction with capableSigner as orbitWallet (should fail)
        const instruction = await program.methods
          .spendTokens(randomSeed3, new BN(transferAmount))
          .accounts({
            orbitWallet: capableSigner.publicKey, // Wrong owner - should fail
            managerWallet: managerWalletKeypair.publicKey,
            approverTokenAccount: customerPda3TokenAccount,
            recipientTokenAccount: testRecipientTokenAccount,
            spender: customerPda3,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();
        
        // Build transaction with capableSigner as fee payer
        const transaction = new Transaction().add(instruction);
        transaction.feePayer = capableSigner.publicKey;
        
        // Get recent blockhash
        const { blockhash } = await provider.connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        
        // Sign and send the transaction (manager signs, but orbit wallet is wrong)
        transaction.sign(capableSigner, managerWalletKeypair);
        const signature = await provider.connection.sendRawTransaction(transaction.serialize());
        await provider.connection.confirmTransaction(signature);
        
        assert.fail("Should have failed with transaction not signed by the contract owner");
      } catch (err: any) {
        assert(
          err.logs?.some((l: string) => l.includes("failed") || l.includes("ConstraintSigner") || l.includes("signer")) || 
          err.message?.includes("failed") || 
          err.message?.includes("ConstraintSigner") ||
          err.message?.includes("signer"),
          "Expected transaction not signed by the contract owner"
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

  const orbitWallet = provider.wallet.payer;

  before(async () => {
    userId = `user_${Math.random().toString(36).substring(7)}`;
    [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(pdaRoot), Buffer.from(userId)],
      program.programId
    );

    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        orbitWallet.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      )
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        managerWalletKeypair.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      )
    );

    testMint = await createMint(
      provider.connection,
      orbitWallet,
      orbitWallet.publicKey,
      null,
      6
    );

    pdaTokenAccount = getAssociatedTokenAddressSync(
      testMint,
      pda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    try {
      await getAccount(provider.connection, pdaTokenAccount);
    } catch {
      const createAtaIx = createAssociatedTokenAccountInstruction(
        orbitWallet.publicKey,
        pdaTokenAccount,
        pda,
        testMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const createTx = new Transaction().add(createAtaIx);
      await provider.sendAndConfirm(createTx, [orbitWallet]);
    }

    await mintTo(
      provider.connection,
      orbitWallet,
      testMint,
      pdaTokenAccount,
      orbitWallet,
      2_000_000
    );

    destinationWallet = Keypair.generate();
    walletTokenAccount = getAssociatedTokenAddressSync(
      testMint,
      destinationWallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    try {
      await getAccount(provider.connection, walletTokenAccount);
    } catch {
      const createAtaIx = createAssociatedTokenAccountInstruction(
        orbitWallet.publicKey,
        walletTokenAccount,
        destinationWallet.publicKey,
        testMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const createTx = new Transaction().add(createAtaIx);
      await provider.sendAndConfirm(createTx, [orbitWallet]);
    }
  });

  it("Happy path: transfer from PDA token account to wallet token account", async () => {
    const transferAmount = 200_000;
    const initialPdaBalance = await getAccount(
      provider.connection,
      pdaTokenAccount
    );
    const initialWalletBalance = await getAccount(
      provider.connection,
      walletTokenAccount
    );

    const message = `${DOMAIN_SEPARATOR}::${destinationWallet.publicKey.toBase58()}`;
    const { ed25519Ix, signature } = buildEd25519Ix(message, orbitWallet);

    await program.methods
      .transferPdaToWallet(
        userId,
        destinationWallet.publicKey,
        new BN(transferAmount),
        Buffer.from(signature).toJSON().data
      )
      .accounts({
        orbitWallet: orbitWallet.publicKey,
        managerWallet: managerWalletKeypair.publicKey,
        pda,
        pdaTokenAccount,
        walletTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
      .signers([orbitWallet, managerWalletKeypair])
      .rpc();

    const finalPdaBalance = await getAccount(
      provider.connection,
      pdaTokenAccount
    );
    const finalWalletBalance = await getAccount(
      provider.connection,
      walletTokenAccount
    );

    assert.equal(
      Number(finalPdaBalance.amount),
      Number(initialPdaBalance.amount) - transferAmount,
      "PDA token account balance should decrease"
    );
    assert.equal(
      Number(finalWalletBalance.amount),
      Number(initialWalletBalance.amount) + transferAmount,
      "Destination wallet token account balance should increase"
    );
  });

  it("Sad path: User should not be able to withdraw if orbit wallet has not signed on the signature in pre instruction", async () => {
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
          Buffer.from(signature).toJSON().data
        )
        .accounts({
          orbitWallet: orbitWallet.publicKey,
          managerWallet: managerWalletKeypair.publicKey,
          pda,
          pdaTokenAccount,
          walletTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .signers([orbitWallet, managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed when orbit wallet did not sign the pre instruction");
    } catch (err: unknown) {
      const logs = (err as { logs?: string[] })?.logs ?? [];
      const msg = (err as Error)?.message ?? "";
      assert(
        logs.some(
          (l: string) =>
            l.includes("InvalidInstructionData") ||
            l.includes("failed") ||
            l.includes("0x0")
        ) || msg.includes("InvalidInstructionData") || msg.includes("failed"),
        "Expected signature verification to fail when signer is not orbit wallet"
      );
    }
  });

  it("Sad path: User should not be able to withdraw if insufficient funds are present in PDA", async () => {
    const pdaBalance = await getAccount(provider.connection, pdaTokenAccount);
    const transferAmount = Number(pdaBalance.amount) + 1_000_000;

    const message = `${DOMAIN_SEPARATOR}::${destinationWallet.publicKey.toBase58()}`;
    const { ed25519Ix, signature } = buildEd25519Ix(message, orbitWallet);

    try {
      await program.methods
        .transferPdaToWallet(
          userId,
          destinationWallet.publicKey,
          new BN(transferAmount),
          Buffer.from(signature).toJSON().data
        )
        .accounts({
          orbitWallet: orbitWallet.publicKey,
          managerWallet: managerWalletKeypair.publicKey,
          pda,
          pdaTokenAccount,
          walletTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .signers([orbitWallet, managerWalletKeypair])
        .rpc();
      assert.fail("Should have failed with insufficient funds in PDA");
    } catch (err: unknown) {
      const logs = (err as { logs?: string[] })?.logs ?? [];
      const msg = (err as Error)?.message ?? "";
      assert(
        logs.some(
          (l: string) =>
            l.includes("insufficient") ||
            l.includes("0x1") ||
            l.includes("failed")
        ) || msg.includes("insufficient") || msg.includes("failed"),
        "Expected insufficient funds error"
      );
    }
  });

  it("Sad path: User should not be ablet to withdraw if wallet address is not owner of wallet token account", async () => {
    const wrongWallet = Keypair.generate();
    const message = `${DOMAIN_SEPARATOR}::${wrongWallet.publicKey.toBase58()}`;
    const { ed25519Ix, signature } = buildEd25519Ix(message, orbitWallet);
    const transferAmount = 100_000;
    try {
      await program.methods
        .transferPdaToWallet(
          userId,
          wrongWallet.publicKey,
          new BN(transferAmount),
          Buffer.from(signature).toJSON().data
        )
        .accounts({
          orbitWallet: orbitWallet.publicKey,
          managerWallet: managerWalletKeypair.publicKey,
          pda,
          pdaTokenAccount,
          walletTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .signers([orbitWallet, managerWalletKeypair])
        .rpc();
    } catch (err: unknown) {
      const logs = (err as { logs?: string[] })?.logs ?? [];
      const msg = (err as Error)?.message ?? "";
      assert(
        logs.some(
          (l: string) =>
            l.includes("ConstraintOwner") ||
            l.includes("failed")
      ),
        "Expected wallet address is not owner of wallet token account"
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

  
    const approver = provider.wallet.payer; 
    let orbitWalletTokenAccount: PublicKey;


    let testMint: PublicKey;


  
    before(async () => {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
          approver.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        )
      );
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
          managerWalletKeypair.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        )
      );
      testMint = await createMint(
        provider.connection,
        approver,
        approver.publicKey,
        null,
        6 // decimals
      );
      // Create approver token account (ATA for orbit wallet)
      orbitWalletTokenAccount = getAssociatedTokenAddressSync(
        testMint,
        provider.wallet.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      
      // Check if ATA exists, if not create it
      try {
        await getAccount(provider.connection, orbitWalletTokenAccount);
      } catch (error: any) {
        const createAtaIx = createAssociatedTokenAccountInstruction(
          approver.publicKey,
          orbitWalletTokenAccount,
          provider.wallet.publicKey,
          testMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
        const createTx = new Transaction().add(createAtaIx);
        await provider.sendAndConfirm(createTx, [approver]);
      }
      
      // Mint tokens to approver token account
      await mintTo(
        provider.connection,
        approver,
        testMint,
        orbitWalletTokenAccount,
        approver,
        2_000_000 // 2,000 tokens
      );
      
      // Create recipient account
      recipientAccount = Keypair.generate();
      
      // Create recipient token account for the test mint
      recipientTokenAccount = await createAccount(
        provider.connection,
        approver,
        testMint,
        recipientAccount.publicKey
      );
  
    });

    it("Happy path: Transfer to LP", async () => {
      const transferAmount = 200_000;
      const initialBalance = await getAccount(provider.connection, orbitWalletTokenAccount);
      const initialRecipientBalance = await getAccount(provider.connection, recipientTokenAccount);
      await program.methods
        .transferToLp(new BN(transferAmount))
        .accounts({
          orbitWallet: provider.wallet.publicKey,
          managerWallet: managerWalletKeypair.publicKey,
          orbitWalletTokenAccount: orbitWalletTokenAccount,
          lpTokenAccount: recipientTokenAccount,
        })
        .signers([provider.wallet.payer, managerWalletKeypair])
        .rpc();
      const finalBalance = await getAccount(provider.connection, orbitWalletTokenAccount);
      const finalRecipientBalance = await getAccount(provider.connection, recipientTokenAccount);
      assert.equal(
        Number(finalBalance.amount),
        Number(initialBalance.amount) - transferAmount,
        "Customer ATA balance should decrease"
      );
      assert.equal(
        Number(finalRecipientBalance.amount),
        Number(initialRecipientBalance.amount) + transferAmount,
        "Recipient balance should increase"
      );
    });

    it("Sad path: wrong recipeint mint address", async () => {
      const transferAmount = 200_000;

      try {
        //Create a new mint account for the recipient token 
        const otherMint = await createMint(
          provider.connection,
          approver,
          approver.publicKey,
          null,
          6 // decimals
        );
        const otherRecipientTokenAccount = await createAccount(
          provider.connection,
          approver,
          otherMint,
          recipientAccount.publicKey
        );
        await program.methods
          .transferToLp(new BN(transferAmount))
          .accounts({
            orbitWallet: provider.wallet.publicKey,
            managerWallet: managerWalletKeypair.publicKey,
            orbitWalletTokenAccount: orbitWalletTokenAccount,
            lpTokenAccount: otherRecipientTokenAccount,
          })
          .signers([provider.wallet.payer, managerWalletKeypair])
          .rpc();
        assert.fail("Should have failed with wrong recipient mint address");
      } catch (err: any) {
        assert(
          err.logs.some((l: string) => l.includes("ConstraintTokenMint.")),
          "Expected recipient mint address mismatch"
        );
      }
    });

    it("Sad path: signer is not the orbit wallet", async () => {
      const transferAmount = 200_000;
      const otherSigner = Keypair.generate();
      try {
        await program.methods
          .transferToLp(new BN(transferAmount))
          .accounts({
            orbitWallet: otherSigner.publicKey,
            managerWallet: managerWalletKeypair.publicKey,
            orbitWalletTokenAccount: orbitWalletTokenAccount,
            lpTokenAccount: recipientTokenAccount,
          })
          .signers([otherSigner, managerWalletKeypair])
          .rpc();
        assert.fail("Should have failed with signer is not the orbit wallet");
      } catch (err: any) {
        assert(
          err.logs.some((l: string) => l.includes("ConstraintOwner")),
          "Expected signer is not the orbit wallet"
        );
      }
    });
  });

describe("deposit tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ZynkOrbit as Program;

  const receiverOwner = new PublicKey("GbNjfHHBLFn3epGUwKQacbTD4YBqAMLNHHtKRNATHaep");

  let mint: PublicKey;
  let spenderTokenAccount: PublicKey;
  let receiverTokenAccount: PublicKey;

  const spender = Keypair.generate();

  before(async () => {
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(spender.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
    );

    mint = await createMint(provider.connection, spender, spender.publicKey, null, 6);

    spenderTokenAccount = await createAccount(provider.connection, spender, mint, spender.publicKey);
    await mintTo(provider.connection, spender, mint, spenderTokenAccount, spender, 1_000_000);

    receiverTokenAccount = await createAccount(provider.connection, spender, mint, receiverOwner);
  });

  it("Happy path: spender deposits tokens into receiver", async () => {
    const depositAmount = 250_000;

    const spenderBefore = await getAccount(provider.connection, spenderTokenAccount);
    const receiverBefore = await getAccount(provider.connection, receiverTokenAccount);

    const requestId = "req-1";
    
    const listener = program.addEventListener("depositEvent", (event, _slot) => {
      try {
        assert.equal(event.domainSeparator.toNumber(), DOMAIN_SEPARATOR)
        assert.equal(event.spender.toBase58(), spender.publicKey.toBase58())
        assert.equal(event.receiver.toBase58(), receiverOwner.toBase58())
        assert.equal(event.amount.toNumber(), depositAmount)
        assert.equal(event.requestId, requestId)
      } catch (err) {
        throw err;
      }
    });
    
    await program.methods
      .deposit(new BN(depositAmount), requestId)
      .accounts({
        spender: spender.publicKey,
        spenderTokenAccount,
        receiverTokenAccount,
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
      await provider.connection.requestAirdrop(randomSpender.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
    );
    const randomSpenderAta = await createAccount(provider.connection, randomSpender, mint, randomSpender.publicKey);
    await mintTo(provider.connection, randomSpender, mint, randomSpenderAta, spender, 500_000);

    const requestId = "req-2";
    
    const listener = program.addEventListener("depositEvent", (event, _slot) => {
      try {
        assert.equal(event.domainSeparator.toNumber(), DOMAIN_SEPARATOR)
        assert.equal(event.spender.toBase58(), randomSpender.publicKey.toBase58())
        assert.equal(event.receiver.toBase58(), receiverOwner.toBase58())
        assert.equal(event.amount.toNumber(), depositAmount)
        assert.equal(event.requestId, requestId)
      } catch (err) {
        throw err;
      }
    });
    
    await program.methods
      .deposit(new BN(depositAmount), requestId)
      .accounts({
        spender: randomSpender.publicKey,
        spenderTokenAccount: randomSpenderAta,
        receiverTokenAccount,
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
      await provider.connection.requestAirdrop(interloper.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
    );

    const requestId = "req-3";
    try {
      // interloper passes their key as `spender` but spenderTokenAccount belongs to `spender`
      await program.methods
        .deposit(new BN(10_000), requestId)
        .accounts({
          spender: interloper.publicKey,
          spenderTokenAccount,           // owned by `spender`, not interloper
          receiverTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([interloper])
        .rpc();
      assert.fail("Should have failed: interloper cannot sign for a token account they don't own");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("failed") || l.includes("ConstraintOwner")),
        "Expected owner constraint failure"
      );
    }
  });

  it("Sad path: receiver token account not owned by hardcoded receiver address", async () => {
    const fakeReceiverOwner = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(fakeReceiverOwner.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
    );
    const fakeReceiverTokenAccount = await createAccount(
      provider.connection,
      fakeReceiverOwner,
      mint,
      fakeReceiverOwner.publicKey
    );

    const requestId = "req-4";
    try {
      await program.methods
        .deposit(new BN(10_000), requestId)
        .accounts({
          spender: spender.publicKey,
          spenderTokenAccount,
          receiverTokenAccount: fakeReceiverTokenAccount, // not owned by hardcoded receiver
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([spender])
        .rpc();
      assert.fail("Should have failed: receiver token account not owned by hardcoded receiver address");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("ConstraintOwner") || l.includes("failed")),
        "Expected receiver owner constraint failure"
      );
    }
  });

  it("Sad path: insufficient balance", async () => {
    const broke = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(broke.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
    );
    const brokeAta = await createAccount(provider.connection, broke, mint, broke.publicKey);
    // mint only 50 tokens but try to deposit 1000
    await mintTo(provider.connection, broke, mint, brokeAta, spender, 50);

    const requestId = "req-4";
    try {
      await program.methods
        .deposit(new BN(1_000), requestId)
        .accounts({
          spender: broke.publicKey,
          spenderTokenAccount: brokeAta,
          receiverTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([broke])
        .rpc();
      assert.fail("Should have failed: insufficient token balance");
    } catch (err: any) {
      const logs = err.logs ?? [];
      assert(
        logs.some((l: string) => l.includes("failed")),
        "Expected insufficient funds error"
      );
    }
  });
});
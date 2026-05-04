import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createMint,
  mintTo,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  createAssociatedTokenAccount,
} from "@solana/spl-token";
import { ZynkCore } from "../target/types/zynk_core";
import { assert, expect } from "chai";
import { createHash, randomUUID } from "crypto";
import { TextEncoder } from "util";
import { sha256 } from "@noble/hashes/sha2";
import nacl from "tweetnacl";

const zynkPartnerId = `zp_32142`;
const generateOrderId = (): Buffer => {
  const transactionId = `txn_${randomUUID()}`;

  const orderKey = `${zynkPartnerId}::${transactionId}`;
  const hash = createHash("sha256").update(orderKey).digest("hex");

  return Buffer.from(hash.slice(0, 32));
};

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

const DOMAIN_SEPARATOR = 1151111081099710;
const MAX_U64 = "18446744073709551615";

const TimelockAction = {
  UpdateAdmin: 0,
  UpdateManager: 1,
  UpdateGuardian: 2,
  UpdateAttester: 3,
  Unpause: 4,
};

const timelockDelays = {
  [TimelockAction.UpdateAdmin]: 24 * 60 * 60,
  [TimelockAction.UpdateManager]: 12 * 60 * 60,
  [TimelockAction.UpdateGuardian]: 48 * 60 * 60,
  [TimelockAction.UpdateAttester]: 12 * 60 * 60,
  [TimelockAction.Unpause]: 6 * 60 * 60,
};

describe("zynk-core", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ZynkCore as Program<ZynkCore>;

  const admin = Keypair.generate();
  const manager = provider.wallet.payer;
  const guardian = Keypair.generate();
  const attester = provider.wallet.payer;
  const partnerOperationalWallet = Keypair.generate();

  const defaultZovId = Buffer.alloc(32);
  defaultZovId.write("default", 0, "utf-8");
  const [zynkOpVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("zynk_op_vault"), defaultZovId],
    program.programId
  );

  const zeroZovId = Buffer.alloc(32);
  const [zZynkOpVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("zynk_op_vault"), zeroZovId],
    program.programId
  );

  // Partner ID for PDA derivation (32 bytes)
  const partnerId = Buffer.alloc(32);
  partnerId.write(zynkPartnerId, 0, "utf-8");

  // Partner deposit vault PDA
  const [partnerDepositVaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("partner_deposit_vault"), partnerId],
    program.programId
  );

  // Config account PDA (to be initialized)
  const [configPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("config::v4")],
    program.programId
  );

  // Token accounts
  let tokenMint: PublicKey;
  let tokenMint2: PublicKey;
  let tokenMint3: PublicKey;
  let invalidTokenMint: PublicKey; // Token not in whitelist

  let atas: Record<string, PublicKey>;

  let timelockPDA: PublicKey;

  let currentOrderId: Buffer;
  let currentOrderTrackerPDA: PublicKey;

  // Helper to derive order tracker PDA
  const deriveOrderTrackerPDA = (
    _orderId: Buffer,
    _partnerId: Buffer | string = partnerId
  ): PublicKey => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("order_tracker"),
        typeof _partnerId === "string" ? Buffer.from(_partnerId) : _partnerId,
        _orderId,
      ],
      program.programId
    )[0];
  };

  const deriveBeneficiaryPDA = (
    _publicKey: PublicKey | string = partnerOperationalWallet.publicKey,
    _partnerId: Buffer | string = partnerId
  ): PublicKey => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("beneficiary"),
        typeof _partnerId === "string" ? Buffer.from(_partnerId) : _partnerId,
        typeof _publicKey === "string"
          ? Buffer.from(_publicKey)
          : _publicKey.toBuffer(),
      ],
      program.programId
    )[0];
  };
  const defaultBeneficiaryPDA = deriveBeneficiaryPDA();

  const gocAta = async (
    owner: PublicKey,
    mint: PublicKey,
    tokenProgramId = TOKEN_PROGRAM_ID
  ) => {
    const { address } = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      manager,
      mint,
      owner,
      true, // allowOwnerOffCurve
      undefined,
      undefined,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    let minted = false;
    while (!minted) {
      try {
        await mintTo(
          provider.connection,
          manager,
          mint,
          address,
          manager.publicKey,
          10000000000000,
          undefined,
          undefined,
          tokenProgramId
        );

        minted = true;
      } catch (error) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * 5000)
        );
      }
    }

    return address;
  };

  let whitelistedTokenMints: PublicKey[] = [];

  before(async () => {
    try {
      const configAccount = await program.account.config.fetch(configPDA);
      whitelistedTokenMints = configAccount.whitelistedTokenMints;
      [tokenMint, tokenMint2, tokenMint3] = whitelistedTokenMints;
    } catch (error) {
      // Airdrop SOL to test wallets for transactions
      for (const kp of [admin, manager, guardian, partnerOperationalWallet]) {
        const tx = await provider.connection.requestAirdrop(
          kp.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(tx, "confirmed");
      }

      // Create test tokens (using admin as mint authority)
      tokenMint = await createMint(
        provider.connection,
        manager,
        manager.publicKey,
        null,
        9
      );

      tokenMint2 = await createMint(
        provider.connection,
        manager,
        manager.publicKey,
        null,
        9
      );

      tokenMint3 = await createMint(
        provider.connection,
        manager,
        manager.publicKey,
        null,
        9,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      whitelistedTokenMints = [tokenMint, tokenMint2, tokenMint3];
    }

    // Create invalid token mint (not in whitelist)
    invalidTokenMint = await createMint(
      provider.connection,
      manager,
      manager.publicKey,
      null,
      9
    );

    const owners = {
      zov: zynkOpVault,
      zZov: zZynkOpVault,
      partnerOperational: partnerOperationalWallet.publicKey,
      partnerDeposit: partnerDepositVaultPDA,
    };

    atas = Object.fromEntries(
      (
        await Promise.all(
          Object.entries(owners).map(async ([ownerKey, owner]) =>
            Promise.all(
              [...whitelistedTokenMints, invalidTokenMint].map(
                async (mint, idx) => {
                  const _key = `${ownerKey}TokenAccount${
                    idx === 0 ? "" : idx === 3 ? "Invalid" : idx + 1
                  }`;

                  return [
                    _key,
                    await gocAta(
                      owner,
                      mint,
                      idx === 2 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
                    ),
                  ];
                }
              )
            )
          )
        )
      ).flat()
    );
  });

  it("Should fail to initialize with empty whitelisted token mints vector", async () => {
    const whitelistedTokenMints: PublicKey[] = [];

    try {
      await program.methods
        .initialize(
          admin.publicKey,
          guardian.publicKey,
          attester.publicKey,
          whitelistedTokenMints
        )
        .accounts({
          config: configPDA,
          manager: manager.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected initialize to fail with empty token mints vector");
    } catch (error) {
      assert.include(
        error.message,
        "EmptyWhitelistedTokenMints",
        "Expected EmptyWhitelistedTokenMints error"
      );
    }
  });

  it("Should fail to initialize with invalid token mint address in vector", async () => {
    // Create a vector with a null/default PublicKey (invalid address)
    const invalidTokenMint = PublicKey.default;
    const whitelistedTokenMints: PublicKey[] = [invalidTokenMint];

    try {
      await program.methods
        .initialize(
          admin.publicKey,
          guardian.publicKey,
          attester.publicKey,
          whitelistedTokenMints
        )
        .accounts({
          config: configPDA,
          manager: manager.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail(
        "Expected initialize to fail with invalid token mint address"
      );
    } catch (error) {
      assert.include(
        error.message,
        "InvalidAddress",
        "Expected InvalidAddress error"
      );
    }
  });

  it("Should fail to initialize with duplicate token mints in vector", async () => {
    const whitelistedTokenMints: PublicKey[] = [tokenMint, tokenMint];
    try {
      await program.methods
        .initialize(
          admin.publicKey,
          guardian.publicKey,
          attester.publicKey,
          whitelistedTokenMints
        )
        .accounts({
          config: configPDA,
          manager: manager.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected initialize to fail with duplicate token mints");
    } catch (error) {
      assert.include(
        error.message,
        "DuplicateWhitelistedTokenMint",
        "Expected DuplicateWhitelistedTokenMint error"
      );
    }
  });

  it("Initializes the protocol with multiple token addresses", async () => {
    await program.methods
      .initialize(
        admin.publicKey,
        guardian.publicKey,
        attester.publicKey,
        whitelistedTokenMints
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Verify config account fields
    const configAccount = await program.account.config.fetch(configPDA);
    assert.ok(configAccount.admin.equals(admin.publicKey));
    assert.ok(configAccount.manager.equals(manager.publicKey));
    assert.ok(configAccount.guardian.equals(guardian.publicKey));
    assert.ok(configAccount.attester.equals(attester.publicKey));
    assert.equal(configAccount.paused, false);

    // Verify all token mints are stored correctly
    assert.equal(
      configAccount.whitelistedTokenMints.length,
      3,
      "Should have 3 token mints"
    );
    assert.ok(
      configAccount.whitelistedTokenMints[0].equals(tokenMint),
      "First token mint should match"
    );
    assert.ok(
      configAccount.whitelistedTokenMints[1].equals(tokenMint2),
      "Second token mint should match"
    );
  });

  it("Should whitelist partnerOperationalWallet as beneficiary - transient disabled", async () => {
    try {
      await program.account.beneficiary.fetch(defaultBeneficiaryPDA);
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected `Account does not exist` error"
      );
    }

    await program.methods
      .whitelistBeneficiary(
        Array.from(partnerId),
        partnerOperationalWallet.publicKey,
        false // !allowTransient
      )
      .accounts({
        config: configPDA,
        beneficiary: defaultBeneficiaryPDA,
        authority: guardian.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([guardian])
      .rpc();

    const beneficiary = await program.account.beneficiary.fetch(
      defaultBeneficiaryPDA
    );
    assert.ok(beneficiary.publicKey.equals(partnerOperationalWallet.publicKey));
    assert.ok(beneficiary.isActive);
  });

  it("Should fail creating transient order when transient disabled", async () => {
    const amount = new anchor.BN(0);

    currentOrderId = generateOrderId();
    currentOrderTrackerPDA = deriveOrderTrackerPDA(currentOrderId);

    try {
      await program.methods
        .createOrder(
          Array.from(partnerId),
          Array.from(currentOrderId),
          Array.from(defaultZovId),
          true, // transient
          amount,
          null
        )
        .accounts({
          config: configPDA,
          manager: manager.publicKey,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount,
          zynkOpVault: zynkOpVault,
          zovTokenAccount: atas.zovTokenAccount,
          beneficiary: defaultBeneficiaryPDA,
          beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
          orderTracker: currentOrderTrackerPDA,
          systemProgram: SystemProgram.programId,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          sysvarInstructions: null,
        })
        .signers([manager])
        .rpc();
    } catch (error) {
      assert.include(
        error.message,
        "InvalidBeneficiary",
        "Expected `InvalidBeneficiary` error"
      );
    }
  });

  it("Should be able to create transient pull order with attester signature provided - even when transient disabled", async () => {
    const amount = new anchor.BN(100000000000);

    const transientOrderId = generateOrderId();
    const transientOrderTrackerPDA = deriveOrderTrackerPDA(transientOrderId);

    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount
    );

    const message = `${DOMAIN_SEPARATOR}::${partnerOperationalWallet.publicKey.toString()}::${partnerDepositVaultPDA.toString()}::${zynkOpVault.toString()}`;
    const { ed25519Ix, signature } = buildEd25519Ix(message, attester);

    await program.methods
      .pullAndCreateOrder(
        Array.from(partnerId),
        Array.from(transientOrderId),
        Array.from(defaultZovId),
        false,
        amount,
        Buffer.from(signature).toJSON().data,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: transientOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
      .signers([manager])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    assert.equal(
      +sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount,
      +amount
    );

    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount
    );
    assert.equal(
      +destBalance_postTx.value.amount - +destBalance_preTx.value.amount,
      +amount
    );

    // Verify order is closed
    try {
      await program.account.orderTracker.fetch(transientOrderTrackerPDA);
      assert.fail("Expected order to be closed");
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected account to be closed"
      );
    }

    // try to replenish and/or close a transient order
    try {
      await program.methods
        .replenish(Array.from(transientOrderId), new anchor.BN(1), true, null)
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount,
          zovTokenAccount: atas.zovTokenAccount,
          orderTracker: transientOrderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected close order to fail for transient orders.");
    } catch (error) {
      assert.include(
        error.message,
        "AccountNotInitialized",
        "Expected AccountNotInitialized error when replenishing a closed order"
      );
    }
  });

  it("Should fail pullAndCreateOrder when amount is zero", async () => {
    const amount = new anchor.BN(0);

    currentOrderId = generateOrderId();
    currentOrderTrackerPDA = deriveOrderTrackerPDA(currentOrderId);

    try {
      await program.methods
        .pullAndCreateOrder(
          Array.from(partnerId),
          Array.from(currentOrderId),
          Array.from(defaultZovId),
          false,
          amount,
          null,
          null
        )
        .accounts({
          config: configPDA,
          manager: manager.publicKey,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount,
          zynkOpVault: zynkOpVault,
          zovTokenAccount: atas.zovTokenAccount,
          beneficiary: defaultBeneficiaryPDA,
          beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
          orderTracker: currentOrderTrackerPDA,
          systemProgram: SystemProgram.programId,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          sysvarInstructions: null,
        })
        .signers([manager])
        .rpc();
    } catch (error) {
      assert.include(
        error.message,
        "InvalidOrder",
        "Expected `InvalidOrder` error"
      );
    }
  });

  it("Pulls tokens from partner_deposit_vault to zynkOpVault and sends tokens from zynkOpVault to partner_operational_wallet", async () => {
    const amount = new anchor.BN(100000000000);

    currentOrderId = generateOrderId();
    currentOrderTrackerPDA = deriveOrderTrackerPDA(currentOrderId);

    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount
    );

    await program.methods
      .pullAndCreateOrder(
        Array.from(partnerId),
        Array.from(currentOrderId),
        Array.from(defaultZovId),
        false,
        amount,
        null,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: currentOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    assert.equal(
      +sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount,
      +amount
    );

    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount
    );
    assert.equal(
      +destBalance_postTx.value.amount - +destBalance_preTx.value.amount,
      +amount
    );

    // Verify OrderTracker stores correct partner deposit vault
    const orderTrackerAccount = await program.account.orderTracker.fetch(
      currentOrderTrackerPDA
    );
    assert.equal(
      orderTrackerAccount.partnerDepositVault.toBase58(),
      partnerDepositVaultPDA.toBase58()
    );
    assert.equal(
      orderTrackerAccount.beneficiaryWallet.toBase58(),
      partnerOperationalWallet.publicKey.toBase58()
    );

    const orderAmountIn = orderTrackerAccount.amountIn;
    const orderAmountOut = orderTrackerAccount.amountOut;
    assert.equal(orderAmountIn.toNumber(), amount.toNumber());
    assert.equal(orderAmountOut.toNumber(), amount.toNumber());
  });

  it("Creates order without transferring tokens, in case of zero amount", async () => {
    const amount = new anchor.BN(0);

    currentOrderId = generateOrderId();
    currentOrderTrackerPDA = deriveOrderTrackerPDA(currentOrderId);

    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(atas.zovTokenAccount);
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount
    );

    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(currentOrderId),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: currentOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx =
      await provider.connection.getTokenAccountBalance(atas.zovTokenAccount);
    assert.equal(
      +sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount,
      0
    );

    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount
    );
    assert.equal(
      +destBalance_postTx.value.amount - +destBalance_preTx.value.amount,
      0
    );

    // Verify OrderTracker stores correct details
    const orderTrackerAccount = await program.account.orderTracker.fetch(
      currentOrderTrackerPDA
    );
    assert.equal(
      orderTrackerAccount.partnerDepositVault.toBase58(),
      partnerDepositVaultPDA.toBase58()
    );
    assert.equal(
      orderTrackerAccount.beneficiaryWallet.toBase58(),
      partnerOperationalWallet.publicKey.toBase58()
    );

    const orderAmountIn = orderTrackerAccount.amountIn;
    const orderAmountOut = orderTrackerAccount.amountOut;
    assert.equal(orderAmountIn.toNumber(), 0);
    assert.equal(orderAmountOut.toNumber(), 0);
  });

  it("Should emit OrderCreated event with correct meta", async () => {
    const amount = new anchor.BN(0);
    const meta = [
      { key: "txType", value: "0" },
      { key: "txAmount", value: "100000000000" },
    ];

    const tempOrderId = generateOrderId();
    const tempOrderTrackerPDA = deriveOrderTrackerPDA(tempOrderId);

    const listener = program.addEventListener(
      "orderCreated",
      (event, _slot) => {
        if (!Buffer.from(event.orderId).equals(Buffer.from(tempOrderId)))
          return;

        try {
          assert.equal(event.domainSeparator.toNumber(), DOMAIN_SEPARATOR);
          assert.equal(event.token.toBase58(), tokenMint.toBase58());
          assert.equal(event.amount.toNumber(), amount.toNumber());
          // assert.equal(event.zynkOpVault.toBase58(), zynkOpVault.toBase58());
          assert.equal(
            event.partnerDepositVault.toBase58(),
            partnerDepositVaultPDA.toBase58()
          );
          assert.equal(
            event.beneficiaryWallet.toBase58(),
            partnerOperationalWallet.publicKey.toBase58()
          );

          assert.ok(event.meta, "Meta should be present");
          assert.lengthOf(
            event.meta,
            meta.length,
            `Meta should have ${meta.length} entries`
          );
          meta.forEach((item, idx) => {
            assert.strictEqual(event.meta[idx].key, item.key);
            assert.strictEqual(event.meta[idx].value, item.value);
          });
        } catch (err) {
          throw err;
        }
      }
    );

    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(tempOrderId),
        Array.from(defaultZovId),
        false,
        amount,
        meta
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: tempOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    await new Promise((resolve) => setTimeout(resolve, 1000));
    await program.removeEventListener(listener);
  });

  it("Sends tokens from zynkOpVault to partner_operational_wallet", async () => {
    const amount = new anchor.BN(100000000000);

    currentOrderId = generateOrderId();
    currentOrderTrackerPDA = deriveOrderTrackerPDA(currentOrderId);

    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(atas.zovTokenAccount);
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount
    );

    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(currentOrderId),
        Array.from(defaultZovId),
        false, // !transient
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: currentOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx =
      await provider.connection.getTokenAccountBalance(atas.zovTokenAccount);
    assert.equal(
      +sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount,
      +amount
    );

    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount
    );
    assert.equal(
      +destBalance_postTx.value.amount - +destBalance_preTx.value.amount,
      +amount
    );

    // Verify OrderTracker stores correct details
    const orderTrackerAccount = await program.account.orderTracker.fetch(
      currentOrderTrackerPDA
    );
    assert.equal(
      orderTrackerAccount.partnerDepositVault.toBase58(),
      partnerDepositVaultPDA.toBase58()
    );
    assert.equal(
      orderTrackerAccount.beneficiaryWallet.toBase58(),
      partnerOperationalWallet.publicKey.toBase58()
    );

    const orderAmountIn = orderTrackerAccount.amountIn;
    const orderAmountOut = orderTrackerAccount.amountOut;
    assert.equal(orderAmountIn.toNumber(), 0);
    assert.equal(orderAmountOut.toNumber(), amount.toNumber());
  });

  it("Should temporarily disable whitelisted partnerOperationalWallet as beneficiary", async () => {
    await program.methods
      .toggleBeneficiary()
      .accounts({
        config: configPDA,
        beneficiary: defaultBeneficiaryPDA,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const beneficiary = await program.account.beneficiary.fetch(
      defaultBeneficiaryPDA
    );
    assert.ok(beneficiary.publicKey.equals(partnerOperationalWallet.publicKey));
    assert.ok(!beneficiary.isActive);
  });

  it("Should fail creating order when beneficiary status is disabled", async () => {
    const amount = new anchor.BN(0);

    currentOrderId = generateOrderId();
    currentOrderTrackerPDA = deriveOrderTrackerPDA(currentOrderId);

    try {
      await program.methods
        .createOrder(
          Array.from(partnerId),
          Array.from(currentOrderId),
          Array.from(defaultZovId),
          false,
          amount,
          null
        )
        .accounts({
          config: configPDA,
          manager: manager.publicKey,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount,
          zynkOpVault: zynkOpVault,
          zovTokenAccount: atas.zovTokenAccount,
          beneficiary: defaultBeneficiaryPDA,
          beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
          orderTracker: currentOrderTrackerPDA,
          systemProgram: SystemProgram.programId,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          sysvarInstructions: null,
        })
        .signers([manager])
        .rpc();
    } catch (error) {
      assert.include(
        error.message,
        "InvalidBeneficiary",
        "Expected `InvalidBeneficiary` error"
      );
    }
  });

  it("Should revoke whitelisted partnerOperationalWallet as beneficiary", async () => {
    await program.methods
      .revokeBeneficiary()
      .accounts({
        config: configPDA,
        beneficiary: defaultBeneficiaryPDA,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    try {
      await program.account.beneficiary.fetch(defaultBeneficiaryPDA);
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected `Account does not exist` error"
      );
    }
  });

  it("Should whitelist partnerOperationalWallet as beneficiary - transient enabled", async () => {
    try {
      await program.account.beneficiary.fetch(defaultBeneficiaryPDA);
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected `Account does not exist` error"
      );
    }

    await program.methods
      .whitelistBeneficiary(
        Array.from(partnerId),
        partnerOperationalWallet.publicKey,
        true // allowTransient
      )
      .accounts({
        config: configPDA,
        beneficiary: defaultBeneficiaryPDA,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const beneficiary = await program.account.beneficiary.fetch(
      defaultBeneficiaryPDA
    );
    assert.ok(beneficiary.publicKey.equals(partnerOperationalWallet.publicKey));
    assert.ok(beneficiary.isActive);
  });

  it("Creates a transient pull order for partner_deposit_vault -> zynkOpVault -> partner_operational_wallet one-way txn - with no attester override", async () => {
    const amount = new anchor.BN(100000000000);

    const transientOrderId = generateOrderId();
    const transientOrderTrackerPDA = deriveOrderTrackerPDA(transientOrderId);

    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount
    );

    await program.methods
      .pullAndCreateOrder(
        Array.from(partnerId),
        Array.from(transientOrderId),
        Array.from(defaultZovId),
        true,
        amount,
        null,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: transientOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .signers([manager])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    assert.equal(
      +sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount,
      +amount
    );

    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount
    );
    assert.equal(
      +destBalance_postTx.value.amount - +destBalance_preTx.value.amount,
      +amount
    );

    // Verify order is closed
    try {
      await program.account.orderTracker.fetch(transientOrderTrackerPDA);
      assert.fail("Expected order to be closed");
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected account to be closed"
      );
    }

    // try to replenish and/or close a transient order
    try {
      await program.methods
        .replenish(Array.from(transientOrderId), new anchor.BN(1), true, null)
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount,
          zovTokenAccount: atas.zovTokenAccount,
          orderTracker: transientOrderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected close order to fail for transient orders.");
    } catch (error) {
      assert.include(
        error.message,
        "AccountNotInitialized",
        "Expected AccountNotInitialized error when replenishing a closed order"
      );
    }
  });

  it("Creates a transient pull order for partner_deposit_vault -> zynkOpVault -> partner_operational_wallet one-way txn - Token2022 - with no attester override", async () => {
    const amount = new anchor.BN(100000000000);

    const transientOrderId = generateOrderId();
    const transientOrderTrackerPDA = deriveOrderTrackerPDA(transientOrderId);

    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount3
      );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount3
    );

    await program.methods
      .pullAndCreateOrder(
        Array.from(partnerId),
        Array.from(transientOrderId),
        Array.from(defaultZovId),
        true, // transient
        amount,
        null,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount3,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount3,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount3,
        orderTracker: transientOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint3,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .signers([manager])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount3
      );
    assert.equal(
      +sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount,
      +amount
    );

    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount3
    );
    assert.equal(
      +destBalance_postTx.value.amount - +destBalance_preTx.value.amount,
      +amount
    );

    // Verify order is closed
    try {
      await program.account.orderTracker.fetch(transientOrderTrackerPDA);
      assert.fail("Expected order to be closed");
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected account to be closed"
      );
    }

    // try to replenish and/or close a transient order
    try {
      await program.methods
        .replenish(Array.from(transientOrderId), new anchor.BN(1), true, null)
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount3,
          zovTokenAccount: atas.zovTokenAccount3,
          orderTracker: transientOrderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint3,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected close order to fail for transient orders.");
    } catch (error) {
      assert.include(
        error.message,
        "AccountNotInitialized",
        "Expected AccountNotInitialized error when replenishing a closed order"
      );
    }
  });

  it("Creates a transient order for zynkOpVault to partner_operational_wallet one-way txn", async () => {
    const amount = new anchor.BN(100000000000);

    const transientOrderId = generateOrderId();
    const transientOrderTrackerPDA = deriveOrderTrackerPDA(transientOrderId);

    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(atas.zovTokenAccount);
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount
    );

    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(transientOrderId),
        Array.from(defaultZovId),
        true, // transient
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: transientOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .signers([manager])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx =
      await provider.connection.getTokenAccountBalance(atas.zovTokenAccount);
    assert.equal(
      +sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount,
      +amount
    );

    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount
    );
    assert.equal(
      +destBalance_postTx.value.amount - +destBalance_preTx.value.amount,
      +amount
    );

    // Verify order is closed
    try {
      await program.account.orderTracker.fetch(transientOrderTrackerPDA);
      assert.fail("Expected order to be closed");
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected account to be closed"
      );
    }

    // try to replenish and/or close a transient order
    try {
      await program.methods
        .replenish(Array.from(transientOrderId), new anchor.BN(1), true, null)
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount,
          zovTokenAccount: atas.zovTokenAccount,
          orderTracker: transientOrderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected close order to fail for transient orders.");
    } catch (error) {
      assert.include(
        error.message,
        "AccountNotInitialized",
        "Expected AccountNotInitialized error when replenishing a closed order"
      );
    }
  });

  it("Creates a transient order for zynkOpVault to partner_operational_wallet one-way txn - Token2022", async () => {
    const amount = new anchor.BN(100000000000);

    const transientOrderId = generateOrderId();
    const transientOrderTrackerPDA = deriveOrderTrackerPDA(transientOrderId);

    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(atas.zovTokenAccount3);
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount3
    );

    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(transientOrderId),
        Array.from(defaultZovId),
        true, // transient
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount3,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount3,
        orderTracker: transientOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint3,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .signers([manager])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx =
      await provider.connection.getTokenAccountBalance(atas.zovTokenAccount3);
    assert.equal(
      +sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount,
      +amount
    );

    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount3
    );
    assert.equal(
      +destBalance_postTx.value.amount - +destBalance_preTx.value.amount,
      +amount
    );

    // Verify order is closed
    try {
      await program.account.orderTracker.fetch(transientOrderTrackerPDA);
      assert.fail("Expected order to be closed");
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected account to be closed"
      );
    }

    // try to replenish and/or close a transient order
    try {
      await program.methods
        .replenish(Array.from(transientOrderId), new anchor.BN(1), true, null)
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount3,
          zovTokenAccount: atas.zovTokenAccount3,
          orderTracker: transientOrderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint3,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected close order to fail for transient orders.");
    } catch (error) {
      assert.include(
        error.message,
        "AccountNotInitialized",
        "Expected AccountNotInitialized error when replenishing a closed order"
      );
    }
  });

  it("Should fail closing order when amount_in is less than amount_out", async () => {
    // creating new order for further transactions
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(currentOrderId),
        Array.from(defaultZovId),
        false, // !transient
        new anchor.BN(1000000000000),
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: currentOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    const ot = await program.account.orderTracker.fetch(currentOrderTrackerPDA);

    const amount = new anchor.BN(50000000000);

    await program.methods
      .replenish(
        Array.from(currentOrderId),
        amount,
        false, // close_order = false (partial replenish)
        null
      )
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zovTokenAccount: atas.zovTokenAccount,
        orderTracker: currentOrderTrackerPDA,
        manager: manager.publicKey,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Now try to close with close_order=true, but amount_in (50) < amount_out (100)
    // Use a small positive amount since amount must be > 0, but total will still be < amount_out
    try {
      await program.methods
        .replenish(
          Array.from(currentOrderId),
          new anchor.BN(1), // Small amount, but total amount_in (50 + 1 = 51) < amount_out (100)
          true, // close_order = true
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount,
          zovTokenAccount: atas.zovTokenAccount,
          orderTracker: currentOrderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail(
        "Expected close order to fail when amount_in is less than amount_out"
      );
    } catch (error) {
      assert.include(
        error.message,
        "DeficientOrder",
        "Expected DeficientOrder error"
      );
    }
  });

  ////// NOTE: Test case disabled temporarily, as it will require some manuevering of the test cases before.
  // it("Should fail replenishment when amount surpasses MAX_U64", async () => {

  //   let amount = new anchor.BN(100000000000);
  //   const sourceBalance_preTx =
  //     await provider.connection.getTokenAccountBalance(
  //       atas.partnerDepositTokenAccount
  //     );
  //   expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

  //   const destBalance_preTx = await provider.connection.getTokenAccountBalance(
  //     atas.zovTokenAccount
  //   );

  //   let orderTrackerAccount = await program.account.orderTracker.fetch(
  //     currentOrderTrackerPDA
  //   );
  //   const orderAmountIn_preTx = orderTrackerAccount.amountIn;

  //   await program.methods
  //     .replenish(
  //       Array.from(currentOrderId),
  //       amount,
  //       false,
  //       null
  //     )
  //     .accounts({
  //       config: configPDA,
  //       partnerDepositVault: partnerDepositVaultPDA,
  //       pdvTokenAccount: atas.partnerDepositTokenAccount,
  //       zovTokenAccount: atas.zovTokenAccount,
  //       orderTracker: currentOrderTrackerPDA,
  //       manager: manager.publicKey,
  //       mint: tokenMint,
  //       tokenProgram: TOKEN_PROGRAM_ID,
  //       systemProgram: SystemProgram.programId,
  //     })
  //     .signers([manager])
  //     .rpc();

  //   // Verify token pull
  //   const sourceBalance_postTx =
  //     await provider.connection.getTokenAccountBalance(
  //       atas.partnerDepositTokenAccount
  //     );
  //   assert.equal(
  //     +sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount,
  //     +amount
  //   );

  //   // Verify token transfer
  //   const destBalance_postTx = await provider.connection.getTokenAccountBalance(
  //     atas.zovTokenAccount
  //   );
  //   assert.equal(
  //     +destBalance_postTx.value.amount - +destBalance_preTx.value.amount,
  //     +amount
  //   );

  //   // Verify that orderTracker is still active
  //   const orderTrackerInfo = await provider.connection.getAccountInfo(
  //     currentOrderTrackerPDA
  //   );
  //   assert.isNotNull(
  //     orderTrackerInfo,
  //     "OrderTracker should still be active after replenish"
  //   );

  //   orderTrackerAccount = await program.account.orderTracker.fetch(
  //     currentOrderTrackerPDA
  //   );

  //   const orderAmountIn_postTx = orderTrackerAccount.amountIn;
  //   assert.equal(
  //     orderAmountIn_postTx.toNumber() - orderAmountIn_preTx.toNumber(),
  //     amount.toNumber()
  //   );

  //   amount = new anchor.BN(MAX_U64);

  //   try {
  //     await program.methods
  //       .replenish(
  //         Array.from(currentOrderId),
  //         amount,
  //         true,
  //         null
  //       )
  //       .accounts({
  //         config: configPDA,
  //         partnerDepositVault: partnerDepositVaultPDA,
  //         pdvTokenAccount: atas.partnerDepositTokenAccount2,
  //         zovTokenAccount: atas.zovTokenAccount2,
  //         orderTracker: currentOrderTrackerPDA,
  //         manager: manager.publicKey,
  //         mint: tokenMint2,
  //         tokenProgram: TOKEN_PROGRAM_ID,
  //         systemProgram: SystemProgram.programId,
  //       })
  //       .signers([manager])
  //       .rpc();
  //   } catch (error) {
  //     assert.include(
  //       error.message,
  //       "ArithmeticOverflow",
  //       "Expected 'ArithmeticOverflow' error"
  //     );
  //   }
  // });

  it("Replenishes tokens from partner_deposit_vault to zynk_op_wallet", async () => {
    const amount = new anchor.BN(100000000000);

    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      atas.zovTokenAccount
    );

    let orderTrackerAccount = await program.account.orderTracker.fetch(
      currentOrderTrackerPDA
    );
    const orderAmountIn_preTx = orderTrackerAccount.amountIn;

    await program.methods
      .replenish(Array.from(currentOrderId), amount, false, null)
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zovTokenAccount: atas.zovTokenAccount,
        orderTracker: currentOrderTrackerPDA,
        manager: manager.publicKey,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    assert.equal(
      +sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount,
      +amount
    );

    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      atas.zovTokenAccount
    );
    assert.equal(
      +destBalance_postTx.value.amount - +destBalance_preTx.value.amount,
      +amount
    );

    // Verify that orderTracker is still active
    const orderTrackerInfo = await provider.connection.getAccountInfo(
      currentOrderTrackerPDA
    );
    assert.isNotNull(
      orderTrackerInfo,
      "OrderTracker should still be active after replenish"
    );

    orderTrackerAccount = await program.account.orderTracker.fetch(
      currentOrderTrackerPDA
    );

    const orderAmountIn_postTx = orderTrackerAccount.amountIn;
    assert.equal(
      orderAmountIn_postTx.toNumber() - orderAmountIn_preTx.toNumber(),
      amount.toNumber()
    );
  });

  it("Replenishes tokens from partner_deposit_vault to zynk_op_wallet - Token2022", async () => {
    const amount = new anchor.BN(100000000000);

    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount3
      );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      atas.zovTokenAccount3
    );

    let orderTrackerAccount = await program.account.orderTracker.fetch(
      currentOrderTrackerPDA
    );
    const orderAmountIn_preTx = orderTrackerAccount.amountIn;
    await program.methods
      .replenish(Array.from(currentOrderId), amount, false, null)
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount3,
        zovTokenAccount: atas.zovTokenAccount3,
        orderTracker: currentOrderTrackerPDA,
        manager: manager.publicKey,
        mint: tokenMint3,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount3
      );
    assert.equal(
      +sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount,
      +amount
    );

    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      atas.zovTokenAccount3
    );
    assert.equal(
      +destBalance_postTx.value.amount - +destBalance_preTx.value.amount,
      +amount
    );

    // Verify that orderTracker is still active
    const orderTrackerInfo = await provider.connection.getAccountInfo(
      currentOrderTrackerPDA
    );
    assert.isNotNull(
      orderTrackerInfo,
      "OrderTracker should still be active after replenish"
    );

    orderTrackerAccount = await program.account.orderTracker.fetch(
      currentOrderTrackerPDA
    );

    const orderAmountIn_postTx = orderTrackerAccount.amountIn;
    assert.equal(
      orderAmountIn_postTx.toNumber() - orderAmountIn_preTx.toNumber(),
      amount.toNumber()
    );
  });

  it("Can replenish tokens multiple times before order is closed", async () => {
    const amount = new anchor.BN(50000000000);

    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      atas.zovTokenAccount
    );

    // Second replenish operation
    await program.methods
      .replenish(Array.from(currentOrderId), amount, false, null)
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zovTokenAccount: atas.zovTokenAccount,
        orderTracker: currentOrderTrackerPDA,
        manager: manager.publicKey,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    assert.equal(
      +sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount,
      +amount
    );

    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      atas.zovTokenAccount
    );
    assert.equal(
      +destBalance_postTx.value.amount - +destBalance_preTx.value.amount,
      +amount
    );

    // Verify that orderTracker is still active
    const orderTrackerInfo = await provider.connection.getAccountInfo(
      currentOrderTrackerPDA
    );
    assert.isNotNull(
      orderTrackerInfo,
      "OrderTracker should still be active after second replenish"
    );
  });

  it("Should fail when wrong PDV is used to replenish", async () => {
    // Create a wrong token account (not the one stored in orderTracker)
    // Must manually create since PDA can't own an ATA
    const partnerId = Buffer.alloc(32);
    partnerId.write("test-id", 0, "utf-8");

    const [wrongPartnerDepositVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("partner_deposit_vault"), partnerId],
      program.programId
    );

    const wrongTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      partnerOperationalWallet,
      tokenMint,
      wrongPartnerDepositVaultPDA,
      undefined,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      true // allowOwnerOffCurve
    );

    await mintTo(
      provider.connection,
      manager,
      tokenMint,
      wrongTokenAccount,
      manager.publicKey,
      100000000000
    );

    try {
      await program.methods
        .replenish(
          Array.from(currentOrderId),
          new anchor.BN(1000000),
          false,
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: wrongPartnerDepositVaultPDA,
          pdvTokenAccount: wrongTokenAccount,
          zovTokenAccount: atas.zovTokenAccount,
          orderTracker: currentOrderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected replenish to fail with wrong PDV");
    } catch (error) {
      assert.include(
        error.message,
        "ConstraintSeeds",
        "Expected ConstraintSeeds error"
      );
    }
  });

  it("Should be able close the order by manager via replenish", async () => {
    // First, replenish enough to meet amount_out requirement
    const orderTrackerAccount = await program.account.orderTracker.fetch(
      currentOrderTrackerPDA
    );
    const remainingAmount = orderTrackerAccount.amountOut.sub(
      orderTrackerAccount.amountIn
    );

    // Replenish the remaining amount and close the order
    await program.methods
      .replenish(
        Array.from(currentOrderId),
        remainingAmount,
        true, // close_order = true
        null
      )
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zovTokenAccount: atas.zovTokenAccount,
        orderTracker: currentOrderTrackerPDA,
        manager: manager.publicKey,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Verify order is closed
    try {
      await program.account.orderTracker.fetch(currentOrderTrackerPDA);
      assert.fail("Expected order to be closed");
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected account to be closed"
      );
    }
  });

  it("Should fail when non-manager tries to close order", async () => {
    const amount = new anchor.BN(100000000000);

    const newOrderId = generateOrderId();
    const newOrderTrackerPDA = deriveOrderTrackerPDA(newOrderId);

    // Initialize new order
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(newOrderId),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: newOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Create a new keypair for non-manager and fund it
    const nonManager = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      nonManager.publicKey,
      1000000000
    );
    await provider.connection.confirmTransaction(airdropSig, "confirmed");

    try {
      await program.methods
        .replenish(
          Array.from(newOrderId),
          new anchor.BN(1),
          true, // close_order = true (requires manager authorization)
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount,
          zovTokenAccount: atas.zovTokenAccount,
          orderTracker: newOrderTrackerPDA,
          manager: nonManager.publicKey, // Wrong manager
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([nonManager])
        .rpc();
      assert.fail("Expected close order to fail with non-manager signer");
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedManager",
        "Expected UnauthorizedManager error"
      );
    }
  });

  it("Should fail when trying to close an already closed order via replenish", async () => {
    // Attempt to close the already closed order
    try {
      await program.methods
        .replenish(
          Array.from(currentOrderId),
          new anchor.BN(0),
          true, // close_order = true
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount,
          zovTokenAccount: atas.zovTokenAccount,
          orderTracker: currentOrderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected close order to fail on already closed order");
    } catch (error) {
      assert.include(
        error.message,
        "AccountNotInitialized",
        "Expected AccountNotInitialized error when closing an already closed order"
      );
    }
  });

  it("Should fail when trying to replenish a closed order", async () => {
    const amount = new anchor.BN(1000000);
    // Attempt to replenish the closed order
    try {
      await program.methods
        .replenish(Array.from(currentOrderId), amount, false, null)
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount,
          zovTokenAccount: atas.zovTokenAccount,
          orderTracker: currentOrderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected replenish to fail on closed order");
    } catch (error) {
      assert.include(
        error.message,
        "AccountNotInitialized",
        "Expected AccountNotInitialized error when replenishing a closed order"
      );
    }
  });

  it("Should fail when deposit vault has insufficient balance", async () => {
    const amount = new anchor.BN(100000000000);

    // Create a new order since previous one is closed
    const newOrderId = generateOrderId();
    const newOrderTrackerPDA = deriveOrderTrackerPDA(newOrderId);

    // Initialize new order
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(newOrderId),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: newOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // First drain the deposit vault by replenishing the maximum amount
    const currentBalance = await provider.connection.getTokenAccountBalance(
      atas.partnerDepositTokenAccount
    );
    await program.methods
      .replenish(
        Array.from(newOrderId),
        new anchor.BN(currentBalance.value.amount),
        false,
        null
      )
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zovTokenAccount: atas.zovTokenAccount,
        orderTracker: newOrderTrackerPDA,
        manager: manager.publicKey,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Now try to replenish more than the available balance
    try {
      await program.methods
        .replenish(Array.from(newOrderId), new anchor.BN(1000000), false, null)
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount,
          zovTokenAccount: atas.zovTokenAccount,
          orderTracker: newOrderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected replenish to fail with insufficient balance");
    } catch (error) {
      assert.include(
        error.message,
        "insufficient funds",
        "Expected insufficient funds error"
      );
    }
  });

  it("User can create and replenish/close order with same mint token", async () => {
    const amount = new anchor.BN(100000000000);
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    // Mint tokens to atas.partnerDepositTokenAccount for this test
    await mintTo(
      provider.connection,
      manager,
      tokenMint,
      atas.partnerDepositTokenAccount,
      manager.publicKey,
      10000000000000 // Mint sufficient tokens for the test
    );

    // Create order with tokenMint
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(orderId),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: orderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Verify order was created
    let orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTrackerPDA
    );
    assert.equal(orderTrackerAccount.amountOut.toNumber(), amount.toNumber());
    assert.equal(orderTrackerAccount.amountIn.toNumber(), 0);

    // Ensure atas.partnerDepositTokenAccount has sufficient balance for replenish
    const balanceBeforeReplenish =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    if (+balanceBeforeReplenish.value.amount < +amount) {
      // Mint additional tokens if needed
      await mintTo(
        provider.connection,
        admin,
        tokenMint,
        atas.partnerDepositTokenAccount,
        admin.publicKey,
        +amount - +balanceBeforeReplenish.value.amount + 1000000000 // Add extra buffer
      );
    }

    // Replenish and close order with same tokenMint
    await program.methods
      .replenish(
        Array.from(orderId),
        amount,
        true, // close_order = true
        null
      )
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zovTokenAccount: atas.zovTokenAccount,
        orderTracker: orderTrackerPDA,
        manager: manager.publicKey,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Verify order is closed
    try {
      await program.account.orderTracker.fetch(orderTrackerPDA);
      assert.fail("Expected order to be closed");
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected account to be closed"
      );
    }
  });

  it("User can create order with first token and close order with second token", async () => {
    const amount = new anchor.BN(100000000000);
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    // Create order with tokenMint (first token)
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(orderId),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: orderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Verify order was created
    let orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTrackerPDA
    );
    assert.equal(orderTrackerAccount.amountOut.toNumber(), amount.toNumber());
    assert.equal(orderTrackerAccount.amountIn.toNumber(), 0);

    // Ensure atas.partnerDepositTokenAccount2 has sufficient balance for replenish
    const balanceBeforeReplenish2 =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount2
      );
    if (+balanceBeforeReplenish2.value.amount < +amount) {
      // Mint additional tokens if needed
      await mintTo(
        provider.connection,
        admin,
        tokenMint2,
        atas.partnerDepositTokenAccount2,
        admin.publicKey,
        +amount - +balanceBeforeReplenish2.value.amount + 1000000000 // Add extra buffer
      );
    }

    // Close order with tokenMint2 (second token)
    await program.methods
      .replenish(
        Array.from(orderId),
        amount,
        true, // close_order = true
        null
      )
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount2, // Using tokenMint2
        zovTokenAccount: atas.zovTokenAccount2, // Using tokenMint2
        orderTracker: orderTrackerPDA,
        manager: manager.publicKey,
        mint: tokenMint2,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Verify order is closed
    try {
      await program.account.orderTracker.fetch(orderTrackerPDA);
      assert.fail("Expected order to be closed");
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected account to be closed"
      );
    }
  });

  it("User is able to pull and create order and close order with same mint token", async () => {
    const amount = new anchor.BN(100000000000);
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    // Pull and create order with tokenMint
    await program.methods
      .pullAndCreateOrder(
        Array.from(partnerId),
        Array.from(orderId),
        Array.from(defaultZovId),
        false,
        amount,
        null,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: orderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Verify order was created
    let orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTrackerPDA
    );
    assert.equal(orderTrackerAccount.amountOut.toNumber(), amount.toNumber());
    assert.equal(orderTrackerAccount.amountIn.toNumber(), amount.toNumber()); // amount_in equals amount_out after pull

    // Close order with same tokenMint (no additional replenish needed since amount_in already equals amount_out)
    await program.methods
      .replenish(
        Array.from(orderId),
        new anchor.BN(0), // No additional amount needed
        true, // close_order = true
        null
      )
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zovTokenAccount: atas.zovTokenAccount,
        orderTracker: orderTrackerPDA,
        manager: manager.publicKey,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Verify order is closed
    try {
      await program.account.orderTracker.fetch(orderTrackerPDA);
      assert.fail("Expected order to be closed");
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected account to be closed"
      );
    }
  });

  it("User is able to pull and create order with one mint token and close order with different mint token (Both valid)", async () => {
    const amount = new anchor.BN(100000000000);
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    // Pull and create order with tokenMint
    await program.methods
      .pullAndCreateOrder(
        Array.from(partnerId),
        Array.from(orderId),
        Array.from(defaultZovId),
        false,
        amount,
        null,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount, // Using tokenMint
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount, // Using tokenMint
        orderTracker: orderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Verify order was created
    let orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTrackerPDA
    );
    assert.equal(orderTrackerAccount.amountOut.toNumber(), amount.toNumber());
    assert.equal(orderTrackerAccount.amountIn.toNumber(), amount.toNumber()); // amount_in equals amount_out after pull

    // Close order with tokenMint2 (different mint token)
    await program.methods
      .replenish(
        Array.from(orderId),
        new anchor.BN(0), // No additional amount needed since amount_in already equals amount_out
        true, // close_order = true
        null
      )
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount2, // Using tokenMint2
        zovTokenAccount: atas.zovTokenAccount2, // Using tokenMint2
        orderTracker: orderTrackerPDA,
        manager: manager.publicKey,
        mint: tokenMint2,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Verify order is closed
    try {
      await program.account.orderTracker.fetch(orderTrackerPDA);
      assert.fail("Expected order to be closed");
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected account to be closed"
      );
    }
  });

  it("User should not be able to create order with invalid mint token", async () => {
    const amount = new anchor.BN(100000000000);
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    try {
      await program.methods
        .createOrder(
          Array.from(partnerId),
          Array.from(orderId),
          Array.from(defaultZovId),
          false,
          amount,
          null
        )
        .accounts({
          config: configPDA,
          manager: manager.publicKey,
          pdvTokenAccount: atas.partnerDepositTokenAccountInvalid, // Using invalid token
          zynkOpVault: zynkOpVault,
          zovTokenAccount: atas.zovTokenAccountInvalid, // Using invalid token
          beneficiary: defaultBeneficiaryPDA,
          beneficiaryTokenAccount: atas.partnerOperationalTokenAccountInvalid, // Using invalid token
          orderTracker: orderTrackerPDA,
          systemProgram: SystemProgram.programId,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          sysvarInstructions: null,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected create order to fail with invalid mint token");
    } catch (error) {
      assert.include(
        error.message,
        "InvalidTokenMint",
        "Expected InvalidTokenMint error"
      );
    }
  });

  it("User should not be able to pull and create order with invalid mint token", async () => {
    const amount = new anchor.BN(100000000000);
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    try {
      await program.methods
        .pullAndCreateOrder(
          Array.from(partnerId),
          Array.from(orderId),
          Array.from(defaultZovId),
          false,
          amount,
          null,
          null
        )
        .accounts({
          config: configPDA,
          manager: manager.publicKey,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccountInvalid, // Using invalid token
          zynkOpVault: zynkOpVault,
          zovTokenAccount: atas.zovTokenAccountInvalid, // Using invalid token
          beneficiary: defaultBeneficiaryPDA,
          beneficiaryTokenAccount: atas.partnerOperationalTokenAccountInvalid, // Using invalid token
          orderTracker: orderTrackerPDA,
          systemProgram: SystemProgram.programId,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          sysvarInstructions: null,
        })
        .signers([manager])
        .rpc();
      assert.fail(
        "Expected pull and create order to fail with invalid mint token"
      );
    } catch (error) {
      assert.include(
        error.message,
        "InvalidTokenMint",
        "Expected InvalidTokenMint error"
      );
    }
  });

  it("User should not be able to pull and create order with valid mint token but pdv and zov mint tokens are different (Both valid)", async () => {
    const amount = new anchor.BN(100000000000);
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    try {
      await program.methods
        .pullAndCreateOrder(
          Array.from(partnerId),
          Array.from(orderId),
          Array.from(defaultZovId),
          false,
          amount,
          null,
          null
        )
        .accounts({
          config: configPDA,
          manager: manager.publicKey,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount,
          zynkOpVault: zynkOpVault,
          zovTokenAccount: atas.zovTokenAccount2, // Using tokenMint2 (different from pdv)
          beneficiary: defaultBeneficiaryPDA,
          beneficiaryTokenAccount: atas.partnerOperationalTokenAccount2, // Using tokenMint2
          orderTracker: orderTrackerPDA,
          systemProgram: SystemProgram.programId,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          sysvarInstructions: null,
        })
        .signers([manager])
        .rpc();
      assert.fail(
        "Expected pull and create order to fail when pdv and zov mint tokens are different"
      );
    } catch (error) {
      assert.include(
        error.message,
        "InvalidTokenMint",
        "Expected InvalidTokenMint error when pdv and zov mints differ"
      );
    }
  });

  it("User should not be able to close order with invalid mint token (Order created by CreateOrder method)", async () => {
    const amount = new anchor.BN(100000000000);
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    // Create order correctly with valid tokenMint
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(orderId),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: orderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Verify order was created
    let orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTrackerPDA
    );
    assert.equal(orderTrackerAccount.amountOut.toNumber(), amount.toNumber());

    // Ensure atas.partnerDepositTokenAccountInvalid has sufficient balance
    const balanceInvalid = await provider.connection.getTokenAccountBalance(
      atas.partnerDepositTokenAccountInvalid
    );
    if (+balanceInvalid.value.amount < +amount) {
      await mintTo(
        provider.connection,
        admin,
        invalidTokenMint,
        atas.partnerDepositTokenAccountInvalid,
        admin.publicKey,
        +amount - +balanceInvalid.value.amount + 1000000000
      );
    }

    // Try to close order with invalid mint token (should fail)
    try {
      await program.methods
        .replenish(
          Array.from(orderId),
          amount,
          true, // close_order = true
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccountInvalid, // Using invalid token
          zovTokenAccount: atas.zovTokenAccountInvalid, // Using invalid token
          orderTracker: orderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected close order to fail with invalid mint token");
    } catch (error) {
      assert.include(
        error.message,
        "InvalidTokenMint",
        "Expected InvalidTokenMint error when closing with invalid mint token"
      );
    }
  });

  it("User should not be able to close order with valid mint token but pdv and zov mint tokens are different (Both valid) (Order created by CreateOrder method)", async () => {
    const amount = new anchor.BN(100000000000);
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    // Create order correctly with tokenMint
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(orderId),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null, // Using tokenMint
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount, // Using tokenMint
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount, // Using tokenMint
        orderTracker: orderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Verify order was created
    let orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTrackerPDA
    );
    assert.equal(orderTrackerAccount.amountOut.toNumber(), amount.toNumber());

    // Ensure atas.partnerDepositTokenAccount2 has sufficient balance
    const balance2 = await provider.connection.getTokenAccountBalance(
      atas.partnerDepositTokenAccount2
    );
    if (+balance2.value.amount < +amount) {
      await mintTo(
        provider.connection,
        admin,
        tokenMint2,
        atas.partnerDepositTokenAccount2,
        admin.publicKey,
        +amount - +balance2.value.amount + 1000000000
      );
    }

    // Try to close order with mismatched tokens (pdv=tokenMint2, zov=tokenMint) - should fail
    try {
      await program.methods
        .replenish(
          Array.from(orderId),
          amount,
          true, // close_order = true
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount2, // Using tokenMint2
          zovTokenAccount: atas.zovTokenAccount, // Using tokenMint (different from pdv)
          orderTracker: orderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail(
        "Expected close order to fail when pdv and zov mint tokens are different"
      );
    } catch (error) {
      assert.include(
        error.message,
        "InvalidTokenMint",
        "Expected InvalidTokenMint error when pdv and zov mints differ"
      );
    }
  });

  it("User should not be able to close order with invalid mint token (Order created by PullAndCreateOrder method)", async () => {
    const amount = new anchor.BN(100000000000);
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    // Ensure atas.partnerDepositTokenAccount has sufficient balance
    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    if (+sourceBalance_preTx.value.amount < +amount) {
      await mintTo(
        provider.connection,
        manager,
        tokenMint,
        atas.partnerDepositTokenAccount,
        manager.publicKey,
        +amount - +sourceBalance_preTx.value.amount + 1000000000
      );
    }

    // Pull and create order correctly with valid tokenMint
    await program.methods
      .pullAndCreateOrder(
        Array.from(partnerId),
        Array.from(orderId),
        Array.from(defaultZovId),
        false,
        amount,
        null,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: orderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Verify order was created
    let orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTrackerPDA
    );
    assert.equal(orderTrackerAccount.amountOut.toNumber(), amount.toNumber());
    assert.equal(orderTrackerAccount.amountIn.toNumber(), amount.toNumber());

    // Ensure atas.partnerDepositTokenAccountInvalid has sufficient balance
    const balanceInvalid = await provider.connection.getTokenAccountBalance(
      atas.partnerDepositTokenAccountInvalid
    );
    if (+balanceInvalid.value.amount < +amount) {
      await mintTo(
        provider.connection,
        admin,
        invalidTokenMint,
        atas.partnerDepositTokenAccountInvalid,
        admin.publicKey,
        +amount - +balanceInvalid.value.amount + 1000000000
      );
    }

    // Try to close order with invalid mint token (should fail)
    try {
      await program.methods
        .replenish(
          Array.from(orderId),
          new anchor.BN(0), // No additional amount needed since amount_in already equals amount_out
          true, // close_order = true
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccountInvalid, // Using invalid token
          zovTokenAccount: atas.zovTokenAccountInvalid, // Using invalid token
          orderTracker: orderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail("Expected close order to fail with invalid mint token");
    } catch (error) {
      assert.include(
        error.message,
        "InvalidTokenMint",
        "Expected InvalidTokenMint error when closing with invalid mint token"
      );
    }
  });

  it("User should not be able to close order with valid mint token but pdv and zov mint tokens are different (Both valid) (Order created by PullAndCreateOrder method)", async () => {
    const amount = new anchor.BN(100000000000);
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    // Ensure atas.partnerDepositTokenAccount has sufficient balance
    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    if (+sourceBalance_preTx.value.amount < +amount) {
      await mintTo(
        provider.connection,
        manager,
        tokenMint,
        atas.partnerDepositTokenAccount,
        manager.publicKey,
        +amount - +sourceBalance_preTx.value.amount + 1000000000
      );
    }

    // Pull and create order correctly with tokenMint
    await program.methods
      .pullAndCreateOrder(
        Array.from(partnerId),
        Array.from(orderId),
        Array.from(defaultZovId),
        false,
        amount,
        null,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount, // Using tokenMint
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount, // Using tokenMint
        orderTracker: orderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Verify order was created
    let orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTrackerPDA
    );
    assert.equal(orderTrackerAccount.amountOut.toNumber(), amount.toNumber());
    assert.equal(orderTrackerAccount.amountIn.toNumber(), amount.toNumber());

    // Ensure atas.partnerDepositTokenAccount2 has sufficient balance
    const balance2 = await provider.connection.getTokenAccountBalance(
      atas.partnerDepositTokenAccount2
    );
    if (+balance2.value.amount < +amount) {
      await mintTo(
        provider.connection,
        admin,
        tokenMint2,
        atas.partnerDepositTokenAccount2,
        admin.publicKey,
        +amount - +balance2.value.amount + 1000000000
      );
    }

    // Try to close order with mismatched tokens (pdv=tokenMint2, zov=tokenMint) - should fail
    try {
      await program.methods
        .replenish(
          Array.from(orderId),
          new anchor.BN(0), // No additional amount needed since amount_in already equals amount_out
          true, // close_order = true
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount2, // Using tokenMint2
          zovTokenAccount: atas.zovTokenAccount, // Using tokenMint (different from pdv)
          orderTracker: orderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail(
        "Expected close order to fail when pdv and zov mint tokens are different"
      );
    } catch (error) {
      assert.include(
        error.message,
        "InvalidTokenMint",
        "Expected InvalidTokenMint error when pdv and zov mints differ"
      );
    }
  });

  it("Should be able to partially replenish order with different mint token that one order is created with", async () => {
    const amount = new anchor.BN(100000000000);
    const replenishAmount = new anchor.BN(50000000000); // Partial replenish
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    // Create order with tokenMint
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(orderId),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: orderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Verify order was created
    let orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTrackerPDA
    );
    assert.equal(orderTrackerAccount.amountOut.toNumber(), amount.toNumber());
    assert.equal(orderTrackerAccount.amountIn.toNumber(), 0);

    // Ensure atas.partnerDepositTokenAccount2 has sufficient balance for replenish
    const balance2_preTx = await provider.connection.getTokenAccountBalance(
      atas.partnerDepositTokenAccount2
    );
    if (+balance2_preTx.value.amount < +replenishAmount) {
      await mintTo(
        provider.connection,
        admin,
        tokenMint2,
        atas.partnerDepositTokenAccount2,
        admin.publicKey,
        +replenishAmount - +balance2_preTx.value.amount + 1000000000
      );
    }

    const zovBalance2_preTx = await provider.connection.getTokenAccountBalance(
      atas.zovTokenAccount2
    );

    // Partially replenish with tokenMint2 (different mint token, but both valid)
    await program.methods
      .replenish(
        Array.from(orderId),
        replenishAmount,
        false, // close_order = false (partial replenish)
        null
      )
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount2, // Using tokenMint2
        zovTokenAccount: atas.zovTokenAccount2, // Using tokenMint2
        orderTracker: orderTrackerPDA,
        manager: manager.publicKey,
        mint: tokenMint2,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    // Verify order tracker is still active
    const orderTrackerInfo = await provider.connection.getAccountInfo(
      orderTrackerPDA
    );
    assert.isNotNull(
      orderTrackerInfo,
      "OrderTracker should still be active after partial replenish"
    );

    // Verify amount_in increased
    orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTrackerPDA
    );
    assert.equal(
      orderTrackerAccount.amountIn.toNumber(),
      replenishAmount.toNumber(),
      "amount_in should equal replenish amount"
    );

    // Verify token transfer occurred
    const zovBalance2_postTx = await provider.connection.getTokenAccountBalance(
      atas.zovTokenAccount2
    );
    assert.equal(
      +zovBalance2_postTx.value.amount - +zovBalance2_preTx.value.amount,
      +replenishAmount,
      "Tokens should be transferred to zovTokenAccount2"
    );
  });

  it("Should not be able to partially replenish order with valid mint token but pdv and zov mint tokens are different", async () => {
    const amount = new anchor.BN(100000000000);
    const replenishAmount = new anchor.BN(50000000000);
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    // Create order with tokenMint
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(orderId),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: orderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Verify order was created
    let orderTrackerAccount = await program.account.orderTracker.fetch(
      orderTrackerPDA
    );
    assert.equal(orderTrackerAccount.amountOut.toNumber(), amount.toNumber());
    assert.equal(orderTrackerAccount.amountIn.toNumber(), 0);

    // Ensure atas.partnerDepositTokenAccount2 has sufficient balance
    const balance2 = await provider.connection.getTokenAccountBalance(
      atas.partnerDepositTokenAccount2
    );
    if (+balance2.value.amount < +replenishAmount) {
      await mintTo(
        provider.connection,
        admin,
        tokenMint2,
        atas.partnerDepositTokenAccount2,
        admin.publicKey,
        +replenishAmount - +balance2.value.amount + 1000000000
      );
    }

    // Try to partially replenish with mismatched tokens (pdv=tokenMint2, zov=tokenMint) - should fail
    try {
      await program.methods
        .replenish(
          Array.from(orderId),
          replenishAmount,
          false, // close_order = false (partial replenish)
          null
        )
        .accounts({
          config: configPDA,
          partnerDepositVault: partnerDepositVaultPDA,
          pdvTokenAccount: atas.partnerDepositTokenAccount2, // Using tokenMint2
          zovTokenAccount: atas.zovTokenAccount, // Using tokenMint (different from pdv)
          orderTracker: orderTrackerPDA,
          manager: manager.publicKey,
          mint: tokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();
      assert.fail(
        "Expected partial replenish to fail when pdv and zov mint tokens are different"
      );
    } catch (error) {
      assert.include(
        error.message,
        "InvalidTokenMint",
        "Expected InvalidTokenMint error when pdv and zov mints differ"
      );
    }
  });

  // it("Should be able to create order tracker created by create order function, pull and create order function or zero amount order created by create_order function", async () => {
  //   const amount = new anchor.BN(50000000000); // 50 tokens
  //   const zeroAmount = new anchor.BN(0);

  //   // Create 2 orders using create_order (non-zero amount)
  //   const order1Id = generateOrderId();
  //   const order1TrackerPDA = deriveOrderTrackerPDA(order1Id);

  //   const order2Id = generateOrderId();
  //   const order2TrackerPDA = deriveOrderTrackerPDA(order2Id);

  //   // Ensure atas.zovTokenAccount has enough tokens
  //   const zovBalance = await provider.connection.getTokenAccountBalance(
  //     atas.zovTokenAccount
  //   );
  //   if (+zovBalance.value.amount < +amount.mul(new anchor.BN(2))) {
  //     await mintTo(
  //       provider.connection,
  //       admin,
  //       tokenMint,
  //       atas.zovTokenAccount,
  //       admin.publicKey,
  //       amount.mul(new anchor.BN(2)).toNumber()
  //     );
  //   }

  //   // Create first order using create_order
  //   await program.methods
  //     .createOrder(
  //       Array.from(partnerId),
  //       Array.from(order1Id),
  //       Array.from(defaultZovId),
  //       false,
  //       amount,
  //       null
  //     )
  //     .accounts({
  //       config: configPDA,
  //       manager: manager.publicKey,
  //       partnerDepositVault: partnerDepositVaultPDA,
  //       pdvTokenAccount: null,
  //       zynkOpVault: zynkOpVault,
  //       zovTokenAccount: atas.zovTokenAccount,
  //       beneficiary: defaultBeneficiaryPDA,
  //       beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
  //       orderTracker: order1TrackerPDA,
  //       systemProgram: SystemProgram.programId,
  //       mint: tokenMint,
  //       tokenProgram: TOKEN_PROGRAM_ID,
  //       sysvarInstructions: null,
  //     })
  //     .signers([manager])
  //     .rpc();

  //   // Create second order using create_order
  //   await program.methods
  //     .createOrder(
  //       Array.from(partnerId),
  //       Array.from(order2Id),
  //       Array.from(defaultZovId),
  //       false,
  //       amount,
  //       null
  //     )
  //     .accounts({
  //       config: configPDA,
  //       manager: manager.publicKey,
  //       partnerDepositVault: partnerDepositVaultPDA,
  //       pdvTokenAccount: null,
  //       zynkOpVault: zynkOpVault,
  //       zovTokenAccount: atas.zovTokenAccount,
  //       beneficiary: defaultBeneficiaryPDA,
  //       beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
  //       orderTracker: order2TrackerPDA,
  //       systemProgram: SystemProgram.programId,
  //       mint: tokenMint,
  //       tokenProgram: TOKEN_PROGRAM_ID,
  //       sysvarInstructions: null,
  //     })
  //     .signers([manager])
  //     .rpc();

  //   // Create 2 orders using pull_and_create_order
  //   const order3Id = generateOrderId();
  //   const order3TrackerPDA = deriveOrderTrackerPDA(order3Id);

  //   const order4Id = generateOrderId();
  //   const order4TrackerPDA = deriveOrderTrackerPDA(order4Id);

  //   // Ensure atas.partnerDepositTokenAccount has enough tokens
  //   const pdvBalance = await provider.connection.getTokenAccountBalance(
  //     atas.partnerDepositTokenAccount
  //   );
  //   if (+pdvBalance.value.amount < +amount.mul(new anchor.BN(2))) {
  //     await mintTo(
  //       provider.connection,
  //       admin,
  //       tokenMint,
  //       atas.partnerDepositTokenAccount,
  //       admin.publicKey,
  //       amount.mul(new anchor.BN(2)).toNumber()
  //     );
  //   }

  //   // Create third order using pull_and_create_order
  //   await program.methods
  //     .pullAndCreateOrder(
  //       Array.from(partnerId),
  //       Array.from(order3Id),
  //       Array.from(defaultZovId),
  //       false,
  //       amount,
  //       null,
  //       null
  //     )
  //     .accounts({
  //       config: configPDA,
  //       manager: manager.publicKey,
  //       partnerDepositVault: partnerDepositVaultPDA,
  //       pdvTokenAccount: atas.partnerDepositTokenAccount,
  //       zynkOpVault: zynkOpVault,
  //       zovTokenAccount: atas.zovTokenAccount,
  //       beneficiary: defaultBeneficiaryPDA,
  //       beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
  //       orderTracker: order3TrackerPDA,
  //       systemProgram: SystemProgram.programId,
  //       mint: tokenMint,
  //       tokenProgram: TOKEN_PROGRAM_ID,
  //       sysvarInstructions: null,
  //     })
  //     .signers([manager])
  //     .rpc();

  //   // Create fourth order using pull_and_create_order
  //   await program.methods
  //     .pullAndCreateOrder(
  //       Array.from(partnerId),
  //       Array.from(order4Id),
  //       Array.from(defaultZovId),
  //       false,
  //       amount,
  //       null,
  //       null
  //     )
  //     .accounts({
  //       config: configPDA,
  //       manager: manager.publicKey,
  //       partnerDepositVault: partnerDepositVaultPDA,
  //       pdvTokenAccount: atas.partnerDepositTokenAccount,
  //       zynkOpVault: zynkOpVault,
  //       zovTokenAccount: atas.zovTokenAccount,
  //       beneficiary: defaultBeneficiaryPDA,
  //       beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
  //       orderTracker: order4TrackerPDA,
  //       systemProgram: SystemProgram.programId,
  //       mint: tokenMint,
  //       tokenProgram: TOKEN_PROGRAM_ID,
  //       sysvarInstructions: null,
  //     })
  //     .signers([manager])
  //     .rpc();

  //   // Create 2 orders using create_order with zero amount
  //   const order5Id = generateOrderId();
  //   const order5TrackerPDA = deriveOrderTrackerPDA(order5Id);

  //   const order6Id = generateOrderId();
  //   const order6TrackerPDA = deriveOrderTrackerPDA(order6Id);

  //   // Create fifth order using create_order with zero amount
  //   await program.methods
  //     .createOrder(
  //       Array.from(partnerId),
  //       Array.from(order5Id),
  //       Array.from(defaultZovId),
  //       false,
  //       zeroAmount,
  //       null
  //     )
  //     .accounts({
  //       config: configPDA,
  //       manager: manager.publicKey,
  //       partnerDepositVault: partnerDepositVaultPDA,
  //       pdvTokenAccount: null,
  //       zynkOpVault: zynkOpVault,
  //       zovTokenAccount: atas.zovTokenAccount,
  //       beneficiary: defaultBeneficiaryPDA,
  //       beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
  //       orderTracker: order5TrackerPDA,
  //       systemProgram: SystemProgram.programId,
  //       mint: tokenMint,
  //       tokenProgram: TOKEN_PROGRAM_ID,
  //       sysvarInstructions: null,
  //     })
  //     .signers([manager])
  //     .rpc();

  //   // Create sixth order using create_order with zero amount
  //   await program.methods
  //     .createOrder(
  //       Array.from(partnerId),
  //       Array.from(order6Id),
  //       Array.from(defaultZovId),
  //       false,
  //       zeroAmount,
  //       null
  //     )
  //     .accounts({
  //       config: configPDA,
  //       manager: manager.publicKey,
  //       partnerDepositVault: partnerDepositVaultPDA,
  //       pdvTokenAccount: null,
  //       zynkOpVault: zynkOpVault,
  //       zovTokenAccount: atas.zovTokenAccount,
  //       beneficiary: defaultBeneficiaryPDA,
  //       beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
  //       orderTracker: order6TrackerPDA,
  //       systemProgram: SystemProgram.programId,
  //       mint: tokenMint,
  //       tokenProgram: TOKEN_PROGRAM_ID,
  //       sysvarInstructions: null,
  //     })
  //     .signers([manager])
  //     .rpc();

  //   // Verify all order trackers exist
  //   const order1Account = await program.account.orderTracker.fetch(
  //     order1TrackerPDA
  //   );
  //   const order2Account = await program.account.orderTracker.fetch(
  //     order2TrackerPDA
  //   );
  //   const order3Account = await program.account.orderTracker.fetch(
  //     order3TrackerPDA
  //   );
  //   const order4Account = await program.account.orderTracker.fetch(
  //     order4TrackerPDA
  //   );
  //   const order5Account = await program.account.orderTracker.fetch(
  //     order5TrackerPDA
  //   );
  //   const order6Account = await program.account.orderTracker.fetch(
  //     order6TrackerPDA
  //   );

  //   assert.isNotNull(order1Account, "Order 1 tracker should exist");
  //   assert.isNotNull(order2Account, "Order 2 tracker should exist");
  //   assert.isNotNull(order3Account, "Order 3 tracker should exist");
  //   assert.isNotNull(order4Account, "Order 4 tracker should exist");
  //   assert.isNotNull(order5Account, "Order 5 tracker should exist");
  //   assert.isNotNull(order6Account, "Order 6 tracker should exist");

  //   // Get lamports in each order tracker account before closing
  //   const order1Info = await provider.connection.getAccountInfo(
  //     order1TrackerPDA
  //   );
  //   const order2Info = await provider.connection.getAccountInfo(
  //     order2TrackerPDA
  //   );
  //   const order3Info = await provider.connection.getAccountInfo(
  //     order3TrackerPDA
  //   );
  //   const order4Info = await provider.connection.getAccountInfo(
  //     order4TrackerPDA
  //   );
  //   const order5Info = await provider.connection.getAccountInfo(
  //     order5TrackerPDA
  //   );
  //   const order6Info = await provider.connection.getAccountInfo(
  //     order6TrackerPDA
  //   );

  //   const totalLamportsToTransfer =
  //     (order1Info?.lamports || 0) +
  //     (order2Info?.lamports || 0) +
  //     (order3Info?.lamports || 0) +
  //     (order4Info?.lamports || 0) +
  //     (order5Info?.lamports || 0) +
  //     (order6Info?.lamports || 0);

  //   // Get admin balance before closing
  //   const adminBalanceBefore = await provider.connection.getBalance(
  //     admin.publicKey
  //   );

  //   // Call closeOrders with all 6 order tracker PDAs in remaining_accounts
  //   // Note: accounts must be writable to be closed
  //   await program.methods
  //     .closeOrders(null)
  //     .accounts({
  //       config: configPDA,
  //       admin: admin.publicKey,
  //     })
  //     .remainingAccounts([
  //       {
  //         pubkey: order1TrackerPDA,
  //         isSigner: false,
  //         isWritable: true,
  //       },
  //       {
  //         pubkey: order2TrackerPDA,
  //         isSigner: false,
  //         isWritable: true,
  //       },
  //       {
  //         pubkey: order3TrackerPDA,
  //         isSigner: false,
  //         isWritable: true,
  //       },
  //       {
  //         pubkey: order4TrackerPDA,
  //         isSigner: false,
  //         isWritable: true,
  //       },
  //       {
  //         pubkey: order5TrackerPDA,
  //         isSigner: false,
  //         isWritable: true,
  //       },
  //       {
  //         pubkey: order6TrackerPDA,
  //         isSigner: false,
  //         isWritable: true,
  //       },
  //     ])
  //     .signers([admin])
  //     .rpc();

  //   // Verify all order tracker accounts are closed
  //   try {
  //     await program.account.orderTracker.fetch(order1TrackerPDA);
  //     assert.fail("Expected order 1 tracker to be closed");
  //   } catch (error) {
  //     assert.include(
  //       error.message,
  //       "Account does not exist",
  //       "Expected order 1 tracker account to be closed"
  //     );
  //   }

  //   try {
  //     await program.account.orderTracker.fetch(order2TrackerPDA);
  //     assert.fail("Expected order 2 tracker to be closed");
  //   } catch (error) {
  //     assert.include(
  //       error.message,
  //       "Account does not exist",
  //       "Expected order 2 tracker account to be closed"
  //     );
  //   }

  //   try {
  //     await program.account.orderTracker.fetch(order3TrackerPDA);
  //     assert.fail("Expected order 3 tracker to be closed");
  //   } catch (error) {
  //     assert.include(
  //       error.message,
  //       "Account does not exist",
  //       "Expected order 3 tracker account to be closed"
  //     );
  //   }

  //   try {
  //     await program.account.orderTracker.fetch(order4TrackerPDA);
  //     assert.fail("Expected order 4 tracker to be closed");
  //   } catch (error) {
  //     assert.include(
  //       error.message,
  //       "Account does not exist",
  //       "Expected order 4 tracker account to be closed"
  //     );
  //   }

  //   try {
  //     await program.account.orderTracker.fetch(order5TrackerPDA);
  //     assert.fail("Expected order 5 tracker to be closed");
  //   } catch (error) {
  //     assert.include(
  //       error.message,
  //       "Account does not exist",
  //       "Expected order 5 tracker account to be closed"
  //     );
  //   }

  //   try {
  //     await program.account.orderTracker.fetch(order6TrackerPDA);
  //     assert.fail("Expected order 6 tracker to be closed");
  //   } catch (error) {
  //     assert.include(
  //       error.message,
  //       "Account does not exist",
  //       "Expected order 6 tracker account to be closed"
  //     );
  //   }

  //   // Verify admin balance increased by the lamports from closed accounts
  //   const adminBalanceAfter = await provider.connection.getBalance(
  //     admin.publicKey
  //   );
  //   assert.equal(
  //     adminBalanceAfter - adminBalanceBefore,
  //     totalLamportsToTransfer,
  //     "Admin balance should increase by the total lamports from closed accounts"
  //   );
  // });

  it("SadPath: Should fail order closures txn if one order is already closed", async () => {
    const amount = new anchor.BN(50000000000); // 50 tokens

    // Create 2 orders
    const order1Id = generateOrderId();
    const order1TrackerPDA = deriveOrderTrackerPDA(order1Id);

    const order2Id = generateOrderId();
    const order2TrackerPDA = deriveOrderTrackerPDA(order2Id);

    // Ensure atas.zovTokenAccount has enough tokens
    const zovBalance = await provider.connection.getTokenAccountBalance(
      atas.zovTokenAccount
    );
    if (+zovBalance.value.amount < +amount.mul(new anchor.BN(2))) {
      await mintTo(
        provider.connection,
        admin,
        tokenMint,
        atas.zovTokenAccount,
        admin.publicKey,
        amount.mul(new anchor.BN(2)).toNumber()
      );
    }

    // Create first order
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(order1Id),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: order1TrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Create second order
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(order2Id),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: order2TrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Close the first order using closeOrders
    await program.methods
      .closeOrders(null)
      .accounts({
        config: configPDA,
        admin: admin.publicKey,
      })
      .remainingAccounts([
        {
          pubkey: order1TrackerPDA,
          isSigner: false,
          isWritable: true,
        },
      ])
      .signers([admin])
      .rpc();

    // Verify first order is closed
    try {
      await program.account.orderTracker.fetch(order1TrackerPDA);
      assert.fail("Expected order 1 to be closed");
    } catch (error) {
      assert.include(error.message, "Account does not exist");
    }

    // Try to close both orders (one already closed, one still open) - should fail
    try {
      await program.methods
        .closeOrders(null)
        .accounts({
          config: configPDA,
          admin: admin.publicKey,
        })
        .remainingAccounts([
          {
            pubkey: order1TrackerPDA, // Already closed
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: order2TrackerPDA, // Still open
            isSigner: false,
            isWritable: true,
          },
        ])
        .signers([admin])
        .rpc();
      assert.fail(
        "Expected closeOrders to fail when one order is already closed"
      );
    } catch (error) {
      // Should fail because order1TrackerPDA is already closed and can't be deserialized
      // The account doesn't exist anymore, so it might fail at transaction level or when trying to deserialize
      assert.ok(
        error.message.includes("InvalidOrder"),
        `Expected InvalidOrder error when trying to close already closed account. Got: ${error.message}`
      );
    }
  });

  it("SadPath: Should fail if guardian, manager or any other wallet than admin is calling the function", async () => {
    const amount = new anchor.BN(50000000000); // 50 tokens

    // Create an order
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    // Ensure atas.zovTokenAccount has enough tokens
    const zovBalance = await provider.connection.getTokenAccountBalance(
      atas.zovTokenAccount
    );
    if (+zovBalance.value.amount < +amount) {
      await mintTo(
        provider.connection,
        admin,
        tokenMint,
        atas.zovTokenAccount,
        admin.publicKey,
        amount.toNumber()
      );
    }

    // Create order
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(orderId),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: orderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Try with manager - should fail
    let newManager = Keypair.generate();
    try {
      await program.methods
        .closeOrders(null)
        .accounts({
          config: configPDA,
          admin: newManager.publicKey, // Wrong signer
        })
        .remainingAccounts([
          {
            pubkey: orderTrackerPDA,
            isSigner: false,
            isWritable: true,
          },
        ])
        .signers([newManager])
        .rpc();
      assert.fail("Expected closeOrders to fail when manager calls it");
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedAdmin",
        "Expected UnauthorizedAdmin error when manager calls closeOrders"
      );
    }

    // Try with guardian - should fail
    try {
      await program.methods
        .closeOrders(null)
        .accounts({
          config: configPDA,
          admin: guardian.publicKey, // Wrong signer
        })
        .remainingAccounts([
          {
            pubkey: orderTrackerPDA,
            isSigner: false,
            isWritable: true,
          },
        ])
        .signers([guardian])
        .rpc();
      assert.fail("Expected closeOrders to fail when guardian calls it");
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedAdmin",
        "Expected UnauthorizedAdmin error when guardian calls closeOrders"
      );
    }

    // Try with a random wallet - should fail
    const randomWallet = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      randomWallet.publicKey,
      1000000000
    );
    await provider.connection.confirmTransaction(airdropSig, "confirmed");

    try {
      await program.methods
        .closeOrders(null)
        .accounts({
          config: configPDA,
          admin: randomWallet.publicKey, // Wrong signer
        })
        .remainingAccounts([
          {
            pubkey: orderTrackerPDA,
            isSigner: false,
            isWritable: true,
          },
        ])
        .signers([randomWallet])
        .rpc();
      assert.fail("Expected closeOrders to fail when random wallet calls it");
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedAdmin",
        "Expected UnauthorizedAdmin error when random wallet calls closeOrders"
      );
    }
  });

  it("SadPath: Should fail if contract is paused", async () => {
    const amount = new anchor.BN(50000000000); // 50 tokens

    // Create an order
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    // Ensure atas.zovTokenAccount has enough tokens
    const zovBalance = await provider.connection.getTokenAccountBalance(
      atas.zovTokenAccount
    );
    if (+zovBalance.value.amount < +amount) {
      await mintTo(
        provider.connection,
        admin,
        tokenMint,
        atas.zovTokenAccount,
        admin.publicKey,
        amount.toNumber()
      );
    }

    // Create order
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(orderId),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: orderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Pause the contract
    await program.methods
      .pause()
      .accounts({
        config: configPDA,
        authority: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    // Try to close order trackers while paused - should fail
    try {
      await program.methods
        .closeOrders(null)
        .accounts({
          config: configPDA,
          admin: admin.publicKey,
        })
        .remainingAccounts([
          {
            pubkey: orderTrackerPDA,
            isSigner: false,
            isWritable: true,
          },
        ])
        .signers([admin])
        .rpc();
      assert.fail("Expected closeOrders to fail when contract is paused");
    } catch (error) {
      assert.include(
        error.message,
        "ContractPaused",
        "Expected ContractPaused error when contract is paused"
      );
    }

    // Unpause for other tests using unpause with timelock
    const action = TimelockAction.Unpause;
    const [timelockPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("timelock"), Buffer.from([action])],
      program.programId
    );

    // Create timelock request
    await program.methods
      .requestTimelock(action, null)
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        manager: manager.publicKey,
      })
      .signers([manager])
      .rpc();

    // Guardian acks the timelock to allow immediate execution
    await program.methods
      .ackTimelock()
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        guardian: guardian.publicKey,
      })
      .signers([guardian])
      .rpc();

    await program.methods
      .unpause()
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();
  });

  it("SadPath: Should fail if one of the PDA account is config and not the OrderTracker", async () => {
    const amount = new anchor.BN(50000000000); // 50 tokens

    // Create an order
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    // Ensure atas.zovTokenAccount has enough tokens
    const zovBalance = await provider.connection.getTokenAccountBalance(
      atas.zovTokenAccount
    );
    if (+zovBalance.value.amount < +amount) {
      await mintTo(
        provider.connection,
        admin,
        tokenMint,
        atas.zovTokenAccount,
        admin.publicKey,
        amount.toNumber()
      );
    }

    // Create order
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(orderId),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: orderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Try to close with config PDA instead of order tracker - should fail
    try {
      await program.methods
        .closeOrders(null)
        .accounts({
          config: configPDA,
          admin: admin.publicKey,
        })
        .remainingAccounts([
          {
            pubkey: configPDA, // Config PDA instead of OrderTracker
            isSigner: false,
            isWritable: true,
          },
        ])
        .signers([admin])
        .rpc();
      assert.fail(
        "Expected closeOrders to fail when config PDA is passed instead of OrderTracker"
      );
    } catch (error) {
      assert.include(
        error.message,
        "AccountDiscriminatorMismatch",
        "Expected AccountDiscriminatorMismatch error when config PDA is passed"
      );
    }
  });

  it("SadPath: Should fail if one of the PDA account is partner deposit vault and not the Order tracker", async () => {
    const amount = new anchor.BN(50000000000); // 50 tokens

    // Create an order
    const orderId = generateOrderId();
    const orderTrackerPDA = deriveOrderTrackerPDA(orderId);

    // Ensure atas.zovTokenAccount has enough tokens
    const zovBalance = await provider.connection.getTokenAccountBalance(
      atas.zovTokenAccount
    );
    if (+zovBalance.value.amount < +amount) {
      await mintTo(
        provider.connection,
        admin,
        tokenMint,
        atas.zovTokenAccount,
        admin.publicKey,
        amount.toNumber()
      );
    }

    // Create order
    await program.methods
      .createOrder(
        Array.from(partnerId),
        Array.from(orderId),
        Array.from(defaultZovId),
        false,
        amount,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: null,
        zynkOpVault: zynkOpVault,
        zovTokenAccount: atas.zovTokenAccount,
        beneficiary: defaultBeneficiaryPDA,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: orderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Try to close with partner deposit vault PDA instead of order tracker - should fail
    try {
      await program.methods
        .closeOrders(null)
        .accounts({
          config: configPDA,
          admin: admin.publicKey,
        })
        .remainingAccounts([
          {
            pubkey: partnerDepositVaultPDA, // Partner deposit vault PDA instead of OrderTracker
            isSigner: false,
            isWritable: true,
          },
        ])
        .signers([admin])
        .rpc();
      assert.fail(
        "Expected closeOrders to fail when partner deposit vault PDA is passed instead of OrderTracker"
      );
    } catch (error) {
      // The partner deposit vault is not owned by the program, so it should fail with InvalidOrder
      // Or if it's owned but wrong discriminator, it should fail with AccountDiscriminatorMismatch
      assert.ok(
        error.message.includes("InvalidOrder") ||
          error.message.includes("AccountDiscriminatorMismatch"),
        `Expected InvalidOrder error when partner deposit vault PDA is passed instead of OrderTracker. Got: ${error.message}`
      );
    }
  });

  it("Should be able to pause by manager", async () => {
    await program.methods
      .pause()
      .accounts({
        config: configPDA,
        authority: manager.publicKey,
      })
      .signers([manager])
      .rpc();

    const configAccount = await program.account.config.fetch(configPDA);
    assert.ok(configAccount.paused, "Expected program to be paused!");
  });

  it("Should be able to pause by admin", async () => {
    await program.methods
      .pause()
      .accounts({
        config: configPDA,
        authority: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.config.fetch(configPDA);
    assert.ok(configAccount.paused, "Expected program to be paused!");
  });

  it("Should be able to pause by attester", async () => {
    await program.methods
      .pause()
      .accounts({
        config: configPDA,
        authority: attester.publicKey,
      })
      .signers([attester])
      .rpc();

    const configAccount = await program.account.config.fetch(configPDA);
    assert.ok(configAccount.paused, "Expected program to be paused!");
  });

  it("Should not be able to pause by non-authority", async () => {
    // Create a wrong keypair for this test
    const wrongAuthority = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      wrongAuthority.publicKey,
      1000000000
    );
    await provider.connection.confirmTransaction(airdropSig, "confirmed");

    try {
      await program.methods
        .pause()
        .accounts({
          config: configPDA,
          authority: wrongAuthority.publicKey,
        })
        .signers([wrongAuthority])
        .rpc();
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedSigner",
        "Expected UnauthorizedSigner error"
      );
    }
  });

  it("Should not be able to request timelock by non-manager", async () => {
    const action = TimelockAction.UpdateGuardian;
    const [timelockPDA, _] = PublicKey.findProgramAddressSync(
      [Buffer.from("timelock"), Buffer.from([action])],
      program.programId
    );

    try {
      await program.methods
        .requestTimelock(action, guardian.publicKey)
        .accounts({
          config: configPDA,
          timelock: timelockPDA,
          manager: guardian.publicKey,
        })
        .signers([guardian])
        .rpc();
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedManager",
        "Expected UnauthorizedManager error"
      );
    }
  });

  it("Should be able to request timelock by manager", async () => {
    const action = TimelockAction.Unpause;
    const result = PublicKey.findProgramAddressSync(
      [Buffer.from("timelock"), Buffer.from([action])],
      program.programId
    );
    timelockPDA = result[0];

    await program.methods
      .requestTimelock(action, guardian.publicKey)
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        manager: manager.publicKey,
      })
      .signers([manager])
      .rpc();

    const timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.equal(timelockAccount.action, action);
    assert.ok(
      !timelockAccount.executed,
      "Timelock should not be in executed state"
    );
    assert.ok(!timelockAccount.ack, "Timelock should not be in ack'ed state");
    assert.equal(
      timelockAccount.value.toBase58(),
      guardian.publicKey.toBase58()
    );

    const expectedDelay = timelockDelays[action];
    const now = Math.floor(Date.now() / 1000);
    assert.ok(
      Math.abs(timelockAccount.eta.toNumber() - (now + expectedDelay)) < 10
    );
  });

  it("Should not be able to execute timelock before eta", async () => {
    const timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.ok(
      Math.floor(Date.now() / 1000) < timelockAccount.eta.toNumber(),
      "ETA elapsed already."
    );

    try {
      await program.methods
        .unpause()
        .accounts({
          config: configPDA,
          timelock: timelockPDA,
          admin: admin.publicKey,
        })
        .signers([admin])
        .rpc();
    } catch (error) {
      assert.include(
        error.message,
        "ActionUnderReview",
        "Expected ActionUnderReview error"
      );
    }
  });

  it("Should not be able to ack timelock by non-guardian", async () => {
    try {
      await program.methods
        .ackTimelock()
        .accounts({
          config: configPDA,
          timelock: timelockPDA,
          guardian: admin.publicKey,
        })
        .signers([admin])
        .rpc();
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedGuardian",
        "Expected UnauthorizedGuardian error"
      );
    }
  });

  it("Should not be able to execute unpause using a wrong timelock request", async () => {
    let configAccount = await program.account.config.fetch(configPDA);
    assert.ok(configAccount.paused, "Expected program to be paused!");

    const action = TimelockAction.UpdateAttester;
    const [wrongTimelockPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("timelock"), Buffer.from([action])],
      program.programId
    );

    ///// Request wrong timelock /////
    await program.methods
      .requestTimelock(action, guardian.publicKey)
      .accounts({
        config: configPDA,
        timelock: wrongTimelockPDA,
        manager: manager.publicKey,
      })
      .signers([manager])
      .rpc();

    ///// Guardian ack for execution readiness /////
    await program.methods
      .ackTimelock()
      .accounts({
        config: configPDA,
        timelock: wrongTimelockPDA,
        guardian: guardian.publicKey,
      })
      .signers([guardian])
      .rpc();

    const timelockAccount = await program.account.request.fetch(
      wrongTimelockPDA
    );
    assert.ok(timelockAccount.ack, "Timelock not ack'ed!");

    try {
      ///// Execute unpause with wrong timelock /////
      await program.methods
        .unpause()
        .accounts({
          config: configPDA,
          timelock: wrongTimelockPDA,
          admin: admin.publicKey,
        })
        .signers([admin])
        .rpc();
    } catch (error) {
      assert.include(
        error.message,
        "InvalidAction",
        "Expected InvalidAction error"
      );
    }

    configAccount = await program.account.config.fetch(configPDA);
    assert.ok(configAccount.paused, "Expected program to be paused!");
  });

  it("Should be able to execute timelock by admin before eta, if guardian acks", async () => {
    let configAccount = await program.account.config.fetch(configPDA);
    assert.ok(configAccount.paused, "Expected program to be paused!");

    await program.methods
      .ackTimelock()
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        guardian: guardian.publicKey,
      })
      .signers([guardian])
      .rpc();

    const timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.ok(timelockAccount.ack, "Timelock not ack'ed!");

    await program.methods
      .unpause()
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    configAccount = await program.account.config.fetch(configPDA);
    assert.ok(!configAccount.paused, "Expected program to be unpaused!");

    try {
      const timelockAccount = await program.account.request.fetch(timelockPDA);
      console.log(timelockAccount);
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected `Account does not exist` error"
      );
    }
  });

  it("Should be able to revoke timelock by admin, once guardian acks", async () => {
    const action = TimelockAction.UpdateGuardian;
    const [timelockPDA, _] = PublicKey.findProgramAddressSync(
      [Buffer.from("timelock"), Buffer.from([action])],
      program.programId
    );

    await program.methods
      .requestTimelock(action, guardian.publicKey)
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        manager: manager.publicKey,
      })
      .signers([manager])
      .rpc();

    let timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.equal(timelockAccount.action, action);

    await program.methods
      .ackTimelock()
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        guardian: guardian.publicKey,
      })
      .signers([guardian])
      .rpc();

    timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.ok(timelockAccount.ack, "Timelock not ack'ed!");

    await program.methods
      .revokeTimelock()
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    try {
      const timelockAccount = await program.account.request.fetch(timelockPDA);
      console.log(timelockAccount);
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected `Account does not exist` error"
      );
    }
  });

  it("Should not be able to request consensus by non-manager", async () => {
    const action = TimelockAction.UpdateAdmin;
    const [timelockPDA, _] = PublicKey.findProgramAddressSync(
      [Buffer.from("timelock"), Buffer.from([action])],
      program.programId
    );

    try {
      await program.methods
        .requestConsensus(action, guardian.publicKey)
        .accounts({
          config: configPDA,
          timelock: timelockPDA,
          manager: admin.publicKey,
          attester: attester.publicKey,
        })
        .signers([admin, attester])
        .rpc();
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedManager",
        "Expected UnauthorizedManager error"
      );
    }
  });

  it("Should not be able to request consensus by non-attester", async () => {
    const action = TimelockAction.UpdateAdmin;
    const [timelockPDA, _] = PublicKey.findProgramAddressSync(
      [Buffer.from("timelock"), Buffer.from([action])],
      program.programId
    );

    try {
      await program.methods
        .requestConsensus(action, guardian.publicKey)
        .accounts({
          config: configPDA,
          timelock: timelockPDA,
          manager: manager.publicKey,
          attester: admin.publicKey,
        })
        .signers([manager, admin])
        .rpc();
    } catch (error) {
      assert.include(
        error.message,
        "UnauthorizedSigner",
        "Expected UnauthorizedSigner error"
      );
    }
  });

  it("Should be able to request consensus by valid signers", async () => {
    const action = TimelockAction.UpdateAdmin;
    const result = PublicKey.findProgramAddressSync(
      [Buffer.from("timelock"), Buffer.from([action])],
      program.programId
    );
    timelockPDA = result[0];

    await program.methods
      .requestConsensus(action, guardian.publicKey)
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        manager: manager.publicKey,
        attester: attester.publicKey,
      })
      .signers([manager, attester])
      .rpc();

    let timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.equal(timelockAccount.action, action);
    assert.ok(
      timelockAccount.consensus,
      "Timelock should be a consensus request"
    );
    assert.ok(
      !timelockAccount.executed,
      "Timelock should not be in executed state"
    );
    assert.ok(!timelockAccount.ack, "Timelock should not be in ack'ed state");
    assert.equal(
      timelockAccount.value.toBase58(),
      guardian.publicKey.toBase58()
    );
  });

  it("Should be able to execute consensus request by guardian", async () => {
    let timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.ok(
      timelockAccount.consensus,
      "Timelock should be a consensus request"
    );

    await program.methods
      .executeConsensus()
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        guardian: guardian.publicKey,
      })
      .signers([guardian])
      .rpc();

    // timelock account must be closed
    try {
      timelockAccount = await program.account.request.fetch(timelockPDA);
      console.log(timelockAccount);
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected `Account does not exist` error"
      );
    }

    const configAccount = await program.account.config.fetch(configPDA);
    assert.equal(configAccount.admin.toBase58(), guardian.publicKey.toBase58());
  });

  it("Should not be able to execute non-consensus request by guardian", async () => {
    const action = TimelockAction.UpdateAdmin;
    const [timelockPDA, _] = PublicKey.findProgramAddressSync(
      [Buffer.from("timelock"), Buffer.from([action])],
      program.programId
    );

    await program.methods
      .requestTimelock(action, guardian.publicKey)
      .accounts({
        config: configPDA,
        timelock: timelockPDA,
        manager: manager.publicKey,
      })
      .signers([manager])
      .rpc();

    let timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.equal(timelockAccount.action, action);
    assert.ok(
      !timelockAccount.consensus,
      "Timelock should not be a consensus request"
    );
    assert.equal(
      timelockAccount.value.toBase58(),
      guardian.publicKey.toBase58()
    );

    try {
      await program.methods
        .executeConsensus()
        .accounts({
          config: configPDA,
          timelock: timelockPDA,
          guardian: guardian.publicKey,
        })
        .signers([guardian])
        .rpc();
    } catch (error) {
      assert.include(
        error.message,
        "InvalidAction",
        "Expected InvalidAction error"
      );
    }

    timelockAccount = await program.account.request.fetch(timelockPDA);
    assert.ok(
      !timelockAccount.executed,
      "Timelock should not be in executed state"
    );
    assert.ok(!timelockAccount.ack, "Timelock should not be in ack'ed state");
    assert.ok(
      !timelockAccount.consensus,
      "Timelock should not be a consensus request"
    );
  });

  const EthereumzynkOpVaultAddress = "0xy82t3g2v3263712863728g3281378232";
  const EthereumRecipientAddress = "0x12876382t3fg237623r75e121321e21";
  const EthereumTxnOut = "0xbsyuadgwgd816213f2v2g3v723f2tv327t323f27c1v";
  const EthereumTxnIn = "0x8723t4gvru3b2yr8327432gb8dy32ieuh38yeb38e382";
  const BridgeTxnOut = "jidabuibf871yeu3brg3vrg3v3t27vg3vsdfg3";
  const BridgeTxnIn = "0xjkb32f32d3wh87egy3u2vbrg3v3782dgihbdkjfh9273tg3";
  const attestOrderId = generateOrderId();
  const attestOrderTrackerPDA = deriveOrderTrackerPDA(attestOrderId, "attest");
  const amount = new anchor.BN(100);

  it("Should attest cross-chain order creation", async () => {
    const listener = program.addEventListener(
      "orderAttested",
      (event, _slot) => {
        if (!Buffer.from(event.orderId).equals(Buffer.from(attestOrderId)))
          return;

        try {
          assert.equal(event.originChain, "Solana");
          assert.equal(event.targetChain, "Ethereum");
          assert.equal(event.origin, zynkOpVault.toString());
          assert.equal(event.proxy, EthereumzynkOpVaultAddress);
          assert.equal(event.target, EthereumRecipientAddress);
          assert.equal(event.txn, EthereumTxnOut);
          assert.equal(event.proxyTxn, BridgeTxnOut);
          assert.equal(event.asset, "USDC");
          assert.equal(event.proxyAsset, "USDT");
          assert.equal(event.amount.toNumber(), amount.toNumber());
        } catch (err) {
          throw err;
        }
      }
    );

    const message = `${DOMAIN_SEPARATOR}::${zynkOpVault.toString()}::${EthereumzynkOpVaultAddress}::${EthereumRecipientAddress}::${EthereumTxnOut}::${amount}`;
    const { ed25519Ix, signature } = buildEd25519Ix(message, attester);

    await program.methods
      .attestOrder(
        Array.from(attestOrderId),
        "Solana",
        "Ethereum",
        zynkOpVault.toString(),
        EthereumzynkOpVaultAddress,
        EthereumRecipientAddress,
        EthereumTxnOut,
        BridgeTxnOut,
        "USDC",
        "USDT",
        amount,
        Buffer.from(signature).toJSON().data,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        orderTracker: attestOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
      .signers([manager])
      .rpc();

    const orderTrackerAccount = await program.account.orderTracker.fetch(
      attestOrderTrackerPDA
    );
    assert.ok(
      Buffer.from(orderTrackerAccount.orderId).equals(
        Buffer.from(attestOrderId)
      )
    );

    const orderAmountIn = orderTrackerAccount.amountIn;
    const orderAmountOut = orderTrackerAccount.amountOut;
    assert.equal(orderAmountOut.toNumber(), amount.toNumber());
    assert.equal(orderAmountIn.toNumber(), 0);

    assert.equal(
      orderTrackerAccount.partnerDepositVault.toBase58(),
      PublicKey.default.toBase58()
    );
    assert.equal(
      orderTrackerAccount.beneficiaryWallet.toBase58(),
      PublicKey.default.toBase58()
    );

    assert.ok(
      Buffer.from(orderTrackerAccount.partnerId).equals(
        sha256(Buffer.from(EthereumzynkOpVaultAddress))
      )
    );

    await program.removeEventListener(listener);
  });

  it("Should attest cross-chain order closure", async () => {
    const orderTrackerAccount = await program.account.orderTracker.fetch(
      attestOrderTrackerPDA
    );
    assert.ok(
      Buffer.from(orderTrackerAccount.orderId).equals(
        Buffer.from(attestOrderId)
      )
    );
    assert.ok(
      Buffer.from(orderTrackerAccount.partnerId).equals(
        sha256(Buffer.from(EthereumzynkOpVaultAddress))
      )
    );

    const listener = program.addEventListener(
      "orderAttested",
      (event, _slot) => {
        if (!Buffer.from(event.orderId).equals(Buffer.from(attestOrderId)))
          return;

        try {
          assert.equal(event.originChain, "Ethereum");
          assert.equal(event.targetChain, "Solana");
          assert.equal(event.origin, EthereumRecipientAddress);
          assert.equal(event.proxy, EthereumzynkOpVaultAddress);
          assert.equal(event.target, zynkOpVault.toString());
          assert.equal(event.txn, EthereumTxnIn);
          assert.equal(event.proxyTxn, BridgeTxnIn);
          assert.equal(event.asset, "USDT");
          assert.equal(event.proxyAsset, "USDG");
          assert.equal(event.amount.toNumber(), amount.toNumber());
        } catch (err) {
          throw err;
        }
      }
    );

    const message = `${DOMAIN_SEPARATOR}::${EthereumRecipientAddress}::${EthereumzynkOpVaultAddress}::${zynkOpVault.toString()}::${EthereumTxnIn}::${amount}`;
    const { ed25519Ix, signature } = buildEd25519Ix(message, attester);

    await program.methods
      .attestOrder(
        Array.from(attestOrderId),
        "Ethereum",
        "Solana",
        EthereumRecipientAddress,
        EthereumzynkOpVaultAddress,
        zynkOpVault.toString(),
        EthereumTxnIn,
        BridgeTxnIn,
        "USDT",
        "USDG",
        amount,
        Buffer.from(signature).toJSON().data,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        orderTracker: attestOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
      .signers([manager])
      .rpc();

    try {
      await program.account.request.fetch(attestOrderTrackerPDA);
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected `Account does not exist` error"
      );
    }

    await program.removeEventListener(listener);
  });

  it("**Whitelisting disabled ZOV flow**", async () => {
    currentOrderId = generateOrderId();
    currentOrderTrackerPDA = deriveOrderTrackerPDA(currentOrderId);

    const zZovBalance_preTx = await provider.connection.getTokenAccountBalance(
      atas.zZovTokenAccount
    );

    const sourceBalance_preTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );

    const destBalance_preTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount
    );

    ///////////// pullAndCreateOrder ////////////////

    const amount = new anchor.BN(100000000000);

    expect(+sourceBalance_preTx.value.amount).to.be.gte(+amount);

    await program.methods
      .pullAndCreateOrder(
        Array.from(partnerId),
        Array.from(currentOrderId),
        Array.from(zeroZovId),
        false,
        amount,
        null,
        null
      )
      .accounts({
        config: configPDA,
        manager: manager.publicKey,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zynkOpVault: zZynkOpVault,
        zovTokenAccount: atas.zZovTokenAccount,
        beneficiary: null,
        beneficiaryTokenAccount: atas.partnerOperationalTokenAccount,
        orderTracker: currentOrderTrackerPDA,
        systemProgram: SystemProgram.programId,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        sysvarInstructions: null,
      })
      .signers([manager])
      .rpc();

    // Verify token pull
    const sourceBalance_postTx =
      await provider.connection.getTokenAccountBalance(
        atas.partnerDepositTokenAccount
      );
    assert.equal(
      +sourceBalance_preTx.value.amount - +sourceBalance_postTx.value.amount,
      +amount
    );

    // Verify token transfer
    const destBalance_postTx = await provider.connection.getTokenAccountBalance(
      atas.partnerOperationalTokenAccount
    );
    assert.equal(
      +destBalance_postTx.value.amount - +destBalance_preTx.value.amount,
      +amount
    );

    // Verify OrderTracker stores correct details
    const orderTrackerAccount = await program.account.orderTracker.fetch(
      currentOrderTrackerPDA
    );
    assert.equal(
      orderTrackerAccount.partnerDepositVault.toBase58(),
      partnerDepositVaultPDA.toBase58()
    );
    assert.equal(
      orderTrackerAccount.beneficiaryWallet.toBase58(),
      partnerOperationalWallet.publicKey.toBase58()
    );

    const orderAmountIn = orderTrackerAccount.amountIn;
    const orderAmountOut = orderTrackerAccount.amountOut;
    assert.equal(orderAmountIn.toNumber(), amount.toNumber());
    assert.equal(orderAmountOut.toNumber(), amount.toNumber());

    ///////////// replenish ////////////////

    const feeAmount = new anchor.BN(1000000000);

    // Replenish the remaining amount and close the order
    await program.methods
      .replenish(
        Array.from(currentOrderId),
        feeAmount,
        true, // close_order = true
        null
      )
      .accounts({
        config: configPDA,
        partnerDepositVault: partnerDepositVaultPDA,
        pdvTokenAccount: atas.partnerDepositTokenAccount,
        zovTokenAccount: atas.zZovTokenAccount,
        orderTracker: currentOrderTrackerPDA,
        manager: manager.publicKey,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();

    const zZovBalance_postTx = await provider.connection.getTokenAccountBalance(
      atas.zZovTokenAccount
    );

    assert.equal(
      +zZovBalance_postTx.value.amount - +zZovBalance_preTx.value.amount,
      +feeAmount
    );

    // Verify order is closed
    try {
      await program.account.orderTracker.fetch(currentOrderTrackerPDA);
      assert.fail("Expected order to be closed");
    } catch (error) {
      assert.include(
        error.message,
        "Account does not exist",
        "Expected account to be closed"
      );
    }
  });
});

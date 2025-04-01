import { PublicKey, SystemProgram } from "@solana/web3.js";

(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const programId = new PublicKey(
    "7UAhcDLNRpKa4HuCk5MkCLxRGLeRnbjqGxhjePdxPcqB"
  );

  //   const idl = await anchor.Program.fetchIdl(programId, provider);
  //   if (!idl) throw new Error("IDL not found for program");

  const idl = {
    version: "0.1.0",
    name: "zynk_protocol",
    instructions: [
      {
        name: "initialize",
        accounts: [
          {
            name: "config",
            isMut: true,
            isSigner: false,
          },
          {
            name: "admin",
            isMut: true,
            isSigner: true,
          },
          {
            name: "systemProgram",
            isMut: false,
            isSigner: false,
          },
        ],
        args: [
          {
            name: "zynkOpWallet",
            type: "publicKey",
          },
          {
            name: "paybackWallet",
            type: "publicKey",
          },
        ],
      },
      {
        name: "send",
        accounts: [
          {
            name: "config",
            isMut: true,
            isSigner: false,
          },
          {
            name: "zynkOpWallet",
            isMut: true,
            isSigner: true,
          },
          {
            name: "sourceTokenAccount",
            isMut: true,
            isSigner: false,
          },
          {
            name: "partnerOperationalWallet",
            isMut: true,
            isSigner: false,
          },
          {
            name: "tokenProgram",
            isMut: false,
            isSigner: false,
          },
          {
            name: "orderTracker",
            isMut: true,
            isSigner: true,
          },
          {
            name: "systemProgram",
            isMut: false,
            isSigner: false,
          },
        ],
        args: [
          {
            name: "tokenMint",
            type: "publicKey",
          },
          {
            name: "amount",
            type: "u64",
          },
          {
            name: "partnerDepositWallet",
            type: "publicKey",
          },
        ],
      },
      {
        name: "replenish",
        accounts: [
          {
            name: "config",
            isMut: true,
            isSigner: false,
          },
          {
            name: "depositTokenAccount",
            isMut: true,
            isSigner: false,
          },
          {
            name: "paybackTokenAccount",
            isMut: true,
            isSigner: false,
          },
          {
            name: "tokenProgram",
            isMut: false,
            isSigner: false,
          },
          {
            name: "depositWallet",
            isMut: false,
            isSigner: true,
          },
          {
            name: "orderTracker",
            isMut: true,
            isSigner: false,
          },
        ],
        args: [
          {
            name: "orderId",
            type: "u64",
          },
          {
            name: "validity",
            type: "i64",
          },
          {
            name: "paybackAmount",
            type: "u64",
          },
        ],
      },
      {
        name: "closeOrder",
        accounts: [
          {
            name: "config",
            isMut: true,
            isSigner: false,
          },
          {
            name: "admin",
            isMut: true,
            isSigner: true,
          },
          {
            name: "orderTracker",
            isMut: true,
            isSigner: false,
          },
          {
            name: "systemProgram",
            isMut: false,
            isSigner: false,
          },
        ],
        args: [
          {
            name: "orderId",
            type: "u64",
          },
        ],
      },
      {
        name: "updateZynkOpWallet",
        accounts: [
          {
            name: "config",
            isMut: true,
            isSigner: false,
          },
          {
            name: "admin",
            isMut: false,
            isSigner: true,
          },
        ],
        args: [
          {
            name: "newZynkOpWallet",
            type: "publicKey",
          },
        ],
      },
      {
        name: "updatePaybackWallet",
        accounts: [
          {
            name: "config",
            isMut: true,
            isSigner: false,
          },
          {
            name: "admin",
            isMut: false,
            isSigner: true,
          },
        ],
        args: [
          {
            name: "newPaybackWallet",
            type: "publicKey",
          },
        ],
      },
      {
        name: "transferAdmin",
        accounts: [
          {
            name: "config",
            isMut: true,
            isSigner: false,
          },
          {
            name: "admin",
            isMut: false,
            isSigner: true,
          },
        ],
        args: [
          {
            name: "newAdmin",
            type: "publicKey",
          },
        ],
      },
      {
        name: "setPauseState",
        accounts: [
          {
            name: "config",
            isMut: true,
            isSigner: false,
          },
          {
            name: "admin",
            isMut: false,
            isSigner: true,
          },
        ],
        args: [
          {
            name: "paused",
            type: "bool",
          },
        ],
      },
    ],
    accounts: [
      {
        name: "Config",
        type: {
          kind: "struct",
          fields: [
            {
              name: "admin",
              type: "publicKey",
            },
            {
              name: "zynkOpWallet",
              type: "publicKey",
            },
            {
              name: "paybackWallet",
              type: "publicKey",
            },
            {
              name: "paused",
              type: "bool",
            },
            {
              name: "currentNonce",
              type: "u64",
            },
          ],
        },
      },
      {
        name: "OrderTracker",
        type: {
          kind: "struct",
          fields: [
            {
              name: "orderId",
              type: "u64",
            },
            {
              name: "partnerDepositWallet",
              type: "publicKey",
            },
          ],
        },
      },
    ],
    events: [
      {
        name: "Send",
        fields: [
          {
            name: "orderId",
            type: "u64",
            index: false,
          },
          {
            name: "token",
            type: "publicKey",
            index: false,
          },
          {
            name: "partnerDepositWallet",
            type: "publicKey",
            index: false,
          },
          {
            name: "amount",
            type: "u64",
            index: false,
          },
          {
            name: "chainId",
            type: "u64",
            index: false,
          },
        ],
      },
      {
        name: "Replenish",
        fields: [
          {
            name: "orderId",
            type: "u64",
            index: false,
          },
          {
            name: "token",
            type: "publicKey",
            index: false,
          },
          {
            name: "amount",
            type: "u64",
            index: false,
          },
          {
            name: "status",
            type: "bool",
            index: false,
          },
          {
            name: "chainId",
            type: "u64",
            index: false,
          },
        ],
      },
      {
        name: "ReplenishClosure",
        fields: [
          {
            name: "orderId",
            type: "u64",
            index: false,
          },
          {
            name: "timestamp",
            type: "i64",
            index: false,
          },
        ],
      },
    ],
    errors: [
      {
        code: 6000,
        name: "UnauthorizedSender",
        msg: "Unauthorized sender",
      },
      {
        code: 6001,
        name: "InvalidAddress",
        msg: "Invalid address: cannot use null address",
      },
      {
        code: 6002,
        name: "ContractPaused",
        msg: "Contract is paused",
      },
      {
        code: 6003,
        name: "NonceOverflow",
        msg: "Nonce overflow",
      },
      {
        code: 6004,
        name: "UnauthorizedAdmin",
        msg: "Unauthorized admin",
      },
      {
        code: 6005,
        name: "InvalidOrderId",
        msg: "Invalid order ID",
      },
      {
        code: 6006,
        name: "InvalidTokenMint",
        msg: "Invalid token mint",
      },
      {
        code: 6007,
        name: "ValidityMustBeFuture",
        msg: "Validity must be in future",
      },
      {
        code: 6008,
        name: "AmountMustBePositive",
        msg: "Amount must be positive",
      },
    ],
  };

  const program = new anchor.Program(idl, programId, provider);

  const zynkOpWallet = new PublicKey(
    "3r7r8dgdcnd8U3HNXxGvS81JXZntJWNk1pJKrN2JiuDR"
  );
  const paybackWallet = new PublicKey(
    "Hig3PLJPpsbEwYrb1SszggsfYf5pCCByyMHL7LPNAZwb"
  );

  const [configPda, configBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  console.log("Config PDA:", configPda.toString());

  try {
    try {
      const configAccount = await program.account.config.fetch(configPda);
      console.log("✅ Config account already exists:", configAccount);

      console.log({
        success: true,
        message: "Protocol initialized successfully",
        data: {
          admin: configAccount.admin.toString(),
          zynkOpWallet: configAccount.zynkOpWallet.toString(),
          paybackWallet: configAccount.paybackWallet.toString(),
          configAccount: configPda.toString(),
        },
      });
    } catch (e) {
      console.log("⚠️ Config account doesn't exist. Initializing...");

      const tx = await program.methods
        .initialize(zynkOpWallet, paybackWallet)
        .accounts({
          config: configPda,
          admin: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("✅ Transaction signature:", tx);

      // Fetch the config account to verify initialization
      const configAccount = await program.account.config.fetch(configPda);
      console.log("Initialized config account:", configAccount);

      console.log({
        success: true,
        message: "Protocol initialized successfully",
        data: {
          txSignature: tx,
          admin: configAccount.admin.toString(),
          zynkOpWallet: configAccount.zynkOpWallet.toString(),
          paybackWallet: configAccount.paybackWallet.toString(),
          configAccount: configPda.toString(),
        },
      });
    }
  } catch (error) {
    console.error("❌ Error during protocol setup/verification:", error);
  }
})();

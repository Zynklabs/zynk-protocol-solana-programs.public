import { PublicKey, SystemProgram } from "@solana/web3.js";

(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const programId = new PublicKey(
    "7UAhcDLNRpKa4HuCk5MkCLxRGLeRnbjqGxhjePdxPcqB"
  );

  const idl = await anchor.Program.fetchIdl(programId, provider);
  if (!idl) throw new Error("IDL not found for program");

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

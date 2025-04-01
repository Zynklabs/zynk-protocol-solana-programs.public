import { PublicKey, SystemProgram } from "@solana/web3.js";
import * as anchor from "@project-serum/anchor";

interface ConfigAccount {
  admin: PublicKey;
  zynkOpWallet: PublicKey;
  paybackWallet: PublicKey;
  paused: boolean;
  currentNonce: number;
}

(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const _programId = "8u9Ddqh6MQYt1sVcqGmxnz3Mrx2py3WFvywEp7FudhF1";
  const _zynkOpWallet = "3r7r8dgdcnd8U3HNXxGvS81JXZntJWNk1pJKrN2JiuDR";
  const _paybackWallet = "Hig3PLJPpsbEwYrb1SszggsfYf5pCCByyMHL7LPNAZwb";

  const programId = new PublicKey(_programId);

  console.log("Program Id", programId.toString(), programId.toBase58());

  const idl = await anchor.Program.fetchIdl(programId, provider);
  if (!idl) throw new Error("IDL not found for program");

  const program = new anchor.Program(idl, programId, provider);

  const zynkOpWallet = new PublicKey(_zynkOpWallet);
  const paybackWallet = new PublicKey(_paybackWallet);

  const [configPda, configBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  console.log("Config PDA:", configPda.toString());

  try {
    const configAccount = (await program.account.config.fetch(
      configPda
    )) as unknown as ConfigAccount;
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
    const configAccount = (await program.account.config.fetch(
      configPda
    )) as unknown as ConfigAccount;
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
})();

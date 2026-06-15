// Initializes the three computation definitions on devnet and uploads their circuits.
// Run once before deploying / testing against devnet:
//
//   npx ts-node -P tsconfig.json scripts/init_comp_defs.ts
//
// Safe to re-run — already-initialized comp defs are skipped gracefully.

import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import {
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  getCompDefAccOffset,
  getMXEAccAddress,
  getLookupTableAddress,
  uploadCircuit,
} from "@arcium-hq/client";
import { Cypher } from "../target/types/cypher";
import * as fs from "fs";
import * as os from "os";

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

// Must match `declare_id!` in lib.rs for the devnet deployment.
const PROGRAM_ID = new PublicKey(
  "cyphPe923pnPGVXJL3a3P7t2W9mJsagBcg1oeauoh2B",
);

// circuit name (used for PDA + circuit file) → Anchor method name on the program
const CIRCUITS: { circuitName: string; methodName: string }[] = [
  { circuitName: "place_private_bet_yesno",     methodName: "initPlaceBetYesnoCompDef" },
  { circuitName: "reveal_market_outcome_yesno", methodName: "initRevealYesnoCompDef" },
  { circuitName: "compute_yesno_payout",        methodName: "initPayoutYesnoCompDef" },
  { circuitName: "compute_yesno_refund",        methodName: "initRefundYesnoCompDef" },
  { circuitName: "place_private_bet_multi",     methodName: "initPlaceBetMultiCompDef" },
  { circuitName: "reveal_market_outcome_multi", methodName: "initRevealMultiCompDef" },
  { circuitName: "compute_multi_payout",        methodName: "initPayoutMultiCompDef" },
  { circuitName: "compute_multi_refund",        methodName: "initRefundMultiCompDef" },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  const keypairPath =
    process.env.KEYPAIR_PATH || `${os.homedir()}/.config/solana/id.json`;
  const owner = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(keypairPath).toString())),
  );
  console.log("Payer:", owner.publicKey.toBase58());

  const wallet = {
    publicKey: owner.publicKey,
    signTransaction: async (tx: any) => {
      tx.partialSign(owner);
      return tx;
    },
    signAllTransactions: async (txs: any[]) => {
      txs.forEach((tx) => tx.partialSign(owner));
      return txs;
    },
  };

  const provider = new anchor.AnchorProvider(connection, wallet as any, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync("target/idl/cypher.json", "utf-8"),
  );
  const program = new Program<Cypher>(idl, provider);
  const arciumProgram = getArciumProgram(provider);

  // ── Preflight: verify MXE is initialized ────────────────────────────────────
  const mxeAddress = getMXEAccAddress(PROGRAM_ID);
  const mxeInfo = await connection.getAccountInfo(mxeAddress);
  if (!mxeInfo) {
    console.error(`
ERROR: Arcium MXE account not found on devnet.
  MXE address: ${mxeAddress.toBase58()}
  Program ID:  ${PROGRAM_ID.toBase58()}

You need to initialize the MXE first. Run:

  arcium deploy \\
    --keypair-path ~/.config/solana/id.json \\
    --cluster-offset 456 \\
    --recovery-set-size <N> \\
    --rpc-url devnet \\
    --skip-deploy        # omit this flag if the program isn't deployed yet

Then re-run: yarn init:comp-defs
`);
    process.exit(1);
  }

  const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const mxeAcc = await (arciumProgram.account as any).mxeAccount.fetch(
    mxeAddress,
  );
  const lutAddress = getLookupTableAddress(PROGRAM_ID, mxeAcc.lutOffsetSlot);
  console.log("MXE:           ", mxeAddress.toBase58());
  console.log("LUT:           ", lutAddress.toBase58());

  for (const { circuitName, methodName } of CIRCUITS) {
    console.log(`\n─── ${circuitName} ───`);

    const offset = getCompDefAccOffset(circuitName);
    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeed, PROGRAM_ID.toBuffer(), offset],
      getArciumProgramId(),
    )[0];
    console.log("Comp def PDA:", compDefPDA.toBase58());

    // ── Init comp def (idempotent) ───────────────────────────────────────────
    try {
      const sig = await (program.methods as any)
        [methodName]()
        .accounts({
          compDefAccount: compDefPDA,
          payer: owner.publicKey,
          mxeAccount: mxeAddress,
          addressLookupTable: lutAddress,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });

      console.log("Init tx:", sig);
      console.log(
        `Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`,
      );
    } catch (err: any) {
      if (
        err.message?.includes("already in use") ||
        err.message?.includes("already initialized")
      ) {
        console.log(`${circuitName} comp def already initialized — skipping.`);
      } else {
        throw err;
      }
    }

    // ── Upload circuit ───────────────────────────────────────────────────────
    const circuitPath = `build/${circuitName}.arcis`;
    if (!fs.existsSync(circuitPath)) {
      console.warn(`Circuit file not found: ${circuitPath} — skipping upload.`);
      continue;
    }
    console.log(`Uploading ${circuitPath} …`);
    const rawCircuit = fs.readFileSync(circuitPath);
    await uploadCircuit(
      provider,
      circuitName,
      PROGRAM_ID,
      rawCircuit,
      true,
      500,
      {
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
      },
    );
    console.log(`${circuitName} circuit uploaded.`);
  }

  console.log("\n=== All comp defs initialized and circuits uploaded ===");
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});

// comp_defs covers init_yesno_comp_def, init_multioutcome_comp_def, init_accuracy_comp_def.
//
// These instructions create computation definition accounts on the Arcium MXE and
// upload the circuit bytecode. They require the Arcium MXE to be deployed.
//
// Workflow:
//   1. Run `npx ts-node -P tsconfig.json scripts/init_comp_defs.ts` on devnet to
//      initialize all three comp defs and upload circuit files.
//   2. Remove .skip() from the tests below and run the suite against devnet:
//        RPC_URL=<devnet-rpc> anchor test --skip-build --provider.cluster devnet
//
// Each test:
//   - Calls the init instruction (idempotent — handles already-initialized).
//   - Derives the expected comp def PDA and verifies the account exists on-chain.

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getCompDefAccOffset,
  getMXEAccAddress,
  getLookupTableAddress,
} from "@arcium-hq/client";
import { setupGlobal, GlobalFixtures } from "../fixtures/global";

// circuit name (Arcium macro) → Anchor method name
const COMP_DEFS = [
  { circuitName: "settle_yesno",        methodName: "initYesnoCompDef" },
  { circuitName: "settle_multioutcome", methodName: "initMultioutcomeCompDef" },
  { circuitName: "settle_accuracy",     methodName: "initAccuracyCompDef" },
] as const;

function deriveCompDefPDA(programId: PublicKey, circuitName: string): PublicKey {
  const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset(circuitName);
  return PublicKey.findProgramAddressSync(
    [baseSeed, programId.toBuffer(), offset],
    getArciumProgramId()
  )[0];
}

describe("comp_defs", () => {
  let g: GlobalFixtures;

  before(async () => {
    g = await setupGlobal();
  });

  it.skip("initializes the settle_yesno computation definition", async () => {
    const { circuitName, methodName } = COMP_DEFS[0];
    const compDefPDA = deriveCompDefPDA(g.program.programId, circuitName);

    const mxeAccount = getMXEAccAddress(g.program.programId);
    const mxeAcc = await (g.arciumProgram.account as any).mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(g.program.programId, mxeAcc.lutOffsetSlot);

    try {
      const sig = await (g.program.methods as any)
        [methodName]()
        .accounts({
          compDefAccount: compDefPDA,
          payer: g.payer.publicKey,
          mxeAccount,
          addressLookupTable: lutAddress,
        })
        .signers([g.payer])
        .rpc({ commitment: "confirmed" });
      console.log("InitYesnoCompDef tx:", sig);
    } catch (e: any) {
      if (!e.message?.includes("already in use") && !e.message?.includes("already initialized")) {
        throw e;
      }
      console.log("settle_yesno comp def already initialized.");
    }

    const info = await g.provider.connection.getAccountInfo(compDefPDA);
    expect(info, "comp def account should exist on-chain").to.not.be.null;
    expect(info!.data.length).to.be.greaterThan(0);
  });

  it.skip("initializes the settle_multioutcome computation definition", async () => {
    const { circuitName, methodName } = COMP_DEFS[1];
    const compDefPDA = deriveCompDefPDA(g.program.programId, circuitName);

    const mxeAccount = getMXEAccAddress(g.program.programId);
    const mxeAcc = await (g.arciumProgram.account as any).mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(g.program.programId, mxeAcc.lutOffsetSlot);

    try {
      const sig = await (g.program.methods as any)
        [methodName]()
        .accounts({
          compDefAccount: compDefPDA,
          payer: g.payer.publicKey,
          mxeAccount,
          addressLookupTable: lutAddress,
        })
        .signers([g.payer])
        .rpc({ commitment: "confirmed" });
      console.log("InitMultioutcomeCompDef tx:", sig);
    } catch (e: any) {
      if (!e.message?.includes("already in use") && !e.message?.includes("already initialized")) {
        throw e;
      }
      console.log("settle_multioutcome comp def already initialized.");
    }

    const info = await g.provider.connection.getAccountInfo(compDefPDA);
    expect(info, "comp def account should exist on-chain").to.not.be.null;
    expect(info!.data.length).to.be.greaterThan(0);
  });

  it.skip("initializes the settle_accuracy computation definition", async () => {
    const { circuitName, methodName } = COMP_DEFS[2];
    const compDefPDA = deriveCompDefPDA(g.program.programId, circuitName);

    const mxeAccount = getMXEAccAddress(g.program.programId);
    const mxeAcc = await (g.arciumProgram.account as any).mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(g.program.programId, mxeAcc.lutOffsetSlot);

    try {
      const sig = await (g.program.methods as any)
        [methodName]()
        .accounts({
          compDefAccount: compDefPDA,
          payer: g.payer.publicKey,
          mxeAccount,
          addressLookupTable: lutAddress,
        })
        .signers([g.payer])
        .rpc({ commitment: "confirmed" });
      console.log("InitAccuracyCompDef tx:", sig);
    } catch (e: any) {
      if (!e.message?.includes("already in use") && !e.message?.includes("already initialized")) {
        throw e;
      }
      console.log("settle_accuracy comp def already initialized.");
    }

    const info = await g.provider.connection.getAccountInfo(compDefPDA);
    expect(info, "comp def account should exist on-chain").to.not.be.null;
    expect(info!.data.length).to.be.greaterThan(0);
  });
});

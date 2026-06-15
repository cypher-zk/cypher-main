import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  getArciumEnv,
  getCompDefAccOffset,
  getArciumProgramId,
  getArciumProgram,
  uploadCircuit,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getFeePoolAccAddress,
  getClockAccAddress,
  getLookupTableAddress,
} from "@arcium-hq/client";

export function buildArciumProgram(
  provider: anchor.AnchorProvider
): Program<any> {
  return getArciumProgram(provider);
}

export function getArciumEnvConfig(): ReturnType<typeof getArciumEnv> {
  return getArciumEnv();
}

// Registers a single Arcium computation definition with the cypher program and
// then finalizes the circuit via uploadCircuit. The methodName must match the
// instruction in the program (initialize circuits are explicit, e.g.
// `initPlaceBetYesnoCompDef`, not auto-derived).
//
// Matches the registration flow used by the e2e tests: `arcium test` pre-loads
// the raw circuit accounts as genesis accounts, so uploadCircuit detects them,
// skips the upload, and calls finalizeComputationDefinition to move state from
// OnchainPending → OnchainFinalized.
export async function initCompDef(
  provider: anchor.AnchorProvider,
  program: Program<any>,
  payer: anchor.web3.Keypair,
  circuitName: string,
  methodName: string
): Promise<{ compDefPDA: PublicKey; initSig?: string }> {
  const offset = Buffer.from(getCompDefAccOffset(circuitName)).readUInt32LE();
  const compDefPDA = getCompDefAccAddress(program.programId, offset);
  const mxeAccount = getMXEAccAddress(program.programId);
  const lutAddress = getLookupTableAddress(program.programId, new BN(3));

  let initSig: string | undefined;
  try {
    initSig = await (program.methods as any)
      [methodName]()
      .accountsPartial({
        payer: payer.publicKey,
        mxeAccount,
        compDefAccount: compDefPDA,
        addressLookupTable: lutAddress,
      })
      .signers([payer])
      .rpc({ commitment: "confirmed" });
  } catch (_) {
    // Comp def may already be registered from a previous run.
  }

  // Pass a 1-byte placeholder so numAccs=1; pre-loaded genesis accounts pass
  // the size check, and uploadCircuit finalizes them.
  try {
    await uploadCircuit(
      provider,
      circuitName,
      program.programId,
      new Uint8Array(1)
    );
  } catch (_) {
    // Already finalized.
  }

  return { compDefPDA, initSig };
}

// Returns the per-call computation accounts object used in queue_computation
// instructions for the cypher program (place/resolve/claim).
export function buildComputationAccounts(
  program: Program<any>,
  computationOffset: BN,
  circuitName: string,
  arciumEnv: ReturnType<typeof getArciumEnv>
): Record<string, PublicKey> {
  const compDefOffset = Buffer.from(
    getCompDefAccOffset(circuitName)
  ).readUInt32LE();

  return {
    mxeAccount: getMXEAccAddress(program.programId),
    mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    computationAccount: getComputationAccAddress(
      arciumEnv.arciumClusterOffset,
      computationOffset
    ),
    compDefAccount: getCompDefAccAddress(program.programId, compDefOffset),
    clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
    poolAccount: getFeePoolAccAddress(),
    clockAccount: getClockAccAddress(),
    arciumProgram: getArciumProgramId(),
  };
}

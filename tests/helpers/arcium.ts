import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import {
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  uploadCircuit,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
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

// Derives the compDef PDA, calls the matching init method on program,
// then uploads the circuit. Circuit file must exist at build/<circuitName>.arcis.
//
// circuitName: the name used in the Arcium macro (e.g. "settle_yesno") — also
//              the circuit file stem (build/settle_yesno.arcis).
// methodName:  the Anchor method to call (e.g. "initYesnoCompDef"). If omitted,
//              derived automatically as "init<TitleCase(circuitName)>CompDef"
//              which works when the fn name matches the circuit name exactly.
export async function initCompDef(
  provider: anchor.AnchorProvider,
  program: Program<any>,
  arciumProgram: Program<any>,
  payer: anchor.web3.Keypair,
  circuitName: string,
  methodName?: string
): Promise<{ compDefPDA: PublicKey; sig: string }> {
  const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset(circuitName);

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeed, program.programId.toBuffer(), offset],
    getArciumProgramId()
  )[0];

  const mxeAccount = getMXEAccAddress(program.programId);
  const mxeAcc = await (arciumProgram.account as any).mxeAccount.fetch(mxeAccount);
  const lutAddress = getLookupTableAddress(
    program.programId,
    mxeAcc.lutOffsetSlot
  );

  const resolvedMethodName =
    methodName ??
    "init" +
      circuitName
        .split("_")
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join("") +
      "CompDef";

  const sig = await (program.methods as any)
    [resolvedMethodName]()
    .accounts({
      compDefAccount: compDefPDA,
      payer: payer.publicKey,
      mxeAccount,
      addressLookupTable: lutAddress,
    })
    .signers([payer])
    .rpc({ commitment: "confirmed" });

  const rawCircuit = fs.readFileSync(`build/${circuitName}.arcis`);
  await uploadCircuit(
    provider,
    circuitName,
    program.programId,
    rawCircuit,
    true,
    500,
    {
      skipPreflight: true,
      preflightCommitment: "confirmed",
      commitment: "confirmed",
    }
  );

  return { compDefPDA, sig };
}

// Returns the accountsPartial object for queue_settlement_* calls.
export function buildComputationAccounts(
  program: Program<any>,
  computationOffset: anchor.BN,
  circuitName: string,
  arciumEnv: ReturnType<typeof getArciumEnv>
): Record<string, PublicKey> {
  const compDefOffset = Buffer.from(
    getCompDefAccOffset(circuitName)
  ).readUInt32LE();

  return {
    computationAccount: getComputationAccAddress(
      arciumEnv.arciumClusterOffset,
      computationOffset
    ),
    clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
    mxeAccount: getMXEAccAddress(program.programId),
    mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    compDefAccount: getCompDefAccAddress(program.programId, compDefOffset),
  };
}

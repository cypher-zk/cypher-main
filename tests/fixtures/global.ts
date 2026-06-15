import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import { buildProvider } from "../helpers/provider";
import { buildArciumProgram, getArciumEnvConfig } from "../helpers/arcium";
import { createMint, createTokenAccount, mintTo } from "../helpers/token";
import { deriveGlobalStatePda } from "../helpers/pda";
import {
  SUITE_BUDGET,
  PROTOCOL_FEE_BPS,
  LP_FEE_BPS,
} from "../helpers/types";
import { getArciumEnv } from "@arcium-hq/client";

export interface GlobalFixtures {
  provider: anchor.AnchorProvider;
  program: Program<any>;
  arciumProgram: Program<any>;
  arciumEnv: ReturnType<typeof getArciumEnv>;
  payer: Keypair;
  usdcMint: PublicKey;
  treasury: PublicKey;
  creatorUsdcAccount: PublicKey;
  globalStatePda: PublicKey;
}

// Call inside each suite's root before(). Does NOT register before/after itself.
// Handles the case where another suite has already initialised the global
// state — reads accepted_mint / treasury from the on-chain account instead of
// creating fresh ones.
export async function setupGlobal(): Promise<GlobalFixtures> {
  const provider = buildProvider();
  const rawIdl = JSON.parse(fs.readFileSync("target/idl/cypher.json", "utf-8"));
  const program = new (anchor as any).Program(rawIdl, provider) as Program<any>;
  const arciumProgram = buildArciumProgram(provider);
  const arciumEnv = getArciumEnvConfig();
  const payer = (provider.wallet as any).payer as Keypair;

  const globalStatePda = deriveGlobalStatePda(program.programId);

  let usdcMint: PublicKey;
  let treasury: PublicKey;
  let creatorUsdcAccount: PublicKey;

  const existing = await provider.connection.getAccountInfo(globalStatePda);

  if (existing) {
    const gs: any = await program.account.globalState.fetch(globalStatePda);
    usdcMint = gs.acceptedMint;
    treasury = gs.protocolTreasury;
    creatorUsdcAccount = await createTokenAccount(
      provider.connection,
      payer,
      usdcMint,
      payer.publicKey,
    );
    await mintTo(
      provider.connection,
      payer,
      usdcMint,
      creatorUsdcAccount,
      payer,
      SUITE_BUDGET,
    );
    await new Promise((r) => setTimeout(r, 2000));
  } else {
    usdcMint = await createMint(provider.connection, payer, payer.publicKey);
    treasury = await createTokenAccount(
      provider.connection,
      payer,
      usdcMint,
      payer.publicKey,
    );
    creatorUsdcAccount = await createTokenAccount(
      provider.connection,
      payer,
      usdcMint,
      payer.publicKey,
    );
    await mintTo(
      provider.connection,
      payer,
      usdcMint,
      creatorUsdcAccount,
      payer,
      SUITE_BUDGET,
    );

    const sig = await program.methods
      .initialize(PROTOCOL_FEE_BPS, LP_FEE_BPS)
      .accountsPartial({
        admin: payer.publicKey,
        globalState: globalStatePda,
        protocolTreasury: treasury,
        acceptedMint: usdcMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("Initialize tx:", sig);
    await new Promise((r) => setTimeout(r, 2000));
  }

  return {
    provider,
    program,
    arciumProgram,
    arciumEnv,
    payer,
    usdcMint,
    treasury,
    creatorUsdcAccount,
    globalStatePda,
  };
}

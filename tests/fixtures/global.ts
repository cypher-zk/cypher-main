import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { CypherMain } from "../../target/types/cypher_main";
import { buildProvider } from "../helpers/provider";
import { buildArciumProgram, getArciumEnvConfig } from "../helpers/arcium";
import { createMint, createTokenAccount, mintTo } from "../helpers/token";
import { deriveCypherMarketPda } from "../helpers/pda";
import {
  SUITE_BUDGET,
  PROTOCOL_FEE_BPS,
  LP_FEE_BPS,
  ACCURACY_PLATFORM_FEE_BPS,
} from "../helpers/types";
import { getArciumEnv } from "@arcium-hq/client";

export interface GlobalFixtures {
  provider: anchor.AnchorProvider;
  program: Program<CypherMain>;
  arciumProgram: Program<any>;
  arciumEnv: ReturnType<typeof getArciumEnv>;
  payer: Keypair;
  usdcMint: PublicKey;
  creatorUsdcAccount: PublicKey;
  cyperMarketPda: PublicKey;
}

// Call inside each suite's root before(). Does NOT register before/after itself.
// Handles the case where initialize.test.ts (which runs first) has already
// initialised the PDA — reads accepted_mint from the on-chain account instead
// of creating a fresh one.
export async function setupGlobal(): Promise<GlobalFixtures> {
  const provider = buildProvider();
  const program = anchor.workspace.CypherMain as Program<CypherMain>;
  const arciumProgram = buildArciumProgram(provider);
  const arciumEnv = getArciumEnvConfig();
  const payer = (provider.wallet as any).payer as Keypair;

  const cyperMarketPda = deriveCypherMarketPda(program.programId);

  let usdcMint: PublicKey;
  let creatorUsdcAccount: PublicKey;

  const existing = await provider.connection.getAccountInfo(cyperMarketPda);

  if (existing) {
    // initialize.test.ts already ran; borrow the mint it set in the config.
    const cm = await program.account.cyperMarket.fetch(cyperMarketPda);
    usdcMint = cm.acceptedMint;
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
    const treasury = await createTokenAccount(
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
      .initialize(PROTOCOL_FEE_BPS, LP_FEE_BPS, ACCURACY_PLATFORM_FEE_BPS)
      .accountsPartial({
        cypherMarket: cyperMarketPda,
        treasury,
        acceptedMint: usdcMint,
        authority: payer.publicKey,
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
    creatorUsdcAccount,
    cyperMarketPda,
  };
}

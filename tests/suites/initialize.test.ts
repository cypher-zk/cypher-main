// NOTE: Error-path tests (FeeTooHigh, InvalidMint) MUST run before the happy
// path because `cypher_market` uses #[account(init, ...)]. Once the PDA
// exists, every subsequent init attempt fails immediately with
// AccountAlreadyInitialized (from the system program), before Anchor even
// evaluates the constraint or require!() checks.
//
// This suite is intentionally self-contained — it does not call setupGlobal()
// so that it controls the exact moment the PDA is created.

import { expect } from "chai";
import * as anchor from "@anchor-lang/core";
import { AnchorError, Program } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { CypherMain } from "../../target/types/cypher_main";
import { buildProvider } from "../helpers/provider";
import { createMint, createTokenAccount } from "../helpers/token";
import { deriveCypherMarketPda } from "../helpers/pda";
import {
  PROTOCOL_FEE_BPS,
  LP_FEE_BPS,
  ACCURACY_PLATFORM_FEE_BPS,
} from "../helpers/types";

describe("initialize", () => {
  let provider: anchor.AnchorProvider;
  let program: Program<CypherMain>;
  let payer: Keypair;
  let usdcMint: PublicKey;
  let treasury: PublicKey;
  let cyperMarketPda: PublicKey;

  before(async () => {
    provider = buildProvider();
    program = anchor.workspace.CypherMain as Program<CypherMain>;
    payer = (provider.wallet as any).payer as Keypair;
    usdcMint = await createMint(provider.connection, payer, payer.publicKey);
    treasury = await createTokenAccount(
      provider.connection,
      payer,
      usdcMint,
      payer.publicKey,
    );
    cyperMarketPda = deriveCypherMarketPda(program.programId);
  });

  // ── Validation error paths (run BEFORE happy path — PDA does not yet exist) ─

  it("rejects when protocol_fee_bps + lp_fee_bps > 1000", async () => {
    // 900 + 200 = 1100 — exceeds the 1000 bps combined cap
    let succeeded = false;
    try {
      await program.methods
        .initialize(900, 200, ACCURACY_PLATFORM_FEE_BPS)
        .accountsPartial({
          cypherMarket: cyperMarketPda,
          treasury,
          acceptedMint: usdcMint,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("FeeTooHigh");
      }
    }
    expect(succeeded, "protocol+lp fee > 1000 bps should be rejected").to.be
      .false;
  });

  it("rejects when accuracy_platform_fee_bps > 5000", async () => {
    let succeeded = false;
    try {
      await program.methods
        .initialize(PROTOCOL_FEE_BPS, LP_FEE_BPS, 5001)
        .accountsPartial({
          cypherMarket: cyperMarketPda,
          treasury,
          acceptedMint: usdcMint,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("FeeTooHigh");
      }
    }
    expect(succeeded, "accuracy fee > 5000 bps should be rejected").to.be.false;
  });

  it("rejects when treasury.mint does not match accepted_mint (InvalidMint)", async () => {
    const wrongMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
    );
    const wrongTreasury = await createTokenAccount(
      provider.connection,
      payer,
      wrongMint,
      payer.publicKey,
    );

    let succeeded = false;
    try {
      await program.methods
        .initialize(PROTOCOL_FEE_BPS, LP_FEE_BPS, ACCURACY_PLATFORM_FEE_BPS)
        .accountsPartial({
          cypherMarket: cyperMarketPda,
          treasury: wrongTreasury,
          acceptedMint: usdcMint,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("InvalidMint");
      }
    }
    expect(succeeded, "treasury with wrong mint should be rejected").to.be
      .false;
  });

  // Verify that all three failed transactions left no on-chain state
  it("cypher_market PDA does not exist after failed calls", async () => {
    const info = await provider.connection.getAccountInfo(cyperMarketPda);
    expect(info, "PDA should not exist after failed inits").to.be.null;
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("initializes the protocol and stores correct state", async () => {
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

    const cm = await program.account.cyperMarket.fetch(cyperMarketPda);

    expect(cm.authority.toBase58()).to.equal(payer.publicKey.toBase58());
    expect(cm.treasury.toBase58()).to.equal(treasury.toBase58());
    expect(cm.acceptedMint.toBase58()).to.equal(usdcMint.toBase58());
    expect(cm.protocolFeeBps).to.equal(PROTOCOL_FEE_BPS);
    expect(cm.lpFeeBps).to.equal(LP_FEE_BPS);
    expect(cm.accuracyPlatformFeeBps).to.equal(ACCURACY_PLATFORM_FEE_BPS);
    expect(cm.marketCount.toNumber()).to.equal(0);
    expect(cm.isPaused).to.be.false;
  });

  // ── Re-initialization guard ──────────────────────────────────────────────

  it("rejects re-initialization of an already-initialized PDA", async () => {
    let succeeded = false;
    try {
      await program.methods
        .initialize(PROTOCOL_FEE_BPS, LP_FEE_BPS, ACCURACY_PLATFORM_FEE_BPS)
        .accountsPartial({
          cypherMarket: cyperMarketPda,
          treasury,
          acceptedMint: usdcMint,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch {
      // Expected: system program returns "account already in use"
    }
    expect(succeeded, "re-init of a live PDA should be rejected").to.be.false;
  });

  it("on-chain state is unchanged after failed re-init", async () => {
    const cm = await program.account.cyperMarket.fetch(cyperMarketPda);
    expect(cm.protocolFeeBps).to.equal(PROTOCOL_FEE_BPS);
    expect(cm.lpFeeBps).to.equal(LP_FEE_BPS);
    expect(cm.accuracyPlatformFeeBps).to.equal(ACCURACY_PLATFORM_FEE_BPS);
    expect(cm.marketCount.toNumber()).to.equal(0);
    expect(cm.isPaused).to.be.false;
  });
});

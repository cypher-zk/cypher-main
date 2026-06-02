// create_tier_market covers:
//   1. UnauthorizedAuthority — non-creator tries to create tier market
//   2. InvalidResolvedValueType — non-Accuracy group rejected
//   3. happy path Micro   (tier_byte=0, bet_size=1_000_000)
//   4. happy path Standard (tier_byte=1, bet_size=10_000_000)
//   5. happy path Whale   (tier_byte=2, bet_size=100_000_000)
//   6. re-init guard — Micro market PDA already exists
//
// Each tier produces a distinct PDA so all three happy paths are independent.
// Error paths run BEFORE their respective PDAs are created.

import { expect } from "chai";
import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { setupGlobal, GlobalFixtures } from "../fixtures/global";
import {
  deriveMarketGroupPda,
  deriveBondPda,
  deriveBondVaultPda,
  deriveBondVaultAuthorityPda,
  deriveMarketPda,
} from "../helpers/pda";

const YESNO = { yesNo: {} };
const ACCURACY = { accuracy: {} };
const CAT_OTHER = { other: {} };
const ORACLE_MANUAL = { manual: {} };

const TIER_MICRO = { micro: {} };
const TIER_STANDARD = { standard: {} };
const TIER_WHALE = { whale: {} };

// Matches Tier::bet_size() in states.rs
const BET_SIZE_MICRO = 1_000_000;
const BET_SIZE_STANDARD = 10_000_000;
const BET_SIZE_WHALE = 100_000_000;

describe("create_tier_market", () => {
  let g: GlobalFixtures;
  let creator: Keypair;
  let creatorTokenAccount: PublicKey;

  let accuracyGroupPda: PublicKey; // Accuracy — used for all three happy paths + unauthorized
  let yesnoGroupPda: PublicKey;    // YesNo — used for InvalidResolvedValueType test

  async function createGroup(marketType: any): Promise<PublicKey> {
    const cm = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);
    const groupIndex = cm.marketCount;
    const marketGroupPda = deriveMarketGroupPda(
      g.program.programId,
      g.cyperMarketPda,
      BigInt(groupIndex.toString())
    );
    const bondPda = deriveBondPda(g.program.programId, marketGroupPda);
    const bondVaultPda = deriveBondVaultPda(g.program.programId, bondPda);
    const bondVaultAuthorityPda = deriveBondVaultAuthorityPda(
      g.program.programId,
      bondPda
    );
    const now = Math.floor(Date.now() / 1000);

    await g.program.methods
      .createMarketGroup(
        marketType,
        CAT_OTHER,
        ORACLE_MANUAL,
        creator.publicKey,
        null,
        null,
        "Will this tier market test pass?",
        [],
        new anchor.BN(now + 300),
        new anchor.BN(now + 3900)
      )
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: marketGroupPda,
        bond: bondPda,
        bondVault: bondVaultPda,
        bondVaultAuthority: bondVaultAuthorityPda,
        creatorTokenAccount,
        acceptedMint: g.usdcMint,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    return marketGroupPda;
  }

  before(async () => {
    g = await setupGlobal();
    creator = g.payer;
    creatorTokenAccount = g.creatorUsdcAccount;

    accuracyGroupPda = await createGroup(ACCURACY);
    yesnoGroupPda = await createGroup(YESNO);
  });

  // ── Validation error paths (run BEFORE happy paths) ───────────────────────

  it("rejects when caller is not the market group creator (UnauthorizedAuthority)", async () => {
    const nonCreator = Keypair.generate();
    const airdropSig = await g.provider.connection.requestAirdrop(
      nonCreator.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await g.provider.connection.confirmTransaction(airdropSig, "confirmed");

    const marketPda = deriveMarketPda(g.program.programId, accuracyGroupPda, 0);

    let succeeded = false;
    try {
      await g.program.methods
        .createTierMarket(TIER_MICRO)
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: accuracyGroupPda,
          market: marketPda,
          creator: nonCreator.publicKey,
        })
        .signers([nonCreator])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("UnauthorizedAuthority");
      }
    }
    expect(succeeded, "non-creator should be rejected").to.be.false;
  });

  it("rejects when market_group is not Accuracy type (InvalidResolvedValueType)", async () => {
    const marketPda = deriveMarketPda(g.program.programId, yesnoGroupPda, 0);

    let succeeded = false;
    try {
      await g.program.methods
        .createTierMarket(TIER_MICRO)
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: yesnoGroupPda,
          market: marketPda,
          creator: creator.publicKey,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("InvalidResolvedValueType");
      }
    }
    expect(
      succeeded,
      "non-Accuracy market type should be rejected by create_tier_market"
    ).to.be.false;
  });

  // ── Happy paths — one per tier ─────────────────────────────────────────────

  it("creates Micro tier market (tier_byte=0, bet_size=1_000_000)", async () => {
    const marketPda = deriveMarketPda(g.program.programId, accuracyGroupPda, 0);
    const cm = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);

    const sig = await g.program.methods
      .createTierMarket(TIER_MICRO)
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: accuracyGroupPda,
        market: marketPda,
        creator: creator.publicKey,
      })
      .rpc({ commitment: "confirmed" });
    console.log("CreateTierMarket (Micro) tx:", sig);

    const market = await g.program.account.market.fetch(marketPda);
    expect(market.group.toBase58()).to.equal(accuracyGroupPda.toBase58());
    expect(market.marketType).to.have.property("accuracy");
    expect(market.tierByte).to.equal(0);
    expect(market.betSize.toNumber()).to.equal(BET_SIZE_MICRO);
    expect(market.protocolFeeBps).to.equal(cm.protocolFeeBps);
    expect(market.lpFeeBps).to.equal(cm.lpFeeBps);
    expect(market.totalParticipants.toNumber()).to.equal(0);
    expect(market.totalVolume.toNumber()).to.equal(0);
  });

  it("creates Standard tier market (tier_byte=1, bet_size=10_000_000)", async () => {
    const marketPda = deriveMarketPda(g.program.programId, accuracyGroupPda, 1);
    const cm = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);

    const sig = await g.program.methods
      .createTierMarket(TIER_STANDARD)
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: accuracyGroupPda,
        market: marketPda,
        creator: creator.publicKey,
      })
      .rpc({ commitment: "confirmed" });
    console.log("CreateTierMarket (Standard) tx:", sig);

    const market = await g.program.account.market.fetch(marketPda);
    expect(market.group.toBase58()).to.equal(accuracyGroupPda.toBase58());
    expect(market.marketType).to.have.property("accuracy");
    expect(market.tierByte).to.equal(1);
    expect(market.betSize.toNumber()).to.equal(BET_SIZE_STANDARD);
    expect(market.protocolFeeBps).to.equal(cm.protocolFeeBps);
    expect(market.lpFeeBps).to.equal(cm.lpFeeBps);
    expect(market.totalParticipants.toNumber()).to.equal(0);
    expect(market.totalVolume.toNumber()).to.equal(0);
  });

  it("creates Whale tier market (tier_byte=2, bet_size=100_000_000)", async () => {
    const marketPda = deriveMarketPda(g.program.programId, accuracyGroupPda, 2);
    const cm = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);

    const sig = await g.program.methods
      .createTierMarket(TIER_WHALE)
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: accuracyGroupPda,
        market: marketPda,
        creator: creator.publicKey,
      })
      .rpc({ commitment: "confirmed" });
    console.log("CreateTierMarket (Whale) tx:", sig);

    const market = await g.program.account.market.fetch(marketPda);
    expect(market.group.toBase58()).to.equal(accuracyGroupPda.toBase58());
    expect(market.marketType).to.have.property("accuracy");
    expect(market.tierByte).to.equal(2);
    expect(market.betSize.toNumber()).to.equal(BET_SIZE_WHALE);
    expect(market.protocolFeeBps).to.equal(cm.protocolFeeBps);
    expect(market.lpFeeBps).to.equal(cm.lpFeeBps);
    expect(market.totalParticipants.toNumber()).to.equal(0);
    expect(market.totalVolume.toNumber()).to.equal(0);
  });

  // ── Re-init guard ─────────────────────────────────────────────────────────

  it("rejects re-initialization of an already-created tier market", async () => {
    const marketPda = deriveMarketPda(g.program.programId, accuracyGroupPda, 0);

    let succeeded = false;
    try {
      await g.program.methods
        .createTierMarket(TIER_MICRO)
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: accuracyGroupPda,
          market: marketPda,
          creator: creator.publicKey,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch {
      // Expected: system program returns "account already in use"
    }
    expect(succeeded, "re-init of an existing tier market should be rejected").to
      .be.false;
  });
});

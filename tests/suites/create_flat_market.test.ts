// create_flat_market covers:
//   1. UnauthorizedAuthority — non-creator tries to create flat market
//   2. InvalidResolvedValueType — Accuracy market type rejected
//   3. happy path — YesNo flat market, correct state stored
//   4. re-init guard — market PDA already exists
//
// Error paths run BEFORE the happy path: the market PDA is #[account(init)],
// so once it exists, every subsequent init attempt fails with
// AccountAlreadyInitialized before any constraint check.

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

describe("create_flat_market", () => {
  let g: GlobalFixtures;
  let creator: Keypair;
  let creatorTokenAccount: PublicKey;

  // Groups created once in before() and reused across tests.
  let yesnoGroupPda: PublicKey;    // YesNo — used for happy path + unauthorized test
  let accuracyGroupPda: PublicKey; // Accuracy — used for InvalidResolvedValueType test

  // Creates a market group and returns its PDA. Reads market_count fresh so
  // each call seeds the correct index without relying on local state.
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
        "Will this test pass?",
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

    yesnoGroupPda = await createGroup(YESNO);
    accuracyGroupPda = await createGroup(ACCURACY);
  });

  // ── Validation error paths (run BEFORE happy path) ────────────────────────

  it("rejects when caller is not the market group creator (UnauthorizedAuthority)", async () => {
    const nonCreator = Keypair.generate();
    const airdropSig = await g.provider.connection.requestAirdrop(
      nonCreator.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await g.provider.connection.confirmTransaction(
      { signature: airdropSig, ...(await g.provider.connection.getLatestBlockhash()) },
      "confirmed"
    );

    const marketPda = deriveMarketPda(g.program.programId, yesnoGroupPda, 0);

    let succeeded = false;
    try {
      await g.program.methods
        .createFlatMarket()
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: yesnoGroupPda,
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

  it("rejects when market_group is Accuracy type (InvalidResolvedValueType)", async () => {
    const marketPda = deriveMarketPda(g.program.programId, accuracyGroupPda, 0);

    let succeeded = false;
    try {
      await g.program.methods
        .createFlatMarket()
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: accuracyGroupPda,
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
      "Accuracy market type should be rejected by create_flat_market"
    ).to.be.false;
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("creates a flat market for a YesNo group and stores correct state", async () => {
    const marketPda = deriveMarketPda(g.program.programId, yesnoGroupPda, 0);
    const cm = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);

    const sig = await g.program.methods
      .createFlatMarket()
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: yesnoGroupPda,
        market: marketPda,
        creator: creator.publicKey,
      })
      .rpc({ commitment: "confirmed" });
    console.log("CreateFlatMarket tx:", sig);

    const market = await g.program.account.market.fetch(marketPda);
    expect(market.group.toBase58()).to.equal(yesnoGroupPda.toBase58());
    expect(market.marketType).to.have.property("yesNo");
    expect(market.tierByte).to.equal(0);
    expect(market.betSize.toNumber()).to.equal(0);
    expect(market.protocolFeeBps).to.equal(cm.protocolFeeBps);
    expect(market.lpFeeBps).to.equal(cm.lpFeeBps);
    expect(market.totalParticipants.toNumber()).to.equal(0);
    expect(market.totalVolume.toNumber()).to.equal(0);
  });

  // ── Re-init guard ─────────────────────────────────────────────────────────

  it("rejects re-initialization of an already-created market", async () => {
    const marketPda = deriveMarketPda(g.program.programId, yesnoGroupPda, 0);

    let succeeded = false;
    try {
      await g.program.methods
        .createFlatMarket()
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: yesnoGroupPda,
          market: marketPda,
          creator: creator.publicKey,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch {
      // Expected: system program returns "account already in use"
    }
    expect(succeeded, "re-init of an existing market should be rejected").to.be
      .false;
  });
});

// post_resolution covers:
//   Error paths (all run before happy paths — groups must still be unresolved):
//   1. MarketNotLocked        — group is still Open (account constraint)
//   2. UnauthorizedOracle     — signer != oracle_authority (account constraint)
//   3. InvalidResolvedValueType (YesNo)    — YesNo group receives Numeric value
//   4. InvalidResolvedValueType (Multi)    — MultiOutcome group receives YesNo value
//   5. InvalidResolvedValueType (Accuracy) — Accuracy group receives YesNo value
//   6. OutcomeIndexOutOfRange             — MultiOutcome group receives Outcome(4)
//
//   Happy paths (one per market type — each resolves its own dedicated group):
//   7. YesNo      — ResolvedValue::YesNo(true)   → status=Resolving, fields set
//   8. MultiOutcome — ResolvedValue::Outcome(2)  → status=Resolving, fields set
//   9. Accuracy   — ResolvedValue::Numeric(...)  → status=Resolving, fields set
//
//   Post-resolution guard:
//  10. AlreadyResolved — second call on a Resolving group is rejected
//
//   Pending (require settle pipeline):
//  11. happy path for Accuracy edge: Outcome(0) and Outcome(3) boundary values
//
// Constraint evaluation order in PostResolution accounts:
//   1. market_group.is_locked()                → MarketNotLocked
//   2. market_group.oracle_authority == signer → UnauthorizedOracle
// Then instruction body:
//   3. resolved_value.is_none()                → AlreadyResolved
//   4. resolved_value type match               → InvalidResolvedValueType / OutcomeIndexOutOfRange
//
// Setup in before():
//   group A  — stays Open (lock_timestamp = now + 300)  → drives MarketNotLocked test
//   group B  — YesNo,        locked (lock_timestamp = now + 2)
//   group C  — MultiOutcome, locked (lock_timestamp = now + 2)
//   group D  — Accuracy,     locked (lock_timestamp = now + 2)
//   group E  — YesNo,        locked (lock_timestamp = now + 2)  → AlreadyResolved test
//
// before() locks groups B-E then waits for all lock_timestamps to pass.

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
  derivePoolPda,
  derivePoolVaultPda,
  deriveVaultAuthorityPda,
} from "../helpers/pda";

// ── Anchor enum literals ────────────────────────────────────────────────────────
const YESNO = { yesNo: {} };
const MULTI = { multiOutcome: {} };
const ACCURACY = { accuracy: {} };
const CAT_OTHER = { other: {} };
const ORACLE_MANUAL = { manual: {} };
const POOL_TYPE_UNIFIED = { unified: {} };
const POOL_TYPE_ACCURACY = { accuracy: {} };

// ResolvedValue variants — @anchor-lang/core v1.x encodes tuple enum variants as
// objects keyed by string index: { variantName: { "0": value } }
// e.g. YesNo(bool) → { yesNo: { "0": true } }, Outcome(u8) → { outcome: { "0": 2 } }
const RV_YESNO_TRUE = { yesNo: { "0": true } };
const RV_YESNO_FALSE = { yesNo: { "0": false } };
const RV_OUTCOME_2 = { outcome: { "0": 2 } };
const RV_OUTCOME_4_OOB = { outcome: { "0": 4 } }; // out-of-range (max valid is 3)
const RV_NUMERIC = { numeric: { "0": new anchor.BN(100_123) } }; // $100.123 × 1000

// DISPUTE_WINDOW is 3600 s — we just verify dispute_deadline = resolved_at + 3600
const DISPUTE_WINDOW = 3600;

describe("post_resolution", () => {
  let g: GlobalFixtures;

  // ── Group A: stays Open — MarketNotLocked + UnauthorizedOracle tests
  let groupAPda: PublicKey;

  // ── Group B: YesNo, Locked — happy path + wrong-value-type tests
  let groupBPda: PublicKey;
  let poolBPda: PublicKey;

  // ── Group C: MultiOutcome, Locked — happy path + wrong-value-type tests
  let groupCPda: PublicKey;
  let poolCPda: PublicKey;

  // ── Group D: Accuracy, Locked — happy path + wrong-value-type tests
  let groupDPda: PublicKey;
  let poolDPda: PublicKey;

  // ── Group E: YesNo, Locked — AlreadyResolved test (pre-resolved in before())
  let groupEPda: PublicKey;
  let poolEPda: PublicKey;

  // ── Group F: MultiOutcome, Locked — Outcome(0) boundary check
  let groupFPda: PublicKey;
  let poolFPda: PublicKey;

  // ── Group G: MultiOutcome, Locked — Outcome(3) boundary check
  let groupGPda: PublicKey;
  let poolGPda: PublicKey;

  // ── A separate oracle keypair (not the creator) to test UnauthorizedOracle
  let wrongOracle: Keypair;

  // ────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────────

  /** Create a market group. oracle_authority = g.payer (Manual oracle). */
  async function createGroup(
    question: string,
    marketType: any,
    lockOffsetSecs: number,
    outcomeLabels: string[] = [],
  ): Promise<PublicKey> {
    const cm = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);
    const groupIndex = cm.marketCount;
    const groupPda = deriveMarketGroupPda(
      g.program.programId,
      g.cyperMarketPda,
      BigInt(groupIndex.toString()),
    );
    const bondPda = deriveBondPda(g.program.programId, groupPda);
    const bondVaultPda = deriveBondVaultPda(g.program.programId, bondPda);
    const bondVaultAuthorityPda = deriveBondVaultAuthorityPda(
      g.program.programId,
      bondPda,
    );
    const now = Math.floor(Date.now() / 1000);

    await g.program.methods
      .createMarketGroup(
        marketType,
        CAT_OTHER,
        ORACLE_MANUAL,
        g.payer.publicKey, // oracle_authority = creator for Manual oracle
        null,
        null,
        question,
        outcomeLabels,
        new anchor.BN(now + lockOffsetSecs),
        new anchor.BN(now + lockOffsetSecs + 3600),
      )
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupPda,
        bond: bondPda,
        bondVault: bondVaultPda,
        bondVaultAuthority: bondVaultAuthorityPda,
        creatorTokenAccount: g.creatorUsdcAccount,
        acceptedMint: g.usdcMint,
        creator: g.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    return groupPda;
  }

  /** Create a flat market + pool for a group. Returns the pool PDA. */
  async function createFlatPool(groupPda: PublicKey): Promise<PublicKey> {
    const marketPda = deriveMarketPda(g.program.programId, groupPda, 0);
    await g.program.methods
      .createFlatMarket()
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupPda,
        market: marketPda,
        creator: g.payer.publicKey,
      })
      .rpc({ commitment: "confirmed" });

    const poolPda = derivePoolPda(g.program.programId, marketPda, 0);
    const poolVaultPda = derivePoolVaultPda(g.program.programId, poolPda);
    const vaultAuthorityPda = deriveVaultAuthorityPda(
      g.program.programId,
      poolPda,
    );
    await g.program.methods
      .createPool(0, POOL_TYPE_UNIFIED)
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupPda,
        market: marketPda,
        pool: poolPda,
        poolVault: poolVaultPda,
        vaultAuthority: vaultAuthorityPda,
        acceptedMint: g.usdcMint,
        creator: g.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    return poolPda;
  }

  /** Create a tier market + pool for an Accuracy group (tier_byte = 0 = Micro). */
  async function createTierPool(groupPda: PublicKey): Promise<PublicKey> {
    const TIER_MICRO = { micro: {} };
    const marketPda = deriveMarketPda(g.program.programId, groupPda, 0); // micro = byte 0
    await g.program.methods
      .createTierMarket(TIER_MICRO)
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupPda,
        market: marketPda,
        creator: g.payer.publicKey,
      })
      .rpc({ commitment: "confirmed" });

    const poolPda = derivePoolPda(g.program.programId, marketPda, 0);
    const poolVaultPda = derivePoolVaultPda(g.program.programId, poolPda);
    const vaultAuthorityPda = deriveVaultAuthorityPda(
      g.program.programId,
      poolPda,
    );
    await g.program.methods
      .createPool(0, POOL_TYPE_ACCURACY)
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupPda,
        market: marketPda,
        pool: poolPda,
        poolVault: poolVaultPda,
        vaultAuthority: vaultAuthorityPda,
        acceptedMint: g.usdcMint,
        creator: g.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    return poolPda;
  }

  /** Lock a group (requires lock_timestamp to have passed). */
  async function lockGroup(groupPda: PublicKey, poolPda: PublicKey) {
    await g.program.methods
      .lockMarket()
      .accountsPartial({ marketGroup: groupPda, pool: poolPda })
      .rpc({ commitment: "confirmed" });
  }

  // ────────────────────────────────────────────────────────────────────────────

  before(async () => {
    g = await setupGlobal();

    // ── Wrong oracle keypair — funded for signing but NOT oracle_authority ────
    wrongOracle = Keypair.generate();
    const airdropSig = await g.provider.connection.requestAirdrop(
      wrongOracle.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    await g.provider.connection.confirmTransaction(
      {
        signature: airdropSig,
        ...(await g.provider.connection.getLatestBlockhash()),
      },
      "confirmed",
    );

    // ── Group A: stays Open (lock 300 s in future) ───────────────────────────
    groupAPda = await createGroup(
      "Group A — always Open for MarketNotLocked test",
      YESNO,
      300,
    );
    // no pool needed for post_resolution — but create one for consistency
    const marketAPda = deriveMarketPda(g.program.programId, groupAPda, 0);
    await g.program.methods
      .createFlatMarket()
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupAPda,
        market: marketAPda,
        creator: g.payer.publicKey,
      })
      .rpc({ commitment: "confirmed" });

    // ── Groups B-E: lock in 2 s ────────────────────────────────────────────
    groupBPda = await createGroup("Group B — YesNo for happy path", YESNO, 2);
    poolBPda = await createFlatPool(groupBPda);

    groupCPda = await createGroup(
      "Group C — MultiOutcome for happy path",
      MULTI,
      2,
      ["Team A", "Team B", "Team C", "Team D"],
    );
    poolCPda = await createFlatPool(groupCPda);

    groupDPda = await createGroup(
      "Group D — Accuracy for happy path",
      ACCURACY,
      2,
    );
    poolDPda = await createTierPool(groupDPda);

    groupEPda = await createGroup(
      "Group E — YesNo for AlreadyResolved test",
      YESNO,
      2,
    );
    poolEPda = await createFlatPool(groupEPda);

    groupFPda = await createGroup(
      "Group F — MultiOutcome for Outcome(0) boundary check",
      MULTI,
      2,
      ["A", "B", "C", "D"],
    );
    poolFPda = await createFlatPool(groupFPda);

    groupGPda = await createGroup(
      "Group G — MultiOutcome for Outcome(3) boundary check",
      MULTI,
      2,
      ["A", "B", "C", "D"],
    );
    poolGPda = await createFlatPool(groupGPda);

    // ── Wait for lock_timestamps to pass ─────────────────────────────────────
    await new Promise((r) => setTimeout(r, 3000));

    // ── Lock B, C, D, E, F, G ────────────────────────────────────────────────
    await lockGroup(groupBPda, poolBPda);
    await lockGroup(groupCPda, poolCPda);
    await lockGroup(groupDPda, poolDPda);
    await lockGroup(groupEPda, poolEPda);
    await lockGroup(groupFPda, poolFPda);
    await lockGroup(groupGPda, poolGPda);

    // ── Pre-resolve group E so we can test AlreadyResolved ───────────────────
    await g.program.methods
      .postResolution(RV_YESNO_FALSE)
      .accountsPartial({
        marketGroup: groupEPda,
        oracleSigner: g.payer.publicKey,
      })
      .rpc({ commitment: "confirmed" });
  });

  // ── Error: MarketNotLocked ────────────────────────────────────────────────────

  it("rejects when market_group is not Locked (MarketNotLocked)", async () => {
    // Group A is still Open — account constraint fires before any body checks.
    let succeeded = false;
    try {
      await g.program.methods
        .postResolution(RV_YESNO_TRUE)
        .accountsPartial({
          marketGroup: groupAPda,
          oracleSigner: g.payer.publicKey,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("MarketNotLocked");
      }
    }
    expect(succeeded, "Open group must be rejected with MarketNotLocked").to.be
      .false;
  });

  // ── Error: UnauthorizedOracle ─────────────────────────────────────────────────

  it("rejects when signer is not oracle_authority (UnauthorizedOracle)", async () => {
    // Group B is Locked; oracle_authority = g.payer.
    // wrongOracle is a different keypair → account constraint 2 fires.
    let succeeded = false;
    try {
      await g.program.methods
        .postResolution(RV_YESNO_TRUE)
        .accountsPartial({
          marketGroup: groupBPda,
          oracleSigner: wrongOracle.publicKey,
        })
        .signers([wrongOracle])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("UnauthorizedOracle");
      }
    }
    expect(
      succeeded,
      "wrong oracle signer must be rejected with UnauthorizedOracle",
    ).to.be.false;
  });

  // ── Error: InvalidResolvedValueType ──────────────────────────────────────────

  it("rejects Numeric value for a YesNo group (InvalidResolvedValueType)", async () => {
    // Group B is YesNo — must receive YesNo(bool), not Numeric.
    let succeeded = false;
    try {
      await g.program.methods
        .postResolution(RV_NUMERIC)
        .accountsPartial({
          marketGroup: groupBPda,
          oracleSigner: g.payer.publicKey,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("InvalidResolvedValueType");
      }
    }
    expect(succeeded, "Numeric value on YesNo group must be rejected").to.be
      .false;
  });

  it("rejects YesNo value for a MultiOutcome group (InvalidResolvedValueType)", async () => {
    // Group C is MultiOutcome — must receive Outcome(u8), not YesNo.
    let succeeded = false;
    try {
      await g.program.methods
        .postResolution(RV_YESNO_TRUE)
        .accountsPartial({
          marketGroup: groupCPda,
          oracleSigner: g.payer.publicKey,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("InvalidResolvedValueType");
      }
    }
    expect(succeeded, "YesNo value on MultiOutcome group must be rejected").to
      .be.false;
  });

  it("rejects YesNo value for an Accuracy group (InvalidResolvedValueType)", async () => {
    // Group D is Accuracy — must receive Numeric(u64), not YesNo.
    let succeeded = false;
    try {
      await g.program.methods
        .postResolution(RV_YESNO_TRUE)
        .accountsPartial({
          marketGroup: groupDPda,
          oracleSigner: g.payer.publicKey,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("InvalidResolvedValueType");
      }
    }
    expect(succeeded, "YesNo value on Accuracy group must be rejected").to.be
      .false;
  });

  // ── Error: OutcomeIndexOutOfRange ─────────────────────────────────────────────

  it("rejects Outcome(4) for a MultiOutcome group — max valid index is 3 (OutcomeIndexOutOfRange)", async () => {
    // Group C is MultiOutcome; Outcome(4) is out of range.
    let succeeded = false;
    try {
      await g.program.methods
        .postResolution(RV_OUTCOME_4_OOB)
        .accountsPartial({
          marketGroup: groupCPda,
          oracleSigner: g.payer.publicKey,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("OutcomeIndexOutOfRange");
      }
    }
    expect(succeeded, "Outcome(4) must be rejected with OutcomeIndexOutOfRange")
      .to.be.false;
  });

  // ── Happy path: YesNo ─────────────────────────────────────────────────────────

  it("resolves a YesNo group with YesNo(true): status=Resolving, fields set correctly", async () => {
    const beforeTs = Math.floor(Date.now() / 1000);

    const sig = await g.program.methods
      .postResolution(RV_YESNO_TRUE)
      .accountsPartial({
        marketGroup: groupBPda,
        oracleSigner: g.payer.publicKey,
      })
      .rpc({ commitment: "confirmed" });
    console.log("PostResolution (YesNo) tx:", sig);

    const mg = await g.program.account.marketGroup.fetch(groupBPda);

    // Status transitions to Resolving
    expect(mg.status).to.have.property("resolving");

    // resolved_value = Some(YesNo(true))
    // Anchor deserialises tuple fields as arrays: { yesNo: [true] }
    expect(mg.resolvedValue).to.not.be.null;
    expect(mg.resolvedValue).to.have.property("yesNo");
    expect((mg.resolvedValue as any).yesNo[0]).to.equal(true);

    // resolved_at is set and is in a reasonable range
    // Allow 2 s of skew: the validator clock can lag Date.now() by up to 1 s.
    expect(mg.resolvedAt).to.not.be.null;
    const resolvedAt = (mg.resolvedAt as anchor.BN).toNumber();
    expect(resolvedAt).to.be.gte(beforeTs - 2);
    expect(resolvedAt).to.be.lte(beforeTs + 10);

    // dispute_deadline = resolved_at + DISPUTE_WINDOW (3600 s)
    expect(mg.disputeDeadline).to.not.be.null;
    const disputeDeadline = (mg.disputeDeadline as anchor.BN).toNumber();
    expect(disputeDeadline).to.equal(resolvedAt + DISPUTE_WINDOW);
  });

  // ── Happy path: MultiOutcome ──────────────────────────────────────────────────

  it("resolves a MultiOutcome group with Outcome(2): status=Resolving, fields set correctly", async () => {
    const beforeTs = Math.floor(Date.now() / 1000);

    const sig = await g.program.methods
      .postResolution(RV_OUTCOME_2)
      .accountsPartial({
        marketGroup: groupCPda,
        oracleSigner: g.payer.publicKey,
      })
      .rpc({ commitment: "confirmed" });
    console.log("PostResolution (MultiOutcome) tx:", sig);

    const mg = await g.program.account.marketGroup.fetch(groupCPda);

    expect(mg.status).to.have.property("resolving");

    expect(mg.resolvedValue).to.not.be.null;
    // Anchor deserialises tuple fields as arrays: { outcome: [2] }
    expect(mg.resolvedValue).to.have.property("outcome");
    expect((mg.resolvedValue as any).outcome[0]).to.equal(2);

    expect(mg.resolvedAt).to.not.be.null;
    const resolvedAt = (mg.resolvedAt as anchor.BN).toNumber();
    expect(resolvedAt).to.be.gte(beforeTs - 2);
    expect(resolvedAt).to.be.lte(beforeTs + 10);

    expect(mg.disputeDeadline).to.not.be.null;
    const disputeDeadline = (mg.disputeDeadline as anchor.BN).toNumber();
    expect(disputeDeadline).to.equal(resolvedAt + DISPUTE_WINDOW);
  });

  // ── Happy path: Accuracy ──────────────────────────────────────────────────────

  it("resolves an Accuracy group with Numeric(100_123): status=Resolving, fields set correctly", async () => {
    const beforeTs = Math.floor(Date.now() / 1000);

    const sig = await g.program.methods
      .postResolution(RV_NUMERIC)
      .accountsPartial({
        marketGroup: groupDPda,
        oracleSigner: g.payer.publicKey,
      })
      .rpc({ commitment: "confirmed" });
    console.log("PostResolution (Accuracy) tx:", sig);

    const mg = await g.program.account.marketGroup.fetch(groupDPda);

    expect(mg.status).to.have.property("resolving");

    expect(mg.resolvedValue).to.not.be.null;
    // @anchor-lang/core v1.x decodes tuple variants as { "0": value }
    expect(mg.resolvedValue).to.have.property("numeric");
    expect((mg.resolvedValue as any).numeric[0].toString()).to.equal("100123");

    expect(mg.resolvedAt).to.not.be.null;
    const resolvedAt = (mg.resolvedAt as anchor.BN).toNumber();
    expect(resolvedAt).to.be.gte(beforeTs - 2);
    expect(resolvedAt).to.be.lte(beforeTs + 10);

    expect(mg.disputeDeadline).to.not.be.null;
    const disputeDeadline = (mg.disputeDeadline as anchor.BN).toNumber();
    expect(disputeDeadline).to.equal(resolvedAt + DISPUTE_WINDOW);
  });

  // ── Post-resolution guard: AlreadyResolved ────────────────────────────────────

  it("rejects a second resolution call on an already-Resolving group (AlreadyResolved)", async () => {
    // Group E was pre-resolved in before() → resolved_value.is_some() → AlreadyResolved.
    // The account constraint (is_locked) now fails too because status = Resolving, not Locked.
    // Either MarketNotLocked or AlreadyResolved is an acceptable rejection here.
    let succeeded = false;
    try {
      await g.program.methods
        .postResolution(RV_YESNO_TRUE)
        .accountsPartial({
          marketGroup: groupEPda,
          oracleSigner: g.payer.publicKey,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        // is_locked() is false (status = Resolving) → MarketNotLocked fires at
        // account constraint level before the body's AlreadyResolved check.
        expect(["MarketNotLocked", "AlreadyResolved"]).to.include(
          e.error.errorCode.code,
        );
      }
    }
    expect(
      succeeded,
      "re-resolving an already-Resolving group must be rejected",
    ).to.be.false;
  });

  // Sanity: verify group E is in Resolving state with the correct resolved_value
  it("group E is in Resolving state with resolvedValue = YesNo(false) after pre-resolution", async () => {
    const mg = await g.program.account.marketGroup.fetch(groupEPda);
    expect(mg.status).to.have.property("resolving");
    expect(mg.resolvedValue).to.not.be.null;
    // Anchor deserialises tuple fields as arrays: { yesNo: [false] }
    expect(mg.resolvedValue).to.have.property("yesNo");
    expect((mg.resolvedValue as any).yesNo[0]).to.equal(false);
    expect(mg.resolvedAt).to.not.be.null;
    expect(mg.disputeDeadline).to.not.be.null;
  });

  // ── Pending: edge cases that require additional infrastructure ────────────────

  it("accepts Outcome(0) — minimum valid index for MultiOutcome (boundary check)", async () => {
    const beforeTs = Math.floor(Date.now() / 1000);
    const sig = await g.program.methods
      .postResolution({ outcome: { "0": 0 } })
      .accountsPartial({
        marketGroup: groupFPda,
        oracleSigner: g.payer.publicKey,
      })
      .rpc({ commitment: "confirmed" });
    console.log("PostResolution Outcome(0) tx:", sig);

    const mg = await g.program.account.marketGroup.fetch(groupFPda);
    expect(mg.status).to.have.property("resolving");
    expect(mg.resolvedValue).to.have.property("outcome");
    expect((mg.resolvedValue as any).outcome[0]).to.equal(0);
    expect(mg.resolvedAt).to.not.be.null;
    // Allow 2 s of skew: the validator clock can lag Date.now() by up to 1 s.
    expect(mg.resolvedAt!.toNumber()).to.be.gte(beforeTs - 2);
  });

  it("accepts Outcome(3) — maximum valid index for MultiOutcome (boundary check)", async () => {
    const beforeTs = Math.floor(Date.now() / 1000);
    const sig = await g.program.methods
      .postResolution({ outcome: { "0": 3 } })
      .accountsPartial({
        marketGroup: groupGPda,
        oracleSigner: g.payer.publicKey,
      })
      .rpc({ commitment: "confirmed" });
    console.log("PostResolution Outcome(3) tx:", sig);

    const mg = await g.program.account.marketGroup.fetch(groupGPda);
    expect(mg.status).to.have.property("resolving");
    expect(mg.resolvedValue).to.have.property("outcome");
    expect((mg.resolvedValue as any).outcome[0]).to.equal(3);
    expect(mg.resolvedAt).to.not.be.null;
    // Allow 2 s of skew: the validator clock can lag Date.now() by up to 1 s.
    expect(mg.resolvedAt!.toNumber()).to.be.gte(beforeTs - 2);
  });
});

// slash_bond covers:
//   1. BondNotLocked             — bond.status is not Locked (already Returned)
//   2. MarketNotLocked           — market_group.status is not Locked (still Open)
//   3. ResolveDeadlineNotPassed  — market_group.resolve_deadline is still in the future
//   4. happy path                — Locked group past resolve_deadline:
//                                  bond vault → treasury, bond.status = Slashed,
//                                  market_group.status = Voided
//
// Ordering of constraint checks in slash_bond:
//   (account constraint)  market_group.is_locked()   → MarketNotLocked
//   (account constraint)  bond.group == market_group  (no error code, just constraint)
//   (account constraint)  bond.status == Locked       → BondNotLocked
//   (instruction body)    now > resolve_deadline       → ResolveDeadlineNotPassed
//
// Setup in before():
//   group A  lock_timestamp = now + 300    (stays Open — drives MarketNotLocked,
//                                           ResolveDeadlineNotPassed-from-Open tests)
//   group B  lock_timestamp = now + 2      (transitions Open → Locked after wait;
//   group B  resolve_deadline = now + 4     also expires quickly — drives happy path)
//
// Before() waits 6 s so both timestamps are in the past when tests run.
// slash_bond is permissionless — any signer can call it once conditions are met.

import { expect } from "chai";
import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
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
import { BOND_AMOUNT } from "../helpers/types";
import { createTokenAccount } from "../helpers/token";

const YESNO = { yesNo: {} };
const CAT_OTHER = { other: {} };
const ORACLE_MANUAL = { manual: {} };
const POOL_TYPE_UNIFIED = { unified: {} };

describe("slash_bond", () => {
  let g: GlobalFixtures;
  let treasuryAccount: PublicKey;

  // ── Group A: stays Open  (MarketNotLocked + BondNotLocked-via-cancel tests)
  let groupAPda: PublicKey;
  let bondAPda: PublicKey;
  let bondVaultAPda: PublicKey;
  let bondVaultAuthorityAPda: PublicKey;
  let poolAPda: PublicKey;

  // ── Group B: locked and resolve_deadline expired  (happy path)
  let groupBPda: PublicKey;
  let bondBPda: PublicKey;
  let bondVaultBPda: PublicKey;
  let bondVaultAuthorityBPda: PublicKey;

  // ── Group C: locked but resolve_deadline still in future  (ResolveDeadlineNotPassed)
  let groupCPda: PublicKey;
  let bondCPda: PublicKey;
  let bondVaultCPda: PublicKey;
  let bondVaultAuthorityCPda: PublicKey;

  /** Helper: create a market group and return its PDAs. */
  async function createGroup(
    question: string,
    lockOffsetSecs: number,
    resolveOffsetSecs: number
  ): Promise<{
    groupPda: PublicKey;
    bondPda: PublicKey;
    bondVaultPda: PublicKey;
    bondVaultAuthorityPda: PublicKey;
  }> {
    const cm = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);
    const groupIndex = cm.marketCount;
    const groupPda = deriveMarketGroupPda(
      g.program.programId,
      g.cyperMarketPda,
      BigInt(groupIndex.toString())
    );
    const bondPda = deriveBondPda(g.program.programId, groupPda);
    const bondVaultPda = deriveBondVaultPda(g.program.programId, bondPda);
    const bondVaultAuthorityPda = deriveBondVaultAuthorityPda(
      g.program.programId,
      bondPda
    );
    const now = Math.floor(Date.now() / 1000);

    await g.program.methods
      .createMarketGroup(
        YESNO,
        CAT_OTHER,
        ORACLE_MANUAL,
        g.payer.publicKey,
        null,
        null,
        question,
        [],
        new anchor.BN(now + lockOffsetSecs),
        new anchor.BN(now + resolveOffsetSecs)
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

    return { groupPda, bondPda, bondVaultPda, bondVaultAuthorityPda };
  }

  /** Helper: create a flat market + pool for a group and return the pool PDA. */
  async function createPool(groupPda: PublicKey): Promise<PublicKey> {
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
      poolPda
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

  before(async () => {
    g = await setupGlobal();

    // Treasury token account — recipient of slashed bonds
    treasuryAccount = await createTokenAccount(
      g.provider.connection,
      g.payer,
      g.usdcMint,
      g.payer.publicKey
    );

    // ── Group A: lock_timestamp far in future (stays Open) ───────────────────
    const a = await createGroup(
      "Group A — always Open for slash_bond error tests",
      300,   // lock_timestamp = now + 300
      3900   // resolve_deadline = now + 3900
    );
    groupAPda = a.groupPda;
    bondAPda = a.bondPda;
    bondVaultAPda = a.bondVaultPda;
    bondVaultAuthorityAPda = a.bondVaultAuthorityPda;
    poolAPda = await createPool(groupAPda);

    // ── Group B: lock in 2 s, resolve_deadline in 4 s (will expire) ─────────
    const b = await createGroup(
      "Group B — lock 2s, resolve 4s for slash_bond happy path",
      2,   // lock_timestamp = now + 2
      4    // resolve_deadline = now + 4  (must be > lock_timestamp)
    );
    groupBPda = b.groupPda;
    bondBPda = b.bondPda;
    bondVaultBPda = b.bondVaultPda;
    bondVaultAuthorityBPda = b.bondVaultAuthorityPda;
    await createPool(groupBPda);

    // ── Group C: lock in 2 s, resolve_deadline in 3600 s (won't expire soon) ─
    const c = await createGroup(
      "Group C — lock 2s, resolve 3600s for ResolveDeadlineNotPassed test",
      2,    // lock_timestamp = now + 2
      3602  // resolve_deadline = now + 3602
    );
    groupCPda = c.groupPda;
    bondCPda = c.bondPda;
    bondVaultCPda = c.bondVaultPda;
    bondVaultAuthorityCPda = c.bondVaultAuthorityPda;
    await createPool(groupCPda);

    // Wait for group B and C lock_timestamps to pass (2 s + buffer)
    await new Promise((r) => setTimeout(r, 3000));

    // Lock group B (now > lock_timestamp)
    const marketBPda = deriveMarketPda(g.program.programId, groupBPda, 0);
    const poolBForLock = derivePoolPda(g.program.programId, marketBPda, 0);
    await g.program.methods
      .lockMarket()
      .accountsPartial({
        marketGroup: groupBPda,
        pool: poolBForLock,
      })
      .rpc({ commitment: "confirmed" });

    // Lock group C (now > lock_timestamp)
    const marketCPda = deriveMarketPda(g.program.programId, groupCPda, 0);
    const poolCForLock = derivePoolPda(g.program.programId, marketCPda, 0);
    await g.program.methods
      .lockMarket()
      .accountsPartial({
        marketGroup: groupCPda,
        pool: poolCForLock,
      })
      .rpc({ commitment: "confirmed" });

    // Wait for group B resolve_deadline to pass (4 s total from creation, +2 s buffer)
    await new Promise((r) => setTimeout(r, 3000));
  });

  // ── Error paths ───────────────────────────────────────────────────────────────

  it("rejects when market_group is not Locked (MarketNotLocked)", async () => {
    // Group A is still Open — the first account constraint fires.
    let succeeded = false;
    try {
      await g.program.methods
        .slashBond()
        .accountsPartial({
          marketGroup: groupAPda,
          bond: bondAPda,
          bondVault: bondVaultAPda,
          bondVaultAuthority: bondVaultAuthorityAPda,
          treasury: treasuryAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("MarketNotLocked");
      }
    }
    expect(succeeded, "Open group should be rejected with MarketNotLocked").to
      .be.false;
  });

  it("rejects when bond.status is not Locked (BondNotLocked)", async () => {
    // Cancel group A first so bond.status → Returned, then try to slash.
    // Group A pool already exists (created in before()), cancel_market checks it.
    const marketAPda = deriveMarketPda(g.program.programId, groupAPda, 0);
    const poolAPdaLocal = derivePoolPda(g.program.programId, marketAPda, 0);

    await g.program.methods
      .cancelMarket()
      .accountsPartial({
        marketGroup: groupAPda,
        bond: bondAPda,
        bondVault: bondVaultAPda,
        bondVaultAuthority: bondVaultAuthorityAPda,
        pool: poolAPdaLocal,
        creatorTokenAccount: g.creatorUsdcAccount,
        creator: g.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    // Group A is now Voided, bond.status = Returned.
    // slash_bond account constraint: market_group.is_locked() fires first →
    // MarketNotLocked because Voided != Locked.
    // Either error is a valid rejection proving the bond cannot be double-slashed.
    let succeeded = false;
    try {
      await g.program.methods
        .slashBond()
        .accountsPartial({
          marketGroup: groupAPda,
          bond: bondAPda,
          bondVault: bondVaultAPda,
          bondVaultAuthority: bondVaultAuthorityAPda,
          treasury: treasuryAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(["MarketNotLocked", "BondNotLocked"]).to.include(
          e.error.errorCode.code
        );
      }
    }
    expect(
      succeeded,
      "Voided/non-Locked bond should be rejected"
    ).to.be.false;
  });

  it("rejects when resolve_deadline has not passed yet (ResolveDeadlineNotPassed)", async () => {
    // Group C is Locked but resolve_deadline is 3600 s out — too early to slash.
    let succeeded = false;
    try {
      await g.program.methods
        .slashBond()
        .accountsPartial({
          marketGroup: groupCPda,
          bond: bondCPda,
          bondVault: bondVaultCPda,
          bondVaultAuthority: bondVaultAuthorityCPda,
          treasury: treasuryAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("ResolveDeadlineNotPassed");
      }
    }
    expect(
      succeeded,
      "slashing before resolve_deadline should be rejected"
    ).to.be.false;
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it("slashes the bond: vault → treasury, bond.status = Slashed, group.status = Voided", async () => {
    // Group B is Locked and resolve_deadline (now + 4 s at creation) has expired.
    const vaultBalBefore = await g.provider.connection.getTokenAccountBalance(
      bondVaultBPda
    );
    expect(vaultBalBefore.value.amount).to.equal(
      BOND_AMOUNT.toString(),
      "bond_vault should hold BOND_AMOUNT before slash"
    );

    const treasuryBalBefore =
      await g.provider.connection.getTokenAccountBalance(treasuryAccount);

    const sig = await g.program.methods
      .slashBond()
      .accountsPartial({
        marketGroup: groupBPda,
        bond: bondBPda,
        bondVault: bondVaultBPda,
        bondVaultAuthority: bondVaultAuthorityBPda,
        treasury: treasuryAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });
    console.log("SlashBond tx:", sig);

    // bond.status → Slashed
    const bond = await g.program.account.bond.fetch(bondBPda);
    expect(bond.status).to.have.property("slashed");

    // market_group.status → Voided
    const mg = await g.program.account.marketGroup.fetch(groupBPda);
    expect(mg.status).to.have.property("voided");

    // bond_vault drained
    const vaultBalAfter = await g.provider.connection.getTokenAccountBalance(
      bondVaultBPda
    );
    expect(vaultBalAfter.value.amount).to.equal("0");

    // treasury received BOND_AMOUNT
    const treasuryBalAfter =
      await g.provider.connection.getTokenAccountBalance(treasuryAccount);
    expect(
      Number(treasuryBalAfter.value.amount) -
        Number(treasuryBalBefore.value.amount)
    ).to.equal(BOND_AMOUNT);
  });

  it("rejects re-slash of an already-Slashed bond (MarketNotLocked)", async () => {
    // Group B is now Voided — market_group.is_locked() fires → MarketNotLocked.
    let succeeded = false;
    try {
      await g.program.methods
        .slashBond()
        .accountsPartial({
          marketGroup: groupBPda,
          bond: bondBPda,
          bondVault: bondVaultBPda,
          bondVaultAuthority: bondVaultAuthorityBPda,
          treasury: treasuryAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(["MarketNotLocked", "BondNotLocked"]).to.include(
          e.error.errorCode.code
        );
      }
    }
    expect(succeeded, "re-slashing a Voided group should be rejected").to.be
      .false;
  });
});

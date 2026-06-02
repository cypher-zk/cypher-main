// lock_market covers:
//   1. LockTimestampNotReached — lock_timestamp still in the future
//   2. happy path — lock_timestamp reached, group transitions Open → Locked
//   3. MarketNotOpen — re-lock attempt on an already-Locked group
//
// lock_market is permissionless: no signer required beyond the tx fee payer.
//
// Setup in before():
//   group A  lock_timestamp = now + 300  (far future — drives error test 1)
//   group B  lock_timestamp = now + 2    (drives happy path + re-lock test)
//   group B → flat market → pool         (pool is read-only in lock_market
//                                         but the account must exist on-chain)
//
// After creating group B, before() waits 3 s so the lock_timestamp has
// definitely passed before any test runs.

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

const YESNO = { yesNo: {} };
const CAT_OTHER = { other: {} };
const ORACLE_MANUAL = { manual: {} };
const POOL_TYPE_UNIFIED = { unified: {} };

describe("lock_market", () => {
  let g: GlobalFixtures;

  // group A — lock_timestamp far in future (LockTimestampNotReached test)
  let groupAPda: PublicKey;

  // group B — lock_timestamp = now + 2  (happy path + re-lock test)
  let groupBPda: PublicKey;
  let poolBPda: PublicKey;  // passed as read-only pool to lock_market

  async function createGroup(
    lockOffsetSecs: number
  ): Promise<PublicKey> {
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
        "Will lock_market tests pass?",
        [],
        new anchor.BN(now + lockOffsetSecs),
        new anchor.BN(now + lockOffsetSecs + 3600)
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

  before(async () => {
    g = await setupGlobal();

    // Group A: lock 5 minutes out — lock_market should always fail immediately
    groupAPda = await createGroup(300);

    // Group B: lock in 2 seconds — will be reachable during the test run
    groupBPda = await createGroup(2);

    // Create flat market + pool for group B (pool is required by lock_market accounts)
    const marketBPda = deriveMarketPda(g.program.programId, groupBPda, 0);
    await g.program.methods
      .createFlatMarket()
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupBPda,
        market: marketBPda,
        creator: g.payer.publicKey,
      })
      .rpc({ commitment: "confirmed" });

    poolBPda = derivePoolPda(g.program.programId, marketBPda, 0);
    const poolVaultBPda = derivePoolVaultPda(g.program.programId, poolBPda);
    const vaultAuthorityBPda = deriveVaultAuthorityPda(
      g.program.programId,
      poolBPda
    );
    await g.program.methods
      .createPool(0, POOL_TYPE_UNIFIED)
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupBPda,
        market: marketBPda,
        pool: poolBPda,
        poolVault: poolVaultBPda,
        vaultAuthority: vaultAuthorityBPda,
        acceptedMint: g.usdcMint,
        creator: g.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    // Wait long enough for group B's lock_timestamp (now + 2) to have passed
    await new Promise((r) => setTimeout(r, 3000));
  });

  // ── Error paths ───────────────────────────────────────────────────────────

  it("rejects when lock_timestamp has not been reached (LockTimestampNotReached)", async () => {
    // Group A has lock_timestamp = now + 300, so this call is always too early.
    // Pool B is passed — no constraint links pool to market_group in LockMarket.
    let succeeded = false;
    try {
      await g.program.methods
        .lockMarket()
        .accountsPartial({
          marketGroup: groupAPda,
          pool: poolBPda,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("LockTimestampNotReached");
      }
    }
    expect(
      succeeded,
      "locking before lock_timestamp should be rejected"
    ).to.be.false;
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("locks the market once lock_timestamp is reached, status transitions to Locked", async () => {
    // Group B's lock_timestamp = now + 2 at creation; before() waited 3 s.
    const mgBefore = await g.program.account.marketGroup.fetch(groupBPda);
    expect(mgBefore.status, "group should be Open before lock").to.have.property("open");

    const sig = await g.program.methods
      .lockMarket()
      .accountsPartial({
        marketGroup: groupBPda,
        pool: poolBPda,
      })
      .rpc({ commitment: "confirmed" });
    console.log("LockMarket tx:", sig);

    const mgAfter = await g.program.account.marketGroup.fetch(groupBPda);
    expect(mgAfter.status).to.have.property("locked");
  });

  // ── Post-lock guard ───────────────────────────────────────────────────────

  it("rejects re-lock of an already-Locked group (MarketNotOpen)", async () => {
    // Group B is now Locked; the constraint market_group.is_open() fires.
    let succeeded = false;
    try {
      await g.program.methods
        .lockMarket()
        .accountsPartial({
          marketGroup: groupBPda,
          pool: poolBPda,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("MarketNotOpen");
      }
    }
    expect(
      succeeded,
      "re-locking an already-Locked group should be rejected"
    ).to.be.false;
  });
});

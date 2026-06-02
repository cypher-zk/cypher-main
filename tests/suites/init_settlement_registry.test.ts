// init_settlement_registry covers:
//   1. MarketNotResolving        — market_group.status is not Resolving (account constraint)
//   2. DisputeWindowActive       — market is Resolving but dispute_deadline hasn't passed
//   3. ZeroWinners               — total_shards = 0             (skipped: needs expired window)
//   4. ShardIndexOutOfRange      — total_shards != expected      (skipped: needs expired window)
//   5. happy path                                                (skipped: needs 1-hour wait)
//
// Constraint / check order in init_settlement_registry:
//   (account constraint)  market_group.is_resolving()           → MarketNotResolving
//   (instruction body)    dispute_window_ended(now)             → DisputeWindowActive
//   (instruction body)    total_shards > 0                      → ZeroWinners
//   (instruction body)    total_shards == expected_shards        → ShardIndexOutOfRange
//
// Setup in before():
//   group A  lock_timestamp = now + 300  (stays Open)          → drives MarketNotResolving
//   group B  lock_timestamp = now + 2    (YesNo, gets locked + resolved in before())
//                                                               → drives DisputeWindowActive
//                                                               (dispute_deadline = resolved_at + 3600)
//
// Before() waits 3 s so group B's lock_timestamp passes, then locks it and
// calls post_resolution. Group B is Resolving with dispute_deadline ~3600 s out.

import { expect } from "chai";
import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
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
  deriveSettlementRegistryPda,
} from "../helpers/pda";

const YESNO = { yesNo: {} };
const CAT_OTHER = { other: {} };
const ORACLE_MANUAL = { manual: {} };
const POOL_TYPE_UNIFIED = { unified: {} };
const RV_YESNO_TRUE = { yesNo: { "0": true } };

describe("init_settlement_registry", () => {
  let g: GlobalFixtures;

  // ── Group A: stays Open — MarketNotResolving test
  let groupAPda: PublicKey;
  let marketAPda: PublicKey;
  let poolAPda: PublicKey;

  // ── Group B: YesNo, locked + resolved in before() — DisputeWindowActive test
  let groupBPda: PublicKey;
  let marketBPda: PublicKey;
  let poolBPda: PublicKey;

  /** Create a market group and return its PDA. */
  async function createGroup(
    question: string,
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
        question,
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

    // ── Group A: lock far in future (stays Open) ─────────────────────────────
    groupAPda = await createGroup(
      "Group A — stays Open for MarketNotResolving test",
      300
    );
    marketAPda = deriveMarketPda(g.program.programId, groupAPda, 0);
    poolAPda = await createFlatPool(groupAPda);

    // ── Group B: lock in 2s, then lock + post_resolution ─────────────────────
    groupBPda = await createGroup(
      "Group B — YesNo, will be locked + resolved for DisputeWindowActive test",
      2
    );
    marketBPda = deriveMarketPda(g.program.programId, groupBPda, 0);
    poolBPda = await createFlatPool(groupBPda);

    // Wait for group B lock_timestamp to pass
    await new Promise((r) => setTimeout(r, 3000));

    // Lock group B
    await g.program.methods
      .lockMarket()
      .accountsPartial({ marketGroup: groupBPda, pool: poolBPda })
      .rpc({ commitment: "confirmed" });

    // Resolve group B (status → Resolving, dispute_deadline = now + 3600)
    await g.program.methods
      .postResolution(RV_YESNO_TRUE)
      .accountsPartial({
        marketGroup: groupBPda,
        oracleSigner: g.payer.publicKey,
      })
      .rpc({ commitment: "confirmed" });
  });

  // ── Error paths ──────────────────────────────────────────────────────────────

  it("rejects when market_group is not Resolving (MarketNotResolving)", async () => {
    // Group A is Open — the account constraint fires.
    const registryPda = deriveSettlementRegistryPda(
      g.program.programId,
      poolAPda
    );
    let succeeded = false;
    try {
      await g.program.methods
        .initSettlementRegistry(1)
        .accountsPartial({
          marketGroup: groupAPda,
          market: marketAPda,
          pool: poolAPda,
          settlementRegistry: registryPda,
          backend: g.payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("MarketNotResolving");
      }
    }
    expect(
      succeeded,
      "Open group should be rejected with MarketNotResolving"
    ).to.be.false;
  });

  it("rejects when dispute window is still active (DisputeWindowActive)", async () => {
    // Group B is Resolving but dispute_deadline = resolved_at + 3600 hasn't passed.
    const registryPda = deriveSettlementRegistryPda(
      g.program.programId,
      poolBPda
    );
    let succeeded = false;
    try {
      await g.program.methods
        .initSettlementRegistry(1)
        .accountsPartial({
          marketGroup: groupBPda,
          market: marketBPda,
          pool: poolBPda,
          settlementRegistry: registryPda,
          backend: g.payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("DisputeWindowActive");
      }
    }
    expect(
      succeeded,
      "Resolving group with active dispute window should be rejected"
    ).to.be.false;
  });

  // ── Skipped paths (require 1-hour dispute window to expire) ─────────────────

  it.skip("rejects total_shards = 0 (ZeroWinners) — requires expired dispute window", async () => {});

  it.skip("rejects wrong total_shards (ShardIndexOutOfRange) — requires expired dispute window", async () => {});

  it.skip("happy path — initializes registry, transitions group + pool to Settling — requires 1-hour dispute window", async () => {});
});

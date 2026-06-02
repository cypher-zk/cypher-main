// queue_settlement covers queue_settlement_yesno, queue_settlement_multioutcome,
// queue_settlement_accuracy.
//
// All three instructions call arcium_anchor::queue_computation and require the
// Arcium MXE to be deployed. The Arcium accounts (mxe_account, comp_def_account,
// cluster_account, pool_account, clock_account) are loaded and deserialized BEFORE
// the program's own require! checks run — so InvalidResolvedValueType, MarketNotSettling,
// ShardIndexOutOfRange, and OutcomeIndexOutOfRange are not reachable on localnet.
//
// All tests here are skipped until Arcium is available (devnet / mainnet).
//
// Error paths per instruction (all need Arcium to reach):
//   queue_settlement_yesno:
//     - InvalidResolvedValueType  — pass a MultiOutcome or Accuracy group
//     - MarketNotSettling         — pool.status != Settling
//     - ShardIndexOutOfRange      — shard_index >= total_shards
//   queue_settlement_multioutcome:
//     - InvalidResolvedValueType  — pass a YesNo or Accuracy group
//     - MarketNotSettling
//     - ShardIndexOutOfRange
//     - OutcomeIndexOutOfRange    — resolved_outcome >= 4
//   queue_settlement_accuracy:
//     - InvalidResolvedValueType  — pass a YesNo or MultiOutcome group
//     - MarketNotSettling
//     - ShardIndexOutOfRange

import * as anchor from "@anchor-lang/core";
import { setupGlobal, GlobalFixtures } from "../fixtures/global";
import { buildComputationAccounts } from "../helpers/arcium";

describe("queue_settlement", () => {
  let g: GlobalFixtures;

  before(async () => {
    g = await setupGlobal();
  });

  // ── queue_settlement_yesno ────────────────────────────────────────────────────

  it.skip("rejects wrong market type for yesno (InvalidResolvedValueType) — requires Arcium", async () => {
    // Setup: MultiOutcome group in Settling status + registry.
    // Expect: InvalidResolvedValueType.
  });

  it.skip("rejects when pool is not Settling (MarketNotSettling) for yesno — requires Arcium", async () => {
    // Setup: YesNo group whose pool.status == Open (never transitioned to Settling).
    // Expect: MarketNotSettling.
  });

  it.skip("rejects shard_index >= total_shards (ShardIndexOutOfRange) for yesno — requires Arcium", async () => {
    // Setup: YesNo group in Settling with total_shards = 1, pass shard_index = 1.
    // Expect: ShardIndexOutOfRange.
  });

  it.skip("queues a yesno settlement shard (happy path) — requires Arcium", async () => {
    // Setup: YesNo group in Settling, comp_def initialized, registry InProgress.
    // Call: queueSettlementYesno with valid encrypted_positions and shard_index.
    // Verify: computation account created on-chain.
  });

  // ── queue_settlement_multioutcome ─────────────────────────────────────────────

  it.skip("rejects wrong market type for multioutcome (InvalidResolvedValueType) — requires Arcium", async () => {});

  it.skip("rejects resolved_outcome >= 4 (OutcomeIndexOutOfRange) — requires Arcium", async () => {
    // Setup: MultiOutcome group in Settling.
    // Pass resolved_outcome = 4.
    // Expect: OutcomeIndexOutOfRange.
  });

  it.skip("rejects when pool is not Settling (MarketNotSettling) for multioutcome — requires Arcium", async () => {});

  it.skip("queues a multioutcome settlement shard (happy path) — requires Arcium", async () => {});

  // ── queue_settlement_accuracy ─────────────────────────────────────────────────

  it.skip("rejects wrong market type for accuracy (InvalidResolvedValueType) — requires Arcium", async () => {});

  it.skip("rejects when pool is not Settling (MarketNotSettling) for accuracy — requires Arcium", async () => {});

  it.skip("rejects shard_index >= total_shards (ShardIndexOutOfRange) for accuracy — requires Arcium", async () => {});

  it.skip("queues an accuracy settlement shard (happy path) — requires Arcium", async () => {});
});

// settle_callback covers settle_yesno_callback, settle_multioutcome_callback,
// settle_accuracy_callback.
//
// These are Arcium callback instructions — they are invoked by the Arcium network
// after a computation completes, NOT called directly by a client. The instruction
// body calls validate_callback_ixs() which checks that the calling instruction is
// the Arcium program, so direct invocation is always rejected.
//
// Testing requires:
//   1. Arcium MXE deployed
//   2. comp_defs initialized
//   3. settlement_registry in InProgress status
//   4. A computation queued via queue_settlement_*
//   5. The Arcium network to execute the MPC computation and invoke the callback
//
// All tests are skipped until the full Arcium pipeline is available.
//
// What each callback does (for verification once unskipped):
//   - increments settlement_registry.settled_shards by 1
//   - emits ShardSettled event with the winner_mask
//   - if all shards done: sets registry.status = Finalizing, pool.status = Settled,
//     emits RegistryFinalized
//
// Accuracy callback additionally: stores errors array (u64 × 4) instead of winner_mask.

import { setupGlobal, GlobalFixtures } from "../fixtures/global";

describe("settle_callback", () => {
  let g: GlobalFixtures;

  before(async () => {
    g = await setupGlobal();
  });

  // ── settle_yesno_callback ─────────────────────────────────────────────────────

  it.skip("settle_yesno_callback: increments settled_shards, emits ShardSettled — requires Arcium", async () => {
    // Prerequisites: registry InProgress, queue_settlement_yesno queued.
    // Verify:
    //   - registry.settled_shards += 1
    //   - ShardSettled event emitted with correct winner_mask ([u8; 8])
  });

  it.skip("settle_yesno_callback: last shard sets registry Finalizing + pool Settled, emits RegistryFinalized — requires Arcium", async () => {
    // Prerequisites: registry with settled_shards == total_shards - 1.
    // Verify:
    //   - registry.status == Finalizing
    //   - pool.status == Settled
    //   - RegistryFinalized event emitted
  });

  // ── settle_multioutcome_callback ──────────────────────────────────────────────

  it.skip("settle_multioutcome_callback: increments settled_shards, emits ShardSettled — requires Arcium", async () => {});

  it.skip("settle_multioutcome_callback: last shard finalizes registry — requires Arcium", async () => {});

  // ── settle_accuracy_callback ──────────────────────────────────────────────────

  it.skip("settle_accuracy_callback: increments settled_shards, stores errors array, emits ShardSettled — requires Arcium", async () => {
    // Verify winner_mask in event is the errors ([u64; 4]) serialized as 32 bytes.
  });

  it.skip("settle_accuracy_callback: last shard finalizes registry — requires Arcium", async () => {});
});

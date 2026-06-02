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
//   - emits ShardSettled event with encryption_key ([u8;32]), nonce (u128),
//     ciphertext ([u8;32]) — the Arcium-encrypted output that the backend
//     decrypts client-side to recover the winner mask / errors
//   - if all shards done: sets registry.status = Finalizing, pool.status = Settled,
//     emits RegistryFinalized

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
    //   - ShardSettled event emitted with encryption_key, nonce, ciphertext
    //     (decrypt ciphertext client-side to recover winner_mask [u8; 8])
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

  it.skip("settle_accuracy_callback: increments settled_shards, emits ShardSettled — requires Arcium", async () => {
    // Verify ShardSettled event has encryption_key, nonce, ciphertext.
    // Decrypt ciphertext client-side to recover errors ([u64; 4]).
  });

  it.skip("settle_accuracy_callback: last shard finalizes registry — requires Arcium", async () => {});
});

// write_position_payout covers the WritePositionPayout instruction.
//
// This instruction is invoked post-settlement (by the backend) for each
// position to record the computed payout and advance the position to Settled.
//
// Account constraints (fire before body):
//   settlement_registry.status in {Finalizing, Complete} → RegistryNotFinalizing
//   position.pool == settlement_registry.pool
//   position.status == Open                              → PayoutAlreadyWritten
//
// Body checks:
//   settlement_registry.status in {Finalizing, Complete} → RegistryNotFinalizing
//   position.status == Open                              → PayoutAlreadyWritten
//
// Effect:
//   - position.payout = payout (instruction arg)
//   - position.status = Settled
//   - emits PayoutWritten { position, user, pool, payout, written_at }
//
// All tests are skipped — RegistryStatus::Finalizing/Complete is only reachable
// after all settle_*_callback shards complete via the Arcium MPC pipeline.
//
// NOTE: Once these tests are unskipped, the ZeroPayout and happy-path tests in
//       claim_payout.test.ts should also be unskipped — they depend on this
//       instruction having run first.

import { setupGlobal, GlobalFixtures } from "../fixtures/global";

describe("write_position_payout", () => {
  let g: GlobalFixtures;

  before(async () => {
    g = await setupGlobal();
  });

  it.skip("rejects when settlement_registry is not Finalizing or Complete (RegistryNotFinalizing) — requires Arcium", async () => {
    // Prerequisites: a settlement_registry in InProgress status.
    // Blocked: init_settlement_registry requires a 1-hour dispute window that
    //          cannot elapse on localnet; an InProgress registry fails the
    //          account constraint immediately with RegistryNotFinalizing.
    // Verify: AnchorError with code RegistryNotFinalizing.
  });

  it.skip("rejects when position is already Settled (PayoutAlreadyWritten) — requires Arcium", async () => {
    // Prerequisites: settlement_registry in Finalizing, position already Settled
    //                (write_position_payout called once before this call).
    // Blocked: Finalizing status requires Arcium.
    // Setup: call write_position_payout once (succeeds), then call again for
    //        same position.
    // Verify: second call → AnchorError with code PayoutAlreadyWritten.
  });

  it.skip("happy path: writes payout, transitions position to Settled, emits PayoutWritten — requires Arcium", async () => {
    // Prerequisites: settlement_registry in Finalizing/Complete, position Open.
    // Blocked: Finalizing status requires Arcium.
    // Verify:
    //   - position.payout == payout arg
    //   - position.status == Settled
    //   - PayoutWritten event emitted with correct position, user, pool, payout
    //
    // After unskipping, also unskip in claim_payout.test.ts:
    //   - "rejects when position.payout == 0 after settlement (ZeroPayout)"
    //   - "happy path: transfers payout, position.status transitions to Claimed"
  });
});

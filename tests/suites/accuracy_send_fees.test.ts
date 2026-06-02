// accuracy_send_fees covers the AccuracySendFees instruction.
//
// This instruction is invoked post-settlement (by the backend) to transfer
// the Arcium accuracy platform fee from the pool vault to the treasury.
//
// Account constraint (fires before body):
//   settlement_registry.status == Finalizing → RegistryNotFinalizing
//
// Body checks:
//   settlement_registry.status == Finalizing   → RegistryNotFinalizing
//   market_group.market_type == Accuracy        → InvalidResolvedValueType
//
// Transfer logic:
//   platform_fee = loser_count × bet_size × accuracy_platform_fee_bps / 10_000
//   if platform_fee == 0: returns Ok(()) without a transfer
//   otherwise: pool_vault → treasury
//
// All tests are skipped — reaching RegistryStatus::Finalizing requires every
// settle_accuracy_callback shard to complete, which requires the full Arcium
// MPC pipeline.

import { setupGlobal, GlobalFixtures } from "../fixtures/global";

describe("accuracy_send_fees", () => {
  let g: GlobalFixtures;

  before(async () => {
    g = await setupGlobal();
  });

  it.skip("rejects when settlement_registry is not Finalizing (RegistryNotFinalizing) — requires Arcium", async () => {
    // Prerequisites: settlement_registry in InProgress status.
    // Blocked: init_settlement_registry requires a 1-hour dispute window
    //          that cannot elapse on localnet; an InProgress registry passed
    //          to this instruction fails the account constraint immediately.
    // Verify: AnchorError with code RegistryNotFinalizing.
  });

  it.skip("rejects when market_group is not Accuracy type (InvalidResolvedValueType) — requires Arcium", async () => {
    // Prerequisites: settlement_registry in Finalizing status for a YesNo or
    //                MultiOutcome pool.
    // Blocked: Finalizing status requires settle_*_callback via Arcium.
    // Verify: AnchorError with code InvalidResolvedValueType.
  });

  it.skip("returns Ok without transfer when loser_count == 0 — requires Arcium", async () => {
    // Prerequisites: Accuracy pool, settlement_registry in Finalizing, loser_count=0.
    // Blocked: Finalizing status requires Arcium.
    // Verify: pool_vault balance unchanged, treasury balance unchanged, no error.
  });

  it.skip("returns Ok without transfer when accuracy_platform_fee_bps == 0 — requires Arcium", async () => {
    // Prerequisites: initialized with accuracy_platform_fee_bps=0, Finalizing registry.
    // Blocked: Finalizing status requires Arcium.
    // Verify: pool_vault balance unchanged, treasury balance unchanged, no error.
  });

  it.skip("happy path: transfers correct platform fee from pool_vault to treasury — requires Arcium", async () => {
    // Prerequisites: Accuracy pool in Finalizing, loser_count > 0, fee_bps > 0.
    // Blocked: Finalizing status requires Arcium.
    // Verify:
    //   - treasury balance increased by loser_count × bet_size × accuracy_platform_fee_bps / 10_000
    //   - pool_vault balance decreased by the same amount
  });
});

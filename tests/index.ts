// Single entry point — Mocha's Node module cache prevents double-registration
// when the glob in Anchor.toml also picks up the suite files directly.
// To use this as the sole entry point instead, update Anchor.toml:
//   test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/index.ts"

import "./suites/initialize.test";
import "./suites/create_market_group.test";
import "./suites/create_flat_market.test";
import "./suites/create_tier_market.test";
import "./suites/create_pool.test";
import "./suites/cancel_market.test";
import "./suites/place_bet.test";
import "./suites/place_bet_accuracy.test";
import "./suites/lock_market.test";
import "./suites/post_resolution.test";
import "./suites/claim_payout.test";
import "./suites/return_bond.test";
import "./suites/slash_bond.test";
import "./suites/comp_defs.test";
import "./suites/init_settlement_registry.test";
import "./suites/queue_settlement.test";
import "./suites/settle_callback.test";
import "./suites/accuracy_send_fees.test";
import "./suites/write_position_payout.test";

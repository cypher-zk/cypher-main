// comp_defs covers init_yesno_comp_def, init_multioutcome_comp_def, init_accuracy_comp_def.
//
// All three instructions call arcium_anchor::init_computation_def and require the
// Arcium MXE to be deployed — there are no program-level authorization checks that
// can be exercised without Arcium. All tests here are therefore skipped on localnet.
//
// Run these manually against devnet once the MXE is live:
//   anchor test --skip-build --provider.cluster devnet

import { expect } from "chai";
import * as anchor from "@anchor-lang/core";
import { setupGlobal, GlobalFixtures } from "../fixtures/global";
import { initCompDef } from "../helpers/arcium";

describe("comp_defs", () => {
  let g: GlobalFixtures;

  before(async () => {
    g = await setupGlobal();
  });

  it.skip("initializes the settle_yesno computation definition (requires Arcium MXE)", async () => {
    const { compDefPDA, sig } = await initCompDef(
      g.provider,
      g.program,
      g.arciumProgram,
      g.payer,
      "settle_yesno"
    );
    console.log("InitYesnoCompDef tx:", sig);
    expect(compDefPDA).to.be.instanceOf(anchor.web3.PublicKey);
  });

  it.skip("initializes the settle_multioutcome computation definition (requires Arcium MXE)", async () => {
    const { compDefPDA, sig } = await initCompDef(
      g.provider,
      g.program,
      g.arciumProgram,
      g.payer,
      "settle_multioutcome"
    );
    console.log("InitMultioutcomeCompDef tx:", sig);
    expect(compDefPDA).to.be.instanceOf(anchor.web3.PublicKey);
  });

  it.skip("initializes the settle_accuracy computation definition (requires Arcium MXE)", async () => {
    const { compDefPDA, sig } = await initCompDef(
      g.provider,
      g.program,
      g.arciumProgram,
      g.payer,
      "settle_accuracy"
    );
    console.log("InitAccuracyCompDef tx:", sig);
    expect(compDefPDA).to.be.instanceOf(anchor.web3.PublicKey);
  });
});

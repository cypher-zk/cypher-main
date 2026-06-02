// cancel_market covers:
//   1. UnauthorizedAuthority — non-creator tries to cancel
//   2. happy path — Open group with 0 participants:
//        bond_vault drained, bond.status = Returned, market_group.status = Voided
//   3. MarketNotOpen — re-cancel attempt after group is already Voided
//
// Ordering matters: (1) must run before (2) because (1) must find the group
// in Open status. (3) must run after (2) because it depends on Voided state.
//
// Setup in before(): group → flat market → pool (pool_index=0).
// The pool is required by the instruction to prove no bets were placed.

import { expect } from "chai";
import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
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

const YESNO = { yesNo: {} };
const CAT_OTHER = { other: {} };
const ORACLE_MANUAL = { manual: {} };
const POOL_TYPE_UNIFIED = { unified: {} };

describe("cancel_market", () => {
  let g: GlobalFixtures;
  let creator: Keypair;
  let creatorTokenAccount: PublicKey;

  // Derived in before() — shared across all tests in this suite
  let groupPda: PublicKey;
  let bondPda: PublicKey;
  let bondVaultPda: PublicKey;
  let bondVaultAuthorityPda: PublicKey;
  let poolPda: PublicKey;

  before(async () => {
    g = await setupGlobal();
    creator = g.payer;
    creatorTokenAccount = g.creatorUsdcAccount;

    // ── Create market group ──────────────────────────────────────────────────
    const cm = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);
    const groupIndex = cm.marketCount;
    groupPda = deriveMarketGroupPda(
      g.program.programId,
      g.cyperMarketPda,
      BigInt(groupIndex.toString())
    );
    bondPda = deriveBondPda(g.program.programId, groupPda);
    bondVaultPda = deriveBondVaultPda(g.program.programId, bondPda);
    bondVaultAuthorityPda = deriveBondVaultAuthorityPda(
      g.program.programId,
      bondPda
    );
    const now = Math.floor(Date.now() / 1000);

    await g.program.methods
      .createMarketGroup(
        YESNO,
        CAT_OTHER,
        ORACLE_MANUAL,
        creator.publicKey,
        null,
        null,
        "Will this cancel test pass?",
        [],
        new anchor.BN(now + 300),
        new anchor.BN(now + 3900)
      )
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupPda,
        bond: bondPda,
        bondVault: bondVaultPda,
        bondVaultAuthority: bondVaultAuthorityPda,
        creatorTokenAccount,
        acceptedMint: g.usdcMint,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    // ── Create flat market ───────────────────────────────────────────────────
    const marketPda = deriveMarketPda(g.program.programId, groupPda, 0);
    await g.program.methods
      .createFlatMarket()
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupPda,
        market: marketPda,
        creator: creator.publicKey,
      })
      .rpc({ commitment: "confirmed" });

    // ── Create pool — required by cancel_market to verify 0 participants ─────
    poolPda = derivePoolPda(g.program.programId, marketPda, 0);
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
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });
  });

  // ── Error paths (run before happy path — group must still be Open) ─────────

  it("rejects when caller is not the market group creator (UnauthorizedAuthority)", async () => {
    const nonCreator = Keypair.generate();
    const airdropSig = await g.provider.connection.requestAirdrop(
      nonCreator.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await g.provider.connection.confirmTransaction(
      {
        signature: airdropSig,
        ...(await g.provider.connection.getLatestBlockhash()),
      },
      "confirmed"
    );

    let succeeded = false;
    try {
      await g.program.methods
        .cancelMarket()
        .accountsPartial({
          marketGroup: groupPda,
          bond: bondPda,
          bondVault: bondVaultPda,
          bondVaultAuthority: bondVaultAuthorityPda,
          pool: poolPda,
          creatorTokenAccount,  // constraint on creator_token_account fires after market_group
          creator: nonCreator.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([nonCreator])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("UnauthorizedAuthority");
      }
    }
    expect(succeeded, "non-creator should be rejected").to.be.false;
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("cancels an open market with no participants, returns bond, voids group", async () => {
    const creatorBalBefore = await g.provider.connection.getTokenAccountBalance(
      creatorTokenAccount
    );
    const vaultBalBefore = await g.provider.connection.getTokenAccountBalance(
      bondVaultPda
    );
    expect(vaultBalBefore.value.amount).to.equal(
      BOND_AMOUNT.toString(),
      "bond vault should hold BOND_AMOUNT before cancel"
    );

    const sig = await g.program.methods
      .cancelMarket()
      .accountsPartial({
        marketGroup: groupPda,
        bond: bondPda,
        bondVault: bondVaultPda,
        bondVaultAuthority: bondVaultAuthorityPda,
        pool: poolPda,
        creatorTokenAccount,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });
    console.log("CancelMarket tx:", sig);

    // Group status → Voided
    const mg = await g.program.account.marketGroup.fetch(groupPda);
    expect(mg.status).to.have.property("voided");

    // Bond status → Returned
    const bond = await g.program.account.bond.fetch(bondPda);
    expect(bond.status).to.have.property("returned");

    // Bond vault drained
    const vaultBalAfter = await g.provider.connection.getTokenAccountBalance(
      bondVaultPda
    );
    expect(vaultBalAfter.value.amount).to.equal("0");

    // Creator received BOND_AMOUNT back
    const creatorBalAfter = await g.provider.connection.getTokenAccountBalance(
      creatorTokenAccount
    );
    expect(
      Number(creatorBalAfter.value.amount) -
        Number(creatorBalBefore.value.amount)
    ).to.equal(BOND_AMOUNT);
  });

  // ── Post-cancel guard ─────────────────────────────────────────────────────

  it("rejects re-cancel of an already-voided group (MarketNotOpen)", async () => {
    let succeeded = false;
    try {
      await g.program.methods
        .cancelMarket()
        .accountsPartial({
          marketGroup: groupPda,
          bond: bondPda,
          bondVault: bondVaultPda,
          bondVaultAuthority: bondVaultAuthorityPda,
          pool: poolPda,
          creatorTokenAccount,
          creator: creator.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
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
      "cancel of a Voided group should be rejected with MarketNotOpen"
    ).to.be.false;
  });
});

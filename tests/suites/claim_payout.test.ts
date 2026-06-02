// claim_payout covers:
//   1. PositionNotSettled — position.status == Open (directly after place_bet)
//   2. UnauthorizedClaim  — signer is not position.user
//
// Pending (require write_position_payout, which is not yet implemented):
//   3. ZeroPayout        — position.status == Settled but payout == 0
//   4. happy path        — position.status == Settled, payout > 0:
//                          vault drained by payout, position.status → Claimed
//
// Why the happy path cannot be tested yet:
//   claim_payout's constraints evaluate in field order:
//     (a) position.user == user.key()       → UnauthorizedClaim
//     (b) position.status == Settled        → PositionNotSettled
//     (c) position.payout > 0              → ZeroPayout
//   place_bet always produces status=Open, payout=0.  The only instruction
//   that transitions a position to Settled is write_position_payout (not yet
//   in the program), so constraints (b) and (c) can never be satisfied today.
//
// Setup in before():
//   group → flat market → pool → place_bet (user1)
//   user2 funded for the UnauthorizedClaim test

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
  derivePositionPda,
} from "../helpers/pda";
import { createFundedUsers, FundedUser } from "../helpers/funded-users";

const YESNO = { yesNo: {} };
const CAT_OTHER = { other: {} };
const ORACLE_MANUAL = { manual: {} };
const POOL_TYPE_UNIFIED = { unified: {} };

const BET_STAKE = 2_000_000; // 2 USDC
const DUMMY_PAYLOAD = [1, 2, 3, 4];
const USER_USDC = 10_000_000; // 10 USDC each

describe("claim_payout", () => {
  let g: GlobalFixtures;

  let poolPda: PublicKey;
  let poolVaultPda: PublicKey;
  let vaultAuthorityPda: PublicKey;
  let groupPda: PublicKey;
  let marketPda: PublicKey;

  // user1 places the bet (owns the position)
  // user2 is the impostor for the UnauthorizedClaim test
  let user1: FundedUser;
  let user2: FundedUser;

  // Position PDA created by place_bet — used by both error tests
  let user1PositionPda: PublicKey;

  before(async () => {
    g = await setupGlobal();

    // ── Create group → flat market → pool ────────────────────────────────────
    const cm = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);
    const groupIndex = cm.marketCount;
    groupPda = deriveMarketGroupPda(
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
        "Will claim_payout tests pass?",
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
        creatorTokenAccount: g.creatorUsdcAccount,
        acceptedMint: g.usdcMint,
        creator: g.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    marketPda = deriveMarketPda(g.program.programId, groupPda, 0);
    await g.program.methods
      .createFlatMarket()
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupPda,
        market: marketPda,
        creator: g.payer.publicKey,
      })
      .rpc({ commitment: "confirmed" });

    poolPda = derivePoolPda(g.program.programId, marketPda, 0);
    poolVaultPda = derivePoolVaultPda(g.program.programId, poolPda);
    vaultAuthorityPda = deriveVaultAuthorityPda(g.program.programId, poolPda);
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

    // ── Fund users ─────────────────────────────────────────────────────────
    [user1, user2] = await createFundedUsers(
      g.provider,
      g.payer,
      g.usdcMint,
      2,
      USER_USDC
    );

    // ── user1 places bet — produces an Open position ────────────────────────
    user1PositionPda = derivePositionPda(
      g.program.programId,
      poolPda,
      user1.keypair.publicKey
    );
    await g.program.methods
      .placeBet(Buffer.from(DUMMY_PAYLOAD), new anchor.BN(BET_STAKE))
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupPda,
        market: marketPda,
        pool: poolPda,
        poolVault: poolVaultPda,
        position: user1PositionPda,
        userTokenAccount: user1.usdcAccount,
        user: user1.keypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user1.keypair])
      .rpc({ commitment: "confirmed" });
  });

  // ── Error paths ───────────────────────────────────────────────────────────

  it("rejects when position.status is Open, not Settled (PositionNotSettled)", async () => {
    // Constraint order: user check (passes) → status check (fails → PositionNotSettled)
    let succeeded = false;
    try {
      await g.program.methods
        .claimPayout()
        .accountsPartial({
          position: user1PositionPda,
          pool: poolPda,
          poolVault: poolVaultPda,
          vaultAuthority: vaultAuthorityPda,
          userTokenAccount: user1.usdcAccount,
          user: user1.keypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1.keypair])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("PositionNotSettled");
      }
    }
    expect(succeeded, "claiming an Open position should be rejected").to.be
      .false;
  });

  it("rejects when signer is not the position owner (UnauthorizedClaim)", async () => {
    // user2 tries to claim user1's position.
    // Constraint 1: position.user (user1) == user.key() (user2) → FALSE → UnauthorizedClaim.
    // This fires before the status check so the Open position is fine here.
    let succeeded = false;
    try {
      await g.program.methods
        .claimPayout()
        .accountsPartial({
          position: user1PositionPda,   // belongs to user1
          pool: poolPda,
          poolVault: poolVaultPda,
          vaultAuthority: vaultAuthorityPda,
          userTokenAccount: user2.usdcAccount, // owned by user2 — constraint matches user
          user: user2.keypair.publicKey,        // signing as user2
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user2.keypair])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("UnauthorizedClaim");
      }
    }
    expect(succeeded, "non-owner should be rejected").to.be.false;
  });

  // ── Pending: require write_position_payout ────────────────────────────────
  // These tests are skipped until the settlement pipeline is implemented.
  // When write_position_payout is added, un-skip and fill in the on-chain
  // setup calls.

  it.skip("rejects when position.payout == 0 after settlement (ZeroPayout)", () => {
    // Requires: write_position_payout called with payout=0 (loser position).
    // Setup: settle pool → write_position_payout(position, 0)
    // Expect: ZeroPayout when user calls claimPayout.
  });

  it.skip("happy path: transfers payout, position.status transitions to Claimed", () => {
    // Requires: write_position_payout called with payout > 0 (winner position).
    // Verify:
    //   - position.status = Claimed
    //   - pool_vault balance decreased by payout
    //   - user_token_account balance increased by payout
  });
});

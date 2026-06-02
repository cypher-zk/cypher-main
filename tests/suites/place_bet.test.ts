// place_bet covers:
//   1. StakeTooLow — stake_amount < MIN_STAKE (1_000_000)
//   2. EmptyEncryptedPayload — zero-length payload
//   3. PayloadTooLarge — payload > 128 bytes
//   4. happy path: first user places bet — full position + pool + market state verified
//   5. happy path: second user places bet — pool/market counters accumulate correctly
//
// Error paths (1-3) all use errorUser whose position PDA is never actually
// persisted: each failing tx is atomic and Solana rolls back the position
// init CPI along with everything else.  errorUser's position PDA remains
// free for all three tests.
//
// Setup in before():
//   group → flat market → pool (pool_index=0)
//   three funded users: errorUser (error paths), user1 + user2 (happy paths)

import { expect } from "chai";
import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
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
import { MIN_STAKE } from "../helpers/types";

const YESNO = { yesNo: {} };
const CAT_OTHER = { other: {} };
const ORACLE_MANUAL = { manual: {} };
const POOL_TYPE_UNIFIED = { unified: {} };

const MAX_PAYLOAD_SIZE = 128; // mirrors lib.rs MAX_PAYLOAD_SIZE
const USER_USDC = 10_000_000; // 10 USDC per user — enough for multiple bets
const BET_STAKE = 2_000_000;  // 2 USDC — safely above MIN_STAKE
const DUMMY_PAYLOAD = [1, 2, 3, 4]; // minimal non-empty payload for happy paths

describe("place_bet", () => {
  let g: GlobalFixtures;

  // Market infrastructure (created once in before())
  let groupPda: PublicKey;
  let marketPda: PublicKey;
  let poolPda: PublicKey;
  let poolVaultPda: PublicKey;

  // Three independent users so error paths never pollute happy-path PDAs
  let errorUser: FundedUser;
  let user1: FundedUser;
  let user2: FundedUser;

  before(async () => {
    g = await setupGlobal();
    const creator = g.payer;

    // ── Create market group ──────────────────────────────────────────────────
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
        creator.publicKey,
        null,
        null,
        "Will place_bet tests pass?",
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
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    // ── Create flat market ───────────────────────────────────────────────────
    marketPda = deriveMarketPda(g.program.programId, groupPda, 0);
    await g.program.methods
      .createFlatMarket()
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupPda,
        market: marketPda,
        creator: creator.publicKey,
      })
      .rpc({ commitment: "confirmed" });

    // ── Create pool ──────────────────────────────────────────────────────────
    poolPda = derivePoolPda(g.program.programId, marketPda, 0);
    poolVaultPda = derivePoolVaultPda(g.program.programId, poolPda);
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

    // ── Fund three independent users with SOL + USDC ─────────────────────────
    [errorUser, user1, user2] = await createFundedUsers(
      g.provider,
      g.payer,
      g.usdcMint,
      3,
      USER_USDC
    );
  });

  // ── Validation error paths ────────────────────────────────────────────────
  // All use errorUser — each failing tx is atomic so the position PDA stays
  // free between tests.

  it("rejects when stake_amount < MIN_STAKE (StakeTooLow)", async () => {
    const positionPda = derivePositionPda(
      g.program.programId,
      poolPda,
      errorUser.keypair.publicKey
    );

    let succeeded = false;
    try {
      await g.program.methods
        .placeBet(Buffer.from(DUMMY_PAYLOAD), new anchor.BN(MIN_STAKE - 1))
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: groupPda,
          market: marketPda,
          pool: poolPda,
          poolVault: poolVaultPda,
          position: positionPda,
          userTokenAccount: errorUser.usdcAccount,
          user: errorUser.keypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([errorUser.keypair])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("StakeTooLow");
      }
    }
    expect(succeeded, "stake below MIN_STAKE should be rejected").to.be.false;
  });

  it("rejects when encrypted_payload is empty (EmptyEncryptedPayload)", async () => {
    const positionPda = derivePositionPda(
      g.program.programId,
      poolPda,
      errorUser.keypair.publicKey
    );

    let succeeded = false;
    try {
      await g.program.methods
        .placeBet(Buffer.from([]), new anchor.BN(BET_STAKE))
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: groupPda,
          market: marketPda,
          pool: poolPda,
          poolVault: poolVaultPda,
          position: positionPda,
          userTokenAccount: errorUser.usdcAccount,
          user: errorUser.keypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([errorUser.keypair])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("EmptyEncryptedPayload");
      }
    }
    expect(succeeded, "empty payload should be rejected").to.be.false;
  });

  it("rejects when encrypted_payload exceeds 128 bytes (PayloadTooLarge)", async () => {
    const positionPda = derivePositionPda(
      g.program.programId,
      poolPda,
      errorUser.keypair.publicKey
    );
    const oversizedPayload = Buffer.alloc(MAX_PAYLOAD_SIZE + 1, 0xab);

    let succeeded = false;
    try {
      await g.program.methods
        .placeBet(oversizedPayload, new anchor.BN(BET_STAKE))
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: groupPda,
          market: marketPda,
          pool: poolPda,
          poolVault: poolVaultPda,
          position: positionPda,
          userTokenAccount: errorUser.usdcAccount,
          user: errorUser.keypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([errorUser.keypair])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("PayloadTooLarge");
      }
    }
    expect(succeeded, "payload > 128 bytes should be rejected").to.be.false;
  });

  // ── Happy paths ───────────────────────────────────────────────────────────

  it("places a bet and stores correct position, pool, and market state", async () => {
    const positionPda = derivePositionPda(
      g.program.programId,
      poolPda,
      user1.keypair.publicKey
    );

    const userBalBefore = await g.provider.connection.getTokenAccountBalance(
      user1.usdcAccount
    );
    const vaultBalBefore = await g.provider.connection.getTokenAccountBalance(
      poolVaultPda
    );

    const sig = await g.program.methods
      .placeBet(Buffer.from(DUMMY_PAYLOAD), new anchor.BN(BET_STAKE))
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupPda,
        market: marketPda,
        pool: poolPda,
        poolVault: poolVaultPda,
        position: positionPda,
        userTokenAccount: user1.usdcAccount,
        user: user1.keypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user1.keypair])
      .rpc({ commitment: "confirmed" });
    console.log("PlaceBet (user1) tx:", sig);

    // Position state
    const pos = await g.program.account.position.fetch(positionPda);
    expect(pos.pool.toBase58()).to.equal(poolPda.toBase58());
    expect(pos.market.toBase58()).to.equal(marketPda.toBase58());
    expect(pos.group.toBase58()).to.equal(groupPda.toBase58());
    expect(pos.user.toBase58()).to.equal(user1.keypair.publicKey.toBase58());
    expect(Array.from(pos.encryptedPayload)).to.deep.equal(DUMMY_PAYLOAD);
    expect(pos.stake.toNumber()).to.equal(BET_STAKE);
    expect(pos.payout.toNumber()).to.equal(0);
    expect(pos.status).to.have.property("open");

    // Pool counters
    const pool = await g.program.account.pool.fetch(poolPda);
    expect(pool.participantCount.toNumber()).to.equal(1);
    expect(pool.totalStaked.toNumber()).to.equal(BET_STAKE);

    // Market counters
    const market = await g.program.account.market.fetch(marketPda);
    expect(market.totalParticipants.toNumber()).to.equal(1);
    expect(market.totalVolume.toNumber()).to.equal(BET_STAKE);

    // Vault received the stake
    const vaultBalAfter = await g.provider.connection.getTokenAccountBalance(
      poolVaultPda
    );
    expect(
      Number(vaultBalAfter.value.amount) - Number(vaultBalBefore.value.amount)
    ).to.equal(BET_STAKE);

    // User paid the stake
    const userBalAfter = await g.provider.connection.getTokenAccountBalance(
      user1.usdcAccount
    );
    expect(
      Number(userBalBefore.value.amount) - Number(userBalAfter.value.amount)
    ).to.equal(BET_STAKE);
  });

  it("second user places bet — pool and market counters accumulate correctly", async () => {
    const secondStake = 3_000_000; // 3 USDC

    const positionPda = derivePositionPda(
      g.program.programId,
      poolPda,
      user2.keypair.publicKey
    );

    const sig = await g.program.methods
      .placeBet(Buffer.from([5, 6, 7, 8]), new anchor.BN(secondStake))
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupPda,
        market: marketPda,
        pool: poolPda,
        poolVault: poolVaultPda,
        position: positionPda,
        userTokenAccount: user2.usdcAccount,
        user: user2.keypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user2.keypair])
      .rpc({ commitment: "confirmed" });
    console.log("PlaceBet (user2) tx:", sig);

    // Pool counters: should reflect both bets
    const pool = await g.program.account.pool.fetch(poolPda);
    expect(pool.participantCount.toNumber()).to.equal(2);
    expect(pool.totalStaked.toNumber()).to.equal(BET_STAKE + secondStake);

    // Market counters: same
    const market = await g.program.account.market.fetch(marketPda);
    expect(market.totalParticipants.toNumber()).to.equal(2);
    expect(market.totalVolume.toNumber()).to.equal(BET_STAKE + secondStake);

    // Vault holds the sum of both stakes
    const vaultBal = await g.provider.connection.getTokenAccountBalance(
      poolVaultPda
    );
    expect(vaultBal.value.amount).to.equal(
      (BET_STAKE + secondStake).toString()
    );
  });
});

// place_bet_accuracy covers:
//   1. EmptyEncryptedPayload — zero-length payload
//   2. PayloadTooLarge — payload > 128 bytes
//   3. StakeTooLow — market.bet_size == 0 (flat YesNo market passed instead of Accuracy)
//   4. happy path: Micro tier bet — stake fixed at market.bet_size (1_000_000),
//        full position + pool + market state verified
//   5. happy path: second user bets on same pool — counters accumulate
//
// Unlike place_bet, there is no stake_amount argument: the on-chain transfer
// amount is market.bet_size.  Passing a flat market (bet_size=0) exercises
// the require!(bet_size > 0) guard that enforces Accuracy-only usage.
//
// Setup in before():
//   Accuracy group → Micro tier market (bet_size=1_000_000) → Accuracy pool
//   YesNo group → flat market (bet_size=0) → flat pool  ← for StakeTooLow
//   Three funded users via createFundedUsers

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
const ACCURACY = { accuracy: {} };
const CAT_OTHER = { other: {} };
const ORACLE_MANUAL = { manual: {} };
const POOL_TYPE_UNIFIED = { unified: {} };
const POOL_TYPE_ACCURACY = { accuracy: {} };
const TIER_MICRO = { micro: {} };

const MAX_PAYLOAD_SIZE = 128;
const MICRO_BET_SIZE = 1_000_000; // Tier::Micro.bet_size() in states.rs
const USER_USDC = 10_000_000;     // 10 USDC — enough for multiple bets
const DUMMY_PAYLOAD = [1, 2, 3, 4];

describe("place_bet_accuracy", () => {
  let g: GlobalFixtures;

  // Accuracy market (happy paths + payload error paths)
  let accuracyGroupPda: PublicKey;
  let microMarketPda: PublicKey;
  let accuracyPoolPda: PublicKey;
  let accuracyPoolVaultPda: PublicKey;

  // Flat YesNo market (bet_size=0 → StakeTooLow)
  let yesnoGroupPda: PublicKey;
  let flatMarketPda: PublicKey;
  let flatPoolPda: PublicKey;
  let flatPoolVaultPda: PublicKey;

  let errorUser: FundedUser;
  let user1: FundedUser;
  let user2: FundedUser;

  // ── Shared setup helper ───────────────────────────────────────────────────

  async function createGroup(marketType: any): Promise<PublicKey> {
    const cm = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);
    const groupIndex = cm.marketCount;
    const groupPda = deriveMarketGroupPda(
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
        marketType,
        CAT_OTHER,
        ORACLE_MANUAL,
        g.payer.publicKey,
        null,
        null,
        "Accuracy bet test question?",
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

    return groupPda;
  }

  async function createPool(
    marketPda: PublicKey,
    groupPda: PublicKey,
    poolType: any
  ): Promise<{ poolPda: PublicKey; poolVaultPda: PublicKey }> {
    const poolPda = derivePoolPda(g.program.programId, marketPda, 0);
    const poolVaultPda = derivePoolVaultPda(g.program.programId, poolPda);
    const vaultAuthorityPda = deriveVaultAuthorityPda(
      g.program.programId,
      poolPda
    );
    await g.program.methods
      .createPool(0, poolType)
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
    return { poolPda, poolVaultPda };
  }

  before(async () => {
    g = await setupGlobal();

    // ── Accuracy group → Micro tier market → Accuracy pool ───────────────────
    accuracyGroupPda = await createGroup(ACCURACY);
    microMarketPda = deriveMarketPda(
      g.program.programId,
      accuracyGroupPda,
      0 // Micro tier_byte
    );
    await g.program.methods
      .createTierMarket(TIER_MICRO)
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: accuracyGroupPda,
        market: microMarketPda,
        creator: g.payer.publicKey,
      })
      .rpc({ commitment: "confirmed" });

    ({ poolPda: accuracyPoolPda, poolVaultPda: accuracyPoolVaultPda } =
      await createPool(microMarketPda, accuracyGroupPda, POOL_TYPE_ACCURACY));

    // ── YesNo group → flat market (bet_size=0) → flat pool ───────────────────
    // Used exclusively for the StakeTooLow error path.
    yesnoGroupPda = await createGroup(YESNO);
    flatMarketPda = deriveMarketPda(g.program.programId, yesnoGroupPda, 0);
    await g.program.methods
      .createFlatMarket()
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: yesnoGroupPda,
        market: flatMarketPda,
        creator: g.payer.publicKey,
      })
      .rpc({ commitment: "confirmed" });

    ({ poolPda: flatPoolPda, poolVaultPda: flatPoolVaultPda } =
      await createPool(flatMarketPda, yesnoGroupPda, POOL_TYPE_UNIFIED));

    // ── Fund three independent users ─────────────────────────────────────────
    [errorUser, user1, user2] = await createFundedUsers(
      g.provider,
      g.payer,
      g.usdcMint,
      3,
      USER_USDC
    );
  });

  // ── Validation error paths ────────────────────────────────────────────────
  // All use errorUser on the Accuracy pool; each failing tx atomically
  // reverts the position init CPI, leaving the PDA free for the next test.

  it("rejects when encrypted_payload is empty (EmptyEncryptedPayload)", async () => {
    const positionPda = derivePositionPda(
      g.program.programId,
      accuracyPoolPda,
      errorUser.keypair.publicKey
    );

    let succeeded = false;
    try {
      await g.program.methods
        .placeBetAccuracy(Buffer.from([]))
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: accuracyGroupPda,
          market: microMarketPda,
          pool: accuracyPoolPda,
          poolVault: accuracyPoolVaultPda,
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
      accuracyPoolPda,
      errorUser.keypair.publicKey
    );
    const oversizedPayload = Buffer.alloc(MAX_PAYLOAD_SIZE + 1, 0xab);

    let succeeded = false;
    try {
      await g.program.methods
        .placeBetAccuracy(oversizedPayload)
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: accuracyGroupPda,
          market: microMarketPda,
          pool: accuracyPoolPda,
          poolVault: accuracyPoolVaultPda,
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

  it("rejects when market.bet_size == 0 (StakeTooLow) — flat market passed to accuracy instruction", async () => {
    // Passing a flat YesNo market (bet_size=0) exercises require!(bet_size > 0).
    const positionPda = derivePositionPda(
      g.program.programId,
      flatPoolPda,
      errorUser.keypair.publicKey
    );

    let succeeded = false;
    try {
      await g.program.methods
        .placeBetAccuracy(Buffer.from(DUMMY_PAYLOAD))
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: yesnoGroupPda,
          market: flatMarketPda,
          pool: flatPoolPda,
          poolVault: flatPoolVaultPda,
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
    expect(
      succeeded,
      "flat market (bet_size=0) should be rejected with StakeTooLow"
    ).to.be.false;
  });

  // ── Happy paths ───────────────────────────────────────────────────────────

  it("places Micro accuracy bet — stake fixed at market.bet_size, not user-provided", async () => {
    const positionPda = derivePositionPda(
      g.program.programId,
      accuracyPoolPda,
      user1.keypair.publicKey
    );

    const userBalBefore = await g.provider.connection.getTokenAccountBalance(
      user1.usdcAccount
    );
    const vaultBalBefore = await g.provider.connection.getTokenAccountBalance(
      accuracyPoolVaultPda
    );

    const sig = await g.program.methods
      .placeBetAccuracy(Buffer.from(DUMMY_PAYLOAD))
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: accuracyGroupPda,
        market: microMarketPda,
        pool: accuracyPoolPda,
        poolVault: accuracyPoolVaultPda,
        position: positionPda,
        userTokenAccount: user1.usdcAccount,
        user: user1.keypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user1.keypair])
      .rpc({ commitment: "confirmed" });
    console.log("PlaceBetAccuracy (user1/Micro) tx:", sig);

    // Position: stake must equal market.bet_size, NOT a user-supplied amount
    const pos = await g.program.account.position.fetch(positionPda);
    expect(pos.pool.toBase58()).to.equal(accuracyPoolPda.toBase58());
    expect(pos.market.toBase58()).to.equal(microMarketPda.toBase58());
    expect(pos.group.toBase58()).to.equal(accuracyGroupPda.toBase58());
    expect(pos.user.toBase58()).to.equal(user1.keypair.publicKey.toBase58());
    expect(Array.from(pos.encryptedPayload)).to.deep.equal(DUMMY_PAYLOAD);
    expect(pos.stake.toNumber()).to.equal(MICRO_BET_SIZE);
    expect(pos.payout.toNumber()).to.equal(0);
    expect(pos.status).to.have.property("open");

    // Pool counters
    const pool = await g.program.account.pool.fetch(accuracyPoolPda);
    expect(pool.participantCount.toNumber()).to.equal(1);
    expect(pool.totalStaked.toNumber()).to.equal(MICRO_BET_SIZE);

    // Market counters
    const market = await g.program.account.market.fetch(microMarketPda);
    expect(market.totalParticipants.toNumber()).to.equal(1);
    expect(market.totalVolume.toNumber()).to.equal(MICRO_BET_SIZE);

    // Vault received exactly MICRO_BET_SIZE
    const vaultBalAfter = await g.provider.connection.getTokenAccountBalance(
      accuracyPoolVaultPda
    );
    expect(
      Number(vaultBalAfter.value.amount) - Number(vaultBalBefore.value.amount)
    ).to.equal(MICRO_BET_SIZE);

    // User paid exactly MICRO_BET_SIZE
    const userBalAfter = await g.provider.connection.getTokenAccountBalance(
      user1.usdcAccount
    );
    expect(
      Number(userBalBefore.value.amount) - Number(userBalAfter.value.amount)
    ).to.equal(MICRO_BET_SIZE);
  });

  it("second user bets — pool and market counters accumulate by another bet_size", async () => {
    const positionPda = derivePositionPda(
      g.program.programId,
      accuracyPoolPda,
      user2.keypair.publicKey
    );

    const sig = await g.program.methods
      .placeBetAccuracy(Buffer.from([5, 6, 7, 8]))
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: accuracyGroupPda,
        market: microMarketPda,
        pool: accuracyPoolPda,
        poolVault: accuracyPoolVaultPda,
        position: positionPda,
        userTokenAccount: user2.usdcAccount,
        user: user2.keypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user2.keypair])
      .rpc({ commitment: "confirmed" });
    console.log("PlaceBetAccuracy (user2/Micro) tx:", sig);

    // Both bets are MICRO_BET_SIZE — no variable stakes in Accuracy markets
    const pool = await g.program.account.pool.fetch(accuracyPoolPda);
    expect(pool.participantCount.toNumber()).to.equal(2);
    expect(pool.totalStaked.toNumber()).to.equal(2 * MICRO_BET_SIZE);

    const market = await g.program.account.market.fetch(microMarketPda);
    expect(market.totalParticipants.toNumber()).to.equal(2);
    expect(market.totalVolume.toNumber()).to.equal(2 * MICRO_BET_SIZE);

    // Vault holds the sum of exactly two fixed-size bets
    const vaultBal = await g.provider.connection.getTokenAccountBalance(
      accuracyPoolVaultPda
    );
    expect(vaultBal.value.amount).to.equal((2 * MICRO_BET_SIZE).toString());
  });
});

// create_pool covers:
//   1. UnauthorizedAuthority — non-creator tries to create pool
//   2. InvalidMint — wrong accepted_mint passed
//   3. happy path: Unified pool for a YesNo market (pool_index=0, PoolType::Unified)
//   4. happy path: Accuracy pool for a Micro tier market (pool_index=0, PoolType::Accuracy)
//   5. re-init guard — pool_index=0 PDA already exists
//
// Error paths (1, 2) share pool_index=0 on the YesNo market with the happy
// path (3). Both fail before the pool init CPI fires so the PDA stays free.
//
// Prerequisites created in before():
//   yesnoMarketPda  — YesNo group → create_flat_market
//   accuracyMicroMarketPda — Accuracy group → create_tier_market(Micro)

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
import { createMint } from "../helpers/token";

const YESNO = { yesNo: {} };
const ACCURACY = { accuracy: {} };
const CAT_OTHER = { other: {} };
const ORACLE_MANUAL = { manual: {} };
const TIER_MICRO = { micro: {} };

const POOL_TYPE_UNIFIED = { unified: {} };
const POOL_TYPE_ACCURACY = { accuracy: {} };

describe("create_pool", () => {
  let g: GlobalFixtures;
  let creator: Keypair;
  let creatorTokenAccount: PublicKey;

  // Derived in before() — markets that already have their Market PDAs created
  let yesnoGroupPda: PublicKey;
  let yesnoMarketPda: PublicKey;
  let accuracyGroupPda: PublicKey;
  let accuracyMicroMarketPda: PublicKey;

  // ── Setup helpers ────────────────────────────────────────────────────────

  async function createGroup(marketType: any): Promise<PublicKey> {
    const cm = await g.program.account.cyperMarket.fetch(g.cyperMarketPda);
    const groupIndex = cm.marketCount;
    const marketGroupPda = deriveMarketGroupPda(
      g.program.programId,
      g.cyperMarketPda,
      BigInt(groupIndex.toString())
    );
    const bondPda = deriveBondPda(g.program.programId, marketGroupPda);
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
        creator.publicKey,
        null,
        null,
        "Will this pool test pass?",
        [],
        new anchor.BN(now + 300),
        new anchor.BN(now + 3900)
      )
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: marketGroupPda,
        bond: bondPda,
        bondVault: bondVaultPda,
        bondVaultAuthority: bondVaultAuthorityPda,
        creatorTokenAccount,
        acceptedMint: g.usdcMint,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    return marketGroupPda;
  }

  async function createFlatMarket(groupPda: PublicKey): Promise<PublicKey> {
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
    return marketPda;
  }

  async function createTierMarket(
    groupPda: PublicKey,
    tier: any,
    tierByte: number
  ): Promise<PublicKey> {
    const marketPda = deriveMarketPda(g.program.programId, groupPda, tierByte);
    await g.program.methods
      .createTierMarket(tier)
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: groupPda,
        market: marketPda,
        creator: creator.publicKey,
      })
      .rpc({ commitment: "confirmed" });
    return marketPda;
  }

  before(async () => {
    g = await setupGlobal();
    creator = g.payer;
    creatorTokenAccount = g.creatorUsdcAccount;

    yesnoGroupPda = await createGroup(YESNO);
    yesnoMarketPda = await createFlatMarket(yesnoGroupPda);

    accuracyGroupPda = await createGroup(ACCURACY);
    accuracyMicroMarketPda = await createTierMarket(
      accuracyGroupPda,
      TIER_MICRO,
      0
    );
  });

  // ── Validation error paths (run BEFORE happy paths for pool_index=0) ─────

  it("rejects when caller is not the market group creator (UnauthorizedAuthority)", async () => {
    const nonCreator = Keypair.generate();
    const airdropSig = await g.provider.connection.requestAirdrop(
      nonCreator.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await g.provider.connection.confirmTransaction(
      { signature: airdropSig, ...(await g.provider.connection.getLatestBlockhash()) },
      "confirmed"
    );

    const poolPda = derivePoolPda(g.program.programId, yesnoMarketPda, 0);
    const poolVaultPda = derivePoolVaultPda(g.program.programId, poolPda);
    const vaultAuthorityPda = deriveVaultAuthorityPda(
      g.program.programId,
      poolPda
    );

    let succeeded = false;
    try {
      await g.program.methods
        .createPool(0, POOL_TYPE_UNIFIED)
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: yesnoGroupPda,
          market: yesnoMarketPda,
          pool: poolPda,
          poolVault: poolVaultPda,
          vaultAuthority: vaultAuthorityPda,
          acceptedMint: g.usdcMint,
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

  it("rejects when accepted_mint does not match cypher_market (InvalidMint)", async () => {
    const wrongMint = await createMint(
      g.provider.connection,
      g.payer,
      g.payer.publicKey
    );

    const poolPda = derivePoolPda(g.program.programId, yesnoMarketPda, 0);
    const poolVaultPda = derivePoolVaultPda(g.program.programId, poolPda);
    const vaultAuthorityPda = deriveVaultAuthorityPda(
      g.program.programId,
      poolPda
    );

    let succeeded = false;
    try {
      await g.program.methods
        .createPool(0, POOL_TYPE_UNIFIED)
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: yesnoGroupPda,
          market: yesnoMarketPda,
          pool: poolPda,
          poolVault: poolVaultPda,
          vaultAuthority: vaultAuthorityPda,
          acceptedMint: wrongMint,
          creator: creator.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch (e) {
      if (e instanceof AnchorError) {
        expect(e.error.errorCode.code).to.equal("InvalidMint");
      }
    }
    expect(succeeded, "wrong mint should be rejected").to.be.false;
  });

  // ── Happy paths ───────────────────────────────────────────────────────────

  it("creates a Unified pool for a YesNo market and stores correct state", async () => {
    const poolPda = derivePoolPda(g.program.programId, yesnoMarketPda, 0);
    const poolVaultPda = derivePoolVaultPda(g.program.programId, poolPda);
    const vaultAuthorityPda = deriveVaultAuthorityPda(
      g.program.programId,
      poolPda
    );

    const sig = await g.program.methods
      .createPool(0, POOL_TYPE_UNIFIED)
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: yesnoGroupPda,
        market: yesnoMarketPda,
        pool: poolPda,
        poolVault: poolVaultPda,
        vaultAuthority: vaultAuthorityPda,
        acceptedMint: g.usdcMint,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });
    console.log("CreatePool (Unified) tx:", sig);

    const pool = await g.program.account.pool.fetch(poolPda);
    expect(pool.market.toBase58()).to.equal(yesnoMarketPda.toBase58());
    expect(pool.group.toBase58()).to.equal(yesnoGroupPda.toBase58());
    expect(pool.poolIndex).to.equal(0);
    expect(pool.poolType).to.have.property("unified");
    expect(pool.vault.toBase58()).to.equal(poolVaultPda.toBase58());
    expect(pool.participantCount.toNumber()).to.equal(0);
    expect(pool.totalStaked.toNumber()).to.equal(0);
    expect(pool.status).to.have.property("open");

    // Vault token account should be initialized and empty
    const vaultBal = await g.provider.connection.getTokenAccountBalance(
      poolVaultPda
    );
    expect(vaultBal.value.amount).to.equal("0");
  });

  it("creates an Accuracy pool for a Micro tier market and stores correct state", async () => {
    const poolPda = derivePoolPda(
      g.program.programId,
      accuracyMicroMarketPda,
      0
    );
    const poolVaultPda = derivePoolVaultPda(g.program.programId, poolPda);
    const vaultAuthorityPda = deriveVaultAuthorityPda(
      g.program.programId,
      poolPda
    );

    const sig = await g.program.methods
      .createPool(0, POOL_TYPE_ACCURACY)
      .accountsPartial({
        cypherMarket: g.cyperMarketPda,
        marketGroup: accuracyGroupPda,
        market: accuracyMicroMarketPda,
        pool: poolPda,
        poolVault: poolVaultPda,
        vaultAuthority: vaultAuthorityPda,
        acceptedMint: g.usdcMint,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });
    console.log("CreatePool (Accuracy/Micro) tx:", sig);

    const pool = await g.program.account.pool.fetch(poolPda);
    expect(pool.market.toBase58()).to.equal(accuracyMicroMarketPda.toBase58());
    expect(pool.group.toBase58()).to.equal(accuracyGroupPda.toBase58());
    expect(pool.poolIndex).to.equal(0);
    expect(pool.poolType).to.have.property("accuracy");
    expect(pool.vault.toBase58()).to.equal(poolVaultPda.toBase58());
    expect(pool.participantCount.toNumber()).to.equal(0);
    expect(pool.totalStaked.toNumber()).to.equal(0);
    expect(pool.status).to.have.property("open");

    const vaultBal = await g.provider.connection.getTokenAccountBalance(
      poolVaultPda
    );
    expect(vaultBal.value.amount).to.equal("0");
  });

  // ── Re-init guard ─────────────────────────────────────────────────────────

  it("rejects re-initialization of an already-created pool", async () => {
    const poolPda = derivePoolPda(g.program.programId, yesnoMarketPda, 0);
    const poolVaultPda = derivePoolVaultPda(g.program.programId, poolPda);
    const vaultAuthorityPda = deriveVaultAuthorityPda(
      g.program.programId,
      poolPda
    );

    let succeeded = false;
    try {
      await g.program.methods
        .createPool(0, POOL_TYPE_UNIFIED)
        .accountsPartial({
          cypherMarket: g.cyperMarketPda,
          marketGroup: yesnoGroupPda,
          market: yesnoMarketPda,
          pool: poolPda,
          poolVault: poolVaultPda,
          vaultAuthority: vaultAuthorityPda,
          acceptedMint: g.usdcMint,
          creator: creator.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      succeeded = true;
    } catch {
      // Expected: system program returns "account already in use"
    }
    expect(succeeded, "re-init of an existing pool should be rejected").to.be
      .false;
  });
});

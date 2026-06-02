// Full end-to-end test: 2 bettors on a YesNo market, devnet.
//
// Usage:
//   ARCIUM_CLUSTER_OFFSET=456 npx ts-node -P tsconfig.json scripts/e2e_yesno.ts [phase]
//
// Phases (run in order, separated by the waits shown below):
//   1  – Setup: create market, fund bettors, place bets        (runs in ~2 min)
//   2  – Lock + post resolution                                 (run ≥120 s after phase 1)
//   3  – Init settlement registry                               (run ≥3600 s after phase 2)
//   4  – Queue settlement + poll for Arcium callback            (run after phase 3; requires Arcium)
//   5  – Write payouts + bettor1 claims                         (run after phase 4 callback fires)
//
// State is persisted to scripts/e2e_state.json between phases.
//
// Prerequisites:
//   - Funded payer at ~/.config/solana/id.json (or KEYPAIR_PATH env var)
//   - ARCIUM_CLUSTER_OFFSET=456 set in your shell
//   - Arcium MXE initialized:  arcium deploy --cluster-offset 456 ...
//   - Comp defs uploaded:       yarn init:comp-defs

/**
 * 
Two caveats noted in the script:
1. The encrypted_payload in place_bet and encrypted_positions in queue_settlement_yesno are dummy zeros — for a proper test with correct winner determination, these need to be real Arcium ciphertexts using getMXEPublicKey() + Rescue FHE encryption.
2. Phase 5 hardcodes bettor1 as the winner; in production, derive the winner from the decrypted ShardSettled ciphertext.
 */

import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import {
  getArciumEnv,
  getArciumProgramId,
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getCompDefAccOffset,
  getCompDefAccAddress,
  getFeePoolAccAddress,
  getClockAccAddress,
} from "@arcium-hq/client";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import { CypherMain } from "../target/types/cypher_main";
import {
  deriveCypherMarketPda,
  deriveMarketGroupPda,
  deriveBondPda,
  deriveBondVaultPda,
  deriveBondVaultAuthorityPda,
  deriveMarketPda,
  derivePoolPda,
  derivePoolVaultPda,
  deriveVaultAuthorityPda,
  derivePositionPda,
  deriveSettlementRegistryPda,
} from "../tests/helpers/pda";
import { createMint, createTokenAccount, mintTo } from "../tests/helpers/token";

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

const PROGRAM_ID = new PublicKey(
  "7JpiCk5c1jZdBC9moiUBQbAjdvCGqUhuMRn4r4FpSjV4",
);

const STATE_PATH = `${__dirname}/e2e_state.json`;

// 5 USDC each bettor
const BETTOR_USDC = 5_000_000;
// 5 USDC stake per bettor
const BET_STAKE = 5_000_000;

const YESNO = { yesNo: {} };
const CAT_OTHER = { other: {} };
const ORACLE_MANUAL = { manual: {} };
const POOL_TYPE_UNIFIED = { unified: {} };

// SIGN_PDA_SEED bytes = utf8("ArciumSignerAccount") — from IDL const seed
const ARCIUM_SIGNER_SEED = Buffer.from("ArciumSignerAccount");

// ── State management ──────────────────────────────────────────────────────────

interface E2EState {
  phase: number;
  cypherMarketPda: string;
  usdcMint: string;
  treasury: string;
  creatorUsdcAccount: string;
  groupPda: string;
  bondPda: string;
  bondVaultPda: string;
  marketPda: string;
  poolPda: string;
  poolVaultPda: string;
  vaultAuthorityPda: string;
  settlementRegistryPda: string;
  bettor1SecretKey: number[];
  bettor2SecretKey: number[];
  bettor1UsdcAccount: string;
  bettor2UsdcAccount: string;
  lockTimestamp: number;
  resolvedAt: number;
}

function saveState(state: E2EState) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`State saved to ${STATE_PATH}`);
}

function loadState(): E2EState {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(`State file not found: ${STATE_PATH}\nRun phase 1 first.`);
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(ts: number, label: string) {
  const now = Math.floor(Date.now() / 1000);
  const delta = ts - now;
  if (delta <= 0) return;
  console.log(`Waiting ${delta}s for ${label}…`);
  await sleep(delta * 1000 + 2000); // +2s buffer for validator clock skew
}

function buildProvider(
  connection: Connection,
  payer: Keypair,
): anchor.AnchorProvider {
  const wallet = {
    publicKey: payer.publicKey,
    signTransaction: async (tx: any) => {
      tx.partialSign(payer);
      return tx;
    },
    signAllTransactions: async (txs: any[]) => {
      txs.forEach((t) => t.partialSign(payer));
      return txs;
    },
  };
  const provider = new anchor.AnchorProvider(connection, wallet as any, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  return provider;
}

function loadPayer(): Keypair {
  const path =
    process.env.KEYPAIR_PATH || `${os.homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(path).toString())),
  );
}

function signPdaAddress(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ARCIUM_SIGNER_SEED],
    getArciumProgramId(),
  )[0];
}

// ── Phase 1: Setup & Place Bets ────────────────────────────────────────────────

async function phase1() {
  console.log("\n=== PHASE 1: Setup + Place Bets ===\n");

  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadPayer();
  console.log("Payer:", payer.publicKey.toBase58());

  const provider = buildProvider(connection, payer);
  const idl = JSON.parse(
    fs.readFileSync("target/idl/cypher_main.json", "utf-8"),
  );
  const program = new Program<CypherMain>(idl, provider);

  const cypherMarketPda = deriveCypherMarketPda(PROGRAM_ID);

  // ── USDC mint + treasury ─────────────────────────────────────────────────────
  let usdcMint: PublicKey;
  let treasury: PublicKey;
  let creatorUsdcAccount: PublicKey;

  const existing = await connection.getAccountInfo(cypherMarketPda);
  if (existing) {
    const cm = await program.account.cyperMarket.fetch(cypherMarketPda);
    usdcMint = cm.acceptedMint;
    treasury = cm.treasury;
    console.log(
      "cypher_market already initialized, using existing mint:",
      usdcMint.toBase58(),
    );
    creatorUsdcAccount = await createTokenAccount(
      connection,
      payer,
      usdcMint,
      payer.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      creatorUsdcAccount,
      payer,
      100_000_000,
    );
  } else {
    usdcMint = await createMint(connection, payer, payer.publicKey);
    treasury = await createTokenAccount(
      connection,
      payer,
      usdcMint,
      payer.publicKey,
    );
    creatorUsdcAccount = await createTokenAccount(
      connection,
      payer,
      usdcMint,
      payer.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      creatorUsdcAccount,
      payer,
      100_000_000,
    );

    const initSig = await program.methods
      .initialize(50, 150, 2000) // protocol_fee=0.5%, lp_fee=1.5%, accuracy_platform_fee=20%
      .accountsPartial({
        cypherMarket: cypherMarketPda,
        treasury,
        acceptedMint: usdcMint,
        authority: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });
    console.log("Initialize tx:", initSig);
  }

  // ── Fund bettors ──────────────────────────────────────────────────────────────
  console.log("\nCreating bettors...");
  const bettor1 = Keypair.generate();
  const bettor2 = Keypair.generate();

  for (const b of [bettor1, bettor2]) {
    const sig = await connection.requestAirdrop(
      b.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(sig, "confirmed");
  }
  await sleep(2000);

  const bettor1UsdcAccount = await createTokenAccount(
    connection,
    payer,
    usdcMint,
    bettor1.publicKey,
  );
  const bettor2UsdcAccount = await createTokenAccount(
    connection,
    payer,
    usdcMint,
    bettor2.publicKey,
  );
  await mintTo(
    connection,
    payer,
    usdcMint,
    bettor1UsdcAccount,
    payer,
    BETTOR_USDC,
  );
  await mintTo(
    connection,
    payer,
    usdcMint,
    bettor2UsdcAccount,
    payer,
    BETTOR_USDC,
  );
  console.log("Bettor1:", bettor1.publicKey.toBase58());
  console.log("Bettor2:", bettor2.publicKey.toBase58());

  // ── Create market group ───────────────────────────────────────────────────────
  const cm = await program.account.cyperMarket.fetch(cypherMarketPda);
  const groupIndex = cm.marketCount;
  const groupPda = deriveMarketGroupPda(
    PROGRAM_ID,
    cypherMarketPda,
    BigInt(groupIndex.toString()),
  );
  const bondPda = deriveBondPda(PROGRAM_ID, groupPda);
  const bondVaultPda = deriveBondVaultPda(PROGRAM_ID, bondPda);
  const bondVaultAuthorityPda = deriveBondVaultAuthorityPda(
    PROGRAM_ID,
    bondPda,
  );

  const now = Math.floor(Date.now() / 1000);
  const lockTimestamp = now + 120; // lock in 2 min
  const resolveDeadline = now + 7200; // resolve deadline in 2 hrs

  const createGroupSig = await program.methods
    .createMarketGroup(
      YESNO,
      CAT_OTHER,
      ORACLE_MANUAL,
      payer.publicKey, // oracle_authority = payer (acts as oracle)
      null,
      null,
      "E2E test: Will bettor1 win? (YES wins)",
      [],
      new BN(lockTimestamp),
      new BN(resolveDeadline),
    )
    .accountsPartial({
      cypherMarket: cypherMarketPda,
      marketGroup: groupPda,
      bond: bondPda,
      bondVault: bondVaultPda,
      bondVaultAuthority: bondVaultAuthorityPda,
      creatorTokenAccount: creatorUsdcAccount,
      acceptedMint: usdcMint,
      creator: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc({ commitment: "confirmed" });
  console.log("\nCreateMarketGroup tx:", createGroupSig);

  // ── Create flat market ────────────────────────────────────────────────────────
  const marketPda = deriveMarketPda(PROGRAM_ID, groupPda, 0);
  await program.methods
    .createFlatMarket()
    .accountsPartial({
      cypherMarket: cypherMarketPda,
      marketGroup: groupPda,
      market: marketPda,
      creator: payer.publicKey,
    })
    .rpc({ commitment: "confirmed" });
  console.log("CreateFlatMarket done");

  // ── Create pool ───────────────────────────────────────────────────────────────
  const poolPda = derivePoolPda(PROGRAM_ID, marketPda, 0);
  const poolVaultPda = derivePoolVaultPda(PROGRAM_ID, poolPda);
  const vaultAuthorityPda = deriveVaultAuthorityPda(PROGRAM_ID, poolPda);

  await program.methods
    .createPool(0, POOL_TYPE_UNIFIED)
    .accountsPartial({
      cypherMarket: cypherMarketPda,
      marketGroup: groupPda,
      market: marketPda,
      pool: poolPda,
      poolVault: poolVaultPda,
      vaultAuthority: vaultAuthorityPda,
      acceptedMint: usdcMint,
      creator: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc({ commitment: "confirmed" });
  console.log("CreatePool done");

  // ── Place bets ────────────────────────────────────────────────────────────────
  // NOTE: Encrypted payloads are dummy bytes. In production, each bettor would
  // encrypt their bet direction (1=YES, 0=NO) with the Arcium cluster's X25519
  // public key using Rescue FHE before calling place_bet.
  const bettor1PositionPda = derivePositionPda(
    PROGRAM_ID,
    poolPda,
    bettor1.publicKey,
  );
  const bettor2PositionPda = derivePositionPda(
    PROGRAM_ID,
    poolPda,
    bettor2.publicKey,
  );

  // bettor1 "bets YES" — dummy payload [1]
  const b1Sig = await program.methods
    .placeBet(
      Buffer.from([
        1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 1,
      ]),
      new BN(BET_STAKE),
    )
    .accountsPartial({
      cypherMarket: cypherMarketPda,
      marketGroup: groupPda,
      market: marketPda,
      pool: poolPda,
      poolVault: poolVaultPda,
      position: bettor1PositionPda,
      userTokenAccount: bettor1UsdcAccount,
      user: bettor1.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([bettor1])
    .rpc({ commitment: "confirmed" });
  console.log("\nBettor1 placed bet:", b1Sig);

  // bettor2 "bets NO" — dummy payload [0]
  const b2Sig = await program.methods
    .placeBet(
      Buffer.from([
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
      ]),
      new BN(BET_STAKE),
    )
    .accountsPartial({
      cypherMarket: cypherMarketPda,
      marketGroup: groupPda,
      market: marketPda,
      pool: poolPda,
      poolVault: poolVaultPda,
      position: bettor2PositionPda,
      userTokenAccount: bettor2UsdcAccount,
      user: bettor2.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([bettor2])
    .rpc({ commitment: "confirmed" });
  console.log("Bettor2 placed bet:", b2Sig);

  const pool = await program.account.pool.fetch(poolPda);
  console.log(
    `\nPool: ${pool.participantCount.toString()} participants, ${
      Number(pool.totalStaked.toString()) / 1e6
    } USDC staked`,
  );

  // ── Save state ─────────────────────────────────────────────────────────────────
  const settlementRegistryPda = deriveSettlementRegistryPda(
    PROGRAM_ID,
    poolPda,
  );
  const state: E2EState = {
    phase: 1,
    cypherMarketPda: cypherMarketPda.toBase58(),
    usdcMint: usdcMint.toBase58(),
    treasury: treasury.toBase58(),
    creatorUsdcAccount: creatorUsdcAccount.toBase58(),
    groupPda: groupPda.toBase58(),
    bondPda: bondPda.toBase58(),
    bondVaultPda: bondVaultPda.toBase58(),
    marketPda: marketPda.toBase58(),
    poolPda: poolPda.toBase58(),
    poolVaultPda: poolVaultPda.toBase58(),
    vaultAuthorityPda: vaultAuthorityPda.toBase58(),
    settlementRegistryPda: settlementRegistryPda.toBase58(),
    bettor1SecretKey: Array.from(bettor1.secretKey),
    bettor2SecretKey: Array.from(bettor2.secretKey),
    bettor1UsdcAccount: bettor1UsdcAccount.toBase58(),
    bettor2UsdcAccount: bettor2UsdcAccount.toBase58(),
    lockTimestamp,
    resolvedAt: 0,
  };
  saveState(state);

  console.log(`\n✓ Phase 1 complete.`);
  console.log(`  Market group:  ${groupPda.toBase58()}`);
  console.log(`  Pool:          ${poolPda.toBase58()}`);
  console.log(
    `  Lock at:       ${new Date(
      lockTimestamp * 1000,
    ).toLocaleTimeString()} (in ~120s)`,
  );
  console.log(
    `\n→ Run phase 2 after ${new Date(lockTimestamp * 1000).toLocaleString()}`,
  );
}

// ── Phase 2: Lock Market + Post Resolution ─────────────────────────────────────

async function phase2() {
  console.log("\n=== PHASE 2: Lock + Post Resolution ===\n");

  const state = loadState();
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadPayer();
  const provider = buildProvider(connection, payer);
  const idl = JSON.parse(
    fs.readFileSync("target/idl/cypher_main.json", "utf-8"),
  );
  const program = new Program<CypherMain>(idl, provider);

  const groupPda = new PublicKey(state.groupPda);
  const poolPda = new PublicKey(state.poolPda);

  // ── Wait for lock timestamp ───────────────────────────────────────────────────
  await waitUntil(state.lockTimestamp, "lock_timestamp");

  // ── Lock market ───────────────────────────────────────────────────────────────
  const lockSig = await program.methods
    .lockMarket()
    .accountsPartial({
      marketGroup: groupPda,
      pool: poolPda,
    })
    .rpc({ commitment: "confirmed" });
  console.log("LockMarket tx:", lockSig);

  const group = await program.account.marketGroup.fetch(groupPda);
  console.log("Market status:", JSON.stringify(group.status));

  // ── Post resolution: YES wins ─────────────────────────────────────────────────
  // resolve as YesNo(true) — YES side wins → bettor1 wins
  const resolvedValue = { yesNo: { "0": true } };

  const resSig = await program.methods
    .postResolution(resolvedValue)
    .accountsPartial({
      marketGroup: groupPda,
      oracleSigner: payer.publicKey,
    })
    .rpc({ commitment: "confirmed" });
  console.log("PostResolution tx:", resSig);

  const resolvedAt = Math.floor(Date.now() / 1000);
  const updatedGroup = await program.account.marketGroup.fetch(groupPda);
  console.log("Resolved value:", JSON.stringify(updatedGroup.resolvedValue));
  console.log(
    "Dispute deadline:",
    new Date(
      (updatedGroup.disputeDeadline?.toNumber() ?? 0) * 1000,
    ).toLocaleString(),
  );

  // ── Save state ─────────────────────────────────────────────────────────────────
  const updated = { ...state, phase: 2, resolvedAt };
  saveState(updated);

  const disputeEnd = resolvedAt + 3600;
  console.log(`\n✓ Phase 2 complete. Market resolved YES.`);
  console.log(
    `  Dispute window ends: ${new Date(disputeEnd * 1000).toLocaleString()}`,
  );
  console.log(
    `\n→ Run phase 3 after ${new Date(
      disputeEnd * 1000,
    ).toLocaleString()} (~60 min from now)`,
  );
}

// ── Phase 3: Init Settlement Registry ────────────────────────────────────────────

async function phase3() {
  console.log("\n=== PHASE 3: Init Settlement Registry ===\n");

  const state = loadState();
  if (state.resolvedAt === 0)
    throw new Error("resolvedAt is 0 — run phase 2 first");

  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadPayer();
  const provider = buildProvider(connection, payer);
  const idl = JSON.parse(
    fs.readFileSync("target/idl/cypher_main.json", "utf-8"),
  );
  const program = new Program<CypherMain>(idl, provider);

  const groupPda = new PublicKey(state.groupPda);
  const marketPda = new PublicKey(state.marketPda);
  const poolPda = new PublicKey(state.poolPda);
  const registryPda = new PublicKey(state.settlementRegistryPda);

  // ── Wait for dispute window ───────────────────────────────────────────────────
  const disputeEnd = state.resolvedAt + 3600;
  await waitUntil(disputeEnd, "dispute window");

  // ── Compute total_shards ──────────────────────────────────────────────────────
  const pool = await program.account.pool.fetch(poolPda);
  const YESNO_SHARD_SIZE = 8;
  const participantCount = Number(pool.participantCount.toString());
  const totalShards = Math.ceil(participantCount / YESNO_SHARD_SIZE) || 1;
  console.log(
    `Participants: ${participantCount}, total_shards: ${totalShards}`,
  );

  const regSig = await program.methods
    .initSettlementRegistry(totalShards)
    .accountsPartial({
      marketGroup: groupPda,
      market: marketPda,
      pool: poolPda,
      settlementRegistry: registryPda,
      backend: payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  console.log("InitSettlementRegistry tx:", regSig);

  const registry = await program.account.settlementRegistry.fetch(registryPda);
  console.log("Registry status:", JSON.stringify(registry.status));
  console.log("Total shards:", registry.totalShards);

  saveState({ ...state, phase: 3 });
  console.log(
    `\n✓ Phase 3 complete. Run phase 4 to queue settlement (requires Arcium MXE).`,
  );
}

// ── Phase 4: Queue Settlement + Poll for Callback ─────────────────────────────

async function phase4() {
  console.log("\n=== PHASE 4: Queue Settlement + Poll Callback ===\n");
  console.log("NOTE: This phase requires the Arcium MXE to be initialized.");
  console.log("      ARCIUM_CLUSTER_OFFSET env var must be set.\n");

  const state = loadState();
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadPayer();
  const provider = buildProvider(connection, payer);
  const idl = JSON.parse(
    fs.readFileSync("target/idl/cypher_main.json", "utf-8"),
  );
  const program = new Program<CypherMain>(idl, provider);

  const arciumEnv = getArciumEnv();
  const groupPda = new PublicKey(state.groupPda);
  const poolPda = new PublicKey(state.poolPda);
  const registryPda = new PublicKey(state.settlementRegistryPda);
  const mxeAccount = getMXEAccAddress(PROGRAM_ID);

  const registry = await program.account.settlementRegistry.fetch(registryPda);
  const totalShards = registry.totalShards;
  const YESNO_SHARD_SIZE = 8;

  // Build encrypted positions array — dummy 32-byte arrays.
  // For production: encrypt each bettor's bet direction (1=YES, 0=NO) with the
  // Arcium cluster's X25519 key using getMXEPublicKey() + Rescue FHE encryption.
  const pool = await program.account.pool.fetch(poolPda);
  const participantCount = Number(pool.participantCount.toString());

  const compDefOffset = Buffer.from(
    getCompDefAccOffset("settle_yesno"),
  ).readUInt32LE();
  const compDefAccount = getCompDefAccAddress(PROGRAM_ID, compDefOffset);

  for (let shardIndex = 0; shardIndex < totalShards; shardIndex++) {
    const shardStart = shardIndex * YESNO_SHARD_SIZE;
    const shardEnd = Math.min(shardStart + YESNO_SHARD_SIZE, participantCount);
    const shardSize = shardEnd - shardStart;

    // dummy ciphertexts: all-zero 32 bytes per position
    const encryptedPositions = Array.from({ length: shardSize }, () =>
      Array.from({ length: 32 }, () => 0),
    );

    const computationOffset = new BN(Date.now());
    await sleep(2); // ensure unique offset across shards

    const computationAccount = getComputationAccAddress(
      arciumEnv.arciumClusterOffset,
      computationOffset as any, // SDK accepts BN; .d.ts incorrectly types as number
    );

    const queueSig = await (program.methods as any)
      .queueSettlementYesno(
        computationOffset,
        encryptedPositions,
        Array(32).fill(0), // _nonce (unused)
        1, // resolved_side: 1 = YES
        shardIndex,
        totalShards,
      )
      .accountsPartial({
        payer: payer.publicKey,
        mxeAccount,
        signPdaAccount: signPdaAddress(),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(
          arciumEnv.arciumClusterOffset,
        ),
        computationAccount,
        compDefAccount,
        clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
        poolAccount: getFeePoolAccAddress(),
        clockAccount: getClockAccAddress(),
        systemProgram: SystemProgram.programId,
        marketGroup: groupPda,
        pool: poolPda,
        settlementRegistry: registryPda,
      })
      .signers([payer])
      .rpc({ commitment: "confirmed" });

    console.log(`Queued shard ${shardIndex}/${totalShards - 1}: ${queueSig}`);
  }

  // ── Poll until all shards settled ─────────────────────────────────────────────
  console.log(
    "\nPolling for Arcium callbacks (settled_shards == total_shards)…",
  );
  const maxWaitMs = 10 * 60 * 1000; // 10 min timeout
  const startMs = Date.now();

  while (true) {
    await sleep(5000);
    const reg = await program.account.settlementRegistry.fetch(registryPda);
    console.log(`  settled_shards: ${reg.settledShards} / ${reg.totalShards}`);
    if (reg.settledShards >= reg.totalShards) {
      console.log(
        "All shards settled! Registry status:",
        JSON.stringify(reg.status),
      );
      break;
    }
    if (Date.now() - startMs > maxWaitMs) {
      console.warn(
        "Timeout waiting for callbacks. Check Arcium network status.",
      );
      break;
    }
  }

  saveState({ ...state, phase: 4 });
  console.log(`\n✓ Phase 4 complete. Run phase 5 to write payouts and claim.`);
}

// ── Phase 5: Write Payouts + Claim ────────────────────────────────────────────

async function phase5() {
  console.log("\n=== PHASE 5: Write Payouts + Claim ===\n");

  const state = loadState();
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadPayer();
  const provider = buildProvider(connection, payer);
  const idl = JSON.parse(
    fs.readFileSync("target/idl/cypher_main.json", "utf-8"),
  );
  const program = new Program<CypherMain>(idl, provider);

  const poolPda = new PublicKey(state.poolPda);
  const poolVaultPda = new PublicKey(state.poolVaultPda);
  const vaultAuthorityPda = new PublicKey(state.vaultAuthorityPda);
  const registryPda = new PublicKey(state.settlementRegistryPda);
  const bettor1 = Keypair.fromSecretKey(new Uint8Array(state.bettor1SecretKey));
  const bettor2 = Keypair.fromSecretKey(new Uint8Array(state.bettor2SecretKey));
  const bettor1UsdcAccount = new PublicKey(state.bettor1UsdcAccount);
  const bettor2UsdcAccount = new PublicKey(state.bettor2UsdcAccount);
  const bettor1PositionPda = derivePositionPda(
    PROGRAM_ID,
    poolPda,
    bettor1.publicKey,
  );
  const bettor2PositionPda = derivePositionPda(
    PROGRAM_ID,
    poolPda,
    bettor2.publicKey,
  );

  // ── Check registry status ─────────────────────────────────────────────────────
  const registry = await program.account.settlementRegistry.fetch(registryPda);
  console.log("Registry status:", JSON.stringify(registry.status));
  if (!registry.status.finalizing && !registry.status.complete) {
    throw new Error(
      "Registry is not yet Finalizing — run phase 4 first (all shards must settle).",
    );
  }

  // ── Compute winner payout ─────────────────────────────────────────────────────
  // After settle_yesno_callback, pool_vault balance = total_staked - proto_fee - lp_fee.
  // The callback sends fees during execution, so we read the current vault balance.
  const vaultInfo = await getAccount(connection, poolVaultPda);
  const vaultBalance = Number(vaultInfo.amount.toString());
  console.log(`Pool vault balance after fees: ${vaultBalance / 1e6} USDC`);

  // bettor1 is the winner (YES wins), bettor2 is the loser.
  // NOTE: In production, derive winner from the decrypted ShardSettled ciphertext
  // (the Arcium-encrypted winner mask from the settle_yesno_callback event).
  const winnerPayout = vaultBalance;
  const loserPayout = 0;

  console.log(`bettor1 (YES) payout: ${winnerPayout / 1e6} USDC`);
  console.log(`bettor2 (NO)  payout: ${loserPayout / 1e6} USDC`);

  // ── Write bettor1 payout ──────────────────────────────────────────────────────
  const wp1Sig = await program.methods
    .writePositionPayout(new BN(winnerPayout))
    .accountsPartial({
      settlementRegistry: registryPda,
      position: bettor1PositionPda,
      backend: payer.publicKey,
    })
    .rpc({ commitment: "confirmed" });
  console.log("\nwritePositionPayout (bettor1):", wp1Sig);

  // ── Write bettor2 payout ──────────────────────────────────────────────────────
  const wp2Sig = await program.methods
    .writePositionPayout(new BN(loserPayout))
    .accountsPartial({
      settlementRegistry: registryPda,
      position: bettor2PositionPda,
      backend: payer.publicKey,
    })
    .rpc({ commitment: "confirmed" });
  console.log("writePositionPayout (bettor2):", wp2Sig);

  // ── Bettor1 claims payout ─────────────────────────────────────────────────────
  const b1Before = await getAccount(connection, bettor1UsdcAccount);
  console.log(
    `\nbettor1 USDC before claim: ${Number(b1Before.amount.toString()) / 1e6}`,
  );

  const claimSig = await program.methods
    .claimPayout()
    .accountsPartial({
      position: bettor1PositionPda,
      pool: poolPda,
      poolVault: poolVaultPda,
      vaultAuthority: vaultAuthorityPda,
      userTokenAccount: bettor1UsdcAccount,
      user: bettor1.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([bettor1])
    .rpc({ commitment: "confirmed" });
  console.log("claimPayout tx:", claimSig);

  const b1After = await getAccount(connection, bettor1UsdcAccount);
  const b2After = await getAccount(connection, bettor2UsdcAccount);
  console.log(`\n─── Final Balances ───`);
  console.log(
    `bettor1: ${Number(b1After.amount.toString()) / 1e6} USDC  (started with ${
      BETTOR_USDC / 1e6
    }, bet ${BET_STAKE / 1e6})`,
  );
  console.log(
    `bettor2: ${Number(b2After.amount.toString()) / 1e6} USDC  (started with ${
      BETTOR_USDC / 1e6
    }, bet ${BET_STAKE / 1e6})`,
  );

  const pos1 = await program.account.position.fetch(bettor1PositionPda);
  const pos2 = await program.account.position.fetch(bettor2PositionPda);
  console.log(`\nbettor1 position status: ${JSON.stringify(pos1.status)}`);
  console.log(`bettor2 position status: ${JSON.stringify(pos2.status)}`);

  saveState({ ...state, phase: 5 });
  console.log(`\n✓ Phase 5 complete. E2E test finished!`);
  console.log(`\nSummary:`);
  console.log(`  Total staked:  ${(BET_STAKE * 2) / 1e6} USDC (both bettors)`);
  console.log(
    `  bettor1 net:   ${
      (Number(b1After.amount.toString()) - (BETTOR_USDC - BET_STAKE)) / 1e6
    } USDC`,
  );
  console.log(
    `  bettor2 net:   ${
      (Number(b2After.amount.toString()) - (BETTOR_USDC - BET_STAKE)) / 1e6
    } USDC`,
  );
}

// ── Entrypoint ─────────────────────────────────────────────────────────────────

async function main() {
  const phase = parseInt(process.argv[2] ?? "1", 10);

  switch (phase) {
    case 1:
      await phase1();
      break;
    case 2:
      await phase2();
      break;
    case 3:
      await phase3();
      break;
    case 4:
      await phase4();
      break;
    case 5:
      await phase5();
      break;
    default:
      console.error(`Unknown phase: ${phase}. Valid values: 1 2 3 4 5`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});

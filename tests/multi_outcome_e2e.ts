import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  createAccount,
  mintTo,
} from "@solana/spl-token";
import {
  getArciumEnv,
  getArciumProgramId,
  getCompDefAccOffset,
  getCompDefAccAddress,
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getFeePoolAccAddress,
  getClockAccAddress,
  getLookupTableAddress,
  getMXEPublicKey,
  x25519,
  RescueCipher,
  deserializeLE,
  awaitComputationFinalization,
  uploadCircuit,
} from "@arcium-hq/client";
import * as fs from "fs";

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey(
  "cyphPe923pnPGVXJL3a3P7t2W9mJsagBcg1oeauoh2B",
);
// CSDC mint pinned by ACCEPTED_MINT in programs/cypher_main/src/states.rs
// (non-mainnet build). Pre-loaded as a genesis account via Anchor.toml's
// [[test.validator.account]] block — see scripts/setup-csdc-mint.ts.
const CSDC_MINT = new PublicKey(
  "8AF9BABNWwEhipRxtXPYoWSZW24SKjUn6YqbKd9ZqhwB",
);
const ARCIUM_PROGRAM_ID = getArciumProgramId();
const ARCIUM_ENV = (() => {
  try {
    return getArciumEnv();
  } catch {
    return null;
  }
})();

const SIGN_PDA_SEED = Buffer.from("ArciumSignerAccount");
const CREATOR_BOND = 10_000_000; // 10 USDC bond
const PROTOCOL_FEE_BPS = 50; // 0.5%
const LP_FEE_BPS = 150; // 1.5%
const USDC_DECIMALS = 6;
const POLL_INTERVAL_MS = 2_000;
const CALLBACK_TIMEOUT_MS = 120_000;

// 5 bettors on 4 presidential candidates
const CANDIDATES = [
  "Donald Trump",
  "JFK",
  "James Madison",
  "Barack Obama",
] as const;
const WINNING_OUTCOME = 0; // Donald Trump wins

const BETTOR_CONFIG = [
  { name: "MagaFan1", outcome: 0, betAmount: 10_000_000 }, // 10 USDC on Trump    (WINNER)
  { name: "Liberty22", outcome: 1, betAmount: 5_000_000 }, //  5 USDC on JFK      (LOSER)
  { name: "MagaFan2", outcome: 0, betAmount: 20_000_000 }, // 20 USDC on Trump    (WINNER)
  { name: "FedPaper", outcome: 2, betAmount: 15_000_000 }, // 15 USDC on Madison  (LOSER)
  { name: "Hope4ward", outcome: 3, betAmount: 8_000_000 }, //  8 USDC on Obama    (LOSER)
] as const;

const COMP_DEFS = [
  {
    circuit: "place_private_bet_multi",
    method: "initPlaceBetMultiCompDef" as any,
  },
  {
    circuit: "reveal_market_outcome_multi",
    method: "initRevealMultiCompDef" as any,
  },
  { circuit: "compute_multi_payout", method: "initPayoutMultiCompDef" as any },
  { circuit: "compute_multi_refund", method: "initRefundMultiCompDef" as any },
];

// ─────────────────────────────────────────────────────────────────────────────
//  PDA Helpers
// ─────────────────────────────────────────────────────────────────────────────

function findGlobalStatePda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global_state")],
    PROGRAM_ID,
  )[0];
}

function findMarketPda(marketId: anchor.BN): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(marketId.toString()));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), buf],
    PROGRAM_ID,
  )[0];
}

function findMarketVaultPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market_vault"), market.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function findLpPositionPda(market: PublicKey, creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp-position"), market.toBuffer(), creator.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function findPositionPda(market: PublicKey, user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), user.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function findSignPdaAccount(): PublicKey {
  return PublicKey.findProgramAddressSync([SIGN_PDA_SEED], PROGRAM_ID)[0];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(ts: number, label: string) {
  const now = Math.floor(Date.now() / 1000);
  if (now >= ts) return;
  const delta = ts - now;
  console.log(`  ⏳ Waiting ${delta}s (${label})...`);
  const start = Date.now();
  while (Date.now() - start < delta * 1000) {
    await sleep(1_000);
  }
}

function fmtUsdc(lamports: number | bigint): string {
  return (Number(lamports) / 10 ** USDC_DECIMALS).toFixed(2);
}

async function waitForMxeReady(
  provider: anchor.AnchorProvider,
  timeoutMs = 240_000,
): Promise<Uint8Array> {
  const deadline = Date.now() + timeoutMs;
  console.log(`  Waiting for MXE keys (up to ${timeoutMs / 1000}s)...`);
  while (Date.now() < deadline) {
    try {
      const key = await getMXEPublicKey(provider, PROGRAM_ID);
      if (key) {
        console.log(`  ✓ MXE public key ready`);
        return key;
      }
    } catch {}
    await sleep(5_000);
    console.log(`  ⏳ MXE keys not set yet, retrying...`);
  }
  throw new Error(
    "MXE keys never became available — is the Arcium cluster running?",
  );
}

function encryptBetInput(
  netAmount: number,
  side: number,
  mxePubKey: Uint8Array,
): {
  encryptedAmount: number[];
  encryptedSide: number[];
  pubKey: number[];
  nonce: BN;
  nonceBytes: Uint8Array;
} {
  const userPrivKey = crypto.getRandomValues(new Uint8Array(32));
  const userPubKey = x25519.getPublicKey(userPrivKey);
  const sharedSecret = x25519.getSharedSecret(userPrivKey, mxePubKey);

  const cipher = new RescueCipher(sharedSecret);

  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);

  const encrypted = cipher.encrypt(
    [BigInt(netAmount), BigInt(side)],
    nonceBytes,
  );

  const nonceBigInt = deserializeLE(nonceBytes);
  const nonceBN = new BN(nonceBigInt.toString());

  return {
    encryptedAmount: encrypted[0],
    encryptedSide: encrypted[1],
    pubKey: Array.from(userPubKey),
    nonce: nonceBN,
    nonceBytes,
  };
}

function expectedPayout(netBet: number, payoutRatio: number): number {
  return Math.floor((netBet * payoutRatio) / 1e9);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("multi_outcome_e2e", function () {
  this.timeout(900_000); // 15 min for the full lifecycle

  let provider: anchor.AnchorProvider;
  let connection: Connection;
  let program: any;
  let payer: Keypair;
  let usdcMint: PublicKey;
  let treasury: PublicKey;
  let globalStatePda: PublicKey;
  let marketPda: PublicKey;
  let marketVaultPda: PublicKey;
  let lpPositionPda: PublicKey;
  let creatorTokenAccount: PublicKey;
  let closeTime: number;
  let marketId: anchor.BN;
  let marketIndex: number;

  const users: {
    name: string;
    outcome: number;
    keypair: Keypair;
    usdcAccount: PublicKey;
    betAmount: number;
    positionPda: PublicKey;
  }[] = [];

  // ── Step 1: Initialize + Comp Defs ──────────────────────────────────────────

  it("Step 1: initialize protocol + register 4 multi-outcome Arcium circuits", async () => {
    console.log("\n═══════════════════════════════════════════════");
    console.log("  STEP 1: INITIALIZE + MULTI COMP DEFS");
    console.log("═══════════════════════════════════════════════\n");

    connection = new Connection(
      (anchor.AnchorProvider.env() as any).connection.rpcEndpoint,
      "confirmed",
    );

    const wallet = anchor.AnchorProvider.env().wallet;
    provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);

    const rawIdl = JSON.parse(
      fs.readFileSync("target/idl/cypher.json", "utf-8"),
    );
    program = new anchor.Program(rawIdl, provider) as any;

    payer = (wallet as any).payer as Keypair;
    console.log(`  Payer:       ${payer.publicKey.toBase58()}`);
    console.log(`  Program ID:  ${PROGRAM_ID.toBase58()}`);
    console.log(`  Arcium ID:   ${ARCIUM_PROGRAM_ID.toBase58()}`);

    // ── Initialize ──────────────────────────────────────────────────────────

    globalStatePda = findGlobalStatePda();
    const existing = await connection.getAccountInfo(globalStatePda);

    if (existing) {
      console.log(`  ℹ GlobalState already exists, reading config...`);
      const gs: any = await program.account.globalState.fetch(globalStatePda);
      usdcMint = gs.acceptedMint;
      treasury = gs.protocolTreasury;
      marketIndex = Number(gs.marketCounter.toString());
      console.log(`  USDC mint:   ${usdcMint.toBase58()}`);
      console.log(`  Treasury:    ${treasury.toBase58()}`);
      console.log(`  Market counter: ${marketIndex}`);
    } else {
      // Use the pre-loaded CSDC mint (test wallet is mint_authority via
      // scripts/setup-csdc-mint.ts + Anchor.toml's [[test.validator.account]]).
      usdcMint = CSDC_MINT;
      console.log(`  Mint:        ${usdcMint.toBase58()} (pre-loaded CSDC)`);

      const treasuryKeypair = Keypair.generate();
      treasury = await createAccount(
        connection,
        payer,
        usdcMint,
        payer.publicKey,
        treasuryKeypair,
      );
      console.log(`  Treasury:    ${treasury.toBase58()}`);

      const creatorKp = Keypair.generate();
      creatorTokenAccount = await createAccount(
        connection,
        payer,
        usdcMint,
        payer.publicKey,
        creatorKp,
      );
      await mintTo(
        connection,
        payer,
        usdcMint,
        creatorTokenAccount,
        payer,
        1_000_000_000,
      );

      const sig = await program.methods
        .initialize(PROTOCOL_FEE_BPS, LP_FEE_BPS)
        .accountsPartial({
          admin: payer.publicKey,
          globalState: globalStatePda,
          protocolTreasury: treasury,
          acceptedMint: usdcMint,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });
      console.log(`  ✓ initialize: ${sig}`);

      marketIndex = 0;
    }

    if (!creatorTokenAccount) {
      const gs: any = await program.account.globalState.fetch(globalStatePda);
      if (usdcMint.equals(gs.acceptedMint)) {
        const kp = Keypair.generate();
        creatorTokenAccount = await createAccount(
          connection,
          payer,
          usdcMint,
          payer.publicKey,
          kp,
        );
        await mintTo(
          connection,
          payer,
          usdcMint,
          creatorTokenAccount,
          payer,
          1_000_000_000,
        );
      }
    }

    // ── Register 4 Multi Computation Definitions ────────────────────────────

    console.log(`\n  Registering 4 multi-outcome Arcium circuits...`);

    for (const cd of COMP_DEFS) {
      const offset = Buffer.from(
        getCompDefAccOffset(cd.circuit),
      ).readUInt32LE();
      const compDefPda = getCompDefAccAddress(PROGRAM_ID, offset);
      const mxeAccount = getMXEAccAddress(PROGRAM_ID);

      const mxeInfo = await connection.getAccountInfo(mxeAccount);
      if (!mxeInfo) {
        console.log(`  ⚠ MXE account not found for ${cd.circuit}. Skipping.`);
        continue;
      }
      const lutAddress = getLookupTableAddress(PROGRAM_ID, new BN(3));

      try {
        const initSig = await (program.methods as any)
          [cd.method]()
          .accountsPartial({
            payer: payer.publicKey,
            mxeAccount,
            compDefAccount: compDefPda,
            addressLookupTable: lutAddress,
          })
          .signers([payer])
          .rpc({ commitment: "confirmed" });
        console.log(`  ✓ ${cd.circuit}: init ${initSig}`);
      } catch (e: any) {
        console.log(`  ℹ ${cd.circuit} init: ${e.message?.slice(0, 300)}`);
      }

      try {
        const uploadSigs = await uploadCircuit(
          provider,
          cd.circuit,
          PROGRAM_ID,
          new Uint8Array(1),
        );
        if (uploadSigs.length > 0) {
          console.log(
            `  ✓ ${cd.circuit}: finalized (${uploadSigs.length} txs)`,
          );
        } else {
          console.log(`  ℹ ${cd.circuit}: already finalized`);
        }
      } catch (e: any) {
        console.log(`  ℹ ${cd.circuit} upload: ${e.message?.slice(0, 300)}`);
      }

      await sleep(500);
    }

    console.log(`\n  ✓ Step 1 complete.`);
  });

  // ── Step 2: Create Multi-Outcome Market ──────────────────────────────────────

  it("Step 2: create_market_multi with 4 outcomes", async () => {
    console.log("\n═══════════════════════════════════════════════");
    console.log("  STEP 2: CREATE MULTI-OUTCOME MARKET");
    console.log("═══════════════════════════════════════════════\n");

    const gs: any = await program.account.globalState.fetch(globalStatePda);
    marketIndex = Number(gs.marketCounter.toString());

    marketId = new BN(marketIndex);
    marketPda = findMarketPda(marketId);

    closeTime = Math.floor(Date.now() / 1000) + 65;

    marketVaultPda = findMarketVaultPda(marketPda);
    lpPositionPda = findLpPositionPda(marketPda, payer.publicKey);

    const question = "Who will be the president of the USA?";
    const category = 1; // POLITICS
    const numOutcomes = 4;

    console.log(`  Question:    "${question}"`);
    console.log(`  Candidates:  ${CANDIDATES.join(", ")}`);
    console.log(`  Market ID:   ${marketIndex}`);
    console.log(`  Market PDA:  ${marketPda.toBase58()}`);
    console.log(`  Vault PDA:   ${marketVaultPda.toBase58()}`);
    console.log(`  LP Position: ${lpPositionPda.toBase58()}`);
    console.log(
      `  Close time:  ${new Date(closeTime * 1000).toLocaleString()}`,
    );
    console.log(`  Category:    1 (Politics)`);
    console.log(`  Outcomes:    ${numOutcomes}`);

    const sig = await program.methods
      .createMarketMulti(question, new BN(closeTime), category, numOutcomes)
      .accountsPartial({
        creator: payer.publicKey,
        globalState: globalStatePda,
        market: marketPda,
        lpPosition: lpPositionPda,
        marketVault: marketVaultPda,
        creatorTokenAccount: creatorTokenAccount,
        acceptedMint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log(`  ✓ create_market_multi: ${sig}`);

    const market: any = await program.account.market.fetch(marketPda);
    const q = String.fromCharCode(
      ...market.question.slice(0, market.questionLen),
    );
    console.log(`  ✓ On-chain question: "${q}"`);
    console.log(`  ✓ Market type:       ${market.marketType} (1=MultiOutcome)`);
    console.log(`  ✓ Num outcomes:      ${market.numOutcomes}`);
    console.log(`  ✓ Market state:      ${market.state} (0=Active)`);
    console.log(`  ✓ Creator bond:      ${fmtUsdc(market.creatorBond)} USDC`);

    const vaultBal = await getAccount(connection, marketVaultPda);
    console.assert(
      Number(vaultBal.amount) === CREATOR_BOND,
      `Expected vault balance = ${CREATOR_BOND}, got ${vaultBal.amount}`,
    );
    console.log(`  ✓ Bond of $10 USDC locked in vault`);

    console.log(`\n  ✓ Step 2 complete.`);
  });

  // ── Step 3: 5 Traders Place Bets on 4 Outcomes ─────────────────────────────

  it("Step 3: 5 traders place private multi-outcome bets", async () => {
    console.log("\n═══════════════════════════════════════════════");
    console.log("  STEP 3: 5 TRADERS PLACE BETS (4 outcomes)");
    console.log("═══════════════════════════════════════════════\n");

    console.log(`  Creating 5 funded wallets...`);
    console.log(
      `  ${"Name".padEnd(8)} | ${"Candidate".padEnd(13)} | ${"Bet".padEnd(
        8,
      )} | ${"Protocol Fee".padEnd(13)} | ${"LP Fee".padEnd(8)} | Net`,
    );
    console.log(`  ${"─".repeat(80)}`);

    for (const cfg of BETTOR_CONFIG) {
      const keypair = Keypair.generate();
      const sig = await connection.requestAirdrop(
        keypair.publicKey,
        2 * LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(sig, "confirmed");

      const usdcAccount = await createAccount(
        connection,
        payer,
        usdcMint,
        keypair.publicKey,
        Keypair.generate(),
      );

      await mintTo(
        connection,
        payer,
        usdcMint,
        usdcAccount,
        payer,
        cfg.betAmount,
      );

      const positionPda = findPositionPda(marketPda, keypair.publicKey);
      const pFee = Math.floor((cfg.betAmount * PROTOCOL_FEE_BPS) / 10_000);
      const lpFee = Math.floor((cfg.betAmount * LP_FEE_BPS) / 10_000);
      const net = cfg.betAmount - pFee - lpFee;

      users.push({
        name: cfg.name,
        outcome: cfg.outcome,
        keypair,
        usdcAccount,
        betAmount: cfg.betAmount,
        positionPda,
      });

      console.log(
        `  ${cfg.name.padEnd(8)} | ${CANDIDATES[cfg.outcome].padEnd(13)} | ` +
          `${fmtUsdc(cfg.betAmount).padEnd(8)} | ${fmtUsdc(pFee).padEnd(
            13,
          )} | ` +
          `${fmtUsdc(lpFee).padEnd(8)} | ${fmtUsdc(net)}`,
      );
    }

    await sleep(2_000);
    console.log(``);

    if (!ARCIUM_ENV) {
      throw new Error(
        "ARCIUM_CLUSTER_OFFSET is not set.\n" +
          "  This test requires the Arcium MXE cluster.\n" +
          "  Run:  arcium test\n" +
          "  Not:  anchor test",
      );
    }

    const mxePubKey = await waitForMxeReady(provider);

    // Pools start at 0 (revealed_pool_0/1/2/3) and accumulate with each bet callback.
    // No init step needed — plaintext pools are valid from market creation.
    console.log(
      `\n  Pools start at 0; accumulate with each bet callback (no init needed).`,
    );

    // Sequential bets: each waits for its Arcium callback before the next.
    // Concurrent submission would cause all bets to read the same stale pool
    // state and the last callback would overwrite the correct accumulated total.
    let allSettled = false;

    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      const pFee = Math.floor((u.betAmount * PROTOCOL_FEE_BPS) / 10_000);
      const lpFee = Math.floor((u.betAmount * LP_FEE_BPS) / 10_000);
      const netAmount = u.betAmount - pFee - lpFee;

      const vaultBefore = await getAccount(connection, marketVaultPda);

      const { encryptedAmount, encryptedSide, pubKey, nonce } = encryptBetInput(
        netAmount,
        u.outcome,
        mxePubKey,
      );

      const computationOffset = new BN(Date.now() + i * 100);

      console.log(
        `  ${u.name} (${CANDIDATES[u.outcome]}): ` +
          `placing ${fmtUsdc(u.betAmount)} USDC  [net=${fmtUsdc(
            netAmount,
          )}]...`,
      );

      try {
        const betSig = await (program.methods as any)
          .placePrivateBetMulti(
            computationOffset,
            new BN(u.betAmount),
            encryptedAmount,
            encryptedSide,
            pubKey,
            nonce,
          )
          .accountsPartial({
            payer: payer.publicKey,
            signPdaAccount: findSignPdaAccount(),
            mxeAccount: getMXEAccAddress(PROGRAM_ID),
            mempoolAccount: getMempoolAccAddress(
              ARCIUM_ENV!.arciumClusterOffset,
            ),
            executingPool: getExecutingPoolAccAddress(
              ARCIUM_ENV!.arciumClusterOffset,
            ),
            computationAccount: getComputationAccAddress(
              ARCIUM_ENV!.arciumClusterOffset,
              computationOffset as any,
            ),
            compDefAccount: getCompDefAccAddress(
              PROGRAM_ID,
              Buffer.from(
                getCompDefAccOffset("place_private_bet_multi"),
              ).readUInt32LE(),
            ),
            clusterAccount: getClusterAccAddress(
              ARCIUM_ENV!.arciumClusterOffset,
            ),
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
            systemProgram: SystemProgram.programId,
            arciumProgram: ARCIUM_PROGRAM_ID,
            user: u.keypair.publicKey,
            globalState: globalStatePda,
            market: marketPda,
            marketVault: marketVaultPda,
            userTokenAccount: u.usdcAccount,
            protocolTreasury: treasury,
            position: u.positionPda,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([u.keypair])
          .rpc({ commitment: "confirmed" });

        console.log(`    ✓ tx: ${betSig}`);

        const vaultAfter = await getAccount(connection, marketVaultPda);
        console.log(
          `    Vault: ${fmtUsdc(vaultBefore.amount)} → ${fmtUsdc(
            vaultAfter.amount,
          )}`,
        );
      } catch (e: any) {
        console.log(`    ✗ FAILED: ${e.message}`);
        continue;
      }

      // Wait for THIS bet's callback before placing the next one.
      try {
        const cbSig = await awaitComputationFinalization(
          provider,
          computationOffset,
          PROGRAM_ID,
          "confirmed",
          CALLBACK_TIMEOUT_MS,
        );
        console.log(`    ✓ callback: ${cbSig}`);

        // awaitComputationFinalization returns when Arcium marks computation finalized,
        // but the callback TX that increments total_bets_count may confirm slightly later.
        // Poll until total_bets_count reflects this bet before placing the next one.
        const expectedCount = i + 1;
        for (let attempt = 0; attempt < 30; attempt++) {
          const m: any = await program.account.market.fetch(marketPda);
          if (Number(m.totalBetsCount.toString()) >= expectedCount) break;
          await sleep(500);
        }

        const pos: any = await program.account.encryptedPosition.fetch(
          u.positionPda,
        );
        console.log(
          `    ${u.name} (${CANDIDATES[u.outcome]}): ` +
            `entry_odds=${pos.entryOdds.toString()}, claimed=${pos.claimed}`,
        );
      } catch (e: any) {
        console.log(`    ℹ callback timeout/error: ${e.message}`);
      }
    }

    try {
      const market: any = await program.account.market.fetch(marketPda);
      const count = Number(market.totalBetsCount.toString());
      console.log(`\n  total_bets_count: ${count} / ${users.length}`);
      allSettled = count >= users.length;
      if (allSettled)
        console.log(`  ✓ All ${users.length} bets confirmed on-chain!`);
    } catch {}

    if (!allSettled) {
      console.log(`  ℹ Not all callbacks received within timeout.`);
    }

    // ── Fee + Pool summary ────────────────────────────────────────────────────
    const totalBetAmount = users.reduce((s, u) => s + u.betAmount, 0);
    const totalProtocolFees = users.reduce(
      (s, u) => s + Math.floor((u.betAmount * PROTOCOL_FEE_BPS) / 10_000),
      0,
    );
    const totalLpFees = users.reduce(
      (s, u) => s + Math.floor((u.betAmount * LP_FEE_BPS) / 10_000),
      0,
    );

    const poolByOutcome = [0, 1, 2, 3].map((outcomeIdx) => {
      return users
        .filter((u) => u.outcome === outcomeIdx)
        .reduce((s, u) => {
          const pFee = Math.floor((u.betAmount * PROTOCOL_FEE_BPS) / 10_000);
          const lpFee = Math.floor((u.betAmount * LP_FEE_BPS) / 10_000);
          return s + u.betAmount - pFee - lpFee;
        }, 0);
    });

    const totalNet = poolByOutcome.reduce((s, v) => s + v, 0);

    console.log(`\n  ── Pool Summary (net after fees) ──`);
    for (let i = 0; i < 4; i++) {
      const traders = users
        .filter((u) => u.outcome === i)
        .map((u) => u.name)
        .join(", ");
      console.log(
        `  ${CANDIDATES[i].padEnd(13)}: ${fmtUsdc(poolByOutcome[i]).padEnd(
          9,
        )} USDC  [${traders || "—"}]`,
      );
    }
    console.log(`  Total net:   ${fmtUsdc(totalNet)} USDC`);
    console.log(`  Total bets:  ${fmtUsdc(totalBetAmount)} USDC`);
    console.log(`  Protocol fees (0.5%): ${fmtUsdc(totalProtocolFees)} USDC`);
    console.log(`  LP fees (1.5%):       ${fmtUsdc(totalLpFees)} USDC`);

    try {
      const vaultFinal = await getAccount(connection, marketVaultPda);
      console.log(
        `\n  Final vault balance: ${fmtUsdc(
          vaultFinal.amount,
        )} USDC (bond + all bets - protocol fees to treasury)`,
      );
    } catch (e: any) {
      console.log(`\n  Could not fetch vault balance: ${e.message}`);
    }

    console.log(`  ✓ Step 3 complete.`);
  });

  // ── Step 4: Wait + Resolve Market ─────────────────────────────────────────

  it("Step 4: resolve market to outcome 0 (Donald Trump wins)", async () => {
    console.log("\n═══════════════════════════════════════════════");
    console.log("  STEP 4: RESOLVE MULTI-OUTCOME MARKET");
    console.log("═══════════════════════════════════════════════\n");

    await waitUntil(closeTime + 5, "close_time");

    const marketBefore: any = await program.account.market.fetch(marketPda);
    console.log(`  Market state before: ${marketBefore.state} (0=Active)`);
    console.log(`  Total bets: ${marketBefore.totalBetsCount.toString()}`);
    console.log(
      `  Pool 0 (Trump):  ${fmtUsdc(marketBefore.revealedPool0)} USDC`,
    );
    console.log(
      `  Pool 1 (Harris): ${fmtUsdc(marketBefore.revealedPool1)} USDC`,
    );
    console.log(
      `  Pool 2 (DeSant): ${fmtUsdc(marketBefore.revealedPool2)} USDC`,
    );
    console.log(
      `  Pool 3 (Obama):  ${fmtUsdc(marketBefore.revealedPool3)} USDC`,
    );
    console.log(`  Num outcomes: ${marketBefore.numOutcomes}`);

    const outcomeValue = WINNING_OUTCOME; // 0 = Donald Trump wins
    const computationOffset = new BN(Date.now());

    console.log(
      `\n  Resolving with outcome=${outcomeValue} (${CANDIDATES[outcomeValue]} wins)...`,
    );

    try {
      const resolveSig = await (program.methods as any)
        .resolveMarketMulti(computationOffset, outcomeValue)
        .accountsPartial({
          payer: payer.publicKey,
          signPdaAccount: findSignPdaAccount(),
          mxeAccount: getMXEAccAddress(PROGRAM_ID),
          mempoolAccount: getMempoolAccAddress(ARCIUM_ENV!.arciumClusterOffset),
          executingPool: getExecutingPoolAccAddress(
            ARCIUM_ENV!.arciumClusterOffset,
          ),
          computationAccount: getComputationAccAddress(
            ARCIUM_ENV!.arciumClusterOffset,
            computationOffset as any,
          ),
          compDefAccount: getCompDefAccAddress(
            PROGRAM_ID,
            Buffer.from(
              getCompDefAccOffset("reveal_market_outcome_multi"),
            ).readUInt32LE(),
          ),
          clusterAccount: getClusterAccAddress(ARCIUM_ENV!.arciumClusterOffset),
          poolAccount: getFeePoolAccAddress(),
          clockAccount: getClockAccAddress(),
          systemProgram: SystemProgram.programId,
          arciumProgram: ARCIUM_PROGRAM_ID,
          resolver: payer.publicKey,
          market: marketPda,
        })
        .rpc({ commitment: "confirmed" });

      console.log(`  ✓ resolve_market_multi: ${resolveSig}`);
    } catch (e: any) {
      console.log(`  ✗ FAILED: ${e.message}`);
      console.log(`  ℹ This step requires Arcium.`);
    }

    const marketMid: any = await program.account.market.fetch(marketPda);
    console.log(
      `  pending_outcome: ${marketMid.pendingOutcome} (${
        CANDIDATES[marketMid.pendingOutcome]
      })`,
    );

    // ── Wait for Arcium callback via computation account finalization ─────────
    console.log(`\n  Waiting for reveal callback to fire...`);
    let resolved = false;

    try {
      const cbSig = await awaitComputationFinalization(
        provider,
        computationOffset,
        PROGRAM_ID,
        "confirmed",
        CALLBACK_TIMEOUT_MS,
      );
      console.log(`  ✓ reveal callback: ${cbSig}`);
      resolved = true;
    } catch (e: any) {
      console.log(`  ℹ reveal callback timeout/error: ${e.message}`);
    }

    if (resolved) {
      const market: any = await program.account.market.fetch(marketPda);
      if (market.state === 2) {
        const q = String.fromCharCode(
          ...market.question.slice(0, market.questionLen),
        );
        console.log(`\n  ✓ Market resolved via Arcium callback!`);
        console.log(`  Question:      "${q}"`);
        console.log(`  State:         ${market.state} (2=Resolved)`);
        console.log(
          `  Outcome:       ${market.outcome} (${
            CANDIDATES[market.outcome]
          } wins)`,
        );
        for (let i = 0; i < 4; i++) {
          console.log(
            `  Pool ${i} (${CANDIDATES[i]}):  ${fmtUsdc(
              market[`revealedPool${i}`],
            )} USDC`,
          );
        }
        console.log(`  Payout ratio:  ${market.payoutRatio.toString()}`);
        console.log(
          `  Resolution:    ${new Date(
            market.resolutionTime.toNumber() * 1000,
          ).toLocaleString()}`,
        );
        console.log(
          `  Claim deadline: ${new Date(
            market.claimDeadline.toNumber() * 1000,
          ).toLocaleString()}`,
        );

        console.assert(
          market.outcome === outcomeValue,
          `Expected outcome=${outcomeValue}, got ${market.outcome}`,
        );
        for (let i = 0; i < 4; i++) {
          const pool = Number((market[`revealedPool${i}`] as any).toString());
          if (i === outcomeValue)
            console.assert(pool > 0, `Winning pool ${i} should be > 0`);
        }
        console.assert(
          Number(market.payoutRatio.toString()) > 0,
          "payout_ratio should be > 0",
        );
        console.log(`  ✓ All assertions passed`);
      } else {
        console.log(
          `  ⚠ Computation finalized but market state=${market.state} (not 2). Callback may have errored.`,
        );
        resolved = false;
      }
    }

    if (!resolved)
      console.log(`  ℹ Market not resolved within timeout. Proceeding...`);

    console.log(`\n  ✓ Step 4 complete.`);
  });

  // ── Step 5+6: Claim Payouts ───────────────────────────────────────────────

  it("Step 5+6: winners claim payouts, losers claim zero", async () => {
    console.log("\n═══════════════════════════════════════════════");
    console.log("  STEPS 5+6: CLAIM PAYOUTS");
    console.log("═══════════════════════════════════════════════\n");

    const marketState: any = await program.account.market.fetch(marketPda);
    const isResolved = marketState.state === 2;

    if (!isResolved) {
      console.log(`  ℹ Market not resolved. Skipping claim steps.`);
      return;
    }

    const vaultBeforeClaim = await getAccount(connection, marketVaultPda);
    console.log(
      `  Vault balance before claims: ${fmtUsdc(vaultBeforeClaim.amount)} USDC`,
    );
    console.log(
      `  Winning outcome: ${marketState.outcome} (${
        CANDIDATES[marketState.outcome]
      })`,
    );

    // Queue claim computations for all bettors
    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      const isWinner = u.outcome === marketState.outcome;

      console.log(
        `\n  ── ${u.name} (${CANDIDATES[u.outcome]} | bet=${fmtUsdc(
          u.betAmount,
        )} USDC | ${isWinner ? "WINNER" : "LOSER"}) ──`,
      );

      const posBefore: any = await program.account.encryptedPosition.fetch(
        u.positionPda,
      );
      console.log(`  Already claimed: ${posBefore.claimed}`);

      if (posBefore.claimed) {
        console.log(`  Already claimed, skipping...`);
        continue;
      }

      const computationOffset = new BN(Date.now() + i * 100);

      try {
        const claimSig = await (program.methods as any)
          .claimPayoutMulti(computationOffset)
          .accountsPartial({
            payer: payer.publicKey,
            signPdaAccount: findSignPdaAccount(),
            mxeAccount: getMXEAccAddress(PROGRAM_ID),
            mempoolAccount: getMempoolAccAddress(
              ARCIUM_ENV!.arciumClusterOffset,
            ),
            executingPool: getExecutingPoolAccAddress(
              ARCIUM_ENV!.arciumClusterOffset,
            ),
            computationAccount: getComputationAccAddress(
              ARCIUM_ENV!.arciumClusterOffset,
              computationOffset as any,
            ),
            compDefAccount: getCompDefAccAddress(
              PROGRAM_ID,
              Buffer.from(
                getCompDefAccOffset("compute_multi_payout"),
              ).readUInt32LE(),
            ),
            clusterAccount: getClusterAccAddress(
              ARCIUM_ENV!.arciumClusterOffset,
            ),
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
            systemProgram: SystemProgram.programId,
            arciumProgram: ARCIUM_PROGRAM_ID,
            user: u.keypair.publicKey,
            market: marketPda,
            position: u.positionPda,
            marketVault: marketVaultPda,
            userTokenAccount: u.usdcAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([u.keypair])
          .rpc({ commitment: "confirmed" });

        console.log(`  ✓ claim_payout queued: ${claimSig}`);
      } catch (e: any) {
        console.log(`  ✗ FAILED: ${e.message}`);
      }

      await sleep(500);
    }

    // ── Poll for Arcium callbacks ──────────────────────────────────────────
    console.log(`\n  Waiting for claim callbacks...`);
    const pollStart = Date.now();
    let allClaimed = false;

    while (Date.now() - pollStart < CALLBACK_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const claims: boolean[] = [];
        for (let i = 0; i < users.length; i++) {
          const pos: any = await program.account.encryptedPosition.fetch(
            users[i].positionPda,
          );
          claims.push(pos.claimed);
        }
        const claimed = claims.filter(Boolean).length;
        console.log(`    Claimed: ${claimed} / ${users.length}`);

        if (claimed >= users.length) {
          allClaimed = true;
          console.log(`\n  ✓ All positions claimed via callbacks!`);
          break;
        }
      } catch {
        // not ready
      }
    }

    if (!allClaimed) {
      console.log(`  ℹ Not all callbacks received. Reading current state...`);
    }

    // Read final state with per-user payout detail
    const resolvedMarket: any = await program.account.market.fetch(marketPda);
    const payoutRatio = Number(resolvedMarket.payoutRatio.toString());
    const revealedPools = [0, 1, 2, 3].map((i) =>
      Number(resolvedMarket[`revealedPool${i}`].toString()),
    );

    console.log(`\n  ── Final Position States ──`);
    for (let i = 0; i < 4; i++) {
      console.log(
        `  ${CANDIDATES[i]} pool (revealed): ${fmtUsdc(revealedPools[i])} USDC`,
      );
    }
    console.log(
      `  Payout ratio:  ${payoutRatio} (×${(payoutRatio / 1e9).toFixed(4)})`,
    );
    console.log(``);
    console.log(
      `  ${"Name".padEnd(8)} | ${"Outcome".padEnd(9)} | ${"Bet".padEnd(
        8,
      )} | ${"Net Bet".padEnd(9)} | ${"entry_odds".padEnd(
        12,
      )} | ${"Payout".padEnd(9)} | ${"P&L".padEnd(9)} | claimed`,
    );
    console.log(`  ${"─".repeat(96)}`);

    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      const pos: any = await program.account.encryptedPosition
        .fetch(u.positionPda)
        .catch(() => null);
      const tokenBal = await getAccount(connection, u.usdcAccount);

      const pFee = Math.floor((u.betAmount * PROTOCOL_FEE_BPS) / 10_000);
      const lpFee = Math.floor((u.betAmount * LP_FEE_BPS) / 10_000);
      const netBet = u.betAmount - pFee - lpFee;
      const isWinner = u.outcome === resolvedMarket.outcome;

      const expected = isWinner ? expectedPayout(netBet, payoutRatio) : 0;
      const actualBalance = Number(tokenBal.amount);
      const pnl = actualBalance - u.betAmount;

      const entryOdds = pos ? pos.entryOdds.toString() : "?";
      const claimed = pos ? pos.claimed.toString() : "?";

      console.log(
        `  ${u.name.padEnd(8)} | ${CANDIDATES[u.outcome].padEnd(9)} | ` +
          `${fmtUsdc(u.betAmount).padEnd(8)} | ${fmtUsdc(netBet).padEnd(
            9,
          )} | ` +
          `${entryOdds.padEnd(12)} | ${fmtUsdc(expected).padEnd(9)} | ` +
          `${(pnl >= 0 ? "+" : "-") + fmtUsdc(Math.abs(pnl))} | ${claimed}`,
      );
    }

    // ── Protocol & Creator earnings summary ──────────────────────────────────
    const totalProtocolFees = users.reduce(
      (s, u) => s + Math.floor((u.betAmount * PROTOCOL_FEE_BPS) / 10_000),
      0,
    );
    const totalLpFees = users.reduce(
      (s, u) => s + Math.floor((u.betAmount * LP_FEE_BPS) / 10_000),
      0,
    );
    // LP fees accumulate in market.accumulated_lp_fees (lp_position.fees_earned is unused)
    const lpFeesOnChain = Number(resolvedMarket.accumulatedLpFees.toString());

    const treasuryBal = await getAccount(connection, treasury).catch(
      () => null,
    );
    const treasuryBalance = treasuryBal ? Number(treasuryBal.amount) : 0;

    const vaultAfter = await getAccount(connection, marketVaultPda);

    console.log(`\n  ── Financial Summary ──`);
    console.log(
      `  Winning outcome:       ${CANDIDATES[resolvedMarket.outcome]}`,
    );
    for (let i = 0; i < 4; i++) {
      console.log(
        `  ${CANDIDATES[i]} pool (net):         ${fmtUsdc(
          revealedPools[i],
        )} USDC`,
      );
    }
    console.log(
      `  Total bets volume:     ${fmtUsdc(
        users.reduce((s, u) => s + u.betAmount, 0),
      )} USDC`,
    );
    console.log(
      `  Protocol fees (0.5%):  ${fmtUsdc(
        totalProtocolFees,
      )} USDC  →  treasury`,
    );
    console.log(
      `  LP fees (1.5%):        ${fmtUsdc(lpFeesOnChain)} USDC  →  creator`,
    );
    console.log(
      `  Creator bond:          ${fmtUsdc(CREATOR_BOND)} USDC  →  creator`,
    );
    console.log(
      `  Creator earnings total: ${fmtUsdc(CREATOR_BOND + lpFeesOnChain)} USDC`,
    );
    console.log(`  Protocol earnings:     ${fmtUsdc(treasuryBalance)} USDC`);
    console.log(`  Vault balance after:   ${fmtUsdc(vaultAfter.amount)} USDC`);
    console.log(`\n  ✓ Steps 5+6 complete.`);
  });

  // ── Step 7: Creator Withdraws ─────────────────────────────────────────────

  it("Step 7: creator withdraws bond + LP fees", async () => {
    console.log("\n═══════════════════════════════════════════════");
    console.log("  STEP 7: CREATOR WITHDRAW FUNDS");
    console.log("═══════════════════════════════════════════════\n");

    const marketState: any = await program.account.market.fetch(marketPda);

    if (marketState.state !== 2) {
      console.log(
        `  ℹ Market not resolved (state=${marketState.state}). Skipping withdraw.`,
      );
      return;
    }

    console.assert(
      !marketState.bondWithdrawn,
      "Bond should not be withdrawn yet",
    );
    console.log(`  Bond already withdrawn: ${marketState.bondWithdrawn}`);

    const lpFeesPending = Number(marketState.accumulatedLpFees.toString());
    console.log(`  LP fees accumulated: ${fmtUsdc(lpFeesPending)} USDC`);
    console.log(`  Bond: ${fmtUsdc(marketState.creatorBond)} USDC`);
    console.log(
      `  Total to withdraw: ${fmtUsdc(
        Number(marketState.creatorBond) + lpFeesPending,
      )} USDC`,
    );

    const creatorBalBefore = await getAccount(connection, creatorTokenAccount);
    const vaultBefore = await getAccount(connection, marketVaultPda);
    console.log(`\n  Creator USDC before: ${fmtUsdc(creatorBalBefore.amount)}`);
    console.log(`  Vault before:        ${fmtUsdc(vaultBefore.amount)}`);

    try {
      const sig = await program.methods
        .withdrawCreatorFunds()
        .accountsPartial({
          creator: payer.publicKey,
          market: marketPda,
          lpPosition: lpPositionPda,
          marketVault: marketVaultPda,
          creatorTokenAccount: creatorTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });

      console.log(`  ✓ withdraw_creator_funds: ${sig}`);

      const creatorBalAfter = await getAccount(connection, creatorTokenAccount);
      const vaultAfter = await getAccount(connection, marketVaultPda);
      const marketAfter: any = await program.account.market.fetch(marketPda);
      const lpPosAfter: any = await program.account.lpPosition.fetch(
        lpPositionPda,
      );

      console.log(
        `\n  Creator USDC after:  ${fmtUsdc(creatorBalAfter.amount)}`,
      );
      console.log(`  Vault after:         ${fmtUsdc(vaultAfter.amount)}`);
      console.log(`  Bond withdrawn:      ${marketAfter.bondWithdrawn}`);
      console.log(`  LP fees claimed:     ${lpPosAfter.feesClaimed}`);

      console.assert(
        Number(creatorBalAfter.amount) > Number(creatorBalBefore.amount),
        "Creator should have more USDC after withdrawal",
      );
      console.log(`  ✓ Bond + LP fees successfully withdrawn`);
    } catch (e: any) {
      console.log(`  ✗ FAILED: ${e.message}`);
    }

    console.log(`\n  ✓ Step 7 complete.`);
  });

  // ── Final Summary ─────────────────────────────────────────────────────────

  after(async () => {
    console.log("\n═══════════════════════════════════════════════");
    console.log("  MULTI-OUTCOME E2E TEST SUMMARY");
    console.log("═══════════════════════════════════════════════\n");

    try {
      const market: any = await program.account.market.fetch(marketPda);
      const q = String.fromCharCode(
        ...market.question.slice(0, market.questionLen),
      );
      const vault = await getAccount(connection, marketVaultPda);

      console.log(`  Market:       "${q}"`);
      console.log(
        `  State:        ${
          ["Active", "Closed", "Resolved", "Unresolved"][market.state] ??
          market.state
        }`,
      );
      console.log(
        `  Outcome:      ${market.outcome} (${
          CANDIDATES[market.outcome] ?? "?"
        })`,
      );
      console.log(`  Total bets:   ${market.totalBetsCount.toString()}`);
      for (let i = 0; i < 4; i++) {
        console.log(
          `  ${CANDIDATES[i]} pool: ${fmtUsdc(
            market[`revealedPool${i}`],
          )} USDC`,
        );
      }
      console.log(`  Payout ratio: ${market.payoutRatio.toString()}`);
      console.log(`  Vault:        ${fmtUsdc(vault.amount)} USDC`);
      console.log(`  Bond w/drawn: ${market.bondWithdrawn}`);

      console.log(`\n  ── User PnL ──`);
      for (let i = 0; i < users.length; i++) {
        const u = users[i];
        const pos = await program.account.encryptedPosition
          .fetch(u.positionPda)
          .catch(() => null);
        const bal = await getAccount(connection, u.usdcAccount);
        const pnl = Number(bal.amount) - u.betAmount;
        console.log(
          `  ${u.name.padEnd(8)} (${CANDIDATES[u.outcome].padEnd(5)}): ` +
            `bet=${fmtUsdc(u.betAmount)} | balance=${fmtUsdc(bal.amount)} | ` +
            `pnl=${pnl >= 0 ? "+" : "-"}${fmtUsdc(Math.abs(pnl))} | ` +
            `claimed=${pos?.claimed ?? "?"}`,
        );
      }

      const lpPos = await program.account.lpPosition
        .fetch(lpPositionPda)
        .catch(() => null);
      const totalLpFees = users.reduce(
        (s, u) => s + Math.floor((u.betAmount * LP_FEE_BPS) / 10_000),
        0,
      );
      const totalProtocolFees = users.reduce(
        (s, u) => s + Math.floor((u.betAmount * PROTOCOL_FEE_BPS) / 10_000),
        0,
      );
      const pools = [0, 1, 2, 3].map((i) =>
        Number((market[`revealedPool${i}`] as any)?.toString() || "0"),
      );
      const winPool = pools[market.outcome] ?? pools[0];
      const totalNetPool = pools.reduce((s, v) => s + v, 0);

      const expectedRatio =
        totalNetPool > 0 && winPool > 0
          ? Math.floor((totalNetPool * 1e9) / winPool)
          : 0;

      console.log(`\n  ── Expected vs Actual ──`);
      console.log(
        `  Winning pool (${CANDIDATES[market.outcome]}): ${fmtUsdc(
          winPool,
        )} USDC`,
      );
      console.log(`  Total net pool:       ${fmtUsdc(totalNetPool)} USDC`);
      console.log(`  Expected ratio:       ${expectedRatio}`);
      console.log(`  Actual ratio:         ${market.payoutRatio.toString()}`);

      const actualLpFees = Number(market.accumulatedLpFees.toString());
      if (lpPos) {
        console.log(
          `\n  Creator LP fees earned:  ${fmtUsdc(
            actualLpFees,
          )} USDC  (from market.accumulated_lp_fees)`,
        );
        console.log(`  Creator bond:            ${fmtUsdc(CREATOR_BOND)} USDC`);
        console.log(
          `  Creator total earnings:  ${fmtUsdc(
            actualLpFees + CREATOR_BOND,
          )} USDC`,
        );
        console.log(`  LP fees claimed:         ${lpPos.feesClaimed}`);
        console.log(
          `  LP fees claimed amt:     ${fmtUsdc(lpPos.feesClaimedAmount)} USDC`,
        );
      } else {
        console.log(
          `\n  Creator LP fees (expected): ${fmtUsdc(totalLpFees)} USDC`,
        );
      }
      const treasuryBal = await getAccount(connection, treasury).catch(
        () => null,
      );
      console.log(
        `\n  Protocol earnings (treasury): ${fmtUsdc(
          treasuryBal ? treasuryBal.amount : BigInt(totalProtocolFees),
        )} USDC`,
      );
    } catch (e: any) {
      console.log(`  Could not fetch final state: ${e.message}`);
    }

    console.log(`\n═══════════════════════════════════════════════`);
    console.log("  ✓ MULTI-OUTCOME E2E TEST COMPLETE");
    console.log("═══════════════════════════════════════════════\n");
  });
});

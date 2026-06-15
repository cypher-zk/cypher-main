// Devnet multi-outcome market end-to-end test.
//
//   yarn devnet:multi
//
// Creates 10 fresh keypairs:
//   • players[0]  = Alice  — market creator (pays 10 USDC bond)
//   • players[1-9]= bettors — spread across 4 outcomes (Trump/JFK/Madison/Obama)
//
// The admin wallet (~/.config/solana/id.json) handles:
//   • GlobalState initialisation (once)
//   • Comp-def registration        (once, idempotent)
//   • USDC mint authority          (mints USDC to each player)

import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  createAccount,
  createMint,
  mintTo,
} from "@solana/spl-token";
import {
  getArciumProgramId,
  getArciumProgram,
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
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";

// ── Config ─────────────────────────────────────────────────────────────────────

const PROGRAM_ID   = new PublicKey("cyphPe923pnPGVXJL3a3P7t2W9mJsagBcg1oeauoh2B");
const ARCIUM_PROG  = getArciumProgramId();
const CLUSTER_OFF  = parseInt(process.env.ARCIUM_CLUSTER_OFFSET ?? "456");
const RPC_URL      = process.env.RPC_URL ??
  "https://devnet.helius-rpc.com/?api-key=8c79234f-3452-457b-96e3-171b70c0cfd4";
const KEYPAIR_PATH = process.env.KEYPAIR_PATH ?? `${os.homedir()}/.config/solana/id.json`;

// ── Token mint ─────────────────────────────────────────────────────────────────
// Devnet: a fresh regular SPL Token mint is created each run (program requires
//         standard Token program, not Token2022).
// Mainnet: set ACCEPTED_MINT to USDC and use `transfer` from admin instead of `mintTo`.
//   mainnet USDC →  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

// ── Constants ──────────────────────────────────────────────────────────────────

const SIGN_SEED     = Buffer.from("ArciumSignerAccount");
const CREATOR_BOND  = 10_000_000;  // 10 USDC
const PROTOCOL_FEE  = 50;          // bps
const LP_FEE        = 150;         // bps
const DECIMALS      = 6;
const CB_TIMEOUT_MS = 240_000;     // 4 min per computation on devnet
const NUM_OUTCOMES  = 4;
const WIN_OUTCOME   = 0;           // Trump wins

const CANDIDATES    = ["Trump", "JFK", "Madison", "Obama"] as const;

// 10 players: 1 creator + 9 bettors across 4 outcomes
// outcome: 0=Trump  1=JFK  2=Madison  3=Obama
const PLAYERS = [
  { name: "Alice",    role: "creator", outcome: -1, usdc: CREATOR_BOND + 1_000_000 },
  { name: "Donovan",  role: "bettor",  outcome: 0,  usdc: 20_000_000 },  // Trump  (WINNER)
  { name: "Liberty",  role: "bettor",  outcome: 1,  usdc:  5_000_000 },  // JFK    (loser)
  { name: "Magnus",   role: "bettor",  outcome: 0,  usdc: 12_000_000 },  // Trump  (WINNER)
  { name: "Fenwick",  role: "bettor",  outcome: 2,  usdc: 15_000_000 },  // Madison(loser)
  { name: "Harmony",  role: "bettor",  outcome: 3,  usdc:  8_000_000 },  // Obama  (loser)
  { name: "Turbo",    role: "bettor",  outcome: 0,  usdc: 10_000_000 },  // Trump  (WINNER)
  { name: "Juliette", role: "bettor",  outcome: 1,  usdc:  6_000_000 },  // JFK    (loser)
  { name: "Kasper",   role: "bettor",  outcome: 2,  usdc:  9_000_000 },  // Madison(loser)
  { name: "Selene",   role: "bettor",  outcome: 3,  usdc:  7_000_000 },  // Obama  (loser)
] as const;

const COMP_DEFS = [
  { circuit: "place_private_bet_multi",     method: "initPlaceBetMultiCompDef" },
  { circuit: "reveal_market_outcome_multi", method: "initRevealMultiCompDef"   },
  { circuit: "compute_multi_payout",        method: "initPayoutMultiCompDef"   },
  { circuit: "compute_multi_refund",        method: "initRefundMultiCompDef"   },
] as const;

// ── Types ──────────────────────────────────────────────────────────────────────

interface Player {
  name:         string;
  keypair:      Keypair;
  tokenAccount: PublicKey;
  outcome:      number;    // -1 = creator
  usdc:         number;
}

// ── PDA helpers ────────────────────────────────────────────────────────────────

const pda = (seeds: Buffer[]) =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

const globalStatePda = () => pda([Buffer.from("global_state")]);

const marketPda = (id: BN) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(id.toString()));
  return pda([Buffer.from("market"), b]);
};

const vaultPda   = (mkt: PublicKey) => pda([Buffer.from("market_vault"), mkt.toBuffer()]);
const lpPosPda   = (mkt: PublicKey, c: PublicKey) =>
  pda([Buffer.from("lp-position"), mkt.toBuffer(), c.toBuffer()]);
const positionPda = (mkt: PublicKey, u: PublicKey) =>
  pda([Buffer.from("position"), mkt.toBuffer(), u.toBuffer()]);
const signPda    = () => pda([SIGN_SEED]);

// ── Helpers ────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt   = (n: number | bigint) => (Number(n) / 10 ** DECIMALS).toFixed(2);
const net   = (n: number) => n - Math.floor((n * PROTOCOL_FEE) / 10_000) - Math.floor((n * LP_FEE) / 10_000);

async function waitUntil(ts: number) {
  const secs = ts - Math.floor(Date.now() / 1000);
  if (secs <= 0) return;
  console.log(`  ⏳ waiting ${secs}s for market close...`);
  await sleep(secs * 1000);
}

async function waitMXE(provider: anchor.AnchorProvider): Promise<Uint8Array> {
  const deadline = Date.now() + CB_TIMEOUT_MS;
  process.stdout.write("  ⏳ waiting for MXE keys");
  while (Date.now() < deadline) {
    try {
      const k = await getMXEPublicKey(provider, PROGRAM_ID);
      if (k) { console.log(" ✓"); return k; }
    } catch {}
    await sleep(4_000);
    process.stdout.write(".");
  }
  throw new Error("MXE keys never became available");
}

function encrypt(netAmt: number, side: number, mxeKey: Uint8Array) {
  const priv   = crypto.getRandomValues(new Uint8Array(32));
  const pub    = x25519.getPublicKey(priv);
  const secret = x25519.getSharedSecret(priv, mxeKey);
  const cipher = new RescueCipher(secret);
  const nonce  = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const enc = cipher.encrypt([BigInt(netAmt), BigInt(side)], nonce);
  return { encAmt: enc[0], encSide: enc[1], pubKey: Array.from(pub),
           nonce: new BN(deserializeLE(nonce).toString()) };
}

// ── Create & fund 10 players ───────────────────────────────────────────────────

async function createPlayers(
  connection: Connection,
  admin: Keypair,
  mint: PublicKey,
): Promise<Player[]> {
  console.log("\n  ┌──────────┬───────────────┬──────────────────────────────────────┐");
  console.log("  │ Name     │ Bet on        │ Wallet (first 12 chars)              │");
  console.log("  ├──────────┼───────────────┼──────────────────────────────────────┤");

  const players: Player[] = [];

  for (const cfg of PLAYERS) {
    const keypair = Keypair.generate();
    // Admin (Anchor provider) pays all tx fees — players need no SOL airdrop.
    const tokenAccount = await createAccount(
      connection, admin, mint, keypair.publicKey, Keypair.generate(),
    );
    await mintTo(connection, admin, mint, tokenAccount, admin, cfg.usdc);

    const candidate = cfg.outcome === -1 ? "creator" : CANDIDATES[cfg.outcome];
    const winner    = cfg.outcome === WIN_OUTCOME ? " ← winner" : "";
    console.log(
      `  │ ${cfg.name.padEnd(8)} │ ${(candidate + winner).padEnd(13)} │ ` +
      `${keypair.publicKey.toBase58().slice(0, 12)}... (${fmt(cfg.usdc)} USDC) │`,
    );
    players.push({ name: cfg.name, keypair, tokenAccount, outcome: cfg.outcome, usdc: cfg.usdc });
  }

  console.log("  └──────────┴───────────────┴──────────────────────────────────────┘");
  return players;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const admin = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR_PATH).toString())),
  );
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = {
    publicKey:           admin.publicKey,
    signTransaction:     async (tx: any) => { tx.partialSign(admin); return tx; },
    signAllTransactions: async (txs: any[]) => { txs.forEach((t) => t.partialSign(admin)); return txs; },
  };
  const provider = new anchor.AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const rawIdl = JSON.parse(fs.readFileSync("target/idl/cypher.json", "utf-8"));
  const program = new anchor.Program(rawIdl, provider) as any;
  const arcProg = getArciumProgram(provider);

  console.log("\n╔═══════════════════════════════════════════════════════════════╗");
  console.log("║         DEVNET MULTI-OUTCOME MARKET — 10-WALLET E2E          ║");
  console.log("╠═══════════════════════════════════════════════════════════════╣");
  console.log(`║  Admin:         ${admin.publicKey.toBase58().slice(0, 44)} ║`);
  console.log(`║  Program:       ${PROGRAM_ID.toBase58().slice(0, 44)} ║`);
  console.log(`║  Cluster offset: ${String(CLUSTER_OFF).padEnd(43)} ║`);
  console.log(`║  Outcomes:      ${CANDIDATES.join(" | ").padEnd(44)} ║`);
  console.log(`║  Winning:       ${CANDIDATES[WIN_OUTCOME].padEnd(44)} ║`);
  console.log("╚═══════════════════════════════════════════════════════════════╝");

  // ── STEP 1: GlobalState + comp defs ─────────────────────────────────────────
  console.log("\n▶  STEP 1  GlobalState + comp defs");
  console.log("   ─────────────────────────────────");

  // Create a fresh regular SPL Token mint for this test run.
  const mint = await createMint(
    connection, admin, admin.publicKey, null, DECIMALS,
  );
  console.log(`   Fresh mint: ${mint.toBase58()}`);

  const gsPda = globalStatePda();
  let treasury: PublicKey;

  const existing = await connection.getAccountInfo(gsPda);
  if (!existing) {
    const tKp = Keypair.generate();
    treasury = await createAccount(connection, admin, mint, admin.publicKey, tKp);
    const sig = await program.methods.initialize(PROTOCOL_FEE, LP_FEE)
      .accountsPartial({
        admin: admin.publicKey, globalState: gsPda,
        protocolTreasury: treasury, acceptedMint: mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });
    console.log(`   ✓ initialize: ${sig}`);
  } else {
    // Always update GlobalState mint to this run's fresh mint
    const tKp = Keypair.generate();
    treasury = await createAccount(connection, admin, mint, admin.publicKey, tKp);
    const sig = await program.methods.updateAcceptedMint()
      .accountsPartial({
        admin: admin.publicKey, globalState: gsPda,
        newMint: mint, newTreasury: treasury,
      })
      .rpc({ commitment: "confirmed" });
    console.log(`   ✓ update_accepted_mint: ${sig}`);
  }
  console.log(`   Mint:     ${mint.toBase58()}`);
  console.log(`   Treasury: ${treasury!.toBase58().slice(0,12)}...`);

  const mxeAddr = getMXEAccAddress(PROGRAM_ID);
  const mxeData = await (arcProg.account as any).mxeAccount.fetch(mxeAddr);
  const lut     = getLookupTableAddress(PROGRAM_ID, mxeData.lutOffsetSlot);

  for (const cd of COMP_DEFS) {
    const compDefPda = getCompDefAccAddress(
      PROGRAM_ID, Buffer.from(getCompDefAccOffset(cd.circuit)).readUInt32LE(),
    );
    try {
      const sig = await (program.methods as any)[cd.method]()
        .accountsPartial({ payer: admin.publicKey, mxeAccount: mxeAddr,
          compDefAccount: compDefPda, addressLookupTable: lut })
        .signers([admin])
        .rpc({ commitment: "confirmed" });
      console.log(`   ✓ ${cd.circuit.padEnd(32)} ${sig.slice(0,8)}...`);
    } catch (e: any) {
      const m = e.message as string;
      if (m.includes("already in use") || m.includes("already initialized")) {
        console.log(`   ℹ ${cd.circuit.padEnd(32)} already registered`);
      } else throw e;
    }
    await sleep(400);
  }

  // ── Fund 10 players ─────────────────────────────────────────────────────────
  const players = await createPlayers(connection, admin, mint);
  const creator  = players[0];
  const bettors  = players.slice(1);

  // ── STEP 2: Create market ───────────────────────────────────────────────────
  console.log("\n▶  STEP 2  Create multi-outcome market");
  console.log("   ─────────────────────────────────");

  // Alice is the creator and on-chain payer for market/vault/lpPos account rent.
  // She was only funded with USDC, so we transfer 0.02 SOL from admin first.
  {
    const { Transaction } = await import("@solana/web3.js");
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey:   creator.keypair.publicKey,
        lamports:   20_000_000, // 0.02 SOL
      }),
    );
    await provider.sendAndConfirm(tx, [admin]);
    console.log(`   ✓ funded Alice with 0.02 SOL for account rent`);
  }

  const gs2: any  = await program.account.globalState.fetch(gsPda);
  const mktId     = gs2.marketCounter as BN;
  const mkt       = marketPda(mktId);
  const vault     = vaultPda(mkt);
  const lpPos     = lpPosPda(mkt, creator.keypair.publicKey);
  const closeTime = Math.floor(Date.now() / 1000) + 75;

  const question = "Who will win the 2028 US presidential election?";
  const createSig = await program.methods
    .createMarketMulti(question, new BN(closeTime), 1, NUM_OUTCOMES)
    .accountsPartial({
      creator:             creator.keypair.publicKey,
      globalState:         gsPda,
      market:              mkt,
      lpPosition:          lpPos,
      marketVault:         vault,
      creatorTokenAccount: creator.tokenAccount,
      acceptedMint:        mint,
      tokenProgram:        TOKEN_PROGRAM_ID,
      systemProgram:       SystemProgram.programId,
    })
    .signers([creator.keypair])
    .rpc({ commitment: "confirmed" });

  console.log(`   ✓ create_market_multi by Alice: ${createSig}`);
  console.log(`   Market PDA:  ${mkt.toBase58()}`);
  console.log(`   Outcomes:    ${CANDIDATES.join(" | ")}`);
  console.log(`   Close time:  +${closeTime - Math.floor(Date.now()/1000)}s from now`);
  const vBal = await getAccount(connection, vault);
  console.log(`   Vault:       ${fmt(vBal.amount)} USDC (creator bond locked)`);

  // ── STEP 3: Place bets ─────────────────────────────────────────────────────
  console.log("\n▶  STEP 3  Place private bets  (9 bettors, sequential)");
  console.log("   ─────────────────────────────────");
  console.log(`   ${"Name".padEnd(9)} ${"Outcome".padEnd(9)} ${"Bet".padEnd(9)} ${"Net".padEnd(9)} Status`);
  console.log(`   ${"─".repeat(70)}`);

  const mxeKey = await waitMXE(provider);

  for (let i = 0; i < bettors.length; i++) {
    const u      = bettors[i];
    const netAmt = net(u.usdc);
    const offset = new BN(Date.now() + i * 200);
    const { encAmt, encSide, pubKey, nonce } = encrypt(netAmt, u.outcome, mxeKey);
    const candLabel = CANDIDATES[u.outcome];

    process.stdout.write(`   ${u.name.padEnd(9)} ${candLabel.padEnd(9)} ${fmt(u.usdc).padEnd(9)} ${fmt(netAmt).padEnd(9)}`);

    try {
      await (program.methods as any)
        .placePrivateBetMulti(offset, new BN(u.usdc), encAmt, encSide, pubKey, nonce)
        .accountsPartial({
          payer:               admin.publicKey,
          signPdaAccount:      signPda(),
          mxeAccount:          getMXEAccAddress(PROGRAM_ID),
          mempoolAccount:      getMempoolAccAddress(CLUSTER_OFF),
          executingPool:       getExecutingPoolAccAddress(CLUSTER_OFF),
          computationAccount:  getComputationAccAddress(CLUSTER_OFF, offset as any),
          compDefAccount:      getCompDefAccAddress(PROGRAM_ID,
            Buffer.from(getCompDefAccOffset("place_private_bet_multi")).readUInt32LE()),
          clusterAccount:      getClusterAccAddress(CLUSTER_OFF),
          poolAccount:         getFeePoolAccAddress(),
          clockAccount:        getClockAccAddress(),
          systemProgram:       SystemProgram.programId,
          arciumProgram:       ARCIUM_PROG,
          user:                u.keypair.publicKey,
          globalState:         gsPda,
          market:              mkt,
          marketVault:         vault,
          userTokenAccount:    u.tokenAccount,
          protocolTreasury:    treasury,
          position:            positionPda(mkt, u.keypair.publicKey),
          tokenProgram:        TOKEN_PROGRAM_ID,
        })
        .signers([u.keypair])
        .rpc({ commitment: "confirmed" });

      await awaitComputationFinalization(provider, offset, PROGRAM_ID, "confirmed", CB_TIMEOUT_MS);

      for (let t = 0; t < 30; t++) {
        const m: any = await program.account.market.fetch(mkt);
        if (Number(m.totalBetsCount.toString()) >= i + 1) break;
        await sleep(400);
      }
      const pos: any = await program.account.encryptedPosition.fetch(
        positionPda(mkt, u.keypair.publicKey),
      );
      const mktSnap: any = await program.account.market.fetch(mkt);
      const pools = CANDIDATES.map((_, j) => fmt(mktSnap[`revealedPool${j}`])).join(" | ");
      console.log(`✓  odds=${pos.entryOdds}  pools=[${pools}]`);
    } catch (e: any) {
      console.log(`✗  ${(e.message as string).slice(0, 60)}`);
    }
  }

  const mktMid: any = await program.account.market.fetch(mkt);
  console.log(`\n   Bets on-chain: ${mktMid.totalBetsCount} / ${bettors.length}`);
  for (let j = 0; j < NUM_OUTCOMES; j++) {
    console.log(`   ${CANDIDATES[j].padEnd(8)} pool: ${fmt(mktMid[`revealedPool${j}`])} USDC`);
  }

  // ── STEP 4: Resolve ─────────────────────────────────────────────────────────
  console.log(`\n▶  STEP 4  Resolve → ${CANDIDATES[WIN_OUTCOME]} wins`);
  console.log("   ─────────────────────────────────");

  await waitUntil(closeTime + 5);

  const rOffset = new BN(Date.now());
  try {
    const rSig = await (program.methods as any)
      .resolveMarketMulti(rOffset, WIN_OUTCOME)
      .accountsPartial({
        payer:              admin.publicKey,
        signPdaAccount:     signPda(),
        mxeAccount:         getMXEAccAddress(PROGRAM_ID),
        mempoolAccount:     getMempoolAccAddress(CLUSTER_OFF),
        executingPool:      getExecutingPoolAccAddress(CLUSTER_OFF),
        computationAccount: getComputationAccAddress(CLUSTER_OFF, rOffset as any),
        compDefAccount:     getCompDefAccAddress(PROGRAM_ID,
          Buffer.from(getCompDefAccOffset("reveal_market_outcome_multi")).readUInt32LE()),
        clusterAccount:     getClusterAccAddress(CLUSTER_OFF),
        poolAccount:        getFeePoolAccAddress(),
        clockAccount:       getClockAccAddress(),
        systemProgram:      SystemProgram.programId,
        arciumProgram:      ARCIUM_PROG,
        resolver:           creator.keypair.publicKey,
        market:             mkt,
      })
      .signers([creator.keypair])
      .rpc({ commitment: "confirmed" });
    console.log(`   ✓ resolve queued: ${rSig}`);
    const cbSig = await awaitComputationFinalization(provider, rOffset, PROGRAM_ID, "confirmed", CB_TIMEOUT_MS);
    console.log(`   ✓ callback:       ${cbSig}`);
  } catch (e: any) {
    console.log(`   ✗ ${(e.message as string).slice(0, 100)}`);
  }

  const mktR: any = await program.account.market.fetch(mkt);
  console.log(`   State:        ${mktR.state} (2=Resolved)`);
  console.log(`   Outcome:      ${mktR.outcome} (${CANDIDATES[mktR.outcome]} wins)`);
  console.log(`   Payout ratio: ${mktR.payoutRatio}`);

  // ── STEP 5+6: Claims ────────────────────────────────────────────────────────
  console.log("\n▶  STEPS 5+6  Claim payouts");
  console.log("   ─────────────────────────────────");

  if (mktR.state !== 2) {
    console.log("   Market not resolved — skipping.");
  } else {
    console.log(`   ${"Name".padEnd(9)} ${"Bet on".padEnd(9)} ${"Bet".padEnd(9)} Result`);
    console.log(`   ${"─".repeat(60)}`);

    for (let i = 0; i < bettors.length; i++) {
      const u      = bettors[i];
      const cOff   = new BN(Date.now() + i * 200);
      const isWin  = u.outcome === WIN_OUTCOME;

      process.stdout.write(`   ${u.name.padEnd(9)} ${CANDIDATES[u.outcome].padEnd(9)} ${fmt(u.usdc).padEnd(9)}`);

      try {
        await (program.methods as any)
          .claimPayoutMulti(cOff)
          .accountsPartial({
            payer:              admin.publicKey,
            signPdaAccount:     signPda(),
            mxeAccount:         getMXEAccAddress(PROGRAM_ID),
            mempoolAccount:     getMempoolAccAddress(CLUSTER_OFF),
            executingPool:      getExecutingPoolAccAddress(CLUSTER_OFF),
            computationAccount: getComputationAccAddress(CLUSTER_OFF, cOff as any),
            compDefAccount:     getCompDefAccAddress(PROGRAM_ID,
              Buffer.from(getCompDefAccOffset("compute_multi_payout")).readUInt32LE()),
            clusterAccount:     getClusterAccAddress(CLUSTER_OFF),
            poolAccount:        getFeePoolAccAddress(),
            clockAccount:       getClockAccAddress(),
            systemProgram:      SystemProgram.programId,
            arciumProgram:      ARCIUM_PROG,
            user:               u.keypair.publicKey,
            market:             mkt,
            position:           positionPda(mkt, u.keypair.publicKey),
            marketVault:        vault,
            userTokenAccount:   u.tokenAccount,
            tokenProgram:       TOKEN_PROGRAM_ID,
          })
          .signers([u.keypair])
          .rpc({ commitment: "confirmed" });

        await awaitComputationFinalization(provider, cOff, PROGRAM_ID, "confirmed", CB_TIMEOUT_MS);
        const bal = await getAccount(connection, u.tokenAccount);
        const pnl = Number(bal.amount) - u.usdc;
        console.log(
          `${isWin ? "✓ WINNER" : "✗ loser "}  ` +
          `balance=${fmt(bal.amount)} USDC  PnL=${pnl>=0?"+":""}${fmt(Math.abs(pnl))}`,
        );
      } catch (e: any) {
        console.log(`✗ ${(e.message as string).slice(0, 70)}`);
      }
      await sleep(300);
    }
  }

  // ── STEP 7: Creator withdraw ────────────────────────────────────────────────
  console.log("\n▶  STEP 7  Creator (Alice) withdraws bond + LP fees");
  console.log("   ─────────────────────────────────");

  const mktF: any = await program.account.market.fetch(mkt);
  if (mktF.state !== 2) {
    console.log("   Market not resolved — skipping.");
  } else {
    const lpFees = Number(mktF.accumulatedLpFees.toString());
    console.log(`   LP fees: ${fmt(lpFees)} USDC   Bond: ${fmt(CREATOR_BOND)} USDC   Total: ${fmt(CREATOR_BOND + lpFees)} USDC`);
    try {
      const wSig = await program.methods.withdrawCreatorFunds()
        .accountsPartial({
          creator:             creator.keypair.publicKey,
          market:              mkt,
          lpPosition:          lpPos,
          marketVault:         vault,
          creatorTokenAccount: creator.tokenAccount,
          tokenProgram:        TOKEN_PROGRAM_ID,
        })
        .signers([creator.keypair])
        .rpc({ commitment: "confirmed" });
      const bal = await getAccount(connection, creator.tokenAccount);
      console.log(`   ✓ withdraw: ${wSig}`);
      console.log(`   Alice final balance: ${fmt(bal.amount)} USDC`);
    } catch (e: any) {
      console.log(`   ✗ ${(e.message as string).slice(0, 100)}`);
    }
  }

  // ── FINAL SUMMARY ──────────────────────────────────────────────────────────
  console.log("\n╔═══════════════════════════════════════════════════════════════╗");
  console.log("║                       FINAL SUMMARY                          ║");
  console.log("╠═══════════════════════════════════════════════════════════════╣");

  try {
    const final: any = await program.account.market.fetch(mkt);
    const vFinal = await getAccount(connection, vault);
    const state  = ["Active","Closed","Resolved","Unresolved"][final.state] ?? final.state;
    const winner = CANDIDATES[final.outcome] ?? "?";
    console.log(`║  Market:       "${question.slice(0,46)}"  ║`);
    console.log(`║  State:        ${state.padEnd(47)} ║`);
    console.log(`║  Outcome:      ${(winner + " wins").padEnd(47)} ║`);
    console.log(`║  Total bets:   ${String(final.totalBetsCount).padEnd(47)} ║`);
    for (let j = 0; j < NUM_OUTCOMES; j++) {
      const line = `${CANDIDATES[j]} pool: ${fmt(final[`revealedPool${j}`])} USDC`;
      console.log(`║  ${line.padEnd(61)} ║`);
    }
    console.log(`║  Vault left:   ${(fmt(vFinal.amount)+" USDC").padEnd(47)} ║`);
    console.log("╠═══════════════════════════════════════════════════════════════╣");
    console.log(`║  ${"Name".padEnd(9)} ${"Bet on".padEnd(9)} ${"Bet".padEnd(9)} ${"Balance".padEnd(10)} ${"PnL".padEnd(11)} ║`);
    console.log(`║  ${"─".repeat(51)} ║`);

    for (const p of players) {
      const bal    = await getAccount(connection, p.tokenAccount);
      const pnl    = Number(bal.amount) - p.usdc;
      const cand   = p.outcome === -1 ? "creator" : CANDIDATES[p.outcome];
      const pnlStr = (pnl >= 0 ? "+" : "") + fmt(Math.abs(pnl));
      const flag   = p.outcome === WIN_OUTCOME ? " W" : (p.outcome === -1 ? "  " : " L");
      console.log(`║  ${p.name.padEnd(9)} ${(cand+flag).padEnd(9)} ${fmt(p.usdc).padEnd(9)} ${fmt(bal.amount).padEnd(10)} ${pnlStr.padEnd(11)} ║`);
    }

    const tresBal = await getAccount(connection, treasury).catch(() => null);
    console.log("╠═══════════════════════════════════════════════════════════════╣");
    console.log(`║  Protocol treasury:  ${fmt(tresBal ? tresBal.amount : BigInt(0)).padEnd(41)} ║`);
  } catch (e: any) {
    console.log(`║  Could not fetch final state: ${(e.message as string).slice(0,34)} ║`);
  }

  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log("\n✓  DEVNET MULTI-OUTCOME E2E COMPLETE\n");
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

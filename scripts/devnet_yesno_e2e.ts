// Devnet YES/NO market end-to-end test.
//
//   yarn devnet:yesno
//
// Creates 10 fresh keypairs:
//   • players[0]  = Alice  — market creator (pays 10 USDC bond)
//   • players[1-9]= bettors — 5 YES, 4 NO, various amounts
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

const PROGRAM_ID = new PublicKey("cyphPe923pnPGVXJL3a3P7t2W9mJsagBcg1oeauoh2B");
const ARCIUM_PROG = getArciumProgramId();
const CLUSTER_OFF = parseInt(process.env.ARCIUM_CLUSTER_OFFSET ?? "456");
const RPC_URL =
  process.env.RPC_URL ??
  "https://devnet.helius-rpc.com/?api-key=8c79234f-3452-457b-96e3-171b70c0cfd4";
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ?? `${os.homedir()}/.config/solana/id.json`;

// ── Token mint ─────────────────────────────────────────────────────────────────
// Devnet: a fresh regular SPL Token mint is created each run (program requires
//         standard Token program, not Token2022).
// Mainnet: set ACCEPTED_MINT to USDC and use `transfer` from admin instead of `mintTo`.
//   mainnet USDC →  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

// ── Constants ──────────────────────────────────────────────────────────────────

const SIGN_SEED = Buffer.from("ArciumSignerAccount");
const CREATOR_BOND = 10_000_000; // 10 USDC
const PROTOCOL_FEE = 50; // bps
const LP_FEE = 150; // bps
const DECIMALS = 6;
const CB_TIMEOUT_MS = 240_000; // 4 min per computation on devnet

// 10 players: 1 creator + 9 bettors (5 YES, 4 NO)
const PLAYERS = [
  { name: "Alice", role: "creator", side: -1, usdc: CREATOR_BOND + 1_000_000 }, // creator gets bond + extra
  { name: "Bob", role: "bettor", side: 1, usdc: 15_000_000 }, // YES  15 USDC
  { name: "Carol", role: "bettor", side: 1, usdc: 8_000_000 }, // YES   8 USDC
  { name: "Dan", role: "bettor", side: 0, usdc: 25_000_000 }, // NO   25 USDC
  { name: "Eve", role: "bettor", side: 1, usdc: 12_000_000 }, // YES  12 USDC
  { name: "Frank", role: "bettor", side: 0, usdc: 18_000_000 }, // NO   18 USDC
  { name: "Grace", role: "bettor", side: 1, usdc: 6_000_000 }, // YES   6 USDC
  { name: "Henry", role: "bettor", side: 0, usdc: 10_000_000 }, // NO   10 USDC
  { name: "Ivy", role: "bettor", side: 1, usdc: 9_000_000 }, // YES   9 USDC
  { name: "Jack", role: "bettor", side: 0, usdc: 20_000_000 }, // NO   20 USDC
] as const;

const COMP_DEFS = [
  { circuit: "place_private_bet_yesno", method: "initPlaceBetYesnoCompDef" },
  { circuit: "reveal_market_outcome_yesno", method: "initRevealYesnoCompDef" },
  { circuit: "compute_yesno_payout", method: "initPayoutYesnoCompDef" },
  { circuit: "compute_yesno_refund", method: "initRefundYesnoCompDef" },
] as const;

// ── Types ──────────────────────────────────────────────────────────────────────

interface Player {
  name: string;
  keypair: Keypair;
  tokenAccount: PublicKey;
  side: number; // 1=YES  0=NO  -1=creator
  usdc: number;
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

const vaultPda = (mkt: PublicKey) =>
  pda([Buffer.from("market_vault"), mkt.toBuffer()]);
const lpPosPda = (mkt: PublicKey, c: PublicKey) =>
  pda([Buffer.from("lp-position"), mkt.toBuffer(), c.toBuffer()]);
const positionPda = (mkt: PublicKey, u: PublicKey) =>
  pda([Buffer.from("position"), mkt.toBuffer(), u.toBuffer()]);
const signPda = () => pda([SIGN_SEED]);

// ── Helpers ────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (n: number | bigint) => (Number(n) / 10 ** DECIMALS).toFixed(2);
const pct = (n: number) => (n * PROTOCOL_FEE) / 10_000;
const lp = (n: number) => (n * LP_FEE) / 10_000;
const net = (n: number) => n - Math.floor(pct(n)) - Math.floor(lp(n));

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
      if (k) {
        console.log(" ✓");
        return k;
      }
    } catch {}
    await sleep(4_000);
    process.stdout.write(".");
  }
  throw new Error("MXE keys never became available");
}

function encrypt(netAmt: number, side: number, mxeKey: Uint8Array) {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = x25519.getPublicKey(priv);
  const secret = x25519.getSharedSecret(priv, mxeKey);
  const cipher = new RescueCipher(secret);
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const enc = cipher.encrypt([BigInt(netAmt), BigInt(side)], nonce);
  return {
    encAmt: enc[0],
    encSide: enc[1],
    pubKey: Array.from(pub),
    nonce: new BN(deserializeLE(nonce).toString()),
  };
}

// ── Create & fund 10 players ───────────────────────────────────────────────────

async function createPlayers(
  connection: Connection,
  admin: Keypair,
  mint: PublicKey,
): Promise<Player[]> {
  console.log(
    "\n  ┌─────────────────────────────────────────────────────────────┐",
  );
  console.log(
    "  │                   FUNDING 10 PLAYERS                        │",
  );
  console.log(
    "  ├──────────┬──────────┬───────────────────────────────────────┤",
  );
  console.log(
    "  │ Name     │ Role     │ Wallet (first 12 chars)               │",
  );
  console.log(
    "  ├──────────┼──────────┼───────────────────────────────────────┤",
  );

  const players: Player[] = [];

  for (const cfg of PLAYERS) {
    const keypair = Keypair.generate();
    // Admin (Anchor provider) pays all tx fees — players need no SOL airdrop.
    const tokenAccount = await createAccount(
      connection, admin, mint, keypair.publicKey, Keypair.generate(),
    );
    await mintTo(connection, admin, mint, tokenAccount, admin, cfg.usdc);

    const role =
      cfg.role === "creator"
        ? "creator"
        : cfg.side === 1
        ? "YES bettor"
        : "NO  bettor";
    console.log(
      `  │ ${cfg.name.padEnd(8)} │ ${role.padEnd(8)} │ ${keypair.publicKey
        .toBase58()
        .slice(0, 12)}... ` + `(${fmt(cfg.usdc)} USDC) │`,
    );

    players.push({
      name: cfg.name,
      keypair,
      tokenAccount,
      side: cfg.side,
      usdc: cfg.usdc,
    });
  }

  console.log(
    "  └──────────┴──────────┴───────────────────────────────────────┘",
  );
  return players;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // ── Provider (admin wallet) ────────────────────────────────────────────────
  const admin = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR_PATH).toString())),
  );
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = {
    publicKey: admin.publicKey,
    signTransaction: async (tx: any) => {
      tx.partialSign(admin);
      return tx;
    },
    signAllTransactions: async (txs: any[]) => {
      txs.forEach((t) => t.partialSign(admin));
      return txs;
    },
  };
  const provider = new anchor.AnchorProvider(connection, wallet as any, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const rawIdl = JSON.parse(fs.readFileSync("target/idl/cypher.json", "utf-8"));
  const program = new anchor.Program(rawIdl, provider) as any;
  const arcProg = getArciumProgram(provider);

  console.log(
    "\n╔═══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║            DEVNET YES/NO MARKET — 10-WALLET E2E              ║",
  );
  console.log(
    "╠═══════════════════════════════════════════════════════════════╣",
  );
  console.log(`║  Admin:   ${admin.publicKey.toBase58().slice(0, 44)} ║`);
  console.log(`║  Program: ${PROGRAM_ID.toBase58().slice(0, 44)} ║`);
  console.log(`║  Cluster offset: ${String(CLUSTER_OFF).padEnd(38)} ║`);
  console.log(
    "╚═══════════════════════════════════════════════════════════════╝",
  );

  // ── STEP 1: GlobalState + comp defs ─────────────────────────────────────────
  console.log("\n▶  STEP 1  GlobalState + comp defs");
  console.log("   ─────────────────────────────────");

  // Create a fresh regular SPL Token mint for this test run.
  // (The program requires standard Token program; CSDC/USDC on mainnet are also SPL Token.)
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

  // Register comp defs (idempotent)
  const mxeAddr = getMXEAccAddress(PROGRAM_ID);
  const mxeData = await (arcProg.account as any).mxeAccount.fetch(mxeAddr);
  const lut = getLookupTableAddress(PROGRAM_ID, mxeData.lutOffsetSlot);

  for (const cd of COMP_DEFS) {
    const compDefPda = getCompDefAccAddress(
      PROGRAM_ID,
      Buffer.from(getCompDefAccOffset(cd.circuit)).readUInt32LE(),
    );
    try {
      const sig = await (program.methods as any)
        [cd.method]()
        .accountsPartial({
          payer: admin.publicKey,
          mxeAccount: mxeAddr,
          compDefAccount: compDefPda,
          addressLookupTable: lut,
        })
        .signers([admin])
        .rpc({ commitment: "confirmed" });
      console.log(`   ✓ ${cd.circuit.padEnd(32)} ${sig.slice(0, 8)}...`);
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
  const creator = players[0];
  const bettors = players.slice(1); // players 1-9

  // ── STEP 2: Create market ───────────────────────────────────────────────────
  console.log("\n▶  STEP 2  Create market");
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

  const gs2: any = await program.account.globalState.fetch(gsPda);
  const mktId = gs2.marketCounter as BN;
  const mkt = marketPda(mktId);
  const vault = vaultPda(mkt);
  const lpPos = lpPosPda(mkt, creator.keypair.publicKey);
  const closeTime = Math.floor(Date.now() / 1000) + 75;

  const createSig = await program.methods
    .createMarket("Will SOL reach $500 by end of 2025?", new BN(closeTime), 0)
    .accountsPartial({
      creator: creator.keypair.publicKey,
      globalState: gsPda,
      market: mkt,
      lpPosition: lpPos,
      marketVault: vault,
      creatorTokenAccount: creator.tokenAccount,
      acceptedMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([creator.keypair])
    .rpc({ commitment: "confirmed" });

  console.log(`   ✓ create_market by Alice: ${createSig}`);
  console.log(`   Market PDA: ${mkt.toBase58()}`);
  console.log(
    `   Close time: +${closeTime - Math.floor(Date.now() / 1000)}s from now`,
  );
  const vBal = await getAccount(connection, vault);
  console.log(`   Vault:      ${fmt(vBal.amount)} USDC (creator bond locked)`);

  // ── STEP 3: Place bets ─────────────────────────────────────────────────────
  console.log("\n▶  STEP 3  Place private bets  (9 bettors, sequential)");
  console.log("   ─────────────────────────────────");
  console.log(
    `   ${"Name".padEnd(7)} ${"Side".padEnd(4)} ${"Bet".padEnd(
      9,
    )} ${"Net (after fees)".padEnd(18)} Status`,
  );
  console.log(`   ${"─".repeat(65)}`);

  const mxeKey = await waitMXE(provider);

  for (let i = 0; i < bettors.length; i++) {
    const u = bettors[i];
    const netAmt = net(u.usdc);
    const offset = new BN(Date.now() + i * 200);
    const { encAmt, encSide, pubKey, nonce } = encrypt(netAmt, u.side, mxeKey);
    const label = u.side === 1 ? "YES " : "NO  ";

    process.stdout.write(
      `   ${u.name.padEnd(7)} ${label} ${fmt(u.usdc).padEnd(9)} ${fmt(
        netAmt,
      ).padEnd(18)}`,
    );

    try {
      const betSig = await (program.methods as any)
        .placePrivateBetYesno(
          offset,
          new BN(u.usdc),
          encAmt,
          encSide,
          pubKey,
          nonce,
        )
        .accountsPartial({
          payer: admin.publicKey,
          signPdaAccount: signPda(),
          mxeAccount: getMXEAccAddress(PROGRAM_ID),
          mempoolAccount: getMempoolAccAddress(CLUSTER_OFF),
          executingPool: getExecutingPoolAccAddress(CLUSTER_OFF),
          computationAccount: getComputationAccAddress(
            CLUSTER_OFF,
            offset as any,
          ),
          compDefAccount: getCompDefAccAddress(
            PROGRAM_ID,
            Buffer.from(
              getCompDefAccOffset("place_private_bet_yesno"),
            ).readUInt32LE(),
          ),
          clusterAccount: getClusterAccAddress(CLUSTER_OFF),
          poolAccount: getFeePoolAccAddress(),
          clockAccount: getClockAccAddress(),
          systemProgram: SystemProgram.programId,
          arciumProgram: ARCIUM_PROG,
          user: u.keypair.publicKey,
          globalState: gsPda,
          market: mkt,
          marketVault: vault,
          userTokenAccount: u.tokenAccount,
          protocolTreasury: treasury,
          position: positionPda(mkt, u.keypair.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([u.keypair])
        .rpc({ commitment: "confirmed" });

      await awaitComputationFinalization(
        provider,
        offset,
        PROGRAM_ID,
        "confirmed",
        CB_TIMEOUT_MS,
      );

      // wait for on-chain bet count to catch up
      for (let t = 0; t < 30; t++) {
        const m: any = await program.account.market.fetch(mkt);
        if (Number(m.totalBetsCount.toString()) >= i + 1) break;
        await sleep(400);
      }
      const pos: any = await program.account.encryptedPosition.fetch(
        positionPda(mkt, u.keypair.publicKey),
      );
      const mktSnap: any = await program.account.market.fetch(mkt);
      console.log(
        `✓  odds=${pos.entryOdds}  [YES:${fmt(
          mktSnap.revealedPool0,
        )} / NO:${fmt(mktSnap.revealedPool1)}]`,
      );
    } catch (e: any) {
      console.log(`✗  ${(e.message as string).slice(0, 60)}`);
    }
  }

  const mktMid: any = await program.account.market.fetch(mkt);
  console.log(
    `\n   Bets confirmed on-chain: ${mktMid.totalBetsCount} / ${bettors.length}`,
  );
  console.log(`   YES pool: ${fmt(mktMid.revealedPool0)} USDC`);
  console.log(`   NO  pool: ${fmt(mktMid.revealedPool1)} USDC`);

  // ── STEP 4: Resolve (YES wins) ─────────────────────────────────────────────
  console.log("\n▶  STEP 4  Resolve market → YES");
  console.log("   ─────────────────────────────────");

  await waitUntil(closeTime + 5);

  const rOffset = new BN(Date.now());
  try {
    const rSig = await (program.methods as any)
      .resolveMarketYesno(rOffset, 1)
      .accountsPartial({
        payer: admin.publicKey,
        signPdaAccount: signPda(),
        mxeAccount: getMXEAccAddress(PROGRAM_ID),
        mempoolAccount: getMempoolAccAddress(CLUSTER_OFF),
        executingPool: getExecutingPoolAccAddress(CLUSTER_OFF),
        computationAccount: getComputationAccAddress(
          CLUSTER_OFF,
          rOffset as any,
        ),
        compDefAccount: getCompDefAccAddress(
          PROGRAM_ID,
          Buffer.from(
            getCompDefAccOffset("reveal_market_outcome_yesno"),
          ).readUInt32LE(),
        ),
        clusterAccount: getClusterAccAddress(CLUSTER_OFF),
        poolAccount: getFeePoolAccAddress(),
        clockAccount: getClockAccAddress(),
        systemProgram: SystemProgram.programId,
        arciumProgram: ARCIUM_PROG,
        resolver: creator.keypair.publicKey,
        market: mkt,
      })
      .signers([creator.keypair])
      .rpc({ commitment: "confirmed" });
    console.log(`   ✓ resolve queued: ${rSig}`);
    const cbSig = await awaitComputationFinalization(
      provider,
      rOffset,
      PROGRAM_ID,
      "confirmed",
      CB_TIMEOUT_MS,
    );
    console.log(`   ✓ callback:       ${cbSig}`);
  } catch (e: any) {
    console.log(`   ✗ ${(e.message as string).slice(0, 100)}`);
  }

  const mktR: any = await program.account.market.fetch(mkt);
  console.log(`   State:        ${mktR.state} (2=Resolved)`);
  console.log(`   Outcome:      ${mktR.outcome} (1=YES wins)`);
  console.log(`   Payout ratio: ${mktR.payoutRatio}`);

  // ── STEP 5+6: Claims ────────────────────────────────────────────────────────
  console.log("\n▶  STEPS 5+6  Claim payouts");
  console.log("   ─────────────────────────────────");

  if (mktR.state !== 2) {
    console.log("   Market not resolved — skipping.");
  } else {
    console.log(
      `   ${"Name".padEnd(7)} ${"Side".padEnd(4)} ${"Bet".padEnd(
        9,
      )} ${"Result"}`,
    );
    console.log(`   ${"─".repeat(50)}`);

    for (let i = 0; i < bettors.length; i++) {
      const u = bettors[i];
      const cOff = new BN(Date.now() + i * 200);
      const label = u.side === 1 ? "YES " : "NO  ";
      process.stdout.write(
        `   ${u.name.padEnd(7)} ${label} ${fmt(u.usdc).padEnd(9)}`,
      );

      try {
        const claimSig = await (program.methods as any)
          .claimPayoutYesno(cOff)
          .accountsPartial({
            payer: admin.publicKey,
            signPdaAccount: signPda(),
            mxeAccount: getMXEAccAddress(PROGRAM_ID),
            mempoolAccount: getMempoolAccAddress(CLUSTER_OFF),
            executingPool: getExecutingPoolAccAddress(CLUSTER_OFF),
            computationAccount: getComputationAccAddress(
              CLUSTER_OFF,
              cOff as any,
            ),
            compDefAccount: getCompDefAccAddress(
              PROGRAM_ID,
              Buffer.from(
                getCompDefAccOffset("compute_yesno_payout"),
              ).readUInt32LE(),
            ),
            clusterAccount: getClusterAccAddress(CLUSTER_OFF),
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
            systemProgram: SystemProgram.programId,
            arciumProgram: ARCIUM_PROG,
            user: u.keypair.publicKey,
            market: mkt,
            position: positionPda(mkt, u.keypair.publicKey),
            marketVault: vault,
            userTokenAccount: u.tokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([u.keypair])
          .rpc({ commitment: "confirmed" });

        await awaitComputationFinalization(
          provider,
          cOff,
          PROGRAM_ID,
          "confirmed",
          CB_TIMEOUT_MS,
        );
        const bal = await getAccount(connection, u.tokenAccount);
        const pnl = Number(bal.amount) - u.usdc;
        const win = u.side === 1 ? "✓ WINNER" : "✗ loser ";
        console.log(
          `${win}  balance=${fmt(bal.amount)} USDC  PnL=${
            pnl >= 0 ? "+" : ""
          }${fmt(Math.abs(pnl))}`,
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
    console.log(`   LP fees:     ${fmt(lpFees)} USDC`);
    console.log(`   Bond:        ${fmt(CREATOR_BOND)} USDC`);
    console.log(`   Total:       ${fmt(CREATOR_BOND + lpFees)} USDC`);
    try {
      const wSig = await program.methods
        .withdrawCreatorFunds()
        .accountsPartial({
          creator: creator.keypair.publicKey,
          market: mkt,
          lpPosition: lpPos,
          marketVault: vault,
          creatorTokenAccount: creator.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
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
  console.log(
    "\n╔═══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║                       FINAL SUMMARY                          ║",
  );
  console.log(
    "╠═══════════════════════════════════════════════════════════════╣",
  );

  try {
    const final: any = await program.account.market.fetch(mkt);
    const vFinal = await getAccount(connection, vault);
    const state =
      ["Active", "Closed", "Resolved", "Unresolved"][final.state] ??
      final.state;
    console.log(
      `║  Market:       "Will SOL reach $500 by end of 2025?"         ║`,
    );
    console.log(`║  State:        ${state.padEnd(47)} ║`);
    console.log(
      `║  Outcome:      ${(final.outcome === 1 ? "YES wins" : "?").padEnd(
        47,
      )} ║`,
    );
    console.log(
      `║  Total bets:   ${String(final.totalBetsCount).padEnd(47)} ║`,
    );
    console.log(
      `║  YES pool:     ${(fmt(final.revealedPool0) + " USDC").padEnd(47)} ║`,
    );
    console.log(
      `║  NO  pool:     ${(fmt(final.revealedPool1) + " USDC").padEnd(47)} ║`,
    );
    console.log(
      `║  Vault left:   ${(fmt(vFinal.amount) + " USDC").padEnd(47)} ║`,
    );
    console.log(
      "╠═══════════════════════════════════════════════════════════════╣",
    );
    console.log(
      `║  ${"Name".padEnd(7)} ${"Role".padEnd(10)} ${"Bet".padEnd(
        9,
      )} ${"Final Bal".padEnd(10)} ${"PnL".padEnd(11)} ║`,
    );
    console.log(`║  ${"─".repeat(51)} ║`);

    for (const p of players) {
      const bal = await getAccount(connection, p.tokenAccount);
      const pnl = Number(bal.amount) - p.usdc;
      const role =
        p.side === -1 ? "creator" : p.side === 1 ? "YES bettor" : "NO  bettor";
      const pnlStr = (pnl >= 0 ? "+" : "") + fmt(Math.abs(pnl));
      console.log(
        `║  ${p.name.padEnd(7)} ${role.padEnd(10)} ${fmt(p.usdc).padEnd(
          9,
        )} ${fmt(bal.amount).padEnd(10)} ${pnlStr.padEnd(11)} ║`,
      );
    }

    const tresBal = await getAccount(connection, treasury).catch(() => null);
    console.log(
      "╠═══════════════════════════════════════════════════════════════╣",
    );
    console.log(
      `║  Protocol treasury:  ${fmt(
        tresBal ? tresBal.amount : BigInt(0),
      ).padEnd(41)} ║`,
    );
  } catch (e: any) {
    console.log(`║  Could not fetch final state: ${e.message.slice(0, 34)} ║`);
  }

  console.log(
    "╚═══════════════════════════════════════════════════════════════╝",
  );
  console.log("\n✓  DEVNET YES/NO E2E COMPLETE\n");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

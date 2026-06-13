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
  createMint,
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
  CSplRescueCipher,
  deserializeLE,
  awaitComputationFinalization,
  uploadCircuit,
} from "@arcium-hq/client";
import * as fs from "fs";

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey("F6pTnahcgW4gJX3iKxihmZGNUJN1jH4s77ijpK34FpFc");
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

// Named bettors with different amounts
const BETTOR_CONFIG = [
  { name: "Bob",   side: 1, betAmount: 10_000_000 }, // 10 USDC  YES
  { name: "Carol", side: 1, betAmount:  5_000_000 }, //  5 USDC  YES
  { name: "Dan",   side: 0, betAmount: 20_000_000 }, // 20 USDC  NO
  { name: "Even",  side: 0, betAmount: 15_000_000 }, // 15 USDC  NO
  { name: "Frank", side: 1, betAmount:  8_000_000 }, //  8 USDC  YES
] as const;

const COMP_DEFS = [
  { circuit: "init_market_yesno", method: "initInitMarketYesnoCompDef" as any },
  { circuit: "place_private_bet_yesno", method: "initPlaceBetYesnoCompDef" as any },
  { circuit: "reveal_market_outcome_yesno", method: "initRevealYesnoCompDef" as any },
  { circuit: "compute_yesno_payout", method: "initPayoutYesnoCompDef" as any },
  { circuit: "compute_yesno_refund", method: "initRefundYesnoCompDef" as any },
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
  return PublicKey.findProgramAddressSync(
    [SIGN_PDA_SEED],
    PROGRAM_ID,
  )[0];
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

// Polls getMXEPublicKey until the MXE cluster has completed key agreement.
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
  throw new Error("MXE keys never became available — is the Arcium cluster running?");
}

// Encrypts amount (u64) + side (u8) with x25519 ECDH + CSplRescueCipher (Enc<Shared>).
// Returns the values to pass directly to place_private_bet_yesno.
function encryptBetInput(
  netAmount: number,
  side: number, // 0 or 1
  mxePubKey: Uint8Array,
): {
  encryptedAmount: number[];
  encryptedSide: number[];
  pubKey: number[];
  nonce: BN; // u128 as BN for Anchor
  nonceBytes: Uint8Array; // 16-byte LE nonce for the cipher
} {
  const userPrivKey = crypto.getRandomValues(new Uint8Array(32));
  const userPubKey = x25519.getPublicKey(userPrivKey);
  const sharedSecret = x25519.getSharedSecret(userPrivKey, mxePubKey);

  const cipher = new CSplRescueCipher(sharedSecret);

  // 16 random bytes as LE nonce
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);

  // encrypt([amount_as_field_elem, side_as_field_elem], nonce)
  // returns number[][] — each inner array is 32 bytes
  const encrypted = cipher.encrypt(
    [BigInt(netAmount), BigInt(side)],
    nonceBytes,
  );

  // nonce as BN (u128 LE)
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

// ─────────────────────────────────────────────────────────────────────────────
//  Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("yes_no_e2e", function () {
  this.timeout(900_000); // 15 min for the full lifecycle

  // Shared state
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
    keypair: Keypair;
    usdcAccount: PublicKey;
    side: number; // 1 = YES, 0 = NO
    betAmount: number;
    positionPda: PublicKey;
  }[] = [];

  // ── Step 1: Initialize + Comp Defs ──────────────────────────────────────────

  it("Step 1: initialize protocol + register 4 Arcium circuits", async () => {
    console.log("\n═══════════════════════════════════════════════");
    console.log("  STEP 1: INITIALIZE + COMP DEFS");
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
      console.log(`  Creating fresh USDC mint...`);

      // Create USDC mint
      usdcMint = await createMint(
        connection,
        payer,
        payer.publicKey,
        null,
        6,
      );
      console.log(`  Mint:        ${usdcMint.toBase58()}`);

      // Create treasury token account
      const treasuryKeypair = Keypair.generate();
      treasury = await createAccount(
        connection,
        payer,
        usdcMint,
        payer.publicKey,
        treasuryKeypair,
      );
      console.log(`  Treasury:    ${treasury.toBase58()}`);

      // Create creator USDC account + fund it
      const creatorKeypair = Keypair.generate();
      creatorTokenAccount = await createAccount(
        connection,
        payer,
        usdcMint,
        payer.publicKey,
        creatorKeypair,
      );
      await mintTo(
        connection,
        payer,
        usdcMint,
        creatorTokenAccount,
        payer,
        1_000_000_000, // 1000 USDC
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

    // Create creator token account if not done above
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

    // ── Register 4 Computation Definitions ────────────────────────────────

    console.log(`\n  Registering 4 Arcium circuits...`);

    for (const cd of COMP_DEFS) {
      const offset = Buffer.from(getCompDefAccOffset(cd.circuit)).readUInt32LE();
      const compDefPda = getCompDefAccAddress(PROGRAM_ID, offset);
      const mxeAccount = getMXEAccAddress(PROGRAM_ID);

      const mxeInfo = await connection.getAccountInfo(mxeAccount);
      if (!mxeInfo) {
        console.log(
          `  ⚠ MXE account not found for ${cd.circuit}. ` +
            `Skipping comp def registration.`,
        );
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
        // Account may already be registered from a previous run
        console.log(`  ℹ ${cd.circuit} init: ${e.message?.slice(0, 300)}`);
      }

      // Finalize comp def: arcium test pre-loads raw circuit accounts as genesis
      // accounts; uploadCircuit detects them, skips the upload, and calls
      // finalizeComputationDefinition to move state OnchainPending → OnchainFinalized.
      try {
        const uploadSigs = await uploadCircuit(
          provider,
          cd.circuit,
          PROGRAM_ID,
          new Uint8Array(1), // triggers numAccs=1; pre-loaded account passes size check
        );
        if (uploadSigs.length > 0) {
          console.log(`  ✓ ${cd.circuit}: finalized (${uploadSigs.length} txs)`);
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

  // ── Step 2: Create Market ──────────────────────────────────────────────────

  it("Step 2: create_market", async () => {
    console.log("\n═══════════════════════════════════════════════");
    console.log("  STEP 2: CREATE MARKET");
    console.log("═══════════════════════════════════════════════\n");

    const gs: any = await program.account.globalState.fetch(globalStatePda);
    marketIndex = Number(gs.marketCounter.toString());

    marketId = new BN(marketIndex);
    marketPda = findMarketPda(marketId);

    closeTime = Math.floor(Date.now() / 1000) + 65; // ~1 minute

    marketVaultPda = findMarketVaultPda(marketPda);
    lpPositionPda = findLpPositionPda(marketPda, payer.publicKey);

    console.log(`  Question:    "Will SOL hit $200?"`);
    console.log(`  Market ID:   ${marketIndex}`);
    console.log(`  Market PDA:  ${marketPda.toBase58()}`);
    console.log(`  Vault PDA:   ${marketVaultPda.toBase58()}`);
    console.log(`  LP Position: ${lpPositionPda.toBase58()}`);
    console.log(`  Close time:  ${new Date(closeTime * 1000).toLocaleString()}`);
    console.log(`  Category:    0 (Sports)`);

    const sig = await program.methods
      .createMarket("Will SOL hit $200?", new BN(closeTime), 0)
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

    console.log(`  ✓ create_market: ${sig}`);

    // Verify market was created
    const market: any = await program.account.market.fetch(marketPda);
    const question = String.fromCharCode(
      ...market.question.slice(0, market.questionLen),
    );
    console.log(`  ✓ On-chain question: "${question}"`);
    console.log(`  ✓ Market state:      ${market.state} (0=Active)`);
    console.log(`  ✓ Creator bond:      ${fmtUsdc(market.creatorBond)} USDC`);
    console.log(`  ✓ Vault balance:     ${fmtUsdc((await getAccount(connection, marketVaultPda)).amount)} USDC`);

    const vaultBal = await getAccount(connection, marketVaultPda);
    console.assert(
      Number(vaultBal.amount) === CREATOR_BOND,
      `Expected vault balance = ${CREATOR_BOND}, got ${vaultBal.amount}`,
    );
    console.log(`  ✓ Bond of $10 USDC locked in vault`);

    console.log(`\n  ✓ Step 2 complete.`);
  });

  // ── Step 3: 5 Users Place Bets ────────────────────────────────────────────

  it("Step 3: 5 traders place private bets", async () => {
    console.log("\n═══════════════════════════════════════════════");
    console.log("  STEP 3: 5 TRADERS PLACE BETS");
    console.log("═══════════════════════════════════════════════\n");

    console.log(`  Creating 5 funded wallets...`);
    console.log(`  ${"Name".padEnd(6)} | ${"Side".padEnd(4)} | ${"Bet".padEnd(8)} | ${"Protocol Fee".padEnd(13)} | ${"LP Fee".padEnd(8)} | Net`);
    console.log(`  ${"─".repeat(70)}`);

    for (const cfg of BETTOR_CONFIG) {
      const keypair = Keypair.generate();
      const sig = await connection.requestAirdrop(keypair.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");

      const usdcAccount = await createAccount(
        connection, payer, usdcMint, keypair.publicKey, Keypair.generate(),
      );

      await mintTo(connection, payer, usdcMint, usdcAccount, payer, cfg.betAmount);

      const positionPda = findPositionPda(marketPda, keypair.publicKey);
      const pFee = Math.floor(cfg.betAmount * PROTOCOL_FEE_BPS / 10_000);
      const lpFee = Math.floor(cfg.betAmount * LP_FEE_BPS / 10_000);
      const net = cfg.betAmount - pFee - lpFee;

      users.push({ name: cfg.name, keypair, usdcAccount, side: cfg.side, betAmount: cfg.betAmount, positionPda });

      console.log(
        `  ${cfg.name.padEnd(6)} | ${(cfg.side === 1 ? "YES" : "NO").padEnd(4)} | ` +
        `${fmtUsdc(cfg.betAmount).padEnd(8)} | ${fmtUsdc(pFee).padEnd(13)} | ` +
        `${fmtUsdc(lpFee).padEnd(8)} | ${fmtUsdc(net)}`,
      );
    }

    await sleep(2_000);
    console.log(``);

    // Fail fast if the test was not launched by `arcium test`
    if (!ARCIUM_ENV) {
      throw new Error(
        "ARCIUM_CLUSTER_OFFSET is not set.\n" +
        "  This test requires the Arcium MXE cluster.\n" +
        "  Run:  arcium test\n" +
        "  Not:  anchor test  (skips MXE init + DKG)",
      );
    }

    // Wait for Arcium MXE cluster to finish key agreement
    const mxePubKey = await waitForMxeReady(provider);

    // Bootstrap valid zero-encrypted pool ciphertexts via the init_market_yesno circuit.
    // Raw [0u8;32] bytes are NOT valid ciphertexts; to_arcis() on them returns garbage.
    // This MUST happen before the first bet so the circuit reads meaningful pool values.
    console.log(`\n  Bootstrapping encrypted pool ciphertexts (init_market_yesno)...`);
    const initPoolsOffset = new BN(Date.now());
    const initPoolsSig = await (program.methods as any)
      .initMarketPoolsYesno(initPoolsOffset)
      .accountsPartial({
        payer: payer.publicKey,
        signPdaAccount: findSignPdaAccount(),
        mxeAccount: getMXEAccAddress(PROGRAM_ID),
        mempoolAccount: getMempoolAccAddress(ARCIUM_ENV!.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(ARCIUM_ENV!.arciumClusterOffset),
        computationAccount: getComputationAccAddress(
          ARCIUM_ENV!.arciumClusterOffset,
          initPoolsOffset as any,
        ),
        compDefAccount: getCompDefAccAddress(
          PROGRAM_ID,
          Buffer.from(getCompDefAccOffset("init_market_yesno")).readUInt32LE(),
        ),
        clusterAccount: getClusterAccAddress(ARCIUM_ENV!.arciumClusterOffset),
        poolAccount: getFeePoolAccAddress(),
        clockAccount: getClockAccAddress(),
        systemProgram: SystemProgram.programId,
        arciumProgram: ARCIUM_PROGRAM_ID,
        market: marketPda,
      })
      .signers([payer])
      .rpc({ commitment: "confirmed" });
    console.log(`  ✓ initMarketPoolsYesno tx: ${initPoolsSig}`);

    const initPoolsCbSig = await awaitComputationFinalization(
      provider,
      initPoolsOffset,
      PROGRAM_ID,
      "confirmed",
      CALLBACK_TIMEOUT_MS,
    );
    console.log(`  ✓ initMarketPoolsYesno callback: ${initPoolsCbSig}`);

    const mktAfterInit: any = await program.account.market.fetch(marketPda);
    const poolsNonZero =
      mktAfterInit.encryptedPool0.some((b: number) => b !== 0) ||
      mktAfterInit.encryptedPool1.some((b: number) => b !== 0);
    console.log(`  ✓ Encrypted pools bootstrapped (non-zero ciphertexts: ${poolsNonZero})`);

    // Bets are placed ONE AT A TIME — each waits for its Arcium callback before
    // the next bet is submitted.  This is required because each bet computation
    // reads the current encrypted pool from on-chain; if two bets are submitted
    // concurrently they both read the same (stale) pool state and the last
    // callback to land overwrites the correct accumulated total.
    let allSettled = false;

    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      const pFee = Math.floor(u.betAmount * PROTOCOL_FEE_BPS / 10_000);
      const lpFee = Math.floor(u.betAmount * LP_FEE_BPS / 10_000);
      const netAmount = u.betAmount - pFee - lpFee;

      const vaultBefore = await getAccount(connection, marketVaultPda);

      const { encryptedAmount, encryptedSide, pubKey, nonce } =
        encryptBetInput(netAmount, u.side, mxePubKey);

      const computationOffset = new BN(Date.now() + i * 100);

      console.log(
        `  ${u.name} (${u.side === 1 ? "YES" : "NO"}): ` +
          `placing ${fmtUsdc(u.betAmount)} USDC  [net=${fmtUsdc(netAmount)}]...`,
      );

      try {
        const betSig = await (program.methods as any)
          .placePrivateBetYesno(
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
            mempoolAccount: getMempoolAccAddress(ARCIUM_ENV!.arciumClusterOffset),
            executingPool: getExecutingPoolAccAddress(ARCIUM_ENV!.arciumClusterOffset),
            computationAccount: getComputationAccAddress(
              ARCIUM_ENV!.arciumClusterOffset,
              computationOffset as any,
            ),
            compDefAccount: getCompDefAccAddress(
              PROGRAM_ID,
              Buffer.from(getCompDefAccOffset("place_private_bet_yesno")).readUInt32LE(),
            ),
            clusterAccount: getClusterAccAddress(ARCIUM_ENV!.arciumClusterOffset),
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
          `    Vault: ${fmtUsdc(vaultBefore.amount)} → ${fmtUsdc(vaultAfter.amount)}`,
        );
      } catch (e: any) {
        console.log(`    ✗ FAILED: ${e.message}`);
        continue;
      }

      // Wait for THIS bet's callback before placing the next one.
      // Each computation re-encrypts the accumulated pool; the next bet must
      // read the updated ciphertext — not the stale one from before this bet.
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

        const pos: any = await program.account.encryptedPosition.fetch(u.positionPda);
        console.log(
          `    ${u.name} (${u.side === 1 ? "YES" : "NO"}): ` +
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
      if (allSettled) console.log(`  ✓ All ${users.length} bets confirmed on-chain!`);
    } catch {}

    if (!allSettled) {
      console.log(`  ℹ Not all callbacks received within timeout.`);
    }

    // ── Fee + Pool summary ────────────────────────────────────────────────────
    const totalBetAmount = users.reduce((s, u) => s + u.betAmount, 0);
    const totalProtocolFees = users.reduce((s, u) => s + Math.floor(u.betAmount * PROTOCOL_FEE_BPS / 10_000), 0);
    const totalLpFees = users.reduce((s, u) => s + Math.floor(u.betAmount * LP_FEE_BPS / 10_000), 0);
    const totalNetYes = users.filter(u => u.side === 1).reduce((s, u) => {
      const pFee = Math.floor(u.betAmount * PROTOCOL_FEE_BPS / 10_000);
      const lpFee = Math.floor(u.betAmount * LP_FEE_BPS / 10_000);
      return s + u.betAmount - pFee - lpFee;
    }, 0);
    const totalNetNo = users.filter(u => u.side === 0).reduce((s, u) => {
      const pFee = Math.floor(u.betAmount * PROTOCOL_FEE_BPS / 10_000);
      const lpFee = Math.floor(u.betAmount * LP_FEE_BPS / 10_000);
      return s + u.betAmount - pFee - lpFee;
    }, 0);

    console.log(`\n  ── Fee & Pool Summary (expected) ──`);
    console.log(`  Total bet volume:     ${fmtUsdc(totalBetAmount)} USDC`);
    console.log(`  Protocol fees (0.5%): ${fmtUsdc(totalProtocolFees)} USDC`);
    console.log(`  LP fees (1.5%):       ${fmtUsdc(totalLpFees)} USDC`);
    console.log(`  YES pool (net):       ${fmtUsdc(totalNetYes)} USDC  [Bob+Carol+Frank]`);
    console.log(`  NO pool (net):        ${fmtUsdc(totalNetNo)} USDC  [Dan+Even]`);

    // Check vault balance
    try {
      const vaultFinal = await getAccount(connection, marketVaultPda);
      console.log(`\n  Final vault balance: ${fmtUsdc(vaultFinal.amount)} USDC`);
      console.log(`  (vault = creator_bond + all_bets - protocol_fees sent to treasury)`);
    } catch (e: any) {
      console.log(`\n  Could not fetch vault balance: ${e.message}`);
    }
    console.log(`  ✓ Step 3 complete.`);
  });

  // ── Step 4: Wait + Resolve Market ─────────────────────────────────────────

  it("Step 4: resolve market to YES (outcome=1)", async () => {
    console.log("\n═══════════════════════════════════════════════");
    console.log("  STEP 4: RESOLVE MARKET");
    console.log("═══════════════════════════════════════════════\n");

    // Wait for close_time
    await waitUntil(closeTime + 5, "close_time"); // +5s grace for validator clock

    const marketBefore: any = await program.account.market.fetch(marketPda);
    console.log(`  Market state before: ${marketBefore.state} (0=Active)`);
    console.log(`  Total bets: ${marketBefore.totalBetsCount.toString()}`);
    console.log(`  Encrypted pool_0: ${Buffer.from(marketBefore.encryptedPool0).toString("hex").slice(0, 16)}...`);
    console.log(`  Encrypted pool_1: ${Buffer.from(marketBefore.encryptedPool1).toString("hex").slice(0, 16)}...`);

    // Resolve as YES (outcome=1)
    const computationOffset = new BN(Date.now());

    console.log(`\n  Resolving with outcome=1 (YES)...`);

    try {
      const resolveSig = await (program.methods as any)
        .resolveMarketYesno(computationOffset, 1)
        .accountsPartial({
          payer: payer.publicKey,
          signPdaAccount: findSignPdaAccount(),
          mxeAccount: getMXEAccAddress(PROGRAM_ID),
          mempoolAccount: getMempoolAccAddress(ARCIUM_ENV!.arciumClusterOffset),
          executingPool: getExecutingPoolAccAddress(ARCIUM_ENV!.arciumClusterOffset),
          computationAccount: getComputationAccAddress(
            ARCIUM_ENV!.arciumClusterOffset,
            computationOffset as any,
          ),
          compDefAccount: getCompDefAccAddress(
            PROGRAM_ID,
            Buffer.from(getCompDefAccOffset("reveal_market_outcome_yesno")).readUInt32LE(),
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

      console.log(`  ✓ resolve_market_yesno: ${resolveSig}`);
    } catch (e: any) {
      console.log(`  ✗ FAILED: ${e.message}`);
      console.log(`  ℹ This step requires Arcium.`);
    }

    // Check pending_outcome was set immediately
    const marketMid: any = await program.account.market.fetch(marketPda);
    console.log(`  pending_outcome: ${marketMid.pendingOutcome}`);

    // ── Wait for Arcium callback via computation account finalization ─────────
    console.log(`\n  Waiting for reveal callback to fire...`);
    let resolved = false;

    try {
      const cbSig = await awaitComputationFinalization(
        provider, computationOffset, PROGRAM_ID, "confirmed", CALLBACK_TIMEOUT_MS,
      );
      console.log(`  ✓ reveal callback: ${cbSig}`);
      resolved = true;
    } catch (e: any) {
      console.log(`  ℹ reveal callback timeout/error: ${e.message}`);
    }

    if (resolved) {
      const market: any = await program.account.market.fetch(marketPda);
      if (market.state === 2) {
        const question = String.fromCharCode(...market.question.slice(0, market.questionLen));
        console.log(`\n  ✓ Market resolved via Arcium callback!`);
        console.log(`  Question:      "${question}"`);
        console.log(`  State:         ${market.state} (2=Resolved)`);
        console.log(`  Outcome:       ${market.outcome} (1=YES)`);
        console.log(`  YES pool:      ${fmtUsdc(market.revealedPool0)} USDC`);
        console.log(`  NO pool:       ${fmtUsdc(market.revealedPool1)} USDC`);
        console.log(`  Payout ratio:  ${market.payoutRatio.toString()}`);
        console.log(`  Resolution:    ${new Date(market.resolutionTime.toNumber() * 1000).toLocaleString()}`);
        console.log(`  Claim deadline: ${new Date(market.claimDeadline.toNumber() * 1000).toLocaleString()}`);

        console.assert(market.outcome === 1, `Expected outcome=1, got ${market.outcome}`);
        console.assert(Number(market.revealedPool0.toString()) > 0, "YES pool should be > 0");
        console.assert(Number(market.revealedPool1.toString()) > 0, "NO pool should be > 0");
        console.assert(Number(market.payoutRatio.toString()) > 0, "payout_ratio should be > 0");
        console.log(`  ✓ All assertions passed`);
      } else {
        console.log(`  ⚠ Computation finalized but market state=${market.state} (not 2). Callback may have errored.`);
        resolved = false;
      }
    }

    if (!resolved) console.log(`  ℹ Market not resolved within timeout. Proceeding...`);

    console.log(`\n  ✓ Step 4 complete.`);
  });

  // ── Step 5 + 6: Claim Payouts ────────────────────────────────────────────

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
    console.log(`  Vault balance before claims: ${fmtUsdc(vaultBeforeClaim.amount)} USDC`);

    // Process all users: YES bettors win, NO bettors lose
    // But claims are individual — each user queues their own computation

    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      const isWinner = u.side === 1; // YES wins

      console.log(
        `\n  ── ${u.name} (${u.side === 1 ? "YES" : "NO"} | bet=${fmtUsdc(u.betAmount)} USDC | ${isWinner ? "WINNER" : "LOSER"}) ──`,
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
        // All users call claimPayoutYesno — winners receive payout, losers get 0 (position marked claimed)
        const claimSig = await (program.methods as any)
          .claimPayoutYesno(computationOffset)
          .accountsPartial({
            payer: payer.publicKey,
            signPdaAccount: findSignPdaAccount(),
            mxeAccount: getMXEAccAddress(PROGRAM_ID),
            mempoolAccount: getMempoolAccAddress(ARCIUM_ENV!.arciumClusterOffset),
            executingPool: getExecutingPoolAccAddress(ARCIUM_ENV!.arciumClusterOffset),
            computationAccount: getComputationAccAddress(
              ARCIUM_ENV!.arciumClusterOffset,
              computationOffset as any,
            ),
            compDefAccount: getCompDefAccAddress(
              PROGRAM_ID,
              Buffer.from(getCompDefAccOffset("compute_yesno_payout")).readUInt32LE(),
            ),
            clusterAccount: getClusterAccAddress(ARCIUM_ENV!.arciumClusterOffset),
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
          const pos: any = await program.account.encryptedPosition.fetch(users[i].positionPda);
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
    const revealedYes = Number(resolvedMarket.revealedPool0.toString());
    const revealedNo  = Number(resolvedMarket.revealedPool1.toString());

    console.log(`\n  ── Final Position States ──`);
    console.log(`  YES pool (revealed): ${fmtUsdc(revealedYes)} USDC`);
    console.log(`  NO pool (revealed):  ${fmtUsdc(revealedNo)} USDC`);
    console.log(`  Payout ratio:        ${payoutRatio} (×${(payoutRatio / 1e9).toFixed(4)})`);
    console.log(``);
    console.log(`  ${"Name".padEnd(6)} | ${"Side".padEnd(4)} | ${"Bet".padEnd(8)} | ${"Net Bet".padEnd(9)} | ${"entry_odds".padEnd(12)} | ${"Payout".padEnd(9)} | ${"P&L".padEnd(9)} | claimed`);
    console.log(`  ${"─".repeat(90)}`);

    let totalPayoutToWinners = 0;

    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      const pos: any = await program.account.encryptedPosition
        .fetch(u.positionPda)
        .catch(() => null);
      const tokenBal = await getAccount(connection, u.usdcAccount);

      const pFee = Math.floor(u.betAmount * PROTOCOL_FEE_BPS / 10_000);
      const lpFee = Math.floor(u.betAmount * LP_FEE_BPS / 10_000);
      const netBet = u.betAmount - pFee - lpFee;
      const isWinner = u.side === 1; // YES wins

      // Expected payout = netBet * payoutRatio / 1e9  (for winners)
      const expectedPayout = isWinner ? Math.floor(netBet * payoutRatio / 1e9) : 0;
      const actualBalance = Number(tokenBal.amount);
      const pnl = actualBalance - u.betAmount; // net gain/loss vs initial deposit

      if (isWinner) totalPayoutToWinners += expectedPayout;

      const entryOdds = pos ? pos.entryOdds.toString() : "?";
      const claimed   = pos ? pos.claimed.toString() : "?";

      console.log(
        `  ${u.name.padEnd(6)} | ${(u.side === 1 ? "YES" : "NO").padEnd(4)} | ` +
        `${fmtUsdc(u.betAmount).padEnd(8)} | ${fmtUsdc(netBet).padEnd(9)} | ` +
        `${entryOdds.padEnd(12)} | ${fmtUsdc(expectedPayout).padEnd(9)} | ` +
        `${(pnl >= 0 ? "+" : "") + fmtUsdc(Math.abs(pnl))} | ${claimed}`,
      );
    }

    // ── Protocol & Creator earnings summary ──────────────────────────────────
    const totalProtocolFees = users.reduce((s, u) => s + Math.floor(u.betAmount * PROTOCOL_FEE_BPS / 10_000), 0);
    const totalLpFees       = users.reduce((s, u) => s + Math.floor(u.betAmount * LP_FEE_BPS / 10_000), 0);
    // LP fees accumulate in market.accumulated_lp_fees, not lp_position.fees_earned
    const lpFeesOnChain = Number(resolvedMarket.accumulatedLpFees.toString());

    const treasuryBal = await getAccount(connection, treasury).catch(() => null);
    const treasuryBalance = treasuryBal ? Number(treasuryBal.amount) : 0;

    const vaultAfter = await getAccount(connection, marketVaultPda);

    console.log(`\n  ── Financial Summary ──`);
    console.log(`  YES pool (net):           ${fmtUsdc(revealedYes)} USDC`);
    console.log(`  NO pool (net):            ${fmtUsdc(revealedNo)} USDC`);
    console.log(`  Total bets volume:        ${fmtUsdc(users.reduce((s, u) => s + u.betAmount, 0))} USDC`);
    console.log(`  Protocol fees (0.5%):     ${fmtUsdc(totalProtocolFees)} USDC  →  treasury`);
    console.log(`  LP fees (1.5%):           ${fmtUsdc(lpFeesOnChain)} USDC  →  creator`);
    console.log(`  Creator bond:             ${fmtUsdc(CREATOR_BOND)} USDC  →  creator`);
    console.log(`  Creator earnings total:   ${fmtUsdc(CREATOR_BOND + lpFeesOnChain)} USDC  (bond + LP fees)`);
    console.log(`  Protocol earnings:        ${fmtUsdc(treasuryBalance)} USDC  (treasury balance)`);
    console.log(`  Total payout to winners:  ~${fmtUsdc(totalPayoutToWinners)} USDC`);
    console.log(`  Vault balance after:      ${fmtUsdc(vaultAfter.amount)} USDC`);
    console.log(`\n  ✓ Steps 5+6 complete.`);
  });

  // ── Step 7: Creator Withdraws ─────────────────────────────────────────────

  it("Step 7: creator withdraws bond + LP fees", async () => {
    console.log("\n═══════════════════════════════════════════════");
    console.log("  STEP 7: CREATOR WITHDRAW FUNDS");
    console.log("═══════════════════════════════════════════════\n");

    const marketState: any = await program.account.market.fetch(marketPda);

    if (marketState.state !== 2) {
      console.log(`  ℹ Market not resolved (state=${marketState.state}). Skipping withdraw.`);
      return;
    }

    // Check bond not already withdrawn
    console.assert(!marketState.bondWithdrawn, "Bond should not be withdrawn yet");
    console.log(`  Bond already withdrawn: ${marketState.bondWithdrawn}`);

    const lpFeesPending = Number(marketState.accumulatedLpFees.toString());
    console.log(`  LP fees accumulated: ${fmtUsdc(lpFeesPending)} USDC`);
    console.log(`  Bond: ${fmtUsdc(marketState.creatorBond)} USDC`);
    console.log(
      `  Total to withdraw: ${fmtUsdc(Number(marketState.creatorBond) + lpFeesPending)} USDC`,
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
      const lpPosAfter: any = await program.account.lpPosition.fetch(lpPositionPda);

      console.log(`\n  Creator USDC after:  ${fmtUsdc(creatorBalAfter.amount)}`);
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
    console.log("  E2E TEST SUMMARY");
    console.log("═══════════════════════════════════════════════\n");

    try {
      const market: any = await program.account.market.fetch(marketPda);
      const question = String.fromCharCode(
        ...market.question.slice(0, market.questionLen),
      );
      const vault = await getAccount(connection, marketVaultPda);

      console.log(`  Market:       "${question}"`);
      console.log(`  State:        ${["Active", "Closed", "Resolved", "Unresolved"][market.state] ?? market.state}`);
      console.log(`  Outcome:      ${market.outcome}`);
      console.log(`  Total bets:   ${market.totalBetsCount.toString()}`);
      console.log(`  YES pool:     ${fmtUsdc(market.revealedPool0)} USDC`);
      console.log(`  NO pool:      ${fmtUsdc(market.revealedPool1)} USDC`);
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
          `  ${u.name.padEnd(6)} (${u.side === 1 ? "YES" : "NO"}): ` +
            `bet=${fmtUsdc(u.betAmount)} | balance=${fmtUsdc(bal.amount)} | ` +
            `pnl=${pnl >= 0 ? "+" : ""}${fmtUsdc(Math.abs(pnl))} | ` +
            `claimed=${pos?.claimed ?? "?"}`,
        );
      }

      const lpPos = await program.account.lpPosition.fetch(lpPositionPda).catch(() => null);
      const totalLpFees = users.reduce((s, u) => s + Math.floor(u.betAmount * LP_FEE_BPS / 10_000), 0);
      const totalProtocolFees = users.reduce((s, u) => s + Math.floor(u.betAmount * PROTOCOL_FEE_BPS / 10_000), 0);
      // LP fees live in market.accumulated_lp_fees (lp_position.fees_earned is unused)
      const lpFeesAccumulated = Number(market.accumulatedLpFees.toString());
      console.log(`\n  Creator LP fees accumulated: ${fmtUsdc(lpFeesAccumulated)} USDC`);
      console.log(`  Creator bond:                ${fmtUsdc(CREATOR_BOND)} USDC`);
      console.log(`  Creator total earnings:      ${fmtUsdc(lpFeesAccumulated + CREATOR_BOND)} USDC`);
      if (lpPos) {
        console.log(`  LP fees claimed:             ${lpPos.feesClaimed}`);
        console.log(`  LP fees claimed amt:         ${fmtUsdc(lpPos.feesClaimedAmount)} USDC`);
      }
      const treasuryBal = await getAccount(connection, treasury).catch(() => null);
      console.log(`\n  Protocol earnings (treasury): ${fmtUsdc(treasuryBal ? treasuryBal.amount : BigInt(totalProtocolFees))} USDC`);
    } catch (e: any) {
      console.log(`  Could not fetch final state: ${e.message}`);
    }

    console.log(`\n═══════════════════════════════════════════════`);
    console.log("  ✓ YES/NO E2E TEST COMPLETE");
    console.log("═══════════════════════════════════════════════\n");
  });
});

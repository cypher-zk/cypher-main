// Synthesizes an SPL Token Mint account JSON for CSDC at the address pinned
// in the program (8AF9BABNWwEhipRxtXPYoWSZW24SKjUn6YqbKd9ZqhwB), with the
// local test wallet as mint_authority + freeze_authority.
//
// Output file is consumed by Anchor.toml's [[test.validator.account]] block,
// so solana-test-validator pre-loads the mint when `arcium test` /
// `anchor test` starts. The test wallet then mints CSDC freely to bettors.
//
// Usage:
//   npx ts-node scripts/setup-csdc-mint.ts
//
// Idempotent: regenerates only when the current wallet pubkey doesn't match
// the mint_authority already embedded in the JSON.

import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import * as path from "path";

const CSDC_MINT = new PublicKey("8AF9BABNWwEhipRxtXPYoWSZW24SKjUn6YqbKd9ZqhwB");
const DECIMALS = 6;
const MINT_LAYOUT_LEN = 82;
const RENT_EXEMPT_LAMPORTS = 1_461_600; // rent-exempt min for 82 bytes
const OUT_PATH = path.resolve(__dirname, "..", "tests", "fixtures", "csdc_mint.json");

function loadPayer(): Keypair {
  const walletPath = process.env.WALLET_PATH ?? `${homedir()}/.config/solana/id.json`;
  const raw = JSON.parse(readFileSync(walletPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// Encodes a 32-byte pubkey as a COption<Pubkey>: 4-byte tag (1 = Some, 0 = None) + 32 bytes.
function encodeCOptionPubkey(pubkey: PublicKey | null): Buffer {
  const buf = Buffer.alloc(36);
  if (pubkey) {
    buf.writeUInt32LE(1, 0);
    buf.set(pubkey.toBytes(), 4);
  }
  return buf;
}

function buildMintData(authority: PublicKey): Buffer {
  const data = Buffer.alloc(MINT_LAYOUT_LEN);
  // mint_authority: COption<Pubkey> at offset 0..36
  encodeCOptionPubkey(authority).copy(data, 0);
  // supply: u64 LE at 36..44 — starts at 0
  // decimals: u8 at 44
  data.writeUInt8(DECIMALS, 44);
  // is_initialized: bool at 45
  data.writeUInt8(1, 45);
  // freeze_authority: COption<Pubkey> at 46..82
  encodeCOptionPubkey(authority).copy(data, 46);
  return data;
}

function alreadyMatchesAuthority(authority: PublicKey): boolean {
  if (!existsSync(OUT_PATH)) return false;
  try {
    const existing = JSON.parse(readFileSync(OUT_PATH, "utf-8"));
    const b64 = existing?.account?.data?.[0];
    if (typeof b64 !== "string") return false;
    const data = Buffer.from(b64, "base64");
    if (data.length !== MINT_LAYOUT_LEN) return false;
    const tag = data.readUInt32LE(0);
    if (tag !== 1) return false;
    const embedded = new PublicKey(data.subarray(4, 36));
    return embedded.equals(authority);
  } catch {
    return false;
  }
}

function main() {
  const payer = loadPayer();
  console.log(`  Wallet: ${payer.publicKey.toBase58()}`);

  if (alreadyMatchesAuthority(payer.publicKey)) {
    console.log(`  ✓ ${OUT_PATH} already matches this wallet — nothing to do.`);
    return;
  }

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  const data = buildMintData(payer.publicKey);
  const json = {
    pubkey: CSDC_MINT.toBase58(),
    account: {
      lamports: RENT_EXEMPT_LAMPORTS,
      data: [data.toString("base64"), "base64"],
      owner: TOKEN_PROGRAM_ID.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: MINT_LAYOUT_LEN,
    },
  };

  writeFileSync(OUT_PATH, JSON.stringify(json, null, 2));
  console.log(`  ✓ Wrote ${OUT_PATH}`);
  console.log(`    CSDC mint ${CSDC_MINT.toBase58()} → authority ${payer.publicKey.toBase58()}`);
}

main();

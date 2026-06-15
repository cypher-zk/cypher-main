import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// All functions take `programId` so the derivations track whatever ID the
// program is actually deployed with at test time (the arcium / anchor test
// runner may deploy under a keypair that differs from `declare_id!`).

// seeds: ["global_state"]
export function deriveGlobalStatePda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global_state")],
    programId
  )[0];
}

// seeds: ["market", market_id.to_le_bytes()]
export function deriveMarketPda(
  programId: PublicKey,
  marketId: bigint | number | BN
): PublicKey {
  const idx = Buffer.alloc(8);
  const asBig =
    marketId instanceof BN ? BigInt(marketId.toString()) : BigInt(marketId);
  idx.writeBigUInt64LE(asBig);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), idx],
    programId
  )[0];
}

// seeds: ["market_vault", market]
export function deriveMarketVaultPda(
  programId: PublicKey,
  market: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market_vault"), market.toBuffer()],
    programId
  )[0];
}

// seeds: ["lp-position", market, creator]
export function deriveLpPositionPda(
  programId: PublicKey,
  market: PublicKey,
  creator: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp-position"), market.toBuffer(), creator.toBuffer()],
    programId
  )[0];
}

// seeds: ["position", market, user]
export function derivePositionPda(
  programId: PublicKey,
  market: PublicKey,
  user: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), user.toBuffer()],
    programId
  )[0];
}

// seeds: ["ArciumSignerAccount"] — sign PDA used by queue_computation instructions
export const SIGN_PDA_SEED = Buffer.from("ArciumSignerAccount");

export function deriveSignPdaAccount(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SIGN_PDA_SEED], programId)[0];
}

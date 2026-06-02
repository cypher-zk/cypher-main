import { PublicKey } from "@solana/web3.js";

// All functions take `programId` so the derivations track whatever ID the
// program is actually deployed with at test time (the arcium / anchor test
// runner may deploy under a keypair that differs from `declare_id!`).

// seeds: ["cypher_market"]
export function deriveCypherMarketPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("cypher_market")],
    programId
  )[0];
}

// seeds: ["market_group", config, group_index as u64 LE]
export function deriveMarketGroupPda(
  programId: PublicKey,
  config: PublicKey,
  groupIndex: bigint | number
): PublicKey {
  const idx = Buffer.alloc(8);
  idx.writeBigUInt64LE(BigInt(groupIndex));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market_group"), config.toBuffer(), idx],
    programId
  )[0];
}

// seeds: ["market", group, [tier_byte]]
// tier_byte: 0 = flat (YesNo/Multi), 0/1/2 = Micro/Standard/Whale (Accuracy)
export function deriveMarketPda(
  programId: PublicKey,
  group: PublicKey,
  tierByte: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), group.toBuffer(), Buffer.from([tierByte])],
    programId
  )[0];
}

// seeds: ["pool", market, [pool_index]]
export function derivePoolPda(
  programId: PublicKey,
  market: PublicKey,
  poolIndex: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), market.toBuffer(), Buffer.from([poolIndex])],
    programId
  )[0];
}

// seeds: ["position", pool, user]
export function derivePositionPda(
  programId: PublicKey,
  pool: PublicKey,
  user: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), pool.toBuffer(), user.toBuffer()],
    programId
  )[0];
}

// seeds: ["bond", group]
export function deriveBondPda(
  programId: PublicKey,
  group: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bond"), group.toBuffer()],
    programId
  )[0];
}

// seeds: ["settlement_registry", pool]
export function deriveSettlementRegistryPda(
  programId: PublicKey,
  pool: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("settlement_registry"), pool.toBuffer()],
    programId
  )[0];
}

// seeds: ["vault_authority", pool]
export function deriveVaultAuthorityPda(
  programId: PublicKey,
  pool: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority"), pool.toBuffer()],
    programId
  )[0];
}

// seeds: ["bond_vault", bond]
// PDA-owned SPL token account holding the creator's bond
export function deriveBondVaultPda(
  programId: PublicKey,
  bond: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bond_vault"), bond.toBuffer()],
    programId
  )[0];
}

// seeds: ["bond_vault_authority", bond]
export function deriveBondVaultAuthorityPda(
  programId: PublicKey,
  bond: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bond_vault_authority"), bond.toBuffer()],
    programId
  )[0];
}

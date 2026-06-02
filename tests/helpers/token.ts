import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createMint as splCreateMint,
  createAccount,
  mintTo as splMintTo,
} from "@solana/spl-token";

export async function createMint(
  connection: Connection,
  payer: Keypair,
  mintAuthority: PublicKey,
  decimals: number = 6
): Promise<PublicKey> {
  return splCreateMint(connection, payer, mintAuthority, null, decimals);
}

export async function createTokenAccount(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  return createAccount(connection, payer, mint, owner);
}

export async function mintTo(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  destination: PublicKey,
  authority: Keypair,
  amount: number | bigint
): Promise<void> {
  await splMintTo(connection, payer, mint, destination, authority, amount);
}

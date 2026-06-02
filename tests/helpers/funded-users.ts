import * as anchor from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { createTokenAccount, mintTo } from "./token";

export interface FundedUser {
  keypair: Keypair;
  usdcAccount: PublicKey;
}

// Creates n funded wallets, each with 2 SOL and usdcAmount USDC (6-decimal lamports).
// Uses its own Connection with disableBlockhashCaching — SPL sendAndConfirmTransaction
// exhausts cached blockhashes on the 4th+ user without this.
export async function createFundedUsers(
  provider: anchor.AnchorProvider,
  payer: Keypair,
  usdcMint: PublicKey,
  n: number,
  usdcAmount: number
): Promise<FundedUser[]> {
  const connection = new Connection(provider.connection.rpcEndpoint, {
    commitment: "confirmed",
    disableBlockhashCaching: true,
  });

  const users: FundedUser[] = [];

  for (let i = 0; i < n; i++) {
    const keypair = Keypair.generate();

    const airdropSig = await connection.requestAirdrop(
      keypair.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdropSig, "confirmed");

    const usdcAccount = await createTokenAccount(
      connection,
      payer,
      usdcMint,
      keypair.publicKey
    );

    await mintTo(connection, payer, usdcMint, usdcAccount, payer, usdcAmount);

    users.push({ keypair, usdcAccount });
  }

  await new Promise((r) => setTimeout(r, 2000));
  return users;
}

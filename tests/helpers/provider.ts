import * as anchor from "@anchor-lang/core";

export function buildProvider(): anchor.AnchorProvider {
  const envProvider = anchor.AnchorProvider.env();
  const connection = new anchor.web3.Connection(
    envProvider.connection.rpcEndpoint,
    { commitment: "confirmed", disableBlockhashCaching: true }
  );
  const provider = new anchor.AnchorProvider(connection, envProvider.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  return provider;
}

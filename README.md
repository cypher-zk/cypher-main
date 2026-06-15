# cypher_main

A confidential Solana app built with Arcium: an Anchor program queues computations, and Arcis instructions define the confidential logic.

## Quickstart

```bash
arcium build                          # devnet — accepts CSDC (8AF9BABNWwEhipRxtXPYoWSZW24SKjUn6YqbKd9ZqhwB)
CYPHER_CLUSTER=mainnet arcium build   # mainnet — accepts USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)

# Local e2e — synthesizes a CSDC mint owned by your test wallet and pre-loads
# it into solana-test-validator, then runs the suite.
yarn test:local
```

The pre-load is wired via `[[test.validator.account]]` in `Anchor.toml` pointing at `tests/fixtures/csdc_mint.json`. `scripts/setup-csdc-mint.ts` writes that file with your `~/.config/solana/id.json` wallet as `mint_authority` so the tests can `mintTo` freely. Re-run `yarn setup:mint` if you rotate the wallet.

## Accepted bet token

The protocol accepts exactly one SPL mint, pinned at **compile time**:

| Build                               | Mint accepted                                  |
|-------------------------------------|------------------------------------------------|
| `arcium build` *(default)*          | Cypher Coin (CSDC) on devnet                   |
| `CYPHER_CLUSTER=mainnet arcium build` | Circle USDC on mainnet                       |

**How the switch works.** `programs/cypher_main/build.rs` reads the `CYPHER_CLUSTER` env var. When it's `mainnet`, it emits `--cfg cypher_mainnet`; otherwise the cfg is off. `states.rs` then picks the right pubkey:

```rust
#[cfg(cypher_mainnet)]
pub const ACCEPTED_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
#[cfg(not(cypher_mainnet))]
pub const ACCEPTED_MINT: Pubkey = pubkey!("8AF9BABNWwEhipRxtXPYoWSZW24SKjUn6YqbKd9ZqhwB");
```

Yes — it is fully automatic with `CYPHER_CLUSTER=mainnet`. No source edits required; just rebuild and redeploy.

**How enforcement works.** Every account context that accepts a user-supplied `TokenAccount` carries an Anchor constraint pinning its `mint` to `ACCEPTED_MINT`:

- `initialize.accepted_mint` and `update_accepted_mint.new_mint` are pinned via `address = ACCEPTED_MINT`.
- Each market's `market_vault` PDA is created with `token::mint = accepted_mint`, so vaults can only hold the accepted token.
- `creator_token_account` and `user_token_account` on **every** instruction — `create_market`, `cancel_market`, `withdraw_creator_funds`, `place_private_bet_*`, `claim_payout_*`, `claim_refund_*`, plus their `*_callback` siblings — carry `constraint = X.mint == ACCEPTED_MINT @ CypherError::WrongMint`.
- `admin_claim_remaining.protocol_treasury` is pinned the same way.

Net result: no SPL token other than CSDC (devnet) / USDC (mainnet) can flow into or out of the protocol at any step.

## Layout

| Path | Purpose |
|------|---------|
| `programs/cypher_main/` | Anchor program: queues computations, handles callbacks |
| `encrypted-ixs/` | Arcis confidential instructions |
| `tests/cypher_main.ts` | TypeScript integration tests |
| `Arcium.toml` | Localnet and cluster configuration |

## Docs

<https://docs.arcium.com/developers>

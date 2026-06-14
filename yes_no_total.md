# Yes/No + Multi-Outcome Settlement: What's Broken

Audit of the end-to-end test against the program (`programs/cypher_main/src/lib.rs`),
the Arcis circuits (`encrypted-ixs/src/lib.rs`), and the test runners (`tests/*.ts`).
Numbers in the test output that should never appear:

- Multi-outcome pool 3 (Obama) = **11,782,185,890,948.49 USDC** after five small bets
  totalling 58 USDC.
- Every bettor's `entry_odds` = `1_000_000_000` (= 1.000×), regardless of which
  candidate they backed or how much.
- Winner MagaFan1 (10 USDC on Trump, Trump wins) received **0 USDC** on claim.
- Vault holds 56.84 USDC of stranded bet principal after all claims complete.

The fee math (0.5 % protocol + 1.5 % LP, taken in the place‑bet ix) and the
share‑of‑losers payout formula (`payout = net_bet × total_pool / winner_pool`)
are **algebraically correct in the code**. The breakdown is upstream of those
formulas — the inputs they consume are corrupt.

## Finding 1 — CRITICAL: the encrypted `BetInput` decrypts to garbage in the circuit

This is the headline bug. Everything else downstream (giant pool numbers,
losers winning, winners losing) is a symptom.

### Evidence

Place‑bet circuit (`encrypted-ixs/src/lib.rs:162`):

```rust
let (p0, p1, p2, p3) = match b.side {
    0 => (pool_0 + b.amount, pool_1, pool_2, pool_3),
    1 => (pool_0, pool_1 + b.amount, pool_2, pool_3),
    2 => (pool_0, pool_1, pool_2 + b.amount, pool_3),
    _ => (pool_0, pool_1, pool_2, pool_3 + b.amount),   // ← anything ≥ 3 lands here
};
```

Observed effects after 5 bets (`outcome` values 0,1,0,2,3 in the test):

- All five increments landed in `pool_3` — the wildcard arm. So every decrypted
  `b.side` was ≥ 3 (i.e. _not_ 0/1/2). It's almost certainly a fixed value across
  all bets, because…
- `entry_odds = total × 1e9 / side_pool` returned `1_000_000_000` every time,
  which only happens when `side_pool == total`. That's only possible if every
  bet keeps writing to the same pool.
- The accumulated `pool_3 ≈ 1.18 × 10¹⁹` micro-USDC — within u64 range and the
  same order of magnitude as the sum of five random‑looking u64 values, i.e.
  `b.amount` is being read as 64 bits of junk, not the encrypted `netAmount`
  the test passed in.

### Likely cause

The test encrypts amount + side as a single 2‑element tuple and the on‑chain
program re-binds them via two `.encrypted_*` calls on `ArgBuilder`:

```ts
// tests/multi_outcome_e2e.ts:191
const encrypted = cipher.encrypt(
  [BigInt(netAmount), BigInt(side)],
  nonceBytes,
);
// → encrypted[0] becomes encryptedAmount,  encrypted[1] becomes encryptedSide
```

```rust
// programs/cypher_main/src/lib.rs:674  (multi)  and :496 (yesno)
ArgBuilder::new()
    .plaintext_u64(m.revealed_pool_0)
    ...
    .x25519_pubkey(pub_key)
    .plaintext_u128(nonce)
    .encrypted_u64(encrypted_amount)   // 32 bytes
    .encrypted_u8 (encrypted_side)     // 32 bytes
    .build();
```

The circuit consumes them as one merged value: `bet: Enc<Shared, BetInput>`
where `BetInput { amount: u64, side: u8 }`. The Arcium pattern for a multi-field
`Enc<Shared, Struct>` is sensitive to:

1. The **ciphertext layout** the client produces — `CSplRescueCipher.encrypt(tuple, nonce)`
   may not be the input shape `Enc<Shared, BetInput>` expects when fields are
   re-fed via separate `.encrypted_u64 / .encrypted_u8` builder calls.
2. The **nonce / shared-secret derivation** — if any of `pub_key`, `nonce`,
   or the MXE pubkey aren't bit-identical between encrypt-side and decrypt-side
   (e.g. endianness on `nonce` between the JS `deserializeLE` ↔ Rust `u128`),
   the symmetric cipher returns plausibly-shaped garbage instead of an error.

Both of these are consistent with the observed symptom — circuit decryption
"succeeds" but yields constant junk for `side` and noisy junk for `amount`.

### How to confirm

Add a temporary debug instruction or `msg!` in the callback that emits a hash
of `(encrypted_amount, encrypted_side, pub_key, nonce)` from the queue side, and
a matching log of decrypted `(amount, side)` from the circuit (gated behind a
debug feature). Compare to what the test encrypted. The test client should also
log `mxePubKey.toString("hex")` so we can verify both sides are using the same
MXE x25519 pubkey.

## Finding 2 — CRITICAL: YES/NO bettors on the losing side can never win — even when their side wins

Independent of the encryption issue, the YES/NO settlement has a
side/outcome enum mismatch.

`BetInput.side` is documented (`encrypted-ixs/src/lib.rs:22`) as
`YES/NO = 1/0` — i.e. 1 = YES, 0 = NO.

`outcome_value` passed to `resolve_market_yesno`
(`programs/cypher_main/src/lib.rs:759`) is required to be **1 (YES) or 2 (NO)**.

The payout circuit (`encrypted-ixs/src/lib.rs:118`) checks:

```rust
let is_winner = pos.side == outcome;
```

Truth table:

| Bet side (encrypted) | Market outcome | `side == outcome` | Should win? |
| --- | --- | --- | --- |
| 1 (YES) | 1 (YES) | true ✓ | yes |
| 0 (NO)  | 1 (YES) | false ✓ | no |
| 1 (YES) | 2 (NO)  | false ✓ | no |
| **0 (NO)**  | **2 (NO)**  | **false ✗** | **YES** |

NO bettors on a NO market would silently get 0 payout. The current e2e test
only resolves to YES, so the bug is invisible there.

## Finding 3 — `b.side` is unchecked against `num_outcomes`

`place_private_bet_multi` accepts any `b.side` and the wildcard `_` arm dumps
all unexpected values into `pool_3`. A market with `num_outcomes = 3` will
silently accept and orphan bets that encrypt `side = 3`.

Strictly the on-chain ix can't validate this without leaking the bettor's
choice. The fix is one of:

- Document this as caller responsibility and add a client-side guard.
- Always store 4 pools regardless of `num_outcomes` (which is what the program
  already does) and explicitly treat any pool beyond `num_outcomes` as
  "unreachable winner" — so at minimum no one's funds are unrecoverable to
  refund flow on cancel. Verify cancel / refund handles this.

## Finding 4 — `total_bets_count` is not used for any settlement decision

It's incremented in both place-bet callbacks but read only by the test. Not a
bug, but worth being aware that on-chain settlement leans entirely on the
revealed pools (which Finding 1 corrupts).

## Finding 5 — Test infra noise (low priority)

The trailing
`Could not fetch final state: Cannot read properties of undefined (reading '_bn')`
in both summaries is the test summary block trying to read an account/pubkey
that wasn't populated when an earlier step took an error path. Cosmetic
once the upstream bugs are fixed.

---

## Recommended approach

In priority order. Stop at the first fix that makes Finding 1 go away — there's
no point patching Findings 2-5 against a corrupted circuit input.

### 1. Fix the encrypted `BetInput` round-trip (Finding 1)

Choose **one** of these two paths and stop:

**(a) Split the struct into two `Enc<Shared, T>` parameters.**
Match each side's wire layout 1:1 to the cipher's per-field tuple output.

```rust
// circuit
pub fn place_private_bet_multi(
    pool_0: u64, pool_1: u64, pool_2: u64, pool_3: u64,
    amount: Enc<Shared, u64>,
    side:   Enc<Shared, u8>,
) -> (u64, u64, u64, u64, u64) {
    let a = amount.to_arcis();
    let s = side.to_arcis();
    /* ...same logic, using a and s... */
}
```

```rust
// on-chain queue
ArgBuilder::new()
    .plaintext_u64(p0).plaintext_u64(p1).plaintext_u64(p2).plaintext_u64(p3)
    .x25519_pubkey(pub_key).plaintext_u128(nonce).encrypted_u64(enc_amount)
    .x25519_pubkey(pub_key).plaintext_u128(nonce).encrypted_u8(enc_side)
    .build();
```

This is the lowest-ambiguity fix because each `Enc<Shared, T>` is a single
ciphertext + its own (pubkey, nonce) header, exactly what `.encrypted_*`
produces. If the client encrypts `[amount, side]` as one tuple, the two
ciphertexts can be reused — just attach the same `pub_key` + `nonce` to each.

**(b) Keep the struct, switch to the byte-blob shape Arcium expects.**
Verify against the current Arcium example for `Enc<Shared, MyStruct>` (where
`MyStruct` has > 1 field) and mirror it exactly:

- the cipher call (single concatenated ciphertext vs. per-field tuple),
- field order and padding (`u64` then `u8` with whatever the compiler emits in
  the `*.arcis.ir` for `BetInput`),
- the corresponding ArgBuilder method(s) — possibly a single
  `.encrypted_struct(...)` rather than two `.encrypted_*` calls.

Then ship (a) anyway if (b) requires inferred behaviour — splitting fields is
the more robust shape and removes the struct-layout coupling between three
codebases.

Before merging either: add a one-shot debug ix that returns the **decrypted**
`(amount, side)` for a known test bet (encrypted with a deterministic nonce).
Assert equality in the test. This catches regressions instantly the next time
someone touches the circuit input layout.

### 2. Fix the YES/NO side/outcome encoding (Finding 2)

Pick one convention and use it end-to-end. Recommended: keep the BetInput
encoding (1 = YES, 0 = NO) and change the on-chain `outcome_value`
domain to match:

```rust
// resolve_market_yesno
require!(outcome_value == 0 || outcome_value == 1, CypherError::InvalidOutcome);
```

Update the `reveal_market_outcome_yesno` circuit's branch
(currently `if outcome_value == 1 { yes_pool } else { no_pool }` — keep this,
it already happens to map correctly), and the `compute_yesno_payout`
`is_winner = pos.side == outcome` comparison will then work for both
sides.

Also update the test resolver call (`yes_no_e2e.ts`) which is currently passing
`outcomeValue = 1` (YES) and would still need to pass `0` for NO once the
domain change lands.

### 3. Decide the policy for out-of-range `b.side` (Finding 3)

The current "wildcard pool_3" arm is unsafe for `num_outcomes < 4`. Cheap
mitigation: keep the wildcard arm and rely on the `revealed_pool_3`
plaintext being 0 (no bets) when `num_outcomes ≤ 3` — but that contract
must be enforced client-side, with a clearly labelled requirement in
`place_private_bet_multi`'s ix-level docs. Document it or eat the cost
of validating side in MPC (constant‑time compare against
`num_outcomes`, force overflow into a sentinel "burn" pool not paid out).

### 4. Re-run the existing e2e tests as a regression check

The YES/NO test resolves to YES and the Multi test resolves to outcome 0.
Add at least two more cases before the diff is considered green:

- YES/NO resolved to **NO** — proves Finding 2 is closed.
- Multi resolved to a non-zero outcome (e.g. `Hope4ward` wins, outcome 3) —
  proves the side decode is correct across all match arms, not just the
  wildcard.

Both should assert that exactly the right winners receive non-zero payouts
and that `vault_final == lp_fees + creator_bond` after all claims.

### 5. Tidy

- Delete the `msg!("CYPHER_DBG bet_ix: …")` and `CYPHER_DBG bet_callback:` lines
  once Finding 1 is closed (`programs/cypher_main/src/lib.rs:491`, `:546`) —
  they leak nothing today but only because the pools are plaintext; they should
  not stay in production.
- Fix the test-summary `_bn` undefined access (Finding 5) so a future regression
  isn't masked by a cosmetic crash.

Once Finding 1 lands, the obscene pool numbers, the constant `entry_odds`, the
winners-getting-zero behaviour, and the stranded vault balance should all
disappear in a single change.

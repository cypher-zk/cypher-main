# Multi-Outcome Markets — User Flow & Math

A multi-outcome market lets bettors back **one of up to four outcomes**
(0/1/2/3). Each bettor's _amount_ and _side_ are encrypted client-side and
stay private through the entire lifecycle — only the **per-outcome pool
totals** are revealed on-chain as bets settle. When the market resolves,
winners split the entire pool in proportion to their share of the winning
side.

All amounts are in **micro-USDC** (1 USDC = 1,000,000 micro). Diagrams use
USDC for readability.

---

## 1. Market lifecycle (state machine)

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Active : create_market_multi
    Active --> Active : place_private_bet_multi (×N)
    Active --> Active : cancel_market (only if 0 bets)
    Active --> [*] : cancelled
    Active --> Resolving : resolve_market_multi
    Resolving --> Resolved : reveal callback
    Resolved --> Resolved : claim_payout_multi (×N)
    Resolved --> Closed : withdraw_creator_funds
    Closed --> [*]

    state Active {
        direction LR
        [*] --> AcceptingBets
        AcceptingBets --> ClosedToBets : now ≥ close_time
    }
```

`state` field on the `Market` account: `0=Active`, `2=Resolved`.
"Resolving" is the brief window between `resolve_market_multi` queueing the
MPC computation and the Arcium callback writing the result.

---

## 2. Cast of characters & on-chain accounts

```mermaid
flowchart LR
    subgraph Onchain["On-chain PDAs"]
        GS["GlobalState<br/>seed: global_state"]
        M["Market PDA<br/>seed: market, market_id"]
        V["Market Vault SPL token account<br/>seed: market_vault, market"]
        LP["LP Position PDA<br/>seed: lp-position, market, creator"]
        P0["Position PDA<br/>seed: position, market, user_0"]
        P1["Position PDA<br/>seed: position, market, user_1"]
        Pn["Position PDA<br/>seed: position, market, user_N"]
    end

    subgraph Wallets["External"]
        TR["protocol_treasury<br/>SPL account"]
        CRE["Creator wallet"]
        U0["Bettor 0"]
        U1["Bettor 1"]
        Un["Bettor N"]
    end

    CRE -->|locks 10 USDC bond| V
    U0 -->|bet, encrypted side and amount| P0
    U1 -->|bet, encrypted side and amount| P1
    Un -->|bet, encrypted side and amount| Pn

    V -.->|protocol fee per bet| TR
    V -.->|winning payouts| U0
    V -.->|bond plus LP fees on close| CRE

    M -. tracks .-> V
    M -. tracks .-> LP
```

`Market` stores plaintext: `revealed_pool_0..3`, `accumulated_lp_fees`,
`payout_ratio`, `outcome`, `state`. The bettor's `side` and `amount` only
ever live encrypted (in `EncryptedPosition` + inside the MPC circuit).

---

## 3. End-to-end user journey

```mermaid
sequenceDiagram
    autonumber
    participant CRE as Creator
    participant U as Bettor x5
    participant P as cypher_main program
    participant A as Arcium MPC cluster
    participant T as Treasury

    Note over CRE,T: STEP 1 — protocol bootstrap (once)
    CRE->>P: initialize (fee rates, treasury, mint)
    CRE->>P: init_comp_def x 4: place_bet, reveal, payout, refund

    Note over CRE,T: STEP 2 — market creation
    CRE->>P: create_market_multi(question, close_time, num_outcomes)
    P-->>P: lock 10 USDC bond into vault
    P-->>P: zero out revealed_pool_0..3

    Note over CRE,T: STEP 3 — bets (each one is a private MPC round-trip)
    loop for each bettor
        U->>U: encrypt(amount, side) with MXE pubkey
        U->>P: place_private_bet_multi(bet, ciphertext)
        P->>T: send protocol_fee (0.5%)
        P-->>P: accumulate lp_fee in market
        P->>A: queue compute(pools, encrypted bet)
        A-->>A: side decides which pool +=net amount
        A->>P: callback(new pools, entry_odds)
        P-->>P: write revealed_pool_0..3
    end

    Note over CRE,T: STEP 4 — resolution
    CRE->>P: resolve_market_multi(outcome)
    P->>A: queue reveal(pools, outcome)
    A->>P: callback(pools, payout_ratio)
    P-->>P: state=Resolved, set deadlines

    Note over CRE,T: STEPS 5+6 — claims (one MPC round-trip each)
    loop for each bettor
        U->>P: claim_payout_multi
        P->>A: queue payout(amount, side, outcome, ratio)
        A->>P: callback(payout, is_winner)
        alt is_winner
            P->>U: transfer payout from vault
        else
            P-->>P: mark claimed, no transfer
        end
    end

    Note over CRE,T: STEP 7 — creator withdraws
    CRE->>P: withdraw_creator_funds
    P->>CRE: transfer bond + accumulated_lp_fees
```

---

## 4. What happens inside `place_private_bet_multi`

```mermaid
flowchart TD
    Start(["User submits bet"]) --> V1{"state == Active<br/>and now &lt; close_time<br/>and bet ≥ min_bet?"}
    V1 -- no --> ERR["reject"]
    V1 -- yes --> CalcFees["protocol_fee = bet × 50 / 10000<br/>lp_fee = bet × 150 / 10000"]

    CalcFees --> Transfer["Transfer full bet: user → vault"]
    Transfer --> Treasury["Transfer protocol_fee: vault → treasury"]
    Treasury --> AccLP["accumulated_lp_fees += lp_fee"]
    AccLP --> InitPos["Init EncryptedPosition PDA<br/>store encrypted_amount, encrypted_side,<br/>pub_key, nonce, entry_odds = 0"]

    InitPos --> Build["Build ArgBuilder<br/>pool_0..3 plaintext,<br/>pub_key, nonce, ciphertexts"]
    Build --> Queue["queue_computation → Arcium"]
    Queue --> Wait(("wait for callback"))

    Wait --> CB["place_private_bet_multi_callback"]
    CB --> Verify{"verify_output from cluster?"}
    Verify -- fail --> Abort["error: ComputationVerificationFailed"]
    Verify -- ok --> Write["Write revealed_pool_0..3 from MPC output<br/>Write entry_odds onto Position<br/>Increment total_bets_count"]
    Write --> Done(["Bet finalised"])
```

**Why two phases?** The fee/transfer half runs in the user's submitting
transaction (atomic with the SPL transfer). The pool update half waits for
the Arcium MPC cluster to decrypt `side` privately, add `net` to the chosen
pool, and sign the result. Only the **revealed pool totals** come back to
chain — the individual side is never written anywhere in the clear.

---

## 5. The MPC computation (place bet, in detail)

```mermaid
sequenceDiagram
    autonumber

    participant Client as Client TS
    participant Prog as cypher_main
    participant MXE as MXE account
    participant Cluster as Arx cluster
    participant Circuit as Arcis circuit
    participant CB as bet_callback

    Note over Client: 1) Fetch MXE pubkey for this program
    Client->>MXE: getMXEPublicKey(PROGRAM_ID)
    MXE-->>Client: x25519 pubkey

    Note over Client: 2) Derive shared secret and encrypt
    Client->>Client: userPriv = random32
    Client->>Client: userPub = x25519(userPriv)
    Client->>Client: shared = x25519(userPriv, mxePub)
    Client->>Client: nonce = random16
    Client->>Client: ciph = RescueCipher(shared).encrypt(netAmount, side, nonce)

    Note right of Client: ciph is 32 bytes per scalar.<br/>ciph_0 = encryptedAmount<br/>ciph_1 = encryptedSide

    Note over Prog: 3) place_private_bet_multi
    Client->>Prog: tx(bet, encAmount, encSide, userPub, nonce)

    Prog->>Cluster: queue_computation(args)

    Note right of Prog: ArgBuilder order matches circuit.<br/>plaintext pools, pubkey, nonce,<br/>encrypted_u64 amount,<br/>encrypted_u8 side

    Note over Cluster: 4) MPC nodes run the circuit
    Cluster->>Circuit: place_private_bet_multi(p0, p1, p2, p3, EncSharedBetInput)

    Circuit-->>Circuit: bet = decrypt private input
    Circuit-->>Circuit: update selected pool
    Circuit-->>Circuit: entry_odds = (total * 1e9) / side_pool

    Circuit-->>Cluster: reveal(p0, p1, p2, p3, entry_odds)

    Note over Cluster: 5) Signed result to on-chain callback
    Cluster->>CB: signed output

    CB->>CB: verify_output()
    CB->>Prog: write pools, entry_odds,<br/>increment total_bets_count
```

**Decryption privacy:** the ciphertexts are decrypted _inside the MPC
secret-shared computation_ — no single Arx node ever sees the plaintext
`(amount, side)`. The match-arm pool update happens on the shared values,
and only the resulting **pool totals** (and `entry_odds`) are `reveal()`-ed
back as plaintext.

---

## 6. The math — per-bet fees & pool accumulation

```mermaid
flowchart LR
    Bet["Gross bet B"] -->|×0.5%| PF["Protocol fee<br/>to treasury<br/>immediately"]
    Bet -->|×1.5%| LF["LP fee<br/>to vault<br/>accumulated_lp_fees"]
    Bet -->|remainder| NET["Net N = B − PF − LF"]
    NET --> POOL["revealed_pool_outcome += N"]

    style PF fill:#fde,stroke:#b58
    style LF fill:#ffd,stroke:#aa3
    style NET fill:#dfd,stroke:#494
    style POOL fill:#def,stroke:#36a
```

Code references:

| Quantity        | Formula                            | Source                                       |
| --------------- | ---------------------------------- | -------------------------------------------- |
| protocol_fee    | `bet × protocol_fee_rate / 10_000` | `lib.rs:602`                                 |
| lp_fee          | `bet × lp_fee_rate / 10_000`       | `lib.rs:607`                                 |
| net (encrypted) | `bet − protocol_fee − lp_fee`      | client-side (`multi_outcome_e2e.ts:549`)     |
| pool update     | `pool_side += net`                 | circuit (`encrypted-ixs/src/lib.rs:171-176`) |

Vault invariant during the betting window:

```
vault_balance == creator_bond
              + Σ bets
              - Σ protocol_fees_sent_to_treasury
```

---

## 7. The math — resolution & payout ratio

When the creator resolves, the reveal circuit returns a **payout ratio**
that scales each winner's net bet to their total claim.

```mermaid
flowchart TD
    R0["winner_pool = revealed_pool_outcome"]
    R1["total = pool_0 + pool_1 + pool_2 + pool_3"]
    R2["safe_div = winner_pool if winner_pool > 0 else 1"]
    R3["payout_ratio = total × 1_000_000_000 / safe_div"]
    R4{"winner_pool > 0?"}
    R5["use payout_ratio"]
    R6["fallback ratio = 1_000_000_000 (1.0×) — no winning bets, nothing to distribute"]

    R0 --> R1 --> R2 --> R3 --> R4
    R4 -- yes --> R5
    R4 -- no  --> R6
```

`payout_ratio` is scaled by `1e9` to keep MPC integer-only.

### Per-user payout

```mermaid
flowchart LR
    inA["user.net_bet N"] --> mul["× payout_ratio / 1e9"]
    inB["payout_ratio R"] --> mul
    inC["user.side"] --> chk{"side == outcome?"}
    chk -- yes --> mul --> out["payout = N × R / 1e9"]
    chk -- no  --> zero["payout = 0<br/>(loser)"]
```

**Algebraic identity** (why this is "share of the losers' pool"):

```
payout_ratio = total / winner_pool                 (scale aside)

payout       = net_bet × total / winner_pool
             = net_bet + net_bet × (total − winner_pool) / winner_pool
             = net_bet + (net_bet / winner_pool) × loser_pools
                       └─ share of winning side ─┘
```

So a winner gets their own net bet back plus a proportional slice of
everything bet on the losing outcomes.

---

## 8. Worked example — test scenario

Question: _"Who will be the president of the USA?"_ — `num_outcomes = 4`.
Resolves to **outcome 0 (Donald Trump)**.

### 8a. Bets placed

| Bettor     | Side (outcome) | Gross bet | Protocol fee (0.5%) | LP fee (1.5%) | Net into pool |
| ---------- | -------------- | --------: | ------------------: | ------------: | ------------: |
| MagaFan1   | 0 (Trump)      |     10.00 |                0.05 |          0.15 |      **9.80** |
| Liberty22  | 1 (JFK)        |      5.00 |               0.025 |         0.075 |      **4.90** |
| MagaFan2   | 0 (Trump)      |     20.00 |                0.10 |          0.30 |     **19.60** |
| FedPaper   | 2 (Madison)    |     15.00 |               0.075 |         0.225 |     **14.70** |
| Hope4ward  | 3 (Obama)      |      8.00 |                0.04 |          0.12 |      **7.84** |
| **Totals** |                | **58.00** |            **0.29** |      **0.87** |     **56.84** |

### 8b. Pools after Step 3 (settled by Arcium callbacks)

```mermaid
pie showData
    title Per-outcome net pools (USDC)
    "Trump (0) — winners" : 29.40
    "JFK (1)" : 4.90
    "Madison (2)" : 14.70
    "Obama (3)" : 7.84
```

```
revealed_pool_0 = 9.80 + 19.60 = 29.40   ← winner pool
revealed_pool_1 = 4.90
revealed_pool_2 = 14.70
revealed_pool_3 = 7.84
total           = 56.84
```

### 8c. Resolve — payout ratio

```
payout_ratio = total × 1e9 / winner_pool
             = 56.84 × 1e9 / 29.40
             = 1_933_333_333          ≈ 1.9333×
```

### 8d. Per-bettor settlement

| Bettor    | Side | Net bet |  × ratio |    Payout | P&L (vs gross) |
| --------- | ---- | ------: | -------: | --------: | -------------: |
| MagaFan1  | 0 ✓  |    9.80 | × 1.9333 | **18.95** |          +8.95 |
| MagaFan2  | 0 ✓  |   19.60 | × 1.9333 | **37.89** |         +17.89 |
| Liberty22 | 1 ✗  |    4.90 |        — |      0.00 |          −5.00 |
| FedPaper  | 2 ✗  |   14.70 |        — |      0.00 |         −15.00 |
| Hope4ward | 3 ✗  |    7.84 |        — |      0.00 |          −8.00 |

Sum of winner payouts: `18.95 + 37.89 = 56.84 = total net pool` ✓
— the pool drains exactly to zero after all winners claim.

### 8e. Final vault reconciliation

```mermaid
flowchart LR
    subgraph VaultStart["Vault at peak after all bets"]
        VB["Bond: 10.00"]
        VN["Net pool: 56.84"]
        VL["LP fees: 0.87"]
    end

    subgraph Claims["Step 5 and 6 — claims"]
        WP["Winner payouts<br/>minus 56.84"]
    end

    subgraph Withdraw["Step 7 — creator withdraw"]
        BO["Bond out: minus 10.00"]
        LO["LP fees out: minus 0.87"]
    end

    subgraph End["Vault end state"]
        Z["Balance: 0.00"]
    end

    VaultStart --> Claims --> Withdraw --> End
```

```
vault_after_bets   = 10.00 (bond) + 58.00 (bets) − 0.29 (protocol→treasury) = 67.71
vault_after_claims = 67.71 − 56.84 (winners) = 10.87
vault_final        = 10.87 − 10.00 (bond) − 0.87 (LP fees) = 0.00

treasury           = 0.29 USDC                  (protocol earnings)
creator total      = 10.00 (bond back) + 0.87 (LP fees) = 10.87 USDC
```

Money in = money out: `58.00 gross bets = 56.84 paid to winners + 0.29 treasury + 0.87 creator LP fees` ✓.

---

## 9. The claim flow (per bettor)

```mermaid
sequenceDiagram
    autonumber
    participant U as Bettor
    participant P as cypher_main
    participant A as Arcium
    participant V as Vault

    U->>P: claim_payout_multi
    P->>P: require not claimed and Resolved and now ≤ claim_deadline
    P->>A: queue compute_multi_payout(encAmount, encSide, outcome, ratio)
    Note right of A: Circuit privately decrypts amount and side.<br/>is_winner = (side == outcome).<br/>payout = is_winner then amt × ratio / 1e9 else 0.
    A->>P: callback(payout, is_winner)
    P->>P: position.claimed = true
    alt is_winner & payout > 0
        P->>V: transfer payout → user
        V->>U: USDC payout
        P->>P: market.total_payouts_claimed += payout
    else loser
        Note over P: no transfer — position simply marked claimed
    end
```

The `claimed` flag prevents double-claims; the `claim_deadline` window
prevents lingering claims after the creator has withdrawn.

---

## 10. Edge cases worth knowing

| Situation                                        | What happens                                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `winner_pool == 0` (no bets on the winning side) | `payout_ratio = 1e9` (1.0×); winners would get back their net stake, but there are none — pool is stranded until `admin_claim_remaining` |
| Market never resolved by deadline                | Anyone with a position can call `claim_refund_multi` to get `net_bet` back (Arcium decrypts amount, returns it)                          |
| Bettor sides ≥ `num_outcomes` (invalid index)    | Lands in `pool_3` via the `_` match arm — unrecoverable as winnings unless outcome ends up 3; client must validate                       |
| Two bets from same user on same market           | Disallowed — `position` PDA seeded by `(market, user)` is single-init                                                                    |
| `cancel_market` after first bet                  | Rejected: `total_bets_count > 0` blocks cancellation                                                                                     |

---

## Quick file map

| Concern                                                                                                                  | File                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| State accounts (`Market`, `EncryptedPosition`, `LPPosition`, `GlobalState`)                                              | `programs/cypher_main/src/states.rs` |
| `create_market_multi`, `place_private_bet_multi`, `resolve_market_multi`, `claim_payout_multi`, `withdraw_creator_funds` | `programs/cypher_main/src/lib.rs`    |
| MPC circuits (`place_private_bet_multi`, `reveal_market_outcome_multi`, `compute_multi_payout`, `compute_multi_refund`)  | `encrypted-ixs/src/lib.rs`           |
| End-to-end test runner                                                                                                   | `tests/multi_outcome_e2e.ts`         |

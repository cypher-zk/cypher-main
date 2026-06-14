use arcis::*;

//  YesNo + MultiOutcome

//  Follows the EXACT Arcium docs pattern:
//  https://docs.arcium.com/developers/program

//  Enc<Shared,T> ← User-owned encrypted (needs pubkey + nonce in ArgBuilder)
//  Pools are now stored as plaintext u64 on-chain (in revealed_pool_0/1/2/3).
//  Individual bet side and amount remain private (Enc<Shared, BetInput>).

#[encrypted]
mod circuits {
    use arcis::*;

    //  SHARED TYPES

    /// User's bet — encrypted with their own key (Enc<Shared, BetInput>)
    /// Both amount AND side are private.
    pub struct BetInput {
        pub amount: u64, // net amount after fees (USDC micro)
        pub side: u8,    // YES/NO = 1/0  |  MultiOutcome = 0/1/2/3
    }

    //  CIRCUIT 1 — place_private_bet_yesno
    //
    //  Runs once per user bet on a YesNo market.
    //  Takes current plaintext pools + user's encrypted bet (Shared).
    //  Returns new pool totals and the user's locked entry_odds.
    //
    //  ArgBuilder order in lib.rs:
    //    .plaintext_u64(market.revealed_pool_0)   ← current YES pool total
    //    .plaintext_u64(market.revealed_pool_1)   ← current NO pool total
    //    .x25519_pubkey(pub_key)                  ← Enc<Shared> pubkey for BetInput
    //    .plaintext_u128(nonce)                   ← Enc<Shared> nonce
    //    .encrypted_u64(encrypted_amount)         ← BetInput.amount
    //    .encrypted_u8(encrypted_side)            ← BetInput.side

    #[instruction]
    pub fn place_private_bet_yesno(
        yes_pool: u64,
        no_pool: u64,
        bet: Enc<Shared, BetInput>,
    ) -> (u64, u64, u64) {
        let b = bet.to_arcis();

        let (new_yes, new_no) = if b.side == 1 {
            (yes_pool + b.amount, no_pool)
        } else {
            (yes_pool, no_pool + b.amount)
        };

        let total = new_yes + new_no;
        let side_pool = if b.side == 1 { new_yes } else { new_no };
        let entry_odds = if side_pool > 0 {
            total * 1_000_000_000 / side_pool
        } else {
            1_000_000_000
        };

        (new_yes.reveal(), new_no.reveal(), entry_odds.reveal())
    }

    //  CIRCUIT 2 — reveal_market_outcome_yesno
    //
    //  Runs ONCE when creator resolves the market.
    //  Takes plaintext pools and returns them plus the computed payout_ratio.
    //  Callback writes revealed_yes_pool, revealed_no_pool, payout_ratio to Market.
    //
    //  ArgBuilder order:
    //    .plaintext_u64(market.revealed_pool_0)  ← YES pool total
    //    .plaintext_u64(market.revealed_pool_1)  ← NO pool total
    //    .plaintext_u8(outcome_value)             ← 1=YES, 2=NO

    #[instruction]
    pub fn reveal_market_outcome_yesno(
        yes_pool: u64,
        no_pool: u64,
        outcome_value: u8,
    ) -> (u64, u64, u64) {
        let winner_pool = if outcome_value == 1 {
            yes_pool
        } else {
            no_pool
        };
        let total_pool = yes_pool + no_pool;

        let safe_divisor = if winner_pool > 0 { winner_pool } else { 1_u64 };
        let computed_ratio = total_pool * 1_000_000_000 / safe_divisor;
        let payout_ratio = if winner_pool > 0 { computed_ratio } else { 1_000_000_000 };

        (yes_pool.reveal(), no_pool.reveal(), payout_ratio.reveal())
    }

    //  CIRCUIT 3 — compute_yesno_payout
    //
    //  Runs once per user when they call claim_payout.
    //  Decrypts user's side + amount, checks against outcome.
    //  Returns PLAINTEXT payout + is_winner.
    //  Callback DIRECTLY TRANSFERS if winner.
    //
    //  ArgBuilder order:
    //    .x25519_pubkey(position.user_pubkey)
    //    .plaintext_u128(position.nonce)
    //    .encrypted_u64(position.encrypted_amount)   ← BetInput.amount
    //    .encrypted_u8(position.encrypted_side)      ← BetInput.side
    //    .plaintext_u8(market.outcome)               ← 1=YES, 2=NO
    //    .plaintext_u64(market.payout_ratio)         ← from reveal callback

    #[instruction]
    pub fn compute_yesno_payout(
        position_data: Enc<Shared, BetInput>,
        outcome: u8,       // plaintext — from Market
        payout_ratio: u64, // plaintext — from Market (scaled 1e9)
    ) -> (u64, bool) {
        let pos = position_data.to_arcis();

        let is_winner = pos.side == outcome;
        let payout = if is_winner {
            pos.amount * payout_ratio / 1_000_000_000
        } else {
            0
        };

        // both PLAINTEXT — callback transfers `payout` to user if `is_winner`
        (payout.reveal(), is_winner.reveal())
    }

    //  CIRCUIT 4 — compute_yesno_refund
    //
    //  Safety net — runs when market was NEVER resolved (creator disappeared).
    //  Decrypts user's bet amount and returns it as PLAINTEXT refund.
    //  Callback DIRECTLY TRANSFERS refund.
    //
    //  ArgBuilder order:
    //    .x25519_pubkey(position.user_pubkey)
    //    .plaintext_u128(position.nonce)
    //    .encrypted_u64(position.encrypted_amount)

    #[instruction]
    pub fn compute_yesno_refund(position_data: Enc<Shared, BetInput>) -> u64 {
        let pos = position_data.to_arcis();
        pos.amount.reveal()
    }

    //  CIRCUIT 5 — place_private_bet_multi
    //
    //  Same as yesno but with 4 plaintext pools.
    //  side = 0,1,2,3  (outcome index)
    //
    //  ArgBuilder order:
    //    .plaintext_u64(market.revealed_pool_0)
    //    .plaintext_u64(market.revealed_pool_1)
    //    .plaintext_u64(market.revealed_pool_2)
    //    .plaintext_u64(market.revealed_pool_3)
    //    .x25519_pubkey(pub_key)
    //    .plaintext_u128(nonce)
    //    .encrypted_u64(encrypted_amount)
    //    .encrypted_u8(encrypted_side)

    #[instruction]
    pub fn place_private_bet_multi(
        pool_0: u64,
        pool_1: u64,
        pool_2: u64,
        pool_3: u64,
        bet: Enc<Shared, BetInput>,
    ) -> (u64, u64, u64, u64, u64) {
        let b = bet.to_arcis();

        let (p0, p1, p2, p3) = match b.side {
            0 => (pool_0 + b.amount, pool_1, pool_2, pool_3),
            1 => (pool_0, pool_1 + b.amount, pool_2, pool_3),
            2 => (pool_0, pool_1, pool_2 + b.amount, pool_3),
            _ => (pool_0, pool_1, pool_2, pool_3 + b.amount),
        };

        let total = p0 + p1 + p2 + p3;
        let side_pool = match b.side {
            0 => p0,
            1 => p1,
            2 => p2,
            _ => p3,
        };
        let entry_odds = if side_pool > 0 {
            total * 1_000_000_000 / side_pool
        } else {
            1_000_000_000
        };

        (p0.reveal(), p1.reveal(), p2.reveal(), p3.reveal(), entry_odds.reveal())
    }

    //  CIRCUIT 6 — reveal_market_outcome_multi
    //
    //  Takes plaintext pools, returns them plus payout_ratio.
    //
    //  ArgBuilder order:
    //    .plaintext_u64(market.revealed_pool_0)
    //    .plaintext_u64(market.revealed_pool_1)
    //    .plaintext_u64(market.revealed_pool_2)
    //    .plaintext_u64(market.revealed_pool_3)
    //    .plaintext_u8(outcome_value)   ← 0/1/2/3

    #[instruction]
    pub fn reveal_market_outcome_multi(
        pool_0: u64,
        pool_1: u64,
        pool_2: u64,
        pool_3: u64,
        outcome_value: u8,
    ) -> (u64, u64, u64, u64, u64) {
        let winner_pool = match outcome_value {
            0 => pool_0,
            1 => pool_1,
            2 => pool_2,
            _ => pool_3,
        };

        let total = pool_0 + pool_1 + pool_2 + pool_3;

        let safe_divisor = if winner_pool > 0 { winner_pool } else { 1_u64 };
        let computed_ratio = total * 1_000_000_000 / safe_divisor;
        let payout_ratio = if winner_pool > 0 { computed_ratio } else { 1_000_000_000 };

        (
            pool_0.reveal(),
            pool_1.reveal(),
            pool_2.reveal(),
            pool_3.reveal(),
            payout_ratio.reveal(),
        )
    }

    //  CIRCUIT 7 — compute_multi_payout
    //
    //  Same logic as yesno but outcome_value is 0-3 instead of 1-2.
    //
    //  ArgBuilder order:
    //    .x25519_pubkey(position.user_pubkey)
    //    .plaintext_u128(position.nonce)
    //    .encrypted_u64(position.encrypted_amount)
    //    .encrypted_u8(position.encrypted_side)
    //    .plaintext_u8(market.outcome)       ← 0/1/2/3
    //    .plaintext_u64(market.payout_ratio)

    #[instruction]
    pub fn compute_multi_payout(
        position_data: Enc<Shared, BetInput>,
        outcome: u8,
        payout_ratio: u64,
    ) -> (u64, bool) {
        let pos = position_data.to_arcis();
        let is_winner = pos.side == outcome;
        let payout = if is_winner {
            pos.amount * payout_ratio / 1_000_000_000
        } else {
            0
        };
        (payout.reveal(), is_winner.reveal())
    }

    //  CIRCUIT 8 — compute_multi_refund
    //  Identical to yesno refund — just decrypt and return amount.

    #[instruction]
    pub fn compute_multi_refund(position_data: Enc<Shared, BetInput>) -> u64 {
        let pos = position_data.to_arcis();
        pos.amount.reveal()
    }
}

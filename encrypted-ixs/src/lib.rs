use arcis::*;

//  YesNo + MultiOutcome

//  Follows the EXACT Arcium docs pattern:
//  https://docs.arcium.com/developers/program

//  Enc<Mxe, T>   ← MXE-owned encrypted (pools stored on-chain, no pubkey needed)
//  Enc<Shared,T> ← User-owned encrypted (needs pubkey + nonce in ArgBuilder)

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
    /// Stored back on Market PDA — encrypted with MXE key
    pub struct YesNoPools {
        pub yes_pool: u64,
        pub no_pool: u64,
    }
    /// 4-outcome pool — stored on Market PDA — encrypted with MXE key
    pub struct MultiPools {
        pub pool_0: u64,
        pub pool_1: u64,
        pub pool_2: u64,
        pub pool_3: u64,
    }

    //  CIRCUIT 1 — place_private_bet_yesno
    //
    //  Runs once per user bet on a YesNo market.
    //  Takes current encrypted pools (MXE-owned) + user's encrypted bet (Shared).
    //  Updates the pools, locks entry_odds for this user.
    //
    //  ArgBuilder order in lib.rs:
    //    .plaintext_u128(market.mxe_nonce)        ← Enc<Mxe> nonce (shared by all fields)
    //    .encrypted_u64(market.encrypted_yes_pool)
    //    .encrypted_u64(market.encrypted_no_pool)
    //    .x25519_pubkey(pub_key)                  ← Enc<Shared> pubkey for BetInput
    //    .plaintext_u128(nonce)                   ← Enc<Shared> nonce
    //    .encrypted_u64(encrypted_amount)         ← BetInput.amount
    //    .encrypted_u8(encrypted_side)            ← BetInput.side

    #[instruction]
    pub fn place_private_bet_yesno(
        current_pools: Enc<Mxe, YesNoPools>,
        bet: Enc<Shared, BetInput>,
    ) -> (Enc<Mxe, YesNoPools>, u64) {
        // decrypt inside MXE
        let pools = current_pools.to_arcis();
        let b = bet.to_arcis();

        // update the correct pool
        let (new_yes, new_no) = if b.side == 1 {
            (pools.yes_pool + b.amount, pools.no_pool)
        } else {
            (pools.yes_pool, pools.no_pool + b.amount)
        };

        // entry_odds = total_pool / side_pool — locked for this user
        // stored as a u64 scaled by 1_000_000_000 (i.e. 1.5x = 1_500_000_000)
        let total = new_yes + new_no;
        let side_pool = if b.side == 1 { new_yes } else { new_no };
        let entry_odds = if side_pool > 0 {
            total * 1_000_000_000 / side_pool
        } else {
            1_000_000_000
        };

        // re-encrypt new pools for MXE storage
        let new_pools = current_pools.owner.from_arcis(YesNoPools {
            yes_pool: new_yes,
            no_pool: new_no,
        });

        // entry_odds returned as PLAINTEXT — stored publicly on EncryptedPosition
        (new_pools, entry_odds.reveal())
    }

    //  CIRCUIT 2 — reveal_market_outcome_yesno
    //
    //  Runs ONCE when creator resolves the market.
    //  Decrypts the two pools and returns them as PLAINTEXT.
    //  Callback writes revealed_yes_pool, revealed_no_pool, payout_ratio to Market.
    //
    //  ArgBuilder order:
    //    .plaintext_u128(market.mxe_nonce)
    //    .encrypted_u64(market.encrypted_yes_pool)
    //    .plaintext_u128(market.mxe_nonce)
    //    .encrypted_u64(market.encrypted_no_pool)
    //    .plaintext_u8(outcome_value)              ← 1=YES, 2=NO

    #[instruction]
    pub fn reveal_market_outcome_yesno(
        pools: Enc<Mxe, YesNoPools>,
        outcome_value: u8, // plaintext — provided by resolver
    ) -> (u64, u64, u64) {
        let pools = pools.to_arcis();

        let winner_pool = if outcome_value == 1 {
            pools.yes_pool
        } else {
            pools.no_pool
        };
        let total_pool = pools.yes_pool + pools.no_pool;

        // payout_ratio = total / winner scaled by 1e9
        let payout_ratio = if winner_pool > 0 {
            total_pool * 1_000_000_000 / winner_pool
        } else {
            1_000_000_000
        };

        // all PLAINTEXT — callback writes these to Market publicly
        (
            pools.yes_pool.reveal(),
            pools.no_pool.reveal(),
            payout_ratio.reveal(),
        )
    }

    //  CIRCUIT 3 — compute_yesno_payout
    //
    //  Runs once per user when they call claim_payout.
    //  Decrypts user's side + amount, checks against outcome.
    //  Returns PLAINTEXT payout + is_winner.
    //  Callback DIRECTLY TRANSFERS if winner.
    //
    //  ArgBuilder order:
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
    //    .plaintext_u128(position.nonce)
    //    .encrypted_u64(position.encrypted_amount)

    #[instruction]
    pub fn compute_yesno_refund(position_data: Enc<Shared, BetInput>) -> u64 {
        let pos = position_data.to_arcis();
        // return their exact net amount
        pos.amount.reveal()
    }

    //  CIRCUIT 5 — place_private_bet_multi
    //
    //  Same as yesno but with 4 encrypted pools.
    //  side = 0,1,2,3  (outcome index)
    //
    //  ArgBuilder order:
    //    .plaintext_u128(market.mxe_nonce)
    //    .encrypted_u64(market.encrypted_pool_0)   ← pool 0
    //    ... (repeat for pools 1,2,3)
    //    .x25519_pubkey(pub_key)
    //    .plaintext_u128(nonce)
    //    .encrypted_u64(encrypted_amount)
    //    .encrypted_u8(encrypted_side)

    #[instruction]
    pub fn place_private_bet_multi(
        current_pools: Enc<Mxe, MultiPools>,
        bet: Enc<Shared, BetInput>,
    ) -> (Enc<Mxe, MultiPools>, u64) {
        let pools = current_pools.to_arcis();
        let b = bet.to_arcis();

        let (p0, p1, p2, p3) = match b.side {
            0 => (
                pools.pool_0 + b.amount,
                pools.pool_1,
                pools.pool_2,
                pools.pool_3,
            ),
            1 => (
                pools.pool_0,
                pools.pool_1 + b.amount,
                pools.pool_2,
                pools.pool_3,
            ),
            2 => (
                pools.pool_0,
                pools.pool_1,
                pools.pool_2 + b.amount,
                pools.pool_3,
            ),
            _ => (
                pools.pool_0,
                pools.pool_1,
                pools.pool_2,
                pools.pool_3 + b.amount,
            ),
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

        let new_pools = current_pools.owner.from_arcis(MultiPools {
            pool_0: p0,
            pool_1: p1,
            pool_2: p2,
            pool_3: p3,
        });

        (new_pools, entry_odds.reveal())
    }

    //  CIRCUIT 6 — reveal_market_outcome_multi
    //
    //  Decrypts all 4 pools, returns plaintext + payout_ratio.
    //
    //  ArgBuilder order:
    //    .plaintext_u128(nonce) .encrypted_u64(pool_0)
    //    .plaintext_u128(nonce) .encrypted_u64(pool_1)
    //    .plaintext_u128(nonce) .encrypted_u64(pool_2)
    //    .plaintext_u128(nonce) .encrypted_u64(pool_3)
    //    .plaintext_u8(outcome_value)   ← 0/1/2/3

    #[instruction]
    pub fn reveal_market_outcome_multi(
        pools: Enc<Mxe, MultiPools>,
        outcome_value: u8,
    ) -> (u64, u64, u64, u64, u64) {
        let p = pools.to_arcis();

        let winner_pool = match outcome_value {
            0 => p.pool_0,
            1 => p.pool_1,
            2 => p.pool_2,
            _ => p.pool_3,
        };

        let total = p.pool_0 + p.pool_1 + p.pool_2 + p.pool_3;
        let payout_ratio = if winner_pool > 0 {
            total * 1_000_000_000 / winner_pool
        } else {
            1_000_000_000
        };

        // plaintext: pool_0, pool_1, pool_2, pool_3, payout_ratio
        (
            p.pool_0.reveal(),
            p.pool_1.reveal(),
            p.pool_2.reveal(),
            p.pool_3.reveal(),
            payout_ratio.reveal(),
        )
    }

    //  CIRCUIT 7 — compute_multi_payout
    //
    //  Same logic as yesno but outcome_value is 0-3 instead of 1-2.
    //
    //  ArgBuilder order:
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

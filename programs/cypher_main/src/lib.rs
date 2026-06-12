use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::Mint;
use arcium_anchor::prelude::*;

pub mod states;
use states::*;

declare_id!("F6pTnahcgW4gJX3iKxihmZGNUJN1jH4s77ijpK34FpFc");

// ─────────────────────────────────────────────────────────────────────────────
//  COMP DEF OFFSETS — one per circuit, name must match circuits.rs exactly
// ─────────────────────────────────────────────────────────────────────────────
const COMP_DEF_OFFSET_PLACE_BET_YESNO: u32 = comp_def_offset("place_private_bet_yesno");
const COMP_DEF_OFFSET_REVEAL_YESNO: u32 = comp_def_offset("reveal_market_outcome_yesno");
const COMP_DEF_OFFSET_PAYOUT_YESNO: u32 = comp_def_offset("compute_yesno_payout");
const COMP_DEF_OFFSET_REFUND_YESNO: u32 = comp_def_offset("compute_yesno_refund");

#[arcium_program]
pub mod cypher {
    use super::*;

    // ═════════════════════════════════════════════════════════════════════════
    //  1 — PROTOCOL SETUP
    // ═════════════════════════════════════════════════════════════════════════

    pub fn initialize(
        ctx: Context<Initialize>,
        protocol_fee_rate: u16,
        lp_fee_rate: u16,
    ) -> Result<()> {
        require!(protocol_fee_rate <= 100, CypherError::InvalidFeeRate); // max 1%
        require!(lp_fee_rate <= 500, CypherError::InvalidFeeRate); // max 5%

        let gs = &mut ctx.accounts.global_state;
        gs.market_counter = 0;
        gs.protocol_fee_rate = protocol_fee_rate;
        gs.lp_fee_rate = lp_fee_rate;
        gs.protocol_treasury = ctx.accounts.protocol_treasury.key();
        gs.accepted_mint = ctx.accounts.accepted_mint.key();
        gs.admin = ctx.accounts.admin.key();
        gs.bump = ctx.bumps.global_state;
        Ok(())
    }

    // ── 4 init comp defs (one per YesNo circuit) ─────────────────────────────

    pub fn init_place_bet_yesno_comp_def(ctx: Context<InitPlaceBetYesnoCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }
    pub fn init_reveal_yesno_comp_def(ctx: Context<InitRevealYesnoCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }
    pub fn init_payout_yesno_comp_def(ctx: Context<InitPayoutYesnoCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }
    pub fn init_refund_yesno_comp_def(ctx: Context<InitRefundYesnoCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  2 — MARKET LIFECYCLE
    // ═════════════════════════════════════════════════════════════════════════

    pub fn create_market(
        ctx: Context<CreateMarket>,
        question: String,
        close_time: i64,
    ) -> Result<()> {
        require!(!question.is_empty(), CypherError::EmptyQuestion);
        require!(question.len() <= 200, CypherError::QuestionTooLong);
        require!(
            close_time > Clock::get()?.unix_timestamp,
            CypherError::InvalidCloseTime
        );

        // Creator pays $10 bond into vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.creator_token_account.to_account_info(),
                    to: ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            CREATOR_BOND,
        )?;

        let gs = &mut ctx.accounts.global_state;
        let m = &mut ctx.accounts.market;
        let mid = gs.market_counter;

        let mut q = [0u8; 200];
        q[..question.len()].copy_from_slice(question.as_bytes());

        m.market_id = mid;
        m.question = q;
        m.question_len = question.len() as u8;
        m.market_type = MARKET_TYPE_YESNO;
        m.creator = ctx.accounts.creator.key();
        m.resolver = ctx.accounts.creator.key();
        m.creator_bond = CREATOR_BOND;
        m.bond_withdrawn = false;
        m.total_bets_count = 0;
        m.encrypted_pool_0 = [0u8; 32];
        m.encrypted_pool_1 = [0u8; 32];
        m.encrypted_pool_2 = [0u8; 32];
        m.encrypted_pool_3 = [0u8; 32];
        m.mxe_nonce = 0;
        m.revealed_pool_0 = 0;
        m.revealed_pool_1 = 0;
        m.revealed_pool_2 = 0;
        m.revealed_pool_3 = 0;
        m.state = MARKET_STATE_ACTIVE;
        m.outcome = 0;
        m.pending_outcome = 0;
        m.close_time = close_time;
        m.resolution_time = 0;
        m.payout_ratio = 0;
        m.accumulated_lp_fees = 0;
        m.accumulated_protocol_fees = 0;
        m.min_bet = MIN_BET_USDC;
        m.total_payouts_claimed = 0;
        m.total_refunds_claimed = 0;
        m.admin_claimed_remaining = false;
        m.resolution_deadline = close_time + DEFAULT_RESOLUTION_WINDOW;
        m.claim_deadline = 0;
        m.refund_deadline = 0;
        m.bump = ctx.bumps.market;
        m.vault_bump = ctx.bumps.market_vault;

        let lp = &mut ctx.accounts.lp_position;
        lp.lp_provider = ctx.accounts.creator.key();
        lp.market = ctx.accounts.market.key();
        lp.liquidity_provided = CREATOR_BOND;
        lp.fees_earned = 0;
        lp.fees_claimed = false;
        lp.fees_claimed_amount = 0;
        lp.bump = ctx.bumps.lp_position;

        gs.market_counter = gs
            .market_counter
            .checked_add(1)
            .ok_or(CypherError::Overflow)?;

        emit!(MarketCreatedEvent {
            market_id: mid,
            market_type: MARKET_TYPE_YESNO,
            creator: ctx.accounts.creator.key(),
            question,
            close_time,
        });
        Ok(())
    }

    pub fn cancel_market(ctx: Context<CancelMarket>) -> Result<()> {
        require!(
            ctx.accounts.market.total_bets_count == 0,
            CypherError::MarketHasBets
        );
        require!(
            ctx.accounts.market.state == MARKET_STATE_ACTIVE,
            CypherError::MarketNotActive
        );

        let market_key = ctx.accounts.market.key();
        let seeds: &[&[u8]] = &[
            b"market_vault",
            market_key.as_ref(),
            &[ctx.accounts.market.vault_bump],
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.creator_token_account.to_account_info(),
                    authority: ctx.accounts.market_vault.to_account_info(),
                },
                &[seeds],
            ),
            CREATOR_BOND,
        )?;

        emit!(MarketCancelledEvent {
            market: ctx.accounts.market.key(),
            creator: ctx.accounts.creator.key(),
            bond_returned: CREATOR_BOND,
        });
        Ok(())
    }

    pub fn withdraw_creator_funds(ctx: Context<WithdrawCreatorFunds>) -> Result<()> {
        require!(
            !ctx.accounts.market.bond_withdrawn,
            CypherError::BondAlreadyWithdrawn
        );
        require!(
            ctx.accounts.market.state == MARKET_STATE_RESOLVED,
            CypherError::NotResolved
        );

        let lp_fees = ctx.accounts.lp_position.fees_earned;
        let bond = ctx.accounts.market.creator_bond;
        let total = bond.checked_add(lp_fees).ok_or(CypherError::Overflow)?;

        let market_key = ctx.accounts.market.key();
        let seeds: &[&[u8]] = &[
            b"market_vault",
            market_key.as_ref(),
            &[ctx.accounts.market.vault_bump],
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.creator_token_account.to_account_info(),
                    authority: ctx.accounts.market_vault.to_account_info(),
                },
                &[seeds],
            ),
            total,
        )?;

        ctx.accounts.market.bond_withdrawn = true;
        ctx.accounts.lp_position.fees_claimed = true;
        ctx.accounts.lp_position.fees_claimed_amount = lp_fees;

        emit!(CreatorWithdrawnEvent {
            market: ctx.accounts.market.key(),
            creator: ctx.accounts.creator.key(),
            bond,
            lp_fees,
            total,
        });
        Ok(())
    }

    pub fn admin_claim_remaining(ctx: Context<AdminClaimRemaining>) -> Result<()> {
        require!(
            !ctx.accounts.market.admin_claimed_remaining,
            CypherError::AdminAlreadyClaimed
        );
        require!(
            Clock::get()?.unix_timestamp > ctx.accounts.market.refund_deadline,
            CypherError::ResolutionDeadlineNotReached
        );
        let balance = ctx.accounts.market_vault.amount;
        require!(balance > 0, CypherError::InsufficientVaultBalance);

        let market_key = ctx.accounts.market.key();
        let seeds: &[&[u8]] = &[
            b"market_vault",
            market_key.as_ref(),
            &[ctx.accounts.market.vault_bump],
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.protocol_treasury.to_account_info(),
                    authority: ctx.accounts.market_vault.to_account_info(),
                },
                &[seeds],
            ),
            balance,
        )?;
        ctx.accounts.market.admin_claimed_remaining = true;
        Ok(())
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  3 — YESNO CIRCUITS
    // ═════════════════════════════════════════════════════════════════════════

    // ── 3a  place_private_bet_yesno ──────────────────────────────────────────
    //
    //  KEY CHANGE from previous version:
    //  The EncryptedPosition PDA is INITIALISED HERE in the queue instruction,
    //  storing the original user ciphertexts (encrypted_amount, encrypted_side,
    //  user_pubkey, nonce) BEFORE the circuit runs.
    //
    //  The callback then just writes entry_odds + updates the market pools.
    //  This is necessary because the circuit only returns (new_pools, entry_odds)
    //  with no re-encrypted position data.

    pub fn place_private_bet_yesno(
        ctx: Context<PlacePrivateBetYesno>,
        computation_offset: u64,
        bet_amount_usdc: u64,       // PUBLIC — actual USDC to transfer
        encrypted_amount: [u8; 32], // ENCRYPTED — net after fees (Enc<Shared>)
        encrypted_side: [u8; 32],   // ENCRYPTED — 0=NO or 1=YES (Enc<Shared>)
        pub_key: [u8; 32],          // user's x25519 pubkey
        nonce: u128,
    ) -> Result<()> {
        require!(
            ctx.accounts.market.state == MARKET_STATE_ACTIVE,
            CypherError::MarketNotActive
        );
        require!(
            Clock::get()?.unix_timestamp < ctx.accounts.market.close_time,
            CypherError::MarketClosed
        );
        require!(
            bet_amount_usdc >= ctx.accounts.market.min_bet,
            CypherError::BetTooSmall
        );

        // ── Fees ──────────────────────────────────────────────────────────────
        let protocol_fee = bet_amount_usdc
            .checked_mul(ctx.accounts.global_state.protocol_fee_rate as u64)
            .ok_or(CypherError::Overflow)?
            .checked_div(10_000)
            .ok_or(CypherError::Overflow)?;

        let lp_fee = bet_amount_usdc
            .checked_mul(ctx.accounts.global_state.lp_fee_rate as u64)
            .ok_or(CypherError::Overflow)?
            .checked_div(10_000)
            .ok_or(CypherError::Overflow)?;

        // Transfer full amount into vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            bet_amount_usdc,
        )?;

        // Send protocol fee from vault to treasury
        if protocol_fee > 0 {
            let market_key = ctx.accounts.market.key();
            let seeds: &[&[u8]] = &[
                b"market_vault",
                market_key.as_ref(),
                &[ctx.accounts.market.vault_bump],
            ];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.market_vault.to_account_info(),
                        to: ctx.accounts.protocol_treasury.to_account_info(),
                        authority: ctx.accounts.market_vault.to_account_info(),
                    },
                    &[seeds],
                ),
                protocol_fee,
            )?;
            ctx.accounts.market.accumulated_protocol_fees = ctx
                .accounts
                .market
                .accumulated_protocol_fees
                .checked_add(protocol_fee)
                .ok_or(CypherError::Overflow)?;
        }

        // Accrue LP fee in LPPosition (stays in vault, withdrawn later)
        ctx.accounts.lp_position.fees_earned = ctx
            .accounts
            .lp_position
            .fees_earned
            .checked_add(lp_fee)
            .ok_or(CypherError::Overflow)?;
        ctx.accounts.market.accumulated_lp_fees = ctx
            .accounts
            .market
            .accumulated_lp_fees
            .checked_add(lp_fee)
            .ok_or(CypherError::Overflow)?;

        // ── Init EncryptedPosition NOW (before circuit runs) ──────────────────
        //  Stores original user ciphertexts so they're available for compute_payout later.
        //  entry_odds is 0 here — the callback will fill it in after circuit completes.
        let pos = &mut ctx.accounts.position;
        pos.user = ctx.accounts.user.key();
        pos.market = ctx.accounts.market.key();
        pos.encrypted_amount = encrypted_amount; // original Enc<Shared> ciphertext
        pos.encrypted_side = encrypted_side; // original Enc<Shared> ciphertext
        pos.user_pubkey = pub_key; // needed by MXE to re-derive shared key
        pos.nonce = nonce;
        pos.entry_odds = 0; // placeholder — callback fills this
        pos.claimed = false;
        pos.bump = ctx.bumps.position;

        // ── Queue the Arcium computation ───────────────────────────────────────
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let m = &ctx.accounts.market;
        let args = ArgBuilder::new()
            // Enc<Mxe, YesNoPools>: yes_pool then no_pool
            // Enc<Mxe> only needs nonce + ciphertext (no pubkey)
            .plaintext_u128(m.mxe_nonce)
            .encrypted_u64(m.encrypted_pool_0) // yes_pool
            .plaintext_u128(m.mxe_nonce)
            .encrypted_u64(m.encrypted_pool_1) // no_pool
            // Enc<Shared, BetInput>: amount then side
            // Enc<Shared> needs pubkey + nonce + ciphertexts
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_amount) // BetInput.amount
            .encrypted_u8(encrypted_side) // BetInput.side
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![PlacePrivateBetYesnoCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[], // no extra accounts needed — position already exists
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    // ── Callback: receives (new_pools, entry_odds) from circuit ──────────────
    //  field_0 = MXEEncryptedStruct (new yes/no pools)
    //  field_1 = u64 (entry_odds, revealed plaintext)
    //  No pos_data — position was already created in the queue instruction.

    #[arcium_callback(encrypted_ix = "place_private_bet_yesno")]
    pub fn place_private_bet_yesno_callback(
        ctx: Context<PlacePrivateBetYesnoCallback>,
        output: SignedComputationOutputs<PlacePrivateBetYesnoOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(PlacePrivateBetYesnoOutput { field_0 }) => field_0,
            Err(_) => return Err(CypherError::ComputationVerificationFailed.into()),
        };

        // field_0.field_0 = MXEEncryptedStruct with new pool ciphertexts
        // field_0.field_1 = u64 entry_odds (revealed)
        let new_pools = &o.field_0; // MXEEncryptedStruct<2>
        let entry_odds = o.field_1; // plaintext u64

        // Update market pools
        ctx.accounts.market.encrypted_pool_0 = new_pools.ciphertexts[0]; // new YES pool
        ctx.accounts.market.encrypted_pool_1 = new_pools.ciphertexts[1]; // new NO  pool
        ctx.accounts.market.mxe_nonce = new_pools.nonce;
        ctx.accounts.market.total_bets_count = ctx
            .accounts
            .market
            .total_bets_count
            .checked_add(1)
            .ok_or(CypherError::Overflow)?;

        // Write entry_odds onto the already-existing position
        ctx.accounts.position.entry_odds = entry_odds;

        emit!(BetPlacedEvent {
            market: ctx.accounts.market.key(),
            user: ctx.accounts.position.user,
            encrypted_amount: ctx.accounts.position.encrypted_amount,
            encrypted_side: ctx.accounts.position.encrypted_side,
            nonce: ctx.accounts.position.nonce,
            entry_odds,
        });
        Ok(())
    }

    // ── 3b  resolve_market_yesno ─────────────────────────────────────────────

    pub fn resolve_market_yesno(
        ctx: Context<ResolveMarketYesno>,
        computation_offset: u64,
        outcome_value: u8, // 1=YES, 2=NO
    ) -> Result<()> {
        require!(
            ctx.accounts.market.state == MARKET_STATE_ACTIVE,
            CypherError::MarketNotActive
        );
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.market.close_time,
            CypherError::MarketStillOpen
        );
        require!(
            outcome_value == 1 || outcome_value == 2,
            CypherError::InvalidOutcome
        );

        ctx.accounts.market.pending_outcome = outcome_value;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let m = &ctx.accounts.market;
        let args = ArgBuilder::new()
            // Enc<Mxe, YesNoPools>
            .plaintext_u128(m.mxe_nonce)
            .encrypted_u64(m.encrypted_pool_0)
            .plaintext_u128(m.mxe_nonce)
            .encrypted_u64(m.encrypted_pool_1)
            // plaintext outcome
            .plaintext_u8(outcome_value)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RevealMarketOutcomeYesnoCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "reveal_market_outcome_yesno")]
    pub fn reveal_market_outcome_yesno_callback(
        ctx: Context<RevealMarketOutcomeYesnoCallback>,
        output: SignedComputationOutputs<RevealMarketOutcomeYesnoOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(RevealMarketOutcomeYesnoOutput { field_0 }) => field_0,
            Err(_) => return Err(CypherError::ComputationVerificationFailed.into()),
        };

        // All three are revealed plaintext u64
        let yes_pool = o.field_0;
        let no_pool = o.field_1;
        let payout_ratio = o.field_2;
        let now = Clock::get()?.unix_timestamp;

        let m = &mut ctx.accounts.market;
        m.revealed_pool_0 = yes_pool;
        m.revealed_pool_1 = no_pool;
        m.payout_ratio = payout_ratio;
        m.state = MARKET_STATE_RESOLVED;
        m.outcome = m.pending_outcome;
        m.resolution_time = now;
        m.claim_deadline = now + DEFAULT_CLAIM_PERIOD;
        m.refund_deadline = now + DEFAULT_CLAIM_PERIOD + DEFAULT_REFUND_PERIOD;

        emit!(MarketResolvedEvent {
            market: m.key(),
            outcome: m.outcome,
            revealed_pool_0: yes_pool,
            revealed_pool_1: no_pool,
            revealed_pool_2: 0,
            revealed_pool_3: 0,
            payout_ratio,
        });
        Ok(())
    }

    // ── 3c  claim_payout_yesno ───────────────────────────────────────────────
    //
    //  KEY CHANGE: ArgBuilder now uses Enc<Shared> pattern
    //  (.x25519_pubkey + .plaintext_u128 + encrypted ciphertexts)
    //  because position stores the ORIGINAL user ciphertexts, not MXE-re-encrypted ones.

    pub fn claim_payout_yesno(
        ctx: Context<ClaimPayoutYesno>,
        computation_offset: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.position.claimed, CypherError::AlreadyClaimed);
        require!(
            ctx.accounts.market.state == MARKET_STATE_RESOLVED,
            CypherError::NotResolved
        );
        require!(
            Clock::get()?.unix_timestamp <= ctx.accounts.market.claim_deadline,
            CypherError::ClaimPeriodExpired
        );

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let pos = &ctx.accounts.position;
        let m = &ctx.accounts.market;

        let args = ArgBuilder::new()
            // Enc<Shared, BetInput> — original user ciphertexts
            // MXE re-derives shared key from pos.user_pubkey
            .x25519_pubkey(pos.user_pubkey) // ← KEY CHANGE: was missing before
            .plaintext_u128(pos.nonce)
            .encrypted_u64(pos.encrypted_amount)
            .encrypted_u8(pos.encrypted_side)
            // plaintext market state
            .plaintext_u8(m.outcome)
            .plaintext_u64(m.payout_ratio)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ComputeYesnoPayoutCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "compute_yesno_payout")]
    pub fn compute_yesno_payout_callback(
        ctx: Context<ComputeYesnoPayoutCallback>,
        output: SignedComputationOutputs<ComputeYesnoPayoutOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(ComputeYesnoPayoutOutput { field_0 }) => field_0,
            Err(_) => return Err(CypherError::ComputationVerificationFailed.into()),
        };

        let payout_amount = o.field_0; // revealed u64
        let is_winner = o.field_1; // revealed bool

        ctx.accounts.position.claimed = true;

        if is_winner && payout_amount > 0 {
            let market_key = ctx.accounts.market.key();
            let seeds: &[&[u8]] = &[
                b"market_vault",
                market_key.as_ref(),
                &[ctx.accounts.market.vault_bump],
            ];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.market_vault.to_account_info(),
                        to: ctx.accounts.user_token_account.to_account_info(),
                        authority: ctx.accounts.market_vault.to_account_info(),
                    },
                    &[seeds],
                ),
                payout_amount,
            )?;
            ctx.accounts.market.total_payouts_claimed = ctx
                .accounts
                .market
                .total_payouts_claimed
                .checked_add(payout_amount)
                .ok_or(CypherError::Overflow)?;

            emit!(PayoutClaimedEvent {
                market: ctx.accounts.market.key(),
                user: ctx.accounts.user.key(),
                payout_amount,
            });
        }
        Ok(())
    }

    // ── 3d  claim_refund_yesno ───────────────────────────────────────────────
    //  Same Enc<Shared> pattern as claim_payout.

    pub fn claim_refund_yesno(
        ctx: Context<ClaimRefundYesno>,
        computation_offset: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.position.claimed, CypherError::AlreadyClaimed);
        require!(
            Clock::get()?.unix_timestamp > ctx.accounts.market.resolution_deadline,
            CypherError::ResolutionDeadlineNotReached
        );
        require!(
            ctx.accounts.market.state != MARKET_STATE_RESOLVED,
            CypherError::AlreadyResolved
        );

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let pos = &ctx.accounts.position;

        let args = ArgBuilder::new()
            // Enc<Shared, BetInput> — same pattern as claim_payout
            .x25519_pubkey(pos.user_pubkey) // ← KEY CHANGE
            .plaintext_u128(pos.nonce)
            .encrypted_u64(pos.encrypted_amount)
            .encrypted_u8(pos.encrypted_side)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ComputeYesnoRefundCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "compute_yesno_refund")]
    pub fn compute_yesno_refund_callback(
        ctx: Context<ComputeYesnoRefundCallback>,
        output: SignedComputationOutputs<ComputeYesnoRefundOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(ComputeYesnoRefundOutput { field_0 }) => field_0,
            Err(_) => return Err(CypherError::ComputationVerificationFailed.into()),
        };

        // o IS the u64 directly — circuit returns a single value so field_0
        // is destructured and becomes `o` itself, not a struct with sub-fields.
        // Using o.field_0 here would be E0610 ("primitive type has no fields").
        let refund_amount = o;

        ctx.accounts.position.claimed = true;

        if refund_amount > 0 {
            let market_key = ctx.accounts.market.key();
            let seeds: &[&[u8]] = &[
                b"market_vault",
                market_key.as_ref(),
                &[ctx.accounts.market.vault_bump],
            ];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.market_vault.to_account_info(),
                        to: ctx.accounts.user_token_account.to_account_info(),
                        authority: ctx.accounts.market_vault.to_account_info(),
                    },
                    &[seeds],
                ),
                refund_amount,
            )?;
            ctx.accounts.market.total_refunds_claimed = ctx
                .accounts
                .market
                .total_refunds_claimed
                .checked_add(refund_amount)
                .ok_or(CypherError::Overflow)?;

            emit!(RefundClaimedEvent {
                market: ctx.accounts.market.key(),
                user: ctx.accounts.user.key(),
                refund_amount,
            });
        }
        Ok(())
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  ACCOUNT CONTEXTS
//  All queue contexts: full Arcium account set from docs.arcium.com/developers/program
// ═════════════════════════════════════════════════════════════════════════════

// ── Non-Arcium ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = GLOBAL_STATE_SPACE, seeds = [b"global_state"], bump)]
    pub global_state: Account<'info, GlobalState>,
    /// CHECK: treasury wallet
    pub protocol_treasury: UncheckedAccount<'info>,
    pub accepted_mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(mut, seeds = [b"global_state"], bump = global_state.bump)]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        init, payer = creator, space = MARKET_SPACE,
        seeds = [b"market", global_state.market_counter.to_le_bytes().as_ref()],
        bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        init, payer = creator, space = LP_POSITION_SPACE,
        seeds = [b"lp-position", market.key().as_ref(), creator.key().as_ref()],
        bump,
    )]
    pub lp_position: Account<'info, LPPosition>,

    #[account(
        init, payer = creator,
        token::mint = accepted_mint,
        token::authority = market_vault,
        seeds = [b"market_vault", market.key().as_ref()],
        bump,
    )]
    pub market_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = creator_token_account.owner == creator.key(),
        constraint = creator_token_account.mint == global_state.accepted_mint @ CypherError::WrongMint,
    )]
    pub creator_token_account: Account<'info, TokenAccount>,

    pub accepted_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump,
        constraint = market.creator == creator.key() @ CypherError::NotMarketCreator)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"market_vault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"lp-position", market.key().as_ref(), creator.key().as_ref()], bump = lp_position.bump)]
    pub lp_position: Account<'info, LPPosition>,
    #[account(mut, constraint = creator_token_account.owner == creator.key())]
    pub creator_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawCreatorFunds<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump,
        constraint = market.creator == creator.key() @ CypherError::NotMarketCreator)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"lp-position", market.key().as_ref(), creator.key().as_ref()], bump = lp_position.bump)]
    pub lp_position: Account<'info, LPPosition>,
    #[account(mut, seeds = [b"market_vault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = creator_token_account.owner == creator.key())]
    pub creator_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminClaimRemaining<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"global_state"], bump = global_state.bump,
        constraint = global_state.admin == admin.key() @ CypherError::UnauthorizedAdmin)]
    pub global_state: Account<'info, GlobalState>,
    #[account(mut, seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"market_vault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = protocol_treasury.key() == global_state.protocol_treasury)]
    pub protocol_treasury: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ── Init Comp Def contexts ────────────────────────────────────────────────────
// Structure from https://docs.arcium.com/developers/program — same for all 4.

#[init_computation_definition_accounts("place_private_bet_yesno", payer)]
#[derive(Accounts)]
pub struct InitPlaceBetYesnoCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("reveal_market_outcome_yesno", payer)]
#[derive(Accounts)]
pub struct InitRevealYesnoCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("compute_yesno_payout", payer)]
#[derive(Accounts)]
pub struct InitPayoutYesnoCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("compute_yesno_refund", payer)]
#[derive(Accounts)]
pub struct InitRefundYesnoCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ── PlacePrivateBetYesno queue context ───────────────────────────────────────
//
//  KEY CHANGE: position is now INIT HERE (not in callback).
//  Contains the full Arcium account set from the docs.

#[queue_computation_accounts("place_private_bet_yesno", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct PlacePrivateBetYesno<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,

    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,

    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,

    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,

    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PLACE_BET_YESNO))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,

    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,

    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,

    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,

    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,

    // ── Custom protocol accounts ──────────────────────────────────────────
    pub user: Signer<'info>,

    #[account(seeds = [b"global_state"], bump = global_state.bump)]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [b"market", market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [b"lp-position", market.key().as_ref(), market.creator.as_ref()],
        bump = lp_position.bump,
    )]
    pub lp_position: Account<'info, LPPosition>,

    #[account(mut, seeds = [b"market_vault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key(),
        constraint = user_token_account.mint == global_state.accepted_mint @ CypherError::WrongMint,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut, constraint = protocol_treasury.key() == global_state.protocol_treasury)]
    pub protocol_treasury: Account<'info, TokenAccount>,

    // ── EncryptedPosition: INIT HERE (not in callback) ────────────────────
    #[account(
        init,
        payer = payer,
        space = ENCRYPTED_POSITION_SPACE,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, EncryptedPosition>,

    pub token_program: Program<'info, Token>,
}

// ── PlacePrivateBetYesnoCallback ─────────────────────────────────────────────
//  Position is now just MUT (already exists from queue instruction).

#[callback_accounts("place_private_bet_yesno")]
#[derive(Accounts)]
pub struct PlacePrivateBetYesnoCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,

    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PLACE_BET_YESNO))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,

    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,

    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,

    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,

    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,

    // Custom — both already exist, just update them
    #[account(mut)]
    pub market: Account<'info, Market>,

    #[account(mut)]
    pub position: Account<'info, EncryptedPosition>,
}

// ── ResolveMarketYesno ────────────────────────────────────────────────────────

#[queue_computation_accounts("reveal_market_outcome_yesno", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ResolveMarketYesno<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: execpool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: comp
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_YESNO))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    // Custom
    pub resolver: Signer<'info>,
    #[account(mut,
        seeds = [b"market", market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        constraint = market.resolver == resolver.key() @ CypherError::UnauthorizedResolver,
    )]
    pub market: Account<'info, Market>,
}

#[callback_accounts("reveal_market_outcome_yesno")]
#[derive(Accounts)]
pub struct RevealMarketOutcomeYesnoCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_YESNO))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: pub computation_account: UncheckedAccount<'info>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK:
    pub instructions_sysvar: UncheckedAccount<'info>,
    // Custom
    #[account(mut)]
    pub market: Account<'info, Market>,
}

// ── ClaimPayoutYesno ──────────────────────────────────────────────────────────

#[queue_computation_accounts("compute_yesno_payout", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ClaimPayoutYesno<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: execpool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: comp
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PAYOUT_YESNO))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    // Custom
    pub user: Signer<'info>,
    #[account(seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.user == user.key(),
    )]
    pub position: Account<'info, EncryptedPosition>,
}

#[callback_accounts("compute_yesno_payout")]
#[derive(Accounts)]
pub struct ComputeYesnoPayoutCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PAYOUT_YESNO))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: pub computation_account: UncheckedAccount<'info>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK:
    pub instructions_sysvar: UncheckedAccount<'info>,
    // Custom — callback directly transfers USDC to winner
    #[account(mut)]
    pub position: Account<'info, EncryptedPosition>,
    /// CHECK: user wallet receiving payout
    #[account(mut)]
    pub user: UncheckedAccount<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// ── ClaimRefundYesno ──────────────────────────────────────────────────────────

#[queue_computation_accounts("compute_yesno_refund", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ClaimRefundYesno<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: execpool
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: comp
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REFUND_YESNO))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    // Custom
    pub user: Signer<'info>,
    #[account(seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.user == user.key(),
    )]
    pub position: Account<'info, EncryptedPosition>,
}

#[callback_accounts("compute_yesno_refund")]
#[derive(Accounts)]
pub struct ComputeYesnoRefundCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REFUND_YESNO))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: pub computation_account: UncheckedAccount<'info>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK:
    pub instructions_sysvar: UncheckedAccount<'info>,
    // Custom — direct refund transfer
    #[account(mut)]
    pub position: Account<'info, EncryptedPosition>,
    /// CHECK: user wallet
    #[account(mut)]
    pub user: UncheckedAccount<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

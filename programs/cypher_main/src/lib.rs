use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::Mint;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount as ArciumCallbackAccount;

pub mod states;
use states::*;

declare_id!("F6pTnahcgW4gJX3iKxihmZGNUJN1jH4s77ijpK34FpFc");

// comp def offsets for yes/no market operations

const COMP_DEF_OFFSET_PLACE_BET_YESNO: u32 = comp_def_offset("place_private_bet_yesno");
const COMP_DEF_OFFSET_REVEAL_YESNO: u32 = comp_def_offset("reveal_market_outcome_yesno");
const COMP_DEF_OFFSET_PAYOUT_YESNO: u32 = comp_def_offset("compute_yesno_payout");
const COMP_DEF_OFFSET_REFUND_YESNO: u32 = comp_def_offset("compute_yesno_refund");

// ── MultiOutcome comp def offsets ────────────────────────────────────────────
const COMP_DEF_OFFSET_PLACE_BET_MULTI: u32 = comp_def_offset("place_private_bet_multi");
const COMP_DEF_OFFSET_REVEAL_MULTI: u32 = comp_def_offset("reveal_market_outcome_multi");
const COMP_DEF_OFFSET_PAYOUT_MULTI: u32 = comp_def_offset("compute_multi_payout");
const COMP_DEF_OFFSET_REFUND_MULTI: u32 = comp_def_offset("compute_multi_refund");

#[arcium_program]
pub mod cypher {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        protocol_fee_rate: u16,
        lp_fee_rate: u16,
    ) -> Result<()> {
        require!(protocol_fee_rate <= 100, CypherError::InvalidFeeRate);
        require!(lp_fee_rate <= 500, CypherError::InvalidFeeRate);
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

    // init def accounts for yes/no market operations

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

    // init def accounts for multioutcome market operations

    pub fn init_place_bet_multi_comp_def(ctx: Context<InitPlaceBetMultiCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }
    pub fn init_reveal_multi_comp_def(ctx: Context<InitRevealMultiCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }
    pub fn init_payout_multi_comp_def(ctx: Context<InitPayoutMultiCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }
    pub fn init_refund_multi_comp_def(ctx: Context<InitRefundMultiCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        question: String,
        close_time: i64,
        category: u8,
    ) -> Result<()> {
        require!(!question.is_empty(), CypherError::EmptyQuestion);
        require!(question.len() <= 200, CypherError::QuestionTooLong);
        require!(
            close_time > Clock::get()?.unix_timestamp,
            CypherError::InvalidCloseTime
        );
        require!(category <= 6, CypherError::InvalidCategory);

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
        m.category = category;
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
            category,
            creator: ctx.accounts.creator.key(),
            question,
            close_time,
        });
        Ok(())
    }

    // Creates a MultiOutcome market with 2-4 outcomes.
    // num_outcomes: how many choices bettors have (2, 3, or 4)
    // outcome labels are handled off-chain — store them in your backend/frontend
    pub fn create_market_multi(
        ctx: Context<CreateMarketMulti>,
        question: String,
        close_time: i64,
        category: u8,
        num_outcomes: u8,
    ) -> Result<()> {
        require!(!question.is_empty(), CypherError::EmptyQuestion);
        require!(question.len() <= 200, CypherError::QuestionTooLong);
        require!(
            close_time > Clock::get()?.unix_timestamp,
            CypherError::InvalidCloseTime
        );
        require!(category <= 6, CypherError::InvalidCategory);
        require!(
            num_outcomes >= 2 && num_outcomes <= 4,
            CypherError::InvalidOutcome
        );

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
        m.market_type = MARKET_TYPE_MULTIOUTCOME;
        m.num_outcomes = num_outcomes;
        m.category = category;
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
            market_type: MARKET_TYPE_MULTIOUTCOME,
            category,
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
        ctx.accounts.market.state = MARKET_STATE_CLOSED;
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

        let lp_fees = ctx.accounts.market.accumulated_lp_fees;
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
        let now = Clock::get()?.unix_timestamp;
        let market = &ctx.accounts.market;
        if market.state == MARKET_STATE_RESOLVED {
            require!(
                now > market.refund_deadline,
                CypherError::ResolutionDeadlineNotReached
            );
        } else {
            require!(
                now > market.resolution_deadline + DEFAULT_REFUND_PERIOD,
                CypherError::ResolutionDeadlineNotReached
            );
        }
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

    pub fn place_private_bet_yesno(
        ctx: Context<PlacePrivateBetYesno>,
        computation_offset: u64,
        bet_amount_usdc: u64,
        encrypted_amount: [u8; 32],
        encrypted_side: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(
            ctx.accounts.market.market_type == MARKET_TYPE_YESNO,
            CypherError::WrongMarketType
        );
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

        ctx.accounts.market.accumulated_lp_fees = ctx
            .accounts
            .market
            .accumulated_lp_fees
            .checked_add(lp_fee)
            .ok_or(CypherError::Overflow)?;

        let net_amount = bet_amount_usdc
            .checked_sub(protocol_fee)
            .ok_or(CypherError::Overflow)?
            .checked_sub(lp_fee)
            .ok_or(CypherError::Overflow)?;

        let pos = &mut ctx.accounts.position;
        pos.user = ctx.accounts.user.key();
        pos.market = ctx.accounts.market.key();
        pos.encrypted_amount = encrypted_amount;
        pos.encrypted_side = encrypted_side;
        pos.user_pubkey = pub_key;
        pos.nonce = nonce;
        pos.entry_odds = 0;
        pos.net_amount = net_amount;
        pos.claimed = false;
        pos.bump = ctx.bumps.position;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let m = &ctx.accounts.market;
        msg!(
            "CYPHER_DBG bet_ix: yes_pool={} no_pool={}",
            m.revealed_pool_0,
            m.revealed_pool_1,
        );
        let args = ArgBuilder::new()
            .plaintext_u64(m.revealed_pool_0)
            .plaintext_u64(m.revealed_pool_1)
            .plaintext_u64(net_amount)
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_amount)
            .encrypted_u8(encrypted_side)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![PlacePrivateBetYesnoCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.market.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.position.key(),
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

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

        let new_yes = o.field_0;
        let new_no = o.field_1;
        let entry_odds = o.field_2;

        msg!(
            "CYPHER_DBG bet_callback: new_yes={} new_no={} odds={}",
            new_yes,
            new_no,
            entry_odds,
        );

        ctx.accounts.market.revealed_pool_0 = new_yes;
        ctx.accounts.market.revealed_pool_1 = new_no;
        ctx.accounts.market.total_bets_count = ctx
            .accounts
            .market
            .total_bets_count
            .checked_add(1)
            .ok_or(CypherError::Overflow)?;
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

    // User passes encrypted_side as outcome index (0, 1, 2, or 3)
    // Only valid indices 0..num_outcomes-1 are meaningful — circuit handles garbage naturally
    pub fn place_private_bet_multi(
        ctx: Context<PlacePrivateBetMulti>,
        computation_offset: u64,
        bet_amount_usdc: u64,
        encrypted_amount: [u8; 32],
        encrypted_side: [u8; 32], // outcome index 0-3 encrypted
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(
            ctx.accounts.market.market_type == MARKET_TYPE_MULTIOUTCOME,
            CypherError::WrongMarketType
        );
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

        ctx.accounts.market.accumulated_lp_fees = ctx
            .accounts
            .market
            .accumulated_lp_fees
            .checked_add(lp_fee)
            .ok_or(CypherError::Overflow)?;

        let net_amount = bet_amount_usdc
            .checked_sub(protocol_fee)
            .ok_or(CypherError::Overflow)?
            .checked_sub(lp_fee)
            .ok_or(CypherError::Overflow)?;

        // Init position before circuit runs — same pattern as YesNo
        let pos = &mut ctx.accounts.position;
        pos.user = ctx.accounts.user.key();
        pos.market = ctx.accounts.market.key();
        pos.encrypted_amount = encrypted_amount;
        pos.encrypted_side = encrypted_side;
        pos.user_pubkey = pub_key;
        pos.nonce = nonce;
        pos.entry_odds = 0;
        pos.net_amount = net_amount;
        pos.claimed = false;
        pos.bump = ctx.bumps.position;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let m = &ctx.accounts.market;
        let args = ArgBuilder::new()
            .plaintext_u64(m.revealed_pool_0)
            .plaintext_u64(m.revealed_pool_1)
            .plaintext_u64(m.revealed_pool_2)
            .plaintext_u64(m.revealed_pool_3)
            .plaintext_u64(net_amount)
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_amount)
            .encrypted_u8(encrypted_side)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![PlacePrivateBetMultiCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.market.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.position.key(),
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "place_private_bet_multi")]
    pub fn place_private_bet_multi_callback(
        ctx: Context<PlacePrivateBetMultiCallback>,
        output: SignedComputationOutputs<PlacePrivateBetMultiOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(PlacePrivateBetMultiOutput { field_0 }) => field_0,
            Err(_) => return Err(CypherError::ComputationVerificationFailed.into()),
        };

        let new_p0 = o.field_0;
        let new_p1 = o.field_1;
        let new_p2 = o.field_2;
        let new_p3 = o.field_3;
        let entry_odds = o.field_4;

        let m = &mut ctx.accounts.market;
        m.revealed_pool_0 = new_p0;
        m.revealed_pool_1 = new_p1;
        m.revealed_pool_2 = new_p2;
        m.revealed_pool_3 = new_p3;
        m.total_bets_count = m
            .total_bets_count
            .checked_add(1)
            .ok_or(CypherError::Overflow)?;

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

    pub fn resolve_market_yesno(
        ctx: Context<ResolveMarketYesno>,
        computation_offset: u64,
        outcome_value: u8,
    ) -> Result<()> {
        require!(
            ctx.accounts.market.market_type == MARKET_TYPE_YESNO,
            CypherError::WrongMarketType
        );
        require!(
            ctx.accounts.market.state == MARKET_STATE_ACTIVE,
            CypherError::MarketNotActive
        );
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.market.close_time,
            CypherError::MarketStillOpen
        );
        require!(
            outcome_value == 0 || outcome_value == 1,
            CypherError::InvalidOutcome
        );

        ctx.accounts.market.pending_outcome = outcome_value;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let m = &ctx.accounts.market;
        let args = ArgBuilder::new()
            .plaintext_u64(m.revealed_pool_0)
            .plaintext_u64(m.revealed_pool_1)
            .plaintext_u8(outcome_value)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RevealMarketOutcomeYesnoCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[ArciumCallbackAccount {
                    pubkey: ctx.accounts.market.key(),
                    is_writable: true,
                }],
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
        // M-3: prevent a second callback from overwriting an already-resolved market
        require!(
            ctx.accounts.market.state != MARKET_STATE_RESOLVED,
            CypherError::AlreadyResolved
        );

        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(RevealMarketOutcomeYesnoOutput { field_0 }) => field_0,
            Err(_) => return Err(CypherError::ComputationVerificationFailed.into()),
        };

        let yes_pool = o.field_0;
        let no_pool = o.field_1;
        let payout_ratio = o.field_2;
        // M-3: use the outcome the circuit actually ran with (field_3), not pending_outcome
        // which could have been overwritten by a concurrent resolve call.
        let outcome = o.field_3;
        let now = Clock::get()?.unix_timestamp;

        let m = &mut ctx.accounts.market;
        m.revealed_pool_0 = yes_pool;
        m.revealed_pool_1 = no_pool;
        m.payout_ratio = payout_ratio;
        m.state = MARKET_STATE_RESOLVED;
        m.outcome = outcome;
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

    // outcome_value: 0-3 (which outcome won)
    // Must be < market.num_outcomes — checked on-chain
    pub fn resolve_market_multi(
        ctx: Context<ResolveMarketMulti>,
        computation_offset: u64,
        outcome_value: u8,
    ) -> Result<()> {
        require!(
            ctx.accounts.market.market_type == MARKET_TYPE_MULTIOUTCOME,
            CypherError::WrongMarketType
        );
        require!(
            ctx.accounts.market.state == MARKET_STATE_ACTIVE,
            CypherError::MarketNotActive
        );
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.market.close_time,
            CypherError::MarketStillOpen
        );
        require!(
            outcome_value < ctx.accounts.market.num_outcomes,
            CypherError::InvalidOutcome
        );

        ctx.accounts.market.pending_outcome = outcome_value;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let m = &ctx.accounts.market;
        let args = ArgBuilder::new()
            .plaintext_u64(m.revealed_pool_0)
            .plaintext_u64(m.revealed_pool_1)
            .plaintext_u64(m.revealed_pool_2)
            .plaintext_u64(m.revealed_pool_3)
            .plaintext_u8(outcome_value)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RevealMarketOutcomeMultiCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[ArciumCallbackAccount {
                    pubkey: ctx.accounts.market.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "reveal_market_outcome_multi")]
    pub fn reveal_market_outcome_multi_callback(
        ctx: Context<RevealMarketOutcomeMultiCallback>,
        output: SignedComputationOutputs<RevealMarketOutcomeMultiOutput>,
    ) -> Result<()> {
        // M-3: prevent a second callback from overwriting an already-resolved market
        require!(
            ctx.accounts.market.state != MARKET_STATE_RESOLVED,
            CypherError::AlreadyResolved
        );

        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(RevealMarketOutcomeMultiOutput { field_0 }) => field_0,
            Err(_) => return Err(CypherError::ComputationVerificationFailed.into()),
        };

        // Returns (pool_0, pool_1, pool_2, pool_3, payout_ratio, outcome) — all revealed plaintext
        // M-3: outcome comes from field_5 (what the circuit ran with), not pending_outcome
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        m.revealed_pool_0 = o.field_0;
        m.revealed_pool_1 = o.field_1;
        m.revealed_pool_2 = o.field_2;
        m.revealed_pool_3 = o.field_3;
        m.payout_ratio = o.field_4;
        m.state = MARKET_STATE_RESOLVED;
        m.outcome = o.field_5;
        m.resolution_time = now;
        m.claim_deadline = now + DEFAULT_CLAIM_PERIOD;
        m.refund_deadline = now + DEFAULT_CLAIM_PERIOD + DEFAULT_REFUND_PERIOD;

        emit!(MarketResolvedEvent {
            market: m.key(),
            outcome: m.outcome,
            revealed_pool_0: o.field_0,
            revealed_pool_1: o.field_1,
            revealed_pool_2: o.field_2,
            revealed_pool_3: o.field_3,
            payout_ratio: o.field_4,
        });
        Ok(())
    }

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

        let pos_pubkey = ctx.accounts.position.user_pubkey;
        let pos_nonce = ctx.accounts.position.nonce;
        let pos_amount = ctx.accounts.position.encrypted_amount;
        let pos_side = ctx.accounts.position.encrypted_side;
        let pos_net_amount = ctx.accounts.position.net_amount;
        let mkt_outcome = ctx.accounts.market.outcome;
        let mkt_ratio = ctx.accounts.market.payout_ratio;

        let args = ArgBuilder::new()
            .x25519_pubkey(pos_pubkey)
            .plaintext_u128(pos_nonce)
            .encrypted_u64(pos_amount)
            .encrypted_u8(pos_side)
            .plaintext_u8(mkt_outcome)
            .plaintext_u64(mkt_ratio)
            .plaintext_u64(pos_net_amount)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ComputeYesnoPayoutCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.position.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.user.key(),
                        is_writable: false,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.market.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.market_vault.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.user_token_account.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.token_program.key(),
                        is_writable: false,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.system_program.key(),
                        is_writable: false,
                    },
                ],
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
        // H-2: concurrent queue calls both read claimed=false; guard here prevents double-pay
        require!(!ctx.accounts.position.claimed, CypherError::AlreadyClaimed);

        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(ComputeYesnoPayoutOutput { field_0 }) => field_0,
            Err(_) => return Err(CypherError::ComputationVerificationFailed.into()),
        };

        let payout_amount = o.field_0;
        let is_winner = o.field_1;

        ctx.accounts.position.claimed = true;

        if is_winner && payout_amount > 0 {
            let market_key = ctx.accounts.market.key();
            let vault_bump = ctx.accounts.market.vault_bump;
            let seeds: &[&[u8]] = &[b"market_vault", market_key.as_ref(), &[vault_bump]];
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

    pub fn claim_payout_multi(
        ctx: Context<ClaimPayoutMulti>,
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

        // Pull values before borrow conflicts
        let pos_pubkey = ctx.accounts.position.user_pubkey;
        let pos_nonce = ctx.accounts.position.nonce;
        let pos_amount = ctx.accounts.position.encrypted_amount;
        let pos_side = ctx.accounts.position.encrypted_side;
        let pos_net_amount = ctx.accounts.position.net_amount;
        let mkt_outcome = ctx.accounts.market.outcome;
        let mkt_ratio = ctx.accounts.market.payout_ratio;

        let args = ArgBuilder::new()
            .x25519_pubkey(pos_pubkey)
            .plaintext_u128(pos_nonce)
            .encrypted_u64(pos_amount)
            .encrypted_u8(pos_side)
            .plaintext_u8(mkt_outcome)
            .plaintext_u64(mkt_ratio)
            .plaintext_u64(pos_net_amount)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ComputeMultiPayoutCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.position.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.user.key(),
                        is_writable: false,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.market.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.market_vault.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.user_token_account.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.token_program.key(),
                        is_writable: false,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.system_program.key(),
                        is_writable: false,
                    },
                ],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "compute_multi_payout")]
    pub fn compute_multi_payout_callback(
        ctx: Context<ComputeMultiPayoutCallback>,
        output: SignedComputationOutputs<ComputeMultiPayoutOutput>,
    ) -> Result<()> {
        // H-2: guard against double-pay from concurrent queue calls
        require!(!ctx.accounts.position.claimed, CypherError::AlreadyClaimed);

        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(ComputeMultiPayoutOutput { field_0 }) => field_0,
            Err(_) => return Err(CypherError::ComputationVerificationFailed.into()),
        };

        let payout_amount = o.field_0;
        let is_winner = o.field_1;

        ctx.accounts.position.claimed = true;

        if is_winner && payout_amount > 0 {
            let market_key = ctx.accounts.market.key();
            let vault_bump = ctx.accounts.market.vault_bump;
            let seeds: &[&[u8]] = &[b"market_vault", market_key.as_ref(), &[vault_bump]];
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

        let pos_pubkey = ctx.accounts.position.user_pubkey;
        let pos_nonce = ctx.accounts.position.nonce;
        let pos_amount = ctx.accounts.position.encrypted_amount;
        let pos_net_amount = ctx.accounts.position.net_amount;

        let args = ArgBuilder::new()
            .x25519_pubkey(pos_pubkey)
            .plaintext_u128(pos_nonce)
            .encrypted_u64(pos_amount)
            .plaintext_u64(pos_net_amount)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ComputeYesnoRefundCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.position.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.user.key(),
                        is_writable: false,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.market.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.market_vault.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.user_token_account.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.token_program.key(),
                        is_writable: false,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.system_program.key(),
                        is_writable: false,
                    },
                ],
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
        // H-2: guard against double-refund from concurrent queue calls
        require!(!ctx.accounts.position.claimed, CypherError::AlreadyClaimed);

        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(ComputeYesnoRefundOutput { field_0 }) => field_0,
            Err(_) => return Err(CypherError::ComputationVerificationFailed.into()),
        };

        // Single return value — o IS the u64, not a struct
        let refund_amount = o;

        ctx.accounts.position.claimed = true;

        if refund_amount > 0 {
            let market_key = ctx.accounts.market.key();
            let vault_bump = ctx.accounts.market.vault_bump;
            let seeds: &[&[u8]] = &[b"market_vault", market_key.as_ref(), &[vault_bump]];
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

    pub fn claim_refund_multi(
        ctx: Context<ClaimRefundMulti>,
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

        let pos_pubkey = ctx.accounts.position.user_pubkey;
        let pos_nonce = ctx.accounts.position.nonce;
        let pos_amount = ctx.accounts.position.encrypted_amount;
        let pos_net_amount = ctx.accounts.position.net_amount;

        let args = ArgBuilder::new()
            .x25519_pubkey(pos_pubkey)
            .plaintext_u128(pos_nonce)
            .encrypted_u64(pos_amount)
            .plaintext_u64(pos_net_amount)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ComputeMultiRefundCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.position.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.user.key(),
                        is_writable: false,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.market.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.market_vault.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.user_token_account.key(),
                        is_writable: true,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.token_program.key(),
                        is_writable: false,
                    },
                    ArciumCallbackAccount {
                        pubkey: ctx.accounts.system_program.key(),
                        is_writable: false,
                    },
                ],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "compute_multi_refund")]
    pub fn compute_multi_refund_callback(
        ctx: Context<ComputeMultiRefundCallback>,
        output: SignedComputationOutputs<ComputeMultiRefundOutput>,
    ) -> Result<()> {
        // H-2: guard against double-refund from concurrent queue calls
        require!(!ctx.accounts.position.claimed, CypherError::AlreadyClaimed);

        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(ComputeMultiRefundOutput { field_0 }) => field_0,
            Err(_) => return Err(CypherError::ComputationVerificationFailed.into()),
        };

        // Single return value — o is the u64 directly
        let refund_amount = o;

        ctx.accounts.position.claimed = true;

        if refund_amount > 0 {
            let market_key = ctx.accounts.market.key();
            let vault_bump = ctx.accounts.market.vault_bump;
            let seeds: &[&[u8]] = &[b"market_vault", market_key.as_ref(), &[vault_bump]];
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

//  ACCOUNT CONTEXTS

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = GLOBAL_STATE_SPACE, seeds = [b"global_state"], bump)]
    pub global_state: Box<Account<'info, GlobalState>>, // ← boxed
    /// CHECK: treasury wallet — no type checks needed
    pub protocol_treasury: UncheckedAccount<'info>,
    pub accepted_mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [b"global_state"], bump = global_state.bump)]
    pub global_state: Box<Account<'info, GlobalState>>, // ← boxed
    #[account(
        init, payer = creator, space = MARKET_SPACE,
        seeds = [b"market", global_state.market_counter.to_le_bytes().as_ref()],
        bump,
    )]
    pub market: Box<Account<'info, Market>>, // ← boxed (Market is ~500 bytes)
    #[account(
        init, payer = creator, space = LP_POSITION_SPACE,
        seeds = [b"lp-position", market.key().as_ref(), creator.key().as_ref()],
        bump,
    )]
    pub lp_position: Box<Account<'info, LPPosition>>, // ← boxed
    #[account(
        init, payer = creator,
        token::mint = accepted_mint,
        token::authority = market_vault,
        seeds = [b"market_vault", market.key().as_ref()],
        bump,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>, // ← boxed
    #[account(
        mut,
        constraint = creator_token_account.owner == creator.key(),
        constraint = creator_token_account.mint == global_state.accepted_mint @ CypherError::WrongMint,
    )]
    pub creator_token_account: Box<Account<'info, TokenAccount>>, // ← boxed
    pub accepted_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut,
        seeds = [b"market", market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        constraint = market.creator == creator.key() @ CypherError::NotMarketCreator,
    )]
    pub market: Box<Account<'info, Market>>, // ← boxed
    #[account(mut, seeds = [b"market_vault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: Box<Account<'info, TokenAccount>>, // ← boxed
    #[account(mut,
        seeds = [b"lp-position", market.key().as_ref(), creator.key().as_ref()],
        bump = lp_position.bump,
    )]
    pub lp_position: Box<Account<'info, LPPosition>>, // ← boxed
    #[account(mut, constraint = creator_token_account.owner == creator.key())]
    pub creator_token_account: Box<Account<'info, TokenAccount>>, // ← boxed
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawCreatorFunds<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut,
        seeds = [b"market", market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        constraint = market.creator == creator.key() @ CypherError::NotMarketCreator,
    )]
    pub market: Box<Account<'info, Market>>, // ← boxed
    #[account(mut,
        seeds = [b"lp-position", market.key().as_ref(), creator.key().as_ref()],
        bump = lp_position.bump,
    )]
    pub lp_position: Box<Account<'info, LPPosition>>, // ← boxed
    #[account(mut, seeds = [b"market_vault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: Box<Account<'info, TokenAccount>>, // ← boxed
    #[account(mut, constraint = creator_token_account.owner == creator.key())]
    pub creator_token_account: Box<Account<'info, TokenAccount>>, // ← boxed
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminClaimRemaining<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"global_state"], bump = global_state.bump,
        constraint = global_state.admin == admin.key() @ CypherError::UnauthorizedAdmin)]
    pub global_state: Box<Account<'info, GlobalState>>, // ← boxed
    #[account(mut, seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>, // ← boxed
    #[account(mut, seeds = [b"market_vault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: Box<Account<'info, TokenAccount>>, // ← boxed
    #[account(mut, constraint = protocol_treasury.key() == global_state.protocol_treasury)]
    pub protocol_treasury: Box<Account<'info, TokenAccount>>, // ← boxed
    pub token_program: Program<'info, Token>,
}

// Init Comp Def contexts

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
    /// CHECK: comp_def_account, checked by arcium program.   ← FIX 1 applied here
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

#[init_computation_definition_accounts("compute_yesno_payout", payer)]
#[derive(Accounts)]
pub struct InitPayoutYesnoCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.   ← FIX 1 applied here
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

#[init_computation_definition_accounts("compute_yesno_refund", payer)]
#[derive(Accounts)]
pub struct InitRefundYesnoCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.   ← FIX 1 applied here
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

// PlacePrivateBetYesno

#[queue_computation_accounts("place_private_bet_yesno", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct PlacePrivateBetYesno<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
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
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    // Custom
    pub user: Signer<'info>,
    #[account(seeds = [b"global_state"], bump = global_state.bump)]
    pub global_state: Box<Account<'info, GlobalState>>,
    #[account(mut, seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [b"market_vault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_token_account.owner == user.key(),
        constraint = user_token_account.mint == global_state.accepted_mint @ CypherError::WrongMint)]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = protocol_treasury.key() == global_state.protocol_treasury)]
    pub protocol_treasury: Box<Account<'info, TokenAccount>>,
    #[account(
        init, payer = payer, space = ENCRYPTED_POSITION_SPACE,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, EncryptedPosition>>, // ← boxed
    pub token_program: Program<'info, Token>,
}

// PlacePrivateBetYesnoCallback

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
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    // Custom
    #[account(mut)]
    pub market: Box<Account<'info, Market>>, // ← boxed
    #[account(mut)]
    pub position: Box<Account<'info, EncryptedPosition>>, // ← boxed
}

//  ResolveMarketYesno
// FIX 2: market boxed.

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
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
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
    pub market: Box<Account<'info, Market>>, // ← boxed
}

//  RevealMarketOutcomeYesnoCallback
// FIX 2: market boxed.

#[callback_accounts("reveal_market_outcome_yesno")]
#[derive(Accounts)]
pub struct RevealMarketOutcomeYesnoCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_YESNO))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    // Custom
    #[account(mut)]
    pub market: Box<Account<'info, Market>>, // ← boxed
}

// ClaimPayoutYesno
// FIX 2: market and position boxed.

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
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
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
    pub market: Box<Account<'info, Market>>, // ← boxed
    #[account(mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.user == user.key(),
    )]
    pub position: Box<Account<'info, EncryptedPosition>>, // ← boxed
    #[account(mut, seeds = [b"market_vault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_token_account.owner == user.key())]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

//  ComputeYesnoPayoutCallback
#[callback_accounts("compute_yesno_payout")]
#[derive(Accounts)]
pub struct ComputeYesnoPayoutCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PAYOUT_YESNO))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    // Custom
    #[account(mut)]
    pub position: Box<Account<'info, EncryptedPosition>>, // ← boxed
    /// CHECK: user wallet for emit event
    pub user: UncheckedAccount<'info>,
    #[account(mut)]
    pub market: Box<Account<'info, Market>>, // ← boxed
    #[account(mut)]
    pub market_vault: Box<Account<'info, TokenAccount>>, // ← boxed
    #[account(mut, constraint = user_token_account.owner == user.key())]
    pub user_token_account: Box<Account<'info, TokenAccount>>, // ← boxed
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

//  ClaimRefundYesno
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
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
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
    pub market: Box<Account<'info, Market>>, // ← boxed
    #[account(mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.user == user.key(),
    )]
    pub position: Box<Account<'info, EncryptedPosition>>, // ← boxed
    #[account(mut, seeds = [b"market_vault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_token_account.owner == user.key())]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

// ComputeYesnoRefundCallback
#[callback_accounts("compute_yesno_refund")]
#[derive(Accounts)]
pub struct ComputeYesnoRefundCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REFUND_YESNO))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    // Custom
    #[account(mut)]
    pub position: Box<Account<'info, EncryptedPosition>>, // ← boxed
    /// CHECK: user wallet for emit event
    pub user: UncheckedAccount<'info>,
    #[account(mut)]
    pub market: Box<Account<'info, Market>>, // ← boxed
    #[account(mut)]
    pub market_vault: Box<Account<'info, TokenAccount>>, // ← boxed
    #[account(mut, constraint = user_token_account.owner == user.key())]
    pub user_token_account: Box<Account<'info, TokenAccount>>, // ← boxed
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// for multioutcome markets structs are

// ── Init Comp Def — Multi ─────────────────────────────────────────────────────

#[init_computation_definition_accounts("place_private_bet_multi", payer)]
#[derive(Accounts)]
pub struct InitPlaceBetMultiCompDef<'info> {
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

#[init_computation_definition_accounts("reveal_market_outcome_multi", payer)]
#[derive(Accounts)]
pub struct InitRevealMultiCompDef<'info> {
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

#[init_computation_definition_accounts("compute_multi_payout", payer)]
#[derive(Accounts)]
pub struct InitPayoutMultiCompDef<'info> {
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

#[init_computation_definition_accounts("compute_multi_refund", payer)]
#[derive(Accounts)]
pub struct InitRefundMultiCompDef<'info> {
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

// ── CreateMarketMulti ─────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct CreateMarketMulti<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [b"global_state"], bump = global_state.bump)]
    pub global_state: Box<Account<'info, GlobalState>>,
    #[account(
        init, payer = creator, space = MARKET_SPACE,
        seeds = [b"market", global_state.market_counter.to_le_bytes().as_ref()],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init, payer = creator, space = LP_POSITION_SPACE,
        seeds = [b"lp-position", market.key().as_ref(), creator.key().as_ref()],
        bump,
    )]
    pub lp_position: Box<Account<'info, LPPosition>>,
    #[account(
        init, payer = creator,
        token::mint = accepted_mint,
        token::authority = market_vault,
        seeds = [b"market_vault", market.key().as_ref()],
        bump,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = creator_token_account.owner == creator.key(),
        constraint = creator_token_account.mint == global_state.accepted_mint @ CypherError::WrongMint,
    )]
    pub creator_token_account: Box<Account<'info, TokenAccount>>,
    pub accepted_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// ── PlacePrivateBetMulti ──────────────────────────────────────────────────────
// Same structure as PlacePrivateBetYesno — lp_position removed for stack budget

#[queue_computation_accounts("place_private_bet_multi", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct PlacePrivateBetMulti<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
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
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PLACE_BET_MULTI))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    // Custom
    pub user: Signer<'info>,
    #[account(seeds = [b"global_state"], bump = global_state.bump)]
    pub global_state: Box<Account<'info, GlobalState>>,
    #[account(mut,
        seeds = [b"market", market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        constraint = market.market_type == MARKET_TYPE_MULTIOUTCOME @ CypherError::WrongMarketType,
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [b"market_vault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut,
        constraint = user_token_account.owner == user.key(),
        constraint = user_token_account.mint == global_state.accepted_mint @ CypherError::WrongMint,
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = protocol_treasury.key() == global_state.protocol_treasury)]
    pub protocol_treasury: Box<Account<'info, TokenAccount>>,
    #[account(
        init, payer = payer, space = ENCRYPTED_POSITION_SPACE,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, EncryptedPosition>>,
    pub token_program: Program<'info, Token>,
}

#[callback_accounts("place_private_bet_multi")]
#[derive(Accounts)]
pub struct PlacePrivateBetMultiCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PLACE_BET_MULTI))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut)]
    pub position: Box<Account<'info, EncryptedPosition>>,
}

// ── ResolveMarketMulti ────────────────────────────────────────────────────────

#[queue_computation_accounts("reveal_market_outcome_multi", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ResolveMarketMulti<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
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
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_MULTI))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    pub resolver: Signer<'info>,
    #[account(mut,
        seeds = [b"market", market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        constraint = market.resolver == resolver.key() @ CypherError::UnauthorizedResolver,
        constraint = market.market_type == MARKET_TYPE_MULTIOUTCOME @ CypherError::WrongMarketType,
    )]
    pub market: Box<Account<'info, Market>>,
}

#[callback_accounts("reveal_market_outcome_multi")]
#[derive(Accounts)]
pub struct RevealMarketOutcomeMultiCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_MULTI))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
}

//  ClaimPayoutMulti

#[queue_computation_accounts("compute_multi_payout", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ClaimPayoutMulti<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
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
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PAYOUT_MULTI))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    pub user: Signer<'info>,
    #[account(seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.user == user.key(),
    )]
    pub position: Box<Account<'info, EncryptedPosition>>,
    #[account(mut, seeds = [b"market_vault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_token_account.owner == user.key())]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[callback_accounts("compute_multi_payout")]
#[derive(Accounts)]
pub struct ComputeMultiPayoutCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PAYOUT_MULTI))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub position: Box<Account<'info, EncryptedPosition>>,
    /// CHECK: user wallet for emit event
    pub user: UncheckedAccount<'info>,
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut)]
    pub market_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_token_account.owner == user.key())]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

//  ClaimRefundMulti

#[queue_computation_accounts("compute_multi_refund", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ClaimRefundMulti<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
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
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REFUND_MULTI))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    pub user: Signer<'info>,
    #[account(seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.user == user.key(),
    )]
    pub position: Box<Account<'info, EncryptedPosition>>,
    #[account(mut, seeds = [b"market_vault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_token_account.owner == user.key())]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[callback_accounts("compute_multi_refund")]
#[derive(Accounts)]
pub struct ComputeMultiRefundCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REFUND_MULTI))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub position: Box<Account<'info, EncryptedPosition>>,
    /// CHECK: user wallet for emit event
    pub user: UncheckedAccount<'info>,
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut)]
    pub market_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_token_account.owner == user.key())]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

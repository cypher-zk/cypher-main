use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_interface::{Mint, TokenAccount},
};
use arcium_anchor::prelude::*;

pub mod states;
use states::*;

declare_id!("F6pTnahcgW4gJX3iKxihmZGNUJN1jH4s77ijpK34FpFc");

// Constants
pub const BOND_AMOUNT: u64 = 10_000_000; // $10 USDC (6 decimals)
pub const USDC_DECIMALS: u8 = 6;
pub const MAX_PAYLOAD_SIZE: usize = 128;
pub const MIN_STAKE: u64 = 1_000_000;
pub const DISPUTE_WINDOW: i64 = 3_600;

// Arcium computation definition offsets — one per circuit
const COMP_DEF_OFFSET_YESNO: u32 = comp_def_offset("settle_yesno");
const COMP_DEF_OFFSET_MULTIOUTCOME: u32 = comp_def_offset("settle_multioutcome");
const COMP_DEF_OFFSET_ACCURACY: u32 = comp_def_offset("settle_accuracy");

#[arcium_program]
pub mod cypher_main {

    use super::*;

    // initialize instruction
    pub fn initialize(
        ctx: Context<Initialize>,
        protocol_fee_bps: u16,
        lp_fee_bps: u16,
        accuracy_platform_fee_bps: u16,
    ) -> Result<()> {
        require!(
            protocol_fee_bps + lp_fee_bps <= 1000,
            CypherError::FeeTooHigh
        );
        require!(accuracy_platform_fee_bps <= 5000, CypherError::FeeTooHigh);
        let cm = &mut ctx.accounts.cypher_market;
        cm.authority = ctx.accounts.authority.key();
        cm.treasury = ctx.accounts.treasury.key();
        cm.accepted_mint = ctx.accounts.accepted_mint.key();
        cm.protocol_fee_bps = protocol_fee_bps;
        cm.lp_fee_bps = lp_fee_bps;
        cm.accuracy_platform_fee_bps = accuracy_platform_fee_bps;
        cm.market_count = 0;
        cm.is_paused = false;
        cm.bump = ctx.bumps.cypher_market;
        cm._padding = [0u8; 64];
        Ok(())
    }

    pub fn create_market_group(
        ctx: Context<CreateMarketGroup>,
        market_type: MarketType,
        category: MarketCategory,
        oracle_type: OracleType,
        oracle_authority: Pubkey,
        pyth_feed: Option<Pubkey>,
        switchboard_feed: Option<Pubkey>,
        question: String,
        outcome_labels: Vec<String>,
        lock_timestamp: i64,
        resolve_deadline: i64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.cypher_market.is_paused,
            CypherError::ProtocolPaused
        );
        require!(question.len() <= 256, CypherError::InvalidResolvedValueType);
        require!(
            outcome_labels.len() <= 4,
            CypherError::OutcomeIndexOutOfRange
        );
        require!(
            lock_timestamp > Clock::get()?.unix_timestamp,
            CypherError::LockTimestampNotReached
        );
        require!(
            resolve_deadline > lock_timestamp,
            CypherError::ResolveDeadlineNotPassed
        );
        match oracle_type {
            OracleType::Pyth => require!(pyth_feed.is_some(), CypherError::OracleTypeNotSupported),
            OracleType::Switchboard => require!(
                switchboard_feed.is_some(),
                CypherError::OracleTypeNotSupported
            ),
            OracleType::Manual => {}
        }

        // ── BORROW FIX: save every key() needed in emit!() and bond assignment
        // BEFORE taking any &mut borrows. Rust won't let you hold &mut X and
        // call X.key() (immutable) in the same scope — even with NLL.
        let market_group_key = ctx.accounts.market_group.key();
        let cypher_market_key = ctx.accounts.cypher_market.key();
        let bond_vault_key = ctx.accounts.bond_vault.key();
        let creator_key = ctx.accounts.creator.key();
        let group_index = ctx.accounts.cypher_market.market_count;

        anchor_spl::token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.creator_token_account.to_account_info(),
                    to: ctx.accounts.bond_vault.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            BOND_AMOUNT,
        )?;

        let mg = &mut ctx.accounts.market_group;
        mg.creator = creator_key;
        mg.config = cypher_market_key;
        mg.group_index = group_index;
        mg.market_type = market_type;
        mg.category = category;
        mg.oracle_type = oracle_type;
        mg.oracle_authority = oracle_authority;
        mg.pyth_feed = pyth_feed;
        mg.switchboard_feed = switchboard_feed;
        mg.question = question.clone();
        mg.outcome_labels = outcome_labels;
        mg.lock_timestamp = lock_timestamp;
        mg.resolve_deadline = resolve_deadline;
        mg.resolved_at = None;
        mg.resolved_value = None;
        mg.dispute_deadline = None;
        mg.status = GroupStatus::Open;
        mg.bump = ctx.bumps.market_group;
        mg._padding = [0u8; 128];
        // save market_type before mg goes out of scope for emit!
        let market_type_clone = mg.market_type.clone();

        let bond = &mut ctx.accounts.bond;
        bond.group = market_group_key; // saved key — no borrow conflict
        bond.creator = creator_key;
        bond.amount = BOND_AMOUNT;
        bond.vault = bond_vault_key; // saved key
        bond.vault_authority_bump = ctx.bumps.bond_vault_authority;
        bond.status = BondStatus::Locked;
        bond.bump = ctx.bumps.bond;
        bond._padding = [0u8; 32];

        ctx.accounts.cypher_market.market_count += 1;

        emit!(GroupCreated {
            group: market_group_key, // saved — no conflict
            creator: creator_key,
            market_type: market_type_clone, // saved — no conflict
            question,
            lock_timestamp,
            resolve_deadline,
            created_at: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn create_flat_market(ctx: Context<CreateFlatMarket>) -> Result<()> {
        require!(
            ctx.accounts.market_group.market_type != MarketType::Accuracy,
            CypherError::InvalidResolvedValueType
        );
        require!(
            ctx.accounts.market_group.is_open(),
            CypherError::MarketNotOpen
        );

        let group_key = ctx.accounts.market_group.key();
        let m = &mut ctx.accounts.market;
        m.group = group_key;
        m.market_type = ctx.accounts.market_group.market_type.clone();
        m.tier_byte = 0;
        m.bet_size = 0;
        m.protocol_fee_bps = ctx.accounts.cypher_market.protocol_fee_bps;
        m.lp_fee_bps = ctx.accounts.cypher_market.lp_fee_bps;
        m.total_participants = 0;
        m.total_volume = 0;
        m.bump = ctx.bumps.market;
        m._padding = [0u8; 64];
        Ok(())
    }

    pub fn create_tier_market(ctx: Context<CreateTierMarket>, tier: Tier) -> Result<()> {
        require!(
            ctx.accounts.market_group.market_type == MarketType::Accuracy,
            CypherError::InvalidResolvedValueType
        );
        require!(
            ctx.accounts.market_group.is_open(),
            CypherError::MarketNotOpen
        );

        let group_key = ctx.accounts.market_group.key();
        let m = &mut ctx.accounts.market;
        m.group = group_key;
        m.market_type = MarketType::Accuracy;
        m.tier_byte = tier.as_byte();
        m.bet_size = tier.bet_size();
        m.protocol_fee_bps = ctx.accounts.cypher_market.protocol_fee_bps;
        m.lp_fee_bps = ctx.accounts.cypher_market.lp_fee_bps;
        m.total_participants = 0;
        m.total_volume = 0;
        m.bump = ctx.bumps.market;
        m._padding = [0u8; 64];
        Ok(())
    }

    pub fn create_pool(
        ctx: Context<CreatePool>,
        pool_index: u8,
        pool_type: PoolType,
    ) -> Result<()> {
        require!(
            ctx.accounts.market_group.is_open(),
            CypherError::MarketNotOpen
        );

        let market_key = ctx.accounts.market.key();
        let market_group_key = ctx.accounts.market_group.key();
        let pool_vault_key = ctx.accounts.pool_vault.key();

        let pool = &mut ctx.accounts.pool;
        pool.market = market_key;
        pool.group = market_group_key;
        pool.pool_index = pool_index;
        pool.pool_type = pool_type;
        pool.vault = pool_vault_key;
        pool.vault_authority_bump = ctx.bumps.vault_authority;
        pool.participant_count = 0;
        pool.total_staked = 0;
        pool.status = PoolStatus::Open;
        pool.bump = ctx.bumps.pool;
        pool._padding = [0u8; 64];
        Ok(())
    }

    pub fn cancel_market(ctx: Context<CancelMarket>) -> Result<()> {
        require!(
            ctx.accounts.market_group.is_open(),
            CypherError::MarketNotOpen
        );
        require!(
            ctx.accounts.pool.participant_count == 0,
            CypherError::MarketHasParticipants
        );
        require!(
            ctx.accounts.bond.status == BondStatus::Locked,
            CypherError::BondNotLocked
        );

        let bond_key = ctx.accounts.bond.key();
        let authority_seeds = &[
            b"bond_vault_authority",
            bond_key.as_ref(),
            &[ctx.accounts.bond.vault_authority_bump],
        ];

        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.bond_vault.to_account_info(),
                    to: ctx.accounts.creator_token_account.to_account_info(),
                    authority: ctx.accounts.bond_vault_authority.to_account_info(),
                },
                &[authority_seeds],
            ),
            BOND_AMOUNT,
        )?;

        ctx.accounts.bond.status = BondStatus::Returned;
        ctx.accounts.market_group.status = GroupStatus::Voided;
        Ok(())
    }

    pub fn place_bet(
        ctx: Context<PlaceBet>,
        encrypted_payload: Vec<u8>,
        stake_amount: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.cypher_market.is_paused,
            CypherError::ProtocolPaused
        );
        require!(
            ctx.accounts.market_group.is_open(),
            CypherError::MarketNotOpen
        );
        require!(
            ctx.accounts.pool.status == PoolStatus::Open,
            CypherError::PoolNotOpen
        );
        require!(stake_amount >= MIN_STAKE, CypherError::StakeTooLow);
        require!(
            !encrypted_payload.is_empty(),
            CypherError::EmptyEncryptedPayload
        );
        require!(
            encrypted_payload.len() <= MAX_PAYLOAD_SIZE,
            CypherError::PayloadTooLarge
        );

        // ── BORROW FIX: save all keys before any &mut borrows
        // emit!() needs these but we also hold &mut pos, &mut pool, &mut market
        let position_key = ctx.accounts.position.key();
        let market_key = ctx.accounts.market.key();
        let group_key = ctx.accounts.market_group.key();
        let pool_key = ctx.accounts.pool.key();
        let user_key = ctx.accounts.user.key();
        let market_type = ctx.accounts.market_group.market_type.clone();
        let now = Clock::get()?.unix_timestamp;

        anchor_spl::token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.pool_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            stake_amount,
        )?;

        let pos = &mut ctx.accounts.position;
        pos.pool = pool_key;
        pos.market = market_key;
        pos.group = group_key;
        pos.user = user_key;
        pos.encrypted_payload = encrypted_payload;
        pos.stake = stake_amount;
        pos.placed_at = now;
        pos.payout = 0;
        pos.status = PositionStatus::Open;
        pos.bump = ctx.bumps.position;
        pos._padding = [0u8; 32];

        let pool = &mut ctx.accounts.pool;
        pool.participant_count = pool
            .participant_count
            .checked_add(1)
            .ok_or(CypherError::MathOverflow)?;
        pool.total_staked = pool
            .total_staked
            .checked_add(stake_amount)
            .ok_or(CypherError::MathOverflow)?;

        let market = &mut ctx.accounts.market;
        market.total_participants = market
            .total_participants
            .checked_add(1)
            .ok_or(CypherError::MathOverflow)?;
        market.total_volume = market
            .total_volume
            .checked_add(stake_amount)
            .ok_or(CypherError::MathOverflow)?;

        emit!(BetPlaced {
            position: position_key, // all saved — no borrow conflicts
            market: market_key,
            group: group_key,
            pool: pool_key,
            user: user_key,
            market_type: market_type,
            stake: stake_amount,
            placed_at: now,
        });
        Ok(())
    }

    pub fn place_bet_accuracy(
        ctx: Context<PlaceBetAccuracy>,
        encrypted_payload: Vec<u8>,
    ) -> Result<()> {
        require!(
            !ctx.accounts.cypher_market.is_paused,
            CypherError::ProtocolPaused
        );
        require!(
            ctx.accounts.market_group.is_open(),
            CypherError::MarketNotOpen
        );
        require!(
            ctx.accounts.pool.status == PoolStatus::Open,
            CypherError::PoolNotOpen
        );
        require!(
            !encrypted_payload.is_empty(),
            CypherError::EmptyEncryptedPayload
        );
        require!(
            encrypted_payload.len() <= MAX_PAYLOAD_SIZE,
            CypherError::PayloadTooLarge
        );

        let bet_size = ctx.accounts.market.bet_size;
        require!(bet_size > 0, CypherError::StakeTooLow);

        // ── BORROW FIX: save all keys before &mut borrows
        let position_key = ctx.accounts.position.key();
        let market_key = ctx.accounts.market.key();
        let group_key = ctx.accounts.market_group.key();
        let pool_key = ctx.accounts.pool.key();
        let user_key = ctx.accounts.user.key();
        let now = Clock::get()?.unix_timestamp;

        anchor_spl::token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.pool_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            bet_size,
        )?;

        let pos = &mut ctx.accounts.position;
        pos.pool = pool_key;
        pos.market = market_key;
        pos.group = group_key;
        pos.user = user_key;
        pos.encrypted_payload = encrypted_payload;
        pos.stake = bet_size;
        pos.placed_at = now;
        pos.payout = 0;
        pos.status = PositionStatus::Open;
        pos.bump = ctx.bumps.position;
        pos._padding = [0u8; 32];

        let pool = &mut ctx.accounts.pool;
        pool.participant_count = pool
            .participant_count
            .checked_add(1)
            .ok_or(CypherError::MathOverflow)?;
        pool.total_staked = pool
            .total_staked
            .checked_add(bet_size)
            .ok_or(CypherError::MathOverflow)?;

        let market = &mut ctx.accounts.market;
        market.total_participants = market
            .total_participants
            .checked_add(1)
            .ok_or(CypherError::MathOverflow)?;
        market.total_volume = market
            .total_volume
            .checked_add(bet_size)
            .ok_or(CypherError::MathOverflow)?;

        emit!(BetPlaced {
            position: position_key,
            market: market_key,
            group: group_key,
            pool: pool_key,
            user: user_key,
            market_type: MarketType::Accuracy,
            stake: bet_size,
            placed_at: now,
        });
        Ok(())
    }

    pub fn lock_market(ctx: Context<LockMarket>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.market_group.lock_timestamp,
            CypherError::LockTimestampNotReached
        );
        require!(
            ctx.accounts.market_group.is_open(),
            CypherError::MarketNotOpen
        );

        // direct field mutation — no let &mut binding — no borrow conflict
        let group_key = ctx.accounts.market_group.key();
        let total_participants = ctx.accounts.pool.participant_count;
        let total_volume = ctx.accounts.pool.total_staked;

        ctx.accounts.market_group.status = GroupStatus::Locked;

        emit!(GroupLocked {
            group: group_key,
            locked_at: now,
            total_participants,
            total_volume,
        });
        Ok(())
    }

    pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
        require!(
            ctx.accounts.position.status == PositionStatus::Settled,
            CypherError::PositionNotSettled
        );
        require!(ctx.accounts.position.payout > 0, CypherError::ZeroPayout);
        require!(
            ctx.accounts.position.user == ctx.accounts.user.key(),
            CypherError::UnauthorizedClaim
        );

        let payout = ctx.accounts.position.payout;
        let position_key = ctx.accounts.position.key();
        let pool_key = ctx.accounts.pool.key();
        let user_key = ctx.accounts.user.key();
        let pos_market = ctx.accounts.position.market;
        let pos_group = ctx.accounts.position.group;
        let now = Clock::get()?.unix_timestamp;

        let authority_seeds = &[
            b"vault_authority",
            pool_key.as_ref(),
            &[ctx.accounts.pool.vault_authority_bump],
        ];

        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.pool_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[authority_seeds],
            ),
            payout,
        )?;

        ctx.accounts.position.status = PositionStatus::Claimed;

        emit!(PayoutClaimed {
            position: position_key,
            user: user_key,
            pool: pool_key,
            market: pos_market,
            group: pos_group,
            payout,
            claimed_at: now,
        });
        Ok(())
    }

    pub fn return_bond(ctx: Context<ReturnBond>) -> Result<()> {
        require!(
            ctx.accounts.bond.status == BondStatus::Locked,
            CypherError::BondNotLocked
        );
        require!(
            ctx.accounts.bond.creator == ctx.accounts.creator.key(),
            CypherError::UnauthorizedBondReturn
        );
        require!(
            ctx.accounts.market_group.status == GroupStatus::Settled,
            CypherError::MarketNotSettled
        );

        let bond_key = ctx.accounts.bond.key();
        let group_key = ctx.accounts.market_group.key();
        let creator_key = ctx.accounts.creator.key();
        let now = Clock::get()?.unix_timestamp;

        let authority_seeds = &[
            b"bond_vault_authority",
            bond_key.as_ref(),
            &[ctx.accounts.bond.vault_authority_bump],
        ];

        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.bond_vault.to_account_info(),
                    to: ctx.accounts.creator_token_account.to_account_info(),
                    authority: ctx.accounts.bond_vault_authority.to_account_info(),
                },
                &[authority_seeds],
            ),
            BOND_AMOUNT,
        )?;

        ctx.accounts.bond.status = BondStatus::Returned;

        emit!(BondReturned {
            bond: bond_key,
            group: group_key,
            creator: creator_key,
            amount: BOND_AMOUNT,
            returned_at: now,
        });
        Ok(())
    }

    pub fn slash_bond(ctx: Context<SlashBond>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.bond.status == BondStatus::Locked,
            CypherError::BondNotLocked
        );
        require!(
            ctx.accounts.market_group.is_locked(),
            CypherError::MarketNotLocked
        );
        require!(
            now > ctx.accounts.market_group.resolve_deadline,
            CypherError::ResolveDeadlineNotPassed
        );

        let bond_key = ctx.accounts.bond.key();
        let group_key = ctx.accounts.market_group.key();
        let creator_key = ctx.accounts.market_group.creator;

        let authority_seeds = &[
            b"bond_vault_authority",
            bond_key.as_ref(),
            &[ctx.accounts.bond.vault_authority_bump],
        ];

        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.bond_vault.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: ctx.accounts.bond_vault_authority.to_account_info(),
                },
                &[authority_seeds],
            ),
            BOND_AMOUNT,
        )?;

        ctx.accounts.bond.status = BondStatus::Slashed;
        ctx.accounts.market_group.status = GroupStatus::Voided;

        emit!(BondSlashed {
            bond: bond_key,
            group: group_key,
            creator: creator_key,
            amount: BOND_AMOUNT,
            slashed_at: now,
        });
        Ok(())
    }

    pub fn post_resolution(
        ctx: Context<PostResolution>,
        resolved_value: ResolvedValue,
    ) -> Result<()> {
        require!(
            ctx.accounts.market_group.is_locked(),
            CypherError::MarketNotLocked
        );
        require!(
            ctx.accounts.market_group.resolved_value.is_none(),
            CypherError::AlreadyResolved
        );

        match &ctx.accounts.market_group.market_type {
            MarketType::YesNo => {
                require!(
                    matches!(resolved_value, ResolvedValue::YesNo(_)),
                    CypherError::InvalidResolvedValueType
                );
            }
            MarketType::MultiOutcome => {
                if let ResolvedValue::Outcome(idx) = &resolved_value {
                    require!(*idx < 4, CypherError::OutcomeIndexOutOfRange);
                } else {
                    return err!(CypherError::InvalidResolvedValueType);
                }
            }
            MarketType::Accuracy => {
                require!(
                    matches!(resolved_value, ResolvedValue::Numeric(_)),
                    CypherError::InvalidResolvedValueType
                );
            }
        }

        let market_group_key = ctx.accounts.market_group.key();
        let oracle_type = ctx.accounts.market_group.oracle_type.clone();
        let now = Clock::get()?.unix_timestamp;
        let dispute_deadline = now + DISPUTE_WINDOW;

        let mg = &mut ctx.accounts.market_group;
        mg.resolved_value = Some(resolved_value.clone());
        mg.resolved_at = Some(now);
        mg.dispute_deadline = Some(dispute_deadline);
        mg.status = GroupStatus::Resolving;

        emit!(ResolutionPosted {
            group: market_group_key,  // saved — no conflict
            oracle_type: oracle_type, // saved — no conflict
            resolved_value,
            resolved_at: now,
            dispute_deadline,
        });
        Ok(())
    }

    // ────── ARCIUM COMPUTATION DEFINITION INIT ──────────────────────────

    pub fn init_yesno_comp_def(ctx: Context<InitYesNoCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn init_multioutcome_comp_def(ctx: Context<InitMultiOutcomeCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn init_accuracy_comp_def(ctx: Context<InitAccuracyCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }
}

// All account instruction below

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = CYPHER_MARKET_SPACE,
        seeds = [b"cypher_market"],
        bump,
    )]
    pub cypher_market: Account<'info, CyperMarket>,

    #[account(
        constraint = treasury.mint == accepted_mint.key() @ CypherError::InvalidMint,
    )]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

    pub accepted_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateMarketGroup<'info> {
    #[account(
        mut,
        seeds = [b"cypher_market"],
        bump = cypher_market.bump,
        constraint = !cypher_market.is_paused @ CypherError::ProtocolPaused,
    )]
    pub cypher_market: Box<Account<'info, CyperMarket>>,

    #[account(
        init,
        payer = creator,
        space = MARKET_GROUP_SPACE,
        seeds = [
            b"market_group",
            cypher_market.key().as_ref(),
            &cypher_market.market_count.to_le_bytes(),
        ],
        bump,
    )]
    pub market_group: Box<Account<'info, MarketGroup>>,

    #[account(
        init,
        payer = creator,
        space = BOND_SPACE,
        seeds = [b"bond", market_group.key().as_ref()],
        bump,
    )]
    pub bond: Box<Account<'info, Bond>>,

    #[account(
        init,
        payer = creator,
        token::mint     = accepted_mint,
        token::authority = bond_vault_authority,
        seeds = [b"bond_vault", bond.key().as_ref()],
        bump,
    )]
    pub bond_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA used as bond vault token authority
    #[account(
        seeds = [b"bond_vault_authority", bond.key().as_ref()],
        bump,
    )]
    pub bond_vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = creator_token_account.mint == cypher_market.accepted_mint
            @ CypherError::InvalidMint,
        constraint = creator_token_account.owner == creator.key()
            @ CypherError::UnauthorizedAuthority,
    )]
    pub creator_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        constraint = accepted_mint.key() == cypher_market.accepted_mint
            @ CypherError::InvalidMint,
    )]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CreateFlatMarket<'info> {
    #[account(seeds = [b"cypher_market"], bump = cypher_market.bump)]
    pub cypher_market: Account<'info, CyperMarket>,

    #[account(
        constraint = market_group.creator == creator.key() @ CypherError::UnauthorizedAuthority,
        constraint = market_group.is_open() @ CypherError::MarketNotOpen,
    )]
    pub market_group: Account<'info, MarketGroup>,

    #[account(
        init, payer = creator, space = MARKET_SPACE,
        seeds = [b"market", market_group.key().as_ref(), &[0u8]], bump,
    )]
    pub market: Account<'info, Market>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(tier: Tier)]
pub struct CreateTierMarket<'info> {
    #[account(seeds = [b"cypher_market"], bump = cypher_market.bump)]
    pub cypher_market: Account<'info, CyperMarket>,

    #[account(
        constraint = market_group.creator == creator.key() @ CypherError::UnauthorizedAuthority,
        constraint = market_group.is_open() @ CypherError::MarketNotOpen,
    )]
    pub market_group: Account<'info, MarketGroup>,

    #[account(
        init, payer = creator, space = MARKET_SPACE,
        seeds = [b"market", market_group.key().as_ref(), &[tier.as_byte()]], bump,
    )]
    pub market: Account<'info, Market>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_index: u8)]
pub struct CreatePool<'info> {
    #[account(seeds = [b"cypher_market"], bump = cypher_market.bump)]
    pub cypher_market: Box<Account<'info, CyperMarket>>,

    #[account(constraint = market_group.creator == creator.key() @ CypherError::UnauthorizedAuthority)]
    pub market_group: Box<Account<'info, MarketGroup>>,

    pub market: Box<Account<'info, Market>>,

    #[account(
        init, payer = creator, space = POOL_SPACE,
        seeds = [b"pool", market.key().as_ref(), &[pool_index]], bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        init, payer = creator,
        token::mint      = accepted_mint,
        token::authority = vault_authority,
        seeds = [b"vault", pool.key().as_ref()], bump,
    )]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA — pool vault token authority
    #[account(seeds = [b"vault_authority", pool.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(constraint = accepted_mint.key() == cypher_market.accepted_mint @ CypherError::InvalidMint)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CancelMarket<'info> {
    #[account(
        mut,
        constraint = market_group.creator == creator.key() @ CypherError::UnauthorizedAuthority,
    )]
    pub market_group: Account<'info, MarketGroup>,

    #[account(mut, constraint = bond.group == market_group.key())]
    pub bond: Account<'info, Bond>,

    #[account(mut, seeds = [b"bond_vault", bond.key().as_ref()], bump)]
    pub bond_vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: PDA — bond vault authority
    #[account(seeds = [b"bond_vault_authority", bond.key().as_ref()], bump)]
    pub bond_vault_authority: UncheckedAccount<'info>,

    #[account(mut, constraint = pool.participant_count == 0 @ CypherError::MarketHasParticipants)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        constraint = creator_token_account.owner == creator.key() @ CypherError::UnauthorizedAuthority,
    )]
    pub creator_token_account: InterfaceAccount<'info, TokenAccount>,

    pub creator: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(seeds = [b"cypher_market"], bump = cypher_market.bump)]
    pub cypher_market: Box<Account<'info, CyperMarket>>,

    #[account(constraint = market_group.is_open() @ CypherError::MarketNotOpen)]
    pub market_group: Box<Account<'info, MarketGroup>>,

    #[account(mut, constraint = market.group == market_group.key())]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        constraint = pool.market == market.key() @ CypherError::PoolNotOpen,
        constraint = pool.status == PoolStatus::Open @ CypherError::PoolNotOpen,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()], bump,
        constraint = pool_vault.mint == cypher_market.accepted_mint @ CypherError::InvalidMint,
    )]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init, payer = user, space = POSITION_SPACE,
        seeds = [b"position", pool.key().as_ref(), user.key().as_ref()], bump,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        constraint = user_token_account.mint == cypher_market.accepted_mint @ CypherError::InvalidMint,
        constraint = user_token_account.owner == user.key() @ CypherError::UnauthorizedClaim,
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceBetAccuracy<'info> {
    #[account(seeds = [b"cypher_market"], bump = cypher_market.bump)]
    pub cypher_market: Box<Account<'info, CyperMarket>>,

    #[account(constraint = market_group.is_open() @ CypherError::MarketNotOpen)]
    pub market_group: Box<Account<'info, MarketGroup>>,

    #[account(mut, constraint = market.group == market_group.key())]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        constraint = pool.market == market.key() @ CypherError::PoolNotOpen,
        constraint = pool.status == PoolStatus::Open @ CypherError::PoolNotOpen,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()], bump,
        constraint = pool_vault.mint == cypher_market.accepted_mint @ CypherError::InvalidMint,
    )]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init, payer = user, space = POSITION_SPACE,
        seeds = [b"position", pool.key().as_ref(), user.key().as_ref()], bump,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        constraint = user_token_account.mint == cypher_market.accepted_mint @ CypherError::InvalidMint,
        constraint = user_token_account.owner == user.key() @ CypherError::UnauthorizedClaim,
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LockMarket<'info> {
    #[account(mut, constraint = market_group.is_open() @ CypherError::MarketNotOpen)]
    pub market_group: Account<'info, MarketGroup>,

    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct ClaimPayout<'info> {
    #[account(
        mut,
        constraint = position.user == user.key() @ CypherError::UnauthorizedClaim,
        constraint = position.status == PositionStatus::Settled @ CypherError::PositionNotSettled,
        constraint = position.payout > 0 @ CypherError::ZeroPayout,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(mut, constraint = pool.key() == position.pool)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump)]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA — pool vault authority
    #[account(seeds = [b"vault_authority", pool.key().as_ref()], bump = pool.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, constraint = user_token_account.owner == user.key() @ CypherError::UnauthorizedClaim)]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ReturnBond<'info> {
    #[account(constraint = market_group.status == GroupStatus::Settled @ CypherError::MarketNotSettled)]
    pub market_group: Account<'info, MarketGroup>,

    #[account(
        mut,
        constraint = bond.group == market_group.key(),
        constraint = bond.creator == creator.key() @ CypherError::UnauthorizedBondReturn,
        constraint = bond.status == BondStatus::Locked @ CypherError::BondNotLocked,
    )]
    pub bond: Account<'info, Bond>,

    #[account(mut, seeds = [b"bond_vault", bond.key().as_ref()], bump)]
    pub bond_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA — bond vault authority
    #[account(seeds = [b"bond_vault_authority", bond.key().as_ref()], bump = bond.vault_authority_bump)]
    pub bond_vault_authority: UncheckedAccount<'info>,

    #[account(mut, constraint = creator_token_account.owner == creator.key() @ CypherError::UnauthorizedBondReturn)]
    pub creator_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub creator: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SlashBond<'info> {
    #[account(mut, constraint = market_group.is_locked() @ CypherError::MarketNotLocked)]
    pub market_group: Account<'info, MarketGroup>,

    #[account(
        mut,
        constraint = bond.group == market_group.key(),
        constraint = bond.status == BondStatus::Locked @ CypherError::BondNotLocked,
    )]
    pub bond: Account<'info, Bond>,

    #[account(mut, seeds = [b"bond_vault", bond.key().as_ref()], bump)]
    pub bond_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA — bond vault authority
    #[account(seeds = [b"bond_vault_authority", bond.key().as_ref()], bump = bond.vault_authority_bump)]
    pub bond_vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

// 2nd group - (oracle instructions)
#[derive(Accounts)]
pub struct PostResolution<'info> {
    #[account(
        mut,
        constraint = market_group.is_locked() @ CypherError::MarketNotLocked,
        constraint = market_group.oracle_authority == oracle_signer.key() @ CypherError::UnauthorizedOracle,
    )]
    pub market_group: Account<'info, MarketGroup>,

    pub oracle_signer: Signer<'info>,
}

// ARCIUM ACCOUNT CONTEXTS

#[init_computation_definition_accounts("settle_yesno", payer)]
#[derive(Accounts)]
pub struct InitYesNoCompDef<'info> {
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

#[init_computation_definition_accounts("settle_multioutcome", payer)]
#[derive(Accounts)]
pub struct InitMultiOutcomeCompDef<'info> {
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

#[init_computation_definition_accounts("settle_accuracy", payer)]
#[derive(Accounts)]
pub struct InitAccuracyCompDef<'info> {
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

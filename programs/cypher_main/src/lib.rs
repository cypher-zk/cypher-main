use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_interface::{Mint, TokenAccount},
};
use arcium_anchor::prelude::*;

pub mod states;
use states::*;

declare_id!("7JpiCk5c1jZdBC9moiUBQbAjdvCGqUhuMRn4r4FpSjV4");

// Constants
pub const BOND_AMOUNT: u64 = 10_000_000; // $10 USDC (6 decimals)
pub const USDC_DECIMALS: u8 = 6;

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

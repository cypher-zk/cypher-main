use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};
use arcium_anchor::prelude::*;

pub mod states;
use states::*;

declare_id!("F6pTnahcgW4gJX3iKxihmZGNUJN1jH4s77ijpK34FpFc");

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
}

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
    pub treasury: Account<'info, TokenAccount>,

    pub accepted_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

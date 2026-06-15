use anchor_lang::prelude::*;

// CYPHER — states.rs   (YesNo + MultiOutcome)

/// The only SPL mint accepted for bets. Selected at compile time via build.rs:
///   `CYPHER_CLUSTER=mainnet` → Circle USDC
///   anything else (default)  → Cypher Coin (CSDC) on devnet
#[cfg(cypher_mainnet)]
pub const ACCEPTED_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
#[cfg(not(cypher_mainnet))]
pub const ACCEPTED_MINT: Pubkey = pubkey!("8AF9BABNWwEhipRxtXPYoWSZW24SKjUn6YqbKd9ZqhwB");

// SPACE CONSTANTS

pub const GLOBAL_STATE_SPACE: usize = 8   // discriminator
    + 8   // market_counter: u64
    + 2   // protocol_fee_rate: u16
    + 2   // lp_fee_rate: u16
    + 32  // protocol_treasury: Pubkey
    + 32  // accepted_mint: Pubkey     
    + 32  // admin: Pubkey
    + 1   // bump: u8
    + 6; // padding

pub const MARKET_SPACE: usize = 8    // discriminator
    + 8   // market_id: u64
    + 200 // question: [u8; 200]
    + 1   // question_len: u8
    + 1   // market_type: u8   0=YesNo, 1=MultiOutcome
    + 1 // num_outcomes: u8  (0 for YesNo, 2-4 for MultiOutcome)
    + 1  // category: u8
    + 32  // creator: Pubkey
    + 32  // resolver: Pubkey
    + 8   // creator_bond: u64
    + 1   // bond_withdrawn: bool
    + 8   // total_bets_count: u64
    //  encrypted pools (MXE-owned ciphertexts) 
    + 32  // encrypted_yes_pool / encrypted_pool_0: [u8;32]
    + 32  // encrypted_no_pool  / encrypted_pool_1: [u8;32]
    + 32  // encrypted_pool_2: [u8;32]  (MultiOutcome only, zeroed for YesNo)
    + 32  // encrypted_pool_3: [u8;32]  (MultiOutcome only, zeroed for YesNo)
    + 16  // mxe_nonce: u128
    //  revealed after resolution 
    + 8   // revealed_pool_0: u64
    + 8   // revealed_pool_1: u64
    + 8   // revealed_pool_2: u64
    + 8   // revealed_pool_3: u64
    + 1   // state: u8   0=Active, 1=Closed, 2=Resolved, 3=Unresolved
    + 1   // outcome: u8   0=None, 1-4=outcome index+1
    + 8   // close_time: i64
    + 8   // resolution_time: i64
    + 8   // payout_ratio: u64   (scaled 1e9)
    + 8   // accumulated_lp_fees: u64
    + 8   // accumulated_protocol_fees: u64
    + 8   // min_bet: u64
    + 8   // total_payouts_claimed: u64
    + 8   // total_refunds_claimed: u64
    + 1   // admin_claimed_remaining: bool
    + 1   // pending_outcome: u8
    + 8   // resolution_deadline: i64
    + 8   // claim_deadline: i64
    + 8   // refund_deadline: i64
    + 1   // bump: u8
    + 1   // vault_bump: u8
    + 6; // padding

pub const ENCRYPTED_POSITION_SPACE: usize = 8  // discriminator
    + 32  // user: Pubkey
    + 32  // market: Pubkey
    + 32  // encrypted_amount: [u8;32]
    + 32  // encrypted_side: [u8;32]
    + 32  // user_pubkey: [u8;32]   (x25519 — for user to decrypt their own data)
    + 16  // nonce: u128
    + 8   // entry_odds: u64   PUBLIC — computed inside MXE at bet time
    + 8   // net_amount: u64  on-chain verified amount after fees
    + 1   // claimed: bool
    + 1   // bump: u8
    + 6; // padding

pub const LP_POSITION_SPACE: usize = 8   // discriminator
    + 32  // lp_provider: Pubkey
    + 32  // market: Pubkey
    + 8   // liquidity_provided: u64
    + 8   // fees_earned: u64
    + 1   // fees_claimed: bool
    + 8   // fees_claimed_amount: u64
    + 1   // bump: u8
    + 6; // padding

// MARKET STATES (u8 for Arcium compatibility)
pub const MARKET_STATE_ACTIVE: u8 = 0;
pub const MARKET_STATE_CLOSED: u8 = 1;
pub const MARKET_STATE_RESOLVED: u8 = 2;
pub const MARKET_STATE_UNRESOLVED: u8 = 3; // resolution deadline passed

//  MARKET TYPES
pub const MARKET_TYPE_YESNO: u8 = 0;
pub const MARKET_TYPE_MULTIOUTCOME: u8 = 1;

//  DEFAULT TIME CONSTANTS
pub const DEFAULT_RESOLUTION_WINDOW: i64 = 7 * 24 * 3600; // 7 days after close
pub const DEFAULT_CLAIM_PERIOD: i64 = 14 * 24 * 3600; // 14 days after resolution
pub const DEFAULT_REFUND_PERIOD: i64 = 14 * 24 * 3600; // 14 days after unresolved

// MIN BET
pub const MIN_BET_USDC: u64 = 1_000_000; // $1 USDC minimum
pub const CREATOR_BOND: u64 = 10_000_000; // $10 USDC bond

// CATEGORY CONSTANTS (u8 for Arcium compatibility)

pub const CATEGORY_CRYPTO: u8 = 0;
pub const CATEGORY_POLITICS: u8 = 1;
pub const CATEGORY_SPORTS: u8 = 2;
pub const CATEGORY_TECH: u8 = 3;
pub const CATEGORY_ECONOMY: u8 = 4;
pub const CATEGORY_CULTURE: u8 = 5;
pub const CATEGORY_BEYOND: u8 = 6;

//
//  ACCOUNTS
//

/// Protocol-wide config. One per deployment.
/// Seeds: ["global_state"]
#[account]
pub struct GlobalState {
    /// Counter for unique market IDs
    pub market_counter: u64,
    /// Protocol fee in basis points → goes to treasury (1 bp = 0.01%)
    pub protocol_fee_rate: u16,
    /// LP fee in basis points → goes to market creator (150 bp = 1.5%)
    pub lp_fee_rate: u16,
    /// Treasury wallet for protocol fees
    pub protocol_treasury: Pubkey,
    /// USDC mint that all markets use
    pub accepted_mint: Pubkey,
    /// Admin who can update settings
    pub admin: Pubkey,
    pub bump: u8,
}

/// One prediction market.
/// Seeds: ["market", market_id.to_le_bytes()]
#[account]
pub struct Market {
    pub market_id: u64,
    pub question: [u8; 200],
    pub question_len: u8,
    /// 0 = YesNo, 1 = MultiOutcome
    pub market_type: u8,
    pub num_outcomes: u8,
    pub category: u8,
    pub creator: Pubkey,
    /// Who can call resolve_market
    pub resolver: Pubkey,
    pub creator_bond: u64,
    pub bond_withdrawn: bool,
    pub total_bets_count: u64,

    //  Encrypted pools — updated by place_private_bet circuit
    // YesNo:        pool_0=YES, pool_1=NO, pool_2=0, pool_3=0
    // MultiOutcome: pool_0..3 = outcome 0..3
    pub encrypted_pool_0: [u8; 32],
    pub encrypted_pool_1: [u8; 32],
    pub encrypted_pool_2: [u8; 32],
    pub encrypted_pool_3: [u8; 32],
    pub mxe_nonce: u128,

    //  Revealed after resolution — written by reveal callback
    pub revealed_pool_0: u64,
    pub revealed_pool_1: u64,
    pub revealed_pool_2: u64,
    pub revealed_pool_3: u64,

    /// 0=Active, 1=Closed, 2=Resolved, 3=Unresolved
    pub state: u8,
    /// YesNo: 0=NO, 1=YES (matches BetInput.side encoding) | Multi: 0=None,1-4=outcome+1
    pub outcome: u8,
    /// Pending outcome set in resolve_market, confirmed by reveal callback
    pub pending_outcome: u8,

    pub close_time: i64,
    pub resolution_time: i64,

    /// payout_ratio = total_pool / winner_pool × 1e9 — set at resolution
    pub payout_ratio: u64,

    pub accumulated_lp_fees: u64,
    pub accumulated_protocol_fees: u64,
    pub min_bet: u64,
    pub total_payouts_claimed: u64,
    pub total_refunds_claimed: u64,
    pub admin_claimed_remaining: bool,

    /// Deadlines (copied from policy or defaults at creation)
    pub resolution_deadline: i64,
    pub claim_deadline: i64,
    pub refund_deadline: i64,

    pub bump: u8,
    pub vault_bump: u8,
}

/// Per-user per-market position. Both amount and side are encrypted.
/// Seeds: ["position", market.key(), user.key()]
#[account]
pub struct EncryptedPosition {
    pub user: Pubkey,
    pub market: Pubkey,
    /// Encrypted net bet amount (USDC micro, after fees)
    pub encrypted_amount: [u8; 32],
    /// Encrypted side (0/1 for YesNo, 0-3 for Multi)
    pub encrypted_side: [u8; 32],
    /// User's x25519 public key — stored so user can decrypt their own position
    pub user_pubkey: [u8; 32],
    pub nonce: u128,
    /// Entry odds locked at bet time — PUBLIC.
    /// = (total_pool / side_pool) × 1e9, computed inside MXE
    pub entry_odds: u64,
    /// On-chain verified net amount (bet_amount - protocol_fee - lp_fee).
    /// Used by payout circuit to cap claims to what was actually deposited.
    pub net_amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

/// Creator's LP position — tracks fees earned from bets.
/// Seeds: ["lp-position", market.key(), creator.key()]
#[account]
pub struct LPPosition {
    pub lp_provider: Pubkey,
    pub market: Pubkey,
    pub liquidity_provided: u64,
    pub fees_earned: u64,
    pub fees_claimed: bool,
    pub fees_claimed_amount: u64,
    pub bump: u8,
}

//  EVENTS

#[event]
pub struct MarketCreatedEvent {
    pub market_id: u64,
    pub market_type: u8,
    pub category: u8,
    pub creator: Pubkey,
    pub question: String,
    pub close_time: i64,
}

#[event]
pub struct BetPlacedEvent {
    pub market: Pubkey,
    pub user: Pubkey,
    pub encrypted_amount: [u8; 32],
    pub encrypted_side: [u8; 32],
    pub nonce: u128,
    pub entry_odds: u64, // PUBLIC — locked-in ratio
}

#[event]
pub struct MarketResolvedEvent {
    pub market: Pubkey,
    pub outcome: u8,
    pub revealed_pool_0: u64,
    pub revealed_pool_1: u64,
    pub revealed_pool_2: u64,
    pub revealed_pool_3: u64,
    pub payout_ratio: u64,
}

#[event]
pub struct PayoutClaimedEvent {
    pub market: Pubkey,
    pub user: Pubkey,
    pub payout_amount: u64,
}

#[event]
pub struct RefundClaimedEvent {
    pub market: Pubkey,
    pub user: Pubkey,
    pub refund_amount: u64,
}

#[event]
pub struct MarketCancelledEvent {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub bond_returned: u64,
}

#[event]
pub struct CreatorWithdrawnEvent {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub bond: u64,
    pub lp_fees: u64,
    pub total: u64,
}

//  ERRORS

#[error_code]
pub enum CypherError {
    #[msg("Market is not active")]
    MarketNotActive,
    #[msg("Market has closed, no more bets allowed")]
    MarketClosed,
    #[msg("Market is still open, cannot resolve yet")]
    MarketStillOpen,
    #[msg("Market has already been resolved")]
    AlreadyResolved,
    #[msg("Market has not been resolved yet")]
    NotResolved,
    #[msg("Only the designated resolver can resolve this market")]
    UnauthorizedResolver,
    #[msg("Only admin can perform this action")]
    UnauthorizedAdmin,
    #[msg("Position has already been claimed")]
    AlreadyClaimed,
    #[msg("This position is on the losing side")]
    PositionLost,
    #[msg("Insufficient bet amount")]
    BetTooSmall,
    #[msg("Insufficient vault balance for payout")]
    InsufficientVaultBalance,
    #[msg("No fees to claim")]
    NoFeesToClaim,
    #[msg("Initial liquidity too low")]
    LiquidityTooLow,
    #[msg("Close time must be in the future")]
    InvalidCloseTime,
    #[msg("Question cannot be empty")]
    EmptyQuestion,
    #[msg("Question too long (max 200 bytes)")]
    QuestionTooLong,
    #[msg("Integer overflow")]
    Overflow,
    #[msg("Invalid outcome value for market type")]
    InvalidOutcome,
    #[msg("Invalid fee rate")]
    InvalidFeeRate,
    #[msg("Treasury mismatch")]
    InvalidTreasury,
    #[msg("Creator bond already withdrawn")]
    BondAlreadyWithdrawn,
    #[msg("Only market creator can do this")]
    NotMarketCreator,
    #[msg("Cannot cancel market with existing bets")]
    MarketHasBets,
    #[msg("Resolution deadline has passed")]
    ResolutionDeadlinePassed,
    #[msg("Market not in unresolved state")]
    MarketNotUnresolved,
    #[msg("Resolution deadline not reached yet")]
    ResolutionDeadlineNotReached,
    #[msg("Claim period has expired")]
    ClaimPeriodExpired,
    #[msg("Refund period has expired")]
    RefundPeriodExpired,
    #[msg("MPC computation was aborted")]
    AbortedComputation,
    #[msg("Computation output verification failed")]
    ComputationVerificationFailed,
    #[msg("Cannot withdraw from unresolved market — bond forfeited")]
    CannotWithdrawFromUnresolved,
    #[msg("Admin already claimed remaining funds")]
    AdminAlreadyClaimed,
    #[msg("Wrong market type for this instruction")]
    WrongMarketType,
    #[msg("Mint does not match accepted mint")]
    WrongMint,
    #[msg("Mint is not the protocol-accepted mint for this cluster")]
    NotAcceptedMint,
    #[msg("Invalid category — must be 0-6")]
    InvalidCategory,
}

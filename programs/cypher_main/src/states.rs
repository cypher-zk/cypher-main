use anchor_lang::prelude::*;

//  CYPHER MARKET — STATE
//
//  Account hierarchy per market:
//    CyperMarket (1 global)
//    └── MarketGroup   (1 per question)
//        ├── Bond PDA  (1 per group — creator's $10)
//        ├── Market    (1 for YesNo/Multi, 3 for Accuracy)
//        │   └── Pool  (1 unified for YesNo/Multi, 1 per tier for Accuracy)
//        │       ├── Pool vault    (SPL token account — user stakes)
//        │       ├── Position PDAs (1 per user per pool)
//        │       └── SettlementRegistry (1 per pool, created at settlement)
//        └── Bond vault (SPL token account — creator bond)

// ─── ENUMS ────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum MarketType {
    YesNo,        // encrypted {side: 0|1}
    MultiOutcome, // encrypted {outcome_index: 0-3}
    Accuracy,     // encrypted {value: u64 × 1000}
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum MarketCategory {
    Crypto,
    Sports,
    Politics,
    Weather,
    Economics,
    Entertainment,
    Other,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum OracleType {
    /// Crypto markets (BTC/USD, ETH/USD, SOL/USD etc).
    /// Backend oracle service reads the Pyth price account,
    /// constructs the tx, and signs with oracle_authority keypair.
    Pyth,

    /// Sports, Politics, Weather, Economics, Entertainment — anything
    /// where no Pyth feed exists.
    /// Backend oracle service reads the Switchboard aggregator account,
    /// constructs the tx, and signs with oracle_authority keypair.
    /// Same signing flow as Pyth — only the data source changes.
    Switchboard,

    /// No automated feed available for this question.
    /// Creator signs post_resolution from frontend using their own wallet.
    /// oracle_authority == creator.key() for these markets.
    /// If creator misses resolve_deadline, slash_bond() can be called by anyone.
    Manual,
}

/// Accuracy market entry fee tiers. Each tier has its own pool.
/// Bettors in $1 tier compete only against other $1 bettors — wallet size is irrelevant.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum Tier {
    Micro,    // $1   — bet_size = 1_000_000  (USDC 6 decimals)
    Standard, // $10  — bet_size = 10_000_000
    Whale,    // $100 — bet_size = 100_000_000
}

impl Tier {
    pub fn bet_size(&self) -> u64 {
        match self {
            Tier::Micro => 1_000_000,
            Tier::Standard => 10_000_000,
            Tier::Whale => 100_000_000,
        }
    }

    /// Used as the `tier_byte` in Market PDA seeds.
    /// YesNo/Multi use tier_byte = 0 (flat market, no tiers).
    pub fn as_byte(&self) -> u8 {
        match self {
            Tier::Micro => 0,
            Tier::Standard => 1,
            Tier::Whale => 2,
        }
    }
}

/// The oracle's answer. Stored on MarketGroup after post_resolution.
/// Public after resolution — positions are still encrypted at this point.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum ResolvedValue {
    YesNo(bool),  // true = YES won, false = NO won
    Outcome(u8),  // winning outcome index 0-3 for MultiOutcome
    Numeric(u64), // actual price × 1000 for Accuracy  (e.g. $100.123 → 100_123)
}

impl ResolvedValue {
    /// Returns the u8 resolved_side for YesNo circuit input.
    pub fn as_yesno_side(&self) -> Option<u8> {
        match self {
            ResolvedValue::YesNo(won) => Some(if *won { 1 } else { 0 }),
            _ => None,
        }
    }

    /// Returns the u8 resolved_outcome for MultiOutcome circuit input.
    pub fn as_outcome_index(&self) -> Option<u8> {
        match self {
            ResolvedValue::Outcome(idx) => Some(*idx),
            _ => None,
        }
    }

    /// Returns the u64 resolved_value for Accuracy circuit input.
    pub fn as_numeric(&self) -> Option<u64> {
        match self {
            ResolvedValue::Numeric(v) => Some(*v),
            _ => None,
        }
    }
}

/// Lifecycle status of a MarketGroup.
/// Transitions: Open → Locked → Resolving → Settling → Settled
///              Open → Voided  (cancel before bets)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum GroupStatus {
    Open,      // accepting bets
    Locked,    // past lock_timestamp, no more bets, oracle can post
    Resolving, // resolution posted, dispute_deadline window active
    Settling,  // backend queued Arcium shard jobs
    Settled,   // all shards done, all payouts written
    Voided,    // cancelled — 0 participants, bond returned
}

/// Pool status. Mirrors group status for the pool's lifecycle.
/// Transitions: Open → Settling → Settled
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum PoolStatus {
    Open,     // accepting bets via place_bet / place_bet_accuracy
    Settling, // Arcium jobs queued, waiting for callbacks
    Settled,  // all callbacks done, payouts can be written
}

/// Whether the pool holds variable-stake bets (YesNo/Multi) or fixed-fee bets (Accuracy).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum PoolType {
    Unified,  // YesNo + MultiOutcome — all bettors, all sides, one vault
    Accuracy, // one per tier, fixed bet_size, separate vault
}

/// Per-position lifecycle.
/// Transitions: Open → Settled → Claimed
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum PositionStatus {
    Open,    // bet placed, waiting for settlement
    Settled, // write_position_payout has been called — payout amount is final
    Claimed, // claim_payout called — USDC transferred to user
}

/// Creator's $10 bond status.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum BondStatus {
    Locked,   // held in bond_vault
    Returned, // creator called return_bond after settlement
    Slashed,  // slash_bond called — creator missed resolve_deadline
}

/// SettlementRegistry status.
/// Backend monitors for Finalizing to trigger write_position_payout.
/// Transitions: InProgress → Finalizing → Complete
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum RegistryStatus {
    InProgress, // settled_shards < total_shards — still waiting on callbacks
    Finalizing, // settled_shards == total_shards — payout_writer should act now
    Complete,   // all write_position_payout calls done
}

// ─── SPACE CONSTANTS ──────────────────────────────────────────────────────────
// All constants include the 8-byte Anchor discriminator.
// Use these in: #[account(init, space = ACCOUNT_SPACE)]

pub const CYPHER_MARKET_SPACE: usize = 8   // discriminator
    + 32   // authority: Pubkey
    + 32   // treasury: Pubkey
    + 32   // accepted_mint: Pubkey  (USDC mint — enforced on every vault + transfer)
    + 2    // protocol_fee_bps: u16
    + 2    // lp_fee_bps: u16
    + 2    // accuracy_platform_fee_bps: u16
    + 8    // market_count: u64
    + 1    // is_paused: bool
    + 1    // bump: u8
    + 64; // _padding: [u8; 64]

pub const MARKET_GROUP_SPACE: usize = 8    // discriminator
    + 32   // creator: Pubkey
    + 32   // config: Pubkey  (CyperMarket PDA)
    + 8    // group_index: u64
    + 1    // market_type: MarketType (1 byte discriminant, no data)
    + 1    // category: MarketCategory
    + 1    // oracle_type: OracleType
    + 32   // oracle_authority: Pubkey  (signs post_resolution)
    + 33   // pyth_feed: Option<Pubkey>        (Pyth price account, None if not Pyth)
    + 33   // switchboard_feed: Option<Pubkey> (Switchboard aggregator, None if not Switchboard)
    + 4 + 256  // question: String  (max 256 chars)
    + 4 + (4 + 32) * 4  // outcome_labels: Vec<String> max 4 × 32 chars
    + 8    // lock_timestamp: i64
    + 8    // resolve_deadline: i64
    + 9    // resolved_at: Option<i64>
    + 1 + 8 // resolved_value: Option<ResolvedValue>  (discriminant + max data)
    + 9    // dispute_deadline: Option<i64>
    + 1    // status: GroupStatus
    + 1    // bond: Pubkey shortcut — actually store bump only
    + 1    // bump: u8
    + 128; // _padding: [u8; 128]

pub const MARKET_SPACE: usize = 8     // discriminator
    + 32   // group: Pubkey
    + 1    // market_type: MarketType
    + 1    // tier_byte: u8  (0=flat/Micro, 1=Standard, 2=Whale)
    + 8    // bet_size: u64  (0 for variable-stake YesNo/Multi)
    + 2    // protocol_fee_bps: u16
    + 2    // lp_fee_bps: u16
    + 8    // total_participants: u64
    + 8    // total_volume: u64
    + 1    // status: GroupStatus (mirrors group)
    + 1    // bump: u8
    + 64; // _padding: [u8; 64]

pub const POOL_SPACE: usize = 8       // discriminator
    + 32   // market: Pubkey
    + 32   // group: Pubkey
    + 1    // pool_index: u8
    + 1    // pool_type: PoolType
    + 32   // vault: Pubkey  (SPL token account)
    + 1    // vault_authority_bump: u8
    + 8    // participant_count: u64
    + 8    // total_staked: u64
    + 1    // status: PoolStatus
    + 1    // bump: u8
    + 64; // _padding: [u8; 64]

// encrypted_payload max 128 bytes — Arcium ciphertext for {side:u8} or {value:u64}
pub const POSITION_SPACE: usize = 8   // discriminator
    + 32   // pool: Pubkey
    + 32   // market: Pubkey
    + 32   // group: Pubkey
    + 32   // user: Pubkey
    + 4 + 128  // encrypted_payload: Vec<u8>  (Arcium ciphertext, max 128 bytes)
    + 8    // stake: u64  (0 for accuracy — enforced by bet_size)
    + 8    // placed_at: i64
    + 8    // payout: u64  (0 until write_position_payout called)
    + 1    // status: PositionStatus
    + 1    // bump: u8
    + 32; // _padding: [u8; 32]

pub const BOND_SPACE: usize = 8       // discriminator
    + 32   // group: Pubkey
    + 32   // creator: Pubkey
    + 8    // amount: u64  (always 10_000_000 — $10 USDC)
    + 32   // vault: Pubkey  (SPL token account for bond)
    + 1    // vault_authority_bump: u8
    + 1    // status: BondStatus
    + 1    // bump: u8
    + 32; // _padding: [u8; 32]

pub const SETTLEMENT_REGISTRY_SPACE: usize = 8  // discriminator
    + 32   // pool: Pubkey
    + 32   // market: Pubkey
    + 32   // group: Pubkey
    + 4    // total_shards: u32
    + 4    // settled_shards: u32
    + 1    // status: RegistryStatus
    + 1    // bump: u8
    + 32; // _padding: [u8; 32]

// ─── ACCOUNTS ─────────────────────────────────────────────────────────────────

/// Global protocol config. One per deploy.
/// Seeds: ["cypher_market"]
/// Owner: program
/// Created by: initialize()  — admin keypair
#[account]
pub struct CyperMarket {
    /// Admin keypair. Can update fees, pause protocol.
    pub authority: Pubkey,

    /// Treasury USDC token account. Receives protocol fees.
    pub treasury: Pubkey,

    /// The ONLY mint accepted across the entire protocol.
    /// Set once at initialize() — never changes.
    /// Devnet:  4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
    /// Mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
    /// Enforced via constraint on every vault creation and every transfer.
    pub accepted_mint: Pubkey,

    /// Protocol fee in basis points (e.g. 50 = 0.5%).
    /// Applied to total pool on YesNo/MultiOutcome markets.
    /// Sent to treasury during settle_*_callback.
    pub protocol_fee_bps: u16,

    /// LP / creator fee in basis points (e.g. 150 = 1.5%).
    /// Applied to total pool on YesNo/MultiOutcome markets.
    /// Sent to creator during settle_*_callback.
    pub lp_fee_bps: u16,

    /// Platform fee for Accuracy markets in basis points (e.g. 2000 = 20%).
    /// Applied to loser pool only. Sent to treasury via accuracy_send_fees.
    pub accuracy_platform_fee_bps: u16,

    /// Total number of market groups ever created. Used as group_index seed.
    pub market_count: u64,

    /// Emergency pause. When true, place_bet and create_market_group are blocked.
    pub is_paused: bool,

    pub bump: u8,

    pub _padding: [u8; 64],
}

/// One per prediction question. Parent of all Market, Pool, Position accounts.
/// Seeds: ["market_group", cypher_market.key(), group_index.to_le_bytes()]
/// Owner: program
/// Created by: create_market_group()  — creator wallet via frontend
#[account]
pub struct MarketGroup {
    /// Wallet that created this group. Receives lp_fee. Posts resolution on manual markets.
    pub creator: Pubkey,

    /// CyperMarket PDA. Used in seeds.
    pub config: Pubkey,

    /// Monotonically increasing index. Used in seeds. Set from market_count at creation.
    pub group_index: u64,

    pub market_type: MarketType,
    pub category: MarketCategory,

    /// Pyth: backend oracle service keypair.
    /// Manual: creator's wallet.
    /// This pubkey must sign post_resolution.
    pub oracle_type: OracleType,

    /// The pubkey that must sign post_resolution.
    /// Pyth:        backend oracle service keypair
    /// Switchboard: backend oracle service keypair (same service, different SDK call)
    /// Manual:      creator's wallet (oracle_authority == creator)
    pub oracle_authority: Pubkey,

    /// Pyth price account address (e.g. BTC/USD feed).
    /// Set when oracle_type == Pyth. None for Switchboard and Manual.
    /// Backend passes this to pythClient.getLatestPrice(pyth_feed).
    pub pyth_feed: Option<Pubkey>,

    /// Switchboard aggregator account address.
    /// Set when oracle_type == Switchboard. None for Pyth and Manual.
    /// Backend passes this to switchboardClient.getLatestResult(switchboard_feed).
    pub switchboard_feed: Option<Pubkey>,

    /// The prediction question. Max 256 characters.
    pub question: String,

    /// Human-readable outcome labels for MultiOutcome markets.
    /// e.g. ["Real Madrid", "Arsenal", "Bayern", "PSG"]
    /// Empty for YesNo and Accuracy.
    pub outcome_labels: Vec<String>,

    /// Unix timestamp when betting closes. lock_market() callable after this.
    pub lock_timestamp: i64,

    /// Unix timestamp by which creator must post resolution.
    /// slash_bond() callable after this if not resolved.
    pub resolve_deadline: i64,

    /// Set when post_resolution is called.
    pub resolved_at: Option<i64>,

    /// The oracle's answer. Set when post_resolution is called.
    /// None until resolution.
    pub resolved_value: Option<ResolvedValue>,

    /// Dispute window end. Set to resolved_at + 3600 when post_resolution is called.
    /// Backend runs settlement after this timestamp.
    pub dispute_deadline: Option<i64>,

    pub status: GroupStatus,

    pub bump: u8,

    pub _padding: [u8; 128],
}

/// One per betting tier per group.
/// YesNo/MultiOutcome: one Market per group (tier_byte = 0, bet_size = 0 = variable).
/// Accuracy: three Markets per group (tier_byte = 0/1/2 for Micro/Standard/Whale).
/// Seeds: ["market", group.key(), [tier_byte]]
/// Owner: program
/// Created by: create_flat_market() or create_tier_market()  — creator wallet
#[account]
pub struct Market {
    pub group: Pubkey,

    pub market_type: MarketType,

    /// 0 = flat (YesNo/Multi), 0/1/2 = Micro/Standard/Whale (Accuracy)
    pub tier_byte: u8,

    /// Fixed entry fee for Accuracy markets.
    /// 0 for YesNo/MultiOutcome (variable stakes).
    pub bet_size: u64,

    /// Copied from CyperMarket at creation time — locked in for this market's life.
    pub protocol_fee_bps: u16,
    pub lp_fee_bps: u16,

    /// Running totals across all pools under this market.
    pub total_participants: u64,
    pub total_volume: u64,

    pub bump: u8,

    pub _padding: [u8; 64],
}

/// The vault that holds all user stakes for a market.
/// YesNo/Multi: ONE unified pool — all bettors, all sides, one vault.
///   Pool address reveals nothing about prediction.
/// Accuracy: one per tier — pool_index matches tier_byte of parent Market.
/// Seeds: ["pool", market.key(), [pool_index]]
/// Owner: program
/// Created by: create_pool()  — creator wallet via frontend
#[account]
pub struct Pool {
    pub market: Pubkey,
    pub group: Pubkey,

    /// For YesNo/Multi: always 0 (one pool per market).
    /// For Accuracy: 0=Micro, 1=Standard, 2=Whale.
    pub pool_index: u8,

    pub pool_type: PoolType,

    /// SPL USDC token account. All user stakes held here.
    /// Authority = vault_authority PDA — program controls withdrawals.
    pub vault: Pubkey,

    /// Bump for vault_authority PDA: ["vault_authority", pool.key()]
    pub vault_authority_bump: u8,

    /// Total number of positions in this pool. Used to calculate shard count.
    pub participant_count: u64,

    /// Sum of all stakes in this pool (before fees).
    pub total_staked: u64,

    pub status: PoolStatus,

    pub bump: u8,

    pub _padding: [u8; 64],
}

/// One per user per pool. Holds the encrypted prediction and tracks payout.
/// Seeds: ["position", pool.key(), user.key()]
/// Owner: program
/// Created by: place_bet() or place_bet_accuracy()  — user wallet via frontend
#[account]
pub struct Position {
    pub pool: Pubkey,
    pub market: Pubkey,
    pub group: Pubkey,

    /// The bettor's wallet. Only this wallet can claim_payout.
    pub user: Pubkey,

    /// Arcium-encrypted prediction.
    /// YesNo:        encrypt({ side: 0|1 })         — 1 byte input
    /// MultiOutcome: encrypt({ outcome_index: 0-3 }) — 1 byte input
    /// Accuracy:     encrypt({ value: u64 })          — 8 byte input
    /// The ciphertext is ~64-128 bytes after Arcium encryption.
    /// This is the ONLY place the prediction exists.
    /// Decrypted only inside Arcium's MXE during settlement.
    pub encrypted_payload: Vec<u8>,

    /// Amount the user staked in lamports (USDC 6 decimals).
    /// For Accuracy, always equal to pool's parent Market.bet_size.
    /// PUBLIC — visible in BetPlaced event. Does not leak prediction.
    pub stake: u64,

    /// Unix timestamp of bet placement.
    pub placed_at: i64,

    /// Payout amount in USDC (6 decimals). Set by write_position_payout.
    /// 0 until settlement is complete.
    /// For losers: stays 0.
    /// For winners: stakeNet + proportional share of loser pool.
    pub payout: u64,

    pub status: PositionStatus,

    pub bump: u8,

    pub _padding: [u8; 32],
}

/// Creator's $10 USDC bond. Returned on honest resolution, slashed on miss.
/// Seeds: ["bond", group.key()]
/// Owner: program
/// Created by: create_market_group()  — creator pays bond atomically
#[account]
pub struct Bond {
    pub group: Pubkey,

    /// Creator wallet — only this key can call return_bond.
    pub creator: Pubkey,

    /// Always 10_000_000 (USDC). Stored for reference.
    pub amount: u64,

    /// SPL USDC token account holding the bond.
    /// Authority = bond_vault_authority PDA: ["bond_vault_authority", bond.key()]
    /// Completely separate from pool vaults — never mixed with user stakes.
    pub vault: Pubkey,

    /// Bump for bond_vault_authority PDA.
    pub vault_authority_bump: u8,

    pub status: BondStatus,

    pub bump: u8,

    pub _padding: [u8; 32],
}

/// Tracks Arcium shard settlement progress for a pool.
/// Created by init_settlement_registry() after dispute window.
/// Backend monitors for status == Finalizing to trigger payout computation.
/// Seeds: ["settlement_registry", pool.key()]
/// Owner: program
/// Created by: init_settlement_registry()  — backend keypair
#[account]
pub struct SettlementRegistry {
    pub pool: Pubkey,
    pub market: Pubkey,
    pub group: Pubkey,

    /// Total Arcium shard jobs queued = ceil(pool.participant_count / 8).
    /// For Accuracy: ceil(participant_count / 4).
    pub total_shards: u32,

    /// Incremented by each settle_*_callback. When == total_shards, status → Finalizing.
    pub settled_shards: u32,

    /// InProgress  → callbacks still arriving
    /// Finalizing  → all callbacks done — payout_writer should act NOW
    /// Complete    → write_position_payout done for all positions
    pub status: RegistryStatus,

    pub bump: u8,

    pub _padding: [u8; 32],
}

// ─── EVENTS ───────────────────────────────────────────────────────────────────
// Emitted via emit!() in instructions. Indexed by backend chain_indexer.

#[event]
pub struct GroupCreated {
    pub group: Pubkey,
    pub creator: Pubkey,
    pub market_type: MarketType,
    pub question: String,
    pub lock_timestamp: i64,
    pub resolve_deadline: i64,
    pub created_at: i64,
}

/// Emitted when any bettor places a bet — all 3 market types.
/// Intentionally does NOT include the side/outcome/value.
/// Prediction is encrypted inside the Position PDA, not emitted here.
#[event]
pub struct BetPlaced {
    pub position: Pubkey,
    pub market: Pubkey,
    pub group: Pubkey,
    pub pool: Pubkey,
    pub user: Pubkey,
    pub market_type: MarketType,
    pub stake: u64, // PUBLIC — stake amount visible
    pub placed_at: i64,
    // side/outcome/value intentionally omitted — stays encrypted
}

#[event]
pub struct GroupLocked {
    pub group: Pubkey,
    pub locked_at: i64,
    pub total_participants: u64,
    pub total_volume: u64,
}

#[event]
pub struct ResolutionPosted {
    pub group: Pubkey,
    pub oracle_type: OracleType,
    pub resolved_value: ResolvedValue,
    pub resolved_at: i64,
    pub dispute_deadline: i64,
}

/// Emitted by settle_*_callback for each completed Arcium shard.
///
/// For YesNo + MultiOutcome:
///   winner_mask is [u8; 8] — 1=winner, 0=loser, 0=unused slot.
///   Serialized as 8 bytes.
///
/// For Accuracy:
///   winner_mask is actually the error bytes — [u64; 4] serialized as
///   32 bytes little-endian (8 bytes per u64).
///   Backend decodes using: for i in 0..4 { u64::from_le_bytes(bytes[i*8..i*8+8]) }
///   Reusing winner_mask field avoids needing a separate event type.
///
/// Backend uses shard_index + shard order from DB to map mask[i] → Position PDA.
#[event]
pub struct ShardSettled {
    pub registry: Pubkey,
    pub pool: Pubkey,
    pub market: Pubkey,
    pub group: Pubkey,
    pub shard_index: u32,
    pub settled_shards: u32,
    pub total_shards: u32,
    pub winner_mask: Vec<u8>, // [u8; 8] for YesNo/Multi  |  [u64; 4] as bytes for Accuracy
    pub settled_at: i64,
}

/// Emitted when settled_shards == total_shards in settle_*_callback.
/// Backend payout_writer listens for this event to trigger write_position_payout.
#[event]
pub struct RegistryFinalized {
    pub registry: Pubkey,
    pub pool: Pubkey,
    pub market: Pubkey,
    pub group: Pubkey,
    pub total_shards: u32,
    pub finalized_at: i64,
}

/// Emitted by write_position_payout for each position.
#[event]
pub struct PayoutWritten {
    pub position: Pubkey,
    pub user: Pubkey,
    pub pool: Pubkey,
    pub payout: u64,
    pub written_at: i64,
}

/// Emitted when user calls claim_payout. USDC transferred to user.
#[event]
pub struct PayoutClaimed {
    pub position: Pubkey,
    pub user: Pubkey,
    pub pool: Pubkey,
    pub market: Pubkey,
    pub group: Pubkey,
    pub payout: u64,
    pub claimed_at: i64,
}

#[event]
pub struct BondReturned {
    pub bond: Pubkey,
    pub group: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
    pub returned_at: i64,
}

#[event]
pub struct BondSlashed {
    pub bond: Pubkey,
    pub group: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
    pub slashed_at: i64,
}

// ─── ERRORS ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum CypherError {
    // market state
    #[msg("Market is not in Open status")]
    MarketNotOpen,
    #[msg("Market is not in Locked status")]
    MarketNotLocked,
    #[msg("Market is not in Resolving status")]
    MarketNotResolving,
    #[msg("Market is not in Settling status")]
    MarketNotSettling,
    #[msg("Market is not in Settled status")]
    MarketNotSettled,
    #[msg("Market has already been resolved")]
    AlreadyResolved,
    #[msg("Lock timestamp has not been reached yet")]
    LockTimestampNotReached,
    #[msg("Resolve deadline has not passed yet")]
    ResolveDeadlineNotPassed,
    #[msg("Dispute window has not ended yet")]
    DisputeWindowActive,
    #[msg("Market has participants — cannot cancel")]
    MarketHasParticipants,

    // oracle
    #[msg("Signer is not the oracle authority for this market")]
    UnauthorizedOracle,
    #[msg("Resolved value type does not match market type")]
    InvalidResolvedValueType,
    #[msg("Outcome index out of range (max 3)")]
    OutcomeIndexOutOfRange,
    #[msg("Oracle type does not support automated resolution for this category")]
    OracleTypeNotSupported,

    // betting
    #[msg("Protocol is paused")]
    ProtocolPaused,
    #[msg("Stake amount is below minimum")]
    StakeTooLow,
    #[msg("User has already placed a bet in this pool")]
    AlreadyBet,
    #[msg("Pool is not accepting bets")]
    PoolNotOpen,
    #[msg("Encrypted payload is empty")]
    EmptyEncryptedPayload,
    #[msg("Encrypted payload exceeds max size of 128 bytes")]
    PayloadTooLarge,

    // settlement
    #[msg("Shard index out of range")]
    ShardIndexOutOfRange,
    #[msg("This shard has already been settled")]
    ShardAlreadySettled,
    #[msg("All shards are already settled")]
    AllShardsSettled,
    #[msg("Registry is not in Finalizing status")]
    RegistryNotFinalizing,
    #[msg("Arcium ZK proof verification failed")]
    InvalidZkProof,
    #[msg("Winner count is zero — no valid predictions matched")]
    ZeroWinners,

    // payout
    #[msg("Position is not in Settled status")]
    PositionNotSettled,
    #[msg("Position payout has already been written")]
    PayoutAlreadyWritten,
    #[msg("Position payout is zero — nothing to claim")]
    ZeroPayout,
    #[msg("Signer is not the position owner")]
    UnauthorizedClaim,
    #[msg("Payout amount exceeds pool balance")]
    InsufficientVaultBalance,

    // bond
    #[msg("Bond is not in Locked status")]
    BondNotLocked,
    #[msg("Signer is not the bond creator")]
    UnauthorizedBondReturn,

    // admin
    #[msg("Signer is not the protocol authority")]
    UnauthorizedAuthority,
    #[msg("Fee basis points exceed maximum (10000)")]
    FeeTooHigh,
    #[msg("Token mint does not match the accepted USDC mint")]
    InvalidMint,

    // math / overflow
    #[msg("Arithmetic overflow in payout calculation")]
    MathOverflow,
    #[msg("Division by zero in payout calculation")]
    DivisionByZero,
}

// ─── IMPL BLOCKS ──────────────────────────────────────────────────────────────

impl MarketGroup {
    pub fn is_yesno(&self) -> bool {
        self.market_type == MarketType::YesNo
    }

    pub fn is_multioutcome(&self) -> bool {
        self.market_type == MarketType::MultiOutcome
    }

    pub fn is_accuracy(&self) -> bool {
        self.market_type == MarketType::Accuracy
    }

    pub fn is_open(&self) -> bool {
        self.status == GroupStatus::Open
    }

    pub fn is_locked(&self) -> bool {
        self.status == GroupStatus::Locked
    }

    pub fn is_resolving(&self) -> bool {
        self.status == GroupStatus::Resolving
    }

    pub fn dispute_window_ended(&self, now: i64) -> bool {
        match self.dispute_deadline {
            Some(deadline) => now > deadline,
            None => false,
        }
    }
}

impl Pool {
    /// Returns ceil(participant_count / shard_size).
    /// YesNo/Multi: shard_size = 8 (circuit array [u8; 8])
    /// Accuracy:    shard_size = 4 (circuit array [u64; 4])
    pub fn total_shards(&self, shard_size: u32) -> u32 {
        if self.participant_count == 0 {
            return 0;
        }
        ((self.participant_count as u32) + shard_size - 1) / shard_size
    }
}

impl SettlementRegistry {
    pub fn is_all_shards_done(&self) -> bool {
        self.total_shards > 0 && self.settled_shards >= self.total_shards
    }
}

impl Position {
    pub fn is_claimable(&self) -> bool {
        self.status == PositionStatus::Settled && self.payout > 0
    }
}

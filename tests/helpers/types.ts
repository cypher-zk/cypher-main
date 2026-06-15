// Shared test constants, sourced from programs/cypher_main/src/states.rs.

export const USDC_DECIMALS = 6;
export const ONE_USDC = 1_000_000;
export const TEN_USDC = 10_000_000;
export const HUNDRED_USDC = 100_000_000;

// MIN_BET_USDC from states.rs
export const MIN_BET_USDC = 1_000_000;
// CREATOR_BOND from states.rs
export const CREATOR_BOND = 10_000_000;

// Fee rates (basis points). Defaults used by tests when calling initialize.
export const PROTOCOL_FEE_BPS = 50; // 0.5%
export const LP_FEE_BPS = 150; // 1.5%

// Convenience funding budget used to mint into creator/treasury accounts during setup.
export const SUITE_BUDGET = 500_000_000;

//! Pool math in u128 with explicit rounding: deposits round against the depositor,
//! withdrawals and swap outputs round down, so the pool never loses value to rounding.

use crate::AmmError;
use anchor_lang::prelude::*;

/// LP permanently locked by the first deposit. It is never minted; every share
/// computation counts it as part of the supply, which blocks the first-depositor
/// share-inflation attack.
pub const MIN_LIQUIDITY: u64 = 1_000;
pub const BPS: u128 = 10_000;

#[derive(Debug, PartialEq, Eq)]
pub struct DepositQuote {
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp: u64,
}

pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

fn to_u64(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| error!(AmmError::Overflow))
}

fn ceil_div(a: u128, b: u128) -> u128 {
    a.div_ceil(b)
}

/// LP supply as seen by share math: minted supply plus the locked minimum.
pub fn total_lp(minted: u64) -> u128 {
    minted as u128 + MIN_LIQUIDITY as u128
}

pub fn deposit(reserve_a: u64, reserve_b: u64, minted_lp: u64, max_a: u64, max_b: u64) -> Result<DepositQuote> {
    require!(max_a > 0 && max_b > 0, AmmError::ZeroAmount);
    if minted_lp == 0 {
        let root = isqrt(max_a as u128 * max_b as u128);
        require!(root > MIN_LIQUIDITY as u128, AmmError::InsufficientInitialLiquidity);
        return Ok(DepositQuote { amount_a: max_a, amount_b: max_b, lp: to_u64(root - MIN_LIQUIDITY as u128)? });
    }
    require!(reserve_a > 0 && reserve_b > 0, AmmError::EmptyPool);
    let total = total_lp(minted_lp);
    let (ra, rb) = (reserve_a as u128, reserve_b as u128);
    let lp = (max_a as u128 * total / ra).min(max_b as u128 * total / rb);
    require!(lp > 0, AmmError::ZeroAmount);
    let amount_a = ceil_div(lp * ra, total);
    let amount_b = ceil_div(lp * rb, total);
    require!(amount_a <= max_a as u128 && amount_b <= max_b as u128, AmmError::Slippage);
    Ok(DepositQuote { amount_a: to_u64(amount_a)?, amount_b: to_u64(amount_b)?, lp: to_u64(lp)? })
}

pub fn withdraw(reserve_a: u64, reserve_b: u64, minted_lp: u64, lp: u64) -> Result<(u64, u64)> {
    require!(lp > 0, AmmError::ZeroAmount);
    require!(lp <= minted_lp, AmmError::Overflow);
    let total = total_lp(minted_lp);
    let out_a = lp as u128 * reserve_a as u128 / total;
    let out_b = lp as u128 * reserve_b as u128 / total;
    Ok((to_u64(out_a)?, to_u64(out_b)?))
}

pub fn swap_out(amount_in: u64, reserve_in: u64, reserve_out: u64, fee_bps: u16) -> Result<u64> {
    require!(amount_in > 0, AmmError::ZeroAmount);
    require!(reserve_in > 0 && reserve_out > 0, AmmError::EmptyPool);
    let in_after_fee = amount_in as u128 * (BPS - fee_bps as u128);
    let out = in_after_fee * reserve_out as u128 / (reserve_in as u128 * BPS + in_after_fee);
    require!(out > 0, AmmError::ZeroAmount);
    to_u64(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqrt_is_exact_floor() {
        for n in [0u128, 1, 2, 3, 4, 15, 16, 17, 1 << 64, u64::MAX as u128 * u64::MAX as u128] {
            let r = isqrt(n);
            let next = (r + 1).checked_mul(r + 1);
            assert!(r * r <= n && next.map_or(true, |sq| sq > n), "n={n}");
        }
    }

    #[test]
    fn first_deposit_locks_minimum() {
        let q = deposit(0, 0, 0, 1_000_000, 4_000_000).unwrap();
        assert_eq!(q.lp, 2_000_000 - MIN_LIQUIDITY);
        assert!(deposit(0, 0, 0, 10, 10).is_err());
    }

    #[test]
    fn proportional_deposit_rounds_against_depositor() {
        let first = deposit(0, 0, 0, 1_000_000, 2_000_000).unwrap();
        let q = deposit(1_000_000, 2_000_000, first.lp, 333, 10_000).unwrap();
        // Pays at least its share of each reserve for the LP it gets.
        let total = total_lp(first.lp);
        assert!(q.amount_a as u128 * total >= q.lp as u128 * 1_000_000);
        assert!(q.amount_b as u128 * total >= q.lp as u128 * 2_000_000);
        assert!(q.amount_a <= 333);
    }

    #[test]
    fn deposit_then_withdraw_never_profits() {
        let first = deposit(0, 0, 0, 5_000_000, 7_000_000).unwrap();
        let (ra, rb, minted) = (5_000_000u64, 7_000_000u64, first.lp);
        let q = deposit(ra, rb, minted, 123_457, 999_999).unwrap();
        let (oa, ob) = withdraw(ra + q.amount_a, rb + q.amount_b, minted + q.lp, q.lp).unwrap();
        assert!(oa <= q.amount_a && ob <= q.amount_b);
    }

    #[test]
    fn swap_keeps_k_and_charges_fee() {
        let (ri, ro) = (1_000_000_000u64, 2_000_000_000u64);
        let out = swap_out(10_000_000, ri, ro, 30).unwrap();
        let k0 = ri as u128 * ro as u128;
        let k1 = (ri + 10_000_000) as u128 * (ro - out) as u128;
        assert!(k1 >= k0);
        let no_fee = swap_out(10_000_000, ri, ro, 0).unwrap();
        assert!(out < no_fee);
    }

    #[test]
    fn swap_rejects_empty_and_dust() {
        assert!(swap_out(1, 0, 100, 30).is_err());
        assert!(swap_out(1, 1_000_000, 1_000, 30).is_err());
    }

    #[test]
    fn withdraw_all_minted_leaves_locked_share() {
        let first = deposit(0, 0, 0, 1_000_000, 1_000_000).unwrap();
        let (oa, ob) = withdraw(1_000_000, 1_000_000, first.lp, first.lp).unwrap();
        assert!(oa < 1_000_000 && ob < 1_000_000);
        assert_eq!(1_000_000 - oa, 1_000);
    }
}

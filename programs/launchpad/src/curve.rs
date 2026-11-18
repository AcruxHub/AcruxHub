//! Constant-product bonding curve over virtual reserves: k = virtual_quote * virtual_tokens.
//! Every division that decides what leaves the curve rounds in the curve's favour, so
//! the curve can never pay out more than it holds.

use crate::LaunchError;
use anchor_lang::prelude::*;

pub const BPS: u128 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CurveState {
    pub virtual_quote: u64,
    pub virtual_tokens: u64,
    /// Quote actually held by the curve (net of fees).
    pub real_quote: u64,
    /// Tokens still sellable through the curve.
    pub real_tokens: u64,
    pub graduation_quote: u64,
    pub fee_bps: u16,
}

#[derive(Debug, PartialEq, Eq)]
pub struct BuyQuote {
    pub quote_to_curve: u64,
    pub fee: u64,
    pub tokens_out: u64,
    pub next: CurveState,
}

#[derive(Debug, PartialEq, Eq)]
pub struct SellQuote {
    pub quote_to_user: u64,
    pub fee: u64,
    pub next: CurveState,
}

fn to_u64(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| error!(LaunchError::Overflow))
}

fn fee_on(net: u64, fee_bps: u16) -> u64 {
    (net as u128 * fee_bps as u128).div_ceil(BPS) as u64
}

/// Spends at most `quote_in` including the fee. Clipped so real_quote never exceeds the threshold.
pub fn buy(s: &CurveState, quote_in: u64) -> Result<BuyQuote> {
    require!(quote_in > 0, LaunchError::ZeroAmount);
    let need = s.graduation_quote.saturating_sub(s.real_quote);
    require!(need > 0, LaunchError::Complete);
    let mut net = to_u64(quote_in as u128 * BPS / (BPS + s.fee_bps as u128))?;
    if net > need {
        net = need;
    }
    let mut fee = fee_on(net, s.fee_bps);
    // Rounding can push net + fee one unit over the budget; trim net until it fits.
    while net > 0 && net + fee > quote_in {
        net -= 1;
        fee = fee_on(net, s.fee_bps);
    }
    require!(net > 0, LaunchError::ZeroAmount);

    let k = s.virtual_quote as u128 * s.virtual_tokens as u128;
    let new_vq = s.virtual_quote as u128 + net as u128;
    let new_vt = k.div_ceil(new_vq);
    let tokens_out = to_u64(s.virtual_tokens as u128 - new_vt)?;
    require!(tokens_out <= s.real_tokens, LaunchError::Overflow);

    Ok(BuyQuote {
        quote_to_curve: net,
        fee,
        tokens_out,
        next: CurveState {
            virtual_quote: to_u64(new_vq)?,
            virtual_tokens: to_u64(new_vt)?,
            real_quote: s.real_quote + net,
            real_tokens: s.real_tokens - tokens_out,
            ..*s
        },
    })
}

pub fn sell(s: &CurveState, tokens_in: u64) -> Result<SellQuote> {
    require!(tokens_in > 0, LaunchError::ZeroAmount);
    let k = s.virtual_quote as u128 * s.virtual_tokens as u128;
    let new_vt = s.virtual_tokens as u128 + tokens_in as u128;
    let new_vq = k.div_ceil(new_vt);
    let gross = to_u64(s.virtual_quote as u128 - new_vq)?;
    require!(gross <= s.real_quote, LaunchError::Overflow);
    let fee = fee_on(gross, s.fee_bps).min(gross);
    Ok(SellQuote {
        quote_to_user: gross - fee,
        fee,
        next: CurveState {
            virtual_quote: to_u64(new_vq)?,
            virtual_tokens: to_u64(new_vt)?,
            real_quote: s.real_quote - gross,
            real_tokens: s.real_tokens + tokens_in,
            ..*s
        },
    })
}

/// Tokens that pair with `quote` at the curve's current price, so the pool opens
/// at exactly the price the last buyer paid.
pub fn tokens_for_pool(s: &CurveState, quote: u64) -> Result<u64> {
    to_u64(quote as u128 * s.virtual_tokens as u128 / s.virtual_quote as u128)
}

/// The curve must reach the threshold before selling out, and the tokens left over
/// must cover the pool at the final price.
pub fn check_params(virtual_quote: u64, virtual_tokens: u64, curve_supply: u64, total_supply: u64, graduation_quote: u64) -> Result<()> {
    let k = virtual_quote as u128 * virtual_tokens as u128;
    let final_vq = virtual_quote as u128 + graduation_quote as u128;
    let final_vt = k.div_ceil(final_vq);
    let sold = virtual_tokens as u128 - final_vt;
    require!(sold <= curve_supply as u128, LaunchError::BadConfig);
    let pool_tokens = graduation_quote as u128 * final_vt / final_vq;
    require!(pool_tokens <= total_supply as u128 - sold, LaunchError::BadConfig);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Testnet defaults: 1B supply (6 dp), 800M on the curve, 30 ACRUX virtual, graduate at 20 ACRUX.
    const TOTAL: u64 = 1_000_000_000_000_000;
    const CURVE: u64 = 800_000_000_000_000;
    const VQ: u64 = 30_000_000_000;
    const VT: u64 = 1_073_000_000_000_000;
    const GRAD: u64 = 20_000_000_000;

    fn fresh() -> CurveState {
        CurveState { virtual_quote: VQ, virtual_tokens: VT, real_quote: 0, real_tokens: CURVE, graduation_quote: GRAD, fee_bps: 100 }
    }

    #[test]
    fn defaults_are_valid() {
        check_params(VQ, VT, CURVE, TOTAL, GRAD).unwrap();
        assert!(check_params(VQ, VT, 1, TOTAL, GRAD).is_err());
    }

    #[test]
    fn buy_charges_fee_within_budget() {
        let q = buy(&fresh(), 1_000_000_000).unwrap();
        assert!(q.quote_to_curve + q.fee <= 1_000_000_000);
        assert_eq!(q.fee, (q.quote_to_curve as u128 * 100).div_ceil(10_000) as u64);
        assert!(q.tokens_out > 0);
        assert!(q.next.virtual_quote as u128 * q.next.virtual_tokens as u128 >= VQ as u128 * VT as u128);
    }

    #[test]
    fn buy_then_sell_loses_money() {
        let b = buy(&fresh(), 5_000_000_000).unwrap();
        let s = sell(&b.next, b.tokens_out).unwrap();
        assert!(s.quote_to_user < b.quote_to_curve + b.fee);
        assert!(s.next.real_quote <= b.next.real_quote);
    }

    #[test]
    fn last_buy_is_clipped_at_threshold() {
        let q = buy(&fresh(), 1_000_000_000_000).unwrap();
        assert_eq!(q.next.real_quote, GRAD);
        assert!(q.quote_to_curve + q.fee <= 1_000_000_000_000);
        assert!(buy(&q.next, 1_000).is_err());
    }

    #[test]
    fn graduation_pool_fits_leftover() {
        let q = buy(&fresh(), 1_000_000_000_000).unwrap();
        let held = TOTAL - (CURVE - q.next.real_tokens);
        let pool = tokens_for_pool(&q.next, q.next.real_quote).unwrap();
        assert!(pool <= held);
    }

    #[test]
    fn many_small_trades_never_drain() {
        let mut s = fresh();
        let mut held_quote: u64 = 0;
        let mut tokens: Vec<u64> = vec![];
        for i in 0..200u64 {
            let b = buy(&s, 10_000_000 + i * 7_919).unwrap();
            held_quote += b.quote_to_curve;
            tokens.push(b.tokens_out);
            s = b.next;
        }
        for t in tokens {
            let q = sell(&s, t).unwrap();
            held_quote -= q.quote_to_user + q.fee;
            s = q.next;
        }
        assert_eq!(held_quote, s.real_quote);
        assert_eq!(s.real_tokens, CURVE);
    }
}

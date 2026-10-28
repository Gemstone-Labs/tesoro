//! Mainnet SOL Positions on a real staking token (ADR 0011, on the computed model of ADR 0010).
//!
//! A Position holds `shares` of the staking token (pool tokens of an SPL stake pool) in a shared
//! per-token vault. Its **Principal** is recorded in lamports at the pool's Staking Rate when it
//! opened (`rate_open`), and its **growth since open** is `Staking Rate now / rate_open`, the same
//! `Accrued Yield = Principal x (growth - 1)` as every network (`yield_math`). Every amount the
//! ledger owes is in lamports; only a payout converts to tokens, at the rate of that moment, so
//! nothing is minted, cranked or recorded per Position.
//!
//! Treasury. The Yield Fee is taken when yield leaves (ticket 31, `ledger::yield_fee`): its
//! shares stay in the vault as the route's `treasury_shares`.

use super::*;

/// Staking Rate fixed point: lamports per pool token, 1e12. Finer than the 1e9 of sim_lst so the
/// ratio `now / open` carries no visible rounding on a Position of any size.
pub const STAKE_RATE_SCALE: u128 = 1_000_000_000_000;
/// Slots in a mainnet epoch.
pub const EPOCH_SLOTS: u128 = 432_000;
/// Slot time the epoch length assumes, ms. Mainnet averages 400 to 430 ms; assuming a little more
/// lengthens the epoch, so the annualised growth errs low rather than high.
pub const ASSUMED_SLOT_MILLIS: u128 = 450;
/// Assumed epoch length, seconds.
pub const EPOCH_SECS: u128 = EPOCH_SLOTS * ASSUMED_SLOT_MILLIS / 1_000;
/// How many epochs behind the clock the pool may be: the update of the current epoch may not have
/// landed yet, the one before must have.
pub const MAX_STALE_EPOCHS: u64 = 1;
/// The most the admin can set the Advance APY ceiling to, basis points.
pub const MAX_APY_CEILING_BPS: u16 = 2_000;

/// SOL base units per pool token at 1e12, rounded down: the pool's `total_lamports /
/// pool_token_supply`. A pool with no tokens or no lamports has no rate.
pub fn staking_rate(total_lamports: u64, pool_token_supply: u64) -> CoreResult<u64> {
    if pool_token_supply == 0 || total_lamports == 0 {
        return Err(CoreError::BadStakePool);
    }
    let rate = to_u64(mul_div_floor(
        total_lamports as u128,
        STAKE_RATE_SCALE,
        pool_token_supply as u128,
    )?)?;
    if rate == 0 {
        return Err(CoreError::BadStakePool);
    }
    Ok(rate)
}

impl StakePoolRead {
    /// The pool's Staking Rate now.
    pub fn rate(&self) -> CoreResult<u64> {
        staking_rate(self.total_lamports, self.pool_token_supply)
    }

    /// Refuses a pool whose last update is more than [`MAX_STALE_EPOCHS`] behind `epoch`.
    pub fn require_fresh(&self, epoch: u64) -> CoreResult<()> {
        if epoch.saturating_sub(self.last_update_epoch) > MAX_STALE_EPOCHS {
            return Err(CoreError::StaleStakePool);
        }
        Ok(())
    }

    /// The annual growth rate, in basis points, to size an Advance on: the growth of the pool's
    /// last epoch (current totals against the totals one update earlier) scaled to a year, capped
    /// at `ceiling_bps`. Zero when the pool has no previous epoch or shows no growth.
    pub fn sizing_apy_bps(&self, ceiling_bps: u16) -> CoreResult<u16> {
        if self.last_epoch_total_lamports == 0 || self.last_epoch_pool_token_supply == 0 {
            return Ok(0);
        }
        let now = staking_rate(self.total_lamports, self.pool_token_supply)? as u128;
        let before = staking_rate(
            self.last_epoch_total_lamports,
            self.last_epoch_pool_token_supply,
        )? as u128;
        if now <= before {
            return Ok(0);
        }
        let annual = mul_div_floor(
            (now - before)
                .checked_mul(BPS)
                .and_then(|x| x.checked_mul(YEAR_SECS))
                .ok_or(CoreError::Math)?,
            1,
            before.checked_mul(EPOCH_SECS).ok_or(CoreError::Math)?,
        )?;
        Ok(annual.min(ceiling_bps as u128) as u16)
    }
}

/// Growth since open: the exact ratio `rate_now / rate_open`.
pub fn stake_growth(rate_open: u64, rate_now: u64) -> CoreResult<Growth> {
    if rate_open == 0 || rate_now == 0 {
        return Err(CoreError::Math);
    }
    Ok(Growth {
        num: rate_now as u128,
        den: rate_open as u128,
    })
}

/// Accrued Yield of a stake Position now, gross (the Yield Fee is taken at cash-out).
pub fn stake_position_accrued(position: &Position, rate_now: u64) -> CoreResult<u64> {
    let growth = stake_growth(position.stake_rate_open, rate_now)?;
    accrued_yield_at(position.principal, growth)
}

/// The highest Staking Rate a stake Position's yield was priced at: `stake_rate_high`, never
/// below the opening rate (a migrated Position starts at it).
pub fn stake_rate_peak(position: &Position) -> u64 {
    position.stake_rate_high.max(position.stake_rate_open)
}

/// Counted Yield of a stake Position (ticket 55): the Accrued Yield at the higher of the rate now
/// and the highest rate its yield was priced at. A fall never un-counts yield that landed, so a
/// checkpoint moved after a fall cannot count the recovery again as new yield.
pub fn stake_position_counted(position: &Position, rate_now: u64) -> CoreResult<u64> {
    stake_position_accrued(position, rate_now.max(stake_rate_peak(position)))
}

/// Pool tokens worth `units` lamports at `rate`, rounded down (what a payout sends).
pub fn tokens_for_units(units: u64, rate: u64) -> CoreResult<u64> {
    if rate == 0 {
        return Err(CoreError::Math);
    }
    to_u64(mul_div_floor(
        units as u128,
        STAKE_RATE_SCALE,
        rate as u128,
    )?)
}

/// Pool tokens worth `units` lamports at `rate`, rounded up (what a reserve must keep).
pub fn tokens_for_units_ceil(units: u128, rate: u64) -> CoreResult<u128> {
    if rate == 0 {
        return Err(CoreError::Math);
    }
    mul_div_ceil(units, STAKE_RATE_SCALE, rate as u128)
}

/// Lamports `tokens` are worth at `rate`, rounded down.
pub fn units_for_tokens(tokens: u64, rate: u64) -> CoreResult<u64> {
    to_u64(mul_div_floor(
        tokens as u128,
        rate as u128,
        STAKE_RATE_SCALE,
    )?)
}

/// Principal, in lamports, of `shares` at `rate`.
pub fn principal_for_shares(shares: u64, rate: u64) -> CoreResult<u64> {
    units_for_tokens(shares, rate)
}

/// What an Unlock pays: the Position's Principal plus its free yield, in tokens at `rate_now`,
/// never more than the shares it holds (a pool that lost value leaves the Player the shares, not
/// their old Principal).
pub fn unlock_tokens(
    principal: u64,
    free_units: u64,
    shares: u64,
    rate_now: u64,
) -> CoreResult<u64> {
    let owed = principal.checked_add(free_units).ok_or(CoreError::Math)?;
    Ok(tokens_for_units(owed, rate_now)?.min(shares))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 1_000_000_000;
    /// A rate of 1.30 lamports per token.
    const R0: u64 = 1_300_000_000_000;

    fn read(total: u64, supply: u64, epoch: u64, lt: u64, ls: u64) -> StakePoolRead {
        StakePoolRead {
            pool_mint: [1; 32],
            total_lamports: total,
            pool_token_supply: supply,
            last_update_epoch: epoch,
            last_epoch_total_lamports: lt,
            last_epoch_pool_token_supply: ls,
        }
    }

    #[test]
    fn the_rate_is_lamports_per_pool_token_and_needs_both_sides() {
        assert_eq!(staking_rate(1_300_000_000, 1_000_000_000), Ok(R0));
        assert_eq!(staking_rate(5, 3), Ok(1_666_666_666_666));
        assert_eq!(staking_rate(5, 0), Err(CoreError::BadStakePool));
        assert_eq!(staking_rate(0, 5), Err(CoreError::BadStakePool));
    }

    #[test]
    fn a_pool_must_have_updated_this_epoch_or_the_one_before() {
        let p = read(1, 1, 100, 0, 0);
        assert_eq!(p.require_fresh(100), Ok(()));
        assert_eq!(p.require_fresh(101), Ok(()));
        assert_eq!(p.require_fresh(102), Err(CoreError::StaleStakePool));
        assert_eq!(p.require_fresh(50), Ok(()));
    }

    #[test]
    fn growth_is_the_rate_ratio_and_yield_follows_the_one_formula() {
        let g = stake_growth(R0, R0 + R0 / 100).unwrap();
        let mut p = Position::new([1; 32], SourceChain::Solana, [9; 32], 9, 10 * SOL, 0).unwrap();
        p.stake_rate_open = R0;
        let a = stake_position_accrued(&p, R0 + R0 / 100).unwrap();
        // 10 SOL grew 1%: 0.1 SOL, all of it counted (the fee waits for the cash-out).
        assert_eq!(a, 100_000_000);
        assert_eq!(accrued_yield_at(10 * SOL, g).unwrap(), a);
        // A pool that lost value yields nothing.
        assert_eq!(stake_position_accrued(&p, R0 - 1).unwrap(), 0);
        assert_eq!(stake_growth(0, R0), Err(CoreError::Math));
    }

    #[test]
    fn sizing_is_one_epoch_of_growth_scaled_to_a_year_and_capped() {
        // 0.04% in an epoch of 194,400 s: 0.0004 * 31,536,000 / 194,400 = 6.49%.
        let p = read(
            1_000_400_000,
            1_000_000_000,
            5,
            1_000_000_000,
            1_000_000_000,
        );
        assert_eq!(p.sizing_apy_bps(2_000), Ok(648));
        assert_eq!(p.sizing_apy_bps(500), Ok(500));
        // No previous epoch, no growth, falling rate: zero.
        assert_eq!(read(1_000, 1_000, 5, 0, 0).sizing_apy_bps(2_000), Ok(0));
        assert_eq!(
            read(1_000, 1_000, 5, 1_000, 1_000).sizing_apy_bps(2_000),
            Ok(0)
        );
        assert_eq!(
            read(999, 1_000, 5, 1_000, 1_000).sizing_apy_bps(2_000),
            Ok(0)
        );
    }

    #[test]
    fn the_live_jitosol_pool_sizes_below_a_generous_ceiling() {
        let bytes = include_bytes!("../../tests/fixtures/jito_pool.bin");
        let pool = parse_stake_pool(bytes).unwrap();
        let apy = pool.sizing_apy_bps(2_000).unwrap();
        assert!(
            apy > 0 && apy < 600,
            "one epoch of jitoSOL growth gave {apy} bps"
        );
        assert!(pool.rate().unwrap() > 1_300_000_000_000);
    }

    #[test]
    fn payouts_convert_at_the_rate_of_the_moment_and_round_down() {
        assert_eq!(tokens_for_units(1_300_000_000, R0), Ok(1_000_000_000));
        assert_eq!(tokens_for_units(1, R0), Ok(0));
        assert_eq!(units_for_tokens(1_000_000_000, R0), Ok(1_300_000_000));
        assert_eq!(tokens_for_units_ceil(1, R0), Ok(1));
    }

    #[test]
    fn unlock_pays_principal_and_free_yield_but_never_more_than_the_shares() {
        let shares = 10 * SOL;
        let principal = units_for_tokens(shares, R0).unwrap();
        // Rate up 10%: the principal needs fewer tokens.
        let r1 = R0 + R0 / 10;
        let t = unlock_tokens(principal, 0, shares, r1).unwrap();
        assert_eq!(t, tokens_for_units(principal, r1).unwrap());
        assert!(t < shares);
        // With the whole gross yield free the tokens add up to the shares (less the rounding).
        let net = stake_position_accrued(
            &Position {
                stake_rate_open: R0,
                ..Position::new([1; 32], SourceChain::Solana, [9; 32], 9, principal, 0).unwrap()
            },
            r1,
        )
        .unwrap();
        let all = unlock_tokens(principal, net, shares, r1).unwrap();
        assert!(shares - all <= 2);
        // Rate fell: the Position gets its shares, not its old Principal.
        assert_eq!(
            unlock_tokens(principal, 0, shares, R0 - R0 / 10),
            Ok(shares)
        );
    }
}

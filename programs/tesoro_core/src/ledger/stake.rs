//! Mainnet SOL Positions on a real staking token (ADR 0011, on the computed model of ADR 0010).
//!
//! A Position holds `shares` of the staking token (pool tokens of an SPL stake pool) in a shared
//! per-token vault. Its **Principal** is recorded in lamports at the pool's Staking Rate when it
//! opened (`rate_open`), and its **growth since open** is `Staking Rate now / rate_open`, the same
//! `Accrued Yield = Principal x (growth - 1)` as every network (`yield_math`). Every amount the
//! ledger owes is in lamports; only a payout converts to tokens, at the rate of that moment, so
//! nothing is minted, cranked or recorded per Position.
//!
//! Treasury. The Yield Fee is a running claim in tokens, kept in the vault: for the Locked
//! Positions `i` with shares `S_i`, Principal `P_i` and fee `f_i` the fee value is
//! `f_i * (S_i * r / SCALE - P_i)`, so the claim in tokens is `(sum f_i S_i - sum f_i P_i * SCALE / r)
//! / BPS`, computed from two sums that change only when a Position opens or unlocks.

use super::*;
use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

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

/// Net Accrued Yield of a stake Position now.
pub fn stake_position_accrued(position: &Position, rate_now: u64) -> CoreResult<AccruedYield> {
    let growth = stake_growth(position.stake_rate_open, rate_now)?;
    accrued_yield_at(position.principal, growth, position.yield_fee_bps)
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

/// Pool-wide totals behind the Treasury's Yield Fee claim in tokens. Change only on open and unlock.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct StakeTotals {
    /// `sum Principal` of Locked Positions, lamports.
    pub principal: u128,
    /// `sum shares * fee_bps` of Locked Positions.
    pub fee_shares: u128,
    /// `sum Principal * fee_bps` of Locked Positions.
    pub fee_principal: u128,
    /// Yield Fees of Positions already unlocked, tokens.
    pub realised_fee_shares: u128,
    /// Locked Positions in the totals; sizes the rounding allowance.
    pub open_positions: u64,
}

/// Rounding allowance per open Position, tokens: each Position floors its gross yield, its fee and
/// the token conversion, and the pooled value uses the unrounded share count.
const ALLOWANCE_PER_POSITION: u128 = 3;

impl StakeTotals {
    pub fn add_position(&mut self, shares: u64, principal: u64, fee_bps: u16) -> CoreResult<()> {
        if fee_bps > MAX_YIELD_FEE_BPS {
            return Err(CoreError::InvalidBps);
        }
        let next = Self {
            principal: self
                .principal
                .checked_add(principal as u128)
                .ok_or(CoreError::Math)?,
            fee_shares: self
                .fee_shares
                .checked_add(shares as u128 * fee_bps as u128)
                .ok_or(CoreError::Math)?,
            fee_principal: self
                .fee_principal
                .checked_add(principal as u128 * fee_bps as u128)
                .ok_or(CoreError::Math)?,
            open_positions: self.open_positions.checked_add(1).ok_or(CoreError::Math)?,
            ..*self
        };
        *self = next;
        Ok(())
    }

    /// Removes a Position (same arguments as [`StakeTotals::add_position`]) and books its fee, in
    /// tokens, into the realised total.
    pub fn remove_position(
        &mut self,
        shares: u64,
        principal: u64,
        fee_bps: u16,
        fee_tokens: u64,
    ) -> CoreResult<()> {
        let next = Self {
            principal: self
                .principal
                .checked_sub(principal as u128)
                .ok_or(CoreError::Math)?,
            fee_shares: self
                .fee_shares
                .checked_sub(shares as u128 * fee_bps as u128)
                .ok_or(CoreError::Math)?,
            fee_principal: self
                .fee_principal
                .checked_sub(principal as u128 * fee_bps as u128)
                .ok_or(CoreError::Math)?,
            realised_fee_shares: self
                .realised_fee_shares
                .checked_add(fee_tokens as u128)
                .ok_or(CoreError::Math)?,
            open_positions: self.open_positions.checked_sub(1).ok_or(CoreError::Math)?,
        };
        *self = next;
        Ok(())
    }

    /// Yield Fee earned by the Treasury at `rate_now`, in tokens: the pooled claim of the Locked
    /// Positions less a rounding allowance, plus the realised total. Conservative: never more than
    /// the sum of the per-Position fees (a Position under water counts against it, never for it).
    pub fn earned_fee_shares(&self, rate_now: u64) -> CoreResult<u64> {
        let reserve = tokens_for_units_ceil(self.fee_principal, rate_now)?;
        let live = self
            .fee_shares
            .saturating_sub(reserve)
            .checked_div(BPS)
            .ok_or(CoreError::Math)?
            .saturating_sub(ALLOWANCE_PER_POSITION * self.open_positions as u128);
        to_u64(
            live.checked_add(self.realised_fee_shares)
                .ok_or(CoreError::Math)?,
        )
    }

    /// Tokens the vault must keep to return every Locked Position's Principal at `rate_now`.
    pub fn principal_reserve(&self, rate_now: u64) -> CoreResult<u64> {
        to_u64(tokens_for_units_ceil(self.principal, rate_now)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const SOL: u64 = 1_000_000_000;
    const FEE: u16 = 2_000;
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
        p.yield_fee_bps = FEE;
        let a = stake_position_accrued(&p, R0 + R0 / 100).unwrap();
        // 10 SOL grew 1%: 0.1 SOL gross, 20% fee.
        assert_eq!(a.gross, 100_000_000);
        assert_eq!(a.fee, 20_000_000);
        assert_eq!(a.net, 80_000_000);
        assert_eq!(accrued_yield_at(10 * SOL, g, FEE).unwrap(), a);
        // A pool that lost value yields nothing.
        assert_eq!(
            stake_position_accrued(&p, R0 - 1).unwrap(),
            AccruedYield::default()
        );
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
                yield_fee_bps: 0,
                ..Position::new([1; 32], SourceChain::Solana, [9; 32], 9, principal, 0).unwrap()
            },
            r1,
        )
        .unwrap()
        .net;
        let all = unlock_tokens(principal, net, shares, r1).unwrap();
        assert!(shares - all <= 2);
        // Rate fell: the Position gets its shares, not its old Principal.
        assert_eq!(
            unlock_tokens(principal, 0, shares, R0 - R0 / 10),
            Ok(shares)
        );
    }

    #[test]
    fn the_treasury_claim_is_the_fee_on_every_positions_growth() {
        let mut t = StakeTotals::default();
        let shares_a = 10 * SOL;
        let shares_b = 4 * SOL;
        let (pa, pb) = (
            principal_for_shares(shares_a, R0).unwrap(),
            principal_for_shares(shares_b, R0).unwrap(),
        );
        t.add_position(shares_a, pa, FEE).unwrap();
        t.add_position(shares_b, pb, FEE).unwrap();
        assert_eq!(t.earned_fee_shares(R0), Ok(0));
        let r1 = R0 + R0 / 20; // +5%
        let sum: u64 = [(pa, shares_a), (pb, shares_b)]
            .iter()
            .map(|(p, _)| {
                let g = accrued_yield_at(*p, stake_growth(R0, r1).unwrap(), FEE).unwrap();
                tokens_for_units(g.fee, r1).unwrap()
            })
            .sum();
        let pooled = t.earned_fee_shares(r1).unwrap();
        assert!(pooled <= sum, "pooled {pooled} > per-Position sum {sum}");
        assert!(sum - pooled <= 8, "pooled {pooled} far below sum {sum}");
        // Unlocking one moves its fee into the realised total.
        let fee_a = accrued_yield_at(pa, stake_growth(R0, r1).unwrap(), FEE)
            .unwrap()
            .fee;
        let fee_tokens = tokens_for_units(fee_a, r1).unwrap();
        t.remove_position(shares_a, pa, FEE, fee_tokens).unwrap();
        assert_eq!(t.open_positions, 1);
        assert!(t.earned_fee_shares(r1).unwrap() + 8 >= pooled);
        assert!(t.earned_fee_shares(r1).unwrap() <= sum);
        // Removing what was never added fails and changes nothing.
        let before = t;
        assert_eq!(
            t.remove_position(shares_a, pa, FEE, 0),
            Err(CoreError::Math)
        );
        assert_eq!(t, before);
    }

    #[test]
    fn the_principal_reserve_rounds_up_and_falls_as_the_rate_rises() {
        let mut t = StakeTotals::default();
        t.add_position(10 * SOL, principal_for_shares(10 * SOL, R0).unwrap(), FEE)
            .unwrap();
        assert_eq!(t.principal_reserve(R0), Ok(10 * SOL));
        assert!(t.principal_reserve(R0 + R0 / 10).unwrap() < 10 * SOL);
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 400, ..ProptestConfig::default() })]

        /// The pooled claim never exceeds the sum of per-Position fees (in tokens) and stays within
        /// a few tokens per Position of it, for Positions opened at different rates.
        #[test]
        fn pooled_claim_is_conservative_and_tight(
            opens in proptest::collection::vec((1_000_000u64..5_000_000_000_000, 1_000_000_000_000u64..2_000_000_000_000, 0u16..=5_000), 1..12),
            rise_bps in 0u64..5_000,
        ) {
            let mut t = StakeTotals::default();
            let mut positions = vec![];
            let mut r_max = 0;
            for (shares, rate, fee) in &opens {
                let p = principal_for_shares(*shares, *rate).unwrap();
                if p == 0 { continue; }
                t.add_position(*shares, p, *fee).unwrap();
                positions.push((*shares, p, *rate, *fee));
                r_max = r_max.max(*rate);
            }
            prop_assume!(!positions.is_empty());
            let r1 = r_max + (r_max as u128 * rise_bps as u128 / 10_000) as u64;
            let sum: u128 = positions.iter().map(|(_, p, r0, fee)| {
                let g = accrued_yield_at(*p, stake_growth(*r0, r1).unwrap(), *fee).unwrap();
                tokens_for_units(g.fee, r1).unwrap() as u128
            }).sum();
            let pooled = t.earned_fee_shares(r1).unwrap() as u128;
            prop_assert!(pooled <= sum, "pooled {pooled} > sum {sum}");
            prop_assert!(sum - pooled <= 8 * positions.len() as u128, "pooled {pooled} sum {sum}");
        }
    }
}

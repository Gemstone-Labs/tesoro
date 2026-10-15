//! Custody arithmetic for Solana-native Positions: the vault holds simSOL shares, the SOL value of
//! a share is the sim_lst rate (`RATE_SCALE` fixed point), and everything is stated in SOL base
//! units so it can be compared with `Position.principal` and Source yield units.
//!
//! Let `V` be the vault's shares, `r` the current rate, `P` the Position's Principal in SOL units,
//! `paid` the SOL units already paid to redeemers, and `O` the applied-but-unpaid yield owed to
//! Gema holders (`cumulative_yield - free_yield - paid`). Then:
//!
//! * accrued yield (cumulative, SOL) `= floor(V * r / S) + paid - P`. Shares paid out stop earning
//!   for the Position, which is why it is derived from the shares still in the vault and not from
//!   the shares deposited at open; it never decreases while the rate does not.
//! * the vault must always hold `ceil((P + O) * S / r)` shares while Locked: Principal plus the
//!   yield owed to holders. After Unlock only `O` is reserved and the rest returns to the owner.

use super::*;

/// sim_lst `RATE_SCALE`: SOL per share, 1e9 fixed point.
pub const RATE_SCALE: u128 = 1_000_000_000;

/// SOL base units worth `shares` at `rate`, rounded down.
pub fn shares_value(shares: u64, rate: u64) -> CoreResult<u64> {
    to_u64(mul_div_floor(shares as u128, rate as u128, RATE_SCALE)?)
}

/// Shares worth `units` SOL base units at `rate`, rounded down (what a payout hands out).
pub fn shares_for_units_floor(units: u64, rate: u64) -> CoreResult<u64> {
    if rate == 0 {
        return Err(CoreError::Math);
    }
    to_u64(mul_div_floor(units as u128, RATE_SCALE, rate as u128)?)
}

/// Shares worth `units` SOL base units at `rate`, rounded up (what a reserve must hold).
pub fn shares_for_units_ceil(units: u64, rate: u64) -> CoreResult<u64> {
    to_u64(mul_div_ceil(units as u128, RATE_SCALE, rate as u128)?)
}

/// Cumulative yield in SOL units from the vault's current shares. Never below zero.
pub fn accrued_yield(
    vault_shares: u64,
    rate: u64,
    redeemed_units: u64,
    principal: u64,
) -> CoreResult<u64> {
    let value = shares_value(vault_shares, rate)?;
    let total = value.checked_add(redeemed_units).ok_or(CoreError::Math)?;
    Ok(total.saturating_sub(principal))
}

/// Yield applied to Sources and not yet paid out to redeemers, SOL units.
pub fn owed_units(position: &Position, redeemed_units: u64) -> CoreResult<u64> {
    position
        .cumulative_yield
        .checked_sub(position.free_yield)
        .and_then(|applied| applied.checked_sub(redeemed_units))
        .ok_or(CoreError::Math)
}

/// Shares the vault must hold: Principal (while Locked) plus the yield owed to holders.
pub fn required_shares(position: &Position, redeemed_units: u64, rate: u64) -> CoreResult<u64> {
    let owed = owed_units(position, redeemed_units)?;
    let units = match position.status {
        PositionStatus::Locked => owed
            .checked_add(position.principal)
            .ok_or(CoreError::Math)?,
        PositionStatus::Unlocked => owed,
    };
    shares_for_units_ceil(units, rate)
}

/// Shares that may leave the vault for the owner: everything beyond what is still required.
/// Only defined once the Position is Unlocked.
pub fn surplus_shares(
    vault_shares: u64,
    position: &Position,
    redeemed_units: u64,
    rate: u64,
) -> CoreResult<u64> {
    if position.status != PositionStatus::Unlocked {
        return Err(CoreError::PositionLocked);
    }
    let required = required_shares(position, redeemed_units, rate)?;
    vault_shares
        .checked_sub(required)
        .ok_or(CoreError::VaultShortfall)
}

/// The invariant every custody instruction ends with.
pub fn check_cover(
    vault_shares: u64,
    position: &Position,
    redeemed_units: u64,
    rate: u64,
) -> CoreResult<()> {
    if vault_shares < required_shares(position, redeemed_units, rate)? {
        return Err(CoreError::VaultShortfall);
    }
    Ok(())
}

// --- Real staking tokens (SPL stake pool) ----------------------------------------------------

/// The `StakePool` account type byte of the SPL stake pool program.
pub const STAKE_POOL_ACCOUNT_TYPE: u8 = 1;
/// Byte offsets in a `StakePool` account (borsh layout, no discriminator): the type byte, five
/// keys and a bump byte come before `pool_mint`; `total_lamports` and `pool_token_supply` follow
/// the manager fee account and the token program id.
const POOL_MINT_OFFSET: usize = 1 + 32 * 3 + 1 + 32 * 2;
const TOTAL_LAMPORTS_OFFSET: usize = POOL_MINT_OFFSET + 32 * 3;
const POOL_SUPPLY_OFFSET: usize = TOTAL_LAMPORTS_OFFSET + 8;
const STAKE_POOL_MIN_LEN: usize = POOL_SUPPLY_OFFSET + 8;

/// What a Position needs from a stake pool account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StakePoolRead {
    pub pool_mint: Key,
    pub total_lamports: u64,
    pub pool_token_supply: u64,
}

/// Reads the pool mint, the lamports under management and the pool token supply out of the data of
/// an initialised `StakePool` account.
pub fn parse_stake_pool(data: &[u8]) -> CoreResult<StakePoolRead> {
    if data.len() < STAKE_POOL_MIN_LEN || data[0] != STAKE_POOL_ACCOUNT_TYPE {
        return Err(CoreError::BadStakePool);
    }
    let key = |at: usize| -> Key { data[at..at + 32].try_into().expect("32 bytes") };
    let word = |at: usize| u64::from_le_bytes(data[at..at + 8].try_into().expect("8 bytes"));
    Ok(StakePoolRead {
        pool_mint: key(POOL_MINT_OFFSET),
        total_lamports: word(TOTAL_LAMPORTS_OFFSET),
        pool_token_supply: word(POOL_SUPPLY_OFFSET),
    })
}

/// SOL base units per pool token, 1e9 fixed point (`RATE_SCALE`), rounded down: the pool's
/// exchange rate `total_lamports / pool_token_supply`. A pool with no tokens or no lamports has no
/// rate.
pub fn stake_pool_rate(total_lamports: u64, pool_token_supply: u64) -> CoreResult<u64> {
    if pool_token_supply == 0 || total_lamports == 0 {
        return Err(CoreError::BadStakePool);
    }
    let rate = to_u64(mul_div_floor(
        total_lamports as u128,
        RATE_SCALE,
        pool_token_supply as u128,
    )?)?;
    if rate == 0 {
        return Err(CoreError::BadStakePool);
    }
    Ok(rate)
}

/// Pool tokens the Treasury takes as Yield Fee from the rate's growth since the fee was last
/// settled: `fee_bps` of what `tracked_shares` gained between `last_rate` and `rate`, in tokens at
/// `rate`. Nothing is due while the rate sits at or below its previous high.
pub fn yield_fee_shares(
    tracked_shares: u64,
    last_rate: u64,
    rate: u64,
    fee_bps: u16,
) -> CoreResult<u64> {
    if rate <= last_rate {
        return Ok(0);
    }
    let growth = to_u64(mul_div_floor(
        tracked_shares as u128,
        (rate - last_rate) as u128,
        RATE_SCALE,
    )?)?;
    let (_, fee_units) = super::split_yield_fee(growth, fee_bps)?;
    Ok(shares_for_units_floor(fee_units, rate)?.min(tracked_shares))
}

#[cfg(test)]
mod stake_pool_tests {
    use super::*;

    /// A `StakePool` account's bytes with the fields the program reads set.
    pub fn pool_bytes(mint: Key, total: u64, supply: u64) -> Vec<u8> {
        let mut data = vec![0u8; 400];
        data[0] = STAKE_POOL_ACCOUNT_TYPE;
        data[POOL_MINT_OFFSET..POOL_MINT_OFFSET + 32].copy_from_slice(&mint);
        data[TOTAL_LAMPORTS_OFFSET..TOTAL_LAMPORTS_OFFSET + 8]
            .copy_from_slice(&total.to_le_bytes());
        data[POOL_SUPPLY_OFFSET..POOL_SUPPLY_OFFSET + 8].copy_from_slice(&supply.to_le_bytes());
        data
    }

    #[test]
    fn the_layout_offsets_match_the_spl_stake_pool_account() {
        // type(1) manager staker deposit_authority(3x32) bump(1) validator_list reserve(2x32)
        // pool_mint(32) manager_fee token_program(2x32) total_lamports(8) supply(8).
        assert_eq!(POOL_MINT_OFFSET, 162);
        assert_eq!(TOTAL_LAMPORTS_OFFSET, 258);
        assert_eq!(POOL_SUPPLY_OFFSET, 266);
    }

    #[test]
    fn a_stake_pool_account_is_read_for_its_mint_and_balances() {
        let read = parse_stake_pool(&pool_bytes([7; 32], 1_300, 1_000)).unwrap();
        assert_eq!(
            read,
            StakePoolRead {
                pool_mint: [7; 32],
                total_lamports: 1_300,
                pool_token_supply: 1_000
            }
        );
    }

    #[test]
    fn data_that_is_not_an_initialised_stake_pool_is_refused() {
        let mut data = pool_bytes([7; 32], 1, 1);
        data[0] = 2; // a validator list
        assert_eq!(parse_stake_pool(&data), Err(CoreError::BadStakePool));
        data[0] = 0;
        assert_eq!(parse_stake_pool(&data), Err(CoreError::BadStakePool));
        assert_eq!(parse_stake_pool(&data[..200]), Err(CoreError::BadStakePool));
    }

    #[test]
    fn the_rate_is_lamports_per_pool_token_and_needs_both_sides() {
        assert_eq!(
            stake_pool_rate(1_300_000_000, 1_000_000_000),
            Ok(1_300_000_000)
        );
        assert_eq!(stake_pool_rate(5, 3), Ok(1_666_666_666));
        assert_eq!(stake_pool_rate(5, 0), Err(CoreError::BadStakePool));
        assert_eq!(stake_pool_rate(0, 5), Err(CoreError::BadStakePool));
    }

    #[test]
    fn the_yield_fee_is_a_share_of_the_rate_growth_taken_in_tokens() {
        // 100 tokens, rate 1.00 -> 1.10: growth 10 SOL, 20% fee = 2 SOL = 2 / 1.1 tokens.
        let fee =
            yield_fee_shares(100 * RATE_SCALE as u64, 1_000_000_000, 1_100_000_000, 2_000).unwrap();
        assert_eq!(fee, 1_818_181_818);
        // No fee while the rate is flat or below its high-water mark.
        assert_eq!(
            yield_fee_shares(100, 1_100_000_000, 1_100_000_000, 2_000),
            Ok(0)
        );
        assert_eq!(
            yield_fee_shares(100, 1_100_000_000, 1_000_000_000, 2_000),
            Ok(0)
        );
        // Fee zero means nothing is taken.
        assert_eq!(yield_fee_shares(100, 1, 2_000_000_000, 0), Ok(0));
        assert_eq!(
            yield_fee_shares(100, 1, 2, 5_001),
            Err(CoreError::InvalidBps)
        );
    }

    #[test]
    fn what_the_fee_leaves_is_the_position_share_of_the_growth() {
        let (tracked, last, now) = (10 * RATE_SCALE as u64, 1_200_000_000u64, 1_260_000_000u64);
        let fee = yield_fee_shares(tracked, last, now, 2_000).unwrap();
        let before = shares_value(tracked, last).unwrap();
        let after = shares_value(tracked - fee, now).unwrap();
        // 80% of the 0.6 SOL growth, give or take one unit of rounding.
        let gain = after - before;
        assert!(gain.abs_diff(480_000_000) <= 2, "gain {gain}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const OWNER: Key = [1; 32];

    /// One native Position: vault, Source and holder Gemas, with the custody instructions as ops.
    struct Model {
        position: Position,
        source: Option<Source>,
        held: u64,
        vault: u64,
        released: u64,
        principal_shares: u64,
        redeemed_units: u64,
        rate: u64,
        rate_open: u64,
        paid_out_shares: u64,
    }

    impl Model {
        fn new(shares: u64, rate_open: u64, apy_bps: u16) -> Option<Self> {
            let principal = shares_value(shares, rate_open).ok()?;
            let position =
                Position::new(OWNER, SourceChain::Solana, [7; 32], 9, principal, apy_bps).ok()?;
            Some(Self {
                position,
                source: None,
                held: 0,
                vault: shares,
                released: 0,
                principal_shares: shares,
                redeemed_units: 0,
                rate: rate_open,
                rate_open,
                paid_out_shares: 0,
            })
        }

        fn advance(&mut self, months: u8, price: u64) {
            if let Ok(src) = self.position.open_advance([9; 32], months, price, 0) {
                // Gemas of earlier Sources stay owed (reserved) but the model redeems only the latest.
                self.held = src.issued;
                self.source = Some(src);
            }
        }

        /// `accrue_native_yield`. Returns whether anything changed.
        fn crank(&mut self) -> bool {
            let cum = accrued_yield(
                self.vault,
                self.rate,
                self.redeemed_units,
                self.position.principal,
            )
            .unwrap();
            if cum <= self.position.cumulative_yield {
                return false;
            }
            let seq = self.position.last_seq + 1;
            let open = self.position.open_advance.is_some();
            let src = if open { self.source.as_mut() } else { None };
            let applied = self.position.apply_yield(src, seq, cum).unwrap();
            assert!(applied);
            true
        }

        fn redeem(&mut self, pct: u64) {
            let Some(src) = self.source.as_mut() else {
                return;
            };
            let mut account = Account::default();
            let mut holding = Holding::new([9; 32], true);
            holding.credit(&mut account, self.held).unwrap();
            let want = (src.redeemable_for(self.held) as u128 * pct as u128 / 100) as u64;
            if want == 0 {
                return;
            }
            let mut trial = src.clone();
            let Ok(units) = redeem(&mut trial, &mut account, &mut holding, want) else {
                return;
            };
            let Ok(shares) = shares_for_units_floor(units, self.rate) else {
                return;
            };
            if shares == 0 || shares > self.vault {
                return;
            }
            let redeemed = self.redeemed_units + units;
            let after = self.vault - shares;
            assert!(
                check_cover(after, &self.position, redeemed, self.rate).is_ok(),
                "payout would break cover"
            );
            *src = trial;
            self.held -= want;
            self.redeemed_units = redeemed;
            self.vault = after;
            self.paid_out_shares += shares;
        }

        fn unlock(&mut self) {
            if self.position.unlock().is_ok() {
                self.release();
            }
        }

        fn release(&mut self) {
            let surplus =
                surplus_shares(self.vault, &self.position, self.redeemed_units, self.rate).unwrap();
            self.vault -= surplus;
            self.released += surplus;
        }

        fn check(&self) {
            // Vault always covers Principal (while Locked) and the unpaid redeemable yield.
            check_cover(self.vault, &self.position, self.redeemed_units, self.rate).unwrap();
            // Payouts never exceed accrued yield.
            assert!(self.redeemed_units <= self.position.cumulative_yield);
            if self.position.status == PositionStatus::Locked {
                // Principal shares only leave through Unlock.
                assert_eq!(self.released, 0, "principal left before unlock");
                assert!(shares_value(self.vault, self.rate).unwrap() >= self.position.principal);
            }
            // Conservation of shares.
            assert_eq!(
                self.vault + self.paid_out_shares + self.released,
                self.principal_shares
            );
            assert!(self.rate >= self.rate_open);
        }
    }

    #[derive(Clone, Debug)]
    enum Op {
        Time(u64),
        Advance(u8, u64),
        Crank,
        Redeem(u64),
        ReturnOwn(u64),
        Unlock,
    }

    fn op() -> impl Strategy<Value = Op> {
        prop_oneof![
            4 => (1u64..40_000_000).prop_map(Op::Time),
            2 => (1u8..=12, 1_000_000u64..500_000_000).prop_map(|(m, p)| Op::Advance(m, p)),
            4 => Just(Op::Crank),
            4 => (1u64..=100).prop_map(Op::Redeem),
            1 => (1u64..=100).prop_map(Op::ReturnOwn),
            1 => Just(Op::Unlock),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 400, ..ProptestConfig::default() })]

        #[test]
        fn vault_always_covers_principal_and_owed_yield(
            shares in 1_000_000u64..1_000_000_000_000,
            rate_open in 1_000_000_000u64..1_500_000_000,
            apy in 100u16..3_000,
            ops in proptest::collection::vec(op(), 1..60),
        ) {
            let Some(mut m) = Model::new(shares, rate_open, apy) else { return Ok(()); };
            m.advance(6, 150_000_000);
            m.check();
            for op in ops {
                let cum_before = m.position.cumulative_yield;
                match op {
                    Op::Time(dr) => m.rate = m.rate.saturating_add(dr),
                    Op::Advance(months, price) => m.advance(months, price),
                    Op::Crank => {
                        m.crank();
                        // Idempotent: cranking again at the same rate changes nothing.
                        let snapshot = (m.position.clone(), m.source.clone());
                        prop_assert!(!m.crank());
                        prop_assert_eq!(snapshot, (m.position.clone(), m.source.clone()));
                    }
                    Op::Redeem(pct) => m.redeem(pct),
                    Op::ReturnOwn(pct) => {
                        if let Some(src) = m.source.as_mut() {
                            let mut account = Account::default();
                            let mut holding = Holding::new([9; 32], true);
                            holding.credit(&mut account, m.held).unwrap();
                            let amt = (src.debt() as u128 * pct as u128 / 100) as u64;
                            if amt > 0
                                && amt <= m.held
                                && return_own(&mut m.position, src, &mut account, &mut holding, amt).is_ok()
                            {
                                m.held -= amt;
                            }
                        }
                    }
                    Op::Unlock => m.unlock(),
                }
                // Cumulative yield is monotonic.
                prop_assert!(m.position.cumulative_yield >= cum_before);
                m.check();
            }
            // Sweeping after unlock keeps every owed unit in the vault, before and after a rate rise.
            if m.position.status == PositionStatus::Unlocked {
                m.release();
                m.check();
                m.rate = m.rate.saturating_add(50_000_000);
                m.release();
                m.check();
            }
        }
    }

    #[test]
    fn worked_example() {
        // 100 shares at rate 1.0 => Principal 100 SOL; 10% APY over 6 months projects 5 SOL.
        let mut m = Model::new(100_000_000_000, RATE_SCALE as u64, 1_000).unwrap();
        m.advance(6, 150_000_000);
        m.rate = 1_050_000_000;
        assert!(m.crank());
        assert_eq!(m.position.cumulative_yield, 5_000_000_000);
        assert_eq!(m.source.as_ref().unwrap().debt(), 0);
        assert!(m.position.open_advance.is_none());
        m.redeem(100);
        m.unlock();
        m.check();
        assert_eq!(m.redeemed_units, 5_000_000_000);
    }
}

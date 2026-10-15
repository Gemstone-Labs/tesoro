//! Native Positions without a crank (ADR 0010). A native Position's Debt, redeemable amount and
//! free yield are all derived from `yield_math` at the moment an instruction runs; the only stored
//! facts are the Position's `opened_at`, `principal`, `rate_bps` and a yield checkpoint
//! (`applied_net`), plus each Source's own counts.
//!
//! Checkpoint rule. `applied_net` is the net Accrued Yield already settled: consumed by Sources
//! that closed, or banked into `free_yield`. The open Advance counts only `net - applied_net`
//! (capped by what it still owes), so yield that accrued before an Advance opened never repays it.
//! A Source closes when Debt is zero and an instruction that needs the Position idle observes it
//! (the next Advance, Unlock, or a `return_own` that clears Debt): the Source keeps its final
//! `yield_units`, the surplus is banked as free yield and the checkpoint moves to `net`.
//!
//! Custody. simSOL value is flat, so the shared vault holds only Principal. Yield is minted at
//! the moment it is paid out (Redeem, Unlock), never before.

use super::*;

/// sim_lst `RATE_SCALE`: SOL per share, 1e9 fixed point.
pub const RATE_SCALE: u128 = 1_000_000_000;

/// SOL base units worth `shares` at `rate`, rounded down.
pub fn shares_value(shares: u64, rate: u64) -> CoreResult<u64> {
    to_u64(mul_div_floor(shares as u128, rate as u128, RATE_SCALE)?)
}

/// Shares worth `units` SOL base units at `rate`, rounded down (what a yield payout mints).
pub fn shares_for_units_floor(units: u64, rate: u64) -> CoreResult<u64> {
    if rate == 0 {
        return Err(CoreError::Math);
    }
    to_u64(mul_div_floor(units as u128, RATE_SCALE, rate as u128)?)
}

/// Net Accrued Yield of a native Position at `now`, with the pool's `speedup` and the Treasury's
/// Yield Fee. The Position's own `rate_bps` and `opened_at` fix the rest.
pub fn position_accrued(
    position: &Position,
    speedup: u32,
    fee_bps: u16,
    now: i64,
) -> CoreResult<AccruedYield> {
    let growth = growth_since_open(position.rate_bps, position.opened_at, now, speedup)?;
    accrued_yield_at(position.principal, growth, fee_bps)
}

/// The Source as it stands at net Accrued Yield `net`: the open Advance gets its derived
/// `yield_units` (never below what is stored); a closed Source is as stored.
pub fn source_view(position: &Position, source: &Source, net: u64) -> CoreResult<Source> {
    if position.open_advance != Some(source.index) {
        return Ok(source.clone());
    }
    let mut view = source_now(source, net, position.applied_net)?.source;
    view.yield_units = view.yield_units.max(source.yield_units);
    Ok(view)
}

/// Closes the open Advance whose Debt is zero: writes its final `yield_units` into `source`,
/// banks the yield beyond it as free yield and moves the checkpoint to `net`.
pub fn close_open_advance(
    position: &mut Position,
    source: &mut Source,
    net: u64,
) -> CoreResult<()> {
    if position.open_advance != Some(source.index) {
        return Err(CoreError::SourceMismatch);
    }
    let view = source_view(position, source, net)?;
    if view.debt() != 0 {
        return Err(CoreError::DebtOutstanding);
    }
    let counted = net.saturating_sub(position.applied_net);
    let free = counted.saturating_sub(view.yield_units);
    position.free_yield = position
        .free_yield
        .checked_add(free)
        .ok_or(CoreError::Math)?;
    position.applied_net = position.applied_net.max(net);
    position.open_advance = None;
    *source = view;
    Ok(())
}

/// With no Advance open, everything accrued since the checkpoint is free yield: bank it.
pub fn bank_free_yield(position: &mut Position, net: u64) -> CoreResult<()> {
    if position.open_advance.is_some() {
        return Err(CoreError::AdvanceAlreadyOpen);
    }
    let delta = net.saturating_sub(position.applied_net);
    position.free_yield = position
        .free_yield
        .checked_add(delta)
        .ok_or(CoreError::Math)?;
    position.applied_net = position.applied_net.max(net);
    Ok(())
}

/// Readies the Position for a new Advance: closes the previous one (its Debt must be zero) or
/// banks the idle yield. `previous` is that Source when one is open.
pub fn prepare_advance(
    position: &mut Position,
    previous: Option<&mut Source>,
    net: u64,
) -> CoreResult<()> {
    let mut pos = position.clone();
    match (pos.open_advance, previous) {
        (Some(_), Some(src)) => {
            if source_view(&pos, src, net)?.debt() != 0 {
                return Err(CoreError::AdvanceAlreadyOpen);
            }
            let mut closed = src.clone();
            close_open_advance(&mut pos, &mut closed, net)?;
            *src = closed;
        }
        (Some(_), None) => return Err(CoreError::SourceMismatch),
        (None, _) => bank_free_yield(&mut pos, net)?,
    }
    *position = pos;
    Ok(())
}

/// Unlocks a native Position: closes its Advance (Debt must be zero) or banks the idle yield,
/// marks it Unlocked and returns the free yield to pay out now.
pub fn unlock_native(
    position: &mut Position,
    open: Option<&mut Source>,
    net: u64,
) -> CoreResult<u64> {
    if position.status != PositionStatus::Locked {
        return Err(CoreError::PositionNotLocked);
    }
    let mut pos = position.clone();
    match (pos.open_advance, open) {
        (Some(_), Some(src)) => {
            let mut closed = src.clone();
            close_open_advance(&mut pos, &mut closed, net)?;
            *src = closed;
        }
        (Some(_), None) => return Err(CoreError::SourceMismatch),
        (None, _) => bank_free_yield(&mut pos, net)?,
    }
    pos.unlock()?;
    let payable = pos
        .free_yield
        .checked_sub(pos.free_yield_claimed)
        .ok_or(CoreError::Math)?;
    pos.free_yield_claimed = pos.free_yield;
    *position = pos;
    Ok(payable)
}

/// `return_own` for a native Position: the Source is first brought to its derived state; when the
/// return clears Debt the Advance closes as in [`close_open_advance`].
pub fn return_own_native(
    position: &mut Position,
    source: &mut Source,
    account: &mut Account,
    holding: &mut Holding,
    amount: u64,
    net: u64,
) -> CoreResult<()> {
    let mut view = source_view(position, source, net)?;
    let mut scratch = position.clone();
    let (mut acct, mut hold) = (account.clone(), holding.clone());
    return_own(&mut scratch, &mut view, &mut acct, &mut hold, amount)?;
    let mut pos = position.clone();
    if view.debt() == 0 && pos.open_advance == Some(view.index) {
        close_open_advance(&mut pos, &mut view, net)?;
    }
    *position = pos;
    *source = view;
    *account = acct;
    *holding = hold;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const OWNER: Key = [1; 32];
    const SOL: u64 = 1_000_000_000;
    const T0: i64 = 1_800_000_000;
    const FEE: u16 = 2_000;

    struct Model {
        position: Position,
        sources: Vec<Source>,
        held: Vec<u64>,
        now: i64,
        free_paid: u64,
        redeemed: u64,
    }

    impl Model {
        fn new(principal: u64, apy: u16) -> Option<Self> {
            let mut position =
                Position::new(OWNER, SourceChain::Solana, [7; 32], 9, principal, apy).ok()?;
            position.opened_at = T0;
            Some(Self {
                position,
                sources: vec![],
                held: vec![],
                now: T0,
                free_paid: 0,
                redeemed: 0,
            })
        }

        fn net(&self) -> u64 {
            position_accrued(&self.position, 4_380, FEE, self.now)
                .unwrap()
                .net
        }

        fn view(&self, i: usize) -> Source {
            source_view(&self.position, &self.sources[i], self.net()).unwrap()
        }

        fn advance(&mut self, months: u8) {
            let net = self.net();
            let n = self.sources.len();
            let idx = self.position.open_advance;
            let mut prev = idx.map(|i| self.sources[i as usize].clone());
            if prepare_advance(&mut self.position, prev.as_mut(), net).is_err() {
                return;
            }
            if let (Some(i), Some(p)) = (idx, prev) {
                self.sources[i as usize] = p;
            }
            if let Ok(src) = self
                .position
                .open_advance([9; 32], months, 150_000_000, FEE)
            {
                self.held.push(src.issued);
                self.sources.push(src);
                assert_eq!(self.sources.len(), n + 1);
            }
        }

        fn redeem(&mut self, i: usize, pct: u64) {
            if i >= self.sources.len() {
                return;
            }
            let mut src = self.view(i);
            let mut account = Account::default();
            let mut holding = Holding::new([9; 32], true);
            holding.credit(&mut account, self.held[i]).unwrap();
            let want = (src.redeemable_for(self.held[i]) as u128 * pct as u128 / 100) as u64;
            if want == 0 {
                return;
            }
            let Ok(units) = redeem(&mut src, &mut account, &mut holding, want) else {
                return;
            };
            self.sources[i] = src;
            self.held[i] -= want;
            self.redeemed += units;
        }

        fn unlock(&mut self) {
            let net = self.net();
            let idx = self.position.open_advance;
            let mut open = idx.map(|i| self.sources[i as usize].clone());
            if let Ok(free) = unlock_native(&mut self.position, open.as_mut(), net) {
                if let (Some(i), Some(s)) = (idx, open) {
                    self.sources[i as usize] = s;
                }
                self.free_paid += free;
            }
        }

        /// What was minted can never exceed the net Accrued Yield, and every closed Source is
        /// fully covered.
        fn check(&self) {
            let net = self.net();
            let consumed: u64 = (0..self.sources.len())
                .map(|i| self.view(i).yield_units)
                .sum();
            assert!(
                consumed + self.position.free_yield <= net.max(self.position.applied_net) + 1,
                "settled yield exceeds accrued: {} + {} > {}",
                consumed,
                self.position.free_yield,
                net
            );
            assert!(self.redeemed + self.free_paid <= net + 1);
            for (i, s) in self.sources.iter().enumerate() {
                if self.position.open_advance != Some(s.index) {
                    assert_eq!(s.debt(), 0, "closed source {i} has debt");
                }
            }
        }
    }

    #[derive(Clone, Debug)]
    enum Op {
        Time(i64),
        Advance(u8),
        Redeem(usize, u64),
        Return(u64),
        Unlock,
    }

    fn op() -> impl Strategy<Value = Op> {
        prop_oneof![
            5 => (1i64..2_000).prop_map(Op::Time),
            2 => (1u8..=12).prop_map(Op::Advance),
            4 => (0usize..4, 1u64..=100).prop_map(|(i, p)| Op::Redeem(i, p)),
            1 => (1u64..=100).prop_map(Op::Return),
            1 => Just(Op::Unlock),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 300, ..ProptestConfig::default() })]

        #[test]
        fn nothing_minted_beyond_accrued_yield(
            principal in 1_000_000u64..1_000_000_000_000,
            apy in 100u16..3_000,
            ops in proptest::collection::vec(op(), 1..50),
        ) {
            let Some(mut m) = Model::new(principal, apy) else { return Ok(()); };
            m.advance(6);
            for op in ops {
                match op {
                    Op::Time(dt) => m.now += dt,
                    Op::Advance(months) => m.advance(months),
                    Op::Redeem(i, pct) => m.redeem(i, pct),
                    Op::Return(pct) => {
                        if let Some(i) = m.position.open_advance {
                            let i = i as usize;
                            let net = m.net();
                            let view = m.view(i);
                            let amt = (view.debt() as u128 * pct as u128 / 100) as u64;
                            let mut account = Account::default();
                            let mut holding = Holding::new([9; 32], true);
                            holding.credit(&mut account, m.held[i]).unwrap();
                            let mut src = m.sources[i].clone();
                            if amt > 0
                                && amt <= m.held[i]
                                && return_own_native(&mut m.position, &mut src, &mut account, &mut holding, amt, net).is_ok()
                            {
                                m.sources[i] = src;
                                m.held[i] -= amt;
                            }
                        }
                    }
                    Op::Unlock => m.unlock(),
                }
                m.check();
                if m.position.status == PositionStatus::Unlocked {
                    break;
                }
            }
        }
    }

    #[test]
    fn debt_reaches_zero_at_the_horizon_with_no_crank() {
        let mut m = Model::new(10 * SOL, 495).unwrap();
        m.advance(6);
        // Six sim months = 3,600 s: debt is nonzero before, zero after.
        m.now = T0 + 3_000;
        assert!(m.view(0).debt() > 0);
        m.now = T0 + 3_600;
        assert_eq!(m.view(0).debt(), 0);
        // The Source is still "open" until something closes it, but a second Advance closes it.
        m.advance(3);
        assert_eq!(m.sources.len(), 2);
        assert_eq!(m.position.open_advance, Some(1));
        assert_eq!(m.sources[0].debt(), 0);
    }

    #[test]
    fn a_second_advance_does_not_count_yield_from_before_it_opened() {
        let mut m = Model::new(10 * SOL, 495).unwrap();
        m.advance(1);
        // Long after the first Advance is repaid, take the second.
        m.now = T0 + 6_000;
        let net_before = m.net();
        m.advance(6);
        assert_eq!(m.sources.len(), 2);
        assert_eq!(m.position.applied_net, net_before);
        // At the moment it opens the second Advance has no yield counted.
        assert_eq!(m.view(1).yield_units, 0);
        assert!(m.view(1).debt() > 0);
        // Yield accrued before it belongs to the owner as free yield.
        assert!(m.position.free_yield > m.sources[0].yield_units);
        m.now += 3_600;
        assert_eq!(m.view(1).debt(), 0);
    }

    #[test]
    fn unlock_pays_the_idle_yield_and_refuses_while_in_debt() {
        let mut m = Model::new(10 * SOL, 495).unwrap();
        m.advance(6);
        m.now = T0 + 1_000;
        let net = m.net();
        let mut open = m.sources[0].clone();
        assert_eq!(
            unlock_native(&mut m.position, Some(&mut open), net),
            Err(CoreError::DebtOutstanding)
        );
        assert_eq!(m.position.status, PositionStatus::Locked);
        m.now = T0 + 7_200;
        let net = m.net();
        let free = unlock_native(&mut m.position, Some(&mut open), net).unwrap();
        assert_eq!(open.yield_units + free, net);
        assert_eq!(m.position.status, PositionStatus::Unlocked);
        assert_eq!(
            unlock_native(&mut m.position, None, net),
            Err(CoreError::PositionNotLocked)
        );
    }

    #[test]
    fn a_closed_source_keeps_its_final_yield_for_late_redeems() {
        let mut m = Model::new(10 * SOL, 495).unwrap();
        m.advance(2);
        m.now = T0 + 5_000;
        m.unlock();
        assert_eq!(m.position.status, PositionStatus::Unlocked);
        m.now += 1_000_000;
        let v = m.view(0);
        assert_eq!(v.debt(), 0);
        assert_eq!(v.yield_units, m.sources[0].yield_units);
        m.redeem(0, 100);
        assert!(m.redeemed > 0);
        m.check();
    }
}

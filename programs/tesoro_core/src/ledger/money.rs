//! Position, Advance, Source, Debt, Gema holdings, Redeem (ADR 0001).
//!
//! Units. Gemas are whole numbers. A Source fixes its rate at issuance as
//! `unit_num / unit_den` source-asset base units per Gema, where `unit_num = 10^(decimals + 4)`
//! and `unit_den = price` (USD price of one whole asset in micro-USD): one Gema is $0.01 =
//! 10_000 micro-USD. After issuance the USD price is never consulted again.
//!
//! Source ledger (all in Gemas unless named `*_units`):
//! `issued`, `returned` (cancelled by the owner), `redeemed` (paid out), and `yield_units`
//! (accrued yield applied, in source-asset units). `covered = min(issued - returned,
//! floor(yield_units / rate))` is the part of the Source that accrued yield has repaid.
//! `debt = issued - returned - covered`; `outstanding = issued - returned - redeemed`
//! is what holders (and Pots) hold; `redeemable = covered - redeemed`.
//! Conservation: `held + escrowed == outstanding`, hence `outstanding + redeemed + returned == issued`.

use super::*;
use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum SourceChain {
    Solana,
    Ethereum,
    HyperEvm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum PositionStatus {
    Locked,
    Unlocked,
}

/// A staker's locked, yield-bearing stake. `principal` is recorded but no function of this core
/// ever reads it except to size a new Advance, and none lets it reduce Debt.
#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Position {
    /// Account identity that owns the Position.
    pub owner: Key,
    pub source_chain: SourceChain,
    pub source_asset: Key,
    pub decimals: u8,
    /// Principal in source-asset base units.
    pub principal: u64,
    /// Provider annual rate in basis points, fixed at open.
    pub rate_bps: u16,
    pub status: PositionStatus,
    /// Advances taken so far; also the index of the next Source.
    pub advances: u32,
    /// Index of the open Advance (the Source with Debt), if any.
    pub open_advance: Option<u32>,
    /// Highest cross-chain message sequence applied.
    pub last_seq: u64,
    /// Last cumulative accrued yield applied, source-asset units.
    pub cumulative_yield: u64,
    /// Yield accrued while no Advance had Debt to repay; belongs to the owner.
    pub free_yield: u64,
    pub free_yield_claimed: u64,
}

impl Position {
    pub fn new(
        owner: Key,
        source_chain: SourceChain,
        source_asset: Key,
        decimals: u8,
        principal: u64,
        rate_bps: u16,
    ) -> CoreResult<Self> {
        if decimals > 18 {
            return Err(CoreError::InvalidDecimals);
        }
        if principal == 0 {
            return Err(CoreError::ZeroAmount);
        }
        Ok(Self {
            owner,
            source_chain,
            source_asset,
            decimals,
            principal,
            rate_bps,
            status: PositionStatus::Locked,
            advances: 0,
            open_advance: None,
            last_seq: 0,
            cumulative_yield: 0,
            free_yield: 0,
            free_yield_claimed: 0,
        })
    }

    /// Takes an Advance: the projected yield over `horizon_months` net of the Yield Fee
    /// (`yield_fee_bps`), as Gemas at $0.01 with `price_micro_usd` (USD per whole asset, micro-USD)
    /// fixed for this Source. The Position earns its yield net of the same fee, so the Advance is
    /// repaid at the Horizon. The caller credits `source.issued` Gemas to the owner's Holding of the
    /// returned Source.
    pub fn open_advance(
        &mut self,
        position: Key,
        horizon_months: u8,
        price_micro_usd: u64,
        yield_fee_bps: u16,
    ) -> CoreResult<Source> {
        if self.status != PositionStatus::Locked {
            return Err(CoreError::PositionNotLocked);
        }
        if self.open_advance.is_some() {
            return Err(CoreError::AdvanceAlreadyOpen);
        }
        if !(MIN_HORIZON_MONTHS..=MAX_HORIZON_MONTHS).contains(&horizon_months) {
            return Err(CoreError::InvalidHorizon);
        }
        if price_micro_usd == 0 {
            return Err(CoreError::InvalidPrice);
        }
        if yield_fee_bps > MAX_YIELD_FEE_BPS {
            return Err(CoreError::InvalidBps);
        }
        let projected_units = mul_div_floor(
            (self.principal as u128)
                .checked_mul(self.rate_bps as u128)
                .and_then(|x| x.checked_mul(horizon_months as u128))
                .ok_or(CoreError::Math)?,
            BPS.checked_sub(yield_fee_bps as u128)
                .ok_or(CoreError::Math)?,
            BPS * BPS * 12,
        )?;
        let unit_num = 10u128
            .checked_pow(self.decimals as u32 + 4)
            .ok_or(CoreError::Math)?;
        let issued = to_u64(mul_div_floor(
            projected_units,
            price_micro_usd as u128,
            unit_num,
        )?)?;
        if issued == 0 {
            return Err(CoreError::AdvanceTooSmall);
        }
        let index = self.advances;
        let next = index.checked_add(1).ok_or(CoreError::Math)?;
        self.advances = next;
        self.open_advance = Some(index);
        Ok(Source {
            position,
            owner: self.owner,
            index,
            horizon_months,
            unit_num,
            unit_den: price_micro_usd,
            issued,
            returned: 0,
            redeemed: 0,
            yield_units: 0,
            redeemed_units: 0,
        })
    }

    /// Applies `YieldAccrued(seq, cumulative)`. Idempotent: `seq <= last_seq` is a no-op
    /// returning `Ok(false)`. Accrued yield first repays the open Advance's Debt; anything beyond
    /// goes to `free_yield`. `source` must be the open Advance's Source when one is open.
    pub fn apply_yield(
        &mut self,
        source: Option<&mut Source>,
        seq: u64,
        cumulative: u64,
    ) -> CoreResult<bool> {
        if seq <= self.last_seq {
            return Ok(false);
        }
        if cumulative < self.cumulative_yield {
            return Err(CoreError::CumulativeDecreased);
        }
        let delta = cumulative - self.cumulative_yield;
        match (self.open_advance, source) {
            (Some(index), Some(src)) => {
                if src.index != index || src.owner != self.owner {
                    return Err(CoreError::SourceMismatch);
                }
                let need = src.units_to_repay()?;
                let take = delta.min(need);
                let free = self
                    .free_yield
                    .checked_add(delta - take)
                    .ok_or(CoreError::Math)?;
                src.yield_units = src.yield_units.checked_add(take).ok_or(CoreError::Math)?;
                self.free_yield = free;
                if src.debt() == 0 {
                    self.open_advance = None;
                }
            }
            (Some(_), None) => return Err(CoreError::SourceMismatch),
            (None, _) => {
                self.free_yield = self.free_yield.checked_add(delta).ok_or(CoreError::Math)?;
            }
        }
        self.last_seq = seq;
        self.cumulative_yield = cumulative;
        Ok(true)
    }

    /// Owner claims yield accrued beyond any Advance (paid on the source chain by `PayYield`).
    pub fn claim_free_yield(&mut self, amount: u64) -> CoreResult<()> {
        if amount == 0 {
            return Err(CoreError::ZeroAmount);
        }
        let claimed = self
            .free_yield_claimed
            .checked_add(amount)
            .ok_or(CoreError::Math)?;
        if claimed > self.free_yield {
            return Err(CoreError::ExceedsRedeemable);
        }
        self.free_yield_claimed = claimed;
        Ok(())
    }

    /// Debt is zero and no Advance is open: Principal may be released (`Unlock` message).
    pub fn unlock(&mut self) -> CoreResult<()> {
        if self.status != PositionStatus::Locked {
            return Err(CoreError::PositionNotLocked);
        }
        if self.open_advance.is_some() {
            return Err(CoreError::DebtOutstanding);
        }
        self.status = PositionStatus::Unlocked;
        Ok(())
    }
}

/// The Advance a Gema was issued from.
#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Source {
    pub position: Key,
    /// Owner of the Position at issuance; Gemas of this Source are "own-sourced" for them.
    pub owner: Key,
    pub index: u32,
    pub horizon_months: u8,
    /// Source-asset base units per Gema is `unit_num / unit_den`.
    pub unit_num: u128,
    pub unit_den: u64,
    pub issued: u64,
    pub returned: u64,
    pub redeemed: u64,
    /// Accrued yield applied to this Source, source-asset units.
    pub yield_units: u64,
    /// Source-asset units already paid out by Redeem.
    pub redeemed_units: u64,
}

impl Source {
    /// Gemas not returned: the claim total on this Source.
    fn live(&self) -> u64 {
        self.issued.saturating_sub(self.returned)
    }

    /// Source-asset units of accrued yield needed to repay everything still live.
    fn units_to_repay_total(&self) -> CoreResult<u64> {
        to_u64(mul_div_ceil(
            self.live() as u128,
            self.unit_num,
            self.unit_den as u128,
        )?)
    }

    fn units_to_repay(&self) -> CoreResult<u64> {
        Ok(self
            .units_to_repay_total()?
            .saturating_sub(self.yield_units))
    }

    /// Gemas repaid by accrued yield.
    pub fn covered(&self) -> u64 {
        let by_yield = (self.yield_units as u128)
            .checked_mul(self.unit_den as u128)
            .and_then(|x| x.checked_div(self.unit_num))
            .unwrap_or(0);
        u64::try_from(by_yield).unwrap_or(u64::MAX).min(self.live())
    }

    /// Debt, in Gemas: outstanding Gemas not yet repaid by accrued yield.
    pub fn debt(&self) -> u64 {
        self.live().saturating_sub(self.covered())
    }

    /// Debt in source-asset units (rounded up).
    pub fn debt_units(&self) -> CoreResult<u64> {
        to_u64(mul_div_ceil(
            self.debt() as u128,
            self.unit_num,
            self.unit_den as u128,
        )?)
    }

    /// Gemas held by anyone or escrowed in Pots.
    pub fn outstanding(&self) -> u64 {
        self.live().saturating_sub(self.redeemed)
    }

    /// Repaid but not yet redeemed, in Gemas: pro rata redeemable by holders now.
    pub fn redeemable(&self) -> u64 {
        self.covered().saturating_sub(self.redeemed)
    }

    /// Accrued yield not yet paid out to redeemers, source-asset units ("pending").
    pub fn pending_units(&self) -> u64 {
        self.yield_units.saturating_sub(self.redeemed_units)
    }

    /// What a holder of `held` free Gemas of this Source may redeem now: their pro rata share.
    pub fn redeemable_for(&self, held: u64) -> u64 {
        let outstanding = self.outstanding();
        if outstanding == 0 {
            return 0;
        }
        let share = (held as u128)
            .checked_mul(self.redeemable() as u128)
            .and_then(|x| x.checked_div(outstanding as u128))
            .unwrap_or(0);
        u64::try_from(share).unwrap_or(0).min(held)
    }

    /// Source-asset units paid for `gemas` redeemed (rounded down).
    pub fn units_for(&self, gemas: u64) -> CoreResult<u64> {
        to_u64(mul_div_floor(
            gemas as u128,
            self.unit_num,
            self.unit_den as u128,
        )?)
    }
}

/// One Account's identity ledger. Balances mirror the sum of its Holdings, split by whether the
/// Gemas are own-sourced (Source owned by this Account) or won (any other Source).
#[derive(Clone, Debug, Default, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Account {
    pub own_total: u64,
    pub won_total: u64,
    /// Reserved for Offers (part of the totals, not free to enter Matches or redeem).
    pub own_reserved: u64,
    pub won_reserved: u64,
}

impl Account {
    pub fn own_free(&self) -> u64 {
        self.own_total.saturating_sub(self.own_reserved)
    }
    pub fn won_free(&self) -> u64 {
        self.won_total.saturating_sub(self.won_reserved)
    }
}

/// Gemas held by one Account of one Source.
#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Holding {
    pub source: Key,
    pub is_own: bool,
    pub amount: u64,
    pub reserved: u64,
}

impl Holding {
    pub fn new(source: Key, is_own: bool) -> Self {
        Self {
            source,
            is_own,
            amount: 0,
            reserved: 0,
        }
    }

    pub fn free(&self) -> u64 {
        self.amount.saturating_sub(self.reserved)
    }

    /// Adds Gemas held. Validates before mutating.
    pub fn credit(&mut self, account: &mut Account, n: u64) -> CoreResult<()> {
        let amount = self.amount.checked_add(n).ok_or(CoreError::Math)?;
        if self.is_own {
            account.own_total = account.own_total.checked_add(n).ok_or(CoreError::Math)?;
        } else {
            account.won_total = account.won_total.checked_add(n).ok_or(CoreError::Math)?;
        }
        self.amount = amount;
        Ok(())
    }

    /// Removes free Gemas held.
    pub fn debit(&mut self, account: &mut Account, n: u64) -> CoreResult<()> {
        if n > self.free() {
            return Err(CoreError::InsufficientGemas);
        }
        let class_free = if self.is_own {
            account.own_free()
        } else {
            account.won_free()
        };
        if n > class_free {
            return Err(CoreError::InsufficientGemas);
        }
        self.amount -= n;
        if self.is_own {
            account.own_total -= n;
        } else {
            account.won_total -= n;
        }
        Ok(())
    }
}

/// Return of own unspent Gemas cancels Debt. `holding` must be the owner's own-sourced Holding of
/// `source`. Only the Position owner can do this, and only up to the Source's Debt: Gemas already
/// repaid by yield are left for `redeem`. Principal is not an input.
pub fn return_own(
    position: &mut Position,
    source: &mut Source,
    account: &mut Account,
    holding: &mut Holding,
    amount: u64,
) -> CoreResult<()> {
    if amount == 0 {
        return Err(CoreError::ZeroAmount);
    }
    if !holding.is_own || source.owner != position.owner {
        return Err(CoreError::NotOwnSource);
    }
    if amount > source.debt() {
        return Err(CoreError::ExceedsDebt);
    }
    let mut src = source.clone();
    src.returned = src.returned.checked_add(amount).ok_or(CoreError::Math)?;
    let mut pos = position.clone();
    if src.debt() == 0 {
        // Yield beyond what the remaining Gemas need is the owner's again.
        let need = src.units_to_repay_total()?;
        if src.yield_units > need {
            pos.free_yield = pos
                .free_yield
                .checked_add(src.yield_units - need)
                .ok_or(CoreError::Math)?;
            src.yield_units = need;
        }
        if pos.open_advance == Some(src.index) {
            pos.open_advance = None;
        }
    }
    holding.debit(account, amount)?;
    *source = src;
    *position = pos;
    Ok(())
}

/// Redeem `amount` Gemas of `source` for source-asset units. Only up to the holder's pro rata
/// share of what the Source has repaid; winning Gemas never touches the winner's own lock.
/// Returns the source-asset units to pay out on the source chain.
pub fn redeem(
    source: &mut Source,
    account: &mut Account,
    holding: &mut Holding,
    amount: u64,
) -> CoreResult<u64> {
    if amount == 0 {
        return Err(CoreError::ZeroAmount);
    }
    if amount > source.redeemable_for(holding.free()) {
        return Err(CoreError::ExceedsRedeemable);
    }
    let units = source.units_for(amount)?;
    let redeemed = source.redeemed.checked_add(amount).ok_or(CoreError::Math)?;
    let redeemed_units = source
        .redeemed_units
        .checked_add(units)
        .ok_or(CoreError::Math)?;
    holding.debit(account, amount)?;
    source.redeemed = redeemed;
    source.redeemed_units = redeemed_units;
    Ok(units)
}

/// Instant Redeem: `amount` won Gemas of `source` move from the holder to the Treasury Account's
/// Holding of the same Source, and the holder is owed `payout` source units now: the Gemas' full
/// value less the Instant Redeem Fee. Only the holding's pending part can be sold: Gemas whose
/// yield has already landed are redeemed in full instead. The Source's counts do not change (the Treasury redeems
/// the Gemas later, as the yield lands), so Debt and every other holder's share are untouched.
/// Returns `(units, payout)`: the Gemas' full value and what the Treasury pays now.
pub fn instant_redeem(
    source: &Source,
    account: &mut Account,
    holding: &mut Holding,
    treasury_account: &mut Account,
    treasury_holding: &mut Holding,
    amount: u64,
    instant_fee_bps: u16,
) -> CoreResult<(u64, u64)> {
    if amount == 0 {
        return Err(CoreError::ZeroAmount);
    }
    if instant_fee_bps > MAX_INSTANT_FEE_BPS {
        return Err(CoreError::InvalidBps);
    }
    if holding.is_own || treasury_holding.is_own {
        return Err(CoreError::NotWonGemas);
    }
    if holding.source != treasury_holding.source {
        return Err(CoreError::HoldingMismatch);
    }
    let free = holding.free();
    if amount > free {
        return Err(CoreError::InsufficientGemas);
    }
    if amount > free.saturating_sub(source.redeemable_for(free)) {
        return Err(CoreError::ExceedsPending);
    }
    let units = source.units_for(amount)?;
    let keep = BPS
        .checked_sub(instant_fee_bps as u128)
        .ok_or(CoreError::Math)?;
    let payout = to_u64(mul_div_floor(units as u128, keep, BPS)?)?;
    if payout == 0 {
        return Err(CoreError::ZeroAmount);
    }
    let mut to = treasury_holding.clone();
    let mut to_account = treasury_account.clone();
    to.credit(&mut to_account, amount)?;
    holding.debit(account, amount)?;
    *treasury_holding = to;
    *treasury_account = to_account;
    Ok((units, payout))
}

// ---------------------------------------------------------------------------------------------
// Entry draws
// ---------------------------------------------------------------------------------------------

/// A slice of Gemas of one Source moving into a Pot or a reservation.
#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Line {
    pub source: Key,
    pub amount: u64,
}

/// Plans an entry of `entry` Gemas over the supplied `holdings` and returns the amount drawn from
/// each (same order). The rule (see docs/tesoro-core.md):
/// 1. own-sourced Gemas first: `own = min(entry, own_free)`, then won Gemas for the rest;
/// 2. holdings are supplied own class first, then won, each strictly ascending by Source key;
/// 3. each class is drained in that order (every holding except the last used is fully drained);
///    a holding that would contribute nothing is rejected;
/// 4. at most `MAX_ENTRY_SOURCES` holdings.
pub fn plan_draw(account: &Account, holdings: &[Holding], entry: u64) -> CoreResult<Vec<u64>> {
    if entry == 0 {
        return Err(CoreError::ZeroAmount);
    }
    if holdings.len() > MAX_ENTRY_SOURCES {
        return Err(CoreError::TooManySources);
    }
    for pair in holdings.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        let ordered = match (a.is_own, b.is_own) {
            (true, false) => true,
            (false, true) => false,
            _ => a.source < b.source,
        };
        if !ordered {
            return Err(CoreError::NonCanonicalDraw);
        }
    }
    let own_need = entry.min(account.own_free());
    let won_need = entry - own_need;
    if won_need > account.won_free() {
        return Err(CoreError::InsufficientGemas);
    }
    let mut takes = Vec::with_capacity(holdings.len());
    let mut own_left = own_need;
    let mut won_left = won_need;
    for h in holdings {
        let left = if h.is_own {
            &mut own_left
        } else {
            &mut won_left
        };
        let take = (*left).min(h.free());
        if take == 0 {
            return Err(CoreError::NonCanonicalDraw);
        }
        *left -= take;
        takes.push(take);
    }
    if own_left != 0 || won_left != 0 {
        return Err(CoreError::NonCanonicalDraw);
    }
    Ok(takes)
}

/// Enters a Match with own-and-won Gemas: debits the holdings and returns the Pot lines.
pub fn draw_entry(
    account: &mut Account,
    holdings: &mut [Holding],
    entry: u64,
) -> CoreResult<Vec<Line>> {
    let takes = plan_draw(account, holdings, entry)?;
    let mut lines = Vec::with_capacity(takes.len());
    for (h, t) in holdings.iter_mut().zip(takes) {
        h.debit(account, t)?;
        lines.push(Line {
            source: h.source,
            amount: t,
        });
    }
    Ok(lines)
}

/// Reservation of a Backer's Gemas for an Offer; `is_own` keeps the own-first classes intact.
#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct ReservedLine {
    pub source: Key,
    pub is_own: bool,
    pub amount: u64,
}

/// Reserves `entry` Gemas with the same draw rule. Returns the reserved lines.
pub fn reserve(
    account: &mut Account,
    holdings: &mut [Holding],
    entry: u64,
) -> CoreResult<Vec<ReservedLine>> {
    let takes = plan_draw(account, holdings, entry)?;
    let mut lines = Vec::with_capacity(takes.len());
    for (h, t) in holdings.iter_mut().zip(takes) {
        h.reserved = h.reserved.checked_add(t).ok_or(CoreError::Math)?;
        if h.is_own {
            account.own_reserved = account.own_reserved.checked_add(t).ok_or(CoreError::Math)?;
        } else {
            account.won_reserved = account.won_reserved.checked_add(t).ok_or(CoreError::Math)?;
        }
        lines.push(ReservedLine {
            source: h.source,
            is_own: h.is_own,
            amount: t,
        });
    }
    Ok(lines)
}

fn check_reservation(
    account: &Account,
    holdings: &[Holding],
    lines: &[ReservedLine],
) -> CoreResult<()> {
    if holdings.len() != lines.len() {
        return Err(CoreError::ReservationMismatch);
    }
    let (mut own, mut won) = (0u64, 0u64);
    for (h, l) in holdings.iter().zip(lines) {
        if h.source != l.source || h.is_own != l.is_own || h.reserved < l.amount {
            return Err(CoreError::ReservationMismatch);
        }
        if l.is_own {
            own = own.checked_add(l.amount).ok_or(CoreError::Math)?;
        } else {
            won = won.checked_add(l.amount).ok_or(CoreError::Math)?;
        }
    }
    if own > account.own_reserved || won > account.won_reserved {
        return Err(CoreError::ReservationMismatch);
    }
    Ok(())
}

/// Releases a reservation back to free Gemas (Offer cancelled or expired).
pub fn release(
    account: &mut Account,
    holdings: &mut [Holding],
    lines: &[ReservedLine],
) -> CoreResult<()> {
    check_reservation(account, holdings, lines)?;
    for (h, l) in holdings.iter_mut().zip(lines) {
        h.reserved -= l.amount;
        if l.is_own {
            account.own_reserved -= l.amount;
        } else {
            account.won_reserved -= l.amount;
        }
    }
    Ok(())
}

/// Moves a reservation into a Pot: the reserved Gemas leave the holdings and become Pot lines.
pub fn consume_reservation(
    account: &mut Account,
    holdings: &mut [Holding],
    lines: &[ReservedLine],
) -> CoreResult<Vec<Line>> {
    check_reservation(account, holdings, lines)?;
    for (h, l) in holdings.iter_mut().zip(lines) {
        h.reserved -= l.amount;
        h.amount -= l.amount;
        if l.is_own {
            account.own_reserved -= l.amount;
            account.own_total -= l.amount;
        } else {
            account.won_reserved -= l.amount;
            account.won_total -= l.amount;
        }
    }
    Ok(lines
        .iter()
        .map(|l| Line {
            source: l.source,
            amount: l.amount,
        })
        .collect())
}

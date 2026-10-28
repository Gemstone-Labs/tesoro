//! Positions, Advances and the Treasury route on the exact books (economy upgrade, ticket 11).
//!
//! Pure Rust, like the rest of `ledger`: no accounts, no clocks, no CPIs. The instruction layer
//! loads a Position, its Source's book (and the checkpoint pages), the custody's [`RouteLedger`]
//! and the rate of the moment, and calls these functions; every number that moves is decided here.
//!
//! # One rule for three kinds of Source
//!
//! A Source's coverage is `net - position.applied_net` source-asset units (the open Advance counts
//! only what accrued after it), turned into Gemas at the Source's own price. What `net` is depends
//! on the Position's kind, nothing else does:
//!
//! * **native** (sim_lst) and **stake** (an SPL stake-pool token): computed from the clock or the
//!   Staking Rate at the instant (ADR 0010), so every instruction that touches the Source first
//!   syncs it ([`sync_source`]);
//! * **reported** (ETH/HYPE): the cumulative yield of the latest applied Yield Report
//!   (`Position::cumulative_yield`), so the report's arrival is the boundary. Its shares are
//!   source-asset units ([`ShareRate::reported`]).
//!
//! # Shares (founder D2: holders carry slashes)
//!
//! When coverage lands, the staking-token shares it is worth at that instant are recorded in the
//! book ([`SourceBook::land`]). A Redeem pays those shares, less the Yield Fee (ticket 31: the fee
//! is taken when yield leaves, [`super::yield_fee`]). The Position keeps one number for all of its
//! books, [`Position::held_shares`]: the landed shares that are not yet paid out or taken by the
//! owner. At Unlock the held shares (rounded down) stay with the Treasury's route as
//! `owed_shares`, the Yield Fee on the owner's free yield is realised, and the owner gets the rest
//! of the custody back.
//!
//! ```text
//! custody = owner_out + fee + owed          (stake: real tokens; native: the vault holds Principal only)
//! ```

use super::book::checkpoint::CheckpointStore;
use super::book::wide::{mul_div_u128, Round};
use super::book::{fp_floor, Book, ClassSlots, Landing, Redeemed, Returned, FP_BITS, SHARE_BITS};
use super::line_store::{Line, CLASS_GENERAL, SIDE_OWN};
use super::prize::RouteLedger;
use super::yield_fee::cash_out;
use super::{
    CoreError, CoreResult, Position, PositionStatus, Source, MAX_HORIZON_MONTHS, RATE_SCALE,
    STAKE_RATE_SCALE, YEAR_SECS,
};

/// Seconds in one month of the planned-repayment clock.
pub const MONTH_SECS: i64 = (YEAR_SECS / 12) as i64;

/// Fixed-point dust (Fp, 2^-64 Gema) a sync forgives: proportional moves hand at most one unit
/// each to the owner's pocket, which turns it back into unpaid Gemas that no landing is worth
/// waiting for. A Source whose unpaid total is at most this far from what the computed coverage
/// pays is treated as repaid (about 6e-8 of a Gema, $6e-10).
pub const DUST_FORGIVEN_FP: u128 = 1 << 40;

/// Planned repayment date of an Advance of `months` taken at `now`, on a clock that runs `speedup`
/// times faster (1 on mainnet, 4,380 on devnet).
pub fn planned_due_at(now: i64, months: u8, speedup: u32) -> CoreResult<i64> {
    let secs = i64::from(months)
        .checked_mul(MONTH_SECS)
        .ok_or(CoreError::Math)?
        / i64::from(speedup.max(1));
    now.checked_add(secs).ok_or(CoreError::Math)
}

// ---------------------------------------------------------------------------------------------
// Units, Gemas and shares
// ---------------------------------------------------------------------------------------------

/// Which staking-token shares pay a Source asset's units: `shares = units * scale / rate`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShareRate {
    scale: u128,
    rate: u128,
}

impl ShareRate {
    pub fn new(scale: u128, rate: u64) -> CoreResult<Self> {
        if scale == 0 || rate == 0 {
            return Err(CoreError::Math);
        }
        Ok(Self {
            scale,
            rate: u128::from(rate),
        })
    }

    /// sim_lst shares at its rate (SOL per share, 1e9 fixed point).
    pub fn native(rate: u64) -> CoreResult<Self> {
        Self::new(RATE_SCALE, rate)
    }

    /// Stake-pool tokens at the Staking Rate (lamports per token, 1e12 fixed point).
    pub fn stake(rate: u64) -> CoreResult<Self> {
        Self::new(STAKE_RATE_SCALE, rate)
    }

    /// Reported Sources: a share is one unit of the Source asset (the vault converts at its own
    /// rate when it pays).
    pub const fn reported() -> Self {
        Self { scale: 1, rate: 1 }
    }

    /// Shares (32 fractional bits) worth `units_fp` units (2^64 fixed point), rounded down.
    pub fn shares_for_units_fp(&self, units_fp: u128) -> CoreResult<u128> {
        mul_div_u128(units_fp, self.scale, self.rate << SHARE_BITS, Round::Down)
            .ok_or(CoreError::Math)
    }

    /// Shares (32 fractional bits) worth `units` whole units, rounded down.
    pub fn shares_for_units(&self, units: u64) -> CoreResult<u128> {
        self.shares_for_units_fp(u128::from(units) << FP_BITS)
    }

    /// Whole units worth `shares` whole shares, rounded down.
    pub fn units_for_shares(&self, shares: u128) -> CoreResult<u128> {
        mul_div_u128(shares, self.rate, self.scale, Round::Down).ok_or(CoreError::Math)
    }

    /// Whole shares worth `units` whole units, rounded up (what must be kept to cover `units`).
    pub fn whole_shares_for_units_ceil(&self, units: u64) -> CoreResult<u64> {
        let s = mul_div_u128(u128::from(units), self.scale, self.rate, Round::Up)
            .ok_or(CoreError::Math)?;
        u64::try_from(s).map_err(|_| CoreError::Math)
    }

    /// The rate itself: Source-asset units per share at `scale` (stake: lamports per token, 1e12).
    pub fn per_share(&self) -> u128 {
        self.rate
    }

    /// Whole shares worth `units` whole units, rounded down (what a payout of `units` sends).
    pub fn whole_shares_for_units(&self, units: u64) -> CoreResult<u64> {
        let s = mul_div_u128(u128::from(units), self.scale, self.rate, Round::Down)
            .ok_or(CoreError::Math)?;
        u64::try_from(s).map_err(|_| CoreError::Math)
    }
}

/// Gemas (2^64 fixed point) that `units` source-asset units repay at the Source's own price,
/// rounded down.
pub fn units_to_gemas_fp(src: &Source, units: u64) -> CoreResult<u128> {
    mul_div_u128(
        u128::from(units),
        u128::from(src.unit_den) << FP_BITS,
        src.unit_num,
        Round::Down,
    )
    .ok_or(CoreError::Math)
}

/// Units (2^64 fixed point) that `gemas_fp` Gemas (2^64 fixed point) are worth, rounded down.
pub fn gemas_fp_to_units_fp(src: &Source, gemas_fp: u128) -> CoreResult<u128> {
    mul_div_u128(
        gemas_fp,
        src.unit_num,
        u128::from(src.unit_den),
        Round::Down,
    )
    .ok_or(CoreError::Math)
}

/// Shares (32 fractional bits) that `k` whole Gemas of `src` are worth at `rate`, rounded down:
/// the figure an Instant Redeem fill prices and a prize Source is sized with.
pub fn shares_for_gemas(src: &Source, k: u64, rate: &ShareRate) -> CoreResult<u128> {
    rate.shares_for_units_fp(gemas_fp_to_units_fp(src, u128::from(k) << FP_BITS)?)
}

/// Whole Gemas that `shares` whole shares are worth at `rate` and a price of `price_micro_usd`
/// per whole Source asset with `decimals` decimals, rounded down (the size of a prize Source).
pub fn gemas_for_shares(
    shares: u128,
    rate: &ShareRate,
    decimals: u8,
    price_micro_usd: u64,
) -> CoreResult<u64> {
    let units = rate.units_for_shares(shares)?;
    let num = 10u128
        .checked_pow(u32::from(decimals) + 4)
        .ok_or(CoreError::Math)?;
    let g = mul_div_u128(units, u128::from(price_micro_usd), num, Round::Down)
        .ok_or(CoreError::Math)?;
    u64::try_from(g).map_err(|_| CoreError::Math)
}

/// Shares a book holds: every class's pool and the owner's pocket (32 fractional bits).
pub fn book_shares<S: ClassSlots>(book: &Book<S>) -> u128 {
    (0..book.class_count()).fold(book.owner_shares, |acc, i| {
        acc.saturating_add(book.class(i as u8).map_or(0, |c| c.shares))
    })
}

// ---------------------------------------------------------------------------------------------
// Sync: landing the coverage a Source has earned
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Synced {
    pub landing: Landing,
    /// Shares (32 fractional bits) the landing recorded.
    pub shares: u128,
}

/// Lands the coverage the open Advance has earned at net Accrued Yield `net`, paying its classes
/// in order, and records the shares it is worth at `rate`. A Source that is not the Position's open
/// Advance has landed everything already: a no-op.
pub fn sync_source<S: ClassSlots, C: CheckpointStore + ?Sized>(
    position: &mut Position,
    src: &Source,
    book: &mut Book<S>,
    net: u64,
    rate: &ShareRate,
    ck: &mut C,
) -> CoreResult<Synced> {
    if position.open_advance != Some(src.index) {
        return Ok(Synced::default());
    }
    let counted = net.saturating_sub(position.applied_net);
    let mut target = units_to_gemas_fp(src, counted)?;
    let need = book.uncovered_total();
    let full = book.h.checked_add(need).ok_or(CoreError::Math)?;
    if target < full && full - target <= DUST_FORGIVEN_FP {
        target = full;
    }
    let pending = book.pending(target);
    if pending == 0 {
        return Ok(Synced::default());
    }
    let shares = rate.shares_for_units_fp(gemas_fp_to_units_fp(src, pending)?)?;
    let held = position
        .held_shares
        .checked_add(shares)
        .ok_or(CoreError::Math)?;
    let landing = book.land(target, shares, ck)?;
    position.held_shares = held;
    note_priced_rate(position, rate)?;
    Ok(Synced { landing, shares })
}

/// A stake Position's yield was just priced at `rate`: its highest priced rate follows (ticket 55).
fn note_priced_rate(position: &mut Position, rate: &ShareRate) -> CoreResult<()> {
    if position.stake_rate_open != 0 {
        let r = u64::try_from(rate.per_share()).map_err(|_| CoreError::Math)?;
        position.stake_rate_high = position.stake_rate_high.max(r);
    }
    Ok(())
}

/// The owner takes the book's pocket: coverage no holder is owed (excess yield, `return_own`'s
/// released ready, rounding dust) becomes the Position's free yield, with its shares.
pub fn take_pocket<S: ClassSlots>(position: &mut Position, book: &mut Book<S>) -> CoreResult<u128> {
    let (_fp, shares) = book.take_owner_pocket()?;
    position.held_shares = position
        .held_shares
        .checked_sub(shares)
        .ok_or(CoreError::BookInconsistent)?;
    position.free_shares = position
        .free_shares
        .checked_add(shares)
        .ok_or(CoreError::Math)?;
    Ok(shares)
}

/// Closes the open Advance whose Debt is zero: lands what is earned, banks the owner's pocket as
/// free yield and moves the checkpoint to `net`. `DebtOutstanding` when anything is still unpaid.
pub fn close_advance<S: ClassSlots, C: CheckpointStore + ?Sized>(
    position: &mut Position,
    src: &Source,
    book: &mut Book<S>,
    net: u64,
    rate: &ShareRate,
    ck: &mut C,
) -> CoreResult<()> {
    if position.open_advance != Some(src.index) {
        return Err(CoreError::SourceMismatch);
    }
    sync_source(position, src, book, net, rate, ck)?;
    if book.uncovered_total() != 0 {
        return Err(CoreError::DebtOutstanding);
    }
    take_pocket(position, book)?;
    position.applied_net = position.applied_net.max(net);
    position.open_advance = None;
    Ok(())
}

/// With no Advance open, everything accrued since the checkpoint is free yield: bank it, in the
/// shares it is worth now.
pub fn bank_free_yield(position: &mut Position, net: u64, rate: &ShareRate) -> CoreResult<()> {
    if position.open_advance.is_some() {
        return Err(CoreError::AdvanceAlreadyOpen);
    }
    let delta = net.saturating_sub(position.applied_net);
    let shares = rate.shares_for_units(delta)?;
    position.free_shares = position
        .free_shares
        .checked_add(shares)
        .ok_or(CoreError::Math)?;
    position.applied_net = position.applied_net.max(net);
    if delta > 0 {
        note_priced_rate(position, rate)?;
    }
    Ok(())
}

/// Readies the Position for a new Advance: closes the previous one (its Debt must be zero) or banks
/// the idle yield. `previous` is that Source and its book when one is open.
pub fn prepare_advance<S: ClassSlots, C: CheckpointStore + ?Sized>(
    position: &mut Position,
    previous: Option<(&Source, &mut Book<S>, &mut C)>,
    net: u64,
    rate: &ShareRate,
) -> CoreResult<()> {
    match (position.open_advance, previous) {
        (Some(_), Some((src, book, ck))) => {
            if let Err(e) = close_advance(position, src, book, net, rate, ck) {
                return Err(match e {
                    CoreError::DebtOutstanding => CoreError::AdvanceAlreadyOpen,
                    other => other,
                });
            }
            Ok(())
        }
        (Some(_), None) => Err(CoreError::SourceMismatch),
        (None, _) => bank_free_yield(position, net, rate),
    }
}

/// The General line of a fresh Advance: `src.issued` Gemas, all unpaid, in the owner's own side.
pub fn advance_line<S: ClassSlots, C: CheckpointStore + ?Sized>(
    book: &mut Book<S>,
    source_key: [u8; 32],
    src: &Source,
    ck: &C,
) -> CoreResult<Line> {
    let mut line = Book::<S>::blank_line(SIDE_OWN, src.due_at, source_key, CLASS_GENERAL, 0);
    book.issue(&mut line, src.issued, ck)?;
    Ok(line)
}

/// Ticket 55, stake Positions only (others pass): new Gemas of `src` may be issued only at or
/// above the highest rate the Position's yield was priced at (`RateBelowPeak`), and only while the
/// Position's settled yield plus everything `src` can still cover stays within its Principal
/// (`YieldCapReached`). `src` is the Source as it will be stored (an Extend's full new issuance).
/// With the cap, holders' shares never exceed the custody: each landing is priced above the
/// opening rate, so the shares of at most Principal of yield are fewer than `custody_shares`.
pub fn check_stake_issuance(position: &Position, rate: &ShareRate, src: &Source) -> CoreResult<()> {
    if position.stake_rate_open == 0 {
        return Ok(());
    }
    if rate.per_share() < u128::from(super::stake_rate_peak(position)) {
        return Err(CoreError::RateBelowPeak);
    }
    let live = src
        .issued
        .checked_sub(src.returned)
        .ok_or(CoreError::Math)?;
    let commit = mul_div_u128(
        u128::from(live),
        src.unit_num,
        u128::from(src.unit_den),
        Round::Up,
    )
    .ok_or(CoreError::Math)?;
    let total = u128::from(position.applied_net)
        .checked_add(commit)
        .ok_or(CoreError::Math)?;
    if total > u128::from(position.principal) {
        return Err(CoreError::YieldCapReached);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Extend
// ---------------------------------------------------------------------------------------------

/// Gemas an Extend of `extra_months` mints: `size(h + extra) - size(h)` at the Source's own price.
/// Moves the Source's Horizon, total issued and planned repayment date.
pub fn extend_gemas(
    position: &Position,
    src: &mut Source,
    extra_months: u8,
    speedup: u32,
) -> CoreResult<u64> {
    let total = src
        .horizon_months
        .checked_add(extra_months)
        .ok_or(CoreError::InvalidHorizon)?;
    if extra_months == 0 || total > MAX_HORIZON_MONTHS {
        return Err(CoreError::InvalidHorizon);
    }
    let before = position.advance_gemas(src.horizon_months, src.unit_den)?;
    let after = position.advance_gemas(total, src.unit_den)?;
    let minted = after.checked_sub(before).ok_or(CoreError::Math)?;
    if minted == 0 {
        return Err(CoreError::AdvanceTooSmall);
    }
    let issued = src.issued.checked_add(minted).ok_or(CoreError::Math)?;
    let due = planned_due_at(src.due_at, extra_months, speedup)?;
    src.issued = issued;
    src.horizon_months = total;
    src.due_at = due;
    Ok(minted)
}

/// Extend the open Advance: lands what is earned, then starts the next Extension tranche (junior to
/// everything issued before it) and issues the new Gemas into a line of it. Returns the line and
/// the Gemas minted. The caller credits the line to the owner's basket.
#[allow(clippy::too_many_arguments)]
pub fn extend_source<S: ClassSlots, C: CheckpointStore + ?Sized>(
    position: &mut Position,
    src: &mut Source,
    source_key: [u8; 32],
    book: &mut Book<S>,
    extra_months: u8,
    speedup: u32,
    net: u64,
    rate: &ShareRate,
    ck: &mut C,
) -> CoreResult<(Line, u64)> {
    if position.status != PositionStatus::Locked {
        return Err(CoreError::PositionNotLocked);
    }
    let open = position.open_advance.ok_or(CoreError::NoOpenAdvance)?;
    if src.index != open {
        return Err(CoreError::SourceMismatch);
    }
    sync_source(position, src, book, net, rate, ck)?;
    if book.uncovered_total() == 0 {
        return Err(CoreError::AdvanceRepaid);
    }
    let mut next = src.clone();
    let minted = extend_gemas(position, &mut next, extra_months, speedup)?;
    check_stake_issuance(position, rate, &next)?;
    let class = book.start_extension()?;
    let mut line = Book::<S>::blank_line(
        SIDE_OWN,
        next.due_at,
        source_key,
        class,
        class - CLASS_GENERAL,
    );
    book.issue(&mut line, minted, &*ck)?;
    *src = next;
    Ok((line, minted))
}

// ---------------------------------------------------------------------------------------------
// return_own, Redeem
// ---------------------------------------------------------------------------------------------

/// `return_own`: the owner takes `k` of their own Gemas of `src` out of the Source. The ready part
/// is released to the owner's pocket (once, against `R`), the unpaid part is cancelled. When the
/// Source was the open Advance and nothing is unpaid any more, the Advance closes.
#[allow(clippy::too_many_arguments)]
pub fn return_own_source<S: ClassSlots, C: CheckpointStore + ?Sized>(
    position: &mut Position,
    src: &mut Source,
    book: &mut Book<S>,
    line: &mut Line,
    k: u64,
    net: u64,
    rate: &ShareRate,
    ck: &mut C,
) -> CoreResult<Returned> {
    if position.status != PositionStatus::Locked {
        return Err(CoreError::PositionNotLocked);
    }
    if line.side != SIDE_OWN || src.owner != position.owner || !line.is_playable() {
        return Err(CoreError::NotOwnSource);
    }
    sync_source(position, src, book, net, rate, ck)?;
    let returned = book.return_own(line, k, ck)?;
    src.returned = src.returned.checked_add(k).ok_or(CoreError::Math)?;
    if position.open_advance == Some(src.index) {
        if book.uncovered_total() == 0 {
            close_advance(position, src, book, net, rate, ck)?;
        }
    } else {
        take_pocket(position, book)?;
    }
    Ok(returned)
}

/// Where the shares a Redeem pays come from: the Position's held shares while it is Locked, the
/// route's `owed_shares` once it is Unlocked.
pub fn debit_paid_shares(
    position: &mut Position,
    kind: CustodyKind,
    route: Option<&mut RouteLedger>,
    paid: u64,
) -> CoreResult<()> {
    if paid == 0 {
        return Ok(());
    }
    match (position.status, route) {
        (PositionStatus::Locked, _) | (PositionStatus::Unlocked, None) => {
            let held = position
                .held_shares
                .checked_sub(u128::from(paid) << SHARE_BITS)
                .ok_or(CoreError::BookInconsistent)?;
            let paid_total =
                if kind == CustodyKind::Stake && position.status == PositionStatus::Locked {
                    let total = position
                        .paid_shares
                        .checked_add(paid)
                        .ok_or(CoreError::Math)?;
                    if total > position.custody_shares {
                        return Err(CoreError::VaultShortfall);
                    }
                    total
                } else {
                    position.paid_shares
                };
            position.held_shares = held;
            position.paid_shares = paid_total;
            Ok(())
        }
        (PositionStatus::Unlocked, Some(route)) => route.pay_owed(u128::from(paid)),
    }
}

/// Whole Gemas of `redeemed` as a count and the shares paid, for the event and the payout.
pub fn redeemed_paid(r: &Redeemed) -> (u64, u64) {
    (r.gemas, u64::try_from(r.shares).unwrap_or(u64::MAX))
}

// ---------------------------------------------------------------------------------------------
// Unlock
// ---------------------------------------------------------------------------------------------

/// What backs a Position's custody.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CustodyKind {
    /// sim_lst: the vault holds only Principal; yield is minted at payout, so the fee and the
    /// holders' claims are virtual shares of the route.
    Native,
    /// A real staking token: the vault holds the Principal, the holders' landed shares and the fee.
    Stake,
    /// A Position of another chain: its vault is on that chain, the core keeps no custody.
    Reported,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UnlockPayout {
    /// Shares returned to the owner from the custody vault (Principal; staking token: everything
    /// not owed to holders or the fee), including any Treasury top-up.
    pub owner_shares: u64,
    /// Shares minted to the owner as free yield, after the Yield Fee (native only).
    pub mint_shares: u64,
    /// The Yield Fee on the owner's free yield, in whole shares, realised now.
    pub fee_shares: u64,
    /// Shares the holders of the Position's Gemas are owed, fixed now (D2).
    pub owed_shares: u64,
    /// Staking token: the part of what the custody lacks that is growth since the yield was
    /// priced, net of any fall (ticket 55): holders' landed shares grew with the pool and the same
    /// growth also counted as the Position's yield. The Treasury tops it up from spendable shares
    /// ([`route_after_unlock`]). Never set at or below the opening rate, never for a fall.
    pub shortfall_shares: u64,
    /// What the owner got less than the Principal and free yield: a slash, or the part of the
    /// shortfall the Treasury could not cover.
    pub gap_shares: u64,
    /// What the Treasury topped up out of `shortfall_shares`.
    pub topped_up_shares: u64,
    /// Staking token, a Lock from before ticket 55 only: what holders are owed beyond the shares
    /// its custody still holds. The whole custody goes to the route and the Treasury funds this
    /// from spendable shares, or the Unlock waits (`GrowthClaimsUnfunded`).
    pub claims_funded_shares: u64,
}

/// What the shares a stake Position's yield landed in grew since that yield was priced, net of
/// any fall since, at `rate`: every share its yield ever landed in (held, free, paid out) less the
/// Yield Fee on the free part, less what all of the yield priced so far (counted at the highest
/// priced rate) is worth now. Zero when that is negative. Landings priced above `rate` net
/// against those below it, so growth a later fall hides is the owner's (design-v4 3.3).
fn landed_growth_shares(position: &Position, rate: &ShareRate, free_fee: u64) -> CoreResult<u64> {
    let priced = super::stake_position_accrued(position, super::stake_rate_peak(position))?;
    let landed = (position.held_shares.saturating_add(position.free_shares) >> SHARE_BITS)
        .saturating_add(u128::from(position.paid_shares));
    let worth = u128::from(rate.whole_shares_for_units_ceil(priced)?);
    let growth = landed.saturating_sub(u128::from(free_fee).saturating_add(worth));
    // Only ever compared with the custody's shortfall (a u64): saturating loses nothing.
    Ok(u64::try_from(growth).unwrap_or(u64::MAX))
}

/// Unlock a Position whose Advance is already closed (or banked). The Yield Fee is charged on the
/// owner's free yield only (ticket 31: covered yield pays it when its holders cash out), at the
/// Position's `yield_fee_bps`. Marks it Unlocked and returns where its custody goes. Reported
/// Positions move no custody here.
pub fn settle_unlock(
    position: &mut Position,
    kind: CustodyKind,
    rate: &ShareRate,
) -> CoreResult<UnlockPayout> {
    if position.status != PositionStatus::Locked {
        return Err(CoreError::PositionNotLocked);
    }
    if position.open_advance.is_some() {
        return Err(CoreError::DebtOutstanding);
    }
    let one = 1u128 << SHARE_BITS;
    // Rounded down: the shares holders can ever be paid are whole shares of their lines, whose
    // sum never exceeds the whole shares of the total (floors of parts <= floor of the sum), and
    // a fraction of a share nobody owns stays with the owner.
    let owed = u64::try_from(position.held_shares / one).map_err(|_| CoreError::Math)?;
    let free = u64::try_from(position.free_shares >> SHARE_BITS).map_err(|_| CoreError::Math)?;
    let split = cash_out(u128::from(free), position.yield_fee_bps, 0)?;
    let free_fee = u64::try_from(split.fee).map_err(|_| CoreError::Math)?;
    let free_after = free.checked_sub(free_fee).ok_or(CoreError::Math)?;
    let payout = match kind {
        CustodyKind::Reported => {
            position.status = PositionStatus::Unlocked;
            return Ok(UnlockPayout::default());
        }
        CustodyKind::Native => UnlockPayout {
            owner_shares: position.custody_shares,
            mint_shares: free_after,
            fee_shares: free_fee,
            owed_shares: owed,
            ..UnlockPayout::default()
        },
        CustodyKind::Stake => {
            let custody =
                position.custody_shares - position.paid_shares.min(position.custody_shares);
            // The Principal is counted at the higher of the rate now and at open: below the
            // opening rate the owner carries the fall (D2, no cushion; red-team 31 #1).
            let open = ShareRate::stake(position.stake_rate_open)?;
            let above_open = rate.per_share() > open.per_share();
            let principal_rate = if above_open { rate } else { &open };
            let due = principal_rate
                .whole_shares_for_units_ceil(position.principal)?
                .checked_add(free_after)
                .ok_or(CoreError::Math)?;
            if owed > custody {
                // Only a Lock issued before the lifetime cap gets here (design-v4 5): its holders
                // are owed more than its custody. The custody goes to them; the Treasury funds
                // the rest ([`route_after_unlock`]); the owner gets nothing back.
                return finish_unlock(
                    position,
                    UnlockPayout {
                        owed_shares: owed,
                        gap_shares: due,
                        claims_funded_shares: owed - custody,
                        ..UnlockPayout::default()
                    },
                );
            }
            let rest = custody - owed;
            if rest >= due {
                let fee = free_fee.min(rest - due);
                UnlockPayout {
                    owner_shares: rest - fee,
                    fee_shares: fee,
                    owed_shares: owed,
                    ..UnlockPayout::default()
                }
            } else {
                // Short. The Treasury covers only the growth of the landed shares since their
                // yield was priced (SOL-02 A, ticket 55); a rate fall is the owner's gap.
                let short = due - rest;
                let growth = if above_open {
                    landed_growth_shares(position, rate, free_fee)?
                } else {
                    0
                };
                let shortfall = short.min(growth);
                UnlockPayout {
                    owner_shares: rest,
                    owed_shares: owed,
                    shortfall_shares: shortfall,
                    gap_shares: short - shortfall,
                    ..UnlockPayout::default()
                }
            }
        }
    };
    finish_unlock(position, payout)
}

fn finish_unlock(position: &mut Position, payout: UnlockPayout) -> CoreResult<UnlockPayout> {
    position.status = PositionStatus::Unlocked;
    position.custody_shares = 0;
    position.paid_shares = 0;
    position.held_shares = 0;
    position.free_shares &= (1u128 << SHARE_BITS) - 1;
    Ok(payout)
}

/// The Treasury's route after an Unlock: the fee on the free yield is realised (the Pool's part at
/// `pool_bps`), the holders' claim becomes `owed_shares`, then the Treasury tops up a stake
/// Position's shortfall from what it can spend; `payout.owner_shares` grows by the top-up and
/// `payout.gap_shares` is what it could not cover. Everything is validated before anything changes.
pub fn route_after_unlock(
    route: &mut RouteLedger,
    payout: &mut UnlockPayout,
    pool_bps: u16,
) -> CoreResult<()> {
    let mut next = route.clone();
    next.realise_yield_fee(u128::from(payout.fee_shares), pool_bps)?;
    // The custody's shares the holders are owed join the route; claims beyond the custody
    // (`claims_funded_shares`, legacy Locks only) must fit what the Treasury may spend.
    let received = payout
        .owed_shares
        .checked_sub(payout.claims_funded_shares)
        .ok_or(CoreError::Math)?;
    next.receive(u128::from(received))?;
    next.add_owed(u128::from(payout.owed_shares)).map_err(|e| {
        match (e, payout.claims_funded_shares) {
            (CoreError::OwedExceedsTreasury, 1..) => CoreError::GrowthClaimsUnfunded,
            (e, _) => e,
        }
    })?;
    let shortfall = u128::from(payout.shortfall_shares);
    let top = shortfall.min(next.spendable());
    next.spend(top)?;
    let top = u64::try_from(top).map_err(|_| CoreError::Math)?;
    let owner = payout
        .owner_shares
        .checked_add(top)
        .ok_or(CoreError::Math)?;
    let gap = payout
        .gap_shares
        .checked_add(payout.shortfall_shares - top)
        .ok_or(CoreError::Math)?;
    *route = next;
    payout.owner_shares = owner;
    payout.gap_shares = gap;
    payout.topped_up_shares = top;
    Ok(())
}

/// Free yield the owner of a Reported Position may still claim, in source-asset units.
pub fn claimable_units(position: &Position) -> u64 {
    let total = u64::try_from(position.free_shares >> SHARE_BITS).unwrap_or(u64::MAX);
    total.saturating_sub(position.free_yield_claimed)
}

/// Whole Gemas of a fixed-point amount (for events).
pub fn whole(v: u128) -> u64 {
    fp_floor(v)
}

#[cfg(test)]
mod tests;

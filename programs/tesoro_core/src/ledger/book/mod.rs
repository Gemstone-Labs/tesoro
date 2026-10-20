//! Exact bookkeeping of a Source's Gemas (spec "Ledger: exact bookkeeping", ticket 03).
//!
//! Pure Rust over plain values, like the rest of `ledger`. A Source keeps one [`SourceBook`]; every
//! basket line and every fee counter is a [`Line`] (from `line_store`) that this module brings up to
//! date and edits. Nothing here knows about accounts, Positions or rates: the caller passes
//! the cumulative coverage the Source has earned and the staking-token shares it is worth.
//!
//! # Units
//!
//! * Gemas are whole in `Line::amount` and fixed point (`x * 2^64`, `u128`) everywhere else: a
//!   line's `uncovered`, a class's `uncovered` and `ready`, and the coverage counters. "Fp" below.
//! * Shares are staking-token base units in fixed point with 32 fractional bits (`SHARE_BITS`).
//!
//! # Model
//!
//! Every Gema of a Source is in one class, paid strictly in this order: Platform, Studio,
//! Leaderboard, General, Extension 1, 2, ... (`line.class`). A class is a Liquity-style stability
//! pool: `uncovered` (`U`) is the exact total still unpaid, `p`/`scale`/`epoch` is the product index
//! that shrinks every line's unpaid share without enumerating holders, and `ready`/`shares` is the
//! pool of repaid Gemas and the staking-token shares that back them.
//!
//! * A line stores `(amount, uncovered)` as of its snapshot `(p, scale, epoch)`. Its current unpaid
//!   amount is `ceil(uncovered * P / p_snapshot / 2^(32 * scale diff))`, and zero if the class's
//!   epoch moved on (the class was paid in full). Ready is `amount * 2^64 - uncovered`, so
//!   a line has no stored ready field and ready + unpaid always equals the amount.
//! * Landing coverage `D` into a class with unpaid total `U`: `D >= U` pays it in full and starts a
//!   new epoch; otherwise `P` becomes `ceil(P * (U - D) / U)` (rescaled by 2^32 when it would fall
//!   below `P_MIN`). `ready += D`, `shares += shares landed`.
//!
//! # Why the sum of ready never exceeds what landed
//!
//! Per class, exactly: `ready + U = sum over lines of amount * 2^64` ("identity E"; every
//! operation here keeps it). A line's virtual unpaid amount is never below its share of `U` because
//! every rounding of a line's unpaid amount goes up and `P` rounds up, so the lines' total unpaid
//! `V >= U` and so the lines' total ready `= sum(amount * 2^64) - V <= ready`. The slack `V - U`
//! is a few units of 2^-64 Gema and is released when the class is fully paid (`U == 0` starts a new
//! epoch, and every line of the old epoch is then ready in full, which is exactly right because
//! `U == 0` means nothing is owed). No separate bound is needed, and no reference to line values
//! is needed to prove a payout is covered.
//!
//! # Shares
//!
//! The spec asks for a per-line "S" sum. Liquity keeps `S` per (epoch, scale) in a map that grows
//! with every epoch; a fee class starts a new epoch each time it is paid in full, so that map
//! cannot be bounded. Instead each class pools its landed shares: a ready Gema of a class is worth
//! `shares / ready` of that class's pool. A slash lowers the value of every share and so of every
//! holder's ready equally, exactly as holders "carry a slash"; the only difference from a per-line
//! sum is that ready Gemas of one class share that class's average shares per ready Gema, across
//! landing times. Pools are per class, so Platform Gemas paid early keep their early price.

pub mod wide;

use super::line_store::{Line, CLASS_EXTENSION_BASE, CLASS_GENERAL};
use super::Key;
use wide::{mul_div_u128, mul_div_wide, Round, U256};

#[cfg(test)]
mod model;
#[cfg(test)]
mod tests;

/// Fixed-point fraction bits of Gemas.
pub const FP_BITS: u32 = 64;
/// One Gema in fixed point.
pub const FP_ONE: u128 = 1 << FP_BITS;
/// Index start of every epoch.
pub const P_ONE: u128 = 1 << 96;
/// Below this `P` is multiplied up by 2^`SCALE_BITS` and `scale` rises. Keeps `P` at 64 significant
/// bits or more, so one landing moves a line's unpaid amount by at most 2^-64 of itself.
pub const P_MIN: u128 = 1 << 64;
pub const SCALE_BITS: u32 = 32;
/// Fractional bits of share amounts.
pub const SHARE_BITS: u32 = 32;
/// Extension tranches a Source can have (Extend's limits keep a Position to at most 11).
pub const MAX_EXTENSIONS: u8 = 11;
/// Platform, Studio, Leaderboard, General and the Extensions.
pub const MAX_CLASSES: usize = CLASS_EXTENSION_BASE as usize + MAX_EXTENSIONS as usize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookError {
    /// Overflow or a result that does not fit its type.
    Math,
    /// A line's snapshot is ahead of its class: the line or the class is corrupt.
    BadSnapshot,
    NoSuchClass,
    TooManyExtensions,
    /// The two lines are of different classes, or of different Sources.
    ClassMismatch,
    ZeroAmount,
    NotEnoughAmount,
    NotEnoughReady,
    /// Stored numbers contradict each other (identity E failed).
    Corrupt(&'static str),
    /// A fee cut needs a playable source line and a fee-class destination.
    NotAFeeCut,
}

pub type BookResult<T> = Result<T, BookError>;

/// `amount` Gemas in fixed point.
pub fn fp(amount: u64) -> u128 {
    (amount as u128) << FP_BITS
}

/// Whole Gemas in a fixed-point value, rounded down.
pub fn fp_floor(v: u128) -> u64 {
    (v >> FP_BITS) as u64
}

/// Whole Gemas in a fixed-point value, rounded up (what is shown as "Left to pay back").
pub fn fp_ceil(v: u128) -> u128 {
    (v >> FP_BITS) + u128::from(v & (FP_ONE - 1) != 0)
}

/// One class of a Source: a pool of unpaid Gemas with its index, and a pool of repaid Gemas.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClassState {
    /// Product index within the epoch, `P_MIN` to `P_ONE` (or lower after a huge landing).
    pub p: u128,
    pub scale: u32,
    pub epoch: u32,
    /// Exact total unpaid Gemas of the class (Fp). "Left to pay back" is the sum over classes.
    pub uncovered: u128,
    /// Repaid Gemas not yet redeemed, returned or moved to another class (Fp). At least the sum of
    /// the lines' ready; equal when the class is fully paid.
    pub ready: u128,
    /// Staking-token shares backing `ready` (share fixed point).
    pub shares: u128,
}

impl ClassState {
    pub const fn fresh() -> ClassState {
        ClassState {
            p: P_ONE,
            scale: 0,
            epoch: 0,
            uncovered: 0,
            ready: 0,
            shares: 0,
        }
    }

    /// The line's unpaid amount now (Fp), rounded up. Does not change the line.
    pub fn view(&self, line: &Line) -> BookResult<u128> {
        if line.uncovered == 0 || line.epoch < self.epoch {
            return Ok(0);
        }
        if line.epoch > self.epoch || line.scale > self.scale || line.p == 0 {
            return Err(BookError::BadSnapshot);
        }
        let diff = self.scale - line.scale;
        if diff == 0 {
            if self.p == line.p {
                return Ok(line.uncovered);
            }
            if self.p > line.p {
                return Err(BookError::BadSnapshot);
            }
        }
        let q = mul_div_wide(line.uncovered, self.p, line.p, Round::Up).ok_or(BookError::Math)?;
        let q = q.shr(SCALE_BITS.saturating_mul(diff), Round::Up);
        let v = q.to_u128().ok_or(BookError::Math)?;
        if v > line.uncovered {
            return Err(BookError::BadSnapshot);
        }
        Ok(v)
    }

    /// Bring a line up to date at this class's index.
    pub fn materialise(&self, line: &mut Line) -> BookResult<()> {
        line.uncovered = self.view(line)?;
        line.p = self.p;
        line.scale = self.scale;
        line.epoch = self.epoch;
        Ok(())
    }

    /// Start a new epoch. Only when nothing is unpaid.
    fn reset(&mut self) -> BookResult<()> {
        debug_assert_eq!(self.uncovered, 0);
        self.epoch = self.epoch.checked_add(1).ok_or(BookError::Math)?;
        self.scale = 0;
        self.p = P_ONE;
        Ok(())
    }

    /// Called after `uncovered` fell from `before`: a class that just became empty starts a new
    /// epoch, which marks every older line fully repaid (nothing is owed, so that is exact).
    fn drained(&mut self, before: u128) -> BookResult<()> {
        if before > 0 && self.uncovered == 0 {
            self.reset()?;
        }
        Ok(())
    }

    /// Keep `P` at 64 significant bits or more before it is multiplied. A landing that left only a
    /// few units unpaid leaves `P` tiny; every line's value is unchanged by multiplying `P` by 2^32
    /// and counting one more scale, so this is exact and costs nothing.
    fn normalise(&mut self) -> BookResult<()> {
        while self.p < P_MIN {
            self.p <<= SCALE_BITS;
            self.scale = self.scale.checked_add(1).ok_or(BookError::Math)?;
        }
        Ok(())
    }

    /// Land `d` (`0 < d <= uncovered`) with its `shares`.
    fn land(&mut self, d: u128, shares: u128) -> BookResult<()> {
        let u = self.uncovered;
        debug_assert!(d > 0 && d <= u);
        self.ready = self.ready.checked_add(d).ok_or(BookError::Math)?;
        self.shares = self.shares.checked_add(shares).ok_or(BookError::Math)?;
        if d == u {
            self.uncovered = 0;
            return self.reset();
        }
        let rest = u - d;
        self.normalise()?;
        let n = U256::mul_wide(self.p, rest);
        let floor_bound = U256::mul_wide(P_MIN, u);
        if n < floor_bound {
            // P would fall below P_MIN: keep 32 more bits and count a scale
            let n = n.checked_shl(SCALE_BITS).ok_or(BookError::Math)?;
            let (q, r) = n.div_rem(u);
            let q = if r != 0 { q.checked_inc() } else { Some(q) };
            let p = q.and_then(|q| q.to_u128()).ok_or(BookError::Math)?;
            self.scale = self.scale.checked_add(1).ok_or(BookError::Math)?;
            self.p = p;
        } else {
            let (q, r) = n.div_rem(u);
            let q = if r != 0 { q.checked_inc() } else { Some(q) };
            self.p = q.and_then(|q| q.to_u128()).ok_or(BookError::Math)?;
        }
        self.uncovered = rest;
        Ok(())
    }
}

/// The bookkeeping of one Source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceBook {
    /// `H`: cumulative coverage ever landed (Fp). Only grows; the checkpoint for the next landing.
    pub h: u128,
    /// `R`: coverage released to the owner by `return_own` (Fp). `C = H - R`.
    pub r: u128,
    /// The owner's pocket: coverage no holder is owed (Fp), i.e. excess beyond everything unpaid,
    /// `return_own`'s released ready and rounding dust. The Position takes it as free yield.
    pub owner_fp: u128,
    /// Shares backing the owner's pocket (share fixed point).
    pub owner_shares: u128,
    /// Cumulative `owner_fp` the Position has taken, kept so the identity still closes.
    pub taken_fp: u128,
    /// Extension tranches started.
    pub n_ext: u8,
    pub classes: [ClassState; MAX_CLASSES],
}

/// What a landing did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Landing {
    /// New coverage landed (Fp), `0` if the computed figure did not pass `H`.
    pub delta: u128,
    /// Part of it that went to the owner because nothing was unpaid.
    pub excess: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Moved {
    /// Ready moved with the Gemas (Fp).
    pub ready: u128,
    /// Unpaid moved with the Gemas (Fp).
    pub uncovered: u128,
    /// Fixed-point remainder handed to the owner's pocket, at most 1.
    pub dust: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Redeemed {
    pub gemas: u64,
    /// Whole staking-token shares paid.
    pub shares: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Returned {
    /// Ready released to the owner (Fp).
    pub ready: u128,
    /// Unpaid Gemas cancelled (Fp): Left to pay back falls by exactly this. (A line's unpaid
    /// amount is rounded up, so the cancelled part of it can exceed the class total by a few
    /// units; the excess leaves the ready pool for the owner's pocket instead.)
    pub cancelled: u128,
    pub dust: u128,
}

impl Default for SourceBook {
    fn default() -> Self {
        Self::new()
    }
}

/// Is `class` one of the fee classes (never played, reserved or moved by a Player)?
pub fn is_fee_class(class: u8) -> bool {
    class < CLASS_GENERAL
}

impl SourceBook {
    pub const fn new() -> SourceBook {
        SourceBook {
            h: 0,
            r: 0,
            owner_fp: 0,
            owner_shares: 0,
            taken_fp: 0,
            n_ext: 0,
            classes: [ClassState::fresh(); MAX_CLASSES],
        }
    }

    /// Classes in use: the three fee classes, General and the started Extensions.
    pub fn class_count(&self) -> usize {
        CLASS_EXTENSION_BASE as usize + self.n_ext as usize
    }

    pub fn class(&self, class: u8) -> BookResult<&ClassState> {
        if (class as usize) < self.class_count() {
            Ok(&self.classes[class as usize])
        } else {
            Err(BookError::NoSuchClass)
        }
    }

    /// `C = H - R`: coverage that backs the remaining holders.
    pub fn net_coverage(&self) -> u128 {
        self.h - self.r.min(self.h)
    }

    /// Left to pay back, Fp.
    pub fn uncovered_total(&self) -> u128 {
        self.classes[..self.class_count()]
            .iter()
            .fold(0u128, |acc, c| acc.saturating_add(c.uncovered))
    }

    /// Ready not yet redeemed, returned or sold, over all classes (Fp).
    pub fn ready_total(&self) -> u128 {
        self.classes[..self.class_count()]
            .iter()
            .fold(0u128, |acc, c| acc.saturating_add(c.ready))
    }

    /// A zero line of this Source and class at the start of the class's epoch. Safe to hand to
    /// `transfer` or `issue`, which bring it up to date.
    pub fn blank_line(side: u8, due_at: i64, source: Key, class: u8, tranche: u8) -> Line {
        Line {
            side,
            class,
            tranche,
            due_at,
            source,
            amount: 0,
            uncovered: 0,
            p: P_ONE,
            scale: 0,
            epoch: 0,
            reserved: [0; 5],
        }
    }

    /// Start the next Extension tranche (Extend) and return its class number. The new class is
    /// junior to everything issued before.
    pub fn start_extension(&mut self) -> BookResult<u8> {
        if self.n_ext >= MAX_EXTENSIONS {
            return Err(BookError::TooManyExtensions);
        }
        self.n_ext += 1;
        Ok(CLASS_GENERAL + self.n_ext)
    }

    /// The line brought up to date (Fp unpaid, snapshot of its class). No change to the book.
    pub fn materialise(&self, line: &mut Line) -> BookResult<()> {
        self.class(line.class)?.materialise(line)
    }

    /// Unpaid Gemas of the line now (Fp), without changing it.
    pub fn uncovered_of(&self, line: &Line) -> BookResult<u128> {
        self.class(line.class)?.view(line)
    }

    /// Ready of the line now (Fp), without changing it.
    pub fn ready_of(&self, line: &Line) -> BookResult<u128> {
        let u = self.uncovered_of(line)?;
        fp(line.amount)
            .checked_sub(u)
            .ok_or(BookError::Corrupt("site1"))
    }

    /// Whole Gemas the line can Redeem now.
    pub fn redeemable(&self, line: &Line) -> BookResult<u64> {
        Ok(fp_floor(self.ready_of(line)?))
    }

    /// Staking-token shares `k` ready Gemas of `class` are worth now, whole shares rounded down.
    pub fn shares_for(&self, class: u8, k: u64) -> BookResult<u128> {
        let c = self.class(class)?;
        if k == 0 {
            return Ok(0);
        }
        if c.ready < fp(k) {
            return Err(BookError::NotEnoughReady);
        }
        let sh = mul_div_u128(c.shares, fp(k), c.ready, Round::Down).ok_or(BookError::Math)?;
        Ok(sh >> SHARE_BITS)
    }

    /// Add `k` freshly issued Gemas (all unpaid) to `line`: the Advance, and each Extend into its
    /// own tranche class. The caller has called [`SourceBook::start_extension`] for a new tranche.
    pub fn issue(&mut self, line: &mut Line, k: u64) -> BookResult<()> {
        if k == 0 {
            return Err(BookError::ZeroAmount);
        }
        let class = *self.class(line.class)?;
        let mut l = *line;
        class.materialise(&mut l)?;
        l.amount = l.amount.checked_add(k).ok_or(BookError::Math)?;
        l.uncovered = l.uncovered.checked_add(fp(k)).ok_or(BookError::Math)?;
        let mut c = class;
        c.uncovered = c.uncovered.checked_add(fp(k)).ok_or(BookError::Math)?;
        self.classes[line.class as usize] = c;
        *line = l;
        Ok(())
    }

    /// The new coverage a computed cumulative figure would land.
    pub fn pending(&self, computed_cumulative: u128) -> u128 {
        computed_cumulative.saturating_sub(self.h)
    }

    /// Land the coverage the Source has earned since `H`, paying classes in order. `shares` is the
    /// staking-token value of exactly `pending(computed_cumulative)` (share fixed point). A figure
    /// not above `H` lands nothing (coverage is a high-water mark).
    pub fn land(&mut self, computed_cumulative: u128, shares: u128) -> BookResult<Landing> {
        let delta = self.pending(computed_cumulative);
        if delta == 0 {
            return Ok(Landing::default());
        }
        let n = self.class_count();
        let mut next = self.classes;
        let mut rest = delta;
        let mut shares_left = shares;
        for c in next[..n].iter_mut() {
            if rest == 0 {
                break;
            }
            let d = rest.min(c.uncovered);
            if d == 0 {
                continue;
            }
            let sh = mul_div_u128(shares, d, delta, Round::Down).ok_or(BookError::Math)?;
            c.land(d, sh)?;
            rest -= d;
            shares_left -= sh;
        }
        let owner_fp = self.owner_fp.checked_add(rest).ok_or(BookError::Math)?;
        let owner_shares = self
            .owner_shares
            .checked_add(shares_left)
            .ok_or(BookError::Math)?;
        self.classes = next;
        self.h = computed_cumulative;
        self.owner_fp = owner_fp;
        self.owner_shares = owner_shares;
        Ok(Landing {
            delta,
            excess: rest,
        })
    }

    /// Split `k` of a materialised line into the part that moves and the part that stays, by the
    /// one proportional rule used for every move: `moved ready = floor(k * ready / amount)`, the
    /// rest of the moved Gemas is unpaid, and what stays is the floor of its proportional ready.
    /// The at most one fixed-point unit lost between the two floors is `dust`.
    fn split(line: &Line, k: u64) -> BookResult<Split> {
        let a = line.amount as u128;
        let rho = fp(line.amount)
            .checked_sub(line.uncovered)
            .ok_or(BookError::Corrupt("site2"))?;
        // rho * k = q * a + r. The mover gets floor = q; what stays is floor(rho * (a - k) / a)
        // = rho - q - (r != 0), so the two floors lose one unit exactly when r != 0.
        let (q, r) = U256::mul_wide(rho, k as u128).div_rem(a);
        let ready = q.to_u128().ok_or(BookError::Math)?;
        let dust = u128::from(r != 0);
        let kept_ready = rho
            .checked_sub(ready)
            .and_then(|v| v.checked_sub(dust))
            .ok_or(BookError::Corrupt("site3"))?;
        let stay = a - k as u128;
        let kept_unpaid = (stay << FP_BITS)
            .checked_sub(kept_ready)
            .ok_or(BookError::Corrupt("site4"))?;
        let moved_unpaid = fp(k)
            .checked_sub(ready)
            .ok_or(BookError::Corrupt("site5"))?;
        Ok(Split {
            ready,
            moved_unpaid,
            kept_unpaid,
            removed_unpaid: line
                .uncovered
                .checked_sub(kept_unpaid)
                .ok_or(BookError::Corrupt("site6"))?,
            dust,
        })
    }

    /// Move `k` Gemas of one class and Source from `src` to `dst`, with their proportional ready
    /// (Pot entry, refund, payout, Backing, Treasury purchase, merge into an existing line). Both
    /// lines are brought up to date first. The class never changes.
    pub fn transfer(&mut self, src: &mut Line, dst: &mut Line, k: u64) -> BookResult<Moved> {
        if src.class != dst.class || src.source != dst.source {
            return Err(BookError::ClassMismatch);
        }
        if k == 0 {
            return Err(BookError::ZeroAmount);
        }
        if k > src.amount {
            return Err(BookError::NotEnoughAmount);
        }
        let mut c = *self.class(src.class)?;
        let (mut s, mut d) = (*src, *dst);
        c.materialise(&mut s)?;
        c.materialise(&mut d)?;
        let sp = Self::split(&s, k)?;
        let mut owner_fp = self.owner_fp;
        let mut owner_shares = self.owner_shares;
        if sp.dust > 0 {
            // the dust becomes unpaid again (it cannot go to either side without one of them
            // showing more ready than the exact rule) and its coverage goes to the owner
            let sh = Self::pool_shares(&c, sp.dust)?;
            c.uncovered = c.uncovered.checked_add(sp.dust).ok_or(BookError::Math)?;
            c.ready -= sp.dust;
            c.shares -= sh;
            owner_fp = owner_fp.checked_add(sp.dust).ok_or(BookError::Math)?;
            owner_shares = owner_shares.checked_add(sh).ok_or(BookError::Math)?;
        }
        Self::sweep(&mut c, &mut owner_shares)?;
        s.amount -= k;
        s.uncovered = sp.kept_unpaid;
        d.amount = d.amount.checked_add(k).ok_or(BookError::Math)?;
        d.uncovered = d
            .uncovered
            .checked_add(sp.moved_unpaid)
            .ok_or(BookError::Math)?;
        self.classes[src.class as usize] = c;
        self.owner_fp = owner_fp;
        self.owner_shares = owner_shares;
        *src = s;
        *dst = d;
        Ok(Moved {
            ready: sp.ready,
            uncovered: sp.moved_unpaid,
            dust: sp.dust,
        })
    }

    /// A fee cut: move `k` Gemas of a playable `src` line into the fee-class line `dst` of the same
    /// Source. The ready part moves with them (and its shares); the unpaid part becomes senior,
    /// which is the only way a Gema changes class.
    pub fn cut_fee(&mut self, src: &mut Line, dst: &mut Line, k: u64) -> BookResult<Moved> {
        if is_fee_class(src.class) || !is_fee_class(dst.class) || src.source != dst.source {
            return Err(BookError::NotAFeeCut);
        }
        if k == 0 {
            return Err(BookError::ZeroAmount);
        }
        if k > src.amount {
            return Err(BookError::NotEnoughAmount);
        }
        let mut ca = *self.class(src.class)?;
        let mut cb = *self.class(dst.class)?;
        let (mut s, mut d) = (*src, *dst);
        ca.materialise(&mut s)?;
        cb.materialise(&mut d)?;
        let sp = Self::split(&s, k)?;
        let leaving = sp.ready.checked_add(sp.dust).ok_or(BookError::Math)?;
        if ca.ready < leaving {
            return Err(BookError::Corrupt("site7"));
        }
        let x_ready = Self::pool_shares(&ca, sp.ready)?;
        let x_dust = Self::pool_shares(&ca, sp.dust)?;
        ca.ready -= leaving;
        ca.shares -= x_ready + x_dust;
        // the moved unpaid is the removed unpaid plus the dust that turns back into unpaid
        cb.uncovered = cb
            .uncovered
            .checked_add(sp.moved_unpaid)
            .ok_or(BookError::Math)?;
        cb.ready = cb.ready.checked_add(sp.ready).ok_or(BookError::Math)?;
        cb.shares = cb.shares.checked_add(x_ready).ok_or(BookError::Math)?;
        let mut owner_fp = self.owner_fp.checked_add(sp.dust).ok_or(BookError::Math)?;
        let mut owner_shares = self
            .owner_shares
            .checked_add(x_dust)
            .ok_or(BookError::Math)?;
        Self::shed(&mut ca, sp.removed_unpaid, &mut owner_fp, &mut owner_shares)?;
        Self::sweep(&mut ca, &mut owner_shares)?;
        s.amount -= k;
        s.uncovered = sp.kept_unpaid;
        d.amount = d.amount.checked_add(k).ok_or(BookError::Math)?;
        d.uncovered = d
            .uncovered
            .checked_add(sp.moved_unpaid)
            .ok_or(BookError::Math)?;
        self.classes[src.class as usize] = ca;
        self.classes[dst.class as usize] = cb;
        self.owner_fp = owner_fp;
        self.owner_shares = owner_shares;
        *src = s;
        *dst = d;
        Ok(Moved {
            ready: sp.ready,
            uncovered: sp.moved_unpaid,
            dust: sp.dust,
        })
    }

    /// Pay out `k` whole ready Gemas of `line` (Redeem, fee cash-in, prize-free Treasury sales of
    /// ready Gemas): the Gemas leave and the line's pool share of staking-token shares is paid.
    pub fn redeem(&mut self, line: &mut Line, k: u64) -> BookResult<Redeemed> {
        if k == 0 {
            return Err(BookError::ZeroAmount);
        }
        let mut c = *self.class(line.class)?;
        let mut l = *line;
        c.materialise(&mut l)?;
        let ready = fp(l.amount)
            .checked_sub(l.uncovered)
            .ok_or(BookError::Corrupt("site9"))?;
        if k > l.amount || fp(k) > ready {
            return Err(BookError::NotEnoughReady);
        }
        if c.ready < fp(k) {
            return Err(BookError::Corrupt("site10"));
        }
        let paid = mul_div_u128(c.shares, fp(k), c.ready, Round::Down).ok_or(BookError::Math)?
            >> SHARE_BITS;
        l.amount -= k;
        c.ready -= fp(k);
        c.shares -= paid << SHARE_BITS;
        let mut owner_shares = self.owner_shares;
        Self::sweep(&mut c, &mut owner_shares)?;
        self.classes[line.class as usize] = c;
        self.owner_shares = owner_shares;
        *line = l;
        Ok(Redeemed {
            gemas: k,
            shares: paid,
        })
    }

    /// `return_own`: the owner takes `k` of their own Gemas out of the Source. The proportional
    /// ready part goes to the owner's pocket (and `R`), the rest is unpaid Debt that is cancelled.
    pub fn return_own(&mut self, line: &mut Line, k: u64) -> BookResult<Returned> {
        if k == 0 {
            return Err(BookError::ZeroAmount);
        }
        if k > line.amount {
            return Err(BookError::NotEnoughAmount);
        }
        let mut c = *self.class(line.class)?;
        let mut l = *line;
        c.materialise(&mut l)?;
        let sp = Self::split(&l, k)?;
        let leaving = sp.ready.checked_add(sp.dust).ok_or(BookError::Math)?;
        if c.ready < leaving {
            return Err(BookError::Corrupt("site11"));
        }
        let x_ready = Self::pool_shares(&c, sp.ready)?;
        let x_dust = Self::pool_shares(&c, sp.dust)?;
        c.ready -= leaving;
        c.shares -= x_ready + x_dust;
        let r = self.r.checked_add(sp.ready).ok_or(BookError::Math)?;
        let mut owner_fp = self.owner_fp.checked_add(leaving).ok_or(BookError::Math)?;
        let mut owner_shares = self
            .owner_shares
            .checked_add(x_ready + x_dust)
            .ok_or(BookError::Math)?;
        let cancelled = Self::shed(&mut c, sp.removed_unpaid, &mut owner_fp, &mut owner_shares)?;
        Self::sweep(&mut c, &mut owner_shares)?;
        l.amount -= k;
        l.uncovered = sp.kept_unpaid;
        self.classes[line.class as usize] = c;
        self.r = r;
        self.owner_fp = owner_fp;
        self.owner_shares = owner_shares;
        *line = l;
        Ok(Returned {
            ready: sp.ready,
            cancelled,
            dust: sp.dust,
        })
    }

    /// The Position takes the owner's pocket as free yield. Returns the Fp and the shares.
    pub fn take_owner_pocket(&mut self) -> BookResult<(u128, u128)> {
        let (fp_v, sh) = (self.owner_fp, self.owner_shares);
        self.taken_fp = self.taken_fp.checked_add(fp_v).ok_or(BookError::Math)?;
        self.owner_fp = 0;
        self.owner_shares = 0;
        Ok((fp_v, sh))
    }

    /// The identity that must hold after every operation, given the whole Gemas the Source has
    /// redeemed and every line of it that exists (`lines`). Used by tests and debug assertions.
    ///
    /// * per class: `ready + uncovered == sum(amount) * 2^64` (identity E);
    /// * `H == sum(ready) + redeemed * 2^64 + owner pocket + taken`.
    pub fn check<'a>(
        &self,
        redeemed: u64,
        lines: impl Iterator<Item = &'a Line>,
    ) -> Result<(), &'static str> {
        let mut per_class = [0u128; MAX_CLASSES];
        for l in lines {
            let slot = per_class
                .get_mut(l.class as usize)
                .ok_or("line of an unknown class")?;
            *slot = slot
                .checked_add(fp(l.amount))
                .ok_or("sum of amounts overflows")?;
        }
        for (i, c) in self.classes[..self.class_count()].iter().enumerate() {
            if c.ready.checked_add(c.uncovered) != Some(per_class[i]) {
                return Err("identity E: ready + uncovered != sum of line amounts");
            }
        }
        let rhs = self
            .ready_total()
            .checked_add(fp(redeemed))
            .and_then(|v| v.checked_add(self.owner_fp))
            .and_then(|v| v.checked_add(self.taken_fp))
            .ok_or("overflow")?;
        if self.h != rhs {
            return Err("H != ready + redeemed + owner pocket + taken");
        }
        if self.r > self.h {
            return Err("R > H");
        }
        Ok(())
    }

    /// Shares of `amount` ready of the pool of `c`, rounded down.
    fn pool_shares(c: &ClassState, amount: u128) -> BookResult<u128> {
        if amount == 0 {
            return Ok(0);
        }
        if c.ready == 0 || amount > c.ready {
            return Err(BookError::Corrupt("site13"));
        }
        mul_div_u128(c.shares, amount, c.ready, Round::Down).ok_or(BookError::Math)
    }

    /// Take `removed` unpaid Gemas of a line out of its class (cancelled by `return_own`, or cut
    /// from the line as a fee). The line's unpaid amount was rounded up when it was brought up to
    /// date, so it can exceed the class's exact total by a few fixed-point units; that excess
    /// has no unpaid Gema to leave and instead comes out of the class's ready pool (it was
    /// coverage the lines could not claim) into the owner's pocket. A class left with nothing unpaid
    /// starts a new epoch.
    fn shed(
        c: &mut ClassState,
        removed: u128,
        owner_fp: &mut u128,
        owner_shares: &mut u128,
    ) -> BookResult<u128> {
        let before = c.uncovered;
        let from_unpaid = removed.min(before);
        let slack = removed - from_unpaid;
        c.uncovered = before - from_unpaid;
        if slack > 0 {
            let sh = Self::pool_shares(c, slack)?;
            c.ready -= slack;
            c.shares -= sh;
            *owner_fp = owner_fp.checked_add(slack).ok_or(BookError::Math)?;
            *owner_shares = owner_shares.checked_add(sh).ok_or(BookError::Math)?;
        }
        c.drained(before)?;
        Ok(from_unpaid)
    }

    /// With no ready left the pool's shares belong to nobody: they go to the owner's pocket.
    fn sweep(c: &mut ClassState, owner_shares: &mut u128) -> BookResult<()> {
        if c.ready == 0 && c.shares != 0 {
            *owner_shares = owner_shares.checked_add(c.shares).ok_or(BookError::Math)?;
            c.shares = 0;
        }
        Ok(())
    }

    /// Size of the encoded book with `n_ext` Extensions.
    pub const fn encoded_len(n_ext: u8) -> usize {
        BOOK_FIXED_LEN + (CLASS_EXTENSION_BASE as usize + n_ext as usize) * CLASS_LEN
    }

    /// Write the book (little endian, only the classes in use) into `out`.
    pub fn encode(&self, out: &mut [u8]) -> BookResult<()> {
        let len = Self::encoded_len(self.n_ext);
        if out.len() < len {
            return Err(BookError::Math);
        }
        out[..len].fill(0);
        out[0..16].copy_from_slice(&self.h.to_le_bytes());
        out[16..32].copy_from_slice(&self.r.to_le_bytes());
        out[32..48].copy_from_slice(&self.owner_fp.to_le_bytes());
        out[48..64].copy_from_slice(&self.owner_shares.to_le_bytes());
        out[64..80].copy_from_slice(&self.taken_fp.to_le_bytes());
        out[80] = self.n_ext;
        for (i, c) in self.classes[..self.class_count()].iter().enumerate() {
            let at = BOOK_FIXED_LEN + i * CLASS_LEN;
            out[at..at + 16].copy_from_slice(&c.p.to_le_bytes());
            out[at + 16..at + 32].copy_from_slice(&c.uncovered.to_le_bytes());
            out[at + 32..at + 48].copy_from_slice(&c.ready.to_le_bytes());
            out[at + 48..at + 64].copy_from_slice(&c.shares.to_le_bytes());
            out[at + 64..at + 68].copy_from_slice(&c.scale.to_le_bytes());
            out[at + 68..at + 72].copy_from_slice(&c.epoch.to_le_bytes());
        }
        Ok(())
    }

    pub fn decode(raw: &[u8]) -> BookResult<SourceBook> {
        if raw.len() < BOOK_FIXED_LEN {
            return Err(BookError::Math);
        }
        let n_ext = raw[80];
        if n_ext > MAX_EXTENSIONS || raw.len() < Self::encoded_len(n_ext) {
            return Err(BookError::TooManyExtensions);
        }
        let mut book = SourceBook::new();
        book.h = u128_at(raw, 0);
        book.r = u128_at(raw, 16);
        book.owner_fp = u128_at(raw, 32);
        book.owner_shares = u128_at(raw, 48);
        book.taken_fp = u128_at(raw, 64);
        book.n_ext = n_ext;
        for i in 0..book.class_count() {
            let at = BOOK_FIXED_LEN + i * CLASS_LEN;
            book.classes[i] = ClassState {
                p: u128_at(raw, at),
                uncovered: u128_at(raw, at + 16),
                ready: u128_at(raw, at + 32),
                shares: u128_at(raw, at + 48),
                scale: u32_at(raw, at + 64),
                epoch: u32_at(raw, at + 68),
            };
            if book.classes[i].p == 0 {
                return Err(BookError::BadSnapshot);
            }
        }
        Ok(book)
    }
}

pub const BOOK_FIXED_LEN: usize = 81;
pub const CLASS_LEN: usize = 72;

fn u128_at(raw: &[u8], at: usize) -> u128 {
    let mut b = [0u8; 16];
    b.copy_from_slice(&raw[at..at + 16]);
    u128::from_le_bytes(b)
}

fn u32_at(raw: &[u8], at: usize) -> u32 {
    let mut b = [0u8; 4];
    b.copy_from_slice(&raw[at..at + 4]);
    u32::from_le_bytes(b)
}

/// Result of [`SourceBook::split`].
struct Split {
    ready: u128,
    moved_unpaid: u128,
    kept_unpaid: u128,
    removed_unpaid: u128,
    dust: u128,
}

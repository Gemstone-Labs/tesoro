//! Exact bookkeeping of a Source's Gemas (spec "Ledger: exact bookkeeping", tickets 03 and 03b).
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
//! that shrinks every line's unpaid share without enumerating holders, `s` is the matching share
//! sum, and `ready`/`shares` is the pool of repaid Gemas and the staking-token shares that back
//! them.
//!
//! * A line stores `(amount, uncovered)` as of its snapshot `(p, scale, epoch, ck, s_snap)`. Its
//!   current unpaid amount is `ceil(uncovered * P / p_snapshot / 2^(32 * scale diff))`, and zero if
//!   the class's epoch moved on (the class was paid in full). Ready is `amount * 2^64 - uncovered`.
//! * Landing coverage `D` with shares `q` into a class with weight `W` (see below) and unpaid
//!   total `U`: `D >= U` pays it in full and starts a new epoch; otherwise `P` becomes
//!   `ceil(P * (W - D) / W)` (rescaled by 2^32 when it would fall below `P_MIN`) and
//!   `S += floor(q * P * 2^64 / W)` with the pre-landing `P`.
//!
//! # Why the sum of ready never exceeds what landed
//!
//! Per class, exactly: `ready + U = sum over lines of amount * 2^64` ("identity E"; every
//! operation here keeps it). A line's unpaid amount is only ever rounded up, so the lines' virtual
//! total `V >= U`, so the lines' total ready `= sum(amount * 2^64) - V <= ready`. The slack
//! `V - U` is a few units of 2^-64 Gema and is released when the class is fully paid (`U == 0`
//! starts a new epoch, and every line of the old epoch is then ready in full, which is exactly
//! right because nothing is owed).
//!
//! # Why the sum of shares never exceeds what landed (ticket 03b)
//!
//! Each line owns the shares it has earned: `banked + uncovered * (S - s_snap) / p` plus the closed
//! segments' terms. Per landing the lines earn `sum_i u_i * dS / p_i = V * q / W` (all weights taken
//! at the landing's index; `V` is the *unrounded* sum of the lines' indexed unpaid amounts, not the
//! sum of their rounded-up views). The index and the share sum use the *weight* `W`, not `U`: a
//! conservative upper bound of `V`, kept as `W = U + Z` where `Z` grows by one unit per rounded-up
//! line touch and by `W / P` per landing (the rounding of `P`), and shrinks with the lines that
//! leave. Since `V <= W`, `V * q / W <= q`: the lines never earn more shares than landed, whatever
//! the rounding. The price is the stranded `q * (1 - V / W)` per landing, which stays in
//! `class.shares` unclaimed: a relative 2^-64 per landing while the class is large, but in the
//! last ulps of an epoch (`W` a handful of ulps) one rounded-up touch or inexact index step
//! misallocates or strands up to the shares of that landing, which the supported domain bounds
//! (`SHARES_PER_ULP_BITS`): a few hundred base units at the limit, far below one at real rates.
//! `W >= U >= 0` always, so the P update `P * (W - D) / W` keeps `V' >= U - D` too (the ready
//! argument above is unchanged).
//!
//! # History
//!
//! `S` restarts from zero when the index changes scale or a new epoch begins. The value a closed
//! segment ended on is written once to an append-only checkpoint list (see [`checkpoint`]) and
//! never dropped, so a dormant line can always finish catching up from the segment it was last
//! touched in, reading only the records of its own epoch.
//!
//! # Single-holder fee classes
//!
//! Platform and Leaderboard classes each have exactly one line, the Source's counter. Their shares
//! stay pooled in the class (`shares / ready`), which for one holder is exactly the holder's own
//! history. This is only exact while the Source really holds a single line of that class: the
//! instruction layer must keep it in the Source account (never in a basket) and never create a
//! second one.

pub mod checkpoint;
pub mod wide;

use super::line_store::{
    Line, CLASS_EXTENSION_BASE, CLASS_GENERAL, CLASS_LEADERBOARD, CLASS_PLATFORM,
};
use super::Key;
use checkpoint::{Checkpoint, CheckpointStore};
use wide::{
    div_rem_limbs, limbs_to_u128, limbs_to_u256, mul_div_u128, mul_u128_u256, shr_limbs, Round,
    U256,
};

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
/// Extra fractional bits of the share sum, so one landing's rounding is below one share unit for
/// every line.
pub const S_FRAC_BITS: u32 = 64;
/// A line's share catch-up reads at most this many segments of its epoch: after ten scale steps
/// every later term is exactly zero, however many more segments the epoch has.
pub const MAX_CATCHUP_SCALE_STEPS: u32 = 10;
/// Largest supported ratio of shares landed to coverage landed: `2^40` share units (2^-32 of a
/// base unit) per unit of 2^-64 Gema, i.e. 2^72 base units of the staking token per Gema. Real
/// Sources are many orders below (a Gema is $0.01); the bound keeps every share-sum increment
/// below 2^200 so the u256 sum cannot overflow, and keeps the weight slack's share error below one
/// base unit.
pub const SHARES_PER_ULP_BITS: u32 = 40;
/// Extension tranches a Source can have (Extend's limits keep a Position to at most 11).
pub const MAX_EXTENSIONS: u8 = 11;
/// Platform, Studio, Leaderboard, General and the Extensions.
pub const MAX_CLASSES: usize = CLASS_EXTENSION_BASE as usize + MAX_EXTENSIONS as usize;
/// Format version of the encoded book.
pub const BOOK_VERSION: u8 = 2;

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
    /// A line needs a checkpoint record the store does not have.
    MissingCheckpoint,
    /// A checkpoint record or page is malformed.
    BadCheckpoint,
    /// The class's counters (epoch, scale or segment number) are about to overflow.
    CounterExhausted,
    /// Only the pooled fee classes (Platform, Leaderboard) answer this.
    NotPooled,
    /// More shares than `2^SHARES_PER_ULP_BITS` per unit of coverage landed.
    SharesOutOfRange,
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

/// Does the class keep an exact share sum (true), or one pool of shares for its single holder?
pub const fn is_exact_class(class: u8) -> bool {
    class != CLASS_PLATFORM && class != CLASS_LEADERBOARD
}

/// Is `class` one of the fee classes (never played, reserved or moved by a Player)?
pub fn is_fee_class(class: u8) -> bool {
    class < CLASS_GENERAL
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
    /// Staking-token shares backing the class (share fixed point): everything landed into it and
    /// not yet paid out or moved. At least what its lines own, including what they have earned and
    /// not yet banked; the difference is the stranded rounding.
    pub shares: u128,
    /// Upper bound of the lines' virtual unpaid total (Fp), at least `uncovered`.
    pub w: u128,
    /// Share sum of the current segment, with `S_FRAC_BITS` extra fractional bits.
    pub s: U256,
    /// Segments closed so far (also the number of the open one).
    pub ck: u32,
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
            w: 0,
            s: U256::ZERO,
            ck: 0,
        }
    }

    /// The line's unpaid amount now (Fp), rounded up, and whether the rounding added anything.
    pub fn view_exact(&self, line: &Line) -> BookResult<(u128, bool)> {
        if line.uncovered == 0 || line.epoch < self.epoch {
            return Ok((0, false));
        }
        if line.epoch > self.epoch || line.scale > self.scale || line.p == 0 {
            return Err(BookError::BadSnapshot);
        }
        let diff = self.scale - line.scale;
        if diff == 0 {
            if self.p == line.p {
                return Ok((line.uncovered, false));
            }
            if self.p > line.p {
                return Err(BookError::BadSnapshot);
            }
        }
        let n = U256::mul_wide(line.uncovered, self.p);
        let (q, r) = n.div_rem(line.p);
        let bits = SCALE_BITS.saturating_mul(diff);
        // ceil(ceil(n / p) / 2^bits) = ceil(n / (p * 2^bits)); it differs from the floor exactly
        // when the rounding added something
        let down = q.shr(bits, Round::Down);
        let qu = if r != 0 {
            q.checked_inc().ok_or(BookError::Math)?
        } else {
            q
        };
        let up = qu.shr(bits, Round::Up);
        let v = up.to_u128().ok_or(BookError::Math)?;
        if v > line.uncovered {
            return Err(BookError::BadSnapshot);
        }
        Ok((v, up != down))
    }

    /// The line's unpaid amount now (Fp), rounded up. Does not change the line.
    pub fn view(&self, line: &Line) -> BookResult<u128> {
        Ok(self.view_exact(line)?.0)
    }

    /// Shares the line has earned since its snapshot and not yet banked (share fixed point),
    /// rounded down. Walks the closed segments from the line's own to the end of its epoch, or to
    /// the open segment.
    pub fn gain<C: CheckpointStore + ?Sized>(
        &self,
        id: u8,
        line: &Line,
        ck: &C,
    ) -> BookResult<u128> {
        if !is_exact_class(id) || line.uncovered == 0 {
            return Ok(0);
        }
        if line.p == 0 || line.ck > self.ck {
            return Err(BookError::BadSnapshot);
        }
        let mut total: u128 = 0;
        let mut j = line.ck;
        let mut s_start = line.s_snap;
        let mut prev_scale = line.scale;
        loop {
            let (s_end, scale_j, last) = if j == self.ck {
                if self.epoch != line.epoch {
                    return Err(BookError::BadSnapshot);
                }
                (self.s, self.scale, true)
            } else {
                let rec = ck.get(id, j).ok_or(BookError::MissingCheckpoint)?;
                if rec.epoch != line.epoch {
                    return Err(BookError::BadCheckpoint);
                }
                (rec.s_end, rec.scale, rec.ends_epoch)
            };
            if scale_j < line.scale {
                return Err(BookError::BadSnapshot);
            }
            if j != line.ck && scale_j <= prev_scale {
                // within one epoch every closed segment runs at a higher scale than the last
                return Err(BookError::BadCheckpoint);
            }
            prev_scale = scale_j;
            let steps = scale_j - line.scale;
            if steps >= MAX_CATCHUP_SCALE_STEPS {
                // u < 2^128 and dS < 2^256 (see `s_increment`), p >= 1 and the divisor has at
                // least 2^(32 * 10 + 64) = 2^384: this term and every later one is exactly 0
                return Ok(total);
            }
            let ds = s_end.checked_sub(&s_start).ok_or(BookError::BadSnapshot)?;
            if !ds.is_zero() {
                // u * dS / (p * 2^(32 * scale steps + 64)), rounded down, in floors that compose
                let prod = mul_u128_u256(line.uncovered, &ds);
                let (q, _) = div_rem_limbs(&prod, line.p);
                let q = shr_limbs(
                    &q,
                    SCALE_BITS.saturating_mul(steps).saturating_add(S_FRAC_BITS),
                    Round::Down,
                );
                let term = limbs_to_u128(&q).ok_or(BookError::Math)?;
                total = total.checked_add(term).ok_or(BookError::Math)?;
            }
            if last {
                return Ok(total);
            }
            j += 1;
            s_start = U256::ZERO;
        }
    }

    /// Bring a line up to date at this class's index: bank the shares it earned, move its snapshot
    /// to now, and charge the class's weight for any rounding up of the unpaid amount.
    pub fn touch<C: CheckpointStore + ?Sized>(
        &mut self,
        id: u8,
        line: &mut Line,
        ck: &C,
    ) -> BookResult<()> {
        let (u, inexact) = self.view_exact(line)?;
        let gain = self.gain(id, line, ck)?;
        let shares = line.shares.checked_add(gain).ok_or(BookError::Math)?;
        if inexact {
            self.w = self.w.checked_add(1).ok_or(BookError::Math)?;
        }
        line.shares = shares;
        line.uncovered = u;
        line.p = self.p;
        line.scale = self.scale;
        line.epoch = self.epoch;
        line.ck = self.ck;
        line.s_snap = self.s;
        Ok(())
    }

    fn headroom(&self) -> bool {
        self.epoch < u32::MAX - 1 && self.scale < u32::MAX - 4 && self.ck < u32::MAX - 4
    }

    /// Close the current segment, writing its record, and open the next one.
    fn close_segment<C: CheckpointStore + ?Sized>(
        &mut self,
        id: u8,
        ends_epoch: bool,
        ck: &mut C,
    ) -> BookResult<()> {
        if is_exact_class(id) {
            ck.push(
                id,
                self.ck,
                Checkpoint {
                    epoch: self.epoch,
                    scale: self.scale,
                    ends_epoch,
                    s_end: self.s,
                },
            )?;
            self.ck = self.ck.checked_add(1).ok_or(BookError::CounterExhausted)?;
        }
        self.s = U256::ZERO;
        Ok(())
    }

    /// Start a new epoch. Only when nothing is unpaid.
    fn reset<C: CheckpointStore + ?Sized>(&mut self, id: u8, ck: &mut C) -> BookResult<()> {
        debug_assert_eq!(self.uncovered, 0);
        let epoch = self
            .epoch
            .checked_add(1)
            .ok_or(BookError::CounterExhausted)?;
        self.close_segment(id, true, ck)?;
        self.epoch = epoch;
        self.scale = 0;
        self.p = P_ONE;
        self.w = 0;
        Ok(())
    }

    /// Called after `uncovered` fell from `before`: a class that just became empty starts a new
    /// epoch, which marks every older line fully repaid (nothing is owed, so that is exact).
    fn drained<C: CheckpointStore + ?Sized>(
        &mut self,
        id: u8,
        before: u128,
        ck: &mut C,
    ) -> BookResult<()> {
        if before > 0 && self.uncovered == 0 {
            self.reset(id, ck)?;
        }
        Ok(())
    }

    /// Keep `P` at 64 significant bits or more before it is multiplied. A landing that left only a
    /// few units unpaid leaves `P` tiny; every line's value is unchanged by multiplying `P` by 2^32
    /// and counting one more scale, so this is exact; the share sum starts its next segment.
    fn normalise<C: CheckpointStore + ?Sized>(&mut self, id: u8, ck: &mut C) -> BookResult<()> {
        while self.p < P_MIN {
            self.close_segment(id, false, ck)?;
            self.p <<= SCALE_BITS;
            self.scale = self
                .scale
                .checked_add(1)
                .ok_or(BookError::CounterExhausted)?;
        }
        Ok(())
    }

    /// `floor(q * P * 2^64 / W)`: what one landing adds to the share sum.
    fn s_increment(&self, q: u128) -> BookResult<U256> {
        if q == 0 {
            return Ok(U256::ZERO);
        }
        if self.w == 0 {
            return Err(BookError::Corrupt("w0"));
        }
        let prod = U256::mul_wide(q, self.p);
        // times 2^64 is one limb up
        let n = [0, prod.0[0], prod.0[1], prod.0[2], prod.0[3]];
        let (quot, _) = div_rem_limbs(&n, self.w);
        limbs_to_u256(&quot).ok_or(BookError::Math)
    }

    /// Land `d` (`0 < d <= uncovered`) with its `q` shares.
    fn land<C: CheckpointStore + ?Sized>(
        &mut self,
        id: u8,
        d: u128,
        q: u128,
        ck: &mut C,
    ) -> BookResult<()> {
        let exact = is_exact_class(id);
        let u = self.uncovered;
        debug_assert!(d > 0 && d <= u && self.w >= u);
        self.ready = self.ready.checked_add(d).ok_or(BookError::Math)?;
        self.shares = self.shares.checked_add(q).ok_or(BookError::Math)?;
        if d == u {
            if exact {
                let inc = self.s_increment(q)?;
                self.s = self.s.checked_add(&inc).ok_or(BookError::Math)?;
            }
            self.uncovered = 0;
            return self.reset(id, ck);
        }
        self.normalise(id, ck)?;
        let w = self.w;
        let rest = w - d;
        if exact {
            let inc = self.s_increment(q)?;
            self.s = self.s.checked_add(&inc).ok_or(BookError::Math)?;
        }
        let n = U256::mul_wide(self.p, rest);
        let floor_bound = U256::mul_wide(P_MIN, w);
        let (new_p, extra, rescale) = if n < floor_bound {
            // P would fall below P_MIN: keep 32 more bits and count a scale
            let shifted = n.checked_shl(SCALE_BITS).ok_or(BookError::Math)?;
            let (qt, r) = shifted.div_rem(w);
            let qt = if r != 0 { qt.checked_inc() } else { Some(qt) };
            let p = qt.and_then(|v| v.to_u128()).ok_or(BookError::Math)?;
            // an inexact P moves the lines' total by less than w / (P * 2^32); an exact one by 0
            let extra = if r == 0 {
                0
            } else {
                let once = w / self.p + u128::from(!w.is_multiple_of(self.p));
                (once >> SCALE_BITS) + u128::from(once & 0xFFFF_FFFF != 0)
            };
            (p, extra, true)
        } else {
            let (qt, r) = n.div_rem(w);
            let qt = if r != 0 { qt.checked_inc() } else { Some(qt) };
            let p = qt.and_then(|v| v.to_u128()).ok_or(BookError::Math)?;
            // an inexact P moves the lines' total by less than w / P; an exact one by 0
            let extra = if r == 0 {
                0
            } else {
                w / self.p + u128::from(!w.is_multiple_of(self.p))
            };
            (p, extra, false)
        };
        if rescale {
            self.close_segment(id, false, ck)?;
            self.scale = self
                .scale
                .checked_add(1)
                .ok_or(BookError::CounterExhausted)?;
        }
        self.p = new_p;
        self.w = rest.checked_add(extra).ok_or(BookError::Math)?;
        self.uncovered = u - d;
        Ok(())
    }
}

/// Where a book keeps its classes: an array in memory ([`ClassArray`]) or the bytes of a Source
/// account ([`ClassBytes`]), which decodes only the classes an operation touches.
pub trait ClassSlots {
    /// Class `i` (the caller keeps `i` below the class count).
    fn get(&self, i: usize) -> ClassState;
    fn put(&mut self, i: usize, c: &ClassState);
    /// Classes there is room for.
    fn capacity(&self) -> usize;
}

/// All classes in memory (1.9 KB: for tests and off-chain code; on chain use [`BookBytes`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassArray(pub [ClassState; MAX_CLASSES]);

impl core::ops::Deref for ClassArray {
    type Target = [ClassState];
    fn deref(&self) -> &[ClassState] {
        &self.0
    }
}

impl core::ops::DerefMut for ClassArray {
    fn deref_mut(&mut self) -> &mut [ClassState] {
        &mut self.0
    }
}

impl ClassSlots for ClassArray {
    fn get(&self, i: usize) -> ClassState {
        self.0[i]
    }
    fn put(&mut self, i: usize, c: &ClassState) {
        self.0[i] = *c;
    }
    fn capacity(&self) -> usize {
        MAX_CLASSES
    }
}

/// The class records of an encoded book, read and written in place.
pub struct ClassBytes<'a>(pub &'a mut [u8]);

impl ClassSlots for ClassBytes<'_> {
    fn get(&self, i: usize) -> ClassState {
        ClassState::decode(&self.0[i * CLASS_LEN..(i + 1) * CLASS_LEN])
    }
    fn put(&mut self, i: usize, c: &ClassState) {
        c.encode(&mut self.0[i * CLASS_LEN..(i + 1) * CLASS_LEN]);
    }
    fn capacity(&self) -> usize {
        self.0.len() / CLASS_LEN
    }
}

/// The bookkeeping of one Source: counters and classes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Book<S> {
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
    pub classes: S,
}

/// A book with all classes in memory.
pub type SourceBook = Book<ClassArray>;

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
    /// Shares that moved with the Gemas (share fixed point).
    pub shares: u128,
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
    /// Shares that went to the owner's pocket with the ready part.
    pub shares: u128,
}

impl Default for SourceBook {
    fn default() -> Self {
        Self::new()
    }
}

impl SourceBook {
    pub const fn new() -> SourceBook {
        Book {
            h: 0,
            r: 0,
            owner_fp: 0,
            owner_shares: 0,
            taken_fp: 0,
            n_ext: 0,
            classes: ClassArray([ClassState::fresh(); MAX_CLASSES]),
        }
    }
}

impl<S: ClassSlots> Book<S> {
    /// Classes in use: the three fee classes, General and the started Extensions.
    pub fn class_count(&self) -> usize {
        CLASS_EXTENSION_BASE as usize + self.n_ext as usize
    }

    pub fn class(&self, class: u8) -> BookResult<ClassState> {
        if (class as usize) < self.class_count() {
            Ok(self.classes.get(class as usize))
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
        (0..self.class_count()).fold(0u128, |acc, i| {
            acc.saturating_add(self.classes.get(i).uncovered)
        })
    }

    /// Ready not yet redeemed, returned or sold, over all classes (Fp).
    pub fn ready_total(&self) -> u128 {
        (0..self.class_count()).fold(0u128, |acc, i| {
            acc.saturating_add(self.classes.get(i).ready)
        })
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
            ck: 0,
            shares: 0,
            s_snap: U256::ZERO,
            reserved: [0; 1],
        }
    }

    /// Start the next Extension tranche (Extend) and return its class number. The new class is
    /// junior to everything issued before.
    pub fn start_extension(&mut self) -> BookResult<u8> {
        if self.n_ext >= MAX_EXTENSIONS {
            return Err(BookError::TooManyExtensions);
        }
        if self.class_count() >= self.classes.capacity() {
            return Err(BookError::Math);
        }
        self.classes.put(self.class_count(), &ClassState::fresh());
        self.n_ext += 1;
        Ok(CLASS_GENERAL + self.n_ext)
    }

    /// Bring a line up to date and keep it so (banks its shares, moves the snapshot, charges the
    /// class for rounding). Use this when the updated line is stored. To only look, use
    /// [`SourceBook::peek`].
    pub fn materialise<C: CheckpointStore + ?Sized>(
        &mut self,
        line: &mut Line,
        ck: &C,
    ) -> BookResult<()> {
        let id = line.class;
        let mut c = self.class(id)?;
        let mut l = *line;
        c.touch(id, &mut l, ck)?;
        self.classes.put(id as usize, &c);
        *line = l;
        Ok(())
    }

    /// The line brought up to date, as a copy, without changing the book. Never store the result:
    /// it is not charged to the class.
    pub fn peek<C: CheckpointStore + ?Sized>(&self, line: &Line, ck: &C) -> BookResult<Line> {
        let id = line.class;
        let mut c = self.class(id)?;
        let mut l = *line;
        c.touch(id, &mut l, ck)?;
        Ok(l)
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
            .ok_or(BookError::Corrupt("ready"))
    }

    /// Whole Gemas the line can Redeem now.
    pub fn redeemable(&self, line: &Line) -> BookResult<u64> {
        Ok(fp_floor(self.ready_of(line)?))
    }

    /// Staking-token shares the line owns now (share fixed point): banked plus earned since its
    /// snapshot. For the one line of a pooled fee class this is the whole pool.
    pub fn shares_of<C: CheckpointStore + ?Sized>(&self, line: &Line, ck: &C) -> BookResult<u128> {
        let c = self.class(line.class)?;
        if !is_exact_class(line.class) {
            // the single holder owns the whole pool
            return Ok(c.shares);
        }
        line.shares
            .checked_add(c.gain(line.class, line, ck)?)
            .ok_or(BookError::Math)
    }

    /// Whole shares that `k` ready Gemas of `line` would be paid now.
    pub fn redeem_shares_of<C: CheckpointStore + ?Sized>(
        &self,
        line: &Line,
        k: u64,
        ck: &C,
    ) -> BookResult<u128> {
        let l = self.peek(line, ck)?;
        let ready = fp(l.amount)
            .checked_sub(l.uncovered)
            .ok_or(BookError::Corrupt("ready"))?;
        if k == 0 {
            return Ok(0);
        }
        if fp(k) > ready {
            return Err(BookError::NotEnoughReady);
        }
        let c = self.class(l.class)?;
        let owned = if is_exact_class(l.class) {
            l.shares
        } else {
            mul_div_u128(c.shares, ready, c.ready, Round::Down).ok_or(BookError::Math)?
        };
        Ok(mul_div_u128(owned, fp(k), ready, Round::Down).ok_or(BookError::Math)? >> SHARE_BITS)
    }

    /// Add `k` freshly issued Gemas (all unpaid) to `line`: the Advance, and each Extend into its
    /// own tranche class. The caller has called [`SourceBook::start_extension`] for a new tranche.
    pub fn issue<C: CheckpointStore + ?Sized>(
        &mut self,
        line: &mut Line,
        k: u64,
        ck: &C,
    ) -> BookResult<()> {
        if k == 0 {
            return Err(BookError::ZeroAmount);
        }
        let id = line.class;
        let mut c = self.class(id)?;
        let mut l = *line;
        c.touch(id, &mut l, ck)?;
        l.amount = l.amount.checked_add(k).ok_or(BookError::Math)?;
        l.uncovered = l.uncovered.checked_add(fp(k)).ok_or(BookError::Math)?;
        c.uncovered = c.uncovered.checked_add(fp(k)).ok_or(BookError::Math)?;
        c.w = c.w.checked_add(fp(k)).ok_or(BookError::Math)?;
        self.classes.put(id as usize, &c);
        *line = l;
        Ok(())
    }

    /// The new coverage a computed cumulative figure would land.
    pub fn pending(&self, computed_cumulative: u128) -> u128 {
        computed_cumulative.saturating_sub(self.h)
    }

    /// Land the coverage the Source has earned since `H`, paying classes in order. `shares` is the
    /// staking-token value of exactly `pending(computed_cumulative)` (share fixed point). A figure
    /// not above `H` lands nothing (coverage is a high-water mark). Closed segments are written to
    /// `ck`; a failure after the first write leaves the store ahead of the book, which the failed
    /// transaction discards.
    pub fn land<C: CheckpointStore + ?Sized>(
        &mut self,
        computed_cumulative: u128,
        shares: u128,
        ck: &mut C,
    ) -> BookResult<Landing> {
        let delta = self.pending(computed_cumulative);
        if delta == 0 {
            return Ok(Landing::default());
        }
        if let Some(max) = delta.checked_mul(1u128 << SHARES_PER_ULP_BITS) {
            if shares > max {
                return Err(BookError::SharesOutOfRange);
            }
        }
        let n = self.class_count();
        // validate before touching anything
        let mut rest = delta;
        for i in 0..n {
            if rest == 0 {
                break;
            }
            let c = self.classes.get(i);
            let d = rest.min(c.uncovered);
            if d > 0 {
                if !c.headroom() {
                    return Err(BookError::CounterExhausted);
                }
                // a class's part of the shares is at most all of them
                c.shares.checked_add(shares).ok_or(BookError::Math)?;
                c.ready.checked_add(d).ok_or(BookError::Math)?;
            }
            rest -= d;
        }
        let owner_fp = self.owner_fp.checked_add(rest).ok_or(BookError::Math)?;
        self.owner_shares
            .checked_add(shares)
            .ok_or(BookError::Math)?;
        let mut rest = delta;
        let mut shares_left = shares;
        for id in 0..n {
            if rest == 0 {
                break;
            }
            let mut c = self.classes.get(id);
            let d = rest.min(c.uncovered);
            if d == 0 {
                continue;
            }
            let sh = mul_div_u128(shares, d, delta, Round::Down).ok_or(BookError::Math)?;
            c.land(id as u8, d, sh, ck)?;
            self.classes.put(id, &c);
            rest -= d;
            shares_left -= sh;
        }
        self.owner_shares = self
            .owner_shares
            .checked_add(shares_left)
            .ok_or(BookError::Math)?;
        self.h = computed_cumulative;
        self.owner_fp = owner_fp;
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
            .ok_or(BookError::Corrupt("split rho"))?;
        // rho * k = q * a + r. The mover gets floor = q; what stays is floor(rho * (a - k) / a)
        // = rho - q - (r != 0), so the two floors lose one unit exactly when r != 0.
        let (q, r) = U256::mul_wide(rho, k as u128).div_rem(a);
        let ready = q.to_u128().ok_or(BookError::Math)?;
        let dust = u128::from(r != 0);
        let kept_ready = rho
            .checked_sub(ready)
            .and_then(|v| v.checked_sub(dust))
            .ok_or(BookError::Corrupt("split kept"))?;
        let stay = a - k as u128;
        let kept_unpaid = (stay << FP_BITS)
            .checked_sub(kept_ready)
            .ok_or(BookError::Corrupt("split unpaid"))?;
        let moved_unpaid = fp(k)
            .checked_sub(ready)
            .ok_or(BookError::Corrupt("split moved"))?;
        Ok(Split {
            ready,
            moved_unpaid,
            kept_unpaid,
            removed_unpaid: line
                .uncovered
                .checked_sub(kept_unpaid)
                .ok_or(BookError::Corrupt("split removed"))?,
            dust,
        })
    }

    /// `floor(shares * k / amount)`: the shares that travel with `k` of a line's Gemas.
    fn moving_shares(line: &Line, k: u64) -> BookResult<u128> {
        if line.shares == 0 {
            return Ok(0);
        }
        mul_div_u128(line.shares, k as u128, line.amount as u128, Round::Down)
            .ok_or(BookError::Math)
    }

    /// Move `k` Gemas of one class and Source from `src` to `dst`, with their proportional ready
    /// and the shares the line owns for it (Pot entry, refund, payout, Backing, Treasury purchase,
    /// merge into an existing line). Both lines are brought up to date first. The class never
    /// changes.
    pub fn transfer<C: CheckpointStore + ?Sized>(
        &mut self,
        src: &mut Line,
        dst: &mut Line,
        k: u64,
        ck: &C,
    ) -> BookResult<Moved> {
        if src.class != dst.class || src.source != dst.source {
            return Err(BookError::ClassMismatch);
        }
        if k == 0 {
            return Err(BookError::ZeroAmount);
        }
        if k > src.amount {
            return Err(BookError::NotEnoughAmount);
        }
        let id = src.class;
        let exact = is_exact_class(id);
        let mut c = self.class(id)?;
        let (mut s, mut d) = (*src, *dst);
        c.touch(id, &mut s, ck)?;
        c.touch(id, &mut d, ck)?;
        let sp = Self::split(&s, k)?;
        let x = Self::moving_shares(&s, k)?;
        let mut owner_fp = self.owner_fp;
        let mut owner_shares = self.owner_shares;
        if sp.dust > 0 {
            // the dust becomes unpaid again (it cannot go to either side without one of them
            // showing more ready than the exact rule) and its coverage goes to the owner
            if !exact {
                let sh = Self::pool_shares(&c, sp.dust)?;
                c.shares -= sh;
                owner_shares = owner_shares.checked_add(sh).ok_or(BookError::Math)?;
            } else if c.ready < sp.dust {
                return Err(BookError::Corrupt("transfer dust"));
            }
            c.uncovered = c.uncovered.checked_add(sp.dust).ok_or(BookError::Math)?;
            c.w = c.w.checked_add(sp.dust).ok_or(BookError::Math)?;
            c.ready -= sp.dust;
            owner_fp = owner_fp.checked_add(sp.dust).ok_or(BookError::Math)?;
        }
        s.amount -= k;
        s.uncovered = sp.kept_unpaid;
        s.shares -= x;
        d.amount = d.amount.checked_add(k).ok_or(BookError::Math)?;
        d.uncovered = d
            .uncovered
            .checked_add(sp.moved_unpaid)
            .ok_or(BookError::Math)?;
        d.shares = d.shares.checked_add(x).ok_or(BookError::Math)?;
        self.classes.put(id as usize, &c);
        self.owner_fp = owner_fp;
        self.owner_shares = owner_shares;
        *src = s;
        *dst = d;
        Ok(Moved {
            ready: sp.ready,
            uncovered: sp.moved_unpaid,
            dust: sp.dust,
            shares: x,
        })
    }

    /// A fee cut: move `k` Gemas of a playable `src` line into the fee-class line `dst` of the same
    /// Source. The ready part moves with them (and the shares the line owns for it); the unpaid
    /// part becomes senior, which is the only way a Gema changes class.
    pub fn cut_fee<C: CheckpointStore + ?Sized>(
        &mut self,
        src: &mut Line,
        dst: &mut Line,
        k: u64,
        ck: &mut C,
    ) -> BookResult<Moved> {
        if is_fee_class(src.class) || !is_fee_class(dst.class) || src.source != dst.source {
            return Err(BookError::NotAFeeCut);
        }
        if k == 0 {
            return Err(BookError::ZeroAmount);
        }
        if k > src.amount {
            return Err(BookError::NotEnoughAmount);
        }
        let (ia, ib) = (src.class, dst.class);
        let mut ca = self.class(ia)?;
        let mut cb = self.class(ib)?;
        if !ca.headroom() {
            return Err(BookError::CounterExhausted);
        }
        let (mut s, mut d) = (*src, *dst);
        ca.touch(ia, &mut s, ck)?;
        cb.touch(ib, &mut d, ck)?;
        let sp = Self::split(&s, k)?;
        let x = Self::moving_shares(&s, k)?;
        let leaving = sp.ready.checked_add(sp.dust).ok_or(BookError::Math)?;
        if ca.ready < leaving || ca.shares < x {
            return Err(BookError::Corrupt("cut_fee pool"));
        }
        ca.ready -= leaving;
        ca.shares -= x;
        // the moved unpaid is the removed unpaid plus the dust that turns back into unpaid
        cb.uncovered = cb
            .uncovered
            .checked_add(sp.moved_unpaid)
            .ok_or(BookError::Math)?;
        cb.w = cb.w.checked_add(sp.moved_unpaid).ok_or(BookError::Math)?;
        cb.ready = cb.ready.checked_add(sp.ready).ok_or(BookError::Math)?;
        cb.shares = cb.shares.checked_add(x).ok_or(BookError::Math)?;
        let mut owner_fp = self.owner_fp.checked_add(sp.dust).ok_or(BookError::Math)?;
        let mut owner_shares = self.owner_shares;
        // everything that can fail on the inputs comes before `shed`, which may write a record
        s.amount -= k;
        s.uncovered = sp.kept_unpaid;
        s.shares -= x;
        d.amount = d.amount.checked_add(k).ok_or(BookError::Math)?;
        d.uncovered = d
            .uncovered
            .checked_add(sp.moved_unpaid)
            .ok_or(BookError::Math)?;
        if is_exact_class(ib) {
            d.shares = d.shares.checked_add(x).ok_or(BookError::Math)?;
        }
        Self::shed(
            ia,
            &mut ca,
            sp.removed_unpaid,
            &mut owner_fp,
            &mut owner_shares,
            ck,
        )?;
        self.classes.put(ia as usize, &ca);
        self.classes.put(ib as usize, &cb);
        self.owner_fp = owner_fp;
        self.owner_shares = owner_shares;
        *src = s;
        *dst = d;
        Ok(Moved {
            ready: sp.ready,
            uncovered: sp.moved_unpaid,
            dust: sp.dust,
            shares: x,
        })
    }

    /// Pay out `k` whole ready Gemas of `line` (Redeem, fee cash-in, the ready part of an Instant
    /// Redeem): the Gemas leave and the line's own shares for them are paid, whole shares rounded
    /// down. A fraction of a share stays with the line.
    pub fn redeem<C: CheckpointStore + ?Sized>(
        &mut self,
        line: &mut Line,
        k: u64,
        ck: &C,
    ) -> BookResult<Redeemed> {
        if k == 0 {
            return Err(BookError::ZeroAmount);
        }
        let id = line.class;
        let exact = is_exact_class(id);
        let mut c = self.class(id)?;
        let mut l = *line;
        c.touch(id, &mut l, ck)?;
        let ready = fp(l.amount)
            .checked_sub(l.uncovered)
            .ok_or(BookError::Corrupt("redeem ready"))?;
        if k > l.amount || fp(k) > ready {
            return Err(BookError::NotEnoughReady);
        }
        if c.ready < fp(k) {
            return Err(BookError::Corrupt("redeem pool"));
        }
        let mut owner_shares = self.owner_shares;
        let paid;
        if exact {
            paid = mul_div_u128(l.shares, fp(k), ready, Round::Down).ok_or(BookError::Math)?
                >> SHARE_BITS;
            let take = paid << SHARE_BITS;
            if c.shares < take {
                return Err(BookError::Corrupt("redeem shares"));
            }
            l.shares -= take;
            c.shares -= take;
            l.amount -= k;
            c.ready -= fp(k);
            if l.amount == 0 && l.shares != 0 {
                // a closed line's sub-share remainder goes to the owner's pocket
                c.shares -= l.shares;
                owner_shares = owner_shares.checked_add(l.shares).ok_or(BookError::Math)?;
                l.shares = 0;
            }
        } else {
            paid = mul_div_u128(c.shares, fp(k), c.ready, Round::Down).ok_or(BookError::Math)?
                >> SHARE_BITS;
            l.amount -= k;
            c.ready -= fp(k);
            c.shares -= paid << SHARE_BITS;
        }
        self.classes.put(id as usize, &c);
        self.owner_shares = owner_shares;
        *line = l;
        Ok(Redeemed {
            gemas: k,
            shares: paid,
        })
    }

    /// `return_own`: the owner takes `k` of their own Gemas out of the Source. The proportional
    /// ready part goes to the owner's pocket (and `R`) with its shares, the rest is unpaid Debt
    /// that is cancelled.
    pub fn return_own<C: CheckpointStore + ?Sized>(
        &mut self,
        line: &mut Line,
        k: u64,
        ck: &mut C,
    ) -> BookResult<Returned> {
        if k == 0 {
            return Err(BookError::ZeroAmount);
        }
        if k > line.amount {
            return Err(BookError::NotEnoughAmount);
        }
        let id = line.class;
        let exact = is_exact_class(id);
        let mut c = self.class(id)?;
        if !c.headroom() {
            return Err(BookError::CounterExhausted);
        }
        let mut l = *line;
        c.touch(id, &mut l, ck)?;
        let sp = Self::split(&l, k)?;
        let leaving = sp.ready.checked_add(sp.dust).ok_or(BookError::Math)?;
        if c.ready < leaving {
            return Err(BookError::Corrupt("return_own pool"));
        }
        let (x_ready, x_dust) = if exact {
            (Self::moving_shares(&l, k)?, 0)
        } else {
            (
                Self::pool_shares(&c, sp.ready)?,
                Self::pool_shares(&c, sp.dust)?,
            )
        };
        if c.shares < x_ready + x_dust {
            return Err(BookError::Corrupt("return_own shares"));
        }
        c.ready -= leaving;
        c.shares -= x_ready + x_dust;
        let r = self.r.checked_add(sp.ready).ok_or(BookError::Math)?;
        let mut owner_fp = self.owner_fp.checked_add(leaving).ok_or(BookError::Math)?;
        let mut owner_shares = self
            .owner_shares
            .checked_add(x_ready + x_dust)
            .ok_or(BookError::Math)?;
        let cancelled = Self::shed(
            id,
            &mut c,
            sp.removed_unpaid,
            &mut owner_fp,
            &mut owner_shares,
            ck,
        )?;
        l.amount -= k;
        l.uncovered = sp.kept_unpaid;
        l.shares -= if exact { x_ready } else { 0 };
        self.classes.put(id as usize, &c);
        self.r = r;
        self.owner_fp = owner_fp;
        self.owner_shares = owner_shares;
        *line = l;
        Ok(Returned {
            ready: sp.ready,
            cancelled,
            dust: sp.dust,
            shares: x_ready + x_dust,
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
    /// * per class: `ready + uncovered == sum(amount) * 2^64` (identity E) and `w >= uncovered`;
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
        for (i, per) in per_class.iter().enumerate().take(self.class_count()) {
            let c = self.classes.get(i);
            if c.ready.checked_add(c.uncovered) != Some(*per) {
                return Err("identity E: ready + uncovered != sum of line amounts");
            }
            if c.w < c.uncovered {
                return Err("weight bound below the unpaid total");
            }
            if c.uncovered == 0 && c.w != 0 {
                return Err("weight bound of an empty class");
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

    /// Shares of `amount` ready of the pool of `c`, rounded down (pooled fee classes only).
    fn pool_shares(c: &ClassState, amount: u128) -> BookResult<u128> {
        if amount == 0 {
            return Ok(0);
        }
        if c.ready == 0 || amount > c.ready {
            return Err(BookError::Corrupt("pool shares"));
        }
        mul_div_u128(c.shares, amount, c.ready, Round::Down).ok_or(BookError::Math)
    }

    /// Take `removed` unpaid Gemas of a line out of its class (cancelled by `return_own`, or cut
    /// from the line as a fee). The line's unpaid amount was rounded up when it was brought up to
    /// date, so it can exceed the class's exact total by a few fixed-point units; that excess
    /// has no unpaid Gema to leave and instead comes out of the class's ready pool (it was
    /// coverage the lines could not claim) into the owner's pocket. A class left with nothing unpaid
    /// starts a new epoch.
    fn shed<C: CheckpointStore + ?Sized>(
        id: u8,
        c: &mut ClassState,
        removed: u128,
        owner_fp: &mut u128,
        owner_shares: &mut u128,
        ck: &mut C,
    ) -> BookResult<u128> {
        let before = c.uncovered;
        let from_unpaid = removed.min(before);
        let slack = removed - from_unpaid;
        c.uncovered = before - from_unpaid;
        c.w =
            c.w.checked_sub(removed)
                .ok_or(BookError::Corrupt("shed weight"))?;
        if c.w < c.uncovered {
            return Err(BookError::Corrupt("shed weight below unpaid"));
        }
        if slack > 0 {
            // pooled classes price the slack; exact classes leave its shares stranded in the class
            let sh = if is_exact_class(id) {
                if c.ready < slack {
                    return Err(BookError::Corrupt("shed slack"));
                }
                0
            } else {
                Self::pool_shares(c, slack)?
            };
            c.ready -= slack;
            c.shares -= sh;
            *owner_fp = owner_fp.checked_add(slack).ok_or(BookError::Math)?;
            *owner_shares = owner_shares.checked_add(sh).ok_or(BookError::Math)?;
        }
        c.drained(id, before, ck)?;
        Ok(from_unpaid)
    }

    /// Counters as bytes (the first `BOOK_FIXED_LEN` bytes of an encoded book).
    fn encode_header(&self, out: &mut [u8]) {
        out[..BOOK_FIXED_LEN].fill(0);
        out[0] = BOOK_VERSION;
        out[1..17].copy_from_slice(&self.h.to_le_bytes());
        out[17..33].copy_from_slice(&self.r.to_le_bytes());
        out[33..49].copy_from_slice(&self.owner_fp.to_le_bytes());
        out[49..65].copy_from_slice(&self.owner_shares.to_le_bytes());
        out[65..81].copy_from_slice(&self.taken_fp.to_le_bytes());
        out[81] = self.n_ext;
    }
}

/// Size of the encoded book with `n_ext` Extensions.
pub const fn encoded_len(n_ext: u8) -> usize {
    BOOK_FIXED_LEN + (CLASS_EXTENSION_BASE as usize + n_ext as usize) * CLASS_LEN
}

impl SourceBook {
    /// Size of the encoded book with `n_ext` Extensions.
    pub const fn encoded_len(n_ext: u8) -> usize {
        encoded_len(n_ext)
    }

    /// Write the book (little endian, only the classes in use) into `out`.
    pub fn encode(&self, out: &mut [u8]) -> BookResult<()> {
        let len = encoded_len(self.n_ext);
        if out.len() < len {
            return Err(BookError::Math);
        }
        out[..len].fill(0);
        self.encode_header(out);
        for i in 0..self.class_count() {
            let at = BOOK_FIXED_LEN + i * CLASS_LEN;
            self.classes[i].encode(&mut out[at..at + CLASS_LEN]);
        }
        Ok(())
    }

    pub fn decode(raw: &[u8]) -> BookResult<SourceBook> {
        let mut book = SourceBook::new();
        book.decode_into(raw)?;
        Ok(book)
    }

    /// Decode into an existing book (no 2 KB temporaries on a small stack).
    pub fn decode_into(&mut self, raw: &[u8]) -> BookResult<()> {
        decode_header(raw, self)?;
        for i in 0..self.class_count() {
            let at = BOOK_FIXED_LEN + i * CLASS_LEN;
            let c = ClassState::decode(&raw[at..at + CLASS_LEN]);
            if c.p == 0 {
                return Err(BookError::BadSnapshot);
            }
            self.classes[i] = c;
        }
        Ok(())
    }
}

fn decode_header<S>(raw: &[u8], book: &mut Book<S>) -> BookResult<()> {
    if raw.len() < BOOK_FIXED_LEN || raw[0] != BOOK_VERSION {
        return Err(BookError::Math);
    }
    let n_ext = raw[81];
    if n_ext > MAX_EXTENSIONS || raw.len() < encoded_len(n_ext) {
        return Err(BookError::TooManyExtensions);
    }
    book.h = u128_at(raw, 1);
    book.r = u128_at(raw, 17);
    book.owner_fp = u128_at(raw, 33);
    book.owner_shares = u128_at(raw, 49);
    book.taken_fp = u128_at(raw, 65);
    book.n_ext = n_ext;
    Ok(())
}

/// A book read and written in place in the bytes of a Source account: the counters are decoded
/// once, each class when an operation touches it, so a transaction with many Sources holds no
/// 2 KB array per book. Call [`BookBytes::close`] after the operations to write the counters.
pub struct BookBytes<'a> {
    book: Book<ClassBytes<'a>>,
    header: &'a mut [u8],
}

impl<'a> BookBytes<'a> {
    pub fn open(raw: &'a mut [u8]) -> BookResult<BookBytes<'a>> {
        let mut book = Book {
            h: 0,
            r: 0,
            owner_fp: 0,
            owner_shares: 0,
            taken_fp: 0,
            n_ext: 0,
            classes: ClassBytes(&mut []),
        };
        decode_header(raw, &mut book)?;
        let (header, rest) = raw.split_at_mut(BOOK_FIXED_LEN);
        book.classes = ClassBytes(rest);
        Ok(BookBytes { book, header })
    }

    /// Format an empty book (no Extension) in `raw`, which must be at least `encoded_len(0)` long.
    pub fn init(raw: &'a mut [u8]) -> BookResult<BookBytes<'a>> {
        if raw.len() < encoded_len(0) {
            return Err(BookError::Math);
        }
        raw.fill(0);
        let fresh = SourceBook::new();
        fresh.encode_header(raw);
        for i in 0..CLASS_EXTENSION_BASE as usize {
            let at = BOOK_FIXED_LEN + i * CLASS_LEN;
            ClassState::fresh().encode(&mut raw[at..at + CLASS_LEN]);
        }
        BookBytes::open(raw)
    }

    /// Write the counters back. The classes were written as they changed.
    pub fn close(self) {
        self.book.encode_header(self.header);
    }
}

impl<'a> core::ops::Deref for BookBytes<'a> {
    type Target = Book<ClassBytes<'a>>;
    fn deref(&self) -> &Self::Target {
        &self.book
    }
}

impl<'a> core::ops::DerefMut for BookBytes<'a> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.book
    }
}

impl ClassState {
    pub fn encode(&self, out: &mut [u8]) {
        out[..CLASS_LEN].fill(0);
        out[0..16].copy_from_slice(&self.p.to_le_bytes());
        out[16..32].copy_from_slice(&self.uncovered.to_le_bytes());
        out[32..48].copy_from_slice(&self.ready.to_le_bytes());
        out[48..64].copy_from_slice(&self.shares.to_le_bytes());
        out[64..80].copy_from_slice(&self.w.to_le_bytes());
        out[80..112].copy_from_slice(&self.s.to_le_bytes());
        out[112..116].copy_from_slice(&self.scale.to_le_bytes());
        out[116..120].copy_from_slice(&self.epoch.to_le_bytes());
        out[120..124].copy_from_slice(&self.ck.to_le_bytes());
    }

    pub fn decode(raw: &[u8]) -> ClassState {
        let mut s = [0u8; 32];
        s.copy_from_slice(&raw[80..112]);
        ClassState {
            p: u128_at(raw, 0),
            uncovered: u128_at(raw, 16),
            ready: u128_at(raw, 32),
            shares: u128_at(raw, 48),
            w: u128_at(raw, 64),
            s: U256::from_le_bytes(&s),
            scale: u32_at(raw, 112),
            epoch: u32_at(raw, 116),
            ck: u32_at(raw, 120),
        }
    }
}

pub const BOOK_FIXED_LEN: usize = 82;
pub const CLASS_LEN: usize = 128;

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

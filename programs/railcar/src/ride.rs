//! The ride on a Table, without accounts or clock: what a signal, a tick (with or without a
//! Brake), a Jump and the end of a ride do to the public Table given the private Vault, and the
//! result core is sent.
//!
//! **Constant work on secrets.** Anyone can simulate a transaction against the private Vault and
//! read its error code, including "compute budget exceeded" under a limit they choose (see
//! `.scratch/railcar/07-brake-decision.md`). So every comparison on Vault values in a signal, a
//! tick or a Jump is arithmetic (`below`, `pick`), not a branch, and the only branches taken on
//! them are ones whose result is public in the same transaction (the ride ends). The LiteSVM
//! tests hold the compiled program to equal compute units across Brake schedules.

use crate::engine::{self, BRAKE_MS, RIDE_CAP_MS};
use crate::state::*;
use tesoro_core::ledger::many_seat::{ManySeatResult, SeatPlace, SeatRefund};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RideError {
    /// No such seat on this ride, or the seat is not this Player's.
    NotAPlayer,
    AlreadyJumped,
    Math,
}

/// -1 when `a < b`, else 0 (no branch; |values| < 2^62). `black_box` hides that the mask comes
/// from a comparison: otherwise LLVM folds it back into a select, which sBPF runs as a jump (the
/// compute-unit test caught a 1-unit difference).
#[inline(always)]
fn below(a: i64, b: i64) -> i64 {
    core::hint::black_box(a.wrapping_sub(b) >> 63)
}

/// `a` where `mask` is -1, `b` where it is 0 (no branch).
#[inline(always)]
fn pick(mask: i64, a: i64, b: i64) -> i64 {
    b ^ ((a ^ b) & mask)
}

/// 1 when `a >= b`, else 0 (no branch).
#[inline(always)]
fn at_least(a: i64, b: i64) -> i64 {
    1 + below(a, b)
}

/// Track position in half track ms at ride ms `t`, exact from the last Brake on: every press
/// added a 5 s slow piece after the earlier ones, so at `t` the car has lost half of the slow time
/// already run (`slow_total` minus what is left of the last piece).
pub fn half_position(v: &Vault, t: u32) -> i64 {
    let (t, total, end) = (
        i64::from(t),
        i64::from(v.slow_total_ms),
        i64::from(v.slow_end_ms),
    );
    let after = 2 * t - total;
    let during = t + end - total;
    pick(below(after, during), during, after)
}

/// Real ms of the ride's Impact: the first ms at which the car has run the crash point, capped at
/// ten minutes. Same as `engine::impact_ms` over the presses (property-tested).
pub fn impact_ms(v: &Vault) -> u32 {
    let (crash2, total, end) = (
        2 * u64::from(v.crash_ms),
        u64::from(v.slow_total_ms),
        u64::from(v.slow_end_ms),
    );
    let fast = (crash2 + total).div_ceil(2);
    let slow = (crash2 + total).saturating_sub(end);
    let t = fast.min(slow).min(u64::from(RIDE_CAP_MS));
    u32::try_from(t).unwrap_or(RIDE_CAP_MS)
}

/// A signal, a tick or the start of a Jump at `slot`: moves the public Tell stage and the false
/// screws passed, and says whether the car has hit the wall (or the ride reached ten minutes).
/// Nothing changes once it has.
pub fn advance(t: &mut Table, v: &Vault, slot: u64) -> bool {
    let ms = t.ride_ms(slot);
    let half = half_position(v, ms);
    let hit =
        at_least(half, 2 * i64::from(v.crash_ms)) | at_least(i64::from(ms), i64::from(RIDE_CAP_MS));
    if hit == 1 {
        return true;
    }
    let tells = at_least(half, 2 * i64::from(v.screw_at_ms))
        + at_least(half, 2 * i64::from(v.bolt_at_ms))
        + at_least(half, 2 * i64::from(v.spark_at_ms));
    let len = i64::from(v.false_len);
    let mut falses = 0i64;
    for (k, at) in v.false_screws.iter().enumerate() {
        falses += at_least(half, 2 * i64::from(*at)) & below(k as i64, len);
    }
    t.tell = t.tell.max(tells as u8);
    t.false_screws = t.false_screws.max(falses as u8);
    false
}

/// Table seat `i`'s tick at ride ms `ms` (before the Impact), with `brake` = 1 the Player's press.
/// The Brake counts when `brake`, the Player is aboard, every seat is bound and the Player has
/// not Braked on this ride; otherwise nothing changes. The same work runs either way (masks), so
/// neither a second Brake nor a tick without one can be told from a first Brake.
pub fn tick(t: &Table, v: &mut Vault, seat: &mut BrakeSeat, i: u8, ms: u32, brake: u8) {
    let all_bound = at_least(i64::from(t.brakes_bound), i64::from(t.seated));
    let aboard = i64::from(t.seats[usize::from(i)].aboard());
    let fresh = 1 - i64::from(seat.used & 1);
    let go = i64::from(brake & 1) & aboard & all_bound & fresh;
    let on = -go;
    let now = i64::from(ms);
    let end = i64::from(v.slow_end_ms);
    let start = pick(below(now, end), end, now);
    v.slow_end_ms = pick(on, start + i64::from(BRAKE_MS), end) as u32;
    v.slow_total_ms = (i64::from(v.slow_total_ms) + go * i64::from(BRAKE_MS)) as u32;
    // `press_count` <= the seats that Braked; slot PRESS_ROOM - 1 only takes a no-op write
    let k = usize::from(v.press_count).min(PRESS_ROOM - 1);
    v.presses[k] = pick(on, now, i64::from(v.presses[k])) as u32;
    v.press_seat[k] = pick(on, i64::from(i), i64::from(v.press_seat[k])) as u8;
    v.press_count = (k as i64 + go) as u8;
    seat.used = (i64::from(seat.used) | go) as u8;
    seat.press_ms = pick(on, now, i64::from(seat.press_ms)) as u32;
}

/// Table seat `i` Jumps at `slot` (before the Impact). Returns whether nobody is aboard now.
pub fn jump(t: &mut Table, i: usize, slot: u64) -> Result<bool, RideError> {
    if i >= usize::from(t.seated) {
        return Err(RideError::NotAPlayer);
    }
    if !t.seats[i].aboard() {
        return Err(RideError::AlreadyJumped);
    }
    let order = t.jumps.checked_add(1).ok_or(RideError::Math)?;
    let ms = t.ride_ms(slot);
    t.seats[i].set_jump(order, ms);
    t.jumps = order;
    t.aboard = t.aboard.checked_sub(1).ok_or(RideError::Math)?;
    Ok(t.aboard == 0)
}

/// Ends the ride at ride ms `over_ms`: with nobody off every entry comes back, otherwise the last
/// three Jumps are placed (last off first) and the earlier Jumps get the schedule's refund at
/// their Jump position.
pub fn conclude(t: &mut Table, v: &Vault, over_ms: u32, now: i64) {
    let m = usize::from(t.jumps);
    let mut by_order = [NO_SEAT; MAX_SEATS as usize];
    for (i, s) in t.seats[..usize::from(t.seated)].iter().enumerate() {
        if s.order > 0 {
            by_order[usize::from(s.order) - 1] = i as u8;
        }
    }
    let entry = t.entry();
    t.places = [NO_SEAT; 3];
    if m == 0 {
        t.outcome = OUTCOME_REFUND;
        t.reason = REASON_NOBODY_JUMPED;
    } else {
        let placed = m.min(3);
        for k in 0..placed {
            t.places[k] = by_order[m - 1 - k];
        }
        // Jump order is ride-time order: one walk over the presses gives every position
        let mut slow = Slowed::new(v.pressed());
        for &i in &by_order[..m - placed] {
            let s = &mut t.seats[usize::from(i)];
            let refund = engine::refund(entry, slow.position_ms(s.jump_ms()));
            s.set_refund(refund);
        }
        t.outcome = OUTCOME_PLACED;
        t.reason = REASON_PLAYED;
    }
    finish(t, Some(v), over_ms, now);
}

/// The ride is void: every entry back. `v` is the Vault when the draw is in (it is revealed).
pub fn void(t: &mut Table, v: Option<&Vault>, reason: u8, now: i64) {
    t.places = [NO_SEAT; 3];
    t.outcome = OUTCOME_REFUND;
    t.reason = reason;
    finish(t, v, 0, now);
}

/// Track positions of ascending ride times under ascending presses, walking the presses once
/// (no allocation: the ride's end must fit any transaction that ends it).
pub struct Slowed<'a> {
    presses: &'a [u32],
    next: usize,
    /// End of the last slow piece already wholly before the queried time.
    end: u64,
    /// Slow ms of those pieces.
    full: u64,
}

impl<'a> Slowed<'a> {
    pub fn new(presses: &'a [u32]) -> Self {
        Self {
            presses,
            next: 0,
            end: 0,
            full: 0,
        }
    }

    /// Track ms at ride ms `t`; `t` must not be below the previous query's.
    pub fn position_ms(&mut self, t: u32) -> u32 {
        let t = u64::from(t);
        let brake = u64::from(BRAKE_MS);
        let mut slowed = self.full;
        while let Some(&p) = self.presses.get(self.next) {
            let start = u64::from(p).max(self.end);
            if start + brake <= t {
                self.full += brake;
                self.end = start + brake;
                self.next += 1;
                slowed = self.full;
            } else {
                slowed = self.full + t.saturating_sub(start);
                break;
            }
        }
        u32::try_from((2 * t - slowed) / 2).unwrap_or(u32::MAX)
    }
}

/// What the end of a ride makes public: the draw and every Brake (from the Vault's press list),
/// so that the engine can recompute the ride from the Table.
fn reveal(t: &mut Table, v: &Vault) {
    if !v.ready {
        return;
    }
    t.reveal_draw = v.draw;
    t.revealed = 1;
    for (&ms, &i) in v.pressed().iter().zip(&v.press_seat) {
        if let Some(s) = t.seats.get_mut(usize::from(i)) {
            s.reveal_brake(ms);
        }
    }
}

fn finish(t: &mut Table, v: Option<&Vault>, over_ms: u32, now: i64) {
    if let Some(v) = v {
        reveal(t, v);
    }
    t.phase = PHASE_OVER;
    t.dirty = 1;
    t.req_pending = 0;
    t.commit_tries = 0;
    t.set_over_ms(over_ms);
    t.set_over_at(now);
}

/// What core is told: places with their shares (last off first), refunds by core seat.
pub fn result(t: &Table) -> Option<ManySeatResult> {
    match t.outcome {
        OUTCOME_REFUND => Some(ManySeatResult::Refund),
        OUTCOME_PLACED => {
            let placed: Vec<u8> = t.places.iter().copied().filter(|p| *p != NO_SEAT).collect();
            let shares = engine::place_shares_bps(placed.len());
            let places = placed
                .iter()
                .zip(shares)
                .map(|(&p, bps)| SeatPlace {
                    seat: t.seats[usize::from(p)].seat,
                    share_bps: bps as u16,
                })
                .collect();
            let mut refunds: Vec<SeatRefund> = t.seats[..usize::from(t.seated)]
                .iter()
                .filter(|s| s.refund() > 0)
                .map(|s| SeatRefund {
                    seat: s.seat,
                    gemas: s.refund(),
                })
                .collect();
            refunds.sort_by_key(|r| r.seat);
            Some(ManySeatResult::Placed { places, refunds })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests;

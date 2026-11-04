//! The ride on a Table, without accounts or clock: what a signal, a Jump and the end of a ride do
//! to the public Table given the private Vault, and the result core is sent.
//!
//! No Brakes yet (ticket 07): track position equals real time, and the Impact is the crash point.

use crate::engine;
use crate::state::*;
use tesoro_core::ledger::many_seat::{ManySeatResult, SeatPlace, SeatRefund};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RideError {
    /// No such seat on this ride, or the seat is not this Player's.
    NotAPlayer,
    AlreadyJumped,
    Math,
}

/// Real ms of the ride's Impact.
pub fn impact_ms(vault: &Vault) -> u32 {
    engine::impact_ms(&[], vault.crash_ms)
}

/// Track position at ride ms `t`.
fn position(t: u32) -> u32 {
    engine::position_ms(&[], t)
}

/// Whether the rollup made fewer than half the slots it should over `secs` of clock, judged only
/// over at least `STALL_SECS` (Block Burst's `stalled`).
pub fn stalled(slots: u64, secs: u64) -> bool {
    secs >= STALL_SECS as u64
        && u128::from(slots) * 1_000
            < u128::from(OUTAGE_RATIO_PERMILLE) * u128::from(SLOTS_PER_SEC) * u128::from(secs)
}

/// The outage rule at an observation (a signal or a Jump while riding) at `slot` and unix `ts`:
/// whether the rollup ran under half speed for 5 s since the pace mark, the last moment the ride
/// was on pace. Otherwise the mark moves here when the stretch since it ran faster than half pace
/// (the mark is the observation furthest ahead of half pace, so a slow stretch is measured from
/// its start however often transactions land). A slot or clock behind the mark is not judged.
pub fn pace(t: &mut Table, slot: u64, ts: i64) -> bool {
    let (mark_slot, mark_ts) = (t.pace_slot(), t.pace_ts());
    if slot < mark_slot || ts < mark_ts {
        return false;
    }
    let slots = slot - mark_slot;
    let secs = ts.abs_diff(mark_ts);
    if stalled(slots, secs) {
        return true;
    }
    if u128::from(slots) * 1_000
        > u128::from(OUTAGE_RATIO_PERMILLE) * u128::from(SLOTS_PER_SEC) * u128::from(secs)
    {
        t.set_pace_slot(slot);
        t.set_pace_ts(ts);
    }
    false
}

/// A signal (or the start of a Jump) at `slot`: moves the public Tell stage and the false screws
/// passed, and says whether the car has hit the wall. Nothing changes once it has.
pub fn advance(t: &mut Table, v: &Vault, slot: u64) -> bool {
    if slot >= t.impact_slot(impact_ms(v)) {
        return true;
    }
    let pos = position(t.ride_ms(slot));
    t.tell = t.tell.max(v.tell_at(pos));
    t.false_screws = t.false_screws.max(v.false_screws_at(pos));
    false
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
pub fn conclude(t: &mut Table, over_ms: u32, now: i64) {
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
        for &i in &by_order[..m - placed] {
            let s = &mut t.seats[usize::from(i)];
            let refund = engine::refund(entry, position(s.jump_ms()));
            s.set_refund(refund);
        }
        t.outcome = OUTCOME_PLACED;
        t.reason = REASON_PLAYED;
    }
    finish(t, over_ms, now);
}

/// The draw never came, or the rollup stalled: every entry back.
pub fn void(t: &mut Table, reason: u8, now: i64) {
    t.places = [NO_SEAT; 3];
    t.outcome = OUTCOME_REFUND;
    t.reason = reason;
    finish(t, 0, now);
}

fn finish(t: &mut Table, over_ms: u32, now: i64) {
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

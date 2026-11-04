//! Settling a many-seat Match (Railcar ticket 03; decision `.scratch/railcar/03-settlement-decision.md`).
//!
//! The Game reports, per seat, a **refund** (Gemas of the seat's own entry back, fee-free) and a
//! **place share** (basis points). Every number is fixed when settling starts ([`plan_payout`]):
//!
//! * Pot after refunds `P` = seated × entry − refunds; forfeited `F` = what the unplaced seats do
//!   not get back.
//! * Fees on `P` ([`pot_fees`]), cut from forfeited Gemas only and capped at `F` (Platform first,
//!   then Studio, then Leaderboard), so a placed seat never ends below its entry.
//! * Placed seats get their entry back, then `F` − fees split by place share; the rounding
//!   remainder goes to first place.

use crate::ledger::lifecycle::blocks::pot_fees;
use crate::ledger::lifecycle::{LifecycleError, Terms};
use crate::ledger::{mul_div_floor, BPS};

use super::{SeatError, SeatResult};

/// Most places a many-seat result pays.
pub const MAX_PLACES: usize = 10;

/// The money of a result, fixed before any line moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Payout {
    /// Platform, Studio and Leaderboard Fees actually cut.
    pub fees: [u64; 3],
    /// Gemas the unplaced seats do not get back.
    pub forfeited: u64,
    /// Forfeited Gemas each place gets on top of its entry, in place order.
    pub won: [u64; MAX_PLACES],
    /// The fees were cut short by the forfeits: a win then earns no Points.
    pub fees_capped: bool,
}

fn fee_err(e: LifecycleError) -> SeatError {
    match e {
        LifecycleError::FeeTooHigh => SeatError::FeeTooHigh,
        _ => SeatError::Math,
    }
}

/// The payout of a result with `shares` (place order, together 10,000 bps) among `seated` seats
/// of `entry` Gemas each, when the unplaced seats get `refunded` Gemas back in total.
pub fn plan_payout(
    entry: u64,
    seated: u8,
    shares: &[u16],
    refunded: u64,
    terms: &Terms,
    leaderboard_bps: u16,
) -> SeatResult<Payout> {
    let unplaced = (seated as u64)
        .checked_sub(shares.len() as u64)
        .ok_or(SeatError::BadResult)?;
    let forfeited = unplaced
        .checked_mul(entry)
        .and_then(|g| g.checked_sub(refunded))
        .ok_or(SeatError::BadResult)?;
    let pot = (seated as u64)
        .checked_mul(entry)
        .and_then(|g| g.checked_sub(refunded))
        .ok_or(SeatError::Math)?;
    let full = pot_fees(pot as u128, terms, leaderboard_bps).map_err(fee_err)?;
    let mut fees = [0u64; 3];
    let mut room = forfeited;
    for (cut, want) in fees.iter_mut().zip(full) {
        *cut = want.min(room);
        room -= *cut;
    }
    let mut won = [0u64; MAX_PLACES];
    let mut given = 0u64;
    for (w, share) in won.iter_mut().zip(shares) {
        *w = mul_div_floor(room as u128, *share as u128, BPS)
            .map_err(|_| SeatError::Math)
            .and_then(|g| u64::try_from(g).map_err(|_| SeatError::Math))?;
        given = given.checked_add(*w).ok_or(SeatError::Math)?;
    }
    if let Some(first) = won.first_mut().filter(|_| !shares.is_empty()) {
        *first = first
            .checked_add(room.checked_sub(given).ok_or(SeatError::Math)?)
            .ok_or(SeatError::Math)?;
    }
    Ok(Payout {
        fees,
        forfeited,
        won,
        fees_capped: fees != full,
    })
}

#[cfg(test)]
mod tests;

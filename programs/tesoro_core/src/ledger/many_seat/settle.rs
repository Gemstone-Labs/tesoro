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
//!   remainder goes to first place. Nothing forfeited is a refund: no fee, no win.
//!
//! The lines then move in permissionless chunks ([`ManySeatRecord::chunk`]), in two phases:
//!
//! 1. **Own Gemas home**, seats in order: a placed seat's whole entry back to its funder, an
//!    unplaced seat's refund from its first line forward (one line split at most). Each seat's
//!    join-time hold covers these credits.
//! 2. **Forfeits**, unplaced seats in order, each from its last line backward: one stream cut into
//!    the Platform, Studio and Leaderboard Fees, then each place's winnings in place order. A won
//!    line keeps its Source, class and tranche.
//!
//! A credit that finds no room stops the chunk; nothing is skipped. Because the own Gemas move
//! first, a winner whose stores are full holds up only the forfeits, never anyone's entry.

use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

use crate::ledger::book::SourceBook;
use crate::ledger::draw::{PotBacking, PotPages};
use crate::ledger::lifecycle::blocks::{cut_step, placement, player_share, pot_fees, Credit};
use crate::ledger::lifecycle::{
    ChunkReport, LcResult, LifecycleError, Settlement, SettlementLine, Terms,
};
use crate::ledger::line_store::{Line, SIDE_WON};
use crate::ledger::{mul_div_floor, Key, BPS};

use super::{ManySeatRecord, ManyStage, Seat, SeatError, SeatResult, SeatState, MAX_SEATS};

/// Most places a many-seat result pays.
pub const MAX_PLACES: usize = 10;

/// Run kinds, the same codes as head-to-head runs (`MatchRunStarted.kind`).
pub const KIND_WIN: u8 = 0;
pub const KIND_ABANDONED: u8 = 4;
pub const KIND_GAME_UPGRADED: u8 = 5;
pub const KIND_BY_GAME: u8 = 6;

/// `SettlementLine.purpose` of an early refund (0-2 fees, 3 entry back, 4 winnings as head-to-head).
pub const PURPOSE_REFUND: u8 = 5;
const PURPOSE_ENTRY: u8 = 3;
const PURPOSE_WON: u8 = 4;

const PHASE_HOME: u8 = 0;
const PHASE_FORFEITS: u8 = 1;
const PHASE_DONE: u8 = 2;

/// One place of a result: a seat and its share of the forfeits after fees.
#[derive(Debug, Clone, Copy, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct SeatPlace {
    pub seat: u8,
    pub share_bps: u16,
}

/// An early refund: Gemas of the seat's own entry back, fee-free.
#[derive(Debug, Clone, Copy, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct SeatRefund {
    pub seat: u8,
    pub gemas: u64,
}

/// What a Game reports for a many-seat Match.
#[derive(Debug, Clone, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum ManySeatResult {
    /// Every entry back in full: no fee, no win (nobody acted, an outage).
    Refund,
    /// The places in finishing order (first place first, shares not increasing, together
    /// 10,000) and the early refunds (seats in ascending order). A seat in neither list loses
    /// its whole entry; a placed seat gets its whole entry back.
    Placed {
        places: Vec<SeatPlace>,
        refunds: Vec<SeatRefund>,
    },
}

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

/// One place as the run keeps it: who is paid, and how much.
#[anchor_lang::zero_copy]
#[derive(Debug, PartialEq, Eq)]
pub struct PlaceSlot {
    pub seat: u8,
    share_bps: [u8; 2],
    /// The Player's Offer share of a Backed seat's winnings (0 unbacked).
    player_share_bps: [u8; 2],
    won: [u8; 8],
    pub player: [u8; 32],
    pub funder: [u8; 32],
}

impl PlaceSlot {
    pub fn share_bps(&self) -> u16 {
        u16::from_le_bytes(self.share_bps)
    }
    /// Forfeited Gemas this place gets on top of its entry.
    pub fn won(&self) -> u64 {
        u64::from_le_bytes(self.won)
    }
    fn backed(&self) -> bool {
        self.player != self.funder
    }
}

/// The frozen plan of a many-seat run and its cursor, read in place inside `ManySeatRecord`.
#[anchor_lang::zero_copy]
#[derive(Debug, PartialEq, Eq)]
pub struct SeatRun {
    kind: u8,
    phase: u8,
    n_places: u8,
    place_i: u8,
    seat_i: u8,
    /// 1 once the cursor entered `seat_i` (its `seat_left` is loaded).
    in_seat: u8,
    /// Seated seats the home phase has passed.
    visited: u8,
    fees_capped: u8,
    /// Home phase: the next line to look at; forfeits phase: one past it (walked backward).
    line_i: [u8; 4],
    /// Gemas the current seat still moves in this phase.
    seat_left: [u8; 8],
    /// Gemas the current place still gets, and of them the Backed Player's share still owed.
    won_left: [u8; 8],
    player_left: [u8; 8],
    fees: [[u8; 8]; 3],
    cut_left: [[u8; 8]; 3],
    chunks: [u8; 4],
    steps: [u8; 4],
    pub places: [PlaceSlot; MAX_PLACES],
}

impl SeatRun {
    pub const LEN: usize = 8 + 4 + 24 + 48 + 8 + 77 * MAX_PLACES;

    pub fn kind(&self) -> u8 {
        self.kind
    }
    pub fn is_refund(&self) -> bool {
        self.kind != KIND_WIN
    }
    pub fn fees(&self) -> [u64; 3] {
        self.fees.map(u64::from_le_bytes)
    }
    pub fn fees_capped(&self) -> bool {
        self.fees_capped != 0
    }
    pub fn places(&self) -> &[PlaceSlot] {
        &self.places[..self.n_places as usize]
    }
    pub fn chunks(&self) -> u32 {
        u32::from_le_bytes(self.chunks)
    }
    pub fn steps(&self) -> u32 {
        u32::from_le_bytes(self.steps)
    }
    fn seat_left(&self) -> u64 {
        u64::from_le_bytes(self.seat_left)
    }
    fn set_seat_left(&mut self, g: u64) {
        self.seat_left = g.to_le_bytes();
    }
    fn won_left(&self) -> u64 {
        u64::from_le_bytes(self.won_left)
    }
    fn player_left(&self) -> u64 {
        u64::from_le_bytes(self.player_left)
    }
    fn line_i(&self) -> usize {
        u32::from_le_bytes(self.line_i) as usize
    }
    fn set_line_i(&mut self, i: usize) -> LcResult<()> {
        self.line_i = u32::try_from(i)
            .map_err(|_| LifecycleError::Math)?
            .to_le_bytes();
        Ok(())
    }
    fn cut_left(&self, class: usize) -> u64 {
        u64::from_le_bytes(self.cut_left[class])
    }

    /// Gemas of the forfeits not paid out yet: fees still to cut and winnings still owed.
    fn owed(&self) -> u64 {
        let later: u64 = self.places[..self.n_places as usize]
            .iter()
            .skip(self.place_i as usize + 1)
            .map(PlaceSlot::won)
            .sum();
        (0..3).map(|c| self.cut_left(c)).sum::<u64>() + self.won_left() + later
    }

    /// Enters place `i`: its winnings, and the Backed Player's share of them.
    fn enter_place(&mut self, i: usize) -> LcResult<()> {
        self.place_i = i as u8;
        let slot = self.places[i];
        self.won_left = slot.won;
        let player = if slot.backed() {
            player_share(slot.won(), u16::from_le_bytes(slot.player_share_bps))?
        } else {
            0
        };
        self.player_left = player.to_le_bytes();
        Ok(())
    }

    fn next_seat(&mut self) {
        self.seat_i += 1;
        self.in_seat = 0;
    }
}

/// The seats and Pots a chunk can reach: the seat pages and Pot accounts the transaction loaded.
pub trait Seats<B: PotBacking> {
    /// A copy of seat `i`. `MissingAccount` when its page was not supplied.
    fn seat(&mut self, i: u8) -> LcResult<Seat>;
    fn set_seat(&mut self, i: u8, seat: &Seat) -> LcResult<()>;
    /// The Pot of seat `i`, the account `key`. `MissingAccount` when it was not supplied.
    fn pot(&mut self, i: u8, key: &Key) -> LcResult<&mut PotPages<B>>;
}

/// Where a chunk credits: a [`Settlement`] plus the slots held for the seat being walked.
pub trait SeatCredits {
    fn settlement(&mut self) -> &mut dyn Settlement;
    /// From now on `owner`'s credits may use `slots` held slots (the seat's join-time hold).
    fn set_hold(&mut self, owner: &Key, slots: u32);
    /// What is left of `owner`'s held slots.
    fn hold_of(&self, owner: &Key) -> u32;
}

/// What starting a run fixed, for the events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Started {
    pub kind: u8,
    /// Gemas the early refunds give back (0 for a refund run).
    pub refunded: u64,
    pub forfeited: u64,
    /// The Account counted as first place's opponent (`MatchWon.loser`): second place's Player,
    /// or with one place the unplaced seat that forfeited most (lowest seat on equal forfeits).
    pub opponent: Key,
}

/// Moves `k` Gemas of the Pot line at `at` to `to` on `side`: the whole line, or a split part.
fn give<B: PotBacking>(
    p: &mut PotPages<B>,
    at: usize,
    w: &mut dyn Settlement,
    to: &Key,
    orig: &Line,
    k: u64,
    side: u8,
) -> LcResult<Credit> {
    if k == orig.amount {
        let mut moved = *orig;
        moved.side = side;
        let placed = w.credit(to, &moved)?;
        let mut empty = *orig;
        empty.amount = 0;
        empty.uncovered = 0;
        p.set(at, &empty)?;
        return Ok(Credit {
            line: moved,
            owner: Some(*to),
            placement: placement(placed),
        });
    }
    w.books().snapshot(&orig.source)?;
    let mut rest = *orig;
    let mut part = SourceBook::blank_line(side, orig.due_at, orig.source, orig.class, orig.tranche);
    {
        let (book, history) = w.books().book_with_history(&orig.source)?;
        book.transfer(&mut rest, &mut part, k, &*history)?;
    }
    let placed = match w.credit(to, &part) {
        Ok(p) => p,
        Err(e) => {
            w.books().rollback(&orig.source)?;
            return Err(e);
        }
    };
    p.set(at, &rest)?;
    Ok(Credit {
        line: part,
        owner: Some(*to),
        placement: placement(placed),
    })
}

fn missing_page(e: LifecycleError) -> SeatError {
    match e {
        LifecycleError::MissingAccount => SeatError::PagesMissing,
        _ => SeatError::Math,
    }
}

impl ManySeatRecord {
    /// Seat indexes the car can have (its pages' seats).
    fn seat_span(&self) -> u8 {
        (self.pages as usize * super::SEATS_PER_PAGE).min(MAX_SEATS as usize) as u8
    }

    fn ready_to_start(&self, now: i64, deploy_slot_now: u64) -> SeatResult<()> {
        if self.stage() != ManyStage::Departed {
            return Err(SeatError::NotDeparted);
        }
        if deploy_slot_now != self.deploy_slot() {
            return Err(SeatError::GameUpgraded);
        }
        if now >= self.deadline_abs() {
            return Err(SeatError::PastDeadline);
        }
        Ok(())
    }

    fn begin(&mut self, kind: u8) {
        self.run = bytemuck::Zeroable::zeroed();
        self.run.kind = kind;
        self.set_stage(if kind == KIND_WIN {
            ManyStage::Settling
        } else {
            ManyStage::Refunding
        });
    }

    /// The Game's settle authority starts settling a Departed car with `result`: checks it,
    /// writes each named seat's place and refund into its page, and freezes the payout. Atomic:
    /// on `Err` nothing changed (the instruction fails as a whole).
    pub fn start_settle<B: PotBacking>(
        &mut self,
        now: i64,
        authority: &Key,
        deploy_slot_now: u64,
        leaderboard_bps: u16,
        result: &ManySeatResult,
        seats: &mut dyn Seats<B>,
    ) -> SeatResult<Started> {
        if *authority != self.settle_authority {
            return Err(SeatError::NotGame);
        }
        self.ready_to_start(now, deploy_slot_now)?;
        let (places, refunds) = match result {
            ManySeatResult::Refund => {
                self.begin(KIND_BY_GAME);
                return Ok(Started {
                    kind: KIND_BY_GAME,
                    refunded: 0,
                    forfeited: 0,
                    opponent: [0; 32],
                });
            }
            ManySeatResult::Placed { places, refunds } => (places, refunds),
        };
        let entry = self.entry();
        let mut total_bps = 0u32;
        let mut last_share = u16::MAX;
        if places.is_empty() || places.len() > MAX_PLACES {
            return Err(SeatError::BadResult);
        }
        let mut slots = [PlaceSlot::zeroed(); MAX_PLACES];
        for (k, place) in places.iter().enumerate() {
            if place.share_bps == 0 || place.share_bps > last_share || place.seat >= self.max_seats
            {
                return Err(SeatError::BadResult);
            }
            last_share = place.share_bps;
            total_bps += place.share_bps as u32;
            let mut s = seats.seat(place.seat).map_err(missing_page)?;
            if s.state() != SeatState::Seated || s.place != 0 {
                return Err(SeatError::BadResult);
            }
            s.place = k as u8 + 1;
            s.place_bps = place.share_bps.to_le_bytes();
            s.refund = [0; 8];
            seats.set_seat(place.seat, &s).map_err(missing_page)?;
            slots[k] = PlaceSlot {
                seat: place.seat,
                share_bps: place.share_bps.to_le_bytes(),
                player_share_bps: s.share_bps,
                won: [0; 8],
                player: s.player,
                funder: s.funder,
            };
        }
        if total_bps != BPS as u32 {
            return Err(SeatError::BadResult);
        }
        let mut refunded = 0u64;
        let mut last_seat: Option<u8> = None;
        for r in refunds {
            if last_seat.is_some_and(|l| r.seat <= l)
                || r.seat >= self.max_seats
                || r.gemas == 0
                || r.gemas > entry
            {
                return Err(SeatError::BadResult);
            }
            last_seat = Some(r.seat);
            let mut s = seats.seat(r.seat).map_err(missing_page)?;
            if s.state() != SeatState::Seated || s.place != 0 {
                return Err(SeatError::BadResult);
            }
            s.refund = r.gemas.to_le_bytes();
            seats.set_seat(r.seat, &s).map_err(missing_page)?;
            refunded = refunded.checked_add(r.gemas).ok_or(SeatError::Math)?;
        }
        let shares: Vec<u16> = places.iter().map(|p| p.share_bps).collect();
        let payout = plan_payout(
            entry,
            self.seated,
            &shares,
            refunded,
            &self.terms(),
            leaderboard_bps,
        )?;
        if payout.forfeited == 0 {
            // nothing changes hands: every entry comes back, no fee, no win
            self.begin(KIND_BY_GAME);
            return Ok(Started {
                kind: KIND_BY_GAME,
                refunded,
                forfeited: 0,
                opponent: [0; 32],
            });
        }
        let opponent = if places.len() > 1 {
            slots[1].player
        } else {
            let mut best: Option<(u64, Key)> = None;
            for i in 0..self.seat_span() {
                let s = seats.seat(i).map_err(missing_page)?;
                if s.state() != SeatState::Seated || s.place != 0 {
                    continue;
                }
                let lost = entry - s.refund();
                if best.is_none_or(|(b, _)| lost > b) {
                    best = Some((lost, s.player));
                }
            }
            best.ok_or(SeatError::BadResult)?.1
        };
        self.begin(KIND_WIN);
        for (slot, won) in slots.iter_mut().zip(payout.won) {
            slot.won = won.to_le_bytes();
        }
        let run = &mut self.run;
        run.places = slots;
        run.n_places = places.len() as u8;
        run.fees = payout.fees.map(u64::to_le_bytes);
        run.cut_left = run.fees;
        run.fees_capped = u8::from(payout.fees_capped);
        run.enter_place(0).map_err(|_| SeatError::Math)?;
        Ok(Started {
            kind: KIND_WIN,
            refunded,
            forfeited: payout.forfeited,
            opponent,
        })
    }

    /// Anyone starts refunding a Departed car once its refund time passed (Abandoned) or when the
    /// Game's build changed since it opened (GameUpgraded). Returns the run kind.
    pub fn start_refund(&mut self, now: i64, deploy_slot_now: u64) -> SeatResult<u8> {
        if self.stage() != ManyStage::Departed {
            return Err(SeatError::NotDeparted);
        }
        let kind = if deploy_slot_now != self.deploy_slot() {
            KIND_GAME_UPGRADED
        } else if now >= self.refund_after() || now >= self.deadline_abs() {
            KIND_ABANDONED
        } else {
            return Err(SeatError::NotExpired);
        };
        self.begin(kind);
        Ok(kind)
    }

    /// Runs up to `max_steps` steps of the run, each one credit. Permissionless and idempotent:
    /// progress lives in the record and in the Pots (emptied in place), so a replayed or
    /// interleaved chunk continues where the last stopped; a paid run does nothing.
    pub fn chunk<B: PotBacking>(
        &mut self,
        seats: &mut dyn Seats<B>,
        w: &mut dyn SeatCredits,
        max_steps: u32,
    ) -> LcResult<ChunkReport> {
        let prior_steps = self.run.steps();
        match self.stage() {
            ManyStage::Settling | ManyStage::Refunding => {}
            ManyStage::Paid => {
                return Ok(ChunkReport {
                    id: self.id(),
                    chunk_no: self.run.chunks(),
                    steps: 0,
                    done: true,
                    blocked: None,
                    prior_steps,
                    lines: Vec::new(),
                })
            }
            _ => return Err(LifecycleError::InvalidStage),
        }
        let mut steps = 0u32;
        let mut lines = Vec::with_capacity(max_steps.min(12) as usize);
        let mut blocked = None;
        let mut done = false;
        while steps < max_steps {
            match self.step(seats, w, &mut lines) {
                Ok(true) => steps += 1,
                Ok(false) => {
                    done = true;
                    break;
                }
                Err(e) => {
                    if steps == 0 {
                        return Err(e);
                    }
                    blocked = Some(e);
                    break;
                }
            }
        }
        if !done && blocked.is_none() && self.run.phase == PHASE_DONE {
            done = true;
        }
        if done {
            self.set_stage(ManyStage::Paid);
        }
        let run = &mut self.run;
        let mut chunks = run.chunks();
        if steps > 0 || done {
            chunks = chunks.checked_add(1).ok_or(LifecycleError::Math)?;
        }
        run.chunks = chunks.to_le_bytes();
        run.steps = prior_steps
            .checked_add(steps)
            .ok_or(LifecycleError::Math)?
            .to_le_bytes();
        Ok(ChunkReport {
            id: self.id(),
            chunk_no: chunks,
            steps,
            done,
            blocked,
            prior_steps,
            lines,
        })
    }

    fn step<B: PotBacking>(
        &mut self,
        seats: &mut dyn Seats<B>,
        w: &mut dyn SeatCredits,
        lines: &mut Vec<SettlementLine>,
    ) -> LcResult<bool> {
        let entry = self.entry();
        let refund_run = self.run.is_refund();
        loop {
            match self.run.phase {
                PHASE_HOME => {
                    if self.run.visited >= self.seated {
                        self.run.phase = PHASE_FORFEITS;
                        self.run.seat_i = 0;
                        self.run.in_seat = 0;
                        if self.run.owed() == 0 {
                            self.run.phase = PHASE_DONE;
                        }
                        continue;
                    }
                    let i = self.run.seat_i;
                    if i >= self.seat_span() {
                        return Err(LifecycleError::Inconsistent("fewer seats than seated"));
                    }
                    let mut s = seats.seat(i)?;
                    let whole = refund_run || s.place != 0;
                    if self.run.in_seat == 0 {
                        if s.state() != SeatState::Seated {
                            self.run.next_seat();
                            continue;
                        }
                        let left = if whole { entry } else { s.refund() };
                        if left == 0 {
                            self.run.next_seat();
                            self.run.visited += 1;
                            continue;
                        }
                        self.run.set_seat_left(left);
                        self.run.set_line_i(0)?;
                        self.run.in_seat = 1;
                    }
                    let funder = s.funder;
                    let seat_left = self.run.seat_left();
                    w.set_hold(&funder, s.hold());
                    let (at, before, credit, k) = {
                        let p = seats.pot(i, &s.pot)?;
                        let mut at = self.run.line_i();
                        while p.store().amount_at(at).is_some_and(|a| a == 0) {
                            at += 1;
                        }
                        let orig = p.get(at).ok_or(LifecycleError::Inconsistent(
                            "a seat's lines are short of what it gets back",
                        ))?;
                        let before = p
                            .store()
                            .snapshot(at)
                            .ok_or(LifecycleError::Inconsistent("line snapshot vanished"))?;
                        let k = orig.amount.min(seat_left);
                        let credit = give(p, at, w.settlement(), &funder, &orig, k, orig.side)?;
                        (at, before, credit, k)
                    };
                    s.set_hold(w.hold_of(&funder));
                    seats.set_seat(i, &s)?;
                    self.run.set_line_i(at)?;
                    self.run.set_seat_left(seat_left - k);
                    if seat_left == k {
                        self.run.next_seat();
                        self.run.visited += 1;
                    }
                    let purpose = if whole { PURPOSE_ENTRY } else { PURPOSE_REFUND };
                    lines.push(SettlementLine::new(i, at as u32, purpose, before, credit));
                    return Ok(true);
                }
                PHASE_FORFEITS => {
                    if self.run.owed() == 0 {
                        self.run.phase = PHASE_DONE;
                        continue;
                    }
                    let i = self.run.seat_i;
                    if i >= self.seat_span() {
                        return Err(LifecycleError::Inconsistent("forfeits short of the plan"));
                    }
                    let s = seats.seat(i)?;
                    if self.run.in_seat == 0 {
                        if s.state() != SeatState::Seated || s.place != 0 {
                            self.run.next_seat();
                            continue;
                        }
                        let left = entry
                            .checked_sub(s.refund())
                            .ok_or(LifecycleError::Inconsistent("refund above the entry"))?;
                        if left == 0 {
                            self.run.next_seat();
                            continue;
                        }
                        let n = seats.pot(i, &s.pot)?.len();
                        self.run.set_seat_left(left);
                        self.run.set_line_i(n)?;
                        self.run.in_seat = 1;
                    }
                    // the stream: fees first, then each place in order
                    let class = (0..3).find(|c| self.run.cut_left(*c) > 0);
                    if class.is_none() {
                        while self.run.won_left() == 0 {
                            let next = self.run.place_i as usize + 1;
                            if next >= self.run.n_places as usize {
                                return Err(LifecycleError::Inconsistent(
                                    "forfeits beyond the plan",
                                ));
                            }
                            self.run.enter_place(next)?;
                        }
                    }
                    let terms = self.terms();
                    let seat_left = self.run.seat_left();
                    let slot = self.run.places[self.run.place_i as usize];
                    let to_player = slot.backed() && self.run.player_left() > 0;
                    let (at, before, credit, k) = {
                        let p = seats.pot(i, &s.pot)?;
                        let mut at = self.run.line_i();
                        while at > 0 && p.store().amount_at(at - 1).is_some_and(|a| a == 0) {
                            at -= 1;
                        }
                        let at = at.checked_sub(1).ok_or(LifecycleError::Inconsistent(
                            "a seat's lines are short of its forfeit",
                        ))?;
                        let orig = p
                            .get(at)
                            .ok_or(LifecycleError::Inconsistent("line vanished"))?;
                        let before = p
                            .store()
                            .snapshot(at)
                            .ok_or(LifecycleError::Inconsistent("line snapshot vanished"))?;
                        let k = orig.amount.min(seat_left);
                        match class {
                            Some(c) => {
                                let k = k.min(self.run.cut_left(c));
                                let credit = cut_step(p, at, &terms, w.settlement(), c as u8, k)?;
                                (at, before, credit, k)
                            }
                            None => {
                                let mut k = k.min(self.run.won_left());
                                let to = if to_player {
                                    k = k.min(self.run.player_left());
                                    slot.player
                                } else {
                                    slot.funder
                                };
                                let credit = give(p, at, w.settlement(), &to, &orig, k, SIDE_WON)?;
                                (at, before, credit, k)
                            }
                        }
                    };
                    let purpose = match class {
                        Some(c) => {
                            self.run.cut_left[c] = (self.run.cut_left(c) - k).to_le_bytes();
                            c as u8
                        }
                        None => {
                            self.run.won_left = (self.run.won_left() - k).to_le_bytes();
                            if to_player {
                                self.run.player_left = (self.run.player_left() - k).to_le_bytes();
                            }
                            PURPOSE_WON
                        }
                    };
                    self.run.set_line_i(at + 1)?;
                    self.run.set_seat_left(seat_left - k);
                    if seat_left == k {
                        self.run.next_seat();
                    }
                    if self.run.owed() == 0 {
                        self.run.phase = PHASE_DONE;
                    }
                    lines.push(SettlementLine::new(i, at as u32, purpose, before, credit));
                    return Ok(true);
                }
                _ => return Ok(false),
            }
        }
    }

    /// Closes one seat of a paid car (its Pot, mark and hold are the instruction's): the seat is
    /// free and the car has one seat fewer to close.
    pub fn close_seat(&mut self, seat: &mut Seat) -> SeatResult<()> {
        if self.stage() != ManyStage::Paid {
            return Err(SeatError::NotPaid);
        }
        if seat.state() != SeatState::Seated {
            return Err(SeatError::BadResult);
        }
        seat.clear();
        self.seated = self.seated.checked_sub(1).ok_or(SeatError::Math)?;
        Ok(())
    }

    /// Closes a car with no seat left: empty before departure, or paid with every seat closed.
    pub fn close_car(&mut self) -> SeatResult<()> {
        if self.stage() == ManyStage::Boarding {
            return self.close_empty();
        }
        if self.stage() != ManyStage::Paid {
            return Err(SeatError::NotPaid);
        }
        if self.seated != 0 {
            return Err(SeatError::NotEmpty);
        }
        self.set_stage(ManyStage::Closed);
        Ok(())
    }
}

/// What the next steps of a run touch, so a client knows which accounts to pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ahead {
    /// Seat pages read (every seat the cursor passes, moved or skipped).
    pub pages: Vec<u8>,
    /// Seats whose lines move (their Pot).
    pub seats: Vec<u8>,
    /// Accounts credited (basket and spill).
    pub owners: Vec<Key>,
    /// Sources of the lines that move (their book).
    pub sources: Vec<Key>,
    /// Sources a fee is cut from (also their Source and Position).
    pub cut_sources: Vec<Key>,
}

fn add_key(v: &mut Vec<Key>, k: Key) {
    if !v.contains(&k) {
        v.push(k);
    }
}

impl ManySeatRecord {
    /// What the next `max_steps` steps touch, walking the same cursor as [`Self::chunk`] over the
    /// line amounts only. `seats[i]` and `lines[i]` are seat `i` and its Pot's lines.
    pub fn ahead(&self, seats: &[Seat], lines: &[Vec<Line>], max_steps: usize) -> Ahead {
        let mut out = Ahead::default();
        if !matches!(self.stage(), ManyStage::Settling | ManyStage::Refunding) {
            return out;
        }
        let entry = self.entry();
        let mut r = self.run;
        let mut amounts: Vec<Vec<u64>> = lines
            .iter()
            .map(|l| l.iter().map(|x| x.amount).collect())
            .collect();
        let refund_run = r.is_refund();
        let mut left = max_steps;
        let span = (seats.len() as u8).min(self.seat_span());
        while left > 0 && r.phase != PHASE_DONE {
            if r.phase == PHASE_HOME {
                if r.visited >= self.seated || r.seat_i >= span {
                    r.phase = if r.owed() == 0 {
                        PHASE_DONE
                    } else {
                        PHASE_FORFEITS
                    };
                    r.seat_i = 0;
                    r.in_seat = 0;
                    continue;
                }
                let i = r.seat_i as usize;
                let s = &seats[i];
                let page = (i / super::SEATS_PER_PAGE) as u8;
                if !out.pages.contains(&page) {
                    out.pages.push(page);
                }
                if r.in_seat == 0 {
                    let whole = refund_run || s.place != 0;
                    let want = if whole { entry } else { s.refund() };
                    if s.state() != SeatState::Seated || want == 0 {
                        if s.state() == SeatState::Seated {
                            r.visited += 1;
                        }
                        r.next_seat();
                        continue;
                    }
                    r.set_seat_left(want);
                    r.line_i = [0; 4];
                    r.in_seat = 1;
                }
                let Some(at) = (r.line_i()..amounts[i].len()).find(|j| amounts[i][*j] > 0) else {
                    break;
                };
                let k = amounts[i][at].min(r.seat_left());
                amounts[i][at] -= k;
                add_key(&mut out.owners, s.funder);
                add_key(&mut out.sources, lines[i][at].source);
                if !out.seats.contains(&(i as u8)) {
                    out.seats.push(i as u8);
                }
                r.line_i = (at as u32).to_le_bytes();
                r.set_seat_left(r.seat_left() - k);
                if r.seat_left() == 0 {
                    r.next_seat();
                    r.visited += 1;
                }
                left -= 1;
            } else {
                if r.owed() == 0 || r.seat_i >= span {
                    break;
                }
                let i = r.seat_i as usize;
                let s = &seats[i];
                let page = (i / super::SEATS_PER_PAGE) as u8;
                if !out.pages.contains(&page) {
                    out.pages.push(page);
                }
                if r.in_seat == 0 {
                    let lost = entry.saturating_sub(s.refund());
                    if s.state() != SeatState::Seated || s.place != 0 || lost == 0 {
                        r.next_seat();
                        continue;
                    }
                    r.set_seat_left(lost);
                    r.line_i = (amounts[i].len() as u32).to_le_bytes();
                    r.in_seat = 1;
                }
                let Some(at) = (0..r.line_i()).rev().find(|j| amounts[i][*j] > 0) else {
                    break;
                };
                let mut k = amounts[i][at].min(r.seat_left());
                let source = lines[i][at].source;
                if let Some(c) = (0..3).find(|c| r.cut_left(*c) > 0) {
                    k = k.min(r.cut_left(c));
                    r.cut_left[c] = (r.cut_left(c) - k).to_le_bytes();
                    add_key(&mut out.cut_sources, source);
                    if c == 1 {
                        if let Some(studio) = self.terms().studio_owner {
                            add_key(&mut out.owners, studio);
                        }
                    }
                } else {
                    while r.won_left() == 0 && (r.place_i as usize + 1) < r.n_places as usize {
                        if r.enter_place(r.place_i as usize + 1).is_err() {
                            return out;
                        }
                    }
                    let slot = r.places[r.place_i as usize];
                    k = k.min(r.won_left());
                    if slot.backed() && r.player_left() > 0 {
                        k = k.min(r.player_left());
                        r.player_left = (r.player_left() - k).to_le_bytes();
                        add_key(&mut out.owners, slot.player);
                    } else {
                        add_key(&mut out.owners, slot.funder);
                    }
                    r.won_left = (r.won_left() - k).to_le_bytes();
                }
                amounts[i][at] -= k;
                add_key(&mut out.sources, source);
                if !out.seats.contains(&(i as u8)) {
                    out.seats.push(i as u8);
                }
                r.line_i = (at as u32 + 1).to_le_bytes();
                r.set_seat_left(r.seat_left() - k);
                if r.seat_left() == 0 {
                    r.next_seat();
                }
                left -= 1;
            }
        }
        out
    }
}

impl PlaceSlot {
    fn zeroed() -> Self {
        bytemuck::Zeroable::zeroed()
    }
}

#[cfg(test)]
mod tests;

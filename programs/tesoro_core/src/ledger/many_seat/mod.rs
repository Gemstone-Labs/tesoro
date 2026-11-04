//! Many-seat Matches (ADR 0015): a Match of 2 to 100 seats, boarding part. Pure Rust: no
//! accounts, no clock. The instruction layer (`instructions::many_seat`) supplies both.
//!
//! * **Open.** The Game opens an empty car with its seat bounds (`min_seats`, `max_seats`).
//! * **Boarding.** Players take seats until `max_seats`; each seat is a Party plus its own Pot.
//!   `min_since` is when the seat count last reached `min_seats` (0 while below), and
//!   `first_min_at` when it first did (never cleared), so a Game can run its countdown from
//!   either. A Player may step off any time before departure.
//! * **Departure.** The Game's authority ends boarding with at least `min_seats` seated. After it
//!   nobody boards or steps off; the result and the settlement follow (ticket 03).
//! * **Deadlines.** Settlement must start before `deadline_abs` (7 days after open, as
//!   head-to-head). Seats and departure stop one hour earlier (`boarding_ends`), so a car that
//!   leaves always has that hour to finish.
//!
//! Seats live in pages of [`SEATS_PER_PAGE`] (`state::SeatPage`); a seat's index is
//! `page * SEATS_PER_PAGE + slot` and never changes while the seat is taken.

use super::lifecycle::{MatchId, MatchMeta, Terms, MAX_MATCH_LIFETIME_SECS};

pub mod settle;
use super::{is_ladder_entry, Key, MATCH_TIMEOUT_SECS};
pub use settle::*;

/// Most seats a many-seat Match has.
pub const MAX_SEATS: u8 = 100;
/// Fewest seats a many-seat Match departs with.
pub const MIN_SEATS: u8 = 2;
pub const SEATS_PER_PAGE: usize = 10;
pub const MAX_SEAT_PAGES: u8 = MAX_SEATS / SEATS_PER_PAGE as u8;
/// Seats and departure stop this long before the absolute deadline.
pub const BOARDING_MARGIN_SECS: i64 = MATCH_TIMEOUT_SECS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeatError {
    BadSeatBounds,
    BadEntry,
    NotBoarding,
    BoardingOver,
    Full,
    BelowMinimum,
    NotGame,
    GameUpgraded,
    NotEmpty,
    /// The result names a seat twice, an empty seat, a refund above the entry or on a placed
    /// seat, or place shares that are not 1 to 10 places summing to 10,000.
    BadResult,
    FeeTooHigh,
    /// The car has not left (or already settles).
    NotDeparted,
    /// Seven days after open: only a refund can start.
    PastDeadline,
    /// A seat page the step needs was not passed.
    PagesMissing,
    /// Nobody but the Game may refund the car yet.
    NotExpired,
    /// The car's run has not paid out yet.
    NotPaid,
    Math,
}

pub type SeatResult<T> = Result<T, SeatError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManyStage {
    Boarding,
    /// The Game ended boarding: the seats are the ride.
    Departed,
    /// The Game's result is frozen and the chunks pay it.
    Settling,
    /// Every entry is going back (the Game's refund, an abandoned car, an upgraded Game).
    Refunding,
    /// Every Gema is paid; the seats close one by one, then the car.
    Paid,
    /// Nothing is owed any more.
    Closed,
}

/// The many-seat Match record (`state::ManySeatMatch`), read and written in place.
///
/// Byte arrays only (alignment 1, no padding), and no Borsh: a record that shared `MatchId`,
/// `MatchMeta` or `Terms` Borsh code with the head-to-head `MatchState` changed how the
/// head-to-head settle chunk was compiled (its 12-step worst case rose 24-30 CU), so the
/// many-seat path keeps its own layout and builds those values through accessors.
#[anchor_lang::zero_copy]
#[derive(Debug, PartialEq, Eq)]
pub struct ManySeatRecord {
    /// The id: the opener's Account and its `next_match` (little endian).
    pub opener: [u8; 32],
    pub n: [u8; 8],
    pub game: [u8; 32],
    /// The Game's settle authority when the car opened: only it departs and settles.
    pub settle_authority: [u8; 32],
    pub studio_owner: [u8; 32],
    deploy_slot: [u8; 8],
    entry: [u8; 8],
    opened_at: [u8; 8],
    deadline_abs: [u8; 8],
    min_since: [u8; 8],
    /// When `seated` first reached `min_seats`; never cleared (a Game's fixed departure time).
    first_min_at: [u8; 8],
    departed_at: [u8; 8],
    platform_bps: [u8; 2],
    studio_bps: [u8; 2],
    has_studio_owner: u8,
    studio_priority: u8,
    challenge: u8,
    asset: u8,
    listed: u8,
    pub min_seats: u8,
    pub max_seats: u8,
    /// Seats taken right now.
    pub seated: u8,
    /// Seat pages created so far (always in order, page `pages` is the next one).
    pub pages: u8,
    stage: u8,
    pub reserved: [u8; 6],
    /// From departure: anyone may refund the car from this time on (`settle::start_refund`).
    refund_after: [u8; 8],
    /// The run (ticket 03), fixed when settling starts. See `settle`.
    pub(crate) run: SeatRun,
}

const BOARDING: u8 = 0;
const DEPARTED: u8 = 1;
const CLOSED: u8 = 2;
const SETTLING: u8 = 3;
const REFUNDING: u8 = 4;
const PAID: u8 = 5;

/// Anyone may refund a car this long after it left, unless the Game settled it first.
pub const REFUND_AFTER_SECS: i64 = 24 * 60 * 60;

impl ManySeatRecord {
    pub const LEN: usize = 32 * 4 + 8 * 8 + 2 * 2 + 10 + 6 + 8 + SeatRun::LEN;

    #[allow(clippy::too_many_arguments)]
    pub fn open(
        id: MatchId,
        meta: MatchMeta,
        (game, settle_authority, deploy_slot): (Key, Key, u64),
        terms: Terms,
        entry: u64,
        sizes: &[u64],
        (min_seats, max_seats): (u8, u8),
        now: i64,
    ) -> SeatResult<Self> {
        if !(MIN_SEATS..=MAX_SEATS).contains(&min_seats)
            || !(min_seats..=MAX_SEATS).contains(&max_seats)
        {
            return Err(SeatError::BadSeatBounds);
        }
        if !is_ladder_entry(entry, sizes) {
            return Err(SeatError::BadEntry);
        }
        let deadline_abs = now
            .checked_add(MAX_MATCH_LIFETIME_SECS)
            .ok_or(SeatError::Math)?;
        Ok(Self {
            opener: id.opener,
            n: id.n.to_le_bytes(),
            game,
            settle_authority,
            studio_owner: terms.studio_owner.unwrap_or_default(),
            deploy_slot: deploy_slot.to_le_bytes(),
            entry: entry.to_le_bytes(),
            opened_at: now.to_le_bytes(),
            deadline_abs: deadline_abs.to_le_bytes(),
            min_since: [0; 8],
            first_min_at: [0; 8],
            departed_at: [0; 8],
            platform_bps: terms.platform_bps.to_le_bytes(),
            studio_bps: terms.studio_bps.to_le_bytes(),
            has_studio_owner: u8::from(terms.studio_owner.is_some()),
            studio_priority: u8::from(terms.studio_priority),
            challenge: u8::from(meta.challenge),
            asset: meta.asset,
            listed: u8::from(meta.listed),
            min_seats,
            max_seats,
            seated: 0,
            pages: 0,
            stage: BOARDING,
            reserved: [0; 6],
            refund_after: [0; 8],
            run: bytemuck::Zeroable::zeroed(),
        })
    }

    pub fn id(&self) -> MatchId {
        MatchId {
            opener: self.opener,
            n: u64::from_le_bytes(self.n),
        }
    }
    pub fn meta(&self) -> MatchMeta {
        MatchMeta {
            challenge: self.challenge != 0,
            asset: self.asset,
            listed: self.listed != 0,
        }
    }
    /// Fee terms snapshotted at open (the Leaderboard Fee is read when settling starts).
    pub fn terms(&self) -> Terms {
        Terms {
            platform_bps: u16::from_le_bytes(self.platform_bps),
            studio_bps: u16::from_le_bytes(self.studio_bps),
            studio_owner: (self.has_studio_owner != 0).then_some(self.studio_owner),
            studio_priority: self.studio_priority != 0,
        }
    }
    pub fn deploy_slot(&self) -> u64 {
        u64::from_le_bytes(self.deploy_slot)
    }
    pub fn entry(&self) -> u64 {
        u64::from_le_bytes(self.entry)
    }
    pub fn opened_at(&self) -> i64 {
        i64::from_le_bytes(self.opened_at)
    }
    /// Settlement must start before this; fixed at open.
    pub fn deadline_abs(&self) -> i64 {
        i64::from_le_bytes(self.deadline_abs)
    }
    /// When `seated` last reached `min_seats`; 0 while below it.
    pub fn min_since(&self) -> i64 {
        i64::from_le_bytes(self.min_since)
    }
    /// When `seated` first reached `min_seats`, 0 until then; a step-off never clears it.
    pub fn first_min_at(&self) -> i64 {
        i64::from_le_bytes(self.first_min_at)
    }
    pub fn departed_at(&self) -> i64 {
        i64::from_le_bytes(self.departed_at)
    }

    pub fn stage(&self) -> ManyStage {
        match self.stage {
            BOARDING => ManyStage::Boarding,
            DEPARTED => ManyStage::Departed,
            SETTLING => ManyStage::Settling,
            REFUNDING => ManyStage::Refunding,
            PAID => ManyStage::Paid,
            _ => ManyStage::Closed,
        }
    }

    fn set_stage(&mut self, stage: ManyStage) {
        self.stage = match stage {
            ManyStage::Boarding => BOARDING,
            ManyStage::Departed => DEPARTED,
            ManyStage::Settling => SETTLING,
            ManyStage::Refunding => REFUNDING,
            ManyStage::Paid => PAID,
            ManyStage::Closed => CLOSED,
        };
    }

    /// Anyone may refund the car from this time on (0 before departure).
    pub fn refund_after(&self) -> i64 {
        i64::from_le_bytes(self.refund_after)
    }

    /// Seats and departure are refused from this time on.
    pub fn boarding_ends(&self) -> i64 {
        self.deadline_abs().saturating_sub(BOARDING_MARGIN_SECS)
    }

    /// Usable slots of page `page`: a car of 25 seats has pages of 10, 10 and 5.
    pub fn page_slots(&self, page: u8) -> usize {
        let start = page as usize * SEATS_PER_PAGE;
        (self.max_seats as usize)
            .saturating_sub(start)
            .min(SEATS_PER_PAGE)
    }

    fn boarding(&self) -> SeatResult<()> {
        if self.stage != BOARDING {
            return Err(SeatError::NotBoarding);
        }
        Ok(())
    }

    /// Counts one more seat.
    pub fn take_seat(&mut self, now: i64) -> SeatResult<()> {
        self.boarding()?;
        if now >= self.boarding_ends() {
            return Err(SeatError::BoardingOver);
        }
        if self.seated >= self.max_seats {
            return Err(SeatError::Full);
        }
        self.seated += 1;
        if self.seated == self.min_seats {
            self.min_since = now.to_le_bytes();
            if self.first_min_at == [0; 8] {
                self.first_min_at = self.min_since;
            }
        }
        Ok(())
    }

    /// Counts one seat fewer (a step-off before departure).
    pub fn leave_seat(&mut self) -> SeatResult<()> {
        self.boarding()?;
        self.seated = self.seated.checked_sub(1).ok_or(SeatError::Math)?;
        if self.seated < self.min_seats {
            self.min_since = [0; 8];
        }
        Ok(())
    }

    /// The Game ends boarding. `deploy_slot_now` is the slot the Game's build is judged by (see
    /// `MatchRecord::start_settle`): a different build cannot take the car anywhere.
    pub fn depart(&mut self, now: i64, authority: &Key, deploy_slot_now: u64) -> SeatResult<()> {
        self.boarding()?;
        if *authority != self.settle_authority {
            return Err(SeatError::NotGame);
        }
        if now >= self.boarding_ends() {
            return Err(SeatError::BoardingOver);
        }
        if deploy_slot_now != self.deploy_slot() {
            return Err(SeatError::GameUpgraded);
        }
        if self.seated < self.min_seats {
            return Err(SeatError::BelowMinimum);
        }
        self.stage = DEPARTED;
        self.departed_at = now.to_le_bytes();
        let after = now
            .checked_add(REFUND_AFTER_SECS)
            .ok_or(SeatError::Math)?
            .min(self.deadline_abs());
        self.refund_after = after.to_le_bytes();
        Ok(())
    }

    /// Closes a car nobody sits in, before departure.
    pub fn close_empty(&mut self) -> SeatResult<()> {
        self.boarding()?;
        if self.seated != 0 {
            return Err(SeatError::NotEmpty);
        }
        self.stage = CLOSED;
        Ok(())
    }
}

/// Index of a seat in its Match.
pub fn seat_index(page: u8, slot: usize) -> u8 {
    (page as usize * SEATS_PER_PAGE + slot) as u8
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeatState {
    Empty,
    Seated,
}

/// What a join writes into a seat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeatFill {
    pub player: Key,
    pub funder: Key,
    /// The Player's share of a Backed seat's winnings (0 when unbacked).
    pub share_bps: u16,
    /// The Pot account holding the seat's entry lines, and how many lines it held.
    pub pot: Key,
    pub pot_lines: u32,
    /// Slots held in the funder's stores for the seat's lines coming back.
    pub hold: u32,
    /// Gemas the entry counted against the Entry Limit and the period they count in.
    pub counted: Option<(u64, i64)>,
}

/// One seat of a page. Byte arrays only (alignment 1, no padding), so a page is read in place.
/// `place_bps` and `refund` are the Game's result for the seat (ticket 03).
#[anchor_lang::zero_copy]
#[derive(Debug, PartialEq, Eq)]
pub struct Seat {
    pub state: u8,
    pub flags: u8,
    pub share_bps: [u8; 2],
    pub place_bps: [u8; 2],
    /// The seat's place in the Game's result (1 = first), 0 when unplaced (ticket 03).
    pub place: u8,
    pub reserved0: u8,
    pub pot_lines: [u8; 4],
    pub hold: [u8; 4],
    pub counted: [u8; 8],
    pub counted_window: [u8; 8],
    pub refund: [u8; 8],
    pub player: [u8; 32],
    pub funder: [u8; 32],
    pub pot: [u8; 32],
    pub reserved: [u8; 24],
}

const SEATED: u8 = 1;

impl Seat {
    pub const LEN: usize = 160;

    pub fn zeroed() -> Self {
        bytemuck::Zeroable::zeroed()
    }

    pub fn state(&self) -> SeatState {
        if self.state == SEATED {
            SeatState::Seated
        } else {
            SeatState::Empty
        }
    }

    pub fn fill(&mut self, f: &SeatFill) {
        *self = Self::zeroed();
        self.state = SEATED;
        self.share_bps = f.share_bps.to_le_bytes();
        self.pot_lines = f.pot_lines.to_le_bytes();
        self.hold = f.hold.to_le_bytes();
        if let Some((gemas, window)) = f.counted {
            self.counted = gemas.to_le_bytes();
            self.counted_window = window.to_le_bytes();
        }
        self.player = f.player;
        self.funder = f.funder;
        self.pot = f.pot;
    }

    pub fn clear(&mut self) {
        *self = Self::zeroed();
    }

    pub fn player(&self) -> Key {
        self.player
    }
    pub fn funder(&self) -> Key {
        self.funder
    }
    pub fn pot(&self) -> Key {
        self.pot
    }
    pub fn share_bps(&self) -> u16 {
        u16::from_le_bytes(self.share_bps)
    }
    pub fn pot_lines(&self) -> u32 {
        u32::from_le_bytes(self.pot_lines)
    }
    pub fn hold(&self) -> u32 {
        u32::from_le_bytes(self.hold)
    }
    /// Gemas counted against the Entry Limit at join and the period start they count in.
    pub fn counted(&self) -> Option<(u64, i64)> {
        let gemas = u64::from_le_bytes(self.counted);
        (gemas > 0).then(|| (gemas, i64::from_le_bytes(self.counted_window)))
    }
    /// Gemas of the entry the Game's result refunds (0 for a placed seat).
    pub fn refund(&self) -> u64 {
        u64::from_le_bytes(self.refund)
    }
    pub fn place_bps(&self) -> u16 {
        u16::from_le_bytes(self.place_bps)
    }
    pub fn set_hold(&mut self, slots: u32) {
        self.hold = slots.to_le_bytes();
    }
}

#[cfg(test)]
mod tests;

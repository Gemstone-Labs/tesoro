//! Many-seat Matches (ADR 0015): a Match of 2 to 100 seats, boarding part. Pure Rust: no
//! accounts, no clock. The instruction layer (`instructions::many_seat`) supplies both.
//!
//! * **Open.** The Game opens an empty car with its seat bounds (`min_seats`, `max_seats`).
//! * **Boarding.** Players take seats until `max_seats`; each seat is a Party plus its own Pot.
//!   `min_since` is when the seat count last reached `min_seats` (0 while below), so a Game can
//!   run its countdown from it. A Player may step off any time before departure.
//! * **Departure.** The Game's authority ends boarding with at least `min_seats` seated. After it
//!   nobody boards or steps off; the result and the settlement follow (ticket 03).
//! * **Deadlines.** Settlement must start before `deadline_abs` (7 days after open, as
//!   head-to-head). Seats and departure stop one hour earlier (`boarding_ends`), so a car that
//!   leaves always has that hour to finish.
//!
//! Seats live in pages of [`SEATS_PER_PAGE`] (`state::SeatPage`); a seat's index is
//! `page * SEATS_PER_PAGE + slot` and never changes while the seat is taken.

use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

use super::lifecycle::{MatchId, MatchMeta, Terms, MAX_MATCH_LIFETIME_SECS};
use super::{is_ladder_entry, Key, MATCH_TIMEOUT_SECS};

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
    Math,
}

pub type SeatResult<T> = Result<T, SeatError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum ManyStage {
    Boarding,
    /// The Game ended boarding: the seats are the ride.
    Departed,
    /// Nothing is owed any more (an empty car closed before departure).
    Closed,
}

/// The many-seat Match record (`state::ManySeatMatch`).
#[derive(Debug, Clone, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct ManySeatRecord {
    pub id: MatchId,
    pub meta: MatchMeta,
    pub game: Key,
    /// The Game's settle authority when the car opened: only it departs and settles.
    pub settle_authority: Key,
    /// The Game program's deploy slot when the car opened.
    pub deploy_slot: u64,
    pub terms: Terms,
    pub entry: u64,
    pub opened_at: i64,
    /// Settlement must start before this; fixed at open.
    pub deadline_abs: i64,
    pub min_seats: u8,
    pub max_seats: u8,
    /// Seats taken right now.
    pub seated: u8,
    /// Seat pages created so far (always in order, page `pages` is the next one).
    pub pages: u8,
    /// When `seated` last reached `min_seats`; 0 while below it.
    pub min_since: i64,
    pub departed_at: i64,
    stage: ManyStage,
}

impl ManySeatRecord {
    /// Borsh size of the record.
    pub const LEN: usize = 40 + 3 + 32 + 32 + 8 + (2 + 2 + 33 + 1) + 8 + 8 + 8 + 4 + 8 + 8 + 1;

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
            id,
            meta,
            game,
            settle_authority,
            deploy_slot,
            terms,
            entry,
            opened_at: now,
            deadline_abs,
            min_seats,
            max_seats,
            seated: 0,
            pages: 0,
            min_since: 0,
            departed_at: 0,
            stage: ManyStage::Boarding,
        })
    }

    pub fn stage(&self) -> ManyStage {
        self.stage
    }

    /// Seats and departure are refused from this time on.
    pub fn boarding_ends(&self) -> i64 {
        self.deadline_abs.saturating_sub(BOARDING_MARGIN_SECS)
    }

    /// Usable slots of page `page`: a car of 25 seats has pages of 10, 10 and 5.
    pub fn page_slots(&self, page: u8) -> usize {
        let start = page as usize * SEATS_PER_PAGE;
        (self.max_seats as usize)
            .saturating_sub(start)
            .min(SEATS_PER_PAGE)
    }

    fn boarding(&self) -> SeatResult<()> {
        if self.stage != ManyStage::Boarding {
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
            self.min_since = now;
        }
        Ok(())
    }

    /// Counts one seat fewer (a step-off before departure).
    pub fn leave_seat(&mut self) -> SeatResult<()> {
        self.boarding()?;
        self.seated = self.seated.checked_sub(1).ok_or(SeatError::Math)?;
        if self.seated < self.min_seats {
            self.min_since = 0;
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
        if deploy_slot_now != self.deploy_slot {
            return Err(SeatError::GameUpgraded);
        }
        if self.seated < self.min_seats {
            return Err(SeatError::BelowMinimum);
        }
        self.stage = ManyStage::Departed;
        self.departed_at = now;
        Ok(())
    }

    /// Closes a car nobody sits in, before departure.
    pub fn close_empty(&mut self) -> SeatResult<()> {
        self.boarding()?;
        if self.seated != 0 {
            return Err(SeatError::NotEmpty);
        }
        self.stage = ManyStage::Closed;
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
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Seat {
    pub state: u8,
    pub flags: u8,
    pub share_bps: [u8; 2],
    pub place_bps: [u8; 2],
    pub reserved0: [u8; 2],
    pub pot_lines: [u8; 4],
    pub hold: [u8; 4],
    pub counted: [u8; 8],
    pub counted_window: [u8; 8],
    pub refund: [u8; 8],
    pub player: Key,
    pub funder: Key,
    pub pot: Key,
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
}

#[cfg(test)]
mod tests;

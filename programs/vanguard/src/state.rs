//! Vanguard accounts and their conversion to and from the pure engine's `Game`.
//!
//! Three kinds of state, by who may read them:
//! - `Battle` (public): everything both Players and spectators may see, including the event ring.
//! - `Army` (one per seat, private to its Player): the ranks of that side's pieces, the Truck's fuel and the
//!   turn it last moved, and a move count. Anything that could reveal a hidden rank lives here.
//! - `Secret` (no reader): the folded entropy, the randomness output, the storm's turn and seed.
//!
//! A piece's number is the index of its start square (Italy 0-29, US 30-59), so `id % 30` indexes the ranks of its
//! army and the number says nothing about the rank.

use crate::engine::{
    self, Army as Side, EndReason, Event, Events, Game, LayoutPiece, Outcome, Piece, Record,
    Winner, CHAIN_CLOCK, PIECE_SLOTS, SQUARES, TRUCK,
};
use crate::VanguardError;
use anchor_lang::prelude::*;

pub const BATTLE_SEED: &[u8] = b"battle";
pub const ARMY_SEED: &[u8] = b"army";
pub const SECRET_SEED: &[u8] = b"secret";
pub const PROGRAM_CONFIG_SEED: &[u8] = b"config";
/// The PDA registered in tesoro_core as this Game's settlement authority.
pub const AUTHORITY_SEED: &[u8] = b"authority";

/// Seconds after creation within which both Players must have delegated and started the Match.
pub const START_WINDOW_SECS: i64 = 300;
/// How long tesoro_core keeps refunds closed to everyone but this Game. The longest Match is the 15-minute cap
/// plus the start window, closing and settling.
pub const TABLE_WINDOW_SECS: i64 = 24 * 60 * 60;
/// Seconds each Player has to contribute entropy once the permissions exist.
pub const ENTROPY_SECS: i64 = 60;

pub const STATUS_CREATED: u8 = 0;
/// Permissions exist; waiting for both secrets, the randomness and `deal`.
pub const STATUS_SETUP: u8 = 1;
pub const STATUS_LIVE: u8 = 2;
pub const STATUS_OVER: u8 = 3;
pub const STATUS_CANCELLED: u8 = 4;

/// `Battle.winner`: nobody yet.
pub const NO_WINNER: u8 = 255;
/// `Battle.winner`: a draw (seats are 0 and 1).
pub const DRAW: u8 = 2;
/// `Battle.reason`: no ending yet.
pub const NO_REASON: u8 = 255;
/// `Battle.us_seat` / `Army.side` before the draw.
pub const UNSET: u8 = 255;
/// `Battle.sq`: the piece is off the board (or the slot was never used).
pub const NO_SQ: u8 = 255;

/// Event ring: the last 16 actions, a record each, numbered by a 32-bit sequence.
pub const RING: usize = 16;
/// Payload bytes of one record: the biggest event is a storm (4 header bytes + 10 shifts of 3 bytes), padded to
/// 35 so a record is 40 bytes with no padding.
pub const RECORD_DATA: usize = 35;

pub const EVENT_MOVE: u8 = 1;
pub const EVENT_ATTACK: u8 = 2;
pub const EVENT_SPOTTED: u8 = 3;
pub const EVENT_RAID: u8 = 4;
pub const EVENT_STORM: u8 = 5;
pub const EVENT_TURN: u8 = 6;
pub const EVENT_END: u8 = 7;

#[zero_copy]
pub struct RingRecord {
    pub seq: u32,
    /// 0 for a slot never written, else one of the `EVENT_*` kinds.
    pub kind: u8,
    pub data: [u8; RECORD_DATA],
}

impl RingRecord {
    pub const EMPTY: RingRecord = RingRecord {
        seq: 0,
        kind: 0,
        data: [0; RECORD_DATA],
    };

    /// Fixed-size encoding of an engine event. Ids are piece numbers, squares are `row * 10 + col`.
    pub fn encode(r: &Record) -> RingRecord {
        let mut d = [0u8; RECORD_DATA];
        let kind = match r.event {
            Event::Move { id, from, to } => {
                d[..3].copy_from_slice(&[id, from, to]);
                EVENT_MOVE
            }
            Event::Attack {
                att,
                def,
                from,
                to,
                outcome,
                flash,
            } => {
                d[..7].copy_from_slice(&[
                    att,
                    def,
                    from,
                    to,
                    outcome_code(outcome),
                    flash[0],
                    flash[1],
                ]);
                EVENT_ATTACK
            }
            Event::Spotted { id } => {
                d[0] = id;
                EVENT_SPOTTED
            }
            Event::Raid { army, at } => {
                d[..2].copy_from_slice(&[army.idx() as u8, at]);
                EVENT_RAID
            }
            Event::Storm {
                col,
                index,
                dir,
                n,
                shifts,
            } => {
                d[..4].copy_from_slice(&[col as u8, index, dir as u8, n]);
                for (i, s) in shifts.iter().enumerate().take(engine::MAX_SHIFTS) {
                    d[4 + i * 3..7 + i * 3].copy_from_slice(&[s.id, s.from, s.to]);
                }
                EVENT_STORM
            }
            Event::Turn { turn, timed_out } => {
                d[..2].copy_from_slice(&[turn.idx() as u8, timed_out as u8]);
                EVENT_TURN
            }
            Event::End { winner, reason } => {
                d[..2].copy_from_slice(&[winner_code(winner), reason_code(reason)]);
                EVENT_END
            }
        };
        RingRecord {
            seq: r.seq,
            kind,
            data: d,
        }
    }
}

pub const fn outcome_code(o: Outcome) -> u8 {
    match o {
        Outcome::Win => 0,
        Outcome::Lose => 1,
        Outcome::Tie => 2,
        Outcome::Mine => 3,
        Outcome::Defuse => 4,
        Outcome::Truck => 5,
    }
}

/// 0 the US Army, 1 the Italian Army, 2 a draw.
pub const fn winner_code(w: Winner) -> u8 {
    match w {
        Winner::Army(a) => a as u8,
        Winner::Draw => 2,
    }
}

pub const fn reason_code(r: EndReason) -> u8 {
    match r {
        EndReason::Truck => 0,
        EndReason::Stuck => 1,
        EndReason::Timeouts => 2,
        EndReason::Cap => 3,
    }
}

const fn reason_of(code: u8) -> Option<EndReason> {
    match code {
        0 => Some(EndReason::Truck),
        1 => Some(EndReason::Stuck),
        2 => Some(EndReason::Timeouts),
        3 => Some(EndReason::Cap),
        _ => None,
    }
}

/// The program config: which validator the Battle may be delegated to. Set at deploy by the upgrade authority.
#[account]
#[derive(InitSpace, Debug)]
pub struct VanguardConfig {
    pub bump: u8,
    pub tee_validator: Pubkey,
}

/// The public Battle. Readable by both Players and by spectators; holds no hidden rank. Zero-copy: at 1.3 KB it
/// is too big to deserialize on the SBF stack. The layout has no padding (fields ordered by alignment, flags as
/// `u8`), so a client can read it at fixed offsets.
#[account(zero_copy)]
pub struct Battle {
    pub match_id: u64,
    /// Bit `id` set when that piece already moved this turn.
    pub moved: u64,
    pub start_deadline: i64,
    pub entropy_deadline: i64,
    /// The turn's deadline: whole rollup seconds.
    pub deadline: i64,
    pub started_at: i64,
    pub event_seq: u32,
    pub turn_no: u16,
    pub moves: u16,
    /// The last 16 records, slot `seq % 16`.
    pub ring: [RingRecord; RING],
    pub tesoro_match: Pubkey,
    pub players: [Pubkey; 2],
    /// Square of each piece number, `NO_SQ` when off the board.
    pub sq: [u8; PIECE_SLOTS],
    /// Revealed rank of each piece (0 while hidden). A piece that left the board keeps the rank it was shown with.
    pub shown: [u8; PIECE_SLOTS],
    /// The last squares each piece stood on, newest last (the shuttle rule).
    pub trail: [[u8; 6]; PIECE_SLOTS],
    pub trail_len: [u8; PIECE_SLOTS],
    pub bump: u8,
    /// Canonical bump of the `authority` PDA, stored so settlement never re-derives it.
    pub authority_bump: u8,
    /// Which seat plays the US Army (`UNSET` until `deal`).
    pub us_seat: u8,
    pub status: u8,
    /// 1 once settled or refunded (or found already refunded).
    pub finalized: u8,
    /// 1 once the permissions exist (so `close_match`, not `close_unstarted`, closes it).
    pub permissioned: u8,
    /// A seat, `DRAW` or `NO_WINNER`.
    pub winner: u8,
    pub reason: u8,
    /// The army to act: 0 US, 1 Italy.
    pub turn: u8,
    pub steps_left: u8,
    pub two_step_active: u8,
    pub storm_done: u8,
    /// Two-Step Turns banked per army.
    pub two_step: [u8; 2],
    /// Timeouts in a row per army.
    pub timeouts: [u8; 2],
    /// 1 when the depot each army raids is claimed.
    pub depot_claimed: [u8; 2],
    pub pad: [u8; 2],
}

impl Battle {
    /// Bind a freshly created (zeroed) Battle to a tesoro_core Match. In place: a Battle is too big to build on
    /// the stack.
    pub fn init(
        &mut self,
        bump: u8,
        authority_bump: u8,
        match_id: u64,
        tesoro_match: Pubkey,
        players: [Pubkey; 2],
        start_deadline: i64,
    ) {
        self.bump = bump;
        self.authority_bump = authority_bump;
        self.match_id = match_id;
        self.tesoro_match = tesoro_match;
        self.players = players;
        self.start_deadline = start_deadline;
        self.us_seat = UNSET;
        self.status = STATUS_CREATED;
        self.winner = NO_WINNER;
        self.reason = NO_REASON;
        self.steps_left = 1;
        self.sq = [NO_SQ; PIECE_SLOTS];
    }

    pub fn seat_of(&self, key: &Pubkey) -> Option<usize> {
        self.players.iter().position(|p| p == key)
    }

    /// The army a seat plays (after `deal`).
    pub fn side_of_seat(&self, seat: usize) -> Option<Side> {
        match self.us_seat {
            0 | 1 => Some(if seat == self.us_seat as usize {
                Side::Us
            } else {
                Side::It
            }),
            _ => None,
        }
    }

    fn seat_of_side(&self, side: Side) -> u8 {
        if side == Side::Us {
            self.us_seat
        } else {
            1 - self.us_seat.min(1)
        }
    }

    fn winner_of(&self) -> Option<Winner> {
        match self.winner {
            DRAW => Some(Winner::Draw),
            0 | 1 => Some(Winner::Army(if self.winner == self.us_seat {
                Side::Us
            } else {
                Side::It
            })),
            _ => None,
        }
    }

    /// The engine's `Game` with the public fields only: no piece is on the board. Enough for the checks that need
    /// no piece (the Two-Step Turn).
    pub fn shell(&self, storm_at: u16, storm_seed: u32) -> Result<Box<Game>> {
        let first = if self.turn == 0 { Side::Us } else { Side::It };
        let mut g = Box::new(
            Game::start(
                &[],
                first,
                storm_at,
                storm_seed,
                self.started_at,
                CHAIN_CLOCK,
            )
            .map_err(|_| error!(VanguardError::BadState))?,
        );
        g.depot_claimed = [self.depot_claimed[0] != 0, self.depot_claimed[1] != 0];
        g.turn_no = self.turn_no;
        g.moves = self.moves;
        g.two_step = self.two_step;
        g.steps_left = self.steps_left;
        g.two_step_active = self.two_step_active != 0;
        g.timeouts = self.timeouts;
        g.moved = self.moved;
        g.deadline = self.deadline;
        g.storm_done = self.storm_done != 0;
        g.event_seq = self.event_seq;
        if self.status == STATUS_OVER {
            g.winner = self.winner_of();
            g.reason = reason_of(self.reason);
        }
        Ok(g)
    }

    /// The engine's `Game`, with the ranks of both armies filled in from their private accounts.
    pub fn game(&self, armies: [&Army; 2], secret: &Secret) -> Result<Box<Game>> {
        let mut g = self.shell(secret.storm_at, secret.storm_seed)?;
        for id in 0..PIECE_SLOTS {
            let sq = self.sq[id];
            if sq == NO_SQ {
                continue;
            }
            if sq as usize >= SQUARES {
                return err!(VanguardError::BadState);
            }
            let side = side_of_id(id);
            let army = armies
                .iter()
                .find(|a| a.side == side.idx() as u8)
                .ok_or_else(|| error!(VanguardError::BadState))?;
            let rank = army.ranks[id % 30];
            g.pieces[id] = Piece {
                rank,
                army: side,
                sq,
                known: self.shown[id] != 0,
                fuel: if rank == TRUCK { army.fuel } else { 0 },
                trail: self.trail[id],
                trail_len: self.trail_len[id],
            };
            g.cells[sq as usize] = id as u8 + 1;
        }
        for a in armies {
            if let Some(side) = side_from(a.side) {
                g.truck_turn[side.idx()] = a.truck_turn;
            }
        }
        Ok(g)
    }

    /// Take the engine's result back into the public fields. `before` holds each piece's rank before the action,
    /// so a piece that left the board is shown with the rank it had.
    pub fn absorb(&mut self, g: &Game, before: &[u8; PIECE_SLOTS]) {
        for (id, (p, was)) in g.pieces.iter().zip(before.iter()).enumerate() {
            if p.rank == 0 {
                if self.sq[id] != NO_SQ {
                    self.shown[id] = *was;
                    self.sq[id] = NO_SQ;
                    self.trail_len[id] = 0;
                }
            } else {
                self.sq[id] = p.sq;
                self.shown[id] = if p.known { p.rank } else { 0 };
                self.trail[id] = p.trail;
                self.trail_len[id] = p.trail_len;
            }
        }
        self.turn = g.turn as u8;
        self.turn_no = g.turn_no;
        self.moves = g.moves;
        self.two_step = g.two_step;
        self.steps_left = g.steps_left;
        self.two_step_active = g.two_step_active as u8;
        self.timeouts = g.timeouts;
        self.moved = g.moved;
        self.deadline = g.deadline;
        self.storm_done = g.storm_done as u8;
        self.depot_claimed = [g.depot_claimed[0] as u8, g.depot_claimed[1] as u8];
        self.event_seq = g.event_seq;
        if let (Some(w), Some(r)) = (g.winner, g.reason) {
            self.status = STATUS_OVER;
            self.winner = match w {
                Winner::Draw => DRAW,
                Winner::Army(a) => self.seat_of_side(a),
            };
            self.reason = reason_code(r);
        }
    }

    pub fn push_events(&mut self, out: &Events) {
        for r in out.as_slice() {
            self.ring[(r.seq as usize) % RING] = RingRecord::encode(r);
        }
    }
}

/// US pieces start on rows 7-9 (numbers 30-59), Italian pieces on rows 0-2 (numbers 0-29).
pub const fn side_of_id(id: usize) -> Side {
    if id >= 30 {
        Side::Us
    } else {
        Side::It
    }
}

const fn side_from(code: u8) -> Option<Side> {
    match code {
        0 => Some(Side::Us),
        1 => Some(Side::It),
        _ => None,
    }
}

/// One side's private state.
#[account]
#[derive(InitSpace, Debug)]
pub struct Army {
    pub bump: u8,
    pub battle: Pubkey,
    pub seat: u8,
    pub player: Pubkey,
    /// 0 US, 1 Italy; `UNSET` until `deal`.
    pub side: u8,
    /// Rank of each of this side's pieces, by `id % 30`; 0 for an empty slot.
    pub ranks: [u8; 30],
    /// Supply Truck moves used.
    pub fuel: u8,
    /// The turn number the Truck last moved on.
    pub truck_turn: i32,
    /// Moves this side made, written on every move so a Truck move writes the account like any other.
    pub moves: u16,
}

impl Army {
    pub fn blank(bump: u8, battle: Pubkey, seat: u8, player: Pubkey) -> Army {
        Army {
            bump,
            battle,
            seat,
            player,
            side: UNSET,
            ranks: [0; 30],
            fuel: 0,
            truck_turn: -9,
            moves: 0,
        }
    }

    /// Write the drawn layout of `side` into the ranks.
    pub fn place(&mut self, side: Side, layout: &[LayoutPiece]) {
        self.side = side.idx() as u8;
        self.ranks = [0; 30];
        self.fuel = 0;
        self.truck_turn = -9;
        for p in layout.iter().filter(|p| p.army == side) {
            if let Some(id) = engine::start_index(p.sq) {
                self.ranks[id as usize % 30] = p.rank;
            }
        }
    }

    /// Take the Truck's fuel and last-moved turn back from the engine.
    pub fn absorb(&mut self, g: &Game) {
        let Some(side) = side_from(self.side) else {
            return;
        };
        self.truck_turn = g.truck_turn[side.idx()];
        let base = if side == Side::Us { 30 } else { 0 };
        for i in 0..30 {
            let p = &g.pieces[base + i];
            if p.rank == TRUCK {
                self.fuel = p.fuel;
            }
        }
    }

    pub fn wipe(&mut self) {
        self.ranks = [0; 30];
        self.fuel = 0;
        self.truck_turn = 0;
        self.moves = 0;
    }
}

/// The hidden randomness. No permission member can read it.
#[account]
#[derive(InitSpace, Debug)]
pub struct Secret {
    pub bump: u8,
    pub battle: Pubkey,
    pub entropy: [u8; 32],
    pub contributed: [bool; 2],
    pub vrf: [u8; 32],
    pub vrf_seen: bool,
    pub dealt: bool,
    /// The turn number on which the Dust Storm may blow.
    pub storm_at: u16,
    pub storm_seed: u32,
}

impl Secret {
    pub fn blank(bump: u8, battle: Pubkey) -> Secret {
        Secret {
            bump,
            battle,
            entropy: [0; 32],
            contributed: [false; 2],
            vrf: [0; 32],
            vrf_seen: false,
            dealt: false,
            storm_at: 0,
            storm_seed: 0,
        }
    }

    pub fn wipe(&mut self) {
        self.entropy = [0; 32];
        self.vrf = [0; 32];
        self.storm_at = 0;
        self.storm_seed = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_accounts_fit_a_cpi_creation() {
        for (name, size) in [
            ("battle", 8 + core::mem::size_of::<Battle>()),
            ("army", 8 + Army::INIT_SPACE),
            ("secret", 8 + Secret::INIT_SPACE),
            ("config", 8 + VanguardConfig::INIT_SPACE),
        ] {
            assert!(size <= 10_240, "{name} is {size} bytes");
        }
    }

    #[test]
    fn a_storm_fits_one_record() {
        const _: () = assert!(4 + engine::MAX_SHIFTS * 3 <= RECORD_DATA);
        assert_eq!(core::mem::size_of::<RingRecord>(), 40);
    }
}

#[cfg(test)]
mod layout {
    use super::*;

    #[test]
    fn the_battle_has_no_padding_and_a_fixed_size() {
        assert_eq!(core::mem::size_of::<Battle>(), 1352);
    }
}

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
    self, Army as Side, Clock, EndReason, Event, Events, Game, LayoutPiece, Outcome, Piece, Record,
    Winner, CAP_SECS, GRACE_SECS, MOVE_CAP, OPENING_GRACE_SECS, PIECE_SLOTS, RESOLVE_SLACK_SECS,
    RULES_VERSION, SQUARES, STORM_FROM, STORM_TO, TRUCK, TURN_SECS,
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
/// Seconds after the start deadline by which the Match must be dealt. Past `setup_deadline` nothing can go Live and
/// `claim_timeout` cancels, so a Match whose Players or oracle stall is refunded long before tesoro_core's deadline.
pub const SETUP_GRACE_SECS: i64 = 180;
/// `Battle.layout_version`. Bump it when the field layout of `Battle` changes, so a client reading a Battle that was
/// created before an upgrade knows which offsets to use.
pub const LAYOUT_VERSION: u8 = 2;
/// `Battle.pending_kind`: nothing is waiting to be resolved.
pub const PENDING_NONE: u8 = 0;
/// A declared move (`pending_piece`, `pending_to`) waits for `resolve`.
pub const PENDING_MOVE: u8 = 1;
/// A declared timeout claim waits for `resolve`: the turn's deadline had passed at the declare.
pub const PENDING_TIMEOUT: u8 = 2;
/// A declared timeout claim waits for `resolve`: the time cap had passed at the declare.
pub const PENDING_CAP: u8 = 3;
/// A declared Blast (`pending_piece` the Engineer) waits for `resolve`.
pub const PENDING_BLAST: u8 = 4;
/// A declared Rescue (`pending_piece` the Colonel) waits for `resolve`.
pub const PENDING_RESCUE: u8 = 5;
/// A declared pass waits for `resolve`. `pending_piece` holds the SEALED Dig in slot byte (0 sealed = a plain pass),
/// so a face-down Dig in and a pass are the same record.
pub const PENDING_PASS: u8 = 6;

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
/// `[engineer, square, n, n x (piece, rank)]`: the Engineer's own number, its square, how many neighbours (at most 8)
/// and each neighbour's number with the rank it plays as now.
pub const EVENT_BLAST: u8 = 8;
/// `[colonel, truck, from, to]`: `from` is the Truck's old square, `to` the Colonel's.
pub const EVENT_RESCUE: u8 = 9;
/// `[army, piece]`: only a face-up Major's Dig in is named.
pub const EVENT_DUG_IN: u8 = 10;
/// `[army]`: a pass, and every Dig in (a face-down one produces exactly this).
pub const EVENT_PASS: u8 = 11;
/// `[piece]`: only a face-up General of the Army's switch is named.
pub const EVENT_SWITCHED: u8 = 12;

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
            Event::Blast { id, at, n, shown } => {
                d[..3].copy_from_slice(&[id, at, n]);
                for (i, (piece, rank)) in shown.iter().enumerate().take(engine::MAX_BLAST) {
                    d[3 + i * 2..5 + i * 2].copy_from_slice(&[*piece, *rank]);
                }
                EVENT_BLAST
            }
            Event::Rescue {
                colonel,
                truck,
                from,
                to,
            } => {
                d[..4].copy_from_slice(&[colonel, truck, from, to]);
                EVENT_RESCUE
            }
            Event::DugIn { army, id } => {
                d[..2].copy_from_slice(&[army.idx() as u8, id]);
                EVENT_DUG_IN
            }
            Event::Pass { army } => {
                d[0] = army.idx() as u8;
                EVENT_PASS
            }
            Event::Switched { id } => {
                d[0] = id;
                EVENT_SWITCHED
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

/// The program config: which validator the Battle may be delegated to and which oracle queue answers its VRF
/// requests. Set at deploy by the upgrade authority; nothing about the cluster is compiled in.
#[account]
#[derive(InitSpace, Debug)]
pub struct VanguardConfig {
    pub bump: u8,
    pub tee_validator: Pubkey,
    pub oracle_queue: Pubkey,
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
    /// `LAYOUT_VERSION` this Battle was created with.
    pub layout_version: u8,
    /// `RULES_VERSION` this Battle was created with. A program upgrade never changes the rules of a Battle in
    /// flight: the numbers below are stored at create and deal.
    pub rules_version: u8,
    /// The Match must be dealt by now; past it `claim_timeout` cancels it.
    pub setup_deadline: i64,
    /// The time cap: set at `deal` to `started_at + cap_secs`.
    pub cap_deadline: i64,
    /// Whoever pressed create and prepaid the rent.
    pub payer: Pubkey,
    /// The oracle queue its VRF request goes to, copied from the config at create.
    pub oracle_queue: Pubkey,
    pub move_cap: u16,
    pub cap_secs: u16,
    pub turn_secs: u8,
    pub grace_secs: u8,
    /// Extra seconds on the opening turn.
    pub opening_grace_secs: u8,
    pub storm_from: u8,
    pub storm_to: u8,
    /// `PENDING_*`: a declared action that only `resolve` (in a later slot) may apply. While one is pending nothing
    /// else is accepted. It holds public intent and timing only, never a rank, and cannot be changed or cancelled.
    pub pending_kind: u8,
    pub pending_piece: u8,
    pub pending_to: u8,
    /// The seat that declared a move (a timeout claim reads 0).
    pub pending_seat: u8,
    /// `pad_a[0]` is the SEALED switch byte of the pending move, Blast, Rescue or pass (`plain ^ pad`, see
    /// `engine::seal_pad`); a timeout claim leaves it 0. Cleared with the pending action. The other two bytes are
    /// unused.
    pub pad_a: [u8; 3],
    /// Counts declared actions: the n-th pending action is the one `resolve` applies.
    pub action_seq: u32,
    pub pad_b: [u8; 4],
    /// The rollup slot of the declare. `resolve` needs a later one.
    pub pending_slot: u64,
    /// The rollup time of the declare: the clock decision was made on it and is not made again.
    pub pending_time: i64,
    /// The slot `deal` ran in. Nothing is declared in it, so the sides cannot be read out of a bundle with `deal`.
    pub deal_slot: u64,
    /// See `engine::RESOLVE_SLACK_SECS`.
    pub resolve_slack_secs: u8,
    /// `reserved[..8]` is the END MASK: bit `id` (little endian `u64`, piece numbers 0-59) is set for every piece
    /// whose rank changed in the Match (a Major that dug in, a General of the Army that became a Spy), dead pieces
    /// included. Written when the Match ends, never before. The rest is unused.
    pub reserved: [u8; 31],
}

/// What a declare freezes in the Battle: public intent plus sealed bytes. A move uses `piece` and `to`; a Blast or a
/// Rescue only `piece`; a pass puts its sealed Dig in slot byte in `piece`; a timeout claim carries nothing.
#[derive(Clone, Copy, Default)]
pub struct Intent {
    pub piece: u8,
    pub to: u8,
    pub sealed_switch: u8,
}

/// What `create_match` knows when it binds a Battle to a tesoro_core Match.
pub struct NewBattle {
    pub bump: u8,
    pub authority_bump: u8,
    pub match_id: u64,
    pub tesoro_match: Pubkey,
    pub players: [Pubkey; 2],
    pub start_deadline: i64,
    pub payer: Pubkey,
    pub oracle_queue: Pubkey,
}

impl Battle {
    /// Bind a freshly created (zeroed) Battle to a tesoro_core Match. In place: a Battle is too big to build on
    /// the stack.
    pub fn init(&mut self, new: NewBattle) {
        self.layout_version = LAYOUT_VERSION;
        self.rules_version = RULES_VERSION;
        self.payer = new.payer;
        self.oracle_queue = new.oracle_queue;
        self.move_cap = MOVE_CAP;
        self.cap_secs = CAP_SECS as u16;
        self.turn_secs = TURN_SECS as u8;
        self.grace_secs = GRACE_SECS as u8;
        self.opening_grace_secs = OPENING_GRACE_SECS as u8;
        self.resolve_slack_secs = RESOLVE_SLACK_SECS as u8;
        self.storm_from = STORM_FROM as u8;
        self.storm_to = STORM_TO as u8;
        self.setup_deadline = new.start_deadline.saturating_add(SETUP_GRACE_SECS);
        self.bump = new.bump;
        self.authority_bump = new.authority_bump;
        self.match_id = new.match_id;
        self.tesoro_match = new.tesoro_match;
        self.players = new.players;
        self.start_deadline = new.start_deadline;
        self.us_seat = UNSET;
        self.status = STATUS_CREATED;
        self.winner = NO_WINNER;
        self.reason = NO_REASON;
        self.steps_left = 1;
        self.sq = [NO_SQ; PIECE_SLOTS];
    }

    /// Record a declared action. It is bound to the n-th declare of the Match and cannot be changed.
    pub fn record_pending(&mut self, kind: u8, intent: Intent, seat: u8, slot: u64, time: i64) {
        self.pending_kind = kind;
        self.pending_piece = intent.piece;
        self.pending_to = intent.to;
        self.pad_a[0] = intent.sealed_switch;
        self.pending_seat = seat;
        self.pending_slot = slot;
        self.pending_time = time;
        self.action_seq = self.action_seq.wrapping_add(1);
    }

    pub fn clear_pending(&mut self) {
        self.pending_kind = PENDING_NONE;
        self.pending_piece = 0;
        self.pending_to = 0;
        self.pending_seat = 0;
        self.pad_a[0] = 0;
        self.pending_slot = 0;
        self.pending_time = 0;
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

    /// The clock this Battle plays under, as stored when it was created.
    pub fn clock(&self) -> Clock {
        Clock {
            turn_secs: self.turn_secs as i64,
            grace_secs: self.grace_secs as i64,
            opening_grace_secs: self.opening_grace_secs as i64,
            resolve_slack_secs: self.resolve_slack_secs as i64,
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
                self.clock(),
            )
            .map_err(|_| error!(VanguardError::BadState))?,
        );
        g.version = self.rules_version;
        g.cap_at = self.cap_deadline;
        g.move_cap = self.move_cap;
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

    /// The engine's `Game` from the public Battle alone: every piece on the board stands in as rank 1. Enough for the
    /// checks that need no rank (`check_declared_move`, `timeout_class`), so a declare reads no Army and no Secret.
    pub fn public_game(&self) -> Result<Box<Game>> {
        let mut g = self.shell(0, 0)?;
        for id in 0..PIECE_SLOTS {
            let sq = self.sq[id];
            if sq == NO_SQ {
                continue;
            }
            if sq as usize >= SQUARES {
                return err!(VanguardError::BadState);
            }
            g.pieces[id] = Piece {
                rank: 1,
                army: side_of_id(id),
                sq,
                known: self.shown[id] != 0,
                fuel: 0,
                trail: self.trail[id],
                trail_len: self.trail_len[id],
            };
            g.cells[sq as usize] = id as u8 + 1;
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
                // Only the Truck has fuel; a mask, not an `if`, so no rank decides what runs.
                fuel: army.fuel & engine::ct::mask(engine::ct::eq(rank as u64, TRUCK as u64)),
                trail: self.trail[id],
                trail_len: self.trail_len[id],
            };
            g.cells[sq as usize] = id as u8 + 1;
        }
        for a in armies {
            if let Some(side) = side_from(a.side) {
                g.truck_turn[side.idx()] = a.truck_turn;
                // every piece whose rank changed, dead ones included: a dead piece keeps its code in the Army
                let base = if side == Side::Us { 30 } else { 0 };
                for (i, code) in a.ranks.iter().enumerate() {
                    g.changed |= (engine::is_changed_code(*code) as u64) << (base + i);
                }
            }
        }
        Ok(g)
    }

    /// Take the engine's result back into the public fields. A piece that left the board is shown with the rank it
    /// played as when it left (`Game::fallen`: a switched General of the Army that died shows as a Spy); a piece that
    /// is face up shows the rank it plays as now, so a known Major that dug in shows as a Landmine.
    pub fn absorb(&mut self, g: &Game) {
        for (id, p) in g.pieces.iter().enumerate() {
            if p.rank == 0 {
                if self.sq[id] != NO_SQ {
                    self.shown[id] = g.fallen[id];
                    self.sq[id] = NO_SQ;
                    self.trail_len[id] = 0;
                }
            } else {
                self.sq[id] = p.sq;
                self.shown[id] = if p.known { engine::eff(p.rank) } else { 0 };
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
            // The end reveal: which pieces changed rank, dead ones included, for the end panel.
            self.reserved[..8].copy_from_slice(&g.changed.to_le_bytes());
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
    /// The 32-byte sealing key of this Army (`engine::seal_keys`), written at `deal`, private to its Player and
    /// zeroed by `wipe`. It seals the switch and Dig in bytes this Player sends (`engine::seal_pad`).
    pub reserved: [u8; 32],
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
            reserved: [0; 32],
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

    /// Take the Truck's fuel and last-moved turn and every rank back from the engine. All thirty rank bytes are
    /// written every time, from masks: a live piece keeps the code the engine holds for it (a Dig in or a switch
    /// changes it), a dead piece keeps the code it had (plus a change made in its last action), so the end reveal and the owner's badge survive a death.
    pub fn absorb(&mut self, g: &Game) {
        let Some(side) = side_from(self.side) else {
            return;
        };
        self.truck_turn = g.truck_turn[side.idx()];
        let base = if side == Side::Us { 30 } else { 0 };
        for i in 0..30 {
            let p = &g.pieces[base + i];
            // Select the Truck's fuel without branching on a rank.
            let m = engine::ct::mask(engine::ct::eq(p.rank as u64, TRUCK as u64));
            self.fuel = (p.fuel & m) | (self.fuel & !m);
            // A dead piece keeps the code it had, except that a change made in this very action (a switch, then a lost
            // attack) is written back from `changed`, so the record and the end mask survive the death.
            let old = self.ranks[i];
            let changed = ((g.changed >> (base + i)) & 1) as u8;
            let switched = changed & engine::ct::eq(old as u64, engine::GENERAL_OF_THE_ARMY as u64);
            let dug_in = changed & engine::ct::eq(old as u64, engine::MAJOR as u64);
            let dead_code = engine::ct::pick(
                switched,
                engine::SWITCHED,
                engine::ct::pick(dug_in, engine::DUG_IN, old),
            );
            let live = engine::ct::mask(1 ^ engine::ct::eq(p.rank as u64, 0));
            self.ranks[i] = (p.rank & live) | (dead_code & !live);
        }
    }

    /// Everything private to the Player goes before the Army is committed to the base layer: the rank codes (a Dig in
    /// or a switch included) and the sealing key.
    pub fn wipe(&mut self) {
        self.ranks = [0; 30];
        self.fuel = 0;
        self.truck_turn = 0;
        self.moves = 0;
        self.reserved = [0; 32];
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
    /// Set by `request_vrf`: a Match where both Players are in but nobody asked for randomness cancels at the first
    /// entropy deadline instead of waiting.
    pub vrf_requested: bool,
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
            vrf_requested: false,
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
mod changes {
    use super::*;
    use crate::engine::{
        CHAIN_CLOCK, DUG_IN, GENERAL, GENERAL_OF_THE_ARMY, MAJOR, NO_PIECE, RECON, SPY, SWITCHED,
    };

    type Parts = (Box<Battle>, Army, Army, Secret);

    /// A live Battle laid out as `deal` leaves it: Alice (seat 0) plays the US Army, Bob (seat 1) Italy.
    fn live(layout: &[LayoutPiece]) -> Parts {
        let g = Game::start(layout, Side::Us, 99, 12_345, 1_000, CHAIN_CLOCK).unwrap();
        let mut b: Box<Battle> = Box::new(anchor_lang::__private::bytemuck::Zeroable::zeroed());
        b.sq = [NO_SQ; PIECE_SLOTS];
        b.rules_version = RULES_VERSION;
        b.us_seat = 0;
        b.turn_secs = TURN_SECS as u8;
        b.grace_secs = GRACE_SECS as u8;
        b.opening_grace_secs = OPENING_GRACE_SECS as u8;
        b.resolve_slack_secs = RESOLVE_SLACK_SECS as u8;
        b.move_cap = MOVE_CAP;
        b.steps_left = 1;
        b.started_at = 1_000;
        b.cap_deadline = g.cap_at;
        b.absorb(&g);
        b.status = STATUS_LIVE;
        let key = Pubkey::new_unique();
        let mut a0 = Army::blank(1, key, 0, Pubkey::new_unique());
        let mut a1 = Army::blank(1, key, 1, Pubkey::new_unique());
        a0.place(Side::Us, layout);
        a1.place(Side::It, layout);
        let mut secret = Secret::blank(1, key);
        secret.storm_at = 99;
        secret.storm_seed = 12_345;
        (b, a0, a1, secret)
    }

    fn bytes(b: &Battle) -> Vec<u8> {
        anchor_lang::__private::bytemuck::bytes_of(b).to_vec()
    }

    fn piece(army: Side, rank: u8, sq: u8) -> LayoutPiece {
        LayoutPiece { army, rank, sq }
    }

    fn layout() -> Vec<LayoutPiece> {
        vec![
            piece(Side::Us, MAJOR, 85),
            piece(Side::Us, GENERAL_OF_THE_ARMY, 86),
            piece(Side::Us, RECON, 99),
            piece(Side::It, GENERAL_OF_THE_ARMY, 26),
            piece(Side::It, RECON, 0),
        ]
    }

    const MAJOR_ID: u8 = 45;
    const TEN_ID: u8 = 46;

    #[test]
    fn a_dig_in_leaves_the_public_battle_exactly_as_a_plain_pass_does() {
        let mut plain = live(&layout());
        let mut dug = live(&layout());
        for (parts, dig) in [(&mut plain, NO_PIECE), (&mut dug, MAJOR_ID)] {
            let (b, a0, a1, secret) = parts;
            crate::run(b, a0, a1, secret, |g, out| {
                g.resolve_pass(dig, false, 1_005, out)
            })
            .unwrap();
        }
        assert_eq!(
            bytes(&plain.0),
            bytes(&dug.0),
            "the public Battle cannot tell a Dig in from a pass"
        );
        assert_eq!(plain.1.ranks[MAJOR_ID as usize % 30], MAJOR);
        assert_eq!(dug.1.ranks[MAJOR_ID as usize % 30], DUG_IN);
        assert_eq!(dug.2.ranks, plain.2.ranks, "the other army is untouched");
    }

    #[test]
    fn a_switch_leaves_the_public_battle_as_no_switch_does() {
        let mut plain = live(&layout());
        let mut switched = live(&layout());
        for (parts, sw) in [(&mut plain, false), (&mut switched, true)] {
            let (b, a0, a1, secret) = parts;
            crate::run(b, a0, a1, secret, |g, out| {
                g.resolve_move(99 - 40, 89, sw, 1_005, out)
            })
            .unwrap();
        }
        assert_eq!(bytes(&plain.0), bytes(&switched.0));
        assert_eq!(switched.1.ranks[TEN_ID as usize % 30], SWITCHED);
        assert_eq!(plain.1.ranks[TEN_ID as usize % 30], GENERAL_OF_THE_ARMY);
    }

    #[test]
    fn a_rank_change_persists_across_engine_runs_and_dead_pieces_keep_their_code() {
        let (mut b, mut a0, mut a1, secret) = live(&layout());
        // run 1: Alice digs in and switches her 10 (a Dig in is a pass)
        crate::run(&mut b, &mut a0, &mut a1, &secret, |g, out| {
            g.resolve_pass(MAJOR_ID, true, 1_005, out)
        })
        .unwrap();
        assert_eq!(
            (
                a0.ranks[MAJOR_ID as usize % 30],
                a0.ranks[TEN_ID as usize % 30]
            ),
            (DUG_IN, SWITCHED)
        );
        // run 2, from the accounts alone: the engine reads them as a Landmine and a Spy
        let g = b.game([&a0, &a1], &secret).unwrap();
        assert_eq!(
            (
                g.pieces[MAJOR_ID as usize].rank,
                g.pieces[TEN_ID as usize].rank
            ),
            (DUG_IN, SWITCHED)
        );
        assert_eq!(g.changed, 1 << MAJOR_ID | 1 << TEN_ID);
        // Italy's piece 26, played as a General (9), stands next to Alice's switched 10 and attacks it: the Spy loses
        // (a 10 would lose to it: the Spy beats the 10 whichever attacks)
        crate::run(&mut b, &mut a0, &mut a1, &secret, |g, out| {
            g.pieces[26].rank = GENERAL;
            let from = g.pieces[26].sq;
            g.cells[from as usize] = 0;
            g.cells[76] = 27;
            g.pieces[26].sq = 76;
            g.pieces[26].trail = [76, 0, 0, 0, 0, 0];
            g.resolve_move(26, 86, false, 1_010, out)
        })
        .unwrap();
        assert_eq!(b.sq[TEN_ID as usize], NO_SQ);
        assert_eq!(
            b.shown[TEN_ID as usize], SPY,
            "a switched 10 that dies is shown as a Spy"
        );
        assert_eq!(
            a0.ranks[TEN_ID as usize % 30],
            SWITCHED,
            "a dead piece keeps its code"
        );
        assert_eq!(
            a0.ranks[MAJOR_ID as usize % 30],
            DUG_IN,
            "and so does the one that did not move"
        );
        // a third run from the accounts still knows both changes, the dead one included
        let g = b.game([&a0, &a1], &secret).unwrap();
        assert_eq!(g.changed, 1 << MAJOR_ID | 1 << TEN_ID);
        // the Army's other twenty-nine bytes were written back unchanged
        assert_eq!(a0.ranks[RECON as usize], 0);
        // nothing of the change is public while the Match lives
        assert_eq!(b.shown[MAJOR_ID as usize], 0);
    }

    #[test]
    fn a_face_up_major_that_digs_in_shows_a_landmine() {
        let (mut b, mut a0, mut a1, secret) = live(&layout());
        b.shown[MAJOR_ID as usize] = MAJOR;
        crate::run(&mut b, &mut a0, &mut a1, &secret, |g, out| {
            g.pieces[MAJOR_ID as usize].known = true;
            g.resolve_pass(MAJOR_ID, false, 1_005, out)
        })
        .unwrap();
        assert_eq!(b.shown[MAJOR_ID as usize], crate::engine::BOMB);
    }

    #[test]
    fn the_new_events_fit_one_record() {
        const _: () = assert!(3 + 2 * engine::MAX_BLAST <= RECORD_DATA);
        let blast = engine::Event::Blast {
            id: 30,
            at: 85,
            n: 8,
            shown: [(1, 2); engine::MAX_BLAST],
        };
        let r = RingRecord::encode(&Record {
            seq: 7,
            event: blast,
        });
        assert_eq!(
            (r.kind, r.data[0], r.data[1], r.data[2]),
            (EVENT_BLAST, 30, 85, 8)
        );
        assert_eq!(&r.data[3..19], &[1, 2].repeat(8)[..]);
        for (event, kind) in [
            (
                engine::Event::Rescue {
                    colonel: 1,
                    truck: 2,
                    from: 3,
                    to: 4,
                },
                EVENT_RESCUE,
            ),
            (
                engine::Event::DugIn {
                    army: Side::It,
                    id: 5,
                },
                EVENT_DUG_IN,
            ),
            (engine::Event::Pass { army: Side::It }, EVENT_PASS),
            (engine::Event::Switched { id: 9 }, EVENT_SWITCHED),
        ] {
            assert_eq!(RingRecord::encode(&Record { seq: 1, event }).kind, kind);
        }
    }
}

#[cfg(test)]
mod layout {
    use super::*;

    #[test]
    fn the_battle_has_no_padding_and_a_fixed_size() {
        assert_eq!(core::mem::size_of::<Battle>(), 1512);
    }

    /// Offsets after the 8-byte discriminator, for clients (ticket 07's decoders). The fields up to `depot_claimed`
    /// have not moved since layout version 1 began; the new ones were appended where the padding was.
    #[test]
    fn the_battle_offsets_are_the_ones_clients_read() {
        use core::mem::offset_of;
        for (name, got, want) in [
            ("match_id", offset_of!(Battle, match_id), 0),
            ("moved", offset_of!(Battle, moved), 8),
            ("start_deadline", offset_of!(Battle, start_deadline), 16),
            ("entropy_deadline", offset_of!(Battle, entropy_deadline), 24),
            ("deadline", offset_of!(Battle, deadline), 32),
            ("started_at", offset_of!(Battle, started_at), 40),
            ("event_seq", offset_of!(Battle, event_seq), 48),
            ("turn_no", offset_of!(Battle, turn_no), 52),
            ("moves", offset_of!(Battle, moves), 54),
            ("ring", offset_of!(Battle, ring), 56),
            ("tesoro_match", offset_of!(Battle, tesoro_match), 696),
            ("players", offset_of!(Battle, players), 728),
            ("sq", offset_of!(Battle, sq), 792),
            ("shown", offset_of!(Battle, shown), 852),
            ("trail", offset_of!(Battle, trail), 912),
            ("trail_len", offset_of!(Battle, trail_len), 1272),
            ("bump", offset_of!(Battle, bump), 1332),
            ("turn", offset_of!(Battle, turn), 1340),
            ("two_step", offset_of!(Battle, two_step), 1344),
            ("timeouts", offset_of!(Battle, timeouts), 1346),
            ("depot_claimed", offset_of!(Battle, depot_claimed), 1348),
            ("layout_version", offset_of!(Battle, layout_version), 1350),
            ("rules_version", offset_of!(Battle, rules_version), 1351),
            ("setup_deadline", offset_of!(Battle, setup_deadline), 1352),
            ("cap_deadline", offset_of!(Battle, cap_deadline), 1360),
            ("payer", offset_of!(Battle, payer), 1368),
            ("oracle_queue", offset_of!(Battle, oracle_queue), 1400),
            ("move_cap", offset_of!(Battle, move_cap), 1432),
            ("cap_secs", offset_of!(Battle, cap_secs), 1434),
            ("turn_secs", offset_of!(Battle, turn_secs), 1436),
            ("grace_secs", offset_of!(Battle, grace_secs), 1437),
            (
                "opening_grace_secs",
                offset_of!(Battle, opening_grace_secs),
                1438,
            ),
            ("storm_from", offset_of!(Battle, storm_from), 1439),
            ("storm_to", offset_of!(Battle, storm_to), 1440),
            ("pending_kind", offset_of!(Battle, pending_kind), 1441),
            ("pending_piece", offset_of!(Battle, pending_piece), 1442),
            ("pending_to", offset_of!(Battle, pending_to), 1443),
            ("pending_seat", offset_of!(Battle, pending_seat), 1444),
            ("action_seq", offset_of!(Battle, action_seq), 1448),
            ("pending_slot", offset_of!(Battle, pending_slot), 1456),
            ("pending_time", offset_of!(Battle, pending_time), 1464),
            ("deal_slot", offset_of!(Battle, deal_slot), 1472),
            (
                "resolve_slack_secs",
                offset_of!(Battle, resolve_slack_secs),
                1480,
            ),
            ("reserved", offset_of!(Battle, reserved), 1481),
        ] {
            assert_eq!(got, want, "{name}");
        }
    }
}

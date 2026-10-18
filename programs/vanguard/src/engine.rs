//! Vanguard rules: the on-chain referee.
//!
//! Pure functions over one fixed-size `Game`: no Anchor types, no heap, no accounts. The app's TypeScript
//! engine (`app/src/games/vanguard/rules.ts`) plays the same rules; `tests/recordings.rs` replays Matches
//! recorded from it and demands the same public board, the same events and the same refusals.
//!
//! Squares are `row * 10 + col` with row 0 at Italy's back row. A piece's number is the index of its start
//! square (Italy rows 0-2 are 0-29, US rows 7-9 are 30-59), so a number says nothing about its rank.
//! Times are whole rollup seconds.
//!
//! Compute: `move_piece`, `timeout` and the no-legal-move check run one fixed scan (every piece slot, four
//! directions, nine squares) whatever the layout, so what a Player has on the board does not change the cost.

/// Bump when a rule changes; the recordings and the app change with it.
pub const RULES_VERSION: u8 = 1;

pub const SIZE: usize = 10;
pub const SQUARES: usize = SIZE * SIZE;
/// One slot per start square: Italy rows 0-2, US rows 7-9.
pub const PIECE_SLOTS: usize = 60;
pub const ARMY_PIECES: usize = 20;
pub const TURN_SECS: i64 = 5;
/// Extra seconds on every deadline for network delay. Ticket 01's latency spike may change it.
pub const GRACE_SECS: i64 = 1;
/// The time cap: 15 minutes from the start.
pub const CAP_SECS: i64 = 15 * 60;
pub const MOVE_CAP: u16 = 200;
pub const TIMEOUTS_TO_LOSE: u8 = 3;
pub const TRUCK_FUEL: u8 = 3;
/// The turns on which the Dust Storm may blow. Changing it needs Ailton's OK (the bot simulation proposes it).
pub const STORM_FROM: u16 = 10;
pub const STORM_TO: u16 = 18;
/// Longest run: nine squares.
const RUN: i8 = 9;
/// Most events one action can produce: move or attack, Spotted, raid, storm, turn, end.
pub const MAX_EVENTS: usize = 8;
/// A storm line has ten squares.
pub const MAX_SHIFTS: usize = SIZE;

/// Ranks. 0 marks an empty slot.
pub const GENERAL_OF_THE_ARMY: u8 = 10;
pub const RECON: u8 = 2;
pub const SPY: u8 = 1;
pub const ENGINEER: u8 = 3;
/// The Landmine.
pub const BOMB: u8 = 11;
/// The Supply Truck.
pub const TRUCK: u8 = 12;

/// `(rank, count)` per army.
pub const ROSTER: [(u8, u8); 12] = [
    (10, 1),
    (9, 1),
    (8, 1),
    (7, 2),
    (6, 2),
    (5, 2),
    (4, 2),
    (3, 2),
    (2, 3),
    (1, 1),
    (BOMB, 2),
    (TRUCK, 1),
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Army {
    Us = 0,
    It = 1,
}

impl Army {
    pub const fn enemy(self) -> Army {
        match self {
            Army::Us => Army::It,
            Army::It => Army::Us,
        }
    }
    pub const fn idx(self) -> usize {
        self as usize
    }
    pub const fn name(self) -> &'static str {
        match self {
            Army::Us => "us",
            Army::It => "it",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Winner {
    Army(Army),
    Draw,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EndReason {
    Truck,
    Stuck,
    Timeouts,
    Cap,
}

impl EndReason {
    pub const fn name(self) -> &'static str {
        match self {
            EndReason::Truck => "truck",
            EndReason::Stuck => "stuck",
            EndReason::Timeouts => "timeouts",
            EndReason::Cap => "cap",
        }
    }
}

/// Why an action was refused. The codes never depend on a hidden rank.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Refusal {
    MatchOver,
    CapPassed,
    TurnExpired,
    TurnNotExpired,
    NotYourTurn,
    NoSuchPiece,
    IllegalMove,
    NoTwoStep,
}

impl Refusal {
    pub const fn name(self) -> &'static str {
        match self {
            Refusal::MatchOver => "match_over",
            Refusal::CapPassed => "cap_passed",
            Refusal::TurnExpired => "turn_expired",
            Refusal::TurnNotExpired => "turn_not_expired",
            Refusal::NotYourTurn => "not_your_turn",
            Refusal::NoSuchPiece => "no_such_piece",
            Refusal::IllegalMove => "illegal_move",
            Refusal::NoTwoStep => "no_two_step",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    Win,
    Lose,
    Tie,
    Mine,
    Defuse,
    Truck,
}

impl Outcome {
    pub const fn name(self) -> &'static str {
        match self {
            Outcome::Win => "win",
            Outcome::Lose => "lose",
            Outcome::Tie => "tie",
            Outcome::Mine => "mine",
            Outcome::Defuse => "defuse",
            Outcome::Truck => "truck",
        }
    }
}

/// No piece: the "none" in a fixed-size event.
pub const NO_PIECE: u8 = 255;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Shift {
    pub id: u8,
    pub from: u8,
    pub to: u8,
}

/// What happened, in a fixed size so a ring of them fits an account.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Event {
    Move {
        id: u8,
        from: u8,
        to: u8,
    },
    /// `flash` holds the pieces whose face is shown to the other side (`NO_PIECE` pads): the beaten piece,
    /// both in a tie, a Landmine that went off. A winning defender stays hidden.
    Attack {
        att: u8,
        def: u8,
        from: u8,
        to: u8,
        outcome: Outcome,
        flash: [u8; 2],
    },
    Spotted {
        id: u8,
    },
    Raid {
        army: Army,
        at: u8,
    },
    /// `col` is true when a column drifted, false for a row. `dir` is 1 or -1 along the line.
    Storm {
        col: bool,
        index: u8,
        dir: i8,
        n: u8,
        shifts: [Shift; MAX_SHIFTS],
    },
    Turn {
        turn: Army,
        timed_out: bool,
    },
    End {
        winner: Winner,
        reason: EndReason,
    },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Record {
    pub seq: u32,
    pub event: Event,
}

/// The events of one action.
#[derive(Clone, Copy, Debug)]
pub struct Events {
    pub len: usize,
    pub items: [Record; MAX_EVENTS],
}

impl Events {
    pub const fn new() -> Events {
        Events {
            len: 0,
            items: [Record {
                seq: 0,
                event: Event::Spotted { id: 0 },
            }; MAX_EVENTS],
        }
    }
    pub fn as_slice(&self) -> &[Record] {
        &self.items[..self.len]
    }
}

impl Default for Events {
    fn default() -> Self {
        Events::new()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Piece {
    /// 0 once the piece is gone.
    pub rank: u8,
    pub army: Army,
    pub sq: u8,
    /// Face up to the enemy for good: a Truck out of fuel, a Landmine that went off, everything at the end.
    pub known: bool,
    /// Supply Truck moves used.
    pub fuel: u8,
    /// Squares this piece stood on, newest last (the no-shuttling rule).
    pub trail: [u8; 6],
    pub trail_len: u8,
}

const GONE: Piece = Piece {
    rank: 0,
    army: Army::Us,
    sq: 0,
    known: false,
    fuel: 0,
    trail: [0; 6],
    trail_len: 0,
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Clock {
    pub turn_secs: i64,
    pub grace_secs: i64,
}

/// The chain's clock: 5 s plus the grace.
pub const CHAIN_CLOCK: Clock = Clock {
    turn_secs: TURN_SECS,
    grace_secs: GRACE_SECS,
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct LayoutPiece {
    pub army: Army,
    pub rank: u8,
    pub sq: u8,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SetupError {
    TooManyPieces,
    BadSquare,
    SquareTaken,
    BadRank,
}

#[derive(Clone, Debug)]
pub struct Game {
    pub pieces: [Piece; PIECE_SLOTS],
    /// Piece number + 1 on each square, 0 when empty.
    pub cells: [u8; SQUARES],
    /// Whether the depot each army raids has been claimed (index: the raiding army).
    pub depot_claimed: [bool; 2],
    pub turn: Army,
    pub turn_no: u16,
    pub moves: u16,
    pub two_step: [u8; 2],
    pub steps_left: u8,
    pub two_step_active: bool,
    pub timeouts: [u8; 2],
    pub truck_turn: [i32; 2],
    /// Bit `id` set when that piece already moved this turn.
    pub moved: u64,
    pub started_at: i64,
    pub clock: Clock,
    pub deadline: i64,
    pub storm_at: u16,
    pub storm_seed: u32,
    pub storm_done: bool,
    pub event_seq: u32,
    pub winner: Option<Winner>,
    pub reason: Option<EndReason>,
}

/// The depot an army raids sits in the other army's base: US raids row 1 column 5, Italy raids row 8 column 4.
pub const DEPOT_SQ: [u8; 2] = [15, 84];

const DIRS: [(i8, i8); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];

pub const fn row(sq: u8) -> u8 {
    sq / 10
}
pub const fn col(sq: u8) -> u8 {
    sq % 10
}

/// The two wadis (impassable): rows 4-5, columns 2-3 and 6-7.
pub const fn is_wadi(sq: u8) -> bool {
    let r = row(sq);
    let c = col(sq);
    (r == 4 || r == 5) && (c == 2 || c == 3 || c == 6 || c == 7)
}

/// The piece number of a start square, or `None` outside the two start zones.
pub const fn start_index(sq: u8) -> Option<u8> {
    let r = row(sq);
    if sq >= 100 {
        None
    } else if r <= 2 {
        Some(sq)
    } else if r >= 7 {
        Some(sq - 40)
    } else {
        None
    }
}

const fn value(rank: u8) -> u8 {
    if rank >= BOMB {
        0
    } else {
        rank
    }
}

/// Who wins when `a` attacks `d`.
pub const fn fight(a: u8, d: u8) -> Outcome {
    if d == TRUCK {
        return Outcome::Truck;
    }
    if d == BOMB {
        return if a == ENGINEER {
            Outcome::Defuse
        } else {
            Outcome::Mine
        };
    }
    if a == d {
        return Outcome::Tie;
    }
    if a == SPY && d == GENERAL_OF_THE_ARMY {
        return Outcome::Win;
    }
    if value(a) > value(d) {
        Outcome::Win
    } else {
        Outcome::Lose
    }
}

/// Result of the fixed scan over every legal target of one army.
#[derive(Clone, Copy, Debug)]
pub struct Scan {
    /// Legal targets (moves and attacks) over all pieces of the army.
    pub count: u16,
    /// The probed `(piece, square)` is one of them.
    pub hit: bool,
    /// Inner steps taken: the same number for every layout.
    pub work: u32,
}

/// Steps in one scan: every slot, four directions, nine squares.
pub const SCAN_WORK: u32 = (PIECE_SLOTS * 4 * RUN as usize) as u32;

fn shuttling(p: &Piece, to: u8) -> bool {
    let n = p.trail_len as usize;
    if n < 4 || n > p.trail.len() {
        return false;
    }
    let (a, b, c, d) = (
        p.trail[n - 4],
        p.trail[n - 3],
        p.trail[n - 2],
        p.trail[n - 1],
    );
    a == c && b == d && to == c
}

/// Mulberry32, the generator the app uses for the storm, so both sides draw the same line and direction.
struct Mulberry(u32);

impl Mulberry {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        t ^ (t >> 14)
    }
}

/// Setup randomness: xoshiro256** seeded from the 32-byte seed the Secret holds.
struct Draw([u64; 4]);

impl Draw {
    fn new(seed: &[u8; 32]) -> Draw {
        let mut s = [0u64; 4];
        for (i, chunk) in seed.chunks_exact(8).enumerate() {
            let mut b = [0u8; 8];
            b.copy_from_slice(chunk);
            s[i] = u64::from_le_bytes(b);
        }
        if s == [0; 4] {
            s[0] = 1;
        }
        Draw(s)
    }
    fn next(&mut self) -> u64 {
        let s = &mut self.0;
        let result = s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = s[1] << 17;
        s[2] ^= s[0];
        s[3] ^= s[1];
        s[1] ^= s[2];
        s[0] ^= s[3];
        s[2] ^= t;
        s[3] = s[3].rotate_left(45);
        result
    }
    /// A number in `0..n`; the bias is below n / 2^32.
    fn below(&mut self, n: u32) -> u32 {
        (((self.next() >> 32) * n as u64) >> 32) as u32
    }
}

/// A random Match: both armies dropped on their start zones, who moves first, the storm turn and seed.
#[derive(Clone, Copy, Debug)]
pub struct Setup {
    pub pieces: [LayoutPiece; 2 * ARMY_PIECES],
    pub first: Army,
    pub storm_at: u16,
    pub storm_seed: u32,
}

/// The depot square inside `army`'s base (the one its enemy raids).
const fn own_depot(army: Army) -> u8 {
    DEPOT_SQ[army.enemy().idx()]
}

const fn manhattan(a: u8, b: u8) -> u8 {
    row(a).abs_diff(row(b)) + col(a).abs_diff(col(b))
}

/// Draw the whole Match from a 32-byte seed. Each draw is a fixed number of calls, so it is deterministic.
/// Landmines and the Truck never spawn on the row facing no-man's-land, the depot square stays empty and no
/// Landmine spawns next to it.
pub fn setup(seed: &[u8; 32]) -> Setup {
    let mut d = Draw::new(seed);
    let mut out = [LayoutPiece {
        army: Army::Us,
        rank: 0,
        sq: 0,
    }; 2 * ARMY_PIECES];
    for (n, army) in [Army::It, Army::Us].into_iter().enumerate() {
        place_army(
            army,
            &mut d,
            &mut out[n * ARMY_PIECES..(n + 1) * ARMY_PIECES],
        );
    }
    let first = if d.below(2) == 0 { Army::Us } else { Army::It };
    let storm_at = STORM_FROM + d.below((STORM_TO - STORM_FROM + 1) as u32) as u16;
    let storm_seed = (d.next() >> 32) as u32;
    Setup {
        pieces: out,
        first,
        storm_at,
        storm_seed,
    }
}

fn place_army(army: Army, d: &mut Draw, out: &mut [LayoutPiece]) {
    let depot = own_depot(army);
    let zone_rows: [u8; 3] = if army == Army::It {
        [0, 1, 2]
    } else {
        [7, 8, 9]
    };
    let front: u8 = if army == Army::It { 2 } else { 7 };
    let mut squares = [0u8; 29];
    let mut n = 0;
    for r in zone_rows {
        for c in 0..SIZE as u8 {
            let sq = r * 10 + c;
            if sq != depot {
                squares[n] = sq;
                n += 1;
            }
        }
    }
    for i in (1..squares.len()).rev() {
        let j = d.below(i as u32 + 1) as usize;
        squares.swap(i, j);
    }
    let mut used = [false; 29];
    let mut put = 0;
    let mut take = |out: &mut [LayoutPiece], rank: u8, ok: &dyn Fn(u8) -> bool| {
        if let Some(i) = (0..squares.len()).find(|&i| !used[i] && ok(squares[i])) {
            used[i] = true;
            out[put] = LayoutPiece {
                army,
                rank,
                sq: squares[i],
            };
            put += 1;
        }
    };
    for _ in 0..2 {
        take(out, BOMB, &|sq| {
            row(sq) != front && manhattan(sq, depot) != 1
        });
    }
    take(out, TRUCK, &|sq| row(sq) != front);
    // The restricted pieces took the earliest squares that suit them, so the squares left are not in random order
    // any more (the front row and the squares by the depot come first). Shuffle them again, or the first ranks
    // dealt would land on the front more often than the last ones.
    let mut rest = [0u8; 29];
    let mut m = 0;
    for (i, sq) in squares.iter().enumerate() {
        if !used[i] {
            rest[m] = *sq;
            m += 1;
        }
    }
    for i in (1..m).rev() {
        let j = d.below(i as u32 + 1) as usize;
        rest.swap(i, j);
    }
    let mut next = 0;
    for (rank, count) in ROSTER {
        if rank != BOMB && rank != TRUCK {
            for _ in 0..count {
                if next < m && put < out.len() {
                    out[put] = LayoutPiece {
                        army,
                        rank,
                        sq: rest[next],
                    };
                    put += 1;
                    next += 1;
                }
            }
        }
    }
}

impl Game {
    /// A Match from an explicit layout. The pieces get their numbers from their start squares.
    pub fn start(
        layout: &[LayoutPiece],
        first: Army,
        storm_at: u16,
        storm_seed: u32,
        started_at: i64,
        clock: Clock,
    ) -> Result<Game, SetupError> {
        if layout.len() > PIECE_SLOTS {
            return Err(SetupError::TooManyPieces);
        }
        let mut g = Game {
            pieces: [GONE; PIECE_SLOTS],
            cells: [0; SQUARES],
            depot_claimed: [false; 2],
            turn: first,
            turn_no: 0,
            moves: 0,
            two_step: [0; 2],
            steps_left: 1,
            two_step_active: false,
            timeouts: [0; 2],
            truck_turn: [-9; 2],
            moved: 0,
            started_at,
            clock,
            deadline: started_at + clock.turn_secs + clock.grace_secs,
            storm_at,
            storm_seed,
            storm_done: false,
            event_seq: 0,
            winner: None,
            reason: None,
        };
        for l in layout {
            let id = start_index(l.sq).ok_or(SetupError::BadSquare)?;
            if l.rank == 0 || l.rank > TRUCK {
                return Err(SetupError::BadRank);
            }
            if g.cells[l.sq as usize] != 0 {
                return Err(SetupError::SquareTaken);
            }
            g.pieces[id as usize] = Piece {
                rank: l.rank,
                army: l.army,
                sq: l.sq,
                known: false,
                fuel: 0,
                trail: [l.sq, 0, 0, 0, 0, 0],
                trail_len: 1,
            };
            g.cells[l.sq as usize] = id + 1;
        }
        Ok(g)
    }

    /// Start from a drawn `Setup`.
    pub fn from_setup(s: &Setup, started_at: i64, clock: Clock) -> Result<Game, SetupError> {
        Game::start(
            &s.pieces,
            s.first,
            s.storm_at,
            s.storm_seed,
            started_at,
            clock,
        )
    }

    fn turn_end(&self, at: i64) -> i64 {
        at.saturating_add(self.clock.turn_secs)
            .saturating_add(self.clock.grace_secs)
    }

    fn push(&mut self, out: &mut Events, event: Event) {
        if out.len < MAX_EVENTS {
            out.items[out.len] = Record {
                seq: self.event_seq,
                event,
            };
            out.len += 1;
        }
        self.event_seq = self.event_seq.wrapping_add(1);
    }

    fn can_move(&self, id: usize, p: &Piece, moved: u64) -> bool {
        match p.rank {
            BOMB => false,
            TRUCK => {
                p.fuel < TRUCK_FUEL
                    && self.truck_turn[p.army.idx()] != self.turn_no as i32 - 2
                    && (moved >> id) & 1 == 0
            }
            _ => true,
        }
    }

    /// Count the legal targets of `army` and test whether `(probe_id, probe_to)` is one of them. Every slot,
    /// direction and square is visited whatever is on the board: there is no early exit.
    pub fn scan(
        &self,
        army: Army,
        moved: u64,
        two_step_active: bool,
        probe_id: u8,
        probe_to: u8,
    ) -> Scan {
        let mut count: u16 = 0;
        let mut hit = false;
        let mut work: u32 = 0;
        for id in 0..PIECE_SLOTS {
            let p = &self.pieces[id];
            let live = p.rank != 0 && p.army == army && self.can_move(id, p, moved);
            let reach: i8 = if p.rank == RECON && !two_step_active {
                RUN
            } else {
                1
            };
            let pr = row(p.sq) as i8;
            let pc = col(p.sq) as i8;
            for (dr, dc) in DIRS {
                let mut open = live;
                for k in 1..=RUN {
                    let r = pr + dr * k;
                    let c = pc + dc * k;
                    let inb = (0..SIZE as i8).contains(&r) && (0..SIZE as i8).contains(&c);
                    let sq = if inb { (r * 10 + c) as u8 } else { 0 };
                    let occ = self.cells[sq as usize];
                    let own = occ != 0 && self.pieces[occ.saturating_sub(1) as usize].army == army;
                    let ok = open && k <= reach && inb && !is_wadi(sq) && !own;
                    let legal = ok && !shuttling(p, sq);
                    count += legal as u16;
                    hit |= legal && id as u8 == probe_id && sq == probe_to;
                    open = ok && occ == 0;
                    work += 1;
                }
            }
        }
        Scan { count, hit, work }
    }

    /// Whether `army` has any legal move at the start of its turn. Same work whatever the layout.
    pub fn has_moves(&self, army: Army) -> bool {
        self.scan(army, 0, false, NO_PIECE, 0).count > 0
    }

    /// Higher total of surviving ranks wins (Landmines and the Truck count 0), then more pieces, else a draw.
    pub fn cap_winner(&self) -> Winner {
        let mut sum = [0u16; 2];
        let mut n = [0u16; 2];
        for p in self.pieces.iter().filter(|p| p.rank != 0) {
            sum[p.army.idx()] += value(p.rank) as u16;
            n[p.army.idx()] += 1;
        }
        if sum[0] != sum[1] {
            return Winner::Army(if sum[0] > sum[1] { Army::Us } else { Army::It });
        }
        if n[0] != n[1] {
            return Winner::Army(if n[0] > n[1] { Army::Us } else { Army::It });
        }
        Winner::Draw
    }

    fn finish(&mut self, winner: Winner, reason: EndReason) {
        for p in self.pieces.iter_mut().filter(|p| p.rank != 0) {
            p.known = true;
        }
        self.winner = Some(winner);
        self.reason = Some(reason);
    }

    fn end(&mut self, out: &mut Events, winner: Winner, reason: EndReason) {
        self.push(out, Event::End { winner, reason });
        self.finish(winner, reason);
    }

    fn cap_passed(&self, at: i64) -> bool {
        at > self.started_at.saturating_add(CAP_SECS)
    }

    fn clock_refusal(&self, at: i64) -> Option<Refusal> {
        if self.winner.is_some() {
            Some(Refusal::MatchOver)
        } else if self.cap_passed(at) {
            Some(Refusal::CapPassed)
        } else if at > self.deadline {
            Some(Refusal::TurnExpired)
        } else {
            None
        }
    }

    /// Spend a banked Two-Step Turn on this turn, before the first step. It does not move the deadline.
    pub fn start_two_step(&mut self, at: i64) -> Result<(), Refusal> {
        if let Some(r) = self.clock_refusal(at) {
            return Err(r);
        }
        let a = self.turn.idx();
        if self.two_step[a] < 1 || self.two_step_active || self.moved != 0 {
            return Err(Refusal::NoTwoStep);
        }
        self.two_step[a] -= 1;
        self.two_step_active = true;
        self.steps_left = 2;
        Ok(())
    }

    fn remove(&mut self, id: usize) {
        self.cells[self.pieces[id].sq as usize] = 0;
        self.pieces[id].rank = 0;
    }

    fn land(&mut self, id: usize, to: u8) {
        let from = self.pieces[id].sq;
        self.cells[from as usize] = 0;
        self.cells[to as usize] = id as u8 + 1;
        let p = &mut self.pieces[id];
        p.sq = to;
        if p.trail_len as usize == p.trail.len() {
            p.trail.copy_within(1.., 0);
            p.trail_len -= 1;
        }
        p.trail[p.trail_len as usize] = to;
        p.trail_len += 1;
    }

    /// Move (or attack with) piece `id` to square `to` at time `at`. On a refusal nothing changes.
    pub fn move_piece(&mut self, id: u8, to: u8, at: i64, out: &mut Events) -> Result<(), Refusal> {
        out.len = 0;
        if let Some(r) = self.clock_refusal(at) {
            return Err(r);
        }
        if id as usize >= PIECE_SLOTS || self.pieces[id as usize].rank == 0 {
            return Err(Refusal::NoSuchPiece);
        }
        let army = self.turn;
        if self.pieces[id as usize].army != army {
            return Err(Refusal::NotYourTurn);
        }
        if to as usize >= SQUARES
            || !self
                .scan(army, self.moved, self.two_step_active, id, to)
                .hit
        {
            return Err(Refusal::IllegalMove);
        }
        let i = id as usize;
        let from = self.pieces[i].sq;
        let rank = self.pieces[i].rank;
        let step = manhattan(from, to) == 1;
        self.moves += 1;
        self.timeouts[army.idx()] = 0;
        if rank == TRUCK {
            self.pieces[i].fuel += 1;
            self.truck_turn[army.idx()] = self.turn_no as i32;
            if self.pieces[i].fuel >= TRUCK_FUEL {
                self.pieces[i].known = true;
            }
        }
        let cell = self.cells[to as usize];
        if cell == 0 {
            self.land(i, to);
            self.push(out, Event::Move { id, from, to });
        } else {
            let did = cell - 1;
            let d = did as usize;
            let outcome = fight(rank, self.pieces[d].rank);
            let flash = match outcome {
                Outcome::Tie => [id, did],
                Outcome::Lose => [id, NO_PIECE],
                _ => [did, NO_PIECE],
            };
            if outcome == Outcome::Mine {
                self.pieces[d].known = true;
            }
            self.push(
                out,
                Event::Attack {
                    att: id,
                    def: did,
                    from,
                    to,
                    outcome,
                    flash,
                },
            );
            match outcome {
                Outcome::Win | Outcome::Defuse | Outcome::Truck => {
                    self.remove(d);
                    self.land(i, to);
                }
                Outcome::Tie => {
                    self.remove(d);
                    self.remove(i);
                }
                Outcome::Lose | Outcome::Mine => self.remove(i),
            }
            if outcome == Outcome::Truck {
                self.end(out, Winner::Army(army), EndReason::Truck);
                return Ok(());
            }
        }
        let alive = self.pieces[i].rank != 0;
        if rank == TRUCK && self.pieces[i].fuel >= TRUCK_FUEL && alive {
            self.push(out, Event::Spotted { id });
        }
        // a one-square step onto the enemy's depot claims it, once per Match
        let a = army.idx();
        if DEPOT_SQ[a] == to && !self.depot_claimed[a] && step && alive && self.pieces[i].sq == to {
            self.depot_claimed[a] = true;
            self.two_step[a] += 1;
            self.push(out, Event::Raid { army, at: to });
        }
        self.moved |= 1 << id;
        self.steps_left -= 1;
        self.deadline = self.turn_end(at);
        // a Two-Step Turn continues while there is a second step to make
        if self.steps_left > 0
            && self
                .scan(army, self.moved, self.two_step_active, NO_PIECE, 0)
                .count
                > 0
        {
            return Ok(());
        }
        self.end_turn(out, false);
        Ok(())
    }

    /// Nobody moved in time (the turn passes; three in a row lose the Match), or the time cap has passed
    /// (the Match ends on the tiebreak whatever the turn clock says). Anyone may call it.
    pub fn timeout(&mut self, at: i64, out: &mut Events) -> Result<(), Refusal> {
        out.len = 0;
        if self.winner.is_some() {
            return Err(Refusal::MatchOver);
        }
        if self.cap_passed(at) {
            let w = self.cap_winner();
            self.end(out, w, EndReason::Cap);
            return Ok(());
        }
        if at <= self.deadline {
            return Err(Refusal::TurnNotExpired);
        }
        let army = self.turn;
        self.timeouts[army.idx()] += 1;
        if self.timeouts[army.idx()] >= TIMEOUTS_TO_LOSE {
            self.end(out, Winner::Army(army.enemy()), EndReason::Timeouts);
            return Ok(());
        }
        self.deadline = self.turn_end(at);
        self.end_turn(out, true);
        Ok(())
    }

    /// The turn passes. Order: pass, storm, `Turn` event, move cap, no legal move.
    fn end_turn(&mut self, out: &mut Events, timed_out: bool) {
        self.turn = self.turn.enemy();
        self.turn_no = self.turn_no.saturating_add(1);
        self.steps_left = 1;
        self.two_step_active = false;
        self.moved = 0;
        if !self.storm_done && self.turn_no >= self.storm_at {
            self.storm(out);
        }
        self.push(
            out,
            Event::Turn {
                turn: self.turn,
                timed_out,
            },
        );
        if self.moves >= MOVE_CAP {
            let w = self.cap_winner();
            self.end(out, w, EndReason::Cap);
            return;
        }
        if !self.has_moves(self.turn) {
            self.end(out, Winner::Army(self.turn.enemy()), EndReason::Stuck);
        }
    }

    /// The Dust Storm (once per Match): a row or column with at least two pieces drifts one square. The line and
    /// direction come from the storm seed at the moment it fires. Pieces nearest the edge they drift toward move
    /// first; one that would leave the board, enter a wadi or hit another piece stays put. A storm never claims a depot.
    fn storm(&mut self, out: &mut Events) {
        self.storm_done = true;
        let mut lines = [(false, 0u8); 2 * SIZE];
        let mut n = 0usize;
        for i in 0..SIZE as u8 {
            let rows = (0..SIZE as u8)
                .filter(|&c| self.cells[(i * 10 + c) as usize] != 0)
                .count();
            let cols = (0..SIZE as u8)
                .filter(|&r| self.cells[(r * 10 + i) as usize] != 0)
                .count();
            if rows >= 2 {
                lines[n] = (false, i);
                n += 1;
            }
            if cols >= 2 {
                lines[n] = (true, i);
                n += 1;
            }
        }
        if n == 0 {
            return;
        }
        let mut rng = Mulberry(self.storm_seed);
        let pick = ((rng.next() as u64 * n as u64) >> 32) as usize;
        let (is_col, index) = lines[pick];
        let dir: i8 = if rng.next() < 0x8000_0000 { 1 } else { -1 };
        let at = |pos: u8| {
            if is_col {
                pos * 10 + index
            } else {
                index * 10 + pos
            }
        };
        let mut shifts = [Shift::default(); MAX_SHIFTS];
        let mut count = 0usize;
        for step in 0..SIZE as u8 {
            let pos = if dir > 0 { SIZE as u8 - 1 - step } else { step };
            let from = at(pos);
            let cell = self.cells[from as usize];
            let next = pos as i8 + dir;
            if cell == 0 || !(0..SIZE as i8).contains(&next) {
                continue;
            }
            let to = at(next as u8);
            if is_wadi(to) || self.cells[to as usize] != 0 {
                continue;
            }
            let id = cell - 1;
            self.land(id as usize, to);
            let p = &mut self.pieces[id as usize];
            p.trail = [to, 0, 0, 0, 0, 0];
            p.trail_len = 1;
            shifts[count] = Shift { id, from, to };
            count += 1;
        }
        self.push(
            out,
            Event::Storm {
                col: is_col,
                index,
                dir,
                n: count as u8,
                shifts,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A well-mixed 32-byte seed per number (splitmix64), standing in for the hash the program derives.
    fn seed_of(n: u64) -> [u8; 32] {
        let mut x = n;
        let mut s = [0u8; 32];
        for chunk in s.chunks_exact_mut(8) {
            x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = x;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            chunk.copy_from_slice(&(z ^ (z >> 31)).to_le_bytes());
        }
        s
    }

    #[test]
    fn every_setup_obeys_the_spawn_rules_and_the_roster() {
        for n in 0..3000u64 {
            let s = setup(&seed_of(n));
            let mut seen = [false; SQUARES];
            for army in [Army::Us, Army::It] {
                let mine: Vec<&LayoutPiece> = s.pieces.iter().filter(|p| p.army == army).collect();
                assert_eq!(mine.len(), ARMY_PIECES);
                for (rank, count) in ROSTER {
                    assert_eq!(
                        mine.iter().filter(|p| p.rank == rank).count(),
                        count as usize,
                        "seed {n} {army:?} rank {rank}"
                    );
                }
                let depot = own_depot(army);
                let front = if army == Army::It { 2 } else { 7 };
                for p in mine {
                    assert!(!seen[p.sq as usize], "square used twice");
                    seen[p.sq as usize] = true;
                    let r = row(p.sq);
                    assert!(
                        if army == Army::It { r <= 2 } else { r >= 7 },
                        "outside the zone"
                    );
                    assert_ne!(p.sq, depot, "depot square must stay empty");
                    if p.rank == BOMB || p.rank == TRUCK {
                        assert_ne!(r, front, "restricted piece on the front row");
                    }
                    if p.rank == BOMB {
                        assert_ne!(manhattan(p.sq, depot), 1, "Landmine next to the depot");
                    }
                }
            }
            assert!((STORM_FROM..=STORM_TO).contains(&s.storm_at));
            assert!(Game::from_setup(&s, 0, CHAIN_CLOCK).is_ok());
        }
    }

    #[test]
    fn piece_numbers_say_nothing_about_rank() {
        // for each piece number, the ranks it held across many seeds
        let mut seen = [[0u32; 13]; PIECE_SLOTS];
        let seeds = 4000u64;
        let mut firsts = 0;
        for n in 0..seeds {
            let s = setup(&seed_of(n + 10_000));
            firsts += (s.first == Army::Us) as u64;
            let g = Game::from_setup(&s, 0, CHAIN_CLOCK).unwrap();
            for (id, p) in g.pieces.iter().enumerate().filter(|(_, p)| p.rank != 0) {
                assert_eq!(start_index(p.sq), Some(id as u8));
                seen[id][p.rank as usize] += 1;
            }
        }
        for (id, ranks) in seen.iter().enumerate() {
            // every non-depot number held plenty of different ranks
            if id == 15 || id == 84 - 40 {
                assert_eq!(
                    ranks.iter().sum::<u32>(),
                    0,
                    "depot square {id} never holds a piece"
                );
                continue;
            }
            let distinct = ranks.iter().filter(|&&c| c > 0).count();
            assert!(
                distinct >= 10,
                "piece number {id} held only {distinct} ranks"
            );
            // the Landmine share at a number stays near the average (2/29 for a free square): numbers carry no rank
            let bomb_share = ranks[BOMB as usize] as f64 / seeds as f64;
            assert!(
                bomb_share < 0.2,
                "piece number {id} holds a Landmine {bomb_share:.2} of the time"
            );
        }
        // a rank order along the numbers would give a near-perfect correlation: check it is nowhere near
        // (Landmines and Trucks are left out: the spawn rules keep them off the front row, which is a rule, not the numbering)
        let mut corr_num = 0f64;
        let (mut sx, mut sy, mut sxx, mut syy, mut sxy, mut cnt) =
            (0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
        for n in 0..500u64 {
            let g = Game::from_setup(&setup(&seed_of(n + 99)), 0, CHAIN_CLOCK).unwrap();
            for (id, p) in g
                .pieces
                .iter()
                .enumerate()
                .filter(|(_, p)| p.rank != 0 && p.rank < BOMB && p.army == Army::Us)
            {
                let (x, y) = (id as f64, value(p.rank) as f64);
                sx += x;
                sy += y;
                sxx += x * x;
                syy += y * y;
                sxy += x * y;
                cnt += 1.0;
            }
        }
        corr_num +=
            (cnt * sxy - sx * sy) / (((cnt * sxx - sx * sx) * (cnt * syy - sy * sy)).sqrt());
        assert!(
            corr_num.abs() < 0.05,
            "rank follows the piece number: correlation {corr_num}"
        );
        let share = firsts as f64 / seeds as f64;
        assert!(
            (0.45..0.55).contains(&share),
            "sides should be random, US first {share}"
        );
    }

    #[test]
    fn the_no_legal_move_check_does_the_same_work_whatever_the_layout() {
        let full = Game::from_setup(&setup(&seed_of(1)), 0, CHAIN_CLOCK).unwrap();
        let empty = Game::start(&[], Army::Us, 99, 0, 0, CHAIN_CLOCK).unwrap();
        let stuck = Game::start(
            &[
                LayoutPiece {
                    army: Army::Us,
                    rank: BOMB,
                    sq: 95,
                },
                LayoutPiece {
                    army: Army::It,
                    rank: RECON,
                    sq: 0,
                },
            ],
            Army::Us,
            99,
            0,
            0,
            CHAIN_CLOCK,
        )
        .unwrap();
        let recon_free = Game::start(
            &[LayoutPiece {
                army: Army::Us,
                rank: RECON,
                sq: 85,
            }],
            Army::Us,
            99,
            0,
            0,
            CHAIN_CLOCK,
        )
        .unwrap();
        for g in [&full, &empty, &stuck, &recon_free] {
            for army in [Army::Us, Army::It] {
                assert_eq!(g.scan(army, 0, false, NO_PIECE, 0).work, SCAN_WORK);
            }
        }
        assert!(!stuck.has_moves(Army::Us));
        assert!(stuck.has_moves(Army::It));
        assert!(!empty.has_moves(Army::Us));
        assert!(recon_free.has_moves(Army::Us));
    }

    #[test]
    fn events_fit_a_fixed_record_and_an_account_ring() {
        // 16 records must stay a small slice of an account
        assert!(
            core::mem::size_of::<Record>() * 16 < 2048,
            "{}",
            core::mem::size_of::<Record>()
        );
        assert!(core::mem::size_of::<Game>() < 1024);
    }

    #[test]
    fn rejects_a_bad_layout() {
        let one = |sq, rank| {
            [LayoutPiece {
                army: Army::Us,
                rank,
                sq,
            }]
        };
        assert_eq!(
            Game::start(&one(45, 5), Army::Us, 1, 1, 0, CHAIN_CLOCK).err(),
            Some(SetupError::BadSquare)
        );
        assert_eq!(
            Game::start(&one(85, 0), Army::Us, 1, 1, 0, CHAIN_CLOCK).err(),
            Some(SetupError::BadRank)
        );
        let two = [
            LayoutPiece {
                army: Army::Us,
                rank: 5,
                sq: 85,
            },
            LayoutPiece {
                army: Army::It,
                rank: 5,
                sq: 85,
            },
        ];
        assert_eq!(
            Game::start(&two, Army::Us, 1, 1, 0, CHAIN_CLOCK).err(),
            Some(SetupError::SquareTaken)
        );
    }

    #[test]
    fn the_storm_draws_match_the_apps_generator() {
        // mulberry32(1): the first three outputs as computed by the app's `seeded(1)`
        let mut m = Mulberry(1);
        assert_eq!(
            [m.next(), m.next(), m.next()],
            [2693262067, 11749833, 2265367787]
        );
    }
}

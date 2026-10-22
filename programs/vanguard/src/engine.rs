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
//! Compute: nothing on the path of the declares and resolves branches on a hidden rank. The legality check probes
//! the one piece asked about and the "any legal action?" check visits the side to move's thirty slots, each with a
//! fixed number of steps for every shape a rank could make (straight lines, diagonal lines, jumps, wadi crossings),
//! whatever the layout, so what a Player has on the board does not change the cost. Ranks are only compared with
//! arithmetic, never with `if` or `&&`. A fight, a Blast and a Rescue are the places where the work depends on the
//! pieces, and it depends on their published outcome only.
//!
//! Powers (rules version 6): the Sergeant moves like a bishop, the Captain like a king, the Lieutenant jumps, the
//! General crosses a wadi, the Engineer Blasts, the Colonel Rescues the Truck, the Major digs in and the General of
//! the Army becomes a Spy. Dig in and Become a Spy are secret: they rewrite a piece's *private rank code* (`DUG_IN`,
//! `SWITCHED`), which the engine reads as a Landmine and as a Spy. A Battle created under an older version keeps
//! that version's rules (`Game::version`, a public number, so branching on it leaks nothing).

use anchor_lang::solana_program::hash::hashv;

/// Bump when a rule changes; the recordings and the app change with it. Each Battle stores the version it was
/// created under.
pub const RULES_VERSION: u8 = 6;

pub const SIZE: usize = 10;
pub const SQUARES: usize = SIZE * SIZE;
/// One slot per start square: Italy rows 0-2, US rows 7-9.
pub const PIECE_SLOTS: usize = 60;
pub const ARMY_PIECES: usize = 20;
pub const TURN_SECS: i64 = 10;
/// Extra seconds on every deadline for network delay. Ticket 01's latency spike may change it.
pub const GRACE_SECS: i64 = 1;
/// Extra seconds on the opening turn only: `deal` starts the first mover's clock before they have loaded their
/// Army. One constant here and in the app's `CHAIN_CLOCK`.
pub const OPENING_GRACE_SECS: i64 = 10;
/// How long after a declare a resolve still counts as "now" for the next deadline. A client that holds back the
/// resolve gets no more thinking time than this: the next deadline counts from
/// `min(resolve time, declare time + RESOLVE_SLACK_SECS)`.
pub const RESOLVE_SLACK_SECS: i64 = 2;
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
/// Squares per direction the "any legal move?" check looks at. The shuttle ban covers one square, so if a run of
/// three or more is legal its first square is open and either it or the second one is legal.
const EXISTS_DEPTH: usize = 2;
/// Most events one action can produce. Worst cases: a move is switched, move or attack, Spotted, raid, storm, turn,
/// end = 7; a Dig in is switched, dug in, pass, storm, turn, end = 6; a Blast or a Rescue is switched, the blast
/// or rescue, storm, turn, end = 5. One spare.
pub const MAX_EVENTS: usize = 8;
/// A Blast shows up to eight neighbours.
pub const MAX_BLAST: usize = 8;
/// A storm line has ten squares.
pub const MAX_SHIFTS: usize = SIZE;

/// Ranks. 0 marks an empty slot.
pub const GENERAL_OF_THE_ARMY: u8 = 10;
pub const RECON: u8 = 2;
pub const SPY: u8 = 1;
pub const ENGINEER: u8 = 3;
pub const SERGEANT: u8 = 4;
pub const LIEUTENANT: u8 = 5;
pub const CAPTAIN: u8 = 6;
pub const MAJOR: u8 = 7;
pub const COLONEL: u8 = 8;
pub const GENERAL: u8 = 9;
/// The Landmine.
pub const BOMB: u8 = 11;
/// The Supply Truck.
pub const TRUCK: u8 = 12;
/// Private rank code of a Major that dug in. The engine plays it as a Landmine. It lives only in the owner's Army
/// account (`ranks`) and in `Game`, and is never published as such: the public shows the Landmine.
pub const DUG_IN: u8 = 13;
/// Private rank code of a General of the Army that became a Spy. The engine plays it as a Spy (1).
pub const SWITCHED: u8 = 14;
/// The largest rank code a slot may hold.
pub const MAX_CODE: u8 = SWITCHED;

/// The rank a piece plays as, from its stored code: a dug-in Major is a Landmine, a switched General of the Army a
/// Spy. Arithmetic only, so the work never depends on which code a slot holds.
#[inline(always)]
pub fn eff(code: u8) -> u8 {
    ct::pick(
        ct::eq(code as u64, DUG_IN as u64),
        BOMB,
        ct::pick(ct::eq(code as u64, SWITCHED as u64), SPY, code),
    )
}

/// 1 when the stored code is one of the two private change codes.
#[inline(always)]
pub fn is_changed_code(code: u8) -> u8 {
    ct::eq(code as u64, DUG_IN as u64) | ct::eq(code as u64, SWITCHED as u64)
}

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

/// What a claimed timeout will do, decided when it is claimed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TimeoutClass {
    /// The turn's deadline passed: the turn is lost.
    Pass,
    /// The time cap passed: the Match ends on the tiebreak.
    Cap,
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
    /// An Engineer blew itself up: it is shown and gone, and every piece on the squares around it is face up for
    /// good. `shown` holds `n` pairs (piece number, rank it plays as now), in row-major scan order of the squares.
    Blast {
        id: u8,
        at: u8,
        n: u8,
        shown: [(u8, u8); MAX_BLAST],
    },
    /// A Colonel blew itself up (shown) and the Truck jumped from `from` onto its square `to`.
    Rescue {
        colonel: u8,
        truck: u8,
        from: u8,
        to: u8,
    },
    /// A face-up Major dug in. A face-down one's Dig in is a plain `Pass`, never named.
    DugIn {
        army: Army,
        id: u8,
    },
    /// An army passed its turn on purpose; a face-down Dig in produces exactly this and nothing else.
    Pass {
        army: Army,
    },
    /// A face-up General of the Army became a Spy. A face-down one switches with no event.
    Switched {
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
    /// Added to the first turn's deadline only.
    pub opening_grace_secs: i64,
    /// Bound on how much a delayed resolve may add to the next deadline.
    pub resolve_slack_secs: i64,
}

/// The chain's clock: 10 s plus the grace, and the opening turn's extra.
pub const CHAIN_CLOCK: Clock = Clock {
    turn_secs: TURN_SECS,
    grace_secs: GRACE_SECS,
    opening_grace_secs: OPENING_GRACE_SECS,
    resolve_slack_secs: RESOLVE_SLACK_SECS,
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
    /// The time cap: a move or claim after this second ends the Match on the tiebreak.
    pub cap_at: i64,
    pub move_cap: u16,
    pub deadline: i64,
    pub storm_at: u16,
    pub storm_seed: u32,
    pub storm_done: bool,
    pub event_seq: u32,
    pub winner: Option<Winner>,
    pub reason: Option<EndReason>,
    /// The rules this Game plays under. Public, so the engine may branch on it.
    pub version: u8,
    /// Bit `id` set when that piece's rank changed (Dig in, Become a Spy), dead pieces included: the end mask.
    pub changed: u64,
    /// The rank each piece played as when it left the board (0 for one still on it): what the public shows for it.
    pub fallen: [u8; PIECE_SLOTS],
}

/// The depot an army raids sits in the other army's base: US raids row 1 column 5, Italy raids row 8 column 4.
pub const DEPOT_SQ: [u8; 2] = [15, 84];

const DIRS: [(i8, i8); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];
const DIAGS: [(i8, i8); 4] = [(-1, -1), (-1, 1), (1, -1), (1, 1)];

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

/// Comparisons on hidden values with no branch. The SBF target has no conditional move or set-on-compare, so a
/// `bool` made from a comparison of a rank is a jump, and a jump that goes one way for a Truck and the other for a
/// General costs a different number of instructions. These helpers return a `u8` that is 0 or 1 and are built from
/// arithmetic only; `opaque` keeps the optimiser from folding them back into a comparison.
pub(crate) mod ct {
    #[inline(always)]
    fn opaque(x: u64) -> u64 {
        core::hint::black_box(x)
    }
    /// 1 when `a == b`, else 0 (both below 2^63).
    #[inline(always)]
    pub fn eq(a: u64, b: u64) -> u8 {
        (opaque(a ^ b).wrapping_sub(1) >> 63) as u8
    }
    /// 1 when `a < b` (both below 2^62), else 0.
    #[inline(always)]
    pub fn lt(a: u64, b: u64) -> u8 {
        (opaque(a).wrapping_sub(b) >> 63) as u8
    }
    /// 1 when `x` is not zero, else 0.
    #[inline(always)]
    pub fn nonzero_u8(x: u8) -> u8 {
        1 ^ eq(x as u64, 0)
    }
    /// All ones when `c` is 1, all zeros when it is 0. Opaque, so a select built from it stays a mask and is not
    /// folded back into a jump.
    #[inline(always)]
    pub fn mask(c: u8) -> u8 {
        core::hint::black_box(0u8.wrapping_sub(c))
    }
    /// `x` when `c` is 1, `y` when it is 0.
    #[inline(always)]
    pub fn pick(c: u8, x: u8, y: u8) -> u8 {
        y ^ ((x ^ y) & mask(c))
    }
    #[inline(always)]
    pub fn pick32(c: u8, x: i32, y: i32) -> i32 {
        y ^ ((x ^ y) & (mask(c) as i8 as i32))
    }
}

/// 1 when `x` is not zero, else 0, from arithmetic only (see `ct`).
#[inline(always)]
fn nonzero(x: u64) -> u8 {
    1 ^ ct::eq(x, 0)
}

/// Combat value: 0 for the Landmine and the Truck.
fn value(rank: u8) -> u8 {
    rank * ct::lt(rank as u64, BOMB as u64)
}

const OUTCOMES: [Outcome; 6] = [
    Outcome::Win,
    Outcome::Lose,
    Outcome::Tie,
    Outcome::Mine,
    Outcome::Defuse,
    Outcome::Truck,
];

/// Who wins when `a` attacks `d`, both as the ranks they play as (see `eff`). Branch-free: every pair of ranks runs
/// the same instructions, so the work of a fight says nothing about the ranks beyond the outcome, which is published
/// anyway (the winning attacker in particular stays hidden, so a Spy that wins must cost what any other winner
/// costs). From rules version 6 attacking a Landmine is always `Mine`; before it the Engineer defused one.
pub fn fight(a: u8, d: u8, version: u8) -> Outcome {
    let spy_kills = ct::eq(a as u64, SPY as u64) & ct::eq(d as u64, GENERAL_OF_THE_ARMY as u64);
    let wins = spy_kills | ct::lt(value(d) as u64, value(a) as u64);
    let mut code = ct::pick(wins, 0, 1);
    code = ct::pick(ct::eq(a as u64, d as u64), 2, code);
    let engineer = ct::eq(a as u64, ENGINEER as u64) & ct::lt(version as u64, 6);
    code = ct::pick(
        ct::eq(d as u64, BOMB as u64),
        ct::pick(engineer, 4, 3),
        code,
    );
    code = ct::pick(ct::eq(d as u64, TRUCK as u64), 5, code);
    OUTCOMES[code as usize]
}

/// Inner steps of the legality check: one piece, eight lines of nine squares, four jumps, four wadi crossings.
pub const PROBE_WORK: u32 = 8 * RUN as u32 + 8;
/// Inner steps of the "any legal move?" check: the side's thirty slots, eight lines of two squares, four jumps, four
/// wadi crossings.
pub const ANY_MOVE_WORK: u32 = (30 * (8 * EXISTS_DEPTH + 8)) as u32;

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

/// Setup randomness: independent SHA-256 counter-mode streams from the 32-byte seed, one per purpose (the side
/// draw, each army's layout, the storm turn, the storm line), domain-separated by a label. A Player who knows their
/// own layout learns nothing about another stream: there is no generator state to recover.
struct Draw {
    seed: [u8; 32],
    label: &'static [u8],
    counter: u64,
    block: [u8; 32],
    used: usize,
}

impl Draw {
    fn new(seed: &[u8; 32], label: &'static [u8]) -> Draw {
        Draw {
            seed: *seed,
            label,
            counter: 0,
            block: [0; 32],
            used: 32,
        }
    }
    fn next(&mut self) -> u64 {
        if self.used == 32 {
            self.block = hashv(&[
                b"vanguard/draw/v1",
                self.label,
                &self.seed,
                &self.counter.to_le_bytes(),
            ])
            .to_bytes();
            self.counter += 1;
            self.used = 0;
        }
        let mut b = [0u8; 8];
        b.copy_from_slice(&self.block[self.used..self.used + 8]);
        self.used += 8;
        u64::from_le_bytes(b)
    }
    /// A number in `0..n`; the bias is below n / 2^32.
    fn below(&mut self, n: u32) -> u32 {
        (((self.next() >> 32) * n as u64) >> 32) as u32
    }
}

/// A random Match: both armies dropped on their start zones, which seat plays the US Army, the storm turn and seed.
#[derive(Clone, Copy, Debug)]
pub struct Setup {
    pub pieces: [LayoutPiece; 2 * ARMY_PIECES],
    /// The draw of who would move first. The program does not use it: the US Army moves first.
    pub first: Army,
    /// Which seat (0 or 1) plays the US Army.
    pub us_seat: u8,
    pub storm_at: u16,
    pub storm_seed: u32,
}

/// The depot square inside `army`'s base (the one its enemy raids).
const fn own_depot(army: Army) -> u8 {
    DEPOT_SQ[army.enemy().idx()]
}

const fn chebyshev(a: u8, b: u8) -> u8 {
    let (dr, dc) = (row(a).abs_diff(row(b)), col(a).abs_diff(col(b)));
    if dr > dc {
        dr
    } else {
        dc
    }
}

const fn manhattan(a: u8, b: u8) -> u8 {
    row(a).abs_diff(row(b)) + col(a).abs_diff(col(b))
}

/// Draw the whole Match from a 32-byte seed. Each draw is a fixed number of calls, so it is deterministic.
/// Landmines and the Truck never spawn on the row facing no-man's-land, the depot square stays empty and no
/// Landmine spawns next to it.
pub fn setup(seed: &[u8; 32], storm_from: u16, storm_to: u16) -> Setup {
    let mut out = [LayoutPiece {
        army: Army::Us,
        rank: 0,
        sq: 0,
    }; 2 * ARMY_PIECES];
    let armies: [(Army, &'static [u8]); 2] = [(Army::It, b"layout-it"), (Army::Us, b"layout-us")];
    for (n, (army, label)) in armies.into_iter().enumerate() {
        let mut d = Draw::new(seed, label);
        place_army(
            army,
            &mut d,
            &mut out[n * ARMY_PIECES..(n + 1) * ARMY_PIECES],
        );
    }
    let first = if Draw::new(seed, b"first").below(2) == 0 {
        Army::Us
    } else {
        Army::It
    };
    let us_seat = Draw::new(seed, b"side").below(2) as u8;
    let storm_at = storm_from
        + Draw::new(seed, b"storm-turn").below((storm_to - storm_from + 1) as u32) as u16;
    let storm_seed = (Draw::new(seed, b"storm-line").next() >> 32) as u32;
    Setup {
        pieces: out,
        first,
        us_seat,
        storm_at,
        storm_seed,
    }
}

/// The two sealing keys of a Match, one per army (index `Army::idx`), drawn from the setup seed. Each is 32 bytes of
/// its own SHA-256 counter-mode stream (labels `seal-key-us` / `seal-key-it`), so it is independent of the layouts,
/// the side draw and the storm: a Player who knows their own layout and key learns nothing about another stream.
pub fn seal_keys(seed: &[u8; 32]) -> [[u8; 32]; 2] {
    let labels: [&'static [u8]; 2] = [b"seal-key-us", b"seal-key-it"];
    let mut keys = [[0u8; 32]; 2];
    for (key, label) in keys.iter_mut().zip(labels) {
        let mut d = Draw::new(seed, label);
        for chunk in key.chunks_exact_mut(8) {
            chunk.copy_from_slice(&d.next().to_le_bytes());
        }
    }
    keys
}

/// Domain of the sealing pad. See `seal_pad`.
pub const SEAL_DOMAIN: &[u8] = b"vanguard-seal-v1";
/// `seal_pad` field: the sealed Dig in slot of a pass.
pub const SEAL_DIG: u8 = 1;
/// `seal_pad` field: the sealed switch of a move, Blast, Rescue or pass.
pub const SEAL_SWITCH: u8 = 2;

/// The one-time pad byte for `(key, battle, seat, seq, field)`:
/// `SHA-256("vanguard-seal-v1" || key || battle || seat || seq (u32 LE) || field)[0]`. `seq` is the `expected_seq` the
/// declare carried; each `(key, seq, field)` seals one byte, once. A client that seals with this and sends
/// `plain ^ pad` shows the chain nothing: without the key every ciphertext byte is equally likely.
pub fn seal_pad(key: &[u8; 32], battle: &[u8; 32], seat: u8, seq: u32, field: u8) -> u8 {
    hashv(&[
        SEAL_DOMAIN,
        key,
        battle,
        &[seat],
        &seq.to_le_bytes(),
        &[field],
    ])
    .to_bytes()[0]
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
            cap_at: started_at.saturating_add(CAP_SECS),
            move_cap: MOVE_CAP,
            deadline: started_at
                .saturating_add(clock.turn_secs)
                .saturating_add(clock.grace_secs)
                .saturating_add(clock.opening_grace_secs),
            storm_at,
            storm_seed,
            storm_done: false,
            event_seq: 0,
            winner: None,
            reason: None,
            version: RULES_VERSION,
            changed: 0,
            fallen: [0; PIECE_SLOTS],
        };
        for l in layout {
            let id = start_index(l.sq).ok_or(SetupError::BadSquare)?;
            if (id >= 30) != (l.army == Army::Us) {
                return Err(SetupError::BadSquare);
            }
            if l.rank == 0 || l.rank > MAX_CODE {
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
            g.changed |= (is_changed_code(l.rank) as u64) << id;
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

    /// The time the next deadline counts from, for an action declared at `declared` and resolved at `resolved`.
    pub fn counted(&self, declared: i64, resolved: i64) -> i64 {
        resolved.min(declared.saturating_add(self.clock.resolve_slack_secs))
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

    /// 1 when the piece may move this turn, from its rank and fuel alone. No comparison of a hidden value is a branch.
    fn can_move(&self, id: usize, p: &Piece, moved: u64) -> u8 {
        let fuel_left = ct::lt(p.fuel as u64, TRUCK_FUEL as u64);
        let last = self.truck_turn[p.army.idx()] as u32 as u64;
        let rested = 1 ^ ct::eq(last, (self.turn_no as i32 - 2) as u32 as u64);
        let not_moved = (((moved >> id) & 1) as u8) ^ 1;
        let truck_ok = fuel_left & rested & not_moved;
        let is_truck = ct::eq(p.rank as u64, TRUCK as u64);
        let is_bomb = ct::eq(eff(p.rank) as u64, BOMB as u64);
        (1 ^ is_bomb) & ((1 ^ is_truck) | truck_ok)
    }

    /// The square `k` steps from `(pr, pc)` along `(dr, dc)` and whether it is on the board (square 0 when it is not,
    /// so the lookups after it stay in range).
    #[inline(always)]
    fn at_step(pr: i8, pc: i8, dr: i8, dc: i8, k: i8) -> (u8, u8) {
        let r = pr + dr * k;
        let c = pc + dc * k;
        let inb = (((r as u8) < SIZE as u8) as u8) & (((c as u8) < SIZE as u8) as u8);
        (inb, if inb != 0 { (r * 10 + c) as u8 } else { 0 })
    }

    /// Walk every shape the piece's rank could make out of piece `id`: eight lines of `DEPTH` squares (straight for
    /// the Recon and every default step, diagonal for the Sergeant and the Captain), four straight jumps over a
    /// neighbour (Lieutenant) and four straight wadi crossings (General). How many targets are legal, and whether
    /// `probe_to` is one of them. Every direction, shape and square is visited whatever is on the board and whatever
    /// the rank is, with no early exit; the rank only decides, with masks, which of the visited squares count.
    #[inline(always)]
    fn piece_scan<const DEPTH: usize>(
        &self,
        id: usize,
        army: Army,
        moved: u64,
        two_step_active: bool,
        probe_to: u8,
    ) -> (u16, bool, u32) {
        let p = &self.pieces[id];
        let live = ((p.rank != 0) as u8) & ((p.army == army) as u8) & self.can_move(id, p, moved);
        let plays = eff(p.rank) as u64;
        let open = (!two_step_active) as u8;
        // Public: the version decides whether the new shapes exist at all.
        let v6 = (self.version >= 6) as u8;
        let is = |rank: u8| ct::eq(plays, rank as u64);
        let recon = is(RECON);
        let sergeant = is(SERGEANT) & v6;
        let captain = is(CAPTAIN) & v6;
        let lieutenant = is(LIEUTENANT) & v6 & open;
        let general = is(GENERAL) & v6 & open;
        // Squares a line may reach: a Sergeant never walks straight, only a Recon runs far and a Two-Step Turn is
        // one square per step.
        let straight_reach = ct::pick(sergeant, 0, ct::pick(recon & open, RUN as u8, 1));
        let diag_reach = ct::pick(
            sergeant,
            ct::pick(open, RUN as u8, 1),
            ct::pick(captain, 1, 0),
        );
        let pr = row(p.sq) as i8;
        let pc = col(p.sq) as i8;
        let mut count: u16 = 0;
        let mut hit: u8 = 0;
        let mut work: u32 = 0;
        for (lines, reach) in [(DIRS, straight_reach), (DIAGS, diag_reach)] {
            for (dr, dc) in lines {
                let mut run_open = live;
                for k in 1..=DEPTH as i8 {
                    let (inb, sq) = Self::at_step(pr, pc, dr, dc, k);
                    let occ = self.cells[sq as usize];
                    let own = ((occ != 0) as u8)
                        & ((self.pieces[occ.saturating_sub(1) as usize].army == army) as u8);
                    let within = 1 ^ ct::lt(reach as u64, k as u64);
                    let ok = run_open & within & inb & (!is_wadi(sq) as u8) & (1 ^ own);
                    let legal = ok & (!shuttling(p, sq) as u8);
                    count += legal as u16;
                    hit |= legal & ((sq == probe_to) as u8);
                    run_open = ok & ((occ == 0) as u8);
                    work += 1;
                }
            }
        }
        for (dr, dc) in DIRS {
            // Lieutenant: over an occupied neighbour onto an empty or enemy square, never a wadi.
            let (_, mid) = Self::at_step(pr, pc, dr, dc, 1);
            let (inb, sq) = Self::at_step(pr, pc, dr, dc, 2);
            let over = (self.cells[mid as usize] != 0) as u8;
            let occ = self.cells[sq as usize];
            let own = ((occ != 0) as u8)
                & ((self.pieces[occ.saturating_sub(1) as usize].army == army) as u8);
            let ok = live & lieutenant & over & inb & (!is_wadi(sq) as u8) & (1 ^ own);
            let legal = ok & (!shuttling(p, sq) as u8);
            count += legal as u16;
            hit |= legal & ((sq == probe_to) as u8);
            work += 1;
            // General: straight over the two squares of a wadi onto the first square beyond.
            let (_, w1) = Self::at_step(pr, pc, dr, dc, 1);
            let (_, w2) = Self::at_step(pr, pc, dr, dc, 2);
            let (inb, sq) = Self::at_step(pr, pc, dr, dc, 3);
            let occ = self.cells[sq as usize];
            let own = ((occ != 0) as u8)
                & ((self.pieces[occ.saturating_sub(1) as usize].army == army) as u8);
            let across = (is_wadi(w1) as u8) & (is_wadi(w2) as u8);
            let ok = live & general & across & inb & (!is_wadi(sq) as u8) & (1 ^ own);
            let legal = ok & (!shuttling(p, sq) as u8);
            count += legal as u16;
            hit |= legal & ((sq == probe_to) as u8);
            work += 1;
        }
        (count, hit != 0, work)
    }

    /// Whether piece `id` of `army` may go to `to` now. Probes that one piece only.
    pub fn probe(&self, army: Army, moved: u64, two_step_active: bool, id: u8, to: u8) -> bool {
        self.piece_scan::<{ RUN as usize }>(id as usize, army, moved, two_step_active, to)
            .1
    }

    /// Whether `army` has any legal move. Only the army's own thirty slots can move, and two squares per line
    /// decide it. Same work whatever the layout, no early exit.
    pub fn any_move(&self, army: Army, moved: u64, two_step_active: bool) -> bool {
        self.any_move_mask(army, moved, two_step_active) != 0
    }

    /// `any_move` as a 0/1 byte built from arithmetic only, so a caller that combines it with other hidden predicates
    /// (`has_action`) never turns a hidden count into a branch before the public result is known.
    pub fn any_move_mask(&self, army: Army, moved: u64, two_step_active: bool) -> u8 {
        let base = if army == Army::Us { 30 } else { 0 };
        let mut count: u16 = 0;
        for id in base..base + 30 {
            count += self
                .piece_scan::<EXISTS_DEPTH>(id, army, moved, two_step_active, NO_PIECE)
                .0;
        }
        nonzero(count as u64)
    }

    /// Whether `army` has any legal move at the start of its turn.
    pub fn has_moves(&self, army: Army) -> bool {
        self.any_move(army, 0, false)
    }

    /// Whether `army` has any one-square step now, the way a Two-Step Turn counts steps (`self.moved` as it stands).
    pub fn has_step(&self, army: Army) -> bool {
        self.any_move(army, self.moved, true)
    }

    /// Whether `army` has a Blast, a Rescue or a Dig in: a live Engineer, a live Colonel with its Truck on the board,
    /// or a live Major that has not dug in. Counts over the thirty slots with masks, whatever the layout.
    pub fn has_power(&self, army: Army) -> bool {
        self.has_power_mask(army) != 0
    }

    /// `has_power` as a 0/1 byte. Every count is turned into a flag with arithmetic (`nonzero`), never a comparison:
    /// a comparison of a hidden count is a jump on SBF, and the jump costs one instruction more or less (a dug-in Major
    /// is no Major, which would show in the compute of the opponent's next resolve).
    pub fn has_power_mask(&self, army: Army) -> u8 {
        let base = if army == Army::Us { 30 } else { 0 };
        let (mut engineers, mut colonels, mut trucks, mut majors) = (0u16, 0u16, 0u16, 0u16);
        for p in &self.pieces[base..base + 30] {
            let live = (p.rank != 0) as u8;
            let is = |rank: u8| ct::eq(p.rank as u64, rank as u64) & live;
            engineers += is(ENGINEER) as u16;
            colonels += is(COLONEL) as u16;
            trucks += is(TRUCK) as u16;
            majors += is(MAJOR) as u16;
        }
        let rescue = nonzero(colonels as u64) & nonzero(trucks as u64);
        let v6 = (self.version >= 6) as u8;
        v6 & (nonzero(engineers as u64) | rescue | nonzero(majors as u64))
    }

    /// Whether `army` has any move, Blast, Rescue or Dig in at the start of its turn. The "no legal move" ending uses
    /// this one; Passing does not count as an action. The two halves are combined as masks and only the final public
    /// answer becomes a `bool`.
    pub fn has_action(&self, army: Army) -> bool {
        let m = self.any_move_mask(army, 0, false);
        let p = self.has_power_mask(army);
        (m | p) != 0
    }

    /// Higher total of surviving ranks wins (Landmines and the Truck count 0), then more pieces, else a draw.
    pub fn cap_winner(&self) -> Winner {
        let mut sum = [0u16; 2];
        let mut n = [0u16; 2];
        // ranks as they are at the end: a dug-in Major counts 0 (a Landmine), a switched General of the Army 1
        for p in self.pieces.iter().filter(|p| p.rank != 0) {
            sum[p.army.idx()] += value(eff(p.rank)) as u16;
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
        at > self.cap_at
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
        self.fallen[id] = eff(self.pieces[id].rank);
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

    /// What the program checks when a move is declared, from public state alone: the clock (frozen here, never
    /// checked again), the piece and the geometry that holds whatever the piece is. The rank-dependent rules
    /// (Landmine, runs, jumps, crossings, the Truck's fuel) are applied at the resolve, so a declare reads no rank.
    /// From version 6 the geometry also admits diagonals (the Sergeant and the Captain).
    pub fn check_declared_move(&self, id: u8, to: u8, at: i64) -> Result<(), Refusal> {
        if let Some(r) = self.clock_refusal(at) {
            return Err(r);
        }
        if id as usize >= PIECE_SLOTS || self.pieces[id as usize].rank == 0 {
            return Err(Refusal::NoSuchPiece);
        }
        let army = self.turn;
        let p = &self.pieces[id as usize];
        if p.army != army {
            return Err(Refusal::NotYourTurn);
        }
        let straight = row(p.sq) == row(to) || col(p.sq) == col(to);
        let diagonal =
            self.version >= 6 && row(p.sq).abs_diff(row(to)) == col(p.sq).abs_diff(col(to));
        let cell = self.cells[(to as usize).min(SQUARES - 1)];
        let own = cell != 0 && self.pieces[cell as usize - 1].army == army;
        if to as usize >= SQUARES
            || is_wadi(to)
            || !(straight || diagonal)
            || to == p.sq
            || own
            || shuttling(p, to)
        {
            return Err(Refusal::IllegalMove);
        }
        Ok(())
    }

    /// What the program checks when a Blast or Rescue is declared, from public state alone: the clock, the piece
    /// (yours, on the board) and that nothing has been done this turn. Reads no rank.
    pub fn check_declared_act(&self, id: u8, at: i64) -> Result<(), Refusal> {
        if let Some(r) = self.clock_refusal(at) {
            return Err(r);
        }
        if id as usize >= PIECE_SLOTS || self.pieces[id as usize].rank == 0 {
            return Err(Refusal::NoSuchPiece);
        }
        if self.pieces[id as usize].army != self.turn {
            return Err(Refusal::NotYourTurn);
        }
        if !self.acts_open() {
            return Err(Refusal::IllegalMove);
        }
        Ok(())
    }

    /// What the program checks when a pass (or a Dig in, which is the same instruction) is declared: the clock and
    /// that nothing has been done this turn.
    pub fn check_declared_pass(&self, at: i64) -> Result<(), Refusal> {
        if let Some(r) = self.clock_refusal(at) {
            return Err(r);
        }
        if !self.acts_open() {
            return Err(Refusal::IllegalMove);
        }
        Ok(())
    }

    /// Public: Blast, Rescue, Dig in and passing exist on version 6 only, never inside a Two-Step Turn and never
    /// after a first step.
    fn acts_open(&self) -> bool {
        self.version >= 6 && !self.two_step_active && self.moved == 0
    }

    /// Whether the side to move may move piece `id` to `to` at time `at`: the clock, the piece and all the rules.
    pub fn check_move(&self, id: u8, to: u8, at: i64) -> Result<(), Refusal> {
        self.check_declared_move(id, to, at)?;
        if !self.probe(self.turn, self.moved, self.two_step_active, id, to) {
            return Err(Refusal::IllegalMove);
        }
        Ok(())
    }

    /// Move (or attack with) piece `id` to square `to` at time `at`, becoming a Spy first when `switch` is set and
    /// the side's General of the Army can. On a refusal nothing changes (a switch rides on a legal action only).
    pub fn move_piece(
        &mut self,
        id: u8,
        to: u8,
        at: i64,
        switch: impl Into<u8>,
        out: &mut Events,
    ) -> Result<(), Refusal> {
        out.len = 0;
        self.check_move(id, to, at)?;
        self.apply_move(id, to, at, switch, out);
        Ok(())
    }

    /// Apply a move declared earlier (its clock decision is made and not made again) at time `resolved`. The hidden
    /// rules are checked here; a move they do not allow costs the turn, like a timeout, so this never fails and a
    /// failure cannot depend on a rank. The next deadline counts from `resolved`. `switch` is the decoded sealed
    /// byte; it is applied only to a move that is legal, and whether the move is legal does not depend on it.
    pub fn resolve_move(
        &mut self,
        id: u8,
        to: u8,
        switch: impl Into<u8>,
        resolved: i64,
        out: &mut Events,
    ) {
        out.len = 0;
        let legal = (id as usize) < PIECE_SLOTS
            && self.probe(self.turn, self.moved, self.two_step_active, id, to);
        if legal {
            self.apply_move(id, to, resolved, switch, out);
        } else {
            self.lose_turn(resolved, out);
        }
    }

    /// 1 when piece `id` is an Engineer (as it plays).
    fn may_blast(&self, id: usize) -> bool {
        ct::eq(eff(self.pieces[id].rank) as u64, ENGINEER as u64) != 0
    }

    /// 1 when piece `id` is a Colonel and its army's Truck is on the board. Same work whatever the layout.
    fn may_rescue(&self, id: usize) -> bool {
        let base = if self.pieces[id].army == Army::Us {
            30
        } else {
            0
        };
        let mut trucks = 0u16;
        for p in &self.pieces[base..base + 30] {
            trucks += ct::eq(p.rank as u64, TRUCK as u64) as u16;
        }
        let colonel = ct::eq(eff(self.pieces[id].rank) as u64, COLONEL as u64);
        (colonel & nonzero(trucks as u64)) != 0
    }

    /// Blast with Engineer `id` at time `at`. Counts as a move and passes the turn.
    pub fn blast(
        &mut self,
        id: u8,
        at: i64,
        switch: impl Into<u8>,
        out: &mut Events,
    ) -> Result<(), Refusal> {
        out.len = 0;
        self.check_declared_act(id, at)?;
        if !self.may_blast(id as usize) {
            return Err(Refusal::IllegalMove);
        }
        self.apply_blast(id, at, switch, out);
        Ok(())
    }

    /// Rescue with Colonel `id` at time `at`. Counts as a move and passes the turn.
    pub fn rescue(
        &mut self,
        id: u8,
        at: i64,
        switch: impl Into<u8>,
        out: &mut Events,
    ) -> Result<(), Refusal> {
        out.len = 0;
        self.check_declared_act(id, at)?;
        if !self.may_rescue(id as usize) {
            return Err(Refusal::IllegalMove);
        }
        self.apply_rescue(id, at, switch, out);
        Ok(())
    }

    /// Pass the turn on purpose at time `at`. `dig_in` is the number of the piece to dig in (anything that is not a
    /// live Major of the side to move, `NO_PIECE` included, makes it a plain pass). A missed turn like a timeout.
    pub fn pass(
        &mut self,
        at: i64,
        dig_in: u8,
        switch: impl Into<u8>,
        out: &mut Events,
    ) -> Result<(), Refusal> {
        out.len = 0;
        self.check_declared_pass(at)?;
        self.apply_pass(at, dig_in, switch, out);
        Ok(())
    }

    /// Apply a declared Blast. Like `resolve_move`, one the rules refuse costs the turn.
    pub fn resolve_blast(
        &mut self,
        id: u8,
        switch: impl Into<u8>,
        resolved: i64,
        out: &mut Events,
    ) {
        out.len = 0;
        let legal = self.acts_open()
            && (id as usize) < PIECE_SLOTS
            && self.pieces[id as usize].rank != 0
            && self.pieces[id as usize].army == self.turn
            && self.may_blast(id as usize);
        if legal {
            self.apply_blast(id, resolved, switch, out);
        } else {
            self.lose_turn(resolved, out);
        }
    }

    /// Apply a declared Rescue. Like `resolve_move`, one the rules refuse costs the turn.
    pub fn resolve_rescue(
        &mut self,
        id: u8,
        switch: impl Into<u8>,
        resolved: i64,
        out: &mut Events,
    ) {
        out.len = 0;
        let legal = self.acts_open()
            && (id as usize) < PIECE_SLOTS
            && self.pieces[id as usize].rank != 0
            && self.pieces[id as usize].army == self.turn
            && self.may_rescue(id as usize);
        if legal {
            self.apply_rescue(id, resolved, switch, out);
        } else {
            self.lose_turn(resolved, out);
        }
    }

    /// Apply a declared pass, with the sealed Dig in and switch decoded. A pass is always allowed once declared (the
    /// declare checked the public conditions); if they no longer hold it costs the turn like any refused action.
    pub fn resolve_pass(
        &mut self,
        dig_in: u8,
        switch: impl Into<u8>,
        resolved: i64,
        out: &mut Events,
    ) {
        out.len = 0;
        if self.acts_open() {
            self.apply_pass(resolved, dig_in, switch, out);
        } else {
            self.lose_turn(resolved, out);
        }
    }

    /// Decode an unsealed switch byte: 0 is no switch, `slot + 1` names the army slot (`id % 30`) of the side to move
    /// that holds its live, unswitched General of the Army. Every other value (an out-of-range slot, an empty or dead
    /// slot, another rank, an already switched 10) decodes to "no switch". Visits all thirty slots with masks, so no
    /// byte value changes the work, and uses no byte as an index. Returns 0 or 1 as a byte, not a `bool`: a `bool`
    /// made from a comparison is a jump on the SBF target, and the jump would cost one unit more or less.
    pub fn switch_wanted(&self, plain: u8) -> u8 {
        let base = if self.turn == Army::Us { 30 } else { 0 };
        let mut hit = 0u8;
        for i in 0..30 {
            let rank = self.pieces[base + i].rank as u64;
            hit |= ct::eq(plain as u64, i as u64 + 1) & ct::eq(rank, GENERAL_OF_THE_ARMY as u64);
        }
        hit
    }

    /// Decode an unsealed Dig in byte of a pass into the piece number `resolve_pass` takes: 0 is a plain pass (`NO_PIECE`),
    /// `slot + 1` with `slot < 30` is that army slot of the side to move, and every other value is a plain pass too.
    /// Whether that piece really is a live Major that can dig in is decided by `apply_dig_in`, over all thirty slots.
    pub fn dig_in_piece(&self, plain: u8) -> u8 {
        let base = if self.turn == Army::Us { 30 } else { 0 };
        let p = plain as u64;
        let valid = (1 ^ ct::eq(p, 0)) & ct::lt(p, 31);
        let slot = plain.wrapping_sub(1) & 31;
        ct::pick(valid, base + slot, NO_PIECE)
    }

    /// Become a Spy: the side's live General of the Army switches when `want` is set. Visits all thirty slots with
    /// masks, so a switch or no switch, and a 10 or no 10, cost the same. An invalid switch does nothing and is never
    /// reported; only a face-up 10 announces it (its change is public the moment it happens).
    fn apply_switch(&mut self, want: impl Into<u8>, out: &mut Events) {
        let base = if self.turn == Army::Us { 30 } else { 0 };
        // A mask the optimiser cannot see through: with a plain `bool` it would unswitch the loop below and skip the
        // thirty slots when there is no switch, so the compute would say whether the switch was set.
        let want = ct::mask(want.into() & 1 & (self.version >= 6) as u8) & 1;
        let mut named = NO_PIECE;
        for i in base..base + 30 {
            let (rank, known) = (self.pieces[i].rank, self.pieces[i].known as u8);
            let hit = want & ct::eq(rank as u64, GENERAL_OF_THE_ARMY as u64);
            self.pieces[i].rank = ct::pick(hit, SWITCHED, rank);
            self.changed |= (hit as u64) << i;
            named = ct::pick(hit & known, i as u8, named);
        }
        if named != NO_PIECE {
            self.push(out, Event::Switched { id: named });
        }
    }

    /// Dig in piece number `dig_in` when it is a live Major of the side to move that has not dug in. Any other value,
    /// out of range included, does nothing. Visits all thirty slots with masks. Only a face-up Major's Dig in is named.
    fn apply_dig_in(&mut self, dig_in: u8, out: &mut Events) {
        let base = if self.turn == Army::Us { 30 } else { 0 };
        let mut named = NO_PIECE;
        for i in base..base + 30 {
            let (rank, known) = (self.pieces[i].rank, self.pieces[i].known as u8);
            let hit = ct::eq(i as u64, dig_in as u64) & ct::eq(rank as u64, MAJOR as u64);
            self.pieces[i].rank = ct::pick(hit, DUG_IN, rank);
            self.changed |= (hit as u64) << i;
            named = ct::pick(hit & known, i as u8, named);
        }
        if named != NO_PIECE {
            let army = self.turn;
            self.push(out, Event::DugIn { army, id: named });
        }
    }

    fn apply_pass(&mut self, at: i64, dig_in: u8, switch: impl Into<u8>, out: &mut Events) {
        self.apply_switch(switch, out);
        self.apply_dig_in(dig_in, out);
        let army = self.turn;
        self.push(out, Event::Pass { army });
        self.timeouts[army.idx()] += 1;
        self.deadline = self.turn_end(at);
        if self.timeouts[army.idx()] >= TIMEOUTS_TO_LOSE {
            self.end(out, Winner::Army(army.enemy()), EndReason::Timeouts);
            return;
        }
        self.end_turn(out, false);
    }

    fn apply_blast(&mut self, id: u8, at: i64, switch: impl Into<u8>, out: &mut Events) {
        self.apply_switch(switch, out);
        let army = self.turn;
        let i = id as usize;
        self.moves += 1;
        self.timeouts[army.idx()] = 0;
        let from = self.pieces[i].sq;
        // the squares around the Engineer in a fixed scan order; edges never wrap and a wadi square holds nothing
        let mut shown = [(0u8, 0u8); MAX_BLAST];
        let mut n = 0usize;
        for dr in -1i8..=1 {
            for dc in -1i8..=1 {
                if dr == 0 && dc == 0 {
                    continue;
                }
                let (inb, sq) = Self::at_step(row(from) as i8, col(from) as i8, dr, dc, 1);
                let cell = if inb != 0 { self.cells[sq as usize] } else { 0 };
                if cell != 0 {
                    let d = cell as usize - 1;
                    self.pieces[d].known = true;
                    shown[n] = (d as u8, eff(self.pieces[d].rank));
                    n += 1;
                }
            }
        }
        self.push(
            out,
            Event::Blast {
                id,
                at: from,
                n: n as u8,
                shown,
            },
        );
        self.remove(i);
        self.deadline = self.turn_end(at);
        self.end_turn(out, false);
    }

    fn apply_rescue(&mut self, id: u8, at: i64, switch: impl Into<u8>, out: &mut Events) {
        self.apply_switch(switch, out);
        let army = self.turn;
        let i = id as usize;
        self.moves += 1;
        self.timeouts[army.idx()] = 0;
        let base = if army == Army::Us { 30 } else { 0 };
        // the Truck is named in the event, so finding it may depend on where it is
        if let Some(t) = (base..base + 30).find(|&t| self.pieces[t].rank == TRUCK) {
            let (to, truck_from) = (self.pieces[i].sq, self.pieces[t].sq);
            self.remove(i);
            // no fuel, no Truck-move count; the trail starts over on the new square and the Truck is face up for good
            self.cells[truck_from as usize] = 0;
            self.cells[to as usize] = t as u8 + 1;
            let truck = &mut self.pieces[t];
            truck.sq = to;
            truck.trail = [to, 0, 0, 0, 0, 0];
            truck.trail_len = 1;
            truck.known = true;
            self.push(
                out,
                Event::Rescue {
                    colonel: id,
                    truck: t as u8,
                    from: truck_from,
                    to,
                },
            );
        }
        self.deadline = self.turn_end(at);
        self.end_turn(out, false);
    }

    fn apply_move(&mut self, id: u8, to: u8, at: i64, switch: impl Into<u8>, out: &mut Events) {
        // Become a Spy first (free): it is applied to a legal action only, and legality does not depend on it
        self.apply_switch(switch, out);
        let army = self.turn;
        let i = id as usize;
        let from = self.pieces[i].sq;
        let rank = self.pieces[i].rank;
        // a one-square step, straight or diagonal; runs, jumps and crossings are longer
        let step = chebyshev(from, to) == 1;
        self.moves += 1;
        self.timeouts[army.idx()] = 0;
        // A Truck's move costs what any other move costs: selects, no `if` on the rank.
        let truck = ct::eq(rank as u64, TRUCK as u64);
        self.pieces[i].fuel += truck;
        let last = &mut self.truck_turn[army.idx()];
        *last = ct::pick32(truck, self.turn_no as i32, *last);
        // Kept as a 0/1 byte until the one public test below: a `bool` made here is a jump on SBF, and the jump would
        // skip an instruction for a Truck with fuel left.
        let spent = truck & (1 ^ ct::lt(self.pieces[i].fuel as u64, TRUCK_FUEL as u64));
        let cell = self.cells[to as usize];
        if cell == 0 {
            self.land(i, to);
            self.push(out, Event::Move { id, from, to });
        } else {
            let did = cell - 1;
            let d = did as usize;
            let outcome = fight(eff(rank), eff(self.pieces[d].rank), self.version);
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
                return;
            }
        }
        let alive_flag = ct::nonzero_u8(self.pieces[i].rank);
        // Public: a Truck's last tank shows it to the other side (a dead piece's `known` is never read).
        if (spent & alive_flag) != 0 {
            self.pieces[i].known = true;
            self.push(out, Event::Spotted { id });
        }
        let alive = alive_flag != 0;
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
        if self.steps_left > 0 && self.any_move(army, self.moved, self.two_step_active) {
            return;
        }
        self.end_turn(out, false);
    }

    /// Nobody moved in time (the turn passes; three in a row lose the Match), or the time cap has passed
    /// (the Match ends on the tiebreak whatever the turn clock says). Anyone may call it.
    pub fn timeout(&mut self, at: i64, out: &mut Events) -> Result<(), Refusal> {
        let class = self.timeout_class(at)?;
        self.resolve_timeout(class, at, out);
        Ok(())
    }

    /// What a timeout claimed at `at` would be, from public state: the cap if it has passed, else the turn's
    /// deadline. Refused while the Match is over or the turn still has time.
    pub fn timeout_class(&self, at: i64) -> Result<TimeoutClass, Refusal> {
        if self.winner.is_some() {
            return Err(Refusal::MatchOver);
        }
        if self.cap_passed(at) {
            return Ok(TimeoutClass::Cap);
        }
        if at <= self.deadline {
            return Err(Refusal::TurnNotExpired);
        }
        Ok(TimeoutClass::Pass)
    }

    /// Apply a timeout claim whose class was decided when it was declared. The next deadline counts from `resolved`.
    pub fn resolve_timeout(&mut self, class: TimeoutClass, resolved: i64, out: &mut Events) {
        out.len = 0;
        match class {
            TimeoutClass::Cap => {
                let w = self.cap_winner();
                self.end(out, w, EndReason::Cap);
            }
            TimeoutClass::Pass => self.lose_turn(resolved, out),
        }
    }

    /// The side to move loses its turn: a timeout, or a declared move the hidden rules refuse. Three in a row lose
    /// the Match. The turn event is the same either way.
    fn lose_turn(&mut self, at: i64, out: &mut Events) {
        let army = self.turn;
        self.timeouts[army.idx()] += 1;
        if self.timeouts[army.idx()] >= TIMEOUTS_TO_LOSE {
            self.end(out, Winner::Army(army.enemy()), EndReason::Timeouts);
            return;
        }
        self.deadline = self.turn_end(at);
        self.end_turn(out, true);
    }

    /// The turn passes. Order: pass, storm, `Turn` event, move cap, no legal action.
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
        if self.moves >= self.move_cap {
            let w = self.cap_winner();
            self.end(out, w, EndReason::Cap);
            return;
        }
        if !self.has_action(self.turn) {
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
            let s = setup(&seed_of(n), STORM_FROM, STORM_TO);
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
            let s = setup(&seed_of(n + 10_000), STORM_FROM, STORM_TO);
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
            let g = Game::from_setup(
                &setup(&seed_of(n + 99), STORM_FROM, STORM_TO),
                0,
                CHAIN_CLOCK,
            )
            .unwrap();
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

    /// The plain rank a code plays as, with branches (the reference for `eff`).
    fn plays_ref(code: u8) -> u8 {
        match code {
            DUG_IN => BOMB,
            SWITCHED => SPY,
            c => c,
        }
    }

    /// The rule for which pieces may move, written plainly with branches.
    fn can_move_ref(g: &Game, id: usize, p: &Piece, moved: u64) -> bool {
        let rank = plays_ref(p.rank);
        if rank == BOMB {
            return false;
        }
        if rank == TRUCK {
            return p.fuel < TRUCK_FUEL
                && g.truck_turn[p.army.idx()] != g.turn_no as i32 - 2
                && (moved >> id) & 1 == 0;
        }
        true
    }

    /// Every legal `(piece, square)` of `army`, written plainly with branches, as the TypeScript `targets` does it
    /// (`app/src/games/vanguard/rules.ts`): the reference the constant-work scans must agree with.
    fn scan_full(g: &Game, army: Army, moved: u64, tsa: bool) -> Vec<(u8, u8)> {
        let mut out = vec![];
        let at = |r: i32, c: i32| -> Option<u8> {
            if (0..10).contains(&r) && (0..10).contains(&c) {
                Some((r * 10 + c) as u8)
            } else {
                None
            }
        };
        for id in 0..PIECE_SLOTS {
            let p = &g.pieces[id];
            if p.rank == 0 || p.army != army || !can_move_ref(g, id, p, moved) {
                continue;
            }
            let rank = plays_ref(p.rank);
            let v6 = g.version >= 6;
            let open = !tsa;
            let (pr, pc) = (row(p.sq) as i32, col(p.sq) as i32);
            let occupant = |sq: u8| -> Option<&Piece> {
                let cell = g.cells[sq as usize];
                (cell != 0).then(|| &g.pieces[cell as usize - 1])
            };
            let mut land = |sq: u8| {
                let own = occupant(sq).is_some_and(|o| o.army == army);
                if !own && !shuttling(p, sq) {
                    out.push((id as u8, sq));
                }
            };
            let mut line = |dirs: &[(i8, i8)], reach: i32| {
                for &(dr, dc) in dirs {
                    for k in 1..=reach {
                        let Some(sq) = at(pr + dr as i32 * k, pc + dc as i32 * k) else {
                            break;
                        };
                        if is_wadi(sq) {
                            break;
                        }
                        let occ = occupant(sq).is_some();
                        land(sq);
                        if occ {
                            break;
                        }
                    }
                }
            };
            let run = if rank == RECON && open { RUN as i32 } else { 1 };
            if !v6 {
                line(&DIRS, run);
                continue;
            }
            if rank == SERGEANT {
                line(&DIAGS, if open { RUN as i32 } else { 1 });
            } else if rank == CAPTAIN {
                line(&DIRS, 1);
                line(&DIAGS, 1);
            } else {
                line(&DIRS, run);
            }
            if rank == LIEUTENANT && open {
                for (dr, dc) in DIRS {
                    let (dr, dc) = (dr as i32, dc as i32);
                    if let (Some(mid), Some(sq)) =
                        (at(pr + dr, pc + dc), at(pr + dr * 2, pc + dc * 2))
                    {
                        if occupant(mid).is_some() && !is_wadi(sq) {
                            land(sq);
                        }
                    }
                }
            }
            if rank == GENERAL && open {
                for (dr, dc) in DIRS {
                    let (dr, dc) = (dr as i32, dc as i32);
                    if let (Some(w1), Some(w2), Some(sq)) = (
                        at(pr + dr, pc + dc),
                        at(pr + dr * 2, pc + dc * 2),
                        at(pr + dr * 3, pc + dc * 3),
                    ) {
                        if is_wadi(w1) && is_wadi(w2) && !is_wadi(sq) {
                            land(sq);
                        }
                    }
                }
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// A small deterministic generator for the property tests.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0 >> 33
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    /// Compare the cheap checks with the old full scan on one position, for both armies and Two-Step states.
    fn assert_same_answers(g: &Game, rng: &mut Lcg, what: &str) {
        for army in [Army::Us, Army::It] {
            for (moved, tsa) in [(0u64, false), (rng.next() & rng.next(), true), (0, true)] {
                let legal = scan_full(g, army, moved, tsa);
                assert_eq!(
                    g.any_move(army, moved, tsa),
                    !legal.is_empty(),
                    "{what}: any_move {army:?} moved {moved:b} tsa {tsa}"
                );
                let mine: Vec<u8> = (0..PIECE_SLOTS as u8)
                    .filter(|&i| {
                        g.pieces[i as usize].rank != 0 && g.pieces[i as usize].army == army
                    })
                    .collect();
                // Every square for a few of the army's pieces, and some random pairs.
                for _ in 0..3 {
                    if mine.is_empty() {
                        break;
                    }
                    let id = mine[rng.below(mine.len() as u64) as usize];
                    for to in 0..SQUARES as u8 {
                        assert_eq!(
                            g.probe(army, moved, tsa, id, to),
                            legal.contains(&(id, to)),
                            "{what}: probe own {id}->{to} {army:?}"
                        );
                    }
                }
                for _ in 0..30 {
                    let (id, to) = (
                        rng.below(PIECE_SLOTS as u64) as u8,
                        rng.below(SQUARES as u64) as u8,
                    );
                    assert_eq!(
                        g.probe(army, moved, tsa, id, to),
                        legal.contains(&(id, to)),
                        "{what}: probe {id}->{to} {army:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_cheap_checks_answer_exactly_like_the_old_full_scan() {
        let mut rng = Lcg(42);
        let mut stuck_seen = 0;
        let mut recon_runs = 0;
        let mut shuttles = 0;
        for n in 0..24u64 {
            let setup = setup(&seed_of(n + 500), STORM_FROM, STORM_TO);
            let mut g = Game::from_setup(&setup, 0, CHAIN_CLOCK).unwrap();
            assert_same_answers(&g, &mut rng, "opening");
            // Play random legal moves; every few plies thin the board and set up a shuttle, so stuck positions,
            // Recon runs and the shuttle ban all show up.
            let mut at = 0i64;
            for ply in 0..110u64 {
                if g.winner.is_some() {
                    break;
                }
                if ply % 6 == 3 {
                    let id = rng.below(PIECE_SLOTS as u64) as usize;
                    if g.pieces[id].rank != 0 && rng.below(3) != 0 {
                        g.remove(id);
                    }
                }
                if ply == 30 && n % 3 == 0 {
                    // Leave the side to move with Landmines only: stuck.
                    for id in 0..PIECE_SLOTS {
                        if g.pieces[id].rank != 0
                            && g.pieces[id].army == g.turn
                            && g.pieces[id].rank != BOMB
                        {
                            g.remove(id);
                        }
                    }
                }
                if ply % 5 == 1 {
                    let id = rng.below(PIECE_SLOTS as u64) as usize;
                    let sq = g.pieces[id].sq;
                    let back = if col(sq) > 0 { sq - 1 } else { sq + 1 };
                    if g.pieces[id].rank != 0 && !is_wadi(back) && g.cells[back as usize] == 0 {
                        g.pieces[id].trail = [back, sq, back, sq, 0, 0];
                        g.pieces[id].trail_len = 4;
                        shuttles += 1;
                    }
                }
                assert_same_answers(&g, &mut rng, &format!("seed {n} ply {ply}"));
                let legal = scan_full(&g, g.turn, g.moved, g.two_step_active);
                if legal.is_empty() {
                    stuck_seen += 1;
                    break;
                }
                recon_runs += legal
                    .iter()
                    .filter(|(id, to)| {
                        g.pieces[*id as usize].rank == RECON
                            && manhattan(g.pieces[*id as usize].sq, *to) > 1
                    })
                    .count();
                let (id, to) = legal[rng.below(legal.len() as u64) as usize];
                at += 1;
                g.deadline = at + 100;
                let mut out = Events::new();
                if g.move_piece(id, to, at, false, &mut out).is_err() {
                    break;
                }
            }
        }
        assert!(stuck_seen > 0, "no stuck position was ever compared");
        assert!(recon_runs > 0, "no Recon run was ever compared");
        assert!(shuttles > 0);
    }

    /// The shuttle ban hides exactly one square, so a Recon that can only run in the banned direction has its move on
    /// the second square. Every square, every banned direction, the other three directions walled in by Landmines.
    #[test]
    fn a_recon_whose_first_square_is_banned_still_has_a_move_on_the_second() {
        let put = |g: &mut Game, id: usize, rank: u8, sq: u8| {
            g.pieces[id] = Piece {
                rank,
                army: Army::Us,
                sq,
                known: false,
                fuel: 0,
                trail: [sq, 0, 0, 0, 0, 0],
                trail_len: 1,
            };
            g.cells[sq as usize] = id as u8 + 1;
        };
        let mut checked = 0;
        for sq in (0..SQUARES as u8).filter(|&q| !is_wadi(q)) {
            for (dr, dc) in DIRS {
                let (r, c) = (row(sq) as i8 + dr, col(sq) as i8 + dc);
                if !(0..10).contains(&r) || !(0..10).contains(&c) {
                    continue;
                }
                let back = (r * 10 + c) as u8;
                if is_wadi(back) {
                    continue;
                }
                let mut g = Game::start(&[], Army::Us, 99, 0, 0, CHAIN_CLOCK).unwrap();
                put(&mut g, 30, RECON, sq);
                let mut next = 31;
                for (er, ec) in DIRS {
                    let (r2, c2) = (row(sq) as i8 + er, col(sq) as i8 + ec);
                    if (0..10).contains(&r2) && (0..10).contains(&c2) {
                        let q = (r2 * 10 + c2) as u8;
                        if q != back {
                            put(&mut g, next, BOMB, q);
                            next += 1;
                        }
                    }
                }
                g.pieces[30].trail = [back, sq, back, sq, 0, 0];
                g.pieces[30].trail_len = 4;
                let expect = !scan_full(&g, Army::Us, 0, false).is_empty();
                assert_eq!(
                    g.any_move(Army::Us, 0, false),
                    expect,
                    "recon at {sq}, banned {back}"
                );
                checked += expect as u32;
            }
        }
        assert!(checked > 100, "{checked}");
    }

    /// What a declare checks reads no rank: scramble every rank (keeping the board) and every answer is the same.
    #[test]
    fn the_declare_checks_do_not_depend_on_any_rank() {
        let mut rng = Lcg(7);
        for n in 0..12u64 {
            let g = Game::from_setup(
                &setup(&seed_of(n + 900), STORM_FROM, STORM_TO),
                0,
                CHAIN_CLOCK,
            )
            .unwrap();
            let mut blind = g.clone();
            for p in blind.pieces.iter_mut().filter(|p| p.rank != 0) {
                p.rank = 1;
            }
            for _ in 0..400 {
                let (id, to) = (
                    rng.below(PIECE_SLOTS as u64) as u8,
                    rng.below(SQUARES as u64 + 5) as u8,
                );
                for at in [0, 5, 6, 16, 17, CAP_SECS + 1] {
                    assert_eq!(
                        g.check_declared_move(id, to, at),
                        blind.check_declared_move(id, to, at),
                        "{id}->{to} at {at}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_declared_move_the_rank_rules_refuse_costs_the_turn() {
        // A Landmine and a far move by a General: both pass the public checks, neither is legal.
        let layout = [
            LayoutPiece {
                army: Army::Us,
                rank: BOMB,
                sq: 95,
            },
            LayoutPiece {
                army: Army::Us,
                rank: GENERAL_OF_THE_ARMY,
                sq: 96,
            },
            LayoutPiece {
                army: Army::It,
                rank: RECON,
                sq: 5,
            },
        ];
        for (id, to) in [(95u8 - 40, 85u8), (96 - 40, 66)] {
            let mut g = Game::start(&layout, Army::Us, 99, 0, 0, CHAIN_CLOCK).unwrap();
            assert_eq!(g.check_declared_move(id, to, 1), Ok(()));
            assert_eq!(g.check_move(id, to, 1), Err(Refusal::IllegalMove));
            let mut out = Events::new();
            g.resolve_move(id, to, false, 40, &mut out);
            assert_eq!(g.turn, Army::It);
            assert_eq!(g.timeouts, [1, 0]);
            assert_eq!(g.moves, 0, "a lost turn is not a move");
            assert_eq!(
                g.deadline,
                40 + TURN_SECS + GRACE_SECS,
                "the next deadline counts from the resolve"
            );
            assert!(matches!(
                out.as_slice()[0].event,
                Event::Turn {
                    turn: Army::It,
                    timed_out: true
                }
            ));
        }
    }

    #[test]
    fn the_setup_streams_are_separate_and_the_sides_random() {
        let seed = seed_of(5);
        let a = Draw::new(&seed, b"layout-us").next();
        assert_eq!(a, Draw::new(&seed, b"layout-us").next());
        assert_ne!(a, Draw::new(&seed, b"layout-it").next());
        assert_ne!(a, Draw::new(&seed, b"storm-line").next());
        assert_ne!(a, Draw::new(&seed_of(6), b"layout-us").next());
        let mut seats = 0u32;
        for n in 0..2000u64 {
            seats += setup(&seed_of(n + 70_000), STORM_FROM, STORM_TO).us_seat as u32;
        }
        assert!(
            (900..1100).contains(&seats),
            "seat 1 plays the US Army {seats} of 2000"
        );
    }

    #[test]
    fn the_cheap_checks_do_the_same_work_whatever_the_layout() {
        let full =
            Game::from_setup(&setup(&seed_of(1), STORM_FROM, STORM_TO), 0, CHAIN_CLOCK).unwrap();
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
            for id in [0usize, 17, 44, 59] {
                assert_eq!(
                    g.piece_scan::<{ RUN as usize }>(id, Army::Us, 0, false, 0)
                        .2,
                    PROBE_WORK
                );
            }
            let total: u32 = (30..60)
                .map(|id| {
                    g.piece_scan::<EXISTS_DEPTH>(id, Army::Us, 0, false, NO_PIECE)
                        .2
                })
                .sum();
            assert_eq!(total, ANY_MOVE_WORK);
        }
        assert!(!stuck.has_moves(Army::Us));
        assert!(stuck.has_moves(Army::It));
        assert!(!empty.has_moves(Army::Us));
        assert!(recon_free.has_moves(Army::Us));
    }

    // --- Rules version 6: shapes, powers, passes, private rank codes -------------------------------------

    /// Put a piece on the board: US pieces take numbers 30.., Italian ones 0.. in the order given.
    fn put(g: &mut Game, id: usize, army: Army, rank: u8, sq: u8) {
        g.pieces[id] = Piece {
            rank,
            army,
            sq,
            known: false,
            fuel: 0,
            trail: [sq, 0, 0, 0, 0, 0],
            trail_len: 1,
        };
        g.cells[sq as usize] = id as u8 + 1;
        g.changed |= (is_changed_code(rank) as u64) << id;
    }

    /// An empty board with the US to move and a far-off pair of Recons, so nobody is ever stuck.
    fn board() -> Game {
        let mut g = Game::start(&[], Army::Us, 999, 1, 0, CHAIN_CLOCK).unwrap();
        put(&mut g, 59, Army::Us, RECON, 99);
        put(&mut g, 0, Army::It, RECON, 0);
        g
    }

    fn kinds(out: &Events) -> Vec<&'static str> {
        out.as_slice()
            .iter()
            .map(|r| match r.event {
                Event::Move { .. } => "move",
                Event::Attack { .. } => "attack",
                Event::Spotted { .. } => "spotted",
                Event::Blast { .. } => "blast",
                Event::Rescue { .. } => "rescue",
                Event::DugIn { .. } => "dug_in",
                Event::Pass { .. } => "pass",
                Event::Switched { .. } => "switched",
                Event::Raid { .. } => "raid",
                Event::Storm { .. } => "storm",
                Event::Turn { .. } => "turn",
                Event::End { .. } => "end",
            })
            .collect()
    }

    #[test]
    fn the_private_codes_play_as_a_landmine_and_a_spy() {
        for code in 0..=255u8 {
            let want = match code {
                DUG_IN => BOMB,
                SWITCHED => SPY,
                c => c,
            };
            assert_eq!(eff(code), want, "code {code}");
            assert_eq!(
                is_changed_code(code),
                (code == DUG_IN || code == SWITCHED) as u8
            );
        }
        const _: () = assert!(DUG_IN > TRUCK && SWITCHED > TRUCK && MAX_CODE == SWITCHED);
        for r in 1..=TRUCK {
            assert_eq!(eff(r), r, "a printed rank plays as itself");
        }
    }

    /// A random board across every rank code, trail and Two-Step state, on both rule versions.
    fn random_board(rng: &mut Lcg) -> (Game, Army, u64, bool) {
        let turn = if rng.below(2) == 0 {
            Army::Us
        } else {
            Army::It
        };
        let mut g = Game::start(&[], turn, 999, 1, 0, CHAIN_CLOCK).unwrap();
        g.version = if rng.below(5) == 0 { 5 } else { 6 };
        g.turn_no = rng.below(30) as u16;
        g.truck_turn = [
            rng.below(40) as i32 - 9,
            g.turn_no as i32 - 2 + rng.below(2) as i32,
        ];
        let squares: Vec<u8> = (0..SQUARES as u8).filter(|&s| !is_wadi(s)).collect();
        let mut free = squares.clone();
        for i in (1..free.len()).rev() {
            let j = rng.below(i as u64 + 1) as usize;
            free.swap(i, j);
        }
        let n = 2 + rng.below(40) as usize;
        for (k, sq) in free.into_iter().take(n).enumerate() {
            let army = if rng.below(2) == 0 {
                Army::Us
            } else {
                Army::It
            };
            // keep to thirty slots per army
            let base = if army == Army::Us { 30 } else { 0 };
            let id = base + (k % 30);
            if g.pieces[id].rank != 0 {
                continue;
            }
            let rank =
                [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 4, 5, 6, 9, 13, 14][rng.below(18) as usize];
            put(&mut g, id, army, rank, sq);
            g.pieces[id].fuel = rng.below(4) as u8;
            g.pieces[id].known = rng.below(4) == 0;
            if rng.below(5) == 0 {
                let back = squares[rng.below(squares.len() as u64) as usize];
                g.pieces[id].trail = [back, sq, back, sq, 0, 0];
                g.pieces[id].trail_len = 4;
            }
        }
        let moved = if rng.below(3) == 0 {
            rng.next() & rng.next()
        } else {
            0
        };
        (g, turn, moved, rng.below(3) == 0)
    }

    #[test]
    fn every_shape_agrees_with_the_plain_reference_on_random_boards() {
        let mut rng = Lcg(2026);
        let (mut diagonal, mut jumps, mut crossings, mut runs) = (0, 0, 0, 0);
        for n in 0..1500 {
            let (g, army, moved, tsa) = random_board(&mut rng);
            let legal = scan_full(&g, army, moved, tsa);
            assert_eq!(
                g.any_move(army, moved, tsa),
                !legal.is_empty(),
                "board {n}: any_move"
            );
            for id in 0..PIECE_SLOTS as u8 {
                for to in 0..SQUARES as u8 {
                    let want = legal.contains(&(id, to));
                    assert_eq!(
                        g.probe(army, moved, tsa, id, to),
                        want,
                        "board {n}: {id}->{to}"
                    );
                    if want {
                        let p = &g.pieces[id as usize];
                        let (dr, dc) = (row(p.sq).abs_diff(row(to)), col(p.sq).abs_diff(col(to)));
                        let rank = plays_ref(p.rank);
                        diagonal += (dr == dc && dr == 1) as u32;
                        runs += (dr == dc && dr > 1) as u32;
                        jumps += (rank == LIEUTENANT && dr.max(dc) == 2) as u32;
                        crossings += (rank == GENERAL && dr.max(dc) == 3) as u32;
                        // the public declare check admits whatever some rank could do
                        let mut pub_g = g.clone();
                        pub_g.turn = army;
                        assert_eq!(
                            pub_g.check_declared_move(id, to, 0),
                            Ok(()),
                            "board {n}: declare {id}->{to}"
                        );
                    }
                }
            }
            // has_step and has_action as the reference defines them
            let step_ref = !scan_full(&g, army, g.moved, true).is_empty();
            assert_eq!(g.has_step(army), step_ref, "board {n}: has_step");
            let power = g.version >= 6
                && g.pieces[if army == Army::Us { 30 } else { 0 }..][..30]
                    .iter()
                    .any(|p| {
                        let r = p.rank;
                        r == ENGINEER
                            || r == MAJOR
                            || (r == COLONEL
                                && g.pieces[if army == Army::Us { 30 } else { 0 }..][..30]
                                    .iter()
                                    .any(|t| t.rank == TRUCK))
                    });
            assert_eq!(
                g.has_action(army),
                !scan_full(&g, army, 0, false).is_empty() || power,
                "board {n}: has_action"
            );
        }
        assert!(
            diagonal > 200 && runs > 200 && jumps > 50 && crossings > 10,
            "{diagonal} {runs} {jumps} {crossings}"
        );
    }

    #[test]
    fn a_switch_changes_no_legality() {
        let mut rng = Lcg(77);
        let mut seen = 0;
        for _ in 0..400 {
            let (mut g, army, moved, tsa) = random_board(&mut rng);
            g.turn = army;
            let before = scan_full(&g, army, moved, tsa);
            let mut out = Events::new();
            g.apply_switch(true, &mut out);
            seen += (g.changed != 0) as u32;
            assert_eq!(scan_full(&g, army, moved, tsa), before);
            for &(id, to) in before.iter().take(20) {
                assert!(g.probe(army, moved, tsa, id, to));
            }
        }
        assert!(seen > 20);
    }

    #[test]
    fn a_sergeant_runs_diagonally_and_a_captain_steps_one_of_eight() {
        let mut g = board();
        put(&mut g, 30, Army::Us, SERGEANT, 91);
        put(&mut g, 31, Army::Us, CAPTAIN, 94);
        put(&mut g, 1, Army::It, SPY, 22);
        assert!(
            !g.probe(Army::Us, 0, false, 30, 81),
            "a Sergeant never walks straight"
        );
        assert!(g.probe(Army::Us, 0, false, 30, 55), "a diagonal run");
        assert!(
            !g.probe(Army::Us, 0, true, 30, 55),
            "one square in a Two-Step Turn"
        );
        assert!(g.probe(Army::Us, 0, true, 30, 82));
        assert!(g.probe(Army::Us, 0, false, 31, 83) && g.probe(Army::Us, 0, false, 31, 85));
        assert!(g.probe(Army::Us, 0, false, 31, 84) && g.probe(Army::Us, 0, false, 31, 93));
        assert!(!g.probe(Army::Us, 0, false, 31, 72));
        // a version 5 Battle keeps four directions
        g.version = 5;
        assert!(g.probe(Army::Us, 0, false, 30, 81) && !g.probe(Army::Us, 0, false, 30, 82));
        assert!(!g.probe(Army::Us, 0, false, 31, 83));
    }

    #[test]
    fn a_lieutenant_jumps_and_a_general_crosses_a_wadi() {
        let mut g = board();
        put(&mut g, 30, Army::Us, LIEUTENANT, 75);
        put(&mut g, 31, Army::Us, BOMB, 65);
        put(&mut g, 1, Army::It, SPY, 74);
        put(&mut g, 2, Army::It, BOMB, 73);
        put(&mut g, 32, Army::Us, GENERAL, 32);
        assert!(
            g.probe(Army::Us, 0, false, 30, 55),
            "over its own Landmine onto an empty square"
        );
        assert!(
            g.probe(Army::Us, 0, false, 30, 73),
            "over an enemy onto a Landmine: an attack"
        );
        assert!(
            !g.probe(Army::Us, 0, true, 30, 55),
            "no jump in a Two-Step Turn"
        );
        assert!(!g.probe(Army::Us, 0, false, 30, 95), "over nobody");
        assert!(g.probe(Army::Us, 0, false, 32, 62), "across the wadi");
        assert!(!g.probe(Army::Us, 0, true, 32, 62));
        assert!(
            !g.probe(Army::Us, 0, false, 32, 52),
            "a wadi square is not a landing"
        );
        g.version = 5;
        assert!(!g.probe(Army::Us, 0, false, 30, 55) && !g.probe(Army::Us, 0, false, 32, 62));
    }

    #[test]
    fn a_blast_shows_its_neighbours_and_takes_the_turn() {
        let mut g = board();
        put(&mut g, 30, Army::Us, ENGINEER, 9);
        put(&mut g, 31, Army::Us, BOMB, 8);
        put(&mut g, 1, Army::It, TRUCK, 19);
        put(&mut g, 2, Army::It, DUG_IN, 18);
        let mut out = Events::new();
        assert_eq!(g.blast(1, 5, false, &mut out), Err(Refusal::NotYourTurn));
        assert_eq!(g.blast(31, 5, false, &mut out), Err(Refusal::IllegalMove));
        assert_eq!(g.blast(99, 5, false, &mut out), Err(Refusal::NoSuchPiece));
        g.blast(30, 5, false, &mut out).unwrap();
        assert_eq!(kinds(&out), ["blast", "turn"]);
        let Event::Blast { id, at, n, shown } = out.as_slice()[0].event else {
            panic!()
        };
        assert_eq!((id, at, n), (30, 9, 3));
        assert_eq!(
            &shown[..3],
            &[(31, BOMB), (2, BOMB), (1, TRUCK)],
            "row-major scan, a dug-in Major shows as a Landmine"
        );
        assert!(
            g.pieces[30].rank == 0 && g.pieces[31].known && g.pieces[2].known && g.pieces[1].known
        );
        assert_eq!((g.moves, g.turn, g.timeouts), (1, Army::It, [0, 0]));
        assert_eq!(g.fallen[30], ENGINEER);
    }

    #[test]
    fn a_rescue_sends_the_truck_to_the_colonel() {
        let mut g = board();
        put(&mut g, 30, Army::Us, COLONEL, 45);
        put(&mut g, 31, Army::Us, TRUCK, 97);
        g.pieces[31].fuel = 2;
        g.truck_turn[0] = 5;
        let mut out = Events::new();
        g.rescue(30, 5, false, &mut out).unwrap();
        assert_eq!(kinds(&out), ["rescue", "turn"]);
        assert_eq!(g.pieces[31].sq, 45);
        assert_eq!(
            (g.pieces[31].fuel, g.truck_turn[0], g.pieces[31].known),
            (2, 5, true)
        );
        assert_eq!((g.pieces[31].trail_len, g.pieces[31].trail[0]), (1, 45));
        assert_eq!((g.cells[97], g.cells[45], g.pieces[30].rank), (0, 32, 0));
        // without a Truck on the board a Colonel cannot rescue
        let mut g = board();
        put(&mut g, 30, Army::Us, COLONEL, 45);
        assert_eq!(g.rescue(30, 5, false, &mut out), Err(Refusal::IllegalMove));
        assert!(!g.has_power(Army::Us));
    }

    #[test]
    fn a_dig_in_is_a_pass_that_changes_a_major_and_a_bad_one_is_a_plain_pass() {
        for (dig, dug) in [
            (30u8, true),
            (31, false),
            (1, false),
            (59, false),
            (200, false),
            (NO_PIECE, false),
        ] {
            let mut g = board();
            put(&mut g, 30, Army::Us, MAJOR, 85);
            put(&mut g, 31, Army::Us, GENERAL, 86);
            put(&mut g, 1, Army::It, MAJOR, 5);
            let mut out = Events::new();
            g.pass(5, dig, false, &mut out).unwrap();
            assert_eq!(
                kinds(&out),
                ["pass", "turn"],
                "dig {dig}: a face-down Dig in is a plain pass in public"
            );
            assert_eq!(g.pieces[30].rank, if dug { DUG_IN } else { MAJOR });
            assert_eq!(g.changed >> 30 & 1, dug as u64);
            assert_eq!((g.timeouts, g.moves), ([1, 0], 0));
        }
        // a face-up Major is named, a dug-in one cannot dig in again
        let mut g = board();
        put(&mut g, 30, Army::Us, MAJOR, 85);
        g.pieces[30].known = true;
        let mut out = Events::new();
        g.pass(5, 30, false, &mut out).unwrap();
        assert_eq!(kinds(&out), ["dug_in", "pass", "turn"]);
        g.turn = Army::Us;
        g.pass(5, 30, false, &mut out).unwrap();
        assert_eq!(kinds(&out), ["pass", "turn"]);
    }

    #[test]
    fn three_missed_turns_of_any_mix_lose_and_a_move_resets() {
        let mut out = Events::new();
        let mut g = board();
        put(&mut g, 30, Army::Us, RECON, 85);
        g.pass(1, NO_PIECE, false, &mut out).unwrap();
        g.move_piece(0, 1, 2, false, &mut out).unwrap();
        g.pass(3, NO_PIECE, false, &mut out).unwrap();
        g.move_piece(0, 0, 4, false, &mut out).unwrap();
        assert_eq!(g.timeouts, [2, 0]);
        // the third, a timeout, loses: passes and timeouts mix
        let late = g.deadline + 1;
        g.timeout(late, &mut out).unwrap();
        assert_eq!(kinds(&out), ["end"]);
        assert_eq!(
            (g.winner, g.reason),
            (Some(Winner::Army(Army::It)), Some(EndReason::Timeouts))
        );
        // a third pass loses too, and the Match is over afterwards
        let mut g = board();
        put(&mut g, 30, Army::Us, RECON, 85);
        g.pass(1, NO_PIECE, false, &mut out).unwrap();
        g.move_piece(0, 1, 2, false, &mut out).unwrap();
        g.pass(3, NO_PIECE, false, &mut out).unwrap();
        g.move_piece(0, 0, 4, false, &mut out).unwrap();
        g.pass(5, NO_PIECE, false, &mut out).unwrap();
        assert_eq!(kinds(&out), ["pass", "end"]);
        assert_eq!(
            g.pass(6, NO_PIECE, false, &mut out),
            Err(Refusal::MatchOver)
        );
        // a move in between resets the count
        let mut g = board();
        put(&mut g, 30, Army::Us, RECON, 85);
        g.pass(1, NO_PIECE, false, &mut out).unwrap();
        g.move_piece(0, 1, 2, false, &mut out).unwrap();
        g.move_piece(30, 75, 3, false, &mut out).unwrap();
        assert_eq!(g.timeouts, [0, 0]);
        // not inside a Two-Step Turn, not on version 5, not after a step
        let mut g = board();
        g.two_step_active = true;
        assert_eq!(
            g.pass(1, NO_PIECE, false, &mut out),
            Err(Refusal::IllegalMove)
        );
        let mut g = board();
        g.version = 5;
        assert_eq!(
            g.pass(1, NO_PIECE, false, &mut out),
            Err(Refusal::IllegalMove)
        );
        assert_eq!(g.blast(59, 1, false, &mut out), Err(Refusal::IllegalMove));
    }

    #[test]
    fn a_switch_rides_on_a_legal_action_only_and_a_known_ten_announces_it() {
        let base = || {
            let mut g = board();
            put(&mut g, 30, Army::Us, GENERAL_OF_THE_ARMY, 85);
            put(&mut g, 1, Army::It, GENERAL_OF_THE_ARMY, 75);
            g
        };
        let mut out = Events::new();
        // a refused move leaves everything alone
        let mut g = base();
        assert_eq!(
            g.move_piece(30, 10, 1, true, &mut out),
            Err(Refusal::IllegalMove)
        );
        assert_eq!((g.pieces[30].rank, g.changed), (GENERAL_OF_THE_ARMY, 0));
        // a declared one the rank rules refuse costs the turn and switches nothing
        g.resolve_move(30, 10, true, 5, &mut out);
        assert_eq!(
            (g.pieces[30].rank, g.timeouts),
            (GENERAL_OF_THE_ARMY, [1, 0])
        );
        // a legal attack with the switch: the switched 10 plays as a Spy and beats the 10 it attacks
        let mut g = base();
        g.move_piece(30, 75, 1, true, &mut out).unwrap();
        assert_eq!(kinds(&out), ["attack", "turn"]);
        assert_eq!(
            (g.pieces[30].rank, g.pieces[1].rank, g.fallen[1]),
            (SWITCHED, 0, GENERAL_OF_THE_ARMY)
        );
        assert_eq!(g.changed, 1 << 30);
        // the same switch on a face-up 10 is announced, before the move
        let mut g = base();
        g.pieces[30].known = true;
        g.move_piece(30, 84, 1, true, &mut out).unwrap();
        assert_eq!(kinds(&out), ["switched", "move", "turn"]);
        // a switch with no 10 left does nothing
        let mut g = base();
        g.remove(30);
        g.turn = Army::Us;
        g.move_piece(59, 89, 1, true, &mut out).unwrap();
        assert_eq!(g.changed, 0);
        // the 10 attacks a switched 10: it wins and the loser is shown as a Spy
        let mut g = base();
        g.apply_switch(true, &mut out);
        g.turn = Army::It;
        g.move_piece(1, 85, 1, false, &mut out).unwrap();
        assert_eq!((g.pieces[30].rank, g.fallen[30]), (0, SPY));
        // two switched 10s tie
        let mut g = base();
        g.apply_switch(true, &mut out);
        g.turn = Army::It;
        g.apply_switch(true, &mut out);
        g.move_piece(1, 85, 1, false, &mut out).unwrap();
        assert_eq!((g.pieces[30].rank, g.pieces[1].rank), (0, 0));
    }

    #[test]
    fn the_end_counts_ranks_as_they_are_now() {
        let mut g = board();
        g.pieces[59].rank = 0;
        g.cells[99] = 0;
        g.pieces[0].rank = 0;
        g.cells[0] = 0;
        put(&mut g, 30, Army::Us, MAJOR, 85); // 7, but dug in it counts 0
        put(&mut g, 1, Army::It, SERGEANT, 5); // 4
        assert_eq!(g.cap_winner(), Winner::Army(Army::Us));
        g.pieces[30].rank = DUG_IN;
        assert_eq!(g.cap_winner(), Winner::Army(Army::It));
        g.pieces[30].rank = GENERAL_OF_THE_ARMY;
        assert_eq!(g.cap_winner(), Winner::Army(Army::Us));
        g.pieces[30].rank = SWITCHED; // 1 against 4
        assert_eq!(g.cap_winner(), Winner::Army(Army::It));
    }

    #[test]
    fn a_side_with_only_a_boxed_major_is_not_stuck_until_it_has_dug_in() {
        let mut g = Game::start(&[], Army::Us, 999, 1, 0, CHAIN_CLOCK).unwrap();
        put(&mut g, 59, Army::Us, RECON, 99);
        put(&mut g, 0, Army::It, MAJOR, 0);
        put(&mut g, 1, Army::It, BOMB, 1);
        put(&mut g, 2, Army::It, BOMB, 10);
        assert!(!g.has_moves(Army::It));
        assert!(g.has_power(Army::It) && g.has_action(Army::It));
        g.pieces[0].rank = DUG_IN;
        assert!(!g.has_power(Army::It) && !g.has_action(Army::It));
        assert!(g.has_action(Army::Us));
        // on version 5 the powers do not exist
        g.pieces[0].rank = MAJOR;
        g.version = 5;
        assert!(!g.has_action(Army::It));
    }

    /// The old `fight`, with branches, as the reference for the branch-free one.
    fn fight_reference(a: u8, d: u8, version: u8) -> Outcome {
        let value = |r: u8| if r >= BOMB { 0 } else { r };
        if d == TRUCK {
            Outcome::Truck
        } else if d == BOMB {
            if a == ENGINEER && version < 6 {
                Outcome::Defuse
            } else {
                Outcome::Mine
            }
        } else if a == d {
            Outcome::Tie
        } else if (a == SPY && d == GENERAL_OF_THE_ARMY) || value(a) > value(d) {
            Outcome::Win
        } else {
            Outcome::Lose
        }
    }

    #[test]
    fn the_branch_free_fight_gives_the_old_outcomes() {
        for a in 1..=TRUCK {
            for d in 1..=TRUCK {
                for version in [5, 6] {
                    assert_eq!(
                        fight(a, d, version),
                        fight_reference(a, d, version),
                        "{a} attacks {d} on version {version}"
                    );
                }
            }
        }
    }

    #[test]
    fn events_fit_a_fixed_record_and_an_account_ring() {
        // 16 records must stay a small slice of an account
        assert!(
            core::mem::size_of::<Record>() * 16 < 2048,
            "{}",
            core::mem::size_of::<Record>()
        );
        assert!(core::mem::size_of::<Game>() < 1280);
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
                army: Army::Us,
                rank: 5,
                sq: 85,
            },
        ];
        assert_eq!(
            Game::start(&two, Army::Us, 1, 1, 0, CHAIN_CLOCK).err(),
            Some(SetupError::SquareTaken)
        );
        // A piece must stand in its own army's zone: the numbers say which army a slot belongs to.
        assert_eq!(
            Game::start(&one(5, 5), Army::Us, 1, 1, 0, CHAIN_CLOCK).err(),
            Some(SetupError::BadSquare)
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

    // --- The sealing recipe -------------------------------------------------------------------------------

    /// Known answers for the pad, computed independently with `hashlib` from the recipe in the docs:
    /// `SHA-256("vanguard-seal-v1" || key || battle || seat || seq u32 LE || field)[0]`. The TypeScript client checks
    /// the same vectors.
    #[test]
    fn the_pad_follows_the_published_recipe() {
        let key: [u8; 32] = core::array::from_fn(|i| i as u8);
        let battle: [u8; 32] = core::array::from_fn(|i| 0xB0 + (i % 16) as u8);
        for (seat, seq, field, want) in [
            (0u8, 0u32, SEAL_DIG, 78u8),
            (0, 0, SEAL_SWITCH, 96),
            (1, 5, SEAL_DIG, 161),
            (1, 5, SEAL_SWITCH, 137),
            (1, 0x0102_0304, SEAL_SWITCH, 190),
        ] {
            assert_eq!(seal_pad(&key, &battle, seat, seq, field), want);
        }
    }

    #[test]
    fn every_input_of_the_pad_matters() {
        let key = [3u8; 32];
        let battle = [9u8; 32];
        let pads = |f: &dyn Fn(u8) -> u8| (0..64).map(f).collect::<std::collections::HashSet<u8>>();
        // many values of each input give many different pad bytes (a 1-byte hash: expect plenty of spread)
        assert!(pads(&|n| seal_pad(&key, &battle, 0, n as u32, SEAL_SWITCH)).len() > 30);
        assert!(pads(&|n| seal_pad(&[n; 32], &battle, 0, 1, SEAL_SWITCH)).len() > 30);
        assert!(pads(&|n| seal_pad(&key, &[n; 32], 0, 1, SEAL_SWITCH)).len() > 30);
        assert_ne!(
            (0..64)
                .map(|n| seal_pad(&key, &battle, 0, n, SEAL_DIG))
                .collect::<Vec<_>>(),
            (0..64)
                .map(|n| seal_pad(&key, &battle, 0, n, SEAL_SWITCH))
                .collect::<Vec<_>>(),
            "the two fields of one seq have different pads"
        );
        assert_ne!(
            (0..64)
                .map(|n| seal_pad(&key, &battle, 0, n, SEAL_SWITCH))
                .collect::<Vec<_>>(),
            (0..64)
                .map(|n| seal_pad(&key, &battle, 1, n, SEAL_SWITCH))
                .collect::<Vec<_>>(),
            "and so do the two seats"
        );
    }

    #[test]
    fn the_army_keys_are_independent_of_each_other_and_of_every_other_stream() {
        let seed = seed_of(11);
        let keys = seal_keys(&seed);
        assert_ne!(keys[0], keys[1]);
        assert_eq!(keys, seal_keys(&seed));
        assert_ne!(keys, seal_keys(&seed_of(12)));
        for label in [
            &b"layout-us"[..],
            b"layout-it",
            b"storm-line",
            b"storm-turn",
            b"side",
            b"first",
        ] {
            let label: &'static [u8] = Box::leak(label.to_vec().into_boxed_slice());
            let mut d = Draw::new(&seed, label);
            let first = d.next().to_le_bytes();
            assert_ne!(&keys[0][..8], &first);
            assert_ne!(&keys[1][..8], &first);
        }
    }

    #[test]
    fn the_sealed_bytes_decode_to_defined_behaviour_for_all_256_values() {
        let mut g = board();
        put(&mut g, 55, Army::Us, GENERAL_OF_THE_ARMY, 95);
        put(&mut g, 45, Army::Us, MAJOR, 85);
        put(&mut g, 46, Army::Us, DUG_IN, 86);
        put(&mut g, 47, Army::Us, SWITCHED, 87);
        put(&mut g, 5, Army::It, GENERAL_OF_THE_ARMY, 5);
        for turn in [Army::Us, Army::It] {
            g.turn = turn;
            let base = if turn == Army::Us { 30 } else { 0 };
            let ten = (base + if turn == Army::Us { 25 } else { 5 }) as u8;
            for plain in 0..=255u8 {
                // a switch only for the live, unswitched 10 of the side to move
                let want = g.switch_wanted(plain);
                assert!(want <= 1);
                let named = plain >= 1 && (base + plain as usize - 1) as u8 == ten;
                assert_eq!(want == 1, named, "turn {turn:?} value {plain}");
                // a Dig in names one of the thirty slots of the side to move, or nothing
                let piece = g.dig_in_piece(plain);
                if (1..=30).contains(&plain) {
                    assert_eq!(piece as usize, base + plain as usize - 1);
                } else {
                    assert_eq!(piece, NO_PIECE, "value {plain}");
                }
            }
        }
    }
}

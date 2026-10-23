use crate::engine;
use anchor_lang::prelude::*;
pub use table_kit::{CommitGuard, Ring, Slot, RING_LEN};

pub const CONFIG_SEED: &[u8] = b"config";
pub const SPONSOR_SEED: &[u8] = b"sponsor";
pub const FUEL_SEED: &[u8] = b"fuel";
pub const TABLE_SEED: &[u8] = b"table";
pub const ASSIGN_SEED: &[u8] = b"assign";
pub const BOARD_SEED: &[u8] = b"board";
pub const VAULT_SEED: &[u8] = b"vault";
/// The address the VRF callback of one request must name (see `Table::vrf_nonce`).
pub const VRF_REQUEST_SEED: &[u8] = b"vrfreq";
/// The PDA registered in tesoro_core as this Game's settlement authority.
pub const AUTHORITY_SEED: &[u8] = b"authority";

// ---------------------------------------------------------------------------------------------
// Time. Phases on a table run in rollup slots, so a stalled clock never costs a Player a Match.
// ---------------------------------------------------------------------------------------------

/// Rollup slots per second, measured on devnet-tee (ticket 01: 99.99 slots/s, 10 ms per slot).
pub const SLOTS_PER_SEC: u64 = 100;

/// Both Players must check in within this long of the Match beginning on the table.
pub const CHECKIN_SECS: u64 = 60;
/// From the second check-in to the Seed arriving and `start`; a request is retried every
/// `SEED_RETRY_SECS` inside it, never extending it.
pub const SEED_SECS: u64 = 60;
pub const SEED_RETRY_SECS: u64 = 20;
/// Requests inside one `SEED_SECS` window (the first and its retries).
pub const MAX_SEED_REQUESTS: u8 = 3;
/// From `start` to the run: both Players see the countdown.
pub const GET_READY_SECS: u64 = 10;
/// The run.
pub const PLAY_SECS: u64 = 90;
/// From this long before the end both Players' scores are hidden, and a `play` writes only the
/// Player's own hidden seat.
pub const HIDE_LAST_SECS: u64 = 10;
/// A move counts if it reaches the table this long after the run ended (F1).
pub const GRACE_SECS: u64 = 3;
/// Closing, committing and finalizing leave room after the run.
pub const CLOSE_MARGIN_SECS: u64 = 60;
/// The longest a Match needs from `begin_match`, as the Game authority checks at assignment: every
/// phase plus the close margin (proposal: 7 minutes).
/// A close after this many slots past a window no longer judges the aggregate slot rate.
pub const CLOSE_GRACE_SLOTS: u64 = CLOSE_MARGIN_SECS * SLOTS_PER_SEC;
pub const ASSIGN_BUDGET_SECS: i64 = 7 * 60;

pub const CHECKIN_SLOTS: u64 = CHECKIN_SECS * SLOTS_PER_SEC;
pub const SEED_SLOTS: u64 = SEED_SECS * SLOTS_PER_SEC;
pub const SEED_RETRY_SLOTS: u64 = SEED_RETRY_SECS * SLOTS_PER_SEC;
pub const GET_READY_SLOTS: u64 = GET_READY_SECS * SLOTS_PER_SEC;
pub const PLAY_SLOTS: u64 = PLAY_SECS * SLOTS_PER_SEC;
pub const FREEZE_OFFSET_SLOTS: u64 = (PLAY_SECS - HIDE_LAST_SECS) * SLOTS_PER_SEC;
pub const END_OFFSET_SLOTS: u64 = (PLAY_SECS + GRACE_SECS) * SLOTS_PER_SEC;

/// Moves per `play` transaction.
pub const MAX_PLAY_BATCH: usize = 8;
/// Pacing: moves landed by slot `s` are at most `MOVES_PER_SEC` per elapsed second plus a burst.
pub const MOVES_PER_SEC: u64 = 4;
pub const MOVE_BURST: u64 = 6;
/// Outage rule: over a stretch of at least `STALL_SECS` of wall-clock time, the rollup ran fewer
/// than this many slots per thousand it should have (`SLOTS_PER_SEC` per second).
pub const OUTAGE_RATIO_PERMILLE: u64 = 500;
pub const STALL_SECS: i64 = 5;
/// Equal scores with both Players under this many moves are a no-show, not a draw (F3).
pub const TRIVIAL_MOVES: u16 = 5;
/// Version of `engine.rs` the move logs are written for.
pub const ENGINE_VERSION: u8 = 1;

/// Seconds from the assignment within which the Match must begin on its table.
pub const START_WINDOW_SECS: i64 = 300;
/// How long tesoro_core keeps refunds closed to everyone but this Game, counted from the
/// assignment: well past the start window and the whole Match, so a finished Match is settled
/// before anyone can refund it.
pub const TABLE_WINDOW_SECS: i64 = 24 * 60 * 60;
/// A finished table waits this long before it is reset, so clients can read the final board.
pub const RESET_DELAY_SECS: i64 = 30;
/// A receipt is trusted only this long after it was written.
pub const RELEASE_DELAY_SECS: i64 = 60;
/// A ring slot whose core Match account has vanished is freed after this long.
pub const STALE_SLOT_SECS: i64 = 15 * 24 * 60 * 60;
/// Hard ceiling on tables per generation, whatever `TableConfig.max_tables` says.
pub const MAX_TABLES_HARD: u16 = 256;
/// Lamports a new table gets for the rent of its ephemeral seats and permissions.
pub const TABLE_BUFFER_LAMPORTS: u64 = 30_000_000;

/// A table between Matches.
pub const TABLE_IDLE: u8 = 0;
/// A Match began; the seats are handed to its Players and they check in.
pub const TABLE_ASSIGNED: u8 = 1;
/// Both checked in; the Seed is being drawn.
pub const TABLE_SEEDING: u8 = 2;
/// `start` set the clock. The run begins at `start_slot` (the countdown before it is get-ready,
/// the 90 s after it is running; the program derives which from the slot).
pub const TABLE_GET_READY: u8 = 3;
/// The result is in the ring; the table waits to be committed, wiped and reset.
pub const TABLE_CLOSED: u8 = 4;

/// Why a Match ended the way it did (public, for the result screen).
pub const REASON_NONE: u8 = 0;
/// Both ran; the scores (or a zero-move side) decided.
pub const REASON_PLAYED: u8 = 1;
/// One Player never checked in: the other won.
pub const REASON_ABSENT: u8 = 2;
/// Neither checked in: refund.
pub const REASON_NEITHER: u8 = 3;
/// The Seed never arrived: refund.
pub const REASON_NO_SEED: u8 = 4;
/// The rollup stalled: refund.
pub const REASON_VOID: u8 = 5;
/// Both checked in and nobody moved: no-show.
pub const REASON_NO_SHOW: u8 = 6;
/// Equal scores with both under `TRIVIAL_MOVES`: no-show.
pub const REASON_TRIVIAL: u8 = 7;
/// Equal scores: a draw, refunded.
pub const REASON_DRAW: u8 = 8;

pub const NO_SEAT: u8 = 255;
const _: () = assert!(RING_LEN == 8);
const LOG_LEN: usize = engine::MAX_MOVES as usize;

/// What a Player's move looks like in an instruction.
#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize)]
pub struct MoveArg {
    pub piece: u16,
    pub x: u8,
    pub y: u8,
}

/// What a Player's instruction names. The program refuses any mismatch, which makes a
/// transaction held back from an earlier Match worthless in a later one on the same table.
#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq, Debug)]
pub struct Binding {
    pub tesoro_match: Pubkey,
    pub generation: u16,
    pub epoch: u64,
}

/// One packed move: the piece's place in its hand (2 bits), then `x` (3) and `y` (3).
pub fn pack_move(hand_base: u32, m: &MoveArg) -> u8 {
    let place = (u32::from(m.piece).wrapping_sub(hand_base) & 3) as u8;
    (place << 6) | ((m.x & 7) << 3) | (m.y & 7)
}

/// Whether the outage rule says the rollup stalled over `slots` of progress in `secs` of wall
/// clock: at least `STALL_SECS` of it and fewer than `OUTAGE_RATIO_PERMILLE` of the slots a
/// healthy rollup makes.
pub fn stalled(slots: u64, secs: i64) -> bool {
    if secs < STALL_SECS {
        return false;
    }
    let secs = secs as u64;
    u128::from(slots) * 1000
        < u128::from(OUTAGE_RATIO_PERMILLE) * u128::from(SLOTS_PER_SEC) * u128::from(secs)
}

/// Game-wide settings. The upgrade authority names the operator (the key that creates tables and
/// assigns Matches), the current table generation (which may only rise) and the table cap.
#[account]
#[derive(InitSpace, Debug)]
pub struct TableConfig {
    pub bump: u8,
    pub operator: Pubkey,
    pub generation: u16,
    pub max_tables: u16,
}

/// A program-owned lamport holder, delegated once, that pays the commits as the fee payer.
#[account]
#[derive(InitSpace, Debug)]
pub struct Sponsor {
    pub bump: u8,
}

/// A delegated lamport reserve the operator empties into the Sponsor inside the rollup.
#[account]
#[derive(InitSpace, Debug)]
pub struct Fuel {
    pub bump: u8,
    pub n: u8,
}

/// The write-once binding of one tesoro_core Match to one table and one epoch. Created on base by
/// the operator, read by the table in the rollup and by `finalize` on base.
#[account]
#[derive(InitSpace, Debug)]
pub struct Assignment {
    pub bump: u8,
    pub tesoro_match: Pubkey,
    pub generation: u16,
    pub index: u16,
    pub epoch: u64,
    /// Seat 0 opened the tesoro_core Match, seat 1 joined (the Players' authorities).
    pub players: [Pubkey; 2],
    /// Unix time by which the Match must have begun on the table.
    pub start_deadline: i64,
    /// Who paid this account's rent; it goes back there when the Assignment is closed.
    pub payer: Pubkey,
}

/// The moves of a finished Match, kept in the ring entry of its result until tesoro_core has
/// frozen the Match. Public once the Match is over. `moves` and `offsets` hold both seats,
/// seat 0 first: a seat's moves are `pack_move` bytes, its offsets are slot counts from
/// `start_slot` (two bytes little-endian each) for the transaction that carried the move.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, Debug, PartialEq, Eq)]
pub struct RunLog {
    pub engine_version: u8,
    /// The Seed both Players played, public once the Match is over.
    pub seed: u64,
    /// SHA-256 over the Seed, the Match, the epoch and the engine version.
    pub seed_hash: [u8; 32],
    pub start_slot: u64,
    /// Why the Match ended (`REASON_*`).
    pub reason: u8,
    pub scores: [u32; 2],
    pub counts: [u16; 2],
    pub moves: [u8; 2 * LOG_LEN],
    pub offsets: [u8; 4 * LOG_LEN],
}

impl RunLog {
    pub fn blank() -> Self {
        Self {
            engine_version: 0,
            seed: 0,
            seed_hash: [0; 32],
            start_slot: 0,
            reason: 0,
            scores: [0; 2],
            counts: [0; 2],
            moves: [0; 2 * LOG_LEN],
            offsets: [0; 4 * LOG_LEN],
        }
    }
}

/// A persistent table. Delegated once and never undelegated in normal running; only this public
/// account is ever committed to Solana. Its two `Board` seats and the `Vault` are rollup-only
/// accounts that live as long as the table does.
#[account]
#[derive(InitSpace, Debug)]
pub struct Table {
    pub bump: u8,
    pub generation: u16,
    pub index: u16,
    /// Rises at every reset; a Match is bound to one epoch.
    pub epoch: u64,
    pub phase: u8,
    /// The two Boards and the Vault exist (created once, kept for the table's life).
    pub seats_created: bool,
    /// The Boards belong to the current Match's Players.
    pub seats_open: bool,
    /// The result is in and not yet committed.
    pub dirty: bool,
    /// The Match on the table (default key while Idle).
    pub tesoro_match: Pubkey,
    /// Its ring slot.
    pub slot: u8,
    pub start_deadline: i64,
    /// Seat 0 opened the tesoro_core Match, seat 1 joined.
    pub players: [Pubkey; 2],
    pub checked_in: [bool; 2],
    /// Slot and clock when the Match began on the table.
    pub assigned_slot: u64,
    pub assigned_ts: i64,
    /// Slot when the second check-in started the Seed window.
    pub seeding_slot: u64,
    /// Counts VRF requests on this table, never reset. The callback of request `n` must name the
    /// address `["vrfreq", table, n]`, so an answer to any other request is refused.
    pub vrf_nonce: u64,
    pub req_nonce: u64,
    pub req_pending: bool,
    pub req_epoch: u64,
    pub req_slot: u64,
    pub req_count: u8,
    /// The Seed was stored in the Vault. Says nothing about its value.
    pub seed_ready: bool,
    /// Slot and clock when `start` set the clock.
    pub ready_slot: u64,
    pub ready_ts: i64,
    /// First slot of the run (`ready_slot` + the get-ready countdown); zero before `start`.
    pub start_slot: u64,
    /// Each seat's last seen score and move count: written by `play` until the freeze, then by
    /// nothing until `close`.
    pub shown_score: [u32; 2],
    pub shown_moves: [u16; 2],
    pub over_at: i64,
    pub reason: u8,
    /// Ring outcome code of the result (`OUTCOME_*`), `OUTCOME_NONE` before `close`.
    pub outcome: u8,
    pub final_scores: [u32; 2],
    pub final_moves: [u16; 2],
    /// Results of finished Matches, kept until tesoro_core has frozen them.
    pub ring: Ring,
    /// The run log of each ring slot, same index.
    #[max_len(8)]
    pub logs: Vec<RunLog>,
    /// When the table may be committed again if a commit was lost on its way to base.
    pub commit: CommitGuard,
}

impl Table {
    pub fn new(bump: u8, generation: u16, index: u16) -> Self {
        Self {
            bump,
            generation,
            index,
            epoch: 0,
            phase: TABLE_IDLE,
            seats_created: false,
            seats_open: false,
            dirty: false,
            tesoro_match: Pubkey::default(),
            slot: 0,
            start_deadline: 0,
            players: [Pubkey::default(); 2],
            checked_in: [false; 2],
            assigned_slot: 0,
            assigned_ts: 0,
            seeding_slot: 0,
            vrf_nonce: 0,
            req_nonce: 0,
            req_pending: false,
            req_epoch: 0,
            req_slot: 0,
            req_count: 0,
            seed_ready: false,
            ready_slot: 0,
            ready_ts: 0,
            start_slot: 0,
            shown_score: [0; 2],
            shown_moves: [0; 2],
            over_at: 0,
            reason: REASON_NONE,
            outcome: 0,
            final_scores: [0; 2],
            final_moves: [0; 2],
            ring: Ring::default(),
            logs: vec![RunLog::blank(); RING_LEN],
            commit: CommitGuard::default(),
        }
    }

    /// Forgets the finished Match and moves to the next epoch. The ring and its logs, the seats'
    /// existence and the request counter stay.
    pub fn reset(&mut self) -> Option<()> {
        let epoch = self.epoch.checked_add(1)?;
        let (ring, nonce, created, commit) =
            (self.ring, self.vrf_nonce, self.seats_created, self.commit);
        let logs = std::mem::take(&mut self.logs);
        *self = Self::new(self.bump, self.generation, self.index);
        self.epoch = epoch;
        self.ring = ring;
        self.logs = logs;
        self.vrf_nonce = nonce;
        self.seats_created = created;
        self.commit = commit;
        Some(())
    }

    /// The address a VRF callback must name for the request numbered `nonce`.
    pub fn request_marker(table: &Pubkey, nonce: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[VRF_REQUEST_SEED, table.as_ref(), &nonce.to_le_bytes()],
            &crate::ID,
        )
        .0
    }

    pub fn binding(&self) -> Binding {
        Binding {
            tesoro_match: self.tesoro_match,
            generation: self.generation,
            epoch: self.epoch,
        }
    }

    /// Last slot at which a check-in is accepted.
    pub fn checkin_end(&self) -> Option<u64> {
        self.assigned_slot.checked_add(CHECKIN_SLOTS)
    }

    /// Last slot at which `start` is accepted.
    pub fn seed_end(&self) -> Option<u64> {
        self.seeding_slot.checked_add(SEED_SLOTS)
    }

    /// From this slot `play` writes no public byte.
    pub fn freeze_slot(&self) -> Option<u64> {
        self.start_slot.checked_add(FREEZE_OFFSET_SLOTS)
    }

    /// Last slot at which a move counts.
    pub fn play_end(&self) -> Option<u64> {
        self.start_slot.checked_add(END_OFFSET_SLOTS)
    }
}

/// The Seed of a Match, drawn from the VRF output at the callback. It is computed inside the
/// rollup, kept in the Vault and copied to a Board at `begin`; the output itself is never stored.
pub fn derive_seed(
    tesoro_match: &Pubkey,
    generation: u16,
    index: u16,
    epoch: u64,
    request_nonce: u64,
    randomness: &[u8; 32],
) -> u64 {
    let digest = anchor_lang::solana_program::hash::hashv(&[
        b"tesoro/block-burst/seed",
        tesoro_match.as_ref(),
        &generation.to_le_bytes(),
        &index.to_le_bytes(),
        &epoch.to_le_bytes(),
        &request_nonce.to_le_bytes(),
        randomness,
    ])
    .to_bytes();
    let mut word = [0u8; 8];
    word.copy_from_slice(&digest[..8]);
    u64::from_le_bytes(word)
}

/// The VRF input the program chooses for a request: never anything a client sent.
pub fn request_input(
    tesoro_match: &Pubkey,
    generation: u16,
    index: u16,
    epoch: u64,
    request_nonce: u64,
) -> [u8; 32] {
    anchor_lang::solana_program::hash::hashv(&[
        b"tesoro/block-burst/vrf-request",
        tesoro_match.as_ref(),
        &generation.to_le_bytes(),
        &index.to_le_bytes(),
        &epoch.to_le_bytes(),
        &request_nonce.to_le_bytes(),
    ])
    .to_bytes()
}

/// What the ring log records about the Seed.
pub fn seed_hash(seed: u64, tesoro_match: &Pubkey, epoch: u64) -> [u8; 32] {
    anchor_lang::solana_program::hash::hashv(&[
        b"tesoro/block-burst/seed-hash",
        &seed.to_le_bytes(),
        tesoro_match.as_ref(),
        &epoch.to_le_bytes(),
        &[ENGINE_VERSION],
    ])
    .to_bytes()
}

/// The zero-member hidden account that holds the Seed from the callback until the table is
/// reset. Nobody can read it; `begin` copies the Seed to a Board once the run has started.
#[account]
#[derive(InitSpace, PartialEq, Eq, Debug)]
pub struct Vault {
    pub bump: u8,
    pub table: Pubkey,
    pub ready: bool,
    pub seed: u64,
}

impl Vault {
    pub fn blank(bump: u8, table: Pubkey) -> Self {
        Self {
            bump,
            table,
            ready: false,
            seed: 0,
        }
    }

    pub fn wipe(&mut self) {
        *self = Self::blank(self.bump, self.table);
    }

    pub fn is_blank(&self) -> bool {
        *self == Self::blank(self.bump, self.table)
    }
}

/// One Player's hidden seat: an ephemeral account (rollup-only, never committed) behind a private
/// permission, created once with the table and kept for its life. Between Matches the data is
/// zeroed and the permission's member swapped to nobody and then to the next Player.
///
/// It holds the Player's board, the Seed (from `begin`), the true score and move count, and the
/// move log with the landing slot of every move.
#[account]
#[derive(InitSpace, PartialEq, Eq, Debug)]
pub struct Board {
    pub bump: u8,
    pub table: Pubkey,
    pub seat: u8,
    /// The Player who may read this seat now; default while the seat is wiped.
    pub player: Pubkey,
    /// The Match and epoch the seat was handed over for.
    pub tesoro_match: Pubkey,
    pub epoch: u64,
    pub began: bool,
    pub seed: u64,
    pub occ: u64,
    pub gems: u64,
    pub score: u32,
    pub moves: u16,
    pub used: u8,
    pub over: bool,
    /// Slot and clock of `begin` or of the latest `play`, for the outage rule.
    pub last_slot: u64,
    pub last_ts: i64,
    /// The rollup stalled between two of this Player's transactions.
    pub stalled: bool,
    /// Packed moves (`pack_move`).
    pub log: [u8; LOG_LEN],
    /// Per move: slots from `start_slot` to the transaction that carried it, little-endian u16.
    pub offsets: [u8; 2 * LOG_LEN],
}

impl Board {
    /// A seat with no Player and no data.
    pub fn blank(bump: u8, table: Pubkey, seat: u8) -> Self {
        Self {
            bump,
            table,
            seat,
            player: Pubkey::default(),
            tesoro_match: Pubkey::default(),
            epoch: 0,
            began: false,
            seed: 0,
            occ: 0,
            gems: 0,
            score: 0,
            moves: 0,
            used: 0,
            over: false,
            last_slot: 0,
            last_ts: 0,
            stalled: false,
            log: [0; LOG_LEN],
            offsets: [0; 2 * LOG_LEN],
        }
    }

    /// Nothing the previous Match left is readable: the seat is back to a blank state.
    pub fn wipe(&mut self) {
        *self = Self::blank(self.bump, self.table, self.seat);
    }

    pub fn is_blank(&self) -> bool {
        *self == Self::blank(self.bump, self.table, self.seat)
    }

    pub fn engine_state(&self) -> engine::State {
        engine::State {
            seed: self.seed,
            occ: self.occ,
            gems: self.gems,
            score: self.score,
            moves: self.moves,
            used: self.used,
            over: self.over,
        }
    }

    pub fn store_engine_state(&mut self, s: &engine::State) {
        self.occ = s.occ;
        self.gems = s.gems;
        self.score = s.score;
        self.moves = s.moves;
        self.used = s.used;
        self.over = s.over;
    }

    pub fn set_offset(&mut self, index: usize, offset: u16) -> Option<()> {
        let at = index.checked_mul(2)?;
        self.offsets
            .get_mut(at..at.checked_add(2)?)?
            .copy_from_slice(&offset.to_le_bytes());
        Some(())
    }
}

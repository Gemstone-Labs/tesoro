use anchor_lang::prelude::*;
pub use table_kit::{Ring, Slot};

pub const CONFIG_SEED: &[u8] = b"config";
pub const SPONSOR_SEED: &[u8] = b"sponsor";
pub const FUEL_SEED: &[u8] = b"fuel";
pub const TABLE_SEED: &[u8] = b"table";
pub const ASSIGN_SEED: &[u8] = b"assign";
pub const BOOK_SEED: &[u8] = b"book";
/// The PDA registered in tesoro_core as this Game's settlement authority.
pub const AUTHORITY_SEED: &[u8] = b"authority";

pub const COLUMNS: usize = 12;
pub const COLUMN_SECS: i64 = 10;
/// Seconds between the Match starting and the line entering column 0.
pub const HEAD_START_SECS: i64 = 30;
/// A column locks this many seconds before its window starts.
pub const LOCK_AHEAD_SECS: i64 = 10;
pub const HIT_POINTS: u32 = 100;
/// A column without a pick (or a pick cleared again).
pub const NO_PICK: i16 = i16::MIN;
/// Bands are clamped to this range so that none ever equals `NO_PICK`.
pub const MAX_BAND: i16 = i16::MAX;
/// Seconds from the start to the end of the last column.
pub const MATCH_SECS: i64 = HEAD_START_SECS + COLUMNS as i64 * COLUMN_SECS;
/// Band height as parts per million of the anchor price, per asset (SOL, ETH, HYPE). Calibrated
/// in `app/src/games/trading-duel/grid.ts`, which carries the data behind these values.
pub const STEP_PPM: [u64; 3] = [120, 100, 130];

/// Seconds from the assignment within which both Players must have checked in.
pub const START_WINDOW_SECS: i64 = 300;
/// How long tesoro_core keeps refunds closed to everyone but this Game, counted from the
/// assignment. It must outlast the start window, the Match and any outage of the rollup, so that a
/// finished Match is settled before anyone can refund it.
pub const TABLE_WINDOW_SECS: i64 = 24 * 60 * 60;
/// A finished table waits this long before it is reset, so clients can read the final board.
pub const RESET_DELAY_SECS: i64 = 30;
/// A receipt is trusted only this long after it was written (the rollup copies base accounts a
/// moment after they change).
pub const RELEASE_DELAY_SECS: i64 = 60;
/// A ring slot whose core Match account has vanished is freed after this long.
pub const STALE_SLOT_SECS: i64 = 15 * 24 * 60 * 60;
/// Hard ceiling on tables per generation, whatever `Config.max_tables` says.
pub const MAX_TABLES_HARD: u16 = 256;
/// Lamports a new table gets for the rent of its ephemeral seats and permissions.
pub const TABLE_BUFFER_LAMPORTS: u64 = 20_000_000;

/// Oldest accepted oracle publish time, seconds before the rollup clock. The feed's timestamp has
/// one-second resolution.
pub const MAX_STALE_SECS: i64 = 2;
/// A feed timestamp may run at most this far ahead of the rollup clock.
pub const MAX_FUTURE_SECS: i64 = 10;

pub const ASSET_SOL: u8 = 0;
pub const ASSET_ETH: u8 = 1;
pub const ASSET_HYPE: u8 = 2;
/// The asset is bits 1 and 2 of the Match id (bit 0 marks a Challenge in the app).
pub const ASSET_SHIFT: u32 = 1;
pub const ASSET_MASK: u64 = 3;

/// A table between Matches.
pub const PHASE_IDLE: u8 = 0;
/// A Match began; the Players check in.
pub const PHASE_WAITING: u8 = 1;
pub const PHASE_LIVE: u8 = 2;
/// The result is in the ring; the table waits to be committed, closed and reset.
pub const PHASE_OVER: u8 = 3;

pub const NO_WINNER: u8 = 255;
pub const DRAW: u8 = 2;

/// What the price line did in each column: its lowest and highest recorded price (1e-8 USD).
/// `seen` is a bitmask of the columns that have data. See `engine::Track` methods for the rules.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub struct Track {
    pub lo: [u64; COLUMNS],
    pub hi: [u64; COLUMNS],
    pub seen: u16,
    /// The last price recorded, 0 before the first sample.
    pub last: u64,
    /// The column of that sample, -1 during the head start.
    pub last_col: i8,
}

impl Default for Track {
    fn default() -> Self {
        Self {
            lo: [0; COLUMNS],
            hi: [0; COLUMNS],
            seen: 0,
            last: 0,
            last_col: -1,
        }
    }
}

/// Game-wide settings. The upgrade authority names the operator (the key that creates tables and
/// assigns Matches), the current table generation and the table cap.
#[account]
#[derive(InitSpace, Debug)]
pub struct TableConfig {
    pub bump: u8,
    pub operator: Pubkey,
    /// A new generation starts if a provider ever has to change. Only this one is assigned.
    pub generation: u16,
    pub max_tables: u16,
}

/// A program-owned lamport holder, delegated once, that pays the commits as the fee payer.
#[account]
#[derive(InitSpace, Debug)]
pub struct Sponsor {
    pub bump: u8,
}

/// A delegated lamport reserve the operator empties into the Sponsor inside the rollup (a base
/// transfer to a delegated account is not seen there).
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
    pub asset: u8,
    /// Unix time by which both Players must have checked in.
    pub start_deadline: i64,
    /// Who paid this account's rent; it goes back there when the Assignment is closed.
    pub payer: Pubkey,
}

/// A persistent table. Delegated once and never undelegated in normal running; only this public
/// account is ever committed to Solana.
#[account]
#[derive(InitSpace, Debug)]
pub struct Table {
    pub bump: u8,
    pub generation: u16,
    pub index: u16,
    /// Rises at every reset; a Match is bound to one epoch.
    pub epoch: u64,
    pub phase: u8,
    pub seats_open: bool,
    /// The result is in and not yet committed.
    pub dirty: bool,
    /// The Match on the table (default key while Idle).
    pub tesoro_match: Pubkey,
    /// Its ring slot.
    pub slot: u8,
    pub players: [Pubkey; 2],
    pub asset: u8,
    pub start_deadline: i64,
    pub checked_in: [bool; 2],
    pub starts_at: i64,
    /// `starts_at + HEAD_START_SECS`: when the line enters column 0.
    pub grid_at: i64,
    pub ends_at: i64,
    pub over_at: i64,
    /// The price when the Match started, 1e-8 USD: band 0 begins here.
    pub anchor: u64,
    /// Band height, 1e-8 USD.
    pub step: u64,
    /// Informational: the time of the last sample.
    pub last_tick: i64,
    pub track: Track,
    /// Picks per seat, public once their column has locked; `NO_PICK` before and for no pick.
    pub revealed: [[i16; COLUMNS]; 2],
    /// Points from the columns scored so far.
    pub scores: [u32; 2],
    /// Winning seat, `DRAW`, or `NO_WINNER` until the Match is over.
    pub winner: u8,
    /// Results of finished Matches, kept until tesoro_core has frozen them.
    pub ring: Ring,
}

impl Table {
    pub fn new(bump: u8, generation: u16, index: u16) -> Self {
        Self {
            bump,
            generation,
            index,
            epoch: 0,
            phase: PHASE_IDLE,
            seats_open: false,
            dirty: false,
            tesoro_match: Pubkey::default(),
            slot: 0,
            players: [Pubkey::default(); 2],
            asset: 0,
            start_deadline: 0,
            checked_in: [false; 2],
            starts_at: 0,
            grid_at: 0,
            ends_at: 0,
            over_at: 0,
            anchor: 0,
            step: 0,
            last_tick: 0,
            track: Track::default(),
            revealed: [[NO_PICK; COLUMNS]; 2],
            scores: [0; 2],
            winner: NO_WINNER,
            ring: Ring::default(),
        }
    }

    /// Forgets the finished Match and moves to the next epoch. The ring stays.
    pub fn reset(&mut self) -> Option<()> {
        let epoch = self.epoch.checked_add(1)?;
        let ring = self.ring;
        *self = Self::new(self.bump, self.generation, self.index);
        self.epoch = epoch;
        self.ring = ring;
        Some(())
    }
}

/// One Player's picks, an ephemeral account readable only by that Player while the Match runs.
/// Created when the seats open, closed when the Match is over.
#[account]
#[derive(InitSpace, Debug)]
pub struct Book {
    pub bump: u8,
    pub table: Pubkey,
    pub player: Pubkey,
    pub seat: u8,
    /// A band (signed, 0 starts at the anchor) per column, or `NO_PICK`.
    pub picks: [i16; COLUMNS],
    /// Columns with a pick right now.
    pub pick_count: u8,
}

impl Book {
    pub fn new(bump: u8, table: Pubkey, player: Pubkey, seat: u8) -> Self {
        Self {
            bump,
            table,
            player,
            seat,
            picks: [NO_PICK; COLUMNS],
            pick_count: 0,
        }
    }
}

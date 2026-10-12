use anchor_lang::prelude::*;

pub const DUEL_SEED: &[u8] = b"duel";
pub const BOOK_SEED: &[u8] = b"book";
/// The PDA registered in tesoro_core as this Game's settlement authority.
pub const AUTHORITY_SEED: &[u8] = b"authority";

pub const COLUMNS: usize = 12;
pub const ROWS: u8 = 8;
pub const COLUMN_SECS: i64 = 10;
/// Seconds between the Match starting and the line entering column 0.
pub const HEAD_START_SECS: i64 = 30;
/// A column locks this many seconds before its window starts.
pub const LOCK_AHEAD_SECS: i64 = 10;
pub const HIT_POINTS: u32 = 100;
/// A column without a pick (or a pick cleared again).
pub const NO_PICK: u8 = 255;
/// Seconds from the start to the end of the last column.
pub const MATCH_SECS: i64 = HEAD_START_SECS + COLUMNS as i64 * COLUMN_SECS;
/// Row height as parts per million of the anchor price, per asset (SOL, ETH, HYPE). Calibrated
/// in `app/src/games/trading-duel/grid.ts`, which carries the data behind these values.
pub const STEP_PPM: [u64; 3] = [250, 200, 270];

/// Seconds after creation within which the Match must have been delegated and started.
pub const START_WINDOW_SECS: i64 = 300;
/// How long tesoro_core keeps refunds closed to everyone but this Game (see holdem).
pub const TABLE_WINDOW_SECS: i64 = 24 * 60 * 60;

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

pub const STATUS_CREATED: u8 = 0;
pub const STATUS_LIVE: u8 = 1;
pub const STATUS_OVER: u8 = 2;
pub const STATUS_CANCELLED: u8 = 3;

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

/// The public table. Readable by anyone during the Match; a Player's pick appears here only once
/// its column has locked.
#[account]
#[derive(InitSpace, Debug)]
pub struct Duel {
    pub bump: u8,
    pub authority_bump: u8,
    /// Same id as the tesoro_core Match this Game settles. Bits 1 and 2 are the asset.
    pub match_id: u64,
    pub tesoro_match: Pubkey,
    /// Seat 0 opened the tesoro_core Match, seat 1 joined.
    pub players: [Pubkey; 2],
    pub asset: u8,
    pub status: u8,
    pub finalized: bool,
    /// Winning seat, `DRAW`, or `NO_WINNER` until the Match is over.
    pub winner: u8,
    pub start_deadline: i64,
    pub starts_at: i64,
    /// `starts_at + HEAD_START_SECS`: when the line enters column 0.
    pub grid_at: i64,
    pub ends_at: i64,
    /// The price when the Match started, 1e-8 USD: row 4 begins here.
    pub anchor: u64,
    /// Row height, 1e-8 USD.
    pub step: u64,
    /// Informational: the time of the last sample. No instruction reads it; clients use it to
    /// notice that the Duel changed.
    pub last_tick: i64,
    pub track: Track,
    /// Picks per seat, public once their column has locked; `NO_PICK` before and for no pick.
    pub revealed: [[u8; COLUMNS]; 2],
    /// Points from the columns scored so far.
    pub scores: [u32; 2],
}

impl Default for Duel {
    fn default() -> Self {
        Self {
            bump: 0,
            authority_bump: 0,
            match_id: 0,
            tesoro_match: Pubkey::default(),
            players: [Pubkey::default(); 2],
            asset: 0,
            status: STATUS_CREATED,
            finalized: false,
            winner: NO_WINNER,
            start_deadline: 0,
            starts_at: 0,
            grid_at: 0,
            ends_at: 0,
            anchor: 0,
            step: 0,
            last_tick: 0,
            track: Track::default(),
            revealed: [[NO_PICK; COLUMNS]; 2],
            scores: [0; 2],
        }
    }
}

/// One Player's picks. Readable only by that Player while the Match runs, public once it is over.
#[account]
#[derive(InitSpace, Debug)]
pub struct Book {
    pub bump: u8,
    pub duel: Pubkey,
    pub player: Pubkey,
    pub seat: u8,
    /// A row (0 bottom to 7 top) per column, or `NO_PICK`.
    pub picks: [u8; COLUMNS],
    /// Columns with a pick right now.
    pub pick_count: u8,
}

impl Default for Book {
    fn default() -> Self {
        Self {
            bump: 0,
            duel: Pubkey::default(),
            player: Pubkey::default(),
            seat: 0,
            picks: [NO_PICK; COLUMNS],
            pick_count: 0,
        }
    }
}

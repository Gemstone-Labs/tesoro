use anchor_lang::prelude::*;

pub const DUEL_SEED: &[u8] = b"duel";
pub const BOOK_SEED: &[u8] = b"book";
/// The PDA registered in tesoro_core as this Game's settlement authority.
pub const AUTHORITY_SEED: &[u8] = b"authority";

/// Chips each Player starts with. Score units with no value outside the Match.
pub const START_CHIPS: u64 = 10_000;
/// Length of the trading window.
pub const DURATION_SECS: i64 = 300;
/// Pause between the Match starting in the rollup and trading opening.
pub const COUNTDOWN_SECS: i64 = 5;
/// Seconds after creation within which the Match must have been delegated and started.
pub const START_WINDOW_SECS: i64 = 300;
/// How long tesoro_core keeps refunds closed to everyone but this Game (see holdem).
pub const TABLE_WINDOW_SECS: i64 = 24 * 60 * 60;

pub const MIN_LEVERAGE: u8 = 1;
pub const MAX_LEVERAGE: u8 = 20;
/// Smallest margin a position may be opened with (1% of the starting stack).
pub const MIN_MARGIN: u64 = 100;
/// Maintenance margin as basis points of the notional. A position whose margin plus PnL is at or
/// below it is liquidated on the next price read.
pub const MAINTENANCE_BPS: u64 = 50;
/// Spread charged on every fill, in basis points of the oracle price, against the Player.
pub const SPREAD_BPS: u64 = 5;
/// Oldest accepted oracle publish time, seconds before the rollup clock. The feed's timestamp has
/// one-second resolution.
pub const MAX_STALE_SECS: i64 = 5;
/// A feed timestamp may run at most this far ahead of the rollup clock.
pub const MAX_FUTURE_SECS: i64 = 10;
/// A lead smaller than this many Chips reads as "level".
pub const LEVEL_BAND: u64 = 50;
/// Fills kept per Player; older ones are overwritten, the count is not.
pub const FILL_LOG: usize = 64;

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

pub const LEAD_LEVEL: u8 = 0;
pub const LEAD_SEAT_0: u8 = 1;
pub const LEAD_SEAT_1: u8 = 2;

pub const SIDE_FLAT: u8 = 0;
pub const SIDE_LONG: u8 = 1;
pub const SIDE_SHORT: u8 = 2;

pub const FILL_OPEN: u8 = 0;
pub const FILL_CLOSE: u8 = 1;
pub const FILL_LIQUIDATED: u8 = 2;
pub const FILL_FINAL: u8 = 3;

/// One executed order. `pnl` is realised by the fill (zero for an open).
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, Debug, PartialEq, Eq,
)]
pub struct Fill {
    /// Seconds since trading opened.
    pub t: u32,
    pub kind: u8,
    pub side: u8,
    /// Fill price in 1e-8 USD, spread included.
    pub price: u64,
    pub notional: u64,
    pub margin: u64,
    pub pnl: i64,
    /// Cash plus any open position's value right after the fill.
    pub equity: u64,
}

/// The public table. Readable by anyone during the Match; holds only a coarse lead.
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
    pub ends_at: i64,
    pub trades: [u32; 2],
    pub lead: u8,
    pub last_tick: i64,
    /// Oracle price the Match ended on, 1e-8 USD.
    pub final_price: u64,
    pub final_equity: [u64; 2],
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
            ends_at: 0,
            trades: [0; 2],
            lead: LEAD_LEVEL,
            last_tick: 0,
            final_price: 0,
            final_equity: [0; 2],
        }
    }
}

/// One Player's book. Readable only by that Player while the Match runs, public once it is over.
#[account]
#[derive(InitSpace, Debug)]
pub struct Book {
    pub bump: u8,
    pub duel: Pubkey,
    pub player: Pubkey,
    pub seat: u8,
    /// Chips not locked as margin.
    pub cash: u64,
    pub side: u8,
    pub margin: u64,
    pub notional: u64,
    pub leverage: u8,
    /// Fill price the open position was entered at.
    pub entry: u64,
    /// Orders opened, liquidations included in `fill_count` only.
    pub trades: u32,
    pub liquidations: u32,
    pub fill_count: u32,
    pub fills: [Fill; FILL_LOG],
}

impl Default for Book {
    fn default() -> Self {
        Self {
            bump: 0,
            duel: Pubkey::default(),
            player: Pubkey::default(),
            seat: 0,
            cash: START_CHIPS,
            side: SIDE_FLAT,
            margin: 0,
            notional: 0,
            leverage: 0,
            entry: 0,
            trades: 0,
            liquidations: 0,
            fill_count: 0,
            fills: [Fill::default(); FILL_LOG],
        }
    }
}

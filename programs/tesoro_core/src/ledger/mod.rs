//! Pure accounting core of `tesoro_core`: the money rules of CONTEXT.md and ADR 0001.
//!
//! Nothing in here touches accounts, CPIs, clocks or syscalls. Every function takes plain values
//! (identities are 32-byte keys, time is a unix timestamp) and mutates plain structs. The only
//! Anchor dependency is the Borsh derive so the same structs can be stored inside program accounts.
//! Every mutating function validates completely before it mutates, so an `Err` leaves its inputs
//! untouched.

pub mod backing;
pub mod matches;
pub mod money;

#[cfg(test)]
mod tests;

pub use backing::*;
pub use matches::*;
pub use money::*;

/// Identity of an Account, Position, Source, Game, ... (a Solana public key in the program).
pub type Key = [u8; 32];

/// Basis points denominator.
pub const BPS: u128 = 10_000;
pub const MIN_HORIZON_MONTHS: u8 = 1;
pub const MAX_HORIZON_MONTHS: u8 = 12;
/// The entry ladder, in Gemas.
pub const LADDER: [u64; 3] = [500, 1_000, 2_500];
/// Maximum distinct Sources one entry may be drawn from. Bounds account counts per instruction.
pub const MAX_ENTRY_SOURCES: usize = 2;
/// Maximum applicants on a public Offer.
pub const MAX_APPLICANTS: usize = 8;
/// Request and Offer lifetime, and the window an accepted Backing has to be used.
pub const BACKING_TTL_SECS: i64 = 24 * 60 * 60;
/// Time a Match has before anybody may refund it as abandoned / no-show.
pub const MATCH_TIMEOUT_SECS: i64 = 60 * 60;
/// Upper bound on Platform Fee + Studio Fee together, in basis points of the Pot.
pub const MAX_TOTAL_FEE_BPS: u16 = 5_000;

macro_rules! core_errors {
    ($($name:ident => $msg:literal),* $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        #[repr(u32)]
        pub enum CoreError { $($name),* }
        impl CoreError {
            pub fn code(self) -> u32 { self as u32 }
            pub fn name(self) -> &'static str { match self { $(Self::$name => stringify!($name)),* } }
            pub fn msg(self) -> &'static str { match self { $(Self::$name => $msg),* } }
        }
    };
}

core_errors! {
    Math => "arithmetic overflow or division by zero",
    InvalidHorizon => "horizon must be 1 to 12 months",
    InvalidPrice => "price must be non-zero",
    InvalidDecimals => "asset decimals out of range",
    PositionLocked => "position is locked",
    PositionNotLocked => "position is not locked",
    AdvanceAlreadyOpen => "position already has an open advance",
    NoOpenAdvance => "position has no open advance",
    SourceMismatch => "source does not belong to this position or advance",
    AdvanceTooSmall => "advance rounds to zero gemas",
    DebtOutstanding => "debt is not zero",
    CumulativeDecreased => "cumulative yield decreased",
    ZeroAmount => "amount must be non-zero",
    NotOwnSource => "only the position owner returns gemas of its own source",
    ExceedsDebt => "amount exceeds the debt of the source",
    ExceedsRedeemable => "amount exceeds what the source has accrued for this holder",
    InsufficientGemas => "not enough free gemas",
    HoldingMismatch => "holding does not match the expected source or account",
    TooManySources => "entry draws on too many sources",
    NonCanonicalDraw => "holdings must be own-sourced first, ascending by source, each drawn from",
    InvalidEntry => "entry must be 500, 1000 or 2500 gemas",
    InvalidBps => "basis points out of range",
    InvalidStatus => "operation not allowed in the current status",
    Expired => "expired",
    NotExpired => "not yet expired",
    NotParty => "signer is not a party to this operation",
    GameMismatch => "game does not match",
    EntryMismatch => "entry does not match",
    SelfMatch => "both sides of a match must be distinct",
    TooManyApplicants => "too many applicants",
    AlreadyApplied => "already applied",
    NotApplicant => "request has not applied to this offer",
    ReservationMismatch => "holdings do not match the offer reservation",
    FeeTooHigh => "fees exceed the cap",
}

pub type CoreResult<T> = Result<T, CoreError>;

pub(crate) fn mul_div_floor(a: u128, b: u128, d: u128) -> CoreResult<u128> {
    a.checked_mul(b)
        .and_then(|x| x.checked_div(d))
        .ok_or(CoreError::Math)
}

pub(crate) fn mul_div_ceil(a: u128, b: u128, d: u128) -> CoreResult<u128> {
    let x = a.checked_mul(b).ok_or(CoreError::Math)?;
    if d == 0 {
        return Err(CoreError::Math);
    }
    let q = x / d;
    if x % d == 0 {
        Ok(q)
    } else {
        q.checked_add(1).ok_or(CoreError::Math)
    }
}

pub(crate) fn to_u64(v: u128) -> CoreResult<u64> {
    u64::try_from(v).map_err(|_| CoreError::Math)
}

pub fn is_ladder_entry(entry: u64) -> bool {
    LADDER.contains(&entry)
}

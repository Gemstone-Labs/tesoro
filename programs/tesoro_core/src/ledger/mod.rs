//! Pure accounting core of `tesoro_core`: the money rules of CONTEXT.md and ADR 0001.
//!
//! Nothing in here touches accounts, CPIs, clocks or syscalls. Every function takes plain values
//! (identities are 32-byte keys, time is a unix timestamp) and mutates plain structs. The only
//! Anchor dependency is the Borsh derive so the same structs can be stored inside program accounts.
//! Every mutating function validates completely before it mutates, so an `Err` leaves its inputs
//! untouched.

pub mod backing;
pub mod book;
pub mod draw;
pub mod extend_limit;
pub mod instant;
pub mod lifecycle;
pub mod line_store;
pub mod matches;
pub mod money;
pub mod native;
pub mod prize;
pub mod protections;
pub mod season;
pub mod stake;
pub mod stake_pool;
pub mod yield_math;

#[cfg(test)]
mod tests;

pub use backing::*;
pub use extend_limit::*;
pub use matches::*;
pub use money::*;
pub use native::*;
pub use protections::*;
pub use season::*;
pub use stake::*;
pub use stake_pool::*;
pub use yield_math::*;

/// Identity of an Account, Position, Source, Game, ... (a Solana public key in the program).
pub type Key = [u8; 32];

/// Basis points denominator.
pub const BPS: u128 = 10_000;
pub const MIN_HORIZON_MONTHS: u8 = 1;
pub const MAX_HORIZON_MONTHS: u8 = 12;
/// The entry sizes in force until the admin sets others, in Gemas.
pub const LADDER: [u64; 3] = [500, 1_000, 2_500];
/// Most entry sizes the admin can set.
pub const MAX_ENTRY_SIZES: usize = 4;
/// Maximum Holdings (distinct Sources) one entry may be drawn from. Bounds accounts per
/// instruction, and with it the payout lines at settlement (see docs/tesoro-core.md).
pub const MAX_ENTRY_SOURCES: usize = 8;
/// Maximum applicants on a public Offer.
pub const MAX_APPLICANTS: usize = 8;
/// Request and Offer lifetime, and the window an accepted Backing has to be used.
pub const BACKING_TTL_SECS: i64 = 24 * 60 * 60;
/// Time a Match has before anybody may refund it as abandoned / no-show.
pub const MATCH_TIMEOUT_SECS: i64 = 60 * 60;
/// Furthest a Game may push an Active Match's refund deadline out, from now (async Games).
pub const MAX_MATCH_EXTENSION_SECS: i64 = 7 * 24 * 60 * 60;
/// Upper bound on Platform Fee + Studio Fee together, in basis points of the Pot.
pub const MAX_TOTAL_FEE_BPS: u16 = 5_000;
/// Upper bound on the Yield Fee, in basis points of every yield increment.
pub const MAX_YIELD_FEE_BPS: u16 = 5_000;
/// Upper bound on the Instant Redeem Fee, in basis points of the redeemed Gemas' value.
pub const MAX_INSTANT_FEE_BPS: u16 = 5_000;

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
    InvalidEntry => "entry is not one of the allowed sizes, or the sizes are invalid",
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
    InvalidDeadline => "deadline may only move later, within the extension cap",
    VaultShortfall => "vault would not cover principal and the yield owed to holders",
    ZeroShares => "amount is worth less than one share at the current rate",
    SeasonNotEnded => "the season has not ended",
    SeasonInvalid => "season or ranking is invalid",
    AlreadyPaid => "this rank was already paid",
    PrizeShortfall => "the supplied pool holdings do not cover the prize",
    NonCanonicalPrize => "pool holdings must be non-empty, ascending by source, each drained but the last",
    LeaderboardOff => "the leaderboard is not set up",
    NotWonGemas => "only won Gemas can be redeemed instantly",
    ExceedsPending => "only Gemas whose yield has not landed can be redeemed instantly; redeem the rest in full",
    AdvanceRepaid => "the advance is already repaid; take another advance instead",
    ExtendCoolingDown => "an extend needs 24 hours since your last one",
    ExtendLimitReached => "this extend would go over your extend limit for the period",
    InvalidExtendLimit => "the extend limit is 0 to 11 months",
    BadStakePool => "account data is not an initialised stake pool with pool tokens",
    EntryLimitReached => "this entry would go over your entry limit for the period",
    PayoutWindowOpen => "the season payout window is still open; ranks are paid 48 hours after it is recorded",
    PayoutWindowClosed => "the season payout window has closed; a rank can no longer be voided",
    RankVoided => "this rank was voided and pays nothing",
    OnBreak => "you are on a Break, so you cannot do this until it ends",
    SelfExcluded => "you are Self-Excluded, so you cannot do this until it ends",
    InvalidBreak => "a Break is 1 to 42 days",
    InvalidSelfExclusion => "Self-Exclusion is 6 to 60 months",
    ProtectionCannotShorten => "a Break or Self-Exclusion cannot end earlier than it already does",
    StaleStakePool => "the staking pool has not been updated this epoch or the one before",
    NoStakingGrowth => "the staking token shows no growth to size an Advance on",
    BookInconsistent => "a Source's bookkeeping contradicts itself",
    NoSuchClass => "the Source has no such class or Extension tranche",
    TooManyExtensions => "a Source has at most 11 Extension tranches",
    NotAFeeCut => "a fee cut moves Gemas of a playable class into a fee class of the same Source",
    MissingCheckpoint => "a line needs a closed-segment record that was not supplied",
    BadCheckpoint => "a checkpoint record or page is malformed",
    CounterExhausted => "a class counter (epoch, scale or segment number) is exhausted",
    NotPooled => "only the pooled fee classes answer this",
    SharesOutOfRange => "more staking-token shares than 2^40 per unit of coverage landed",
    PrizeSourceRefused => "prize Gemas can only be redeemed through the prize escrow",
    PrizeEscrowOff => "the prize escrow is switched off",
    PrizeFundingWaits => "the Treasury holds less than holders, reservations and the Pool are owed; prize funding waits",
    AlreadyFunded => "this Season's prize was already funded on this route",
    OverSpendable => "amount exceeds what the Treasury may spend after holders, the Pool and reservations",
    PrizeBackingShort => "the prize escrow does not hold enough shares for this",
    BudgetStep => "prize payout step is out of order or already done",
    PoolShareTooSoon => "a new prize share applies from a Season at least one full Season ahead",
    SeasonNotFunded => "this Season's prize was not funded on every route",
    SeasonUnfinished => "some ranks of this Season are still unpaid",
    OwedExceedsTreasury => "holders would be owed more shares than the Treasury holds beyond the Pool and reservations",
    NotFillAuthority => "only the admin, or the keeper while its fill rule is on, may fill Instant Redeem orders",
    ReservedGemas => "these Gemas back an Offer reservation",
    InvalidOrderTtl => "an Instant Redeem order lasts 1 hour to 30 days",
    SpillFull => "the account has no room for another line: grow its spill and retry",
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

/// Splits a yield increment into what the Position keeps and the Yield Fee (floored, so rounding
/// favours the Position). `fee_bps` above `MAX_YIELD_FEE_BPS` is refused.
pub fn split_yield_fee(units: u64, fee_bps: u16) -> CoreResult<(u64, u64)> {
    if fee_bps > MAX_YIELD_FEE_BPS {
        return Err(CoreError::InvalidBps);
    }
    let fee = to_u64(mul_div_floor(units as u128, fee_bps as u128, BPS)?)?;
    Ok((units.checked_sub(fee).ok_or(CoreError::Math)?, fee))
}

/// `entry` must be one of `sizes` (the Config's entry sizes).
pub fn is_ladder_entry(entry: u64, sizes: &[u64]) -> bool {
    entry != 0 && sizes.contains(&entry)
}

/// An admin-set list: 1 to `MAX_ENTRY_SIZES` distinct sizes, each a non-zero multiple of the
/// Points divisor (100 Gemas) so Points stay whole.
pub fn validate_entry_sizes(sizes: &[u64]) -> CoreResult<()> {
    if sizes.is_empty() || sizes.len() > MAX_ENTRY_SIZES {
        return Err(CoreError::InvalidEntry);
    }
    for (i, &s) in sizes.iter().enumerate() {
        if s == 0 || s % POINTS_DIVISOR != 0 || sizes[..i].contains(&s) {
            return Err(CoreError::InvalidEntry);
        }
    }
    Ok(())
}

impl From<book::BookError> for CoreError {
    fn from(e: book::BookError) -> CoreError {
        use book::BookError as B;
        match e {
            B::Math => CoreError::Math,
            B::BadSnapshot | B::Corrupt(_) => CoreError::BookInconsistent,
            B::NoSuchClass => CoreError::NoSuchClass,
            B::TooManyExtensions => CoreError::TooManyExtensions,
            B::ClassMismatch => CoreError::SourceMismatch,
            B::ZeroAmount => CoreError::ZeroAmount,
            B::NotEnoughAmount => CoreError::InsufficientGemas,
            B::NotEnoughReady => CoreError::ExceedsRedeemable,
            B::NotAFeeCut => CoreError::NotAFeeCut,
            B::MissingCheckpoint => CoreError::MissingCheckpoint,
            B::BadCheckpoint => CoreError::BadCheckpoint,
            B::CounterExhausted => CoreError::CounterExhausted,
            B::NotPooled => CoreError::NotPooled,
            B::SharesOutOfRange => CoreError::SharesOutOfRange,
        }
    }
}

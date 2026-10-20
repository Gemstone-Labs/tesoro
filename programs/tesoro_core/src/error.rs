use crate::ledger::CoreError;
use anchor_lang::error::AnchorError;
use anchor_lang::prelude::*;

/// Ledger errors surface as `CORE_ERROR_OFFSET + CoreError::code()`.
pub const CORE_ERROR_OFFSET: u32 = 6100;

#[error_code]
pub enum TesoroError {
    #[msg("signer is not authorised")]
    Unauthorized,
    #[msg("game is not registered")]
    GameNotRegistered,
    #[msg("game registry is full")]
    GameRegistryFull,
    #[msg("account does not match")]
    InvalidAccount,
    #[msg("wrong number of remaining accounts")]
    BadRemainingAccounts,
    #[msg("the same account was supplied twice")]
    DuplicateAccount,
    #[msg("account must be writable")]
    NotWritable,
    #[msg("pool is not the canonical sim_lst pool")]
    InvalidPool,
    #[msg("mint is not the sim_lst pool's simSOL mint")]
    InvalidMint,
    #[msg("native Positions are opened and driven only by the native instructions")]
    NativePosition,
    #[msg("position is not a native Position")]
    NotNativePosition,
    #[msg("price is stale or not set")]
    StalePrice,
    #[msg("Gemas of an EVM-sourced Advance are redeemed through the bridge")]
    BridgedSource,
    #[msg("a name is 3 to 20 letters, digits, spaces, dots, underscores or dashes, with no space at either end")]
    InvalidProfileName,
    #[msg("avatar is not one of the available pictures")]
    InvalidAvatar,
    #[msg("the EVM address is not linked to this Account through the bridge")]
    EvmNotLinked,
    #[msg("the leaderboard is not set up")]
    LeaderboardOff,
    #[msg("the treasury cannot pay this instant redeem now")]
    TreasuryShort,
    #[msg("the open Advance's Source must be supplied")]
    SourceRequired,
    #[msg("the Treasury has no company wallet set")]
    CompanyNotSet,
    #[msg("the price feed account is not the mapped Pyth feed, or is not a verified price update")]
    BadPriceFeed,
    #[msg("the price feed's confidence interval is too wide to issue Gemas on")]
    PriceTooUncertain,
    #[msg("this asset is priced from its on-chain feed; use the on-chain Advance")]
    OnchainPriceRequired,
    #[msg("creating an Account needs an Invite")]
    InviteRequired,
    #[msg("an Invite key is needed to turn the Invite gate on")]
    InviteKeyMissing,
    #[msg("this staking token is not the one new Positions open with")]
    StakeTokenInactive,
    #[msg("the Advance APY ceiling is not set")]
    StakeCeilingNotSet,
    #[msg("position is not a staking-token Position")]
    NotStakePosition,
    #[msg("the stake pool account is not the custody's pool, is not owned by a stake pool program, or is not its token's pool")]
    BadStakePoolAccount,
    #[msg("the oracle key can no longer register Positions, report yield or price Advances")]
    OracleLocked,
    #[msg("this account is not of the retired world, so it cannot be retired")]
    NotOldWorld,
}

/// Errors of the economy storage layer (baskets, spills, the sponsor, Source books). Their own
/// range, so the numbers do not move when `TesoroError` gains codes.
#[error_code(offset = 6300)]
pub enum BasketError {
    #[msg("the store is already at the size you asked for")]
    NothingToResize,
    #[msg("the store would go over its maximum number of lines")]
    StoreAtMaximum,
    #[msg("one call adds at most 71 lines")]
    GrowTooLarge,
    #[msg("sponsoring is paused")]
    SponsorPaused,
    #[msg("only the sponsor's relayer authorises sponsored rent")]
    NotSponsorRelayer,
    #[msg("this Account is at its cap of sponsored rent")]
    AccountSponsorCap,
    #[msg("the sponsor is at its total cap of sponsored rent")]
    TotalSponsorCap,
    #[msg("the sponsor does not hold enough SOL")]
    SponsorShort,
    #[msg("the sponsor's caps cannot be below what is already outstanding")]
    CapBelowOutstanding,
    #[msg("the basket or spill account is malformed")]
    BadStore,
    #[msg("a basket and a spill hold no Platform or Leaderboard line: those live in the Source's book")]
    FeeCounterOnly,
    #[msg("account is not a Source book of this program")]
    BadSourceBook,
    #[msg("account is not a checkpoint page of a supplied Source book")]
    BadCheckpointPage,
    #[msg("the same book or page was supplied twice")]
    DuplicateBook,
    #[msg("a line needs the book of its Source")]
    BookMissing,
    #[msg("the supplied accounts must be writable")]
    AccountNotWritable,
    #[msg("the page number is not the next one for this class")]
    WrongPage,
    #[msg("the Source book already exists for this Source")]
    BookExists,
    #[msg("the ledger refused the operation")]
    Ledger,
}

pub fn core_err(e: CoreError) -> Error {
    Error::from(AnchorError {
        error_name: e.name().to_string(),
        error_code_number: CORE_ERROR_OFFSET + e.code(),
        error_msg: e.msg().to_string(),
        error_origin: None,
        compared_values: None,
    })
}

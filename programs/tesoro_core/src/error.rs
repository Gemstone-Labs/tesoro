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
    #[msg("the Game program is not a live program of a loader the registry understands")]
    GameProofInvalid,
    #[msg("the signer does not control the Game program")]
    NotGameControl,
    #[msg("a Studio Fee is at most 10%")]
    StudioFeeTooHigh,
    #[msg("the Studio recipient may not be the Pool, the Treasury or the platform recipient")]
    StudioRecipientReserved,
    #[msg("no change is waiting for this Game")]
    NoPendingChange,
    #[msg("a change to a Game applies 7 days after it is proposed")]
    ChangeDelayNotElapsed,
    #[msg("this Game is not listed, or was upgraded since the admin approved it")]
    GameNotListed,
    #[msg("these two Accounts have started too many Matches together today")]
    PairLimitReached,
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

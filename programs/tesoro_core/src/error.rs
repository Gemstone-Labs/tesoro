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
    #[msg("this pair counter is still inside its 24-hour window")]
    PairWindowOpen,
    #[msg("the program's executable does not hash to the value given")]
    CodeHashMismatch,
    #[msg(
        "the program's executable differs from the approved build; the admin must approve it again"
    )]
    CodeChanged,
    #[msg("the listing already matches the program's deploy slot")]
    ListingCurrent,
    #[msg("the Game is not listed, so there is nothing to refresh")]
    NotListed,
    #[msg("the program is too large to hash in one transaction")]
    ProgramTooLarge,
    #[msg(
        "the Advance would issue fewer Gemas than the minimum asked for (or the minimum is zero)"
    )]
    AdvanceBelowMinimum,
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

/// Errors of Tickets, Pots and the Match lifecycle (tickets 09). Their own range.
#[error_code(offset = 6400)]
pub enum MatchError {
    /// No longer returned (an entry needs no free slot since ticket 09b); kept so the codes after
    /// it do not move.
    #[msg("the spill has no free slots to reserve: grow it first")]
    RoomNotReserved,
    #[msg("this Account already has the most Matches open at once")]
    TooManyOpenMatches,
    #[msg("the Ticket is not this Account's, Game or entry size")]
    TicketMismatch,
    #[msg("the Ticket has not staged the whole entry yet")]
    TicketNotComplete,
    #[msg("faster Gemas arrived since the Ticket staged: stage again")]
    FasterGemasAvailable,
    #[msg("this entry needs more lines than one transaction moves: use an Entry Ticket")]
    NeedsTicket,
    #[msg("the Ticket's storage is full: grow it")]
    TicketStorageFull,
    #[msg("only the owner stages an Entry Ticket")]
    NotTicketOwner,
    #[msg("only the owner cancels a Ticket before it expires")]
    TicketNotExpired,
    #[msg("a Ticket of this kind is already open on this basket")]
    TicketAlreadyOpen,
    #[msg("the Ticket's storage and spill room were not reserved")]
    StorageNotReserved,
    #[msg("the Ticket is not open")]
    TicketNotOpen,
    #[msg("the Pot still holds Gemas")]
    PotNotEmpty,
    #[msg("the Match is not closed: its run is not finished")]
    MatchNotClosed,
    #[msg("this is not the Pot of the Match")]
    WrongPot,
    #[msg("the Backing's accounts do not match the Offer")]
    BadBacking,
    #[msg("the Offer has a Backing Ticket open: cancel that first")]
    OfferHasTicket,
    #[msg("settlement can only start before the Match's absolute deadline")]
    PastAbsoluteDeadline,
    #[msg("the Game was upgraded since the Match opened: it can only be refunded")]
    GameUpgraded,
    #[msg("the Match record and its Pots disagree")]
    Inconsistent,
    #[msg("the Match has no joiner yet")]
    NotJoined,
    #[msg("the run is not finished: more chunks are needed")]
    RunUnfinished,
    #[msg("a settlement receipt can be closed 14 days after it was written")]
    ReceiptTooNew,
    #[msg("an account that must be supplied for this chunk is missing")]
    AccountMissing,
    #[msg("the Match is not in the state this instruction needs")]
    WrongStage,
    #[msg("the Offer cannot be used: it is not accepted, or not by this Player")]
    OfferNotUsable,
    #[msg("this Account already has the most Offers open at once")]
    TooManyOffers,
    #[msg("the stores of the studio that is paid by this Match must be passed when it is joined")]
    StudioStoresMissing,
    #[msg("the overflow record this Match needs was not supplied")]
    OverflowRecordMissing,
    #[msg("the overflow record is not the one for this owner and scope")]
    OverflowRecordInvalid,
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

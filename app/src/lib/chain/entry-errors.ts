import { plainError } from "../errors";

/**
 * What a refused entry says in plain words. tesoro_core numbers its errors in ranges: Anchor's own 6000+ list
 * (in the IDL), the ledger's CoreError at 6100 + its position in `ledger/mod.rs`, Match and Ticket errors at 6400,
 * basket and sponsor errors at 6300. The names are matched from the program log ("Error Code: X") first, the number
 * second, so a log-less failure still reads well.
 */
export const CORE = ["Math", "InvalidHorizon", "InvalidPrice", "InvalidDecimals", "PositionLocked", "PositionNotLocked", "AdvanceAlreadyOpen", "NoOpenAdvance", "SourceMismatch", "AdvanceTooSmall", "DebtOutstanding", "CumulativeDecreased", "ZeroAmount", "NotOwnSource", "ExceedsDebt", "ExceedsRedeemable", "InsufficientGemas", "LineMismatch", "TooManySources", "NonCanonicalDraw", "InvalidEntry", "InvalidBps", "InvalidStatus", "Expired", "NotExpired", "NotParty", "GameMismatch", "EntryMismatch", "SelfMatch", "TooManyApplicants", "AlreadyApplied", "WrongRequest", "ReservationMismatch", "FeeTooHigh", "InvalidDeadline", "VaultShortfall", "ZeroShares", "SeasonNotEnded", "SeasonInvalid", "AlreadyPaid", "PrizeShortfall", "NonCanonicalPrize", "LeaderboardOff", "NotWonGemas", "ExceedsPending", "AdvanceRepaid", "ExtendCoolingDown", "ExtendLimitReached", "InvalidExtendLimit", "BadStakePool", "EntryLimitReached", "PayoutWindowOpen", "PayoutWindowClosed", "RankVoided", "OnBreak", "SelfExcluded", "InvalidBreak", "InvalidSelfExclusion", "ProtectionCannotShorten", "StaleStakePool", "NoStakingGrowth", "BookInconsistent", "NoSuchClass", "TooManyExtensions", "NotAFeeCut", "MissingCheckpoint", "BadCheckpoint", "CounterExhausted", "NotPooled", "SharesOutOfRange", "PrizeSourceRefused", "PrizeEscrowOff", "PrizeFundingWaits", "AlreadyFunded", "OverSpendable", "PrizeBackingShort", "BudgetStep", "PoolShareTooSoon", "SeasonNotFunded", "SeasonUnfinished", "OwedExceedsTreasury", "NotFillAuthority", "ReservedGemas", "InvalidOrderTtl", "SpillFull"];
export const MATCH = ["RoomNotReserved", "TooManyOpenMatches", "TicketMismatch", "TicketNotComplete", "FasterGemasAvailable", "NeedsTicket", "TicketStorageFull", "NotTicketOwner", "TicketNotExpired", "TicketAlreadyOpen", "StorageNotReserved", "TicketNotOpen", "PotNotEmpty", "MatchNotClosed", "WrongPot", "BadBacking", "OfferHasTicket", "PastAbsoluteDeadline", "GameUpgraded", "Inconsistent", "NotJoined", "RunUnfinished", "ReceiptTooNew", "AccountMissing", "WrongStage", "OfferNotUsable", "TooManyOffers", "StudioStoresMissing", "OverflowRecordMissing", "OverflowRecordInvalid"];
export const BASKET = ["NothingToResize", "StoreAtMaximum", "GrowTooLarge", "SponsorPaused", "NotSponsorRelayer", "AccountSponsorCap", "TotalSponsorCap", "SponsorShort", "CapBelowOutstanding", "BadStore", "FeeCounterOnly", "BadSourceBook", "BadCheckpointPage", "DuplicateBook", "BookMissing", "AccountNotWritable", "WrongPage", "BookExists", "Ledger", "AccountsSponsorCap", "PayerNeedsSponsor"];

/** Plain words for the errors an entry can run into. Names not listed here fall through to `plainError`. */
export const ENTRY_WORDS: Record<string, string> = {
  InsufficientGemas: "You don't have enough free Gemas for this entry.",
  ReservedGemas: "Some of your Gemas are held back for an Offer. Cancel the Offer or pick a smaller entry.",
  EntryLimitReached: "This entry would go over your Entry Limit for the period.",
  OnBreak: "You are on a Break, so you can't enter a Match until it ends.",
  SelfExcluded: "You are Self-Excluded, so you can't enter a Match.",
  SelfMatch: "You can't join a Match you back, or one you opened.",
  InvalidEntry: "That entry size isn't available.",
  TooManyOpenMatches: "You already have the most Matches open at once. Finish or cancel one first.",
  TooManyOffers: "You already have the most Offers open at once.",
  TicketAlreadyOpen: "You already have an entry being prepared. Finish or cancel it first.",
  TicketNotComplete: "Your entry isn't fully prepared yet. Keep going.",
  FasterGemasAvailable: "Faster Gemas arrived while your entry was being prepared. Prepare it again.",
  NeedsTicket: "This entry uses many Gemas, so it is prepared in steps first.",
  TicketStorageFull: "Your entry needs more room. Try again.",
  NotTicketOwner: "Only the owner can prepare this entry.",
  TicketNotOpen: "This entry is no longer being prepared.",
  TicketNotExpired: "Only the owner can cancel this entry before it expires.",
  TicketMismatch: "That prepared entry is for a different Game or size.",
  OfferNotUsable: "This Offer can't be used any more. It may have expired or been taken.",
  OfferHasTicket: "This Offer is being used right now. Try again in a moment.",
  BadBacking: "The Backing doesn't match this Offer.",
  PairLimitReached: "You've played this opponent as often as allowed today.",
  GameNotListed: "This Game isn't listed right now.",
  GameUpgraded: "This Game was upgraded since the Match opened. It can only be refunded.",
  WrongStage: "This Match is no longer open.",
  PastAbsoluteDeadline: "This Match ran out of time.",
  SpillFull: "Your account is out of room for another line of Gemas. Try again in a moment.",
  RoomNotReserved: "Your account needs a little more room first. Try again.",
  StoreAtMaximum: "Your account holds the most lines it can.",
  GrowTooLarge: "That is more room than one step can add.",
  SponsorPaused: "Free transactions are paused. Your wallet pays the network fee.",
  AccountSponsorCap: "You've used the free room you get. Your wallet pays for more.",
  TotalSponsorCap: "Free transactions are used up for now. Your wallet pays the network fee.",
  SponsorShort: "Free transactions are used up for now. Your wallet pays the network fee.",
  AccountsSponsorCap: "Free new Accounts are used up for now. Your wallet pays for its own.",
  Unauthorized: "Your wallet can't do this.",
  InvalidAccount: "Something in this entry doesn't match your account. Reload and try again.",
  StaleStakePool: "The staking pool needs a refresh first. Try again in a minute.",
};

function nameOf(text: string): string | null {
  const named = /Error Code: (\w+)/.exec(text);
  if (named) return named[1];
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  const dec = /"Custom":\s*(\d+)/.exec(text);
  const code = hex ? parseInt(hex[1], 16) : dec ? Number(dec[1]) : null;
  if (code === null) return null;
  if (code >= 6400) return MATCH[code - 6400] ?? null;
  if (code >= 6300) return BASKET[code - 6300] ?? null;
  if (code >= 6100) return CORE[code - 6100] ?? null;
  return null;
}

/** The sentence for a failed entry step: ours when we know the error, else the shared `plainError`. */
export function entryError(e: unknown): string {
  const text = e instanceof Error ? `${e.message}\n${(e as { logs?: string[] }).logs?.join("\n") ?? ""}` : String(e);
  const name = nameOf(text);
  return (name && ENTRY_WORDS[name]) || plainError(e);
}

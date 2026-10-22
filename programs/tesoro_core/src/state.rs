//! On-chain accounts. Each wraps a plain ledger struct (`inner`) and stores its canonical bump.
//! Ledger identities (`Key`) are the addresses of the PDAs below; `Account` (CONTEXT.md) is
//! `TesoroAccount` on chain because `Account` is Anchor's wrapper type.

use crate::ledger::{self, Key, Offer, Position, Request, Source};
use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const ACCOUNT_SEED: &[u8] = b"account";
pub const POSITION_SEED: &[u8] = b"position";
pub const SOURCE_SEED: &[u8] = b"source";
/// A Match: `["match", opener Account, counter as u64 LE]`. The counter lives in the opener's
/// `AccountCounters` and only grows, so no id is ever reused.
pub const MATCH_SEED: &[u8] = b"match";
/// An Account's counters (next Match id, open Matches, open Offers): `["counters", account]`.
pub const COUNTERS_SEED: &[u8] = b"counters";
/// An Entry or Backing Ticket, and later the Pot of the side that used it:
/// `["ticket", account, nonce as u64 LE]`.
pub const TICKET_SEED: &[u8] = b"ticket";
/// The settlement receipt of a Match: `["settled", match]`.
pub const RECEIPT_SEED: &[u8] = crate::ledger::lifecycle::RECEIPT_SEED;
pub const REQUEST_SEED: &[u8] = b"request";
pub const OFFER_SEED: &[u8] = b"offer";
pub const NATIVE_SEED: &[u8] = b"native";
pub const NATIVE_VAULT_SEED: &[u8] = b"native_vault";
/// The staking-token setting (ADR 0011): `["stake_config"]`.
pub const STAKE_CONFIG_SEED: &[u8] = b"stake_config";
/// One shared custody per staking token: `["stake_custody", mint]`, with its vault at
/// `["stake_vault", mint]`.
pub const STAKE_CUSTODY_SEED: &[u8] = b"stake_custody";
pub const STAKE_VAULT_SEED: &[u8] = b"stake_vault";
/// PDA that signs `sim_lst::mint_yield`; sim_lst records it as the one yield authority.
pub const YIELD_SEED: &[u8] = b"yield";
pub const PRICE_SEED: &[u8] = b"price";
/// Seed of an asset's on-chain price mapping: `["onchain_price", source_asset]`.
pub const ONCHAIN_PRICE_SEED: &[u8] = b"onchain_price";
pub const SEASON_SEED: &[u8] = b"season";
pub const SEASON_WINDOW_SEED: &[u8] = b"season_window";
/// Address (never a signer) that owns the Leaderboard Pool Account: `["leaderboard"]`.
pub const LEADERBOARD_SEED: &[u8] = b"leaderboard";
pub const PROFILE_SEED: &[u8] = b"profile";
pub const EXTEND_LIMIT_SEED: &[u8] = b"extend_limit";
/// A Player's Protections (Entry Limit now; Break and Self-Exclusion later): `["protections", account]`.
pub const PROTECTIONS_SEED: &[u8] = b"protections";
/// The Treasury: its config account, and the address that owns the Treasury Account and the
/// treasury simSOL vault (`["treasury"]`). Nobody can sign for it outside this program.
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const TREASURY_VAULT_SEED: &[u8] = b"treasury_vault";
/// The cross-chain bridge, whose `EvmLink` accounts prove an EVM address belongs to an Account.
pub const BRIDGE_PROGRAM_ID: Pubkey = pubkey!("5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ");
/// Seed of the bridge's `EvmLink` PDA: `["evm", evm_address]`.
pub const EVM_LINK_SEED: &[u8] = b"evm";

/// simSOL mint of `sim_lst` (PDA `["mint"]` of `WgcM5G...`). A Solana Position whose
/// `source_asset` is this mint is a native Position and is only ever opened by `open_native_position`.
pub const SIM_SOL_MINT: Pubkey = pubkey!("3Q2VRPmdAZHutWNhE2Rof9Pdg6MnTMotXucmoD5cgAZJ");
/// How old the issuance price may be when an Advance is taken.
pub const MAX_PRICE_AGE_SECS: i64 = 24 * 60 * 60;
pub const SOURCE_AUTHORITY_SEED: &[u8] = b"source_auth";
/// The Invite gate setting (ADR 0012): `["invite_gate"]`. Its own account so `Config` keeps its layout.
pub const INVITE_GATE_SEED: &[u8] = b"invite_gate";
/// One record per Game: `["game", program_id]`.
pub const GAME_SEED: &[u8] = b"game";
/// The PDA an immutable Game program signs registration changes with: `["tesoro-register"]` of the
/// Game program (not of this program).
pub const REGISTER_SEED: &[u8] = b"tesoro-register";
/// Matches one opener-to-joiner pair may start in a window: `["pair", opener Account, joiner Account]`.
pub const PAIR_SEED: &[u8] = b"pair";

/// Address of the Invite gate account (it may not exist yet: no account means the gate is off).
pub fn invite_gate_pda() -> Pubkey {
    Pubkey::find_program_address(&[INVITE_GATE_SEED], &crate::ID).0
}

/// While `required`, `create_account` needs `key` as an extra signer.
#[account]
pub struct InviteGate {
    pub bump: u8,
    pub required: bool,
    pub key: Pubkey,
}

impl InviteGate {
    pub const SPACE: usize = 8 + 1 + 1 + 32;
}

/// A Game's Studio Fee never exceeds this share of the Pot.
pub const MAX_STUDIO_BPS: u16 = 1_000;
/// Wait between proposing a change to a Game's record and applying it.
pub const GAME_CHANGE_DELAY_SECS: i64 = 7 * 24 * 60 * 60;
/// The 8-entry list that `Config` carried before the per-Game records: kept so an account written
/// with it still reads. Nothing reads or writes it.
const LEGACY_GAMES: usize = 8;

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize)]
pub struct LegacyGameEntry {
    pub game: Pubkey,
    pub authority: Pubkey,
    pub studio_bps: u16,
    pub studio_recipient: Pubkey,
}

/// One Game. Registered once by whoever controls its program (see `registry`); changed only by
/// that same control, after `GAME_CHANGE_DELAY_SECS`. Listing is written by the admin.
#[account]
pub struct GameRecord {
    pub bump: u8,
    /// The Game program's id.
    pub game: Pubkey,
    /// Only this key may settle the Game's Matches (a PDA of the Game program, or a server key).
    pub settle_authority: Pubkey,
    pub studio_bps: u16,
    /// `TesoroAccount` that receives the Studio Fee.
    pub studio_recipient: Pubkey,
    /// Unix time a proposed change was made; zero while none is waiting.
    pub pending_at: i64,
    /// The control key that proposed it. Applying needs the same key to be in control still.
    pub pending_by: Pubkey,
    pub pending_settle_authority: Pubkey,
    pub pending_studio_bps: u16,
    pub pending_studio_recipient: Pubkey,
    /// The Game counts as listed until this unix time (admin). Zero: never listed.
    pub listed_until: i64,
    /// The deploy slot the admin approved. A program upgraded since has a different slot and
    /// counts as unlisted until the admin approves again.
    pub approved_slot: u64,
    /// SHA-256 of the approved build's executable bytes without trailing zeros (`registry::code_hash`).
    /// A moved slot keeps the listing only through `refresh_listing`, which proves the bytes are these.
    pub approved_hash: [u8; 32],
    /// Counts the builds the admin approved: bumped by `list_game` only when it sets a different
    /// hash, never by `refresh_listing`. A Match remembers the epoch it opened under, so a moved
    /// deploy slot with the same epoch is the same build.
    pub listing_epoch: u32,
}

impl GameRecord {
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 2 + 32 + 8 + 32 + 32 + 2 + 32 + 8 + 8 + 32 + 4;

    /// Listed right now, for the deploy slot the loader reports (`None`: it could not be read).
    pub fn is_listed(&self, now: i64, deploy_slot: Option<u64>) -> bool {
        self.listed_until > now && deploy_slot == Some(self.approved_slot)
    }

    /// The Game program is still the build a Match opened under: the deploy slot is unchanged, or
    /// it moved (ExtendProgram) and `refresh_listing` proved the same bytes in the same epoch.
    pub fn same_build(&self, m: &MatchState, current_slot: u64) -> bool {
        current_slot == m.inner.deploy_slot
            || (current_slot == self.approved_slot && self.listing_epoch == m.listing_epoch)
    }

    pub fn fee_terms(&self, config: &Config) -> ledger::FeeTerms {
        ledger::FeeTerms {
            platform_bps: config.platform_bps,
            studio_bps: self.studio_bps,
            platform_recipient: config.platform_recipient.to_bytes(),
            studio_recipient: self.studio_recipient.to_bytes(),
        }
    }
}

/// How many Matches one opener-to-joiner pair has started in the current window.
#[account]
pub struct PairState {
    pub bump: u8,
    /// Who paid the counter's rent (the joiner's wallet); `close_pair` returns it there.
    pub payer: Pubkey,
    pub window_start: i64,
    pub count: u16,
}

/// Matches one opener-to-joiner pair may start per window.
pub const MAX_PAIR_MATCHES: u16 = 20;
pub const PAIR_WINDOW_SECS: i64 = 24 * 60 * 60;

impl PairState {
    pub const SPACE: usize = 8 + 1 + 32 + 8 + 2;

    /// Counts one more Match started at `now`; `false` when the pair is at its limit for the window.
    pub fn record(&mut self, now: i64) -> bool {
        if now >= self.window_start.saturating_add(PAIR_WINDOW_SECS) {
            self.window_start = now;
            self.count = 0;
        }
        if self.count >= MAX_PAIR_MATCHES {
            return false;
        }
        self.count += 1;
        true
    }
}

#[account]
pub struct Config {
    pub bump: u8,
    pub admin: Pubkey,
    /// Trusted for now to supply the issuance price and `YieldAccrued`/`PositionLocked` facts.
    /// This is the seam for the LayerZero receiver (messages) and Pyth (price).
    pub oracle_authority: Pubkey,
    pub platform_bps: u16,
    /// `TesoroAccount` that receives the Platform Fee.
    pub platform_recipient: Pubkey,
    /// Unused since the per-Game records; its bytes stay so older accounts keep their layout.
    pub legacy_games: Vec<LegacyGameEntry>,
    /// Leaderboard Fee in basis points of the Pot. Appended after `games`: an account created
    /// before it reads the fields as zero (the unused tail of the account is zeroed) and is
    /// extended by `init_leaderboard`.
    pub leaderboard_bps: u16,
    /// The Leaderboard Pool: `TesoroAccount` owned by the `["leaderboard"]` address. Zero until
    /// `init_leaderboard`; the fee is off while it is.
    pub pool_account: Pubkey,
    /// Unix time `init_leaderboard` first ran: Matches opened before it were not charged the fee, so
    /// readers show the fee only for Matches opened at or after it. Zero until then.
    pub leaderboard_since: i64,
    /// Entry sizes in Gemas, zero-padded. All zero until `set_entry_sizes`: the default 500 /
    /// 1,000 / 2,500 apply, so an older Config needs no call. Appended after the Leaderboard
    /// fields: an account created before reads them as zero from its zeroed tail.
    pub entry_sizes: [u64; ledger::MAX_ENTRY_SIZES],
    /// Set by the admin on mainnet (`set_oracle_lock`): the oracle key can no longer register
    /// Positions, report their yield or name an Advance's price (test-mode paths), so a stolen
    /// oracle key cannot mint Gemas. Appended last: an older Config reads it as false.
    pub oracle_locked: bool,
}

impl Config {
    pub const SPACE: usize = Self::LEGACY_SPACE + 2 + 32 + 8 + 8 * ledger::MAX_ENTRY_SIZES + 1;
    /// The layout before the Leaderboard fields.
    pub const LEGACY_SPACE: usize =
        8 + 1 + 32 + 32 + 2 + 32 + 4 + LEGACY_GAMES * (32 + 32 + 2 + 32);

    /// The entry sizes in force: the admin's list, or the default ladder while none is set.
    pub fn entries(&self) -> Vec<u64> {
        let set: Vec<u64> = self
            .entry_sizes
            .iter()
            .copied()
            .filter(|&e| e != 0)
            .collect();
        if set.is_empty() {
            ledger::LADDER.to_vec()
        } else {
            set
        }
    }

    pub fn leaderboard_terms(&self) -> ledger::LeaderboardTerms {
        if self.pool_account == Pubkey::default() {
            return ledger::LeaderboardTerms::default();
        }
        ledger::LeaderboardTerms {
            bps: self.leaderboard_bps,
            recipient: self.pool_account.to_bytes(),
        }
    }
}

/// A recorded Season: the ranking, the frozen prize budget and the per-rank payout cursors, with
/// the 48-hour payout window. Created by `record_season`, paid by `pay_season_rank` one
/// (rank, budget line) step at a time. Seeds `["season", number as u32 LE]`.
#[account]
pub struct SeasonState {
    pub bump: u8,
    pub inner: ledger::PrizeSeason,
}

impl SeasonState {
    /// `PrizeSeason` with its most budget lines.
    pub const SPACE: usize = 8
        + 1
        + (4 + (4 + 8 + 2)
            + 1
            + ledger::PRIZE_PLACES * 32
            + ledger::PRIZE_PLACES * 8
            + 4
            + ledger::MAX_BUDGET_LINES * ledger::BUDGET_LINE_LEN
            + ledger::PRIZE_PLACES
            + 1);
}

/// The signer allowed to report `PositionLocked` / `YieldAccrued` for Positions of one source
/// chain (the cross-chain bridge PDA). Registered by the admin; seeds `["source_auth", chain_byte]`.
#[account]
pub struct SourceAuthority {
    pub bump: u8,
    pub chain: ledger::SourceChain,
    pub authority: Pubkey,
}

impl SourceAuthority {
    pub const SPACE: usize = 8 + 1 + 1 + 32;
}

#[account]
pub struct TesoroAccount {
    pub bump: u8,
    /// Solana wallet that controls the Account.
    pub authority: Pubkey,
    /// The EVM family address of the Account (zero until set).
    pub evm_address: [u8; 20],
}

impl TesoroAccount {
    pub const SPACE: usize = 8 + 1 + 32 + 20;
}

#[account]
pub struct PositionState {
    pub bump: u8,
    pub position_id: [u8; 32],
    pub inner: Position,
}

impl PositionState {
    pub const SPACE: usize = 8
        + 1
        + 32
        + 32
        + 1
        + 32
        + 1
        + 8
        + 2
        + 1
        + 4
        + 5
        + 8
        + 8
        + 8
        + 8
        + 8
        + 8
        + 8
        + 2
        + 8
        + 16
        + 16
        + 8;
}

#[account]
pub struct SourceState {
    pub bump: u8,
    pub inner: Source,
}

impl SourceState {
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 4 + 1 + 16 + 8 + 5 * 8 + 8;
}

/// The most Matches one Account may have open at once (an Open, Active, Settling or Refunding
/// Match counts until it is closed). Idle Matches cannot hold tables for free.
pub const MAX_OPEN_MATCHES: u32 = 8;

/// What an Account has counted: the id of its next Match, how many of its Matches are open, how
/// many Offers it has open. Created with the first Match or Offer; never closed.
#[account]
pub struct AccountCounters {
    pub bump: u8,
    pub next_match: u64,
    pub open_matches: u32,
    pub open_offers: u32,
}

impl AccountCounters {
    pub const SPACE: usize = 8 + 1 + 8 + 4 + 4;
}

/// A Match. The Pots (the Tickets' lines) live in the two Ticket accounts named in `pots`.
#[account]
pub struct MatchState {
    pub bump: u8,
    pub inner: ledger::lifecycle::MatchRecord,
    /// The Game was listed when the Match opened: only then does a win earn Points.
    pub listed: bool,
    /// `GameRecord.listing_epoch` when the Match opened.
    pub listing_epoch: u32,
    /// Who paid the rent of this account; it goes back there when the Match is closed.
    pub payer: Pubkey,
    /// The Ticket account that is each side's Pot (the default key until the side joined).
    pub pots: [Pubkey; 2],
    /// Slots held in Accounts' stores for the lines this Match will credit (`room_reserved` of
    /// each spill counts them). Every credit that takes a new slot pays the holder's share down;
    /// `close_match` hands back what is left.
    pub room: [RoomHold; ROOM_HOLDS],
}

/// Slots of one Account's stores held for a Match.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct RoomHold {
    pub account: [u8; 32],
    pub left: u32,
}

/// Distinct Accounts a Match can credit: both Players, both funders and an outside Studio.
pub const ROOM_HOLDS: usize = 5;

impl RoomHold {
    pub const LEN: usize = 32 + 4;
}

impl MatchState {
    /// Largest Borsh size of `MatchRecord` (a Match with a joiner and a run in progress), checked
    /// by a unit test.
    pub const RECORD_LEN: usize = 486;
    pub const SPACE: usize =
        8 + 1 + Self::RECORD_LEN + 1 + 4 + 32 + 64 + ROOM_HOLDS * RoomHold::LEN;

    pub fn id(&self) -> ledger::lifecycle::MatchId {
        self.inner.id
    }
}

/// Written when a Match enters Settling or Refunding: proof, in core, that its outcome is frozen
/// and its table's result slot is spent. Refundable to whoever paid it.
#[account]
pub struct SettlementReceipt {
    pub bump: u8,
    pub match_key: Pubkey,
    pub payer: Pubkey,
    pub receipt: ledger::lifecycle::Receipt,
}

impl SettlementReceipt {
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 50;
}

#[account]
pub struct RequestState {
    pub bump: u8,
    pub nonce: u64,
    pub inner: Request,
}

impl RequestState {
    pub const SPACE: usize = 8 + 1 + 8 + 32 + 32 + 8 + 8 + 1;
}

#[account]
pub struct OfferState {
    pub bump: u8,
    pub nonce: u64,
    pub inner: Offer,
}

impl OfferState {
    pub const SPACE: usize = 8
        + 1
        + 8
        + 32
        + 32
        + 8
        + 2
        + 33
        + 1
        + 8
        + 8
        + 33
        + 33
        + 4
        + ledger::MAX_APPLICANTS * 32
        + 1;
}

/// The one custody of every native Position (ADR 0010): a single simSOL vault that keeps their
/// Principal, and the pool totals behind the Treasury's Yield Fee claim. Seeds `["native"]`; the
/// vault is `["native_vault"]` with this account as authority. Yield is never held here: it is
/// minted by `sim_lst` at the moment it is paid out.
#[account]
pub struct NativeCustody {
    pub bump: u8,
    pub vault_bump: u8,
    /// The canonical `sim_lst` Pool (test APY and speedup live there).
    pub pool: Pubkey,
    pub mint: Pubkey,
    /// Token account (PDA) that keeps the Principal of every Locked native Position.
    pub vault: Pubkey,
    /// `PoolTotals` (`ledger::yield_math`), updated only on open and unlock.
    pub principal: u128,
    pub fee_weight: u128,
    pub fee_weight_time: u128,
    pub realised_fee: u128,
    pub open_positions: u64,
    /// The Treasury's shares of this route: what it holds, what holders and the Pool are owed
    /// (realised fees only, D1), the prize escrow. Simulated shares are minted at payout, so most
    /// of these are virtual until paid.
    pub route: ledger::RouteLedger,
}

impl NativeCustody {
    pub const SPACE: usize = 8 + 1 + 1 + 3 * 32 + 4 * 16 + 8 + ledger::RouteLedger::SPACE;

    pub fn totals(&self) -> ledger::PoolTotals {
        ledger::PoolTotals {
            principal: self.principal,
            fee_weight: self.fee_weight,
            fee_weight_time: self.fee_weight_time,
            realised_fee: self.realised_fee,
            open_positions: self.open_positions,
        }
    }

    pub fn set_totals(&mut self, t: ledger::PoolTotals) {
        self.principal = t.principal;
        self.fee_weight = t.fee_weight;
        self.fee_weight_time = t.fee_weight_time;
        self.realised_fee = t.realised_fee;
        self.open_positions = t.open_positions;
    }
}

/// The staking-token setting for mainnet SOL Positions (ADR 0011): which token new Positions open
/// with, and the ceiling on the APY an Advance is sized on. Seeds `["stake_config"]`. Test mode
/// never creates it.
#[account]
pub struct StakeConfig {
    pub bump: u8,
    /// Mint of the one active token; default = none yet.
    pub active_mint: Pubkey,
    /// Ceiling on the annualised growth an Advance is sized on, basis points; 0 = not set (no
    /// Advance can be taken).
    pub apy_ceiling_bps: u16,
}

impl StakeConfig {
    pub const SPACE: usize = 8 + 1 + 32 + 2;
}

/// The shared custody of one staking token. Every stake Position of that token holds its
/// `custody_shares` in `vault`; the totals behind the Treasury's Yield Fee claim change only on
/// open and unlock (`ledger::stake`). Seeds `["stake_custody", mint]`; the vault is a token account
/// at `["stake_vault", mint]` with this account as authority.
#[account]
pub struct StakeCustody {
    pub bump: u8,
    pub vault_bump: u8,
    pub mint: Pubkey,
    /// The SPL stake pool account the token's Staking Rate is read from.
    pub pool: Pubkey,
    pub vault: Pubkey,
    pub principal: u128,
    pub fee_shares: u128,
    pub fee_principal: u128,
    pub realised_fee_shares: u128,
    pub open_positions: u64,
    /// Tokens the Treasury bought back by redeeming Gemas (their yield stays in the vault).
    pub refilled_shares: u64,
    /// Tokens paid by Instant Redeem, cumulative.
    pub instant_shares: u64,
    /// Tokens withdrawn to the company wallet, cumulative.
    pub withdrawn_shares: u64,
    /// The Treasury's shares of this route. The vault holds exactly the open Positions' custody
    /// plus `route.treasury_shares` plus the prize escrow (`route.escrow_total()`).
    pub route: ledger::RouteLedger,
}

impl StakeCustody {
    pub const SPACE: usize = 8 + 2 + 3 * 32 + 4 * 16 + 8 + 3 * 8 + ledger::RouteLedger::SPACE;

    pub fn totals(&self) -> ledger::StakeTotals {
        ledger::StakeTotals {
            principal: self.principal,
            fee_shares: self.fee_shares,
            fee_principal: self.fee_principal,
            realised_fee_shares: self.realised_fee_shares,
            open_positions: self.open_positions,
        }
    }

    pub fn set_totals(&mut self, t: ledger::StakeTotals) {
        self.principal = t.principal;
        self.fee_shares = t.fee_shares;
        self.fee_principal = t.fee_principal;
        self.realised_fee_shares = t.realised_fee_shares;
        self.open_positions = t.open_positions;
    }
}

/// Tesoro's Treasury (CONTEXT.md): its Yield Fee on Solana-native Positions is computed from the
/// `NativeCustody` pool totals (ADR 0010) and minted lazily: its balance is the unminted fee
/// (`earned_fee - fee_minted`) plus the simSOL in `vault`. It pays Solana Instant Redeems and
/// `withdraw_treasury` from `vault` first, then by minting the shortfall out of the unminted fee, and holds the Gemas it bought in `account`, a
/// `TesoroAccount` whose authority is this PDA. Seeds `["treasury"]`. Its fee rates apply on every
/// chain: `yield_fee_bps` sizes every Advance, and EVM vaults take the same fee at the source.
#[account]
pub struct Treasury {
    pub bump: u8,
    pub vault_bump: u8,
    pub account_bump: u8,
    /// Yield Fee, basis points of every yield increment (2,000 at launch).
    pub yield_fee_bps: u16,
    /// Instant Redeem Fee, basis points of the redeemed Gemas' value (3,500 on devnet; 2,500 on mainnet, ADR 0011).
    pub instant_fee_bps: u16,
    /// The Treasury Account (`["account", treasury]`).
    pub account: Pubkey,
    /// simSOL token account (`["treasury_vault"]`), authority = this PDA.
    pub vault: Pubkey,
    /// SOL units of earned Yield Fee already minted out as simSOL (to a withdrawal or an Instant
    /// Redeem payout). Never above `PoolTotals::earned_fee`; the difference is the unminted fee.
    pub fee_minted: u64,
    /// SOL units paid out by Solana Instant Redeems, cumulative.
    pub instant_units: u64,
    /// simSOL shares the admin funded the vault with, cumulative.
    pub funded_shares: u64,
    /// SOL units withdrawn to the company wallet, cumulative.
    pub withdrawn_units: u64,
    /// The wallet whose simSOL account `withdraw_treasury` pays; unset (default) refuses.
    pub company: Pubkey,
}

impl Treasury {
    pub const SPACE: usize = 8 + 3 + 2 + 2 + 32 + 32 + 3 * 8 + 8 + 32;
}

/// SOL/USD price used for issuance (micro-USD per whole SOL). Written by the oracle authority
/// for devnet; the Pyth seam replaces this account's source, not `take_native_advance`.
#[account]
pub struct PriceFeed {
    pub bump: u8,
    pub asset: Pubkey,
    pub price_micro_usd: u64,
    pub updated_ts: i64,
}

impl PriceFeed {
    pub const SPACE: usize = 8 + 1 + 32 + 8 + 8;
}

/// Where an asset's Advances read their USD price on mainnet (ADR 0011): the Pyth sponsored push
/// feed account and the feed id it must carry. Admin-set, seeds `["onchain_price", source_asset]`.
/// While it exists the oracle-supplied price path (`take_advance`) is closed for that asset.
#[account]
pub struct OnchainPrice {
    pub bump: u8,
    /// The `source_asset` of the Positions it prices (the staking token's mint or EVM key).
    pub asset: Pubkey,
    /// The `PriceUpdateV2` account the price is read from (owned by the Pyth receiver).
    pub feed: Pubkey,
    /// The Pyth feed id of the asset's underlying coin (SOL/USD, ETH/USD, HYPE/USD).
    pub feed_id: [u8; 32],
    /// The oldest price an Advance accepts; the program caps it at `pyth::MAX_ONCHAIN_PRICE_AGE_SECS`.
    pub max_age_secs: u32,
    /// The widest confidence interval an Advance accepts, share of the price in basis points.
    pub max_conf_bps: u16,
}

impl OnchainPrice {
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 32 + 4 + 2;

    /// The micro-USD price of one whole unit of the asset, read from the feed account `info`.
    pub fn read(&self, info: &AccountInfo, now: i64) -> Result<u64> {
        use crate::error::TesoroError;
        use crate::pyth::{read_micro_usd, PythError, PYTH_RECEIVER};
        require_keys_eq!(*info.key, self.feed, TesoroError::BadPriceFeed);
        require_keys_eq!(*info.owner, PYTH_RECEIVER, TesoroError::BadPriceFeed);
        let data = info.try_borrow_data()?;
        read_micro_usd(
            &data,
            &self.feed_id,
            now,
            self.max_age_secs,
            self.max_conf_bps,
        )
        .map_err(|e| match e {
            PythError::BadFeed => error!(TesoroError::BadPriceFeed),
            PythError::Stale => error!(TesoroError::StalePrice),
            PythError::LowConfidence => error!(TesoroError::PriceTooUncertain),
        })
    }
}

#[event]
pub struct InstantRequested {
    pub order: Pubkey,
    pub account: Pubkey,
    pub source: Pubkey,
    pub gemas: u64,
    pub expires_at: i64,
}

#[event]
pub struct InstantFilled {
    pub order: Pubkey,
    pub source: Pubkey,
    pub gemas: u64,
    /// Shares the Treasury paid the seller.
    pub payout_shares: u64,
    pub fee_bps: u16,
}

#[event]
pub struct InstantReturned {
    pub order: Pubkey,
    pub gemas: u64,
    pub expired: bool,
}

#[event]
pub struct Harvested {
    pub source: Pubkey,
    pub gemas: u64,
    pub shares: u64,
}

#[event]
pub struct SeasonFunded {
    pub season: u32,
    pub route: Pubkey,
    pub moved_shares: u64,
    pub prize_source: Pubkey,
    pub gemas: u64,
}

#[event]
pub struct PrizeRedeemed {
    pub prize_source: Pubkey,
    pub account: Pubkey,
    pub gemas: u64,
    pub shares: u64,
}

/// Seed of the economy settings: `["economy"]`.
pub const ECONOMY_SEED: &[u8] = b"economy";
/// Seed of an Instant Redeem order: `["instant", holder account, nonce LE]`.
pub const INSTANT_ORDER_SEED: &[u8] = b"instant";
/// Seed of a prize Source: `["prize", route (custody), season LE]`.
pub const PRIZE_SOURCE_SEED: &[u8] = b"prize";
/// Seed of the Pool's Season reservations: `["pool_reservations"]`.
pub const POOL_RESERVATIONS_SEED: &[u8] = b"pool_reservations";

/// How many routes (custodies) `record_season` waits for.
pub const MAX_ROUTES: usize = 4;

/// Who may do what in the economy upgrade, as explicit settings (never the oracle authority).
/// Seeds `["economy"]`; created by the admin's `set_economy`.
#[account]
pub struct EconomyConfig {
    pub bump: u8,
    /// Runs Seasons (`fund_season_prize`, `record_season`, `pay_season_rank`) besides the admin.
    pub season_keeper: Pubkey,
    /// May fill Instant Redeem orders while `keeper_fills` is on (the admin always may).
    pub fill_keeper: Pubkey,
    /// Off by default: only the admin fills.
    pub keeper_fills: bool,
    /// The Pool's share of every realised Yield Fee, changeable from a Season announced ahead.
    pub pool_share: ledger::PoolShare,
    /// Custodies whose prize escrow `record_season` waits for (zero = unused slot).
    pub routes: [Pubkey; MAX_ROUTES],
    /// The Account that receives the Studio Fee counters of Tesoro's own Games (`cash_in_fee`);
    /// zero until the admin names it.
    pub tesoro_studio: Pubkey,
}

impl EconomyConfig {
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 1 + (2 + 4 + 2) + 32 * MAX_ROUTES + 32;

    pub fn fill_authority(&self, admin: &Pubkey) -> ledger::FillAuthority {
        ledger::FillAuthority {
            admin: admin.to_bytes(),
            keeper: self.fill_keeper.to_bytes(),
            keeper_fills: self.keeper_fills,
        }
    }
}

/// An open Instant Redeem order (ticket 07's `InstantOrder` on chain): the unsold Gemas sit in
/// `line`, off the owner's basket, until a fill buys them, the owner cancels or the order expires.
/// Seeds `["instant", holder account, nonce LE]`; the owner pays the rent and gets it back, or the
/// sponsor does for a Player with no SOL (it is repaid first).
#[account]
pub struct InstantOrderState {
    pub bump: u8,
    pub nonce: u64,
    /// The seller's `TesoroAccount`.
    pub account: Pubkey,
    /// The seller's wallet.
    pub owner: Pubkey,
    /// `Line` bytes (`LINE_LEN`).
    pub line: [u8; ledger::LINE_LEN],
    pub requested: u64,
    pub created_at: i64,
    pub expires_at: i64,
    pub sold: u64,
    pub redeemed_while_open: u64,
    pub paid_shares: u128,
    /// Who paid the order's rent and gets it back at the close: the seller, or the sponsor's
    /// relayer (then `sponsored_lamports` of it return to the sponsor first).
    pub payer: Pubkey,
    pub sponsored_lamports: u64,
}

impl InstantOrderState {
    pub const SPACE: usize =
        8 + 1 + 8 + 32 + 32 + ledger::LINE_LEN + 8 + 8 + 8 + 8 + 8 + 16 + 32 + 8;

    /// The Source whose Gemas the order holds.
    pub fn line_source(&self) -> Pubkey {
        Pubkey::new_from_array(ledger::line_store::Line::decode(&self.line).source)
    }

    pub fn order(&self) -> ledger::InstantOrder {
        ledger::InstantOrder {
            owner: self.account.to_bytes(),
            line: ledger::line_store::Line::decode(&self.line),
            requested: self.requested,
            created_at: self.created_at,
            expires_at: self.expires_at,
            sold: self.sold,
            redeemed_while_open: self.redeemed_while_open,
            paid_shares: self.paid_shares,
        }
    }

    pub fn set_order(&mut self, o: &ledger::InstantOrder) {
        o.line.encode(&mut self.line);
        self.requested = o.requested;
        self.created_at = o.created_at;
        self.expires_at = o.expires_at;
        self.sold = o.sold;
        self.redeemed_while_open = o.redeemed_while_open;
        self.paid_shares = o.paid_shares;
    }
}

/// A prize Source: Gemas issued against a quantity of shares held in a route's prize escrow
/// (ticket 06's `PrizeSource`). It has no book and no unpaid Gemas. Seeds
/// `["prize", route, season LE]`.
#[account]
pub struct PrizeSourceState {
    pub bump: u8,
    /// The custody (route) whose escrow backs it.
    pub route: Pubkey,
    pub season: u32,
    pub inner: ledger::PrizeSource,
}

impl PrizeSourceState {
    pub const SPACE: usize = 8 + 1 + 32 + 4 + (32 + 16 + 8);
}

/// One reservation of a Pool line by a recorded Season's budget (Borsh form of
/// `ledger::PoolReservations`' entries).
#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize)]
pub struct ReservationEntry {
    pub side: u8,
    pub due_at: i64,
    pub source: Key,
    pub class: u8,
    pub tranche: u8,
    pub amount: u64,
}

/// The Pool's lines that Seasons have promised (`ledger::PoolReservations`). Seeds
/// `["pool_reservations"]`.
#[account]
pub struct PoolReservationsState {
    pub bump: u8,
    pub entries: Vec<ReservationEntry>,
}

impl PoolReservationsState {
    pub const SPACE: usize = 8 + 1 + 4 + ledger::MAX_RESERVATION_ENTRIES * 51;

    pub fn reservations(&self) -> ledger::PoolReservations {
        ledger::PoolReservations::from_entries(self.entries.iter().map(|e| {
            (
                ledger::LineKey {
                    side: e.side,
                    due_at: e.due_at,
                    source: e.source,
                    class: e.class,
                    tranche: e.tranche,
                },
                e.amount,
            )
        }))
    }

    pub fn set_reservations(&mut self, r: &ledger::PoolReservations) {
        self.entries = r
            .entries()
            .iter()
            .map(|(k, a)| ReservationEntry {
                side: k.side,
                due_at: k.due_at,
                source: k.source,
                class: k.class,
                tranche: k.tranche,
                amount: *a,
            })
            .collect();
    }
}

pub fn key(p: &Pubkey) -> Key {
    p.to_bytes()
}

#[event]
pub struct AdvanceIssued {
    pub position: Pubkey,
    pub source: Pubkey,
    pub gemas: u64,
    pub horizon_months: u8,
    pub price_micro_usd: u64,
}

/// A Player's Extend Limit. Seeds `["extend_limit", account]`; created by the first Extend (at the
/// default) or by `set_extend_limit`, paid by the owner.
#[account]
pub struct ExtendLimitState {
    pub bump: u8,
    /// The `TesoroAccount` this limit belongs to; the default key until first used.
    pub account: Pubkey,
    pub inner: ledger::ExtendLimit,
}

impl ExtendLimitState {
    pub const SPACE: usize = 8 + 1 + 32 + ledger::ExtendLimit::SPACE;
}

/// A Player's Protections. Seeds `["protections", account]`; created by the first
/// `set_entry_limit` (or any later Protection), paid by the owner. A Player who never set one has no
/// account, which means no Protection is in force: every Match entry and Backing still passes the
/// (empty) PDA address, so a direct transaction cannot leave it out.
#[account]
pub struct ProtectionsState {
    pub bump: u8,
    /// The `TesoroAccount` these belong to; the default key until first used.
    pub account: Pubkey,
    pub inner: ledger::Protections,
}

impl ProtectionsState {
    pub const SPACE: usize = 8 + 1 + 32 + ledger::Protections::SPACE;
}

#[event]
pub struct BreakSet {
    pub account: Pubkey,
    /// When the Break ends (unix seconds).
    pub until: i64,
}

#[event]
pub struct SelfExclusionSet {
    pub account: Pubkey,
    /// When the Self-Exclusion ends (unix seconds).
    pub until: i64,
}

#[event]
pub struct EntryLimitSet {
    pub account: Pubkey,
    /// The limit in force after the change, in Gemas (zero = off).
    pub gemas: u64,
    /// A raise waiting for `pending_at` (zero = none); a pending zero means the limit is removed.
    pub pending_gemas: u64,
    pub pending_at: i64,
}

#[event]
pub struct ExtendLimitSet {
    pub account: Pubkey,
    /// The limit in force after the change.
    pub months: u8,
    /// A raise waiting for `pending_at` (zero = none).
    pub pending_months: u8,
    pub pending_at: i64,
}

#[event]
pub struct AdvanceExtended {
    pub position: Pubkey,
    pub source: Pubkey,
    /// Gemas minted by this Extend.
    pub gemas: u64,
    pub extra_months: u8,
    /// Horizon after the Extend.
    pub horizon_months: u8,
}

#[event]
pub struct YieldApplied {
    pub position: Pubkey,
    pub seq: u64,
    pub cumulative: u64,
    pub debt_gemas: u64,
}

/// The seam for `PayYield`: source-chain units owed to the redeeming Account's address there.
#[event]
pub struct Redeemed {
    pub position: Pubkey,
    pub source: Pubkey,
    pub account: Pubkey,
    pub gemas: u64,
    pub source_units: u64,
}

#[event]
pub struct YieldClaimed {
    pub position: Pubkey,
    pub amount: u64,
}

/// The seam for the `Unlock` message.
#[event]
pub struct PositionUnlocked {
    pub position: Pubkey,
}

#[event]
pub struct NativePositionOpened {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub rate: u64,
    pub principal_sol: u64,
}

/// simSOL paid to `to` for a native Position.
#[event]
pub struct NativePayout {
    pub position: Pubkey,
    pub to: Pubkey,
    pub shares: u64,
    pub sol_units: u64,
    /// 0 = redeem (yield minted), 1 = unlock Principal (from the vault), 2 = unlock free yield
    /// (minted).
    pub kind: u8,
}

/// Won Gemas sold to the Treasury: `payout_units` is paid now (on Solana in the same transaction,
/// on an EVM chain by the vault's treasury through the bridge), `source_units` is their full value.
#[event]
pub struct InstantRedeemed {
    pub position: Pubkey,
    pub source: Pubkey,
    pub account: Pubkey,
    pub gemas: u64,
    pub source_units: u64,
    pub payout_units: u64,
}

/// The admin withdrew `units` SOL (`shares` simSOL, `minted_units` of it freshly minted from the
/// earned Yield Fee) to the company wallet.
#[event]
pub struct TreasuryWithdrawn {
    pub company: Pubkey,
    pub units: u64,
    pub shares: u64,
    pub minted_units: u64,
}

#[event]
pub struct TreasuryFunded {
    pub shares: u64,
}

/// The admin mapped an asset to the Pyth feed its Advances are priced from.
#[event]
pub struct OnchainPriceSet {
    pub asset: Pubkey,
    pub feed: Pubkey,
    pub feed_id: [u8; 32],
}

/// The admin chose the staking token new SOL Positions open with.
#[event]
pub struct StakeTokenSet {
    pub mint: Pubkey,
    pub pool: Pubkey,
}

#[event]
pub struct StakeApyCeilingSet {
    pub apy_ceiling_bps: u16,
}

#[event]
pub struct StakePositionOpened {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub shares: u64,
    /// Staking Rate at open, lamports per token at 1e12.
    pub rate: u64,
    pub principal_sol: u64,
}

/// Staking tokens paid to `to` for a stake Position or from the Treasury.
#[event]
pub struct StakePayout {
    pub position: Pubkey,
    pub to: Pubkey,
    pub shares: u64,
    pub sol_units: u64,
    /// 0 = redeem, 1 = unlock Principal, 2 = unlock free yield, 3 = instant redeem, 4 = withdrawal.
    pub kind: u8,
}

#[event]
pub struct PriceSet {
    pub asset: Pubkey,
    pub price_micro_usd: u64,
}

/// A Match was won. The Player is the Account that played (a Backer's win is the Player's for
/// points). Every season standing is the sum of these events, so anyone can recompute it. Written
/// by event-CPI when the outcome is frozen (the start of Settling), so it cannot be forged by
/// another program's log: readers check the program id of the inner instruction.
#[event]
pub struct MatchWon {
    /// The opener's Account and its counter value: the Match id.
    pub opener: Pubkey,
    pub n: u64,
    pub game: Pubkey,
    pub entry: u64,
    pub player: Pubkey,
    pub funder: Pubkey,
    pub points: u64,
    /// Gemas this Match pays into the Leaderboard Pool.
    pub pool_fee: u64,
    pub season: u32,
    pub ts: i64,
    /// The Account that played on the losing side (the opponent of `player`).
    pub loser: Pubkey,
    pub challenge: bool,
    pub asset: u8,
    pub opened_at: i64,
}

/// Settling or Refunding started: the outcome and the fees are frozen. Start record of a run.
#[event]
pub struct MatchRunStarted {
    pub opener: Pubkey,
    pub n: u64,
    pub game: Pubkey,
    /// 0 win, 1 no-show, 2 draw, 3 cancelled, 4 abandoned, 5 game upgraded, 6 refunded by game.
    pub kind: u8,
    /// Index of the winning side (0 opened, 1 joined); 255 when there is none.
    pub winner: u8,
    pub entry: u64,
    pub fees: [u64; 3],
    pub a_player: Pubkey,
    pub a_funder: Pubkey,
    pub b_player: Pubkey,
    pub b_funder: Pubkey,
    pub challenge: bool,
    pub asset: u8,
    pub opened_at: i64,
    pub ts: i64,
    /// Each side's Player share of a Backing, in bps (0 for an unbacked side).
    pub a_share_bps: u16,
    pub b_share_bps: u16,
}

/// One chunk of a run did work. Stable ids: the Match id and the chunk number.
#[event]
pub struct MatchChunkDone {
    pub opener: Pubkey,
    pub n: u64,
    pub chunk_no: u32,
    pub steps: u32,
    pub done: bool,
    /// A step could not run (missing account or room); nothing was skipped.
    pub blocked: bool,
    /// Credits this chunk wrote into overflow records instead of the Accounts' stores.
    pub overflowed: u32,
}

/// Lines moved out of an overflow record into their owner's stores.
#[event]
pub struct OverflowClaimed {
    pub account: Pubkey,
    pub kind: u8,
    pub moved: u32,
    /// Lines still waiting in the record; zero means it was closed and its rent returned.
    pub left: u32,
}

/// The run is complete: every obligation is a durable basket or spill line.
#[event]
pub struct MatchSettled {
    pub opener: Pubkey,
    pub n: u64,
    pub kind: u8,
    pub chunks: u32,
}

#[event]
pub struct SeasonRecorded {
    pub season: u32,
    pub pool_total: u64,
    pub winners: u8,
}

#[event]
pub struct SeasonRankVoided {
    pub season: u32,
    pub rank: u8,
    pub account: Pubkey,
}

#[event]
pub struct SeasonPrizePaid {
    pub season: u32,
    pub rank: u8,
    pub account: Pubkey,
    pub amount: u64,
}

/// Number of animal-head avatars the app ships (`app/src/lib/art.ts`). `AvatarChoice::Animal(i)` takes `i` in `0..AVATAR_COUNT`.
pub const AVATAR_COUNT: u8 = 12;
pub const PROFILE_NAME_MIN: usize = 3;
pub const PROFILE_NAME_MAX: usize = 20;

/// Which picture a Player shows. `Default` is the avatar derived from the Account key;
/// `NameService` is the avatar of the Player's .sol / .eth record (the app falls back to
/// `Default` when there is none).
#[derive(Clone, Copy, PartialEq, Eq, Debug, AnchorSerialize, AnchorDeserialize)]
pub enum AvatarChoice {
    Default,
    NameService,
    Animal(u8),
}

/// A Player's chosen display name and picture. Seeds `["profile", account]`; one per Account,
/// created by the first `set_profile`. Names are not unique and are not verified: a name is a label.
#[account]
pub struct Profile {
    pub bump: u8,
    /// The `TesoroAccount` this Profile belongs to.
    pub account: Pubkey,
    pub name_len: u8,
    /// UTF-8 (ASCII only), zero padded past `name_len`.
    pub name: [u8; PROFILE_NAME_MAX],
    pub avatar: AvatarChoice,
    /// A Solana wallet that co-signed `set_name_wallet`: its primary .sol name shows for this Player
    /// (the Account's own wallet is a Tesoro-created one with no name). Default key = none.
    pub name_wallet: Pubkey,
    /// An EVM address linked to this Account through the bridge (`link_evm`) and attached by
    /// `set_name_evm`: its primary .eth name shows. All zeros = none.
    pub name_evm: [u8; 20],
}

impl Profile {
    /// Discriminator, bump, account, name_len, name, avatar (tag + one index byte at most), name_wallet, name_evm.
    pub const SPACE: usize = 8 + 1 + 32 + 1 + PROFILE_NAME_MAX + 2 + 32 + 20;

    /// 3 to 20 characters from letters, digits, space, `.`, `_`, `-`; no leading or trailing space.
    pub fn name_is_valid(name: &[u8]) -> bool {
        (PROFILE_NAME_MIN..=PROFILE_NAME_MAX).contains(&name.len())
            && name.first() != Some(&b' ')
            && name.last() != Some(&b' ')
            && name
                .iter()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b' ' | b'.' | b'_' | b'-'))
    }

    pub fn avatar_is_valid(avatar: AvatarChoice) -> bool {
        !matches!(avatar, AvatarChoice::Animal(i) if i >= AVATAR_COUNT)
    }
}

#[cfg(test)]
mod profile_tests {
    use super::*;

    #[test]
    fn names() {
        for ok in [
            "abc",
            "Ana Maria",
            "a.b_c-d",
            "x".repeat(20).as_str(),
            "0xAB",
        ] {
            assert!(Profile::name_is_valid(ok.as_bytes()), "{ok}");
        }
        for bad in [
            "",
            "ab",
            " abc",
            "abc ",
            "a@b",
            "ça va",
            "x".repeat(21).as_str(),
            "a\tb",
            "a/b",
        ] {
            assert!(!Profile::name_is_valid(bad.as_bytes()), "{bad:?}");
        }
    }

    #[test]
    fn avatars() {
        assert!(Profile::avatar_is_valid(AvatarChoice::Default));
        assert!(Profile::avatar_is_valid(AvatarChoice::NameService));
        assert!(Profile::avatar_is_valid(AvatarChoice::Animal(11)));
        assert!(!Profile::avatar_is_valid(AvatarChoice::Animal(12)));
    }
}

/// An account of the world before the yield-by-math reset was closed by the admin. `kind`:
/// 0 custody (`amount` = simSOL returned to its owner), 1 Position, 2 Source, 3 Holding
/// (`amount` 0), 4 Request, 5 Offer, 6 Treasury.
#[event]
pub struct OldAccountRetired {
    pub kind: u8,
    pub account: Pubkey,
    pub amount: u64,
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::ledger::lifecycle::*;
    use anchor_lang::AnchorSerialize;

    /// The fullest Match: joined, Backed, an outside studio, a run started, every room hold used.
    pub(crate) fn fullest_match_state() -> MatchState {
        // the fullest record: a joined Match with a Backed side, an outside studio and a run
        let party = Party {
            player: [1; 32],
            funder: [2; 32],
            share_bps: 1,
        };
        let mut rec = MatchRecord::open(
            MatchId {
                opener: [1; 32],
                n: u64::MAX,
            },
            MatchMeta {
                challenge: true,
                asset: 9,
                listed: true,
            },
            [3; 32],
            [4; 32],
            u64::MAX,
            Terms {
                platform_bps: 1,
                studio_bps: 1,
                studio_owner: Some([5; 32]),
                studio_priority: true,
            },
            500,
            &[500],
            party,
            &{
                let mut p = crate::ledger::draw::PotPages::new([2; 32]);
                let mut l = crate::ledger::book::SourceBook::blank_line(
                    0,
                    0,
                    [7; 32],
                    crate::ledger::line_store::CLASS_GENERAL,
                    0,
                );
                l.amount = 500;
                p.push(&l).unwrap();
                p
            },
            1,
        )
        .unwrap();
        let mut p = crate::ledger::draw::PotPages::new([9; 32]);
        let mut l = crate::ledger::book::SourceBook::blank_line(
            0,
            0,
            [8; 32],
            crate::ledger::line_store::CLASS_GENERAL,
            0,
        );
        l.amount = 500;
        p.push(&l).unwrap();
        rec.join(
            Party {
                player: [10; 32],
                funder: [11; 32],
                share_bps: 2,
            },
            &p,
            2,
        )
        .unwrap();
        rec.start_settle(3, &[4; 32], u64::MAX, Outcome::NoShow, 1)
            .unwrap();
        let state = MatchState {
            bump: 255,
            inner: rec,
            listed: true,
            listing_epoch: u32::MAX,
            payer: Pubkey::new_from_array([60; 32]),
            pots: [
                Pubkey::new_from_array([61; 32]),
                Pubkey::new_from_array([62; 32]),
            ],
            room: std::array::from_fn(|i| RoomHold {
                account: [40 + i as u8; 32],
                left: 3 + i as u32,
            }),
        };
        state
    }

    #[test]
    fn the_match_record_never_outgrows_its_account() {
        let state = fullest_match_state();
        let mut bytes = Vec::new();
        state.serialize(&mut bytes).unwrap();
        // 8 discriminator + bump, then the Borsh of the rest
        assert!(
            8 + 1 + bytes.len() - 1 <= MatchState::SPACE,
            "{} bytes against {}",
            bytes.len(),
            MatchState::SPACE
        );
        assert!(
            MatchState::RECORD_LEN
                >= bytes.len() - 1 - 1 - 4 - 32 - 64 - ROOM_HOLDS * RoomHold::LEN
        );
    }
}

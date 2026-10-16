//! On-chain accounts. Each wraps a plain ledger struct (`inner`) and stores its canonical bump.
//! Ledger identities (`Key`) are the addresses of the PDAs below; `Account` (CONTEXT.md) is
//! `TesoroAccount` on chain because `Account` is Anchor's wrapper type.

use crate::ledger::{self, Holding, Key, Match, Offer, Position, Request, Source};
use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const ACCOUNT_SEED: &[u8] = b"account";
pub const POSITION_SEED: &[u8] = b"position";
pub const SOURCE_SEED: &[u8] = b"source";
pub const HOLDING_SEED: &[u8] = b"holding";
pub const MATCH_SEED: &[u8] = b"match";
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

pub const MAX_GAMES: usize = 8;

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize)]
pub struct GameEntry {
    /// Identity of the Game (its program id).
    pub game: Pubkey,
    /// Only this key may settle the Game's Matches (a PDA of the Game program, or a server key).
    pub authority: Pubkey,
    pub studio_bps: u16,
    /// `TesoroAccount` that receives the Studio Fee.
    pub studio_recipient: Pubkey,
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
    pub games: Vec<GameEntry>,
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
}

impl Config {
    pub const SPACE: usize = Self::LEGACY_SPACE + 2 + 32 + 8 + 8 * ledger::MAX_ENTRY_SIZES;
    /// The layout before the Leaderboard fields.
    pub const LEGACY_SPACE: usize = 8 + 1 + 32 + 32 + 2 + 32 + 4 + MAX_GAMES * (32 + 32 + 2 + 32);

    pub fn game(&self, game: &Pubkey) -> Option<&GameEntry> {
        self.games.iter().find(|g| g.game == *game)
    }

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

    pub fn fee_terms(&self, g: &GameEntry) -> ledger::FeeTerms {
        ledger::FeeTerms {
            platform_bps: self.platform_bps,
            studio_bps: g.studio_bps,
            platform_recipient: self.platform_recipient.to_bytes(),
            studio_recipient: g.studio_recipient.to_bytes(),
        }
    }
}

/// A finished season: the ranking and prizes recorded by `record_season`, paid by
/// `pay_season_rank`. Seeds `["season", number as u32 LE]`.
#[account]
pub struct SeasonState {
    pub bump: u8,
    pub inner: ledger::Season,
}

impl SeasonState {
    pub const SPACE: usize = 8 + 1 + 4 + 8 + 1 + ledger::PRIZE_PLACES * (32 + 8 + 8) + 2;
}

/// The payout window of a recorded season (ADR 0012): when it was recorded and which ranks the
/// admin voided. A separate account so `SeasonState` keeps its layout. Created by
/// `record_season`; seeds `["season_window", number as u32 LE]`.
#[account]
pub struct SeasonWindowState {
    pub bump: u8,
    pub inner: ledger::SeasonWindow,
}

impl SeasonWindowState {
    pub const SPACE: usize = 8 + 1 + 4 + 8 + 2;
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
    pub inner: ledger::Account,
}

impl TesoroAccount {
    pub const SPACE: usize = 8 + 1 + 32 + 20 + 4 * 8;
}

#[account]
pub struct PositionState {
    pub bump: u8,
    pub position_id: [u8; 32],
    pub inner: Position,
}

impl PositionState {
    pub const SPACE: usize =
        8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1 + 4 + 5 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 2 + 8;
}

#[account]
pub struct SourceState {
    pub bump: u8,
    pub inner: Source,
}

impl SourceState {
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 4 + 1 + 16 + 8 + 5 * 8;
}

#[account]
pub struct HoldingState {
    pub bump: u8,
    pub account: Pubkey,
    pub inner: Holding,
}

impl HoldingState {
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 1 + 8 + 8;
}

const SIDE: usize = 32 + 32 + 2 + 4 + ledger::MAX_ENTRY_SOURCES * 40;

#[account]
pub struct MatchState {
    pub bump: u8,
    pub id: u64,
    pub inner: Match,
}

impl MatchState {
    pub const SPACE: usize = 8 + 1 + 8 + 32 + 8 + 68 + 1 + SIDE + 1 + SIDE + 8;
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
        + 4
        + ledger::MAX_ENTRY_SOURCES * 41;
}

/// The one custody of every native Position (ADR 0010): a single simSOL vault holding their
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
    /// Token account (PDA) holding the Principal of every Locked native Position.
    pub vault: Pubkey,
    /// `PoolTotals` (`ledger::yield_math`), updated only on open and unlock.
    pub principal: u128,
    pub fee_weight: u128,
    pub fee_weight_time: u128,
    pub realised_fee: u128,
    pub open_positions: u64,
}

impl NativeCustody {
    pub const SPACE: usize = 8 + 1 + 1 + 3 * 32 + 4 * 16 + 8;

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
}

impl StakeCustody {
    pub const SPACE: usize = 8 + 2 + 3 * 32 + 4 * 16 + 8 + 3 * 8;

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

    /// The Treasury's balance in tokens at `rate`: the earned Yield Fee plus what it redeemed,
    /// less what it paid out; never more than the vault holds above the Principal reserve.
    pub fn treasury_balance(&self, rate: u64, vault_amount: u64) -> Result<u64> {
        use crate::error::core_err;
        let totals = self.totals();
        let earned = totals.earned_fee_shares(rate).map_err(core_err)?;
        let claim = earned
            .saturating_add(self.refilled_shares)
            .saturating_sub(self.instant_shares)
            .saturating_sub(self.withdrawn_shares);
        let headroom =
            vault_amount.saturating_sub(totals.principal_reserve(rate).map_err(core_err)?);
        Ok(claim.min(headroom))
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
/// points). Every season standing is the sum of these events, so anyone can recompute it.
#[event]
pub struct MatchWon {
    pub match_id: u64,
    pub game: Pubkey,
    pub entry: u64,
    pub player: Pubkey,
    pub funder: Pubkey,
    pub points: u64,
    /// Gemas this Match paid into the Leaderboard Pool.
    pub pool_fee: u64,
    pub season: u32,
    pub ts: i64,
    /// The Account that played on the losing side (the opponent of `player`); all zeroes if that
    /// seat was empty. Last field, so events from before it was added are the same bytes minus
    /// these 32 and read as having no known opponent (ADR 0012).
    pub loser: Pubkey,
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

#[event]
pub struct MatchSettled {
    pub match_id: u64,
    pub result: u8,
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

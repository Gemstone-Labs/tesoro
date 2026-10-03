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
/// PDA that signs `sim_lst::mint_yield`; sim_lst records it as the one yield authority.
pub const YIELD_SEED: &[u8] = b"yield";
pub const PRICE_SEED: &[u8] = b"price";

/// simSOL mint of `sim_lst` (PDA `["mint"]` of `WgcM5G...`). A Solana Position whose
/// `source_asset` is this mint is a native Position and is only ever opened by `open_native_position`.
pub const SIM_SOL_MINT: Pubkey = pubkey!("3Q2VRPmdAZHutWNhE2Rof9Pdg6MnTMotXucmoD5cgAZJ");
/// How old the issuance price may be when an Advance is taken.
pub const MAX_PRICE_AGE_SECS: i64 = 24 * 60 * 60;
pub const SOURCE_AUTHORITY_SEED: &[u8] = b"source_auth";

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
}

impl Config {
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 2 + 32 + 4 + MAX_GAMES * (32 + 32 + 2 + 32);

    pub fn game(&self, game: &Pubkey) -> Option<&GameEntry> {
        self.games.iter().find(|g| g.game == *game)
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
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1 + 4 + 5 + 8 + 8 + 8 + 8;
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

/// Custody of one native Position: the simSOL vault and what is needed to value it.
#[account]
pub struct NativeCustody {
    pub bump: u8,
    pub vault_bump: u8,
    pub position: Pubkey,
    pub owner_authority: Pubkey,
    /// The `sim_lst` Pool (canonical PDA) whose rate values the vault.
    pub pool: Pubkey,
    pub mint: Pubkey,
    /// Token account (PDA) holding the Position's simSOL, authority = this custody.
    pub vault: Pubkey,
    /// sim_lst rate at open (1e9 fixed point, SOL per simSOL).
    pub rate_at_open: u64,
    /// simSOL deposited at open, base units. Informational: the vault balance is authoritative.
    pub deposited_shares: u64,
    /// SOL base units paid to Gema holders from the vault by `redeem`.
    pub redeemed_units: u64,
    /// Shares this custody accounts for: deposited at open minus paid out. Yield and cover are read
    /// from this, never from the vault's token balance, so simSOL sent straight to the vault is not
    /// yield (ADR 0001: Principal never pays Debt, not even by top-up). Appended after the original
    /// layout; custodies opened before it are extended by `migrate_native_custody`.
    pub tracked_shares: u64,
    /// Unix time up to which yield has been minted into the vault (per-Position yield model,
    /// docs/yield-model.md). Appended after `tracked_shares`; older custodies are extended by
    /// `migrate_native_custody`, which starts it at the migration time.
    pub last_accrual_ts: i64,
}

impl NativeCustody {
    pub const SPACE: usize = Self::TRACKED_SPACE + 8;
    /// The layout with `tracked_shares` and before `last_accrual_ts`.
    pub const TRACKED_SPACE: usize = Self::LEGACY_SPACE + 8;
    /// The layout before `tracked_shares`.
    pub const LEGACY_SPACE: usize = 8 + 1 + 1 + 5 * 32 + 3 * 8;
    /// Offsets inside the account data, after the 8-byte discriminator.
    pub const VAULT_OFFSET: usize = 8 + 2 + 4 * 32;
    pub const DEPOSITED_OFFSET: usize = 8 + 2 + 5 * 32 + 8;
    pub const TRACKED_OFFSET: usize = Self::LEGACY_SPACE;
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

/// simSOL paid out of a Position's vault.
#[event]
pub struct NativePayout {
    pub position: Pubkey,
    pub to: Pubkey,
    pub shares: u64,
    pub sol_units: u64,
    /// 0 = redeem, 1 = unlock, 2 = sweep.
    pub kind: u8,
}

#[event]
pub struct NativeCustodyMigrated {
    pub position: Pubkey,
    pub deposited_shares: u64,
    pub tracked_shares: u64,
}

#[event]
pub struct PriceSet {
    pub asset: Pubkey,
    pub price_micro_usd: u64,
}

#[event]
pub struct MatchSettled {
    pub match_id: u64,
    pub result: u8,
}

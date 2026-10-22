#![allow(clippy::too_many_arguments)]

use anchor_lang::prelude::*;

pub mod books;
pub mod error;
pub mod instructions;
#[cfg(test)]
mod keeper_fixtures;
pub mod ledger;
pub mod pots;
pub mod pyth;
pub mod registry;
pub mod state;
pub mod storage;
pub mod util;

pub use instructions::*;

declare_id!("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");

#[program]
pub mod tesoro_core {
    use super::*;

    // --- Config and Game registry -----------------------------------------------------------

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        oracle_authority: Pubkey,
        platform_bps: u16,
    ) -> Result<()> {
        instructions::admin::initialize_config(ctx, oracle_authority, platform_bps)
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        oracle_authority: Pubkey,
        platform_bps: u16,
    ) -> Result<()> {
        instructions::admin::update_config(ctx, oracle_authority, platform_bps)
    }

    pub fn set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::set_admin(ctx, new_admin)
    }

    /// Registers a Game. Signed by the control of its program (upgrade authority, or the program's
    /// `["tesoro-register"]` PDA once immutable). The Game id is the `game_program` account.
    pub fn register_game(
        ctx: Context<RegisterGame>,
        settle_authority: Pubkey,
        studio_bps: u16,
    ) -> Result<()> {
        instructions::registry::register_game(ctx, settle_authority, studio_bps)
    }

    /// Proposes new settle authority and Studio terms; they apply 7 days later.
    pub fn propose_game_change(
        ctx: Context<ChangeGame>,
        settle_authority: Pubkey,
        studio_bps: u16,
    ) -> Result<()> {
        instructions::registry::propose_game_change(ctx, settle_authority, studio_bps)
    }

    /// Returns the rent of an opener-to-joiner pair counter after its window.
    pub fn close_pair(ctx: Context<ClosePair>, opener: Pubkey, joiner: Pubkey) -> Result<()> {
        instructions::matching::close_pair(ctx, opener, joiner)
    }

    pub fn apply_game_change(ctx: Context<ApplyGameChange>) -> Result<()> {
        instructions::registry::apply_game_change(ctx)
    }

    pub fn cancel_game_change(ctx: Context<CancelGameChange>) -> Result<()> {
        instructions::registry::cancel_game_change(ctx)
    }

    /// Admin: lists a Game until a time for the build that hashes to `approved_hash` (or unlists
    /// it with 0).
    pub fn list_game(
        ctx: Context<ListGame>,
        listed_until: i64,
        approved_hash: [u8; 32],
    ) -> Result<()> {
        instructions::registry::list_game(ctx, listed_until, approved_hash)
    }

    /// Anyone: moves the approved slot forward when the program's bytes still hash to the
    /// approved build.
    pub fn refresh_listing(ctx: Context<RefreshListing>) -> Result<()> {
        instructions::registry::refresh_listing(ctx)
    }

    /// Extends a Config that predates the Leaderboard, creates the pool Account and sets the fee.
    pub fn init_leaderboard(ctx: Context<InitLeaderboard>, leaderboard_bps: u16) -> Result<()> {
        instructions::admin::init_leaderboard(ctx, leaderboard_bps)
    }

    /// Admin only: turns the Invite gate on or off and sets the key that must co-sign
    /// `create_account` while it is on.
    pub fn set_invite_gate(ctx: Context<SetInviteGate>, required: bool, key: Pubkey) -> Result<()> {
        instructions::admin::set_invite_gate(ctx, required, key)
    }

    /// Sets the entry sizes in Gemas (1 to 4, each a multiple of 100). Admin only.
    pub fn set_entry_sizes(ctx: Context<SetEntrySizes>, sizes: Vec<u64>) -> Result<()> {
        instructions::admin::set_entry_sizes(ctx, sizes)
    }

    /// Locks (mainnet) or unlocks the oracle's test-mode powers. Admin only.
    pub fn set_oracle_lock(ctx: Context<SetOracleLock>, locked: bool) -> Result<()> {
        instructions::admin::set_oracle_lock(ctx, locked)
    }

    // --- Leaderboard seasons ----------------------------------------------------------------

    pub fn record_season<'info>(
        ctx: Context<'_, '_, 'info, 'info, RecordSeason<'info>>,
        number: u32,
        points: Vec<u64>,
    ) -> Result<()> {
        instructions::season::record_season(ctx, number, points)
    }

    /// Pays one (rank, budget line) step: every rank takes the same share of every line.
    pub fn pay_season_rank<'info>(
        ctx: Context<'_, '_, 'info, 'info, PaySeasonRank<'info>>,
        rank: u8,
        line: u8,
    ) -> Result<()> {
        instructions::season::pay_season_rank(ctx, rank, line)
    }

    /// Releases what no rank took so it rolls into the next Season (anyone, once all is paid).
    pub fn close_season(ctx: Context<CloseSeason>) -> Result<()> {
        instructions::season::close_season(ctx)
    }

    // --- Economy settings, harvest, prizes (ticket 11) ---------------------------------------

    /// Admin: the Season keeper, the Instant Redeem fill keeper and its switch, and the routes a
    /// recorded Season waits for.
    pub fn set_economy(
        ctx: Context<SetEconomy>,
        season_keeper: Pubkey,
        fill_keeper: Pubkey,
        keeper_fills: bool,
        routes: [Pubkey; state::MAX_ROUTES],
    ) -> Result<()> {
        instructions::prize::set_economy(ctx, season_keeper, fill_keeper, keeper_fills, routes)
    }

    /// Admin: the Pool's share of every Yield Fee realised from a Season announced ahead.
    pub fn set_prize_share(ctx: Context<SetPrizeShare>, from_season: u32, bps: u16) -> Result<()> {
        instructions::prize::set_prize_share(ctx, from_season, bps)
    }

    /// Admin: switches a custody's prize escrow (off until the slashing fix is accepted).
    pub fn set_prize_escrow(ctx: Context<SetPrizeEscrow>, enabled: bool) -> Result<()> {
        instructions::prize::set_prize_escrow(ctx, enabled)
    }

    /// Anyone: the ready part of a Source's Leaderboard counter goes into the prize escrow.
    pub fn harvest<'info>(ctx: Context<'_, '_, 'info, 'info, Harvest<'info>>) -> Result<()> {
        instructions::prize::harvest(ctx)
    }

    /// Admin: the Account that receives the Studio Fee counters of Tesoro's own Games.
    pub fn set_tesoro_studio(ctx: Context<SetTesoroStudio>) -> Result<()> {
        instructions::fee::set_tesoro_studio(ctx)
    }

    /// Anyone: the covered Platform (0) or Studio (1) fee of a native or stake Source is paid to
    /// its recipient.
    pub fn cash_in_fee<'info>(
        ctx: Context<'_, '_, 'info, 'info, CashInFee<'info>>,
        class: u8,
    ) -> Result<()> {
        instructions::fee::cash_in_fee(ctx, class)
    }

    /// The EVM twin of `cash_in_fee`, signed by the chain's source authority (the bridge), which
    /// pays the recipient on that chain.
    pub fn cash_in_fee_from_source<'info>(
        ctx: Context<'_, '_, 'info, 'info, CashInFeeFromSource<'info>>,
        class: u8,
        min_units: u64,
    ) -> Result<()> {
        instructions::fee::cash_in_fee_from_source(ctx, class, min_units)
    }

    /// The bridge issues the Pool's prize Source for shares an EVM vault confirmed in its escrow
    /// (signed by the Season authority and the chain's source authority).
    #[allow(clippy::too_many_arguments)]
    pub fn issue_prize_from_source<'info>(
        ctx: Context<'_, '_, 'info, 'info, IssuePrizeFromSource<'info>>,
        chain: ledger::SourceChain,
        season: u32,
        route: Pubkey,
        asset: Pubkey,
        decimals: u8,
        shares: u128,
        units: u64,
        price_micro_usd: u64,
    ) -> Result<()> {
        instructions::evm_prize::issue_prize_from_source(
            ctx,
            chain,
            season,
            route,
            asset,
            decimals,
            shares,
            units,
            price_micro_usd,
        )
    }

    /// A holder's prize Redeem on an EVM route: the Gemas burn, the shares are the bridge's to pay.
    pub fn begin_prize_payout_from_source(
        ctx: Context<BeginPrizePayoutFromSource>,
        chain: ledger::SourceChain,
        amount: u64,
    ) -> Result<()> {
        instructions::evm_prize::begin_prize_payout_from_source(ctx, chain, amount)
    }

    /// The vault rejected a prize payout for good: Gemas and shares go back.
    pub fn cancel_prize_payout_from_source(
        ctx: Context<CancelPrizePayoutFromSource>,
        chain: ledger::SourceChain,
        gemas: u64,
        shares: u128,
    ) -> Result<()> {
        instructions::evm_prize::cancel_prize_payout_from_source(ctx, chain, gemas, shares)
    }

    pub fn fund_season_prize_native<'info>(
        ctx: Context<'_, '_, 'info, 'info, FundSeasonPrizeNative<'info>>,
        season: u32,
    ) -> Result<()> {
        instructions::prize::fund_season_prize_native(ctx, season)
    }

    pub fn fund_season_prize_stake<'info>(
        ctx: Context<'_, '_, 'info, 'info, FundSeasonPrizeStake<'info>>,
        season: u32,
    ) -> Result<()> {
        instructions::prize::fund_season_prize_stake(ctx, season)
    }

    pub fn redeem_prize<'info>(
        ctx: Context<'_, '_, 'info, 'info, RedeemPrize<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::prize::redeem_prize(ctx, amount)
    }

    /// Admin only, inside the 48-hour payout window: the rank pays nothing and its share stays in
    /// the pool for the next season.
    pub fn void_season_rank(ctx: Context<VoidSeasonRank>, rank: u8) -> Result<()> {
        instructions::season::void_season_rank(ctx, rank)
    }

    // --- Baskets, spills, sponsor, Source books (ticket 08) ----------------------------------

    /// Creates the basket and spill of an Account that already exists. Anyone may pay.
    pub fn init_stores(ctx: Context<InitStores>) -> Result<()> {
        instructions::basket::init_stores(ctx)
    }

    /// Admin only: creates the sponsor that pays refundable rent for Players.
    pub fn init_sponsor(
        ctx: Context<InitSponsor>,
        relayer: Pubkey,
        per_account_cap: u64,
        total_cap: u64,
        pages_cap: u64,
    ) -> Result<()> {
        instructions::basket::init_sponsor(ctx, relayer, per_account_cap, total_cap, pages_cap)
    }

    /// Admin only: the relayer key, the pause switch and the caps of the sponsor.
    pub fn set_sponsor(
        ctx: Context<SetSponsor>,
        relayer: Pubkey,
        paused: bool,
        per_account_cap: u64,
        total_cap: u64,
        pages_cap: u64,
    ) -> Result<()> {
        instructions::basket::set_sponsor(
            ctx,
            relayer,
            paused,
            per_account_cap,
            total_cap,
            pages_cap,
        )
    }

    /// Anyone grows a basket or spill with their own lamports (a gift to its owner).
    pub fn grow_store(ctx: Context<GrowStore>, which: StoreKind, extra_lines: u32) -> Result<()> {
        instructions::basket::grow_store(ctx, which, extra_lines)
    }

    /// The sponsor grows a basket or spill; needs the relayer's signature, within the caps.
    pub fn grow_store_sponsored(
        ctx: Context<GrowStoreSponsored>,
        which: StoreKind,
        extra_lines: u32,
    ) -> Result<()> {
        instructions::basket::grow_store_sponsored(ctx, which, extra_lines)
    }

    /// The owner drops free slots; the sponsor is refunded first.
    pub fn shrink_store(ctx: Context<ShrinkStore>, which: StoreKind, keep_free: u32) -> Result<()> {
        instructions::basket::shrink_store(ctx, which, keep_free)
    }

    /// Anyone moves up to `max` spill lines into the basket. Source books are remaining accounts.
    pub fn claim_spill<'info>(
        ctx: Context<'_, '_, 'info, 'info, ClaimSpill<'info>>,
        max: u8,
    ) -> Result<()> {
        instructions::basket::claim_spill(ctx, max)
    }

    /// Anyone moves up to `max` lines of an overflow record into the owner's stores; an empty
    /// record is closed and its rent goes back to its payer. Source books are remaining accounts.
    pub fn claim_overflow<'info>(
        ctx: Context<'_, '_, 'info, 'info, ClaimOverflow<'info>>,
        max: u8,
    ) -> Result<()> {
        instructions::overflow::claim_overflow(ctx, max)
    }

    /// Anyone creates the book account of a Source.
    pub fn init_source_book(ctx: Context<InitSourceBook>) -> Result<()> {
        instructions::basket::init_source_book(ctx)
    }

    /// Anyone pays for the next page of a class's checkpoint records.
    pub fn init_ckpt_page(ctx: Context<InitCkptPage>, class: u8, page_no: u32) -> Result<()> {
        instructions::basket::init_ckpt_page(ctx, class, page_no)
    }

    /// The same page, paid by the sponsor; needs the relayer's signature.
    pub fn init_ckpt_page_sponsored(
        ctx: Context<InitCkptPageSponsored>,
        class: u8,
        page_no: u32,
    ) -> Result<()> {
        instructions::basket::init_ckpt_page_sponsored(ctx, class, page_no)
    }

    // --- Accounts --------------------------------------------------------------

    pub fn create_account(ctx: Context<CreateAccount>, evm_address: [u8; 20]) -> Result<()> {
        instructions::identity::create_account(ctx, evm_address)
    }

    pub fn set_evm_address(ctx: Context<SetEvmAddress>, evm_address: [u8; 20]) -> Result<()> {
        instructions::identity::set_evm_address(ctx, evm_address)
    }

    pub fn set_profile(
        ctx: Context<SetProfile>,
        name: String,
        avatar: state::AvatarChoice,
    ) -> Result<()> {
        instructions::identity::set_profile(ctx, name, avatar)
    }

    pub fn set_name_wallet(ctx: Context<SetNameWallet>) -> Result<()> {
        instructions::identity::set_name_wallet(ctx)
    }

    pub fn set_name_evm(ctx: Context<SetNameEvm>, evm_address: [u8; 20]) -> Result<()> {
        instructions::identity::set_name_evm(ctx, evm_address)
    }

    // --- Positions, Advances, Debt, Redeem --------------------------------------------------

    pub fn open_position(
        ctx: Context<OpenPosition>,
        source_chain: ledger::SourceChain,
        position_id: [u8; 32],
        source_asset: Pubkey,
        decimals: u8,
        principal: u64,
        rate_bps: u16,
    ) -> Result<()> {
        instructions::position::open_position(
            ctx,
            source_chain,
            position_id,
            source_asset,
            decimals,
            principal,
            rate_bps,
        )
    }

    pub fn take_advance<'info>(
        ctx: Context<'_, '_, 'info, 'info, TakeAdvance<'info>>,
        horizon_months: u8,
        price_micro_usd: u64,
        min_gemas: u64,
    ) -> Result<()> {
        instructions::position::take_advance(ctx, horizon_months, price_micro_usd, min_gemas)
    }

    pub fn apply_yield<'info>(
        ctx: Context<'_, '_, 'info, 'info, ApplyYield<'info>>,
        seq: u64,
        cumulative: u64,
    ) -> Result<()> {
        instructions::position::apply_yield(ctx, seq, cumulative)
    }

    /// Returns `amount` of the owner's own Gemas of one line of the Source.
    pub fn return_own<'info>(
        ctx: Context<'_, '_, 'info, 'info, ReturnOwn<'info>>,
        line: LineRef,
        amount: u64,
    ) -> Result<()> {
        instructions::position::return_own(ctx, line, amount)
    }

    /// Redeems `amount` repaid Gemas of one line; pays the shares their yield was worth.
    pub fn redeem<'info>(
        ctx: Context<'_, '_, 'info, 'info, Redeem<'info>>,
        line: LineRef,
        amount: u64,
    ) -> Result<()> {
        instructions::position::redeem(ctx, line, amount)
    }

    pub fn claim_free_yield(ctx: Context<ClaimFreeYield>, amount: u64) -> Result<()> {
        instructions::position::claim_free_yield(ctx, amount)
    }

    pub fn unlock<'info>(ctx: Context<'_, '_, 'info, 'info, Unlock<'info>>) -> Result<()> {
        instructions::position::unlock(ctx)
    }

    // --- Solana-native Positions (shared simSOL custody, yield computed) ----------------------

    pub fn set_price(ctx: Context<SetPrice>, price_micro_usd: u64) -> Result<()> {
        instructions::native::set_price(ctx, price_micro_usd)
    }

    pub fn open_native_position(
        ctx: Context<OpenNativePosition>,
        nonce: u64,
        lst_amount: u64,
    ) -> Result<()> {
        instructions::native::open_native_position(ctx, nonce, lst_amount)
    }

    pub fn take_native_advance<'info>(
        ctx: Context<'_, '_, 'info, 'info, TakeNativeAdvance<'info>>,
        horizon_months: u8,
        min_gemas: u64,
    ) -> Result<()> {
        instructions::native::take_native_advance(ctx, horizon_months, min_gemas)
    }

    /// Admin: where an asset's Advances read their USD price on mainnet (a Pyth push feed).
    pub fn set_onchain_price(
        ctx: Context<SetOnchainPrice>,
        asset: Pubkey,
        feed_id: [u8; 32],
        max_age_secs: u32,
        max_conf_bps: u16,
    ) -> Result<()> {
        instructions::onchain_price::set_onchain_price(
            ctx,
            asset,
            feed_id,
            max_age_secs,
            max_conf_bps,
        )
    }

    /// `take_native_advance` priced from the asset's Pyth feed instead of the keeper's price.
    pub fn take_native_advance_onchain<'info>(
        ctx: Context<'_, '_, 'info, 'info, TakeNativeAdvanceOnchain<'info>>,
        horizon_months: u8,
        min_gemas: u64,
    ) -> Result<()> {
        instructions::onchain_price::take_native_advance_onchain(ctx, horizon_months, min_gemas)
    }

    /// `take_advance` priced from the asset's Pyth feed instead of a price the oracle names.
    pub fn take_advance_onchain<'info>(
        ctx: Context<'_, '_, 'info, 'info, TakeAdvanceOnchain<'info>>,
        horizon_months: u8,
        min_gemas: u64,
    ) -> Result<()> {
        instructions::onchain_price::take_advance_onchain(ctx, horizon_months, min_gemas)
    }

    pub fn extend_native_advance<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExtendNativeAdvance<'info>>,
        extra_months: u8,
        min_gemas: u64,
    ) -> Result<()> {
        instructions::native::extend_native_advance(ctx, extra_months, min_gemas)
    }

    pub fn set_extend_limit(ctx: Context<SetExtendLimit>, months: u8) -> Result<()> {
        instructions::native::set_extend_limit(ctx, months)
    }

    pub fn set_entry_limit(ctx: Context<SetEntryLimit>, gemas: u64) -> Result<()> {
        instructions::native::set_entry_limit(ctx, gemas)
    }

    pub fn set_break(ctx: Context<SetProtection>, days: u16) -> Result<()> {
        instructions::native::set_break(ctx, days)
    }

    pub fn set_self_exclusion(ctx: Context<SetProtection>, months: u16) -> Result<()> {
        instructions::native::set_self_exclusion(ctx, months)
    }

    /// Creates the shared native custody (vault + pool totals). Admin only, once.
    pub fn init_native_custody(ctx: Context<InitNativeCustody>) -> Result<()> {
        instructions::native::init_native_custody(ctx)
    }

    // --- Mainnet SOL Positions on a real staking token (ADR 0011) -----------------------------

    /// Admin: the staking token new SOL Positions open with (creates its custody and vault the
    /// first time). The stake pool account pins the token's Staking Rate source.
    pub fn set_stake_token(ctx: Context<SetStakeToken>) -> Result<()> {
        instructions::stake::set_stake_token(ctx)
    }

    /// Admin: the ceiling on the annualised growth an Advance is sized on, in basis points.
    pub fn set_stake_apy_ceiling(
        ctx: Context<SetStakeApyCeiling>,
        apy_ceiling_bps: u16,
    ) -> Result<()> {
        instructions::stake::set_stake_apy_ceiling(ctx, apy_ceiling_bps)
    }

    /// Deposits `shares` of the active staking token into the shared vault as a new Position.
    pub fn open_stake_position(
        ctx: Context<OpenStakePosition>,
        nonce: u64,
        shares: u64,
    ) -> Result<()> {
        instructions::stake::open_stake_position(ctx, nonce, shares)
    }

    /// An Advance against a stake Position: Pyth price, sized on the pool's recent growth.
    pub fn take_stake_advance<'info>(
        ctx: Context<'_, '_, 'info, 'info, TakeStakeAdvance<'info>>,
        horizon_months: u8,
        min_gemas: u64,
    ) -> Result<()> {
        instructions::stake::take_stake_advance(ctx, horizon_months, min_gemas)
    }

    pub fn extend_stake_advance<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExtendStakeAdvance<'info>>,
        extra_months: u8,
        min_gemas: u64,
    ) -> Result<()> {
        instructions::stake::extend_stake_advance(ctx, extra_months, min_gemas)
    }

    /// Admin: tops up the Treasury with `shares` of the staking token (its own funding).
    pub fn fund_treasury_stake(ctx: Context<FundTreasuryStake>, shares: u64) -> Result<()> {
        instructions::stake::fund_treasury_stake(ctx, shares)
    }

    /// Admin: withdraws the Treasury's spendable shares, in the token, to the company wallet.
    pub fn withdraw_treasury_stake(ctx: Context<WithdrawTreasuryStake>, amount: u64) -> Result<()> {
        instructions::stake::withdraw_treasury_stake(ctx, amount)
    }

    /// Creates the Treasury without a simSOL vault (a deployment without `sim_lst`) or changes
    /// its fee rates.
    pub fn init_treasury_stake(
        ctx: Context<InitTreasuryStake>,
        yield_fee_bps: u16,
        instant_fee_bps: u16,
    ) -> Result<()> {
        instructions::stake::init_treasury_stake(ctx, yield_fee_bps, instant_fee_bps)
    }

    // --- Treasury: Yield Fee and Instant Redeem (ADR 0007) ----------------------------------

    /// Creates the Treasury (config, Treasury Account, simSOL vault) or changes its fee rates.
    pub fn init_treasury(
        ctx: Context<InitTreasury>,
        yield_fee_bps: u16,
        instant_fee_bps: u16,
    ) -> Result<()> {
        instructions::treasury::init_treasury(ctx, yield_fee_bps, instant_fee_bps)
    }

    pub fn fund_treasury(ctx: Context<FundTreasury>, shares: u64) -> Result<()> {
        instructions::treasury::fund_treasury(ctx, shares)
    }

    /// Sets the company wallet that `withdraw_treasury` pays (admin).
    pub fn set_treasury_company(ctx: Context<SetTreasuryCompany>, company: Pubkey) -> Result<()> {
        instructions::treasury::set_treasury_company(ctx, company)
    }

    /// Withdraws `amount` SOL units of the Treasury balance to the company wallet (admin).
    pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
        instructions::treasury::withdraw_treasury(ctx, amount)
    }

    /// The Treasury Account redeems Gemas it bought (an Instant Redeem fill); anyone may call it.
    pub fn redeem_treasury<'info>(
        ctx: Context<'_, '_, 'info, 'info, RedeemTreasury<'info>>,
        line: LineRef,
        amount: u64,
    ) -> Result<()> {
        instructions::treasury::redeem_treasury(ctx, line, amount)
    }

    pub fn redeem_treasury_from_source<'info>(
        ctx: Context<'_, '_, 'info, 'info, RedeemTreasuryFromSource<'info>>,
        line: LineRef,
        amount: u64,
    ) -> Result<()> {
        instructions::treasury::redeem_treasury_from_source(ctx, line, amount)
    }

    // --- Instant Redeem orders ---------------------------------------------------------------

    /// Puts won Gemas into an order Tesoro fills; the repaid part is Redeemed at full value.
    pub fn request_instant_redeem<'info>(
        ctx: Context<'_, '_, 'info, 'info, RequestInstantRedeem<'info>>,
        line: LineRef,
        sell: u64,
        ttl_secs: i64,
        nonce: u64,
    ) -> Result<()> {
        instructions::instant::request_instant_redeem(ctx, line, sell, ttl_secs, nonce)
    }

    /// The fill authority buys all or part of an order at 75% of the value at fill.
    pub fn fill_instant_redeem<'info>(
        ctx: Context<'_, '_, 'info, 'info, FillInstantRedeem<'info>>,
        gemas: u64,
    ) -> Result<()> {
        instructions::instant::fill_instant_redeem(ctx, gemas)
    }

    /// The bridge fills an order of an EVM-sourced Source against the vault's mirrored budget.
    pub fn fill_instant_redeem_from_source<'info>(
        ctx: Context<'_, '_, 'info, 'info, FillInstantRedeemFromSource<'info>>,
        gemas: u64,
        available_shares: u64,
    ) -> Result<u64> {
        instructions::instant::fill_instant_redeem_from_source(ctx, gemas, available_shares)
    }

    /// The seller takes the unsold Gemas back, any time before they are sold.
    pub fn cancel_instant_redeem<'info>(
        ctx: Context<'_, '_, 'info, 'info, ReturnInstantRedeem<'info>>,
    ) -> Result<()> {
        instructions::instant::cancel_instant_redeem(ctx)
    }

    /// Anyone returns the unsold Gemas of an expired order to its seller.
    pub fn expire_instant_redeem<'info>(
        ctx: Context<'_, '_, 'info, 'info, ReturnInstantRedeem<'info>>,
    ) -> Result<()> {
        instructions::instant::expire_instant_redeem(ctx)
    }

    // --- Source authorities (cross-chain bridge) --------------------------------------------

    pub fn set_source_authority(
        ctx: Context<SetSourceAuthority>,
        chain: ledger::SourceChain,
        authority: Pubkey,
    ) -> Result<()> {
        instructions::source_auth::set_source_authority(ctx, chain, authority)
    }

    pub fn remove_source_authority(
        ctx: Context<RemoveSourceAuthority>,
        chain: ledger::SourceChain,
    ) -> Result<()> {
        instructions::source_auth::remove_source_authority(ctx, chain)
    }

    pub fn open_position_from_source(
        ctx: Context<OpenPositionFromSource>,
        source_chain: ledger::SourceChain,
        position_id: [u8; 32],
        source_asset: Pubkey,
        decimals: u8,
        principal: u64,
        rate_bps: u16,
    ) -> Result<()> {
        instructions::source_auth::open_position_from_source(
            ctx,
            source_chain,
            position_id,
            source_asset,
            decimals,
            principal,
            rate_bps,
        )
    }

    pub fn apply_yield_from_source<'info>(
        ctx: Context<'_, '_, 'info, 'info, ApplyYieldFromSource<'info>>,
        seq: u64,
        cumulative: u64,
    ) -> Result<()> {
        instructions::source_auth::apply_yield_from_source(ctx, seq, cumulative)
    }

    pub fn redeem_from_source<'info>(
        ctx: Context<'_, '_, 'info, 'info, RedeemFromSource<'info>>,
        line: LineRef,
        amount: u64,
    ) -> Result<()> {
        instructions::source_auth::redeem_from_source(ctx, line, amount)
    }

    // --- Matches ----------------------------------------------------------------------------

    /// Opens a Match for `game` at `entry`. `n` is the opener's next Match id; `pot` is a fresh
    /// address (the entry is drawn here, into a new account of `pot_lines` lines at
    /// `["ticket", funder, pot_nonce]`) or a complete Entry Ticket. With an accepted Offer in the
    /// optional accounts, the Backer's Gemas fund the entry. `challenge` and `asset` are carried
    /// in the Match record, since the id no longer encodes them.
    #[allow(clippy::too_many_arguments)]
    pub fn open_match<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenMatch<'info>>,
        game: Pubkey,
        entry: u64,
        n: u64,
        pot_nonce: u64,
        challenge: bool,
        asset: u8,
        pot_lines: u32,
    ) -> Result<()> {
        instructions::matching::open_match(
            ctx, game, entry, n, pot_nonce, challenge, asset, pot_lines,
        )
    }

    /// Joins an Open Match with an equal entry (backed with an accepted Offer in the optional
    /// accounts).
    pub fn join_match<'info>(
        ctx: Context<'_, '_, 'info, 'info, JoinMatch<'info>>,
        pot_nonce: u64,
        pot_lines: u32,
    ) -> Result<()> {
        instructions::matching::join_match(ctx, pot_nonce, pot_lines)
    }

    /// Starts settling an Active Match (Game authority): freezes the outcome and the fees, writes
    /// the receipt, emits the records. The payouts follow in `match_chunk`.
    pub fn settle_match(ctx: Context<SettleMatch>, result: MatchResult) -> Result<()> {
        instructions::matching::settle_match(ctx, result)
    }

    /// Starts refunding an Open or Active Match; the chunks follow.
    pub fn refund_match(ctx: Context<RefundMatch>) -> Result<()> {
        instructions::matching::refund_match(ctx)
    }

    /// Runs up to `max_steps` steps of a Settling or Refunding Match (anyone).
    pub fn match_chunk<'info>(
        ctx: Context<'_, '_, 'info, 'info, MatchChunk<'info>>,
        max_steps: u8,
    ) -> Result<()> {
        instructions::matching::match_chunk(ctx, max_steps)
    }

    /// Closes a finished Match and returns the rents.
    pub fn close_match<'info>(ctx: Context<'_, '_, 'info, 'info, CloseMatch<'info>>) -> Result<()> {
        instructions::matching::close_match(ctx)
    }

    pub fn close_receipt(ctx: Context<CloseReceipt>) -> Result<()> {
        instructions::matching::close_receipt(ctx)
    }

    pub fn extend_match_deadline(
        ctx: Context<ExtendMatchDeadline>,
        new_deadline: i64,
    ) -> Result<()> {
        instructions::matching::extend_match_deadline(ctx, new_deadline)
    }

    // --- Tickets ---------------------------------------------------------------------------

    pub fn open_ticket(
        ctx: Context<OpenTicket>,
        nonce: u64,
        kind: TicketKindArg,
        game: Pubkey,
        target: u64,
        lines: u32,
    ) -> Result<()> {
        instructions::ticket::open_ticket(ctx, nonce, kind, game, target, lines)
    }

    pub fn grow_ticket(ctx: Context<GrowTicket>, extra_lines: u32) -> Result<()> {
        instructions::ticket::grow_ticket(ctx, extra_lines)
    }

    pub fn stage_entry<'info>(
        ctx: Context<'_, '_, 'info, 'info, StageEntry<'info>>,
        max_ops: u8,
    ) -> Result<()> {
        instructions::ticket::stage_entry(ctx, max_ops)
    }

    pub fn cancel_ticket<'info>(
        ctx: Context<'_, '_, 'info, 'info, CancelTicket<'info>>,
        max_lines: u8,
    ) -> Result<()> {
        instructions::ticket::cancel_ticket(ctx, max_lines)
    }

    pub fn close_ticket(ctx: Context<CloseTicket>) -> Result<()> {
        instructions::ticket::close_ticket(ctx)
    }

    // --- Backing ----------------------------------------------------------------------------

    pub fn create_request(
        ctx: Context<CreateRequest>,
        nonce: u64,
        game: Pubkey,
        entry: u64,
    ) -> Result<()> {
        instructions::backing::create_request(ctx, nonce, game, entry)
    }

    pub fn cancel_request(ctx: Context<CancelRequest>) -> Result<()> {
        instructions::backing::cancel_request(ctx)
    }

    pub fn create_offer(
        ctx: Context<CreateOffer>,
        nonce: u64,
        game: Pubkey,
        entry: u64,
        player_share_bps: u16,
        directed_request: Option<Pubkey>,
    ) -> Result<()> {
        instructions::backing::create_offer(
            ctx,
            nonce,
            game,
            entry,
            player_share_bps,
            directed_request,
        )
    }

    pub fn clear_request(ctx: Context<ClearRequest>) -> Result<()> {
        instructions::backing::clear_request(ctx)
    }

    pub fn accept_directed(ctx: Context<AcceptDirected>) -> Result<()> {
        instructions::backing::accept_directed(ctx)
    }

    pub fn apply_offer(ctx: Context<ApplyOffer>) -> Result<()> {
        instructions::backing::apply_offer(ctx)
    }

    pub fn accept_applicant(ctx: Context<AcceptApplicant>) -> Result<()> {
        instructions::backing::accept_applicant(ctx)
    }

    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        instructions::backing::cancel_offer(ctx)
    }

    pub fn expire_offer(ctx: Context<ExpireOffer>) -> Result<()> {
        instructions::backing::expire_offer(ctx)
    }

    // --- Reset: retiring the old world (admin only, ticket 11) -------------------------------

    /// Returns an old per-Position vault's simSOL to the Position owner and closes vault and custody.
    pub fn retire_native_custody(ctx: Context<RetireNativeCustody>) -> Result<()> {
        instructions::retire::retire_native_custody(ctx)
    }

    pub fn retire_position(ctx: Context<RetirePosition>) -> Result<()> {
        instructions::retire::retire_position(ctx)
    }

    pub fn retire_source(ctx: Context<RetireSource>) -> Result<()> {
        instructions::retire::retire_source(ctx)
    }

    pub fn retire_holding(ctx: Context<RetireHolding>) -> Result<()> {
        instructions::retire::retire_holding(ctx)
    }

    pub fn retire_request(ctx: Context<RetireRequest>) -> Result<()> {
        instructions::retire::retire_request(ctx)
    }

    pub fn retire_offer<'info>(
        ctx: Context<'_, '_, 'info, 'info, RetireOffer<'info>>,
    ) -> Result<()> {
        instructions::retire::retire_offer(ctx)
    }

    pub fn retire_treasury(ctx: Context<RetireTreasury>) -> Result<()> {
        instructions::retire::retire_treasury(ctx)
    }
}

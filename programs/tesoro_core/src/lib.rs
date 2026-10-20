use anchor_lang::prelude::*;

pub mod books;
pub mod error;
pub mod instructions;
pub mod ledger;
pub mod pyth;
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

    pub fn register_game(
        ctx: Context<RegisterGame>,
        game: Pubkey,
        authority: Pubkey,
        studio_bps: u16,
    ) -> Result<()> {
        instructions::admin::register_game(ctx, game, authority, studio_bps)
    }

    pub fn remove_game(ctx: Context<RemoveGame>, game: Pubkey) -> Result<()> {
        instructions::admin::remove_game(ctx, game)
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

    pub fn pay_season_rank<'info>(
        ctx: Context<'_, '_, 'info, 'info, PaySeasonRank<'info>>,
        rank: u8,
    ) -> Result<()> {
        instructions::season::pay_season_rank(ctx, rank)
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

    // --- Accounts and Holdings --------------------------------------------------------------

    pub fn create_account(ctx: Context<CreateAccount>, evm_address: [u8; 20]) -> Result<()> {
        instructions::identity::create_account(ctx, evm_address)
    }

    pub fn set_evm_address(ctx: Context<SetEvmAddress>, evm_address: [u8; 20]) -> Result<()> {
        instructions::identity::set_evm_address(ctx, evm_address)
    }

    pub fn open_holding(ctx: Context<OpenHolding>) -> Result<()> {
        instructions::identity::open_holding(ctx)
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

    pub fn take_advance(
        ctx: Context<TakeAdvance>,
        horizon_months: u8,
        price_micro_usd: u64,
    ) -> Result<()> {
        instructions::position::take_advance(ctx, horizon_months, price_micro_usd)
    }

    pub fn apply_yield(ctx: Context<ApplyYield>, seq: u64, cumulative: u64) -> Result<()> {
        instructions::position::apply_yield(ctx, seq, cumulative)
    }

    pub fn return_own<'info>(
        ctx: Context<'_, '_, 'info, 'info, ReturnOwn<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::position::return_own(ctx, amount)
    }

    pub fn redeem<'info>(
        ctx: Context<'_, '_, 'info, 'info, Redeem<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::position::redeem(ctx, amount)
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

    pub fn take_native_advance(ctx: Context<TakeNativeAdvance>, horizon_months: u8) -> Result<()> {
        instructions::native::take_native_advance(ctx, horizon_months)
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
    pub fn take_native_advance_onchain(
        ctx: Context<TakeNativeAdvanceOnchain>,
        horizon_months: u8,
    ) -> Result<()> {
        instructions::onchain_price::take_native_advance_onchain(ctx, horizon_months)
    }

    /// `take_advance` priced from the asset's Pyth feed instead of a price the oracle names.
    pub fn take_advance_onchain(
        ctx: Context<TakeAdvanceOnchain>,
        horizon_months: u8,
    ) -> Result<()> {
        instructions::onchain_price::take_advance_onchain(ctx, horizon_months)
    }

    pub fn extend_native_advance(
        ctx: Context<ExtendNativeAdvance>,
        extra_months: u8,
    ) -> Result<()> {
        instructions::native::extend_native_advance(ctx, extra_months)
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
    pub fn take_stake_advance(ctx: Context<TakeStakeAdvance>, horizon_months: u8) -> Result<()> {
        instructions::stake::take_stake_advance(ctx, horizon_months)
    }

    pub fn extend_stake_advance(ctx: Context<ExtendStakeAdvance>, extra_months: u8) -> Result<()> {
        instructions::stake::extend_stake_advance(ctx, extra_months)
    }

    /// Instant Redeem of won Gemas of a stake Source, paid in the token from the Treasury balance.
    pub fn instant_redeem_stake(ctx: Context<InstantRedeemStake>, amount: u64) -> Result<()> {
        instructions::stake::instant_redeem_stake(ctx, amount)
    }

    /// Admin: withdraws Treasury balance, in the token, to the company wallet.
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

    pub fn instant_redeem(ctx: Context<InstantRedeem>, amount: u64) -> Result<()> {
        instructions::treasury::instant_redeem(ctx, amount)
    }

    pub fn instant_redeem_from_source(
        ctx: Context<InstantRedeemFromSource>,
        amount: u64,
    ) -> Result<u64> {
        instructions::treasury::instant_redeem_from_source(ctx, amount)
    }

    pub fn redeem_treasury<'info>(
        ctx: Context<'_, '_, 'info, 'info, RedeemTreasury<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::treasury::redeem_treasury(ctx, amount)
    }

    pub fn redeem_treasury_from_source(
        ctx: Context<RedeemTreasuryFromSource>,
        amount: u64,
    ) -> Result<()> {
        instructions::treasury::redeem_treasury_from_source(ctx, amount)
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

    pub fn apply_yield_from_source(
        ctx: Context<ApplyYieldFromSource>,
        seq: u64,
        cumulative: u64,
    ) -> Result<()> {
        instructions::source_auth::apply_yield_from_source(ctx, seq, cumulative)
    }

    pub fn redeem_from_source(ctx: Context<RedeemFromSource>, amount: u64) -> Result<()> {
        instructions::source_auth::redeem_from_source(ctx, amount)
    }

    // --- Matches ----------------------------------------------------------------------------

    pub fn open_match<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenMatch<'info>>,
        match_id: u64,
        game: Pubkey,
        entry: u64,
    ) -> Result<()> {
        instructions::matching::open_match(ctx, match_id, game, entry)
    }

    pub fn join_match<'info>(ctx: Context<'_, '_, 'info, 'info, JoinMatch<'info>>) -> Result<()> {
        instructions::matching::join_match(ctx)
    }

    pub fn open_match_backed<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenMatchBacked<'info>>,
        match_id: u64,
        game: Pubkey,
        entry: u64,
    ) -> Result<()> {
        instructions::matching::open_match_backed(ctx, match_id, game, entry)
    }

    pub fn join_match_backed<'info>(
        ctx: Context<'_, '_, 'info, 'info, JoinMatchBacked<'info>>,
    ) -> Result<()> {
        instructions::matching::join_match_backed(ctx)
    }

    pub fn settle_match<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleMatch<'info>>,
        result: MatchResult,
    ) -> Result<()> {
        instructions::matching::settle_match(ctx, result)
    }

    pub fn extend_match_deadline(
        ctx: Context<ExtendMatchDeadline>,
        new_deadline: i64,
    ) -> Result<()> {
        instructions::matching::extend_match_deadline(ctx, new_deadline)
    }

    pub fn refund_match<'info>(
        ctx: Context<'_, '_, 'info, 'info, RefundMatch<'info>>,
    ) -> Result<()> {
        instructions::matching::refund_match(ctx)
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

    pub fn create_offer<'info>(
        ctx: Context<'_, '_, 'info, 'info, CreateOffer<'info>>,
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

    pub fn cancel_offer<'info>(
        ctx: Context<'_, '_, 'info, 'info, CancelOffer<'info>>,
    ) -> Result<()> {
        instructions::backing::cancel_offer(ctx)
    }

    pub fn expire_offer<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExpireOffer<'info>>,
    ) -> Result<()> {
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

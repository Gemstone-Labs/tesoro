use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod ledger;
pub mod state;
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

    pub fn return_own(ctx: Context<ReturnOwn>, amount: u64) -> Result<()> {
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

    // --- Solana-native Positions (simSOL custody, permissionless yield) ----------------------

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

    pub fn accrue_native_yield(ctx: Context<AccrueNativeYield>) -> Result<()> {
        instructions::native::accrue_native_yield(ctx)
    }

    pub fn sweep_native_surplus(ctx: Context<SweepNativeSurplus>) -> Result<()> {
        instructions::native::sweep_native_surplus(ctx)
    }

    /// Extends a custody opened before `tracked_shares` existed. Permissionless.
    pub fn migrate_native_custody(ctx: Context<MigrateNativeCustody>) -> Result<()> {
        instructions::native::migrate_native_custody(ctx)
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
}

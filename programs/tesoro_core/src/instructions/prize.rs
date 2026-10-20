//! The Yield Fee's Pool half and the Season prize (spec "Ledger: Leaderboard Pool, prizes,
//! Season", ticket 06 on chain).
//!
//! * `set_economy` / `set_prize_share` / `set_prize_escrow`: who runs Seasons and fills Instant
//!   Redeem orders (explicit settings, never the oracle), the Pool's share of every realised Yield
//!   Fee (from a Season announced ahead), and the prize escrow switch (off until the treasury
//!   slashing fix is accepted).
//! * `harvest` (anyone): moves the ready part of a Source's Leaderboard counter into the route's
//!   prize escrow, as shares.
//! * `fund_season_prize_native` / `_stake` (admin or Season keeper, once per ended Season per
//!   route): moves `pool_owed` into the escrow when the Treasury can afford it, and issues one
//!   prize Source (`kind = Prize`) for every escrowed share that has no Gemas yet, credited to the
//!   Pool's basket.
//! * `redeem_prize` (any holder): prize Gemas pay the shares held for them in the escrow, at once.
//! * `record_season`, `pay_season_rank`, `void_season_rank`, `close_season` (see `season.rs`).
//!
//! The escrow is an accounting bucket inside the custody's route (`RouteLedger`): its shares stay
//! in the custody vault, which holds the open Positions' custody plus `route.treasury_shares` plus
//! `route.escrow_total()`. Only prize Redeem takes shares out of it.

use crate::books::OnchainBooks;
use crate::error::{core_err, TesoroError};
use crate::instructions::economy::*;
use crate::instructions::position::chain_byte;
use crate::ledger::draw::{Bytes, SourceBooks};
use crate::ledger::line_store::{Line, LineKey, CLASS_GENERAL, CLASS_LEADERBOARD, SIDE_WON};
use crate::ledger::{
    self, CoreError, PoolShare, PrizeSource, RouteLedger, ShareRate, SourceKind,
};
use crate::state::*;
use crate::storage::*;
use crate::util::now;
use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use sim_lst::Pool as SimPool;

// --- Settings ----------------------------------------------------------------------------------

/// Admin: who runs Seasons and fills Instant Redeem orders, and which custodies a recorded Season
/// waits for. Creates the settings (Pool share 50% of the Yield Fee, keeper fills off) the first
/// time.
#[derive(Accounts)]
pub struct SetEconomy<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = EconomyConfig::SPACE,
        seeds = [ECONOMY_SEED],
        bump
    )]
    pub economy: Account<'info, EconomyConfig>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_economy(
    ctx: Context<SetEconomy>,
    season_keeper: Pubkey,
    fill_keeper: Pubkey,
    keeper_fills: bool,
    routes: [Pubkey; MAX_ROUTES],
) -> Result<()> {
    let e = &mut ctx.accounts.economy;
    if e.bump == 0 {
        e.bump = ctx.bumps.economy;
        e.pool_share = PoolShare::default();
    }
    e.season_keeper = season_keeper;
    e.fill_keeper = fill_keeper;
    e.keeper_fills = keeper_fills;
    e.routes = routes;
    Ok(())
}

/// Admin: the Pool's share of every Yield Fee realised from `from_season` on. A full Season of
/// notice at the least, so nobody can front-run it.
#[derive(Accounts)]
pub struct SetPrizeShare<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [ECONOMY_SEED], bump = economy.bump)]
    pub economy: Account<'info, EconomyConfig>,
}

pub(crate) fn set_prize_share(ctx: Context<SetPrizeShare>, from_season: u32, bps: u16) -> Result<()> {
    ctx.accounts
        .economy
        .pool_share
        .set(now()?, from_season, bps)
        .map_err(core_err)
}

/// Admin: switches a custody's prize escrow on or off. It ships off until the slashing fix lands:
/// while off, `harvest` and `fund_season_prize` are refused and `record_season` does not wait for
/// the route.
#[derive(Accounts)]
pub struct SetPrizeEscrow<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: a `NativeCustody` or a `StakeCustody` of this program, decoded by its discriminator.
    #[account(mut, owner = crate::ID)]
    pub custody: UncheckedAccount<'info>,
}

pub(crate) fn set_prize_escrow(ctx: Context<SetPrizeEscrow>, enabled: bool) -> Result<()> {
    let info = ctx.accounts.custody.to_account_info();
    match CustodyType::of(&info)? {
        CustodyType::Native => {
            let mut data = info.try_borrow_mut_data()?;
            let mut c = NativeCustody::try_deserialize(&mut &data[..])?;
            c.route.set_escrow_enabled(enabled);
            c.try_serialize(&mut &mut data[..])?;
        }
        CustodyType::Stake => {
            let mut data = info.try_borrow_mut_data()?;
            let mut c = StakeCustody::try_deserialize(&mut &data[..])?;
            c.route.set_escrow_enabled(enabled);
            c.try_serialize(&mut &mut data[..])?;
        }
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CustodyType {
    Native,
    Stake,
}

impl CustodyType {
    pub fn of(info: &AccountInfo) -> Result<Self> {
        use anchor_lang::Discriminator;
        require!(info.owner == &crate::ID, TesoroError::InvalidAccount);
        let data = info.try_borrow_data()?;
        let disc = data.get(..8).unwrap_or(&[]);
        if disc == NativeCustody::DISCRIMINATOR {
            Ok(Self::Native)
        } else if disc == StakeCustody::DISCRIMINATOR {
            Ok(Self::Stake)
        } else {
            err!(TesoroError::InvalidAccount)
        }
    }
}

/// The route of a custody account, read without writing. The account is owned by this program
/// and has a custody's discriminator, which only the custody-creating instructions write.
pub(crate) fn route_of(info: &AccountInfo) -> Result<RouteLedger> {
    let data = info.try_borrow_data()?;
    match CustodyType::of(info)? {
        CustodyType::Native => Ok(NativeCustody::try_deserialize(&mut &data[..])?.route),
        CustodyType::Stake => Ok(StakeCustody::try_deserialize(&mut &data[..])?.route),
    }
}

// --- Pool lines --------------------------------------------------------------------------------

/// Takes exactly `amount` of the prize line `key` out of `pool`.
pub(crate) fn take_exact<B: Bytes, S: Bytes>(
    pool: &mut ledger::draw::Pool<B, S>,
    key: &LineKey,
    amount: u64,
) -> Result<Line> {
    let (at, idx, mut line) =
        find_line(pool, key).ok_or_else(|| core_err(CoreError::HoldingMismatch))?;
    if amount > line.amount {
        return Err(core_err(CoreError::InsufficientGemas));
    }
    let mut taken = line;
    taken.amount = amount;
    line.amount -= amount;
    store_line(pool, at, idx, &line)?;
    Ok(taken)
}

/// Credits a prize line: prize Gemas are fully covered lines with no book, so equal keys merge
/// without touching one. `SpillFull` when neither the basket nor the spill has room.
pub(crate) fn put_prize<B: Bytes, S: Bytes>(
    pool: &mut ledger::draw::Pool<B, S>,
    line: &Line,
) -> Result<()> {
    let key = line.key();
    if pool.basket.find(&key).is_ok() {
        return pool.basket.merge(line).map(drop).map_err(store_err);
    }
    if pool.basket.len() < pool.basket.capacity() {
        return pool.basket.insert(line).map(drop).map_err(store_err);
    }
    if pool.spill.find(&key).is_ok() {
        return pool.spill.merge(line).map(drop).map_err(store_err);
    }
    if pool.spill.len() < pool.spill.capacity() {
        return pool.spill.insert(line).map(drop).map_err(store_err);
    }
    Err(core_err(CoreError::SpillFull))
}

/// The key of a prize Source's line in any basket: won, due at once, General.
pub fn prize_line_key(source: &Pubkey) -> LineKey {
    LineKey {
        side: SIDE_WON,
        due_at: 0,
        source: source.to_bytes(),
        class: CLASS_GENERAL,
        tranche: 0,
    }
}

/// Checks that a loaded `PrizeSourceState` sits at the PDA its own fields name.
pub(crate) fn check_prize_source(ps: &PrizeSourceState, key: &Pubkey) -> Result<()> {
    let expected = Pubkey::create_program_address(
        &[
            PRIZE_SOURCE_SEED,
            ps.route.as_ref(),
            &ps.season.to_le_bytes(),
            &[ps.bump],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(TesoroError::InvalidAccount))?;
    require_keys_eq!(expected, *key, TesoroError::InvalidAccount);
    Ok(())
}

// --- Harvest -----------------------------------------------------------------------------------

/// Anyone moves the ready part of a Source's Leaderboard counter into the prize escrow. Refused
/// while the escrow is off and on prize Sources (they have no book). Remaining accounts: the
/// kind's accounts (not paying), then the Source's book and pages.
#[derive(Accounts)]
pub struct Harvest<'info> {
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Account<'info, SourceState>,
}

pub(crate) fn harvest<'info>(
    ctx: Context<'_, '_, 'info, 'info, Harvest<'info>>,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let (mut kind, rest) = KindCtx::load(&a.position.inner, remaining, PayTo::Nobody)?;
    require!(
        kind.route().is_some(),
        TesoroError::BridgedSource
    );
    let rates = kind.rates(&a.position.inner)?;
    let mut books = OnchainBooks::load(rest)?;
    let source_key = a.source.key();
    let position_key = a.position.key();
    sync_in_books(&mut books, &mut a.position, &a.source, &source_key, &rates)?;
    let mut counter = books
        .counter(&source_key.to_bytes(), CLASS_LEADERBOARD)
        .ok_or_else(|| core_err(CoreError::ZeroAmount))?;
    let out = {
        let (book, ck) = books
            .book_with_history(&source_key.to_bytes())
            .map_err(draw_err)?;
        let k = book.redeemable(&counter).map_err(book_err)?;
        let route = kind
            .route_mut()
            .ok_or_else(|| error!(TesoroError::BridgedSource))?;
        route
            .harvest(SourceKind::Yield, book, &mut counter, k, &*ck)
            .map_err(core_err)?
    };
    require!(
        books.set_counter(&source_key.to_bytes(), CLASS_LEADERBOARD, &counter),
        TesoroError::InvalidAccount
    );
    let shares = u64::try_from(out.shares).map_err(|_| core_err(CoreError::Math))?;
    let tag = kind.custody_kind();
    // The escrow already holds the shares; the Position (or the owed total) lets them go.
    let escrow_after = kind.route().map(|r| r.escrow_unissued);
    ledger::economy::debit_paid_shares(&mut a.position.inner, tag, kind.route_mut(), shares)
        .map_err(core_err)?;
    debug_assert!(escrow_after.is_some());
    a.source.inner.redeemed = a.source.inner.redeemed.saturating_add(out.gemas);
    let units = u64::try_from(rates.rate.units_for_shares(u128::from(shares)).map_err(core_err)?)
        .map_err(|_| core_err(CoreError::Math))?;
    a.source.inner.redeemed_units = a.source.inner.redeemed_units.saturating_add(units);
    books.flush()?;
    kind.exit()?;
    emit!(Harvested {
        source: source_key,
        gemas: out.gemas,
        shares,
    });
    let _ = position_key;
    Ok(())
}

// --- Funding a Season's prize ------------------------------------------------------------------

fn fund_route<'info>(
    route: &mut RouteLedger,
    custody: Pubkey,
    season: u32,
    rate: &ShareRate,
    decimals: u8,
    price_micro_usd: u64,
    prize_source: &mut Account<'info, PrizeSourceState>,
    prize_bump: u8,
    pool_basket: &AccountInfo,
    pool_spill: &AccountInfo,
) -> Result<()> {
    let ts = now()?;
    let unissued = route
        .escrow_unissued
        .checked_add(route.pool_owed)
        .ok_or_else(|| core_err(CoreError::Math))?;
    let gemas = ledger::economy::gemas_for_shares(unissued, rate, decimals, price_micro_usd)
        .map_err(core_err)?;
    let key = prize_source.key();
    let funding = route
        .fund_season_prize(season, ts, key.to_bytes(), gemas)
        .map_err(core_err)?;
    prize_source.bump = prize_bump;
    prize_source.route = custody;
    prize_source.season = season;
    prize_source.inner = funding.issued.unwrap_or(PrizeSource {
        source: key.to_bytes(),
        shares: 0,
        gemas: 0,
    });
    if let Some(ps) = funding.issued {
        let line = ledger::prize::prize_line(SIDE_WON, 0, key.to_bytes(), ps.gemas);
        with_pool(pool_basket, pool_spill, |pool| put_prize(pool, &line))?;
    }
    emit!(SeasonFunded {
        season,
        route: custody,
        moved_shares: u64::try_from(funding.moved).unwrap_or(u64::MAX),
        prize_source: key,
        gemas: funding.issued.map_or(0, |p| p.gemas),
    });
    Ok(())
}

pub(crate) fn require_season_authority(
    config: &Config,
    economy: &EconomyConfig,
    signer: &Pubkey,
) -> Result<()> {
    require!(
        *signer == config.admin
            || (economy.season_keeper != Pubkey::default() && *signer == economy.season_keeper),
        TesoroError::Unauthorized
    );
    Ok(())
}

pub(crate) use require_season_authority as season_authority;

/// Funds a Season's prize on the native route.
#[derive(Accounts)]
#[instruction(season: u32)]
pub struct FundSeasonPrizeNative<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [ECONOMY_SEED], bump = economy.bump)]
    pub economy: Box<Account<'info, EconomyConfig>>,
    #[account(
        mut,
        seeds = [NATIVE_SEED],
        bump = custody.bump,
        constraint = custody.pool == pool.key() @ TesoroError::InvalidPool
    )]
    pub custody: Box<Account<'info, NativeCustody>>,
    #[account(
        seeds = [sim_lst::POOL_SEED],
        seeds::program = sim_lst::ID,
        bump = pool.bump,
        constraint = pool.mint == SIM_SOL_MINT @ TesoroError::InvalidPool
    )]
    pub pool: Box<Account<'info, SimPool>>,
    #[account(
        seeds = [PRICE_SEED, SIM_SOL_MINT.as_ref()],
        bump = price_feed.bump
    )]
    pub price_feed: Account<'info, PriceFeed>,
    #[account(
        seeds = [ACCOUNT_SEED, pool_account.authority.as_ref()],
        bump = pool_account.bump,
        constraint = pool_account.key() == config.pool_account @ TesoroError::InvalidAccount
    )]
    pub pool_account: Account<'info, TesoroAccount>,
    /// CHECK: the Pool's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, pool_account.key().as_ref()], bump)]
    pub pool_basket: UncheckedAccount<'info>,
    /// CHECK: the Pool's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, pool_account.key().as_ref()], bump)]
    pub pool_spill: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = PrizeSourceState::SPACE,
        seeds = [PRIZE_SOURCE_SEED, custody.key().as_ref(), &season.to_le_bytes()],
        bump
    )]
    pub prize_source: Account<'info, PrizeSourceState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn fund_season_prize_native(
    ctx: Context<FundSeasonPrizeNative>,
    season: u32,
) -> Result<()> {
    let bump = ctx.bumps.prize_source;
    let a = ctx.accounts;
    require_season_authority(&a.config, &a.economy, &a.authority.key())?;
    let ts = now()?;
    let age = ts
        .checked_sub(a.price_feed.updated_ts)
        .ok_or(TesoroError::StalePrice)?;
    require!(
        a.price_feed.price_micro_usd > 0 && (0..=MAX_PRICE_AGE_SECS).contains(&age),
        TesoroError::StalePrice
    );
    let rate = ShareRate::native(sim_lst::current_rate(&a.pool, ts)?).map_err(core_err)?;
    let custody = a.custody.key();
    fund_route(
        &mut a.custody.route,
        custody,
        season,
        &rate,
        9,
        a.price_feed.price_micro_usd,
        &mut a.prize_source,
        bump,
        &a.pool_basket.to_account_info(),
        &a.pool_spill.to_account_info(),
    )
}

/// Funds a Season's prize on a staking-token route.
#[derive(Accounts)]
#[instruction(season: u32)]
pub struct FundSeasonPrizeStake<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [ECONOMY_SEED], bump = economy.bump)]
    pub economy: Box<Account<'info, EconomyConfig>>,
    #[account(
        mut,
        seeds = [STAKE_CUSTODY_SEED, custody.mint.as_ref()],
        bump = custody.bump
    )]
    pub custody: Box<Account<'info, StakeCustody>>,
    pub mint: Box<Account<'info, Mint>>,
    /// CHECK: the custody's stake pool; checked by `read_pool`.
    pub stake_pool: UncheckedAccount<'info>,
    #[account(
        seeds = [ONCHAIN_PRICE_SEED, custody.mint.as_ref()],
        bump = onchain_price.bump
    )]
    pub onchain_price: Account<'info, OnchainPrice>,
    /// CHECK: address, owner, layout and feed id are checked against `onchain_price` on read.
    #[account(address = onchain_price.feed @ TesoroError::BadPriceFeed)]
    pub price_feed: UncheckedAccount<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, pool_account.authority.as_ref()],
        bump = pool_account.bump,
        constraint = pool_account.key() == config.pool_account @ TesoroError::InvalidAccount
    )]
    pub pool_account: Account<'info, TesoroAccount>,
    /// CHECK: the Pool's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, pool_account.key().as_ref()], bump)]
    pub pool_basket: UncheckedAccount<'info>,
    /// CHECK: the Pool's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, pool_account.key().as_ref()], bump)]
    pub pool_spill: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = PrizeSourceState::SPACE,
        seeds = [PRIZE_SOURCE_SEED, custody.key().as_ref(), &season.to_le_bytes()],
        bump
    )]
    pub prize_source: Account<'info, PrizeSourceState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn fund_season_prize_stake(
    ctx: Context<FundSeasonPrizeStake>,
    season: u32,
) -> Result<()> {
    let bump = ctx.bumps.prize_source;
    let a = ctx.accounts;
    require_season_authority(&a.config, &a.economy, &a.authority.key())?;
    require_keys_eq!(a.mint.key(), a.custody.mint, TesoroError::InvalidMint);
    let ts = now()?;
    let price = a.onchain_price.read(&a.price_feed.to_account_info(), ts)?;
    let read = read_pool(&a.stake_pool.to_account_info(), &a.custody)?;
    let rate = ShareRate::stake(read.rate().map_err(core_err)?).map_err(core_err)?;
    let custody = a.custody.key();
    fund_route(
        &mut a.custody.route,
        custody,
        season,
        &rate,
        a.mint.decimals,
        price,
        &mut a.prize_source,
        bump,
        &a.pool_basket.to_account_info(),
        &a.pool_spill.to_account_info(),
    )
}

// --- Prize Redeem ------------------------------------------------------------------------------

/// Prize Gemas pay at once the shares held for them in the route's escrow: `k / gemas` of the
/// prize Source's remaining shares, so a slash lowers every holder's coin value by the same ratio
/// and the Source can never owe more than it holds. Remaining accounts: the custody's accounts
/// (paying to the holder).
#[derive(Accounts)]
pub struct RedeemPrize<'info> {
    pub holder_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, holder_authority.key().as_ref()],
        bump = holder_account.bump
    )]
    pub holder_account: Account<'info, TesoroAccount>,
    /// CHECK: the holder's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, holder_account.key().as_ref()], bump)]
    pub basket: UncheckedAccount<'info>,
    /// CHECK: the holder's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, holder_account.key().as_ref()], bump)]
    pub spill: UncheckedAccount<'info>,
    #[account(mut)]
    pub prize_source: Account<'info, PrizeSourceState>,
}

pub(crate) fn redeem_prize<'info>(
    ctx: Context<'_, '_, 'info, 'info, RedeemPrize<'info>>,
    amount: u64,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    check_prize_source(&a.prize_source, &a.prize_source.key())?;
    let wallet = a.holder_authority.key();
    let (mut kind, _rest) = KindCtx::load_route(remaining, PayTo::Wallet(&wallet))?;
    require_keys_eq!(
        kind.custody_key().unwrap_or_default(),
        a.prize_source.route,
        TesoroError::InvalidAccount
    );
    let key = prize_line_key(&a.prize_source.key());
    with_pool(&a.basket.to_account_info(), &a.spill.to_account_info(), |pool| {
        let (at, idx, mut line) =
            find_line(pool, &key).ok_or_else(|| core_err(CoreError::HoldingMismatch))?;
        pool.check_withdraw(amount).map_err(draw_err)?;
        if amount > line.amount {
            return Err(core_err(CoreError::InsufficientGemas));
        }
        line.amount -= amount;
        store_line(pool, at, idx, &line)
    })?;
    let shares = {
        let route = kind
            .route_mut()
            .ok_or_else(|| error!(TesoroError::InvalidAccount))?;
        route
            .redeem_prize(&mut a.prize_source.inner, amount)
            .map_err(core_err)?
    };
    let paid = u64::try_from(shares).map_err(|_| core_err(CoreError::Math))?;
    kind.pay_shares(&a.prize_source.key(), paid, 5)?;
    kind.exit()?;
    emit!(PrizeRedeemed {
        prize_source: a.prize_source.key(),
        account: a.holder_account.key(),
        gemas: amount,
        shares: paid,
    });
    Ok(())
}

//! Solana-native Positions without a crank (ADR 0010).
//!
//! * Custody: one simSOL vault (`NativeCustody`) holds the Principal of every Locked native
//!   Position; each Position records its `custody_shares`, `opened_at`, `principal` and `rate_bps`.
//! * Debt, redeemable amounts and free yield are computed from `ledger::yield_math` at `Clock` now
//!   by every instruction that needs them. Nothing records yield.
//! * Yield is minted by `sim_lst::mint_yield` exactly at the moment it is paid (Redeem, Unlock);
//!   Principal returns from the shared vault at Unlock.
//! * The pool totals behind the Treasury's Yield Fee claim change only on open and unlock.
//!
//! The oracle can never open, credit yield to, or unlock a native Position.

use crate::error::{core_err, TesoroError};
use crate::instructions::economy::*;
use crate::instructions::position::chain_byte;
use crate::ledger::{self, native, CoreError, SourceChain};
use crate::state::*;
use crate::storage::*;
use crate::util::{now, require_can_advance};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use sim_lst::Pool;

/// A Solana Position backed by simSOL custody rather than by an oracle fact.
pub fn is_native(position: &ledger::Position) -> bool {
    position.source_chain == SourceChain::Solana && position.source_asset == SIM_SOL_MINT.to_bytes()
}

/// A Solana Position backed by a real staking token in a shared stake custody (ADR 0011). Only
/// `open_stake_position` sets the Staking Rate at open, so no oracle fact can make one.
pub fn is_stake(position: &ledger::Position) -> bool {
    position.source_chain == SourceChain::Solana
        && position.source_asset != SIM_SOL_MINT.to_bytes()
        && position.stake_rate_open != 0
}

/// Position ids of native Positions are derived from their owner and a nonce so nobody else can
/// occupy an owner's id, and one owner can hold several.
pub fn native_position_id(owner_authority: &Pubkey, nonce: u64) -> [u8; 32] {
    hashv(&[b"native", owner_authority.as_ref(), &nonce.to_le_bytes()]).to_bytes()
}

// --- Price -----------------------------------------------------------------------------------

/// The oracle authority publishes the SOL/USD issuance price. Devnet stand-in for Pyth: the
/// feed account is the seam, `take_native_advance` only reads it.
#[derive(Accounts)]
pub struct SetPrice<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.oracle_authority == oracle.key() @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = oracle,
        space = PriceFeed::SPACE,
        seeds = [PRICE_SEED, SIM_SOL_MINT.as_ref()],
        bump
    )]
    pub price_feed: Account<'info, PriceFeed>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_price(ctx: Context<SetPrice>, price_micro_usd: u64) -> Result<()> {
    require!(price_micro_usd > 0, TesoroError::StalePrice);
    let feed = &mut ctx.accounts.price_feed;
    feed.bump = ctx.bumps.price_feed;
    feed.asset = SIM_SOL_MINT;
    feed.price_micro_usd = price_micro_usd;
    feed.updated_ts = now()?;
    emit!(PriceSet {
        asset: SIM_SOL_MINT,
        price_micro_usd,
    });
    Ok(())
}

// --- Custody setup ---------------------------------------------------------------------------

/// Creates the shared custody and its simSOL vault. Admin only, once.
#[derive(Accounts)]
pub struct InitNativeCustody<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    /// The canonical sim_lst Pool: owned by the sim_lst program and at its `["pool"]` PDA.
    #[account(
        seeds = [sim_lst::POOL_SEED],
        seeds::program = sim_lst::ID,
        bump = pool.bump,
        constraint = pool.mint == SIM_SOL_MINT @ TesoroError::InvalidPool
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(address = pool.mint @ TesoroError::InvalidMint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        space = NativeCustody::SPACE,
        seeds = [NATIVE_SEED],
        bump
    )]
    pub custody: Box<Account<'info, NativeCustody>>,
    #[account(
        init,
        payer = admin,
        seeds = [NATIVE_VAULT_SEED],
        bump,
        token::mint = mint,
        token::authority = custody
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn init_native_custody(ctx: Context<InitNativeCustody>) -> Result<()> {
    let a = ctx.accounts;
    a.custody.bump = ctx.bumps.custody;
    a.custody.vault_bump = ctx.bumps.vault;
    a.custody.pool = a.pool.key();
    a.custody.mint = a.mint.key();
    a.custody.vault = a.vault.key();
    a.custody.route = ledger::RouteLedger::default();
    Ok(())
}

// --- Open ------------------------------------------------------------------------------------

/// The owner deposits simSOL into the shared vault. Principal is recorded in SOL at the current
/// sim_lst rate, and the Position joins the pool totals. No oracle involved.
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct OpenNativePosition<'info> {
    #[account(mut)]
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    /// The canonical sim_lst Pool: owned by the sim_lst program and at its `["pool"]` PDA.
    #[account(
        seeds = [sim_lst::POOL_SEED],
        seeds::program = sim_lst::ID,
        bump = pool.bump,
        constraint = pool.mint == SIM_SOL_MINT @ TesoroError::InvalidPool
    )]
    pub pool: Account<'info, Pool>,
    #[account(address = pool.mint @ TesoroError::InvalidMint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = owner_authority
    )]
    pub owner_token: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = owner_authority,
        space = PositionState::SPACE,
        seeds = [
            POSITION_SEED,
            &[chain_byte(SourceChain::Solana)],
            native_position_id(&owner_authority.key(), nonce).as_ref()
        ],
        bump
    )]
    pub position: Account<'info, PositionState>,
    /// Its Yield Fee is fixed on the Position at open.
    #[account(seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(
        mut,
        seeds = [NATIVE_SEED],
        bump = custody.bump,
        constraint = custody.pool == pool.key() @ TesoroError::InvalidPool
    )]
    pub custody: Account<'info, NativeCustody>,
    #[account(mut, address = custody.vault @ TesoroError::InvalidAccount)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn open_native_position(
    mut ctx: Context<OpenNativePosition>,
    nonce: u64,
    lst_amount: u64,
) -> Result<()> {
    let a = &mut ctx.accounts;
    if lst_amount == 0 {
        return Err(core_err(CoreError::ZeroAmount));
    }
    let ts = now()?;
    let rate = sim_lst::current_rate(&a.pool, ts)?;
    let principal = native::shares_value(lst_amount, rate).map_err(core_err)?;
    let rate_bps = u16::try_from(a.pool.apy_bps).map_err(|_| error!(TesoroError::InvalidPool))?;

    let before = a.vault.amount;
    token::transfer(
        CpiContext::new(
            a.token_program.to_account_info(),
            Transfer {
                from: a.owner_token.to_account_info(),
                to: a.vault.to_account_info(),
                authority: a.owner_authority.to_account_info(),
            },
        ),
        lst_amount,
    )?;
    a.vault.reload()?;
    require_eq!(
        a.vault.amount,
        before
            .checked_add(lst_amount)
            .ok_or(TesoroError::InvalidAccount)?,
        TesoroError::InvalidAccount
    );

    let position_key = a.position.key();
    a.position.bump = ctx.bumps.position;
    a.position.position_id = native_position_id(&a.owner_authority.key(), nonce);
    a.position.inner = ledger::Position::new(
        a.owner_account.key().to_bytes(),
        SourceChain::Solana,
        SIM_SOL_MINT.to_bytes(),
        a.mint.decimals,
        principal,
        rate_bps,
    )
    .map_err(core_err)?;
    a.position.inner.opened_at = ts;
    a.position.inner.custody_shares = lst_amount;
    a.position.inner.yield_fee_bps = a.treasury.yield_fee_bps;

    a.custody.add_position(principal)?;

    emit!(NativePositionOpened {
        position: position_key,
        owner: a.owner_account.key(),
        shares: lst_amount,
        rate,
        principal_sol: principal,
    });
    Ok(())
}

// --- Advance ---------------------------------------------------------------------------------

/// An Advance against a native Position priced by the on-chain `PriceFeed`: the owner signs alone.
/// When the Position still has its previous Advance open (Debt zero by now, but nothing has
/// closed it), that Source and its book go in the remaining accounts and are closed here:
/// `[prev_source, prev_book, its checkpoint pages...]`.
#[derive(Accounts)]
pub struct TakeNativeAdvance<'info> {
    #[account(mut)]
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    /// CHECK: the owner's Protections address; a Self-Excluded owner takes no Advance.
    #[account(
        seeds = [PROTECTIONS_SEED, owner_account.key().as_ref()],
        bump
    )]
    pub protections: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized,
        constraint = is_native(&position.inner) @ TesoroError::NotNativePosition
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        seeds = [PRICE_SEED, SIM_SOL_MINT.as_ref()],
        bump = price_feed.bump,
        constraint = price_feed.asset.to_bytes() == position.inner.source_asset @ TesoroError::InvalidAccount
    )]
    pub price_feed: Account<'info, PriceFeed>,
    /// The canonical sim_lst Pool, whose speedup times the yield.
    #[account(
        seeds = [sim_lst::POOL_SEED],
        seeds::program = sim_lst::ID,
        bump = pool.bump,
        constraint = pool.mint == SIM_SOL_MINT @ TesoroError::InvalidPool
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init,
        payer = owner_authority,
        space = SourceState::SPACE,
        seeds = [SOURCE_SEED, position.key().as_ref(), &position.inner.advances.to_le_bytes()],
        bump
    )]
    pub source: Account<'info, SourceState>,
    #[account(
        init,
        payer = owner_authority,
        space = SOURCE_BOOK_LEN,
        seeds = [BOOK_SEED, source.key().as_ref()],
        bump
    )]
    pub book: AccountLoader<'info, SourceBookHead>,
    /// CHECK: the owner's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, owner_account.key().as_ref()], bump)]
    pub basket: UncheckedAccount<'info>,
    /// CHECK: the owner's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, owner_account.key().as_ref()], bump)]
    pub spill: UncheckedAccount<'info>,
    /// The Pool's share of the Yield Fee in force, snapshotted into the new Source (ticket 31).
    #[account(seeds = [ECONOMY_SEED], bump = economy.bump)]
    pub economy: Box<Account<'info, EconomyConfig>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn take_native_advance<'info>(
    mut ctx: Context<'_, '_, 'info, 'info, TakeNativeAdvance<'info>>,
    horizon_months: u8,
    min_gemas: u64,
) -> Result<()> {
    require_can_advance(&ctx.accounts.protections.to_account_info())?;
    let remaining = ctx.remaining_accounts;
    let (source_bump, book_bump) = (ctx.bumps.source, ctx.bumps.book);
    let a = &mut ctx.accounts;
    let ts = now()?;
    let age = ts
        .checked_sub(a.price_feed.updated_ts)
        .ok_or(TesoroError::StalePrice)?;
    require!(
        a.price_feed.price_micro_usd > 0 && (0..=MAX_PRICE_AGE_SECS).contains(&age),
        TesoroError::StalePrice
    );
    let rates = native_rates(&a.position.inner, &a.pool)?;
    let fee = FeeSnapshot::now(a.position.inner.yield_fee_bps, &a.economy)?;
    let (basket, spill) = (a.basket.to_account_info(), a.spill.to_account_info());
    begin_advance(
        NewAdvance {
            position: &mut a.position,
            source: &mut a.source,
            source_bump,
            book: &a.book,
            book_bump,
            basket: &basket,
            spill: &spill,
        },
        &rates,
        remaining,
        horizon_months,
        a.price_feed.price_micro_usd,
        fee,
        min_gemas,
    )
}

// --- Extend ----------------------------------------------------------------------------------

/// Adds months to the Position's open Advance and credits those months' Gemas, as a new Extension
/// tranche (junior to everything issued before), to the owner's basket. The owner signs alone.
/// Remaining accounts: the Source's book and its checkpoint pages. The book grows by one class, paid
/// by the owner.
#[derive(Accounts)]
pub struct ExtendNativeAdvance<'info> {
    #[account(mut)]
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    /// CHECK: the owner's Protections address; a Self-Excluded owner takes no Advance.
    #[account(
        seeds = [PROTECTIONS_SEED, owner_account.key().as_ref()],
        bump
    )]
    pub protections: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized,
        constraint = is_native(&position.inner) @ TesoroError::NotNativePosition
    )]
    pub position: Account<'info, PositionState>,
    /// The canonical sim_lst Pool, whose speedup times the yield.
    #[account(
        seeds = [sim_lst::POOL_SEED],
        seeds::program = sim_lst::ID,
        bump = pool.bump,
        constraint = pool.mint == SIM_SOL_MINT @ TesoroError::InvalidPool
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Account<'info, SourceState>,
    /// CHECK: the owner's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, owner_account.key().as_ref()], bump)]
    pub basket: UncheckedAccount<'info>,
    /// CHECK: the owner's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, owner_account.key().as_ref()], bump)]
    pub spill: UncheckedAccount<'info>,
    /// The owner's Extend Limit, created at the default on the first Extend.
    #[account(
        init_if_needed,
        payer = owner_authority,
        space = ExtendLimitState::SPACE,
        seeds = [EXTEND_LIMIT_SEED, owner_account.key().as_ref()],
        bump
    )]
    pub extend_limit: Account<'info, ExtendLimitState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn extend_native_advance<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExtendNativeAdvance<'info>>,
    extra_months: u8,
    min_gemas: u64,
) -> Result<()> {
    require_can_advance(&ctx.accounts.protections.to_account_info())?;
    let remaining = ctx.remaining_accounts;
    let bump = ctx.bumps.extend_limit;
    let a = ctx.accounts;
    touch_extend_limit(&mut a.extend_limit, a.owner_account.key(), bump);
    let ts = now()?;
    a.extend_limit
        .inner
        .record_extend(ts, extra_months)
        .map_err(core_err)?;
    let rates = native_rates(&a.position.inner, &a.pool)?;
    extend_open_advance(
        ExtendAccounts {
            position: &mut a.position,
            source: &mut a.source,
            payer: a.owner_authority.to_account_info(),
            system_program: a.system_program.to_account_info(),
            basket: a.basket.to_account_info(),
            spill: a.spill.to_account_info(),
        },
        &rates,
        remaining,
        extra_months,
        min_gemas,
    )
}

/// Fills in a freshly created (zeroed) Extend Limit with its identity and the default limit.
pub(crate) fn touch_extend_limit(limit: &mut ExtendLimitState, account: Pubkey, bump: u8) {
    if limit.account == Pubkey::default() {
        limit.bump = bump;
        limit.account = account;
        limit.inner = Default::default();
    }
}

/// Sets the owner's Extend Limit: a lower limit applies at once, a higher one 24 hours later.
#[derive(Accounts)]
pub struct SetExtendLimit<'info> {
    #[account(mut)]
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        init_if_needed,
        payer = owner_authority,
        space = ExtendLimitState::SPACE,
        seeds = [EXTEND_LIMIT_SEED, owner_account.key().as_ref()],
        bump
    )]
    pub extend_limit: Account<'info, ExtendLimitState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_extend_limit(ctx: Context<SetExtendLimit>, months: u8) -> Result<()> {
    let bump = ctx.bumps.extend_limit;
    let a = ctx.accounts;
    touch_extend_limit(&mut a.extend_limit, a.owner_account.key(), bump);
    let ts = now()?;
    a.extend_limit
        .inner
        .set_limit(ts, months)
        .map_err(core_err)?;
    let l = a.extend_limit.inner;
    emit!(ExtendLimitSet {
        account: a.owner_account.key(),
        months: l.effective(ts),
        pending_months: l.pending_months,
        pending_at: l.pending_at,
    });
    Ok(())
}

/// Sets the owner's Entry Limit: a lower limit applies at once, a higher one (or none, zero) 24
/// hours later. Creates the owner's Protections account on first use.
#[derive(Accounts)]
pub struct SetEntryLimit<'info> {
    #[account(mut)]
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        init_if_needed,
        payer = owner_authority,
        space = ProtectionsState::SPACE,
        seeds = [PROTECTIONS_SEED, owner_account.key().as_ref()],
        bump
    )]
    pub protections: Account<'info, ProtectionsState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_entry_limit(ctx: Context<SetEntryLimit>, gemas: u64) -> Result<()> {
    let bump = ctx.bumps.protections;
    let a = ctx.accounts;
    touch_protections(&mut a.protections, a.owner_account.key(), bump);
    let ts = now()?;
    a.protections
        .inner
        .entry_limit
        .set_limit(ts, gemas)
        .map_err(core_err)?;
    let l = a.protections.inner.entry_limit;
    emit!(EntryLimitSet {
        account: a.owner_account.key(),
        gemas: l.effective(ts),
        pending_gemas: l.pending_gemas,
        pending_at: l.pending_at,
    });
    Ok(())
}

/// Starts a Break (`days`, 1 to 42) or a Self-Exclusion (`months`, 6 to 60), or extends the one
/// running. Neither can be ended or shortened. Creates the owner's Protections account on first use.
#[derive(Accounts)]
pub struct SetProtection<'info> {
    #[account(mut)]
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        init_if_needed,
        payer = owner_authority,
        space = ProtectionsState::SPACE,
        seeds = [PROTECTIONS_SEED, owner_account.key().as_ref()],
        bump
    )]
    pub protections: Account<'info, ProtectionsState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_break(ctx: Context<SetProtection>, days: u16) -> Result<()> {
    let bump = ctx.bumps.protections;
    let a = ctx.accounts;
    touch_protections(&mut a.protections, a.owner_account.key(), bump);
    let ts = now()?;
    a.protections.inner.set_break(ts, days).map_err(core_err)?;
    emit!(BreakSet {
        account: a.owner_account.key(),
        until: a.protections.inner.break_until,
    });
    Ok(())
}

pub(crate) fn set_self_exclusion(ctx: Context<SetProtection>, months: u16) -> Result<()> {
    let bump = ctx.bumps.protections;
    let a = ctx.accounts;
    touch_protections(&mut a.protections, a.owner_account.key(), bump);
    let ts = now()?;
    a.protections
        .inner
        .set_self_exclusion(ts, months)
        .map_err(core_err)?;
    emit!(SelfExclusionSet {
        account: a.owner_account.key(),
        until: a.protections.inner.self_exclusion_until,
    });
    Ok(())
}

/// Fills in a freshly created (zeroed) Protections account with its identity and no Protection.
pub(crate) fn touch_protections(p: &mut ProtectionsState, account: Pubkey, bump: u8) {
    if p.account == Pubkey::default() {
        p.bump = bump;
        p.account = account;
        p.inner = Default::default();
    }
}

// --- Loading accounts from `remaining_accounts` ------------------------------------------------
//
// `redeem`, `unlock` and `return_own` also serve Positions of other chains, so their fixed
// accounts do not change; a native Position adds the accounts below after them.

/// The canonical sim_lst Pool: owned by sim_lst, discriminator and PDA address checked.
pub(crate) fn load_pool<'info>(info: &'info AccountInfo<'info>) -> Result<Account<'info, Pool>> {
    let pool = Account::<Pool>::try_from(info)?;
    let expected =
        Pubkey::create_program_address(&[sim_lst::POOL_SEED, &[pool.bump]], &sim_lst::ID)
            .map_err(|_| error!(TesoroError::InvalidPool))?;
    require_keys_eq!(expected, *info.key, TesoroError::InvalidPool);
    require_keys_eq!(pool.mint, SIM_SOL_MINT, TesoroError::InvalidPool);
    Ok(pool)
}

pub(crate) fn load_custody<'info>(
    info: &'info AccountInfo<'info>,
) -> Result<Account<'info, NativeCustody>> {
    require!(info.is_writable, TesoroError::NotWritable);
    let custody = Account::<NativeCustody>::try_from(info)?;
    let expected = Pubkey::create_program_address(&[NATIVE_SEED, &[custody.bump]], &crate::ID)
        .map_err(|_| error!(TesoroError::InvalidAccount))?;
    require_keys_eq!(expected, *info.key, TesoroError::InvalidAccount);
    Ok(custody)
}

/// Who the minted yield is for: a wallet (its token account) or one fixed vault.
pub(crate) enum Payee<'a> {
    Wallet(&'a Pubkey),
    Vault(&'a Pubkey),
}

/// Everything a yield payout needs: `[pool, destination, mint, yield_config, yield_authority,
/// sim_lst_program, token_program]`.
pub(crate) struct YieldMint<'info> {
    pub pool: Account<'info, Pool>,
    pub destination: Account<'info, TokenAccount>,
    pub mint: &'info AccountInfo<'info>,
    pub yield_config: &'info AccountInfo<'info>,
    pub yield_authority: &'info AccountInfo<'info>,
    pub sim_lst_program: &'info AccountInfo<'info>,
    pub token_program: &'info AccountInfo<'info>,
    authority_bump: u8,
}

pub(crate) const YIELD_MINT_ACCOUNTS: usize = 7;

pub(crate) fn load_yield_mint<'info>(
    accounts: &'info [AccountInfo<'info>],
    payee: Payee,
) -> Result<YieldMint<'info>> {
    let [pool_info, dest_info, mint, yield_config, yield_authority, sim_lst_program, token_program] =
        accounts
    else {
        return err!(TesoroError::BadRemainingAccounts);
    };
    require!(
        dest_info.is_writable && mint.is_writable,
        TesoroError::NotWritable
    );
    let pool = load_pool(pool_info)?;
    require_keys_eq!(*mint.key, pool.mint, TesoroError::InvalidMint);
    let destination = Account::<TokenAccount>::try_from(dest_info)?;
    require_keys_eq!(destination.mint, pool.mint, TesoroError::InvalidMint);
    match payee {
        Payee::Wallet(wallet) => {
            require_keys_eq!(destination.owner, *wallet, TesoroError::InvalidAccount)
        }
        Payee::Vault(vault) => {
            require_keys_eq!(*dest_info.key, *vault, TesoroError::InvalidAccount)
        }
    }
    let config = Account::<sim_lst::YieldConfig>::try_from(yield_config)?;
    let expected =
        Pubkey::create_program_address(&[sim_lst::YIELD_SEED, &[config.bump]], &sim_lst::ID)
            .map_err(|_| error!(TesoroError::InvalidAccount))?;
    require_keys_eq!(expected, *yield_config.key, TesoroError::InvalidAccount);
    let (authority, authority_bump) = Pubkey::find_program_address(&[YIELD_SEED], &crate::ID);
    require_keys_eq!(authority, *yield_authority.key, TesoroError::InvalidAccount);
    require_keys_eq!(config.authority, authority, TesoroError::InvalidAccount);
    require_keys_eq!(
        *sim_lst_program.key,
        sim_lst::ID,
        TesoroError::InvalidAccount
    );
    require_keys_eq!(*token_program.key, token::ID, TesoroError::InvalidAccount);
    Ok(YieldMint {
        pool,
        destination,
        mint,
        yield_config,
        yield_authority,
        sim_lst_program,
        token_program,
        authority_bump,
    })
}

impl<'info> YieldMint<'info> {
    /// Sends `shares` of Principal from the custody vault to the destination.
    pub(crate) fn transfer_from_vault(
        &self,
        vault: &AccountInfo<'info>,
        custody: &Account<'info, NativeCustody>,
        shares: u64,
        position: &Pubkey,
    ) -> Result<()> {
        let rate = sim_lst::current_rate(&self.pool, now()?)?;
        let seeds: &[&[u8]] = &[NATIVE_SEED, &[custody.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                self.token_program.clone(),
                Transfer {
                    from: vault.clone(),
                    to: self.destination.to_account_info(),
                    authority: custody.to_account_info(),
                },
                &[seeds],
            ),
            shares,
        )?;
        emit!(NativePayout {
            position: *position,
            to: self.destination.key(),
            shares,
            sol_units: native::shares_value(shares, rate).map_err(core_err)?,
            kind: 1,
        });
        Ok(())
    }

    /// Mints exactly `shares` simSOL shares to the destination and reports their value now.
    pub(crate) fn pay_shares(&self, position: &Pubkey, shares: u64, kind: u8) -> Result<()> {
        if shares == 0 {
            return Err(core_err(CoreError::ZeroShares));
        }
        let rate = sim_lst::current_rate(&self.pool, now()?)?;
        let seeds: &[&[u8]] = &[YIELD_SEED, &[self.authority_bump]];
        sim_lst::cpi::mint_yield(
            CpiContext::new_with_signer(
                self.sim_lst_program.clone(),
                sim_lst::cpi::accounts::MintYield {
                    authority: self.yield_authority.clone(),
                    config: self.yield_config.clone(),
                    pool: self.pool.to_account_info(),
                    mint: self.mint.clone(),
                    destination: self.destination.to_account_info(),
                    token_program: self.token_program.clone(),
                },
                &[seeds],
            ),
            shares,
        )?;
        emit!(NativePayout {
            position: *position,
            to: self.destination.key(),
            shares,
            sol_units: native::shares_value(shares, rate).map_err(core_err)?,
            kind,
        });
        Ok(())
    }
}

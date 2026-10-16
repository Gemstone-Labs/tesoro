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
use crate::instructions::position::{chain_byte, issue_advance};
use crate::ledger::{self, native, CoreError, SourceChain};
use crate::state::*;
use crate::util::{now, require_can_advance};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use sim_lst::Pool;

/// A Solana Position backed by simSOL custody rather than by an oracle fact.
pub fn is_native(position: &ledger::Position) -> bool {
    position.source_chain == SourceChain::Solana && position.source_asset == SIM_SOL_MINT.to_bytes()
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
    a.custody.set_totals(ledger::PoolTotals::default());
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

    let mut totals = a.custody.totals();
    totals
        .add_position(principal, ts, rate_bps, a.treasury.yield_fee_bps)
        .map_err(core_err)?;
    a.custody.set_totals(totals);

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
/// closed it), that Source is passed as `prev_source` and closed here.
#[derive(Accounts)]
pub struct TakeNativeAdvance<'info> {
    #[account(mut)]
    pub owner_authority: Signer<'info>,
    #[account(
        mut,
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
    /// The Position's open Advance, when it has one.
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &prev_source.inner.index.to_le_bytes()],
        bump = prev_source.bump,
        constraint = prev_source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub prev_source: Option<Account<'info, SourceState>>,
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
        space = HoldingState::SPACE,
        seeds = [HOLDING_SEED, owner_account.key().as_ref(), source.key().as_ref()],
        bump
    )]
    pub holding: Account<'info, HoldingState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn take_native_advance(
    mut ctx: Context<TakeNativeAdvance>,
    horizon_months: u8,
) -> Result<()> {
    require_can_advance(&ctx.accounts.protections.to_account_info())?;
    let a = &mut ctx.accounts;
    let ts = now()?;
    let age = ts
        .checked_sub(a.price_feed.updated_ts)
        .ok_or(TesoroError::StalePrice)?;
    require!(
        a.price_feed.price_micro_usd > 0 && (0..=MAX_PRICE_AGE_SECS).contains(&age),
        TesoroError::StalePrice
    );
    let net = native::position_accrued(&a.position.inner, a.pool.speedup, ts).map_err(core_err)?;
    let fee = a.position.inner.yield_fee_bps;
    if a.position.inner.open_advance.is_some() && a.prev_source.is_none() {
        return err!(TesoroError::SourceRequired);
    }
    native::prepare_advance(
        &mut a.position.inner,
        a.prev_source.as_mut().map(|s| &mut s.inner),
        net.net,
    )
    .map_err(core_err)?;
    issue_advance(
        &mut a.position,
        &mut a.source,
        &mut a.holding,
        &mut a.owner_account,
        ctx.bumps.source,
        ctx.bumps.holding,
        horizon_months,
        a.price_feed.price_micro_usd,
        fee,
    )
}

// --- Extend ----------------------------------------------------------------------------------

/// Adds months to the Position's open Advance and credits those months' Gemas to the owner's
/// Holding of its Source, at the Source's stored price. The owner signs alone.
#[derive(Accounts)]
pub struct ExtendNativeAdvance<'info> {
    #[account(mut)]
    pub owner_authority: Signer<'info>,
    #[account(
        mut,
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
    #[account(
        mut,
        seeds = [HOLDING_SEED, owner_account.key().as_ref(), source.key().as_ref()],
        bump = holding.bump,
        constraint = holding.account == owner_account.key() @ TesoroError::InvalidAccount,
        constraint = holding.inner.source == source.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub holding: Account<'info, HoldingState>,
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

pub(crate) fn extend_native_advance(
    ctx: Context<ExtendNativeAdvance>,
    extra_months: u8,
) -> Result<()> {
    require_can_advance(&ctx.accounts.protections.to_account_info())?;
    let bump = ctx.bumps.extend_limit;
    let a = ctx.accounts;
    touch_extend_limit(&mut a.extend_limit, a.owner_account.key(), bump);
    a.extend_limit
        .inner
        .record_extend(now()?, extra_months)
        .map_err(core_err)?;
    let ts = now()?;
    let net = native::position_accrued(&a.position.inner, a.pool.speedup, ts).map_err(core_err)?;
    let fee = a.position.inner.yield_fee_bps;
    let mut source =
        native::source_view(&a.position.inner, &a.source.inner, net.net).map_err(core_err)?;
    let gemas = a
        .position
        .inner
        .extend_advance(&mut source, extra_months, fee)
        .map_err(core_err)?;
    a.source.inner = source;
    a.holding
        .inner
        .credit(&mut a.owner_account.inner, gemas)
        .map_err(core_err)?;
    emit!(AdvanceExtended {
        position: a.position.key(),
        source: a.source.key(),
        gemas,
        extra_months,
        horizon_months: a.source.inner.horizon_months,
    });
    Ok(())
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

fn load_custody<'info>(info: &'info AccountInfo<'info>) -> Result<Account<'info, NativeCustody>> {
    require!(info.is_writable, TesoroError::NotWritable);
    let custody = Account::<NativeCustody>::try_from(info)?;
    let expected = Pubkey::create_program_address(&[NATIVE_SEED, &[custody.bump]], &crate::ID)
        .map_err(|_| error!(TesoroError::InvalidAccount))?;
    require_keys_eq!(expected, *info.key, TesoroError::InvalidAccount);
    Ok(custody)
}

/// The Source of `position` at `index`, writable.
fn load_source<'info>(
    info: &'info AccountInfo<'info>,
    position: &Pubkey,
    index: u32,
) -> Result<Account<'info, SourceState>> {
    require!(info.is_writable, TesoroError::NotWritable);
    let source = Account::<SourceState>::try_from(info)?;
    let expected = Pubkey::create_program_address(
        &[
            SOURCE_SEED,
            position.as_ref(),
            &index.to_le_bytes(),
            &[source.bump],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(TesoroError::InvalidAccount))?;
    require_keys_eq!(expected, *info.key, TesoroError::InvalidAccount);
    require_eq!(source.inner.index, index, TesoroError::InvalidAccount);
    require!(
        source.inner.position == position.to_bytes(),
        TesoroError::InvalidAccount
    );
    Ok(source)
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
    mint: &'info AccountInfo<'info>,
    yield_config: &'info AccountInfo<'info>,
    yield_authority: &'info AccountInfo<'info>,
    sim_lst_program: &'info AccountInfo<'info>,
    token_program: &'info AccountInfo<'info>,
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
    /// Mints `units` SOL of yield, in simSOL at the rate, to the destination and reports it.
    pub(crate) fn pay(&self, position: &Pubkey, units: u64, kind: u8) -> Result<()> {
        let rate = sim_lst::current_rate(&self.pool, now()?)?;
        let shares = native::shares_for_units_floor(units, rate).map_err(core_err)?;
        if shares == 0 {
            return Err(core_err(CoreError::ZeroShares));
        }
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
            sol_units: units,
            kind,
        });
        Ok(())
    }
}

// --- Redeem, Unlock, return_own for native Positions ------------------------------------------

/// `redeem` of a native Source. `remaining`: `[pool, destination, mint, yield_config,
/// yield_authority, sim_lst_program, token_program]`. The Source is brought to its derived state
/// first; the yield for the redeemed Gemas is minted to the holder's simSOL account.
#[allow(clippy::too_many_arguments)]
pub(crate) fn redeem_native<'info>(
    position: &PositionState,
    position_key: &Pubkey,
    source: &mut SourceState,
    holder_account: &mut TesoroAccount,
    holding: &mut HoldingState,
    holder_authority: &Pubkey,
    amount: u64,
    remaining: &'info [AccountInfo<'info>],
) -> Result<u64> {
    let y = load_yield_mint(remaining, Payee::Wallet(holder_authority))?;
    redeem_with(
        position,
        position_key,
        source,
        holder_account,
        holding,
        &y,
        amount,
    )
}

/// `redeem_treasury` of a native Source: the yield is minted into the treasury vault.
/// `remaining`: `[pool, destination, mint, yield_config, yield_authority, sim_lst_program,
/// token_program]`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn redeem_treasury_native<'info>(
    position: &PositionState,
    position_key: &Pubkey,
    source: &mut SourceState,
    treasury_account: &mut TesoroAccount,
    treasury_holding: &mut HoldingState,
    treasury: &Treasury,
    amount: u64,
    remaining: &'info [AccountInfo<'info>],
) -> Result<u64> {
    let y = load_yield_mint(remaining, Payee::Vault(&treasury.vault))?;
    redeem_with(
        position,
        position_key,
        source,
        treasury_account,
        treasury_holding,
        &y,
        amount,
    )
}

#[allow(clippy::too_many_arguments)]
fn redeem_with(
    position: &PositionState,
    position_key: &Pubkey,
    source: &mut SourceState,
    account: &mut TesoroAccount,
    holding: &mut HoldingState,
    y: &YieldMint,
    amount: u64,
) -> Result<u64> {
    let net =
        native::position_accrued(&position.inner, y.pool.speedup, now()?).map_err(core_err)?;
    source.inner =
        native::source_view(&position.inner, &source.inner, net.net).map_err(core_err)?;
    let units = ledger::redeem(
        &mut source.inner,
        &mut account.inner,
        &mut holding.inner,
        amount,
    )
    .map_err(core_err)?;
    y.pay(position_key, units, 0)?;
    Ok(units)
}

/// `unlock` of a native Position. `remaining`: `[custody, vault, pool, destination,
/// mint, yield_config, yield_authority, sim_lst_program, token_program]`, then the open Advance's
/// Source when the Position has one. Principal returns from the shared vault; the free yield is
/// minted.
pub(crate) fn unlock_native_position<'info>(
    position: &mut Account<PositionState>,
    owner_authority: &Pubkey,
    remaining: &'info [AccountInfo<'info>],
) -> Result<()> {
    let [custody_info, vault_info, rest @ ..] = remaining else {
        return err!(TesoroError::BadRemainingAccounts);
    };
    require!(
        rest.len() >= YIELD_MINT_ACCOUNTS,
        TesoroError::BadRemainingAccounts
    );
    let (mint_accounts, tail) = rest.split_at(YIELD_MINT_ACCOUNTS);
    let mut custody = load_custody(custody_info)?;
    require_keys_eq!(*vault_info.key, custody.vault, TesoroError::InvalidAccount);
    require!(vault_info.is_writable, TesoroError::NotWritable);
    let y = load_yield_mint(mint_accounts, Payee::Wallet(owner_authority))?;
    require_keys_eq!(y.pool.key(), custody.pool, TesoroError::InvalidPool);

    let position_key = position.key();
    let ts = now()?;
    let net = native::position_accrued(&position.inner, y.pool.speedup, ts).map_err(core_err)?;
    let mut open = match position.inner.open_advance {
        Some(index) => {
            let info = tail.first().ok_or(TesoroError::SourceRequired)?;
            Some(load_source(info, &position_key, index)?)
        }
        None => None,
    };
    let free = native::unlock_native(
        &mut position.inner,
        open.as_mut().map(|s| &mut s.inner),
        net.net,
    )
    .map_err(core_err)?;
    if let Some(source) = open.as_ref() {
        source.exit(&crate::ID)?;
    }

    let shares = position.inner.custody_shares;
    let mut totals = custody.totals();
    totals
        .remove_position(
            position.inner.principal,
            position.inner.opened_at,
            position.inner.rate_bps,
            position.inner.yield_fee_bps,
            net.fee,
        )
        .map_err(core_err)?;
    custody.set_totals(totals);
    position.inner.custody_shares = 0;
    let custody_bump = custody.bump;
    custody.exit(&crate::ID)?;

    let seeds: &[&[u8]] = &[NATIVE_SEED, &[custody_bump]];
    token::transfer(
        CpiContext::new_with_signer(
            y.token_program.clone(),
            Transfer {
                from: vault_info.clone(),
                to: y.destination.to_account_info(),
                authority: custody_info.clone(),
            },
            &[seeds],
        ),
        shares,
    )?;
    let rate = sim_lst::current_rate(&y.pool, ts)?;
    emit!(NativePayout {
        position: position_key,
        to: y.destination.key(),
        shares,
        sol_units: native::shares_value(shares, rate).map_err(core_err)?,
        kind: 1,
    });
    if free > 0 {
        y.pay(&position_key, free, 2)?;
    }
    Ok(())
}

/// `return_own` of a native Source. `remaining`: `[pool]`.
pub(crate) fn return_own_native_source<'info>(
    position: &mut PositionState,
    source: &mut SourceState,
    account: &mut TesoroAccount,
    holding: &mut HoldingState,
    amount: u64,
    remaining: &'info [AccountInfo<'info>],
) -> Result<()> {
    let [pool_info] = remaining else {
        return err!(TesoroError::BadRemainingAccounts);
    };
    let pool = load_pool(pool_info)?;
    let net = native::position_accrued(&position.inner, pool.speedup, now()?).map_err(core_err)?;
    native::return_own_native(
        &mut position.inner,
        &mut source.inner,
        &mut account.inner,
        &mut holding.inner,
        amount,
        net.net,
    )
    .map_err(core_err)
}

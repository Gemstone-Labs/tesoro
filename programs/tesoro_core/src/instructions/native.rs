//! Solana-native Positions: the Principal is real simSOL (`sim_lst`) held in a vault that only this
//! program controls, and yield is read from the pool's rate instead of being reported by the oracle.
//!
//! Custody model (see `ledger::native` for the arithmetic). The vault of a Position (a token
//! account PDA, authority = its `NativeCustody`) holds the shares deposited at open. Shares leave
//! only by:
//!
//! * `redeem`: shares worth the redeemed accrued yield at the current rate go to the holder;
//! * `unlock` / `sweep_native_surplus`: everything beyond `ceil((Principal + owed yield) / rate)`
//!   (Principal is released only once Debt is zero; the owed yield of holders who have not redeemed
//!   yet stays in the vault, valued at the current rate, so a later redeem is always covered).
//!
//! Every payout ends by re-checking that the vault covers Principal (while Locked) plus the applied
//! but unredeemed yield. The oracle can never open, credit yield to, or unlock a native Position.

use crate::error::{core_err, TesoroError};
use crate::instructions::position::{chain_byte, issue_advance};
use crate::instructions::stake_pool::{self, custody_rate, load_fee_accounts, FeeAccounts};
use crate::ledger::{self, native, CoreError, SourceChain};
use crate::state::*;
use crate::util::now;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use sim_lst::Pool;

/// A Solana Position backed by token custody rather than by an oracle fact: it carries the native
/// marker `open_native_position` writes, or is a simSOL Position opened before the marker existed.
pub fn is_native(state: &Account<PositionState>) -> bool {
    let position = &state.inner;
    position.source_chain == SourceChain::Solana
        && (position.source_asset == SIM_SOL_MINT.to_bytes()
            || state
                .to_account_info()
                .try_borrow_data()
                .is_ok_and(|data| PositionState::has_native_marker(&data)))
}

/// The active `SolSource`, when the caller passes it as the first remaining account.
///
/// Optional so instructions that predate the setting keep their account lists: without it the
/// legacy simSOL token applies. A passed account must be the program's own `SolSource` PDA.
pub fn active_source(remaining: &[AccountInfo]) -> Result<Option<SolSource>> {
    let Some(info) = remaining.first() else {
        return Ok(None);
    };
    require_keys_eq!(
        *info.key,
        Pubkey::find_program_address(&[SOL_SOURCE_SEED], &crate::ID).0,
        TesoroError::InvalidAccount
    );
    require_keys_eq!(*info.owner, crate::ID, TesoroError::InvalidAccount);
    Ok(Some(SolSource::try_deserialize(
        &mut &info.try_borrow_data()?[..],
    )?))
}

// --- Setting: which token new native Positions open with ---------------------------------------

/// The admin sets the staking token new Solana-native Positions open with. Existing Positions
/// keep the token they opened with.
#[derive(Accounts)]
pub struct SetSolSource<'info> {
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
        space = SolSource::SPACE,
        seeds = [SOL_SOURCE_SEED],
        bump
    )]
    pub sol_source: Account<'info, SolSource>,
    pub mint: Account<'info, Mint>,
    /// CHECK: only its address is stored; each opening validates it against the token's pool.
    pub pool: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_sol_source(ctx: Context<SetSolSource>) -> Result<()> {
    let a = ctx.accounts;
    a.sol_source.bump = ctx.bumps.sol_source;
    a.sol_source.mint = a.mint.key();
    a.sol_source.pool = a.pool.key();
    emit!(SolSourceSet {
        mint: a.mint.key(),
        pool: a.pool.key(),
    });
    Ok(())
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

// --- Open ------------------------------------------------------------------------------------

/// The owner deposits the active staking token into the Position's vault. Principal is recorded in
/// SOL at the current sim_lst rate. No oracle involved.
///
/// The token is the `SolSource` setting, passed as the first remaining account; without it, simSOL.
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
        bump = pool.bump
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
        space = PositionState::NATIVE_SPACE,
        seeds = [
            POSITION_SEED,
            &[chain_byte(SourceChain::Solana)],
            native_position_id(&owner_authority.key(), nonce).as_ref()
        ],
        bump
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        init,
        payer = owner_authority,
        space = NativeCustody::SPACE,
        seeds = [NATIVE_SEED, position.key().as_ref()],
        bump
    )]
    pub custody: Account<'info, NativeCustody>,
    #[account(
        init,
        payer = owner_authority,
        seeds = [NATIVE_VAULT_SEED, position.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = custody
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn open_native_position(
    mut ctx: Context<OpenNativePosition>,
    nonce: u64,
    lst_amount: u64,
) -> Result<()> {
    let source = active_source(ctx.remaining_accounts)?;
    let a = &mut ctx.accounts;
    if lst_amount == 0 {
        return Err(core_err(CoreError::ZeroAmount));
    }
    match source {
        Some(s) => {
            require_keys_eq!(a.mint.key(), s.mint, TesoroError::InvalidMint);
            require_keys_eq!(a.pool.key(), s.pool, TesoroError::InvalidPool);
        }
        None => require_keys_eq!(a.mint.key(), SIM_SOL_MINT, TesoroError::InvalidPool),
    }
    let rate = sim_lst::current_rate(&a.pool, now()?)?;
    let principal = native::shares_value(lst_amount, rate).map_err(core_err)?;
    let rate_bps = u16::try_from(a.pool.apy_bps).map_err(|_| error!(TesoroError::InvalidPool))?;

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
    require_eq!(a.vault.amount, lst_amount, TesoroError::InvalidAccount);

    let position_key = a.position.key();
    a.position.bump = ctx.bumps.position;
    a.position.position_id = native_position_id(&a.owner_authority.key(), nonce);
    a.position.inner = ledger::Position::new(
        a.owner_account.key().to_bytes(),
        SourceChain::Solana,
        a.mint.key().to_bytes(),
        a.mint.decimals,
        principal,
        rate_bps,
    )
    .map_err(core_err)?;

    a.position.to_account_info().try_borrow_mut_data()?[PositionState::SPACE] =
        PositionState::NATIVE_MARKER;

    a.custody.bump = ctx.bumps.custody;
    a.custody.vault_bump = ctx.bumps.vault;
    a.custody.position = position_key;
    a.custody.owner_authority = a.owner_authority.key();
    a.custody.pool = a.pool.key();
    a.custody.mint = a.mint.key();
    a.custody.vault = a.vault.key();
    a.custody.rate_at_open = rate;
    a.custody.deposited_shares = lst_amount;
    a.custody.redeemed_units = 0;
    a.custody.tracked_shares = lst_amount;
    a.custody.last_accrual_ts = now()?;

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
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized,
        constraint = is_native(&position) @ TesoroError::NotNativePosition
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        seeds = [PRICE_SEED, position.inner.source_asset.as_ref()],
        bump = price_feed.bump,
        constraint = price_feed.asset.to_bytes() == position.inner.source_asset @ TesoroError::InvalidAccount
    )]
    pub price_feed: Account<'info, PriceFeed>,
    /// Its Yield Fee sizes the Advance.
    #[account(seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
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
    let a = &mut ctx.accounts;
    let age = now()?
        .checked_sub(a.price_feed.updated_ts)
        .ok_or(TesoroError::StalePrice)?;
    require!(
        a.price_feed.price_micro_usd > 0 && (0..=MAX_PRICE_AGE_SECS).contains(&age),
        TesoroError::StalePrice
    );
    issue_advance(
        &mut a.position,
        &mut a.source,
        &mut a.holding,
        &mut a.owner_account,
        ctx.bumps.source,
        ctx.bumps.holding,
        horizon_months,
        a.price_feed.price_micro_usd,
        a.treasury.yield_fee_bps,
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
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized,
        constraint = is_native(&position) @ TesoroError::NotNativePosition
    )]
    pub position: Account<'info, PositionState>,
    /// Its Yield Fee sizes the added months.
    #[account(seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
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
    let bump = ctx.bumps.extend_limit;
    let a = ctx.accounts;
    touch_extend_limit(&mut a.extend_limit, a.owner_account.key(), bump);
    a.extend_limit
        .inner
        .record_extend(now()?, extra_months)
        .map_err(core_err)?;
    let gemas = a
        .position
        .inner
        .extend_advance(&mut a.source.inner, extra_months, a.treasury.yield_fee_bps)
        .map_err(core_err)?;
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

// --- Yield crank -----------------------------------------------------------------------------

/// Anyone can call. First mints the simulated yield the Position earned since `last_accrual_ts`
/// (`principal * apy * dt * speedup / year`) through `sim_lst::mint_yield`: the Yield Fee into the
/// treasury vault, the rest into the Position's vault. Then reads cumulative accrued yield from the
/// vault's shares (so only the Position's share counts) and applies it like the oracle's
/// `YieldAccrued`: Debt is repaid first, the rest is free yield. Nothing accrues after Unlock.
#[derive(Accounts)]
pub struct AccrueNativeYield<'info> {
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        mut,
        seeds = [NATIVE_SEED, position.key().as_ref()],
        bump = custody.bump,
        constraint = custody.position == position.key() @ TesoroError::InvalidAccount
    )]
    pub custody: Account<'info, NativeCustody>,
    #[account(mut, address = custody.vault @ TesoroError::InvalidAccount)]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = custody.pool @ TesoroError::InvalidPool)]
    pub pool: Account<'info, Pool>,
    #[account(mut, address = custody.mint @ TesoroError::InvalidMint)]
    pub mint: Account<'info, Mint>,
    /// sim_lst's record of the yield authority.
    #[account(seeds = [sim_lst::YIELD_SEED], seeds::program = sim_lst::ID, bump = yield_config.bump)]
    pub yield_config: Account<'info, sim_lst::YieldConfig>,
    /// CHECK: this program's `["yield"]` PDA; it only signs the `mint_yield` CPI.
    #[account(seeds = [YIELD_SEED], bump)]
    pub yield_authority: UncheckedAccount<'info>,
    pub sim_lst_program: Program<'info, sim_lst::program::SimLst>,
    pub token_program: Program<'info, Token>,
    /// Receives the Yield Fee.
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, address = treasury.vault @ TesoroError::InvalidAccount)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    /// The Position's open Advance, when it has one.
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Option<Account<'info, SourceState>>,
}

pub(crate) fn accrue_native_yield(mut ctx: Context<AccrueNativeYield>) -> Result<()> {
    let bump = ctx.bumps.yield_authority;
    let a = &mut ctx.accounts;
    let now = now()?;
    let rate = sim_lst::current_rate(&a.pool, now)?;
    if a.position.inner.status == ledger::PositionStatus::Locked {
        mint_accrued_yield(a, now, rate, bump)?;
    }
    apply_cumulative_yield(&mut a.position, &a.custody, a.source.as_mut(), rate)
}

/// Applies the yield the vault's tracked shares hold at `rate` to the Position (and its open
/// Advance): Debt is repaid first, the rest is free yield. Shared by the simSOL and stake pool
/// cranks; a replay or a rate that has not moved changes nothing.
pub(crate) fn apply_cumulative_yield(
    position: &mut Account<PositionState>,
    custody: &Account<NativeCustody>,
    source: Option<&mut Account<SourceState>>,
    rate: u64,
) -> Result<()> {
    let cumulative = native::accrued_yield(
        custody.tracked_shares,
        rate,
        custody.redeemed_units,
        position.inner.principal,
    )
    .map_err(core_err)?;
    if cumulative <= position.inner.cumulative_yield {
        return Ok(());
    }
    let seq = position
        .inner
        .last_seq
        .checked_add(1)
        .ok_or(TesoroError::InvalidAccount)?;
    let position_key = position.key();
    let mut source = source;
    position
        .inner
        .apply_yield(source.as_mut().map(|s| &mut s.inner), seq, cumulative)
        .map_err(core_err)?;
    emit!(YieldApplied {
        position: position_key,
        seq,
        cumulative,
        debt_gemas: source.as_ref().map_or(0, |s| s.inner.debt()),
    });
    Ok(())
}

/// Mints the yield earned since `last_accrual_ts`: the Yield Fee into the treasury vault, the rest
/// into the Position's vault. When the Position's part is under one share nothing is minted and the
/// timestamp stays put, so the time carries into the next crank instead of being lost.
fn mint_accrued_yield(a: &mut AccrueNativeYield, now: i64, rate: u64, bump: u8) -> Result<()> {
    let dt = now.saturating_sub(a.custody.last_accrual_ts);
    if dt <= 0 {
        return Ok(());
    }
    let units = sim_lst::yield_units(
        a.position.inner.principal,
        u32::from(a.position.inner.rate_bps),
        dt,
        a.pool.speedup,
    )?;
    let (keep_units, fee_units) =
        ledger::split_yield_fee(units, a.treasury.yield_fee_bps).map_err(core_err)?;
    let shares = native::shares_for_units_floor(keep_units, rate).map_err(core_err)?;
    if shares == 0 {
        return Ok(());
    }
    let fee_shares = native::shares_for_units_floor(fee_units, rate).map_err(core_err)?;
    let vault = a.vault.to_account_info();
    mint_yield_to(a, &vault, shares, bump)?;
    a.vault.reload()?;
    if fee_shares > 0 {
        let treasury_vault = a.treasury_vault.to_account_info();
        mint_yield_to(a, &treasury_vault, fee_shares, bump)?;
        a.treasury_vault.reload()?;
        let fee_value = native::shares_value(fee_shares, rate).map_err(core_err)?;
        a.treasury.fee_units = a
            .treasury
            .fee_units
            .checked_add(fee_value)
            .ok_or(TesoroError::InvalidAccount)?;
        emit!(YieldFeeTaken {
            position: a.position.key(),
            units: fee_value,
            shares: fee_shares,
        });
    }
    a.custody.tracked_shares = a
        .custody
        .tracked_shares
        .checked_add(shares)
        .ok_or(TesoroError::InvalidAccount)?;
    a.custody.last_accrual_ts = now;
    Ok(())
}

fn mint_yield_to<'info>(
    a: &AccrueNativeYield<'info>,
    destination: &AccountInfo<'info>,
    shares: u64,
    bump: u8,
) -> Result<()> {
    let seeds: &[&[u8]] = &[YIELD_SEED, &[bump]];
    sim_lst::cpi::mint_yield(
        CpiContext::new_with_signer(
            a.sim_lst_program.to_account_info(),
            sim_lst::cpi::accounts::MintYield {
                authority: a.yield_authority.to_account_info(),
                config: a.yield_config.to_account_info(),
                pool: a.pool.to_account_info(),
                mint: a.mint.to_account_info(),
                destination: destination.clone(),
                token_program: a.token_program.to_account_info(),
            },
            &[seeds],
        ),
        shares,
    )
}

// --- Payouts ---------------------------------------------------------------------------------

/// The accounts a payout needs, loaded from `remaining_accounts` for the legacy `redeem` and
/// `unlock` instructions (whose fixed accounts cannot change): `[custody, vault, destination,
/// pool, token_program]`. `pool` is the account that values the custody's token: the `sim_lst`
/// Pool, or the stake pool of a real token. A payout that lets the vault's surplus leave (Unlock,
/// sweep) of a real token adds `[treasury, treasury_vault]` so the Yield Fee on the rate's growth
/// is settled first.
pub(crate) struct Custody<'info> {
    pub custody: Account<'info, NativeCustody>,
    pub vault: Account<'info, TokenAccount>,
    pub destination: Account<'info, TokenAccount>,
    pub rate: u64,
    pub token_program: AccountInfo<'info>,
    pub fee: Option<FeeAccounts<'info>>,
}

impl Custody<'_> {
    /// Writes back what the payout changed.
    fn exit(&self) -> Result<()> {
        self.custody.exit(&crate::ID)?;
        if let Some(fee) = &self.fee {
            fee.treasury.exit(&crate::ID)?;
        }
        Ok(())
    }
}

pub(crate) fn load_custody<'info>(
    remaining: &'info [AccountInfo<'info>],
    position: &Pubkey,
    wallet: &Pubkey,
    settle_fee: bool,
) -> Result<Custody<'info>> {
    let [custody_info, vault_info, dest_info, pool_info, token_program, rest @ ..] = remaining
    else {
        return err!(TesoroError::BadRemainingAccounts);
    };
    require!(
        custody_info.is_writable && vault_info.is_writable && dest_info.is_writable,
        TesoroError::NotWritable
    );
    let custody = Account::<NativeCustody>::try_from(custody_info)?;
    let expected = Pubkey::create_program_address(
        &[NATIVE_SEED, position.as_ref(), &[custody.bump]],
        &crate::ID,
    )
    .map_err(|_| error!(TesoroError::InvalidAccount))?;
    require_keys_eq!(expected, *custody_info.key, TesoroError::InvalidAccount);
    require_keys_eq!(custody.position, *position, TesoroError::InvalidAccount);
    require_keys_eq!(*vault_info.key, custody.vault, TesoroError::InvalidAccount);
    let vault = Account::<TokenAccount>::try_from(vault_info)?;
    let destination = Account::<TokenAccount>::try_from(dest_info)?;
    require_keys_neq!(vault.key(), destination.key(), TesoroError::InvalidAccount);
    require_keys_eq!(destination.mint, custody.mint, TesoroError::InvalidMint);
    require_keys_eq!(destination.owner, *wallet, TesoroError::InvalidAccount);
    require_keys_eq!(*token_program.key, token::ID, TesoroError::InvalidAccount);
    let rate = custody_rate(&custody, pool_info)?;
    let stake_pool = stake_pool::is_stake_pool_custody(&custody);
    let fee = if stake_pool && settle_fee {
        Some(load_fee_accounts(rest)?)
    } else {
        require!(rest.is_empty(), TesoroError::BadRemainingAccounts);
        None
    };
    let mut c = Custody {
        custody,
        vault,
        destination,
        rate,
        token_program: token_program.clone(),
        fee,
    };
    c.settle_fee()?;
    Ok(c)
}

impl Custody<'_> {
    /// Takes the Yield Fee on the pool rate's growth, when this custody pays one.
    pub(crate) fn settle_fee(&mut self) -> Result<()> {
        let Some(fee) = self.fee.as_mut() else {
            return Ok(());
        };
        stake_pool::settle_yield_fee(
            &mut self.custody,
            &mut self.vault,
            &mut fee.treasury,
            &mut fee.vault,
            &self.token_program,
            self.rate,
        )
    }
}

fn pay_shares<'info>(c: &Custody<'info>, shares: u64) -> Result<()> {
    let seeds: &[&[u8]] = &[NATIVE_SEED, c.custody.position.as_ref(), &[c.custody.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            c.token_program.clone(),
            Transfer {
                from: c.vault.to_account_info(),
                to: c.destination.to_account_info(),
                authority: c.custody.to_account_info(),
            },
            &[seeds],
        ),
        shares,
    )
}

/// Pays a redeeming Gema holder `units` SOL of accrued yield, in simSOL at the current rate.
/// Never reduces below what Principal and the other holders' unredeemed yield need.
pub(crate) fn pay_redeem<'info>(
    position: &PositionState,
    position_key: &Pubkey,
    holder_authority: &Pubkey,
    units: u64,
    remaining: &'info [AccountInfo<'info>],
) -> Result<()> {
    let mut c = load_custody(remaining, position_key, holder_authority, false)?;
    let rate = c.rate;
    let shares = native::shares_for_units_floor(units, rate).map_err(core_err)?;
    if shares == 0 {
        return Err(core_err(CoreError::ZeroShares));
    }
    if c.custody.tracked_shares < shares {
        return Err(core_err(CoreError::VaultShortfall));
    }
    c.custody.redeemed_units = c
        .custody
        .redeemed_units
        .checked_add(units)
        .ok_or(TesoroError::InvalidAccount)?;
    c.custody.tracked_shares = c
        .custody
        .tracked_shares
        .checked_sub(shares)
        .ok_or(TesoroError::InvalidAccount)?;
    pay_shares(&c, shares)?;
    c.vault.reload()?;
    native::check_cover(
        c.custody.tracked_shares,
        &position.inner,
        c.custody.redeemed_units,
        rate,
    )
    .map_err(core_err)?;
    c.exit()?;
    emit!(NativePayout {
        position: *position_key,
        to: c.destination.key(),
        shares,
        sol_units: units,
        kind: 0,
    });
    Ok(())
}

/// Returns to the owner everything the vault holds beyond the yield still owed to holders.
/// The Position must already be Unlocked (Debt zero).
pub(crate) fn release_surplus<'info>(
    position: &PositionState,
    position_key: &Pubkey,
    owner_authority: &Pubkey,
    remaining: &'info [AccountInfo<'info>],
    kind: u8,
) -> Result<()> {
    let mut c = load_custody(remaining, position_key, owner_authority, true)?;
    require_keys_eq!(
        c.custody.owner_authority,
        *owner_authority,
        TesoroError::Unauthorized
    );
    release(&mut c, position, position_key, kind)
}

pub(crate) fn release<'info>(
    c: &mut Custody<'info>,
    position: &PositionState,
    position_key: &Pubkey,
    kind: u8,
) -> Result<()> {
    let rate = c.rate;
    let surplus = native::surplus_shares(
        c.vault.amount,
        &position.inner,
        c.custody.redeemed_units,
        rate,
    )
    .map_err(core_err)?;
    if surplus > 0 {
        pay_shares(c, surplus)?;
        c.vault.reload()?;
    }
    // Whatever was not tracked (simSOL sent straight to the vault) leaves with the surplus.
    c.custody.tracked_shares = c.custody.tracked_shares.min(c.vault.amount);
    native::check_cover(
        c.custody.tracked_shares,
        &position.inner,
        c.custody.redeemed_units,
        rate,
    )
    .map_err(core_err)?;
    c.exit()?;
    emit!(NativePayout {
        position: *position_key,
        to: c.destination.key(),
        shares: surplus,
        sol_units: native::shares_value(surplus, rate).map_err(core_err)?,
        kind,
    });
    Ok(())
}

/// After Unlock the owner can reclaim whatever the vault holds beyond the yield still owed
/// (the owed part is valued at the current rate, so the reserve set at unlock shrinks as the
/// rate grows and holders redeem).
#[derive(Accounts)]
pub struct SweepNativeSurplus<'info> {
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        mut,
        seeds = [NATIVE_SEED, position.key().as_ref()],
        bump = custody.bump,
        constraint = custody.position == position.key() @ TesoroError::InvalidAccount,
        constraint = custody.owner_authority == owner_authority.key() @ TesoroError::Unauthorized
    )]
    pub custody: Account<'info, NativeCustody>,
    #[account(mut, address = custody.vault @ TesoroError::InvalidAccount)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = custody.mint,
        token::authority = owner_authority
    )]
    pub owner_token: Account<'info, TokenAccount>,
    /// CHECK: the account that values the custody's token (the `sim_lst` Pool or a stake pool),
    /// checked against the custody on read. A real token adds `[treasury, treasury_vault]` as
    /// remaining accounts.
    #[account(address = custody.pool @ TesoroError::InvalidPool)]
    pub pool: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub(crate) fn sweep_native_surplus<'info>(
    ctx: Context<'_, '_, 'info, 'info, SweepNativeSurplus<'info>>,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let rate = custody_rate(&a.custody, &a.pool.to_account_info())?;
    let fee = if stake_pool::is_stake_pool_custody(&a.custody) {
        Some(load_fee_accounts(remaining)?)
    } else {
        require!(remaining.is_empty(), TesoroError::BadRemainingAccounts);
        None
    };
    let mut c = Custody {
        custody: a.custody.clone(),
        vault: a.vault.clone(),
        destination: a.owner_token.clone(),
        rate,
        token_program: a.token_program.to_account_info(),
        fee,
    };
    c.settle_fee()?;
    release(&mut c, &a.position, &a.position.key(), 2)?;
    a.custody.tracked_shares = c.custody.tracked_shares;
    Ok(())
}

// --- Migration -------------------------------------------------------------------------------

/// Extends a custody opened before `tracked_shares` (original layout) or before `last_accrual_ts`
/// (tracked layout) to the current one. Permissionless; the payer covers the extra rent. For the
/// original layout the count starts at `min(vault balance, deposited at open)`: shares paid out
/// since open only lower the balance, and the deposit caps anything added to the vault directly.
/// `last_accrual_ts` starts at the migration time: the Position earns the per-Position yield
/// from here on and keeps whatever the old rate model already gave it.
#[derive(Accounts)]
pub struct MigrateNativeCustody<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = is_native(&position) @ TesoroError::NotNativePosition
    )]
    pub position: Account<'info, PositionState>,
    /// CHECK: the custody PDA of `position`, read and resized by hand because its old layout no
    /// longer deserializes; owner, seeds, discriminator and length are checked below.
    #[account(
        mut,
        seeds = [NATIVE_SEED, position.key().as_ref()],
        bump,
        owner = crate::ID @ TesoroError::InvalidAccount
    )]
    pub custody: UncheckedAccount<'info>,
    #[account(
        seeds = [NATIVE_VAULT_SEED, position.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn migrate_native_custody(ctx: Context<MigrateNativeCustody>) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.custody.to_account_info();
    let (deposited, tracked) = {
        let data = info.try_borrow_data()?;
        let len = data.len();
        require!(
            len == NativeCustody::LEGACY_SPACE || len == NativeCustody::TRACKED_SPACE,
            TesoroError::InvalidAccount
        );
        require!(
            data[..8] == *NativeCustody::DISCRIMINATOR,
            TesoroError::InvalidAccount
        );
        let vault_key =
            Pubkey::try_from(&data[NativeCustody::VAULT_OFFSET..NativeCustody::VAULT_OFFSET + 32])
                .map_err(|_| error!(TesoroError::InvalidAccount))?;
        require_keys_eq!(vault_key, a.vault.key(), TesoroError::InvalidAccount);
        let deposited = u64::from_le_bytes(
            data[NativeCustody::DEPOSITED_OFFSET..NativeCustody::DEPOSITED_OFFSET + 8]
                .try_into()
                .map_err(|_| error!(TesoroError::InvalidAccount))?,
        );
        let tracked = if len == NativeCustody::TRACKED_SPACE {
            u64::from_le_bytes(
                data[NativeCustody::TRACKED_OFFSET..NativeCustody::TRACKED_OFFSET + 8]
                    .try_into()
                    .map_err(|_| error!(TesoroError::InvalidAccount))?,
            )
        } else {
            deposited.min(a.vault.amount)
        };
        (deposited, tracked)
    };
    let rent = Rent::get()?.minimum_balance(NativeCustody::SPACE);
    let missing = rent.saturating_sub(info.lamports());
    if missing > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                a.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: a.payer.to_account_info(),
                    to: info.clone(),
                },
            ),
            missing,
        )?;
    }
    info.resize(NativeCustody::SPACE)?;
    let mut data = info.try_borrow_mut_data()?;
    data[NativeCustody::LEGACY_SPACE..NativeCustody::TRACKED_SPACE]
        .copy_from_slice(&tracked.to_le_bytes());
    data[NativeCustody::TRACKED_SPACE..].copy_from_slice(&now()?.to_le_bytes());
    emit!(NativeCustodyMigrated {
        position: a.position.key(),
        deposited_shares: deposited,
        tracked_shares: tracked,
    });
    Ok(())
}

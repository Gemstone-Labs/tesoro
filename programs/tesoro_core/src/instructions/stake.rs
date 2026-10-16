//! Mainnet SOL Positions on a real staking token (ADR 0011 on the computed model of ADR 0010).
//!
//! * The token is a setting (`StakeConfig`); each token has one shared custody and vault
//!   (`StakeCustody`), and each Position records the token it opened with.
//! * Growth since open is the stake pool's Staking Rate now over its rate at open. The pool account
//!   is passed into every instruction that needs it, must be the custody's pool, be owned by a stake
//!   pool program and not be stale. Nothing is cranked and the keeper has no job here.
//! * Advances are priced from the on-chain Pyth mapping only and sized on the pool's last-epoch
//!   growth, annualised and capped by the admin's ceiling.
//! * Payouts (Redeem, Unlock, Instant Redeem, withdrawal) are in the staking token, converted from
//!   lamports at the rate of that moment. Nothing is minted.

use crate::error::{core_err, TesoroError};
use crate::instructions::native::{is_native, is_stake, load_source, touch_extend_limit};
use crate::instructions::position::{chain_byte, issue_advance};
use crate::ledger::{
    self, native, parse_stake_pool, CoreError, SourceChain, StakePoolRead, MAX_APY_CEILING_BPS,
};
use crate::state::*;
use crate::util::{now, require_can_advance};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

/// The stake pool programs a staking token's pool may belong to: the SPL stake pool program and
/// Sanctum's two forks. Each id was read from mainnet (an executable upgradeable program owning
/// 611-byte stake pool accounts; jitoSOL's pool is owned by the first).
pub const STAKE_POOL_PROGRAMS: [Pubkey; 3] = [
    pubkey!("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"),
    pubkey!("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY"),
    pubkey!("SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn"),
];

/// Position ids of stake Positions are derived from their owner and a nonce.
pub fn stake_position_id(owner_authority: &Pubkey, nonce: u64) -> [u8; 32] {
    hashv(&[b"stake", owner_authority.as_ref(), &nonce.to_le_bytes()]).to_bytes()
}

/// Reads and checks a stake pool account for `custody`: the custody's pool, owned by a stake pool
/// program, the token's own pool, updated recently enough.
fn read_pool(info: &AccountInfo, custody: &StakeCustody) -> Result<StakePoolRead> {
    require_keys_eq!(*info.key, custody.pool, TesoroError::BadStakePoolAccount);
    require!(
        STAKE_POOL_PROGRAMS.contains(info.owner),
        TesoroError::BadStakePoolAccount
    );
    let read = parse_stake_pool(&info.try_borrow_data()?).map_err(core_err)?;
    require!(
        read.pool_mint == custody.mint.to_bytes(),
        TesoroError::BadStakePoolAccount
    );
    read.require_fresh(Clock::get()?.epoch).map_err(core_err)?;
    Ok(read)
}

// --- Settings --------------------------------------------------------------------------------

/// Admin: makes `mint` the staking token new Positions open with, creating its custody and vault
/// the first time. `stake_pool` is the SPL stake pool account of the token; it is pinned on the
/// custody and cannot change afterwards.
#[derive(Accounts)]
pub struct SetStakeToken<'info> {
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
        space = StakeConfig::SPACE,
        seeds = [STAKE_CONFIG_SEED],
        bump
    )]
    pub stake_config: Box<Account<'info, StakeConfig>>,
    #[account(constraint = mint.decimals == 9 @ TesoroError::InvalidMint)]
    pub mint: Box<Account<'info, Mint>>,
    /// CHECK: owner, layout and mint are checked in the handler.
    pub stake_pool: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        space = StakeCustody::SPACE,
        seeds = [STAKE_CUSTODY_SEED, mint.key().as_ref()],
        bump
    )]
    pub custody: Box<Account<'info, StakeCustody>>,
    #[account(
        init_if_needed,
        payer = admin,
        seeds = [STAKE_VAULT_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = custody
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_stake_token(ctx: Context<SetStakeToken>) -> Result<()> {
    let a = ctx.accounts;
    require!(
        STAKE_POOL_PROGRAMS.contains(a.stake_pool.owner),
        TesoroError::BadStakePoolAccount
    );
    let read = parse_stake_pool(&a.stake_pool.try_borrow_data()?).map_err(core_err)?;
    require!(
        read.pool_mint == a.mint.key().to_bytes(),
        TesoroError::BadStakePoolAccount
    );
    read.rate().map_err(core_err)?;
    if a.custody.mint == Pubkey::default() {
        a.custody.bump = ctx.bumps.custody;
        a.custody.vault_bump = ctx.bumps.vault;
        a.custody.mint = a.mint.key();
        a.custody.pool = a.stake_pool.key();
        a.custody.vault = a.vault.key();
        a.custody.set_totals(ledger::StakeTotals::default());
    } else {
        require_keys_eq!(
            a.custody.pool,
            a.stake_pool.key(),
            TesoroError::BadStakePoolAccount
        );
    }
    a.stake_config.bump = ctx.bumps.stake_config;
    a.stake_config.active_mint = a.mint.key();
    emit!(StakeTokenSet {
        mint: a.mint.key(),
        pool: a.stake_pool.key(),
    });
    Ok(())
}

/// Admin: the ceiling on the annualised growth an Advance is sized on, basis points.
#[derive(Accounts)]
pub struct SetStakeApyCeiling<'info> {
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
        space = StakeConfig::SPACE,
        seeds = [STAKE_CONFIG_SEED],
        bump
    )]
    pub stake_config: Box<Account<'info, StakeConfig>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_stake_apy_ceiling(
    ctx: Context<SetStakeApyCeiling>,
    apy_ceiling_bps: u16,
) -> Result<()> {
    require!(
        (1..=MAX_APY_CEILING_BPS).contains(&apy_ceiling_bps),
        TesoroError::StakeCeilingNotSet
    );
    let a = ctx.accounts;
    a.stake_config.bump = ctx.bumps.stake_config;
    a.stake_config.apy_ceiling_bps = apy_ceiling_bps;
    emit!(StakeApyCeilingSet { apy_ceiling_bps });
    Ok(())
}

// --- Open ------------------------------------------------------------------------------------

/// The owner deposits `shares` of the active staking token into the shared vault. Principal is
/// recorded in lamports at the pool's Staking Rate now. A Player holding plain SOL puts the pool's
/// `DepositSol` in front of this instruction in the same transaction, so the whole thing reverts
/// when the deposit mints fewer tokens than `shares`.
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct OpenStakePosition<'info> {
    #[account(mut)]
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Box<Account<'info, TesoroAccount>>,
    #[account(seeds = [STAKE_CONFIG_SEED], bump = stake_config.bump)]
    pub stake_config: Box<Account<'info, StakeConfig>>,
    #[account(address = stake_config.active_mint @ TesoroError::StakeTokenInactive)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        seeds = [STAKE_CUSTODY_SEED, mint.key().as_ref()],
        bump = custody.bump
    )]
    pub custody: Box<Account<'info, StakeCustody>>,
    #[account(mut, address = custody.vault @ TesoroError::InvalidAccount)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = owner_authority
    )]
    pub owner_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: the custody's stake pool; checked by `read_pool`.
    pub stake_pool: UncheckedAccount<'info>,
    /// Its Yield Fee is fixed on the Position at open.
    #[account(seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(
        init,
        payer = owner_authority,
        space = PositionState::SPACE,
        seeds = [
            POSITION_SEED,
            &[chain_byte(SourceChain::Solana)],
            stake_position_id(&owner_authority.key(), nonce).as_ref()
        ],
        bump
    )]
    pub position: Box<Account<'info, PositionState>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn open_stake_position(
    ctx: Context<OpenStakePosition>,
    nonce: u64,
    shares: u64,
) -> Result<()> {
    let a = ctx.accounts;
    if shares == 0 {
        return Err(core_err(CoreError::ZeroAmount));
    }
    let read = read_pool(&a.stake_pool.to_account_info(), &a.custody)?;
    let rate = read.rate().map_err(core_err)?;
    let principal = ledger::principal_for_shares(shares, rate).map_err(core_err)?;
    let sizing = read
        .sizing_apy_bps(a.stake_config.apy_ceiling_bps)
        .map_err(core_err)?;

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
        shares,
    )?;
    a.vault.reload()?;
    require_eq!(
        a.vault.amount,
        before
            .checked_add(shares)
            .ok_or(TesoroError::InvalidAccount)?,
        TesoroError::InvalidAccount
    );

    let position_key = a.position.key();
    a.position.bump = ctx.bumps.position;
    a.position.position_id = stake_position_id(&a.owner_authority.key(), nonce);
    a.position.inner = ledger::Position::new(
        a.owner_account.key().to_bytes(),
        SourceChain::Solana,
        a.mint.key().to_bytes(),
        a.mint.decimals,
        principal,
        sizing,
    )
    .map_err(core_err)?;
    a.position.inner.opened_at = now()?;
    a.position.inner.custody_shares = shares;
    a.position.inner.yield_fee_bps = a.treasury.yield_fee_bps;
    a.position.inner.stake_rate_open = rate;

    let mut totals = a.custody.totals();
    totals
        .add_position(shares, principal, a.treasury.yield_fee_bps)
        .map_err(core_err)?;
    a.custody.set_totals(totals);

    emit!(StakePositionOpened {
        position: position_key,
        owner: a.owner_account.key(),
        mint: a.mint.key(),
        shares,
        rate,
        principal_sol: principal,
    });
    Ok(())
}

// --- Advance and Extend ----------------------------------------------------------------------

/// An Advance against a stake Position, priced from the asset's Pyth feed (the mapping is keyed by
/// the token's mint) and sized on the pool's recent growth under the admin's ceiling. The owner
/// signs alone. The keeper's `PriceFeed` and the oracle's `take_advance` cannot reach a stake
/// Position.
#[derive(Accounts)]
pub struct TakeStakeAdvance<'info> {
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
        constraint = is_stake(&position.inner) @ TesoroError::NotStakePosition
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        seeds = [ONCHAIN_PRICE_SEED, position.inner.source_asset.as_ref()],
        bump = onchain_price.bump
    )]
    pub onchain_price: Account<'info, OnchainPrice>,
    /// CHECK: address, owner, layout and feed id are checked against `onchain_price` on read.
    #[account(address = onchain_price.feed @ TesoroError::BadPriceFeed)]
    pub price_feed: UncheckedAccount<'info>,
    #[account(seeds = [STAKE_CONFIG_SEED], bump = stake_config.bump)]
    pub stake_config: Box<Account<'info, StakeConfig>>,
    #[account(
        seeds = [STAKE_CUSTODY_SEED, position.inner.source_asset.as_ref()],
        bump = custody.bump
    )]
    pub custody: Box<Account<'info, StakeCustody>>,
    /// CHECK: the custody's stake pool; checked by `read_pool`.
    pub stake_pool: UncheckedAccount<'info>,
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

/// The APY an Advance is sized on: the pool's last-epoch growth annualised, under the ceiling.
/// Refuses when there is none to size on.
fn sizing(read: &StakePoolRead, config: &StakeConfig) -> Result<u16> {
    require!(config.apy_ceiling_bps > 0, TesoroError::StakeCeilingNotSet);
    let apy = read
        .sizing_apy_bps(config.apy_ceiling_bps)
        .map_err(core_err)?;
    if apy == 0 {
        return Err(core_err(CoreError::NoStakingGrowth));
    }
    Ok(apy)
}

pub(crate) fn take_stake_advance(
    mut ctx: Context<TakeStakeAdvance>,
    horizon_months: u8,
) -> Result<()> {
    let a = &mut ctx.accounts;
    require_can_advance(&a.protections.to_account_info())?;
    let ts = now()?;
    let price = a.onchain_price.read(&a.price_feed.to_account_info(), ts)?;
    let read = read_pool(&a.stake_pool.to_account_info(), &a.custody)?;
    let rate = read.rate().map_err(core_err)?;
    let apy = sizing(&read, &a.stake_config)?;
    let net = ledger::stake_position_accrued(&a.position.inner, rate).map_err(core_err)?;
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
    a.position.inner.rate_bps = apy;
    issue_advance(
        &mut a.position,
        &mut a.source,
        &mut a.holding,
        &mut a.owner_account,
        ctx.bumps.source,
        ctx.bumps.holding,
        horizon_months,
        price,
        fee,
    )
}

/// Adds months to a stake Position's open Advance, sized as an Advance is.
#[derive(Accounts)]
pub struct ExtendStakeAdvance<'info> {
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
        constraint = is_stake(&position.inner) @ TesoroError::NotStakePosition
    )]
    pub position: Account<'info, PositionState>,
    #[account(seeds = [STAKE_CONFIG_SEED], bump = stake_config.bump)]
    pub stake_config: Box<Account<'info, StakeConfig>>,
    #[account(
        seeds = [STAKE_CUSTODY_SEED, position.inner.source_asset.as_ref()],
        bump = custody.bump
    )]
    pub custody: Box<Account<'info, StakeCustody>>,
    /// CHECK: the custody's stake pool; checked by `read_pool`.
    pub stake_pool: UncheckedAccount<'info>,
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

pub(crate) fn extend_stake_advance(
    ctx: Context<ExtendStakeAdvance>,
    extra_months: u8,
) -> Result<()> {
    require_can_advance(&ctx.accounts.protections.to_account_info())?;
    let bump = ctx.bumps.extend_limit;
    let a = ctx.accounts;
    let ts = now()?;
    touch_extend_limit(&mut a.extend_limit, a.owner_account.key(), bump);
    a.extend_limit
        .inner
        .record_extend(ts, extra_months)
        .map_err(core_err)?;
    let read = read_pool(&a.stake_pool.to_account_info(), &a.custody)?;
    let rate = read.rate().map_err(core_err)?;
    let apy = sizing(&read, &a.stake_config)?;
    let net = ledger::stake_position_accrued(&a.position.inner, rate).map_err(core_err)?;
    let fee = a.position.inner.yield_fee_bps;
    let mut source =
        native::source_view(&a.position.inner, &a.source.inner, net.net).map_err(core_err)?;
    a.position.inner.rate_bps = apy;
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

// --- Remaining accounts of redeem, unlock, return_own, redeem_treasury -----------------------
//
// A stake Position adds `[custody, stake_pool, ...]` after the fixed accounts of the generic
// instructions (see each function for the tail).

/// A loaded custody and the pool's read: what every payout needs.
pub(crate) struct StakeNow<'info> {
    pub custody: Account<'info, StakeCustody>,
    pub rate: u64,
}

fn load_stake<'info>(
    custody_info: &'info AccountInfo<'info>,
    pool_info: &AccountInfo,
    mint: &[u8; 32],
) -> Result<StakeNow<'info>> {
    let custody = Account::<StakeCustody>::try_from(custody_info)?;
    let expected = Pubkey::create_program_address(
        &[STAKE_CUSTODY_SEED, custody.mint.as_ref(), &[custody.bump]],
        &crate::ID,
    )
    .map_err(|_| error!(TesoroError::InvalidAccount))?;
    require_keys_eq!(expected, *custody_info.key, TesoroError::InvalidAccount);
    require!(custody.mint.to_bytes() == *mint, TesoroError::InvalidMint);
    let read = read_pool(pool_info, &custody)?;
    let rate = read.rate().map_err(core_err)?;
    Ok(StakeNow { custody, rate })
}

/// Sends `tokens` from the custody's vault, signed by the custody PDA.
fn pay_tokens<'info>(
    custody: &Account<'info, StakeCustody>,
    vault: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    tokens: u64,
) -> Result<()> {
    require_keys_eq!(*vault.key, custody.vault, TesoroError::InvalidAccount);
    require_keys_eq!(*token_program.key, token::ID, TesoroError::InvalidAccount);
    require!(vault.is_writable, TesoroError::NotWritable);
    let seeds: &[&[u8]] = &[STAKE_CUSTODY_SEED, custody.mint.as_ref(), &[custody.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.clone(),
            Transfer {
                from: vault.clone(),
                to: destination.clone(),
                authority: custody.to_account_info(),
            },
            &[seeds],
        ),
        tokens,
    )
}

fn wallet_token<'info>(
    info: &'info AccountInfo<'info>,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Result<Account<'info, TokenAccount>> {
    require!(info.is_writable, TesoroError::NotWritable);
    let t = Account::<TokenAccount>::try_from(info)?;
    require_keys_eq!(t.mint, *mint, TesoroError::InvalidMint);
    require_keys_eq!(t.owner, *owner, TesoroError::InvalidAccount);
    Ok(t)
}

/// `redeem` of a stake Source. `remaining`: `[custody, stake_pool, vault, holder_token,
/// token_program]`. The Source is brought to its derived state first; the Gemas' value is paid in
/// tokens at the rate of this moment.
#[allow(clippy::too_many_arguments)]
pub(crate) fn redeem_stake<'info>(
    position: &PositionState,
    position_key: &Pubkey,
    source: &mut SourceState,
    holder_account: &mut TesoroAccount,
    holding: &mut HoldingState,
    holder_authority: &Pubkey,
    amount: u64,
    remaining: &'info [AccountInfo<'info>],
) -> Result<u64> {
    let [custody_info, pool_info, vault, dest_info, token_program] = remaining else {
        return err!(TesoroError::BadRemainingAccounts);
    };
    let st = load_stake(custody_info, pool_info, &position.inner.source_asset)?;
    let dest = wallet_token(dest_info, &st.custody.mint, holder_authority)?;
    let net = ledger::stake_position_accrued(&position.inner, st.rate).map_err(core_err)?;
    source.inner =
        native::source_view(&position.inner, &source.inner, net.net).map_err(core_err)?;
    let units = ledger::redeem(
        &mut source.inner,
        &mut holder_account.inner,
        &mut holding.inner,
        amount,
    )
    .map_err(core_err)?;
    let tokens = ledger::tokens_for_units(units, st.rate).map_err(core_err)?;
    if tokens == 0 {
        return Err(core_err(CoreError::ZeroShares));
    }
    pay_tokens(
        &st.custody,
        vault,
        &dest.to_account_info(),
        token_program,
        tokens,
    )?;
    emit!(StakePayout {
        position: *position_key,
        to: dest.key(),
        shares: tokens,
        sol_units: units,
        kind: 0,
    });
    Ok(units)
}

/// `redeem_treasury` of a stake Source: the Gemas' value stays in the vault and joins the
/// Treasury's balance. `remaining`: `[custody (writable), stake_pool]`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn redeem_treasury_stake<'info>(
    position: &PositionState,
    source: &mut SourceState,
    treasury_account: &mut TesoroAccount,
    treasury_holding: &mut HoldingState,
    amount: u64,
    remaining: &'info [AccountInfo<'info>],
) -> Result<u64> {
    let [custody_info, pool_info] = remaining else {
        return err!(TesoroError::BadRemainingAccounts);
    };
    require!(custody_info.is_writable, TesoroError::NotWritable);
    let mut st = load_stake(custody_info, pool_info, &position.inner.source_asset)?;
    let net = ledger::stake_position_accrued(&position.inner, st.rate).map_err(core_err)?;
    source.inner =
        native::source_view(&position.inner, &source.inner, net.net).map_err(core_err)?;
    let units = ledger::redeem(
        &mut source.inner,
        &mut treasury_account.inner,
        &mut treasury_holding.inner,
        amount,
    )
    .map_err(core_err)?;
    let tokens = ledger::tokens_for_units(units, st.rate).map_err(core_err)?;
    st.custody.refilled_shares = st
        .custody
        .refilled_shares
        .checked_add(tokens)
        .ok_or(TesoroError::InvalidAccount)?;
    st.custody.exit(&crate::ID)?;
    Ok(units)
}

/// `unlock` of a stake Position. `remaining`: `[custody (writable), stake_pool, vault (writable),
/// owner_token (writable), token_program]`, then the open Advance's Source when the Position has
/// one. Debt is computed here and must be zero; Principal and the free yield return in tokens.
pub(crate) fn unlock_stake_position<'info>(
    position: &mut Account<PositionState>,
    owner_authority: &Pubkey,
    remaining: &'info [AccountInfo<'info>],
) -> Result<()> {
    let [custody_info, pool_info, vault, dest_info, token_program, tail @ ..] = remaining else {
        return err!(TesoroError::BadRemainingAccounts);
    };
    require!(custody_info.is_writable, TesoroError::NotWritable);
    let mut st = load_stake(custody_info, pool_info, &position.inner.source_asset)?;
    let dest = wallet_token(dest_info, &st.custody.mint, owner_authority)?;
    let position_key = position.key();
    let net = ledger::stake_position_accrued(&position.inner, st.rate).map_err(core_err)?;
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
    let fee_tokens = ledger::tokens_for_units(net.fee, st.rate).map_err(core_err)?;
    let mut totals = st.custody.totals();
    totals
        .remove_position(
            shares,
            position.inner.principal,
            position.inner.yield_fee_bps,
            fee_tokens,
        )
        .map_err(core_err)?;
    st.custody.set_totals(totals);
    position.inner.custody_shares = 0;
    st.custody.exit(&crate::ID)?;

    let principal_tokens =
        ledger::unlock_tokens(position.inner.principal, 0, shares, st.rate).map_err(core_err)?;
    let total_tokens =
        ledger::unlock_tokens(position.inner.principal, free, shares, st.rate).map_err(core_err)?;
    pay_tokens(
        &st.custody,
        vault,
        &dest.to_account_info(),
        token_program,
        total_tokens,
    )?;
    emit!(StakePayout {
        position: position_key,
        to: dest.key(),
        shares: principal_tokens,
        sol_units: position.inner.principal,
        kind: 1,
    });
    if free > 0 && total_tokens > principal_tokens {
        emit!(StakePayout {
            position: position_key,
            to: dest.key(),
            shares: total_tokens - principal_tokens,
            sol_units: free,
            kind: 2,
        });
    }
    Ok(())
}

/// `return_own` of a stake Source. `remaining`: `[custody, stake_pool]`.
pub(crate) fn return_own_stake_source<'info>(
    position: &mut PositionState,
    source: &mut SourceState,
    account: &mut TesoroAccount,
    holding: &mut HoldingState,
    amount: u64,
    remaining: &'info [AccountInfo<'info>],
) -> Result<()> {
    let [custody_info, pool_info] = remaining else {
        return err!(TesoroError::BadRemainingAccounts);
    };
    let st = load_stake(custody_info, pool_info, &position.inner.source_asset)?;
    let net = ledger::stake_position_accrued(&position.inner, st.rate).map_err(core_err)?;
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

// --- Treasury --------------------------------------------------------------------------------

/// Creates the Treasury (config and Treasury Account, no simSOL vault) or changes its fee rates,
/// for a deployment without `sim_lst`. The Yield Fee it names is copied onto every Position.
#[derive(Accounts)]
pub struct InitTreasuryStake<'info> {
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
        space = Treasury::SPACE,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = TesoroAccount::SPACE,
        seeds = [ACCOUNT_SEED, treasury.key().as_ref()],
        bump
    )]
    pub treasury_account: Box<Account<'info, TesoroAccount>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn init_treasury_stake(
    ctx: Context<InitTreasuryStake>,
    yield_fee_bps: u16,
    instant_fee_bps: u16,
) -> Result<()> {
    if yield_fee_bps > ledger::MAX_YIELD_FEE_BPS || instant_fee_bps > ledger::MAX_INSTANT_FEE_BPS {
        return Err(core_err(CoreError::InvalidBps));
    }
    let treasury_key = ctx.accounts.treasury.key();
    let account = &mut ctx.accounts.treasury_account;
    if account.authority == Pubkey::default() {
        account.bump = ctx.bumps.treasury_account;
        account.authority = treasury_key;
        account.evm_address = [0; 20];
        account.inner = Default::default();
    }
    let account_key = account.key();
    let t = &mut ctx.accounts.treasury;
    t.bump = ctx.bumps.treasury;
    t.account_bump = ctx.bumps.treasury_account;
    t.yield_fee_bps = yield_fee_bps;
    t.instant_fee_bps = instant_fee_bps;
    t.account = account_key;
    Ok(())
}

/// Instant Redeem of won Gemas of a stake Source: the Treasury's balance in the token (the earned
/// Yield Fee plus what it redeemed, less what it paid, never below the Principal reserve) pays the
/// holder in the same transaction, or the instruction fails (`TreasuryShort`).
#[derive(Accounts)]
pub struct InstantRedeemStake<'info> {
    #[account(mut)]
    pub holder_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, holder_authority.key().as_ref()],
        bump = holder_account.bump
    )]
    pub holder_account: Box<Account<'info, TesoroAccount>>,
    #[account(
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = is_stake(&position.inner) @ TesoroError::NotStakePosition
    )]
    pub position: Box<Account<'info, PositionState>>,
    #[account(
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Box<Account<'info, SourceState>>,
    #[account(
        mut,
        seeds = [HOLDING_SEED, holder_account.key().as_ref(), source.key().as_ref()],
        bump = holding.bump
    )]
    pub holding: Box<Account<'info, HoldingState>>,
    #[account(seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, treasury.key().as_ref()],
        bump = treasury.account_bump
    )]
    pub treasury_account: Box<Account<'info, TesoroAccount>>,
    #[account(
        init_if_needed,
        payer = holder_authority,
        space = HoldingState::SPACE,
        seeds = [HOLDING_SEED, treasury_account.key().as_ref(), source.key().as_ref()],
        bump
    )]
    pub treasury_holding: Box<Account<'info, HoldingState>>,
    #[account(
        mut,
        seeds = [STAKE_CUSTODY_SEED, position.inner.source_asset.as_ref()],
        bump = custody.bump
    )]
    pub custody: Box<Account<'info, StakeCustody>>,
    #[account(mut, address = custody.vault @ TesoroError::InvalidAccount)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = custody.mint,
        token::authority = holder_authority
    )]
    pub holder_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: the custody's stake pool; checked by `read_pool`.
    pub stake_pool: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn instant_redeem_stake(ctx: Context<InstantRedeemStake>, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    let treasury_account_key = a.treasury_account.key();
    let source_key = a.source.key();
    crate::instructions::treasury::open_treasury_holding(
        &mut a.treasury_holding,
        ctx.bumps.treasury_holding,
        &treasury_account_key,
        &source_key,
    );
    let read = read_pool(&a.stake_pool.to_account_info(), &a.custody)?;
    let rate = read.rate().map_err(core_err)?;
    let net = ledger::stake_position_accrued(&a.position.inner, rate).map_err(core_err)?;
    let view =
        native::source_view(&a.position.inner, &a.source.inner, net.net).map_err(core_err)?;
    let (units, payout) = crate::instructions::treasury::sell_to_treasury(
        &a.treasury,
        &view,
        &mut a.holder_account,
        &mut a.holding,
        &mut a.treasury_account,
        &mut a.treasury_holding,
        amount,
    )?;
    let tokens = ledger::tokens_for_units(payout, rate).map_err(core_err)?;
    if tokens == 0 {
        return Err(core_err(CoreError::ZeroShares));
    }
    let balance = a.custody.treasury_balance(rate, a.vault.amount)?;
    require!(tokens <= balance, TesoroError::TreasuryShort);
    a.custody.instant_shares = a
        .custody
        .instant_shares
        .checked_add(tokens)
        .ok_or(TesoroError::InvalidAccount)?;
    pay_tokens(
        &a.custody,
        &a.vault.to_account_info(),
        &a.holder_token.to_account_info(),
        &a.token_program.to_account_info(),
        tokens,
    )?;
    emit!(StakePayout {
        position: a.position.key(),
        to: a.holder_token.key(),
        shares: tokens,
        sol_units: payout,
        kind: 3,
    });
    emit!(InstantRedeemed {
        position: a.position.key(),
        source: source_key,
        account: a.holder_account.key(),
        gemas: amount,
        source_units: units,
        payout_units: payout,
    });
    Ok(())
}

/// The admin withdraws `amount` lamports of value of the Treasury balance, in the token, to the
/// company wallet's token account. Refused (`TreasuryShort`) beyond the balance.
#[derive(Accounts)]
pub struct WithdrawTreasuryStake<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(
        mut,
        seeds = [STAKE_CUSTODY_SEED, custody.mint.as_ref()],
        bump = custody.bump
    )]
    pub custody: Box<Account<'info, StakeCustody>>,
    #[account(mut, address = custody.vault @ TesoroError::InvalidAccount)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = custody.mint)]
    pub company_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: the custody's stake pool; checked by `read_pool`.
    pub stake_pool: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub(crate) fn withdraw_treasury_stake(
    ctx: Context<WithdrawTreasuryStake>,
    amount: u64,
) -> Result<()> {
    let a = ctx.accounts;
    if amount == 0 {
        return Err(core_err(CoreError::ZeroAmount));
    }
    require!(
        a.treasury.company != Pubkey::default(),
        TesoroError::CompanyNotSet
    );
    require_keys_eq!(
        a.company_token.owner,
        a.treasury.company,
        TesoroError::InvalidAccount
    );
    let read = read_pool(&a.stake_pool.to_account_info(), &a.custody)?;
    let rate = read.rate().map_err(core_err)?;
    let tokens = ledger::tokens_for_units(amount, rate).map_err(core_err)?;
    if tokens == 0 {
        return Err(core_err(CoreError::ZeroShares));
    }
    let balance = a.custody.treasury_balance(rate, a.vault.amount)?;
    require!(tokens <= balance, TesoroError::TreasuryShort);
    a.custody.withdrawn_shares = a
        .custody
        .withdrawn_shares
        .checked_add(tokens)
        .ok_or(TesoroError::InvalidAccount)?;
    a.treasury.withdrawn_units = a
        .treasury
        .withdrawn_units
        .checked_add(amount)
        .ok_or(TesoroError::InvalidAccount)?;
    pay_tokens(
        &a.custody,
        &a.vault.to_account_info(),
        &a.company_token.to_account_info(),
        &a.token_program.to_account_info(),
        tokens,
    )?;
    emit!(TreasuryWithdrawn {
        company: a.treasury.company,
        units: amount,
        shares: tokens,
        minted_units: 0,
    });
    Ok(())
}

/// `is_native` and `is_stake` Positions are driven by the computed model, not by an oracle.
pub fn is_computed(position: &ledger::Position) -> bool {
    is_native(position) || is_stake(position)
}

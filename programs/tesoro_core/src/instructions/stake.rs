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
use crate::instructions::economy::*;
use crate::instructions::native::{is_native, is_stake, touch_extend_limit};
use crate::instructions::position::chain_byte;
use crate::ledger::{
    self, parse_stake_pool, CoreError, SourceChain, StakePoolRead, MAX_APY_CEILING_BPS,
};
use crate::state::*;
use crate::storage::*;
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
        a.custody.route = ledger::RouteLedger::default();
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
/// recorded in lamports at the pool's Staking Rate now. A Player with plain SOL puts the pool's
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

    a.custody.add_position(principal)?;

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
/// Position. When the Position has its previous Advance open, that Source, its book and its pages
/// are the remaining accounts.
#[derive(Accounts)]
pub struct TakeStakeAdvance<'info> {
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

pub(crate) fn take_stake_advance<'info>(
    mut ctx: Context<'_, '_, 'info, 'info, TakeStakeAdvance<'info>>,
    horizon_months: u8,
    min_gemas: u64,
) -> Result<()> {
    require_can_advance(&ctx.accounts.protections.to_account_info())?;
    let remaining = ctx.remaining_accounts;
    let (source_bump, book_bump) = (ctx.bumps.source, ctx.bumps.book);
    let a = &mut ctx.accounts;
    let ts = now()?;
    let price = a.onchain_price.read(&a.price_feed.to_account_info(), ts)?;
    let read = read_pool(&a.stake_pool.to_account_info(), &a.custody)?;
    let rate = read.rate().map_err(core_err)?;
    let apy = sizing(&read, &a.stake_config)?;
    let rates = stake_rates(&a.position.inner, rate)?;
    let fee = FeeSnapshot::now(a.position.inner.yield_fee_bps, &a.economy)?;
    a.position.inner.rate_bps = apy;
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
        price,
        fee,
        min_gemas,
    )
}

/// Adds months to a stake Position's open Advance, sized as an Advance is. Remaining accounts: the
/// Source's book and its checkpoint pages.
#[derive(Accounts)]
pub struct ExtendStakeAdvance<'info> {
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

pub(crate) fn extend_stake_advance<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExtendStakeAdvance<'info>>,
    extra_months: u8,
    min_gemas: u64,
) -> Result<()> {
    require_can_advance(&ctx.accounts.protections.to_account_info())?;
    let remaining = ctx.remaining_accounts;
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
    let rates = stake_rates(&a.position.inner, rate)?;
    a.position.inner.rate_bps = apy;
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

/// Sends `tokens` from the custody's vault, signed by the custody PDA.
pub(crate) fn pay_tokens<'info>(
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

/// The admin tops up the Treasury with `shares` of the staking token (its own funding: never a
/// Yield Fee, so nothing of it is owed to the Pool).
#[derive(Accounts)]
pub struct FundTreasuryStake<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [STAKE_CUSTODY_SEED, custody.mint.as_ref()],
        bump = custody.bump
    )]
    pub custody: Box<Account<'info, StakeCustody>>,
    #[account(mut, address = custody.vault @ TesoroError::InvalidAccount)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = custody.mint, token::authority = admin)]
    pub admin_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub(crate) fn fund_treasury_stake(ctx: Context<FundTreasuryStake>, shares: u64) -> Result<()> {
    if shares == 0 {
        return Err(core_err(CoreError::ZeroAmount));
    }
    let a = ctx.accounts;
    token::transfer(
        CpiContext::new(
            a.token_program.to_account_info(),
            Transfer {
                from: a.admin_token.to_account_info(),
                to: a.vault.to_account_info(),
                authority: a.admin.to_account_info(),
            },
        ),
        shares,
    )?;
    a.custody
        .route
        .receive(u128::from(shares))
        .map_err(core_err)?;
    emit!(TreasuryFunded { shares });
    Ok(())
}

/// The admin withdraws `amount` lamports of value of the Treasury's spendable shares, in the
/// token, to the company wallet's token account. Only what the Treasury may spend (realised fees
/// and its own funding, never shares owed to holders or the Pool): `OverSpendable` beyond that.
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
    a.custody
        .route
        .spend(u128::from(tokens))
        .map_err(core_err)?;
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

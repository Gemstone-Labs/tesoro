//! Real staking tokens as a Source (ADR 0010). On mainnet the token a native Position holds is an
//! SPL stake pool token (jitoSOL today); nothing is minted. Its SOL value is the pool's exchange
//! rate (`total_lamports / pool_token_supply`, read from the `StakePool` account), the Position's
//! yield is that rate's growth on the shares in its vault, and the Yield Fee is taken from the
//! growth in tokens, moved from the Position's vault into the Treasury's vault of that token.
//!
//! Custody and payouts are the ones in `native` (`tracked_shares * rate - principal + redeemed`);
//! only the rate's source and the fee mechanics differ, and a custody says which it uses with the
//! trailing marker `NativeCustody::STAKE_POOL_MARKER`. Test mode keeps `sim_lst` untouched.

use crate::error::{core_err, TesoroError};
use crate::instructions::native::{apply_cumulative_yield, native_position_id};
use crate::instructions::position::chain_byte;
use crate::ledger::{self, native as math, CoreError, SourceChain};
use crate::state::*;
use crate::util::now;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use sim_lst::Pool;

/// The pool's rate for `mint`: the account must be owned by a known stake pool program, be an
/// initialised `StakePool` and name `mint` as its pool mint.
pub fn pool_rate(pool: &AccountInfo, mint: &Pubkey) -> Result<u64> {
    require!(
        STAKE_POOL_PROGRAMS.contains(pool.owner),
        TesoroError::InvalidStakePool
    );
    let read = math::parse_stake_pool(&pool.try_borrow_data()?)
        .map_err(|_| error!(TesoroError::InvalidStakePool))?;
    require!(
        read.pool_mint == mint.to_bytes(),
        TesoroError::InvalidStakePool
    );
    math::stake_pool_rate(read.total_lamports, read.pool_token_supply).map_err(core_err)
}

/// The `sim_lst` Pool in `pool`: owned by that program and carrying its discriminator.
fn load_sim_pool(pool: &AccountInfo) -> Result<Pool> {
    require_keys_eq!(*pool.owner, sim_lst::ID, TesoroError::InvalidPool);
    Pool::try_deserialize(&mut &pool.try_borrow_data()?[..])
}

/// The rate that values a native custody's shares: the stake pool's for a real token, the
/// `sim_lst` Pool's for simSOL. `pool` must be the account the custody recorded.
pub fn custody_rate(custody: &Account<NativeCustody>, pool: &AccountInfo) -> Result<u64> {
    require_keys_eq!(*pool.key, custody.pool, TesoroError::InvalidPool);
    if is_stake_pool_custody(custody) {
        pool_rate(pool, &custody.mint)
    } else {
        sim_lst::current_rate(&load_sim_pool(pool)?, now()?)
    }
}

/// The rate behind a token held by no custody (Instant Redeem prices the Gemas of a Position
/// whose pool is passed by the caller): the canonical `sim_lst` Pool for simSOL, otherwise a stake
/// pool of the token.
pub fn rate_for_mint(pool: &AccountInfo, mint: &Pubkey) -> Result<u64> {
    if *pool.owner == sim_lst::ID {
        require_keys_eq!(
            *pool.key,
            Pubkey::find_program_address(&[sim_lst::POOL_SEED], &sim_lst::ID).0,
            TesoroError::InvalidPool
        );
        let sim = load_sim_pool(pool)?;
        require_keys_eq!(sim.mint, *mint, TesoroError::InvalidPool);
        sim_lst::current_rate(&sim, now()?)
    } else {
        pool_rate(pool, mint)
    }
}

pub fn is_stake_pool_custody(custody: &Account<NativeCustody>) -> bool {
    custody
        .to_account_info()
        .try_borrow_data()
        .is_ok_and(|data| NativeCustody::is_stake_pool(&data))
}

/// The Treasury's vault of `mint`: the original vault (whatever token the Treasury was created
/// with) or the one at `["treasury_vault", mint]`, owned by the Treasury.
pub fn check_treasury_vault(
    treasury: &Account<Treasury>,
    vault: &Account<TokenAccount>,
    mint: &Pubkey,
) -> Result<()> {
    require_keys_eq!(vault.mint, *mint, TesoroError::InvalidMint);
    require_keys_eq!(vault.owner, treasury.key(), TesoroError::InvalidAccount);
    let canonical =
        Pubkey::find_program_address(&[TREASURY_VAULT_SEED, mint.as_ref()], &crate::ID).0;
    require!(
        vault.key() == treasury.vault || vault.key() == canonical,
        TesoroError::InvalidAccount
    );
    Ok(())
}

/// Takes the Yield Fee on the pool rate's growth since it was last settled: pool tokens move from
/// the Position's vault to the Treasury's vault of that token and leave `tracked_shares`, so the
/// Position keeps `1 - fee` of the growth. The rate high-water mark moves up with it, which makes
/// the fee settle at most once per rate and lets it run in any instruction that touches the vault.
pub fn settle_yield_fee<'info>(
    custody: &mut Account<'info, NativeCustody>,
    vault: &mut Account<'info, TokenAccount>,
    treasury: &mut Account<'info, Treasury>,
    treasury_vault: &mut Account<'info, TokenAccount>,
    token_program: &AccountInfo<'info>,
    rate: u64,
) -> Result<()> {
    check_treasury_vault(treasury, treasury_vault, &custody.mint)?;
    let info = custody.to_account_info();
    let last = NativeCustody::stake_pool_last_rate(&info.try_borrow_data()?)
        .ok_or(TesoroError::InvalidAccount)?;
    let fee_shares =
        math::yield_fee_shares(custody.tracked_shares, last, rate, treasury.yield_fee_bps)
            .map_err(core_err)?;
    if rate > last {
        NativeCustody::set_stake_pool_last_rate(&mut info.try_borrow_mut_data()?, rate);
    }
    if fee_shares == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[NATIVE_SEED, custody.position.as_ref(), &[custody.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.clone(),
            Transfer {
                from: vault.to_account_info(),
                to: treasury_vault.to_account_info(),
                authority: info,
            },
            &[seeds],
        ),
        fee_shares,
    )?;
    vault.reload()?;
    treasury_vault.reload()?;
    custody.tracked_shares = custody
        .tracked_shares
        .checked_sub(fee_shares)
        .ok_or(TesoroError::InvalidAccount)?;
    let fee_value = math::shares_value(fee_shares, rate).map_err(core_err)?;
    treasury.fee_units = treasury
        .fee_units
        .checked_add(fee_value)
        .ok_or(TesoroError::InvalidAccount)?;
    emit!(YieldFeeTaken {
        position: custody.position,
        units: fee_value,
        shares: fee_shares,
    });
    Ok(())
}

// --- Published APY ---------------------------------------------------------------------------

/// The oracle authority (the keeper) publishes the APY a staking token's new Positions are sized
/// on. Mainnet Positions take their `rate_bps` from here at open.
#[derive(Accounts)]
pub struct SetTokenApy<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.oracle_authority == oracle.key() @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = oracle,
        space = TokenApy::SPACE,
        seeds = [TOKEN_APY_SEED, mint.key().as_ref()],
        bump
    )]
    pub token_apy: Account<'info, TokenApy>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_token_apy(ctx: Context<SetTokenApy>, apy_bps: u16) -> Result<()> {
    if apy_bps > MAX_TOKEN_APY_BPS {
        return Err(core_err(CoreError::InvalidBps));
    }
    let a = ctx.accounts;
    a.token_apy.bump = ctx.bumps.token_apy;
    a.token_apy.mint = a.mint.key();
    a.token_apy.apy_bps = apy_bps;
    a.token_apy.updated_ts = now()?;
    emit!(TokenApySet {
        mint: a.mint.key(),
        apy_bps,
    });
    Ok(())
}

/// The highest APY the oracle authority can publish: 100% a year.
pub const MAX_TOKEN_APY_BPS: u16 = 10_000;

/// An Advance or Extend on a real token refuses a published APY older than this (3 days).
pub const MAX_APY_AGE_SECS: i64 = 3 * 86_400;

/// The admin sets the ceiling Advances are sized under, creating the `TokenApy` if the oracle has
/// not published yet. Publishing never touches the ceiling and the ceiling never touches the
/// published APY.
#[derive(Accounts)]
pub struct SetTokenApyCeiling<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = admin,
        space = TokenApy::SPACE,
        seeds = [TOKEN_APY_SEED, mint.key().as_ref()],
        bump
    )]
    pub token_apy: Account<'info, TokenApy>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_token_apy_ceiling(
    ctx: Context<SetTokenApyCeiling>,
    ceiling_bps: u16,
) -> Result<()> {
    if ceiling_bps > MAX_TOKEN_APY_BPS {
        return Err(core_err(CoreError::InvalidBps));
    }
    let a = ctx.accounts;
    a.token_apy.bump = ctx.bumps.token_apy;
    a.token_apy.mint = a.mint.key();
    a.token_apy.ceiling_bps = ceiling_bps;
    emit!(TokenApyCeilingSet {
        mint: a.mint.key(),
        ceiling_bps,
    });
    Ok(())
}

/// Re-reads the sizing APY of a real token into the Position before an Advance or Extend, so they
/// follow the trailing APY under the ceiling. A simSOL Position keeps its fixed rate and needs no
/// account. For a real token the `TokenApy` of its mint is the first remaining account (it cannot
/// be left out), the published APY must be fresh and the ceiling set.
pub fn refresh_position_rate(
    position: &mut Account<PositionState>,
    remaining: &[AccountInfo],
) -> Result<()> {
    if position.inner.source_asset == SIM_SOL_MINT.to_bytes() {
        return Ok(());
    }
    let info = remaining.first().ok_or(TesoroError::BadRemainingAccounts)?;
    require_keys_eq!(
        *info.key,
        Pubkey::find_program_address(&[TOKEN_APY_SEED, &position.inner.source_asset], &crate::ID).0,
        TesoroError::InvalidAccount
    );
    require_keys_eq!(*info.owner, crate::ID, TesoroError::InvalidAccount);
    let apy = TokenApy::try_deserialize(&mut &info.try_borrow_data()?[..])?;
    let age = now()?.saturating_sub(apy.updated_ts);
    require!(age <= MAX_APY_AGE_SECS, TesoroError::StaleApy);
    require!(apy.ceiling_bps > 0, TesoroError::ApyCeilingNotSet);
    position.inner.rate_bps = apy.effective_bps();
    Ok(())
}

// --- Treasury vault of a token ---------------------------------------------------------------

/// Creates the Treasury's vault of one more token (`["treasury_vault", mint]`), where the Yield
/// Fee of that token's Positions lands and Instant Redeems of its Gemas are paid from. Treasuries
/// start empty and nobody seeds them.
#[derive(Accounts)]
pub struct InitTreasuryVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = admin,
        seeds = [TREASURY_VAULT_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = treasury
    )]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn init_treasury_vault(_ctx: Context<InitTreasuryVault>) -> Result<()> {
    Ok(())
}

// --- Open ------------------------------------------------------------------------------------

/// Opens a Position with the active staking token: the `SolSource` setting names the mint and the
/// stake pool, and both are required here, so a real token can never open without the setting.
/// Principal is the deposited tokens at the pool's rate; `rate_bps` is the token's published APY.
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct OpenStakePoolPosition<'info> {
    #[account(mut)]
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(seeds = [SOL_SOURCE_SEED], bump = sol_source.bump)]
    pub sol_source: Account<'info, SolSource>,
    #[account(
        seeds = [TOKEN_APY_SEED, mint.key().as_ref()],
        bump = token_apy.bump
    )]
    pub token_apy: Account<'info, TokenApy>,
    /// CHECK: the stake pool the setting names; owner, type and pool mint are checked on read.
    #[account(address = sol_source.pool @ TesoroError::InvalidPool)]
    pub pool: UncheckedAccount<'info>,
    #[account(address = sol_source.mint @ TesoroError::InvalidMint)]
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
        space = NativeCustody::STAKE_POOL_SPACE,
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

pub(crate) fn open_stake_pool_position(
    mut ctx: Context<OpenStakePoolPosition>,
    nonce: u64,
    token_amount: u64,
) -> Result<()> {
    let a = &mut ctx.accounts;
    if token_amount == 0 {
        return Err(core_err(CoreError::ZeroAmount));
    }
    let rate = pool_rate(&a.pool.to_account_info(), &a.mint.key())?;
    let principal = math::shares_value(token_amount, rate).map_err(core_err)?;

    token::transfer(
        CpiContext::new(
            a.token_program.to_account_info(),
            Transfer {
                from: a.owner_token.to_account_info(),
                to: a.vault.to_account_info(),
                authority: a.owner_authority.to_account_info(),
            },
        ),
        token_amount,
    )?;
    a.vault.reload()?;
    require_eq!(a.vault.amount, token_amount, TesoroError::InvalidAccount);

    let position_key = a.position.key();
    a.position.bump = ctx.bumps.position;
    a.position.position_id = native_position_id(&a.owner_authority.key(), nonce);
    a.position.inner = ledger::Position::new(
        a.owner_account.key().to_bytes(),
        SourceChain::Solana,
        a.mint.key().to_bytes(),
        a.mint.decimals,
        principal,
        a.token_apy.effective_bps(),
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
    a.custody.deposited_shares = token_amount;
    a.custody.redeemed_units = 0;
    a.custody.tracked_shares = token_amount;
    a.custody.last_accrual_ts = now()?;
    {
        let info = a.custody.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        data[NativeCustody::SPACE] = NativeCustody::STAKE_POOL_MARKER;
        NativeCustody::set_stake_pool_last_rate(&mut data, rate);
    }

    emit!(NativePositionOpened {
        position: position_key,
        owner: a.owner_account.key(),
        shares: token_amount,
        rate,
        principal_sol: principal,
    });
    Ok(())
}

// --- Yield crank -----------------------------------------------------------------------------

/// Anyone can call. Reads the pool's rate, takes the Yield Fee on its growth into the Treasury's
/// vault of the token, then applies the Position's yield (`tracked_shares * rate - principal +
/// redeemed`) like `accrue_native_yield` does: Debt is repaid first, the rest is free yield.
#[derive(Accounts)]
pub struct AccrueStakePoolYield<'info> {
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
    /// CHECK: the stake pool the custody recorded; owner, type and pool mint are checked on read.
    #[account(address = custody.pool @ TesoroError::InvalidPool)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    /// The Position's open Advance, when it has one.
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Option<Account<'info, SourceState>>,
}

pub(crate) fn accrue_stake_pool_yield(mut ctx: Context<AccrueStakePoolYield>) -> Result<()> {
    let a = &mut ctx.accounts;
    require!(
        is_stake_pool_custody(&a.custody),
        TesoroError::InvalidAccount
    );
    let rate = pool_rate(&a.pool.to_account_info(), &a.custody.mint)?;
    settle_yield_fee(
        &mut a.custody,
        &mut a.vault,
        &mut a.treasury,
        &mut a.treasury_vault,
        &a.token_program.to_account_info(),
        rate,
    )?;
    apply_cumulative_yield(&mut a.position, &a.custody, a.source.as_mut(), rate)
}

/// The accounts an owner's Unlock or sweep adds for a stake pool custody: `[treasury,
/// treasury_vault]`, because the surplus leaves with the rate growth since the fee was settled.
pub struct FeeAccounts<'info> {
    pub treasury: Account<'info, Treasury>,
    pub vault: Account<'info, TokenAccount>,
}

pub fn load_fee_accounts<'info>(infos: &'info [AccountInfo<'info>]) -> Result<FeeAccounts<'info>> {
    let [treasury_info, vault_info] = infos else {
        return err!(TesoroError::BadRemainingAccounts);
    };
    require!(
        treasury_info.is_writable && vault_info.is_writable,
        TesoroError::NotWritable
    );
    require_keys_eq!(
        *treasury_info.key,
        Pubkey::find_program_address(&[TREASURY_SEED], &crate::ID).0,
        TesoroError::InvalidAccount
    );
    Ok(FeeAccounts {
        treasury: Account::try_from(treasury_info)?,
        vault: Account::try_from(vault_info)?,
    })
}

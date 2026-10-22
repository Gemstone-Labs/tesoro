//! The Treasury (CONTEXT.md, ADR 0007): Tesoro's Yield Fee and Instant Redeem.
//!
//! * The Yield Fee is taken when yield is cashed out (ticket 31) and joins the custody's route as
//!   the Treasury's shares (native: virtual until minted). The Treasury's balance is the route's
//!   spendable shares; `pay_from_treasury` takes the simSOL vault first and mints the rest. EVM
//!   vaults keep their fee at the source.
//! * Instant Redeem: a holder sells won Gemas to the Treasury Account for their value less the
//!   Instant Redeem Fee. On Solana the treasury vault pays in the same transaction
//!   (`instant_redeem`); for EVM Sources the bridge records the payout and the vault's treasury pays
//!   it (`instant_redeem_from_source`, co-signed by the chain's source authority).
//! * The Treasury Account later redeems those Gemas through the normal Redeem rules
//!   (`redeem_treasury`, `redeem_treasury_from_source`), which refills the treasury on that chain.
//!   That redeem is not exempt: it is where the Yield Fee on bought Gemas is realised, with the
//!   Pool's half and its fifth of the Instant fee.

use crate::books::OnchainBooks;
use crate::error::{core_err, TesoroError};
use crate::instructions::economy::*;
use crate::instructions::native::{is_native, is_stake};
use crate::instructions::position::chain_byte;
use crate::ledger::{self, native, SourceChain, MAX_INSTANT_FEE_BPS, MAX_YIELD_FEE_BPS};
use crate::state::*;
use crate::storage::*;
use crate::util::now;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use sim_lst::program::SimLst;
use sim_lst::Pool;

// --- Setup -----------------------------------------------------------------------------------

/// Creates the Treasury (config, Treasury Account, simSOL vault) or changes its fee rates.
#[derive(Accounts)]
pub struct InitTreasury<'info> {
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
    #[account(address = SIM_SOL_MINT @ TesoroError::InvalidMint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = admin,
        seeds = [TREASURY_VAULT_SEED],
        bump,
        token::mint = mint,
        token::authority = treasury
    )]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn init_treasury(
    ctx: Context<InitTreasury>,
    yield_fee_bps: u16,
    instant_fee_bps: u16,
) -> Result<()> {
    if yield_fee_bps > MAX_YIELD_FEE_BPS || instant_fee_bps > MAX_INSTANT_FEE_BPS {
        return Err(core_err(ledger::CoreError::InvalidBps));
    }
    crate::instructions::admin::require_studio_exemption_safe(
        yield_fee_bps,
        ctx.accounts.config.platform_bps,
        ctx.accounts.config.leaderboard_bps,
    )?;
    let treasury_key = ctx.accounts.treasury.key();
    let account = &mut ctx.accounts.treasury_account;
    if account.authority == Pubkey::default() {
        account.bump = ctx.bumps.treasury_account;
        account.authority = treasury_key;
        account.evm_address = [0; 20];
    }
    let account_key = account.key();
    let vault_key = ctx.accounts.treasury_vault.key();
    let t = &mut ctx.accounts.treasury;
    t.bump = ctx.bumps.treasury;
    t.vault_bump = ctx.bumps.treasury_vault;
    t.account_bump = ctx.bumps.treasury_account;
    t.yield_fee_bps = yield_fee_bps;
    t.instant_fee_bps = instant_fee_bps;
    t.account = account_key;
    t.vault = vault_key;
    Ok(())
}

/// The admin tops up the Treasury's simSOL vault: real tokens that are the Treasury's own (never a
/// Yield Fee, so nothing of it is owed to the Pool). Instant Redeem fills and withdrawals draw on
/// the vault first.
#[derive(Accounts)]
pub struct FundTreasury<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, seeds = [NATIVE_SEED], bump = custody.bump)]
    pub custody: Box<Account<'info, NativeCustody>>,
    #[account(mut, address = treasury.vault @ TesoroError::InvalidAccount)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = SIM_SOL_MINT, token::authority = admin)]
    pub admin_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub(crate) fn fund_treasury(ctx: Context<FundTreasury>, shares: u64) -> Result<()> {
    if shares == 0 {
        return Err(core_err(ledger::CoreError::ZeroAmount));
    }
    let a = ctx.accounts;
    token::transfer(
        CpiContext::new(
            a.token_program.to_account_info(),
            Transfer {
                from: a.admin_token.to_account_info(),
                to: a.treasury_vault.to_account_info(),
                authority: a.admin.to_account_info(),
            },
        ),
        shares,
    )?;
    a.custody
        .route
        .receive(u128::from(shares))
        .map_err(core_err)?;
    a.treasury.funded_shares = a
        .treasury
        .funded_shares
        .checked_add(shares)
        .ok_or(TesoroError::InvalidAccount)?;
    emit!(TreasuryFunded { shares });
    Ok(())
}

// --- Paying from the Treasury ----------------------------------------------------------------

/// What a Treasury payout needs to mint the part its vault cannot pay.
pub(crate) struct FeeMint<'a, 'info> {
    pub pool: &'a Account<'info, Pool>,
    pub mint: AccountInfo<'info>,
    pub yield_config: AccountInfo<'info>,
    pub yield_authority: AccountInfo<'info>,
    pub sim_lst_program: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
}

/// Pays `shares` simSOL from the Treasury to `destination`: from the vault first, the rest
/// minted (the route has already checked `shares` against `spendable`; the unminted part is
/// virtual shares of the realised Yield Fee). Returns the SOL units minted, rounded up.
pub(crate) fn pay_from_treasury<'info>(
    treasury: &Account<'info, Treasury>,
    vault: &mut Account<'info, TokenAccount>,
    destination: &AccountInfo<'info>,
    fee: &FeeMint<'_, 'info>,
    shares: u64,
    ts: i64,
) -> Result<u64> {
    let from_vault = shares.min(vault.amount);
    let to_mint = shares - from_vault;
    let mut minted_units = 0;
    if to_mint > 0 {
        let rate = sim_lst::current_rate(fee.pool, ts)?;
        minted_units = native::shares_value_ceil(to_mint, rate).map_err(core_err)?;
        let (authority, bump) = Pubkey::find_program_address(&[YIELD_SEED], &crate::ID);
        require_keys_eq!(
            authority,
            fee.yield_authority.key(),
            TesoroError::InvalidAccount
        );
        let seeds: &[&[u8]] = &[YIELD_SEED, &[bump]];
        sim_lst::cpi::mint_yield(
            CpiContext::new_with_signer(
                fee.sim_lst_program.clone(),
                sim_lst::cpi::accounts::MintYield {
                    authority: fee.yield_authority.clone(),
                    config: fee.yield_config.clone(),
                    pool: fee.pool.to_account_info(),
                    mint: fee.mint.clone(),
                    destination: destination.clone(),
                    token_program: fee.token_program.clone(),
                },
                &[seeds],
            ),
            to_mint,
        )?;
    }
    if from_vault > 0 {
        let seeds: &[&[u8]] = &[TREASURY_SEED, &[treasury.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                fee.token_program.clone(),
                Transfer {
                    from: vault.to_account_info(),
                    to: destination.clone(),
                    authority: treasury.to_account_info(),
                },
                &[seeds],
            ),
            from_vault,
        )?;
        vault.reload()?;
    }
    Ok(minted_units)
}

/// Sets the company wallet that `withdraw_treasury` pays.
#[derive(Accounts)]
pub struct SetTreasuryCompany<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
}

pub(crate) fn set_treasury_company(
    ctx: Context<SetTreasuryCompany>,
    company: Pubkey,
) -> Result<()> {
    ctx.accounts.treasury.company = company;
    Ok(())
}

/// The admin withdraws `amount` SOL units of the Treasury's spendable shares as simSOL to the
/// company wallet's simSOL account: from the vault, then minted. Only what the Treasury may spend
/// (realised fees and its own funding, never shares owed to holders or the Pool): `OverSpendable`
/// beyond that. D1: the fee of an open Position is not spendable until it unlocks.
#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, seeds = [TREASURY_VAULT_SEED], bump = treasury.vault_bump)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = SIM_SOL_MINT
    )]
    pub company_token: Box<Account<'info, TokenAccount>>,
    #[account(
        seeds = [sim_lst::POOL_SEED],
        seeds::program = sim_lst::ID,
        bump = pool.bump,
        constraint = pool.mint == SIM_SOL_MINT @ TesoroError::InvalidPool
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        mut,
        seeds = [NATIVE_SEED],
        bump = custody.bump,
        constraint = custody.pool == pool.key() @ TesoroError::InvalidPool
    )]
    pub custody: Box<Account<'info, NativeCustody>>,
    #[account(mut, address = SIM_SOL_MINT @ TesoroError::InvalidMint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(seeds = [sim_lst::YIELD_SEED], seeds::program = sim_lst::ID, bump = yield_config.bump)]
    pub yield_config: Box<Account<'info, sim_lst::YieldConfig>>,
    /// CHECK: the `["yield"]` PDA of this program, which must be the sim_lst yield authority.
    #[account(
        seeds = [YIELD_SEED],
        bump,
        constraint = yield_config.authority == yield_authority.key() @ TesoroError::InvalidAccount
    )]
    pub yield_authority: UncheckedAccount<'info>,
    pub sim_lst_program: Program<'info, SimLst>,
    pub token_program: Program<'info, Token>,
}

pub(crate) fn withdraw_treasury(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    if amount == 0 {
        return Err(core_err(ledger::CoreError::ZeroAmount));
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
    let ts = now()?;
    let rate = sim_lst::current_rate(&a.pool, ts)?;
    let shares = native::shares_for_units_floor(amount, rate).map_err(core_err)?;
    if shares == 0 {
        return Err(core_err(ledger::CoreError::ZeroShares));
    }
    a.custody
        .route
        .spend(u128::from(shares))
        .map_err(core_err)?;
    let fee = FeeMint {
        pool: &a.pool,
        mint: a.mint.to_account_info(),
        yield_config: a.yield_config.to_account_info(),
        yield_authority: a.yield_authority.to_account_info(),
        sim_lst_program: a.sim_lst_program.to_account_info(),
        token_program: a.token_program.to_account_info(),
    };
    let destination = a.company_token.to_account_info();
    let minted_units = pay_from_treasury(
        &a.treasury,
        &mut a.treasury_vault,
        &destination,
        &fee,
        shares,
        ts,
    )?;
    a.treasury.withdrawn_units = a
        .treasury
        .withdrawn_units
        .checked_add(amount)
        .ok_or(TesoroError::InvalidAccount)?;
    emit!(TreasuryWithdrawn {
        company: a.treasury.company,
        units: amount,
        shares,
        minted_units,
    });
    Ok(())
}

// --- Treasury redemption ---------------------------------------------------------------------

/// The Treasury Account redeems Gemas of a Solana Source it bought (an Instant Redeem fill), by the
/// normal Redeem rules (only the repaid part of a line, paying the shares it was worth when its
/// yield landed). Permissionless: nobody can sign for the Treasury Account and the destination is
/// fixed, so Tesoro cannot defer the Pool's share. Native: the shares are minted into the
/// Treasury's vault; stake: they stay in the custody vault. Either way they become the Treasury's
/// own shares (`route.receive`), and the Pool is owed its half of the Yield Fee and its fifth of
/// the Instant fee on them (`route.owe_pool`).
/// Remaining accounts: the kind's accounts (native paying to `treasury.vault`), then the Source's
/// book and pages.
#[derive(Accounts)]
pub struct RedeemTreasury<'info> {
    #[account(seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(
        seeds = [ACCOUNT_SEED, treasury.key().as_ref()],
        bump = treasury.account_bump
    )]
    pub treasury_account: Box<Account<'info, TesoroAccount>>,
    /// CHECK: the Treasury Account's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, treasury_account.key().as_ref()], bump)]
    pub basket: UncheckedAccount<'info>,
    /// CHECK: the Treasury Account's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, treasury_account.key().as_ref()], bump)]
    pub spill: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = (is_native(&position.inner) || is_stake(&position.inner)) @ TesoroError::NotNativePosition
    )]
    pub position: Box<Account<'info, PositionState>>,
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Box<Account<'info, SourceState>>,
}

pub(crate) fn redeem_treasury<'info>(
    ctx: Context<'_, '_, 'info, 'info, RedeemTreasury<'info>>,
    line: LineRef,
    amount: u64,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let vault = a.treasury.vault;
    let pay = if is_stake(&a.position.inner) {
        PayTo::Nobody
    } else {
        PayTo::Vault(&vault)
    };
    let (mut kind, rest) = KindCtx::load(&a.position.inner, remaining, pay)?;
    let mut books = OnchainBooks::load(rest)?;
    let source_key = a.source.key();
    let key = line.key(&source_key);
    let out = with_pool(
        &a.basket.to_account_info(),
        &a.spill.to_account_info(),
        |pool| {
            redeem_line(
                pool,
                &mut books,
                &mut kind,
                &mut a.position,
                &mut a.source,
                &source_key,
                &key,
                amount,
                Cashing::Treasury {
                    instant_fee_bps: ledger::INSTANT_REDEEM_FEE_BPS,
                },
            )
        },
    )?;
    require!(out.shares > 0, TesoroError::InvalidAccount);
    books.flush()?;
    // Stake shares stay in the custody vault as the Treasury's own; native simSOL is minted into
    // the Treasury's vault.
    if !is_stake(&a.position.inner) {
        kind.pay_shares(&a.position.key(), out.shares, 4)?;
    }
    kind.exit()?;
    emit!(Redeemed {
        position: a.position.key(),
        source: source_key,
        account: a.treasury_account.key(),
        gemas: out.gemas,
        source_units: out.units,
    });
    Ok(())
}

/// The Treasury Account redeems Gemas of an EVM-sourced Advance it bought, signed by the chain's
/// source authority (the bridge), which records the claim and pays it into the vault's treasury.
/// Remaining accounts: the Source's book and checkpoint pages.
#[derive(Accounts)]
pub struct RedeemTreasuryFromSource<'info> {
    pub source_signer: Signer<'info>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[chain_byte(position.inner.source_chain)]],
        bump = source_authority.bump,
        constraint = source_authority.chain == position.inner.source_chain
            && source_authority.authority == source_signer.key() @ TesoroError::Unauthorized
    )]
    pub source_authority: Box<Account<'info, SourceAuthority>>,
    #[account(seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(
        seeds = [ACCOUNT_SEED, treasury.key().as_ref()],
        bump = treasury.account_bump
    )]
    pub treasury_account: Box<Account<'info, TesoroAccount>>,
    /// CHECK: the Treasury Account's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, treasury_account.key().as_ref()], bump)]
    pub basket: UncheckedAccount<'info>,
    /// CHECK: the Treasury Account's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, treasury_account.key().as_ref()], bump)]
    pub spill: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.source_chain != SourceChain::Solana @ TesoroError::InvalidAccount
    )]
    pub position: Box<Account<'info, PositionState>>,
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Box<Account<'info, SourceState>>,
}

pub(crate) fn redeem_treasury_from_source<'info>(
    ctx: Context<'_, '_, 'info, 'info, RedeemTreasuryFromSource<'info>>,
    line: LineRef,
    amount: u64,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let mut kind = KindCtx::Reported;
    let mut books = OnchainBooks::load(remaining)?;
    let source_key = a.source.key();
    let key = line.key(&source_key);
    let out = with_pool(
        &a.basket.to_account_info(),
        &a.spill.to_account_info(),
        |pool| {
            redeem_line(
                pool,
                &mut books,
                &mut kind,
                &mut a.position,
                &mut a.source,
                &source_key,
                &key,
                amount,
                Cashing::Treasury {
                    instant_fee_bps: ledger::INSTANT_REDEEM_FEE_BPS,
                },
            )
        },
    )?;
    require!(out.shares > 0, TesoroError::InvalidAccount);
    books.flush()?;
    emit!(Redeemed {
        position: a.position.key(),
        source: source_key,
        account: a.treasury_account.key(),
        gemas: out.gemas,
        source_units: out.units,
    });
    Ok(())
}

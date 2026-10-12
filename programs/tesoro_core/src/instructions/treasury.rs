//! The Treasury (CONTEXT.md, ADR 0007): Tesoro's Yield Fee and Instant Redeem.
//!
//! * The Yield Fee on Solana-native Positions is minted into the treasury simSOL vault by
//!   `accrue_native_yield`; EVM vaults keep theirs at the source.
//! * Instant Redeem: a holder sells won Gemas to the Treasury Account for their value less the
//!   Instant Redeem Fee. On Solana the treasury vault pays in the same transaction
//!   (`instant_redeem`); for EVM Sources the bridge records the payout and the vault's treasury pays
//!   it (`instant_redeem_from_source`, co-signed by the chain's source authority).
//! * The Treasury Account later redeems those Gemas at full value through the normal Redeem rules
//!   (`redeem_treasury`, `redeem_treasury_from_source`), which refills the treasury on that chain.

use crate::error::{core_err, TesoroError};
use crate::instructions::native::{is_native, pay_redeem};
use crate::instructions::position::chain_byte;
use crate::ledger::{self, native, SourceChain, MAX_INSTANT_FEE_BPS, MAX_YIELD_FEE_BPS};
use crate::state::*;
use crate::util::now;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
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
    let treasury_key = ctx.accounts.treasury.key();
    let account = &mut ctx.accounts.treasury_account;
    if account.authority == Pubkey::default() {
        account.bump = ctx.bumps.treasury_account;
        account.authority = treasury_key;
        account.evm_address = [0; 20];
        account.inner = Default::default();
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

/// The admin tops up the treasury simSOL vault so Instant Redeems can be paid before any Yield
/// Fee has accrued.
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
    a.treasury.funded_shares = a
        .treasury
        .funded_shares
        .checked_add(shares)
        .ok_or(TesoroError::InvalidAccount)?;
    emit!(TreasuryFunded { shares });
    Ok(())
}

// --- Instant Redeem --------------------------------------------------------------------------

/// Moves `amount` won Gemas into the Treasury Account and returns `(units, payout)`.
fn sell_to_treasury(
    treasury: &Treasury,
    source: &SourceState,
    holder_account: &mut TesoroAccount,
    holding: &mut HoldingState,
    treasury_account: &mut TesoroAccount,
    treasury_holding: &mut HoldingState,
    amount: u64,
) -> Result<(u64, u64)> {
    ledger::instant_redeem(
        &source.inner,
        &mut holder_account.inner,
        &mut holding.inner,
        &mut treasury_account.inner,
        &mut treasury_holding.inner,
        amount,
        treasury.instant_fee_bps,
    )
    .map_err(core_err)
}

/// Fills in the Treasury Account's Holding of `source` the first time it buys Gemas of it.
fn open_treasury_holding(
    holding: &mut HoldingState,
    bump: u8,
    treasury_account: &Pubkey,
    source: &Pubkey,
) {
    if holding.account == Pubkey::default() {
        holding.bump = bump;
        holding.account = *treasury_account;
        holding.inner = ledger::Holding::new(source.to_bytes(), false);
    }
}

/// Instant Redeem of won Gemas of a Solana-native Source: the treasury vault pays the holder in
/// simSOL in the same transaction, or the instruction fails (`TreasuryShort`).
#[derive(Accounts)]
pub struct InstantRedeem<'info> {
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
        constraint = is_native(&position.inner) @ TesoroError::NotNativePosition
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
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
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
        seeds = [TREASURY_VAULT_SEED],
        bump = treasury.vault_bump
    )]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = SIM_SOL_MINT, token::authority = holder_authority)]
    pub holder_token: Box<Account<'info, TokenAccount>>,
    /// The canonical sim_lst Pool, whose rate converts the payout to simSOL.
    #[account(
        seeds = [sim_lst::POOL_SEED],
        seeds::program = sim_lst::ID,
        bump = pool.bump,
        constraint = pool.mint == SIM_SOL_MINT @ TesoroError::InvalidPool
    )]
    pub pool: Box<Account<'info, Pool>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn instant_redeem(ctx: Context<InstantRedeem>, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    let treasury_account_key = a.treasury_account.key();
    let source_key = a.source.key();
    open_treasury_holding(
        &mut a.treasury_holding,
        ctx.bumps.treasury_holding,
        &treasury_account_key,
        &source_key,
    );
    let (units, payout) = sell_to_treasury(
        &a.treasury,
        &a.source,
        &mut a.holder_account,
        &mut a.holding,
        &mut a.treasury_account,
        &mut a.treasury_holding,
        amount,
    )?;
    let rate = sim_lst::current_rate(&a.pool, now()?)?;
    let shares = native::shares_for_units_floor(payout, rate).map_err(core_err)?;
    if shares == 0 {
        return Err(core_err(ledger::CoreError::ZeroShares));
    }
    require!(
        a.treasury_vault.amount >= shares,
        TesoroError::TreasuryShort
    );
    let seeds: &[&[u8]] = &[TREASURY_SEED, &[a.treasury.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            Transfer {
                from: a.treasury_vault.to_account_info(),
                to: a.holder_token.to_account_info(),
                authority: a.treasury.to_account_info(),
            },
            &[seeds],
        ),
        shares,
    )?;
    a.treasury_vault.reload()?;
    a.treasury.instant_units = a
        .treasury
        .instant_units
        .checked_add(payout)
        .ok_or(TesoroError::InvalidAccount)?;
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

/// Instant Redeem of won Gemas of an EVM-sourced Advance, signed by the holder and by the chain's
/// registered source authority (the bridge), which records the payout, checks it against its
/// mirror of the vault's treasury and sends it. Returns the payout in source units.
#[derive(Accounts)]
pub struct InstantRedeemFromSource<'info> {
    #[account(mut)]
    pub holder_authority: Signer<'info>,
    pub source_signer: Signer<'info>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[chain_byte(position.inner.source_chain)]],
        bump = source_authority.bump,
        constraint = source_authority.chain == position.inner.source_chain
            && source_authority.authority == source_signer.key() @ TesoroError::Unauthorized
    )]
    pub source_authority: Box<Account<'info, SourceAuthority>>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, holder_authority.key().as_ref()],
        bump = holder_account.bump
    )]
    pub holder_account: Box<Account<'info, TesoroAccount>>,
    #[account(
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.source_chain != SourceChain::Solana @ TesoroError::InvalidAccount
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
    pub system_program: Program<'info, System>,
}

pub(crate) fn instant_redeem_from_source(
    ctx: Context<InstantRedeemFromSource>,
    amount: u64,
) -> Result<u64> {
    let a = ctx.accounts;
    let treasury_account_key = a.treasury_account.key();
    let source_key = a.source.key();
    open_treasury_holding(
        &mut a.treasury_holding,
        ctx.bumps.treasury_holding,
        &treasury_account_key,
        &source_key,
    );
    let (units, payout) = sell_to_treasury(
        &a.treasury,
        &a.source,
        &mut a.holder_account,
        &mut a.holding,
        &mut a.treasury_account,
        &mut a.treasury_holding,
        amount,
    )?;
    emit!(InstantRedeemed {
        position: a.position.key(),
        source: source_key,
        account: a.holder_account.key(),
        gemas: amount,
        source_units: units,
        payout_units: payout,
    });
    Ok(payout)
}

// --- Treasury redemption ---------------------------------------------------------------------

/// The Treasury Account redeems Gemas of a Solana-native Source it bought, by the normal Redeem
/// rules (only up to its pro rata share of accrued yield); the simSOL goes into the treasury vault.
/// Permissionless: nobody can sign for the Treasury Account and the destination is fixed.
/// `remaining_accounts`: `[custody, vault, treasury_vault, pool, token_program]`.
#[derive(Accounts)]
pub struct RedeemTreasury<'info> {
    #[account(seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, treasury.key().as_ref()],
        bump = treasury.account_bump
    )]
    pub treasury_account: Box<Account<'info, TesoroAccount>>,
    #[account(
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = is_native(&position.inner) @ TesoroError::NotNativePosition
    )]
    pub position: Box<Account<'info, PositionState>>,
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Box<Account<'info, SourceState>>,
    #[account(
        mut,
        seeds = [HOLDING_SEED, treasury_account.key().as_ref(), source.key().as_ref()],
        bump = treasury_holding.bump
    )]
    pub treasury_holding: Box<Account<'info, HoldingState>>,
}

pub(crate) fn redeem_treasury<'info>(
    ctx: Context<'_, '_, 'info, 'info, RedeemTreasury<'info>>,
    amount: u64,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let units = ledger::redeem(
        &mut a.source.inner,
        &mut a.treasury_account.inner,
        &mut a.treasury_holding.inner,
        amount,
    )
    .map_err(core_err)?;
    emit!(Redeemed {
        position: a.position.key(),
        source: a.source.key(),
        account: a.treasury_account.key(),
        gemas: amount,
        source_units: units,
    });
    let [_, _, destination, ..] = remaining else {
        return err!(TesoroError::BadRemainingAccounts);
    };
    require_keys_eq!(
        *destination.key,
        a.treasury.vault,
        TesoroError::InvalidAccount
    );
    pay_redeem(
        &a.position,
        &a.position.key(),
        &a.treasury.key(),
        units,
        remaining,
    )
}

/// The Treasury Account redeems Gemas of an EVM-sourced Advance it bought, signed by the chain's
/// source authority (the bridge), which records the claim and pays it into the vault's treasury.
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
        mut,
        seeds = [ACCOUNT_SEED, treasury.key().as_ref()],
        bump = treasury.account_bump
    )]
    pub treasury_account: Box<Account<'info, TesoroAccount>>,
    #[account(
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
    #[account(
        mut,
        seeds = [HOLDING_SEED, treasury_account.key().as_ref(), source.key().as_ref()],
        bump = treasury_holding.bump
    )]
    pub treasury_holding: Box<Account<'info, HoldingState>>,
}

pub(crate) fn redeem_treasury_from_source(
    ctx: Context<RedeemTreasuryFromSource>,
    amount: u64,
) -> Result<()> {
    let a = ctx.accounts;
    let units = ledger::redeem(
        &mut a.source.inner,
        &mut a.treasury_account.inner,
        &mut a.treasury_holding.inner,
        amount,
    )
    .map_err(core_err)?;
    emit!(Redeemed {
        position: a.position.key(),
        source: a.source.key(),
        account: a.treasury_account.key(),
        gemas: amount,
        source_units: units,
    });
    Ok(())
}

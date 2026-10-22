use crate::books::OnchainBooks;
use crate::error::{core_err, TesoroError};
use crate::instructions::economy::*;
use crate::instructions::stake::is_computed as is_computed_kind;
use crate::ledger::draw::SourceBooks;
use crate::ledger::{self, SourceChain};
use crate::state::*;
use crate::storage::*;
use crate::util::{now, require_can_advance};
use anchor_lang::prelude::*;

pub(crate) fn chain_byte(chain: SourceChain) -> u8 {
    match chain {
        SourceChain::Solana => 0,
        SourceChain::Ethereum => 1,
        SourceChain::HyperEvm => 2,
    }
}

/// `PositionLocked`: the oracle authority (later the LayerZero receiver) reports that a Position
/// was opened on its source chain. Solana-native Positions use the same instruction.
#[derive(Accounts)]
#[instruction(source_chain: SourceChain, position_id: [u8; 32])]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.oracle_authority == oracle.key() @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_account.authority.as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        init,
        payer = oracle,
        space = PositionState::SPACE,
        seeds = [POSITION_SEED, &[chain_byte(source_chain)], position_id.as_ref()],
        bump
    )]
    pub position: Account<'info, PositionState>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn open_position(
    ctx: Context<OpenPosition>,
    source_chain: SourceChain,
    position_id: [u8; 32],
    source_asset: Pubkey,
    decimals: u8,
    principal: u64,
    rate_bps: u16,
) -> Result<()> {
    require!(
        !ctx.accounts.config.oracle_locked,
        TesoroError::OracleLocked
    );
    require!(
        !(source_chain == SourceChain::Solana && source_asset == SIM_SOL_MINT),
        TesoroError::NativePosition
    );
    let position = &mut ctx.accounts.position;
    position.bump = ctx.bumps.position;
    position.position_id = position_id;
    position.inner = ledger::Position::new(
        ctx.accounts.owner_account.key().to_bytes(),
        source_chain,
        source_asset.to_bytes(),
        decimals,
        principal,
        rate_bps,
    )
    .map_err(core_err)?;
    Ok(())
}

/// An Advance: the owner picks the Horizon, the oracle authority supplies the USD price at
/// issuance (test mode only: an asset with an `OnchainPrice` is advanced by `take_advance_onchain`
/// and this refuses it; the asset's `OnchainPrice` address is the first remaining account). Both
/// sign. When the Position still has its previous Advance open, that Source, its book and its
/// pages follow in the remaining accounts, after the `OnchainPrice` address.
#[derive(Accounts)]
pub struct TakeAdvance<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.oracle_authority == oracle.key() @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    /// Its Yield Fee sizes the Advance.
    #[account(seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
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
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        init,
        payer = oracle,
        space = SourceState::SPACE,
        seeds = [SOURCE_SEED, position.key().as_ref(), &position.inner.advances.to_le_bytes()],
        bump
    )]
    pub source: Account<'info, SourceState>,
    #[account(
        init,
        payer = oracle,
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

pub(crate) fn take_advance<'info>(
    mut ctx: Context<'_, '_, 'info, 'info, TakeAdvance<'info>>,
    horizon_months: u8,
    price_micro_usd: u64,
    min_gemas: u64,
) -> Result<()> {
    require!(
        !ctx.accounts.config.oracle_locked,
        TesoroError::OracleLocked
    );
    require!(
        !is_computed_kind(&ctx.accounts.position.inner),
        TesoroError::NativePosition
    );
    let [price_marker, remaining @ ..] = ctx.remaining_accounts else {
        return err!(TesoroError::BadRemainingAccounts);
    };
    crate::instructions::onchain_price::require_no_onchain_price(
        &Pubkey::new_from_array(ctx.accounts.position.inner.source_asset),
        std::slice::from_ref(price_marker),
    )?;
    require_can_advance(&ctx.accounts.protections.to_account_info())?;
    let (source_bump, book_bump) = (ctx.bumps.source, ctx.bumps.book);
    let a = &mut ctx.accounts;
    let rates = reported_rates(&a.position.inner);
    let fee = FeeSnapshot::now(a.treasury.yield_fee_bps, &a.economy)?;
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
        price_micro_usd,
        fee,
        min_gemas,
    )
}

/// `YieldAccrued(seq, cumulative)`. Idempotent: a replayed or older `seq` changes nothing. Lands
/// the yield the open Advance has earned: when the Position has one, its Source is passed, and its
/// book and checkpoint pages are the remaining accounts.
#[derive(Accounts)]
pub struct ApplyYield<'info> {
    pub oracle: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.oracle_authority == oracle.key() @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, PositionState>,
    /// The Position's open Advance, when it has one.
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Option<Account<'info, SourceState>>,
}

pub(crate) fn apply_yield<'info>(
    mut ctx: Context<'_, '_, 'info, 'info, ApplyYield<'info>>,
    seq: u64,
    cumulative: u64,
) -> Result<()> {
    require!(
        !ctx.accounts.config.oracle_locked,
        TesoroError::OracleLocked
    );
    require!(
        !is_computed_kind(&ctx.accounts.position.inner),
        TesoroError::NativePosition
    );
    let remaining = ctx.remaining_accounts;
    let a = &mut ctx.accounts;
    apply_reported_yield(
        &mut a.position,
        a.source.as_mut(),
        remaining,
        seq,
        cumulative,
    )
}

/// Applies a Yield Report to a reported Position and lands the yield. Shared by the oracle's
/// `apply_yield` and the bridge's `apply_yield_from_source`.
pub(crate) fn apply_reported_yield<'info>(
    position: &mut Account<'info, PositionState>,
    source: Option<&mut Account<'info, SourceState>>,
    books_all: &'info [AccountInfo<'info>],
    seq: u64,
    cumulative: u64,
) -> Result<()> {
    if seq <= position.inner.last_seq {
        return Ok(());
    }
    if cumulative < position.inner.cumulative_yield {
        return Err(core_err(ledger::CoreError::CumulativeDecreased));
    }
    let position_key = position.key();
    position.inner.last_seq = seq;
    position.inner.cumulative_yield = cumulative;
    let rates = reported_rates(&position.inner);
    let mut debt_gemas = 0;
    match (position.inner.open_advance, source) {
        (Some(index), Some(src)) => {
            require!(
                src.inner.index == index && src.inner.position == position_key.to_bytes(),
                TesoroError::InvalidAccount
            );
            let source_key = src.key();
            let mut books = OnchainBooks::load(books_all)?;
            {
                let (book, ck) = books
                    .book_with_history(&source_key.to_bytes())
                    .map_err(draw_err)?;
                ledger::economy::sync_source(
                    &mut position.inner,
                    &src.inner,
                    book,
                    rates.accrued,
                    &rates.rate,
                    ck,
                )
                .map_err(core_err)?;
                if book.uncovered_total() == 0 {
                    ledger::economy::close_advance(
                        &mut position.inner,
                        &src.inner,
                        book,
                        rates.accrued,
                        &rates.rate,
                        ck,
                    )
                    .map_err(core_err)?;
                } else {
                    debt_gemas = u64::try_from(ledger::book::fp_ceil(book.uncovered_total()))
                        .unwrap_or(u64::MAX);
                }
            }
            books.flush()?;
        }
        (Some(_), None) => return err!(TesoroError::InvalidAccount),
        (None, _) => {
            ledger::economy::bank_free_yield(&mut position.inner, rates.accrued, &rates.rate)
                .map_err(core_err)?;
        }
    }
    emit!(YieldApplied {
        position: position_key,
        seq,
        cumulative,
        debt_gemas,
    });
    Ok(())
}

/// Return of the owner's own unspent Gemas of one line: the repaid part is released to the owner's
/// free yield (once), the unpaid part is cancelled. Principal is not an input. Remaining accounts:
/// the kind's accounts (not paying), then the Source's book and pages.
#[derive(Accounts)]
pub struct ReturnOwn<'info> {
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    /// CHECK: the owner's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, owner_account.key().as_ref()], bump)]
    pub basket: UncheckedAccount<'info>,
    /// CHECK: the owner's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, owner_account.key().as_ref()], bump)]
    pub spill: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized
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

pub(crate) fn return_own<'info>(
    ctx: Context<'_, '_, 'info, 'info, ReturnOwn<'info>>,
    line: LineRef,
    amount: u64,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let (kind, rest) = KindCtx::load(&a.position.inner, remaining, PayTo::Nobody)?;
    let rates = kind.rates(&a.position.inner)?;
    let mut books = OnchainBooks::load(rest)?;
    let source_key = a.source.key();
    let key = line.key(&source_key);
    with_pool(
        &a.basket.to_account_info(),
        &a.spill.to_account_info(),
        |pool| {
            return_own_line(
                pool,
                &mut books,
                &mut a.position,
                &mut a.source,
                &source_key,
                &key,
                amount,
                &rates,
            )
        },
    )?;
    books.flush()
}

/// Redeem Gemas for their Source asset, up to the line's repaid part. Pays the shares they were
/// worth when their yield landed, less the Yield Fee (none on fee classes). Emits `Redeemed`. Remaining accounts: the kind's accounts
/// (paying to the holder), then the Source's book and pages.
#[derive(Accounts)]
pub struct Redeem<'info> {
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

pub(crate) fn redeem<'info>(
    ctx: Context<'_, '_, 'info, 'info, Redeem<'info>>,
    line: LineRef,
    amount: u64,
) -> Result<()> {
    // Gemas of an EVM-sourced Advance are paid on their source chain, which only the bridge can
    // record (`redeem_from_source`); burning them here would destroy the claim without a payout.
    require!(
        ctx.accounts.position.inner.source_chain == SourceChain::Solana,
        TesoroError::BridgedSource
    );
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let wallet = a.holder_authority.key();
    let (mut kind, rest) = KindCtx::load(&a.position.inner, remaining, PayTo::Wallet(&wallet))?;
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
                Cashing::Holder,
            )
        },
    )?;
    // A Redeem too small to pay a share after the Yield Fee would burn the Gemas for nothing.
    if out.payout_shares == 0 {
        return Err(ledger_zero_shares());
    }
    books.flush()?;
    kind.pay_shares(&a.position.key(), out.payout_shares, 0)?;
    kind.exit()?;
    emit!(Redeemed {
        position: a.position.key(),
        source: source_key,
        account: a.holder_account.key(),
        gemas: out.gemas,
        source_units: out.units,
    });
    Ok(())
}

fn ledger_zero_shares() -> Error {
    core_err(ledger::CoreError::ZeroShares)
}

/// The owner claims yield accrued beyond any Advance (reported Positions; a native or stake
/// Position's free yield comes back with `unlock`).
#[derive(Accounts)]
pub struct ClaimFreeYield<'info> {
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized
    )]
    pub position: Account<'info, PositionState>,
}

pub(crate) fn claim_free_yield(ctx: Context<ClaimFreeYield>, amount: u64) -> Result<()> {
    require!(
        !is_computed_kind(&ctx.accounts.position.inner),
        TesoroError::NativePosition
    );
    if amount == 0 {
        return Err(core_err(ledger::CoreError::ZeroAmount));
    }
    let p = &mut ctx.accounts.position.inner;
    if amount > ledger::economy::claimable_units(p) {
        return Err(core_err(ledger::CoreError::ExceedsRedeemable));
    }
    p.free_yield_claimed = p
        .free_yield_claimed
        .checked_add(amount)
        .ok_or_else(|| core_err(ledger::CoreError::Math))?;
    emit!(YieldClaimed {
        position: ctx.accounts.position.key(),
        amount,
    });
    Ok(())
}

/// Debt is zero: release Principal. Remaining accounts: the kind's accounts (paying to the owner),
/// then, when the Position has an open Advance, its Source, book and pages.
#[derive(Accounts)]
pub struct Unlock<'info> {
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(seeds = [ECONOMY_SEED], bump = economy.bump)]
    pub economy: Account<'info, EconomyConfig>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized
    )]
    pub position: Account<'info, PositionState>,
}

pub(crate) fn unlock<'info>(ctx: Context<'_, '_, 'info, 'info, Unlock<'info>>) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let wallet = a.owner_authority.key();
    // The fee on the owner's free yield is split at the Pool share the latest Advance snapshotted;
    // a Position that never took one uses the share in force (red-team 31 #2).
    let pool_bps = if a.position.inner.advances > 0 {
        a.position.inner.pool_bps
    } else {
        a.economy.pool_share.bps_now(now()?).map_err(core_err)?
    };
    let (mut kind, rest) = KindCtx::load(&a.position.inner, remaining, PayTo::Wallet(&wallet))?;
    let position_key = a.position.key();
    unlock_position(&mut a.position, &mut kind, rest, pool_bps)?;
    emit!(PositionUnlocked {
        position: position_key,
    });
    Ok(())
}

/// Closes (or banks), settles and pays the Unlock of one Position.
pub(crate) fn unlock_position<'info>(
    position: &mut Account<'info, PositionState>,
    kind: &mut KindCtx<'info>,
    rest: &'info [AccountInfo<'info>],
    pool_bps: u16,
) -> Result<()> {
    let position_key = position.key();
    let rates = kind.rates(&position.inner)?;
    match position.inner.open_advance {
        Some(index) => {
            let [src_info, books_rest @ ..] = rest else {
                return err!(TesoroError::SourceRequired);
            };
            let src = read_source(src_info, &position_key, index)?;
            let mut books = OnchainBooks::load(books_rest)?;
            {
                let (book, ck) = books
                    .book_with_history(&src.key().to_bytes())
                    .map_err(draw_err)?;
                ledger::economy::close_advance(
                    &mut position.inner,
                    &src.inner,
                    book,
                    rates.accrued,
                    &rates.rate,
                    ck,
                )
                .map_err(core_err)?;
            }
            books.flush()?;
        }
        None => {
            ledger::economy::bank_free_yield(&mut position.inner, rates.accrued, &rates.rate)
                .map_err(core_err)?;
        }
    }
    let principal = position.inner.principal;
    let custody_kind = kind.custody_kind();
    let mut payout = ledger::economy::settle_unlock(&mut position.inner, custody_kind, &rates.rate)
        .map_err(core_err)?;
    match kind {
        KindCtx::Native { custody, .. } => {
            custody.remove_position(principal)?;
            ledger::economy::route_after_unlock(&mut custody.route, &mut payout, pool_bps)
                .map_err(core_err)?;
        }
        KindCtx::Stake { custody, .. } => {
            custody.remove_position(principal)?;
            ledger::economy::route_after_unlock(&mut custody.route, &mut payout, pool_bps)
                .map_err(core_err)?;
        }
        KindCtx::Reported => {}
    }
    if payout.shortfall_shares > 0 || payout.gap_shares > 0 {
        emit!(UnlockShortfall {
            position: position_key,
            shortfall_shares: payout.shortfall_shares,
            topped_up_shares: payout.topped_up_shares,
            gap_shares: payout.gap_shares,
        });
    }
    kind.exit()?;
    kind.pay_custody(&position_key, payout.owner_shares)?;
    kind.pay_shares(&position_key, payout.mint_shares, 2)?;
    Ok(())
}

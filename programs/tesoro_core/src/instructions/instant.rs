//! Instant Redeem orders (spec "Instant Redeem is an order that Tesoro fills", ticket 07 on chain).
//!
//! * `request_instant_redeem`: the holder puts won Gemas into an order PDA. The line's repaid
//!   Gemas are simply Redeemed at full value; the unpaid ones wait in the order (keeping their
//!   class and tranche) and cannot be played while it is open.
//! * `fill_instant_redeem`: the fill authority (the admin, or the keeper while its rule is on)
//!   buys all or part of the order at 75% of the Gemas' value at the moment of the fill, from the
//!   route's `spendable_shares` only (never what holders, the Pool or reservations are owed). The
//!   Treasury's basket takes the Gemas with the seller's class and tranche.
//! * `cancel_instant_redeem` (the seller, any time) and `expire_instant_redeem` (anyone, after the
//!   deadline) put the unsold Gemas back exactly.
//!
//! Remaining accounts of request and fill: the kind's accounts (paying to the seller), then, for
//! a native fill, the Treasury's simSOL vault, then the Source's book and pages. Cancel and expire
//! need only the book and pages (merging into an existing line asks for the book).

use crate::books::OnchainBooks;
use crate::error::{core_err, TesoroError};
use crate::instructions::economy::*;
use crate::instructions::position::chain_byte;
use crate::instructions::ticket::{close_pot_account, sponsor_rent};
use crate::instructions::treasury::{pay_from_treasury, FeeMint};
use crate::ledger::draw::SourceBooks;
use crate::ledger::instant::{self as inst, PayMode};
use crate::ledger::{
    self, CoreError, CustodyKind, FillTerms, Rate, RouteLedger, SourceChain, SourceKind,
};
use crate::state::*;
use crate::storage::*;
use crate::util::now;
use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

/// Closes a finished order: the sponsor gets back what it fronted, the rest goes to whoever paid.
fn close_order<'info>(
    order: &Account<'info, InstantOrderState>,
    payer: &AccountInfo<'info>,
    sponsor: Option<&mut Account<'info, SponsorState>>,
) -> Result<()> {
    close_pot_account(
        &order.to_account_info(),
        payer,
        sponsor,
        order.sponsored_lamports,
    )
}

// --- Request -----------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(line: LineRef, sell: u64, ttl_secs: i64, nonce: u64)]
pub struct RequestInstantRedeem<'info> {
    /// Pays the order's rent: the holder, or with the sponsor accounts the relayer, made whole
    /// from the sponsor at once (a Player with no SOL can still sell).
    #[account(mut)]
    pub payer: Signer<'info>,
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
    #[account(
        init,
        payer = payer,
        space = InstantOrderState::SPACE,
        seeds = [INSTANT_ORDER_SEED, holder_account.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub order: Account<'info, InstantOrderState>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Option<Account<'info, SponsorState>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn request_instant_redeem<'info>(
    ctx: Context<'_, '_, 'info, 'info, RequestInstantRedeem<'info>>,
    line: LineRef,
    sell: u64,
    ttl_secs: i64,
    nonce: u64,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let order_bump = ctx.bumps.order;
    let a = ctx.accounts;
    let wallet = a.holder_authority.key();
    // Gemas of an EVM-sourced Advance wait in the order like any other: their repaid part is
    // redeemed through the bridge, so the order refuses to start while one is ready.
    let reported = a.position.inner.source_chain != SourceChain::Solana;
    // The bridge fills the orders of an EVM-sourced Advance and cannot return a sponsor's rent.
    let mut sponsored_lamports = 0;
    if let Some(sponsor) = a.sponsor.as_mut() {
        require!(!reported, TesoroError::BridgedSource);
        let rent = Rent::get()?.minimum_balance(InstantOrderState::SPACE);
        sponsor_rent(sponsor, &a.payer.to_account_info(), 0, rent)?;
        sponsored_lamports = rent;
    } else {
        require_keys_eq!(a.payer.key(), wallet, TesoroError::Unauthorized);
    }
    let pay = if reported {
        PayTo::Nobody
    } else {
        PayTo::Wallet(&wallet)
    };
    let (mut kind, rest) = KindCtx::load(&a.position.inner, remaining, pay)?;
    let rates = kind.rates(&a.position.inner)?;
    let mut books = OnchainBooks::load(rest)?;
    let source_key = a.source.key();
    let position_key = a.position.key();
    sync_in_books(&mut books, &mut a.position, &a.source, &source_key, &rates)?;
    let key = line.key(&source_key);
    let account_key = a.holder_account.key();
    let ts = now()?;
    let requested = with_pool(
        &a.basket.to_account_info(),
        &a.spill.to_account_info(),
        |pool| {
            let (book, ck) = books
                .book_with_history(&source_key.to_bytes())
                .map_err(draw_err)?;
            inst::request_instant_redeem(
                SourceKind::Yield,
                book,
                ck,
                pool,
                &key,
                account_key.to_bytes(),
                sell,
                ts,
                ttl_secs,
            )
            .map_err(core_err)
        },
    )?;
    if let Some(r) = &requested.redeemed {
        require!(!reported, TesoroError::BridgedSource);
        let paid = u64::try_from(r.shares).map_err(|_| core_err(CoreError::Math))?;
        let tag = kind.custody_kind();
        ledger::economy::debit_paid_shares(&mut a.position.inner, tag, kind.route_mut(), paid)
            .map_err(core_err)?;
        let units = u64::try_from(
            rates
                .rate
                .units_for_shares(u128::from(paid))
                .map_err(core_err)?,
        )
        .map_err(|_| core_err(CoreError::Math))?;
        a.source.inner.redeemed = a
            .source
            .inner
            .redeemed
            .checked_add(r.gemas)
            .ok_or_else(|| core_err(CoreError::Math))?;
        a.source.inner.redeemed_units = a.source.inner.redeemed_units.saturating_add(units);
        books.flush()?;
        kind.pay_shares(&position_key, paid, 0)?;
        kind.exit()?;
    } else {
        books.flush()?;
        kind.exit()?;
    }
    let order = &mut a.order;
    order.bump = order_bump;
    order.nonce = nonce;
    order.account = account_key;
    order.owner = wallet;
    order.payer = a.payer.key();
    order.sponsored_lamports = sponsored_lamports;
    order.set_order(&requested.order);
    emit!(InstantRequested {
        order: order.key(),
        account: account_key,
        source: source_key,
        gemas: sell,
        expires_at: requested.order.expires_at,
    });
    Ok(())
}

// --- Fill --------------------------------------------------------------------------------------

/// Buys all or part of an order.
#[derive(Accounts)]
pub struct FillInstantRedeem<'info> {
    pub filler: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [ECONOMY_SEED], bump = economy.bump)]
    pub economy: Box<Account<'info, EconomyConfig>>,
    #[account(seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(
        seeds = [ACCOUNT_SEED, treasury.key().as_ref()],
        bump = treasury.account_bump
    )]
    pub treasury_account: Box<Account<'info, TesoroAccount>>,
    /// CHECK: the Treasury Account's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, treasury_account.key().as_ref()], bump)]
    pub treasury_basket: UncheckedAccount<'info>,
    /// CHECK: the Treasury Account's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, treasury_account.key().as_ref()], bump)]
    pub treasury_spill: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [INSTANT_ORDER_SEED, order.account.as_ref(), &order.nonce.to_le_bytes()],
        bump = order.bump
    )]
    pub order: Account<'info, InstantOrderState>,
    /// CHECK: who paid the order's rent (the seller, or the sponsor's relayer); receives it back
    /// when the order is finished.
    #[account(mut, address = order.payer @ TesoroError::InvalidAccount)]
    pub owner_wallet: UncheckedAccount<'info>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Option<Account<'info, SponsorState>>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.source_chain == SourceChain::Solana @ TesoroError::BridgedSource
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

fn fee_figures(book: &ledger::book::SourceBook) -> (u128, u128) {
    let fees = (0..3u8).fold(0u128, |acc, c| {
        acc.saturating_add(book.class(c).map_or(0, |s| s.uncovered))
    });
    (
        fees >> ledger::book::FP_BITS,
        book.uncovered_total() >> ledger::book::FP_BITS,
    )
}

pub(crate) fn fill_instant_redeem<'info>(
    ctx: Context<'_, '_, 'info, 'info, FillInstantRedeem<'info>>,
    gemas: u64,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    require_keys_eq!(
        a.order.line_source(),
        a.source.key(),
        TesoroError::InvalidAccount
    );
    let owner = a.order.owner;
    let (mut kind, rest) = KindCtx::load(&a.position.inner, remaining, PayTo::Wallet(&owner))?;
    let native = kind.custody_kind() == CustodyKind::Native;
    let (treasury_vault, rest) = if native {
        let [v, rest @ ..] = rest else {
            return err!(TesoroError::BadRemainingAccounts);
        };
        require_keys_eq!(*v.key, a.treasury.vault, TesoroError::InvalidAccount);
        require!(v.is_writable, TesoroError::NotWritable);
        (Some(v), rest)
    } else {
        (None, rest)
    };
    let rates = kind.rates(&a.position.inner)?;
    let mut books = OnchainBooks::load(rest)?;
    let source_key = a.source.key();
    let position_key = a.position.key();
    sync_in_books(&mut books, &mut a.position, &a.source, &source_key, &rates)?;
    let ts = now()?;
    let auth = a.economy.fill_authority(&a.config.admin);
    let value = ledger::economy::shares_for_gemas(&a.source.inner, gemas, &rates.rate)
        .map_err(core_err)?
        >> ledger::book::SHARE_BITS;
    let mut order = a.order.order();
    let filled = {
        let (book, ck) = books
            .book_with_history(&source_key.to_bytes())
            .map_err(draw_err)?;
        let (fees_outstanding, outstanding) = fee_figures(book);
        let terms = FillTerms {
            rate: Rate {
                shares: value,
                gemas,
            },
            fees_outstanding,
            outstanding,
            pay: PayMode::Now,
        };
        let route = kind
            .route_mut()
            .ok_or_else(|| error!(TesoroError::BridgedSource))?;
        let filler = a.filler.key().to_bytes();
        with_pool(
            &a.treasury_basket.to_account_info(),
            &a.treasury_spill.to_account_info(),
            |treasury_pool| {
                // `ck` is a trait object borrowed from `books`, and the pool call needs the same
                // book for merges: the pure fill takes both through one `SourceBooks`.
                inst::fill_instant_redeem(
                    &auth,
                    &filler,
                    route,
                    book,
                    ck,
                    &mut order,
                    treasury_pool,
                    gemas,
                    &terms,
                    ts,
                )
                .map_err(core_err)
            },
        )?
    };
    if let Some(r) = &filled.redeemed {
        let paid = u64::try_from(r.shares).map_err(|_| core_err(CoreError::Math))?;
        let tag = kind.custody_kind();
        ledger::economy::debit_paid_shares(&mut a.position.inner, tag, kind.route_mut(), paid)
            .map_err(core_err)?;
        let units = u64::try_from(
            rates
                .rate
                .units_for_shares(u128::from(paid))
                .map_err(core_err)?,
        )
        .map_err(|_| core_err(CoreError::Math))?;
        a.source.inner.redeemed = a.source.inner.redeemed.saturating_add(r.gemas);
        a.source.inner.redeemed_units = a.source.inner.redeemed_units.saturating_add(units);
        kind.pay_shares(&position_key, paid, 0)?;
    }
    let payout = u64::try_from(filled.payout_shares).map_err(|_| core_err(CoreError::Math))?;
    match (&kind, treasury_vault) {
        (
            KindCtx::Native {
                pool, pay: Some(p), ..
            },
            Some(v),
        ) => {
            let mut vault = Account::<TokenAccount>::try_from(v)?;
            let fee = FeeMint {
                pool,
                mint: p.y.mint.clone(),
                yield_config: p.y.yield_config.clone(),
                yield_authority: p.y.yield_authority.clone(),
                sim_lst_program: p.y.sim_lst_program.clone(),
                token_program: p.y.token_program.clone(),
            };
            pay_from_treasury(
                &a.treasury,
                &mut vault,
                &p.y.destination.to_account_info(),
                &fee,
                payout,
                ts,
            )?;
        }
        _ => kind.pay_shares(&position_key, payout, 3)?,
    }
    books.flush()?;
    kind.exit()?;
    let finished = !order.is_open();
    a.order.set_order(&order);
    emit!(InstantFilled {
        order: a.order.key(),
        source: source_key,
        gemas,
        payout_shares: payout,
        fee_bps: filled.fee_bps,
    });
    if finished {
        close_order(
            &a.order,
            &a.owner_wallet.to_account_info(),
            a.sponsor.as_mut(),
        )?;
    }
    Ok(())
}

/// A Solana order is filled by `fill_instant_redeem`. For Gemas of an EVM-sourced Advance the
/// payout is made by the vault on its chain, so the bridge (the chain's source authority) fills the
/// order on Tesoro's behalf after checking `available_shares` against its mirror of the vault's
/// spendable figure; the Gemas move to the Treasury's basket and the payout (in source units, as
/// everything of these Sources) is returned.
#[derive(Accounts)]
pub struct FillInstantRedeemFromSource<'info> {
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
    pub treasury_basket: UncheckedAccount<'info>,
    /// CHECK: the Treasury Account's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, treasury_account.key().as_ref()], bump)]
    pub treasury_spill: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [INSTANT_ORDER_SEED, order.account.as_ref(), &order.nonce.to_le_bytes()],
        bump = order.bump
    )]
    pub order: Account<'info, InstantOrderState>,
    /// CHECK: the seller's wallet; receives the order's rent when it is finished.
    #[account(mut, address = order.owner @ TesoroError::InvalidAccount)]
    pub owner_wallet: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.source_chain != SourceChain::Solana @ TesoroError::InvalidAccount
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

pub(crate) fn fill_instant_redeem_from_source<'info>(
    ctx: Context<'_, '_, 'info, 'info, FillInstantRedeemFromSource<'info>>,
    gemas: u64,
    available_shares: u64,
) -> Result<u64> {
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    require_keys_eq!(
        a.order.line_source(),
        a.source.key(),
        TesoroError::InvalidAccount
    );
    let rates = reported_rates(&a.position.inner);
    let mut books = OnchainBooks::load(remaining)?;
    let source_key = a.source.key();
    sync_in_books(&mut books, &mut a.position, &a.source, &source_key, &rates)?;
    let ts = now()?;
    let value = ledger::economy::shares_for_gemas(&a.source.inner, gemas, &rates.rate)
        .map_err(core_err)?
        >> ledger::book::SHARE_BITS;
    let mut order = a.order.order();
    // The vault's spendable figure, as the bridge mirrors it, is the only budget of this fill.
    let mut route = RouteLedger {
        treasury_shares: u128::from(available_shares),
        ..RouteLedger::default()
    };
    // The source authority fills as Tesoro's own filler.
    let auth = ledger::FillAuthority {
        admin: a.source_signer.key().to_bytes(),
        keeper: [0; 32],
        keeper_fills: false,
    };
    let filled = {
        let (book, ck) = books
            .book_with_history(&source_key.to_bytes())
            .map_err(draw_err)?;
        let (fees_outstanding, outstanding) = fee_figures(book);
        let terms = FillTerms {
            rate: Rate {
                shares: value,
                gemas,
            },
            fees_outstanding,
            outstanding,
            pay: PayMode::Now,
        };
        let signer = a.source_signer.key().to_bytes();
        with_pool(
            &a.treasury_basket.to_account_info(),
            &a.treasury_spill.to_account_info(),
            |treasury_pool| {
                inst::fill_instant_redeem(
                    &auth,
                    &signer,
                    &mut route,
                    book,
                    ck,
                    &mut order,
                    treasury_pool,
                    gemas,
                    &terms,
                    ts,
                )
                .map_err(core_err)
            },
        )?
    };
    // An order with Gemas ready to Redeem would have them Redeemed at full value here, a payout only
    // the bridge can record. The whole fill is refused instead: the seller cancels, which returns
    // the Gemas, and Redeems them through the bridge.
    require!(filled.redeemed.is_none(), TesoroError::BridgedSource);
    books.flush()?;
    let payout = u64::try_from(filled.payout_shares).map_err(|_| core_err(CoreError::Math))?;
    let finished = !order.is_open();
    a.order.set_order(&order);
    emit!(InstantFilled {
        order: a.order.key(),
        source: source_key,
        gemas,
        payout_shares: payout,
        fee_bps: filled.fee_bps,
    });
    if finished {
        close_order(&a.order, &a.owner_wallet.to_account_info(), None)?;
    }
    Ok(payout)
}

// --- Cancel and expiry -------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ReturnInstantRedeem<'info> {
    /// The seller on cancel; anyone on expiry.
    pub signer: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_account.authority.as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    /// CHECK: the seller's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, owner_account.key().as_ref()], bump)]
    pub basket: UncheckedAccount<'info>,
    /// CHECK: the seller's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, owner_account.key().as_ref()], bump)]
    pub spill: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [INSTANT_ORDER_SEED, order.account.as_ref(), &order.nonce.to_le_bytes()],
        bump = order.bump,
        constraint = order.account == owner_account.key() @ TesoroError::InvalidAccount
    )]
    pub order: Account<'info, InstantOrderState>,
    /// CHECK: who paid the order's rent (the seller, or the sponsor's relayer); receives it back
    /// when the order is finished.
    #[account(mut, address = order.payer @ TesoroError::InvalidAccount)]
    pub owner_wallet: UncheckedAccount<'info>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Option<Account<'info, SponsorState>>,
}

pub(crate) fn cancel_instant_redeem<'info>(
    ctx: Context<'_, '_, 'info, 'info, ReturnInstantRedeem<'info>>,
) -> Result<()> {
    let a = ctx.accounts;
    require_keys_eq!(a.signer.key(), a.order.owner, TesoroError::Unauthorized);
    let source = Pubkey::new_from_array(a.order.order().line.source);
    let mut books = OnchainBooks::load(ctx.remaining_accounts)?;
    let mut order = a.order.order();
    let signer = a.owner_account.key().to_bytes();
    let returned = with_pool(
        &a.basket.to_account_info(),
        &a.spill.to_account_info(),
        |pool| {
            let (book, ck) = books
                .book_with_history(&source.to_bytes())
                .map_err(draw_err)?;
            inst::cancel_instant_redeem(&signer, book, ck, &mut order, pool).map_err(core_err)
        },
    )?;
    books.flush()?;
    a.order.set_order(&order);
    emit!(InstantReturned {
        order: a.order.key(),
        gemas: returned,
        expired: false,
    });
    close_order(
        &a.order,
        &a.owner_wallet.to_account_info(),
        a.sponsor.as_mut(),
    )
}

pub(crate) fn expire_instant_redeem<'info>(
    ctx: Context<'_, '_, 'info, 'info, ReturnInstantRedeem<'info>>,
) -> Result<()> {
    let a = ctx.accounts;
    let source = Pubkey::new_from_array(a.order.order().line.source);
    let mut books = OnchainBooks::load(ctx.remaining_accounts)?;
    let mut order = a.order.order();
    let ts = now()?;
    let returned = with_pool(
        &a.basket.to_account_info(),
        &a.spill.to_account_info(),
        |pool| {
            let (book, ck) = books
                .book_with_history(&source.to_bytes())
                .map_err(draw_err)?;
            inst::expire_instant_redeem(ts, book, ck, &mut order, pool).map_err(core_err)
        },
    )?;
    books.flush()?;
    a.order.set_order(&order);
    emit!(InstantReturned {
        order: a.order.key(),
        gemas: returned,
        expired: true,
    });
    close_order(
        &a.order,
        &a.owner_wallet.to_account_info(),
        a.sponsor.as_mut(),
    )
}

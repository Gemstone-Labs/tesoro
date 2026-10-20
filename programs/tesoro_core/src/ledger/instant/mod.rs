//! Instant Redeem orders (economy upgrade, ticket 07).
//!
//! Pure Rust, like the rest of `ledger`: no accounts, no clocks, no CPIs. Ticket 11 wires the
//! instructions. An Instant Redeem is an **order that Tesoro fills** (founder, 2026-10-20):
//!
//! 1. [`request_instant_redeem`] Redeems the line's ready whole Gemas at full value, then moves
//!    the Gemas to sell out of the Player's basket into an [`InstantOrder`]. The order holds a
//!    [`Line`] of the same Source, class and tranche. Because the Gemas are no longer in the
//!    basket, no draw, transfer, Redeem or Offer reservation can reach them while the order is
//!    open (an order's Gemas are not part of `own_total`/`won_total`).
//! 2. [`fill_instant_redeem`] (the fill authority: the admin, or the keeper while a rule is
//!    switched on, off by default) buys all or some of the order's Gemas. The Treasury pays 75%
//!    of their value at fill from `spendable_shares` ([`RouteLedger::spend`]) and its basket
//!    takes the Gemas with the seller's class and tranche (never promoted into a fee class). A
//!    partial fill leaves the rest of the order open. Ready Gemas that appeared in the order
//!    while it waited are Redeemed to the seller at full value first, so waiting never costs the
//!    seller the 25% on Gemas that already repaid.
//! 3. [`cancel_instant_redeem`] (the seller, any time) and [`expire_instant_redeem`] (anyone,
//!    after `expires_at`) put the unsold Gemas back exactly.
//!
//! A fill never touches shares owed to holders or to the Pool: it spends only what
//! [`RouteLedger::spendable`] allows. Nothing is reserved while an order is open, so a request
//! can never take money Tesoro was counting on.
//!
//! **Room for an automatic filler.** Who may fill is one value ([`FillAuthority`]) and what a
//! fill needs is one call; an automatic budget later is a policy that picks `gemas` (see
//! [`InstantOrder::max_fill`]) and signs as the keeper. Nothing in the order depends on who fills.
//!
//! The fee is a flat 25%, computed by [`instant_fee_bps`], which already receives the Source's
//! fee share so a curve can replace it without touching callers.

#[cfg(test)]
mod tests;

use super::book::wide::{mul_div_u128, Round};
use super::book::{Redeemed, SourceBook};
use super::line_store::{Line, LineKey, LineStore, LineStoreError, SIDE_WON};
use super::prize::{RouteLedger, SourceKind};
use super::{CoreError, CoreResult, Key, BPS, MAX_INSTANT_FEE_BPS};

/// The Instant Redeem Fee for launch, in basis points of the Gemas' value (25%).
pub const INSTANT_REDEEM_FEE_BPS: u16 = 2_500;
/// How long an order waits for a fill unless the request says otherwise.
pub const DEFAULT_ORDER_TTL_SECS: i64 = 7 * 24 * 60 * 60;
pub const MIN_ORDER_TTL_SECS: i64 = 60 * 60;
pub const MAX_ORDER_TTL_SECS: i64 = 30 * 24 * 60 * 60;

/// The one place the Instant Redeem Fee is computed. `fees_outstanding` and `outstanding` are the
/// Source's fee Gemas and all its Gemas still unpaid (same unit): the flat launch fee ignores
/// them, a fee by wait time or by fee share can use them later.
pub fn instant_fee_bps(fees_outstanding: u128, outstanding: u128) -> u16 {
    let _ = (fees_outstanding, outstanding);
    INSTANT_REDEEM_FEE_BPS
}

/// What Gemas are worth in staking-token shares at the instant of a fill: `gemas` Gemas are worth
/// `shares` shares (the instruction layer reads the rate and the price).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rate {
    pub shares: u128,
    pub gemas: u64,
}

impl Rate {
    /// Whole shares `k` Gemas are worth, rounded down.
    pub fn value(&self, k: u64) -> CoreResult<u128> {
        if self.gemas == 0 {
            return Err(CoreError::Math);
        }
        mul_div_u128(
            self.shares,
            u128::from(k),
            u128::from(self.gemas),
            Round::Down,
        )
        .ok_or(CoreError::Math)
    }
}

/// Who may fill. The admin always can; the keeper only while `keeper_fills` is on (off by
/// default). A budget-driven automatic filler would be a keeper rule behind that switch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct FillAuthority {
    pub admin: Key,
    pub keeper: Key,
    pub keeper_fills: bool,
}

impl FillAuthority {
    pub fn check(&self, signer: &Key) -> CoreResult<()> {
        if *signer == self.admin {
            return Ok(());
        }
        if self.keeper_fills && self.keeper != [0u8; 32] && *signer == self.keeper {
            return Ok(());
        }
        Err(CoreError::NotFillAuthority)
    }
}

/// How the seller's payout leaves the Treasury.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayMode {
    /// Solana: the shares leave the Treasury in the fill's own transaction.
    Now,
    /// ETH/HYPE: the shares are reserved and the payout message goes out after the fill; the
    /// caller then calls [`RouteLedger::pay_reserved`] (or `unreserve` if it never goes).
    Deferred,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FillTerms {
    pub rate: Rate,
    pub fees_outstanding: u128,
    pub outstanding: u128,
    pub pay: PayMode,
}

/// An open Instant Redeem order (one PDA per order).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstantOrder {
    pub owner: Key,
    /// The Gemas still on offer: same Source, class, tranche, `due_at` and side as the line they
    /// came from. `line.amount == 0` means the order is finished and its account can close.
    pub line: Line,
    /// Gemas put into the order when it was requested.
    pub requested: u64,
    pub created_at: i64,
    pub expires_at: i64,
    /// Gemas the Treasury has bought so far.
    pub sold: u64,
    /// Whole Gemas Redeemed at full value because they repaid while the order waited.
    pub redeemed_while_open: u64,
    /// Shares paid by the Treasury so far.
    pub paid_shares: u128,
}

impl InstantOrder {
    pub fn is_open(&self) -> bool {
        self.line.amount > 0
    }

    /// The most Gemas a fill can buy now without the Treasury paying more than `spendable`
    /// shares (an automatic filler's budget is applied the same way: shrink `spendable`).
    /// Ready Gemas are Redeemed to the seller first and are not for sale.
    pub fn max_fill(
        &self,
        book: &SourceBook,
        spendable: u128,
        terms: &FillTerms,
    ) -> CoreResult<u64> {
        let ready = book.redeemable(&self.line)?.min(self.line.amount);
        let (mut lo, mut hi) = (0u64, self.line.amount - ready);
        while lo < hi {
            let mid = lo + (hi - lo).div_ceil(2);
            if payout_for(mid, terms)?.1 <= spendable {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        Ok(lo)
    }
}

/// `(value, payout)` for `k` Gemas: the payout is the value less the fee, rounded down.
fn payout_for(k: u64, terms: &FillTerms) -> CoreResult<(u128, u128)> {
    let value = terms.rate.value(k)?;
    let fee = instant_fee_bps(terms.fees_outstanding, terms.outstanding);
    if fee > MAX_INSTANT_FEE_BPS {
        return Err(CoreError::InvalidBps);
    }
    let keep = BPS - u128::from(fee);
    let payout = mul_div_u128(value, keep, BPS, Round::Down).ok_or(CoreError::Math)?;
    Ok((value, payout))
}

fn store_err(e: LineStoreError) -> CoreError {
    match e {
        LineStoreError::Full => CoreError::BasketFull,
        LineStoreError::Overflow => CoreError::Math,
        _ => CoreError::BookInconsistent,
    }
}

/// What a request did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Requested {
    pub order: InstantOrder,
    /// The ready part Redeemed at full value; pay `shares` to the seller.
    pub redeemed: Option<Redeemed>,
}

/// `request_instant_redeem`: the Player puts `sell` Gemas of the won line `key` into an order.
/// The line's ready whole Gemas are Redeemed at full value first (their shares are the seller's).
/// Refused for own Gemas, fee classes and prize Sources, and when the Gemas leaving (Redeemed
/// plus sold) would dip into what an Offer reservation needs. `Err` changes nothing.
#[allow(clippy::too_many_arguments)]
pub fn request_instant_redeem<T: AsRef<[u8]> + AsMut<[u8]>>(
    kind: SourceKind,
    book: &mut SourceBook,
    basket: &mut LineStore<T>,
    key: &LineKey,
    owner: Key,
    sell: u64,
    now: i64,
    ttl_secs: i64,
) -> CoreResult<Requested> {
    kind.require_yield()?;
    if sell == 0 {
        return Err(CoreError::ZeroAmount);
    }
    if !(MIN_ORDER_TTL_SECS..=MAX_ORDER_TTL_SECS).contains(&ttl_secs) {
        return Err(CoreError::InvalidOrderTtl);
    }
    let idx = basket.find(key).map_err(|_| CoreError::HoldingMismatch)?;
    let mut line = basket.get(idx).ok_or(CoreError::HoldingMismatch)?;
    if line.side != SIDE_WON || !line.is_playable() {
        return Err(CoreError::NotWonGemas);
    }
    let mut b = book.clone();
    let ready = b.redeemable(&line)?.min(line.amount);
    let redeemed = if ready > 0 {
        Some(b.redeem(&mut line, ready)?)
    } else {
        None
    };
    if sell > line.amount {
        return Err(CoreError::InsufficientGemas);
    }
    let leaving = ready.checked_add(sell).ok_or(CoreError::Math)?;
    let free = basket
        .own_total()
        .checked_add(basket.won_total())
        .ok_or(CoreError::Math)?
        .saturating_sub(basket.reserved_total());
    if leaving > free {
        return Err(CoreError::ReservedGemas);
    }
    let mut order_line = SourceBook::blank_line(
        line.side,
        line.due_at,
        line.source,
        line.class,
        line.tranche,
    );
    b.transfer(&mut line, &mut order_line, sell)?;
    if line.amount == 0 {
        basket.remove_at(idx).map_err(store_err)?;
    } else {
        basket.set_line(idx, &line).map_err(store_err)?;
    }
    *book = b;
    Ok(Requested {
        order: InstantOrder {
            owner,
            line: order_line,
            requested: sell,
            created_at: now,
            expires_at: now.checked_add(ttl_secs).ok_or(CoreError::Math)?,
            sold: 0,
            redeemed_while_open: 0,
            paid_shares: 0,
        },
        redeemed,
    })
}

/// What a fill did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Filled {
    /// Gemas the Treasury bought.
    pub gemas: u64,
    /// Their value at fill, in shares.
    pub value_shares: u128,
    pub fee_bps: u16,
    /// Shares the Treasury pays the seller (value less the fee, rounded down).
    pub payout_shares: u128,
    /// Ready Gemas Redeemed to the seller at full value before the sale.
    pub redeemed: Option<Redeemed>,
    /// `true` for [`PayMode::Deferred`]: the payout is reserved, not yet spent.
    pub deferred: bool,
}

/// `fill_instant_redeem`: buy `gemas` of the order's Gemas, all or part, at 75% of their value at
/// fill, from `spendable_shares`. `treasury` is the Treasury Account's basket, which takes the
/// Gemas under the seller's key (class and tranche kept). Refused for a signer without fill
/// authority, an expired or finished order, more Gemas than the order holds (after Redeeming its
/// ready part), a payout above `route.spendable()`, or a full Treasury basket. `Err` changes
/// nothing.
#[allow(clippy::too_many_arguments)]
pub fn fill_instant_redeem<T: AsRef<[u8]> + AsMut<[u8]>>(
    auth: &FillAuthority,
    signer: &Key,
    route: &mut RouteLedger,
    book: &mut SourceBook,
    order: &mut InstantOrder,
    treasury: &mut LineStore<T>,
    gemas: u64,
    terms: &FillTerms,
    now: i64,
) -> CoreResult<Filled> {
    auth.check(signer)?;
    if gemas == 0 {
        return Err(CoreError::ZeroAmount);
    }
    if !order.is_open() {
        return Err(CoreError::InvalidStatus);
    }
    if now >= order.expires_at {
        return Err(CoreError::Expired);
    }
    let mut b = book.clone();
    let mut ol = order.line;
    let ready = b.redeemable(&ol)?.min(ol.amount);
    let redeemed = if ready > 0 {
        Some(b.redeem(&mut ol, ready)?)
    } else {
        None
    };
    if gemas > ol.amount {
        return Err(CoreError::InsufficientGemas);
    }
    let (value, payout) = payout_for(gemas, terms)?;
    if payout == 0 {
        return Err(CoreError::ZeroShares);
    }
    let mut r = route.clone();
    match terms.pay {
        PayMode::Now => r.spend(payout)?,
        PayMode::Deferred => r.reserve(payout)?,
    }
    let (mut dst, at) = match treasury.find(&ol.key()) {
        Ok(i) => (treasury.get(i).ok_or(CoreError::BookInconsistent)?, Some(i)),
        Err(_) => (
            SourceBook::blank_line(ol.side, ol.due_at, ol.source, ol.class, ol.tranche),
            None,
        ),
    };
    b.transfer(&mut ol, &mut dst, gemas)?;
    match at {
        Some(i) => treasury.set_line(i, &dst).map_err(store_err)?,
        None => {
            treasury.insert(&dst).map_err(store_err)?;
        }
    }
    *route = r;
    *book = b;
    order.line = ol;
    order.sold += gemas;
    order.redeemed_while_open += ready;
    order.paid_shares += payout;
    Ok(Filled {
        gemas,
        value_shares: value,
        fee_bps: instant_fee_bps(terms.fees_outstanding, terms.outstanding),
        payout_shares: payout,
        redeemed,
        deferred: matches!(terms.pay, PayMode::Deferred),
    })
}

/// Puts all the order's remaining Gemas into `dst` (an existing line of the same key, or a blank
/// one) exactly: same Source, class and tranche, nothing promoted. Leaves the order finished.
fn release(book: &mut SourceBook, order: &mut InstantOrder, dst: &mut Line) -> CoreResult<()> {
    if !order.is_open() {
        return Err(CoreError::InvalidStatus);
    }
    let k = order.line.amount;
    let mut b = book.clone();
    let mut ol = order.line;
    b.transfer(&mut ol, dst, k)?;
    *book = b;
    order.line = ol;
    Ok(())
}

/// Returns the order's Gemas to the owner's basket (merging into the line of the same key).
fn return_to_basket<T: AsRef<[u8]> + AsMut<[u8]>>(
    book: &mut SourceBook,
    order: &mut InstantOrder,
    basket: &mut LineStore<T>,
) -> CoreResult<u64> {
    let k = order.line.amount;
    let (mut dst, at) = match basket.find(&order.line.key()) {
        Ok(i) => (basket.get(i).ok_or(CoreError::BookInconsistent)?, Some(i)),
        Err(_) => (
            SourceBook::blank_line(
                order.line.side,
                order.line.due_at,
                order.line.source,
                order.line.class,
                order.line.tranche,
            ),
            None,
        ),
    };
    let (mut b, mut o) = (book.clone(), order.clone());
    release(&mut b, &mut o, &mut dst)?;
    match at {
        Some(i) => basket.set_line(i, &dst).map_err(store_err)?,
        None => {
            basket.insert(&dst).map_err(store_err)?;
        }
    }
    *book = b;
    *order = o;
    Ok(k)
}

/// `cancel_instant_redeem`: the owner takes the unsold Gemas back, any time before they are sold.
pub fn cancel_instant_redeem<T: AsRef<[u8]> + AsMut<[u8]>>(
    signer: &Key,
    book: &mut SourceBook,
    order: &mut InstantOrder,
    basket: &mut LineStore<T>,
) -> CoreResult<u64> {
    if *signer != order.owner {
        return Err(CoreError::NotParty);
    }
    return_to_basket(book, order, basket)
}

/// Expiry: anyone returns the unsold Gemas to the owner once `expires_at` has passed.
pub fn expire_instant_redeem<T: AsRef<[u8]> + AsMut<[u8]>>(
    now: i64,
    book: &mut SourceBook,
    order: &mut InstantOrder,
    basket: &mut LineStore<T>,
) -> CoreResult<u64> {
    if now < order.expires_at {
        return Err(CoreError::NotExpired);
    }
    return_to_basket(book, order, basket)
}

/// Cancel or expiry when the owner's basket is full: the Gemas go into `dst` (the caller's
/// overflow record line, blank or existing) instead.
pub fn release_instant_redeem(
    book: &mut SourceBook,
    order: &mut InstantOrder,
    dst: &mut Line,
) -> CoreResult<u64> {
    let k = order.line.amount;
    release(book, order, dst)?;
    Ok(k)
}

//! One vault route's share books and its prize escrow.
//!
//! A *route* is a staking token with its Treasury and prize escrow (SOL: the native custody and
//! `PrizeLedger` on Solana; ETH and HYPE: one vault each). All figures are whole staking-token
//! **shares**. The Treasury holds `T` shares of which some are not its own:
//!
//! ```text
//! spendable = max(0, T - owed_shares - pool_owed - reserved)
//! ```
//!
//! `owed_shares` is what unlocked Positions' holders are owed (fixed in shares when their yield
//! landed), `pool_owed` the Pool's half of every realised Yield Fee, `reserved` pending payouts
//! and other reservations. Treasury withdraw, Instant Redeem fills and prize funding all answer to
//! this one figure; the three `owed + pool_owed + reserved` parts are never spendable, so
//! `owed + pool_owed + reserved <= T` holds after every operation ([`RouteLedger::check`]).
//!
//! The prize escrow holds shares in three buckets that always add up to what it physically holds:
//! `escrow_unissued` (arrived by `fund_season_prize` or `harvest`, no Gemas issued yet),
//! `escrow_backing` (the sum of every prize Source's `shares`) and `escrow_pending` (reserved for
//! prize payouts that are not executed yet). Only prize Redeem takes shares out.

use super::{SourceKind, DEFAULT_POOL_SHARE_BPS};
use crate::ledger::book::wide::{mul_div_u128, Round};
use crate::ledger::book::SourceBook;
use crate::ledger::line_store::{Line, CLASS_LEADERBOARD};
use crate::ledger::{season_end, CoreError, CoreResult, Key, BPS};
use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

/// A prize Source: Gemas issued against a fixed quantity of escrowed shares. The Gemas count
/// never changes with the coin price; a holder of `k` Gemas redeems `k / gemas` of `shares`, so a
/// slash lowers every holder's coin value by the same ratio and the Source can never owe more
/// than it holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct PrizeSource {
    pub source: Key,
    /// Shares of the escrow this Source still owns (not counting pending payouts).
    pub shares: u128,
    /// Prize Gemas outstanding (not counting pending payouts).
    pub gemas: u64,
}

/// A prize Redeem that executes later (EVM `PayPrize`): shares reserved, Gemas already taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct PrizePayout {
    pub shares: u128,
    pub gemas: u64,
}

/// What `fund_season_prize` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Funding {
    /// Shares moved from `pool_owed` into the escrow.
    pub moved: u128,
    /// The prize Source issued for the escrow's unissued shares, if any were worth a Gema.
    pub issued: Option<PrizeSource>,
}

/// What `harvest` took out of a Source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Harvested {
    pub gemas: u64,
    pub shares: u128,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct RouteLedger {
    /// Shares the Treasury holds, including everything it owes.
    pub treasury_shares: u128,
    pub owed_shares: u128,
    pub pool_owed: u128,
    pub reserved: u128,
    /// The prize escrow ships switched off until the slashing fix lands (decisions.md, D1).
    pub escrow_enabled: bool,
    pub escrow_unissued: u128,
    pub escrow_backing: u128,
    pub escrow_pending: u128,
    /// Last Season whose prize was funded on this route (0 = none). Strictly increasing.
    pub last_funded: u32,
    /// Lifetime Pool halves of realised Yield Fees; `== pool_owed + pool_funded_total`.
    pub pool_realised_total: u128,
    /// Lifetime shares moved from `pool_owed` into the escrow.
    pub pool_funded_total: u128,
}

fn add(a: u128, b: u128) -> CoreResult<u128> {
    a.checked_add(b).ok_or(CoreError::Math)
}

fn sub(a: u128, b: u128) -> CoreResult<u128> {
    a.checked_sub(b).ok_or(CoreError::Math)
}

fn mul_div_down(a: u128, b: u128, d: u128) -> CoreResult<u128> {
    mul_div_u128(a, b, d, Round::Down).ok_or(CoreError::Math)
}

impl RouteLedger {
    /// The single figure Treasury withdraw, Instant Redeem fills and prize funding answer to.
    pub fn spendable(&self) -> u128 {
        let claims = self
            .owed_shares
            .saturating_add(self.pool_owed)
            .saturating_add(self.reserved);
        self.treasury_shares.saturating_sub(claims)
    }

    /// Shares the escrow holds in total.
    pub fn escrow_total(&self) -> u128 {
        self.escrow_unissued
            .saturating_add(self.escrow_backing)
            .saturating_add(self.escrow_pending)
    }

    /// Refills, Treasury funding and redemptions of bought Gemas: shares arrive and are the
    /// Treasury's own. Never a Yield Fee, so nothing is owed to the Pool.
    pub fn receive(&mut self, shares: u128) -> CoreResult<()> {
        self.treasury_shares = add(self.treasury_shares, shares)?;
        Ok(())
    }

    /// A Yield Fee became **realised** (D1): `fee_shares` joined the Treasury and `pool_bps` of
    /// it (floored, so rounding favours Tesoro by at most one share) is owed to the Pool. Returns
    /// `(tesoro_half, pool_half)`. The only way `pool_owed` grows.
    pub fn realise_yield_fee(
        &mut self,
        fee_shares: u128,
        pool_bps: u16,
    ) -> CoreResult<(u128, u128)> {
        if u128::from(pool_bps) > BPS {
            return Err(CoreError::InvalidBps);
        }
        let pool = mul_div_down(fee_shares, u128::from(pool_bps), BPS)?;
        let treasury = add(self.treasury_shares, fee_shares)?;
        let owed = add(self.pool_owed, pool)?;
        let realised = add(self.pool_realised_total, pool)?;
        self.treasury_shares = treasury;
        self.pool_owed = owed;
        self.pool_realised_total = realised;
        Ok((fee_shares - pool, pool))
    }

    /// [`Self::realise_yield_fee`] at the default 50/50 split.
    pub fn realise_yield_fee_default(&mut self, fee_shares: u128) -> CoreResult<(u128, u128)> {
        self.realise_yield_fee(fee_shares, DEFAULT_POOL_SHARE_BPS)
    }

    /// Unlocked holders became owed `shares` more (their yield landed and fixed in shares). The
    /// shares must already be in the Treasury and not claimed by anything else.
    pub fn add_owed(&mut self, shares: u128) -> CoreResult<()> {
        if shares > self.spendable() {
            return Err(CoreError::OwedExceedsTreasury);
        }
        self.owed_shares = add(self.owed_shares, shares)?;
        Ok(())
    }

    /// A holder of an unlocked Position was paid `shares`.
    pub fn pay_owed(&mut self, shares: u128) -> CoreResult<()> {
        let owed = sub(self.owed_shares, shares)?;
        let held = sub(self.treasury_shares, shares)?;
        self.owed_shares = owed;
        self.treasury_shares = held;
        Ok(())
    }

    /// Tesoro's own spending: Treasury withdraw and the paid part of an Instant Redeem fill.
    pub fn spend(&mut self, shares: u128) -> CoreResult<()> {
        if shares > self.spendable() {
            return Err(CoreError::OverSpendable);
        }
        self.treasury_shares -= shares;
        Ok(())
    }

    /// Reserve shares for a pending payout (or any other claim) so nothing else can spend them.
    pub fn reserve(&mut self, shares: u128) -> CoreResult<()> {
        if shares > self.spendable() {
            return Err(CoreError::OverSpendable);
        }
        self.reserved = add(self.reserved, shares)?;
        Ok(())
    }

    /// Drop a reservation without paying (a cancelled order).
    pub fn unreserve(&mut self, shares: u128) -> CoreResult<()> {
        self.reserved = sub(self.reserved, shares)?;
        Ok(())
    }

    /// A reserved payout executed: the shares leave the Treasury.
    pub fn pay_reserved(&mut self, shares: u128) -> CoreResult<()> {
        let reserved = sub(self.reserved, shares)?;
        let held = sub(self.treasury_shares, shares)?;
        self.reserved = reserved;
        self.treasury_shares = held;
        Ok(())
    }

    pub fn set_escrow_enabled(&mut self, on: bool) {
        self.escrow_enabled = on;
    }

    /// `fund_season_prize` for `season` on this route (keeper or admin, once per ended Season,
    /// refused while the escrow is off). Waits (`PrizeFundingWaits`, nothing changes) until the
    /// Treasury holds the Pool's half beyond what holders and reservations need:
    /// `T - owed - reserved >= pool_owed`. Then all of `pool_owed` moves into the escrow, and one
    /// prize Source is issued for every share in the escrow that has none: `gemas_for_unissued`
    /// is what those shares are worth in Gemas at the rate of the instant (the instruction layer
    /// computes it; 0 leaves them unissued, e.g. under one Gema of dust). Later Seasons never
    /// touch an earlier Source's shares.
    pub fn fund_season_prize(
        &mut self,
        season: u32,
        now: i64,
        source: Key,
        gemas_for_unissued: u64,
    ) -> CoreResult<Funding> {
        if !self.escrow_enabled {
            return Err(CoreError::PrizeEscrowOff);
        }
        if now < season_end(season)? {
            return Err(CoreError::SeasonNotEnded);
        }
        if season <= self.last_funded {
            return Err(CoreError::AlreadyFunded);
        }
        let headroom = self
            .treasury_shares
            .saturating_sub(self.owed_shares.saturating_add(self.reserved));
        if headroom < self.pool_owed {
            return Err(CoreError::PrizeFundingWaits);
        }
        let moved = self.pool_owed;
        let unissued = add(self.escrow_unissued, moved)?;
        let funded = add(self.pool_funded_total, moved)?;
        let issued = if unissued > 0 && gemas_for_unissued > 0 {
            Some(PrizeSource {
                source,
                shares: unissued,
                gemas: gemas_for_unissued,
            })
        } else {
            None
        };
        let backing = match issued {
            Some(p) => add(self.escrow_backing, p.shares)?,
            None => self.escrow_backing,
        };
        self.treasury_shares -= moved;
        self.pool_owed = 0;
        self.pool_funded_total = funded;
        self.escrow_unissued = if issued.is_some() { 0 } else { unissued };
        self.escrow_backing = backing;
        self.last_funded = season;
        Ok(Funding { moved, issued })
    }

    /// `harvest`: permissionless, moves `k` ready Gemas of a Source's Leaderboard counter into
    /// the escrow as shares (they are issued as prize Gemas by the next `fund_season_prize`).
    /// Refused on prize Sources and while the escrow is off.
    pub fn harvest(
        &mut self,
        kind: SourceKind,
        book: &mut SourceBook,
        counter: &mut Line,
        k: u64,
    ) -> CoreResult<Harvested> {
        kind.require_yield()?;
        if !self.escrow_enabled {
            return Err(CoreError::PrizeEscrowOff);
        }
        if counter.class != CLASS_LEADERBOARD {
            return Err(CoreError::SourceMismatch);
        }
        let unissued = self.escrow_unissued;
        let mut book_after = book.clone();
        let mut line_after = *counter;
        let out = book_after.redeem(&mut line_after, k)?;
        let unissued = add(unissued, out.shares)?;
        *book = book_after;
        *counter = line_after;
        self.escrow_unissued = unissued;
        Ok(Harvested {
            gemas: out.gemas,
            shares: out.shares,
        })
    }

    fn payout_shares(ps: &PrizeSource, k: u64) -> CoreResult<u128> {
        if k == 0 {
            return Err(CoreError::ZeroAmount);
        }
        if k > ps.gemas {
            return Err(CoreError::InsufficientGemas);
        }
        let shares = if k == ps.gemas {
            ps.shares
        } else {
            mul_div_down(ps.shares, u128::from(k), u128::from(ps.gemas))?
        };
        if shares == 0 {
            return Err(CoreError::ZeroShares);
        }
        Ok(shares)
    }

    /// Prize Redeem paid at once (Solana): `k` Gemas burn and `k / gemas` of the Source's shares
    /// leave the escrow. Returns the shares to pay out.
    pub fn redeem_prize(&mut self, ps: &mut PrizeSource, k: u64) -> CoreResult<u128> {
        let shares = Self::payout_shares(ps, k)?;
        let backing = sub(self.escrow_backing, shares)?;
        ps.shares -= shares;
        ps.gemas -= k;
        self.escrow_backing = backing;
        Ok(shares)
    }

    /// Prize Redeem that executes later (EVM `PayPrize`): the Gemas burn and the shares move to
    /// `escrow_pending`, where no other holder's Redeem can count on them.
    pub fn begin_prize_payout(&mut self, ps: &mut PrizeSource, k: u64) -> CoreResult<PrizePayout> {
        let shares = Self::payout_shares(ps, k)?;
        let backing = sub(self.escrow_backing, shares)?;
        let pending = add(self.escrow_pending, shares)?;
        ps.shares -= shares;
        ps.gemas -= k;
        self.escrow_backing = backing;
        self.escrow_pending = pending;
        Ok(PrizePayout { shares, gemas: k })
    }

    /// The pending payout executed: its shares leave the escrow.
    pub fn finish_prize_payout(&mut self, p: PrizePayout) -> CoreResult<()> {
        self.escrow_pending = sub(self.escrow_pending, p.shares)?;
        Ok(())
    }

    /// The pending payout failed for good: the holder gets the Gemas back and the Source its
    /// shares.
    pub fn cancel_prize_payout(&mut self, ps: &mut PrizeSource, p: PrizePayout) -> CoreResult<()> {
        let pending = sub(self.escrow_pending, p.shares)?;
        let backing = add(self.escrow_backing, p.shares)?;
        let shares = add(ps.shares, p.shares)?;
        let gemas = ps.gemas.checked_add(p.gemas).ok_or(CoreError::Math)?;
        self.escrow_pending = pending;
        self.escrow_backing = backing;
        ps.shares = shares;
        ps.gemas = gemas;
        Ok(())
    }

    /// The route invariants. `sources` are all the route's live prize Sources (tests, indexers
    /// and the keeper's audit pass them).
    pub fn check(&self, sources: &[PrizeSource]) -> CoreResult<()> {
        let claims = add(add(self.owed_shares, self.pool_owed)?, self.reserved)?;
        if claims > self.treasury_shares {
            return Err(CoreError::BookInconsistent);
        }
        if self.pool_realised_total != add(self.pool_owed, self.pool_funded_total)? {
            return Err(CoreError::BookInconsistent);
        }
        let mut backing = 0u128;
        for s in sources {
            backing = add(backing, s.shares)?;
            if s.gemas == 0 && s.shares != 0 {
                return Err(CoreError::BookInconsistent);
            }
        }
        if backing != self.escrow_backing {
            return Err(CoreError::BookInconsistent);
        }
        Ok(())
    }
}

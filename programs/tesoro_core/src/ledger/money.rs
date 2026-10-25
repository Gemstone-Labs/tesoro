//! Position, Advance, Source, Debt (ADR 0001).
//!
//! Units. Gemas are whole numbers. A Source fixes its rate at issuance as
//! `unit_num / unit_den` source-asset base units per Gema, where `unit_num = 10^(decimals + 4)`
//! and `unit_den = price` (USD price of one whole asset in micro-USD): one Gema is $0.01 =
//! 10_000 micro-USD. After issuance the USD price is never consulted again.
//!
//! Source ledger (all in Gemas unless named `*_units`):
//! `issued`, `returned` (cancelled by the owner), `redeemed` (paid out), and `yield_units`
//! (accrued yield applied, in source-asset units). `covered = min(issued - returned,
//! floor(yield_units / rate))` is the part of the Source that accrued yield has repaid.
//! `debt = issued - returned - covered`; `outstanding = issued - returned - redeemed`
//! is what holders (and Pots) hold; `redeemable = covered - redeemed`.
//! Conservation: `held + escrowed == outstanding`, hence `outstanding + redeemed + returned == issued`.

use super::*;
use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum SourceChain {
    Solana,
    Ethereum,
    HyperEvm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum PositionStatus {
    Locked,
    Unlocked,
}

/// A staker's locked, yield-bearing stake. `principal` is recorded but no function of this core
/// ever reads it except to size a new Advance, and none lets it reduce Debt.
#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Position {
    /// Account identity that owns the Position.
    pub owner: Key,
    pub source_chain: SourceChain,
    pub source_asset: Key,
    pub decimals: u8,
    /// Principal in source-asset base units.
    pub principal: u64,
    /// Provider annual rate in basis points, fixed at open.
    pub rate_bps: u16,
    pub status: PositionStatus,
    /// Advances taken so far; also the index of the next Source.
    pub advances: u32,
    /// Index of the open Advance (the Source with Debt), if any.
    pub open_advance: Option<u32>,
    /// Highest cross-chain message sequence applied.
    pub last_seq: u64,
    /// Last cumulative accrued yield applied, source-asset units.
    pub cumulative_yield: u64,
    /// Yield accrued while no Advance had Debt to repay; belongs to the owner.
    pub free_yield: u64,
    pub free_yield_claimed: u64,
    /// Unix time the Position opened: Accrued Yield counts from here (ADR 0010). Native Positions
    /// only; zero for Positions whose yield is reported.
    pub opened_at: i64,
    /// Native Positions: the yield checkpoint. Net Accrued Yield up to here is already settled:
    /// consumed by closed Sources or banked in `free_yield`. The open Advance counts only what
    /// accrues after it.
    pub applied_net: u64,
    /// Native Positions: simSOL shares this Position holds in the shared custody vault.
    pub custody_shares: u64,
    /// Native Positions: the Yield Fee in basis points, fixed at open (like `rate_bps`). A later
    /// change of the Treasury's rate applies only to Positions opened afterwards.
    pub yield_fee_bps: u16,
    /// Staking-token Positions (mainnet, ADR 0011): the pool's Staking Rate when the Position
    /// opened, lamports per pool token at 1e12. Non-zero marks a stake Position; growth since open
    /// is the Staking Rate now over this. Zero for every other Position.
    pub stake_rate_open: u64,
    /// Staking-token shares (32 fractional bits) that the Position's Sources have landed and that
    /// are not yet paid out or taken: the part of its custody that belongs to the holders of its
    /// Gemas and to the owner's pocket. Economy upgrade (ticket 11).
    pub held_shares: u128,
    /// Shares (32 fractional bits) that are the owner's free yield: the owner's pocket of the
    /// closed Sources and the yield that accrued while no Advance was open. Paid at Unlock
    /// (native), claimable (reported Sources), or simply part of what Unlock leaves the owner
    /// (staking token). Economy upgrade (ticket 11).
    pub free_shares: u128,
    /// Staking-token Positions: whole shares already paid out of the custody before Unlock (to
    /// holders by Redeem, to the prize escrow by harvest, to the Treasury by its own Redeem).
    /// `custody_shares` stays what was deposited, so the pooled fee totals can be unwound exactly.
    pub paid_shares: u64,
    /// The Pool's share of the Yield Fee the latest Advance snapshotted: the share the fee on the
    /// owner's free yield uses at Unlock (red-team 31 #2). 0 before the first Advance.
    pub pool_bps: u16,
}

impl Position {
    pub fn new(
        owner: Key,
        source_chain: SourceChain,
        source_asset: Key,
        decimals: u8,
        principal: u64,
        rate_bps: u16,
    ) -> CoreResult<Self> {
        if decimals > 18 {
            return Err(CoreError::InvalidDecimals);
        }
        if principal == 0 {
            return Err(CoreError::ZeroAmount);
        }
        Ok(Self {
            owner,
            source_chain,
            source_asset,
            decimals,
            principal,
            rate_bps,
            status: PositionStatus::Locked,
            advances: 0,
            open_advance: None,
            last_seq: 0,
            cumulative_yield: 0,
            free_yield: 0,
            free_yield_claimed: 0,
            opened_at: 0,
            applied_net: 0,
            custody_shares: 0,
            yield_fee_bps: 0,
            stake_rate_open: 0,
            held_shares: 0,
            free_shares: 0,
            paid_shares: 0,
            pool_bps: 0,
        })
    }

    /// Takes an Advance: the whole projected yield over `horizon_months`, as Gemas at $0.01 with
    /// `price_micro_usd` (USD per whole asset, micro-USD) fixed for this Source. The Position earns
    /// its gross yield, so the Advance is repaid at the Horizon; the Yield Fee is taken when the
    /// Gemas are cashed out (ticket 31). The caller sets the Source's fee snapshot and credits
    /// `source.issued` Gemas to the owner's basket as lines of the returned Source.
    pub fn open_advance(
        &mut self,
        position: Key,
        horizon_months: u8,
        price_micro_usd: u64,
    ) -> CoreResult<Source> {
        if self.status != PositionStatus::Locked {
            return Err(CoreError::PositionNotLocked);
        }
        if self.open_advance.is_some() {
            return Err(CoreError::AdvanceAlreadyOpen);
        }
        if !(MIN_HORIZON_MONTHS..=MAX_HORIZON_MONTHS).contains(&horizon_months) {
            return Err(CoreError::InvalidHorizon);
        }
        if price_micro_usd == 0 {
            return Err(CoreError::InvalidPrice);
        }
        let unit_num = 10u128
            .checked_pow(self.decimals as u32 + 4)
            .ok_or(CoreError::Math)?;
        let issued = self.advance_gemas(horizon_months, price_micro_usd)?;
        if issued == 0 {
            return Err(CoreError::AdvanceTooSmall);
        }
        let index = self.advances;
        let next = index.checked_add(1).ok_or(CoreError::Math)?;
        self.advances = next;
        self.open_advance = Some(index);
        Ok(Source {
            position,
            owner: self.owner,
            index,
            horizon_months,
            unit_num,
            unit_den: price_micro_usd,
            issued,
            returned: 0,
            redeemed: 0,
            yield_units: 0,
            redeemed_units: 0,
            due_at: 0,
            yield_fee_bps: 0,
            pool_bps: 0,
            fee_units: 0,
            pool_units: 0,
        })
    }

    /// Gemas an Advance of `months` is worth: the whole projected yield, as Gemas at
    /// `price_micro_usd`, floored.
    pub(crate) fn advance_gemas(&self, months: u8, price_micro_usd: u64) -> CoreResult<u64> {
        let projected_units = mul_div_floor(
            (self.principal as u128)
                .checked_mul(self.rate_bps as u128)
                .and_then(|x| x.checked_mul(months as u128))
                .ok_or(CoreError::Math)?,
            1,
            BPS * 12,
        )?;
        let unit_num = 10u128
            .checked_pow(self.decimals as u32 + 4)
            .ok_or(CoreError::Math)?;
        to_u64(mul_div_floor(
            projected_units,
            price_micro_usd as u128,
            unit_num,
        )?)
    }

    /// Extends the open Advance by `extra_months` (total Horizon at most 12) and returns the Gemas
    /// minted: `size(h + extra) - size(h)` at the Source's own price. The caller credits them to
    /// the owner's basket as lines of `src`.
    pub fn extend_advance(&mut self, src: &mut Source, extra_months: u8) -> CoreResult<u64> {
        if self.status != PositionStatus::Locked {
            return Err(CoreError::PositionNotLocked);
        }
        let open = self.open_advance.ok_or(CoreError::NoOpenAdvance)?;
        if src.index != open {
            return Err(CoreError::SourceMismatch);
        }
        if src.debt() == 0 {
            return Err(CoreError::AdvanceRepaid);
        }
        let total = src
            .horizon_months
            .checked_add(extra_months)
            .ok_or(CoreError::InvalidHorizon)?;
        if extra_months == 0 || total > MAX_HORIZON_MONTHS {
            return Err(CoreError::InvalidHorizon);
        }
        let before = self.advance_gemas(src.horizon_months, src.unit_den)?;
        let after = self.advance_gemas(total, src.unit_den)?;
        let minted = after.checked_sub(before).ok_or(CoreError::Math)?;
        if minted == 0 {
            return Err(CoreError::AdvanceTooSmall);
        }
        src.issued = src.issued.checked_add(minted).ok_or(CoreError::Math)?;
        src.horizon_months = total;
        Ok(minted)
    }

    /// Applies `YieldAccrued(seq, cumulative)`. Idempotent: `seq <= last_seq` is a no-op
    /// returning `Ok(false)`. Accrued yield first repays the open Advance's Debt; anything beyond
    /// goes to `free_yield`. `source` must be the open Advance's Source when one is open.
    pub fn apply_yield(
        &mut self,
        source: Option<&mut Source>,
        seq: u64,
        cumulative: u64,
    ) -> CoreResult<bool> {
        if seq <= self.last_seq {
            return Ok(false);
        }
        if cumulative < self.cumulative_yield {
            return Err(CoreError::CumulativeDecreased);
        }
        let delta = cumulative - self.cumulative_yield;
        match (self.open_advance, source) {
            (Some(index), Some(src)) => {
                if src.index != index || src.owner != self.owner {
                    return Err(CoreError::SourceMismatch);
                }
                let need = src.units_to_repay()?;
                let take = delta.min(need);
                let free = self
                    .free_yield
                    .checked_add(delta - take)
                    .ok_or(CoreError::Math)?;
                src.yield_units = src.yield_units.checked_add(take).ok_or(CoreError::Math)?;
                self.free_yield = free;
                if src.debt() == 0 {
                    self.open_advance = None;
                }
            }
            (Some(_), None) => return Err(CoreError::SourceMismatch),
            (None, _) => {
                self.free_yield = self.free_yield.checked_add(delta).ok_or(CoreError::Math)?;
            }
        }
        self.last_seq = seq;
        self.cumulative_yield = cumulative;
        Ok(true)
    }

    /// Owner claims yield accrued beyond any Advance (paid on the source chain by `PayYield`).
    pub fn claim_free_yield(&mut self, amount: u64) -> CoreResult<()> {
        if amount == 0 {
            return Err(CoreError::ZeroAmount);
        }
        let claimed = self
            .free_yield_claimed
            .checked_add(amount)
            .ok_or(CoreError::Math)?;
        if claimed > self.free_yield {
            return Err(CoreError::ExceedsRedeemable);
        }
        self.free_yield_claimed = claimed;
        Ok(())
    }

    /// Debt is zero and no Advance is open: Principal may be released (`Unlock` message).
    pub fn unlock(&mut self) -> CoreResult<()> {
        if self.status != PositionStatus::Locked {
            return Err(CoreError::PositionNotLocked);
        }
        if self.open_advance.is_some() {
            return Err(CoreError::DebtOutstanding);
        }
        self.status = PositionStatus::Unlocked;
        Ok(())
    }
}

/// The Advance a Gema was issued from.
#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Source {
    pub position: Key,
    /// Owner of the Position at issuance; Gemas of this Source are "own-sourced" for them.
    pub owner: Key,
    pub index: u32,
    pub horizon_months: u8,
    /// Source-asset base units per Gema is `unit_num / unit_den`.
    pub unit_num: u128,
    pub unit_den: u64,
    pub issued: u64,
    pub returned: u64,
    pub redeemed: u64,
    /// Accrued yield applied to this Source, source-asset units.
    pub yield_units: u64,
    /// Source-asset units already paid out by Redeem.
    pub redeemed_units: u64,
    /// Planned repayment date of the Source's Gemas (unix seconds), set by the instruction layer
    /// when the Advance is taken and moved by Extend: the fast-first key of its basket lines.
    pub due_at: i64,
    /// Yield Fee charged when this Source's Gemas are cashed out, fixed when the Advance opens
    /// (ticket 31). Fee-class lines are exempt whatever this says.
    pub yield_fee_bps: u16,
    /// The Pool's share of that fee, fixed when the Advance opens (red-team #10).
    pub pool_bps: u16,
    /// Source-asset units of Yield Fee charged on this Source's cash-outs, cumulative (included in
    /// `redeemed_units`). The bridge reads its delta to tell an EVM vault what to keep.
    pub fee_units: u64,
    /// Units of those cash-outs owed to the Leaderboard Pool, cumulative: its part of the Yield
    /// Fee and, on the Treasury's redeems, its fifth of the Instant fee.
    pub pool_units: u64,
}

impl Source {
    /// Gemas not returned: the claim total on this Source.
    fn live(&self) -> u64 {
        self.issued.saturating_sub(self.returned)
    }

    /// Source-asset units of accrued yield needed to repay everything still live.
    pub fn units_to_repay_total(&self) -> CoreResult<u64> {
        to_u64(mul_div_ceil(
            self.live() as u128,
            self.unit_num,
            self.unit_den as u128,
        )?)
    }

    fn units_to_repay(&self) -> CoreResult<u64> {
        Ok(self
            .units_to_repay_total()?
            .saturating_sub(self.yield_units))
    }

    /// Gemas repaid by accrued yield.
    pub fn covered(&self) -> u64 {
        let by_yield = (self.yield_units as u128)
            .checked_mul(self.unit_den as u128)
            .and_then(|x| x.checked_div(self.unit_num))
            .unwrap_or(0);
        u64::try_from(by_yield).unwrap_or(u64::MAX).min(self.live())
    }

    /// Debt, in Gemas: outstanding Gemas not yet repaid by accrued yield.
    pub fn debt(&self) -> u64 {
        self.live().saturating_sub(self.covered())
    }

    /// Debt in source-asset units (rounded up).
    pub fn debt_units(&self) -> CoreResult<u64> {
        to_u64(mul_div_ceil(
            self.debt() as u128,
            self.unit_num,
            self.unit_den as u128,
        )?)
    }

    /// Gemas held by anyone or escrowed in Pots.
    pub fn outstanding(&self) -> u64 {
        self.live().saturating_sub(self.redeemed)
    }

    /// Repaid but not yet redeemed, in Gemas: pro rata redeemable by holders now.
    pub fn redeemable(&self) -> u64 {
        self.covered().saturating_sub(self.redeemed)
    }

    /// Accrued yield not yet paid out to redeemers, source-asset units ("pending").
    pub fn pending_units(&self) -> u64 {
        self.yield_units.saturating_sub(self.redeemed_units)
    }

    /// What a holder of `held` free Gemas of this Source may redeem now: their pro rata share.
    pub fn redeemable_for(&self, held: u64) -> u64 {
        let outstanding = self.outstanding();
        if outstanding == 0 {
            return 0;
        }
        let share = (held as u128)
            .checked_mul(self.redeemable() as u128)
            .and_then(|x| x.checked_div(outstanding as u128))
            .unwrap_or(0);
        u64::try_from(share).unwrap_or(0).min(held)
    }

    /// Source-asset units paid for `gemas` redeemed (rounded down).
    pub fn units_for(&self, gemas: u64) -> CoreResult<u64> {
        to_u64(mul_div_floor(
            gemas as u128,
            self.unit_num,
            self.unit_den as u128,
        )?)
    }
}

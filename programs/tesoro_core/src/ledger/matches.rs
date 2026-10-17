//! Match: two equal entries, an escrowed Pot, one settlement.
//!
//! Gema units in a Pot keep their Source. On a win the winner receives the loser's actual Gemas
//! (their Sources intact) minus the fees, which are taken from the loser's lines. Allocation across
//! Sources is deterministic: lines are merged and sorted ascending by Source key, and every
//! "take N Gemas" drains lines in that order (see docs/tesoro-core.md).

use super::*;
use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct FeeTerms {
    pub platform_bps: u16,
    pub studio_bps: u16,
    pub platform_recipient: Key,
    pub studio_recipient: Key,
}

impl FeeTerms {
    pub fn validate(&self) -> CoreResult<()> {
        let total = (self.platform_bps as u32) + (self.studio_bps as u32);
        if total > MAX_TOTAL_FEE_BPS as u32 {
            return Err(CoreError::FeeTooHigh);
        }
        Ok(())
    }
}

/// The Leaderboard Fee: a share of the Pot of every Match, paid into the pool Account. Read from
/// `Config` when the Match settles (not snapshotted in the Match, whose layout is fixed), so a
/// rate of 0 or no pool means no fee. Taken after the Platform and Studio Fees.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LeaderboardTerms {
    pub bps: u16,
    pub recipient: Key,
}

impl LeaderboardTerms {
    /// All three fees together may not exceed `MAX_TOTAL_FEE_BPS` of the Pot.
    pub fn validate(&self, fees: &FeeTerms) -> CoreResult<()> {
        let total = (fees.platform_bps as u32) + (fees.studio_bps as u32) + (self.bps as u32);
        if total > MAX_TOTAL_FEE_BPS as u32 {
            return Err(CoreError::FeeTooHigh);
        }
        Ok(())
    }
}

/// One entrant. `funder == player` unless the entry is backed; then `share_bps` is the Player's
/// share of the surplus from the accepted Offer.
#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Side {
    pub player: Key,
    pub funder: Key,
    pub share_bps: u16,
    pub lines: Vec<Line>,
}

impl Side {
    pub fn total(&self) -> CoreResult<u64> {
        self.lines.iter().try_fold(0u64, |acc, l| {
            acc.checked_add(l.amount).ok_or(CoreError::Math)
        })
    }
    pub fn is_backed(&self) -> bool {
        self.funder != self.player
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum MatchStatus {
    /// One entrant waiting.
    Open,
    /// Both entries in escrow.
    Active,
    Settled,
    /// Draw, abandonment, no-show or cancellation: entries returned.
    Refunded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Index of the winning side: 0 opened the Match, 1 joined.
    Winner(u8),
    Draw,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payout {
    pub recipient: Key,
    pub source: Key,
    pub amount: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Match {
    pub game: Key,
    pub entry: u64,
    /// Fee terms snapshotted when the Match opened.
    pub fees: FeeTerms,
    pub status: MatchStatus,
    pub a: Side,
    pub b: Option<Side>,
    /// After this time anyone may refund the Match as abandoned / no-show.
    pub deadline: i64,
}

/// Merges lines by Source, drops empties, sorts ascending by Source key.
pub fn normalize(lines: &[Line]) -> CoreResult<Vec<Line>> {
    let mut out: Vec<Line> = Vec::with_capacity(lines.len());
    let mut sorted: Vec<&Line> = lines.iter().filter(|l| l.amount > 0).collect();
    sorted.sort_by(|x, y| x.source.cmp(&y.source));
    for l in sorted {
        match out.last_mut() {
            Some(last) if last.source == l.source => {
                last.amount = last.amount.checked_add(l.amount).ok_or(CoreError::Math)?;
            }
            _ => out.push(l.clone()),
        }
    }
    Ok(out)
}

/// Takes `amount` Gemas from `lines` (already normalized), draining in order.
fn take_lines(lines: &mut [Line], mut amount: u64) -> Vec<Line> {
    let mut taken = Vec::new();
    for l in lines.iter_mut() {
        if amount == 0 {
            break;
        }
        let t = l.amount.min(amount);
        if t > 0 {
            l.amount -= t;
            amount -= t;
            taken.push(Line {
                source: l.source,
                amount: t,
            });
        }
    }
    taken
}

fn sum(lines: &[Line]) -> CoreResult<u64> {
    lines
        .iter()
        .try_fold(0u64, |a, l| a.checked_add(l.amount).ok_or(CoreError::Math))
}

fn push(out: &mut Vec<Payout>, recipient: Key, lines: &[Line]) {
    for l in lines {
        if l.amount > 0 {
            out.push(Payout {
                recipient,
                source: l.source,
                amount: l.amount,
            });
        }
    }
}

/// Merges payouts by (recipient, source) and sorts them: the order accounts must be supplied in.
fn finish(payouts: Vec<Payout>) -> CoreResult<Vec<Payout>> {
    let mut sorted = payouts;
    sorted.sort_by(|x, y| (x.recipient, x.source).cmp(&(y.recipient, y.source)));
    let mut out: Vec<Payout> = Vec::with_capacity(sorted.len());
    for p in sorted {
        match out.last_mut() {
            Some(last) if last.recipient == p.recipient && last.source == p.source => {
                last.amount = last.amount.checked_add(p.amount).ok_or(CoreError::Math)?;
            }
            _ => out.push(p),
        }
    }
    Ok(out)
}

impl Match {
    pub fn open(
        game: Key,
        entry: u64,
        sizes: &[u64],
        fees: FeeTerms,
        a: Side,
        now: i64,
    ) -> CoreResult<Self> {
        if !is_ladder_entry(entry, sizes) {
            return Err(CoreError::InvalidEntry);
        }
        fees.validate()?;
        if a.total()? != entry {
            return Err(CoreError::EntryMismatch);
        }
        if a.share_bps as u128 > BPS {
            return Err(CoreError::InvalidBps);
        }
        Ok(Self {
            game,
            entry,
            fees,
            status: MatchStatus::Open,
            a,
            b: None,
            deadline: now.checked_add(MATCH_TIMEOUT_SECS).ok_or(CoreError::Math)?,
        })
    }

    /// Second entrant joins with an equal entry; the Match starts.
    pub fn join(&mut self, b: Side, now: i64) -> CoreResult<()> {
        if self.status != MatchStatus::Open {
            return Err(CoreError::InvalidStatus);
        }
        if now >= self.deadline {
            return Err(CoreError::Expired);
        }
        if b.total()? != self.entry {
            return Err(CoreError::EntryMismatch);
        }
        if b.share_bps as u128 > BPS {
            return Err(CoreError::InvalidBps);
        }
        if b.player == self.a.player || b.funder == self.a.funder || b.player == self.a.funder {
            return Err(CoreError::SelfMatch);
        }
        let deadline = now.checked_add(MATCH_TIMEOUT_SECS).ok_or(CoreError::Math)?;
        self.b = Some(b);
        self.status = MatchStatus::Active;
        self.deadline = deadline;
        Ok(())
    }

    /// Fees for this Pot, in Gemas: (platform, studio).
    pub fn fees_due(&self) -> CoreResult<(u64, u64)> {
        let pot = (self.entry as u128).checked_mul(2).ok_or(CoreError::Math)?;
        let platform = to_u64(mul_div_floor(pot, self.fees.platform_bps as u128, BPS)?)?;
        let studio = to_u64(mul_div_floor(pot, self.fees.studio_bps as u128, BPS)?)?;
        Ok((platform, studio))
    }

    /// The Leaderboard Fee for this Pot, in Gemas.
    pub fn leaderboard_due(&self, lb: &LeaderboardTerms) -> CoreResult<u64> {
        let pot = (self.entry as u128).checked_mul(2).ok_or(CoreError::Math)?;
        to_u64(mul_div_floor(pot, lb.bps as u128, BPS)?)
    }

    /// `settle_with` and no Leaderboard Fee.
    pub fn settle(&mut self, outcome: Outcome) -> CoreResult<Vec<Payout>> {
        self.settle_with(outcome, &LeaderboardTerms::default())
    }

    /// Settles an Active Match exactly once and returns who is credited which Gemas.
    /// Winner: the loser's lines minus fees (fees to the recipients), plus the winner's own entry
    /// back. If the winner is backed: the Backer's entry back first, the remainder split by the
    /// Offer's share. Draw: both entries returned in full.
    pub fn settle_with(
        &mut self,
        outcome: Outcome,
        lb: &LeaderboardTerms,
    ) -> CoreResult<Vec<Payout>> {
        if self.status != MatchStatus::Active {
            return Err(CoreError::InvalidStatus);
        }
        let b = self.b.as_ref().ok_or(CoreError::InvalidStatus)?;
        let (payouts, status) = match outcome {
            Outcome::Draw => (self.refund_payouts()?, MatchStatus::Refunded),
            Outcome::Winner(i) => {
                let (winner, loser) = match i {
                    0 => (&self.a, b),
                    1 => (b, &self.a),
                    _ => return Err(CoreError::NotParty),
                };
                (self.win_payouts(winner, loser, lb)?, MatchStatus::Settled)
            }
        };
        self.status = status;
        Ok(payouts)
    }

    fn win_payouts(
        &self,
        winner: &Side,
        loser: &Side,
        lb: &LeaderboardTerms,
    ) -> CoreResult<Vec<Payout>> {
        lb.validate(&self.fees)?;
        let (platform, studio) = self.fees_due()?;
        let pool = self.leaderboard_due(lb)?;
        let mut rest = normalize(&loser.lines)?;
        let platform_lines = take_lines(&mut rest, platform);
        let studio_lines = take_lines(&mut rest, studio);
        let pool_lines = take_lines(&mut rest, pool);
        if sum(&platform_lines)? != platform
            || sum(&studio_lines)? != studio
            || sum(&pool_lines)? != pool
        {
            return Err(CoreError::FeeTooHigh);
        }
        let surplus = sum(&rest)?;
        let mut out = Vec::new();
        push(&mut out, self.fees.platform_recipient, &platform_lines);
        push(&mut out, self.fees.studio_recipient, &studio_lines);
        push(&mut out, lb.recipient, &pool_lines);
        if winner.is_backed() {
            // Backer's entry back first, then the Offer's split of the remainder.
            push(&mut out, winner.funder, &normalize(&winner.lines)?);
            let player_share = to_u64(mul_div_floor(
                surplus as u128,
                winner.share_bps as u128,
                BPS,
            )?)?;
            let player_lines = take_lines(&mut rest, player_share);
            push(&mut out, winner.player, &player_lines);
            push(&mut out, winner.funder, &rest);
        } else {
            push(&mut out, winner.player, &normalize(&winner.lines)?);
            push(&mut out, winner.player, &rest);
        }
        finish(out)
    }

    fn refund_payouts(&self) -> CoreResult<Vec<Payout>> {
        let mut out = Vec::new();
        push(&mut out, self.a.funder, &normalize(&self.a.lines)?);
        if let Some(b) = &self.b {
            push(&mut out, b.funder, &normalize(&b.lines)?);
        }
        finish(out)
    }

    /// Pushes the refund deadline of an Open or Active Match out (never in), for Games whose
    /// Matches outlast `MATCH_TIMEOUT_SECS` or can be played before a second Player joins. At most
    /// `MAX_MATCH_EXTENSION_SECS` from `now`.
    pub fn extend_deadline(&mut self, now: i64, new_deadline: i64) -> CoreResult<()> {
        if !matches!(self.status, MatchStatus::Open | MatchStatus::Active) {
            return Err(CoreError::InvalidStatus);
        }
        if now >= self.deadline {
            return Err(CoreError::Expired);
        }
        let cap = now
            .checked_add(MAX_MATCH_EXTENSION_SECS)
            .ok_or(CoreError::Math)?;
        if new_deadline < self.deadline || new_deadline > cap {
            return Err(CoreError::InvalidDeadline);
        }
        self.deadline = new_deadline;
        Ok(())
    }

    /// Refunds both entries (abandonment, no-show, cancellation of an Open Match). `force` is the
    /// authorised path (the Game, or the creator of an Open Match); otherwise the deadline must
    /// have passed. Exactly once, like `settle`.
    pub fn refund(&mut self, now: i64, force: bool) -> CoreResult<Vec<Payout>> {
        if !matches!(self.status, MatchStatus::Open | MatchStatus::Active) {
            return Err(CoreError::InvalidStatus);
        }
        if !force && now < self.deadline {
            return Err(CoreError::NotExpired);
        }
        let payouts = self.refund_payouts()?;
        self.status = MatchStatus::Refunded;
        Ok(payouts)
    }
}

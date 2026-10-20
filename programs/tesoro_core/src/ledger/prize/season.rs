//! Season payout with a frozen budget (spec "Season order").
//!
//! Order: the Season ends, every route runs `fund_season_prize`, `record_season` freezes a
//! per-line **budget** from the Pool's basket, the 48-hour void window runs, then
//! `pay_season_rank` pays each rank its share of **every** budget line. Because every rank takes
//! the same fraction of the same lines, every rank gets the same mix of coins, whatever the Pool
//! holds or receives later. Ranks round down; the leftovers stay in the Pool's lines and roll
//! into the next Season.
//!
//! Progress is tracked per (rank, budget line): a rank's cursor is the number of lines already
//! paid, and a step must name the next one, so retries and parallel keepers cannot pay twice.

use super::route::RouteLedger;
use crate::ledger::line_store::{LineKey, CLASS_GENERAL};
use crate::ledger::{
    season_end, CoreError, CoreResult, Key, Ranked, SeasonWindow, BPS, PRIZE_BPS, PRIZE_PLACES,
};
use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

/// Most Pool lines one Season's budget freezes. A budget line costs a (rank, line) step per
/// rank, so this bounds a Season's payout work (10 ranks x 16 lines). The biggest free lines are
/// taken; smaller ones (rounding dust of past Seasons) wait for a Season in which they matter.
pub const MAX_BUDGET_LINES: usize = 16;
/// Bytes of a Borsh-serialised [`BudgetLine`].
pub const BUDGET_LINE_LEN: usize = 1 + 1 + 1 + 8 + 32 + 8 + 8;
/// Most Pool lines the reservations name at once (a Season reserves at most [`MAX_BUDGET_LINES`]).
pub const MAX_RESERVATION_ENTRIES: usize = 64;

/// A Pool basket line as the budget sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolLine {
    pub key: LineKey,
    pub amount: u64,
}

/// One frozen line of a Season's budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct BudgetLine {
    pub side: u8,
    pub class: u8,
    pub tranche: u8,
    pub due_at: i64,
    pub source: Key,
    /// Gemas set aside for this Season's ranks. Never changes after `record`.
    pub amount: u64,
    /// Gemas paid out of it so far.
    pub paid: u64,
}

impl BudgetLine {
    pub fn key(&self) -> LineKey {
        LineKey {
            side: self.side,
            due_at: self.due_at,
            source: self.source,
            class: self.class,
            tranche: self.tranche,
        }
    }
}

/// Gemas of the Pool's lines that Seasons have already promised. A Season reserves its whole
/// budget when recorded, so a later Season (recorded while this one is still paying) can't
/// promise the same Gemas again; paying a rank and closing the Season release them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PoolReservations {
    entries: Vec<(LineKey, u64)>,
}

impl PoolReservations {
    pub fn from_entries(entries: impl IntoIterator<Item = (LineKey, u64)>) -> Self {
        Self {
            entries: entries.into_iter().collect(),
        }
    }

    pub fn entries(&self) -> &[(LineKey, u64)] {
        &self.entries
    }

    pub fn reserved_of(&self, key: &LineKey) -> u64 {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map_or(0, |(_, v)| *v)
    }

    pub fn total(&self) -> u128 {
        self.entries.iter().map(|(_, v)| u128::from(*v)).sum()
    }

    /// What is left of a Pool line for a new budget.
    pub fn free_of(&self, line: &PoolLine) -> u64 {
        line.amount.saturating_sub(self.reserved_of(&line.key))
    }

    fn reserve(&mut self, key: LineKey, n: u64) -> CoreResult<()> {
        match self.entries.iter_mut().find(|(k, _)| *k == key) {
            Some((_, v)) => *v = v.checked_add(n).ok_or(CoreError::Math)?,
            None => self.entries.push((key, n)),
        }
        Ok(())
    }

    fn release(&mut self, key: &LineKey, n: u64) -> CoreResult<()> {
        let i = self
            .entries
            .iter()
            .position(|(k, _)| k == key)
            .ok_or(CoreError::Math)?;
        let left = self.entries[i].1.checked_sub(n).ok_or(CoreError::Math)?;
        if left == 0 {
            self.entries.swap_remove(i);
        } else {
            self.entries[i].1 = left;
        }
        Ok(())
    }
}

/// One payout step: move `amount` Gemas from the Pool line `key` to the winner (zero is
/// possible for tiny lines; the step still counts as done).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PayStep {
    pub key: LineKey,
    pub amount: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct PrizeSeason {
    pub number: u32,
    pub window: SeasonWindow,
    pub count: u8,
    pub winners: [Key; PRIZE_PLACES],
    pub points: [u64; PRIZE_PLACES],
    /// The frozen budget, sorted by line key.
    pub lines: Vec<BudgetLine>,
    /// Per rank: how many budget lines it has been paid.
    pub cursor: [u8; PRIZE_PLACES],
    pub closed: bool,
}

impl PrizeSeason {
    /// `record_season`. Every route must have funded this Season's prize (or have its escrow
    /// switched off). The budget is each Pool line's free Gemas (amount minus earlier
    /// reservations), the biggest [`MAX_BUDGET_LINES`] of them, all reserved here.
    pub fn record(
        number: u32,
        now: i64,
        routes: &[&RouteLedger],
        pool: &[PoolLine],
        reservations: &mut PoolReservations,
        ranking: &[Ranked],
    ) -> CoreResult<Self> {
        if now < season_end(number)? {
            return Err(CoreError::SeasonNotEnded);
        }
        if routes
            .iter()
            .any(|r| r.escrow_enabled && r.last_funded < number)
        {
            return Err(CoreError::SeasonNotFunded);
        }
        if ranking.len() > PRIZE_PLACES {
            return Err(CoreError::SeasonInvalid);
        }
        for (i, r) in ranking.iter().enumerate() {
            if r.points == 0 || (i > 0 && r.points > ranking[i - 1].points) {
                return Err(CoreError::SeasonInvalid);
            }
            if ranking[..i].iter().any(|o| o.account == r.account) {
                return Err(CoreError::SeasonInvalid);
            }
        }
        if pool.iter().any(|l| l.key.class < CLASS_GENERAL) {
            return Err(CoreError::SourceMismatch);
        }
        let mut free: Vec<(u64, &PoolLine)> = pool
            .iter()
            .map(|l| (reservations.free_of(l), l))
            .filter(|(f, _)| *f > 0)
            .collect();
        free.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.key.cmp(&b.1.key)));
        free.truncate(MAX_BUDGET_LINES);
        free.sort_by(|a, b| a.1.key.cmp(&b.1.key));
        let mut lines = Vec::with_capacity(free.len());
        for w in free.windows(2) {
            if w[0].1.key == w[1].1.key {
                return Err(CoreError::SeasonInvalid);
            }
        }
        let mut next = reservations.clone();
        for (f, l) in &free {
            next.reserve(l.key, *f)?;
            lines.push(BudgetLine {
                side: l.key.side,
                class: l.key.class,
                tranche: l.key.tranche,
                due_at: l.key.due_at,
                source: l.key.source,
                amount: *f,
                paid: 0,
            });
        }
        *reservations = next;
        let mut s = Self {
            number,
            window: SeasonWindow::new(number, now),
            count: ranking.len() as u8,
            winners: [[0; 32]; PRIZE_PLACES],
            points: [0; PRIZE_PLACES],
            lines,
            cursor: [0; PRIZE_PLACES],
            closed: false,
        };
        for (i, r) in ranking.iter().enumerate() {
            s.winners[i] = r.account;
            s.points[i] = r.points;
        }
        Ok(s)
    }

    /// What rank `rank` gets from budget line `line`: its share of the frozen amount, rounded
    /// down. Same fraction of every line, so every rank gets the same mix.
    pub fn amount_for(&self, rank: u8, line: usize) -> CoreResult<u64> {
        if rank >= self.count {
            return Err(CoreError::SeasonInvalid);
        }
        let b = self.lines.get(line).ok_or(CoreError::BudgetStep)?;
        let v = u128::from(b.amount) * u128::from(PRIZE_BPS[rank as usize]) / BPS;
        u64::try_from(v).map_err(|_| CoreError::Math)
    }

    pub fn rank_paid(&self, rank: u8) -> bool {
        rank < self.count && self.cursor[rank as usize] as usize == self.lines.len()
    }

    /// `pay_season_rank`, one (rank, line) step. `line` must be the rank's next unpaid line.
    pub fn pay_step(
        &mut self,
        reservations: &mut PoolReservations,
        rank: u8,
        line: usize,
        now: i64,
    ) -> CoreResult<PayStep> {
        if self.closed {
            return Err(CoreError::BudgetStep);
        }
        if rank >= self.count {
            return Err(CoreError::SeasonInvalid);
        }
        self.window.check_pay(rank, now)?;
        if line != self.cursor[rank as usize] as usize || line >= self.lines.len() {
            return Err(CoreError::BudgetStep);
        }
        let amount = self.amount_for(rank, line)?;
        let key = self.lines[line].key();
        let paid = self.lines[line]
            .paid
            .checked_add(amount)
            .ok_or(CoreError::Math)?;
        if paid > self.lines[line].amount {
            return Err(CoreError::BudgetStep);
        }
        if amount > 0 {
            reservations.release(&key, amount)?;
        }
        self.lines[line].paid = paid;
        self.cursor[rank as usize] += 1;
        Ok(PayStep { key, amount })
    }

    /// Admin voids a rank inside the 48-hour window; its share stays in the Pool.
    pub fn void(&mut self, rank: u8, now: i64) -> CoreResult<()> {
        if rank >= self.count {
            return Err(CoreError::SeasonInvalid);
        }
        if now >= self.window.opens_at()? {
            return Err(CoreError::PayoutWindowClosed);
        }
        if self.cursor[rank as usize] != 0 {
            return Err(CoreError::AlreadyPaid);
        }
        if self.window.voided(rank) {
            return Err(CoreError::RankVoided);
        }
        self.window.voided_mask |= 1u16 << rank;
        Ok(())
    }

    /// Every rank is paid or voided (and the window has passed).
    pub fn is_finished(&self, now: i64) -> bool {
        let Ok(opens) = self.window.opens_at() else {
            return false;
        };
        now >= opens && (0..self.count).all(|r| self.rank_paid(r) || self.window.voided(r))
    }

    /// Releases what no rank took (rounding dust and voided ranks' shares) so it rolls into the
    /// next Season's budget. Once, after every rank is paid or voided.
    pub fn close(&mut self, reservations: &mut PoolReservations, now: i64) -> CoreResult<()> {
        if self.closed {
            return Err(CoreError::BudgetStep);
        }
        if !self.is_finished(now) {
            return Err(CoreError::SeasonUnfinished);
        }
        let mut next = reservations.clone();
        for b in &self.lines {
            let left = b.amount - b.paid;
            if left > 0 {
                next.release(&b.key(), left)?;
            }
        }
        *reservations = next;
        self.closed = true;
        Ok(())
    }
}

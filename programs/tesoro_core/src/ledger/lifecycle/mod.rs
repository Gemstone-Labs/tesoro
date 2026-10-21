//! The Match lifecycle: open, join, settle or refund in chunks (spec "Ledger: Match lifecycle,
//! settle and refund", ticket 05). Pure Rust over [`PotPages`], [`Pool`]-backed credits and
//! [`SourceBook`]s; no accounts, no clock, no syscalls. The instruction layer (ticket 09) supplies
//! the bytes, the clock and a [`Settlement`] that can reach the accounts a chunk touches.
//!
//! # The rules in one page
//!
//! * **States** `Open -> Active -> Settling | Refunding -> Closed`, one way. Moving into
//!   `Settling` or `Refunding` is a single atomic step ([`MatchRecord::start_settle`],
//!   [`MatchRecord::start_refund`]); once taken, the other can never start, so a Match is paid
//!   out or refunded exactly once and never both.
//! * **Frozen at the transition.** The outcome, the fee totals, which loser lines the fees are
//!   cut from (as few as possible, largest first), the Backed split and the order of the steps
//!   are all fixed when `Settling` starts. A chunk only walks that plan.
//! * **Chunks are permissionless and idempotent.** [`MatchRecord::chunk`] does at most
//!   `max_steps` steps, each step exactly one credit (a fee cut is one cut plus one fee credit).
//!   Progress lives in the record (a cursor over the plan and over the Pot lines, which are
//!   emptied in place), so a replayed, stale or interleaved chunk can never pay a line twice or
//!   skip one: it just continues, and a finished record does nothing.
//! * **Payout order.** Platform, Studio, Leaderboard, then holders: the fee cuts come first (in
//!   that class order), then the winner's own entry back (the Backer's entry back first when
//!   Backed), then the surplus split by the Offer's share.
//! * **Fee cuts sync first.** Before a line is cut for a fee the Source's landed yield is synced
//!   (`Settlement::sync_source`), because a fee class only gets yield that lands after the cut.
//! * **Deadlines.** Settlement must *start* before the absolute deadline (`opened_at` + 7 days),
//!   which no extension moves. A running settlement is never cut short by the clock.
//! * **Same code as at open.** If the Game's program was redeployed since the Match opened, only
//!   a refund can start, and anyone may start it.
//! * **Room.** Every credit goes through `Pool::put` (basket, then the Account's spill). The
//!   rent for the spill slots a Match may need is reserved when it opens and joins
//!   ([`MatchRecord::room_plan`]), so a chunk can never fail for lack of room. If it ever did,
//!   the failing step changes nothing, the chunk reports it in `blocked`, and the instruction
//!   layer grows the spill and calls again; nothing is skipped.
//! * **Ids** come from the opener's Account and a counter that never resets ([`MatchCounter`]).
//!
//! Not here (ticket 09 wires it): authorities and signatures, the account layout, event-CPI
//! records, the settlement receipt PDA's creation, rent, the table's own "started, nobody acted"
//! proof for [`Outcome::NoShow`], and the Source sync itself.

use std::collections::BTreeMap;

use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

use super::book::{BookError, SourceBook};
use super::draw::{DrawError, Placed, PotBacking, PotPages, SourceBooks};
use super::line_store::{Line, LineStoreError, CLASS_STUDIO, SIDE_OWN, SIDE_WON};
use super::{
    is_ladder_entry, mul_div_floor, to_u64, Key, BPS, MATCH_TIMEOUT_SECS, MAX_TOTAL_FEE_BPS,
};

/// A Match can never be settled later than this after it opened, and no extension moves it.
pub const MAX_MATCH_LIFETIME_SECS: i64 = 7 * 24 * 60 * 60;
/// Furthest an extension may push the refund deadline from now (never past the absolute one).
pub const MAX_EXTENSION_SECS: i64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleError {
    /// The Match is not in a state that allows this.
    InvalidStage,
    /// The refund deadline has passed.
    Expired,
    /// The refund deadline has not passed (and nothing else allows a refund).
    NotExpired,
    /// The absolute deadline has passed: only a refund can start.
    PastAbsoluteDeadline,
    /// The Game's program changed since the Match opened: only a refund can start.
    GameUpgraded,
    NotAuthorised,
    InvalidEntry,
    EntryMismatch,
    SelfMatch,
    InvalidBps,
    FeeTooHigh,
    InvalidDeadline,
    /// A per-Account counter or a total overflowed.
    Math,
    /// The plan and the Pot disagree: a bug or a corrupt account.
    Inconsistent(&'static str),
    Draw(DrawError),
    Book(BookError),
}

impl From<DrawError> for LifecycleError {
    fn from(e: DrawError) -> Self {
        LifecycleError::Draw(e)
    }
}
impl From<BookError> for LifecycleError {
    fn from(e: BookError) -> Self {
        LifecycleError::Book(e)
    }
}
impl From<LineStoreError> for LifecycleError {
    fn from(e: LineStoreError) -> Self {
        LifecycleError::Draw(DrawError::Store(e))
    }
}

pub type LcResult<T> = Result<T, LifecycleError>;

// ---------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------

/// A Match id: the opener's Account and its counter value. Never reused: the counter only grows
/// and Accounts can't be closed and re-created.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, AnchorSerialize, AnchorDeserialize,
)]
pub struct MatchId {
    pub opener: Key,
    pub n: u64,
}

impl MatchId {
    /// The bytes after the `"match"` seed of the Match PDA.
    pub fn seed(&self) -> [u8; 40] {
        let mut out = [0u8; 40];
        out[..32].copy_from_slice(&self.opener);
        out[32..].copy_from_slice(&self.n.to_le_bytes());
        out
    }
}

/// The per-Account counter behind [`MatchId`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MatchCounter {
    next: u64,
}

impl MatchCounter {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn from_next(next: u64) -> Self {
        Self { next }
    }
    pub fn next(&self) -> u64 {
        self.next
    }
    /// The id for a new Match, and the counter moved past it.
    pub fn take(&mut self, opener: Key) -> LcResult<MatchId> {
        let n = self.next;
        self.next = n.checked_add(1).ok_or(LifecycleError::Math)?;
        Ok(MatchId { opener, n })
    }
}

// ---------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------

/// What a Match carries explicitly now that the id is only a counter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, AnchorSerialize, AnchorDeserialize)]
pub struct MatchMeta {
    pub challenge: bool,
    pub asset: u8,
    /// The Game's listed status when the Match opened (an unlisted Game earns no Points).
    pub listed: bool,
}

/// Fee terms snapshotted when the Match opened. The Leaderboard Fee is read when settling starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Terms {
    pub platform_bps: u16,
    pub studio_bps: u16,
    /// `None`: Tesoro's own Studio Fee, a Source counter. `Some(account)`: an outside studio,
    /// paid as a fee line in its basket.
    pub studio_owner: Option<Key>,
}

impl Terms {
    fn validate(&self, leaderboard_bps: u16) -> LcResult<()> {
        let total = self.platform_bps as u32 + self.studio_bps as u32 + leaderboard_bps as u32;
        if total > MAX_TOTAL_FEE_BPS as u32 {
            return Err(LifecycleError::FeeTooHigh);
        }
        Ok(())
    }
}

/// One entrant. `funder == player` unless the entry is Backed; then `share_bps` is the Player's
/// share of the surplus from the accepted Offer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Party {
    pub player: Key,
    pub funder: Key,
    pub share_bps: u16,
}

impl Party {
    pub fn is_backed(&self) -> bool {
        self.funder != self.player
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum Stage {
    /// One entrant waiting.
    Open,
    /// Both entries in escrow.
    Active,
    Settling,
    Refunding,
    /// Every obligation is a durable basket line or spill line; the account may be closed.
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Index of the winning side: 0 opened the Match, 1 joined.
    Winner(u8),
    /// A draw: both entries come back in full.
    Draw,
    /// The table committed "started, nobody acted": each side pays the Platform Fee, the rest of
    /// its entry comes back. Needs both sides in.
    NoShow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefundBy {
    /// The Game's settle authority (the table's refund), on an Open or Active Match.
    Game(Key),
    /// The opener cancelling a Match nobody joined.
    Opener(Key),
    /// Anyone, once the refund deadline passed or the Game was redeployed.
    Anyone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum RunKind {
    Win { winner: u8 },
    NoShow,
    Draw,
    Cancelled,
    Abandoned,
    GameUpgraded,
    ByGame,
}

impl RunKind {
    pub fn is_refund(&self) -> bool {
        !matches!(self, RunKind::Win { .. } | RunKind::NoShow)
    }
}

/// The settlement receipt written when the Match enters Settling or Refunding: the outcome is
/// frozen in core from then on. Tables read its existence as proof their result slot is spent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Receipt {
    pub id: MatchId,
    pub kind: RunKind,
    pub at: i64,
}

/// Seed of the receipt PDA: `["settled", match]`.
pub const RECEIPT_SEED: &[u8] = b"settled";

/// A phase of a run. A Win is `Cuts(loser) -> Back(winner) -> Surplus`, a No-show is
/// `Cuts(0) -> Cuts(1) -> Back(0) -> Back(1)`, a refund is `Back(0) [-> Back(1)]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum Phase {
    /// Cut the fees owed by this side from its Pot lines, in line order, class by class
    /// (Platform, Studio, Leaderboard).
    Cuts(u8),
    /// Return the side's remaining lines to its funder, keeping each line's side.
    Back(u8),
    /// The loser's remaining lines go to the winner (as won lines), split by the Offer's share
    /// when the winner is Backed.
    Surplus { from: u8, to: u8 },
}

/// Most phases a run has.
pub const MAX_PHASES: usize = 4;

/// The frozen plan and its cursor. Fixed size: it does not grow with the Pot, so the Match record
/// stays one small account whatever the number of lines. Which line a fee is cut from is not
/// listed up front: the cut walks the loser's Pot lines in order from the cursor, which only moves
/// forward, so a replayed or interleaved chunk continues exactly where the last one stopped.
#[derive(Debug, Clone, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Run {
    pub kind: RunKind,
    pub receipt: Receipt,
    /// Platform, Studio, Leaderboard totals in Gemas (a No-show: Platform only, both sides).
    pub fees: [u64; 3],
    phases: [Phase; MAX_PHASES],
    n_phases: u8,
    phase_i: u8,
    line_i: u32,
    /// Fee Gemas still to cut from each side's lines, per class.
    cut_left: [[u64; 3]; 2],
    /// Gemas of the surplus still owed to the Player (Backed winner), frozen at the start.
    player_left: u64,
    pub chunks: u32,
    pub steps: u32,
}

impl Run {
    fn phase(&self) -> Option<Phase> {
        (self.phase_i < self.n_phases).then(|| self.phases[self.phase_i as usize])
    }

    fn enter_next_phase(&mut self) {
        self.phase_i += 1;
        self.line_i = 0;
    }

    /// Fee Gemas not cut yet, all sides and classes.
    pub fn fees_left(&self) -> u64 {
        self.cut_left.iter().flatten().sum()
    }
}

fn make_run(kind: RunKind, receipt: Receipt, phases: &[Phase]) -> Run {
    let mut fixed = [Phase::Back(0); MAX_PHASES];
    fixed[..phases.len()].copy_from_slice(phases);
    Run {
        kind,
        receipt,
        fees: [0; 3],
        phases: fixed,
        n_phases: phases.len() as u8,
        phase_i: 0,
        line_i: 0,
        cut_left: [[0; 3]; 2],
        player_left: 0,
        chunks: 0,
        steps: 0,
    }
}

/// The two Pots of a Match, as far as the transaction loaded them. A Match nobody joined has only
/// side 0.
pub type Pots<B = Vec<u8>> = [Option<PotPages<B>>; 2];

/// Gemas still sitting in the Pots (not yet credited anywhere).
pub fn pots_total<B: PotBacking>(pots: &Pots<B>) -> u64 {
    pots.iter()
        .flatten()
        .fold(0u64, |a, p| a.saturating_add(p.total()))
}

/// What one chunk did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkReport {
    pub id: MatchId,
    /// 1-based number of this chunk among the chunks that did work.
    pub chunk_no: u32,
    pub steps: u32,
    /// The run is complete: the Match is Closed.
    pub done: bool,
    /// A step could not proceed (room or a missing book). Nothing was skipped; retry after
    /// fixing it.
    pub blocked: Option<LifecycleError>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Closure {
    pub id: MatchId,
    pub receipt: Receipt,
    pub chunks: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct MatchRecord {
    pub id: MatchId,
    pub meta: MatchMeta,
    pub game: Key,
    pub settle_authority: Key,
    /// The Game program's deploy slot when the Match opened.
    pub deploy_slot: u64,
    pub terms: Terms,
    pub entry: u64,
    pub opened_at: i64,
    /// After this time anyone may refund the Match as abandoned (extendable, never past the
    /// absolute deadline).
    pub deadline: i64,
    /// Settlement must start before this; fixed at open.
    pub deadline_abs: i64,
    pub a: Party,
    pub b: Option<Party>,
    /// Lines each side's Pot held when it was put in (the Pot never gains lines).
    pub pot_lines: [u32; 2],
    stage: Stage,
    run: Option<Run>,
}

/// The accounts a chunk can reach, supplied by the instruction layer (and by the fuzz model).
pub trait Settlement {
    /// The books of the Sources this transaction loaded.
    fn books(&mut self) -> &mut dyn SourceBooks;
    /// Land the Source's newly computed yield (Native and staking Sources use the computed yield
    /// at the clock; ETH/HYPE the latest applied report). Called before a fee cut on the Source.
    fn sync_source(&mut self, source: &Key) -> LcResult<()>;
    /// Credit a line to an Account's basket, or its spill when the basket is full. Changes
    /// nothing on `SpillFull`.
    fn credit(&mut self, owner: &Key, line: &Line) -> LcResult<Placed>;
    /// Credit a fee line (class `CLASS_PLATFORM`, `CLASS_STUDIO` or `CLASS_LEADERBOARD`, blank
    /// key fields) to the recipient: a Source counter when `owner` is `None`, else a fee line in
    /// the owner's basket. Changes nothing on error.
    fn credit_fee(&mut self, class: u8, owner: Option<&Key>, line: &Line) -> LcResult<()>;
}

fn fee_of(entry_pot: u128, bps: u16) -> LcResult<u64> {
    to_u64(mul_div_floor(entry_pot, bps as u128, BPS).map_err(|_| LifecycleError::Math)?)
        .map_err(|_| LifecycleError::Math)
}

impl MatchRecord {
    /// Open a Match with the first entrant's Pot.
    #[allow(clippy::too_many_arguments)]
    pub fn open<B: PotBacking>(
        id: MatchId,
        meta: MatchMeta,
        game: Key,
        settle_authority: Key,
        deploy_slot: u64,
        terms: Terms,
        entry: u64,
        sizes: &[u64],
        a: Party,
        pot_a: &PotPages<B>,
        now: i64,
    ) -> LcResult<Self> {
        if !is_ladder_entry(entry, sizes) {
            return Err(LifecycleError::InvalidEntry);
        }
        terms.validate(0)?;
        if a.share_bps as u128 > BPS {
            return Err(LifecycleError::InvalidBps);
        }
        pot_a.check()?;
        if pot_a.total() != entry {
            return Err(LifecycleError::EntryMismatch);
        }
        let deadline_abs = now
            .checked_add(MAX_MATCH_LIFETIME_SECS)
            .ok_or(LifecycleError::Math)?;
        let deadline = now
            .checked_add(MATCH_TIMEOUT_SECS)
            .ok_or(LifecycleError::Math)?
            .min(deadline_abs);
        Ok(Self {
            id,
            meta,
            game,
            settle_authority,
            deploy_slot,
            terms,
            entry,
            opened_at: now,
            deadline,
            deadline_abs,
            a,
            b: None,
            pot_lines: [
                u32::try_from(pot_a.len()).map_err(|_| LifecycleError::Math)?,
                0,
            ],
            stage: Stage::Open,
            run: None,
        })
    }

    pub fn stage(&self) -> Stage {
        self.stage
    }

    pub fn run(&self) -> Option<&Run> {
        self.run.as_ref()
    }

    pub fn party(&self, side: u8) -> Option<&Party> {
        match side {
            0 => Some(&self.a),
            1 => self.b.as_ref(),
            _ => None,
        }
    }

    /// The second entrant joins with an equal entry; the Match starts.
    pub fn join<B: PotBacking>(&mut self, b: Party, pot_b: &PotPages<B>, now: i64) -> LcResult<()> {
        if self.stage != Stage::Open {
            return Err(LifecycleError::InvalidStage);
        }
        if now >= self.deadline {
            return Err(LifecycleError::Expired);
        }
        if b.share_bps as u128 > BPS {
            return Err(LifecycleError::InvalidBps);
        }
        pot_b.check()?;
        if pot_b.total() != self.entry {
            return Err(LifecycleError::EntryMismatch);
        }
        // nobody plays or funds both sides, or plays against their own Backer or Backing
        if b.player == self.a.player
            || b.funder == self.a.funder
            || b.player == self.a.funder
            || b.funder == self.a.player
        {
            return Err(LifecycleError::SelfMatch);
        }
        let deadline = now
            .checked_add(MATCH_TIMEOUT_SECS)
            .ok_or(LifecycleError::Math)?
            .min(self.deadline_abs);
        self.pot_lines[1] = u32::try_from(pot_b.len()).map_err(|_| LifecycleError::Math)?;
        self.b = Some(b);
        self.stage = Stage::Active;
        self.deadline = deadline;
        Ok(())
    }

    /// Push the refund deadline out (never in), at most `MAX_EXTENSION_SECS` from `now` and never
    /// past the absolute deadline.
    pub fn extend_deadline(&mut self, now: i64, new_deadline: i64) -> LcResult<()> {
        if !matches!(self.stage, Stage::Open | Stage::Active) {
            return Err(LifecycleError::InvalidStage);
        }
        if now >= self.deadline {
            return Err(LifecycleError::Expired);
        }
        let cap = now
            .checked_add(MAX_EXTENSION_SECS)
            .ok_or(LifecycleError::Math)?
            .min(self.deadline_abs);
        if new_deadline < self.deadline || new_deadline > cap {
            return Err(LifecycleError::InvalidDeadline);
        }
        self.deadline = new_deadline;
        Ok(())
    }

    /// Spill slots to have reserved, per Account that can be credited, for settle or refund to
    /// be unable to fail for lack of room. Call at open and again after join; reserve the
    /// difference. Every credit is one line, so the bound is the Pot's lines plus the two lines
    /// a split (Backed surplus, or the cut of a line shared by two fees) can add.
    pub fn room_plan(&self) -> BTreeMap<Key, usize> {
        let n = self.pot_lines[0] as usize + self.pot_lines[1] as usize + 2;
        let mut out = BTreeMap::new();
        let mut add = |k: Key| {
            out.insert(k, n);
        };
        add(self.a.player);
        add(self.a.funder);
        if let Some(b) = &self.b {
            add(b.player);
            add(b.funder);
        }
        if let Some(s) = self.terms.studio_owner {
            // The Studio Fee lines (at most one per cut, so at most `n`) land in the same spill
            // as that Account's own credits when it also plays or backs: the needs add up.
            *out.entry(s).or_insert(0) += n;
        }
        out
    }

    fn receipt(&self, kind: RunKind, now: i64) -> Receipt {
        Receipt {
            id: self.id,
            kind,
            at: now,
        }
    }

    /// Start settling an Active Match: freezes the outcome, the fees and the payout plan, and
    /// returns the settlement receipt to write. Atomic: on `Err` nothing changed.
    ///
    /// `deploy_slot_now` is the slot the Game's deployed build is judged by: the Match's own
    /// `deploy_slot` while the build is the one it opened under (including a program only
    /// extended, whose code is unchanged), else the current slot. A different value means the
    /// Game was upgraded, and only a refund can start.
    pub fn start_settle(
        &mut self,
        now: i64,
        authority: &Key,
        deploy_slot_now: u64,
        outcome: Outcome,
        leaderboard_bps: u16,
    ) -> LcResult<Receipt> {
        if self.stage != Stage::Active {
            return Err(LifecycleError::InvalidStage);
        }
        if *authority != self.settle_authority {
            return Err(LifecycleError::NotAuthorised);
        }
        if now >= self.deadline_abs {
            return Err(LifecycleError::PastAbsoluteDeadline);
        }
        if deploy_slot_now != self.deploy_slot {
            return Err(LifecycleError::GameUpgraded);
        }
        let b = self.b.ok_or(LifecycleError::InvalidStage)?;
        self.terms.validate(leaderboard_bps)?;
        let pot = (self.entry as u128)
            .checked_mul(2)
            .ok_or(LifecycleError::Math)?;
        let run = match outcome {
            Outcome::Draw => self.refund_run(RunKind::Draw, now),
            Outcome::Winner(w) => {
                if w > 1 {
                    return Err(LifecycleError::NotAuthorised);
                }
                let winner = if w == 0 { self.a } else { b };
                let fees = [
                    fee_of(pot, self.terms.platform_bps)?,
                    fee_of(pot, self.terms.studio_bps)?,
                    fee_of(pot, leaderboard_bps)?,
                ];
                let l = 1 - w;
                let fee_total = fees
                    .iter()
                    .try_fold(0u64, |a, f| a.checked_add(*f))
                    .ok_or(LifecycleError::Math)?;
                // the loser's lines (together `entry`) pay every fee
                let surplus = self
                    .entry
                    .checked_sub(fee_total)
                    .ok_or(LifecycleError::FeeTooHigh)?;
                let player_left = if winner.is_backed() {
                    to_u64(
                        mul_div_floor(surplus as u128, winner.share_bps as u128, BPS)
                            .map_err(|_| LifecycleError::Math)?,
                    )
                    .map_err(|_| LifecycleError::Math)?
                } else {
                    0
                };
                let kind = RunKind::Win { winner: w };
                let mut r = make_run(
                    kind,
                    self.receipt(kind, now),
                    &[
                        Phase::Cuts(l),
                        Phase::Back(w),
                        Phase::Surplus { from: l, to: w },
                    ],
                );
                r.fees = fees;
                r.cut_left[l as usize] = fees;
                r.player_left = player_left;
                r
            }
            Outcome::NoShow => {
                let each = fee_of(self.entry as u128, self.terms.platform_bps)?;
                let mut r = self.refund_run(RunKind::NoShow, now);
                r.fees = [each.checked_mul(2).ok_or(LifecycleError::Math)?, 0, 0];
                r.cut_left = [[each, 0, 0], [each, 0, 0]];
                r.phases = [
                    Phase::Cuts(0),
                    Phase::Cuts(1),
                    Phase::Back(0),
                    Phase::Back(1),
                ];
                r.n_phases = 4;
                r
            }
        };
        let receipt = run.receipt;
        self.stage = if run.kind.is_refund() {
            Stage::Refunding
        } else {
            Stage::Settling
        };
        self.run = Some(run);
        Ok(receipt)
    }

    fn refund_run(&self, kind: RunKind, now: i64) -> Run {
        let phases: &[Phase] = if self.b.is_some() {
            &[Phase::Back(0), Phase::Back(1)]
        } else {
            &[Phase::Back(0)]
        };
        make_run(kind, self.receipt(kind, now), phases)
    }

    /// Start refunding an Open or Active Match: every Pot line goes back exactly. Atomic.
    pub fn start_refund(
        &mut self,
        now: i64,
        by: RefundBy,
        deploy_slot_now: u64,
    ) -> LcResult<Receipt> {
        if !matches!(self.stage, Stage::Open | Stage::Active) {
            return Err(LifecycleError::InvalidStage);
        }
        let kind = match by {
            RefundBy::Game(k) => {
                if k != self.settle_authority {
                    return Err(LifecycleError::NotAuthorised);
                }
                RunKind::ByGame
            }
            RefundBy::Opener(k) => {
                if self.stage != Stage::Open || k != self.a.player {
                    return Err(LifecycleError::NotAuthorised);
                }
                RunKind::Cancelled
            }
            RefundBy::Anyone => {
                if deploy_slot_now != self.deploy_slot {
                    RunKind::GameUpgraded
                } else if now >= self.deadline || now >= self.deadline_abs {
                    RunKind::Abandoned
                } else {
                    return Err(LifecycleError::NotExpired);
                }
            }
        };
        let run = self.refund_run(kind, now);
        let receipt = run.receipt;
        self.run = Some(run);
        self.stage = Stage::Refunding;
        Ok(receipt)
    }

    /// The Sources the next `max_lines` steps will touch, so the caller knows which books (and,
    /// for the fee cuts, which Source and Position accounts) to load. It walks the same cursor the
    /// chunk walks.
    pub fn sources_ahead<B: PotBacking>(&self, pots: &Pots<B>, max_lines: usize) -> Vec<Key> {
        let mut out: Vec<Key> = Vec::new();
        let Some(run) = &self.run else { return out };
        let mut left = max_lines;
        let push = |k: Key, out: &mut Vec<Key>| {
            if !out.contains(&k) {
                out.push(k);
            }
        };
        let mut line_i = run.line_i as usize;
        let mut cut_left = run.cut_left;
        for pi in (run.phase_i as usize)..(run.n_phases as usize) {
            if left == 0 {
                break;
            }
            match run.phases[pi] {
                Phase::Cuts(side) => {
                    let Some(p) = pots[side as usize].as_ref() else {
                        continue;
                    };
                    // what is left of the line at `line_i` after the cuts walked so far
                    let mut avail: Option<u64> = None;
                    for need in cut_left[side as usize].iter_mut() {
                        while *need > 0 && left > 0 {
                            let Some(l) = p.get(line_i) else { break };
                            let a = avail.unwrap_or(l.amount);
                            if a == 0 {
                                line_i += 1;
                                avail = None;
                                continue;
                            }
                            push(l.source, &mut out);
                            let take = a.min(*need);
                            *need -= take;
                            left -= 1;
                            if a == take {
                                line_i += 1;
                                avail = None;
                            } else {
                                avail = Some(a - take);
                            }
                        }
                    }
                    if cut_left[side as usize].iter().any(|n| *n > 0) {
                        break;
                    }
                    line_i = 0;
                }
                Phase::Back(s) | Phase::Surplus { from: s, .. } => {
                    let Some(p) = pots[s as usize].as_ref() else {
                        continue;
                    };
                    while line_i < p.len() && left > 0 {
                        if let Some(l) = p.get(line_i).filter(|l| l.amount > 0) {
                            push(l.source, &mut out);
                            left -= 1;
                        }
                        line_i += 1;
                    }
                    if line_i < p.len() {
                        break;
                    }
                    line_i = 0;
                }
            }
        }
        out
    }

    /// Run up to `max_steps` steps of the Settling or Refunding plan. Permissionless and
    /// idempotent: progress is in the record, a finished record reports `done` and does nothing.
    pub fn chunk<B: PotBacking>(
        &mut self,
        pots: &mut Pots<B>,
        w: &mut dyn Settlement,
        max_steps: u32,
    ) -> LcResult<ChunkReport> {
        match self.stage {
            Stage::Open | Stage::Active => return Err(LifecycleError::InvalidStage),
            Stage::Closed => {
                return Ok(ChunkReport {
                    id: self.id,
                    chunk_no: self.run.as_ref().map_or(0, |r| r.chunks),
                    steps: 0,
                    done: true,
                    blocked: None,
                })
            }
            Stage::Settling | Stage::Refunding => {}
        }
        let mut steps = 0u32;
        let mut blocked = None;
        let mut done = false;
        while steps < max_steps {
            match self.step(pots, w) {
                Ok(Stepped::Did) => steps += 1,
                Ok(Stepped::Finished) => {
                    done = true;
                    break;
                }
                Err(e) => {
                    if steps == 0 {
                        return Err(e);
                    }
                    blocked = Some(e);
                    break;
                }
            }
        }
        if !done && blocked.is_none() && steps == max_steps {
            // a chunk that used its whole budget may have landed exactly on the end
            done = self.is_finished(pots);
        }
        if done {
            self.stage = Stage::Closed;
        }
        let run = self
            .run
            .as_mut()
            .ok_or(LifecycleError::Inconsistent("no run"))?;
        if steps > 0 || done {
            run.chunks = run.chunks.checked_add(1).ok_or(LifecycleError::Math)?;
        }
        run.steps = run.steps.checked_add(steps).ok_or(LifecycleError::Math)?;
        Ok(ChunkReport {
            id: self.id,
            chunk_no: run.chunks,
            steps,
            done,
            blocked,
        })
    }

    fn is_finished<B: PotBacking>(&self, pots: &Pots<B>) -> bool {
        let Some(run) = &self.run else { return false };
        (run.phase_i as usize..run.n_phases as usize).all(|pi| match run.phases[pi] {
            Phase::Cuts(side) => run.cut_left[side as usize].iter().all(|n| *n == 0),
            Phase::Back(s) | Phase::Surplus { from: s, .. } => {
                let start = if pi == run.phase_i as usize {
                    run.line_i as usize
                } else {
                    0
                };
                pots[s as usize].as_ref().is_none_or(|p| {
                    (start..p.len()).all(|i| p.get(i).is_none_or(|l| l.amount == 0))
                })
            }
        })
    }

    fn step<B: PotBacking>(
        &mut self,
        pots: &mut Pots<B>,
        w: &mut dyn Settlement,
    ) -> LcResult<Stepped> {
        let Self {
            run, a, b, terms, ..
        } = self;
        let run = run.as_mut().ok_or(LifecycleError::Inconsistent("no run"))?;
        loop {
            let Some(phase) = run.phase() else {
                return Ok(Stepped::Finished);
            };
            match phase {
                Phase::Cuts(side) => {
                    let Some(class) = run.cut_left[side as usize].iter().position(|n| *n > 0)
                    else {
                        run.enter_next_phase();
                        continue;
                    };
                    let p = pot_of(pots, side)?;
                    let n = p.len();
                    let mut at = run.line_i as usize;
                    while at < n && p.get(at).is_none_or(|l| l.amount == 0) {
                        at += 1;
                    }
                    run.line_i = at as u32;
                    let Some(orig) = p.get(at) else {
                        return Err(LifecycleError::Inconsistent("fees exceed the Pot's lines"));
                    };
                    let k = orig.amount.min(run.cut_left[side as usize][class]);
                    cut_step(p, at, terms, w, class as u8, k)?;
                    run.cut_left[side as usize][class] -= k;
                    return Ok(Stepped::Did);
                }
                Phase::Back(side) | Phase::Surplus { from: side, .. } => {
                    let p = pot_of(pots, side)?;
                    let n = p.len();
                    let mut at = run.line_i as usize;
                    while at < n && p.get(at).is_none_or(|l| l.amount == 0) {
                        at += 1;
                    }
                    run.line_i = at as u32;
                    if at >= n {
                        run.enter_next_phase();
                        continue;
                    }
                    let orig = p
                        .get(at)
                        .ok_or(LifecycleError::Inconsistent("line vanished"))?;
                    match phase {
                        Phase::Back(_) => {
                            let party = if side == 0 { Some(*a) } else { *b };
                            let owner = party
                                .ok_or(LifecycleError::Inconsistent("no party"))?
                                .funder;
                            w.credit(&owner, &orig)?;
                            p.set(at, &emptied(&orig))?;
                        }
                        Phase::Surplus { to, .. } => {
                            let winner = if to == 0 { Some(*a) } else { *b }
                                .ok_or(LifecycleError::Inconsistent("no winner"))?;
                            surplus_step(p, at, &mut run.player_left, w, &winner, &orig)?;
                        }
                        Phase::Cuts(_) => unreachable!(),
                    }
                    return Ok(Stepped::Did);
                }
            }
        }
    }

    /// Close a finished Match. Every obligation is now a durable basket or spill line (or a fee
    /// credit), so the instruction layer may return the rent and release the unused reserve.
    /// `pot_left` is what the Pots still hold: it must be nothing.
    pub fn close(self, pot_left: u64) -> LcResult<Closure> {
        if self.stage != Stage::Closed {
            return Err(LifecycleError::InvalidStage);
        }
        if pot_left != 0 {
            return Err(LifecycleError::Inconsistent("closed with Gemas in the Pot"));
        }
        let run = self.run.ok_or(LifecycleError::Inconsistent("no run"))?;
        Ok(Closure {
            id: self.id,
            receipt: run.receipt,
            chunks: run.chunks,
        })
    }
}

enum Stepped {
    Did,
    Finished,
}

fn pot_of<B: PotBacking>(pots: &mut Pots<B>, side: u8) -> LcResult<&mut PotPages<B>> {
    pots[(side & 1) as usize]
        .as_mut()
        .ok_or(LifecycleError::Inconsistent("pot not supplied"))
}

fn emptied(l: &Line) -> Line {
    let mut z = *l;
    z.amount = 0;
    z.uncovered = 0;
    z
}

/// Cut `k` Gemas of the Pot line at `at` into the fee `class`.
fn cut_step<B: PotBacking>(
    p: &mut PotPages<B>,
    at: usize,
    terms: &Terms,
    w: &mut dyn Settlement,
    class: u8,
    k: u64,
) -> LcResult<()> {
    let orig = p
        .get(at)
        .ok_or(LifecycleError::Inconsistent("cut line vanished"))?;
    if orig.amount < k {
        return Err(LifecycleError::Inconsistent("cut larger than its line"));
    }
    let owner = if class == CLASS_STUDIO {
        terms.studio_owner
    } else {
        None
    };
    w.sync_source(&orig.source)?;
    w.books().snapshot(&orig.source)?;
    let mut src = orig;
    let mut dst = SourceBook::blank_line(SIDE_OWN, 0, orig.source, class, 0);
    {
        let (book, history) = w.books().book_with_history(&orig.source)?;
        book.cut_fee(&mut src, &mut dst, k, history)?;
    }
    if let Err(e) = w.credit_fee(class, owner.as_ref(), &dst) {
        w.books().rollback(&orig.source)?;
        return Err(e);
    }
    if src.amount == 0 {
        src.uncovered = 0;
    }
    p.set(at, &src)?;
    Ok(())
}

fn surplus_step<B: PotBacking>(
    p: &mut PotPages<B>,
    at: usize,
    player_left: &mut u64,
    w: &mut dyn Settlement,
    winner: &Party,
    orig: &Line,
) -> LcResult<()> {
    let mut won = *orig;
    won.side = SIDE_WON;
    if !winner.is_backed() {
        w.credit(&winner.player, &won)?;
        p.set(at, &emptied(orig))?;
        return Ok(());
    }
    if *player_left == 0 {
        w.credit(&winner.funder, &won)?;
        p.set(at, &emptied(orig))?;
        return Ok(());
    }
    let take = (*player_left).min(orig.amount);
    if take == orig.amount {
        w.credit(&winner.player, &won)?;
        p.set(at, &emptied(orig))?;
    } else {
        w.books().snapshot(&orig.source)?;
        let mut rest = *orig;
        let mut part =
            SourceBook::blank_line(SIDE_WON, orig.due_at, orig.source, orig.class, orig.tranche);
        {
            let (book, history) = w.books().book_with_history(&orig.source)?;
            book.transfer(&mut rest, &mut part, take, &*history)?;
        }
        if let Err(e) = w.credit(&winner.player, &part) {
            w.books().rollback(&orig.source)?;
            return Err(e);
        }
        p.set(at, &rest)?;
    }
    *player_left -= take;
    Ok(())
}

#[cfg(test)]
mod tests;

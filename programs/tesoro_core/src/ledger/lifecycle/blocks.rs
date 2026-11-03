//! The settle building blocks a Match path is made of: fee totals, the fee cut, the hand-out of
//! a Pot line to a payee, and the Player/funder split of a Backed winner's surplus. Pure
//! functions over [`PotPages`] and a [`Settlement`]; the head-to-head path in the parent module
//! walks them in its fixed plan, and any other Match path can call them for its own plan.
//!
//! Every block is atomic: on `Err` the Pot, the books and the credits are unchanged.

use super::{LcResult, LifecycleError, Party, Pots, Settlement, Terms};
use crate::ledger::book::SourceBook;
use crate::ledger::draw::{Placed, PotBacking, PotPages};
use crate::ledger::line_store::{Line, CLASS_STUDIO, SIDE_OWN, SIDE_WON};
use crate::ledger::{mul_div_floor, to_u64, Key, BPS};

/// One credit a block made: the line that moved, who got it, and where it landed.
pub(crate) struct Credit {
    pub(crate) line: Line,
    pub(crate) owner: Option<Key>,
    pub(crate) placement: u8,
}

#[inline(always)]
pub(crate) fn placement(p: Placed) -> u8 {
    match p {
        Placed::Basket => 0,
        Placed::Spill => 1,
        Placed::Overflow => 2,
    }
}

pub(crate) fn fee_of(entry_pot: u128, bps: u16) -> LcResult<u64> {
    to_u64(mul_div_floor(entry_pot, bps as u128, BPS).map_err(|_| LifecycleError::Math)?)
        .map_err(|_| LifecycleError::Math)
}

/// Platform, Studio and Leaderboard fee totals of a won Match, each a floored share of `pot`.
/// Refuses terms whose total fee is above the cap.
pub fn win_fees(pot: u128, terms: &Terms, leaderboard_bps: u16) -> LcResult<[u64; 3]> {
    terms.validate(leaderboard_bps)?;
    Ok([
        fee_of(pot, terms.platform_bps)?,
        fee_of(pot, terms.studio_bps)?,
        fee_of(pot, leaderboard_bps)?,
    ])
}

/// What is left of the losers' lines (together `losing_lines`) once every fee is cut.
pub fn win_surplus(losing_lines: u64, fees: [u64; 3]) -> LcResult<u64> {
    let total = fees
        .iter()
        .try_fold(0u64, |a, f| a.checked_add(*f))
        .ok_or(LifecycleError::Math)?;
    losing_lines
        .checked_sub(total)
        .ok_or(LifecycleError::FeeTooHigh)
}

/// The Player's floored share of a Backed winner's surplus.
pub fn player_share(surplus: u64, share_bps: u16) -> LcResult<u64> {
    to_u64(
        mul_div_floor(surplus as u128, share_bps as u128, BPS).map_err(|_| LifecycleError::Math)?,
    )
    .map_err(|_| LifecycleError::Math)
}

/// Return the whole Pot line at `at` (`orig`, as just read) to `owner` (an entry back), keeping
/// its side. The caller reports the credit.
#[inline(always)]
pub(crate) fn back_step<B: PotBacking>(
    p: &mut PotPages<B>,
    at: usize,
    orig: &Line,
    w: &mut dyn Settlement,
    owner: &Key,
) -> LcResult<Placed> {
    let placed = w.credit(owner, orig)?;
    p.set(at, &emptied(orig))?;
    Ok(placed)
}

#[inline(always)]
pub(crate) fn pot_of<B: PotBacking>(pots: &mut Pots<B>, side: u8) -> LcResult<&mut PotPages<B>> {
    pots[(side & 1) as usize]
        .as_mut()
        .ok_or(LifecycleError::Inconsistent("pot not supplied"))
}

#[inline(always)]
pub(crate) fn emptied(l: &Line) -> Line {
    let mut z = *l;
    z.amount = 0;
    z.uncovered = 0;
    z
}

/// Cut `k` Gemas of the Pot line at `at` into the fee `class`.
pub(crate) fn cut_step<B: PotBacking>(
    p: &mut PotPages<B>,
    at: usize,
    terms: &Terms,
    w: &mut dyn Settlement,
    class: u8,
    k: u64,
) -> LcResult<Credit> {
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
    if class == CLASS_STUDIO && !terms.studio_priority {
        // no priority: the Studio Fee is ordinary won Gemas for the recipient
        let to = owner.ok_or(LifecycleError::Inconsistent(
            "a plain Studio Fee needs a recipient",
        ))?;
        return pay_plain(p, at, w, &to, &orig, k);
    }
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
    Ok(Credit {
        line: dst,
        owner,
        placement: if owner.is_none() { 3 } else { 255 },
    })
}

/// Moves `k` Gemas of the Pot line at `at` to `to` as ordinary won Gemas (the whole line, or a part).
pub(crate) fn pay_plain<B: PotBacking>(
    p: &mut PotPages<B>,
    at: usize,
    w: &mut dyn Settlement,
    to: &Key,
    orig: &Line,
    k: u64,
) -> LcResult<Credit> {
    if k == orig.amount {
        let mut won = *orig;
        won.side = SIDE_WON;
        let placed = w.credit(to, &won)?;
        p.set(at, &emptied(orig))?;
        return Ok(Credit {
            line: won,
            owner: Some(*to),
            placement: placement(placed),
        });
    }
    w.books().snapshot(&orig.source)?;
    let mut rest = *orig;
    let mut part =
        SourceBook::blank_line(SIDE_WON, orig.due_at, orig.source, orig.class, orig.tranche);
    {
        let (book, history) = w.books().book_with_history(&orig.source)?;
        book.transfer(&mut rest, &mut part, k, &*history)?;
    }
    let placed = match w.credit(to, &part) {
        Ok(p) => p,
        Err(e) => {
            w.books().rollback(&orig.source)?;
            return Err(e);
        }
    };
    p.set(at, &rest)?;
    Ok(Credit {
        line: part,
        owner: Some(*to),
        placement: placement(placed),
    })
}

pub(crate) fn surplus_step<B: PotBacking>(
    p: &mut PotPages<B>,
    at: usize,
    player_left: &mut u64,
    w: &mut dyn Settlement,
    winner: &Party,
    orig: &Line,
) -> LcResult<Credit> {
    let mut won = *orig;
    won.side = SIDE_WON;
    if !winner.is_backed() {
        let placed = w.credit(&winner.player, &won)?;
        p.set(at, &emptied(orig))?;
        return Ok(Credit {
            line: won,
            owner: Some(winner.player),
            placement: placement(placed),
        });
    }
    if *player_left == 0 {
        let placed = w.credit(&winner.funder, &won)?;
        p.set(at, &emptied(orig))?;
        return Ok(Credit {
            line: won,
            owner: Some(winner.funder),
            placement: placement(placed),
        });
    }
    let take = (*player_left).min(orig.amount);
    let (line, placed) = if take == orig.amount {
        let placed = w.credit(&winner.player, &won)?;
        p.set(at, &emptied(orig))?;
        (won, placed)
    } else {
        w.books().snapshot(&orig.source)?;
        let mut rest = *orig;
        let mut part =
            SourceBook::blank_line(SIDE_WON, orig.due_at, orig.source, orig.class, orig.tranche);
        {
            let (book, history) = w.books().book_with_history(&orig.source)?;
            book.transfer(&mut rest, &mut part, take, &*history)?;
        }
        let placed = match w.credit(&winner.player, &part) {
            Ok(p) => p,
            Err(e) => {
                w.books().rollback(&orig.source)?;
                return Err(e);
            }
        };
        p.set(at, &rest)?;
        (part, placed)
    };
    *player_left -= take;
    Ok(Credit {
        line,
        owner: Some(winner.player),
        placement: placement(placed),
    })
}

use super::*;
use crate::ledger::book::checkpoint::MemCheckpoints;
use crate::ledger::book::{fp, SourceBook};
use crate::ledger::line_store::{CLASS_GENERAL, SIDE_WON};
use crate::ledger::{
    principal_for_shares, stake_position_accrued, tokens_for_units, SourceChain, STAKE_RATE_SCALE,
};
use proptest::prelude::*;

const OWNER: [u8; 32] = [1; 32];
const POSITION: [u8; 32] = [2; 32];
const SOL: u64 = 1_000_000_000;
const R0: u64 = 1_300_000_000_000;
const FEE: u16 = 2_000;
const PRICE: u64 = 150_000_000;
const T0: i64 = 1_800_000_000;

fn source_key(i: usize) -> [u8; 32] {
    let mut k = [9; 32];
    k[0] = i as u8;
    k
}

/// A staking-token Position with its Sources, books, histories and the baskets' lines of two
/// holders (0 = the owner, 1 = a winner), in the shape the instructions use them.
#[derive(Clone)]
struct World {
    pos: Position,
    srcs: Vec<Source>,
    books: Vec<SourceBook>,
    cks: Vec<MemCheckpoints>,
    /// `lines[s]` = lines of Source `s`, each tagged with its holder.
    lines: Vec<Vec<(u8, Line)>>,
    rate: u64,
    route: RouteLedger,
    custody0: u64,
    paid_pre: u64,
    paid_post: u64,
    unlocked: Option<UnlockPayout>,
    now: i64,
}

impl World {
    fn new(shares: u64) -> Self {
        let principal = principal_for_shares(shares, R0).unwrap();
        let mut pos =
            Position::new(OWNER, SourceChain::Solana, [7; 32], 9, principal, 500).unwrap();
        pos.stake_rate_open = R0;
        pos.yield_fee_bps = FEE;
        pos.custody_shares = shares;
        let route = RouteLedger {
            escrow_enabled: true,
            ..RouteLedger::default()
        };
        Self {
            pos,
            srcs: vec![],
            books: vec![],
            cks: vec![],
            lines: vec![],
            rate: R0,
            route,
            custody0: shares,
            paid_pre: 0,
            paid_post: 0,
            unlocked: None,
            now: T0,
        }
    }

    fn share_rate(&self) -> ShareRate {
        ShareRate::stake(self.rate).unwrap()
    }

    fn net(&self) -> u64 {
        stake_position_accrued(&self.pos, self.rate).unwrap().net
    }

    fn fee_units(&self) -> u64 {
        stake_position_accrued(&self.pos, self.rate).unwrap().fee
    }

    /// Takes an Advance of `months`, closing the previous one if it is repaid.
    fn advance(&mut self, months: u8) -> CoreResult<()> {
        let net = self.net();
        let rate = self.share_rate();
        let mut pos = self.pos.clone();
        let prev = pos.open_advance.map(|i| i as usize);
        match prev {
            Some(i) => {
                let (src, book, ck) = (&self.srcs[i], &mut self.books[i], &mut self.cks[i]);
                let mut book2 = book.clone();
                let mut ck2 = ck.clone();
                prepare_advance(&mut pos, Some((src, &mut book2, &mut ck2)), net, &rate)?;
                *book = book2;
                *ck = ck2;
            }
            None => prepare_advance::<crate::ledger::book::ClassArray, MemCheckpoints>(
                &mut pos, None, net, &rate,
            )?,
        }
        let mut src = pos.open_advance(POSITION, months, PRICE, FEE)?;
        src.due_at = planned_due_at(self.now, months, 1)?;
        let s = self.srcs.len();
        let mut book = SourceBook::new();
        let ck = MemCheckpoints::new(source_key(s));
        let line = advance_line(&mut book, source_key(s), &src, &ck)?;
        self.pos = pos;
        self.srcs.push(src);
        self.books.push(book);
        self.cks.push(ck);
        self.lines.push(vec![(0, line)]);
        Ok(())
    }

    fn sync(&mut self, s: usize) -> CoreResult<()> {
        let (net, rate) = (self.net(), self.share_rate());
        sync_source(
            &mut self.pos,
            &self.srcs[s],
            &mut self.books[s],
            net,
            &rate,
            &mut self.cks[s],
        )
        .map(drop)
    }

    fn find(&self, s: usize, holder: u8, class: u8) -> Option<usize> {
        self.lines[s]
            .iter()
            .position(|(h, l)| *h == holder && l.class == class && l.amount > 0)
    }

    fn extend(&mut self, months: u8) -> CoreResult<()> {
        let Some(open) = self.pos.open_advance else {
            return Err(CoreError::NoOpenAdvance);
        };
        let s = open as usize;
        let (net, rate) = (self.net(), self.share_rate());
        let (line, _) = extend_source(
            &mut self.pos,
            &mut self.srcs[s],
            source_key(s),
            &mut self.books[s],
            months,
            FEE,
            1,
            net,
            &rate,
            &mut self.cks[s],
        )?;
        self.lines[s].push((0, line));
        Ok(())
    }

    /// Redeems `k` of a line, paying shares from the Position (or the route once Unlocked).
    fn redeem(&mut self, s: usize, idx: usize, k: u64) -> CoreResult<u64> {
        self.sync(s)?;
        let (h, mut line) = self.lines[s][idx];
        let r = self.books[s].redeem(&mut line, k, &self.cks[s])?;
        let paid = u64::try_from(r.shares).unwrap();
        let unlocked = self.pos.status == PositionStatus::Unlocked;
        debit_paid_shares(
            &mut self.pos,
            CustodyKind::Stake,
            unlocked.then_some(&mut self.route),
            paid,
        )?;
        self.srcs[s].redeemed += k;
        self.lines[s][idx] = (h, line);
        if unlocked {
            self.paid_post += paid;
        } else {
            self.paid_pre += paid;
        }
        Ok(paid)
    }

    fn return_own(&mut self, s: usize, idx: usize, k: u64) -> CoreResult<()> {
        let (net, rate) = (self.net(), self.share_rate());
        let (h, mut line) = self.lines[s][idx];
        return_own_source(
            &mut self.pos,
            &mut self.srcs[s],
            &mut self.books[s],
            &mut line,
            k,
            net,
            &rate,
            &mut self.cks[s],
        )?;
        self.lines[s][idx] = (h, line);
        Ok(())
    }

    /// A Match win: `k` Gemas of the owner's line move to the winner (holder 1) as won Gemas.
    fn win(&mut self, s: usize, idx: usize, k: u64) -> CoreResult<()> {
        self.sync(s)?;
        let (h, mut src_line) = self.lines[s][idx];
        let mut dst = SourceBook::blank_line(
            SIDE_WON,
            src_line.due_at,
            src_line.source,
            src_line.class,
            src_line.tranche,
        );
        let at = self.lines[s]
            .iter()
            .position(|(hh, l)| *hh == 1 && l.key() == dst.key());
        if let Some(i) = at {
            dst = self.lines[s][i].1;
        }
        self.books[s].transfer(&mut src_line, &mut dst, k, &self.cks[s])?;
        self.lines[s][idx] = (h, src_line);
        match at {
            Some(i) => self.lines[s][i] = (1, dst),
            None => self.lines[s].push((1, dst)),
        }
        Ok(())
    }

    fn unlock(&mut self) -> CoreResult<()> {
        let net = self.net();
        let rate = self.share_rate();
        let mut pos = self.pos.clone();
        if let Some(i) = pos.open_advance.map(|i| i as usize) {
            let mut book = self.books[i].clone();
            let mut ck = self.cks[i].clone();
            close_advance(&mut pos, &self.srcs[i], &mut book, net, &rate, &mut ck)?;
            self.books[i] = book;
            self.cks[i] = ck;
        } else {
            bank_free_yield(&mut pos, net, &rate)?;
        }
        let payout = settle_unlock(&mut pos, CustodyKind::Stake, self.fee_units(), &rate)?;
        let mut route = self.route.clone();
        route_after_unlock(&mut route, &payout, 5_000)?;
        self.pos = pos;
        self.route = route;
        self.unlocked = Some(payout);
        Ok(())
    }

    /// Everything that must hold after every operation.
    fn check(&self) {
        let mut held_in_books = 0u128;
        for (s, book) in self.books.iter().enumerate() {
            let lines = self.lines[s].iter().map(|(_, l)| l);
            book.check(self.srcs[s].redeemed, lines)
                .unwrap_or_else(|e| panic!("source {s}: {e}"));
            held_in_books += book_shares(book);
        }
        if self.pos.status == PositionStatus::Locked {
            assert_eq!(
                self.pos.held_shares, held_in_books,
                "the Position's held shares are exactly the shares its books hold"
            );
            assert!(
                u128::from(self.pos.custody_shares - self.pos.paid_shares) << SHARE_BITS
                    >= self.pos.held_shares,
                "the custody still covers what holders are owed"
            );
        }
        self.route.check(&[]).expect("route");
        if let Some(p) = &self.unlocked {
            assert_eq!(
                self.custody0,
                self.paid_pre + p.owner_shares + p.fee_shares + p.owed_shares,
                "the custody is conserved through Unlock"
            );
            assert_eq!(
                u64::try_from(self.route.owed_shares).unwrap() + self.paid_post,
                p.owed_shares,
                "owed shares only leave by being paid"
            );
        }
    }

    fn redeemable(&self, s: usize, idx: usize) -> u64 {
        self.books[s].redeemable(&self.lines[s][idx].1).unwrap()
    }
}

#[test]
fn coverage_lands_in_class_order_and_the_open_advance_closes_when_repaid() {
    let mut w = World::new(10 * SOL);
    w.advance(12).unwrap();
    let issued = w.srcs[0].issued;
    assert!(issued > 0);
    assert_eq!(book_shares(&w.books[0]), 0);
    // The pool grows 2%: some of the Advance is repaid.
    w.rate = R0 + R0 / 50;
    w.sync(0).unwrap();
    w.check();
    let b = &w.books[0];
    assert!(b.uncovered_total() > 0 && b.uncovered_total() < fp(issued));
    assert!(w.pos.held_shares > 0);
    // It cannot close yet.
    assert_eq!(w.advance(1), Err(CoreError::AdvanceAlreadyOpen));
    // A large growth repays it, the excess is the owner's pocket, and a new Advance closes it.
    w.rate = R0 * 2;
    w.sync(0).unwrap();
    assert_eq!(w.books[0].uncovered_total(), 0);
    assert!(w.books[0].owner_shares > 0);
    w.advance(1).unwrap();
    assert!(w.pos.free_shares > 0, "the pocket became free yield");
    assert_eq!(w.books[0].owner_shares, 0);
    w.check();
}

#[test]
fn a_slash_after_landing_lowers_the_value_of_ready_shares_not_their_number() {
    let mut w = World::new(10 * SOL);
    w.advance(12).unwrap();
    w.rate = R0 + R0 / 20;
    w.sync(0).unwrap();
    let before = w.redeemable(0, 0);
    let shares_before = w.books[0].shares_of(&w.lines[0][0].1, &w.cks[0]).unwrap();
    assert!(before > 0);
    // The pool is slashed below the rate the Position opened at.
    w.rate = R0 - R0 / 10;
    w.sync(0).unwrap();
    assert_eq!(w.redeemable(0, 0), before, "Redeem now never goes down");
    assert_eq!(
        w.books[0].shares_of(&w.lines[0][0].1, &w.cks[0]).unwrap(),
        shares_before,
        "the shares the yield was worth when it landed"
    );
    let paid = w.redeem(0, 0, before).unwrap();
    // Value of the payout falls with the rate: fewer lamports than when it landed.
    let landed_value = tokens_for_units(1, R0 + R0 / 20).unwrap();
    assert!(landed_value <= 1 && paid > 0);
    w.check();
}

#[test]
fn sub_gema_dust_from_proportional_moves_does_not_block_a_repaid_source() {
    let mut w = World::new(10 * SOL);
    w.advance(6).unwrap();
    // Many small partial moves, each leaving a fixed-point remainder with the owner's pocket.
    w.rate = R0 + R0 / 100;
    for _ in 0..40 {
        w.sync(0).unwrap();
        let idx = w.find(0, 0, CLASS_GENERAL).unwrap();
        if w.lines[0][idx].1.amount > 7 {
            w.win(0, idx, 7).unwrap();
        }
        w.rate += R0 / 4_000;
    }
    w.check();
    // Pay everything back.
    w.rate = R0 * 3;
    w.sync(0).unwrap();
    assert_eq!(w.books[0].uncovered_total(), 0);
    w.unlock().unwrap();
    w.check();
}

#[test]
fn return_own_releases_ready_once_and_unlock_pays_it_once() {
    let mut w = World::new(10 * SOL);
    w.advance(12).unwrap();
    w.rate = R0 + R0 / 25;
    w.sync(0).unwrap();
    let idx = w.find(0, 0, CLASS_GENERAL).unwrap();
    let amount = w.lines[0][idx].1.amount;
    // Return everything: the ready part goes to the pocket, the unpaid part is cancelled.
    let held_before = w.pos.held_shares;
    w.return_own(0, idx, amount).unwrap();
    assert_eq!(w.books[0].uncovered_total(), 0);
    assert!(
        w.pos.open_advance.is_none(),
        "returning the debt closes the Advance"
    );
    assert!(w.pos.free_shares > 0);
    assert!(w.pos.held_shares < held_before + 1);
    w.check();
    let free = w.pos.free_shares;
    // Unlock: the owner gets the rest of the custody; the free shares are included once.
    w.unlock().unwrap();
    let p = w.unlocked.unwrap();
    assert!(
        p.owed_shares <= 1,
        "nobody holds Gemas of this Source: at most a stranded share is owed"
    );
    assert_eq!(
        w.custody0,
        p.owner_shares + p.fee_shares + p.owed_shares,
        "custody = owner + fee + owed"
    );
    assert!(free >> SHARE_BITS <= u128::from(p.owner_shares));
    w.check();
}

#[test]
fn unlock_with_debt_is_refused_and_moves_nothing() {
    let mut w = World::new(10 * SOL);
    w.advance(12).unwrap();
    w.rate = R0 + R0 / 100;
    let pos = w.pos.clone();
    let route = w.route.clone();
    assert_eq!(w.unlock(), Err(CoreError::DebtOutstanding));
    assert_eq!(w.pos, pos);
    assert_eq!(w.route, route);
}

#[test]
fn holders_of_an_unlocked_position_are_paid_from_owed_shares() {
    let mut w = World::new(10 * SOL);
    w.advance(3).unwrap();
    w.rate = R0 * 2;
    w.sync(0).unwrap();
    let idx = w.find(0, 0, CLASS_GENERAL).unwrap();
    let issued = w.lines[0][idx].1.amount;
    w.win(0, idx, issued / 2).unwrap();
    w.unlock().unwrap();
    let p = w.unlocked.unwrap();
    assert!(p.owed_shares > 0 && p.fee_shares > 0);
    // The route owes holders exactly and the Pool's half of the fee is protected.
    assert_eq!(w.route.owed_shares, u128::from(p.owed_shares));
    assert_eq!(w.route.pool_owed, u128::from(p.fee_shares) / 2);
    assert_eq!(
        w.route.spendable(),
        u128::from(p.fee_shares) - u128::from(p.fee_shares) / 2
    );
    let won = w.find(0, 1, CLASS_GENERAL).unwrap();
    let k = w.redeemable(0, won);
    assert!(k > 0);
    let paid = w.redeem(0, won, k).unwrap();
    assert!(paid > 0);
    w.check();
    // Spending never touches what holders are owed or the Pool's half.
    let spendable = w.route.spendable();
    assert_eq!(
        w.route.clone().spend(spendable + 1),
        Err(CoreError::OverSpendable)
    );
    w.route.spend(spendable).unwrap();
    w.check();
}

#[test]
fn extend_never_slows_an_earlier_holder_and_lands_after_everything_issued_before() {
    let mut w = World::new(10 * SOL);
    w.advance(6).unwrap();
    w.rate = R0 + R0 / 100;
    w.sync(0).unwrap();
    let idx = w.find(0, 0, CLASS_GENERAL).unwrap();
    w.win(0, idx, w.lines[0][idx].1.amount / 3).unwrap();
    let won = w.find(0, 1, CLASS_GENERAL).unwrap();
    let before = w.redeemable(0, won);
    w.extend(6).unwrap();
    assert_eq!(w.redeemable(0, won), before);
    let ext = w.find(0, 0, CLASS_GENERAL + 1).unwrap();
    assert_eq!(w.redeemable(0, ext), 0, "the Extension starts unpaid");
    assert_eq!(w.lines[0][ext].1.tranche, 1);
    assert!(w.lines[0][ext].1.due_at > w.lines[0][idx].1.due_at);
    w.rate = R0 + R0 / 20;
    w.sync(0).unwrap();
    assert!(w.redeemable(0, won) >= before);
    w.check();
}

#[test]
fn a_repaid_advance_cannot_be_extended() {
    let mut w = World::new(10 * SOL);
    w.advance(1).unwrap();
    w.rate = R0 * 2;
    w.sync(0).unwrap();
    assert_eq!(w.extend(1), Err(CoreError::AdvanceRepaid));
}

#[test]
fn the_pool_half_follows_the_share_in_force_and_the_route_never_overspends() {
    let mut route = RouteLedger::default();
    let payout = UnlockPayout {
        owner_shares: 5,
        mint_shares: 0,
        fee_shares: 1_000,
        owed_shares: 700,
    };
    route_after_unlock(&mut route, &payout, 5_000).unwrap();
    assert_eq!(route.treasury_shares, 1_700);
    assert_eq!((route.owed_shares, route.pool_owed), (700, 500));
    assert_eq!(route.spendable(), 500);
    route_after_unlock(&mut route, &payout, 0).unwrap();
    assert_eq!(
        route.pool_owed, 500,
        "a share of zero owes the Pool nothing more"
    );
    assert_eq!(route.spendable(), 1_500);
}

#[test]
fn the_dust_tolerance_is_far_below_a_whole_gema() {
    assert!(DUST_FORGIVEN_FP < fp(1) / 1_000_000);
}

#[test]
fn rates_convert_units_and_shares_both_ways_rounding_down() {
    let r = ShareRate::stake(R0).unwrap();
    assert_eq!(
        r.whole_shares_for_units(1_300_000_000).unwrap(),
        1_000_000_000
    );
    assert_eq!(r.whole_shares_for_units(1).unwrap(), 0);
    assert_eq!(r.units_for_shares(1_000_000_000).unwrap(), 1_300_000_000);
    let n = ShareRate::native(1_050_000_000).unwrap();
    assert_eq!(n.units_for_shares(1_000_000_000).unwrap(), 1_050_000_000);
    let rep = ShareRate::reported();
    assert_eq!(rep.shares_for_units(7).unwrap(), 7u128 << 32);
    assert_eq!(ShareRate::new(1, 0), Err(CoreError::Math));
    assert_eq!(STAKE_RATE_SCALE, 1_000_000_000_000);
}

#[test]
fn a_prize_source_is_sized_in_gemas_by_the_value_of_its_shares() {
    // 1 SOL of shares at the stake rate 1.3, $150: 1.3 SOL = $195 = 19,500 Gemas.
    let r = ShareRate::stake(R0).unwrap();
    let g = gemas_for_shares(u128::from(SOL), &r, 9, PRICE).unwrap();
    assert_eq!(g, 19_500);
}

// --- Property: random lives of a Position, with slashes ----------------------------------------

#[derive(Clone, Debug)]
enum Op {
    /// The Staking Rate moves by this many basis points (negative = slash).
    Rate(i32),
    Advance(u8),
    Extend(u8),
    Sync,
    /// Redeem `pct` percent of what a line can Redeem.
    Redeem(u8, u8, u8),
    ReturnOwn(u8, u8),
    Win(u8, u8),
    Unlock,
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        8 => (-300i32..500).prop_map(Op::Rate),
        2 => (1u8..=12).prop_map(Op::Advance),
        1 => (1u8..=6).prop_map(Op::Extend),
        2 => Just(Op::Sync),
        4 => (0u8..3, 0u8..4, 1u8..=100).prop_map(|(s, i, p)| Op::Redeem(s, i, p)),
        1 => (0u8..3, 1u8..=100).prop_map(|(s, p)| Op::ReturnOwn(s, p)),
        3 => (0u8..3, 1u8..=60).prop_map(|(s, p)| Op::Win(s, p)),
        1 => Just(Op::Unlock),
    ]
}

fn run(ops: &[Op]) {
    let mut w = World::new(10 * SOL);
    w.advance(6).unwrap();
    for o in ops {
        // "Redeem now" of every winner line, before the operation.
        let snapshot: Vec<(usize, usize, u64)> = w
            .lines
            .iter()
            .enumerate()
            .flat_map(|(s, ls)| {
                let w = &w;
                ls.iter()
                    .enumerate()
                    .filter(|(_, (h, _))| *h == 1)
                    .map(move |(i, _)| (s, i, w.redeemable(s, i)))
            })
            .collect();
        let mut winner_acts = false;
        let snap = w.clone();
        let res: CoreResult<()> = (|| {
            match o {
                Op::Rate(bps) => {
                    w.rate =
                        (w.rate as i128 + w.rate as i128 * *bps as i128 / 10_000).max(1) as u64;
                    w.now += 3_600;
                }
                Op::Advance(m) => w.advance(*m)?,
                Op::Extend(m) => w.extend(*m)?,
                Op::Sync => {
                    for s in 0..w.srcs.len() {
                        w.sync(s)?;
                    }
                }
                Op::Redeem(s, i, pct) => {
                    let s = *s as usize % w.srcs.len();
                    let n = w.lines[s].len();
                    let i = *i as usize % n;
                    w.sync(s)?;
                    let can = w.redeemable(s, i);
                    let k = can * u64::from(*pct) / 100;
                    if k > 0 {
                        winner_acts = w.lines[s][i].0 == 1;
                        w.redeem(s, i, k)?;
                    }
                }
                Op::ReturnOwn(s, pct) => {
                    let s = *s as usize % w.srcs.len();
                    if let Some(i) = w.find(s, 0, CLASS_GENERAL) {
                        let k = (w.lines[s][i].1.amount * u64::from(*pct) / 100).max(1);
                        w.return_own(s, i, k)?;
                    }
                }
                Op::Win(s, pct) => {
                    let s = *s as usize % w.srcs.len();
                    if let Some(i) = w.find(s, 0, CLASS_GENERAL) {
                        let k = (w.lines[s][i].1.amount * u64::from(*pct) / 100).max(1);
                        winner_acts = true;
                        w.win(s, i, k)?;
                    }
                }
                Op::Unlock => {
                    if w.unlocked.is_none() {
                        w.unlock()?;
                    }
                }
            }
            Ok(())
        })();
        if res.is_err() {
            // An Err aborts the transaction: nothing it did is kept.
            w = snap;
        }
        w.check();
        if !winner_acts {
            for (s, i, before) in snapshot {
                if w.lines[s].len() > i {
                    let after = w.redeemable(s, i);
                    assert!(
                        after >= before,
                        "Redeem now of a winner's line fell from {before} to {after} after {o:?}"
                    );
                }
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, ..ProptestConfig::default() })]

    #[test]
    fn a_positions_whole_life_conserves_shares_and_never_lowers_redeem_now(
        ops in proptest::collection::vec(op(), 1..60)
    ) {
        run(&ops);
    }
}

#[test]
fn a_fee_larger_than_what_the_custody_has_left_is_clamped_not_invented() {
    let rate = ShareRate::stake(R0).unwrap();
    let mut pos = Position::new(OWNER, SourceChain::Solana, [7; 32], 9, 1, 500).unwrap();
    pos.stake_rate_open = R0;
    pos.custody_shares = 1_000;
    pos.held_shares = 400u128 << SHARE_BITS;
    pos.paid_shares = 0;
    let p = settle_unlock(&mut pos, CustodyKind::Stake, 10 * SOL, &rate).unwrap();
    // The owner keeps the share that covers the Principal (1 lamport), the fee takes the rest.
    assert_eq!((p.owed_shares, p.fee_shares, p.owner_shares), (400, 599, 1));
    // Holders owed more than the custody holds is an inconsistency, not a payout.
    let mut pos = Position::new(OWNER, SourceChain::Solana, [7; 32], 9, SOL, 500).unwrap();
    pos.custody_shares = 100;
    pos.held_shares = 400u128 << SHARE_BITS;
    assert_eq!(
        settle_unlock(&mut pos, CustodyKind::Stake, 0, &rate),
        Err(CoreError::VaultShortfall)
    );
    assert_eq!(pos.status, PositionStatus::Locked);
}

#[test]
fn the_fee_is_paid_only_above_the_owners_principal() {
    let rate = ShareRate::stake(R0).unwrap();
    // 1,000 shares, 400 owed to holders: the owner's 600 shares are worth 780 units at R0.
    let mut pos = Position::new(OWNER, SourceChain::Solana, [7; 32], 9, 700, 500).unwrap();
    pos.stake_rate_open = R0;
    pos.custody_shares = 1_000;
    pos.held_shares = 400u128 << SHARE_BITS;
    let p = settle_unlock(&mut pos, CustodyKind::Stake, 500, &rate).unwrap();
    // The Principal (700 units) needs 539 shares; the fee wanted 385 but only 61 are above it.
    assert_eq!(
        (p.owed_shares, p.fee_shares, p.owner_shares),
        (400, 61, 539)
    );
    // A Principal worth more than the owner's shares leaves no fee at all.
    let mut pos = Position::new(OWNER, SourceChain::Solana, [7; 32], 9, 900, 500).unwrap();
    pos.stake_rate_open = R0;
    pos.custody_shares = 1_000;
    pos.held_shares = 400u128 << SHARE_BITS;
    let p = settle_unlock(&mut pos, CustodyKind::Stake, 500, &rate).unwrap();
    assert_eq!((p.fee_shares, p.owner_shares), (0, 600));
}

#[test]
fn growth_of_landed_shares_never_takes_the_owners_principal() {
    // Coverage lands in many small steps while the pool grows, so the landed shares grow with the
    // pool and the Position's own growth is counted on them again. Priced on the Position's whole
    // growth the owner would get back a little less than the Principal.
    let mut w = World::new(10 * SOL);
    w.advance(12).unwrap();
    let step = R0 / 20_000;
    for _ in 0..4_000 {
        w.rate += step;
        w.sync(0).unwrap();
        if w.books[0].uncovered_total() == 0 {
            break;
        }
    }
    assert_eq!(w.books[0].uncovered_total(), 0, "the Advance is repaid");
    let fee_units = w.fee_units();
    let rate = w.share_rate();
    w.unlock().unwrap();
    let p = w.unlocked.unwrap();
    let rest = w.custody0 - p.owed_shares;
    let uncapped = rate.whole_shares_for_units(fee_units).unwrap().min(rest);
    let value = |shares: u64| rate.units_for_shares(u128::from(shares)).unwrap();
    assert!(
        value(rest - uncapped) < u128::from(w.pos.principal),
        "without the floor the owner would get back less than the Principal"
    );
    assert!(
        value(p.owner_shares) >= u128::from(w.pos.principal),
        "the owner's shares are worth at least the Principal"
    );
    assert!(p.fee_shares > 0 && p.fee_shares < uncapped);
}

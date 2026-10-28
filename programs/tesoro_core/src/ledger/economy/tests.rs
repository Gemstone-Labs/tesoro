use super::*;
use crate::ledger::book::checkpoint::MemCheckpoints;
use crate::ledger::book::{fp, SourceBook};
use crate::ledger::line_store::{
    CLASS_GENERAL, CLASS_LEADERBOARD, CLASS_PLATFORM, CLASS_STUDIO, SIDE_WON,
};
use crate::ledger::yield_fee::{cash_out, exit_terms};
use crate::ledger::{
    principal_for_shares, stake_position_counted, tokens_for_units, SourceChain, STAKE_RATE_SCALE,
};
use proptest::prelude::*;

const OWNER: [u8; 32] = [1; 32];
const POSITION: [u8; 32] = [2; 32];
const SOL: u64 = 1_000_000_000;
const R0: u64 = 1_300_000_000_000;
const FEE: u16 = 2_000;
const POOL: u16 = 5_000;
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
    /// Shares that left the vault: holders' payouts and the owner's Unlock.
    out: u64,
    /// Yield Fee shares realised by cash-outs, and how many cash-outs paid one.
    fees: u128,
    unlocked: Option<UnlockPayout>,
    now: i64,
    /// Every increase of the shares the Position's yield landed in (held, free and paid), with the
    /// rate it landed at: the independent record of what each landing was priced at (ticket 55).
    landings: Vec<(u128, u64)>,
    /// The rate the Position unlocked at.
    unlock_rate: u64,
    /// `applied_net` when each Source was issued (it only moves once the Source closes).
    issued_at_net: Vec<u64>,
    /// A Lock from before ticket 55: its Sources were issued without the issuance checks.
    legacy: bool,
}

impl World {
    fn new(shares: u64) -> Self {
        let principal = principal_for_shares(shares, R0).unwrap();
        let mut pos =
            Position::new(OWNER, SourceChain::Solana, [7; 32], 9, principal, 500).unwrap();
        pos.stake_rate_open = R0;
        pos.stake_rate_high = R0;
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
            out: 0,
            fees: 0,
            unlocked: None,
            now: T0,
            landings: vec![],
            unlock_rate: 0,
            issued_at_net: vec![],
            legacy: false,
        }
    }

    fn share_rate(&self) -> ShareRate {
        ShareRate::stake(self.rate).unwrap()
    }

    /// Counted yield, as the instructions read it (`stake_rates`).
    fn net(&self) -> u64 {
        stake_position_counted(&self.pos, self.rate).unwrap()
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
        let mut src = pos.open_advance(POSITION, months, PRICE)?;
        if !self.legacy {
            check_stake_issuance(&pos, &rate, &src)?;
        }
        src.due_at = planned_due_at(self.now, months, 1)?;
        src.yield_fee_bps = FEE;
        src.pool_bps = POOL;
        let s = self.srcs.len();
        let mut book = SourceBook::new();
        let ck = MemCheckpoints::new(source_key(s));
        let line = advance_line(&mut book, source_key(s), &src, &ck)?;
        self.issued_at_net.push(pos.applied_net);
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
            1,
            net,
            &rate,
            &mut self.cks[s],
        )?;
        self.lines[s].push((0, line));
        Ok(())
    }

    /// Redeems `k` of a line, as the instruction does: the shares come from the Position (or the
    /// route once Unlocked), the holder is paid them less the Yield Fee, the fee joins the Treasury.
    /// Returns `(paid, payout)`.
    fn redeem(&mut self, s: usize, idx: usize, k: u64) -> CoreResult<(u64, u64)> {
        self.sync(s)?;
        let (h, mut line) = self.lines[s][idx];
        let r = self.books[s].redeem(&mut line, k, &self.cks[s])?;
        let paid = u64::try_from(r.shares).unwrap();
        let unlocked = self.pos.status == PositionStatus::Unlocked;
        let (yf, pool) = exit_terms(&self.srcs[s], line.class);
        let c = cash_out(u128::from(paid), yf, pool)?;
        let mut pos = self.pos.clone();
        let mut route = self.route.clone();
        debit_paid_shares(
            &mut pos,
            CustodyKind::Stake,
            unlocked.then_some(&mut route),
            paid,
        )?;
        route.realise_yield_fee(c.fee, pool)?;
        self.pos = pos;
        self.route = route;
        self.fees += c.fee;
        self.srcs[s].redeemed += k;
        self.lines[s][idx] = (h, line);
        if unlocked {
            self.paid_post += paid;
        } else {
            self.paid_pre += paid;
        }
        let payout = u64::try_from(c.payout).unwrap();
        self.out += payout;
        Ok((paid, payout))
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
        let mut payout = settle_unlock(&mut pos, CustodyKind::Stake, &rate)?;
        let mut route = self.route.clone();
        route_after_unlock(&mut route, &mut payout, POOL)?;
        self.pos = pos;
        self.route = route;
        self.fees += u128::from(payout.fee_shares);
        self.out += payout.owner_shares;
        self.unlocked = Some(payout);
        self.unlock_rate = self.rate;
        Ok(())
    }

    /// Shares (32 fractional bits) the Position's yield has landed in so far.
    fn landed_total(&self) -> u128 {
        self.pos.held_shares + self.pos.free_shares + (u128::from(self.paid_pre) << SHARE_BITS)
    }

    /// What the landed shares grew since each was priced, at `rate`, whole shares: the sum of
    /// every landing's positive growth, with nothing netted against a loss.
    fn model_growth(&self, rate: u64) -> u128 {
        let fp: u128 = self
            .landings
            .iter()
            .filter(|(_, r)| *r < rate)
            .map(|(s, r)| s - s * u128::from(*r) / u128::from(rate))
            .sum();
        fp >> SHARE_BITS
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
        if self.pos.status == PositionStatus::Locked && !self.legacy {
            assert_eq!(
                self.pos.held_shares, held_in_books,
                "the Position's held shares are exactly the shares its books hold"
            );
            assert!(
                u128::from(self.pos.custody_shares - self.pos.paid_shares) << SHARE_BITS
                    >= self.pos.held_shares,
                "the custody still covers what holders are owed"
            );
            // Ticket 55 cap: every Source's commitment fit under Principal when it was issued.
            if let Some(i) = self.pos.open_advance {
                let src = &self.srcs[i as usize];
                let commit =
                    (src.issued - src.returned) as u128 * src.unit_num / u128::from(src.unit_den);
                assert!(
                    u128::from(self.issued_at_net[i as usize]) + commit
                        <= u128::from(self.pos.principal) + 1,
                    "Source {i} was issued over the lifetime cap"
                );
            }
        }
        self.route.check(&[]).expect("route");
        let custody_left = if self.pos.status == PositionStatus::Locked {
            self.pos.custody_shares - self.pos.paid_shares
        } else {
            0
        };
        assert_eq!(
            u128::from(self.custody0),
            u128::from(self.out) + u128::from(custody_left) + self.route.treasury_shares,
            "every share of the vault is the custody's, paid out, or the Treasury's"
        );
        if let Some(p) = &self.unlocked {
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
    // A large growth repays it, the excess is the owner's pocket, and a new Advance closes it
    // (half of Principal accrued: under the lifetime cap).
    w.rate = R0 + R0 / 2;
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
    let (paid, _) = w.redeem(0, 0, before).unwrap();
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
    let free = u64::try_from(w.pos.free_shares >> SHARE_BITS).unwrap();
    assert_eq!(
        w.fees, 0,
        "returning own Gemas pays no fee: nothing left Tesoro yet"
    );
    // Unlock: the released ready came back as free yield and pays the Yield Fee now, once
    // (red-team #1: Return then Unlock does not get around the fee).
    w.unlock().unwrap();
    let p = w.unlocked.unwrap();
    assert!(
        p.owed_shares <= 1,
        "nobody holds Gemas of this Source: at most a stranded share is owed"
    );
    let want = cash_out(u128::from(free), FEE, 0).unwrap().fee;
    assert!(want > 0);
    assert_eq!(u128::from(p.fee_shares), want);
    assert_eq!(w.route.pool_owed, want / 2);
    assert_eq!(p.shortfall_shares, 0);
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
    let pool_before = w.route.pool_owed;
    let (paid, payout) = w.redeem(0, won, k).unwrap();
    assert!(paid > 0);
    let c = cash_out(u128::from(paid), FEE, POOL).unwrap();
    assert_eq!(
        u128::from(payout),
        c.payout,
        "an unlocked holder pays the fee too"
    );
    assert_eq!(w.route.pool_owed, pool_before + c.pool);
    w.check();
    // Spending never touches what holders are owed or the Pool's half.
    let spendable = w.route.spendable();
    assert_eq!(
        w.route.clone().spend(spendable + 1),
        Err(CoreError::OverSpendable)
    );
    w.route.spend(spendable).unwrap();
    // A withdrawal: those shares leave the vault.
    w.out += u64::try_from(spendable).unwrap();
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
        fee_shares: 1_000,
        owed_shares: 700,
        ..UnlockPayout::default()
    };
    route_after_unlock(&mut route, &mut payout.clone(), 5_000).unwrap();
    assert_eq!(route.treasury_shares, 1_700);
    assert_eq!((route.owed_shares, route.pool_owed), (700, 500));
    assert_eq!(route.spendable(), 500);
    route_after_unlock(&mut route, &mut payout.clone(), 0).unwrap();
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

#[test]
fn the_highest_priced_rate_moves_only_when_yield_lands_and_counted_yield_never_drops() {
    let mut w = World::new(10 * SOL);
    w.pos.stake_rate_high = R0;
    w.advance(12).unwrap();
    // A rise nobody syncs is not priced.
    w.rate = R0 + R0 / 10;
    assert_eq!(w.pos.stake_rate_high, R0);
    w.rate = R0 + R0 / 20;
    w.sync(0).unwrap();
    assert_eq!(
        w.pos.stake_rate_high,
        R0 + R0 / 20,
        "a landing prices at the rate of the moment"
    );
    let counted = w.net();
    // A fall prices nothing and counts what was priced.
    w.rate = R0 + R0 / 40;
    let held = w.pos.held_shares;
    w.sync(0).unwrap();
    assert_eq!(
        (w.pos.stake_rate_high, w.pos.held_shares),
        (R0 + R0 / 20, held)
    );
    assert_eq!(
        w.net(),
        counted,
        "counted yield stays at the highest priced rate"
    );
    assert_eq!(
        stake_position_counted(&w.pos, R0 - R0 / 10).unwrap(),
        counted,
        "even below the opening rate"
    );
    // Idle yield banked with no Advance open moves it too; nothing banked, nothing moves.
    let mut idle = World::new(10 * SOL);
    idle.pos.stake_rate_high = R0;
    idle.rate = R0 - R0 / 10;
    let (net, rate) = (idle.net(), idle.share_rate());
    bank_free_yield(&mut idle.pos, net, &rate).unwrap();
    assert_eq!(idle.pos.stake_rate_high, R0);
    idle.rate = R0 + R0 / 8;
    let (net, rate) = (idle.net(), idle.share_rate());
    bank_free_yield(&mut idle.pos, net, &rate).unwrap();
    assert_eq!(idle.pos.stake_rate_high, R0 + R0 / 8);
    // A Position that is not a stake Position never gets one.
    let mut native = Position::new(OWNER, SourceChain::Solana, [7; 32], 9, SOL, 500).unwrap();
    bank_free_yield(&mut native, SOL, &ShareRate::native(1_100_000_000).unwrap()).unwrap();
    assert_eq!(native.stake_rate_high, 0);
}

#[test]
fn issuance_is_capped_at_principal_and_refused_below_the_highest_priced_rate() {
    let mut pos = Position::new(OWNER, SourceChain::Solana, [7; 32], 9, 12 * SOL, 2_000).unwrap();
    pos.stake_rate_open = R0;
    pos.stake_rate_high = R0 + R0 / 10;
    let mut src = pos.clone().open_advance(POSITION, 12, PRICE).unwrap();
    // 2.4 SOL: 36,000 Gemas at $150.
    assert_eq!(src.issued, 36_000);
    let peak = ShareRate::stake(R0 + R0 / 10).unwrap();
    let below = ShareRate::stake(R0 + R0 / 10 - 1).unwrap();
    assert_eq!(check_stake_issuance(&pos, &peak, &src), Ok(()));
    assert_eq!(
        check_stake_issuance(&pos, &below, &src),
        Err(CoreError::RateBelowPeak)
    );
    // Exactly at Principal passes, one lamport over is refused.
    pos.applied_net = 12 * SOL - 2_400_000_000;
    assert_eq!(check_stake_issuance(&pos, &peak, &src), Ok(()));
    pos.applied_net += 1;
    assert_eq!(
        check_stake_issuance(&pos, &peak, &src),
        Err(CoreError::YieldCapReached)
    );
    // Returned Gemas free their commitment; redeemed ones do not.
    src.returned = 1;
    src.redeemed = 5_000;
    assert_eq!(check_stake_issuance(&pos, &peak, &src), Ok(()));
    // Counted yield above Principal (rate more than doubled) refuses without underflowing.
    pos.applied_net = 13 * SOL;
    assert_eq!(
        check_stake_issuance(&pos, &peak, &src),
        Err(CoreError::YieldCapReached)
    );
    // Native and reported Positions are never checked here.
    let other = Position::new(OWNER, SourceChain::Solana, [7; 32], 9, SOL, 500).unwrap();
    assert_eq!(check_stake_issuance(&other, &below, &src), Ok(()));
}

#[test]
fn yearly_advances_at_twenty_percent_stop_after_four_years() {
    // design-v4 4.1: compounding 20% a year, a 12-month Advance each year. After 3 years
    // 0.728P + 0.2P fits; after 4 years 1.074P does not.
    let mut w = World::new(10 * SOL);
    let mut ok = vec![];
    for year in 1..=5 {
        w.pos.rate_bps = 2_000;
        let r = w.advance(12);
        ok.push((year, r.is_ok()));
        if r.is_err() {
            assert_eq!(r, Err(CoreError::YieldCapReached), "year {year}");
            break;
        }
        w.rate = w.rate + w.rate / 5;
    }
    assert_eq!(
        ok,
        vec![(1, true), (2, true), (3, true), (4, true), (5, false)]
    );
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

/// One operation of a random life; an Err leaves `w` half-changed (the caller restores it).
fn apply(w: &mut World, o: &Op, winner_acts: &mut bool) -> CoreResult<()> {
    let before = w.landed_total();
    let res = (|| {
        match o {
            Op::Rate(bps) => {
                w.rate = (w.rate as i128 + w.rate as i128 * *bps as i128 / 10_000).max(1) as u64;
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
                    *winner_acts = w.lines[s][i].0 == 1;
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
                    *winner_acts = true;
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
    let after = w.landed_total();
    if res.is_ok() && after > before {
        let rate = w.rate;
        w.landings.push((after - before, rate));
    }
    res
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
        let res = apply(&mut w, o, &mut winner_acts);
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

/// Ticket 55 (SOL-02 A): a random life ends in an Unlock with the Treasury funded. Whatever
/// the history, the top-up is at most the growth the landed shares really had since their yield
/// was priced (each landing on its own, `World::landings`), nothing below the opening rate, and
/// nothing when the rate is below every landing's.
fn run_growth_only(ops: &[Op]) {
    let mut w = World::new(10 * SOL);
    w.route.receive(u128::from(SOL)).unwrap();
    w.custody0 += SOL;
    w.advance(6).unwrap();
    for o in ops.iter().chain([Op::Unlock].iter()) {
        let snap = w.clone();
        if apply(&mut w, o, &mut false).is_err() {
            w = snap;
        }
        w.check();
    }
    let Some(p) = w.unlocked else {
        return;
    };
    let r = w.unlock_rate;
    let growth = w.model_growth(r);
    assert!(
        u128::from(p.shortfall_shares) <= growth + 1,
        "top-up {} beyond the landed shares' growth {growth} at {r} ({:?})",
        p.shortfall_shares,
        w.landings
    );
    if r <= R0 {
        assert_eq!(
            p.shortfall_shares, 0,
            "no top-up at or below the opening rate"
        );
    }
    if w.landings.iter().all(|(_, lr)| r < *lr) {
        assert_eq!(
            p.shortfall_shares, 0,
            "no top-up below every landing's rate"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, ..ProptestConfig::default() })]

    #[test]
    fn the_unlock_top_up_never_exceeds_the_landed_shares_growth(
        ops in proptest::collection::vec(op(), 1..60)
    ) {
        run_growth_only(&ops);
    }

    #[test]
    fn a_positions_whole_life_conserves_shares_and_never_lowers_redeem_now(
        ops in proptest::collection::vec(op(), 1..60)
    ) {
        run(&ops);
    }
}

#[test]
fn unlock_charges_the_fee_on_free_yield_only_and_never_invents_custody() {
    let rate = ShareRate::stake(R0).unwrap();
    // 1,000 shares, 400 owed to holders, Principal 600 units (462 shares at R0), 100 free shares.
    let mut pos = Position::new(OWNER, SourceChain::Solana, [7; 32], 9, 600, 500).unwrap();
    pos.stake_rate_open = R0;
    pos.yield_fee_bps = FEE;
    pos.custody_shares = 1_000;
    pos.held_shares = 400u128 << SHARE_BITS;
    pos.free_shares = 100u128 << SHARE_BITS;
    let p = settle_unlock(&mut pos, CustodyKind::Stake, &rate).unwrap();
    // The fee is 20 of the 100 free shares; the owner gets everything else of the custody.
    assert_eq!(
        (
            p.owed_shares,
            p.fee_shares,
            p.owner_shares,
            p.shortfall_shares
        ),
        (400, 20, 580, 0)
    );
    // Holders owed more than the custody holds (a migrated legacy Lock, ticket 55): the whole
    // custody goes to the route, the Treasury must fund the rest of the claims, the owner gets
    // nothing back.
    let mut pos = Position::new(OWNER, SourceChain::Solana, [7; 32], 9, SOL, 500).unwrap();
    pos.stake_rate_open = R0;
    pos.custody_shares = 100;
    pos.held_shares = 400u128 << SHARE_BITS;
    let p = settle_unlock(&mut pos, CustodyKind::Stake, &rate).unwrap();
    assert_eq!(
        (p.owner_shares, p.owed_shares, p.claims_funded_shares),
        (0, 400, 300)
    );
    assert_eq!(p.gap_shares, rate.whole_shares_for_units_ceil(SOL).unwrap());
    let mut empty = RouteLedger::default();
    let mut paid = p;
    assert_eq!(
        route_after_unlock(&mut empty, &mut paid, POOL),
        Err(CoreError::GrowthClaimsUnfunded)
    );
    assert_eq!(empty, RouteLedger::default());
}

#[test]
fn holder_claims_above_the_custody_are_funded_by_the_treasury_or_unlock_waits() {
    // Codex's figures (design-v4 5): Treasury 4 jitoSOL, custody 10, holders owed 10.348956599.
    let rate = ShareRate::stake(R0).unwrap();
    let claims = |treasury: u128| {
        let mut pos = Position::new(OWNER, SourceChain::Solana, [7; 32], 9, 12 * SOL, 500).unwrap();
        pos.stake_rate_open = R0 - R0 / 10;
        pos.stake_rate_high = R0;
        pos.custody_shares = 10 * SOL;
        pos.held_shares = 10_348_956_599u128 << SHARE_BITS;
        let p = settle_unlock(&mut pos, CustodyKind::Stake, &rate).unwrap();
        let mut route = RouteLedger {
            reserved: 7,
            pool_owed: 11,
            pool_realised_total: 11,
            ..RouteLedger::default()
        };
        route.receive(treasury + 18).unwrap();
        (p, route)
    };
    let (mut p, mut route) = claims(4 * u128::from(SOL));
    assert_eq!(p.claims_funded_shares, 348_956_599);
    route_after_unlock(&mut route, &mut p, POOL).unwrap();
    assert_eq!(route.treasury_shares, 14 * u128::from(SOL) + 18);
    assert_eq!(route.owed_shares, 10_348_956_599);
    assert_eq!(route.spendable(), 3_651_043_401);
    assert_eq!(
        (route.reserved, route.pool_owed),
        (7, 11),
        "other claims untouched"
    );
    assert_eq!(
        (p.owner_shares, p.topped_up_shares, p.shortfall_shares),
        (0, 0, 0)
    );
    route.check(&[]).unwrap();
    // One share short of the excess: refused, nothing changes.
    let (mut p, mut route) = claims(348_956_598);
    let before = route.clone();
    assert_eq!(
        route_after_unlock(&mut route, &mut p, POOL),
        Err(CoreError::GrowthClaimsUnfunded)
    );
    assert_eq!(route, before);
    // Exactly the excess: funded, nothing spendable left.
    let (mut p, mut route) = claims(348_956_599);
    route_after_unlock(&mut route, &mut p, POOL).unwrap();
    assert_eq!(route.spendable(), 0);
}

#[test]
fn a_migrated_lock_with_ten_uncapped_advances_unlocks_through_the_treasury() {
    // A legacy Lock (high = open, no cap on its old Sources): ten 12-month Advances at 20% while
    // the rate goes from 1.3 to 3.9 land more shares than its custody (Codex: 10.35 per 10).
    // Unlock funds the excess from the Treasury and every share stays accounted for.
    let mut w = World::new(10 * SOL);
    w.legacy = true;
    w.route.receive(5 * u128::from(SOL)).unwrap();
    w.custody0 += 5 * SOL;
    for _ in 0..10 {
        w.pos.rate_bps = 2_000;
        w.advance(12).unwrap();
        w.rate += R0 / 5;
        w.sync(w.srcs.len() - 1).unwrap();
        assert_eq!(w.books[w.srcs.len() - 1].uncovered_total(), 0);
    }
    assert!(
        w.pos.held_shares >> SHARE_BITS > u128::from(w.pos.custody_shares),
        "holders' claims exceed the custody"
    );
    w.unlock().unwrap();
    let p = w.unlocked.unwrap();
    assert!(p.claims_funded_shares > 0);
    assert_eq!(p.owner_shares, 0);
    w.check();
}

#[test]
fn a_short_custody_is_absorbed_by_the_free_yield_fee_then_topped_up_by_the_treasury() {
    let rate = ShareRate::stake(R0).unwrap();
    let short = |principal: u64| {
        let mut pos =
            Position::new(OWNER, SourceChain::Solana, [7; 32], 9, principal, 500).unwrap();
        // Opened at a lower rate: the token grew, so a shortfall is the landed-yield gap.
        pos.stake_rate_open = R0 - R0 / 10;
        pos.yield_fee_bps = FEE;
        pos.custody_shares = 1_000;
        pos.held_shares = 400u128 << SHARE_BITS;
        pos.free_shares = 100u128 << SHARE_BITS;
        settle_unlock(&mut pos, CustodyKind::Stake, &rate).unwrap()
    };
    // Principal 600 shares + 80 free after the fee = 680 due, 600 there: the fee is waived and the
    // owner is 80 short.
    let p = short(780);
    assert_eq!(
        (p.fee_shares, p.owner_shares, p.shortfall_shares),
        (0, 600, 80)
    );
    // Principal 516 shares + 80 = 596 due, 600 there: the fee only takes the 4 above it.
    let p = short(670);
    assert_eq!(
        (p.fee_shares, p.owner_shares, p.shortfall_shares),
        (4, 596, 0)
    );
    // The Treasury tops up what it can spend; Unlock never fails for the rest.
    let p = short(780);
    let mut rich = RouteLedger::default();
    rich.receive(1_000).unwrap();
    let mut paid = p;
    route_after_unlock(&mut rich, &mut paid, POOL).unwrap();
    assert_eq!((paid.owner_shares, paid.gap_shares), (680, 0));
    assert_eq!(rich.treasury_shares, 1_000 + 400 - 80);
    let mut poor = RouteLedger::default();
    poor.receive(30).unwrap();
    let mut paid = p;
    route_after_unlock(&mut poor, &mut paid, POOL).unwrap();
    assert_eq!((paid.owner_shares, paid.gap_shares), (630, 50));
    assert_eq!(poor.spendable(), 0);
    let mut empty = RouteLedger::default();
    let mut paid = p;
    route_after_unlock(&mut empty, &mut paid, POOL).unwrap();
    assert_eq!((paid.owner_shares, paid.gap_shares), (600, 80));
}

#[test]
fn a_slash_is_never_insured_by_the_treasury() {
    // Red-team 31 #1: 100 shares locked at 1.3, no Advance, the token is slashed by 10%. The owner
    // carries it (D2, no cushion): the custody comes back whole, the Treasury pays nothing.
    let mut w = World::new(100);
    w.route.receive(1_000).unwrap();
    w.custody0 += 1_000;
    w.rate = R0 - R0 / 10;
    let before = w.route.clone();
    w.unlock().unwrap();
    let p = w.unlocked.unwrap();
    assert_eq!((p.owner_shares, p.shortfall_shares), (100, 0));
    assert_eq!(w.route, before, "the Treasury is untouched");
    w.check();
    // With holders: the coverage landed before the slash, so the owner's Principal paid for it.
    // Still nothing from the Treasury; the gap is recorded.
    let mut w = World::new(10 * SOL);
    w.route.receive(SOL as u128).unwrap();
    w.custody0 += SOL;
    w.advance(3).unwrap();
    w.rate = R0 * 2;
    w.sync(0).unwrap();
    let idx = w.find(0, 0, CLASS_GENERAL).unwrap();
    w.win(0, idx, w.lines[0][idx].1.amount).unwrap();
    w.rate = R0 - R0 / 10;
    let spendable = w.route.spendable();
    w.unlock().unwrap();
    let p = w.unlocked.unwrap();
    assert_eq!(
        p.shortfall_shares, 0,
        "no top-up after a fall below the opening rate"
    );
    assert!(p.gap_shares > 0);
    assert_eq!(w.route.spendable(), spendable);
    w.check();
}

#[test]
fn growth_of_landed_shares_is_covered_by_the_treasury_not_the_owners_principal() {
    // Coverage lands in many small steps while the pool grows, so the landed shares grow with the
    // pool and the Position's own growth is counted on them again: the custody falls short of the
    // owner's Principal. The Treasury (here funded by earlier fees) makes the owner whole.
    let mut w = World::new(10 * SOL);
    w.route.receive(SOL as u128).unwrap();
    w.custody0 += SOL;
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
    let rate = w.share_rate();
    w.unlock().unwrap();
    let p = w.unlocked.unwrap();
    let value = |shares: u64| rate.units_for_shares(u128::from(shares)).unwrap();
    assert!(
        p.shortfall_shares > 0,
        "the landed shares' growth leaves the custody short"
    );
    // The priced yield is worth `ceil(priced / rate)` shares: the owner can be one share short
    // of the growth (ticket 55 rounds the Treasury's way).
    assert!(p.gap_shares <= 1, "gap {}", p.gap_shares);
    assert!(
        value(p.owner_shares + p.gap_shares) >= u128::from(w.pos.principal),
        "the owner's shares are worth the Principal, but for that share"
    );
    w.check();
}

#[test]
fn fee_classes_are_exempt_and_every_playable_class_pays_the_sources_snapshot() {
    let mut src = Position::new(OWNER, SourceChain::Solana, [7; 32], 9, SOL, 500)
        .unwrap()
        .open_advance(POSITION, 6, PRICE)
        .unwrap();
    src.yield_fee_bps = FEE;
    src.pool_bps = POOL;
    for class in [CLASS_PLATFORM, CLASS_STUDIO, CLASS_LEADERBOARD] {
        assert_eq!(exit_terms(&src, class), (0, 0));
    }
    assert_eq!(exit_terms(&src, CLASS_GENERAL), (FEE, POOL));
    assert_eq!(exit_terms(&src, CLASS_GENERAL + 3), (FEE, POOL));
}

#[test]
fn a_locked_redeem_pays_eighty_percent_and_the_fee_stays_in_the_vault_as_the_treasurys() {
    let mut w = World::new(10 * SOL);
    w.advance(6).unwrap();
    w.rate = R0 + R0 / 20;
    w.sync(0).unwrap();
    let idx = w.find(0, 0, CLASS_GENERAL).unwrap();
    w.win(0, idx, w.lines[0][idx].1.amount / 2).unwrap();
    let won = w.find(0, 1, CLASS_GENERAL).unwrap();
    let k = w.redeemable(0, won);
    let (paid, payout) = w.redeem(0, won, k).unwrap();
    let c = cash_out(u128::from(paid), FEE, POOL).unwrap();
    assert_eq!(u128::from(payout), c.payout);
    assert!(c.fee > 0);
    assert_eq!(w.route.treasury_shares, c.fee);
    assert_eq!(w.route.pool_owed, c.pool);
    assert_eq!(w.route.spendable(), c.fee - c.pool);
    w.check();
}

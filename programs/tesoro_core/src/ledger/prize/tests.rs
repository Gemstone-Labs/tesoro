#![allow(clippy::needless_range_loop)]

use super::*;
use crate::ledger::book::checkpoint::NoCheckpoints;
use crate::ledger::book::{fp, SourceBook, SHARE_BITS};
use crate::ledger::line_store::{
    required_len, LineKey, LineStore, CLASS_LEADERBOARD, SIDE_OWN, SIDE_WON,
};
use crate::ledger::{season_end, season_start, Ranked, PAYOUT_WINDOW_SECS, PRIZE_BPS};

const SEASON1_END: i64 = 1_791_158_400 + 7 * 24 * 3600;

fn key(n: u8) -> Key {
    [n; 32]
}

fn on() -> RouteLedger {
    let mut r = RouteLedger::default();
    r.set_escrow_enabled(true);
    r
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next() % n
        }
    }
}

// ------------------------------------------------------------------ Pool share setting

#[test]
fn the_pool_share_changes_only_from_a_season_announced_ahead() {
    let mut s = PoolShare::default();
    let now = season_start(5).unwrap() + 100;
    assert_eq!(s.bps_at(5), 5_000);
    assert_eq!(s.set(now, 5, 2_000), Err(CoreError::PoolShareTooSoon));
    assert_eq!(s.set(now, 4, 2_000), Err(CoreError::PoolShareTooSoon));
    assert_eq!(s.set(now, 6, 10_001), Err(CoreError::InvalidBps));
    s.set(now, 6, 2_000).unwrap();
    assert_eq!(s.bps_at(5), 5_000);
    assert_eq!(s.bps_at(6), 2_000);
    assert_eq!(s.bps_now(now).unwrap(), 5_000);
    // a second announcement replaces the pending one
    s.set(now, 7, 3_000).unwrap();
    assert_eq!((s.bps_at(6), s.bps_at(7)), (5_000, 3_000));
    // once in force it is folded in before the next announcement
    let later = season_start(8).unwrap() + 1;
    s.set(later, 10, 1_000).unwrap();
    assert_eq!(
        (s.bps_at(8), s.bps_at(9), s.bps_at(10)),
        (3_000, 3_000, 1_000)
    );
}

// ------------------------------------------------------------------ route books

#[test]
fn a_realised_yield_fee_splits_in_halves_and_the_pools_half_is_not_spendable() {
    let mut r = RouteLedger::default();
    assert_eq!(r.spendable(), 0);
    let (t, p) = r.realise_yield_fee_default(1_001).unwrap();
    assert_eq!((t, p), (501, 500));
    assert_eq!(r.treasury_shares, 1_001);
    assert_eq!(r.pool_owed, 500);
    assert_eq!(r.spendable(), 501);
    assert_eq!(r.spend(502), Err(CoreError::OverSpendable));
    r.spend(501).unwrap();
    assert_eq!(r.spendable(), 0);
    assert_eq!(r.treasury_shares, 500);
    r.check(&[]).unwrap();
}

#[test]
fn only_a_realised_fee_makes_the_pool_owed_anything() {
    let mut r = RouteLedger::default();
    r.receive(10_000).unwrap(); // refills and funding are the Treasury's own
    assert_eq!(r.pool_owed, 0);
    assert_eq!(r.spendable(), 10_000);
    r.spend(10_000).unwrap();
}

#[test]
fn holders_and_reservations_are_never_spendable() {
    let mut r = RouteLedger::default();
    r.receive(1_000).unwrap();
    r.add_owed(300).unwrap();
    r.reserve(200).unwrap();
    assert_eq!(r.spendable(), 500);
    assert_eq!(r.add_owed(501), Err(CoreError::OwedExceedsTreasury));
    assert_eq!(r.reserve(501), Err(CoreError::OverSpendable));
    assert_eq!(r.spend(501), Err(CoreError::OverSpendable));
    r.spend(500).unwrap();
    assert_eq!(r.spendable(), 0);
    r.pay_owed(300).unwrap();
    r.pay_reserved(200).unwrap();
    assert_eq!(r.treasury_shares, 0);
    assert_eq!(r.pay_owed(1), Err(CoreError::Math));
    r.check(&[]).unwrap();
}

#[test]
fn a_failed_operation_changes_nothing() {
    let mut r = on();
    r.realise_yield_fee_default(100).unwrap();
    let before = r.clone();
    assert!(r.spend(1_000).is_err());
    assert!(r.fund_season_prize(1, SEASON1_END - 1, key(1), 5).is_err());
    assert!(r.reserve(1_000).is_err());
    assert!(r.unreserve(1).is_err());
    assert_eq!(r, before);
}

// ------------------------------------------------------------------ funding

#[test]
fn funding_is_off_until_switched_on_and_runs_once_per_ended_season() {
    let mut r = RouteLedger::default();
    r.realise_yield_fee_default(1_000).unwrap();
    assert_eq!(
        r.fund_season_prize(1, SEASON1_END, key(1), 10),
        Err(CoreError::PrizeEscrowOff)
    );
    r.set_escrow_enabled(true);
    assert_eq!(
        r.fund_season_prize(1, SEASON1_END - 1, key(1), 10),
        Err(CoreError::SeasonNotEnded)
    );
    let f = r.fund_season_prize(1, SEASON1_END, key(1), 10).unwrap();
    assert_eq!(f.moved, 500);
    let ps = f.issued.unwrap();
    assert_eq!((ps.shares, ps.gemas, ps.source), (500, 10, key(1)));
    assert_eq!(r.pool_owed, 0);
    assert_eq!(r.treasury_shares, 500);
    assert_eq!(r.escrow_backing, 500);
    assert_eq!(
        r.fund_season_prize(1, SEASON1_END, key(2), 10),
        Err(CoreError::AlreadyFunded)
    );
    r.check(&[ps]).unwrap();
}

#[test]
fn funding_waits_while_the_treasury_cannot_cover_holders_and_the_pool() {
    let mut r = on();
    r.receive(1_000).unwrap();
    r.add_owed(900).unwrap();
    r.realise_yield_fee_default(200).unwrap(); // T 1,200: owed 900, pool 100, spendable 200
    r.reserve(150).unwrap();
    // T - owed - reserved = 150 >= pool_owed 100: funds
    let mut ok = r.clone();
    assert!(ok.fund_season_prize(1, SEASON1_END, key(1), 1).is_ok());
    // a slash-free shortfall: spend what is spendable, then reserve the rest of the headroom
    r.spend(50).unwrap(); // spendable 0, T 1,150
    let before = r.clone();
    // pretend holders were owed more shares than remain once the Pool is counted
    r.owed_shares += 60;
    assert!(r.treasury_shares - r.owed_shares - r.reserved < r.pool_owed);
    let waits = r.fund_season_prize(1, SEASON1_END, key(1), 1);
    assert_eq!(waits, Err(CoreError::PrizeFundingWaits));
    r.owed_shares -= 60;
    assert_eq!(r, before);
}

#[test]
fn shares_with_less_than_a_gema_stay_unissued_until_a_later_season() {
    let mut r = on();
    r.realise_yield_fee_default(40).unwrap();
    let f = r.fund_season_prize(1, SEASON1_END, key(1), 0).unwrap();
    assert_eq!((f.moved, f.issued), (20, None));
    assert_eq!(r.escrow_unissued, 20);
    r.realise_yield_fee_default(40).unwrap();
    let f = r
        .fund_season_prize(2, SEASON1_END + 7 * 24 * 3600, key(2), 3)
        .unwrap();
    let ps = f.issued.unwrap();
    assert_eq!((ps.shares, ps.gemas), (40, 3));
    assert_eq!(r.escrow_unissued, 0);
    r.check(&[ps]).unwrap();
}

#[test]
fn a_later_season_never_touches_an_earlier_prize_sources_shares() {
    let mut r = on();
    r.realise_yield_fee_default(1_000).unwrap();
    let a = r
        .fund_season_prize(1, SEASON1_END, key(1), 50)
        .unwrap()
        .issued
        .unwrap();
    r.realise_yield_fee_default(600).unwrap();
    let b = r
        .fund_season_prize(2, SEASON1_END + 7 * 24 * 3600, key(2), 30)
        .unwrap()
        .issued
        .unwrap();
    assert_eq!((a.shares, b.shares), (500, 300));
    assert_eq!(r.escrow_backing, 800);
    r.check(&[a, b]).unwrap();
}

// ------------------------------------------------------------------ harvest

fn leaderboard_book(issue: u64, landed: u64, shares: u128) -> (SourceBook, Line) {
    let mut book = SourceBook::new();
    let mut counter = SourceBook::blank_line(SIDE_OWN, 0, key(9), CLASS_LEADERBOARD, 0);
    book.issue(&mut counter, issue, &NoCheckpoints).unwrap();
    book.land(fp(landed), shares << SHARE_BITS, &mut NoCheckpoints)
        .unwrap();
    (book, counter)
}

#[test]
fn harvest_moves_the_ready_part_of_the_leaderboard_counter_into_the_escrow() {
    let mut r = on();
    let (mut book, mut counter) = leaderboard_book(100, 100, 1_000);
    let h = r
        .harvest(
            SourceKind::Yield,
            &mut book,
            &mut counter,
            60,
            &NoCheckpoints,
        )
        .unwrap();
    assert_eq!((h.gemas, h.shares), (60, 600));
    assert_eq!(r.escrow_unissued, 600);
    assert_eq!(counter.amount, 40);
    // only what is ready can be harvested
    assert!(r
        .harvest(
            SourceKind::Yield,
            &mut book,
            &mut counter,
            41,
            &NoCheckpoints
        )
        .is_err());
    assert_eq!(r.escrow_unissued, 600);
    let (mut b2, mut c2) = leaderboard_book(100, 60, 600);
    assert!(r
        .harvest(SourceKind::Yield, &mut b2, &mut c2, 61, &NoCheckpoints)
        .is_err());
    assert_eq!(c2.amount, 100);
}

#[test]
fn harvest_is_refused_on_prize_sources_off_escrows_and_other_classes() {
    let (mut book, mut counter) = leaderboard_book(100, 60, 600);
    let mut r = on();
    let (b0, c0) = (book.clone(), counter);
    assert_eq!(
        r.harvest(
            SourceKind::Prize,
            &mut book,
            &mut counter,
            10,
            &NoCheckpoints
        ),
        Err(CoreError::PrizeSourceRefused)
    );
    let mut off = RouteLedger::default();
    assert_eq!(
        off.harvest(
            SourceKind::Yield,
            &mut book,
            &mut counter,
            10,
            &NoCheckpoints
        ),
        Err(CoreError::PrizeEscrowOff)
    );
    counter.class = 3;
    assert_eq!(
        r.harvest(
            SourceKind::Yield,
            &mut book,
            &mut counter,
            10,
            &NoCheckpoints
        ),
        Err(CoreError::SourceMismatch)
    );
    counter.class = CLASS_LEADERBOARD;
    assert_eq!((book, counter), (b0, c0));
    assert_eq!(r.escrow_unissued, 0);
}

#[test]
fn every_other_redeem_path_refuses_prize_sources() {
    assert_eq!(
        SourceKind::Prize.require_yield(),
        Err(CoreError::PrizeSourceRefused)
    );
    assert_eq!(SourceKind::Yield.require_yield(), Ok(()));
}

// ------------------------------------------------------------------ prize Redeem

fn funded(shares: u128, gemas: u64) -> (RouteLedger, PrizeSource) {
    let mut r = on();
    r.realise_yield_fee_default(shares * 2).unwrap();
    let ps = r
        .fund_season_prize(1, SEASON1_END, key(1), gemas)
        .unwrap()
        .issued
        .unwrap();
    (r, ps)
}

#[test]
fn a_holder_redeems_their_fraction_of_the_sources_own_shares() {
    let (mut r, mut ps) = funded(1_000, 30);
    assert_eq!(r.redeem_prize(&mut ps, 10).unwrap(), 333);
    assert_eq!((ps.shares, ps.gemas), (667, 20));
    assert_eq!(r.redeem_prize(&mut ps, 10).unwrap(), 333);
    // the last Gemas take everything left, so no share is stranded
    assert_eq!(r.redeem_prize(&mut ps, 10).unwrap(), 334);
    assert_eq!((ps.shares, ps.gemas, r.escrow_backing), (0, 0, 0));
    r.check(&[ps]).unwrap();
}

#[test]
fn prize_redeem_cannot_pay_more_than_held_or_nothing() {
    let (mut r, mut ps) = funded(1_000, 30);
    assert_eq!(r.redeem_prize(&mut ps, 0), Err(CoreError::ZeroAmount));
    assert_eq!(
        r.redeem_prize(&mut ps, 31),
        Err(CoreError::InsufficientGemas)
    );
    let (mut r2, mut tiny) = funded(1, 1_000);
    assert_eq!(r2.redeem_prize(&mut tiny, 1), Err(CoreError::ZeroShares));
}

#[test]
fn a_pending_prize_payout_is_reserved_and_never_backs_other_holders() {
    let (mut r, mut ps) = funded(1_000, 100);
    let p = r.begin_prize_payout(&mut ps, 50).unwrap();
    assert_eq!(p.shares, 500);
    assert_eq!((r.escrow_backing, r.escrow_pending), (500, 500));
    // the rest of the holders redeem against the remaining 500 shares only
    assert_eq!(r.redeem_prize(&mut ps, 50).unwrap(), 500);
    assert_eq!(r.escrow_total(), 500);
    r.finish_prize_payout(p).unwrap();
    assert_eq!(r.escrow_total(), 0);
    r.check(&[ps]).unwrap();
}

#[test]
fn a_cancelled_prize_payout_gives_back_exactly_what_it_took() {
    let (mut r, mut ps) = funded(777, 19);
    let (r0, ps0) = (r.clone(), ps);
    let p = r.begin_prize_payout(&mut ps, 7).unwrap();
    r.cancel_prize_payout(&mut ps, p).unwrap();
    assert_eq!((r, ps), (r0, ps0));
}

#[test]
fn a_slash_changes_the_coin_a_holder_gets_not_the_gema_count_or_the_shares_owed() {
    // Shares are the unit: whatever the staking token is worth, 10 of 30 Gemas are 1/3 of the shares.
    let (mut r, mut ps) = funded(900, 30);
    assert_eq!(r.redeem_prize(&mut ps, 10).unwrap(), 300);
    assert_eq!(ps.gemas, 20);
}

// ------------------------------------------------------------------ fee cut on prize Gemas

#[test]
fn a_fee_cut_from_prize_gemas_is_an_ordinary_fully_ready_line() {
    let mut loser = prize_line(SIDE_WON, 5, key(1), 100);
    let mut fee = prize_line(SIDE_WON, 5, key(1), 0);
    prize_move(&mut loser, &mut fee, 10).unwrap();
    assert_eq!((loser.amount, fee.amount), (90, 10));
    assert_eq!((fee.uncovered, fee.class), (0, CLASS_GENERAL));
    assert!(fee.is_playable());
    assert_eq!(
        prize_move(&mut loser, &mut fee, 0),
        Err(CoreError::ZeroAmount)
    );
    assert_eq!(
        prize_move(&mut loser, &mut fee, 91),
        Err(CoreError::InsufficientGemas)
    );
    let mut other = prize_line(SIDE_WON, 5, key(2), 0);
    assert_eq!(
        prize_move(&mut loser, &mut other, 1),
        Err(CoreError::SourceMismatch)
    );
    let mut fee_class = fee;
    fee_class.class = CLASS_LEADERBOARD;
    assert_eq!(
        prize_move(&mut loser, &mut fee_class, 1),
        Err(CoreError::SourceMismatch)
    );
}

// ------------------------------------------------------------------ Season

fn lk(n: u8) -> LineKey {
    LineKey {
        side: SIDE_WON,
        due_at: n as i64,
        source: key(n),
        class: CLASS_GENERAL,
        tranche: 0,
    }
}

fn ranking(n: usize) -> Vec<Ranked> {
    (0..n)
        .map(|i| Ranked {
            account: key(100 + i as u8),
            points: 1_000 - i as u64,
        })
        .collect()
}

fn funded_routes() -> Vec<RouteLedger> {
    let mut r = on();
    r.last_funded = 1;
    vec![r]
}

fn record(
    pool: &[PoolLine],
    res: &mut PoolReservations,
    n: usize,
    now: i64,
) -> CoreResult<PrizeSeason> {
    let routes = funded_routes();
    let refs: Vec<&RouteLedger> = routes.iter().collect();
    PrizeSeason::record(1, now, &refs, pool, res, &ranking(n))
}

#[test]
fn record_needs_an_ended_season_and_every_route_funded() {
    let pool = [PoolLine {
        key: lk(1),
        amount: 100,
    }];
    let mut res = PoolReservations::default();
    assert_eq!(
        record(&pool, &mut res, 3, SEASON1_END - 1),
        Err(CoreError::SeasonNotEnded)
    );
    let mut unfunded = on();
    unfunded.last_funded = 0;
    assert_eq!(
        PrizeSeason::record(1, SEASON1_END, &[&unfunded], &pool, &mut res, &ranking(3)),
        Err(CoreError::SeasonNotFunded)
    );
    // a route whose escrow is switched off is not waited for
    let off = RouteLedger::default();
    assert!(PrizeSeason::record(1, SEASON1_END, &[&off], &pool, &mut res, &ranking(3)).is_ok());
    assert_eq!(res.total(), 100);
}

#[test]
fn the_budget_is_frozen_and_reserved_at_record() {
    let pool = [
        PoolLine {
            key: lk(1),
            amount: 1_000,
        },
        PoolLine {
            key: lk(2),
            amount: 333,
        },
    ];
    let mut res = PoolReservations::default();
    let s = record(&pool, &mut res, 10, SEASON1_END).unwrap();
    assert_eq!(
        s.lines.iter().map(|l| l.amount).collect::<Vec<_>>(),
        vec![1_000, 333]
    );
    assert_eq!(res.total(), 1_333);
    // a second Season recorded now finds nothing free: it can't promise the same Gemas
    let again = record(&pool, &mut res, 2, SEASON1_END).unwrap();
    assert!(again.lines.is_empty());
    assert_eq!(res.total(), 1_333);
}

#[test]
fn every_rank_gets_its_share_of_every_line_rounded_down() {
    let pool = [
        PoolLine {
            key: lk(1),
            amount: 1_000,
        },
        PoolLine {
            key: lk(2),
            amount: 77,
        },
    ];
    let mut res = PoolReservations::default();
    let mut s = record(&pool, &mut res, 10, SEASON1_END).unwrap();
    let now = SEASON1_END + PAYOUT_WINDOW_SECS;
    let mut totals = [0u64; 2];
    for rank in 0..10u8 {
        for line in 0..2usize {
            let step = s.pay_step(&mut res, rank, line, now).unwrap();
            assert_eq!(
                step.amount,
                [1_000u64, 77][line] * PRIZE_BPS[rank as usize] as u64 / 10_000
            );
            totals[line] += step.amount;
        }
        assert!(s.rank_paid(rank));
    }
    assert_eq!(totals[0], 1_000);
    assert!(totals[1] <= 77);
    // the 7 Gemas of rounding dust stay reserved until the Season closes, then roll over
    assert_eq!(res.total(), u128::from(77 - totals[1]));
    s.close(&mut res, now).unwrap();
    assert_eq!(res.total(), 0);
}

#[test]
fn steps_must_follow_the_rank_cursor_and_the_window() {
    let pool = [
        PoolLine {
            key: lk(1),
            amount: 500,
        },
        PoolLine {
            key: lk(2),
            amount: 500,
        },
    ];
    let mut res = PoolReservations::default();
    let mut s = record(&pool, &mut res, 3, SEASON1_END).unwrap();
    let open = SEASON1_END + PAYOUT_WINDOW_SECS;
    assert_eq!(
        s.pay_step(&mut res, 0, 0, open - 1),
        Err(CoreError::PayoutWindowOpen)
    );
    assert_eq!(s.pay_step(&mut res, 0, 1, open), Err(CoreError::BudgetStep));
    assert_eq!(
        s.pay_step(&mut res, 3, 0, open),
        Err(CoreError::SeasonInvalid)
    );
    s.pay_step(&mut res, 0, 0, open).unwrap();
    assert_eq!(
        s.pay_step(&mut res, 0, 0, open),
        Err(CoreError::BudgetStep),
        "no double pay"
    );
    s.pay_step(&mut res, 0, 1, open).unwrap();
    assert_eq!(s.pay_step(&mut res, 0, 2, open), Err(CoreError::BudgetStep));
}

#[test]
fn a_voided_rank_pays_nothing_and_its_share_rolls_over() {
    let pool = [PoolLine {
        key: lk(1),
        amount: 10_000,
    }];
    let mut res = PoolReservations::default();
    let mut s = record(&pool, &mut res, 2, SEASON1_END).unwrap();
    let open = SEASON1_END + PAYOUT_WINDOW_SECS;
    s.void(0, open - 1).unwrap();
    assert_eq!(s.void(0, open - 1), Err(CoreError::RankVoided));
    assert_eq!(s.void(1, open), Err(CoreError::PayoutWindowClosed));
    assert_eq!(s.pay_step(&mut res, 0, 0, open), Err(CoreError::RankVoided));
    assert_eq!(s.close(&mut res, open), Err(CoreError::SeasonUnfinished));
    assert_eq!(s.pay_step(&mut res, 1, 0, open).unwrap().amount, 1_800);
    s.close(&mut res, open).unwrap();
    assert_eq!(
        res.total(),
        0,
        "voided rank's 2,500 and the rest are free again"
    );
    // the next Season can promise them
    let pool2 = [PoolLine {
        key: lk(1),
        amount: 10_000 - 1_800,
    }];
    let s2 = record(&pool2, &mut res, 1, SEASON1_END).unwrap();
    assert_eq!(s2.lines[0].amount, 8_200);
}

#[test]
fn funding_arriving_mid_payout_does_not_change_a_recorded_budget() {
    let mut pool = vec![PoolLine {
        key: lk(1),
        amount: 1_000,
    }];
    let mut res = PoolReservations::default();
    let mut s = record(&pool, &mut res, 3, SEASON1_END).unwrap();
    let frozen = s.lines.clone();
    let open = SEASON1_END + PAYOUT_WINDOW_SECS;
    s.pay_step(&mut res, 0, 0, open).unwrap();
    // a new prize line lands in the Pool and the old line grows too
    pool.push(PoolLine {
        key: lk(2),
        amount: 9_999,
    });
    pool[0].amount += 5_000;
    s.pay_step(&mut res, 1, 0, open).unwrap();
    s.pay_step(&mut res, 2, 0, open).unwrap();
    assert_eq!(
        s.lines.iter().map(|l| l.amount).collect::<Vec<_>>(),
        frozen.iter().map(|l| l.amount).collect::<Vec<_>>()
    );
    assert_eq!(s.lines.len(), 1);
}

#[test]
fn only_the_biggest_lines_enter_a_budget_and_the_rest_wait() {
    let pool: Vec<PoolLine> = (1..=20u8)
        .map(|n| PoolLine {
            key: lk(n),
            amount: 100 + n as u64,
        })
        .collect();
    let mut res = PoolReservations::default();
    let s = record(&pool, &mut res, 1, SEASON1_END).unwrap();
    assert_eq!(s.lines.len(), MAX_BUDGET_LINES);
    assert!(s.lines.iter().all(|l| l.amount >= 105));
    assert!(s.lines.windows(2).all(|w| w[0].key() < w[1].key()));
}

#[test]
fn fee_class_lines_cannot_enter_a_budget() {
    let mut k = lk(1);
    k.class = CLASS_LEADERBOARD;
    let mut res = PoolReservations::default();
    assert_eq!(
        record(&[PoolLine { key: k, amount: 5 }], &mut res, 1, SEASON1_END).err(),
        Some(CoreError::SourceMismatch)
    );
}

#[test]
fn a_ranking_must_be_ordered_distinct_and_scored() {
    let mut res = PoolReservations::default();
    let mut r = on();
    r.last_funded = 1;
    let mut bad = ranking(3);
    bad[1].points = 5_000;
    assert_eq!(
        PrizeSeason::record(1, SEASON1_END, &[&r], &[], &mut res, &bad).err(),
        Some(CoreError::SeasonInvalid)
    );
    let mut dup = ranking(3);
    dup[2].account = dup[0].account;
    assert_eq!(
        PrizeSeason::record(1, SEASON1_END, &[&r], &[], &mut res, &dup).err(),
        Some(CoreError::SeasonInvalid)
    );
}

// ------------------------------------------------------------------ end to end on real baskets

#[test]
fn fund_record_pay_through_real_baskets_with_funding_mid_payout() {
    let mut pool = LineStore::init(vec![0u8; required_len(8)], key(200), 255).unwrap();
    let mut winner = LineStore::init(vec![0u8; required_len(8)], key(101), 255).unwrap();
    let mut route = on();

    // Season 1: yield fees realised, funded, the prize Source credited to the Pool.
    route.realise_yield_fee_default(2_000).unwrap();
    let ps1 = route
        .fund_season_prize(1, SEASON1_END, key(31), 100)
        .unwrap()
        .issued
        .unwrap();
    pool.merge(&prize_line(SIDE_WON, SEASON1_END, ps1.source, ps1.gemas))
        .unwrap();

    let view = |s: &LineStore<Vec<u8>>| -> Vec<PoolLine> {
        s.lines()
            .filter(|l| l.is_playable())
            .map(|l| PoolLine {
                key: l.key(),
                amount: l.amount,
            })
            .collect()
    };
    let mut res = PoolReservations::default();
    let mut season = PrizeSeason::record(
        1,
        SEASON1_END,
        &[&route],
        &view(&pool),
        &mut res,
        &ranking(2),
    )
    .unwrap();
    let open = SEASON1_END + PAYOUT_WINDOW_SECS;

    // Season 2 funding lands while rank 0 is being paid.
    route.realise_yield_fee_default(600).unwrap();
    let ps2 = route
        .fund_season_prize(2, SEASON1_END + 7 * 24 * 3600, key(32), 40)
        .unwrap()
        .issued
        .unwrap();
    pool.merge(&prize_line(
        SIDE_WON,
        SEASON1_END + 7 * 24 * 3600,
        ps2.source,
        ps2.gemas,
    ))
    .unwrap();

    for rank in 0..2u8 {
        for i in 0..season.lines.len() {
            let step = season.pay_step(&mut res, rank, i, open).unwrap();
            if step.amount == 0 {
                continue;
            }
            let at = pool.find(&step.key).unwrap();
            let mut src = pool.get(at).unwrap();
            let mut dst = prize_line(SIDE_WON, src.due_at, src.source, 0);
            prize_move(&mut src, &mut dst, step.amount).unwrap();
            pool.set_line(at, &src).unwrap();
            winner.merge(&dst).unwrap();
        }
    }
    // only Season 1's Source was in the budget; Season 2's prize is untouched
    assert_eq!(season.lines.len(), 1);
    assert_eq!(winner.get(0).unwrap().source, ps1.source);
    assert_eq!(winner.won_total(), 25 + 18);
    assert_eq!(pool.won_total(), 100 - 43 + 40);
    season.close(&mut res, open).unwrap();
    assert_eq!(res.total(), 0);
    route.check(&[ps1, ps2]).unwrap();
    let _ = (season_end(1), SEASON1_END);
}

// ------------------------------------------------------------------ fuzz: route money

#[test]
fn fuzz_route_books_never_overspend_and_the_escrow_never_exceeds_what_was_funded() {
    for seed in 0..600u64 {
        let mut rng = Rng(seed);
        let mut r = RouteLedger::default();
        r.set_escrow_enabled(rng.below(8) != 0);
        let mut sources: Vec<PrizeSource> = Vec::new();
        let mut pending: Vec<(usize, PrizePayout)> = Vec::new();
        let mut season = 0u32;
        let mut paid_out: u128 = 0; // shares that left the escrow through prize payouts
        for _ in 0..150 {
            let before = r.clone();
            let n = rng.below(5_000) as u128 + rng.below(2) as u128 * (1u128 << 70);
            let ok = match rng.below(14) {
                0 => r.receive(n).is_ok(),
                1 => r.realise_yield_fee(n, rng.below(10_001) as u16).is_ok(),
                2 => r.add_owed(n % 3_000).is_ok(),
                3 => {
                    let k = n % 3_000;
                    r.pay_owed(k).is_ok()
                }
                4 => r.spend(n % 4_000).is_ok(),
                5 => r.reserve(n % 2_000).is_ok(),
                6 => {
                    let k = n % 2_000;
                    r.pay_reserved(k).is_ok()
                }
                7 => r.unreserve(n % 2_000).is_ok(),
                8 => {
                    let next = season + 1;
                    let now = season_end(next).unwrap();
                    let gemas = rng.below(500);
                    match r.fund_season_prize(next, now, key(next as u8), gemas) {
                        Ok(f) => {
                            season = next;
                            if let Some(p) = f.issued {
                                sources.push(p);
                            }
                            true
                        }
                        Err(_) => false,
                    }
                }
                9 if !sources.is_empty() => {
                    let i = rng.below(sources.len() as u64) as usize;
                    let k = rng.below(sources[i].gemas + 1);
                    let mut ps = sources[i];
                    match r.redeem_prize(&mut ps, k) {
                        Ok(s) => {
                            paid_out += s;
                            sources[i] = ps;
                            true
                        }
                        Err(_) => false,
                    }
                }
                10 if !sources.is_empty() => {
                    let i = rng.below(sources.len() as u64) as usize;
                    let k = rng.below(sources[i].gemas + 1);
                    let mut ps = sources[i];
                    match r.begin_prize_payout(&mut ps, k) {
                        Ok(p) => {
                            sources[i] = ps;
                            pending.push((i, p));
                            true
                        }
                        Err(_) => false,
                    }
                }
                11 if !pending.is_empty() => {
                    let (_, p) = pending.swap_remove(rng.below(pending.len() as u64) as usize);
                    paid_out += p.shares;
                    r.finish_prize_payout(p).is_ok()
                }
                12 if !pending.is_empty() => {
                    let (i, p) = pending.swap_remove(rng.below(pending.len() as u64) as usize);
                    let mut ps = sources[i];
                    let ok = r.cancel_prize_payout(&mut ps, p).is_ok();
                    sources[i] = ps;
                    ok
                }
                _ => {
                    r.set_escrow_enabled(rng.below(6) != 0);
                    true
                }
            };
            if !ok {
                assert_eq!(
                    r, before,
                    "seed {seed}: a refused operation changed the books"
                );
            }
            // The Treasury can never spend shares owed to holders, the Pool or reservations.
            assert!(
                r.owed_shares + r.pool_owed + r.reserved <= r.treasury_shares,
                "seed {seed}"
            );
            assert!(r.spendable() <= r.treasury_shares - r.owed_shares - r.pool_owed - r.reserved);
            // Prize Gemas never exceed confirmed escrow: every share a Source owns is in the escrow.
            r.check(&sources).unwrap();
            let pending_sum: u128 = pending.iter().map(|(_, p)| p.shares).sum();
            assert_eq!(r.escrow_pending, pending_sum, "seed {seed}");
            // escrow + paid out == everything ever moved in by funding
            assert_eq!(
                r.escrow_total() + paid_out,
                r.pool_funded_total,
                "seed {seed}: escrow shares were created or lost"
            );
            // The Pool's half is owed only once realised.
            assert!(r.pool_realised_total >= r.pool_funded_total);
        }
    }
}

// ------------------------------------------------------------------ fuzz: Seasons

#[test]
fn fuzz_seasons_freeze_budgets_and_pay_every_rank_the_same_mix() {
    for seed in 0..400u64 {
        let mut rng = Rng(seed);
        let mut pool: Vec<PoolLine> = (0..rng.below(24) + 1)
            .map(|n| {
                let w = rng.below(40) + 1;
                PoolLine {
                    key: lk(n as u8 + 1),
                    amount: rng.below(1u64 << w),
                }
            })
            .collect();
        let mut res = PoolReservations::default();
        let routes = funded_routes();
        let refs: Vec<&RouteLedger> = routes.iter().collect();
        let ranks = rng.below(11) as usize;
        let mut s1 =
            PrizeSeason::record(1, SEASON1_END, &refs, &pool, &mut res, &ranking(ranks)).unwrap();
        let frozen: Vec<u64> = s1.lines.iter().map(|l| l.amount).collect();
        // A second Season recorded while the first is paying cannot reuse its Gemas.
        let mut s2 =
            PrizeSeason::record(1, SEASON1_END, &refs, &pool, &mut res, &ranking(ranks)).unwrap();
        for l2 in &s2.lines {
            let total = pool.iter().find(|p| p.key == l2.key()).unwrap().amount;
            let l1 = s1
                .lines
                .iter()
                .find(|l| l.key() == l2.key())
                .map_or(0, |l| l.amount);
            assert!(l1 + l2.amount <= total, "seed {seed}: Gemas promised twice");
        }
        let open = SEASON1_END + PAYOUT_WINDOW_SECS;
        let mut voided = vec![false; ranks];
        // (fresh Seasons voiding inside the window)
        for r in 0..ranks {
            if rng.below(5) == 0 {
                s1.void(r as u8, open - 1).unwrap();
                voided[r] = true;
            }
        }
        let mut steps: Vec<(u8, usize)> = (0..ranks as u8)
            .flat_map(|r| (0..s1.lines.len()).map(move |l| (r, l)))
            .collect();
        let mut paid = vec![vec![0u64; s1.lines.len()]; ranks];
        let mut guard = 0;
        while !steps.is_empty() && guard < 10_000 {
            guard += 1;
            let i = rng.below(steps.len() as u64) as usize;
            let (rank, line) = steps[i];
            match s1.pay_step(&mut res, rank, line, open) {
                Ok(step) => {
                    paid[rank as usize][line] = step.amount;
                    let p = pool.iter_mut().find(|p| p.key == step.key).unwrap();
                    p.amount -= step.amount; // leaves the basket
                    steps.swap_remove(i);
                    // funding keeps arriving mid payout
                    if rng.below(4) == 0 {
                        let mut k = lk(250);
                        k.due_at = 1_000 + guard as i64;
                        pool.push(PoolLine {
                            key: k,
                            amount: rng.below(1 << 30),
                        });
                    }
                }
                Err(CoreError::RankVoided) => {
                    steps.swap_remove(i);
                }
                Err(CoreError::BudgetStep) => {} // out of order: try another
                Err(e) => panic!("seed {seed}: {e:?}"),
            }
            assert_eq!(
                s1.lines.iter().map(|l| l.amount).collect::<Vec<_>>(),
                frozen,
                "seed {seed}: a recorded budget changed"
            );
            // reservations never exceed what the Pool holds
            for p in &pool {
                assert!(res.reserved_of(&p.key) <= p.amount, "seed {seed}");
            }
        }
        // totals per line never exceed the budget; same mix within rounding
        for l in 0..s1.lines.len() {
            let sum: u64 = (0..ranks).map(|r| paid[r][l]).sum();
            assert!(
                sum <= s1.lines[l].amount && s1.lines[l].paid == sum,
                "seed {seed}"
            );
            for a in 0..ranks {
                for b in 0..ranks {
                    if voided[a] || voided[b] {
                        continue;
                    }
                    let (pa, pb) = (paid[a][l] as u128, paid[b][l] as u128);
                    let (ba, bb) = (PRIZE_BPS[a] as u128, PRIZE_BPS[b] as u128);
                    let diff = (pa * bb).abs_diff(pb * ba);
                    assert!(
                        diff < ba.max(bb),
                        "seed {seed}: ranks {a},{b} line {l} mixes differ"
                    );
                }
            }
        }
        s1.close(&mut res, open).unwrap();
        // what rolls over is exactly the dust plus the voided ranks' shares
        for l in &s1.lines {
            let bought: u64 = l.paid;
            assert!(bought <= l.amount);
        }
        // s2 still holds its own reservations untouched by s1's close
        for l2 in &s2.lines {
            assert!(
                res.reserved_of(&l2.key()) >= l2.amount - l2.paid,
                "seed {seed}"
            );
        }
        let _ = &mut s2;
    }
}

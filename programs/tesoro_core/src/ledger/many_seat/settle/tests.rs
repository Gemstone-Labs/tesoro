use super::*;
use crate::ledger::lifecycle::Terms;

/// Railcar's terms: Platform 2%, Studio 3% (Tesoro's own, a senior class).
fn terms(platform_bps: u16, studio_bps: u16) -> Terms {
    Terms {
        platform_bps,
        studio_bps,
        studio_owner: None,
        studio_priority: true,
    }
}

const LB: u16 = 100;

#[test]
fn the_worked_example_pays_to_the_gema() {
    // Ana refunded 350 of 500; Dee, Ben, Cy placed 60/25/15; Eve aboard at Impact.
    let p = plan_payout(500, 5, &[6000, 2500, 1500], 350, &terms(200, 300), LB).unwrap();
    assert_eq!(p.fees.iter().sum::<u64>(), 129);
    assert_eq!(p.fees, [44, 64, 21]);
    assert_eq!(p.forfeited, 650);
    assert_eq!(&p.won[..3], &[313, 130, 78]);
    assert!(p.won[3..].iter().all(|w| *w == 0));
    assert!(!p.fees_capped);
}

#[test]
fn without_the_early_jump_the_rounding_gema_goes_to_first_place() {
    // P 2,500, fees 150, 850 to share: 510 / 212.5 / 127.5 floored, the 1 left to first place.
    let p = plan_payout(500, 5, &[6000, 2500, 1500], 0, &terms(200, 300), LB).unwrap();
    assert_eq!(p.fees, [50, 75, 25]);
    assert_eq!(&p.won[..3], &[511, 212, 127]);
}

#[test]
fn two_places_split_seventy_thirty() {
    // Ana refunded 350; Dee and Ben placed; Cy and Eve aboard: F = 1,150, fees 129, 1,021 to share.
    let p = plan_payout(500, 5, &[7000, 3000], 350, &terms(200, 300), LB).unwrap();
    assert_eq!(p.fees, [44, 64, 21]);
    assert_eq!(p.forfeited, 1_150);
    assert_eq!(&p.won[..2], &[715, 306]);
}

#[test]
fn one_place_takes_everything_after_fees() {
    let p = plan_payout(500, 5, &[10_000], 350, &terms(200, 300), LB).unwrap();
    assert_eq!(p.forfeited, 1_650);
    assert_eq!(p.won[0], 1_650 - 129);
}

#[test]
fn head_to_head_in_this_shape_gives_todays_numbers() {
    // winner 100%, loser nothing: fees 6% of both entries, all from the loser
    let p = plan_payout(500, 2, &[10_000], 0, &terms(200, 300), LB).unwrap();
    assert_eq!((p.fees, p.won[0]), ([20, 30, 10], 440));
    let p = plan_payout(1_000, 2, &[10_000], 0, &terms(200, 300), LB).unwrap();
    assert_eq!((p.fees, p.won[0]), ([40, 60, 20], 880));
}

#[test]
fn fees_are_capped_at_the_forfeits_platform_first() {
    // 44% fees; two early refunds of 400: P 1,700 asks 748, but only 200 is forfeited.
    let p = plan_payout(500, 5, &[6000, 2500, 1500], 800, &terms(4_000, 300), LB).unwrap();
    assert_eq!(p.forfeited, 200);
    assert_eq!(p.fees, [200, 0, 0]);
    assert_eq!(&p.won[..3], &[0, 0, 0]);
    assert!(p.fees_capped);
}

#[test]
fn a_cap_shortens_the_later_fee_classes_first() {
    // 30% fees on P 1,800 = 540 (Platform 432, Studio 54, Leaderboard 54); forfeited 300
    let p = plan_payout(500, 5, &[6000, 2500, 1500], 700, &terms(2_400, 300), 300).unwrap();
    assert_eq!(p.forfeited, 300);
    assert_eq!(p.fees, [300, 0, 0]);
    let p = plan_payout(500, 5, &[10_000], 1_500, &terms(2_400, 300), 300).unwrap();
    // P 1,000: Platform 240, Studio 30, Leaderboard 30; forfeited 500, nothing capped
    assert_eq!((p.fees, p.fees_capped, p.won[0]), ([240, 30, 30], false, 200));
    let p = plan_payout(500, 5, &[10_000], 1_740, &terms(2_400, 300), 300).unwrap();
    // P 760: total 228 = Platform 184 + Studio 22 + Leaderboard 22; forfeited 260
    assert_eq!((p.fees, p.fees_capped, p.won[0]), ([184, 22, 22], false, 32));
    let p = plan_payout(500, 5, &[10_000], 1_790, &terms(2_400, 300), 300).unwrap();
    // P 710: Platform 171, Studio 21, Leaderboard 21 (total 213); forfeited 210: Leaderboard cut to 18
    assert_eq!((p.fees, p.fees_capped, p.won[0]), ([171, 21, 18], true, 0));
}

#[test]
fn nothing_forfeited_means_no_fee() {
    // three unplaced seats each refunded in full
    let p = plan_payout(500, 5, &[6000, 4000], 1_500, &terms(200, 300), LB).unwrap();
    assert_eq!((p.forfeited, p.fees), (0, [0, 0, 0]));
    assert_eq!(&p.won[..2], &[0, 0]);
}

#[test]
fn a_result_that_does_not_fit_the_car_is_refused() {
    assert_eq!(
        plan_payout(500, 2, &[5000, 3000, 2000], 0, &terms(200, 300), LB).unwrap_err(),
        SeatError::BadResult
    );
    // refunds above what the unplaced seats put in
    assert_eq!(
        plan_payout(500, 5, &[10_000], 2_001, &terms(200, 300), LB).unwrap_err(),
        SeatError::BadResult
    );
    assert_eq!(
        plan_payout(500, 5, &[10_000], 0, &terms(4_900, 300), LB).unwrap_err(),
        SeatError::FeeTooHigh
    );
}

// ---------------------------------------------------------------------------------------------
// The line walk, over a memory world
// ---------------------------------------------------------------------------------------------

use crate::ledger::book::SourceBook;
use crate::ledger::draw::{grow_spill_body, spill_body, DrawError, MemBooks, Placed, Pool, SourceBooks};
use crate::ledger::many_seat::SeatState;
use crate::ledger::lifecycle::{MatchId, MatchMeta, Settlement};
use crate::ledger::line_store::{
    required_len, Line, LineStore, CLASS_GENERAL, SIDE_OWN, SIDE_WON,
};
use crate::ledger::many_seat::{ManySeatRecord, ManyStage, Seat, SeatFill, SEATS_PER_PAGE};
use crate::ledger::Key;
use std::collections::BTreeMap;

fn key(n: u8) -> Key {
    [n; 32]
}
const ENTRY: u64 = 500;
const T: i64 = 1_000_000;
const AUTH: Key = [8; 32];
const SLOT: u64 = 100;

struct Store {
    basket: Vec<u8>,
    spill: Vec<u8>,
}

struct World {
    accts: BTreeMap<Key, Store>,
    books: MemBooks,
    /// Fee Gemas per (class, Source).
    counters: BTreeMap<(u8, Key), Line>,
}

impl World {
    fn new() -> World {
        let mut books = MemBooks::default();
        for s in 100..110u8 {
            let mut b = SourceBook::new();
            b.start_extension().unwrap();
            books.insert(key(s), b);
        }
        World {
            accts: BTreeMap::new(),
            books,
            counters: BTreeMap::new(),
        }
    }

    fn account(&mut self, who: Key, basket_lines: usize) {
        let mut basket = vec![0u8; required_len(basket_lines)];
        LineStore::init(basket.as_mut_slice(), who, 1).unwrap();
        self.accts.insert(
            who,
            Store {
                basket,
                spill: spill_body(who, 0).unwrap(),
            },
        );
    }

    fn grow_spill(&mut self, who: &Key, by: usize) {
        let a = self.accts.get_mut(who).unwrap();
        let cap = LineStore::new(a.spill.as_slice()).unwrap().capacity();
        grow_spill_body(&mut a.spill, cap + by);
    }

    fn lines_of(&self, who: &Key) -> Vec<Line> {
        let a = &self.accts[who];
        let mut v: Vec<Line> = LineStore::new(a.basket.as_slice()).unwrap().lines().collect();
        v.extend(LineStore::new(a.spill.as_slice()).unwrap().lines());
        v
    }

    fn gemas(&self, who: u8) -> u64 {
        self.lines_of(&key(who)).iter().map(|l| l.amount).sum()
    }

    /// Gemas `who` holds of Source `src` on `side`.
    fn held(&self, who: u8, src: u8, side: u8) -> u64 {
        self.lines_of(&key(who))
            .iter()
            .filter(|l| l.source == key(src) && l.side == side)
            .map(|l| l.amount)
            .sum()
    }

    fn fees(&self) -> [u64; 3] {
        let mut out = [0; 3];
        for ((class, _), l) in &self.counters {
            out[*class as usize] += l.amount;
        }
        out
    }

    fn fee_of(&self, class: u8, src: u8) -> u64 {
        self.counters.get(&(class, key(src))).map_or(0, |l| l.amount)
    }
}

impl Settlement for World {
    fn books(&mut self) -> &mut dyn SourceBooks {
        &mut self.books
    }
    fn sync_source(&mut self, _source: &Key) -> LcResult<()> {
        Ok(())
    }
    fn credit(&mut self, owner: &Key, line: &Line) -> LcResult<Placed> {
        let a = self.accts.get_mut(owner).ok_or(LifecycleError::MissingAccount)?;
        let mut b = LineStore::new(a.basket.as_mut_slice()).unwrap();
        let mut s = LineStore::new(a.spill.as_mut_slice()).unwrap();
        Ok(Pool::new(&mut b, &mut s).put(&mut self.books, line)?)
    }
    fn credit_fee(&mut self, class: u8, owner: Option<&Key>, line: &Line) -> LcResult<()> {
        assert!(owner.is_none(), "Tesoro's own Studio: every fee is a counter");
        let mut counter = self
            .counters
            .get(&(class, line.source))
            .copied()
            .unwrap_or_else(|| SourceBook::blank_line(SIDE_OWN, 0, line.source, class, 0));
        let mut l = *line;
        let (book, history) = self.books.book_with_history(&line.source)?;
        book.transfer(&mut l, &mut counter, line.amount, &*history)?;
        self.counters.insert((class, line.source), counter);
        Ok(())
    }
}

impl SeatCredits for World {
    fn settlement(&mut self) -> &mut dyn Settlement {
        self
    }
    fn set_hold(&mut self, _owner: &Key, _slots: u32) {}
    fn hold_of(&self, _owner: &Key) -> u32 {
        0
    }
}

/// The pages and Pots a transaction loaded.
struct Pages {
    seats: Vec<Seat>,
    pots: Vec<PotPages>,
    /// Pages a chunk was not given.
    hidden: Vec<u8>,
}

impl Seats<Vec<u8>> for Pages {
    fn seat(&mut self, i: u8) -> LcResult<Seat> {
        if self.hidden.contains(&(i / SEATS_PER_PAGE as u8)) {
            return Err(LifecycleError::MissingAccount);
        }
        Ok(self.seats.get(i as usize).copied().unwrap_or_else(Seat::zeroed))
    }
    fn set_seat(&mut self, i: u8, seat: &Seat) -> LcResult<()> {
        self.seats[i as usize] = *seat;
        Ok(())
    }
    fn pot(&mut self, i: u8, k: &Key) -> LcResult<&mut PotPages> {
        assert_eq!(*k, pot_key(i));
        Ok(&mut self.pots[i as usize])
    }
}

fn pot_key(i: u8) -> Key {
    let mut k = [200u8; 32];
    k[0] = i;
    k
}

struct Car {
    rec: ManySeatRecord,
    pages: Pages,
}

/// A departed car: each Player `who` boards with lines `(Source, Gemas)`, together 500.
fn car(w: &mut World, riders: &[(u8, &[(u8, u64)])], t: Terms) -> Car {
    let mut rec = ManySeatRecord::open(
        MatchId {
            opener: key(riders[0].0),
            n: 0,
        },
        MatchMeta {
            challenge: false,
            asset: 0,
            listed: true,
        },
        ([9; 32], AUTH, SLOT),
        t,
        ENTRY,
        &[100, 500, 1_000],
        (2, 100),
        T,
    )
    .unwrap();
    let mut seats = vec![];
    let mut pots = vec![];
    for (i, (who, lines)) in riders.iter().enumerate() {
        w.account(key(*who), 32);
        let mut p = PotPages::new(key(*who));
        for (j, (src, amount)) in lines.iter().enumerate() {
            let mut line = SourceBook::blank_line(SIDE_OWN, j as i64, key(*src), CLASS_GENERAL, 0);
            w.books.issue(&key(*src), &mut line, *amount).unwrap();
            p.push(&line).unwrap();
        }
        assert_eq!(p.total(), ENTRY);
        let mut s = Seat::zeroed();
        s.fill(&SeatFill {
            player: key(*who),
            funder: key(*who),
            share_bps: 0,
            pot: pot_key(i as u8),
            pot_lines: p.len() as u32,
            hold: 0,
            counted: None,
        });
        seats.push(s);
        pots.push(p);
        rec.take_seat(T).unwrap();
    }
    rec.pages = riders.len().div_ceil(SEATS_PER_PAGE) as u8;
    rec.depart(T + 40, &AUTH, SLOT).unwrap();
    Car {
        rec,
        pages: Pages {
            seats,
            pots,
            hidden: vec![],
        },
    }
}

impl Car {
    fn settle(&mut self, result: &ManySeatResult) -> SeatResult<Started> {
        self.rec
            .start_settle(T + 100, &AUTH, SLOT, LB, result, &mut self.pages)
    }

    /// Chunks of `steps` until paid; returns how many chunks did work.
    fn run(&mut self, w: &mut World, steps: u32) -> u32 {
        let mut chunks = 0;
        while self.rec.stage() != ManyStage::Paid {
            let r = self.rec.chunk(&mut self.pages, w, steps).expect("chunk");
            assert!(r.blocked.is_none(), "blocked: {:?}", r.blocked);
            chunks += 1;
            assert!(chunks < 10_000);
        }
        assert!(self.pages.pots.iter().all(|p| p.total() == 0));
        chunks
    }
}

fn places(list: &[(u8, u16)]) -> Vec<SeatPlace> {
    list.iter()
        .map(|&(seat, share_bps)| SeatPlace { seat, share_bps })
        .collect()
}
fn refunds(list: &[(u8, u64)]) -> Vec<SeatRefund> {
    list.iter()
        .map(|&(seat, gemas)| SeatRefund { seat, gemas })
        .collect()
}

const ANA: u8 = 1;
const BEN: u8 = 2;
const CY: u8 = 3;
const DEE: u8 = 4;
const EVE: u8 = 5;

fn worked_example_car(w: &mut World) -> Car {
    car(
        w,
        &[
            (ANA, &[(100, 300), (101, 200)]),
            (BEN, &[(102, 500)]),
            (CY, &[(103, 250), (104, 250)]),
            (DEE, &[(100, 500)]),
            (EVE, &[(101, 200), (102, 300)]),
        ],
        terms(200, 300),
    )
}

fn worked_example_result() -> ManySeatResult {
    ManySeatResult::Placed {
        places: places(&[(3, 6000), (1, 2500), (2, 1500)]),
        refunds: refunds(&[(0, 350)]),
    }
}

#[test]
fn the_worked_example_moves_every_line_to_the_gema() {
    let mut w = World::new();
    let mut c = worked_example_car(&mut w);
    let started = c.settle(&worked_example_result()).unwrap();
    assert_eq!(started.kind, KIND_WIN);
    assert_eq!((started.refunded, started.forfeited), (350, 650));
    assert_eq!(started.opponent, key(BEN));
    c.run(&mut w, 3);
    let got: Vec<u64> = [ANA, BEN, CY, DEE, EVE].map(|p| w.gemas(p)).to_vec();
    assert_eq!(got, vec![350, 630, 578, 813, 0]);
    assert_eq!(w.fees(), [44, 64, 21]);
    assert_eq!(got.iter().sum::<u64>() + 129, 2_500);
    // Ana's refund is her own Gemas: her first line whole, 50 of the second
    assert_eq!((w.held(ANA, 100, SIDE_OWN), w.held(ANA, 101, SIDE_OWN)), (300, 50));
    // The forfeits, Ana's 150 of Source 101, then Eve's lines from her last: 300 of 102, 200 of
    // 101. Fees take Ana's 150 down to 21, which goes to Dee with 292 of Eve's 102; Ben gets the
    // last 8 of it and 122 of Eve's 101; Cy the 78 left.
    assert_eq!(
        (w.fee_of(0, 101), w.fee_of(1, 101), w.fee_of(2, 101)),
        (44, 64, 21)
    );
    assert_eq!((w.held(DEE, 101, SIDE_WON), w.held(DEE, 102, SIDE_WON)), (21, 292));
    assert_eq!((w.held(BEN, 102, SIDE_WON), w.held(BEN, 101, SIDE_WON)), (8, 122));
    assert_eq!(w.held(CY, 101, SIDE_WON), 78);
    // the placed seats' own entries came back as their own Gemas
    assert_eq!(w.held(DEE, 100, SIDE_OWN), 500);
}

#[test]
fn a_winner_with_no_room_holds_up_only_the_forfeits() {
    let mut w = World::new();
    let mut c = worked_example_car(&mut w);
    // Dee's stores hold one line: her own entry comes home, her winnings find no slot
    w.account(key(DEE), 1);
    c.settle(&worked_example_result()).unwrap();
    let mut blocked = None;
    for _ in 0..100 {
        match c.rec.chunk(&mut c.pages, &mut w, 4) {
            Ok(r) if r.blocked.is_some() => {
                blocked = r.blocked;
                break;
            }
            Ok(_) => {}
            Err(e) => {
                blocked = Some(e);
                break;
            }
        }
    }
    assert_eq!(blocked, Some(LifecycleError::Draw(DrawError::SpillFull)));
    // everyone's own Gemas are home already; the fees went out before Dee's turn
    let got: Vec<u64> = [ANA, BEN, CY, DEE, EVE].map(|p| w.gemas(p)).to_vec();
    assert_eq!(got, vec![350, 500, 500, 500, 0]);
    assert_eq!(w.fees(), [44, 64, 21]);
    // a replayed chunk changes nothing while the room is missing
    assert!(c.rec.chunk(&mut c.pages, &mut w, 4).is_err());
    // room is made (anyone may gift slots): the run goes on where it stopped
    w.grow_spill(&key(DEE), 2);
    c.run(&mut w, 4);
    let got: Vec<u64> = [ANA, BEN, CY, DEE, EVE].map(|p| w.gemas(p)).to_vec();
    assert_eq!(got, vec![350, 630, 578, 813, 0]);
}

#[test]
fn a_page_the_chunk_was_not_given_stops_it_and_nothing_is_skipped() {
    let mut w = World::new();
    let riders: Vec<(u8, &[(u8, u64)])> = (0..12u8).map(|i| (10 + i, &[(100, 500)][..])).collect();
    let mut c = car(&mut w, &riders, terms(200, 300));
    c.settle(&ManySeatResult::Placed {
        places: places(&[(11, 10_000)]),
        refunds: vec![],
    })
    .unwrap();
    c.pages.hidden = vec![1];
    let r = c.rec.chunk(&mut c.pages, &mut w, 20).unwrap();
    // seats 0-9 came home (nothing: they forfeit), then seat 11's entry is on the hidden page
    assert_eq!(r.blocked, Some(LifecycleError::MissingAccount));
    assert_eq!(w.gemas(21), 0);
    c.pages.hidden = vec![];
    c.run(&mut w, 20);
    // 11 entries forfeited: 6,000 Pot, 360 fees, 5,140 won
    assert_eq!(w.gemas(21), 500 + 5_500 - 360);
    assert_eq!(w.fees().iter().sum::<u64>(), 360);
}

#[test]
fn the_game_refund_returns_every_line_exactly_and_charges_nothing() {
    let mut w = World::new();
    let mut c = worked_example_car(&mut w);
    let lines_before: Vec<Vec<Line>> = c.pages.pots.iter().map(|p| p.lines()).collect();
    let s = c.settle(&ManySeatResult::Refund).unwrap();
    assert_eq!(s.kind, KIND_BY_GAME);
    assert_eq!(c.rec.stage(), ManyStage::Refunding);
    c.run(&mut w, 2);
    for (i, who) in [ANA, BEN, CY, DEE, EVE].into_iter().enumerate() {
        let mut have = w.lines_of(&key(who));
        let mut want = lines_before[i].clone();
        have.sort_by_key(|l| (l.source, l.due_at));
        want.sort_by_key(|l| (l.source, l.due_at));
        assert_eq!(have, want, "{who}'s lines come back as they went in");
    }
    assert_eq!(w.fees(), [0, 0, 0]);
}

#[test]
fn a_result_where_nothing_is_forfeited_is_a_refund() {
    let mut w = World::new();
    let mut c = worked_example_car(&mut w);
    let s = c
        .settle(&ManySeatResult::Placed {
            places: places(&[(3, 7000), (1, 3000)]),
            refunds: refunds(&[(0, 500), (2, 500), (4, 500)]),
        })
        .unwrap();
    assert_eq!((s.kind, s.forfeited), (KIND_BY_GAME, 0));
    c.run(&mut w, 5);
    assert!([ANA, BEN, CY, DEE, EVE].iter().all(|p| w.gemas(*p) == 500));
    assert_eq!(w.fees(), [0, 0, 0]);
}

#[test]
fn one_place_names_the_seat_that_lost_most_as_its_opponent() {
    let mut w = World::new();
    let mut c = worked_example_car(&mut w);
    // Dee alone placed; Ana and Ben refunded, Cy and Eve lost everything: Cy is the lower seat
    let s = c
        .settle(&ManySeatResult::Placed {
            places: places(&[(3, 10_000)]),
            refunds: refunds(&[(0, 400), (1, 100)]),
        })
        .unwrap();
    assert_eq!(s.opponent, key(CY));
    c.run(&mut w, 3);
    // forfeited 100 + 400 + 500 + 500 = 1,500; Pot 2,000: fees 120
    assert_eq!(w.gemas(DEE), 500 + 1_500 - 120);
    assert_eq!((w.gemas(ANA), w.gemas(BEN), w.gemas(CY), w.gemas(EVE)), (400, 100, 0, 0));
}

#[test]
fn head_to_head_through_the_walk_pays_the_winner_940() {
    let mut w = World::new();
    let mut c = car(
        &mut w,
        &[(ANA, &[(100, 500)]), (BEN, &[(101, 250), (102, 250)])],
        terms(200, 300),
    );
    let s = c
        .settle(&ManySeatResult::Placed {
            places: places(&[(0, 10_000)]),
            refunds: vec![],
        })
        .unwrap();
    assert_eq!(s.opponent, key(BEN));
    c.run(&mut w, 12);
    assert_eq!((w.gemas(ANA), w.gemas(BEN)), (940, 0));
    assert_eq!(w.fees(), [20, 30, 10]);
}

#[test]
fn a_backed_place_returns_the_backers_entry_then_splits_the_winnings_by_the_offer() {
    let mut w = World::new();
    let mut c = worked_example_car(&mut w);
    // Dee's seat is Backed by Fay (6): Fay's entry, Dee's Offer share 50%
    const FAY: u8 = 6;
    w.account(key(FAY), 8);
    c.pages.seats[3].funder = key(FAY);
    c.pages.seats[3].share_bps = 5_000u16.to_le_bytes();
    c.settle(&worked_example_result()).unwrap();
    c.run(&mut w, 3);
    // Fay: 500 back, then 157 of the 313; Dee 156 (floored share)
    assert_eq!((w.gemas(FAY), w.gemas(DEE)), (657, 156));
    assert_eq!((w.gemas(BEN), w.gemas(CY)), (630, 578));
}

fn refused(c: &mut Car, result: ManySeatResult) -> SeatError {
    let before = (c.rec, c.pages.seats.clone());
    let e = c.settle(&result).unwrap_err();
    assert_eq!(c.rec.stage(), ManyStage::Departed);
    let _ = before;
    e
}

#[test]
fn a_result_that_breaks_the_rules_is_refused() {
    let mut w = World::new();
    let mut c = worked_example_car(&mut w);
    let p = |pl: &[(u8, u16)], r: &[(u8, u64)]| ManySeatResult::Placed {
        places: places(pl),
        refunds: refunds(r),
    };
    let bad = [
        p(&[(3, 6000), (1, 3000)], &[]),                // shares sum to 9,000
        p(&[(3, 6000), (1, 2500), (2, 2500)], &[]),     // 11,000
        p(&[(3, 5000), (3, 5000)], &[]),                // a seat placed twice
        p(&[(3, 3000), (1, 7000)], &[]),                // shares rise
        p(&[(3, 10_000)], &[(3, 100)]),                 // a refund on a placed seat
        p(&[(3, 10_000)], &[(0, 501)]),                 // a refund above the entry
        p(&[(3, 10_000)], &[(0, 0)]),                   // an empty refund
        p(&[(3, 10_000)], &[(1, 100), (0, 100)]),       // refunds out of order
        p(&[(3, 10_000)], &[(0, 100), (0, 100)]),       // a seat refunded twice
        p(&[(7, 10_000)], &[]),                         // an empty seat
        p(&[(200, 10_000)], &[]),                       // no such seat
        p(&[], &[]),                                    // nobody placed
        p(&[(3, 0), (1, 10_000)], &[]),                 // a zero share
    ];
    for r in bad {
        assert_eq!(refused(&mut c, r.clone()), SeatError::BadResult, "{r:?}");
        // a refused result leaves no mark on the seats
        c = worked_example_car(&mut World::new());
    }
    let eleven: Vec<(u8, u16)> = (0..11).map(|i| (i, 1)).collect();
    assert_eq!(refused(&mut c, p(&eleven, &[])), SeatError::BadResult);
}

#[test]
fn only_the_game_starts_a_settlement_once_and_within_seven_days() {
    let mut w = World::new();
    let mut c = worked_example_car(&mut w);
    let r = worked_example_result();
    let now = T + 100;
    assert_eq!(
        c.rec.start_settle(now, &[7; 32], SLOT, LB, &r, &mut c.pages).unwrap_err(),
        SeatError::NotGame
    );
    assert_eq!(
        c.rec.start_settle(now, &AUTH, SLOT + 1, LB, &r, &mut c.pages).unwrap_err(),
        SeatError::GameUpgraded
    );
    let late = c.rec.deadline_abs();
    assert_eq!(
        c.rec.start_settle(late, &AUTH, SLOT, LB, &r, &mut c.pages).unwrap_err(),
        SeatError::PastDeadline
    );
    c.settle(&r).unwrap();
    assert_eq!(c.settle(&r).unwrap_err(), SeatError::NotDeparted);
    assert_eq!(c.rec.start_refund(late, SLOT).unwrap_err(), SeatError::NotDeparted);
}

#[test]
fn anyone_refunds_a_day_after_departure_or_when_the_game_changed() {
    let mut w = World::new();
    let mut c = worked_example_car(&mut w);
    let after = c.rec.refund_after();
    assert_eq!(after, T + 40 + 24 * 3600);
    assert_eq!(c.rec.start_refund(after - 1, SLOT).unwrap_err(), SeatError::NotExpired);
    assert_eq!(c.rec.start_refund(after, SLOT).unwrap(), KIND_ABANDONED);
    c.run(&mut w, 4);
    assert!([ANA, BEN, CY, DEE, EVE].iter().all(|p| w.gemas(*p) == 500));
    let mut c = worked_example_car(&mut World::new());
    assert_eq!(c.rec.start_refund(T + 50, SLOT + 1).unwrap(), KIND_GAME_UPGRADED);
}

#[test]
fn a_paid_car_closes_its_seats_one_by_one_then_itself() {
    let mut w = World::new();
    let mut c = worked_example_car(&mut w);
    c.settle(&worked_example_result()).unwrap();
    let mut s0 = c.pages.seats[0];
    assert_eq!(c.rec.close_seat(&mut s0).unwrap_err(), SeatError::NotPaid);
    assert_eq!(c.rec.close_car().unwrap_err(), SeatError::NotPaid);
    c.run(&mut w, 6);
    for i in 0..5 {
        assert_eq!(c.rec.close_car().unwrap_err(), SeatError::NotEmpty);
        let mut s = c.pages.seats[i];
        c.rec.close_seat(&mut s).unwrap();
        assert_eq!(s.state(), SeatState::Empty);
        assert_eq!(c.rec.close_seat(&mut s).unwrap_err(), SeatError::BadResult);
    }
    c.rec.close_car().unwrap();
    assert_eq!(c.rec.stage(), ManyStage::Closed);
}

// ---------------------------------------------------------------------------------------------
// Property: whatever valid result and chunk sizes, every Gema lands where the payout says
// ---------------------------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % n.max(1)
    }
}

#[test]
fn every_gema_lands_where_the_payout_says() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    for case in 0..300 {
        let mut w = World::new();
        let n = 2 + rng.below(24) as usize;
        let mut riders: Vec<(u8, Vec<(u8, u64)>)> = vec![];
        for i in 0..n {
            // 1-5 lines from random Sources, together 500
            let k = 1 + rng.below(5) as usize;
            let mut left = ENTRY;
            let mut lines = vec![];
            for j in 0..k {
                let a = if j + 1 == k { left } else { 1 + rng.below(left - (k - j - 1) as u64) };
                left -= a;
                lines.push((100 + rng.below(10) as u8, a));
            }
            riders.push((10 + i as u8, lines));
        }
        let view: Vec<(u8, &[(u8, u64)])> = riders.iter().map(|(w, l)| (*w, &l[..])).collect();
        let t = terms(rng.below(1_500) as u16, rng.below(1_000) as u16);
        let mut c = car(&mut w, &view, t);
        // places: 1-3 distinct seats, shares not increasing, summing to 10,000
        let n_places = 1 + rng.below(3.min(n as u64)) as usize;
        let mut seats: Vec<u8> = (0..n as u8).collect();
        for i in (1..seats.len()).rev() {
            seats.swap(i, rng.below(i as u64 + 1) as usize);
        }
        let mut shares: Vec<u16> = (0..n_places).map(|_| 1 + rng.below(9_000) as u16).collect();
        let sum: u32 = shares.iter().map(|s| *s as u32).sum();
        shares = shares.iter().map(|s| ((*s as u32 * 10_000) / sum).max(1) as u16).collect();
        shares.sort_unstable_by(|a, b| b.cmp(a));
        let fix = 10_000i32 - shares.iter().map(|s| *s as i32).sum::<i32>();
        shares[0] = (shares[0] as i32 + fix) as u16;
        let pl: Vec<(u8, u16)> = seats[..n_places].iter().copied().zip(shares.clone()).collect();
        let mut rf: Vec<(u8, u64)> = seats[n_places..]
            .iter()
            .filter(|_| rng.below(2) == 0)
            .map(|s| (*s, 1 + rng.below(ENTRY)))
            .collect();
        rf.sort_unstable();
        let refunded: u64 = rf.iter().map(|r| r.1).sum();
        let pay = plan_payout(ENTRY, n as u8, &shares, refunded, &t, LB).unwrap();
        let started = c
            .settle(&ManySeatResult::Placed {
                places: places(&pl),
                refunds: refunds(&rf),
            })
            .unwrap();
        let steps = 1 + rng.below(12) as u32;
        c.run(&mut w, steps);
        let total: u64 = riders.iter().map(|(who, _)| w.gemas(*who)).sum();
        assert_eq!(total + w.fees().iter().sum::<u64>(), n as u64 * ENTRY, "case {case}");
        if started.kind == KIND_BY_GAME {
            assert!(riders.iter().all(|(who, _)| w.gemas(*who) == ENTRY), "case {case}");
            continue;
        }
        assert_eq!(w.fees(), pay.fees, "case {case}");
        for (seat, (who, _)) in riders.iter().enumerate() {
            let seat = seat as u8;
            let want = if let Some(k) = pl.iter().position(|p| p.0 == seat) {
                ENTRY + pay.won[k]
            } else {
                rf.iter().find(|r| r.0 == seat).map_or(0, |r| r.1)
            };
            assert_eq!(w.gemas(*who), want, "case {case} seat {seat}");
        }
    }
}

use super::*;
use crate::ledger::book::{fp, SourceBook};
use crate::ledger::line_store::{LineStore, CLASS_EXTENSION_BASE, SIDE_OWN, SIDE_WON};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

fn key(n: u8) -> Key {
    [n; 32]
}

const OWNER: u8 = 200;
const GAME: u8 = 77;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

type Books = MemBooks;
type P<'a> = Pool<'a, &'a mut [u8], &'a mut [u8]>;

/// A basket, its spill and the Source books, plus every other place a line can be.
#[derive(Clone)]
struct World {
    basket: Vec<u8>,
    spill: Vec<u8>,
    books: Books,
    gone: Vec<Line>,
    pots: Vec<PotPages>,
    issued: u64,
    /// Spill slots the instruction layer had to grant, and the most it may be asked for.
    grown: usize,
    allowance: usize,
}

fn world(cap: usize) -> World {
    let mut basket = vec![0u8; required_len(cap)];
    LineStore::init(basket.as_mut_slice(), key(OWNER), 1).unwrap();
    let mut books = MemBooks::default();
    for s in 0..5u8 {
        let mut b = SourceBook::new();
        b.start_extension().unwrap();
        books.insert(key(s), b);
    }
    World {
        basket,
        spill: spill_body(key(OWNER), 0).unwrap(),
        books,
        gone: vec![],
        pots: vec![],
        issued: 0,
        grown: 0,
        allowance: 0,
    }
}

impl World {
    /// Run `f` on the pool; on `SpillFull` grant one more spill slot (reserved rent) and retry.
    fn run<R>(&mut self, mut f: impl FnMut(&mut P, &mut Books) -> DrawResult<R>) -> DrawResult<R> {
        loop {
            let r = {
                let mut b = LineStore::new(self.basket.as_mut_slice()).unwrap();
                let mut s = LineStore::new(self.spill.as_mut_slice()).unwrap();
                let mut p = Pool::new(&mut b, &mut s);
                f(&mut p, &mut self.books)
            };
            match r {
                Err(DrawError::SpillFull) => {
                    let cap = LineStore::new(self.spill.as_slice()).unwrap().capacity();
                    grow_spill_body(&mut self.spill, cap + 1);
                    self.grown += 1;
                }
                other => return other,
            }
        }
    }
    /// Like `run` but the caller wants the raw result, `SpillFull` included.
    fn run_raw<R>(&mut self, f: impl FnOnce(&mut P, &mut Books) -> DrawResult<R>) -> DrawResult<R> {
        let mut b = LineStore::new(self.basket.as_mut_slice()).unwrap();
        let mut s = LineStore::new(self.spill.as_mut_slice()).unwrap();
        let mut p = Pool::new(&mut b, &mut s);
        f(&mut p, &mut self.books)
    }
    fn b(&self) -> LineStore<&[u8]> {
        LineStore::new(self.basket.as_slice()).unwrap()
    }
    fn s(&self) -> LineStore<&[u8]> {
        LineStore::new(self.spill.as_slice()).unwrap()
    }
    /// Issue `amount` fresh Gemas of Source `src` and credit them like a settle.
    fn credit(&mut self, side: u8, due: i64, src: u8, class: u8, amount: u64) -> Placed {
        let tranche = if class == CLASS_EXTENSION_BASE { 1 } else { 0 };
        let mut line = SourceBook::blank_line(side, due, key(src), class, tranche);
        self.books.issue(&key(src), &mut line, amount).unwrap();
        self.issued += amount;
        self.allowance += spill_slots_for_credit(1);
        self.run(|p, books| p.put(books, &line)).unwrap()
    }
    fn land(&mut self, src: u8, gemas: u64) {
        let cum = self.books[&key(src)].h + fp(gemas);
        self.books.land(&key(src), cum, fp(gemas) >> 32).unwrap();
    }
    fn free(&mut self) -> u64 {
        self.run_raw(|p, _| Ok(p.free())).unwrap()
    }
    fn all_lines(&self) -> Vec<Line> {
        let mut v: Vec<Line> = self.b().lines().collect();
        v.extend(self.s().lines());
        v
    }
    fn amounts(&self) -> Vec<(u8, i64, u8, u8, u64)> {
        let mut v: Vec<_> = self
            .all_lines()
            .iter()
            .map(|l| (l.side, l.due_at, l.source[0], l.class, l.amount))
            .collect();
        v.sort();
        v
    }
    fn check(&self, extra: &[Line]) {
        self.b().check().unwrap();
        self.s().check().unwrap();
        let mut by_src: BTreeMap<Key, Vec<Line>> = BTreeMap::new();
        let mut all = self.all_lines();
        all.extend(self.gone.iter().copied());
        all.extend(extra.iter().copied());
        for p in &self.pots {
            p.check().unwrap();
            all.extend(p.lines());
        }
        for l in all {
            by_src.entry(l.source).or_default().push(l);
        }
        for (k, lines) in by_src {
            self.books[&k].check(0, lines.iter()).unwrap();
        }
    }
}

fn pot_amounts(p: &PotPages) -> Vec<(u8, i64, u8, u8, u64)> {
    p.lines()
        .into_iter()
        .map(|l| (l.side, l.due_at, l.source[0], l.class, l.amount))
        .collect()
}

#[test]
fn draw_takes_own_first_then_won_by_earliest_due_and_skips_fee_lines() {
    let mut w = world(16);
    w.credit(SIDE_WON, 5, 1, CLASS_GENERAL, 100);
    w.credit(SIDE_WON, 2, 2, CLASS_GENERAL, 100);
    w.credit(SIDE_OWN, 9, 3, CLASS_GENERAL, 100);
    w.credit(SIDE_OWN, 1, 4, 1, 50); // Studio fee line: never drawn
    let pot = w
        .run(|p, books| p.draw_direct(books, key(OWNER), 250, 12))
        .unwrap();
    assert_eq!(
        pot_amounts(&pot),
        vec![
            (SIDE_OWN, 9, 3, 3, 100),
            (SIDE_WON, 2, 2, 3, 100),
            (SIDE_WON, 5, 1, 3, 50)
        ]
    );
    assert_eq!(w.b().fee_total(), 50);
    w.pots.push(pot);
    w.check(&[]);
}

#[test]
fn the_reservation_is_held_by_the_slowest_lines_and_an_entry_never_touches_it() {
    let mut w = world(16);
    w.credit(SIDE_OWN, 1, 1, CLASS_GENERAL, 500);
    w.credit(SIDE_WON, 3, 2, CLASS_GENERAL, 500);
    w.run(|p, _| p.reserve_offer(500, 0)).unwrap();
    assert_eq!(w.free(), 500);
    assert_eq!(
        w.run(|p, books| p.draw_direct(books, key(OWNER), 501, 12))
            .unwrap_err(),
        DrawError::InsufficientGemas
    );
    let pot = w
        .run(|p, books| p.draw_direct(books, key(OWNER), 500, 12))
        .unwrap();
    assert_eq!(pot_amounts(&pot), vec![(SIDE_OWN, 1, 1, 3, 500)]);
    assert_eq!(w.b().get(0).unwrap().amount, 500);
    assert_eq!(w.b().reserved_total(), 500);
    w.pots.push(pot);
    w.check(&[]);
}

#[test]
fn a_split_line_moves_ready_proportionally() {
    let mut w = world(8);
    w.credit(SIDE_OWN, 1, 1, CLASS_GENERAL, 1000);
    w.land(1, 400);
    let pot = w
        .run(|p, books| p.draw_direct(books, key(OWNER), 250, 12))
        .unwrap();
    let book = &w.books[&key(1)];
    let part = pot.lines()[0];
    let rest = w.b().get(0).unwrap();
    assert_eq!(part.amount + rest.amount, 1000);
    assert_eq!(
        book.ready_of(&part).unwrap() / 250,
        book.ready_of(&rest).unwrap() / 750
    );
    w.pots.push(pot);
    w.check(&[]);
}

#[test]
fn a_draw_over_the_line_cap_needs_a_ticket_and_changes_nothing() {
    let mut w = world(32);
    for i in 0..20 {
        w.credit(SIDE_OWN, i, (i % 5) as u8, CLASS_GENERAL, 10);
    }
    let (b0, s0) = (w.basket.clone(), w.spill.clone());
    assert_eq!(
        w.run(|p, books| p.draw_direct(books, key(OWNER), 150, 12))
            .unwrap_err(),
        DrawError::NeedsTicket
    );
    assert_eq!((w.basket.clone(), w.spill.clone()), (b0, s0));
}

fn open_ticket(w: &mut World, entry: u64) -> Ticket {
    let mut t = w
        .run(|p, _| Ticket::open_entry(p, key(GAME), 1, entry, 1_000))
        .unwrap();
    t.mark_storage_reserved();
    t
}

fn stage_all(w: &mut World, t: &mut Ticket) {
    loop {
        if w.run(|p, books| t.stage(p, books, 12, true)).unwrap().ready {
            break;
        }
    }
}

#[test]
fn a_ticket_stages_in_steps_and_its_pages_become_the_pot() {
    let mut w = world(400);
    for i in 0..300i64 {
        w.credit(
            SIDE_OWN,
            i,
            (i % 5) as u8,
            CLASS_GENERAL,
            1 + (i as u64 % 3),
        );
    }
    let entry = 400;
    let mut t = open_ticket(&mut w, entry);
    assert!(w.b().flags() & FLAG_TICKET_OPEN != 0);
    assert_eq!(w.b().ticket_need(), entry);
    let mut steps = 0;
    loop {
        let s = w.run(|p, books| t.stage(p, books, 12, true)).unwrap();
        steps += 1;
        assert_eq!(w.b().ticket_need(), entry - s.staged);
        if s.ready {
            break;
        }
    }
    assert!(steps > 1);
    w.run(|p, _| t.consume(p, &key(GAME), entry)).unwrap();
    let pot = t.into_pot();
    assert_eq!(w.b().flags(), 0);
    assert_eq!(w.b().ticket_need(), 0);
    assert_eq!(pot.total(), entry);
    w.pots.push(pot);
    w.check(&[]);
}

#[test]
fn staging_needs_storage_reserved_first_and_the_owner_for_an_entry() {
    let mut w = world(16);
    w.credit(SIDE_OWN, 1, 1, CLASS_GENERAL, 100);
    let mut t = w
        .run(|p, _| Ticket::open_entry(p, key(GAME), 1, 50, 1_000))
        .unwrap();
    assert_eq!(
        w.run(|p, books| t.stage(p, books, 12, true)).unwrap_err(),
        DrawError::StorageNotReserved
    );
    t.mark_storage_reserved();
    assert_eq!(
        w.run(|p, books| t.stage(p, books, 12, false)).unwrap_err(),
        DrawError::NotOwner
    );
    assert!(w.run(|p, books| t.stage(p, books, 12, true)).unwrap().ready);
}

#[test]
fn while_an_entry_ticket_is_open_no_other_entry_reservation_or_ticket() {
    let mut w = world(16);
    w.credit(SIDE_OWN, 1, 1, CLASS_GENERAL, 1000);
    let _t = open_ticket(&mut w, 500);
    assert_eq!(
        w.run(|p, books| p.draw_direct(books, key(OWNER), 100, 12))
            .unwrap_err(),
        DrawError::TicketOpen
    );
    assert_eq!(
        w.run(|p, _| Ticket::open_entry(p, key(GAME), 2, 100, 1_000))
            .unwrap_err(),
        DrawError::TicketOpen
    );
    assert_eq!(
        w.run(|p, _| p.reserve_offer(100, 0)).unwrap_err(),
        DrawError::TicketOpen
    );
}

#[test]
fn bypass_stage_fast_then_enter_slow_is_refused_and_restaging_fixes_it() {
    let mut w = world(16);
    w.credit(SIDE_WON, 50, 1, CLASS_GENERAL, 300);
    w.credit(SIDE_WON, 60, 2, CLASS_GENERAL, 300);
    let mut t = open_ticket(&mut w, 300);
    assert!(w.run(|p, books| t.stage(p, books, 12, true)).unwrap().ready);
    w.credit(SIDE_WON, 10, 3, CLASS_GENERAL, 200);
    assert!(w.run_raw(|p, _| Ok(t.faster_waiting(p))).unwrap());
    assert_eq!(
        w.run(|p, _| t.consume(p, &key(GAME), 300)).unwrap_err(),
        DrawError::FasterGemasAvailable
    );
    let s = w.run(|p, books| t.stage(p, books, 12, true)).unwrap();
    assert!(s.ready && s.returned >= 1);
    w.run(|p, _| t.consume(p, &key(GAME), 300)).unwrap();
    let pot = t.into_pot();
    assert_eq!(
        pot_amounts(&pot),
        vec![(SIDE_WON, 10, 3, 3, 200), (SIDE_WON, 50, 1, 3, 100)]
    );
    w.pots.push(pot);
    w.check(&[]);
}

#[test]
fn a_consume_with_a_mismatch_or_an_incomplete_ticket_is_refused() {
    let mut w = world(16);
    w.credit(SIDE_OWN, 1, 1, CLASS_GENERAL, 500);
    let mut t = open_ticket(&mut w, 300);
    assert_eq!(
        w.run(|p, _| t.consume(p, &key(GAME), 300)).unwrap_err(),
        DrawError::NotComplete
    );
    w.run(|p, books| t.stage(p, books, 12, true)).unwrap();
    assert_eq!(
        w.run(|p, _| t.consume(p, &key(9), 300)).unwrap_err(),
        DrawError::Mismatch
    );
    assert_eq!(
        w.run(|p, _| t.consume(p, &key(GAME), 400)).unwrap_err(),
        DrawError::Mismatch
    );
    assert!(w.run(|p, _| t.consume(p, &key(GAME), 300)).is_ok());
    assert_eq!(
        w.run(|p, _| t.consume(p, &key(GAME), 300)).unwrap_err(),
        DrawError::NotOpen
    );
}

#[test]
fn no_double_spend_between_a_ticket_an_offer_and_a_redeem() {
    let mut w = world(16);
    w.credit(SIDE_OWN, 1, 1, CLASS_GENERAL, 1000);
    w.run(|p, _| p.reserve_offer(300, 0)).unwrap();
    let _t = open_ticket(&mut w, 500);
    assert_eq!(w.free(), 200);
    assert_eq!(
        w.run(|p, _| p.check_withdraw(201)).unwrap_err(),
        DrawError::WouldBreakReservation
    );
    assert!(w.run(|p, _| p.check_withdraw(200)).is_ok());
    let mut w2 = world(16);
    w2.credit(SIDE_OWN, 1, 1, CLASS_GENERAL, 1000);
    w2.run(|p, _| p.reserve_offer(600, 0)).unwrap();
    assert_eq!(
        w2.run(|p, _| Ticket::open_entry(p, key(GAME), 1, 500, 1_000))
            .unwrap_err(),
        DrawError::InsufficientGemas
    );
    assert_eq!(
        w2.run(|p, _| p.reserve_offer(401, 1)).unwrap_err(),
        DrawError::InsufficientGemas
    );
    assert_eq!(
        w2.run(|p, _| p.reserve_offer(1, MAX_OPEN_OFFERS))
            .unwrap_err(),
        DrawError::TooManyOffers
    );
    w2.run(|p, _| p.release_offer(600)).unwrap();
    assert_eq!(
        w2.run(|p, _| p.release_offer(1)).unwrap_err(),
        DrawError::ReservationShort
    );
}

#[test]
fn cancel_returns_every_line_exactly_and_clears_the_flag() {
    let mut w = world(64);
    for i in 0..30i64 {
        w.credit(SIDE_OWN, i, (i % 5) as u8, CLASS_GENERAL, 7);
    }
    w.land(1, 3);
    let before = w.amounts();
    let mut t = open_ticket(&mut w, 150);
    stage_all(&mut w, &mut t);
    assert_eq!(
        w.run(|p, _| t.begin_cancel(p, 0, false)).unwrap_err(),
        DrawError::NotExpired
    );
    w.run(|p, _| t.begin_cancel(p, 1_000, false)).unwrap();
    assert_eq!(
        w.run(|p, books| t.stage(p, books, 1, true)).unwrap_err(),
        DrawError::NotOpen
    );
    let mut chunks = 0;
    loop {
        let s = w.run(|p, books| t.cancel_step(p, books, 5)).unwrap();
        chunks += 1;
        if s.done {
            break;
        }
    }
    assert!(chunks > 1);
    assert!(w.run(|p, books| t.cancel_step(p, books, 5)).unwrap().done);
    assert_eq!(w.b().flags(), 0);
    assert_eq!(w.amounts(), before);
    w.check(&[]);
}

// --- the three gaps of ticket 04b ---------------------------------------------------------------

#[test]
fn gaps_1_a_player_with_gemas_only_in_the_spill_enters_without_claiming() {
    let mut w = world(3);
    for i in 0..3 {
        w.credit(SIDE_OWN, i, 0, CLASS_GENERAL, 10);
    }
    // the basket is full; these settlements land in the spill
    assert_eq!(w.credit(SIDE_WON, 5, 1, CLASS_GENERAL, 500), Placed::Spill);
    assert_eq!(w.credit(SIDE_WON, 6, 2, CLASS_GENERAL, 500), Placed::Spill);
    // spend the basket's own Gemas elsewhere: only the spill is left
    let pot = w
        .run(|p, books| p.draw_direct(books, key(OWNER), 30, 12))
        .unwrap();
    w.pots.push(pot);
    assert_eq!(w.b().len(), 0);
    assert_eq!(w.free(), 1000);
    // direct and through a Ticket, in the merged order (won due 5 before due 6)
    let pot = w
        .run(|p, books| p.draw_direct(books, key(OWNER), 600, 12))
        .unwrap();
    assert_eq!(
        pot_amounts(&pot),
        vec![(SIDE_WON, 5, 1, 3, 500), (SIDE_WON, 6, 2, 3, 100)]
    );
    w.pots.push(pot);
    let mut t = open_ticket(&mut w, 400);
    stage_all(&mut w, &mut t);
    w.run(|p, _| t.consume(p, &key(GAME), 400)).unwrap();
    let pot = t.into_pot();
    assert_eq!(pot.total(), 400);
    w.pots.push(pot);
    w.check(&[]);
}

#[test]
fn gaps_1_cancel_and_refund_into_a_full_basket_use_the_spill_and_stay_free() {
    let mut w = world(10);
    for i in 0..10i64 {
        w.credit(SIDE_OWN, i, (i % 5) as u8, CLASS_GENERAL, 10);
    }
    let mut t = open_ticket(&mut w, 50);
    stage_all(&mut w, &mut t);
    // the freed slots fill with new Gemas of other keys
    for i in 100..105i64 {
        w.credit(SIDE_OWN, i, 0, CLASS_GENERAL, 3);
    }
    assert_eq!(w.b().len(), 10);
    w.run(|p, _| t.begin_cancel(p, 0, true)).unwrap();
    let s = w.run(|p, books| t.cancel_step(p, books, 100)).unwrap();
    assert!(s.done);
    assert_eq!(w.s().len(), 5);
    // everything is free at once: 50 back + 15 + 50 other
    assert_eq!(w.free(), 50 + 15 + 50);
    assert!(w.grown <= w.allowance + t.storage_lines());
    w.check(&[]);
    // and claiming is only tidying up
    let moved = w.run(|p, books| p.claim(books, 100)).unwrap();
    assert_eq!(moved, 0);
}

#[test]
fn gaps_2_restage_after_faster_gemas_refilled_a_full_basket_never_strands() {
    let mut w = world(4);
    for (i, due) in [50i64, 60, 70, 80].iter().enumerate() {
        w.credit(SIDE_WON, *due, i as u8, CLASS_GENERAL, 100);
    }
    let mut t = open_ticket(&mut w, 200);
    assert!(w.run(|p, books| t.stage(p, books, 12, true)).unwrap().ready);
    // two freed slots fill with faster Gemas of new keys, then more arrive in the spill
    for (i, due) in [1i64, 2, 3].iter().enumerate() {
        w.credit(SIDE_WON, *due, i as u8, CLASS_GENERAL, 100);
    }
    assert_eq!(w.b().len(), 4);
    assert!(!w.s().is_empty());
    loop {
        match w.run(|p, books| t.stage(p, books, 12, true)) {
            Ok(s) if s.ready => break,
            Ok(_) => {}
            Err(e) => panic!("{e:?}"),
        }
    }
    w.run(|p, _| t.consume(p, &key(GAME), 200)).unwrap();
    let pot = t.into_pot();
    assert_eq!(
        pot_amounts(&pot),
        vec![(SIDE_WON, 1, 0, 3, 100), (SIDE_WON, 2, 1, 3, 100)]
    );
    w.pots.push(pot);
    w.check(&[]);
}

#[test]
fn gaps_3_a_backing_ticket_never_blocks_the_backers_own_entries() {
    let mut w = world(64);
    for i in 0..30i64 {
        w.credit(SIDE_OWN, i, (i % 5) as u8, CLASS_GENERAL, 10);
    }
    w.run(|p, _| p.reserve_offer(100, 0)).unwrap();
    let mut back = w
        .run(|p, _| Ticket::open_backing(p, key(GAME), 1, 100, 1_000))
        .unwrap();
    back.mark_storage_reserved();
    // a stranger stages part of it
    w.run(|p, books| back.stage(p, books, 3, false)).unwrap();
    assert_eq!(w.b().flags() & FLAG_TICKET_OPEN, 0);
    // the Backer enters directly and through an Entry Ticket, meanwhile
    let pot = w
        .run(|p, books| p.draw_direct(books, key(OWNER), 40, 12))
        .unwrap();
    w.pots.push(pot);
    let mut t = open_ticket(&mut w, 100);
    stage_all(&mut w, &mut t);
    w.run(|p, _| t.consume(p, &key(GAME), 100)).unwrap();
    let pot = t.into_pot();
    w.pots.push(pot);
    // no second Backing Ticket, no new Offer while it is open
    assert_eq!(
        w.run(|p, _| Ticket::open_backing(p, key(GAME), 2, 10, 1_000))
            .unwrap_err(),
        DrawError::TicketOpen
    );
    assert_eq!(
        w.run(|p, _| p.reserve_offer(10, 1)).unwrap_err(),
        DrawError::TicketOpen
    );
    // a stranger cannot cancel it early; the Backer can at once
    assert_eq!(
        w.run(|p, _| back.begin_cancel(p, 0, false)).unwrap_err(),
        DrawError::NotExpired
    );
    w.run(|p, _| back.begin_cancel(p, 0, true)).unwrap();
    while !w
        .run(|p, books| back.cancel_step(p, books, 4))
        .unwrap()
        .done
    {}
    assert_eq!(w.b().flags(), 0);
    assert_eq!(w.b().reserved_total(), 100);
    w.run(|p, _| p.reserve_offer(10, 1)).unwrap();
    w.check(&[]);
}

#[test]
fn backing_ticket_cancel_restores_the_reservation_then_draws_directly() {
    let mut w = world(64);
    for i in 0..30i64 {
        w.credit(SIDE_OWN, i, (i % 5) as u8, CLASS_GENERAL, 10);
    }
    w.run(|p, _| p.reserve_offer(200, 0)).unwrap();
    w.run(|p, _| p.reserve_offer(50, 1)).unwrap();
    let mut t = w
        .run(|p, _| Ticket::open_backing(p, key(GAME), 1, 200, 1_000))
        .unwrap();
    t.mark_storage_reserved();
    w.run(|p, books| t.stage(p, books, 5, false)).unwrap();
    assert!(w.b().reserved_total() < 250);
    assert_eq!(w.b().ticket_need(), 0);
    w.run(|p, _| t.begin_cancel(p, 0, true)).unwrap();
    while !w.run(|p, books| t.cancel_step(p, books, 4)).unwrap().done {}
    assert_eq!(w.b().reserved_total(), 250);
    let pot = w
        .run(|p, books| p.draw_backing_direct(books, key(OWNER), 50, 12))
        .unwrap();
    assert_eq!(pot.total(), 50);
    assert_eq!(w.b().reserved_total(), 200);
    assert_eq!(
        w.run(|p, books| p.draw_backing_direct(books, key(OWNER), 201, 12))
            .unwrap_err(),
        DrawError::ReservationShort
    );
    w.pots.push(pot);
    w.check(&[]);
}

#[test]
fn spill_full_changes_nothing_and_names_the_room_needed() {
    let mut w = world(1);
    w.credit(SIDE_OWN, 1, 0, CLASS_GENERAL, 10);
    let mut line = SourceBook::blank_line(SIDE_OWN, 2, key(1), CLASS_GENERAL, 0);
    w.books.issue(&key(1), &mut line, 5).unwrap();
    w.issued += 5;
    let (b0, s0) = (w.basket.clone(), w.spill.clone());
    assert_eq!(
        w.run_raw(|p, books| p.put(books, &line)).unwrap_err(),
        DrawError::SpillFull
    );
    assert_eq!((w.basket.clone(), w.spill.clone()), (b0, s0));
    w.run(|p, books| p.put(books, &line)).unwrap();
    assert_eq!(w.grown, 1);
}

// ---------------------------------------------------------------------------------------------
// Fuzz against an independent model
// ---------------------------------------------------------------------------------------------

static COV: [AtomicUsize; 9] = [const { AtomicUsize::new(0) }; 9];
const C_TICKET: usize = 0;
const C_RESTAGE: usize = 1;
const C_SPILL: usize = 2;
const C_BACKING_TICKET: usize = 3;
const C_REFUSED_FASTER: usize = 4;
const C_CLAIM: usize = 5;
const C_ENTER_DURING_BACKING: usize = 6;
const C_ENTER_WITH_SPILL: usize = 7;
const C_CREDIT_DURING_TICKET_FULL: usize = 8;

type Union = BTreeMap<LineKey, u64>;

/// The model's draw: the first `amount` playable Gemas of the order.
fn canonical(union: &Union, amount: u64) -> BTreeMap<LineKey, u64> {
    let mut out = BTreeMap::new();
    let mut left = amount;
    for (k, &a) in union {
        if k.class < CLASS_GENERAL || a == 0 {
            continue;
        }
        let t = a.min(left);
        if t > 0 {
            out.insert(*k, t);
        }
        left -= t;
        if left == 0 {
            break;
        }
    }
    assert_eq!(left, 0, "model asked for more than exists");
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Slot {
    Entry,
    Backing,
}

#[derive(Clone)]
struct Sim {
    w: World,
    rng: Rng,
    cap: usize,
    ent: Option<Ticket>,
    bk: Option<Ticket>,
    /// Model: every Gema of the Player that is not out: basket, spill, both Tickets.
    union: Union,
    offers: Vec<u64>,
    /// Amount of the Offer under an open Backing Ticket (its reservation travels with it).
    backing: u64,
    now: i64,
    max_lines: usize,
}

impl Clone for Rng {
    fn clone(&self) -> Rng {
        Rng(self.0)
    }
}

fn mk_key(l: &Line) -> LineKey {
    l.key()
}

impl Sim {
    fn new(seed: u64) -> Sim {
        let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
        let cap = [3, 6, 12, 40, 400][rng.below(5) as usize];
        let max_lines = 1 + rng.below(5) as usize;
        Sim {
            w: world(cap),
            rng,
            cap,
            ent: None,
            bk: None,
            union: BTreeMap::new(),
            offers: vec![],
            backing: 0,
            now: 0,
            max_lines,
        }
    }

    fn slot(&mut self, s: Slot) -> &mut Option<Ticket> {
        match s {
            Slot::Entry => &mut self.ent,
            Slot::Backing => &mut self.bk,
        }
    }
    fn staged_e(&self) -> u64 {
        self.ent.as_ref().map_or(0, |t| t.staged())
    }
    fn staged_b(&self) -> u64 {
        self.bk.as_ref().map_or(0, |t| t.staged())
    }
    fn reserved(&self) -> u64 {
        self.offers.iter().sum::<u64>() + self.backing - self.staged_b()
    }
    fn playable_union(&self) -> u64 {
        self.union
            .iter()
            .filter(|(k, _)| k.class >= CLASS_GENERAL)
            .map(|(_, a)| a)
            .sum()
    }
    fn need(&self) -> u64 {
        match &self.ent {
            Some(t) if t.state == TicketState::Open => t.target - t.staged(),
            _ => 0,
        }
    }
    fn model_free(&self) -> u64 {
        (self.playable_union() - self.staged_e() - self.staged_b()) - self.reserved() - self.need()
    }
    /// Basket and spill summed by key.
    fn pool_union(&self) -> Union {
        let mut u = BTreeMap::new();
        for l in self.w.all_lines() {
            *u.entry(mk_key(&l)).or_default() += l.amount;
        }
        u
    }
    fn open(t: &Option<Ticket>) -> bool {
        t.as_ref()
            .is_some_and(|t| matches!(t.state, TicketState::Open | TicketState::Cancelling))
    }

    fn invariants(&mut self) {
        self.w.b().check().unwrap();
        self.w.s().check().unwrap();
        let mut real = self.pool_union();
        for t in [&self.ent, &self.bk].into_iter().flatten() {
            t.pages.check().unwrap();
            for l in t.pages.lines() {
                *real.entry(mk_key(&l)).or_default() += l.amount;
            }
        }
        assert_eq!(real, self.union, "pool + tickets != model");
        let b = self.w.b();
        assert_eq!(b.reserved_total(), self.reserved());
        assert_eq!(b.ticket_need(), self.need());
        assert_eq!(b.flags() & FLAG_TICKET_OPEN != 0, Self::open(&self.ent));
        assert_eq!(b.flags() & FLAG_BACKING_OPEN != 0, Self::open(&self.bk));
        let pool_playable = self.playable_union() - self.staged_e() - self.staged_b();
        assert!(pool_playable >= b.reserved_total() + b.ticket_need());
        let mut sum: u64 = self.w.all_lines().iter().map(|l| l.amount).sum();
        sum += self.staged_e() + self.staged_b();
        sum += self.w.pots.iter().map(|p| p.total()).sum::<u64>();
        sum += self.w.gone.iter().map(|l| l.amount).sum::<u64>();
        assert_eq!(sum, self.w.issued, "a Gema was created or lost");
        assert!(
            self.w.grown <= self.w.allowance,
            "the spill needed more slots ({}) than were reserved ({})",
            self.w.grown,
            self.w.allowance
        );
    }

    fn op_credit(&mut self) {
        let side = self.rng.below(2) as u8;
        let due = self.rng.below(8) as i64;
        let src = self.rng.below(5) as u8;
        let class = [0u8, 1, 2, 3, 3, 3, 3, 4][self.rng.below(8) as usize];
        let amount = [1u64, 1, 2, 3, 5, 20, 60][self.rng.below(7) as usize];
        let tranche = if class == CLASS_EXTENSION_BASE { 1 } else { 0 };
        let k = LineKey {
            side,
            due_at: due,
            source: key(src),
            class,
            tranche,
        };
        let full = self.w.b().len() >= self.cap;
        if full && (Self::open(&self.ent) || Self::open(&self.bk)) {
            COV[C_CREDIT_DURING_TICKET_FULL].fetch_add(1, Relaxed);
        }
        let placed = self.w.credit(side, due, src, class, amount);
        if placed == Placed::Spill {
            COV[C_SPILL].fetch_add(1, Relaxed);
        }
        *self.union.entry(k).or_default() += amount;
    }

    fn sub_union(&mut self, k: &LineKey, a: u64) {
        let e = self.union.get_mut(k).unwrap();
        *e -= a;
        if *e == 0 {
            self.union.remove(k);
        }
    }

    fn op_withdraw(&mut self) {
        let free = self.model_free();
        assert_eq!(
            self.w.run(|p, _| p.check_withdraw(free + 1)).unwrap_err(),
            DrawError::WouldBreakReservation
        );
        let lines: Vec<(bool, Line)> = self
            .w
            .b()
            .lines()
            .map(|l| (true, l))
            .chain(self.w.s().lines().map(|l| (false, l)))
            .filter(|(_, l)| l.class >= CLASS_GENERAL)
            .collect();
        if lines.is_empty() || free == 0 {
            return;
        }
        let (in_basket, line) = lines[self.rng.below(lines.len() as u64) as usize];
        let k = 1 + self.rng.below(line.amount.min(free));
        let out = self
            .w
            .run_raw(|p, books| {
                p.check_withdraw(k)?;
                let mut rest = line;
                let mut out = SourceBook::blank_line(
                    line.side,
                    line.due_at,
                    line.source,
                    line.class,
                    line.tranche,
                );
                let (book, history) = books.book_with_history(&line.source)?;
                book.transfer(&mut rest, &mut out, k, &*history)?;
                if in_basket {
                    let idx = p.basket.find(&line.key()).unwrap();
                    if rest.amount == 0 {
                        p.basket.remove_at(idx)?;
                    } else {
                        p.basket.set_line(idx, &rest)?;
                    }
                } else {
                    let idx = p.spill.find(&line.key()).unwrap();
                    if rest.amount == 0 {
                        p.spill.remove_at(idx)?;
                    } else {
                        p.spill.set_line(idx, &rest)?;
                    }
                }
                Ok(out)
            })
            .unwrap();
        self.w.gone.push(out);
        self.sub_union(&line.key(), k);
    }

    fn op_reserve(&mut self) {
        let amount = 1 + self.rng.below(300);
        let expect_ok = !Self::open(&self.ent)
            && !Self::open(&self.bk)
            && (self.offers.len() as u32) < MAX_OPEN_OFFERS
            && amount <= self.model_free();
        let n = self.offers.len() as u32;
        let r = self.w.run(|p, _| p.reserve_offer(amount, n));
        assert_eq!(r.is_ok(), expect_ok, "{r:?} amount {amount}");
        if expect_ok {
            self.offers.push(amount);
        }
    }

    fn op_release(&mut self) {
        if self.offers.is_empty() {
            return;
        }
        let i = self.rng.below(self.offers.len() as u64) as usize;
        let a = self.offers.remove(i);
        self.w.run(|p, _| p.release_offer(a)).unwrap();
    }

    fn take_pot(&mut self, pot: &PotPages, amount: u64, before: &Union) {
        let want = canonical(before, amount);
        let got: BTreeMap<LineKey, u64> =
            pot.lines().iter().map(|l| (mk_key(l), l.amount)).collect();
        assert_eq!(got, want, "the draw did not follow the program's order");
        for (k, a) in &got {
            self.sub_union(k, *a);
        }
    }

    fn model_pool_union(&self) -> Union {
        // the model's view of what the order is made of: everything not staged
        self.union.clone()
    }

    fn op_enter(&mut self) {
        let ml = self.max_lines;
        let entry = [10u64, 30, 80, 200][self.rng.below(4) as usize];
        let free = self.model_free();
        let before = self.model_pool_union();
        if Self::open(&self.ent) {
            assert_eq!(
                self.w
                    .run(|p, books| p.draw_direct(books, key(OWNER), entry, ml))
                    .unwrap_err(),
                DrawError::TicketOpen
            );
            return;
        }
        if Self::open(&self.bk) {
            COV[C_ENTER_DURING_BACKING].fetch_add(1, Relaxed);
        }
        if !self.w.s().is_empty() {
            COV[C_ENTER_WITH_SPILL].fetch_add(1, Relaxed);
        }
        // the union includes staged Backing lines; the order of the pool excludes them, but the
        // Backing Ticket's lines are all sorted before whatever the pool still holds only if the
        // Ticket pulled them first, so the canonical draw is taken over the pool alone
        let pool = self.pool_union();
        let _ = before;
        match self
            .w
            .run(|p, books| p.draw_direct(books, key(OWNER), entry, ml))
        {
            Ok(pot) => {
                assert!(entry <= free);
                self.take_pot(&pot, entry, &pool);
                self.w.pots.push(pot);
            }
            Err(DrawError::InsufficientGemas) => {
                assert!(
                    entry > free,
                    "a Player whose free Gemas cover the entry was refused"
                );
            }
            Err(DrawError::NeedsTicket) => {
                assert!(entry <= free);
                let mut t = self
                    .w
                    .run(|p, _| {
                        Ticket::open_entry(p, key(GAME), self.now as u64, entry, self.now + 500)
                    })
                    .expect("a covered entry always opens a Ticket");
                t.mark_storage_reserved();
                self.w.allowance += t.storage_lines();
                COV[C_TICKET].fetch_add(1, Relaxed);
                self.ent = Some(t);
            }
            Err(e) => panic!("{e:?}"),
        }
    }

    fn op_open_backing(&mut self) {
        let ml = self.max_lines;
        if self.offers.is_empty() {
            return;
        }
        let i = self.rng.below(self.offers.len() as u64) as usize;
        let a = self.offers[i];
        let pool = self.pool_union();
        if Self::open(&self.bk) {
            assert_eq!(
                self.w
                    .run(|p, books| p.draw_backing_direct(books, key(OWNER), a, ml))
                    .unwrap_err(),
                DrawError::TicketOpen
            );
            return;
        }
        match self
            .w
            .run(|p, books| p.draw_backing_direct(books, key(OWNER), a, ml))
        {
            Ok(pot) => {
                self.offers.remove(i);
                self.take_pot(&pot, a, &pool);
                self.w.pots.push(pot);
            }
            Err(DrawError::NeedsTicket) => {
                let mut t = self
                    .w
                    .run(|p, _| {
                        Ticket::open_backing(p, key(GAME), self.now as u64, a, self.now + 500)
                    })
                    .unwrap();
                t.mark_storage_reserved();
                self.w.allowance += t.storage_lines();
                self.offers.remove(i);
                self.bk = Some(t);
                self.backing = a;
                COV[C_BACKING_TICKET].fetch_add(1, Relaxed);
            }
            Err(e) => panic!("{e:?}"),
        }
    }

    /// Stage a few steps of a slot's Ticket. Returns true when it is ready.
    fn op_stage(&mut self, slot: Slot, max_ops: usize) -> bool {
        let Some(mut t) = self.slot(slot).take() else {
            return false;
        };
        if t.state != TicketState::Open {
            *self.slot(slot) = Some(t);
            return false;
        }
        let owner = slot == Slot::Entry || self.rng.below(2) == 0;
        let ready;
        loop {
            match self.w.run(|p, books| t.stage(p, books, max_ops, owner)) {
                Ok(s) => {
                    if s.returned > 0 {
                        COV[C_RESTAGE].fetch_add(1, Relaxed);
                    }
                    ready = s.ready;
                    break;
                }
                Err(DrawError::TicketStorageFull) => {
                    t.grow_storage(4);
                    self.w.allowance += 4;
                }
                Err(e) => panic!("stage failed for a covered entry: {e:?}"),
            }
        }
        *self.slot(slot) = Some(t);
        ready
    }

    fn model_faster(&self, t: &Ticket) -> bool {
        let Some(last) = t.pages.last_line() else {
            return false;
        };
        let pool = self.pool_union();
        let total: u64 = pool
            .iter()
            .filter(|(k, _)| k.class >= CLASS_GENERAL)
            .map(|(_, a)| a)
            .sum();
        let hold = match t.kind {
            TicketKind::Entry => self.reserved(),
            TicketKind::Backing => self.reserved() - t.reserved_left,
        };
        if total <= hold {
            return false;
        }
        pool.iter()
            .find(|(k, a)| k.class >= CLASS_GENERAL && **a > 0)
            .is_some_and(|(k, _)| *k < last.key())
    }

    fn op_consume(&mut self, slot: Slot) {
        let Some(t0) = (match slot {
            Slot::Entry => self.ent.as_ref(),
            Slot::Backing => self.bk.as_ref(),
        }) else {
            return;
        };
        if t0.state != TicketState::Open {
            return;
        }
        let expect_ok = t0.staged() == t0.target && !self.model_faster(t0);
        let mut t = self.slot(slot).take().unwrap();
        // the order this Ticket followed: the pool plus its own pages (the other Ticket's lines
        // were drawn earlier and are gone from the order)
        let mut before = self.pool_union();
        for l in t.pages.lines() {
            *before.entry(mk_key(&l)).or_default() += l.amount;
        }
        let target = t.target;
        let kind = t.kind;
        let r = self
            .w
            .run(|p, _| t.consume(p, &key(GAME), target))
            .map(|()| t.clone().into_pot());
        if r.as_ref().err() == Some(&DrawError::FasterGemasAvailable) {
            COV[C_REFUSED_FASTER].fetch_add(1, Relaxed);
        }
        assert_eq!(r.is_ok(), expect_ok, "{:?}", r.as_ref().err());
        match r {
            Ok(pot) => {
                if kind == TicketKind::Backing {
                    self.backing = 0;
                }
                let want = canonical(&before, target);
                let got: BTreeMap<LineKey, u64> =
                    pot.lines().iter().map(|l| (mk_key(l), l.amount)).collect();
                assert_eq!(got, want, "Ticket order differs from the program's order");
                for (k, a) in &got {
                    self.sub_union(k, *a);
                }
                self.w.pots.push(pot);
            }
            Err(_) => *self.slot(slot) = Some(t),
        }
    }

    fn op_cancel(&mut self, slot: Slot) {
        if !Self::open(match slot {
            Slot::Entry => &self.ent,
            Slot::Backing => &self.bk,
        }) {
            return;
        }
        {
            let now = self.now;
            let by_owner = self.rng.below(2) == 0;
            let mut t = self.slot(slot).take().unwrap();
            if t.state == TicketState::Open {
                if slot == Slot::Backing && !by_owner {
                    // a stranger cannot cancel before the deadline
                    if now < t.expires_at {
                        assert_eq!(
                            self.w
                                .run(|p, _| t.begin_cancel(p, now, false))
                                .unwrap_err(),
                            DrawError::NotExpired
                        );
                    }
                    self.now += 1_000;
                    let n = self.now;
                    self.w.run(|p, _| t.begin_cancel(p, n, false)).unwrap();
                } else if by_owner {
                    self.w.run(|p, _| t.begin_cancel(p, now, true)).unwrap();
                } else {
                    self.now += 1_000;
                    let n = self.now;
                    self.w.run(|p, _| t.begin_cancel(p, n, false)).unwrap();
                }
            }
            *self.slot(slot) = Some(t);
        }
        self.invariants();
        loop {
            let max = 1 + self.rng.below(5) as usize;
            let mut t = self.slot(slot).take().unwrap();
            let s = self.w.run(|p, books| t.cancel_step(p, books, max)).unwrap();
            let done = s.done;
            *self.slot(slot) = Some(t);
            self.invariants();
            if done {
                break;
            }
            if self.rng.below(3) == 0 {
                self.op_credit();
                self.invariants();
            }
        }
        if slot == Slot::Backing {
            // the whole reservation is back: the Offer is whole again
            let a = self.backing;
            self.backing = 0;
            self.offers.push(a);
        }
        *self.slot(slot) = None;
        self.invariants();
    }

    fn op_claim(&mut self) {
        let before = self.w.s().len();
        let max = 1 + self.rng.below(6) as usize;
        self.w.run(|p, books| p.claim(books, max)).unwrap();
        if before > 0 {
            COV[C_CLAIM].fetch_add(1, Relaxed);
        }
    }

    fn op_land(&mut self) {
        let src = self.rng.below(5) as u8;
        let g = 1 + self.rng.below(60);
        self.w.land(src, g);
    }

    fn step(&mut self) {
        match self.rng.below(100) {
            0..=27 => self.op_credit(),
            28..=34 => self.op_withdraw(),
            35..=39 => self.op_reserve(),
            40..=43 => self.op_release(),
            44..=52 => self.op_enter(),
            53..=57 => self.op_open_backing(),
            58..=66 => {
                let n = 1 + self.rng.below(5) as usize;
                self.op_stage(Slot::Entry, n);
            }
            67..=72 => {
                let n = 1 + self.rng.below(5) as usize;
                self.op_stage(Slot::Backing, n);
            }
            73..=79 => self.op_consume(Slot::Entry),
            80..=83 => self.op_consume(Slot::Backing),
            84..=88 => self.op_cancel(Slot::Entry),
            89..=91 => self.op_cancel(Slot::Backing),
            92..=94 => self.op_claim(),
            _ => self.op_land(),
        }
        self.invariants();
    }

    /// The founder's requirement, checked on a copy after every operation and with nothing
    /// cancelled first: whoever's free Gemas cover an entry completes it (an open Entry Ticket
    /// completes), whatever the basket, spill, Offers and Backing Tickets look like.
    fn assert_can_always_enter(&self) {
        let mut c = self.clone();
        if Self::open(&c.ent) && c.ent.as_ref().unwrap().state == TicketState::Open {
            c.finish_entry_ticket();
            c.invariants();
        }
        if Self::open(&c.ent) {
            return; // cancelling: the Player waits for the chunks, then enters
        }
        for entry in [10u64, 30, 80, 200] {
            if entry > c.model_free() {
                continue;
            }
            let ml = c.max_lines;
            let pool = c.pool_union();
            let r =
                c.w.run(|p, books| p.draw_direct(books, key(OWNER), entry, ml));
            match r {
                Ok(pot) => {
                    c.take_pot(&pot, entry, &pool);
                    c.w.pots.push(pot);
                }
                Err(DrawError::NeedsTicket) => {
                    let mut t =
                        c.w.run(|p, _| Ticket::open_entry(p, key(GAME), 9, entry, 9))
                            .unwrap();
                    t.mark_storage_reserved();
                    c.w.allowance += t.storage_lines();
                    c.ent = Some(t);
                    c.finish_entry_ticket();
                }
                Err(e) => panic!("covered entry {entry} refused: {e:?}"),
            }
            c.invariants();
        }
    }

    fn finish_entry_ticket(&mut self) {
        let mut guard = 0;
        while !self.op_stage(Slot::Entry, MAX_DRAW_LINES) {
            guard += 1;
            assert!(guard < 5_000, "staging does not converge");
        }
        self.op_consume(Slot::Entry);
        assert!(self.ent.is_none(), "a covered entry could not be consumed");
    }

    fn final_check(&mut self) {
        let extra: Vec<Line> = [&self.ent, &self.bk]
            .into_iter()
            .flatten()
            .flat_map(|t| t.pages.lines())
            .collect();
        self.w.check(&extra);
    }
}

fn run(seed: u64, ops: usize) {
    let mut s = Sim::new(seed);
    for _ in 0..ops {
        s.step();
        s.assert_can_always_enter();
    }
    s.final_check();
}

fn seeds() -> u64 {
    std::env::var("DRAW_FUZZ_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300)
}

#[test]
fn fuzz_draw_tickets_offers_against_a_model() {
    for seed in 1..=seeds() {
        run(seed, 200);
    }
    let c: Vec<usize> = COV.iter().map(|c| c.load(Relaxed)).collect();
    eprintln!(
        "coverage [ticket, restage, spill credit, backing ticket, refused faster, claim, enter during backing, enter with spill, credit during ticket in full basket]: {c:?}"
    );
    for (i, n) in c.iter().enumerate() {
        assert!(*n > 0, "the fuzz never reached case {i}: {c:?}");
    }
}

// --- ticket 09b: holds ---------------------------------------------------------------------------

/// A world whose basket holds `n` own lines of 10 Gemas, due 0..n, with no room to spare, and a
/// spill of `spill_cap` slots.
fn full_world(n: usize, spill_cap: usize) -> World {
    let mut w = world(n);
    grow_spill_body(&mut w.spill, spill_cap);
    for i in 0..n as i64 {
        w.credit(SIDE_OWN, i, (i % 5) as u8, CLASS_GENERAL, 10);
    }
    assert_eq!(w.b().len(), n);
    w
}

fn other_line(w: &mut World, due: i64) -> Line {
    let mut line = SourceBook::blank_line(SIDE_WON, due, key(4), CLASS_GENERAL, 0);
    w.books.issue(&key(4), &mut line, 7).unwrap();
    w.issued += 7;
    line
}

#[test]
fn a_whole_line_an_entry_takes_frees_a_slot_and_a_split_frees_none() {
    let mut w = full_world(4, 0);
    let (pot, freed) = w
        .run_raw(|p, books| {
            let pot = p.draw_direct(books, key(OWNER), 25, 12)?;
            Ok((pot, p.freed()))
        })
        .unwrap();
    // 10 + 10 whole, 5 split off the third
    assert_eq!(pot.len(), 3);
    assert_eq!(freed, 2);
    w.pots.push(pot);
    w.check(&[]);
}

#[test]
fn a_hold_keeps_the_freed_slot_for_the_lines_that_come_back() {
    let mut w = full_world(4, 0);
    let pot = w
        .run_raw(|p, books| p.draw_direct(books, key(OWNER), 20, 12))
        .unwrap();
    // the instruction layer turns the two freed slots into a hold on the spill header
    LineStore::new(w.spill.as_mut_slice())
        .unwrap()
        .set_room_reserved(2);
    // other credits cannot take them
    let other = other_line(&mut w, 50);
    assert_eq!(
        w.run_raw(|p, books| p.put(books, &other)).unwrap_err(),
        DrawError::SpillFull
    );
    // the entry's own lines can, and each one pays the hold down
    for line in pot.lines() {
        w.run_raw(|p, books| {
            let held = p.spill.room_reserved();
            p.set_hold(held);
            p.put(books, &line)?;
            Ok(())
        })
        .unwrap();
    }
    assert_eq!(w.s().room_reserved(), 0);
    w.check(&[]);
}

#[test]
fn a_put_with_a_hold_pays_the_hold_and_the_header_down() {
    let mut w = full_world(4, 0);
    let pot = w
        .run_raw(|p, books| p.draw_direct(books, key(OWNER), 10, 12))
        .unwrap();
    LineStore::new(w.spill.as_mut_slice())
        .unwrap()
        .set_room_reserved(1);
    let line = pot.lines()[0];
    let left = w
        .run_raw(|p, books| {
            p.set_hold(1);
            p.put(books, &line)?;
            Ok((p.hold_left(), p.used()))
        })
        .unwrap();
    assert_eq!(left, (0, 1));
    assert_eq!(w.s().room_reserved(), 0);
    assert_eq!(w.b().len(), 4);
}

#[test]
fn credits_beyond_the_holds_still_land_while_there_is_free_room() {
    let mut w = full_world(4, 3);
    let pot = w
        .run_raw(|p, books| p.draw_direct(books, key(OWNER), 10, 12))
        .unwrap();
    LineStore::new(w.spill.as_mut_slice())
        .unwrap()
        .set_room_reserved(1);
    // free room: 1 (basket) + 3 (spill) = 4, held 1: three organic credits fit, the fourth does not
    for due in 60..63 {
        let line = other_line(&mut w, due);
        w.run_raw(|p, books| p.put(books, &line)).unwrap();
    }
    let line = other_line(&mut w, 63);
    assert_eq!(
        w.run_raw(|p, books| p.put(books, &line)).unwrap_err(),
        DrawError::SpillFull
    );
    // and the held slot is still there for the entry's line
    let back = pot.lines()[0];
    w.run_raw(|p, books| {
        p.set_hold(1);
        p.put(books, &back)
    })
    .unwrap();
}

#[test]
fn a_hold_slot_taken_while_a_merge_needs_none_stays_held() {
    let mut w = full_world(4, 0);
    let pot = w
        .run_raw(|p, books| p.draw_direct(books, key(OWNER), 5, 12))
        .unwrap();
    // a split draw: the key is still in the basket, the line merges back without a slot
    LineStore::new(w.spill.as_mut_slice())
        .unwrap()
        .set_room_reserved(0);
    let line = pot.lines()[0];
    let used = w
        .run_raw(|p, books| {
            p.set_hold(0);
            p.put(books, &line)?;
            Ok(p.used())
        })
        .unwrap();
    assert_eq!(used, 0);
}

#[test]
fn a_freed_slot_a_plain_put_used_in_the_same_step_is_not_held() {
    let mut w = full_world(4, 0);
    let (freed, to_hold, used) = w
        .run_raw(|p, books| {
            p.draw_direct(books, key(OWNER), 10, 12)?;
            // a new key lands in the slot the draw just freed (no hold of its own, none held)
            let line = other_line_for(books, 50);
            p.put(books, &line)?;
            Ok((p.freed(), p.freed_to_hold(), p.used()))
        })
        .unwrap();
    assert_eq!((freed, used), (1, 1));
    // the slot is taken: holding it would leave more held than free
    assert_eq!(to_hold, 0);
}

#[test]
fn a_freed_slot_nobody_used_is_held_in_full() {
    let mut w = full_world(4, 0);
    let to_hold = w
        .run_raw(|p, books| {
            p.draw_direct(books, key(OWNER), 20, 12)?;
            Ok(p.freed_to_hold())
        })
        .unwrap();
    assert_eq!(to_hold, 2);
}

fn other_line_for(books: &mut Books, due: i64) -> Line {
    let mut line = SourceBook::blank_line(SIDE_WON, due, key(4), CLASS_GENERAL, 0);
    books.issue(&key(4), &mut line, 7).unwrap();
    line
}

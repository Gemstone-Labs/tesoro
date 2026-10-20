use super::*;
use crate::ledger::book::{fp, SourceBook};
use crate::ledger::line_store::{LineStore, CLASS_EXTENSION_BASE, SIDE_OWN, SIDE_WON};

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

/// A basket plus the Source books and every other place a line can be.
struct World {
    basket: Vec<u8>,
    books: BTreeMap<Key, SourceBook>,
    gone: Vec<Line>,
    pots: Vec<PotPages>,
    spill: Overflow,
    issued: u64,
}

fn world(cap: usize) -> World {
    let mut basket = vec![0u8; required_len(cap)];
    LineStore::init(basket.as_mut_slice(), key(OWNER), 1).unwrap();
    let mut books = BTreeMap::new();
    for s in 0..5u8 {
        let mut b = SourceBook::new();
        b.start_extension().unwrap();
        books.insert(key(s), b);
    }
    World {
        basket,
        books,
        gone: vec![],
        pots: vec![],
        spill: Overflow::new(key(OWNER), 4096).unwrap(),
        issued: 0,
    }
}

impl World {
    fn b(&mut self) -> (LineStore<&mut [u8]>, &mut BTreeMap<Key, SourceBook>) {
        (
            LineStore::new(self.basket.as_mut_slice()).unwrap(),
            &mut self.books,
        )
    }
    fn r(&self) -> LineStore<&[u8]> {
        LineStore::new(self.basket.as_slice()).unwrap()
    }
    /// Issue `amount` fresh Gemas of Source `src` and credit them like a settle: merge into the
    /// basket, or into the spill record when the basket is full.
    fn credit(&mut self, side: u8, due: i64, src: u8, class: u8, amount: u64) {
        let tranche = if class == CLASS_EXTENSION_BASE { 1 } else { 0 };
        let mut line = SourceBook::blank_line(side, due, key(src), class, tranche);
        self.books
            .get_mut(&key(src))
            .unwrap()
            .issue(&mut line, amount)
            .unwrap();
        self.issued += amount;
        let mut b = LineStore::new(self.basket.as_mut_slice()).unwrap();
        if !put_line(&mut b, &mut self.books, &line).unwrap() {
            self.spill.credit(&mut self.books, &line).unwrap();
        }
    }
    fn land(&mut self, src: u8, gemas: u64) {
        let book = self.books.get_mut(&key(src)).unwrap();
        let cum = book.h + fp(gemas);
        book.land(cum, (fp(gemas)) >> 32).unwrap();
    }
    fn amounts(&self) -> Vec<(u8, i64, u8, u8, u64)> {
        self.r()
            .lines()
            .map(|l| (l.side, l.due_at, l.source[0], l.class, l.amount))
            .collect()
    }
    fn check(&self) {
        self.r().check().unwrap();
        let mut by_src: BTreeMap<Key, Vec<Line>> = BTreeMap::new();
        let mut all: Vec<Line> = self.r().lines().collect();
        all.extend(self.gone.iter().copied());
        all.extend(self.spill.lines());
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
    let (mut b, books) = w.b();
    let pot = draw_direct(&mut b, books, key(OWNER), 250, 12).unwrap();
    assert_eq!(
        pot_amounts(&pot),
        vec![
            (SIDE_OWN, 9, 3, 3, 100),
            (SIDE_WON, 2, 2, 3, 100),
            (SIDE_WON, 5, 1, 3, 50)
        ]
    );
    assert_eq!(b.fee_total(), 50);
    assert_eq!(playable_total(&b), 50);
    w.pots.push(pot);
    w.check();
}

#[test]
fn the_reservation_is_held_by_the_slowest_lines_and_an_entry_never_touches_it() {
    let mut w = world(16);
    w.credit(SIDE_OWN, 1, 1, CLASS_GENERAL, 500);
    w.credit(SIDE_WON, 3, 2, CLASS_GENERAL, 500);
    let (mut b, books) = w.b();
    reserve_offer(&mut b, 500, 0).unwrap();
    assert_eq!(free_gemas(&b), 500);
    assert_eq!(
        draw_direct(&mut b, books, key(OWNER), 501, 12).unwrap_err(),
        DrawError::InsufficientGemas
    );
    let pot = draw_direct(&mut b, books, key(OWNER), 500, 12).unwrap();
    assert_eq!(pot_amounts(&pot), vec![(SIDE_OWN, 1, 1, 3, 500)]);
    // what is left is exactly the reserved slow line
    assert_eq!(b.get(0).unwrap().amount, 500);
    assert_eq!(b.reserved_total(), 500);
    w.pots.push(pot);
    w.check();
}

#[test]
fn a_split_line_moves_ready_proportionally() {
    let mut w = world(8);
    w.credit(SIDE_OWN, 1, 1, CLASS_GENERAL, 1000);
    w.land(1, 400);
    let (mut b, books) = w.b();
    let pot = draw_direct(&mut b, books, key(OWNER), 250, 12).unwrap();
    let book = &w.books[&key(1)];
    let part = pot.lines()[0];
    let rest = w.r().get(0).unwrap();
    assert_eq!(part.amount + rest.amount, 1000);
    assert_eq!(
        book.ready_of(&part).unwrap() / 250,
        book.ready_of(&rest).unwrap() / 750
    );
    w.pots.push(pot);
    w.check();
}

#[test]
fn a_draw_over_the_line_cap_needs_a_ticket_and_changes_nothing() {
    let mut w = world(32);
    for i in 0..20 {
        w.credit(SIDE_OWN, i, (i % 5) as u8, CLASS_GENERAL, 10);
    }
    let before = w.basket.clone();
    let (mut b, books) = w.b();
    assert_eq!(
        draw_direct(&mut b, books, key(OWNER), 150, 12).unwrap_err(),
        DrawError::NeedsTicket
    );
    assert_eq!(w.basket, before);
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
    let total = w.r().own_total();
    let entry = 400;
    assert!(total >= entry);
    let (mut b, books) = w.b();
    let mut t = Ticket::open_entry(&mut b, key(GAME), 1, entry, 1_000).unwrap();
    assert!(ticket_is_open(&b));
    assert_eq!(b.ticket_need(), entry);
    t.mark_storage_reserved();
    let mut steps = 0;
    loop {
        let s = t.stage(&mut b, books, 12, true).unwrap();
        steps += 1;
        assert_eq!(b.ticket_need(), entry - s.staged);
        if s.ready {
            break;
        }
    }
    assert!(steps > 1);
    let pot = t.consume(&mut b, &key(GAME), entry).unwrap();
    assert!(!ticket_is_open(&b));
    assert_eq!(b.ticket_need(), 0);
    assert_eq!(pot.total(), entry);
    assert!(pot.page_count() >= 1);
    w.pots.push(pot);
    w.check();
}

#[test]
fn staging_needs_storage_reserved_first_and_the_owner_for_an_entry() {
    let mut w = world(16);
    w.credit(SIDE_OWN, 1, 1, CLASS_GENERAL, 100);
    let (mut b, books) = w.b();
    let mut t = Ticket::open_entry(&mut b, key(GAME), 1, 50, 1_000).unwrap();
    assert_eq!(
        t.stage(&mut b, books, 12, true).unwrap_err(),
        DrawError::StorageNotReserved
    );
    t.mark_storage_reserved();
    assert_eq!(
        t.stage(&mut b, books, 12, false).unwrap_err(),
        DrawError::NotOwner
    );
    assert!(t.stage(&mut b, books, 12, true).unwrap().ready);
}

#[test]
fn while_a_ticket_is_open_nothing_else_draws_reserves_or_opens() {
    let mut w = world(16);
    w.credit(SIDE_OWN, 1, 1, CLASS_GENERAL, 1000);
    let (mut b, books) = w.b();
    let _t = Ticket::open_entry(&mut b, key(GAME), 1, 500, 1_000).unwrap();
    assert_eq!(
        draw_direct(&mut b, books, key(OWNER), 100, 12).unwrap_err(),
        DrawError::TicketOpen
    );
    assert_eq!(
        Ticket::open_entry(&mut b, key(GAME), 2, 100, 1_000).unwrap_err(),
        DrawError::TicketOpen
    );
    assert_eq!(
        reserve_offer(&mut b, 100, 0).unwrap_err(),
        DrawError::TicketOpen
    );
    assert_eq!(
        draw_backing_direct(&mut b, books, key(OWNER), 100, 12).unwrap_err(),
        DrawError::TicketOpen
    );
}

#[test]
fn bypass_stage_fast_then_enter_slow_is_refused_and_restaging_fixes_it() {
    let mut w = world(16);
    w.credit(SIDE_WON, 50, 1, CLASS_GENERAL, 300); // slow
    w.credit(SIDE_WON, 60, 2, CLASS_GENERAL, 300);
    let (mut b, books) = w.b();
    let mut t = Ticket::open_entry(&mut b, key(GAME), 1, 300, 1_000).unwrap();
    t.mark_storage_reserved();
    assert!(t.stage(&mut b, books, 12, true).unwrap().ready);
    // faster Gemas arrive after staging
    w.credit(SIDE_WON, 10, 3, CLASS_GENERAL, 200);
    let (mut b, books) = w.b();
    assert!(t.faster_waiting(&b));
    assert_eq!(
        t.consume(&mut b, &key(GAME), 300).unwrap_err(),
        DrawError::FasterGemasAvailable
    );
    let s = t.stage(&mut b, books, 12, true).unwrap();
    assert!(s.ready && s.returned >= 1);
    let pot = t.consume(&mut b, &key(GAME), 300).unwrap();
    assert_eq!(
        pot_amounts(&pot),
        vec![(SIDE_WON, 10, 3, 3, 200), (SIDE_WON, 50, 1, 3, 100)]
    );
    w.pots.push(pot);
    w.check();
}

#[test]
fn bypass_offer_reserved_after_staging_is_refused() {
    let mut w = world(16);
    w.credit(SIDE_WON, 50, 1, CLASS_GENERAL, 300);
    let (mut b, _) = w.b();
    let _t = Ticket::open_entry(&mut b, key(GAME), 1, 100, 1_000).unwrap();
    assert_eq!(
        reserve_offer(&mut b, 100, 0).unwrap_err(),
        DrawError::TicketOpen
    );
}

#[test]
fn a_consume_with_a_mismatch_or_an_incomplete_ticket_is_refused() {
    let mut w = world(16);
    w.credit(SIDE_OWN, 1, 1, CLASS_GENERAL, 500);
    let (mut b, books) = w.b();
    let mut t = Ticket::open_entry(&mut b, key(GAME), 1, 300, 1_000).unwrap();
    t.mark_storage_reserved();
    assert_eq!(
        t.consume(&mut b, &key(GAME), 300).unwrap_err(),
        DrawError::NotComplete
    );
    t.stage(&mut b, books, 12, true).unwrap();
    assert_eq!(
        t.consume(&mut b, &key(9), 300).unwrap_err(),
        DrawError::Mismatch
    );
    assert_eq!(
        t.consume(&mut b, &key(GAME), 400).unwrap_err(),
        DrawError::Mismatch
    );
    assert!(t.consume(&mut b, &key(GAME), 300).is_ok());
    assert_eq!(
        t.consume(&mut b, &key(GAME), 300).unwrap_err(),
        DrawError::NotOpen
    );
}

#[test]
fn no_double_spend_between_a_ticket_an_offer_and_a_redeem() {
    let mut w = world(16);
    w.credit(SIDE_OWN, 1, 1, CLASS_GENERAL, 1000);
    let (mut b, _) = w.b();
    reserve_offer(&mut b, 300, 0).unwrap();
    // 700 free: a 500 Ticket leaves 200 to withdraw, and the Offer's 300 stay
    let _t = Ticket::open_entry(&mut b, key(GAME), 1, 500, 1_000).unwrap();
    assert_eq!(free_gemas(&b), 200);
    assert_eq!(
        check_withdraw(&b, 201).unwrap_err(),
        DrawError::WouldBreakReservation
    );
    assert!(check_withdraw(&b, 200).is_ok());
    // the entry is refused if the Offer and a Redeem already took the room
    let mut w2 = world(16);
    w2.credit(SIDE_OWN, 1, 1, CLASS_GENERAL, 1000);
    let (mut b2, _) = w2.b();
    reserve_offer(&mut b2, 600, 0).unwrap();
    assert_eq!(
        Ticket::open_entry(&mut b2, key(GAME), 1, 500, 1_000).unwrap_err(),
        DrawError::InsufficientGemas
    );
    assert_eq!(
        reserve_offer(&mut b2, 401, 1).unwrap_err(),
        DrawError::InsufficientGemas
    );
    assert_eq!(
        reserve_offer(&mut b2, 1, MAX_OPEN_OFFERS).unwrap_err(),
        DrawError::TooManyOffers
    );
    release_offer(&mut b2, 600).unwrap();
    assert_eq!(
        release_offer(&mut b2, 1).unwrap_err(),
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
    let before_total = w.r().own_total();
    let mut t = {
        let (mut b, books) = w.b();
        let mut t = Ticket::open_entry(&mut b, key(GAME), 1, 150, 1_000).unwrap();
        t.mark_storage_reserved();
        while !t.stage(&mut b, books, 12, true).unwrap().ready {}
        t
    };
    let (mut b, books) = w.b();
    assert_eq!(
        t.begin_cancel(&mut b, 0, false).unwrap_err(),
        DrawError::NotExpired
    );
    t.begin_cancel(&mut b, 1_000, false).unwrap(); // expiry: anyone
    assert_eq!(
        t.stage(&mut b, books, 1, true).unwrap_err(),
        DrawError::NotOpen
    );
    let mut chunks = 0;
    loop {
        let s = t.cancel_step(&mut b, books, 5).unwrap();
        chunks += 1;
        if s.done {
            break;
        }
    }
    assert!(chunks > 1);
    assert!(t.cancel_step(&mut b, books, 5).unwrap().done); // idempotent
    assert!(!ticket_is_open(&b));
    assert_eq!(b.own_total(), before_total);
    assert_eq!(w.amounts(), before);
    w.check();
}

#[test]
fn cancel_into_a_full_basket_goes_to_the_overflow_record_and_is_claimable() {
    let mut w = world(10);
    for i in 0..10i64 {
        w.credit(SIDE_OWN, i, (i % 5) as u8, CLASS_GENERAL, 10);
    }
    let mut t = {
        let (mut b, books) = w.b();
        let mut t = Ticket::open_entry(&mut b, key(GAME), 1, 50, 1_000).unwrap();
        t.mark_storage_reserved();
        while !t.stage(&mut b, books, 12, true).unwrap().ready {}
        t
    };
    // the freed slots fill with new Gemas of other keys
    for i in 100..105i64 {
        w.credit(SIDE_OWN, i, 0, CLASS_GENERAL, 3);
    }
    assert_eq!(w.r().len(), 10);
    let (mut b, books) = w.b();
    t.begin_cancel(&mut b, 0, true).unwrap();
    let s = t.cancel_step(&mut b, books, 100).unwrap();
    assert!(s.done);
    assert_eq!(s.lines_to_overflow, 5);
    assert_eq!(s.gemas_to_overflow, 50);
    assert_eq!(t.overflow.total(), 50);
    assert_eq!(b.own_total(), 50 + 15);
    // make room and claim
    let mut big = vec![0u8; required_len(20)];
    {
        let mut nb = LineStore::init(big.as_mut_slice(), key(OWNER), 1).unwrap();
        for l in b.lines() {
            nb.insert(&l).unwrap();
        }
        let n = t.overflow.claim(&mut nb, books, 100).unwrap();
        assert_eq!(n, 5);
        assert!(t.overflow.is_empty());
        assert_eq!(nb.own_total(), 115);
    }
}

#[test]
fn backing_ticket_is_staged_by_anyone_and_cancel_restores_the_reservation() {
    let mut w = world(64);
    for i in 0..30i64 {
        w.credit(SIDE_OWN, i, (i % 5) as u8, CLASS_GENERAL, 10);
    }
    let (mut b, books) = w.b();
    reserve_offer(&mut b, 200, 0).unwrap();
    reserve_offer(&mut b, 50, 1).unwrap();
    let mut t = Ticket::open_backing(&mut b, key(GAME), 1, 200, 1_000).unwrap();
    t.mark_storage_reserved();
    t.stage(&mut b, books, 5, false).unwrap(); // a stranger stages
    assert!(b.reserved_total() < 250);
    assert_eq!(b.ticket_need(), 0);
    t.begin_cancel(&mut b, 0, true).unwrap();
    while !t.cancel_step(&mut b, books, 4).unwrap().done {}
    assert_eq!(b.reserved_total(), 250);
    assert_eq!(t.reservation_lost, 0);
    // now draw it directly in a bigger chunk budget
    let pot = draw_backing_direct(&mut b, books, key(OWNER), 50, 12).unwrap();
    assert_eq!(pot.total(), 50);
    assert_eq!(b.reserved_total(), 200);
    assert_eq!(
        draw_backing_direct(&mut b, books, key(OWNER), 201, 12).unwrap_err(),
        DrawError::ReservationShort
    );
}

// ---------------------------------------------------------------------------------------------
// Fuzz against an independent model
// ---------------------------------------------------------------------------------------------

use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
static COV: [AtomicUsize; 6] = [const { AtomicUsize::new(0) }; 6];
const C_TICKET: usize = 0;
const C_RESTAGE: usize = 1;
const C_OVERFLOW: usize = 2;
const C_BACKING_TICKET: usize = 3;
const C_REFUSED_FASTER: usize = 4;
const C_CLAIM: usize = 5;

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

struct Sim {
    w: World,
    rng: Rng,
    cap: usize,
    ticket: Option<Ticket>,
    spills: Vec<Overflow>,
    /// Model: every Gema in the basket and the open Ticket, by key.
    union: Union,
    offers: Vec<u64>,
    /// Amount of the Offer under an open Backing Ticket (its reservation travels with the Ticket).
    backing: u64,
    now: i64,
    max_lines: usize,
}

fn mk_key(l: &Line) -> LineKey {
    l.key()
}

impl Sim {
    fn new(seed: u64) -> Sim {
        let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
        let cap = [6, 12, 40, 400][rng.below(4) as usize];
        let max_lines = 1 + rng.below(5) as usize;
        Sim {
            w: world(cap),
            rng,
            cap,
            ticket: None,
            spills: vec![],
            union: BTreeMap::new(),
            offers: vec![],
            backing: 0,
            now: 0,
            max_lines,
        }
    }

    fn staged(&self) -> u64 {
        self.ticket.as_ref().map_or(0, |t| t.staged())
    }
    fn reserved(&self) -> u64 {
        let lost = self.ticket.as_ref().map_or(0, |t| t.reservation_lost);
        self.offers.iter().sum::<u64>() + self.backing - self.staged_backing() - lost
    }
    fn staged_backing(&self) -> u64 {
        match &self.ticket {
            Some(t) if t.kind == TicketKind::Backing => t.staged(),
            _ => 0,
        }
    }
    fn playable_union(&self) -> u64 {
        self.union
            .iter()
            .filter(|(k, _)| k.class >= CLASS_GENERAL)
            .map(|(_, a)| a)
            .sum()
    }
    fn need(&self) -> u64 {
        match &self.ticket {
            Some(t) if t.kind == TicketKind::Entry && t.state == TicketState::Open => {
                t.target - t.staged()
            }
            _ => 0,
        }
    }
    fn model_free(&self) -> u64 {
        (self.playable_union() - self.staged()) - self.reserved() - self.need()
    }
    fn basket_union(&self) -> Union {
        let mut u = BTreeMap::new();
        for l in self.w.r().lines() {
            u.insert(mk_key(&l), l.amount);
        }
        u
    }

    fn invariants(&mut self) {
        let b = self.w.r();
        b.check().unwrap();
        // the model and the real basket + ticket agree line by line
        let mut real = self.basket_union();
        if let Some(t) = &self.ticket {
            t.pages.check().unwrap();
            for l in t.pages.lines() {
                *real.entry(mk_key(&l)).or_default() += l.amount;
            }
        }
        assert_eq!(real, self.union, "basket + ticket != model");
        assert_eq!(b.reserved_total(), self.reserved());
        assert_eq!(b.ticket_need(), self.need());
        assert_eq!(
            ticket_is_open(&b),
            self.ticket
                .as_ref()
                .is_some_and(|t| !matches!(t.state, TicketState::Closed | TicketState::Cancelled))
        );
        // no double spend: what the basket holds covers the reservations and the Ticket's need
        assert!(playable_total(&b) >= b.reserved_total() + b.ticket_need());
        // conservation
        let mut sum = self.w.r().lines().map(|l| l.amount).sum::<u64>();
        sum += self.staged();
        sum += self.w.spill.total();
        sum += self.spills.iter().map(|o| o.total()).sum::<u64>();
        if let Some(t) = &self.ticket {
            sum += t.overflow.total();
        }
        sum += self.w.pots.iter().map(|p| p.total()).sum::<u64>();
        sum += self.w.gone.iter().map(|l| l.amount).sum::<u64>();
        assert_eq!(sum, self.w.issued, "a Gema was created or lost");
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
        let in_basket = self.basket_union().contains_key(&k);
        let full = self.w.r().len() >= self.cap;
        self.w.credit(side, due, src, class, amount);
        if in_basket || !full {
            *self.union.entry(k).or_default() += amount;
        }
    }

    fn op_withdraw(&mut self) {
        let free = self.model_free();
        let lines: Vec<Line> = self
            .w
            .r()
            .lines()
            .filter(|l| l.class >= CLASS_GENERAL)
            .collect();
        // the guard must agree with the model, in both directions
        let over = free + 1;
        let (b, _) = self.w.b();
        assert_eq!(
            check_withdraw(&b, over).unwrap_err(),
            DrawError::WouldBreakReservation
        );
        if lines.is_empty() || free == 0 {
            let (b, _) = self.w.b();
            assert!(check_withdraw(&b, 1).is_err() || free > 0);
            return;
        }
        let line = lines[self.rng.below(lines.len() as u64) as usize];
        let k = 1 + self.rng.below(line.amount.min(free));
        let (mut b, books) = self.w.b();
        check_withdraw(&b, k).unwrap();
        let idx = b.find(&line.key()).unwrap();
        let mut rest = line;
        let mut out = SourceBook::blank_line(
            line.side,
            line.due_at,
            line.source,
            line.class,
            line.tranche,
        );
        books
            .book_mut(&line.source)
            .unwrap()
            .transfer(&mut rest, &mut out, k)
            .unwrap();
        if rest.amount == 0 {
            b.remove_at(idx).unwrap();
        } else {
            b.set_line(idx, &rest).unwrap();
        }
        self.w.gone.push(out);
        let e = self.union.get_mut(&line.key()).unwrap();
        *e -= k;
        if *e == 0 {
            self.union.remove(&line.key());
        }
    }

    fn op_reserve(&mut self) {
        let amount = 1 + self.rng.below(300);
        let expect_ok = self.ticket.is_none()
            && (self.offers.len() as u32) < MAX_OPEN_OFFERS
            && amount <= self.model_free();
        let n = self.offers.len() as u32;
        let (mut b, _) = self.w.b();
        let r = reserve_offer(&mut b, amount, n);
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
        let (mut b, _) = self.w.b();
        release_offer(&mut b, a).unwrap();
    }

    fn check_pot_is_canonical(&mut self, pot: &PotPages, amount: u64, union_before: &Union) {
        let want = canonical(union_before, amount);
        let got: BTreeMap<LineKey, u64> =
            pot.lines().iter().map(|l| (mk_key(l), l.amount)).collect();
        assert_eq!(got, want, "the draw did not follow the program's order");
        for (k, a) in &got {
            let e = self.union.get_mut(k).unwrap();
            *e -= a;
            if *e == 0 {
                self.union.remove(k);
            }
        }
    }

    fn op_enter(&mut self) {
        let ml = self.max_lines;
        let entry = [10u64, 30, 80, 200][self.rng.below(4) as usize];
        let free = self.model_free();
        let before = self.union.clone();
        if self.ticket.is_some() {
            let (mut b, books) = self.w.b();
            assert_eq!(
                draw_direct(&mut b, books, key(OWNER), entry, ml).unwrap_err(),
                DrawError::TicketOpen
            );
            return;
        }
        let (mut b, books) = self.w.b();
        match draw_direct(&mut b, books, key(OWNER), entry, ml) {
            Ok(pot) => {
                assert!(entry <= free);
                self.check_pot_is_canonical(&pot, entry, &before);
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
                let mut t =
                    Ticket::open_entry(&mut b, key(GAME), self.now as u64, entry, self.now + 500)
                        .expect("a covered entry always opens a Ticket");
                t.mark_storage_reserved();
                COV[C_TICKET].fetch_add(1, Relaxed);
                self.ticket = Some(t);
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
        let before = self.union.clone();
        let (mut b, books) = self.w.b();
        if self.ticket.is_some() {
            assert_eq!(
                draw_backing_direct(&mut b, books, key(OWNER), a, ml).unwrap_err(),
                DrawError::TicketOpen
            );
            return;
        }
        match draw_backing_direct(&mut b, books, key(OWNER), a, ml) {
            Ok(pot) => {
                self.offers.remove(i);
                self.check_pot_is_canonical(&pot, a, &before);
                self.w.pots.push(pot);
            }
            Err(DrawError::NeedsTicket) => {
                let mut t =
                    Ticket::open_backing(&mut b, key(GAME), self.now as u64, a, self.now + 500)
                        .unwrap();
                t.mark_storage_reserved();
                // the Offer's amount now travels with the Ticket
                self.offers.remove(i);
                self.ticket = Some(t);
                self.backing = a;
                COV[C_BACKING_TICKET].fetch_add(1, Relaxed);
            }
            Err(e) => panic!("{e:?}"),
        }
    }
}

impl Sim {
    /// Stage a few steps. Returns true when the Ticket is ready.
    fn op_stage(&mut self, max_ops: usize) -> bool {
        let Some(mut t) = self.ticket.take() else {
            return false;
        };
        if t.state != TicketState::Open {
            self.ticket = Some(t);
            return false;
        }
        let owner =
            t.kind == TicketKind::Backing && self.rng.below(2) == 0 || t.kind == TicketKind::Entry;
        let mut ready = false;
        for _ in 0..2 {
            let before_full = self.w.r().len() >= self.cap;
            let (mut b, books) = self.w.b();
            match t.stage(&mut b, books, max_ops, owner) {
                Ok(s) => {
                    if s.returned > 0 {
                        COV[C_RESTAGE].fetch_add(1, Relaxed);
                    }
                    ready = s.ready;
                    break;
                }
                Err(DrawError::TicketStorageFull) => t.grow_storage(4).unwrap(),
                Err(DrawError::BasketFull) => {
                    assert!(
                        before_full || self.w.r().len() >= self.cap,
                        "BasketFull with room"
                    );
                    break;
                }
                Err(e) => panic!("stage failed for a covered entry: {e:?}"),
            }
        }
        // the ticket kept the model union intact; only the Backing reservation moves with it
        self.ticket = Some(t);
        ready
    }

    fn model_faster(&self, t: &Ticket) -> bool {
        let Some(last) = t.pages.last_line() else {
            return false;
        };
        let basket = self.basket_union();
        let total: u64 = basket
            .iter()
            .filter(|(k, _)| k.class >= CLASS_GENERAL)
            .map(|(_, a)| a)
            .sum();
        let hold = self.reserved();
        if total <= hold {
            return false;
        }
        basket
            .iter()
            .find(|(k, a)| k.class >= CLASS_GENERAL && **a > 0)
            .is_some_and(|(k, _)| *k < last.key())
    }

    fn op_consume(&mut self) {
        let Some(t0) = self.ticket.as_ref() else {
            return;
        };
        if t0.state != TicketState::Open {
            return;
        }
        let expect_ok = t0.staged() == t0.target && !self.model_faster(t0);
        let mut t = self.ticket.take().unwrap();
        let before = self.union.clone();
        let target = t.target;
        let kind = t.kind;
        let r = {
            let (mut b, _) = self.w.b();
            t.consume(&mut b, &key(GAME), target)
        };
        if r.as_ref().err() == Some(&DrawError::FasterGemasAvailable) {
            COV[C_REFUSED_FASTER].fetch_add(1, Relaxed);
        }
        assert_eq!(r.is_ok(), expect_ok, "{:?}", r.as_ref().err());
        match r {
            Ok(pot) => {
                if kind == TicketKind::Backing {
                    self.backing = 0;
                }
                // the Ticket's lines left the union: the pot is the canonical draw
                let want = canonical(&before, target);
                let got: BTreeMap<LineKey, u64> =
                    pot.lines().iter().map(|l| (mk_key(l), l.amount)).collect();
                assert_eq!(got, want, "Ticket order differs from the program's order");
                // the staged part was in the union already; remove it
                for (k, a) in &got {
                    let e = self.union.get_mut(k).unwrap();
                    *e -= a;
                    if *e == 0 {
                        self.union.remove(k);
                    }
                }
                self.w.pots.push(pot);
                self.spills.push(t.overflow.clone());
            }
            Err(_) => self.ticket = Some(t),
        }
    }

    fn sub_union(&mut self, k: &LineKey, a: u64) {
        let e = self.union.get_mut(k).unwrap();
        *e -= a;
        if *e == 0 {
            self.union.remove(k);
        }
    }

    fn op_cancel(&mut self) {
        if self
            .ticket
            .as_ref()
            .is_none_or(|t| matches!(t.state, TicketState::Closed | TicketState::Cancelled))
        {
            return;
        }
        {
            let now = self.now;
            let by_owner = self.rng.below(2) == 0;
            let t = self.ticket.as_mut().unwrap();
            let (mut b, _) = self.w.b();
            if t.state == TicketState::Open {
                if by_owner {
                    t.begin_cancel(&mut b, now, false).ok();
                    assert!(t.state == TicketState::Open || now >= t.expires_at);
                    if t.state == TicketState::Open {
                        t.begin_cancel(&mut b, now, true).unwrap();
                    }
                } else {
                    self.now += 1_000;
                    t.begin_cancel(&mut b, self.now, false).unwrap();
                }
            }
        }
        self.invariants();
        loop {
            let max = 1 + self.rng.below(5) as usize;
            let mut t = self.ticket.take().unwrap();
            let before = t.overflow.lines();
            let s = {
                let (mut b, books) = self.w.b();
                t.cancel_step(&mut b, books, max).unwrap()
            };
            if s.lines_to_overflow > 0 {
                COV[C_OVERFLOW].fetch_add(1, Relaxed);
                assert!(
                    self.w.r().len() >= self.cap,
                    "overflow while the basket had room"
                );
            }
            let after = t.overflow.lines();
            let mut delta: BTreeMap<LineKey, i128> = BTreeMap::new();
            for l in &after {
                *delta.entry(mk_key(l)).or_default() += l.amount as i128;
            }
            for l in &before {
                *delta.entry(mk_key(l)).or_default() -= l.amount as i128;
            }
            for (k, d) in delta {
                if d > 0 {
                    self.sub_union(&k, d as u64);
                }
            }
            let done = s.done;
            self.ticket = Some(t);
            self.invariants();
            if done {
                break;
            }
            if self.rng.below(3) == 0 {
                self.op_credit();
                self.invariants();
            }
        }
        let t = self.ticket.take().unwrap();
        if t.kind == TicketKind::Backing {
            let left = self.backing - t.reservation_lost;
            self.backing = 0;
            if left > 0 {
                self.offers.push(left);
            }
        }
        self.spills.push(t.overflow);
        self.invariants();
    }

    fn op_claim(&mut self) {
        let mut ovs = std::mem::take(&mut self.spills);
        ovs.push(std::mem::replace(
            &mut self.w.spill,
            Overflow::new(key(OWNER), 4096).unwrap(),
        ));
        let i = self.rng.below(ovs.len() as u64) as usize;
        let before = ovs[i].lines();
        {
            let (mut b, books) = self.w.b();
            ovs[i]
                .claim(&mut b, books, 1 + self.rng.below(6) as usize)
                .unwrap();
        }
        if !before.is_empty() {
            COV[C_CLAIM].fetch_add(1, Relaxed);
        }
        let after: Vec<LineKey> = ovs[i].lines().iter().map(mk_key).collect();
        let kept: BTreeMap<LineKey, u64> = ovs[i]
            .lines()
            .iter()
            .map(|l| (mk_key(l), l.amount))
            .collect();
        for l in before {
            if !after.contains(&mk_key(&l)) || kept[&mk_key(&l)] != l.amount {
                *self.union.entry(mk_key(&l)).or_default() +=
                    l.amount - kept.get(&mk_key(&l)).copied().unwrap_or(0);
            }
        }
        self.w.spill = ovs.pop().unwrap();
        self.spills = ovs;
    }

    fn op_land(&mut self) {
        let src = self.rng.below(5) as u8;
        let g = 1 + self.rng.below(60);
        self.w.land(src, g);
    }

    fn step(&mut self) {
        match self.rng.below(100) {
            0..=29 => self.op_credit(),
            30..=37 => self.op_withdraw(),
            38..=43 => self.op_reserve(),
            44..=47 => self.op_release(),
            48..=57 => self.op_enter(),
            58..=61 => self.op_open_backing(),
            62..=77 => {
                let n = 1 + self.rng.below(5) as usize;
                self.op_stage(n);
            }
            78..=86 => self.op_consume(),
            87..=91 => self.op_cancel(),
            92..=94 => self.op_claim(),
            _ => self.op_land(),
        }
        self.invariants();
    }

    /// The founder's requirement: with no Ticket in the way (or after cancelling it), whoever's
    /// free Gemas cover an entry completes it, whatever the basket looks like.
    fn assert_can_always_enter(&mut self) {
        let ml = self.max_lines;
        if self.ticket.is_some() {
            self.op_cancel();
        }
        for entry in [10u64, 30, 80, 200] {
            if entry > self.model_free() {
                continue;
            }
            let before = self.union.clone();
            let (mut b, books) = self.w.b();
            let pot = match draw_direct(&mut b, books, key(OWNER), entry, ml) {
                Ok(p) => p,
                Err(DrawError::NeedsTicket) => {
                    let mut t = Ticket::open_entry(&mut b, key(GAME), 9, entry, 9).unwrap();
                    t.mark_storage_reserved();
                    let mut guard = 0;
                    loop {
                        match t.stage(&mut b, books, ml, true) {
                            Ok(s) if s.ready => break,
                            Ok(_) => {}
                            Err(DrawError::TicketStorageFull) => t.grow_storage(4).unwrap(),
                            Err(e) => panic!("covered entry {entry} could not stage: {e:?}"),
                        }
                        guard += 1;
                        assert!(guard < 5_000, "staging does not converge");
                    }
                    t.consume(&mut b, &key(GAME), entry).unwrap()
                }
                Err(e) => panic!("covered entry {entry} refused: {e:?}"),
            };
            self.check_pot_is_canonical(&pot, entry, &before);
            self.w.pots.push(pot);
            self.invariants();
        }
    }
}

impl Sim {
    fn final_check(&mut self) {
        for o in std::mem::take(&mut self.spills) {
            for l in o.lines() {
                self.w.gone.push(l);
            }
        }
        self.w.check();
    }
}

fn run(seed: u64, ops: usize) {
    let mut s = Sim::new(seed);
    for i in 0..ops {
        s.step();
        if i % 25 == 24 {
            s.assert_can_always_enter();
        }
    }
    s.assert_can_always_enter();
    s.final_check();
}

fn seeds() -> u64 {
    std::env::var("DRAW_FUZZ_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(400)
}

#[test]
fn fuzz_draw_tickets_offers_against_a_model() {
    for seed in 1..=seeds() {
        run(seed, 200);
    }
    let c: Vec<usize> = COV.iter().map(|c| c.load(Relaxed)).collect();
    eprintln!("coverage [ticket, restage, overflow, backing ticket, refused faster, claim]: {c:?}");
    for (i, n) in c.iter().enumerate() {
        assert!(*n > 0, "the fuzz never reached case {i}: {c:?}");
    }
}

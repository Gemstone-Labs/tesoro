use super::*;
use crate::ledger::book::{fp, SourceBook};
use crate::ledger::draw::{grow_spill_body, spill_body, DrawResult, Pool};
use crate::ledger::line_store::{required_len, LineStore, CLASS_EXTENSION_BASE, CLASS_GENERAL};

fn key(n: u8) -> Key {
    [n; 32]
}

const GAME: u8 = 77;
const AUTH: u8 = 78;
const OUTSIDE: u8 = 9;
const SIZES: [u64; 3] = [20, 50, 100];
const SLOT: u64 = 100;

#[derive(Clone)]
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
    fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
}

type Books = BTreeMap<Key, SourceBook>;

struct Acct {
    basket: Vec<u8>,
    spill: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Ev {
    Sync(Key),
    Credit {
        m: MatchId,
        owner: Key,
        src: Key,
        class: u8,
        amount: u64,
    },
    Fee {
        m: MatchId,
        class: u8,
        owner: Option<Key>,
        src: Key,
        amount: u64,
    },
}

/// Every place a line can be, as the instruction layer would reach it.
struct World {
    accts: BTreeMap<Key, Acct>,
    books: Books,
    counters: BTreeMap<(u8, Key), Line>,
    issued: BTreeMap<Key, u64>,
    /// The computed cumulative coverage of each Source (Fp); `sync_source` lands up to it.
    target: BTreeMap<Key, u128>,
    ev: Vec<Ev>,
    cur: Option<MatchId>,
    /// Spill slots reserved per (Match, Account).
    reserved: BTreeMap<(MatchId, Key), usize>,
    /// Spill slots granted for organic credits, to check the room contract.
    organic_grown: usize,
}

impl World {
    fn new(rng: &mut Rng) -> World {
        let mut accts = BTreeMap::new();
        for n in (1..=6u8).chain([OUTSIDE]) {
            let cap = 1 + rng.below(4) as usize;
            let mut basket = vec![0u8; required_len(cap)];
            LineStore::init(basket.as_mut_slice(), key(n), 1).unwrap();
            accts.insert(
                key(n),
                Acct {
                    basket,
                    spill: spill_body(key(n), 0).unwrap(),
                },
            );
        }
        let mut books = BTreeMap::new();
        let mut issued = BTreeMap::new();
        for s in 100..104u8 {
            let mut b = SourceBook::new();
            b.start_extension().unwrap();
            books.insert(key(s), b);
            issued.insert(key(s), 0);
        }
        World {
            accts,
            books,
            counters: BTreeMap::new(),
            issued,
            target: BTreeMap::new(),
            ev: vec![],
            cur: None,
            reserved: BTreeMap::new(),
            organic_grown: 0,
        }
    }

    fn pool<R>(
        &mut self,
        who: &Key,
        f: impl FnOnce(&mut Pool<&mut [u8], &mut [u8]>, &mut Books) -> DrawResult<R>,
    ) -> DrawResult<R> {
        let a = self.accts.get_mut(who).unwrap();
        let mut b = LineStore::new(a.basket.as_mut_slice()).unwrap();
        let mut s = LineStore::new(a.spill.as_mut_slice()).unwrap();
        let mut p = Pool::new(&mut b, &mut s);
        f(&mut p, &mut self.books)
    }

    fn grow_spill(&mut self, who: &Key, by: usize) {
        let a = self.accts.get_mut(who).unwrap();
        let cap = LineStore::new(a.spill.as_slice()).unwrap().capacity();
        grow_spill_body(&mut a.spill, cap + by);
    }

    /// An organic credit (setup, "other" activity): grows the spill for itself if it must.
    fn give(&mut self, who: u8, side: u8, due: i64, src: u8, ext: bool, amount: u64) {
        let (class, tranche) = if ext {
            (CLASS_EXTENSION_BASE, 1)
        } else {
            (CLASS_GENERAL, 0)
        };
        let mut line = SourceBook::blank_line(side, due, key(src), class, tranche);
        self.books
            .get_mut(&key(src))
            .unwrap()
            .issue(&mut line, amount)
            .unwrap();
        *self.issued.get_mut(&key(src)).unwrap() += amount;
        loop {
            match self.pool(&key(who), |p, books| p.put(books, &line)) {
                Ok(_) => break,
                Err(DrawError::SpillFull) => {
                    self.grow_spill(&key(who), 1);
                    self.organic_grown += 1;
                }
                Err(e) => panic!("give: {e:?}"),
            }
        }
    }

    /// Reserve the spill slots a Match's plan asks for (the difference to what it already holds).
    fn reserve(&mut self, rec: &MatchRecord) {
        for (acct, n) in rec.room_plan() {
            let have = self.reserved.get(&(rec.id, acct)).copied().unwrap_or(0);
            if n > have {
                self.grow_spill(&acct, n - have);
                self.reserved.insert((rec.id, acct), n);
            }
        }
    }

    fn free(&mut self, who: &Key) -> u64 {
        self.pool(who, |p, _| Ok(p.free())).unwrap()
    }

    fn lines_of(&self, who: &Key) -> Vec<Line> {
        let a = &self.accts[who];
        let mut v: Vec<Line> = LineStore::new(a.basket.as_slice())
            .unwrap()
            .lines()
            .collect();
        v.extend(LineStore::new(a.spill.as_slice()).unwrap().lines());
        v
    }
}

impl Settlement for World {
    fn books(&mut self) -> &mut dyn SourceBooks {
        &mut self.books
    }

    fn sync_source(&mut self, source: &Key) -> LcResult<()> {
        self.ev.push(Ev::Sync(*source));
        let Some(t) = self.target.get(source).copied() else {
            return Ok(());
        };
        let b = self.books.get_mut(source).unwrap();
        if t > b.h {
            let shares = (t - b.h) >> 32;
            b.land(t, shares)?;
        }
        Ok(())
    }

    fn credit(&mut self, owner: &Key, line: &Line) -> LcResult<Placed> {
        let placed = self.pool(owner, |p, books| p.put(books, line))?;
        self.ev.push(Ev::Credit {
            m: self.cur.unwrap(),
            owner: *owner,
            src: line.source,
            class: line.class,
            amount: line.amount,
        });
        Ok(placed)
    }

    fn credit_fee(&mut self, class: u8, owner: Option<&Key>, line: &Line) -> LcResult<()> {
        match owner {
            Some(o) => {
                self.pool(o, |p, books| p.put(books, line))?;
            }
            None => {
                let mut counter = self
                    .counters
                    .get(&(class, line.source))
                    .copied()
                    .unwrap_or_else(|| SourceBook::blank_line(SIDE_OWN, 0, line.source, class, 0));
                let mut l = *line;
                self.books.get_mut(&line.source).unwrap().transfer(
                    &mut l,
                    &mut counter,
                    line.amount,
                )?;
                self.counters.insert((class, line.source), counter);
            }
        }
        self.ev.push(Ev::Fee {
            m: self.cur.unwrap(),
            class,
            owner: owner.copied(),
            src: line.source,
            amount: line.amount,
        });
        Ok(())
    }
}

fn terms(studio_outside: bool, pb: u16, sb: u16) -> Terms {
    Terms {
        platform_bps: pb,
        studio_bps: sb,
        studio_owner: studio_outside.then(|| key(OUTSIDE)),
    }
}

fn id(n: u8, c: u64) -> MatchId {
    MatchId {
        opener: key(n),
        n: c,
    }
}

/// Pot lines straight from a list (not from a basket), for directed tests.
fn pot(w: &mut World, owner: u8, lines: &[(u8, u8, u64)]) -> PotPages {
    let mut p = PotPages::new(key(owner));
    let mut sorted = lines.to_vec();
    sorted.sort_by_key(|l| (l.0, l.1));
    for (i, (src, _tr, amount)) in sorted.iter().enumerate() {
        let mut line = SourceBook::blank_line(SIDE_OWN, i as i64, key(*src), CLASS_GENERAL, 0);
        w.books
            .get_mut(&key(*src))
            .unwrap()
            .issue(&mut line, *amount)
            .unwrap();
        *w.issued.get_mut(&key(*src)).unwrap() += amount;
        p.push(&line).unwrap();
    }
    p
}

fn party(p: u8, f: u8, share: u16) -> Party {
    Party {
        player: key(p),
        funder: key(f),
        share_bps: share,
    }
}

fn open_with(
    w: &mut World,
    mid: MatchId,
    t: Terms,
    entry: u64,
    a: Party,
    lines: &[(u8, u8, u64)],
    now: i64,
) -> MatchRecord {
    let pa = pot(w, a.funder[0], lines);
    let rec = MatchRecord::open(
        mid,
        MatchMeta::default(),
        key(GAME),
        key(AUTH),
        SLOT,
        t,
        entry,
        &SIZES,
        a,
        pa,
        now,
    )
    .unwrap();
    w.reserve(&rec);
    rec
}

fn join_with(w: &mut World, rec: &mut MatchRecord, b: Party, lines: &[(u8, u8, u64)], now: i64) {
    let pb = pot(w, b.funder[0], lines);
    rec.join(b, pb, now).unwrap();
    w.reserve(rec);
}

fn run_all(w: &mut World, rec: &mut MatchRecord, steps: u32) -> Vec<ChunkReport> {
    w.cur = Some(rec.id);
    let mut out = vec![];
    for _ in 0..1000 {
        let r = rec.chunk(w, steps).unwrap();
        assert!(r.blocked.is_none());
        let done = r.done;
        out.push(r);
        if done {
            return out;
        }
    }
    panic!("never finished");
}

fn credits(w: &World, m: MatchId) -> BTreeMap<(Key, Key, u8), u64> {
    let mut out = BTreeMap::new();
    for e in &w.ev {
        if let Ev::Credit {
            m: mm,
            owner,
            src,
            class,
            amount,
        } = e
        {
            if *mm == m {
                *out.entry((*owner, *src, *class)).or_insert(0) += amount;
            }
        }
    }
    out
}

fn fees(w: &World, m: MatchId) -> BTreeMap<(u8, Option<Key>, Key), u64> {
    let mut out = BTreeMap::new();
    for e in &w.ev {
        if let Ev::Fee {
            m: mm,
            class,
            owner,
            src,
            amount,
        } = e
        {
            if *mm == m {
                *out.entry((*class, *owner, *src)).or_insert(0) += amount;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Directed tests
// ---------------------------------------------------------------------------------------------

#[test]
fn match_ids_come_from_a_counter_that_only_grows() {
    let mut c = MatchCounter::new();
    let a = c.take(key(1)).unwrap();
    let b = c.take(key(1)).unwrap();
    assert_eq!((a.n, b.n), (0, 1));
    assert_ne!(a.seed(), b.seed());
    assert_ne!(a.seed(), id(2, 0).seed());
    let mut full = MatchCounter::from_next(u64::MAX);
    assert_eq!(full.take(key(1)), Err(LifecycleError::Math));
    assert_eq!(full.next(), u64::MAX);
}

#[test]
fn a_win_cuts_the_fees_from_as_few_loser_lines_as_possible_largest_first() {
    let mut rng = Rng(7);
    let mut w = World::new(&mut rng);
    // loser lines 5, 8, 60, 20, 7 = 100; Platform 5% of 200 = 10, Studio 3% = 6, Leaderboard 1% = 2
    let t = terms(false, 500, 300);
    let mut rec = open_with(
        &mut w,
        id(1, 0),
        t,
        100,
        party(1, 1, 0),
        &[(100, 0, 100)],
        0,
    );
    join_with(
        &mut w,
        &mut rec,
        party(2, 2, 0),
        &[
            (100, 0, 5),
            (101, 0, 8),
            (102, 0, 60),
            (103, 0, 20),
            (100, 1, 7),
        ],
        10,
    );
    rec.start_settle(20, &key(AUTH), SLOT, Outcome::Winner(0), 100)
        .unwrap();
    let run = rec.run().unwrap();
    assert_eq!(run.fees, [10, 6, 2]);
    // 18 Gemas in total: the 60 line alone covers them
    let lines: std::collections::BTreeSet<u32> = run.cuts.iter().map(|c| c.line).collect();
    assert_eq!(lines.len(), 1, "{:?}", run.cuts);
    let classes: Vec<u8> = run.cuts.iter().map(|c| c.class).collect();
    assert_eq!(
        classes,
        vec![CLASS_PLATFORM, CLASS_STUDIO, CLASS_LEADERBOARD]
    );
    run_all(&mut w, &mut rec, 2);
    let f = fees(&w, rec.id);
    assert_eq!(f.values().sum::<u64>(), 18);
    assert_eq!(rec.remaining(), 0);
}

#[test]
fn payout_order_is_platform_studio_leaderboard_then_holders() {
    let mut rng = Rng(8);
    let mut w = World::new(&mut rng);
    let mut rec = open_with(
        &mut w,
        id(1, 0),
        terms(true, 500, 300),
        100,
        party(1, 1, 0),
        &[(100, 0, 40), (101, 0, 60)],
        0,
    );
    join_with(&mut w, &mut rec, party(2, 2, 0), &[(102, 0, 100)], 5);
    rec.start_settle(6, &key(AUTH), SLOT, Outcome::Winner(1), 100)
        .unwrap();
    run_all(&mut w, &mut rec, 1);
    let ranks: Vec<u8> =
        w.ev.iter()
            .filter_map(|e| match e {
                Ev::Fee { class, .. } => Some(*class),
                Ev::Credit { .. } => Some(CLASS_GENERAL),
                Ev::Sync(_) => None,
            })
            .collect();
    let mut sorted = ranks.clone();
    sorted.sort();
    assert_eq!(ranks, sorted);
    assert_eq!(
        &ranks[..3],
        &[CLASS_PLATFORM, CLASS_STUDIO, CLASS_LEADERBOARD]
    );
    // the outside studio's fee is a line in its basket
    assert!(w
        .lines_of(&key(OUTSIDE))
        .iter()
        .any(|l| l.class == CLASS_STUDIO && l.amount == 6));
}

#[test]
fn every_fee_cut_syncs_its_source_first() {
    let mut rng = Rng(9);
    let mut w = World::new(&mut rng);
    w.target.insert(key(102), fp(30));
    let mut rec = open_with(
        &mut w,
        id(1, 0),
        terms(false, 500, 0),
        100,
        party(1, 1, 0),
        &[(100, 0, 100)],
        0,
    );
    join_with(&mut w, &mut rec, party(2, 2, 0), &[(102, 0, 100)], 5);
    rec.start_settle(6, &key(AUTH), SLOT, Outcome::Winner(0), 0)
        .unwrap();
    run_all(&mut w, &mut rec, 5);
    let at =
        w.ev.iter()
            .position(|e| matches!(e, Ev::Fee { .. }))
            .unwrap();
    assert_eq!(w.ev[at - 1], Ev::Sync(key(102)));
    // the Platform counter only got yield landed after the cut: the 30 landed first, so the
    // fee line was cut with ready already in the loser's line
    assert!(w.books[&key(102)].h >= fp(30));
}

#[test]
fn settlement_must_start_before_the_absolute_deadline_and_a_running_one_is_never_cut_short() {
    let mut rng = Rng(10);
    let mut w = World::new(&mut rng);
    let mut rec = open_with(
        &mut w,
        id(1, 0),
        terms(false, 500, 0),
        100,
        party(1, 1, 0),
        &[(100, 0, 100)],
        1000,
    );
    join_with(&mut w, &mut rec, party(2, 2, 0), &[(102, 0, 100)], 1005);
    let abs = rec.deadline_abs;
    assert_eq!(abs, 1000 + MAX_MATCH_LIFETIME_SECS);
    // extensions never reach past it
    assert!(rec.extend_deadline(1010, abs).is_ok());
    assert_eq!(
        rec.extend_deadline(abs - 10, abs + 1),
        Err(LifecycleError::InvalidDeadline)
    );
    // at the deadline settlement can't start, refund can, by anyone
    let mut late = rec.clone();
    assert_eq!(
        late.start_settle(abs, &key(AUTH), SLOT, Outcome::Winner(0), 0),
        Err(LifecycleError::PastAbsoluteDeadline)
    );
    assert!(late.start_refund(abs, RefundBy::Anyone, SLOT).is_ok());
    // started in time, the chunks run on after the deadline
    rec.start_settle(abs - 1, &key(AUTH), SLOT, Outcome::Winner(1), 0)
        .unwrap();
    w.cur = Some(rec.id);
    let r = rec.chunk(&mut w, 1).unwrap();
    assert_eq!(r.steps, 1);
    let rest = run_all(&mut w, &mut rec, 1);
    assert!(rest.last().unwrap().done);
    assert_eq!(rec.stage(), Stage::Closed);
}

#[test]
fn a_redeployed_game_can_only_refund_and_anyone_may_start_it() {
    let mut rng = Rng(11);
    let mut w = World::new(&mut rng);
    let mut rec = open_with(
        &mut w,
        id(1, 0),
        terms(false, 500, 0),
        100,
        party(1, 1, 0),
        &[(100, 0, 100)],
        0,
    );
    join_with(&mut w, &mut rec, party(2, 2, 0), &[(102, 0, 100)], 5);
    assert_eq!(
        rec.start_settle(6, &key(AUTH), SLOT + 1, Outcome::Winner(0), 0),
        Err(LifecycleError::GameUpgraded)
    );
    assert_eq!(rec.stage(), Stage::Active);
    assert_eq!(
        rec.start_refund(6, RefundBy::Anyone, SLOT),
        Err(LifecycleError::NotExpired)
    );
    let r = rec.start_refund(6, RefundBy::Anyone, SLOT + 1).unwrap();
    assert_eq!(r.kind, RunKind::GameUpgraded);
    run_all(&mut w, &mut rec, 3);
    let c = credits(&w, rec.id);
    assert_eq!(c[&(key(1), key(100), CLASS_GENERAL)], 100);
    assert_eq!(c[&(key(2), key(102), CLASS_GENERAL)], 100);
    assert!(fees(&w, rec.id).is_empty());
}

#[test]
fn settle_and_refund_exclude_each_other() {
    let mut rng = Rng(12);
    let mut w = World::new(&mut rng);
    let mut rec = open_with(
        &mut w,
        id(1, 0),
        terms(false, 500, 0),
        100,
        party(1, 1, 0),
        &[(100, 0, 100)],
        0,
    );
    join_with(&mut w, &mut rec, party(2, 2, 0), &[(102, 0, 100)], 5);
    rec.start_settle(6, &key(AUTH), SLOT, Outcome::Draw, 0)
        .unwrap();
    let frozen = rec.clone();
    assert_eq!(
        rec.start_refund(7, RefundBy::Game(key(AUTH)), SLOT),
        Err(LifecycleError::InvalidStage)
    );
    assert_eq!(
        rec.start_settle(7, &key(AUTH), SLOT, Outcome::Winner(0), 0),
        Err(LifecycleError::InvalidStage)
    );
    assert_eq!(rec, frozen);
    let mut rec2 = open_with(
        &mut w,
        id(1, 1),
        terms(false, 500, 0),
        100,
        party(1, 1, 0),
        &[(100, 0, 100)],
        0,
    );
    rec2.start_refund(1, RefundBy::Opener(key(1)), SLOT)
        .unwrap();
    assert_eq!(
        rec2.start_refund(2, RefundBy::Opener(key(1)), SLOT),
        Err(LifecycleError::InvalidStage)
    );
}

#[test]
fn no_show_charges_the_platform_fee_once_per_side_and_returns_the_rest() {
    let mut rng = Rng(13);
    let mut w = World::new(&mut rng);
    let mut rec = open_with(
        &mut w,
        id(1, 0),
        terms(false, 500, 300),
        100,
        party(1, 1, 0),
        &[(100, 0, 30), (101, 0, 70)],
        0,
    );
    // the opener cannot be charged before someone joined
    assert_eq!(
        rec.start_settle(1, &key(AUTH), SLOT, Outcome::NoShow, 0),
        Err(LifecycleError::InvalidStage)
    );
    join_with(&mut w, &mut rec, party(2, 2, 0), &[(102, 0, 100)], 5);
    rec.start_settle(6, &key(AUTH), SLOT, Outcome::NoShow, 100)
        .unwrap();
    run_all(&mut w, &mut rec, 4);
    let f = fees(&w, rec.id);
    // 5% of each 100-Gema entry, from the largest line of each side
    assert_eq!(f.values().sum::<u64>(), 10);
    assert!(f.keys().all(|(c, _, _)| *c == CLASS_PLATFORM));
    assert_eq!(f[&(CLASS_PLATFORM, None, key(101))], 5);
    assert_eq!(f[&(CLASS_PLATFORM, None, key(102))], 5);
    let c = credits(&w, rec.id);
    assert_eq!(c[&(key(1), key(100), CLASS_GENERAL)], 30);
    assert_eq!(c[&(key(1), key(101), CLASS_GENERAL)], 65);
    assert_eq!(c[&(key(2), key(102), CLASS_GENERAL)], 95);
}

#[test]
fn a_backed_win_returns_the_backers_entry_then_splits_the_surplus_by_the_offers_share() {
    let mut rng = Rng(14);
    let mut w = World::new(&mut rng);
    // Player 1 backed by funder 5 (Offer share 25%); loser 2 has lines 10, 40, 50
    let mut rec = open_with(
        &mut w,
        id(1, 0),
        terms(false, 500, 0),
        100,
        party(1, 5, 2500),
        &[(100, 0, 100)],
        0,
    );
    join_with(
        &mut w,
        &mut rec,
        party(2, 2, 0),
        &[(100, 1, 10), (101, 0, 40), (102, 0, 50)],
        5,
    );
    rec.start_settle(6, &key(AUTH), SLOT, Outcome::Winner(0), 0)
        .unwrap();
    // surplus 100 - 10 = 90; the Player's 25% = 22
    assert_eq!(rec.run().unwrap().player_left, 22);
    run_all(&mut w, &mut rec, 1);
    let c = credits(&w, rec.id);
    let player: u64 = c
        .iter()
        .filter(|((o, _, _), _)| *o == key(1))
        .map(|(_, a)| a)
        .sum();
    let funder: u64 = c
        .iter()
        .filter(|((o, _, _), _)| *o == key(5))
        .map(|(_, a)| a)
        .sum();
    assert_eq!(player, 22);
    assert_eq!(funder, 100 + 90 - 22);
    // the first credit is the Backer's own entry back (after the fee cut)
    let first_credit = w.ev.iter().find_map(|e| match e {
        Ev::Credit { owner, .. } => Some(*owner),
        _ => None,
    });
    assert_eq!(first_credit, Some(key(5)));
}

#[test]
fn without_reserved_room_a_chunk_blocks_changes_nothing_and_resumes_after_growth() {
    let mut rng = Rng(15);
    let mut w = World::new(&mut rng);
    // fill account 1's basket completely, spill has no slot
    for i in 0..8 {
        w.give(1, SIDE_OWN, 100 + i, 100, false, 3);
    }
    let a = Acct {
        basket: w.accts[&key(1)].basket.clone(),
        spill: w.accts[&key(1)].spill.clone(),
    };
    let _ = a;
    let t = terms(false, 0, 0);
    let pa = pot(&mut w, 1, &[(101, 0, 50), (102, 0, 50)]);
    let mut rec = MatchRecord::open(
        id(1, 0),
        MatchMeta::default(),
        key(GAME),
        key(AUTH),
        SLOT,
        t,
        100,
        &SIZES,
        party(1, 1, 0),
        pa,
        0,
    )
    .unwrap();
    rec.start_refund(1, RefundBy::Opener(key(1)), SLOT).unwrap();
    w.cur = Some(rec.id);
    // the basket is full and the spill has 0 slots and these keys are new
    let before = rec.clone();
    let before_lines = w.lines_of(&key(1));
    let e = rec.chunk(&mut w, 5).unwrap_err();
    assert_eq!(e, LifecycleError::Draw(DrawError::SpillFull));
    assert_eq!(rec, before);
    assert_eq!(w.lines_of(&key(1)), before_lines);
    w.grow_spill(&key(1), 2);
    let r = rec.chunk(&mut w, 5).unwrap();
    assert!(r.done && r.steps == 2 && r.blocked.is_none());
    assert_eq!(credits(&w, rec.id).values().sum::<u64>(), 100);
}

#[test]
fn a_finished_match_ignores_further_chunks_and_closes_empty() {
    let mut rng = Rng(16);
    let mut w = World::new(&mut rng);
    let mut rec = open_with(
        &mut w,
        id(1, 0),
        terms(false, 500, 0),
        100,
        party(1, 1, 0),
        &[(100, 0, 100)],
        0,
    );
    join_with(&mut w, &mut rec, party(2, 2, 0), &[(102, 0, 100)], 5);
    assert_eq!(rec.clone().close(), Err(LifecycleError::InvalidStage));
    rec.start_settle(6, &key(AUTH), SLOT, Outcome::Winner(0), 0)
        .unwrap();
    run_all(&mut w, &mut rec, 100);
    let n = w.ev.len();
    let again = rec.chunk(&mut w, 10).unwrap();
    assert!(again.done && again.steps == 0);
    assert_eq!(w.ev.len(), n);
    let closure = rec.close().unwrap();
    assert_eq!(closure.id, id(1, 0));
}

// ---------------------------------------------------------------------------------------------
// The fuzz: random Matches against an independent model
// ---------------------------------------------------------------------------------------------

type HolderMap = BTreeMap<(Key, Key, u8), u64>;
type FeeMap = BTreeMap<(u8, Option<Key>, Key), u64>;

struct Tracked {
    rec: MatchRecord,
    started: Option<(HolderMap, FeeMap)>,
    finished: bool,
    snapshot_after_done: Option<(Vec<Line>, usize)>,
}

fn add(m: &mut HolderMap, who: Key, l: &Line, amount: u64) {
    if amount > 0 {
        *m.entry((who, l.source, l.class)).or_insert(0) += amount;
    }
}

/// What every account and fee sink must have received, worked out from the Pot lines before the
/// start and the cuts the run froze, by the spec's rules and nothing else.
fn expected(before: &MatchRecord, run: &Run) -> (HolderMap, FeeMap) {
    let mut holders = HolderMap::new();
    let mut fee_map = FeeMap::new();
    let lines: [Vec<Line>; 2] = [before.pot(0).lines(), before.pot(1).lines()];
    let mut cut = [vec![0u64; lines[0].len()], vec![0u64; lines[1].len()]];
    for c in &run.cuts {
        let l = &lines[c.side as usize][c.line as usize];
        cut[c.side as usize][c.line as usize] += c.k;
        let owner = (c.class == CLASS_STUDIO)
            .then_some(before.terms.studio_owner)
            .flatten();
        *fee_map.entry((c.class, owner, l.source)).or_insert(0) += c.k;
    }
    for s in 0..2usize {
        for (i, l) in lines[s].iter().enumerate() {
            assert!(cut[s][i] <= l.amount);
        }
    }
    let party = |s: usize| if s == 0 { Some(before.a) } else { before.b };
    match run.kind {
        RunKind::Win { winner } => {
            let w = winner as usize;
            let lo = 1 - w;
            let wp = party(w).unwrap();
            for l in &lines[w] {
                add(&mut holders, wp.funder, l, l.amount);
            }
            let fee_total: u64 = run.fees.iter().sum();
            let surplus = before.entry - fee_total;
            let mut left = if wp.is_backed() {
                (surplus as u128 * wp.share_bps as u128 / 10_000) as u64
            } else {
                0
            };
            for (i, l) in lines[lo].iter().enumerate() {
                let r = l.amount - cut[lo][i];
                let to_player = if wp.is_backed() { left.min(r) } else { r };
                left -= if wp.is_backed() { to_player } else { 0 };
                add(&mut holders, wp.player, l, to_player);
                add(&mut holders, wp.funder, l, r - to_player);
            }
        }
        _ => {
            for s in 0..2usize {
                if let Some(p) = party(s) {
                    for (i, l) in lines[s].iter().enumerate() {
                        add(&mut holders, p.funder, l, l.amount - cut[s][i]);
                    }
                }
            }
        }
    }
    (holders, fee_map)
}

fn min_lines(amounts: &[u64], need: u64) -> usize {
    let mut v = amounts.to_vec();
    v.sort_by(|a, b| b.cmp(a));
    let (mut sum, mut n) = (0u64, 0usize);
    for a in v {
        if sum >= need {
            break;
        }
        sum += a;
        n += 1;
    }
    n
}

struct Sim {
    rng: Rng,
    w: World,
    counters: BTreeMap<Key, MatchCounter>,
    ms: Vec<Tracked>,
    now: i64,
    cov: [usize; 12],
}

const C_BACKED: usize = 0;
const C_NOSHOW: usize = 1;
const C_DRAW: usize = 2;
const C_WIN: usize = 3;
const C_SPILL_USED: usize = 4;
const C_REFUND_ANY: usize = 5;
const C_UPGRADED: usize = 6;
const C_PAST_ABS: usize = 7;
const C_MID_PAST_ABS: usize = 8;
const C_OUTSIDE: usize = 9;
const C_INTERLEAVE: usize = 10;
const C_REPLAY: usize = 11;

impl Sim {
    fn new(seed: u64) -> Sim {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        for _ in 0..4 {
            rng.next();
        }
        let mut w = World::new(&mut rng);
        for p in 1..=6u8 {
            for _ in 0..(3 + rng.below(6)) {
                let side = if rng.chance(50) { SIDE_OWN } else { SIDE_WON };
                let amount = 3 + rng.below(70);
                w.give(
                    p,
                    side,
                    rng.below(50) as i64,
                    100 + rng.below(4) as u8,
                    rng.chance(30),
                    amount,
                );
            }
        }
        Sim {
            rng,
            w,
            counters: BTreeMap::new(),
            ms: vec![],
            now: 1_000,
            cov: [0; 12],
        }
    }

    fn open(&mut self) {
        let r = &mut self.rng;
        let player = 1 + r.below(6) as u8;
        let backed = r.chance(35);
        let funder = if backed {
            let f = 1 + r.below(6) as u8;
            if f == player {
                player
            } else {
                f
            }
        } else {
            player
        };
        let entry = SIZES[r.below(3) as usize];
        let share = if backed { r.below(10_001) as u16 } else { 0 };
        let t = terms(r.chance(40), 200 + r.below(500) as u16, r.below(400) as u16);
        let mid = {
            let c = self.counters.entry(key(player)).or_default();
            c.take(key(player)).unwrap()
        };
        let a = Party {
            player: key(player),
            funder: key(funder),
            share_bps: share,
        };
        let fk = key(funder);
        if self.w.free(&fk) < entry {
            return;
        }
        let pot_a = self
            .w
            .pool(&fk, |p, books| p.draw_direct(books, fk, entry, 1000))
            .unwrap();
        let rec = MatchRecord::open(
            mid,
            MatchMeta::default(),
            key(GAME),
            key(AUTH),
            SLOT,
            t,
            entry,
            &SIZES,
            a,
            pot_a,
            self.now,
        )
        .unwrap();
        self.w.reserve(&rec);
        self.ms.push(Tracked {
            rec,
            started: None,
            finished: false,
            snapshot_after_done: None,
        });
    }

    fn join(&mut self) {
        let open: Vec<usize> = (0..self.ms.len())
            .filter(|i| self.ms[*i].rec.stage() == Stage::Open)
            .collect();
        if open.is_empty() {
            return;
        }
        let i = open[self.rng.below(open.len() as u64) as usize];
        let player = 1 + self.rng.below(6) as u8;
        let backed = self.rng.chance(30);
        let funder = if backed {
            1 + self.rng.below(6) as u8
        } else {
            player
        };
        let share = if backed {
            self.rng.below(10_001) as u16
        } else {
            0
        };
        let entry = self.ms[i].rec.entry;
        let b = Party {
            player: key(player),
            funder: key(funder),
            share_bps: share,
        };
        let fk = key(funder);
        if self.w.free(&fk) < entry {
            return;
        }
        let a = self.ms[i].rec.a;
        let selfmatch = b.player == a.player || b.funder == a.funder || b.player == a.funder;
        let expired = self.now >= self.ms[i].rec.deadline;
        let pot_b = self
            .w
            .pool(&fk, |p, books| p.draw_direct(books, fk, entry, 1000))
            .unwrap();
        let before = self.ms[i].rec.clone();
        let r = self.ms[i].rec.join(b, pot_b.clone(), self.now);
        match (expired, selfmatch) {
            (true, _) => assert_eq!(r, Err(LifecycleError::Expired)),
            (false, true) => assert_eq!(r, Err(LifecycleError::SelfMatch)),
            _ => r.unwrap(),
        }
        if r.is_err() {
            assert_eq!(self.ms[i].rec, before);
            // the drawn lines go back so nothing is lost
            for l in pot_b.lines() {
                self.w
                    .pool(&fk, |p, books| p.put(books, &l))
                    .unwrap_or_else(|_| {
                        self.w.grow_spill(&fk, 1);
                        self.w.organic_grown += 1;
                        self.w.pool(&fk, |p, books| p.put(books, &l)).unwrap()
                    });
            }
        } else {
            self.w.reserve(&self.ms[i].rec);
            if backed || self.ms[i].rec.a.is_backed() {
                self.cov[C_BACKED] += 1;
            }
        }
    }

    fn pick(&mut self, f: impl Fn(&Tracked) -> bool) -> Option<usize> {
        let c: Vec<usize> = (0..self.ms.len()).filter(|i| f(&self.ms[*i])).collect();
        (!c.is_empty()).then(|| c[self.rng.below(c.len() as u64) as usize])
    }

    fn start_settle(&mut self) {
        let Some(i) = self.pick(|t| matches!(t.rec.stage(), Stage::Active | Stage::Open)) else {
            return;
        };
        let good_auth = self.rng.chance(90);
        let slot = if self.rng.chance(12) { SLOT + 1 } else { SLOT };
        let outcome = match self.rng.below(10) {
            0 => Outcome::Draw,
            1 => Outcome::NoShow,
            n => Outcome::Winner((n % 2) as u8),
        };
        let lb = self.rng.below(200) as u16;
        let auth = if good_auth { key(AUTH) } else { key(1) };
        let t = &mut self.ms[i];
        let before = t.rec.clone();
        let pre = t.rec.clone();
        let r = t.rec.start_settle(self.now, &auth, slot, outcome, lb);
        let want = if before.stage() != Stage::Active {
            Some(LifecycleError::InvalidStage)
        } else if !good_auth {
            Some(LifecycleError::NotAuthorised)
        } else if self.now >= before.deadline_abs {
            Some(LifecycleError::PastAbsoluteDeadline)
        } else if slot != SLOT {
            Some(LifecycleError::GameUpgraded)
        } else {
            None
        };
        match want {
            Some(e) => {
                assert_eq!(r, Err(e));
                assert_eq!(t.rec, before, "a refused start changed the record");
                if e == LifecycleError::PastAbsoluteDeadline {
                    self.cov[C_PAST_ABS] += 1;
                }
                if e == LifecycleError::GameUpgraded {
                    self.cov[C_UPGRADED] += 1;
                }
            }
            None => {
                let receipt = r.unwrap();
                assert_eq!(receipt.id, t.rec.id);
                let run = t.rec.run().unwrap().clone();
                match outcome {
                    Outcome::Draw => {
                        assert_eq!(t.rec.stage(), Stage::Refunding);
                        self.cov[C_DRAW] += 1;
                    }
                    Outcome::NoShow => {
                        assert_eq!(t.rec.stage(), Stage::Settling);
                        self.cov[C_NOSHOW] += 1;
                    }
                    Outcome::Winner(_) => {
                        assert_eq!(t.rec.stage(), Stage::Settling);
                        self.cov[C_WIN] += 1;
                        if before.terms.studio_owner.is_some() {
                            self.cov[C_OUTSIDE] += 1;
                        }
                    }
                }
                Self::check_cuts(&pre, &run);
                t.started = Some(expected(&pre, &run));
            }
        }
    }

    /// The fees are exactly the spec's amounts and come from the fewest lines.
    fn check_cuts(pre: &MatchRecord, run: &Run) {
        let pot2 = pre.entry as u128 * 2;
        match run.kind {
            RunKind::Win { winner } => {
                let lo = 1 - winner;
                let total: u64 = run.fees.iter().sum();
                let cut_sum: u64 = run.cuts.iter().map(|c| c.k).sum();
                assert_eq!(cut_sum, total);
                assert_eq!(
                    run.fees[0] as u128,
                    pot2 * pre.terms.platform_bps as u128 / 10_000
                );
                assert_eq!(
                    run.fees[1] as u128,
                    pot2 * pre.terms.studio_bps as u128 / 10_000
                );
                let amounts: Vec<u64> = pre.pot(lo).lines().iter().map(|l| l.amount).collect();
                let used: std::collections::BTreeSet<u32> =
                    run.cuts.iter().map(|c| c.line).collect();
                assert_eq!(
                    used.len(),
                    min_lines(&amounts, total),
                    "not the fewest lines"
                );
                // classes never go backwards
                let cl: Vec<u8> = run.cuts.iter().map(|c| c.class).collect();
                assert!(cl.windows(2).all(|w| w[0] <= w[1]));
            }
            RunKind::NoShow => {
                let each = (pre.entry as u128 * pre.terms.platform_bps as u128 / 10_000) as u64;
                for s in 0..2u8 {
                    let amounts: Vec<u64> = pre.pot(s).lines().iter().map(|l| l.amount).collect();
                    let cuts: Vec<&FeeCut> = run.cuts.iter().filter(|c| c.side == s).collect();
                    assert_eq!(cuts.iter().map(|c| c.k).sum::<u64>(), each);
                    let used: std::collections::BTreeSet<u32> =
                        cuts.iter().map(|c| c.line).collect();
                    assert_eq!(used.len(), min_lines(&amounts, each));
                }
            }
            _ => assert!(run.cuts.is_empty()),
        }
    }

    fn start_refund(&mut self) {
        let Some(i) = self.pick(|t| matches!(t.rec.stage(), Stage::Active | Stage::Open)) else {
            return;
        };
        let slot = if self.rng.chance(15) { SLOT + 1 } else { SLOT };
        let by = match self.rng.below(3) {
            0 => RefundBy::Game(if self.rng.chance(90) {
                key(AUTH)
            } else {
                key(2)
            }),
            1 => RefundBy::Opener(if self.rng.chance(90) {
                self.ms[i].rec.a.player
            } else {
                key(6)
            }),
            _ => RefundBy::Anyone,
        };
        let t = &mut self.ms[i];
        let before = t.rec.clone();
        let r = t.rec.start_refund(self.now, by, slot);
        let want = match by {
            RefundBy::Game(k) => (k != key(AUTH)).then_some(LifecycleError::NotAuthorised),
            RefundBy::Opener(k) => (before.stage() != Stage::Open || k != before.a.player)
                .then_some(LifecycleError::NotAuthorised),
            RefundBy::Anyone => {
                (slot == SLOT && self.now < before.deadline).then_some(LifecycleError::NotExpired)
            }
        };
        match want {
            Some(e) => {
                assert_eq!(r, Err(e));
                assert_eq!(t.rec, before);
            }
            None => {
                r.unwrap();
                assert_eq!(t.rec.stage(), Stage::Refunding);
                if matches!(by, RefundBy::Anyone) {
                    self.cov[C_REFUND_ANY] += 1;
                    if slot != SLOT {
                        self.cov[C_UPGRADED] += 1;
                    }
                }
                let run = t.rec.run().unwrap().clone();
                t.started = Some(expected(&before, &run));
            }
        }
    }

    fn chunk(&mut self) {
        let Some(i) = self.pick(|t| !t.finished && t.started.is_some()) else {
            return;
        };
        let steps = self.rng.below(6) as u32;
        self.w.cur = Some(self.ms[i].rec.id);
        let busy = self
            .ms
            .iter()
            .filter(|t| t.started.is_some() && !t.finished)
            .count();
        if busy > 1 {
            self.cov[C_INTERLEAVE] += 1;
        }
        let before_spill: usize = self.spill_used();
        if self.now >= self.ms[i].rec.deadline_abs {
            self.cov[C_MID_PAST_ABS] += 1;
        }
        let r = self.ms[i]
            .rec
            .chunk(&mut self.w, steps)
            .expect("a started Match can always make progress: room is reserved");
        assert!(r.blocked.is_none(), "{r:?}");
        if self.spill_used() > before_spill {
            self.cov[C_SPILL_USED] += 1;
        }
        if r.done {
            self.finish(i);
        }
        // replaying the same chunk is harmless
        if self.rng.chance(20) {
            let snap = self.ms[i].rec.clone();
            let ev = self.w.ev.len();
            let r2 = self.ms[i].rec.chunk(&mut self.w, 0).unwrap();
            assert_eq!(r2.steps, 0);
            assert_eq!(self.w.ev.len(), ev);
            if r.done {
                assert!(r2.done);
                assert_eq!(self.ms[i].rec.stage(), Stage::Closed);
                assert_eq!(
                    self.ms[i].rec.run().unwrap().chunks,
                    snap.run().unwrap().chunks
                );
                self.cov[C_REPLAY] += 1;
            }
        }
    }

    fn spill_used(&self) -> usize {
        self.w
            .accts
            .values()
            .map(|a| LineStore::new(a.spill.as_slice()).unwrap().len())
            .sum()
    }

    /// The Match is complete: what was paid is exactly what the model expected, once.
    fn finish(&mut self, i: usize) {
        let t = &mut self.ms[i];
        t.finished = true;
        assert_eq!(t.rec.stage(), Stage::Closed);
        assert_eq!(t.rec.remaining(), 0);
        let (eh, ef) = t.started.take().unwrap();
        let got_h = credits(&self.w, t.rec.id);
        let got_f = fees(&self.w, t.rec.id);
        assert_eq!(got_h, eh, "holders paid differently from the model");
        assert_eq!(got_f, ef, "fees paid differently from the model");
        // payout order inside this Match: fee classes ascending, then holders
        let mut last = 0u8;
        let mut seen_holder = false;
        let mut synced: Option<Key> = None;
        for e in &self.w.ev {
            match e {
                Ev::Sync(s) => synced = Some(*s),
                Ev::Fee { m, class, src, .. } if *m == t.rec.id => {
                    assert!(!seen_holder, "a fee after a holder");
                    if matches!(t.rec.run().unwrap().kind, RunKind::Win { .. }) {
                        assert!(*class >= last, "fee classes out of order");
                    }
                    last = *class;
                    assert_eq!(synced, Some(*src), "a fee cut without syncing its Source");
                }
                Ev::Credit { m, .. } if *m == t.rec.id => seen_holder = true,
                _ => {}
            }
        }
        t.snapshot_after_done = Some((vec![], self.w.ev.len()));
        let rec = t.rec.clone();
        let closure = rec.close().unwrap();
        assert_eq!(closure.id, t.rec.id);
    }

    fn other(&mut self) {
        // organic credits and yield landing
        if self.rng.chance(50) {
            let p = 1 + self.rng.below(6) as u8;
            let amount = 1 + self.rng.below(30);
            let src = 100 + self.rng.below(4) as u8;
            let side = if self.rng.chance(50) {
                SIDE_OWN
            } else {
                SIDE_WON
            };
            let due = self.rng.below(60) as i64;
            let ext = self.rng.chance(25);
            self.w.give(p, side, due, src, ext, amount);
        } else {
            let src = key(100 + self.rng.below(4) as u8);
            let bump = fp(self.rng.below(40)) + self.rng.below(1 << 20) as u128;
            let h = self.w.books[&src].h;
            let cur = self.w.target.get(&src).copied().unwrap_or(h).max(h);
            self.w.target.insert(src, cur + bump);
        }
    }

    fn advance(&mut self) {
        self.now += match self.rng.below(10) {
            0 => self.rng.below(4 * 24 * 3600) as i64,
            1 => self.rng.below(MAX_MATCH_LIFETIME_SECS as u64) as i64,
            _ => self.rng.below(2000) as i64,
        };
    }

    fn extend(&mut self) {
        let Some(i) = self.pick(|t| matches!(t.rec.stage(), Stage::Active | Stage::Open)) else {
            return;
        };
        let t = &mut self.ms[i];
        let new = t.rec.deadline + self.rng.below(5 * 24 * 3600) as i64;
        let before = t.rec.clone();
        let abs = t.rec.deadline_abs;
        let r = t.rec.extend_deadline(self.now, new);
        let cap = (self.now + MAX_EXTENSION_SECS).min(abs);
        if self.now >= before.deadline {
            assert_eq!(r, Err(LifecycleError::Expired));
        } else if new > cap {
            assert_eq!(r, Err(LifecycleError::InvalidDeadline));
            assert_eq!(t.rec, before);
        } else {
            r.unwrap();
            assert!(t.rec.deadline <= abs);
        }
        assert_eq!(t.rec.deadline_abs, abs);
    }

    fn invariants(&mut self) {
        // no Gema created or lost, and every Source's books hold together
        let mut by_src: BTreeMap<Key, Vec<Line>> = BTreeMap::new();
        for k in self.w.accts.keys().copied().collect::<Vec<_>>() {
            let a = &self.w.accts[&k];
            LineStore::new(a.basket.as_slice())
                .unwrap()
                .check()
                .unwrap();
            LineStore::new(a.spill.as_slice()).unwrap().check().unwrap();
            for l in self.w.lines_of(&k) {
                by_src.entry(l.source).or_default().push(l);
            }
        }
        for t in &self.ms {
            for s in 0..2u8 {
                t.rec.pot(s).check().unwrap();
                for l in t.rec.pot(s).lines() {
                    by_src.entry(l.source).or_default().push(l);
                }
            }
        }
        for l in self.w.counters.values() {
            by_src.entry(l.source).or_default().push(*l);
        }
        for (src, issued) in &self.w.issued {
            let lines = by_src.get(src).cloned().unwrap_or_default();
            let total: u64 = lines.iter().map(|l| l.amount).sum();
            assert_eq!(total, *issued, "Gemas of a Source were created or lost");
            self.w.books[src].check(0, lines.iter()).unwrap();
        }
        // the room contract: spill never needed more than the organic grants plus reservations
        let granted: usize = self
            .w
            .accts
            .values()
            .map(|a| LineStore::new(a.spill.as_slice()).unwrap().capacity())
            .sum();
        let reserved: usize = self.w.reserved.values().sum();
        assert_eq!(granted, reserved + self.w.organic_grown);
        // exclusive states and one way: a started Match only moves forward
        for t in &self.ms {
            match t.rec.stage() {
                Stage::Settling => assert!(!t.rec.run().unwrap().kind.is_refund()),
                Stage::Refunding => assert!(t.rec.run().unwrap().kind.is_refund()),
                _ => {}
            }
        }
    }

    fn step(&mut self) {
        match self.rng.below(100) {
            0..=14 => self.open(),
            15..=30 => self.join(),
            31..=40 => self.advance(),
            41..=46 => self.extend(),
            47..=54 => self.start_settle(),
            55..=58 => self.start_refund(),
            59..=84 => self.chunk(),
            _ => self.other(),
        }
        self.invariants();
    }

    fn drain(&mut self) {
        // everything started finishes, whatever is left Open or Active is refunded
        for i in 0..self.ms.len() {
            if matches!(self.ms[i].rec.stage(), Stage::Open | Stage::Active) {
                let t = &mut self.ms[i];
                let before = t.rec.clone();
                t.rec
                    .start_refund(self.now, RefundBy::Game(key(AUTH)), SLOT)
                    .unwrap();
                let run = t.rec.run().unwrap().clone();
                t.started = Some(expected(&before, &run));
            }
            if !self.ms[i].finished {
                self.w.cur = Some(self.ms[i].rec.id);
                loop {
                    let r = self.ms[i].rec.chunk(&mut self.w, 3).unwrap();
                    assert!(r.blocked.is_none());
                    if r.done {
                        self.finish(i);
                        break;
                    }
                }
            }
            self.invariants();
        }
        // every id is unique
        let mut ids: Vec<MatchId> = self.ms.iter().map(|t| t.rec.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), self.ms.len());
    }
}

fn run(seed: u64, ops: usize) -> [usize; 12] {
    let mut s = Sim::new(seed);
    for _ in 0..ops {
        s.step();
    }
    s.drain();
    s.cov
}

fn seeds() -> u64 {
    std::env::var("LIFECYCLE_FUZZ_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(400)
}

#[test]
fn fuzz_match_lifecycle_against_a_model() {
    let mut cov = [0usize; 12];
    for seed in 0..seeds() {
        let c = run(seed, 220);
        for (a, b) in cov.iter_mut().zip(c) {
            *a += b;
        }
    }
    let names = [
        "backed",
        "no-show",
        "draw",
        "win",
        "spill used",
        "refund by anyone",
        "game upgraded",
        "settle refused past the absolute deadline",
        "chunk after the absolute deadline",
        "outside studio",
        "interleaved matches",
        "replay of a finished match",
    ];
    for (n, c) in names.iter().zip(cov) {
        assert!(c > 0, "the fuzz never exercised: {n}");
    }
}

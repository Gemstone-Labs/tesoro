#![allow(clippy::too_many_arguments)]

use super::{
    cancel_instant_redeem as cancel_pool, expire_instant_redeem as expire_pool,
    fill_instant_redeem as fill_pool, request_instant_redeem as request_pool, *,
};
use crate::ledger::book::checkpoint::{CheckpointStore, MemCheckpoints};
use crate::ledger::book::fp;
use crate::ledger::draw::{grow_spill_body, spill_body};
use crate::ledger::line_store::{
    required_len, LineStore, CLASS_GENERAL, CLASS_PLATFORM, SIDE_OWN, SIDE_WON,
};
use std::collections::BTreeMap;

const DUE: i64 = 5_000;
const NOW: i64 = 1_000_000;

fn key(n: u8) -> Key {
    [n; 32]
}

type Basket = LineStore<Vec<u8>>;

/// The unit tests below use accounts whose spill has no room: a credit that does not fit the
/// basket is refused (`SpillFull`). The spill itself is covered by the tests at the end.
fn no_spill(owner: Key) -> LineStore<Vec<u8>> {
    LineStore::new(spill_body(owner, 0).unwrap()).unwrap()
}

fn request_instant_redeem(
    kind: SourceKind,
    book: &mut SourceBook,
    history: &mut dyn CheckpointStore,
    basket: &mut Basket,
    key: &LineKey,
    owner: Key,
    sell: u64,
    now: i64,
    ttl: i64,
) -> CoreResult<Requested> {
    let mut sp = no_spill(owner);
    request_pool(
        kind,
        book,
        history,
        &mut Pool::new(basket, &mut sp),
        key,
        owner,
        sell,
        now,
        ttl,
    )
}

fn fill_instant_redeem(
    auth: &FillAuthority,
    signer: &Key,
    route: &mut RouteLedger,
    book: &mut SourceBook,
    history: &mut dyn CheckpointStore,
    order: &mut InstantOrder,
    treasury: &mut Basket,
    gemas: u64,
    terms: &FillTerms,
    now: i64,
) -> CoreResult<Filled> {
    let mut sp = no_spill(key(11));
    fill_pool(
        auth,
        signer,
        route,
        book,
        history,
        order,
        &mut Pool::new(treasury, &mut sp),
        gemas,
        terms,
        now,
    )
}

fn cancel_instant_redeem(
    signer: &Key,
    book: &mut SourceBook,
    history: &mut dyn CheckpointStore,
    order: &mut InstantOrder,
    basket: &mut Basket,
) -> CoreResult<u64> {
    let mut sp = no_spill(key(10));
    cancel_pool(
        signer,
        book,
        history,
        order,
        &mut Pool::new(basket, &mut sp),
    )
}

fn expire_instant_redeem(
    now: i64,
    book: &mut SourceBook,
    history: &mut dyn CheckpointStore,
    order: &mut InstantOrder,
    basket: &mut Basket,
) -> CoreResult<u64> {
    let mut sp = no_spill(key(10));
    expire_pool(now, book, history, order, &mut Pool::new(basket, &mut sp))
}

fn basket(n: u8, lines: usize) -> Basket {
    LineStore::init(vec![0u8; required_len(lines)], key(n), 255).unwrap()
}

/// A Source whose owner holds `issued` Gemas of class General.
struct Src {
    book: SourceBook,
    ck: MemCheckpoints,
    owner: Line,
    cum: u64,
    redeemed: u64,
    issued: u64,
}

impl Src {
    fn new(id: u8, issued: u64) -> Src {
        let mut book = SourceBook::new();
        let mut owner = SourceBook::blank_line(SIDE_OWN, DUE, key(id), CLASS_GENERAL, 0);
        let ck = MemCheckpoints::new(key(id));
        book.issue(&mut owner, issued, &ck).unwrap();
        Src {
            book,
            ck,
            owner,
            cum: 0,
            redeemed: 0,
            issued,
        }
    }

    /// The Source has earned `gemas` more coverage; shares are 1 per Gema.
    fn land(&mut self, gemas: u64) {
        self.cum += gemas;
        let cum = fp(self.cum);
        let shares = self.book.pending(cum) >> 32;
        self.book.land(cum, shares, &mut self.ck).unwrap();
    }

    /// Gives `k` Gemas of class `class` to the player's basket (a won line).
    fn give(&mut self, b: &mut Basket, class: u8, tranche: u8, k: u64) {
        let key = LineKey {
            side: SIDE_WON,
            due_at: DUE,
            source: self.owner.source,
            class,
            tranche,
        };
        let mut src = self.owner;
        if class != CLASS_GENERAL {
            // a class other than General: the owner needs a line of it
            src = SourceBook::blank_line(SIDE_OWN, DUE, self.owner.source, class, tranche);
            self.book.issue(&mut src, k, &self.ck).unwrap();
            self.issued += k;
        }
        let (mut dst, at) = match b.find(&key) {
            Ok(i) => (b.get(i).unwrap(), Some(i)),
            Err(_) => (
                SourceBook::blank_line(SIDE_WON, DUE, self.owner.source, class, tranche),
                None,
            ),
        };
        self.book.transfer(&mut src, &mut dst, k, &self.ck).unwrap();
        match at {
            Some(i) => b.set_line(i, &dst).unwrap(),
            None => {
                b.insert(&dst).unwrap();
            }
        }
        if class == CLASS_GENERAL {
            self.owner = src;
        } else {
            assert_eq!(src.amount, 0);
        }
    }

    fn won_key(&self, class: u8, tranche: u8) -> LineKey {
        LineKey {
            side: SIDE_WON,
            due_at: DUE,
            source: self.owner.source,
            class,
            tranche,
        }
    }

    fn check(&self, others: &[&Line]) {
        let all = std::iter::once(&self.owner).chain(others.iter().copied());
        self.book.check(self.redeemed, all).unwrap();
    }
}

fn terms(shares: u128, gemas: u64, pay: PayMode) -> FillTerms {
    FillTerms {
        rate: Rate { shares, gemas },
        fees_outstanding: 0,
        outstanding: 0,
        pay,
    }
}

fn auth() -> FillAuthority {
    FillAuthority {
        admin: key(200),
        keeper: key(201),
        keeper_fills: false,
    }
}

fn route(spendable: u128) -> RouteLedger {
    let mut r = RouteLedger::default();
    r.receive(spendable).unwrap();
    r
}

fn all_lines(stores: &[&Basket], orders: &[&InstantOrder]) -> Vec<Line> {
    let mut v: Vec<Line> = stores.iter().flat_map(|s| s.lines()).collect();
    v.extend(orders.iter().map(|o| o.line));
    v
}

fn check_all(s: &Src, stores: &[&Basket], orders: &[&InstantOrder]) {
    let lines = all_lines(stores, orders);
    let refs: Vec<&Line> = lines.iter().collect();
    s.check(&refs);
    for st in stores {
        st.check().unwrap();
    }
}

/// A Source with 10,000 Gemas, 5,000 of them in the player's basket, 2,000 Gemas of coverage landed
/// (so the player has 1,000 ready).
fn world() -> (Src, Basket, Basket) {
    let mut s = Src::new(1, 10_000);
    let mut player = basket(10, 16);
    s.give(&mut player, CLASS_GENERAL, 0, 5_000);
    s.land(2_000);
    (s, player, basket(11, 16))
}

fn request(s: &mut Src, b: &mut Basket, sell: u64) -> CoreResult<Requested> {
    let k = s.won_key(CLASS_GENERAL, 0);
    request_instant_redeem(
        SourceKind::Yield,
        &mut s.book,
        &mut s.ck,
        b,
        &k,
        key(10),
        sell,
        NOW,
        DEFAULT_ORDER_TTL_SECS,
    )
}

#[test]
fn a_request_redeems_the_ready_part_and_moves_the_rest_into_the_order() {
    let (mut s, mut player, treasury) = world();
    let r = request(&mut s, &mut player, 3_000).unwrap();
    let red = r.redeemed.unwrap();
    s.redeemed += red.gemas;
    // 2,000 landed over 10,000 Gemas: 1,000 ready (a fixed-point ulp short is allowed)
    assert!((999..=1_000).contains(&red.gemas), "{}", red.gemas);
    // one share per Gema, whole shares rounded down (an ulp short of a share pays one fewer)
    assert!((red.gemas as u128 - 1..=red.gemas as u128).contains(&red.shares));
    let o = r.order;
    assert_eq!(o.line.amount, 3_000);
    assert_eq!(
        (o.line.class, o.line.tranche, o.line.side),
        (CLASS_GENERAL, 0, SIDE_WON)
    );
    assert_eq!(o.line.source, key(1));
    assert_eq!(
        (o.owner, o.requested, o.expires_at),
        (key(10), 3_000, NOW + DEFAULT_ORDER_TTL_SECS)
    );
    // the player keeps the rest and the order's Gemas are out of the basket's totals
    assert_eq!(player.won_total(), 5_000 - red.gemas - 3_000);
    check_all(&s, &[&player, &treasury], &[&o]);
}

#[test]
fn a_request_refuses_what_it_must() {
    let (mut s, mut player, _) = world();
    let before = (player.lines().collect::<Vec<_>>(), s.book.clone());
    assert_eq!(
        request(&mut s, &mut player, 0).unwrap_err(),
        CoreError::ZeroAmount
    );
    assert_eq!(
        request(&mut s, &mut player, 5_000).unwrap_err(),
        CoreError::InsufficientGemas
    );
    let k = s.won_key(CLASS_GENERAL, 0);
    let go = |s: &mut Src, b: &mut Basket, kind, k: &LineKey, ttl| {
        request_instant_redeem(kind, &mut s.book, &mut s.ck, b, k, key(10), 10, NOW, ttl)
    };
    assert_eq!(
        go(
            &mut s,
            &mut player,
            SourceKind::Prize,
            &k,
            DEFAULT_ORDER_TTL_SECS
        )
        .unwrap_err(),
        CoreError::PrizeSourceRefused
    );
    assert_eq!(
        go(&mut s, &mut player, SourceKind::Yield, &k, 10).unwrap_err(),
        CoreError::InvalidOrderTtl
    );
    let missing = s.won_key(CLASS_GENERAL, 9);
    assert_eq!(
        go(
            &mut s,
            &mut player,
            SourceKind::Yield,
            &missing,
            DEFAULT_ORDER_TTL_SECS
        )
        .unwrap_err(),
        CoreError::LineMismatch
    );
    // own Gemas can't be sold
    let mut own = basket(12, 4);
    own.insert(&s.owner).unwrap();
    let own_key = s.owner.key();
    assert_eq!(
        go(
            &mut s,
            &mut own,
            SourceKind::Yield,
            &own_key,
            DEFAULT_ORDER_TTL_SECS
        )
        .unwrap_err(),
        CoreError::NotWonGemas
    );
    assert_eq!(before, (player.lines().collect::<Vec<_>>(), s.book.clone()));
}

#[test]
fn fee_classes_cannot_be_sold() {
    let mut s = Src::new(1, 1_000);
    let mut fee = SourceBook::blank_line(SIDE_WON, DUE, key(1), CLASS_PLATFORM, 0);
    let mut owner = s.owner;
    s.book
        .cut_fee(&mut owner, &mut fee, 100, &mut s.ck)
        .unwrap();
    s.owner = owner;
    let mut b = basket(10, 4);
    b.insert(&fee).unwrap();
    let r = request_instant_redeem(
        SourceKind::Yield,
        &mut s.book,
        &mut s.ck,
        &mut b,
        &fee.key(),
        key(10),
        10,
        NOW,
        DEFAULT_ORDER_TTL_SECS,
    );
    assert_eq!(r.unwrap_err(), CoreError::NotWonGemas);
}

#[test]
fn a_request_never_dips_into_an_offer_reservation() {
    let (mut s, mut player, _) = world();
    player.set_reserved_total(3_500); // 5,000 in the basket: 1,500 may leave
    let snapshot = (player.lines().collect::<Vec<_>>(), s.book.clone());
    let ready = s.book.redeemable(&player.lines().next().unwrap()).unwrap();
    // the ready Gemas are Redeemed too, so only 1,500 - ready more can be sold
    let room = 1_500 - ready;
    assert_eq!(
        request(&mut s, &mut player, room + 1).unwrap_err(),
        CoreError::ReservedGemas
    );
    assert_eq!(
        snapshot,
        (player.lines().collect::<Vec<_>>(), s.book.clone())
    );
    let r = request(&mut s, &mut player, room).unwrap();
    assert_eq!(player.won_total(), 3_500);
    assert_eq!(player.reserved_total(), 3_500);
    assert_eq!(r.order.line.amount, room);
}

#[test]
fn a_full_fill_pays_75_percent_of_the_value_at_fill_and_keeps_class_and_tranche() {
    let mut s = Src::new(1, 10_000);
    let mut player = basket(10, 16);
    let mut treasury = basket(11, 16);
    s.book.start_extension().unwrap();
    s.give(&mut player, 4, 1, 4_000); // Extension 1 Gemas
    s.give(&mut player, CLASS_GENERAL, 0, 100);
    s.land(0);
    let key_ext = s.won_key(4, 1);
    let mut order = request_instant_redeem(
        SourceKind::Yield,
        &mut s.book,
        &mut s.ck,
        &mut player,
        &key_ext,
        key(10),
        4_000,
        NOW,
        DEFAULT_ORDER_TTL_SECS,
    )
    .unwrap()
    .order;
    let mut route = route(10_000);
    let t = terms(3, 2, PayMode::Now); // 1 Gema = 1.5 shares
    let f = fill_instant_redeem(
        &auth(),
        &key(200),
        &mut route,
        &mut s.book,
        &mut s.ck,
        &mut order,
        &mut treasury,
        4_000,
        &t,
        NOW + 10,
    )
    .unwrap();
    assert_eq!(
        (f.value_shares, f.fee_bps, f.payout_shares),
        (6_000, 2_500, 4_500)
    );
    assert_eq!(route.treasury_shares, 10_000 - 4_500);
    assert_eq!(route.spendable(), 5_500);
    assert!(!order.is_open());
    assert_eq!((order.sold, order.paid_shares), (4_000, 4_500));
    let tl = treasury.get(treasury.find(&key_ext).unwrap()).unwrap();
    assert_eq!((tl.amount, tl.class, tl.tranche), (4_000, 4, 1));
    assert!(player.find(&key_ext).is_err());
    check_all(&s, &[&player, &treasury], &[&order]);
}

#[test]
fn partial_fills_add_up_and_leave_the_rest_open() {
    let (mut s, mut player, mut treasury) = world();
    let r = request(&mut s, &mut player, 3_000).unwrap();
    s.redeemed += r.redeemed.unwrap().gemas;
    let mut order = r.order;
    let mut route = route(1_000_000);
    let t = terms(1, 1, PayMode::Now);
    let mut paid = 0u128;
    for k in [1_000u64, 2, 1_000, 998] {
        let f = fill_instant_redeem(
            &auth(),
            &key(200),
            &mut route,
            &mut s.book,
            &mut s.ck,
            &mut order,
            &mut treasury,
            k,
            &t,
            NOW,
        )
        .unwrap();
        assert_eq!(f.payout_shares, u128::from(k) * 3 / 4);
        paid += f.payout_shares;
        check_all(&s, &[&player, &treasury], &[&order]);
    }
    assert_eq!(order.sold, 3_000);
    assert_eq!(order.paid_shares, paid);
    assert!(!order.is_open());
    assert_eq!(treasury.won_total(), 3_000);
    // a fill worth less than one share pays nothing and is refused
    // nothing is left to fill or cancel
    assert_eq!(
        fill_instant_redeem(
            &auth(),
            &key(200),
            &mut route,
            &mut s.book,
            &mut s.ck,
            &mut order,
            &mut treasury,
            1,
            &t,
            NOW
        )
        .unwrap_err(),
        CoreError::InvalidStatus
    );
    assert_eq!(
        cancel_instant_redeem(&key(10), &mut s.book, &mut s.ck, &mut order, &mut player)
            .unwrap_err(),
        CoreError::InvalidStatus
    );
}

#[test]
fn a_fill_above_spendable_is_refused_and_changes_nothing() {
    let (mut s, mut player, mut treasury) = world();
    let mut order = request(&mut s, &mut player, 4_000).unwrap().order;
    let mut route = route(5_000);
    route.add_owed(2_000).unwrap();
    route.realise_yield_fee_default(1_000).unwrap(); // T 6,000: owed 2,000, pool 500
    assert_eq!(route.spendable(), 3_500);
    let t = terms(1, 1, PayMode::Now);
    let before = (
        route.clone(),
        s.book.clone(),
        order.clone(),
        treasury.lines().count(),
    );
    // 4,667 Gemas would cost 3,500.25 -> 3,501 refused; 4,000 Gemas cost 3,000 fine
    let over = terms(1, 1, PayMode::Now);
    let e = fill_instant_redeem(
        &auth(),
        &key(200),
        &mut route,
        &mut s.book,
        &mut s.ck,
        &mut order,
        &mut treasury,
        4_000,
        &FillTerms {
            rate: Rate {
                shares: 12,
                gemas: 10,
            },
            ..over
        },
        NOW,
    )
    .unwrap_err();
    assert_eq!(e, CoreError::OverSpendable);
    assert_eq!(
        before,
        (
            route.clone(),
            s.book.clone(),
            order.clone(),
            treasury.lines().count()
        )
    );
    // max_fill finds the biggest affordable part: payout(k) = 0.9 k
    let t12 = FillTerms {
        rate: Rate {
            shares: 12,
            gemas: 10,
        },
        ..t
    };
    let k = order.max_fill(&s.book, route.spendable(), &t12).unwrap();
    assert_eq!(k, 3_889); // value 4,666 -> payout 3,499; 3,890 would pay 3,501
    assert!(fill_instant_redeem(
        &auth(),
        &key(200),
        &mut route,
        &mut s.book,
        &mut s.ck,
        &mut order,
        &mut treasury,
        k + 1,
        &t12,
        NOW
    )
    .is_err());
    let f = fill_instant_redeem(
        &auth(),
        &key(200),
        &mut route,
        &mut s.book,
        &mut s.ck,
        &mut order,
        &mut treasury,
        k,
        &t12,
        NOW,
    )
    .unwrap();
    assert!(f.payout_shares <= 3_500);
    // holders and the Pool were never touched
    assert_eq!((route.owed_shares, route.pool_owed), (2_000, 500));
    route.check(&[]).unwrap();
}

#[test]
fn only_the_admin_or_an_enabled_keeper_fills() {
    let (mut s, mut player, mut treasury) = world();
    let mut order = request(&mut s, &mut player, 100).unwrap().order;
    let mut route = route(1_000);
    let t = terms(1, 1, PayMode::Now);
    let mut try_fill = |a: &FillAuthority, who: u8, order: &mut InstantOrder| {
        fill_instant_redeem(
            a,
            &key(who),
            &mut route,
            &mut s.book,
            &mut s.ck,
            order,
            &mut treasury,
            10,
            &t,
            NOW,
        )
    };
    assert_eq!(
        try_fill(&auth(), 201, &mut order).unwrap_err(),
        CoreError::NotFillAuthority
    );
    assert_eq!(
        try_fill(&auth(), 10, &mut order).unwrap_err(),
        CoreError::NotFillAuthority
    );
    let on = FillAuthority {
        keeper_fills: true,
        ..auth()
    };
    assert_eq!(
        try_fill(&on, 7, &mut order).unwrap_err(),
        CoreError::NotFillAuthority
    );
    try_fill(&on, 201, &mut order).unwrap();
    try_fill(&auth(), 200, &mut order).unwrap();
    // an unset keeper key never matches the zero key
    let blank = FillAuthority {
        admin: key(200),
        keeper: [0; 32],
        keeper_fills: true,
    };
    assert_eq!(blank.check(&[0; 32]), Err(CoreError::NotFillAuthority));
}

#[test]
fn an_expired_order_cannot_be_filled_and_anyone_can_return_it() {
    let (mut s, mut player, mut treasury) = world();
    let mut order = request(&mut s, &mut player, 1_000).unwrap().order;
    let mut route = route(1_000);
    let t = terms(1, 1, PayMode::Now);
    let at = order.expires_at;
    assert_eq!(
        fill_instant_redeem(
            &auth(),
            &key(200),
            &mut route,
            &mut s.book,
            &mut s.ck,
            &mut order,
            &mut treasury,
            1,
            &t,
            at
        )
        .unwrap_err(),
        CoreError::Expired
    );
    assert_eq!(
        expire_instant_redeem(at - 1, &mut s.book, &mut s.ck, &mut order, &mut player).unwrap_err(),
        CoreError::NotExpired
    );
    let k = expire_instant_redeem(at, &mut s.book, &mut s.ck, &mut order, &mut player).unwrap();
    assert_eq!(k, 1_000);
    assert!(!order.is_open());
}

#[test]
fn cancel_and_expiry_return_exactly_what_was_locked() {
    let (mut s, mut player, _) = world();
    let r = request(&mut s, &mut player, 3_000).unwrap();
    s.redeemed += r.redeemed.unwrap().gemas;
    let o = r.order;
    let kept = player.won_total();
    // some of the order's Gemas repay while it waits
    s.land(1_500);
    let unpaid_before = s.book.uncovered_total();
    let ready_in_order = s.book.ready_of(&o.line).unwrap();
    let basket_line = player.get(player.find(&o.line.key()).unwrap()).unwrap();
    let basket_ready = s.book.ready_of(&basket_line).unwrap();
    assert!(ready_in_order > fp(100));
    assert_eq!(
        cancel_instant_redeem(
            &key(11),
            &mut s.book,
            &mut s.ck,
            &mut o.clone(),
            &mut player
        )
        .unwrap_err(),
        CoreError::NotParty
    );
    for who in [0u8, 1] {
        let (mut book, mut p, mut ord) = (s.book.clone(), basket(10, 16), o.clone());
        let mut ck = s.ck.clone();
        for l in player.lines() {
            p.insert(&l).unwrap();
        }
        let k = if who == 0 {
            cancel_instant_redeem(&key(10), &mut book, &mut ck, &mut ord, &mut p).unwrap()
        } else {
            expire_instant_redeem(o.expires_at + 1, &mut book, &mut ck, &mut ord, &mut p).unwrap()
        };
        assert_eq!(k, 3_000);
        let back = p.get(p.find(&o.line.key()).unwrap()).unwrap();
        assert_eq!(back.amount, kept + 3_000);
        assert_eq!(p.won_total(), kept + 3_000);
        assert_eq!(book.uncovered_total(), unpaid_before);
        let now_ready = book.ready_of(&back).unwrap();
        let sum = ready_in_order + basket_ready;
        assert!(
            now_ready <= sum && sum - now_ready <= 2,
            "ready returns exactly"
        );
        let mut all: Vec<Line> = p.lines().collect();
        all.push(ord.line);
        book.check(s.redeemed, std::iter::once(&s.owner).chain(all.iter()))
            .unwrap();
    }
}

#[test]
fn ready_gemas_that_appear_while_an_order_waits_are_redeemed_in_full_at_fill() {
    let (mut s, mut player, mut treasury) = world();
    let r = request(&mut s, &mut player, 4_000).unwrap();
    s.redeemed += r.redeemed.unwrap().gemas;
    let mut order = r.order;
    s.land(2_000); // 2,000 more coverage: the order's 4,000 of 8,000 outstanding earn ~ 1,000
    let ready = s.book.redeemable(&order.line).unwrap();
    assert!(ready >= 999);
    let mut route = route(1_000_000);
    let t = terms(1, 1, PayMode::Now);
    let f = fill_instant_redeem(
        &auth(),
        &key(200),
        &mut route,
        &mut s.book,
        &mut s.ck,
        &mut order,
        &mut treasury,
        100,
        &t,
        NOW,
    )
    .unwrap();
    let red = f.redeemed.unwrap();
    s.redeemed += red.gemas;
    assert_eq!(red.gemas, ready);
    assert_eq!(f.payout_shares, 75);
    assert_eq!(order.redeemed_while_open, ready);
    assert_eq!(order.line.amount, 4_000 - ready - 100);
    check_all(&s, &[&player, &treasury], &[&order]);
}

#[test]
fn a_deferred_fill_reserves_the_payout_for_the_bridge_message() {
    let (mut s, mut player, mut treasury) = world();
    let mut order = request(&mut s, &mut player, 400).unwrap().order;
    let mut route = route(1_000);
    let t = terms(1, 1, PayMode::Deferred);
    let f = fill_instant_redeem(
        &auth(),
        &key(200),
        &mut route,
        &mut s.book,
        &mut s.ck,
        &mut order,
        &mut treasury,
        400,
        &t,
        NOW,
    )
    .unwrap();
    assert!(f.deferred);
    assert_eq!(
        (route.treasury_shares, route.reserved, route.spendable()),
        (1_000, 300, 700)
    );
    route.pay_reserved(f.payout_shares).unwrap();
    assert_eq!((route.treasury_shares, route.reserved), (700, 0));
}

#[test]
fn the_treasury_basket_can_be_full_and_nothing_changes() {
    let (mut s, mut player, _) = world();
    let mut order = request(&mut s, &mut player, 400).unwrap().order;
    let mut full = basket(11, 1);
    full.insert(&SourceBook::blank_line(
        SIDE_WON,
        1,
        key(9),
        CLASS_GENERAL,
        0,
    ))
    .unwrap();
    let mut route = route(1_000);
    let before = (route.clone(), order.clone(), s.book.clone());
    let e = fill_instant_redeem(
        &auth(),
        &key(200),
        &mut route,
        &mut s.book,
        &mut s.ck,
        &mut order,
        &mut full,
        10,
        &terms(1, 1, PayMode::Now),
        NOW,
    )
    .unwrap_err();
    assert_eq!(e, CoreError::SpillFull);
    assert_eq!(before, (route, order, s.book));
}

// ------------------------------------------------------------------------------ the spill

/// All of Source `id`'s lines in the stores and orders, for the book's identity check.
fn lines_of(id: u8, stores: &[&Basket], spills: &[&[u8]], orders: &[&InstantOrder]) -> Vec<Line> {
    let mut v: Vec<Line> = stores.iter().flat_map(|s| s.lines()).collect();
    for b in spills {
        v.extend(LineStore::new(*b).unwrap().lines());
    }
    v.extend(orders.iter().map(|o| o.line));
    v.retain(|l| l.source == key(id));
    v
}

fn check_source(s: &Src, stores: &[&Basket], spills: &[&[u8]], orders: &[&InstantOrder]) {
    let lines = lines_of(1, stores, spills, orders);
    let refs: Vec<&Line> = lines.iter().collect();
    s.check(&refs);
}

/// A player whose single basket slot is taken by another Source's Gemas, with an order open
/// for every non-ready Gema of Source 1's 5,000.
fn full_basket_world() -> (Src, Basket, InstantOrder) {
    let mut s = Src::new(1, 10_000);
    let mut player = basket(10, 1);
    s.give(&mut player, CLASS_GENERAL, 0, 5_000);
    s.land(2_000);
    let line = player.lines().next().unwrap();
    let sell = 5_000 - s.book.redeemable(&line).unwrap();
    let r = request(&mut s, &mut player, sell).unwrap();
    s.redeemed += r.redeemed.unwrap().gemas;
    assert_eq!(player.len(), 0);
    Src::new(2, 1_000).give(&mut player, CLASS_GENERAL, 0, 100);
    assert_eq!(player.len(), player.capacity());
    (s, player, r.order)
}

#[test]
fn cancel_and_expiry_into_a_full_basket_go_to_the_spill_not_a_separate_overflow() {
    for expiry in [false, true] {
        let (mut s, mut player, order) = full_basket_world();
        let o_key = order.line.key();
        let sold = order.line.amount;
        let kept = (player.len(), player.won_total());
        let mut spill = spill_body(key(10), 0).unwrap();
        let mut o = order.clone();
        // no room anywhere: refused, nothing changed
        let before = (
            s.book.clone(),
            o.clone(),
            player.lines().collect::<Vec<_>>(),
        );
        let e = {
            let mut sp = LineStore::new(spill.as_mut_slice()).unwrap();
            let mut pool = Pool::new(&mut player, &mut sp);
            if expiry {
                expire_pool(o.expires_at, &mut s.book, &mut s.ck, &mut o, &mut pool)
            } else {
                cancel_pool(&key(10), &mut s.book, &mut s.ck, &mut o, &mut pool)
            }
            .unwrap_err()
        };
        assert_eq!(e, CoreError::SpillFull);
        assert_eq!(
            before,
            (
                s.book.clone(),
                o.clone(),
                player.lines().collect::<Vec<_>>()
            )
        );
        // the instruction layer grows the spill and retries
        grow_spill_body(&mut spill, 1);
        let k = {
            let mut sp = LineStore::new(spill.as_mut_slice()).unwrap();
            let mut pool = Pool::new(&mut player, &mut sp);
            let free_before = pool.free();
            let k = if expiry {
                expire_pool(o.expires_at, &mut s.book, &mut s.ck, &mut o, &mut pool)
            } else {
                cancel_pool(&key(10), &mut s.book, &mut s.ck, &mut o, &mut pool)
            }
            .unwrap();
            // playable at once, no claim needed
            assert_eq!(pool.free(), free_before + k);
            k
        };
        assert_eq!(k, sold);
        assert!(!o.is_open());
        assert_eq!((player.len(), player.won_total()), kept);
        let sp = LineStore::new(spill.as_slice()).unwrap();
        let back = sp.get(sp.find(&o_key).unwrap()).unwrap();
        assert_eq!(
            (back.amount, back.class, back.tranche),
            (sold, CLASS_GENERAL, 0)
        );
        check_source(&s, &[&player], &[spill.as_slice()], &[&o]);
    }
}

#[test]
fn a_fill_into_a_full_treasury_pool_goes_to_its_spill_after_growth() {
    let (mut s, mut player, mut order) = full_basket_world();
    let o_key = order.line.key();
    let sold = order.line.amount;
    let mut treasury = basket(11, 1);
    Src::new(2, 10).give(&mut treasury, CLASS_GENERAL, 0, 5);
    let mut spill = spill_body(key(11), 0).unwrap();
    let mut route = route(10_000);
    let t = terms(1, 1, PayMode::Now);
    let go = |s: &mut Src,
              route: &mut RouteLedger,
              order: &mut InstantOrder,
              treasury: &mut Basket,
              spill: &mut Vec<u8>,
              k: u64| {
        let mut sp = LineStore::new(spill.as_mut_slice()).unwrap();
        fill_pool(
            &auth(),
            &key(200),
            route,
            &mut s.book,
            &mut s.ck,
            order,
            &mut Pool::new(treasury, &mut sp),
            k,
            &t,
            NOW + 5,
        )
    };
    let before = (route.clone(), order.clone(), s.book.clone());
    assert_eq!(
        go(
            &mut s,
            &mut route,
            &mut order,
            &mut treasury,
            &mut spill,
            1_000
        )
        .unwrap_err(),
        CoreError::SpillFull
    );
    assert_eq!(before, (route.clone(), order.clone(), s.book.clone()));
    grow_spill_body(&mut spill, 1);
    go(
        &mut s,
        &mut route,
        &mut order,
        &mut treasury,
        &mut spill,
        1_000,
    )
    .unwrap();
    // a second partial fill merges into the spill line, which needs no new slot
    go(
        &mut s,
        &mut route,
        &mut order,
        &mut treasury,
        &mut spill,
        500,
    )
    .unwrap();
    let sp = LineStore::new(spill.as_slice()).unwrap();
    let tl = sp.get(sp.find(&o_key).unwrap()).unwrap();
    assert_eq!((tl.amount, tl.class, tl.tranche), (1_500, CLASS_GENERAL, 0));
    assert_eq!(order.line.amount, sold - 1_500);
    let _ = &mut player;
    check_source(&s, &[&player, &treasury], &[spill.as_slice()], &[&order]);
}

#[test]
fn a_request_sells_from_a_line_that_sits_in_the_spill_and_respects_the_whole_pool() {
    let mut s = Src::new(1, 10_000);
    let mut player = basket(10, 1);
    Src::new(2, 10).give(&mut player, CLASS_GENERAL, 0, 5);
    let mut tmp = basket(10, 2);
    s.give(&mut tmp, CLASS_GENERAL, 0, 4_000);
    let mut spill = spill_body(key(10), 1).unwrap();
    {
        let mut sp = LineStore::new(spill.as_mut_slice()).unwrap();
        sp.insert(&tmp.lines().next().unwrap()).unwrap();
    }
    s.land(1_000);
    let k = s.won_key(CLASS_GENERAL, 0);
    let mut sp = LineStore::new(spill.as_mut_slice()).unwrap();
    // a reservation the whole pool must keep: 4,000 + 5 playable, 4,000 reserved
    player.set_reserved_total(4_000);
    let mut pool = Pool::new(&mut player, &mut sp);
    let ready = s.book.redeemable(&pool.spill.get(0).unwrap()).unwrap();
    let room = 5 - ready.min(5);
    let e = request_pool(
        SourceKind::Yield,
        &mut s.book,
        &mut s.ck,
        &mut pool,
        &k,
        key(10),
        2_000,
        NOW,
        DEFAULT_ORDER_TTL_SECS,
    )
    .unwrap_err();
    assert_eq!(e, CoreError::ReservedGemas);
    let _ = room;
    pool.basket.set_reserved_total(0);
    let r = request_pool(
        SourceKind::Yield,
        &mut s.book,
        &mut s.ck,
        &mut pool,
        &k,
        key(10),
        2_000,
        NOW,
        DEFAULT_ORDER_TTL_SECS,
    )
    .unwrap();
    assert_eq!(r.order.line.amount, 2_000);
    assert_eq!(pool.spill.get(0).unwrap().amount, 4_000 - ready - 2_000);
}

#[test]
fn the_fee_is_one_function_of_the_sources_fee_share() {
    assert_eq!(instant_fee_bps(0, 0), 2_500);
    assert_eq!(instant_fee_bps(300, 1_000), 2_500);
}

// ------------------------------------------------------------------------------------- fuzz

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

struct Open {
    src: usize,
    order: InstantOrder,
}

#[derive(Default, Debug)]
struct Stats {
    requests: u64,
    fills: u64,
    partial_fills: u64,
    deferred: u64,
    over_spendable: u64,
    cancels: u64,
    expiries: u64,
    ready_redeemed_at_fill: u64,
    ext_orders: u64,
}

fn fuzz_one(seed: u64, ops: usize, st: &mut Stats) {
    let mut rng = Rng(seed);
    let mut srcs = [Src::new(1, 50_000), Src::new(2, 20_000)];
    let mut player = basket(10, 64);
    let mut treasury = basket(11, 64);
    let mut pots: BTreeMap<(usize, u8, u8), Line> = BTreeMap::new();
    let mut orders: Vec<Open> = Vec::new();
    let mut route = RouteLedger::default();
    route.receive(30_000).unwrap();
    let mut a = auth();
    a.keeper_fills = rng.below(2) == 0;
    let mut ext = [false; 2];

    for step in 0..ops {
        let ctx = format!("seed {seed} step {step}");
        match rng.below(12) {
            0 | 1 => {
                let i = rng.below(2) as usize;
                let g = rng.below(3_000);
                srcs[i].land(g);
            }
            2 => {
                let i = rng.below(2) as usize;
                let (class, tranche) = if rng.below(3) == 0 {
                    if !ext[i] {
                        ext[i] = true;
                        srcs[i].book.start_extension().unwrap();
                    }
                    (4, 1)
                } else {
                    (CLASS_GENERAL, 0)
                };
                let k = 1 + rng.below(2_000);
                let room = if class == CLASS_GENERAL {
                    srcs[i].owner.amount
                } else {
                    u64::MAX
                };
                if k <= room && player.len() < 40 {
                    srcs[i].give(&mut player, class, tranche, k);
                }
            }
            3..=5 => {
                // request
                let lines: Vec<Line> = player.lines().collect();
                if lines.is_empty() || orders.len() >= 8 {
                    continue;
                }
                let l = lines[rng.below(lines.len() as u64) as usize];
                let i = if l.source == key(1) { 0 } else { 1 };
                let sell = 1 + rng.below(l.amount + 2);
                let ttl = MIN_ORDER_TTL_SECS + rng.below(1000) as i64;
                let free_before = (player.own_total() + player.won_total())
                    .saturating_sub(player.reserved_total());
                let unpaid = srcs[i].book.uncovered_total();
                let snap = (player.lines().collect::<Vec<_>>(), srcs[i].book.clone());
                match request_instant_redeem(
                    SourceKind::Yield,
                    &mut srcs[i].book,
                    &mut srcs[i].ck,
                    &mut player,
                    &l.key(),
                    key(10),
                    sell,
                    NOW,
                    ttl,
                ) {
                    Ok(r) => {
                        if let Some(red) = r.redeemed {
                            srcs[i].redeemed += red.gemas;
                        }
                        let left = r.redeemed.map_or(0, |x| x.gemas) + sell;
                        assert!(
                            left <= free_before,
                            "{ctx}: request dipped under a reservation"
                        );
                        let d = srcs[i].book.uncovered_total().abs_diff(unpaid);
                        assert!(d <= 1, "{ctx}: request moved unpaid by {d}");
                        assert_eq!(r.order.line.amount, sell);
                        assert_eq!(
                            (r.order.line.class, r.order.line.tranche),
                            (l.class, l.tranche)
                        );
                        st.requests += 1;
                        st.ext_orders += u64::from(l.class == 4);
                        orders.push(Open {
                            src: i,
                            order: r.order,
                        });
                    }
                    Err(_) => {
                        assert_eq!(
                            snap,
                            (player.lines().collect::<Vec<_>>(), srcs[i].book.clone()),
                            "{ctx}"
                        );
                    }
                }
            }
            6 | 7 => {
                // fill
                if orders.is_empty() {
                    continue;
                }
                let n = rng.below(orders.len() as u64) as usize;
                let o = &mut orders[n];
                let s = &mut srcs[o.src];
                let t = FillTerms {
                    rate: Rate {
                        shares: if rng.below(4) == 0 {
                            5_000
                        } else {
                            1 + u128::from(rng.below(30))
                        },
                        gemas: 1 + rng.below(20),
                    },
                    fees_outstanding: u128::from(rng.below(100)),
                    outstanding: 100,
                    pay: if rng.below(2) == 0 {
                        PayMode::Now
                    } else {
                        PayMode::Deferred
                    },
                };
                let spendable = route.spendable();
                let sellable = o.order.max_fill(&s.book, spendable, &t).unwrap();
                let k = match rng.below(4) {
                    0 => sellable,
                    1 => sellable.saturating_add(1 + rng.below(3)),
                    _ => 1 + rng.below(sellable + 2),
                };
                let signer = match rng.below(4) {
                    0 => key(201),
                    1 => key(9),
                    _ => key(200),
                };
                let (owed, pool) = (route.owed_shares, route.pool_owed);
                let snap = (
                    route.clone(),
                    s.book.clone(),
                    o.order.clone(),
                    treasury.lines().collect::<Vec<_>>(),
                );
                let expired = rng.below(10) == 0;
                let now = if expired { o.order.expires_at } else { NOW + 1 };
                match fill_instant_redeem(
                    &a,
                    &signer,
                    &mut route,
                    &mut s.book,
                    &mut s.ck,
                    &mut o.order,
                    &mut treasury,
                    k,
                    &t,
                    now,
                ) {
                    Ok(f) => {
                        st.fills += 1;
                        st.partial_fills += u64::from(o.order.is_open());
                        st.deferred += u64::from(f.deferred);
                        st.ready_redeemed_at_fill += u64::from(f.redeemed.is_some());
                        assert!(a.check(&signer).is_ok(), "{ctx}: unauthorised fill");
                        assert!(!expired, "{ctx}: filled an expired order");
                        // never more than 75% of the value at fill, never above spendable
                        assert!(
                            f.payout_shares * 10_000 <= f.value_shares * 7_500,
                            "{ctx}: over 75%"
                        );
                        assert_eq!(f.value_shares, t.rate.value(k).unwrap());
                        assert!(f.payout_shares <= spendable, "{ctx}: over spendable");
                        assert_eq!(
                            (route.owed_shares, route.pool_owed),
                            (owed, pool),
                            "{ctx}: holders or the Pool touched"
                        );
                        match t.pay {
                            PayMode::Now => {
                                assert_eq!(route.spendable(), spendable - f.payout_shares)
                            }
                            PayMode::Deferred => {
                                assert_eq!(route.spendable(), spendable - f.payout_shares);
                                route.pay_reserved(f.payout_shares).unwrap();
                            }
                        }
                        if let Some(red) = f.redeemed {
                            s.redeemed += red.gemas;
                        }
                        // the Treasury's line has the seller's class and tranche
                        let key_of = o.order.line.key();
                        let tline = treasury
                            .get(treasury.find(&key_of).expect("treasury line"))
                            .unwrap();
                        assert_eq!((tline.class, tline.tranche), (key_of.class, key_of.tranche));
                        assert!(tline.class >= CLASS_GENERAL, "{ctx}: promoted");
                        route.check(&[]).unwrap();
                    }
                    Err(e) => {
                        st.over_spendable += u64::from(e == CoreError::OverSpendable);
                        assert_eq!(
                            snap,
                            (
                                route.clone(),
                                s.book.clone(),
                                o.order.clone(),
                                treasury.lines().collect::<Vec<_>>()
                            ),
                            "{ctx}: a refused fill changed state"
                        );
                    }
                }
            }
            8 => {
                // cancel / expire
                if orders.is_empty() {
                    continue;
                }
                let n = rng.below(orders.len() as u64) as usize;
                let o = &mut orders[n];
                let s = &mut srcs[o.src];
                let amount = o.order.line.amount;
                let before_total = player.won_total();
                let unpaid = s.book.uncovered_total();
                let snap = (
                    s.book.clone(),
                    o.order.clone(),
                    player.lines().collect::<Vec<_>>(),
                );
                let by_owner = rng.below(2) == 0;
                let res = if by_owner {
                    cancel_instant_redeem(
                        &key(10),
                        &mut s.book,
                        &mut s.ck,
                        &mut o.order,
                        &mut player,
                    )
                } else {
                    expire_instant_redeem(
                        o.order.expires_at + rng.below(2) as i64 - 1,
                        &mut s.book,
                        &mut s.ck,
                        &mut o.order,
                        &mut player,
                    )
                };
                match res {
                    Ok(k) => {
                        assert_eq!(k, amount);
                        if by_owner {
                            st.cancels += 1
                        } else {
                            st.expiries += 1
                        }
                        assert_eq!(player.won_total(), before_total + amount, "{ctx}");
                        assert_eq!(
                            s.book.uncovered_total(),
                            unpaid,
                            "{ctx}: unpaid changed by a full return"
                        );
                        assert!(!o.order.is_open());
                    }
                    Err(_) => assert_eq!(
                        snap,
                        (
                            s.book.clone(),
                            o.order.clone(),
                            player.lines().collect::<Vec<_>>()
                        ),
                        "{ctx}"
                    ),
                }
            }
            9 => {
                // play: draw from the basket into a Pot; open orders are out of reach
                let lines: Vec<Line> = player.lines().collect();
                if lines.is_empty() {
                    continue;
                }
                let l = lines[rng.below(lines.len() as u64) as usize];
                let i = if l.source == key(1) { 0 } else { 1 };
                let free = (player.own_total() + player.won_total())
                    .saturating_sub(player.reserved_total());
                let k = 1 + rng.below(l.amount);
                if k > free {
                    continue;
                }
                let idx = player.find(&l.key()).unwrap();
                let mut src = l;
                let pot = pots.entry((i, l.class, l.tranche)).or_insert_with(|| {
                    SourceBook::blank_line(SIDE_WON, 0, l.source, l.class, l.tranche)
                });
                let open_before: Vec<u64> = orders.iter().map(|o| o.order.line.amount).collect();
                srcs[i]
                    .book
                    .transfer(&mut src, pot, k, &srcs[i].ck)
                    .unwrap();
                if src.amount == 0 {
                    player.remove_at(idx).unwrap();
                } else {
                    player.set_line(idx, &src).unwrap();
                }
                let open_after: Vec<u64> = orders.iter().map(|o| o.order.line.amount).collect();
                assert_eq!(open_before, open_after, "{ctx}: play touched an order");
            }
            10 => {
                // Redeem from the basket, and an Offer reservation change
                let lines: Vec<Line> = player.lines().collect();
                if lines.is_empty() {
                    continue;
                }
                let l = lines[rng.below(lines.len() as u64) as usize];
                let i = if l.source == key(1) { 0 } else { 1 };
                let ready = srcs[i].book.redeemable(&l).unwrap().min(l.amount);
                let free = (player.own_total() + player.won_total())
                    .saturating_sub(player.reserved_total());
                let k = ready.min(free);
                if k > 0 {
                    let idx = player.find(&l.key()).unwrap();
                    let mut ln = l;
                    srcs[i].book.redeem(&mut ln, k, &srcs[i].ck).unwrap();
                    srcs[i].redeemed += k;
                    if ln.amount == 0 {
                        player.remove_at(idx).unwrap();
                    } else {
                        player.set_line(idx, &ln).unwrap();
                    }
                }
                let total = player.own_total() + player.won_total();
                player.set_reserved_total(rng.below(total + 1));
            }
            _ => {
                // route events
                match rng.below(5) {
                    0 => route.receive(u128::from(rng.below(5_000))).unwrap(),
                    1 => {
                        route
                            .realise_yield_fee_default(u128::from(rng.below(3_000)))
                            .unwrap();
                    }
                    2 => {
                        let _ = route.add_owed(u128::from(rng.below(4_000)));
                    }
                    3 => {
                        let _ = route.spend(u128::from(rng.below(2_000)));
                    }
                    _ => {
                        let _ = route.reserve(u128::from(rng.below(500)));
                        let r = route.reserved;
                        route.unreserve(r).unwrap();
                    }
                }
            }
        }
        // after every op: books, store totals, route and Gema conservation per Source
        for (i, s) in srcs.iter().enumerate() {
            let mut lines: Vec<Line> = player.lines().chain(treasury.lines()).collect();
            lines.extend(orders.iter().map(|o| o.order.line));
            lines.extend(pots.values().copied());
            lines.retain(|l| l.source == s.owner.source);
            let refs = lines.iter();
            s.book
                .check(s.redeemed, std::iter::once(&s.owner).chain(refs))
                .unwrap_or_else(|e| panic!("{ctx}: {e}"));
            let held_i: u64 = lines.iter().map(|l| l.amount).sum::<u64>() + s.owner.amount;
            assert_eq!(
                held_i + s.redeemed,
                s.issued,
                "{ctx}: Gemas created or lost on source {i}"
            );
        }
        player.check().unwrap();
        treasury.check().unwrap();
        route.check(&[]).unwrap();
    }
}

#[test]
fn fuzz_orders_hold_every_invariant() {
    let seeds: u64 = std::env::var("INSTANT_FUZZ_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(600);
    let base: u64 = std::env::var("INSTANT_FUZZ_BASE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut st = Stats::default();
    for seed in base..base + seeds {
        fuzz_one(seed, 150, &mut st);
    }
    eprintln!("{st:?}");
    if seeds >= 100 {
        assert!(st.requests > 0 && st.fills > 0 && st.partial_fills > 0 && st.deferred > 0);
        assert!(st.over_spendable > 0 && st.cancels > 0 && st.expiries > 0);
        assert!(st.ready_redeemed_at_fill > 0 && st.ext_orders > 0);
    }
}

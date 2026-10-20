use super::model::{LineId, Model, Rat};
use super::wide::*;
use super::*;
use crate::ledger::line_store::{Line, CLASS_GENERAL, SIDE_OWN};
use num_bigint::{BigInt, BigUint};
use num_integer::Integer;
use num_traits::{ToPrimitive, Zero};
use std::collections::BTreeMap;

// ---------------------------------------------------------------- random numbers

pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next() % n
        }
    }
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.below(hi - lo + 1)
    }
    pub fn u128(&mut self) -> u128 {
        (self.next() as u128) << 64 | self.next() as u128
    }
    /// A number with an interesting shape: edges, powers of two, random of a random width.
    pub fn shaped(&mut self) -> u128 {
        match self.below(8) {
            0 => 0,
            1 => 1,
            2 => u128::MAX,
            3 => (1u128 << self.below(128)).wrapping_sub(self.below(3) as u128),
            4 => (1u128 << self.below(128)).wrapping_add(self.below(3) as u128),
            5 => self.u128() >> self.below(128),
            6 => u64::MAX as u128 + self.below(3) as u128 - 1,
            _ => self.u128(),
        }
    }
}

fn big(v: u128) -> BigUint {
    BigUint::from(v)
}

fn wide_big(v: &U256) -> BigUint {
    let mut r = BigUint::zero();
    for limb in v.0.iter().rev() {
        r = (r << 64) | BigUint::from(*limb);
    }
    r
}

// ---------------------------------------------------------------- 256-bit arithmetic

#[test]
fn wide_mul_div_matches_big_integers() {
    let mut r = Rng(1);
    let cases: u64 = std::env::var("BOOK_WIDE_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200_000);
    for i in 0..cases {
        let (a, b) = (r.shaped(), r.shaped());
        let mut d = r.shaped();
        if d == 0 {
            d = 1 + i as u128;
        }
        let prod = U256::mul_wide(a, b);
        assert_eq!(wide_big(&prod), big(a) * big(b), "mul {a} {b}");
        let (q, rem) = prod.div_rem(d);
        let (eq, er) = (big(a) * big(b)).div_rem(&big(d));
        assert_eq!((wide_big(&q), big(rem)), (eq, er), "div {a} {b} {d}");
        for round in [Round::Down, Round::Up] {
            let want = {
                let (q, rem) = (big(a) * big(b)).div_rem(&big(d));
                if round == Round::Up && !rem.is_zero() {
                    q + 1u32
                } else {
                    q
                }
            };
            let got = mul_div_wide(a, b, d, round).map(|v| wide_big(&v));
            assert_eq!(got, Some(want.clone()));
            let narrow = mul_div_u128(a, b, d, round);
            assert_eq!(
                narrow.map(big),
                (want < (BigUint::from(1u8) << 128)).then_some(want)
            );
        }
    }
}

#[test]
fn wide_division_by_dividend_and_divisor_length() {
    let mut r = Rng(5);
    for _ in 0..200_000 {
        let len = 1 + r.below(4) as usize;
        let mut limbs = [0u64; 4];
        for l in limbs.iter_mut().take(len) {
            *l = match r.below(4) {
                0 => 0,
                1 => u64::MAX,
                _ => r.next(),
            };
        }
        let d: u128 = match r.below(4) {
            0 => r.next() as u128 | 1,
            1 => (r.next() as u128) << 64 | r.next() as u128 | 1,
            2 => (1u128 << (1 + r.below(127))) | r.below(2) as u128,
            _ => u128::MAX - r.below(4) as u128,
        };
        let n = U256(limbs);
        let (q, rem) = n.div_rem(d);
        let (eq, er) = wide_big(&n).div_rem(&big(d));
        assert_eq!((wide_big(&q), big(rem)), (eq, er), "{n:?} / {d}");
    }
}

#[test]
fn wide_division_edge_cases() {
    // the cases Knuth D gets wrong when the add-back step is missing or the estimate is off
    let top = u128::MAX;
    for d in [
        1u128 << 64,
        (1u128 << 64) + 1,
        (1u128 << 127) + 1,
        u128::MAX,
        u128::MAX - 1,
        0x8000_0000_0000_0000_0000_0000_0000_0001,
        (u64::MAX as u128) << 64,
        ((u64::MAX as u128) << 64) | 1,
    ] {
        for n in [
            U256([u64::MAX; 4]),
            U256([0, 0, 0, u64::MAX]),
            U256([0, 0, u64::MAX, u64::MAX]),
            U256([u64::MAX, 0, 0, u64::MAX]),
            U256::mul_wide(top, top),
            U256::mul_wide(d, d),
            U256::mul_wide(d, d - 1),
            U256::mul_wide(d, top),
            U256([1, 0, 0, 0]),
        ] {
            let (q, r) = n.div_rem(d);
            let (eq, er) = wide_big(&n).div_rem(&big(d));
            assert_eq!((wide_big(&q), big(r)), (eq, er), "{n:?} / {d}");
        }
    }
}

#[test]
fn wide_shifts_round_the_requested_way() {
    let mut r = Rng(2);
    for _ in 0..50_000 {
        let n = U256([
            r.shaped() as u64,
            r.shaped() as u64,
            r.shaped() as u64,
            r.shaped() as u64,
        ]);
        let bits = r.below(300) as u32;
        let b = wide_big(&n);
        let down = if bits >= 256 {
            BigUint::zero()
        } else {
            &b >> bits
        };
        let exact = bits < 256 && (&down << bits) == b;
        let up = if exact || b.is_zero() {
            down.clone()
        } else {
            &down + 1u32
        };
        assert_eq!(wide_big(&n.shr(bits, Round::Down)), down);
        assert_eq!(wide_big(&n.shr(bits, Round::Up)), up);
        let sh = n.checked_shl(bits);
        let fits = bits < 256 && (&b << bits) < (BigUint::from(1u8) << 256);
        assert_eq!(sh.is_some(), fits || b.is_zero() && bits < 4096);
        if let Some(s) = sh {
            if !b.is_zero() || bits < 256 {
                assert_eq!(
                    wide_big(&s),
                    if bits >= 256 {
                        BigUint::zero()
                    } else {
                        &b << bits
                    }
                );
            }
        }
    }
}

// ---------------------------------------------------------------- the system under test

const SRC: Key = [7; 32];
const OWNER: u8 = 0;
const TREASURY: u8 = 9;

fn holder_of_fee(class: u8) -> u8 {
    10 + class
}

#[derive(Clone, Copy, Debug)]
enum Mode {
    /// Everything up to u64 totals, all kinds of landings.
    Mixed,
    /// Small numbers, many lines, lots of full-cover epochs.
    Small,
    /// Huge amounts near 2^62, big classes.
    Huge,
    /// Tiny landings only, to push P through many scales and farm rounding.
    Dust,
}

struct Sys {
    book: SourceBook,
    lines: BTreeMap<LineId, Line>,
    model: Model,
    redeemed: u64,
    computed: u128,
    shares_landed: u128,
    shares_paid_fp: u128,
    taken_shares: u128,
    issued: u64,
    ops: u64,
    max_deficit_ratio: f64,
    max_excess: f64,
    forgiven: Rat,
    log: Vec<String>,
}

fn blank(id: LineId) -> Line {
    SourceBook::blank_line(
        SIDE_OWN,
        id.0 as i64,
        SRC,
        id.1,
        id.1.saturating_sub(CLASS_GENERAL),
    )
}

impl Sys {
    fn new() -> Sys {
        Sys {
            book: SourceBook::new(),
            lines: BTreeMap::new(),
            model: Model::new(),
            redeemed: 0,
            computed: 0,
            shares_landed: 0,
            shares_paid_fp: 0,
            taken_shares: 0,
            issued: 0,
            ops: 0,
            max_deficit_ratio: 0.0,
            max_excess: 0.0,
            forgiven: Rat::zero(),
            log: Vec::new(),
        }
    }

    fn prev_ready(&self) -> BTreeMap<LineId, u128> {
        self.lines
            .iter()
            .map(|(id, l)| (*id, self.book.ready_of(l).unwrap()))
            .collect()
    }

    fn line(&mut self, id: LineId) -> Line {
        self.lines.get(&id).copied().unwrap_or_else(|| blank(id))
    }

    fn store(&mut self, id: LineId, l: Line) {
        if l.amount == 0 {
            assert_eq!(
                l.uncovered, 0,
                "an empty line keeps unpaid Gemas: {id:?} {l:?}"
            );
            self.lines.remove(&id);
        } else {
            self.lines.insert(id, l);
        }
    }

    fn issue(&mut self, id: LineId, k: u64) {
        let before = self.prev_ready();
        self.log.push(format!("issue {id:?} {k}"));
        let mut l = self.line(id);
        self.book.issue(&mut l, k).unwrap();
        self.store(id, l);
        self.issued += k;
        self.model.issue(id, k);
        self.after(&[id], &before);
    }

    fn extend(&mut self, k: u64) {
        let class = self.book.start_extension().unwrap();
        self.model.start_extension();
        self.issue((OWNER, class), k);
    }

    fn sync(&mut self, delta: u128, shares: u128) {
        let before = self.prev_ready();
        self.log.push(format!("sync +{delta} shares {shares}"));
        let target = self.book.h.saturating_add(delta);
        let class_before: Vec<(u128, u128)> = self.book.classes[..self.book.class_count()]
            .iter()
            .map(|c| (c.ready, c.uncovered))
            .collect();
        let pending = self.book.pending(target);
        let landing = self.book.land(target, shares).unwrap();
        assert_eq!(landing.delta, pending);
        if pending > 0 {
            self.computed = self.computed.max(target);
            self.shares_landed += shares;
            self.model.land(&Rat::from_fp(pending));
            // payout order: a class that took coverage had every senior class paid in full
            for (i, before_i) in class_before.iter().enumerate() {
                if self.book.classes[i].ready > before_i.0 {
                    for j in 0..i {
                        assert_eq!(
                            self.book.classes[j].uncovered, 0,
                            "class {i} was paid before class {j} was paid in full"
                        );
                    }
                }
            }
        }
        self.after(&[], &before);
    }

    fn transfer(&mut self, src: LineId, dst: LineId, k: u64) {
        let before = self.prev_ready();
        self.log.push(format!("transfer {src:?} -> {dst:?} {k}"));
        let (mut s, mut d) = (self.line(src), self.line(dst));
        self.book
            .transfer(&mut s, &mut d, k)
            .unwrap_or_else(|e| panic!("{e:?}\n{}", self.log.join("\n")));
        self.store(src, s);
        self.store(dst, d);
        self.model.transfer(src, dst, k);
        self.after(&[src, dst], &before);
    }

    fn cut_fee(&mut self, src: LineId, dst: LineId, k: u64) {
        let before = self.prev_ready();
        self.log.push(format!("cut_fee {src:?} -> {dst:?} {k}"));
        let (mut s, mut d) = (self.line(src), self.line(dst));
        self.book.cut_fee(&mut s, &mut d, k).unwrap();
        self.store(src, s);
        self.store(dst, d);
        self.model.transfer(src, dst, k);
        self.after(&[src, dst], &before);
    }

    fn redeem(&mut self, id: LineId, k: u64) {
        let before = self.prev_ready();
        self.log.push(format!("redeem {id:?} {k}"));
        let mut l = self.line(id);
        let r = self.book.redeem(&mut l, k).unwrap();
        self.shares_paid_fp += r.shares << SHARE_BITS;
        self.redeemed += k;
        self.store(id, l);
        let forgiven = self.model.redeem(id, k);
        self.forgiven = self.forgiven.add(&forgiven);
        self.after(&[id], &before);
    }

    fn return_own(&mut self, id: LineId, k: u64) {
        let before = self.prev_ready();
        self.log.push(format!("return_own {id:?} {k}"));
        let mut l = self.line(id);
        let debt = self.book.uncovered_total();
        let r = self.book.return_own(&mut l, k).unwrap();
        assert_eq!(
            self.book.uncovered_total(),
            debt - r.cancelled,
            "Left to pay back must fall by exactly the cancelled part"
        );
        self.store(id, l);
        self.model.return_own(id, k);
        self.after(&[id], &before);
    }

    fn take_pocket(&mut self) {
        let before = self.prev_ready();
        self.log.push("take_pocket".into());
        let (_, sh) = self.book.take_owner_pocket().unwrap();
        self.taken_shares += sh;
        self.after(&[], &before);
    }

    /// Everything that must hold after every operation.
    fn after(&mut self, touched: &[LineId], before: &BTreeMap<LineId, u128>) {
        self.ops += 1;
        let ctx = || {
            self.log
                .iter()
                .rev()
                .take(12)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        };
        if let Err(e) = self.book.check(self.redeemed, self.lines.values()) {
            panic!("{e}\nlast ops:\n{}", ctx());
        }
        assert!(self.book.h <= self.computed.max(self.book.h));
        // shares: nothing created or lost
        let pools: u128 = self.book.classes[..self.book.class_count()]
            .iter()
            .map(|c| c.shares)
            .sum();
        assert_eq!(
            self.shares_landed,
            pools + self.shares_paid_fp + self.book.owner_shares + self.taken_shares,
            "shares not conserved\n{}",
            ctx()
        );
        // the same whole Gemas as the model, ready never above the model's and within the bound
        let mut class_ready = vec![0u128; self.book.class_count()];
        for (id, l) in &self.lines {
            let m = self.model.lines.get(id).expect("model has the line");
            assert_eq!(m.amount, l.amount, "amount of {id:?}\n{}", ctx());
            let ready = self.book.ready_of(l).unwrap();
            class_ready[l.class as usize] += ready;
            let mr = m.ready();
            let signed = BigInt::from(mr.floor_fp()) - BigInt::from(ready);
            let deficit = signed.to_f64().unwrap();
            self.max_excess = self.max_excess.max(-deficit);
            // the error of a line comes from the whole class's rounding (a holder's share of it),
            // so the bound scales with everything the Source issued
            let eps = self.ops as f64 * (64.0 + self.issued as f64 * 4.0);
            assert!(
                deficit <= eps && -deficit <= eps,
                "line {id:?} is {deficit} ulps below the model (bound {eps})\nline {l:?}\nclass {:?}\nmodel unpaid {:e} amount {}\nimpl view {} ulps\n{}",
                self.book.classes[l.class as usize],
                m.unpaid.to_f64() * 18446744073709551616.0,
                m.amount,
                self.book.uncovered_of(l).unwrap(),
                ctx()
            );
            self.max_deficit_ratio = self.max_deficit_ratio.max(deficit / eps);
            // ready only goes down by its holder's own action
            if !touched.contains(id) {
                if let Some(prev) = before.get(id) {
                    assert!(
                        ready >= *prev,
                        "ready of {id:?} fell without its holder acting\n{}",
                        ctx()
                    );
                }
            }
        }
        for (class, sum) in class_ready.iter().enumerate() {
            let c = &self.book.classes[class];
            assert!(
                *sum <= c.ready,
                "lines hold more ready than the class pool\n{}",
                ctx()
            );
        }
        // Left to pay back is the class counters; it stays within the bound of the exact figure
        let impl_total = self.book.uncovered_total();
        let exact = self.model.unpaid_total().floor_fp();
        let gap = (BigInt::from(impl_total) - exact).to_f64().unwrap();
        let eps_total = self.ops as f64 * (64.0 + self.issued as f64 * 4.0);
        assert!(
            gap.abs() <= eps_total,
            "debt is {gap} ulps from exact\n{}",
            ctx()
        );
        // coverage released by return_own stays within the bound of what the exact model returned
        let r_gap = BigInt::from(self.book.r) - self.model.returned.floor_fp();
        assert!(
            r_gap.to_f64().unwrap() <= eps_total,
            "R is {r_gap} ulps above exact\n{}",
            ctx()
        );
    }
}

fn pick_line(r: &mut Rng, sys: &Sys, pred: impl Fn(&LineId, &Line) -> bool) -> Option<LineId> {
    let ids: Vec<LineId> = sys
        .lines
        .iter()
        .filter(|(i, l)| pred(i, l))
        .map(|(i, _)| *i)
        .collect();
    if ids.is_empty() {
        None
    } else {
        Some(ids[r.below(ids.len() as u64) as usize])
    }
}

fn pick_k(r: &mut Rng, max: u64) -> u64 {
    match r.below(5) {
        0 => 1,
        1 => max,
        2 => (max / 2).max(1),
        3 => r.range(1, max.min(10)),
        _ => r.range(1, max),
    }
}

fn run(seed: u64, mode: Mode, steps: usize) -> Sys {
    let mut r = Rng(seed);
    let mut sys = Sys::new();
    let (first, cap): (u64, u64) = match mode {
        Mode::Small => (r.range(1, 40), 2_000),
        Mode::Huge => (r.range(1 << 55, 1 << 61), u64::MAX - (1 << 62)),
        Mode::Dust => (r.range(1_000, 1_000_000), 1 << 40),
        Mode::Mixed => {
            let w = r.range(1, 50);
            (r.range(1, 1 << w), 1 << 60)
        }
    };
    sys.issue((OWNER, CLASS_GENERAL), first);
    for _ in 0..steps {
        let roll = r.below(100);
        let n_classes = sys.book.class_count();
        if roll < 22 {
            // land coverage
            let unpaid = sys.book.uncovered_total();
            let delta: u128 = match mode {
                Mode::Dust => r.range(1, 5_000) as u128,
                _ => match r.below(9) {
                    0 => r.range(1, 1000) as u128,
                    1 => unpaid / (1 + r.below(1000) as u128),
                    2 => unpaid / (1 + r.below(4) as u128),
                    3 => {
                        // exactly what the first classes owe: full covers and epochs
                        let upto = r.below(n_classes as u64) as usize;
                        sys.book.classes[..=upto].iter().map(|c| c.uncovered).sum()
                    }
                    4 => unpaid,
                    5 => unpaid.saturating_add(r.range(0, 3) as u128),
                    6 => r.shaped() >> r.range(20, 100),
                    7 => 0,
                    _ => unpaid.saturating_sub(r.range(0, 3) as u128),
                },
            };
            let shares =
                (delta >> 30).saturating_mul(r.range(1, 1 << 20) as u128) + r.range(0, 5) as u128;
            sys.sync(delta, shares);
        } else if roll < 44 {
            let Some(src) = pick_line(&mut r, &sys, |_, l| l.class >= CLASS_GENERAL) else {
                continue;
            };
            let amount = sys.lines[&src].amount;
            let k = pick_k(&mut r, amount);
            let holder = [1u8, 2, 3, TREASURY, OWNER][r.below(5) as usize];
            if (holder, src.1) == src {
                continue;
            }
            sys.transfer(src, (holder, src.1), k);
        } else if roll < 56 {
            let Some(src) = pick_line(&mut r, &sys, |_, l| l.class >= CLASS_GENERAL) else {
                continue;
            };
            let amount = sys.lines[&src].amount;
            let k = pick_k(&mut r, amount.min(1 + amount / 20));
            let fee_class = r.below(3) as u8;
            let holder = if fee_class == 1 && r.below(2) == 0 {
                13
            } else {
                holder_of_fee(fee_class)
            };
            sys.cut_fee(src, (holder, fee_class), k);
        } else if roll < 70 {
            let Some(id) = pick_line(&mut r, &sys, |_, l| fp_floor(sys_ready(&sys, l)) >= 1) else {
                continue;
            };
            let ready = fp_floor(sys_ready(&sys, &sys.lines[&id]));
            let k = pick_k(&mut r, ready);
            sys.redeem(id, k);
        } else if roll < 78 {
            let Some(id) = pick_line(&mut r, &sys, |i, l| {
                i.0 == OWNER && l.class >= CLASS_GENERAL
            }) else {
                continue;
            };
            let k = pick_k(&mut r, sys.lines[&id].amount);
            sys.return_own(id, k);
        } else if roll < 84 {
            // Instant Redeem: the ready part is redeemed, the rest is sold to the Treasury in
            // its class and tranche
            let Some(id) = pick_line(&mut r, &sys, |i, l| {
                i.0 != TREASURY && l.class >= CLASS_GENERAL
            }) else {
                continue;
            };
            let ready = fp_floor(sys_ready(&sys, &sys.lines[&id]));
            if ready > 0 {
                sys.redeem(id, ready);
            }
            if let Some(l) = sys.lines.get(&id) {
                let k = l.amount;
                sys.transfer(id, (TREASURY, id.1), k);
            }
        } else if roll < 87 {
            if sys.book.n_ext < MAX_EXTENSIONS && sys.issued < cap {
                let k = r.range(1, (cap - sys.issued).min(first.max(2)));
                sys.extend(k);
            }
        } else if roll < 90 {
            if sys.issued < cap {
                let k = r.range(1, (cap - sys.issued).min(first.max(2)));
                sys.issue((OWNER, CLASS_GENERAL), k);
            }
        } else if roll < 92 {
            sys.take_pocket();
        } else if roll < 96 {
            // a holder pays fee Gemas out of ready ones
            let Some(id) = pick_line(&mut r, &sys, |i, _| i.1 < CLASS_GENERAL) else {
                continue;
            };
            let ready = fp_floor(sys_ready(&sys, &sys.lines[&id]));
            if ready > 0 {
                let k = pick_k(&mut r, ready);
                sys.redeem(id, k);
            }
        }
    }
    sys
}

fn sys_ready(sys: &Sys, l: &Line) -> u128 {
    sys.book.ready_of(l).unwrap()
}

fn seeds(default: u64) -> u64 {
    std::env::var("BOOK_FUZZ_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn fuzz(mode: Mode, default_seeds: u64, steps: usize) {
    let base: u64 = std::env::var("BOOK_FUZZ_BASE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut worst = 0f64;
    let mut worst_excess = 0f64;
    for seed in base..base + seeds(default_seeds) {
        let sys = run(
            seed.wrapping_mul(0x1234_5678_9ABC_DEF1) ^ 0xDEAD,
            mode,
            steps,
        );
        worst = worst.max(sys.max_deficit_ratio);
        worst_excess = worst_excess.max(sys.max_excess);
    }
    eprintln!(
        "{mode:?}: worst deficit / bound = {worst:.6}, worst excess over model {worst_excess} ulps"
    );
}

#[test]
fn fuzz_mixed_against_the_exact_model() {
    fuzz(Mode::Mixed, 200, 150);
}

#[test]
fn fuzz_small_amounts_and_many_epochs() {
    fuzz(Mode::Small, 200, 200);
}

#[test]
fn fuzz_huge_amounts_near_the_u64_edge() {
    fuzz(Mode::Huge, 150, 120);
}

#[test]
fn fuzz_dust_landings_through_many_scales() {
    fuzz(Mode::Dust, 100, 250);
}

// ---------------------------------------------------------------- regressions and directed cases
//
// Each of these is a counterexample from the spec reviews (rereview-*, recheck3-*, recheck4-*)
// or an adversarial sequence from the ticket. Numbers are chosen so the exact answer is
// representable (landings that leave a dyadic fraction), which makes the assertions exact.

const G: u128 = FP_ONE;

fn gline(class: u8, who: u8) -> Line {
    SourceBook::blank_line(
        SIDE_OWN,
        who as i64,
        SRC,
        class,
        class.saturating_sub(CLASS_GENERAL),
    )
}

fn ready(book: &SourceBook, l: &Line) -> u128 {
    book.ready_of(l).unwrap()
}

fn unpaid(book: &SourceBook, l: &Line) -> u128 {
    book.uncovered_of(l).unwrap()
}

/// Land `delta` on top of `H` with `shares` whole shares.
fn land(book: &mut SourceBook, delta: u128, shares: u128) -> Landing {
    let to = book.h + delta;
    book.land(to, shares << SHARE_BITS).unwrap()
}

fn all_lines<'a>(ls: &'a [&'a Line]) -> impl Iterator<Item = &'a Line> {
    ls.iter().copied()
}

#[test]
fn a_class_paid_in_full_starts_a_new_epoch_and_new_fees_get_their_own_share() {
    // Claude round 2 N1: Platform 100 repaid in full, then 50 more arrive; 25 lands.
    let mut b = SourceBook::new();
    let mut platform = gline(0, 10);
    let mut general = gline(CLASS_GENERAL, 0);
    b.issue(&mut platform, 100).unwrap();
    b.issue(&mut general, 1_000).unwrap();
    land(&mut b, 100 * G, 0);
    assert_eq!(b.classes[0].epoch, 1);
    assert_eq!(ready(&b, &platform), 100 * G);
    assert_eq!(unpaid(&b, &platform), 0);
    assert_eq!(ready(&b, &general), 0);

    b.issue(&mut platform, 50).unwrap();
    land(&mut b, 25 * G, 0);
    // 25 of the new 50 repaid, never the 50 an index reset to zero would have claimed
    assert_eq!(ready(&b, &platform), 125 * G);
    assert_eq!(unpaid(&b, &platform), 25 * G);
    assert_eq!(
        ready(&b, &general),
        0,
        "General waits while Platform is unpaid"
    );
    b.check(0, all_lines(&[&platform, &general])).unwrap();
}

#[test]
fn a_finite_index_cannot_manufacture_ready() {
    // Codex round 2 N1: 100 unpaid, 99 allocated, 100 new unpaid, 1 allocated.
    let mut b = SourceBook::new();
    let mut a = gline(CLASS_GENERAL, 1);
    let mut c = gline(CLASS_GENERAL, 2);
    b.issue(&mut a, 100).unwrap();
    land(&mut b, 99 * G, 0);
    b.issue(&mut c, 100).unwrap();
    land(&mut b, G, 0);
    let total = ready(&b, &a) + ready(&b, &c);
    assert!(
        total <= 100 * G,
        "ready {total} exceeds the 100 that landed"
    );
    assert!(
        total >= 100 * G - 8,
        "and not by more than rounding below it"
    );
    // exactly: a has 1 unpaid, c has 100: the last Gema splits 1:100
    let want_a = 99 * G + G / 101;
    assert!(ready(&b, &a) <= want_a && want_a - ready(&b, &a) <= 8);
}

#[test]
fn sub_gema_fractions_survive_touching_at_every_landing() {
    // Claude round 2 N2: a 1,000 Gema line, 2,000 landings of 0.4 Gema. Touched at every landing
    // or only once, it must end at 800 ready (within rounding), never 500.
    let landing = (G / 10) * 4;
    let mut once = SourceBook::new();
    let mut touched = SourceBook::new();
    let mut l_once = gline(CLASS_GENERAL, 1);
    let mut l_touched = gline(CLASS_GENERAL, 1);
    once.issue(&mut l_once, 1_000).unwrap();
    touched.issue(&mut l_touched, 1_000).unwrap();
    for _ in 0..2_000 {
        land(&mut once, landing, 0);
        land(&mut touched, landing, 0);
        touched.materialise(&mut l_touched).unwrap();
    }
    let exact = 2_000 * landing;
    for (b, l) in [(&once, &l_once), (&touched, &l_touched)] {
        let got = ready(b, l);
        assert!(got <= exact);
        assert!(exact - got < 20_000, "off by {} ulps", exact - got);
    }
    let diff = ready(&once, &l_once).abs_diff(ready(&touched, &l_touched));
    assert!(diff < 20_000);
}

#[test]
fn return_own_gives_back_exactly_its_ready_and_nothing_twice() {
    // Round 2 N3, round 3 F3, round 4 H1: owner 96 + others 32, 32 repaid.
    let mut b = SourceBook::new();
    let mut owner = gline(CLASS_GENERAL, 0);
    let mut other = gline(CLASS_GENERAL, 1);
    b.issue(&mut owner, 128).unwrap();
    let mut o = owner;
    b.transfer(&mut o, &mut other, 32).unwrap();
    let mut owner = o;
    land(&mut b, 32 * G, 32);
    assert_eq!(ready(&b, &owner), 24 * G);
    assert_eq!(ready(&b, &other), 8 * G);
    assert_eq!(b.uncovered_total(), 96 * G);

    let r = b.return_own(&mut owner, 96).unwrap();
    assert_eq!((r.ready, r.cancelled, r.dust), (24 * G, 72 * G, 0));
    assert_eq!(
        b.uncovered_total(),
        24 * G,
        "Left to pay back fell by exactly the cancelled part"
    );
    assert_eq!((b.h, b.r, b.net_coverage()), (32 * G, 24 * G, 8 * G));
    assert_eq!(b.ready_total(), 8 * G, "ready + redeemed <= C");
    assert_eq!(b.owner_fp, 24 * G);
    b.check(0, all_lines(&[&other])).unwrap();

    // the yield figure is unchanged, so nothing lands again
    assert_eq!(b.pending(32 * G), 0);
    assert_eq!(b.land(32 * G, 0).unwrap(), Landing::default());
    // owner closes: the pocket is paid once, and the checkpoint H is untouched
    let (pocket, shares) = b.take_owner_pocket().unwrap();
    assert_eq!((pocket, shares >> SHARE_BITS), (24 * G, 24));
    assert_eq!((b.owner_fp, b.taken_fp, b.h), (0, 24 * G, 32 * G));
    assert_eq!(b.take_owner_pocket().unwrap().0, 0);
    // the rest of the Debt lands later and repays the other holder, not the owner
    land(&mut b, 24 * G, 24);
    assert_eq!(ready(&b, &other), 32 * G);
    assert_eq!(b.classes[CLASS_GENERAL as usize].uncovered, 0);
    b.check(0, all_lines(&[&other])).unwrap();
}

#[test]
fn an_extension_never_slows_earlier_holders_even_after_instant_redeem() {
    // Round 3 F4 / Claude H2: General 100 unpaid, Extension 100 unpaid, the Extension is sold.
    let mut b = SourceBook::new();
    let mut a = gline(CLASS_GENERAL, 1);
    b.issue(&mut a, 100).unwrap();
    let class = b.start_extension().unwrap();
    assert_eq!(class, CLASS_GENERAL + 1);
    let mut ext = gline(class, 0);
    b.issue(&mut ext, 100).unwrap();
    // the Treasury buys the unpaid Extension: same class, so it is not promoted
    let mut t = gline(class, TREASURY);
    b.transfer(&mut ext, &mut t, 100).unwrap();
    assert_eq!(t.class, class);
    assert_eq!(
        b.transfer(&mut t, &mut gline(CLASS_GENERAL, TREASURY), 1),
        Err(BookError::ClassMismatch),
        "no transfer changes class"
    );
    land(&mut b, 100 * G, 0);
    assert_eq!(
        ready(&b, &a),
        100 * G,
        "the General holder is paid first and in full"
    );
    assert_eq!(ready(&b, &t), 0);
    // a later Extend is junior to the first Extension
    let class2 = b.start_extension().unwrap();
    let mut ext2 = gline(class2, 0);
    b.issue(&mut ext2, 100).unwrap();
    land(&mut b, 100 * G, 0);
    assert_eq!(ready(&b, &t), 100 * G);
    assert_eq!(ready(&b, &ext2), 0);
    land(&mut b, 100 * G, 0);
    assert_eq!(ready(&b, &ext2), 100 * G);
    b.check(0, all_lines(&[&a, &t, &ext2])).unwrap();
}

#[test]
fn moves_carry_their_proportional_ready_and_nothing_else() {
    // Round 3 F7: amount 100 with half ready; moving 50 moves 25 ready, not 0 and not 50.
    let mut b = SourceBook::new();
    let mut l = gline(CLASS_GENERAL, 1);
    b.issue(&mut l, 128).unwrap();
    land(&mut b, 64 * G, 0);
    assert_eq!(ready(&b, &l), 64 * G);
    let mut dst = gline(CLASS_GENERAL, 2);
    let m = b.transfer(&mut l, &mut dst, 64).unwrap();
    assert_eq!((m.ready, m.uncovered, m.dust), (32 * G, 32 * G, 0));
    assert_eq!((ready(&b, &l), ready(&b, &dst)), (32 * G, 32 * G));
    assert_eq!((unpaid(&b, &l), unpaid(&b, &dst)), (32 * G, 32 * G));
    // moving all of it moves all of the ready
    let mut sink = gline(CLASS_GENERAL, 3);
    b.transfer(&mut dst, &mut sink, 64).unwrap();
    assert_eq!((dst.amount, ready(&b, &sink)), (0, 32 * G));
    b.check(0, all_lines(&[&l, &sink])).unwrap();
}

#[test]
fn lines_with_stale_snapshots_merge_only_after_both_are_brought_up_to_date() {
    // Codex round 2 N2: a 100 line with latent ready next to a 100 that arrives later.
    let mut b = SourceBook::new();
    let mut old = gline(CLASS_GENERAL, 1);
    b.issue(&mut old, 128).unwrap();
    land(&mut b, 64 * G, 0);
    // old is untouched: its snapshot is the start of the epoch, its ready is latent
    assert_eq!(old.uncovered, 128 * G);
    let mut fresh = gline(CLASS_GENERAL, 2);
    b.issue(&mut fresh, 128).unwrap();
    // fresh joined at the current index; merge them through a transfer into `old`
    let mut keep = old;
    b.transfer(&mut fresh, &mut keep, 128).unwrap();
    assert_eq!(keep.amount, 256);
    // 128 Gemas had 64 ready; the 128 new ones had none: 64 total, not 128
    assert_eq!(ready(&b, &keep), 64 * G);
    assert_eq!(unpaid(&b, &keep), 192 * G);
    b.check(0, all_lines(&[&keep])).unwrap();
}

#[test]
fn classes_are_paid_strictly_in_order() {
    let mut b = SourceBook::new();
    let mut platform = gline(0, 10);
    let mut studio = gline(1, 11);
    let mut board = gline(2, 12);
    let mut general = gline(CLASS_GENERAL, 0);
    for (l, k) in [
        (&mut general, 100u64),
        (&mut board, 10),
        (&mut studio, 10),
        (&mut platform, 10),
    ] {
        b.issue(l, k).unwrap();
    }
    land(&mut b, 5 * G, 0);
    assert_eq!(ready(&b, &platform), 5 * G);
    land(&mut b, 5 * G, 0);
    assert_eq!((ready(&b, &platform), ready(&b, &studio)), (10 * G, 0));
    land(&mut b, 10 * G, 0);
    assert_eq!((ready(&b, &studio), ready(&b, &board)), (10 * G, 0));
    land(&mut b, 12 * G, 0);
    assert_eq!(ready(&b, &board), 10 * G);
    // 2 of General's 100 (landing a non-dyadic fraction rounds the holder's ready down)
    assert!(ready(&b, &general) <= 2 * G && 2 * G - ready(&b, &general) < 4);
    b.check(0, all_lines(&[&platform, &studio, &board, &general]))
        .unwrap();
}

#[test]
fn a_fee_is_repaid_only_from_yield_that_lands_after_it_arrives() {
    // Spec: "fee arriving with stale yield". The settlement syncs the Source first; then the fee
    // class takes only later yield. 32 of 128 already repaid when the fee is cut.
    let mut b = SourceBook::new();
    let mut winner_side = gline(CLASS_GENERAL, 1);
    b.issue(&mut winner_side, 128).unwrap();
    land(&mut b, 32 * G, 0); // synced before the fee
    let mut platform = gline(0, 10);
    b.cut_fee(&mut winner_side, &mut platform, 64).unwrap();
    // the fee's ready part (16) moved with it; only its unpaid 48 is senior now
    assert_eq!(
        (ready(&b, &platform), unpaid(&b, &platform)),
        (16 * G, 48 * G)
    );
    assert_eq!(
        (ready(&b, &winner_side), unpaid(&b, &winner_side)),
        (16 * G, 48 * G)
    );
    land(&mut b, 48 * G, 0);
    assert_eq!(unpaid(&b, &platform), 0, "Platform first");
    assert_eq!(ready(&b, &platform), 64 * G);
    assert_eq!(ready(&b, &winner_side), 16 * G, "General waited");
    land(&mut b, 8 * G, 0);
    assert_eq!(ready(&b, &winner_side), 24 * G);
    b.check(0, all_lines(&[&platform, &winner_side])).unwrap();
}

#[test]
fn fee_cuts_move_shares_with_the_ready_part() {
    let mut b = SourceBook::new();
    let mut loser = gline(CLASS_GENERAL, 1);
    b.issue(&mut loser, 128).unwrap();
    land(&mut b, 64 * G, 64); // 64 ready backed by 64 shares
    let mut platform = gline(0, 10);
    b.cut_fee(&mut loser, &mut platform, 32).unwrap();
    // 16 ready moved with 16 shares
    assert_eq!(b.classes[0].ready, 16 * G);
    assert_eq!(b.classes[0].shares, 16 << SHARE_BITS);
    assert_eq!(b.classes[CLASS_GENERAL as usize].shares, 48 << SHARE_BITS);
    let r = b.redeem(&mut platform, 16).unwrap();
    assert_eq!(r.shares, 16);
    assert_eq!(b.classes[0].ready, 0);
    // the fee class cannot be played and a fee cut needs the right shape
    let mut other = gline(CLASS_GENERAL, 2);
    assert_eq!(
        b.cut_fee(&mut loser, &mut other, 1),
        Err(BookError::NotAFeeCut)
    );
    let mut studio = gline(1, 11);
    assert_eq!(
        b.cut_fee(&mut platform, &mut studio, 1),
        Err(BookError::NotAFeeCut)
    );
}

#[test]
fn slashing_lowers_value_and_never_the_gema_count() {
    // The shares behind ready are fixed when yield lands; the value of a share follows the staking
    // token. The ledger's part: ready Gemas of a class share that class's shares, redeeming pays
    // them at the pool's rate rounded down, and no landing ever lowers a holder's ready count.
    let mut b = SourceBook::new();
    let mut a = gline(CLASS_GENERAL, 1);
    let mut c = gline(CLASS_GENERAL, 2);
    b.issue(&mut a, 100).unwrap();
    let mut a2 = a;
    b.transfer(&mut a2, &mut c, 50).unwrap();
    a = a2;
    land(&mut b, 100 * G, 90); // 100 ready worth 90 shares
    assert_eq!(b.shares_for(CLASS_GENERAL, 100).unwrap(), 90);
    assert_eq!(b.redeem(&mut a, 50).unwrap().shares, 45);
    assert_eq!(
        b.redeem(&mut c, 25).unwrap().shares,
        22,
        "22.5 paid as 22: against the redeemer"
    );
    let pool = b.classes[CLASS_GENERAL as usize];
    assert_eq!((pool.ready, pool.shares), (25 * G, 23 << SHARE_BITS));
    // later yield lands at a lower share price (after a slash it takes more shares to carry the
    // same value): the pool takes it in, and c still has exactly its 25 ready Gemas
    let mut d = gline(CLASS_GENERAL, 3);
    b.issue(&mut d, 100).unwrap();
    land(&mut b, 100 * G, 130);
    assert_eq!(ready(&b, &c), 25 * G, "the Gema count never goes down");
    let pool = b.classes[CLASS_GENERAL as usize];
    assert_eq!((pool.ready, pool.shares), (125 * G, 153 << SHARE_BITS));
    assert_eq!(b.shares_for(CLASS_GENERAL, 25).unwrap(), 30);
    b.check(75, all_lines(&[&c, &d])).unwrap();
}

#[test]
fn coverage_is_a_high_water_mark() {
    let mut b = SourceBook::new();
    let mut a = gline(CLASS_GENERAL, 1);
    b.issue(&mut a, 100).unwrap();
    land(&mut b, 40 * G, 40);
    let snapshot = b.clone();
    // the computed figure falls (a slash, a correction): nothing lands, nothing is taken back
    assert_eq!(b.land(30 * G, 1 << 40).unwrap(), Landing::default());
    assert_eq!(b, snapshot);
    // it recovers to 40: still nothing new; only above H does anything land
    assert_eq!(b.land(40 * G, 1 << 40).unwrap(), Landing::default());
    let l = b.land(41 * G, 1 << SHARE_BITS).unwrap();
    assert_eq!((l.delta, l.excess), (G, 0));
    assert!(ready(&b, &a) <= 41 * G && 41 * G - ready(&b, &a) < 16);
}

#[test]
fn coverage_beyond_everything_unpaid_is_the_owners() {
    let mut b = SourceBook::new();
    let mut a = gline(CLASS_GENERAL, 1);
    b.issue(&mut a, 10).unwrap();
    let l = land(&mut b, 25 * G, 25);
    assert_eq!((l.delta, l.excess), (25 * G, 15 * G));
    assert_eq!(b.owner_fp, 15 * G);
    assert_eq!(b.owner_shares, 15 << SHARE_BITS, "its shares go with it");
    assert_eq!(ready(&b, &a), 10 * G);
    assert_eq!(b.classes[CLASS_GENERAL as usize].shares, 10 << SHARE_BITS);
    // an Extend afterwards starts unpaid, with no inherited coverage
    let class = b.start_extension().unwrap();
    let mut e = gline(class, 0);
    b.issue(&mut e, 5).unwrap();
    assert_eq!(ready(&b, &e), 0);
    assert_eq!(b.pending(25 * G), 0);
    b.check(0, all_lines(&[&a, &e])).unwrap();
}

#[test]
fn tiny_transfers_cannot_farm_rounding() {
    // Many one-Gema moves back and forth: nothing is created, and the rounding that is lost goes
    // to the owner's pocket, never to either side.
    let mut b = SourceBook::new();
    let mut x = gline(CLASS_GENERAL, 1);
    let mut y = gline(CLASS_GENERAL, 2);
    b.issue(&mut x, 1_001).unwrap();
    land(&mut b, 333 * G + 12_345, 333);
    let start = ready(&b, &x);
    let mut moved = 0u128;
    for i in 0..4_000 {
        let (s, d) = if i % 3 == 0 {
            (&mut y, &mut x)
        } else {
            (&mut x, &mut y)
        };
        if s.amount == 0 {
            continue;
        }
        moved += b.transfer(s, d, 1).unwrap().dust;
    }
    let after = ready(&b, &x) + ready(&b, &y);
    assert!(after <= start, "no ready was created");
    assert_eq!(
        after + b.owner_fp,
        start,
        "what was lost is exactly the owner's pocket"
    );
    assert_eq!(moved, b.owner_fp);
    assert!(moved < 4_000, "at most one unit per move");
    b.check(0, all_lines(&[&x, &y])).unwrap();
}

#[test]
fn a_class_drained_by_return_own_marks_the_rest_fully_repaid() {
    let mut b = SourceBook::new();
    let mut owner = gline(CLASS_GENERAL, 0);
    b.issue(&mut owner, 128).unwrap();
    let mut other = gline(CLASS_GENERAL, 1);
    let mut o = owner;
    b.transfer(&mut o, &mut other, 64).unwrap();
    land(&mut b, 32 * G, 0); // 25% repaid: each holds 16 ready, 48 unpaid
    let mut owner = o;
    let r = b.return_own(&mut owner, 64).unwrap();
    assert_eq!((r.ready, r.cancelled), (16 * G, 48 * G));
    assert_eq!(b.uncovered_total(), 48 * G);
    // 48 more lands: the other holder is now repaid in full, and the class starts a new epoch
    land(&mut b, 48 * G, 0);
    assert_eq!(ready(&b, &other), 64 * G);
    assert_eq!(b.classes[CLASS_GENERAL as usize].epoch, 1);
    b.check(0, all_lines(&[&other])).unwrap();
}

#[test]
fn errors_change_nothing() {
    let mut b = SourceBook::new();
    let mut a = gline(CLASS_GENERAL, 1);
    b.issue(&mut a, 10).unwrap();
    land(&mut b, 4 * G, 4);
    let mut d = gline(CLASS_GENERAL, 2);
    let (b0, a0, d0) = (b.clone(), a, d);
    assert_eq!(b.redeem(&mut a, 5), Err(BookError::NotEnoughReady));
    assert_eq!(b.redeem(&mut a, 0), Err(BookError::ZeroAmount));
    assert_eq!(
        b.transfer(&mut a, &mut d, 11),
        Err(BookError::NotEnoughAmount)
    );
    assert_eq!(b.transfer(&mut a, &mut d, 0), Err(BookError::ZeroAmount));
    assert_eq!(b.return_own(&mut a, 11), Err(BookError::NotEnoughAmount));
    let mut wrong_class = gline(CLASS_GENERAL + 1, 2);
    assert_eq!(
        b.transfer(&mut a, &mut wrong_class, 1),
        Err(BookError::ClassMismatch)
    );
    assert_eq!(b.issue(&mut wrong_class, 1), Err(BookError::NoSuchClass));
    let mut other_source = d;
    other_source.source = [8; 32];
    assert_eq!(
        b.transfer(&mut a, &mut other_source, 1),
        Err(BookError::ClassMismatch)
    );
    assert_eq!(b.start_extension().map(|_| ()), Ok(()));
    assert_eq!((b.clone() == b0, a == a0, d == d0), (false, true, true));
    let mut b1 = b0.clone();
    for _ in 0..MAX_EXTENSIONS {
        b1.start_extension().unwrap();
    }
    assert_eq!(b1.start_extension(), Err(BookError::TooManyExtensions));
}

#[test]
fn overflow_at_the_u64_edge_is_refused_without_changes() {
    let mut b = SourceBook::new();
    let mut a = gline(CLASS_GENERAL, 1);
    b.issue(&mut a, u64::MAX - 5).unwrap();
    let before = (b.clone(), a);
    assert_eq!(b.issue(&mut a, 6), Err(BookError::Math));
    assert_eq!((b.clone(), a), before);
    b.issue(&mut a, 5).unwrap();
    assert_eq!(a.amount, u64::MAX);
    assert_eq!(b.uncovered_total(), u64::MAX as u128 * G);
    // landing everything at the edge starts the next epoch and leaves exact ready
    land(&mut b, u64::MAX as u128 * G, 7);
    assert_eq!(ready(&b, &a), u64::MAX as u128 * G);
    assert_eq!(b.redeemable(&a).unwrap(), u64::MAX);
    let mut c = gline(CLASS_GENERAL, 2);
    b.transfer(&mut a, &mut c, u64::MAX).unwrap();
    assert_eq!((a.amount, c.amount), (0, u64::MAX));
    // the destination cannot take more than u64
    let mut full = c;
    b.issue(&mut a, 1).unwrap();
    let guard = (b.clone(), a, full);
    assert_eq!(b.transfer(&mut a, &mut full, 1), Err(BookError::Math));
    assert_eq!((b, a, full), guard);
}

#[test]
fn an_exhausted_epoch_counter_is_refused_atomically() {
    let mut b = SourceBook::new();
    let mut a = gline(CLASS_GENERAL, 1);
    b.issue(&mut a, 10).unwrap();
    b.classes[CLASS_GENERAL as usize].epoch = u32::MAX;
    a.epoch = u32::MAX;
    let before = b.clone();
    assert_eq!(b.land(10 * G, 0), Err(BookError::Math));
    assert_eq!(b, before);
}

#[test]
fn a_scale_of_dust_landings_matches_the_exact_model() {
    // 2^100 unpaid in one line; land all but a sliver, over and over, refilling in between so the
    // index crosses many scales and snapshots are old.
    let mut sys = Sys::new();
    sys.issue((OWNER, CLASS_GENERAL), 1 << 36);
    let mut r = Rng(99);
    for round in 0..40 {
        let u = sys.book.uncovered_total();
        let w = r.range(1, 20);
        let keep = r.range(1, 1 << w) as u128;
        sys.sync(u.saturating_sub(keep), 1 << 40);
        if round % 3 == 0 {
            sys.issue((OWNER, CLASS_GENERAL), r.range(1, 1 << 30));
        }
        sys.transfer((OWNER, CLASS_GENERAL), (1, CLASS_GENERAL), 1);
    }
    assert!(
        sys.book.classes[CLASS_GENERAL as usize].scale >= 2
            || sys.book.classes[CLASS_GENERAL as usize].epoch >= 1
    );
}

#[test]
fn the_book_survives_a_round_trip_through_bytes() {
    for seed in 0..40 {
        let sys = run(seed, Mode::Mixed, 60);
        let mut buf = vec![0xEEu8; SourceBook::encoded_len(sys.book.n_ext) + 7];
        sys.book.encode(&mut buf).unwrap();
        assert_eq!(SourceBook::decode(&buf).unwrap(), sys.book);
        assert_eq!(
            buf.len() - 7,
            BOOK_FIXED_LEN + sys.book.class_count() * CLASS_LEN
        );
    }
    assert!(SourceBook::decode(&[0u8; 10]).is_err());
    let mut zero_p = vec![0u8; SourceBook::encoded_len(0)];
    SourceBook::new().encode(&mut zero_p).unwrap();
    zero_p[BOOK_FIXED_LEN] = 0;
    for b in zero_p[BOOK_FIXED_LEN..BOOK_FIXED_LEN + 16].iter_mut() {
        *b = 0;
    }
    assert_eq!(SourceBook::decode(&zero_p), Err(BookError::BadSnapshot));
}

#[test]
fn landing_splits_shares_by_what_each_class_took() {
    let mut b = SourceBook::new();
    let mut p = gline(0, 10);
    let mut g = gline(CLASS_GENERAL, 0);
    b.issue(&mut p, 10).unwrap();
    b.issue(&mut g, 90).unwrap();
    // 100 lands worth 200 shares: 10 to Platform, 90 to General, none left over
    land(&mut b, 100 * G, 200);
    assert_eq!(b.classes[0].shares, 20 << SHARE_BITS);
    assert_eq!(b.classes[CLASS_GENERAL as usize].shares, 180 << SHARE_BITS);
    // with excess: 30 owed, 50 lands worth 100 shares: 60 shares to the class, 40 to the owner
    let mut b = SourceBook::new();
    let mut g = gline(CLASS_GENERAL, 0);
    b.issue(&mut g, 30).unwrap();
    land(&mut b, 50 * G, 100);
    assert_eq!(b.classes[CLASS_GENERAL as usize].shares, 60 << SHARE_BITS);
    assert_eq!(b.owner_shares, 40 << SHARE_BITS);
    // a pool left with no ready releases its dust shares to the owner
    let r = b.redeem(&mut g, 30).unwrap();
    assert_eq!(r.shares, 60);
    assert_eq!(b.classes[CLASS_GENERAL as usize].shares, 0);
}

#[test]
fn junior_classes_never_touch_senior_ones() {
    // Two worlds see the same yield and the same operations on the fee and General classes. World B
    // also starts Extensions, sells them, redeems them and returns them. Nothing a senior holder
    // can observe may differ: not their lines, not their ready, not the class state.
    for seed in 0..60u64 {
        let mut r = Rng(seed ^ 0xABCD);
        let (mut a, mut b) = (SourceBook::new(), SourceBook::new());
        let mut la: BTreeMap<u8, Line> = BTreeMap::new();
        let mut lb: BTreeMap<u8, Line> = BTreeMap::new();
        let mut ext: BTreeMap<(u8, u8), Line> = BTreeMap::new();
        let first = r.range(100, 100_000);
        for (book, lines) in [(&mut a, &mut la), (&mut b, &mut lb)] {
            let mut l = gline(CLASS_GENERAL, 0);
            book.issue(&mut l, first).unwrap();
            lines.insert(0, l);
        }
        for step in 0..120 {
            match r.below(10) {
                0..=2 => {
                    let unpaid = a.uncovered_total();
                    let d = match r.below(3) {
                        0 => unpaid / (1 + r.below(50) as u128),
                        1 => r.range(1, 1 << 40) as u128,
                        _ => unpaid + r.range(0, 5) as u128,
                    };
                    let sh = d >> 20;
                    // the juniors' unpaid may differ between worlds, so seniors must be the only
                    // ones to see this landing: B has strictly more classes to pay afterwards
                    for book in [&mut a, &mut b] {
                        let to = book.h + d;
                        book.land(to, sh).unwrap();
                    }
                }
                3 | 4 => {
                    let src = pick_general(&la, &mut r);
                    let amount = la[&src].amount;
                    if amount == 0 {
                        continue;
                    }
                    let k = pick_k(&mut r, amount);
                    let dst = r.below(4) as u8;
                    for (book, lines) in [(&mut a, &mut la), (&mut b, &mut lb)] {
                        let mut s = lines[&src];
                        let mut d = lines
                            .get(&dst)
                            .copied()
                            .unwrap_or_else(|| gline(CLASS_GENERAL, dst));
                        if src != dst {
                            book.transfer(&mut s, &mut d, k).unwrap();
                            lines.insert(src, s);
                            lines.insert(dst, d);
                        }
                    }
                }
                5 => {
                    let src = pick_general(&la, &mut r);
                    let amount = la[&src].amount;
                    if amount < 2 {
                        continue;
                    }
                    let k = r.range(1, amount / 2);
                    let fee = r.below(3) as u8;
                    for (book, lines) in [(&mut a, &mut la), (&mut b, &mut lb)] {
                        let mut s = lines[&src];
                        let mut d = lines
                            .get(&(100 + fee))
                            .copied()
                            .unwrap_or_else(|| gline(fee, 100 + fee));
                        book.cut_fee(&mut s, &mut d, k).unwrap();
                        lines.insert(src, s);
                        lines.insert(100 + fee, d);
                    }
                }
                6 | 7 => {
                    // world B only: Extend, then sell, redeem or return junior Gemas
                    if b.n_ext < MAX_EXTENSIONS && r.below(3) == 0 {
                        let class = b.start_extension().unwrap();
                        let mut l = gline(class, 0);
                        b.issue(&mut l, r.range(1, 100_000)).unwrap();
                        ext.insert((0, class), l);
                    } else if let Some(&key) =
                        ext.keys().nth(r.below(ext.len().max(1) as u64) as usize)
                    {
                        let mut l = ext[&key];
                        if l.amount == 0 {
                            continue;
                        }
                        match r.below(3) {
                            0 => {
                                let mut t = ext
                                    .get(&(TREASURY, key.1))
                                    .copied()
                                    .unwrap_or_else(|| gline(key.1, TREASURY));
                                let k = l.amount;
                                b.transfer(&mut l, &mut t, k).unwrap();
                                ext.insert((TREASURY, key.1), t);
                            }
                            1 => {
                                let k = fp_floor(b.ready_of(&l).unwrap());
                                if k > 0 {
                                    b.redeem(&mut l, k).unwrap();
                                }
                            }
                            _ => {
                                let k = pick_k(&mut r, l.amount);
                                b.return_own(&mut l, k).unwrap();
                            }
                        }
                        ext.insert(key, l);
                    }
                }
                _ => {
                    // a General holder redeems what is ready
                    let src = *la.keys().nth(r.below(la.len() as u64) as usize).unwrap();
                    let k = fp_floor(a.ready_of(&la[&src]).unwrap());
                    if k > 0 && lb[&src].amount > 0 {
                        for (book, lines) in [(&mut a, &mut la), (&mut b, &mut lb)] {
                            let mut l = lines[&src];
                            book.redeem(&mut l, k).unwrap();
                            lines.insert(src, l);
                        }
                    }
                }
            }
            for class in 0..=CLASS_GENERAL as usize {
                assert_eq!(
                    a.classes[class], b.classes[class],
                    "seed {seed} step {step}: class {class}"
                );
            }
            assert_eq!(la, lb);
            for l in la.values() {
                assert_eq!(a.ready_of(l).unwrap(), b.ready_of(l).unwrap());
            }
        }
    }
}

fn pick_general(lines: &BTreeMap<u8, Line>, r: &mut Rng) -> u8 {
    let ids: Vec<u8> = lines.keys().copied().filter(|k| *k < 100).collect();
    ids[r.below(ids.len() as u64) as usize]
}

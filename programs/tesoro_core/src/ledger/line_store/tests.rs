use super::*;
use crate::ledger::book::wide::U256;

fn line(side: u8, due_at: i64, src: u8, class: u8, tranche: u8, amount: u64) -> Line {
    Line {
        side,
        class,
        tranche,
        due_at,
        source: [src; 32],
        amount,
        uncovered: amount as u128 * 3,
        p: 1 << 64,
        scale: 1,
        epoch: 2,
        ck: 3,
        shares: amount as u128 * 5,
        s_snap: U256([7, 0, 0, 1]),
        reserved: [0; 1],
    }
}

fn fresh(cap: usize) -> Vec<u8> {
    let mut buf = vec![0u8; required_len(cap)];
    LineStore::init(&mut buf[..], [9; 32], 254).unwrap();
    buf
}

#[test]
fn layout_constants_are_what_the_docs_say() {
    assert_eq!(HEADER_LEN, 128);
    assert_eq!(LINE_LEN, 144);
    let l = line(1, -5, 3, CLASS_GENERAL, 0, 11);
    let mut raw = [0xAAu8; LINE_LEN];
    l.encode(&mut raw);
    assert_eq!(Line::decode(&raw), l);
    assert_eq!(&raw[143..], &[0; 1]);
    assert_eq!(&raw[91..95], &3u32.to_le_bytes());
}

#[test]
fn init_writes_version_bump_account_and_rejects_bad_bodies() {
    let buf = fresh(2);
    let s = LineStore::new(&buf[..]).unwrap();
    assert_eq!(
        (s.version(), s.bump(), s.account()),
        (BASKET_VERSION, 254, [9; 32])
    );
    assert_eq!((s.len(), s.capacity()), (0, 2));
    assert!(LineStore::new(&buf[..HEADER_LEN - 1]).is_err());
    let mut bad = buf.clone();
    bad[0] = BASKET_VERSION + 1;
    assert_eq!(
        LineStore::new(&bad[..]).err(),
        Some(LineStoreError::BadStore)
    );
    let mut over = buf.clone();
    over[4] = 3;
    assert_eq!(
        LineStore::new(&over[..]).err(),
        Some(LineStoreError::BadStore)
    );
}

#[test]
fn sort_order_is_side_then_due_at_then_source_then_tranche() {
    let mut buf = fresh(8);
    let mut s = LineStore::new(&mut buf[..]).unwrap();
    let order = [
        line(SIDE_OWN, 50, 9, CLASS_GENERAL, 0, 1),
        line(SIDE_OWN, 60, 1, CLASS_GENERAL, 0, 1),
        line(SIDE_WON, -10, 5, CLASS_GENERAL, 0, 1),
        line(SIDE_WON, 10, 1, CLASS_GENERAL, 0, 1),
        line(SIDE_WON, 10, 2, CLASS_GENERAL, 0, 1),
        line(SIDE_WON, 10, 2, CLASS_GENERAL + 1, 1, 1),
        line(SIDE_WON, 10, 2, CLASS_GENERAL + 2, 2, 1),
    ];
    for l in order.iter().rev() {
        s.insert(l).unwrap();
    }
    assert_eq!(s.lines().collect::<Vec<_>>(), order);
    assert_eq!(s.first_of_side(SIDE_WON), 2);
    assert_eq!(s.first_of_side(SIDE_OWN), 0);
    s.check().unwrap();
}

#[test]
fn totals_split_own_won_and_fee_classes() {
    let mut buf = fresh(8);
    let mut s = LineStore::new(&mut buf[..]).unwrap();
    s.insert(&line(SIDE_OWN, 1, 1, CLASS_GENERAL, 0, 10))
        .unwrap();
    s.insert(&line(SIDE_WON, 1, 2, CLASS_GENERAL, 0, 20))
        .unwrap();
    s.insert(&line(SIDE_WON, 1, 3, CLASS_STUDIO, 0, 40))
        .unwrap();
    s.insert(&line(SIDE_WON, 1, 4, CLASS_EXTENSION_BASE, 1, 5))
        .unwrap();
    assert_eq!((s.own_total(), s.won_total(), s.fee_total()), (10, 25, 40));
    s.remove(&line(SIDE_WON, 1, 3, CLASS_STUDIO, 0, 0).key())
        .unwrap();
    assert_eq!(s.fee_total(), 0);
    s.check().unwrap();
}

#[test]
fn insert_refuses_duplicates_full_and_bad_side_without_changing_state() {
    let mut buf = fresh(1);
    let mut s = LineStore::new(&mut buf[..]).unwrap();
    s.insert(&line(0, 1, 1, CLASS_GENERAL, 0, 1)).unwrap();
    assert_eq!(
        s.insert(&line(0, 1, 1, CLASS_GENERAL, 0, 1)),
        Err(LineStoreError::Duplicate)
    );
    assert_eq!(
        s.insert(&line(0, 2, 1, CLASS_GENERAL, 0, 1)),
        Err(LineStoreError::Full)
    );
    assert_eq!(
        s.insert(&line(2, 2, 1, CLASS_GENERAL, 0, 1)),
        Err(LineStoreError::BadLine)
    );
    assert_eq!((s.len(), s.own_total()), (1, 1));
    s.check().unwrap();
}

#[test]
fn totals_overflow_is_refused_and_leaves_state() {
    let mut buf = fresh(3);
    let mut s = LineStore::new(&mut buf[..]).unwrap();
    s.insert(&line(0, 1, 1, CLASS_GENERAL, 0, u64::MAX))
        .unwrap();
    let before = buf_copy(&s);
    assert_eq!(
        s.insert(&line(0, 2, 1, CLASS_GENERAL, 0, 1)),
        Err(LineStoreError::Overflow)
    );
    assert_eq!(
        s.merge(&line(0, 1, 1, CLASS_GENERAL, 0, 1)),
        Err(LineStoreError::Overflow)
    );
    assert_eq!(before, buf_copy(&s));
}

fn buf_copy(s: &LineStore<&mut [u8]>) -> Vec<u8> {
    s.data.to_vec()
}

#[test]
fn merge_adds_only_after_materialise_and_keeps_reserved_bytes() {
    let mut buf = fresh(2);
    let mut s = LineStore::new(&mut buf[..]).unwrap();
    let mut base = line(1, 5, 1, CLASS_GENERAL, 0, 10);
    base.reserved = [7; 1];
    s.insert(&base).unwrap();
    let add = line(1, 5, 1, CLASS_GENERAL, 0, 4);
    assert_eq!(s.merge(&add), Ok(0));
    let got = s.get(0).unwrap();
    assert_eq!((got.amount, got.uncovered, got.shares), (14, 42, 70));
    assert_eq!(got.reserved, [7; 1]);
    assert_eq!(s.won_total(), 14);

    let mut stale = add;
    stale.epoch += 1;
    assert_eq!(s.merge(&stale), Err(LineStoreError::NotMaterialised));
    let mut dirty = add;
    dirty.reserved[0] = 1;
    assert_eq!(s.merge(&dirty), Err(LineStoreError::BadLine));
    assert_eq!(s.get(0).unwrap().amount, 14);
    // a new key inserts
    assert_eq!(s.merge(&line(1, 6, 1, CLASS_GENERAL, 0, 1)), Ok(1));
}

#[test]
fn set_line_keeps_the_key_and_updates_totals() {
    let mut buf = fresh(2);
    let mut s = LineStore::new(&mut buf[..]).unwrap();
    s.insert(&line(0, 1, 1, CLASS_GENERAL, 0, 10)).unwrap();
    let mut l = s.get(0).unwrap();
    l.amount = 3;
    s.set_line(0, &l).unwrap();
    assert_eq!(s.own_total(), 3);
    l.due_at = 2;
    assert_eq!(s.set_line(0, &l), Err(LineStoreError::KeyChanged));
    assert_eq!(s.set_line(5, &l), Err(LineStoreError::NotFound));
}

#[test]
fn remove_zeroes_the_vacated_slot_and_shrink_len_tracks_used_lines() {
    let mut buf = fresh(4);
    let mut s = LineStore::new(&mut buf[..]).unwrap();
    for i in 1..=3 {
        s.insert(&line(0, i as i64, 1, CLASS_GENERAL, 0, 1))
            .unwrap();
    }
    s.remove_at(0).unwrap();
    assert_eq!(s.shrinkable_len(), required_len(2));
    assert_eq!(s.remove_at(2), Err(LineStoreError::NotFound));
    assert!(s.data[HEADER_LEN + 2 * LINE_LEN..].iter().all(|b| *b == 0));
}

#[test]
fn check_detects_corruption() {
    let mut buf = fresh(2);
    {
        let mut s = LineStore::new(&mut buf[..]).unwrap();
        s.insert(&line(0, 1, 1, CLASS_GENERAL, 0, 1)).unwrap();
        s.insert(&line(0, 2, 1, CLASS_GENERAL, 0, 1)).unwrap();
    }
    buf[HEADER_LEN + LINE_LEN + 3] = 0; // second line's due_at 2 -> 0: out of order
    assert_eq!(
        LineStore::new(&buf[..]).unwrap().check(),
        Err(LineStoreError::Unsorted)
    );
}

// ---- model fuzz ----

/// The plain list the store must agree with.
#[derive(Default)]
struct Model {
    lines: Vec<Line>,
    cap: usize,
}

impl Model {
    fn find(&self, k: &LineKey) -> Result<usize, usize> {
        self.lines.binary_search_by(|l| l.key().cmp(k))
    }
    fn insert(&mut self, l: &Line) -> Result<usize, LineStoreError> {
        match self.find(&l.key()) {
            Ok(_) => Err(LineStoreError::Duplicate),
            Err(_) if self.lines.len() == self.cap => Err(LineStoreError::Full),
            Err(at) => {
                self.lines.insert(at, *l);
                Ok(at)
            }
        }
    }
    fn totals(&self) -> (u64, u64, u64) {
        let mut t = (0u64, 0u64, 0u64);
        for l in &self.lines {
            let b = if !l.is_playable() {
                &mut t.2
            } else if l.side == SIDE_OWN {
                &mut t.0
            } else {
                &mut t.1
            };
            *b += l.amount;
        }
        t
    }
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
        self.next() % n
    }
}

/// A key from a small pool so inserts collide, merges hit and the order is exercised.
fn pool_line(r: &mut Rng) -> Line {
    let class = [
        CLASS_PLATFORM,
        CLASS_STUDIO,
        CLASS_GENERAL,
        CLASS_GENERAL,
        CLASS_EXTENSION_BASE,
        CLASS_EXTENSION_BASE + 1,
    ][r.below(6) as usize];
    let tranche = class.saturating_sub(CLASS_GENERAL);
    Line {
        side: r.below(2) as u8,
        class,
        tranche,
        due_at: r.below(5) as i64 - 2,
        source: [r.below(4) as u8; 32],
        amount: r.below(1000),
        uncovered: r.next() as u128 >> 4,
        p: 1 << 64,
        scale: r.below(2) as u32,
        epoch: 0,
        ck: 0,
        shares: r.next() as u128 >> 4,
        s_snap: U256([0; 4]),
        reserved: [0; 1],
    }
}

fn run_ops(seed: u64, ops: u64) {
    let mut r = Rng(seed);
    let mut buf = fresh(0);
    let mut m = Model::default();
    for step in 0..ops {
        if step % 5_000 == 0 {
            buf = fresh(r.below(6) as usize);
            m = Model {
                lines: vec![],
                cap: (buf.len() - HEADER_LEN) / LINE_LEN,
            };
        }
        let mut s = LineStore::new(&mut buf[..]).unwrap();
        let pick = r.below(100);
        match pick {
            0..=34 => {
                let l = pool_line(&mut r);
                assert_eq!(s.insert(&l), m.insert(&l), "insert");
            }
            35..=46 => {
                if !m.lines.is_empty() && r.below(4) != 0 {
                    let i = r.below(m.lines.len() as u64) as usize;
                    assert_eq!(s.remove_at(i), Ok(m.lines.remove(i)), "remove_at");
                } else {
                    let k = pool_line(&mut r).key();
                    let want = match m.find(&k) {
                        Ok(i) => Ok(m.lines.remove(i)),
                        Err(_) => Err(LineStoreError::NotFound),
                    };
                    assert_eq!(s.remove(&k), want, "remove");
                }
            }
            47..=66 => {
                // merge: existing key (same or stale snapshot) or new key
                let mut inc = if !m.lines.is_empty() && r.below(3) != 0 {
                    let mut l = m.lines[r.below(m.lines.len() as u64) as usize];
                    l.amount = r.below(1000);
                    l.uncovered = r.next() as u128 >> 4;
                    l.shares = r.next() as u128 >> 4;
                    l.reserved = [0; 1];
                    l
                } else {
                    pool_line(&mut r)
                };
                if r.below(5) == 0 {
                    inc.epoch += 1;
                }
                let want = match m.find(&inc.key()) {
                    Ok(i) => {
                        if !m.lines[i].same_index(&inc) {
                            Err(LineStoreError::NotMaterialised)
                        } else {
                            let o = &mut m.lines[i];
                            o.amount += inc.amount;
                            o.uncovered += inc.uncovered;
                            o.shares += inc.shares;
                            Ok(i)
                        }
                    }
                    Err(_) => m.insert(&inc),
                };
                assert_eq!(s.merge(&inc), want, "merge");
            }
            67..=76 => {
                if !m.lines.is_empty() {
                    let i = r.below(m.lines.len() as u64) as usize;
                    let mut l = m.lines[i];
                    l.amount = r.below(1000);
                    l.uncovered = r.next() as u128 >> 4;
                    l.reserved = [r.below(3) as u8; 1];
                    if r.below(4) == 0 {
                        l.due_at += 100;
                        assert_eq!(s.set_line(i, &l), Err(LineStoreError::KeyChanged));
                    } else {
                        assert_eq!(s.set_line(i, &l), Ok(()));
                        m.lines[i] = l;
                    }
                }
            }
            77..=88 => {
                let k = pool_line(&mut r).key();
                assert_eq!(s.find(&k), m.find(&k), "find");
                let side = r.below(3) as u8;
                assert_eq!(
                    s.first_of_side(side),
                    m.lines.iter().take_while(|l| l.side < side).count(),
                    "first_of_side"
                );
            }
            89..=94 => {
                let n = r.below(4) as usize;
                let new_len = buf.len() + n * LINE_LEN;
                buf.resize(new_len, 0);
                m.cap += n;
                continue_check(&buf, &m);
                continue;
            }
            _ => {
                let used = m.lines.len();
                let keep = used + r.below((m.cap - used) as u64 + 1) as usize;
                assert!(s.shrinkable_len() <= required_len(keep));
                buf.truncate(required_len(keep));
                m.cap = keep;
                continue_check(&buf, &m);
                continue;
            }
        }
        continue_check(&buf, &m);
    }
}

fn continue_check(buf: &[u8], m: &Model) {
    let s = LineStore::new(buf).unwrap();
    assert_eq!(s.len(), m.lines.len());
    assert_eq!(s.capacity(), m.cap);
    assert!(s.lines().eq(m.lines.iter().copied()), "contents diverged");
    let (o, w, f) = m.totals();
    assert_eq!((s.own_total(), s.won_total(), s.fee_total()), (o, w, f));
    s.check().unwrap();
}

fn fuzz_cases() -> u64 {
    std::env::var("LINESTORE_FUZZ_CASES")
        .ok()
        .and_then(|v| v.replace('_', "").parse().ok())
        .unwrap_or(50_000)
}

/// Seeded deterministic fuzz against the plain list. Default 50k operations;
/// `LINESTORE_FUZZ_CASES=1000000 cargo test --release -p tesoro_core line_store` runs the 1M case.
#[test]
fn fuzz_against_list_model() {
    let total = fuzz_cases();
    let chunks = 4u64;
    for c in 0..chunks {
        run_ops(0xC0FFEE + c, total / chunks);
    }
}

mod prop {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]
        #[test]
        fn shrinkable_fuzz(seed in any::<u64>()) {
            run_ops(seed, 600);
        }
    }
}

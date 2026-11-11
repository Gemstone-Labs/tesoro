//! Railcar engine tests plus the shared TS/Rust parity vectors.
//!
//! `tests/vectors.json` is regenerated with `WRITE_VECTORS=1 cargo test -p
//! railcar --test engine`; without the variable the test fails if the
//! committed file differs from what the engine now produces.

use proptest::prelude::*;
use railcar::engine::*;

fn splitmix(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn random_draw(rng: &mut u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    for c in out.chunks_mut(8) {
        c.copy_from_slice(&splitmix(rng).to_le_bytes());
    }
    out
}

fn draw_with_first_word(w: u64) -> [u8; 32] {
    let mut rng = w ^ 0x1234;
    let mut d = random_draw(&mut rng);
    d[..8].copy_from_slice(&w.to_le_bytes());
    d
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---- crash point ----

#[test]
fn smallest_and_largest_words_hit_the_floor_and_the_cap() {
    // w = u64::MAX: U = 1, no exponential part.
    assert_eq!(ride(&draw_with_first_word(u64::MAX)).crash_ms, 10_000);
    // w = 0: U = 2^-64, exponential part far above the cap.
    assert_eq!(ride(&draw_with_first_word(0)).crash_ms, 120_000);
}

#[test]
fn half_word_gives_the_30s_median_of_the_exponential_part() {
    // U = 0.5 exactly (w + 1 = 2^63): exponential part is the 30 s median.
    let r = ride(&draw_with_first_word((1u64 << 63) - 1));
    assert_eq!(r.crash_ms, 40_000);
}

#[test]
fn crash_point_odds_match_the_published_ones() {
    let mut rng = 7u64;
    let n = 200_000usize;
    let mut crashes: Vec<u32> = (0..n)
        .map(|_| ride(&random_draw(&mut rng)).crash_ms)
        .collect();
    assert!(crashes.iter().all(|c| (10_000..=120_000).contains(c)));
    crashes.sort_unstable();
    let median = crashes[n / 2] as f64 / 1000.0;
    assert!((median - 40.0).abs() < 0.6, "median {median}");
    let capped = crashes.iter().filter(|c| **c == 120_000).count() as f64 / n as f64;
    assert!((capped - 0.0787).abs() < 0.004, "capped {capped}");
    // Even chance per second: P(crash in second k | survived to k) is constant.
    let expect = 1.0 - 2f64.powf(-1.0 / 30.0);
    for k in [0u32, 10, 20, 40, 60, 80] {
        let lo = 10_000 + k * 1000;
        let alive = crashes.iter().filter(|c| **c >= lo).count() as f64;
        let hit = crashes
            .iter()
            .filter(|c| **c >= lo && **c < lo + 1000)
            .count() as f64;
        let h = hit / alive;
        assert!(
            (h - expect).abs() < 0.006,
            "hazard at +{k}s was {h}, want {expect}"
        );
    }
}

// ---- tells ----

#[test]
fn tells_that_show_keep_their_published_ranges_and_their_order() {
    let mut rng = 99u64;
    for _ in 0..50_000 {
        let r = ride(&random_draw(&mut rng));
        assert!((20_000..=40_000).contains(&r.screw_lead_ms));
        assert_eq!(r.bolt_lead_ms.is_some(), r.bolt_at_ms.is_some());
        assert_eq!(r.spark_lead_ms.is_some(), r.spark_at_ms.is_some());
        let mut last = r.screw_at_ms;
        if let (Some(lead), Some(at)) = (r.bolt_lead_ms, r.bolt_at_ms) {
            assert!((8_000..=15_000).contains(&lead));
            assert_eq!(at, r.crash_ms.saturating_sub(lead));
            assert!(last <= at);
            last = at;
        }
        if let (Some(lead), Some(at)) = (r.spark_lead_ms, r.spark_at_ms) {
            assert!((3_000..=8_000).contains(&lead));
            // The sparks, when they show, are never under 3 s before the crash.
            assert!(r.crash_ms - at >= 3_000);
            assert!(last <= at && at <= r.crash_ms);
        }
    }
}

#[test]
fn the_bolt_shows_on_3_rides_in_4_and_the_sparks_on_2_in_3_each_on_its_own() {
    let mut rng = 2026u64;
    let n = 200_000usize;
    let rides: Vec<Ride> = (0..n).map(|_| ride(&random_draw(&mut rng))).collect();
    let share = |of: &[&Ride], f: &dyn Fn(&Ride) -> bool| {
        of.iter().filter(|r| f(r)).count() as f64 / of.len() as f64
    };
    let bolt = |r: &Ride| r.bolt_at_ms.is_some();
    let sparks = |r: &Ride| r.spark_at_ms.is_some();
    let all: Vec<&Ride> = rides.iter().collect();
    assert!((share(&all, &bolt) - 0.75).abs() < 0.01);
    assert!((share(&all, &sparks) - 2.0 / 3.0).abs() < 0.01);
    // Neither says anything about the other...
    let with_bolt: Vec<&Ride> = all.iter().copied().filter(|r| bolt(r)).collect();
    let without_bolt: Vec<&Ride> = all.iter().copied().filter(|r| !bolt(r)).collect();
    assert!((share(&with_bolt, &sparks) - 2.0 / 3.0).abs() < 0.01);
    assert!((share(&without_bolt, &sparks) - 2.0 / 3.0).abs() < 0.01);
    // ...or about the crash point: short, middling and long rides show them alike.
    for (lo, hi) in [(10_000, 20_000), (20_000, 40_000), (40_000, 80_000), (80_000, 120_001)] {
        let band: Vec<&Ride> = all
            .iter()
            .copied()
            .filter(|r| (lo..hi).contains(&r.crash_ms))
            .collect();
        assert!(band.len() > 10_000, "band {lo}..{hi} too small");
        assert!((share(&band, &bolt) - 0.75).abs() < 0.015, "bolt in {lo}..{hi}");
        assert!((share(&band, &sparks) - 2.0 / 3.0).abs() < 0.015, "sparks in {lo}..{hi}");
    }
    // 1 ride in 12 warns with the screws only.
    let screws_only = share(&all, &|r| !bolt(r) && !sparks(r));
    assert!((screws_only - 1.0 / 12.0).abs() < 0.005, "{screws_only}");
}

/// The crash point, the leads of the Tells that show and the false screws of a draw are what
/// they were when every ride showed every Tell (rides recorded before then still replay).
#[test]
fn absent_tells_changed_nothing_else_about_a_draw() {
    // The first rides of the vectors file as committed before Tells could be absent.
    let zero = ride(&[0u8; 32]);
    assert_eq!((zero.crash_ms, zero.screw_lead_ms), (120_000, 20_000));
    assert_eq!(zero.false_screws(), [14_473, 14_911, 17_651]);
    assert_eq!(zero.bolt_lead_ms.unwrap_or(8_000), 8_000);
    assert_eq!(zero.spark_lead_ms.unwrap_or(3_000), 3_000);
    let ones = ride(&[0xff; 32]);
    assert_eq!((ones.crash_ms, ones.screw_lead_ms), (10_000, 20_594));
    assert_eq!(ones.bolt_lead_ms.unwrap_or(10_393), 10_393);
    assert_eq!(ones.spark_lead_ms.unwrap_or(6_210), 6_210);
}

// ---- track position under Brakes ----

#[test]
fn no_brake_means_position_equals_time() {
    assert_eq!(position_ms(&[], 0), 0);
    assert_eq!(position_ms(&[], 33_333), 33_333);
    assert_eq!(impact_ms(&[], 47_000), 47_000);
}

#[test]
fn one_brake_halves_speed_for_five_seconds() {
    let b = [10_000];
    assert_eq!(position_ms(&b, 10_000), 10_000);
    assert_eq!(position_ms(&b, 12_000), 11_000);
    assert_eq!(position_ms(&b, 15_000), 12_500);
    assert_eq!(position_ms(&b, 20_000), 17_500);
    // Crash at track 40 s: 2.5 s lost to the brake.
    assert_eq!(impact_ms(&b, 40_000), 42_500);
}

#[test]
fn a_brake_during_another_adds_five_seconds() {
    let b = [10_000, 12_000];
    // Slow from 10 s to 20 s: 5 s of track in 10 s.
    assert_eq!(position_ms(&b, 20_000), 15_000);
    assert_eq!(position_ms(&b, 21_000), 16_000);
    // A brake pressed after the slow period ended starts a new one.
    let c = [10_000, 16_000];
    // slow [10,15) = 2.5 s, fast [15,16) = 1 s, slow [16,21) = 2.5 s
    assert_eq!(position_ms(&c, 21_000), 16_000);
}

#[test]
fn position_is_never_lowered_by_brakes_and_impact_is_the_first_time_at_the_crash() {
    let mut rng = 21u64;
    for _ in 0..2_000 {
        let n = (splitmix(&mut rng) % 6) as usize;
        let mut brakes: Vec<u32> = (0..n)
            .map(|_| (splitmix(&mut rng) % 120_000) as u32)
            .collect();
        brakes.sort_unstable();
        let crash = 10_000 + (splitmix(&mut rng) % 110_001) as u32;
        let t = impact_ms(&brakes, crash);
        assert!(position_ms(&brakes, t) >= crash);
        assert!(t == 0 || position_ms(&brakes, t - 1) < crash);
        let mut prev = 0;
        for s in 0..60 {
            let p = position_ms(&brakes, s * 1000);
            assert!(p >= prev);
            prev = p;
        }
    }
}

#[test]
fn ride_never_lasts_more_than_ten_minutes() {
    let brakes: Vec<u32> = (0..100).map(|i| i * 1000).collect();
    assert!(impact_ms(&brakes, 120_000) <= RIDE_CAP_MS);
    assert_eq!(impact_ms(&[0; 0], 120_000), 120_000);
}

// ---- Early-jump refund ----

#[test]
fn refund_follows_the_schedule_at_every_edge() {
    let table = [
        (0, 80),
        (19_999, 80),
        (20_000, 70),
        (29_999, 70),
        (30_000, 60),
        (40_000, 50),
        (50_000, 40),
        (60_000, 30),
        (70_000, 20),
        (79_999, 20),
        (80_000, 10),
        (89_999, 10),
        (90_000, 5),
        (99_999, 5),
        (100_000, 0),
        (120_000, 0),
    ];
    for (pos, pct) in table {
        assert_eq!(refund_pct(pos), pct, "at {pos}");
        assert_eq!(refund(500, pos), 500 * pct as u64 / 100, "at {pos}");
    }
}

#[test]
fn refund_is_measured_in_track_position_so_brakes_never_lower_it() {
    // Same real time, a Brake lowers the position, so the refund can only rise.
    let t = 41_000;
    assert_eq!(refund_at(500, &[], t), 250);
    assert_eq!(refund_at(500, &[30_000], t), 300); // position 38.5 s
    assert_eq!(refund_at(500, &[30_000], 5_000), 400);
    // Real 21.999 s, but the Brake held position under the 20 s edge: still 80%.
    assert_eq!(refund_at(500, &[18_000], 21_999), 400);
}

// ---- payouts ----

#[test]
fn split_matches_the_worked_example() {
    // 2,150 - 129 fees - 1,500 entries back = 521.
    assert_eq!(split(521, 3), [313, 130, 78]);
    assert_eq!(split(521, 3).iter().sum::<u64>(), 521);
}

#[test]
fn two_off_split_70_30_and_one_off_takes_all() {
    assert_eq!(split(1000, 2), [700, 300, 0]);
    assert_eq!(split(1001, 2), [701, 300, 0]);
    assert_eq!(split(777, 1), [777, 0, 0]);
    assert_eq!(split(0, 3), [0, 0, 0]);
    assert_eq!(split(100, 0), [0, 0, 0]);
}

proptest! {
    #[test]
    fn split_conserves_and_rounds_to_the_top(amount in 0u64..10_000_000_000, n in 1usize..4) {
        let s = split(amount, n);
        prop_assert_eq!(s.iter().sum::<u64>(), amount);
        prop_assert!(s[0] >= s[1] && s[1] >= s[2] || n < 3 );
        let bps = place_shares_bps(n);
        for i in 1..n {
            prop_assert_eq!(s[i], amount * bps[i] as u64 / 10_000);
        }
    }

    #[test]
    fn engine_never_panics(w in any::<[u8; 32]>(), t in 0u32..2_000_000, mut b in proptest::collection::vec(0u32..600_000, 0..100)) {
        b.sort_unstable();
        let r = ride(&w);
        let i = impact_ms(&b, r.crash_ms);
        prop_assert!(i <= RIDE_CAP_MS);
        let _ = position_ms(&b, t);
    }
}

// ---- vectors ----

fn u32s(v: &[u32]) -> String {
    format!(
        "[{}]",
        v.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
    )
}

fn build_vectors() -> String {
    let mut rng = 0xC0FFEE_u64;
    let mut draws: Vec<[u8; 32]> = vec![
        [0; 32],
        [0xff; 32],
        draw_with_first_word(u64::MAX),
        draw_with_first_word((1u64 << 63) - 1),
        draw_with_first_word(1),
    ];
    while draws.len() < 60 {
        draws.push(random_draw(&mut rng));
    }
    // Every pattern of Tells, on a ride long enough for its leads and on a short one.
    for bolt in [true, false] {
        for sparks in [true, false] {
            for short in [false, true] {
                let d = loop {
                    let d = random_draw(&mut rng);
                    let r = ride(&d);
                    let length = if short {
                        r.crash_ms < 14_000
                    } else {
                        r.crash_ms >= 45_000
                    };
                    if r.bolt_at_ms.is_some() == bolt && r.spark_at_ms.is_some() == sparks && length
                    {
                        break d;
                    }
                };
                draws.push(d);
            }
        }
    }
    let rides: Vec<String> = draws
        .iter()
        .map(|d| {
            let r = ride(d);
            let opt = |v: Option<u32>| v.map_or("null".to_string(), |x| x.to_string());
            format!(
                "{{\"draw\":\"{}\",\"crash\":{},\"screwLead\":{},\"boltLead\":{},\"sparkLead\":{},\"screwAt\":{},\"boltAt\":{},\"sparkAt\":{},\"falseScrews\":{}}}",
                hex(d), r.crash_ms, r.screw_lead_ms, opt(r.bolt_lead_ms), opt(r.spark_lead_ms),
                r.screw_at_ms, opt(r.bolt_at_ms), opt(r.spark_at_ms), u32s(r.false_screws())
            )
        })
        .collect();

    let mut tracks = Vec::new();
    let mut schedules: Vec<Vec<u32>> = vec![
        vec![],
        vec![10_000],
        vec![10_000, 12_000],
        vec![10_000, 16_000],
        vec![0, 0, 0],
        (0..100).map(|i| i * 1000).collect(),
    ];
    for _ in 0..30 {
        let n = (splitmix(&mut rng) % 8) as usize;
        let mut b: Vec<u32> = (0..n)
            .map(|_| (splitmix(&mut rng) % 150_000) as u32)
            .collect();
        b.sort_unstable();
        schedules.push(b);
    }
    for b in &schedules {
        let times: Vec<u32> = (0..25)
            .map(|_| (splitmix(&mut rng) % 200_000) as u32)
            .collect();
        let positions: Vec<u32> = times.iter().map(|t| position_ms(b, *t)).collect();
        let crashes: Vec<u32> = vec![10_000, 40_000, 77_777, 120_000];
        let impacts: Vec<u32> = crashes.iter().map(|c| impact_ms(b, *c)).collect();
        tracks.push(format!(
            "{{\"brakes\":{},\"times\":{},\"positions\":{},\"crashes\":{},\"impacts\":{}}}",
            u32s(b),
            u32s(&times),
            u32s(&positions),
            u32s(&crashes),
            u32s(&impacts)
        ));
    }

    let mut refunds = Vec::new();
    for edge in (0..=12).map(|i| i * 10_000u32) {
        for pos in [edge.saturating_sub(1), edge, edge + 1] {
            for entry in [500u64, 1000, 777] {
                refunds.push(format!(
                    "{{\"position\":{pos},\"entry\":{entry},\"pct\":{},\"refund\":{}}}",
                    refund_pct(pos),
                    refund(entry, pos)
                ));
            }
        }
    }
    let splits: Vec<String> = [0u64, 1, 2, 3, 99, 100, 521, 1001, 12_345, 9_999_999_999]
        .iter()
        .flat_map(|a| {
            (0..=3usize).map(move |n| {
                let s = split(*a, n);
                format!(
                    "{{\"amount\":\"{a}\",\"places\":{n},\"shares\":[\"{}\",\"{}\",\"{}\"]}}",
                    s[0], s[1], s[2]
                )
            })
        })
        .collect();

    format!(
        "{{\"rides\":[{}],\"tracks\":[{}],\"refunds\":[{}],\"splits\":[{}]}}",
        rides.join(","),
        tracks.join(","),
        refunds.join(","),
        splits.join(",")
    )
}

#[test]
fn vectors_match_committed_file() {
    let json = build_vectors();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors.json");
    if std::env::var("WRITE_VECTORS").is_ok() {
        std::fs::write(path, &json).unwrap();
    } else {
        let on_disk =
            std::fs::read_to_string(path).expect("vectors.json missing; run with WRITE_VECTORS=1");
        assert_eq!(
            on_disk, json,
            "vectors.json is stale; rerun with WRITE_VECTORS=1"
        );
    }
}

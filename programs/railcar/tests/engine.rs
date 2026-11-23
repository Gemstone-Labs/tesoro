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

fn crash_of_word(w: u64) -> u32 {
    ride(&draw_with_first_word(w)).crash_ms
}

/// The largest first word whose crash point is still the cap (the crash point falls as the
/// word grows).
fn last_capped_word() -> u64 {
    let (mut lo, mut hi) = (0u64, u64::MAX);
    while lo < hi {
        let mid = lo + (hi - lo + 1) / 2;
        if crash_of_word(mid) == MAX_CRASH_MS {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---- crash point ----

#[test]
fn smallest_and_largest_words_hit_the_floor_and_the_cap() {
    // w = u64::MAX: U = 1, no random part: the safe 5 s and nothing more.
    assert_eq!(crash_of_word(u64::MAX), MIN_CRASH_MS);
    assert_eq!(MIN_CRASH_MS, 5_000);
    // U within a few 2^-64 of 1 still gives the floor.
    assert_eq!(crash_of_word(u64::MAX - 1), MIN_CRASH_MS);
    assert_eq!(crash_of_word(u64::MAX - 2), MIN_CRASH_MS);
    // w = 0: U = 2^-64, the random part (8 x 20 s) is far above the cap.
    assert_eq!(crash_of_word(0), MAX_CRASH_MS);
    assert_eq!(crash_of_word(1), MAX_CRASH_MS);
    assert_eq!(crash_of_word(2), MAX_CRASH_MS);
    assert_eq!(MAX_CRASH_MS, 120_000);
}

#[test]
fn the_cap_binds_on_about_one_draw_in_nine_billion() {
    let last = last_capped_word();
    assert_eq!(crash_of_word(last), MAX_CRASH_MS);
    assert!(crash_of_word(last + 1) < MAX_CRASH_MS);
    // -log2 U >= (115 / 20)^2 = 33.0625: U <= 2^-33.06, about one draw in 8.8 billion.
    let share = (last as f64 + 1.0) / 2f64.powi(64);
    assert!((share * 8.8e9 - 1.0).abs() < 0.05, "capped share {share}");
}

#[test]
fn half_word_gives_the_25s_median() {
    // U = 0.5 exactly (w + 1 = 2^63): -log2 U = 1, its root 1, so the safe 5 s plus the 20 s median.
    assert_eq!(crash_of_word((1u64 << 63) - 1), 25_000);
}

#[test]
fn the_crash_point_falls_as_the_word_grows() {
    let mut rng = 11u64;
    let mut words: Vec<u64> = (0..2_000).map(|_| splitmix(&mut rng)).collect();
    words.extend([0, 1, 2, (1 << 63) - 1, 1 << 63, u64::MAX - 1, u64::MAX]);
    words.sort_unstable();
    for pair in words.windows(2) {
        assert!(crash_of_word(pair[0]) >= crash_of_word(pair[1]));
    }
}

#[test]
fn crash_point_odds_match_the_published_ones() {
    let mut rng = 7u64;
    let n = 200_000usize;
    let mut crashes: Vec<u32> = (0..n)
        .map(|_| ride(&random_draw(&mut rng)).crash_ms)
        .collect();
    assert!(crashes
        .iter()
        .all(|c| (MIN_CRASH_MS..=MAX_CRASH_MS).contains(c)));
    crashes.sort_unstable();
    let share_by = |ms: u32| crashes.iter().filter(|c| **c < ms).count() as f64 / n as f64;
    // Half of all rides are over by 25 s, 9 in 10 by 41 s, about 1 in 190 passes 60 s.
    let median = crashes[n / 2] as f64 / 1000.0;
    assert!((median - 25.0).abs() < 0.3, "median {median}");
    assert!(
        (share_by(41_000) - 0.894).abs() < 0.005,
        "{}",
        share_by(41_000)
    );
    let past_60 = 1.0 - share_by(60_000);
    assert!(
        (past_60 - 1.0 / 190.0).abs() < 0.0015,
        "past 60 s {past_60}"
    );
    assert_eq!(share_by(MIN_CRASH_MS), 0.0, "no Bomb in the safe part");
    // The chance of the Bomb in the next whole second, for a car that got this far: 1.9, 6.9 and
    // 13.1 in 100 at 10, 25 and 45 s (Weibull shape 2: it rises in a straight line with time).
    let hazard = |sec: u32| {
        let lo = sec * 1000;
        let alive = crashes.iter().filter(|c| **c >= lo).count() as f64;
        let hit = crashes
            .iter()
            .filter(|c| **c >= lo && **c < lo + 1000)
            .count() as f64;
        hit / alive
    };
    for (sec, want) in [(10, 0.019), (25, 0.069), (45, 0.131)] {
        let h = hazard(sec);
        assert!(
            (h - want).abs() < 0.01,
            "chance at {sec} s was {h}, want {want}"
        );
    }
    let mut last = 0.0;
    for sec in [6, 10, 15, 20, 25, 30, 35, 40] {
        let h = hazard(sec);
        assert!(h > last, "the chance at {sec} s ({h}) fell below {last}");
        last = h;
    }
}

// ---- tells ----

#[test]
fn tells_that_show_keep_their_published_ranges_and_their_order() {
    let mut rng = 99u64;
    for _ in 0..50_000 {
        let r = ride(&random_draw(&mut rng));
        assert!((9_000..=18_000).contains(&r.screw_lead_ms));
        assert_eq!(r.bolt_lead_ms.is_some(), r.bolt_at_ms.is_some());
        assert_eq!(r.spark_lead_ms.is_some(), r.spark_at_ms.is_some());
        let mut last = r.screw_at_ms;
        if let (Some(lead), Some(at)) = (r.bolt_lead_ms, r.bolt_at_ms) {
            assert!((5_000..=9_000).contains(&lead));
            assert_eq!(at, r.crash_ms.saturating_sub(lead));
            assert!(last <= at);
            last = at;
        }
        if let (Some(lead), Some(at)) = (r.spark_lead_ms, r.spark_at_ms) {
            assert!((3_000..=5_000).contains(&lead));
            // The sparks, when they show, are never under 3 s before the Bomb.
            assert!(r.crash_ms - at >= 3_000);
            assert!(last <= at && at <= r.crash_ms);
        }
        for f in r.false_screws() {
            assert!((1_000..=9_000).contains(f));
            assert!(f + 1_000 <= r.screw_at_ms);
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
    for (lo, hi) in [
        (5_000, 15_000),
        (15_000, 25_000),
        (25_000, 40_000),
        (40_000, 120_001),
    ] {
        let band: Vec<&Ride> = all
            .iter()
            .copied()
            .filter(|r| (lo..hi).contains(&r.crash_ms))
            .collect();
        assert!(band.len() > 10_000, "band {lo}..{hi} too small");
        assert!(
            (share(&band, &bolt) - 0.75).abs() < 0.015,
            "bolt in {lo}..{hi}"
        );
        assert!(
            (share(&band, &sparks) - 2.0 / 3.0).abs() < 0.015,
            "sparks in {lo}..{hi}"
        );
    }
    // 1 ride in 12 warns with the screws only.
    let screws_only = share(&all, &|r| !bolt(r) && !sparks(r));
    assert!((screws_only - 1.0 / 12.0).abs() < 0.005, "{screws_only}");
}

#[test]
fn a_short_ride_starts_its_screws_at_departure() {
    let mut rng = 5u64;
    let mut seen = 0;
    for _ in 0..200_000 {
        let r = ride(&random_draw(&mut rng));
        if r.crash_ms < r.screw_lead_ms {
            seen += 1;
            assert_eq!(r.screw_at_ms, 0);
            assert!(r.false_screws().is_empty());
        }
    }
    assert!(
        seen > 1_000,
        "short rides are common enough to matter: {seen}"
    );
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
        let crash = MIN_CRASH_MS + (splitmix(&mut rng) % 115_001) as u32;
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

// ---- no Early-jump refund (decisions Q40) ----

#[test]
fn a_jump_before_the_last_three_pays_nothing_wherever_it_lands() {
    for pos in [
        0,
        1,
        4_999,
        5_000,
        19_999,
        20_000,
        60_000,
        100_000,
        120_000,
        u32::MAX,
    ] {
        assert_eq!(refund_pct(pos), 0, "at {pos}");
        assert_eq!(refund(100, pos), 0, "at {pos}");
        assert_eq!(refund(777, pos), 0, "at {pos}");
    }
    // Brakes change the position, never the refund.
    assert_eq!(refund_at(100, &[], 41_000), 0);
    assert_eq!(refund_at(100, &[30_000], 41_000), 0);
    assert_eq!(refund_at(100, &[0], 0), 0);
}

// ---- payouts ----

#[test]
fn split_matches_the_worked_example() {
    // 500 - 30 fees - 300 entries back = 170: Dee 103, Ben 42, Cy 25.
    assert_eq!(split(170, 3), [103, 42, 25]);
    assert_eq!(split(170, 3).iter().sum::<u64>(), 170);
}

#[test]
fn two_off_split_70_30_and_one_off_takes_all() {
    // Two off: 500 - 30 - 200 = 270.
    assert_eq!(split(270, 2), [189, 81, 0]);
    assert_eq!(split(1001, 2), [701, 300, 0]);
    // One off: 500 - 30 - 100 = 370.
    assert_eq!(split(370, 1), [370, 0, 0]);
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
        prop_assert!((MIN_CRASH_MS..=MAX_CRASH_MS).contains(&r.crash_ms));
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
    let cap_edge = last_capped_word();
    // The boundary draws of the smooth draw: the floor (U = 1 and just under), the cap (U = 2^-64
    // and just over), both sides of the cap's edge and the median.
    let mut draws: Vec<[u8; 32]> = vec![
        [0; 32],
        [0xff; 32],
        draw_with_first_word(u64::MAX),
        draw_with_first_word(u64::MAX - 1),
        draw_with_first_word(u64::MAX - 2),
        draw_with_first_word(0),
        draw_with_first_word(1),
        draw_with_first_word(2),
        draw_with_first_word(cap_edge),
        draw_with_first_word(cap_edge + 1),
        draw_with_first_word((1u64 << 63) - 1),
        draw_with_first_word(1u64 << 63),
    ];
    while draws.len() < 60 {
        draws.push(random_draw(&mut rng));
    }
    // Every pattern of Tells, on a ride long enough for its leads and on a short one (its own
    // random stream, so the vectors below stay what they were).
    let mut patterns = 0x7_E115_u64;
    for bolt in [true, false] {
        for sparks in [true, false] {
            for short in [false, true] {
                let d = loop {
                    let d = random_draw(&mut patterns);
                    let r = ride(&d);
                    let length = if short {
                        r.crash_ms < 8_000
                    } else {
                        r.crash_ms >= 25_000
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
        let crashes: Vec<u32> = vec![5_000, 25_000, 41_000, 77_777, 120_000];
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
    for pos in [
        0u32,
        4_999,
        5_000,
        19_999,
        20_000,
        60_000,
        100_000,
        120_000,
        u32::MAX,
    ] {
        for entry in [100u64, 500, 777] {
            refunds.push(format!(
                "{{\"position\":{pos},\"entry\":{entry},\"pct\":{},\"refund\":{}}}",
                refund_pct(pos),
                refund(entry, pos)
            ));
        }
    }
    let splits: Vec<String> = [
        0u64,
        1,
        2,
        3,
        99,
        100,
        170,
        270,
        370,
        521,
        1001,
        12_345,
        9_999_999_999,
    ]
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

use super::*;
use anchor_lang::prelude::Pubkey;
use proptest::prelude::*;

const RIDE_SLOT: u64 = 1_000;

/// Slot `secs` seconds into the ride.
fn at(secs: f64) -> u64 {
    RIDE_SLOT + (secs * SLOTS_PER_SEC as f64).round() as u64
}

fn vault(crash_ms: u32) -> Vault {
    let mut v = Vault::blank(0, Pubkey::default());
    v.ready = true;
    v.crash_ms = crash_ms;
    v.screw_at_ms = crash_ms - 30_000;
    v.bolt_at_ms = crash_ms - 10_000;
    v.spark_at_ms = crash_ms - 5_000;
    v.false_screws[..2].copy_from_slice(&[4_000, 9_000]);
    v.false_len = 2;
    v
}

/// A riding Table with `n` seats, core seat i at Table seat i.
fn riding(n: u8) -> Box<Table> {
    let mut t: Box<Table> = Box::new(bytemuck::Zeroable::zeroed());
    t.init(1, 0);
    t.set_entry(ENTRY_GEMAS);
    t.seated = n;
    t.aboard = n;
    for i in 0..n {
        t.seats[usize::from(i)].seat = i;
        t.seats[usize::from(i)].account = [i + 1; 32];
    }
    t.phase = PHASE_RIDING;
    t.set_ride_slot(RIDE_SLOT);
    t
}

const ANA: usize = 0;
const BEN: usize = 1;
const CY: usize = 2;
const DEE: usize = 3;

#[test]
fn the_worked_example_reports_three_places_and_anas_refund() {
    let v = vault(120_000);
    let mut t = riding(5);
    for (who, secs) in [(ANA, 25.0), (CY, 95.0), (BEN, 97.0), (DEE, 99.0)] {
        assert!(!advance(&mut t, &v, at(secs)));
        assert_eq!(jump(&mut t, who, at(secs)), Ok(false));
    }
    assert!(advance(&mut t, &v, at(120.0)), "the wall at 120 s");
    conclude(&mut t, &v, impact_ms(&v), 77);
    assert_eq!(
        result(&t),
        Some(ManySeatResult::Placed {
            places: vec![
                SeatPlace {
                    seat: 3,
                    share_bps: 6_000
                },
                SeatPlace {
                    seat: 1,
                    share_bps: 2_500
                },
                SeatPlace {
                    seat: 2,
                    share_bps: 1_500
                },
            ],
            refunds: vec![SeatRefund {
                seat: 0,
                gemas: 350
            }],
        })
    );
    assert_eq!(
        (t.phase, t.dirty, t.over_ms(), t.over_at()),
        (PHASE_OVER, 1, 120_000, 77)
    );
}

#[test]
fn two_and_one_jumpers_split_seventy_thirty_and_all() {
    let v = vault(60_000);
    let mut t = riding(5);
    jump(&mut t, CY, at(30.0)).unwrap();
    jump(&mut t, BEN, at(31.0)).unwrap();
    conclude(&mut t, &v, 60_000, 0);
    let Some(ManySeatResult::Placed { places, refunds }) = result(&t) else {
        panic!("placed");
    };
    assert_eq!(
        places
            .iter()
            .map(|p| (p.seat, p.share_bps))
            .collect::<Vec<_>>(),
        vec![(1, 7_000), (2, 3_000)]
    );
    assert!(refunds.is_empty());

    let mut t = riding(5);
    jump(&mut t, DEE, at(12.0)).unwrap();
    assert!(advance(&mut t, &v, at(60.0)));
    conclude(&mut t, &v, 60_000, 0);
    let Some(ManySeatResult::Placed { places, .. }) = result(&t) else {
        panic!("placed");
    };
    assert_eq!(
        places
            .iter()
            .map(|p| (p.seat, p.share_bps))
            .collect::<Vec<_>>(),
        vec![(3, 10_000)]
    );
}

#[test]
fn nobody_off_is_a_full_refund() {
    let v = vault(30_000);
    let mut t = riding(5);
    conclude(&mut t, &v, 30_000, 0);
    assert_eq!(result(&t), Some(ManySeatResult::Refund));
    assert_eq!(t.reason, REASON_NOBODY_JUMPED);
}

#[test]
fn the_wall_is_hit_from_the_impact_slot_and_not_a_slot_before() {
    let v = vault(40_000);
    let mut t = riding(5);
    assert!(!advance(&mut t, &v, at(40.0) - 1));
    assert!(advance(&mut t, &v, at(40.0)));
}

#[test]
fn signals_show_each_tell_stage_and_false_screw_only_once_passed() {
    let v = vault(60_000);
    let mut t = riding(5);
    let seen = |t: &Table| (t.tell, t.false_screws);
    advance(&mut t, &v, at(3.99));
    assert_eq!(seen(&t), (0, 0));
    advance(&mut t, &v, at(4.0));
    assert_eq!(seen(&t), (0, 1));
    advance(&mut t, &v, at(29.99));
    assert_eq!(seen(&t), (0, 2));
    advance(&mut t, &v, at(30.0));
    assert_eq!(seen(&t), (1, 2));
    advance(&mut t, &v, at(50.0));
    assert_eq!(seen(&t), (2, 2));
    advance(&mut t, &v, at(55.0));
    assert_eq!(seen(&t), (3, 2));
}

#[test]
fn a_player_jumps_once_and_the_order_has_no_ties() {
    let mut t = riding(5);
    jump(&mut t, BEN, at(10.0)).unwrap();
    jump(&mut t, ANA, at(10.0)).unwrap();
    assert_eq!(jump(&mut t, BEN, at(11.0)), Err(RideError::AlreadyJumped));
    assert_eq!(jump(&mut t, 5, at(11.0)), Err(RideError::NotAPlayer));
    assert_eq!((t.seats[BEN].order, t.seats[ANA].order), (1, 2));
}

#[test]
fn early_refunds_follow_the_schedule_at_the_jump() {
    let v = vault(120_000);
    let mut t = riding(6);
    // 19.99 s: 80%, 20 s: 70%, 95 s: 5%, then three placed
    for (who, secs) in [
        (0, 19.99),
        (1, 20.0),
        (2, 95.0),
        (3, 100.5),
        (4, 101.0),
        (5, 102.0),
    ] {
        jump(&mut t, who, at(secs)).unwrap();
    }
    conclude(&mut t, &v, 102_000, 0);
    let refunds: Vec<u64> = t.seats[..6].iter().map(|s| s.refund()).collect();
    assert_eq!(refunds, vec![400, 350, 25, 0, 0, 0]);
}

// =========================================================================================
// Brakes
// =========================================================================================

/// A Brake seat bound to the ride.
fn brake_seat(i: u8) -> BrakeSeat {
    BrakeSeat {
        version: BrakeSeat::VERSION,
        bump: 0,
        table: Pubkey::default(),
        seat: i,
        bound: 1,
        car_no: 0,
        used: 0,
        press_ms: 0,
        reserved: [0; 16],
    }
}

/// A riding Table whose seats are all bound, and their Brake seats.
fn braking(n: u8) -> (Box<Table>, Vec<BrakeSeat>) {
    let mut t = riding(n);
    t.brakes_bound = n;
    (t, (0..n).map(brake_seat).collect())
}

fn press(t: &Table, v: &mut Vault, seats: &mut [BrakeSeat], i: usize, secs: f64) {
    let ms = t.ride_ms(at(secs));
    tick(t, v, &mut seats[i], i as u8, ms, true);
}

#[test]
fn the_spec_brake_example_moves_the_wall_from_52_to_54_5_s() {
    let mut v = vault(52_000);
    let (mut t, mut seats) = braking(5);
    assert_eq!(impact_ms(&v), 52_000);
    press(&t, &mut v, &mut seats, ANA, 48.0);
    assert_eq!(impact_ms(&v), 54_500);
    assert_eq!((seats[ANA].used, seats[ANA].press_ms), (1, 48_000));
    assert!(!advance(&mut t, &v, at(50.0)));
    jump(&mut t, BEN, at(50.0)).unwrap();
    assert!(!advance(&mut t, &v, at(52.0)), "the wall has moved");
    assert!(!advance(&mut t, &v, at(53.0)));
    jump(&mut t, ANA, at(53.0)).unwrap();
    assert!(!advance(&mut t, &v, at(54.49)));
    assert!(advance(&mut t, &v, at(54.5)));
    conclude(&mut t, &v, impact_ms(&v), 9);
    assert_eq!(t.over_ms(), 54_500);
    assert_eq!((t.seats[BEN].order, t.seats[ANA].order), (1, 2));
    assert_eq!(t.revealed, 1);
    assert_eq!(t.seats[ANA].brake_ms(), Some(48_000));
    assert_eq!(t.seats[BEN].brake_ms(), None);
}

#[test]
fn a_brake_during_another_extends_it_by_five_seconds() {
    let mut v = vault(52_000);
    let (t, mut seats) = braking(5);
    press(&t, &mut v, &mut seats, ANA, 40.0);
    press(&t, &mut v, &mut seats, CY, 42.0);
    // slow 40-50 s: at 50 s the car is at 45, the wall 7 s further
    assert_eq!((v.slow_end_ms, v.slow_total_ms), (50_000, 10_000));
    assert_eq!(impact_ms(&v), 57_000);
    assert_eq!(impact_ms(&v), engine::impact_ms(v.pressed(), 52_000));
}

#[test]
fn a_second_brake_by_the_same_player_does_nothing() {
    let mut v = vault(52_000);
    let (t, mut seats) = braking(5);
    press(&t, &mut v, &mut seats, ANA, 40.0);
    let once = (v.slow_end_ms, v.slow_total_ms, v.press_count, seats[ANA].press_ms);
    press(&t, &mut v, &mut seats, ANA, 42.0);
    assert_eq!(
        (v.slow_end_ms, v.slow_total_ms, v.press_count, seats[ANA].press_ms),
        once
    );
    assert_eq!(impact_ms(&v), 54_500);
}

#[test]
fn a_brake_off_the_car_or_before_every_seat_is_bound_does_nothing() {
    let mut v = vault(52_000);
    let (mut t, mut seats) = braking(5);
    jump(&mut t, ANA, at(30.0)).unwrap();
    press(&t, &mut v, &mut seats, ANA, 40.0);
    assert_eq!((v.press_count, seats[ANA].used), (0, 0));
    t.brakes_bound = 4;
    press(&t, &mut v, &mut seats, BEN, 40.0);
    assert_eq!((v.press_count, seats[BEN].used), (0, 0));
    // a tick without the Brake leaves everything as it was
    t.brakes_bound = 5;
    let ms = t.ride_ms(at(41.0));
    tick(&t, &mut v, &mut seats[CY], CY as u8, ms, false);
    assert_eq!((v.press_count, seats[CY].used, impact_ms(&v)), (0, 0, 52_000));
}

#[test]
fn refunds_after_a_brake_follow_track_position() {
    let mut v = vault(120_000);
    let (mut t, mut seats) = braking(6);
    press(&t, &mut v, &mut seats, ANA, 15.0);
    // Ben Jumps at 21 s real, 18.5 s of track: 80%, not the 70% real time would give
    jump(&mut t, BEN, at(21.0)).unwrap();
    for (who, secs) in [(2, 60.0), (3, 61.0), (4, 62.0)] {
        jump(&mut t, who, at(secs)).unwrap();
    }
    conclude(&mut t, &v, impact_ms(&v), 0);
    assert_eq!(t.seats[BEN].refund(), 400);
}

#[test]
fn the_ride_ends_by_ten_minutes_whatever_the_vault_says() {
    let mut v = vault(120_000);
    v.crash_ms = 700_000;
    let mut t = riding(5);
    assert_eq!(impact_ms(&v), 600_000);
    assert!(!advance(&mut t, &v, at(599.99)));
    assert!(advance(&mut t, &v, at(600.0)));
}

#[test]
fn a_press_at_the_first_ms_does_not_wrap_the_position() {
    let mut v = vault(20_000);
    let (mut t, mut seats) = braking(5);
    press(&t, &mut v, &mut seats, ANA, 0.0);
    assert!(!advance(&mut t, &v, at(0.01)));
    assert_eq!(half_position(&v, 10), 10);
    assert_eq!(impact_ms(&v), 22_500);
}

#[test]
fn the_reveal_lets_the_engine_recompute_the_ride() {
    let draw = [7u8; 32];
    let mut v = Vault::blank(0, Pubkey::default());
    v.store(draw);
    let crash = v.crash_ms;
    let (mut t, mut seats) = braking(5);
    press(&t, &mut v, &mut seats, CY, 1.0);
    press(&t, &mut v, &mut seats, ANA, 3.0);
    jump(&mut t, BEN, at(4.0)).unwrap();
    conclude(&mut t, &v, impact_ms(&v), 0);
    let r = engine::ride(&t.reveal_draw);
    assert_eq!(r.crash_ms, crash);
    let mut brakes: Vec<u32> = t.seats[..5].iter().filter_map(|s| s.brake_ms()).collect();
    brakes.sort_unstable();
    assert_eq!(brakes, vec![1_000, 3_000]);
    assert_eq!(engine::impact_ms(&brakes, r.crash_ms), t.over_ms());
}

#[test]
fn a_void_before_the_draw_reveals_nothing() {
    let v = Vault::blank(0, Pubkey::default());
    let mut t = riding(5);
    void(&mut t, Some(&v), REASON_NO_DRAW, 0);
    assert_eq!((t.revealed, t.reveal_draw), (0, [0; 32]));
}

/// Valid press times: each before the Impact of the presses before it, ascending.
fn valid_presses(crash: u32, gaps: &[u32]) -> Vec<u32> {
    let mut out = Vec::new();
    let mut at = 0u32;
    for g in gaps {
        at += g;
        if at >= engine::impact_ms(&out, crash) {
            break;
        }
        out.push(at);
    }
    out
}

proptest! {
    #[test]
    fn the_closed_form_matches_the_engine(
        crash in 10_000u32..=120_000,
        gaps in proptest::collection::vec(0u32..12_000, 0..100),
        after in 0u32..300_000,
    ) {
        let presses = valid_presses(crash, &gaps);
        let mut v = vault(crash);
        let (t, mut seats) = braking(100);
        for (k, p) in presses.iter().enumerate() {
            tick(&t, &mut v, &mut seats[k], k as u8, *p, true);
        }
        prop_assert_eq!(v.pressed(), &presses[..]);
        prop_assert_eq!(impact_ms(&v), engine::impact_ms(&presses, crash));
        let last = presses.last().copied().unwrap_or(0);
        let q = last + after;
        prop_assert_eq!(
            (half_position(&v, q) / 2) as u32,
            engine::position_ms(&presses, q)
        );
    }

    #[test]
    fn one_walk_gives_the_engine_positions(
        gaps in proptest::collection::vec(0u32..12_000, 0..100),
        mut times in proptest::collection::vec(0u32..700_000, 0..100),
    ) {
        let presses = valid_presses(120_000, &gaps);
        times.sort_unstable();
        let mut walk = Slowed::new(&presses);
        for q in times {
            prop_assert_eq!(walk.position_ms(q), engine::position_ms(&presses, q));
        }
    }
}

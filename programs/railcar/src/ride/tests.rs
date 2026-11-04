use super::*;
use anchor_lang::prelude::Pubkey;

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
    conclude(&mut t, impact_ms(&v), 77);
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
    conclude(&mut t, 60_000, 0);
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
    conclude(&mut t, 60_000, 0);
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
    let mut t = riding(5);
    conclude(&mut t, 30_000, 0);
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
    conclude(&mut t, 102_000, 0);
    let refunds: Vec<u64> = t.seats[..6].iter().map(|s| s.refund()).collect();
    assert_eq!(refunds, vec![400, 350, 25, 0, 0, 0]);
}

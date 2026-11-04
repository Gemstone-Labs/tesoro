use super::*;
use crate::ledger::lifecycle::{MatchId, MatchMeta, Terms};

const T: i64 = 1_000_000;
const GAME: Key = [9; 32];
const AUTH: Key = [8; 32];
const SLOT: u64 = 100;
const SIZES: [u64; 3] = [100, 500, 1_000];

fn terms() -> Terms {
    Terms {
        platform_bps: 200,
        studio_bps: 300,
        studio_owner: None,
        studio_priority: true,
    }
}

fn open(min: u8, max: u8) -> Result<ManySeatRecord, SeatError> {
    ManySeatRecord::open(
        MatchId {
            opener: [1; 32],
            n: 0,
        },
        MatchMeta {
            challenge: false,
            asset: 0,
            listed: true,
        },
        (GAME, AUTH, SLOT),
        terms(),
        500,
        &SIZES,
        (min, max),
        T,
    )
}

fn car(min: u8, max: u8) -> ManySeatRecord {
    open(min, max).expect("open")
}

#[test]
fn a_car_opens_empty_and_boarding_with_its_bounds() {
    let c = car(5, 100);
    assert_eq!(c.stage(), ManyStage::Boarding);
    assert_eq!(
        (c.min_seats, c.max_seats, c.seated, c.min_since()),
        (5, 100, 0, 0)
    );
    assert_eq!(c.deadline_abs(), T + 7 * 24 * 3600);
    assert_eq!((c.entry(), c.deploy_slot(), c.opened_at()), (500, SLOT, T));
    assert_eq!(c.terms(), terms());
    assert_eq!(c.id().n, 0);
    assert_eq!(c.boarding_ends(), T + 7 * 24 * 3600 - 3600);
}

#[test]
fn seat_bounds_must_be_two_to_a_hundred_with_min_at_most_max() {
    assert_eq!(open(1, 10).unwrap_err(), SeatError::BadSeatBounds);
    assert_eq!(open(6, 5).unwrap_err(), SeatError::BadSeatBounds);
    assert_eq!(open(5, 101).unwrap_err(), SeatError::BadSeatBounds);
    assert!(open(2, 2).is_ok());
    assert!(open(100, 100).is_ok());
}

#[test]
fn an_entry_off_the_ladder_is_refused() {
    let bad = ManySeatRecord::open(
        MatchId {
            opener: [1; 32],
            n: 0,
        },
        MatchMeta::default(),
        (GAME, AUTH, SLOT),
        terms(),
        700,
        &SIZES,
        (5, 100),
        T,
    );
    assert_eq!(bad.unwrap_err(), SeatError::BadEntry);
}

#[test]
fn the_hundredth_seat_fills_the_car_and_the_hundred_and_first_is_refused() {
    let mut c = car(5, 100);
    for _ in 0..100 {
        c.take_seat(T + 1).expect("seat");
    }
    assert_eq!(c.seated, 100);
    assert_eq!(c.take_seat(T + 2), Err(SeatError::Full));
    assert_eq!(c.seated, 100);
}

#[test]
fn the_countdown_starts_at_the_minth_seat_and_stops_below_it() {
    let mut c = car(5, 100);
    for i in 0..4 {
        c.take_seat(T + i).unwrap();
        assert_eq!(c.min_since(), 0);
    }
    c.take_seat(T + 10).unwrap();
    assert_eq!(c.min_since(), T + 10);
    // a sixth seat leaves the countdown where it is
    c.take_seat(T + 12).unwrap();
    assert_eq!(c.min_since(), T + 10);
    c.leave_seat().unwrap();
    assert_eq!(c.min_since(), T + 10);
    c.leave_seat().unwrap();
    assert_eq!((c.seated, c.min_since()), (4, 0));
    c.take_seat(T + 20).unwrap();
    assert_eq!(c.min_since(), T + 20);
}

#[test]
fn the_first_time_the_car_reached_its_minimum_is_kept_through_step_offs() {
    let mut c = car(5, 100);
    for i in 0..4 {
        c.take_seat(T + i).unwrap();
    }
    assert_eq!(c.first_min_at(), 0);
    c.take_seat(T + 10).unwrap();
    assert_eq!(c.first_min_at(), T + 10);
    // below the minimum and back: the countdown restarts, the first time does not
    c.leave_seat().unwrap();
    c.take_seat(T + 25).unwrap();
    assert_eq!((c.min_since(), c.first_min_at()), (T + 25, T + 10));
}

#[test]
fn no_seat_is_taken_once_boarding_has_ended() {
    let mut c = car(5, 100);
    let end = c.boarding_ends();
    c.take_seat(end - 1).unwrap();
    assert_eq!(c.take_seat(end), Err(SeatError::BoardingOver));
}

#[test]
fn only_the_game_departs_and_only_with_the_minimum_seated() {
    let mut c = car(5, 100);
    for i in 0..4 {
        c.take_seat(T + i).unwrap();
    }
    assert_eq!(c.depart(T + 5, &AUTH, SLOT), Err(SeatError::BelowMinimum));
    c.take_seat(T + 6).unwrap();
    assert_eq!(c.depart(T + 7, &[7; 32], SLOT), Err(SeatError::NotGame));
    assert_eq!(
        c.depart(T + 7, &AUTH, SLOT + 1),
        Err(SeatError::GameUpgraded)
    );
    let end = c.boarding_ends();
    assert_eq!(c.depart(end, &AUTH, SLOT), Err(SeatError::BoardingOver));
    c.depart(T + 7, &AUTH, SLOT).expect("depart");
    assert_eq!((c.stage(), c.departed_at()), (ManyStage::Departed, T + 7));
    assert_eq!(c.depart(T + 8, &AUTH, SLOT), Err(SeatError::NotBoarding));
}

#[test]
fn after_departure_nobody_boards_or_steps_off() {
    let mut c = car(2, 3);
    c.take_seat(T).unwrap();
    c.take_seat(T).unwrap();
    c.depart(T + 1, &AUTH, SLOT).unwrap();
    assert_eq!(c.take_seat(T + 2), Err(SeatError::NotBoarding));
    assert_eq!(c.leave_seat(), Err(SeatError::NotBoarding));
    assert_eq!(c.seated, 2);
}

#[test]
fn only_an_empty_boarding_car_closes_early() {
    let mut c = car(2, 3);
    c.take_seat(T).unwrap();
    assert_eq!(c.close_empty(), Err(SeatError::NotEmpty));
    c.leave_seat().unwrap();
    c.close_empty().expect("close");
    assert_eq!(c.stage(), ManyStage::Closed);
    assert_eq!(c.take_seat(T), Err(SeatError::NotBoarding));
}

#[test]
fn seats_are_indexed_by_page_and_slot_below_the_car_maximum() {
    assert_eq!(seat_index(0, 0), 0);
    assert_eq!(seat_index(3, 7), 37);
    let c = car(5, 25);
    assert_eq!(c.page_slots(0), 10);
    assert_eq!(c.page_slots(2), 5);
    assert_eq!(c.page_slots(3), 0);
}

#[test]
fn a_seat_round_trips_its_fields() {
    let mut s = Seat::zeroed();
    assert_eq!(s.state(), SeatState::Empty);
    s.fill(&SeatFill {
        player: [1; 32],
        funder: [2; 32],
        share_bps: 4_000,
        pot: [3; 32],
        pot_lines: 17,
        hold: 15,
        counted: Some((500, T)),
    });
    assert_eq!(s.state(), SeatState::Seated);
    assert_eq!(
        (s.player(), s.funder(), s.pot()),
        ([1; 32], [2; 32], [3; 32])
    );
    assert_eq!((s.share_bps(), s.pot_lines(), s.hold()), (4_000, 17, 15));
    assert_eq!(s.counted(), Some((500, T)));
    s.clear();
    assert_eq!(s, Seat::zeroed());
}

#[test]
fn the_record_and_a_seat_are_flat_bytes_and_keep_an_outside_studio() {
    let mut t = terms();
    t.studio_owner = Some([4; 32]);
    t.studio_priority = false;
    let c = ManySeatRecord::open(
        MatchId {
            opener: [1; 32],
            n: 7,
        },
        MatchMeta {
            challenge: false,
            asset: 2,
            listed: false,
        },
        (GAME, AUTH, SLOT),
        t,
        500,
        &SIZES,
        (5, 100),
        T,
    )
    .unwrap();
    assert_eq!(c.terms(), t);
    assert_eq!((c.id().n, c.meta().asset, c.meta().listed), (7, 2, false));
    assert_eq!(std::mem::size_of::<ManySeatRecord>(), ManySeatRecord::LEN);
    assert_eq!(std::mem::align_of::<ManySeatRecord>(), 1);
    assert_eq!(std::mem::size_of::<Seat>(), Seat::LEN);
    assert_eq!(std::mem::align_of::<Seat>(), 1);
}

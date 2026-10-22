//! How a Match ends: the outcome table of the Block Burst Live spec as pure functions, so every
//! row is a unit test and `close` only supplies facts.

use crate::state::*;
use table_kit::{
    OUTCOME_DRAW, OUTCOME_NO_SHOW, OUTCOME_WIN0, OUTCOME_WIN1,
};

/// A Match whose Players were paired but did not both check in before the window ended.
/// `stalled`: the rollup stalled over the window (a one-sided absence is then nobody's fault).
pub fn absent(checked_in: [bool; 2], stalled: bool) -> (u8, u8) {
    match (checked_in, stalled) {
        ([false, false], _) => (OUTCOME_DRAW, REASON_NEITHER),
        (_, true) => (OUTCOME_DRAW, REASON_VOID),
        ([true, false], false) => (OUTCOME_WIN0, REASON_ABSENT),
        ([false, true], false) => (OUTCOME_WIN1, REASON_ABSENT),
        // both checked in cannot reach this table row
        ([true, true], _) => (OUTCOME_DRAW, REASON_NO_SEED),
    }
}

/// A run that was played: `moves` and `scores` per seat.
pub fn played(moves: [u16; 2], scores: [u32; 2]) -> (u8, u8) {
    match (moves[0] == 0, moves[1] == 0) {
        (true, true) => (OUTCOME_NO_SHOW, REASON_NO_SHOW),
        (true, false) => (OUTCOME_WIN1, REASON_PLAYED),
        (false, true) => (OUTCOME_WIN0, REASON_PLAYED),
        (false, false) => match scores[0].cmp(&scores[1]) {
            core::cmp::Ordering::Greater => (OUTCOME_WIN0, REASON_PLAYED),
            core::cmp::Ordering::Less => (OUTCOME_WIN1, REASON_PLAYED),
            core::cmp::Ordering::Equal => {
                if moves[0] < TRIVIAL_MOVES && moves[1] < TRIVIAL_MOVES {
                    (OUTCOME_NO_SHOW, REASON_TRIVIAL)
                } else {
                    (OUTCOME_DRAW, REASON_DRAW)
                }
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_one_sided_absence_is_a_win_for_the_present_side() {
        assert_eq!(absent([true, false], false), (OUTCOME_WIN0, REASON_ABSENT));
        assert_eq!(absent([false, true], false), (OUTCOME_WIN1, REASON_ABSENT));
    }

    #[test]
    fn nobody_checking_in_refunds_and_a_stall_turns_an_absence_into_a_refund() {
        assert_eq!(absent([false, false], false), (OUTCOME_DRAW, REASON_NEITHER));
        assert_eq!(absent([false, false], true), (OUTCOME_DRAW, REASON_NEITHER));
        assert_eq!(absent([true, false], true), (OUTCOME_DRAW, REASON_VOID));
        assert_eq!(absent([false, true], true), (OUTCOME_DRAW, REASON_VOID));
    }

    #[test]
    fn played_runs_follow_the_outcome_table() {
        assert_eq!(played([0, 0], [0, 0]), (OUTCOME_NO_SHOW, REASON_NO_SHOW));
        assert_eq!(played([0, 3], [0, 4]), (OUTCOME_WIN1, REASON_PLAYED));
        assert_eq!(played([3, 0], [4, 0]), (OUTCOME_WIN0, REASON_PLAYED));
        assert_eq!(played([9, 9], [50, 40]), (OUTCOME_WIN0, REASON_PLAYED));
        assert_eq!(played([9, 9], [40, 50]), (OUTCOME_WIN1, REASON_PLAYED));
        // Equal and trivial: no-show. Equal and real: a draw.
        assert_eq!(played([4, 4], [9, 9]), (OUTCOME_NO_SHOW, REASON_TRIVIAL));
        assert_eq!(played([1, 4], [2, 2]), (OUTCOME_NO_SHOW, REASON_TRIVIAL));
        assert_eq!(played([5, 4], [9, 9]), (OUTCOME_DRAW, REASON_DRAW));
        assert_eq!(played([9, 9], [60, 60]), (OUTCOME_DRAW, REASON_DRAW));
    }

    #[test]
    fn the_outage_rule_needs_a_real_stretch_and_a_real_shortfall() {
        // 100 slots a second is healthy.
        assert!(!stalled(10_000, 100));
        // Under STALL_SECS nothing is judged.
        assert!(!stalled(0, STALL_SECS - 1));
        // Half the slots or fewer over at least STALL_SECS is a stall.
        assert!(stalled(0, STALL_SECS));
        assert!(stalled(4_999, 100));
        assert!(!stalled(5_000, 100));
    }

    #[test]
    fn every_wait_fits_the_assignment_budget_and_the_cores_cap() {
        let phases = (CHECKIN_SECS + SEED_SECS + GET_READY_SECS + PLAY_SECS + GRACE_SECS) as i64;
        assert!(phases + CLOSE_MARGIN_SECS as i64 <= ASSIGN_BUDGET_SECS);
        // Window to begin + budget stays inside the hold on refunds, which stays inside core's
        // seven-day extension cap.
        assert!(START_WINDOW_SECS + ASSIGN_BUDGET_SECS < TABLE_WINDOW_SECS);
        assert!(TABLE_WINDOW_SECS < 7 * 24 * 60 * 60);
        // The freeze begins after the run starts and before it ends.
        assert!(HIDE_LAST_SECS < PLAY_SECS);
        assert!(GRACE_SECS < HIDE_LAST_SECS);
    }
}

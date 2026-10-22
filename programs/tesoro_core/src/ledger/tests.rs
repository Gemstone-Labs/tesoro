//! Ledger tests that need no world model: Advance sizing, Extend, the Yield Fee, Protections.

use super::*;

fn akey(i: usize) -> Key {
    [i as u8 + 1; 32]
}
fn pkey(p: usize) -> Key {
    [50 + p as u8; 32]
}

// --- Deterministic edge cases --------------------------------------------------------------

fn locked_position() -> Position {
    // 100 SOL-like (9 decimals) at 10% APR.
    Position::new(
        akey(0),
        SourceChain::Solana,
        [7; 32],
        9,
        100_000_000_000,
        1_000,
    )
    .unwrap()
}

#[test]
fn advance_sizing_matches_glossary() {
    let mut p = locked_position();
    // Projected yield over 6 months: 5 SOL. At $150 => $750 => 75_000 Gemas.
    let s = p.open_advance(pkey(0), 6, 150_000_000, 0).unwrap();
    assert_eq!(s.issued, 75_000);
    assert_eq!(p.open_advance, Some(0));
    assert_eq!(
        p.open_advance(pkey(0), 6, 150_000_000, 0),
        Err(CoreError::AdvanceAlreadyOpen)
    );
    assert_eq!(
        locked_position().open_advance(pkey(0), 0, 1, 0),
        Err(CoreError::InvalidHorizon)
    );
    assert_eq!(
        locked_position().open_advance(pkey(0), 13, 1, 0),
        Err(CoreError::InvalidHorizon)
    );
    assert_eq!(
        locked_position().open_advance(pkey(0), 6, 0, 0),
        Err(CoreError::InvalidPrice)
    );
}

#[test]
fn extend_mints_the_added_months_at_the_source_price() {
    let mut p = locked_position();
    let mut s = p.open_advance(pkey(0), 6, 150_000_000, 0).unwrap();
    // The Player lost everything; yield has barely started.
    assert!(p.apply_yield(Some(&mut s), 1, 500_000_000).unwrap());
    let debt = s.debt();
    // 3 more months = half of the 6-month Advance: 37_500 Gemas at the same $150.
    let minted = p.extend_advance(&mut s, 3, 0).unwrap();
    assert_eq!(minted, 37_500);
    assert_eq!((s.issued, s.horizon_months), (112_500, 9));
    assert_eq!(s.debt(), debt + 37_500);
    assert_eq!(s.unit_den, 150_000_000);
    assert_eq!(p.open_advance, Some(0));
    // Extending to the cap works, one more month does not.
    assert_eq!(
        p.extend_advance(&mut s, 4, 0),
        Err(CoreError::InvalidHorizon)
    );
    assert!(p.extend_advance(&mut s, 3, 0).is_ok());
    assert_eq!(s.horizon_months, 12);
    assert_eq!(
        p.extend_advance(&mut s, 1, 0),
        Err(CoreError::InvalidHorizon)
    );
}

#[test]
fn extend_is_net_of_the_yield_fee_and_matches_a_single_longer_advance() {
    let mut a = locked_position();
    let mut sa = a.open_advance(pkey(0), 4, 150_000_000, 2_000).unwrap();
    a.extend_advance(&mut sa, 5, 2_000).unwrap();
    let mut b = locked_position();
    let sb = b.open_advance(pkey(0), 9, 150_000_000, 2_000).unwrap();
    assert_eq!(sa.issued, sb.issued);
}

#[test]
fn extend_after_the_yield_fee_changed_mints_the_added_months_at_the_current_fee() {
    let mut p = locked_position();
    let mut s = p.open_advance(pkey(0), 6, 150_000_000, 0).unwrap();
    assert_eq!(s.issued, 75_000);
    // The fee rises to 20% after the Advance: 3 more months are 20% smaller, not an error.
    let minted = p.extend_advance(&mut s, 3, 2_000).unwrap();
    assert_eq!(minted, 30_000);
    assert_eq!((s.issued, s.horizon_months), (105_000, 9));
    // The fee falls back to 0: the added months are full size, never a negative mint.
    let mut q = locked_position();
    let mut t = q.open_advance(pkey(0), 6, 150_000_000, 2_000).unwrap();
    assert_eq!(t.issued, 60_000);
    assert_eq!(q.extend_advance(&mut t, 3, 0).unwrap(), 37_500);
}

#[test]
fn extend_refuses_without_an_open_advance_other_sources_zero_debt_and_zero_months() {
    let mut p = locked_position();
    let mut s = p.open_advance(pkey(0), 3, 150_000_000, 0).unwrap();
    assert_eq!(
        p.extend_advance(&mut s, 0, 0),
        Err(CoreError::InvalidHorizon)
    );
    let mut other = s.clone();
    other.index = 7;
    assert_eq!(
        p.extend_advance(&mut other, 1, 0),
        Err(CoreError::SourceMismatch)
    );
    let before = (p.clone(), s.clone());
    assert_eq!(
        p.extend_advance(&mut s, 1, 20_000),
        Err(CoreError::InvalidBps)
    );
    assert_eq!(before, (p.clone(), s.clone()));
    // Repaid: the Advance closes and Extend has nothing to extend.
    assert!(p.apply_yield(Some(&mut s), 1, 9_000_000_000).unwrap());
    assert_eq!(s.debt(), 0);
    assert_eq!(
        p.extend_advance(&mut s, 1, 0),
        Err(CoreError::NoOpenAdvance)
    );
    // A Position that never took an Advance.
    let mut fresh = locked_position();
    let mut s2 = s.clone();
    s2.index = 0;
    assert_eq!(
        fresh.extend_advance(&mut s2, 1, 0),
        Err(CoreError::NoOpenAdvance)
    );
    // Unlocked Positions refuse.
    let mut q = locked_position();
    let mut sq = q.open_advance(pkey(0), 3, 150_000_000, 0).unwrap();
    q.status = PositionStatus::Unlocked;
    assert_eq!(
        q.extend_advance(&mut sq, 1, 0),
        Err(CoreError::PositionNotLocked)
    );
}

#[test]
fn extend_with_debt_zero_but_open_is_refused() {
    let mut p = locked_position();
    let mut s = p.open_advance(pkey(0), 3, 150_000_000, 0).unwrap();
    s.returned = s.issued;
    assert_eq!(s.debt(), 0);
    assert_eq!(
        p.extend_advance(&mut s, 1, 0),
        Err(CoreError::AdvanceRepaid)
    );
}

#[test]
fn yield_repays_debt_then_unlocks_and_new_advance_needs_zero_debt() {
    let mut p = locked_position();
    let mut s = p.open_advance(pkey(0), 6, 150_000_000, 0).unwrap();
    assert!(p.apply_yield(Some(&mut s), 1, 2_500_000_000).unwrap());
    assert_eq!(s.debt(), 37_500);
    assert_eq!(
        p.open_advance(pkey(0), 3, 150_000_000, 0),
        Err(CoreError::AdvanceAlreadyOpen)
    );
    assert_eq!(p.unlock(), Err(CoreError::DebtOutstanding));
    assert!(p.apply_yield(Some(&mut s), 2, 9_000_000_000).unwrap());
    assert_eq!(s.debt(), 0);
    assert_eq!(p.free_yield, 4_000_000_000);
    assert_eq!(p.open_advance, None);
    assert!(p.unlock().is_ok());
    // Replays and out-of-order messages are no-ops.
    assert_eq!(p.apply_yield(None, 2, 9_000_000_000), Ok(false));
    assert_eq!(p.apply_yield(None, 1, 1), Ok(false));
}

#[test]
fn seasons_are_weeks_from_a_monday() {
    assert_eq!(season_at(SEASON_EPOCH - 1), Err(CoreError::SeasonInvalid));
    assert_eq!(season_at(SEASON_EPOCH), Ok(1));
    assert_eq!(season_at(SEASON_EPOCH + SEASON_SECS - 1), Ok(1));
    assert_eq!(season_at(SEASON_EPOCH + SEASON_SECS), Ok(2));
    assert_eq!(season_start(2), Ok(SEASON_EPOCH + SEASON_SECS));
    assert_eq!(season_end(1), season_start(2));
    assert_eq!(season_start(0), Err(CoreError::SeasonInvalid));
    // 1970-01-01 was a Thursday: the epoch is a whole number of days from a Monday.
    assert_eq!(((SEASON_EPOCH / 86_400) + 3) % 7, 0);
    assert_eq!(PRIZE_BPS.iter().map(|b| *b as u32).sum::<u32>(), 10_000);
    assert_eq!([500u64, 1_000, 2_500].map(points_for_win), [5, 10, 25]);
}

// --- Yield Fee ----------------------------------------------------------------------------------

#[test]
fn advance_is_net_of_the_yield_fee_and_repaid_at_the_horizon() {
    let mut p = locked_position();
    // Gross yield over 6 months: 5 SOL; net of the 20% Yield Fee: 4 SOL. At $150 => 60_000 Gemas.
    let mut s = p.open_advance(pkey(0), 6, 150_000_000, 2_000).unwrap();
    assert_eq!(s.issued, 60_000);
    // The Position earns 80% of its gross yield; at the Horizon it has earned exactly the Advance.
    let gross_at_horizon = 5_000_000_000u64;
    let (net, fee) = split_yield_fee(gross_at_horizon, 2_000).unwrap();
    assert_eq!((net, fee), (4_000_000_000, 1_000_000_000));
    let (half, _) = split_yield_fee(gross_at_horizon / 2, 2_000).unwrap();
    assert!(p.apply_yield(Some(&mut s), 1, half).unwrap());
    assert_eq!(s.debt(), 30_000, "half the Horizon repays half the Advance");
    assert!(p.apply_yield(Some(&mut s), 2, net).unwrap());
    assert_eq!(s.debt(), 0);
    assert_eq!(p.free_yield, 0, "nothing left over at the Horizon");
    assert_eq!(p.open_advance, None);
    assert_eq!(
        locked_position().open_advance(pkey(0), 6, 150_000_000, MAX_YIELD_FEE_BPS + 1),
        Err(CoreError::InvalidBps)
    );
}

#[test]
fn yield_fee_split_floors_the_fee() {
    assert_eq!(split_yield_fee(9, 2_000).unwrap(), (8, 1));
    assert_eq!(split_yield_fee(4, 2_000).unwrap(), (4, 0));
    assert_eq!(split_yield_fee(1_000, 0).unwrap(), (1_000, 0));
    assert_eq!(split_yield_fee(1, 5_001), Err(CoreError::InvalidBps));
}

// --- Extend Limit ------------------------------------------------------------------------------

const T: i64 = 1_800_000_000;
const DAY: i64 = 24 * 60 * 60;

#[test]
fn a_fresh_extend_limit_is_three_months() {
    let l = ExtendLimit::default();
    assert_eq!(l.effective(T), 3);
    assert_eq!(l.window_months, 0);
}

#[test]
fn extends_are_recorded_against_the_limit_until_it_is_reached() {
    let mut l = ExtendLimit::default();
    l.record_extend(T, 2).unwrap();
    // Inside 24 h of the last Extend: refused, and nothing changes.
    assert_eq!(
        l.record_extend(T + DAY - 1, 1),
        Err(CoreError::ExtendCoolingDown)
    );
    assert_eq!(l.window_months, 2);
    // Exactly 24 h later it is allowed; the third month fills the limit.
    l.record_extend(T + DAY, 1).unwrap();
    assert_eq!(l.window_months, 3);
    assert_eq!(l.last_extend_at, T + DAY);
    // Past the wait but over the limit.
    assert_eq!(
        l.record_extend(T + 3 * DAY, 1),
        Err(CoreError::ExtendLimitReached)
    );
    assert_eq!(l.window_months, 3);
}

#[test]
fn an_extend_larger_than_the_limit_is_refused_at_once() {
    let mut l = ExtendLimit::default();
    assert_eq!(l.record_extend(T, 4), Err(CoreError::ExtendLimitReached));
    assert_eq!(l, ExtendLimit::default());
}

#[test]
fn the_period_resets_exactly_thirty_days_after_it_began() {
    let mut l = ExtendLimit::default();
    l.record_extend(T, 3).unwrap();
    assert_eq!(
        l.record_extend(T + 30 * DAY - 1, 1),
        Err(CoreError::ExtendLimitReached)
    );
    l.record_extend(T + 30 * DAY, 3).unwrap();
    assert_eq!((l.window_start, l.window_months), (T + 30 * DAY, 3));
}

#[test]
fn a_limit_of_zero_blocks_extend() {
    let mut l = ExtendLimit::default();
    l.set_limit(T, 0).unwrap();
    assert_eq!(l.effective(T), 0);
    assert_eq!(l.record_extend(T, 1), Err(CoreError::ExtendLimitReached));
}

#[test]
fn lowering_the_limit_works_at_once_and_a_raise_waits_a_day() {
    let mut l = ExtendLimit::default();
    l.set_limit(T, 1).unwrap();
    assert_eq!(l.effective(T), 1);
    l.set_limit(T, 5).unwrap();
    assert_eq!(l.effective(T), 1);
    assert_eq!(l.effective(T + DAY - 1), 1);
    assert_eq!(l.effective(T + DAY), 5);
    // The raise is in force for an Extend after its day.
    l.record_extend(T + DAY, 5).unwrap();
}

#[test]
fn lowering_below_a_pending_raise_cancels_it() {
    let mut l = ExtendLimit::default();
    l.set_limit(T, 6).unwrap();
    l.set_limit(T + 10, 2).unwrap();
    assert_eq!(l.effective(T + 10 * DAY), 2);
    // Setting the limit already in force while a raise waits cancels it too.
    let mut m = ExtendLimit::default();
    m.set_limit(T, 6).unwrap();
    m.set_limit(T + 10, 3).unwrap();
    assert_eq!(m.effective(T + 10 * DAY), 3);
}

#[test]
fn setting_the_pending_raise_again_keeps_its_timer() {
    let mut l = ExtendLimit::default();
    l.set_limit(T, 6).unwrap();
    let before = l;
    l.set_limit(T + 100, 6).unwrap();
    assert_eq!(l, before);
    assert_eq!(l.effective(T + DAY), 6);
}

#[test]
fn setting_the_limit_in_force_with_no_raise_pending_changes_nothing() {
    let mut l = ExtendLimit::default();
    let before = l;
    l.set_limit(T, DEFAULT_EXTEND_LIMIT).unwrap();
    assert_eq!(l, before);
}

#[test]
fn a_due_raise_is_settled_before_the_next_change() {
    let mut l = ExtendLimit::default();
    l.set_limit(T, 6).unwrap();
    // After its day the raise is the limit; lowering from there is a lowering.
    l.set_limit(T + 2 * DAY, 4).unwrap();
    assert_eq!(l.effective(T + 2 * DAY), 4);
}

#[test]
fn the_limit_is_at_most_eleven_months() {
    let mut l = ExtendLimit::default();
    assert_eq!(l.set_limit(T, 12), Err(CoreError::InvalidExtendLimit));
    l.set_limit(T, 11).unwrap();
    assert_eq!(l.effective(T + DAY), 11);
}

#[test]
fn the_twelve_month_horizon_still_caps_an_extend_inside_the_limit() {
    let mut p = locked_position();
    let mut s = p.open_advance(pkey(0), 6, 150_000_000, 0).unwrap();
    p.apply_yield(Some(&mut s), 1, 500_000_000).unwrap();
    let mut l = ExtendLimit::default();
    l.set_limit(T, 11).unwrap();
    l.record_extend(T + DAY, 7).unwrap();
    assert_eq!(
        p.extend_advance(&mut s, 7, 0),
        Err(CoreError::InvalidHorizon)
    );
}

// --- Entry Limit -------------------------------------------------------------------------------

const WEEK: i64 = 7 * DAY;

#[test]
fn no_entry_limit_counts_nothing_and_refuses_nothing() {
    let mut l = EntryLimit::default();
    l.record_entry(T, 2_500).unwrap();
    assert_eq!(l, EntryLimit::default());
    assert_eq!(l.effective(T), 0);
}

#[test]
fn entries_count_in_a_period_until_the_limit_is_reached() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 1_500).unwrap();
    assert_eq!(l.effective(T), 1_500);
    l.record_entry(T, 500).unwrap();
    l.record_entry(T + DAY, 1_000).unwrap();
    assert_eq!(l.used(T + DAY), 1_500);
    assert_eq!(
        l.record_entry(T + 2 * DAY, 500),
        Err(CoreError::EntryLimitReached)
    );
    assert_eq!(l.used(T + 2 * DAY), 1_500);
}

#[test]
fn an_entry_over_the_limit_changes_nothing() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 1_000).unwrap();
    let before = l;
    assert_eq!(l.record_entry(T, 2_500), Err(CoreError::EntryLimitReached));
    assert_eq!(l, before);
}

#[test]
fn the_period_resets_exactly_seven_days_after_it_began() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 1_000).unwrap();
    l.record_entry(T, 1_000).unwrap();
    assert_eq!(
        l.record_entry(T + WEEK - 1, 500),
        Err(CoreError::EntryLimitReached)
    );
    assert_eq!(l.used(T + WEEK - 1), 1_000);
    assert_eq!(l.used(T + WEEK), 0);
    l.record_entry(T + WEEK, 1_000).unwrap();
    assert_eq!((l.window_start, l.window_used), (T + WEEK, 1_000));
}

#[test]
fn lowering_the_entry_limit_works_at_once_even_below_what_is_used() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 2_500).unwrap();
    l.record_entry(T, 1_000).unwrap();
    l.set_limit(T + 1, 500).unwrap();
    assert_eq!(l.effective(T + 1), 500);
    assert_eq!(
        l.record_entry(T + 2, 500),
        Err(CoreError::EntryLimitReached)
    );
}

#[test]
fn a_raised_entry_limit_waits_a_day() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 500).unwrap();
    l.set_limit(T + 10, 2_500).unwrap();
    assert_eq!(l.effective(T + 10), 500);
    assert_eq!(l.effective(T + 10 + DAY - 1), 500);
    assert_eq!(l.effective(T + 10 + DAY), 2_500);
    assert_eq!(
        l.record_entry(T + 10 + DAY - 1, 1_000),
        Err(CoreError::EntryLimitReached)
    );
    l.record_entry(T + 10 + DAY, 1_000).unwrap();
}

#[test]
fn removing_the_entry_limit_is_a_raise_and_waits_a_day() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 500).unwrap();
    l.set_limit(T, 0).unwrap();
    assert_eq!(l.effective(T + DAY - 1), 500);
    assert_eq!(l.effective(T + DAY), 0);
    l.record_entry(T + DAY, 2_500).unwrap();
    l.record_entry(T + DAY + 1, 2_500).unwrap();
}

#[test]
fn setting_a_first_limit_applies_at_once() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 1_000).unwrap();
    assert_eq!(l.effective(T), 1_000);
    assert_eq!(l.pending_at, 0);
}

#[test]
fn lowering_or_restating_the_limit_cancels_a_pending_raise() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 1_000).unwrap();
    l.set_limit(T + 10, 2_500).unwrap();
    l.set_limit(T + 20, 500).unwrap();
    assert_eq!((l.pending_at, l.effective(T + 9 * DAY)), (0, 500));
    let mut m = EntryLimit::default();
    m.set_limit(T, 1_000).unwrap();
    m.set_limit(T + 10, 2_500).unwrap();
    m.set_limit(T + 20, 1_000).unwrap();
    assert_eq!((m.pending_at, m.effective(T + 9 * DAY)), (0, 1_000));
}

#[test]
fn setting_the_pending_entry_raise_again_keeps_its_timer() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 500).unwrap();
    l.set_limit(T + 5, 1_000).unwrap();
    let before = l;
    l.set_limit(T + 100, 1_000).unwrap();
    assert_eq!(l, before);
}

#[test]
fn a_due_entry_raise_is_settled_before_the_next_change() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 500).unwrap();
    l.set_limit(T, 2_500).unwrap();
    l.set_limit(T + 2 * DAY, 1_000).unwrap();
    assert_eq!((l.effective(T + 2 * DAY), l.pending_at), (1_000, 0));
}

#[test]
fn lowering_a_removed_limit_is_a_lowering() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 500).unwrap();
    l.set_limit(T, 0).unwrap();
    l.set_limit(T + 2 * DAY, 1_000).unwrap();
    assert_eq!((l.effective(T + 2 * DAY), l.pending_at), (1_000, 0));
}

#[test]
fn protections_keep_a_fixed_size_with_room_for_break_and_self_exclusion() {
    use anchor_lang::prelude::AnchorSerialize;
    let p = Protections::default();
    assert_eq!(p.try_to_vec().unwrap().len(), Protections::SPACE);
    assert_eq!((p.break_until, p.self_exclusion_until), (0, 0));
}

// --- Break and Self-Exclusion -------------------------------------------------------------------

#[test]
fn no_protection_blocks_anything() {
    let p = Protections::default();
    assert_eq!(p.check_play(T), Ok(()));
    assert_eq!(p.check_advance(T), Ok(()));
    assert!(!p.away(T));
}

#[test]
fn a_break_blocks_play_until_it_ends_but_not_advances() {
    let mut p = Protections::default();
    p.set_break(T, 3).unwrap();
    assert_eq!(p.break_until, T + 3 * DAY);
    assert_eq!(p.check_play(T + 3 * DAY - 1), Err(CoreError::OnBreak));
    assert_eq!(p.check_advance(T + 1), Ok(()));
    assert!(p.away(T + 1));
    assert_eq!(p.check_play(T + 3 * DAY), Ok(()));
    assert!(!p.away(T + 3 * DAY));
}

#[test]
fn a_self_exclusion_blocks_play_and_advances() {
    let mut p = Protections::default();
    p.set_self_exclusion(T, 6).unwrap();
    assert_eq!(p.self_exclusion_until, T + 180 * DAY);
    assert_eq!(p.check_play(T + 1), Err(CoreError::SelfExcluded));
    assert_eq!(p.check_advance(T + 1), Err(CoreError::SelfExcluded));
    assert_eq!(p.check_play(T + 180 * DAY), Ok(()));
    assert_eq!(p.check_advance(T + 180 * DAY), Ok(()));
}

#[test]
fn a_break_is_one_to_forty_two_days() {
    let mut p = Protections::default();
    assert_eq!(p.set_break(T, 0), Err(CoreError::InvalidBreak));
    assert_eq!(p.set_break(T, 43), Err(CoreError::InvalidBreak));
    p.set_break(T, 1).unwrap();
    p.set_break(T, 42).unwrap();
    assert_eq!(p.break_until, T + 42 * DAY);
}

#[test]
fn a_self_exclusion_is_six_to_sixty_months() {
    let mut p = Protections::default();
    assert_eq!(
        p.set_self_exclusion(T, 5),
        Err(CoreError::InvalidSelfExclusion)
    );
    assert_eq!(
        p.set_self_exclusion(T, 61),
        Err(CoreError::InvalidSelfExclusion)
    );
    p.set_self_exclusion(T, 60).unwrap();
    assert_eq!(p.self_exclusion_until, T + 1_800 * DAY);
}

#[test]
fn a_break_or_self_exclusion_cannot_end_earlier() {
    let mut p = Protections::default();
    p.set_break(T, 10).unwrap();
    let before = p;
    assert_eq!(
        p.set_break(T + DAY, 2),
        Err(CoreError::ProtectionCannotShorten)
    );
    assert_eq!(p, before);
    p.set_break(T + DAY, 10).unwrap();
    assert_eq!(p.break_until, T + 11 * DAY);
    p.set_self_exclusion(T, 12).unwrap();
    assert_eq!(
        p.set_self_exclusion(T + DAY, 6),
        Err(CoreError::ProtectionCannotShorten)
    );
}

#[test]
fn a_new_break_can_follow_an_ended_one_and_is_independent_of_self_exclusion() {
    let mut p = Protections::default();
    p.set_break(T, 1).unwrap();
    p.set_break(T + 5 * DAY, 1).unwrap();
    assert_eq!(p.break_until, T + 6 * DAY);
    assert_eq!(p.self_exclusion_until, 0);
    p.set_self_exclusion(T, 6).unwrap();
    assert_eq!(p.break_until, T + 6 * DAY);
}

#[test]
fn protections_keep_the_entry_limit_when_a_break_is_set() {
    let mut p = Protections::default();
    p.entry_limit.set_limit(T, 1_000).unwrap();
    p.set_break(T, 7).unwrap();
    assert_eq!(p.entry_limit.effective(T), 1_000);
}

#[test]
fn entry_sizes_are_1_to_4_distinct_multiples_of_100_and_points_stay_entry_over_100() {
    assert!(validate_entry_sizes(&[100, 500, 1_000]).is_ok());
    assert!(validate_entry_sizes(&LADDER).is_ok());
    assert!(validate_entry_sizes(&[100, 200, 300, 400]).is_ok());
    for bad in [
        &[][..],
        &[0],
        &[150],
        &[100, 100],
        &[100, 200, 300, 400, 500],
    ] {
        assert_eq!(validate_entry_sizes(bad), Err(CoreError::InvalidEntry));
    }
    assert_eq!([100u64, 500, 1_000].map(points_for_win), [1, 5, 10]);
    assert!(is_ladder_entry(100, &[100, 500]) && !is_ladder_entry(1_000, &[100, 500]));
    assert!(!is_ladder_entry(0, &[0, 100]));
}

//! Ticket 55 (SOL-02 A, founder 2026-10-28): the Treasury's Unlock top-up covers the growth of
//! landed shares since their yield was priced, never a rate fall. Expected figures come from
//! `growth_sim.py` beside this file, which prices every landing on its own; they agree with the
//! program to within one base unit where a 1-Gema Redeem is used to land yield.

use super::*;

/// The pool at `total` lamports per 1e12 tokens, with a last epoch a little lower so an Advance
/// can be sized at any rate (1% an epoch: far above any ceiling).
pub(super) fn set_rate(env: &mut Env, total: u64) {
    env.set_pool(pool_data(
        total,
        1_000_000_000_000,
        EPOCH,
        total - total / 100,
        1_000_000_000_000,
    ));
}

/// Ana's release at Unlock and what the Treasury's spendable shares lost.
fn unlock_at(env: &mut Env, ana: &Person, pos: Pos, rate: u64) -> (u64, u64) {
    set_rate(env, rate);
    let (before, start) = (env.spendable(), env.token_balance(ana.token));
    env.unlock(ana, pos).unwrap();
    env.check_vault();
    (
        env.token_balance(ana.token) - start,
        before.saturating_sub(env.spendable()),
    )
}

/// What the custody gives back to the owner before any top-up: custody less paid and owed.
fn rest_of(env: &Env, pos: Pos) -> u64 {
    let p = env.position(pos);
    let owed = u64::try_from(p.held_shares >> 32).unwrap();
    p.custody_shares - p.paid_shares - owed
}

#[test]
fn growth_only_the_opening_rate_is_no_cliff() {
    for rate in [1_200_100_000_000, 1_199_900_000_000] {
        let (mut env, ana, pos) = paid_yield_scenario();
        env.fund_treasury(SOL);
        let (release, treasury) = unlock_at(&mut env, &ana, pos, rate);
        // Today 1.2001 pays 908,257,646 from the Treasury and 1.1999 pays nothing.
        assert_eq!((release, treasury), (9_090_909_091, 0), "rate {rate}");
    }
}

#[test]
fn growth_only_a_fall_after_part_of_the_yield_is_borne_by_the_player() {
    let mut env = at_open_rate();
    let ana = env.holder(10 * SOL);
    let pos = env.open(&ana, 10 * SOL).unwrap();
    let source = env.advance_stake(&ana, pos, 6).unwrap();
    assert_eq!(env.stored(source).issued, 9_000);
    set_rate(&mut env, 1_260_000_000_000);
    env.redeem(&ana, pos, source, 9_000).unwrap();
    env.fund_treasury(SOL);
    // Today the Treasury pays 312,256,050 units.
    let (release, treasury) = unlock_at(&mut env, &ana, pos, 1_220_000_000_000);
    assert_eq!((release, treasury), (9_523_809_524, 0));
}

/// Ana's 12-month Advance lands in two halves held by holders: 0.6 SOL at 1.26, 0.6 SOL at
/// 1.32. A 1-Gema Redeem lands each half.
fn two_landings() -> (Env, Person, Pos) {
    let mut env = at_open_rate();
    let ana = env.holder(10 * SOL);
    let pos = env.open(&ana, 10 * SOL).unwrap();
    let source = env.advance_stake(&ana, pos, 12).unwrap();
    set_rate(&mut env, 1_260_000_000_000);
    env.redeem(&ana, pos, source, 1).unwrap();
    set_rate(&mut env, HIGH_RATE);
    env.redeem(&ana, pos, source, 1).unwrap();
    assert_eq!(env.debt(source), 0);
    env.fund_treasury(SOL);
    (env, ana, pos)
}

#[test]
fn growth_only_two_landings_pay_only_the_growth_net_of_the_fall() {
    // (Unlock rate, Treasury from growth_sim.py; today it pays 21,645,021 / 161,505,161 /
    // 454,545,454 / 530,735,930 / 0.)
    for (rate, want) in [
        (HIGH_RATE, 21_645_020u64),
        (1_300_000_000_000, 7_659_006),
        (1_260_000_000_000, 0),
        (LOW_RATE, 0),
        (1_190_000_000_000, 0),
    ] {
        let (mut env, ana, pos) = two_landings();
        let rest = rest_of(&env, pos);
        let (release, treasury) = unlock_at(&mut env, &ana, pos, rate);
        assert!(
            treasury.abs_diff(want) <= 1,
            "unlock at {rate}: Treasury paid {treasury}, growth_sim.py says {want}"
        );
        if want == 0 {
            assert_eq!(treasury, 0, "unlock at {rate}");
        }
        assert_eq!(release, rest + treasury, "unlock at {rate}");
    }
}

#[test]
fn growth_only_counted_yield_never_drops_so_a_close_after_a_fall_banks_no_phantom() {
    let (mut env, ana, pos) = {
        let mut env = at_open_rate();
        let ana = env.holder(10 * SOL);
        let pos = env.open(&ana, 10 * SOL).unwrap();
        (env, ana, pos)
    };
    let source = env.advance_stake(&ana, pos, 12).unwrap();
    env.set_total(HIGH_RATE);
    env.redeem(&ana, pos, source, 17_990).unwrap();
    // Fall, then the owner returns the last 10 own Gemas: the Advance closes at the low rate.
    env.set_total(LOW_RATE);
    env.return_own(&ana, pos, source, 10).unwrap();
    let p = env.position(pos);
    assert_eq!(p.open_advance, None);
    assert_eq!(
        p.applied_net, 1_200_000_000,
        "the checkpoint keeps the yield priced at 1.32 (the old code moved it to 500,000,000)"
    );
    // Recovery to 1.30 is not new yield: nothing is banked, nothing is topped up.
    env.fund_treasury(SOL);
    let free_before = env.position(pos).free_shares;
    let rest = rest_of(&env, pos);
    let (release, treasury) = unlock_at(&mut env, &ana, pos, 1_300_000_000_000);
    assert_eq!(treasury, 0);
    assert_eq!(release, rest);
    assert!(free_before > 0, "the returned ready Gemas are the owner's pocket");
}

#[test]
fn growth_only_growth_hidden_by_a_later_fall_is_borne_by_the_player() {
    // Codex's history (design-v4 3.3, founder-accepted): 20% ceiling, two 12-month Advances of
    // 2.4 SOL. The first lands at 1.44, the second is taken at 1.44 and lands at 1.68, Unlock at
    // 1.55. The first landing really grew 118,279,569 units (0.1833 SOL, 1.53% of Principal) but
    // the second's loss nets it out: the Treasury pays nothing and Ana keeps `rest`.
    let mut env = at_open_rate();
    env.set_ceiling(CEILING_BPS).unwrap();
    let ana = env.holder(10 * SOL);
    let pos = env.open(&ana, 10 * SOL).unwrap();
    let first = env.advance_stake(&ana, pos, 12).unwrap();
    assert_eq!(env.stored(first).issued, 36_000);
    set_rate(&mut env, 1_440_000_000_000);
    let second = env.advance_stake(&ana, pos, 12).unwrap();
    assert_eq!(env.stored(second).issued, 36_000);
    set_rate(&mut env, 1_680_000_000_000);
    env.redeem(&ana, pos, second, 1).unwrap();
    assert_eq!(env.debt(second), 0);
    env.fund_treasury(SOL);
    let rest = rest_of(&env, pos);
    let (release, treasury) = unlock_at(&mut env, &ana, pos, 1_550_000_000_000);
    // Today the Treasury pays 837,173,579 units.
    assert_eq!((release, treasury), (rest, 0));
    assert!(rest.abs_diff(6_904_761_905) <= 1, "rest {rest}");
}

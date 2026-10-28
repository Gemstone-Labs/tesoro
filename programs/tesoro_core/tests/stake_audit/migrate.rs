//! Ticket 55: `migrate_position` rewrites a 235-byte Position (before `stake_rate_high`) in the
//! 243-byte layout with `stake_rate_high = stake_rate_open`, so a migrated Lock keeps today's
//! Unlock behaviour. Admin only; a 243-byte Position is left alone.

use super::growth_only::set_rate;
use super::*;
use anchor_lang::{AnchorSerialize, Discriminator};

/// Rewrites a Position as the 235-byte account it would be before ticket 55: the old fields,
/// then `fill` bytes (a Some -> None rewrite leaves stale bytes after a shorter `None`), with the
/// rent a 235-byte account holds.
fn to_legacy(env: &mut Env, pos: Pos, fill: u8) {
    let state = env.load::<PositionState>(pos.position);
    let p = state.inner;
    let old = PositionStateV1 {
        bump: state.bump,
        position_id: state.position_id,
        inner: PositionV1 {
            owner: p.owner,
            source_chain: p.source_chain,
            source_asset: p.source_asset,
            decimals: p.decimals,
            principal: p.principal,
            rate_bps: p.rate_bps,
            status: p.status,
            advances: p.advances,
            open_advance: p.open_advance,
            last_seq: p.last_seq,
            cumulative_yield: p.cumulative_yield,
            free_yield: p.free_yield,
            free_yield_claimed: p.free_yield_claimed,
            opened_at: p.opened_at,
            applied_net: p.applied_net,
            custody_shares: p.custody_shares,
            yield_fee_bps: p.yield_fee_bps,
            stake_rate_open: p.stake_rate_open,
            held_shares: p.held_shares,
            free_shares: p.free_shares,
            paid_shares: p.paid_shares,
            pool_bps: p.pool_bps,
        },
    };
    let mut data = vec![fill; PositionStateV1::SPACE];
    data[..8].copy_from_slice(PositionState::DISCRIMINATOR);
    let body = old.try_to_vec().unwrap();
    data[8..8 + body.len()].copy_from_slice(&body);
    let mut acct = env.svm.get_account(&s(pos.position)).unwrap();
    acct.lamports = env
        .svm
        .minimum_balance_for_rent_exemption(PositionStateV1::SPACE);
    acct.data = data;
    env.svm.set_account(s(pos.position), acct).unwrap();
}

/// Anchor's `AccountDidNotDeserialize`.
const ANCHOR_DID_NOT_DESERIALIZE: u32 = 3003;

fn migrate_ix(signer: APk, position: APk) -> Instruction {
    tix(
        accounts::MigratePosition {
            admin: signer,
            config: pda(&[CONFIG_SEED]),
            position,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::MigratePosition {},
        vec![],
    )
}

fn migrate(env: &mut Env, pos: Pos) -> Result<(), Failed> {
    let admin = env.admin.insecure_clone();
    env.send(&[migrate_ix(a(admin.pubkey()), pos.position)], &admin, &[])
}

fn data_len(env: &Env, pos: Pos) -> usize {
    env.svm.get_account(&s(pos.position)).unwrap().data.len()
}

#[test]
fn migrate_rewrites_a_235_byte_position_with_its_high_at_the_opening_rate() {
    for (with_advance, fill) in [(true, 0u8), (false, 0), (false, 0xab)] {
        let mut env = at_open_rate();
        let ana = env.holder(10 * SOL);
        let pos = env.open(&ana, 10 * SOL).unwrap();
        if with_advance {
            let source = env.advance_stake(&ana, pos, 12).unwrap();
            set_rate(&mut env, LOW_RATE);
            env.redeem(&ana, pos, source, 1).unwrap();
            assert_eq!(env.position(pos).stake_rate_high, LOW_RATE);
        }
        let before = env.position(pos);
        to_legacy(&mut env, pos, fill);
        assert_eq!(data_len(&env, pos), 235);
        // The current program cannot read it until it is migrated.
        assert_eq!(
            code(&env.unlock(&ana, pos).unwrap_err()),
            ANCHOR_DID_NOT_DESERIALIZE
        );
        // Only the admin migrates.
        let stranger = env.person();
        assert_eq!(
            code(
                &env.send(&[migrate_ix(stranger.key, pos.position)], &stranger.kp, &[])
                    .unwrap_err()
            ),
            ERR_UNAUTHORIZED
        );
        migrate(&mut env, pos).unwrap();
        assert_eq!(data_len(&env, pos), 243);
        let after = env.position(pos);
        let mut want = before.clone();
        want.stake_rate_high = want.stake_rate_open;
        assert_eq!(after, want, "advance {with_advance} fill {fill:#x}");
        let acct = env.svm.get_account(&s(pos.position)).unwrap();
        assert!(acct.lamports >= env.svm.minimum_balance_for_rent_exemption(243));
        // A second call changes nothing.
        let data = acct.data.clone();
        migrate(&mut env, pos).unwrap();
        let again = env.svm.get_account(&s(pos.position)).unwrap();
        assert_eq!((again.data, again.lamports), (data, acct.lamports));
        set_rate(&mut env, HIGH_RATE);
        env.unlock(&ana, pos).unwrap();
        env.check_vault();
    }
}

#[test]
fn migrate_keeps_a_position_that_is_not_a_stake_lock_at_zero() {
    let mut env = at_open_rate();
    let ana = env.holder(0);
    let oracle = env.oracle.insecure_clone();
    let (ix, position) = oracle_open_ix(&env, &ana, 77);
    env.send(&[ix], &oracle, &[]).unwrap();
    let pos = Pos { position };
    to_legacy(&mut env, pos, 0);
    migrate(&mut env, pos).unwrap();
    let p = env.position(pos);
    assert_eq!((p.stake_rate_open, p.stake_rate_high), (0, 0));
}

/// Ana's legacy Lock with a 12-month Advance: the first landing (at `first`, by a 1-Gema Redeem)
/// happens before ticket 55, then the Position is migrated at `migrate_at`.
fn legacy_with_landing(first: u64, migrate_at: u64) -> (Env, Person, Pos) {
    let mut env = at_open_rate();
    let ana = env.holder(10 * SOL);
    let pos = env.open(&ana, 10 * SOL).unwrap();
    let source = env.advance_stake(&ana, pos, 12).unwrap();
    set_rate(&mut env, first);
    env.redeem(&ana, pos, source, 1).unwrap();
    set_rate(&mut env, migrate_at);
    to_legacy(&mut env, pos, 0);
    migrate(&mut env, pos).unwrap();
    env.fund_treasury(SOL);
    (env, ana, pos)
}

#[test]
fn a_migrated_lock_unlocks_as_it_did_before_the_upgrade() {
    // Claude's history (design-v4 6.1): landed at 1.25, migrated at 1.32, Unlock at 1.28. Before
    // and after the upgrade the Treasury pays 9,375,000 units (growth_sim.py).
    let (mut env, ana, pos) = legacy_with_landing(LOW_RATE, HIGH_RATE);
    set_rate(&mut env, 1_280_000_000_000);
    let before = env.spendable();
    env.unlock(&ana, pos).unwrap();
    env.check_vault();
    let paid = before - env.spendable();
    assert!(paid.abs_diff(9_375_000) <= 1, "Treasury paid {paid}");
}

#[test]
fn a_migrated_lock_with_its_advance_open_at_migration_pays_no_more_than_before() {
    // Codex's history (design-v4 6.1): migrated at 1.32 with nothing landed, fall to 1.25 where a
    // Redeem lands 0.5 SOL, recovery to 1.32, Unlock. Today 21,212,121; now 21,212,120.
    let mut env = at_open_rate();
    let ana = env.holder(10 * SOL);
    let pos = env.open(&ana, 10 * SOL).unwrap();
    let source = env.advance_stake(&ana, pos, 12).unwrap();
    set_rate(&mut env, HIGH_RATE);
    to_legacy(&mut env, pos, 0);
    migrate(&mut env, pos).unwrap();
    assert_eq!(env.position(pos).stake_rate_high, OPEN_RATE);
    set_rate(&mut env, LOW_RATE);
    env.redeem(&ana, pos, source, 1).unwrap();
    env.fund_treasury(SOL);
    let before = env.spendable();
    set_rate(&mut env, HIGH_RATE);
    env.unlock(&ana, pos).unwrap();
    env.check_vault();
    let paid = before - env.spendable();
    assert!(paid.abs_diff(21_212_120) <= 1, "Treasury paid {paid}");
}

/// A legacy Lock whose holders are owed 10.348956599 tokens against a 10-token custody
/// (design-v4 5: reachable only before the lifetime cap).
fn over_claimed(treasury: u64) -> (Env, Person, Pos) {
    let mut env = at_open_rate();
    let ana = env.holder(10 * SOL);
    let pos = env.open(&ana, 10 * SOL).unwrap();
    let mut state = env.load::<PositionState>(pos.position);
    state.inner.held_shares = 10_348_956_599u128 << 32;
    env.write(pos.position, &state, PositionState::SPACE);
    to_legacy(&mut env, pos, 0);
    migrate(&mut env, pos).unwrap();
    env.fund_treasury(treasury);
    (env, ana, pos)
}

#[test]
fn a_legacy_lock_owing_holders_more_than_its_custody_unlocks_only_when_the_treasury_funds_it() {
    let (mut env, ana, pos) = over_claimed(348_956_598);
    let route = env.route();
    assert_eq!(
        code(&env.unlock(&ana, pos).unwrap_err()),
        core_code(ledger::CoreError::GrowthClaimsUnfunded)
    );
    assert_eq!(env.route(), route, "nothing changes");
    env.fund_treasury(1);
    let start = env.token_balance(ana.token);
    env.unlock(&ana, pos).unwrap();
    assert_eq!(env.token_balance(ana.token), start, "the owner gets nothing back");
    let r = env.route();
    assert_eq!(r.owed_shares, 10_348_956_599);
    assert_eq!(r.treasury_shares, 10_348_956_599);
    assert_eq!(r.spendable(), 0);
    env.check_vault();

    let (mut env, ana, pos) = over_claimed(4 * SOL);
    env.unlock(&ana, pos).unwrap();
    let r = env.route();
    assert_eq!(r.treasury_shares, 14 * u128::from(SOL));
    assert_eq!(r.spendable(), 3_651_043_401);
    env.check_vault();
}

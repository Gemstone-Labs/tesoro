use super::*;

const OPEN_RATE: u64 = 1_200_000_000_000;
const HIGH_RATE: u64 = 1_320_000_000_000;
const LOW_RATE: u64 = 1_250_000_000_000;

fn at_open_rate() -> Env {
    let mut env = Env::with_pool(pool_data(
        OPEN_RATE,
        1_000_000_000_000,
        EPOCH,
        1_190_000_000_000,
        1_000_000_000_000,
    ));
    env.set_ceiling(1_000).unwrap();
    env
}

#[test]
fn audit_open_fees_cannot_fund_a_withdrawal_and_all_principal_returns() {
    let mut env = at_open_rate();
    let ana = env.holder(10 * SOL);
    let ben = env.holder(7 * SOL);
    let a_pos = env.open(&ana, 10 * SOL).unwrap();
    let b_pos = env.open(&ben, 7 * SOL).unwrap();
    let company = env.holder(0);
    env.set_company(company.key);
    env.set_total(HIGH_RATE);
    assert_eq!(env.spendable(), 0);
    assert_eq!(
        code(&env.withdraw(company.token, 1_000_000).unwrap_err()),
        core_code(ledger::CoreError::OverSpendable)
    );
    // Only actual funding is spendable. Remove all of it before the rate changes.
    env.fund_treasury(SOL);
    env.withdraw(company.token, HIGH_RATE / 1_000).unwrap();
    assert_eq!(env.spendable(), 0);
    env.set_total(OPEN_RATE);
    env.unlock(&ana, a_pos).unwrap();
    env.unlock(&ben, b_pos).unwrap();
    assert_eq!(env.token_balance(ana.token), 10 * SOL);
    assert_eq!(env.token_balance(ben.token), 7 * SOL);
    env.check_vault();
}

#[test]
fn audit_instant_fill_cannot_spend_open_fees_and_all_positions_unlock() {
    let mut env = at_open_rate();
    let ana = env.holder(10 * SOL);
    let a_pos = env.open(&ana, 10 * SOL).unwrap();
    env.set_total(HIGH_RATE);
    let ben = env.holder(10 * SOL);
    let b_pos = env.open(&ben, 10 * SOL).unwrap();
    let source = env.advance_stake(&ben, b_pos, 12).unwrap();
    let mut request = env.request_ix(&ben, b_pos, source, 3_300, 1);
    request.data = instruction::RequestInstantRedeem {
        line: env.line(source, SIDE_OWN),
        sell: 3_300,
        ttl_secs: 7 * 24 * 3600,
        nonce: 1,
    }
    .data();
    env.send(&[request], &ben.kp, &[]).unwrap();
    assert_eq!(env.spendable(), 0);
    assert_eq!(
        code(&env.fill(&ben, b_pos, source, 1, 3_300).unwrap_err()),
        core_code(ledger::CoreError::OverSpendable)
    );
    let cancel = env.return_order_ix(&ben, &ben, source, 1, false);
    env.send(&[cancel], &ben.kp, &[]).unwrap();
    let all = env.gemas(&ben, source);
    env.return_own(&ben, b_pos, source, all).unwrap();
    env.set_total(OPEN_RATE);
    env.unlock(&ana, a_pos).unwrap();
    env.unlock(&ben, b_pos).unwrap();
    assert_eq!(env.token_balance(ana.token), 10 * SOL);
    assert_eq!(env.token_balance(ben.token), 10 * SOL);
    env.check_vault();
}

#[test]
fn audit_unlocked_claims_after_a_slash_leave_another_positions_custody_intact() {
    let mut env = at_open_rate();
    let ana = env.holder(10 * SOL);
    let ben = env.holder(0);
    let pos = env.open(&ana, 10 * SOL).unwrap();
    let source = env.advance_stake(&ana, pos, 1).unwrap();
    env.give_won(&ana, &ben, source, 400);
    env.set_total(HIGH_RATE);
    env.unlock(&ana, pos).unwrap();
    let owed = env.route().owed_shares;
    assert!(owed > 0);
    let carla = env.holder(10 * SOL);
    let c_pos = env.open(&carla, 10 * SOL).unwrap();
    env.withdraw_all_spendable_to_company();
    env.set_total(1_100_000_000_000);
    let before = env.token_balance(env.vault());
    let ready = env.redeemable(&ben, source);
    env.redeem(&ben, pos, source, ready).unwrap();
    let claim = owed - env.route().owed_shares;
    assert_eq!(
        u128::from(env.token_balance(ben.token)),
        claim * 8_000 / 10_000
    );
    assert_eq!(
        before - env.token_balance(env.vault()),
        env.token_balance(ben.token)
    );
    assert_eq!(env.position(c_pos).custody_shares, 10 * SOL);
    env.unlock(&carla, c_pos).unwrap();
    assert_eq!(env.token_balance(carla.token), 10 * SOL);
    let ana_ready = env.redeemable(&ana, source);
    env.redeem(&ana, pos, source, ana_ready).unwrap();
    env.check_vault();
}

fn paid_yield_scenario() -> (Env, Person, Pos) {
    let mut env = at_open_rate();
    let ana = env.holder(10 * SOL);
    let pos = env.open(&ana, 10 * SOL).unwrap();
    let source = env.advance_stake(&ana, pos, 12).unwrap();
    assert_eq!(env.stored(source).issued, 18_000);
    env.set_total(HIGH_RATE);
    env.redeem(&ana, pos, source, 18_000).unwrap();
    assert_eq!(env.debt(source), 0);
    env.check_vault();
    (env, ana, pos)
}

/// SOL-01 (founder decision 2026-10-28, option A): a rate fall after the yield was paid out leaves the
/// Player what is left of their tokens, less than the Locked amount. Disclosed on the Risks page, Terms and the
/// Unlock screen; the program emits `UnlockShortfall` with the gap the app reads. Tesoro does not cover it.
#[test]
fn audit_a_rate_fall_after_paid_yield_returns_what_is_left_and_is_disclosed() {
    let (mut env, ana, pos) = paid_yield_scenario();
    env.withdraw_all_spendable_to_company();
    env.set_total(LOW_RATE);
    let before = env.token_balance(ana.token);
    env.unlock(&ana, pos).unwrap();
    let release = env.token_balance(ana.token) - before;
    let value = ledger::units_for_tokens(release, LOW_RATE).unwrap();
    env.check_vault();
    assert!(
        value < 12 * SOL,
        "the Player bears the fall: {value} should be below {}",
        12 * SOL
    );
    // Decision page walk-through: Ana keeps `rest` = 9,090,909,091 base units, worth 11.363636363
    // SOL at the low rate; nothing comes from the Treasury (SOL-02 A, ticket 55).
    assert_eq!(release, 9_090_909_091);
    assert_eq!(12 * SOL - value, 636_363_637);
}

#[test]
fn audit_a_rate_fall_above_open_does_not_charge_the_treasury_for_the_slash() {
    let (mut env, ana, pos) = paid_yield_scenario();
    env.fund_treasury(SOL);
    let before = env.spendable();
    env.set_total(LOW_RATE);
    let start = env.token_balance(ana.token);
    env.unlock(&ana, pos).unwrap();
    assert_eq!(env.token_balance(ana.token) - start, 9_090_909_091);
    env.check_vault();
    let after = env.spendable();
    eprintln!(
        "SOL-02 treasury before={before} after={after} charged={}",
        before - after
    );
    assert_eq!(
        after, before,
        "D2: a rate fall must not consume Treasury funding"
    );
}

#[test]
fn audit_paid_yield_does_not_spend_another_positions_principal() {
    let (mut env, ana, pos) = paid_yield_scenario();
    env.withdraw_all_spendable_to_company();
    let ben = env.holder(10 * SOL);
    let b_pos = env.open(&ben, 10 * SOL).unwrap();
    env.set_total(LOW_RATE);
    env.unlock(&ana, pos).unwrap();
    env.check_vault();
    env.unlock(&ben, b_pos).unwrap();
    assert_eq!(env.token_balance(ben.token), 10 * SOL);
    env.check_vault();
}

#[test]
fn audit_stale_pool_is_rejected_at_extend_fill_treasury_redeem_and_withdraw() {
    let (mut env, ana, ben, pos, source) = treasury_env();
    env.request(&ben, pos, source, 1_000, 1).unwrap();
    env.fund_treasury(SOL);
    env.fill(&ben, pos, source, 1, 100).unwrap();
    let company = env.holder(0);
    env.set_company(company.key);
    env.set_clock(T0 + 24 * 3600, EPOCH + 2);
    let stale = core_code(ledger::CoreError::StaleStakePool);
    assert_eq!(
        code(&env.extend_stake(&ana, pos, source, 1).unwrap_err()),
        stale
    );
    assert_eq!(
        code(&env.fill(&ben, pos, source, 1, 100).unwrap_err()),
        stale
    );
    let payer = env.person();
    assert_eq!(
        code(&env.redeem_treasury(&payer.kp, pos, source, 1).unwrap_err()),
        stale
    );
    assert_eq!(
        code(&env.withdraw(company.token, 1_000_000).unwrap_err()),
        stale
    );
    env.check_vault();
}

fn oracle_open_ix(env: &Env, owner: &Person, id: u8) -> (Instruction, APk) {
    let position_id = [id; 32];
    let position = pda(&[POSITION_SEED, &[0], &position_id]);
    (
        tix(
            accounts::OpenPosition {
                oracle: a(env.oracle.pubkey()),
                config: pda(&[CONFIG_SEED]),
                owner_account: owner.account,
                position,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::OpenPosition {
                source_chain: ledger::SourceChain::Solana,
                position_id,
                source_asset: env.mint,
                decimals: 9,
                principal: 12 * SOL,
                rate_bps: 1_000,
            },
            vec![],
        ),
        position,
    )
}

#[test]
fn audit_mainnet_oracle_lock_rejects_uncustodied_real_token_positions() {
    let mut env = at_open_rate();
    let ana = env.holder(0);
    let oracle = env.oracle.insecure_clone();
    let admin = env.admin.insecure_clone();
    let lock = tix(
        accounts::SetOracleLock {
            admin: a(admin.pubkey()),
            config: pda(&[CONFIG_SEED]),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::SetOracleLock { locked: true },
        vec![],
    );
    env.send(&[lock], &admin, &[]).unwrap();
    let (ix, position) = oracle_open_ix(&env, &ana, 99);
    let err = env.send(&[ix], &oracle, &[]).unwrap_err();
    assert_eq!(
        code(&err),
        6000 + tesoro_core::error::TesoroError::OracleLocked as u32
    );
    assert!(env.svm.get_account(&s(position)).is_none());
    assert_eq!(env.token_balance(env.vault()), 0);
}

#[test]
fn audit_unlocked_oracle_mode_is_explicitly_not_a_custody_guarantee() {
    let mut env = at_open_rate();
    let ana = env.holder(0);
    let oracle = env.oracle.insecure_clone();
    let (ix, position) = oracle_open_ix(&env, &ana, 99);
    env.send(&[ix], &oracle, &[]).unwrap();
    let recorded = env.load::<PositionState>(position).inner;
    assert_eq!(recorded.source_asset, env.mint.to_bytes());
    assert_eq!(recorded.principal, 12 * SOL);
    assert_eq!(recorded.custody_shares, 0);
    assert_eq!(recorded.stake_rate_open, 0);
    assert_eq!(env.token_balance(env.vault()), 0);
}

#[test]
fn audit_payout_rejects_substituted_pool_owner_mint_and_token_program() {
    let (mut env, ana, _ben, pos, source) = treasury_env();
    env.set_total(HIGH_RATE);
    let fake = APk::new_unique();
    let original = env.svm.get_account(&s(env.pool)).unwrap();
    env.svm.set_account(s(fake), original.clone()).unwrap();
    let mut ix = env.redeem_ix(&ana, pos, source, 1);
    ix.accounts
        .iter_mut()
        .find(|m| m.pubkey == s(env.pool))
        .unwrap()
        .pubkey = s(fake);
    assert_eq!(
        code(&env.send(&[ix], &ana.kp, &[]).unwrap_err()),
        ERR_BAD_POOL
    );
    let mut bad_owner = original.clone();
    bad_owner.owner = s(anchor_lang::system_program::ID);
    env.svm.set_account(s(env.pool), bad_owner).unwrap();
    assert_eq!(
        code(&env.redeem(&ana, pos, source, 1).unwrap_err()),
        ERR_BAD_POOL
    );
    let mut bad_mint = original.clone();
    bad_mint.data[162] ^= 1;
    env.svm.set_account(s(env.pool), bad_mint).unwrap();
    assert_eq!(
        code(&env.redeem(&ana, pos, source, 1).unwrap_err()),
        ERR_BAD_POOL
    );
    env.svm.set_account(s(env.pool), original).unwrap();
    let mut ix = env.redeem_ix(&ana, pos, source, 1);
    ix.accounts
        .iter_mut()
        .find(|m| m.pubkey == s(TOKEN_PROGRAM_ID))
        .unwrap()
        .pubkey = s(anchor_lang::system_program::ID);
    assert_eq!(
        code(&env.send(&[ix], &ana.kp, &[]).unwrap_err()),
        6000 + tesoro_core::error::TesoroError::InvalidAccount as u32
    );
    env.check_vault();
}

#[test]
fn audit_runbook_and_fixture_use_the_published_jitosol_addresses() {
    let env = at_open_rate();
    let runbook = include_str!("../../../../docs/mainnet-runbook.md");
    let client = include_str!("../../../../app/src/lib/chain/stake.ts");
    for key in [env.mint, env.pool] {
        assert!(runbook.contains(&key.to_string()));
        assert!(client.contains(&key.to_string()));
    }
    assert_eq!(
        ledger::parse_stake_pool(JITO_POOL_DATA).unwrap().pool_mint,
        env.mint.to_bytes()
    );
    assert_eq!(ledger::MAX_STALE_EPOCHS, 1);
}

#[test]
fn audit_single_landing_without_a_rate_fall_needs_no_material_treasury_topup() {
    let (mut env, ana, pos) = paid_yield_scenario();
    env.fund_treasury(SOL);
    let before = env.spendable();
    env.unlock(&ana, pos).unwrap();
    assert!(before.abs_diff(env.spendable()) <= 1);
    env.check_vault();
}

#[test]
fn audit_a_fall_below_open_leaves_treasury_funding_untouched() {
    let (mut env, ana, pos) = paid_yield_scenario();
    env.fund_treasury(SOL);
    let before = env.spendable();
    env.set_total(1_190_000_000_000);
    env.unlock(&ana, pos).unwrap();
    assert_eq!(env.spendable(), before);
    env.check_vault();
}

#[test]
#[ignore = "audit 2026-10-26: SOL-01"]
fn audit_retaining_all_realised_fees_keeps_principal_whole_after_a_rate_fall() {
    let (mut env, ana, pos) = paid_yield_scenario();
    env.set_total(LOW_RATE);
    let before = env.token_balance(ana.token);
    env.unlock(&ana, pos).unwrap();
    let release = env.token_balance(ana.token) - before;
    let value = ledger::units_for_tokens(release, LOW_RATE).unwrap();
    env.check_vault();
    eprintln!("SOL-01 retained fees release={release} value={value}");
    assert!(
        value >= 12 * SOL,
        "Principal must remain whole even without Treasury spending"
    );
}

mod cu;
mod fixtures;
mod growth_only;
mod migrate;

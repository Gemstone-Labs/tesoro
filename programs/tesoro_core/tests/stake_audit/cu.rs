//! Compute units of the stake paths ticket 55 touches, printed for a before/after comparison:
//! `cargo test -p tesoro_core --test stake cu_report -- --nocapture`.

use super::*;

fn cu(env: &mut Env, ix: Instruction, payer: &Keypair) -> u64 {
    env.svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        env.svm.latest_blockhash(),
    );
    env.svm
        .send_transaction(tx)
        .expect("instruction succeeds")
        .compute_units_consumed
}

#[test]
fn cu_report() {
    let mut env = at_open_rate();
    let ana = env.holder(10 * SOL);
    let pos = env.open(&ana, 10 * SOL).unwrap();
    env.refresh_feed();
    let (ix, source) = env.advance_ix(&ana, pos, 6);
    let first_advance = cu(&mut env, ix, &ana.kp);
    env.ensure_pages(source);
    env.set_total(1_300_000_000_000);
    let ix = env.redeem_ix(&ana, pos, source, 1);
    let redeem_landing = cu(&mut env, ix, &ana.kp);
    let ix = env.redeem_ix(&ana, pos, source, 1);
    let redeem_plain = cu(&mut env, ix, &ana.kp);
    let ext = tix(
        accounts::ExtendStakeAdvance {
            owner_authority: ana.key,
            owner_account: ana.account,
            protections: pda(&[PROTECTIONS_SEED, ana.account.as_ref()]),
            position: pos.position,
            stake_config: pda(&[STAKE_CONFIG_SEED]),
            custody: env.custody_address(),
            stake_pool: env.pool,
            source,
            basket: env.basket(&ana),
            spill: env.spill(&ana),
            extend_limit: pda(&[EXTEND_LIMIT_SEED, ana.account.as_ref()]),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::ExtendStakeAdvance {
            extra_months: 6,
            min_gemas: 1,
        },
        book_metas(&env.svm, source),
    );
    let extend = cu(&mut env, ext, &ana.kp);
    env.ensure_pages(source);
    env.set_total(1_500_000_000_000);
    env.refresh_feed();
    let (ix, second) = env.advance_ix(&ana, pos, 6);
    let closing_advance = cu(&mut env, ix, &ana.kp);
    env.ensure_pages(second);
    env.set_total(1_700_000_000_000);
    let ix = env.unlock_ix(&ana, pos);
    let unlock_closing = cu(&mut env, ix, &ana.kp);
    let ben = env.holder(10 * SOL);
    let b_pos = env.open(&ben, 10 * SOL).unwrap();
    env.set_total(1_800_000_000_000);
    let ix = env.unlock_ix(&ben, b_pos);
    let unlock_banking = cu(&mut env, ix, &ben.kp);
    eprintln!(
        "CU take_stake_advance(first)={first_advance} redeem(landing)={redeem_landing} \
         redeem(no landing)={redeem_plain} extend_stake_advance={extend} \
         take_stake_advance(closing previous)={closing_advance} unlock(closing)={unlock_closing} \
         unlock(banking)={unlock_banking}"
    );
}

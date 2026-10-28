//! Compute units of the stake paths ticket 55 touches, printed for a before/after comparison:
//! `cargo test -p tesoro_core --test stake cu_report -- --nocapture`.

use super::growth_only::set_rate;
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

/// A holder with a fixed key: every PDA (and so every bump search) is the same on every run.
fn fixed_holder(env: &mut Env, seed: u8, tokens: u64) -> Person {
    let kp = solana_sdk::signer::keypair::keypair_from_seed(&[seed; 32]).unwrap();
    env.svm.airdrop(&kp.pubkey(), 1_000 * SOL).unwrap();
    let key = a(kp.pubkey());
    let account = pda(&[ACCOUNT_SEED, key.as_ref()]);
    let create = tix(
        accounts::CreateAccount {
            authority: key,
            account,
            basket: basket_address(&account).0,
            spill: spill_address(&account).0,
            invite_gate: invite_gate_pda(),
            system_program: anchor_lang::system_program::ID,
            payer: key,
            sponsor: None,
        },
        instruction::CreateAccount {
            evm_address: [0; 20],
        },
        vec![],
    );
    env.send(&[create], &kp, &[]).unwrap();
    let p = Person {
        token: get_associated_token_address(&key, &env.mint),
        kp,
        key,
        account,
    };
    env.set_tokens(&p, tokens);
    p
}

#[test]
fn cu_report() {
    let mut env = at_open_rate();
    let ana = fixed_holder(&mut env, 7, 10 * SOL);
    let pos = env.open(&ana, 10 * SOL).unwrap();
    env.refresh_feed();
    let (ix, source) = env.advance_ix(&ana, pos, 6);
    let first_advance = cu(&mut env, ix, &ana.kp);
    env.ensure_pages(source);
    set_rate(&mut env, 1_220_000_000_000);
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
            extra_months: 1,
            min_gemas: 1,
        },
        book_metas(&env.svm, source),
    );
    let extend = cu(&mut env, ext, &ana.kp);
    env.ensure_pages(source);
    set_rate(&mut env, 1_500_000_000_000);
    env.refresh_feed();
    let (ix, second) = env.advance_ix(&ana, pos, 6);
    let closing_advance = cu(&mut env, ix, &ana.kp);
    env.ensure_pages(second);
    env.set_total(1_700_000_000_000);
    let ix = env.unlock_ix(&ana, pos);
    let unlock_closing = cu(&mut env, ix, &ana.kp);
    let ben = fixed_holder(&mut env, 8, 10 * SOL);
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

fn cu_tx(env: &mut Env, ixs: &[Instruction], payer: &Keypair) -> u64 {
    env.svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        ixs,
        Some(&payer.pubkey()),
        &[payer],
        env.svm.latest_blockhash(),
    );
    env.svm
        .send_transaction(tx)
        .expect("transaction succeeds")
        .compute_units_consumed
}

/// `migrate_position` on 235-byte Positions: alone, and ten in one transaction (the operator
/// script's batch, keeper/src/migrate-positions.ts sizes its compute limit from these):
/// `cargo test -p tesoro_core --test stake cu_report_migrate -- --nocapture`.
#[test]
fn cu_report_migrate_position() {
    use super::migrate::{migrate_ix, to_legacy};
    let mut env = at_open_rate();
    let ana = fixed_holder(&mut env, 9, 11 * SOL);
    let with_advance = env.open(&ana, SOL).unwrap();
    env.advance_stake(&ana, with_advance, 6).unwrap();
    let mut rest = vec![];
    for _ in 0..10 {
        rest.push(env.open(&ana, SOL).unwrap());
    }
    to_legacy(&mut env, with_advance, 0);
    for p in &rest {
        to_legacy(&mut env, *p, 0xab);
    }
    let admin = env.admin.insecure_clone();
    let one = cu_tx(
        &mut env,
        &[migrate_ix(a(admin.pubkey()), with_advance.position)],
        &admin,
    );
    let ixs: Vec<Instruction> = rest
        .iter()
        .map(|p| migrate_ix(a(admin.pubkey()), p.position))
        .collect();
    let ten = cu_tx(&mut env, &ixs, &admin);
    let again = cu_tx(&mut env, &ixs, &admin);
    for p in rest.iter().chain([&with_advance]) {
        assert_eq!(env.svm.get_account(&s(p.position)).unwrap().data.len(), 243);
    }
    eprintln!("CU migrate_position(one, open Advance)={one} migrate_position(ten in one tx)={ten} migrate_position(ten already migrated)={again}");
    // keeper/src/migrate-positions.ts asks 10,000 CU a Position (MIGRATE_CU_LIMIT) from this measurement.
    assert!(
        one <= 10_000 && ten <= 10 * 10_000,
        "the operator script's 10,000 CU per Position covers a migration"
    );
}

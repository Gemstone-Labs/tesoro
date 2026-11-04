//! Seat keys: the Match names a key per Player, the Game copies it into the Assignment, Battle and
//! Armies, and every Player instruction accepts the Seat's wallet or its key and nobody else. The
//! rollup lets any key send for free, so these refusals are the only gate.
//!
//! LiteSVM has no permission program: `seat_players_standin` stamps the Armies the way the real
//! `seat_players` does. The two-member permission itself is covered in `table_kit`.

use super::*;

/// Opens and joins a Match whose Players name `ak` and `bk` as seat keys, assigns it to table 0
/// at its current epoch and points the Env at that table. LiteSVM charges fees the rollup does
/// not, so the keys are funded.
fn keyed_match(env: &mut Env, ak: &Keypair, bk: &Keypair) {
    env.ensure_deployed();
    for k in [ak, bk] {
        env.svm.airdrop(&k.pubkey(), SOL).expect("airdrop");
    }
    let (alice, bob) = (dup(&env.alice), dup(&env.bob));
    let n = env.nonce;
    env.nonce += 2;
    let m = flow::open_match_keyed(
        &mut env.svm,
        &alice.kp,
        Some(ak),
        vanguard::ID,
        1_000,
        n,
        false,
        0,
    )
    .expect("open match");
    flow::join_match_keyed(&mut env.svm, &bob.kp, Some(bk), &m, vanguard::ID, n + 1)
        .expect("join match");
    env.tmatch = m.key;
    env.mref = Some(m);
    let epoch = env.table_at(table_addr(0, 0)).epoch;
    env.assign(0, 0, epoch).expect("assign");
}

/// The Match is on the table, begun, and the seats are handed over (nobody has checked in).
fn seated() -> (Env, Keypair, Keypair) {
    let mut env = Env::new();
    let (ak, bk) = (Keypair::new(), Keypair::new());
    keyed_match(&mut env, &ak, &bk);
    env.begin().expect("begin");
    env.seat_players_standin();
    (env, ak, bk)
}

/// `ix` with `who` in its first (signer) account, sent and paid by `who`.
fn as_signer(env: &mut Env, who: &Keypair, mut ixn: Instruction) -> Result<(), Failed> {
    ixn.accounts[0].pubkey = who.pubkey();
    env.send(&[budget(), ixn], who, &[])
}

fn refused_with(env: &mut Env, who: &Keypair, ixn: Instruction, want: VanguardError) {
    let err = as_signer(env, who, ixn).expect_err("must be refused");
    assert_eq!(custom_code(&err), vcode(want), "{:?}", err.err);
}

/// A dealt Match with the truck-raid layout, Alice (seat 0) on the US turn, nothing declared.
fn dealt(env: &mut Env) {
    env.check_in(0).unwrap();
    env.check_in(1).unwrap();
    env.stage(&truck_raid_layout(), 0);
    env.set_time(env.now + 2);
    env.next_slot();
}

#[test]
fn the_seat_signer_is_copied_from_the_match_into_assignment_battle_and_armies() {
    let (env, ak, bk) = seated();
    let keys = [a(ak.pubkey()), a(bk.pubkey())];
    let asg: Assignment = env.load(assign_addr(env.tmatch));
    assert_eq!(asg.players, [env.alice.key, env.bob.key]);
    assert_eq!(asg.signers, keys);
    let b = env.battle();
    assert_eq!(b.signers, keys);
    let t = env.table();
    for (seat, key) in keys.into_iter().enumerate() {
        let army = env.army(seat);
        assert_eq!(
            (army.signer, army.tesoro_match, army.epoch),
            (key, t.tesoro_match, t.epoch)
        );
    }
}

#[test]
fn a_wallet_that_names_no_seat_key_is_its_own_signer() {
    let mut env = ready();
    env.seat_players_standin();
    let asg: Assignment = env.load(assign_addr(env.tmatch));
    assert_eq!(asg.signers, asg.players);
    assert_eq!(env.battle().signers, env.battle().players);
    assert_eq!(env.army(0).signer, env.alice.key);
}

#[test]
fn a_seat_is_played_by_its_key_and_by_its_wallet_through_every_instruction() {
    let (mut env, ak, bk) = seated();
    let (alice, bob) = (env.alice.kp.insecure_clone(), env.bob.kp.insecure_clone());
    // check-in: Ana's key, Ben's wallet
    let ixn = env.check_in_ix(env.alice.key);
    as_signer(&mut env, &ak, ixn).unwrap();
    let ixn = env.check_in_ix(env.bob.key);
    as_signer(&mut env, &bob, ixn).unwrap();
    assert_eq!(env.table().phase, vanguard::TABLE_LIVE);
    // entropy: Ana's wallet, Ben's key
    let secrets = [env.fresh_secret(), env.fresh_secret()];
    let ixn = env.contribute_ix(0, secrets[0]);
    as_signer(&mut env, &alice, ixn).unwrap();
    let ixn = env.contribute_ix(1, secrets[1]);
    as_signer(&mut env, &bk, ixn).unwrap();
    assert!(env.army(0).contributed && env.army(1).contributed);
    // declares: Ana's key, Ben's key, Ana's wallet each pass in turn
    env.stage(&truck_raid_layout(), 0);
    env.set_time(env.now + 2);
    env.next_slot();
    let outsider = stranger(&mut env);
    let ixn = env.pass_ix(env.alice.key, 0, 0);
    as_signer(&mut env, &ak, ixn).unwrap();
    env.resolve(&outsider).unwrap();
    let ixn = env.pass_ix(env.bob.key, 0, 0);
    as_signer(&mut env, &bk, ixn).unwrap();
    env.resolve(&outsider).unwrap();
    let ixn = env.pass_ix(env.alice.key, 0, 0);
    as_signer(&mut env, &alice, ixn).unwrap();
    env.resolve(&outsider).unwrap();
    assert_eq!(env.battle().turn, 1);
}

#[test]
fn check_in_refuses_a_stranger_and_lets_each_key_check_in_only_its_own_seat() {
    let (mut env, _ak, bk) = seated();
    let outsider = stranger(&mut env);
    let ixn = env.check_in_ix(env.alice.key);
    refused_with(&mut env, &outsider, ixn, VanguardError::NotAPlayer);
    assert_eq!(env.table().checked_in, [false, false]);
    // Ben's key resolves to Ben's seat, never to Ana's.
    let ixn = env.check_in_ix(env.bob.key);
    as_signer(&mut env, &bk, ixn).unwrap();
    assert_eq!(env.table().checked_in, [false, true]);
}

#[test]
fn contribute_refuses_the_opponent_a_stranger_and_an_army_of_another_match() {
    let (mut env, ak, bk) = seated();
    env.check_in(0).unwrap();
    env.check_in(1).unwrap();
    let (alice, bob) = (env.alice.kp.insecure_clone(), env.bob.kp.insecure_clone());
    let outsider = stranger(&mut env);
    let secret = env.fresh_secret();
    for who in [&bob, &bk, &outsider] {
        let ixn = env.contribute_ix(0, secret);
        refused_with(&mut env, who, ixn, VanguardError::NotAPlayer);
    }
    assert!(!env.army(0).contributed);
    // an Army stamped for another Match refuses its own key and wallet
    let real = env.table().tesoro_match;
    env.patch_army(0, |v| v.tesoro_match = APk::new_unique());
    for who in [&ak, &alice] {
        let ixn = env.contribute_ix(0, secret);
        refused_with(&mut env, who, ixn, VanguardError::NotAPlayer);
    }
    env.patch_army(0, |v| v.tesoro_match = real);
    let ixn = env.contribute_ix(0, secret);
    as_signer(&mut env, &ak, ixn).unwrap();
}

#[test]
fn every_declare_refuses_a_stranger_and_never_lets_the_opponent_take_the_turn() {
    let (mut env, ak, bk) = seated();
    dealt(&mut env);
    let (alice, bob) = (env.alice.kp.insecure_clone(), env.bob.kp.insecure_clone());
    let outsider = stranger(&mut env);
    let p = env.alice.key;
    let declares = |env: &Env| -> Vec<Instruction> {
        vec![
            env.move_ix(p, id_of(70), 20),
            env.blast_ix(p, id_of(70), 0),
            env.rescue_ix(p, id_of(70), 0),
            env.pass_ix(p, 0, 0),
            env.declare_ix(p, vanguard::instruction::StartTwoStep {}),
        ]
    };
    for ixn in declares(&env) {
        // Alice is on turn: a stranger is no Player at all
        refused_with(&mut env, &outsider, ixn.clone(), VanguardError::NotAPlayer);
        // Ben's wallet and key resolve to Ben's seat, which is not on turn
        for who in [&bob, &bk] {
            refused_with(&mut env, who, ixn.clone(), VanguardError::NotYourTurn);
        }
    }
    assert_eq!(env.battle().pending_kind, vanguard::PENDING_NONE);
    // the seat's own wallet and key are not refused by the binding
    for who in [&alice, &ak] {
        let ixn = env.pass_ix(p, 0, 0);
        let err = as_signer(&mut env, who, ixn);
        assert!(err.is_ok(), "{:?}", err.err());
        env.resolve(&outsider).unwrap();
        // pass back to Alice for the next round
        let back = env.pass_ix(env.bob.key, 0, 0);
        as_signer(&mut env, &bob, back).unwrap();
        env.resolve(&outsider).unwrap();
    }
}

/// A table whose first Match is over and wiped, the next one named `ck` and `dk`.
fn reused() -> (Env, Keypair, Keypair, Keypair, Keypair) {
    let mut env = Env::new();
    let (ak, bk) = (Keypair::new(), Keypair::new());
    keyed_match(&mut env, &ak, &bk);
    env.begin().unwrap();
    env.start_in_rollup(1);
    env.stage(&truck_raid_layout(), 0);
    env.set_time(env.now + 2);
    env.mv(0, id_of(70), 20).expect("capture the Truck");
    env.finish_and_reset();
    env.set_time(env.now + 10);
    let (ck, dk) = (Keypair::new(), Keypair::new());
    keyed_match(&mut env, &ck, &dk);
    env.begin().unwrap();
    env.seat_players_standin();
    (env, ak, bk, ck, dk)
}

#[test]
fn an_old_seat_key_does_nothing_on_a_reused_table_for_check_in_and_entropy() {
    let (mut env, ak, bk, ck, dk) = reused();
    assert_eq!(env.army(0).signer, a(ck.pubkey()));
    for who in [&ak, &bk] {
        let ixn = env.check_in_ix(a(who.pubkey()));
        refused_with(&mut env, who, ixn, VanguardError::NotAPlayer);
    }
    let ixn = env.check_in_ix(env.alice.key);
    as_signer(&mut env, &ck, ixn).unwrap();
    let ixn = env.check_in_ix(env.bob.key);
    as_signer(&mut env, &dk, ixn).unwrap();
    let secret = env.fresh_secret();
    for who in [&ak, &bk] {
        let ixn = env.contribute_ix(0, secret);
        refused_with(&mut env, who, ixn, VanguardError::NotAPlayer);
    }
    let ixn = env.contribute_ix(0, secret);
    as_signer(&mut env, &ck, ixn).unwrap();
}

#[test]
fn an_old_seat_key_does_nothing_on_a_reused_table_for_declares() {
    let (mut env, ak, bk, ck, _dk) = reused();
    dealt(&mut env);
    for who in [&ak, &bk] {
        let ixn = env.pass_ix(env.alice.key, 0, 0);
        refused_with(&mut env, who, ixn, VanguardError::NotAPlayer);
    }
    let ixn = env.pass_ix(env.alice.key, 0, 0);
    as_signer(&mut env, &ck, ixn).unwrap();
}

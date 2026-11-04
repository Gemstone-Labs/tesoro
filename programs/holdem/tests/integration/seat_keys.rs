//! Seat keys: the Match names a key per Player, the Game copies it into the Assignment, Table and
//! Holes, and every Player instruction accepts the Seat's wallet or its key and nobody else. The
//! rollup lets any key send for free, so these refusals are the only gate.
//!
//! LiteSVM has no permission program: `seat_players_standin` stamps the Holes the way the real
//! `seat_players` does. The two-member permission itself is covered in `table_kit`.

use super::*;
use holdem::HoldemError as E;

/// Opens and joins a Match whose Players name `ak` and `bk` as seat keys, assigns it to table 0
/// at its current epoch and points the Env at that table. LiteSVM charges fees the rollup does
/// not, so the keys are funded.
fn keyed_match(env: &mut Env, ak: &Keypair, bk: &Keypair) {
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
        holdem::ID,
        1_000,
        n,
        false,
        env.speed,
    )
    .expect("open match");
    flow::join_match_keyed(&mut env.svm, &bob.kp, Some(bk), &m, holdem::ID, n + 1)
        .expect("join match");
    env.tmatch = m.key;
    env.mref = Some(m);
    let epoch = env.table_at(table_addr(0, 0)).epoch;
    env.assign(0, 0, epoch).expect("assign");
    env.table = table_addr(0, 0);
}

/// The Match is on the table and the seats are handed over (nobody has checked in).
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
    env.send(&[ixn], who, &[])
}

fn refused_with(env: &mut Env, who: &Keypair, ixn: Instruction, want: E) {
    let err = as_signer(env, who, ixn).expect_err("must be refused");
    assert_eq!(custom_code(&err), dcode(want));
}

/// Both Players check in with their wallets: the Match is live at hand one's shuffle.
fn live_now(env: &mut Env) {
    env.check_in(0).expect("check in 0");
    env.check_in(1).expect("check in 1");
}

#[test]
fn the_seat_signer_is_copied_from_the_match_into_assignment_table_and_holes() {
    let (env, ak, bk) = seated();
    let keys = [a(ak.pubkey()), a(bk.pubkey())];
    let asg: Assignment = env.load(assign_addr(env.tmatch));
    assert_eq!(asg.players, [env.alice.key, env.bob.key]);
    assert_eq!(asg.signers, keys);
    let t = env.table();
    assert_eq!(t.game.signers, keys);
    for (seat, key) in keys.into_iter().enumerate() {
        let h = env.hole(seat);
        assert_eq!(
            (h.signer, h.tesoro_match, h.epoch),
            (key, t.tesoro_match, t.epoch)
        );
    }
}

#[test]
fn a_wallet_that_names_no_seat_key_is_its_own_signer() {
    let mut env = ready();
    env.begin().unwrap();
    env.seat_players_standin();
    let asg: Assignment = env.load(assign_addr(env.tmatch));
    assert_eq!(asg.signers, asg.players);
    assert_eq!(env.hole(0).signer, env.alice.key);
}

#[test]
fn a_seat_is_played_by_its_key_and_by_its_wallet_through_every_instruction() {
    let (mut env, ak, bk) = seated();
    let (alice, bob) = (env.alice.kp.insecure_clone(), env.bob.kp.insecure_clone());
    // Ana's key and Ben's wallet check in.
    let ixn = env.check_in_ix(env.alice.key);
    as_signer(&mut env, &ak, ixn).unwrap();
    let ixn = env.check_in_ix(env.bob.key);
    as_signer(&mut env, &bob, ixn).unwrap();
    assert_eq!(env.table().phase, holdem::TABLE_LIVE);
    // the shuffle: Ana's key and Ben's wallet contribute
    let secrets = [env.fresh_secret(), env.fresh_secret()];
    let ixn = env.contribute_ix(0, secrets[0]);
    as_signer(&mut env, &ak, ixn).unwrap();
    let ixn = env.contribute_ix(1, secrets[1]);
    as_signer(&mut env, &bob, ixn).unwrap();
    env.request_standin();
    env.callback([0x5a; 32]).unwrap();
    env.deal().unwrap();
    // the first to act uses the key, the other the wallet
    let first = usize::from(env.table().game.to_act);
    let keys = [&ak, &bk];
    let wallets = [&alice, &bob];
    let ixn = env.act_ix(a(keys[first].pubkey()), Action::Call);
    as_signer(&mut env, keys[first], ixn).unwrap();
    assert_eq!(usize::from(env.table().game.to_act), 1 - first);
    let ixn = env.act_ix(a(wallets[1 - first].pubkey()), Action::Check);
    as_signer(&mut env, wallets[1 - first], ixn).unwrap();
    // and the other way round on the next street
    let next = usize::from(env.table().game.to_act);
    let ixn = env.act_ix(a(wallets[next].pubkey()), Action::Check);
    as_signer(&mut env, wallets[next], ixn).unwrap();
    let ixn = env.act_ix(a(keys[1 - next].pubkey()), Action::Check);
    as_signer(&mut env, keys[1 - next], ixn).unwrap();
}

#[test]
fn check_in_refuses_a_stranger_and_lets_each_key_check_in_only_its_own_seat() {
    let (mut env, _ak, bk) = seated();
    let stranger = env.admin.insecure_clone();
    let ixn = env.check_in_ix(env.alice.key);
    refused_with(&mut env, &stranger, ixn, E::NotAPlayer);
    assert_eq!(env.table().checked_in, [false, false]);
    // Ben's key resolves to Ben's seat, never to Ana's.
    let ixn = env.check_in_ix(env.bob.key);
    as_signer(&mut env, &bk, ixn).unwrap();
    assert_eq!(env.table().checked_in, [false, true]);
}

#[test]
fn contribute_refuses_the_opponent_a_stranger_and_a_board_of_another_match() {
    let (mut env, ak, bk) = seated();
    live_now(&mut env);
    let (alice, bob) = (env.alice.kp.insecure_clone(), env.bob.kp.insecure_clone());
    let stranger = env.admin.insecure_clone();
    let secret = env.fresh_secret();
    for who in [&bob, &bk, &stranger] {
        let ixn = env.contribute_ix(0, secret);
        refused_with(&mut env, who, ixn, E::NotAPlayer);
    }
    // a Hole stamped for another Match refuses its own key and wallet
    env.patch_hole(0, |h| h.tesoro_match = APk::new_unique());
    for who in [&ak, &alice] {
        let ixn = env.contribute_ix(0, secret);
        refused_with(&mut env, who, ixn, E::NotAPlayer);
    }
    let real = env.table().tesoro_match;
    env.patch_hole(0, |h| h.tesoro_match = real);
    let ixn = env.contribute_ix(0, secret);
    as_signer(&mut env, &ak, ixn).unwrap();
}

#[test]
fn act_refuses_a_stranger_and_never_lets_the_opponent_take_the_turn() {
    let (mut env, ak, bk) = seated();
    live_now(&mut env);
    env.deal_hand([0x5a; 32]).unwrap();
    let first = usize::from(env.table().game.to_act);
    let (alice, bob) = (env.alice.kp.insecure_clone(), env.bob.kp.insecure_clone());
    let stranger = env.admin.insecure_clone();
    let ixn = env.act_ix(a(stranger.pubkey()), Action::Fold);
    refused_with(&mut env, &stranger, ixn, E::NotAPlayer);
    // the opponent's wallet and key resolve to the opponent's seat, which is not on turn
    let (their_wallet, their_key) = if first == 0 {
        (&bob, &bk)
    } else {
        (&alice, &ak)
    };
    for who in [their_wallet, their_key] {
        let ixn = env.act_ix(a(who.pubkey()), Action::Call);
        refused_with(&mut env, who, ixn, E::NotYourTurn);
    }
    assert_eq!(usize::from(env.table().game.to_act), first);
}

#[test]
fn an_old_seat_key_does_nothing_on_a_reused_table() {
    let mut env = Env::new();
    let (ak, bk) = (Keypair::new(), Keypair::new());
    keyed_match(&mut env, &ak, &bk);
    env.play();
    env.wipe_standin();
    env.set_time(env.now + holdem::RESET_DELAY_SECS);
    env.reset().expect("reset");
    let (ck, dk) = (Keypair::new(), Keypair::new());
    keyed_match(&mut env, &ck, &dk);
    env.begin().unwrap();
    env.seat_players_standin();
    assert_eq!(env.hole(0).signer, a(ck.pubkey()));
    for who in [&ak, &bk] {
        let ixn = env.check_in_ix(a(who.pubkey()));
        refused_with(&mut env, who, ixn, E::NotAPlayer);
    }
    let ixn = env.check_in_ix(env.alice.key);
    as_signer(&mut env, &ck, ixn).unwrap();
    let ixn = env.check_in_ix(env.bob.key);
    as_signer(&mut env, &dk, ixn).unwrap();
    let secret = env.fresh_secret();
    for who in [&ak, &bk] {
        let ixn = env.contribute_ix(0, secret);
        refused_with(&mut env, who, ixn, E::NotAPlayer);
    }
    let ixn = env.contribute_ix(0, secret);
    as_signer(&mut env, &ck, ixn).unwrap();
}

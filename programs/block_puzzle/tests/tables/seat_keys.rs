//! Seat keys: the Match names a key per Player, the Game copies it into the Assignment, Table and
//! Boards, and every Player instruction accepts the Seat's wallet or its key and nobody else.
//! The rollup lets any key send for free, so these refusals are the only gate.
//!
//! LiteSVM has no permission program: `seat_players_standin` stamps the Boards the way the real
//! `seat_players` does. The two-member permission itself is covered in `table_kit`.

use super::*;

/// Opens and joins a Match whose Players name `ak` and `bk` as seat keys, assigns it to `index`
/// at the table's current epoch and points the Env at that table. LiteSVM charges fees the
/// rollup does not, so the keys are funded.
fn keyed_match(env: &mut Env, ak: &Keypair, bk: &Keypair, index: u16) {
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
        block_puzzle::ID,
        1_000,
        n,
        false,
        0,
    )
    .expect("open match");
    flow::join_match_keyed(&mut env.svm, &bob.kp, Some(bk), &m, block_puzzle::ID, n + 1)
        .expect("join match");
    env.tmatch = m.key;
    env.mref = Some(m);
    let epoch = env.table_at(table_addr(0, index)).epoch;
    env.assign(0, index, epoch).expect("assign");
    env.table = table_addr(0, index);
}

fn keyed() -> (Env, Keypair, Keypair) {
    let mut env = Env::new();
    let (ak, bk) = (Keypair::new(), Keypair::new());
    keyed_match(&mut env, &ak, &bk, 0);
    (env, ak, bk)
}

/// The Match is on the table and the seats are handed over (nobody has checked in).
fn seated() -> (Env, Keypair, Keypair) {
    let (mut env, ak, bk) = keyed();
    env.begin().expect("begin_match");
    env.seat_players_standin();
    (env, ak, bk)
}

/// `ix` with `who` in its first (signer) account, sent and paid by `who`.
fn as_signer(env: &mut Env, who: &Keypair, mut ixn: Instruction) -> Result<(), Failed> {
    ixn.accounts[0].pubkey = who.pubkey();
    env.send(&[ixn], who, &[])
}

fn refused(env: &mut Env, who: &Keypair, ixn: Instruction) {
    let err = as_signer(env, who, ixn).expect_err("must be refused");
    assert_eq!(custom_code(&err), dcode(E::NotAPlayer));
}

/// Both Players check in with their wallets, the Seed arrives, the countdown ends.
fn running_now(env: &mut Env) {
    env.check_in(0).expect("check in 0");
    env.check_in(1).expect("check in 1");
    env.request_standin();
    env.callback([0x5a; 32]).expect("callback");
    env.start().expect("start");
    let start = env.table().start_slot;
    env.set_slot(start);
}

fn check_in_of(env: &Env, seat: usize) -> Instruction {
    env.check_in_ix(env.person_of(seat).1, env.binding())
}

#[test]
fn the_seat_signer_is_copied_from_the_match_into_assignment_table_and_boards() {
    let (mut env, ak, bk) = keyed();
    let keys = [a(ak.pubkey()), a(bk.pubkey())];
    let asg: Assignment = env.load(assign_addr(env.tmatch));
    assert_eq!(asg.players, [env.alice.key, env.bob.key]);
    assert_eq!(asg.signers, keys);
    env.begin().unwrap();
    assert_eq!(env.table().signers, keys);
    env.seat_players_standin();
    assert_eq!([env.board(0).signer, env.board(1).signer], keys);
}

#[test]
fn a_wallet_that_names_no_seat_key_is_its_own_signer() {
    let mut env = ready();
    let asg: Assignment = env.load(assign_addr(env.tmatch));
    assert_eq!(asg.signers, asg.players);
    env.begin().unwrap();
    env.seat_players_standin();
    assert_eq!(env.board(0).signer, env.alice.key);
}

#[test]
fn a_seat_is_played_by_its_key_and_by_its_wallet_through_every_instruction() {
    let (mut env, ak, bk) = seated();
    let (alice, bob) = (env.alice.kp.insecure_clone(), env.bob.kp.insecure_clone());
    // Ana's key and Ben's wallet check in.
    let ixn = check_in_of(&env, 0);
    as_signer(&mut env, &ak, ixn).unwrap();
    let ixn = check_in_of(&env, 1);
    as_signer(&mut env, &bob, ixn).unwrap();
    env.request_standin();
    env.callback([0x5a; 32]).unwrap();
    env.start().unwrap();
    let start = env.table().start_slot;
    env.set_slot(start);
    let b = env.binding();
    let ixn = env.begin_run_ix(0, b);
    as_signer(&mut env, &ak, ixn).unwrap();
    let ixn = env.begin_run_ix(1, b);
    as_signer(&mut env, &bob, ixn).unwrap();
    // public play: the key, then the wallet
    env.set_slot(start + SPS);
    for (seat, who) in [(0, &ak), (1, &bob)] {
        let moves = env.moves(seat, 1);
        let ixn = env.play_ix(seat, b, 0, moves, false);
        as_signer(&mut env, who, ixn).unwrap();
        assert_eq!(env.board(seat).moves, 1);
    }
    // the hidden beat from the freeze: the wallet, then the key
    let freeze = env.table().freeze_slot().unwrap();
    env.set_slot(freeze);
    for (seat, who) in [(0, &alice), (1, &bk)] {
        let moves = env.moves(seat, 1);
        let ixn = env.play_ix(seat, b, 1, moves, true);
        as_signer(&mut env, who, ixn).unwrap();
        assert_eq!(env.board(seat).moves, 2);
    }
}

#[test]
fn check_in_refuses_a_stranger_and_lets_each_key_check_in_only_its_own_seat() {
    let (mut env, _ak, bk) = seated();
    let stranger = env.admin.insecure_clone();
    let ixn = check_in_of(&env, 0);
    refused(&mut env, &stranger, ixn);
    assert_eq!(env.table().checked_in, [false, false]);
    // Ben's wallet and Ben's key resolve to Ben's seat, never to Ana's.
    let bob = env.bob.kp.insecure_clone();
    for who in [&bob, &bk] {
        let ixn = env.check_in_ix(a(who.pubkey()), env.binding());
        as_signer(&mut env, who, ixn).unwrap();
        assert_eq!(env.table().checked_in, [false, true]);
        env.patch_table(|t| t.checked_in = [false; 2]);
    }
}

#[test]
fn begin_and_play_refuse_the_opponent_and_a_stranger() {
    let (mut env, ak, bk) = seated();
    running_now(&mut env);
    let bob = env.bob.kp.insecure_clone();
    let alice = env.alice.kp.insecure_clone();
    let stranger = env.admin.insecure_clone();
    let b = env.binding();
    let on_ana = |env: &Env| env.begin_run_ix(0, b);
    for who in [&bob, &bk, &stranger] {
        let ixn = on_ana(&env);
        refused(&mut env, who, ixn);
    }
    env.begin_run(0).unwrap();
    env.begin_run(1).unwrap();
    env.set_slot(env.slot + SPS);
    for who in [&bob, &bk, &stranger] {
        let moves = env.moves(0, 1);
        let ixn = env.play_ix(0, b, 0, moves, false);
        refused(&mut env, who, ixn);
    }
    // the same seat's own wallet and key still pass
    for who in [&alice, &ak] {
        let moves = env.moves(0, 1);
        let before = env.board(0).moves;
        let ixn = env.play_ix(0, b, before, moves, false);
        as_signer(&mut env, who, ixn).unwrap();
        env.set_slot(env.slot + SPS);
    }
    // hidden beat from the freeze
    let freeze = env.table().freeze_slot().unwrap();
    env.set_slot(freeze);
    for who in [&bob, &bk, &stranger] {
        let moves = env.moves(0, 1);
        let ixn = env.play_ix(0, b, env.board(0).moves, moves, true);
        refused(&mut env, who, ixn);
    }
}

#[test]
fn a_board_stamped_for_another_match_refuses_its_own_key() {
    let (mut env, ak, _bk) = seated();
    running_now(&mut env);
    let b = env.binding();
    env.patch_board(0, |bd| bd.tesoro_match = APk::new_unique());
    let ixn = env.begin_run_ix(0, b);
    refused(&mut env, &ak, ixn);
    let alice = env.alice.kp.insecure_clone();
    let ixn = env.begin_run_ix(0, b);
    refused(&mut env, &alice, ixn);
}

#[test]
fn an_old_seat_key_does_nothing_on_a_reused_table() {
    let (mut env, ak, bk) = keyed();
    env.play_out(1, 1);
    next_epoch(&mut env);
    let (ck, dk) = (Keypair::new(), Keypair::new());
    keyed_match(&mut env, &ck, &dk, 0);
    env.begin().unwrap();
    env.seat_players_standin();
    assert_eq!(env.board(0).signer, a(ck.pubkey()));
    for who in [&ak, &bk] {
        let ixn = env.check_in_ix(a(who.pubkey()), env.binding());
        refused(&mut env, who, ixn);
    }
    let ixn = check_in_of(&env, 0);
    as_signer(&mut env, &ck, ixn).unwrap();
    let ixn = check_in_of(&env, 1);
    as_signer(&mut env, &dk, ixn).unwrap();
    env.request_standin();
    env.callback([0x5a; 32]).unwrap();
    env.start().unwrap();
    let start = env.table().start_slot;
    env.set_slot(start);
    let b = env.binding();
    for who in [&ak, &bk] {
        let ixn = env.begin_run_ix(0, b);
        refused(&mut env, who, ixn);
    }
    let ixn = env.begin_run_ix(0, b);
    as_signer(&mut env, &ck, ixn).unwrap();
}

#[test]
fn the_seat_check_keeps_the_heaviest_player_instructions_in_budget() {
    let (mut env, ak, _bk) = seated();
    running_now(&mut env);
    env.begin_run(0).unwrap();
    env.begin_run(1).unwrap();
    let b = env.binding();
    let start = env.table().start_slot;
    env.set_slot(start + SPS);
    let moves = env.moves(0, block_puzzle::MAX_PLAY_BATCH);
    let ixn = env.play_ix(0, b, 0, moves, false);
    as_signer(&mut env, &ak, ixn).unwrap();
    let public_play = env.last_cu;
    let freeze = env.table().freeze_slot().unwrap();
    env.set_slot(freeze);
    let before = env.board(0).moves;
    let moves = env.moves(0, block_puzzle::MAX_PLAY_BATCH);
    let ixn = env.play_ix(0, b, before, moves, true);
    as_signer(&mut env, &ak, ixn).unwrap();
    let hidden_beat = env.last_cu;
    println!("CU by seat key: play(8 moves) {public_play}, play_hidden(8 moves) {hidden_beat}");
    assert!(public_play < 100_000 && hidden_beat < 100_000);
}

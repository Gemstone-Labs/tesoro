//! Seat keys: the Match names a key per Player, the Game copies it into the Assignment, Table and
//! Books, and every Player instruction accepts the Seat's wallet or its key and nobody else. The
//! rollup lets any key send for free, so these refusals are the only gate.
//!
//! LiteSVM has no permission program: `open_seats_standin` stamps the Books the way the real
//! `open_seats` does. The two-member permission itself is covered in `table_kit`.

use super::*;
use trading_duel::DuelError as E;

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
        trading_duel::ID,
        1_000,
        n,
        false,
        env.asset,
    )
    .expect("open match");
    flow::join_match_keyed(&mut env.svm, &bob.kp, Some(bk), &m, trading_duel::ID, n + 1)
        .expect("join match");
    env.tmatch = m.key;
    env.mref = Some(m);
    let epoch = env.table_at(table_addr(0, 0)).epoch;
    env.assign(0, 0, epoch).expect("assign");
    env.table = table_addr(0, 0);
}

/// The Match is on the table and the Books exist (nobody has checked in), with the price set.
fn seated() -> (Env, Keypair, Keypair) {
    let mut env = Env::new();
    let (ak, bk) = (Keypair::new(), Keypair::new());
    keyed_match(&mut env, &ak, &bk);
    env.begin().expect("begin");
    env.open_seats_standin();
    env.price(100.0);
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

fn pick_ix(env: &Env, seat: usize, column: u8, band: i16) -> Instruction {
    ix(
        trading_duel::ID,
        trading_duel::accounts::SetPick {
            player: env.person_of(seat).1,
            table: env.table,
            book: book_addr(env.table, seat as u8),
        },
        trading_duel::instruction::SetPick { column, band },
        vec![],
    )
}

#[test]
fn the_seat_signer_is_copied_from_the_match_into_assignment_table_and_books() {
    let (env, ak, bk) = seated();
    let keys = [a(ak.pubkey()), a(bk.pubkey())];
    let asg: Assignment = env.load(assign_addr(env.tmatch));
    assert_eq!(asg.players, [env.alice.key, env.bob.key]);
    assert_eq!(asg.signers, keys);
    let t = env.table();
    assert_eq!(t.signers, keys);
    for (seat, key) in keys.into_iter().enumerate() {
        let b = env.book(seat);
        assert_eq!(
            (b.signer, b.tesoro_match, b.epoch),
            (key, t.tesoro_match, t.epoch)
        );
    }
}

#[test]
fn a_wallet_that_names_no_seat_key_is_its_own_signer() {
    let mut env = ready();
    env.begin().unwrap();
    env.open_seats_standin();
    let asg: Assignment = env.load(assign_addr(env.tmatch));
    assert_eq!(asg.signers, asg.players);
    assert_eq!(env.book(0).signer, env.alice.key);
}

#[test]
fn a_seat_is_played_by_its_key_and_by_its_wallet_through_every_instruction() {
    let (mut env, ak, bk) = seated();
    let bob = env.bob.kp.insecure_clone();
    let ixn = env.check_in_ix(env.alice.key);
    as_signer(&mut env, &ak, ixn).unwrap();
    let ixn = env.check_in_ix(env.bob.key);
    as_signer(&mut env, &bob, ixn).unwrap();
    assert_eq!(env.table().phase, trading_duel::PHASE_LIVE);
    // Ana's key picks column 0, Ben's wallet picks column 1; each Book holds only its own pick
    let ixn = pick_ix(&env, 0, 0, 2);
    as_signer(&mut env, &ak, ixn).unwrap();
    let ixn = pick_ix(&env, 1, 1, -1);
    as_signer(&mut env, &bob, ixn).unwrap();
    assert_eq!(env.book(0).picks[0], 2);
    assert_eq!(env.book(1).picks[1], -1);
    // and the other way round
    let alice = env.alice.kp.insecure_clone();
    let ixn = pick_ix(&env, 0, 2, 3);
    as_signer(&mut env, &alice, ixn).unwrap();
    let ixn = pick_ix(&env, 1, 3, 4);
    as_signer(&mut env, &bk, ixn).unwrap();
    assert_eq!((env.book(0).pick_count, env.book(1).pick_count), (2, 2));
}

#[test]
fn check_in_refuses_a_stranger_and_lets_each_key_check_in_only_its_own_seat() {
    let (mut env, _ak, bk) = seated();
    let stranger = env.admin.insecure_clone();
    let ixn = env.check_in_ix(env.alice.key);
    refused(&mut env, &stranger, ixn);
    assert_eq!(env.table().checked_in, [false, false]);
    // Ben's key resolves to Ben's seat, never to Ana's.
    let ixn = env.check_in_ix(env.bob.key);
    as_signer(&mut env, &bk, ixn).unwrap();
    assert_eq!(env.table().checked_in, [false, true]);
}

#[test]
fn set_pick_refuses_the_opponent_a_stranger_and_a_book_of_another_match() {
    let (mut env, ak, bk) = seated();
    env.check_in(0).unwrap();
    env.check_in(1).unwrap();
    let (alice, bob) = (env.alice.kp.insecure_clone(), env.bob.kp.insecure_clone());
    let stranger = env.admin.insecure_clone();
    for who in [&bob, &bk, &stranger] {
        let ixn = pick_ix(&env, 0, 0, 1);
        refused(&mut env, who, ixn);
    }
    assert_eq!(env.book(0).pick_count, 0);
    // a Book opened for another Match refuses its own key and wallet
    let real = env.table().tesoro_match;
    env.patch_book(0, |b| b.tesoro_match = APk::new_unique());
    for who in [&ak, &alice] {
        let ixn = pick_ix(&env, 0, 0, 1);
        refused(&mut env, who, ixn);
    }
    env.patch_book(0, |b| b.tesoro_match = real);
    let ixn = pick_ix(&env, 0, 0, 1);
    as_signer(&mut env, &ak, ixn).unwrap();
}

#[test]
fn an_old_seat_key_does_nothing_on_a_reused_table() {
    let mut env = Env::new();
    let (ak, bk) = (Keypair::new(), Keypair::new());
    keyed_match(&mut env, &ak, &bk);
    env.play(Some(0), Some(0));
    env.close_seats_standin();
    env.set_time(env.now + trading_duel::RESET_DELAY_SECS);
    env.reset().expect("reset");
    let (ck, dk) = (Keypair::new(), Keypair::new());
    keyed_match(&mut env, &ck, &dk);
    env.begin().unwrap();
    env.open_seats_standin();
    env.price(100.0);
    assert_eq!(env.book(0).signer, a(ck.pubkey()));
    for who in [&ak, &bk] {
        let ixn = env.check_in_ix(a(who.pubkey()));
        refused(&mut env, who, ixn);
    }
    let ixn = env.check_in_ix(env.alice.key);
    as_signer(&mut env, &ck, ixn).unwrap();
    let ixn = env.check_in_ix(env.bob.key);
    as_signer(&mut env, &dk, ixn).unwrap();
    for who in [&ak, &bk] {
        let ixn = pick_ix(&env, 0, 0, 1);
        refused(&mut env, who, ixn);
    }
    let ixn = pick_ix(&env, 0, 0, 1);
    as_signer(&mut env, &ck, ixn).unwrap();
}

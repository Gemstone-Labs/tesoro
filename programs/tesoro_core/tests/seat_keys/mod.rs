//! Seat keys (seat-keys ticket 02): an entry names a key that co-signs it; that key, the wallet
//! and nobody else act for the entry's Match side or Entry Ticket (`util::acts_for`).

use super::*;
use tesoro_core::ledger::draw::TicketState;
use tesoro_core::ledger::lifecycle::Stage;

const WALLET_ONLY_NOT_EXPIRED: u32 = ERR_TICKET_NOT_EXPIRED;
const NOT_TICKET_OWNER: u32 = 6400 + tesoro_core::error::MatchError::NotTicketOwner as u32;

impl Env {
    /// A funded key that is nobody's wallet: a seat key, or a stranger.
    fn fresh_key(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 10 * SOL).expect("airdrop");
        k
    }

    /// The next entries (Match or Ticket) name `k` as their seat key and it co-signs them.
    fn name_seat(&mut self, k: &Keypair) {
        self.seat_key = Some(k.insecure_clone());
    }

    fn no_seat(&mut self) {
        self.seat_key = None;
    }

    fn ticket_signer(&self, owner: &Person, nonce: u64) -> APk {
        let d = self
            .svm
            .get_account(&s(ticket_pda(owner.account, nonce)))
            .expect("ticket")
            .data;
        let at = tesoro_core::pots::SIGNER_AT;
        APk::new_from_array(d[8 + at..8 + at + 32].try_into().unwrap())
    }
}

fn key_of(k: &Keypair) -> APk {
    a(k.pubkey())
}

#[test]
fn a_match_side_records_the_seat_key_that_co_signed_or_the_wallet_that_named_none() {
    let mut d = duel();
    let ana_key = d.env.fresh_key();
    let ben_key = d.env.fresh_key();
    d.env.name_seat(&ana_key);
    let id = d.env.open_match(&d.alice, 500).expect("open with a seat key");
    assert_eq!(d.env.mstate(id).inner.a.signer, key_of(&ana_key).to_bytes());
    assert_eq!(d.env.mstate(id).inner.a.player, d.alice.account.to_bytes());
    d.env.name_seat(&ben_key);
    d.env.join_match(&d.bob, id).expect("join with a seat key");
    let b = d.env.mstate(id).inner.b.expect("joined");
    assert_eq!(b.signer, key_of(&ben_key).to_bytes());
    assert_eq!(b.player, d.bob.account.to_bytes());

    // a wallet that wants no seat key names itself, on both entry paths
    d.env.no_seat();
    let (carol, _) = person_with_lines(&mut d.env, 2, 150, 1_000);
    let (dan, _) = person_with_lines(&mut d.env, 2, 160, 1_000);
    let id2 = d.env.open_match(&carol, 500).expect("open");
    assert_eq!(d.env.mstate(id2).inner.a.signer, carol.key.to_bytes());
    d.env.join_match(&dan, id2).expect("join");
    assert_eq!(
        d.env.mstate(id2).inner.b.unwrap().signer,
        dan.key.to_bytes()
    );
}

#[test]
fn a_seat_signer_that_did_not_sign_is_refused_on_every_entry_path() {
    let mut d = duel();
    let not_signing = Keypair::new();
    // open_ticket
    let nonce = d.env.next_ticket(d.alice.account);
    d.env.ensure_spill(&d.alice.kp.insecure_clone(), d.alice.account, 4);
    let open = open_ticket_ix(&d.alice, nonce, 500, 4, key_of(&not_signing));
    let alice = d.alice.kp.insecure_clone();
    assert!(d.env.send(&[open], &alice, &[]).is_err());
    // open_match and join_match: the named key has to sign, wherever it is named
    d.env.seat_key = Some(not_signing.insecure_clone());
    d.env.seat_unsigned = true;
    assert!(d.env.open_match(&d.alice, 500).is_err());
    d.env.seat_unsigned = false;
    d.env.no_seat();
    let id = d.env.open_match(&d.alice, 500).expect("open");
    d.env.seat_key = Some(not_signing);
    d.env.seat_unsigned = true;
    assert!(d.env.join_match(&d.bob, id).is_err());
    assert_eq!(d.env.mstate(id).inner.stage(), Stage::Open);
}

#[test]
fn the_seat_key_the_ticket_names_stages_and_cancels_it_and_nobody_else_does() {
    let mut d = duel();
    let ana_key = d.env.fresh_key();
    let other_key = d.env.fresh_key();
    let stranger = d.env.fresh_key();
    // another Player's Ticket, with another seat key
    d.env.name_seat(&other_key);
    d.env.open_ticket(&d.bob, 5, 500, 6).expect("bob's ticket");
    d.env.name_seat(&ana_key);
    let (alice, bob) = (
        Person {
            kp: d.alice.kp.insecure_clone(),
            key: d.alice.key,
            account: d.alice.account,
        },
        Person {
            kp: d.bob.kp.insecure_clone(),
            key: d.bob.key,
            account: d.bob.account,
        },
    );
    d.env.open_ticket(&alice, 5, 500, 6).expect("ana's ticket");
    assert_eq!(d.env.ticket_signer(&alice, 5), key_of(&ana_key));
    let books = d.env.books_of(alice.account);

    // staging an Entry Ticket: the owner's wallet and its seat key; a stranger and another
    // Player's seat key are refused
    for wrong in [&stranger, &other_key] {
        let err = d
            .env
            .stage_with(wrong, &alice, 5, 20, books.clone())
            .unwrap_err();
        assert_eq!(custom_code(&err), NOT_TICKET_OWNER);
    }
    d.env
        .stage_with(&ana_key, &alice, 5, 20, books.clone())
        .expect("the seat key stages");
    assert_eq!(d.env.load_ticket_staged(&alice, 5), 500);

    // cancelling: a stranger and another Player's key wait for the deadline, the seat key does
    // not
    for wrong in [&stranger, &other_key] {
        let err = d
            .env
            .cancel_ticket_with(wrong, &alice, 5, 8, books.clone())
            .unwrap_err();
        assert_eq!(custom_code(&err), WALLET_ONLY_NOT_EXPIRED);
    }
    assert_eq!(d.env.ticket_state(&alice, 5), TicketState::Open);
    d.env
        .cancel_ticket_with(&ana_key, &alice, 5, 8, books.clone())
        .expect("the seat key cancels at once");
    while d.env.ticket_state(&alice, 5) != TicketState::Cancelled {
        d.env
            .cancel_ticket_with(&stranger, &alice, 5, 8, books.clone())
            .expect("anyone continues");
    }

    // a Ticket whose seat key is the wallet itself works as before: the wallet stages and cancels
    d.env.no_seat();
    d.env.open_ticket(&alice, 6, 500, 6).expect("wallet ticket");
    assert_eq!(d.env.ticket_signer(&alice, 6), alice.key);
    let wallet = alice.kp.insecure_clone();
    let err = d
        .env
        .stage_with(&ana_key, &alice, 6, 20, books.clone())
        .unwrap_err();
    assert_eq!(custom_code(&err), NOT_TICKET_OWNER);
    d.env
        .stage_with(&wallet, &alice, 6, 20, books.clone())
        .expect("wallet stages");
    d.env
        .cancel_ticket_with(&wallet, &alice, 6, 8, books.clone())
        .expect("wallet cancels");
    // the other Player's key still does nothing to Bob's Ticket by being Ana's
    let err = d
        .env
        .cancel_ticket_with(&ana_key, &bob, 5, 8, books)
        .unwrap_err();
    assert_eq!(custom_code(&err), WALLET_ONLY_NOT_EXPIRED);
}

#[test]
fn the_requesters_seat_key_is_named_by_a_backed_entry_but_only_the_backer_cancels_the_backing_ticket(
) {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, request, 5_000);
    b.accept(offer, request);
    let carol = Person {
        kp: b.carol.kp.insecure_clone(),
        key: b.carol.key,
        account: b.carol.account,
    };
    let dave = Person {
        kp: b.dave.kp.insecure_clone(),
        key: b.dave.key,
        account: b.dave.account,
    };
    let dave_key = b.d.env.fresh_key();
    b.d.env.name_seat(&dave_key);
    b.d.env
        .open_backing_ticket(&carol, &dave, offer, 9, 500, 4)
        .expect("backing ticket with the requester's seat key");
    let books = b.d.env.books_of(carol.account);
    // staging stays open to anyone
    let stranger = b.d.env.fresh_key();
    b.d.env
        .stage_with(&stranger, &carol, 9, 20, books.clone())
        .expect("anyone stages a Backing Ticket");
    // the Requester's key does not cancel the Backer's Ticket: that is the Backer's, or anyone
    // after the deadline
    let err = b
        .d
        .env
        .cancel_backing_ticket(&dave_key, &carol, 9, Some(offer), books.clone())
        .unwrap_err();
    assert_eq!(custom_code(&err), WALLET_ONLY_NOT_EXPIRED);
    // the backed entry names the Requester's seat key
    let n = b.d.env.counters_next(dave.account);
    let id = b
        .d
        .env
        .open_match_ix(
            &dave,
            500,
            n,
            9,
            false,
            0,
            1,
            ticket_pda(carol.account, 9),
            books,
            Some((offer, carol.account)),
        )
        .expect("backed open");
    let side = b.d.env.mstate(id).inner.a;
    assert_eq!(side.signer, key_of(&dave_key).to_bytes());
    assert_eq!(side.player, dave.account.to_bytes());
    assert_eq!(side.funder, carol.account.to_bytes());
}

#[test]
fn only_the_wallet_or_the_named_seat_key_cancels_an_open_match_at_once() {
    let mut d = duel();
    let ana_key = d.env.fresh_key();
    let ben_key = d.env.fresh_key();
    let stranger = d.env.fresh_key();
    let alice = d.alice.kp.insecure_clone();
    d.env.name_seat(&ana_key);
    let id = d.env.open_match(&d.alice, 500).expect("ana opens");
    d.env.name_seat(&ben_key);
    let ben_open = d.env.open_match(&d.bob, 500).expect("ben opens");

    // a stranger and another Match's seat key are refused
    for wrong in [&stranger, &ben_key] {
        let err = d.env.refund_start(wrong, id).unwrap_err();
        assert_eq!(custom_code(&err), core(CoreError::NotExpired));
    }
    assert_eq!(d.env.mstate(id).inner.stage(), Stage::Open);
    // the seat key refunds Ana's Match at once; Ben's stays
    d.env.refund_keep(&ana_key, id).expect("seat key cancels");
    assert_eq!(d.env.mstate(id).inner.stage(), Stage::Closed);
    assert_eq!(d.env.mstate(ben_open).inner.stage(), Stage::Open);

    // the wallet does it too, with or without a seat key named
    d.env.no_seat();
    let id2 = d.env.open_match(&d.alice, 500).expect("wallet-only open");
    d.env.refund_keep(&alice, id2).expect("wallet cancels");
    d.env.name_seat(&ana_key);
    let id3 = d.env.open_match(&d.alice, 500).expect("named open");
    d.env.refund_keep(&alice, id3).expect("wallet cancels a seat-keyed Match");
    assert_eq!(d.env.mstate(id3).inner.stage(), Stage::Closed);
}

#[test]
fn a_joiners_seat_key_cannot_refund_the_match_it_joined_before_the_deadline() {
    let mut d = duel();
    let ben_key = d.env.fresh_key();
    let id = d.env.open_match(&d.alice, 500).expect("open");
    d.env.name_seat(&ben_key);
    d.env.join_match(&d.bob, id).expect("join");
    let err = d.env.refund_start(&ben_key, id).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NotExpired));
    assert_eq!(d.env.mstate(id).inner.stage(), Stage::Active);
}

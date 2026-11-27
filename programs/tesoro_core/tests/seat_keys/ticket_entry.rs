//! Seat-keys ticket 14: an entry staged in an Entry Ticket costs the wallet one signature. The
//! seat key the wallet named in `open_ticket` alone sends the `open_match` / `join_match` that
//! spends the complete Ticket, when the Ticket is bound to that Match and still in its seat-key
//! window (`matching::require_entry_authority`). Every other entry needs the wallet.

use super::*;
use tesoro_core::pots::{join_target_tag, open_target_tag, SEAT_ENTRY_SECS};

const WALLET_MUST_SIGN: u32 = 6400 + tesoro_core::error::MatchError::WalletMustSign as u32;
const BAD_BACKING: u32 = 6400 + tesoro_core::error::MatchError::BadBacking as u32;
/// Ticket nonces the tests name.
const T: u64 = 5;

/// A Player whose 500 Gemas sit in 25 lines of 20: more than one transaction draws, so the entry
/// is staged in an Entry Ticket.
fn many_lines(env: &mut Env, tag: u8) -> Person {
    let (p, _) = person_with_lines(env, 25, tag, 500);
    p
}

fn clone(p: &Person) -> Person {
    Person {
        kp: p.kp.insecure_clone(),
        key: p.key,
        account: p.account,
    }
}

impl Env {
    /// Opens Entry Ticket `nonce` for 500 naming `seat`, bound to `tag`, and stages it full with the
    /// seat key alone. The wallet signs only `open_ticket`.
    fn staged_ticket(&mut self, p: &Person, nonce: u64, seat: &Keypair, tag: u64) {
        self.name_seat(seat);
        self.ticket_tag = tag;
        self.open_ticket(p, nonce, 500, 26).expect("ticket");
        self.ticket_tag = 0;
        while self.load_ticket_staged(p, nonce) < 500 {
            self.stage_with(seat, p, nonce, 255, vec![])
                .expect("the seat key stages");
        }
    }

    /// The address of the Match `p` opens next.
    fn next_match_key(&self, p: &Person) -> APk {
        let n = self.counters_next(p.account);
        pda(&[MATCH_SEED, p.account.as_ref(), &n.to_le_bytes()])
    }

    /// Entries from now on are paid by a relayer and the wallet does not sign them.
    fn without_wallet(&mut self) {
        let relayer = self.fresh_key();
        self.walletless = Some(relayer);
    }

    fn with_wallet(&mut self) {
        self.walletless = None;
    }
}

#[test]
fn a_complete_entry_ticket_bound_to_its_match_is_spent_by_its_seat_key_alone() {
    let mut d = duel();
    let ana = many_lines(&mut d.env, 70);
    let ana_key = d.env.fresh_key();
    // Ana opens a Match: her wallet signs open_ticket, the seat key does the rest
    let tag = open_target_tag(&d.env.next_match_key(&ana), false, 0);
    d.env.staged_ticket(&ana, T, &ana_key, tag);
    d.env.without_wallet();
    let id = d
        .env
        .open_match_ticket(&ana, 500, T)
        .expect("the seat key alone opens");
    let side = d.env.mstate(id).inner.a;
    assert_eq!(side.player, ana.account.to_bytes());
    assert_eq!(side.signer, key_of(&ana_key).to_bytes());
    assert_eq!(d.env.total_gemas(&ana), 0);
    // the tag's bytes are the Pot's `counted_in` now: nothing counted (no Entry Limit)
    let pot = d
        .env
        .svm
        .get_account(&s(ticket_pda(ana.account, T)))
        .unwrap();
    assert_eq!(tesoro_core::pots::counted_in(&pot.data[8..200]), 0);

    // Ben joins Ana's Match the same way, with his own key and a Ticket bound to that join
    let ben = many_lines(&mut d.env, 110);
    let ben_key = d.env.fresh_key();
    d.env.with_wallet();
    d.env
        .staged_ticket(&ben, T, &ben_key, join_target_tag(&d.env.match_key(id)));
    d.env.without_wallet();
    let nonce = T;
    d.env
        .join_match_ix(&ben, id, nonce, 1, ticket_pda(ben.account, T), vec![], None)
        .expect("the seat key alone joins");
    let b = d.env.mstate(id).inner.b.expect("joined");
    assert_eq!(b.signer, key_of(&ben_key).to_bytes());
    assert_eq!(b.player, ben.account.to_bytes());
}

#[test]
fn the_wallet_still_signs_an_entry_from_a_fresh_pot_or_an_unbound_ticket() {
    let mut d = duel();
    let key = d.env.fresh_key();
    // a direct draw: nothing was approved before, the wallet signs
    d.env.name_seat(&key);
    d.env.without_wallet();
    let err = d.env.open_match(&d.alice, 500).unwrap_err();
    assert_eq!(custom_code(&err), WALLET_MUST_SIGN);
    // the same entry with the wallet: opens
    d.env.with_wallet();
    d.env.open_match(&d.alice, 500).expect("the wallet opens");

    // a Ticket bound to no Match: the wallet signs, as before ticket 14
    let ana = many_lines(&mut d.env, 70);
    d.env.staged_ticket(&ana, T, &key, 0);
    d.env.without_wallet();
    let err = d.env.open_match_ticket(&ana, 500, T).unwrap_err();
    assert_eq!(custom_code(&err), WALLET_MUST_SIGN);
    assert_eq!(d.env.ticket_state(&ana, T), TicketState::Open);
    d.env.with_wallet();
    d.env
        .open_match_ticket(&ana, 500, T)
        .expect("the wallet spends an unbound Ticket");
}

#[test]
fn a_ticket_bound_to_another_match_or_other_terms_needs_the_wallet() {
    let mut d = duel();
    let ana = many_lines(&mut d.env, 70);
    let key = d.env.fresh_key();
    let next = d.env.next_match_key(&ana);
    // bound to a Challenge, opened as a Queue Match; bound to a join, used to open; bound to
    // another Trading Duel asset; bound to the Match after the next one
    let later = {
        let n = d.env.counters_next(ana.account) + 1;
        pda(&[MATCH_SEED, ana.account.as_ref(), &n.to_le_bytes()])
    };
    let wrong = [
        open_target_tag(&next, true, 0),
        join_target_tag(&next),
        open_target_tag(&next, false, 1),
        open_target_tag(&later, false, 0),
    ];
    for (i, tag) in wrong.into_iter().enumerate() {
        let nonce = T + i as u64;
        d.env.with_wallet();
        d.env.staged_ticket(&ana, nonce, &key, tag);
        d.env.without_wallet();
        let err = d.env.open_match_ticket(&ana, 500, nonce).unwrap_err();
        assert_eq!(custom_code(&err), WALLET_MUST_SIGN, "tag {i}");
        d.env.with_wallet();
        let books = d.env.books_of(ana.account);
        while d.env.ticket_state(&ana, nonce) != TicketState::Cancelled {
            d.env
                .cancel_ticket_with(&key, &ana, nonce, 32, books.clone())
                .expect("cancel");
        }
    }

    // a join bound to Ben's Match cannot join Carol's (the stolen-key case: Carol is the thief)
    let ben = clone(&d.bob);
    let (carol, _) = person_with_lines(&mut d.env, 2, 150, 1_000);
    d.env.no_seat();
    let bens = d.env.open_match(&ben, 500).expect("ben opens");
    let carols = d.env.open_match(&carol, 500).expect("carol opens");
    let dan = many_lines(&mut d.env, 190);
    let dan_key = d.env.fresh_key();
    d.env
        .staged_ticket(&dan, T, &dan_key, join_target_tag(&d.env.match_key(bens)));
    d.env.without_wallet();
    let err = d
        .env
        .join_match_ix(&dan, carols, T, 1, ticket_pda(dan.account, T), vec![], None)
        .unwrap_err();
    assert_eq!(custom_code(&err), WALLET_MUST_SIGN);
    assert!(d.env.mstate(carols).inner.b.is_none());
    d.env
        .join_match_ix(&dan, bens, T, 1, ticket_pda(dan.account, T), vec![], None)
        .expect("the Match it was bound to");
}

#[test]
fn only_the_tickets_own_seat_key_for_its_own_account_spends_it() {
    let mut d = duel();
    let ana = many_lines(&mut d.env, 70);
    let ana_key = d.env.fresh_key();
    let other = d.env.fresh_key();
    let tag = open_target_tag(&d.env.next_match_key(&ana), false, 0);
    d.env.staged_ticket(&ana, T, &ana_key, tag);
    d.env.without_wallet();
    // another key co-signs as the seat key
    d.env.name_seat(&other);
    let err = d.env.open_match_ticket(&ana, 500, T).unwrap_err();
    assert_eq!(custom_code(&err), WALLET_MUST_SIGN);
    // Ben, holding Ana's key, names Ana's Ticket as the Pot of his own entry
    let ben = clone(&d.bob);
    d.env.name_seat(&ana_key);
    let n = d.env.counters_next(ben.account);
    let err = d
        .env
        .open_match_ix(
            &ben,
            500,
            n,
            T,
            false,
            0,
            1,
            ticket_pda(ana.account, T),
            vec![],
            None,
        )
        .unwrap_err();
    assert_eq!(custom_code(&err), WALLET_MUST_SIGN);
    assert_eq!(d.env.ticket_state(&ana, T), TicketState::Open);
    // Ana's own key
    d.env
        .open_match_ticket(&ana, 500, T)
        .expect("ana's seat key opens");
}

#[test]
fn the_seat_key_alone_spends_a_ticket_only_within_its_window_and_while_it_is_open() {
    let mut d = duel();
    let ana = many_lines(&mut d.env, 70);
    let key = d.env.fresh_key();
    let tag = open_target_tag(&d.env.next_match_key(&ana), false, 0);
    let t0 = d.env.now();
    d.env.staged_ticket(&ana, T, &key, tag);
    // 15 minutes after open_ticket: the wallet signs again
    d.env.set_time(t0 + SEAT_ENTRY_SECS);
    d.env.without_wallet();
    let err = d.env.open_match_ticket(&ana, 500, T).unwrap_err();
    assert_eq!(custom_code(&err), WALLET_MUST_SIGN);
    d.env.set_time(t0 + SEAT_ENTRY_SECS - 1);
    d.env
        .open_match_ticket(&ana, 500, T)
        .expect("a second before the end of the window");

    // a Ticket being cancelled
    d.env.with_wallet();
    let ben = many_lines(&mut d.env, 110);
    let tag = open_target_tag(&d.env.next_match_key(&ben), false, 0);
    d.env.staged_ticket(&ben, T, &key, tag);
    let books = d.env.books_of(ben.account);
    d.env
        .cancel_ticket_with(&key, &ben, T, 1, books)
        .expect("cancelling");
    assert_eq!(d.env.ticket_state(&ben, T), TicketState::Cancelling);
    d.env.without_wallet();
    let err = d.env.open_match_ticket(&ben, 500, T).unwrap_err();
    assert_eq!(custom_code(&err), WALLET_MUST_SIGN);

    // a Ticket not staged full: the seat key is allowed, the Ticket is not complete
    d.env.with_wallet();
    let carol = many_lines(&mut d.env, 150);
    let tag = open_target_tag(&d.env.next_match_key(&carol), false, 0);
    d.env.name_seat(&key);
    d.env.ticket_tag = tag;
    d.env.open_ticket(&carol, T, 500, 26).expect("ticket");
    d.env.ticket_tag = 0;
    d.env
        .stage_with(&key, &carol, T, 4, vec![])
        .expect("part staged");
    d.env.without_wallet();
    assert!(d.env.open_match_ticket(&carol, 500, T).is_err());
    assert_eq!(d.env.ticket_state(&carol, T), TicketState::Open);
}

#[test]
fn a_backed_entry_and_a_backing_ticket_always_need_the_wallet() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, request, 5_000);
    b.accept(offer, request);
    let carol = clone(&b.carol);
    let dave = clone(&b.dave);
    let dave_key = b.d.env.fresh_key();
    b.d.env.name_seat(&dave_key);
    // a Backing Ticket names no target
    let tag = open_target_tag(&b.d.env.next_match_key(&dave), false, 0);
    b.d.env.ticket_tag = tag;
    let err =
        b.d.env
            .open_backing_ticket(&carol, &dave, offer, 9, 500, 4)
            .unwrap_err();
    assert_eq!(custom_code(&err), BAD_BACKING);
    b.d.env.ticket_tag = 0;
    b.d.env
        .open_backing_ticket(&carol, &dave, offer, 9, 500, 4)
        .expect("backing ticket");
    let books = b.d.env.books_of(carol.account);
    let anyone = b.d.env.fresh_key();
    b.d.env
        .stage_with(&anyone, &carol, 9, 20, books.clone())
        .expect("staged");
    // the backed open signed by the Requester's seat key alone: refused
    b.d.env.without_wallet();
    let n = b.d.env.counters_next(dave.account);
    let err =
        b.d.env
            .open_match_ix(
                &dave,
                500,
                n,
                9,
                false,
                0,
                1,
                ticket_pda(carol.account, 9),
                books.clone(),
                Some((offer, carol.account)),
            )
            .unwrap_err();
    assert_eq!(custom_code(&err), WALLET_MUST_SIGN);
    // and the Backing Ticket named without its Offer, as if it were an Entry Ticket: refused
    let err =
        b.d.env
            .open_match_ix(
                &dave,
                500,
                n,
                9,
                false,
                0,
                1,
                ticket_pda(carol.account, 9),
                books.clone(),
                None,
            )
            .unwrap_err();
    assert_eq!(custom_code(&err), WALLET_MUST_SIGN);
    // the wallet signs the backed open
    b.d.env.with_wallet();
    b.d.env
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
        .expect("backed open with the wallet");
}

#[test]
fn a_wallet_that_signs_but_does_not_pay_still_enters() {
    // the sponsored shape: the relayer pays, the wallet signs as `player_authority` only
    let mut d = duel();
    let key = d.env.fresh_key();
    d.env.name_seat(&key);
    let relayer = d.env.fresh_key();
    let n = d.env.counters_next(d.alice.account);
    let nonce = d.env.next_ticket(d.alice.account);
    let pot = ticket_pda(d.alice.account, nonce);
    let books = d.env.books_of(d.alice.account);
    d.env.walletless = Some(relayer.insecure_clone());
    d.env.wallet_cosigns = true;
    d.env
        .open_match_ix(
            &clone(&d.alice),
            500,
            n,
            nonce,
            false,
            0,
            4,
            pot,
            books,
            None,
        )
        .expect("the wallet signs as the Player, the relayer pays");
}

#[test]
fn target_tags_match_the_app() {
    // the same vectors as app/src/lib/chain/ticket-target.test.ts
    let key = APk::new_from_array([7; 32]);
    assert_eq!(open_target_tag(&key, true, 2), 9_885_216_746_269_472_129);
    assert_eq!(join_target_tag(&key), 14_060_664_597_131_761_704);
}

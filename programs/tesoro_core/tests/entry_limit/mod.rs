//! Railcar ticket 17: Gemas counted on an Entry Limit that come back unplayed are given back to the
//! period they counted in, while it is current. Head-to-head and Offers here; Railcar seats in
//! `many_seat/backing.rs`.

use super::*;
use tesoro_core::error::MatchError;

fn match_code(e: MatchError) -> u32 {
    6400 + e as u32
}

impl Backing {
    fn cancel_offer_ix(&self, offer: APk, request: Option<APk>, with_limit: bool) -> Instruction {
        ix(
            accounts::CancelOffer {
                backer_authority: self.carol.key,
                backer_account: self.carol.account,
                basket: basket_address(&self.carol.account).0,
                spill: spill_address(&self.carol.account).0,
                counters: counters_pda(self.carol.account),
                offer,
                request,
                backer_protections: with_limit.then(|| protections_pda(self.carol.account)),
            },
            instruction::CancelOffer {},
            vec![],
        )
    }

    fn cancel_offer(
        &mut self,
        offer: APk,
        with_limit: bool,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let i = self.cancel_offer_ix(offer, None, with_limit);
        let carol = self.carol.kp.insecure_clone();
        self.d.env.send(&[i], &carol, &[])
    }

    fn expire_offer(
        &mut self,
        offer: APk,
        with_limit: bool,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let i = ix(
            accounts::ExpireOffer {
                caller: a(self.d.env.admin.pubkey()),
                backer_account: self.carol.account,
                basket: basket_address(&self.carol.account).0,
                spill: spill_address(&self.carol.account).0,
                counters: counters_pda(self.carol.account),
                offer,
                request: None,
                backer_protections: with_limit.then(|| protections_pda(self.carol.account)),
            },
            instruction::ExpireOffer {},
            vec![],
        );
        let admin = self.d.env.admin.insecure_clone();
        self.d.env.send(&[i], &admin, &[])
    }

    fn carol_used(&self) -> u64 {
        self.d.env.entry_limit(&self.carol).used(self.d.env.now())
    }

    fn counted_in(&self, offer: APk) -> i64 {
        self.d.env.load::<OfferState>(offer).inner.counted_in
    }
}

impl Env {
    /// `close_match` without the funders' Protections.
    fn close_match_bare(
        &mut self,
        id: u64,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let payer = self.admin.insecure_clone();
        let m = self.mstate(id).inner;
        let limits: Vec<Pk> = [Some(m.a), m.b]
            .into_iter()
            .flatten()
            .map(|p| s(protections_pda(APk::new_from_array(p.funder))))
            .collect();
        let mut i = self.close_match_ix(a(payer.pubkey()), id);
        i.accounts.retain(|m| !limits.contains(&m.pubkey));
        self.send(&[i], &payer, &[])
    }

    fn used(&self, p: &Person) -> u64 {
        self.entry_limit(p).used(self.now())
    }
}

#[test]
fn bobs_withdrawn_offer_gives_his_entry_limit_back() {
    // Carol is the walk-through's Bob: a limit of 1,000, a 500 Offer counted when made
    let mut b = backing_setup();
    b.d.env.set_entry_limit(&b.carol, 1_000).unwrap();
    let request = b.request(1, 500);
    let offer = b.offer(1, request, 5_000);
    assert_eq!(b.carol_used(), 500);
    assert_ne!(
        b.counted_in(offer),
        0,
        "the Offer keeps the period it counted in"
    );
    // nobody can withdraw it and skip the give-back
    let err = b.cancel_offer(offer, false).unwrap_err();
    assert_eq!(custom_code(&err), match_code(MatchError::AccountMissing));
    b.cancel_offer(offer, true).expect("withdraw");
    assert_eq!(b.carol_used(), 0);
    assert_eq!(b.counted_in(offer), 0);
    // the whole 1,000 is hers again this period
    b.offer(2, request, 5_000);
    b.offer(3, request, 5_000);
    assert_eq!(b.carol_used(), 1_000);
    let more = b.offer_ix(4, request, 5_000);
    let carol = b.carol.kp.insecure_clone();
    let err = b.d.env.send(&[more], &carol, &[]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
}

#[test]
fn an_expired_offer_gives_back_its_count_but_not_into_a_later_period() {
    let mut b = backing_setup();
    b.d.env.set_entry_limit(&b.carol, 1_000).unwrap();
    let t = b.d.env.now();
    let first = {
        let r = b.request(1, 500);
        b.offer(1, r, 5_000)
    };
    b.d.env.set_time(t + DAY + 1);
    let err = b.expire_offer(first, false).unwrap_err();
    assert_eq!(custom_code(&err), match_code(MatchError::AccountMissing));
    b.expire_offer(first, true).expect("expire");
    assert_eq!(b.carol_used(), 0);

    // an Offer counted in this period, expired after the period rolled over
    let stale = {
        let r = b.request(2, 500);
        b.offer(2, r, 5_000)
    };
    assert_eq!(b.carol_used(), 500);
    b.d.env.set_time(t + 7 * DAY + 1);
    {
        let r = b.request(3, 500);
        b.offer(3, r, 5_000)
    };
    assert_eq!(
        b.carol_used(),
        500,
        "the new period counted only the new Offer"
    );
    b.expire_offer(stale, true).expect("expire the stale Offer");
    assert_eq!(
        b.carol_used(),
        500,
        "the new period never counted the stale one"
    );
    assert_eq!(b.counted_in(stale), 0);
}

#[test]
fn a_refunded_match_gives_the_players_entry_back_and_needs_their_protections() {
    let mut d = duel();
    d.env.set_entry_limit(&d.alice, 1_000).unwrap();
    let m = d.env.open_match(&d.alice, 500).expect("open");
    assert_eq!(d.env.used(&d.alice), 500);
    // nobody joins; Alice cancels it
    let alice = d.alice.kp.insecure_clone();
    d.env.refund_start(&alice, m).expect("cancel");
    d.env.run_chunks(m);
    assert_eq!(
        d.env.used(&d.alice),
        500,
        "given back when the Match closes"
    );
    let err = d.env.close_match_bare(m).unwrap_err();
    assert_eq!(custom_code(&err), match_code(MatchError::AccountMissing));
    d.env.close_match(m).expect("close");
    assert_eq!(d.env.used(&d.alice), 0);
    assert_eq!(d.env.total_gemas(&d.alice), 75_000);
    // and the 1,000 is hers again
    d.env.open_match(&d.alice, 500).expect("open");
    d.env.open_match(&d.alice, 500).expect("open");
}

#[test]
fn a_table_refund_gives_back_both_sides_the_backer_and_the_player() {
    // Alice opens with her own 500; Dave joins with Carol's Backing; the table refunds it
    let mut b = backing_setup();
    b.d.env.set_entry_limit(&b.d.alice, 1_000).unwrap();
    b.d.env.set_entry_limit(&b.carol, 1_000).unwrap();
    b.d.env.set_entry_limit(&b.dave, 1).unwrap();
    let request = b.request(1, 500);
    let offer = b.offer(1, request, 5_000);
    b.accept(offer, request);
    let m = b.d.env.open_match(&b.d.alice, 500).expect("open");
    b.join_backed(offer, m).expect("backed join");
    assert_eq!(b.counted_in(offer), 0, "the count moved to the Pot");
    assert_eq!(b.carol_used(), 500);
    assert_eq!(b.d.env.used(&b.d.alice), 500);
    let game = b.d.env.game_auth.insecure_clone();
    b.d.env.refund_start(&game, m).expect("table refund");
    b.d.env.finish_run(m);
    assert_eq!(b.carol_used(), 0);
    assert_eq!(b.d.env.used(&b.d.alice), 0);
    assert_eq!(
        b.d.env.used(&b.dave),
        0,
        "the backed Player was never counted"
    );
}

#[test]
fn a_backed_match_nobody_joins_gives_the_backers_entry_back() {
    let mut b = backing_setup();
    b.d.env.set_entry_limit(&b.carol, 1_000).unwrap();
    let request = b.request(1, 500);
    let offer = b.offer(1, request, 5_000);
    b.accept(offer, request);
    let m = b.open_backed(offer, 500).expect("backed open");
    let now = b.d.env.now();
    b.d.env.set_time(now + 3_601);
    let stranger = b.d.env.admin.insecure_clone();
    b.d.env.refund_start(&stranger, m).expect("abandoned");
    b.d.env.finish_run(m);
    assert_eq!(b.carol_used(), 0);
    assert_eq!(b.d.env.total_gemas(&b.carol), 75_000);
}

#[test]
fn played_entries_are_never_given_back() {
    let mut d = duel();
    d.env.set_entry_limit(&d.alice, 2_000).unwrap();
    d.env.set_entry_limit(&d.bob, 2_000).unwrap();
    let game = d.env.game_auth.insecure_clone();
    for result in [MatchResult::Draw, MatchResult::NoShow, MatchResult::Opener] {
        let m = d.env.open_match(&d.alice, 500).expect("open");
        d.env.join_match(&d.bob, m).expect("join");
        d.env.settle(&game, m, result, vec![]).expect("settle");
    }
    assert_eq!(d.env.used(&d.alice), 1_500);
    assert_eq!(d.env.used(&d.bob), 1_500);
}

#[test]
fn a_refund_closed_after_the_period_rolled_over_gives_nothing_back() {
    let mut d = duel();
    d.env.set_entry_limit(&d.alice, 1_000).unwrap();
    let t = d.env.now();
    let m = d.env.open_match(&d.alice, 500).expect("open");
    let alice = d.alice.kp.insecure_clone();
    d.env.refund_keep(&alice, m).expect("cancel");
    // the Match is closed only after a new period has counted another entry
    d.env.set_time(t + 7 * DAY + 1);
    d.env.open_match(&d.alice, 500).expect("open");
    assert_eq!(d.env.used(&d.alice), 500);
    d.env.close_match(m).expect("close");
    assert_eq!(d.env.used(&d.alice), 500);
}

#[test]
fn an_offer_of_the_old_layout_grows_and_then_gives_nothing_back() {
    let mut b = backing_setup();
    b.d.env.set_entry_limit(&b.carol, 1_000).unwrap();
    let request = b.request(1, 500);
    let offer = b.offer(1, request, 5_000);
    // an Accepted Offer fills its Player slot, so the old 174 bytes hold no room for the period
    b.accept(offer, request);
    // as the program before ticket 17 left it: 174 bytes, no period
    let mut old = b.d.env.svm.get_account(&s(offer)).expect("offer");
    old.data.truncate(OfferState::SPACE_V1);
    b.d.env.svm.set_account(s(offer), old).expect("old Offer");
    let withdraw = |b: &mut Backing| {
        let i = b.cancel_offer_ix(offer, Some(request), true);
        let carol = b.carol.kp.insecure_clone();
        b.d.env.send(&[i], &carol, &[])
    };
    assert!(withdraw(&mut b).is_err(), "unreadable until grown");

    let grow = |b: &mut Backing| {
        let payer = b.d.env.admin.insecure_clone();
        let i = ix(
            accounts::GrowOffer {
                payer: a(payer.pubkey()),
                offer,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::GrowOffer {},
            vec![],
        );
        b.d.env.send(&[i], &payer, &[])
    };
    grow(&mut b).expect("grow");
    let acc = b.d.env.svm.get_account(&s(offer)).expect("offer");
    assert_eq!(acc.data.len(), OfferState::SPACE);
    assert_eq!(b.counted_in(offer), 0);
    grow(&mut b).expect("a grown Offer is left alone");
    // it withdraws as before; its period was never stored, so nothing is given back
    withdraw(&mut b).expect("withdraw");
    assert_eq!(b.carol_used(), 500);
    assert_eq!(b.reserved(), 0);
}

#[test]
fn an_open_offer_of_the_old_layout_reads_as_counting_nothing() {
    // an Open Offer leaves its 32-byte Player slot unused: the old 174 bytes read `counted_in` 0
    let mut b = backing_setup();
    b.d.env.set_entry_limit(&b.carol, 1_000).unwrap();
    let request = b.request(1, 500);
    let offer = b.offer(1, request, 5_000);
    let mut old = b.d.env.svm.get_account(&s(offer)).expect("offer");
    old.data.truncate(OfferState::SPACE_V1);
    old.data[OfferState::SPACE_V1 - 32..].fill(0);
    b.d.env.svm.set_account(s(offer), old).expect("old Offer");
    b.cancel_offer(offer, true).expect("withdraw");
    assert_eq!(b.carol_used(), 500, "its period was never stored");
    assert_eq!(b.reserved(), 0);
}

#[test]
fn a_pot_made_from_a_ticket_records_its_own_count_whatever_the_ticket_held() {
    const COUNTED_AT: usize = DISC + 184;
    let mut d = duel();
    let kp = d.alice.kp.insecure_clone();
    let open = |d: &mut Duel, nonce: u64| -> APk {
        d.env.open_ticket(&d.alice, nonce, 500, 4).expect("ticket");
        while d.env.load_ticket_staged(&d.alice, nonce) < 500 {
            let books = d.env.books_of(d.alice.account);
            d.env
                .stage_with(&kp, &d.alice, nonce, 255, books)
                .expect("stage");
        }
        // whatever a Ticket's head held at those bytes
        let pot = ticket_pda(d.alice.account, nonce);
        let mut acc = d.env.svm.get_account(&s(pot)).expect("ticket");
        acc.data[COUNTED_AT..COUNTED_AT + 8].fill(0xAB);
        d.env.svm.set_account(s(pot), acc).expect("dirty head");
        d.env.open_match_ticket(&d.alice, 500, nonce).expect("open");
        pot
    };
    let counted = |d: &Duel, pot: APk| {
        let data = d.env.svm.get_account(&s(pot)).expect("pot").data;
        i64::from_le_bytes(data[COUNTED_AT..COUNTED_AT + 8].try_into().unwrap())
    };
    // no Entry Limit in force: the Pot says nothing was counted
    let pot = open(&mut d, 50);
    assert_eq!(counted(&d, pot), 0);
    // with one: the period it counted in
    d.env.set_entry_limit(&d.alice, 1_000).unwrap();
    let pot = open(&mut d, 51);
    let window = d.env.entry_limit(&d.alice).window_start;
    assert_ne!(window, 0);
    assert_eq!(counted(&d, pot), window);
}

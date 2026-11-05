//! Backing a seat of a many-seat Match (Railcar ticket 04), against the built program: a Backer
//! funds one seat through an accepted Offer; refunds and the entry go back to the Backer, a place's
//! winnings split by the Offer's share, the Player never risks a Gema of their own.

use super::settle::{result, ANA, BEN, CY, DEE, EVE};
use super::*;
use tesoro_core::error::MatchError;
use tesoro_core::ledger::many_seat::SeatState;
use tesoro_core::ledger::OfferStatus;

/// The share of a backed seat's winnings that goes to its Player.
const SHARE: u16 = 4_000;

impl Env {
    /// `player` asks to be backed for the test Game at the car's entry; `backer` offers `share`;
    /// `player` accepts. Returns the Offer.
    fn backing(&mut self, player: &Person, backer: &Person, nonce: u64, share: u16) -> APk {
        let request = request_pda(player.account, nonce);
        let offer = offer_pda(backer.account, nonce);
        let ask = ix(
            accounts::CreateRequest {
                player_authority: player.key,
                config: pda(&[CONFIG_SEED]),
                game_record: common::game_record(GAME),
                player_account: player.account,
                protections: protections_pda(player.account),
                request,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::CreateRequest {
                nonce,
                game: GAME,
                entry: CAR_ENTRY,
            },
            vec![],
        );
        self.send(&[ask], &player.kp.insecure_clone(), &[])
            .expect("request");
        let make = ix(
            accounts::CreateOffer {
                backer_authority: backer.key,
                config: pda(&[CONFIG_SEED]),
                request,
                game_record: common::game_record(GAME),
                backer_account: backer.account,
                protections: protections_pda(backer.account),
                basket: basket_address(&backer.account).0,
                spill: spill_address(&backer.account).0,
                counters: counters_pda(backer.account),
                offer,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::CreateOffer {
                nonce,
                player_share_bps: share,
            },
            vec![],
        );
        self.send(&[make], &backer.kp.insecure_clone(), &[])
            .expect("offer");
        let accept = ix(
            accounts::AcceptOffer {
                player_authority: player.key,
                player_account: player.account,
                protections: protections_pda(player.account),
                request,
                offer,
            },
            instruction::AcceptOffer {},
            vec![],
        );
        self.send(&[accept], &player.kp.insecure_clone(), &[])
            .expect("accept");
        offer
    }

    /// `player` boards with `backer`'s Gemas, staged first in the Backing Ticket of `offer`.
    fn board_backed(
        &mut self,
        player: &Person,
        backer: &Person,
        offer: APk,
        car: Car,
    ) -> Result<u8, litesvm::types::FailedTransactionMetadata> {
        self.board_backed_keyed(player, backer, offer, car, None)
    }

    /// As `board_backed`, naming `seat_key` as the Player's seat key.
    fn board_backed_keyed(
        &mut self,
        player: &Person,
        backer: &Person,
        offer: APk,
        car: Car,
        seat_key: Option<&Keypair>,
    ) -> Result<u8, litesvm::types::FailedTransactionMetadata> {
        let join = self.backed_join_ix(player, backer, offer, car, seat_key);
        let kp = player.kp.insecure_clone();
        match seat_key {
            Some(k) => self.send_v0_with(&[cu_limit(1_400_000), join], &kp, &[k])?,
            None => self.send_v0(&[cu_limit(1_400_000), join], &kp)?,
        };
        println!("backed join: {} CU", self.last_cu);
        Ok(self.mark(car, player).expect("mark").seat)
    }

    /// The open Backing Ticket `offer` opened, if any: its nonce.
    fn ticket_of(&self, backer: &Person, offer: APk) -> Option<u64> {
        let want = self.load::<OfferState>(offer).nonce;
        (0..self.next_ticket(backer.account)).find(|&n| {
            self.svm
                .get_account(&s(ticket_pda(backer.account, n)))
                .filter(|acc| acc.data.len() > tesoro_core::pots::POT_AT)
                .is_some_and(|acc| {
                    let head = &acc.data[8..];
                    head[2] == 1 && head[3] == 0 && head[184..192] == want.to_le_bytes()
                })
        })
    }

    /// `player` opens the Backing Ticket of `offer` (as they would with the accept) and anyone
    /// stages it until it holds the entry. Returns its nonce; an open one is used as it is.
    fn stage_backing(&mut self, player: &Person, backer: &Person, offer: APk) -> u64 {
        if let Some(n) = self.ticket_of(backer, offer) {
            return n;
        }
        let nonce = self.next_ticket(backer.account);
        self.open_backing_ticket(backer, player, offer, nonce, CAR_ENTRY, 20)
            .expect("open the Backing Ticket");
        let mut books = vec![];
        for src in self.sources_in(backer.account) {
            books.extend(book_metas(&self.svm, src));
        }
        let anyone = self.admin.insecure_clone();
        while self.load_ticket_staged(backer, nonce) < CAR_ENTRY {
            self.stage_with(&anyone, backer, nonce, 255, books.clone())
                .expect("stage");
        }
        nonce
    }

    /// The Backed join: its Pot is the complete Backing Ticket, so it names no books.
    fn backed_join_ix(
        &mut self,
        player: &Person,
        backer: &Person,
        offer: APk,
        car: Car,
        seat_key: Option<&Keypair>,
    ) -> Instruction {
        let named = seat_key.map_or(player.key, |k| a(k.pubkey()));
        let page = self.page_with_room(car);
        let nonce = self.stage_backing(player, backer, offer);
        self.join_ix(
            player,
            car,
            page,
            (nonce, 20, ticket_pda(backer.account, nonce)),
            vec![],
            (Some((offer, backer.account)), named),
        )
    }

    fn offer_status(&self, offer: APk) -> OfferStatus {
        self.load::<OfferState>(offer).inner.status
    }

    /// Gemas of `p`'s basket held back for their Offers.
    fn reserved_of(&self, p: &Person) -> u64 {
        let d = self
            .svm
            .get_account(&s(basket_address(&p.account).0))
            .expect("basket")
            .data;
        tesoro_core::ledger::line_store::LineStore::new(&d[DISC..])
            .expect("store")
            .reserved_total()
    }
}

#[test]
fn a_backer_funds_the_seat_and_only_the_backers_limit_counts_the_entry() {
    let mut env = Env::new();
    let opener = env.rider(2_000);
    let (ben, bob) = (env.person(), env.rider(2_000));
    env.set_entry_limit(&ben, 1).expect("Ben's limit");
    env.set_entry_limit(&bob, 1_000).expect("Bob's limit");
    let offer = env.backing(&ben, &bob, 1, SHARE);
    assert_eq!(
        env.entry_limit(&bob).window_used,
        500,
        "counted at the Offer"
    );
    assert_eq!(env.reserved_of(&bob), 500);
    let car = env.open_car(&opener, (2, 10));
    let seat = env.board_backed(&ben, &bob, offer, car).expect("backed");

    let st = env.page(car, 0).seats[seat as usize];
    assert_eq!(st.player(), ben.account.to_bytes());
    assert_eq!(st.funder(), bob.account.to_bytes());
    assert_eq!(st.share_bps(), SHARE);
    assert_eq!(env.total_gemas(&ben), 0);
    assert_eq!(env.total_gemas(&bob), 1_500);
    assert_eq!(
        env.reserved_of(&bob),
        0,
        "the reserved Gemas are in the Pot"
    );
    assert_eq!(env.offer_status(offer), OfferStatus::Consumed);
    // nothing counted twice, nothing on the Player
    assert_eq!(env.entry_limit(&ben).window_used, 0);
    assert_eq!(env.entry_limit(&bob).window_used, 500);
    assert_eq!(env.counters(ben.account).open_matches, 1);
    assert_eq!(env.counters(bob.account).open_offers, 0);
    // both are in this car: the Player's mark and the Backer's
    assert_eq!(env.mark(car, &ben).expect("Ben's mark").seat, seat);
    assert_eq!(env.mark(car, &bob).expect("Bob's mark").seat, seat);
}

/// The worked example with four of its five seats backed: Ana's early refund, Ben's second
/// place, Dee's first place and Eve's lost seat are each funded by a Backer; Cy plays his own.
#[test]
fn backed_seats_settle_the_worked_example_to_the_backers_and_the_players_shares() {
    let mut env = Env::new();
    env.enable_leaderboard(100);
    let players: Vec<Person> = (0..5)
        .map(|i| {
            if i == CY {
                env.rider(2_000)
            } else {
                env.person()
            }
        })
        .collect();
    let backers: Vec<Option<Person>> = (0..5)
        .map(|i| (i != CY).then(|| env.rider(2_000)))
        .collect();
    let car = env.open_car(&players[ANA], (5, 100));
    for (i, p) in players.iter().enumerate() {
        match &backers[i] {
            Some(b) => {
                let offer = env.backing(p, b, 1, SHARE);
                env.board_backed(p, b, offer, car).expect("backed");
            }
            None => {
                env.board(p, car).expect("board");
            }
        }
    }
    let studio = env.studio.kp.insecure_clone();
    let studio_account = env.studio.account;
    env.ensure_spill(&studio, studio_account, 16);
    env.depart(car).expect("depart");
    env.settle_car(car, result(&[(3, 6000), (1, 2500), (2, 1500)], &[(0, 350)]))
        .expect("settle");
    // Points follow the Player: Dee won, her Backer funded it
    let won: Vec<MatchWon> = env.started();
    let dee_backer = backers[DEE].as_ref().expect("Dee's Backer");
    assert_eq!(won[0].player, players[DEE].account);
    assert_eq!(won[0].funder, dee_backer.account);
    assert_eq!(won[0].loser, players[BEN].account);
    assert_eq!(won[0].points, 5);
    env.run_car(car);

    let gemas = |env: &Env, p: Option<&Person>| p.map_or(0, |p| env.total_gemas(p));
    // Ana jumped early: her Backer gets the 350 refund, Ana nothing
    assert_eq!(gemas(&env, backers[ANA].as_ref()), 1_500 + 350);
    assert_eq!(env.total_gemas(&players[ANA]), 0);
    // Ben second: 630 = Backer's 500 back, then the 130 split 40/60 (52 to Ben, 78 to the Backer)
    assert_eq!(gemas(&env, backers[BEN].as_ref()), 1_500 + 500 + 78);
    assert_eq!(env.total_gemas(&players[BEN]), 52);
    // Cy unbacked third: 578
    assert_eq!(env.total_gemas(&players[CY]), 1_500 + 578);
    // Dee first: 813 = 500 back, then 313 split (125 to Dee, 188 to the Backer)
    assert_eq!(gemas(&env, backers[DEE].as_ref()), 1_500 + 500 + 188);
    assert_eq!(env.total_gemas(&players[DEE]), 125);
    // Eve aboard at Impact: her Backer lost the 500, Eve lost nothing of her own
    assert_eq!(gemas(&env, backers[EVE].as_ref()), 1_500);
    assert_eq!(env.total_gemas(&players[EVE]), 0);

    // every seat closes with both of its marks; nobody keeps an open Match
    env.close_paid_car(car);
    for (p, b) in players.iter().zip(&backers) {
        assert_eq!(env.counters(p.account).open_matches, 0);
        assert!(env.mark(car, p).is_none());
        if let Some(b) = b {
            assert!(
                env.svm
                    .get_account(&s(mark_pda(car.key, b.account)))
                    .is_none_or(|a| a.lamports == 0),
                "the Backer's mark closed"
            );
        }
    }
}

#[test]
fn a_backer_funds_one_seat_per_car_and_cannot_ride_in_it() {
    let mut env = Env::new();
    let opener = env.rider(2_000);
    let (ben, cy, bob) = (env.person(), env.person(), env.rider(2_000));
    let for_ben = env.backing(&ben, &bob, 1, SHARE);
    let for_cy = env.backing(&cy, &bob, 2, SHARE);
    let car = env.open_car(&opener, (2, 10));
    env.board_backed(&ben, &bob, for_ben, car).expect("Ben");
    let err = env.board_backed(&cy, &bob, for_cy, car).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::AlreadySeated));
    assert_eq!(env.offer_status(for_cy), OfferStatus::Accepted, "unused");
    assert!(env.ticket_of(&bob, for_cy).is_some(), "its Ticket waits");
    let err = env.board(&bob, car).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::AlreadySeated));
    // a rider of the car cannot fund another seat in it either
    let (dee, fay) = (env.rider(2_000), env.person());
    let for_fay = env.backing(&fay, &dee, 3, SHARE);
    env.board(&dee, car).expect("Dee rides");
    let err = env.board_backed(&fay, &dee, for_fay, car).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::AlreadySeated));
    // the same Offer boards the next car
    let car2 = env.open_car(&opener, (2, 10));
    env.board_backed(&cy, &bob, for_cy, car2).expect("next car");
    assert_eq!(env.car(car).inner.seated, 2);
}

#[test]
fn only_a_listed_games_car_can_be_backed() {
    let mut env = Env::new();
    let opener = env.rider(2_000);
    let (ben, bob) = (env.rider(2_000), env.rider(2_000));
    let offer = env.backing(&ben, &bob, 1, SHARE);
    // the Game is upgraded and not approved again: its cars open unlisted
    common::set_program_data(
        &mut env.svm,
        s(GAME),
        Some(env.game_ctl.pubkey()),
        GAME_SLOT + 1,
    );
    let car = env.open_car(&opener, (2, 10));
    let err = env.board_backed(&ben, &bob, offer, car).unwrap_err();
    assert_eq!(
        custom_code(&err),
        anchor_code(tesoro_core::error::TesoroError::GameNotListed)
    );
    assert_eq!(env.offer_status(offer), OfferStatus::Accepted);
    assert!(env.ticket_of(&bob, offer).is_some(), "its Ticket waits");
    // the same Player rides it with his own Gemas
    env.board(&ben, car).expect("unbacked");
}

#[test]
fn an_away_backer_or_player_cannot_board_a_backed_seat() {
    let mut env = Env::new();
    let opener = env.rider(2_000);
    let (ben, bob) = (env.person(), env.rider(2_000));
    let offer = env.backing(&ben, &bob, 1, SHARE);
    let car = env.open_car(&opener, (2, 10));
    env.set_break(&bob, 1).expect("Bob's Break");
    assert!(env.board_backed(&ben, &bob, offer, car).is_err());
    let (cy, dot) = (env.person(), env.rider(2_000));
    let offer = env.backing(&cy, &dot, 2, SHARE);
    env.set_break(&cy, 1).expect("Cy's Break");
    assert!(env.board_backed(&cy, &dot, offer, car).is_err());
    assert_eq!(env.car(car).inner.seated, 0);
}

#[test]
fn stepping_off_a_backed_seat_sends_the_entry_home_to_the_backer() {
    let mut env = Env::new();
    let opener = env.rider(2_000);
    let ben = env.rider(2_000);
    // Bob's 500 are ten lines of ten Sources: more than one step-off moves
    let bob = env.person();
    let sources: Vec<APk> = (0..10).map(|i| env.forge_source(70 + i as u8, 0)).collect();
    env.give_lines(&bob, &sources, 50, |i| i as i64);
    let offer = env.backing(&ben, &bob, 1, SHARE);
    let car = env.open_car(&opener, (2, 10));
    let seat = env.board_backed(&ben, &bob, offer, car).expect("backed");
    assert_eq!(env.total_gemas(&bob), 0);

    // the Backer's mark is not the seat's Player: it cannot stand in for Ben's
    let mut wrong = env.step_off_ix(ben.key, car, &ben, 8, false);
    wrong.accounts[3].pubkey = s(mark_pda(car.key, bob.account));
    wrong.accounts[5].pubkey = s(counters_pda(bob.account));
    wrong.accounts[6].pubkey = s(protections_pda(bob.account));
    let err = env.send_v0(&[wrong], &ben.kp.insecure_clone()).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::WrongSeat));

    let kp = ben.kp.insecure_clone();
    let i = env.step_off_ix(ben.key, car, &ben, 8, false);
    env.send_v0(&[i], &kp).expect("step off");
    assert_eq!(env.car(car).inner.seated, 0);
    assert_eq!(
        env.page(car, 0).seats[seat as usize].state(),
        SeatState::Empty
    );
    // Ben is free at once: his mark closed and he holds no open Match
    assert!(env.mark(car, &ben).is_none());
    assert_eq!(env.counters(ben.account).open_matches, 0);
    // Bob's mark carries the rest of his lines home; until then he cannot board this car
    let mark = env.mark(car, &bob).expect("Bob's return");
    assert_eq!((mark.returning, mark.funder), (1, bob.account.to_bytes()));
    assert_eq!(env.total_gemas(&bob), 8 * 50);
    let err = env.board(&bob, car).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::StillReturning));
    let other = opener.kp.insecure_clone();
    env.return_rest(&other, car, &bob, 8).expect("rest");
    assert!(env.mark(car, &bob).is_none());
    assert_eq!(env.total_gemas(&bob), 500);
    assert_eq!(env.total_gemas(&ben), 2_000);
    // the Backing was used: the Offer stays spent and nothing is reserved
    assert_eq!(env.offer_status(offer), OfferStatus::Consumed);
    assert_eq!(env.reserved_of(&bob), 0);
    // Ben boards again with his own Gemas
    env.board(&ben, car).expect("Ben again");
}

#[test]
fn an_unbacked_step_off_ignores_a_funder_mark_passed_with_it() {
    let (mut env, car, riders) = seated_car(3, (2, 10));
    let (ana, ben) = (&riders[0], &riders[1]);
    let mut i = env.step_off_ix(ben.key, car, ben, 8, false);
    // `funder_mark` is the last named account: pass Ana's live mark there
    i.accounts[13] = AccountMeta::new(s(mark_pda(car.key, ana.account)), false);
    env.send_v0(&[i], &ben.kp.insecure_clone())
        .expect("step off");
    assert!(env.mark(car, ben).is_none());
    assert_eq!(env.total_gemas(ben), 2_000);
    assert_eq!(env.mark(car, ana).expect("Ana's mark").returning, 0);
    assert_eq!(env.car(car).inner.seated, 2);
}

#[test]
fn a_backed_seat_steps_off_with_its_seat_key_and_the_return_lands_on_the_backer() {
    let mut env = Env::new();
    let opener = env.rider(2_000);
    let ben = env.rider(2_000);
    let bob = env.person();
    let sources: Vec<APk> = (0..10).map(|i| env.forge_source(70 + i as u8, 0)).collect();
    env.give_lines(&bob, &sources, 50, |i| i as i64);
    let offer = env.backing(&ben, &bob, 1, SHARE);
    let car = env.open_car(&opener, (2, 10));
    let key = env.fresh_key();
    let stranger = env.fresh_key();
    env.board_backed_keyed(&ben, &bob, offer, car, Some(&key))
        .expect("backed with a key");
    // a stranger cannot step Ben off
    let i = env.step_off_ix(a(stranger.pubkey()), car, &ben, 8, false);
    let err = env.send_v0(&[i], &stranger).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::NotYourSeat));
    // the seat key steps off; the lines land on the Backer's mark
    let i = env.step_off_ix(a(key.pubkey()), car, &ben, 8, false);
    env.send_v0(&[i], &key).expect("seat key steps off");
    assert!(env.mark(car, &ben).is_none());
    let mark = env.mark(car, &bob).expect("Bob's return");
    assert_eq!((mark.returning, mark.funder), (1, bob.account.to_bytes()));
    assert_eq!(env.total_gemas(&bob), 8 * 50);
    let other = opener.kp.insecure_clone();
    env.return_rest(&other, car, &bob, 8).expect("rest");
    assert_eq!(env.total_gemas(&bob), 500);
    assert_eq!(env.total_gemas(&ben), 2_000);
}

/// The compute unit price instruction the sponsor puts in front of what it sends.
fn cu_price(micro_lamports: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&micro_lamports.to_le_bytes());
    Instruction {
        program_id: "ComputeBudget111111111111111111111111111111"
            .parse()
            .expect("compute budget program"),
        accounts: vec![],
        data,
    }
}

/// What the sponsor sends: the relayer pays, the Player's wallet and the seat key co-sign, with the
/// compute limit and price the sponsor puts in front. It must fit with no lookup table at all (the
/// sponsor's table is optional). Bob's 500 come from 4 Sources.
#[test]
fn the_sponsored_backed_join_with_a_seat_key_fits_a_transaction_with_no_table() {
    use solana_sdk::message::{v0, VersionedMessage};
    let mut env = Env::new();
    let opener = env.rider(2_000);
    let ben = env.rider(2_000);
    let bob = env.person();
    let sources: Vec<APk> = (0..4).map(|i| env.forge_source(70 + i as u8, 0)).collect();
    env.give_lines(&bob, &sources, 125, |i| i as i64);
    let offer = env.backing(&ben, &bob, 1, SHARE);
    let car = env.open_car(&opener, (2, 10));
    let key = env.fresh_key();
    let relayer = env.fresh_key();
    let mut join = env.backed_join_ix(&ben, &bob, offer, car, Some(&key));
    join.accounts[0].pubkey = s(a(relayer.pubkey()));
    let ixs = [cu_limit(1_400_000), cu_price(1_000), join];
    let m = v0::Message::try_compile(&relayer.pubkey(), &ixs, &[], env.svm.latest_blockhash())
        .expect("compile");
    let sigs = m.header.num_required_signatures as usize;
    let len = VersionedMessage::V0(m).serialize().len() + 1 + 64 * sigs;
    println!(
        "sponsored Backed join + seat key, no table: {len} B ({sigs} signatures, {} join accounts)",
        ixs[2].accounts.len()
    );
    assert_eq!(sigs, 3);
    assert!(len <= 1_232, "{len} B");
}

#[test]
fn a_backed_seat_takes_its_backing_ticket_not_a_direct_draw() {
    let mut env = Env::new();
    let opener = env.rider(2_000);
    let (ben, bob) = (env.person(), env.rider(2_000));
    let offer = env.backing(&ben, &bob, 1, SHARE);
    let car = env.open_car(&opener, (2, 10));
    let nonce = env.next_ticket(bob.account);
    let mut books = vec![];
    for src in env.sources_in(bob.account) {
        books.extend(book_metas(&env.svm, src));
    }
    env.ensure_spill(&bob.kp.insecure_clone(), bob.account, 40);
    let join = env.join_ix(
        &ben,
        car,
        0,
        (nonce, 12, ticket_pda(bob.account, nonce)),
        books,
        (Some((offer, bob.account)), ben.key),
    );
    let err = env
        .send_v0(&[cu_limit(1_400_000), join], &ben.kp.insecure_clone())
        .unwrap_err();
    assert_eq!(
        custom_code(&err),
        seat_err(ManySeatError::BackingNeedsTicket)
    );
    assert_eq!(env.offer_status(offer), OfferStatus::Accepted);
    assert_eq!(env.reserved_of(&bob), 500);
}

#[test]
fn a_backing_ticket_boards_only_with_the_offer_that_opened_it() {
    let mut env = Env::new();
    let opener = env.rider(2_000);
    let (ben, cy, bob) = (env.person(), env.person(), env.rider(2_000));
    // Bob backs Ben twice and Cy once; Ben stages the first Offer
    let first = env.backing(&ben, &bob, 1, SHARE);
    let second = env.backing(&ben, &bob, 2, SHARE);
    let for_cy = env.backing(&cy, &bob, 3, SHARE);
    let car = env.open_car(&opener, (2, 10));
    let nonce = env.stage_backing(&ben, &bob, first);
    let with = |env: &mut Env, p: &Person, offer: APk| {
        let page = env.page_with_room(car);
        let join = env.join_ix(
            p,
            car,
            page,
            (nonce, 20, ticket_pda(bob.account, nonce)),
            vec![],
            (Some((offer, bob.account)), p.key),
        );
        env.send_v0(&[cu_limit(1_400_000), join], &p.kp.insecure_clone())
    };
    // Ben's other Offer, and Cy's Offer, cannot spend the Ticket the first one opened
    let err = with(&mut env, &ben, second).unwrap_err();
    assert_eq!(custom_code(&err), match_err(MatchError::BadBacking));
    let err = with(&mut env, &cy, for_cy).unwrap_err();
    assert_eq!(custom_code(&err), match_err(MatchError::BadBacking));
    assert_eq!(env.offer_status(second), OfferStatus::Accepted);
    assert_eq!(env.offer_status(for_cy), OfferStatus::Accepted);
    // the Offer that opened it boards Ben
    with(&mut env, &ben, first).expect("the Ticket's own Offer");
    assert_eq!(env.offer_status(first), OfferStatus::Consumed);
    assert_eq!(env.counters(bob.account).open_offers, 2);
    assert_eq!(
        env.page(car, 0).seats[env.mark(car, &ben).expect("mark").seat as usize].funder(),
        bob.account.to_bytes()
    );
}

#[test]
fn an_unused_backing_ticket_goes_home_to_the_backer_and_only_with_its_own_offer() {
    let mut env = Env::new();
    let (ben, cy, bob) = (env.person(), env.person(), env.rider(2_000));
    let for_ben = env.backing(&ben, &bob, 1, SHARE);
    let for_cy = env.backing(&cy, &bob, 2, SHARE);
    let nonce = env.stage_backing(&ben, &bob, for_ben);
    assert_eq!(env.total_gemas(&bob), 1_500);
    // an hour on, anyone may cancel it, but naming another of Bob's Offers would leave Ben's
    // tied to a Ticket that no longer exists: refused
    env.set_time(env.now() + 3_601);
    let stranger = env.fresh_key();
    let mut books = vec![];
    for src in env.sources_in(bob.account) {
        books.extend(book_metas(&env.svm, src));
    }
    let err = env
        .cancel_backing_ticket(&stranger, &bob, nonce, Some(for_cy), books.clone())
        .unwrap_err();
    assert_eq!(custom_code(&err), match_err(MatchError::BadBacking));
    env.cancel_backing_ticket(&stranger, &bob, nonce, Some(for_ben), books)
        .expect("cancel with its Offer");
    assert_eq!(env.total_gemas(&bob), 2_000);
    assert_eq!(env.offer_status(for_ben), OfferStatus::Accepted);
    assert!(!env.load::<OfferState>(for_ben).inner.ticket_open);
    // Ben's Offer is free again: it stages and boards a car
    let opener = env.rider(2_000);
    let car = env.open_car(&opener, (2, 10));
    env.board_backed(&ben, &bob, for_ben, car)
        .expect("boards after all");
    assert_eq!(env.total_gemas(&bob), 1_500);
}

//! Many-seat Matches (ADR 0015, Railcar ticket 02): boarding, driven like a Game would, against
//! the built program. Checks what Accounts hold, what the car shows and what is refused.

use super::*;
use tesoro_core::error::ManySeatError;
use tesoro_core::ledger::draw::PotPages;
use tesoro_core::ledger::many_seat::{ManyStage, SeatState, SEATS_PER_PAGE};

const CAR_ENTRY: u64 = 500;

fn seat_err(e: ManySeatError) -> u32 {
    6500 + e as u32
}
fn match_err(e: tesoro_core::error::MatchError) -> u32 {
    6400 + e as u32
}

#[derive(Clone, Copy, Debug)]
struct Car {
    key: APk,
}

fn page_pda(car: APk, page: u8) -> APk {
    pda(&[SEAT_PAGE_SEED, car.as_ref(), &[page]])
}
fn mark_pda(car: APk, account: APk) -> APk {
    pda(&[SEAT_SEED, car.as_ref(), account.as_ref()])
}

impl Env {
    /// A Player with `gemas` own Gemas of one forged Source of their own.
    fn rider(&mut self, gemas: u64) -> Person {
        let p = self.person();
        let source = self.forge_source(self.person_seed, 0);
        self.give_lines(&p, &[source], gemas, |_| 0);
        p
    }

    fn open_car_as(
        &mut self,
        opener: &Person,
        game_signer: &Keypair,
        (min, max): (u8, u8),
    ) -> Result<Car, litesvm::types::FailedTransactionMetadata> {
        let n = self.counters_next(opener.account);
        let key = pda(&[MATCH_SEED, opener.account.as_ref(), &n.to_le_bytes()]);
        let (game_record, game_program, program_data) = self.game_accounts();
        let open = ix(
            accounts::OpenManySeatMatch {
                payer: opener.key,
                opener_authority: opener.key,
                game_authority: a(game_signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                game_record,
                game_program,
                program_data,
                opener_account: opener.account,
                counters: counters_pda(opener.account),
                match_state: key,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::OpenManySeatMatch {
                entry: CAR_ENTRY,
                n,
                min_seats: min,
                max_seats: max,
                asset: 0,
            },
            vec![],
        );
        let kp = opener.kp.insecure_clone();
        self.send(&[open], &kp, &[game_signer])?;
        Ok(Car { key })
    }

    fn open_car(&mut self, opener: &Person, bounds: (u8, u8)) -> Car {
        let game = self.game_auth.insecure_clone();
        self.open_car_as(opener, &game, bounds).expect("open car")
    }

    fn car(&self, car: Car) -> ManySeatMatch {
        let d = self.svm.get_account(&s(car.key)).expect("car").data;
        assert_eq!(&d[..8], ManySeatMatch::DISCRIMINATOR);
        *bytemuck::from_bytes::<ManySeatMatch>(&d[8..ManySeatMatch::SPACE])
    }

    fn page(&self, car: Car, page: u8) -> SeatPage {
        let d = self
            .svm
            .get_account(&s(page_pda(car.key, page)))
            .expect("page")
            .data;
        *bytemuck::from_bytes::<SeatPage>(&d[8..SeatPage::SPACE])
    }

    /// The page a client would pick: the first with a free seat, or the next one.
    fn page_with_room(&self, car: Car) -> u8 {
        let st = self.car(car);
        (0..st.inner.pages)
            .find(|&i| {
                let slots = st.inner.page_slots(i);
                self.page(car, i).seats[..slots]
                    .iter()
                    .any(|s| s.state() == SeatState::Empty)
            })
            .unwrap_or(st.inner.pages)
    }

    /// Boards with a direct draw into a fresh Pot. Returns the seat index.
    fn board(
        &mut self,
        p: &Person,
        car: Car,
    ) -> Result<u8, litesvm::types::FailedTransactionMetadata> {
        let page = self.page_with_room(car);
        let nonce = self.next_ticket(p.account);
        let pot = ticket_pda(p.account, nonce);
        let books = self.books_of(p.account);
        self.board_ix(p, car, page, (nonce, 4, pot), books)
    }

    fn board_ix(
        &mut self,
        p: &Person,
        car: Car,
        page: u8,
        (pot_nonce, pot_lines, pot): (u64, u32, APk),
        remaining: Vec<AccountMeta>,
    ) -> Result<u8, litesvm::types::FailedTransactionMetadata> {
        self.ensure_spill(&p.kp, p.account, 16 + 2 * pot_lines as usize);
        let join = self.join_ix(p, car, page, (pot_nonce, pot_lines, pot), remaining, None);
        let kp = p.kp.insecure_clone();
        self.send(&[join], &kp, &[])?;
        Ok(self.mark(car, p).expect("mark").seat)
    }

    /// A join; with `backing` = (accepted Offer, Backer's Account) the Backer funds the seat.
    fn join_ix(
        &self,
        p: &Person,
        car: Car,
        page: u8,
        (pot_nonce, pot_lines, pot): (u64, u32, APk),
        remaining: Vec<AccountMeta>,
        backing: Option<(APk, APk)>,
    ) -> Instruction {
        let (game_record, game_program, program_data) = self.game_accounts();
        let backer = backing.map(|(_, b)| b);
        ix(
            accounts::JoinManySeatMatch {
                payer: p.key,
                player_authority: p.key,
                player_account: p.account,
                counters: counters_pda(p.account),
                protections: protections_pda(p.account),
                basket: basket_address(&p.account).0,
                spill: spill_address(&p.account).0,
                pot,
                match_state: car.key,
                game_record,
                game_program,
                program_data,
                seat_page: page_pda(car.key, page),
                seat_mark: mark_pda(car.key, p.account),
                system_program: anchor_lang::system_program::ID,
                offer: backing.map(|(o, _)| o),
                backer_account: backer,
                backer_counters: backer.map(counters_pda),
                backer_protections: backer.map(protections_pda),
                backer_basket: backer.map(|b| basket_address(&b).0),
                backer_spill: backer.map(|b| spill_address(&b).0),
                funder_mark: backer.map(|b| mark_pda(car.key, b)),
            },
            instruction::JoinManySeatMatch {
                pot_nonce,
                pot_lines,
                page,
            },
            remaining,
        )
    }

    /// The mark of the seat's Backer, when the seat is backed.
    fn funder_mark_of(&self, car: Car, seat: u8) -> Option<APk> {
        let st = self.page(car, seat / SEATS_PER_PAGE as u8).seats[seat as usize % SEATS_PER_PAGE];
        (st.funder() != st.player()).then(|| mark_pda(car.key, APk::new_from_array(st.funder())))
    }

    fn mark(&self, car: Car, p: &Person) -> Option<SeatMark> {
        self.svm
            .get_account(&s(mark_pda(car.key, p.account)))
            .filter(|acc| !acc.data.is_empty())
            .map(|acc| *bytemuck::from_bytes::<SeatMark>(&acc.data[8..SeatMark::SPACE]))
    }

    /// The stores, books and overflow record a return of the last `max` lines of `pot` to
    /// `funder` touches.
    fn return_remaining(&self, car: Car, funder: APk, pot: APk, max: u8) -> Vec<AccountMeta> {
        let mut out = vec![
            rem(basket_address(&funder).0),
            rem(spill_address(&funder).0),
        ];
        let d = self.svm.get_account(&s(pot)).expect("pot").data;
        let lines = PotPages::open(d[tesoro_core::pots::POT_AT..].to_vec())
            .expect("pot")
            .lines();
        let mut sources: Vec<APk> = vec![];
        for l in lines.iter().rev().take(max as usize) {
            let k = APk::new_from_array(l.source);
            if !sources.contains(&k) {
                sources.push(k);
            }
        }
        for src in sources {
            out.extend(book_metas(&self.svm, src));
        }
        let id = self
            .svm
            .get_account(&s(car.key))
            .map(|_| self.car(car).inner.id());
        if let Some(id) = id {
            let record = overflow_address(&funder, OVERFLOW_MATCH, &id.seed()).0;
            if self.svm.get_account(&s(record)).is_some() {
                out.push(rem(record));
            }
        }
        out
    }

    fn step_off_ix(
        &self,
        caller: APk,
        car: Car,
        p: &Person,
        max_lines: u8,
        game: bool,
    ) -> Instruction {
        let mark = self.mark(car, p).expect("seated");
        let page = self.page(car, mark.seat / SEATS_PER_PAGE as u8);
        let seat = page.seats[mark.seat as usize % SEATS_PER_PAGE];
        let pot = APk::new_from_array(seat.pot());
        let (game_record, game_program, program_data) = self.game_accounts();
        ix(
            accounts::StepOffManySeatMatch {
                caller,
                match_state: car.key,
                seat_page: page_pda(car.key, mark.seat / SEATS_PER_PAGE as u8),
                seat_mark: mark_pda(car.key, p.account),
                mark_payer: APk::new_from_array(mark.payer),
                player_counters: counters_pda(p.account),
                player_protections: protections_pda(p.account),
                pot,
                pot_payer: pot_payer_of(&self.svm, pot),
                sponsor: None,
                game_record: game.then_some(game_record),
                game_program: game.then_some(game_program),
                program_data: game.then_some(program_data),
                funder_mark: self.funder_mark_of(car, mark.seat),
                funder_protections: (seat.funder() != seat.player())
                    .then(|| protections_pda(APk::new_from_array(seat.funder()))),
            },
            instruction::StepOffManySeatMatch {
                seat: mark.seat,
                max_lines,
            },
            self.return_remaining(car, APk::new_from_array(seat.funder()), pot, max_lines),
        )
    }

    fn step_off(
        &mut self,
        caller: &Keypair,
        car: Car,
        p: &Person,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let i = self.step_off_ix(
            a(caller.pubkey()),
            car,
            p,
            tesoro_core::MAX_RETURN_LINES,
            false,
        );
        let kp = caller.insecure_clone();
        self.send_v0(&[i], &kp).map(drop)
    }

    fn return_rest(
        &mut self,
        caller: &Keypair,
        car: Car,
        p: &Person,
        max_lines: u8,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let mark = self.mark(car, p).expect("returning");
        let i = ix(
            accounts::ReturnSteppedOff {
                caller: a(caller.pubkey()),
                seat_mark: mark_pda(car.key, p.account),
                mark_payer: APk::new_from_array(mark.payer),
                pot: APk::new_from_array(mark.pot),
                pot_payer: pot_payer_of(&self.svm, APk::new_from_array(mark.pot)),
                sponsor: None,
            },
            instruction::ReturnSteppedOff { max_lines },
            self.return_remaining(
                car,
                APk::new_from_array(mark.funder),
                APk::new_from_array(mark.pot),
                max_lines,
            ),
        );
        let kp = caller.insecure_clone();
        self.send_v0(&[i], &kp).map(drop)
    }

    fn depart_as(
        &mut self,
        signer: &Keypair,
        car: Car,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let (game_record, game_program, program_data) = self.game_accounts();
        let i = ix(
            accounts::DepartManySeatMatch {
                game_authority: a(signer.pubkey()),
                game_record,
                game_program,
                program_data,
                match_state: car.key,
            },
            instruction::DepartManySeatMatch {},
            vec![],
        );
        let kp = signer.insecure_clone();
        self.send(&[i], &kp, &[])
    }

    fn depart(&mut self, car: Car) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let game = self.game_auth.insecure_clone();
        self.depart_as(&game, car)
    }

    fn close_car(
        &mut self,
        caller: &Keypair,
        car: Car,
        pages: &[u8],
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let st = self.car(car);
        let mut remaining = vec![];
        for &i in pages {
            let page = self.page(car, i);
            remaining.push(rem(page_pda(car.key, i)));
            remaining.push(rem(APk::new_from_array(page.payer)));
        }
        let i = ix(
            accounts::CloseManySeatMatch {
                caller: a(caller.pubkey()),
                match_state: car.key,
                match_payer: APk::new_from_array(st.payer),
            },
            instruction::CloseManySeatMatch {},
            remaining,
        );
        let kp = caller.insecure_clone();
        self.send(&[i], &kp, &[])
    }

    fn sol_of(&self, k: APk) -> u64 {
        self.svm.get_account(&s(k)).map_or(0, |a| a.lamports)
    }
}

fn pot_payer_of(svm: &LiteSVM, pot: APk) -> APk {
    let d = svm.get_account(&s(pot)).expect("pot").data;
    APk::new_from_array(d[8 + 72..8 + 104].try_into().unwrap())
}

/// A car with `n` Players seated, each holding 2,000 Gemas before boarding.
fn seated_car(n: usize, bounds: (u8, u8)) -> (Env, Car, Vec<Person>) {
    let mut env = Env::new();
    let riders: Vec<Person> = (0..n).map(|_| env.rider(2_000)).collect();
    let car = env.open_car(&riders[0], bounds);
    for p in &riders {
        env.board(p, car).expect("board");
    }
    (env, car, riders)
}

#[test]
fn five_players_board_and_the_game_departs_the_car() {
    let mut env = Env::new();
    let riders: Vec<Person> = (0..5).map(|_| env.rider(2_000)).collect();
    let car = env.open_car(&riders[0], (5, 100));
    let st = env.car(car);
    assert_eq!(st.inner.stage(), ManyStage::Boarding);
    assert_eq!((st.inner.seated, st.inner.entry()), (0, CAR_ENTRY));
    for (i, p) in riders.iter().enumerate() {
        let t = 1_000_000 + i as i64;
        env.set_time(t);
        assert_eq!(env.board(p, car).expect("board"), i as u8);
        assert_eq!(env.total_gemas(p), 1_500);
        let st = env.car(car);
        assert_eq!(st.inner.seated, i as u8 + 1);
        // the countdown starts at the fifth seat
        assert_eq!(st.inner.min_since(), if i == 4 { t } else { 0 });
    }
    let page = env.page(car, 0);
    for (i, p) in riders.iter().enumerate() {
        assert_eq!(page.seats[i].player(), p.account.to_bytes());
        assert_eq!(page.seats[i].funder(), p.account.to_bytes());
        assert_eq!(env.counters(p.account).open_matches, 1);
    }
    env.set_time(1_000_040);
    env.depart(car).expect("depart");
    let st = env.car(car);
    assert_eq!(st.inner.stage(), ManyStage::Departed);
    assert_eq!((st.inner.seated, st.inner.departed_at()), (5, 1_000_040));
}

#[test]
fn a_hundred_seats_fill_the_car_and_the_hundred_and_first_is_refused() {
    let (mut env, car, _riders) = seated_car(100, (5, 100));
    let st = env.car(car);
    assert_eq!((st.inner.seated, st.inner.pages), (100, 10));
    let late = env.rider(2_000);
    // every page is full: the next page does not exist, and the car refuses a 101st seat
    let nonce = env.next_ticket(late.account);
    let books = env.books_of(late.account);
    let err = env
        .board_ix(
            &late,
            car,
            9,
            (nonce, 4, ticket_pda(late.account, nonce)),
            books.clone(),
        )
        .unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::Full));
    let err = env
        .board_ix(
            &late,
            car,
            10,
            (nonce, 4, ticket_pda(late.account, nonce)),
            books,
        )
        .unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::Full));
    assert_eq!(env.total_gemas(&late), 2_000);
    env.depart(car).expect("a full car leaves");
}

#[test]
fn a_car_smaller_than_its_pages_has_no_seat_past_its_maximum() {
    let (mut env, car, _riders) = seated_car(12, (2, 12));
    assert_eq!(env.car(car).inner.pages, 2);
    let late = env.rider(2_000);
    let nonce = env.next_ticket(late.account);
    let books = env.books_of(late.account);
    let err = env
        .board_ix(
            &late,
            car,
            1,
            (nonce, 4, ticket_pda(late.account, nonce)),
            books,
        )
        .unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::Full));
}

#[test]
fn pages_are_made_in_order_and_a_full_page_says_so() {
    let mut env = Env::new();
    let riders: Vec<Person> = (0..11).map(|_| env.rider(2_000)).collect();
    let car = env.open_car(&riders[0], (5, 100));
    let nonce = env.next_ticket(riders[0].account);
    let books = env.books_of(riders[0].account);
    let p0 = &riders[0];
    let err = env
        .board_ix(p0, car, 1, (nonce, 4, ticket_pda(p0.account, nonce)), books)
        .unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::BadPage));
    for p in &riders[..10] {
        env.board(p, car).expect("board");
    }
    let p = &riders[10];
    let nonce = env.next_ticket(p.account);
    let books = env.books_of(p.account);
    let err = env
        .board_ix(
            p,
            car,
            0,
            (nonce, 4, ticket_pda(p.account, nonce)),
            books.clone(),
        )
        .unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::PageFull));
    assert_eq!(
        env.board_ix(p, car, 1, (nonce, 4, ticket_pda(p.account, nonce)), books)
            .expect("next page"),
        10
    );
}

#[test]
fn one_seat_per_account() {
    let (mut env, car, riders) = seated_car(2, (2, 10));
    let err = env.board(&riders[1], car).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::AlreadySeated));
    assert_eq!(env.total_gemas(&riders[1]), 1_500);
    assert_eq!(env.car(car).inner.seated, 2);
}

#[test]
fn stepping_off_gives_the_whole_entry_back_frees_the_seat_and_every_rent() {
    let (mut env, _first, riders) = seated_car(3, (2, 10));
    let ben = &riders[1];
    env.set_entry_limit(ben, 600).expect("limit");
    // the limit counted nothing so far (it was set after boarding): set it before the next car
    let car2 = env.open_car(&riders[0], (2, 10));
    // Ben's own spill growth is his storage, not this car's rent
    env.ensure_spill(&ben.kp.insecure_clone(), ben.account, 24);
    let before = env.sol_of(ben.key);
    env.board(ben, car2).expect("board car 2");
    assert_eq!(env.entry_limit(ben).used(env.now()), 500);
    assert_eq!(env.total_gemas(ben), 1_000);
    assert_eq!(env.counters(ben.account).open_matches, 2);
    let seat = env.mark(car2, ben).expect("mark").seat;
    let pot = APk::new_from_array(env.page(car2, 0).seats[seat as usize].pot());
    let kp = ben.kp.insecure_clone();
    env.step_off(&kp, car2, ben).expect("step off");
    assert_eq!(env.total_gemas(ben), 1_500);
    assert_eq!(env.entry_limit(ben).used(env.now()), 0);
    assert_eq!(env.counters(ben.account).open_matches, 1);
    assert_eq!(
        env.page(car2, 0).seats[seat as usize].state(),
        SeatState::Empty
    );
    assert_eq!(env.car(car2).inner.seated, 0);
    assert!(env.mark(car2, ben).is_none(), "the mark closed");
    assert!(env.svm.get_account(&s(pot)).is_none_or(|a| a.lamports == 0));
    // Pot and mark rents back; only the page (closed with the car) and fees stay out
    let page_rent = env.sol_of(page_pda(car2.key, 0));
    assert!(before - env.sol_of(ben.key) <= page_rent + 50_000);
    // the freed seat is taken again, by the same Player
    assert_eq!(env.board(ben, car2).expect("board again"), seat);
    assert_eq!(env.total_gemas(ben), 1_000);
}

#[test]
fn the_countdown_stops_when_a_step_off_drops_the_car_below_its_minimum() {
    let (mut env, car, riders) = seated_car(5, (5, 100));
    assert_ne!(env.car(car).inner.min_since(), 0);
    let kp = riders[2].kp.insecure_clone();
    env.step_off(&kp, car, &riders[2]).expect("step off");
    assert_eq!(env.car(car).inner.min_since(), 0);
    let err = env.depart(car).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::BelowMinimum));
    env.set_time(1_000_100);
    env.board(&riders[2], car).expect("back on");
    assert_eq!(env.car(car).inner.min_since(), 1_000_100);
    env.depart(car).expect("depart");
}

#[test]
fn after_departure_nobody_steps_off_or_boards() {
    let (mut env, car, riders) = seated_car(2, (2, 10));
    env.depart(car).expect("depart");
    let kp = riders[0].kp.insecure_clone();
    let err = env.step_off(&kp, car, &riders[0]).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::NotBoarding));
    let late = env.rider(2_000);
    let err = env.board(&late, car).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::NotBoarding));
    assert_eq!(env.total_gemas(&riders[0]), 1_500);
    let err = env.depart(car).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::NotBoarding));
}

#[test]
fn only_the_game_opens_a_car_and_makes_it_leave() {
    let mut env = Env::new();
    let ana = env.rider(2_000);
    let bob = env.rider(2_000);
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let err = env.open_car_as(&ana, &stranger, (2, 10)).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::NotGame));
    let game = env.game_auth.insecure_clone();
    let err = env.open_car_as(&ana, &game, (1, 10)).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::BadSeatBounds));
    let err = env.open_car_as(&ana, &game, (5, 101)).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::BadSeatBounds));
    let car = env.open_car(&ana, (2, 10));
    env.board(&ana, car).expect("ana");
    env.board(&bob, car).expect("bob");
    let err = env.depart_as(&stranger, car).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::NotGame));
    let kp = ana.kp.insecure_clone();
    let err = env.depart_as(&kp, car).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::NotGame));
    env.depart(car).expect("the Game departs");
}

#[test]
fn a_stranger_cannot_step_a_player_off() {
    let (mut env, car, riders) = seated_car(2, (2, 10));
    let kp = riders[1].kp.insecure_clone();
    let err = env.step_off(&kp, car, &riders[0]).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::NotYourSeat));
    assert_eq!(env.total_gemas(&riders[0]), 1_500);
    // the Game's authority may
    let game = env.game_auth.insecure_clone();
    env.step_off(&game, car, &riders[0])
        .expect("game steps off");
    assert_eq!(env.total_gemas(&riders[0]), 2_000);
}

#[test]
fn break_and_self_exclusion_refuse_boarding_and_let_anyone_step_off_an_away_player() {
    let mut env = Env::new();
    let ana = env.rider(2_000);
    let bob = env.rider(2_000);
    let cy = env.rider(2_000);
    let car = env.open_car(&ana, (2, 10));
    env.set_break(&bob, 1).expect("break");
    let err = env.board(&bob, car).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::OnBreak));
    env.set_self_exclusion(&cy, 6).expect("self-exclusion");
    let err = env.board(&cy, car).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::SelfExcluded));
    assert_eq!(env.total_gemas(&bob) + env.total_gemas(&cy), 4_000);
    // Ana boards, then starts a Break: anyone may step her off
    env.board(&ana, car).expect("ana");
    env.set_break(&ana, 1).expect("ana's break");
    let kp = bob.kp.insecure_clone();
    env.step_off(&kp, car, &ana).expect("anyone");
    assert_eq!(env.total_gemas(&ana), 2_000);
}

#[test]
fn an_entry_limit_stops_boarding_over_it() {
    let mut env = Env::new();
    let ana = env.rider(2_000);
    let opener = env.rider(2_000);
    env.set_entry_limit(&ana, 700).expect("limit");
    let car1 = env.open_car(&opener, (2, 10));
    let car2 = env.open_car(&opener, (2, 10));
    env.board(&ana, car1).expect("first car");
    let err = env.board(&ana, car2).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
    // stepping off the first car frees the limit for the second
    let kp = ana.kp.insecure_clone();
    env.step_off(&kp, car1, &ana).expect("step off");
    env.board(&ana, car2).expect("second car");
    assert_eq!(env.entry_limit(&ana).used(env.now()), 500);
}

#[test]
fn an_entry_staged_in_an_entry_ticket_boards_and_comes_back_over_several_calls() {
    let mut env = Env::new();
    let opener = env.rider(2_000);
    let ana = env.person();
    env.grow_basket_to(&ana, 40);
    // 500 Gemas in 25 lines of 20: more than one transaction draws, so an Entry Ticket stages it
    let sources: Vec<APk> = (0..25).map(|i| env.forge_source(60 + i as u8, 0)).collect();
    env.give_lines(&ana, &sources, 20, |i| i as i64);
    env.open_ticket(&ana, 5, CAR_ENTRY, 26).expect("ticket");
    let kp = ana.kp.insecure_clone();
    while env.load_ticket_staged(&ana, 5) < CAR_ENTRY {
        env.stage_with(&kp, &ana, 5, 255, vec![]).expect("stage");
    }
    let car = env.open_car(&opener, (2, 10));
    let seat = env
        .board_ix(&ana, car, 0, (5, 1, ticket_pda(ana.account, 5)), vec![])
        .expect("board with the Ticket");
    assert_eq!(env.total_gemas(&ana), 0);
    assert_eq!(
        env.page(car, 0).seats[seat as usize].pot(),
        ticket_pda(ana.account, 5).to_bytes()
    );
    let i = env.step_off_ix(ana.key, car, &ana, tesoro_core::MAX_RETURN_LINES, false);
    env.send_v0(&[i], &kp).expect("step off");
    assert_eq!(env.total_gemas(&ana), 8 * 20);
    let mark = env.mark(car, &ana).expect("still returning");
    assert_eq!(mark.returning, 1);
    assert_eq!(env.car(car).inner.seated, 0, "the seat is free at once");
    let err = env.board(&ana, car).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::StillReturning));
    // anyone finishes the return, a call at a time
    let other = opener.kp.insecure_clone();
    for _ in 0..2 {
        env.return_rest(&other, car, &ana, 8).expect("rest");
        assert!(env.mark(car, &ana).is_some());
    }
    env.return_rest(&other, car, &ana, 8).expect("last");
    assert_eq!(env.total_gemas(&ana), CAR_ENTRY);
    assert!(env.mark(car, &ana).is_none());
    assert!(env
        .svm
        .get_account(&s(ticket_pda(ana.account, 5)))
        .is_none_or(|a| a.lamports == 0));
}

#[test]
fn an_upgraded_game_takes_no_seat_and_anyone_steps_its_players_off() {
    let (mut env, car, riders) = seated_car(2, (2, 10));
    common::set_program_data(
        &mut env.svm,
        s(GAME),
        Some(env.game_ctl.pubkey()),
        GAME_SLOT + 5,
    );
    let late = env.rider(2_000);
    let err = env.board(&late, car).unwrap_err();
    assert_eq!(
        custom_code(&err),
        match_err(tesoro_core::error::MatchError::GameUpgraded)
    );
    let err = env.depart(car).unwrap_err();
    assert_eq!(
        custom_code(&err),
        match_err(tesoro_core::error::MatchError::GameUpgraded)
    );
    let stranger = late.kp.insecure_clone();
    let i = env.step_off_ix(late.key, car, &riders[0], 16, true);
    env.send_v0(&[i], &stranger).expect("anyone, Game changed");
    assert_eq!(env.total_gemas(&riders[0]), 2_000);
}

#[test]
fn once_boarding_ends_nobody_boards_the_car_cannot_leave_and_anyone_steps_off() {
    let (mut env, car, riders) = seated_car(2, (2, 10));
    let ends = env.car(car).inner.boarding_ends();
    env.set_time(ends);
    let err = env.depart(car).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::BoardingOver));
    let late = env.rider(2_000);
    let err = env.board(&late, car).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::BoardingOver));
    let stranger = late.kp.insecure_clone();
    env.step_off(&stranger, car, &riders[0]).expect("anyone");
    env.step_off(&stranger, car, &riders[1]).expect("anyone");
    assert_eq!(
        env.total_gemas(&riders[0]) + env.total_gemas(&riders[1]),
        4_000
    );
}

#[test]
fn an_empty_car_closes_with_every_page_and_returns_their_rent() {
    let mut env = Env::new();
    let riders: Vec<Person> = (0..11).map(|_| env.rider(2_000)).collect();
    let car = env.open_car(&riders[0], (5, 20));
    for p in &riders {
        env.board(p, car).expect("board");
    }
    let page1_payer = APk::new_from_array(env.page(car, 1).payer);
    assert_eq!(page1_payer, riders[10].key);
    let caller = Keypair::new();
    env.svm.airdrop(&caller.pubkey(), SOL).unwrap();
    let err = env.close_car(&caller, car, &[0, 1]).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::NotEmpty));
    for p in &riders {
        let kp = p.kp.insecure_clone();
        env.step_off(&kp, car, p).expect("step off");
    }
    let err = env.close_car(&caller, car, &[0]).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::PagesMissing));
    let payer = APk::new_from_array(env.car(car).payer);
    let before = (env.sol_of(payer), env.sol_of(page1_payer));
    let page1_rent = env.sol_of(page_pda(car.key, 1));
    let match_rent = env.sol_of(car.key);
    env.close_car(&caller, car, &[0, 1]).expect("close");
    assert!(env
        .svm
        .get_account(&s(car.key))
        .is_none_or(|a| a.lamports == 0));
    assert_eq!(env.sol_of(page1_payer), before.1 + page1_rent);
    // the opener paid the Match and page 0
    assert!(env.sol_of(payer) >= before.0 + match_rent);
    for p in &riders {
        assert_eq!(env.total_gemas(p), 2_000);
        assert_eq!(env.counters(p.account).open_matches, 0);
    }
}

/// The compute a step-off or return call holds under: the head-to-head chunk budget.
const RETURN_CU_BUDGET: u64 = 140_000;

/// CU of a step-off that returns `k` lines from `k` Sources, each merging into a line Ana still
/// holds of the same Source (the book of every Source is read and written: the worst return).
fn step_off_cu(k: u8) -> u64 {
    let mut env = Env::new();
    let opener = env.rider(2_000);
    let ana = env.person();
    env.grow_basket_to(&ana, 60);
    let sources: Vec<APk> = (0..20).map(|i| env.forge_source(90 + i as u8, 0)).collect();
    env.give_lines(&ana, &sources, 25, |i| i as i64);
    env.open_ticket(&ana, 5, CAR_ENTRY, 21).expect("ticket");
    let kp = ana.kp.insecure_clone();
    while env.load_ticket_staged(&ana, 5) < CAR_ENTRY {
        env.stage_with(&kp, &ana, 5, 255, vec![]).expect("stage");
    }
    let car = env.open_car(&opener, (2, 10));
    env.board_ix(&ana, car, 0, (5, 1, ticket_pda(ana.account, 5)), vec![])
        .expect("board");
    env.give_lines(&ana, &sources, 5, |i| i as i64);
    let i = env.step_off_ix(ana.key, car, &ana, k, false);
    env.send_v0(&[cu_limit(1_400_000), i], &kp)
        .expect("step off");
    let cu = env.last_cu;
    while env.mark(car, &ana).is_some() {
        env.return_rest(&kp, car, &ana, k).expect("rest");
        assert!(env.last_cu < RETURN_CU_BUDGET + 10_000);
    }
    assert_eq!(env.total_gemas(&ana), CAR_ENTRY + 20 * 5);
    cu
}

#[test]
fn a_step_off_returning_its_most_lines_fits_the_chunk_budget() {
    let max = tesoro_core::MAX_RETURN_LINES;
    let sweep: Vec<(u8, u64)> = [1, max / 2, max]
        .into_iter()
        .map(|k| (k, step_off_cu(k)))
        .collect();
    println!("step-off CU by lines returned (cap {max}): {sweep:?}");
    let at_cap = sweep.iter().find(|(k, _)| *k == max).expect("cap").1;
    assert!(at_cap < RETURN_CU_BUDGET, "{max} lines used {at_cap} CU");
}
mod backing;
mod settle;

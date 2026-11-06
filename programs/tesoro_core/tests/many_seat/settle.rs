//! Many-seat settlement (Railcar ticket 03), driven like a Game would against the built program:
//! the Game reports a result, anyone sends the chunks and closes the seats. Checks what Accounts
//! hold, the fees, the events and what is refused.

use super::*;
use tesoro_core::ledger::line_store::LineStore;
use tesoro_core::ledger::many_seat::{ManySeatResult, Seat, SeatPlace, SeatRefund};
use tesoro_core::{ManySeatChunkDone, ManySeatPlaced, ManySeatRunStarted, ManySeatSettled};

const CHUNK_CU_BUDGET: u64 = 140_000;

pub(super) fn result(places: &[(u8, u16)], refunds: &[(u8, u64)]) -> ManySeatResult {
    ManySeatResult::Placed {
        places: places
            .iter()
            .map(|&(seat, share_bps)| SeatPlace { seat, share_bps })
            .collect(),
        refunds: refunds
            .iter()
            .map(|&(seat, gemas)| SeatRefund { seat, gemas })
            .collect(),
    }
}

/// One chunk as sent: its compute units and the accounts it named.
#[derive(Debug, Clone, Copy)]
pub(super) struct Sent {
    cu: u64,
    accounts: usize,
    steps: u8,
}

impl Env {
    fn page_metas(&self, car: Car) -> Vec<AccountMeta> {
        (0..self.car(car).inner.pages)
            .map(|i| rem(page_pda(car.key, i)))
            .collect()
    }

    fn settle_car_as(
        &mut self,
        signer: &Keypair,
        car: Car,
        result: ManySeatResult,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let (game_record, game_program, program_data) = self.game_accounts();
        let i = ix(
            accounts::SettleManySeatMatch {
                game_authority: a(signer.pubkey()),
                payer: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                game_record,
                game_program,
                program_data,
                match_state: car.key,
                receipt: receipt_pda(car.key),
                system_program: anchor_lang::system_program::ID,
                event_authority: event_authority(),
                program: tesoro_core::ID,
            },
            instruction::SettleManySeatMatch { result },
            self.page_metas(car),
        );
        let kp = signer.insecure_clone();
        self.send(&[cu_limit(1_400_000), i], &kp, &[])?;
        self.start_events = self.last_events.clone();
        Ok(())
    }

    pub(super) fn settle_car(
        &mut self,
        car: Car,
        result: ManySeatResult,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let game = self.game_auth.insecure_clone();
        self.settle_car_as(&game, car, result)
    }

    fn refund_car(
        &mut self,
        caller: &Keypair,
        car: Car,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let (game_record, game_program, program_data) = self.game_accounts();
        let i = ix(
            accounts::RefundManySeatMatch {
                caller: a(caller.pubkey()),
                payer: a(caller.pubkey()),
                game_record,
                game_program,
                program_data,
                match_state: car.key,
                receipt: receipt_pda(car.key),
                system_program: anchor_lang::system_program::ID,
                event_authority: event_authority(),
                program: tesoro_core::ID,
            },
            instruction::RefundManySeatMatch {},
            vec![],
        );
        let kp = caller.insecure_clone();
        self.send(&[i], &kp, &[])
    }

    /// Every seat of the car and its Pot's lines (none for an empty seat or a closed Pot).
    fn seats_and_lines(&self, car: Car) -> (Vec<Seat>, Vec<Vec<Line>>) {
        let st = self.car(car);
        let mut seats = vec![];
        let mut lines = vec![];
        for p in 0..st.inner.pages {
            for seat in self.page(car, p).seats {
                let l = if seat.state() == SeatState::Seated {
                    self.svm
                        .get_account(&s(APk::new_from_array(seat.pot())))
                        .filter(|acc| acc.data.len() > tesoro_core::pots::POT_AT)
                        .map(|acc| {
                            PotPages::open(acc.data[tesoro_core::pots::POT_AT..].to_vec())
                                .expect("pot")
                                .lines()
                        })
                        .unwrap_or_default()
                } else {
                    vec![]
                };
                seats.push(seat);
                lines.push(l);
            }
        }
        (seats, lines)
    }

    /// The chunk a client sends: the accounts `ahead` lists for the next `steps` steps.
    fn car_chunk_ix(&self, caller: APk, car: Car, steps: u8) -> Instruction {
        let st = self.car(car);
        let (seats, lines) = self.seats_and_lines(car);
        let plan = st.inner.ahead(&seats, &lines, steps as usize);
        let mut out: Vec<AccountMeta> = plan
            .pages
            .iter()
            .map(|p| rem(page_pda(car.key, *p)))
            .collect();
        for i in &plan.seats {
            out.push(rem(APk::new_from_array(seats[*i as usize].pot())));
        }
        let id = st.inner.id();
        for o in &plan.owners {
            let o = APk::new_from_array(*o);
            out.push(rem(basket_address(&o).0));
            out.push(rem(spill_address(&o).0));
            let record = overflow_address(&o, OVERFLOW_MATCH, &id.seed()).0;
            if self
                .svm
                .get_account(&s(record))
                .is_some_and(|r| !r.data.is_empty())
            {
                out.push(rem(record));
            }
        }
        let mut books: Vec<APk> = vec![];
        for src in plan.sources.iter().chain(&plan.cut_sources) {
            let src = APk::new_from_array(*src);
            if !books.contains(&src) {
                books.push(src);
                out.extend(book_metas(&self.svm, src));
            }
        }
        for src in &plan.cut_sources {
            let src = APk::new_from_array(*src);
            out.push(AccountMeta::new_readonly(s(src), false));
            out.push(rem(APk::new_from_array(
                self.load::<SourceState>(src).inner.position,
            )));
        }
        ix(
            accounts::ManySeatChunk {
                caller,
                match_state: car.key,
                event_authority: event_authority(),
                program: tesoro_core::ID,
            },
            instruction::ManySeatChunk { max_steps: steps },
            out,
        )
    }

    /// One chunk of up to `steps` steps, fewer when the accounts would pass 60.
    fn car_chunk(
        &mut self,
        car: Car,
        steps: u8,
    ) -> Result<Sent, litesvm::types::FailedTransactionMetadata> {
        let payer = self.admin.insecure_clone();
        let mut steps = steps;
        let mut i = self.car_chunk_ix(a(payer.pubkey()), car, steps);
        while i.accounts.len() > 60 && steps > 1 {
            steps -= 1;
            i = self.car_chunk_ix(a(payer.pubkey()), car, steps);
        }
        let accounts = i.accounts.len();
        self.send_v0(&[cu_limit(1_400_000), i], &payer)?;
        Ok(Sent {
            cu: self.last_cu,
            accounts,
            steps,
        })
    }

    /// Chunks until the run is paid; every chunk sent.
    pub(super) fn run_car(&mut self, car: Car) -> Vec<Sent> {
        let mut sent = vec![];
        for _ in 0..5_000 {
            if self.car(car).inner.stage() == ManyStage::Paid {
                return sent;
            }
            sent.push(
                self.car_chunk(car, tesoro_core::MAX_SEAT_CHUNK_STEPS)
                    .expect("chunk"),
            );
        }
        panic!("the run did not finish");
    }

    pub(super) fn close_seat_ix(&self, caller: APk, car: Car, seat: u8) -> Instruction {
        let page = self.page(car, seat / SEATS_PER_PAGE as u8);
        let st = page.seats[seat as usize % SEATS_PER_PAGE];
        let player = APk::new_from_array(st.player());
        let mark = mark_pda(car.key, player);
        let mark_payer = self
            .svm
            .get_account(&s(mark))
            .map(|acc| *bytemuck::from_bytes::<SeatMark>(&acc.data[8..SeatMark::SPACE]))
            .expect("mark")
            .payer;
        let pot = APk::new_from_array(st.pot());
        ix(
            accounts::CloseManySeat {
                caller,
                match_state: car.key,
                seat_page: page_pda(car.key, seat / SEATS_PER_PAGE as u8),
                seat_mark: mark,
                mark_payer: APk::new_from_array(mark_payer),
                player_counters: counters_pda(player),
                pot,
                pot_payer: pot_payer_of(&self.svm, pot),
                sponsor: None,
                funder_spill: Some(spill_address(&APk::new_from_array(st.funder())).0),
                funder_mark: self.funder_mark_of(car, seat),
                funder_protections: Some(protections_pda(APk::new_from_array(st.funder()))),
            },
            instruction::CloseManySeat { seat },
            vec![],
        )
    }

    /// Closes every seat, then the car.
    pub(super) fn close_paid_car(&mut self, car: Car) {
        let caller = self.admin.insecure_clone();
        let (seats, _) = self.seats_and_lines(car);
        for (i, st) in seats.iter().enumerate() {
            if st.state() == SeatState::Seated {
                let c = self.close_seat_ix(a(caller.pubkey()), car, i as u8);
                self.send(&[c], &caller, &[]).expect("close seat");
            }
        }
        let pages: Vec<u8> = (0..self.car(car).inner.pages).collect();
        self.close_car(&caller, car, &pages).expect("close car");
    }

    pub(super) fn started<T: anchor_lang::Event>(&self) -> Vec<T> {
        self.start_events
            .iter()
            .filter_map(|e| decode_event::<T>(e))
            .collect()
    }

    /// Fee Gemas in Source counters of `class`, over `sources`.
    fn counters_of(&self, sources: &[APk], class: u8) -> u64 {
        sources
            .iter()
            .map(|src| common::econ::counter(&self.svm, *src, class).map_or(0, |l| l.amount))
            .sum()
    }
}

/// Ana, Ben, Cy, Dee, Eve each hold 2,000 own Gemas of a Source of their own and board a car of
/// 500; the Leaderboard Fee is 1%, so fees are 6% (Platform 2, Studio 3 to the outside studio).
fn five_riders() -> (Env, Car, Vec<Person>, Vec<APk>) {
    let mut env = Env::new();
    env.enable_leaderboard(100);
    let riders: Vec<Person> = (0..5).map(|_| env.rider(2_000)).collect();
    let sources: Vec<APk> = riders
        .iter()
        .map(|p| env.sources_in(p.account)[0])
        .collect();
    let car = env.open_car(&riders[0], (5, 100));
    for p in &riders {
        env.board(p, car).expect("board");
    }
    let studio = env.studio.kp.insecure_clone();
    let studio_account = env.studio.account;
    env.ensure_spill(&studio, studio_account, 16);
    env.depart(car).expect("depart");
    (env, car, riders, sources)
}

pub(super) const ANA: usize = 0;
pub(super) const BEN: usize = 1;
pub(super) const CY: usize = 2;
pub(super) const DEE: usize = 3;
pub(super) const EVE: usize = 4;

#[test]
fn the_worked_example_settles_to_the_gema() {
    let (mut env, car, riders, sources) = five_riders();
    let studio_before = env.fee_gemas(&env.studio);
    env.settle_car(car, result(&[(3, 6000), (1, 2500), (2, 1500)], &[(0, 350)]))
        .expect("settle");
    // the win: Dee first, Ben her opponent for the Points cap, 5 Points
    let won: Vec<MatchWon> = env.started();
    assert_eq!(won.len(), 1);
    assert_eq!(won[0].player, riders[DEE].account);
    assert_eq!(won[0].funder, riders[DEE].account);
    assert_eq!(won[0].loser, riders[BEN].account);
    assert_eq!((won[0].points, won[0].pool_fee, won[0].entry), (5, 21, 500));
    let run: Vec<ManySeatRunStarted> = env.started();
    assert_eq!(run[0].fees, [44, 64, 21]);
    assert_eq!(
        (run[0].refunded, run[0].forfeited, run[0].seated),
        (350, 650, 5)
    );
    let placed: Vec<ManySeatPlaced> = env.started();
    let paid: Vec<(u8, u8, APk, u64)> = placed
        .iter()
        .map(|p| (p.place, p.seat, p.player, p.won))
        .collect();
    assert_eq!(
        paid,
        vec![
            (1, 3, riders[DEE].account, 313),
            (2, 1, riders[BEN].account, 130),
            (3, 2, riders[CY].account, 78)
        ]
    );
    if let Ok(path) = std::env::var("TESORO_MANY_SEAT_FIXTURE") {
        let hex = |b: &Vec<u8>| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        let events: Vec<String> = env
            .start_events
            .iter()
            .map(|e| format!("\"{}\"", hex(e)))
            .collect();
        let who: Vec<String> = riders
            .iter()
            .map(|p| format!("\"{}\"", p.account))
            .collect();
        std::fs::write(
            path,
            format!(
                "{{\"riders\":[{}],\"events\":[{}]}}\n",
                who.join(","),
                events.join(",")
            ),
        )
        .expect("fixture");
    }
    let sent = env.run_car(car);
    let got: Vec<u64> = riders.iter().map(|p| env.total_gemas(p) - 1_500).collect();
    assert_eq!(got, vec![350, 630, 578, 813, 0]);
    assert_eq!(env.counters_of(&sources, CLASS_PLATFORM), 44);
    assert_eq!(env.fee_gemas(&env.studio) - studio_before, 64);
    assert_eq!(env.counters_of(&sources, CLASS_LEADERBOARD), 21);
    // the forfeits are Ana's and Eve's Gemas: Dee's winnings keep their Sources
    assert!(gemas_in(&env.svm, riders[DEE].account, sources[EVE]) > 0);
    println!("worked example: {} chunks {:?}", sent.len(), sent);
    let settled: Vec<ManySeatSettled> = env
        .last_events
        .iter()
        .filter_map(|e| decode_event(e))
        .collect();
    assert_eq!(settled.len(), 1);
    // the seats close, every rent goes back, nobody keeps an open Match
    let marks: Vec<APk> = riders
        .iter()
        .map(|p| mark_pda(car.key, p.account))
        .collect();
    env.close_paid_car(car);
    for (p, mark) in riders.iter().zip(marks) {
        assert_eq!(env.counters(p.account).open_matches, 0);
        assert!(env
            .svm
            .get_account(&s(mark))
            .is_none_or(|a| a.lamports == 0));
    }
    assert!(env
        .svm
        .get_account(&s(car.key))
        .is_none_or(|a| a.lamports == 0));
    assert!(env.svm.get_account(&s(receipt_pda(car.key))).is_some());
}

#[test]
fn the_other_place_splits_and_a_full_refund() {
    // two placed 70/30, one placed takes all, nobody acted: full refund, no fee
    let cases: [(ManySeatResult, [u64; 5], [u64; 3], u64); 3] = [
        (
            result(&[(3, 7000), (1, 3000)], &[(0, 350)]),
            [350, 806, 0, 1_215, 0],
            [44, 64, 21],
            5,
        ),
        (
            result(&[(3, 10_000)], &[(0, 350)]),
            [350, 0, 0, 2_021, 0],
            [44, 64, 21],
            5,
        ),
        (ManySeatResult::Refund, [500; 5], [0, 0, 0], 0),
    ];
    for (r, want, fees, points) in cases {
        let (mut env, car, riders, sources) = five_riders();
        let studio_before = env.fee_gemas(&env.studio);
        env.settle_car(car, r.clone()).expect("settle");
        let won: Vec<MatchWon> = env.started();
        assert_eq!(won.iter().map(|w| w.points).sum::<u64>(), points, "{r:?}");
        env.run_car(car);
        let got: Vec<u64> = riders.iter().map(|p| env.total_gemas(p) - 1_500).collect();
        assert_eq!(got, want.to_vec(), "{r:?}");
        let cut = [
            env.counters_of(&sources, CLASS_PLATFORM),
            env.fee_gemas(&env.studio) - studio_before,
            env.counters_of(&sources, CLASS_LEADERBOARD),
        ];
        assert_eq!(cut, fees, "{r:?}");
        env.close_paid_car(car);
    }
}

#[test]
fn fees_are_capped_at_the_forfeits_and_the_win_earns_no_points() {
    // The config cannot set rates above its cap, but at the default 6% the cap binds when a Game
    // refunds nearly every unplaced entry: Ana and Ben get 490 back, Pot after refunds 1,520 asks
    // 91 in fees (Platform 31, Studio 45, Leaderboard 15) and only 20 is forfeited.
    let (mut env, car, riders, sources) = five_riders();
    env.settle_car(
        car,
        result(&[(2, 6000), (3, 2500), (4, 1500)], &[(0, 490), (1, 490)]),
    )
    .expect("settle");
    let run: Vec<ManySeatRunStarted> = env.started();
    assert_eq!((run[0].fees, run[0].fees_capped), ([20, 0, 0], true));
    let won: Vec<MatchWon> = env.started();
    assert_eq!((won[0].points, won[0].pool_fee), (0, 0));
    env.run_car(car);
    let got: Vec<u64> = riders.iter().map(|p| env.total_gemas(p) - 1_500).collect();
    assert_eq!(got, vec![490, 490, 500, 500, 500]);
    assert_eq!(env.counters_of(&sources, CLASS_PLATFORM), 20);
}

#[test]
fn a_two_seat_car_won_outright_gives_the_head_to_head_numbers() {
    let mut env = Env::new();
    env.enable_leaderboard(100);
    let ana = env.rider(2_000);
    let ben = env.rider(2_000);
    let sources = vec![
        env.sources_in(ana.account)[0],
        env.sources_in(ben.account)[0],
    ];
    let studio = env.studio.kp.insecure_clone();
    let studio_account = env.studio.account;
    env.ensure_spill(&studio, studio_account, 8);
    let studio_before = env.fee_gemas(&env.studio);
    let car = env.open_car(&ana, (2, 2));
    env.board(&ana, car).expect("ana");
    env.board(&ben, car).expect("ben");
    env.depart(car).expect("depart");
    env.settle_car(car, result(&[(0, 10_000)], &[]))
        .expect("settle");
    let won: Vec<MatchWon> = env.started();
    assert_eq!((won[0].loser, won[0].points), (ben.account, 5));
    env.run_car(car);
    // fees 6% of both entries, all from Ben's: 20 + 30 + 10; Ana 500 + 440
    assert_eq!(
        (env.total_gemas(&ana), env.total_gemas(&ben)),
        (1_500 + 940, 1_500)
    );
    assert_eq!(env.counters_of(&sources, CLASS_PLATFORM), 20);
    assert_eq!(env.fee_gemas(&env.studio) - studio_before, 30);
    assert_eq!(env.counters_of(&sources, CLASS_LEADERBOARD), 10);
}

#[test]
fn seven_days_after_open_only_a_refund_starts_and_anyone_starts_it() {
    let (mut env, car, riders, _) = five_riders();
    let stranger = riders[EVE].kp.insecure_clone();
    // a day after departure at the earliest
    let err = env.refund_car(&stranger, car).unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::NotExpired));
    let deadline = env.car(car).inner.deadline_abs();
    env.set_time(deadline);
    let err = env
        .settle_car(car, result(&[(3, 10_000)], &[]))
        .unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::PastDeadline));
    env.refund_car(&stranger, car).expect("anyone refunds");
    env.run_car(car);
    assert!(riders.iter().all(|p| env.total_gemas(p) == 2_000));
    env.close_paid_car(car);
}

#[test]
fn a_car_keeps_its_receipts_canonical_bump_from_open() {
    let (env, car, _, _) = five_riders();
    let (_, canonical) =
        APk::find_program_address(&[b"settled", car.key.as_ref()], &tesoro_core::ID);
    assert_eq!(env.car(car).inner.receipt_bump(), canonical);
}

#[test]
fn a_day_after_departure_anyone_refunds_and_the_game_can_no_longer_settle() {
    let (mut env, car, riders, _) = five_riders();
    let after = env.car(car).inner.refund_after();
    env.set_time(after);
    let stranger = riders[ANA].kp.insecure_clone();
    env.refund_car(&stranger, car).expect("refund");
    let err = env
        .settle_car(car, result(&[(3, 10_000)], &[]))
        .unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::NotDeparted));
    env.run_car(car);
    assert!(riders.iter().all(|p| env.total_gemas(p) == 2_000));
}

#[test]
fn an_upgraded_game_cannot_settle_and_anyone_refunds_at_once() {
    let (mut env, car, riders, _) = five_riders();
    common::set_program_data(
        &mut env.svm,
        s(GAME),
        Some(env.game_ctl.pubkey()),
        GAME_SLOT + 5,
    );
    let err = env
        .settle_car(car, result(&[(3, 10_000)], &[]))
        .unwrap_err();
    assert_eq!(
        custom_code(&err),
        match_err(tesoro_core::error::MatchError::GameUpgraded)
    );
    let stranger = riders[ANA].kp.insecure_clone();
    env.refund_car(&stranger, car).expect("refund");
    env.run_car(car);
    assert!(riders.iter().all(|p| env.total_gemas(p) == 2_000));
}

#[test]
fn only_the_game_settles_and_a_bad_result_is_refused() {
    let (mut env, car, riders, _) = five_riders();
    let ana = riders[ANA].kp.insecure_clone();
    let err = env
        .settle_car_as(&ana, car, result(&[(3, 10_000)], &[]))
        .unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::NotGame));
    let err = env
        .settle_car(car, result(&[(3, 6_000), (1, 3_000)], &[]))
        .unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::BadResult));
    let err = env
        .settle_car(car, result(&[(3, 10_000)], &[(0, 501)]))
        .unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::BadResult));
    // nothing stuck: the right result still settles
    env.settle_car(car, result(&[(3, 10_000)], &[]))
        .expect("settle");
}

#[test]
fn a_winner_with_full_stores_waits_until_anyone_pays_for_room() {
    let (mut env, car, riders, _) = five_riders();
    env.settle_car(car, result(&[(3, 6000), (1, 2500), (2, 1500)], &[(0, 350)]))
        .expect("settle");
    // Dee fills every free slot of her stores: her own entry still comes home (held at boarding)
    let dee = riders[DEE].account;
    common::econ::fill_with_dust(&mut env.svm, basket_address(&dee).0);
    common::econ::fill_with_dust(&mut env.svm, spill_address(&dee).0);
    let mut blocked = false;
    for _ in 0..100 {
        match env.car_chunk(car, tesoro_core::MAX_SEAT_CHUNK_STEPS) {
            Ok(_) => {
                let chunk: Vec<ManySeatChunkDone> = env
                    .last_events
                    .iter()
                    .filter_map(|e| decode_event(e))
                    .collect();
                if chunk[0].blocked {
                    blocked = true;
                    break;
                }
            }
            Err(_) => {
                blocked = true;
                break;
            }
        }
    }
    assert!(blocked, "Dee's winnings found no slot");
    assert_eq!(env.total_gemas(&riders[ANA]), 1_850);
    assert_eq!(env.total_gemas(&riders[BEN]), 2_000);
    // a stranger may only pay for an Account the run pays
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let id = env.car(car).inner.id();
    let reserve = |who: APk| {
        ix(
            accounts::ReserveManySeatRoom {
                payer: a(stranger.pubkey()),
                match_state: car.key,
                record: overflow_address(&who, OVERFLOW_MATCH, &id.seed()).0,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::ReserveManySeatRoom {
                account: who,
                lines: 4,
            },
            vec![],
        )
    };
    let err = env
        .send(&[reserve(riders[EVE].account)], &stranger, &[])
        .unwrap_err();
    assert_eq!(custom_code(&err), seat_err(ManySeatError::NotPaidHere));
    env.send(&[reserve(dee)], &stranger, &[])
        .expect("room for Dee");
    env.run_car(car);
    let record = overflow_address(&dee, OVERFLOW_MATCH, &id.seed()).0;
    let d = env.svm.get_account(&s(record)).expect("record").data;
    let held: u64 = LineStore::new(&d[OVERFLOW_STORE_AT..])
        .expect("record store")
        .lines()
        .map(|l| l.amount)
        .sum();
    assert_eq!(held, 313);
    assert_eq!(env.total_gemas(&riders[BEN]), 2_130);
    assert_eq!(env.total_gemas(&riders[CY]), 2_078);
}

#[test]
fn a_chunk_cannot_be_fed_another_cars_page_or_pot() {
    let (mut env, car, riders, _) = five_riders();
    // a second car with its own seats
    let other_riders: Vec<Person> = (0..2).map(|_| env.rider(2_000)).collect();
    let other = env.open_car(&other_riders[0], (2, 10));
    for p in &other_riders {
        env.board(p, other).expect("board");
    }
    env.settle_car(car, result(&[(3, 10_000)], &[]))
        .expect("settle");
    let payer = env.admin.insecure_clone();
    let mut i = env.car_chunk_ix(a(payer.pubkey()), car, 4);
    // swap in the other car's page and a Pot of its own
    for m in i.accounts.iter_mut() {
        if m.pubkey == s(page_pda(car.key, 0)) {
            m.pubkey = s(page_pda(other.key, 0));
        }
    }
    let err = env.send_v0(&[i], &payer).unwrap_err();
    assert_eq!(
        custom_code(&err),
        match_err(tesoro_core::error::MatchError::AccountMissing)
    );
    let mut i = env.car_chunk_ix(a(payer.pubkey()), car, 4);
    let wrong_pot = APk::new_from_array(env.page(other, 0).seats[0].pot());
    let dee_pot = s(APk::new_from_array(env.page(car, 0).seats[DEE].pot()));
    for m in i.accounts.iter_mut() {
        if m.pubkey == dee_pot {
            m.pubkey = s(wrong_pot);
        }
    }
    let err = env.send_v0(&[i], &payer).unwrap_err();
    assert_eq!(
        custom_code(&err),
        match_err(tesoro_core::error::MatchError::AccountMissing)
    );
    env.run_car(car);
    assert_eq!(env.total_gemas(&riders[DEE]), 1_500 + 500 + 2_000 - 150);
}

/// 100 riders whose entries are staged in Entry Tickets: 10 lines of 50 from 10 shared Sources.
/// Railcar's shape: the last three off 60/25/15, 60 early jumpers refunded 5-80%, 37 aboard. The
/// client sends chunks of `steps`; returns the worst chunk and the number of chunks.
fn hundred_seats(steps: u8) -> (Sent, usize, u64) {
    let mut env = Env::new();
    env.enable_leaderboard(100);
    let sources: Vec<APk> = (0..10)
        .map(|i| env.forge_source(200 + i as u8, 0))
        .collect();
    let riders: Vec<Person> = (0..100)
        .map(|_| {
            let p = env.person();
            env.grow_basket_to(&p, 24);
            env.give_lines(&p, &sources, 50, |i| i as i64);
            p
        })
        .collect();
    let car = env.open_car(&riders[0], (5, 100));
    for p in &riders {
        let nonce = env.next_ticket(p.account);
        env.open_ticket(p, nonce, CAR_ENTRY, 12).expect("ticket");
        let kp = p.kp.insecure_clone();
        while env.load_ticket_staged(p, nonce) < CAR_ENTRY {
            env.stage_with(&kp, p, nonce, 255, vec![]).expect("stage");
        }
        let page = env.page_with_room(car);
        env.board_ix(
            p,
            car,
            page,
            (nonce, 1, ticket_pda(p.account, nonce)),
            vec![],
        )
        .expect("board with a Ticket");
    }
    let studio = env.studio.kp.insecure_clone();
    let studio_account = env.studio.account;
    env.ensure_spill(&studio, studio_account, 64);
    env.depart(car).expect("depart");
    let ladder = [400u64, 350, 300, 250, 200, 150, 100, 50, 25];
    let refunds: Vec<(u8, u64)> = (0..60u8)
        .map(|i| (i, ladder[i as usize % ladder.len()]))
        .collect();
    let refunded: u64 = refunds.iter().map(|r| r.1).sum();
    env.settle_car(car, result(&[(99, 6000), (98, 2500), (97, 1500)], &refunds))
        .expect("settle");
    let start_cu = env.last_cu;
    let mut sent = vec![];
    while env.car(car).inner.stage() != ManyStage::Paid {
        sent.push(env.car_chunk(car, steps).expect("chunk"));
        assert!(sent.len() < 5_000);
    }
    let worst = sent.iter().max_by_key(|s| s.cu).copied().expect("chunks");
    // every Gema is where the payout says
    let pot = 100 * CAR_ENTRY - refunded;
    let fees = pot * 6 / 100;
    let total: u64 = riders.iter().map(|p| env.total_gemas(p)).sum::<u64>() + fees;
    assert_eq!(total, 100 * CAR_ENTRY);
    for (i, p) in riders.iter().enumerate().take(60) {
        assert_eq!(env.total_gemas(p), ladder[i % ladder.len()], "rider {i}");
    }
    env.close_paid_car(car);
    assert!(riders
        .iter()
        .all(|p| env.counters(p.account).open_matches == 0));
    (worst, sent.len(), start_cu)
}

#[test]
fn a_hundred_seats_with_entry_tickets_settle_inside_the_chunk_budget() {
    let max = tesoro_core::MAX_SEAT_CHUNK_STEPS;
    let mut at_cap = None;
    for steps in [max - 2, max - 1, max] {
        let (worst, chunks, start_cu) = hundred_seats(steps);
        println!(
            "100 seats, Entry Tickets (10 lines each), chunks of {steps}: settle start {start_cu} CU; {chunks} chunks; worst chunk {} CU ({} steps, {} accounts)",
            worst.cu, worst.steps, worst.accounts
        );
        if steps == max {
            at_cap = Some(worst);
        }
    }
    let worst = at_cap.expect("cap measured");
    assert!(worst.cu < CHUNK_CU_BUDGET, "worst chunk {worst:?}");
}

//! LiteSVM tests of the Block Puzzle Game program together with `tesoro_core`
//! (`pnpm build:programs` first). LiteSVM has no delegation program, so Boards stay owned by
//! `block_puzzle` here: everything that runs in the rollup on devnet (begin_run, play, finish,
//! seal) is exercised directly; delegation, permissions and commit are covered by the devnet
//! run recorded in docs/games/block-puzzle.md.
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use block_puzzle::engine::{self, piece_at, State};
use block_puzzle::{Board, Session, AUTHORITY_SEED, BOARD_SEED, SESSION_SEED};
use litesvm::LiteSVM;
use solana_sdk::clock::Clock;
use solana_sdk::hash::Hash;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::sysvar::slot_hashes::SlotHashes;
use solana_sdk::transaction::Transaction;
use tesoro_core::instructions::MatchResult;
use tesoro_core::ledger::{MatchStatus, Outcome, SourceChain};
use tesoro_core::state::*;

const SOL: u64 = 1_000_000_000;
const ENTRY: u64 = 1_000;
const T0: i64 = 1_000_000;

type Res = Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>;

fn a(p: Pk) -> APk {
    APk::new_from_array(p.to_bytes())
}
fn s(p: APk) -> Pk {
    Pk::new_from_array(p.to_bytes())
}
fn core_pda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &tesoro_core::ID).0
}
fn bp_pda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &block_puzzle::ID).0
}
fn authority() -> APk {
    bp_pda(&[AUTHORITY_SEED])
}
fn account_pda(auth: APk) -> APk {
    core_pda(&[ACCOUNT_SEED, auth.as_ref()])
}
fn holding_pda(account: APk, source: APk) -> APk {
    core_pda(&[HOLDING_SEED, account.as_ref(), source.as_ref()])
}
fn match_pda(id: u64) -> APk {
    core_pda(&[MATCH_SEED, &id.to_le_bytes()])
}
fn session_pda(m: APk) -> APk {
    bp_pda(&[SESSION_SEED, m.as_ref()])
}
fn board_pda(session: APk, seat: u8) -> APk {
    bp_pda(&[BOARD_SEED, session.as_ref(), &[seat]])
}

fn to_metas(m: Vec<anchor_lang::prelude::AccountMeta>) -> Vec<AccountMeta> {
    m.into_iter()
        .map(|m| AccountMeta {
            pubkey: s(m.pubkey),
            is_signer: m.is_signer,
            is_writable: m.is_writable,
        })
        .collect()
}
fn core_ix(
    accts: impl ToAccountMetas,
    data: impl InstructionData,
    rem: Vec<AccountMeta>,
) -> Instruction {
    let mut metas = to_metas(accts.to_account_metas(None));
    metas.extend(rem);
    Instruction {
        program_id: s(tesoro_core::ID),
        accounts: metas,
        data: data.data(),
    }
}
fn bp_ix(
    accts: impl ToAccountMetas,
    data: impl InstructionData,
    rem: Vec<AccountMeta>,
) -> Instruction {
    let mut metas = to_metas(accts.to_account_metas(None));
    metas.extend(rem);
    Instruction {
        program_id: s(block_puzzle::ID),
        accounts: metas,
        data: data.data(),
    }
}
fn rem(k: APk) -> AccountMeta {
    AccountMeta::new(s(k), false)
}

fn code(e: &litesvm::types::FailedTransactionMetadata) -> u32 {
    use solana_sdk::instruction::InstructionError;
    use solana_sdk::transaction::TransactionError;
    match &e.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => *c,
        other => panic!("unexpected error {other:?}\n{:?}", e.meta.logs),
    }
}
/// Anchor custom error code of a `BlockPuzzleError` variant.
fn bp_err(e: block_puzzle::BlockPuzzleError) -> u32 {
    e.into()
}

struct Person {
    kp: Keypair,
    key: APk,
    account: APk,
    holding: APk,
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    oracle: Keypair,
    stranger: Keypair,
    slot: u64,
    next_match: u64,
}

impl Env {
    fn new() -> (Self, Person, Person) {
        let mut svm = LiteSVM::new();
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/");
        svm.add_program_from_file(s(tesoro_core::ID), format!("{dir}tesoro_core.so"))
            .expect("tesoro_core.so (pnpm build:programs)");
        svm.add_program_from_file(s(block_puzzle::ID), format!("{dir}block_puzzle.so"))
            .expect("block_puzzle.so (pnpm build:programs)");
        let mut env = Self {
            svm,
            admin: Keypair::new(),
            oracle: Keypair::new(),
            stranger: Keypair::new(),
            slot: 100,
            next_match: 1,
        };
        for k in [&env.admin, &env.oracle, &env.stranger] {
            env.svm.airdrop(&k.pubkey(), 1_000 * SOL).expect("airdrop");
        }
        env.set_clock(T0, 100);

        let platform = env.person_account();
        let studio = env.person_account();
        let config = core_pda(&[CONFIG_SEED]);
        let admin = env.admin.insecure_clone();
        env.send_core_admin(
            &admin,
            core_ix(
                tesoro_core::accounts::InitializeConfig {
                    admin: a(admin.pubkey()),
                    config,
                    platform_recipient: platform.0,
                    system_program: anchor_lang::system_program::ID,
                },
                tesoro_core::instruction::InitializeConfig {
                    oracle_authority: a(env.oracle.pubkey()),
                    platform_bps: 200,
                },
                vec![],
            ),
        );
        env.send_core_admin(
            &admin,
            core_ix(
                tesoro_core::accounts::RegisterGame {
                    admin: a(admin.pubkey()),
                    config,
                    studio_recipient: studio.0,
                },
                tesoro_core::instruction::RegisterGame {
                    game: block_puzzle::ID,
                    authority: authority(),
                    studio_bps: 300,
                },
                vec![],
            ),
        );
        let alice = env.staker(1);
        let bob = env.staker(2);
        (env, alice, bob)
    }

    fn send_core_admin(&mut self, payer: &Keypair, ix: Instruction) {
        self.send(&[ix], payer, &[]).expect("core admin ix");
    }

    fn set_clock(&mut self, unix_timestamp: i64, slot: u64) {
        self.slot = slot;
        self.svm.set_sysvar(&Clock {
            slot,
            unix_timestamp,
            ..Clock::default()
        });
    }
    fn set_time(&mut self, t: i64) {
        let slot = self.slot;
        self.set_clock(t, slot);
    }
    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }
    fn set_slot_hashes(&mut self, entries: &[(u64, Hash)]) {
        self.svm.set_sysvar(&SlotHashes::new(entries));
    }

    fn send(&mut self, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) -> Res {
        self.svm.expire_blockhash();
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&payer.pubkey()),
            &signers,
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx)
    }

    /// Creates a funded wallet and its Tesoro Account. Returns (account, keypair).
    fn person_account(&mut self) -> (APk, Keypair) {
        let kp = Keypair::new();
        self.svm
            .airdrop(&kp.pubkey(), 1_000 * SOL)
            .expect("airdrop");
        let account = account_pda(a(kp.pubkey()));
        let create = core_ix(
            tesoro_core::accounts::CreateAccount {
                authority: a(kp.pubkey()),
                account,
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::CreateAccount {
                evm_address: [0; 20],
            },
            vec![],
        );
        self.send(&[create], &kp, &[]).expect("create account");
        (account, kp)
    }

    /// A Player with a Position and an Advance: 75_000 Gemas of their own Source.
    fn staker(&mut self, id: u8) -> Person {
        let (account, kp) = self.person_account();
        let position = core_pda(&[POSITION_SEED, &[0], &[id; 32]]);
        let config = core_pda(&[CONFIG_SEED]);
        let open = core_ix(
            tesoro_core::accounts::OpenPosition {
                oracle: a(self.oracle.pubkey()),
                config,
                owner_account: account,
                position,
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::OpenPosition {
                source_chain: SourceChain::Solana,
                position_id: [id; 32],
                source_asset: APk::new_unique(),
                decimals: 9,
                principal: 100 * SOL,
                rate_bps: 1_000,
            },
            vec![],
        );
        let oracle = self.oracle.insecure_clone();
        self.send(&[open], &oracle, &[]).expect("open position");
        let source = core_pda(&[SOURCE_SEED, position.as_ref(), &0u32.to_le_bytes()]);
        let holding = holding_pda(account, source);
        let advance = core_ix(
            tesoro_core::accounts::TakeAdvance {
                oracle: a(self.oracle.pubkey()),
                owner_authority: a(kp.pubkey()),
                config,
                owner_account: account,
                position,
                source,
                holding,
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::TakeAdvance {
                horizon_months: 6,
                price_micro_usd: 150_000_000,
            },
            vec![],
        );
        self.send(&[advance], &oracle, &[&kp]).expect("advance");
        Person {
            key: a(kp.pubkey()),
            kp,
            account,
            holding,
        }
    }

    fn load_core<T: AccountDeserialize>(&self, k: APk) -> T {
        let acct = self.svm.get_account(&s(k)).expect("account exists");
        T::try_deserialize(&mut acct.data.as_slice()).expect("deserialize")
    }
    fn load_bp<T: AccountDeserialize>(&self, k: APk) -> T {
        self.load_core(k)
    }
    fn total(&self, p: &Person) -> u64 {
        let acct = self.load_core::<TesoroAccount>(p.account).inner;
        acct.own_total + acct.won_total
    }
    fn patch_board(&mut self, k: APk, f: impl FnOnce(&mut Board)) {
        let mut acct = self.svm.get_account(&s(k)).expect("board exists");
        let mut board = Board::try_deserialize(&mut acct.data.as_slice()).expect("deserialize");
        f(&mut board);
        let mut buf = Vec::new();
        board.try_serialize(&mut buf).expect("serialize");
        acct.data[..buf.len()].copy_from_slice(&buf);
        self.svm.set_account(s(k), acct).expect("set account");
    }

    fn open_holding(&mut self, account: APk, source: APk) {
        let holding = holding_pda(account, source);
        if self.svm.get_account(&s(holding)).is_some() {
            return;
        }
        let open = core_ix(
            tesoro_core::accounts::OpenHolding {
                payer: a(self.admin.pubkey()),
                account,
                source,
                holding,
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::OpenHolding {},
            vec![],
        );
        let admin = self.admin.insecure_clone();
        self.send(&[open], &admin, &[]).expect("open holding");
    }

    /// Payout accounts for settling `id` with `result`, in the ledger's order.
    fn payout_metas(&mut self, id: u64, result: MatchResult) -> Vec<AccountMeta> {
        let mut m = self.load_core::<MatchState>(match_pda(id)).inner;
        let outcome = match result {
            MatchResult::Opener => Outcome::Winner(0),
            MatchResult::Joiner => Outcome::Winner(1),
            MatchResult::Draw => Outcome::Draw,
        };
        let payouts = m.settle(outcome).unwrap_or_default();
        let mut metas = Vec::new();
        for p in payouts {
            let recipient = APk::new_from_array(p.recipient);
            let source = APk::new_from_array(p.source);
            self.open_holding(recipient, source);
            metas.push(rem(recipient));
            metas.push(rem(holding_pda(recipient, source)));
        }
        metas
    }

    fn open_and_join(&mut self, alice: &Person, bob: &Person) -> u64 {
        let id = self.next_match;
        self.next_match += 1;
        let open = core_ix(
            tesoro_core::accounts::OpenMatch {
                player_authority: alice.key,
                config: core_pda(&[CONFIG_SEED]),
                player_account: alice.account,
                match_state: match_pda(id),
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::OpenMatch {
                match_id: id,
                game: block_puzzle::ID,
                entry: ENTRY,
            },
            vec![rem(alice.holding)],
        );
        self.send(&[open], &alice.kp, &[]).expect("open match");
        let join = core_ix(
            tesoro_core::accounts::JoinMatch {
                player_authority: bob.key,
                player_account: bob.account,
                match_state: match_pda(id),
            },
            tesoro_core::instruction::JoinMatch {},
            vec![rem(bob.holding)],
        );
        self.send(&[join], &bob.kp, &[]).expect("join match");
        id
    }

    fn start_session(&mut self, alice: &Person, bob: &Person, id: u64) -> Res {
        let m = match_pda(id);
        let session = session_pda(m);
        let ix = bp_ix(
            block_puzzle::accounts::StartSession {
                payer: a(self.stranger.pubkey()),
                match_state: m,
                account_a: alice.account,
                account_b: bob.account,
                session,
                board_0: board_pda(session, 0),
                board_1: board_pda(session, 1),
                system_program: anchor_lang::system_program::ID,
            },
            block_puzzle::instruction::StartSession {},
            vec![],
        );
        let payer = self.stranger.insecure_clone();
        self.send(&[ix], &payer, &[])
    }

    fn reveal(&mut self, id: u64) -> Res {
        let m = match_pda(id);
        let session = session_pda(m);
        let ix = bp_ix(
            block_puzzle::accounts::RevealSeed {
                payer: a(self.stranger.pubkey()),
                session,
                board_0: board_pda(session, 0),
                board_1: board_pda(session, 1),
                slot_hashes: anchor_lang::solana_program::sysvar::slot_hashes::ID,
                authority: authority(),
                config: core_pda(&[CONFIG_SEED]),
                match_state: m,
                tesoro_core_program: tesoro_core::ID,
            },
            block_puzzle::instruction::RevealSeed {},
            vec![],
        );
        let payer = self.stranger.insecure_clone();
        self.send(&[ix], &payer, &[])
    }

    /// Match opened, joined, Session started and Seed revealed. Returns (match id, seed).
    fn ready(&mut self, alice: &Person, bob: &Person) -> (u64, u64) {
        let id = self.open_and_join(alice, bob);
        self.start_session(alice, bob, id).expect("start session");
        let session: Session = self.load_bp(session_pda(match_pda(id)));
        let commit = session.commit_slot;
        self.set_clock(self.now(), commit + 2);
        self.set_slot_hashes(&[
            (commit + 1, Hash::new_unique()),
            (commit, Hash::new_unique()),
            (commit - 1, Hash::new_unique()),
        ]);
        self.reveal(id).expect("reveal seed");
        let session: Session = self.load_bp(session_pda(match_pda(id)));
        assert!(session.seed_ready);
        // Boards are private in the rollup; mimic `init_permission` having run there.
        for seat in 0..2 {
            self.patch_board(board_pda(session_pda(match_pda(id)), seat), |b| {
                b.permission_ready = true
            });
        }
        (id, session.seed)
    }

    fn board(&self, id: u64, seat: u8) -> APk {
        board_pda(session_pda(match_pda(id)), seat)
    }

    fn begin(&mut self, p: &Person, board: APk) -> Res {
        let ix = bp_ix(
            block_puzzle::accounts::PlayerAction {
                player: p.key,
                board,
            },
            block_puzzle::instruction::BeginRun {},
            vec![],
        );
        self.send(&[ix], &p.kp, &[])
    }

    fn play(&mut self, p: &Person, board: APk, moves: &[engine::Move]) -> Res {
        let mut last = None;
        for chunk in moves.chunks(20) {
            let ix = bp_ix(
                block_puzzle::accounts::PlayerAction {
                    player: p.key,
                    board,
                },
                block_puzzle::instruction::Play {
                    moves: chunk
                        .iter()
                        .map(|m| block_puzzle::MoveArg {
                            piece: m.piece,
                            x: m.x,
                            y: m.y,
                        })
                        .collect(),
                },
                vec![],
            );
            last = Some(self.send(&[ix], &p.kp, &[])?);
        }
        Ok(last.expect("at least one move"))
    }

    fn finish(&mut self, p: &Person, board: APk) -> Res {
        let ix = bp_ix(
            block_puzzle::accounts::PlayerAction {
                player: p.key,
                board,
            },
            block_puzzle::instruction::Finish {},
            vec![],
        );
        self.send(&[ix], &p.kp, &[])
    }

    fn seal(&mut self, id: u64) -> Res {
        let ix = bp_ix(
            block_puzzle::accounts::Seal {
                payer: a(self.stranger.pubkey()),
                board_0: self.board(id, 0),
                board_1: self.board(id, 1),
            },
            block_puzzle::instruction::Seal {},
            vec![],
        );
        let payer = self.stranger.insecure_clone();
        self.send(&[ix], &payer, &[])
    }

    fn settle_accounts(
        &self,
        id: u64,
        signer: APk,
        authority_key: APk,
    ) -> block_puzzle::accounts::Settle {
        block_puzzle::accounts::Settle {
            payer: signer,
            session: session_pda(match_pda(id)),
            board_0: self.board(id, 0),
            board_1: self.board(id, 1),
            authority: authority_key,
            config: core_pda(&[CONFIG_SEED]),
            match_state: match_pda(id),
            tesoro_core_program: tesoro_core::ID,
        }
    }

    fn settle(&mut self, id: u64, result: MatchResult) -> Res {
        let remaining = self.payout_metas(id, result);
        let ix = bp_ix(
            self.settle_accounts(id, a(self.stranger.pubkey()), authority()),
            block_puzzle::instruction::Settle {},
            remaining,
        );
        let payer = self.stranger.insecure_clone();
        self.send(&[ix], &payer, &[])
    }

    fn claim_timeout(&mut self, id: u64) -> Res {
        let remaining = self.payout_metas(id, MatchResult::Draw);
        let ix = bp_ix(
            self.settle_accounts(id, a(self.stranger.pubkey()), authority()),
            block_puzzle::instruction::ClaimTimeout {},
            remaining,
        );
        let payer = self.stranger.insecure_clone();
        self.send(&[ix], &payer, &[])
    }
}

/// A legal game: first fitting placement of the first unused piece, `n` moves at most.
fn greedy(seed: u64, n: usize) -> Vec<engine::Move> {
    let mut st = State::new(seed);
    let mut out = Vec::new();
    while out.len() < n && !st.over {
        let base = st.hand_base();
        let mut played = false;
        'hand: for slot in 0..engine::HAND {
            if st.used >> slot & 1 == 1 {
                continue;
            }
            let piece = piece_at(seed, base + slot);
            let (w, h) = engine::dims(piece);
            for y in 0..=engine::SIZE - h {
                for x in 0..=engine::SIZE - w {
                    let mv = engine::Move {
                        piece: (base + slot) as u16,
                        x,
                        y,
                    };
                    let mut t = st;
                    if t.apply(mv).is_ok() {
                        st = t;
                        out.push(mv);
                        played = true;
                        break 'hand;
                    }
                }
            }
        }
        if !played {
            break;
        }
    }
    out
}

fn replay_score(seed: u64, moves: &[engine::Move]) -> u32 {
    engine::replay(seed, moves).expect("legal").score
}

#[test]
fn seed_is_derived_from_a_future_slot_hash_nobody_chose() {
    let (mut env, alice, bob) = Env::new();
    let id = env.open_and_join(&alice, &bob);
    env.start_session(&alice, &bob, id).expect("start");
    let session: Session = env.load_bp(session_pda(match_pda(id)));
    assert!(!session.seed_ready);

    // Too early: the committed slot has not passed.
    let err = env.reveal(id).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::SeedTooEarly)
    );
    env.set_clock(env.now(), session.commit_slot);
    let err = env.reveal(id).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::SeedTooEarly)
    );

    // Two histories that differ only in the committed slot's hash give different Seeds.
    let commit = session.commit_slot;
    env.set_clock(env.now(), commit + 5);
    let h = Hash::new_unique();
    env.set_slot_hashes(&[(commit + 4, Hash::new_unique()), (commit, h)]);
    env.reveal(id).expect("reveal");
    let seed_a = env.load_bp::<Session>(session_pda(match_pda(id))).seed;
    let expected = {
        let d = anchor_lang::solana_program::hash::hashv(&[
            b"tesoro/block-puzzle/seed",
            match_pda(id).as_ref(),
            h.as_ref(),
            &commit.to_le_bytes(),
        ])
        .to_bytes();
        u64::from_le_bytes(d[..8].try_into().expect("8 bytes"))
    };
    assert_eq!(seed_a, expected);

    // Reveal is once.
    let err = env.reveal(id).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::SeedAlreadyRevealed)
    );

    // The Seed is copied to both Boards, and the Match's refund deadline moved past the
    // submission deadline.
    let session: Session = env.load_bp(session_pda(match_pda(id)));
    for seat in 0..2 {
        let b: Board = env.load_bp(env.board(id, seat));
        assert_eq!(b.seed, seed_a);
        assert_eq!(b.deadline, session.deadline);
    }
    let m = env.load_core::<MatchState>(match_pda(id)).inner;
    assert_eq!(
        m.deadline,
        session.deadline + block_puzzle::SETTLE_GRACE_SECS
    );

    // Another Match, another slot hash: another Seed.
    let id2 = env.open_and_join(&alice, &bob);
    env.start_session(&alice, &bob, id2).expect("start");
    let commit2 = env
        .load_bp::<Session>(session_pda(match_pda(id2)))
        .commit_slot;
    env.set_clock(env.now(), commit2 + 5);
    env.set_slot_hashes(&[(commit2, Hash::new_unique())]);
    env.reveal(id2).expect("reveal");
    let seed_b = env.load_bp::<Session>(session_pda(match_pda(id2))).seed;
    assert_ne!(seed_a, seed_b);
}

#[test]
fn a_stale_commitment_is_renewed_instead_of_wedging_the_match() {
    let (mut env, alice, bob) = Env::new();
    let id = env.open_and_join(&alice, &bob);
    env.start_session(&alice, &bob, id).expect("start");
    let commit = env
        .load_bp::<Session>(session_pda(match_pda(id)))
        .commit_slot;
    env.set_clock(env.now(), commit + block_puzzle::SEED_EXPIRY_SLOTS + 1);
    env.set_slot_hashes(&[(env.slot - 1, Hash::new_unique())]);
    env.reveal(id).expect("renews");
    let session: Session = env.load_bp(session_pda(match_pda(id)));
    assert!(!session.seed_ready);
    assert!(session.commit_slot > commit);
}

#[test]
fn only_a_real_active_match_of_this_game_starts_a_session() {
    let (mut env, alice, bob) = Env::new();
    let id = env.next_match;
    env.next_match += 1;
    let open = core_ix(
        tesoro_core::accounts::OpenMatch {
            player_authority: alice.key,
            config: core_pda(&[CONFIG_SEED]),
            player_account: alice.account,
            match_state: match_pda(id),
            system_program: anchor_lang::system_program::ID,
        },
        tesoro_core::instruction::OpenMatch {
            match_id: id,
            game: block_puzzle::ID,
            entry: ENTRY,
        },
        vec![rem(alice.holding)],
    );
    env.send(&[open], &alice.kp, &[]).expect("open");
    // Nobody has joined yet.
    let err = env.start_session(&alice, &bob, id).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::InvalidMatch)
    );
}

#[test]
fn score_is_the_engine_replay_and_illegal_moves_are_rejected() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.ready(&alice, &bob);
    let board = env.board(id, 0);

    // Cannot play before begin_run, nor can the opponent play this Board.
    let moves = greedy(seed, 30);
    let err = env.play(&alice, board, &moves).unwrap_err();
    assert_eq!(code(&err), bp_err(block_puzzle::BlockPuzzleError::NotBegan));
    let err = env.begin(&bob, board).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::NotThePlayer)
    );
    env.begin(&alice, board).expect("begin");
    let err = env.begin(&alice, board).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::AlreadyBegan)
    );
    let err = env.play(&bob, board, &moves).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::NotThePlayer)
    );

    // An illegal move (a piece not in the hand) rejects the whole batch: nothing is stored.
    let mut bad = moves[..3].to_vec();
    bad.push(engine::Move {
        piece: 40,
        x: 0,
        y: 0,
    });
    let err = env.play(&alice, board, &bad).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::IllegalMove)
    );
    assert_eq!(env.load_bp::<Board>(board).moves, 0);

    let meta = env.play(&alice, board, &moves[..20]).expect("play 20");
    println!("play(20 moves) CU = {}", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed < 200_000);
    env.play(&alice, board, &moves[20..]).expect("play rest");
    let b: Board = env.load_bp(board);
    assert_eq!(b.score, replay_score(seed, &moves));
    assert_eq!(usize::from(b.moves), moves.len());
    let logged: Vec<u32> = b.log[..moves.len()].to_vec();
    let expected: Vec<u32> = moves
        .iter()
        .map(|m| u32::from(m.piece) | (u32::from(m.x) << 16) | (u32::from(m.y) << 24))
        .collect();
    assert_eq!(logged, expected);

    // The play window closes 90 s (+10 s grace) after begin_run.
    let t = env.now();
    env.set_time(t + 101);
    let more = greedy(seed, 31);
    let err = env.play(&alice, board, &more[30..]).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::PlayWindowClosed)
    );
}

#[test]
fn higher_replayed_score_wins_and_the_pot_settles_through_tesoro_core() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.ready(&alice, &bob);
    let (ba, bb) = (env.board(id, 0), env.board(id, 1));
    env.begin(&alice, ba).expect("begin a");
    env.begin(&bob, bb).expect("begin b");
    let strong = greedy(seed, 30);
    let weak = greedy(seed, 10);
    assert!(replay_score(seed, &strong) > replay_score(seed, &weak));
    env.play(&alice, ba, &strong).expect("alice plays");
    env.play(&bob, bb, &weak).expect("bob plays");

    // Not sealable while a run is open.
    let err = env.seal(id).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::NotSealable)
    );
    env.finish(&alice, ba).expect("finish a");
    env.finish(&bob, bb).expect("finish b");
    let err = env.play(&bob, bb, &greedy(seed, 11)[10..]).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::RunClosed)
    );

    // Settling before sealing is refused.
    let err = env.settle(id, MatchResult::Opener).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::NotSealed)
    );
    env.seal(id).expect("seal");
    env.settle(id, MatchResult::Opener).expect("settle");

    let m = env.load_core::<MatchState>(match_pda(id)).inner;
    assert_eq!(m.status, MatchStatus::Settled);
    // Winner takes the loser's entry minus fees (200 + 300 bps of the 2,000 Pot = 100 Gemas, taken from the loser).
    assert_eq!(env.total(&alice), 75_000 + ENTRY - 100);
    assert_eq!(env.total(&bob), 75_000 - ENTRY);
    let session: Session = env.load_bp(session_pda(match_pda(id)));
    assert!(session.settled);
    assert_eq!(session.result, 0);
    assert_eq!(
        session.scores,
        [replay_score(seed, &strong), replay_score(seed, &weak)]
    );

    // No double settlement, here or in tesoro_core.
    let err = env.settle(id, MatchResult::Opener).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::AlreadySettled)
    );
    assert_eq!(env.total(&alice), 75_000 + ENTRY - 100);
}

#[test]
fn a_bad_result_cannot_be_forced_only_the_replayed_scores_decide() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.ready(&alice, &bob);
    let (ba, bb) = (env.board(id, 0), env.board(id, 1));
    env.begin(&alice, ba).expect("begin a");
    env.begin(&bob, bb).expect("begin b");
    env.play(&alice, ba, &greedy(seed, 5)).expect("alice");
    env.play(&bob, bb, &greedy(seed, 25)).expect("bob");
    env.finish(&alice, ba).expect("finish");
    env.finish(&bob, bb).expect("finish");
    env.seal(id).expect("seal");
    // The caller-supplied payout list is derived for an Opener win, but Bob scored higher:
    // the CPI settles as Joiner, so the wrong payout accounts are rejected by tesoro_core.
    let wrong = env.payout_metas(id, MatchResult::Opener);
    let ix = bp_ix(
        env.settle_accounts(id, a(env.stranger.pubkey()), authority()),
        block_puzzle::instruction::Settle {},
        wrong,
    );
    let payer = env.stranger.insecure_clone();
    assert!(env.send(&[ix], &payer, &[]).is_err());
    assert_eq!(
        env.load_core::<MatchState>(match_pda(id)).inner.status,
        MatchStatus::Active
    );
    env.settle(id, MatchResult::Joiner).expect("settle");
    assert_eq!(env.total(&bob), 75_000 + ENTRY - 100);
}

#[test]
fn equal_scores_draw_and_refund_both_entries() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.ready(&alice, &bob);
    let (ba, bb) = (env.board(id, 0), env.board(id, 1));
    env.begin(&alice, ba).expect("begin a");
    env.begin(&bob, bb).expect("begin b");
    let moves = greedy(seed, 12);
    env.play(&alice, ba, &moves).expect("alice");
    env.play(&bob, bb, &moves).expect("bob");
    env.finish(&alice, ba).expect("finish");
    env.finish(&bob, bb).expect("finish");
    env.seal(id).expect("seal");
    env.settle(id, MatchResult::Draw).expect("settle");
    assert_eq!(
        env.load_core::<MatchState>(match_pda(id)).inner.status,
        MatchStatus::Refunded
    );
    assert_eq!(env.total(&alice), 75_000);
    assert_eq!(env.total(&bob), 75_000);
    assert_eq!(env.load_bp::<Session>(session_pda(match_pda(id))).result, 2);
}

#[test]
fn a_player_who_never_begins_forfeits_after_the_deadline() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.ready(&alice, &bob);
    let (ba, bb) = (env.board(id, 0), env.board(id, 1));
    env.begin(&alice, ba).expect("begin a");
    env.play(&alice, ba, &greedy(seed, 4)).expect("alice");
    env.finish(&alice, ba).expect("finish");

    // Bob has 24h: nobody can seal early.
    let err = env.seal(id).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::NotSealable)
    );
    let deadline = env.load_bp::<Session>(session_pda(match_pda(id))).deadline;
    env.set_time(deadline - 1);
    assert!(env.seal(id).is_err());
    // Bob still cannot begin after the deadline.
    env.set_time(deadline);
    let err = env.begin(&bob, bb).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::DeadlinePassed)
    );
    env.seal(id).expect("seal at deadline");
    env.settle(id, MatchResult::Opener).expect("settle");
    assert_eq!(env.total(&alice), 75_000 + ENTRY - 100);
    assert_eq!(env.total(&bob), 75_000 - ENTRY);
}

#[test]
fn a_player_who_began_but_never_finished_is_scored_after_the_window() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.ready(&alice, &bob);
    let (ba, bb) = (env.board(id, 0), env.board(id, 1));
    env.begin(&alice, ba).expect("begin a");
    env.begin(&bob, bb).expect("begin b");
    env.play(&alice, ba, &greedy(seed, 6)).expect("alice");
    env.play(&bob, bb, &greedy(seed, 9)).expect("bob");
    // Neither calls finish; once 100 s pass both runs are closed and anyone may seal.
    assert!(env.seal(id).is_err());
    let t = env.now();
    env.set_time(t + 101);
    env.seal(id).expect("seal");
    env.settle(id, MatchResult::Joiner).expect("settle");
    assert_eq!(env.total(&bob), 75_000 + ENTRY - 100);
}

#[test]
fn claim_timeout_refunds_a_match_nobody_played_and_only_after_the_deadline() {
    let (mut env, alice, bob) = Env::new();
    let (id, _) = env.ready(&alice, &bob);
    let err = env.claim_timeout(id).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::NotExpired)
    );
    let deadline = env.load_bp::<Session>(session_pda(match_pda(id))).deadline;
    env.set_time(deadline);
    env.claim_timeout(id).expect("claim");
    assert_eq!(
        env.load_core::<MatchState>(match_pda(id)).inner.status,
        MatchStatus::Refunded
    );
    assert_eq!(env.total(&alice), 75_000);
    assert_eq!(env.total(&bob), 75_000);
    let err = env.claim_timeout(id).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::AlreadySettled)
    );
}

#[test]
fn claim_timeout_is_not_a_way_to_skip_a_played_board() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.ready(&alice, &bob);
    let ba = env.board(id, 0);
    env.begin(&alice, ba).expect("begin");
    env.play(&alice, ba, &greedy(seed, 3)).expect("play");
    let deadline = env.load_bp::<Session>(session_pda(match_pda(id))).deadline;
    env.set_time(deadline + 1);
    let err = env.claim_timeout(id).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::NotExpired)
    );
}

#[test]
fn only_the_registered_authority_settles() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.ready(&alice, &bob);
    let (ba, bb) = (env.board(id, 0), env.board(id, 1));
    env.begin(&alice, ba).expect("begin a");
    env.begin(&bob, bb).expect("begin b");
    env.play(&alice, ba, &greedy(seed, 8)).expect("alice");
    env.play(&bob, bb, &greedy(seed, 2)).expect("bob");
    env.finish(&alice, ba).expect("finish");
    env.finish(&bob, bb).expect("finish");
    env.seal(id).expect("seal");

    // Straight to tesoro_core with the Player's own key: Unauthorized.
    let remaining = env.payout_metas(id, MatchResult::Opener);
    let direct = core_ix(
        tesoro_core::accounts::SettleMatch {
            game_authority: alice.key,
            config: core_pda(&[CONFIG_SEED]),
            match_state: match_pda(id),
        },
        tesoro_core::instruction::SettleMatch {
            result: MatchResult::Opener,
        },
        remaining.clone(),
    );
    let err = env.send(&[direct], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), 6000);

    // Through block_puzzle with a different authority account: the PDA seeds do not match.
    let ix = bp_ix(
        env.settle_accounts(id, a(env.stranger.pubkey()), alice.key),
        block_puzzle::instruction::Settle {},
        remaining,
    );
    let payer = env.stranger.insecure_clone();
    assert!(env.send(&[ix], &payer, &[]).is_err());
    assert_eq!(
        env.load_core::<MatchState>(match_pda(id)).inner.status,
        MatchStatus::Active
    );
    env.settle(id, MatchResult::Opener).expect("real settle");
}

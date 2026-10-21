//! LiteSVM tests of the Block Puzzle Game program together with `tesoro_core`
//! (`pnpm build:programs` first). LiteSVM has no delegation program, so Boards stay owned by
//! `block_puzzle` here: everything that runs in the rollup on devnet (begin_run, play, finish,
//! seal) is exercised directly; delegation, permissions and commit are covered by the devnet
//! run recorded in docs/games/block-puzzle.md.
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use block_puzzle::engine::{self, piece_at, State};
use block_puzzle::{
    Board, SeedVault, Session, AUTHORITY_SEED, BOARD_SEED, SESSION_SEED, VAULT_SEED,
};
use litesvm::LiteSVM;
use solana_sdk::clock::Clock;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
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

/// The Game's record in tesoro_core, and the loader accounts `open_match` reads its deploy slot from.
fn game_record_pda() -> APk {
    APk::find_program_address(&[GAME_SEED, block_puzzle::ID.as_ref()], &tesoro_core::ID).0
}
fn program_data_pda() -> APk {
    APk::find_program_address(
        &[block_puzzle::ID.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    )
    .0
}

/// ComputeBudget `SetComputeUnitLimit`: `list_game` hashes the whole game program.
fn cu_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: s(APk::from_str_const(
            "ComputeBudget111111111111111111111111111111",
        )),
        accounts: vec![],
        data,
    }
}

/// Makes `key` the upgrade authority of the Game program loaded into `svm` and returns the slot the
/// loader recorded for its deployment; here: the hash tesoro_core approves (SHA-256 of the
/// executable without trailing zeros).
fn control_program(svm: &mut LiteSVM, program: APk, key: APk) -> [u8; 32] {
    let pd = s(APk::find_program_address(
        &[program.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    )
    .0);
    let mut acct = svm.get_account(&pd).expect("program data");
    acct.data[12] = 1;
    acct.data[13..45].copy_from_slice(key.as_ref());
    let code = &acct.data[45..];
    let end = code.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
    let hash = solana_sdk::hash::hash(&code[..end]).to_bytes();
    svm.set_account(pd, acct).expect("set program data");
    hash
}
fn pair_pda(opener: APk, joiner: APk) -> APk {
    APk::find_program_address(
        &[PAIR_SEED, opener.as_ref(), joiner.as_ref()],
        &tesoro_core::ID,
    )
    .0
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
fn vault_pda(session: APk) -> APk {
    bp_pda(&[VAULT_SEED, session.as_ref()])
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
        let ctl = Keypair::new();
        let hash = control_program(&mut env.svm, block_puzzle::ID, a(ctl.pubkey()));
        let register = core_ix(
            tesoro_core::accounts::RegisterGame {
                payer: a(admin.pubkey()),
                control: a(ctl.pubkey()),
                config,
                game_program: block_puzzle::ID,
                program_data: program_data_pda(),
                studio_recipient: studio.0,
                game_record: game_record_pda(),
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::RegisterGame {
                settle_authority: authority(),
                studio_bps: 300,
            },
            vec![],
        );
        env.send(&[register], &admin, &[&ctl])
            .expect("register game");
        env.send_core_admin(
            &admin,
            core_ix(
                tesoro_core::accounts::ListGame {
                    admin: a(admin.pubkey()),
                    config,
                    game_record: game_record_pda(),
                    game_program: block_puzzle::ID,
                    program_data: program_data_pda(),
                },
                tesoro_core::instruction::ListGame {
                    listed_until: 4_000_000_000,
                    approved_hash: hash,
                },
                vec![],
            ),
        );
        let alice = env.staker(1);
        let bob = env.staker(2);
        (env, alice, bob)
    }

    fn send_core_admin(&mut self, payer: &Keypair, ix: Instruction) {
        self.send(&[cu_limit(1_400_000), ix], payer, &[])
            .expect("core admin ix");
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
                basket: tesoro_core::storage::basket_address(&account).0,
                spill: tesoro_core::storage::spill_address(&account).0,
                invite_gate: tesoro_core::state::invite_gate_pda(),
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
        let asset = APk::new_unique();
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
                source_asset: asset,
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
                treasury: tesoro_core_treasury(),
                owner_account: account,
                protections: core_pda(&[PROTECTIONS_SEED, account.as_ref()]),
                position,
                source,
                book: tesoro_core::storage::book_address(&source).0,
                basket: tesoro_core::storage::basket_address(&account).0,
                spill: tesoro_core::storage::spill_address(&account).0,
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::TakeAdvance {
                horizon_months: 6,
                price_micro_usd: 150_000_000,
            },
            vec![AccountMeta::new_readonly(
                s(APk::find_program_address(
                    &[tesoro_core::state::ONCHAIN_PRICE_SEED, asset.as_ref()],
                    &tesoro_core::ID,
                )
                .0),
                false,
            )],
        );
        put_core_treasury(&mut self.svm);
        self.send(&[advance], &oracle, &[&kp]).expect("advance");
        self.open_holding(account, source);
        forge_holding_amount(&mut self.svm, account, source);
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

    fn open(&mut self, alice: &Person) -> u64 {
        let id = self.next_match;
        self.next_match += 1;
        let open = core_ix(
            tesoro_core::accounts::OpenMatch {
                player_authority: alice.key,
                config: core_pda(&[CONFIG_SEED]),
                game_record: game_record_pda(),
                game_program: block_puzzle::ID,
                program_data: program_data_pda(),
                player_account: alice.account,
                protections: core_pda(&[PROTECTIONS_SEED, alice.account.as_ref()]),
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
        id
    }

    fn opener_account(&self, id: u64) -> APk {
        APk::new_from_array(self.load_core::<MatchState>(match_pda(id)).inner.a.player)
    }

    fn join(&mut self, bob: &Person, id: u64) -> Res {
        let join = core_ix(
            tesoro_core::accounts::JoinMatch {
                player_authority: bob.key,
                player_account: bob.account,
                protections: core_pda(&[PROTECTIONS_SEED, bob.account.as_ref()]),
                match_state: match_pda(id),
                opener_protections: core_pda(&[PROTECTIONS_SEED, self.opener_account(id).as_ref()]),
                pair: pair_pda(self.opener_account(id), bob.account),
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::JoinMatch {},
            vec![rem(bob.holding)],
        );
        self.send(&[join], &bob.kp, &[])
    }

    fn open_session(&mut self, alice: &Person, id: u64) -> Res {
        let m = match_pda(id);
        let session = session_pda(m);
        let ix = bp_ix(
            block_puzzle::accounts::OpenSession {
                payer: a(self.stranger.pubkey()),
                match_state: m,
                account_a: alice.account,
                session,
                board_0: board_pda(session, 0),
                vault: vault_pda(session),
                authority: authority(),
                game_record: game_record_pda(),
                tesoro_core_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            block_puzzle::instruction::OpenSession {},
            vec![],
        );
        let payer = self.stranger.insecure_clone();
        self.send(&[ix], &payer, &[])
    }

    fn join_session(&mut self, bob: &Person, id: u64) -> Res {
        let m = match_pda(id);
        let session = session_pda(m);
        let ix = bp_ix(
            block_puzzle::accounts::JoinSession {
                payer: a(self.stranger.pubkey()),
                session,
                match_state: m,
                account_b: bob.account,
                board_1: board_pda(session, 1),
                authority: authority(),
                game_record: game_record_pda(),
                tesoro_core_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            block_puzzle::instruction::JoinSession {},
            vec![],
        );
        let payer = self.stranger.insecure_clone();
        self.send(&[ix], &payer, &[])
    }

    /// A stranger asks tesoro_core to refund an unjoined Match of `alice`.
    fn refund_as_stranger(&mut self, alice: &Person, id: u64) -> Res {
        let payer = self.stranger.insecure_clone();
        let mut metas = to_metas(
            tesoro_core::accounts::RefundMatch {
                caller: a(payer.pubkey()),
                game_record: game_record_pda(),
                match_state: match_pda(id),
                opener_protections: None,
            }
            .to_account_metas(None),
        );
        metas.push(rem(alice.account));
        metas.push(rem(alice.holding));
        let ix = Instruction {
            program_id: s(tesoro_core::ID),
            accounts: metas,
            data: tesoro_core::instruction::RefundMatch {}.data(),
        };
        self.send(&[ix], &payer, &[])
    }

    fn vault(&self, id: u64) -> APk {
        vault_pda(session_pda(match_pda(id)))
    }

    /// What the rollup does in `init_vault_permission`, `init_permission` and the VRF callback,
    /// none of which LiteSVM can run: the Seed lands in the SeedVault and nowhere else.
    fn prepare_opener(&mut self, id: u64) -> u64 {
        let seed = block_puzzle::derive_seed(&match_pda(id), &[id as u8; 32]);
        let vault = self.vault(id);
        let mut acct = self.svm.get_account(&s(vault)).expect("vault exists");
        let mut v = SeedVault::try_deserialize(&mut acct.data.as_slice()).expect("deserialize");
        v.permission_ready = true;
        v.ready = true;
        v.seed = seed;
        let mut buf = Vec::new();
        v.try_serialize(&mut buf).expect("serialize");
        acct.data[..buf.len()].copy_from_slice(&buf);
        self.svm.set_account(s(vault), acct).expect("set account");
        self.patch_board(self.board(id, 0), |b| b.permission_ready = true);
        seed
    }

    /// Match opened and its Session started; the SeedVault holds the Seed. The opener can play.
    fn opened(&mut self, alice: &Person) -> (u64, u64) {
        let id = self.open(alice);
        self.open_session(alice, id).expect("open session");
        let seed = self.prepare_opener(id);
        (id, seed)
    }

    /// The second Player joins the Match and its Session.
    fn joined(&mut self, bob: &Person, id: u64) {
        self.join(bob, id).expect("join match");
        self.join_session(bob, id).expect("join session");
        self.patch_board(self.board(id, 1), |b| b.permission_ready = true);
    }

    /// Both Players paired before anyone plays. Returns (match id, seed).
    fn ready(&mut self, alice: &Person, bob: &Person) -> (u64, u64) {
        let (id, seed) = self.opened(alice);
        self.joined(bob, id);
        (id, seed)
    }

    fn board(&self, id: u64, seat: u8) -> APk {
        board_pda(session_pda(match_pda(id)), seat)
    }

    fn begin(&mut self, p: &Person, board: APk) -> Res {
        let session = self.load_bp::<Board>(board).session;
        let ix = bp_ix(
            block_puzzle::accounts::BeginRun {
                player: p.key,
                board,
                vault: vault_pda(session),
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
            game_record: game_record_pda(),
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
fn a_session_needs_an_open_match_of_this_game_opened_by_the_account_given() {
    let (mut env, alice, bob) = Env::new();
    let id = env.open(&alice);
    // The opener's Account must be the one on the Match.
    let err = env.open_session(&bob, id).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::InvalidAccount)
    );
    env.open_session(&alice, id).expect("open session");
    let session: Session = env.load_bp(session_pda(match_pda(id)));
    let m = env.load_core::<MatchState>(match_pda(id)).inner;
    assert_eq!(session.players[0], alice.key);
    assert!(!session.joined);
    // The Queue holds the entry a day, not tesoro_core's hour.
    assert_eq!(m.deadline, env.now() + block_puzzle::QUEUE_WINDOW_SECS);
    let opener_deadline = m.deadline + block_puzzle::SUBMISSION_SECS;
    assert_eq!(session.opener_deadline, opener_deadline);
    let board: Board = env.load_bp(env.board(id, 0));
    assert_eq!(board.player, alice.key);
    assert_eq!(board.deadline, opener_deadline);
    // Once per Match.
    assert!(env.open_session(&alice, id).is_err());

    // The Queue window cannot be past.
    let id3 = env.open(&alice);
    env.set_time(env.now() + tesoro_core::ledger::MATCH_TIMEOUT_SECS);

    let err = env.open_session(&alice, id3).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::DeadlinePassed)
    );
}

#[test]
fn an_unjoined_block_puzzle_match_waits_a_day_before_anyone_can_refund_it() {
    let (mut env, alice, _bob) = Env::new();
    let (id, _) = env.opened(&alice);
    let t0 = env.now();
    // An hour in the Match is still Open and joinable; the refund is not open to a stranger.
    env.set_time(t0 + tesoro_core::ledger::MATCH_TIMEOUT_SECS + 1);
    let err = env.refund_as_stranger(&alice, id).unwrap_err();
    assert_eq!(
        code(&err),
        6000 + 100 + tesoro_core::ledger::CoreError::NotExpired.code()
    );
    assert_eq!(env.total(&alice), 75_000 - ENTRY);
    // The window closes a day after the Session opened.
    env.set_time(t0 + block_puzzle::QUEUE_WINDOW_SECS + 1);
    env.refund_as_stranger(&alice, id)
        .expect("refund after a day");
    assert_eq!(env.total(&alice), 75_000);
}

#[test]
fn joining_binds_the_second_player_and_extends_the_match_deadline() {
    let (mut env, alice, bob) = Env::new();
    let (id, _) = env.opened(&alice);
    // Nobody has joined: no second Board yet, and the Match cannot get one.
    let err = env.join_session(&bob, id).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::InvalidMatch)
    );
    assert!(env.svm.get_account(&s(env.board(id, 1))).is_none());

    env.join(&bob, id).expect("join match");
    // Only the Account that joined the Match can be bound.
    let carol = env.staker(3);
    let err = env.join_session(&carol, id).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::InvalidAccount)
    );
    env.join_session(&bob, id).expect("join session");
    let session: Session = env.load_bp(session_pda(match_pda(id)));
    assert!(session.joined);
    assert_eq!(session.players[1], bob.key);
    assert_eq!(session.deadline, env.now() + block_puzzle::SUBMISSION_SECS);
    let b1: Board = env.load_bp(env.board(id, 1));
    assert_eq!((b1.player, b1.deadline), (bob.key, session.deadline));
    let m = env.load_core::<MatchState>(match_pda(id)).inner;
    // The refund window closes after both Boards' deadlines, the opener's included.
    assert_eq!(
        m.deadline,
        session.deadline.max(session.opener_deadline) + block_puzzle::SETTLE_GRACE_SECS
    );
    // Once only: the second Board already exists.
    assert!(env.join_session(&bob, id).is_err());
}

#[test]
fn the_opener_plays_a_full_run_before_anyone_is_paired() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.opened(&alice);
    let ba = env.board(id, 0);
    env.begin(&alice, ba).expect("begin");
    let moves = greedy(seed, 30);
    env.play(&alice, ba, &moves).expect("play");
    env.finish(&alice, ba).expect("finish");
    let b: Board = env.load_bp(ba);
    assert_eq!(b.score, replay_score(seed, &moves));
    // The Match is still Open and the entry is still escrowed.
    let m = env.load_core::<MatchState>(match_pda(id)).inner;
    assert_eq!(m.status, MatchStatus::Open);
    assert_eq!(env.total(&alice), 75_000 - ENTRY);

    // Sealing needs the joiner's Board, which does not exist yet: nothing of the opener's
    // run can be committed (made public) before a joiner has played too.
    let payer = env.stranger.insecure_clone();
    let seal = bp_ix(
        block_puzzle::accounts::Seal {
            payer: a(payer.pubkey()),
            board_0: ba,
            board_1: env.board(id, 1),
        },
        block_puzzle::instruction::Seal {},
        vec![],
    );
    assert!(env.send(&[seal], &payer, &[]).is_err());

    // The joiner arrives later and plays the same Seed against the opener's stored score.
    env.set_time(env.now() + 1_800);
    env.joined(&bob, id);
    let bb = env.board(id, 1);
    env.begin(&bob, bb).expect("bob begins");
    assert_eq!(env.load_bp::<Board>(bb).seed, seed);
    let weaker = greedy(seed, 8);
    env.play(&bob, bb, &weaker).expect("bob plays");
    env.finish(&bob, bb).expect("bob finishes");
    env.seal(id).expect("seal");
    env.settle(id, MatchResult::Opener).expect("settle");
    assert_eq!(env.total(&alice), 75_000 + ENTRY - 100);
    assert_eq!(env.total(&bob), 75_000 - ENTRY);
    let session: Session = env.load_bp(session_pda(match_pda(id)));
    assert_eq!(session.seed, seed);
    assert_eq!(session.result, 0);
}

#[test]
fn the_joiner_can_win_against_the_opener_who_played_first() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.opened(&alice);
    let ba = env.board(id, 0);
    env.begin(&alice, ba).expect("begin");
    env.play(&alice, ba, &greedy(seed, 6)).expect("play");
    env.finish(&alice, ba).expect("finish");
    env.joined(&bob, id);
    let bb = env.board(id, 1);
    env.begin(&bob, bb).expect("begin");
    env.play(&bob, bb, &greedy(seed, 28)).expect("play");
    env.finish(&bob, bb).expect("finish");
    env.seal(id).expect("seal");
    env.settle(id, MatchResult::Joiner).expect("settle");
    assert_eq!(env.total(&bob), 75_000 + ENTRY - 100);
    assert_eq!(env.total(&alice), 75_000 - ENTRY);
}

#[test]
fn the_seed_is_only_in_the_vault_until_a_player_begins() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.opened(&alice);
    env.joined(&bob, id);
    let needle = seed.to_le_bytes();
    let holds_seed = |env: &Env, k: APk| {
        env.svm
            .get_account(&s(k))
            .expect("account exists")
            .data
            .windows(8)
            .any(|w| w == needle)
    };
    let session = session_pda(match_pda(id));
    // Before any run begins, the Seed is in the SeedVault alone: not in the Session, not in
    // either Board (those are what a Player reads in the rollup, or anyone reads on the base).
    assert!(holds_seed(&env, env.vault(id)));
    for k in [session, env.board(id, 0), env.board(id, 1)] {
        assert!(!holds_seed(&env, k), "seed leaked before begin_run");
    }
    assert_eq!(env.load_bp::<Board>(env.board(id, 0)).seed, 0);

    // Nobody can start another Player's run.
    let err = env.begin(&bob, env.board(id, 0)).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::NotThePlayer)
    );
    // Beginning copies the Seed into the beginning Player's own Board only.
    env.begin(&alice, env.board(id, 0)).expect("begin");
    assert!(holds_seed(&env, env.board(id, 0)));
    assert!(!holds_seed(&env, env.board(id, 1)));
    assert!(!holds_seed(&env, session));
    env.begin(&bob, env.board(id, 1)).expect("begin");
    assert!(holds_seed(&env, env.board(id, 1)));
}

#[test]
fn a_run_cannot_begin_before_the_seed_is_drawn() {
    let (mut env, alice, _bob) = Env::new();
    let id = env.open(&alice);
    env.open_session(&alice, id).expect("open session");
    let ba = env.board(id, 0);
    env.patch_board(ba, |b| b.permission_ready = true);
    let err = env.begin(&alice, ba).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::SeedNotReady)
    );
    let check = bp_ix(
        block_puzzle::accounts::CheckSeed {
            payer: alice.key,
            vault: env.vault(id),
        },
        block_puzzle::instruction::CheckSeed {},
        vec![],
    );
    let err = env
        .send(std::slice::from_ref(&check), &alice.kp, &[])
        .unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::SeedNotReady)
    );
    env.prepare_opener(id);
    env.send(&[check], &alice.kp, &[]).expect("seed is ready");
    env.begin(&alice, ba).expect("begin");
}

#[test]
fn the_opener_who_never_begins_forfeits_once_their_window_closes() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.opened(&alice);
    env.joined(&bob, id);
    let bb = env.board(id, 1);
    env.begin(&bob, bb).expect("begin");
    env.play(&bob, bb, &greedy(seed, 3)).expect("play");
    env.finish(&bob, bb).expect("finish");
    // Alice still has her Queue window: nobody can seal early.
    assert!(env.seal(id).is_err());
    let opener_deadline = env
        .load_bp::<Session>(session_pda(match_pda(id)))
        .opener_deadline;
    env.set_time(opener_deadline);
    let err = env.begin(&alice, env.board(id, 0)).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::DeadlinePassed)
    );
    env.seal(id).expect("seal");
    env.settle(id, MatchResult::Joiner).expect("settle");
    assert_eq!(env.total(&bob), 75_000 + ENTRY - 100);
}

#[test]
fn a_match_nobody_joins_is_refunded_to_the_opener_after_they_played() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.opened(&alice);
    let ba = env.board(id, 0);
    env.begin(&alice, ba).expect("begin");
    env.play(&alice, ba, &greedy(seed, 10)).expect("play");
    env.finish(&alice, ba).expect("finish");
    assert_eq!(env.total(&alice), 75_000 - ENTRY);

    // Not before the Queue window, and not by a stranger.
    let payer = env.stranger.insecure_clone();
    let refund = |env: &Env, caller: APk| {
        let mut metas = to_metas(
            tesoro_core::accounts::RefundMatch {
                caller,
                game_record: game_record_pda(),
                match_state: match_pda(id),
                opener_protections: None,
            }
            .to_account_metas(None),
        );
        metas.push(rem(alice.account));
        metas.push(rem(alice.holding));
        let _ = env;
        Instruction {
            program_id: s(tesoro_core::ID),
            accounts: metas,
            data: tesoro_core::instruction::RefundMatch {}.data(),
        }
    };
    let ix = refund(&env, a(payer.pubkey()));
    assert!(env.send(std::slice::from_ref(&ix), &payer, &[]).is_err());
    // Expired means nobody can join either.
    env.set_time(env.now() + block_puzzle::QUEUE_WINDOW_SECS);
    let err = env.join(&bob, id).unwrap_err();
    assert_eq!(
        code(&err),
        6000 + 100 + tesoro_core::ledger::CoreError::Expired.code()
    );
    env.send(&[ix], &payer, &[])
        .expect("anyone refunds after the window");
    assert_eq!(env.total(&alice), 75_000);
    let m = env.load_core::<MatchState>(match_pda(id)).inner;
    assert_eq!(m.status, MatchStatus::Refunded);
}

#[test]
fn the_opener_can_cancel_an_unjoined_match_at_once() {
    let (mut env, alice, _bob) = Env::new();
    let (id, _) = env.opened(&alice);
    let mut metas = to_metas(
        tesoro_core::accounts::RefundMatch {
            caller: alice.key,
            game_record: game_record_pda(),
            match_state: match_pda(id),
            opener_protections: None,
        }
        .to_account_metas(None),
    );
    metas.push(rem(alice.account));
    metas.push(rem(alice.holding));
    let ix = Instruction {
        program_id: s(tesoro_core::ID),
        accounts: metas,
        data: tesoro_core::instruction::RefundMatch {}.data(),
    };
    env.send(&[ix], &alice.kp, &[]).expect("cancel");
    assert_eq!(env.total(&alice), 75_000);
}

#[test]
fn score_is_the_engine_replay_and_illegal_moves_are_rejected() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.ready(&alice, &bob);
    let board = env.board(id, 0);

    // Cannot play before begin_run, nor can the opponent play this Board.
    let moves = greedy(seed, 30);
    assert_eq!(
        moves.len(),
        30,
        "the Seed is fixed per Match id, so this is deterministic"
    );
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
    assert!(
        more.len() > 30,
        "this test needs a Seed whose greedy game lasts 31 moves"
    );
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
            game_record: game_record_pda(),
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

// --- Security audit 2026-09-30: proof tests ------------------------------------------------------
// Security review 2026-09-30 (findings F-01, F-02, F-06, F-09).

use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

fn sdk_key(p: ephemeral_rollups_sdk::compat::Pubkey) -> APk {
    APk::new_from_array(p.to_bytes())
}

fn permission_pda(target: APk) -> APk {
    APk::find_program_address(
        &[PERMISSION_SEED, target.as_ref()],
        &sdk_key(PERMISSION_PROGRAM_ID),
    )
    .0
}

fn logs_mention(e: &litesvm::types::FailedTransactionMetadata, needle: &str) -> bool {
    e.meta.logs.iter().any(|l| l.contains(needle))
}

/// F-01. `delegate_opener` / `delegate_joiner` are callable by anyone and used to pass whatever
/// validator the caller named (or none, which the delegation program reads as the public default
/// validator). The validator a delegation names is the only key that can commit state back, so
/// this let a Player forge a Board. Delegation is pinned to the TEE validator.
#[test]
fn f01_delegation_is_pinned_to_the_tee_validator() {
    let (mut env, alice, bob) = Env::new();
    let id = env.open(&alice);
    env.open_session(&alice, id).expect("open session");
    let session = session_pda(match_pda(id));
    let dlp = sdk_key(ephemeral_rollups_sdk::id());
    let derive = |seeds: &[&[u8]], program: &APk| APk::find_program_address(seeds, program).0;
    let buffer = |k: APk| derive(&[b"buffer", k.as_ref()], &block_puzzle::ID);
    let record = |k: APk| derive(&[b"delegation", k.as_ref()], &dlp);
    let meta = |k: APk| derive(&[b"delegation-metadata", k.as_ref()], &dlp);

    let attacker = Keypair::new();
    env.svm
        .airdrop(&attacker.pubkey(), 10 * SOL)
        .expect("airdrop");
    let (board_0, vault) = (board_pda(session, 0), vault_pda(session));
    for validator in [Some(a(attacker.pubkey())), None] {
        let ix = bp_ix(
            block_puzzle::accounts::DelegateOpener {
                payer: a(attacker.pubkey()),
                session,
                buffer_board_0: buffer(board_0),
                delegation_record_board_0: record(board_0),
                delegation_metadata_board_0: meta(board_0),
                board_0,
                buffer_vault: buffer(vault),
                delegation_record_vault: record(vault),
                delegation_metadata_vault: meta(vault),
                vault,
                validator,
                owner_program: block_puzzle::ID,
                delegation_program: dlp,
                system_program: anchor_lang::system_program::ID,
            },
            block_puzzle::instruction::DelegateOpener {},
            vec![],
        );
        let err = env.send(&[ix], &attacker, &[]).unwrap_err();
        assert!(
            logs_mention(&err, "InvalidValidator"),
            "validator {validator:?} must be refused, got {:?}",
            err.meta.logs
        );
    }

    // The joiner's Board is pinned the same way.
    env.join(&bob, id).expect("join");
    env.join_session(&bob, id).expect("join session");
    let board_1 = board_pda(session, 1);
    let ix = bp_ix(
        block_puzzle::accounts::DelegateJoiner {
            payer: a(attacker.pubkey()),
            session,
            buffer_board_1: buffer(board_1),
            delegation_record_board_1: record(board_1),
            delegation_metadata_board_1: meta(board_1),
            board_1,
            validator: Some(a(attacker.pubkey())),
            owner_program: block_puzzle::ID,
            delegation_program: dlp,
            system_program: anchor_lang::system_program::ID,
        },
        block_puzzle::instruction::DelegateJoiner {},
        vec![],
    );
    let err = env.send(&[ix], &attacker, &[]).unwrap_err();
    assert!(
        logs_mention(&err, "InvalidValidator"),
        "{:?}",
        err.meta.logs
    );
}

/// Audit 2026-10-16 G-1. The delegate instructions are permissionless and checked only the
/// validator, so a Board that had been committed back (sealed) could be delegated again by
/// anyone, after which `settle` cannot read it and the loser waits out the refund window instead
/// of losing. A Board delegates once, before its run begins.
#[test]
fn g01_a_sealed_board_cannot_be_delegated_again() {
    let (mut env, alice, bob) = Env::new();
    let id = env.open(&alice);
    env.open_session(&alice, id).expect("open session");
    env.join(&bob, id).expect("join");
    env.join_session(&bob, id).expect("join session");
    let session = session_pda(match_pda(id));
    let dlp = sdk_key(ephemeral_rollups_sdk::id());
    let derive = |seeds: &[&[u8]], program: &APk| APk::find_program_address(seeds, program).0;
    let buffer = |k: APk| derive(&[b"buffer", k.as_ref()], &block_puzzle::ID);
    let record = |k: APk| derive(&[b"delegation", k.as_ref()], &dlp);
    let meta = |k: APk| derive(&[b"delegation-metadata", k.as_ref()], &dlp);
    let attacker = Keypair::new();
    env.svm
        .airdrop(&attacker.pubkey(), 10 * SOL)
        .expect("airdrop");
    let (board_0, board_1, vault) = (
        board_pda(session, 0),
        board_pda(session, 1),
        vault_pda(session),
    );
    for k in [board_0, board_1] {
        env.patch_board(k, |b| {
            b.started_at = 1;
            b.sealed = true;
        });
    }
    let opener = bp_ix(
        block_puzzle::accounts::DelegateOpener {
            payer: a(attacker.pubkey()),
            session,
            buffer_board_0: buffer(board_0),
            delegation_record_board_0: record(board_0),
            delegation_metadata_board_0: meta(board_0),
            board_0,
            buffer_vault: buffer(vault),
            delegation_record_vault: record(vault),
            delegation_metadata_vault: meta(vault),
            vault,
            validator: Some(block_puzzle::TEE_VALIDATOR),
            owner_program: block_puzzle::ID,
            delegation_program: dlp,
            system_program: anchor_lang::system_program::ID,
        },
        block_puzzle::instruction::DelegateOpener {},
        vec![],
    );
    let err = env.send(&[opener], &attacker, &[]).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::AlreadyBegan)
    );
    let joiner = bp_ix(
        block_puzzle::accounts::DelegateJoiner {
            payer: a(attacker.pubkey()),
            session,
            buffer_board_1: buffer(board_1),
            delegation_record_board_1: record(board_1),
            delegation_metadata_board_1: meta(board_1),
            board_1,
            validator: Some(block_puzzle::TEE_VALIDATOR),
            owner_program: block_puzzle::ID,
            delegation_program: dlp,
            system_program: anchor_lang::system_program::ID,
        },
        block_puzzle::instruction::DelegateJoiner {},
        vec![],
    );
    let err = env.send(&[joiner], &attacker, &[]).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::AlreadyBegan)
    );
}

/// F-02. `init_permission` treated "the permission address holds lamports" as "the permission
/// exists". Anyone can put lamports on that address first, after which the Board (and the
/// SeedVault) is marked ready without ever being made private.
#[test]
fn f02_a_prefunded_permission_address_is_not_a_permission() {
    let (mut env, alice, _bob) = Env::new();
    let id = env.open(&alice);
    env.open_session(&alice, id).expect("open session");
    let session = session_pda(match_pda(id));
    let (board, vault) = (board_pda(session, 0), vault_pda(session));
    let attacker = Keypair::new();
    env.svm
        .airdrop(&attacker.pubkey(), 10 * SOL)
        .expect("airdrop");
    env.svm
        .airdrop(&s(permission_pda(board)), 1_000_000)
        .expect("dust");
    env.svm
        .airdrop(&s(permission_pda(vault)), 1_000_000)
        .expect("dust");

    let init_board = bp_ix(
        block_puzzle::accounts::InitPermission {
            payer: a(attacker.pubkey()),
            board,
            permission: permission_pda(board),
            permission_program: sdk_key(PERMISSION_PROGRAM_ID),
            ephemeral_vault: sdk_key(EPHEMERAL_VAULT_ID),
            magic_program: sdk_key(MAGIC_PROGRAM_ID),
        },
        block_puzzle::instruction::InitPermission {},
        vec![],
    );
    assert!(env.send(&[init_board], &attacker, &[]).is_err());
    assert!(!env.load_bp::<Board>(board).permission_ready);

    let init_vault = bp_ix(
        block_puzzle::accounts::InitVaultPermission {
            payer: a(attacker.pubkey()),
            vault,
            permission: permission_pda(vault),
            permission_program: sdk_key(PERMISSION_PROGRAM_ID),
            ephemeral_vault: sdk_key(EPHEMERAL_VAULT_ID),
            magic_program: sdk_key(MAGIC_PROGRAM_ID),
        },
        block_puzzle::instruction::InitVaultPermission {},
        vec![],
    );
    assert!(env.send(&[init_vault], &attacker, &[]).is_err());
    assert!(!env.load_bp::<SeedVault>(vault).permission_ready);
}

/// F-06. The opener's Board deadline was the Queue window's end, so joining the Match one second
/// before it left an opener who had not begun no time at all and the joiner won by forfeit. The
/// opener now has `SUBMISSION_SECS` past the window, never less than the joiner's own window.
#[test]
fn f06_joining_in_the_last_second_does_not_forfeit_an_opener_who_has_not_begun() {
    let (mut env, alice, bob) = Env::new();
    let id = env.open(&alice);
    env.open_session(&alice, id).expect("open session");
    let seed = env.prepare_opener(id);
    let queue_end = env.load_core::<MatchState>(match_pda(id)).inner.deadline;
    env.set_time(queue_end - 1);
    env.joined(&bob, id);
    let session: Session = env.load_bp(session_pda(match_pda(id)));
    assert!(
        session.opener_deadline >= session.deadline,
        "the opener never has less time than the joiner"
    );
    let bb = env.board(id, 1);
    env.begin(&bob, bb).expect("begin");
    env.play(&bob, bb, &greedy(seed, 2)).expect("play");
    env.finish(&bob, bb).expect("finish");
    // The Queue window has passed, and the opener still begins and plays.
    env.set_time(queue_end + 60);
    let ba = env.board(id, 0);
    env.begin(&alice, ba).expect("the opener can still begin");
    env.play(&alice, ba, &greedy(seed, 10)).expect("play");
    env.finish(&alice, ba).expect("finish");
    env.seal(id).expect("seal");
    env.settle(id, MatchResult::Opener).expect("settle");
    // Settlement always wins the race against a plain refund.
    let m = env.load_core::<MatchState>(match_pda(id)).inner;
    assert!(m.deadline >= session.opener_deadline + block_puzzle::SETTLE_GRACE_SECS);
}

/// F-09. `join_match` cannot require a Session, so anyone could join an Open Block Puzzle Match
/// before `open_session` ran and the Match could never get a Session (only the refund was left).
/// `open_session` now also binds a Match that was joined first, and `join_session` follows.
#[test]
fn f09_joining_before_the_session_exists_does_not_strand_the_match() {
    let (mut env, alice, bob) = Env::new();
    let id = env.open(&alice);
    env.join(&bob, id).expect("join before the session");
    // Still only the opener's own Account can open the Session.
    let err = env.open_session(&bob, id).unwrap_err();
    assert_eq!(
        code(&err),
        bp_err(block_puzzle::BlockPuzzleError::InvalidAccount)
    );
    env.open_session(&alice, id)
        .expect("session after the join");
    env.join_session(&bob, id).expect("join session");
    let session: Session = env.load_bp(session_pda(match_pda(id)));
    assert!(session.joined);
    assert_eq!(session.players, [alice.key, bob.key]);
    // Both can play it through.
    env.patch_board(env.board(id, 0), |b| b.permission_ready = true);
    env.patch_board(env.board(id, 1), |b| b.permission_ready = true);
    let seed = env.prepare_opener(id);
    let (ba, bb) = (env.board(id, 0), env.board(id, 1));
    env.begin(&alice, ba).expect("begin a");
    env.play(&alice, ba, &greedy(seed, 8)).expect("play a");
    env.finish(&alice, ba).expect("finish a");
    env.begin(&bob, bb).expect("begin b");
    env.play(&bob, bb, &greedy(seed, 2)).expect("play b");
    env.finish(&bob, bb).expect("finish b");
    env.seal(id).expect("seal");
    env.settle(id, MatchResult::Opener).expect("settle");
}

#[test]
fn each_logged_move_records_its_slot_offset_from_the_run_start() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.ready(&alice, &bob);
    let board = env.board(id, 0);
    let moves = greedy(seed, 30);
    let (t0, slot0) = (env.now(), env.slot);
    env.set_clock(t0, slot0 + 1000);
    env.begin(&alice, board).expect("begin");
    let started = env.load_bp::<Board>(board);
    assert_eq!(started.start_slot, slot0 + 1000);

    // Batches of 20 then 10, sent 7 and 50 slots after the start: every move in a batch shares
    // the batch's offset.
    env.set_clock(t0, slot0 + 1007);
    env.play(&alice, board, &moves[..20]).expect("batch 1");
    env.set_clock(t0, slot0 + 1050);
    env.play(&alice, board, &moves[20..]).expect("batch 2");
    let b: Board = env.load_bp(board);
    assert!(b.move_slots[..20].iter().all(|&o| o == 7));
    assert!(b.move_slots[20..30].iter().all(|&o| o == 50));
    assert!(b.move_slots[30..].iter().all(|&o| o == 0));

    // Replay and score are unaffected by timing.
    assert_eq!(b.score, replay_score(seed, &moves));
    assert_eq!(usize::from(b.moves), moves.len());
}

/// CU readings (run with `--nocapture`).
#[test]
fn cu_profile_block_puzzle() {
    let (mut env, alice, bob) = Env::new();
    let (id, seed) = env.ready(&alice, &bob);
    let (ba, bb) = (env.board(id, 0), env.board(id, 1));
    let begin = env.begin(&alice, ba).expect("begin").compute_units_consumed;
    let moves = greedy(seed, 41);
    let one = env
        .play(&alice, ba, &moves[..1])
        .expect("one move")
        .compute_units_consumed;
    let batch = env
        .play(&alice, ba, &moves[1..21])
        .expect("20 moves")
        .compute_units_consumed;
    env.finish(&alice, ba).expect("finish");
    env.begin(&bob, bb).expect("begin b");
    env.play(&bob, bb, &greedy(seed, 2)).expect("bob");
    env.finish(&bob, bb).expect("finish b");
    let seal = env.seal(id).expect("seal").compute_units_consumed;
    let settle = env
        .settle(id, MatchResult::Opener)
        .expect("settle")
        .compute_units_consumed;
    println!(
        "CU begin_run {begin}; play 1 move {one}; play 20 moves {batch} ({} per move); seal {seal}; settle (with tesoro_core CPI) {settle}",
        batch / 20
    );
    assert!(batch < 1_400_000);
}

/// tesoro_core's Treasury with no Yield Fee: these suites size Advances without it (its rate and
/// Instant Redeem are covered in tesoro_core's own tests).
fn put_core_treasury(svm: &mut litesvm::LiteSVM) {
    let (key, bump) = anchor_lang::prelude::Pubkey::find_program_address(
        &[tesoro_core::state::TREASURY_SEED],
        &tesoro_core::ID,
    );
    let treasury = tesoro_core::state::Treasury {
        bump,
        vault_bump: 0,
        account_bump: 0,
        yield_fee_bps: 0,
        instant_fee_bps: 3_500,
        account: Default::default(),
        vault: Default::default(),
        fee_minted: 0,
        instant_units: 0,
        funded_shares: 0,
        withdrawn_units: 0,
        company: Default::default(),
    };
    let mut data = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(&treasury, &mut data).expect("serialize");
    svm.set_account(
        solana_sdk::pubkey::Pubkey::new_from_array(key.to_bytes()),
        solana_sdk::account::Account {
            lamports: 1_000_000_000,
            data,
            owner: solana_sdk::pubkey::Pubkey::new_from_array(tesoro_core::ID.to_bytes()),
            executable: false,
            rent_epoch: 0,
        },
    )
    .expect("treasury");
}

fn tesoro_core_treasury() -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::find_program_address(
        &[tesoro_core::state::TREASURY_SEED],
        &tesoro_core::ID,
    )
    .0
}

/// Matching reads Holdings until ticket 09 moves it onto baskets: give the Advance's owner a
/// Holding of the new Source with the Gemas the Advance issued (the basket holds them too).
fn forge_holding_amount(svm: &mut litesvm::LiteSVM, account: APk, source: APk) {
    use anchor_lang::{AccountDeserialize, AccountSerialize};
    let issued = {
        let acc = svm.get_account(&s(source)).expect("source");
        SourceState::try_deserialize(&mut acc.data.as_slice())
            .expect("source")
            .inner
            .issued
    };
    let hk = holding_pda(account, source);
    let mut h = {
        let acc = svm.get_account(&s(hk)).expect("holding");
        HoldingState::try_deserialize(&mut acc.data.as_slice()).expect("holding")
    };
    let mut acct = {
        let acc = svm.get_account(&s(account)).expect("account");
        TesoroAccount::try_deserialize(&mut acc.data.as_slice()).expect("account")
    };
    h.inner.credit(&mut acct.inner, issued).expect("credit");
    for (k, buf) in [
        (hk, {
            let mut b = Vec::new();
            h.try_serialize(&mut b).unwrap();
            b.resize(HoldingState::SPACE, 0);
            b
        }),
        (account, {
            let mut b = Vec::new();
            acct.try_serialize(&mut b).unwrap();
            b.resize(TesoroAccount::SPACE, 0);
            b
        }),
    ] {
        let mut acc = svm.get_account(&s(k)).expect("account");
        acc.data = buf;
        svm.set_account(s(k), acc).expect("set");
    }
}

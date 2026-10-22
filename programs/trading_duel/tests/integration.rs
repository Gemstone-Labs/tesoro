//! LiteSVM tests: the real trading_duel and tesoro_core programs (`pnpm build:programs` first).
//!
//! LiteSVM has no delegation, permission or VRF programs, so the rollup-only steps
//! (`init_permissions`, `request_vrf`, the oracle callback, `close_match`) are stood in for by
//! writing the account state they would have produced. Everything else runs as deployed: `deal`
//! shuffles and deals, `act` and `claim_timeout` play the hand, and `finalize` settles or refunds
//! the tesoro_core Match by CPI signed by the `authority` PDA.
#![allow(clippy::result_large_err)]
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::account::Account;
use solana_sdk::clock::Clock;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use std::collections::HashMap;
use tesoro_core::ledger::lifecycle::Stage;
use tesoro_core::ledger::SourceChain;
use tesoro_core::state::*;
use trading_duel::{Assignment, Book, Table};

#[path = "../../tesoro_core/tests/common/flow.rs"]
mod flow;

const SOL: u64 = 1_000_000_000;
const T0: i64 = 1_000_000;

fn a(p: Pk) -> APk {
    APk::new_from_array(p.to_bytes())
}
fn s(p: APk) -> Pk {
    Pk::new_from_array(p.to_bytes())
}
fn tpda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &tesoro_core::ID).0
}

/// The Game's record in tesoro_core, and the loader accounts `open_match` reads its deploy slot from.
fn game_record_pda() -> APk {
    APk::find_program_address(&[GAME_SEED, trading_duel::ID.as_ref()], &tesoro_core::ID).0
}
fn program_data_pda() -> APk {
    APk::find_program_address(
        &[trading_duel::ID.as_ref()],
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

/// Makes `key` the upgrade authority of the Game program loaded into `svm`, as the Game's studio
/// would hold it, and returns the hash tesoro_core approves: SHA-256 of the executable without
/// trailing zeros.
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
fn dpda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &trading_duel::ID).0
}
fn account_pda(auth: APk) -> APk {
    tpda(&[ACCOUNT_SEED, auth.as_ref()])
}
fn authority_pda() -> APk {
    dpda(&[trading_duel::AUTHORITY_SEED])
}

fn ix(
    program: APk,
    accounts: impl ToAccountMetas,
    data: impl InstructionData,
    remaining: Vec<AccountMeta>,
) -> Instruction {
    let mut metas: Vec<AccountMeta> = accounts
        .to_account_metas(None)
        .into_iter()
        .map(|m| AccountMeta {
            pubkey: s(m.pubkey),
            is_signer: m.is_signer,
            is_writable: m.is_writable,
        })
        .collect();
    metas.extend(remaining);
    Instruction {
        program_id: s(program),
        accounts: metas,
        data: data.data(),
    }
}

fn rem(k: APk) -> AccountMeta {
    AccountMeta::new(s(k), false)
}

type Failed = litesvm::types::FailedTransactionMetadata;

fn custom_code(err: &Failed) -> u32 {
    use solana_sdk::instruction::InstructionError;
    use solana_sdk::transaction::TransactionError;
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => *c,
        other => panic!("unexpected error {other:?}\n{:?}", err.meta.logs),
    }
}

/// Anchor custom error code of a trading_duel error.
fn dcode(e: trading_duel::DuelError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

struct Person {
    kp: Keypair,
    key: APk,
    account: APk,
}

fn dup(p: &Person) -> Person {
    Person {
        kp: p.kp.insecure_clone(),
        key: p.key,
        account: p.account,
    }
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    oracle: Keypair,
    platform: Person,
    studio: Person,
    alice: Person,
    bob: Person,
    a_source: APk,
    b_source: APk,
    /// The Game's upgrade authority (names the operator).
    ctl: Keypair,
    /// The Game's operator: creates tables, assigns Matches.
    operator: Keypair,
    /// Asset of the next Match (0 SOL, 1 ETH, 2 HYPE).
    asset: u8,
    /// The tesoro_core Match under test.
    tmatch: APk,
    mref: Option<flow::MatchRef>,
    /// The table of the Match under test.
    table: APk,
    /// What base last saw of each table (the committed bytes), by table address.
    committed: HashMap<APk, Vec<u8>>,
    /// Pot nonces already used by Alice and Bob.
    nonce: u64,
    now: i64,
    last_cu: u64,
}

impl Env {
    fn send(
        &mut self,
        ixs: &[Instruction],
        payer: &Keypair,
        extra: &[&Keypair],
    ) -> Result<(), Failed> {
        self.svm.expire_blockhash();
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&payer.pubkey()),
            &signers,
            self.svm.latest_blockhash(),
        );
        match self.svm.send_transaction(tx) {
            Ok(meta) => {
                self.last_cu = meta.compute_units_consumed;
                Ok(())
            }
            Err(e) => {
                self.last_cu = e.meta.compute_units_consumed;
                Err(e)
            }
        }
    }

    fn person(&mut self) -> Person {
        let kp = Keypair::new();
        self.svm
            .airdrop(&kp.pubkey(), 1_000 * SOL)
            .expect("airdrop");
        let key = a(kp.pubkey());
        let account = account_pda(key);
        let create = ix(
            tesoro_core::ID,
            tesoro_core::accounts::CreateAccount {
                authority: key,
                account,
                basket: tesoro_core::storage::basket_address(&account).0,
                spill: tesoro_core::storage::spill_address(&account).0,
                invite_gate: tesoro_core::state::invite_gate_pda(),
                system_program: anchor_lang::system_program::ID,
                payer: key,
                sponsor: None,
            },
            tesoro_core::instruction::CreateAccount {
                evm_address: [0; 20],
            },
            vec![],
        );
        self.send(&[create], &kp, &[]).expect("create account");
        Person { kp, key, account }
    }

    fn set_time(&mut self, t: i64) {
        self.now = t;
        self.svm.set_sysvar(&Clock {
            unix_timestamp: t,
            ..Clock::default()
        });
    }

    /// Position + Advance: 75_000 Gemas of the staker's own Source.
    fn stake(&mut self, p: &Person, id: u8) -> APk {
        let position = tpda(&[POSITION_SEED, &[0], &[id; 32]]);
        let asset = APk::new_unique();
        let open = ix(
            tesoro_core::ID,
            tesoro_core::accounts::OpenPosition {
                oracle: a(self.oracle.pubkey()),
                config: tpda(&[CONFIG_SEED]),
                owner_account: p.account,
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
        let source = tpda(&[SOURCE_SEED, position.as_ref(), &0u32.to_le_bytes()]);
        let advance = ix(
            tesoro_core::ID,
            tesoro_core::accounts::TakeAdvance {
                oracle: a(self.oracle.pubkey()),
                owner_authority: p.key,
                config: tpda(&[CONFIG_SEED]),
                treasury: tesoro_core_treasury(),
                owner_account: p.account,
                protections: tpda(&[PROTECTIONS_SEED, p.account.as_ref()]),
                position,
                source,
                book: tesoro_core::storage::book_address(&source).0,
                basket: tesoro_core::storage::basket_address(&p.account).0,
                spill: tesoro_core::storage::spill_address(&p.account).0,
                economy: tpda(&[ECONOMY_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::TakeAdvance {
                horizon_months: 6,
                price_micro_usd: 150_000_000,
                min_gemas: 1,
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
        self.send(&[advance], &oracle, &[&p.kp]).expect("advance");
        source
    }

    fn load<T: AccountDeserialize>(&self, k: APk) -> T {
        let acct = self.svm.get_account(&s(k)).expect("account exists");
        T::try_deserialize(&mut acct.data.as_slice()).expect("deserialize")
    }

    fn store<T: AccountSerialize>(&mut self, k: APk, value: &T, owner: APk) {
        let mut data = Vec::new();
        value.try_serialize(&mut data).expect("serialize");
        let lamports = self
            .svm
            .get_account(&s(k))
            .map_or(SOL, |acct| acct.lamports);
        self.svm
            .set_account(
                s(k),
                Account {
                    lamports,
                    data,
                    owner: s(owner),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("set account");
    }
    fn table(&self) -> Table {
        self.load(self.table)
    }

    fn table_at(&self, k: APk) -> Table {
        self.load(k)
    }

    fn book(&self, seat: usize) -> Book {
        self.load(book_addr(self.table, seat as u8))
    }

    fn patch_table(&mut self, f: impl FnOnce(&mut Table)) {
        let mut t = self.table();
        f(&mut t);
        self.store(self.table, &t, trading_duel::ID);
    }

    fn gemas(&self, p: &Person) -> u64 {
        flow::gemas(&self.svm, p.account)
    }

    fn tesoro_status(&self) -> Stage {
        self.load::<MatchState>(self.tmatch).inner.stage()
    }

    fn operator_kp(&self) -> Keypair {
        self.operator.insecure_clone()
    }

    fn ctl_kp(&self) -> Keypair {
        self.ctl.insecure_clone()
    }

    /// The Game is registered and listed in tesoro_core, Alice and Bob each hold Gemas, the
    /// operator is configured, and the Sponsor and two tables exist and are "delegated" (their
    /// committed copy is the freshly created table).
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/");
        for (id, file) in [
            (tesoro_core::ID, "tesoro_core.so"),
            (trading_duel::ID, "trading_duel.so"),
        ] {
            let path = format!("{root}{file}");
            assert!(
                std::path::Path::new(&path).exists(),
                "build the programs first: pnpm build:programs"
            );
            svm.add_program_from_file(s(id), path)
                .expect("load program");
        }
        let placeholder = |kp: Keypair| Person {
            key: a(kp.pubkey()),
            account: APk::default(),
            kp,
        };
        let mut env = Self {
            svm,
            admin: Keypair::new(),
            oracle: Keypair::new(),
            platform: placeholder(Keypair::new()),
            studio: placeholder(Keypair::new()),
            alice: placeholder(Keypair::new()),
            bob: placeholder(Keypair::new()),
            a_source: APk::default(),
            b_source: APk::default(),
            ctl: Keypair::new(),
            operator: Keypair::new(),
            asset: 0,
            tmatch: APk::default(),
            mref: None,
            table: table_addr(0, 0),
            committed: HashMap::new(),
            nonce: 10,
            now: T0,
            last_cu: 0,
        };
        for k in [&env.admin, &env.oracle, &env.ctl, &env.operator] {
            env.svm.airdrop(&k.pubkey(), 1_000 * SOL).expect("airdrop");
        }
        env.set_time(T0);
        env.platform = env.person();
        env.studio = env.person();
        let init = ix(
            tesoro_core::ID,
            tesoro_core::accounts::InitializeConfig {
                admin: a(env.admin.pubkey()),
                config: tpda(&[CONFIG_SEED]),
                platform_recipient: env.platform.account,
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::InitializeConfig {
                oracle_authority: a(env.oracle.pubkey()),
                platform_bps: 200,
            },
            vec![],
        );
        let admin = env.admin.insecure_clone();
        env.send(&[init], &admin, &[]).expect("init config");
        flow::set_economy(&mut env.svm, &admin);
        // The Game authority is the trading_duel PDA, not a keypair.
        let ctl = env.ctl_kp();
        let hash = control_program(&mut env.svm, trading_duel::ID, a(ctl.pubkey()));
        let register = ix(
            tesoro_core::ID,
            tesoro_core::accounts::RegisterGame {
                payer: a(admin.pubkey()),
                control: a(ctl.pubkey()),
                config: tpda(&[CONFIG_SEED]),
                game_program: trading_duel::ID,
                program_data: program_data_pda(),
                studio_recipient: env.studio.account,
                game_record: game_record_pda(),
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::RegisterGame {
                settle_authority: authority_pda(),
                studio_bps: 300,
            },
            vec![],
        );
        env.send(&[register], &admin, &[&ctl])
            .expect("register game");
        let list = ix(
            tesoro_core::ID,
            tesoro_core::accounts::ListGame {
                admin: a(admin.pubkey()),
                config: tpda(&[CONFIG_SEED]),
                game_record: game_record_pda(),
                game_program: trading_duel::ID,
                program_data: program_data_pda(),
            },
            tesoro_core::instruction::ListGame {
                listed_until: 4_000_000_000,
                approved_hash: hash,
            },
            vec![],
        );
        env.send(&[cu_limit(1_400_000), list], &admin, &[])
            .expect("list game");

        env.alice = env.person();
        env.bob = env.person();
        let (alice, bob) = (dup(&env.alice), dup(&env.bob));
        env.a_source = env.stake(&alice, 1);
        env.b_source = env.stake(&bob, 2);

        env.set_config(a(env.operator.pubkey()), 0, 4)
            .expect("set config");
        let op = env.operator_kp();
        let sponsor = env.create_sponsor_ix(SOL);
        env.send(&[sponsor], &op, &[]).expect("create sponsor");
        for index in 0..2 {
            env.create_table(0, index).expect("create table");
            env.delegate_standin(table_addr(0, index));
        }
        env
    }

    // --- base-layer instructions -----------------------------------------------------------

    fn set_config(
        &mut self,
        operator: APk,
        generation: u16,
        max_tables: u16,
    ) -> Result<(), Failed> {
        let ctl = self.ctl_kp();
        let ixn = ix(
            trading_duel::ID,
            trading_duel::accounts::SetConfig {
                authority: a(ctl.pubkey()),
                config: config_addr(),
                program: trading_duel::ID,
                program_data: program_data_pda(),
                system_program: anchor_lang::system_program::ID,
            },
            trading_duel::instruction::SetConfig {
                operator,
                generation,
                max_tables,
            },
            vec![],
        );
        self.send(&[ixn], &ctl, &[])
    }

    fn create_sponsor_ix(&self, lamports: u64) -> Instruction {
        ix(
            trading_duel::ID,
            trading_duel::accounts::CreateSponsor {
                operator: a(self.operator.pubkey()),
                config: config_addr(),
                sponsor: sponsor_addr(),
                system_program: anchor_lang::system_program::ID,
            },
            trading_duel::instruction::CreateSponsor { lamports },
            vec![],
        )
    }

    fn create_table_ix(&self, signer: APk, generation: u16, index: u16) -> Instruction {
        ix(
            trading_duel::ID,
            trading_duel::accounts::CreateTable {
                operator: signer,
                config: config_addr(),
                table: table_addr(generation, index),
                system_program: anchor_lang::system_program::ID,
            },
            trading_duel::instruction::CreateTable { generation, index },
            vec![],
        )
    }

    fn create_table(&mut self, generation: u16, index: u16) -> Result<(), Failed> {
        let op = self.operator_kp();
        let ixn = self.create_table_ix(a(op.pubkey()), generation, index);
        self.send(&[ixn], &op, &[])
    }

    /// Stands in for `delegate_table`: base keeps the freshly created table as its committed copy.
    fn delegate_standin(&mut self, table: APk) {
        let acct = self.svm.get_account(&s(table)).expect("table");
        self.committed.insert(table, acct.data);
    }

    fn assign_ix(
        &self,
        m: APk,
        generation: u16,
        index: u16,
        epoch: u64,
        signer: APk,
    ) -> Instruction {
        ix(
            trading_duel::ID,
            trading_duel::accounts::AssignMatch {
                operator: signer,
                config: config_addr(),
                tesoro_match: m,
                account_a: self.alice.account,
                account_b: self.bob.account,
                authority: authority_pda(),
                assignment: assign_addr(m),
                tesoro_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            trading_duel::instruction::AssignMatch {
                generation,
                index,
                epoch,
            },
            vec![],
        )
    }

    fn assign(&mut self, generation: u16, index: u16, epoch: u64) -> Result<(), Failed> {
        let op = self.operator_kp();
        let ixn = self.assign_ix(self.tmatch, generation, index, epoch, a(op.pubkey()));
        self.send(&[ixn], &op, &[])?;
        self.table = table_addr(generation, index);
        Ok(())
    }

    fn open_and_join(&mut self, entry: u64) {
        let (alice, bob) = (dup(&self.alice), dup(&self.bob));
        let n = self.nonce;
        self.nonce += 2;
        let m = flow::open_match(
            &mut self.svm,
            &alice.kp,
            trading_duel::ID,
            entry,
            n,
            false,
            self.asset,
        )
        .expect("open match");
        flow::join_match(&mut self.svm, &bob.kp, &m, trading_duel::ID, n + 1).expect("join match");
        self.tmatch = m.key;
        self.mref = Some(m);
    }

    /// Opens and joins a Match for the same Players and assigns it to `index` at the table's
    /// current epoch.
    fn next_match_on(&mut self, index: u16) {
        self.open_and_join(1_000);
        let epoch = self.table_at(table_addr(0, index)).epoch;
        self.assign(0, index, epoch).expect("assign");
    }

    fn use_match(&mut self, m: flow::MatchRef, table: APk) {
        self.tmatch = m.key;
        self.mref = Some(m);
        self.table = table;
    }

    fn run_settlement(&mut self) {
        let m = self.mref.expect("a Match");
        let caller = self.oracle.insecure_clone();
        flow::run_chunks(&mut self.svm, &caller, &m);
    }

    /// Runs `f` with base's view of the table: the committed bytes, owned by the delegation
    /// program. The live rollup table is put back afterwards.
    fn on_base<R>(&mut self, table: APk, f: impl FnOnce(&mut Self) -> R) -> R {
        let live = self.svm.get_account(&s(table));
        if let Some(bytes) = self.committed.get(&table).cloned() {
            self.svm
                .set_account(
                    s(table),
                    Account {
                        lamports: SOL,
                        data: bytes,
                        owner: s(dlp()),
                        executable: false,
                        rent_epoch: 0,
                    },
                )
                .expect("base view");
        }
        let r = f(self);
        if let Some(acct) = live {
            self.svm.set_account(s(table), acct).expect("restore live");
        }
        r
    }

    fn finalize_ix(&self, caller: APk) -> Instruction {
        ix(
            trading_duel::ID,
            trading_duel::accounts::Finalize {
                caller,
                assignment: assign_addr(self.tmatch),
                table: self.table,
                tesoro_match: self.tmatch,
                config: tpda(&[CONFIG_SEED]),
                game_record: game_record_pda(),
                authority: authority_pda(),
                game_program: trading_duel::ID,
                program_data: program_data_pda(),
                receipt: tpda(&[b"settled", self.tmatch.as_ref()]),
                system_program: anchor_lang::system_program::ID,
                event_authority: tpda(&[b"__event_authority"]),
                tesoro_program: tesoro_core::ID,
            },
            trading_duel::instruction::Finalize {},
            vec![],
        )
    }

    /// Starts the settlement or refund from base's view of the table.
    fn finalize_start(&mut self) -> Result<(), Failed> {
        let caller = self.oracle.insecure_clone();
        let finalize = self.finalize_ix(a(caller.pubkey()));
        let table = self.table;
        self.on_base(table, |env| env.send(&[finalize], &caller, &[]))
    }

    /// Starts the settlement or refund and runs its chunks.
    fn finalize(&mut self) -> Result<(), Failed> {
        self.finalize_start()?;
        self.run_settlement();
        Ok(())
    }

    // --- rollup instructions ---------------------------------------------------------------

    fn rollup(&mut self, ixn: Instruction) -> Result<(), Failed> {
        let caller = self.oracle.insecure_clone();
        self.send(&[ixn], &caller, &[])
    }

    fn begin_ix(&self) -> Instruction {
        ix(
            trading_duel::ID,
            trading_duel::accounts::BeginMatch {
                caller: a(self.oracle.pubkey()),
                assignment: assign_addr(self.tmatch),
                table: self.table,
                tesoro_match: self.tmatch,
            },
            trading_duel::instruction::BeginMatch {},
            vec![],
        )
    }

    fn begin(&mut self) -> Result<(), Failed> {
        let ixn = self.begin_ix();
        self.rollup(ixn)
    }

    /// Stands in for `open_seats`, whose ephemeral-account and permission CPIs need MagicBlock:
    /// both Books exist (private to their Players) and the table says so.
    fn open_seats_standin(&mut self) {
        let t = self.table();
        for seat in 0..2u8 {
            let (key, bump) = book_addr_bump(self.table, seat);
            let book = Book::new(bump, self.table, t.players[seat as usize], seat);
            self.store(key, &book, trading_duel::ID);
        }
        self.patch_table(|t| t.seats_open = true);
    }

    /// Stands in for `close_seats`: the Books are gone.
    fn close_seats_standin(&mut self) {
        for seat in 0..2u8 {
            self.svm
                .set_account(s(book_addr(self.table, seat)), Account::default())
                .expect("close book");
        }
        self.patch_table(|t| t.seats_open = false);
    }

    fn check_in_ix(&self, player: APk) -> Instruction {
        ix(
            trading_duel::ID,
            trading_duel::accounts::CheckIn {
                player,
                table: self.table,
                price_feed: self.feed_key(),
            },
            trading_duel::instruction::CheckIn {},
            vec![],
        )
    }

    fn check_in(&mut self, seat: usize) -> Result<(), Failed> {
        let (kp, key) = self.person_of(seat);
        let ixn = self.check_in_ix(key);
        self.send(&[ixn], &kp, &[])
    }

    /// Begin, open the seats, both Players check in: the Match is live with a $100 anchor.
    fn start(&mut self) {
        self.begin().expect("begin");
        self.open_seats_standin();
        self.price(100.0);
        self.check_in(0).expect("check in 0");
        self.check_in(1).expect("check in 1");
    }

    /// Stands in for `commit_table`'s commit: the result is on base and the table is clean.
    fn commit_standin(&mut self) {
        let now = self.now;
        self.patch_table(|t| {
            t.dirty = false;
            t.commit.record(now);
        });
        let acct = self.svm.get_account(&s(self.table)).expect("table");
        self.committed.insert(self.table, acct.data);
    }

    /// The MagicBlock program does not exist in LiteSVM. Any program loaded at its address lets
    /// the account checks pass, and the CPI into it then fails (what a real commit does is
    /// devnet evidence): here the Game's own binary, which refuses a foreign program id.
    fn magic_shell(&mut self) {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../target/deploy/trading_duel.so"
        );
        self.svm
            .add_program_from_file(s(sdk_key(MAGIC_PROGRAM_ID)), path)
            .expect("magic shell");
    }

    fn commit_ix(&self) -> Instruction {
        ix(
            trading_duel::ID,
            trading_duel::accounts::CommitTable {
                caller: a(self.oracle.pubkey()),
                table: self.table,
                sponsor: sponsor_addr(),
                magic_fee_vault: table_kit::fee_vault_address(&trading_duel::TEE_VALIDATOR),
                magic_context: sdk_key(ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID),
                magic_program: sdk_key(MAGIC_PROGRAM_ID),
            },
            trading_duel::instruction::CommitTable {},
            vec![],
        )
    }

    fn reset_ix(&self) -> Instruction {
        ix(
            trading_duel::ID,
            trading_duel::accounts::TableOnly {
                caller: a(self.oracle.pubkey()),
                table: self.table,
            },
            trading_duel::instruction::ResetTable {},
            vec![],
        )
    }

    fn reset(&mut self) -> Result<(), Failed> {
        let ixn = self.reset_ix();
        self.rollup(ixn)
    }

    fn expire_ix(&self) -> Instruction {
        ix(
            trading_duel::ID,
            trading_duel::accounts::TableOnly {
                caller: a(self.oracle.pubkey()),
                table: self.table,
            },
            trading_duel::instruction::ExpireStart {},
            vec![],
        )
    }

    fn release_accounts(&self, m: APk) -> trading_duel::accounts::Release {
        trading_duel::accounts::Release {
            caller: a(self.oracle.pubkey()),
            table: self.table,
            receipt: tpda(&[b"settled", m.as_ref()]),
            match_state: m,
        }
    }

    fn release(&mut self, index: u8, m: APk) -> Result<(), Failed> {
        let ixn = ix(
            trading_duel::ID,
            self.release_accounts(m),
            trading_duel::instruction::ReleaseSlot { index },
            vec![],
        );
        self.rollup(ixn)
    }

    fn void(&mut self, m: APk) -> Result<(), Failed> {
        let ixn = ix(
            trading_duel::ID,
            self.release_accounts(m),
            trading_duel::instruction::VoidTable {},
            vec![],
        );
        self.rollup(ixn)
    }

    /// Plays one whole Match on the table under test from `assign` to a committed result:
    /// start, flat line, `a_band` for Alice and `b_band` for Bob in every column.
    fn play(&mut self, a_band: Option<i16>, b_band: Option<i16>) {
        self.start();
        for (seat, band) in [(0, a_band), (1, b_band)] {
            if let Some(band) = band {
                pick_all(self, seat, band);
            }
        }
        play_flat(self);
        self.commit_standin();
    }

    // --- feed and clock --------------------------------------------------------------------

    /// A feed account as the pricing oracle writes it, at the real address of `asset`'s feed.
    fn feed(&mut self, asset: u8, price: i64, published: i64) {
        self.feed_with(asset, price, 0, 8, published, trading_duel::PRICE_PROGRAM);
    }

    fn feed_with(
        &mut self,
        asset: u8,
        price: i64,
        conf: u64,
        exponent: i32,
        published: i64,
        owner: APk,
    ) {
        let key = trading_duel::FEEDS[asset as usize];
        let mut data = vec![0u8; 134];
        data[..8].copy_from_slice(&[0xea, 0xa1, 0x0e, 0x24, 0xac, 0xef, 0x0f, 0xe8]);
        data[40] = 1;
        data[41..73].copy_from_slice(key.as_ref());
        data[73..81].copy_from_slice(&price.to_le_bytes());
        data[81..89].copy_from_slice(&conf.to_le_bytes());
        data[89..93].copy_from_slice(&exponent.to_le_bytes());
        data[93..101].copy_from_slice(&published.to_le_bytes());
        data[101..109].copy_from_slice(&published.to_le_bytes());
        self.svm
            .set_account(
                s(key),
                Account {
                    lamports: SOL,
                    data,
                    owner: s(owner),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("set feed");
    }

    /// Price in whole USD at the current clock.
    fn price(&mut self, usd: f64) {
        let now = self.now;
        let asset = self.table().asset;
        self.feed(asset, (usd * 1e8) as i64, now);
    }

    fn person_of(&self, seat: usize) -> (Keypair, APk) {
        let p = if seat == 0 { &self.alice } else { &self.bob };
        (p.kp.insecure_clone(), p.key)
    }

    fn feed_key(&self) -> APk {
        let asset = self
            .svm
            .get_account(&s(self.table))
            .map_or(0, |_| self.table().asset);
        trading_duel::FEEDS[asset as usize]
    }

    fn sample_ix(&self, caller: APk, data: impl InstructionData) -> Instruction {
        ix(
            trading_duel::ID,
            trading_duel::accounts::Sample {
                caller,
                table: self.table,
                book_0: book_addr(self.table, 0),
                book_1: book_addr(self.table, 1),
                price_feed: self.feed_key(),
            },
            data,
            vec![],
        )
    }

    /// Seconds since the Match started, at the current clock.
    fn t(&self) -> i64 {
        self.now - self.table().starts_at
    }

    /// Moves the clock to `t` seconds after the start.
    fn at(&mut self, t: i64) {
        let starts = self.table().starts_at;
        self.set_time(starts + t);
    }

    fn pick_as(
        &mut self,
        signer: &Keypair,
        book: APk,
        column: u8,
        band: i16,
    ) -> Result<(), Failed> {
        let ixn = ix(
            trading_duel::ID,
            trading_duel::accounts::SetPick {
                player: a(signer.pubkey()),
                table: self.table,
                book,
            },
            trading_duel::instruction::SetPick { column, band },
            vec![],
        );
        self.send(&[ixn], signer, &[])
    }

    fn pick(&mut self, seat: usize, column: u8, band: i16) -> Result<(), Failed> {
        let (kp, _) = self.person_of(seat);
        let book = book_addr(self.table, seat as u8);
        self.pick_as(&kp, book, column, band)
    }

    fn tick(&mut self) -> Result<(), Failed> {
        let (kp, key) = self.person_of(0);
        let ixn = self.sample_ix(key, trading_duel::instruction::Tick {});
        self.send(&[ixn], &kp, &[])
    }

    /// Sets the price and ticks at `t` seconds after the start.
    fn tick_at(&mut self, t: i64, usd: f64) -> Result<(), Failed> {
        self.at(t);
        self.price(usd);
        self.tick()
    }

    fn end(&mut self) -> Result<(), Failed> {
        let (kp, key) = self.person_of(0);
        let ixn = ix(
            trading_duel::ID,
            trading_duel::accounts::EndMatch {
                caller: key,
                table: self.table,
                book_0: book_addr(self.table, 0),
                book_1: book_addr(self.table, 1),
            },
            trading_duel::instruction::EndMatch {},
            vec![],
        );
        self.send(&[ixn], &kp, &[])
    }

    /// Jumps one second past the end of the window, then ends the Match.
    fn finish(&mut self) -> Result<(), Failed> {
        let ends = self.table().ends_at;
        self.set_time(ends + 1);
        self.end()
    }
}

fn dlp() -> APk {
    sdk_key(ephemeral_rollups_sdk::id())
}
fn table_addr(generation: u16, index: u16) -> APk {
    trading_duel::table_address(generation, index)
}
fn config_addr() -> APk {
    dpda(&[trading_duel::CONFIG_SEED])
}
fn sponsor_addr() -> APk {
    dpda(&[trading_duel::SPONSOR_SEED])
}
fn assign_addr(m: APk) -> APk {
    dpda(&[trading_duel::ASSIGN_SEED, m.as_ref()])
}
fn book_addr_bump(table: APk, seat: u8) -> (APk, u8) {
    APk::find_program_address(
        &[trading_duel::BOOK_SEED, table.as_ref(), &[seat]],
        &trading_duel::ID,
    )
}
fn book_addr(table: APk, seat: u8) -> APk {
    book_addr_bump(table, seat).0
}

/// The first table, assigned to a Match that is open and joined.
fn ready() -> Env {
    let mut env = Env::new();
    env.next_match_on(0);
    env.table = table_addr(0, 0);
    env
}

/// A started Match with trading open and a $100 price.
fn live() -> Env {
    let mut env = ready();
    env.start();
    env
}

const PRICE: i64 = 100_00000000;
const ANCHOR: i64 = PRICE;

// =========================================================================================
// Tests
// =========================================================================================

use ephemeral_rollups_sdk::consts::{MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

fn sdk_key(p: ephemeral_rollups_sdk::compat::Pubkey) -> APk {
    APk::new_from_array(p.to_bytes())
}

const NO_PICK: i16 = trading_duel::NO_PICK;

fn err_code(e: trading_duel::DuelError) -> u32 {
    dcode(e)
}

/// Picks col 0..11 for a seat, all on `band`.
fn pick_all(env: &mut Env, seat: usize, band: i16) {
    for c in 0..12 {
        env.pick(seat, c, band).unwrap();
    }
}

/// Plays a flat line at $100 (everything in band 0), ticking every 10 seconds, then ends.
fn play_flat(env: &mut Env) {
    for t in (10..150).step_by(10) {
        env.tick_at(t, 100.0).unwrap();
    }
    env.finish().expect("end");
}

fn bytes_of(t: &Table) -> Vec<u8> {
    let mut v = Vec::new();
    t.try_serialize(&mut v).expect("serialize");
    v
}

// --- Config, tables, assignment --------------------------------------------------------------

#[test]
fn only_the_upgrade_authority_sets_the_config_and_the_generation_only_rises() {
    let mut env = Env::new();
    let stranger = env.admin.insecure_clone();
    let ixn = ix(
        trading_duel::ID,
        trading_duel::accounts::SetConfig {
            authority: a(stranger.pubkey()),
            config: config_addr(),
            program: trading_duel::ID,
            program_data: program_data_pda(),
            system_program: anchor_lang::system_program::ID,
        },
        trading_duel::instruction::SetConfig {
            operator: a(stranger.pubkey()),
            generation: 0,
            max_tables: 4,
        },
        vec![],
    );
    let err = env.send(&[ixn], &stranger, &[]).unwrap_err();
    assert_eq!(
        custom_code(&err),
        dcode(trading_duel::DuelError::NotUpgradeAuthority)
    );
    env.set_config(a(env.operator.pubkey()), 1, 8)
        .expect("raise");
    let err = env.set_config(a(env.operator.pubkey()), 0, 8).unwrap_err();
    assert_eq!(custom_code(&err), dcode(trading_duel::DuelError::BadConfig));
    for (op, max) in [
        (APk::default(), 4u16),
        (a(env.operator.pubkey()), 0),
        (a(env.operator.pubkey()), 257),
    ] {
        let err = env.set_config(op, 1, max).unwrap_err();
        assert_eq!(custom_code(&err), dcode(trading_duel::DuelError::BadConfig));
    }
}

#[test]
fn only_the_operator_creates_tables_inside_the_cap_and_the_current_generation() {
    use trading_duel::DuelError::*;
    let mut env = Env::new();
    let stranger = env.admin.insecure_clone();
    let ixn = env.create_table_ix(a(stranger.pubkey()), 0, 2);
    let err = env.send(&[ixn], &stranger, &[]).unwrap_err();
    assert_eq!(custom_code(&err), dcode(NotOperator));
    env.create_table(0, 2).expect("operator");
    env.create_table(0, 3)
        .expect("last table under the cap of 4");
    assert_eq!(
        custom_code(&env.create_table(0, 4).unwrap_err()),
        dcode(BadTableSlot)
    );
    assert_eq!(
        custom_code(&env.create_table(1, 0).unwrap_err()),
        dcode(BadTableSlot)
    );
    assert!(env.create_table(0, 2).is_err(), "a table is created once");
    let t = env.table_at(table_addr(0, 2));
    assert_eq!(
        (t.generation, t.index, t.epoch, t.phase),
        (0, 2, 0, trading_duel::PHASE_IDLE)
    );
    assert!(t.ring.slots.iter().all(|s| s.state == table_kit::SLOT_FREE));
}

#[test]
fn assignment_copies_players_and_asset_from_the_match_and_holds_the_refund_timer() {
    let env = ready();
    let asg: Assignment = env.load(assign_addr(env.tmatch));
    assert_eq!(
        asg.players,
        [env.alice.key, env.bob.key],
        "seat order is the Match's"
    );
    assert_eq!(asg.asset, trading_duel::ASSET_SOL);
    assert_eq!((asg.generation, asg.index, asg.epoch), (0, 0, 0));
    assert_eq!(asg.start_deadline, T0 + trading_duel::START_WINDOW_SECS);
    assert_eq!(asg.payer, a(env.operator.pubkey()));
    let m = env.load::<MatchState>(env.tmatch).inner;
    assert_eq!(m.deadline, T0 + trading_duel::TABLE_WINDOW_SECS);
}

#[test]
fn the_asset_is_the_one_the_match_was_opened_with_and_three_is_refused() {
    for asset in [1u8, 2] {
        let mut env = Env::new();
        env.asset = asset;
        env.next_match_on(0);
        let asg: Assignment = env.load(assign_addr(env.tmatch));
        assert_eq!(asg.asset, asset);
    }
    let mut env = Env::new();
    env.asset = 3;
    env.open_and_join(1_000);
    let err = env.assign(0, 0, 0).unwrap_err();
    assert_eq!(
        custom_code(&err),
        dcode(trading_duel::DuelError::InvalidAsset)
    );
}

#[test]
fn only_the_operator_assigns_once_and_only_to_a_real_table_slot() {
    use trading_duel::DuelError::*;
    let mut env = Env::new();
    env.open_and_join(1_000);
    let stranger = env.alice.kp.insecure_clone();
    let ixn = env.assign_ix(env.tmatch, 0, 0, 0, env.alice.key);
    let err = env.send(&[ixn], &stranger, &[]).unwrap_err();
    assert_eq!(custom_code(&err), dcode(NotOperator));
    assert_eq!(
        custom_code(&env.assign(0, 4, 0).unwrap_err()),
        dcode(BadTableSlot)
    );
    assert_eq!(
        custom_code(&env.assign(1, 0, 0).unwrap_err()),
        dcode(BadTableSlot)
    );
    env.assign(0, 0, 0).expect("operator assigns");
    assert!(
        env.assign(0, 1, 0).is_err(),
        "write-once: a second assignment is refused"
    );
    assert!(env.assign(0, 0, 0).is_err());
    let asg: Assignment = env.load(assign_addr(env.tmatch));
    assert_eq!(asg.index, 0, "the first assignment stands");
}

#[test]
fn an_open_match_nobody_joined_cannot_be_assigned() {
    let mut env = Env::new();
    let alice = dup(&env.alice);
    let m = flow::open_match(
        &mut env.svm,
        &alice.kp,
        trading_duel::ID,
        1_000,
        5,
        false,
        0,
    )
    .expect("open");
    env.tmatch = m.key;
    let err = env.assign(0, 0, 0).unwrap_err();
    assert_eq!(
        custom_code(&err),
        dcode(trading_duel::DuelError::BadTesoroMatch)
    );
}

// --- begin, check-in ------------------------------------------------------------------------

#[test]
fn begin_reserves_a_ring_slot_and_copies_the_match_from_the_assignment() {
    let mut env = ready();
    env.begin().expect("begin");
    let t = env.table();
    assert_eq!(t.phase, trading_duel::PHASE_WAITING);
    assert_eq!(t.tesoro_match, env.tmatch);
    assert_eq!(t.players, [env.alice.key, env.bob.key]);
    assert_eq!(t.start_deadline, T0 + trading_duel::START_WINDOW_SECS);
    let (i, slot) = t.ring.find(&env.tmatch, 0).expect("slot");
    assert_eq!((i, slot.state), (t.slot, table_kit::SLOT_RESERVED));
    assert_eq!(
        custom_code(&env.begin().unwrap_err()),
        dcode(trading_duel::DuelError::WrongPhase)
    );
}

#[test]
fn begin_refuses_a_wrong_table_epoch_or_late_start_and_a_frozen_match() {
    use trading_duel::DuelError::*;
    // another table
    let mut env = ready();
    env.table = table_addr(0, 1);
    assert_eq!(custom_code(&env.begin().unwrap_err()), dcode(NotAssigned));
    // a future epoch
    let mut env = Env::new();
    env.open_and_join(1_000);
    env.assign(0, 0, 5).expect("assign epoch 5");
    assert_eq!(custom_code(&env.begin().unwrap_err()), dcode(NotAssigned));
    // after the start deadline
    let mut env = ready();
    env.set_time(T0 + trading_duel::START_WINDOW_SECS + 1);
    assert_eq!(
        custom_code(&env.begin().unwrap_err()),
        dcode(StartWindowPassed)
    );
    // a Match tesoro_core already froze
    let mut env = ready();
    env.set_time(T0 + trading_duel::TABLE_WINDOW_SECS + 1);
    core_refund(&mut env).expect("anyone refunds past the deadline");
    assert_eq!(
        custom_code(&env.begin().unwrap_err()),
        dcode(BadTesoroMatch)
    );
}

/// tesoro_core's refund by anyone once the Match's deadline passed.
fn core_refund(env: &mut Env) -> Result<(), Failed> {
    let caller = env.oracle.insecure_clone();
    let ixn = ix(
        tesoro_core::ID,
        tesoro_core::accounts::RefundMatch {
            caller: a(caller.pubkey()),
            payer: a(caller.pubkey()),
            game_record: game_record_pda(),
            game_program: trading_duel::ID,
            program_data: program_data_pda(),
            match_state: env.tmatch,
            receipt: tpda(&[b"settled", env.tmatch.as_ref()]),
            opener_protections: None,
            system_program: anchor_lang::system_program::ID,
            event_authority: tpda(&[b"__event_authority"]),
            program: tesoro_core::ID,
        },
        tesoro_core::instruction::RefundMatch {},
        vec![],
    );
    env.send(&[ixn], &caller, &[])?;
    env.run_settlement();
    Ok(())
}

#[test]
fn a_full_ring_refuses_a_new_match() {
    let mut env = ready();
    env.patch_table(|t| {
        for (i, slot) in t.ring.slots.iter_mut().enumerate() {
            *slot = table_kit::Slot {
                state: table_kit::SLOT_DONE,
                match_key: APk::new_from_array([i as u8 + 1; 32]),
                epoch: 0,
                outcome: table_kit::OUTCOME_WIN0,
                at: 1,
            };
        }
    });
    let err = env.begin().unwrap_err();
    assert_eq!(custom_code(&err), dcode(trading_duel::DuelError::RingFull));
}

#[test]
fn both_players_check_in_and_the_second_one_starts_the_match() {
    use trading_duel::DuelError::*;
    let mut env = ready();
    env.begin().unwrap();
    env.price(100.0);
    assert_eq!(
        custom_code(&env.check_in(0).unwrap_err()),
        dcode(SeatsNotOpen)
    );
    env.open_seats_standin();
    // a stranger cannot check in
    let stranger = env.admin.insecure_clone();
    let ixn = env.check_in_ix(a(stranger.pubkey()));
    assert_eq!(
        custom_code(&env.send(&[ixn], &stranger, &[]).unwrap_err()),
        dcode(NotAPlayer)
    );
    env.check_in(0).unwrap();
    let t = env.table();
    assert_eq!(
        (t.phase, t.checked_in),
        (trading_duel::PHASE_WAITING, [true, false])
    );
    assert_eq!(t.starts_at, 0, "the clock has not started");
    assert_eq!(custom_code(&env.pick(0, 0, 0).unwrap_err()), dcode(NotLive));
    env.set_time(T0 + 5);
    env.price(100.0);
    env.check_in(1).unwrap();
    let t = env.table();
    assert_eq!(t.phase, trading_duel::PHASE_LIVE);
    assert_eq!(t.starts_at, T0 + 5);
    assert_eq!(t.ends_at, T0 + 5 + trading_duel::MATCH_SECS);
    assert_eq!(t.anchor, ANCHOR as u64);
    assert_eq!(
        t.track.last, ANCHOR as u64,
        "the anchor is the first sample"
    );
}

#[test]
fn a_late_check_in_is_refused_and_a_player_who_never_came_gets_a_refund_from_the_ring() {
    use trading_duel::DuelError::*;
    let mut env = ready();
    env.begin().unwrap();
    env.open_seats_standin();
    env.price(100.0);
    env.check_in(0).unwrap();
    let deadline = env.table().start_deadline;
    // not expirable before the deadline
    let ixn = env.expire_ix();
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(NotTimedOut)
    );
    env.set_time(deadline + 1);
    env.price(100.0);
    assert_eq!(
        custom_code(&env.check_in(1).unwrap_err()),
        dcode(StartWindowPassed)
    );
    let ixn = env.expire_ix();
    env.rollup(ixn).expect("expire");
    let t = env.table();
    assert_eq!((t.phase, t.dirty), (trading_duel::PHASE_OVER, true));
    assert_eq!(
        t.ring.find(&env.tmatch, 0).unwrap().1.outcome,
        table_kit::OUTCOME_DRAW
    );
    env.commit_standin();
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize().expect("refund from the ring");
    assert_eq!(
        (env.gemas(&env.alice), env.gemas(&env.bob)),
        (before.0 + 1_000, before.1 + 1_000)
    );
}

// --- Picks, ticks, scoring (the grid rules are unchanged) ------------------------------------

#[test]
fn picks_are_accepted_until_ten_seconds_before_the_column() {
    use trading_duel::DuelError::*;
    let mut env = live();
    env.pick(0, 0, 1).expect("pick before the lock");
    assert_eq!(env.book(0).picks[0], 1);
    assert_eq!(env.book(0).pick_count, 1);
    env.pick(0, 0, 2).expect("a pick can be moved");
    assert_eq!(env.book(0).pick_count, 1);
    env.pick(0, 0, NO_PICK).expect("and cleared");
    assert_eq!(env.book(0).picks[0], NO_PICK);
    assert_eq!(env.book(0).pick_count, 0);
    env.pick(0, 0, NO_PICK).expect("clearing twice is harmless");
    assert_eq!(env.book(0).pick_count, 0);

    env.at(19);
    env.pick(0, 0, 1).expect("last second before the lock");
    env.at(20);
    for band in [-1, NO_PICK] {
        assert_eq!(
            custom_code(&env.pick(0, 0, band).unwrap_err()),
            dcode(ColumnLocked)
        );
    }
    assert_eq!(env.book(0).picks[0], 1, "a locked pick stays");
    env.pick(0, 1, -2).expect("the next column is still open");
    env.at(129);
    env.pick(1, 11, 3).expect("the last column opens until 130");
    env.at(130);
    assert_eq!(
        custom_code(&env.pick(1, 11, 3).unwrap_err()),
        dcode(ColumnLocked)
    );
}

#[test]
fn picks_must_name_a_real_column_and_any_band_goes() {
    use trading_duel::DuelError::*;
    let mut env = live();
    assert_eq!(
        custom_code(&env.pick(0, 12, 3).unwrap_err()),
        dcode(InvalidColumn)
    );
    for band in [i16::MIN + 1, -4, 0, 3, 100, i16::MAX] {
        env.pick(0, 0, band).expect("any band is accepted");
        assert_eq!(env.book(0).picks[0], band);
    }
    assert_eq!(env.book(0).pick_count, 1);
}

#[test]
fn only_a_player_can_pick_and_only_in_their_own_book() {
    use trading_duel::DuelError::*;
    let mut env = live();
    let (b0, b1) = (book_addr(env.table, 0), book_addr(env.table, 1));
    let stranger = env.admin.insecure_clone();
    for book in [b0, b1] {
        let err = env.pick_as(&stranger, book, 0, 0).unwrap_err();
        assert_eq!(custom_code(&err), dcode(NotAPlayer));
    }
    let (bob, alice) = (env.bob.kp.insecure_clone(), env.alice.kp.insecure_clone());
    assert_eq!(
        custom_code(&env.pick_as(&bob, b0, 0, 0).unwrap_err()),
        dcode(NotAPlayer)
    );
    assert_eq!(
        custom_code(&env.pick_as(&alice, b1, 0, 0).unwrap_err()),
        dcode(NotAPlayer)
    );
    assert_eq!(env.book(0).pick_count + env.book(1).pick_count, 0);
}

#[test]
fn nothing_is_picked_or_ticked_before_the_match_starts() {
    use trading_duel::DuelError::*;
    let mut env = ready();
    env.begin().unwrap();
    env.open_seats_standin();
    assert_eq!(custom_code(&env.pick(0, 0, 0).unwrap_err()), dcode(NotLive));
    env.price(100.0);
    assert_eq!(custom_code(&env.tick().unwrap_err()), dcode(NotLive));
    assert_eq!(custom_code(&env.end().unwrap_err()), dcode(NotLive));
}

#[test]
fn a_column_is_revealed_to_both_when_it_locks_and_not_before() {
    let mut env = live();
    env.pick(0, 0, 1).unwrap();
    env.pick(1, 0, 0).unwrap();
    env.pick(0, 1, -2).unwrap();
    env.tick_at(19, 100.0).unwrap();
    assert_eq!(
        env.table().revealed,
        [[NO_PICK; 12]; 2],
        "nothing is public yet"
    );
    env.tick_at(20, 100.0).unwrap();
    let r = env.table().revealed;
    assert_eq!((r[0][0], r[1][0]), (1, 0));
    assert_eq!(
        (r[0][1], r[1][1]),
        (NO_PICK, NO_PICK),
        "column 1 locks at 30"
    );
    env.tick_at(30, 100.0).unwrap();
    let r = env.table().revealed;
    assert_eq!(
        (r[0][1], r[1][1]),
        (-2, NO_PICK),
        "an empty column reveals as empty"
    );
}

#[test]
fn ticks_fill_the_columns_the_line_crosses_and_carry_skipped_ones() {
    let mut env = live();
    assert_eq!(env.table().track.last, ANCHOR as u64);
    env.tick_at(10, 100.0).unwrap();
    env.tick_at(35, 100.03).unwrap();
    env.tick_at(38, 99.99).unwrap();
    let d = env.table();
    assert_eq!(d.track.lo[0], 99_99000000);
    assert_eq!(d.track.hi[0], 100_03000000);
    assert_eq!(d.track.seen, 1);
    env.tick_at(55, 100.10).unwrap();
    let d = env.table();
    assert_eq!((d.track.lo[1], d.track.hi[1]), (99_99000000, 99_99000000));
    assert_eq!((d.track.lo[2], d.track.hi[2]), (99_99000000, 100_10000000));
    assert_eq!(d.track.seen, 0b111);
    assert_eq!(d.track.last, 100_10000000);
    assert_eq!(d.track.last_col, 2);
}

#[test]
fn columns_are_scored_once_they_are_over() {
    let mut env = live();
    env.pick(0, 0, 1).unwrap();
    env.pick(1, 0, 2).unwrap();
    env.tick_at(35, 100.02).unwrap();
    assert_eq!(env.table().scores, [0, 0], "column 0 is still live");
    env.tick_at(40, 100.02).unwrap();
    assert_eq!(env.table().scores, [100, 0]);
    env.tick_at(50, 100.03).unwrap();
    assert_eq!(env.table().scores, [100, 0]);
}

#[test]
fn ticks_work_only_inside_the_window() {
    use trading_duel::DuelError::*;
    let mut env = live();
    let ends = env.table().ends_at;
    env.tick_at(149, 100.0).expect("the last second");
    env.set_time(ends);
    env.price(100.0);
    assert_eq!(custom_code(&env.tick().unwrap_err()), dcode(GridClosed));
}

#[test]
fn the_match_cannot_end_early() {
    use trading_duel::DuelError::*;
    let mut env = live();
    env.at(149);
    assert_eq!(custom_code(&env.end().unwrap_err()), dcode(NotEnded));
}

#[test]
fn a_match_with_no_ticks_still_scores_from_the_anchor() {
    let mut env = live();
    pick_all(&mut env, 0, 0);
    pick_all(&mut env, 1, 1);
    env.finish().expect("end");
    let d = env.table();
    assert_eq!(d.track.seen, 0xfff);
    assert_eq!(d.scores, [1200, 0]);
    assert_eq!(d.winner, 0);
}

#[test]
fn a_hit_needs_the_line_to_cross_the_band_inside_the_column() {
    let mut env = live();
    env.pick(0, 2, 2).unwrap();
    env.pick(1, 2, 3).unwrap();
    env.tick_at(51, 100.0).unwrap();
    env.tick_at(55, 100.03).unwrap();
    env.tick_at(60, 100.03).unwrap();
    assert_eq!(env.table().scores, [100, 0]);
}

#[test]
fn the_end_is_the_same_whenever_and_whoever_ends_it() {
    let run = |delay: i64, feed_usd: f64| {
        let mut env = live();
        env.pick(0, 11, 1).unwrap();
        env.pick(1, 11, 0).unwrap();
        env.tick_at(140, 100.03).unwrap();
        let ends = env.table().ends_at;
        env.set_time(ends + delay);
        env.price(feed_usd);
        env.end().expect("end");
        let d = env.table();
        (d.track, d.scores, d.winner)
    };
    let on_time = run(0, 100.0);
    assert_eq!(on_time, run(3, 150.0));
    assert_eq!(on_time, run(100, 50.0));
    assert_eq!(on_time.0.last, 100_03000000);
    assert_eq!(on_time.1, [100, 100], "column 11 crossed bands 0 and 1");
}

// --- Results, the ring and finalize ---------------------------------------------------------

#[test]
fn the_higher_score_wins_the_result_goes_into_the_ring_and_finalize_pays_the_winner() {
    let mut env = ready();
    env.begin().unwrap();
    let begin_cu = env.last_cu;
    env.open_seats_standin();
    env.price(100.0);
    env.check_in(0).unwrap();
    env.check_in(1).unwrap();
    let check_in_cu = env.last_cu;
    pick_all(&mut env, 0, 0);
    pick_all(&mut env, 1, 1);
    for t in (10..150).step_by(10) {
        env.tick_at(t, 100.0).unwrap();
    }
    let tick_cu = env.last_cu;
    env.finish().expect("end");
    let end_cu = env.last_cu;
    let t = env.table();
    assert_eq!(
        (t.phase, t.dirty, t.scores, t.winner),
        (trading_duel::PHASE_OVER, true, [1200, 0], 0)
    );
    assert_eq!(t.revealed, [[0; 12], [1; 12]]);
    let (_, slot) = t.ring.find(&env.tmatch, 0).expect("slot");
    assert_eq!(
        (slot.state, slot.outcome),
        (table_kit::SLOT_DONE, table_kit::OUTCOME_WIN0)
    );
    env.commit_standin();
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize_start().expect("settle");
    let finalize_cu = env.last_cu;
    env.run_settlement();
    assert_eq!(
        env.gemas(&env.alice),
        before.0 + 1_900,
        "pot of 2000 less 5% fees"
    );
    assert_eq!(env.gemas(&env.bob), before.1);
    assert_eq!(env.tesoro_status(), Stage::Closed);
    println!("CU begin {begin_cu} check_in {check_in_cu} tick {tick_cu} end {end_cu} finalize {finalize_cu}");
    // Budgets: every table instruction fits far inside one transaction.
    for (name, cu) in [
        ("begin", begin_cu),
        ("check_in", check_in_cu),
        ("tick", tick_cu),
        ("end", end_cu),
    ] {
        assert!(cu < 60_000, "{name} used {cu} CU");
    }
    assert!(finalize_cu < 250_000, "finalize used {finalize_cu} CU");
}

#[test]
fn the_second_seat_can_win() {
    let mut env = live();
    pick_all(&mut env, 0, 2);
    env.pick(1, 3, 0).unwrap();
    play_flat(&mut env);
    assert_eq!(env.table().scores, [0, 100]);
    env.commit_standin();
    let before = env.gemas(&env.bob);
    env.finalize().expect("settle");
    assert_eq!(env.gemas(&env.bob), before + 1_900);
}

#[test]
fn equal_points_draw_and_refund_both_entries() {
    let mut env = live();
    pick_all(&mut env, 0, 0);
    pick_all(&mut env, 1, 0);
    play_flat(&mut env);
    assert_eq!(env.table().scores, [1200, 1200]);
    assert_eq!(env.table().winner, trading_duel::DRAW);
    env.commit_standin();
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize().expect("refund");
    assert_eq!(
        (env.gemas(&env.alice), env.gemas(&env.bob)),
        (before.0 + 1_000, before.1 + 1_000)
    );
}

#[test]
fn a_match_in_which_nobody_picked_is_a_no_show_that_costs_each_side_the_platform_fee() {
    let mut env = live();
    play_flat(&mut env);
    let t = env.table();
    assert_eq!((t.scores, t.winner), ([0, 0], trading_duel::DRAW));
    assert_eq!(
        t.ring.find(&env.tmatch, 0).unwrap().1.outcome,
        table_kit::OUTCOME_NO_SHOW
    );
    env.commit_standin();
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize().expect("no-show settlement");
    let (ga, gb) = (
        env.gemas(&env.alice) - before.0,
        env.gemas(&env.bob) - before.1,
    );
    assert_eq!(ga, gb, "both sides pay the same");
    assert!(
        ga < 1_000 && ga > 900,
        "each loses the Platform Fee only, got {ga}"
    );
}

#[test]
fn a_live_match_cannot_be_finalized() {
    use trading_duel::DuelError::*;
    let mut env = live();
    env.commit_standin();
    // The committed copy still shows the Match running: no slot is Done.
    let err = env.finalize_start().unwrap_err();
    assert_eq!(custom_code(&err), dcode(MatchNotOver));
}

#[test]
fn finalize_reads_only_the_committed_table_owned_by_the_delegation_program() {
    use trading_duel::DuelError::*;
    let mut env = live();
    pick_all(&mut env, 0, 0);
    play_flat(&mut env);
    env.commit_standin();
    // Owned by the program itself (an undelegated table) also reads.
    // Owned by anyone else, or an unrelated account at the table's address, is refused.
    let table = env.table;
    let bytes = env.committed.get(&table).cloned().unwrap();
    for owner in [
        anchor_lang::system_program::ID,
        tesoro_core::ID,
        APk::new_unique(),
    ] {
        let live = env.svm.get_account(&s(table)).unwrap();
        env.svm
            .set_account(
                s(table),
                Account {
                    lamports: SOL,
                    data: bytes.clone(),
                    owner: s(owner),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let caller = env.oracle.insecure_clone();
        let ixn = env.finalize_ix(a(caller.pubkey()));
        let err = env.send(&[ixn], &caller, &[]).unwrap_err();
        assert_eq!(custom_code(&err), dcode(BadTable), "owner {owner}");
        env.svm.set_account(s(table), live).unwrap();
    }
}

#[test]
fn finalize_from_another_table_or_a_table_with_garbage_is_refused() {
    use trading_duel::DuelError::*;
    let mut env = live();
    pick_all(&mut env, 0, 0);
    play_flat(&mut env);
    env.commit_standin();
    // Table 1 (a real table, never used) passed for the Match assigned to table 0.
    let right = env.table;
    env.table = table_addr(0, 1);
    let wrong = env.table;
    env.committed.insert(wrong, env.committed[&right].clone());
    let caller = env.oracle.insecure_clone();
    let ixn = env.finalize_ix(a(caller.pubkey()));
    let err = env
        .on_base(wrong, |e| e.send(&[ixn], &caller, &[]))
        .unwrap_err();
    assert_eq!(custom_code(&err), dcode(BadTable));
    // The right address with undecodable bytes.
    env.table = right;
    env.committed.insert(right, vec![7u8; 400]);
    let err = env.finalize_start().unwrap_err();
    assert_eq!(custom_code(&err), dcode(BadTable));
}

#[test]
fn a_settled_match_cannot_be_settled_again() {
    let mut env = live();
    pick_all(&mut env, 0, 0);
    play_flat(&mut env);
    env.commit_standin();
    env.finalize().expect("settle");
    assert!(
        env.finalize_start().is_err(),
        "core refuses a second settlement"
    );
}

#[test]
fn a_stale_commit_never_refunds_a_match_that_has_a_result() {
    use trading_duel::DuelError::*;
    let mut env = live();
    pick_all(&mut env, 0, 0);
    play_flat(&mut env);
    // The result was never committed. Base's copy is the idle table from before the Match.
    env.set_time(env.now + 10 * 86_400 / 10);
    let err = env.finalize_start().unwrap_err();
    assert_eq!(custom_code(&err), dcode(NoResult));
    // Far past every deadline of the table, still no refund from a stale copy.
    env.set_time(T0 + 2 * trading_duel::TABLE_WINDOW_SECS);
    let err = env.finalize_start().unwrap_err();
    assert_eq!(custom_code(&err), dcode(NoResult));
}

#[test]
fn a_match_that_never_began_is_refunded_only_once_the_table_has_moved_past_its_epoch() {
    use trading_duel::DuelError::*;
    let mut env = Env::new();
    // Match A is assigned to table 0 at epoch 0 and never begins.
    env.next_match_on(0);
    let never = (env.mref.unwrap(), env.table);
    // Match B takes the same table and epoch, plays and is committed; the table resets.
    env.next_match_on(0);
    env.play(Some(0), Some(1));
    env.close_seats_standin();
    env.set_time(env.now + trading_duel::RESET_DELAY_SECS);
    env.reset().expect("reset");
    // Base still has the epoch-0 table: the table has not moved past epoch 0 as far as base knows.
    env.use_match(never.0, never.1);
    env.set_time(env.now + 1_000);
    assert_eq!(
        custom_code(&env.finalize_start().unwrap_err()),
        dcode(NoResult)
    );
    // After a commit that shows epoch 1 (the next Match's result), A's refund is proven.
    env.commit_standin();
    let committed = env.table_at_committed();
    assert_eq!(committed.epoch, 1);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize().expect("refund of a Match that never began");
    assert_eq!(
        (env.gemas(&env.alice), env.gemas(&env.bob)),
        (before.0 + 1_000, before.1 + 1_000)
    );
    // Before the start deadline even a proven epoch does not refund.
    let _ = NotTimedOut;
}

impl Env {
    fn table_at_committed(&self) -> Table {
        let bytes = self.committed.get(&self.table).expect("committed");
        Table::try_deserialize(&mut bytes.as_slice()).expect("decode")
    }
}

#[test]
fn a_table_is_reused_and_every_result_waits_in_the_ring_until_it_is_settled() {
    let mut env = Env::new();
    let mut played: Vec<(flow::MatchRef, APk)> = vec![];
    for n in 0..3u64 {
        env.next_match_on(0);
        assert_eq!(env.table().epoch, n, "each Match runs in its own epoch");
        env.play(Some(0), Some(1));
        played.push((env.mref.unwrap(), env.table));
        env.close_seats_standin();
        env.set_time(env.now + trading_duel::RESET_DELAY_SECS);
        env.reset().expect("reset");
        assert_eq!(
            env.table().ring.used(),
            (n + 1) as usize,
            "results are kept across resets"
        );
    }
    // The table is two resets past the first Match; every result is still in the committed ring.
    let committed = env.table_at_committed();
    assert_eq!(committed.ring.used(), 3);
    for (m, table) in played {
        env.use_match(m, table);
        let before = env.gemas(&env.alice);
        env.finalize().expect("settle from the ring");
        assert_eq!(
            env.gemas(&env.alice),
            before + 1_900,
            "Alice won every Match"
        );
    }
}

#[test]
fn a_match_assigned_to_a_past_epoch_never_begins_and_is_refunded_not_paid_from_another_result() {
    use trading_duel::DuelError::*;
    let mut env = Env::new();
    env.next_match_on(0);
    env.play(Some(0), Some(1));
    env.close_seats_standin();
    env.set_time(env.now + trading_duel::RESET_DELAY_SECS);
    env.reset().unwrap();
    // A second Match is assigned to the epoch that already ran (0). The table is at epoch 1.
    env.open_and_join(1_000);
    env.assign(0, 0, 0).unwrap();
    assert_eq!(custom_code(&env.begin().unwrap_err()), dcode(NotAssigned));
    env.commit_standin();
    // Its finalize finds no slot for (its key, epoch 0): it cannot borrow the first Match's win.
    // Because base now shows the table past epoch 0, it is a Match that never ran: a refund.
    env.set_time(env.now + 1_000);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize().expect("refund");
    assert_eq!(
        (env.gemas(&env.alice), env.gemas(&env.bob)),
        (before.0 + 1_000, before.1 + 1_000)
    );
}

// --- Release, void, reset --------------------------------------------------------------------

#[test]
fn a_slot_is_freed_only_on_the_cores_receipt_and_not_a_minute_too_soon() {
    use trading_duel::DuelError::*;
    let mut env = live();
    pick_all(&mut env, 0, 0);
    play_flat(&mut env);
    env.commit_standin();
    let m = env.tmatch;
    let slot = env.table().slot;
    // No receipt yet.
    assert_eq!(
        custom_code(&env.release(slot, m).unwrap_err()),
        dcode(NoReceipt)
    );
    env.finalize().expect("settle");
    // The receipt exists but is too young.
    assert_eq!(
        custom_code(&env.release(slot, m).unwrap_err()),
        dcode(NoReceipt)
    );
    assert_eq!(env.table().ring.used(), 1);
    // A receipt of another Match proves nothing for this slot: pass an unrelated account.
    env.set_time(env.now + trading_duel::RELEASE_DELAY_SECS);
    let ixn = ix(
        trading_duel::ID,
        trading_duel::accounts::Release {
            caller: a(env.oracle.pubkey()),
            table: env.table,
            receipt: env.alice.account,
            match_state: m,
        },
        trading_duel::instruction::ReleaseSlot { index: slot },
        vec![],
    );
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(NoReceipt));
    env.release(slot, m).expect("freed with the receipt");
    assert_eq!(env.table().ring.used(), 0);
    // A free slot cannot be freed again.
    assert_eq!(
        custom_code(&env.release(slot, m).unwrap_err()),
        dcode(BadSlot)
    );
}

#[test]
fn a_reserved_or_unknown_slot_cannot_be_released() {
    use trading_duel::DuelError::*;
    let mut env = ready();
    env.begin().unwrap();
    let m = env.tmatch;
    let slot = env.table().slot;
    assert_eq!(
        custom_code(&env.release(slot, m).unwrap_err()),
        dcode(BadSlot)
    );
    assert_eq!(
        custom_code(&env.release(200, m).unwrap_err()),
        dcode(BadSlot)
    );
}

#[test]
fn a_slot_whose_match_account_vanished_is_freed_after_fifteen_days_only() {
    use trading_duel::DuelError::*;
    let mut env = live();
    pick_all(&mut env, 0, 0);
    play_flat(&mut env);
    let slot = env.table().slot;
    let m = env.tmatch;
    let at = env.now;
    // Forge "no receipt and no Match account" the way a vanished Match reads: the slot's Match
    // key points at an empty account.
    let ghost = APk::new_unique();
    env.patch_table(|t| t.ring.slots[slot as usize].match_key = ghost);
    let ixn = ix(
        trading_duel::ID,
        trading_duel::accounts::Release {
            caller: a(env.oracle.pubkey()),
            table: env.table,
            receipt: tpda(&[b"settled", ghost.as_ref()]),
            match_state: ghost,
        },
        trading_duel::instruction::ReleaseSlot { index: slot },
        vec![],
    );
    assert_eq!(
        custom_code(&env.rollup(ixn.clone()).unwrap_err()),
        dcode(NoReceipt)
    );
    env.set_time(at + trading_duel::STALE_SLOT_SECS);
    env.rollup(ixn).expect("freed after the long wait");
    assert_eq!(env.table().ring.used(), 0);
    let _ = m;
}

#[test]
fn a_table_is_reset_only_when_closed_committed_and_a_moment_old_and_it_forgets_the_match() {
    use trading_duel::DuelError::*;
    let mut env = live();
    pick_all(&mut env, 0, 0);
    env.pick(1, 4, 3).unwrap();
    play_flat(&mut env);
    let over = env.table().over_at;
    let first = env.table();
    // The seats are still open.
    env.set_time(over + trading_duel::RESET_DELAY_SECS);
    assert_eq!(custom_code(&env.reset().unwrap_err()), dcode(SeatsOpen));
    env.close_seats_standin();
    // Not committed yet: the result must be scheduled for Solana before it can be wiped.
    assert_eq!(custom_code(&env.reset().unwrap_err()), dcode(NotCommitted));
    env.commit_standin();
    // Too early.
    env.set_time(over + trading_duel::RESET_DELAY_SECS - 1);
    assert_eq!(custom_code(&env.reset().unwrap_err()), dcode(ResetTooEarly));
    env.set_time(over + trading_duel::RESET_DELAY_SECS);
    let commit_before = env.table().commit;
    env.reset().expect("reset");
    // Everything but identity, the epoch and the ring is wiped.
    let mut expected = Table::new(first.bump, 0, 0);
    expected.epoch = 1;
    expected.ring = first.ring;
    expected.commit = commit_before;
    assert_eq!(bytes_of(&env.table()), bytes_of(&expected));
    assert_eq!(env.table().ring.used(), 1);
    // A table that is Idle cannot be reset again.
    assert_eq!(custom_code(&env.reset().unwrap_err()), dcode(WrongPhase));
}

#[test]
fn a_live_match_cannot_be_reset_away() {
    use trading_duel::DuelError::*;
    let mut env = live();
    env.set_time(env.now + 10_000);
    assert_eq!(custom_code(&env.reset().unwrap_err()), dcode(WrongPhase));
    env.begin().expect_err("and cannot be begun over");
    let _ = (NotCommitted, SeatsOpen);
}

#[test]
fn the_old_assignment_cannot_begin_again_after_its_epoch() {
    use trading_duel::DuelError::*;
    let mut env = Env::new();
    env.next_match_on(0);
    env.play(Some(0), Some(1));
    env.close_seats_standin();
    env.set_time(env.now + trading_duel::RESET_DELAY_SECS);
    env.reset().unwrap();
    // Replaying begin for the finished Match: epoch moved on.
    assert_eq!(custom_code(&env.begin().unwrap_err()), dcode(NotAssigned));
}

#[test]
fn a_table_whose_match_core_already_refunded_is_voided_and_reset_without_a_result() {
    use trading_duel::DuelError::*;
    let mut env = live();
    let m = env.tmatch;
    // No receipt yet: nothing to void.
    assert_eq!(custom_code(&env.void(m).unwrap_err()), dcode(NoReceipt));
    // The outage: nothing was committed, core's deadline passes and anyone refunds.
    env.set_time(T0 + trading_duel::TABLE_WINDOW_SECS + 1);
    core_refund(&mut env).expect("core refund");
    // The receipt is too young.
    assert_eq!(custom_code(&env.void(m).unwrap_err()), dcode(NoReceipt));
    env.set_time(env.now + trading_duel::RELEASE_DELAY_SECS);
    env.void(m).expect("void");
    let t = env.table();
    assert_eq!((t.phase, t.dirty), (trading_duel::PHASE_OVER, false));
    assert_eq!(t.ring.used(), 0, "the reserved slot is freed");
    env.close_seats_standin();
    env.set_time(env.now + trading_duel::RESET_DELAY_SECS);
    env.reset().expect("reset");
    assert_eq!(env.table().epoch, 1);
}

#[test]
fn a_receipt_of_another_match_cannot_void_the_table() {
    use trading_duel::DuelError::*;
    let mut env = Env::new();
    env.next_match_on(0);
    let other = env.mref.unwrap();
    env.next_match_on(1);
    env.begin().expect("the second Match waits on table 1");
    let table_1 = env.table;
    // Core refunds the first Match; the second is still on its table.
    env.set_time(T0 + trading_duel::TABLE_WINDOW_SECS + 1);
    env.use_match(other, table_addr(0, 0));
    core_refund(&mut env).unwrap();
    env.set_time(env.now + trading_duel::RELEASE_DELAY_SECS);
    let ixn = ix(
        trading_duel::ID,
        trading_duel::accounts::Release {
            caller: a(env.oracle.pubkey()),
            table: table_1,
            receipt: tpda(&[b"settled", other.key.as_ref()]),
            match_state: other.key,
        },
        trading_duel::instruction::VoidTable {},
        vec![],
    );
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(NoReceipt));
}

// --- Closing an Assignment, committing, sponsor ----------------------------------------------

#[test]
fn an_assignment_closes_only_after_the_core_receipt_and_returns_its_rent_to_the_payer() {
    use trading_duel::DuelError::*;
    let mut env = live();
    pick_all(&mut env, 0, 0);
    play_flat(&mut env);
    env.commit_standin();
    let asg = assign_addr(env.tmatch);
    let close = |env: &Env| {
        ix(
            trading_duel::ID,
            trading_duel::accounts::CloseAssignment {
                caller: a(env.oracle.pubkey()),
                assignment: assign_addr(env.tmatch),
                payer: a(env.operator.pubkey()),
                receipt: tpda(&[b"settled", env.tmatch.as_ref()]),
                match_state: env.tmatch,
            },
            trading_duel::instruction::CloseAssignment {},
            vec![],
        )
    };
    let ixn = close(&env);
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(NoReceipt));
    env.finalize().expect("settle");
    let before = env.svm.get_balance(&s(a(env.operator.pubkey()))).unwrap();
    let ixn = close(&env);
    env.rollup(ixn).expect("close");
    assert!(env.svm.get_account(&s(asg)).is_none_or(|a| a.lamports == 0));
    assert!(env.svm.get_balance(&s(a(env.operator.pubkey()))).unwrap() > before);
}

#[test]
fn the_result_is_committed_once_and_the_sponsor_cannot_be_drained_by_repeats() {
    use trading_duel::DuelError::*;
    let mut env = live();
    env.magic_shell();
    // Nothing to commit while the Match runs.
    let ixn = env.commit_ix();
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(NotDirty));
    pick_all(&mut env, 0, 0);
    play_flat(&mut env);
    // With a result the call passes its own checks and reaches the MagicBlock program, which
    // LiteSVM does not have (devnet evidence, ticket 24).
    let ixn = env.commit_ix();
    let err = env.rollup(ixn).unwrap_err();
    assert!(
        !err.meta.logs.iter().any(|l| l.contains("NotDirty")),
        "{:?}",
        err.meta.logs
    );
    env.commit_standin();
    let ixn = env.commit_ix();
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(NotDirty),
        "once per result"
    );
    // The wrong fee vault is refused before any commit.
    env.patch_table(|t| t.dirty = true);
    let mut bad = env.commit_ix();
    let idx = bad
        .accounts
        .iter()
        .position(|m| m.pubkey == s(table_kit::fee_vault_address(&trading_duel::TEE_VALIDATOR)))
        .unwrap();
    bad.accounts[idx].pubkey = s(APk::new_unique());
    let err = env.rollup(bad).unwrap_err();
    assert!(
        err.meta
            .logs
            .iter()
            .any(|l| l.contains("ConstraintAddress") || l.contains("Address")),
        "{:?}",
        err.meta.logs
    );
}

#[test]
fn the_sponsor_is_refilled_from_a_fuel_reserve_by_the_operator_only() {
    use trading_duel::DuelError::*;
    let mut env = Env::new();
    let op = env.operator_kp();
    let fuel = dpda(&[trading_duel::FUEL_SEED, &[0]]);
    let create = ix(
        trading_duel::ID,
        trading_duel::accounts::CreateFuel {
            operator: a(op.pubkey()),
            config: config_addr(),
            fuel,
            system_program: anchor_lang::system_program::ID,
        },
        trading_duel::instruction::CreateFuel {
            n: 0,
            lamports: 5 * SOL,
        },
        vec![],
    );
    env.send(&[create], &op, &[]).expect("create fuel");
    let refill = |signer: APk, amount: u64| {
        ix(
            trading_duel::ID,
            trading_duel::accounts::RefillSponsor {
                operator: signer,
                config: config_addr(),
                fuel,
                sponsor: sponsor_addr(),
            },
            trading_duel::instruction::RefillSponsor { amount },
            vec![],
        )
    };
    let stranger = env.admin.insecure_clone();
    let ixn = refill(a(stranger.pubkey()), SOL);
    assert_eq!(
        custom_code(&env.send(&[ixn], &stranger, &[]).unwrap_err()),
        dcode(NotOperator)
    );
    let sponsor_before = env.svm.get_balance(&s(sponsor_addr())).unwrap();
    let ixn = refill(a(op.pubkey()), 2 * SOL);
    env.send(&[ixn], &op, &[]).expect("refill");
    assert_eq!(
        env.svm.get_balance(&s(sponsor_addr())).unwrap(),
        sponsor_before + 2 * SOL
    );
    // The fuel account never goes below its rent.
    let ixn = refill(a(op.pubkey()), 3 * SOL + 1);
    assert!(
        env.send(&[ixn], &op, &[]).is_err(),
        "would take the reserve below its rent"
    );
}

// --- Delegation and seats guards --------------------------------------------------------------

#[test]
fn delegation_is_pinned_to_the_tee_validator() {
    let mut env = Env::new();
    let dlpk = dlp();
    let derive = |seeds: &[&[u8]], program: &APk| APk::find_program_address(seeds, program).0;
    let buffer = |k: APk| derive(&[b"buffer", k.as_ref()], &trading_duel::ID);
    let record = |k: APk| derive(&[b"delegation", k.as_ref()], &dlpk);
    let meta = |k: APk| derive(&[b"delegation-metadata", k.as_ref()], &dlpk);
    let table = table_addr(0, 0);
    let op = env.operator_kp();
    for validator in [Some(a(env.admin.pubkey())), None] {
        let delegate = ix(
            trading_duel::ID,
            trading_duel::accounts::DelegateTable {
                operator: a(op.pubkey()),
                config: config_addr(),
                buffer_table: buffer(table),
                delegation_record_table: record(table),
                delegation_metadata_table: meta(table),
                table,
                validator,
                owner_program: trading_duel::ID,
                delegation_program: dlpk,
                system_program: anchor_lang::system_program::ID,
            },
            trading_duel::instruction::DelegateTable {
                generation: 0,
                index: 0,
            },
            vec![],
        );
        let err = env.send(&[delegate], &op, &[]).unwrap_err();
        assert!(
            err.meta.logs.iter().any(|l| l.contains("InvalidValidator")),
            "validator {validator:?} must be refused, got {:?}",
            err.meta.logs
        );
    }
    // Only the operator delegates.
    let stranger = env.admin.insecure_clone();
    let delegate = ix(
        trading_duel::ID,
        trading_duel::accounts::DelegateTable {
            operator: a(stranger.pubkey()),
            config: config_addr(),
            buffer_table: buffer(table),
            delegation_record_table: record(table),
            delegation_metadata_table: meta(table),
            table,
            validator: Some(trading_duel::TEE_VALIDATOR),
            owner_program: trading_duel::ID,
            delegation_program: dlpk,
            system_program: anchor_lang::system_program::ID,
        },
        trading_duel::instruction::DelegateTable {
            generation: 0,
            index: 0,
        },
        vec![],
    );
    let err = env.send(&[delegate], &stranger, &[]).unwrap_err();
    assert_eq!(
        custom_code(&err),
        dcode(trading_duel::DuelError::NotOperator)
    );
}

#[test]
fn seats_open_only_for_a_waiting_or_live_table_and_close_only_when_over() {
    use trading_duel::DuelError::*;
    let mut env = ready();
    let open = |env: &Env| {
        let t = env.table;
        let (b0, b1) = (book_addr(t, 0), book_addr(t, 1));
        let perm = |k: APk| {
            APk::find_program_address(
                &[
                    ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED,
                    k.as_ref(),
                ],
                &sdk_key(PERMISSION_PROGRAM_ID),
            )
            .0
        };
        ix(
            trading_duel::ID,
            trading_duel::accounts::OpenSeats {
                caller: a(env.oracle.pubkey()),
                table: t,
                book_0: b0,
                book_1: b1,
                book_0_permission: perm(b0),
                book_1_permission: perm(b1),
                permission_program: sdk_key(PERMISSION_PROGRAM_ID),
                ephemeral_vault: sdk_key(ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID),
                magic_program: sdk_key(MAGIC_PROGRAM_ID),
            },
            trading_duel::instruction::OpenSeats {},
            vec![],
        )
    };
    // An idle table has no Match to seat.
    let ixn = open(&env);
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(WrongPhase)
    );
    env.begin().unwrap();
    env.open_seats_standin();
    let ixn = open(&env);
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(SeatsOpen));
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
        retired_fee_minted: 0,
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

// --- A commit that never reaches base ------------------------------------------------------

impl Env {
    /// A commit the rollup accepted but base never received: the table is clean, the guard has
    /// counted the try, and base's copy is unchanged.
    fn commit_lost_standin(&mut self) {
        let now = self.now;
        self.patch_table(|t| {
            t.dirty = false;
            t.commit.record(now);
        });
    }
}

#[test]
fn a_lost_commit_is_repeated_after_a_wait_and_then_finalize_pays_the_winner() {
    use trading_duel::DuelError::*;
    let mut env = live();
    env.magic_shell();
    pick_all(&mut env, 0, 0);
    play_flat(&mut env);
    env.commit_lost_standin();
    assert_eq!(
        custom_code(&env.finalize_start().unwrap_err()),
        dcode(NoResult)
    );
    let before = bytes_of(&env.table());
    let ixn = env.commit_ix();
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(NotDirty));
    env.set_time(env.now + trading_duel::RESET_DELAY_SECS);
    let ixn = env.commit_ix();
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(NotDirty));
    assert_eq!(bytes_of(&env.table()), before);
    env.set_time(env.now + table_kit::COMMIT_RETRY_SECS);
    let ixn = env.commit_ix();
    let err = env.rollup(ixn).unwrap_err();
    assert!(
        !err.meta.logs.iter().any(|l| l.contains("NotDirty")),
        "{:?}",
        err.meta.logs
    );
    env.commit_standin();
    let before_gemas = env.gemas(&env.alice);
    env.finalize().expect("settle from the repeated commit");
    assert_eq!(env.gemas(&env.alice), before_gemas + 1_900);
}

#[test]
fn a_lost_commit_survives_the_reset() {
    let mut env = live();
    env.magic_shell();
    pick_all(&mut env, 0, 0);
    play_flat(&mut env);
    env.commit_lost_standin();
    env.close_seats_standin();
    env.set_time(env.now + trading_duel::RESET_DELAY_SECS);
    env.reset().expect("a lost commit does not hold the reset");
    let t = env.table();
    assert_eq!((t.epoch, t.ring.used(), t.commit.tries), (1, 1, 1));
    env.set_time(env.now + table_kit::COMMIT_RETRY_SECS);
    let ixn = env.commit_ix();
    let err = env.rollup(ixn).unwrap_err();
    assert!(!err.meta.logs.iter().any(|l| l.contains("NotDirty")));
}

#[test]
fn repeated_commit_calls_cost_nothing_once_the_result_is_settled_and_freed() {
    use trading_duel::DuelError::*;
    let mut env = live();
    env.magic_shell();
    pick_all(&mut env, 0, 0);
    play_flat(&mut env);
    env.commit_standin();
    let slot = env.table().slot;
    let m = env.tmatch;
    env.finalize().expect("settle");
    env.set_time(env.now + trading_duel::RELEASE_DELAY_SECS);
    env.release(slot, m).expect("freed");
    let sponsor = env.svm.get_balance(&s(sponsor_addr())).unwrap();
    let before = bytes_of(&env.table());
    for _ in 0..5 {
        env.set_time(env.now + table_kit::COMMIT_RETRY_MAX_SECS);
        let ixn = env.commit_ix();
        assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(NotDirty));
    }
    assert_eq!(bytes_of(&env.table()), before);
    assert_eq!(env.svm.get_balance(&s(sponsor_addr())).unwrap(), sponsor);
}

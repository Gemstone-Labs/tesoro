//! LiteSVM tests: the real holdem and tesoro_core programs (`pnpm build:programs` first).
//!
//! LiteSVM has no delegation, permission, ephemeral-account or VRF programs, so the steps that
//! need them are stood in for by writing the account state they would have produced: creating the
//! two Hole seats, swapping their permission members, the VRF request. Everything else runs as
//! deployed: the oracle's callback (with the identity PDA signing), `deal`, `act`,
//! `claim_timeout`, the table state machine and `finalize` against base's view of the table.
#![allow(clippy::result_large_err)]
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use holdem::{Action, Assignment, Hole, Table};
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
    APk::find_program_address(&[GAME_SEED, holdem::ID.as_ref()], &tesoro_core::ID).0
}
fn program_data_pda() -> APk {
    APk::find_program_address(
        &[holdem::ID.as_ref()],
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
    APk::find_program_address(seeds, &holdem::ID).0
}
fn account_pda(auth: APk) -> APk {
    tpda(&[ACCOUNT_SEED, auth.as_ref()])
}
fn authority_pda() -> APk {
    dpda(&[holdem::AUTHORITY_SEED])
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

/// Anchor custom error code of a holdem error.
fn dcode(e: holdem::HoldemError) -> u32 {
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
    /// Speed of the next Match (0 standard, 1 turbo), carried as the tesoro_core `asset`.
    speed: u8,
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
    /// Counter behind `fresh_secret`.
    secrets: u64,
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

    fn hole(&self, seat: usize) -> Hole {
        self.load(hole_addr(self.table, seat as u8))
    }

    fn patch_hole(&mut self, seat: usize, f: impl FnOnce(&mut Hole)) {
        let mut h = self.hole(seat);
        f(&mut h);
        self.store(hole_addr(self.table, seat as u8), &h, holdem::ID);
    }

    fn patch_table(&mut self, f: impl FnOnce(&mut Table)) {
        let mut t = self.table();
        f(&mut t);
        self.store(self.table, &t, holdem::ID);
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
        // Signature checks are off so a test can present the VRF identity PDA as a signer, which only
        // the oracle's program could do on chain.
        let mut svm = LiteSVM::new().with_sigverify(false);
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/");
        for (id, file) in [
            (tesoro_core::ID, "tesoro_core.so"),
            (holdem::ID, "holdem.so"),
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
            speed: 0,
            tmatch: APk::default(),
            mref: None,
            table: table_addr(0, 0),
            committed: HashMap::new(),
            nonce: 10,
            now: T0,
            last_cu: 0,
            secrets: 0,
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
        // The Game authority is the holdem PDA, not a keypair.
        let ctl = env.ctl_kp();
        let hash = control_program(&mut env.svm, holdem::ID, a(ctl.pubkey()));
        let register = ix(
            tesoro_core::ID,
            tesoro_core::accounts::RegisterGame {
                payer: a(admin.pubkey()),
                control: a(ctl.pubkey()),
                config: tpda(&[CONFIG_SEED]),
                game_program: holdem::ID,
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
                game_program: holdem::ID,
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
            env.init_seats_standin(table_addr(0, index));
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
            holdem::ID,
            holdem::accounts::SetConfig {
                authority: a(ctl.pubkey()),
                config: config_addr(),
                program: holdem::ID,
                program_data: program_data_pda(),
                system_program: anchor_lang::system_program::ID,
            },
            holdem::instruction::SetConfig {
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
            holdem::ID,
            holdem::accounts::CreateSponsor {
                operator: a(self.operator.pubkey()),
                config: config_addr(),
                sponsor: sponsor_addr(),
                system_program: anchor_lang::system_program::ID,
            },
            holdem::instruction::CreateSponsor { lamports },
            vec![],
        )
    }

    fn create_table_ix(&self, signer: APk, generation: u16, index: u16) -> Instruction {
        ix(
            holdem::ID,
            holdem::accounts::CreateTable {
                operator: signer,
                config: config_addr(),
                table: table_addr(generation, index),
                system_program: anchor_lang::system_program::ID,
            },
            holdem::instruction::CreateTable { generation, index },
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
            holdem::ID,
            holdem::accounts::AssignMatch {
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
            holdem::instruction::AssignMatch {
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
            holdem::ID,
            entry,
            n,
            false,
            self.speed,
        )
        .expect("open match");
        flow::join_match(&mut self.svm, &bob.kp, &m, holdem::ID, n + 1).expect("join match");
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
            holdem::ID,
            holdem::accounts::Finalize {
                caller,
                assignment: assign_addr(self.tmatch),
                table: self.table,
                tesoro_match: self.tmatch,
                config: tpda(&[CONFIG_SEED]),
                game_record: game_record_pda(),
                authority: authority_pda(),
                game_program: holdem::ID,
                program_data: program_data_pda(),
                receipt: tpda(&[b"settled", self.tmatch.as_ref()]),
                system_program: anchor_lang::system_program::ID,
                event_authority: tpda(&[b"__event_authority"]),
                tesoro_program: tesoro_core::ID,
            },
            holdem::instruction::Finalize {},
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
            holdem::ID,
            holdem::accounts::BeginMatch {
                caller: a(self.oracle.pubkey()),
                assignment: assign_addr(self.tmatch),
                table: self.table,
                tesoro_match: self.tmatch,
            },
            holdem::instruction::BeginMatch {},
            vec![],
        )
    }

    fn begin(&mut self) -> Result<(), Failed> {
        let ixn = self.begin_ix();
        self.rollup(ixn)
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
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/holdem.so");
        self.svm
            .add_program_from_file(s(sdk_key(MAGIC_PROGRAM_ID)), path)
            .expect("magic shell");
    }

    fn commit_ix(&self) -> Instruction {
        ix(
            holdem::ID,
            holdem::accounts::CommitTable {
                caller: a(self.oracle.pubkey()),
                table: self.table,
                sponsor: sponsor_addr(),
                magic_fee_vault: table_kit::fee_vault_address(&holdem::TEE_VALIDATOR),
                magic_context: sdk_key(ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID),
                magic_program: sdk_key(MAGIC_PROGRAM_ID),
            },
            holdem::instruction::CommitTable {},
            vec![],
        )
    }

    fn reset_ix(&self) -> Instruction {
        ix(
            holdem::ID,
            holdem::accounts::TableOnly {
                caller: a(self.oracle.pubkey()),
                table: self.table,
            },
            holdem::instruction::ResetTable {},
            vec![],
        )
    }

    fn reset(&mut self) -> Result<(), Failed> {
        let ixn = self.reset_ix();
        self.rollup(ixn)
    }

    fn expire_ix(&self) -> Instruction {
        ix(
            holdem::ID,
            holdem::accounts::TableOnly {
                caller: a(self.oracle.pubkey()),
                table: self.table,
            },
            holdem::instruction::ExpireStart {},
            vec![],
        )
    }

    fn release_accounts(&self, m: APk) -> holdem::accounts::Release {
        holdem::accounts::Release {
            caller: a(self.oracle.pubkey()),
            table: self.table,
            receipt: tpda(&[b"settled", m.as_ref()]),
            match_state: m,
        }
    }

    fn release(&mut self, index: u8, m: APk) -> Result<(), Failed> {
        let ixn = ix(
            holdem::ID,
            self.release_accounts(m),
            holdem::instruction::ReleaseSlot { index },
            vec![],
        );
        self.rollup(ixn)
    }

    fn void(&mut self, m: APk) -> Result<(), Failed> {
        let ixn = ix(
            holdem::ID,
            self.release_accounts(m),
            holdem::instruction::VoidTable {},
            vec![],
        );
        self.rollup(ixn)
    }

    /// Stands in for `init_seats`, whose ephemeral-account and permission CPIs need MagicBlock:
    /// both Holes exist, blank and with no member, and the table says so.
    fn init_seats_standin(&mut self, table: APk) {
        for seat in 0..2u8 {
            let (key, bump) = hole_addr_bump(table, seat);
            self.store(key, &Hole::blank(bump, table, seat), holdem::ID);
        }
        let mut t: Table = self.load(table);
        t.seats_created = true;
        self.store(table, &t, holdem::ID);
    }

    /// Stands in for the permission half of `seat_players`: each blank Hole is stamped with its
    /// Player and the table says the seats are theirs.
    fn seat_players_standin(&mut self) {
        let players = self.table().game.players;
        for (seat, player) in players.into_iter().enumerate() {
            self.patch_hole(seat, |h| h.player = player);
        }
        self.patch_table(|t| t.seats_open = true);
    }

    /// Stands in for the permission half of `wipe_seats`: both Holes are back to blank.
    fn wipe_standin(&mut self) {
        for seat in 0..2 {
            self.patch_hole(seat, |h| h.wipe());
        }
        self.patch_table(|t| t.seats_open = false);
    }

    fn person_of(&self, seat: usize) -> (Keypair, APk) {
        let p = if seat == 0 { &self.alice } else { &self.bob };
        (p.kp.insecure_clone(), p.key)
    }

    fn check_in_ix(&self, player: APk) -> Instruction {
        ix(
            holdem::ID,
            holdem::accounts::CheckIn {
                player,
                table: self.table,
            },
            holdem::instruction::CheckIn {},
            vec![],
        )
    }

    fn check_in(&mut self, seat: usize) -> Result<(), Failed> {
        let (kp, key) = self.person_of(seat);
        let ixn = self.check_in_ix(key);
        self.send(&[ixn], &kp, &[])
    }

    /// Begin, hand the seats over, both Players check in: the Match is live at hand one's
    /// shuffle.
    fn start(&mut self) {
        self.begin().expect("begin");
        self.seat_players_standin();
        self.check_in(0).expect("check in 0");
        self.check_in(1).expect("check in 1");
    }

    // --- the shuffle -----------------------------------------------------------------------

    /// A secret nobody has used before.
    fn fresh_secret(&mut self) -> [u8; 32] {
        self.secrets += 1;
        solana_sdk::hash::hashv(&[b"test secret", &self.secrets.to_le_bytes()]).to_bytes()
    }

    fn contribute_ix(&self, seat: usize, secret: [u8; 32]) -> Instruction {
        let (_, key) = self.person_of(seat);
        ix(
            holdem::ID,
            holdem::accounts::ContributeEntropy {
                player: key,
                table: self.table,
                hole: hole_addr(self.table, seat as u8),
            },
            holdem::instruction::ContributeEntropy { secret },
            vec![],
        )
    }

    fn contribute(&mut self, seat: usize, secret: [u8; 32]) -> Result<(), Failed> {
        let (kp, _) = self.person_of(seat);
        let ixn = self.contribute_ix(seat, secret);
        self.send(&[ixn], &kp, &[])
    }

    fn request_ix(&self, payer: APk) -> Instruction {
        let vrf_program =
            APk::new_from_array(ephemeral_rollups_sdk::vrf::consts::VRF_PROGRAM_ID.to_bytes());
        ix(
            holdem::ID,
            holdem::accounts::RequestVrf {
                payer,
                table: self.table,
                hole_0: hole_addr(self.table, 0),
                hole_1: hole_addr(self.table, 1),
                oracle_queue: APk::new_from_array(
                    ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE.to_bytes(),
                ),
                program_identity: dpda(&[ephemeral_rollups_sdk::vrf::consts::IDENTITY]),
                vrf_program,
                slot_hashes: APk::new_from_array(solana_sdk::sysvar::slot_hashes::ID.to_bytes()),
                system_program: anchor_lang::system_program::ID,
            },
            holdem::instruction::RequestVrf {},
            vec![],
        )
    }

    /// Stands in for the part of `request_vrf` that needs the VRF program: the table records the
    /// outstanding request exactly as the instruction does before it calls the oracle.
    fn request_standin(&mut self) {
        let now = self.now;
        self.patch_table(|t| {
            t.req_nonce = t.vrf_nonce;
            t.vrf_nonce += 1;
            t.req_pending = true;
            t.req_epoch = t.epoch;
            t.req_hand = t.game.hand_no;
            t.req_at = now;
        });
    }

    /// The VRF program's callback: the scoped identity PDA signs, as the oracle's CPI makes it.
    fn callback_with(&mut self, randomness: [u8; 32], request: APk) -> Result<(), Failed> {
        let identity = APk::new_from_array(
            ephemeral_rollups_sdk::vrf::consts::scoped_vrf_identity(&holdem::ID).to_bytes(),
        );
        let ixn = ix(
            holdem::ID,
            holdem::accounts::VrfCallbackShuffle {
                vrf_program_identity: identity,
                table: self.table,
                hole_0: hole_addr(self.table, 0),
                hole_1: hole_addr(self.table, 1),
                request,
            },
            holdem::instruction::VrfCallbackShuffle { randomness },
            vec![],
        );
        let payer = self.oracle.insecure_clone();
        self.svm.expire_blockhash();
        let msg = solana_sdk::message::Message::new_with_blockhash(
            &[ixn],
            Some(&payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let mut tx = Transaction::new_unsigned(msg);
        tx.partial_sign(&[&payer], self.svm.latest_blockhash());
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

    /// The marker the outstanding request names.
    fn marker(&self) -> APk {
        let t = self.table();
        holdem::Table::request_marker(&self.table, t.req_nonce)
    }

    fn callback(&mut self, randomness: [u8; 32]) -> Result<(), Failed> {
        let request = self.marker();
        self.callback_with(randomness, request)
    }

    fn deal_ix(&self) -> Instruction {
        ix(
            holdem::ID,
            holdem::accounts::Deal {
                payer: a(self.oracle.pubkey()),
                table: self.table,
                hole_0: hole_addr(self.table, 0),
                hole_1: hole_addr(self.table, 1),
            },
            holdem::instruction::Deal {},
            vec![],
        )
    }

    fn deal(&mut self) -> Result<(), Failed> {
        let ixn = self.deal_ix();
        self.rollup(ixn)
    }

    /// Both Players contribute, the request is made, the oracle answers with `randomness` and the
    /// hand is dealt. Returns the secrets used.
    fn deal_hand(&mut self, randomness: [u8; 32]) -> Result<[[u8; 32]; 2], Failed> {
        let secrets = [self.fresh_secret(), self.fresh_secret()];
        self.contribute(0, secrets[0])?;
        self.contribute(1, secrets[1])?;
        self.request_standin();
        self.callback(randomness)?;
        self.deal()?;
        Ok(secrets)
    }

    /// The hand `deal_hand` must have produced, from the public derivation.
    fn expected_hand(&self, secrets: [[u8; 32]; 2], randomness: [u8; 32], nonce: u64) -> Hand {
        let t = self.table();
        let ctx = holdem::deal::HandContext {
            tesoro_match: t.tesoro_match,
            generation: t.generation,
            index: t.index,
            epoch: t.epoch,
            hand_no: t.game.hand_no,
            nonce,
        };
        let halves = [
            holdem::deal::vrf_half(0, &randomness, nonce),
            holdem::deal::vrf_half(1, &randomness, nonce),
        ];
        let seed = holdem::deal::derive_seed(
            &ctx,
            &holdem::deal::Contributions {
                secrets,
                halves,
                ext: [[0; 32]; 2],
            },
        );
        let (holes, board) = holdem::deal::split_hand(&holdem::deal::draw_hand(&seed));
        Hand {
            seed,
            halves,
            holes,
            board,
        }
    }

    // --- betting ---------------------------------------------------------------------------

    fn act_ix(&self, player: APk, action: Action) -> Instruction {
        ix(
            holdem::ID,
            holdem::accounts::Act {
                player,
                table: self.table,
                hole_0: hole_addr(self.table, 0),
                hole_1: hole_addr(self.table, 1),
            },
            holdem::instruction::Act { action },
            vec![],
        )
    }

    fn act(&mut self, seat: usize, action: Action) -> Result<(), Failed> {
        let (kp, key) = self.person_of(seat);
        let ixn = self.act_ix(key, action);
        self.send(&[ixn], &kp, &[])
    }

    fn timeout_ix(&self, caller: APk) -> Instruction {
        ix(
            holdem::ID,
            holdem::accounts::ClaimTimeout {
                caller,
                table: self.table,
                hole_0: hole_addr(self.table, 0),
                hole_1: hole_addr(self.table, 1),
            },
            holdem::instruction::ClaimTimeout {},
            vec![],
        )
    }

    fn claim_timeout(&mut self) -> Result<(), Failed> {
        let ixn = self.timeout_ix(a(self.oracle.pubkey()));
        self.rollup(ixn)
    }

    /// Jumps past the current hand deadline.
    fn past_deadline(&mut self) {
        let d = self.table().game.deadline;
        self.set_time(d + 1);
    }

    /// The seat to act shoves its whole stack, the other calls: the hand and, unless the pot is
    /// split, the Match ends.
    fn shove_and_call(&mut self) -> Result<(), Failed> {
        let g = self.table().game;
        if !(holdem::PHASE_PREFLOP..=holdem::PHASE_RIVER).contains(&g.phase) {
            return Ok(()); // settled at the deal by blinds that put a stack all-in
        }
        let first = usize::from(g.to_act);
        let to = g.bets[first] + g.stacks[first];
        self.act(first, Action::Raise { to })?;
        self.act(1 - first, Action::Call)
    }

    /// Plays hands (every one a shove and a call) until the Match is over; returns the winner.
    fn play_match_out(&mut self) -> usize {
        for _ in 0..60 {
            if self.table().game.status != holdem::STATUS_LIVE {
                break;
            }
            let randomness =
                solana_sdk::hash::hashv(&[b"rand", &self.secrets.to_le_bytes()]).to_bytes();
            self.deal_hand(randomness).expect("deal");
            self.shove_and_call().expect("shove");
        }
        let g = self.table().game;
        assert_eq!(g.status, holdem::STATUS_OVER, "the Match ended");
        usize::from(g.winner)
    }

    /// Plays one whole Match on the table under test to a committed result; returns the winner.
    fn play(&mut self) -> usize {
        self.start();
        let winner = self.play_match_out();
        self.commit_standin();
        winner
    }

    fn winner_person(&self, seat: usize) -> &Person {
        if seat == 0 {
            &self.alice
        } else {
            &self.bob
        }
    }
}

/// What the public derivation says a deal must have produced.
struct Hand {
    seed: [u8; 32],
    halves: [[u8; 32]; 2],
    holes: [[u8; 2]; 2],
    board: [u8; 5],
}

fn dlp() -> APk {
    sdk_key(ephemeral_rollups_sdk::id())
}
fn table_addr(generation: u16, index: u16) -> APk {
    holdem::table_address(generation, index)
}
fn config_addr() -> APk {
    dpda(&[holdem::CONFIG_SEED])
}
fn sponsor_addr() -> APk {
    dpda(&[holdem::SPONSOR_SEED])
}
fn assign_addr(m: APk) -> APk {
    dpda(&[holdem::ASSIGN_SEED, m.as_ref()])
}
fn hole_addr_bump(table: APk, seat: u8) -> (APk, u8) {
    holdem::hole_address(&table, seat)
}
fn hole_addr(table: APk, seat: u8) -> APk {
    hole_addr_bump(table, seat).0
}
fn perm_addr(k: APk) -> APk {
    APk::find_program_address(
        &[
            ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED,
            k.as_ref(),
        ],
        &sdk_key(PERMISSION_PROGRAM_ID),
    )
    .0
}

use ephemeral_rollups_sdk::consts::{MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

fn sdk_key(p: ephemeral_rollups_sdk::compat::Pubkey) -> APk {
    APk::new_from_array(p.to_bytes())
}

const SHUFFLE: u8 = holdem::PHASE_SHUFFLE;

/// The first table, assigned to a Match that is open and joined.
fn ready() -> Env {
    let mut env = Env::new();
    env.next_match_on(0);
    env.table = table_addr(0, 0);
    env
}

/// A started Match waiting for hand one's shuffle.
fn live() -> Env {
    let mut env = ready();
    env.start();
    env
}

/// Hand one dealt from a known oracle answer.
fn dealt() -> (Env, [[u8; 32]; 2], [u8; 32]) {
    let mut env = live();
    let randomness = [0x5au8; 32];
    let secrets = env.deal_hand(randomness).expect("deal");
    (env, secrets, randomness)
}

fn bytes_of(t: &Table) -> Vec<u8> {
    let mut v = Vec::new();
    t.try_serialize(&mut v).expect("serialize");
    v
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    needle.len() <= haystack.len() && haystack.windows(needle.len()).any(|w| w == needle)
}

// =========================================================================================
// Tests
// =========================================================================================

// --- Config, tables, assignment --------------------------------------------------------------

#[test]
fn only_the_upgrade_authority_sets_the_config_and_the_generation_only_rises() {
    let mut env = Env::new();
    let stranger = env.admin.insecure_clone();
    let ixn = ix(
        holdem::ID,
        holdem::accounts::SetConfig {
            authority: a(stranger.pubkey()),
            config: config_addr(),
            program: holdem::ID,
            program_data: program_data_pda(),
            system_program: anchor_lang::system_program::ID,
        },
        holdem::instruction::SetConfig {
            operator: a(stranger.pubkey()),
            generation: 0,
            max_tables: 4,
        },
        vec![],
    );
    let err = env.send(&[ixn], &stranger, &[]).unwrap_err();
    assert_eq!(
        custom_code(&err),
        dcode(holdem::HoldemError::NotUpgradeAuthority)
    );
    env.set_config(a(env.operator.pubkey()), 1, 8)
        .expect("raise");
    let err = env.set_config(a(env.operator.pubkey()), 0, 8).unwrap_err();
    assert_eq!(custom_code(&err), dcode(holdem::HoldemError::BadConfig));
    for (op, max) in [
        (APk::default(), 4u16),
        (a(env.operator.pubkey()), 0),
        (a(env.operator.pubkey()), 257),
    ] {
        let err = env.set_config(op, 1, max).unwrap_err();
        assert_eq!(custom_code(&err), dcode(holdem::HoldemError::BadConfig));
    }
}

#[test]
fn only_the_operator_creates_tables_inside_the_cap_and_the_current_generation() {
    use holdem::HoldemError::*;
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
        (0, 2, 0, holdem::TABLE_IDLE)
    );
    assert!(!t.seats_created, "the seats are made in the rollup");
    assert!(t.ring.slots.iter().all(|s| s.state == table_kit::SLOT_FREE));
}

#[test]
fn assignment_copies_players_and_speed_from_the_match_and_holds_the_refund_timer() {
    let env = ready();
    let asg: Assignment = env.load(assign_addr(env.tmatch));
    assert_eq!(
        asg.players,
        [env.alice.key, env.bob.key],
        "seat order is the Match's"
    );
    assert_eq!(asg.speed, holdem::SPEED_STANDARD);
    assert_eq!((asg.generation, asg.index, asg.epoch), (0, 0, 0));
    assert_eq!(asg.start_deadline, T0 + holdem::START_WINDOW_SECS);
    assert_eq!(asg.payer, a(env.operator.pubkey()));
    let m = env.load::<MatchState>(env.tmatch).inner;
    assert_eq!(m.deadline, T0 + holdem::TABLE_WINDOW_SECS);
}

#[test]
fn the_speed_is_the_one_the_match_was_opened_with_and_two_is_refused() {
    let mut env = Env::new();
    env.speed = holdem::SPEED_TURBO;
    env.next_match_on(0);
    let asg: Assignment = env.load(assign_addr(env.tmatch));
    assert_eq!(asg.speed, holdem::SPEED_TURBO);
    env.begin().unwrap();
    env.seat_players_standin();
    env.check_in(0).unwrap();
    env.check_in(1).unwrap();
    assert_eq!(
        env.table().game.small_blind,
        50,
        "turbo blinds start at 50/100"
    );

    let mut env = Env::new();
    env.speed = 2;
    env.open_and_join(1_000);
    let err = env.assign(0, 0, 0).unwrap_err();
    assert_eq!(custom_code(&err), dcode(holdem::HoldemError::InvalidSpeed));
}

#[test]
fn only_the_operator_assigns_once_and_only_to_a_real_table_slot() {
    use holdem::HoldemError::*;
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
    let m =
        flow::open_match(&mut env.svm, &alice.kp, holdem::ID, 1_000, 5, false, 0).expect("open");
    env.tmatch = m.key;
    let err = env.assign(0, 0, 0).unwrap_err();
    assert_eq!(
        custom_code(&err),
        dcode(holdem::HoldemError::BadTesoroMatch)
    );
}

// --- begin, seats, check-in -----------------------------------------------------------------

#[test]
fn begin_reserves_a_ring_slot_and_copies_the_match_from_the_assignment() {
    let mut env = ready();
    env.begin().expect("begin");
    let t = env.table();
    assert_eq!(t.phase, holdem::TABLE_WAITING);
    assert_eq!(t.tesoro_match, env.tmatch);
    assert_eq!(t.game.players, [env.alice.key, env.bob.key]);
    assert_eq!(t.game.status, holdem::STATUS_CREATED, "not started yet");
    assert_eq!(t.start_deadline, T0 + holdem::START_WINDOW_SECS);
    let (i, slot) = t.ring.find(&env.tmatch, 0).expect("slot");
    assert_eq!((i, slot.state), (t.slot, table_kit::SLOT_RESERVED));
    assert_eq!(
        custom_code(&env.begin().unwrap_err()),
        dcode(holdem::HoldemError::WrongPhase)
    );
}

#[test]
fn begin_refuses_a_wrong_table_epoch_or_late_start_a_frozen_match_and_a_table_without_seats() {
    use holdem::HoldemError::*;
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
    env.set_time(T0 + holdem::START_WINDOW_SECS + 1);
    assert_eq!(
        custom_code(&env.begin().unwrap_err()),
        dcode(StartWindowPassed)
    );
    // a Match tesoro_core already froze
    let mut env = ready();
    env.set_time(T0 + holdem::TABLE_WINDOW_SECS + 1);
    core_refund(&mut env).expect("anyone refunds past the deadline");
    assert_eq!(
        custom_code(&env.begin().unwrap_err()),
        dcode(BadTesoroMatch)
    );
    // a table whose seats were never made
    let mut env = ready();
    env.patch_table(|t| t.seats_created = false);
    assert_eq!(custom_code(&env.begin().unwrap_err()), dcode(SeatsMissing));
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
            game_program: holdem::ID,
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
    assert_eq!(custom_code(&err), dcode(holdem::HoldemError::RingFull));
}

#[test]
fn both_players_check_in_and_the_second_one_starts_the_match() {
    use holdem::HoldemError::*;
    let mut env = ready();
    env.begin().unwrap();
    assert_eq!(
        custom_code(&env.check_in(0).unwrap_err()),
        dcode(SeatsNotOpen)
    );
    env.seat_players_standin();
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
        (holdem::TABLE_WAITING, [true, false])
    );
    assert_eq!(
        t.game.status,
        holdem::STATUS_CREATED,
        "the clock has not started"
    );
    let secret = env.fresh_secret();
    assert_eq!(
        custom_code(&env.contribute(0, secret).unwrap_err()),
        dcode(NotLive)
    );
    env.set_time(T0 + 5);
    env.check_in(1).unwrap();
    let t = env.table();
    assert_eq!(t.phase, holdem::TABLE_LIVE);
    let g = t.game;
    assert_eq!(
        (
            g.status,
            g.phase,
            g.hand_no,
            g.stacks[0] + g.stacks[1] + g.committed[0] + g.committed[1]
        ),
        (holdem::STATUS_LIVE, SHUFFLE, 1, 2 * holdem::STARTING_CHIPS)
    );
    assert_eq!(g.deadline, T0 + 5 + holdem::ENTROPY_SECS);
}

#[test]
fn a_late_check_in_is_refused_and_a_player_who_never_came_gets_a_refund_from_the_ring() {
    use holdem::HoldemError::*;
    let mut env = ready();
    env.begin().unwrap();
    env.seat_players_standin();
    env.check_in(0).unwrap();
    let deadline = env.table().start_deadline;
    // not expirable before the deadline
    let ixn = env.expire_ix();
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(NotTimedOut)
    );
    env.set_time(deadline + 1);
    assert_eq!(
        custom_code(&env.check_in(1).unwrap_err()),
        dcode(StartWindowPassed)
    );
    let ixn = env.expire_ix();
    env.rollup(ixn).expect("expire");
    let t = env.table();
    assert_eq!((t.phase, t.dirty), (holdem::TABLE_OVER, true));
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

// --- The shuffle ----------------------------------------------------------------------------

#[test]
fn contributing_touches_only_the_players_own_hole_and_reads_the_table() {
    use holdem::HoldemError::*;
    let mut env = live();
    let ixn = env.contribute_ix(0, [1; 32]);
    let writable: Vec<_> = ixn.accounts.iter().filter(|m| m.is_writable).collect();
    assert_eq!(
        writable.len(),
        1,
        "only the Hole is writable, and the signer is not paying: {writable:?}"
    );
    assert_eq!(writable[0].pubkey, s(hole_addr(env.table, 0)));
    let table_before = bytes_of(&env.table());

    // A Player cannot contribute into the other seat or as a stranger.
    let stranger = env.admin.insecure_clone();
    let mut theirs = env.contribute_ix(1, [2; 32]);
    theirs.accounts[0].pubkey = stranger.pubkey();
    assert_eq!(
        custom_code(&env.send(&[theirs], &stranger, &[]).unwrap_err()),
        dcode(NotAPlayer)
    );
    // Bob cannot write Alice's Hole.
    let mut cross = env.contribute_ix(1, [2; 32]);
    cross.accounts[2].pubkey = s(hole_addr(env.table, 0));
    let bob = env.bob.kp.insecure_clone();
    assert_eq!(
        custom_code(&env.send(&[cross], &bob, &[]).unwrap_err()),
        dcode(NotAPlayer)
    );

    env.contribute(0, [1; 32]).unwrap();
    assert_eq!(
        bytes_of(&env.table()),
        table_before,
        "the table is untouched"
    );
    let h = env.hole(0);
    assert!(h.contributed && h.secret == [1; 32] && h.hand_no == 1);
    assert_eq!(
        custom_code(&env.contribute(0, [9; 32]).unwrap_err()),
        dcode(AlreadyContributed)
    );
    assert_eq!(
        env.hole(0).secret,
        [1; 32],
        "a second secret is not folded in"
    );
}

#[test]
fn the_request_needs_both_secrets_and_is_made_once_per_hand() {
    use holdem::HoldemError::*;
    let mut env = live();
    env.magic_shell_for_vrf();
    let ixn = env.request_ix(a(env.oracle.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn.clone()).unwrap_err()),
        dcode(EntropyIncomplete)
    );
    env.contribute(0, [1; 32]).unwrap();
    assert_eq!(
        custom_code(&env.rollup(ixn.clone()).unwrap_err()),
        dcode(EntropyIncomplete)
    );
    env.contribute(1, [2; 32]).unwrap();
    // With both secrets the checks pass and the call reaches the VRF program, which LiteSVM does
    // not have (devnet evidence, ticket 24).
    let err = env.rollup(ixn.clone()).unwrap_err();
    assert!(
        !err.meta.logs.iter().any(|l| l.contains("Error Number: 6")),
        "{:?}",
        err.meta.logs
    );
    // Once a request is outstanding, or the hand's request was made, a second one is refused.
    env.request_standin();
    assert_eq!(
        custom_code(&env.rollup(ixn.clone()).unwrap_err()),
        dcode(AlreadyDealt)
    );
    env.callback([3; 32]).unwrap();
    assert_eq!(
        custom_code(&env.rollup(ixn.clone()).unwrap_err()),
        dcode(AlreadyDealt),
        "the answer is in and waits for the deal"
    );
    env.deal().unwrap();
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(WrongPhase),
        "no request mid-hand"
    );
}

#[test]
fn a_secret_cannot_be_given_after_the_request() {
    let mut env = live();
    env.contribute(0, [1; 32]).unwrap();
    env.contribute(1, [2; 32]).unwrap();
    env.request_standin();
    assert!(env.contribute(0, [4; 32]).is_err());
    assert_eq!(env.hole(0).secret, [1; 32], "frozen");
}

#[test]
fn deal_needs_both_secrets_and_the_answer() {
    use holdem::HoldemError::*;
    let mut env = live();
    assert_eq!(
        custom_code(&env.deal().unwrap_err()),
        dcode(EntropyIncomplete)
    );
    env.contribute(0, [1; 32]).unwrap();
    env.contribute(1, [2; 32]).unwrap();
    assert_eq!(
        custom_code(&env.deal().unwrap_err()),
        dcode(EntropyIncomplete),
        "no answer yet"
    );
    env.request_standin();
    assert_eq!(
        custom_code(&env.deal().unwrap_err()),
        dcode(EntropyIncomplete),
        "requested but not answered"
    );
    env.callback([3; 32]).unwrap();
    env.deal().expect("deal");
    assert_eq!(
        custom_code(&env.deal().unwrap_err()),
        dcode(WrongPhase),
        "a hand is dealt once"
    );
}

#[test]
fn deal_writes_the_derived_hand_into_the_holes_and_nothing_public() {
    let (env, secrets, randomness) = dealt();
    let want = env.expected_hand(secrets, randomness, 0);
    let (h0, h1) = (env.hole(0), env.hole(1));
    assert_eq!((h0.cards, h1.cards), (want.holes[0], want.holes[1]));
    assert!(h0.dealt && h1.dealt);
    assert_eq!(
        holdem::deal::combine_shares(&[h0.shares, h1.shares]),
        want.board,
        "the two shares make the board"
    );
    assert_ne!(h0.shares, want.board, "neither share is the board");
    assert_ne!(h1.shares, want.board);
    let g = env.table().game;
    assert_eq!(
        g.board,
        [holdem::NO_CARD; 5],
        "nothing of the board is public"
    );
    assert_eq!(g.phase, holdem::PHASE_PREFLOP);
    let mut seen = std::collections::HashSet::new();
    for c in want.holes.iter().flatten().chain(want.board.iter()) {
        assert!(*c < 52 && seen.insert(*c), "nine distinct cards");
    }
}

#[test]
fn nothing_that_made_the_shuffle_survives_the_deal() {
    let (env, secrets, randomness) = dealt();
    let want = env.expected_hand(secrets, randomness, 0);
    let t = env.table;
    let mut needles: Vec<(&str, Vec<u8>)> = vec![
        ("seed", want.seed.to_vec()),
        ("secret 0", secrets[0].to_vec()),
        ("secret 1", secrets[1].to_vec()),
        ("vrf half 0", want.halves[0].to_vec()),
        ("vrf half 1", want.halves[1].to_vec()),
        ("vrf output", randomness.to_vec()),
        ("nine cards", {
            let mut v = vec![];
            v.extend(want.holes.iter().flatten());
            v.extend(want.board);
            v
        }),
    ];
    needles.push(("board", want.board.to_vec()));
    // Every account the Game owns for this table, plus the Assignment and the Sponsor.
    let accounts = [
        t,
        hole_addr(t, 0),
        hole_addr(t, 1),
        assign_addr(env.tmatch),
        sponsor_addr(),
        config_addr(),
    ];
    for key in accounts {
        let Some(acct) = env.svm.get_account(&s(key)) else {
            continue;
        };
        for (name, needle) in &needles {
            if *name == "nine cards" {
                continue;
            }
            // The board is public by design once a street is revealed; it is not yet.
            if *name == "board" && (key == hole_addr(t, 0) || key == hole_addr(t, 1)) {
                continue;
            }
            assert!(
                !contains(&acct.data, needle),
                "{name} found in account {key}"
            );
        }
    }
    // The Holes keep only the Players' own hole cards and one XOR share of the board each.
    for (seat, secret) in secrets.iter().enumerate() {
        let h = env.hole(seat);
        assert_eq!(h.secret, [0; 32]);
        assert_eq!(h.half, [0; 32]);
        assert!(!h.contributed && !h.half_set);
        assert_eq!(h.last_secret_hash, holdem::deal::secret_hash(secret));
    }
}

#[test]
fn the_deal_logs_nothing() {
    let mut env = live();
    env.contribute(0, [1; 32]).unwrap();
    env.contribute(1, [2; 32]).unwrap();
    env.request_standin();
    env.callback([3; 32]).unwrap();
    let ixn = env.deal_ix();
    let caller = env.oracle.insecure_clone();
    env.svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ixn],
        Some(&caller.pubkey()),
        &[&caller],
        env.svm.latest_blockhash(),
    );
    let meta = env.svm.send_transaction(tx).expect("deal");
    for line in &meta.logs {
        assert!(
            line.starts_with("Program log: Instruction:")
                || line.starts_with("Program CjhY")
                || line.starts_with("Program consumption"),
            "unexpected log line: {line}"
        );
    }
}

#[test]
fn only_the_answer_to_the_outstanding_request_is_accepted_and_only_once() {
    use holdem::HoldemError::*;
    let mut env = live();
    env.contribute(0, [1; 32]).unwrap();
    env.contribute(1, [2; 32]).unwrap();
    // No request yet.
    let marker = holdem::Table::request_marker(&env.table, 0);
    assert_eq!(
        custom_code(&env.callback_with([3; 32], marker).unwrap_err()),
        dcode(StaleRequest)
    );
    env.request_standin();
    // An answer that names another request.
    for wrong in [
        holdem::Table::request_marker(&env.table, 1),
        holdem::Table::request_marker(&table_addr(0, 1), 0),
        APk::new_unique(),
    ] {
        assert_eq!(
            custom_code(&env.callback_with([3; 32], wrong).unwrap_err()),
            dcode(StaleRequest)
        );
    }
    assert!(!env.table().vrf_ready);
    env.callback([3; 32]).expect("the real answer");
    let t = env.table();
    assert!(t.vrf_ready && !t.req_pending);
    assert!(env.hole(0).half_set && env.hole(1).half_set);
    assert_ne!(env.hole(0).half, env.hole(1).half);
    // A replay of the same answer, or a second one, is refused.
    assert_eq!(
        custom_code(&env.callback([4; 32]).unwrap_err()),
        dcode(StaleRequest)
    );
    // A real callback is signed by the VRF program's identity and nobody else.
    let ixn = ix(
        holdem::ID,
        holdem::accounts::VrfCallbackShuffle {
            vrf_program_identity: env.oracle.pubkey().to_bytes().into(),
            table: env.table,
            hole_0: hole_addr(env.table, 0),
            hole_1: hole_addr(env.table, 1),
            request: env.marker(),
        },
        holdem::instruction::VrfCallbackShuffle {
            randomness: [5; 32],
        },
        vec![],
    );
    assert!(env.rollup(ixn).is_err(), "not the VRF identity");
}

#[test]
fn a_stale_answer_after_a_reset_or_on_a_new_hand_is_refused() {
    use holdem::HoldemError::*;
    // Match one: request made, then the hand is lost (the oracle never answers in time).
    let mut env = live();
    env.contribute(0, [1; 32]).unwrap();
    env.contribute(1, [2; 32]).unwrap();
    env.request_standin();
    let old_marker = env.marker();
    for _ in 0..=holdem::VRF_MAX_EXTENSIONS {
        env.past_deadline();
        env.claim_timeout().unwrap();
    }
    let t = env.table();
    assert_eq!(
        (t.phase, t.game.status),
        (holdem::TABLE_OVER, holdem::STATUS_CANCELLED)
    );
    assert!(!t.req_pending, "the request is abandoned with the Match");
    // The late answer arrives while the table is Over, then after the reset: refused both times.
    assert_eq!(
        custom_code(&env.callback_with([7; 32], old_marker).unwrap_err()),
        dcode(StaleRequest)
    );
    env.commit_standin();
    env.wipe_standin();
    env.set_time(env.now + holdem::RESET_DELAY_SECS);
    env.reset().unwrap();
    assert_eq!(
        custom_code(&env.callback_with([7; 32], old_marker).unwrap_err()),
        dcode(StaleRequest)
    );
    // Match two on the same table makes its own request; the old answer still cannot land on it.
    env.next_match_on(0);
    env.start();
    env.contribute(0, [1; 32]).unwrap();
    env.contribute(1, [2; 32]).unwrap();
    env.request_standin();
    assert_ne!(env.marker(), old_marker, "request numbers never repeat");
    assert_eq!(
        custom_code(&env.callback_with([7; 32], old_marker).unwrap_err()),
        dcode(StaleRequest)
    );
    env.callback([7; 32]).expect("its own answer lands");
}

#[test]
fn the_same_secrets_and_answer_in_the_next_match_give_a_different_deal() {
    let mut env = Env::new();
    let mut hands = vec![];
    let mut seeds = vec![];
    for _ in 0..3 {
        env.next_match_on(0);
        env.start();
        // Same secrets, same oracle output every time.
        env.contribute(0, [1; 32]).unwrap();
        env.contribute(1, [2; 32]).unwrap();
        env.request_standin();
        env.callback([3; 32]).unwrap();
        let nonce = env.table().req_nonce;
        env.deal().unwrap();
        let want = env.expected_hand([[1; 32], [2; 32]], [3; 32], nonce);
        assert_eq!(env.hole(0).cards, want.holes[0]);
        hands.push((env.hole(0).cards, env.hole(1).cards, want.board));
        seeds.push(want.seed);
        // End the Match: Alice folds hand one, then wipe and reset.
        let seat = usize::from(env.table().game.to_act);
        env.act(seat, Action::Fold).unwrap();
        env.past_deadline();
        env.finish_by_forfeit();
        env.commit_standin();
        env.wipe_standin();
        env.set_time(env.now + holdem::RESET_DELAY_SECS);
        env.reset().unwrap();
    }
    assert!(seeds[0] != seeds[1] && seeds[1] != seeds[2] && seeds[0] != seeds[2]);
    assert!(
        hands[0] != hands[1] || hands[1] != hands[2],
        "three Matches with identical inputs must not deal identically: {hands:?}"
    );
}

#[test]
fn a_secret_cannot_repeat_at_a_seat() {
    use holdem::HoldemError::*;
    let (mut env, secrets, _) = dealt();
    // Play the hand out by folding, so hand two starts.
    let first = usize::from(env.table().game.to_act);
    env.act(first, Action::Fold).unwrap();
    assert_eq!(env.table().game.phase, SHUFFLE);
    assert_eq!(env.table().game.hand_no, 2);
    assert_eq!(
        custom_code(&env.contribute(0, secrets[0]).unwrap_err()),
        dcode(SecretReused)
    );
    let fresh = env.fresh_secret();
    env.contribute(0, fresh).expect("a fresh secret is fine");
}

// --- The hand -------------------------------------------------------------------------------

#[test]
fn only_the_player_to_act_may_act_and_rules_are_enforced_on_chain() {
    use holdem::HoldemError::*;
    let (mut env, _, _) = dealt();
    let g = env.table().game;
    let first = usize::from(g.to_act);
    let second = 1 - first;
    assert_eq!(
        custom_code(&env.act(second, Action::Call).unwrap_err()),
        dcode(NotYourTurn)
    );
    assert_eq!(
        custom_code(&env.act(first, Action::Check).unwrap_err()),
        dcode(CannotCheck)
    );
    assert_eq!(
        custom_code(
            &env.act(first, Action::Raise { to: g.big_blind })
                .unwrap_err()
        ),
        dcode(RaiseTooSmall)
    );
    env.act(first, Action::Call).expect("limp");
    assert_eq!(env.table().game.to_act as usize, second);
}

#[test]
fn a_stranger_cannot_act() {
    let (mut env, _, _) = dealt();
    let stranger = env.admin.insecure_clone();
    let ixn = env.act_ix(a(stranger.pubkey()), Action::Fold);
    assert_eq!(
        custom_code(&env.send(&[ixn], &stranger, &[]).unwrap_err()),
        dcode(holdem::HoldemError::NotAPlayer)
    );
}

#[test]
fn error_codes_do_not_depend_on_the_hidden_cards() {
    // The same illegal move, on hands with different hidden cards, fails the same way.
    let mut codes = vec![];
    for answer in [[1u8; 32], [2; 32], [3; 32], [4; 32]] {
        let mut env = live();
        env.deal_hand(answer).unwrap();
        let first = usize::from(env.table().game.to_act);
        let e1 = custom_code(&env.act(first, Action::Check).unwrap_err());
        let e2 = custom_code(&env.act(1 - first, Action::Call).unwrap_err());
        codes.push((e1, e2));
    }
    assert!(codes.windows(2).all(|w| w[0] == w[1]), "{codes:?}");
}

#[test]
fn a_fold_wipes_the_hands_cards_and_shares_and_opens_the_next_shuffle() {
    let (mut env, _, _) = dealt();
    let first = usize::from(env.table().game.to_act);
    env.act(first, Action::Fold).unwrap();
    let t = env.table();
    assert_eq!((t.game.phase, t.game.hand_no), (SHUFFLE, 2));
    for seat in 0..2 {
        let h = env.hole(seat);
        assert!(!h.dealt, "no hand in the seat");
        assert_eq!((h.cards, h.shares), ([0; 2], [0; 5]));
        assert_eq!(
            h.player,
            env.person_of(seat).1,
            "the seat stays with its Player"
        );
    }
    assert!(!t.game.last_showdown);
    assert_eq!(
        t.game.last_shown,
        [[holdem::NO_CARD; 2]; 2],
        "a fold shows nothing"
    );
}

#[test]
fn board_cards_become_public_street_by_street_from_the_two_shares() {
    let (mut env, secrets, randomness) = dealt();
    let want = env.expected_hand(secrets, randomness, 0);
    let g = env.table().game;
    let first = usize::from(g.to_act);
    env.act(first, Action::Call).unwrap();
    env.act(1 - first, Action::Check).unwrap();
    assert_eq!(env.table().game.phase, holdem::PHASE_FLOP);
    let b = env.table().game.board;
    assert_eq!(&b[..3], &want.board[..3]);
    assert_eq!(&b[3..], &[holdem::NO_CARD; 2]);
    // The out-of-position Player acts first after the flop.
    let g = env.table().game;
    let first = usize::from(g.to_act);
    env.act(first, Action::Check).unwrap();
    env.act(1 - first, Action::Check).unwrap();
    assert_eq!(env.table().game.board[3], want.board[3]);
    assert_eq!(env.table().game.board[4], holdem::NO_CARD);
    let first = usize::from(env.table().game.to_act);
    env.act(first, Action::Check).unwrap();
    env.act(1 - first, Action::Check).unwrap();
    assert_eq!(env.table().game.board, want.board);
    let first = usize::from(env.table().game.to_act);
    env.act(first, Action::Check).unwrap();
    env.act(1 - first, Action::Check).unwrap();
    // Showdown: the hole cards are public in the record, the seats are clean, hand two is next.
    let g = env.table().game;
    assert!(g.last_showdown);
    assert_eq!(g.last_shown, want.holes);
    assert_eq!(g.last_board, want.board);
    assert_eq!(g.hand_no, 2);
    assert_eq!(env.hole(0).cards, [0; 2]);
}

// --- Results, the ring and finalize ---------------------------------------------------------

#[test]
fn a_shove_and_call_decides_the_match_the_result_goes_into_the_ring_and_finalize_pays_the_winner() {
    let mut env = ready();
    env.begin().unwrap();
    let begin_cu = env.last_cu;
    env.seat_players_standin();
    env.check_in(0).unwrap();
    env.check_in(1).unwrap();
    let check_in_cu = env.last_cu;
    env.contribute(0, [1; 32]).unwrap();
    let contribute_cu = env.last_cu;
    env.contribute(1, [2; 32]).unwrap();
    env.request_standin();
    env.callback([3; 32]).unwrap();
    let callback_cu = env.last_cu;
    env.deal().unwrap();
    let deal_cu = env.last_cu;
    env.shove_and_call().unwrap();
    let act_cu = env.last_cu;
    let mut winner = None;
    let mut tries = 0;
    // A split pot (rare) plays another hand.
    while env.table().game.status == holdem::STATUS_LIVE {
        tries += 1;
        assert!(tries < 20);
        env.deal_hand([tries as u8; 32]).unwrap();
        env.shove_and_call().unwrap();
    }
    let t = env.table();
    assert_eq!((t.phase, t.dirty), (holdem::TABLE_OVER, true));
    assert_eq!(t.game.status, holdem::STATUS_OVER);
    let w = usize::from(t.game.winner);
    winner.get_or_insert(w);
    let (_, slot) = t.ring.find(&env.tmatch, 0).expect("slot");
    assert_eq!(
        (slot.state, slot.outcome),
        (
            table_kit::SLOT_DONE,
            if w == 0 {
                table_kit::OUTCOME_WIN0
            } else {
                table_kit::OUTCOME_WIN1
            }
        )
    );
    assert_eq!(t.game.stacks[w], 2 * holdem::STARTING_CHIPS);
    env.commit_standin();
    let loser = 1 - w;
    let before = (
        env.gemas(env.winner_person(w)),
        env.gemas(env.winner_person(loser)),
    );
    env.finalize_start().expect("settle");
    let finalize_cu = env.last_cu;
    env.run_settlement();
    assert_eq!(
        env.gemas(env.winner_person(w)),
        before.0 + 1_900,
        "pot of 2000 less 5% fees"
    );
    assert_eq!(env.gemas(env.winner_person(loser)), before.1);
    assert_eq!(env.tesoro_status(), Stage::Closed);
    println!(
        "CU begin {begin_cu} check_in {check_in_cu} contribute {contribute_cu} callback {callback_cu} deal {deal_cu} act(shove->showdown) {act_cu} finalize {finalize_cu}"
    );
    for (name, cu) in [
        ("begin", begin_cu),
        ("check_in", check_in_cu),
        ("contribute", contribute_cu),
        ("callback", callback_cu),
        ("deal", deal_cu),
        ("act", act_cu),
    ] {
        assert!(cu < 200_000, "{name} used {cu} CU");
    }
    assert!(finalize_cu < 300_000, "finalize used {finalize_cu} CU");
}

#[test]
fn the_second_seat_can_win_and_chips_are_conserved_in_every_hand() {
    // Different oracle answers until seat 1 wins one Match; chips always add up.
    let mut found = false;
    for round in 0..12u8 {
        let mut env = ready();
        env.start();
        let mut guard = 0;
        while env.table().game.status == holdem::STATUS_LIVE {
            guard += 1;
            assert!(guard < 40);
            env.deal_hand([round.wrapping_mul(17).wrapping_add(guard); 32])
                .unwrap();
            env.shove_and_call().unwrap();
            let g = env.table().game;
            assert_eq!(
                g.stacks[0] + g.stacks[1] + g.committed[0] + g.committed[1],
                3_000
            );
        }
        if env.table().game.winner == 1 {
            env.commit_standin();
            let before = env.gemas(&env.bob);
            env.finalize().expect("settle");
            assert_eq!(env.gemas(&env.bob), before + 1_900);
            found = true;
            break;
        }
    }
    assert!(found, "seat 1 wins some Match");
}

#[test]
fn a_whole_match_of_short_hands_conserves_chips_and_settles_once() {
    let mut env = ready();
    env.start();
    let mut hands = 0;
    while env.table().game.status == holdem::STATUS_LIVE {
        hands += 1;
        assert!(hands < 80);
        env.deal_hand([hands as u8; 32]).unwrap();
        let first = usize::from(env.table().game.to_act);
        // Late blinds can put a stack all-in at the deal, which settles the hand there and then.
        let betting =
            (holdem::PHASE_PREFLOP..=holdem::PHASE_RIVER).contains(&env.table().game.phase);
        // Fold hands pass the chips one blind at a time; every tenth hand is a shove.
        if !betting {
        } else if hands % 10 == 0 {
            env.shove_and_call().unwrap();
        } else {
            env.act(first, Action::Fold).unwrap();
        }
        let g = env.table().game;
        assert_eq!(
            g.stacks[0] + g.stacks[1] + g.committed[0] + g.committed[1],
            3_000
        );
        // Seats are clean between hands.
        if g.status == holdem::STATUS_LIVE {
            for seat in 0..2 {
                assert!(!env.hole(seat).dealt);
            }
        }
    }
    env.commit_standin();
    env.finalize().expect("settle");
    assert!(
        env.finalize_start().is_err(),
        "core refuses a second settlement"
    );
}

#[test]
fn nobody_contributing_to_hand_one_is_a_no_show_that_costs_each_side_the_platform_fee() {
    let mut env = live();
    env.past_deadline();
    env.claim_timeout().unwrap();
    let t = env.table();
    assert_eq!(
        (t.phase, t.game.status),
        (holdem::TABLE_OVER, holdem::STATUS_CANCELLED)
    );
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
fn a_player_who_never_contributes_to_hand_one_cancels_it_and_both_are_refunded() {
    let mut env = live();
    env.contribute(0, [1; 32]).unwrap();
    let d = env.table().game.deadline;
    env.set_time(d);
    assert_eq!(
        custom_code(&env.claim_timeout().unwrap_err()),
        dcode(holdem::HoldemError::NotTimedOut)
    );
    env.set_time(d + 1);
    env.claim_timeout().unwrap();
    assert_eq!(
        env.table().ring.find(&env.tmatch, 0).unwrap().1.outcome,
        table_kit::OUTCOME_DRAW
    );
    env.commit_standin();
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize().expect("refund");
    assert_eq!(
        (env.gemas(&env.alice), env.gemas(&env.bob)),
        (before.0 + 1_000, before.1 + 1_000)
    );
}

#[test]
fn a_player_who_skips_a_later_hands_secret_forfeits_it() {
    let (mut env, _, _) = dealt();
    let first = usize::from(env.table().game.to_act);
    env.act(first, Action::Fold).unwrap();
    // Hand two: only Bob contributes.
    let s = env.fresh_secret();
    env.contribute(1, s).unwrap();
    env.past_deadline();
    env.claim_timeout().unwrap();
    let g = env.table().game;
    assert_eq!((g.status, g.winner), (holdem::STATUS_OVER, 1));
    env.commit_standin();
    let before = env.gemas(&env.bob);
    env.finalize().expect("settle");
    assert_eq!(env.gemas(&env.bob), before + 1_900);
}

#[test]
fn an_oracle_that_never_answers_ends_the_hand_in_a_refund_and_never_re_rolls() {
    use holdem::HoldemError::*;
    let mut env = live();
    env.magic_shell_for_vrf();
    env.contribute(0, [1; 32]).unwrap();
    env.contribute(1, [2; 32]).unwrap();
    env.request_standin();
    for n in 0..holdem::VRF_MAX_EXTENSIONS {
        env.past_deadline();
        env.claim_timeout().unwrap();
        assert_eq!(
            env.table().game.status,
            holdem::STATUS_LIVE,
            "wait {n}: the oracle is slow, nobody forfeits"
        );
        // Asking again is refused: one request per hand.
        let ixn = env.request_ix(a(env.oracle.pubkey()));
        assert_eq!(
            custom_code(&env.rollup(ixn).unwrap_err()),
            dcode(AlreadyDealt)
        );
    }
    env.past_deadline();
    env.claim_timeout().unwrap();
    assert_eq!(env.table().game.status, holdem::STATUS_CANCELLED);
    assert_eq!(
        env.table().ring.find(&env.tmatch, 0).unwrap().1.outcome,
        table_kit::OUTCOME_DRAW
    );
    env.commit_standin();
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize().expect("refund");
    assert_eq!(
        (env.gemas(&env.alice), env.gemas(&env.bob)),
        (before.0 + 1_000, before.1 + 1_000)
    );
}

#[test]
fn an_idle_player_is_auto_checked_or_folded_then_forfeits_after_three_misses() {
    let (mut env, _, _) = dealt();
    let first = usize::from(env.table().game.to_act);
    // Facing the big blind, the idle small blind is folded.
    env.past_deadline();
    env.claim_timeout().unwrap();
    assert_eq!(env.table().game.missed[first], 1);
    assert_eq!(env.table().game.hand_no, 2);
    // Two more misses in a row forfeit the Match.
    let mut n = 1;
    while env.table().game.status == holdem::STATUS_LIVE {
        n += 1;
        assert!(n < 12);
        let other_secret = env.fresh_secret();
        let me = usize::from(env.table().game.dealer);
        let _ = me;
        env.contribute(0, other_secret).unwrap();
        let s1 = env.fresh_secret();
        env.contribute(1, s1).unwrap();
        env.request_standin();
        env.callback([n as u8; 32]).unwrap();
        env.deal().unwrap();
        env.past_deadline();
        env.claim_timeout().unwrap();
    }
    assert_eq!(env.table().game.status, holdem::STATUS_OVER);
}

#[test]
fn a_live_match_cannot_be_finalized() {
    use holdem::HoldemError::*;
    let mut env = live();
    env.commit_standin();
    let err = env.finalize_start().unwrap_err();
    assert_eq!(custom_code(&err), dcode(MatchNotOver));
}

#[test]
fn finalize_reads_only_the_committed_table_owned_by_the_delegation_program() {
    use holdem::HoldemError::*;
    let mut env = live();
    env.play_match_out();
    env.commit_standin();
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
    use holdem::HoldemError::*;
    let mut env = live();
    env.play_match_out();
    env.commit_standin();
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
    env.table = right;
    env.committed.insert(right, vec![7u8; 400]);
    let err = env.finalize_start().unwrap_err();
    assert_eq!(custom_code(&err), dcode(BadTable));
}

#[test]
fn a_settled_match_cannot_be_settled_again() {
    let mut env = live();
    env.play_match_out();
    env.commit_standin();
    env.finalize().expect("settle");
    assert!(
        env.finalize_start().is_err(),
        "core refuses a second settlement"
    );
}

#[test]
fn a_stale_commit_never_refunds_a_match_that_has_a_result() {
    use holdem::HoldemError::*;
    let mut env = live();
    env.play_match_out();
    // The result was never committed. Base's copy is the idle table from before the Match.
    env.set_time(env.now + 10 * 86_400 / 10);
    let err = env.finalize_start().unwrap_err();
    assert_eq!(custom_code(&err), dcode(NoResult));
    env.set_time(T0 + 2 * holdem::TABLE_WINDOW_SECS);
    let err = env.finalize_start().unwrap_err();
    assert_eq!(custom_code(&err), dcode(NoResult));
}

#[test]
fn a_match_that_never_began_is_refunded_only_once_the_table_has_moved_past_its_epoch() {
    use holdem::HoldemError::*;
    let mut env = Env::new();
    env.next_match_on(0);
    let never = (env.mref.unwrap(), env.table);
    env.next_match_on(0);
    env.play();
    env.wipe_standin();
    env.set_time(env.now + holdem::RESET_DELAY_SECS);
    env.reset().expect("reset");
    env.use_match(never.0, never.1);
    env.set_time(env.now + 1_000);
    assert_eq!(
        custom_code(&env.finalize_start().unwrap_err()),
        dcode(NoResult)
    );
    env.commit_standin();
    let committed = env.table_at_committed();
    assert_eq!(committed.epoch, 1);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize().expect("refund of a Match that never began");
    assert_eq!(
        (env.gemas(&env.alice), env.gemas(&env.bob)),
        (before.0 + 1_000, before.1 + 1_000)
    );
    let _ = NotTimedOut;
}

impl Env {
    fn table_at_committed(&self) -> Table {
        let bytes = self.committed.get(&self.table).expect("committed");
        Table::try_deserialize(&mut bytes.as_slice()).expect("decode")
    }

    /// The VRF program does not exist in LiteSVM. Any program loaded at its address lets the
    /// account checks pass; the CPI into it then fails (what the oracle does is devnet evidence).
    fn magic_shell_for_vrf(&mut self) {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/holdem.so");
        self.svm
            .add_program_from_file(
                s(APk::new_from_array(
                    ephemeral_rollups_sdk::vrf::consts::VRF_PROGRAM_ID.to_bytes(),
                )),
                path,
            )
            .expect("vrf shell");
    }

    /// Ends the Match by forfeit: the idle Player misses three turns in a row. Used where the
    /// test only needs a finished Match.
    fn finish_by_forfeit(&mut self) {
        for _ in 0..40 {
            if self.table().game.status != holdem::STATUS_LIVE {
                return;
            }
            let randomness = [0x77; 32];
            let phase = self.table().game.phase;
            if phase == SHUFFLE {
                self.deal_hand(randomness).expect("deal");
            }
            self.past_deadline();
            self.claim_timeout().expect("timeout");
        }
        panic!("the Match did not end");
    }
}

#[test]
fn a_table_is_reused_and_every_result_waits_in_the_ring_until_it_is_settled() {
    let mut env = Env::new();
    let mut played: Vec<(flow::MatchRef, APk, usize)> = vec![];
    for n in 0..3u64 {
        env.next_match_on(0);
        assert_eq!(env.table().epoch, n, "each Match runs in its own epoch");
        let winner = env.play();
        played.push((env.mref.unwrap(), env.table, winner));
        env.wipe_standin();
        env.set_time(env.now + holdem::RESET_DELAY_SECS);
        env.reset().expect("reset");
        assert_eq!(
            env.table().ring.used(),
            (n + 1) as usize,
            "results are kept across resets"
        );
        assert!(env.table().seats_created, "the seats outlive the Match");
        assert!(env.table().vrf_nonce > n, "request numbers never reset");
    }
    let committed = env.table_at_committed();
    assert_eq!(committed.ring.used(), 3);
    for (m, table, winner) in played {
        env.use_match(m, table);
        let before = env.gemas(env.winner_person(winner));
        env.finalize().expect("settle from the ring");
        assert_eq!(env.gemas(env.winner_person(winner)), before + 1_900);
    }
}

#[test]
fn a_match_assigned_to_a_past_epoch_never_begins_and_is_refunded_not_paid_from_another_result() {
    use holdem::HoldemError::*;
    let mut env = Env::new();
    env.next_match_on(0);
    env.play();
    env.wipe_standin();
    env.set_time(env.now + holdem::RESET_DELAY_SECS);
    env.reset().unwrap();
    env.open_and_join(1_000);
    env.assign(0, 0, 0).unwrap();
    assert_eq!(custom_code(&env.begin().unwrap_err()), dcode(NotAssigned));
    env.commit_standin();
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
    use holdem::HoldemError::*;
    let mut env = live();
    env.play_match_out();
    env.commit_standin();
    let m = env.tmatch;
    let slot = env.table().slot;
    assert_eq!(
        custom_code(&env.release(slot, m).unwrap_err()),
        dcode(NoReceipt)
    );
    env.finalize().expect("settle");
    assert_eq!(
        custom_code(&env.release(slot, m).unwrap_err()),
        dcode(NoReceipt)
    );
    assert_eq!(env.table().ring.used(), 1);
    env.set_time(env.now + holdem::RELEASE_DELAY_SECS);
    let ixn = ix(
        holdem::ID,
        holdem::accounts::Release {
            caller: a(env.oracle.pubkey()),
            table: env.table,
            receipt: env.alice.account,
            match_state: m,
        },
        holdem::instruction::ReleaseSlot { index: slot },
        vec![],
    );
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(NoReceipt));
    env.release(slot, m).expect("freed with the receipt");
    assert_eq!(env.table().ring.used(), 0);
    assert_eq!(
        custom_code(&env.release(slot, m).unwrap_err()),
        dcode(BadSlot)
    );
}

#[test]
fn a_reserved_or_unknown_slot_cannot_be_released() {
    use holdem::HoldemError::*;
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
    use holdem::HoldemError::*;
    let mut env = live();
    env.play_match_out();
    let slot = env.table().slot;
    let at = env.now;
    let ghost = APk::new_unique();
    env.patch_table(|t| t.ring.slots[slot as usize].match_key = ghost);
    let ixn = ix(
        holdem::ID,
        holdem::accounts::Release {
            caller: a(env.oracle.pubkey()),
            table: env.table,
            receipt: tpda(&[b"settled", ghost.as_ref()]),
            match_state: ghost,
        },
        holdem::instruction::ReleaseSlot { index: slot },
        vec![],
    );
    assert_eq!(
        custom_code(&env.rollup(ixn.clone()).unwrap_err()),
        dcode(NoReceipt)
    );
    env.set_time(at + holdem::STALE_SLOT_SECS);
    env.rollup(ixn).expect("freed after the long wait");
    assert_eq!(env.table().ring.used(), 0);
}

#[test]
fn a_table_is_reset_only_when_wiped_committed_and_a_moment_old_and_it_forgets_the_match() {
    use holdem::HoldemError::*;
    let mut env = live();
    env.play_match_out();
    let over = env.table().over_at;
    let first = env.table();
    env.set_time(over + holdem::RESET_DELAY_SECS);
    assert_eq!(custom_code(&env.reset().unwrap_err()), dcode(SeatsOpen));
    env.wipe_standin();
    assert_eq!(custom_code(&env.reset().unwrap_err()), dcode(NotCommitted));
    env.commit_standin();
    env.set_time(over + holdem::RESET_DELAY_SECS - 1);
    assert_eq!(custom_code(&env.reset().unwrap_err()), dcode(ResetTooEarly));
    env.set_time(over + holdem::RESET_DELAY_SECS);
    let commit_before = env.table().commit;
    env.reset().expect("reset");
    let mut expected = Table::new(first.bump, 0, 0);
    expected.epoch = 1;
    expected.ring = first.ring;
    expected.vrf_nonce = first.vrf_nonce;
    expected.seats_created = true;
    expected.commit = commit_before;
    assert_eq!(bytes_of(&env.table()), bytes_of(&expected));
    assert_eq!(env.table().ring.used(), 1);
    assert_eq!(custom_code(&env.reset().unwrap_err()), dcode(WrongPhase));
}

#[test]
fn a_live_match_cannot_be_reset_away() {
    use holdem::HoldemError::*;
    let mut env = live();
    env.set_time(env.now + 10_000);
    assert_eq!(custom_code(&env.reset().unwrap_err()), dcode(WrongPhase));
    env.begin().expect_err("and cannot be begun over");
    let _ = (NotCommitted, SeatsOpen);
}

#[test]
fn the_old_assignment_cannot_begin_again_after_its_epoch() {
    use holdem::HoldemError::*;
    let mut env = Env::new();
    env.next_match_on(0);
    env.play();
    env.wipe_standin();
    env.set_time(env.now + holdem::RESET_DELAY_SECS);
    env.reset().unwrap();
    assert_eq!(custom_code(&env.begin().unwrap_err()), dcode(NotAssigned));
}

#[test]
fn a_table_whose_match_core_already_refunded_is_voided_and_reset_without_a_result() {
    use holdem::HoldemError::*;
    let mut env = live();
    let m = env.tmatch;
    env.contribute(0, [1; 32]).unwrap();
    env.contribute(1, [2; 32]).unwrap();
    env.request_standin();
    assert_eq!(custom_code(&env.void(m).unwrap_err()), dcode(NoReceipt));
    env.set_time(T0 + holdem::TABLE_WINDOW_SECS + 1);
    core_refund(&mut env).expect("core refund");
    assert_eq!(custom_code(&env.void(m).unwrap_err()), dcode(NoReceipt));
    env.set_time(env.now + holdem::RELEASE_DELAY_SECS);
    env.void(m).expect("void");
    let t = env.table();
    assert_eq!((t.phase, t.dirty), (holdem::TABLE_OVER, false));
    assert!(!t.req_pending, "a late answer finds nothing waiting");
    assert_eq!(t.ring.used(), 0, "the reserved slot is freed");
    env.wipe_standin();
    env.set_time(env.now + holdem::RESET_DELAY_SECS);
    env.reset().expect("reset");
    assert_eq!(env.table().epoch, 1);
}

#[test]
fn a_receipt_of_another_match_cannot_void_the_table() {
    use holdem::HoldemError::*;
    let mut env = Env::new();
    env.next_match_on(0);
    let other = env.mref.unwrap();
    env.next_match_on(1);
    env.begin().expect("the second Match waits on table 1");
    let table_1 = env.table;
    env.set_time(T0 + holdem::TABLE_WINDOW_SECS + 1);
    env.use_match(other, table_addr(0, 0));
    core_refund(&mut env).unwrap();
    env.set_time(env.now + holdem::RELEASE_DELAY_SECS);
    let ixn = ix(
        holdem::ID,
        holdem::accounts::Release {
            caller: a(env.oracle.pubkey()),
            table: table_1,
            receipt: tpda(&[b"settled", other.key.as_ref()]),
            match_state: other.key,
        },
        holdem::instruction::VoidTable {},
        vec![],
    );
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(NoReceipt));
}

// --- Closing an Assignment, committing, sponsor ----------------------------------------------

#[test]
fn an_assignment_closes_only_after_the_core_receipt_and_returns_its_rent_to_the_payer() {
    use holdem::HoldemError::*;
    let mut env = live();
    env.play_match_out();
    env.commit_standin();
    let asg = assign_addr(env.tmatch);
    let close = |env: &Env| {
        ix(
            holdem::ID,
            holdem::accounts::CloseAssignment {
                caller: a(env.oracle.pubkey()),
                assignment: assign_addr(env.tmatch),
                payer: a(env.operator.pubkey()),
                receipt: tpda(&[b"settled", env.tmatch.as_ref()]),
                match_state: env.tmatch,
            },
            holdem::instruction::CloseAssignment {},
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
    use holdem::HoldemError::*;
    let mut env = live();
    env.magic_shell();
    let ixn = env.commit_ix();
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(NotDirty));
    env.play_match_out();
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
    env.patch_table(|t| t.dirty = true);
    let mut bad = env.commit_ix();
    let idx = bad
        .accounts
        .iter()
        .position(|m| m.pubkey == s(table_kit::fee_vault_address(&holdem::TEE_VALIDATOR)))
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
fn only_the_public_table_is_ever_in_a_commit() {
    // The commit instruction names the table and the Sponsor and nothing else the Match owns:
    // no Hole can reach the magic program through it.
    let env = live();
    let ixn = env.commit_ix();
    let mine: Vec<_> = ixn
        .accounts
        .iter()
        .map(|m| APk::new_from_array(m.pubkey.to_bytes()))
        .collect();
    for seat in 0..2u8 {
        assert!(!mine.contains(&hole_addr(env.table, seat)));
        assert!(!mine.contains(&perm_addr(hole_addr(env.table, seat))));
    }
    assert!(mine.contains(&env.table));
}

#[test]
fn the_sponsor_is_refilled_from_a_fuel_reserve_by_the_operator_only() {
    use holdem::HoldemError::*;
    let mut env = Env::new();
    let op = env.operator_kp();
    let fuel = dpda(&[holdem::FUEL_SEED, &[0]]);
    let create = ix(
        holdem::ID,
        holdem::accounts::CreateFuel {
            operator: a(op.pubkey()),
            config: config_addr(),
            fuel,
            system_program: anchor_lang::system_program::ID,
        },
        holdem::instruction::CreateFuel {
            n: 0,
            lamports: 5 * SOL,
        },
        vec![],
    );
    env.send(&[create], &op, &[]).expect("create fuel");
    let refill = |signer: APk, amount: u64| {
        ix(
            holdem::ID,
            holdem::accounts::RefillSponsor {
                operator: signer,
                config: config_addr(),
                fuel,
                sponsor: sponsor_addr(),
            },
            holdem::instruction::RefillSponsor { amount },
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
    let ixn = refill(a(op.pubkey()), 3 * SOL + 1);
    assert!(
        env.send(&[ixn], &op, &[]).is_err(),
        "would take the reserve below its rent"
    );
}

// --- Delegation ----------------------------------------------------------------------------

#[test]
fn delegation_is_pinned_to_the_tee_validator() {
    let mut env = Env::new();
    let dlpk = dlp();
    let derive = |seeds: &[&[u8]], program: &APk| APk::find_program_address(seeds, program).0;
    let buffer = |k: APk| derive(&[b"buffer", k.as_ref()], &holdem::ID);
    let record = |k: APk| derive(&[b"delegation", k.as_ref()], &dlpk);
    let meta = |k: APk| derive(&[b"delegation-metadata", k.as_ref()], &dlpk);
    let table = table_addr(0, 0);
    let op = env.operator_kp();
    for validator in [Some(a(env.admin.pubkey())), None] {
        let delegate = ix(
            holdem::ID,
            holdem::accounts::DelegateTable {
                operator: a(op.pubkey()),
                config: config_addr(),
                buffer_table: buffer(table),
                delegation_record_table: record(table),
                delegation_metadata_table: meta(table),
                table,
                validator,
                owner_program: holdem::ID,
                delegation_program: dlpk,
                system_program: anchor_lang::system_program::ID,
            },
            holdem::instruction::DelegateTable {
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
    let stranger = env.admin.insecure_clone();
    let delegate = ix(
        holdem::ID,
        holdem::accounts::DelegateTable {
            operator: a(stranger.pubkey()),
            config: config_addr(),
            buffer_table: buffer(table),
            delegation_record_table: record(table),
            delegation_metadata_table: meta(table),
            table,
            validator: Some(holdem::TEE_VALIDATOR),
            owner_program: holdem::ID,
            delegation_program: dlpk,
            system_program: anchor_lang::system_program::ID,
        },
        holdem::instruction::DelegateTable {
            generation: 0,
            index: 0,
        },
        vec![],
    );
    let err = env.send(&[delegate], &stranger, &[]).unwrap_err();
    assert_eq!(custom_code(&err), dcode(holdem::HoldemError::NotOperator));
}

// --- Seats and permissions ------------------------------------------------------------------

/// The accounts the three permission-changing instructions take.
fn seat_ix(env: &Env, which: &str, signer: APk) -> Instruction {
    let t = env.table;
    let (h0, h1) = (hole_addr(t, 0), hole_addr(t, 1));
    let (p0, p1) = (perm_addr(h0), perm_addr(h1));
    let permission_program = sdk_key(PERMISSION_PROGRAM_ID);
    let ephemeral_vault = sdk_key(ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID);
    let magic_program = sdk_key(MAGIC_PROGRAM_ID);
    match which {
        "init" => ix(
            holdem::ID,
            holdem::accounts::InitSeats {
                caller: signer,
                table: t,
                hole_0: h0,
                hole_1: h1,
                hole_0_permission: p0,
                hole_1_permission: p1,
                permission_program,
                ephemeral_vault,
                magic_program,
            },
            holdem::instruction::InitSeats {},
            vec![],
        ),
        "seat" => ix(
            holdem::ID,
            holdem::accounts::SeatPlayers {
                caller: signer,
                table: t,
                hole_0: h0,
                hole_1: h1,
                hole_0_permission: p0,
                hole_1_permission: p1,
                permission_program,
                ephemeral_vault,
                magic_program,
            },
            holdem::instruction::SeatPlayers {},
            vec![],
        ),
        "wipe" => ix(
            holdem::ID,
            holdem::accounts::WipeSeats {
                caller: signer,
                table: t,
                hole_0: h0,
                hole_1: h1,
                hole_0_permission: p0,
                hole_1_permission: p1,
                permission_program,
                ephemeral_vault,
                magic_program,
            },
            holdem::instruction::WipeSeats {},
            vec![],
        ),
        _ => ix(
            holdem::ID,
            holdem::accounts::RetireSeats {
                operator: signer,
                config: config_addr(),
                table: t,
                hole_0: h0,
                hole_1: h1,
                hole_0_permission: p0,
                hole_1_permission: p1,
                permission_program,
                ephemeral_vault,
                magic_program,
            },
            holdem::instruction::RetireSeats {},
            vec![],
        ),
    }
}

#[test]
fn no_instruction_a_player_calls_can_reach_the_permission_program() {
    // The IDL says which instructions take the permission program. Only the table's own state
    // machine steps do, and none of them is a Player's move.
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/idl/holdem.json");
    let idl: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("IDL: pnpm build:programs"))
            .expect("json");
    let mut reaching: Vec<String> = idl["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| {
            i["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|acc| acc["name"] == "permission_program")
        })
        .map(|i| i["name"].as_str().unwrap().to_string())
        .collect();
    reaching.sort();
    assert_eq!(
        reaching,
        ["init_seats", "retire_seats", "seat_players", "wipe_seats"]
    );
    // And no instruction a Player signs for takes it. (`contribute_entropy`, `act` and `check_in`
    // are the ones with a Player signer.)
    for name in ["contribute_entropy", "act", "check_in"] {
        assert!(!reaching.iter().any(|r| r == name));
    }
}

#[test]
fn seats_are_made_once_and_handed_on_only_between_matches() {
    use holdem::HoldemError::*;
    let mut env = live();
    let caller = env.oracle.insecure_clone();
    // Already made.
    let ixn = seat_ix(&env, "init", a(caller.pubkey()));
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(SeatsOpen));
    // A live Match's seats cannot be handed to anyone or wiped, by anyone.
    let ixn = seat_ix(&env, "seat", a(caller.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(WrongPhase)
    );
    let ixn = seat_ix(&env, "wipe", a(caller.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(WrongPhase)
    );
    // The Players cannot either.
    for seat in 0..2 {
        let (kp, key) = env.person_of(seat);
        for which in ["seat", "wipe", "retire"] {
            let ixn = seat_ix(&env, which, key);
            assert!(
                env.send(&[ixn], &kp, &[]).is_err(),
                "{which} as seat {seat}"
            );
        }
    }
    // Retiring needs the operator and an idle table.
    let op = env.operator_kp();
    let ixn = seat_ix(&env, "retire", a(op.pubkey()));
    assert_eq!(
        custom_code(&env.send(&[ixn], &op, &[]).unwrap_err()),
        dcode(WrongPhase)
    );
    let ixn = seat_ix(&env, "retire", a(caller.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(NotOperator)
    );
}

#[test]
fn seats_are_handed_over_only_when_blank_and_wiped_only_when_the_match_is_over() {
    use holdem::HoldemError::*;
    let mut env = ready();
    let caller = env.oracle.insecure_clone();
    // An idle table has no Match to seat.
    let ixn = seat_ix(&env, "seat", a(caller.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(WrongPhase)
    );
    env.begin().unwrap();
    // A seat that still holds data is not handed on.
    env.patch_hole(0, |h| h.last_secret_hash = [9; 32]);
    let ixn = seat_ix(&env, "seat", a(caller.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(SeatNotBlank)
    );
    env.patch_hole(0, |h| h.wipe());
    // Open seats are not handed again.
    env.seat_players_standin();
    let ixn = seat_ix(&env, "seat", a(caller.pubkey()));
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(SeatsOpen));
    // Waiting is not over.
    let ixn = seat_ix(&env, "wipe", a(caller.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(WrongPhase)
    );
}

#[test]
fn a_wiped_seat_is_blank_and_a_hand_clears_only_the_cards() {
    let (mut env, _, _) = dealt();
    let mut h = env.hole(0);
    assert!(!h.is_blank());
    h.clear_hand();
    assert_eq!((h.cards, h.shares, h.dealt), ([0; 2], [0; 5], false));
    assert!(!h.is_blank(), "the Player and the repeat guard stay");
    h.wipe();
    assert!(h.is_blank());
    assert_eq!(h.player, APk::default());
    let mut bytes = Vec::new();
    h.try_serialize(&mut bytes).unwrap();
    let blank = Hole::blank(h.bump, env.table, 0);
    let mut expected = Vec::new();
    blank.try_serialize(&mut expected).unwrap();
    assert_eq!(bytes, expected, "every byte but identity is zero");
    let _ = &mut env;
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
    use holdem::HoldemError::*;
    let mut env = live();
    env.magic_shell();
    let winner = env.play_match_out();
    let loser = 1 - winner;
    env.commit_lost_standin();
    // Base still has the table from before the Match: nothing to settle from.
    assert_eq!(
        custom_code(&env.finalize_start().unwrap_err()),
        dcode(NoResult)
    );
    // Too soon: refused, and the table is untouched.
    let before = bytes_of(&env.table());
    let ixn = env.commit_ix();
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(NotDirty));
    env.set_time(env.now + holdem::RESET_DELAY_SECS);
    let ixn = env.commit_ix();
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(NotDirty));
    assert_eq!(bytes_of(&env.table()), before);
    // After the wait the repeat passes its own checks and reaches the MagicBlock program, which
    // LiteSVM does not have (devnet evidence, ticket 24).
    env.set_time(env.now + table_kit::COMMIT_RETRY_SECS);
    let ixn = env.commit_ix();
    let err = env.rollup(ixn).unwrap_err();
    assert!(
        !err.meta.logs.iter().any(|l| l.contains("NotDirty")),
        "{:?}",
        err.meta.logs
    );
    // This time the commit lands.
    env.commit_standin();
    let before_gemas = (
        env.gemas(env.winner_person(winner)),
        env.gemas(env.winner_person(loser)),
    );
    env.finalize().expect("settle from the repeated commit");
    assert_eq!(env.gemas(env.winner_person(winner)), before_gemas.0 + 1_900);
    assert_eq!(env.gemas(env.winner_person(loser)), before_gemas.1);
}

#[test]
fn a_lost_commit_survives_the_reset_and_a_repeat_carries_the_whole_ring() {
    let mut env = Env::new();
    env.magic_shell();
    env.next_match_on(0);
    env.start();
    env.play_match_out();
    env.commit_lost_standin();
    env.wipe_standin();
    env.set_time(env.now + holdem::RESET_DELAY_SECS);
    env.reset().expect("a lost commit does not hold the reset");
    // The next epoch begins; the result is still in the ring and a repeat is still allowed.
    let t = env.table();
    assert_eq!(t.epoch, 1);
    assert_eq!(t.ring.used(), 1);
    assert_eq!(t.commit.tries, 1, "the guard survives the reset");
    env.set_time(env.now + table_kit::COMMIT_RETRY_SECS);
    let ixn = env.commit_ix();
    let err = env.rollup(ixn).unwrap_err();
    assert!(!err.meta.logs.iter().any(|l| l.contains("NotDirty")));
}

#[test]
fn repeated_commit_calls_cost_nothing_once_the_result_is_settled_and_freed() {
    use holdem::HoldemError::*;
    let mut env = live();
    env.magic_shell();
    env.play_match_out();
    env.commit_standin();
    let slot = env.table().slot;
    let m = env.tmatch;
    env.finalize().expect("settle");
    env.set_time(env.now + holdem::RELEASE_DELAY_SECS);
    env.release(slot, m).expect("freed");
    assert_eq!(env.table().ring.used(), 0);
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

#[test]
fn a_result_older_than_cores_refund_window_is_not_repeated() {
    use holdem::HoldemError::*;
    let mut env = live();
    env.magic_shell();
    env.play_match_out();
    env.commit_lost_standin();
    env.set_time(env.now + table_kit::COMMIT_WINDOW_SECS);
    let ixn = env.commit_ix();
    assert_eq!(custom_code(&env.rollup(ixn).unwrap_err()), dcode(NotDirty));
}

#[test]
fn nothing_in_the_program_can_undelegate_a_table_or_a_seat() {
    // No instruction builds an undelegation or a commit-and-undelegate, so no caller can trigger one.
    let source = include_str!("../src/lib.rs");
    for needle in [
        "commit_and_undelegate",
        "undelegate_",
        "CommitAndUndelegate",
        "request_undelegation",
    ] {
        assert!(!source.contains(needle), "{needle} appears in the program");
    }
}

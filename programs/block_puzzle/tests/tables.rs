//! LiteSVM tests: the real block_puzzle and tesoro_core programs (`pnpm build:programs` first).
//!
//! LiteSVM has no delegation, permission, ephemeral-account or VRF programs, so the steps that
//! need them are stood in for by writing the account state they would have produced: creating the
//! two Boards and the Vault, swapping their permission members, the VRF request. Everything else
//! runs as deployed: the oracle's callback (with the identity PDA signing), `start`, `begin`,
//! `play`, `play_hidden`, `close`, the table state machine and `finalize` against base's view of
//! the table.
#![allow(clippy::result_large_err)]
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, Space, ToAccountMetas};
use block_puzzle::engine;
use block_puzzle::{Assignment, Binding, Board, MoveArg, Table, Vault};
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
/// The rollup slot at `T0`.
const SLOT0: u64 = 5_000_000;
const SPS: u64 = block_puzzle::SLOTS_PER_SEC;

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
    APk::find_program_address(seeds, &block_puzzle::ID).0
}
fn account_pda(auth: APk) -> APk {
    tpda(&[ACCOUNT_SEED, auth.as_ref()])
}
fn authority_pda() -> APk {
    dpda(&[block_puzzle::AUTHORITY_SEED])
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

/// Anchor custom error code of a block_puzzle error.
fn dcode(e: block_puzzle::BlockPuzzleError) -> u32 {
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
    slot: u64,
    last_cu: u64,
    last_logs: Vec<String>,
}

/// Slot of `secs` seconds after `start_slot`, in slots.
fn after(start: u64, secs: u64) -> u64 {
    start + secs * SPS
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
                self.last_logs = meta.logs;
                Ok(())
            }
            Err(e) => {
                self.last_cu = e.meta.compute_units_consumed;
                self.last_logs = e.meta.logs.clone();
                Err(e)
            }
        }
    }

    /// Wall-clock time in seconds; the rollup slot follows at the healthy rate.
    fn set_time(&mut self, t: i64) {
        self.set_clock(SLOT0 + (t - T0).max(0) as u64 * SPS, t);
    }

    /// An exact rollup slot; the clock follows at the healthy rate.
    fn set_slot(&mut self, slot: u64) {
        self.set_clock(slot, T0 + ((slot - SLOT0) / SPS) as i64);
    }

    /// Slot and clock independently: a stalled rollup has fewer slots than seconds.
    fn set_clock(&mut self, slot: u64, ts: i64) {
        self.now = ts;
        self.slot = slot;
        self.svm.set_sysvar(&Clock {
            slot,
            unix_timestamp: ts,
            ..Clock::default()
        });
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

    fn set_config(
        &mut self,
        operator: APk,
        generation: u16,
        max_tables: u16,
    ) -> Result<(), Failed> {
        let ctl = self.ctl_kp();
        let ixn = ix(
            block_puzzle::ID,
            block_puzzle::accounts::SetConfig {
                authority: a(ctl.pubkey()),
                config: config_addr(),
                program: block_puzzle::ID,
                program_data: program_data_pda(),
                system_program: anchor_lang::system_program::ID,
            },
            block_puzzle::instruction::SetConfig {
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
            block_puzzle::ID,
            block_puzzle::accounts::CreateSponsor {
                operator: a(self.operator.pubkey()),
                config: config_addr(),
                sponsor: sponsor_addr(),
                system_program: anchor_lang::system_program::ID,
            },
            block_puzzle::instruction::CreateSponsor { lamports },
            vec![],
        )
    }

    fn create_table_ix(&self, signer: APk, generation: u16, index: u16) -> Instruction {
        ix(
            block_puzzle::ID,
            block_puzzle::accounts::CreateTable {
                operator: signer,
                config: config_addr(),
                table: table_addr(generation, index),
                system_program: anchor_lang::system_program::ID,
            },
            block_puzzle::instruction::CreateTable { generation, index },
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
            block_puzzle::ID,
            block_puzzle::accounts::AssignMatch {
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
            block_puzzle::instruction::AssignMatch {
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
            block_puzzle::ID,
            entry,
            n,
            false,
            0,
        )
        .expect("open match");
        flow::join_match(&mut self.svm, &bob.kp, &m, block_puzzle::ID, n + 1).expect("join match");
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
            block_puzzle::ID,
            block_puzzle::accounts::Finalize {
                caller,
                assignment: assign_addr(self.tmatch),
                table: self.table,
                tesoro_match: self.tmatch,
                config: tpda(&[CONFIG_SEED]),
                game_record: game_record_pda(),
                authority: authority_pda(),
                game_program: block_puzzle::ID,
                program_data: program_data_pda(),
                receipt: tpda(&[b"settled", self.tmatch.as_ref()]),
                system_program: anchor_lang::system_program::ID,
                core_event_authority: tpda(&[b"__event_authority"]),
                tesoro_program: tesoro_core::ID,
                event_authority: dpda(&[b"__event_authority"]),
                program: block_puzzle::ID,
            },
            block_puzzle::instruction::Finalize {},
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

    fn rollup(&mut self, ixn: Instruction) -> Result<(), Failed> {
        let caller = self.oracle.insecure_clone();
        self.send(&[ixn], &caller, &[])
    }

    fn begin_ix(&self) -> Instruction {
        ix(
            block_puzzle::ID,
            block_puzzle::accounts::BeginMatch {
                caller: a(self.oracle.pubkey()),
                assignment: assign_addr(self.tmatch),
                table: self.table,
                tesoro_match: self.tmatch,
            },
            block_puzzle::instruction::BeginMatch {},
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
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../target/deploy/block_puzzle.so"
        );
        self.svm
            .add_program_from_file(s(sdk_key(MAGIC_PROGRAM_ID)), path)
            .expect("magic shell");
    }

    fn commit_ix(&self) -> Instruction {
        ix(
            block_puzzle::ID,
            block_puzzle::accounts::CommitTable {
                caller: a(self.oracle.pubkey()),
                table: self.table,
                sponsor: sponsor_addr(),
                magic_fee_vault: table_kit::fee_vault_address(&block_puzzle::TEE_VALIDATOR),
                magic_context: sdk_key(ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID),
                magic_program: sdk_key(MAGIC_PROGRAM_ID),
            },
            block_puzzle::instruction::CommitTable {},
            vec![],
        )
    }

    fn reset_ix(&self) -> Instruction {
        ix(
            block_puzzle::ID,
            block_puzzle::accounts::TableOnly {
                caller: a(self.oracle.pubkey()),
                table: self.table,
            },
            block_puzzle::instruction::ResetTable {},
            vec![],
        )
    }

    fn reset(&mut self) -> Result<(), Failed> {
        let ixn = self.reset_ix();
        self.rollup(ixn)
    }

    fn release_accounts(&self, m: APk) -> block_puzzle::accounts::Release {
        block_puzzle::accounts::Release {
            caller: a(self.oracle.pubkey()),
            table: self.table,
            receipt: tpda(&[b"settled", m.as_ref()]),
            match_state: m,
        }
    }

    fn release(&mut self, index: u8, m: APk) -> Result<(), Failed> {
        let ixn = ix(
            block_puzzle::ID,
            self.release_accounts(m),
            block_puzzle::instruction::ReleaseSlot { index },
            vec![],
        );
        self.rollup(ixn)
    }

    fn void(&mut self, m: APk) -> Result<(), Failed> {
        let ixn = ix(
            block_puzzle::ID,
            self.release_accounts(m),
            block_puzzle::instruction::VoidTable {},
            vec![],
        );
        self.rollup(ixn)
    }

    fn person_of(&self, seat: usize) -> (Keypair, APk) {
        let p = if seat == 0 { &self.alice } else { &self.bob };
        (p.kp.insecure_clone(), p.key)
    }

    fn winner_person(&self, seat: usize) -> &Person {
        if seat == 0 {
            &self.alice
        } else {
            &self.bob
        }
    }

    fn table(&self) -> Table {
        self.load(self.table)
    }

    fn table_at(&self, k: APk) -> Table {
        self.load(k)
    }

    fn board(&self, seat: usize) -> Board {
        self.load(board_addr(self.table, seat as u8))
    }

    fn vault(&self) -> Vault {
        self.load(vault_addr(self.table))
    }

    fn patch_board(&mut self, seat: usize, f: impl FnOnce(&mut Board)) {
        let mut b = self.board(seat);
        f(&mut b);
        self.store(board_addr(self.table, seat as u8), &b, block_puzzle::ID);
    }

    fn patch_vault(&mut self, f: impl FnOnce(&mut Vault)) {
        let mut v = self.vault();
        f(&mut v);
        self.store(vault_addr(self.table), &v, block_puzzle::ID);
    }

    fn patch_table(&mut self, f: impl FnOnce(&mut Table)) {
        let mut t = self.table();
        f(&mut t);
        self.store(self.table, &t, block_puzzle::ID);
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
            (block_puzzle::ID, "block_puzzle.so"),
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
            tmatch: APk::default(),
            mref: None,
            table: table_addr(0, 0),
            committed: HashMap::new(),
            nonce: 10,
            now: T0,
            slot: SLOT0,
            last_cu: 0,
            last_logs: vec![],
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
        // The Game authority is the block_puzzle PDA, not a keypair.
        let ctl = env.ctl_kp();
        let hash = control_program(&mut env.svm, block_puzzle::ID, a(ctl.pubkey()));
        let register = ix(
            tesoro_core::ID,
            tesoro_core::accounts::RegisterGame {
                payer: a(admin.pubkey()),
                control: a(ctl.pubkey()),
                config: tpda(&[CONFIG_SEED]),
                game_program: block_puzzle::ID,
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
                game_program: block_puzzle::ID,
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

    // --- seats (stand-ins for the permission program) --------------------------------------

    /// Stands in for `init_seats`, whose ephemeral-account and permission CPIs need MagicBlock:
    /// both Boards and the Vault exist, blank and with no member, and the table says so.
    fn init_seats_standin(&mut self, table: APk) {
        for seat in 0..2u8 {
            let (key, bump) = board_addr_bump(table, seat);
            self.store(key, &Board::blank(bump, table, seat), block_puzzle::ID);
        }
        let (vault, bump) = block_puzzle::vault_address(&table);
        self.store(vault, &Vault::blank(bump, table), block_puzzle::ID);
        let mut t: Table = self.load(table);
        t.seats_created = true;
        self.store(table, &t, block_puzzle::ID);
    }

    /// Stands in for the permission half of `seat_players`: each blank Board is stamped with its
    /// Player, the Match and the epoch, and the table says the seats are theirs.
    fn seat_players_standin(&mut self) {
        let t = self.table();
        for (seat, player) in t.players.into_iter().enumerate() {
            self.patch_board(seat, |b| {
                b.player = player;
                b.tesoro_match = t.tesoro_match;
                b.epoch = t.epoch;
            });
        }
        self.patch_table(|t| t.seats_open = true);
    }

    /// Stands in for the permission half of `wipe_seats`: both Boards and the Vault are blank.
    fn wipe_standin(&mut self) {
        for seat in 0..2 {
            self.patch_board(seat, |b| b.wipe());
        }
        self.patch_vault(|v| v.wipe());
        self.patch_table(|t| t.seats_open = false);
    }

    // --- the Match ---------------------------------------------------------------------------

    fn binding(&self) -> Binding {
        self.table().binding()
    }

    fn check_in_ix(&self, player: APk, binding: Binding) -> Instruction {
        ix(
            block_puzzle::ID,
            block_puzzle::accounts::CheckIn {
                player,
                table: self.table,
            },
            block_puzzle::instruction::CheckIn { binding },
            vec![],
        )
    }

    fn check_in_with(&mut self, seat: usize, binding: Binding) -> Result<(), Failed> {
        let (kp, key) = self.person_of(seat);
        let ixn = self.check_in_ix(key, binding);
        self.send(&[ixn], &kp, &[])
    }

    fn check_in(&mut self, seat: usize) -> Result<(), Failed> {
        let binding = self.binding();
        self.check_in_with(seat, binding)
    }

    fn request_ix(&self, payer: APk) -> Instruction {
        let vrf_program =
            APk::new_from_array(ephemeral_rollups_sdk::vrf::consts::VRF_PROGRAM_ID.to_bytes());
        ix(
            block_puzzle::ID,
            block_puzzle::accounts::RequestSeed {
                payer,
                table: self.table,
                seed_vault: vault_addr(self.table),
                oracle_queue: APk::new_from_array(
                    ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE.to_bytes(),
                ),
                program_identity: dpda(&[ephemeral_rollups_sdk::vrf::consts::IDENTITY]),
                vrf_program,
                slot_hashes: APk::new_from_array(solana_sdk::sysvar::slot_hashes::ID.to_bytes()),
                system_program: anchor_lang::system_program::ID,
            },
            block_puzzle::instruction::RequestSeed {},
            vec![],
        )
    }

    /// Stands in for the part of `request_seed` that needs the VRF program: the table records the
    /// outstanding request exactly as the instruction does before it calls the oracle.
    fn request_standin(&mut self) {
        let slot = self.slot;
        self.patch_table(|t| {
            t.req_nonce = t.vrf_nonce;
            t.vrf_nonce += 1;
            t.req_pending = true;
            t.req_epoch = t.epoch;
            t.req_slot = slot;
            t.req_count += 1;
        });
    }

    /// The VRF program's callback: the scoped identity PDA signs, as the oracle's CPI makes it.
    fn callback_with(&mut self, randomness: [u8; 32], request: APk) -> Result<(), Failed> {
        let identity = APk::new_from_array(
            ephemeral_rollups_sdk::vrf::consts::scoped_vrf_identity(&block_puzzle::ID).to_bytes(),
        );
        let ixn = ix(
            block_puzzle::ID,
            block_puzzle::accounts::SeedCallback {
                vrf_program_identity: identity,
                table: self.table,
                seed_vault: vault_addr(self.table),
                request,
            },
            block_puzzle::instruction::SeedCallback { randomness },
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
                self.last_logs = meta.logs;
                Ok(())
            }
            Err(e) => {
                self.last_cu = e.meta.compute_units_consumed;
                self.last_logs = e.meta.logs.clone();
                Err(e)
            }
        }
    }

    /// The marker the outstanding request names.
    fn marker(&self) -> APk {
        let t = self.table();
        Table::request_marker(&self.table, t.req_nonce)
    }

    fn callback(&mut self, randomness: [u8; 32]) -> Result<(), Failed> {
        let request = self.marker();
        self.callback_with(randomness, request)
    }

    fn start_ix(&self) -> Instruction {
        ix(
            block_puzzle::ID,
            block_puzzle::accounts::TableOnly {
                caller: a(self.oracle.pubkey()),
                table: self.table,
            },
            block_puzzle::instruction::Start {},
            vec![],
        )
    }

    fn start(&mut self) -> Result<(), Failed> {
        let ixn = self.start_ix();
        self.rollup(ixn)
    }

    fn begin_run_ix(&self, seat: usize, binding: Binding) -> Instruction {
        let (_, key) = self.person_of(seat);
        ix(
            block_puzzle::ID,
            block_puzzle::accounts::Begin {
                player: key,
                table: self.table,
                seed_vault: vault_addr(self.table),
                board: board_addr(self.table, seat as u8),
            },
            block_puzzle::instruction::Begin { binding },
            vec![],
        )
    }

    fn begin_run_with(&mut self, seat: usize, binding: Binding) -> Result<(), Failed> {
        let (kp, _) = self.person_of(seat);
        let ixn = self.begin_run_ix(seat, binding);
        self.send(&[ixn], &kp, &[])
    }

    fn begin_run(&mut self, seat: usize) -> Result<(), Failed> {
        let binding = self.binding();
        self.begin_run_with(seat, binding)
    }

    fn play_ix(
        &self,
        seat: usize,
        binding: Binding,
        expected: u16,
        moves: Vec<MoveArg>,
        hidden: bool,
    ) -> Instruction {
        let (_, key) = self.person_of(seat);
        if hidden {
            ix(
                block_puzzle::ID,
                block_puzzle::accounts::PlayHidden {
                    player: key,
                    table: self.table,
                    board: board_addr(self.table, seat as u8),
                },
                hidden_args(binding, expected, 0, &moves),
                vec![],
            )
        } else {
            ix(
                block_puzzle::ID,
                block_puzzle::accounts::Play {
                    player: key,
                    table: self.table,
                    board: board_addr(self.table, seat as u8),
                },
                block_puzzle::instruction::Play {
                    binding,
                    expected_count: expected,
                    moves,
                },
                vec![],
            )
        }
    }

    fn play_with(
        &mut self,
        seat: usize,
        binding: Binding,
        expected: u16,
        moves: Vec<MoveArg>,
        hidden: bool,
    ) -> Result<(), Failed> {
        let (kp, _) = self.person_of(seat);
        let ixn = self.play_ix(seat, binding, expected, moves, hidden);
        self.send(&[ixn], &kp, &[])
    }

    /// `n` legal moves from the Player's current board.
    fn moves(&self, seat: usize, n: usize) -> Vec<MoveArg> {
        legal_moves(&self.board(seat).engine_state(), n)
    }

    /// The Player plays `n` legal moves (stops early when the game ends), public play.
    fn play(&mut self, seat: usize, n: usize) -> Result<(), Failed> {
        let (binding, expected) = (self.binding(), self.board(seat).moves);
        let moves = self.moves(seat, n);
        self.play_with(seat, binding, expected, moves, false)
    }

    /// Public play before the freeze, hidden play from it: what a client does.
    fn play_any(&mut self, seat: usize, n: usize) -> Result<(), Failed> {
        if self.slot < self.table().freeze_slot().unwrap() {
            self.play(seat, n)
        } else {
            self.play_hidden(seat, n)
        }
    }

    fn play_hidden(&mut self, seat: usize, n: usize) -> Result<(), Failed> {
        let (binding, expected) = (self.binding(), self.board(seat).moves);
        let moves = self.moves(seat, n);
        self.play_with(seat, binding, expected, moves, true)
    }

    fn close_ix(&self) -> Instruction {
        ix(
            block_puzzle::ID,
            block_puzzle::accounts::CloseMatch {
                caller: a(self.oracle.pubkey()),
                table: self.table,
                board_0: board_addr(self.table, 0),
                board_1: board_addr(self.table, 1),
            },
            block_puzzle::instruction::Close {},
            vec![],
        )
    }

    fn close(&mut self) -> Result<(), Failed> {
        let ixn = self.close_ix();
        self.rollup(ixn)
    }

    /// Begin on the table, hand the seats over, both Players check in: the Seed window is open.
    fn check_in_both(&mut self) {
        self.begin().expect("begin_match");
        self.seat_players_standin();
        self.check_in(0).expect("check in 0");
        self.check_in(1).expect("check in 1");
    }

    /// Both checked in, the Seed requested and answered, `start` sent: the get-ready countdown
    /// runs.
    fn seeded(&mut self, randomness: [u8; 32]) {
        self.check_in_both();
        self.request_standin();
        self.callback(randomness).expect("callback");
        self.start().expect("start");
    }

    /// `seeded`, then the clock reaches `start_slot`.
    fn running(&mut self, randomness: [u8; 32]) {
        self.seeded(randomness);
        let start = self.table().start_slot;
        self.set_slot(start);
    }

    /// `running`, then both Players have begun.
    fn begun(&mut self) {
        self.running([0x5a; 32]);
        self.begin_run(0).expect("begin 0");
        self.begin_run(1).expect("begin 1");
    }

    /// Plays one whole Match on the table under test to a committed result: both Players play
    /// `n0` and `n1` moves, time runs out, `close`.
    fn play_out(&mut self, n0: usize, n1: usize) {
        self.begun();
        let start = self.table().start_slot;
        let mut at = start;
        for (seat, n) in [(0, n0), (1, n1)] {
            let mut left = n;
            while left > 0 {
                let batch = left.min(block_puzzle::MAX_PLAY_BATCH);
                at += SPS;
                self.set_slot(at);
                // keep inside the pace; stay clear of the freeze
                if at < self.table().freeze_slot().unwrap() {
                    self.play(seat, batch).expect("play");
                } else {
                    self.play_hidden(seat, batch).expect("play hidden");
                }
                left -= batch;
            }
        }
        let end = self.table().play_end().unwrap();
        self.set_slot(end + 1);
        self.close().expect("close");
    }

    fn table_at_committed(&self) -> Table {
        let bytes = self.committed.get(&self.table).expect("committed");
        Table::try_deserialize(&mut bytes.as_slice()).expect("decode")
    }

    /// The VRF program does not exist in LiteSVM. Any program loaded at its address lets the
    /// account checks pass; the CPI into it then fails (what the oracle does is devnet evidence).
    fn magic_shell_for_vrf(&mut self) {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../target/deploy/block_puzzle.so"
        );
        self.svm
            .add_program_from_file(
                s(APk::new_from_array(
                    ephemeral_rollups_sdk::vrf::consts::VRF_PROGRAM_ID.to_bytes(),
                )),
                path,
            )
            .expect("vrf shell");
    }
}

/// `n` legal moves for the engine state, found greedily (the first anchor that fits, trying the
/// unused pieces of the hand in order). Stops early when the game is over.
/// First-fit play on this Seed fills the board after 23 moves.
const SHORT_RUN_SEED: u64 = 48;

fn legal_moves(state: &engine::State, n: usize) -> Vec<MoveArg> {
    let mut st = *state;
    let mut out = vec![];
    while out.len() < n && !st.over {
        let base = st.hand_base();
        let mut found = None;
        'pieces: for slot in 0..engine::HAND {
            if st.used >> slot & 1 == 1 {
                continue;
            }
            for y in 0..engine::SIZE {
                for x in 0..engine::SIZE {
                    let mv = engine::Move {
                        piece: (base + slot) as u16,
                        x,
                        y,
                    };
                    let mut t = st;
                    if t.apply(mv).is_ok() {
                        found = Some((mv, t));
                        break 'pieces;
                    }
                }
            }
        }
        let Some((mv, next)) = found else { break };
        out.push(MoveArg {
            piece: mv.piece,
            x: mv.x,
            y: mv.y,
        });
        st = next;
    }
    out
}

fn board_addr_bump(table: APk, seat: u8) -> (APk, u8) {
    block_puzzle::board_address(&table, seat)
}
fn board_addr(table: APk, seat: u8) -> APk {
    board_addr_bump(table, seat).0
}
fn vault_addr(table: APk) -> APk {
    block_puzzle::vault_address(&table).0
}

fn dlp() -> APk {
    sdk_key(ephemeral_rollups_sdk::id())
}

fn table_addr(generation: u16, index: u16) -> APk {
    block_puzzle::table_address(generation, index)
}

fn config_addr() -> APk {
    dpda(&[block_puzzle::CONFIG_SEED])
}

fn sponsor_addr() -> APk {
    dpda(&[block_puzzle::SPONSOR_SEED])
}

fn assign_addr(m: APk) -> APk {
    dpda(&[block_puzzle::ASSIGN_SEED, m.as_ref()])
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

fn sdk_key(p: ephemeral_rollups_sdk::compat::Pubkey) -> APk {
    APk::new_from_array(p.to_bytes())
}

fn bytes_of(t: &Table) -> Vec<u8> {
    let mut v = Vec::new();
    t.try_serialize(&mut v).expect("serialize");
    v
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    needle.len() <= haystack.len() && haystack.windows(needle.len()).any(|w| w == needle)
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

/// tesoro_core's refund by anyone once the Match's deadline passed.
fn core_refund(env: &mut Env) -> Result<(), Failed> {
    let caller = env.oracle.insecure_clone();
    let ixn = ix(
        tesoro_core::ID,
        tesoro_core::accounts::RefundMatch {
            caller: a(caller.pubkey()),
            payer: a(caller.pubkey()),
            game_record: game_record_pda(),
            game_program: block_puzzle::ID,
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

use ephemeral_rollups_sdk::consts::{MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

/// The first table, assigned to a Match that is open and joined.
fn ready() -> Env {
    let mut env = Env::new();
    env.next_match_on(0);
    env.table = table_addr(0, 0);
    env
}

/// Checked in, seeded and started; the get-ready countdown runs.
fn seeded() -> Env {
    let mut env = ready();
    env.seeded([0x5a; 32]);
    env
}

/// The run has started (nobody has begun).
fn running() -> Env {
    let mut env = ready();
    env.running([0x5a; 32]);
    env
}

/// Both Players have begun their runs.
fn begun() -> Env {
    let mut env = ready();
    env.begun();
    env
}

/// The code of an error from this program, if it is one.
fn ours(err: &Failed) -> Option<u32> {
    use solana_sdk::instruction::InstructionError;
    use solana_sdk::transaction::TransactionError;
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
        _ => None,
    }
}

/// The hand-in-hand reset a table goes through between Matches (the permission half is stood in).
fn next_epoch(env: &mut Env) {
    env.wipe_standin();
    env.set_time(env.now + block_puzzle::RESET_DELAY_SECS);
    env.reset().expect("reset");
}

fn outcome_of(env: &Env) -> (u8, u8) {
    let t = env.table();
    (t.outcome, t.reason)
}

use block_puzzle::BlockPuzzleError as E;
use table_kit::{OUTCOME_DRAW, OUTCOME_NO_SHOW, OUTCOME_WIN0, OUTCOME_WIN1};

// =========================================================================================
// Tests
// =========================================================================================

// --- Config, tables, assignment --------------------------------------------------------------

#[test]
fn only_the_upgrade_authority_sets_the_config_and_the_generation_only_rises() {
    let mut env = Env::new();
    let stranger = env.admin.insecure_clone();
    let ixn = ix(
        block_puzzle::ID,
        block_puzzle::accounts::SetConfig {
            authority: a(stranger.pubkey()),
            config: config_addr(),
            program: block_puzzle::ID,
            program_data: program_data_pda(),
            system_program: anchor_lang::system_program::ID,
        },
        block_puzzle::instruction::SetConfig {
            operator: a(stranger.pubkey()),
            generation: 0,
            max_tables: 4,
        },
        vec![],
    );
    let err = env.send(&[ixn], &stranger, &[]).unwrap_err();
    assert_eq!(custom_code(&err), dcode(E::NotUpgradeAuthority));
    env.set_config(a(env.operator.pubkey()), 1, 8)
        .expect("raise");
    let err = env.set_config(a(env.operator.pubkey()), 0, 8).unwrap_err();
    assert_eq!(custom_code(&err), dcode(E::BadConfig));
    for (op, max) in [
        (APk::default(), 4u16),
        (a(env.operator.pubkey()), 0),
        (a(env.operator.pubkey()), 257),
    ] {
        let err = env.set_config(op, 1, max).unwrap_err();
        assert_eq!(custom_code(&err), dcode(E::BadConfig));
    }
}

#[test]
fn only_the_operator_creates_tables_inside_the_cap_and_the_current_generation() {
    let mut env = Env::new();
    let stranger = env.admin.insecure_clone();
    let ixn = env.create_table_ix(a(stranger.pubkey()), 0, 2);
    let err = env.send(&[ixn], &stranger, &[]).unwrap_err();
    assert_eq!(custom_code(&err), dcode(E::NotOperator));
    env.create_table(0, 2).expect("operator");
    env.create_table(0, 3)
        .expect("last table under the cap of 4");
    assert_eq!(
        custom_code(&env.create_table(0, 4).unwrap_err()),
        dcode(E::BadTableSlot)
    );
    assert_eq!(
        custom_code(&env.create_table(1, 0).unwrap_err()),
        dcode(E::BadTableSlot)
    );
    assert!(env.create_table(0, 2).is_err(), "a table is created once");
    let t = env.table_at(table_addr(0, 2));
    assert_eq!(
        (t.generation, t.index, t.epoch, t.phase),
        (0, 2, 0, block_puzzle::TABLE_IDLE)
    );
    assert!(!t.seats_created, "the seats are made in the rollup");
    assert!(t.ring.slots.iter().all(|s| s.state == table_kit::SLOT_FREE));
    assert_eq!(
        t.logs.len(),
        table_kit::RING_LEN,
        "a log for every ring slot"
    );
}

#[test]
fn a_table_account_fits_the_ten_kilobyte_creation_limit_with_room_to_spare() {
    // An account created by CPI is at most 10,240 bytes. The ring's run logs make this the
    // biggest account the Game creates.
    let size = 8 + Table::INIT_SPACE;
    println!("table account: {size} bytes");
    assert!(size < 10_240, "table is {size} bytes");
    let mut env = Env::new();
    let acct = env.svm.get_account(&s(table_addr(0, 0))).unwrap();
    assert_eq!(acct.data.len(), size);
    let _ = &mut env;
}

#[test]
fn assignment_copies_the_players_and_holds_the_refund_timer() {
    let env = ready();
    let asg: Assignment = env.load(assign_addr(env.tmatch));
    assert_eq!(
        asg.players,
        [env.alice.key, env.bob.key],
        "seat order is the Match's"
    );
    assert_eq!((asg.generation, asg.index, asg.epoch), (0, 0, 0));
    assert_eq!(asg.start_deadline, T0 + block_puzzle::START_WINDOW_SECS);
    assert_eq!(asg.payer, a(env.operator.pubkey()));
    let m = env.load::<MatchState>(env.tmatch).inner;
    assert_eq!(m.deadline, T0 + block_puzzle::TABLE_WINDOW_SECS);
}

#[test]
fn a_match_the_core_deadline_cannot_see_through_is_not_assigned() {
    // The budget: the start window, every phase and the close margin must fit before core's
    // absolute deadline, or the Match would be refundable (and fought over) mid-run.
    let need = block_puzzle::START_WINDOW_SECS + block_puzzle::ASSIGN_BUDGET_SECS;
    for (room, ok) in [(need - 1, false), (need, true)] {
        let mut env = Env::new();
        env.open_and_join(1_000);
        let mut m = env.load::<MatchState>(env.tmatch);
        m.inner.deadline_abs = T0 + room;
        m.inner.deadline = T0 + room;
        let key = env.tmatch;
        env.store(key, &m, tesoro_core::ID);
        let r = env.assign(0, 0, 0);
        if ok {
            r.expect("exactly enough room");
        } else {
            assert_eq!(custom_code(&r.unwrap_err()), dcode(E::BudgetTooShort));
        }
    }
    // An already expired deadline too.
    let mut env = Env::new();
    env.open_and_join(1_000);
    env.set_time(T0 + 10 * 86_400);
    assert!(env.assign(0, 0, 0).is_err());
}

#[test]
fn only_the_operator_assigns_once_and_only_to_a_real_table_slot() {
    let mut env = Env::new();
    env.open_and_join(1_000);
    let stranger = env.alice.kp.insecure_clone();
    let ixn = env.assign_ix(env.tmatch, 0, 0, 0, env.alice.key);
    let err = env.send(&[ixn], &stranger, &[]).unwrap_err();
    assert_eq!(custom_code(&err), dcode(E::NotOperator));
    assert_eq!(
        custom_code(&env.assign(0, 4, 0).unwrap_err()),
        dcode(E::BadTableSlot)
    );
    assert_eq!(
        custom_code(&env.assign(1, 0, 0).unwrap_err()),
        dcode(E::BadTableSlot)
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
        block_puzzle::ID,
        1_000,
        5,
        false,
        0,
    )
    .expect("open");
    env.tmatch = m.key;
    let err = env.assign(0, 0, 0).unwrap_err();
    assert_eq!(custom_code(&err), dcode(E::BadTesoroMatch));
}

// --- begin, seats, check-in -----------------------------------------------------------------

#[test]
fn begin_reserves_a_ring_slot_and_copies_the_match_from_the_assignment() {
    let mut env = ready();
    env.set_time(T0 + 7);
    env.begin().expect("begin");
    let t = env.table();
    assert_eq!(t.phase, block_puzzle::TABLE_ASSIGNED);
    assert_eq!(t.tesoro_match, env.tmatch);
    assert_eq!(t.players, [env.alice.key, env.bob.key]);
    assert_eq!(t.checked_in, [false; 2]);
    assert_eq!((t.assigned_slot, t.assigned_ts), (env.slot, env.now));
    assert_eq!(t.start_deadline, T0 + block_puzzle::START_WINDOW_SECS);
    let (i, slot) = t.ring.find(&env.tmatch, 0).expect("slot");
    assert_eq!((i, slot.state), (t.slot, table_kit::SLOT_RESERVED));
    assert_eq!(custom_code(&env.begin().unwrap_err()), dcode(E::WrongPhase));
}

#[test]
fn begin_refuses_a_wrong_table_epoch_or_late_start_a_frozen_match_and_a_table_without_seats() {
    // another table
    let mut env = ready();
    env.table = table_addr(0, 1);
    assert_eq!(
        custom_code(&env.begin().unwrap_err()),
        dcode(E::NotAssigned)
    );
    // a future epoch
    let mut env = Env::new();
    env.open_and_join(1_000);
    env.assign(0, 0, 5).expect("assign epoch 5");
    assert_eq!(
        custom_code(&env.begin().unwrap_err()),
        dcode(E::NotAssigned)
    );
    // after the start deadline
    let mut env = ready();
    env.set_time(T0 + block_puzzle::START_WINDOW_SECS + 1);
    assert_eq!(
        custom_code(&env.begin().unwrap_err()),
        dcode(E::StartWindowPassed)
    );
    // a Match tesoro_core already froze
    let mut env = ready();
    env.set_time(T0 + block_puzzle::TABLE_WINDOW_SECS + 1);
    core_refund(&mut env).expect("anyone refunds past the deadline");
    assert_eq!(
        custom_code(&env.begin().unwrap_err()),
        dcode(E::BadTesoroMatch)
    );
    // a table whose seats were never made
    let mut env = ready();
    env.patch_table(|t| t.seats_created = false);
    assert_eq!(
        custom_code(&env.begin().unwrap_err()),
        dcode(E::SeatsMissing)
    );
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
    assert_eq!(custom_code(&err), dcode(E::RingFull));
}

#[test]
fn both_players_check_in_and_the_second_one_opens_the_seed_window() {
    let mut env = ready();
    env.begin().unwrap();
    assert_eq!(
        custom_code(&env.check_in(0).unwrap_err()),
        dcode(E::SeatsNotOpen)
    );
    env.seat_players_standin();
    // a stranger cannot check in
    let stranger = env.admin.insecure_clone();
    let ixn = env.check_in_ix(a(stranger.pubkey()), env.binding());
    assert_eq!(
        custom_code(&env.send(&[ixn], &stranger, &[]).unwrap_err()),
        dcode(E::NotAPlayer)
    );
    env.check_in(0).unwrap();
    let t = env.table();
    assert_eq!(
        (t.phase, t.checked_in),
        (block_puzzle::TABLE_ASSIGNED, [true, false])
    );
    assert_eq!(
        custom_code(&env.check_in(0).unwrap_err()),
        dcode(E::AlreadyCheckedIn)
    );
    // Check-in is attendance only: one account, no CPI, no VRF.
    assert!(!env.last_logs.iter().any(|l| l.contains("invoke [2]")));
    env.set_slot(env.slot + 123);
    env.check_in(1).unwrap();
    let t = env.table();
    assert_eq!(t.phase, block_puzzle::TABLE_SEEDING);
    assert_eq!(t.seeding_slot, env.slot);
    assert!(!t.seed_ready && !t.req_pending);
}

#[test]
fn a_late_check_in_is_refused_and_the_window_is_counted_in_slots() {
    let mut env = ready();
    env.begin().unwrap();
    env.seat_players_standin();
    let end = env.table().checkin_end().unwrap();
    assert_eq!(end, env.table().assigned_slot + block_puzzle::CHECKIN_SLOTS);
    env.set_slot(end + 1);
    assert_eq!(
        custom_code(&env.check_in(0).unwrap_err()),
        dcode(E::CheckInClosed)
    );
    env.set_slot(end);
    env.check_in(0).expect("the last slot still counts");
}

// --- The Seed ----------------------------------------------------------------------------------

#[test]
fn start_needs_both_check_ins_and_the_seed_and_nothing_else() {
    let mut env = ready();
    env.begin().unwrap();
    env.seat_players_standin();
    assert_eq!(custom_code(&env.start().unwrap_err()), dcode(E::WrongPhase));
    env.check_in(0).unwrap();
    assert_eq!(custom_code(&env.start().unwrap_err()), dcode(E::WrongPhase));
    env.check_in(1).unwrap();
    // Seeding, but no answer yet.
    assert_eq!(
        custom_code(&env.start().unwrap_err()),
        dcode(E::SeedNotReady)
    );
    env.request_standin();
    assert_eq!(
        custom_code(&env.start().unwrap_err()),
        dcode(E::SeedNotReady),
        "asking is not answering"
    );
    env.callback([9; 32]).unwrap();
    env.start().expect("start");
    let t = env.table();
    assert_eq!(t.phase, block_puzzle::TABLE_GET_READY);
    assert_eq!(t.ready_slot, env.slot);
    assert_eq!(t.start_slot, env.slot + block_puzzle::GET_READY_SLOTS);
    assert_eq!(custom_code(&env.start().unwrap_err()), dcode(E::WrongPhase));
}

#[test]
fn a_seed_that_arrives_after_its_window_cannot_start_the_match() {
    let mut env = ready();
    env.check_in_both();
    env.request_standin();
    let end = env.table().seed_end().unwrap();
    env.set_slot(end + 1);
    env.callback([9; 32]).expect("the answer is stored");
    assert_eq!(
        custom_code(&env.start().unwrap_err()),
        dcode(E::SeedWindowClosed)
    );
    // The last slot of the window still starts it.
    let mut env = ready();
    env.check_in_both();
    env.request_standin();
    env.callback([9; 32]).unwrap();
    env.set_slot(end_of_seed_window(&env));
    env.start().expect("last slot");
}

fn end_of_seed_window(env: &Env) -> u64 {
    env.table().seed_end().unwrap()
}

#[test]
fn the_seed_request_is_made_once_and_retried_only_after_its_wait_and_never_past_the_window() {
    let mut env = ready();
    env.magic_shell_for_vrf();
    let caller = env.oracle.insecure_clone();
    // Not before both have checked in.
    let ixn = env.request_ix(a(caller.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(E::WrongPhase)
    );
    env.check_in_both();
    // A first request passes this program's checks and fails only in the oracle's program,
    // which LiteSVM does not have (devnet evidence).
    let ixn = env.request_ix(a(caller.pubkey()));
    let err = env.rollup(ixn).unwrap_err();
    assert!(
        !ours(&err).is_some_and(|c| (6000..6100).contains(&c)),
        "{:?}",
        err.meta.logs
    );
    // An outstanding request: no second one until its wait has passed.
    env.request_standin();
    let ixn = env.request_ix(a(caller.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn.clone()).unwrap_err()),
        dcode(E::SeedRequestNotDue)
    );
    let asked = env.table().req_slot;
    env.set_slot(asked + block_puzzle::SEED_RETRY_SLOTS - 1);
    assert_eq!(
        custom_code(&env.rollup(ixn.clone()).unwrap_err()),
        dcode(E::SeedRequestNotDue)
    );
    env.set_slot(asked + block_puzzle::SEED_RETRY_SLOTS);
    let err = env.rollup(ixn.clone()).unwrap_err();
    assert!(!ours(&err).is_some_and(|c| (6000..6100).contains(&c)));
    // The requests are used up.
    env.patch_table(|t| t.req_count = block_puzzle::MAX_SEED_REQUESTS);
    assert_eq!(
        custom_code(&env.rollup(ixn.clone()).unwrap_err()),
        dcode(E::SeedRequestNotDue)
    );
    // The window ended.
    env.patch_table(|t| t.req_count = 1);
    let end = env.table().seed_end().unwrap();
    env.set_slot(end + 1);
    assert_eq!(
        custom_code(&env.rollup(ixn.clone()).unwrap_err()),
        dcode(E::SeedWindowClosed)
    );
    // An answered request is not repeated.
    env.set_slot(asked + block_puzzle::SEED_RETRY_SLOTS);
    env.callback([1; 32]).unwrap();
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(E::SeedRequestNotDue)
    );
}

#[test]
fn only_the_answer_to_the_outstanding_request_is_accepted_and_only_once() {
    let mut env = ready();
    env.check_in_both();
    // Nothing asked yet.
    let marker = Table::request_marker(&env.table, 0);
    assert_eq!(
        custom_code(&env.callback_with([1; 32], marker).unwrap_err()),
        dcode(E::StaleRequest)
    );
    env.request_standin();
    // A marker for another request number, another table, or nothing.
    for wrong in [
        Table::request_marker(&env.table, 7),
        Table::request_marker(&table_addr(0, 1), 0),
        APk::new_unique(),
    ] {
        assert_eq!(
            custom_code(&env.callback_with([1; 32], wrong).unwrap_err()),
            dcode(E::StaleRequest)
        );
    }
    // Another epoch's request.
    env.patch_table(|t| t.req_epoch = 3);
    assert_eq!(
        custom_code(&env.callback([1; 32]).unwrap_err()),
        dcode(E::StaleRequest)
    );
    env.patch_table(|t| t.req_epoch = 0);
    env.callback([1; 32]).expect("the right answer");
    let t = env.table();
    assert!(t.seed_ready && !t.req_pending);
    let v = env.vault();
    assert!(v.ready);
    assert_eq!(
        v.seed,
        block_puzzle::derive_seed(&t.tesoro_match, 0, 0, 0, t.req_nonce, &[1; 32])
    );
    // Once.
    assert_eq!(
        custom_code(&env.callback([2; 32]).unwrap_err()),
        dcode(E::StaleRequest)
    );
    assert_eq!(env.vault().seed, v.seed);
}

#[test]
fn the_callback_must_come_from_the_oracle_and_only_while_seeding() {
    let mut env = ready();
    env.check_in_both();
    env.request_standin();
    // Without the VRF program identity as a signer the callback is refused.
    let ixn = ix(
        block_puzzle::ID,
        block_puzzle::accounts::SeedCallback {
            vrf_program_identity: env.alice.key,
            table: env.table,
            seed_vault: vault_addr(env.table),
            request: env.marker(),
        },
        block_puzzle::instruction::SeedCallback {
            randomness: [1; 32],
        },
        vec![],
    );
    let payer = env.oracle.insecure_clone();
    let alice = env.alice.kp.insecure_clone();
    assert!(env.send(&[ixn], &payer, &[&alice]).is_err());
    assert!(!env.vault().ready);
    // A callback after the Match left Seeding (stale, after start) is refused.
    env.callback([1; 32]).unwrap();
    env.start().unwrap();
    env.request_standin();
    assert_eq!(
        custom_code(&env.callback([2; 32]).unwrap_err()),
        dcode(E::StaleRequest)
    );
}

#[test]
fn a_stale_answer_after_a_reset_is_refused_and_the_next_match_gets_a_different_seed() {
    let mut env = Env::new();
    env.next_match_on(0);
    env.seeded([7; 32]);
    let first_seed = env.vault().seed;
    let old_marker = env.marker();
    env.set_slot(env.table().play_end().unwrap() + 1);
    env.close().unwrap();
    env.commit_standin();
    next_epoch(&mut env);
    env.next_match_on(0);
    env.check_in_both();
    // The old request's marker cannot answer anything in the new epoch.
    env.request_standin();
    assert_eq!(
        custom_code(&env.callback_with([7; 32], old_marker).unwrap_err()),
        dcode(E::StaleRequest)
    );
    // The same oracle output gives another Seed in the next Match: it is bound to the Match,
    // the epoch and the request number.
    env.callback([7; 32]).unwrap();
    assert_ne!(env.vault().seed, first_seed);
}

// --- start, begin ---------------------------------------------------------------------------

#[test]
fn begin_waits_for_the_start_slot_and_copies_the_seed_without_touching_anything_public() {
    let mut env = seeded();
    let start = env.table().start_slot;
    let seed = env.vault().seed;
    assert_ne!(seed, 0);
    // Nobody holds the pieces before the run starts.
    env.set_slot(start - 1);
    assert_eq!(
        custom_code(&env.begin_run(0).unwrap_err()),
        dcode(E::NotStarted)
    );
    assert_eq!(env.board(0).seed, 0);
    env.set_slot(start);
    let table_before = env.svm.get_account(&s(env.table)).unwrap();
    let vault_before = env.svm.get_account(&s(vault_addr(env.table))).unwrap();
    env.begin_run(0).expect("begin");
    let b = env.board(0);
    assert!(b.began);
    assert_eq!(b.seed, seed);
    assert_eq!((b.last_slot, b.last_ts), (env.slot, env.now));
    assert_eq!(env.board(1).seed, 0, "the other seat does not get it");
    // Public bytes and lamports are exactly as before.
    let table_after = env.svm.get_account(&s(env.table)).unwrap();
    assert_eq!(table_before.data, table_after.data);
    assert_eq!(table_before.lamports, table_after.lamports);
    assert_eq!(
        vault_before.data,
        env.svm.get_account(&s(vault_addr(env.table))).unwrap().data
    );
    // Once, and only the Match's Players.
    assert_eq!(
        custom_code(&env.begin_run(0).unwrap_err()),
        dcode(E::AlreadyBegan)
    );
    let stranger = env.admin.insecure_clone();
    let mut ixn = env.begin_run_ix(1, env.binding());
    ixn.accounts[0].pubkey = stranger.pubkey();
    assert_eq!(
        custom_code(&env.send(&[ixn], &stranger, &[]).unwrap_err()),
        dcode(E::NotAPlayer)
    );
    // Not after the window.
    let end = env.table().play_end().unwrap();
    env.set_slot(end + 1);
    assert_eq!(
        custom_code(&env.begin_run(1).unwrap_err()),
        dcode(E::PlayWindowClosed)
    );
}

#[test]
fn begin_before_the_seed_exists_is_refused() {
    let mut env = running();
    env.patch_vault(|v| v.wipe());
    assert_eq!(
        custom_code(&env.begin_run(0).unwrap_err()),
        dcode(E::SeedNotReady)
    );
}

// --- play -----------------------------------------------------------------------------------

#[test]
fn play_replays_the_moves_with_the_engine_logs_them_and_shows_the_score() {
    let mut env = begun();
    let start = env.table().start_slot;
    env.set_slot(start + 250);
    let moves = env.moves(0, 4);
    let expected = {
        let mut st = env.board(0).engine_state();
        for m in &moves {
            st.apply(engine::Move {
                piece: m.piece,
                x: m.x,
                y: m.y,
            })
            .unwrap();
        }
        st
    };
    env.play(0, 4).expect("play");
    let b = env.board(0);
    assert_eq!(
        (b.occ, b.gems, b.score, b.moves, b.used, b.over),
        (
            expected.occ,
            expected.gems,
            expected.score,
            expected.moves,
            expected.used,
            expected.over
        )
    );
    // The log: each move packed, each with the offset of the landing slot.
    for (i, m) in moves.iter().enumerate() {
        assert_eq!(b.log[i], block_puzzle::pack_move((i as u32 / 3) * 3, m));
        let off = u16::from_le_bytes([b.offsets[2 * i], b.offsets[2 * i + 1]]);
        assert_eq!(u64::from(off), 250);
    }
    // Before the freeze the public table shows the last seen score and move count.
    let t = env.table();
    assert_eq!((t.shown_score[0], t.shown_moves[0]), (b.score, 4));
    assert_eq!((t.shown_score[1], t.shown_moves[1]), (0, 0));
    println!("CU play(4 moves) {}", env.last_cu);
    assert!(env.last_cu < 200_000);
}

/// A client that only has the Seed and the packed log rebuilds the same board.
fn rebuilt_from_log(b: &Board) -> engine::State {
    let mut st = engine::State::new(b.seed);
    for i in 0..usize::from(b.moves) {
        let byte = b.log[i];
        let m = engine::Move {
            piece: (st.hand_base() + u32::from(byte >> 6)) as u16,
            x: (byte >> 3) & 7,
            y: byte & 7,
        };
        st.apply(m).expect("replays");
    }
    st
}

#[test]
fn the_reconnect_vector_seed_and_move_log_rebuild_the_live_state() {
    let mut env = begun();
    let start = env.table().start_slot;
    let mut at = start;
    for _ in 0..6 {
        at += SPS;
        env.set_slot(at);
        env.play(0, 4).unwrap();
    }
    let b = env.board(0);
    let st = rebuilt_from_log(&b);
    assert_eq!(
        (st.occ, st.gems, st.score, st.moves, st.used, st.over),
        (b.occ, b.gems, b.score, b.moves, b.used, b.over)
    );
    // The Match key, and so the Seed, is new every run: the first-fit run is 24 moves unless
    // this Seed fills the board first, and then it stops there with `over` set.
    assert!(
        b.moves == 24 || b.over,
        "{} moves, over {}",
        b.moves,
        b.over
    );
}

#[test]
fn the_reconnect_vector_rebuilds_a_run_that_fills_the_board_before_24_moves() {
    let seed = SHORT_RUN_SEED;
    let mut st = engine::State::new(seed);
    let moves = legal_moves(&st, 24);
    assert_eq!(moves.len(), 23);
    let mut log = vec![];
    for m in &moves {
        let slot = m.piece as u32 - st.hand_base();
        log.push(((slot as u8) << 6) | (m.x << 3) | m.y);
        st.apply(engine::Move {
            piece: m.piece,
            x: m.x,
            y: m.y,
        })
        .unwrap();
    }
    assert!(st.over);
    let mut rebuilt = engine::State::new(seed);
    for byte in &log {
        rebuilt
            .apply(engine::Move {
                piece: (rebuilt.hand_base() + u32::from(byte >> 6)) as u16,
                x: (byte >> 3) & 7,
                y: byte & 7,
            })
            .unwrap();
    }
    assert_eq!(
        (
            rebuilt.occ,
            rebuilt.score,
            rebuilt.moves,
            rebuilt.used,
            rebuilt.over
        ),
        (st.occ, st.score, st.moves, st.used, st.over)
    );
}

#[test]
fn the_freeze_play_writes_the_public_table_at_79_seconds_and_nothing_public_at_81() {
    let mut env = begun();
    let start = env.table().start_slot;
    let freeze = env.table().freeze_slot().unwrap();
    assert_eq!(freeze, start + 80 * SPS);
    // 79 s: the public table changes.
    env.set_slot(start + 79 * SPS);
    let before = env.svm.get_account(&s(env.table)).unwrap();
    env.play(0, 4).expect("play at 79 s");
    let after = env.svm.get_account(&s(env.table)).unwrap();
    assert_ne!(before.data, after.data, "the shown score moved");
    // The last slot before the freeze still shows; the freeze slot itself does not.
    env.set_slot(freeze - 1);
    env.play(0, 4).expect("play just before the freeze");
    env.set_slot(freeze);
    assert_eq!(
        custom_code(&env.play(0, 4).unwrap_err()),
        dcode(E::Frozen),
        "the public play is refused from the freeze"
    );
    // 81 s: a hidden play changes the Board and not one public byte, lamport or owner.
    env.set_slot(start + 81 * SPS);
    let table_before = env.svm.get_account(&s(env.table)).unwrap();
    let sponsor_before = env.svm.get_account(&s(sponsor_addr())).unwrap();
    let board_before = env.board(0);
    env.play_hidden(0, 4).expect("hidden play at 81 s");
    let table_after = env.svm.get_account(&s(env.table)).unwrap();
    assert_eq!(table_before.data, table_after.data);
    assert_eq!(table_before.lamports, table_after.lamports);
    assert_eq!(table_before.owner, table_after.owner);
    assert_eq!(
        sponsor_before.lamports,
        env.svm.get_account(&s(sponsor_addr())).unwrap().lamports
    );
    assert_eq!(env.board(0).moves, board_before.moves + 4);
    // The shown value stays the last seen one, which lags the truth.
    let t = env.table();
    assert!(t.shown_moves[0] < env.board(0).moves);
    assert!(t.shown_score[0] <= env.board(0).score);
    // The hidden play is not a way to hide your score while watching the opponent's.
    let mut env = begun();
    let start = env.table().start_slot;
    env.set_slot(start + 100);
    assert_eq!(
        custom_code(&env.play_hidden(1, 2).unwrap_err()),
        dcode(E::NotFrozen)
    );
    env.set_slot(freeze);
    env.play_hidden(1, 2).expect("hidden play from the freeze");
}

#[test]
fn the_hidden_play_has_no_public_account_and_no_other_instruction_writes_one_after_the_freeze() {
    // The IDL says what each instruction takes and whether it can write it.
    let idl = idl();
    let accounts = |name: &str| -> Vec<(String, bool)> {
        idl["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["name"] == name)
            .unwrap_or_else(|| panic!("{name}"))["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|acc| {
                (
                    acc["name"].as_str().unwrap().to_string(),
                    acc["writable"].as_bool().unwrap_or(false),
                )
            })
            .collect()
    };
    let writes =
        |name: &str, account: &str| accounts(name).into_iter().any(|(n, w)| n == account && w);
    assert!(writes("play", "table"), "the public play shows the score");
    for name in ["play_hidden", "begin"] {
        assert!(!writes(name, "table"), "{name} must not write the table");
        assert!(writes(name, "board"), "{name} writes the Player's Board");
    }
    // Nothing public is writable in the hidden play: the table is read-only and there is no
    // other account but the signer.
    let hidden = accounts("play_hidden");
    assert_eq!(
        hidden.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
        ["player", "table", "board"]
    );
    assert!(!hidden[0].1 || hidden[0].0 == "player");
}

/// The fixed-shape hidden beat: `moves` padded to 8 entries, `count` real.
fn hidden_args(
    binding: Binding,
    expected: u16,
    beat: u8,
    moves: &[MoveArg],
) -> block_puzzle::instruction::PlayHidden {
    let pad = MoveArg {
        piece: 0,
        x: 0,
        y: 0,
    };
    let mut padded = [pad; 8];
    padded[..moves.len()].copy_from_slice(moves);
    block_puzzle::instruction::PlayHidden {
        binding,
        expected_count: expected,
        beat,
        count: moves.len() as u8,
        moves: padded,
    }
}

fn idl() -> serde_json::Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/idl/block_puzzle.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("IDL: pnpm build:programs"))
        .expect("json")
}

#[test]
fn a_move_counts_three_seconds_after_time_is_up_and_not_a_slot_later() {
    let mut env = begun();
    let start = env.table().start_slot;
    let end = env.table().play_end().unwrap();
    assert_eq!(end, start + 93 * SPS, "90 s of play and the 3 s grace");
    env.set_slot(end);
    env.play_hidden(0, 2)
        .expect("the last slot of the grace counts");
    env.set_slot(end + 1);
    assert_eq!(
        custom_code(&env.play_hidden(0, 2).unwrap_err()),
        dcode(E::PlayWindowClosed)
    );
    assert_eq!(
        custom_code(&env.play_hidden(1, 2).unwrap_err()),
        dcode(E::PlayWindowClosed)
    );
}

#[test]
fn pacing_refuses_a_stockpile_dump_and_lets_a_human_keep_up() {
    let mut env = begun();
    let start = env.table().start_slot;
    // A burst of 6 at once is fine, 7 is not; the other Player's stockpile is refused alike.
    env.set_slot(start);
    assert_eq!(custom_code(&env.play(0, 7).unwrap_err()), dcode(E::TooFast));
    assert_eq!(custom_code(&env.play(1, 8).unwrap_err()), dcode(E::TooFast));
    assert_eq!(env.board(0).moves, 0, "nothing was applied");
    env.play(0, 6).expect("the burst");
    assert_eq!(custom_code(&env.play(0, 1).unwrap_err()), dcode(E::TooFast));
    // 4 more moves become allowed per second: the 7th move needs a quarter second.
    env.set_slot(start + SPS / 4 - 1);
    assert_eq!(custom_code(&env.play(0, 1).unwrap_err()), dcode(E::TooFast));
    env.set_slot(start + SPS / 4);
    env.play(0, 1).expect("the 7th move after a quarter second");
    // One second in, the allowance is 10 moves in all.
    env.set_slot(start + SPS);
    assert_eq!(custom_code(&env.play(0, 4).unwrap_err()), dcode(E::TooFast));
    env.play(0, 3).expect("up to ten in the first second");
    assert_eq!(env.board(0).moves, 10);
    // The pace holds from the freeze on, for the hidden play, counting what was played before.
    env.set_slot(start + 80 * SPS);
    let n = env.board(0).moves;
    assert!(u64::from(n) * SPS <= 4 * 80 * SPS + 6 * SPS);
    env.play_hidden(0, 4).expect("hidden, well inside the pace");
}

#[test]
fn a_batch_has_one_to_eight_moves() {
    let mut env = begun();
    let start = env.table().start_slot;
    env.set_slot(start + 10 * SPS);
    let (binding, expected) = (env.binding(), 0);
    assert_eq!(
        custom_code(
            &env.play_with(0, binding, expected, vec![], false)
                .unwrap_err()
        ),
        dcode(E::BadBatch)
    );
    let nine = env.moves(0, 9);
    assert_eq!(nine.len(), 9);
    assert_eq!(
        custom_code(
            &env.play_with(0, binding, expected, nine, false)
                .unwrap_err()
        ),
        dcode(E::BadBatch)
    );
    env.play(0, 8).expect("eight");
}

#[test]
fn an_illegal_move_rejects_the_whole_batch_and_leaves_the_board() {
    let mut env = begun();
    let start = env.table().start_slot;
    env.set_slot(start + 10 * SPS);
    let mut moves = env.moves(0, 3);
    moves[2].piece = 99;
    let (binding, expected) = (env.binding(), 0);
    let before = env.board(0);
    assert_eq!(
        custom_code(
            &env.play_with(0, binding, expected, moves, false)
                .unwrap_err()
        ),
        dcode(E::IllegalMove)
    );
    assert_eq!(env.board(0), before);
}

#[test]
fn the_expected_count_makes_a_resent_batch_a_no_op() {
    let mut env = begun();
    let start = env.table().start_slot;
    env.set_slot(start + 10 * SPS);
    let (binding, moves) = (env.binding(), env.moves(0, 3));
    env.play_with(0, binding, 0, moves.clone(), false).unwrap();
    let after = env.board(0);
    // The same batch again, or with a count that is too high: refused, nothing changes.
    for expected in [0u16, 1, 4, 100] {
        assert_eq!(
            custom_code(
                &env.play_with(0, binding, expected, moves.clone(), false)
                    .unwrap_err()
            ),
            dcode(E::WrongCount),
            "expected {expected}"
        );
    }
    assert_eq!(env.board(0), after);
    // The count is per Player.
    let m1 = env.moves(1, 2);
    env.play_with(1, binding, 0, m1, false).unwrap();
}

#[test]
fn a_player_cannot_play_another_players_board_or_before_beginning() {
    let mut env = begun();
    let start = env.table().start_slot;
    env.set_slot(start + 10 * SPS);
    // Alice presents Bob's Board.
    let (kp, key) = env.person_of(0);
    let binding = env.binding();
    let moves = env.moves(1, 2);
    let ixn = ix(
        block_puzzle::ID,
        block_puzzle::accounts::PlayHidden {
            player: key,
            table: env.table,
            board: board_addr(env.table, 1),
        },
        hidden_args(binding, 0, 0, &moves),
        vec![],
    );
    assert_eq!(
        custom_code(&env.send(&[ixn], &kp, &[]).unwrap_err()),
        dcode(E::NotAPlayer)
    );
    // A Player who never began cannot play.
    let mut env = running();
    let start = env.table().start_slot;
    env.set_slot(start + 10 * SPS);
    env.begin_run(0).unwrap();
    let moves = legal_moves(&engine::State::new(env.board(0).seed), 2);
    let ixn = env.play_ix(1, env.binding(), 0, moves, false);
    let (kp, _) = env.person_of(1);
    assert_eq!(
        custom_code(&env.send(&[ixn], &kp, &[]).unwrap_err()),
        dcode(E::NotBegan)
    );
}

#[test]
fn a_run_that_is_over_takes_no_more_moves_and_both_runs_over_end_the_match_early() {
    let mut env = begun();
    let start = env.table().start_slot;
    let mut at = start;
    for seat in 0..2 {
        let mut guard = 0;
        while !env.board(seat).over {
            guard += 1;
            assert!(guard < 100, "the game does not end");
            at += SPS;
            env.set_slot(at);
            env.play_any(seat, 4).unwrap();
        }
    }
    assert!(at < env.table().freeze_slot().unwrap() + 100 * SPS);
    let b = env.board(0);
    assert!(b.over);
    assert_eq!(
        custom_code(&env.play_any(0, 1).unwrap_err()),
        dcode(E::RunOver)
    );
    // Both are over: the Match can be closed without waiting for the clock.
    assert!(env.slot < env.table().play_end().unwrap());
    env.close().expect("early close");
    let t = env.table();
    assert_eq!(t.phase, block_puzzle::TABLE_CLOSED);
    assert_eq!(t.final_moves, [env.board(0).moves, env.board(1).moves]);
}

#[test]
fn binding_an_instruction_to_another_match_epoch_or_generation_is_refused_everywhere() {
    let mut env = begun();
    let start = env.table().start_slot;
    env.set_slot(start + 10 * SPS);
    let good = env.binding();
    let other = APk::new_unique();
    for bad in [
        Binding {
            tesoro_match: other,
            ..good
        },
        Binding {
            generation: good.generation + 1,
            ..good
        },
        Binding {
            epoch: good.epoch + 1,
            ..good
        },
    ] {
        assert_eq!(
            custom_code(&env.check_in_with(0, bad).unwrap_err()),
            dcode(E::StaleBinding)
        );
        assert_eq!(
            custom_code(&env.begin_run_with(0, bad).unwrap_err()),
            dcode(E::StaleBinding)
        );
        let moves = env.moves(0, 2);
        let (start, freeze) = (env.table().start_slot, env.table().freeze_slot().unwrap());
        for (hidden, at) in [(false, start + 10 * SPS), (true, freeze)] {
            env.set_slot(at);
            assert_eq!(
                custom_code(&env.play_with(0, bad, 0, moves.clone(), hidden).unwrap_err()),
                dcode(E::StaleBinding)
            );
        }
        env.set_slot(start + 10 * SPS);
    }
}

#[test]
fn a_transaction_held_back_from_one_match_is_worthless_in_the_next_on_the_same_table() {
    let mut env = Env::new();
    env.next_match_on(0);
    env.begin().unwrap();
    env.seat_players_standin();
    let old = env.binding();
    env.check_in(0).unwrap();
    env.check_in(1).unwrap();
    env.request_standin();
    env.callback([3; 32]).unwrap();
    env.start().unwrap();
    env.set_slot(env.table().start_slot);
    env.begin_run(0).unwrap();
    env.begin_run(1).unwrap();
    let old_moves = env.moves(0, 2);
    env.set_slot(env.table().play_end().unwrap() + 1);
    env.close().unwrap();
    env.commit_standin();
    next_epoch(&mut env);
    // Match 2 on the same table.
    env.next_match_on(0);
    env.begin().unwrap();
    env.seat_players_standin();
    assert_ne!(env.binding(), old);
    assert_eq!(
        custom_code(&env.check_in_with(0, old).unwrap_err()),
        dcode(E::StaleBinding)
    );
    env.check_in(0).unwrap();
    env.check_in(1).unwrap();
    env.request_standin();
    env.callback([3; 32]).unwrap();
    env.start().unwrap();
    env.set_slot(env.table().start_slot);
    assert_eq!(
        custom_code(&env.begin_run_with(0, old).unwrap_err()),
        dcode(E::StaleBinding)
    );
    env.begin_run(0).unwrap();
    let (start, freeze) = (env.table().start_slot, env.table().freeze_slot().unwrap());
    for (hidden, at) in [(false, start), (true, freeze)] {
        env.set_slot(at);
        assert_eq!(
            custom_code(
                &env.play_with(0, old, 0, old_moves.clone(), hidden)
                    .unwrap_err()
            ),
            dcode(E::StaleBinding)
        );
    }
}

// --- The outcome table ------------------------------------------------------------------------

/// Finalizes the committed result and returns what each Player's Gemas changed by.
fn settle(env: &mut Env) -> (i64, i64) {
    env.commit_standin();
    let before = (env.gemas(&env.alice) as i64, env.gemas(&env.bob) as i64);
    env.finalize().expect("finalize");
    (
        env.gemas(&env.alice) as i64 - before.0,
        env.gemas(&env.bob) as i64 - before.1,
    )
}

#[test]
fn neither_player_checking_in_is_a_no_show_each_side_pays_the_platform_fee() {
    let mut env = ready();
    env.begin().unwrap();
    env.seat_players_standin();
    let end = env.table().checkin_end().unwrap();
    env.set_slot(end);
    assert_eq!(
        custom_code(&env.close().unwrap_err()),
        dcode(E::NotClosable),
        "the last slot of the window is still the window"
    );
    env.set_slot(end + 1);
    env.close().expect("close");
    assert_eq!(
        outcome_of(&env),
        (OUTCOME_NO_SHOW, block_puzzle::REASON_NEITHER)
    );
    let t = env.table();
    assert_eq!((t.phase, t.dirty), (block_puzzle::TABLE_CLOSED, true));
    let (ga, gb) = settle(&mut env);
    assert_eq!(ga, gb, "both sides pay the same");
    assert!(
        ga > 900 && ga < 1_000,
        "each gets the entry back less the Platform Fee, got {ga}"
    );
    assert_eq!(env.tesoro_status(), Stage::Closed);
}

#[test]
fn a_player_who_does_not_check_in_loses_to_the_one_who_did() {
    for present in [0usize, 1] {
        let mut env = ready();
        env.begin().unwrap();
        env.seat_players_standin();
        env.check_in(present).unwrap();
        let end = env.table().checkin_end().unwrap();
        env.set_slot(end + 1);
        env.close().expect("close");
        let (outcome, why) = outcome_of(&env);
        assert_eq!(
            (outcome, why),
            (
                if present == 0 {
                    OUTCOME_WIN0
                } else {
                    OUTCOME_WIN1
                },
                block_puzzle::REASON_ABSENT
            )
        );
        let (ga, gb) = settle(&mut env);
        // A normal win: the Pot of 2,000 less 5% fees to the present side; core needs no
        // one-sided result.
        let (winner, loser) = if present == 0 { (ga, gb) } else { (gb, ga) };
        assert_eq!(
            (winner, loser),
            (1_900, 0),
            "the Pot less 5% fees, nothing for the absent side"
        );
    }
}

#[test]
fn a_stall_during_check_in_turns_a_one_sided_absence_into_a_refund() {
    let mut env = ready();
    env.begin().unwrap();
    env.seat_players_standin();
    env.check_in(0).unwrap();
    let end = env.table().checkin_end().unwrap();
    // The window ran out in slots, but ten minutes of wall clock passed: the rollup stalled.
    let ts = env.table().assigned_ts + 600;
    env.set_clock(end + 1, ts);
    env.close().expect("close");
    assert_eq!(outcome_of(&env), (OUTCOME_DRAW, block_puzzle::REASON_VOID));
    assert_eq!(settle(&mut env), (1_000, 1_000));
}

#[test]
fn a_seed_that_never_came_refunds_both() {
    let mut env = ready();
    env.check_in_both();
    let end = env.table().seed_end().unwrap();
    env.set_slot(end);
    assert_eq!(
        custom_code(&env.close().unwrap_err()),
        dcode(E::NotClosable)
    );
    env.set_slot(end + 1);
    env.close().expect("close");
    assert_eq!(
        outcome_of(&env),
        (OUTCOME_DRAW, block_puzzle::REASON_NO_SEED)
    );
    assert_eq!(settle(&mut env), (1_000, 1_000));
}

#[test]
fn both_checked_in_and_nobody_moved_is_a_no_show_that_costs_each_side_the_platform_fee() {
    let mut env = begun();
    let end = env.table().play_end().unwrap();
    env.set_slot(end);
    assert_eq!(
        custom_code(&env.close().unwrap_err()),
        dcode(E::NotClosable)
    );
    env.set_slot(end + 1);
    env.close().expect("close");
    assert_eq!(
        outcome_of(&env),
        (OUTCOME_NO_SHOW, block_puzzle::REASON_NO_SHOW)
    );
    let (ga, gb) = settle(&mut env);
    assert_eq!(ga, gb, "both sides pay the same");
    assert!(
        ga > 900 && ga < 1_000,
        "each loses the Platform Fee only, got {ga}"
    );
}

#[test]
fn the_player_who_moved_beats_the_one_who_did_not() {
    let mut env = ready();
    env.play_out(3, 0);
    assert_eq!(
        outcome_of(&env),
        (OUTCOME_WIN0, block_puzzle::REASON_PLAYED)
    );
    assert_eq!(settle(&mut env), (1_900, 0));
}

#[test]
fn the_higher_score_wins_whoever_sits_where() {
    let mut env = ready();
    env.play_out(10, 6);
    let t = env.table();
    assert!(t.final_scores[0] > t.final_scores[1]);
    assert_eq!(t.final_moves, [10, 6]);
    assert_eq!(
        outcome_of(&env),
        (OUTCOME_WIN0, block_puzzle::REASON_PLAYED)
    );
    let (ga, gb) = settle(&mut env);
    assert_eq!((ga, gb), (1_900, 0));

    let mut env = Env::new();
    env.next_match_on(0);
    env.play_out(6, 10);
    assert_eq!(
        outcome_of(&env),
        (OUTCOME_WIN1, block_puzzle::REASON_PLAYED)
    );
    let t = env.table();
    assert!(t.final_scores[0] < t.final_scores[1]);
}

#[test]
fn equal_scores_are_a_no_show_when_both_made_fewer_than_five_moves_and_a_draw_otherwise() {
    // Both Players play the same Seed, so the same moves score the same.
    for (n, want, reason) in [
        (4usize, OUTCOME_NO_SHOW, block_puzzle::REASON_TRIVIAL),
        (5, OUTCOME_DRAW, block_puzzle::REASON_DRAW),
        (9, OUTCOME_DRAW, block_puzzle::REASON_DRAW),
    ] {
        let mut env = Env::new();
        env.next_match_on(0);
        env.play_out(n, n);
        let t = env.table();
        assert_eq!(t.final_scores[0], t.final_scores[1], "{n} moves");
        assert_eq!(outcome_of(&env), (want, reason), "{n} moves");
        let (ga, gb) = settle(&mut env);
        if want == OUTCOME_DRAW {
            assert_eq!((ga, gb), (1_000, 1_000), "exact refund");
        } else {
            assert_eq!(ga, gb);
            assert!(ga > 900 && ga < 1_000, "got {ga}");
        }
    }
    // One under, one over the line is not trivial: the equal scores of different move counts
    // cannot happen, but 4 and 5 moves with unequal scores is a plain win.
    let mut env = Env::new();
    env.next_match_on(0);
    env.play_out(5, 4);
    assert_eq!(
        outcome_of(&env),
        (OUTCOME_WIN0, block_puzzle::REASON_PLAYED)
    );
}

#[test]
fn a_rollup_outage_during_the_run_voids_the_match_and_refunds_in_full() {
    // Over the whole run: far more wall clock than slots.
    let mut env = begun();
    let end = env.table().play_end().unwrap();
    env.play_any(0, 3).unwrap();
    let ts = env.table().ready_ts + 10_000;
    env.set_clock(end + 1, ts);
    env.close().expect("close");
    assert_eq!(outcome_of(&env), (OUTCOME_DRAW, block_puzzle::REASON_VOID));
    assert_eq!(settle(&mut env), (1_000, 1_000));

    // A stall between one Player's own transactions marks the seat, even if the run as a whole
    // looks healthy at the end.
    let mut env = Env::new();
    env.next_match_on(0);
    env.begun();
    let start = env.table().start_slot;
    env.set_slot(start + SPS);
    env.play_any(0, 2).unwrap();
    let (slot, ts) = (env.slot, env.now);
    // 60 seconds of wall clock, 100 slots.
    env.set_clock(slot + 100, ts + 60);
    env.play_any(0, 2).unwrap();
    assert!(env.board(0).stalled);
    assert!(!env.board(1).stalled);
    let end = env.table().play_end().unwrap();
    env.set_clock(
        end + 1,
        ts + 60 + (end + 1 - slot - 100) as i64 / SPS as i64,
    );
    env.close().expect("close");
    assert_eq!(outcome_of(&env), (OUTCOME_DRAW, block_puzzle::REASON_VOID));
}

#[test]
fn a_slow_player_is_not_a_stall_and_a_short_gap_is_never_judged() {
    let mut env = begun();
    let start = env.table().start_slot;
    env.set_slot(start + SPS);
    env.play_any(0, 2).unwrap();
    // 30 seconds of thinking at the healthy rate.
    env.set_slot(start + 31 * SPS);
    env.play_any(0, 2).unwrap();
    // Four seconds with no slots at all is under the judging threshold.
    let (slot, ts) = (env.slot, env.now);
    env.set_clock(slot, ts + 4);
    env.play_any(0, 2).unwrap();
    assert!(!env.board(0).stalled);
}

#[test]
fn close_waits_for_the_clock_unless_both_runs_are_over_and_closes_only_once() {
    let mut env = begun();
    assert_eq!(
        custom_code(&env.close().unwrap_err()),
        dcode(E::NotClosable)
    );
    let end = env.table().play_end().unwrap();
    env.set_slot(end + 1);
    env.close().unwrap();
    assert_eq!(custom_code(&env.close().unwrap_err()), dcode(E::WrongPhase));
    // An idle table has nothing to close.
    let mut env = ready();
    assert_eq!(custom_code(&env.close().unwrap_err()), dcode(E::WrongPhase));
}

#[test]
fn the_result_carries_both_run_logs_bound_to_the_match_epoch_and_seed() {
    let mut env = ready();
    env.begun();
    let start = env.table().start_slot;
    let seed = env.board(0).seed;
    env.set_slot(start + 2 * SPS);
    env.play(0, 4).unwrap();
    env.set_slot(start + 5 * SPS);
    env.play(1, 3).unwrap();
    let (b0, b1) = (env.board(0), env.board(1));
    env.set_slot(env.table().play_end().unwrap() + 1);
    env.close().unwrap();
    let t = env.table();
    let (i, slot) = t.ring.find(&env.tmatch, 0).unwrap();
    assert_eq!(slot.state, table_kit::SLOT_DONE);
    let log = &t.logs[i as usize];
    assert_eq!(log.engine_version, block_puzzle::ENGINE_VERSION);
    assert_eq!(log.seed, seed);
    assert_eq!(log.seed_hash, block_puzzle::seed_hash(seed, &env.tmatch, 0));
    assert_eq!(log.start_slot, start);
    assert_eq!(log.scores, [b0.score, b1.score]);
    assert_eq!(log.counts, [4, 3]);
    assert_eq!(&log.moves[..120], &b0.log[..]);
    assert_eq!(&log.moves[120..], &b1.log[..]);
    assert_eq!(&log.offsets[..240], &b0.offsets[..]);
    assert_eq!(&log.offsets[240..], &b1.offsets[..]);
    assert_eq!(u16::from_le_bytes([log.offsets[0], log.offsets[1]]), 200);
    assert_eq!(
        u16::from_le_bytes([log.offsets[240], log.offsets[241]]),
        500
    );
    // The finished Match is public in the table too.
    assert_eq!(t.final_scores, log.scores);
    assert_eq!(t.final_moves, [4, 3]);
}

// --- Privacy ----------------------------------------------------------------------------------

#[test]
fn after_start_no_public_account_holds_the_seed_or_the_oracle_output() {
    let randomness = [0x5au8; 32];
    let mut env = ready();
    env.running(randomness);
    env.begin_run(0).unwrap();
    let seed = env.vault().seed;
    let needles: Vec<(&str, Vec<u8>)> = vec![
        ("seed le", seed.to_le_bytes().to_vec()),
        ("seed be", seed.to_be_bytes().to_vec()),
        ("oracle output", randomness.to_vec()),
        ("oracle output half", randomness[..16].to_vec()),
    ];
    let publics: Vec<(&str, APk)> = vec![
        ("table", env.table),
        ("assignment", assign_addr(env.tmatch)),
        ("sponsor", sponsor_addr()),
        ("config", config_addr()),
        ("core match", env.tmatch),
    ];
    for (name, key) in &publics {
        let acct = env.svm.get_account(&s(*key)).unwrap();
        for (what, needle) in &needles {
            assert!(!contains(&acct.data, needle), "{what} leaked into {name}");
        }
    }
    // Only the Vault and the begun Board hold the Seed.
    let vault = env.svm.get_account(&s(vault_addr(env.table))).unwrap();
    assert!(contains(&vault.data, &seed.to_le_bytes()));
    let own = env.svm.get_account(&s(board_addr(env.table, 0))).unwrap();
    assert!(contains(&own.data, &seed.to_le_bytes()));
    let other = env.svm.get_account(&s(board_addr(env.table, 1))).unwrap();
    assert!(!contains(&other.data, &seed.to_le_bytes()));
    // The oracle output is kept nowhere at all.
    for key in [
        env.table,
        vault_addr(env.table),
        board_addr(env.table, 0),
        board_addr(env.table, 1),
    ] {
        let acct = env.svm.get_account(&s(key)).unwrap();
        assert!(!contains(&acct.data, &randomness));
    }
}

#[test]
fn nothing_the_game_does_is_logged_and_the_seed_is_in_no_log() {
    let mut env = ready();
    env.check_in_both();
    env.request_standin();
    env.callback([0x77; 32]).unwrap();
    let callback_logs = env.last_logs.clone();
    env.start().unwrap();
    let start_logs = env.last_logs.clone();
    env.set_slot(env.table().start_slot + 100);
    env.begin_run(0).unwrap();
    let begin_logs = env.last_logs.clone();
    env.begin_run(1).unwrap();
    env.play(0, 3).unwrap();
    let play_logs = env.last_logs.clone();
    env.play_any(1, 3).unwrap();
    let hidden_logs = env.last_logs.clone();
    env.set_slot(env.table().play_end().unwrap() + 1);
    env.close().unwrap();
    let close_logs = env.last_logs.clone();
    let seed = env.vault().seed;
    for (name, logs) in [
        ("callback", callback_logs),
        ("start", start_logs),
        ("begin", begin_logs),
        ("play", play_logs),
        ("play_hidden", hidden_logs),
        ("close", close_logs),
    ] {
        for line in &logs {
            if let Some(text) = line.strip_prefix("Program log: ") {
                assert!(text.starts_with("Instruction: "), "{name} logged {text:?}");
            }
            assert!(!line.contains(&seed.to_string()), "{name}: {line}");
            assert!(!line.contains(&format!("{seed:x}")), "{name}: {line}");
        }
    }
}

#[test]
fn error_codes_do_not_depend_on_the_hidden_seed_or_board() {
    // The same refused call gives the same code whatever the Seed or the board holds.
    let mut codes = vec![];
    for randomness in [[1u8; 32], [2u8; 32], [3u8; 32]] {
        let mut env = ready();
        env.running(randomness);
        env.begin_run(0).unwrap();
        let (binding, moves) = (env.binding(), env.moves(0, 2));
        let mut bad = moves.clone();
        bad[1].piece = 200;
        let illegal = custom_code(&env.play_with(0, binding, 0, bad, true).unwrap_err());
        let wrong_count = custom_code(&env.play_with(0, binding, 5, moves, true).unwrap_err());
        codes.push((illegal, wrong_count));
    }
    assert!(codes.windows(2).all(|w| w[0] == w[1]), "{codes:?}");
}

#[test]
fn a_wiped_seat_is_blank_and_the_reset_forgets_the_match_but_not_the_ring() {
    let mut env = Env::new();
    env.next_match_on(0);
    env.play_out(4, 3);
    let over = env.table().over_at;
    let first = env.table();
    env.set_time(over + block_puzzle::RESET_DELAY_SECS);
    assert_eq!(custom_code(&env.reset().unwrap_err()), dcode(E::SeatsOpen));
    assert!(!env.board(0).is_blank() && !env.vault().is_blank());
    env.wipe_standin();
    for seat in 0..2 {
        assert!(env.board(seat).is_blank(), "seat {seat} holds nothing");
        assert_eq!(env.board(seat).player, APk::default());
        assert_eq!(env.board(seat).moves, 0);
    }
    assert!(env.vault().is_blank());
    assert_eq!(
        custom_code(&env.reset().unwrap_err()),
        dcode(E::NotCommitted)
    );
    env.commit_standin();
    env.set_time(over + block_puzzle::RESET_DELAY_SECS - 1);
    assert_eq!(
        custom_code(&env.reset().unwrap_err()),
        dcode(E::ResetTooEarly)
    );
    env.set_time(over + block_puzzle::RESET_DELAY_SECS);
    let commit_before = env.table().commit;
    env.reset().expect("reset");
    let mut expected = Table::new(first.bump, 0, 0);
    expected.epoch = 1;
    expected.ring = first.ring;
    expected.logs = first.logs.clone();
    expected.vrf_nonce = first.vrf_nonce;
    expected.seats_created = true;
    expected.commit = commit_before;
    assert_eq!(bytes_of(&env.table()), bytes_of(&expected));
    assert_eq!(env.table().ring.used(), 1);
    assert_eq!(custom_code(&env.reset().unwrap_err()), dcode(E::WrongPhase));
}

// --- Results, the ring and finalize ------------------------------------------------------------

#[test]
fn finalize_pays_the_winner_from_the_committed_ring_and_the_loser_nothing() {
    let mut env = ready();
    env.play_out(8, 5);
    env.commit_standin();
    let close_cu = env.last_cu;
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
    println!("CU close {close_cu} finalize {finalize_cu}");
    assert!(finalize_cu < 300_000, "finalize used {finalize_cu} CU");
}

#[test]
fn finalize_emits_the_session_record_through_the_event_cpi() {
    let mut env = ready();
    env.play_out(8, 5);
    env.commit_standin();
    env.finalize_start().expect("settle");
    assert!(
        env.last_logs
            .iter()
            .any(|l| l.contains("invoke [2]") && l.contains(&block_puzzle::ID.to_string())),
        "the record is a self-CPI, not a log line: {:?}",
        env.last_logs
    );
}

#[test]
fn a_live_match_cannot_be_finalized() {
    let mut env = begun();
    env.commit_standin();
    let err = env.finalize_start().unwrap_err();
    assert_eq!(custom_code(&err), dcode(E::MatchNotOver));
}

#[test]
fn finalize_reads_only_the_committed_table_owned_by_the_delegation_program() {
    let mut env = ready();
    env.play_out(4, 2);
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
        assert_eq!(custom_code(&err), dcode(E::BadTable), "owner {owner}");
        env.svm.set_account(s(table), live).unwrap();
    }
}

#[test]
fn finalize_from_another_table_or_a_table_with_garbage_is_refused() {
    let mut env = ready();
    env.play_out(4, 2);
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
    assert_eq!(custom_code(&err), dcode(E::BadTable));
    env.table = right;
    env.committed.insert(right, vec![7u8; 400]);
    let err = env.finalize_start().unwrap_err();
    assert_eq!(custom_code(&err), dcode(E::BadTable));
}

#[test]
fn a_settled_match_cannot_be_settled_again() {
    let mut env = ready();
    env.play_out(4, 2);
    env.commit_standin();
    env.finalize().expect("settle");
    assert!(
        env.finalize_start().is_err(),
        "core refuses a second settlement"
    );
}

#[test]
fn settling_from_the_wrong_epoch_finds_no_result() {
    // The ring is keyed by (Match, epoch): an Assignment for epoch 0 cannot read epoch 1's slot.
    let mut env = Env::new();
    env.next_match_on(0);
    env.play_out(4, 2);
    env.commit_standin();
    let mut asg: Assignment = env.load(assign_addr(env.tmatch));
    asg.epoch = 1;
    env.store(assign_addr(env.tmatch), &asg, block_puzzle::ID);
    assert_eq!(
        custom_code(&env.finalize_start().unwrap_err()),
        dcode(E::NoResult)
    );
}

#[test]
fn a_stale_commit_never_refunds_a_match_that_has_a_result() {
    let mut env = ready();
    env.play_out(4, 2);
    // The result was never committed. Base's copy is the idle table from before the Match.
    env.set_time(env.now + 10 * 86_400 / 10);
    let err = env.finalize_start().unwrap_err();
    assert_eq!(custom_code(&err), dcode(E::NoResult));
    env.set_time(T0 + 2 * block_puzzle::TABLE_WINDOW_SECS);
    let err = env.finalize_start().unwrap_err();
    assert_eq!(custom_code(&err), dcode(E::NoResult));
}

#[test]
fn a_match_that_never_began_is_refunded_only_once_the_table_has_moved_past_its_epoch() {
    let mut env = Env::new();
    env.next_match_on(0);
    let never = (env.mref.unwrap(), env.table);
    env.next_match_on(0);
    env.play_out(4, 2);
    env.commit_standin();
    next_epoch(&mut env);
    env.use_match(never.0, never.1);
    env.set_time(env.now + 1_000);
    assert_eq!(
        custom_code(&env.finalize_start().unwrap_err()),
        dcode(E::NoResult),
        "base has not seen the next epoch yet"
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
}

#[test]
fn a_table_is_reused_and_every_result_and_its_log_wait_in_the_ring_until_the_receipt() {
    let mut env = Env::new();
    let mut played: Vec<(flow::MatchRef, APk, [u32; 2], [u16; 2])> = vec![];
    for (n, (m0, m1)) in [(9usize, 4usize), (3, 8), (6, 6)].into_iter().enumerate() {
        env.next_match_on(0);
        assert_eq!(
            env.table().epoch,
            n as u64,
            "each Match runs in its own epoch"
        );
        env.play_out(m0, m1);
        let t = env.table();
        played.push((env.mref.unwrap(), env.table, t.final_scores, t.final_moves));
        env.commit_standin();
        next_epoch(&mut env);
        assert_eq!(
            env.table().ring.used(),
            n + 1,
            "results are kept across resets"
        );
        assert!(env.table().seats_created, "the seats outlive the Match");
    }
    // Every result is in base's copy with its own log, even though the table has been reset.
    let committed = env.table_at_committed();
    assert_eq!(committed.ring.used(), 3);
    for (m, _, scores, counts) in &played {
        let (i, slot) = committed
            .ring
            .find(
                &m.key,
                played.iter().position(|p| p.0.key == m.key).unwrap() as u64,
            )
            .unwrap();
        assert_eq!(slot.state, table_kit::SLOT_DONE);
        let log = &committed.logs[i as usize];
        assert_eq!((log.scores, log.counts), (*scores, *counts));
    }
    // Settle each from the ring; the log stays until the slot is freed by the receipt.
    for (k, (m, table, _, _)) in played.iter().enumerate() {
        env.use_match(*m, *table);
        env.finalize().expect("settle from the ring");
        let slot = env.table().ring.find(&m.key, k as u64).unwrap().0;
        assert!(
            env.table().logs[slot as usize].counts != [0, 0],
            "the log survives until the slot is released"
        );
        env.set_time(env.now + block_puzzle::RELEASE_DELAY_SECS);
        env.release(slot, m.key).expect("freed on the receipt");
    }
    assert_eq!(env.table().ring.used(), 0);
}

#[test]
fn a_match_assigned_to_a_past_epoch_never_begins_and_is_refunded_not_paid_from_another_result() {
    let mut env = Env::new();
    env.next_match_on(0);
    env.play_out(5, 2);
    env.commit_standin();
    next_epoch(&mut env);
    env.open_and_join(1_000);
    env.assign(0, 0, 0).unwrap();
    assert_eq!(
        custom_code(&env.begin().unwrap_err()),
        dcode(E::NotAssigned)
    );
    env.commit_standin();
    env.set_time(env.now + 1_000);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize().expect("refund");
    assert_eq!(
        (env.gemas(&env.alice), env.gemas(&env.bob)),
        (before.0 + 1_000, before.1 + 1_000)
    );
}

// --- Release, void, reset ---------------------------------------------------------------------

#[test]
fn a_slot_is_freed_only_on_the_cores_receipt_and_not_a_minute_too_soon() {
    let mut env = ready();
    env.play_out(4, 2);
    env.commit_standin();
    let m = env.tmatch;
    let slot = env.table().slot;
    assert_eq!(
        custom_code(&env.release(slot, m).unwrap_err()),
        dcode(E::NoReceipt)
    );
    env.finalize().expect("settle");
    assert_eq!(
        custom_code(&env.release(slot, m).unwrap_err()),
        dcode(E::NoReceipt)
    );
    assert_eq!(env.table().ring.used(), 1);
    env.set_time(env.now + block_puzzle::RELEASE_DELAY_SECS);
    let ixn = ix(
        block_puzzle::ID,
        block_puzzle::accounts::Release {
            caller: a(env.oracle.pubkey()),
            table: env.table,
            receipt: env.alice.account,
            match_state: m,
        },
        block_puzzle::instruction::ReleaseSlot { index: slot },
        vec![],
    );
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(E::NoReceipt)
    );
    env.release(slot, m).expect("freed with the receipt");
    assert_eq!(env.table().ring.used(), 0);
    assert_eq!(
        custom_code(&env.release(slot, m).unwrap_err()),
        dcode(E::BadSlot)
    );
}

#[test]
fn a_reserved_or_unknown_slot_cannot_be_released() {
    let mut env = ready();
    env.begin().unwrap();
    let m = env.tmatch;
    let slot = env.table().slot;
    assert_eq!(
        custom_code(&env.release(slot, m).unwrap_err()),
        dcode(E::BadSlot)
    );
    assert_eq!(
        custom_code(&env.release(200, m).unwrap_err()),
        dcode(E::BadSlot)
    );
}

#[test]
fn a_slot_whose_match_account_vanished_is_freed_after_fifteen_days_only() {
    let mut env = ready();
    env.play_out(4, 2);
    let slot = env.table().slot;
    let at = env.now;
    let ghost = APk::new_unique();
    env.patch_table(|t| t.ring.slots[slot as usize].match_key = ghost);
    let ixn = ix(
        block_puzzle::ID,
        block_puzzle::accounts::Release {
            caller: a(env.oracle.pubkey()),
            table: env.table,
            receipt: tpda(&[b"settled", ghost.as_ref()]),
            match_state: ghost,
        },
        block_puzzle::instruction::ReleaseSlot { index: slot },
        vec![],
    );
    assert_eq!(
        custom_code(&env.rollup(ixn.clone()).unwrap_err()),
        dcode(E::NoReceipt)
    );
    env.set_time(at + block_puzzle::STALE_SLOT_SECS);
    env.rollup(ixn).expect("freed after the long wait");
    assert_eq!(env.table().ring.used(), 0);
}

#[test]
fn a_live_match_cannot_be_reset_away() {
    let mut env = begun();
    env.set_time(env.now + 10_000);
    assert_eq!(custom_code(&env.reset().unwrap_err()), dcode(E::WrongPhase));
    env.begin().expect_err("and cannot be begun over");
}

#[test]
fn the_old_assignment_cannot_begin_again_after_its_epoch() {
    let mut env = Env::new();
    env.next_match_on(0);
    env.play_out(4, 2);
    env.commit_standin();
    next_epoch(&mut env);
    assert_eq!(
        custom_code(&env.begin().unwrap_err()),
        dcode(E::NotAssigned)
    );
}

#[test]
fn a_table_whose_match_core_already_refunded_is_voided_and_reset_without_a_result() {
    let mut env = begun();
    let m = env.tmatch;
    assert_eq!(custom_code(&env.void(m).unwrap_err()), dcode(E::NoReceipt));
    env.set_time(T0 + block_puzzle::TABLE_WINDOW_SECS + 1);
    core_refund(&mut env).expect("core refund");
    assert_eq!(custom_code(&env.void(m).unwrap_err()), dcode(E::NoReceipt));
    env.set_time(env.now + block_puzzle::RELEASE_DELAY_SECS);
    env.void(m).expect("void");
    let t = env.table();
    assert_eq!((t.phase, t.dirty), (block_puzzle::TABLE_CLOSED, false));
    assert!(!t.req_pending);
    assert_eq!(t.ring.used(), 0, "the reserved slot is freed");
    env.wipe_standin();
    env.set_time(env.now + block_puzzle::RESET_DELAY_SECS);
    env.reset().expect("reset after void");
    assert_eq!(env.table().epoch, 1);
}

#[test]
fn a_receipt_of_another_match_cannot_void_the_table() {
    let mut env = begun();
    env.set_time(T0 + block_puzzle::TABLE_WINDOW_SECS + 1);
    core_refund(&mut env).expect("core refund");
    env.set_time(env.now + block_puzzle::RELEASE_DELAY_SECS);
    let other = APk::new_unique();
    let ixn = ix(
        block_puzzle::ID,
        env.release_accounts(other),
        block_puzzle::instruction::VoidTable {},
        vec![],
    );
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(E::NoReceipt)
    );
    assert_eq!(env.table().phase, block_puzzle::TABLE_GET_READY);
}

#[test]
fn an_assignment_closes_only_after_the_core_receipt_and_returns_its_rent_to_the_payer() {
    let mut env = ready();
    let m = env.tmatch;
    let close = |env: &Env| {
        ix(
            block_puzzle::ID,
            block_puzzle::accounts::CloseAssignment {
                caller: a(env.oracle.pubkey()),
                assignment: assign_addr(m),
                payer: a(env.operator.pubkey()),
                receipt: tpda(&[b"settled", m.as_ref()]),
                match_state: m,
            },
            block_puzzle::instruction::CloseAssignment {},
            vec![],
        )
    };
    let caller = env.oracle.insecure_clone();
    let ixn = close(&env);
    assert_eq!(
        custom_code(&env.send(&[ixn], &caller, &[]).unwrap_err()),
        dcode(E::NoReceipt)
    );
    env.play_out(4, 2);
    env.commit_standin();
    env.finalize().expect("settle");
    let before = env.svm.get_balance(&s(a(env.operator.pubkey()))).unwrap();
    let ixn = close(&env);
    env.send(&[ixn], &caller, &[]).expect("close");
    assert!(env.svm.get_account(&s(assign_addr(m))).is_none());
    assert!(env.svm.get_balance(&s(a(env.operator.pubkey()))).unwrap() > before);
}

// --- Commits ------------------------------------------------------------------------------------

#[test]
fn the_result_is_committed_once_and_the_sponsor_cannot_be_drained_by_repeats() {
    let mut env = begun();
    env.magic_shell();
    let ixn = env.commit_ix();
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(E::NotDirty)
    );
    env.set_slot(env.table().play_end().unwrap() + 1);
    env.close().unwrap();
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
        dcode(E::NotDirty),
        "once per result"
    );
    env.patch_table(|t| t.dirty = true);
    let mut bad = env.commit_ix();
    let idx = bad
        .accounts
        .iter()
        .position(|m| m.pubkey == s(table_kit::fee_vault_address(&block_puzzle::TEE_VALIDATOR)))
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
    let env = begun();
    let ixn = env.commit_ix();
    let mine: Vec<_> = ixn
        .accounts
        .iter()
        .map(|m| APk::new_from_array(m.pubkey.to_bytes()))
        .collect();
    for seat in 0..2u8 {
        assert!(!mine.contains(&board_addr(env.table, seat)));
        assert!(!mine.contains(&perm_addr(board_addr(env.table, seat))));
    }
    assert!(!mine.contains(&vault_addr(env.table)));
    assert!(!mine.contains(&perm_addr(vault_addr(env.table))));
    assert!(mine.contains(&env.table));
}

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
    let mut env = ready();
    env.magic_shell();
    env.play_out(8, 3);
    env.commit_lost_standin();
    // Base still has the table from before the Match: nothing to settle from.
    assert_eq!(
        custom_code(&env.finalize_start().unwrap_err()),
        dcode(E::NoResult)
    );
    let before = bytes_of(&env.table());
    let ixn = env.commit_ix();
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(E::NotDirty)
    );
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
    let before_gemas = env.gemas(&env.alice);
    env.finalize().expect("settle from the repeated commit");
    assert_eq!(env.gemas(&env.alice), before_gemas + 1_900);
}

#[test]
fn a_lost_commit_survives_the_reset_and_repeated_calls_cost_nothing_once_freed() {
    let mut env = Env::new();
    env.magic_shell();
    env.next_match_on(0);
    env.play_out(8, 3);
    env.commit_lost_standin();
    next_epoch(&mut env);
    let t = env.table();
    assert_eq!(t.epoch, 1);
    assert_eq!(t.ring.used(), 1);
    assert_eq!(t.commit.tries, 1, "the guard survives the reset");
    env.set_time(env.now + table_kit::COMMIT_RETRY_SECS);
    let ixn = env.commit_ix();
    let err = env.rollup(ixn).unwrap_err();
    assert!(!err.meta.logs.iter().any(|l| l.contains("NotDirty")));
    // Settled and freed: nothing left to repeat.
    env.commit_standin();
    let m = env.mref.unwrap();
    env.table = table_addr(0, 0);
    env.use_match(m, env.table);
    env.finalize().expect("settle");
    env.set_time(env.now + block_puzzle::RELEASE_DELAY_SECS);
    let slot = env.table().ring.find(&m.key, 0).unwrap().0;
    env.release(slot, m.key).expect("freed");
    let sponsor = env.svm.get_balance(&s(sponsor_addr())).unwrap();
    let before = bytes_of(&env.table());
    for _ in 0..5 {
        env.set_time(env.now + table_kit::COMMIT_RETRY_MAX_SECS);
        let ixn = env.commit_ix();
        assert_eq!(
            custom_code(&env.rollup(ixn).unwrap_err()),
            dcode(E::NotDirty)
        );
    }
    assert_eq!(bytes_of(&env.table()), before);
    assert_eq!(env.svm.get_balance(&s(sponsor_addr())).unwrap(), sponsor);
}

#[test]
fn the_sponsor_is_refilled_from_a_fuel_reserve_by_the_operator_only() {
    let mut env = Env::new();
    let op = env.operator_kp();
    let fuel = dpda(&[block_puzzle::FUEL_SEED, &[0]]);
    let create = ix(
        block_puzzle::ID,
        block_puzzle::accounts::CreateFuel {
            operator: a(op.pubkey()),
            config: config_addr(),
            fuel,
            system_program: anchor_lang::system_program::ID,
        },
        block_puzzle::instruction::CreateFuel {
            n: 0,
            lamports: 5 * SOL,
        },
        vec![],
    );
    env.send(&[create], &op, &[]).expect("create fuel");
    let refill = |signer: APk, amount: u64| {
        ix(
            block_puzzle::ID,
            block_puzzle::accounts::RefillSponsor {
                operator: signer,
                config: config_addr(),
                fuel,
                sponsor: sponsor_addr(),
            },
            block_puzzle::instruction::RefillSponsor { amount },
            vec![],
        )
    };
    let stranger = env.admin.insecure_clone();
    let ixn = refill(a(stranger.pubkey()), SOL);
    assert_eq!(
        custom_code(&env.send(&[ixn], &stranger, &[]).unwrap_err()),
        dcode(E::NotOperator)
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

// --- Delegation ---------------------------------------------------------------------------------

#[test]
fn delegation_is_pinned_to_the_tee_validator() {
    let mut env = Env::new();
    let dlpk = dlp();
    let derive = |seeds: &[&[u8]], program: &APk| APk::find_program_address(seeds, program).0;
    let buffer = |k: APk| derive(&[b"buffer", k.as_ref()], &block_puzzle::ID);
    let record = |k: APk| derive(&[b"delegation", k.as_ref()], &dlpk);
    let meta = |k: APk| derive(&[b"delegation-metadata", k.as_ref()], &dlpk);
    let table = table_addr(0, 0);
    let op = env.operator_kp();
    for validator in [Some(a(env.admin.pubkey())), None] {
        let delegate = ix(
            block_puzzle::ID,
            block_puzzle::accounts::DelegateTable {
                operator: a(op.pubkey()),
                config: config_addr(),
                buffer_table: buffer(table),
                delegation_record_table: record(table),
                delegation_metadata_table: meta(table),
                table,
                validator,
                owner_program: block_puzzle::ID,
                delegation_program: dlpk,
                system_program: anchor_lang::system_program::ID,
            },
            block_puzzle::instruction::DelegateTable {
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
        block_puzzle::ID,
        block_puzzle::accounts::DelegateTable {
            operator: a(stranger.pubkey()),
            config: config_addr(),
            buffer_table: buffer(table),
            delegation_record_table: record(table),
            delegation_metadata_table: meta(table),
            table,
            validator: Some(block_puzzle::TEE_VALIDATOR),
            owner_program: block_puzzle::ID,
            delegation_program: dlpk,
            system_program: anchor_lang::system_program::ID,
        },
        block_puzzle::instruction::DelegateTable {
            generation: 0,
            index: 0,
        },
        vec![],
    );
    let err = env.send(&[delegate], &stranger, &[]).unwrap_err();
    assert_eq!(custom_code(&err), dcode(E::NotOperator));
}

// --- Seats and permissions ------------------------------------------------------------------

/// The accounts the four permission-changing instructions take.
fn seat_ix(env: &Env, which: &str, signer: APk) -> Instruction {
    let t = env.table;
    let (b0, b1, v) = (board_addr(t, 0), board_addr(t, 1), vault_addr(t));
    let (p0, p1, pv) = (perm_addr(b0), perm_addr(b1), perm_addr(v));
    let permission_program = sdk_key(PERMISSION_PROGRAM_ID);
    let ephemeral_vault = sdk_key(ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID);
    let magic_program = sdk_key(MAGIC_PROGRAM_ID);
    match which {
        "init" => ix(
            block_puzzle::ID,
            block_puzzle::accounts::InitSeats {
                caller: signer,
                table: t,
                board_0: b0,
                board_1: b1,
                seed_vault: v,
                board_0_permission: p0,
                board_1_permission: p1,
                seed_vault_permission: pv,
                permission_program,
                ephemeral_vault,
                magic_program,
            },
            block_puzzle::instruction::InitSeats {},
            vec![],
        ),
        "seat" => ix(
            block_puzzle::ID,
            block_puzzle::accounts::SeatPlayers {
                caller: signer,
                table: t,
                board_0: b0,
                board_1: b1,
                seed_vault: v,
                board_0_permission: p0,
                board_1_permission: p1,
                permission_program,
                ephemeral_vault,
                magic_program,
            },
            block_puzzle::instruction::SeatPlayers {},
            vec![],
        ),
        "wipe" => ix(
            block_puzzle::ID,
            block_puzzle::accounts::WipeSeats {
                caller: signer,
                table: t,
                board_0: b0,
                board_1: b1,
                seed_vault: v,
                board_0_permission: p0,
                board_1_permission: p1,
                permission_program,
                ephemeral_vault,
                magic_program,
            },
            block_puzzle::instruction::WipeSeats {},
            vec![],
        ),
        _ => ix(
            block_puzzle::ID,
            block_puzzle::accounts::RetireSeats {
                operator: signer,
                config: config_addr(),
                table: t,
                board_0: b0,
                board_1: b1,
                seed_vault: v,
                board_0_permission: p0,
                board_1_permission: p1,
                seed_vault_permission: pv,
                permission_program,
                ephemeral_vault,
                magic_program,
            },
            block_puzzle::instruction::RetireSeats {},
            vec![],
        ),
    }
}

#[test]
fn no_instruction_a_player_calls_can_reach_the_permission_program() {
    // The IDL says which instructions take the permission program. Only the table's own state
    // machine steps do, and none of them is a Player's move.
    let idl = idl();
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
    // No instruction a Player signs takes it, and none of those can write a Vault or reach a
    // permission account either.
    for name in ["check_in", "begin", "play", "play_hidden"] {
        assert!(!reaching.iter().any(|r| r == name));
        let ix = idl["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["name"] == name)
            .unwrap();
        for acc in ix["accounts"].as_array().unwrap() {
            let n = acc["name"].as_str().unwrap();
            assert!(!n.contains("permission"), "{name} takes {n}");
            if n == "seed_vault" {
                assert!(
                    !acc["writable"].as_bool().unwrap_or(false),
                    "{name} writes the Vault"
                );
            }
        }
    }
}

#[test]
fn seats_are_made_once_and_handed_on_only_between_matches() {
    let mut env = begun();
    let caller = env.oracle.insecure_clone();
    // Already made.
    let ixn = seat_ix(&env, "init", a(caller.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(E::SeatsOpen)
    );
    // A live Match's seats cannot be handed to anyone or wiped, by anyone.
    for which in ["seat", "wipe"] {
        let ixn = seat_ix(&env, which, a(caller.pubkey()));
        assert_eq!(
            custom_code(&env.rollup(ixn).unwrap_err()),
            dcode(E::WrongPhase),
            "{which}"
        );
    }
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
        dcode(E::WrongPhase)
    );
    let ixn = seat_ix(&env, "retire", a(caller.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(E::NotOperator)
    );
}

#[test]
fn seats_are_handed_over_only_when_blank_and_wiped_only_when_the_match_is_over() {
    let mut env = ready();
    let caller = env.oracle.insecure_clone();
    // An idle table has no Match to seat.
    let ixn = seat_ix(&env, "seat", a(caller.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(E::WrongPhase)
    );
    env.begin().unwrap();
    // A seat that still holds data, or a Vault that still holds a Seed, is not handed on.
    env.patch_board(0, |b| b.seed = 9);
    let ixn = seat_ix(&env, "seat", a(caller.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn.clone()).unwrap_err()),
        dcode(E::SeatNotBlank)
    );
    env.patch_board(0, |b| b.wipe());
    env.patch_vault(|v| v.seed = 4);
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(E::SeatNotBlank)
    );
    env.patch_vault(|v| v.wipe());
    // Open seats are not handed again.
    env.seat_players_standin();
    let ixn = seat_ix(&env, "seat", a(caller.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(E::SeatsOpen)
    );
    // Waiting is not over.
    let ixn = seat_ix(&env, "wipe", a(caller.pubkey()));
    assert_eq!(
        custom_code(&env.rollup(ixn).unwrap_err()),
        dcode(E::WrongPhase)
    );
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

#[test]
fn the_old_per_match_machinery_is_gone() {
    let source = include_str!("../src/lib.rs");
    for needle in [
        "open_session",
        "join_session",
        "delegate_opener",
        "delegate_joiner",
        "commit_boards",
        "claim_timeout",
        "extend_match_deadline(\n                CpiContext::new_with_signer(\n                    ctx.accounts.tesoro_core_program",
    ] {
        assert!(!source.contains(needle), "{needle} is still in the program");
    }
    let idl = idl();
    let names: Vec<&str> = idl["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap())
        .collect();
    for gone in [
        "open_session",
        "join_session",
        "delegate_opener",
        "delegate_joiner",
        "commit_boards",
        "claim_timeout",
        "finish",
        "seal",
        "settle",
    ] {
        assert!(!names.contains(&gone), "{gone} is still an instruction");
    }
}

#[test]
fn a_rollup_that_halts_after_the_window_does_not_turn_a_decided_match_into_a_refund() {
    // The run is fine; nobody closes for three minutes and the wall clock runs on while the rollup
    // is down. Only a prompt close judges the aggregate rate.
    let mut env = ready();
    env.begun();
    env.set_slot(env.table().start_slot + SPS);
    env.play(0, 4).unwrap();
    let end = env.table().play_end().unwrap();
    let ts = env.table().ready_ts + 300;
    env.set_clock(end + block_puzzle::CLOSE_GRACE_SLOTS + 1, ts);
    env.close().expect("close");
    assert_eq!(
        outcome_of(&env),
        (OUTCOME_WIN0, block_puzzle::REASON_PLAYED)
    );
    // The same gap with a close inside the grace is a stall.
    let mut env = Env::new();
    env.next_match_on(0);
    env.begun();
    env.set_slot(env.table().start_slot + SPS);
    env.play(0, 4).unwrap();
    let end = env.table().play_end().unwrap();
    env.set_clock(end + 1, env.table().ready_ts + 300);
    env.close().expect("close");
    assert_eq!(outcome_of(&env), (OUTCOME_DRAW, block_puzzle::REASON_VOID));
}

// --- Fast refunds (ticket 35) ----------------------------------------------------------------

impl Env {
    fn refund_untabled_ix(&self, caller: APk) -> Instruction {
        ix(
            block_puzzle::ID,
            block_puzzle::accounts::RefundUntabled {
                caller,
                assignment: assign_addr(self.tmatch),
                tesoro_match: self.tmatch,
                game_record: game_record_pda(),
                authority: authority_pda(),
                game_program: block_puzzle::ID,
                program_data: program_data_pda(),
                receipt: tpda(&[b"settled", self.tmatch.as_ref()]),
                system_program: anchor_lang::system_program::ID,
                core_event_authority: tpda(&[b"__event_authority"]),
                event_authority: dpda(&[b"__event_authority"]),
                program: block_puzzle::ID,
                tesoro_program: tesoro_core::ID,
            },
            block_puzzle::instruction::RefundUntabled {},
            vec![],
        )
    }

    fn refund_untabled(&mut self) -> Result<(), Failed> {
        let caller = self.oracle.insecure_clone();
        let ixn = self.refund_untabled_ix(a(caller.pubkey()));
        self.send(&[ixn], &caller, &[])?;
        self.run_settlement();
        Ok(())
    }

    fn skip_ix(&self) -> Instruction {
        ix(
            block_puzzle::ID,
            block_puzzle::accounts::SkipEpoch {
                caller: a(self.oracle.pubkey()),
                assignment: assign_addr(self.tmatch),
                table: self.table,
            },
            block_puzzle::instruction::SkipEpoch {},
            vec![],
        )
    }

    fn skip(&mut self) -> Result<(), Failed> {
        let ixn = self.skip_ix();
        self.rollup(ixn)
    }
}

#[test]
fn a_joined_match_with_no_table_refunds_after_the_table_wait_and_not_before() {
    use block_puzzle::BlockPuzzleError::*;
    let mut env = Env::new();
    env.open_and_join(1_000);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.set_time(T0 + table_kit::TABLE_WAIT_SECS - 1);
    assert_eq!(
        custom_code(&env.refund_untabled().unwrap_err()),
        dcode(TableWaitNotOver)
    );
    assert_eq!(env.tesoro_status(), Stage::Active);
    env.set_time(T0 + table_kit::TABLE_WAIT_SECS);
    env.refund_untabled().expect("refund after the wait");
    assert_eq!(env.tesoro_status(), Stage::Closed);
    assert_eq!(
        (env.gemas(&env.alice), env.gemas(&env.bob)),
        (before.0 + 1_000, before.1 + 1_000)
    );
    // No double refund: the Match is no longer Active.
    assert_eq!(
        custom_code(&env.refund_untabled().unwrap_err()),
        dcode(NotUntabled)
    );
}

#[test]
fn a_match_a_table_took_cannot_use_the_untabled_refund() {
    use block_puzzle::BlockPuzzleError::*;
    // Assigned, and the wait long past: the Assignment closes the path.
    let mut env = Env::new();
    env.next_match_on(0);
    env.set_time(T0 + 10 * table_kit::TABLE_WAIT_SECS);
    assert_eq!(
        custom_code(&env.refund_untabled().unwrap_err()),
        dcode(NotUntabled)
    );
    assert_eq!(env.tesoro_status(), Stage::Active);
    // Started on the table: still refused.
    let mut env = Env::new();
    env.next_match_on(0);
    env.begin().expect("begin");
    env.set_time(T0 + 10 * table_kit::TABLE_WAIT_SECS);
    assert_eq!(
        custom_code(&env.refund_untabled().unwrap_err()),
        dcode(NotUntabled)
    );
}

#[test]
fn a_lamport_sent_to_the_assignment_address_does_not_block_the_untabled_refund() {
    let mut env = Env::new();
    env.open_and_join(1_000);
    env.svm
        .set_account(
            s(assign_addr(env.tmatch)),
            Account {
                lamports: 1,
                data: vec![],
                owner: Pk::default(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("one lamport");
    env.set_time(T0 + table_kit::TABLE_WAIT_SECS);
    env.refund_untabled().expect("refund");
    assert_eq!(env.tesoro_status(), Stage::Closed);
}

#[test]
fn a_match_that_never_began_is_refunded_promptly_by_skipping_its_epoch() {
    use block_puzzle::BlockPuzzleError::*;
    let mut env = Env::new();
    env.next_match_on(0);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    // The start window is still open: the Match may yet begin.
    assert_eq!(custom_code(&env.skip().unwrap_err()), dcode(CannotSkip));
    env.set_time(T0 + block_puzzle::START_WINDOW_SECS + 1);
    env.skip().expect("skip");
    let t = env.table();
    assert_eq!((t.phase, t.epoch), (block_puzzle::TABLE_IDLE, 0));
    assert!(t.dirty);
    let (_, slot) = t.ring.find(&env.tmatch, 0).expect("slot");
    assert_eq!(
        (slot.state, slot.outcome),
        (table_kit::SLOT_DONE, table_kit::OUTCOME_DRAW)
    );
    // Nothing is refunded until the commit lands on base.
    assert_eq!(
        custom_code(&env.finalize_start().unwrap_err()),
        dcode(NoResult)
    );
    env.commit_standin();
    env.finalize().expect("refund from the committed Draw");
    assert_eq!(
        (env.gemas(&env.alice), env.gemas(&env.bob)),
        (before.0 + 1_000, before.1 + 1_000)
    );
    // Once per Match, and once settled it cannot be refunded again.
    assert_eq!(custom_code(&env.skip().unwrap_err()), dcode(RingFull));
    assert!(env.finalize_start().is_err());
}

#[test]
fn skip_refuses_a_table_that_began_or_names_another_epoch() {
    use block_puzzle::BlockPuzzleError::*;
    let mut env = Env::new();
    env.next_match_on(0);
    env.begin().expect("begin");
    env.set_time(T0 + block_puzzle::START_WINDOW_SECS + 1);
    assert_eq!(custom_code(&env.skip().unwrap_err()), dcode(CannotSkip));
}

#[test]
fn a_skipped_epoch_can_still_start_another_match_assigned_to_it() {
    let mut env = Env::new();
    env.next_match_on(0);
    env.set_time(T0 + block_puzzle::START_WINDOW_SECS + 1);
    env.skip().expect("skip the first");
    assert_eq!(env.table().epoch, 0, "the epoch is untouched");
    env.next_match_on(0);
    env.begin()
        .expect("a later Assignment still begins on the skipped epoch");
    assert_ne!(env.table().phase, block_puzzle::TABLE_IDLE);
}

// ---- ticket 43: the hidden beat ----------------------------------------------------------------

/// Both Players play their runs to the end before the freeze (public plays, inside the pace).
fn both_runs_over_before_the_freeze(env: &mut Env) {
    let mut at = env.table().start_slot;
    for seat in 0..2 {
        let mut guard = 0;
        while !env.board(seat).over {
            guard += 1;
            assert!(guard < 100, "the game does not end");
            at += SPS;
            env.set_slot(at);
            env.play(seat, 4).unwrap();
        }
    }
}

fn beat(env: &mut Env, seat: usize, expected: u16, n: u8, moves: &[MoveArg]) -> Result<(), Failed> {
    let (kp, key) = env.person_of(seat);
    let binding = env.binding();
    let ixn = ix(
        block_puzzle::ID,
        block_puzzle::accounts::PlayHidden {
            player: key,
            table: env.table,
            board: board_addr(env.table, seat as u8),
        },
        hidden_args(binding, expected, n, moves),
        vec![],
    );
    env.send(&[ixn], &kp, &[])
}

#[test]
fn an_empty_hidden_beat_changes_nothing_public_and_only_the_freeze_opens_it() {
    let mut env = begun();
    let start = env.table().start_slot;
    env.set_slot(start + 79 * SPS);
    assert_eq!(
        custom_code(&beat(&mut env, 0, 0, 0, &[]).unwrap_err()),
        dcode(E::NotFrozen),
        "an empty beat is no way around the freeze rule"
    );
    let freeze = env.table().freeze_slot().unwrap();
    env.set_slot(freeze + 30);
    let table_before = env.svm.get_account(&s(env.table)).unwrap();
    let board_before = env.board(0);
    beat(&mut env, 0, 0, 0, &[]).expect("empty beat");
    beat(&mut env, 1, 0, 1, &[]).expect("empty beat, other Player");
    let table_after = env.svm.get_account(&s(env.table)).unwrap();
    assert_eq!(table_before.data, table_after.data);
    assert_eq!(table_before.lamports, table_after.lamports);
    let board_after = env.board(0);
    assert_eq!(board_after.moves, board_before.moves);
    assert_eq!(board_after.score, board_before.score);
    assert_eq!(
        board_after.last_slot,
        freeze + 30,
        "the beat is liveness evidence"
    );
}

#[test]
fn every_hidden_beat_has_the_same_size_and_the_same_accounts() {
    let mut env = begun();
    let freeze = env.table().freeze_slot().unwrap();
    env.set_slot(freeze + 30);
    let binding = env.binding();
    let moves = env.moves(0, 5);
    let (_, key) = env.person_of(0);
    let mk = |m: &[MoveArg], n: u8| {
        ix(
            block_puzzle::ID,
            block_puzzle::accounts::PlayHidden {
                player: key,
                table: env.table,
                board: board_addr(env.table, 0),
            },
            hidden_args(binding, 0, n, m),
            vec![],
        )
    };
    let (empty, full) = (mk(&[], 0), mk(&moves, 1));
    assert_eq!(empty.data.len(), full.data.len(), "args are padded");
    assert_eq!(empty.accounts, full.accounts);
    assert_ne!(
        empty.data,
        mk(&[], 1).data,
        "the beat number makes bytes unique"
    );
}

#[test]
fn a_resent_beat_is_skipped_not_refused_and_gaps_or_overruns_are() {
    let mut env = begun();
    let freeze = env.table().freeze_slot().unwrap();
    env.set_slot(freeze + 30);
    let m = env.moves(0, 4);
    beat(&mut env, 0, 0, 0, &m[..3]).expect("three moves");
    assert_eq!(env.board(0).moves, 3);
    // The same beat again (the first outcome was unknown): nothing is applied twice.
    beat(&mut env, 0, 0, 1, &m[..3]).expect("resend");
    assert_eq!(env.board(0).moves, 3);
    // A resend that also carries a new move applies only the new one.
    beat(&mut env, 0, 0, 2, &m[..4]).expect("resend plus one");
    assert_eq!(env.board(0).moves, 4);
    // A count ahead of the Board is refused.
    assert_eq!(
        custom_code(&beat(&mut env, 0, 5, 3, &[]).unwrap_err()),
        dcode(E::WrongCount)
    );
    // A beat that lands late, shorter than what the Board already holds past its count, is wholly
    // held already: it succeeds and changes nothing, so a reordered beat never leaves a failed
    // transaction that only Players with moves could cause.
    beat(&mut env, 0, 1, 4, &m[..2]).expect("late beat, all held");
    beat(&mut env, 0, 0, 5, &[]).expect("late empty beat");
    assert_eq!(env.board(0).moves, 4);
}

#[test]
fn the_public_play_still_refuses_an_empty_batch_and_hidden_beats_keep_the_pace() {
    let mut env = begun();
    let start = env.table().start_slot;
    env.set_slot(start + 10 * SPS);
    let (binding, expected) = (env.binding(), 0);
    assert_eq!(
        custom_code(
            &env.play_with(0, binding, expected, vec![], false)
                .unwrap_err()
        ),
        dcode(E::BadBatch)
    );
    // Stockpiled moves are refused in a hidden beat just as in the public play.
    let freeze = env.table().freeze_slot().unwrap();
    env.set_slot(freeze);
    let m = env.moves(0, 8);
    assert!(u64::from(8u8) * SPS <= 4 * (freeze - start) + 6 * SPS);
    beat(&mut env, 0, 0, 0, &m).expect("eight moves are well inside the pace at 80 s");
}

#[test]
fn a_finished_run_keeps_answering_the_beat_and_the_match_waits_for_the_clock_after_the_freeze() {
    let mut env = begun();
    both_runs_over_before_the_freeze(&mut env);
    let freeze = env.table().freeze_slot().unwrap();
    env.set_slot(freeze + 30);
    let (c0, c1) = (env.board(0).moves, env.board(1).moves);
    beat(&mut env, 0, c0, 0, &[]).expect("empty beat on a finished run");
    let extra = vec![MoveArg {
        piece: 0,
        x: 0,
        y: 0,
    }];
    assert_eq!(
        custom_code(&beat(&mut env, 1, c1, 1, &extra).unwrap_err()),
        dcode(E::RunOver),
        "a finished run takes no moves"
    );
    // Both runs are over, yet from the freeze the close does not come early: when it happens
    // would tell the opponent when the last run ended.
    assert_eq!(
        custom_code(&env.close().unwrap_err()),
        dcode(E::NotClosable)
    );
    env.set_slot(env.table().play_end().unwrap() + 1);
    env.close().expect("close at the end of the window");
}

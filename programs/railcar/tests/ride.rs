//! LiteSVM: the real railcar and tesoro_core programs (`pnpm build:programs` first), driven the
//! way Players' pages drive a ride: board through core, `check_departure`, `start_ride`, the VRF
//! callback, signals and Jumps, `finalize`, then core's chunks. Checks what Accounts end up
//! holding, the public Table and what is refused.
//!
//! LiteSVM has no delegation, permission, ephemeral-account or VRF programs. A stub accepting
//! any instruction stands at the magic, permission and VRF program addresses (so the commit and
//! the VRF request run to their end), the Vault is written as `init_vault` would create it, and
//! base's view of a delegated Table is the bytes the last commit sent, owned by the delegation
//! program (as Block Burst's table tests do).
#![allow(clippy::result_large_err)]
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{
    AccountDeserialize, AccountSerialize, Discriminator, InstructionData, ToAccountMetas,
};
use litesvm::LiteSVM;
use railcar::state::{
    Table, Vault, AUTHORITY_SEED, COUNTDOWN_SECS, OUTCOME_PLACED, OUTCOME_REFUND, PHASE_DRAWING,
    PHASE_OVER, PHASE_RIDING, SPONSOR_SEED,
};
use solana_sdk::account::Account;
use solana_sdk::clock::Clock;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use std::collections::HashMap;
use tesoro_core::ledger::draw::PotPages;
use tesoro_core::ledger::many_seat::{ManyStage, Seat, SeatState, SEATS_PER_PAGE};
use tesoro_core::state::*;
use tesoro_core::storage::*;

#[path = "../../tesoro_core/tests/common/flow.rs"]
mod flow;

type Failed = litesvm::types::FailedTransactionMetadata;

const SOL: u64 = 1_000_000_000;
const T0: i64 = 1_000_000;
/// The rollup slot at `T0`; slots follow the clock at the healthy rate.
const SLOT0: u64 = 5_000_000;
const SPS: u64 = railcar::state::SLOTS_PER_SEC;

fn a(p: Pk) -> APk {
    APk::new_from_array(p.to_bytes())
}
fn s(p: APk) -> Pk {
    Pk::new_from_array(p.to_bytes())
}
fn tpda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &tesoro_core::ID).0
}
fn rpda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &railcar::ID).0
}
fn sdk_key(p: ephemeral_rollups_sdk::compat::Pubkey) -> APk {
    APk::new_from_array(p.to_bytes())
}
fn program_data() -> APk {
    flow::program_data(railcar::ID)
}
fn game_record() -> APk {
    flow::game_record(railcar::ID)
}
fn authority() -> APk {
    rpda(&[AUTHORITY_SEED])
}
fn config_addr() -> APk {
    rpda(&[railcar::state::CONFIG_SEED])
}
fn sponsor_addr() -> APk {
    rpda(&[SPONSOR_SEED])
}
fn vault_addr(table: APk) -> APk {
    railcar::vault_address(&table).0
}
fn receipt(m: APk) -> APk {
    tpda(&[b"settled", m.as_ref()])
}
fn page_pda(m: APk, page: u8) -> APk {
    tpda(&[SEAT_PAGE_SEED, m.as_ref(), &[page]])
}
fn mark_pda(m: APk, account: APk) -> APk {
    tpda(&[SEAT_SEED, m.as_ref(), account.as_ref()])
}
fn dlp() -> APk {
    sdk_key(ephemeral_rollups_sdk::id())
}

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

fn code(err: &Failed) -> u32 {
    use solana_sdk::instruction::InstructionError;
    use solana_sdk::transaction::TransactionError;
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => *c,
        other => panic!("unexpected error {other:?}\n{:#?}", err.meta.logs),
    }
}

fn rcode(e: railcar::RailcarError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

/// Makes `key` the upgrade authority of the program loaded into `svm` and returns the hash
/// tesoro_core approves: SHA-256 of the executable without trailing zeros.
fn control_program(svm: &mut LiteSVM, key: APk) -> [u8; 32] {
    let pd = s(program_data());
    let mut acct = svm.get_account(&pd).expect("program data");
    acct.data[12] = 1;
    acct.data[13..45].copy_from_slice(key.as_ref());
    let code = &acct.data[45..];
    let end = code.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
    let hash = solana_sdk::hash::hash(&code[..end]).to_bytes();
    svm.set_account(pd, acct).expect("set program data");
    hash
}

/// tesoro_core's Treasury with no Yield Fee: Advances are sized without it here.
fn put_core_treasury(svm: &mut LiteSVM) {
    let (key, bump) = APk::find_program_address(&[TREASURY_SEED], &tesoro_core::ID);
    let treasury = Treasury {
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
    treasury.try_serialize(&mut data).expect("serialize");
    svm.set_account(
        s(key),
        Account {
            lamports: SOL,
            data,
            owner: s(tesoro_core::ID),
            executable: false,
            rent_epoch: 0,
        },
    )
    .expect("treasury");
}

fn book_metas(svm: &LiteSVM, source: APk) -> Vec<AccountMeta> {
    let mut v = vec![AccountMeta::new(s(book_address(&source).0), false)];
    for class in 0..15u8 {
        for page_no in 0..4u32 {
            let k = ckpt_address(&source, class, page_no).0;
            if svm.get_account(&s(k)).is_some() {
                v.push(AccountMeta::new(s(k), false));
            }
        }
    }
    v
}

struct Person {
    kp: Keypair,
    key: APk,
    account: APk,
    source: APk,
}

fn dup(p: &Person) -> Person {
    Person {
        kp: p.kp.insecure_clone(),
        key: p.key,
        account: p.account,
        source: p.source,
    }
}

/// A car as the tests hold it.
#[derive(Clone, Copy, Debug)]
struct Car {
    no: u64,
    key: APk,
    tesoro: APk,
    table: APk,
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    oracle: Keypair,
    ctl: Keypair,
    operator: Keypair,
    studio: Person,
    /// What base last saw of each Table (the committed bytes).
    committed: HashMap<APk, Vec<u8>>,
    stakes: u8,
    now: i64,
    slot: u64,
    last_cu: u64,
    last_logs: Vec<String>,
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
        let r = self.svm.send_transaction(tx);
        self.finish(r)
    }

    fn finish(&mut self, r: litesvm::types::TransactionResult) -> Result<(), Failed> {
        match r {
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

    /// A v0 transaction whose lookup table holds every non-signer account.
    fn send_v0(&mut self, ixs: &[Instruction], payer: &Keypair) -> Result<(), Failed> {
        use solana_sdk::message::{v0, AddressLookupTableAccount, VersionedMessage};
        use solana_sdk::transaction::VersionedTransaction;
        let table: Vec<Pk> = ixs
            .iter()
            .flat_map(|i| i.accounts.iter())
            .filter(|m| !m.is_signer)
            .map(|m| m.pubkey)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let alt_key = Pk::new_unique();
        let mut data = vec![0u8; 56];
        data[0..4].copy_from_slice(&1u32.to_le_bytes());
        data[4..12].copy_from_slice(&u64::MAX.to_le_bytes());
        for k in &table {
            data.extend_from_slice(k.as_ref());
        }
        self.svm
            .set_account(
                alt_key,
                Account {
                    lamports: 10 * SOL,
                    data,
                    owner: "AddressLookupTab1e1111111111111111111111111"
                        .parse()
                        .expect("alt program"),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("lookup table");
        self.svm.expire_blockhash();
        let alt = AddressLookupTableAccount {
            key: alt_key,
            addresses: table,
        };
        let msg =
            v0::Message::try_compile(&payer.pubkey(), ixs, &[alt], self.svm.latest_blockhash())
                .expect("compile v0");
        let tx =
            VersionedTransaction::try_new(VersionedMessage::V0(msg), &[payer]).expect("sign v0");
        let r = self.svm.send_transaction(tx);
        self.finish(r)
    }

    /// Wall-clock time; the rollup slot follows at the healthy rate.
    fn set_time(&mut self, t: i64) {
        self.set_clock(SLOT0 + (t - T0).max(0) as u64 * SPS, t);
    }

    /// An exact rollup slot; the clock follows.
    fn set_slot(&mut self, slot: u64) {
        self.set_clock(slot, T0 + ((slot - SLOT0) / SPS) as i64);
    }

    fn set_clock(&mut self, slot: u64, ts: i64) {
        self.now = ts;
        self.slot = slot;
        self.svm.set_sysvar(&Clock {
            slot,
            unix_timestamp: ts,
            ..Clock::default()
        });
    }

    fn load<T: AccountDeserialize>(&self, k: APk) -> T {
        flow::load(&self.svm, k)
    }

    fn put<T: AccountSerialize>(&mut self, k: APk, value: &T, owner: APk) {
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

    /// A Player with a Tesoro Account and 75,000 Gemas of a Source of their own.
    fn rider(&mut self) -> Person {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 100 * SOL).expect("airdrop");
        let key = a(kp.pubkey());
        let account = flow::account_of(key);
        let create = ix(
            tesoro_core::ID,
            tesoro_core::accounts::CreateAccount {
                authority: key,
                account,
                basket: basket_address(&account).0,
                spill: spill_address(&account).0,
                invite_gate: invite_gate_pda(),
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
        let mut p = Person {
            kp,
            key,
            account,
            source: APk::default(),
        };
        p.source = self.stake(&p);
        flow::ensure_spill(&mut self.svm, &p.kp, account, 24);
        p
    }

    /// Position + Advance: 75,000 Gemas of the staker's own Source.
    fn stake(&mut self, p: &Person) -> APk {
        self.stakes = self.stakes.checked_add(1).expect("fewer than 255 stakes");
        let id = [self.stakes; 32];
        let position = tpda(&[POSITION_SEED, &[0], &id]);
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
                source_chain: tesoro_core::ledger::SourceChain::Solana,
                position_id: id,
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
                treasury: tpda(&[TREASURY_SEED]),
                owner_account: p.account,
                protections: tpda(&[PROTECTIONS_SEED, p.account.as_ref()]),
                position,
                source,
                book: book_address(&source).0,
                basket: basket_address(&p.account).0,
                spill: spill_address(&p.account).0,
                economy: tpda(&[ECONOMY_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::TakeAdvance {
                horizon_months: 6,
                price_micro_usd: 150_000_000,
                min_gemas: 1,
            },
            vec![AccountMeta::new_readonly(
                s(tpda(&[ONCHAIN_PRICE_SEED, asset.as_ref()])),
                false,
            )],
        );
        self.send(&[advance], &oracle, &[&p.kp]).expect("advance");
        source
    }

    /// Playable Gemas (own and won).
    fn gemas(&self, p: &Person) -> u64 {
        flow::gemas(&self.svm, p.account)
    }

    /// Fee-class Gemas (Studio Fee lines) in the Account's stores.
    fn fee_gemas(&self, p: &Person) -> u64 {
        [basket_address(&p.account).0, spill_address(&p.account).0]
            .into_iter()
            .map(|st| {
                let d = self.svm.get_account(&s(st)).expect("store").data;
                tesoro_core::ledger::line_store::LineStore::new(&d[DISC..])
                    .expect("store")
                    .fee_total()
            })
            .sum()
    }

    /// Core with a 2% Platform Fee and a 1% Leaderboard Fee; Railcar registered with its
    /// authority PDA, a 3% Studio Fee to an outside studio, and Listed; Railcar configured with
    /// `tables` Tables, a Sponsor, and every Table created, "delegated" and given its Vault.
    fn new(tables: u16) -> Self {
        let mut svm = LiteSVM::new().with_sigverify(false);
        litesvm_magic_stub::install(&mut svm);
        litesvm_magic_stub::install_at(
            &mut svm,
            s(sdk_key(ephemeral_rollups_sdk::vrf::consts::VRF_PROGRAM_ID)),
        );
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/");
        for (id, file) in [
            (tesoro_core::ID, "tesoro_core.so"),
            (railcar::ID, "railcar.so"),
        ] {
            let path = format!("{root}{file}");
            assert!(
                std::path::Path::new(&path).exists(),
                "build the programs first: pnpm build:programs"
            );
            svm.add_program_from_file(s(id), path)
                .expect("load program");
        }
        let placeholder = Person {
            kp: Keypair::new(),
            key: APk::default(),
            account: APk::default(),
            source: APk::default(),
        };
        let mut env = Self {
            svm,
            admin: Keypair::new(),
            oracle: Keypair::new(),
            ctl: Keypair::new(),
            operator: Keypair::new(),
            studio: placeholder,
            committed: HashMap::new(),
            stakes: 0,
            now: T0,
            slot: SLOT0,
            last_cu: 0,
            last_logs: vec![],
        };
        for k in [&env.admin, &env.oracle, &env.ctl, &env.operator] {
            env.svm.airdrop(&k.pubkey(), 1_000 * SOL).expect("airdrop");
        }
        env.set_time(T0);
        let platform = env.bare_person();
        env.studio = env.bare_person();
        let admin = env.admin.insecure_clone();
        let init = ix(
            tesoro_core::ID,
            tesoro_core::accounts::InitializeConfig {
                admin: a(admin.pubkey()),
                config: tpda(&[CONFIG_SEED]),
                platform_recipient: platform.account,
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::InitializeConfig {
                oracle_authority: a(env.oracle.pubkey()),
                platform_bps: 200,
            },
            vec![],
        );
        env.send(&[init], &admin, &[]).expect("init config");
        flow::set_economy(&mut env.svm, &admin);
        put_core_treasury(&mut env.svm);
        let leaderboard = ix(
            tesoro_core::ID,
            tesoro_core::accounts::InitLeaderboard {
                admin: a(admin.pubkey()),
                config: tpda(&[CONFIG_SEED]),
                pool_authority: tpda(&[LEADERBOARD_SEED]),
                pool_account: tpda(&[ACCOUNT_SEED, tpda(&[LEADERBOARD_SEED]).as_ref()]),
                treasury: tpda(&[TREASURY_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::InitLeaderboard {
                leaderboard_bps: 100,
            },
            vec![],
        );
        env.send(&[leaderboard], &admin, &[]).expect("leaderboard");
        let ctl = env.ctl.insecure_clone();
        let hash = control_program(&mut env.svm, a(ctl.pubkey()));
        let register = ix(
            tesoro_core::ID,
            tesoro_core::accounts::RegisterGame {
                payer: a(admin.pubkey()),
                control: a(ctl.pubkey()),
                config: tpda(&[CONFIG_SEED]),
                game_program: railcar::ID,
                program_data: program_data(),
                studio_recipient: env.studio.account,
                game_record: game_record(),
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
        let list = ix(
            tesoro_core::ID,
            tesoro_core::accounts::ListGame {
                admin: a(admin.pubkey()),
                config: tpda(&[CONFIG_SEED]),
                game_record: game_record(),
                game_program: railcar::ID,
                program_data: program_data(),
            },
            tesoro_core::instruction::ListGame {
                listed_until: 4_000_000_000,
                approved_hash: hash,
            },
            vec![],
        );
        env.send(&[cu_limit(1_400_000), list], &admin, &[])
            .expect("list game");
        let studio = dup(&env.studio);
        flow::ensure_spill(&mut env.svm, &studio.kp, studio.account, 64);

        env.set_config(a(env.operator.pubkey()), tables)
            .expect("set config");
        let op = env.operator.insecure_clone();
        let sponsor = ix(
            railcar::ID,
            railcar::accounts::CreateSponsor {
                operator: a(op.pubkey()),
                config: config_addr(),
                sponsor: sponsor_addr(),
                system_program: anchor_lang::system_program::ID,
            },
            railcar::instruction::CreateSponsor { lamports: SOL },
            vec![],
        );
        env.send(&[sponsor], &op, &[]).expect("create sponsor");
        for index in 0..tables {
            env.create_table(index).expect("create table");
            env.init_vault_standin(index);
            env.delegate_standin(railcar::table_address(index));
        }
        env
    }

    /// A Tesoro Account with no Gemas.
    fn bare_person(&mut self) -> Person {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 100 * SOL).expect("airdrop");
        let key = a(kp.pubkey());
        let account = flow::account_of(key);
        let create = ix(
            tesoro_core::ID,
            tesoro_core::accounts::CreateAccount {
                authority: key,
                account,
                basket: basket_address(&account).0,
                spill: spill_address(&account).0,
                invite_gate: invite_gate_pda(),
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
        Person {
            kp,
            key,
            account,
            source: APk::default(),
        }
    }

    fn set_config(&mut self, operator: APk, tables: u16) -> Result<(), Failed> {
        let ctl = self.ctl.insecure_clone();
        let i = ix(
            railcar::ID,
            railcar::accounts::SetConfig {
                authority: a(ctl.pubkey()),
                config: config_addr(),
                program: railcar::ID,
                program_data: program_data(),
                system_program: anchor_lang::system_program::ID,
            },
            railcar::instruction::SetConfig { operator, tables },
            vec![],
        );
        self.send(&[i], &ctl, &[])
    }

    fn create_table(&mut self, index: u16) -> Result<(), Failed> {
        let op = self.operator.insecure_clone();
        let i = ix(
            railcar::ID,
            railcar::accounts::CreateTable {
                operator: a(op.pubkey()),
                config: config_addr(),
                table: railcar::table_address(index),
                system_program: anchor_lang::system_program::ID,
            },
            railcar::instruction::CreateTable { index },
            vec![],
        );
        self.send(&[i], &op, &[])
    }

    /// Stands in for `init_vault`, whose ephemeral-account and permission CPIs need MagicBlock:
    /// the Vault exists, blank, and the Table says so.
    fn init_vault_standin(&mut self, index: u16) {
        let table = railcar::table_address(index);
        let (vault, bump) = railcar::vault_address(&table);
        self.put(vault, &Vault::blank(bump, table), railcar::ID);
        self.patch_table(table, |t| t.vault_ready = 1);
    }

    /// Stands in for `delegate_table`: base keeps the fresh Table as its committed copy.
    fn delegate_standin(&mut self, table: APk) {
        let acct = self.svm.get_account(&s(table)).expect("table");
        self.committed.insert(table, acct.data);
    }

    /// What a real commit sends: base now holds the Table as the rollup has it.
    fn commit_standin(&mut self, table: APk) {
        self.delegate_standin(table);
    }

    fn table(&self, table: APk) -> Table {
        let d = self.svm.get_account(&s(table)).expect("table").data;
        assert_eq!(&d[..8], Table::DISCRIMINATOR);
        *bytemuck::from_bytes::<Table>(&d[8..Table::SPACE])
    }

    fn patch_table(&mut self, table: APk, f: impl FnOnce(&mut Table)) {
        let mut acct = self.svm.get_account(&s(table)).expect("table");
        f(bytemuck::from_bytes_mut::<Table>(
            &mut acct.data[8..Table::SPACE],
        ));
        self.svm.set_account(s(table), acct).expect("patch table");
    }

    fn vault(&self, table: APk) -> Vault {
        self.load(vault_addr(table))
    }

    fn config(&self) -> railcar::state::RailcarConfig {
        self.load(config_addr())
    }

    fn core_car(&self, car: &Car) -> ManySeatMatch {
        let d = self.svm.get_account(&s(car.tesoro)).expect("car").data;
        *bytemuck::from_bytes::<ManySeatMatch>(&d[8..ManySeatMatch::SPACE])
    }

    fn page(&self, car: &Car, page: u8) -> SeatPage {
        let d = self
            .svm
            .get_account(&s(page_pda(car.tesoro, page)))
            .expect("page")
            .data;
        *bytemuck::from_bytes::<SeatPage>(&d[8..SeatPage::SPACE])
    }

    fn page_metas(&self, car: &Car) -> Vec<AccountMeta> {
        (0..self.core_car(car).inner.pages)
            .map(|i| rem(page_pda(car.tesoro, i)))
            .collect()
    }

    fn page_with_room(&self, car: &Car) -> u8 {
        let st = self.core_car(car);
        (0..st.inner.pages)
            .find(|&i| {
                let slots = st.inner.page_slots(i);
                self.page(car, i).seats[..slots]
                    .iter()
                    .any(|seat| seat.state() == SeatState::Empty)
            })
            .unwrap_or(st.inner.pages)
    }

    // --- boarding (base) ------------------------------------------------------------------

    fn car_at(&self, no: u64) -> Car {
        let key = railcar::car_address(no);
        let c: railcar::state::Car = self.load(key);
        Car {
            no,
            key,
            tesoro: c.tesoro_match,
            table: railcar::table_address(c.table),
        }
    }

    fn check_ix(&self, car: &Car) -> Instruction {
        ix(
            railcar::ID,
            railcar::accounts::CheckDeparture {
                car: car.key,
                match_state: car.tesoro,
                game_record: game_record(),
                game_program: railcar::ID,
                program_data: program_data(),
                authority: authority(),
                tesoro_program: tesoro_core::ID,
            },
            railcar::instruction::CheckDeparture {},
            vec![],
        )
    }

    fn join_ix(&self, p: &Person, car: &Car) -> Instruction {
        let page = self.page_with_room(car);
        self.join_page_ix(p, car, page)
    }

    fn join_page_ix(&self, p: &Person, car: &Car, page: u8) -> Instruction {
        let counters: Option<AccountCounters> = self
            .svm
            .get_account(&s(tpda(&[COUNTERS_SEED, p.account.as_ref()])))
            .map(|acc| {
                AccountCounters::try_deserialize(&mut acc.data.as_slice()).expect("counters")
            });
        let nonce = counters.map_or(0, |c| c.next_ticket);
        ix(
            tesoro_core::ID,
            tesoro_core::accounts::JoinManySeatMatch {
                payer: p.key,
                player_authority: p.key,
                player_account: p.account,
                counters: tpda(&[COUNTERS_SEED, p.account.as_ref()]),
                protections: tpda(&[PROTECTIONS_SEED, p.account.as_ref()]),
                basket: basket_address(&p.account).0,
                spill: spill_address(&p.account).0,
                pot: tpda(&[TICKET_SEED, p.account.as_ref(), &nonce.to_le_bytes()]),
                match_state: car.tesoro,
                game_record: game_record(),
                game_program: railcar::ID,
                program_data: program_data(),
                seat_page: page_pda(car.tesoro, page),
                seat_mark: mark_pda(car.tesoro, p.account),
                system_program: anchor_lang::system_program::ID,
                offer: None,
                backer_account: None,
                backer_counters: None,
                backer_protections: None,
                backer_basket: None,
                backer_spill: None,
                funder_mark: None,
            },
            tesoro_core::instruction::JoinManySeatMatch {
                pot_nonce: nonce,
                pot_lines: 4,
                page,
            },
            book_metas(&self.svm, p.source),
        )
    }

    /// Boards `car` the way the app does: core's join and Railcar's `check_departure` in one
    /// transaction.
    fn board(&mut self, p: &Person, car: &Car) -> Result<(), Failed> {
        let ixs = [self.join_ix(p, car), self.check_ix(car)];
        let kp = p.kp.insecure_clone();
        self.send(&ixs, &kp, &[])
    }

    /// Any page's `check_departure` while boarding.
    fn check(&mut self, car: &Car) -> Result<(), Failed> {
        let i = self.check_ix(car);
        let payer = self.oracle.insecure_clone();
        self.send(&[i], &payer, &[])
    }

    fn open_car_ix(&self, p: &Person) -> Instruction {
        let counters: Option<AccountCounters> = self
            .svm
            .get_account(&s(tpda(&[COUNTERS_SEED, p.account.as_ref()])))
            .map(|acc| {
                AccountCounters::try_deserialize(&mut acc.data.as_slice()).expect("counters")
            });
        let n = counters.map_or(0, |c| c.next_match);
        let config = self.config();
        ix(
            railcar::ID,
            railcar::accounts::OpenCar {
                payer: p.key,
                opener: p.key,
                config: config_addr(),
                car: railcar::car_address(config.next_car),
                boarding_match: config.boarding_match,
                match_state: tpda(&[MATCH_SEED, p.account.as_ref(), &n.to_le_bytes()]),
                core_config: tpda(&[CONFIG_SEED]),
                economy: tpda(&[ECONOMY_SEED]),
                game_record: game_record(),
                game_program: railcar::ID,
                program_data: program_data(),
                opener_account: p.account,
                counters: tpda(&[COUNTERS_SEED, p.account.as_ref()]),
                authority: authority(),
                tesoro_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            railcar::instruction::OpenCar { n },
            vec![],
        )
    }

    /// Opens the next car and boards it, in one transaction (as the app does when no car boards).
    fn open_car(&mut self, p: &Person) -> Result<Car, Failed> {
        let no = self.config().next_car;
        let open = self.open_car_ix(p);
        let key = railcar::car_address(no);
        let tesoro = APk::new_from_array(open.accounts[5].pubkey.to_bytes());
        let car = Car {
            no,
            key,
            tesoro,
            table: railcar::table_address((no % u64::from(self.config().tables)) as u16),
        };
        let ixs = [open, self.join_page_ix(p, &car, 0), self.check_ix(&car)];
        let kp = p.kp.insecure_clone();
        self.send(&ixs, &kp, &[])?;
        Ok(car)
    }

    /// The app's choice: board the car that is boarding, or open the next one.
    fn queue(&mut self, p: &Person) -> Result<Car, Failed> {
        let config = self.config();
        if config.next_car > 0 {
            let car = self.car_at(config.next_car - 1);
            let open = self
                .svm
                .get_account(&s(car.tesoro))
                .is_some_and(|acc| acc.data.len() == ManySeatMatch::SPACE);
            if open && self.core_car(&car).inner.stage() == ManyStage::Boarding {
                self.board(p, &car)?;
                return Ok(car);
            }
        }
        self.open_car(p)
    }

    fn step_off(&mut self, p: &Person, car: &Car) -> Result<(), Failed> {
        let d = self
            .svm
            .get_account(&s(mark_pda(car.tesoro, p.account)))
            .expect("mark")
            .data;
        let mark = *bytemuck::from_bytes::<SeatMark>(&d[8..SeatMark::SPACE]);
        let seat_page = mark.seat / SEATS_PER_PAGE as u8;
        let seat = self.page(car, seat_page).seats[mark.seat as usize % SEATS_PER_PAGE];
        let pot = APk::new_from_array(seat.pot());
        let pd = self.svm.get_account(&s(pot)).expect("pot").data;
        let pot_payer = APk::new_from_array(pd[8 + 72..8 + 104].try_into().expect("payer"));
        let mut remaining = vec![
            rem(basket_address(&p.account).0),
            rem(spill_address(&p.account).0),
        ];
        remaining.extend(book_metas(&self.svm, p.source));
        let i = ix(
            tesoro_core::ID,
            tesoro_core::accounts::StepOffManySeatMatch {
                caller: p.key,
                match_state: car.tesoro,
                seat_page: page_pda(car.tesoro, seat_page),
                seat_mark: mark_pda(car.tesoro, p.account),
                mark_payer: APk::new_from_array(mark.payer),
                player_counters: tpda(&[COUNTERS_SEED, p.account.as_ref()]),
                player_protections: tpda(&[PROTECTIONS_SEED, p.account.as_ref()]),
                pot,
                pot_payer,
                sponsor: None,
                game_record: None,
                game_program: None,
                program_data: None,
                funder_mark: None,
                funder_protections: None,
            },
            tesoro_core::instruction::StepOffManySeatMatch {
                seat: mark.seat,
                max_lines: tesoro_core::MAX_RETURN_LINES,
            },
            remaining,
        );
        let kp = p.kp.insecure_clone();
        self.send(&[i], &kp, &[])
    }

    fn stage(&self, car: &Car) -> ManyStage {
        self.core_car(car).inner.stage()
    }

    // --- the ride (rollup) ----------------------------------------------------------------

    fn start_ix(&self, car: &Car, previous: APk) -> Instruction {
        ix(
            railcar::ID,
            railcar::accounts::StartRide {
                payer: a(self.oracle.pubkey()),
                table: car.table,
                vault: vault_addr(car.table),
                car: car.key,
                match_state: car.tesoro,
                previous_receipt: receipt(previous),
                oracle_queue: sdk_key(ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE),
                program_identity: rpda(&[ephemeral_rollups_sdk::vrf::consts::IDENTITY]),
                vrf_program: sdk_key(ephemeral_rollups_sdk::vrf::consts::VRF_PROGRAM_ID),
                slot_hashes: a(solana_sdk::sysvar::slot_hashes::ID),
                system_program: anchor_lang::system_program::ID,
            },
            railcar::instruction::StartRide {},
            self.page_metas(car),
        )
    }

    fn start_ride(&mut self, car: &Car) -> Result<(), Failed> {
        let previous = APk::new_from_array(self.table(car.table).tesoro_match);
        let i = self.start_ix(car, previous);
        let payer = self.oracle.insecure_clone();
        self.send(&[cu_limit(1_400_000), i], &payer, &[])
    }

    /// The VRF program's callback: its scoped identity signs, as the oracle's CPI makes it.
    fn callback(&mut self, table: APk, randomness: [u8; 32]) -> Result<(), Failed> {
        let t = self.table(table);
        let identity = sdk_key(ephemeral_rollups_sdk::vrf::consts::scoped_vrf_identity(
            &railcar::ID,
        ));
        let i = ix(
            railcar::ID,
            railcar::accounts::DrawCallback {
                vrf_program_identity: identity,
                table,
                vault: vault_addr(table),
                request: Table::request_marker(&table, t.req_nonce()),
            },
            railcar::instruction::DrawCallback { randomness },
            vec![],
        );
        let payer = self.oracle.insecure_clone();
        self.svm.expire_blockhash();
        let msg = solana_sdk::message::Message::new_with_blockhash(
            &[i],
            Some(&payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let mut tx = Transaction::new_unsigned(msg);
        tx.partial_sign(&[&payer], self.svm.latest_blockhash());
        let r = self.svm.send_transaction(tx);
        self.finish(r)
    }

    fn magic_accounts(&self) -> (APk, APk, APk) {
        (
            table_kit::fee_vault_address(&railcar::TEE_VALIDATOR),
            sdk_key(ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID),
            sdk_key(ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID),
        )
    }

    /// A page's signal. A signal that ends the ride commits it (stood in: base now holds it).
    fn signal(&mut self, table: APk) -> Result<(), Failed> {
        let (fee, context, magic) = self.magic_accounts();
        let i = ix(
            railcar::ID,
            railcar::accounts::Signal {
                caller: a(self.oracle.pubkey()),
                table,
                vault: vault_addr(table),
                sponsor: sponsor_addr(),
                magic_fee_vault: fee,
                magic_context: context,
                magic_program: magic,
            },
            railcar::instruction::Signal {},
            vec![],
        );
        let payer = self.oracle.insecure_clone();
        self.send(&[i], &payer, &[])?;
        self.commit_if_ended(table);
        Ok(())
    }

    fn commit_if_ended(&mut self, table: APk) {
        let t = self.table(table);
        if t.phase == PHASE_OVER && t.dirty == 0 {
            self.commit_standin(table);
        }
    }

    /// Table seat of `p` on the ride.
    fn seat_of(&self, table: APk, p: &Person) -> u8 {
        let t = self.table(table);
        (0..t.seated)
            .find(|&i| t.seats[usize::from(i)].account == p.account.to_bytes())
            .expect("on the ride")
    }

    fn jump_ix(&self, table: APk, p: &Person, car_no: u64, seat: u8) -> Instruction {
        let (fee, context, magic) = self.magic_accounts();
        ix(
            railcar::ID,
            railcar::accounts::Jump {
                player: p.key,
                player_account: p.account,
                table,
                vault: vault_addr(table),
                sponsor: sponsor_addr(),
                magic_fee_vault: fee,
                magic_context: context,
                magic_program: magic,
            },
            railcar::instruction::Jump { car_no, seat },
            vec![],
        )
    }

    fn jump(&mut self, table: APk, p: &Person) -> Result<(), Failed> {
        let seat = self.seat_of(table, p);
        let car_no = self.table(table).car_no();
        let i = self.jump_ix(table, p, car_no, seat);
        let kp = p.kp.insecure_clone();
        self.send(&[i], &kp, &[])?;
        self.commit_if_ended(table);
        Ok(())
    }

    /// Slot `secs` seconds into the ride.
    fn ride_at(&self, table: APk, secs: f64) -> u64 {
        self.table(table).ride_slot() + (secs * SPS as f64).round() as u64
    }

    /// The first slot at or after ride ms `ms`.
    fn at_ms(&mut self, table: APk, ms: u32) {
        let slot = self.table(table).ride_slot() + u64::from(ms).div_ceil(1_000 / SPS);
        self.set_slot(slot);
    }

    /// The Impact slot of the ride on `table`.
    fn impact_slot(&self, table: APk) -> u64 {
        self.table(table).ride_slot() + u64::from(self.vault(table).crash_ms).div_ceil(1_000 / SPS)
    }

    fn at_ride(&mut self, table: APk, secs: f64) {
        let slot = self.ride_at(table, secs);
        self.set_slot(slot);
    }

    // --- settlement (base) ----------------------------------------------------------------

    /// Runs `f` with base's view of the Table: the committed bytes, owned by the delegation
    /// program. The rollup Table is put back afterwards.
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

    fn finalize_ix(&self, car: &Car, pages: Vec<AccountMeta>) -> Instruction {
        let c: railcar::state::Car = self.load(car.key);
        ix(
            railcar::ID,
            railcar::accounts::Finalize {
                caller: a(self.admin.pubkey()),
                car: car.key,
                car_payer: c.payer,
                table: car.table,
                match_state: car.tesoro,
                core_config: tpda(&[CONFIG_SEED]),
                game_record: game_record(),
                authority: authority(),
                game_program: railcar::ID,
                program_data: program_data(),
                receipt: receipt(car.tesoro),
                system_program: anchor_lang::system_program::ID,
                core_event_authority: tpda(&[b"__event_authority"]),
                tesoro_program: tesoro_core::ID,
                event_authority: rpda(&[b"__event_authority"]),
                program: railcar::ID,
            },
            railcar::instruction::Finalize {},
            pages,
        )
    }

    fn finalize_with(&mut self, car: &Car, pages: Vec<AccountMeta>) -> Result<(), Failed> {
        let i = self.finalize_ix(car, pages);
        let payer = self.admin.insecure_clone();
        let table = car.table;
        self.on_base(table, |env| env.send_v0(&[cu_limit(1_400_000), i], &payer))
    }

    fn finalize(&mut self, car: &Car) -> Result<(), Failed> {
        let pages = self.page_metas(car);
        self.finalize_with(car, pages)
    }

    /// Every seat of the car and its Pot's lines.
    fn seats_and_lines(
        &self,
        car: &Car,
    ) -> (Vec<Seat>, Vec<Vec<tesoro_core::ledger::line_store::Line>>) {
        let st = self.core_car(car);
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

    /// One settle chunk with the accounts core's `ahead` names.
    fn chunk_ix(&self, car: &Car, steps: u8) -> Instruction {
        let st = self.core_car(car);
        let (seats, lines) = self.seats_and_lines(car);
        let plan = st.inner.ahead(&seats, &lines, steps as usize);
        let mut out: Vec<AccountMeta> = plan
            .pages
            .iter()
            .map(|p| rem(page_pda(car.tesoro, *p)))
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
            let source: SourceState = self.load(src);
            out.push(rem(APk::new_from_array(source.inner.position)));
        }
        ix(
            tesoro_core::ID,
            tesoro_core::accounts::ManySeatChunk {
                caller: a(self.admin.pubkey()),
                match_state: car.tesoro,
                event_authority: tpda(&[b"__event_authority"]),
                program: tesoro_core::ID,
            },
            tesoro_core::instruction::ManySeatChunk { max_steps: steps },
            out,
        )
    }

    /// Core's chunks until the car is paid.
    fn run_car(&mut self, car: &Car) {
        let payer = self.admin.insecure_clone();
        for _ in 0..1_000 {
            if self.stage(car) == ManyStage::Paid {
                return;
            }
            let mut steps = tesoro_core::MAX_SEAT_CHUNK_STEPS;
            let mut i = self.chunk_ix(car, steps);
            while i.accounts.len() > 60 && steps > 1 {
                steps -= 1;
                i = self.chunk_ix(car, steps);
            }
            self.send_v0(&[cu_limit(1_400_000), i], &payer)
                .expect("chunk");
        }
        panic!("the run did not finish");
    }

    /// `finalize` and every chunk: the car is paid.
    fn settle(&mut self, car: &Car) {
        self.finalize(car).expect("finalize");
        self.run_car(car);
    }
}

/// A VRF output whose ride satisfies `want`.
fn draw_where(want: impl Fn(&railcar::engine::Ride) -> bool) -> [u8; 32] {
    for i in 0u64..100_000 {
        let mut d = [0u8; 32];
        for (k, w) in d.chunks_exact_mut(8).enumerate() {
            let mut z = (i * 4 + k as u64)
                .wrapping_add(1)
                .wrapping_mul(0x9E37_79B9_7F4A_7C15);
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z ^= z >> 31;
            w.copy_from_slice(&z.to_le_bytes());
        }
        if want(&railcar::engine::ride(&d)) {
            return d;
        }
    }
    panic!("no draw found");
}

/// `n` riders boarded a car through the Queue (the 5th fixed the end time).
fn boarded(env: &mut Env, n: usize) -> (Car, Vec<Person>) {
    let riders: Vec<Person> = (0..n).map(|_| env.rider()).collect();
    let mut car = None;
    for p in &riders {
        car = Some(env.queue(p).expect("board"));
    }
    (car.expect("a car"), riders)
}

/// Five riders' car, departed at the end of its countdown, the ride running with `draw`.
fn riding(draw: [u8; 32]) -> (Env, Car, Vec<Person>) {
    let mut env = Env::new(2);
    let (car, riders) = boarded(&mut env, 5);
    env.set_time(env.now + COUNTDOWN_SECS);
    env.check(&car).expect("check");
    assert_eq!(env.stage(&car), ManyStage::Departed);
    env.start_ride(&car).expect("start ride");
    env.callback(car.table, draw).expect("callback");
    (env, car, riders)
}

const ANA: usize = 0;
const BEN: usize = 1;
const CY: usize = 2;
const DEE: usize = 3;
const EVE: usize = 4;

// =========================================================================================
// The worked example
// =========================================================================================

#[test]
fn the_worked_example_pays_to_the_gema() {
    let draw = draw_where(|r| r.crash_ms >= 101_000);
    let (mut env, car, riders) = riding(draw);
    let before: Vec<u64> = riders.iter().map(|p| env.gemas(p)).collect();
    let studio_before = env.fee_gemas(&env.studio);
    for (who, secs) in [(ANA, 25.0), (CY, 95.0), (BEN, 97.0), (DEE, 99.0)] {
        env.at_ride(car.table, secs);
        env.jump(car.table, &riders[who]).expect("jump");
    }
    let t = env.table(car.table);
    assert_eq!((t.jumps, t.aboard, t.phase), (4, 1, PHASE_RIDING));
    // Eve is aboard: the first signal from the Impact slot ends the ride and commits it
    env.at_ride(car.table, 100.0);
    env.signal(car.table).expect("signal");
    assert_eq!(env.table(car.table).phase, PHASE_RIDING);
    let impact = env.impact_slot(car.table);
    env.set_slot(impact - 1);
    env.signal(car.table).expect("signal");
    assert_eq!(
        env.table(car.table).phase,
        PHASE_RIDING,
        "a slot before the wall"
    );
    env.set_slot(impact);
    env.signal(car.table).expect("impact");
    let t = env.table(car.table);
    assert_eq!(
        (t.phase, t.outcome, t.dirty),
        (PHASE_OVER, OUTCOME_PLACED, 0)
    );
    env.settle(&car);
    let delta: Vec<i64> = riders
        .iter()
        .zip(&before)
        .map(|(p, b)| env.gemas(p) as i64 - *b as i64)
        .collect();
    // what each gets back for the 500 they boarded with: Dee 813, Ben 630, Cy 578, Ana 350, Eve 0
    assert_eq!(delta, vec![350, 630, 578, 813, 0]);
    assert_eq!(
        env.fee_gemas(&env.studio) - studio_before,
        64,
        "Studio Fee 3%"
    );
    assert_eq!(env.stage(&car), ManyStage::Paid);
    assert!(
        env.svm
            .get_account(&s(car.key))
            .is_none_or(|acc| acc.lamports == 0),
        "the car closed with its settlement"
    );
}

// =========================================================================================
// Who gets what
// =========================================================================================

/// What each rider got back: Gemas after the car settled, against after boarding.
fn settle_deltas(env: &mut Env, car: &Car, riders: &[Person], before: &[u64]) -> Vec<i64> {
    env.settle(car);
    riders
        .iter()
        .zip(before)
        .map(|(p, b)| env.gemas(p) as i64 - *b as i64)
        .collect()
}

fn end_by_signal(env: &mut Env, car: &Car) {
    let impact = env.impact_slot(car.table);
    env.set_slot(impact);
    env.signal(car.table).expect("impact");
    assert_eq!(env.table(car.table).phase, PHASE_OVER);
}

#[test]
fn nobody_jumping_refunds_every_entry_with_no_fee() {
    let (mut env, car, riders) = riding(draw_where(|r| r.crash_ms < 40_000));
    let before: Vec<u64> = riders.iter().map(|p| env.gemas(p)).collect();
    let studio_before = env.fee_gemas(&env.studio);
    end_by_signal(&mut env, &car);
    assert_eq!(env.table(car.table).outcome, OUTCOME_REFUND);
    assert_eq!(
        settle_deltas(&mut env, &car, &riders, &before),
        vec![500; 5]
    );
    assert_eq!(env.fee_gemas(&env.studio), studio_before);
}

#[test]
fn one_jumper_takes_the_rest_and_two_split_seventy_thirty() {
    let draw = draw_where(|r| r.crash_ms >= 40_000);
    // one: Dee off at 12 s takes everything after fees (2,500 - 150 - her 500 = 1,850)
    let (mut env, car, riders) = riding(draw);
    let before: Vec<u64> = riders.iter().map(|p| env.gemas(p)).collect();
    env.at_ride(car.table, 12.0);
    env.jump(car.table, &riders[DEE]).expect("jump");
    end_by_signal(&mut env, &car);
    assert_eq!(
        settle_deltas(&mut env, &car, &riders, &before),
        vec![0, 0, 0, 2_350, 0]
    );
    // two: Cy at 30 s, Ben at 31 s; the 1,350 after fees and entries splits 945 / 405
    let (mut env, car, riders) = riding(draw);
    let before: Vec<u64> = riders.iter().map(|p| env.gemas(p)).collect();
    env.at_ride(car.table, 30.0);
    env.jump(car.table, &riders[CY]).expect("jump");
    env.at_ride(car.table, 31.0);
    env.jump(car.table, &riders[BEN]).expect("jump");
    end_by_signal(&mut env, &car);
    assert_eq!(
        settle_deltas(&mut env, &car, &riders, &before),
        vec![0, 1_445, 905, 0, 0]
    );
}

#[test]
fn when_everyone_jumps_the_ride_ends_at_the_last_jump() {
    let (mut env, car, riders) = riding(draw_where(|r| r.crash_ms >= 30_000));
    let before: Vec<u64> = riders.iter().map(|p| env.gemas(p)).collect();
    for (i, p) in riders.iter().enumerate() {
        env.at_ride(car.table, 5.0 + i as f64);
        env.jump(car.table, p).expect("jump");
    }
    let t = env.table(car.table);
    assert_eq!((t.phase, t.aboard, t.over_ms()), (PHASE_OVER, 0, 9_000));
    // Ana and Ben get 80% back (400 each); the Pot after refunds is 1,700 and its 6% fees 102 come
    // from their 200 forfeited; the 98 left split 60/25/15 with the rounding to Eve: 60, 24, 14
    assert_eq!(
        settle_deltas(&mut env, &car, &riders, &before),
        vec![400, 400, 514, 524, 560]
    );
}

#[test]
fn a_jump_at_or_after_the_impact_slot_ends_the_ride_with_the_player_aboard() {
    let (mut env, car, riders) = riding(draw_where(|r| r.crash_ms >= 20_000));
    env.at_ride(car.table, 11.0);
    env.jump(car.table, &riders[ANA]).expect("jump");
    // the last slot before the wall still counts
    let impact = env.impact_slot(car.table);
    env.set_slot(impact - 1);
    env.jump(car.table, &riders[BEN]).expect("in time");
    // Cy's Jump lands on the Impact slot: it succeeds, ends the ride, and Cy is aboard
    env.set_slot(impact);
    env.jump(car.table, &riders[CY]).expect("the ride ends");
    let t = env.table(car.table);
    assert_eq!((t.phase, t.jumps), (PHASE_OVER, 2));
    let cy = env.seat_of(car.table, &riders[CY]);
    assert!(t.seats[usize::from(cy)].aboard());
    // after the end nothing more is taken
    let late = env.jump(car.table, &riders[DEE]).unwrap_err();
    assert_eq!(code(&late), rcode(railcar::RailcarError::WrongPhase));
}

#[test]
fn jumps_are_ordered_as_they_arrive_even_in_the_same_slot() {
    let (mut env, car, riders) = riding(draw_where(|r| r.crash_ms >= 30_000));
    let before: Vec<u64> = riders.iter().map(|p| env.gemas(p)).collect();
    env.at_ride(car.table, 20.0);
    env.jump(car.table, &riders[BEN]).expect("Ben first");
    env.jump(car.table, &riders[ANA])
        .expect("Ana second, same slot");
    let t = env.table(car.table);
    let order = |p: &Person| t.seats[usize::from(env.seat_of(car.table, p))].order;
    assert_eq!((order(&riders[BEN]), order(&riders[ANA])), (1, 2));
    end_by_signal(&mut env, &car);
    // Ana was last off: 70% of the 1,350 left, Ben 30%
    assert_eq!(
        settle_deltas(&mut env, &car, &riders, &before),
        vec![1_445, 905, 0, 0, 0]
    );
}

#[test]
fn a_jump_names_its_car_and_its_own_seat() {
    let (mut env, car, riders) = riding(draw_where(|r| r.crash_ms >= 30_000));
    env.at_ride(car.table, 15.0);
    let seat = env.seat_of(car.table, &riders[ANA]);
    let stale = env.jump_ix(car.table, &riders[ANA], car.no + 2, seat);
    let kp = riders[ANA].kp.insecure_clone();
    let err = env.send(&[stale], &kp, &[]).unwrap_err();
    assert_eq!(code(&err), rcode(railcar::RailcarError::StaleBinding));
    let bens = env.seat_of(car.table, &riders[BEN]);
    let wrong = env.jump_ix(car.table, &riders[ANA], car.no, bens);
    let err = env.send(&[wrong], &kp, &[]).unwrap_err();
    assert_eq!(code(&err), rcode(railcar::RailcarError::NotAPlayer));
    assert_eq!(env.table(car.table).jumps, 0);
}

#[test]
fn signals_show_the_tells_only_once_the_car_passes_them() {
    let (mut env, car, _riders) = riding(draw_where(|r| {
        r.crash_ms >= 60_000 && r.screw_at_ms > 25_000
    }));
    let v = env.vault(car.table);
    let slot_before =
        env.table(car.table).ride_slot() + u64::from(v.screw_at_ms - 1) / (1_000 / SPS);
    env.set_slot(slot_before);
    env.signal(car.table).expect("signal");
    assert_eq!(env.table(car.table).tell, 0);
    env.at_ms(car.table, v.screw_at_ms);
    env.signal(car.table).expect("signal");
    assert_eq!(env.table(car.table).tell, 1);
    env.at_ms(car.table, v.spark_at_ms);
    env.signal(car.table).expect("signal");
    let t = env.table(car.table);
    assert_eq!((t.tell, t.phase), (3, PHASE_RIDING));
}

#[test]
fn a_draw_that_never_comes_refunds_the_car() {
    let mut env = Env::new(2);
    let (car, riders) = boarded(&mut env, 5);
    let before: Vec<u64> = riders.iter().map(|p| env.gemas(p)).collect();
    env.set_time(env.now + COUNTDOWN_SECS);
    env.check(&car).expect("depart");
    env.start_ride(&car).expect("start");
    assert_eq!(env.table(car.table).phase, PHASE_DRAWING);
    let started = env.table(car.table).started_slot();
    env.set_slot(started + railcar::state::DRAW_WINDOW_SLOTS);
    env.signal(car.table).expect("still waiting");
    assert_eq!(env.table(car.table).phase, PHASE_DRAWING);
    env.set_slot(started + railcar::state::DRAW_WINDOW_SLOTS + 1);
    let late = env.callback(car.table, [1; 32]).unwrap_err();
    assert_eq!(code(&late), rcode(railcar::RailcarError::StaleRequest));
    env.signal(car.table).expect("void");
    let t = env.table(car.table);
    assert_eq!(
        (t.outcome, t.reason),
        (OUTCOME_REFUND, railcar::state::REASON_NO_DRAW)
    );
    assert_eq!(
        settle_deltas(&mut env, &car, &riders, &before),
        vec![500; 5]
    );
}

// =========================================================================================
// Boarding
// =========================================================================================

#[test]
fn the_car_waits_below_five_and_leaves_thirty_seconds_after_the_fifth() {
    let mut env = Env::new(2);
    let (car, riders) = boarded(&mut env, 4);
    env.set_time(env.now + 10_000);
    env.check(&car).expect("no-op");
    assert_eq!(
        env.stage(&car),
        ManyStage::Boarding,
        "no time limit below 5"
    );
    let fifth = env.rider();
    env.queue(&fifth).expect("fifth");
    let first = env.core_car(&car).inner.first_min_at();
    assert_eq!(first, env.now);
    env.set_time(first + COUNTDOWN_SECS - 1);
    env.check(&car).expect("no-op");
    assert_eq!(env.stage(&car), ManyStage::Boarding);
    env.set_time(first + COUNTDOWN_SECS);
    env.check(&car).expect("depart");
    assert_eq!(env.stage(&car), ManyStage::Departed);
    assert_eq!(env.core_car(&car).inner.seated, 5);
    drop(riders);
}

#[test]
fn stepping_off_and_back_on_never_moves_the_departure_time() {
    let mut env = Env::new(2);
    let (car, riders) = boarded(&mut env, 5);
    let first = env.core_car(&car).inner.first_min_at();
    env.set_time(first + 20);
    env.step_off(&riders[BEN], &car).expect("step off");
    env.set_time(first + 25);
    env.queue(&riders[BEN]).expect("back on");
    assert_eq!(
        env.core_car(&car).inner.min_since(),
        first + 25,
        "core's countdown restarted"
    );
    env.set_time(first + COUNTDOWN_SECS);
    env.check(&car).expect("depart");
    assert_eq!(
        env.stage(&car),
        ManyStage::Departed,
        "the first end time holds"
    );
}

#[test]
fn a_car_short_of_five_at_its_end_time_leaves_the_moment_a_fifth_boards() {
    let mut env = Env::new(2);
    let (car, riders) = boarded(&mut env, 5);
    let first = env.core_car(&car).inner.first_min_at();
    env.set_time(first + 20);
    env.step_off(&riders[EVE], &car).expect("step off");
    env.set_time(first + COUNTDOWN_SECS + 1);
    env.check(&car).expect("no-op");
    assert_eq!(env.stage(&car), ManyStage::Boarding, "never with 4");
    env.set_time(first + 300);
    let newcomer = env.rider();
    let boarded_car = env.queue(&newcomer).expect("board");
    assert_eq!(boarded_car.key, car.key);
    assert_eq!(
        env.stage(&car),
        ManyStage::Departed,
        "left in the 5th's transaction"
    );
}

#[test]
fn a_hundred_players_ride_one_car_and_the_hundred_and_first_boards_the_next() {
    let mut env = Env::new(2);
    let (car, riders) = boarded(&mut env, 100);
    assert_eq!(
        env.stage(&car),
        ManyStage::Departed,
        "a full car leaves in the transaction that fills it"
    );
    let late = env.rider();
    let next = env.queue(&late).expect("next car");
    assert_eq!((next.no, env.stage(&next)), (1, ManyStage::Boarding));
    assert_eq!(next.table, railcar::table_address(1));
    // the ride: 10 Jump early, then the last three; everyone else is aboard at Impact
    let before: Vec<u64> = riders.iter().map(|p| env.gemas(p)).collect();
    let studio_before = env.fee_gemas(&env.studio);
    env.start_ride(&car).expect("start");
    println!("start_ride, 100 seats: {} CU", env.last_cu);
    env.callback(car.table, draw_where(|r| r.crash_ms >= 60_000))
        .expect("draw");
    assert_eq!(env.table(car.table).seated, 100);
    for (k, p) in riders.iter().take(13).enumerate() {
        env.at_ride(car.table, 2.0 + 4.0 * k as f64);
        env.jump(car.table, p).expect("jump");
        println!("jump {k}: {} CU", env.last_cu);
    }
    end_by_signal(&mut env, &car);
    println!("impact signal, 100 seats: {} CU", env.last_cu);
    let pages = env.page_metas(&car);
    let finalize = env.finalize_ix(&car, pages);
    let payer = env.admin.insecure_clone();
    let table = car.table;
    env.on_base(table, |e| {
        e.send_v0(&[cu_limit(1_400_000), finalize], &payer)
    })
    .expect("finalize");
    println!("finalize, 100 seats: {} CU", env.last_cu);
    // a placed seat takes a line from each forfeited Source and the outside studio a fee line:
    // the client grows their stores first (core reserves no room for winnings)
    let grow: Vec<Person> = riders[10..13]
        .iter()
        .chain(std::iter::once(&env.studio))
        .map(dup)
        .collect();
    for p in &grow {
        flow::ensure_spill(&mut env.svm, &p.kp, p.account, 200);
    }
    env.run_car(&car);
    let delta: Vec<i64> = riders
        .iter()
        .zip(&before)
        .map(|(p, b)| env.gemas(p) as i64 - *b as i64)
        .collect();
    // early Jumpers every 4 s from 2 s to 38 s: 80% to 20 s, 70% to 30 s, 60% to 40 s
    let refunds = [400, 400, 400, 400, 400, 350, 350, 300, 300, 300];
    for (k, r) in refunds.iter().enumerate() {
        assert_eq!(delta[k], *r, "early Jumper {k}");
    }
    assert!(delta[13..].iter().all(|d| *d == 0), "aboard at Impact");
    // refunds 3,600: the Pot after refunds is 46,400 and its 6% fees 2,784
    let fees: i64 = 2_784;
    assert_eq!(delta.iter().sum::<i64>(), 50_000 - fees);
    assert!(
        delta[12] > delta[11] && delta[11] > delta[10],
        "last off first"
    );
    assert_eq!(
        env.fee_gemas(&env.studio) - studio_before,
        1_392,
        "Studio Fee: 3% of 46,400"
    );
}

// =========================================================================================
// Tables and the result
// =========================================================================================

/// Five more riders board the next car through the Queue and it leaves.
fn next_departed(env: &mut Env) -> Car {
    let (car, _) = boarded(env, 5);
    env.set_time(env.now + COUNTDOWN_SECS);
    env.check(&car).expect("depart");
    car
}

#[test]
fn a_table_takes_its_next_car_only_after_core_froze_the_last_one() {
    let draw = draw_where(|r| r.crash_ms >= 30_000);
    let (mut env, car0, riders) = riding(draw);
    let car1 = next_departed(&mut env);
    let car2 = next_departed(&mut env);
    assert_eq!(
        (car1.table, car2.table),
        (railcar::table_address(1), car0.table)
    );
    // car 2 shares Table 0 with car 0, still riding
    let err = env.start_ride(&car2).unwrap_err();
    assert_eq!(code(&err), rcode(railcar::RailcarError::WrongPhase));
    env.at_ride(car0.table, 12.0);
    env.jump(car0.table, &riders[ANA]).expect("jump");
    end_by_signal(&mut env, &car0);
    let err = env.start_ride(&car2).unwrap_err();
    assert_eq!(code(&err), rcode(railcar::RailcarError::PreviousNotFrozen));
    env.finalize(&car0).expect("finalize car 0");
    env.start_ride(&car2).expect("Table 0 takes car 2");
    let t = env.table(car2.table);
    assert_eq!(
        (t.car_no(), t.phase, t.seated, t.jumps),
        (2, PHASE_DRAWING, 5, 0)
    );
    env.start_ride(&car1).expect("Table 1 takes car 1");
}

#[test]
fn finalize_needs_the_cars_own_finished_table_and_all_its_pages() {
    let draw = draw_where(|r| r.crash_ms >= 30_000);
    let (mut env, car, riders) = riding(draw);
    // base still holds the Table as it was before the ride
    let err = env.finalize(&car).unwrap_err();
    assert_eq!(code(&err), rcode(railcar::RailcarError::BadTable));
    env.at_ride(car.table, 12.0);
    env.jump(car.table, &riders[ANA]).expect("jump");
    // a commit of the ride in progress is not a result either
    env.commit_standin(car.table);
    let err = env.finalize(&car).unwrap_err();
    assert_eq!(code(&err), rcode(railcar::RailcarError::BadTable));
    end_by_signal(&mut env, &car);
    let err = env.finalize_with(&car, vec![]).unwrap_err();
    assert_eq!(code(&err), rcode(railcar::RailcarError::PagesMissing));
    env.finalize(&car).expect("finalize");
    assert_eq!(env.stage(&car), ManyStage::Settling);
}

#[test]
fn a_table_passes_over_a_car_that_will_never_ride() {
    let mut env = Env::new(2);
    // car 0 (Table 0): its only rider steps off and anyone closes the empty car
    let ana = env.rider();
    let car0 = env.queue(&ana).expect("open");
    env.step_off(&ana, &car0).expect("step off");
    let close = ix(
        tesoro_core::ID,
        tesoro_core::accounts::CloseManySeatMatch {
            caller: a(env.admin.pubkey()),
            match_state: car0.tesoro,
            match_payer: ana.key,
        },
        tesoro_core::instruction::CloseManySeatMatch {},
        vec![rem(page_pda(car0.tesoro, 0)), rem(ana.key)],
    );
    let admin = env.admin.insecure_clone();
    env.send(&[close], &admin, &[]).expect("close empty car");
    let car1 = next_departed(&mut env);
    let car2 = next_departed(&mut env);
    assert_eq!((car1.no, car2.no), (1, 2));
    let err = env.start_ride(&car2).unwrap_err();
    assert_eq!(code(&err), rcode(railcar::RailcarError::WrongCar));
    let skip = ix(
        railcar::ID,
        railcar::accounts::SkipCar {
            caller: a(admin.pubkey()),
            table: car0.table,
            config: config_addr(),
            car: car0.key,
            match_state: car0.tesoro,
            receipt: receipt(car0.tesoro),
        },
        railcar::instruction::SkipCar {},
        vec![],
    );
    env.send(std::slice::from_ref(&skip), &admin, &[])
        .expect("skip car 0");
    env.start_ride(&car2).expect("car 2 rides");
    // a car still on its way cannot be skipped
    let skip_two = ix(
        railcar::ID,
        railcar::accounts::SkipCar {
            caller: a(admin.pubkey()),
            table: car1.table,
            config: config_addr(),
            car: car1.key,
            match_state: car1.tesoro,
            receipt: receipt(car1.tesoro),
        },
        railcar::instruction::SkipCar {},
        vec![],
    );
    let err = env.send(&[skip_two], &admin, &[]).unwrap_err();
    assert_eq!(code(&err), rcode(railcar::RailcarError::CannotSkip));
}

#[test]
fn only_one_car_boards_at_a_time() {
    let mut env = Env::new(2);
    let (car, riders) = boarded(&mut env, 3);
    let other = env.rider();
    let err = env.open_car(&other).unwrap_err();
    assert_eq!(code(&err), rcode(railcar::RailcarError::CarBoarding));
    assert_eq!(env.config().next_car, 1);
    drop((car, riders));
}

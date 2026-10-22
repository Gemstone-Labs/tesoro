//! LiteSVM tests: the real vanguard and tesoro_core programs (`pnpm build:programs` first).
//!
//! LiteSVM has no delegation, permission or VRF programs, so the rollup-only steps (`init_permissions`,
//! `request_vrf`, the oracle callback, `close_match`) are stood in for by writing the account state they would
//! have produced. Everything else runs as deployed: `create_match`, `set_config`, `deal`, `move_piece`,
//! `start_two_step`, `claim_timeout` and `finalize`, which settles or refunds the tesoro_core Match by CPI
//! signed by the `authority` PDA.
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
#[path = "../../tesoro_core/tests/common/flow.rs"]
mod flow;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::account::Account;
use solana_sdk::clock::Clock;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::message::Message;
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use tesoro_core::instructions::MatchResult;
use tesoro_core::ledger::lifecycle::Stage;
use tesoro_core::ledger::SourceChain;
use tesoro_core::state::*;
use vanguard::engine::{
    self, Army as Side, EndReason, Game, LayoutPiece, BOMB, CHAIN_CLOCK, ENGINEER,
    GENERAL_OF_THE_ARMY, OPENING_GRACE_SECS, PIECE_SLOTS, RECON, SPY, TRUCK,
};
use vanguard::{Army, Battle, Secret, VanguardConfig, VanguardError};

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
    APk::find_program_address(&[GAME_SEED, vanguard::ID.as_ref()], &tesoro_core::ID).0
}
fn program_data_pda() -> APk {
    APk::find_program_address(
        &[vanguard::ID.as_ref()],
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
fn vpda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &vanguard::ID).0
}
fn account_pda(auth: APk) -> APk {
    tpda(&[ACCOUNT_SEED, auth.as_ref()])
}
fn authority_pda() -> APk {
    vpda(&[vanguard::AUTHORITY_SEED])
}
fn config_pda() -> APk {
    vpda(&[vanguard::PROGRAM_CONFIG_SEED])
}

struct Addrs {
    battle: APk,
    secret: APk,
    army_0: APk,
    army_1: APk,
}
fn addrs(tesoro_match: APk) -> Addrs {
    let battle = vpda(&[vanguard::BATTLE_SEED, tesoro_match.as_ref()]);
    Addrs {
        battle,
        secret: vpda(&[vanguard::SECRET_SEED, battle.as_ref()]),
        army_0: vpda(&[vanguard::ARMY_SEED, battle.as_ref(), &[0]]),
        army_1: vpda(&[vanguard::ARMY_SEED, battle.as_ref(), &[1]]),
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

/// A raise of the compute limit, as the app sends with every move (the fixed-work scan costs more than the 200,000
/// default).
fn budget() -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&1_400_000u32.to_le_bytes());
    Instruction {
        program_id: Pk::new_from_array(
            *b"\x03\x06\x46\x6f\xe5\x21\x17\x32\xff\xec\xad\xba\x72\xc3\x9b\xe7\xbc\x8c\xe5\xbb\xc5\xf7\x12\x6b\x2c\x43\x9b\x3a\x40\x00\x00\x00",
        ),
        accounts: vec![],
        data,
    }
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

/// Anchor custom error code of a vanguard error.
fn vcode(e: VanguardError) -> u32 {
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
    tmatch: APk,
    next_person: u8,
    mref: Option<flow::MatchRef>,
    now: i64,
    last_cu: u64,
    last_logs: Vec<String>,
    /// The compute of the last declare and the last resolve of `mv` and `claim_timeout`.
    declare_cu: u64,
    resolve_cu: u64,
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
        self.run(tx)
    }

    fn run(&mut self, tx: Transaction) -> Result<(), Failed> {
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

    fn person(&mut self) -> Person {
        // Fixed keys: every Env addresses the same Match and Battle, so runs can be compared byte for byte.
        self.next_person += 1;
        let kp = Keypair::new_from_array([self.next_person; 32]);
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
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = t;
        self.svm.set_sysvar(&clock);
    }

    fn slot(&self) -> u64 {
        self.svm.get_sysvar::<Clock>().slot
    }

    /// The next rollup slot: a declare can be resolved from here on.
    fn next_slot(&mut self) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
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

    fn battle(&self) -> Battle {
        self.load(addrs(self.tmatch).battle)
    }
    fn secret(&self) -> Secret {
        self.load(addrs(self.tmatch).secret)
    }
    fn army(&self, seat: usize) -> Army {
        let ad = addrs(self.tmatch);
        self.load(if seat == 0 { ad.army_0 } else { ad.army_1 })
    }

    fn patch_battle(&mut self, f: impl FnOnce(&mut Battle)) {
        let mut b = self.battle();
        f(&mut b);
        let mut data = <Battle as anchor_lang::Discriminator>::DISCRIMINATOR.to_vec();
        data.extend_from_slice(anchor_lang::__private::bytemuck::bytes_of(&b));
        let key = s(addrs(self.tmatch).battle);
        let mut acct = self.svm.get_account(&key).expect("battle");
        acct.data = data;
        self.svm.set_account(key, acct).expect("set battle");
    }
    fn patch_secret(&mut self, f: impl FnOnce(&mut Secret)) {
        let mut v = self.secret();
        f(&mut v);
        self.store(addrs(self.tmatch).secret, &v, vanguard::ID);
    }
    fn patch_army(&mut self, seat: usize, f: impl FnOnce(&mut Army)) {
        let mut v = self.army(seat);
        f(&mut v);
        let ad = addrs(self.tmatch);
        self.store(
            if seat == 0 { ad.army_0 } else { ad.army_1 },
            &v,
            vanguard::ID,
        );
    }

    fn gemas(&self, p: &Person) -> u64 {
        flow::gemas(&self.svm, p.account)
    }

    fn tesoro_status(&self) -> Stage {
        self.load::<MatchState>(self.tmatch).inner.stage()
    }

    fn new() -> Self {
        Self::build(true)
    }

    fn build(sigverify: bool) -> Self {
        let mut svm = LiteSVM::new().with_sigverify(sigverify);
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/");
        for (id, file) in [
            (tesoro_core::ID, "tesoro_core.so"),
            (vanguard::ID, "vanguard.so"),
        ] {
            let path = format!("{root}{file}");
            assert!(
                std::path::Path::new(&path).exists(),
                "build the programs first: pnpm build:programs"
            );
            svm.add_program_from_file(s(id), path)
                .expect("load program");
        }
        // The Magic program is only passed as an account; an executable stands in for it.
        svm.add_program_from_file(sdk_key(MAGIC_PROGRAM_ID), format!("{root}tesoro_core.so"))
            .expect("magic stand-in");
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
            tmatch: APk::default(),
            next_person: 0,
            mref: None,
            now: T0,
            last_cu: 0,
            last_logs: vec![],
            declare_cu: 0,
            resolve_cu: 0,
        };
        for k in [&env.admin, &env.oracle] {
            env.svm.airdrop(&k.pubkey(), 1_000 * SOL).expect("airdrop");
        }
        let mut clock = env.svm.get_sysvar::<Clock>();
        clock.slot = 100;
        env.svm.set_sysvar(&clock);
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
        // The Game authority is the vanguard PDA, not a keypair.
        let ctl = Keypair::new();
        let hash = control_program(&mut env.svm, vanguard::ID, a(ctl.pubkey()));
        let register = ix(
            tesoro_core::ID,
            tesoro_core::accounts::RegisterGame {
                payer: a(admin.pubkey()),
                control: a(ctl.pubkey()),
                config: tpda(&[CONFIG_SEED]),
                game_program: vanguard::ID,
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
                game_program: vanguard::ID,
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
        env.tmatch = tpda(&[b"match", env.alice.account.as_ref(), &0u64.to_le_bytes()]);
        env
    }

    fn open_and_join(&mut self, entry: u64) {
        let (alice, bob) = (dup(&self.alice), dup(&self.bob));
        let m = flow::open_match(&mut self.svm, &alice.kp, vanguard::ID, entry, 1, false, 0)
            .expect("open match");
        flow::join_match(&mut self.svm, &bob.kp, &m, vanguard::ID, 2).expect("join match");
        assert_eq!(m.key, self.tmatch);
        self.mref = Some(m);
    }

    fn run_settlement(&mut self) {
        let m = self.mref.expect("a Match");
        let caller = self.oracle.insecure_clone();
        flow::run_chunks(&mut self.svm, &caller, &m);
    }

    fn create_ix(&self, creator: APk) -> Instruction {
        let ad = addrs(self.tmatch);
        ix(
            vanguard::ID,
            vanguard::accounts::CreateMatch {
                creator,
                tesoro_match: self.tmatch,
                game_record: game_record_pda(),
                vanguard_config: config_pda(),
                account_a: self.alice.account,
                account_b: self.bob.account,
                authority: authority_pda(),
                battle: ad.battle,
                secret: ad.secret,
                army_0: ad.army_0,
                army_1: ad.army_1,
                tesoro_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            vanguard::instruction::CreateMatch {},
            vec![],
        )
    }

    /// The deploy step before any Match: the upgrade authority names the TEE validator and the oracle queue.
    fn ensure_config(&mut self) {
        if self.svm.get_account(&s(config_pda())).is_some() {
            return;
        }
        let admin = self.admin.insecure_clone();
        set_upgrade_authority(self, a(admin.pubkey()));
        self.send(&[set_config_ix(a(admin.pubkey()), TEE)], &admin, &[])
            .expect("set config");
    }

    fn create(&mut self) -> Result<(), Failed> {
        self.ensure_config();
        let alice = self.alice.kp.insecure_clone();
        let ix = self.create_ix(self.alice.key);
        self.send(&[ix], &alice, &[])
    }

    /// Stands in for `delegate_match`, `init_permissions`, both Players' entropy and the VRF callback.
    fn start_in_rollup(&mut self, seed: u8) {
        let now = self.now;
        self.patch_battle(|b| {
            b.status = vanguard::STATUS_SETUP;
            b.permissioned = 1;
            b.entropy_deadline = now + vanguard::ENTROPY_SECS;
        });
        self.patch_secret(|v| {
            v.entropy = [seed.wrapping_add(7); 32];
            v.contributed = [true, true];
            v.vrf_requested = true;
            v.vrf_seen = true;
            v.vrf = [seed.wrapping_add(99); 32];
        });
    }

    fn deal_ix(&self, payer: APk) -> Instruction {
        let ad = addrs(self.tmatch);
        ix(
            vanguard::ID,
            vanguard::accounts::Deal {
                payer,
                battle: ad.battle,
                secret: ad.secret,
                army_0: ad.army_0,
                army_1: ad.army_1,
            },
            vanguard::instruction::Deal {},
            vec![],
        )
    }

    fn deal(&mut self) -> Result<(), Failed> {
        let payer = self.alice.kp.insecure_clone();
        let deal = self.deal_ix(self.alice.key);
        self.send(&[deal], &payer, &[])?;
        // Nothing is declared in the slot of the deal.
        self.next_slot();
        Ok(())
    }

    /// Lay out an explicit Match as `deal` would leave it, with Alice (seat 0) or Bob playing the US Army.
    fn stage(&mut self, layout: &[LayoutPiece], us_seat: u8) {
        let now = self.now;
        let g = Game::start(layout, Side::Us, 99, 12_345, now, CHAIN_CLOCK).expect("layout");
        self.patch_battle(|b| {
            b.us_seat = us_seat;
            b.absorb(&g);
            b.status = vanguard::STATUS_LIVE;
            b.permissioned = 1;
            b.started_at = now;
            b.cap_deadline = g.cap_at;
        });
        for seat in 0..2 {
            let side = if seat == us_seat as usize {
                Side::Us
            } else {
                Side::It
            };
            self.patch_army(seat, |v| v.place(side, layout));
        }
        self.patch_secret(|v| {
            v.contributed = [true, true];
            v.vrf_seen = true;
            v.dealt = true;
            v.storm_at = 99;
            v.storm_seed = 12_345;
        });
    }

    fn player(&self, seat: usize) -> Person {
        dup(if seat == 0 { &self.alice } else { &self.bob })
    }

    fn seat_of_key(&self, key: APk) -> usize {
        usize::from(key == self.bob.key)
    }

    /// What a client sends to seal `plain` for the next declare of `seat`: `plain ^ pad` under the Army's key.
    fn seal(&self, seat: usize, field: u8, plain: u8) -> u8 {
        plain ^ self.pad(seat, self.battle().action_seq, field)
    }

    /// The pad for `(seat, seq, field)` under the Army key stored in the account, as a client would derive it.
    fn pad(&self, seat: usize, seq: u32, field: u8) -> u8 {
        vanguard::engine::seal_pad(
            &self.army(seat).reserved,
            &addrs(self.tmatch).battle.to_bytes(),
            seat as u8,
            seq,
            field,
        )
    }

    fn declare_ix(&self, signer: APk, data: impl InstructionData) -> Instruction {
        ix(
            vanguard::ID,
            vanguard::accounts::Declare {
                player: signer,
                battle: addrs(self.tmatch).battle,
            },
            data,
            vec![],
        )
    }

    /// A move with the switch byte `plain_switch` sealed for the current seq (0 = no switch).
    fn move_ix_switch(&self, signer: APk, piece: u8, to: u8, plain_switch: u8) -> Instruction {
        let seat = self.seat_of_key(signer);
        self.declare_ix(
            signer,
            vanguard::instruction::MovePiece {
                piece,
                to,
                expected_seq: self.battle().action_seq,
                sealed_switch: self.seal(seat, vanguard::engine::SEAL_SWITCH, plain_switch),
            },
        )
    }

    fn move_ix(&self, signer: APk, piece: u8, to: u8) -> Instruction {
        self.move_ix_switch(signer, piece, to, 0)
    }

    fn blast_ix(&self, signer: APk, piece: u8, plain_switch: u8) -> Instruction {
        let seat = self.seat_of_key(signer);
        self.declare_ix(
            signer,
            vanguard::instruction::Blast {
                piece,
                expected_seq: self.battle().action_seq,
                sealed_switch: self.seal(seat, vanguard::engine::SEAL_SWITCH, plain_switch),
            },
        )
    }

    fn rescue_ix(&self, signer: APk, piece: u8, plain_switch: u8) -> Instruction {
        let seat = self.seat_of_key(signer);
        self.declare_ix(
            signer,
            vanguard::instruction::Rescue {
                piece,
                expected_seq: self.battle().action_seq,
                sealed_switch: self.seal(seat, vanguard::engine::SEAL_SWITCH, plain_switch),
            },
        )
    }

    /// A pass sealing `plain_slot` (0 = plain pass, else army slot + 1 to dig in) and `plain_switch`.
    fn pass_ix(&self, signer: APk, plain_slot: u8, plain_switch: u8) -> Instruction {
        let seat = self.seat_of_key(signer);
        self.declare_ix(
            signer,
            vanguard::instruction::Pass {
                expected_seq: self.battle().action_seq,
                sealed_slot: self.seal(seat, vanguard::engine::SEAL_DIG, plain_slot),
                sealed_switch: self.seal(seat, vanguard::engine::SEAL_SWITCH, plain_switch),
            },
        )
    }

    fn resolve_ix(&self, caller: APk) -> Instruction {
        let ad = addrs(self.tmatch);
        ix(
            vanguard::ID,
            vanguard::accounts::Resolve {
                caller,
                battle: ad.battle,
                army_0: ad.army_0,
                army_1: ad.army_1,
                secret: ad.secret,
            },
            vanguard::instruction::Resolve {},
            vec![],
        )
    }

    /// Resolve the pending action in a later slot, as anyone may.
    fn resolve(&mut self, caller: &Keypair) -> Result<(), Failed> {
        self.next_slot();
        let r = self.resolve_ix(a(caller.pubkey()));
        self.send(&[budget(), r], caller, &[])
    }

    /// Declare a move, then resolve it in the next slot. The compute and the logs of both are kept.
    fn mv(&mut self, seat: usize, piece: u8, to: u8) -> Result<(), Failed> {
        let p = self.player(seat);
        let m = self.move_ix(p.key, piece, to);
        self.send(&[budget(), m], &p.kp, &[])?;
        self.declare_cu = self.last_cu;
        let logs = std::mem::take(&mut self.last_logs);
        let r = self.resolve(&p.kp);
        self.resolve_cu = self.last_cu;
        self.last_cu = self.declare_cu + self.resolve_cu;
        self.last_logs.extend(logs);
        r
    }

    fn two_step(&mut self, seat: usize) -> Result<(), Failed> {
        let p = self.player(seat);
        let ad = addrs(self.tmatch);
        let i = ix(
            vanguard::ID,
            vanguard::accounts::StartTwoStep {
                player: p.key,
                battle: ad.battle,
            },
            vanguard::instruction::StartTwoStep {},
            vec![],
        );
        self.send(&[i], &p.kp, &[])
    }

    /// Declare the timeout; in a live Match it is then resolved in the next slot.
    fn claim_timeout(&mut self, caller: &Keypair) -> Result<(), Failed> {
        self.claim_timeout_declare(caller)?;
        if self.battle().pending_kind == vanguard::PENDING_NONE {
            return Ok(());
        }
        self.declare_cu = self.last_cu;
        let r = self.resolve(caller);
        self.resolve_cu = self.last_cu;
        self.last_cu = self.declare_cu + self.resolve_cu;
        r
    }

    fn claim_timeout_declare(&mut self, caller: &Keypair) -> Result<(), Failed> {
        let ad = addrs(self.tmatch);
        let claim = ix(
            vanguard::ID,
            vanguard::accounts::ClaimTimeout {
                caller: a(caller.pubkey()),
                battle: ad.battle,
                secret: ad.secret,
            },
            vanguard::instruction::ClaimTimeout {},
            vec![],
        );
        self.send(&[budget(), claim], caller, &[])
    }

    fn core_refund_ix(&self, caller: APk) -> Instruction {
        ix(
            tesoro_core::ID,
            tesoro_core::accounts::RefundMatch {
                caller,
                payer: caller,
                game_record: game_record_pda(),
                game_program: vanguard::ID,
                program_data: program_data_pda(),
                match_state: self.tmatch,
                receipt: tpda(&[b"settled", self.tmatch.as_ref()]),
                opener_protections: None,
                system_program: anchor_lang::system_program::ID,
                event_authority: tpda(&[b"__event_authority"]),
                program: tesoro_core::ID,
            },
            tesoro_core::instruction::RefundMatch {},
            vec![],
        )
    }

    fn core_settle_ix(&self, signer: APk, result: MatchResult) -> Instruction {
        ix(
            tesoro_core::ID,
            tesoro_core::accounts::SettleMatch {
                game_authority: signer,
                payer: signer,
                config: tpda(&[CONFIG_SEED]),
                game_record: game_record_pda(),
                game_program: vanguard::ID,
                program_data: program_data_pda(),
                match_state: self.tmatch,
                receipt: tpda(&[b"settled", self.tmatch.as_ref()]),
                system_program: anchor_lang::system_program::ID,
                event_authority: tpda(&[b"__event_authority"]),
                program: tesoro_core::ID,
            },
            tesoro_core::instruction::SettleMatch { result },
            vec![],
        )
    }

    fn finalize(&mut self, _refund: bool) -> Result<(), Failed> {
        self.finalize_with(vec![])?;
        self.run_settlement();
        Ok(())
    }

    fn finalize_with(&mut self, remaining: Vec<AccountMeta>) -> Result<(), Failed> {
        let ad = addrs(self.tmatch);
        let caller = self.oracle.insecure_clone();
        let finalize = ix(
            vanguard::ID,
            vanguard::accounts::Finalize {
                caller: a(caller.pubkey()),
                battle: ad.battle,
                tesoro_match: self.tmatch,
                config: tpda(&[CONFIG_SEED]),
                game_record: game_record_pda(),
                authority: authority_pda(),
                game_program: vanguard::ID,
                program_data: program_data_pda(),
                receipt: tpda(&[b"settled", self.tmatch.as_ref()]),
                system_program: anchor_lang::system_program::ID,
                event_authority: tpda(&[b"__event_authority"]),
                tesoro_program: tesoro_core::ID,
            },
            vanguard::instruction::Finalize {},
            remaining,
        );
        self.send(&[finalize], &caller, &[])
    }
}

fn ready() -> Env {
    let mut env = Env::new();
    env.open_and_join(1_000);
    env.create().expect("create match");
    env
}

fn lp(army: Side, rank: u8, sq: u8) -> LayoutPiece {
    LayoutPiece { army, rank, sq }
}

/// A small Match: the US Recon on column 0 faces the Italian Truck at the end of an open file.
fn truck_raid_layout() -> Vec<LayoutPiece> {
    vec![
        lp(Side::Us, RECON, 70),
        lp(Side::Us, GENERAL_OF_THE_ARMY, 95),
        lp(Side::Us, TRUCK, 96),
        lp(Side::It, TRUCK, 20),
        lp(Side::It, GENERAL_OF_THE_ARMY, 5),
        lp(Side::It, BOMB, 6),
    ]
}

fn id_of(sq: u8) -> u8 {
    engine::start_index(sq).expect("start square")
}

use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

fn sdk_key(p: ephemeral_rollups_sdk::compat::Pubkey) -> Pk {
    Pk::new_from_array(p.to_bytes())
}
fn sdk_apk(p: ephemeral_rollups_sdk::compat::Pubkey) -> APk {
    APk::new_from_array(p.to_bytes())
}

fn permission_pda(target: APk) -> APk {
    APk::find_program_address(
        &[PERMISSION_SEED, target.as_ref()],
        &sdk_apk(PERMISSION_PROGRAM_ID),
    )
    .0
}

const TEE: APk = APk::new_from_array([7; 32]);
const QUEUE: APk = APk::new_from_array([8; 32]);

/// Writes the upgrade authority into the vanguard ProgramData account, as a deploy would leave it.
fn set_upgrade_authority(env: &mut Env, authority: APk) {
    let (data_key, _) = Pk::find_program_address(
        &[s(vanguard::ID).as_ref()],
        &s(anchor_lang::solana_program::bpf_loader_upgradeable::ID),
    );
    let mut acct = env.svm.get_account(&data_key).expect("programdata");
    // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }
    acct.data[12] = 1;
    acct.data[13..45].copy_from_slice(authority.as_ref());
    env.svm.set_account(data_key, acct).expect("programdata");
}

fn set_config_ix(authority: APk, validator: APk) -> Instruction {
    let (data_key, _) = Pk::find_program_address(
        &[s(vanguard::ID).as_ref()],
        &s(anchor_lang::solana_program::bpf_loader_upgradeable::ID),
    );
    ix(
        vanguard::ID,
        vanguard::accounts::SetConfig {
            authority,
            config: config_pda(),
            program: vanguard::ID,
            program_data: a(data_key),
            system_program: anchor_lang::system_program::ID,
        },
        vanguard::instruction::SetConfig {
            tee_validator: validator,
            oracle_queue: QUEUE,
        },
        vec![],
    )
}

fn delegate_ix(env: &Env, payer: APk, validator: Option<APk>) -> Instruction {
    let ad = addrs(env.tmatch);
    let dlp = sdk_apk(ephemeral_rollups_sdk::id());
    let derive = |seeds: &[&[u8]], program: &APk| APk::find_program_address(seeds, program).0;
    let buffer = |k: APk| derive(&[b"buffer", k.as_ref()], &vanguard::ID);
    let record = |k: APk| derive(&[b"delegation", k.as_ref()], &dlp);
    let meta = |k: APk| derive(&[b"delegation-metadata", k.as_ref()], &dlp);
    ix(
        vanguard::ID,
        vanguard::accounts::DelegateMatch {
            payer,
            buffer_battle: buffer(ad.battle),
            delegation_record_battle: record(ad.battle),
            delegation_metadata_battle: meta(ad.battle),
            battle: ad.battle,
            buffer_secret: buffer(ad.secret),
            delegation_record_secret: record(ad.secret),
            delegation_metadata_secret: meta(ad.secret),
            secret: ad.secret,
            buffer_army_0: buffer(ad.army_0),
            delegation_record_army_0: record(ad.army_0),
            delegation_metadata_army_0: meta(ad.army_0),
            army_0: ad.army_0,
            buffer_army_1: buffer(ad.army_1),
            delegation_record_army_1: record(ad.army_1),
            delegation_metadata_army_1: meta(ad.army_1),
            army_1: ad.army_1,
            config: config_pda(),
            validator,
            owner_program: vanguard::ID,
            delegation_program: dlp,
            system_program: anchor_lang::system_program::ID,
        },
        vanguard::instruction::DelegateMatch {
            tesoro_match: env.tmatch,
        },
        vec![],
    )
}

fn init_permissions_ix(env: &Env, payer: APk) -> Instruction {
    let ad = addrs(env.tmatch);
    ix(
        vanguard::ID,
        vanguard::accounts::InitPermissions {
            payer,
            battle: ad.battle,
            secret: ad.secret,
            army_0: ad.army_0,
            army_1: ad.army_1,
            battle_permission: permission_pda(ad.battle),
            secret_permission: permission_pda(ad.secret),
            army_0_permission: permission_pda(ad.army_0),
            army_1_permission: permission_pda(ad.army_1),
            permission_program: sdk_apk(PERMISSION_PROGRAM_ID),
            ephemeral_vault: sdk_apk(EPHEMERAL_VAULT_ID),
            magic_program: sdk_apk(MAGIC_PROGRAM_ID),
        },
        vanguard::instruction::InitPermissions {},
        vec![],
    )
}

fn close_match_ix(env: &Env, payer: APk) -> Instruction {
    let ad = addrs(env.tmatch);
    ix(
        vanguard::ID,
        vanguard::accounts::CloseMatch {
            payer,
            battle: ad.battle,
            secret: ad.secret,
            army_0: ad.army_0,
            army_1: ad.army_1,
            battle_permission: permission_pda(ad.battle),
            secret_permission: permission_pda(ad.secret),
            army_0_permission: permission_pda(ad.army_0),
            army_1_permission: permission_pda(ad.army_1),
            permission_program: sdk_apk(PERMISSION_PROGRAM_ID),
            ephemeral_vault: sdk_apk(EPHEMERAL_VAULT_ID),
            magic_context: sdk_apk(ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID),
            magic_program: sdk_apk(MAGIC_PROGRAM_ID),
        },
        vanguard::instruction::CloseMatch {},
        vec![],
    )
}

fn close_unstarted_ix(env: &Env, payer: APk) -> Instruction {
    let ad = addrs(env.tmatch);
    ix(
        vanguard::ID,
        vanguard::accounts::CloseUnstarted {
            payer,
            battle: ad.battle,
            secret: ad.secret,
            army_0: ad.army_0,
            army_1: ad.army_1,
            magic_context: sdk_apk(ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID),
            magic_program: sdk_apk(MAGIC_PROGRAM_ID),
        },
        vanguard::instruction::CloseUnstarted {},
        vec![],
    )
}

// --- Setup: config, create, permissions ---------------------------------------------------------

/// LiteSVM has no permission program, so this checks the flags instead: the permission program takes each
/// hidden account as the writable payer of its permission, and the rollup refuses the whole step with
/// `PrivilegeEscalation` when the Game passes one read-only (the first staging Match, 2026-10-21).
#[test]
fn every_account_given_a_permission_is_writable() {
    let ad = addrs(APk::new_unique());
    let metas = vanguard::accounts::InitPermissions {
        payer: APk::new_unique(),
        battle: ad.battle,
        secret: ad.secret,
        army_0: ad.army_0,
        army_1: ad.army_1,
        battle_permission: permission_pda(ad.battle),
        secret_permission: permission_pda(ad.secret),
        army_0_permission: permission_pda(ad.army_0),
        army_1_permission: permission_pda(ad.army_1),
        permission_program: sdk_apk(PERMISSION_PROGRAM_ID),
        ephemeral_vault: sdk_apk(EPHEMERAL_VAULT_ID),
        magic_program: sdk_apk(MAGIC_PROGRAM_ID),
    }
    .to_account_metas(None);
    for (name, key) in [
        ("battle", ad.battle),
        ("secret", ad.secret),
        ("army_0", ad.army_0),
        ("army_1", ad.army_1),
    ] {
        let meta = metas.iter().find(|m| m.pubkey == key).unwrap();
        assert!(
            meta.is_writable,
            "init_permissions: mark `{name}` #[account(mut)], the permission CPI writes it"
        );
    }
}

#[test]
fn only_the_upgrade_authority_sets_the_tee_validator() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let stranger = env.bob.kp.insecure_clone();
    set_upgrade_authority(&mut env, a(admin.pubkey()));

    let err = env
        .send(&[set_config_ix(a(stranger.pubkey()), TEE)], &stranger, &[])
        .unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotUpgradeAuthority));
    assert!(env.svm.get_account(&s(config_pda())).is_none());

    let err = env
        .send(
            &[set_config_ix(a(admin.pubkey()), APk::default())],
            &admin,
            &[],
        )
        .unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::InvalidValidator));

    // The oracle queue is a setting too, and must be named.
    let mut no_queue = set_config_ix(a(admin.pubkey()), TEE);
    no_queue.data = vanguard::instruction::SetConfig {
        tee_validator: TEE,
        oracle_queue: APk::default(),
    }
    .data();
    let err = env.send(&[no_queue], &admin, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::InvalidValidator));

    env.send(&[set_config_ix(a(admin.pubkey()), TEE)], &admin, &[])
        .expect("authority sets the validator");
    let config: VanguardConfig = env.load(config_pda());
    assert_eq!(config.tee_validator, TEE);
    assert_eq!(config.oracle_queue, QUEUE);
    // It can be changed later, for example on the way to mainnet.
    let other = APk::new_unique();
    env.send(&[set_config_ix(a(admin.pubkey()), other)], &admin, &[])
        .expect("authority changes the validator");
    assert_eq!(
        env.load::<VanguardConfig>(config_pda()).tee_validator,
        other
    );
}

/// Delegation names the TEE validator the config holds: the validator a delegation names is the only key that can
/// commit state back, so a caller-chosen validator (or none, which the delegation program reads as the public
/// default validator) would let a Player commit a Battle they won, or leave the Armies outside the TEE.
#[test]
fn delegation_is_pinned_to_the_configured_validator() {
    let mut env = ready();
    let attacker = env.bob.kp.insecure_clone();
    for validator in [Some(a(attacker.pubkey())), None] {
        let delegate = delegate_ix(&env, a(attacker.pubkey()), validator);
        let err = env.send(&[delegate], &attacker, &[]).unwrap_err();
        assert_eq!(
            custom_code(&err),
            vcode(VanguardError::InvalidValidator),
            "validator {validator:?} must be refused"
        );
    }
}

/// `delegate_match` is permissionless, so once the Battle is committed back anyone could delegate it again and
/// `finalize` could no longer read it. A Battle delegates once, while it is freshly created.
#[test]
fn a_battle_that_has_been_played_cannot_be_delegated_again() {
    let mut env = ready();
    for status in [vanguard::STATUS_OVER, vanguard::STATUS_CANCELLED] {
        env.patch_battle(|b| b.status = status);
        let attacker = env.bob.kp.insecure_clone();
        let delegate = delegate_ix(&env, a(attacker.pubkey()), Some(TEE));
        let err = env.send(&[delegate], &attacker, &[]).unwrap_err();
        assert_eq!(custom_code(&err), vcode(VanguardError::AlreadyStarted));
    }
}

/// A Battle nobody delegated before its start window closed is a no-show: `finalize` refunds it on the base layer,
/// so delegating it then would only strand it in the rollup.
#[test]
fn a_battle_cannot_be_delegated_after_its_start_window() {
    let mut env = ready();
    let start_deadline = env.battle().start_deadline;
    env.set_time(start_deadline + 1);
    let payer = env.bob.kp.insecure_clone();
    let delegate = delegate_ix(&env, a(payer.pubkey()), Some(TEE));
    let err = env.send(&[delegate], &payer, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotLive));
    env.set_time(start_deadline);
    let delegate = delegate_ix(&env, a(payer.pubkey()), Some(TEE));
    // The delegation program is not loaded here: whatever happens next, the window is not what refuses it.
    if let Err(err) = env.send(&[delegate], &payer, &[]) {
        use solana_sdk::instruction::InstructionError;
        use solana_sdk::transaction::TransactionError;
        assert!(
            !matches!(&err.err, TransactionError::InstructionError(_, InstructionError::Custom(c)) if *c == vcode(VanguardError::NotLive)),
            "the last second of the window must pass the window check"
        );
    }
}

/// A permission address that already holds lamports is not a permission: anyone can send some to the predictable
/// address, which would mark a hidden account ready without ever making it private.
#[test]
fn a_prefunded_permission_address_is_not_a_permission() {
    let mut env = ready();
    let ad = addrs(env.tmatch);
    for target in [ad.battle, ad.secret, ad.army_0, ad.army_1] {
        env.svm
            .airdrop(&s(permission_pda(target)), 1_000_000)
            .expect("dust");
    }
    let payer = env.bob.kp.insecure_clone();
    let init = init_permissions_ix(&env, a(payer.pubkey()));
    let err = env.send(&[init], &payer, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::PermissionNotReady));
    assert_eq!(env.battle().status, vanguard::STATUS_CREATED);
}

/// tesoro_core makes an Active Match refundable by anyone one hour after it turns Active. `create_match` pushes
/// that deadline a full table window out; only then can a stranger refund.
#[test]
fn create_match_pushes_the_refund_deadline_a_full_table_window_out() {
    let mut env = ready();
    let deadline = env.load::<MatchState>(env.tmatch).inner.deadline;
    assert_eq!(deadline, T0 + vanguard::TABLE_WINDOW_SECS);
    env.set_time(T0 + tesoro_core::ledger::MATCH_TIMEOUT_SECS + 1);
    let caller = env.bob.kp.insecure_clone();
    let refund = env.core_refund_ix(a(caller.pubkey()));
    let err = env
        .send(std::slice::from_ref(&refund), &caller, &[])
        .unwrap_err();
    assert_eq!(
        custom_code(&err),
        tesoro_core::error::CORE_ERROR_OFFSET + tesoro_core::ledger::CoreError::NotExpired.code()
    );
    assert_eq!(env.tesoro_status(), Stage::Active);
    env.set_time(deadline);
    env.send(&[refund], &caller, &[])
        .expect("anyone refunds once the table window is over");
    env.run_settlement();
    assert_eq!(env.tesoro_status(), Stage::Closed);
}

#[test]
fn create_match_binds_the_tesoro_match_and_rejects_impostors() {
    let mut env = Env::new();
    let alice = env.alice.kp.insecure_clone();
    // No tesoro Match yet: nothing to bind.
    let too_early = env.create_ix(env.alice.key);
    assert!(env.send(&[too_early], &alice, &[]).is_err());

    env.open_and_join(1_000);
    // Before the deploy step (set_config) there is nothing to create a Battle from.
    let early = env.create_ix(env.alice.key);
    assert!(env.send(&[early], &alice, &[]).is_err());
    assert!(env.svm.get_account(&s(addrs(env.tmatch).battle)).is_none());
    env.ensure_config();
    let stranger = Keypair::new();
    env.svm
        .airdrop(&stranger.pubkey(), 10 * SOL)
        .expect("airdrop");
    let bad = env.create_ix(a(stranger.pubkey()));
    let err = env.send(&[bad], &stranger, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotAPlayer));

    env.create().expect("create");
    let b = env.battle();
    assert_eq!(b.players, [env.alice.key, env.bob.key]);
    assert_eq!(b.tesoro_match, env.tmatch);
    assert_eq!(b.status, vanguard::STATUS_CREATED);
    assert_eq!(b.start_deadline, T0 + vanguard::START_WINDOW_SECS);
    assert_eq!(b.us_seat, vanguard::UNSET);
    assert_eq!(b.sq, [vanguard::NO_SQ; PIECE_SLOTS]);
    let (_, bump) = APk::find_program_address(&[vanguard::AUTHORITY_SEED], &vanguard::ID);
    assert_eq!(b.authority_bump, bump);
    // The private accounts exist and are empty.
    assert_eq!(env.secret().entropy, [0; 32]);
    let army = env.army(1);
    assert_eq!((army.player, army.ranks), (env.bob.key, [0; 30]));
    // Each account holds the permission rent it needs before it is delegated.
    let rent = ephemeral_rollups_sdk::ephemeral_accounts::rent(
        ephemeral_rollups_sdk::access_control::structs::EphemeralPermission::size_of(2) as u32,
    );
    let ad = addrs(env.tmatch);
    for k in [ad.battle, ad.secret, ad.army_0, ad.army_1] {
        assert!(env.svm.get_account(&s(k)).expect("account").lamports >= rent);
    }
}

#[test]
fn only_active_matches_may_be_bound() {
    let mut env = Env::new();
    let alice = env.alice.kp.insecure_clone();
    flow::open_match(&mut env.svm, &alice, vanguard::ID, 1_000, 1, false, 0).expect("open only");
    let create = env.create_ix(env.alice.key);
    assert!(env.send(&[create], &alice, &[]).is_err());
    assert!(env.svm.get_account(&s(addrs(env.tmatch).battle)).is_none());
}

#[test]
fn the_account_sizes_are_what_the_docs_say() {
    let mut env = ready();
    let ad = addrs(env.tmatch);
    let size = |env: &mut Env, k: APk| env.svm.get_account(&s(k)).expect("account").data.len();
    let sizes = (
        size(&mut env, ad.battle),
        size(&mut env, ad.army_0),
        size(&mut env, ad.secret),
    );
    println!(
        "SIZES battle {} army {} secret {}",
        sizes.0, sizes.1, sizes.2
    );
    assert!(sizes.0 <= 10_240);
    assert_eq!(sizes.0, 8 + core::mem::size_of::<Battle>());
}

// --- Setup: the draw -----------------------------------------------------------------------------

#[test]
fn deal_needs_both_secrets_and_the_randomness_and_runs_once() {
    let mut env = ready();
    // Not in the setup phase yet.
    let err = env.deal().unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::WrongPhase));
    env.start_in_rollup(1);
    env.patch_secret(|v| v.vrf_seen = false);
    let err = env.deal().unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::EntropyIncomplete));
    env.patch_secret(|v| v.vrf_seen = true);
    env.deal().expect("deal");
    let err = env.deal().unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::WrongPhase));
}

#[test]
fn deal_draws_the_armies_into_the_private_accounts_and_nothing_hidden_into_the_battle() {
    for seed in 0..12u8 {
        let mut env = ready();
        env.start_in_rollup(seed);
        env.set_time(T0 + 30);
        env.deal().expect("deal");
        let b = env.battle();
        assert_eq!(b.status, vanguard::STATUS_LIVE);
        assert!(b.us_seat < 2);
        assert_eq!(b.turn, 0, "the US Army moves first");
        assert_eq!(b.started_at, T0 + 30);
        assert_eq!(
            b.deadline,
            T0 + 30 + engine::TURN_SECS + engine::GRACE_SECS + OPENING_GRACE_SECS,
            "the opening turn has extra seconds: the first mover has not loaded their Army yet"
        );
        assert_eq!(b.shown, [0; PIECE_SLOTS], "no rank is public at the start");
        assert_eq!(b.sq.iter().filter(|q| **q != vanguard::NO_SQ).count(), 40);
        let secret = env.secret();
        assert!(secret.dealt);
        assert!((engine::STORM_FROM..=engine::STORM_TO).contains(&secret.storm_at));
        for seat in 0..2 {
            let army = env.army(seat);
            let side = b.side_of_seat(seat).expect("sides drawn");
            assert_eq!(army.side, side.idx() as u8);
            assert_eq!(army.ranks.iter().filter(|r| **r != 0).count(), 20);
            for (rank, count) in engine::ROSTER {
                assert_eq!(
                    army.ranks.iter().filter(|r| **r == rank).count(),
                    count as usize
                );
            }
            // A piece's rank is stored under its start-square number, in its own army's half.
            let base = if side == Side::Us { 30 } else { 0 };
            for i in 0..30 {
                assert_eq!(
                    army.ranks[i] != 0,
                    b.sq[base + i] != vanguard::NO_SQ,
                    "seed {seed} piece {}",
                    base + i
                );
            }
        }
    }
}

#[test]
fn the_same_secrets_deal_the_same_match_and_other_secrets_a_different_one() {
    let deal_with = |seed: u8| {
        let mut env = ready();
        env.start_in_rollup(seed);
        env.deal().expect("deal");
        (env.battle().us_seat, env.army(0).ranks, env.army(1).ranks)
    };
    assert_eq!(deal_with(3), deal_with(3));
    assert_ne!(deal_with(3), deal_with(4));
}

/// The VRF callback only stores the output, and only while the Battle is still waiting to start. A late output
/// after a cancel can never start the Match. LiteSVM cannot sign for the VRF program's identity PDA, so this test
/// runs without signature verification (the transaction names the identity as a signer).
#[test]
fn a_late_vrf_after_a_cancel_cannot_start_the_match() {
    let mut env = Env::build(false);
    env.open_and_join(1_000);
    env.create().expect("create");
    env.start_in_rollup(1);
    env.patch_secret(|v| {
        v.vrf_seen = false;
        v.vrf = [0; 32];
    });
    let identity = sdk_apk(ephemeral_rollups_sdk::vrf::consts::scoped_vrf_identity(
        &ephemeral_rollups_sdk::compat::Pubkey::new_from_array(vanguard::ID.to_bytes()),
    ));
    let callback = |env: &Env, randomness: [u8; 32]| {
        let ad = addrs(env.tmatch);
        ix(
            vanguard::ID,
            vanguard::accounts::VrfCallbackStore {
                vrf_program_identity: identity,
                secret: ad.secret,
                battle: ad.battle,
            },
            vanguard::instruction::VrfCallbackStore { randomness },
            vec![],
        )
    };
    let send_callback = |env: &mut Env, randomness: [u8; 32]| {
        let payer = env.oracle.insecure_clone();
        let i = callback(env, randomness);
        env.svm.expire_blockhash();
        let mut tx = Transaction::new_unsigned(Message::new(&[i], Some(&payer.pubkey())));
        tx.partial_sign(&[&payer], env.svm.latest_blockhash());
        env.run(tx)
    };

    // A first output is stored (and a second one refused).
    send_callback(&mut env, [9; 32]).expect("the output is stored");
    assert!(env.secret().vrf_seen);
    assert_eq!(env.secret().vrf, [9; 32]);
    let err = send_callback(&mut env, [8; 32]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::AlreadyDealt));

    // Past the setup deadline an output is refused too.
    env.patch_secret(|v| {
        v.vrf_seen = false;
        v.vrf = [0; 32];
    });
    let setup_deadline = env.battle().setup_deadline;
    env.set_time(setup_deadline + 1);
    let err = send_callback(&mut env, [6; 32]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::SetupClosed));
    assert!(!env.secret().vrf_seen);

    // Cancelled while the output was late: a delivery afterwards stores nothing and starts nothing.
    env.patch_secret(|v| {
        v.vrf_seen = false;
        v.vrf = [0; 32];
    });
    env.set_time(T0 + vanguard::ENTROPY_SECS + 1);
    env.patch_secret(|v| v.contributed = [true, false]);
    let caller = env.bob.kp.insecure_clone();
    env.claim_timeout(&caller).expect("cancel");
    assert_eq!(env.battle().status, vanguard::STATUS_CANCELLED);
    env.patch_secret(|v| v.contributed = [true, true]);
    let err = send_callback(&mut env, [5; 32]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::WrongPhase));
    assert!(!env.secret().vrf_seen);
    let err = env.deal().unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::WrongPhase));
    assert_eq!(env.battle().status, vanguard::STATUS_CANCELLED);
}

#[test]
fn both_players_fold_secrets_in_and_nobody_else_can() {
    let mut env = ready();
    let contribute = |env: &mut Env, signer: &Keypair, secret: [u8; 32]| {
        let ad = addrs(env.tmatch);
        let i = ix(
            vanguard::ID,
            vanguard::accounts::ContributeEntropy {
                player: a(signer.pubkey()),
                battle: ad.battle,
                secret: ad.secret,
            },
            vanguard::instruction::ContributeEntropy { secret },
            vec![],
        );
        env.send(&[i], signer, &[])
    };
    let (alice, bob) = (env.alice.kp.insecure_clone(), env.bob.kp.insecure_clone());
    // Permissions do not exist yet.
    let err = contribute(&mut env, &alice, [1; 32]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::WrongPhase));

    env.start_in_rollup(1);
    env.patch_secret(|v| {
        v.entropy = [0; 32];
        v.contributed = [false; 2];
        v.vrf_seen = false;
        v.vrf = [0; 32];
    });
    let stranger = Keypair::new();
    env.svm
        .airdrop(&stranger.pubkey(), 10 * SOL)
        .expect("airdrop");
    let err = contribute(&mut env, &stranger, [3; 32]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotAPlayer));

    contribute(&mut env, &alice, [1; 32]).expect("alice");
    let after_alice = env.secret();
    assert_eq!(after_alice.contributed, [true, false]);
    assert_ne!(after_alice.entropy, [0; 32]);
    assert_ne!(
        after_alice.entropy, [1; 32],
        "the secret itself is never stored"
    );
    let err = contribute(&mut env, &alice, [9; 32]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::AlreadyContributed));
    assert_eq!(env.secret().entropy, after_alice.entropy);

    contribute(&mut env, &bob, [2; 32]).expect("bob");
    let both = env.secret();
    assert_eq!(both.contributed, [true, true]);
    assert_ne!(both.entropy, after_alice.entropy);
    // Not dealt without the randomness; anyone deals once it arrives.
    let err = env.deal().unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::EntropyIncomplete));
    env.patch_secret(|v| {
        v.vrf_seen = true;
        v.vrf = [4; 32];
    });
    let deal = env.deal_ix(a(stranger.pubkey()));
    env.send(&[deal], &stranger, &[]).expect("anyone may deal");
    assert_eq!(env.battle().status, vanguard::STATUS_LIVE);
}

// --- Playing -------------------------------------------------------------------------------------

#[test]
fn a_full_match_to_a_truck_capture_pays_the_winner_the_pot_minus_fees() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.stage(&truck_raid_layout(), 0);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    assert_eq!(before.0 + before.1, 2 * 75_000 - 2_000, "entries in escrow");

    env.set_time(T0 + 2);
    // Alice (US, to move) runs the Recon the length of the file onto the Truck.
    env.mv(0, id_of(70), 20).expect("capture the Truck");
    let b = env.battle();
    assert_eq!(b.status, vanguard::STATUS_OVER);
    assert_eq!(b.winner, 0);
    assert_eq!(b.reason, vanguard::reason_code(EndReason::Truck));
    // The ending reveals every remaining piece; the beaten Truck is shown with its rank.
    assert_eq!(b.shown[id_of(20) as usize], TRUCK);
    assert_eq!(b.shown[id_of(70) as usize], RECON);
    assert_eq!(b.shown[id_of(95) as usize], GENERAL_OF_THE_ARMY);
    assert_eq!(env.army(0).moves, 1);
    assert_eq!(env.army(1).moves, 0);
    // The event ring holds the attack, then the end.
    let attack = &b.ring[0];
    assert_eq!(attack.kind, vanguard::EVENT_ATTACK);
    assert_eq!(
        attack.data[4],
        vanguard::outcome_code(engine::Outcome::Truck)
    );
    assert_eq!(b.ring[1].kind, vanguard::EVENT_END);
    assert_eq!(b.event_seq, 2);
    // The Match is over: nothing moves any more.
    let err = env.mv(1, id_of(5), 15).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotLive));

    env.finalize(false).expect("finalize");
    assert_eq!(env.tesoro_status(), Stage::Closed);
    assert_eq!(env.gemas(&env.alice), before.0 + 1_900);
    assert_eq!(env.gemas(&env.bob), before.1);
    assert_eq!(env.battle().finalized, 1);
}

#[test]
fn the_other_seat_can_play_the_us_army_and_win() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.stage(&truck_raid_layout(), 1);
    env.set_time(T0 + 2);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    // Alice plays Italy and is not to move.
    let err = env.mv(0, id_of(5), 15).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotYourTurn));
    env.mv(1, id_of(70), 20).expect("Bob captures the Truck");
    assert_eq!(env.battle().winner, 1);
    env.finalize(false).expect("finalize");
    assert_eq!(env.gemas(&env.alice), before.0);
    assert_eq!(env.gemas(&env.bob), before.1 + 1_900);
}

#[test]
fn a_winning_attacker_and_a_winning_defender_stay_hidden() {
    let mut env = ready();
    env.start_in_rollup(1);
    // The US Spy (1) attacks nothing here; a US Recon (2) takes the Italian Spy (1) and the Italian General (10)
    // later hits a hidden piece.
    let layout = vec![
        lp(Side::Us, RECON, 70),
        lp(Side::Us, TRUCK, 96),
        lp(Side::Us, BOMB, 97),
        lp(Side::It, SPY, 20),
        lp(Side::It, GENERAL_OF_THE_ARMY, 5),
        lp(Side::It, TRUCK, 6),
    ];
    env.stage(&layout, 0);
    env.set_time(T0 + 2);
    env.mv(0, id_of(70), 20).expect("Recon takes the Spy");
    let b = env.battle();
    assert_eq!(b.status, vanguard::STATUS_LIVE);
    assert_eq!(
        b.shown[id_of(20) as usize],
        SPY,
        "the beaten piece is shown"
    );
    assert_eq!(b.sq[id_of(20) as usize], vanguard::NO_SQ);
    assert_eq!(
        b.shown[id_of(70) as usize],
        0,
        "the winning attacker stays hidden"
    );
    assert_eq!(b.sq[id_of(70) as usize], 20);
    assert_eq!(b.turn, 1);
    // Everything hidden still is hidden: only the Spy's rank is public.
    assert_eq!(b.shown.iter().filter(|r| **r != 0).count(), 1);
    // The Italian General now takes the Recon that stands at 20? It is four squares away: one step toward it.
    env.set_time(T0 + 3);
    env.mv(1, id_of(5), 15).expect("Italy steps");
    assert_eq!(env.battle().shown.iter().filter(|r| **r != 0).count(), 1);
}

#[test]
fn refusals_are_generic_and_change_nothing() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.stage(&truck_raid_layout(), 0);
    env.set_time(T0 + 2);
    let before = env.battle();
    let stranger = Keypair::new();
    env.svm
        .airdrop(&stranger.pubkey(), 10 * SOL)
        .expect("airdrop");

    // A non-player.
    let m = env.move_ix(a(stranger.pubkey()), id_of(70), 60);
    let err = env.send(&[budget(), m], &stranger, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotAPlayer));
    // The wrong turn: Bob plays Italy and Alice is to move.
    let err = env.mv(1, id_of(5), 15).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotYourTurn));
    // Someone else's piece, on my own turn.
    let err = env.mv(0, id_of(5), 15).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotYourTurn));
    // An empty slot.
    let err = env.mv(0, id_of(80), 70).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::IllegalMove));
    // Onto my own piece, into a wadi, off the board, off every line a piece could walk: public geometry, refused when declared.
    for (piece, to) in [
        (id_of(95), 96),
        (id_of(70), 42),
        (id_of(70), 100),
        (id_of(95), 87),
    ] {
        let err = env.mv(0, piece, to).unwrap_err();
        assert_eq!(
            custom_code(&err),
            vcode(VanguardError::IllegalMove),
            "{piece} -> {to}"
        );
    }
    // Nothing was written by any of these.
    assert_eq!(
        anchor_lang::__private::bytemuck::bytes_of(&env.battle()),
        anchor_lang::__private::bytemuck::bytes_of(&before)
    );
}

/// The rank rules are applied when the move is resolved, so the declare of a Landmine's move or of a Truck's with no
/// fuel left is accepted (it answers the same for every rank) and the move costs the turn.
#[test]
fn a_truck_out_of_fuel_cannot_move_and_a_landmine_never_does() {
    let mut env = ready();
    env.start_in_rollup(1);
    let layout = vec![
        lp(Side::Us, TRUCK, 96),
        lp(Side::Us, BOMB, 97),
        lp(Side::Us, ENGINEER, 90),
        lp(Side::It, GENERAL_OF_THE_ARMY, 5),
        lp(Side::It, TRUCK, 6),
    ];
    env.stage(&layout, 0);
    env.set_time(T0 + 2);
    env.patch_army(0, |v| v.fuel = engine::TRUCK_FUEL);
    env.mv(0, id_of(96), 86).expect("declared and resolved");
    let b = env.battle();
    assert_eq!(
        (b.turn, b.timeouts, b.moves),
        (1, [1, 0], 0),
        "no fuel: the turn is lost, nothing moved"
    );
    assert_eq!(b.sq[id_of(96) as usize], 96);
    assert_eq!(b.ring[0].kind, vanguard::EVENT_TURN);
    assert_eq!(
        b.ring[0].data[1], 1,
        "the turn event says timed out, like any lost turn"
    );
    // Italy moves; the Landmine "moves" and the turn is lost again.
    env.mv(1, id_of(5), 15).expect("Italy moves");
    env.mv(0, id_of(97), 87).expect("declared and resolved");
    let b = env.battle();
    assert_eq!(
        (b.turn, b.timeouts, b.sq[id_of(97) as usize]),
        (1, [2, 0], 97)
    );
    // With fuel left, the Truck moves, and the Army account records the fuel and the turn.
    env.mv(1, id_of(5), 25).expect("Italy moves");
    env.patch_army(0, |v| v.fuel = 1);
    env.mv(0, id_of(96), 86).expect("Truck moves");
    let b = env.battle();
    assert_eq!((b.sq[id_of(96) as usize], b.timeouts), (86, [0, 0]));
    let army = env.army(0);
    assert_eq!(army.fuel, 2);
    assert_eq!(army.truck_turn, 4);
}

#[test]
fn moves_write_no_logs_and_two_step_turns_work() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.stage(&truck_raid_layout(), 0);
    env.set_time(T0 + 2);
    // No Two-Step Turn banked.
    let err = env.two_step(0).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NoTwoStep));
    env.patch_battle(|b| b.two_step[0] = 1);
    // Only the Player to act may spend it.
    let err = env.two_step(1).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotYourTurn));
    let deadline = env.battle().deadline;
    env.two_step(0).expect("spend a Two-Step Turn");
    let b = env.battle();
    assert_eq!(b.two_step_active, 1);
    assert_eq!(b.two_step, [0, 0]);
    assert_eq!(b.steps_left, 2);
    assert_eq!(
        b.deadline, deadline,
        "starting it does not move the deadline"
    );

    env.set_time(T0 + 3);
    env.mv(0, id_of(96), 86).expect("first step with the Truck");
    assert!(
        env.last_logs.iter().all(|l| !l.starts_with("Program log:")),
        "a declare and a resolve write no logs: {:?}",
        env.last_logs
    );
    let b = env.battle();
    assert_eq!(b.turn, 0, "the second step is still Alice's");
    assert_eq!(b.steps_left, 1);
    assert_eq!(
        b.deadline,
        T0 + 3 + engine::TURN_SECS + engine::GRACE_SECS,
        "each step gets a full turn"
    );
    env.mv(0, id_of(95), 85)
        .expect("second step with another piece");
    assert_eq!(env.battle().turn, 1);
    assert_eq!(env.battle().two_step_active, 0);
}

/// The Truck cannot take both steps of a Two-Step Turn: the second declare passes, the resolve loses the turn.
#[test]
fn the_truck_cannot_take_both_steps_of_a_two_step_turn() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.stage(&truck_raid_layout(), 0);
    env.set_time(T0 + 2);
    env.patch_battle(|b| b.two_step[0] = 1);
    env.two_step(0).expect("spend it");
    env.mv(0, id_of(96), 86).expect("first step");
    env.mv(0, id_of(96), 76)
        .expect("declared, then refused by the rank rules");
    let b = env.battle();
    assert_eq!(
        (b.turn, b.timeouts, b.sq[id_of(96) as usize]),
        (1, [1, 0], 86)
    );
}

#[test]
fn the_cap_comes_first_and_ends_the_match_on_the_tiebreak() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.stage(&truck_raid_layout(), 0);
    let started = env.now;
    // Move at exactly the cap is fine; one second later the Match cannot go on.
    env.set_time(started + engine::CAP_SECS + 1);
    let err = env.mv(0, id_of(70), 60).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::CapPassed));
    let err = env.two_step(0).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::CapPassed));
    // Anyone ends it. Alice's General, Recon and Truck against Italy's General and Truck: Alice has more.
    let caller = env.bob.kp.insecure_clone();
    env.claim_timeout(&caller).expect("the cap ends it");
    let b = env.battle();
    assert_eq!(b.status, vanguard::STATUS_OVER);
    assert_eq!(b.reason, vanguard::reason_code(EndReason::Cap));
    assert_eq!(b.winner, 0);
    assert!(b
        .sq
        .iter()
        .zip(b.shown.iter())
        .all(|(q, r)| (*q == vanguard::NO_SQ) || *r != 0));
    let err = env.claim_timeout(&caller).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::MatchOver));
}

#[test]
fn a_draw_refunds_both_entries_with_no_fees() {
    let mut env = ready();
    env.start_in_rollup(1);
    let layout = vec![
        lp(Side::Us, GENERAL_OF_THE_ARMY, 95),
        lp(Side::Us, TRUCK, 96),
        lp(Side::It, GENERAL_OF_THE_ARMY, 5),
        lp(Side::It, TRUCK, 6),
    ];
    env.stage(&layout, 0);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.set_time(env.now + engine::CAP_SECS + 1);
    let caller = env.oracle.insecure_clone();
    env.claim_timeout(&caller).expect("the cap ends it");
    let b = env.battle();
    assert_eq!(b.winner, vanguard::DRAW);
    assert_eq!(b.status, vanguard::STATUS_OVER);

    env.finalize(true).expect("a draw refunds");
    assert_eq!(env.tesoro_status(), Stage::Closed);
    assert_eq!(env.gemas(&env.alice), before.0 + 1_000);
    assert_eq!(env.gemas(&env.bob), before.1 + 1_000);
}

#[test]
fn three_timeouts_in_a_row_lose_the_match() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.stage(&truck_raid_layout(), 0);
    let caller = env.bob.kp.insecure_clone();
    // Too early.
    env.set_time(env.battle().deadline);
    let err = env.claim_timeout(&caller).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotTimedOut));
    // Alice idles; so does Bob; Alice idles again... three of Alice's in a row lose.
    for expected in [[1u8, 0], [1, 1], [2, 1], [2, 2]] {
        env.set_time(env.battle().deadline + 1);
        env.claim_timeout(&caller).expect("timeout");
        assert_eq!(env.battle().timeouts, expected);
    }
    env.set_time(env.battle().deadline + 1);
    env.claim_timeout(&caller).expect("third timeout");
    let b = env.battle();
    assert_eq!(b.status, vanguard::STATUS_OVER);
    assert_eq!(b.winner, 1);
    assert_eq!(b.reason, vanguard::reason_code(EndReason::Timeouts));
}

// --- Endings -------------------------------------------------------------------------------------

#[test]
fn a_no_show_refunds_both_entries() {
    let mut env = ready();
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    // Too early: the start window is still open.
    let err = env.finalize_with(vec![]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotTimedOut));
    env.set_time(T0 + vanguard::START_WINDOW_SECS + 1);
    env.finalize(true).expect("no-show refund via tesoro_core");
    assert_eq!(env.tesoro_status(), Stage::Closed);
    assert_eq!(env.gemas(&env.alice), before.0 + 1_000);
    assert_eq!(env.gemas(&env.bob), before.1 + 1_000);
}

#[test]
fn a_player_who_never_contributes_entropy_cancels_the_match_and_both_are_refunded() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.patch_secret(|v| {
        v.contributed = [true, false];
        v.vrf_seen = false;
    });
    let bob = env.bob.kp.insecure_clone();
    let err = env.claim_timeout(&bob).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotTimedOut));
    env.set_time(T0 + vanguard::ENTROPY_SECS + 1);
    env.claim_timeout(&bob)
        .expect("anyone may claim the timeout");
    assert_eq!(env.battle().status, vanguard::STATUS_CANCELLED);
    // A cancelled Match plays no more.
    let err = env.deal().unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::WrongPhase));

    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize(true).expect("refund");
    assert_eq!(env.tesoro_status(), Stage::Closed);
    assert_eq!(env.gemas(&env.alice), before.0 + 1_000);
    assert_eq!(env.gemas(&env.bob), before.1 + 1_000);
}

#[test]
fn late_randomness_does_not_cancel_the_match_it_pushes_the_deadline() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.patch_secret(|v| v.vrf_seen = false);
    let caller = env.bob.kp.insecure_clone();
    env.set_time(T0 + vanguard::ENTROPY_SECS + 1);
    env.claim_timeout(&caller).expect("claim");
    let b = env.battle();
    assert_eq!(b.status, vanguard::STATUS_SETUP);
    assert_eq!(
        b.entropy_deadline,
        T0 + vanguard::ENTROPY_SECS + 1 + vanguard::ENTROPY_SECS
    );
}

#[test]
fn a_second_finalize_is_refused() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.stage(&truck_raid_layout(), 0);
    env.set_time(T0 + 2);
    env.mv(0, id_of(70), 20).expect("capture");
    env.finalize(false).expect("finalize");
    let after = (env.gemas(&env.alice), env.gemas(&env.bob));
    let err = env.finalize_with(vec![]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::AlreadyFinalized));
    assert_eq!((env.gemas(&env.alice), env.gemas(&env.bob)), after);
}

#[test]
fn finalize_marks_a_match_tesoro_core_already_refunded_and_moves_nothing() {
    let mut env = ready();
    let deadline = env.load::<MatchState>(env.tmatch).inner.deadline;
    env.set_time(deadline);
    let caller = env.bob.kp.insecure_clone();
    let refund = env.core_refund_ix(a(caller.pubkey()));
    env.send(&[refund], &caller, &[])
        .expect("tesoro_core refund");
    env.run_settlement();
    assert_eq!(env.tesoro_status(), Stage::Closed);
    let after = (env.gemas(&env.alice), env.gemas(&env.bob));

    env.finalize_with(vec![]).expect("finalize still works");
    assert_eq!(env.battle().finalized, 1);
    assert_eq!((env.gemas(&env.alice), env.gemas(&env.bob)), after);
    let err = env.finalize_with(vec![]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::AlreadyFinalized));
}

#[test]
fn a_match_not_yet_over_cannot_be_finalized_and_only_the_authority_pda_settles() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.stage(&truck_raid_layout(), 0);
    let err = env.finalize_with(vec![]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::MatchNotOver));

    let intruder = Keypair::new();
    env.svm
        .airdrop(&intruder.pubkey(), 10 * SOL)
        .expect("airdrop");
    let settle = env.core_settle_ix(a(intruder.pubkey()), MatchResult::Opener);
    let err = env.send(&[settle], &intruder, &[]).unwrap_err();
    assert_eq!(custom_code(&err), 6000);
    let record = env.load::<GameRecord>(game_record_pda());
    assert_eq!(record.settle_authority, authority_pda());
}

#[test]
fn close_match_before_the_end_is_refused_and_close_unstarted_needs_a_cancel() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.stage(&truck_raid_layout(), 0);
    let payer = env.bob.kp.insecure_clone();
    for status in [
        vanguard::STATUS_CREATED,
        vanguard::STATUS_SETUP,
        vanguard::STATUS_LIVE,
    ] {
        env.patch_battle(|b| b.status = status);
        let close = close_match_ix(&env, a(payer.pubkey()));
        let err = env.send(&[close], &payer, &[]).unwrap_err();
        assert_eq!(custom_code(&err), vcode(VanguardError::MatchNotOver));
        let close = close_unstarted_ix(&env, a(payer.pubkey()));
        let err = env.send(&[close], &payer, &[]).unwrap_err();
        assert_eq!(custom_code(&err), vcode(VanguardError::MatchNotOver));
    }
    // A cancel that happened after the permissions exist is closed by `close_match`, not `close_unstarted`.
    env.patch_battle(|b| b.status = vanguard::STATUS_CANCELLED);
    let close = close_unstarted_ix(&env, a(payer.pubkey()));
    let err = env.send(&[close], &payer, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::MatchNotOver));
    // And one that never had permissions is refused by `close_match`.
    env.patch_battle(|b| b.permissioned = 0);
    let close = close_match_ix(&env, a(payer.pubkey()));
    let err = env.send(&[close], &payer, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::WrongPhase));
}

// --- A whole dealt Match -------------------------------------------------------------------------

/// Every legal (piece, square) of the army to act, found with the engine's own scan.
fn legal_moves(env: &Env) -> Vec<(u8, u8)> {
    let b = env.battle();
    let secret = env.secret();
    let (a0, a1) = (env.army(0), env.army(1));
    let g = b.game([&a0, &a1], &secret).expect("game");
    let army = if b.turn == 0 { Side::Us } else { Side::It };
    let mut out = vec![];
    for id in 0..PIECE_SLOTS {
        let p = &g.pieces[id];
        if p.rank == 0 || p.army != army {
            continue;
        }
        let reach: i8 = if p.rank == RECON { 9 } else { 1 };
        let (r, c) = ((p.sq / 10) as i8, (p.sq % 10) as i8);
        for (dr, dc) in [(-1i8, 0i8), (1, 0), (0, -1), (0, 1)] {
            for k in 1..=reach {
                let (nr, nc) = (r + dr * k, c + dc * k);
                if !(0..10).contains(&nr) || !(0..10).contains(&nc) {
                    break;
                }
                let to = (nr * 10 + nc) as u8;
                if g.probe(army, g.moved, g.two_step_active, id as u8, to) {
                    out.push((id as u8, to));
                }
            }
        }
    }
    out
}

fn play_out(seed: u8) -> Env {
    let mut env = ready();
    env.start_in_rollup(seed);
    env.deal().expect("deal");
    let mut rng = u64::from(seed) * 7919 + 13;
    let mut steps = 0;
    while env.battle().status == vanguard::STATUS_LIVE {
        steps += 1;
        assert!(steps < 400, "a Match must end");
        let moves = legal_moves(&env);
        assert!(!moves.is_empty(), "the engine ends a Match with no move");
        rng = rng
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        // Prefer an attack half the time so Matches also end by fights.
        let b = env.battle();
        let attacks: Vec<(u8, u8)> = moves
            .iter()
            .copied()
            .filter(|(_, to)| b.sq.contains(to))
            .collect();
        let pool = if !attacks.is_empty() && (rng >> 60) % 2 == 0 {
            attacks
        } else {
            moves
        };
        let (piece, to) = pool[((rng >> 33) as usize) % pool.len()];
        let seat = {
            let side = if b.turn == 0 { Side::Us } else { Side::It };
            (0..2)
                .find(|s| b.side_of_seat(*s) == Some(side))
                .expect("seat")
        };
        let t = env.now + 1;
        env.set_time(t);
        env.mv(seat, piece, to).expect("a legal move is accepted");
        let board = env.battle();
        let mut seen = [false; 100];
        for q in board.sq.iter().filter(|q| **q != vanguard::NO_SQ) {
            assert!(!seen[*q as usize], "two pieces on a square");
            seen[*q as usize] = true;
            assert!(!engine::is_wadi(*q), "a piece in a wadi");
        }
        assert!(env.army(0).fuel <= engine::TRUCK_FUEL && env.army(1).fuel <= engine::TRUCK_FUEL);
    }
    env
}

#[test]
fn whole_dealt_matches_end_and_settle_or_refund() {
    for seed in [1u8, 2, 3, 4, 5, 6] {
        let mut env = play_out(seed);
        let b = env.battle();
        assert_eq!(b.status, vanguard::STATUS_OVER, "seed {seed}");
        assert!(b.winner == vanguard::DRAW || b.winner < 2);
        // Everything left is face up, and what is off the board was shown on its way out.
        for id in 0..PIECE_SLOTS {
            if b.sq[id] != vanguard::NO_SQ {
                assert_ne!(
                    b.shown[id], 0,
                    "seed {seed} piece {id} is still hidden at the end"
                );
            }
        }
        let before = (env.gemas(&env.alice), env.gemas(&env.bob));
        let draw = b.winner == vanguard::DRAW;
        env.finalize(draw).expect("finalize");
        let after = (env.gemas(&env.alice), env.gemas(&env.bob));
        if draw {
            assert_eq!(after, (before.0 + 1_000, before.1 + 1_000));
            assert_eq!(env.tesoro_status(), Stage::Closed);
        } else {
            let (w, l) = if b.winner == 0 {
                (after.0 - before.0, after.1 - before.1)
            } else {
                (after.1 - before.1, after.0 - before.0)
            };
            assert_eq!((w, l), (1_900, 0), "seed {seed} reason {}", b.reason);
            assert_eq!(env.tesoro_status(), Stage::Closed);
        }
        println!(
            "seed {seed}: {} moves, turn {}, winner {}, reason {}",
            b.moves, b.turn_no, b.winner, b.reason
        );
    }
}

/// CU readings (run with `--nocapture`). Spec: the compute a move and a clock check use must not depend on the
/// layout.
#[test]
fn cu_profile() {
    let mut moves = vec![];
    let mut timeouts = vec![];
    for seed in [1u8, 2, 3, 4] {
        let mut env = ready();
        env.start_in_rollup(seed);
        env.deal().expect("deal");
        let deal = env.last_cu;
        let first = legal_moves(&env)[0];
        let t = env.now + 1;
        env.set_time(t);
        let seat = if env.battle().side_of_seat(0) == Some(Side::Us) {
            0
        } else {
            1
        };
        env.mv(seat, first.0, first.1).expect("move");
        moves.push(env.last_cu);
        let caller = env.oracle.insecure_clone();
        let deadline = env.battle().deadline;
        env.set_time(deadline + 1);
        env.claim_timeout(&caller).expect("timeout");
        timeouts.push(env.last_cu);
        println!(
            "CU seed {seed}: deal {deal}; move {}; claim_timeout {}",
            moves[moves.len() - 1],
            timeouts[timeouts.len() - 1]
        );
    }
    let mut second_steps = vec![];
    for seed in [1u8, 2, 3, 4] {
        let mut env = ready();
        env.start_in_rollup(seed);
        env.deal().expect("deal");
        let seat = if env.battle().side_of_seat(0) == Some(Side::Us) {
            0
        } else {
            1
        };
        env.patch_battle(|b| b.two_step[0] = 1);
        let t = env.now + 1;
        env.set_time(t);
        env.two_step(seat).expect("two-step");
        let first = legal_moves(&env)[0];
        env.mv(seat, first.0, first.1).expect("first step");
        let second = legal_moves(&env)[0];
        env.mv(seat, second.0, second.1).expect("second step");
        second_steps.push(env.last_cu);
        println!("CU seed {seed}: two-step second step {}", env.last_cu);
    }
    let spread = |v: &[u64]| v.iter().max().unwrap() - v.iter().min().unwrap();
    println!(
        "CU spread across layouts: move {}; claim_timeout {}",
        spread(&moves),
        spread(&timeouts)
    );
}

/// The compute a permissionless `claim_timeout` (and a move) uses must not depend on hidden ranks: the squares stay
/// where they are and only the ranks under them are permuted.
#[test]
fn compute_does_not_depend_on_which_rank_stands_where() {
    let mut readings = vec![];
    for rotate in 0..6usize {
        let mut env = ready();
        env.start_in_rollup(7);
        env.deal().expect("deal");
        for seat in 0..2 {
            env.patch_army(seat, |v| {
                let slots: Vec<usize> = (0..30).filter(|i| v.ranks[*i] != 0).collect();
                let ranks: Vec<u8> = slots.iter().map(|i| v.ranks[*i]).collect();
                for (n, slot) in slots.iter().enumerate() {
                    v.ranks[*slot] = ranks[(n + rotate * 3) % ranks.len()];
                }
            });
        }
        let caller = env.oracle.insecure_clone();
        let deadline = env.battle().deadline;
        env.set_time(deadline + 1);
        env.claim_timeout(&caller).expect("timeout");
        readings.push(env.last_cu);
    }
    println!("CU claim_timeout across rank permutations: {readings:?}");
    assert!(
        readings.iter().all(|c| *c == readings[0]),
        "compute depends on the ranks: {readings:?}"
    );
}

// --- Review fixes: setup deadline, init_permissions, stored rules, compute ---------------------------

fn is_vcode(err: &Failed, e: VanguardError) -> bool {
    use solana_sdk::instruction::InstructionError;
    use solana_sdk::transaction::TransactionError;
    matches!(&err.err, TransactionError::InstructionError(_, InstructionError::Custom(c)) if *c == vcode(e))
}

fn stranger(env: &mut Env) -> Keypair {
    let k = Keypair::new();
    env.svm.airdrop(&k.pubkey(), 10 * SOL).expect("airdrop");
    k
}

/// A stranger who could run `init_permissions` would move every new Battle to SETUP before it is delegated, and the
/// Match would die by no-show. Only a Player may.
#[test]
fn only_a_player_can_open_the_setup_phase() {
    let mut env = ready();
    let outsider = stranger(&mut env);
    let init = init_permissions_ix(&env, a(outsider.pubkey()));
    let err = env.send(&[init], &outsider, &[]).unwrap_err();
    assert!(is_vcode(&err, VanguardError::NotAPlayer), "{:?}", err.err);
    assert_eq!(env.battle().status, vanguard::STATUS_CREATED);
    assert_eq!(env.battle().permissioned, 0);
    // Either Player passes the guard. LiteSVM has no permission program, so the call stops further on and
    // reverts: the Battle is untouched.
    for seat in 0..2 {
        let p = env.player(seat);
        let init = init_permissions_ix(&env, p.key);
        let err = env.send(&[init], &p.kp, &[]).unwrap_err();
        assert!(!is_vcode(&err, VanguardError::NotAPlayer), "seat {seat}");
        assert_eq!(env.battle().status, vanguard::STATUS_CREATED);
    }
}

#[test]
fn setup_has_a_hard_deadline_well_inside_the_refund_window() {
    let env = ready();
    let b = env.battle();
    assert_eq!(
        b.setup_deadline,
        b.start_deadline + vanguard::SETUP_GRACE_SECS
    );
    let refund = env.load::<MatchState>(env.tmatch).inner.deadline;
    // Dealt on the last second, the Match still ends (cap) and settles with hours to spare.
    assert!(b.setup_deadline + engine::CAP_SECS + 3_600 < refund);
}

#[test]
fn nothing_goes_live_past_the_setup_deadline_and_claim_timeout_cancels() {
    let mut env = ready();
    env.start_in_rollup(1);
    let deadline = env.battle().setup_deadline;
    // Both secrets and the randomness are in, but it is too late to start.
    env.set_time(deadline + 1);
    let err = env.deal().unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::SetupClosed));
    assert_eq!(env.battle().status, vanguard::STATUS_SETUP);
    let caller = env.bob.kp.insecure_clone();
    env.claim_timeout(&caller).expect("cancel");
    assert_eq!(env.battle().status, vanguard::STATUS_CANCELLED);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize(true).expect("refund");
    assert_eq!(env.gemas(&env.alice), before.0 + 1_000);
    assert_eq!(env.gemas(&env.bob), before.1 + 1_000);
}

/// A late oracle pushes the entropy deadline a minute at a time, never past the setup deadline.
#[test]
fn the_wait_for_a_late_oracle_is_bounded_by_the_setup_deadline() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.patch_secret(|v| v.vrf_seen = false);
    let setup_deadline = env.battle().setup_deadline;
    let caller = env.bob.kp.insecure_clone();
    let mut claims = 0;
    while env.battle().status == vanguard::STATUS_SETUP {
        claims += 1;
        assert!(claims < 20, "the wait never ends");
        let t = env.battle().entropy_deadline + 1;
        env.set_time(t);
        env.claim_timeout(&caller).expect("claim");
        assert!(env.battle().entropy_deadline <= setup_deadline);
    }
    assert_eq!(env.battle().status, vanguard::STATUS_CANCELLED);
    assert!(env.now > setup_deadline);
    assert!(claims > 1, "the oracle got more than one extra minute");
}

/// Both Players are in and nobody asked for randomness: that is not the oracle being late, it cancels at the first
/// deadline instead of looping.
#[test]
fn randomness_nobody_asked_for_cancels_at_the_first_deadline() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.patch_secret(|v| {
        v.vrf_seen = false;
        v.vrf_requested = false;
    });
    env.set_time(T0 + vanguard::ENTROPY_SECS + 1);
    let caller = env.bob.kp.insecure_clone();
    env.claim_timeout(&caller).expect("claim");
    assert_eq!(env.battle().status, vanguard::STATUS_CANCELLED);
}

#[test]
fn entropy_after_the_window_is_refused() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.patch_secret(|v| {
        v.contributed = [false; 2];
        v.vrf_seen = false;
        v.vrf_requested = false;
    });
    env.set_time(env.battle().entropy_deadline + 1);
    let ad = addrs(env.tmatch);
    let alice = env.alice.kp.insecure_clone();
    let i = ix(
        vanguard::ID,
        vanguard::accounts::ContributeEntropy {
            player: a(alice.pubkey()),
            battle: ad.battle,
            secret: ad.secret,
        },
        vanguard::instruction::ContributeEntropy { secret: [1; 32] },
        vec![],
    );
    let err = env.send(&[i], &alice, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::SetupClosed));
    assert_eq!(env.secret().contributed, [false, false]);
}

#[test]
fn a_battle_records_its_versions_and_rules_when_created() {
    let mut env = Env::new();
    env.open_and_join(1_000);
    let bob = env.bob.kp.insecure_clone();
    env.ensure_config();
    let create = env.create_ix(env.bob.key);
    env.send(&[create], &bob, &[]).expect("bob creates");
    let b = env.battle();
    assert_eq!(b.layout_version, vanguard::LAYOUT_VERSION);
    assert_eq!(b.rules_version, engine::RULES_VERSION);
    assert_eq!(
        b.payer, env.bob.key,
        "whoever pressed create prepaid the rent"
    );
    assert_eq!(
        b.oracle_queue, QUEUE,
        "the queue comes from the config, not the code"
    );
    assert_eq!(b.move_cap, engine::MOVE_CAP);
    assert_eq!(b.cap_secs as i64, engine::CAP_SECS);
    assert_eq!(b.turn_secs as i64, engine::TURN_SECS);
    assert_eq!(b.grace_secs as i64, engine::GRACE_SECS);
    assert_eq!(b.opening_grace_secs as i64, OPENING_GRACE_SECS);
    assert_eq!(
        (b.storm_from as u16, b.storm_to as u16),
        (engine::STORM_FROM, engine::STORM_TO)
    );
    assert_eq!(b.reserved, [0; 31]);
    assert_eq!(
        (b.pending_kind, b.action_seq, b.deal_slot),
        (vanguard::PENDING_NONE, 0, 0)
    );
    assert_eq!(env.army(0).reserved, [0; 32]);
    assert_eq!(env.army(1).reserved, [0; 32]);
}

/// A program upgrade never changes the rules of a Match in flight: the clock, the caps and the storm window are
/// read from the Battle, set when it was created.
#[test]
fn a_battle_plays_by_the_rules_stored_when_it_was_created() {
    let mut env = ready();
    env.start_in_rollup(2);
    env.patch_battle(|b| {
        b.turn_secs = 9;
        b.grace_secs = 2;
        b.opening_grace_secs = 4;
        b.move_cap = 2;
        b.cap_secs = 100;
        b.storm_from = 3;
        b.storm_to = 4;
    });
    env.set_time(T0 + 30);
    env.deal().expect("deal");
    let b = env.battle();
    assert_eq!(b.deadline, T0 + 30 + 9 + 2 + 4);
    assert_eq!(b.cap_deadline, T0 + 30 + 100);
    assert!((3..=4).contains(&env.secret().storm_at));
    // Two moves reach the stored move cap, not the compiled one.
    for _ in 0..2 {
        let (piece, to) = legal_moves(&env)[0];
        let t = env.now + 1;
        env.set_time(t);
        let seat = {
            let b = env.battle();
            let side = if b.turn == 0 { Side::Us } else { Side::It };
            (0..2)
                .find(|s| b.side_of_seat(*s) == Some(side))
                .expect("seat")
        };
        env.mv(seat, piece, to).expect("move");
    }
    let b = env.battle();
    assert_eq!(b.status, vanguard::STATUS_OVER);
    assert_eq!(b.reason, vanguard::reason_code(EndReason::Cap));
}

#[test]
fn the_opening_turn_has_ten_extra_seconds() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.set_time(T0 + 30);
    env.deal().expect("deal");
    let deadline = env.battle().deadline;
    assert_eq!(
        deadline,
        T0 + 30 + engine::TURN_SECS + engine::GRACE_SECS + OPENING_GRACE_SECS
    );
    let caller = env.oracle.insecure_clone();
    env.set_time(deadline);
    let err = env.claim_timeout(&caller).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotTimedOut));
    // A first move after the usual six seconds is still in time.
    env.set_time(T0 + 30 + 14);
    let (piece, to) = legal_moves(&env)[0];
    let seat = if env.battle().side_of_seat(0) == Some(Side::Us) {
        0
    } else {
        1
    };
    env.mv(seat, piece, to)
        .expect("a slow first move is accepted");
    // The next turn has only the usual clock.
    assert_eq!(
        env.battle().deadline,
        T0 + 30 + 14 + engine::TURN_SECS + engine::GRACE_SECS
    );
}

// --- No hidden rank decides what runs ----------------------------------------------------------------

/// Italy's side of the boards below: it always has a piece that can move, so no move here ends the Match.
fn italy() -> Vec<LayoutPiece> {
    vec![
        lp(Side::It, GENERAL_OF_THE_ARMY, 5),
        lp(Side::It, 8, 6),
        lp(Side::It, BOMB, 7),
    ]
}

/// A US piece of `rank` at 70 steps onto the empty square 60; a General at 95 is for a second step.
fn step_layout(rank: u8, others: u8) -> Vec<LayoutPiece> {
    let mut l = vec![
        lp(Side::Us, rank, 70),
        lp(Side::Us, GENERAL_OF_THE_ARMY, 95),
        lp(Side::Us, others, 97),
    ];
    l.extend(italy());
    l
}

/// The compute of declaring and of resolving the first step of a turn by the piece at 70.
fn first_step_cu(rank: u8, others: u8, fuel: u8) -> (u64, u64) {
    let mut env = ready();
    env.start_in_rollup(1);
    env.stage(&step_layout(rank, others), 0);
    env.set_time(T0 + 2);
    env.patch_army(0, |v| v.fuel = fuel);
    env.mv(0, id_of(70), 60).expect("the step is legal");
    (env.declare_cu, env.resolve_cu)
}

/// The same move, by pieces of every hidden rank: the declare and the resolve each cost the same compute, so the
/// opponent who sees a transaction's compute learns nothing about the piece that moved. A Truck's first two moves
/// cost what any other piece's move costs (its third shows it and is announced anyway).
#[test]
fn a_move_costs_the_same_compute_whatever_rank_moves() {
    let mut readings = vec![];
    // (rank 4, the Sergeant, no longer walks straight; its diagonal step is measured in the version 6 table)
    for rank in [SPY, RECON, ENGINEER, 5, 6, 7, 8, 9, GENERAL_OF_THE_ARMY] {
        for others in [BOMB, ENGINEER, 5] {
            readings.push((
                format!("rank {rank} others {others}"),
                first_step_cu(rank, others, 0),
            ));
        }
    }
    for fuel in [0, 1] {
        readings.push((
            format!("Truck fuel {fuel}"),
            first_step_cu(TRUCK, BOMB, fuel),
        ));
    }
    let first = readings[0].1;
    for (what, cu) in &readings {
        assert_eq!(
            *cu, first,
            "{what} used {cu:?}, a rank-1 move {first:?}: {readings:?}"
        );
    }
    println!(
        "CU of a first step (declare, resolve), {} variants: {first:?}",
        readings.len()
    );
}

/// A declare reads no Army and no Secret: it costs the same whatever the board holds, and with a compute limit set
/// to exactly what it needs it succeeds for every rank, one unit less it fails for every rank.
#[test]
fn a_declare_cannot_tell_ranks_apart_even_under_a_tight_compute_limit() {
    let declare = |rank: u8, others: u8, limit: Option<u32>| -> Result<u64, ()> {
        let mut env = ready();
        env.start_in_rollup(1);
        env.stage(&step_layout(rank, others), 0);
        env.set_time(T0 + 2);
        let p = env.player(0);
        let m = env.move_ix(p.key, id_of(70), 60);
        let mut ixs = vec![m];
        if let Some(l) = limit {
            let mut data = vec![2u8];
            data.extend_from_slice(&l.to_le_bytes());
            ixs.insert(0, Instruction { data, ..budget() });
        }
        env.send(&ixs, &p.kp, &[])
            .map(|_| env.last_cu)
            .map_err(|_| ())
    };
    let needed = declare(5, BOMB, None).expect("declare");
    for (rank, others) in [
        (SPY, 5),
        (RECON, BOMB),
        (GENERAL_OF_THE_ARMY, ENGINEER),
        (TRUCK, BOMB),
        (BOMB, 5),
    ] {
        assert_eq!(declare(rank, others, None), Ok(needed), "rank {rank}");
        // the limit instruction itself costs a few units: leave room for it
        assert!(
            declare(rank, others, Some(needed as u32 + 1_000)).is_ok(),
            "rank {rank} with room"
        );
        assert!(
            declare(rank, others, Some(needed as u32 - 3_000)).is_err(),
            "rank {rank} without room"
        );
    }
}

/// An impersonated signer (a transaction that names the opponent's key but carries no signature from it, as a
/// `simulateTransaction` with `sigVerify: false` allows) gets the same answer and the same compute whatever the
/// hidden rank of the opponent's piece: a Landmine, a Recon, a Truck out of fuel, a General.
#[test]
fn an_impersonated_declare_answers_the_same_for_every_hidden_rank() {
    let mut results = vec![];
    for (rank, fuel) in [
        (BOMB, 0),
        (RECON, 0),
        (TRUCK, engine::TRUCK_FUEL),
        (TRUCK, 0),
        (GENERAL_OF_THE_ARMY, 0),
        (SPY, 0),
    ] {
        let mut env = Env::build(false);
        env.open_and_join(1_000);
        env.create().expect("create");
        env.start_in_rollup(1);
        // Italy to move, with the piece under test at 5.
        let layout = vec![
            lp(Side::Us, GENERAL_OF_THE_ARMY, 95),
            lp(Side::It, rank, 5),
            lp(Side::It, GENERAL_OF_THE_ARMY, 6),
        ];
        env.stage(&layout, 0);
        env.patch_battle(|b| b.turn = 1);
        env.patch_army(1, |v| v.fuel = fuel);
        env.set_time(T0 + 2);
        // Alice attacks: she names Bob's key as the signer and signs only as the fee payer.
        let alice = env.alice.kp.insecure_clone();
        let bob = env.bob.key;
        let declare = env.move_ix(bob, id_of(5), 15);
        env.svm.expire_blockhash();
        let mut tx =
            Transaction::new_unsigned(Message::new(&[budget(), declare], Some(&alice.pubkey())));
        tx.partial_sign(&[&alice], env.svm.latest_blockhash());
        let r = env.run(tx);
        results.push((rank, fuel, r.is_ok(), env.last_cu));
    }
    for r in &results {
        assert_eq!((r.2, r.3), (results[0].2, results[0].3), "{results:?}");
    }
    assert!(
        results[0].2,
        "the declare is accepted: it checks public state only"
    );
}

/// A Two-Step Turn, too: spending it and each step.
#[test]
fn a_two_step_turn_costs_the_same_compute_whatever_rank_moves() {
    let measure = |rank: u8, fuel: u8| {
        let mut env = ready();
        env.start_in_rollup(1);
        env.stage(&step_layout(rank, BOMB), 0);
        env.set_time(T0 + 2);
        env.patch_army(0, |v| v.fuel = fuel);
        env.patch_battle(|b| b.two_step[0] = 1);
        env.two_step(0).expect("spend it");
        let spend = env.last_cu;
        env.mv(0, id_of(70), 60).expect("first step");
        let first = (env.declare_cu, env.resolve_cu);
        env.mv(0, id_of(95), 85).expect("second step");
        (spend, first, (env.declare_cu, env.resolve_cu))
    };
    let base = measure(5, 0);
    for (rank, fuel) in [
        (SPY, 0),
        (RECON, 0),
        (GENERAL_OF_THE_ARMY, 0),
        (TRUCK, 0),
        (TRUCK, 1),
    ] {
        assert_eq!(measure(rank, fuel), base, "rank {rank} fuel {fuel}");
    }
    println!("CU of a Two-Step Turn (spend, first step, second step): {base:?}");
}

/// A fight is the one place where the work may depend on the pieces, and then on the published outcome only: the
/// winning attacker stays hidden, so a Spy that beats the General must cost what any other winner costs. The declare
/// of an attack costs what any declare costs.
#[test]
fn a_fight_costs_what_its_published_outcome_costs_and_no_more() {
    let attack = |att: u8, def: u8| -> (u8, u64, u64) {
        let mut env = ready();
        env.start_in_rollup(1);
        let layout = vec![
            lp(Side::Us, att, 70),
            lp(Side::Us, GENERAL_OF_THE_ARMY, 95),
            lp(Side::It, def, 20),
            lp(Side::It, GENERAL_OF_THE_ARMY, 5),
            lp(Side::It, 8, 6),
        ];
        env.stage(&layout, 0);
        // The defender stands next to the attacker: it left its start square earlier.
        let d = id_of(20) as usize;
        env.patch_battle(|b| {
            b.sq[d] = 60;
            b.trail[d] = [60, 0, 0, 0, 0, 0];
            b.trail_len[d] = 1;
        });
        env.set_time(T0 + 2);
        env.mv(0, id_of(70), 60).expect("the attack is legal");
        (env.battle().ring[0].data[4], env.declare_cu, env.resolve_cu)
    };
    type Class = (&'static str, engine::Outcome, Vec<(u8, u8)>);
    let classes: [Class; 5] = [
        (
            "win",
            engine::Outcome::Win,
            vec![
                (10, 9),
                (9, 8),
                (5, 3),
                (6, 2),
                (SPY, GENERAL_OF_THE_ARMY),
                (3, 1),
                (8, 5),
            ],
        ),
        (
            "lose",
            engine::Outcome::Lose,
            vec![(3, 7), (1, 9), (2, 10), (6, 8), (SPY, 5), (5, 6)],
        ),
        (
            "tie",
            engine::Outcome::Tie,
            vec![(7, 7), (3, 3), (10, 10), (SPY, SPY)],
        ),
        (
            "mine",
            engine::Outcome::Mine,
            vec![
                (10, BOMB),
                (5, BOMB),
                (SPY, BOMB),
                (RECON, BOMB),
                (TRUCK, BOMB),
                (ENGINEER, BOMB),
            ],
        ),
        (
            "truck",
            engine::Outcome::Truck,
            vec![(10, TRUCK), (SPY, TRUCK), (RECON, TRUCK), (6, TRUCK)],
        ),
    ];
    let mut declares = vec![];
    for (name, outcome, pairs) in classes {
        let readings: Vec<(u8, u8, u8, u64)> = pairs
            .iter()
            .map(|&(att, def)| {
                let (code, declare, resolve) = attack(att, def);
                declares.push(declare);
                (att, def, code, resolve)
            })
            .collect();
        for &(att, def, code, cu) in &readings {
            assert_eq!(
                code,
                vanguard::outcome_code(outcome),
                "{name}: {att} attacks {def}"
            );
            assert_eq!(
                cu, readings[0].3,
                "{name}: {att} attacks {def} resolved with {cu}: {readings:?}"
            );
        }
        println!("CU of resolving a fight, {name}: {}", readings[0].3);
    }
    assert!(declares.iter().all(|d| *d == declares[0]), "{declares:?}");
}

/// `claim_timeout` is permissionless, so anyone reads its compute: it must not say anything about the Truck's fuel.
#[test]
fn claim_timeout_costs_the_same_compute_whatever_the_truck_fuel() {
    let measure = |fuel: u8| {
        let mut env = ready();
        env.start_in_rollup(1);
        env.stage(&step_layout(TRUCK, BOMB), 0);
        env.patch_army(0, |v| v.fuel = fuel);
        env.set_time(env.battle().deadline + 1);
        let caller = env.oracle.insecure_clone();
        env.claim_timeout(&caller).expect("timeout");
        (env.declare_cu, env.resolve_cu)
    };
    let base = measure(0);
    for fuel in [1, 2, 3] {
        assert_eq!(measure(fuel), base, "fuel {fuel}");
    }
}

// --- Declare, then resolve in a later slot -------------------------------------------------------------

fn declared_env() -> Env {
    let mut env = ready();
    env.start_in_rollup(1);
    env.stage(&truck_raid_layout(), 0);
    env.set_time(T0 + 2);
    env
}

/// A declare is recorded and nothing else: the board does not move until `resolve`.
#[test]
fn a_declare_records_public_intent_and_moves_nothing() {
    let mut env = declared_env();
    let p = env.player(0);
    let before = env.battle();
    let m = env.move_ix(p.key, id_of(70), 20);
    env.send(&[budget(), m], &p.kp, &[]).expect("declare");
    let b = env.battle();
    assert_eq!(
        (
            b.pending_kind,
            b.pending_piece,
            b.pending_to,
            b.pending_seat,
            b.action_seq
        ),
        (vanguard::PENDING_MOVE, id_of(70), 20, 0, 1)
    );
    assert_eq!(b.pending_slot, env.slot());
    assert_eq!(b.pending_time, env.now);
    assert_eq!(
        (b.sq, b.turn, b.moves, b.event_seq),
        (before.sq, before.turn, before.moves, before.event_seq)
    );
}

#[test]
fn resolve_needs_a_later_slot_and_a_pending_action() {
    let mut env = declared_env();
    let alice = env.alice.kp.insecure_clone();
    // Nothing pending.
    env.next_slot();
    let r = env.resolve_ix(a(alice.pubkey()));
    let err = env.send(&[budget(), r], &alice, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NothingPending));
    // In the declare's slot.
    let m = env.move_ix(env.alice.key, id_of(70), 20);
    env.send(&[budget(), m], &alice, &[]).expect("declare");
    let r = env.resolve_ix(a(alice.pubkey()));
    let err = env.send(&[budget(), r], &alice, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::TooSoon));
    assert_eq!(env.battle().pending_kind, vanguard::PENDING_MOVE);
    // Anyone resolves in the next slot, and no gameplay choice is theirs.
    let outsider = stranger(&mut env);
    env.resolve(&outsider).expect("anyone resolves");
    assert_eq!(env.battle().status, vanguard::STATUS_OVER);
    assert_eq!(env.battle().pending_kind, vanguard::PENDING_NONE);
}

/// One transaction cannot declare and resolve: a bundle sees one slot.
#[test]
fn a_declare_and_a_resolve_in_one_transaction_are_refused() {
    let mut env = declared_env();
    let alice = env.alice.kp.insecure_clone();
    let before = env.battle();
    let m = env.move_ix(env.alice.key, id_of(70), 20);
    let r = env.resolve_ix(env.alice.key);
    let err = env.send(&[budget(), m, r], &alice, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::TooSoon));
    assert_eq!(
        anchor_lang::__private::bytemuck::bytes_of(&env.battle()),
        anchor_lang::__private::bytemuck::bytes_of(&before)
    );
}

/// While an action is pending only `resolve` is accepted.
#[test]
fn nothing_but_resolve_is_accepted_while_an_action_is_pending() {
    let mut env = declared_env();
    let alice = env.alice.kp.insecure_clone();
    let m = env.move_ix(env.alice.key, id_of(70), 60);
    env.send(&[budget(), m], &alice, &[]).expect("declare");
    env.next_slot();
    let again = env.move_ix(env.alice.key, id_of(95), 85);
    let err = env.send(&[budget(), again], &alice, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::ActionPending));
    env.patch_battle(|b| b.two_step[0] = 1);
    let err = env.two_step(0).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::ActionPending));
    env.set_time(env.battle().deadline + 1);
    let bob = env.bob.kp.insecure_clone();
    let err = env.claim_timeout_declare(&bob).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::ActionPending));
    // The pending move is still the one declared.
    let b = env.battle();
    assert_eq!(
        (b.pending_piece, b.pending_to, b.action_seq),
        (id_of(70), 60, 1)
    );
}

/// `deal` and a declare in one transaction (or in one slot) are refused: the sides cannot be read out of a bundle.
#[test]
fn nothing_is_declared_in_the_slot_of_the_deal() {
    let mut env = ready();
    env.start_in_rollup(1);
    let alice = env.alice.kp.insecure_clone();
    let bob = env.bob.kp.insecure_clone();
    // Either Player might be the one to move first: try both seats, in one transaction with the deal.
    for p in [&alice, &bob] {
        let deal = env.deal_ix(a(p.pubkey()));
        let decl = env.move_ix(a(p.pubkey()), 55, 45);
        let err = env.send(&[budget(), deal, decl], p, &[]).unwrap_err();
        assert_eq!(custom_code(&err), vcode(VanguardError::TooSoon));
        assert_eq!(
            env.battle().status,
            vanguard::STATUS_SETUP,
            "the whole transaction reverted"
        );
    }
    // The same slot, in two transactions.
    let deal = env.deal_ix(a(alice.pubkey()));
    env.send(&[deal], &alice, &[]).expect("deal");
    for p in [&alice, &bob] {
        let decl = env.move_ix(a(p.pubkey()), 55, 45);
        let err = env.send(&[budget(), decl], p, &[]).unwrap_err();
        assert_eq!(custom_code(&err), vcode(VanguardError::TooSoon), "declare");
    }
    let two = env.alice.kp.insecure_clone();
    let ts = ix(
        vanguard::ID,
        vanguard::accounts::StartTwoStep {
            player: a(two.pubkey()),
            battle: addrs(env.tmatch).battle,
        },
        vanguard::instruction::StartTwoStep {},
        vec![],
    );
    let err = env.send(&[ts], &two, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::TooSoon), "two-step");
    let caller = env.oracle.insecure_clone();
    env.set_time(env.battle().deadline + 1);
    let err = env.claim_timeout_declare(&caller).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::TooSoon), "timeout");
}

/// The clock decision is made at the declare and never again: a late resolve does not turn an accepted move into a
/// refusal, and the next deadline counts from the resolve.
#[test]
fn the_clock_is_decided_at_the_declare_and_the_next_deadline_counts_from_the_resolve() {
    let mut env = declared_env();
    let alice = env.alice.kp.insecure_clone();
    let deadline = env.battle().deadline;
    // Declared at the very edge of the deadline...
    env.set_time(deadline);
    let m = env.move_ix(env.alice.key, id_of(70), 60);
    env.send(&[budget(), m], &alice, &[])
        .expect("declared in time");
    // ...resolved long after it.
    env.set_time(deadline + 500);
    env.resolve(&alice)
        .expect("a late resolve still applies the move");
    let b = env.battle();
    assert_eq!(b.sq[id_of(70) as usize], 60);
    assert_eq!(
        b.deadline,
        deadline + engine::RESOLVE_SLACK_SECS + engine::TURN_SECS + engine::GRACE_SECS,
        "a stalled resolve is counted from the declare plus the slack, with no extra grace"
    );
    // One second past the edge is refused at the declare.
    let bob = env.bob.kp.insecure_clone();
    env.set_time(b.deadline + 1);
    let late = env.move_ix(env.bob.key, id_of(5), 15);
    let err = env.send(&[budget(), late], &bob, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::TurnExpired));
}

/// A timeout claim is judged when it is claimed: the turn's deadline against the cap, decided at the declare.
#[test]
fn a_timeout_is_classified_when_claimed_and_applied_when_resolved() {
    let mut env = declared_env();
    let caller = env.bob.kp.insecure_clone();
    let deadline = env.battle().deadline;
    env.set_time(deadline + 1);
    env.claim_timeout_declare(&caller).expect("claim");
    assert_eq!(env.battle().pending_kind, vanguard::PENDING_TIMEOUT);
    // Resolved after the cap has passed: it is still the lost turn it was claimed as, not a cap ending.
    env.set_time(env.battle().started_at + engine::CAP_SECS + 50);
    env.resolve(&caller).expect("resolve");
    let b = env.battle();
    assert_eq!(
        (b.status, b.turn, b.timeouts),
        (vanguard::STATUS_LIVE, 1, [1, 0])
    );
    // Claimed after the cap: the tiebreak, whatever the turn clock says.
    env.claim_timeout(&caller).expect("claim and resolve");
    assert_eq!(env.battle().status, vanguard::STATUS_OVER);
    assert_eq!(env.battle().reason, vanguard::reason_code(EndReason::Cap));
}

/// A declared move the rank rules refuse costs the turn: three in a row lose the Match.
#[test]
fn a_declared_illegal_move_costs_the_turn_and_three_lose_the_match() {
    let mut env = ready();
    env.start_in_rollup(1);
    let layout = vec![
        lp(Side::Us, BOMB, 97),
        lp(Side::Us, GENERAL_OF_THE_ARMY, 95),
        lp(Side::It, GENERAL_OF_THE_ARMY, 5),
        lp(Side::It, 8, 6),
    ];
    env.stage(&layout, 0);
    env.set_time(T0 + 2);
    for (n, expected) in [[1u8, 0], [2, 0]].into_iter().enumerate() {
        env.mv(0, id_of(97), 87)
            .expect("a Landmine cannot move: the turn is lost");
        assert_eq!(env.battle().timeouts, expected);
        assert_eq!(env.battle().sq[id_of(97) as usize], 97);
        // Italy moves, which does not reset Alice's count.
        let to = if n == 0 { 15 } else { 25 };
        env.mv(1, id_of(5), to).expect("Italy moves");
    }
    env.mv(0, id_of(97), 87).expect("the third lost turn");
    let b = env.battle();
    assert_eq!(
        (b.status, b.winner, b.reason),
        (
            vanguard::STATUS_OVER,
            1,
            vanguard::reason_code(EndReason::Timeouts)
        )
    );
}

/// After the Match is over, `resolve` followed by `finalize` in one transaction is only possible where both are
/// callable (LiteSVM); either way the outcome shown is the committed one and nothing is half done.
#[test]
fn resolve_then_finalize_in_one_transaction_is_all_or_nothing() {
    let mut env = declared_env();
    let alice = env.alice.kp.insecure_clone();
    let m = env.move_ix(env.alice.key, id_of(70), 20);
    env.send(&[budget(), m], &alice, &[])
        .expect("declare the Truck capture");
    env.next_slot();
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    let remaining: Vec<AccountMeta> = vec![];
    let ad = addrs(env.tmatch);
    let finalize = ix(
        vanguard::ID,
        vanguard::accounts::Finalize {
            caller: a(alice.pubkey()),
            battle: ad.battle,
            tesoro_match: env.tmatch,
            config: tpda(&[CONFIG_SEED]),
            game_record: game_record_pda(),
            authority: authority_pda(),
            game_program: vanguard::ID,
            program_data: program_data_pda(),
            receipt: tpda(&[b"settled", env.tmatch.as_ref()]),
            system_program: anchor_lang::system_program::ID,
            event_authority: tpda(&[b"__event_authority"]),
            tesoro_program: tesoro_core::ID,
        },
        vanguard::instruction::Finalize {},
        remaining,
    );
    let resolve = env.resolve_ix(env.alice.key);
    env.send(&[budget(), resolve, finalize], &alice, &[])
        .expect("the Match ends and settles");
    env.run_settlement();
    assert_eq!(env.tesoro_status(), Stage::Closed);
    assert_eq!(env.gemas(&env.alice), before.0 + 1_900);
    assert_eq!(env.battle().finalized, 1);
}

/// The opening turn's extra time is stored once, in the first deadline. Nothing re-grants it.
#[test]
fn the_opening_grace_is_consumed_exactly_once() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.set_time(T0 + 30);
    env.deal().expect("deal");
    let opening = env.battle().deadline;
    assert_eq!(
        opening,
        T0 + 30 + engine::TURN_SECS + engine::GRACE_SECS + OPENING_GRACE_SECS
    );
    let us = if env.battle().side_of_seat(0) == Some(Side::Us) {
        0
    } else {
        1
    };
    let player = env.player(us);
    // Spending a banked Two-Step Turn on the opening turn does not refresh it.
    env.patch_battle(|b| b.two_step[0] = 1);
    env.set_time(T0 + 31);
    env.two_step(us).expect("spend");
    assert_eq!(env.battle().deadline, opening);
    // The first timeout cannot be claimed before the opening deadline, and can right after it.
    let caller = env.oracle.insecure_clone();
    env.set_time(opening);
    let err = env.claim_timeout_declare(&caller).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotTimedOut));
    // A first move one second past it is refused at the declare.
    let (piece, to) = legal_moves(&env)[0];
    env.set_time(opening + 1);
    let late = env.move_ix(player.key, piece, to);
    let err = env.send(&[budget(), late], &player.kp, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::TurnExpired));
    // A first move at the edge, resolved much later: the next turn has the plain 6 seconds, counted from the resolve.
    env.set_time(opening);
    let m = env.move_ix(player.key, piece, to);
    env.send(&[budget(), m], &player.kp, &[])
        .expect("declared at the edge");
    env.set_time(opening + 300);
    env.resolve(&caller).expect("delayed resolve");
    assert_eq!(
        env.battle().deadline,
        opening + engine::RESOLVE_SLACK_SECS + engine::TURN_SECS + engine::GRACE_SECS
    );
}

// --- tesoro_core fixtures ------------------------------------------------------------------------

/// tesoro_core's Treasury with no Yield Fee: these suites size Advances without it.
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
        Pk::new_from_array(key.to_bytes()),
        Account {
            lamports: 1_000_000_000,
            data,
            owner: Pk::new_from_array(tesoro_core::ID.to_bytes()),
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

// --- Ticket 08: the turn clock ----------------------------------------------------------------------

/// Resolves a pending move `after` seconds past its declare and returns the next deadline.
fn resolved_after(env: &mut Env, after: i64) -> i64 {
    let alice = env.alice.kp.insecure_clone();
    let m = env.move_ix(env.alice.key, id_of(70), 60);
    env.send(&[budget(), m], &alice, &[]).expect("declare");
    let declared = env.now;
    env.set_time(declared + after);
    env.resolve(&alice).expect("resolve");
    env.battle().deadline
}

#[test]
fn the_next_deadline_counts_from_the_resolve_but_a_stalled_resolve_gains_at_most_the_slack() {
    let slack = engine::RESOLVE_SLACK_SECS;
    assert_eq!(slack, 2);
    let turn = engine::TURN_SECS + engine::GRACE_SECS;
    for after in [0, 1, slack, slack + 1, 30, 600] {
        let mut env = declared_env();
        let declared = env.now;
        let next = resolved_after(&mut env, after);
        assert_eq!(
            next,
            declared + after.min(slack) + turn,
            "resolved {after} s after the declare"
        );
    }
}

#[test]
fn a_stalled_timeout_resolve_gains_at_most_the_slack_too() {
    let mut env = declared_env();
    let caller = env.bob.kp.insecure_clone();
    env.set_time(env.battle().deadline + 1);
    env.claim_timeout_declare(&caller).expect("claim");
    let declared = env.now;
    env.set_time(declared + 600);
    env.resolve(&caller).expect("resolve");
    assert_eq!(
        env.battle().deadline,
        declared + engine::RESOLVE_SLACK_SECS + engine::TURN_SECS + engine::GRACE_SECS
    );
}

#[test]
fn the_slack_is_stored_per_battle_and_obeyed() {
    let mut env = declared_env();
    assert_eq!(
        env.battle().resolve_slack_secs as i64,
        engine::RESOLVE_SLACK_SECS
    );
    env.patch_battle(|b| b.resolve_slack_secs = 0);
    let declared = env.now;
    let next = resolved_after(&mut env, 5);
    assert_eq!(next, declared + engine::TURN_SECS + engine::GRACE_SECS);
}

/// A declare at the deadline is accepted; one second later it is refused and a timeout claim is possible.
#[test]
fn a_declare_at_the_deadline_is_accepted_and_one_second_later_is_refused() {
    let mut env = declared_env();
    let alice = env.alice.kp.insecure_clone();
    let deadline = env.battle().deadline;
    assert_eq!(
        deadline,
        T0 + engine::TURN_SECS + engine::GRACE_SECS + OPENING_GRACE_SECS
    );
    env.set_time(deadline + 1);
    let late = env.move_ix(env.alice.key, id_of(70), 60);
    let err = env.send(&[budget(), late], &alice, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::TurnExpired));
    assert_eq!(env.battle().pending_kind, vanguard::PENDING_NONE);
    env.set_time(deadline);
    let m = env.move_ix(env.alice.key, id_of(70), 60);
    env.send(&[budget(), m], &alice, &[])
        .expect("accepted at the deadline");
    assert_eq!(env.battle().pending_kind, vanguard::PENDING_MOVE);
}

#[test]
fn claim_timeout_works_only_after_the_deadline() {
    let mut env = declared_env();
    let caller = env.bob.kp.insecure_clone();
    let deadline = env.battle().deadline;
    for t in [T0, deadline - 1, deadline] {
        env.set_time(t);
        let err = env.claim_timeout_declare(&caller).unwrap_err();
        assert_eq!(
            custom_code(&err),
            vcode(VanguardError::NotTimedOut),
            "at {t}"
        );
        assert_eq!(env.battle().pending_kind, vanguard::PENDING_NONE);
    }
    env.set_time(deadline + 1);
    env.claim_timeout(&caller).expect("one second past");
    let b = env.battle();
    assert_eq!((b.turn, b.timeouts), (1, [1, 0]));
}

/// Each step of a Two-Step Turn gives a fresh deadline; spending the banked turn gives nothing.
#[test]
fn each_two_step_step_resets_the_deadline_and_start_two_step_never_moves_it() {
    let mut env = declared_env();
    let turn = engine::TURN_SECS + engine::GRACE_SECS;
    env.patch_battle(|b| b.two_step[0] = 1);
    let opening = env.battle().deadline;
    env.set_time(T0 + 3);
    env.two_step(0).expect("spend");
    assert_eq!(env.battle().deadline, opening);
    env.set_time(T0 + 4);
    env.mv(0, id_of(70), 60).expect("first step");
    let b = env.battle();
    assert_eq!((b.turn, b.steps_left, b.deadline), (0, 1, T0 + 4 + turn));
    env.set_time(T0 + 7);
    env.mv(0, id_of(95), 85).expect("second step");
    let b = env.battle();
    assert_eq!((b.turn, b.deadline), (1, T0 + 7 + turn));
}

#[test]
fn a_move_clears_the_count_of_timeouts_in_a_row() {
    let mut env = declared_env();
    let caller = env.oracle.insecure_clone();
    env.set_time(env.battle().deadline + 1);
    env.claim_timeout(&caller).expect("alice idles");
    env.set_time(env.battle().deadline + 1);
    env.claim_timeout(&caller).expect("bob idles");
    assert_eq!(env.battle().timeouts, [1, 1]);
    env.set_time(env.now + 1);
    env.mv(0, id_of(70), 60).expect("alice moves");
    assert_eq!(env.battle().timeouts, [0, 1]);
}

#[test]
fn a_move_at_the_cap_is_accepted_and_the_move_cap_ends_the_match_on_the_tiebreak() {
    let mut env = declared_env();
    let cap = env.battle().cap_deadline;
    env.set_time(cap);
    env.patch_battle(|b| b.deadline = cap + 100);
    env.mv(0, id_of(70), 60).expect("a move at the cap");
    assert_eq!(env.battle().status, vanguard::STATUS_LIVE);
    // 200 moves played: the 200th ends the Match on the tiebreak, and nothing more is accepted.
    env.patch_battle(|b| b.moves = engine::MOVE_CAP - 1);
    env.set_time(cap - 5);
    env.patch_battle(|b| b.deadline = cap + 100);
    env.mv(1, id_of(5), 15).expect("the last move");
    let b = env.battle();
    assert_eq!(
        (b.status, b.reason),
        (vanguard::STATUS_OVER, vanguard::reason_code(EndReason::Cap))
    );
    assert!(env.mv(0, id_of(70), 50).is_err());
}

/// The start window: the first second after it, anyone cancels; at it, nobody can.
#[test]
fn a_match_nobody_started_is_cancelled_one_second_after_the_start_window_and_refunded() {
    let mut env = ready();
    let caller = env.bob.kp.insecure_clone();
    let end = T0 + vanguard::START_WINDOW_SECS;
    env.set_time(end);
    let err = env.claim_timeout(&caller).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotTimedOut));
    let err = env.finalize_with(vec![]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotTimedOut));
    env.set_time(end + 1);
    env.claim_timeout(&caller).expect("cancel");
    assert_eq!(env.battle().status, vanguard::STATUS_CANCELLED);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize(true).expect("refund");
    assert_eq!(env.gemas(&env.alice), before.0 + 1_000);
    assert_eq!(env.gemas(&env.bob), before.1 + 1_000);
}

#[test]
fn the_entropy_window_ends_exactly_at_its_deadline() {
    let mut env = ready();
    env.start_in_rollup(1);
    env.patch_secret(|v| {
        v.contributed = [true, false];
        v.vrf_seen = false;
    });
    let caller = env.bob.kp.insecure_clone();
    env.set_time(env.battle().entropy_deadline);
    let err = env.claim_timeout(&caller).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotTimedOut));
    env.set_time(env.battle().entropy_deadline + 1);
    env.claim_timeout(&caller).expect("cancel");
    assert_eq!(env.battle().status, vanguard::STATUS_CANCELLED);
}

/// A board with a row of two pieces for the storm to move; the storm blows on the first turn change.
fn stormy_env() -> Env {
    let mut env = declared_env();
    env.patch_secret(|v| {
        v.storm_at = 1;
        v.storm_seed = 3;
    });
    env
}

fn storm_events(env: &Env) -> usize {
    env.battle()
        .ring
        .iter()
        .filter(|r| r.kind == vanguard::EVENT_STORM)
        .count()
}

#[test]
fn the_storm_fires_inside_the_resolve_of_the_move_that_ends_the_turn() {
    let mut env = stormy_env();
    assert_eq!((env.battle().storm_done, storm_events(&env)), (0, 0));
    env.mv(0, id_of(70), 60).expect("move");
    assert_eq!((env.battle().storm_done, storm_events(&env)), (1, 1));
}

#[test]
fn the_storm_fires_inside_the_resolve_of_the_timeout_that_ends_the_turn() {
    let mut env = stormy_env();
    let caller = env.bob.kp.insecure_clone();
    env.set_time(env.battle().deadline + 1);
    env.claim_timeout_declare(&caller).expect("declare");
    assert_eq!((env.battle().storm_done, storm_events(&env)), (0, 0));
    env.resolve(&caller).expect("resolve");
    assert_eq!((env.battle().storm_done, storm_events(&env)), (1, 1));
}

#[test]
fn the_storm_waits_for_the_turn_that_ends_it_not_for_the_first_step_of_a_two_step_turn() {
    let mut env = stormy_env();
    env.patch_battle(|b| b.two_step[0] = 1);
    env.two_step(0).expect("spend");
    env.mv(0, id_of(70), 60).expect("first step");
    assert_eq!((env.battle().storm_done, storm_events(&env)), (0, 0));
    env.mv(0, id_of(95), 85).expect("second step");
    assert_eq!((env.battle().storm_done, storm_events(&env)), (1, 1));
}

// --- Rules version 6: compute of whole `resolve` instructions ------------------------------------------

/// Move a staged piece (given by its start square) to another square, as if it had walked there.
fn tele(env: &mut Env, start_sq: u8, to: u8) {
    let d = id_of(start_sq) as usize;
    env.patch_battle(|b| {
        b.sq[d] = to;
        b.trail[d] = [to, 0, 0, 0, 0, 0];
        b.trail_len[d] = 1;
    });
}

/// Compute of the whole `resolve` instruction for the movement rules of version 6 (run with `--nocapture`): dense and
/// sparse boards, the longest Sergeant run, a Lieutenant jump that attacks, a General crossing a wadi, a Two-Step
/// continuation, a storm turn and each ending. The client budget for `resolve` is `chain.ts` `CU.resolve`.
#[test]
fn compute_of_resolving_moves_under_the_new_rules() {
    const BUDGET: u64 = 200_000;
    let rows: std::cell::RefCell<Vec<(String, u64, u64)>> = Default::default();
    // 1: a staged board, `setup`, then the US moves piece `from` (a start square) to `to`; returns the Env for checks.
    let play =
        |name: &str, layout: Vec<LayoutPiece>, setup: &dyn Fn(&mut Env), from: u8, to: u8| -> Env {
            let mut env = ready();
            env.start_in_rollup(1);
            env.stage(&layout, 0);
            setup(&mut env);
            env.set_time(T0 + 2);
            let before = env.battle().moves;
            env.mv(0, id_of(from), to).expect(name);
            assert_eq!(env.battle().moves, before + 1, "{name}: the move was legal");
            rows.borrow_mut()
                .push((name.to_string(), env.declare_cu, env.resolve_cu));
            env
        };
    let none: &dyn Fn(&mut Env) = &|_| {};
    // sparse and dense
    play("sparse board, one step", step_layout(5, BOMB), none, 70, 60);
    // the Sergeant's longest run, and one that ends in an attack
    let mut serg = vec![lp(Side::Us, 4, 90), lp(Side::Us, GENERAL_OF_THE_ARMY, 95)];
    serg.extend(italy());
    play(
        "Sergeant runs nine squares diagonally",
        serg.clone(),
        none,
        90,
        9,
    );
    let mut serg_attack = serg.clone();
    serg_attack.push(lp(Side::It, 3, 18));
    play(
        "Sergeant runs eight squares and attacks",
        serg_attack,
        none,
        90,
        18,
    );
    // a Lieutenant jumps an enemy and attacks the piece behind it
    let mut jump = vec![
        lp(Side::Us, 5, 70),
        lp(Side::Us, GENERAL_OF_THE_ARMY, 95),
        lp(Side::It, SPY, 20),
        lp(Side::It, 5, 21),
    ];
    jump.extend(italy());
    play(
        "Lieutenant jumps a Spy and attacks a 5",
        jump,
        &|env| {
            tele(env, 20, 60);
            tele(env, 21, 50);
        },
        70,
        50,
    );
    // a General crosses a wadi
    let mut cross = vec![lp(Side::Us, 9, 72), lp(Side::Us, GENERAL_OF_THE_ARMY, 95)];
    cross.extend(italy());
    play(
        "General crosses a wadi",
        cross,
        &|env| tele(env, 72, 32),
        72,
        62,
    );
    // a Two-Step Turn: the first step continues the turn (a second step exists), the second ends it
    {
        let mut env = ready();
        env.start_in_rollup(1);
        env.stage(&step_layout(5, BOMB), 0);
        env.set_time(T0 + 2);
        env.patch_battle(|b| b.two_step[0] = 1);
        env.two_step(0).expect("spend it");
        env.mv(0, id_of(70), 60).expect("first step");
        rows.borrow_mut().push((
            "Two-Step Turn, first step (turn continues)".into(),
            env.declare_cu,
            env.resolve_cu,
        ));
        env.mv(0, id_of(95), 85).expect("second step");
        rows.borrow_mut().push((
            "Two-Step Turn, second step (turn ends)".into(),
            env.declare_cu,
            env.resolve_cu,
        ));
    }
    // endings
    let raid = truck_raid_layout();
    play("ends: the Truck is taken", raid.clone(), none, 70, 20);
    let mut cap = step_layout(5, BOMB);
    cap.push(lp(Side::It, 3, 17));
    let env = play(
        "ends: the 200th move (cap)",
        cap,
        &|env| env.patch_battle(|b| b.moves = 199),
        70,
        60,
    );
    assert_eq!(env.battle().reason, vanguard::reason_code(EndReason::Cap));
    let stuck = vec![
        lp(Side::Us, RECON, 70),
        lp(Side::Us, GENERAL_OF_THE_ARMY, 95),
        lp(Side::It, BOMB, 5),
        lp(Side::It, BOMB, 6),
    ];
    let env = play(
        "ends: Italy has no action left (stuck)",
        stuck,
        none,
        70,
        60,
    );
    assert_eq!(env.battle().reason, vanguard::reason_code(EndReason::Stuck));
    // a third missed turn, and the time cap, through claim_timeout
    {
        let mut env = ready();
        env.start_in_rollup(1);
        env.stage(&step_layout(5, BOMB), 0);
        env.patch_battle(|b| b.timeouts = [2, 0]);
        env.set_time(env.battle().deadline + 1);
        let caller = env.oracle.insecure_clone();
        env.claim_timeout(&caller).expect("timeout");
        assert_eq!(
            env.battle().reason,
            vanguard::reason_code(EndReason::Timeouts)
        );
        rows.borrow_mut().push((
            "ends: the third missed turn".into(),
            env.declare_cu,
            env.resolve_cu,
        ));
        let mut env = ready();
        env.start_in_rollup(1);
        env.stage(&step_layout(5, BOMB), 0);
        env.set_time(env.battle().cap_deadline + 1);
        let caller = env.oracle.insecure_clone();
        env.claim_timeout(&caller).expect("cap");
        assert_eq!(env.battle().reason, vanguard::reason_code(EndReason::Cap));
        rows.borrow_mut()
            .push(("ends: the time cap".into(), env.declare_cu, env.resolve_cu));
    }
    // dense random boards (the first move of a dealt Match), plain and with the storm on that very turn
    for (seed, storm) in [
        (1u8, false),
        (2, false),
        (3, false),
        (4, false),
        (5, true),
        (6, true),
        (7, true),
    ] {
        let mut env = ready();
        env.start_in_rollup(seed);
        env.deal().expect("deal");
        if storm {
            env.patch_secret(|v| v.storm_at = 1);
        }
        let (piece, to) = legal_moves(&env)[0];
        env.set_time(env.now + 1);
        let seat = if env.battle().side_of_seat(0) == Some(Side::Us) {
            0
        } else {
            1
        };
        env.mv(seat, piece, to).expect("move");
        let stormed = env.battle().storm_done != 0;
        assert_eq!(stormed, storm, "seed {seed}");
        rows.borrow_mut().push((
            format!(
                "dense dealt board (seed {seed}){}",
                if storm { ", storm turn" } else { "" }
            ),
            env.declare_cu,
            env.resolve_cu,
        ));
    }
    let rows = rows.into_inner();
    println!("\nCU of whole instructions, rules version 6 (client budget: declare 40,000, resolve {BUDGET})");
    for (name, declare, resolve) in &rows {
        println!("  {name:<52} declare {declare:>6}   resolve {resolve:>7}");
    }
    let worst = rows.iter().map(|r| r.2).max().unwrap();
    println!("  worst resolve {worst}");
    assert!(worst < 600_000, "above 600k: back to the orchestrator");
    assert!(
        rows.iter().all(|r| r.1 <= 40_000 && r.2 <= BUDGET),
        "a reading is over the client budget"
    );
}

// --- Powers: Blast, Rescue, pass and Dig in, the sealed bytes, the wind-down ---------------------------
//
// A client turns a plaintext into the byte it sends with `plain ^ pad`; the helpers on `Env` (`seal`, `pad`) mirror
// that with `engine::seal_pad` and the Army key stored in the account.

/// Both sides hold every power piece. US: Engineer 70, Major 71, Colonel 72, Major 73, Recon 74, Bomb 75, General of
/// the Army 95, Truck 96. Italy: Engineer 0, Major 1, Colonel 2, Major 3, Recon 4, General of the Army 5, Truck 6,
/// Bomb 7.
fn power_layout() -> Vec<LayoutPiece> {
    vec![
        lp(Side::Us, ENGINEER, 70),
        lp(Side::Us, 7, 71),
        lp(Side::Us, 8, 72),
        lp(Side::Us, 7, 73),
        lp(Side::Us, RECON, 74),
        lp(Side::Us, BOMB, 75),
        lp(Side::Us, GENERAL_OF_THE_ARMY, 95),
        lp(Side::Us, TRUCK, 96),
        lp(Side::It, ENGINEER, 0),
        lp(Side::It, 7, 1),
        lp(Side::It, 8, 2),
        lp(Side::It, 7, 3),
        lp(Side::It, RECON, 4),
        lp(Side::It, GENERAL_OF_THE_ARMY, 5),
        lp(Side::It, TRUCK, 6),
        lp(Side::It, BOMB, 7),
    ]
}

/// A staged Match on `power_layout` with Army keys in place, `mover` to act (0 plays the US Army and moves first;
/// 1 plays Italy).
fn power_env(mover: usize) -> Env {
    let mut env = ready();
    env.start_in_rollup(1);
    env.stage(&power_layout(), 0);
    for seat in 0..2 {
        env.patch_army(seat, |v| v.reserved = [0x40 + seat as u8; 32]);
    }
    if mover == 1 {
        env.patch_battle(|b| b.turn = 1);
    }
    env.set_time(T0 + 2);
    env
}

/// The public Battle bytes, without the two Players' keys and the payer (every `Env` makes its own).
fn bytes_of_battle(env: &Env) -> Vec<u8> {
    let mut b = env.battle();
    b.players = [APk::default(); 2];
    b.payer = APk::default();
    anchor_lang::__private::bytemuck::bytes_of(&b).to_vec()
}

/// The event kinds still in the ring, oldest first.
fn event_kinds(env: &Env) -> Vec<u8> {
    let b = env.battle();
    (b.event_seq.saturating_sub(vanguard::RING as u32)..b.event_seq)
        .map(|seq| b.ring[(seq as usize) % vanguard::RING].kind)
        .collect()
}

struct Snap {
    battle: Account,
    armies: [Army; 2],
}

impl Env {
    fn snap(&self) -> Snap {
        Snap {
            battle: self
                .svm
                .get_account(&s(addrs(self.tmatch).battle))
                .expect("battle"),
            armies: [self.army(0), self.army(1)],
        }
    }

    fn restore(&mut self, snap: &Snap) {
        self.svm
            .set_account(s(addrs(self.tmatch).battle), snap.battle.clone())
            .expect("restore battle");
        for seat in 0..2 {
            let army = snap.armies[seat].clone();
            self.patch_army(seat, |v| *v = army);
        }
    }

    /// Declare `declare` as `seat`, resolve it in the next slot, keep the compute of both.
    fn act(&mut self, seat: usize, declare: Instruction) -> Result<(), Failed> {
        let p = self.player(seat);
        self.send(&[budget(), declare], &p.kp, &[])?;
        self.declare_cu = self.last_cu;
        let r = self.resolve(&p.kp);
        self.resolve_cu = self.last_cu;
        r
    }
}

/// Army slots (`id % 30`) of the Generals of the Army in `power_layout`: US piece 55, Italy piece 5.
const SLOT_US_GOTA: u8 = 25;
const SLOT_IT_GOTA: u8 = 5;

fn maybe_custom(err: &Failed) -> Option<u32> {
    use solana_sdk::instruction::InstructionError;
    use solana_sdk::transaction::TransactionError;
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
        _ => None,
    }
}

#[test]
fn a_blast_removes_the_engineer_and_shows_every_neighbour_both_ways() {
    let mut env = power_env(0);
    // Italy's General of the Army stands next to the Engineer at 70, and so does the US Major at 71.
    tele(&mut env, 5, 60);
    let p = env.player(0);
    let blast = env.blast_ix(p.key, id_of(70), 0);
    env.send(&[budget(), blast], &p.kp, &[]).expect("declare");
    let b = env.battle();
    assert_eq!(
        (
            b.pending_kind,
            b.pending_piece,
            b.pending_to,
            b.pending_seat
        ),
        (vanguard::PENDING_BLAST, id_of(70), 0, 0)
    );
    assert_eq!(
        b.pad_a[0],
        env.pad(0, 0, engine::SEAL_SWITCH),
        "the sealed switch byte (plain 0) sits in pad_a[0]"
    );
    assert_eq!(b.sq[id_of(70) as usize], 70, "a declare moves nothing");
    env.resolve(&p.kp).expect("resolve");
    let b = env.battle();
    assert_eq!(b.sq[id_of(70) as usize], vanguard::NO_SQ);
    assert_eq!(
        b.shown[id_of(70) as usize],
        ENGINEER,
        "the Engineer is shown"
    );
    assert_eq!(
        b.shown[5], GENERAL_OF_THE_ARMY,
        "the enemy neighbour is shown"
    );
    assert_eq!(
        b.shown[id_of(71) as usize],
        7,
        "my own neighbour is shown too"
    );
    assert_eq!(
        b.shown[id_of(72) as usize],
        0,
        "a piece two squares away is not"
    );
    assert_eq!((b.turn, b.moves, b.timeouts), (1, 1, [0, 0]));
    assert_eq!(
        (b.pending_kind, b.pad_a[0], b.action_seq),
        (vanguard::PENDING_NONE, 0, 1)
    );
    assert_eq!(
        event_kinds(&env),
        vec![vanguard::EVENT_BLAST, vanguard::EVENT_TURN]
    );
    assert_eq!(&b.ring[0].data[..3], &[id_of(70), 70, 2]);
    assert_eq!(env.army(0).ranks[id_of(70) as usize % 30], ENGINEER);
}

#[test]
fn a_rescue_sends_the_truck_to_the_colonel_and_shows_both() {
    let mut env = power_env(0);
    let p = env.player(0);
    let rescue = env.rescue_ix(p.key, id_of(72), 0);
    env.act(0, rescue).expect("rescue");
    let b = env.battle();
    assert_eq!(b.sq[id_of(72) as usize], vanguard::NO_SQ);
    assert_eq!(b.shown[id_of(72) as usize], 8);
    assert_eq!(
        b.sq[id_of(96) as usize],
        72,
        "the Truck stands on the Colonel's square"
    );
    assert_eq!(
        b.shown[id_of(96) as usize],
        engine::TRUCK,
        "and is face up for good"
    );
    assert_eq!((b.turn, b.moves), (1, 1));
    assert_eq!(
        event_kinds(&env),
        vec![vanguard::EVENT_RESCUE, vanguard::EVENT_TURN]
    );
    assert_eq!(
        &b.ring[0].data[..4],
        &[id_of(72), id_of(96), 96, 72],
        "colonel, truck, from, to"
    );
}

#[test]
fn a_blast_or_rescue_by_the_wrong_rank_costs_the_turn_and_drops_the_switch() {
    for (rescue, piece) in [(false, id_of(71)), (true, id_of(70))] {
        let mut env = power_env(0);
        let p = env.player(0);
        let switch = SLOT_US_GOTA + 1;
        let declare = if rescue {
            env.rescue_ix(p.key, piece, switch)
        } else {
            env.blast_ix(p.key, piece, switch)
        };
        env.act(0, declare)
            .expect("accepted, then refused as a missed turn");
        let b = env.battle();
        assert_eq!((b.turn, b.moves, b.timeouts), (1, 0, [1, 0]));
        assert_ne!(
            b.sq[piece as usize],
            vanguard::NO_SQ,
            "nothing was blown up"
        );
        assert_eq!(
            env.army(0).ranks[SLOT_US_GOTA as usize],
            GENERAL_OF_THE_ARMY,
            "the switch rode on an action the rules refused, so it is dropped"
        );
        assert_eq!(event_kinds(&env), vec![vanguard::EVENT_TURN]);
    }
}

#[test]
fn a_pass_is_a_missed_turn_and_a_dig_in_looks_exactly_like_it() {
    let major = id_of(71);
    let mut results = vec![];
    for plain_slot in [0u8, major % 30 + 1, 99] {
        let mut env = power_env(0);
        let p = env.player(0);
        let pass = env.pass_ix(p.key, plain_slot, 0);
        env.send(&[budget(), pass], &p.kp, &[]).expect("declare");
        let b = env.battle();
        assert_eq!(b.pending_kind, vanguard::PENDING_PASS);
        assert_eq!(
            b.pending_piece,
            plain_slot ^ env.pad(0, 0, engine::SEAL_DIG),
            "the sealed Dig in byte is in pending_piece"
        );
        env.resolve(&p.kp).expect("resolve");
        let b = env.battle();
        assert_eq!((b.turn, b.moves, b.timeouts), (1, 0, [1, 0]));
        assert_eq!(
            event_kinds(&env),
            vec![vanguard::EVENT_PASS, vanguard::EVENT_TURN]
        );
        results.push((bytes_of_battle(&env), env.army(0).ranks));
    }
    assert_eq!(
        results[0].0, results[1].0,
        "a Dig in and a pass: the same public bytes"
    );
    assert_eq!(results[0].0, results[2].0, "an invalid Dig in too");
    assert_eq!(results[0].1[major as usize % 30], 7);
    assert_eq!(results[1].1[major as usize % 30], engine::DUG_IN);
    assert_eq!(results[2].1[major as usize % 30], 7);
}

#[test]
fn a_switch_rides_on_a_move_and_nothing_public_says_so() {
    let mut env = power_env(0);
    let p = env.player(0);
    let mv = env.move_ix_switch(p.key, id_of(74), 64, SLOT_US_GOTA + 1);
    env.act(0, mv).expect("move");
    assert_eq!(env.army(0).ranks[SLOT_US_GOTA as usize], engine::SWITCHED);
    assert_eq!(
        env.battle().shown[id_of(95) as usize],
        0,
        "nothing public says the 10 changed"
    );
    assert_eq!(env.battle().sq[id_of(74) as usize], 64);
    assert_eq!(
        event_kinds(&env),
        vec![vanguard::EVENT_MOVE, vanguard::EVENT_TURN]
    );
}

#[test]
fn a_declare_sealed_for_another_turn_is_refused() {
    let mut env = power_env(0);
    let p = env.player(0);
    let seq = env.battle().action_seq;
    let stale = [
        env.declare_ix(
            p.key,
            vanguard::instruction::MovePiece {
                piece: id_of(74),
                to: 64,
                expected_seq: seq + 1,
                sealed_switch: 0,
            },
        ),
        env.declare_ix(
            p.key,
            vanguard::instruction::Blast {
                piece: id_of(70),
                expected_seq: seq.wrapping_sub(1),
                sealed_switch: 0,
            },
        ),
        env.declare_ix(
            p.key,
            vanguard::instruction::Rescue {
                piece: id_of(72),
                expected_seq: 7,
                sealed_switch: 0,
            },
        ),
        env.declare_ix(
            p.key,
            vanguard::instruction::Pass {
                expected_seq: u32::MAX,
                sealed_slot: 0,
                sealed_switch: 0,
            },
        ),
    ];
    for declare in stale {
        let err = env.send(&[budget(), declare], &p.kp, &[]).unwrap_err();
        assert_eq!(custom_code(&err), vcode(VanguardError::StaleSeq));
    }
    assert_eq!(env.battle().pending_kind, vanguard::PENDING_NONE);
    // A timeout claimed in between moves the seq on: what was sealed for the old one is refused, the new seq works.
    let sealed_for_old = env.move_ix(p.key, id_of(74), 64);
    env.set_time(env.battle().deadline + 1);
    let bob = env.bob.kp.insecure_clone();
    env.claim_timeout(&bob).expect("timeout");
    assert_eq!(env.battle().action_seq, seq + 1);
    // hand the turn back to Alice with the clock open and try the old bytes
    env.patch_battle(|b| b.turn = 0);
    let t = env.battle().deadline - 1;
    env.set_time(t);
    let err = env
        .send(&[budget(), sealed_for_old], &p.kp, &[])
        .unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::StaleSeq));
    let fresh = env.move_ix(p.key, id_of(74), 64);
    env.send(&[budget(), fresh], &p.kp, &[])
        .expect("the new seq is accepted");
}

#[test]
fn the_new_declares_check_public_state_only() {
    let mut env = power_env(0);
    let (p, bob) = (env.player(0), env.player(1));
    // not your turn
    let wrong_turn = env.pass_ix(bob.key, 0, 0);
    let err = env.send(&[budget(), wrong_turn], &bob.kp, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::NotYourTurn));
    // the enemy's piece, a piece off the board, a piece that does not exist
    env.patch_battle(|b| b.sq[id_of(73) as usize] = vanguard::NO_SQ);
    for (piece, want) in [
        (5u8, VanguardError::NotYourTurn),
        (id_of(73), VanguardError::IllegalMove),
        (77, VanguardError::IllegalMove),
        (255, VanguardError::IllegalMove),
    ] {
        for declare in [
            env.blast_ix(p.key, piece, 0),
            env.rescue_ix(p.key, piece, 0),
        ] {
            let err = env.send(&[budget(), declare], &p.kp, &[]).unwrap_err();
            assert_eq!(custom_code(&err), vcode(want), "piece {piece}");
        }
    }
    // inside a Two-Step Turn, and after a first step
    env.patch_battle(|b| {
        b.two_step[0] = 1;
        b.two_step_active = 1;
    });
    for declare in [
        env.blast_ix(p.key, id_of(70), 0),
        env.rescue_ix(p.key, id_of(72), 0),
        env.pass_ix(p.key, 0, 0),
    ] {
        let err = env.send(&[budget(), declare], &p.kp, &[]).unwrap_err();
        assert_eq!(custom_code(&err), vcode(VanguardError::IllegalMove));
    }
    env.patch_battle(|b| {
        b.two_step_active = 0;
        b.moved = 1 << id_of(74);
    });
    let pass = env.pass_ix(p.key, 0, 0);
    let err = env.send(&[budget(), pass], &p.kp, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::IllegalMove));
    // after the clock
    env.patch_battle(|b| b.moved = 0);
    env.set_time(env.battle().deadline + 1);
    let pass = env.pass_ix(p.key, 0, 0);
    let err = env.send(&[budget(), pass], &p.kp, &[]).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::TurnExpired));
    assert_eq!(env.battle().pending_kind, vanguard::PENDING_NONE);
}

#[test]
fn three_missed_turns_lose_and_a_blast_resets_the_count() {
    let mut env = power_env(0);
    env.patch_battle(|b| b.timeouts = [2, 0]);
    let p = env.player(0);
    // a Blast is a move: it resets the missed turns
    let blast = env.blast_ix(p.key, id_of(70), 0);
    env.act(0, blast).expect("blast");
    assert_eq!(env.battle().timeouts, [0, 0]);
    // the third missed turn in a row
    env.patch_battle(|b| {
        b.turn = 0;
        b.timeouts = [2, 0];
    });
    let pass = env.pass_ix(p.key, 0, 0);
    env.act(0, pass).expect("third missed turn");
    let b = env.battle();
    assert_eq!(b.status, vanguard::STATUS_OVER);
    assert_eq!(b.reason, vanguard::reason_code(EndReason::Timeouts));
    assert_eq!(b.winner, 1);
    assert_eq!(
        b.reserved[..8],
        0u64.to_le_bytes(),
        "no piece changed, so the end mask is empty"
    );
}

#[test]
fn the_end_mask_names_every_changed_piece_dead_ones_included_and_nothing_before() {
    let mut env = power_env(0);
    let p = env.player(0);
    let dig = env.pass_ix(p.key, id_of(71) % 30 + 1, 0);
    env.act(0, dig).expect("dig in");
    assert_eq!(
        env.battle().reserved,
        [0; 31],
        "nothing public while the Match lives"
    );
    // Italy switches its 10 with a move
    let bob = env.player(1);
    let mv = env.move_ix_switch(bob.key, 4, 14, SLOT_IT_GOTA + 1);
    env.act(1, mv).expect("switch");
    assert_eq!(env.battle().reserved, [0; 31]);
    // the Italian 10 dies (stand-in: off the board, its code stays in the Army), then the Match ends by timeouts
    env.patch_battle(|b| {
        b.sq[5] = vanguard::NO_SQ;
        b.shown[5] = 1;
        b.timeouts = [2, 0];
    });
    let pass = env.pass_ix(p.key, 0, 0);
    env.act(0, pass).expect("third missed turn ends it");
    let b = env.battle();
    assert_eq!(b.status, vanguard::STATUS_OVER);
    let mask = u64::from_le_bytes(b.reserved[..8].try_into().unwrap());
    assert_eq!(
        mask,
        (1u64 << id_of(71)) | (1u64 << 5),
        "the dug-in Major and the dead switched 10"
    );
    assert_eq!(b.reserved[8..], [0; 23]);
}

#[test]
fn a_deal_writes_a_fresh_key_per_army_from_its_own_stream() {
    let key_of = |seed: u8| {
        let mut env = ready();
        env.start_in_rollup(seed);
        env.deal().expect("deal");
        // the Army of the US side holds the US key, whichever seat plays it
        let b = env.battle();
        let us = usize::from(b.us_seat);
        [env.army(us).reserved, env.army(1 - us).reserved]
    };
    let a = key_of(1);
    assert_ne!(a[0], [0; 32]);
    assert_ne!(a[1], [0; 32]);
    assert_ne!(a[0], a[1], "one key per Army");
    assert_eq!(key_of(1), a, "the same secrets give the same keys");
    assert_ne!(key_of(2), a, "other secrets give other keys");
    let seed =
        anchor_lang::solana_program::hash::hashv(&[&[1u8 + 7; 32], &[1u8 + 99; 32]]).to_bytes();
    assert_eq!(
        engine::seal_keys(&seed),
        a,
        "the program draws the keys as engine::seal_keys does (US, then Italy)"
    );
}

/// One run of a sweep: every one of the 256 values of a sealed byte, built the way a client builds it (`plain ^ pad`).
struct Sweep {
    plain: u8,
    ranks: [u8; 30],
    other_ranks: [u8; 30],
    public: Vec<u8>,
    cu: (u64, u64),
}

type Maker<'a> = &'a dyn Fn(&Env, APk, u8) -> Instruction;
type Declares = Vec<(&'static str, Box<dyn Fn(&Env, APk, u8) -> Instruction>)>;
type OneByteFree = Vec<(&'static str, Box<dyn Fn(&Env, APk) -> Instruction>)>;

fn sweep(env: &mut Env, seat: usize, declare: Maker) -> Vec<Sweep> {
    let snap = env.snap();
    let mut out = vec![];
    for plain in 0..=255u8 {
        env.restore(&snap);
        let key = env.player(seat).key;
        let ix = declare(env, key, plain);
        env.act(seat, ix)
            .unwrap_or_else(|e| panic!("value {plain} must neither error nor panic: {e:?}"));
        assert_eq!(env.battle().pending_kind, vanguard::PENDING_NONE);
        out.push(Sweep {
            plain,
            ranks: env.army(seat).ranks,
            other_ranks: env.army(1 - seat).ranks,
            public: bytes_of_battle(env),
            cu: (env.declare_cu, env.resolve_cu),
        });
    }
    env.restore(&snap);
    out
}

/// No value changes the public Battle bytes, the other Army, or the compute of the declare and the whole resolve.
fn assert_flat(sweeps: &[Sweep], what: &str) {
    for sw in sweeps {
        assert_eq!(
            sw.public, sweeps[0].public,
            "{what}: value {} changed the public Battle bytes",
            sw.plain
        );
        assert_eq!(
            sw.cu, sweeps[0].cu,
            "{what}: value {} changed the compute (value 0 costs {:?})",
            sw.plain, sweeps[0].cu
        );
        assert_eq!(sw.other_ranks, sweeps[0].other_ranks);
    }
}

#[test]
fn all_256_values_of_the_sealed_switch_byte_do_what_the_spec_says_on_every_action() {
    for seat in 0..2usize {
        let gota = if seat == 0 {
            SLOT_US_GOTA
        } else {
            SLOT_IT_GOTA
        };
        let (step, blast_piece, rescue_piece) = if seat == 0 {
            ((id_of(74), 64u8), id_of(70), id_of(72))
        } else {
            ((4u8, 14u8), 0u8, 2u8)
        };
        let makers: Declares = vec![
            (
                "move",
                Box::new(move |e, k, v| e.move_ix_switch(k, step.0, step.1, v)),
            ),
            (
                "blast",
                Box::new(move |e, k, v| e.blast_ix(k, blast_piece, v)),
            ),
            (
                "rescue",
                Box::new(move |e, k, v| e.rescue_ix(k, rescue_piece, v)),
            ),
            ("pass", Box::new(|e, k, v| e.pass_ix(k, 0, v))),
        ];
        for (name, make) in makers {
            let mut env = power_env(seat);
            let sweeps = sweep(&mut env, seat, &*make);
            let what = format!("seat {seat} {name}");
            assert_flat(&sweeps, &what);
            for sw in &sweeps {
                let mut want = sweeps[0].ranks;
                if sw.plain == gota + 1 {
                    want[gota as usize] = engine::SWITCHED;
                }
                assert_eq!(sw.ranks, want, "{what}: value {}", sw.plain);
            }
        }
    }
}

#[test]
fn a_switch_sealed_for_a_dead_or_already_switched_ten_does_nothing() {
    // dead: the General of the Army left the board, its code stays in the Army
    let mut env = power_env(0);
    env.patch_battle(|b| b.sq[id_of(95) as usize] = vanguard::NO_SQ);
    let sweeps = sweep(&mut env, 0, &|e, k, v| {
        e.move_ix_switch(k, id_of(74), 64, v)
    });
    assert_flat(&sweeps, "dead 10");
    assert!(sweeps.iter().all(|s| s.ranks == sweeps[0].ranks));
    assert_eq!(sweeps[0].ranks[SLOT_US_GOTA as usize], GENERAL_OF_THE_ARMY);
    // already switched
    let mut env = power_env(0);
    env.patch_army(0, |v| v.ranks[SLOT_US_GOTA as usize] = engine::SWITCHED);
    let sweeps = sweep(&mut env, 0, &|e, k, v| {
        e.move_ix_switch(k, id_of(74), 64, v)
    });
    assert_flat(&sweeps, "switched 10");
    assert!(sweeps
        .iter()
        .all(|s| s.ranks[SLOT_US_GOTA as usize] == engine::SWITCHED));
}

#[test]
fn all_256_values_of_the_sealed_dig_in_slot_dig_in_a_live_major_or_pass_plainly() {
    for seat in 0..2usize {
        // the first Major is live; the second is dead (its code stays in the Army); slot 20 holds a dug-in Major
        let (live, dead) = if seat == 0 {
            (id_of(71) % 30, id_of(73) as usize)
        } else {
            (1u8, 3usize)
        };
        let mut env = power_env(seat);
        env.patch_battle(|b| b.sq[dead] = vanguard::NO_SQ);
        env.patch_army(seat, |v| v.ranks[20] = engine::DUG_IN);
        let sweeps = sweep(&mut env, seat, &|e, k, v| e.pass_ix(k, v, 0));
        assert_flat(&sweeps, &format!("seat {seat} dig in"));
        for sw in &sweeps {
            let mut want = sweeps[0].ranks;
            if sw.plain == live + 1 {
                want[live as usize] = engine::DUG_IN;
            }
            assert_eq!(sw.ranks, want, "seat {seat}: value {}", sw.plain);
        }
        let dug = sweeps.iter().filter(|s| s.ranks != sweeps[0].ranks).count();
        assert_eq!(dug, 1, "exactly one value digs in: the live Major's");
    }
}

#[test]
fn the_dig_in_byte_and_the_switch_byte_of_a_pass_decode_independently() {
    let mut env = power_env(0);
    let dig = id_of(71) % 30 + 1;
    let sweeps = sweep(&mut env, 0, &|e, k, v| e.pass_ix(k, dig, v));
    assert_flat(&sweeps, "valid dig in, any switch");
    assert!(sweeps
        .iter()
        .all(|s| s.ranks[id_of(71) as usize % 30] == engine::DUG_IN));
    let sweeps = sweep(&mut env, 0, &|e, k, v| e.pass_ix(k, v, SLOT_US_GOTA + 1));
    assert_flat(&sweeps, "valid switch, any dig in");
    assert!(sweeps
        .iter()
        .all(|s| s.ranks[SLOT_US_GOTA as usize] == engine::SWITCHED));
}

#[test]
fn a_switch_leaves_the_public_bytes_and_the_compute_of_the_same_attack_alone() {
    let run = |switch: bool| {
        let mut env = power_env(0);
        let p = env.player(0);
        let plain = if switch { SLOT_US_GOTA + 1 } else { 0 };
        // the Recon attacks an Italian Engineer put in its way: the same published outcome with or without the switch
        tele(&mut env, 0, 64);
        let mv = env.move_ix_switch(p.key, id_of(74), 64, plain);
        env.act(0, mv).expect("attack");
        (
            bytes_of_battle(&env),
            env.declare_cu,
            env.resolve_cu,
            env.army(0).ranks,
        )
    };
    let (plain, switched) = (run(false), run(true));
    assert_eq!(plain.0, switched.0, "public bytes");
    assert_eq!((plain.1, plain.2), (switched.1, switched.2), "compute");
    assert_ne!(plain.3, switched.3, "only the private rank code differs");
}

#[test]
fn a_dig_in_costs_what_a_pass_costs_even_under_a_tight_compute_limit() {
    let measure = |plain_slot: u8, limit: Option<u32>| -> Result<(Vec<u8>, u64), ()> {
        let mut env = power_env(0);
        let p = env.player(0);
        let pass = env.pass_ix(p.key, plain_slot, 0);
        env.send(&[budget(), pass], &p.kp, &[]).expect("declare");
        env.next_slot();
        let r = env.resolve_ix(p.key);
        let mut ixs = vec![r];
        if let Some(l) = limit {
            let mut data = vec![2u8];
            data.extend_from_slice(&l.to_le_bytes());
            ixs.insert(0, Instruction { data, ..budget() });
        }
        env.send(&ixs, &p.kp, &[])
            .map(|_| (bytes_of_battle(&env), env.last_cu))
            .map_err(|_| ())
    };
    let plain = measure(0, None).expect("a pass resolves");
    for slot in [id_of(71) % 30 + 1, id_of(73) % 30 + 1, 99, 200] {
        assert_eq!(measure(slot, None).expect("resolves"), plain, "slot {slot}");
    }
    let tight = plain.1 as u32 + 1_000;
    let short = plain.1 as u32 - 3_000;
    for slot in [0, id_of(71) % 30 + 1, id_of(73) % 30 + 1, 99] {
        assert!(measure(slot, Some(tight)).is_ok(), "slot {slot} with room");
        assert!(
            measure(slot, Some(short)).is_err(),
            "slot {slot} without room"
        );
    }
}

#[test]
fn an_impersonated_declare_of_any_new_kind_answers_the_same_for_every_hidden_rank() {
    for kind in 0..4u8 {
        let mut results = vec![];
        for (rank, sealed) in [
            (ENGINEER, 0u8),
            (BOMB, 1),
            (7, 77),
            (GENERAL_OF_THE_ARMY, 200),
            (TRUCK, 255),
            (SPY, 6),
        ] {
            let mut env = Env::build(false);
            env.open_and_join(1_000);
            env.create().expect("create");
            env.start_in_rollup(1);
            let layout = vec![
                lp(Side::Us, GENERAL_OF_THE_ARMY, 95),
                lp(Side::It, rank, 5),
                lp(Side::It, 8, 6),
            ];
            env.stage(&layout, 0);
            env.patch_battle(|b| b.turn = 1);
            env.set_time(T0 + 2);
            let alice = env.alice.kp.insecure_clone();
            let bob = env.bob.key;
            let declare = match kind {
                0 => env.blast_ix(bob, id_of(5), sealed),
                1 => env.rescue_ix(bob, id_of(5), sealed),
                2 => env.pass_ix(bob, sealed, sealed),
                _ => env.move_ix_switch(bob, id_of(5), 15, sealed),
            };
            env.svm.expire_blockhash();
            let mut tx = Transaction::new_unsigned(Message::new(
                &[budget(), declare],
                Some(&alice.pubkey()),
            ));
            tx.partial_sign(&[&alice], env.svm.latest_blockhash());
            let r = env.run(tx);
            results.push((rank, r.is_ok(), env.last_cu));
        }
        for r in &results {
            assert_eq!(
                (r.1, r.2),
                (results[0].1, results[0].2),
                "kind {kind}: {results:?}"
            );
        }
        assert!(results[0].1, "kind {kind}: accepted: public state only");
    }
}

#[test]
fn a_declare_and_a_resolve_in_one_transaction_are_refused_for_every_new_kind() {
    for kind in 0..3u8 {
        let mut env = power_env(0);
        let p = env.player(0);
        let before = bytes_of_battle(&env);
        let declare = match kind {
            0 => env.blast_ix(p.key, id_of(70), 0),
            1 => env.rescue_ix(p.key, id_of(72), 0),
            _ => env.pass_ix(p.key, 2, 0),
        };
        let r = env.resolve_ix(p.key);
        let err = env.send(&[budget(), declare, r], &p.kp, &[]).unwrap_err();
        assert_eq!(custom_code(&err), vcode(VanguardError::TooSoon));
        assert_eq!(bytes_of_battle(&env), before);
    }
}

#[test]
fn a_timeout_claim_never_applies_a_switch() {
    let mut env = power_env(0);
    let t = env.battle().deadline + 1;
    env.set_time(t);
    let bob = env.bob.kp.insecure_clone();
    env.claim_timeout_declare(&bob)
        .expect("declare the timeout");
    let b = env.battle();
    assert_eq!((b.pending_kind, b.pad_a[0]), (vanguard::PENDING_TIMEOUT, 0));
    // whatever sits in the sealed byte, a timeout resolves without a switch
    let snap = env.snap();
    for stuffed in 0..=255u8 {
        env.patch_battle(|b| b.pad_a[0] = stuffed);
        env.resolve(&bob).expect("resolve");
        assert_eq!(
            env.army(0).ranks[SLOT_US_GOTA as usize],
            GENERAL_OF_THE_ARMY
        );
        assert_eq!(env.battle().timeouts, [1, 0]);
        env.restore(&snap);
    }
}

#[test]
fn wiping_an_army_removes_the_key_and_every_rank_code_from_the_committed_bytes() {
    let mut env = power_env(0);
    let p = env.player(0);
    let dig = env.pass_ix(p.key, id_of(71) % 30 + 1, SLOT_US_GOTA + 1);
    env.act(0, dig).expect("dig in and switch");
    let mut army = env.army(0);
    let key = army.reserved;
    assert_ne!(key, [0; 32]);
    assert!(army.ranks.contains(&engine::DUG_IN) && army.ranks.contains(&engine::SWITCHED));
    army.wipe();
    let mut bytes = vec![];
    anchor_lang::AccountSerialize::try_serialize(&army, &mut bytes).unwrap();
    assert!(
        !bytes.windows(32).any(|w| w == key),
        "the key is gone from the committed bytes"
    );
    // discriminator 8, bump 1, battle 32, seat 1, player 32, side 1: then the thirty rank bytes
    assert_eq!(bytes[75..105], [0u8; 30], "no rank code is committed");
    assert_eq!(bytes[bytes.len() - 32..], [0u8; 32], "and no key");
    assert_eq!(army.ranks, [0; 30]);
    assert_eq!(army.reserved, [0; 32]);
}

// --- Wind-down of Battles created under older rules ---------------------------------------------------

/// A Battle in a lifecycle state, created under rules version 5.
fn old_battle(state: &str) -> Env {
    let mut env = ready();
    match state {
        "created" => {}
        "setup" => env.start_in_rollup(1),
        _ => {
            env.start_in_rollup(1);
            env.stage(&power_layout(), 0);
            env.set_time(T0 + 2);
        }
    }
    env.patch_battle(|b| b.rules_version = 5);
    let (slot, now) = (env.slot(), env.now);
    match state {
        "pending move" => env.patch_battle(|b| {
            b.record_pending(
                vanguard::PENDING_MOVE,
                vanguard::Intent {
                    piece: id_of(74),
                    to: 64,
                    sealed_switch: 0,
                },
                0,
                slot,
                now,
            )
        }),
        "pending timeout" => env.patch_battle(|b| {
            b.record_pending(
                vanguard::PENDING_TIMEOUT,
                vanguard::Intent::default(),
                0,
                slot,
                now,
            )
        }),
        _ => {}
    }
    env
}

#[test]
fn a_battle_on_older_rules_is_cancelled_by_claim_timeout_in_every_lifecycle_state_and_refunded() {
    for state in [
        "created",
        "setup",
        "live",
        "pending move",
        "pending timeout",
    ] {
        let mut env = old_battle(state);
        let anyone = stranger(&mut env);
        let before = (env.gemas(&env.alice), env.gemas(&env.bob));
        // at once: no deadline of the old Battle has to pass
        env.claim_timeout_declare(&anyone)
            .unwrap_or_else(|e| panic!("{state}: {e:?}"));
        let b = env.battle();
        assert_eq!(b.status, vanguard::STATUS_CANCELLED, "{state}");
        assert_eq!(b.pending_kind, vanguard::PENDING_NONE, "{state}");
        // nothing but close and finalize is left: `resolve` is refused
        let err = env.resolve(&anyone).unwrap_err();
        assert!(is_vcode(&err, VanguardError::NotLive), "{state}");
        // the close step passes its own checks (it then stops at the rollup programs, which LiteSVM lacks)
        let payer = env.bob.kp.insecure_clone();
        let close = if b.permissioned != 0 {
            close_match_ix(&env, a(payer.pubkey()))
        } else {
            close_unstarted_ix(&env, a(payer.pubkey()))
        };
        if let Err(e) = env.send(&[close], &payer, &[]) {
            if let Some(code) = maybe_custom(&e) {
                assert!(
                    code != vcode(VanguardError::MatchNotOver)
                        && code != vcode(VanguardError::WrongPhase),
                    "{state}: close refused with {code}"
                );
            }
        }
        env.finalize(true)
            .unwrap_or_else(|e| panic!("{state}: finalize {e:?}"));
        assert_eq!(env.tesoro_status(), Stage::Closed, "{state}");
        assert_eq!(
            (env.gemas(&env.alice), env.gemas(&env.bob)),
            (before.0 + 1_000, before.1 + 1_000),
            "{state}: both entries are back in full"
        );
        assert_eq!(env.battle().finalized, 1);
    }
}

#[test]
fn an_older_battle_that_is_over_still_finalizes_and_cannot_be_cancelled() {
    let mut env = old_battle("live");
    env.patch_battle(|b| {
        b.status = vanguard::STATUS_OVER;
        b.winner = 0;
        b.reason = vanguard::reason_code(EndReason::Truck);
    });
    let anyone = stranger(&mut env);
    let err = env.claim_timeout_declare(&anyone).unwrap_err();
    assert!(is_vcode(&err, VanguardError::MatchOver));
    assert_eq!(env.battle().status, vanguard::STATUS_OVER);
    let before = env.gemas(&env.alice);
    env.finalize(false).expect("a finished v5 Battle settles");
    assert!(env.gemas(&env.alice) > before, "the winner is paid");
}

#[test]
fn a_battle_on_the_current_rules_is_not_wound_down_early() {
    for state in ["created", "setup", "live"] {
        let mut env = old_battle(state);
        env.patch_battle(|b| b.rules_version = engine::RULES_VERSION);
        let anyone = stranger(&mut env);
        let err = env.claim_timeout_declare(&anyone).unwrap_err();
        assert!(
            is_vcode(&err, VanguardError::NotTimedOut)
                || is_vcode(&err, VanguardError::TooSoon)
                || is_vcode(&err, VanguardError::ActionPending),
            "{state}: {err:?}"
        );
        assert_ne!(env.battle().status, vanguard::STATUS_CANCELLED, "{state}");
    }
}

// --- Compute of whole instructions for the new kinds -------------------------------------------------

#[test]
fn compute_of_the_new_declares_and_resolves_has_headroom_in_the_client_budgets() {
    const RESOLVE_BUDGET: u64 = 200_000;
    const DECLARE_BUDGET: u64 = 40_000;
    let mut rows: Vec<(String, u64, u64)> = vec![];
    let sw = SLOT_US_GOTA + 1;
    let makers: OneByteFree = vec![
        (
            "move + switch",
            Box::new(move |e, k| e.move_ix_switch(k, id_of(74), 64, sw)),
        ),
        (
            "blast + switch",
            Box::new(move |e, k| e.blast_ix(k, id_of(70), sw)),
        ),
        (
            "rescue + switch",
            Box::new(move |e, k| e.rescue_ix(k, id_of(72), sw)),
        ),
        ("pass", Box::new(|e, k| e.pass_ix(k, 0, 0))),
        (
            "dig in + switch",
            Box::new(move |e, k| e.pass_ix(k, id_of(71) % 30 + 1, sw)),
        ),
    ];
    for (name, make) in makers {
        let mut env = power_env(0);
        let p = env.player(0);
        let ix = make(&env, p.key);
        env.act(0, ix).expect(name);
        rows.push((
            format!("{name} (power board)"),
            env.declare_cu,
            env.resolve_cu,
        ));
    }
    // dense dealt boards, the real worst case, plain and on the storm turn
    for (seed, storm) in [(1u8, false), (2, false), (5, true), (6, true)] {
        for kind in ["dig in + switch", "blast + switch", "rescue + switch"] {
            let mut env = ready();
            env.start_in_rollup(seed);
            env.deal().expect("deal");
            if storm {
                env.patch_secret(|v| v.storm_at = 1);
            }
            let seat = if env.battle().side_of_seat(0) == Some(Side::Us) {
                0
            } else {
                1
            };
            let p = env.player(seat);
            let ranks = env.army(seat).ranks;
            let slot_of = |rank: u8| ranks.iter().position(|r| *r == rank).expect("rank") as u8;
            let base = if env.battle().side_of_seat(seat) == Some(Side::Us) {
                30
            } else {
                0
            };
            let switch = slot_of(10) + 1;
            let ix = match kind {
                "dig in + switch" => env.pass_ix(p.key, slot_of(7) + 1, switch),
                "blast + switch" => env.blast_ix(p.key, base + slot_of(3), switch),
                _ => env.rescue_ix(p.key, base + slot_of(8), switch),
            };
            env.set_time(env.now + 1);
            env.act(seat, ix)
                .unwrap_or_else(|e| panic!("{kind} seed {seed}: {e:?}"));
            assert_eq!(
                env.army(seat).ranks[slot_of(10) as usize],
                engine::SWITCHED,
                "{kind} seed {seed}: the switch applied"
            );
            rows.push((
                format!(
                    "{kind}, dense dealt board (seed {seed}){}",
                    if storm { ", storm turn" } else { "" }
                ),
                env.declare_cu,
                env.resolve_cu,
            ));
        }
    }
    println!("\nCU of the new instructions (declare / whole resolve); budgets: declare {DECLARE_BUDGET}, resolve {RESOLVE_BUDGET}");
    for (name, d, r) in &rows {
        println!("  {name:<58} declare {d:>6}   resolve {r:>7}");
    }
    let worst = rows.iter().map(|r| r.2).max().unwrap();
    println!("  worst resolve {worst}");
    assert!(worst < 600_000, "above 600k: back to the orchestrator");
    for (name, d, r) in &rows {
        assert!(
            *d * 13 / 10 <= DECLARE_BUDGET && *r * 13 / 10 <= RESOLVE_BUDGET,
            "{name}: {d} / {r} leaves less than 30% headroom"
        );
    }
}

// --- The next turn must not show what the last one hid; a death keeps its change ----------------------

/// US: Major 71, Colonel 72, Recon 74, General of the Army 95, Truck 96 (no Engineer, so the Major is the only thing
/// that gives the Major's side a Dig in, and the Colonel and the Truck the only Rescue). Italy: Colonel 2, Recon 4,
/// General of the Army 5, Truck 6, Bomb 7.
fn lean_layout() -> Vec<LayoutPiece> {
    vec![
        lp(Side::Us, 7, 71),
        lp(Side::Us, 8, 72),
        lp(Side::Us, RECON, 74),
        lp(Side::Us, GENERAL_OF_THE_ARMY, 95),
        lp(Side::Us, TRUCK, 96),
        lp(Side::It, 8, 2),
        lp(Side::It, RECON, 4),
        lp(Side::It, GENERAL_OF_THE_ARMY, 5),
        lp(Side::It, TRUCK, 6),
        lp(Side::It, BOMB, 7),
    ]
}

/// Alice acts (declare + resolve), then Bob moves his Recon; returns the public bytes after Bob's resolve and the
/// compute of Bob's whole turn, optionally with Bob's resolve under a compute limit.
fn next_turn(
    alice: &dyn Fn(&Env, APk) -> Instruction,
    limit: Option<u32>,
) -> Result<(Vec<u8>, u64, u64, [u8; 30]), Failed> {
    let mut env = ready();
    env.start_in_rollup(1);
    env.stage(&lean_layout(), 0);
    for seat in 0..2 {
        env.patch_army(seat, |v| v.reserved = [0x40 + seat as u8; 32]);
    }
    env.set_time(T0 + 2);
    let ix = alice(&env, env.alice.key);
    env.act(0, ix).expect("alice acts");
    let after_alice = (env.declare_cu, env.resolve_cu);
    let bob = env.player(1);
    let mv = env.move_ix(bob.key, 4, 14);
    env.send(&[budget(), mv], &bob.kp, &[])
        .expect("bob declares");
    env.next_slot();
    let r = env.resolve_ix(bob.key);
    let mut ixs = vec![r];
    if let Some(l) = limit {
        let mut data = vec![2u8];
        data.extend_from_slice(&l.to_le_bytes());
        ixs.insert(0, Instruction { data, ..budget() });
    }
    env.send(&ixs, &bob.kp, &[])?;
    Ok((
        bytes_of_battle(&env),
        env.last_cu,
        after_alice.1,
        env.army(0).ranks,
    ))
}

fn next_turn_variants() -> OneByteFree {
    let major = id_of(71) % 30 + 1;
    let ten = SLOT_US_GOTA + 1;
    vec![
        ("plain pass", Box::new(|e, k| e.pass_ix(k, 0, 0))),
        (
            "face-down dig in",
            Box::new(move |e, k| e.pass_ix(k, major, 0)),
        ),
        (
            "invalid dig in (the Colonel)",
            Box::new(|e, k| e.pass_ix(k, id_of(72) % 30 + 1, 0)),
        ),
        (
            "invalid dig in (nothing there)",
            Box::new(|e, k| e.pass_ix(k, 29, 0)),
        ),
        ("pass + switch", Box::new(move |e, k| e.pass_ix(k, 0, ten))),
        (
            "dig in + switch",
            Box::new(move |e, k| e.pass_ix(k, major, ten)),
        ),
    ]
}

#[test]
fn the_opponents_next_resolve_costs_the_same_whatever_the_last_turn_hid() {
    let variants = next_turn_variants();
    // (Major dug in, 10 switched) per variant, as the owner's Army must show afterwards
    let transformed = [
        (false, false),
        (true, false),
        (false, false),
        (false, false),
        (false, true),
        (true, true),
    ];
    let (major, ten) = (id_of(71) as usize % 30, SLOT_US_GOTA as usize);
    let base = next_turn(&*variants[0].1, None).expect("baseline");
    for ((name, make), (dug, switched)) in variants.iter().zip(transformed) {
        let got = next_turn(&**make, None).expect(name);
        assert_eq!(
            (
                got.3[major] == engine::DUG_IN,
                got.3[ten] == engine::SWITCHED
            ),
            (dug, switched),
            "{name}: the hidden change happened (or not) in the owner's Army"
        );
        assert_eq!(got.0, base.0, "{name}: public bytes after the next turn");
        assert_eq!(got.1, base.1, "{name}: the next turn's compute, exactly");
        assert_eq!(got.2, base.2, "{name}: this turn's compute, exactly");
    }
    // Bob's resolve held to exactly what it needs: it succeeds at the measured amount and runs out one below, the
    // same for every hidden variant
    let with_limit = next_turn(&*variants[0].1, Some(1_400_000))
        .expect("limit")
        .1 as u32;
    for (name, make) in &variants {
        assert!(
            next_turn(&**make, Some(with_limit)).is_ok(),
            "{name}: at the measured limit"
        );
        let err = next_turn(&**make, Some(with_limit - 1)).expect_err(name);
        assert!(is_budget_exceeded(&err), "{name}: one below it: {err:?}");
    }
}

/// The program ran out of compute: LiteSVM reports it as `ProgramFailedToComplete` with the meter message in the log.
fn is_budget_exceeded(err: &Failed) -> bool {
    use solana_sdk::instruction::InstructionError;
    use solana_sdk::transaction::TransactionError;
    matches!(
        err.err,
        TransactionError::InstructionError(
            _,
            InstructionError::ProgramFailedToComplete
                | InstructionError::ComputationalBudgetExceeded
        )
    ) && err
        .meta
        .logs
        .iter()
        .any(|l| l.contains("exceeded CUs meter"))
}

/// A Truck that attacks something stronger and dies: whatever fuel it had (the third drive would have shown it), the
/// public bytes, the whole-resolve compute and the point where the budget runs out are the same.
#[test]
fn a_losing_truck_attack_costs_the_same_whatever_the_fuel_it_had() {
    let run = |fuel: u8, limit: Option<u32>| -> Result<(Vec<u8>, u64), Failed> {
        let mut env = ready();
        env.start_in_rollup(1);
        env.stage(&step_layout(TRUCK, BOMB), 0);
        tele(&mut env, 5, 60);
        env.patch_army(0, |v| v.fuel = fuel);
        env.set_time(T0 + 2);
        let p = env.player(0);
        let mv = env.move_ix(p.key, id_of(70), 60);
        env.send(&[budget(), mv], &p.kp, &[]).expect("declare");
        env.next_slot();
        let r = env.resolve_ix(p.key);
        let mut ixs = vec![r];
        if let Some(l) = limit {
            let mut data = vec![2u8];
            data.extend_from_slice(&l.to_le_bytes());
            ixs.insert(0, Instruction { data, ..budget() });
        }
        env.send(&ixs, &p.kp, &[])?;
        assert_eq!(
            env.battle().sq[id_of(70) as usize],
            vanguard::NO_SQ,
            "the Truck died"
        );
        assert!(!event_kinds(&env).contains(&vanguard::EVENT_SPOTTED));
        Ok((bytes_of_battle(&env), env.last_cu))
    };
    let base = run(0, None).expect("fuel 0");
    for fuel in [1u8, 2] {
        assert_eq!(run(fuel, None).expect("runs"), base, "fuel {fuel}");
    }
    let at = run(0, Some(1_400_000)).expect("limit").1 as u32;
    for fuel in [0u8, 1, 2] {
        assert!(
            run(fuel, Some(at)).is_ok(),
            "fuel {fuel} at the measured limit"
        );
        let err = run(fuel, Some(at - 1)).expect_err("one below");
        assert!(is_budget_exceeded(&err), "fuel {fuel}: {err:?}");
    }
}

#[test]
fn a_switch_that_dies_with_its_attack_keeps_its_change_in_the_army_and_the_end_mask() {
    let mut env = power_env(0);
    let p = env.player(0);
    // an Italian Recon stands next to the US General of the Army at 95; the switched 10 plays as a Spy and loses
    tele(&mut env, 4, 85);
    let attack = env.move_ix_switch(p.key, id_of(95), 85, SLOT_US_GOTA + 1);
    env.act(0, attack).expect("switch and attack");
    let b = env.battle();
    assert_eq!(
        b.sq[id_of(95) as usize],
        vanguard::NO_SQ,
        "the switched 10 died"
    );
    assert_eq!(
        b.shown[id_of(95) as usize],
        SPY,
        "shown as the Spy it fought as"
    );
    assert_eq!(
        env.army(0).ranks[SLOT_US_GOTA as usize],
        engine::SWITCHED,
        "the owner's record keeps the change"
    );
    // another resolve (Italy moves), then the Match ends by timeouts
    let bob = env.player(1);
    let mv = env.move_ix(bob.key, 2, 12);
    env.act(1, mv).expect("italy moves");
    assert_eq!(env.army(0).ranks[SLOT_US_GOTA as usize], engine::SWITCHED);
    env.patch_battle(|b| b.timeouts = [2, 0]);
    let pass = env.pass_ix(p.key, 0, 0);
    env.act(0, pass).expect("third missed turn");
    let b = env.battle();
    assert_eq!(b.status, vanguard::STATUS_OVER);
    let mask = u64::from_le_bytes(b.reserved[..8].try_into().unwrap());
    assert_eq!(
        mask,
        1u64 << id_of(95),
        "the dead switched 10 is in the end mask"
    );
}

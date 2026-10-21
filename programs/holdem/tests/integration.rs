//! LiteSVM tests: the real holdem and tesoro_core programs (`pnpm build:programs` first).
//!
//! LiteSVM has no delegation, permission or VRF programs, so the rollup-only steps
//! (`init_permissions`, `request_vrf`, the oracle callback, `close_match`) are stood in for by
//! writing the account state they would have produced. Everything else runs as deployed: `deal`
//! shuffles and deals, `act` and `claim_timeout` play the hand, and `finalize` settles or refunds
//! the tesoro_core Match by CPI signed by the `authority` PDA.
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use holdem::{Action, Deck, GameMatch, Hole};
use litesvm::LiteSVM;
use solana_sdk::account::Account;
use solana_sdk::clock::Clock;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use tesoro_core::instructions::MatchResult;
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
fn hpda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &holdem::ID).0
}
fn account_pda(auth: APk) -> APk {
    tpda(&[ACCOUNT_SEED, auth.as_ref()])
}
fn authority_pda() -> APk {
    hpda(&[holdem::AUTHORITY_SEED])
}

struct Addrs {
    game_match: APk,
    deck: APk,
    hole_0: APk,
    hole_1: APk,
}
fn addrs(tesoro_match: APk) -> Addrs {
    let game_match = hpda(&[holdem::MATCH_SEED, tesoro_match.as_ref()]);
    Addrs {
        game_match,
        deck: hpda(&[holdem::DECK_SEED, game_match.as_ref()]),
        hole_0: hpda(&[holdem::HOLE_SEED, game_match.as_ref(), &[0]]),
        hole_1: hpda(&[holdem::HOLE_SEED, game_match.as_ref(), &[1]]),
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
fn hcode(e: holdem::HoldemError) -> u32 {
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
    /// The tesoro_core Match the table is bound to.
    tmatch: APk,
    mref: Option<flow::MatchRef>,
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

    fn game_match(&self) -> GameMatch {
        self.load(addrs(self.tmatch).game_match)
    }

    fn patch_match(&mut self, f: impl FnOnce(&mut GameMatch)) {
        let ad = addrs(self.tmatch);
        let mut m = self.game_match();
        f(&mut m);
        self.store(ad.game_match, &m, holdem::ID);
    }

    fn patch_deck(&mut self, f: impl FnOnce(&mut Deck)) {
        let ad = addrs(self.tmatch);
        let mut d: Deck = self.load(ad.deck);
        f(&mut d);
        self.store(ad.deck, &d, holdem::ID);
    }

    fn gemas(&self, p: &Person) -> u64 {
        flow::gemas(&self.svm, p.account)
    }

    fn tesoro_status(&self) -> Stage {
        self.load::<MatchState>(self.tmatch).inner.stage()
    }

    /// Platform Fee Gemas in the Sources' counters.
    fn platform_fees(&self) -> u64 {
        [self.a_source, self.b_source]
            .into_iter()
            .map(|src| {
                let d = self
                    .svm
                    .get_account(&s(tesoro_core::storage::book_address(&src).0))
                    .expect("book")
                    .data;
                tesoro_core::storage::counter_get(
                    &d,
                    tesoro_core::ledger::line_store::CLASS_PLATFORM,
                )
                .map_or(0, |l| l.amount)
            })
            .sum()
    }

    /// Fee-class Gemas (the Studio Fee) in the studio's basket.
    fn studio_fees(&self) -> u64 {
        let d = self
            .svm
            .get_account(&s(tesoro_core::storage::basket_address(
                &self.studio.account,
            )
            .0))
            .expect("basket")
            .data;
        tesoro_core::ledger::line_store::LineStore::new(&d[tesoro_core::storage::DISC..])
            .expect("store")
            .fee_total()
    }

    fn receipt(&self) -> APk {
        tpda(&[b"settled", self.tmatch.as_ref()])
    }

    /// `refund_match` by `caller` (any key may try; the rules decide).
    fn core_refund_ix(&self, caller: APk) -> Instruction {
        ix(
            tesoro_core::ID,
            tesoro_core::accounts::RefundMatch {
                caller,
                payer: caller,
                game_record: game_record_pda(),
                game_program: holdem::ID,
                program_data: program_data_pda(),
                match_state: self.tmatch,
                receipt: self.receipt(),
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
                game_program: holdem::ID,
                program_data: program_data_pda(),
                match_state: self.tmatch,
                receipt: self.receipt(),
                system_program: anchor_lang::system_program::ID,
                event_authority: tpda(&[b"__event_authority"]),
                program: tesoro_core::ID,
            },
            tesoro_core::instruction::SettleMatch { result },
            vec![],
        )
    }

    /// The tesoro_core Match is opened and joined for entry 1_000, then the holdem table created.
    fn new() -> Self {
        let mut svm = LiteSVM::new();
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
            tmatch: APk::default(),
            mref: None,
            now: T0,
            last_cu: 0,
        };
        for k in [&env.admin, &env.oracle] {
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
        // The Game authority is the holdem PDA, not a keypair.
        let ctl = Keypair::new();
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
        env
    }

    fn open_and_join(&mut self, entry: u64) {
        let (alice, bob) = (dup(&self.alice), dup(&self.bob));
        let m = flow::open_match(&mut self.svm, &alice.kp, holdem::ID, entry, 1, false, 0)
            .expect("open match");
        flow::join_match(&mut self.svm, &bob.kp, &m, holdem::ID, 2).expect("join match");
        self.tmatch = m.key;
        self.mref = Some(m);
    }

    fn run_settlement(&mut self) {
        let m = self.mref.expect("a Match");
        let caller = self.oracle.insecure_clone();
        flow::run_chunks(&mut self.svm, &caller, &m);
    }

    fn create_ix(&self, creator: APk, speed: u8) -> Instruction {
        let ad = addrs(self.tmatch);
        ix(
            holdem::ID,
            holdem::accounts::CreateMatch {
                creator,
                tesoro_match: self.tmatch,
                game_record: game_record_pda(),
                account_a: self.alice.account,
                account_b: self.bob.account,
                authority: authority_pda(),
                game_match: ad.game_match,
                deck: ad.deck,
                hole_0: ad.hole_0,
                hole_1: ad.hole_1,
                tesoro_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            holdem::instruction::CreateMatch { speed },
            vec![],
        )
    }

    fn create(&mut self, speed: u8) -> Result<(), Failed> {
        let alice = self.alice.kp.insecure_clone();
        let ix = self.create_ix(self.alice.key, speed);
        self.send(&[ix], &alice, &[])
    }

    /// Stands in for `init_permissions` (which also starts the Match) and both Players'
    /// entropy plus the VRF callback for the current hand.
    fn start_in_rollup(&mut self) {
        let now = self.now;
        self.patch_match(|m| m.start(now).expect("start"));
        self.ready_deck();
    }

    fn ready_deck(&mut self) {
        let hand_no = self.game_match().hand_no;
        let seed = u8::try_from(hand_no % 250).expect("small");
        self.patch_deck(|d| {
            d.reset_for(hand_no);
            d.entropy = [seed.wrapping_add(7); 32];
            d.contributed = [true, true];
            d.vrf_seen = true;
            d.vrf = [seed.wrapping_add(99); 32];
        });
    }

    fn deal(&mut self) -> Result<(), Failed> {
        let ad = addrs(self.tmatch);
        let payer = self.alice.kp.insecure_clone();
        let deal = ix(
            holdem::ID,
            holdem::accounts::Deal {
                payer: self.alice.key,
                game_match: ad.game_match,
                deck: ad.deck,
                hole_0: ad.hole_0,
                hole_1: ad.hole_1,
            },
            holdem::instruction::Deal {},
            vec![],
        );
        self.send(&[deal], &payer, &[])
    }

    fn act(&mut self, seat: usize, action: Action) -> Result<(), Failed> {
        let ad = addrs(self.tmatch);
        let (kp, key) = if seat == 0 {
            (self.alice.kp.insecure_clone(), self.alice.key)
        } else {
            (self.bob.kp.insecure_clone(), self.bob.key)
        };
        let act = ix(
            holdem::ID,
            holdem::accounts::Act {
                player: key,
                game_match: ad.game_match,
                deck: ad.deck,
                hole_0: ad.hole_0,
                hole_1: ad.hole_1,
            },
            holdem::instruction::Act { action },
            vec![],
        );
        self.send(&[act], &kp, &[])
    }

    fn claim_timeout(&mut self, caller: &Keypair) -> Result<(), Failed> {
        let ad = addrs(self.tmatch);
        let claim = ix(
            holdem::ID,
            holdem::accounts::ClaimTimeout {
                caller: a(caller.pubkey()),
                game_match: ad.game_match,
                deck: ad.deck,
                hole_0: ad.hole_0,
                hole_1: ad.hole_1,
            },
            holdem::instruction::ClaimTimeout {},
            vec![],
        );
        self.send(&[claim], caller, &[])
    }

    /// Starts the settlement or refund by `finalize` and runs its chunks.
    fn finalize(&mut self, _refund: bool) -> Result<(), Failed> {
        self.finalize_with(vec![])?;
        self.run_settlement();
        Ok(())
    }

    fn finalize_with(&mut self, remaining: Vec<AccountMeta>) -> Result<(), Failed> {
        let caller = self.oracle.insecure_clone();
        let finalize = self.finalize_ix(self.tmatch, remaining);
        self.send(&[finalize], &caller, &[])
    }

    fn finalize_ix(&self, tesoro_match: APk, remaining: Vec<AccountMeta>) -> Instruction {
        let ad = addrs(self.tmatch);
        let caller = self.oracle.insecure_clone();
        ix(
            holdem::ID,
            holdem::accounts::Finalize {
                caller: a(caller.pubkey()),
                game_match: ad.game_match,
                tesoro_match,
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
            remaining,
        )
    }
}

fn ready(speed: u8) -> Env {
    let mut env = Env::new();
    env.open_and_join(1_000);
    env.create(speed).expect("create match");
    env
}

// --- Security audit 2026-09-30: proof tests ------------------------------------------------------
// Security review 2026-09-30 (findings F-01, F-02, F-03).

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

/// F-01. `delegate_match` is callable by anyone and used to pass whatever validator the caller
/// named (or none, which the delegation program reads as the public default validator). The
/// validator named at delegation is the only key that can commit state back, so a Player could
/// commit a table they had won. Delegation is pinned to the TEE validator.
#[test]
fn f01_delegation_is_pinned_to_the_tee_validator() {
    let mut env = ready(0);
    let ad = addrs(env.tmatch);
    let dlp = sdk_key(ephemeral_rollups_sdk::id());
    let derive = |seeds: &[&[u8]], program: &APk| APk::find_program_address(seeds, program).0;
    let buffer = |k: APk| derive(&[b"buffer", k.as_ref()], &holdem::ID);
    let record = |k: APk| derive(&[b"delegation", k.as_ref()], &dlp);
    let meta = |k: APk| derive(&[b"delegation-metadata", k.as_ref()], &dlp);
    let attacker = env.bob.kp.insecure_clone();
    for validator in [Some(a(attacker.pubkey())), None] {
        let delegate = ix(
            holdem::ID,
            holdem::accounts::DelegateMatch {
                payer: a(attacker.pubkey()),
                buffer_game_match: buffer(ad.game_match),
                delegation_record_game_match: record(ad.game_match),
                delegation_metadata_game_match: meta(ad.game_match),
                game_match: ad.game_match,
                buffer_deck: buffer(ad.deck),
                delegation_record_deck: record(ad.deck),
                delegation_metadata_deck: meta(ad.deck),
                deck: ad.deck,
                buffer_hole_0: buffer(ad.hole_0),
                delegation_record_hole_0: record(ad.hole_0),
                delegation_metadata_hole_0: meta(ad.hole_0),
                hole_0: ad.hole_0,
                buffer_hole_1: buffer(ad.hole_1),
                delegation_record_hole_1: record(ad.hole_1),
                delegation_metadata_hole_1: meta(ad.hole_1),
                hole_1: ad.hole_1,
                validator,
                owner_program: holdem::ID,
                delegation_program: dlp,
                system_program: anchor_lang::system_program::ID,
            },
            holdem::instruction::DelegateMatch {
                tesoro_match: env.tmatch,
            },
            vec![],
        );
        let err = env.send(&[delegate], &attacker, &[]).unwrap_err();
        assert!(
            err.meta.logs.iter().any(|l| l.contains("InvalidValidator")),
            "validator {validator:?} must be refused, got {:?}",
            err.meta.logs
        );
    }
}

/// Audit 2026-10-16 G-1. `delegate_match` is permissionless and checked only the validator, so
/// once the table had been committed back to the base layer anyone could delegate it again. The
/// accounts then belong to the delegation program and `finalize` can no longer read them: the
/// loser stalls the settlement until the refund window opens. A table delegates once, while it
/// is freshly created.
#[test]
fn g01_a_table_that_has_been_played_cannot_be_delegated_again() {
    let mut env = ready(0);
    env.patch_match(|m| m.status = holdem::STATUS_OVER);
    let ad = addrs(env.tmatch);
    let dlp = sdk_key(ephemeral_rollups_sdk::id());
    let derive = |seeds: &[&[u8]], program: &APk| APk::find_program_address(seeds, program).0;
    let buffer = |k: APk| derive(&[b"buffer", k.as_ref()], &holdem::ID);
    let record = |k: APk| derive(&[b"delegation", k.as_ref()], &dlp);
    let meta = |k: APk| derive(&[b"delegation-metadata", k.as_ref()], &dlp);
    let attacker = env.bob.kp.insecure_clone();
    let delegate = ix(
        holdem::ID,
        holdem::accounts::DelegateMatch {
            payer: a(attacker.pubkey()),
            buffer_game_match: buffer(ad.game_match),
            delegation_record_game_match: record(ad.game_match),
            delegation_metadata_game_match: meta(ad.game_match),
            game_match: ad.game_match,
            buffer_deck: buffer(ad.deck),
            delegation_record_deck: record(ad.deck),
            delegation_metadata_deck: meta(ad.deck),
            deck: ad.deck,
            buffer_hole_0: buffer(ad.hole_0),
            delegation_record_hole_0: record(ad.hole_0),
            delegation_metadata_hole_0: meta(ad.hole_0),
            hole_0: ad.hole_0,
            buffer_hole_1: buffer(ad.hole_1),
            delegation_record_hole_1: record(ad.hole_1),
            delegation_metadata_hole_1: meta(ad.hole_1),
            hole_1: ad.hole_1,
            validator: Some(holdem::TEE_VALIDATOR),
            owner_program: holdem::ID,
            delegation_program: dlp,
            system_program: anchor_lang::system_program::ID,
        },
        holdem::instruction::DelegateMatch {
            tesoro_match: env.tmatch,
        },
        vec![],
    );
    let err = env.send(&[delegate], &attacker, &[]).unwrap_err();
    assert_eq!(
        custom_code(&err),
        hcode(holdem::HoldemError::AlreadyStarted)
    );
}

/// F-02. `init_permissions` treated "the permission address holds lamports" as "the permission
/// exists". Anyone can put lamports on those addresses first, after which the table starts with
/// the Deck and the Hole cards never made private.
#[test]
fn f02_a_prefunded_permission_address_is_not_a_permission() {
    let mut env = ready(0);
    let ad = addrs(env.tmatch);
    for target in [ad.game_match, ad.deck, ad.hole_0, ad.hole_1] {
        env.svm
            .airdrop(&s(permission_pda(target)), 1_000_000)
            .expect("dust");
    }
    let payer = env.bob.kp.insecure_clone();
    let init = ix(
        holdem::ID,
        holdem::accounts::InitPermissions {
            payer: a(payer.pubkey()),
            game_match: ad.game_match,
            deck: ad.deck,
            hole_0: ad.hole_0,
            hole_1: ad.hole_1,
            match_permission: permission_pda(ad.game_match),
            deck_permission: permission_pda(ad.deck),
            hole_0_permission: permission_pda(ad.hole_0),
            hole_1_permission: permission_pda(ad.hole_1),
            permission_program: sdk_key(PERMISSION_PROGRAM_ID),
            ephemeral_vault: sdk_key(EPHEMERAL_VAULT_ID),
            magic_program: sdk_key(MAGIC_PROGRAM_ID),
        },
        holdem::instruction::InitPermissions {},
        vec![],
    );
    assert!(env.send(&[init], &payer, &[]).is_err());
    assert_eq!(env.game_match().status, holdem::STATUS_CREATED);
}

/// F-03. A tesoro_core Match becomes refundable by anyone one hour after it turns Active. The
/// table never extended that timer, so a Player who is losing could stall past the hour and
/// refund the Pot mid-Match. `create_match` now pushes the refund deadline out; only the Game's
/// own `finalize` refunds a live table.
#[test]
fn f03_a_live_table_cannot_be_refunded_from_tesoro_core_after_an_hour() {
    let mut env = ready(0);
    env.set_time(T0 + tesoro_core::ledger::MATCH_TIMEOUT_SECS + 1);
    let caller = env.bob.kp.insecure_clone();
    let refund = env.core_refund_ix(a(caller.pubkey()));
    let err = env.send(&[refund], &caller, &[]).unwrap_err();
    assert_eq!(
        custom_code(&err),
        tesoro_core::error::CORE_ERROR_OFFSET + tesoro_core::ledger::CoreError::NotExpired.code()
    );
    assert_eq!(env.tesoro_status(), Stage::Active);
}

/// The table plays in the rollup, where tesoro_core cannot be called, so the single push at
/// `create_match` covers the whole table: the deadline is a full table window from creation, and
/// only then can a stranger refund.
#[test]
fn create_match_pushes_the_refund_deadline_a_full_table_window_out() {
    let mut env = ready(0);
    let deadline = env.load::<MatchState>(env.tmatch).inner.deadline;
    assert_eq!(deadline, T0 + holdem::TABLE_WINDOW_SECS);
    env.set_time(deadline - 1);
    let caller = env.bob.kp.insecure_clone();
    let refund = env.core_refund_ix(a(caller.pubkey()));
    let err = env
        .send(std::slice::from_ref(&refund), &caller, &[])
        .unwrap_err();
    assert_eq!(
        custom_code(&err),
        tesoro_core::error::CORE_ERROR_OFFSET + tesoro_core::ledger::CoreError::NotExpired.code()
    );
    env.set_time(deadline);
    env.send(&[refund], &caller, &[])
        .expect("anyone refunds once the table window is over");
    env.run_settlement();
    assert_eq!(env.tesoro_status(), Stage::Closed);
}

#[test]
fn create_match_binds_the_tesoro_match_and_rejects_impostors() {
    let mut env = Env::new();
    // No tesoro Match yet: nothing to bind.
    let alice = env.alice.kp.insecure_clone();
    let too_early = env.create_ix(env.alice.key, 0);
    assert!(env.send(&[too_early], &alice, &[]).is_err());

    env.open_and_join(1_000);
    // A stranger cannot create the table.
    let stranger = Keypair::new();
    env.svm
        .airdrop(&stranger.pubkey(), 10 * SOL)
        .expect("airdrop");
    let bad = env.create_ix(a(stranger.pubkey()), 0);
    let err = env.send(&[bad], &stranger, &[]).unwrap_err();
    assert_eq!(custom_code(&err), hcode(holdem::HoldemError::NotAPlayer));
    // An unknown speed is refused.
    let bad_speed = env.create_ix(env.alice.key, 7);
    let err = env.send(&[bad_speed], &alice, &[]).unwrap_err();
    assert_eq!(custom_code(&err), hcode(holdem::HoldemError::InvalidSpeed));

    env.create(1).expect("create");
    let m = env.game_match();
    assert_eq!(m.players, [env.alice.key, env.bob.key]);
    assert_eq!(m.tesoro_match, env.tmatch);
    assert_eq!(m.status, holdem::STATUS_CREATED);
    assert_eq!(m.speed, 1);
    assert_eq!(m.start_deadline, T0 + holdem::START_WINDOW_SECS);
    let (_, bump) = APk::find_program_address(&[holdem::AUTHORITY_SEED], &holdem::ID);
    assert_eq!(m.authority_bump, bump);
    // The hidden accounts exist and are empty.
    let deck: Deck = env.load(addrs(env.tmatch).deck);
    assert_eq!(deck.cards, [0; 52]);
    let hole: Hole = env.load(addrs(env.tmatch).hole_1);
    assert_eq!((hole.player, hole.cards), (env.bob.key, [0, 0]));
}

#[test]
fn only_active_matches_may_be_bound() {
    let mut env = Env::new();
    let alice = env.alice.kp.insecure_clone();
    // Make the Match unjoined: only Active Matches may be bound.
    let m =
        flow::open_match(&mut env.svm, &alice, holdem::ID, 1_000, 1, false, 0).expect("open only");
    env.tmatch = m.key;
    // Bob has not joined: `account_b` cannot match `b.player`.
    let create = env.create_ix(env.alice.key, 0);
    let err = env.send(&[create], &alice, &[]).unwrap_err();
    assert_eq!(
        custom_code(&err),
        hcode(holdem::HoldemError::BadTesoroMatch)
    );
}

#[test]
fn deal_needs_entropy_and_vrf_then_deals_distinct_cards_and_opens_betting() {
    let mut env = ready(0);
    env.patch_match(|m| m.start(T0).expect("start"));
    // Nothing contributed yet.
    let err = env.deal().unwrap_err();
    assert_eq!(
        custom_code(&err),
        hcode(holdem::HoldemError::EntropyIncomplete)
    );
    env.ready_deck();
    env.deal().expect("deal");

    let ad = addrs(env.tmatch);
    let deck: Deck = env.load(ad.deck);
    let h0: Hole = env.load(ad.hole_0);
    let h1: Hole = env.load(ad.hole_1);
    assert!(deck.dealt);
    let mut sorted = deck.cards;
    sorted.sort_unstable();
    assert_eq!(
        sorted,
        core::array::from_fn::<u8, 52, _>(|i| i as u8),
        "a permutation of 52"
    );
    assert_eq!(h0.cards, [deck.cards[0], deck.cards[2]]);
    assert_eq!(h1.cards, [deck.cards[1], deck.cards[3]]);

    let m = env.game_match();
    assert_eq!(m.phase, holdem::PHASE_PREFLOP);
    assert_eq!(m.to_act, 0);
    assert_eq!(m.board, [holdem::NO_CARD; 5], "no board card is public yet");
    // A second deal for the same hand is refused.
    assert!(env.deal().is_err());
}

#[test]
fn different_entropy_gives_a_different_shuffle() {
    let mut a_env = ready(0);
    a_env.start_in_rollup();
    a_env.deal().expect("deal");
    let first: Deck = a_env.load(addrs(a_env.tmatch).deck);

    let mut b_env = ready(0);
    b_env.patch_match(|m| m.start(T0).expect("start"));
    b_env.patch_deck(|d| {
        d.reset_for(1);
        d.entropy = [1; 32];
        d.contributed = [true, true];
        d.vrf_seen = true;
        d.vrf = [2; 32];
    });
    b_env.deal().expect("deal");
    let second: Deck = b_env.load(addrs(b_env.tmatch).deck);
    assert_ne!(first.cards, second.cards);
}

#[test]
fn only_the_player_to_act_may_act_and_rules_are_enforced_on_chain() {
    let mut env = ready(0);
    env.start_in_rollup();
    env.deal().expect("deal");
    let err = env.act(1, Action::Check).unwrap_err();
    assert_eq!(custom_code(&err), hcode(holdem::HoldemError::NotYourTurn));
    let err = env.act(0, Action::Check).unwrap_err();
    assert_eq!(custom_code(&err), hcode(holdem::HoldemError::CannotCheck));
    let err = env.act(0, Action::Raise { to: 60 }).unwrap_err();
    assert_eq!(custom_code(&err), hcode(holdem::HoldemError::RaiseTooSmall));
    let err = env.act(0, Action::Raise { to: 9_999 }).unwrap_err();
    assert_eq!(
        custom_code(&err),
        hcode(holdem::HoldemError::NotEnoughChips)
    );
    env.act(0, Action::Call).expect("call");
    assert_eq!(env.game_match().to_act, 1);
    env.act(1, Action::Check).expect("check");
    assert_eq!(env.game_match().phase, holdem::PHASE_FLOP);
    let board = env.game_match().board;
    let deck: Deck = env.load(addrs(env.tmatch).deck);
    assert_eq!(
        board[..3],
        deck.cards[4..7],
        "the flop comes off the hidden deck"
    );
    assert_eq!(board[3], holdem::NO_CARD);
}

#[test]
fn a_stranger_cannot_act() {
    let mut env = ready(0);
    env.start_in_rollup();
    env.deal().expect("deal");
    let ad = addrs(env.tmatch);
    let stranger = Keypair::new();
    env.svm
        .airdrop(&stranger.pubkey(), 10 * SOL)
        .expect("airdrop");
    let act = ix(
        holdem::ID,
        holdem::accounts::Act {
            player: a(stranger.pubkey()),
            game_match: ad.game_match,
            deck: ad.deck,
            hole_0: ad.hole_0,
            hole_1: ad.hole_1,
        },
        holdem::instruction::Act {
            action: Action::Call,
        },
        vec![],
    );
    let err = env.send(&[act], &stranger, &[]).unwrap_err();
    assert_eq!(custom_code(&err), hcode(holdem::HoldemError::NotAPlayer));
}

#[test]
fn shove_and_call_settles_the_tesoro_match_to_the_winner_by_pda_authority() {
    let mut env = ready(1);
    env.start_in_rollup();
    env.deal().expect("deal");
    env.act(0, Action::Raise { to: 1_500 }).expect("shove");
    env.act(1, Action::Call).expect("call");
    let m = env.game_match();
    assert_eq!(m.status, holdem::STATUS_OVER);
    assert_eq!(m.phase, holdem::PHASE_NONE);
    assert_eq!(m.stacks[usize::from(m.winner)], 3_000);
    assert_eq!(m.stacks[1 - usize::from(m.winner)], 0);
    assert!(m.last_showdown);
    assert!(m.last_board.iter().all(|c| *c < 52), "the runout is public");

    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    let studio_before = env.studio_fees();
    env.finalize(false).expect("finalize settles via CPI");
    assert_eq!(env.tesoro_status(), Stage::Closed);
    assert!(env.game_match().finalized);

    // Entries are already escrowed. Pot 2,000; fees 200 + 300 bps = 40 + 60, taken from the loser's
    // entry, so the winner receives their own 1,000 back plus 900.
    let (alice, bob) = (env.gemas(&env.alice), env.gemas(&env.bob));
    if m.winner == 0 {
        assert_eq!((alice, bob), (before.0 + 1_900, before.1));
    } else {
        assert_eq!((alice, bob), (before.0, before.1 + 1_900));
    }
    // the Platform Fee lands in the loser's Source's counter, the Studio Fee as a fee line in the
    // studio's basket (the Game was listed when the Match opened)
    assert_eq!(env.platform_fees(), 40);
    assert_eq!(env.studio_fees(), studio_before + 60);

    // Settles exactly once.
    let err = env.finalize_with(vec![]).unwrap_err();
    assert_eq!(
        custom_code(&err),
        hcode(holdem::HoldemError::AlreadyFinalized)
    );
}

#[test]
fn finalize_rejects_a_live_match_and_a_foreign_tesoro_match() {
    let mut env = ready(0);
    env.start_in_rollup();
    // Still live: nothing to settle.
    let err = env.finalize_with(vec![]).unwrap_err();
    assert_eq!(custom_code(&err), hcode(holdem::HoldemError::MatchNotOver));
    assert_eq!(env.tesoro_status(), Stage::Active);

    // A different tesoro Match cannot be substituted.
    let caller = env.oracle.insecure_clone();
    let finalize = env.finalize_ix(APk::new_unique(), vec![]);
    assert!(env.send(&[finalize], &caller, &[]).is_err());
}

#[test]
fn only_the_holdem_authority_pda_settles_and_the_registered_key_is_the_pda() {
    // Directly calling tesoro_core settle_match with a random key is refused.
    let mut env = ready(1);
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
fn no_show_before_the_start_deadline_refunds_both_entries() {
    let mut env = ready(0);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    assert_eq!(
        before.0 + before.1,
        2 * 75_000 - 2_000,
        "entries are in escrow"
    );
    // Too early: the start window is still open.
    let err = env.finalize_with(vec![]).unwrap_err();
    assert_eq!(custom_code(&err), hcode(holdem::HoldemError::NotTimedOut));
    env.set_time(T0 + holdem::START_WINDOW_SECS + 1);
    env.finalize(true).expect("no-show refund via tesoro_core");
    assert_eq!(env.tesoro_status(), Stage::Closed);
    assert_eq!(env.gemas(&env.alice), before.0 + 1_000);
    assert_eq!(env.gemas(&env.bob), before.1 + 1_000);
}

#[test]
fn a_player_who_never_contributes_entropy_cancels_hand_one_and_both_are_refunded() {
    let mut env = ready(0);
    env.patch_match(|m| m.start(T0).expect("start"));
    // Only seat 0 contributed.
    env.patch_deck(|d| {
        d.reset_for(1);
        d.contributed = [true, false];
    });
    let bob = env.bob.kp.insecure_clone();
    let err = env.claim_timeout(&bob).unwrap_err();
    assert_eq!(custom_code(&err), hcode(holdem::HoldemError::NotTimedOut));
    env.set_time(T0 + holdem::ENTROPY_SECS + 1);
    env.claim_timeout(&bob)
        .expect("anyone may claim the timeout");
    assert_eq!(env.game_match().status, holdem::STATUS_CANCELLED);

    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize(true).expect("refund");
    assert_eq!(env.tesoro_status(), Stage::Closed);
    assert_eq!(env.gemas(&env.alice), before.0 + 1_000);
    assert_eq!(env.gemas(&env.bob), before.1 + 1_000);
}

#[test]
fn an_idle_player_is_auto_checked_or_folded_then_forfeits_after_three_misses() {
    let mut env = ready(0);
    env.start_in_rollup();
    env.deal().expect("deal");
    let caller = env.bob.kp.insecure_clone();
    // Seat 0 (small blind, to act) is idle: too early, then folded because facing the big blind.
    assert!(env.claim_timeout(&caller).is_err());
    let deadline = env.game_match().deadline;
    env.set_time(deadline + 1);
    env.claim_timeout(&caller).expect("timeout fold");
    let m = env.game_match();
    assert_eq!(m.last_result, 1);
    assert_eq!(m.missed, [1, 0]);
    assert_eq!(m.hand_no, 2);

    // Two more misses by seat 0 forfeit the Match to seat 1.
    env.patch_match(|m| m.missed = [2, 0]);
    env.ready_deck();
    env.deal().expect("deal hand two");
    let m = env.game_match();
    assert_eq!(m.to_act, 1, "the button alternates");
    env.act(1, Action::Call).expect("call");
    // Seat 0 (big blind) idles again: its third miss in a row forfeits the Match.
    env.set_time(env.game_match().deadline + 1);
    env.claim_timeout(&caller).expect("third miss");
    let m = env.game_match();
    assert_eq!(m.status, holdem::STATUS_OVER);
    assert_eq!(m.winner, 1);

    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize(false).expect("finalize forfeit");
    assert_eq!(env.tesoro_status(), Stage::Closed);
    assert_eq!(env.gemas(&env.alice), before.0);
    assert_eq!(env.gemas(&env.bob), before.1 + 1_900);
}

#[test]
fn a_whole_match_of_short_hands_conserves_chips_and_settles_once() {
    let mut env = ready(1);
    env.start_in_rollup();
    let mut hands = 0;
    while env.game_match().status == holdem::STATUS_LIVE {
        hands += 1;
        assert!(hands < 60, "the turbo schedule must end the Match");
        env.deal().expect("deal");
        // Seat to act calls or checks down, the other folds preflop half the time: enough variety.
        let m = env.game_match();
        let seat = usize::from(m.to_act);
        if hands % 3 == 0 {
            env.act(seat, Action::Fold).expect("fold");
        } else if hands % 3 == 1 {
            let max = m.bets[seat] + m.stacks[seat];
            env.act(seat, Action::Raise { to: max }).expect("shove");
            let other = 1 - seat;
            if env.game_match().status == holdem::STATUS_LIVE {
                env.act(other, Action::Call).expect("call");
            }
        } else {
            env.act(seat, Action::Call).expect("call");
            let other = usize::from(env.game_match().to_act);
            env.act(other, Action::Check).expect("check");
            while env.game_match().phase != holdem::PHASE_SHUFFLE
                && env.game_match().status == holdem::STATUS_LIVE
            {
                let s = usize::from(env.game_match().to_act);
                env.act(s, Action::Check).expect("check down");
            }
        }
        let m = env.game_match();
        if m.status == holdem::STATUS_LIVE {
            assert_eq!(
                m.stacks[0] + m.stacks[1] + m.committed[0] + m.committed[1],
                3_000
            );
            env.ready_deck();
        }
    }
    assert_eq!(env.game_match().status, holdem::STATUS_OVER);
    env.finalize(false).expect("finalize");
    assert_eq!(env.tesoro_status(), Stage::Closed);
}

/// CU readings (run with `--nocapture`).
#[test]
fn cu_profile_holdem() {
    let mut env = ready(0);
    env.start_in_rollup();
    env.deal().expect("deal");
    let deal = env.last_cu;
    // Hand 1: call, check, then check down to a showdown.
    env.act(0, Action::Call).expect("call");
    let call = env.last_cu;
    env.act(1, Action::Check).expect("check");
    let mut streets = 0;
    let mut showdown = 0;
    while env.game_match().phase != holdem::PHASE_SHUFFLE {
        let seat = usize::from(env.game_match().to_act);
        env.act(seat, Action::Check).expect("check down");
        streets += 1;
        showdown = env.last_cu;
    }
    env.ready_deck();
    // Following hands: shove and call until the Match ends.
    let (mut shove, mut all_in_call) = (0, 0);
    while env.game_match().status == holdem::STATUS_LIVE {
        env.deal().expect("deal next");
        let dealer = usize::from(env.game_match().to_act);
        let m = env.game_match();
        env.act(
            dealer,
            Action::Raise {
                to: m.bets[dealer] + m.stacks[dealer],
            },
        )
        .expect("shove");
        shove = env.last_cu;
        env.act(1 - dealer, Action::Call).expect("call");
        all_in_call = env.last_cu;
        if env.game_match().status == holdem::STATUS_LIVE {
            env.ready_deck();
        }
    }
    env.finalize(false).expect("finalize");
    let finalize = env.last_cu;
    println!(
        "CU deal {deal}; act call {call}; act shove {shove}; last check to showdown ({streets} checks) {showdown}; call to all-in showdown {all_in_call}; finalize {finalize}"
    );
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

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
use tesoro_core::ledger::{MatchStatus, Outcome, SourceChain};
use tesoro_core::state::*;

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
fn hpda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &holdem::ID).0
}
fn account_pda(auth: APk) -> APk {
    tpda(&[ACCOUNT_SEED, auth.as_ref()])
}
fn holding_pda(account: APk, source: APk) -> APk {
    tpda(&[HOLDING_SEED, account.as_ref(), source.as_ref()])
}
fn tmatch_pda(id: u64) -> APk {
    tpda(&[MATCH_SEED, &id.to_le_bytes()])
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
fn addrs(id: u64) -> Addrs {
    let game_match = hpda(&[holdem::MATCH_SEED, &id.to_le_bytes()]);
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
    a_holding: APk,
    b_holding: APk,
    a_source: APk,
    b_source: APk,
    id: u64,
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
    fn stake(&mut self, p: &Person, id: u8) -> (APk, APk) {
        let position = tpda(&[POSITION_SEED, &[0], &[id; 32]]);
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
                source_asset: APk::new_unique(),
                decimals: 9,
                principal: 100 * SOL,
                rate_bps: 1_000,
            },
            vec![],
        );
        let oracle = self.oracle.insecure_clone();
        self.send(&[open], &oracle, &[]).expect("open position");
        let source = tpda(&[SOURCE_SEED, position.as_ref(), &0u32.to_le_bytes()]);
        let holding = holding_pda(p.account, source);
        let advance = ix(
            tesoro_core::ID,
            tesoro_core::accounts::TakeAdvance {
                oracle: a(self.oracle.pubkey()),
                owner_authority: p.key,
                config: tpda(&[CONFIG_SEED]),
                owner_account: p.account,
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
        self.send(&[advance], &oracle, &[&p.kp]).expect("advance");
        (source, holding)
    }

    fn open_holding(&mut self, account: APk, source: APk) {
        let holding = holding_pda(account, source);
        if self.svm.get_account(&s(holding)).is_some() {
            return;
        }
        let open = ix(
            tesoro_core::ID,
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
        self.load(addrs(self.id).game_match)
    }

    fn patch_match(&mut self, f: impl FnOnce(&mut GameMatch)) {
        let ad = addrs(self.id);
        let mut m = self.game_match();
        f(&mut m);
        self.store(ad.game_match, &m, holdem::ID);
    }

    fn patch_deck(&mut self, f: impl FnOnce(&mut Deck)) {
        let ad = addrs(self.id);
        let mut d: Deck = self.load(ad.deck);
        f(&mut d);
        self.store(ad.deck, &d, holdem::ID);
    }

    fn gemas(&self, p: &Person) -> u64 {
        let acct = self.load::<TesoroAccount>(p.account).inner;
        acct.own_total + acct.won_total
    }

    fn tesoro_status(&self) -> MatchStatus {
        self.load::<MatchState>(tmatch_pda(self.id)).inner.status
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
            a_holding: APk::default(),
            b_holding: APk::default(),
            a_source: APk::default(),
            b_source: APk::default(),
            id: 1,
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
        let register = ix(
            tesoro_core::ID,
            tesoro_core::accounts::RegisterGame {
                admin: a(admin.pubkey()),
                config: tpda(&[CONFIG_SEED]),
                studio_recipient: env.studio.account,
            },
            tesoro_core::instruction::RegisterGame {
                game: holdem::ID,
                authority: authority_pda(),
                studio_bps: 300,
            },
            vec![],
        );
        env.send(&[register], &admin, &[]).expect("register game");

        env.alice = env.person();
        env.bob = env.person();
        let (alice, bob) = (dup(&env.alice), dup(&env.bob));
        (env.a_source, env.a_holding) = env.stake(&alice, 1);
        (env.b_source, env.b_holding) = env.stake(&bob, 2);
        env
    }

    fn open_and_join(&mut self, entry: u64) {
        let (alice, bob) = (dup(&self.alice), dup(&self.bob));
        let open = ix(
            tesoro_core::ID,
            tesoro_core::accounts::OpenMatch {
                player_authority: alice.key,
                config: tpda(&[CONFIG_SEED]),
                player_account: alice.account,
                match_state: tmatch_pda(self.id),
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::OpenMatch {
                match_id: self.id,
                game: holdem::ID,
                entry,
            },
            vec![rem(self.a_holding)],
        );
        self.send(&[open], &alice.kp, &[]).expect("open match");
        let join = ix(
            tesoro_core::ID,
            tesoro_core::accounts::JoinMatch {
                player_authority: bob.key,
                player_account: bob.account,
                match_state: tmatch_pda(self.id),
            },
            tesoro_core::instruction::JoinMatch {},
            vec![rem(self.b_holding)],
        );
        self.send(&[join], &bob.kp, &[]).expect("join match");
    }

    fn create_ix(&self, creator: APk, speed: u8) -> Instruction {
        let ad = addrs(self.id);
        ix(
            holdem::ID,
            holdem::accounts::CreateMatch {
                creator,
                tesoro_match: tmatch_pda(self.id),
                account_a: self.alice.account,
                account_b: self.bob.account,
                authority: authority_pda(),
                game_match: ad.game_match,
                deck: ad.deck,
                hole_0: ad.hole_0,
                hole_1: ad.hole_1,
                system_program: anchor_lang::system_program::ID,
            },
            holdem::instruction::CreateMatch {
                match_id: self.id,
                speed,
            },
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
        let ad = addrs(self.id);
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
        let ad = addrs(self.id);
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
        let ad = addrs(self.id);
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

    fn payout_metas(&mut self, refund: bool) -> Vec<AccountMeta> {
        let mut m = self.load::<MatchState>(tmatch_pda(self.id)).inner;
        let payouts = if refund {
            m.refund(i64::MAX, true).expect("refund")
        } else {
            let winner = self.game_match().winner;
            m.settle(Outcome::Winner(winner)).expect("settle")
        };
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

    fn finalize(&mut self, refund: bool) -> Result<(), Failed> {
        let remaining = self.payout_metas(refund);
        self.finalize_with(remaining)
    }

    fn finalize_with(&mut self, remaining: Vec<AccountMeta>) -> Result<(), Failed> {
        let ad = addrs(self.id);
        let caller = self.oracle.insecure_clone();
        let finalize = ix(
            holdem::ID,
            holdem::accounts::Finalize {
                caller: a(caller.pubkey()),
                game_match: ad.game_match,
                tesoro_match: tmatch_pda(self.id),
                config: tpda(&[CONFIG_SEED]),
                authority: authority_pda(),
                tesoro_program: tesoro_core::ID,
            },
            holdem::instruction::Finalize {},
            remaining,
        );
        self.send(&[finalize], &caller, &[])
    }
}

fn ready(speed: u8) -> Env {
    let mut env = Env::new();
    env.open_and_join(1_000);
    env.create(speed).expect("create match");
    env
}

// --- Security audit 2026-09-30: proof tests ------------------------------------------------------
// See docs/security/audit-2026-09-30.md (findings F-01, F-02, F-03).

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
    let ad = addrs(env.id);
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
            holdem::instruction::DelegateMatch { match_id: env.id },
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

/// F-02. `init_permissions` treated "the permission address holds lamports" as "the permission
/// exists". Anyone can put lamports on those addresses first, after which the table starts with
/// the Deck and the Hole cards never made private.
#[test]
fn f02_a_prefunded_permission_address_is_not_a_permission() {
    let mut env = ready(0);
    let ad = addrs(env.id);
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

/// CU readings (run with `--nocapture`; docs/security/audit-2026-09-30.md).
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
    env.deal().expect("deal 2");
    // Hand 2: shove and call, an all-in showdown that usually ends the Match.
    let dealer = usize::from(env.game_match().to_act);
    let m = env.game_match();
    env.act(
        dealer,
        Action::Raise {
            to: m.bets[dealer] + m.stacks[dealer],
        },
    )
    .expect("shove");
    let shove = env.last_cu;
    env.act(1 - dealer, Action::Call).expect("call");
    let all_in_call = env.last_cu;
    let mut finalize = 0;
    if env.game_match().status == holdem::STATUS_OVER {
        env.finalize(false).expect("finalize");
        finalize = env.last_cu;
    }
    println!(
        "CU deal {deal}; act call {call}; act shove {shove}; last check to showdown ({streets} checks) {showdown}; call to all-in showdown {all_in_call}; finalize {finalize}"
    );
}

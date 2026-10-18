//! LiteSVM tests: the real vanguard and tesoro_core programs (`pnpm build:programs` first).
//!
//! LiteSVM has no delegation, permission or VRF programs, so the rollup-only steps (`init_permissions`,
//! `request_vrf`, the oracle callback, `close_match`) are stood in for by writing the account state they would
//! have produced. Everything else runs as deployed: `create_match`, `set_config`, `deal`, `move_piece`,
//! `start_two_step`, `claim_timeout` and `finalize`, which settles or refunds the tesoro_core Match by CPI
//! signed by the `authority` PDA.
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
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
use tesoro_core::ledger::{MatchStatus, Outcome as CoreOutcome, SourceChain};
use tesoro_core::state::*;
use vanguard::engine::{
    self, Army as Side, EndReason, Events, Game, LayoutPiece, BOMB, CHAIN_CLOCK, ENGINEER,
    GENERAL_OF_THE_ARMY, PIECE_SLOTS, RECON, SPY, TRUCK,
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
fn vpda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &vanguard::ID).0
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
fn addrs(id: u64) -> Addrs {
    let battle = vpda(&[vanguard::BATTLE_SEED, &id.to_le_bytes()]);
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
    a_holding: APk,
    b_holding: APk,
    a_source: APk,
    b_source: APk,
    id: u64,
    now: i64,
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
    fn stake(&mut self, p: &Person, id: u8) -> (APk, APk) {
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
        let holding = holding_pda(p.account, source);
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
                holding,
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

    fn battle(&self) -> Battle {
        self.load(addrs(self.id).battle)
    }
    fn secret(&self) -> Secret {
        self.load(addrs(self.id).secret)
    }
    fn army(&self, seat: usize) -> Army {
        let ad = addrs(self.id);
        self.load(if seat == 0 { ad.army_0 } else { ad.army_1 })
    }

    fn patch_battle(&mut self, f: impl FnOnce(&mut Battle)) {
        let mut b = self.battle();
        f(&mut b);
        let mut data = <Battle as anchor_lang::Discriminator>::DISCRIMINATOR.to_vec();
        data.extend_from_slice(anchor_lang::__private::bytemuck::bytes_of(&b));
        let key = s(addrs(self.id).battle);
        let mut acct = self.svm.get_account(&key).expect("battle");
        acct.data = data;
        self.svm.set_account(key, acct).expect("set battle");
    }
    fn patch_secret(&mut self, f: impl FnOnce(&mut Secret)) {
        let mut v = self.secret();
        f(&mut v);
        self.store(addrs(self.id).secret, &v, vanguard::ID);
    }
    fn patch_army(&mut self, seat: usize, f: impl FnOnce(&mut Army)) {
        let mut v = self.army(seat);
        f(&mut v);
        let ad = addrs(self.id);
        self.store(
            if seat == 0 { ad.army_0 } else { ad.army_1 },
            &v,
            vanguard::ID,
        );
    }

    fn gemas(&self, p: &Person) -> u64 {
        let acct = self.load::<TesoroAccount>(p.account).inner;
        acct.own_total + acct.won_total
    }

    fn tesoro_status(&self) -> MatchStatus {
        self.load::<MatchState>(tmatch_pda(self.id)).inner.status
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
            a_holding: APk::default(),
            b_holding: APk::default(),
            a_source: APk::default(),
            b_source: APk::default(),
            id: 1,
            now: T0,
            last_cu: 0,
            last_logs: vec![],
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
        // The Game authority is the vanguard PDA, not a keypair.
        let register = ix(
            tesoro_core::ID,
            tesoro_core::accounts::RegisterGame {
                admin: a(admin.pubkey()),
                config: tpda(&[CONFIG_SEED]),
                studio_recipient: env.studio.account,
            },
            tesoro_core::instruction::RegisterGame {
                game: vanguard::ID,
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
                protections: tpda(&[PROTECTIONS_SEED, alice.account.as_ref()]),
                match_state: tmatch_pda(self.id),
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::OpenMatch {
                match_id: self.id,
                game: vanguard::ID,
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
                protections: tpda(&[PROTECTIONS_SEED, bob.account.as_ref()]),
                match_state: tmatch_pda(self.id),
                opener_protections: tpda(&[PROTECTIONS_SEED, alice.account.as_ref()]),
            },
            tesoro_core::instruction::JoinMatch {},
            vec![rem(self.b_holding)],
        );
        self.send(&[join], &bob.kp, &[]).expect("join match");
    }

    fn create_ix(&self, creator: APk) -> Instruction {
        let ad = addrs(self.id);
        ix(
            vanguard::ID,
            vanguard::accounts::CreateMatch {
                creator,
                tesoro_match: tmatch_pda(self.id),
                config: tpda(&[CONFIG_SEED]),
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
            vanguard::instruction::CreateMatch { match_id: self.id },
            vec![],
        )
    }

    fn create(&mut self) -> Result<(), Failed> {
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
            v.vrf_seen = true;
            v.vrf = [seed.wrapping_add(99); 32];
        });
    }

    fn deal_ix(&self, payer: APk) -> Instruction {
        let ad = addrs(self.id);
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
        self.send(&[deal], &payer, &[])
    }

    /// Lay out an explicit Match as `deal` would leave it, with Alice (seat 0) or Bob playing the US Army.
    fn stage(&mut self, layout: &[LayoutPiece], us_seat: u8) {
        let now = self.now;
        let g = Game::start(layout, Side::Us, 99, 12_345, now, CHAIN_CLOCK).expect("layout");
        self.patch_battle(|b| {
            b.us_seat = us_seat;
            b.absorb(&g, &[0; PIECE_SLOTS]);
            b.status = vanguard::STATUS_LIVE;
            b.permissioned = 1;
            b.started_at = now;
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

    fn move_ix(&self, signer: APk, piece: u8, to: u8) -> Instruction {
        let ad = addrs(self.id);
        ix(
            vanguard::ID,
            vanguard::accounts::Play {
                player: signer,
                battle: ad.battle,
                army_0: ad.army_0,
                army_1: ad.army_1,
                secret: ad.secret,
            },
            vanguard::instruction::MovePiece { piece, to },
            vec![],
        )
    }

    fn mv(&mut self, seat: usize, piece: u8, to: u8) -> Result<(), Failed> {
        let p = self.player(seat);
        let m = self.move_ix(p.key, piece, to);
        self.send(&[budget(), m], &p.kp, &[])
    }

    fn two_step(&mut self, seat: usize) -> Result<(), Failed> {
        let p = self.player(seat);
        let ad = addrs(self.id);
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

    fn claim_timeout(&mut self, caller: &Keypair) -> Result<(), Failed> {
        let ad = addrs(self.id);
        let claim = ix(
            vanguard::ID,
            vanguard::accounts::ClaimTimeout {
                caller: a(caller.pubkey()),
                battle: ad.battle,
                army_0: ad.army_0,
                army_1: ad.army_1,
                secret: ad.secret,
            },
            vanguard::instruction::ClaimTimeout {},
            vec![],
        );
        self.send(&[budget(), claim], caller, &[])
    }

    fn payout_metas(&mut self, refund: bool) -> Vec<AccountMeta> {
        let mut m = self.load::<MatchState>(tmatch_pda(self.id)).inner;
        let payouts = if refund {
            m.refund(i64::MAX, true).expect("refund")
        } else {
            let winner = self.battle().winner;
            m.settle(CoreOutcome::Winner(winner)).expect("settle")
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
            vanguard::ID,
            vanguard::accounts::Finalize {
                caller: a(caller.pubkey()),
                battle: ad.battle,
                tesoro_match: tmatch_pda(self.id),
                config: tpda(&[CONFIG_SEED]),
                authority: authority_pda(),
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
        },
        vec![],
    )
}

fn delegate_ix(env: &Env, payer: APk, validator: Option<APk>) -> Instruction {
    let ad = addrs(env.id);
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
        vanguard::instruction::DelegateMatch { match_id: env.id },
        vec![],
    )
}

fn init_permissions_ix(env: &Env, payer: APk) -> Instruction {
    let ad = addrs(env.id);
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
    let ad = addrs(env.id);
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
    let ad = addrs(env.id);
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

#[test]
fn only_the_upgrade_authority_sets_the_tee_validator() {
    let mut env = ready();
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

    env.send(&[set_config_ix(a(admin.pubkey()), TEE)], &admin, &[])
        .expect("authority sets the validator");
    let config: VanguardConfig = env.load(config_pda());
    assert_eq!(config.tee_validator, TEE);
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

    // No config yet: nothing can be delegated.
    let early = delegate_ix(&env, a(attacker.pubkey()), Some(TEE));
    assert!(env.send(&[early], &attacker, &[]).is_err());

    let admin = env.admin.insecure_clone();
    set_upgrade_authority(&mut env, a(admin.pubkey()));
    env.send(&[set_config_ix(a(admin.pubkey()), TEE)], &admin, &[])
        .expect("config");
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
    let admin = env.admin.insecure_clone();
    set_upgrade_authority(&mut env, a(admin.pubkey()));
    env.send(&[set_config_ix(a(admin.pubkey()), TEE)], &admin, &[])
        .expect("config");
    for status in [vanguard::STATUS_OVER, vanguard::STATUS_CANCELLED] {
        env.patch_battle(|b| b.status = status);
        let attacker = env.bob.kp.insecure_clone();
        let delegate = delegate_ix(&env, a(attacker.pubkey()), Some(TEE));
        let err = env.send(&[delegate], &attacker, &[]).unwrap_err();
        assert_eq!(custom_code(&err), vcode(VanguardError::AlreadyStarted));
    }
}

/// A permission address that already holds lamports is not a permission: anyone can send some to the predictable
/// address, which would mark a hidden account ready without ever making it private.
#[test]
fn a_prefunded_permission_address_is_not_a_permission() {
    let mut env = ready();
    let ad = addrs(env.id);
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
    let deadline = env.load::<MatchState>(tmatch_pda(env.id)).inner.deadline;
    assert_eq!(deadline, T0 + vanguard::TABLE_WINDOW_SECS);
    env.set_time(T0 + tesoro_core::ledger::MATCH_TIMEOUT_SECS + 1);
    let remaining = env.payout_metas(true);
    let caller = env.bob.kp.insecure_clone();
    let refund = ix(
        tesoro_core::ID,
        tesoro_core::accounts::RefundMatch {
            caller: a(caller.pubkey()),
            config: tpda(&[CONFIG_SEED]),
            match_state: tmatch_pda(env.id),
            opener_protections: None,
        },
        tesoro_core::instruction::RefundMatch {},
        remaining,
    );
    let err = env
        .send(std::slice::from_ref(&refund), &caller, &[])
        .unwrap_err();
    assert_eq!(
        custom_code(&err),
        tesoro_core::error::CORE_ERROR_OFFSET + tesoro_core::ledger::CoreError::NotExpired.code()
    );
    assert_eq!(env.tesoro_status(), MatchStatus::Active);
    env.set_time(deadline);
    env.send(&[refund], &caller, &[])
        .expect("anyone refunds once the table window is over");
    assert_eq!(env.tesoro_status(), MatchStatus::Refunded);
}

#[test]
fn create_match_binds_the_tesoro_match_and_rejects_impostors() {
    let mut env = Env::new();
    let alice = env.alice.kp.insecure_clone();
    // No tesoro Match yet: nothing to bind.
    let too_early = env.create_ix(env.alice.key);
    assert!(env.send(&[too_early], &alice, &[]).is_err());

    env.open_and_join(1_000);
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
    assert_eq!(b.tesoro_match, tmatch_pda(1));
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
    let ad = addrs(1);
    for k in [ad.battle, ad.secret, ad.army_0, ad.army_1] {
        assert!(env.svm.get_account(&s(k)).expect("account").lamports >= rent);
    }
}

#[test]
fn only_active_matches_may_be_bound() {
    let mut env = Env::new();
    let alice = env.alice.kp.insecure_clone();
    let open = ix(
        tesoro_core::ID,
        tesoro_core::accounts::OpenMatch {
            player_authority: env.alice.key,
            config: tpda(&[CONFIG_SEED]),
            player_account: env.alice.account,
            protections: tpda(&[PROTECTIONS_SEED, env.alice.account.as_ref()]),
            match_state: tmatch_pda(1),
            system_program: anchor_lang::system_program::ID,
        },
        tesoro_core::instruction::OpenMatch {
            match_id: 1,
            game: vanguard::ID,
            entry: 1_000,
        },
        vec![rem(env.a_holding)],
    );
    env.send(&[open], &alice, &[]).expect("open only");
    let create = env.create_ix(env.alice.key);
    assert!(env.send(&[create], &alice, &[]).is_err());
    assert!(env.svm.get_account(&s(addrs(1).battle)).is_none());
}

#[test]
fn the_account_sizes_are_what_the_docs_say() {
    let mut env = ready();
    let ad = addrs(env.id);
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
        assert_eq!(b.deadline, T0 + 30 + 6);
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
        let ad = addrs(env.id);
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
        let ad = addrs(env.id);
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
    assert_eq!(env.tesoro_status(), MatchStatus::Settled);
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
    // Onto my own piece, into a wadi, off the board, diagonally, a Landmine, far with a non-Recon.
    for (piece, to) in [
        (id_of(95), 96),
        (id_of(70), 42),
        (id_of(70), 100),
        (id_of(95), 84),
        (id_of(95), 55),
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
    let err = env.mv(0, id_of(96), 86).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::IllegalMove));
    let err = env.mv(0, id_of(97), 87).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::IllegalMove));
    // With fuel left, the Truck moves, and the Army account records the fuel and the turn.
    env.patch_army(0, |v| v.fuel = 1);
    env.mv(0, id_of(96), 86).expect("Truck moves");
    let army = env.army(0);
    assert_eq!(army.fuel, 2);
    assert_eq!(army.truck_turn, 0);
    assert_eq!(army.moves, 1);
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
        "a move writes no logs: {:?}",
        env.last_logs
    );
    let b = env.battle();
    assert_eq!(b.turn, 0, "the second step is still Alice's");
    assert_eq!(b.steps_left, 1);
    assert_eq!(b.deadline, T0 + 3 + 6, "each step gets a full turn");
    // The Truck cannot take both steps of a Two-Step Turn.
    let err = env.mv(0, id_of(96), 76).unwrap_err();
    assert_eq!(custom_code(&err), vcode(VanguardError::IllegalMove));
    env.mv(0, id_of(95), 85)
        .expect("second step with another piece");
    assert_eq!(env.battle().turn, 1);
    assert_eq!(env.battle().two_step_active, 0);
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
    assert_eq!(env.tesoro_status(), MatchStatus::Refunded);
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
    assert_eq!(env.tesoro_status(), MatchStatus::Refunded);
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
    assert_eq!(env.tesoro_status(), MatchStatus::Refunded);
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
    let deadline = env.load::<MatchState>(tmatch_pda(env.id)).inner.deadline;
    env.set_time(deadline);
    let remaining = env.payout_metas(true);
    let caller = env.bob.kp.insecure_clone();
    let refund = ix(
        tesoro_core::ID,
        tesoro_core::accounts::RefundMatch {
            caller: a(caller.pubkey()),
            config: tpda(&[CONFIG_SEED]),
            match_state: tmatch_pda(env.id),
            opener_protections: None,
        },
        tesoro_core::instruction::RefundMatch {},
        remaining,
    );
    env.send(&[refund], &caller, &[])
        .expect("tesoro_core refund");
    assert_eq!(env.tesoro_status(), MatchStatus::Refunded);
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
    let settle = ix(
        tesoro_core::ID,
        tesoro_core::accounts::SettleMatch {
            game_authority: a(intruder.pubkey()),
            config: tpda(&[CONFIG_SEED]),
            match_state: tmatch_pda(env.id),
        },
        tesoro_core::instruction::SettleMatch {
            result: tesoro_core::instructions::MatchResult::Opener,
        },
        vec![],
    );
    let err = env.send(&[settle], &intruder, &[]).unwrap_err();
    assert_eq!(custom_code(&err), 6000);
    let config = env.load::<Config>(tpda(&[CONFIG_SEED]));
    assert_eq!(
        config.game(&vanguard::ID).expect("registered").authority,
        authority_pda()
    );
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
                if g.scan(army, g.moved, g.two_step_active, id as u8, to).hit {
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
            assert_eq!(env.tesoro_status(), MatchStatus::Refunded);
        } else {
            let (w, l) = if b.winner == 0 {
                (after.0 - before.0, after.1 - before.1)
            } else {
                (after.1 - before.1, after.0 - before.0)
            };
            assert_eq!((w, l), (1_900, 0), "seed {seed} reason {}", b.reason);
            assert_eq!(env.tesoro_status(), MatchStatus::Settled);
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
        fee_minted: 0,
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

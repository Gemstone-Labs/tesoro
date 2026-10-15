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
use tesoro_core::ledger::{MatchStatus, Outcome, SourceChain};
use tesoro_core::state::*;
use trading_duel::{Book, Duel};

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
fn dpda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &trading_duel::ID).0
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
    dpda(&[trading_duel::AUTHORITY_SEED])
}

struct Addrs {
    duel: APk,
    book_0: APk,
    book_1: APk,
}
fn addrs(id: u64) -> Addrs {
    let duel = dpda(&[trading_duel::DUEL_SEED, &id.to_le_bytes()]);
    Addrs {
        duel,
        book_0: dpda(&[trading_duel::BOOK_SEED, duel.as_ref(), &[0]]),
        book_1: dpda(&[trading_duel::BOOK_SEED, duel.as_ref(), &[1]]),
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

    fn duel(&self) -> Duel {
        self.load(addrs(self.id).duel)
    }

    fn book(&self, seat: usize) -> Book {
        let ad = addrs(self.id);
        self.load(if seat == 0 { ad.book_0 } else { ad.book_1 })
    }

    fn patch_duel(&mut self, f: impl FnOnce(&mut Duel)) {
        let ad = addrs(self.id);
        let mut d = self.duel();
        f(&mut d);
        self.store(ad.duel, &d, trading_duel::ID);
    }

    fn gemas(&self, p: &Person) -> u64 {
        let acct = self.load::<TesoroAccount>(p.account).inner;
        acct.own_total + acct.won_total
    }

    fn tesoro_status(&self) -> MatchStatus {
        self.load::<MatchState>(tmatch_pda(self.id)).inner.status
    }

    /// The tesoro_core Match is opened and joined for entry 1_000, then the Duel created.
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
            a_holding: APk::default(),
            b_holding: APk::default(),
            a_source: APk::default(),
            b_source: APk::default(),
            id: 4_000, // asset 0 (SOL): bits 1 and 2
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
        // The Game authority is the trading_duel PDA, not a keypair.
        let register = ix(
            tesoro_core::ID,
            tesoro_core::accounts::RegisterGame {
                admin: a(admin.pubkey()),
                config: tpda(&[CONFIG_SEED]),
                studio_recipient: env.studio.account,
            },
            tesoro_core::instruction::RegisterGame {
                game: trading_duel::ID,
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
                game: trading_duel::ID,
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
            },
            tesoro_core::instruction::JoinMatch {},
            vec![rem(self.b_holding)],
        );
        self.send(&[join], &bob.kp, &[]).expect("join match");
    }

    fn create_ix(&self, creator: APk) -> Instruction {
        let ad = addrs(self.id);
        ix(
            trading_duel::ID,
            trading_duel::accounts::CreateMatch {
                creator,
                tesoro_match: tmatch_pda(self.id),
                config: tpda(&[CONFIG_SEED]),
                account_a: self.alice.account,
                account_b: self.bob.account,
                authority: authority_pda(),
                duel: ad.duel,
                book_0: ad.book_0,
                book_1: ad.book_1,
                tesoro_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            trading_duel::instruction::CreateMatch { match_id: self.id },
            vec![],
        )
    }

    fn create(&mut self) -> Result<(), Failed> {
        let alice = self.alice.kp.insecure_clone();
        let ix = self.create_ix(self.alice.key);
        self.send(&[ix], &alice, &[])
    }

    /// Stands in for `init_permissions`, which starts the Match in the rollup: anchor $100, the
    /// clock at the first second (the head start begins).
    fn start_in_rollup(&mut self) {
        let now = self.now;
        let asset = self.duel().asset;
        let anchor = ANCHOR as u64;
        self.patch_duel(|d| {
            d.status = trading_duel::STATUS_LIVE;
            d.starts_at = now;
            d.grid_at = now + trading_duel::HEAD_START_SECS;
            d.ends_at = now + trading_duel::MATCH_SECS;
            d.anchor = anchor;
            d.step = trading_duel::engine::step_for(anchor, trading_duel::STEP_PPM[asset as usize]);
            d.track.record(0, anchor);
        });
    }

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
        let asset = self.duel().asset;
        self.feed(asset, (usd * 1e8) as i64, now);
    }

    fn person_of(&self, seat: usize) -> (Keypair, APk) {
        let p = if seat == 0 { &self.alice } else { &self.bob };
        (p.kp.insecure_clone(), p.key)
    }

    fn feed_key(&self) -> APk {
        trading_duel::FEEDS[self.duel().asset as usize]
    }

    fn sample_ix(&self, caller: APk, data: impl InstructionData) -> Instruction {
        let ad = addrs(self.id);
        ix(
            trading_duel::ID,
            trading_duel::accounts::Sample {
                caller,
                duel: ad.duel,
                book_0: ad.book_0,
                book_1: ad.book_1,
                price_feed: self.feed_key(),
            },
            data,
            vec![],
        )
    }

    /// Seconds since the Match started, at the current clock.
    fn t(&self) -> i64 {
        self.now - self.duel().starts_at
    }

    /// Moves the clock to `t` seconds after the start.
    fn at(&mut self, t: i64) {
        let starts = self.duel().starts_at;
        self.set_time(starts + t);
    }

    fn pick_as(
        &mut self,
        signer: &Keypair,
        book: APk,
        column: u8,
        band: i16,
    ) -> Result<(), Failed> {
        let ad = addrs(self.id);
        let ixn = ix(
            trading_duel::ID,
            trading_duel::accounts::SetPick {
                player: a(signer.pubkey()),
                duel: ad.duel,
                book,
            },
            trading_duel::instruction::SetPick { column, band },
            vec![],
        );
        self.send(&[ixn], signer, &[])
    }

    fn pick(&mut self, seat: usize, column: u8, band: i16) -> Result<(), Failed> {
        let (kp, _) = self.person_of(seat);
        let ad = addrs(self.id);
        self.pick_as(
            &kp,
            if seat == 0 { ad.book_0 } else { ad.book_1 },
            column,
            band,
        )
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
        let ad = addrs(self.id);
        let ixn = ix(
            trading_duel::ID,
            trading_duel::accounts::EndMatch {
                caller: key,
                duel: ad.duel,
                book_0: ad.book_0,
                book_1: ad.book_1,
            },
            trading_duel::instruction::EndMatch {},
            vec![],
        );
        self.send(&[ixn], &kp, &[])
    }

    /// Jumps one second past the end of the window, then ends the Match.
    fn finish(&mut self) -> Result<(), Failed> {
        let ends = self.duel().ends_at;
        self.set_time(ends + 1);
        self.end()
    }

    fn payout_metas(&mut self, refund: bool) -> Vec<AccountMeta> {
        let mut m = self.load::<MatchState>(tmatch_pda(self.id)).inner;
        let payouts = if refund {
            m.refund(i64::MAX, true).expect("refund")
        } else {
            let winner = self.duel().winner;
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
        let ad = addrs(self.id);
        let caller = self.oracle.insecure_clone();
        let finalize = ix(
            trading_duel::ID,
            trading_duel::accounts::Finalize {
                caller: a(caller.pubkey()),
                duel: ad.duel,
                tesoro_match: tmatch_pda(self.id),
                config: tpda(&[CONFIG_SEED]),
                authority: authority_pda(),
                tesoro_program: tesoro_core::ID,
            },
            trading_duel::instruction::Finalize {},
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

/// A started Match with trading open and a $100 price.
fn live() -> Env {
    let mut env = ready();
    env.start_in_rollup();
    env.price(100.0);
    env
}

const PRICE: i64 = 100_00000000;
const ANCHOR: i64 = PRICE;

#[test]
fn create_binds_the_duel_to_the_match_and_reads_the_asset_from_the_id() {
    let env = ready();
    let d = env.duel();
    assert_eq!(d.asset, trading_duel::ASSET_SOL);
    assert_eq!(d.status, trading_duel::STATUS_CREATED);
    assert_eq!(d.players, [env.alice.key, env.bob.key]);
    assert_eq!(d.winner, trading_duel::NO_WINNER);
    let b0 = env.book(0);
    assert_eq!((b0.player, b0.seat), (env.alice.key, 0));
    assert_eq!(b0.picks, [trading_duel::NO_PICK; 12]);
    assert_eq!(b0.pick_count, 0);
    assert_eq!(env.book(1).player, env.bob.key);
    assert_eq!(d.revealed, [[trading_duel::NO_PICK; 12]; 2]);
    let m = env.load::<MatchState>(tmatch_pda(env.id)).inner;
    assert!(
        m.deadline > T0 + 3_600,
        "refund timer extended past one hour"
    );
}

#[test]
fn the_asset_follows_the_low_bits_of_the_id_and_three_is_refused() {
    for (id, asset) in [(4_002u64, 1u8), (4_004, 2)] {
        let mut env = Env::new();
        env.id = id;
        env.open_and_join(1_000);
        env.create().expect("create");
        assert_eq!(env.duel().asset, asset);
    }
    let mut env = Env::new();
    env.id = 4_006;
    env.open_and_join(1_000);
    let err = env.create().unwrap_err();
    assert_eq!(
        custom_code(&err),
        dcode(trading_duel::DuelError::InvalidAsset)
    );
}

#[test]
fn only_a_player_may_create_and_a_second_create_fails() {
    let mut env = Env::new();
    env.open_and_join(1_000);
    let stranger = env.admin.insecure_clone();
    let ix = env.create_ix(a(stranger.pubkey()));
    let err = env.send(&[ix], &stranger, &[]).unwrap_err();
    assert_eq!(
        custom_code(&err),
        dcode(trading_duel::DuelError::NotAPlayer)
    );
    env.create().expect("player creates");
    assert!(env.create().is_err());
}

const NO_PICK: i16 = trading_duel::NO_PICK;

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
    let ad = addrs(env.id);
    let stranger = env.admin.insecure_clone();
    for book in [ad.book_0, ad.book_1] {
        let err = env.pick_as(&stranger, book, 0, 0).unwrap_err();
        assert_eq!(custom_code(&err), dcode(NotAPlayer));
    }
    // Bob cannot write into Alice's Book, nor Alice into Bob's.
    let (bob, alice) = (env.bob.kp.insecure_clone(), env.alice.kp.insecure_clone());
    assert_eq!(
        custom_code(&env.pick_as(&bob, ad.book_0, 0, 0).unwrap_err()),
        dcode(NotAPlayer)
    );
    assert_eq!(
        custom_code(&env.pick_as(&alice, ad.book_1, 0, 0).unwrap_err()),
        dcode(NotAPlayer)
    );
    assert_eq!(env.book(0).pick_count + env.book(1).pick_count, 0);
}

#[test]
fn nothing_is_picked_or_ticked_before_the_match_starts() {
    use trading_duel::DuelError::*;
    let mut env = ready();
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
        env.duel().revealed,
        [[NO_PICK; 12]; 2],
        "nothing is public yet"
    );
    env.tick_at(20, 100.0).unwrap();
    let r = env.duel().revealed;
    assert_eq!((r[0][0], r[1][0]), (1, 0));
    assert_eq!(
        (r[0][1], r[1][1]),
        (NO_PICK, NO_PICK),
        "column 1 locks at 30"
    );
    env.tick_at(30, 100.0).unwrap();
    let r = env.duel().revealed;
    assert_eq!(
        (r[0][1], r[1][1]),
        (-2, NO_PICK),
        "an empty column reveals as empty"
    );
}

#[test]
fn ticks_fill_the_columns_the_line_crosses_and_carry_skipped_ones() {
    let mut env = live();
    assert_eq!(
        env.duel().track.last,
        ANCHOR as u64,
        "the anchor is the first sample"
    );
    env.tick_at(10, 100.0).unwrap();
    env.tick_at(35, 100.03).unwrap();
    env.tick_at(38, 99.99).unwrap();
    let d = env.duel();
    // Column 0 starts at the price the line entered with ($100) and extends to both extremes.
    assert_eq!(d.track.lo[0], 99_99000000);
    assert_eq!(d.track.hi[0], 100_03000000);
    assert_eq!(d.track.seen, 1);
    // No sample in column 1; the next one lands in column 2, so column 1 carries the last price.
    env.tick_at(55, 100.10).unwrap();
    let d = env.duel();
    assert_eq!((d.track.lo[1], d.track.hi[1]), (99_99000000, 99_99000000));
    assert_eq!((d.track.lo[2], d.track.hi[2]), (99_99000000, 100_10000000));
    assert_eq!(d.track.seen, 0b111);
    assert_eq!(d.track.last, 100_10000000);
    assert_eq!(d.track.last_col, 2);
}

#[test]
fn columns_are_scored_once_they_are_over() {
    let mut env = live();
    // Column 0: $100.00 to $100.02 crosses bands 0 and 1 ($0.012 each). Seat 0 picks 1 (hit), seat 1 picks 2.
    env.pick(0, 0, 1).unwrap();
    env.pick(1, 0, 2).unwrap();
    env.tick_at(35, 100.02).unwrap();
    assert_eq!(env.duel().scores, [0, 0], "column 0 is still live");
    env.tick_at(40, 100.02).unwrap();
    assert_eq!(env.duel().scores, [100, 0]);
    // Column 1 is never picked by anyone: nothing is scored.
    env.tick_at(50, 100.03).unwrap();
    assert_eq!(env.duel().scores, [100, 0]);
}

#[test]
fn ticks_work_only_inside_the_window() {
    use trading_duel::DuelError::*;
    let mut env = live();
    let ends = env.duel().ends_at;
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

#[test]
fn the_higher_score_wins_and_finalize_pays_the_winner() {
    let mut env = live();
    pick_all(&mut env, 0, 0);
    pick_all(&mut env, 1, 1);
    play_flat(&mut env);
    let d = env.duel();
    assert_eq!(d.status, trading_duel::STATUS_OVER);
    assert_eq!(d.scores, [1200, 0]);
    assert_eq!(d.winner, 0);
    assert_eq!(d.revealed, [[0; 12], [1; 12]]);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize(false).expect("settle");
    assert_eq!(
        env.gemas(&env.alice),
        before.0 + 1_900,
        "pot of 2000 less 5% fees"
    );
    assert_eq!(env.gemas(&env.bob), before.1);
    assert_eq!(env.tesoro_status(), MatchStatus::Settled);
    assert!(env.duel().finalized);
}

#[test]
fn the_second_seat_can_win() {
    let mut env = live();
    pick_all(&mut env, 0, 2);
    env.pick(1, 3, 0).unwrap();
    play_flat(&mut env);
    assert_eq!(env.duel().scores, [0, 100]);
    assert_eq!(env.duel().winner, 1);
    let before = env.gemas(&env.bob);
    env.finalize(false).expect("settle");
    assert_eq!(env.gemas(&env.bob), before + 1_900);
}

#[test]
fn equal_points_draw_and_refund_both_entries() {
    let mut env = live();
    pick_all(&mut env, 0, 0);
    pick_all(&mut env, 1, 0);
    play_flat(&mut env);
    assert_eq!(env.duel().scores, [1200, 1200]);
    assert_eq!(env.duel().winner, trading_duel::DRAW);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize(true).expect("refund");
    assert_eq!(
        (env.gemas(&env.alice), env.gemas(&env.bob)),
        (before.0 + 1_000, before.1 + 1_000)
    );
}

#[test]
fn nobody_picking_is_a_draw() {
    let mut env = live();
    play_flat(&mut env);
    assert_eq!(env.duel().scores, [0, 0]);
    assert_eq!(env.duel().winner, trading_duel::DRAW);
}

#[test]
fn a_match_with_no_ticks_still_scores_from_the_anchor() {
    let mut env = live();
    pick_all(&mut env, 0, 0);
    pick_all(&mut env, 1, 1);
    // Only the anchor is recorded: every column carries it.
    env.finish().expect("end");
    let d = env.duel();
    assert_eq!(d.track.seen, 0xfff);
    assert_eq!(d.scores, [1200, 0]);
    assert_eq!(d.winner, 0);
}

#[test]
fn a_hit_needs_the_line_to_cross_the_band_inside_the_column() {
    let mut env = live();
    env.pick(0, 2, 2).unwrap(); // $100.024 to $100.036
    env.pick(1, 2, 3).unwrap(); // $100.036 to $100.048
    env.tick_at(51, 100.0).unwrap();
    env.tick_at(55, 100.03).unwrap();
    env.tick_at(60, 100.03).unwrap();
    assert_eq!(env.duel().scores, [100, 0]);
}

#[test]
fn a_match_never_started_cancels_after_the_start_deadline_and_refunds() {
    let mut env = ready();
    let d = env.duel();
    // not before the deadline
    env.set_time(d.start_deadline);
    let err = env.finalize(true).unwrap_err();
    assert_eq!(
        custom_code(&err),
        dcode(trading_duel::DuelError::NotTimedOut)
    );
    env.set_time(d.start_deadline + 1);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize(true).expect("refund an unstarted Match");
    assert_eq!(
        (env.gemas(&env.alice), env.gemas(&env.bob)),
        (before.0 + 1_000, before.1 + 1_000)
    );
}

#[test]
fn claim_timeout_cancels_an_unstarted_duel_in_the_rollup() {
    let mut env = ready();
    let deadline = env.duel().start_deadline;
    let ad = addrs(env.id);
    let caller = env.admin.insecure_clone();
    let claim = |env: &mut Env| {
        let ixn = ix(
            trading_duel::ID,
            trading_duel::accounts::ClaimTimeout {
                caller: a(caller.pubkey()),
                duel: ad.duel,
            },
            trading_duel::instruction::ClaimTimeout {},
            vec![],
        );
        env.send(&[ixn], &caller, &[])
    };
    assert_eq!(
        custom_code(&claim(&mut env).unwrap_err()),
        dcode(trading_duel::DuelError::NotTimedOut)
    );
    env.set_time(deadline + 1);
    claim(&mut env).expect("cancel");
    assert_eq!(env.duel().status, trading_duel::STATUS_CANCELLED);
    env.finalize(true).expect("refund the cancelled Match");
    // a started Match cannot be cancelled this way
    let mut env = live();
    env.set_time(env.duel().start_deadline + 1);
    let ad = addrs(env.id);
    let caller = env.admin.insecure_clone();
    let ixn = ix(
        trading_duel::ID,
        trading_duel::accounts::ClaimTimeout {
            caller: a(caller.pubkey()),
            duel: ad.duel,
        },
        trading_duel::instruction::ClaimTimeout {},
        vec![],
    );
    assert_eq!(
        custom_code(&env.send(&[ixn], &caller, &[]).unwrap_err()),
        dcode(trading_duel::DuelError::AlreadyStarted)
    );
}

#[test]
fn a_live_match_cannot_be_finalized_early() {
    let mut env = live();
    let err = env.finalize(true).unwrap_err();
    assert_eq!(
        custom_code(&err),
        dcode(trading_duel::DuelError::MatchNotOver)
    );
}

// --- Delegation and permission guards (as in holdem's audit proofs) ---------------------------

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

#[test]
fn delegation_is_pinned_to_the_tee_validator() {
    let mut env = ready();
    let ad = addrs(env.id);
    let dlp = sdk_key(ephemeral_rollups_sdk::id());
    let derive = |seeds: &[&[u8]], program: &APk| APk::find_program_address(seeds, program).0;
    let buffer = |k: APk| derive(&[b"buffer", k.as_ref()], &trading_duel::ID);
    let record = |k: APk| derive(&[b"delegation", k.as_ref()], &dlp);
    let meta = |k: APk| derive(&[b"delegation-metadata", k.as_ref()], &dlp);
    let attacker = env.bob.kp.insecure_clone();
    for validator in [Some(a(attacker.pubkey())), None] {
        let delegate = ix(
            trading_duel::ID,
            trading_duel::accounts::DelegateMatch {
                payer: a(attacker.pubkey()),
                buffer_duel: buffer(ad.duel),
                delegation_record_duel: record(ad.duel),
                delegation_metadata_duel: meta(ad.duel),
                duel: ad.duel,
                buffer_book_0: buffer(ad.book_0),
                delegation_record_book_0: record(ad.book_0),
                delegation_metadata_book_0: meta(ad.book_0),
                book_0: ad.book_0,
                buffer_book_1: buffer(ad.book_1),
                delegation_record_book_1: record(ad.book_1),
                delegation_metadata_book_1: meta(ad.book_1),
                book_1: ad.book_1,
                validator,
                owner_program: trading_duel::ID,
                delegation_program: dlp,
                system_program: anchor_lang::system_program::ID,
            },
            trading_duel::instruction::DelegateMatch { match_id: env.id },
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

#[test]
fn starting_after_the_start_deadline_names_the_window() {
    let mut env = ready();
    let ad = addrs(env.id);
    let deadline = env.duel().start_deadline;
    env.set_time(deadline + 1);
    let payer = env.bob.kp.insecure_clone();
    env.price(100.0);
    let init = ix(
        trading_duel::ID,
        trading_duel::accounts::InitPermissions {
            payer: a(payer.pubkey()),
            duel: ad.duel,
            book_0: ad.book_0,
            book_1: ad.book_1,
            duel_permission: permission_pda(ad.duel),
            book_0_permission: permission_pda(ad.book_0),
            book_1_permission: permission_pda(ad.book_1),
            permission_program: sdk_key(PERMISSION_PROGRAM_ID),
            ephemeral_vault: sdk_key(EPHEMERAL_VAULT_ID),
            magic_program: sdk_key(MAGIC_PROGRAM_ID),
            price_feed: env.feed_key(),
        },
        trading_duel::instruction::InitPermissions {},
        vec![],
    );
    let err = env.send(&[init], &payer, &[]).unwrap_err();
    assert!(
        err.meta
            .logs
            .iter()
            .any(|l| l.contains("StartWindowPassed")),
        "{:?}",
        err.meta.logs
    );
}

#[test]
fn a_prefunded_permission_address_is_not_a_permission() {
    let mut env = ready();
    let ad = addrs(env.id);
    for target in [ad.duel, ad.book_0, ad.book_1] {
        env.svm
            .airdrop(&s(permission_pda(target)), 1_000_000)
            .expect("dust");
    }
    let payer = env.bob.kp.insecure_clone();
    env.price(100.0);
    let init = ix(
        trading_duel::ID,
        trading_duel::accounts::InitPermissions {
            payer: a(payer.pubkey()),
            duel: ad.duel,
            book_0: ad.book_0,
            book_1: ad.book_1,
            duel_permission: permission_pda(ad.duel),
            book_0_permission: permission_pda(ad.book_0),
            book_1_permission: permission_pda(ad.book_1),
            permission_program: sdk_key(PERMISSION_PROGRAM_ID),
            ephemeral_vault: sdk_key(EPHEMERAL_VAULT_ID),
            magic_program: sdk_key(MAGIC_PROGRAM_ID),
            price_feed: env.feed_key(),
        },
        trading_duel::instruction::InitPermissions {},
        vec![],
    );
    let err = env.send(&[init], &payer, &[]).unwrap_err();
    assert!(
        err.meta
            .logs
            .iter()
            .any(|l| l.contains("PermissionNotReady")),
        "{:?}",
        err.meta.logs
    );
}

#[test]
fn the_end_is_the_same_whenever_and_whoever_ends_it() {
    // The feed is not an input: ending right at the close or much later, with any price on the
    // feed, carries the last recorded price forward and gives the same result.
    let run = |delay: i64, feed_usd: f64| {
        let mut env = live();
        env.pick(0, 11, 1).unwrap();
        env.pick(1, 11, 0).unwrap();
        env.tick_at(140, 100.03).unwrap();
        let ends = env.duel().ends_at;
        env.set_time(ends + delay);
        env.price(feed_usd);
        env.end().expect("end");
        let d = env.duel();
        (d.track, d.scores, d.winner)
    };
    let on_time = run(0, 100.0);
    assert_eq!(on_time, run(3, 150.0));
    assert_eq!(on_time, run(100, 50.0));
    assert_eq!(on_time.0.last, 100_03000000);
    assert_eq!(on_time.1, [100, 100], "column 11 crossed bands 0 and 1");
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
        fee_units: 0,
        instant_units: 0,
        funded_shares: 0,
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

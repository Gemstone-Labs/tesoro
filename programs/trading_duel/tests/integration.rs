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

    /// Stands in for `init_permissions`, which starts the Match in the rollup. Trading opens
    /// `COUNTDOWN_SECS` after `now`, and the clock is moved to the first second of trading.
    fn start_in_rollup(&mut self) {
        let now = self.now;
        self.patch_duel(|d| {
            d.status = trading_duel::STATUS_LIVE;
            d.starts_at = now + trading_duel::COUNTDOWN_SECS;
            d.ends_at = d.starts_at + trading_duel::DURATION_SECS;
        });
        let starts = self.duel().starts_at;
        self.set_time(starts);
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

    fn trade_accounts(&self, player: APk, feed: APk) -> trading_duel::accounts::Trade {
        let ad = addrs(self.id);
        trading_duel::accounts::Trade {
            player,
            duel: ad.duel,
            book_0: ad.book_0,
            book_1: ad.book_1,
            price_feed: feed,
        }
    }

    fn person_of(&self, seat: usize) -> (Keypair, APk) {
        let p = if seat == 0 { &self.alice } else { &self.bob };
        (p.kp.insecure_clone(), p.key)
    }

    fn feed_key(&self) -> APk {
        trading_duel::FEEDS[self.duel().asset as usize]
    }

    fn call(&mut self, seat: usize, data: impl InstructionData) -> Result<(), Failed> {
        let (kp, key) = self.person_of(seat);
        let ix = ix(
            trading_duel::ID,
            self.trade_accounts(key, self.feed_key()),
            data,
            vec![],
        );
        self.send(&[ix], &kp, &[])
    }

    fn open(&mut self, seat: usize, side: u8, margin: u64, leverage: u8) -> Result<(), Failed> {
        self.call(
            seat,
            trading_duel::instruction::OpenPosition {
                side,
                margin,
                leverage,
            },
        )
    }

    fn close(&mut self, seat: usize) -> Result<(), Failed> {
        self.call(seat, trading_duel::instruction::ClosePosition {})
    }

    fn tick(&mut self) -> Result<(), Failed> {
        self.call(0, trading_duel::instruction::Tick {})
    }

    fn end(&mut self) -> Result<(), Failed> {
        self.call(0, trading_duel::instruction::EndMatch {})
    }

    /// Jumps past the end of the window with a fresh price at `usd`, then ends the Match.
    fn finish_at(&mut self, usd: f64) -> Result<(), Failed> {
        let ends = self.duel().ends_at;
        self.set_time(ends + 1);
        self.price(usd);
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

#[test]
fn create_binds_the_duel_to_the_match_and_reads_the_asset_from_the_id() {
    let env = ready();
    let d = env.duel();
    assert_eq!(d.asset, trading_duel::ASSET_SOL);
    assert_eq!(d.status, trading_duel::STATUS_CREATED);
    assert_eq!(d.players, [env.alice.key, env.bob.key]);
    assert_eq!(d.winner, trading_duel::NO_WINNER);
    let b0 = env.book(0);
    assert_eq!(
        (b0.cash, b0.player, b0.seat),
        (trading_duel::START_CHIPS, env.alice.key, 0)
    );
    assert_eq!(env.book(1).player, env.bob.key);
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

#[test]
fn open_and_close_move_chips_and_fill_the_log() {
    let mut env = live();
    env.open(0, trading_duel::SIDE_LONG, 1_000, 10)
        .expect("open");
    let b = env.book(0);
    assert_eq!(
        (b.cash, b.margin, b.notional, b.side),
        (9_000, 1_000, 10_000, trading_duel::SIDE_LONG)
    );
    assert_eq!(b.entry, (PRICE as u64) * 10_005 / 10_000);
    assert_eq!(env.duel().trades, [1, 0]);
    env.set_time(env.now + 10);
    env.feed(0, PRICE * 102 / 100, env.now);
    env.close(0).expect("close");
    let b = env.book(0);
    assert_eq!(b.side, trading_duel::SIDE_FLAT);
    assert!(b.cash > 10_000, "a 2% move at 10x wins: {}", b.cash);
    assert_eq!(b.fill_count, 2);
    assert_eq!(b.fills[0].kind, trading_duel::FILL_OPEN);
    assert_eq!(b.fills[1].kind, trading_duel::FILL_CLOSE);
    assert_eq!(b.fills[1].t, 10);
    assert!(b.fills[1].pnl > 0);
    // the opponent's lead reads from the public Duel
    assert_eq!(env.duel().lead, trading_duel::LEAD_SEAT_0);
}

#[test]
fn leverage_margin_and_one_position_bounds() {
    let mut env = live();
    let long = trading_duel::SIDE_LONG;
    assert_eq!(
        custom_code(&env.open(0, long, 1_000, 0).unwrap_err()),
        dcode(trading_duel::DuelError::InvalidLeverage)
    );
    assert_eq!(
        custom_code(&env.open(0, long, 1_000, 21).unwrap_err()),
        dcode(trading_duel::DuelError::InvalidLeverage)
    );
    assert_eq!(
        custom_code(&env.open(0, long, 99, 5).unwrap_err()),
        dcode(trading_duel::DuelError::MarginTooSmall)
    );
    assert_eq!(
        custom_code(&env.open(0, long, 10_001, 5).unwrap_err()),
        dcode(trading_duel::DuelError::NotEnoughChips)
    );
    assert_eq!(
        custom_code(&env.open(0, 0, 1_000, 5).unwrap_err()),
        dcode(trading_duel::DuelError::InvalidSide)
    );
    env.open(0, long, 10_000, 20)
        .expect("max leverage, whole stack");
    assert_eq!(env.book(0).notional, 200_000);
    assert_eq!(
        custom_code(&env.open(0, trading_duel::SIDE_SHORT, 100, 2).unwrap_err()),
        dcode(trading_duel::DuelError::PositionOpen)
    );
    // the other Player's book is independent
    env.open(1, trading_duel::SIDE_SHORT, 500, 3)
        .expect("opponent opens");
    assert_eq!(env.book(1).side, trading_duel::SIDE_SHORT);
}

#[test]
fn flipping_is_close_then_open() {
    let mut env = live();
    env.open(0, trading_duel::SIDE_LONG, 1_000, 5).unwrap();
    env.close(0).unwrap();
    env.open(0, trading_duel::SIDE_SHORT, 1_000, 5).unwrap();
    let b = env.book(0);
    assert_eq!(b.side, trading_duel::SIDE_SHORT);
    assert_eq!(b.trades, 2);
}

#[test]
fn a_stranger_cannot_trade_and_a_book_is_not_swappable() {
    let mut env = live();
    let stranger = env.admin.insecure_clone();
    let ixn = ix(
        trading_duel::ID,
        env.trade_accounts(a(stranger.pubkey()), env.feed_key()),
        trading_duel::instruction::OpenPosition {
            side: 1,
            margin: 500,
            leverage: 2,
        },
        vec![],
    );
    let err = env.send(&[ixn], &stranger, &[]).unwrap_err();
    assert_eq!(
        custom_code(&err),
        dcode(trading_duel::DuelError::NotAPlayer)
    );
    // books passed in the wrong slots fail the seeds
    let ad = addrs(env.id);
    let mut accts = env.trade_accounts(env.alice.key, env.feed_key());
    std::mem::swap(&mut accts.book_0, &mut accts.book_1);
    let _ = ad;
    let alice = env.alice.kp.insecure_clone();
    let ixn = ix(
        trading_duel::ID,
        accts,
        trading_duel::instruction::OpenPosition {
            side: 1,
            margin: 500,
            leverage: 2,
        },
        vec![],
    );
    assert!(env.send(&[ixn], &alice, &[]).is_err());
}

#[test]
fn trading_is_closed_before_the_countdown_ends_and_after_the_window() {
    let mut env = ready();
    env.start_in_rollup();
    let starts = env.duel().starts_at;
    env.set_time(starts - 1);
    env.price(100.0);
    assert_eq!(
        custom_code(&env.open(0, 1, 500, 2).unwrap_err()),
        dcode(trading_duel::DuelError::TradingClosed)
    );
    env.set_time(starts);
    env.price(100.0);
    env.open(0, 1, 500, 2).expect("open at the first second");
    let ends = env.duel().ends_at;
    env.set_time(ends + 1);
    env.price(100.0);
    assert_eq!(
        custom_code(&env.open(1, 1, 500, 2).unwrap_err()),
        dcode(trading_duel::DuelError::TradingClosed)
    );
    assert_eq!(
        custom_code(&env.close(0).unwrap_err()),
        dcode(trading_duel::DuelError::TradingClosed)
    );
    assert_eq!(
        custom_code(&env.tick().unwrap_err()),
        dcode(trading_duel::DuelError::TradingClosed)
    );
}

#[test]
fn nothing_trades_before_the_match_starts() {
    let mut env = ready();
    env.price(100.0);
    assert_eq!(
        custom_code(&env.open(0, 1, 500, 2).unwrap_err()),
        dcode(trading_duel::DuelError::NotLive)
    );
}

#[test]
fn stale_future_and_malformed_prices_are_rejected() {
    use trading_duel::DuelError::*;
    let mut env = live();
    let now = env.now;
    let err = |e: &Failed| custom_code(e);
    // exactly at the limit is fine, one second older is not
    env.feed(0, PRICE, now - trading_duel::MAX_STALE_SECS);
    env.tick().expect("at the staleness limit");
    env.feed(0, PRICE, now - trading_duel::MAX_STALE_SECS - 1);
    assert_eq!(err(&env.tick().unwrap_err()), dcode(StalePrice));
    assert_eq!(err(&env.open(0, 1, 500, 2).unwrap_err()), dcode(StalePrice));
    env.feed(0, PRICE, now + trading_duel::MAX_FUTURE_SECS + 1);
    assert_eq!(err(&env.tick().unwrap_err()), dcode(StalePrice));
    env.feed(0, 0, now);
    assert_eq!(err(&env.tick().unwrap_err()), dcode(BadPrice));
    env.feed(0, -5, now);
    assert_eq!(err(&env.tick().unwrap_err()), dcode(BadPrice));
    env.feed_with(0, PRICE, 0, 6, now, trading_duel::PRICE_PROGRAM);
    assert_eq!(err(&env.tick().unwrap_err()), dcode(BadPrice));
    env.feed_with(
        0,
        PRICE,
        PRICE as u64 / 50,
        8,
        now,
        trading_duel::PRICE_PROGRAM,
    );
    assert_eq!(err(&env.tick().unwrap_err()), dcode(BadPrice));
    // a fresh price works again
    env.feed(0, PRICE, now);
    env.tick().expect("fresh");
}

#[test]
fn the_wrong_feed_or_a_lookalike_account_is_rejected() {
    use trading_duel::DuelError::*;
    let mut env = live();
    let now = env.now;
    // an ETH feed passed to a SOL Match
    env.feed(1, PRICE, now);
    let (kp, key) = env.person_of(0);
    let eth = trading_duel::FEEDS[1];
    let wrong = ix(
        trading_duel::ID,
        env.trade_accounts(key, eth),
        trading_duel::instruction::Tick {},
        vec![],
    );
    assert_eq!(
        custom_code(&env.send(&[wrong], &kp, &[]).unwrap_err()),
        dcode(BadPriceFeed)
    );
    // the right address owned by someone else (an attacker-written look-alike)
    let owner = APk::new_unique();
    env.feed_with(0, 1, 0, 8, now, owner);
    assert_eq!(custom_code(&env.tick().unwrap_err()), dcode(BadPriceFeed));
    // an arbitrary account of the right owner is not the feed
    let fake = APk::new_unique();
    env.svm
        .set_account(
            s(fake),
            Account {
                lamports: SOL,
                data: vec![0; 134],
                owner: s(trading_duel::PRICE_PROGRAM),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let ixn = ix(
        trading_duel::ID,
        env.trade_accounts(key, fake),
        trading_duel::instruction::Tick {},
        vec![],
    );
    assert_eq!(
        custom_code(&env.send(&[ixn], &kp, &[]).unwrap_err()),
        dcode(BadPriceFeed)
    );
}

#[test]
fn a_tick_liquidates_a_position_past_maintenance() {
    let mut env = live();
    env.open(0, trading_duel::SIDE_LONG, 1_000, 20).unwrap();
    env.open(1, trading_duel::SIDE_SHORT, 1_000, 20).unwrap();
    env.set_time(env.now + 5);
    env.price(95.4); // -4.6%: seat 0 is below maintenance, seat 1 is in profit
    env.tick().expect("anyone may crank");
    let b0 = env.book(0);
    assert_eq!(b0.side, trading_duel::SIDE_FLAT);
    assert_eq!(b0.liquidations, 1);
    assert_eq!(b0.fills[1].kind, trading_duel::FILL_LIQUIDATED);
    assert!(b0.cash < 9_100);
    assert_eq!(env.book(1).side, trading_duel::SIDE_SHORT);
    assert_eq!(env.duel().lead, trading_duel::LEAD_SEAT_1);
}

#[test]
fn closing_after_a_due_liquidation_records_it_instead_of_failing() {
    let mut env = live();
    env.open(0, trading_duel::SIDE_LONG, 1_000, 20).unwrap();
    env.set_time(env.now + 5);
    env.price(90.0);
    env.close(0)
        .expect("the liquidation stands, nothing else to close");
    let b = env.book(0);
    assert_eq!(b.side, trading_duel::SIDE_FLAT);
    assert_eq!(b.liquidations, 1);
    assert_eq!(b.fill_count, 2);
    assert_eq!(b.cash, 9_000);
}

#[test]
fn the_match_cannot_end_early_or_on_a_price_from_before_the_end() {
    use trading_duel::DuelError::*;
    let mut env = live();
    assert_eq!(custom_code(&env.end().unwrap_err()), dcode(NotEnded));
    let ends = env.duel().ends_at;
    env.set_time(ends);
    env.feed(0, PRICE, ends - 1);
    assert_eq!(custom_code(&env.end().unwrap_err()), dcode(NotEnded));
    env.feed(0, PRICE, ends);
    env.end().expect("first price at the end");
    assert_eq!(env.duel().status, trading_duel::STATUS_OVER);
    assert_eq!(custom_code(&env.end().unwrap_err()), dcode(NotLive));
}

#[test]
fn the_higher_final_equity_wins_and_open_positions_are_marked_at_the_final_price() {
    let mut env = live();
    env.open(0, trading_duel::SIDE_LONG, 2_000, 5).unwrap();
    env.open(1, trading_duel::SIDE_SHORT, 2_000, 5).unwrap();
    env.finish_at(104.0).expect("end");
    let d = env.duel();
    assert_eq!(d.status, trading_duel::STATUS_OVER);
    assert_eq!(d.winner, 0);
    assert!(d.final_equity[0] > 10_000 && d.final_equity[1] < 10_000);
    assert_eq!(d.final_price, 104_00000000);
    for seat in 0..2 {
        let b = env.book(seat);
        assert_eq!(b.side, trading_duel::SIDE_FLAT);
        assert_eq!(b.fills[1].kind, trading_duel::FILL_FINAL);
        assert_eq!(b.cash, d.final_equity[seat]);
    }
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize(false).expect("settle");
    // the entries are already out of both balances: the winner gets the 2,000 Pot minus 5% fees
    assert_eq!(env.gemas(&env.alice), before.0 + 1_900);
    assert_eq!(env.gemas(&env.bob), before.1);
    assert_eq!(env.tesoro_status(), MatchStatus::Settled);
    assert!(env.duel().finalized);
}

#[test]
fn the_second_seat_can_win() {
    let mut env = live();
    env.open(0, trading_duel::SIDE_LONG, 1_000, 10).unwrap();
    env.open(1, trading_duel::SIDE_SHORT, 1_000, 10).unwrap();
    env.finish_at(97.0).expect("end");
    assert_eq!(env.duel().winner, 1);
    let before = env.gemas(&env.bob);
    env.finalize(false).expect("settle");
    assert_eq!(env.gemas(&env.bob), before + 1_900);
}

#[test]
fn neither_trading_is_a_draw_and_refunds_both_entries() {
    let mut env = live();
    env.finish_at(100.0).expect("end");
    let d = env.duel();
    assert_eq!(d.winner, trading_duel::DRAW);
    assert_eq!(d.final_equity, [10_000, 10_000]);
    let before = (env.gemas(&env.alice), env.gemas(&env.bob));
    env.finalize(true).expect("refund");
    assert_eq!(env.tesoro_status(), MatchStatus::Refunded);
    assert_eq!(
        (env.gemas(&env.alice), env.gemas(&env.bob)),
        (before.0 + 1_000, before.1 + 1_000)
    );
}

#[test]
fn identical_trades_draw_at_a_flat_price_only_when_equity_is_exactly_equal() {
    let mut env = live();
    env.open(0, trading_duel::SIDE_LONG, 1_000, 5).unwrap();
    env.open(1, trading_duel::SIDE_LONG, 1_000, 5).unwrap();
    env.finish_at(100.0).unwrap();
    assert_eq!(env.duel().winner, trading_duel::DRAW);
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

#[test]
fn the_fill_log_survives_many_trades_in_a_match() {
    let mut env = live();
    for i in 0..40 {
        env.set_time(env.now + 1);
        env.price(100.0);
        let seat = i % 2;
        env.open(seat, 1 + (i % 2) as u8, 100, 2).unwrap();
        env.close(seat).unwrap();
    }
    assert_eq!(env.book(0).fill_count, 40);
    assert_eq!(env.duel().trades, [20, 20]);
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
fn a_prefunded_permission_address_is_not_a_permission() {
    let mut env = ready();
    let ad = addrs(env.id);
    for target in [ad.duel, ad.book_0, ad.book_1] {
        env.svm
            .airdrop(&s(permission_pda(target)), 1_000_000)
            .expect("dust");
    }
    let payer = env.bob.kp.insecure_clone();
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
fn an_on_time_end_uses_a_price_published_inside_the_grace_window() {
    let mut env = live();
    env.open(0, trading_duel::SIDE_LONG, 2_000, 5).unwrap();
    let ends = env.duel().ends_at;
    env.set_time(ends + 2);
    env.feed(0, 104 * PRICE / 100, ends + 1);
    env.end().expect("price published inside the window");
    let d = env.duel();
    assert_eq!(d.final_price, (104 * PRICE / 100) as u64);
    assert_eq!(d.winner, 0);
}

#[test]
fn a_price_after_the_grace_window_is_not_an_end_price() {
    use trading_duel::DuelError::*;
    let mut env = live();
    let ends = env.duel().ends_at;
    env.set_time(ends + 1);
    env.feed(0, PRICE, ends + trading_duel::END_GRACE_SECS + 1);
    assert_eq!(
        custom_code(&env.end().unwrap_err()),
        dcode(EndPriceOutOfWindow)
    );
}

#[test]
fn a_late_end_settles_at_the_last_recorded_mid_whatever_the_feed_says() {
    // Two identical Matches: one ended late while the feed shows a huge rise, one while it shows
    // a crash. Both settle at the last mid recorded during the window.
    let run = |feed_usd: f64| {
        let mut env = live();
        env.open(0, trading_duel::SIDE_LONG, 2_000, 5).unwrap();
        env.open(1, trading_duel::SIDE_SHORT, 2_000, 5).unwrap();
        env.set_time(env.now + 20);
        env.price(101.0);
        env.tick().unwrap();
        assert_eq!(env.duel().final_price, 101_00000000);
        let ends = env.duel().ends_at;
        env.set_time(ends + trading_duel::END_GRACE_SECS + 30);
        env.price(feed_usd);
        env.end().expect("a late call settles");
        let d = env.duel();
        (d.final_price, d.final_equity, d.winner)
    };
    let up = run(150.0);
    let down = run(50.0);
    assert_eq!(up, down, "the late feed price changes nothing");
    assert_eq!(up.0, 101_00000000);
    assert_eq!(up.2, 0, "the long is ahead at the last recorded mid");
}

#[test]
fn a_late_end_needs_no_feed_when_nobody_traded() {
    let mut env = live();
    let ends = env.duel().ends_at;
    env.set_time(ends + 100);
    // a stale feed that would fail an on-time end
    env.feed(0, PRICE, ends - 500);
    env.end().expect("late and flat");
    assert_eq!(env.duel().winner, trading_duel::DRAW);
}

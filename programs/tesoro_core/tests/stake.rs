//! Mainnet SOL Positions on a real staking token (ADR 0011 on the computed model of ADR 0010),
//! against the real SPL stake pool program and the live jitoSOL pool, mint, reserve and fee
//! accounts (read from mainnet 2026-10-15, `tests/fixtures`). `sim_lst` is not loaded: this is the
//! mainnet shape. Most tests set the pool's balances to round figures by rewriting the pool
//! account's data; `opening_with_plain_sol...` runs the live pool untouched.
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{spl_token, ID as TOKEN_PROGRAM_ID};
use litesvm::LiteSVM;
use solana_sdk::clock::Clock;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use tesoro_core::ledger::book::checkpoint::MemCheckpoints;
use tesoro_core::ledger::book::fp_ceil;
use tesoro_core::ledger::line_store::{CLASS_GENERAL, SIDE_OWN, SIDE_WON};
use tesoro_core::ledger::{self, PositionStatus, ShareRate};
use tesoro_core::stake::{stake_position_id, STAKE_POOL_PROGRAMS};
use tesoro_core::state::*;
use tesoro_core::storage::*;
use tesoro_core::{accounts, instruction, LineRef};

mod common;
use common::econ::{self, book_metas, find_line, gemas_in, read_book};

const SOL: u64 = 1_000_000_000;
const T0: i64 = 1_000_000;
const EPOCH: u64 = 1058;
/// $150 per SOL as a Pyth push feed publishes it (exponent -8).
const FEED_150: i64 = 15_000_000_000;
const PYTH_SOL_USD: [u8; 32] = [0xef; 32];
const MONTH_SECS: i64 = 30 * 24 * 3600;

const YIELD_FEE_BPS: u16 = 2_000;
const INSTANT_FEE_BPS: u16 = 2_500;
/// The ceiling the tests set: 20%.
const CEILING_BPS: u16 = 2_000;

const ERR_BAD_REMAINING: u32 = 6004;
const ERR_NATIVE_POSITION: u32 = 6009;
const ERR_NOT_NATIVE: u32 = 6010;
const ERR_STAKE_INACTIVE: u32 = 6025;
const ERR_CEILING_NOT_SET: u32 = 6026;
const ERR_BAD_POOL: u32 = 6028;
const ERR_UNAUTHORIZED: u32 = 6000;

const JITO_POOL_DATA: &[u8] = include_bytes!("fixtures/jito_pool.bin");
const JITO_MINT_DATA: &[u8] = include_bytes!("fixtures/jito_mint.bin");
const JITO_FEE_DATA: &[u8] = include_bytes!("fixtures/jito_fee.bin");
const JITO_RESERVE_DATA: &[u8] = include_bytes!("fixtures/jito_reserve.bin");
const STAKE_POOL_SO: &[u8] = include_bytes!("fixtures/spl_stake_pool.so");
/// Offsets of the pool fields the tests rewrite (see `ledger::stake_pool`).
const TOTAL_AT: usize = 258;
const SUPPLY_AT: usize = 266;
const EPOCH_AT: usize = 274;
const LAST_SUPPLY_AT: usize = 419;
const LAST_TOTAL_AT: usize = 427;

fn pk(s: &str) -> APk {
    s.parse().unwrap()
}
fn a(p: Pk) -> APk {
    APk::new_from_array(p.to_bytes())
}
fn s(p: APk) -> Pk {
    Pk::new_from_array(p.to_bytes())
}
fn pda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &tesoro_core::ID).0
}
fn core_code(e: ledger::CoreError) -> u32 {
    tesoro_core::error::CORE_ERROR_OFFSET + e.code()
}
fn treasury_account() -> APk {
    pda(&[ACCOUNT_SEED, pda(&[TREASURY_SEED]).as_ref()])
}

type Failed = litesvm::types::FailedTransactionMetadata;

fn code(err: &Failed) -> u32 {
    use solana_sdk::instruction::InstructionError;
    use solana_sdk::transaction::TransactionError;
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => *c,
        other => panic!("unexpected error {other:?}\n{:?}", err.meta.logs),
    }
}

fn tix(
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
        program_id: s(tesoro_core::ID),
        accounts: metas,
        data: data.data(),
    }
}

fn rem(k: APk, writable: bool) -> AccountMeta {
    if writable {
        AccountMeta::new(s(k), false)
    } else {
        AccountMeta::new_readonly(s(k), false)
    }
}

struct Person {
    kp: Keypair,
    key: APk,
    account: APk,
    token: APk,
}

#[derive(Clone, Copy, Debug)]
struct Pos {
    position: APk,
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    oracle: Keypair,
    mint: APk,
    pool: APk,
    next_nonce: u64,
    opened: Vec<APk>,
}

fn pool_data(total: u64, supply: u64, epoch: u64, last_total: u64, last_supply: u64) -> Vec<u8> {
    let mut d = JITO_POOL_DATA.to_vec();
    d[TOTAL_AT..TOTAL_AT + 8].copy_from_slice(&total.to_le_bytes());
    d[SUPPLY_AT..SUPPLY_AT + 8].copy_from_slice(&supply.to_le_bytes());
    d[EPOCH_AT..EPOCH_AT + 8].copy_from_slice(&epoch.to_le_bytes());
    d[LAST_SUPPLY_AT..LAST_SUPPLY_AT + 8].copy_from_slice(&last_supply.to_le_bytes());
    d[LAST_TOTAL_AT..LAST_TOTAL_AT + 8].copy_from_slice(&last_total.to_le_bytes());
    d
}

/// A round pool: 1.30 SOL per token, and the last epoch's balances 0.04% lower (about 6.5% a
/// year at the program's assumed epoch length).
fn round_pool() -> Vec<u8> {
    pool_data(
        1_300_000_000_000,
        1_000_000_000_000,
        EPOCH,
        1_299_480_000_000,
        1_000_000_000_000,
    )
}

fn account(owner: APk, data: Vec<u8>) -> solana_sdk::account::Account {
    solana_sdk::account::Account {
        lamports: 10_000_000_000,
        data,
        owner: s(owner),
        executable: false,
        rent_epoch: 0,
    }
}

fn pyth_image(feed_id: [u8; 32], price: i64, conf: u64, published: i64) -> Vec<u8> {
    let mut d = vec![0u8; tesoro_core::pyth::PRICE_UPDATE_V2_LEN];
    d[0..8].copy_from_slice(&tesoro_core::pyth::PRICE_UPDATE_V2);
    d[40] = 1;
    d[41..73].copy_from_slice(&feed_id);
    d[73..81].copy_from_slice(&price.to_le_bytes());
    d[81..89].copy_from_slice(&conf.to_le_bytes());
    d[89..93].copy_from_slice(&(-8i32).to_le_bytes());
    d[93..101].copy_from_slice(&published.to_le_bytes());
    d
}

fn token_account_data(mint: APk, owner: APk, amount: u64) -> Vec<u8> {
    let mut data = vec![0u8; spl_token::state::Account::LEN];
    spl_token::state::Account {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: spl_token::state::AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    }
    .pack_into_slice(&mut data);
    data
}

impl Env {
    fn new() -> Self {
        Self::with_pool(round_pool())
    }

    fn with_pool(pool_bytes: Vec<u8>) -> Self {
        let mut svm = LiteSVM::new();
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/");
        svm.add_program_from_file(s(tesoro_core::ID), format!("{dir}tesoro_core.so"))
            .expect("run `pnpm build:programs` first");
        svm.add_program(s(STAKE_POOL_PROGRAMS[0]), STAKE_POOL_SO)
            .expect("stake pool program");
        let pool = pk("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb");
        let mint = pk("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
        let stake_program = STAKE_POOL_PROGRAMS[0];
        svm.set_account(s(pool), account(stake_program, pool_bytes))
            .unwrap();
        svm.set_account(s(mint), account(TOKEN_PROGRAM_ID, JITO_MINT_DATA.to_vec()))
            .unwrap();
        svm.set_account(
            s(pk("8yoigZfzZ1nNaadumY9uPVD118225UYHTDpmjpr2nrSa")),
            account(TOKEN_PROGRAM_ID, JITO_FEE_DATA.to_vec()),
        )
        .unwrap();
        svm.set_account(
            s(pk("BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL")),
            account(
                pk("Stake11111111111111111111111111111111111111"),
                JITO_RESERVE_DATA.to_vec(),
            ),
        )
        .unwrap();
        svm.set_sysvar(&Clock {
            unix_timestamp: T0,
            epoch: EPOCH,
            ..Clock::default()
        });
        let admin = Keypair::new();
        let oracle = Keypair::new();
        for k in [&admin, &oracle] {
            svm.airdrop(&k.pubkey(), 1_000 * SOL).expect("airdrop");
        }
        let mut env = Self {
            svm,
            admin,
            oracle,
            mint,
            pool,
            next_nonce: 1,
            opened: vec![],
        };
        let admin = env.admin.insecure_clone();
        let platform = env.person();
        let init = tix(
            accounts::InitializeConfig {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                platform_recipient: platform.account,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitializeConfig {
                oracle_authority: a(env.oracle.pubkey()),
                platform_bps: 200,
            },
            vec![],
        );
        env.send(&[init], &admin, &[]).expect("init config");
        let treasury = tix(
            accounts::InitTreasuryStake {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                treasury: pda(&[TREASURY_SEED]),
                treasury_account: treasury_account(),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitTreasuryStake {
                yield_fee_bps: YIELD_FEE_BPS,
                instant_fee_bps: INSTANT_FEE_BPS,
            },
            vec![],
        );
        env.send(&[treasury], &admin, &[]).expect("init treasury");
        env.set_stake_token(a(admin.pubkey()), env.mint, env.pool)
            .expect("set token");
        env.set_ceiling(CEILING_BPS).expect("ceiling");
        env.map_price();
        env.init_economy();
        env
    }

    /// The economy settings and the Treasury Account's basket and spill.
    fn init_economy(&mut self) {
        let admin = self.admin.insecure_clone();
        let set = tix(
            accounts::SetEconomy {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetEconomy {
                season_keeper: APk::default(),
                fill_keeper: APk::default(),
                keeper_fills: false,
                routes: [
                    self.custody_address(),
                    APk::default(),
                    APk::default(),
                    APk::default(),
                ],
            },
            vec![],
        );
        self.send(&[set], &admin, &[]).expect("set economy");
        let stores = tix(
            accounts::InitStores {
                payer: a(admin.pubkey()),
                account: treasury_account(),
                basket: basket_address(&treasury_account()).0,
                spill: spill_address(&treasury_account()).0,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitStores {},
            vec![],
        );
        self.send(&[stores], &admin, &[]).expect("treasury stores");
    }

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
        self.svm.send_transaction(tx).map(|_| ())
    }

    fn load<T: AccountDeserialize>(&self, k: APk) -> T {
        let acct = self.svm.get_account(&s(k)).expect("account exists");
        T::try_deserialize(&mut acct.data.as_slice()).expect("deserialize")
    }

    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }
    fn set_clock(&mut self, t: i64, epoch: u64) {
        self.svm.set_sysvar(&Clock {
            unix_timestamp: t,
            epoch,
            ..Clock::default()
        });
    }
    fn advance(&mut self, secs: i64) {
        let epoch = self.svm.get_sysvar::<Clock>().epoch;
        let t = self.now() + secs;
        self.set_clock(t, epoch);
    }

    fn token_balance(&self, k: APk) -> u64 {
        self.svm
            .get_account(&s(k))
            .map(|acc| {
                spl_token::state::Account::unpack(&acc.data)
                    .expect("token")
                    .amount
            })
            .unwrap_or(0)
    }

    fn person(&mut self) -> Person {
        let kp = Keypair::new();
        self.svm
            .airdrop(&kp.pubkey(), 1_000 * SOL)
            .expect("airdrop");
        let key = a(kp.pubkey());
        let account = pda(&[ACCOUNT_SEED, key.as_ref()]);
        let create = tix(
            accounts::CreateAccount {
                authority: key,
                account,
                basket: tesoro_core::storage::basket_address(&account).0,
                spill: tesoro_core::storage::spill_address(&account).0,
                invite_gate: invite_gate_pda(),
                system_program: anchor_lang::system_program::ID,
                payer: key,
                sponsor: None,
            },
            instruction::CreateAccount {
                evm_address: [0; 20],
            },
            vec![],
        );
        self.send(&[create], &kp, &[]).expect("create account");
        let token = get_associated_token_address(&key, &self.mint);
        Person {
            kp,
            key,
            account,
            token,
        }
    }

    /// A person with `tokens` of the staking token.
    fn holder(&mut self, tokens: u64) -> Person {
        let p = self.person();
        self.set_tokens(&p, tokens);
        p
    }

    fn set_tokens(&mut self, p: &Person, amount: u64) {
        self.svm
            .set_account(
                s(p.token),
                account(
                    TOKEN_PROGRAM_ID,
                    token_account_data(self.mint, p.key, amount),
                ),
            )
            .unwrap();
    }

    fn set_pool(&mut self, bytes: Vec<u8>) {
        self.svm
            .set_account(s(self.pool), account(STAKE_POOL_PROGRAMS[0], bytes))
            .unwrap();
    }

    /// The round pool with its total lamports (and so its rate) changed.
    fn set_total(&mut self, total: u64) {
        self.set_pool(pool_data(
            total,
            1_000_000_000_000,
            EPOCH,
            1_299_480_000_000,
            1_000_000_000_000,
        ));
    }

    fn rate(&self) -> u64 {
        let acct = self.svm.get_account(&s(self.pool)).unwrap();
        ledger::parse_stake_pool(&acct.data)
            .unwrap()
            .rate()
            .unwrap()
    }

    // --- settings ---------------------------------------------------------------------------

    fn set_stake_token(&mut self, admin: APk, mint: APk, pool: APk) -> Result<(), Failed> {
        let kp = if admin == a(self.admin.pubkey()) {
            self.admin.insecure_clone()
        } else {
            Keypair::new()
        };
        let set = tix(
            accounts::SetStakeToken {
                admin,
                config: pda(&[CONFIG_SEED]),
                stake_config: pda(&[STAKE_CONFIG_SEED]),
                mint,
                stake_pool: pool,
                custody: pda(&[STAKE_CUSTODY_SEED, mint.as_ref()]),
                vault: pda(&[STAKE_VAULT_SEED, mint.as_ref()]),
                token_program: TOKEN_PROGRAM_ID,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetStakeToken {},
            vec![],
        );
        self.send(&[set], &kp, &[])
    }

    fn set_ceiling(&mut self, bps: u16) -> Result<(), Failed> {
        let admin = self.admin.insecure_clone();
        let set = tix(
            accounts::SetStakeApyCeiling {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                stake_config: pda(&[STAKE_CONFIG_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetStakeApyCeiling {
                apy_ceiling_bps: bps,
            },
            vec![],
        );
        self.send(&[set], &admin, &[])
    }

    fn feed(&self) -> APk {
        pk("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE")
    }

    /// A fresh $150 SOL/USD feed, mapped to the staking token.
    fn map_price(&mut self) {
        let now = self.now();
        self.put_feed(FEED_150, 5_000_000, now);
        let admin = self.admin.insecure_clone();
        let set = tix(
            accounts::SetOnchainPrice {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                onchain_price: pda(&[ONCHAIN_PRICE_SEED, self.mint.as_ref()]),
                feed: self.feed(),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetOnchainPrice {
                asset: self.mint,
                feed_id: PYTH_SOL_USD,
                max_age_secs: 90,
                max_conf_bps: 100,
            },
            vec![],
        );
        self.send(&[set], &admin, &[]).expect("map price");
    }

    fn put_feed(&mut self, price: i64, conf: u64, published: i64) {
        self.svm
            .set_account(
                s(self.feed()),
                account(
                    tesoro_core::pyth::PYTH_RECEIVER,
                    pyth_image(PYTH_SOL_USD, price, conf, published),
                ),
            )
            .unwrap();
    }

    fn refresh_feed(&mut self) {
        let now = self.now();
        self.put_feed(FEED_150, 5_000_000, now);
    }

    // --- positions --------------------------------------------------------------------------

    fn custody_address(&self) -> APk {
        pda(&[STAKE_CUSTODY_SEED, self.mint.as_ref()])
    }
    fn vault(&self) -> APk {
        pda(&[STAKE_VAULT_SEED, self.mint.as_ref()])
    }
    fn custody(&self) -> StakeCustody {
        self.load::<StakeCustody>(self.custody_address())
    }

    fn open_ix(&self, p: &Person, nonce: u64, shares: u64) -> (Instruction, Pos) {
        let position = pda(&[POSITION_SEED, &[0], &stake_position_id(&p.key, nonce)]);
        let open = tix(
            accounts::OpenStakePosition {
                owner_authority: p.key,
                owner_account: p.account,
                stake_config: pda(&[STAKE_CONFIG_SEED]),
                mint: self.mint,
                custody: self.custody_address(),
                vault: self.vault(),
                owner_token: p.token,
                stake_pool: self.pool,
                treasury: pda(&[TREASURY_SEED]),
                position,
                token_program: TOKEN_PROGRAM_ID,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::OpenStakePosition { nonce, shares },
            vec![],
        );
        (open, Pos { position })
    }

    fn open(&mut self, p: &Person, shares: u64) -> Result<Pos, Failed> {
        let nonce = self.next_nonce;
        self.next_nonce += 1;
        let (open, pos) = self.open_ix(p, nonce, shares);
        self.send(&[open], &p.kp, &[])?;
        self.opened.push(pos.position);
        Ok(pos)
    }

    fn position(&self, pos: Pos) -> ledger::Position {
        self.load::<PositionState>(pos.position).inner
    }
    fn source(&self, pos: Pos, index: u32) -> APk {
        pda(&[SOURCE_SEED, pos.position.as_ref(), &index.to_le_bytes()])
    }
    fn basket(&self, p: &Person) -> APk {
        basket_address(&p.account).0
    }
    fn spill(&self, p: &Person) -> APk {
        spill_address(&p.account).0
    }
    fn gemas(&self, p: &Person, source: APk) -> u64 {
        gemas_in(&self.svm, p.account, source)
    }
    fn stored(&self, source: APk) -> ledger::Source {
        self.load::<SourceState>(source).inner
    }

    /// The line a holder names: the General class of a Source (`side`: 0 own, 1 won).
    fn line(&self, source: APk, side: u8) -> LineRef {
        LineRef {
            side,
            due_at: self.stored(source).due_at,
            class: CLASS_GENERAL,
            tranche: 0,
        }
    }

    fn side_of(&self, p: &Person, source: APk) -> u8 {
        if self.stored(source).owner == p.account.to_bytes() {
            SIDE_OWN
        } else {
            SIDE_WON
        }
    }

    fn mem_pages(&self, source: APk) -> MemCheckpoints {
        let mut m = MemCheckpoints::new(source.to_bytes());
        for class in 0..15u8 {
            for page_no in 0..4u32 {
                let k = ckpt_address(&source, class, page_no).0;
                if let Some(acc) = self.svm.get_account(&s(k)) {
                    m.pages
                        .insert((class, page_no), acc.data[CKPT_PAGE_AT..].to_vec());
                }
            }
        }
        m
    }

    /// The Source's book as an instruction would leave it after syncing now.
    fn synced(&self, source: APk) -> (ledger::book::SourceBook, ledger::Position, MemCheckpoints) {
        let stored = self.stored(source);
        let mut position = self
            .load::<PositionState>(APk::new_from_array(stored.position))
            .inner;
        let net = ledger::stake_position_accrued(&position, self.rate()).unwrap();
        let rate = ShareRate::stake(self.rate()).unwrap();
        let mut book = read_book(&self.svm, source);
        let mut ck = self.mem_pages(source);
        ledger::economy::sync_source(&mut position, &stored, &mut book, net, &rate, &mut ck)
            .unwrap();
        (book, position, ck)
    }
    fn debt(&self, source: APk) -> u64 {
        fp_ceil(self.synced(source).0.uncovered_total()) as u64
    }
    /// What the holder's General line of the Source can Redeem now.
    fn redeemable(&self, p: &Person, source: APk) -> u64 {
        let side = self.side_of(p, source);
        let (book, _, ck) = self.synced(source);
        let Some(line) = find_line(&self.svm, p.account, source, side, CLASS_GENERAL, 0) else {
            return 0;
        };
        book.redeemable(&book.peek(&line, &ck).unwrap()).unwrap()
    }

    /// `[prev_source, its book and pages]` when the Position still has an Advance open.
    fn prev_tail(&self, pos: Pos) -> Vec<AccountMeta> {
        match self.position(pos).open_advance {
            Some(index) => {
                let prev = self.source(pos, index);
                let mut v = vec![rem(prev, false)];
                v.extend(book_metas(&self.svm, prev));
                v
            }
            None => vec![],
        }
    }

    fn advance_ix(&self, p: &Person, pos: Pos, months: u8) -> (Instruction, APk) {
        let position = self.position(pos);
        let source = self.source(pos, position.advances);
        let advance = tix(
            accounts::TakeStakeAdvance {
                owner_authority: p.key,
                owner_account: p.account,
                protections: pda(&[PROTECTIONS_SEED, p.account.as_ref()]),
                position: pos.position,
                onchain_price: pda(&[ONCHAIN_PRICE_SEED, self.mint.as_ref()]),
                price_feed: self.feed(),
                stake_config: pda(&[STAKE_CONFIG_SEED]),
                custody: self.custody_address(),
                stake_pool: self.pool,
                source,
                book: book_address(&source).0,
                basket: self.basket(p),
                spill: self.spill(p),
                economy: pda(&[ECONOMY_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::TakeStakeAdvance {
                horizon_months: months,
                min_gemas: 1,
            },
            self.prev_tail(pos),
        );
        (advance, source)
    }

    fn advance_stake(&mut self, p: &Person, pos: Pos, months: u8) -> Result<APk, Failed> {
        self.refresh_feed();
        let (advance, source) = self.advance_ix(p, pos, months);
        self.send(&[advance], &p.kp, &[])?;
        self.ensure_pages(source);
        Ok(source)
    }

    /// Creates page 0 of every class of the Source that writes checkpoint records.
    fn ensure_pages(&mut self, source: APk) {
        let n_ext = read_book(&self.svm, source).n_ext;
        let payer = Keypair::new();
        self.svm.airdrop(&payer.pubkey(), SOL).unwrap();
        for class in std::iter::once(1u8).chain(3..4 + n_ext) {
            let page = ckpt_address(&source, class, 0).0;
            if self.svm.get_account(&s(page)).is_some() {
                continue;
            }
            let init = tix(
                accounts::InitCkptPage {
                    payer: a(payer.pubkey()),
                    book: book_address(&source).0,
                    page,
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::InitCkptPage { class, page_no: 0 },
                vec![],
            );
            self.send(&[init], &payer, &[]).expect("checkpoint page");
        }
    }

    fn extend_stake(
        &mut self,
        p: &Person,
        pos: Pos,
        source: APk,
        extra_months: u8,
    ) -> Result<(), Failed> {
        let extend = tix(
            accounts::ExtendStakeAdvance {
                owner_authority: p.key,
                owner_account: p.account,
                protections: pda(&[PROTECTIONS_SEED, p.account.as_ref()]),
                position: pos.position,
                stake_config: pda(&[STAKE_CONFIG_SEED]),
                custody: self.custody_address(),
                stake_pool: self.pool,
                source,
                basket: self.basket(p),
                spill: self.spill(p),
                extend_limit: pda(&[EXTEND_LIMIT_SEED, p.account.as_ref()]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::ExtendStakeAdvance {
                extra_months,
                min_gemas: 1,
            },
            book_metas(&self.svm, source),
        );
        self.send(&[extend], &p.kp, &[])?;
        self.ensure_pages(source);
        Ok(())
    }

    fn pool_tail(&self) -> Vec<AccountMeta> {
        vec![rem(self.custody_address(), true), rem(self.pool, false)]
    }

    /// The kind accounts of a paying instruction: `[custody, stake_pool, vault, destination,
    /// token_program]`.
    fn kind_paying(&self, dest: APk) -> Vec<AccountMeta> {
        let mut v = self.pool_tail();
        v.extend([
            rem(self.vault(), true),
            rem(dest, true),
            rem(TOKEN_PROGRAM_ID, false),
        ]);
        v
    }

    fn redeem_line_ix(
        &self,
        p: &Person,
        pos: Pos,
        source: APk,
        line: LineRef,
        amount: u64,
    ) -> Instruction {
        let mut remaining = self.kind_paying(p.token);
        remaining.extend(book_metas(&self.svm, source));
        tix(
            accounts::Redeem {
                holder_authority: p.key,
                holder_account: p.account,
                basket: self.basket(p),
                spill: self.spill(p),
                position: pos.position,
                source,
            },
            instruction::Redeem { line, amount },
            remaining,
        )
    }

    fn redeem_ix(&self, p: &Person, pos: Pos, source: APk, amount: u64) -> Instruction {
        self.redeem_line_ix(
            p,
            pos,
            source,
            self.line(source, self.side_of(p, source)),
            amount,
        )
    }

    fn redeem(&mut self, p: &Person, pos: Pos, source: APk, amount: u64) -> Result<(), Failed> {
        let ix = self.redeem_ix(p, pos, source, amount);
        self.send(&[ix], &p.kp, &[])
    }

    fn unlock_ix(&self, p: &Person, pos: Pos) -> Instruction {
        let mut remaining = self.kind_paying(p.token);
        if let Some(index) = self.position(pos).open_advance {
            let source = self.source(pos, index);
            remaining.push(rem(source, false));
            remaining.extend(book_metas(&self.svm, source));
        }
        tix(
            accounts::Unlock {
                owner_authority: p.key,
                owner_account: p.account,
                economy: pda(&[ECONOMY_SEED]),
                position: pos.position,
            },
            instruction::Unlock {},
            remaining,
        )
    }

    fn unlock(&mut self, p: &Person, pos: Pos) -> Result<(), Failed> {
        let ix = self.unlock_ix(p, pos);
        self.send(&[ix], &p.kp, &[])
    }

    fn return_own(&mut self, p: &Person, pos: Pos, source: APk, amount: u64) -> Result<(), Failed> {
        let mut remaining = self.pool_tail();
        remaining.extend(book_metas(&self.svm, source));
        let ret = tix(
            accounts::ReturnOwn {
                owner_authority: p.key,
                owner_account: p.account,
                basket: self.basket(p),
                spill: self.spill(p),
                position: pos.position,
                source,
            },
            instruction::ReturnOwn {
                line: self.line(source, SIDE_OWN),
                amount,
            },
            remaining,
        );
        self.send(&[ret], &p.kp, &[])
    }

    /// What a won Match does to the baskets (see `common::econ::win`).
    fn give_won(&mut self, from: &Person, to: &Person, source: APk, n: u64) {
        econ::win(
            &mut self.svm,
            source,
            from.account,
            to.account,
            CLASS_GENERAL,
            0,
            n,
        );
    }

    /// The vault holds exactly the open Positions' custody, the Treasury's shares and the escrow.
    fn check_vault(&self) {
        let c = self.custody();
        let open: u64 = self
            .opened
            .iter()
            .map(|p| self.load::<PositionState>(*p).inner)
            .filter(|p| p.status == PositionStatus::Locked)
            .map(|p| p.custody_shares - p.paid_shares)
            .sum();
        let vault = self.token_balance(self.vault()) as u128;
        let want = open as u128 + c.route.treasury_shares + c.route.escrow_total();
        assert_eq!(
            vault, want,
            "vault {vault} != custody {open} + route {:?}",
            c.route
        );
        c.route.check(&[]).expect("route claims fit the Treasury");
    }

    fn route(&self) -> ledger::RouteLedger {
        self.custody().route
    }

    /// The Treasury's spendable shares: what it may withdraw or spend on a fill.
    fn spendable(&self) -> u64 {
        self.route().spendable() as u64
    }

    fn treasury_gemas(&self, source: APk) -> u64 {
        gemas_in(&self.svm, treasury_account(), source)
    }

    /// The Platform recipient as a Person (its token account created empty).
    fn platform_person(&mut self) -> Person {
        let config = self.load::<Config>(pda(&[CONFIG_SEED]));
        let account = config.platform_recipient;
        let key = self.load::<TesoroAccount>(account).authority;
        let p = Person {
            kp: Keypair::new(),
            key,
            account,
            token: get_associated_token_address(&key, &self.mint),
        };
        self.set_tokens(&p, 0);
        p
    }

    fn set_studio(&mut self, recipient: APk) -> Result<(), Failed> {
        let admin = self.admin.insecure_clone();
        let set = tix(
            accounts::SetTesoroStudio {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                recipient_account: recipient,
            },
            instruction::SetTesoroStudio {},
            vec![],
        );
        self.send(&[set], &admin, &[])
    }

    fn cash_in_ix(&self, pos: Pos, source: APk, class: u8, to: &Person) -> Instruction {
        let mut remaining = self.kind_paying(to.token);
        remaining.extend(book_metas(&self.svm, source));
        tix(
            accounts::CashInFee {
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                recipient_account: to.account,
                position: pos.position,
                source,
            },
            instruction::CashInFee { class },
            remaining,
        )
    }

    fn cash_in(
        &mut self,
        payer: &Keypair,
        pos: Pos,
        source: APk,
        class: u8,
        to: &Person,
    ) -> Result<(), Failed> {
        let ix = self.cash_in_ix(pos, source, class, to);
        self.send(&[ix], payer, &[])
    }

    /// What a fee counter can cash in now, in Gemas, and the shares that pays.
    fn covered_fee(&self, source: APk, class: u8) -> (u64, u64) {
        let (book, _, ck) = self.synced(source);
        let Some(counter) = econ::counter(&self.svm, source, class) else {
            return (0, 0);
        };
        let k = book.redeemable(&book.peek(&counter, &ck).unwrap()).unwrap();
        let shares = book.redeem_shares_of(&counter, k, &ck).unwrap();
        (k, shares as u64)
    }

    fn fund_treasury(&mut self, tokens: u64) {
        let admin = self.admin.insecure_clone();
        let admin_token = get_associated_token_address(&a(admin.pubkey()), &self.mint);
        self.svm
            .set_account(
                s(admin_token),
                account(
                    TOKEN_PROGRAM_ID,
                    token_account_data(self.mint, a(admin.pubkey()), tokens),
                ),
            )
            .unwrap();
        let fund = tix(
            accounts::FundTreasuryStake {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                custody: self.custody_address(),
                vault: self.vault(),
                admin_token,
                token_program: TOKEN_PROGRAM_ID,
            },
            instruction::FundTreasuryStake { shares: tokens },
            vec![],
        );
        self.send(&[fund], &admin, &[]).expect("fund treasury");
    }

    fn order_address(&self, p: &Person, nonce: u64) -> APk {
        pda(&[INSTANT_ORDER_SEED, p.account.as_ref(), &nonce.to_le_bytes()])
    }

    fn request_ix(&self, p: &Person, pos: Pos, source: APk, sell: u64, nonce: u64) -> Instruction {
        let mut remaining = self.kind_paying(p.token);
        remaining.extend(book_metas(&self.svm, source));
        tix(
            accounts::RequestInstantRedeem {
                payer: p.key,
                holder_authority: p.key,
                holder_account: p.account,
                basket: self.basket(p),
                spill: self.spill(p),
                position: pos.position,
                source,
                order: self.order_address(p, nonce),
                sponsor: None,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::RequestInstantRedeem {
                line: self.line(source, SIDE_WON),
                sell,
                ttl_secs: 7 * 24 * 3600,
                nonce,
            },
            remaining,
        )
    }

    fn request(
        &mut self,
        p: &Person,
        pos: Pos,
        source: APk,
        sell: u64,
        nonce: u64,
    ) -> Result<(), Failed> {
        let ix = self.request_ix(p, pos, source, sell, nonce);
        self.send(&[ix], &p.kp, &[])
    }

    fn fill_ix(
        &self,
        signer: APk,
        seller: &Person,
        pos: Pos,
        source: APk,
        nonce: u64,
        gemas: u64,
    ) -> Instruction {
        let mut remaining = self.kind_paying(seller.token);
        remaining.extend(book_metas(&self.svm, source));
        tix(
            accounts::FillInstantRedeem {
                filler: signer,
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                treasury: pda(&[TREASURY_SEED]),
                treasury_account: treasury_account(),
                treasury_basket: basket_address(&treasury_account()).0,
                treasury_spill: spill_address(&treasury_account()).0,
                order: self.order_address(seller, nonce),
                owner_wallet: seller.key,
                sponsor: None,
                position: pos.position,
                source,
            },
            instruction::FillInstantRedeem { gemas },
            remaining,
        )
    }

    fn fill(
        &mut self,
        seller: &Person,
        pos: Pos,
        source: APk,
        nonce: u64,
        gemas: u64,
    ) -> Result<(), Failed> {
        let admin = self.admin.insecure_clone();
        let ix = self.fill_ix(a(admin.pubkey()), seller, pos, source, nonce, gemas);
        self.send(&[ix], &admin, &[])
    }

    fn return_order_ix(
        &self,
        signer: &Person,
        seller: &Person,
        source: APk,
        nonce: u64,
        expire: bool,
    ) -> Instruction {
        let accounts = accounts::ReturnInstantRedeem {
            signer: signer.key,
            owner_account: seller.account,
            basket: self.basket(seller),
            spill: self.spill(seller),
            order: self.order_address(seller, nonce),
            owner_wallet: seller.key,
            sponsor: None,
        };
        let remaining = book_metas(&self.svm, source);
        if expire {
            tix(accounts, instruction::ExpireInstantRedeem {}, remaining)
        } else {
            tix(accounts, instruction::CancelInstantRedeem {}, remaining)
        }
    }

    /// The Treasury redeems what it bought: stake shares stay in the custody vault.
    fn redeem_treasury(
        &mut self,
        payer: &Keypair,
        pos: Pos,
        source: APk,
        amount: u64,
    ) -> Result<(), Failed> {
        let line = LineRef {
            side: SIDE_WON,
            due_at: self.stored(source).due_at,
            class: CLASS_GENERAL,
            tranche: 0,
        };
        let mut remaining = self.pool_tail();
        remaining.extend(book_metas(&self.svm, source));
        let redeem = tix(
            accounts::RedeemTreasury {
                treasury: pda(&[TREASURY_SEED]),
                treasury_account: treasury_account(),
                basket: basket_address(&treasury_account()).0,
                spill: spill_address(&treasury_account()).0,
                position: pos.position,
                source,
            },
            instruction::RedeemTreasury { line, amount },
            remaining,
        );
        self.send(&[redeem], payer, &[])
    }

    fn set_company(&mut self, company: APk) {
        let admin = self.admin.insecure_clone();
        let set = tix(
            accounts::SetTreasuryCompany {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                treasury: pda(&[TREASURY_SEED]),
            },
            instruction::SetTreasuryCompany { company },
            vec![],
        );
        self.send(&[set], &admin, &[]).expect("company");
    }

    fn withdraw(&mut self, company_token: APk, amount: u64) -> Result<(), Failed> {
        let admin = self.admin.insecure_clone();
        let ix = tix(
            accounts::WithdrawTreasuryStake {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                treasury: pda(&[TREASURY_SEED]),
                custody: self.custody_address(),
                vault: self.vault(),
                company_token,
                stake_pool: self.pool,
                token_program: TOKEN_PROGRAM_ID,
            },
            instruction::WithdrawTreasuryStake { amount },
            vec![],
        );
        self.send(&[ix], &admin, &[])
    }

    fn write<T: anchor_lang::AccountSerialize>(&mut self, k: APk, v: &T, len: usize) {
        let mut buf = Vec::new();
        v.try_serialize(&mut buf).expect("serialize");
        buf.resize(len, 0);
        let mut acct = self.svm.get_account(&s(k)).unwrap_or_default();
        acct.owner = s(tesoro_core::ID);
        acct.lamports = acct.lamports.max(SOL / 100);
        acct.data = buf;
        self.svm.set_account(s(k), acct).expect("set account");
    }
}

fn invite_gate_pda() -> APk {
    tesoro_core::state::invite_gate_pda()
}

/// Gemas an Advance of `months` is worth on `principal` lamports at `apy_bps`, $150 SOL and the
/// 20% Yield Fee, as `Position::open_advance` floors it.
/// Gemas of an Advance: the whole projected yield (ticket 31), at $150.
fn gemas_for(principal: u64, apy_bps: u64, months: u64) -> u64 {
    let units = principal as u128 * apy_bps as u128 * months as u128 / (10_000u128 * 12);
    (units * 150_000_000 / 10u128.pow(13)) as u64
}

fn tokens_for(units: u64, rate: u64) -> u64 {
    ledger::tokens_for_units(units, rate).unwrap()
}

// --- Settings --------------------------------------------------------------------------------

#[test]
fn the_admin_sets_the_active_token_and_its_custody_is_pinned_to_the_pool() {
    let mut env = Env::new();
    let cfg = env.load::<StakeConfig>(pda(&[STAKE_CONFIG_SEED]));
    assert_eq!(cfg.active_mint, env.mint);
    assert_eq!(cfg.apy_ceiling_bps, CEILING_BPS);
    let custody = env.custody();
    assert_eq!((custody.mint, custody.pool), (env.mint, env.pool));
    assert_eq!(custody.vault, env.vault());
    assert_eq!(env.token_balance(env.vault()), 0);

    // Only the admin sets either.
    let mallory = env.person();
    let mut set = tix(
        accounts::SetStakeToken {
            admin: mallory.key,
            config: pda(&[CONFIG_SEED]),
            stake_config: pda(&[STAKE_CONFIG_SEED]),
            mint: env.mint,
            stake_pool: env.pool,
            custody: env.custody_address(),
            vault: env.vault(),
            token_program: TOKEN_PROGRAM_ID,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::SetStakeToken {},
        vec![],
    );
    set.accounts[0].is_signer = true;
    let err = env.send(&[set], &mallory.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_UNAUTHORIZED);

    // A pool of another mint, or owned by another program, or not a pool at all is refused.
    let other_pool = APk::new_unique();
    let mut bytes = round_pool();
    bytes[162] ^= 0xff;
    env.svm
        .set_account(s(other_pool), account(STAKE_POOL_PROGRAMS[0], bytes))
        .unwrap();
    let admin = a(env.admin.pubkey());
    let err = env
        .set_stake_token(admin, env.mint, other_pool)
        .unwrap_err();
    assert_eq!(code(&err), ERR_BAD_POOL);
    let rogue = APk::new_unique();
    env.svm
        .set_account(s(rogue), account(APk::new_unique(), round_pool()))
        .unwrap();
    let err = env.set_stake_token(admin, env.mint, rogue).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_POOL);
    // The same token again must name the same pool.
    let same_data_other_key = APk::new_unique();
    env.svm
        .set_account(
            s(same_data_other_key),
            account(STAKE_POOL_PROGRAMS[0], round_pool()),
        )
        .unwrap();
    let err = env
        .set_stake_token(admin, env.mint, same_data_other_key)
        .unwrap_err();
    assert_eq!(code(&err), ERR_BAD_POOL);
    env.set_stake_token(admin, env.mint, env.pool)
        .expect("re-activating is fine");

    // The ceiling is bounded.
    assert!(env.set_ceiling(0).is_err());
    assert!(env.set_ceiling(ledger::MAX_APY_CEILING_BPS + 1).is_err());
    env.set_ceiling(500).unwrap();
    assert_eq!(
        env.load::<StakeConfig>(pda(&[STAKE_CONFIG_SEED]))
            .apy_ceiling_bps,
        500
    );
}

#[test]
fn every_allowed_stake_pool_program_id_is_a_distinct_known_program() {
    let ids: Vec<String> = STAKE_POOL_PROGRAMS.iter().map(|k| k.to_string()).collect();
    assert_eq!(
        ids,
        [
            "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
            "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY",
            "SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn"
        ]
    );
}

// --- Open ------------------------------------------------------------------------------------

#[test]
fn open_with_the_token_records_the_staking_rate_and_moves_the_shares_to_the_vault() {
    let mut env = Env::new();
    let alice = env.holder(20 * SOL);
    let pos = env.open(&alice, 10 * SOL).expect("open");
    let p = env.position(pos);
    let rate = env.rate();
    assert_eq!(rate, 1_300_000_000_000);
    assert_eq!(p.source_asset, env.mint.to_bytes());
    assert_eq!(p.stake_rate_open, rate);
    assert_eq!(p.custody_shares, 10 * SOL);
    assert_eq!(p.principal, 13 * SOL, "10 tokens at 1.30 are 13 SOL");
    assert_eq!(p.yield_fee_bps, YIELD_FEE_BPS);
    assert_eq!(p.status, PositionStatus::Locked);
    assert_eq!(env.token_balance(env.vault()), 10 * SOL);
    assert_eq!(env.token_balance(alice.token), 10 * SOL);
    let c = env.custody();
    assert_eq!((c.principal, c.open_positions), (13 * SOL as u128, 1));
    // Sized on the pool's last epoch: 0.04% an epoch is 649 bps a year.
    assert_eq!(p.rate_bps, 649);
}

#[test]
fn open_refuses_a_token_that_is_not_active_and_a_pool_that_is_not_the_customs() {
    let mut env = Env::new();
    let alice = env.holder(20 * SOL);

    // A stale pool (two epochs behind the clock) is refused.
    env.set_clock(T0, EPOCH + 2);
    let err = env.open(&alice, SOL).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::StaleStakePool));
    // One epoch behind is accepted: the current epoch's update may not have landed yet.
    env.set_clock(T0, EPOCH + 1);
    env.open(&alice, SOL).expect("one epoch behind is fresh");
    env.set_clock(T0, EPOCH);

    // Another pool account in place of the custody's.
    let fake = APk::new_unique();
    env.svm
        .set_account(s(fake), account(STAKE_POOL_PROGRAMS[0], round_pool()))
        .unwrap();
    let (mut open, _) = env.open_ix(&alice, 90, SOL);
    let pool_at = open
        .accounts
        .iter()
        .position(|m| m.pubkey == s(env.pool))
        .unwrap();
    open.accounts[pool_at].pubkey = s(fake);
    let err = env.send(&[open], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_POOL);

    // Zero shares.
    let err = env.open(&alice, 0).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::ZeroAmount));

    // Switching the setting off the token leaves new opens refused with the old accounts.
    let other_mint = APk::new_unique();
    let mut mint_data = JITO_MINT_DATA.to_vec();
    mint_data[0..4].copy_from_slice(&0u32.to_le_bytes());
    env.svm
        .set_account(s(other_mint), account(TOKEN_PROGRAM_ID, mint_data))
        .unwrap();
    let other_pool = APk::new_unique();
    let mut bytes = round_pool();
    bytes[162..194].copy_from_slice(other_mint.as_ref());
    env.svm
        .set_account(s(other_pool), account(STAKE_POOL_PROGRAMS[1], bytes))
        .unwrap();
    let admin = a(env.admin.pubkey());
    env.set_stake_token(admin, other_mint, other_pool)
        .expect("a second token on a Sanctum-owned pool");
    let err = env.open(&alice, SOL).unwrap_err();
    assert_eq!(code(&err), ERR_STAKE_INACTIVE);
    // The first token's custody is untouched and still serves its Positions.
    assert_eq!(env.custody().open_positions, 1);
}

#[test]
fn opening_with_plain_sol_deposits_into_the_live_pool_and_opens_in_one_transaction() {
    let mut env = Env::with_pool(JITO_POOL_DATA.to_vec());
    let alice = env.person();
    let live_rate = env.rate();
    let pool_total = |env: &Env| {
        ledger::parse_stake_pool(&env.svm.get_account(&s(env.pool)).unwrap().data)
            .unwrap()
            .total_lamports
    };
    let before_total = pool_total(&env);
    let lamports_before = env.svm.get_balance(&s(alice.key)).unwrap();

    // The app's plan: create the token account, DepositSol, then open for the tokens it quoted
    // less 0.5%.
    let view = deposit_view(&env);
    let quote = view.tokens_for(10 * SOL);
    let shares = quote - quote / 200;
    let create_ata = create_ata_ix(alice.key, alice.key, env.mint);
    let deposit = deposit_sol_ix(&env, &alice, 10 * SOL);
    let (open, pos) = env.open_ix(&alice, 1, shares);
    env.send(&[create_ata.clone(), deposit.clone(), open], &alice.kp, &[])
        .expect("deposit and open in one transaction");
    let p = env.position(pos);
    assert_eq!(p.custody_shares, shares);
    assert_eq!(p.stake_rate_open, env.rate(), "rate read after the deposit");
    assert!(p.stake_rate_open.abs_diff(live_rate) < live_rate / 1_000_000);
    // The principal is what the tokens are worth: just under the 10 SOL put in.
    assert!(p.principal <= 10 * SOL && p.principal > 10 * SOL * 99 / 100);
    assert_eq!(env.token_balance(env.vault()), shares);
    // The rest of the minted tokens (the margin) stayed with the Player.
    assert_eq!(env.token_balance(alice.token), quote - shares);
    assert_eq!(pool_total(&env), before_total + 10 * SOL);
    assert!(env.svm.get_balance(&s(alice.key)).unwrap() < lamports_before - 10 * SOL + SOL / 100);

    // Asking to open more tokens than the deposit minted reverts the whole transaction,
    // deposit included.
    let bob = env.person();
    let bob_lamports = env.svm.get_balance(&s(bob.key)).unwrap();
    let total = pool_total(&env);
    let create = create_ata_ix(bob.key, bob.key, env.mint);
    let deposit = deposit_sol_ix(&env, &bob, 10 * SOL);
    let (greedy, _) = env.open_ix(&bob, 1, view.tokens_for(10 * SOL) + 1);
    let err = env
        .send(&[create, deposit, greedy], &bob.kp, &[])
        .unwrap_err();
    assert!(
        !err.meta.logs.is_empty(),
        "the open fails on the missing tokens"
    );
    assert_eq!(pool_total(&env), total, "the deposit was rolled back");
    assert!(
        bob_lamports - env.svm.get_balance(&s(bob.key)).unwrap() <= 10_000,
        "only the transaction fee was spent"
    );
    assert!(env.svm.get_account(&s(bob.token)).is_none());
}

/// The pool's `DepositSol` arithmetic for a quote (no deposit fee on the live pool).
struct DepositView {
    total: u64,
    supply: u64,
}
impl DepositView {
    fn tokens_for(&self, lamports: u64) -> u64 {
        (lamports as u128 * self.supply as u128 / self.total as u128) as u64
    }
}
fn deposit_view(env: &Env) -> DepositView {
    let read = ledger::parse_stake_pool(&env.svm.get_account(&s(env.pool)).unwrap().data).unwrap();
    DepositView {
        total: read.total_lamports,
        supply: read.pool_token_supply,
    }
}

fn create_ata_ix(payer: APk, owner: APk, mint: APk) -> Instruction {
    spl_associated_token_account_ix(payer, owner, mint)
}

fn spl_associated_token_account_ix(payer: APk, owner: APk, mint: APk) -> Instruction {
    let ata = get_associated_token_address(&owner, &mint);
    Instruction {
        program_id: s(anchor_spl::associated_token::ID),
        accounts: vec![
            AccountMeta::new(s(payer), true),
            AccountMeta::new(s(ata), false),
            AccountMeta::new_readonly(s(owner), false),
            AccountMeta::new_readonly(s(mint), false),
            AccountMeta::new_readonly(s(anchor_lang::system_program::ID), false),
            AccountMeta::new_readonly(s(TOKEN_PROGRAM_ID), false),
        ],
        data: vec![1],
    }
}

/// The SPL stake pool's `DepositSol` (instruction 14).
fn deposit_sol_ix(env: &Env, p: &Person, lamports: u64) -> Instruction {
    let program = STAKE_POOL_PROGRAMS[0];
    let withdraw = APk::find_program_address(&[env.pool.as_ref(), b"withdraw"], &program).0;
    let mut data = vec![14u8];
    data.extend(lamports.to_le_bytes());
    let reserve = pk("BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL");
    let fee = pk("8yoigZfzZ1nNaadumY9uPVD118225UYHTDpmjpr2nrSa");
    Instruction {
        program_id: s(program),
        accounts: vec![
            AccountMeta::new(s(env.pool), false),
            AccountMeta::new_readonly(s(withdraw), false),
            AccountMeta::new(s(reserve), false),
            AccountMeta::new(s(p.key), true),
            AccountMeta::new(s(p.token), false),
            AccountMeta::new(s(fee), false),
            AccountMeta::new(s(p.token), false),
            AccountMeta::new(s(env.mint), false),
            AccountMeta::new_readonly(s(anchor_lang::system_program::ID), false),
            AccountMeta::new_readonly(s(TOKEN_PROGRAM_ID), false),
        ],
        data,
    }
}

// --- Growth since open, Advance, Redeem, Unlock ----------------------------------------------

#[test]
fn growth_since_open_is_the_staking_rate_ratio_and_pays_the_token() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_stake(&alice, pos, 1).expect("advance");
    // 13 SOL at 6.49% for a month, all of it (the fee waits for the cash-out), at $150.
    let issued = env.stored(source).issued;
    assert_eq!(issued, gemas_for(13 * SOL, 649, 1));
    assert_eq!(env.debt(source), issued, "nothing has grown yet");

    // The pool's rate rises 1%: 13 SOL grew 0.13 SOL, all of it repaying Debt.
    env.set_total(1_313_000_000_000);
    let accrued = ledger::stake_position_accrued(&env.position(pos), env.rate()).unwrap();
    assert_eq!(accrued, 130_000_000);
    assert!(env.debt(source) < issued);

    // Redeem the Gemas that are covered: the payout is the tokens their yield was worth when it
    // landed, which is the rate of this instant.
    let covered = env.redeemable(&alice, source);
    assert!(covered > 0);
    let before = env.token_balance(alice.token);
    env.redeem(&alice, pos, source, covered).expect("redeem");
    let units = env.stored(source).units_for(covered).unwrap();
    let shares = tokens_for(units, env.rate());
    // The holder gets them less the 20% Yield Fee (ticket 31); the fee stays in the vault as the
    // Treasury's.
    let want = shares * 8_000 / 10_000;
    let got = env.token_balance(alice.token) - before;
    assert!(got.abs_diff(want) <= 2, "got {got} want {want}");
    assert_eq!(env.token_balance(env.vault()), 10 * SOL - got);
    // The Position's custody bookkeeping: every share the Redeem took leaves its custody, the fee
    // part into the Treasury's.
    let paid = env.position(pos).paid_shares;
    assert!(paid.abs_diff(shares) <= 2, "paid {paid} shares {shares}");
    assert_eq!(env.route().treasury_shares, u128::from(paid - got));
}

#[test]
fn anyone_cashes_in_the_covered_platform_and_studio_fees_and_only_those() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let platform = env.platform_person();
    let studio = env.holder(0);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_stake(&alice, pos, 12).unwrap();
    // A settled Match cut 400 Platform and 300 Studio Gemas out of Alice's Advance.
    for (class, k) in [(0u8, 400u64), (1, 300)] {
        econ::fee_cut(
            &mut env.svm,
            source,
            alice.account,
            CLASS_GENERAL,
            0,
            class,
            k,
        );
    }
    let payer = env.holder(0);
    // Nothing is covered yet, and the Studio recipient is not set: nothing can be cashed in.
    let err = env
        .cash_in(&payer.kp, pos, source, 0, &platform)
        .unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::ZeroAmount));
    assert!(env.cash_in(&payer.kp, pos, source, 1, &studio).is_err());
    // Yield lands until the Platform Fee is covered and the Studio Fee only in part.
    let mut total = 1_300_000_000_000u64;
    loop {
        total += 100_000_000;
        env.set_total(total);
        let (p, _) = env.covered_fee(source, 0);
        let (st, _) = env.covered_fee(source, 1);
        if p == 400 && st > 0 {
            assert!(st < 300, "the Studio Fee is partly covered");
            break;
        }
        assert!(total < 1_500_000_000_000, "never reached");
    }
    // The Studio recipient is the admin's setting: unset, nobody is paid.
    let err = env.cash_in(&payer.kp, pos, source, 1, &studio).unwrap_err();
    assert_eq!(code(&err), ERR_UNAUTHORIZED);
    env.set_studio(studio.account).expect("studio recipient");
    // The fee must go to its own recipient, never to the caller's pick.
    let err = env.cash_in(&payer.kp, pos, source, 0, &studio).unwrap_err();
    assert_eq!(code(&err), ERR_UNAUTHORIZED);
    // A class that is not Platform or Studio is refused (Leaderboard has `harvest`).
    assert!(env.cash_in(&payer.kp, pos, source, 2, &platform).is_err());
    assert!(env.cash_in(&payer.kp, pos, source, 3, &platform).is_err());

    let (p_gemas, p_shares) = env.covered_fee(source, 0);
    let (s_gemas, s_shares) = env.covered_fee(source, 1);
    assert_eq!(p_gemas, 400);
    assert!(p_shares > 0 && s_shares > 0);
    env.cash_in(&payer.kp, pos, source, 0, &platform)
        .expect("platform");
    env.cash_in(&payer.kp, pos, source, 1, &studio)
        .expect("studio");
    assert_eq!(env.token_balance(platform.token), p_shares);
    assert_eq!(env.token_balance(studio.token), s_shares);
    let platform_left = econ::counter(&env.svm, source, 0).unwrap();
    let studio_left = econ::counter(&env.svm, source, 1).unwrap();
    assert_eq!(platform_left.amount, 400 - p_gemas);
    assert_eq!(
        studio_left.amount,
        300 - s_gemas,
        "only the covered part left"
    );
    env.check_vault();
    // A second call pays nothing and moves nothing.
    for (class, to) in [(0u8, &platform), (1, &studio)] {
        let before = env.token_balance(to.token);
        assert!(env.cash_in(&payer.kp, pos, source, class, to).is_err());
        assert_eq!(env.token_balance(to.token), before);
    }
    env.check_vault();
    // More yield covers the rest of the Studio Fee, and it is paid then, never twice.
    env.set_total(1_700_000_000_000);
    let (rest, _) = env.covered_fee(source, 1);
    assert_eq!(rest, studio_left.amount);
    env.cash_in(&payer.kp, pos, source, 1, &studio)
        .expect("rest");
    assert_eq!(econ::counter(&env.svm, source, 1).unwrap().amount, 0);
    env.check_vault();
}

#[test]
fn unlock_returns_the_rest_of_the_custody_and_realises_the_fee() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    // No Advance: everything accrued is free yield. Rate +10%.
    env.set_total(1_430_000_000_000);
    let rate = env.rate();
    let accrued = ledger::stake_position_accrued(&env.position(pos), rate).unwrap();
    assert_eq!(accrued, 1_300_000_000);
    env.unlock(&alice, pos).expect("unlock");
    let paid = env.token_balance(alice.token);
    // The free yield pays the Yield Fee as it leaves (ticket 31): 20% of its tokens, one floor.
    let free = tokens_for(accrued, rate);
    let fee_tokens = free - free * 8_000 / 10_000;
    assert_eq!(paid, 10 * SOL - fee_tokens);
    // Principal plus the free yield after the fee, at today's rate, within a token unit.
    let old = ledger::unlock_tokens(13 * SOL, accrued * 8 / 10, 10 * SOL, rate).unwrap();
    assert!(paid.abs_diff(old) <= 1, "{paid} {old}");
    assert!(paid > 9_800_000_000 && paid < 9_850_000_000, "{paid}");
    // What stays in the vault is the Treasury's realised fee (and nothing else).
    let left = env.token_balance(env.vault());
    assert_eq!(left, fee_tokens);
    let c = env.custody();
    assert_eq!((c.open_positions, c.principal), (0, 0));
    assert_eq!(c.route.treasury_shares, fee_tokens as u128);
    assert_eq!(c.route.pool_owed, (fee_tokens / 2) as u128);
    assert_eq!(env.spendable(), fee_tokens - fee_tokens / 2);
    assert_eq!(env.position(pos).status, PositionStatus::Unlocked);
    assert_eq!(env.position(pos).custody_shares, 0);
    // Twice is refused.
    assert!(env.unlock(&alice, pos).is_err());
    env.check_vault();
}

#[test]
fn a_pool_that_lost_value_leaves_the_player_the_shares_and_no_yield() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    env.set_total(1_170_000_000_000);
    env.unlock(&alice, pos).expect("unlock");
    assert_eq!(env.token_balance(alice.token), 10 * SOL);
    assert_eq!(env.token_balance(env.vault()), 0);
    assert_eq!(env.spendable(), 0);
    env.check_vault();
}

#[test]
fn unlock_with_debt_outstanding_is_refused_and_moves_nothing() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    env.advance_stake(&alice, pos, 6).unwrap();
    env.set_total(1_313_000_000_000);
    let err = env.unlock(&alice, pos).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::DebtOutstanding));
    assert_eq!(env.token_balance(env.vault()), 10 * SOL);
    assert_eq!(env.position(pos).status, PositionStatus::Locked);
}

#[test]
fn debt_clears_with_growth_alone_and_a_second_advance_does_not_count_old_yield() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let first = env.advance_stake(&alice, pos, 1).unwrap();
    let owed = env.stored(first).units_to_repay_total().unwrap();
    // Grow the rate until the first Advance is repaid (and then some).
    env.set_total(1_400_000_000_000);
    assert_eq!(env.debt(first), 0);
    let net_before = ledger::stake_position_accrued(&env.position(pos), env.rate()).unwrap();
    assert!(net_before > owed);
    let second = env.advance_stake(&alice, pos, 1).expect("second advance");
    assert_eq!(env.position(pos).open_advance, Some(1));
    assert_eq!(env.position(pos).applied_net, net_before);
    assert_eq!(env.debt(second), env.stored(second).issued);
    // The first Source kept what it needed; the rest is the owner's free yield.
    let b0 = read_book(&env.svm, first);
    assert_eq!(b0.uncovered_total(), 0);
    assert_eq!(
        b0.owner_shares, 0,
        "the pocket was taken when the Advance closed"
    );
    assert!(env.position(pos).free_shares > 0);
    env.check_vault();
}

#[test]
fn return_own_cancels_debt_on_the_computed_model() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_stake(&alice, pos, 3).unwrap();
    let issued = env.gemas(&alice, source);
    env.return_own(&alice, pos, source, issued / 2)
        .expect("return");
    assert_eq!(env.debt(source), issued - issued / 2);
    assert_eq!(env.gemas(&alice, source), issued - issued / 2);
    // Without the custody and pool the call has no rate to compute from.
    let ret = tix(
        accounts::ReturnOwn {
            owner_authority: alice.key,
            owner_account: alice.account,
            basket: env.basket(&alice),
            spill: env.spill(&alice),
            position: pos.position,
            source,
        },
        instruction::ReturnOwn {
            line: env.line(source, SIDE_OWN),
            amount: 1,
        },
        vec![],
    );
    let err = env.send(&[ret], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_REMAINING);
}

// --- Advance sizing and price ----------------------------------------------------------------

#[test]
fn an_advance_is_sized_on_the_pools_last_epoch_growth_under_the_ceiling() {
    let mut env = Env::new();
    let alice = env.holder(30 * SOL);
    let p1 = env.open(&alice, 10 * SOL).unwrap();
    // 649 bps a year on 13 SOL for 3 months, 80% of it, at $150.
    let s1 = env.advance_stake(&alice, p1, 3).unwrap();
    assert_eq!(env.position(p1).rate_bps, 649);
    assert_eq!(env.stored(s1).issued, gemas_for(13 * SOL, 649, 3));

    // A higher ceiling than the growth changes nothing; a lower one caps the APY.
    env.set_ceiling(300).unwrap();
    let p2 = env.open(&alice, 10 * SOL).unwrap();
    let s2 = env.advance_stake(&alice, p2, 3).unwrap();
    assert_eq!(env.position(p2).rate_bps, 300);
    assert_eq!(env.stored(s2).issued, gemas_for(13 * SOL, 300, 3));

    // A spike in the last epoch cannot make an oversized Advance: 10% in one epoch is capped.
    env.set_pool(pool_data(
        1_430_000_000_000,
        1_000_000_000_000,
        EPOCH,
        1_300_000_000_000,
        1_000_000_000_000,
    ));
    env.set_ceiling(CEILING_BPS).unwrap();
    let p3 = env.open(&alice, 10 * SOL).unwrap();
    let s3 = env.advance_stake(&alice, p3, 1).unwrap();
    assert_eq!(env.position(p3).rate_bps, CEILING_BPS);
    assert!(env.stored(s3).issued > 0);
}

#[test]
fn no_growth_to_size_on_or_no_ceiling_means_no_advance() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    // The pool shows no growth over its last epoch.
    env.set_pool(pool_data(
        1_300_000_000_000,
        1_000_000_000_000,
        EPOCH,
        1_300_000_000_000,
        1_000_000_000_000,
    ));
    let err = env.advance_stake(&alice, pos, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::NoStakingGrowth));
    // A pool with no previous epoch has none either.
    env.set_pool(pool_data(1_300_000_000_000, 1_000_000_000_000, EPOCH, 0, 0));
    let err = env.advance_stake(&alice, pos, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::NoStakingGrowth));

    // Before the ceiling is set no Advance is sized (a fresh deployment).
    let mut fresh = Env::new();
    let admin = fresh.admin.insecure_clone();
    let reset = tix(
        accounts::SetStakeApyCeiling {
            admin: a(admin.pubkey()),
            config: pda(&[CONFIG_SEED]),
            stake_config: pda(&[STAKE_CONFIG_SEED]),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::SetStakeApyCeiling { apy_ceiling_bps: 1 },
        vec![],
    );
    fresh.send(&[reset], &admin, &[]).unwrap();
    // Zero the ceiling directly to stand for "not set yet" (the instruction refuses zero).
    let mut cfg = fresh.load::<StakeConfig>(pda(&[STAKE_CONFIG_SEED]));
    cfg.apy_ceiling_bps = 0;
    fresh.write(pda(&[STAKE_CONFIG_SEED]), &cfg, StakeConfig::SPACE);
    let bob = fresh.holder(10 * SOL);
    let pos = fresh.open(&bob, 10 * SOL).unwrap();
    let err = fresh.advance_stake(&bob, pos, 1).unwrap_err();
    assert_eq!(code(&err), ERR_CEILING_NOT_SET);
}

#[test]
fn a_stake_position_prices_only_from_the_pyth_mapping() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();

    // A stale feed, and a feed that is not the mapped account, are refused.
    let now = env.now();
    env.put_feed(FEED_150, 5_000_000, now - 91);
    let (advance, _) = env.advance_ix(&alice, pos, 1);
    let err = env.send(&[advance], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), 6011);
    let other_feed = APk::new_unique();
    env.svm
        .set_account(
            s(other_feed),
            account(
                tesoro_core::pyth::PYTH_RECEIVER,
                pyth_image(PYTH_SOL_USD, FEED_150, 0, now),
            ),
        )
        .unwrap();
    let (mut advance, _) = env.advance_ix(&alice, pos, 1);
    let at = advance
        .accounts
        .iter()
        .position(|m| m.pubkey == s(env.feed()))
        .unwrap();
    advance.accounts[at].pubkey = s(other_feed);
    let err = env.send(&[advance], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), 6020, "the mapped feed address is enforced");

    // The keeper's PriceFeed path cannot reach it: `take_native_advance` wants a native Position.
    let source = env.source(pos, 0);
    let keeper = tix(
        accounts::TakeNativeAdvance {
            owner_authority: alice.key,
            owner_account: alice.account,
            protections: pda(&[PROTECTIONS_SEED, alice.account.as_ref()]),
            position: pos.position,
            price_feed: pda(&[PRICE_SEED, SIM_SOL_MINT.as_ref()]),
            pool: pda(&[b"pool"]),
            source,
            book: book_address(&source).0,
            basket: env.basket(&alice),
            spill: env.spill(&alice),
            economy: pda(&[ECONOMY_SEED]),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::TakeNativeAdvance {
            horizon_months: 1,
            min_gemas: 1,
        },
        vec![],
    );
    let err = env.send(&[keeper], &alice.kp, &[]).unwrap_err();
    assert!(
        matches!(code(&err), ERR_NOT_NATIVE | 2006 | 3012 | 3007),
        "{}",
        code(&err)
    );

    // Nor can the oracle name a price for it: `take_advance` refuses a computed Position.
    let oracle = env.oracle.insecure_clone();
    let by_oracle = tix(
        accounts::TakeAdvance {
            oracle: a(oracle.pubkey()),
            owner_authority: alice.key,
            config: pda(&[CONFIG_SEED]),
            treasury: pda(&[TREASURY_SEED]),
            owner_account: alice.account,
            protections: pda(&[PROTECTIONS_SEED, alice.account.as_ref()]),
            position: pos.position,
            source,
            book: book_address(&source).0,
            basket: env.basket(&alice),
            spill: env.spill(&alice),
            economy: pda(&[ECONOMY_SEED]),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::TakeAdvance {
            horizon_months: 1,
            price_micro_usd: 1_000_000_000_000,
            min_gemas: 1,
        },
        vec![rem(pda(&[ONCHAIN_PRICE_SEED, env.mint.as_ref()]), false)],
    );
    let err = env.send(&[by_oracle], &oracle, &[&alice.kp]).unwrap_err();
    assert_eq!(code(&err), ERR_NATIVE_POSITION);

    // The mapped, fresh feed works.
    env.advance_stake(&alice, pos, 1).expect("priced advance");
}

#[test]
fn a_self_excluded_owner_takes_no_stake_advance_and_no_extend() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_stake(&alice, pos, 1).unwrap();
    let set = tix(
        accounts::SetProtection {
            owner_authority: alice.key,
            owner_account: alice.account,
            protections: pda(&[PROTECTIONS_SEED, alice.account.as_ref()]),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::SetSelfExclusion { months: 6 },
        vec![],
    );
    env.send(&[set], &alice.kp, &[]).unwrap();
    env.advance(MONTH_SECS);
    let err = env.advance_stake(&alice, pos, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::SelfExcluded));
    let err = env.extend_stake(&alice, pos, source, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::SelfExcluded));
}

#[test]
fn extend_adds_the_extra_months_sized_the_same_way() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_stake(&alice, pos, 2).unwrap();
    let before = env.stored(source);
    env.extend_stake(&alice, pos, source, 1).expect("extend");
    let after = env.stored(source);
    assert_eq!(after.horizon_months, 3);
    // Months 3 minus months 2 at 649 bps, each floored as the program does.
    assert_eq!(
        after.issued - before.issued,
        gemas_for(13 * SOL, 649, 3) - gemas_for(13 * SOL, 649, 2)
    );
    assert_eq!(env.gemas(&alice, source), after.issued);
    // The Extension is its own tranche, junior to the Advance's own Gemas.
    let ext = find_line(
        &env.svm,
        alice.account,
        source,
        SIDE_OWN,
        CLASS_GENERAL + 1,
        1,
    )
    .unwrap();
    assert_eq!(ext.amount, after.issued - before.issued);
}

#[test]
fn the_oracle_and_the_bridge_cannot_drive_a_stake_position() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let oracle = env.oracle.insecure_clone();
    let apply = tix(
        accounts::ApplyYield {
            oracle: a(oracle.pubkey()),
            config: pda(&[CONFIG_SEED]),
            position: pos.position,
            source: None,
        },
        instruction::ApplyYield {
            seq: 1,
            cumulative: 1_000,
        },
        vec![],
    );
    let err = env.send(&[apply], &oracle, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_NATIVE_POSITION);
    let claim = tix(
        accounts::ClaimFreeYield {
            owner_authority: alice.key,
            owner_account: alice.account,
            position: pos.position,
        },
        instruction::ClaimFreeYield { amount: 1 },
        vec![],
    );
    let err = env.send(&[claim], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_NATIVE_POSITION);
}

// --- Treasury: realised fees only (D1), holders carry slashes (D2), no cushion (D3) -------------

/// A Position of 10 tokens with a 12-month Advance and 1,000 of Alice's Gemas won by Bob.
fn treasury_env() -> (Env, Person, Person, Pos, APk) {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let bob = env.holder(0);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_stake(&alice, pos, 12).unwrap();
    env.give_won(&alice, &bob, source, 1_000);
    (env, alice, bob, pos, source)
}

#[test]
fn the_treasury_starts_empty_and_a_fee_is_not_its_own_until_yield_is_cashed_out() {
    let (mut env, _alice, bob, _pos, source) = treasury_env();
    assert_eq!(env.spendable(), 0);
    // 10% growth on 13 SOL: yield lands, but nobody cashed out, so no fee is realised.
    env.set_total(1_430_000_000_000);
    assert!(env.redeemable(&bob, source) > 0);
    assert_eq!(
        env.spendable(),
        0,
        "an open Position's fee is not spendable"
    );
    env.check_vault();
}

/// Failure 2 of the treasury slashing work, on the Solana staking custody: the Treasury balance
/// counted the earned fee of OPEN Positions as spendable. The admin withdrew it, the pool was
/// slashed, and the Player's Unlock found the vault short of the shares it must return. The
/// Treasury now spends only realised fees: the withdrawal is refused.
#[test]
fn an_open_positions_fee_is_not_spendable_so_a_slash_cannot_leave_unlock_short() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let company = env.person();
    env.set_tokens(&company, 0);
    env.set_company(company.key);
    // The pool grows 10%: yield accrues but nothing is realised, because nobody cashed out.
    env.set_total(1_430_000_000_000);
    let err = env.withdraw(company.token, 1_000_000).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::OverSpendable));
    assert_eq!(env.token_balance(company.token), 0);
    // The pool is then slashed below the rate Alice opened at.
    env.set_total(1_170_000_000_000);
    env.unlock(&alice, pos).expect("unlock after the slash");
    assert_eq!(
        env.token_balance(alice.token),
        10 * SOL,
        "Alice carries the slash as a token holder, not a missing-token failure"
    );
    env.check_vault();
}

#[test]
fn after_unlock_the_treasury_spends_its_half_and_the_pool_half_is_protected() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let company = env.person();
    env.set_tokens(&company, 0);
    env.set_company(company.key);
    env.set_total(1_430_000_000_000);
    let rate = env.rate();
    let free = tokens_for(
        ledger::stake_position_accrued(&env.position(pos), rate).unwrap(),
        rate,
    );
    env.unlock(&alice, pos).unwrap();
    let fee_tokens = free - free * 8_000 / 10_000;
    let route = env.route();
    assert_eq!(route.treasury_shares, fee_tokens as u128);
    assert_eq!(
        route.pool_owed,
        (fee_tokens / 2) as u128,
        "half the Yield Fee is the Pool's"
    );
    let mine = env.spendable();
    assert_eq!(mine, fee_tokens - fee_tokens / 2);
    // A withdrawal beyond Tesoro's half is refused, however small the excess.
    let max_units = ledger::units_for_tokens(mine, rate).unwrap();
    let err = env.withdraw(company.token, max_units + 2_000).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::OverSpendable));
    env.withdraw(company.token, max_units)
        .expect("its own half");
    assert_eq!(
        env.token_balance(company.token),
        tokens_for(max_units, rate)
    );
    assert!(
        env.route().pool_owed == route.pool_owed,
        "the Pool's half is untouched"
    );
    env.check_vault();
}

#[test]
fn only_the_admin_withdraws_the_treasury_and_only_to_the_company_wallet() {
    let (mut env, alice, _bob, pos, _source) = treasury_env();
    let company = env.person();
    let mallory = env.holder(0);
    env.set_tokens(&company, 0);
    // No company wallet set yet.
    let err = env.withdraw(company.token, 1_000).unwrap_err();
    assert_eq!(
        code(&err),
        6000 + tesoro_core::error::TesoroError::CompanyNotSet as u32
    );
    env.set_company(company.key);
    env.fund_treasury(SOL);
    // Not another wallet's token account, even as the admin.
    let err = env.withdraw(mallory.token, 1_000).unwrap_err();
    assert_eq!(
        code(&err),
        6000 + tesoro_core::error::TesoroError::InvalidAccount as u32
    );
    // A non-admin cannot.
    let mut ix = tix(
        accounts::WithdrawTreasuryStake {
            admin: mallory.key,
            config: pda(&[CONFIG_SEED]),
            treasury: pda(&[TREASURY_SEED]),
            custody: env.custody_address(),
            vault: env.vault(),
            company_token: company.token,
            stake_pool: env.pool,
            token_program: TOKEN_PROGRAM_ID,
        },
        instruction::WithdrawTreasuryStake { amount: 1_000 },
        vec![],
    );
    ix.accounts[0].is_signer = true;
    let err = env.send(&[ix], &mallory.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_UNAUTHORIZED);
    let _ = (alice, pos);
    env.withdraw(company.token, 1_000)
        .expect("the admin pays the company");
    env.check_vault();
}

/// Holders carry a slash (D2): their ready Gemas are claims on the shares the yield was worth
/// when it landed, so a later slash lowers what the tokens are worth, never how many there are.
#[test]
fn a_slash_between_landing_and_redeem_changes_the_value_not_the_number_of_shares() {
    let (mut env, _alice, bob, pos, source) = treasury_env();
    // The pool grows 5%; a small Redeem by Bob lands the yield.
    env.set_total(1_365_000_000_000);
    let rate_landed = env.rate();
    let ready_first = env.redeemable(&bob, source);
    assert!(ready_first > 10);
    env.redeem(&bob, pos, source, 1).expect("lands the yield");
    let lands = env.token_balance(bob.token);
    assert!(lands > 0);
    let ready = env.redeemable(&bob, source);
    // The pool is slashed below the rate the Position opened at.
    env.set_total(1_100_000_000_000);
    assert_eq!(
        env.redeemable(&bob, source),
        ready,
        "Redeem now never goes down"
    );
    let before = env.token_balance(bob.token);
    env.redeem(&bob, pos, source, ready)
        .expect("redeem after the slash");
    let got = env.token_balance(bob.token) - before;
    // The shares are those the Gemas were worth at the landing, at the rate of the landing.
    let units = env.stored(source).units_for(ready).unwrap();
    let want = tokens_for(units, rate_landed) * 8_000 / 10_000;
    assert!(
        got.abs_diff(want) <= 2,
        "got {got} want {want}: shares are fixed at landing (less the Yield Fee)"
    );
    env.check_vault();
}

#[test]
fn unlocked_holders_are_owed_shares_that_the_treasury_can_never_spend() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let bob = env.holder(0);
    let company = env.person();
    env.set_tokens(&company, 0);
    env.set_company(company.key);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_stake(&alice, pos, 1).unwrap();
    env.give_won(&alice, &bob, source, 400);
    env.set_total(1_400_000_000_000);
    env.unlock(&alice, pos).expect("unlock");
    let route = env.route();
    assert!(
        route.owed_shares > 0,
        "Bob's 400 Gemas are claims on shares"
    );
    // The Treasury cannot touch what Bob is owed, whatever the rate does.
    env.set_total(1_000_000_000_000);
    let rate = env.rate();
    let spendable = env.spendable();
    let units = ledger::units_for_tokens(spendable, rate).unwrap();
    let err = env.withdraw(company.token, units + 100_000).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::OverSpendable));
    env.withdraw(company.token, units).unwrap();
    // Bob is paid the shares fixed when they landed, from owed_shares.
    let owed = env.route().owed_shares;
    assert_eq!(owed, route.owed_shares);
    let ready = env.redeemable(&bob, source);
    assert!(ready > 0);
    env.redeem(&bob, pos, source, ready).expect("late redeem");
    let paid = env.token_balance(bob.token);
    assert!(paid > 0 && (paid as u128) <= owed);
    // Bob's whole claim leaves `owed_shares`; he is paid it less the Yield Fee.
    let claim = owed - env.route().owed_shares;
    assert_eq!(paid as u128, claim * 8_000 / 10_000);
    env.check_vault();
}

/// A fill pays 60% of the value at fill (the Yield Fee, then the 25% Instant fee) from the spendable
/// shares only, and a fill that would
/// need more than the Treasury may spend is refused.
#[test]
fn an_instant_redeem_fill_is_bounded_by_the_spendable_shares() {
    let (mut env, _alice, bob, pos, source) = treasury_env();
    env.request(&bob, pos, source, 1_000, 1).expect("request");
    assert_eq!(env.gemas(&bob, source), 0, "the Gemas wait in the order");
    // Empty Treasury: nothing to spend.
    let err = env.fill(&bob, pos, source, 1, 100).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::OverSpendable));
    // Funding is the Treasury's own and spendable at once.
    env.fund_treasury(SOL);
    let rate = env.rate();
    let units = env.stored(source).units_for(400).unwrap();
    let value = tokens_for(units, rate);
    let before = env.token_balance(bob.token);
    let spend_before = env.spendable();
    env.fill(&bob, pos, source, 1, 400).expect("fill");
    let paid = env.token_balance(bob.token) - before;
    let expect = value * 6_000 / 10_000;
    assert!(paid.abs_diff(expect) <= 2, "paid {paid} expect {expect}");
    assert_eq!(spend_before - env.spendable(), paid);
    assert_eq!(env.treasury_gemas(source), 400);
    // A fill needing more than is spendable is refused and changes nothing.
    env.withdraw_all_spendable_to_company();
    let err = env.fill(&bob, pos, source, 1, 100).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::OverSpendable));
    assert_eq!(env.treasury_gemas(source), 400);
    env.check_vault();
}

#[test]
fn cancelling_a_part_filled_order_returns_the_unsold_gemas_exactly() {
    let (mut env, _alice, bob, pos, source) = treasury_env();
    env.request(&bob, pos, source, 1_000, 1).expect("request");
    env.fund_treasury(SOL);
    env.fill(&bob, pos, source, 1, 400).expect("fill");
    assert_eq!(env.gemas(&bob, source), 0, "the rest waits in the order");
    let cancel = env.return_order_ix(&bob, &bob, source, 1, false);
    env.send(&[cancel], &bob.kp, &[]).expect("cancel");
    assert_eq!(
        env.gemas(&bob, source),
        600,
        "only the unsold Gemas come back"
    );
    assert_eq!(env.treasury_gemas(source), 400);
    assert!(env
        .svm
        .get_account(&s(env.order_address(&bob, 1)))
        .is_none());
    env.check_vault();
}

#[test]
fn the_treasury_redeems_what_it_bought_at_full_value_into_its_own_shares() {
    let (mut env, _alice, bob, pos, source) = treasury_env();
    env.request(&bob, pos, source, 1_000, 1).expect("request");
    env.fund_treasury(SOL);
    env.fill(&bob, pos, source, 1, 1_000).expect("fill");
    assert_eq!(env.treasury_gemas(source), 1_000);
    // Growth repays the whole Advance, so the Treasury's Gemas are redeemable.
    env.set_total(1_430_000_000_000);
    let before = env.route().treasury_shares;
    let payer = env.person();
    env.redeem_treasury(&payer.kp, pos, source, 1_000)
        .expect("treasury redeems");
    assert_eq!(env.treasury_gemas(source), 0);
    assert!(
        env.route().treasury_shares > before,
        "the shares stay in the vault as the Treasury's"
    );
    env.check_vault();
}

impl Env {
    fn withdraw_all_spendable_to_company(&mut self) {
        let company = self.person();
        self.set_tokens(&company, 0);
        self.set_company(company.key);
        let units = ledger::units_for_tokens(self.spendable(), self.rate()).unwrap();
        if units > 0 {
            self.withdraw(company.token, units).unwrap();
        }
    }
}

#[test]
fn a_stale_pool_stops_redeem_unlock_advance_and_the_instant_redeem_request() {
    let (mut env, alice, bob, pos, source) = treasury_env();
    env.set_total(1_326_000_000_000);
    env.set_clock(env.now(), EPOCH + 2);
    let stale = core_code(ledger::CoreError::StaleStakePool);
    let covered = env.redeemable(&alice, source);
    assert!(covered > 0);
    assert_eq!(
        code(&env.redeem(&alice, pos, source, covered).unwrap_err()),
        stale
    );
    assert_eq!(code(&env.unlock(&alice, pos).unwrap_err()), stale);
    assert_eq!(code(&env.advance_stake(&alice, pos, 1).unwrap_err()), stale);
    assert_eq!(
        code(&env.return_own(&alice, pos, source, 1).unwrap_err()),
        stale
    );
    assert_eq!(
        code(&env.request(&bob, pos, source, 500, 1).unwrap_err()),
        stale
    );
    // The pool updating again opens everything back up.
    env.set_clock(env.now(), EPOCH + 1);
    env.redeem(&alice, pos, source, covered)
        .expect("fresh again");
}

#[test]
fn unlock_closes_a_repaid_advance_and_pays_in_the_token() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_stake(&alice, pos, 1).unwrap();
    env.set_total(1_400_000_000_000);
    assert_eq!(env.debt(source), 0);
    assert_eq!(env.position(pos).open_advance, Some(0));
    env.unlock(&alice, pos)
        .expect("unlock with the Source passed");
    assert_eq!(env.position(pos).open_advance, None);
    // The owner gets the custody less the shares owed to holders and the fee on the free yield
    // (the coverage landed in one step, so the custody is not short and the Treasury tops up
    // nothing).
    let held = env.route().owed_shares as u64;
    let fee = (env.route().treasury_shares - env.route().owed_shares) as u64;
    assert!(fee > 0, "the free yield beyond the Advance paid the fee");
    assert_eq!(env.token_balance(alice.token), 10 * SOL - held - fee);
    // The Gemas of the closed Source still redeem against the shares left for them.
    let gemas = env.gemas(&alice, source);
    env.redeem(&alice, pos, source, gemas).expect("late redeem");
    assert_eq!(env.gemas(&alice, source), 0);
    env.check_vault();
}

#[test]
fn the_vault_returns_every_principal_and_the_treasury_keeps_its_fee() {
    let mut env = Env::new();
    let people: Vec<Person> = (0..3).map(|_| env.holder(100 * SOL)).collect();
    let amounts = [10 * SOL, 7 * SOL + 12_345, 3 * SOL];
    let mut positions = vec![];
    for (i, p) in people.iter().enumerate() {
        // The pool grows between opens, so each Position has its own rate at open.
        env.set_total(1_300_000_000_000 + i as u64 * 20_000_000_000);
        positions.push(env.open(p, amounts[i]).unwrap());
    }
    env.set_total(1_600_000_000_000);
    let rate = env.rate();
    let vault_before = env.token_balance(env.vault());
    assert_eq!(vault_before, amounts.iter().sum::<u64>());
    let mut paid = 0u64;
    for (p, pos) in people.iter().zip(&positions) {
        let before = env.token_balance(p.token);
        env.unlock(p, *pos).expect("unlock");
        let got = env.token_balance(p.token) - before;
        let position = env.position(*pos);
        // Each Player gets at least their Principal's worth of tokens at the new rate.
        assert!(got >= tokens_for(position.principal, rate), "{got}");
        paid += got;
        env.check_vault();
    }
    let left = env.token_balance(env.vault());
    assert_eq!(left, vault_before - paid);
    // What remains is exactly the Treasury's realised fees.
    assert_eq!(left as u128, env.route().treasury_shares);
    assert_eq!(env.custody().open_positions, 0);
}

/// The ready part of an Instant Redeem is an ordinary Redeem (red-team 31 #5): the seller gets
/// exactly floor(80%) of the shares redeemed, the Treasury the rest, at the request and at the fill.
#[test]
fn the_ready_part_of_an_instant_redeem_pays_the_yield_fee() {
    let (mut env, _alice, bob, pos, source) = treasury_env();
    env.fund_treasury(SOL);
    env.set_total(1_365_000_000_000);
    // The request first Redeems the line's ready part, then sells from the rest.
    let ready = env.redeemable(&bob, source);
    assert!(ready > 0 && ready < 1_000, "ready {ready}");
    let route = env.route();
    env.request(&bob, pos, source, 1_000 - ready, 1)
        .expect("request");
    let got = u128::from(env.token_balance(bob.token));
    let fee = env.route().treasury_shares - route.treasury_shares;
    assert!(got > 0, "part of the line was ready");
    assert_eq!(got, (got + fee) * 8_000 / 10_000, "seller {got}, fee {fee}");
    // More repays while the order waits; the fill Redeems that part first, with the same fee.
    env.set_total(1_370_000_000_000);
    let before = env.token_balance(bob.token);
    let route = env.route();
    env.fill(&bob, pos, source, 1, 10).expect("fill");
    let state = env.load::<InstantOrderState>(env.order_address(&bob, 1));
    assert!(state.redeemed_while_open > 0, "part repaid while it waited");
    let ready = u128::from(env.token_balance(bob.token) - before) - state.paid_shares;
    let fee = env.route().treasury_shares + state.paid_shares - route.treasury_shares;
    assert!(ready > 0);
    assert_eq!(
        ready,
        (ready + fee) * 8_000 / 10_000,
        "seller {ready}, fee {fee}"
    );
    env.check_vault();
}

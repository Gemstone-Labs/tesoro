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
use tesoro_core::ledger::{self, PositionStatus};
use tesoro_core::stake::{stake_position_id, STAKE_POOL_PROGRAMS};
use tesoro_core::state::*;
use tesoro_core::{accounts, instruction};

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
const ERR_TREASURY_SHORT: u32 = 6017;
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
        env
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
                invite_gate: invite_gate_pda(),
                system_program: anchor_lang::system_program::ID,
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

    /// A person holding `tokens` of the staking token.
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
        self.send(&[open], &p.kp, &[]).map(|_| pos)
    }

    fn position(&self, pos: Pos) -> ledger::Position {
        self.load::<PositionState>(pos.position).inner
    }
    fn source(&self, pos: Pos, index: u32) -> APk {
        pda(&[SOURCE_SEED, pos.position.as_ref(), &index.to_le_bytes()])
    }
    fn holding(&self, p: &Person, source: APk) -> APk {
        pda(&[HOLDING_SEED, p.account.as_ref(), source.as_ref()])
    }
    fn gemas(&self, p: &Person, source: APk) -> u64 {
        self.load::<HoldingState>(self.holding(p, source))
            .inner
            .amount
    }
    fn stored(&self, source: APk) -> ledger::Source {
        self.load::<SourceState>(source).inner
    }

    /// The Source as the program derives it now.
    fn view(&self, source: APk) -> ledger::Source {
        let stored = self.stored(source);
        let position = self
            .load::<PositionState>(APk::new_from_array(stored.position))
            .inner;
        let net = ledger::stake_position_accrued(&position, self.rate())
            .unwrap()
            .net;
        ledger::native::source_view(&position, &stored, net).unwrap()
    }
    fn debt(&self, source: APk) -> u64 {
        self.view(source).debt()
    }

    fn advance_ix(&self, p: &Person, pos: Pos, months: u8) -> (Instruction, APk) {
        let position = self.position(pos);
        let source = self.source(pos, position.advances);
        let prev_source = position.open_advance.map(|index| self.source(pos, index));
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
                prev_source,
                source,
                holding: self.holding(p, source),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::TakeStakeAdvance {
                horizon_months: months,
            },
            vec![],
        );
        (advance, source)
    }

    fn advance_stake(&mut self, p: &Person, pos: Pos, months: u8) -> Result<APk, Failed> {
        self.refresh_feed();
        let (advance, source) = self.advance_ix(p, pos, months);
        self.send(&[advance], &p.kp, &[]).map(|_| source)
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
                holding: self.holding(p, source),
                extend_limit: pda(&[EXTEND_LIMIT_SEED, p.account.as_ref()]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::ExtendStakeAdvance { extra_months },
            vec![],
        );
        self.send(&[extend], &p.kp, &[])
    }

    fn pool_tail(&self) -> Vec<AccountMeta> {
        vec![rem(self.custody_address(), true), rem(self.pool, false)]
    }

    fn redeem_ix(&self, p: &Person, pos: Pos, source: APk, amount: u64) -> Instruction {
        let mut remaining = self.pool_tail();
        remaining.extend([
            rem(self.vault(), true),
            rem(p.token, true),
            rem(TOKEN_PROGRAM_ID, false),
        ]);
        tix(
            accounts::Redeem {
                holder_authority: p.key,
                holder_account: p.account,
                position: pos.position,
                source,
                holding: self.holding(p, source),
            },
            instruction::Redeem { amount },
            remaining,
        )
    }

    fn redeem(&mut self, p: &Person, pos: Pos, source: APk, amount: u64) -> Result<(), Failed> {
        let ix = self.redeem_ix(p, pos, source, amount);
        self.send(&[ix], &p.kp, &[])
    }

    fn unlock_ix(&self, p: &Person, pos: Pos) -> Instruction {
        let mut remaining = self.pool_tail();
        remaining.extend([
            rem(self.vault(), true),
            rem(p.token, true),
            rem(TOKEN_PROGRAM_ID, false),
        ]);
        if let Some(index) = self.position(pos).open_advance {
            remaining.push(rem(self.source(pos, index), true));
        }
        tix(
            accounts::Unlock {
                owner_authority: p.key,
                owner_account: p.account,
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
        let ret = tix(
            accounts::ReturnOwn {
                owner_authority: p.key,
                owner_account: p.account,
                position: pos.position,
                source,
                holding: self.holding(p, source),
            },
            instruction::ReturnOwn { amount },
            self.pool_tail(),
        );
        self.send(&[ret], &p.kp, &[])
    }

    // --- Treasury ---------------------------------------------------------------------------

    fn treasury_holding(&self, source: APk) -> APk {
        pda(&[HOLDING_SEED, treasury_account().as_ref(), source.as_ref()])
    }

    /// Moves `n` of `from`'s own Gemas of `source` to `to` as won Gemas, as after a Match.
    fn give_won(&mut self, from: &Person, to: &Person, source: APk, n: u64) {
        let mut from_account = self.load::<TesoroAccount>(from.account);
        let from_key = self.holding(from, source);
        let mut from_holding = self.load::<HoldingState>(from_key);
        from_holding
            .inner
            .debit(&mut from_account.inner, n)
            .unwrap();
        let mut to_account = self.load::<TesoroAccount>(to.account);
        let to_key = self.holding(to, source);
        let mut to_holding = match self.svm.get_account(&s(to_key)) {
            Some(_) => self.load::<HoldingState>(to_key),
            None => HoldingState {
                bump: APk::find_program_address(
                    &[HOLDING_SEED, to.account.as_ref(), source.as_ref()],
                    &tesoro_core::ID,
                )
                .1,
                account: to.account,
                inner: ledger::Holding::new(source.to_bytes(), false),
            },
        };
        to_holding.inner.credit(&mut to_account.inner, n).unwrap();
        self.write(from.account, &from_account, TesoroAccount::SPACE);
        self.write(from_key, &from_holding, HoldingState::SPACE);
        self.write(to.account, &to_account, TesoroAccount::SPACE);
        self.write(to_key, &to_holding, HoldingState::SPACE);
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

    fn instant_redeem_ix(&self, p: &Person, pos: Pos, source: APk, amount: u64) -> Instruction {
        tix(
            accounts::InstantRedeemStake {
                holder_authority: p.key,
                holder_account: p.account,
                position: pos.position,
                source,
                holding: self.holding(p, source),
                treasury: pda(&[TREASURY_SEED]),
                treasury_account: treasury_account(),
                treasury_holding: self.treasury_holding(source),
                custody: self.custody_address(),
                vault: self.vault(),
                holder_token: p.token,
                stake_pool: self.pool,
                token_program: TOKEN_PROGRAM_ID,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InstantRedeemStake { amount },
            vec![],
        )
    }

    fn instant_redeem(
        &mut self,
        p: &Person,
        pos: Pos,
        source: APk,
        amount: u64,
    ) -> Result<(), Failed> {
        let ix = self.instant_redeem_ix(p, pos, source, amount);
        self.send(&[ix], &p.kp, &[])
    }

    fn redeem_treasury(
        &mut self,
        payer: &Keypair,
        pos: Pos,
        source: APk,
        amount: u64,
    ) -> Result<(), Failed> {
        let redeem = tix(
            accounts::RedeemTreasury {
                treasury: pda(&[TREASURY_SEED]),
                treasury_account: treasury_account(),
                position: pos.position,
                source,
                treasury_holding: self.treasury_holding(source),
            },
            instruction::RedeemTreasury { amount },
            self.pool_tail(),
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

    /// The Treasury's balance in tokens, as the program computes it.
    fn treasury_balance(&self) -> u64 {
        self.custody()
            .treasury_balance(self.rate(), self.token_balance(self.vault()))
            .unwrap()
    }
}

fn invite_gate_pda() -> APk {
    tesoro_core::state::invite_gate_pda()
}

/// Gemas an Advance of `months` is worth on `principal` lamports at `apy_bps`, $150 SOL and the
/// 20% Yield Fee, as `Position::open_advance` floors it.
fn gemas_for(principal: u64, apy_bps: u64, months: u64) -> u64 {
    let units =
        principal as u128 * apy_bps as u128 * months as u128 * 8_000 / (10_000u128 * 10_000 * 12);
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
    // 13 SOL at 6.48% for a month, less the 20% fee, at $150.
    let issued = env.stored(source).issued;
    assert_eq!(issued, gemas_for(13 * SOL, 649, 1));
    assert_eq!(env.debt(source), issued, "nothing has grown yet");

    // The pool's rate rises 1%: 13 SOL grew 0.13 SOL, 0.104 SOL after the fee, repaying Debt.
    env.set_total(1_313_000_000_000);
    let net = ledger::stake_position_accrued(&env.position(pos), env.rate()).unwrap();
    assert_eq!((net.gross, net.net), (130_000_000, 104_000_000));
    let view = env.view(source);
    assert_eq!(
        view.yield_units,
        net.net.min(view.units_to_repay_total().unwrap())
    );
    assert!(env.debt(source) < issued);

    // Redeem the Gemas that are covered: the payout is in the token at today's rate.
    let covered = view.redeemable_for(env.gemas(&alice, source));
    assert!(covered > 0);
    let before = env.token_balance(alice.token);
    env.redeem(&alice, pos, source, covered).expect("redeem");
    let units = view.units_for(covered).unwrap();
    assert_eq!(
        env.token_balance(alice.token) - before,
        tokens_for(units, env.rate())
    );
    assert_eq!(
        env.token_balance(env.vault()),
        10 * SOL - tokens_for(units, env.rate())
    );
}

#[test]
fn unlock_returns_the_principal_and_the_free_yield_in_the_token_and_books_the_fee() {
    let mut env = Env::new();
    let alice = env.holder(10 * SOL);
    let pos = env.open(&alice, 10 * SOL).unwrap();
    // No Advance: everything accrued is free yield. Rate +10%.
    env.set_total(1_430_000_000_000);
    let rate = env.rate();
    let net = ledger::stake_position_accrued(&env.position(pos), rate).unwrap();
    assert_eq!(net.gross, 1_300_000_000);
    assert_eq!(net.fee, 260_000_000);
    env.unlock(&alice, pos).expect("unlock");
    let paid = env.token_balance(alice.token);
    let expect = ledger::unlock_tokens(13 * SOL, net.net, 10 * SOL, rate).unwrap();
    assert_eq!(paid, expect);
    // 10 tokens at 1.30 = 13 SOL principal; at 1.43 they are 9.0909 tokens; plus the free yield
    // 1.04 SOL = 0.7273 tokens: the Player gets back about 9.818 of the 10 tokens.
    assert!(paid > 9_800_000_000 && paid < 9_850_000_000, "{paid}");
    // What stays in the vault is the Treasury's fee (and nothing else).
    let left = env.token_balance(env.vault());
    assert_eq!(left, 10 * SOL - paid);
    let fee_tokens = tokens_for(net.fee, rate);
    assert!(
        left.abs_diff(fee_tokens) <= 2,
        "left {left} fee {fee_tokens}"
    );
    let c = env.custody();
    assert_eq!((c.open_positions, c.principal), (0, 0));
    assert_eq!(c.realised_fee_shares as u64, fee_tokens);
    assert_eq!(env.position(pos).status, PositionStatus::Unlocked);
    assert_eq!(env.position(pos).custody_shares, 0);
    assert_eq!(env.treasury_balance(), left.min(fee_tokens));
    // Twice is refused.
    assert!(env.unlock(&alice, pos).is_err());
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
    assert_eq!(env.treasury_balance(), 0);
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
    let net_before = ledger::stake_position_accrued(&env.position(pos), env.rate())
        .unwrap()
        .net;
    assert!(net_before > owed);
    let second = env.advance_stake(&alice, pos, 1).expect("second advance");
    assert_eq!(env.position(pos).open_advance, Some(1));
    assert_eq!(env.position(pos).applied_net, net_before);
    assert_eq!(env.debt(second), env.stored(second).issued);
    // The first Source kept what it needed; the rest is free yield.
    assert_eq!(env.stored(first).yield_units, owed);
    assert_eq!(env.position(pos).free_yield, net_before - owed);
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
            position: pos.position,
            source,
            holding: env.holding(&alice, source),
        },
        instruction::ReturnOwn { amount: 1 },
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
            prev_source: None,
            source,
            holding: env.holding(&alice, source),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::TakeNativeAdvance { horizon_months: 1 },
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
            holding: env.holding(&alice, source),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::TakeAdvance {
            horizon_months: 1,
            price_micro_usd: 1_000_000_000_000,
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

// --- Treasury --------------------------------------------------------------------------------

/// A Position of 10 tokens with a 12-month Advance, 1,000 of Alice's Gemas won by Bob, and a
/// rate that has risen enough for the fee to cover the sale.
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
fn the_treasury_balance_is_the_fee_on_growth_and_starts_empty() {
    let (mut env, _alice, _bob, _pos, _source) = treasury_env();
    assert_eq!(env.treasury_balance(), 0);
    // 10% growth on 13 SOL: gross 1.3 SOL, fee 0.26 SOL, in tokens at the new rate.
    env.set_total(1_430_000_000_000);
    let want = tokens_for(260_000_000, env.rate());
    let got = env.treasury_balance();
    assert!(got <= want && want - got <= 3, "got {got} want {want}");
}

#[test]
fn instant_redeem_pays_75_percent_in_the_token_from_the_fee_and_hands_the_treasury_the_gemas() {
    let (mut env, _alice, bob, pos, source) = treasury_env();
    // Empty Treasury: refused, nothing moved.
    let err = env.instant_redeem(&bob, pos, source, 1_000).unwrap_err();
    assert_eq!(code(&err), ERR_TREASURY_SHORT);
    assert_eq!(env.gemas(&bob, source), 1_000);
    assert!(env
        .svm
        .get_account(&s(env.treasury_holding(source)))
        .is_none());

    env.set_total(1_326_000_000_000);
    let rate = env.rate();
    let source_before = env.stored(source);
    let balance_before = env.treasury_balance();
    let view = env.view(source);
    // Gemas whose yield has not landed yet are the ones Instant Redeem takes.
    let pending = 1_000 - view.redeemable_for(1_000);
    assert!(pending > 0);
    env.instant_redeem(&bob, pos, source, pending)
        .expect("instant");
    let units = view.units_for(pending).unwrap();
    let payout = units * 7_500 / 10_000;
    let tokens = tokens_for(payout, rate);
    assert_eq!(env.token_balance(bob.token), tokens);
    assert_eq!(env.custody().instant_shares, tokens);
    assert_eq!(env.treasury_balance(), balance_before - tokens);
    let bought = env.load::<HoldingState>(env.treasury_holding(source));
    assert_eq!((bought.inner.amount, bought.inner.is_own), (pending, false));
    // Debt, the Source's stored counts and the Position are untouched.
    assert_eq!(env.stored(source), source_before);
    assert_eq!(env.position(pos).status, PositionStatus::Locked);

    // Refilling: the Treasury redeems its Gemas once their yield lands, which adds to its balance.
    env.set_total(2_000_000_000_000);
    let before = env.custody().refilled_shares;
    let payer = env.person();
    let held = env
        .load::<HoldingState>(env.treasury_holding(source))
        .inner
        .amount;
    let redeemable = env.view(source).redeemable_for(held);
    assert!(redeemable > 0);
    env.redeem_treasury(&payer.kp, pos, source, redeemable)
        .expect("redeem treasury");
    assert!(env.custody().refilled_shares > before);
}

#[test]
fn the_treasury_never_pays_below_the_principal_reserve() {
    let (mut env, _alice, bob, pos, source) = treasury_env();
    env.set_total(1_326_000_000_000);
    // The fee claim is real, but pretend the vault lost tokens elsewhere: the headroom over the
    // Principal reserve caps what the Treasury can pay.
    let reserve = env
        .custody()
        .totals()
        .principal_reserve(env.rate())
        .unwrap();
    let mut vault = env.svm.get_account(&s(env.vault())).unwrap();
    let mut data = spl_token::state::Account::unpack(&vault.data).unwrap();
    data.amount = reserve + 1_000;
    spl_token::state::Account::pack(data, &mut vault.data).unwrap();
    env.svm.set_account(s(env.vault()), vault).unwrap();
    assert_eq!(env.treasury_balance(), 1_000);
    let pending = 1_000 - env.view(source).redeemable_for(1_000);
    assert!(pending > 0);
    let err = env.instant_redeem(&bob, pos, source, pending).unwrap_err();
    assert_eq!(code(&err), ERR_TREASURY_SHORT);
}

#[test]
fn the_admin_withdraws_the_fee_in_the_token_and_only_up_to_the_balance() {
    let (mut env, _alice, _bob, _pos, _source) = treasury_env();
    let company = env.person();
    let company_token = company.token;
    env.set_tokens(&company, 0);
    // No company wallet set yet.
    let err = env.withdraw(company_token, 1_000).unwrap_err();
    assert_eq!(code(&err), 6019);
    env.set_company(company.key);
    env.set_total(1_430_000_000_000);
    let rate = env.rate();
    let balance = env.treasury_balance();
    assert!(balance > 0);
    // More than the balance is refused.
    let too_much = ledger::units_for_tokens(balance, rate).unwrap() + 1_000;
    let err = env.withdraw(company_token, too_much).unwrap_err();
    assert_eq!(code(&err), ERR_TREASURY_SHORT);
    // Half of it is paid.
    let half_units = ledger::units_for_tokens(balance / 2, rate).unwrap();
    env.withdraw(company_token, half_units).expect("withdraw");
    assert_eq!(
        env.token_balance(company_token),
        tokens_for(half_units, rate)
    );
    assert_eq!(env.custody().withdrawn_shares, tokens_for(half_units, rate));
    assert!(env.treasury_balance() < balance - balance / 2 + 3);
    // A non-admin cannot.
    let mallory = env.person();
    let mut ix = tix(
        accounts::WithdrawTreasuryStake {
            admin: mallory.key,
            config: pda(&[CONFIG_SEED]),
            treasury: pda(&[TREASURY_SEED]),
            custody: env.custody_address(),
            vault: env.vault(),
            company_token,
            stake_pool: env.pool,
            token_program: TOKEN_PROGRAM_ID,
        },
        instruction::WithdrawTreasuryStake { amount: 1_000 },
        vec![],
    );
    ix.accounts[0].is_signer = true;
    let err = env.send(&[ix], &mallory.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_UNAUTHORIZED);
}

// --- Property: the vault stays solvent for the Principal --------------------------------------

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
    }
    let left = env.token_balance(env.vault());
    assert_eq!(left, vault_before - paid);
    // What remains is the Treasury's earned fee, nothing missing, nothing extra beyond rounding.
    let earned = env.custody().totals().earned_fee_shares(rate).unwrap();
    assert!(left >= earned, "vault {left} < fee {earned}");
    assert!(left - earned <= 8, "vault {left} far above fee {earned}");
    assert_eq!(env.custody().open_positions, 0);
}

// --- More: staleness on every path, Unlock with an Advance ------------------------------------

#[test]
fn a_stale_pool_stops_redeem_unlock_advance_and_instant_redeem() {
    let (mut env, alice, bob, pos, source) = treasury_env();
    env.set_total(1_326_000_000_000);
    env.set_clock(env.now(), EPOCH + 2);
    let stale = core_code(ledger::CoreError::StaleStakePool);
    let covered = env.view(source).redeemable_for(env.gemas(&alice, source));
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
    let pending = 1_000 - env.view(source).redeemable_for(1_000);
    assert_eq!(
        code(&env.instant_redeem(&bob, pos, source, pending).unwrap_err()),
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
    let rate = env.rate();
    let net = ledger::stake_position_accrued(&env.position(pos), rate).unwrap();
    let owed = env.stored(source).units_to_repay_total().unwrap();
    env.unlock(&alice, pos)
        .expect("unlock with the Source passed");
    assert_eq!(env.position(pos).open_advance, None);
    assert_eq!(env.stored(source).yield_units, owed);
    let free = net.net - owed;
    assert_eq!(
        env.token_balance(alice.token),
        ledger::unlock_tokens(13 * SOL, free, 10 * SOL, rate).unwrap()
    );
    // The Gemas of the closed Source still redeem against the tokens left for them.
    let held = env.gemas(&alice, source);
    env.redeem(&alice, pos, source, held).expect("late redeem");
    assert_eq!(env.gemas(&alice, source), 0);
}

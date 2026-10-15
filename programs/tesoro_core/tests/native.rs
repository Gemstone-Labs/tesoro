//! Solana-native Positions against the real `sim_lst` program (both built by
//! `pnpm build:programs`): shared custody, Debt and payouts computed from the clock with no crank
//! (ADR 0010), yield minted at payout, pool totals, Extend, Instant Redeem and the Treasury.
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::{get_associated_token_address, ID as ATA_PROGRAM_ID};
use anchor_spl::token::{spl_token, ID as TOKEN_PROGRAM_ID};
use litesvm::LiteSVM;
use proptest::prelude::*;
use solana_sdk::clock::Clock;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use tesoro_core::error::TesoroError;
use tesoro_core::ledger::{self, native, PositionStatus};
use tesoro_core::state::*;
use tesoro_core::{accounts, instruction};

const SOL: u64 = 1_000_000_000;
const T0: i64 = 1_000_000;
/// $150 per SOL, micro-USD.
const PRICE: u64 = 150_000_000;
/// One simulated month (1/12 year) of per-Position yield takes 600 s at the 4,380x speedup, so an
/// Advance of N months is repaid after N * MONTH seconds.
const MONTH: i64 = 600;

/// The launch rates: the Yield Fee and the Instant Redeem Fee, basis points.
const YIELD_FEE_BPS: u16 = 2_000;
const INSTANT_FEE_BPS: u16 = 3_500;

const ERR_INVALID_ACCOUNT: u32 = 6003;
const ERR_BAD_REMAINING: u32 = 6004;
const ERR_INVALID_MINT: u32 = 6008;
const ERR_NATIVE_POSITION: u32 = 6009;
const ERR_NOT_NATIVE: u32 = 6010;
const ERR_STALE_PRICE: u32 = 6011;
const ERR_TREASURY_SHORT: u32 = 6017;
const ERR_SOURCE_REQUIRED: u32 = 6018;
const CONSTRAINT_SEEDS: u32 = 2006;
const ACCOUNT_OWNED_BY_WRONG_PROGRAM: u32 = 3007;

fn a(p: Pk) -> APk {
    APk::new_from_array(p.to_bytes())
}
fn s(p: APk) -> Pk {
    Pk::new_from_array(p.to_bytes())
}
fn pda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &tesoro_core::ID).0
}
fn sim_pda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &sim_lst::ID).0
}
fn treasury_account() -> APk {
    pda(&[ACCOUNT_SEED, pda(&[TREASURY_SEED]).as_ref()])
}
fn core_code(e: ledger::CoreError) -> u32 {
    tesoro_core::error::CORE_ERROR_OFFSET + e.code()
}

fn ix(
    program_id: APk,
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
        program_id: s(program_id),
        accounts: metas,
        data: data.data(),
    }
}

fn tix(
    accounts: impl ToAccountMetas,
    data: impl InstructionData,
    remaining: Vec<AccountMeta>,
) -> Instruction {
    ix(tesoro_core::ID, accounts, data, remaining)
}

fn rem(k: APk, writable: bool) -> AccountMeta {
    if writable {
        AccountMeta::new(s(k), false)
    } else {
        AccountMeta::new_readonly(s(k), false)
    }
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

struct Person {
    kp: Keypair,
    key: APk,
    account: APk,
    token: APk,
}

/// A native Position and the addresses around it (the custody and vault are shared).
#[derive(Clone, Copy)]
struct Pos {
    position: APk,
    custody: APk,
    vault: APk,
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    oracle: Keypair,
    pool: APk,
    mint: APk,
    next_nonce: u64,
    last_cu: u64,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/");
        svm.add_program_from_file(s(tesoro_core::ID), format!("{dir}tesoro_core.so"))
            .expect("run `pnpm build:programs` first");
        svm.add_program_from_file(s(sim_lst::ID), format!("{dir}sim_lst.so"))
            .expect("run `pnpm build:programs` first");
        svm.set_sysvar(&Clock {
            unix_timestamp: T0,
            ..Clock::default()
        });
        let admin = Keypair::new();
        let oracle = Keypair::new();
        for k in [&admin, &oracle] {
            svm.airdrop(&k.pubkey(), 1_000 * SOL).expect("airdrop");
        }
        let pool = sim_pda(&[b"pool"]);
        let mint = sim_pda(&[b"mint"]);
        assert_eq!(mint, SIM_SOL_MINT, "SIM_SOL_MINT is the sim_lst mint PDA");
        let mut env = Self {
            svm,
            admin,
            oracle,
            pool,
            mint,
            next_nonce: 1,
            last_cu: 0,
        };
        let init_pool = ix(
            sim_lst::ID,
            sim_lst::accounts::Initialize {
                admin: a(env.admin.pubkey()),
                pool,
                mint,
                vault: sim_pda(&[b"vault"]),
                token_program: TOKEN_PROGRAM_ID,
                system_program: anchor_lang::system_program::ID,
            },
            sim_lst::instruction::Initialize {
                apy_bps: 700,
                speedup: sim_lst::DEFAULT_SPEEDUP,
                faucet_amount: 10 * SOL,
                faucet_cooldown: 3_600,
            },
            vec![],
        );
        let admin = env.admin.insecure_clone();
        env.send(&[init_pool], &admin, &[]).expect("init pool");

        let set_yield_authority = ix(
            sim_lst::ID,
            sim_lst::accounts::SetYieldAuthority {
                admin: a(env.admin.pubkey()),
                pool,
                config: sim_pda(&[sim_lst::YIELD_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            sim_lst::instruction::SetYieldAuthority {
                authority: pda(&[YIELD_SEED]),
            },
            vec![],
        );
        env.send(&[set_yield_authority], &admin, &[])
            .expect("set yield authority");

        let platform = env.person();
        let init = tix(
            accounts::InitializeConfig {
                admin: a(env.admin.pubkey()),
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
        env.init_treasury(YIELD_FEE_BPS, INSTANT_FEE_BPS)
            .expect("init treasury");
        env.init_custody().expect("init native custody");
        env.set_price(PRICE).expect("price");
        env
    }

    fn init_treasury(&mut self, yield_fee_bps: u16, instant_fee_bps: u16) -> Result<(), Failed> {
        let init = tix(
            accounts::InitTreasury {
                admin: a(self.admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                treasury: pda(&[TREASURY_SEED]),
                treasury_account: treasury_account(),
                mint: self.mint,
                treasury_vault: pda(&[TREASURY_VAULT_SEED]),
                token_program: TOKEN_PROGRAM_ID,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitTreasury {
                yield_fee_bps,
                instant_fee_bps,
            },
            vec![],
        );
        let admin = self.admin.insecure_clone();
        self.send(&[init], &admin, &[])
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

    fn load<T: AccountDeserialize>(&self, k: APk) -> T {
        let acct = self.svm.get_account(&s(k)).expect("account exists");
        T::try_deserialize(&mut acct.data.as_slice()).expect("deserialize")
    }

    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }
    fn set_time(&mut self, t: i64) {
        self.svm.set_sysvar(&Clock {
            unix_timestamp: t,
            ..Clock::default()
        });
    }
    fn advance(&mut self, secs: i64) {
        let t = self.now() + secs;
        self.set_time(t);
    }

    /// Total simSOL minted (faucet plus minted yield).
    fn supply(&self) -> u64 {
        let acct = self.svm.get_account(&s(self.mint)).expect("mint");
        spl_token::state::Mint::unpack(&acct.data)
            .expect("mint")
            .supply
    }

    fn rate(&self) -> u64 {
        let pool = self.load::<sim_lst::Pool>(self.pool);
        sim_lst::current_rate(&pool, self.now()).expect("rate")
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
                system_program: anchor_lang::system_program::ID,
            },
            instruction::CreateAccount {
                evm_address: [0; 20],
            },
            vec![],
        );
        self.send(&[create], &kp, &[]).expect("create account");
        Person {
            token: get_associated_token_address(&key, &self.mint),
            kp,
            key,
            account,
        }
    }

    fn faucet(&mut self, p: &Person) -> Result<(), Failed> {
        let faucet = ix(
            sim_lst::ID,
            sim_lst::accounts::Faucet {
                user: p.key,
                pool: self.pool,
                mint: self.mint,
                user_ata: p.token,
                claim: sim_pda(&[sim_lst::FAUCET_SEED, p.key.as_ref()]),
                token_program: TOKEN_PROGRAM_ID,
                associated_token_program: ATA_PROGRAM_ID,
                system_program: anchor_lang::system_program::ID,
            },
            sim_lst::instruction::Faucet {},
            vec![],
        );
        self.send(&[faucet], &p.kp, &[])
    }

    /// A person with 10 simSOL.
    fn staker(&mut self) -> Person {
        let p = self.person();
        self.faucet(&p).expect("faucet");
        p
    }

    fn set_price(&mut self, price: u64) -> Result<(), Failed> {
        let set = tix(
            accounts::SetPrice {
                oracle: a(self.oracle.pubkey()),
                config: pda(&[CONFIG_SEED]),
                price_feed: pda(&[PRICE_SEED, SIM_SOL_MINT.as_ref()]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetPrice {
                price_micro_usd: price,
            },
            vec![],
        );
        let oracle = self.oracle.insecure_clone();
        self.send(&[set], &oracle, &[])
    }

    fn init_custody(&mut self) -> Result<(), Failed> {
        let init = tix(
            accounts::InitNativeCustody {
                admin: a(self.admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                pool: self.pool,
                mint: self.mint,
                custody: pda(&[NATIVE_SEED]),
                vault: pda(&[NATIVE_VAULT_SEED]),
                token_program: TOKEN_PROGRAM_ID,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitNativeCustody {},
            vec![],
        );
        let admin = self.admin.insecure_clone();
        self.send(&[init], &admin, &[])
    }

    fn open_ix_with(
        &mut self,
        p: &Person,
        nonce: u64,
        shares: u64,
        pool: APk,
        mint: APk,
    ) -> (Instruction, Pos) {
        let position = pda(&[
            POSITION_SEED,
            &[0],
            &tesoro_core::native_position_id(&p.key, nonce),
        ]);
        let custody = pda(&[NATIVE_SEED]);
        let vault = pda(&[NATIVE_VAULT_SEED]);
        let open = tix(
            accounts::OpenNativePosition {
                owner_authority: p.key,
                owner_account: p.account,
                pool,
                mint,
                owner_token: p.token,
                position,
                treasury: pda(&[TREASURY_SEED]),
                custody,
                vault,
                token_program: TOKEN_PROGRAM_ID,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::OpenNativePosition {
                nonce,
                lst_amount: shares,
            },
            vec![],
        );
        (
            open,
            Pos {
                position,
                custody,
                vault,
            },
        )
    }

    fn open(&mut self, p: &Person, shares: u64) -> Result<Pos, Failed> {
        let nonce = self.next_nonce;
        self.next_nonce += 1;
        let (open, pos) = self.open_ix_with(p, nonce, shares, self.pool, self.mint);
        self.send(&[open], &p.kp, &[]).map(|_| pos)
    }

    fn source(&self, pos: Pos, index: u32) -> APk {
        pda(&[SOURCE_SEED, pos.position.as_ref(), &index.to_le_bytes()])
    }
    fn holding(&self, p: &Person, source: APk) -> APk {
        pda(&[HOLDING_SEED, p.account.as_ref(), source.as_ref()])
    }

    fn advance_ix(&self, p: &Person, pos: Pos, months: u8) -> (Instruction, APk) {
        let position = self.position(pos);
        let source = self.source(pos, position.advances);
        let prev_source = position.open_advance.map(|index| self.source(pos, index));
        let advance = tix(
            accounts::TakeNativeAdvance {
                owner_authority: p.key,
                owner_account: p.account,
                position: pos.position,
                price_feed: pda(&[PRICE_SEED, SIM_SOL_MINT.as_ref()]),
                pool: self.pool,
                prev_source,
                source,
                holding: self.holding(p, source),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::TakeNativeAdvance {
                horizon_months: months,
            },
            vec![],
        );
        (advance, source)
    }

    fn advance_native(&mut self, p: &Person, pos: Pos, months: u8) -> Result<APk, Failed> {
        let (advance, source) = self.advance_ix(p, pos, months);
        self.send(&[advance], &p.kp, &[]).map(|_| source)
    }

    fn extend_limit(&self, p: &Person) -> APk {
        pda(&[EXTEND_LIMIT_SEED, p.account.as_ref()])
    }

    fn set_extend_limit(&mut self, p: &Person, months: u8) -> Result<(), Failed> {
        let set = tix(
            accounts::SetExtendLimit {
                owner_authority: p.key,
                owner_account: p.account,
                extend_limit: self.extend_limit(p),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetExtendLimit { months },
            vec![],
        );
        self.send(&[set], &p.kp, &[])
    }

    fn extend_native(
        &mut self,
        p: &Person,
        pos: Pos,
        source: APk,
        extra_months: u8,
    ) -> Result<(), Failed> {
        let extend = tix(
            accounts::ExtendNativeAdvance {
                owner_authority: p.key,
                owner_account: p.account,
                position: pos.position,
                pool: self.pool,
                source,
                holding: self.holding(p, source),
                extend_limit: self.extend_limit(p),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::ExtendNativeAdvance { extra_months },
            vec![],
        );
        self.send(&[extend], &p.kp, &[])
    }

    /// `[pool, destination, mint, yield_config, yield_authority, sim_lst_program, token_program]`.
    fn yield_mint(&self, dest: APk) -> Vec<AccountMeta> {
        vec![
            rem(self.pool, false),
            rem(dest, true),
            rem(self.mint, true),
            rem(sim_pda(&[sim_lst::YIELD_SEED]), false),
            rem(pda(&[YIELD_SEED]), false),
            rem(sim_lst::ID, false),
            rem(TOKEN_PROGRAM_ID, false),
        ]
    }

    fn redeem_ix(&self, p: &Person, pos: Pos, source: APk, amount: u64, dest: APk) -> Instruction {
        let remaining = self.yield_mint(dest);
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
        let redeem = self.redeem_ix(p, pos, source, amount, p.token);
        self.send(&[redeem], &p.kp, &[])
    }

    fn unlock_ix(&self, p: &Person, pos: Pos, dest: APk) -> Instruction {
        let mut remaining = vec![rem(pos.custody, true), rem(pos.vault, true)];
        remaining.extend(self.yield_mint(dest));
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
        let unlock = self.unlock_ix(p, pos, p.token);
        self.send(&[unlock], &p.kp, &[])
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
            vec![rem(self.pool, false)],
        );
        self.send(&[ret], &p.kp, &[])
    }

    fn position(&self, pos: Pos) -> ledger::Position {
        self.load::<PositionState>(pos.position).inner
    }
    fn custody(&self) -> NativeCustody {
        self.load::<NativeCustody>(pda(&[NATIVE_SEED]))
    }
    fn stored(&self, source: APk) -> ledger::Source {
        self.load::<SourceState>(source).inner
    }

    /// The Source as the program sees it now: derived from the clock for an open Advance.
    fn view(&self, source: APk) -> ledger::Source {
        let stored = self.stored(source);
        let pos_key = APk::new_from_array(stored.position);
        let position = self.load::<PositionState>(pos_key).inner;
        let pool = self.load::<sim_lst::Pool>(self.pool);
        let net = native::position_accrued(&position, pool.speedup, self.now())
            .unwrap()
            .net;
        native::source_view(&position, &stored, net).unwrap()
    }
    fn debt(&self, source: APk) -> u64 {
        self.view(source).debt()
    }
    fn gemas(&self, p: &Person, source: APk) -> u64 {
        self.load::<HoldingState>(self.holding(p, source))
            .inner
            .amount
    }

    /// Net Accrued Yield of a Position now.
    fn accrued(&self, pos: Pos) -> ledger::AccruedYield {
        let pool = self.load::<sim_lst::Pool>(self.pool);
        native::position_accrued(&self.position(pos), pool.speedup, self.now()).unwrap()
    }

    /// The custody invariants, read back from chain state, for the Locked Positions given.
    fn check_invariants(&self, positions: &[Pos]) {
        let custody = self.custody();
        let vault = self.token_balance(pda(&[NATIVE_VAULT_SEED]));
        let (mut shares, mut principal, mut open) = (0u64, 0u128, 0u64);
        for pos in positions {
            let p = self.position(*pos);
            if p.status == PositionStatus::Locked {
                shares += p.custody_shares;
                principal += p.principal as u128;
                open += 1;
            } else {
                assert_eq!(p.custody_shares, 0, "an unlocked Position holds no shares");
            }
        }
        assert!(vault >= shares, "vault {vault} < Principal shares {shares}");
        assert_eq!(custody.principal, principal);
        assert_eq!(custody.open_positions, open);
    }
}

// --- Custody --------------------------------------------------------------------------------

#[test]
fn the_shared_custody_is_created_once_by_the_admin() {
    let mut env = Env::new();
    let c = env.custody();
    assert_eq!(c.vault, pda(&[NATIVE_VAULT_SEED]));
    assert_eq!(c.pool, env.pool);
    assert_eq!((c.principal, c.open_positions), (0, 0));
    assert!(env.init_custody().is_err(), "a second init is refused");
    let mallory = env.person();
    let mut init = tix(
        accounts::InitNativeCustody {
            admin: mallory.key,
            config: pda(&[CONFIG_SEED]),
            pool: env.pool,
            mint: env.mint,
            custody: pda(&[NATIVE_SEED]),
            vault: pda(&[NATIVE_VAULT_SEED]),
            token_program: TOKEN_PROGRAM_ID,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::InitNativeCustody {},
        vec![],
    );
    init.accounts[0].is_signer = true;
    assert!(env.send(&[init], &mallory.kp, &[]).is_err());
}

#[test]
fn open_moves_simsol_into_the_shared_vault_and_records_the_position() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    env.advance(MONTH);
    let rate = env.rate();
    let pos = env.open(&alice, 10 * SOL).expect("open");
    let pos2 = env.open(&bob, 4 * SOL).expect("open");

    assert_eq!(env.token_balance(alice.token), 0);
    assert_eq!(env.token_balance(pos.vault), 14 * SOL, "one vault for all");
    let position = env.position(pos);
    assert_eq!(
        position.principal,
        native::shares_value(10 * SOL, rate).unwrap()
    );
    assert_eq!(position.source_asset, SIM_SOL_MINT.to_bytes());
    assert_eq!(position.rate_bps, 700);
    assert_eq!(position.opened_at, T0 + MONTH);
    assert_eq!(position.custody_shares, 10 * SOL);
    assert_eq!(position.owner, alice.account.to_bytes());
    let totals = env.custody().totals();
    assert_eq!(totals.principal, 14 * SOL as u128);
    let w = 14 * SOL as u128 * 700 * YIELD_FEE_BPS as u128;
    assert_eq!(totals.fee_weight, w);
    assert_eq!(totals.fee_weight_time, w * (T0 + MONTH) as u128);
    assert_eq!(position.yield_fee_bps, YIELD_FEE_BPS);
    assert_eq!(totals.open_positions, 2);
    // The vault is owned by the custody PDA, not by a staker.
    let vault =
        spl_token::state::Account::unpack(&env.svm.get_account(&s(pos.vault)).unwrap().data)
            .unwrap();
    assert_eq!(vault.owner.to_bytes(), pos.custody.to_bytes());
    env.check_invariants(&[pos, pos2]);
}

#[test]
fn advance_is_priced_by_the_feed_and_owner_signs_alone() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).expect("advance");
    // 10 SOL at 7% for one month = 0.058333333 SOL, 80% of it after the Yield Fee = 0.046666666
    // SOL = 699 Gemas (floored) at $150.
    assert_eq!(env.gemas(&alice, source), 699);
    assert_eq!(env.debt(source), 699);
    // A second Advance is refused while Debt is open.
    let again = env.advance_native(&alice, pos, 1).unwrap_err();
    assert_eq!(
        code(&again),
        core_code(ledger::CoreError::AdvanceAlreadyOpen)
    );
}

#[test]
fn stale_price_blocks_an_advance() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    env.advance(MAX_PRICE_AGE_SECS + 1);
    let err = env.advance_native(&alice, pos, 1).unwrap_err();
    assert_eq!(code(&err), ERR_STALE_PRICE);
    env.set_price(PRICE).unwrap();
    env.advance_native(&alice, pos, 1).expect("fresh price");
}

#[test]
fn only_the_owner_takes_an_advance() {
    let mut env = Env::new();
    let alice = env.staker();
    let mallory = env.person();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.source(pos, 0);
    let advance = tix(
        accounts::TakeNativeAdvance {
            owner_authority: mallory.key,
            owner_account: mallory.account,
            position: pos.position,
            price_feed: pda(&[PRICE_SEED, SIM_SOL_MINT.as_ref()]),
            pool: env.pool,
            prev_source: None,
            source,
            holding: env.holding(&mallory, source),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::TakeNativeAdvance { horizon_months: 1 },
        vec![],
    );
    let err = env.send(&[advance], &mallory.kp, &[]).unwrap_err();
    assert_eq!(code(&err), 6000);
}

/// A direct transfer into the shared vault is not yield and not Principal: it repays no Debt, is
/// not redeemable, and stays behind when the Position unlocks (ADR 0001).
#[test]
fn a_donation_to_the_vault_repays_nothing_and_never_leaves_with_the_owner() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    let donor = env.staker();
    let mut data = vec![3u8];
    data.extend_from_slice(&SOL.to_le_bytes());
    let donate = Instruction {
        program_id: s(TOKEN_PROGRAM_ID),
        accounts: vec![
            AccountMeta::new(s(donor.token), false),
            AccountMeta::new(s(pos.vault), false),
            AccountMeta::new_readonly(s(donor.key), true),
        ],
        data,
    };
    env.send(&[donate], &donor.kp, &[]).expect("donate");
    assert_eq!(env.debt(source), 699, "a top-up must not repay Debt");
    env.advance(MONTH);
    assert_eq!(env.debt(source), 0);
    env.unlock(&alice, pos).expect("unlock");
    assert_eq!(
        env.token_balance(pos.vault),
        SOL,
        "the donation is still in the vault"
    );
    env.check_invariants(&[pos]);
}

// --- No crank -------------------------------------------------------------------------------

#[test]
fn debt_falls_with_the_clock_and_reaches_zero_at_the_horizon_with_no_crank() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    assert_eq!(env.debt(source), 699);

    env.advance(300);
    let half = env.debt(source);
    assert!(half > 0 && half < 699, "debt {half}");
    assert_eq!(env.stored(source).yield_units, 0, "nothing was recorded");

    env.advance(MONTH);
    assert_eq!(env.debt(source), 0);
    // Nothing closed the Advance: it is still the open one until an instruction observes it.
    assert_eq!(env.position(pos).open_advance, Some(0));
    assert_eq!(env.stored(source).yield_units, 0);
    env.check_invariants(&[pos]);
}

#[test]
fn redeem_mints_exactly_the_yield_paid_and_never_touches_principal() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();

    // Nothing is redeemable before any yield accrues.
    let err = env.redeem(&alice, pos, source, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::ExceedsRedeemable));

    env.advance(MONTH);
    let supply = env.supply();
    let vault = env.token_balance(pos.vault);
    env.redeem(&alice, pos, source, 699).expect("redeem all");

    // 699 Gemas = 46_600_000 lamports of SOL, minted as simSOL at the rate (rounded down).
    let paid = env.token_balance(alice.token);
    let expected = native::shares_for_units_floor(46_600_000, env.rate()).unwrap();
    assert_eq!(paid, expected);
    assert_eq!(env.supply() - supply, expected, "minted exactly at payout");
    assert_eq!(env.token_balance(pos.vault), vault, "Principal untouched");
    assert_eq!(env.gemas(&alice, source), 0);
    let stored = env.stored(source);
    assert_eq!((stored.redeemed, stored.redeemed_units), (699, 46_600_000));
    assert_eq!(stored.yield_units, 46_600_000);
    env.check_invariants(&[pos]);
}

#[test]
fn nothing_is_minted_until_a_payout() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    env.advance_native(&alice, pos, 1).unwrap();
    let supply = env.supply();
    env.advance(10 * MONTH);
    assert_eq!(env.supply(), supply);
    assert!(env.accrued(pos).net > 0);
}

#[test]
fn payouts_are_bounded_by_accrued_yield() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(300);
    let redeemable = env.view(source).redeemable();
    assert!(redeemable > 0 && redeemable < 699);
    let err = env.redeem(&alice, pos, source, redeemable + 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::ExceedsRedeemable));
    env.redeem(&alice, pos, source, redeemable).unwrap();
    // A second redeem of the same yield finds nothing left.
    let err = env.redeem(&alice, pos, source, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::ExceedsRedeemable));
    // More yield lands with the clock, and more can be redeemed.
    env.advance(100);
    assert!(env.view(source).redeemable() > 0);
    env.redeem(&alice, pos, source, 1).unwrap();
    let minted_units = env.stored(source).redeemed_units;
    assert!(minted_units <= env.accrued(pos).net);
}

#[test]
fn redeem_needs_the_native_accounts_and_pays_only_the_holder() {
    let mut env = Env::new();
    let alice = env.staker();
    let mallory = env.person();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH);

    // Without the payout accounts the call cannot burn Gemas for nothing.
    let bare = tix(
        accounts::Redeem {
            holder_authority: alice.key,
            holder_account: alice.account,
            position: pos.position,
            source,
            holding: env.holding(&alice, source),
        },
        instruction::Redeem { amount: 100 },
        vec![],
    );
    let err = env.send(&[bare], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_REMAINING);
    assert_eq!(env.gemas(&alice, source), 699);

    // The destination must belong to the holder.
    env.faucet(&mallory).unwrap();
    let steal = env.redeem_ix(&alice, pos, source, 100, mallory.token);
    let err = env.send(&[steal], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_INVALID_ACCOUNT);

    // A treasury, pool or sim_lst that is not the real one is refused.
    let mut fake_pool = env.redeem_ix(&alice, pos, source, 100, alice.token);
    fake_pool.accounts[5].pubkey = s(alice.account);
    assert!(env.send(&[fake_pool], &alice.kp, &[]).is_err());
    let mut fake_program = env.redeem_ix(&alice, pos, source, 100, alice.token);
    fake_program.accounts[10].pubkey = s(anchor_lang::system_program::ID);
    assert!(env.send(&[fake_program], &alice.kp, &[]).is_err());
    assert_eq!(env.gemas(&alice, source), 699);
}

#[test]
fn a_non_owner_holder_redeems_won_gemas_with_no_crank() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.give_won(&alice, &bob, source, 100);

    env.advance(MONTH);
    let bob_before = env.token_balance(bob.token);
    env.redeem(&bob, pos, source, 100).expect("bob redeems");
    let units = env.stored(source).units_for(100).unwrap();
    assert_eq!(
        env.token_balance(bob.token) - bob_before,
        native::shares_for_units_floor(units, env.rate()).unwrap()
    );
    env.check_invariants(&[pos]);
}

// --- Unlock ---------------------------------------------------------------------------------

#[test]
fn unlock_needs_zero_debt_and_pays_principal_plus_free_yield_with_no_crank() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();

    // Debt is open: principal cannot leave.
    let err = env.unlock(&alice, pos).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::DebtOutstanding));
    assert_eq!(env.token_balance(pos.vault), 10 * SOL);

    env.advance(MONTH);
    // The open Advance's Source must be supplied once Debt is zero.
    let mut without = env.unlock_ix(&alice, pos, alice.token);
    without.accounts.pop();
    let err = env.send(&[without], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_SOURCE_REQUIRED);

    env.redeem(&alice, pos, source, 699).unwrap();
    let before = env.token_balance(alice.token);
    let supply = env.supply();
    let net = env.accrued(pos);
    env.unlock(&alice, pos).expect("unlock");

    let position = env.position(pos);
    assert_eq!(position.status, PositionStatus::Unlocked);
    assert_eq!(position.open_advance, None);
    assert_eq!(position.custody_shares, 0);
    let y = env.stored(source).yield_units;
    assert_eq!(y, 46_600_000);
    let free = net.net - y;
    assert_eq!(position.free_yield, free);
    assert_eq!(position.free_yield_claimed, free);
    // Principal from the vault, free yield minted: exactly that and no more.
    let got = env.token_balance(alice.token) - before;
    let yield_shares = native::shares_for_units_floor(free, env.rate()).unwrap();
    assert_eq!(got, 10 * SOL + yield_shares);
    assert_eq!(env.supply() - supply, yield_shares);
    assert_eq!(env.token_balance(pos.vault), 0);
    // Totals: the Position left and its Yield Fee is booked.
    let totals = env.custody().totals();
    assert_eq!(
        (
            totals.principal,
            totals.fee_weight_time,
            totals.open_positions
        ),
        (0, 0, 0)
    );
    assert_eq!(totals.realised_fee, net.fee as u128);
    // Unlocking twice is refused.
    let err = env.unlock(&alice, pos).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::PositionNotLocked));
    env.check_invariants(&[pos]);
}

#[test]
fn unlock_with_no_advance_pays_all_the_accrued_yield() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    env.advance(MONTH);
    let net = env.accrued(pos);
    let before = env.token_balance(alice.token);
    env.unlock(&alice, pos).unwrap();
    let got = env.token_balance(alice.token) - before;
    assert_eq!(
        got,
        10 * SOL + native::shares_for_units_floor(net.net, env.rate()).unwrap()
    );
}

#[test]
fn gemas_still_redeem_after_unlock_from_the_closed_source() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH);
    env.unlock(&alice, pos).expect("unlock");
    env.advance(10 * MONTH);
    let supply = env.supply();
    env.redeem(&alice, pos, source, 699)
        .expect("redeem after unlock");
    assert_eq!(
        env.supply() - supply,
        native::shares_for_units_floor(46_600_000, env.rate()).unwrap(),
        "the closed Source pays what it owed, not more"
    );
}

#[test]
fn a_second_advance_after_debt_zero_counts_only_yield_after_it_opened() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let first = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(3 * MONTH);
    let net = env.accrued(pos).net;

    let second = env.advance_native(&alice, pos, 2).expect("second advance");
    let p = env.position(pos);
    assert_eq!(p.open_advance, Some(1));
    assert_eq!(p.applied_net, net, "the checkpoint moved to now");
    let y0 = env.stored(first).yield_units;
    assert_eq!(y0, 46_600_000, "the first Source kept its final yield");
    assert_eq!(p.free_yield, net - y0, "the rest was free yield");
    // The new Advance starts with its whole Debt.
    assert_eq!(env.debt(second), env.stored(second).issued);
    assert!(env.debt(second) > 0);

    // And is repaid by yield after it opened: two months.
    env.advance(MONTH);
    let half = env.debt(second);
    assert!(half > 0 && half < env.stored(second).issued);
    env.advance(MONTH + 1);
    assert_eq!(env.debt(second), 0);

    // Unlock pays Principal plus exactly the unconsumed yield.
    let before = env.token_balance(alice.token);
    let net_end = env.accrued(pos);
    env.unlock(&alice, pos).unwrap();
    let p = env.position(pos);
    let y1 = env.stored(second).yield_units;
    assert_eq!(
        p.free_yield + y0 + y1,
        net_end.net,
        "every unit accounted once"
    );
    assert_eq!(
        env.token_balance(alice.token) - before,
        10 * SOL + native::shares_for_units_floor(p.free_yield, env.rate()).unwrap()
    );
    env.check_invariants(&[pos]);
}

#[test]
fn returning_own_gemas_cancels_debt_and_frees_the_surplus_yield() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 2).unwrap();
    env.advance(MONTH);
    let debt = env.debt(source);
    assert!(debt > 0);
    // Returning part of the Debt keeps the Advance open.
    env.return_own(&alice, pos, source, debt / 2).unwrap();
    assert_eq!(env.position(pos).open_advance, Some(0));
    assert!(env.debt(source) > 0);
    // Returning the rest clears it, closes the Advance and banks the yield beyond.
    let rest = env.debt(source);
    env.return_own(&alice, pos, source, rest).unwrap();
    assert_eq!(env.debt(source), 0);
    let p = env.position(pos);
    assert_eq!(p.open_advance, None);
    assert_eq!(p.applied_net, env.accrued(pos).net);
    let y = env.stored(source).yield_units;
    assert_eq!(p.free_yield + y, p.applied_net);
    env.unlock(&alice, pos).expect("unlock after returning");
}

#[test]
fn only_the_owner_unlocks() {
    let mut env = Env::new();
    let alice = env.staker();
    let mallory = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH);
    let unlock = env.unlock_ix(&mallory, pos, mallory.token);
    assert!(env.send(&[unlock], &mallory.kp, &[]).is_err());
    // Nor can Alice route Principal to someone else's token account.
    let steal = env.unlock_ix(&alice, pos, mallory.token);
    let err = env.send(&[steal], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_INVALID_ACCOUNT);
    assert_eq!(env.token_balance(pos.vault), 10 * SOL);
}

// --- Pool totals ----------------------------------------------------------------------------

#[test]
fn pool_totals_stay_within_the_proven_bound_of_the_per_position_fees() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let carol = env.staker();
    let a = env.open(&alice, 10 * SOL).unwrap();
    env.advance(200);
    let b = env.open(&bob, 4 * SOL).unwrap();
    env.advance(300);
    let c = env.open(&carol, SOL + 777).unwrap();
    env.advance(2_345);

    let claim = |env: &Env, realised: u64, locked: &[Pos]| {
        let sum: u64 = locked.iter().map(|p| env.accrued(*p).fee).sum::<u64>() + realised;
        let earned = env
            .custody()
            .totals()
            .earned_fee(env.now(), sim_lst::DEFAULT_SPEEDUP)
            .unwrap();
        let n = locked.len() as u64;
        assert!(earned <= sum, "claim {earned} above the sum of fees {sum}");
        assert!(
            sum <= earned + 2 * n + 2,
            "claim {earned} below sum {sum} by more than the proven bound"
        );
        earned
    };
    claim(&env, 0, &[a, b, c]);

    // Bob unlocks; his fee is realised exactly and the claim does not drop.
    let before = claim(&env, 0, &[a, b, c]);
    let bob_fee = env.accrued(b).fee;
    env.unlock(&bob, b).unwrap();
    assert_eq!(env.custody().totals().realised_fee, bob_fee as u128);
    let after = claim(&env, bob_fee, &[a, c]);
    assert!(
        after + 4 >= before,
        "unlock moved the claim from {before} to {after}"
    );
    env.check_invariants(&[a, b, c]);

    env.advance(10_000);
    claim(&env, bob_fee, &[a, c]);
    let (a_fee, c_fee) = (env.accrued(a).fee, env.accrued(c).fee);
    env.unlock(&alice, a).unwrap();
    env.unlock(&carol, c).unwrap();
    let t = env.custody().totals();
    assert_eq!(
        (t.principal, t.fee_weight_time, t.open_positions),
        (0, 0, 0)
    );
    assert_eq!(t.realised_fee, (bob_fee + a_fee + c_fee) as u128);
}

// A fee change applies only to Positions opened afterwards (the Yield Fee is fixed at open).
#[test]
fn a_fee_change_never_applies_backwards() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let a = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, a, 1).unwrap();
    env.advance(300);
    let a_before = env.accrued(a);
    let debt_before = env.debt(source);
    env.init_treasury(1_000, INSTANT_FEE_BPS).unwrap();
    assert_eq!(env.accrued(a), a_before, "the past yield did not move");
    assert_eq!(env.debt(source), debt_before);
    assert_eq!(env.position(a).yield_fee_bps, 2_000);

    env.advance(100);
    let b = env.open(&bob, 4 * SOL).unwrap();
    assert_eq!(env.position(b).yield_fee_bps, 1_000);
    env.advance(2_000);
    let sum = env.accrued(a).fee + env.accrued(b).fee;
    let earned = env
        .custody()
        .totals()
        .earned_fee(env.now(), sim_lst::DEFAULT_SPEEDUP)
        .unwrap();
    assert!(earned <= sum, "claim {earned} above fee(A)+fee(B) {sum}");
    assert!(
        sum <= earned + 2 * 2 + 2,
        "claim {earned} too far below {sum}"
    );
    // The Advance is still repaid at its Horizon at A's own 20%.
    assert_eq!(env.debt(source), 0);
    // Unlock books each Position's own fee exactly.
    let (fa, fb) = (env.accrued(a).fee, env.accrued(b).fee);
    env.unlock(&alice, a).unwrap();
    env.unlock(&bob, b).unwrap();
    assert_eq!(env.custody().totals().realised_fee, (fa + fb) as u128);
}

// --- Validation -----------------------------------------------------------------------------

#[test]
fn unregistered_pool_and_mismatched_mint_are_rejected() {
    let mut env = Env::new();
    let alice = env.staker();

    // A copy of the Pool at another address, still owned by sim_lst: not the canonical PDA.
    let fake_pool = APk::new_unique();
    let real = env.svm.get_account(&s(env.pool)).unwrap();
    env.svm.set_account(s(fake_pool), real.clone()).unwrap();
    let (open, _) = env.open_ix_with(&alice, 90, SOL, fake_pool, env.mint);
    let err = env.send(&[open], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), CONSTRAINT_SEEDS);

    // The canonical address but owned by another program.
    let mut spoofed = real.clone();
    spoofed.owner = s(APk::new_unique());
    let saved = env.svm.get_account(&s(env.pool)).unwrap();
    env.svm.set_account(s(env.pool), spoofed).unwrap();
    let (open, _) = env.open_ix_with(&alice, 91, SOL, env.pool, env.mint);
    let err = env.send(&[open], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ACCOUNT_OWNED_BY_WRONG_PROGRAM);
    env.svm.set_account(s(env.pool), saved).unwrap();

    // A different mint than the pool's simSOL.
    let other_mint = APk::new_unique();
    let mint_acct = env.svm.get_account(&s(env.mint)).unwrap();
    env.svm.set_account(s(other_mint), mint_acct).unwrap();
    let (open, _) = env.open_ix_with(&alice, 92, SOL, env.pool, other_mint);
    let err = env.send(&[open], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_INVALID_MINT);

    // Nothing was deposited by any of them.
    assert_eq!(env.token_balance(alice.token), 10 * SOL);
    assert_eq!(env.custody().open_positions, 0);
}

#[test]
fn a_fake_pool_cannot_speed_up_or_stall_the_yield() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH);
    // A pool copy with a huge speedup at another address, passed in place of the real one.
    let fake = APk::new_unique();
    let mut acct = env.svm.get_account(&s(env.pool)).unwrap();
    // disc 8, admin 32, mint 32, base_rate 8, base_ts 8, apy 4, then speedup
    acct.data[92..96].copy_from_slice(&1_000_000u32.to_le_bytes());
    env.svm.set_account(s(fake), acct).unwrap();
    let mut unlock = env.unlock_ix(&alice, pos, alice.token);
    unlock.accounts[5].pubkey = s(fake);
    assert!(env.send(&[unlock], &alice.kp, &[]).is_err());
    let mut redeem = env.redeem_ix(&alice, pos, source, 699, alice.token);
    redeem.accounts[5].pubkey = s(fake);
    assert!(env.send(&[redeem], &alice.kp, &[]).is_err());
}

#[test]
fn the_oracle_can_neither_open_credit_nor_unlock_a_native_position() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    env.advance_native(&alice, pos, 1).unwrap();
    let oracle = env.oracle.insecure_clone();

    // Oracle-reported yield is refused for a native Position.
    let apply = tix(
        accounts::ApplyYield {
            oracle: a(oracle.pubkey()),
            config: pda(&[CONFIG_SEED]),
            position: pos.position,
            source: Some(env.source(pos, 0)),
        },
        instruction::ApplyYield {
            seq: 1,
            cumulative: 10 * SOL,
        },
        vec![],
    );
    let err = env.send(&[apply], &oracle, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_NATIVE_POSITION);

    // Oracle cannot mint a fake native Position over the simSOL mint either.
    let open = tix(
        accounts::OpenPosition {
            oracle: a(oracle.pubkey()),
            config: pda(&[CONFIG_SEED]),
            owner_account: alice.account,
            position: pda(&[POSITION_SEED, &[0], &[5; 32]]),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::OpenPosition {
            source_chain: ledger::SourceChain::Solana,
            position_id: [5; 32],
            source_asset: SIM_SOL_MINT,
            decimals: 9,
            principal: 10 * SOL,
            rate_bps: 700,
        },
        vec![],
    );
    let err = env.send(&[open], &oracle, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_NATIVE_POSITION);
}

#[test]
fn take_native_advance_rejects_an_oracle_position() {
    let mut env = Env::new();
    let alice = env.staker();
    let oracle = env.oracle.insecure_clone();
    let position = pda(&[POSITION_SEED, &[0], &[6; 32]]);
    let open = tix(
        accounts::OpenPosition {
            oracle: a(oracle.pubkey()),
            config: pda(&[CONFIG_SEED]),
            owner_account: alice.account,
            position,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::OpenPosition {
            source_chain: ledger::SourceChain::Solana,
            position_id: [6; 32],
            source_asset: APk::new_unique(),
            decimals: 9,
            principal: 10 * SOL,
            rate_bps: 700,
        },
        vec![],
    );
    env.send(&[open], &oracle, &[]).unwrap();
    let fake = Pos {
        position,
        custody: pda(&[NATIVE_SEED]),
        vault: pda(&[NATIVE_VAULT_SEED]),
    };
    let err = env.advance_native(&alice, fake, 1).unwrap_err();
    assert_eq!(code(&err), ERR_NOT_NATIVE);
}

#[test]
fn the_oracle_position_cannot_unlock_through_the_native_path_and_redeem_still_burns_only_there() {
    // A non-native Solana Position keeps the ledger path: unlock needs no native accounts.
    let mut env = Env::new();
    let alice = env.staker();
    let oracle = env.oracle.insecure_clone();
    let position = pda(&[POSITION_SEED, &[0], &[7; 32]]);
    let open = tix(
        accounts::OpenPosition {
            oracle: a(oracle.pubkey()),
            config: pda(&[CONFIG_SEED]),
            owner_account: alice.account,
            position,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::OpenPosition {
            source_chain: ledger::SourceChain::Solana,
            position_id: [7; 32],
            source_asset: APk::new_unique(),
            decimals: 9,
            principal: 10 * SOL,
            rate_bps: 700,
        },
        vec![],
    );
    env.send(&[open], &oracle, &[]).unwrap();
    let unlock = tix(
        accounts::Unlock {
            owner_authority: alice.key,
            owner_account: alice.account,
            position,
        },
        instruction::Unlock {},
        vec![],
    );
    env.send(&[unlock], &alice.kp, &[]).expect("ledger unlock");
}

// --- Randomized sequences -------------------------------------------------------------------

#[derive(Clone, Debug)]
enum Op {
    Time(i64),
    Redeem(u64),
    Advance(u8),
    ReturnOwn(u64),
    Unlock,
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        5 => (1i64..900).prop_map(Op::Time),
        4 => (1u64..=100).prop_map(Op::Redeem),
        2 => (1u8..=6).prop_map(Op::Advance),
        1 => (1u64..=100).prop_map(Op::ReturnOwn),
        1 => Just(Op::Unlock),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 12, ..ProptestConfig::default() })]

    #[test]
    fn invariants_hold_over_random_sequences(
        shares in 1u64..=10,
        head_start in 0i64..3_000,
        ops in proptest::collection::vec(op(), 1..14),
    ) {
        let mut env = Env::new();
        let alice = env.staker();
        env.advance(head_start);
        let pos = env.open(&alice, shares * SOL).unwrap();
        env.advance_native(&alice, pos, 2).unwrap();
        let base_supply = env.supply();

        for op in ops {
            let latest = env.position(pos).advances - 1;
            let source = env.source(pos, latest);
            match op {
                Op::Time(secs) => env.advance(secs),
                Op::Redeem(pct) => {
                    let held = env.gemas(&alice, source);
                    let amount = env.view(source).redeemable_for(held) * pct / 100;
                    if amount > 0 {
                        let _ = env.redeem(&alice, pos, source, amount);
                    }
                }
                Op::Advance(months) => {
                    let _ = env.advance_native(&alice, pos, months);
                }
                Op::ReturnOwn(pct) => {
                    let amount = (env.debt(source) * pct / 100).min(env.gemas(&alice, source));
                    if amount > 0 {
                        let _ = env.return_own(&alice, pos, source, amount);
                    }
                }
                Op::Unlock => {
                    let _ = env.unlock(&alice, pos);
                }
            }
            // Yield is minted only as paid, and never beyond what has accrued (net of the fee).
            let minted = env.supply() - base_supply;
            prop_assert!(minted <= env.accrued(pos).net, "minted {} accrued {}", minted, env.accrued(pos).net);
            prop_assert!(env.debt(source) <= env.stored(source).issued);
            env.check_invariants(&[pos]);
        }
    }
}

/// CU readings for the payouts (run with `--nocapture`).
#[test]
fn cu_profile_redeem_and_unlock() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH);
    env.redeem(&alice, pos, source, 699).unwrap();
    let redeem = env.last_cu;
    env.unlock(&alice, pos).unwrap();
    println!("CU redeem: {redeem}; unlock: {}", env.last_cu);
    assert!(redeem < 100_000 && env.last_cu < 120_000);
}

// --- Horizon --------------------------------------------------------------------------------

#[test]
fn an_advance_of_n_months_is_repaid_in_n_times_a_month_for_any_principal_and_rate() {
    for rate in [SOL, 3_720_000_000, 7_000 * SOL] {
        for months in [1u8, 3, 12] {
            let mut env = Env::new();
            set_pool_rate(&mut env, rate);
            let alice = env.staker();
            // Two Positions of very different size opened at the same moment.
            let mut positions = vec![];
            for shares in [2 * SOL, SOL / 4] {
                let pos = env.open(&alice, shares).unwrap();
                let source = env.advance_native(&alice, pos, months).unwrap();
                positions.push((pos, source));
            }
            let total = i64::from(months) * MONTH;
            let early = total / 10;
            env.advance(total - early);
            for (_, source) in &positions {
                assert!(env.debt(*source) > 0, "not repaid {early} s early");
            }
            env.advance(early + 1);
            for (_, source) in &positions {
                assert_eq!(
                    env.debt(*source),
                    0,
                    "rate {rate} months {months}: repaid at {} s",
                    total + 1
                );
            }
            let all: Vec<Pos> = positions.iter().map(|p| p.0).collect();
            env.check_invariants(&all);
        }
    }
}

/// Sets the pool's constant rate.
fn set_pool_rate(env: &mut Env, rate: u64) {
    let mut acct = env.svm.get_account(&s(env.pool)).expect("pool");
    // disc 8, admin 32, mint 32, then base_rate
    acct.data[72..80].copy_from_slice(&rate.to_le_bytes());
    env.svm.set_account(s(env.pool), acct).expect("set");
}

#[test]
fn the_rate_does_not_grow() {
    let mut env = Env::new();
    let before = env.rate();
    env.advance(30 * 24 * 3_600);
    assert_eq!(env.rate(), before);
}

#[test]
fn only_the_recorded_yield_authority_can_mint_yield() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, SOL).unwrap();
    for who in [
        &alice.kp,
        &env.admin.insecure_clone(),
        &env.oracle.insecure_clone(),
    ] {
        let ix = ix(
            sim_lst::ID,
            sim_lst::accounts::MintYield {
                authority: a(who.pubkey()),
                config: sim_pda(&[sim_lst::YIELD_SEED]),
                pool: env.pool,
                mint: env.mint,
                destination: pos.vault,
                token_program: TOKEN_PROGRAM_ID,
            },
            sim_lst::instruction::MintYield { shares: SOL },
            vec![],
        );
        let err = env.send(&[ix], who, &[]).expect_err("must be refused");
        assert_eq!(code(&err), 6000, "Unauthorized");
    }
    assert_eq!(env.token_balance(pos.vault), SOL);
}

// --- Extend ---------------------------------------------------------------------------------

#[test]
fn a_player_who_lost_the_gemas_extends_the_advance_and_unlocks_on_the_new_schedule() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let pos = env.open(&alice, 2 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 3).unwrap();
    let first = env.gemas(&alice, source);
    // Lost every Gema of the first Advance.
    env.give_won(&alice, &bob, source, first);
    assert_eq!(env.gemas(&alice, source), 0);
    // Not owner-signed, wrong months and the cap are refused.
    assert!(env.extend_native(&bob, pos, source, 1).is_err());
    assert!(env.extend_native(&alice, pos, source, 0).is_err());
    assert!(env.extend_native(&alice, pos, source, 10).is_err());
    env.advance(MONTH);
    env.extend_native(&alice, pos, source, 3).unwrap();
    // Three more months of the same Source, at the same price, as own Gemas.
    assert_eq!(env.gemas(&alice, source), first);
    let src = env.stored(source);
    assert_eq!((src.horizon_months, src.issued), (6, 2 * first));
    // Not yet repaid at 6 months minus a tenth; repaid at 6 months and a second.
    let total = 6 * MONTH;
    env.advance(total - MONTH - total / 10);
    assert!(env.debt(source) > 0);
    assert!(env.unlock(&alice, pos).is_err());
    env.advance(total / 10 + 1);
    assert_eq!(env.debt(source), 0);
    env.unlock(&alice, pos).unwrap();
    env.check_invariants(&[pos]);
}

const DAY: i64 = 24 * 60 * 60;

/// Yield at real speed, so a day passes without the Advance being repaid.
fn slow_clock(env: &mut Env) {
    let mut acct = env.svm.get_account(&s(env.pool)).expect("pool");
    // disc 8, admin 32, mint 32, base_rate 8, base_ts 8, apy 4, then speedup
    acct.data[92..96].copy_from_slice(&1u32.to_le_bytes());
    env.svm.set_account(s(env.pool), acct).expect("set");
}

fn lost_advance(env: &mut Env, alice: &Person) -> (Pos, APk) {
    slow_clock(env);
    let bob = env.staker();
    let pos = env.open(alice, 2 * SOL).unwrap();
    let source = env.advance_native(alice, pos, 3).unwrap();
    let first = env.gemas(alice, source);
    env.give_won(alice, &bob, source, first);
    (pos, source)
}

#[test]
fn extend_waits_a_day_between_extends_and_stops_at_the_extend_limit() {
    let mut env = Env::new();
    let alice = env.staker();
    let (pos, source) = lost_advance(&mut env, &alice);
    env.extend_native(&alice, pos, source, 1).unwrap();
    let limit = env.load::<ExtendLimitState>(env.extend_limit(&alice));
    assert_eq!((limit.inner.months, limit.inner.window_months), (3, 1));
    // Inside 24 h of the last Extend.
    env.advance(DAY - 1);
    assert!(env.extend_native(&alice, pos, source, 1).is_err());
    // Exactly a day later it goes through, and fills the limit of 3.
    env.advance(1);
    env.extend_native(&alice, pos, source, 2).unwrap();
    assert_eq!(env.stored(source).horizon_months, 6);
    env.advance(DAY);
    assert!(env.extend_native(&alice, pos, source, 1).is_err());
}

#[test]
fn a_lower_extend_limit_applies_at_once_and_a_raise_a_day_later() {
    let mut env = Env::new();
    let alice = env.staker();
    let (pos, source) = lost_advance(&mut env, &alice);
    // More than 11 is refused.
    assert!(env.set_extend_limit(&alice, 12).is_err());
    // Raising: pending for a day, so a 4-month Extend still fails.
    env.set_extend_limit(&alice, 5).unwrap();
    assert!(env.extend_native(&alice, pos, source, 4).is_err());
    env.advance(DAY);
    env.extend_native(&alice, pos, source, 4).unwrap();
    // Lowering to 0 stops Extend at once, even after the wait.
    env.advance(DAY);
    env.set_extend_limit(&alice, 0).unwrap();
    assert!(env.extend_native(&alice, pos, source, 1).is_err());
}

#[test]
fn extend_is_refused_without_an_open_advance_and_after_repayment() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 2 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH + 1);
    assert_eq!(env.debt(source), 0);
    let err = env.extend_native(&alice, pos, source, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::AdvanceRepaid));
}

#[test]
fn an_extend_keeps_the_yield_already_counted() {
    let mut env = Env::new();
    let alice = env.staker();
    let (pos, source) = lost_advance(&mut env, &alice);
    env.advance(MONTH);
    let before = env.view(source).yield_units;
    assert!(before > 0);
    env.extend_native(&alice, pos, source, 3).unwrap();
    // The Source now records the yield counted so far; it never drops.
    assert!(env.stored(source).yield_units >= before);
    assert!(env.debt(source) > 0);
}

fn pda_bump(seeds: &[&[u8]]) -> u8 {
    APk::find_program_address(seeds, &tesoro_core::ID).1
}

impl Env {
    /// Overwrites a program-owned account (test setup only).
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

// --- Yield Fee, Instant Redeem and the Treasury (ADR 0007) -----------------------------------

impl Env {
    fn treasury_vault(&self) -> APk {
        pda(&[TREASURY_VAULT_SEED])
    }
    fn treasury(&self) -> Treasury {
        self.load::<Treasury>(pda(&[TREASURY_SEED]))
    }
    fn treasury_holding(&self, source: APk) -> APk {
        pda(&[HOLDING_SEED, treasury_account().as_ref(), source.as_ref()])
    }

    /// Moves `n` of `from`'s own Gemas of `source` to `to` as won Gemas, as after a Match
    /// (settlement itself is covered in integration.rs).
    fn give_won(&mut self, from: &Person, to: &Person, source: APk, n: u64) {
        let mut from_account = self.load::<TesoroAccount>(from.account);
        let mut from_holding = self.load::<HoldingState>(self.holding(from, source));
        from_holding
            .inner
            .debit(&mut from_account.inner, n)
            .unwrap();
        let mut to_account = self.load::<TesoroAccount>(to.account);
        let to_key = self.holding(to, source);
        let mut to_holding = match self.svm.get_account(&s(to_key)) {
            Some(_) => self.load::<HoldingState>(to_key),
            None => HoldingState {
                bump: pda_bump(&[HOLDING_SEED, to.account.as_ref(), source.as_ref()]),
                account: to.account,
                inner: ledger::Holding::new(source.to_bytes(), false),
            },
        };
        to_holding.inner.credit(&mut to_account.inner, n).unwrap();
        let from_key = self.holding(from, source);
        self.write(from.account, &from_account, TesoroAccount::SPACE);
        self.write(from_key, &from_holding, HoldingState::SPACE);
        self.write(to.account, &to_account, TesoroAccount::SPACE);
        self.write(to_key, &to_holding, HoldingState::SPACE);
    }

    fn fund_treasury(&mut self, shares: u64) -> Result<(), Failed> {
        let admin = self.admin.insecure_clone();
        let admin_token = get_associated_token_address(&a(admin.pubkey()), &self.mint);
        // The faucet cooldown moves the clock; funding must not age the Positions under test.
        let clock = self.now();
        let mut faucets = 0;
        while self.token_balance(admin_token) < shares {
            let faucet = ix(
                sim_lst::ID,
                sim_lst::accounts::Faucet {
                    user: a(admin.pubkey()),
                    pool: self.pool,
                    mint: self.mint,
                    user_ata: admin_token,
                    claim: sim_pda(&[sim_lst::FAUCET_SEED, admin.pubkey().as_ref()]),
                    token_program: TOKEN_PROGRAM_ID,
                    associated_token_program: ATA_PROGRAM_ID,
                    system_program: anchor_lang::system_program::ID,
                },
                sim_lst::instruction::Faucet {},
                vec![],
            );
            self.send(&[faucet], &admin, &[]).expect("faucet");
            self.advance(3_600);
            faucets += 1;
            assert!(faucets < 20, "faucet loop");
        }
        self.set_time(clock);
        let fund = tix(
            accounts::FundTreasury {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                treasury: pda(&[TREASURY_SEED]),
                treasury_vault: self.treasury_vault(),
                admin_token,
                token_program: TOKEN_PROGRAM_ID,
            },
            instruction::FundTreasury { shares },
            vec![],
        );
        self.send(&[fund], &admin, &[])
    }

    fn set_company(&mut self, company: APk) -> Result<(), Failed> {
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
        self.send(&[set], &admin, &[])
    }

    fn withdraw_ix(&self, signer: APk, company_token: APk, amount: u64) -> Instruction {
        tix(
            accounts::WithdrawTreasury {
                admin: signer,
                config: pda(&[CONFIG_SEED]),
                treasury: pda(&[TREASURY_SEED]),
                treasury_vault: self.treasury_vault(),
                company_token,
                pool: self.pool,
                custody: pda(&[NATIVE_SEED]),
                mint: self.mint,
                yield_config: sim_pda(&[sim_lst::YIELD_SEED]),
                yield_authority: pda(&[YIELD_SEED]),
                sim_lst_program: sim_lst::ID,
                token_program: TOKEN_PROGRAM_ID,
            },
            instruction::WithdrawTreasury { amount },
            vec![],
        )
    }

    fn withdraw(&mut self, company_token: APk, amount: u64) -> Result<(), Failed> {
        let admin = self.admin.insecure_clone();
        let ix = self.withdraw_ix(a(admin.pubkey()), company_token, amount);
        self.send(&[ix], &admin, &[])
    }

    /// Yield Fee earned by the pool at the clock, in SOL units.
    fn earned_fee(&self) -> u64 {
        let custody = self.load::<NativeCustody>(pda(&[NATIVE_SEED]));
        let speedup = self.load::<sim_lst::Pool>(self.pool).speedup;
        custody.totals().earned_fee(self.now(), speedup).unwrap()
    }

    /// The Treasury balance in SOL units: unminted fee plus the vault at the rate.
    fn treasury_balance(&self) -> u64 {
        let unminted = self.earned_fee() - self.treasury().fee_minted;
        let vault =
            native::shares_value(self.token_balance(self.treasury_vault()), self.rate()).unwrap();
        unminted + vault
    }

    fn instant_redeem_ix(&self, p: &Person, pos: Pos, source: APk, amount: u64) -> Instruction {
        tix(
            accounts::InstantRedeem {
                holder_authority: p.key,
                holder_account: p.account,
                position: pos.position,
                source,
                holding: self.holding(p, source),
                treasury: pda(&[TREASURY_SEED]),
                treasury_account: treasury_account(),
                treasury_holding: self.treasury_holding(source),
                treasury_vault: self.treasury_vault(),
                holder_token: p.token,
                pool: self.pool,
                custody: pda(&[NATIVE_SEED]),
                mint: self.mint,
                yield_config: sim_pda(&[sim_lst::YIELD_SEED]),
                yield_authority: pda(&[YIELD_SEED]),
                sim_lst_program: sim_lst::ID,
                token_program: TOKEN_PROGRAM_ID,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InstantRedeem { amount },
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
            self.yield_mint(self.treasury_vault()),
        );
        self.send(&[redeem], payer, &[])
    }
}

#[test]
fn a_native_advance_is_80_percent_of_projected_yield() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 3).unwrap();
    // 10 SOL at 7% over 3 months = 0.175 SOL gross; 80% of it = 0.14 SOL; at $150 = $21 = 2,100.
    assert_eq!(env.gemas(&alice, source), 2_100);
    assert_eq!(env.load::<SourceState>(source).inner.issued, 2_100);
}

#[test]
fn the_treasury_is_set_up_once_and_its_rates_are_capped() {
    let mut env = Env::new();
    let t = env.treasury();
    assert_eq!((t.yield_fee_bps, t.instant_fee_bps), (2_000, 3_500));
    assert_eq!(t.account, treasury_account());
    assert_eq!(t.vault, env.treasury_vault());
    let account = env.load::<TesoroAccount>(treasury_account());
    assert_eq!(account.authority, pda(&[TREASURY_SEED]));
    // Re-running changes the rates and nothing else.
    env.init_treasury(1_000, 3_000).unwrap();
    let t = env.treasury();
    assert_eq!((t.yield_fee_bps, t.instant_fee_bps), (1_000, 3_000));
    let err = env.init_treasury(5_001, 3_500).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::InvalidBps));
    let err = env.init_treasury(2_000, 5_001).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::InvalidBps));
    // Only the admin.
    let mallory = env.person();
    let mut init = common_init_treasury(&env, mallory.key);
    init.accounts[0].is_signer = true;
    let err = env.send(&[init], &mallory.kp, &[]).unwrap_err();
    assert_eq!(code(&err), 6000);
}

fn common_init_treasury(env: &Env, admin: APk) -> Instruction {
    tix(
        accounts::InitTreasury {
            admin,
            config: pda(&[CONFIG_SEED]),
            treasury: pda(&[TREASURY_SEED]),
            treasury_account: treasury_account(),
            mint: env.mint,
            treasury_vault: env.treasury_vault(),
            token_program: TOKEN_PROGRAM_ID,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::InitTreasury {
            yield_fee_bps: 0,
            instant_fee_bps: 0,
        },
        vec![],
    )
}

#[test]
fn instant_redeem_pays_65_percent_from_the_treasury_and_hands_it_the_gemas() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 3).unwrap();
    env.give_won(&alice, &bob, source, 1_000);
    env.fund_treasury(SOL).unwrap();
    let source_before = env.load::<SourceState>(source).inner;

    let bob_before = env.token_balance(bob.token);
    env.instant_redeem(&bob, pos, source, 1_000)
        .expect("instant");
    // 1,000 Gemas at $150/SOL are worth 0.0666... SOL; Bob gets 65% of it now, in simSOL.
    let units = source_before.units_for(1_000).unwrap();
    let payout = units * 6_500 / 10_000;
    let shares = native::shares_for_units_floor(payout, env.rate()).unwrap();
    assert_eq!(env.token_balance(bob.token) - bob_before, shares);
    assert_eq!(env.token_balance(env.treasury_vault()), SOL - shares);
    assert_eq!(env.treasury().instant_units, payout);
    // The Gemas now belong to the Treasury Account, still of Alice's Source.
    assert_eq!(env.gemas(&bob, source), 0);
    let bought = env.load::<HoldingState>(env.treasury_holding(source));
    assert_eq!((bought.inner.amount, bought.inner.is_own), (1_000, false));
    assert_eq!(
        env.load::<TesoroAccount>(treasury_account())
            .inner
            .won_total,
        1_000
    );
    // Debt, the Source's counts and Alice's lock are untouched.
    assert_eq!(env.load::<SourceState>(source).inner, source_before);
    assert_eq!(env.position(pos).status, PositionStatus::Locked);
    env.check_invariants(&[pos]);
}

#[test]
fn instant_redeem_fails_cleanly_when_the_treasury_is_short() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    // A long Horizon, so most of Bob's Gemas are still pending after a month.
    let source = env.advance_native(&alice, pos, 12).unwrap();
    env.give_won(&alice, &bob, source, 1_000);
    // Empty treasury: refused, and nothing moved.
    let err = env.instant_redeem(&bob, pos, source, 1_000).unwrap_err();
    assert_eq!(code(&err), ERR_TREASURY_SHORT);
    assert_eq!(env.gemas(&bob, source), 1_000);
    assert!(env
        .svm
        .get_account(&s(env.treasury_holding(source)))
        .is_none());
    // A treasury holding less than the payout is still short.
    env.fund_treasury(1_000).unwrap();
    let err = env.instant_redeem(&bob, pos, source, 1_000).unwrap_err();
    assert_eq!(code(&err), ERR_TREASURY_SHORT);
    assert_eq!(env.gemas(&bob, source), 1_000);
    // Funding it fills it: then the same sale is paid.
    env.fund_treasury(SOL).unwrap();
    env.instant_redeem(&bob, pos, source, 100)
        .expect("paid once funded");
}

#[test]
fn instant_redeem_refuses_gemas_whose_yield_has_landed() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 12).unwrap();
    env.give_won(&alice, &bob, source, 1_000);
    env.fund_treasury(SOL).unwrap();
    env.advance(MONTH);
    let landed = env.view(source).redeemable_for(1_000);
    assert!(landed > 0 && landed < 1_000);
    let err = env.instant_redeem(&bob, pos, source, 1_000).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::ExceedsPending));
    assert_eq!(env.gemas(&bob, source), 1_000);
    env.instant_redeem(&bob, pos, source, 1_000 - landed)
        .expect("the pending part sells");
    assert_eq!(env.gemas(&bob, source), landed);
}

#[test]
fn only_won_gemas_are_redeemed_instantly() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 3).unwrap();
    env.fund_treasury(SOL).unwrap();
    let err = env.instant_redeem(&alice, pos, source, 100).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::NotWonGemas));
    assert_eq!(env.gemas(&alice, source), 2_100);
}

#[test]
fn the_treasury_balance_is_the_unminted_fee_plus_the_vault_and_pays_both_ways() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let company = env.staker();
    env.set_company(company.key).unwrap();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 3).unwrap();
    env.give_won(&alice, &bob, source, 60);
    env.advance(MONTH);
    let earned = env.earned_fee();
    assert!(earned > 1_000_000, "10 SOL at 7% pays a fee in a month");
    assert_eq!(env.treasury().fee_minted, 0);
    assert_eq!(env.token_balance(env.treasury_vault()), 0);
    assert_eq!(env.treasury_balance(), earned);
    let supply = env.supply();
    let company_before = env.token_balance(company.token);

    // Withdraw part of it: minted fresh, the vault stays empty.
    env.withdraw(company.token, earned / 2)
        .expect("withdraw half");
    let got = env.token_balance(company.token) - company_before;
    assert_eq!(
        got,
        native::shares_for_units_floor(earned / 2, env.rate()).unwrap()
    );
    assert_eq!(env.supply() - supply, got);
    let t = env.treasury();
    assert_eq!(t.withdrawn_units, earned / 2);
    assert!(t.fee_minted >= earned / 2 && t.fee_minted <= earned / 2 + 1);
    assert_eq!(env.token_balance(env.treasury_vault()), 0);

    // Instant Redeem draws from the same unminted fee.
    let bob_before = env.token_balance(bob.token);
    env.instant_redeem(&bob, pos, source, 30).expect("instant");
    assert!(env.token_balance(bob.token) > bob_before);
    assert!(env.treasury().fee_minted <= env.earned_fee());
    assert!(env.treasury().instant_units > 0);

    // Withdraw everything left: nothing more can be paid, in either direction.
    let rest = env.treasury_balance();
    env.withdraw(company.token, rest).expect("withdraw all");
    assert!(env.treasury_balance() <= 1);
    assert!(env.treasury().fee_minted <= env.earned_fee());
    let err = env.withdraw(company.token, SOL / 1_000).unwrap_err();
    assert_eq!(code(&err), ERR_TREASURY_SHORT);
    let err = env.instant_redeem(&bob, pos, source, 10).unwrap_err();
    assert_eq!(code(&err), ERR_TREASURY_SHORT);
    assert_eq!(env.gemas(&bob, source), 30);

    // Gemas the Treasury bought redeem later at full value and refill the vault.
    env.advance(3 * MONTH + 1);
    assert_eq!(env.debt(source), 0);
    let carol = env.staker();
    env.redeem_treasury(&carol.kp, pos, source, 30)
        .expect("refill");
    let refill = env.token_balance(env.treasury_vault());
    assert!(refill > 0);

    // The vault pays first: an Instant Redeem now leaves the minted-fee counter alone.
    let dave = env.staker();
    let pos2 = env.open(&dave, 10 * SOL).unwrap();
    let source2 = env.advance_native(&dave, pos2, 12).unwrap();
    env.give_won(&dave, &bob, source2, 10);
    let minted_before = env.treasury().fee_minted;
    env.instant_redeem(&bob, pos2, source2, 10)
        .expect("instant from the vault");
    assert_eq!(env.treasury().fee_minted, minted_before);
    assert!(env.token_balance(env.treasury_vault()) < refill);

    // Withdraw beyond fee + vault is refused; exactly the balance is paid.
    let balance = env.treasury_balance();
    let err = env
        .withdraw(company.token, balance + balance / 10 + 10)
        .unwrap_err();
    assert_eq!(code(&err), ERR_TREASURY_SHORT);
    env.withdraw(company.token, balance)
        .expect("withdraw the balance");
    assert!(env.treasury_balance() <= 1);
    assert!(env.treasury().fee_minted <= env.earned_fee());
}

#[test]
fn only_the_admin_withdraws_and_only_to_the_company_wallet() {
    let mut env = Env::new();
    let alice = env.staker();
    let company = env.staker();
    let mallory = env.staker();
    env.open(&alice, 10 * SOL).unwrap();
    env.advance(MONTH);
    let amount = env.earned_fee() / 2;
    // No company wallet set yet.
    let err = env.withdraw(company.token, amount).unwrap_err();
    assert_eq!(code(&err), 6000 + TesoroError::CompanyNotSet as u32);
    // Only the admin sets it.
    let mut set = tix(
        accounts::SetTreasuryCompany {
            admin: mallory.key,
            config: pda(&[CONFIG_SEED]),
            treasury: pda(&[TREASURY_SEED]),
        },
        instruction::SetTreasuryCompany {
            company: mallory.key,
        },
        vec![],
    );
    set.accounts[0].is_signer = true;
    let err = env.send(&[set], &mallory.kp, &[]).unwrap_err();
    assert_eq!(code(&err), 6000);
    env.set_company(company.key).unwrap();
    // Not the admin.
    let ix = env.withdraw_ix(mallory.key, mallory.token, amount);
    let err = env.send(&[ix], &mallory.kp, &[]).unwrap_err();
    assert_eq!(code(&err), 6000);
    // Not to another wallet, even as the admin.
    let err = env.withdraw(mallory.token, amount).unwrap_err();
    assert_eq!(code(&err), 6000 + TesoroError::InvalidAccount as u32);
    assert_eq!(env.treasury().fee_minted, 0);
    env.withdraw(company.token, amount)
        .expect("the admin pays the company");
}

/// Withdrawing at many points in time never takes more than the fee the Positions earned plus
/// what was put into the vault, and `fee_minted` never passes the earned fee.
#[test]
fn withdrawals_never_exceed_the_earned_fee_plus_the_vault() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let company = env.staker();
    env.set_company(company.key).unwrap();
    env.fund_treasury(SOL / 10).unwrap();
    env.open(&alice, 10 * SOL).unwrap();
    env.open(&bob, 7 * SOL).unwrap();
    let funded = env.token_balance(env.treasury_vault());
    let mut seed = 0x9E37_79B9_7F4A_7C15u64;
    let mut paid_units = 0u64;
    for _ in 0..40 {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        env.advance(((seed >> 40) % 300) as i64 + 1);
        let balance = env.treasury_balance();
        let ask = (balance as u128 * ((seed >> 20) % 130) as u128 / 100) as u64 + 1;
        match env.withdraw(company.token, ask) {
            Ok(()) => {
                assert!(ask <= balance, "paid {ask} above the balance {balance}");
                paid_units += ask;
            }
            Err(e) => {
                assert_eq!(code(&e), ERR_TREASURY_SHORT);
                assert!(
                    ask > balance || ask < 2,
                    "refused {ask} within the balance {balance}"
                );
            }
        }
        let t = env.treasury();
        assert!(t.fee_minted <= env.earned_fee());
        let funded_units = native::shares_value(funded, env.rate()).unwrap();
        assert!(paid_units <= env.earned_fee() + funded_units);
    }
    assert!(paid_units > 0);
}

#[test]
fn the_treasury_redeems_what_it_bought_at_full_value_and_refills_its_vault() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let carol = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    let issued = env.gemas(&alice, source);
    env.give_won(&alice, &bob, source, 400);
    env.give_won(&alice, &carol, source, 200);
    env.fund_treasury(SOL).unwrap();
    env.instant_redeem(&bob, pos, source, 400).unwrap();
    let after_instant = env.token_balance(env.treasury_vault());

    // Nothing is redeemable before the yield lands.
    let err = env.redeem_treasury(&carol.kp, pos, source, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::ExceedsRedeemable));

    env.advance(MONTH + 1);
    assert_eq!(env.debt(source), 0);
    let full = env.view(source).units_for(400).unwrap();
    // Anyone may call it; the minted simSOL can only go to the treasury vault.
    env.redeem_treasury(&carol.kp, pos, source, 400)
        .expect("treasury redeems");
    let refill = env.token_balance(env.treasury_vault()) - after_instant;
    assert_eq!(
        refill,
        native::shares_for_units_floor(full, env.rate()).unwrap()
    );
    assert_eq!(
        env.load::<HoldingState>(env.treasury_holding(source))
            .inner
            .amount,
        0
    );
    let paid = native::shares_for_units_floor(full * 6_500 / 10_000, env.rate()).unwrap();
    assert!(
        refill > paid,
        "the Treasury gets back more than the 65% it paid"
    );
    // Paying into anyone else's account is refused.
    let redirected = tix(
        accounts::RedeemTreasury {
            treasury: pda(&[TREASURY_SEED]),
            treasury_account: treasury_account(),
            position: pos.position,
            source,
            treasury_holding: env.treasury_holding(source),
        },
        instruction::RedeemTreasury { amount: 1 },
        env.yield_mint(carol.token),
    );
    assert!(env.send(&[redirected], &carol.kp, &[]).is_err());

    // Normal Redeem is unchanged for everyone else: Carol redeems her won Gemas, Alice her own.
    let carol_before = env.token_balance(carol.token);
    env.redeem(&carol, pos, source, 200).expect("carol redeems");
    let units = env.stored(source).units_for(200).unwrap();
    assert_eq!(
        env.token_balance(carol.token) - carol_before,
        native::shares_for_units_floor(units, env.rate()).unwrap()
    );
    env.redeem(&alice, pos, source, issued - 600)
        .expect("alice redeems");
    env.check_invariants(&[pos]);
}

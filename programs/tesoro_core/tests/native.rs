//! Solana-native Positions against the real `sim_lst` program (both built by
//! `pnpm build:programs`): custody, the permissionless yield crank, payouts, and the vault
//! invariants, plus a randomized sequence test that reads every invariant back from chain state.
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
use tesoro_core::ledger::{self, native, PositionStatus};
use tesoro_core::state::*;
use tesoro_core::{accounts, instruction};

const SOL: u64 = 1_000_000_000;
const T0: i64 = 1_000_000;
/// $150 per SOL, micro-USD.
const PRICE: u64 = 150_000_000;
/// One month of yield takes 600 s, but the pool accrues simple interest per 30-day month while the
/// Advance projects 1/12 of a year, so a Horizon of one month is repaid a little after 600 s.
const MONTH: i64 = 610;

const ERR_INVALID_ACCOUNT: u32 = 6003;
const ERR_BAD_REMAINING: u32 = 6004;
const ERR_INVALID_MINT: u32 = 6008;
const ERR_NATIVE_POSITION: u32 = 6009;
const ERR_NOT_NATIVE: u32 = 6010;
const ERR_STALE_PRICE: u32 = 6011;
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

/// A native Position and the addresses around it.
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
        env.set_price(PRICE).expect("price");
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
        let custody = pda(&[NATIVE_SEED, position.as_ref()]);
        let vault = pda(&[NATIVE_VAULT_SEED, position.as_ref()]);
        let open = tix(
            accounts::OpenNativePosition {
                owner_authority: p.key,
                owner_account: p.account,
                pool,
                mint,
                owner_token: p.token,
                position,
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

    fn advance_native(&mut self, p: &Person, pos: Pos, months: u8) -> Result<APk, Failed> {
        let index = self.load::<PositionState>(pos.position).inner.advances;
        let source = self.source(pos, index);
        let advance = tix(
            accounts::TakeNativeAdvance {
                owner_authority: p.key,
                owner_account: p.account,
                position: pos.position,
                price_feed: pda(&[PRICE_SEED, SIM_SOL_MINT.as_ref()]),
                source,
                holding: self.holding(p, source),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::TakeNativeAdvance {
                horizon_months: months,
            },
            vec![],
        );
        self.send(&[advance], &p.kp, &[]).map(|_| source)
    }

    /// Anyone may crank; `payer` only pays the fee.
    fn crank(&mut self, payer: &Keypair, pos: Pos) -> Result<(), Failed> {
        let p = self.load::<PositionState>(pos.position).inner;
        let source = p.open_advance.map(|index| self.source(pos, index));
        let crank = tix(
            accounts::AccrueNativeYield {
                position: pos.position,
                custody: pos.custody,
                vault: pos.vault,
                pool: self.pool,
                source,
            },
            instruction::AccrueNativeYield {},
            vec![],
        );
        self.send(&[crank], payer, &[])
    }

    fn redeem_ix(&self, p: &Person, pos: Pos, source: APk, amount: u64, dest: APk) -> Instruction {
        tix(
            accounts::Redeem {
                holder_authority: p.key,
                holder_account: p.account,
                position: pos.position,
                source,
                holding: self.holding(p, source),
            },
            instruction::Redeem { amount },
            vec![
                rem(pos.custody, true),
                rem(pos.vault, true),
                rem(dest, true),
                rem(self.pool, false),
                rem(TOKEN_PROGRAM_ID, false),
            ],
        )
    }

    fn redeem(&mut self, p: &Person, pos: Pos, source: APk, amount: u64) -> Result<(), Failed> {
        let redeem = self.redeem_ix(p, pos, source, amount, p.token);
        self.send(&[redeem], &p.kp, &[])
    }

    fn unlock_ix(&self, p: &Person, pos: Pos, dest: APk) -> Instruction {
        tix(
            accounts::Unlock {
                owner_authority: p.key,
                owner_account: p.account,
                position: pos.position,
            },
            instruction::Unlock {},
            vec![
                rem(pos.custody, true),
                rem(pos.vault, true),
                rem(dest, true),
                rem(self.pool, false),
                rem(TOKEN_PROGRAM_ID, false),
            ],
        )
    }

    fn unlock(&mut self, p: &Person, pos: Pos) -> Result<(), Failed> {
        let unlock = self.unlock_ix(p, pos, p.token);
        self.send(&[unlock], &p.kp, &[])
    }

    fn sweep(&mut self, p: &Person, pos: Pos) -> Result<(), Failed> {
        let sweep = tix(
            accounts::SweepNativeSurplus {
                owner_authority: p.key,
                owner_account: p.account,
                position: pos.position,
                custody: pos.custody,
                vault: pos.vault,
                owner_token: p.token,
                pool: self.pool,
                token_program: TOKEN_PROGRAM_ID,
            },
            instruction::SweepNativeSurplus {},
            vec![],
        );
        self.send(&[sweep], &p.kp, &[])
    }

    fn position(&self, pos: Pos) -> ledger::Position {
        self.load::<PositionState>(pos.position).inner
    }
    fn custody(&self, pos: Pos) -> NativeCustody {
        self.load::<NativeCustody>(pos.custody)
    }
    fn debt(&self, source: APk) -> u64 {
        self.load::<SourceState>(source).inner.debt()
    }
    fn gemas(&self, p: &Person, source: APk) -> u64 {
        self.load::<HoldingState>(self.holding(p, source))
            .inner
            .amount
    }

    /// The custody invariants, read back from chain state.
    fn check_invariants(&self, pos: Pos) {
        let position = self.position(pos);
        let custody = self.custody(pos);
        let vault = self.token_balance(pos.vault);
        let rate = self.rate();
        assert!(
            native::check_cover(vault, &position, custody.redeemed_units, rate).is_ok(),
            "vault {vault} does not cover principal + owed yield"
        );
        assert!(
            custody.redeemed_units <= position.cumulative_yield,
            "paid more than accrued"
        );
        if position.status == PositionStatus::Locked {
            assert!(
                native::shares_value(vault, rate).unwrap() >= position.principal,
                "principal shares left before unlock"
            );
        }
    }
}

// --- Custody --------------------------------------------------------------------------------

#[test]
fn open_moves_simsol_into_a_program_vault_and_records_principal_in_sol() {
    let mut env = Env::new();
    let alice = env.staker();
    env.advance(MONTH);
    let rate = env.rate();
    let pos = env.open(&alice, 10 * SOL).expect("open");

    assert_eq!(env.token_balance(alice.token), 0);
    assert_eq!(env.token_balance(pos.vault), 10 * SOL);
    let position = env.position(pos);
    assert_eq!(
        position.principal,
        native::shares_value(10 * SOL, rate).unwrap()
    );
    assert_eq!(position.source_asset, SIM_SOL_MINT.to_bytes());
    assert_eq!(position.rate_bps, 700);
    assert_eq!(position.owner, alice.account.to_bytes());
    let custody = env.custody(pos);
    assert_eq!(custody.rate_at_open, rate);
    assert_eq!(custody.deposited_shares, 10 * SOL);
    assert_eq!(custody.vault, pos.vault);
    // The vault is owned by the custody PDA, not by the staker.
    let vault =
        spl_token::state::Account::unpack(&env.svm.get_account(&s(pos.vault)).unwrap().data)
            .unwrap();
    assert_eq!(vault.owner.to_bytes(), pos.custody.to_bytes());
    env.check_invariants(pos);
}

#[test]
fn advance_is_priced_by_the_feed_and_owner_signs_alone() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).expect("advance");
    // 10 SOL at 7% for one month = 0.058333333 SOL = 874 Gemas (floored) at $150.
    assert_eq!(env.gemas(&alice, source), 874);
    assert_eq!(env.debt(source), 874);
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
    let index = 0;
    let source = env.source(pos, index);
    let advance = tix(
        accounts::TakeNativeAdvance {
            owner_authority: mallory.key,
            owner_account: mallory.account,
            position: pos.position,
            price_feed: pda(&[PRICE_SEED, SIM_SOL_MINT.as_ref()]),
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

/// F-05 (open, needs a decision). The vault's SPL balance is the yield source, so anybody can add
/// simSOL to it directly. The crank then reads that as accrued yield and repays Debt, which is a
/// top-up paying Debt (ADR 0001 says Principal never does). This test pins the CURRENT behaviour;
/// when custody tracks its own share count, flip the assertion to `debt == 874`.
#[test]
fn f05_known_issue_donating_simsol_to_the_vault_repays_debt() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    assert_eq!(env.debt(source), 874);
    let donor = env.staker();
    // Plain SPL Token transfer (instruction 3) straight into the vault.
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
    env.crank(&donor.kp, pos).expect("crank");
    assert_eq!(env.debt(source), 0, "no time passed, yet Debt was repaid");
}

// --- Yield crank ----------------------------------------------------------------------------

#[test]
fn anyone_can_crank_and_yield_repays_debt() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    let cranker = env.person();

    // Nothing accrued yet: a no-op, not an error.
    env.crank(&cranker.kp, pos).expect("no-op crank");
    assert_eq!(env.position(pos).cumulative_yield, 0);
    assert_eq!(env.debt(source), 874);

    // Half a month of yield repays about half of the Debt.
    env.advance(300);
    env.crank(&cranker.kp, pos).expect("crank");
    let position = env.position(pos);
    let expected = native::accrued_yield(10 * SOL, env.rate(), 0, position.principal).unwrap();
    assert_eq!(position.cumulative_yield, expected);
    let debt = env.debt(source);
    assert!(debt > 0 && debt < 874, "debt {debt}");

    // Past the Horizon the Debt is gone and the Position has no open Advance.
    env.advance(MONTH);
    env.crank(&cranker.kp, pos).expect("crank");
    assert_eq!(env.debt(source), 0);
    assert!(env.position(pos).open_advance.is_none());
    env.check_invariants(pos);
}

#[test]
fn crank_is_idempotent_and_monotonic() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    env.advance_native(&alice, pos, 3).unwrap();
    let cranker = env.person();
    env.advance(400);
    env.crank(&cranker.kp, pos).unwrap();
    let after_first = env.svm.get_account(&s(pos.position)).unwrap().data;
    let source_after_first = env.svm.get_account(&s(env.source(pos, 0))).unwrap().data;
    // Same clock: cranking again changes nothing, byte for byte.
    env.crank(&cranker.kp, pos).unwrap();
    env.crank(&cranker.kp, pos).unwrap();
    assert_eq!(
        env.svm.get_account(&s(pos.position)).unwrap().data,
        after_first
    );
    assert_eq!(
        env.svm.get_account(&s(env.source(pos, 0))).unwrap().data,
        source_after_first
    );
    let first = env.position(pos).cumulative_yield;
    env.advance(100);
    env.crank(&cranker.kp, pos).unwrap();
    assert!(env.position(pos).cumulative_yield > first);
}

#[test]
fn yield_without_an_advance_is_free_yield_for_the_owner() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let cranker = env.person();
    env.advance(MONTH);
    env.crank(&cranker.kp, pos).unwrap();
    let position = env.position(pos);
    assert!(position.free_yield > 0);
    assert_eq!(position.free_yield, position.cumulative_yield);
    // It is not payable through the ledger claim: unlock returns it with the surplus.
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

// --- Payouts --------------------------------------------------------------------------------

#[test]
fn redeem_pays_simsol_worth_the_accrued_yield_and_never_touches_principal() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    let cranker = env.person();

    // Nothing is redeemable before any yield accrues.
    let err = env.redeem(&alice, pos, source, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::ExceedsRedeemable));

    env.advance(MONTH);
    env.crank(&cranker.kp, pos).unwrap();
    let before_vault = env.token_balance(pos.vault);
    env.redeem(&alice, pos, source, 874).expect("redeem all");

    // 874 Gemas = 58_266_666 lamports of SOL, paid as simSOL at the current rate (rounded down).
    let paid = env.token_balance(alice.token);
    let expected = native::shares_for_units_floor(58_266_666, env.rate()).unwrap();
    assert_eq!(paid, expected);
    assert_eq!(env.token_balance(pos.vault), before_vault - paid);
    assert_eq!(env.custody(pos).redeemed_units, 58_266_666);
    assert_eq!(env.gemas(&alice, source), 0);
    // Principal is intact: the vault still backs it at the current rate.
    let position = env.position(pos);
    assert!(
        native::shares_value(env.token_balance(pos.vault), env.rate()).unwrap()
            >= position.principal
    );
    env.check_invariants(pos);
}

#[test]
fn payouts_are_bounded_by_accrued_yield() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    let cranker = env.person();
    env.advance(300);
    env.crank(&cranker.kp, pos).unwrap();
    let redeemable = env.load::<SourceState>(source).inner.redeemable();
    assert!(redeemable > 0 && redeemable < 874);
    let err = env.redeem(&alice, pos, source, redeemable + 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::ExceedsRedeemable));
    env.redeem(&alice, pos, source, redeemable).unwrap();
    // A second redeem of the same yield finds nothing left.
    let err = env.redeem(&alice, pos, source, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::ExceedsRedeemable));
    let paid_units = env.custody(pos).redeemed_units;
    assert!(paid_units <= env.position(pos).cumulative_yield);
    env.check_invariants(pos);
}

#[test]
fn redeem_needs_the_native_accounts_and_pays_only_the_holder() {
    let mut env = Env::new();
    let alice = env.staker();
    let mallory = env.person();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH);
    env.crank(&alice.kp, pos).unwrap();

    // Without the payout accounts the legacy call cannot burn Gemas for nothing.
    let legacy = tix(
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
    let err = env.send(&[legacy], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_REMAINING);
    assert_eq!(env.gemas(&alice, source), 874);

    // The destination must belong to the holder.
    let steal = env.redeem_ix(&alice, pos, source, 100, mallory.token);
    env.faucet(&mallory).unwrap();
    let err = env.send(&[steal], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_INVALID_ACCOUNT);
}

#[test]
fn a_non_owner_holder_redeems_won_gemas_from_the_vault() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();

    // Bob holds 100 of Alice's Gemas, as after winning them in a Match (settlement itself is
    // covered in integration.rs): move them between the two Holdings directly.
    let mut alice_account = env.load::<TesoroAccount>(alice.account);
    let mut alice_holding = env.load::<HoldingState>(env.holding(&alice, source));
    alice_holding
        .inner
        .debit(&mut alice_account.inner, 100)
        .unwrap();
    let mut bob_account = env.load::<TesoroAccount>(bob.account);
    let mut bob_holding = HoldingState {
        bump: pda_bump(&[HOLDING_SEED, bob.account.as_ref(), source.as_ref()]),
        account: bob.account,
        inner: ledger::Holding::new(source.to_bytes(), false),
    };
    bob_holding
        .inner
        .credit(&mut bob_account.inner, 100)
        .unwrap();
    let alice_holding_key = env.holding(&alice, source);
    let bob_holding_key = env.holding(&bob, source);
    env.write(alice.account, &alice_account, TesoroAccount::SPACE);
    env.write(alice_holding_key, &alice_holding, HoldingState::SPACE);
    env.write(bob.account, &bob_account, TesoroAccount::SPACE);
    env.write(bob_holding_key, &bob_holding, HoldingState::SPACE);

    env.advance(MONTH);
    env.crank(&alice.kp, pos).unwrap();
    let bob_before = env.token_balance(bob.token);
    env.redeem(&bob, pos, source, 100).expect("bob redeems");
    let units = env
        .load::<SourceState>(source)
        .inner
        .units_for(100)
        .unwrap();
    assert_eq!(
        env.token_balance(bob.token) - bob_before,
        native::shares_for_units_floor(units, env.rate()).unwrap()
    );
    env.check_invariants(pos);
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

// --- Unlock ---------------------------------------------------------------------------------

#[test]
fn unlock_needs_zero_debt_and_returns_principal_shares_to_the_owner() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();

    // Debt is open: principal cannot leave.
    let err = env.unlock(&alice, pos).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::DebtOutstanding));
    assert_eq!(env.token_balance(pos.vault), 10 * SOL);

    env.advance(MONTH);
    env.crank(&alice.kp, pos).unwrap();
    env.redeem(&alice, pos, source, 874).unwrap();
    let redeemed_shares = env.token_balance(alice.token);
    env.unlock(&alice, pos).expect("unlock");

    assert_eq!(env.position(pos).status, PositionStatus::Unlocked);
    // Everything went back to the owner but one share of rounding dust reserved for the
    // sub-Gema remainder of the Source's yield.
    assert!(env.token_balance(pos.vault) <= 1);
    assert_eq!(
        env.token_balance(alice.token) + env.token_balance(pos.vault),
        10 * SOL
    );
    assert!(env.token_balance(alice.token) > redeemed_shares);
    // The owner ends with at least the SOL value of the Principal plus all the yield.
    assert!(
        native::shares_value(env.token_balance(alice.token), env.rate()).unwrap()
            >= env.position(pos).principal
    );
    env.check_invariants(pos);
}

#[test]
fn unlock_keeps_the_yield_owed_to_other_holders_in_the_vault_until_they_redeem() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH);
    env.crank(&alice.kp, pos).unwrap();
    // Alice redeems nothing and unlocks: the yield owed on her 874 unredeemed Gemas stays put.
    env.unlock(&alice, pos).expect("unlock");
    let rate = env.rate();
    let reserve = env.token_balance(pos.vault);
    let owed = native::owed_units(&env.position(pos), 0).unwrap();
    assert_eq!(reserve, native::shares_for_units_ceil(owed, rate).unwrap());
    assert!(reserve > 0);
    env.check_invariants(pos);

    // Later, at a higher rate, redeeming still works and is covered.
    env.advance(3_600);
    env.redeem(&alice, pos, source, 874)
        .expect("redeem after unlock");
    assert!(env.token_balance(pos.vault) < reserve);
    env.check_invariants(pos);

    // The rest (rounded reserve growth) is swept back to the owner, and nothing owed remains.
    env.sweep(&alice, pos).expect("sweep");
    assert!(env.token_balance(pos.vault) <= 1);
    assert_eq!(
        env.token_balance(alice.token) + env.token_balance(pos.vault),
        10 * SOL
    );
}

#[test]
fn only_the_owner_unlocks_or_sweeps() {
    let mut env = Env::new();
    let alice = env.staker();
    let mallory = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    env.advance_native(&alice, pos, 1).unwrap();
    // Mallory (with her own Account) tries to sweep or unlock Alice's Position.
    let unlock = env.unlock_ix(&mallory, pos, mallory.token);
    assert!(env.send(&[unlock], &mallory.kp, &[]).is_err());
    let sweep = tix(
        accounts::SweepNativeSurplus {
            owner_authority: mallory.key,
            owner_account: mallory.account,
            position: pos.position,
            custody: pos.custody,
            vault: pos.vault,
            owner_token: mallory.token,
            pool: env.pool,
            token_program: TOKEN_PROGRAM_ID,
        },
        instruction::SweepNativeSurplus {},
        vec![],
    );
    assert!(env.send(&[sweep], &mallory.kp, &[]).is_err());
    assert_eq!(env.token_balance(pos.vault), 10 * SOL);
}

#[test]
fn sweeping_while_locked_is_refused() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let err = env.sweep(&alice, pos).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::PositionLocked));
    assert_eq!(env.token_balance(pos.vault), 10 * SOL);
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
        custody: APk::default(),
        vault: APk::default(),
    };
    let err = env.advance_native(&alice, fake, 1).unwrap_err();
    assert_eq!(code(&err), ERR_NOT_NATIVE);
}

// --- Randomized sequences -------------------------------------------------------------------

#[derive(Clone, Debug)]
enum Op {
    Time(i64),
    Crank,
    Redeem(u64),
    Advance(u8),
    ReturnOwn(u64),
    Unlock,
    Sweep,
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => (1i64..900).prop_map(Op::Time),
        4 => Just(Op::Crank),
        4 => (1u64..=100).prop_map(Op::Redeem),
        2 => (1u8..=6).prop_map(Op::Advance),
        1 => (1u64..=100).prop_map(Op::ReturnOwn),
        1 => Just(Op::Unlock),
        1 => Just(Op::Sweep),
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
        let deposit = shares * SOL;
        let pos = env.open(&alice, deposit).unwrap();
        env.advance_native(&alice, pos, 2).unwrap();
        let cranker = env.person();
        let total = |env: &Env| env.token_balance(alice.token) + env.token_balance(pos.vault);
        prop_assert_eq!(total(&env), 10 * SOL);

        for op in ops {
            let before_cum = env.position(pos).cumulative_yield;
            let before_paid = env.custody(pos).redeemed_units;
            let latest = env.position(pos).advances - 1;
            let source = env.source(pos, latest);
            match op {
                Op::Time(secs) => env.advance(secs),
                Op::Crank => {
                    let _ = env.crank(&cranker.kp, pos);
                    // Idempotent: a second crank at the same time changes nothing.
                    let snap = env.svm.get_account(&s(pos.position)).unwrap().data;
                    let vault = env.svm.get_account(&s(pos.vault)).unwrap().data;
                    let _ = env.crank(&cranker.kp, pos);
                    prop_assert_eq!(env.svm.get_account(&s(pos.position)).unwrap().data, snap);
                    prop_assert_eq!(env.svm.get_account(&s(pos.vault)).unwrap().data, vault);
                }
                Op::Redeem(pct) => {
                    let held = env.gemas(&alice, source);
                    let redeemable = env.load::<SourceState>(source).inner.redeemable_for(held);
                    let amount = redeemable * pct / 100;
                    if amount > 0 {
                        let _ = env.redeem(&alice, pos, source, amount);
                    }
                }
                Op::Advance(months) => {
                    let _ = env.advance_native(&alice, pos, months);
                }
                Op::ReturnOwn(pct) => {
                    let debt = env.debt(source);
                    let amount = (debt * pct / 100).min(env.gemas(&alice, source));
                    if amount > 0 {
                        let ret = tix(
                            accounts::ReturnOwn {
                                owner_authority: alice.key,
                                owner_account: alice.account,
                                position: pos.position,
                                source,
                                holding: env.holding(&alice, source),
                            },
                            instruction::ReturnOwn { amount },
                            vec![],
                        );
                        let _ = env.send(&[ret], &alice.kp, &[]);
                    }
                }
                Op::Unlock => {
                    let _ = env.unlock(&alice, pos);
                }
                Op::Sweep => {
                    let _ = env.sweep(&alice, pos);
                }
            }
            let position = env.position(pos);
            // Yield is monotonic and never exceeds what the vault produced.
            prop_assert!(position.cumulative_yield >= before_cum);
            prop_assert!(env.custody(pos).redeemed_units >= before_paid);
            // Shares are conserved: they are in the vault or in the owner's wallet.
            prop_assert_eq!(total(&env), 10 * SOL);
            env.check_invariants(pos);
        }
    }
}

/// CU reading for the crank (run with `--nocapture`; recorded in docs/security/audit-2026-09-30.md).
#[test]
fn cu_profile_accrue_native_yield() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    let _ = source;
    env.advance(300);
    let cranker = env.person();
    env.crank(&cranker.kp, pos).unwrap();
    let with_debt = env.last_cu;
    env.advance(MONTH);
    env.crank(&cranker.kp, pos).unwrap();
    println!(
        "CU accrue_native_yield partial repay: {with_debt}; final repay: {}",
        env.last_cu
    );
    assert!(with_debt < 100_000 && env.last_cu < 100_000);
}

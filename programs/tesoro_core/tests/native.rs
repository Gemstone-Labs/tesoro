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
                treasury: pda(&[TREASURY_SEED]),
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
                mint: self.mint,
                yield_config: sim_pda(&[sim_lst::YIELD_SEED]),
                yield_authority: pda(&[YIELD_SEED]),
                sim_lst_program: sim_lst::ID,
                token_program: TOKEN_PROGRAM_ID,
                treasury: pda(&[TREASURY_SEED]),
                treasury_vault: pda(&[TREASURY_VAULT_SEED]),
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
            custody.tracked_shares <= vault,
            "tracked shares exceed the vault balance"
        );
        assert!(
            native::check_cover(
                custody.tracked_shares,
                &position,
                custody.redeemed_units,
                rate
            )
            .is_ok(),
            "tracked shares {} do not cover principal + owed yield",
            custody.tracked_shares
        );
        assert!(
            custody.redeemed_units <= position.cumulative_yield,
            "paid more than accrued"
        );
        if position.status == PositionStatus::Locked {
            assert!(
                native::shares_value(custody.tracked_shares, rate).unwrap() >= position.principal,
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
    let index = 0;
    let source = env.source(pos, index);
    let advance = tix(
        accounts::TakeNativeAdvance {
            owner_authority: mallory.key,
            owner_account: mallory.account,
            position: pos.position,
            price_feed: pda(&[PRICE_SEED, SIM_SOL_MINT.as_ref()]),
            treasury: pda(&[TREASURY_SEED]),
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

/// F-05. The vault's SPL balance used to be the yield source, so anybody could add simSOL to it and
/// the crank counted that as accrued yield and repaid Debt: a top-up paying Debt, which ADR 0001
/// forbids. Custody now counts its own shares (`tracked_shares`), so a direct transfer is not yield.
fn donate(env: &mut Env, donor: &Person, pos: Pos, amount: u64) {
    // Plain SPL Token transfer (instruction 3) straight into the vault.
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
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
}

#[test]
fn f05_donating_simsol_to_the_vault_does_not_repay_debt() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    assert_eq!(env.debt(source), 699);
    let donor = env.staker();
    donate(&mut env, &donor, pos, SOL);
    env.crank(&donor.kp, pos).expect("crank");
    assert_eq!(env.debt(source), 699, "a top-up must not repay Debt");
    assert_eq!(env.position(pos).cumulative_yield, 0);
    assert_eq!(env.custody(pos).tracked_shares, 10 * SOL);
    assert_eq!(env.token_balance(pos.vault), 11 * SOL);

    // Real yield still counts, and only on the tracked shares.
    env.advance(300);
    env.crank(&donor.kp, pos).expect("crank");
    let expected = native::accrued_yield(
        env.custody(pos).tracked_shares,
        env.rate(),
        0,
        env.position(pos).principal,
    )
    .unwrap();
    assert_eq!(env.position(pos).cumulative_yield, expected);
    env.check_invariants(pos);
}

#[test]
fn f05_a_donation_is_not_redeemable_and_returns_to_the_owner_at_unlock() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    let donor = env.staker();
    donate(&mut env, &donor, pos, SOL);
    env.advance(MONTH);
    env.crank(&donor.kp, pos).unwrap();
    assert_eq!(env.debt(source), 0);
    // Redeeming everything accrued never touches the donated shares, and the cover check ignores them.
    env.redeem(&alice, pos, source, 699).expect("redeem");
    env.check_invariants(pos);
    env.unlock(&alice, pos).expect("unlock");
    let custody = env.custody(pos);
    assert_eq!(
        custody.tracked_shares,
        env.token_balance(pos.vault),
        "the donation left with the surplus"
    );
    env.check_invariants(pos);
}

fn migrate_ix(env: &Env, payer: &Person, pos: Pos) -> Instruction {
    let _ = env;
    tix(
        accounts::MigrateNativeCustody {
            payer: payer.key,
            position: pos.position,
            custody: pos.custody,
            vault: pos.vault,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::MigrateNativeCustody {},
        vec![],
    )
}

/// Rewrites the custody as it looked before the upgrade (no `tracked_shares`).
fn make_legacy(env: &mut Env, pos: Pos) {
    let mut acct = env.svm.get_account(&s(pos.custody)).expect("custody");
    acct.data.truncate(NativeCustody::LEGACY_SPACE);
    env.svm.set_account(s(pos.custody), acct).expect("set");
}

/// Custodies opened before `tracked_shares` have the old, shorter layout: they cannot be read until
/// `migrate_native_custody` extends them, which anybody can call.
#[test]
fn f05_migration_extends_a_legacy_custody() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    make_legacy(&mut env, pos);
    let cranker = env.person();
    assert!(
        env.crank(&cranker.kp, pos).is_err(),
        "legacy layout is unreadable until migrated"
    );

    let ix = migrate_ix(&env, &cranker, pos);
    env.send(&[ix], &cranker.kp, &[]).expect("migrate");
    assert_eq!(env.custody(pos).tracked_shares, 10 * SOL);
    assert_eq!(
        env.svm.get_account(&s(pos.custody)).unwrap().data.len(),
        NativeCustody::SPACE
    );
    // Once migrated it is a normal custody, and migrating twice is refused.
    let ix = migrate_ix(&env, &cranker, pos);
    assert!(env.send(&[ix], &cranker.kp, &[]).is_err());
    env.advance(300);
    env.crank(&cranker.kp, pos).expect("crank");
    assert!(env.debt(source) < 699);
    env.check_invariants(pos);
}

/// The migration cannot be used to launder a top-up made before it: the count is capped by what was
/// deposited at open.
#[test]
fn f05_migration_caps_the_count_at_the_deposit() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let donor = env.staker();
    donate(&mut env, &donor, pos, 5 * SOL);
    make_legacy(&mut env, pos);
    let ix = migrate_ix(&env, &donor, pos);
    env.send(&[ix], &donor.kp, &[]).expect("migrate");
    assert_eq!(env.custody(pos).tracked_shares, 10 * SOL);
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
    assert_eq!(env.debt(source), 699);

    // Half a month of yield repays about half of the Debt.
    env.advance(300);
    env.crank(&cranker.kp, pos).expect("crank");
    let position = env.position(pos);
    let expected = native::accrued_yield(
        env.custody(pos).tracked_shares,
        env.rate(),
        0,
        position.principal,
    )
    .unwrap();
    assert_eq!(position.cumulative_yield, expected);
    let debt = env.debt(source);
    assert!(debt > 0 && debt < 699, "debt {debt}");

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
    env.redeem(&alice, pos, source, 699).expect("redeem all");

    // 699 Gemas = 46_600_000 lamports of SOL, paid as simSOL at the current rate (rounded down).
    let paid = env.token_balance(alice.token);
    let expected = native::shares_for_units_floor(46_600_000, env.rate()).unwrap();
    assert_eq!(paid, expected);
    assert_eq!(env.token_balance(pos.vault), before_vault - paid);
    assert_eq!(env.custody(pos).redeemed_units, 46_600_000);
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
    assert!(redeemable > 0 && redeemable < 699);
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
    assert_eq!(env.gemas(&alice, source), 699);

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
    env.redeem(&alice, pos, source, 699).unwrap();
    let redeemed_shares = env.token_balance(alice.token);
    env.unlock(&alice, pos).expect("unlock");

    assert_eq!(env.position(pos).status, PositionStatus::Unlocked);
    // Everything went back to the owner but one share of rounding dust reserved for the
    // sub-Gema remainder of the Source's yield.
    assert!(env.token_balance(pos.vault) <= 1);
    assert_eq!(
        env.token_balance(alice.token)
            + env.token_balance(pos.vault)
            + env.token_balance(env.treasury_vault()),
        env.supply()
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
    // Alice redeems nothing and unlocks: the yield owed on her 699 unredeemed Gemas stays put.
    env.unlock(&alice, pos).expect("unlock");
    let rate = env.rate();
    let reserve = env.token_balance(pos.vault);
    let owed = native::owed_units(&env.position(pos), 0).unwrap();
    assert_eq!(reserve, native::shares_for_units_ceil(owed, rate).unwrap());
    assert!(reserve > 0);
    env.check_invariants(pos);

    // Later, at a higher rate, redeeming still works and is covered.
    env.advance(3_600);
    env.redeem(&alice, pos, source, 699)
        .expect("redeem after unlock");
    assert!(env.token_balance(pos.vault) < reserve);
    env.check_invariants(pos);

    // The rest (rounded reserve growth) is swept back to the owner, and nothing owed remains.
    env.sweep(&alice, pos).expect("sweep");
    assert!(env.token_balance(pos.vault) <= 1);
    assert_eq!(
        env.token_balance(alice.token)
            + env.token_balance(pos.vault)
            + env.token_balance(env.treasury_vault()),
        env.supply()
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
        let total = |env: &Env| {
            env.token_balance(alice.token)
                + env.token_balance(pos.vault)
                + env.token_balance(env.treasury_vault())
        };
        prop_assert_eq!(total(&env), env.supply());

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
            prop_assert_eq!(total(&env), env.supply());
            env.check_invariants(pos);
        }
    }
}

/// CU reading for the crank (run with `--nocapture`).
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

// --- Per-Position yield (docs/yield-model.md) -------------------------------------------------

/// Sets the pool's constant rate, as a devnet pool that grew under the old model and was then
/// checkpointed.
fn set_pool_rate(env: &mut Env, rate: u64) {
    let mut acct = env.svm.get_account(&s(env.pool)).expect("pool");
    // disc 8, admin 32, mint 32, then base_rate
    acct.data[72..80].copy_from_slice(&rate.to_le_bytes());
    env.svm.set_account(s(env.pool), acct).expect("set");
}

fn mint_yield_ix(env: &Env, authority: APk, destination: APk, shares: u64) -> Instruction {
    ix(
        sim_lst::ID,
        sim_lst::accounts::MintYield {
            authority,
            config: sim_pda(&[sim_lst::YIELD_SEED]),
            pool: env.pool,
            mint: env.mint,
            destination,
            token_program: TOKEN_PROGRAM_ID,
        },
        sim_lst::instruction::MintYield { shares },
        vec![],
    )
}

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
            for (pos, source) in &positions {
                env.crank(&alice.kp, *pos).unwrap();
                assert!(env.debt(*source) > 0, "not repaid {early} s early");
                env.check_invariants(*pos);
            }
            env.advance(early + 1);
            for (pos, source) in &positions {
                env.crank(&alice.kp, *pos).unwrap();
                assert_eq!(
                    env.debt(*source),
                    0,
                    "rate {rate} months {months}: repaid at {} s",
                    total + 1
                );
                env.check_invariants(*pos);
            }
        }
    }
}

#[test]
fn the_rate_does_not_grow() {
    let mut env = Env::new();
    let before = env.rate();
    env.advance(30 * 24 * 3_600);
    assert_eq!(env.rate(), before);
}

#[test]
fn yield_accrues_linearly_on_the_principal_and_is_minted_into_the_vault() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    assert_eq!(env.custody(pos).last_accrual_ts, T0);
    env.advance(MONTH);
    env.crank(&alice.kp, pos).unwrap();
    // 7% a year over one simulated month on 10 SOL, minted as simSOL at rate 1.0: the Yield Fee
    // (20%) into the treasury vault, the rest into the Position's vault.
    let gross = 10 * SOL * 700 / 10_000 / 12;
    let fee = gross * u64::from(YIELD_FEE_BPS) / 10_000;
    let expected = gross - fee;
    let custody = env.custody(pos);
    assert_eq!(custody.tracked_shares, 10 * SOL + expected);
    assert_eq!(env.token_balance(pos.vault), 10 * SOL + expected);
    assert_eq!(env.token_balance(env.treasury_vault()), fee);
    assert_eq!(env.treasury().fee_units, fee);
    assert_eq!(custody.last_accrual_ts, T0 + MONTH);
    assert_eq!(env.position(pos).cumulative_yield, expected);
    // Cranking again in the same second mints nothing more.
    env.crank(&alice.kp, pos).unwrap();
    assert_eq!(env.token_balance(pos.vault), 10 * SOL + expected);
    assert_eq!(env.token_balance(env.treasury_vault()), fee);
}

#[test]
fn yield_that_rounds_to_zero_shares_carries_its_time() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 1_000).unwrap();
    env.advance(1);
    env.crank(&alice.kp, pos).unwrap();
    assert_eq!(
        env.custody(pos).last_accrual_ts,
        T0,
        "time kept until a share is due"
    );
    assert_eq!(env.token_balance(pos.vault), 1_000);
    env.advance(3_600_000);
    env.crank(&alice.kp, pos).unwrap();
    assert!(env.token_balance(pos.vault) > 1_000);
}

#[test]
fn nothing_accrues_after_unlock() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH + 1);
    env.crank(&alice.kp, pos).unwrap();
    assert_eq!(env.debt(source), 0);
    env.redeem(&alice, pos, source, 699).expect("redeem");
    env.unlock(&alice, pos).expect("unlock");
    let shares = env.custody(pos).tracked_shares;
    env.advance(10 * MONTH);
    env.crank(&alice.kp, pos).unwrap();
    assert_eq!(env.custody(pos).tracked_shares, shares);
    env.check_invariants(pos);
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
        let ix = mint_yield_ix(&env, a(who.pubkey()), pos.vault, SOL);
        let err = env.send(&[ix], who, &[]).expect_err("must be refused");
        assert_eq!(code(&err), 6000, "Unauthorized");
    }
    assert_eq!(env.token_balance(pos.vault), SOL);
}

#[test]
fn the_crank_only_calls_the_real_sim_lst() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, SOL).unwrap();
    env.advance(MONTH);
    let mut ix = tix(
        accounts::AccrueNativeYield {
            position: pos.position,
            custody: pos.custody,
            vault: pos.vault,
            pool: env.pool,
            mint: env.mint,
            yield_config: sim_pda(&[sim_lst::YIELD_SEED]),
            yield_authority: pda(&[YIELD_SEED]),
            sim_lst_program: anchor_lang::system_program::ID,
            token_program: TOKEN_PROGRAM_ID,
            treasury: pda(&[TREASURY_SEED]),
            treasury_vault: pda(&[TREASURY_VAULT_SEED]),
            source: None,
        },
        instruction::AccrueNativeYield {},
        vec![],
    );
    assert!(env.send(&[ix.clone()], &alice.kp, &[]).is_err());
    // A mint other than the custody's is refused too.
    ix.accounts[4].pubkey = s(pos.vault);
    assert!(env.send(&[ix], &alice.kp, &[]).is_err());
    assert_eq!(env.token_balance(pos.vault), SOL);
}

/// Rewrites the custody as it was after F-05 and before the per-Position yield (no `last_accrual_ts`).
fn make_tracked_only(env: &mut Env, pos: Pos) {
    let mut acct = env.svm.get_account(&s(pos.custody)).expect("custody");
    acct.data.truncate(NativeCustody::TRACKED_SPACE);
    env.svm.set_account(s(pos.custody), acct).expect("set");
}

#[test]
fn migration_of_a_pre_upgrade_custody_starts_earning_at_the_new_rate_from_now() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    make_tracked_only(&mut env, pos);
    let cranker = env.person();
    assert!(
        env.crank(&cranker.kp, pos).is_err(),
        "unreadable until migrated"
    );

    env.advance(5_000); // the upgrade lands long after the custody was opened
    let migrate = migrate_ix(&env, &cranker, pos);
    env.send(&[migrate], &cranker.kp, &[]).expect("migrate");
    let custody = env.custody(pos);
    assert_eq!(
        custody.tracked_shares,
        10 * SOL,
        "tracked count carried over"
    );
    assert_eq!(custody.last_accrual_ts, T0 + 5_000);
    let migrate = migrate_ix(&env, &cranker, pos);
    assert!(
        env.send(&[migrate], &cranker.kp, &[]).is_err(),
        "twice is refused"
    );

    // No back pay for the 5,000 s before the migration, then the schedule runs from there.
    env.crank(&cranker.kp, pos).unwrap();
    assert_eq!(env.token_balance(pos.vault), 10 * SOL);
    env.advance(MONTH + 1);
    env.crank(&cranker.kp, pos).unwrap();
    assert_eq!(env.debt(source), 0);
    env.check_invariants(pos);
}

#[test]
fn migration_still_accepts_the_original_layout() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    make_legacy(&mut env, pos);
    let cranker = env.person();
    let migrate = migrate_ix(&env, &cranker, pos);
    env.send(&[migrate], &cranker.kp, &[]).expect("migrate");
    let custody = env.custody(pos);
    assert_eq!(custody.tracked_shares, 10 * SOL);
    assert_eq!(custody.last_accrual_ts, T0);
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
            vec![
                rem(pos.custody, true),
                rem(pos.vault, true),
                rem(self.treasury_vault(), true),
                rem(self.pool, false),
                rem(TOKEN_PROGRAM_ID, false),
            ],
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
    env.check_invariants(pos);
}

#[test]
fn instant_redeem_fails_cleanly_when_the_treasury_is_short() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 3).unwrap();
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
    // Yield Fees fill it: after a month of Alice's yield the treasury pays.
    env.advance(MONTH);
    env.crank(&alice.kp, pos).unwrap();
    assert!(env.token_balance(env.treasury_vault()) > 1_000);
    env.instant_redeem(&bob, pos, source, 100)
        .expect("paid from fees");
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
    env.crank(&alice.kp, pos).unwrap();
    assert_eq!(env.debt(source), 0);
    let fees = env.token_balance(env.treasury_vault()) - after_instant;
    let full = env
        .load::<SourceState>(source)
        .inner
        .units_for(400)
        .unwrap();
    // Anyone may crank it; the simSOL can only go to the treasury vault.
    env.redeem_treasury(&carol.kp, pos, source, 400)
        .expect("treasury redeems");
    let refill = env.token_balance(env.treasury_vault()) - after_instant - fees;
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
        vec![
            rem(pos.custody, true),
            rem(pos.vault, true),
            rem(carol.token, true),
            rem(env.pool, false),
            rem(TOKEN_PROGRAM_ID, false),
        ],
    );
    assert!(env.send(&[redirected], &carol.kp, &[]).is_err());

    // Normal Redeem is unchanged for everyone else: Carol redeems her won Gemas, Alice her own.
    let carol_before = env.token_balance(carol.token);
    env.redeem(&carol, pos, source, 200).expect("carol redeems");
    let units = env
        .load::<SourceState>(source)
        .inner
        .units_for(200)
        .unwrap();
    assert_eq!(
        env.token_balance(carol.token) - carol_before,
        native::shares_for_units_floor(units, env.rate()).unwrap()
    );
    env.redeem(&alice, pos, source, issued - 600)
        .expect("alice redeems");
    env.check_invariants(pos);
}

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
#[derive(Clone, Copy, Debug)]
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
                invite_gate: invite_gate_pda(),
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

    /// The published APY of a real token Position's mint, passed as a remaining account; simSOL
    /// Positions pass nothing.
    fn apy_remaining(&self, pos: Pos) -> Vec<AccountMeta> {
        let state = self.load::<PositionState>(pos.position);
        if state.inner.source_asset == SIM_SOL_MINT.to_bytes() {
            return vec![];
        }
        vec![rem(
            pda(&[TOKEN_APY_SEED, &state.inner.source_asset]),
            false,
        )]
    }

    fn advance_native(&mut self, p: &Person, pos: Pos, months: u8) -> Result<APk, Failed> {
        let state = self.load::<PositionState>(pos.position);
        let source = self.source(pos, state.inner.advances);
        // The feed of the Position's own token when one is set, else the simSOL feed.
        let own_feed = pda(&[PRICE_SEED, &state.inner.source_asset]);
        let feed = if self.svm.get_account(&s(own_feed)).is_some() {
            own_feed
        } else {
            pda(&[PRICE_SEED, SIM_SOL_MINT.as_ref()])
        };
        let advance = tix(
            accounts::TakeNativeAdvance {
                owner_authority: p.key,
                owner_account: p.account,
                protections: pda(&[PROTECTIONS_SEED, p.account.as_ref()]),
                position: pos.position,
                price_feed: feed,
                treasury: pda(&[TREASURY_SEED]),
                source,
                holding: self.holding(p, source),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::TakeNativeAdvance {
                horizon_months: months,
            },
            self.apy_remaining(pos),
        );
        self.send(&[advance], &p.kp, &[]).map(|_| source)
    }

    fn protect(&mut self, p: &Person, ix_data: Vec<u8>) -> Result<(), Failed> {
        let set = Instruction {
            program_id: s(tesoro_core::ID),
            accounts: accounts::SetProtection {
                owner_authority: p.key,
                owner_account: p.account,
                protections: pda(&[PROTECTIONS_SEED, p.account.as_ref()]),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None)
            .into_iter()
            .map(|m| AccountMeta {
                pubkey: s(m.pubkey),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
            data: ix_data,
        };
        self.send(&[set], &p.kp, &[])
    }

    fn take_break(&mut self, p: &Person, days: u16) -> Result<(), Failed> {
        self.protect(p, instruction::SetBreak { days }.data())
    }

    fn self_exclude(&mut self, p: &Person, months: u16) -> Result<(), Failed> {
        self.protect(p, instruction::SetSelfExclusion { months }.data())
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
                protections: pda(&[PROTECTIONS_SEED, p.account.as_ref()]),
                position: pos.position,
                treasury: pda(&[TREASURY_SEED]),
                source,
                holding: self.holding(p, source),
                extend_limit: self.extend_limit(p),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::ExtendNativeAdvance { extra_months },
            self.apy_remaining(pos),
        );
        self.send(&[extend], &p.kp, &[])
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
            protections: pda(&[PROTECTIONS_SEED, mallory.account.as_ref()]),
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
    env.crank(&alice.kp, pos).unwrap();
    env.extend_native(&alice, pos, source, 3).unwrap();
    // Three more months of the same Source, at the same price, as own Gemas.
    assert_eq!(env.gemas(&alice, source), first);
    let src = env.load::<SourceState>(source).inner;
    assert_eq!((src.horizon_months, src.issued), (6, 2 * first));
    env.check_invariants(pos);
    // Not yet repaid at 6 months minus a tenth; repaid at 6 months and a second.
    let total = 6 * MONTH;
    env.advance(total - MONTH - total / 10);
    env.crank(&alice.kp, pos).unwrap();
    assert!(env.debt(source) > 0);
    assert!(env.unlock(&alice, pos).is_err());
    env.advance(total / 10 + 1);
    env.crank(&alice.kp, pos).unwrap();
    assert_eq!(env.debt(source), 0);
    env.check_invariants(pos);
    env.unlock(&alice, pos).unwrap();
}

const DAY: i64 = 24 * 60 * 60;

fn lost_advance(env: &mut Env, alice: &Person) -> (Pos, APk) {
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
    assert_eq!(env.load::<SourceState>(source).inner.horizon_months, 6);
    env.advance(DAY);
    assert!(env.extend_native(&alice, pos, source, 1).is_err());
    env.check_invariants(pos);
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
    env.crank(&alice.kp, pos).unwrap();
    assert_eq!(env.debt(source), 0);
    assert!(env.extend_native(&alice, pos, source, 1).is_err());
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
    // Yield Fees fill it: after a month of Alice's yield the treasury pays.
    env.advance(MONTH);
    env.crank(&alice.kp, pos).unwrap();
    assert!(env.token_balance(env.treasury_vault()) > 1_000);
    env.instant_redeem(&bob, pos, source, 100)
        .expect("paid from fees");
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
    env.crank(&alice.kp, pos).unwrap();
    let landed = env.load::<SourceState>(source).inner.redeemable_for(1_000);
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

// --- The staking token is a setting ---------------------------------------------------------

fn sol_source() -> APk {
    pda(&[SOL_SOURCE_SEED])
}

fn set_sol_source_ix(signer: APk, mint: APk, pool: APk) -> Instruction {
    tix(
        accounts::SetSolSource {
            admin: signer,
            config: pda(&[CONFIG_SEED]),
            sol_source: sol_source(),
            mint,
            pool,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::SetSolSource {},
        vec![],
    )
}

fn set_sol_source(env: &mut Env, mint: APk, pool: APk) -> Result<(), Failed> {
    let admin = env.admin.insecure_clone();
    let set = set_sol_source_ix(a(admin.pubkey()), mint, pool);
    env.send(&[set], &admin, &[])
}

/// A bare SPL mint account, standing in for a second staking token.
fn plant_mint(env: &mut Env) -> APk {
    let key = APk::new_unique();
    let mint = spl_token::state::Mint {
        mint_authority: None.into(),
        supply: 0,
        decimals: 9,
        is_initialized: true,
        freeze_authority: None.into(),
    };
    let mut data = vec![0u8; spl_token::state::Mint::LEN];
    spl_token::state::Mint::pack(mint, &mut data).unwrap();
    env.svm
        .set_account(
            s(key),
            solana_sdk::account::Account {
                lamports: SOL / 100,
                data,
                owner: s(TOKEN_PROGRAM_ID),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    key
}

fn open_with_source(env: &mut Env, p: &Person, shares: u64) -> Result<Pos, Failed> {
    let nonce = env.next_nonce;
    env.next_nonce += 1;
    let (mut open, pos) = env.open_ix_with(p, nonce, shares, env.pool, env.mint);
    open.accounts.push(rem(sol_source(), false));
    env.send(&[open], &p.kp, &[]).map(|_| pos)
}

#[test]
fn only_the_admin_sets_the_staking_token() {
    let mut env = Env::new();
    let mallory = env.person();
    let (mint, pool) = (env.mint, env.pool);
    let set = set_sol_source_ix(mallory.key, mint, pool);
    let err = env.send(&[set], &mallory.kp, &[]).unwrap_err();
    assert_eq!(code(&err), 6000, "Unauthorized");
    assert!(env.svm.get_account(&s(sol_source())).is_none());

    set_sol_source(&mut env, mint, pool).expect("admin sets it");
    let setting = env.load::<SolSource>(sol_source());
    assert_eq!((setting.mint, setting.pool), (mint, pool));
}

#[test]
fn a_native_position_opens_with_the_active_token_and_is_marked_native() {
    let mut env = Env::new();
    let alice = env.staker();
    let (mint, pool) = (env.mint, env.pool);
    set_sol_source(&mut env, mint, pool).unwrap();
    let pos = open_with_source(&mut env, &alice, 10 * SOL).expect("open");

    assert_eq!(env.position(pos).source_asset, mint.to_bytes());
    assert_eq!(env.custody(pos).mint, mint);
    assert_eq!(env.custody(pos).pool, pool);
    let data = env.svm.get_account(&s(pos.position)).unwrap().data;
    assert!(PositionState::has_native_marker(&data));
    env.advance_native(&alice, pos, 1)
        .expect("native gates pass");
}

#[test]
fn a_position_keeps_its_token_after_the_active_token_changes() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let (mint, pool) = (env.mint, env.pool);
    set_sol_source(&mut env, mint, pool).unwrap();
    let pos = open_with_source(&mut env, &alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();

    let other_mint = plant_mint(&mut env);
    let other_pool = APk::new_unique();
    set_sol_source(&mut env, other_mint, other_pool).expect("switch");
    assert_eq!(env.load::<SolSource>(sol_source()).mint, other_mint);

    // The new token is not what an opening with the old pool carries.
    let err = open_with_source(&mut env, &bob, SOL).expect_err("refused");
    assert_eq!(code(&err), ERR_INVALID_MINT);
    // The oracle cannot register the new token as a Solana Position either.
    let nonce = 9u8;
    let mut oracle_open = tix(
        accounts::OpenPosition {
            oracle: a(env.oracle.pubkey()),
            config: pda(&[CONFIG_SEED]),
            owner_account: bob.account,
            position: pda(&[POSITION_SEED, &[0], &[nonce; 32]]),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::OpenPosition {
            source_chain: ledger::SourceChain::Solana,
            position_id: [nonce; 32],
            source_asset: other_mint,
            decimals: 9,
            principal: SOL,
            rate_bps: 700,
        },
        vec![],
    );
    oracle_open.accounts.push(rem(sol_source(), false));
    let oracle = env.oracle.insecure_clone();
    let err = env.send(&[oracle_open], &oracle, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_NATIVE_POSITION);

    // The earlier Position still carries and uses its own token end to end.
    assert_eq!(env.position(pos).source_asset, mint.to_bytes());
    assert_eq!(env.custody(pos).mint, mint);
    env.advance(MONTH);
    env.crank(&alice.kp, pos).expect("crank");
    env.redeem(&alice, pos, source, 699).expect("redeem");
    env.unlock(&alice, pos).expect("unlock");
    assert_eq!(env.position(pos).status, PositionStatus::Unlocked);
}

#[test]
fn changing_the_active_token_leaves_an_existing_treasury_vault_alone() {
    let mut env = Env::new();
    // The Treasury exists with a simSOL vault: re-running init with another active token (and the
    // setting passed) only changes the fee rates.
    let other_mint = plant_mint(&mut env);
    set_sol_source(&mut env, other_mint, APk::new_unique()).unwrap();
    env.init_treasury(1_000, 2_500).expect("fee change");

    let treasury = env.load::<Treasury>(pda(&[TREASURY_SEED]));
    assert_eq!(treasury.yield_fee_bps, 1_000);
    assert_eq!(env.token_balance(treasury.vault), 0);
    let vault =
        spl_token::state::Account::unpack(&env.svm.get_account(&s(treasury.vault)).unwrap().data)
            .unwrap();
    assert_eq!(vault.mint.to_bytes(), SIM_SOL_MINT.to_bytes());
}

// --- A real staking token: stake pool rate, no mint step (ADR 0010) ------------------------------

const ERR_INVALID_POOL: u32 = 6007;
const ERR_INVALID_STAKE_POOL: u32 = 6018;
const ACCOUNT_NOT_INITIALIZED: u32 = 3012;
/// 1 jitoSOL starts out worth 1.2 SOL.
const JITO_RATE: u64 = 1_200_000_000;

struct Jito {
    mint: APk,
    pool: APk,
}

/// The bytes of a `StakePool` account (SPL stake pool layout) with the fields the program reads.
fn stake_pool_bytes(mint: APk, total_lamports: u64, supply: u64) -> Vec<u8> {
    let mut data = vec![0u8; 611];
    data[0] = 1;
    data[162..194].copy_from_slice(mint.as_ref());
    data[258..266].copy_from_slice(&total_lamports.to_le_bytes());
    data[266..274].copy_from_slice(&supply.to_le_bytes());
    data
}

fn put_account(env: &mut Env, key: APk, owner: APk, data: Vec<u8>) {
    env.svm
        .set_account(
            s(key),
            solana_sdk::account::Account {
                lamports: SOL / 10,
                data,
                owner: s(owner),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
}

/// A stake pool account owned by the SPL stake pool program.
fn set_stake_pool(env: &mut Env, pool: APk, mint: APk, total_lamports: u64, supply: u64) {
    let data = stake_pool_bytes(mint, total_lamports, supply);
    put_account(env, pool, STAKE_POOL_PROGRAMS[0], data);
}

/// Moves the pool's exchange rate to `rate` with 1,000 jitoSOL outstanding.
fn set_jito_rate(env: &mut Env, jito: &Jito, rate: u64) {
    set_stake_pool(env, jito.pool, jito.mint, 1_000 * rate, 1_000 * SOL);
}

fn jito_rate(env: &Env, jito: &Jito) -> u64 {
    let data = env.svm.get_account(&s(jito.pool)).unwrap().data;
    let read = ledger::parse_stake_pool(&data).unwrap();
    native::stake_pool_rate(read.total_lamports, read.pool_token_supply).unwrap()
}

/// A token account of `owner` for `mint` holding `amount`.
fn plant_token(env: &mut Env, owner: APk, mint: APk, amount: u64) -> APk {
    let key = get_associated_token_address(&owner, &mint);
    let mut data = vec![0u8; spl_token::state::Account::LEN];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    put_account(env, key, TOKEN_PROGRAM_ID, data);
    key
}

fn set_token_apy_ix(oracle: APk, mint: APk, apy_bps: u16) -> Instruction {
    tix(
        accounts::SetTokenApy {
            oracle,
            config: pda(&[CONFIG_SEED]),
            mint,
            token_apy: pda(&[TOKEN_APY_SEED, mint.as_ref()]),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::SetTokenApy { apy_bps },
        vec![],
    )
}

fn set_ceiling_ix(admin: APk, mint: APk, ceiling_bps: u16) -> Instruction {
    tix(
        accounts::SetTokenApyCeiling {
            admin,
            config: pda(&[CONFIG_SEED]),
            mint,
            token_apy: pda(&[TOKEN_APY_SEED, mint.as_ref()]),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::SetTokenApyCeiling { ceiling_bps },
        vec![],
    )
}

fn set_ceiling(env: &mut Env, mint: APk, ceiling_bps: u16) -> Result<(), Failed> {
    let admin = env.admin.insecure_clone();
    let set = set_ceiling_ix(a(admin.pubkey()), mint, ceiling_bps);
    env.send(&[set], &admin, &[])
}

fn publish_apy(env: &mut Env, mint: APk, apy_bps: u16) -> Result<(), Failed> {
    let oracle = env.oracle.insecure_clone();
    let publish = set_token_apy_ix(a(oracle.pubkey()), mint, apy_bps);
    env.send(&[publish], &oracle, &[])
}

fn token_treasury_vault(mint: APk) -> APk {
    pda(&[TREASURY_VAULT_SEED, mint.as_ref()])
}

fn init_treasury_vault(env: &mut Env, mint: APk) -> Result<(), Failed> {
    let admin = env.admin.insecure_clone();
    let init = tix(
        accounts::InitTreasuryVault {
            admin: a(admin.pubkey()),
            config: pda(&[CONFIG_SEED]),
            treasury: pda(&[TREASURY_SEED]),
            mint,
            treasury_vault: token_treasury_vault(mint),
            token_program: TOKEN_PROGRAM_ID,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::InitTreasuryVault {},
        vec![],
    );
    env.send(&[init], &admin, &[])
}

/// jitoSOL as the active token: a stake pool at 1.2 SOL a token, a published APY of 7%, the
/// Treasury's vault of the token and a USD price for it.
fn jito_env() -> (Env, Jito) {
    let mut env = Env::new();
    let mint = plant_mint(&mut env);
    let pool = APk::new_unique();
    let jito = Jito { mint, pool };
    set_jito_rate(&mut env, &jito, JITO_RATE);
    set_sol_source(&mut env, mint, pool).unwrap();
    let oracle = env.oracle.insecure_clone();
    let publish = set_token_apy_ix(a(oracle.pubkey()), mint, 700);
    env.send(&[publish], &oracle, &[]).expect("publish APY");
    set_ceiling(&mut env, mint, 1_000).expect("ceiling");
    init_treasury_vault(&mut env, mint).expect("treasury vault");
    let feed = PriceFeed {
        bump: pda_bump(&[PRICE_SEED, mint.as_ref()]),
        asset: mint,
        price_micro_usd: PRICE,
        updated_ts: env.now(),
    };
    env.write(pda(&[PRICE_SEED, mint.as_ref()]), &feed, PriceFeed::SPACE);
    (env, jito)
}

impl Env {
    /// A person holding `amount` of `mint` in their associated token account.
    fn holder_of(&mut self, mint: APk, amount: u64) -> (Person, APk) {
        let p = self.person();
        let token = plant_token(self, p.key, mint, amount);
        (p, token)
    }

    fn open_stake_ix(&mut self, jito: &Jito, p: &Person, amount: u64) -> (Instruction, Pos) {
        let nonce = self.next_nonce;
        self.next_nonce += 1;
        let position = pda(&[
            POSITION_SEED,
            &[0],
            &tesoro_core::native_position_id(&p.key, nonce),
        ]);
        let custody = pda(&[NATIVE_SEED, position.as_ref()]);
        let vault = pda(&[NATIVE_VAULT_SEED, position.as_ref()]);
        let open = tix(
            accounts::OpenStakePoolPosition {
                owner_authority: p.key,
                owner_account: p.account,
                sol_source: sol_source(),
                token_apy: pda(&[TOKEN_APY_SEED, jito.mint.as_ref()]),
                pool: jito.pool,
                mint: jito.mint,
                owner_token: get_associated_token_address(&p.key, &jito.mint),
                position,
                custody,
                vault,
                token_program: TOKEN_PROGRAM_ID,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::OpenStakePoolPosition {
                nonce,
                token_amount: amount,
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

    fn open_stake(&mut self, jito: &Jito, p: &Person, amount: u64) -> Result<Pos, Failed> {
        let (open, pos) = self.open_stake_ix(jito, p, amount);
        self.send(&[open], &p.kp, &[]).map(|_| pos)
    }

    fn crank_stake_ix(&self, jito: &Jito, pos: Pos) -> Instruction {
        let p = self.position(pos);
        let source = p.open_advance.map(|index| self.source(pos, index));
        tix(
            accounts::AccrueStakePoolYield {
                position: pos.position,
                custody: pos.custody,
                vault: pos.vault,
                pool: jito.pool,
                treasury: pda(&[TREASURY_SEED]),
                treasury_vault: token_treasury_vault(jito.mint),
                token_program: TOKEN_PROGRAM_ID,
                source,
            },
            instruction::AccrueStakePoolYield {},
            vec![],
        )
    }

    fn crank_stake(&mut self, jito: &Jito, payer: &Keypair, pos: Pos) -> Result<(), Failed> {
        let crank = self.crank_stake_ix(jito, pos);
        self.send(&[crank], payer, &[])
    }

    fn stake_redeem(
        &mut self,
        jito: &Jito,
        p: &Person,
        pos: Pos,
        source: APk,
        amount: u64,
    ) -> Result<(), Failed> {
        let dest = get_associated_token_address(&p.key, &jito.mint);
        let mut redeem = self.redeem_ix(p, pos, source, amount, dest);
        redeem.accounts[8] = AccountMeta::new_readonly(s(jito.pool), false);
        self.send(&[redeem], &p.kp, &[])
    }

    fn stake_unlock_ix(&self, jito: &Jito, p: &Person, pos: Pos, with_fee: bool) -> Instruction {
        let dest = get_associated_token_address(&p.key, &jito.mint);
        let mut unlock = self.unlock_ix(p, pos, dest);
        unlock.accounts[6] = AccountMeta::new_readonly(s(jito.pool), false);
        if with_fee {
            unlock
                .accounts
                .push(AccountMeta::new(s(pda(&[TREASURY_SEED])), false));
            unlock
                .accounts
                .push(AccountMeta::new(s(token_treasury_vault(jito.mint)), false));
        }
        unlock
    }

    fn stake_instant_redeem_ix(
        &self,
        jito: &Jito,
        p: &Person,
        pos: Pos,
        source: APk,
        amount: u64,
    ) -> Instruction {
        let mut ix = self.instant_redeem_ix(p, pos, source, amount);
        // treasury_vault, holder_token, pool are accounts 8, 9 and 10 of the instruction.
        ix.accounts[8] = AccountMeta::new(s(token_treasury_vault(jito.mint)), false);
        ix.accounts[9] =
            AccountMeta::new(s(get_associated_token_address(&p.key, &jito.mint)), false);
        ix.accounts[10] = AccountMeta::new_readonly(s(jito.pool), false);
        ix
    }

    /// Every jitoSOL token of a Position is in its vault, the Treasury's vault or a payout.
    fn check_stake_invariants(&self, jito: &Jito, pos: Pos) {
        let (position, custody) = (self.position(pos), self.custody(pos));
        let rate = jito_rate(self, jito);
        assert!(custody.tracked_shares <= self.token_balance(pos.vault));
        native::check_cover(
            custody.tracked_shares,
            &position,
            custody.redeemed_units,
            rate,
        )
        .expect("tracked shares cover principal and the yield owed");
        assert!(custody.redeemed_units <= position.cumulative_yield);
    }

    fn mint_supply(&self, mint: APk) -> u64 {
        spl_token::state::Mint::unpack(&self.svm.get_account(&s(mint)).unwrap().data)
            .unwrap()
            .supply
    }
}

#[test]
fn a_position_opens_with_the_active_staking_token_and_records_its_value_in_sol() {
    let (mut env, jito) = jito_env();
    let (alice, alice_token) = env.holder_of(jito.mint, 10 * SOL);
    let pos = env.open_stake(&jito, &alice, 10 * SOL).expect("open");

    assert_eq!(env.token_balance(alice_token), 0);
    assert_eq!(env.token_balance(pos.vault), 10 * SOL);
    let position = env.position(pos);
    // 10 jitoSOL at 1.2 SOL each.
    assert_eq!(position.principal, 12 * SOL);
    assert_eq!(position.source_asset, jito.mint.to_bytes());
    assert_eq!(position.rate_bps, 700, "the published APY");
    let custody = env.custody(pos);
    assert_eq!((custody.mint, custody.pool), (jito.mint, jito.pool));
    assert_eq!(custody.rate_at_open, JITO_RATE);
    let data = env.svm.get_account(&s(pos.custody)).unwrap().data;
    assert_eq!(data.len(), NativeCustody::STAKE_POOL_SPACE);
    assert_eq!(NativeCustody::stake_pool_last_rate(&data), Some(JITO_RATE));
    assert!(PositionState::has_native_marker(
        &env.svm.get_account(&s(pos.position)).unwrap().data
    ));
    env.advance_native(&alice, pos, 1)
        .expect("native gates pass");
    env.check_stake_invariants(&jito, pos);
}

#[test]
fn a_real_token_cannot_open_without_the_setting_the_pool_or_a_published_apy() {
    let mut env = Env::new();
    let mint = plant_mint(&mut env);
    let jito = Jito {
        mint,
        pool: APk::new_unique(),
    };
    set_jito_rate(&mut env, &jito, JITO_RATE);
    let (alice, _) = env.holder_of(mint, 10 * SOL);
    env.faucet(&alice).unwrap();

    // No setting: the SolSource account does not exist.
    let err = env.open_stake(&jito, &alice, SOL).unwrap_err();
    assert_eq!(code(&err), ACCOUNT_NOT_INITIALIZED);
    // The legacy open cannot carry it, with the setting or without.
    let (legacy, _) = env.open_ix_with(&alice, 90, SOL, env.pool, mint);
    assert_eq!(
        code(&env.send(&std::slice::from_ref(&legacy), &alice.kp, &[]).unwrap_err()),
        ERR_INVALID_MINT
    );
    set_sol_source(&mut env, mint, jito.pool).unwrap();
    assert_eq!(
        code(&env.send(&[legacy], &alice.kp, &[]).unwrap_err()),
        ERR_INVALID_MINT
    );

    // No published APY yet.
    let err = env.open_stake(&jito, &alice, SOL).unwrap_err();
    assert_eq!(code(&err), ACCOUNT_NOT_INITIALIZED);
    let oracle = env.oracle.insecure_clone();
    let publish = set_token_apy_ix(a(oracle.pubkey()), mint, 700);
    env.send(&[publish], &oracle, &[]).unwrap();
    set_ceiling(&mut env, mint, 1_000).unwrap();
    env.open_stake(&jito, &alice, SOL).expect("now it opens");
}

#[test]
fn only_the_oracle_authority_publishes_an_apy_and_it_is_capped() {
    let (mut env, jito) = jito_env();
    let mallory = env.person();
    let publish = set_token_apy_ix(mallory.key, jito.mint, 9_000);
    let err = env.send(&[publish], &mallory.kp, &[]).unwrap_err();
    assert_eq!(code(&err), 6000);
    let oracle = env.oracle.insecure_clone();
    let too_high = set_token_apy_ix(a(oracle.pubkey()), jito.mint, 10_001);
    let err = env.send(&[too_high], &oracle, &[]).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::InvalidBps));
    let fine = set_token_apy_ix(a(oracle.pubkey()), jito.mint, 450);
    env.send(&[fine], &oracle, &[]).unwrap();
    let apy = env.load::<TokenApy>(pda(&[TOKEN_APY_SEED, jito.mint.as_ref()]));
    assert_eq!((apy.mint, apy.apy_bps), (jito.mint, 450));
}

#[test]
fn the_pool_must_be_a_stake_pool_of_the_token() {
    let (mut env, jito) = jito_env();
    let (alice, _) = env.holder_of(jito.mint, 10 * SOL);
    // Owned by another program.
    put_account(
        &mut env,
        jito.pool,
        APk::new_unique(),
        stake_pool_bytes(jito.mint, 1_200 * SOL, 1_000 * SOL),
    );
    let err = env.open_stake(&jito, &alice, SOL).unwrap_err();
    assert_eq!(code(&err), ERR_INVALID_STAKE_POOL);
    // A stake pool of another token.
    set_stake_pool(
        &mut env,
        jito.pool,
        APk::new_unique(),
        1_200 * SOL,
        1_000 * SOL,
    );
    let err = env.open_stake(&jito, &alice, SOL).unwrap_err();
    assert_eq!(code(&err), ERR_INVALID_STAKE_POOL);
    // A pool with no tokens has no rate.
    set_stake_pool(&mut env, jito.pool, jito.mint, 1_200 * SOL, 0);
    let err = env.open_stake(&jito, &alice, SOL).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::BadStakePool));
    // Not the pool the setting names.
    let other = Jito {
        mint: jito.mint,
        pool: APk::new_unique(),
    };
    set_jito_rate(&mut env, &other, JITO_RATE);
    let err = env.open_stake(&other, &alice, SOL).unwrap_err();
    assert_eq!(code(&err), ERR_INVALID_POOL);
    set_jito_rate(&mut env, &jito, JITO_RATE);
    env.open_stake(&jito, &alice, SOL)
        .expect("a real pool opens");
}

#[test]
fn yield_is_the_rate_growth_with_the_fee_taken_in_tokens_and_nothing_minted() {
    let (mut env, jito) = jito_env();
    let (alice, _) = env.holder_of(jito.mint, 10 * SOL);
    let pos = env.open_stake(&jito, &alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    // 12 SOL at 7% for a month = 0.07 SOL, 80% of it at $150 = 840 Gemas of Debt.
    assert_eq!(env.debt(source), 840);
    let supply_before = env.mint_supply(jito.mint);
    let cranker = env.person();

    // The rate has not moved: nothing accrues, nothing is charged.
    env.crank_stake(&jito, &cranker.kp, pos).unwrap();
    assert_eq!(env.position(pos).cumulative_yield, 0);
    assert_eq!(env.token_balance(token_treasury_vault(jito.mint)), 0);

    // jitoSOL goes from 1.20 to 1.22 SOL: the vault's 10 tokens gained 0.2 SOL.
    set_jito_rate(&mut env, &jito, 1_220_000_000);
    env.crank_stake(&jito, &cranker.kp, pos).expect("crank");
    let fee = native::yield_fee_shares(10 * SOL, JITO_RATE, 1_220_000_000, YIELD_FEE_BPS).unwrap();
    assert!(fee > 0);
    assert_eq!(env.token_balance(token_treasury_vault(jito.mint)), fee);
    assert_eq!(env.token_balance(pos.vault), 10 * SOL - fee);
    assert_eq!(env.custody(pos).tracked_shares, 10 * SOL - fee);
    assert_eq!(
        env.mint_supply(jito.mint),
        supply_before,
        "nothing is minted"
    );
    // The Position keeps 80% of the 0.2 SOL, the Treasury 20%.
    let position = env.position(pos);
    assert!(position.cumulative_yield.abs_diff(160_000_000) <= 2);
    assert!(env.treasury().fee_units.abs_diff(40_000_000) <= 2);
    assert_eq!(env.debt(source), 0, "the rate growth repaid the Debt");
    let data = env.svm.get_account(&s(pos.custody)).unwrap().data;
    assert_eq!(
        NativeCustody::stake_pool_last_rate(&data),
        Some(1_220_000_000)
    );
    env.check_stake_invariants(&jito, pos);

    // Cranking again at the same rate, or after the rate dipped and came back, takes no second fee.
    let (vault_balance, treasury_balance) = (
        env.token_balance(pos.vault),
        env.token_balance(token_treasury_vault(jito.mint)),
    );
    env.crank_stake(&jito, &cranker.kp, pos).unwrap();
    set_jito_rate(&mut env, &jito, 1_210_000_000);
    env.crank_stake(&jito, &cranker.kp, pos).unwrap();
    set_jito_rate(&mut env, &jito, 1_220_000_000);
    env.crank_stake(&jito, &cranker.kp, pos).unwrap();
    assert_eq!(env.token_balance(pos.vault), vault_balance);
    assert_eq!(
        env.token_balance(token_treasury_vault(jito.mint)),
        treasury_balance
    );
    env.check_stake_invariants(&jito, pos);
}

#[test]
fn redeem_and_unlock_pay_the_token_and_settle_the_fee_on_unseen_growth() {
    let (mut env, jito) = jito_env();
    let (alice, alice_token) = env.holder_of(jito.mint, 10 * SOL);
    let pos = env.open_stake(&jito, &alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    set_jito_rate(&mut env, &jito, 1_220_000_000);
    env.crank_stake(&jito, &alice.kp, pos).unwrap();

    // Redeem: 840 Gemas of 0.056 SOL, paid in jitoSOL at the pool rate.
    let rate = jito_rate(&env, &jito);
    env.stake_redeem(&jito, &alice, pos, source, 840)
        .expect("redeem");
    let units = 56_000_000;
    let paid = native::shares_for_units_floor(units, rate).unwrap();
    assert_eq!(env.token_balance(alice_token), paid);
    assert_eq!(env.custody(pos).redeemed_units, units);
    env.check_stake_invariants(&jito, pos);

    // The pool earns more before Unlock, and nobody cranks. Unlock without the Treasury accounts
    // is refused: the surplus would leave without its fee.
    set_jito_rate(&mut env, &jito, 1_250_000_000);
    let treasury_before = env.token_balance(token_treasury_vault(jito.mint));
    let bare = env.stake_unlock_ix(&jito, &alice, pos, false);
    let err = env.send(&[bare], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_REMAINING);
    let unlock = env.stake_unlock_ix(&jito, &alice, pos, true);
    env.send(&[unlock], &alice.kp, &[]).expect("unlock");

    assert_eq!(env.position(pos).status, PositionStatus::Unlocked);
    assert!(
        env.token_balance(token_treasury_vault(jito.mint)) > treasury_before,
        "the growth since the last crank paid its Yield Fee at Unlock"
    );
    // The owner got Principal back in the token: at least what it was worth, and the vault is empty.
    let owner_tokens = env.token_balance(alice_token);
    assert!(native::shares_value(owner_tokens - paid, 1_250_000_000).unwrap() >= 12 * SOL);
    assert_eq!(env.token_balance(pos.vault), 0);
    // Every token is accounted for: owner, Treasury, nothing left behind.
    assert_eq!(
        owner_tokens + env.token_balance(token_treasury_vault(jito.mint)),
        10 * SOL
    );
}

#[test]
fn a_fee_cannot_be_skipped_by_sweeping_instead_of_unlocking() {
    let (mut env, jito) = jito_env();
    let (alice, alice_token) = env.holder_of(jito.mint, 10 * SOL);
    let pos = env.open_stake(&jito, &alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    set_jito_rate(&mut env, &jito, 1_220_000_000);
    env.crank_stake(&jito, &alice.kp, pos).unwrap();
    env.stake_redeem(&jito, &alice, pos, source, 840).unwrap();
    let unlock = env.stake_unlock_ix(&jito, &alice, pos, true);
    env.send(&[unlock], &alice.kp, &[]).unwrap();

    // Something is left to sweep only if a holder still has yield owed; here a donation to the
    // vault is the owner's. Growth afterwards is settled with its fee on the sweep too.
    let vault_before = env.token_balance(pos.vault);
    set_jito_rate(&mut env, &jito, 1_300_000_000);
    let sweep = |env: &Env, with_fee: bool| {
        let mut ix = tix(
            accounts::SweepNativeSurplus {
                owner_authority: alice.key,
                owner_account: alice.account,
                position: pos.position,
                custody: pos.custody,
                vault: pos.vault,
                owner_token: alice_token,
                pool: jito.pool,
                token_program: TOKEN_PROGRAM_ID,
            },
            instruction::SweepNativeSurplus {},
            vec![],
        );
        if with_fee {
            ix.accounts
                .push(AccountMeta::new(s(pda(&[TREASURY_SEED])), false));
            ix.accounts
                .push(AccountMeta::new(s(token_treasury_vault(jito.mint)), false));
        }
        let _ = env;
        ix
    };
    let bare = sweep(&env, false);
    let err = env.send(&[bare], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_REMAINING);
    let with_fee = sweep(&env, true);
    env.send(&[with_fee], &alice.kp, &[])
        .expect("sweep with the fee accounts");
    assert_eq!(env.token_balance(pos.vault), vault_before);
}

#[test]
fn instant_redeem_pays_the_positions_token_from_the_treasurys_vault_of_that_token() {
    let (mut env, jito) = jito_env();
    let (alice, _) = env.holder_of(jito.mint, 10 * SOL);
    let (bob, bob_token) = env.holder_of(jito.mint, 0);
    let pos = env.open_stake(&jito, &alice, 10 * SOL).unwrap();
    // A long Horizon, so most of Bob's Gemas are still pending after a little growth.
    let source = env.advance_native(&alice, pos, 12).unwrap();
    env.give_won(&alice, &bob, source, 1_000);

    // The Treasury has no jitoSOL yet (its simSOL does not count).
    env.fund_treasury(SOL).unwrap();
    let short = env.stake_instant_redeem_ix(&jito, &bob, pos, source, 1_000);
    let err = env.send(&[short], &bob.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_TREASURY_SHORT);

    // The Yield Fee of the token's Positions fills the vault of that token.
    set_jito_rate(&mut env, &jito, 1_220_000_000);
    env.crank_stake(&jito, &alice.kp, pos).unwrap();
    let vault = token_treasury_vault(jito.mint);
    let fee = env.token_balance(vault);
    assert!(fee > 0);
    let landed = env.load::<SourceState>(source).inner.redeemable_for(1_000);
    let pending = 1_000 - landed;
    let units = env
        .load::<SourceState>(source)
        .inner
        .units_for(pending)
        .unwrap();
    let payout = units * 6_500 / 10_000;
    let instant = env.stake_instant_redeem_ix(&jito, &bob, pos, source, pending);
    env.send(&[instant], &bob.kp, &[]).expect("instant redeem");
    let shares = native::shares_for_units_floor(payout, jito_rate(&env, &jito)).unwrap();
    assert_eq!(env.token_balance(bob_token), shares, "paid in the token");
    assert_eq!(env.token_balance(vault), fee - shares);
    assert_eq!(env.treasury().instant_units, payout);

    // The simSOL vault cannot pay a jitoSOL Position, nor the sim pool price it.
    let mut wrong_vault = env.stake_instant_redeem_ix(&jito, &bob, pos, source, 1);
    wrong_vault.accounts[8] = AccountMeta::new(s(env.treasury_vault()), false);
    let err = env.send(&[wrong_vault], &bob.kp, &[]).unwrap_err();
    assert_eq!(
        code(&err),
        2014,
        "the holder's jitoSOL account is not of the simSOL vault's mint"
    );
    let mut wrong_pool = env.stake_instant_redeem_ix(&jito, &bob, pos, source, 1);
    wrong_pool.accounts[10] = AccountMeta::new_readonly(s(env.pool), false);
    let err = env.send(&[wrong_pool], &bob.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_INVALID_POOL);
}

#[test]
fn the_treasury_redeems_what_it_bought_into_its_vault_of_the_token() {
    let (mut env, jito) = jito_env();
    let (alice, _) = env.holder_of(jito.mint, 10 * SOL);
    let (bob, _) = env.holder_of(jito.mint, 0);
    let pos = env.open_stake(&jito, &alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 12).unwrap();
    env.give_won(&alice, &bob, source, 1_000);
    set_jito_rate(&mut env, &jito, 1_220_000_000);
    env.crank_stake(&jito, &alice.kp, pos).unwrap();
    let landed = env.load::<SourceState>(source).inner.redeemable_for(1_000);
    let instant = env.stake_instant_redeem_ix(&jito, &bob, pos, source, 1_000 - landed);
    env.send(&[instant], &bob.kp, &[]).unwrap();

    set_jito_rate(&mut env, &jito, 1_400_000_000);
    env.crank_stake(&jito, &alice.kp, pos).unwrap();
    let vault = token_treasury_vault(jito.mint);
    let before = env.token_balance(vault);
    let redeem = tix(
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
            rem(vault, true),
            rem(jito.pool, false),
            rem(TOKEN_PROGRAM_ID, false),
        ],
    );
    let payer = env.person();
    env.send(&std::slice::from_ref(&redeem), &payer.kp, &[]).expect("redeem");
    assert!(env.token_balance(vault) > before);

    // Only its own vault of the token: the simSOL vault is refused.
    let mut wrong = redeem;
    wrong.accounts[5 + 2] = AccountMeta::new(s(env.treasury_vault()), false);
    let err = env.send(&[wrong], &payer.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_INVALID_MINT);
}

#[test]
fn the_two_kinds_of_custody_keep_to_their_own_crank() {
    let (mut env, jito) = jito_env();
    let (alice, _) = env.holder_of(jito.mint, 10 * SOL);
    let stake = env.open_stake(&jito, &alice, 10 * SOL).unwrap();
    let sim = env.person();
    env.faucet(&sim).unwrap();
    let simple = env.open(&sim, 5 * SOL).unwrap();
    let payer = env.person();

    // The simSOL crank cannot value a stake pool custody.
    let mut wrong = tix(
        accounts::AccrueNativeYield {
            position: stake.position,
            custody: stake.custody,
            vault: stake.vault,
            pool: jito.pool,
            mint: jito.mint,
            yield_config: sim_pda(&[sim_lst::YIELD_SEED]),
            yield_authority: pda(&[YIELD_SEED]),
            sim_lst_program: sim_lst::ID,
            token_program: TOKEN_PROGRAM_ID,
            treasury: pda(&[TREASURY_SEED]),
            treasury_vault: env.treasury_vault(),
            source: None,
        },
        instruction::AccrueNativeYield {},
        vec![],
    );
    wrong.accounts[0].is_writable = true;
    let err = env.send(&[wrong], &payer.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ACCOUNT_OWNED_BY_WRONG_PROGRAM);

    // The stake pool crank refuses a simSOL custody, and the wrong Treasury vault.
    let mut on_sim = env.crank_stake_ix(&jito, stake);
    on_sim.accounts[0] = AccountMeta::new(s(simple.position), false);
    on_sim.accounts[1] = AccountMeta::new(s(simple.custody), false);
    on_sim.accounts[2] = AccountMeta::new(s(simple.vault), false);
    on_sim.accounts[3] = AccountMeta::new_readonly(s(env.pool), false);
    let err = env.send(&[on_sim], &payer.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_INVALID_ACCOUNT);
    let mut wrong_vault = env.crank_stake_ix(&jito, stake);
    wrong_vault.accounts[5] = AccountMeta::new(s(env.treasury_vault()), false);
    let err = env.send(&[wrong_vault], &payer.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_INVALID_MINT);
}

#[test]
fn switching_the_active_token_leaves_a_stake_pool_position_alone() {
    let (mut env, jito) = jito_env();
    let (alice, alice_token) = env.holder_of(jito.mint, 10 * SOL);
    let pos = env.open_stake(&jito, &alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();

    let other_mint = plant_mint(&mut env);
    let other_pool = APk::new_unique();
    set_stake_pool(&mut env, other_pool, other_mint, 1_000 * SOL, 1_000 * SOL);
    set_sol_source(&mut env, other_mint, other_pool).unwrap();
    // New openings of the old token are refused; the Position goes on with its own token.
    let (bob, _) = env.holder_of(jito.mint, SOL);
    assert_eq!(
        code(&env.open_stake(&jito, &bob, SOL).unwrap_err()),
        ERR_INVALID_POOL
    );
    set_jito_rate(&mut env, &jito, 1_230_000_000);
    env.crank_stake(&jito, &alice.kp, pos).expect("crank");
    env.stake_redeem(&jito, &alice, pos, source, 840)
        .expect("redeem");
    assert!(env.token_balance(alice_token) > 0);
    let unlock = env.stake_unlock_ix(&jito, &alice, pos, true);
    env.send(&[unlock], &alice.kp, &[]).expect("unlock");
    assert_eq!(env.position(pos).status, PositionStatus::Unlocked);
}

#[test]
fn a_stake_pool_custody_is_a_marker_past_the_unchanged_layout() {
    let (mut env, jito) = jito_env();
    let (alice, _) = env.holder_of(jito.mint, 10 * SOL);
    let pos = env.open_stake(&jito, &alice, SOL).unwrap();
    let mut data = env.svm.get_account(&s(pos.custody)).unwrap().data;
    // The struct is what live custodies have; the eight bytes after it are the marker and the rate.
    assert_eq!(NativeCustody::SPACE, 8 + 1 + 1 + 5 * 32 + 5 * 8);
    NativeCustody::try_deserialize(&mut &data[..NativeCustody::SPACE]).expect("same layout");
    data.truncate(NativeCustody::SPACE);
    assert!(
        !NativeCustody::is_stake_pool(&data),
        "no marker, a sim_lst custody"
    );
}

// --- Plain SOL: the stake pool's own deposit, then the Position, in one transaction -------------
//
// These run the real SPL stake pool program against a snapshot of the live jitoSOL pool
// (tests/fixtures: program dumped from mainnet-beta, pool, reserve, mint and manager fee account
// read on 2026-10-15), so the deposit's accounts and data are the ones the pool really takes.

/// The vanilla SPL stake pool program (jitoSOL's).
const SPL_STAKE_POOL: APk = STAKE_POOL_PROGRAMS[0];
const JITO_POOL: APk = APk::from_str_const("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb");
const JITO_MINT: APk = APk::from_str_const("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
const JITO_RESERVE: APk = APk::from_str_const("BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL");
const JITO_FEE_ACCOUNT: APk = APk::from_str_const("8yoigZfzZ1nNaadumY9uPVD118225UYHTDpmjpr2nrSa");
/// The slippage floor the app opens with after a quote, in basis points.
const SLIPPAGE_BPS: u64 = 50;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}

fn plant_fixture(env: &mut Env, key: APk, owner: APk, name: &str, lamports: u64) {
    env.svm
        .set_account(
            s(key),
            solana_sdk::account::Account {
                lamports,
                data: fixture(name),
                owner: s(owner),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
}

/// The live jitoSOL pool as the active token, with the real stake pool program loaded.
fn real_jito_env() -> (Env, Jito) {
    let mut env = Env::new();
    let program = fixture("spl_stake_pool.so");
    env.svm.add_program(s(SPL_STAKE_POOL), &program).unwrap();
    plant_fixture(&mut env, JITO_POOL, SPL_STAKE_POOL, "jito_pool.bin", SOL);
    plant_fixture(
        &mut env,
        JITO_RESERVE,
        anchor_lang::solana_program::stake::program::ID,
        "jito_reserve.bin",
        5_333_682_558_151,
    );
    plant_fixture(&mut env, JITO_MINT, TOKEN_PROGRAM_ID, "jito_mint.bin", SOL);
    plant_fixture(
        &mut env,
        JITO_FEE_ACCOUNT,
        TOKEN_PROGRAM_ID,
        "jito_fee.bin",
        SOL,
    );
    env.svm.set_sysvar(&Clock {
        unix_timestamp: T0,
        epoch: 1_058,
        ..Clock::default()
    });
    let jito = Jito {
        mint: JITO_MINT,
        pool: JITO_POOL,
    };
    set_sol_source(&mut env, JITO_MINT, JITO_POOL).unwrap();
    let oracle = env.oracle.insecure_clone();
    let publish = set_token_apy_ix(a(oracle.pubkey()), JITO_MINT, 700);
    env.send(&[publish], &oracle, &[]).expect("publish APY");
    set_ceiling(&mut env, JITO_MINT, 1_000).expect("ceiling");
    init_treasury_vault(&mut env, JITO_MINT).expect("treasury vault");
    (env, jito)
}

fn pool_withdraw_authority() -> APk {
    APk::find_program_address(&[JITO_POOL.as_ref(), b"withdraw"], &SPL_STAKE_POOL).0
}

/// `DepositSol` (instruction 14) into the pool, minting to `dest`.
fn deposit_sol_ix(from: APk, dest: APk, lamports: u64) -> Instruction {
    let mut data = vec![14u8];
    data.extend_from_slice(&lamports.to_le_bytes());
    let meta = |k: APk, w: bool, sig: bool| AccountMeta {
        pubkey: s(k),
        is_signer: sig,
        is_writable: w,
    };
    Instruction {
        program_id: s(SPL_STAKE_POOL),
        accounts: vec![
            meta(JITO_POOL, true, false),
            meta(pool_withdraw_authority(), false, false),
            meta(JITO_RESERVE, true, false),
            meta(from, true, true),
            meta(dest, true, false),
            meta(JITO_FEE_ACCOUNT, true, false),
            meta(dest, true, false),
            meta(JITO_MINT, true, false),
            meta(anchor_lang::system_program::ID, false, false),
            meta(TOKEN_PROGRAM_ID, false, false),
        ],
        data,
    }
}

fn create_ata_idempotent_ix(payer: APk, owner: APk, mint: APk) -> Instruction {
    let meta = |k: APk, w: bool, sig: bool| AccountMeta {
        pubkey: s(k),
        is_signer: sig,
        is_writable: w,
    };
    Instruction {
        program_id: s(ATA_PROGRAM_ID),
        accounts: vec![
            meta(payer, true, true),
            meta(get_associated_token_address(&owner, &mint), true, false),
            meta(owner, false, false),
            meta(mint, false, false),
            meta(anchor_lang::system_program::ID, false, false),
            meta(TOKEN_PROGRAM_ID, false, false),
        ],
        data: vec![1],
    }
}

/// Pool tokens a deposit of `lamports` mints at the pool's current balances, with no deposit fee.
fn quote_deposit(env: &Env, lamports: u64) -> u64 {
    let data = env.svm.get_account(&s(JITO_POOL)).unwrap().data;
    let read = ledger::parse_stake_pool(&data).unwrap();
    (lamports as u128 * read.pool_token_supply as u128 / read.total_lamports as u128) as u64
}

#[test]
fn plain_sol_is_staked_into_the_pool_and_opened_as_a_position_in_one_transaction() {
    let (mut env, jito) = real_jito_env();
    let alice = env.person();
    let ata = get_associated_token_address(&alice.key, &JITO_MINT);
    let lamports = 10 * SOL;
    let quoted = quote_deposit(&env, lamports);
    let floor = quoted * (10_000 - SLIPPAGE_BPS) / 10_000;
    let sol_before = env.svm.get_balance(&alice.kp.pubkey()).unwrap();

    let (open, pos) = env.open_stake_ix(&jito, &alice, floor);
    let ixs = [
        create_ata_idempotent_ix(alice.key, alice.key, JITO_MINT),
        deposit_sol_ix(alice.key, ata, lamports),
        open,
    ];
    env.send(&ixs, &alice.kp, &[]).expect("deposit then open");

    // The pool minted what the quote said, and the Position holds the floor of it.
    let leftover = env.token_balance(ata);
    assert_eq!(env.token_balance(pos.vault), floor);
    assert_eq!(leftover, quoted - floor, "only the slippage margin stays");
    assert_eq!(
        sol_before - env.svm.get_balance(&alice.kp.pubkey()).unwrap() - lamports,
        // rent of the ATA, Position, custody and vault accounts plus the signature fee
        env.svm
            .get_balance(&s(pos.position))
            .unwrap()
            .saturating_add(env.svm.get_balance(&s(pos.custody)).unwrap())
            .saturating_add(env.svm.get_balance(&s(pos.vault)).unwrap())
            .saturating_add(env.svm.get_balance(&s(ata)).unwrap())
            + 5_000
    );
    let position = env.position(pos);
    assert_eq!(position.source_asset, JITO_MINT.to_bytes());
    // Principal is worth about the SOL put in, never more.
    assert!(position.principal <= lamports);
    assert!(position.principal >= lamports * (10_000 - SLIPPAGE_BPS - 1) / 10_000);
    assert_eq!(position.rate_bps, 700);
    env.check_stake_invariants(&jito, pos);
}

#[test]
fn an_open_that_asks_for_more_than_the_deposit_minted_reverts_the_whole_transaction() {
    let (mut env, jito) = real_jito_env();
    let alice = env.person();
    let ata = get_associated_token_address(&alice.key, &JITO_MINT);
    let lamports = 10 * SOL;
    let quoted = quote_deposit(&env, lamports);
    let pool_before = env.svm.get_account(&s(JITO_POOL)).unwrap().data;
    let sol_before = env.svm.get_balance(&alice.kp.pubkey()).unwrap();

    let (open, pos) = env.open_stake_ix(&jito, &alice, quoted + 1);
    let ixs = [
        create_ata_idempotent_ix(alice.key, alice.key, JITO_MINT),
        deposit_sol_ix(alice.key, ata, lamports),
        open,
    ];
    env.send(&ixs, &alice.kp, &[])
        .expect_err("the pool minted less than the open asks for");

    // Nothing moved: no token account, no Position, the pool is as it was, SOL is intact bar the fee.
    assert!(env.svm.get_account(&s(ata)).is_none());
    assert!(env.svm.get_account(&s(pos.position)).is_none());
    assert_eq!(
        env.svm.get_account(&s(JITO_POOL)).unwrap().data,
        pool_before
    );
    let spent = sol_before - env.svm.get_balance(&alice.kp.pubkey()).unwrap();
    assert!(
        spent <= 5_000,
        "only the signature fee left the wallet: {spent}"
    );
}

#[test]
fn a_second_deposit_reuses_the_token_account_without_failing() {
    let (mut env, jito) = real_jito_env();
    let alice = env.person();
    let ata = get_associated_token_address(&alice.key, &JITO_MINT);
    for _ in 0..2 {
        let quoted = quote_deposit(&env, 5 * SOL);
        let floor = quoted * (10_000 - SLIPPAGE_BPS) / 10_000;
        let (open, _) = env.open_stake_ix(&jito, &alice, floor);
        let ixs = [
            create_ata_idempotent_ix(alice.key, alice.key, JITO_MINT),
            deposit_sol_ix(alice.key, ata, 5 * SOL),
            open,
        ];
        env.send(&ixs, &alice.kp, &[]).expect("open again");
    }
}

// --- Trailing APY under a ceiling (ADR 0010, ticket 11) ---------------------------------------

const ERR_STALE_APY: u32 = 6019;
const ERR_CEILING_NOT_SET: u32 = 6020;

impl Env {
    /// Re-stamps a token's USD price so the Advance's own staleness check passes after a warp.
    fn write_feed_fresh(&mut self, mint: APk) {
        let feed = PriceFeed {
            bump: pda_bump(&[PRICE_SEED, mint.as_ref()]),
            asset: mint,
            price_micro_usd: PRICE,
            updated_ts: self.now(),
        };
        self.write(pda(&[PRICE_SEED, mint.as_ref()]), &feed, PriceFeed::SPACE);
    }
}

fn rate_bps_of(env: &Env, pos: Pos) -> u16 {
    env.load::<PositionState>(pos.position).inner.rate_bps
}

#[test]
fn a_position_opens_and_is_advanced_on_the_lower_of_the_apy_and_the_ceiling() {
    let (mut env, jito) = jito_env();
    let alice = env.holder_of(jito.mint, 10 * SOL);
    let (alice, _) = alice;
    // Published 7%, ceiling 10%: the published APY applies.
    let pos = env.open_stake(&jito, &alice, SOL).unwrap();
    assert_eq!(rate_bps_of(&env, pos), 700);
    // The ceiling drops under the APY: the Advance follows it, not the open-time rate.
    set_ceiling(&mut env, jito.mint, 300).unwrap();
    let source = env.advance_native(&alice, pos, 12).unwrap();
    assert_eq!(rate_bps_of(&env, pos), 300);
    let at_300 = env.load::<SourceState>(source).inner.issued;
    // A spike in the published APY cannot lift it past the ceiling.
    publish_apy(&mut env, jito.mint, 9_000).unwrap();
    let pos2 = env.open_stake(&jito, &alice, SOL).unwrap();
    assert_eq!(rate_bps_of(&env, pos2), 300);
    let source2 = env.advance_native(&alice, pos2, 12).unwrap();
    assert_eq!(env.load::<SourceState>(source2).inner.issued, at_300);
    // Raising the ceiling above the published APY sizes on the published APY.
    set_ceiling(&mut env, jito.mint, 10_000).unwrap();
    let pos3 = env.open_stake(&jito, &alice, SOL).unwrap();
    assert_eq!(rate_bps_of(&env, pos3), 9_000);
}

#[test]
fn an_extend_follows_the_current_apy_for_the_added_months_only() {
    let (mut env, jito) = jito_env();
    let (alice, _) = env.holder_of(jito.mint, 10 * SOL);
    let pos = env.open_stake(&jito, &alice, 2 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 3).unwrap();
    let base = env.load::<SourceState>(source).inner.issued;
    env.advance(DAY + 1);
    env.write_feed_fresh(jito.mint);
    publish_apy(&mut env, jito.mint, 350).unwrap();
    let holding = env.holding(&alice, source);
    let before = env.load::<HoldingState>(holding).inner.amount;
    env.extend_native(&alice, pos, source, 3).unwrap();
    assert_eq!(rate_bps_of(&env, pos), 350);
    let minted = env.load::<HoldingState>(holding).inner.amount - before;
    // Half the rate over the same number of months mints about half the first three months.
    assert!(minted > 0 && minted < base, "{minted} vs {base}");
}

#[test]
fn only_the_admin_sets_the_ceiling_and_the_oracle_does_not_touch_it() {
    let (mut env, jito) = jito_env();
    let mallory = env.person();
    let err = env
        .send(
            &[set_ceiling_ix(mallory.key, jito.mint, 5_000)],
            &mallory.kp,
            &[],
        )
        .unwrap_err();
    assert_eq!(code(&err), 6000);
    // The oracle authority is not the admin.
    let oracle = env.oracle.insecure_clone();
    let err = env
        .send(
            &[set_ceiling_ix(a(oracle.pubkey()), jito.mint, 5_000)],
            &oracle,
            &[],
        )
        .unwrap_err();
    assert_eq!(code(&err), 6000);
    let err = set_ceiling(&mut env, jito.mint, 10_001).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::InvalidBps));
    // Publishing leaves the ceiling; setting it leaves the published APY and its time.
    let key = pda(&[TOKEN_APY_SEED, jito.mint.as_ref()]);
    publish_apy(&mut env, jito.mint, 450).unwrap();
    assert_eq!(env.load::<TokenApy>(key).ceiling_bps, 1_000);
    env.advance(100);
    set_ceiling(&mut env, jito.mint, 600).unwrap();
    let apy = env.load::<TokenApy>(key);
    assert_eq!((apy.apy_bps, apy.ceiling_bps), (450, 600));
    assert!(apy.updated_ts < env.now());
}

#[test]
fn a_stale_published_apy_refuses_an_advance_and_an_extend() {
    let (mut env, jito) = jito_env();
    let (alice, _) = env.holder_of(jito.mint, 10 * SOL);
    let pos = env.open_stake(&jito, &alice, 2 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(3 * DAY + 60);
    env.write_feed_fresh(jito.mint);
    let err = env.extend_native(&alice, pos, source, 1).unwrap_err();
    assert_eq!(code(&err), ERR_STALE_APY);
    publish_apy(&mut env, jito.mint, 700).unwrap();
    env.extend_native(&alice, pos, source, 1).unwrap();
    // Just inside the window still works for a fresh Position.
    env.advance(3 * DAY);
    env.write_feed_fresh(jito.mint);
    let pos2 = env.open_stake(&jito, &alice, SOL).unwrap();
    env.advance_native(&alice, pos2, 1)
        .expect("exactly 3 days old");
    env.advance(1);
    env.write_feed_fresh(jito.mint);
    let pos3 = env.open_stake(&jito, &alice, SOL).unwrap();
    let err = env.advance_native(&alice, pos3, 1).unwrap_err();
    assert_eq!(code(&err), ERR_STALE_APY);
}

#[test]
fn no_ceiling_means_no_stake_pool_advance_and_the_apy_account_cannot_be_left_out() {
    let (mut env, _) = jito_env();
    let mint = plant_mint(&mut env);
    let pool = APk::new_unique();
    let other = Jito { mint, pool };
    set_stake_pool(&mut env, pool, mint, 1_000 * JITO_RATE, 1_000 * SOL);
    set_sol_source(&mut env, mint, pool).unwrap();
    publish_apy(&mut env, mint, 700).unwrap();
    init_treasury_vault(&mut env, mint).unwrap();
    let feed = PriceFeed {
        bump: pda_bump(&[PRICE_SEED, mint.as_ref()]),
        asset: mint,
        price_micro_usd: PRICE,
        updated_ts: env.now(),
    };
    env.write(pda(&[PRICE_SEED, mint.as_ref()]), &feed, PriceFeed::SPACE);
    let (alice, _) = env.holder_of(mint, 10 * SOL);
    let pos = env.open_stake(&other, &alice, SOL).unwrap();
    assert_eq!(rate_bps_of(&env, pos), 0);
    let err = env.advance_native(&alice, pos, 1).unwrap_err();
    assert_eq!(code(&err), ERR_CEILING_NOT_SET);
    set_ceiling(&mut env, mint, 500).unwrap();

    // Without the account an Advance cannot fall back to the stored rate.
    let state = env.load::<PositionState>(pos.position);
    let source = env.source(pos, state.inner.advances);
    let advance = tix(
        accounts::TakeNativeAdvance {
            owner_authority: alice.key,
            owner_account: alice.account,
            protections: pda(&[PROTECTIONS_SEED, alice.account.as_ref()]),
            position: pos.position,
            price_feed: pda(&[PRICE_SEED, mint.as_ref()]),
            treasury: pda(&[TREASURY_SEED]),
            source,
            holding: env.holding(&alice, source),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::TakeNativeAdvance { horizon_months: 1 },
        vec![],
    );
    let err = env.send(&[advance], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_REMAINING);
    env.advance_native(&alice, pos, 1).unwrap();
    assert_eq!(rate_bps_of(&env, pos), 500);
}

// --- On-chain prices (ADR 0010) -------------------------------------------------------------

const PYTH_SOL_USD: [u8; 32] = [0xef; 32];
const PYTH_ETH_USD: [u8; 32] = [0xff; 32];
const PYTH_RECEIVER_ID: APk = tesoro_core::pyth::PYTH_RECEIVER;
const ERR_BAD_PRICE_FEED: u32 = 6021;
const ERR_PRICE_UNCERTAIN: u32 = 6022;
const ERR_ONCHAIN_REQUIRED: u32 = 6023;
const ERR_UNAUTHORIZED: u32 = 6000;
/// $150 with the exponent Pyth publishes, -8.
const FEED_150: i64 = 15_000_000_000;

/// A `PriceUpdateV2` image (`VerificationLevel::Full`).
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

fn put_feed(env: &mut Env, key: APk, feed_id: [u8; 32], price: i64, conf: u64, published: i64) {
    put_account(
        env,
        key,
        PYTH_RECEIVER_ID,
        pyth_image(feed_id, price, conf, published),
    );
}

fn onchain_price_pda(asset: APk) -> APk {
    pda(&[ONCHAIN_PRICE_SEED, asset.as_ref()])
}

fn set_onchain_price_ix(
    admin: APk,
    asset: APk,
    feed: APk,
    feed_id: [u8; 32],
    max_age_secs: u32,
    max_conf_bps: u16,
) -> Instruction {
    tix(
        accounts::SetOnchainPrice {
            admin,
            config: pda(&[CONFIG_SEED]),
            onchain_price: onchain_price_pda(asset),
            feed,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::SetOnchainPrice {
            asset,
            feed_id,
            max_age_secs,
            max_conf_bps,
        },
        vec![],
    )
}

fn map_price(env: &mut Env, asset: APk, feed: APk, feed_id: [u8; 32]) -> Result<(), Failed> {
    let admin = env.admin.insecure_clone();
    let set = set_onchain_price_ix(a(admin.pubkey()), asset, feed, feed_id, 90, 100);
    env.send(&[set], &admin, &[])
}

impl Env {
    fn advance_onchain_ix(&self, p: &Person, pos: Pos, feed: APk, months: u8) -> Instruction {
        let state = self.load::<PositionState>(pos.position);
        let asset = APk::new_from_array(state.inner.source_asset);
        let source = self.source(pos, state.inner.advances);
        tix(
            accounts::TakeNativeAdvanceOnchain {
                owner_authority: p.key,
                owner_account: p.account,
                protections: pda(&[PROTECTIONS_SEED, p.account.as_ref()]),
                position: pos.position,
                onchain_price: onchain_price_pda(asset),
                price_feed: feed,
                treasury: pda(&[TREASURY_SEED]),
                source,
                holding: self.holding(p, source),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::TakeNativeAdvanceOnchain {
                horizon_months: months,
            },
            self.apy_remaining(pos),
        )
    }

    fn advance_onchain(
        &mut self,
        p: &Person,
        pos: Pos,
        feed: APk,
        months: u8,
    ) -> Result<APk, Failed> {
        let state = self.load::<PositionState>(pos.position);
        let source = self.source(pos, state.inner.advances);
        let ix = self.advance_onchain_ix(p, pos, feed, months);
        self.send(&[ix], &p.kp, &[]).map(|_| source)
    }
}

/// A jitoSOL Position of 10 tokens (12 SOL) and a SOL/USD feed mapped to the token.
fn priced_env() -> (Env, Jito, Person, Pos, APk) {
    let (mut env, jito) = jito_env();
    let (alice, _) = env.holder_of(jito.mint, 10 * SOL);
    let pos = env.open_stake(&jito, &alice, 10 * SOL).unwrap();
    let feed = APk::new_unique();
    let now = env.now();
    put_feed(&mut env, feed, PYTH_SOL_USD, FEED_150, 5_000_000, now);
    map_price(&mut env, jito.mint, feed, PYTH_SOL_USD).expect("map");
    (env, jito, alice, pos, feed)
}

#[test]
fn a_self_excluded_owner_takes_no_feed_priced_advance() {
    let (mut env, _jito, alice, pos, feed) = priced_env();
    env.self_exclude(&alice, 6).unwrap();
    let err = env.advance_onchain(&alice, pos, feed, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::SelfExcluded));
}

#[test]
fn a_fresh_feed_prices_the_advance() {
    let (mut env, _jito, alice, pos, feed) = priced_env();
    let source = env.advance_onchain(&alice, pos, feed, 1).expect("advance");
    // 12 SOL at 7% for a month, 80% after the Yield Fee, at the feed's $150: the same 840 Gemas
    // the keeper-priced Advance gives at $150.
    assert_eq!(env.gemas(&alice, source), 840);
    let stored = env.load::<SourceState>(source);
    assert_eq!(stored.inner.unit_den, 150_000_000);
}

#[test]
fn the_exponent_and_a_non_round_price_convert_to_micro_usd() {
    let (mut env, _jito, alice, pos, feed) = priced_env();
    let now = env.now();
    // $103.22918088: 103,229,180 micro-USD floored; 0.056 SOL -> 578 Gemas.
    put_feed(&mut env, feed, PYTH_SOL_USD, 10_322_918_088, 3_356_136, now);
    let source = env.advance_onchain(&alice, pos, feed, 1).unwrap();
    assert_eq!(env.load::<SourceState>(source).inner.unit_den, 103_229_180);
    assert_eq!(env.gemas(&alice, source), 578);
}

#[test]
fn a_stale_price_refuses_the_advance_until_it_is_fresh() {
    let (mut env, _jito, alice, pos, feed) = priced_env();
    env.advance(91);
    let err = env.advance_onchain(&alice, pos, feed, 1).unwrap_err();
    assert_eq!(code(&err), ERR_STALE_PRICE);
    // Just inside the limit the admin set (90 s) is fine.
    let now = env.now();
    put_feed(&mut env, feed, PYTH_SOL_USD, FEED_150, 5_000_000, now - 90);
    env.advance_onchain(&alice, pos, feed, 1).expect("90 s old");
}

#[test]
fn a_feed_far_in_the_future_is_refused_too() {
    let (mut env, _jito, alice, pos, feed) = priced_env();
    let now = env.now();
    put_feed(&mut env, feed, PYTH_SOL_USD, FEED_150, 5_000_000, now + 60);
    let err = env.advance_onchain(&alice, pos, feed, 1).unwrap_err();
    assert_eq!(code(&err), ERR_STALE_PRICE);
}

#[test]
fn a_wide_confidence_interval_refuses_the_advance() {
    let (mut env, _jito, alice, pos, feed) = priced_env();
    let now = env.now();
    // 1.5% of the price against the 1% limit.
    put_feed(&mut env, feed, PYTH_SOL_USD, FEED_150, 225_000_000, now);
    let err = env.advance_onchain(&alice, pos, feed, 1).unwrap_err();
    assert_eq!(code(&err), ERR_PRICE_UNCERTAIN);
    put_feed(&mut env, feed, PYTH_SOL_USD, FEED_150, 150_000_000, now);
    env.advance_onchain(&alice, pos, feed, 1)
        .expect("1% is the limit");
}

#[test]
fn a_feed_of_the_wrong_owner_address_or_id_is_refused() {
    let (mut env, jito, alice, pos, feed) = priced_env();
    let now = env.now();
    // Not owned by the Pyth receiver.
    put_account(
        &mut env,
        feed,
        APk::new_unique(),
        pyth_image(PYTH_SOL_USD, FEED_150, 0, now),
    );
    let err = env.advance_onchain(&alice, pos, feed, 1).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_PRICE_FEED);
    // A genuine feed of another asset at the mapped address.
    put_feed(&mut env, feed, PYTH_ETH_USD, 240_000_000_000, 0, now);
    let err = env.advance_onchain(&alice, pos, feed, 1).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_PRICE_FEED);
    // A genuine SOL/USD feed, but not the mapped account.
    let other = APk::new_unique();
    put_feed(&mut env, other, PYTH_SOL_USD, FEED_150, 0, now);
    let err = env.advance_onchain(&alice, pos, other, 1).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_PRICE_FEED);
    // A partially verified update is not a price.
    let mut partial = pyth_image(PYTH_SOL_USD, FEED_150, 0, now);
    partial[40] = 0;
    put_account(&mut env, feed, PYTH_RECEIVER_ID, partial);
    let err = env.advance_onchain(&alice, pos, feed, 1).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_PRICE_FEED);
    put_feed(&mut env, feed, PYTH_SOL_USD, FEED_150, 0, now);
    env.advance_onchain(&alice, pos, feed, 1)
        .expect("the real feed works");
    let _ = jito;
}

#[test]
fn only_the_admin_maps_a_feed_and_only_a_pyth_account_can_be_mapped() {
    let (mut env, jito) = jito_env();
    let feed = APk::new_unique();
    let now = env.now();
    put_feed(&mut env, feed, PYTH_SOL_USD, FEED_150, 0, now);
    let oracle = env.oracle.insecure_clone();
    let by_oracle =
        set_onchain_price_ix(a(oracle.pubkey()), jito.mint, feed, PYTH_SOL_USD, 90, 100);
    let err = env.send(&[by_oracle], &oracle, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_UNAUTHORIZED);
    // The feed account must carry the id given.
    let err = map_price(&mut env, jito.mint, feed, PYTH_ETH_USD).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_PRICE_FEED);
    // And be owned by the Pyth receiver.
    let fake = APk::new_unique();
    put_account(
        &mut env,
        fake,
        APk::new_unique(),
        pyth_image(PYTH_SOL_USD, FEED_150, 0, now),
    );
    let err = map_price(&mut env, jito.mint, fake, PYTH_SOL_USD).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_PRICE_FEED);
    // Limits beyond the program's own are refused.
    let admin = env.admin.insecure_clone();
    for (age, conf) in [(0u32, 100u16), (121, 100), (90, 0), (90, 501)] {
        let set = set_onchain_price_ix(a(admin.pubkey()), jito.mint, feed, PYTH_SOL_USD, age, conf);
        let err = env.send(&[set], &admin, &[]).unwrap_err();
        assert_eq!(code(&err), ERR_BAD_PRICE_FEED, "{age} {conf}");
    }
    map_price(&mut env, jito.mint, feed, PYTH_SOL_USD).expect("admin maps");
}

#[test]
fn an_unmapped_asset_cannot_use_the_onchain_advance() {
    let (mut env, jito) = jito_env();
    let (alice, _) = env.holder_of(jito.mint, 10 * SOL);
    let pos = env.open_stake(&jito, &alice, 10 * SOL).unwrap();
    let feed = APk::new_unique();
    let now = env.now();
    put_feed(&mut env, feed, PYTH_SOL_USD, FEED_150, 0, now);
    let err = env.advance_onchain(&alice, pos, feed, 1).unwrap_err();
    assert_eq!(code(&err), CONSTRAINT_ACCOUNT_NOT_INITIALIZED);
}
const CONSTRAINT_ACCOUNT_NOT_INITIALIZED: u32 = 3012;

/// An Ethereum Position the oracle reported, 10 ETH of principal at 4%.
fn evm_position(env: &mut Env, p: &Person, asset: APk) -> APk {
    let id = [9u8; 32];
    let position = pda(&[POSITION_SEED, &[1], &id]);
    let oracle = env.oracle.insecure_clone();
    let open = tix(
        accounts::OpenPosition {
            oracle: a(oracle.pubkey()),
            config: pda(&[CONFIG_SEED]),
            owner_account: p.account,
            position,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::OpenPosition {
            source_chain: ledger::SourceChain::Ethereum,
            position_id: id,
            source_asset: asset,
            decimals: 18,
            principal: 10 * 1_000_000_000_000_000_000,
            rate_bps: 400,
        },
        vec![],
    );
    env.send(&[open], &oracle, &[]).unwrap();
    position
}

fn evm_advance_ix(
    env: &Env,
    p: &Person,
    position: APk,
    onchain: Option<APk>,
    price: u64,
) -> Instruction {
    let source = pda(&[SOURCE_SEED, position.as_ref(), &0u32.to_le_bytes()]);
    let holding = pda(&[HOLDING_SEED, p.account.as_ref(), source.as_ref()]);
    let asset = APk::new_from_array(env.load::<PositionState>(position).inner.source_asset);
    match onchain {
        Some(feed) => tix(
            accounts::TakeAdvanceOnchain {
                oracle: a(env.oracle.pubkey()),
                owner_authority: p.key,
                config: pda(&[CONFIG_SEED]),
                treasury: pda(&[TREASURY_SEED]),
                owner_account: p.account,
                protections: pda(&[PROTECTIONS_SEED, p.account.as_ref()]),
                position,
                onchain_price: onchain_price_pda(asset),
                price_feed: feed,
                source,
                holding,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::TakeAdvanceOnchain { horizon_months: 3 },
            vec![],
        ),
        None => tix(
            accounts::TakeAdvance {
                oracle: a(env.oracle.pubkey()),
                owner_authority: p.key,
                config: pda(&[CONFIG_SEED]),
                treasury: pda(&[TREASURY_SEED]),
                owner_account: p.account,
                protections: pda(&[PROTECTIONS_SEED, p.account.as_ref()]),
                position,
                source,
                holding,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::TakeAdvance {
                horizon_months: 3,
                price_micro_usd: price,
            },
            vec![rem(onchain_price_pda(asset), false)],
        ),
    }
}

#[test]
fn once_mapped_the_oracle_cannot_name_the_price_of_an_evm_advance() {
    let mut env = Env::new();
    let alice = env.staker();
    let asset = APk::new_unique();
    let position = evm_position(&mut env, &alice, asset);
    let oracle = env.oracle.insecure_clone();
    let feed = APk::new_unique();
    let now = env.now();
    put_feed(
        &mut env,
        feed,
        PYTH_ETH_USD,
        300_000_000_000,
        100_000_000,
        now,
    );
    map_price(&mut env, asset, feed, PYTH_ETH_USD).unwrap();

    let legacy = evm_advance_ix(&env, &alice, position, None, 1_000_000_000_000);
    let err = env.send(&[legacy], &oracle, &[&alice.kp]).unwrap_err();
    assert_eq!(code(&err), ERR_ONCHAIN_REQUIRED);
    // Leaving the mapping out of the remaining accounts does not help.
    let mut bare = evm_advance_ix(&env, &alice, position, None, 1_000_000_000_000);
    bare.accounts.pop();
    let err = env.send(&[bare], &oracle, &[&alice.kp]).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_REMAINING);

    let priced = evm_advance_ix(&env, &alice, position, Some(feed), 0);
    env.send(&[priced], &oracle, &[&alice.kp])
        .expect("feed price");
    let source = pda(&[SOURCE_SEED, position.as_ref(), &0u32.to_le_bytes()]);
    // 10 ETH at 4% for 3 months = 0.1 ETH, 80% = 0.08 ETH at $3,000 = 24,000 cents.
    assert_eq!(env.load::<SourceState>(source).inner.issued, 24_000);
}

#[test]
fn a_self_exclusion_stops_new_and_extended_advances_but_a_break_does_not() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let pos = env.open(&alice, 2 * SOL).unwrap();
    env.take_break(&alice, 7).unwrap();
    let source = env
        .advance_native(&alice, pos, 3)
        .expect("a Break leaves Advances open");
    let first = env.gemas(&alice, source);
    env.give_won(&alice, &bob, source, first);
    env.advance(MONTH);
    env.crank(&alice.kp, pos).unwrap();
    env.extend_native(&alice, pos, source, 1)
        .expect("a Break leaves Extends open");

    env.self_exclude(&alice, 6).unwrap();
    env.advance(DAY);
    let err = env.extend_native(&alice, pos, source, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::SelfExcluded));
    let carol = env.staker();
    let pos2 = env.open(&alice, SOL).expect("locking still works");
    let err = env.advance_native(&alice, pos2, 3).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::SelfExcluded));
    // Another Player's Self-Exclusion changes nothing for them.
    env.set_price(PRICE).unwrap();
    let pos3 = env.open(&carol, SOL).unwrap();
    env.advance_native(&carol, pos3, 3).unwrap();
}

#[test]
fn repayment_unlock_and_sweep_work_during_a_self_exclusion() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 2 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.self_exclude(&alice, 6).unwrap();
    env.advance(MONTH + 1);
    env.crank(&alice.kp, pos).expect("the crank repays Debt");
    assert_eq!(env.debt(source), 0);
    env.unlock(&alice, pos).expect("unlock");
    env.sweep(&alice, pos).expect("sweep");
}

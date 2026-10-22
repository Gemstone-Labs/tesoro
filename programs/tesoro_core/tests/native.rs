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
use tesoro_core::ledger::book::checkpoint::MemCheckpoints;
use tesoro_core::ledger::book::fp_ceil;
use tesoro_core::ledger::line_store::{CLASS_GENERAL, SIDE_OWN, SIDE_WON};
use tesoro_core::ledger::{self, native, PositionStatus, ShareRate};
use tesoro_core::state::*;
use tesoro_core::storage::*;
use tesoro_core::{accounts, instruction, LineRef};

mod common;
use common::econ::{self, book_metas, find_line, gemas_in, read_book};

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
const ERR_ADVANCE_BELOW_MINIMUM: u32 = anchor_lang::error::ERROR_CODE_OFFSET
    + tesoro_core::error::TesoroError::AdvanceBelowMinimum as u32;
const ERR_SOURCE_REQUIRED: u32 = 6018;
const ERR_BAD_PRICE_FEED: u32 = 6020;
const ERR_PRICE_UNCERTAIN: u32 = 6021;
const ERR_ONCHAIN_REQUIRED: u32 = 6022;
const ERR_UNAUTHORIZED: u32 = 6000;
const CONSTRAINT_SEEDS: u32 = 2006;
const ACCOUNT_DISCRIMINATOR_MISMATCH: u32 = 3002;
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
        Self::with_start(T0)
    }

    /// An Env whose clock starts at `t0` (the Season tests start inside Season 1).
    fn with_start(t0: i64) -> Self {
        let mut svm = LiteSVM::new();
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/");
        svm.add_program_from_file(s(tesoro_core::ID), format!("{dir}tesoro_core.so"))
            .expect("run `pnpm build:programs` first");
        svm.add_program_from_file(s(sim_lst::ID), format!("{dir}sim_lst.so"))
            .expect("run `pnpm build:programs` first");
        svm.set_sysvar(&Clock {
            unix_timestamp: t0,
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
        env.init_economy();
        env
    }

    /// The economy settings (the Season and fill keepers stay unset, keeper fills off) and the
    /// Treasury Account's basket and spill.
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
                    pda(&[NATIVE_SEED]),
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
    fn basket(&self, p: &Person) -> APk {
        basket_address(&p.account).0
    }
    fn spill(&self, p: &Person) -> APk {
        spill_address(&p.account).0
    }

    /// The line a holder names to redeem: the General class of a Source (`side`: 0 own, 1 won).
    fn line(&self, source: APk, side: u8) -> LineRef {
        LineRef {
            side,
            due_at: self.stored(source).due_at,
            class: CLASS_GENERAL,
            tranche: 0,
        }
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
        self.advance_ix_min(p, pos, months, 1)
    }

    fn advance_ix_min(
        &self,
        p: &Person,
        pos: Pos,
        months: u8,
        min_gemas: u64,
    ) -> (Instruction, APk) {
        let position = self.position(pos);
        let source = self.source(pos, position.advances);
        let advance = tix(
            accounts::TakeNativeAdvance {
                owner_authority: p.key,
                owner_account: p.account,
                protections: pda(&[PROTECTIONS_SEED, p.account.as_ref()]),
                position: pos.position,
                price_feed: pda(&[PRICE_SEED, SIM_SOL_MINT.as_ref()]),
                pool: self.pool,
                source,
                book: book_address(&source).0,
                basket: self.basket(p),
                spill: self.spill(p),
                economy: pda(&[ECONOMY_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::TakeNativeAdvance {
                horizon_months: months,
                min_gemas,
            },
            self.prev_tail(pos),
        );
        (advance, source)
    }

    fn advance_native(&mut self, p: &Person, pos: Pos, months: u8) -> Result<APk, Failed> {
        let (advance, source) = self.advance_ix(p, pos, months);
        self.send(&[advance], &p.kp, &[])?;
        self.ensure_pages(source);
        Ok(source)
    }

    /// Creates page 0 of every class of the Source that writes checkpoint records (anyone pays),
    /// so a landing that closes a segment finds somewhere to write it.
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
        self.extend_native_min(p, pos, source, extra_months, 1)
    }

    fn extend_native_min(
        &mut self,
        p: &Person,
        pos: Pos,
        source: APk,
        extra_months: u8,
        min_gemas: u64,
    ) -> Result<(), Failed> {
        let extend = tix(
            accounts::ExtendNativeAdvance {
                owner_authority: p.key,
                owner_account: p.account,
                protections: pda(&[PROTECTIONS_SEED, p.account.as_ref()]),
                position: pos.position,
                pool: self.pool,
                source,
                basket: self.basket(p),
                spill: self.spill(p),
                extend_limit: self.extend_limit(p),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::ExtendNativeAdvance {
                extra_months,
                min_gemas,
            },
            book_metas(&self.svm, source),
        );
        self.send(&[extend], &p.kp, &[])?;
        self.ensure_pages(source);
        Ok(())
    }

    /// The kind accounts of a paying instruction:
    /// `[custody, vault, pool, destination, mint, yield_config, yield_authority, sim_lst, token]`.
    fn kind_paying(&self, pos: Pos, dest: APk) -> Vec<AccountMeta> {
        vec![
            rem(pos.custody, true),
            rem(pos.vault, true),
            rem(self.pool, false),
            rem(dest, true),
            rem(self.mint, true),
            rem(sim_pda(&[sim_lst::YIELD_SEED]), false),
            rem(pda(&[YIELD_SEED]), false),
            rem(sim_lst::ID, false),
            rem(TOKEN_PROGRAM_ID, false),
        ]
    }

    fn redeem_ix(
        &self,
        p: &Person,
        pos: Pos,
        source: APk,
        line: LineRef,
        amount: u64,
        dest: APk,
    ) -> Instruction {
        let mut remaining = self.kind_paying(pos, dest);
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

    /// A Redeem of the holder's General line of the Source: own side for the Position's owner,
    /// won side for anyone else.
    fn redeem_to_ix(
        &self,
        p: &Person,
        pos: Pos,
        source: APk,
        amount: u64,
        dest: APk,
    ) -> Instruction {
        let side = if self.stored(source).owner == p.account.to_bytes() {
            SIDE_OWN
        } else {
            SIDE_WON
        };
        self.redeem_ix(p, pos, source, self.line(source, side), amount, dest)
    }

    /// Redeems `amount` of the holder's won Gemas of the General class (`side` 1) or own (0).
    fn redeem_side(
        &mut self,
        p: &Person,
        pos: Pos,
        source: APk,
        side: u8,
        amount: u64,
    ) -> Result<(), Failed> {
        let line = self.line(source, side);
        let redeem = self.redeem_ix(p, pos, source, line, amount, p.token);
        self.send(&[redeem], &p.kp, &[])
    }

    /// The owner redeems repaid Gemas of their own General line.
    fn redeem(&mut self, p: &Person, pos: Pos, source: APk, amount: u64) -> Result<(), Failed> {
        let side = if self.stored(source).owner == p.account.to_bytes() {
            SIDE_OWN
        } else {
            SIDE_WON
        };
        self.redeem_side(p, pos, source, side, amount)
    }

    fn unlock_ix(&self, p: &Person, pos: Pos, dest: APk) -> Instruction {
        let mut remaining = self.kind_paying(pos, dest);
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
        let unlock = self.unlock_ix(p, pos, p.token);
        self.send(&[unlock], &p.kp, &[])
    }

    fn return_own(&mut self, p: &Person, pos: Pos, source: APk, amount: u64) -> Result<(), Failed> {
        let line = self.line(source, SIDE_OWN);
        let mut remaining = vec![rem(pos.custody, true), rem(self.pool, false)];
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
            instruction::ReturnOwn { line, amount },
            remaining,
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

    /// The checkpoint records on chain, as a store the pure ledger can write to.
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

    /// The Source's book as it would stand if an instruction synced it now (what every
    /// instruction does first), and the Position with the shares that landing recorded.
    fn synced(&self, source: APk) -> (ledger::book::SourceBook, ledger::Position, MemCheckpoints) {
        let stored = self.stored(source);
        let pos_key = APk::new_from_array(stored.position);
        let mut position = self.load::<PositionState>(pos_key).inner;
        let pool = self.load::<sim_lst::Pool>(self.pool);
        let net = native::position_accrued(&position, pool.speedup, self.now()).unwrap();
        let rate = ShareRate::native(sim_lst::current_rate(&pool, self.now()).unwrap()).unwrap();
        let mut book = read_book(&self.svm, source);
        let mut ck = self.mem_pages(source);
        ledger::economy::sync_source(&mut position, &stored, &mut book, net, &rate, &mut ck)
            .unwrap();
        (book, position, ck)
    }

    /// Left to pay back now, in Gemas (rounded up).
    fn debt(&self, source: APk) -> u64 {
        fp_ceil(self.synced(source).0.uncovered_total()) as u64
    }

    /// What the General line of `holder` (own or won) can Redeem now.
    fn redeemable(&self, holder: &Person, source: APk, side: u8) -> u64 {
        let (book, _, ck) = self.synced(source);
        let Some(line) = find_line(&self.svm, holder.account, source, side, CLASS_GENERAL, 0)
        else {
            return 0;
        };
        let line = book.peek(&line, &ck).unwrap();
        book.redeemable(&line).unwrap()
    }

    fn gemas(&self, p: &Person, source: APk) -> u64 {
        gemas_in(&self.svm, p.account, source)
    }

    /// Accrued Yield of a Position now (gross: the Yield Fee waits for the cash-out).
    fn accrued(&self, pos: Pos) -> u64 {
        let pool = self.load::<sim_lst::Pool>(self.pool);
        native::position_accrued(&self.position(pos), pool.speedup, self.now()).unwrap()
    }

    /// What a won Match does to the baskets (see `common::econ::win`).
    fn give_won(&mut self, from: &Person, to: &Person, source: APk, k: u64) {
        econ::win(
            &mut self.svm,
            source,
            from.account,
            to.account,
            CLASS_GENERAL,
            0,
            k,
        );
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
    let custody = env.custody();
    assert_eq!(custody.principal, 14 * SOL as u128);
    assert_eq!(position.yield_fee_bps, YIELD_FEE_BPS);
    assert_eq!(custody.open_positions, 2);
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
    // 10 SOL at 7% for one month = 0.058333333 SOL = 874 Gemas (floored) at $150: the whole
    // yield (ticket 31; the Yield Fee is taken at cash-out).
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
fn an_advance_below_the_players_floor_is_refused_and_nothing_moves() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    // The quote said 874 (see above). The price drops 1% before the Advance lands: about 865.
    env.set_price(PRICE * 99 / 100).unwrap();
    let (short, _) = env.advance_ix_min(&alice, pos, 1, 874);
    let err = env.send(&[short], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_ADVANCE_BELOW_MINIMUM);
    assert_eq!(env.position(pos).advances, 0, "no Advance was opened");
    // A floor of zero is refused too: every caller names one.
    let (zero, _) = env.advance_ix_min(&alice, pos, 1, 0);
    assert_eq!(
        code(&env.send(&[zero], &alice.kp, &[]).unwrap_err()),
        ERR_ADVANCE_BELOW_MINIMUM
    );
    // Back at the quoted price the same floor is met exactly.
    env.set_price(PRICE).unwrap();
    let (ok, source) = env.advance_ix_min(&alice, pos, 1, 874);
    env.send(&[ok], &alice.kp, &[]).expect("floor met");
    assert_eq!(env.gemas(&alice, source), 874);
}

#[test]
fn an_extend_below_the_players_floor_is_refused() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    let before = env.gemas(&alice, source);
    // One more month at the Source's own price mints 874 or 875 (two floors); 876 is out of reach.
    let err = env
        .extend_native_min(&alice, pos, source, 1, 876)
        .unwrap_err();
    assert_eq!(code(&err), ERR_ADVANCE_BELOW_MINIMUM);
    assert_eq!(env.gemas(&alice, source), before);
    env.extend_native_min(&alice, pos, source, 1, 874)
        .expect("floor met");
    assert!(env.gemas(&alice, source) >= before + 874);
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
            protections: pda(&[PROTECTIONS_SEED, mallory.account.as_ref()]),
            position: pos.position,
            price_feed: pda(&[PRICE_SEED, SIM_SOL_MINT.as_ref()]),
            pool: env.pool,
            source,
            book: book_address(&source).0,
            basket: env.basket(&mallory),
            spill: env.spill(&mallory),
            economy: pda(&[ECONOMY_SEED]),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::TakeNativeAdvance {
            horizon_months: 1,
            min_gemas: 1,
        },
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
    assert_eq!(env.debt(source), 874, "a top-up must not repay Debt");
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
    assert_eq!(env.debt(source), 874);

    env.advance(300);
    let half = env.debt(source);
    assert!(half > 0 && half < 874, "debt {half}");
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
    env.redeem(&alice, pos, source, 874).expect("redeem all");

    // 874 Gemas = 58_266_666 lamports of SOL, worth the simSOL shares their yield was worth when it
    // landed (the same instant here), rounded down. The holder is paid 80% of them (one floor);
    // the Yield Fee stays with the Treasury, half of it owed to the Pool (ticket 31).
    let paid = env.token_balance(alice.token);
    let shares = native::shares_for_units_floor(58_266_666, env.rate()).unwrap();
    let expected = shares * 8_000 / 10_000;
    assert!(
        paid <= expected && expected - paid <= 1,
        "paid {paid} expected {expected}"
    );
    assert_eq!(env.supply() - supply, paid, "only the payout is minted");
    let route = env.custody().route;
    let fee = route.treasury_shares;
    assert!(fee as u64 + paid <= shares && shares - (fee as u64 + paid) <= 1);
    assert_eq!(route.pool_owed, fee / 2);
    let stored = env.stored(source);
    assert!(stored.fee_units > 0 && stored.pool_units <= stored.fee_units / 2 + 1);
    assert_eq!(env.token_balance(pos.vault), vault, "Principal untouched");
    assert_eq!(env.gemas(&alice, source), 0);
    let stored = env.stored(source);
    assert_eq!(stored.redeemed, 874);
    assert!(stored.redeemed_units <= 58_266_666 && 58_266_666 - stored.redeemed_units <= 2);
    assert_eq!(
        stored.yield_units, 0,
        "the book records coverage, not the Source"
    );
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
    assert!(env.accrued(pos) > 0);
}

#[test]
fn payouts_are_bounded_by_accrued_yield() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(300);
    let redeemable = env.redeemable(&alice, source, SIDE_OWN);
    assert!(redeemable > 0 && redeemable < 874);
    let err = env.redeem(&alice, pos, source, redeemable + 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::ExceedsRedeemable));
    env.redeem(&alice, pos, source, redeemable).unwrap();
    // A second redeem of the same yield finds nothing left.
    let err = env.redeem(&alice, pos, source, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::ExceedsRedeemable));
    // More yield lands with the clock, and more can be redeemed.
    env.advance(100);
    assert!(env.redeemable(&alice, source, SIDE_OWN) > 0);
    env.redeem(&alice, pos, source, 1).unwrap();
    // What was paid is shares of what landed: never more units than the yield accrued, at the
    // rate the shares were minted at (a share is worth a little more later).
    let minted = env.token_balance(alice.token);
    let landed = native::shares_for_units_floor(env.accrued(pos), 1_000_000_000).unwrap();
    assert!(minted <= landed, "minted {minted} landed {landed}");
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
            basket: env.basket(&alice),
            spill: env.spill(&alice),
            position: pos.position,
            source,
        },
        instruction::Redeem {
            line: env.line(source, SIDE_OWN),
            amount: 100,
        },
        vec![],
    );
    let err = env.send(&[bare], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_REMAINING);
    assert_eq!(env.gemas(&alice, source), 874);

    // The destination must belong to the holder.
    env.faucet(&mallory).unwrap();
    let steal = env.redeem_to_ix(&alice, pos, source, 100, mallory.token);
    let err = env.send(&[steal], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_INVALID_ACCOUNT);

    // A treasury, pool or sim_lst that is not the real one is refused.
    let mut fake_pool = env.redeem_to_ix(&alice, pos, source, 100, alice.token);
    fake_pool.accounts[8].pubkey = s(alice.account);
    assert!(env.send(&[fake_pool], &alice.kp, &[]).is_err());
    let mut fake_program = env.redeem_to_ix(&alice, pos, source, 100, alice.token);
    fake_program.accounts[13].pubkey = s(anchor_lang::system_program::ID);
    assert!(env.send(&[fake_program], &alice.kp, &[]).is_err());
    assert_eq!(env.gemas(&alice, source), 874);
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
    // Bob is paid the shares less the 20% Yield Fee (one floor).
    let expected = native::shares_for_units_floor(units, env.rate()).unwrap() * 8_000 / 10_000;
    let got = env.token_balance(bob.token) - bob_before;
    assert!(
        got.abs_diff(expected) <= 1,
        "bob got {got} expected {expected}"
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
    without.accounts.truncate(4 + 9);
    let err = env.send(&[without], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_SOURCE_REQUIRED);

    env.redeem(&alice, pos, source, 874).unwrap();
    let before = env.token_balance(alice.token);
    let supply = env.supply();
    // What the book will hand the owner as free yield: the coverage no holder is owed.
    let (book, _, _) = env.synced(source);
    let pocket = (book.owner_shares >> 32) as u64;
    // The free yield pays the Yield Fee as it leaves (ticket 31).
    let pocket_fee = pocket - pocket * 8_000 / 10_000;
    assert!(
        pocket > 0,
        "the first month earned a little more than the Advance needed"
    );
    env.unlock(&alice, pos).expect("unlock");

    let position = env.position(pos);
    assert_eq!(position.status, PositionStatus::Unlocked);
    assert_eq!(position.open_advance, None);
    assert_eq!(position.custody_shares, 0);
    assert_eq!(
        (position.held_shares >> 32, position.free_shares >> 32),
        (0, 0)
    );
    // Principal from the vault, free yield less the fee minted: exactly that and no more.
    let got = env.token_balance(alice.token) - before;
    assert_eq!(got, 10 * SOL + pocket - pocket_fee);
    assert_eq!(env.supply() - supply, pocket - pocket_fee);
    assert_eq!(env.token_balance(pos.vault), 0);
    // The book gave its pocket away once.
    let after = read_book(&env.svm, source);
    assert_eq!((after.owner_shares, after.owner_fp), (0, 0));
    // The Position left the custody.
    let custody = env.custody();
    assert_eq!((custody.principal, custody.open_positions), (0, 0));
    // The fees realised so far: Alice's Redeem of her 874 Gemas, then her free yield at Unlock,
    // each split with the Pool at the Source's 50%.
    let route = custody.route;
    assert!(route.treasury_shares >= pocket_fee as u128);
    assert!(route.pool_owed * 2 <= route.treasury_shares);
    assert_eq!(
        route.owed_shares, 0,
        "Alice redeemed every Gema before unlocking"
    );
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
    let accrued = env.accrued(pos);
    let before = env.token_balance(alice.token);
    env.unlock(&alice, pos).unwrap();
    let got = env.token_balance(alice.token) - before;
    // All of it is free yield, which pays the 20% Yield Fee as it leaves (one floor).
    let free = native::shares_for_units_floor(accrued, env.rate()).unwrap();
    assert_eq!(got, 10 * SOL + free * 8_000 / 10_000);
    let route = env.custody().route;
    assert_eq!(
        route.treasury_shares,
        u128::from(free - free * 8_000 / 10_000)
    );
    assert_eq!(route.pool_owed, route.treasury_shares / 2);
}

#[test]
fn gemas_still_redeem_after_unlock_from_the_closed_source() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH);
    let rate_then = env.rate();
    env.unlock(&alice, pos).expect("unlock");
    // The holders' claim is fixed in shares at Unlock (D2) and owed from the route.
    let owed = env.custody().route.owed_shares;
    assert!(owed > 0);
    env.advance(10 * MONTH);
    let supply = env.supply();
    env.redeem(&alice, pos, source, 874)
        .expect("redeem after unlock");
    let owed_for_them = native::shares_for_units_floor(58_266_666, rate_then).unwrap();
    let minted = env.supply() - supply;
    let paid = owed - env.custody().route.owed_shares;
    assert!(
        paid <= owed_for_them as u128 && owed_for_them as u128 - paid <= 1,
        "the closed Source pays the shares it owed (paid {paid}, owed {owed_for_them}), not more"
    );
    // An unlocked holder pays the Yield Fee too: 80% minted, the fee joins the Treasury.
    assert_eq!(minted as u128, paid * 8_000 / 10_000);
}

#[test]
fn a_second_advance_after_debt_zero_counts_only_yield_after_it_opened() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let first = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(3 * MONTH);
    let net = env.accrued(pos);

    let second = env.advance_native(&alice, pos, 2).expect("second advance");
    let p = env.position(pos);
    assert_eq!(p.open_advance, Some(1));
    assert_eq!(p.applied_net, net, "the checkpoint moved to now");
    // The first Source is fully covered and its book gave the rest to the owner as free yield.
    let b0 = read_book(&env.svm, first);
    assert_eq!(b0.uncovered_total(), 0);
    assert!(p.free_shares > 0, "the rest was free yield");
    assert_eq!(b0.owner_shares, 0);
    // The new Advance starts with its whole Debt.
    assert_eq!(env.debt(second), env.stored(second).issued);
    assert!(env.debt(second) > 0);

    // And is repaid by yield after it opened: two months.
    env.advance(MONTH);
    let half = env.debt(second);
    assert!(half > 0 && half < env.stored(second).issued);
    env.advance(MONTH + 1);
    assert_eq!(env.debt(second), 0);

    // Unlock pays Principal plus exactly the free yield, once.
    let before = env.token_balance(alice.token);
    let supply = env.supply();
    env.unlock(&alice, pos).unwrap();
    let minted = env.supply() - supply;
    assert_eq!(env.token_balance(alice.token) - before, 10 * SOL + minted);
    assert!(minted > 0);
    let p = env.position(pos);
    assert_eq!(p.free_shares >> 32, 0, "the free yield was paid");
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
    let issued = env.stored(source).issued;
    assert!(debt > 0 && debt < issued);
    // Returning part of the line keeps the Advance open and lowers Left to pay back.
    env.return_own(&alice, pos, source, issued / 2).unwrap();
    assert_eq!(env.position(pos).open_advance, Some(0));
    assert!(env.debt(source) > 0 && env.debt(source) < debt);
    // Returning the rest clears it, closes the Advance and banks the yield beyond.
    let rest = env.gemas(&alice, source);
    env.return_own(&alice, pos, source, rest).unwrap();
    assert_eq!(env.debt(source), 0);
    let p = env.position(pos);
    assert_eq!(p.open_advance, None);
    assert_eq!(p.applied_net, env.accrued(pos));
    assert!(
        p.free_shares > 0,
        "the released coverage is the owner's free yield"
    );
    assert_eq!(env.stored(source).returned, issued);
    // Unlock pays it once, less the Yield Fee.
    let supply = env.supply();
    let free = p.free_shares >> 32;
    env.unlock(&alice, pos).expect("unlock after returning");
    assert_eq!((env.supply() - supply) as u128, free * 8_000 / 10_000);
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

// --- Yield Fee snapshot -------------------------------------------------------------------

// A fee change applies only to Advances opened afterwards: each Source keeps the Yield Fee and the
// Pool's share it was opened with (ticket 31, red-team #10).
#[test]
fn a_fee_change_never_applies_backwards() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let a = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, a, 1).unwrap();
    env.advance(300);
    let debt_before = env.debt(source);
    env.init_treasury(1_000, INSTANT_FEE_BPS).unwrap();
    assert_eq!(env.debt(source), debt_before, "the Debt did not move");
    let stored = env.stored(source);
    assert_eq!((stored.yield_fee_bps, stored.pool_bps), (2_000, 5_000));

    env.advance(100);
    let b = env.open(&bob, 4 * SOL).unwrap();
    assert_eq!(env.position(b).yield_fee_bps, 1_000);
    let bs = env.advance_native(&bob, b, 1).unwrap();
    assert_eq!(env.stored(bs).yield_fee_bps, 1_000);
    // The Advance is repaid at its Horizon: Gemas are the whole yield, whatever the fee.
    env.advance(2_000);
    assert_eq!(env.debt(source), 0);
}

#[test]
fn an_advance_is_sized_on_the_whole_yield() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    // 10 SOL at 7% for one month at $150: 0.0583 SOL = $8.74 = 874 Gemas (was 874 net of 20%).
    let issued = env.stored(source).issued;
    let principal = env.position(pos).principal;
    let expect = (principal as u128 * 700 / (10_000 * 12)) * PRICE as u128 / 10u128.pow(13);
    assert_eq!(issued as u128, expect);
    assert_eq!(issued, 874);
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
    unlock.accounts[6].pubkey = s(fake);
    assert!(env.send(&[unlock], &alice.kp, &[]).is_err());
    let mut redeem = env.redeem_to_ix(&alice, pos, source, 874, alice.token);
    redeem.accounts[8].pubkey = s(fake);
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
            economy: pda(&[ECONOMY_SEED]),
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
        let rate_open = env.rate();
        let pos = env.open(&alice, shares * SOL).unwrap();
        env.advance_native(&alice, pos, 2).unwrap();
        let base_supply = env.supply();

        for op in ops {
            let latest = env.position(pos).advances - 1;
            let source = env.source(pos, latest);
            match op {
                Op::Time(secs) => env.advance(secs),
                Op::Redeem(pct) => {
                    let amount = env.redeemable(&alice, source, SIDE_OWN) * pct / 100;
                    if amount > 0 {
                        let _ = env.redeem(&alice, pos, source, amount);
                    }
                }
                Op::Advance(months) => {
                    let _ = env.advance_native(&alice, pos, months);
                }
                Op::ReturnOwn(pct) => {
                    let amount = (env.gemas(&alice, source) * pct / 100).max(1).min(env.gemas(&alice, source));
                    if amount > 0 {
                        let _ = env.return_own(&alice, pos, source, amount);
                    }
                }
                Op::Unlock => {
                    let _ = env.unlock(&alice, pos);
                }
            }
            // Yield is minted only as paid, in shares of what landed, which never exceeds the
            // shares the net Accrued Yield was worth at the rate the Position opened at (the
            // rate only grows).
            let minted = env.supply() - base_supply;
            let landed = native::shares_for_units_floor(env.accrued(pos), rate_open).unwrap();
            prop_assert!(minted <= landed + 2, "minted {} landed {}", minted, landed);
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
    env.redeem(&alice, pos, source, 874).unwrap();
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
    // Three more months of the same Source, at the same price, as own Gemas of the first
    // Extension tranche (a class of its own, junior to everything issued before).
    assert_eq!(env.gemas(&alice, source), first);
    let ext = find_line(
        &env.svm,
        alice.account,
        source,
        SIDE_OWN,
        CLASS_GENERAL + 1,
        1,
    )
    .unwrap();
    assert_eq!(ext.amount, first);
    assert!(ext.due_at > env.stored(source).due_at - 3 * MONTH);
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
    let (book, _, _) = env.synced(source);
    let landed = book.h;
    assert!(landed > 0);
    env.extend_native(&alice, pos, source, 3).unwrap();
    // The book keeps the coverage already landed; it never drops, and the Extension starts unpaid.
    let after = read_book(&env.svm, source);
    assert!(after.h >= landed);
    assert!(env.debt(source) > 0);
    let ext = find_line(
        &env.svm,
        alice.account,
        source,
        SIDE_OWN,
        CLASS_GENERAL + 1,
        1,
    )
    .unwrap();
    assert_eq!(after.ready_of(&ext).unwrap(), 0);
}

impl Env {}

// --- Yield Fee, Instant Redeem and the Treasury (ADR 0007, economy upgrade) ---------------------

impl Env {
    fn treasury_vault(&self) -> APk {
        pda(&[TREASURY_VAULT_SEED])
    }
    fn treasury(&self) -> Treasury {
        self.load::<Treasury>(pda(&[TREASURY_SEED]))
    }
    fn route(&self) -> ledger::RouteLedger {
        self.custody().route
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
                custody: pda(&[NATIVE_SEED]),
                treasury_vault: self.treasury_vault(),
                admin_token,
                token_program: TOKEN_PROGRAM_ID,
            },
            instruction::FundTreasury { shares },
            vec![],
        );
        self.send(&[fund], &admin, &[])
    }

    /// The Platform recipient as a Person with an (empty) token account.
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
        self.make_ata(&p);
        p
    }

    fn make_ata(&mut self, p: &Person) {
        let admin = self.admin.insecure_clone();
        let ix = Instruction {
            program_id: s(ATA_PROGRAM_ID),
            accounts: vec![
                AccountMeta::new(s(a(admin.pubkey())), true),
                AccountMeta::new(s(p.token), false),
                AccountMeta::new_readonly(s(p.key), false),
                AccountMeta::new_readonly(s(self.mint), false),
                AccountMeta::new_readonly(s(anchor_lang::system_program::ID), false),
                AccountMeta::new_readonly(s(TOKEN_PROGRAM_ID), false),
            ],
            data: vec![1],
        };
        self.send(&[ix], &admin, &[]).expect("create token account");
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

    fn cash_in(
        &mut self,
        payer: &Keypair,
        pos: Pos,
        source: APk,
        class: u8,
        to: &Person,
    ) -> Result<(), Failed> {
        let mut remaining = self.kind_paying(pos, to.token);
        remaining.extend(book_metas(&self.svm, source));
        let ix = tix(
            accounts::CashInFee {
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                recipient_account: to.account,
                position: pos.position,
                source,
            },
            instruction::CashInFee { class },
            remaining,
        );
        self.send(&[ix], payer, &[])
    }

    /// What a fee counter can cash in now, in Gemas.
    fn covered_fee(&self, pos: Pos, source: APk, class: u8) -> u64 {
        let stored = self.stored(source);
        let mut position = self.position(pos);
        let pool = self.load::<sim_lst::Pool>(self.pool);
        let ts = self.svm.get_sysvar::<Clock>().unix_timestamp;
        let acc = native::position_accrued(&position, pool.speedup, ts).unwrap();
        let rate = ShareRate::native(sim_lst::current_rate(&pool, ts).unwrap()).unwrap();
        let mut book = read_book(&self.svm, source);
        let mut ck = MemCheckpoints::new(source.to_bytes());
        for c in 0..15u8 {
            for page_no in 0..4u32 {
                let k = ckpt_address(&source, c, page_no).0;
                if let Some(acct) = self.svm.get_account(&s(k)) {
                    ck.pages
                        .insert((c, page_no), acct.data[CKPT_PAGE_AT..].to_vec());
                }
            }
        }
        ledger::economy::sync_source(&mut position, &stored, &mut book, acc, &rate, &mut ck)
            .unwrap();
        let Some(counter) = econ::counter(&self.svm, source, class) else {
            return 0;
        };
        book.redeemable(&book.peek(&counter, &ck).unwrap()).unwrap()
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

    /// The Treasury Account's Gemas of a Source (basket and spill).
    fn treasury_gemas(&self, source: APk) -> u64 {
        gemas_in(&self.svm, treasury_account(), source)
    }

    fn lamports(&self, k: APk) -> u64 {
        self.svm.get_balance(&s(k)).unwrap_or(0)
    }

    fn order_address(&self, p: &Person, nonce: u64) -> APk {
        pda(&[INSTANT_ORDER_SEED, p.account.as_ref(), &nonce.to_le_bytes()])
    }

    fn request_ix(
        &self,
        p: &Person,
        pos: Pos,
        source: APk,
        sell: u64,
        ttl: i64,
        nonce: u64,
    ) -> Instruction {
        self.request_ix_paid_by(p, pos, source, sell, ttl, nonce, p.key, false)
    }

    /// `payer` pays the order's rent; `sponsored` passes the sponsor account.
    #[allow(clippy::too_many_arguments)]
    fn request_ix_paid_by(
        &self,
        p: &Person,
        pos: Pos,
        source: APk,
        sell: u64,
        ttl: i64,
        nonce: u64,
        payer: APk,
        sponsored: bool,
    ) -> Instruction {
        let mut remaining = self.kind_paying(pos, p.token);
        remaining.extend(book_metas(&self.svm, source));
        tix(
            accounts::RequestInstantRedeem {
                payer,
                holder_authority: p.key,
                holder_account: p.account,
                basket: self.basket(p),
                spill: self.spill(p),
                position: pos.position,
                source,
                order: self.order_address(p, nonce),
                sponsor: sponsored.then(|| sponsor_address().0),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::RequestInstantRedeem {
                line: self.line(source, SIDE_WON),
                sell,
                ttl_secs: ttl,
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
    ) -> Result<APk, Failed> {
        let ix = self.request_ix(p, pos, source, sell, 7 * DAY, nonce);
        self.send(&[ix], &p.kp, &[])
            .map(|_| self.order_address(p, nonce))
    }

    /// The owner sells Gemas of their own line (founder, 2026-10-22: Instant works on own Gemas).
    fn request_own(
        &mut self,
        p: &Person,
        pos: Pos,
        source: APk,
        sell: u64,
        nonce: u64,
    ) -> Result<APk, Failed> {
        let mut ix = self.request_ix(p, pos, source, sell, 7 * DAY, nonce);
        ix.data = instruction::RequestInstantRedeem {
            line: self.line(source, SIDE_OWN),
            sell,
            ttl_secs: 7 * DAY,
            nonce,
        }
        .data();
        self.send(&[ix], &p.kp, &[])
            .map(|_| self.order_address(p, nonce))
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
        let mut remaining = self.kind_paying(pos, seller.token);
        remaining.push(rem(self.treasury_vault(), true));
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
        self.return_order_ix_for(signer, seller, source, nonce, expire, seller.key, false)
    }

    /// `payer` is who paid the order's rent; `sponsored` passes the sponsor account.
    #[allow(clippy::too_many_arguments)]
    fn return_order_ix_for(
        &self,
        signer: &Person,
        seller: &Person,
        source: APk,
        nonce: u64,
        expire: bool,
        payer: APk,
        sponsored: bool,
    ) -> Instruction {
        let accounts = accounts::ReturnInstantRedeem {
            signer: signer.key,
            owner_account: seller.account,
            basket: self.basket(seller),
            spill: self.spill(seller),
            order: self.order_address(seller, nonce),
            owner_wallet: payer,
            sponsor: sponsored.then(|| sponsor_address().0),
        };
        let remaining = book_metas(&self.svm, source);
        if expire {
            tix(accounts, instruction::ExpireInstantRedeem {}, remaining)
        } else {
            tix(accounts, instruction::CancelInstantRedeem {}, remaining)
        }
    }

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
        let mut remaining = vec![
            rem(pos.custody, true),
            rem(pos.vault, true),
            rem(self.pool, false),
            rem(self.treasury_vault(), true),
            rem(self.mint, true),
            rem(sim_pda(&[sim_lst::YIELD_SEED]), false),
            rem(pda(&[YIELD_SEED]), false),
            rem(sim_lst::ID, false),
            rem(TOKEN_PROGRAM_ID, false),
        ];
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
}

#[test]
fn a_native_advance_is_the_whole_projected_yield() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 3).unwrap();
    // 10 SOL at 7% over 3 months = 0.175 SOL; at $150 = $26.25 = 2,625 (ticket 31: no fee factor).
    assert_eq!(env.gemas(&alice, source), 2_625);
    assert_eq!(env.load::<SourceState>(source).inner.issued, 2_625);
    // The Gemas are one General line of the owner's own side, due at the planned repayment date,
    // and the Source has its book.
    let line = find_line(&env.svm, alice.account, source, SIDE_OWN, CLASS_GENERAL, 0).unwrap();
    assert_eq!(line.amount, 2_625);
    assert_eq!(line.due_at, T0 + 3 * MONTH);
    assert_eq!(env.stored(source).due_at, T0 + 3 * MONTH);
    let book = read_book(&env.svm, source);
    assert_eq!(fp_ceil(book.uncovered_total()), 2_625);
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

impl Env {
    fn set_platform_fee(&mut self, platform_bps: u16) -> Result<(), Failed> {
        let admin = self.admin.insecure_clone();
        let config = self.load::<Config>(pda(&[CONFIG_SEED]));
        let update = tix(
            accounts::UpdateConfig {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                platform_recipient: config.platform_recipient,
                treasury: common::treasury(),
            },
            instruction::UpdateConfig {
                oracle_authority: a(self.oracle.pubkey()),
                platform_bps,
            },
            vec![],
        );
        self.send(&[update], &admin, &[])
    }

    fn set_leaderboard_fee(&mut self, leaderboard_bps: u16) -> Result<(), Failed> {
        let admin = self.admin.insecure_clone();
        let init = tix(
            accounts::InitLeaderboard {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                pool_authority: pda(&[LEADERBOARD_SEED]),
                pool_account: self.pool_account(),
                treasury: common::treasury(),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitLeaderboard { leaderboard_bps },
            vec![],
        );
        self.send(&[init], &admin, &[])
    }
}

/// Studio Fee Gemas skip the Yield Fee, so routing Gemas through a Studio must cost more in Platform
/// and Leaderboard Fees than it saves: `yield_fee x 10% <= platform + leaderboard` (red-team 31 #4).
/// Every setter of those rates refuses a change that breaks it.
#[test]
fn fees_that_would_pay_to_launder_gemas_through_a_studio_are_refused() {
    // Platform 2%, no Leaderboard yet, Yield Fee 20%: 20% x 10% = 2%, cost equals saving.
    let mut env = Env::new();
    let laundering = 6000 + TesoroError::StudioFeeLaundering as u32;
    let err = env.init_treasury(2_001, INSTANT_FEE_BPS).unwrap_err();
    assert_eq!(code(&err), laundering);
    let err = env.set_platform_fee(199).unwrap_err();
    assert_eq!(code(&err), laundering);
    // A 1% Leaderboard Fee raises the cost: a 30% Yield Fee fits, then neither fee can drop.
    env.set_leaderboard_fee(100).unwrap();
    env.init_treasury(3_000, INSTANT_FEE_BPS).unwrap();
    let err = env.set_leaderboard_fee(99).unwrap_err();
    assert_eq!(code(&err), laundering);
    let err = env.set_platform_fee(199).unwrap_err();
    assert_eq!(code(&err), laundering);
    let err = env.init_treasury(3_001, INSTANT_FEE_BPS).unwrap_err();
    assert_eq!(code(&err), laundering);
    // Nothing moved.
    assert_eq!(env.treasury().yield_fee_bps, 3_000);
    let config = env.load::<Config>(pda(&[CONFIG_SEED]));
    assert_eq!((config.platform_bps, config.leaderboard_bps), (200, 100));
    // Raising a cost is always fine.
    env.set_platform_fee(300).unwrap();
}

/// The Yield Fee is the Treasury's only once yield is cashed out (ticket 31): an open Position's
/// growing yield is not spendable; its free yield's fee is, once it unlocks.
#[test]
fn an_open_positions_fee_is_not_spendable_until_it_is_realised() {
    let mut env = Env::new();
    let alice = env.staker();
    let company = env.staker();
    env.set_company(company.key).unwrap();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    env.advance(MONTH);
    // Yield accrues but nothing has been cashed out, so nothing is spendable.
    assert!(env.accrued(pos) > 0);
    assert_eq!(env.route().spendable(), 0);
    let err = env.withdraw(company.token, 1_000).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::OverSpendable));
    assert_eq!(
        env.token_balance(company.token),
        10 * SOL,
        "only the faucet's simSOL"
    );
    // Unlock cashes out the free yield: its fee is realised, half Tesoro's to spend, half owed to
    // the Pool.
    let free = native::shares_for_units_floor(env.accrued(pos), env.rate()).unwrap();
    env.unlock(&alice, pos).unwrap();
    let fee_shares = u128::from(free - free * 8_000 / 10_000);
    let route = env.route();
    assert_eq!(route.treasury_shares, fee_shares);
    assert_eq!(route.pool_owed, fee_shares / 2);
    assert_eq!(route.spendable(), fee_shares - fee_shares / 2);
    // The Treasury may spend exactly its half, not a lamport of the Pool's.
    let spendable = route.spendable() as u64;
    let rate = env.rate();
    let units = native::shares_value(spendable, rate).unwrap();
    let too_much = units + 10;
    let err = env.withdraw(company.token, too_much).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::OverSpendable));
    let before = env.token_balance(company.token);
    env.withdraw(company.token, units)
        .expect("withdraw its half");
    let paid = env.token_balance(company.token) - before;
    assert_eq!(paid, native::shares_for_units_floor(units, rate).unwrap());
    assert_eq!(
        env.route().pool_owed,
        fee_shares / 2,
        "the Pool's half is untouched"
    );
    assert!(env.route().spendable() < 3);
}

#[test]
fn only_the_admin_withdraws_and_only_to_the_company_wallet() {
    let mut env = Env::new();
    let alice = env.staker();
    let company = env.staker();
    let mallory = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    env.advance(MONTH);
    env.unlock(&alice, pos).unwrap();
    let amount = native::shares_value(env.route().spendable() as u64, env.rate()).unwrap() / 2;
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
    env.withdraw(company.token, amount)
        .expect("the admin pays the company");
}

/// Funding is the Treasury's own: spendable at once, and never a Yield Fee, so nothing of it is
/// owed to the Pool.
#[test]
fn funding_is_spendable_and_owes_the_pool_nothing() {
    let mut env = Env::new();
    env.fund_treasury(3 * SOL).unwrap();
    let route = env.route();
    assert_eq!(
        (route.treasury_shares, route.pool_owed),
        (3 * SOL as u128, 0)
    );
    assert_eq!(route.spendable(), 3 * SOL as u128);
    assert_eq!(env.token_balance(env.treasury_vault()), 3 * SOL);
    let company = env.staker();
    env.set_company(company.key).unwrap();
    let before = env.token_balance(company.token);
    env.withdraw(company.token, SOL).unwrap();
    assert_eq!(
        env.token_balance(company.token) - before,
        native::shares_for_units_floor(SOL, env.rate()).unwrap()
    );
    assert!(env.route().spendable() < 3 * SOL as u128 - SOL as u128 + 2);
}

/// The whole Instant Redeem path: request, a partial fill at 60% of the value at fill (the Yield
/// Fee, then the 25% Instant fee, one floor) from the spendable shares, cancel of the rest.
#[test]
fn an_instant_redeem_is_an_order_the_treasury_fills_at_60_percent() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let admin_funding = 5 * SOL;
    env.fund_treasury(admin_funding).unwrap();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 12).unwrap();
    env.give_won(&alice, &bob, source, 2_000);
    env.advance(3 * MONTH);
    let supply = env.supply();
    // Bob offers 1,500: the repaid quarter is simply Redeemed (less the Yield Fee), the rest waits.
    let order = env.request(&bob, pos, source, 1_500, 1).expect("request");
    let state = env.load::<InstantOrderState>(order);
    let repaid = 2_000 - 1_500 - env.gemas(&bob, source);
    assert_eq!(state.requested, 1_500);
    assert_eq!(state.owner, bob.key);
    let redeemed_shares = env.token_balance(bob.token) - 10 * SOL;
    assert!(redeemed_shares > 0, "the repaid part pays at once");
    assert_eq!(env.supply() - supply, redeemed_shares);
    // ... less the Yield Fee, like any Redeem (red-team #3): the fee is the Treasury's now.
    let after_request = env.route();
    let fee = after_request.treasury_shares - (5 * SOL) as u128;
    assert!(fee > 0);
    assert!(u128::from(redeemed_shares) * 2_500 / 10_000 <= fee + 1);
    assert_eq!(after_request.pool_owed, fee / 2);
    assert_eq!(
        env.gemas(&bob, source),
        500 - repaid,
        "the order took the rest from the basket"
    );
    let line = ledger::line_store::Line::decode(&state.line);
    assert_eq!(
        (line.amount, line.side, line.class, line.tranche),
        (1_500, SIDE_WON, CLASS_GENERAL, 0)
    );

    // The fill authority is the admin; nobody else, and not the keeper while its rule is off.
    let mallory = env.person();
    let ix = env.fill_ix(mallory.key, &bob, pos, source, 1, 100);
    let err = env.send(&[ix], &mallory.kp, &[]).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::NotFillAuthority));

    // A partial fill: 60% of the value of 600 Gemas at this instant, paid from the Treasury.
    let rate = env.rate();
    let units = env.stored(source).units_for(600).unwrap();
    let value = native::shares_for_units_floor(units, rate).unwrap();
    let before = env.token_balance(bob.token);
    let route_before = env.route();
    env.fill(&bob, pos, source, 1, 600).expect("fill");
    let paid = env.token_balance(bob.token) - before;
    // The ready part that appeared while the order waited is Redeemed at full value too.
    let order_state = env.load::<InstantOrderState>(order);
    let waited = order_state.redeemed_while_open;
    assert_eq!(order_state.sold, 600);
    let payout = order_state.paid_shares;
    assert!(payout > 0 && payout <= value as u128 * 6_000 / 10_000 + 1);
    assert!(payout * 10_000 >= (value as u128 - 4) * 6_000);
    assert!(paid >= payout as u64, "{paid} {payout} waited {waited}");
    assert_eq!(env.treasury_gemas(source), 600);
    let route = env.route();
    // The payout left; any ready part Redeemed at the fill paid its Yield Fee in.
    assert!(route.treasury_shares + payout >= route_before.treasury_shares);
    if waited == 0 {
        assert_eq!(route.treasury_shares, route_before.treasury_shares - payout);
    }
    // The Treasury's basket kept the seller's class and tranche.
    let bought = find_line(
        &env.svm,
        treasury_account(),
        source,
        SIDE_WON,
        CLASS_GENERAL,
        0,
    )
    .unwrap();
    assert_eq!(bought.amount, 600);

    // The seller cancels the rest: the exact line comes back.
    let remaining = ledger::line_store::Line::decode(&order_state.line).amount;
    let cancel = env.return_order_ix(&bob, &bob, source, 1, false);
    env.send(&[cancel], &bob.kp, &[]).expect("cancel");
    assert!(
        env.svm
            .get_account(&s(order))
            .is_none_or(|acc| acc.data.is_empty()),
        "the order closed"
    );
    assert!(remaining > 0);
    env.check_invariants(&[pos]);
}

#[test]
fn a_sponsored_order_costs_the_player_nothing_and_the_sponsor_gets_its_rent_back() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 12).unwrap();
    env.give_won(&alice, &bob, source, 2_000);
    let relayer = Keypair::new();
    env.svm.airdrop(&relayer.pubkey(), 10 * SOL).unwrap();
    let admin = env.admin.insecure_clone();
    let init = tix(
        accounts::InitSponsor {
            admin: a(admin.pubkey()),
            config: pda(&[CONFIG_SEED]),
            sponsor: sponsor_address().0,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::InitSponsor {
            relayer: a(relayer.pubkey()),
            per_account_cap: SOL,
            total_cap: 10 * SOL,
            pages_cap: SOL,
        },
        vec![],
    );
    env.send(&[init], &admin, &[]).unwrap();
    env.svm.airdrop(&s(sponsor_address().0), 5 * SOL).unwrap();
    let rent = env
        .svm
        .minimum_balance_for_rent_exemption(InstantOrderState::SPACE);

    // With the sponsor accounts only the sponsor's relayer may pay; without them only the holder.
    let stranger = env.person();
    let no_sponsor =
        env.request_ix_paid_by(&bob, pos, source, 1_500, 7 * DAY, 1, stranger.key, false);
    let err = env
        .send(&[no_sponsor], &stranger.kp, &[&bob.kp])
        .unwrap_err();
    assert_eq!(code(&err), 6000, "no sponsor: only the holder pays");
    let wrong = env.request_ix_paid_by(&bob, pos, source, 1_500, 7 * DAY, 1, stranger.key, true);
    let err = env.send(&[wrong], &stranger.kp, &[&bob.kp]).unwrap_err();
    assert_eq!(code(&err), 6304, "only the sponsor's relayer");

    let rkey = a(relayer.pubkey());
    let ix = env.request_ix_paid_by(&bob, pos, source, 1_500, 7 * DAY, 1, rkey, true);
    let (bob_before, relayer_before) = (env.lamports(bob.key), env.lamports(rkey));
    let sponsor_before = env.lamports(sponsor_address().0);
    env.send(&[ix], &relayer, &[&bob.kp])
        .expect("sponsored request");
    let order = env.order_address(&bob, 1);
    let state = env.load::<InstantOrderState>(order);
    assert_eq!(state.payer, rkey);
    assert_eq!(state.sponsored_lamports, rent);
    assert_eq!(env.lamports(bob.key), bob_before, "the Player paid nothing");
    // The relayer fronted the rent and was made whole (only the two-signature fee is its own).
    assert_eq!(env.lamports(rkey), relayer_before - 10_000);
    assert_eq!(env.lamports(sponsor_address().0), sponsor_before - rent);
    assert_eq!(
        env.load::<SponsorState>(sponsor_address().0).outstanding,
        rent
    );

    // Closing without the sponsor account cannot strand its rent.
    let cancel = env.return_order_ix_for(&bob, &bob, source, 1, false, rkey, false);
    let err = env.send(&[cancel], &bob.kp, &[]).unwrap_err();
    assert_eq!(code(&err), 6307);

    // With it the rent goes back to the sponsor and the Player's Gemas come back.
    let cancel = env.return_order_ix_for(&bob, &bob, source, 1, false, rkey, true);
    env.send(&[cancel], &bob.kp, &[]).expect("cancel");
    assert_eq!(env.lamports(sponsor_address().0), sponsor_before);
    assert_eq!(env.load::<SponsorState>(sponsor_address().0).outstanding, 0);
    assert_eq!(env.gemas(&bob, source), 2_000);
}

#[test]
fn a_fill_cannot_spend_more_than_the_treasury_may_and_an_order_expires() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 12).unwrap();
    env.give_won(&alice, &bob, source, 2_000);
    let order = env.request(&bob, pos, source, 2_000, 5).expect("request");
    assert!(env.gemas(&bob, source) == 0);
    // An empty Treasury: nothing is spendable, so no fill, however small.
    let err = env.fill(&bob, pos, source, 5, 10).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::OverSpendable));
    // Not yet expired: nobody but the seller can take it back.
    let carol = env.person();
    let early = env.return_order_ix(&carol, &bob, source, 5, true);
    let err = env.send(&[early], &carol.kp, &[]).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::NotExpired));
    let not_owner = env.return_order_ix(&carol, &bob, source, 5, false);
    let err = env.send(&[not_owner], &carol.kp, &[]).unwrap_err();
    assert_eq!(code(&err), 6000);
    // After the deadline anyone returns it, and the line is exactly as it was.
    env.advance(7 * DAY + 1);
    let late = env.return_order_ix(&carol, &bob, source, 5, true);
    env.send(&[late], &carol.kp, &[]).expect("expire");
    assert_eq!(env.gemas(&bob, source), 2_000);
    assert!(env
        .svm
        .get_account(&s(order))
        .is_none_or(|acc| acc.data.is_empty()));
}

#[test]
fn the_treasury_redeems_what_it_bought_and_owes_the_pool_its_share() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    env.fund_treasury(5 * SOL).unwrap();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 12).unwrap();
    env.give_won(&alice, &bob, source, 3_000);
    env.request(&bob, pos, source, 3_000, 1).unwrap();
    env.fill(&bob, pos, source, 1, 3_000).expect("fill all");
    let vault_before = env.token_balance(env.treasury_vault());
    let route_before = env.route();
    // Yield lands as time passes; anyone may redeem for the Treasury, paying the vault.
    env.advance(12 * MONTH);
    let payer = env.person();
    let ready = {
        let (book, _, ck) = env.synced(source);
        let line = find_line(
            &env.svm,
            treasury_account(),
            source,
            SIDE_WON,
            CLASS_GENERAL,
            0,
        )
        .unwrap();
        book.redeemable(&book.peek(&line, &ck).unwrap()).unwrap()
    };
    assert!(ready > 0);
    env.redeem_treasury(&payer.kp, pos, source, ready)
        .expect("redeem treasury");
    let refill = env.token_balance(env.treasury_vault()) - vault_before;
    assert!(refill > 0);
    let route = env.route();
    assert_eq!(
        route.treasury_shares,
        route_before.treasury_shares + refill as u128,
        "every share of the refill is the Treasury's"
    );
    // Not exempt (red-team #4): the Pool is owed its half of the Yield Fee plus one fifth of the
    // 25% Instant fee on the value after the Yield Fee (founder: $8.00 -> $1.00 + $0.40 per 1,000).
    let paid = u128::from(refill);
    let after_fee = paid * 8_000 / 10_000;
    let fee = paid - after_fee;
    let pool = fee * 5_000 / 10_000 + after_fee * 500 / 10_000;
    assert_eq!(route.pool_owed - route_before.pool_owed, pool);
    assert_eq!(env.treasury_gemas(source), 3_000 - ready);
}

#[test]
fn an_owner_can_cash_out_their_own_gemas_instantly() {
    let mut env = Env::new();
    let alice = env.staker();
    env.fund_treasury(5 * SOL).unwrap();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 12).unwrap();
    let own = env.gemas(&alice, source);
    let order = env
        .request_own(&alice, pos, source, 1_000, 1)
        .expect("own Gemas are for sale");
    let state = env.load::<InstantOrderState>(order);
    let line = ledger::line_store::Line::decode(&state.line);
    assert_eq!((line.amount, line.side), (1_000, SIDE_OWN));
    assert_eq!(env.gemas(&alice, source), own - 1_000);
    let rate = env.rate();
    let units = env.stored(source).units_for(1_000).unwrap();
    let value = native::shares_for_units_floor(units, rate).unwrap();
    let before = env.token_balance(alice.token);
    env.fill(&alice, pos, source, 1, 1_000).expect("fill");
    let paid = env.token_balance(alice.token) - before;
    assert!(
        paid as u128 <= value as u128 * 6_000 / 10_000 + 1,
        "{paid} of {value}"
    );
    assert!(paid as u128 * 10_000 >= (value as u128 - 4) * 6_000);
    // The Treasury holds the owner's Gemas now, still on the own side of the Source.
    let bought = find_line(
        &env.svm,
        treasury_account(),
        source,
        SIDE_OWN,
        CLASS_GENERAL,
        0,
    )
    .unwrap();
    assert_eq!(bought.amount, 1_000);
    env.check_invariants(&[pos]);
}

/// Return then Unlock does not get around the fee (red-team #1/#2): the ready part `return_own`
/// releases comes back as free yield and pays the Yield Fee at Unlock, once.
#[test]
fn returning_own_gemas_then_unlocking_pays_the_fee_once() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH);
    let all = env.gemas(&alice, source);
    env.return_own(&alice, pos, source, all)
        .expect("return all");
    assert_eq!(
        env.route().treasury_shares,
        0,
        "returning cashes nothing out"
    );
    let free = (env.position(pos).free_shares >> 32) as u64;
    assert!(free > 0);
    let before = env.token_balance(alice.token);
    let supply = env.supply();
    env.unlock(&alice, pos).expect("unlock");
    let got = env.token_balance(alice.token) - before;
    let fee = free - free * 8_000 / 10_000;
    // Principal back from the vault, the free yield minted less its fee.
    assert!(
        got >= 10 * SOL + free - fee && got <= 10 * SOL + free - fee + 1,
        "{got}"
    );
    assert!(env.supply() - supply <= free - fee + 1);
    let route = env.route();
    assert!(
        route.treasury_shares >= u128::from(fee) && route.treasury_shares <= u128::from(fee) + 1
    );
    assert_eq!(route.pool_owed, route.treasury_shares / 2);
}

// --- On-chain prices (ADR 0011) -------------------------------------------------------------

const PYTH_SOL_USD: [u8; 32] = [0xef; 32];
const PYTH_ETH_USD: [u8; 32] = [0xff; 32];
const PYTH_RECEIVER_ID: APk = tesoro_core::pyth::PYTH_RECEIVER;
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
                pool: self.pool,
                source,
                book: book_address(&source).0,
                basket: self.basket(p),
                spill: self.spill(p),
                economy: pda(&[ECONOMY_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::TakeNativeAdvanceOnchain {
                horizon_months: months,
                min_gemas: 1,
            },
            self.prev_tail(pos),
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
        self.send(&[ix], &p.kp, &[])?;
        self.ensure_pages(source);
        Ok(source)
    }
}

/// A simSOL Position of 10 SOL and a SOL/USD feed mapped to its asset.
fn priced_env() -> (Env, Person, Pos, APk) {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let feed = APk::new_unique();
    let now = env.now();
    put_feed(&mut env, feed, PYTH_SOL_USD, FEED_150, 5_000_000, now);
    let mint = env.mint;
    map_price(&mut env, mint, feed, PYTH_SOL_USD).expect("map");
    (env, alice, pos, feed)
}

#[test]
fn a_self_excluded_owner_takes_no_feed_priced_advance() {
    let (mut env, alice, pos, feed) = priced_env();
    env.self_exclude(&alice, 6).unwrap();
    let err = env.advance_onchain(&alice, pos, feed, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::SelfExcluded));
}

#[test]
fn a_fresh_feed_prices_the_advance() {
    let (mut env, alice, pos, feed) = priced_env();
    let source = env.advance_onchain(&alice, pos, feed, 1).expect("advance");
    // 10 SOL at 7% for a month, the whole yield, at the feed's $150: the same 874 Gemas
    // the keeper-priced Advance gives at $150.
    assert_eq!(env.gemas(&alice, source), 874);
    assert_eq!(env.load::<SourceState>(source).inner.unit_den, 150_000_000);
    assert_eq!(env.debt(source), 874);
}

#[test]
fn a_second_feed_priced_advance_closes_the_repaid_one() {
    let (mut env, alice, pos, feed) = priced_env();
    env.advance_onchain(&alice, pos, feed, 1).unwrap();
    env.advance(MONTH + 1);
    let now = env.now();
    put_feed(&mut env, feed, PYTH_SOL_USD, FEED_150, 5_000_000, now);
    let second = env.advance_onchain(&alice, pos, feed, 1).expect("second");
    assert_eq!(env.position(pos).open_advance, Some(1));
    assert!(env.gemas(&alice, second) > 0);
    // Without the repaid Source the Advance is refused.
    env.advance(MONTH + 1);
    let now = env.now();
    put_feed(&mut env, feed, PYTH_SOL_USD, FEED_150, 5_000_000, now);
    let mut bare = env.advance_onchain_ix(&alice, pos, feed, 1);
    // The previous Source, its book and its pages are the remaining accounts: leave them out.
    bare.accounts.truncate(13);
    let err = env.send(&[bare], &alice.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_SOURCE_REQUIRED);
}

#[test]
fn the_exponent_and_a_non_round_price_convert_to_micro_usd() {
    let (mut env, alice, pos, feed) = priced_env();
    let now = env.now();
    // $103.22918088: 103,229,180 micro-USD floored.
    put_feed(&mut env, feed, PYTH_SOL_USD, 10_322_918_088, 3_356_136, now);
    let source = env.advance_onchain(&alice, pos, feed, 1).unwrap();
    assert_eq!(env.load::<SourceState>(source).inner.unit_den, 103_229_180);
    assert_eq!(env.gemas(&alice, source), 602);
}

#[test]
fn a_stale_price_refuses_the_advance_until_it_is_fresh() {
    let (mut env, alice, pos, feed) = priced_env();
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
    let (mut env, alice, pos, feed) = priced_env();
    let now = env.now();
    put_feed(&mut env, feed, PYTH_SOL_USD, FEED_150, 5_000_000, now + 60);
    let err = env.advance_onchain(&alice, pos, feed, 1).unwrap_err();
    assert_eq!(code(&err), ERR_STALE_PRICE);
}

#[test]
fn a_wide_confidence_interval_refuses_the_advance() {
    let (mut env, alice, pos, feed) = priced_env();
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
    let (mut env, alice, pos, feed) = priced_env();
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
}

#[test]
fn only_the_admin_maps_a_feed_and_only_a_pyth_account_can_be_mapped() {
    let mut env = Env::new();
    let mint = env.mint;
    let feed = APk::new_unique();
    let now = env.now();
    put_feed(&mut env, feed, PYTH_SOL_USD, FEED_150, 0, now);
    let oracle = env.oracle.insecure_clone();
    let by_oracle = set_onchain_price_ix(a(oracle.pubkey()), mint, feed, PYTH_SOL_USD, 90, 100);
    let err = env.send(&[by_oracle], &oracle, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_UNAUTHORIZED);
    // The feed account must carry the id given.
    let err = map_price(&mut env, mint, feed, PYTH_ETH_USD).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_PRICE_FEED);
    // And be owned by the Pyth receiver.
    let fake = APk::new_unique();
    put_account(
        &mut env,
        fake,
        APk::new_unique(),
        pyth_image(PYTH_SOL_USD, FEED_150, 0, now),
    );
    let err = map_price(&mut env, mint, fake, PYTH_SOL_USD).unwrap_err();
    assert_eq!(code(&err), ERR_BAD_PRICE_FEED);
    // Limits beyond the program's own are refused.
    let admin = env.admin.insecure_clone();
    for (age, conf) in [(0u32, 100u16), (121, 100), (90, 0), (90, 501)] {
        let set = set_onchain_price_ix(a(admin.pubkey()), mint, feed, PYTH_SOL_USD, age, conf);
        let err = env.send(&[set], &admin, &[]).unwrap_err();
        assert_eq!(code(&err), ERR_BAD_PRICE_FEED, "{age} {conf}");
    }
    map_price(&mut env, mint, feed, PYTH_SOL_USD).expect("admin maps");
}

#[test]
fn an_unmapped_asset_cannot_use_the_onchain_advance() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
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
                book: book_address(&source).0,
                basket: basket_address(&p.account).0,
                spill: spill_address(&p.account).0,
                economy: pda(&[ECONOMY_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::TakeAdvanceOnchain {
                horizon_months: 3,
                min_gemas: 1,
            },
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
                book: book_address(&source).0,
                basket: basket_address(&p.account).0,
                spill: spill_address(&p.account).0,
                economy: pda(&[ECONOMY_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::TakeAdvance {
                horizon_months: 3,
                price_micro_usd: price,
                min_gemas: 1,
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
    // 10 ETH at 4% for 3 months = 0.1 ETH at $3,000 = 30,000 cents.
    assert_eq!(env.load::<SourceState>(source).inner.issued, 30_000);
}

#[test]
fn a_native_sources_covered_fees_go_to_their_recipients() {
    let mut env = Env::with_start(SEASON_1_START + 10);
    let alice = env.staker();
    let platform = env.platform_person();
    let studio = env.staker();
    env.set_studio(studio.account).expect("studio recipient");
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 12).unwrap();
    for (class, k) in [(0u8, 300u64), (1, 200)] {
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
    let payer = env.person();
    // The Platform Fee is covered first; the Studio Fee only after it.
    env.advance(MONTH);
    let (p, st) = (
        env.covered_fee(pos, source, 0),
        env.covered_fee(pos, source, 1),
    );
    assert!(p > 0 && p <= 300, "{p}");
    let before = env.token_balance(platform.token);
    let route_before = env.route();
    let supply = env.supply();
    env.cash_in(&payer.kp, pos, source, 0, &platform)
        .expect("platform");
    assert!(env.token_balance(platform.token) > before);
    assert_eq!(econ::counter(&env.svm, source, 0).unwrap().amount, 300 - p);
    // Fee classes are exempt from the Yield Fee (founder, 2026-10-22): the whole value is minted
    // to the recipient and nothing joins the Treasury or the Pool.
    assert_eq!(
        env.token_balance(platform.token) - before,
        env.supply() - supply
    );
    assert_eq!(env.route(), route_before);
    assert_eq!(env.stored(source).fee_units, 0);
    let _ = st;
    // The Studio Fee goes to the Studio recipient and only there.
    env.advance(MONTH);
    assert!(env.cash_in(&payer.kp, pos, source, 1, &platform).is_err());
    let s_cov = env.covered_fee(pos, source, 1);
    env.cash_in(&payer.kp, pos, source, 1, &studio)
        .expect("studio");
    assert_eq!(
        econ::counter(&env.svm, source, 1).unwrap().amount,
        200 - s_cov
    );
    // Nothing more is covered right now: repeating pays nothing.
    let bal = env.token_balance(studio.token);
    assert!(env.cash_in(&payer.kp, pos, source, 1, &studio).is_err());
    assert_eq!(env.token_balance(studio.token), bal);
    // Gemas still redeem and the custody still unlocks after the cash-ins.
    env.advance(11 * MONTH);
    if econ::counter(&env.svm, source, 0).unwrap().amount > 0 {
        env.cash_in(&payer.kp, pos, source, 0, &platform)
            .expect("rest of Platform");
    }
    if econ::counter(&env.svm, source, 1).unwrap().amount > 0 {
        env.cash_in(&payer.kp, pos, source, 1, &studio)
            .expect("rest of Studio");
    }
    assert_eq!(econ::counter(&env.svm, source, 0).unwrap().amount, 0);
    assert_eq!(econ::counter(&env.svm, source, 1).unwrap().amount, 0);
    env.unlock(&alice, pos).expect("unlock after cash-ins");
}

#[test]
fn an_evm_sources_fee_cash_in_is_the_bridges_and_records_the_units_it_owes() {
    let mut env = Env::new();
    let alice = env.staker();
    let studio = env.person();
    env.set_studio(studio.account).expect("studio recipient");
    let position = evm_position(&mut env, &alice, APk::new_unique());
    let oracle = env.oracle.insecure_clone();
    let adv = evm_advance_ix(&env, &alice, position, None, 1_000_000_000_000);
    env.send(&[adv], &oracle, &[&alice.kp]).expect("advance");
    let source = pda(&[SOURCE_SEED, position.as_ref(), &0u32.to_le_bytes()]);
    env.ensure_pages(source);
    econ::fee_cut(
        &mut env.svm,
        source,
        alice.account,
        CLASS_GENERAL,
        0,
        1,
        300,
    );
    // The oracle reports the yield (test mode), so the Studio counter is covered.
    let apply = tix(
        accounts::ApplyYield {
            oracle: a(oracle.pubkey()),
            config: pda(&[CONFIG_SEED]),
            position,
            source: Some(source),
        },
        instruction::ApplyYield {
            seq: 1,
            cumulative: 50_000_000_000_000_000,
        },
        book_metas(&env.svm, source),
    );
    env.send(&[apply], &oracle, &[]).expect("yield");
    let bridge = Keypair::new();
    env.svm.airdrop(&bridge.pubkey(), SOL).unwrap();
    let admin = env.admin.insecure_clone();
    let reg = tix(
        accounts::SetSourceAuthority {
            admin: a(admin.pubkey()),
            config: pda(&[CONFIG_SEED]),
            source_authority: pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::SetSourceAuthority {
            chain: ledger::SourceChain::Ethereum,
            authority: a(bridge.pubkey()),
        },
        vec![],
    );
    env.send(&[reg], &admin, &[]).expect("register the bridge");
    let from_source = |env: &Env, signer: &Keypair, to: APk, class: u8, min_units: u64| {
        tix(
            accounts::CashInFeeFromSource {
                source_signer: a(signer.pubkey()),
                source_authority: pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                recipient_account: to,
                position,
                source,
            },
            instruction::CashInFeeFromSource { class, min_units },
            book_metas(&env.svm, source),
        )
    };
    // Solana's own cash-in refuses an EVM Source; only the registered bridge may use the twin.
    let payer = env.person();
    let err = env
        .cash_in(
            &payer.kp,
            Pos {
                position,
                custody: APk::default(),
                vault: APk::default(),
            },
            source,
            1,
            &studio,
        )
        .unwrap_err();
    assert_eq!(code(&err), 6000 + TesoroError::BridgedSource as u32);
    let ix = from_source(&env, &payer.kp, studio.account, 1, 0);
    let err = env.send(&[ix], &payer.kp, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_UNAUTHORIZED);
    // The recipient needs an EVM address, and the fee goes to its own recipient only.
    let ix = from_source(&env, &bridge, studio.account, 1, 0);
    let err = env.send(&[ix], &bridge, &[]).unwrap_err();
    assert_eq!(code(&err), 6000 + TesoroError::EvmNotLinked as u32);
    let link = tix(
        accounts::SetEvmAddress {
            authority: studio.key,
            account: studio.account,
        },
        instruction::SetEvmAddress {
            evm_address: [7; 20],
        },
        vec![],
    );
    env.send(&[link], &studio.kp, &[]).expect("link");
    let ix = from_source(&env, &bridge, alice.account, 1, 0);
    let err = env.send(&[ix], &bridge, &[]).unwrap_err();
    assert_eq!(code(&err), ERR_UNAUTHORIZED);
    // A batch minimum above what is covered leaves everything as it was.
    let ix = from_source(&env, &bridge, studio.account, 1, u64::MAX);
    assert!(env.send(&[ix], &bridge, &[]).is_err());
    assert_eq!(econ::counter(&env.svm, source, 1).unwrap().amount, 300);
    let before = env.stored(source).redeemed_units;
    let ix = from_source(&env, &bridge, studio.account, 1, 1);
    env.send(&[ix], &bridge, &[]).expect("cash in");
    let after = env.stored(source);
    assert!(after.redeemed_units > before, "the units owed are recorded");
    let left = econ::counter(&env.svm, source, 1).unwrap().amount;
    assert_eq!(after.redeemed, 300 - left);
    assert!(left < 300);
    // Repeating pays nothing.
    let ix = from_source(&env, &bridge, studio.account, 1, 0);
    let err = env.send(&[ix], &bridge, &[]).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::ZeroAmount));
}

#[test]
fn a_self_exclusion_stops_new_and_extended_advances_but_a_break_does_not() {
    let mut env = Env::new();
    let alice = env.staker();
    let (pos, source) = lost_advance(&mut env, &alice);
    env.take_break(&alice, 7).unwrap();
    env.extend_native(&alice, pos, source, 1)
        .expect("a Break leaves Extends open");
    let pos_b = env.open(&alice, SOL).expect("a Break leaves locking open");
    env.advance_native(&alice, pos_b, 3)
        .expect("a Break leaves Advances open");

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
fn repayment_redeem_and_unlock_work_during_a_self_exclusion() {
    let mut env = Env::new();
    let alice = env.staker();
    let pos = env.open(&alice, 2 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    let gemas = env.gemas(&alice, source);
    env.self_exclude(&alice, 6).unwrap();
    env.advance(MONTH + 1);
    assert_eq!(env.debt(source), 0, "Debt is computed, not cranked");
    env.redeem(&alice, pos, source, gemas / 2).expect("redeem");
    env.unlock(&alice, pos).expect("unlock");
}

// --- Harvest, the Season prize and prize Redeem (ticket 11) -----------------------------------

const SEASON_1_START: i64 = tesoro_core::ledger::SEASON_EPOCH;
const SEASON_SECS: i64 = tesoro_core::ledger::SEASON_SECS;

impl Env {
    fn pool_account(&self) -> APk {
        pda(&[ACCOUNT_SEED, pda(&[LEADERBOARD_SEED]).as_ref()])
    }

    /// The Leaderboard Pool Account (1% fee) with its basket and spill.
    fn init_pool(&mut self) {
        let admin = self.admin.insecure_clone();
        let init = tix(
            accounts::InitLeaderboard {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                pool_authority: pda(&[LEADERBOARD_SEED]),
                pool_account: self.pool_account(),
                treasury: common::treasury(),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitLeaderboard {
                leaderboard_bps: 100,
            },
            vec![],
        );
        self.send(&[init], &admin, &[]).expect("init leaderboard");
        let stores = tix(
            accounts::InitStores {
                payer: a(admin.pubkey()),
                account: self.pool_account(),
                basket: basket_address(&self.pool_account()).0,
                spill: spill_address(&self.pool_account()).0,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitStores {},
            vec![],
        );
        self.send(&[stores], &admin, &[]).expect("pool stores");
    }

    fn set_escrow(&mut self, on: bool) {
        let admin = self.admin.insecure_clone();
        let set = tix(
            accounts::SetPrizeEscrow {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                custody: pda(&[NATIVE_SEED]),
            },
            instruction::SetPrizeEscrow { enabled: on },
            vec![],
        );
        self.send(&[set], &admin, &[]).expect("escrow switch");
    }

    fn keeper_economy(&mut self, keeper: APk) {
        let admin = self.admin.insecure_clone();
        let set = tix(
            accounts::SetEconomy {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetEconomy {
                season_keeper: keeper,
                fill_keeper: APk::default(),
                keeper_fills: false,
                routes: [
                    pda(&[NATIVE_SEED]),
                    APk::default(),
                    APk::default(),
                    APk::default(),
                ],
            },
            vec![],
        );
        self.send(&[set], &admin, &[]).expect("economy");
    }

    fn harvest(&mut self, payer: &Keypair, pos: Pos, source: APk) -> Result<(), Failed> {
        let mut remaining = vec![rem(pos.custody, true), rem(self.pool, false)];
        remaining.extend(book_metas(&self.svm, source));
        let harvest = tix(
            accounts::Harvest {
                position: pos.position,
                source,
            },
            instruction::Harvest {},
            remaining,
        );
        self.send(&[harvest], payer, &[])
    }

    fn prize_source(&self, season: u32) -> APk {
        pda(&[
            PRIZE_SOURCE_SEED,
            pda(&[NATIVE_SEED]).as_ref(),
            &season.to_le_bytes(),
        ])
    }

    fn fund_prize(&mut self, signer: &Keypair, season: u32) -> Result<APk, Failed> {
        let ps = self.prize_source(season);
        let fund = tix(
            accounts::FundSeasonPrizeNative {
                authority: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                custody: pda(&[NATIVE_SEED]),
                pool: self.pool,
                price_feed: pda(&[PRICE_SEED, SIM_SOL_MINT.as_ref()]),
                pool_account: self.pool_account(),
                pool_basket: basket_address(&self.pool_account()).0,
                pool_spill: spill_address(&self.pool_account()).0,
                prize_source: ps,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::FundSeasonPrizeNative { season },
            vec![],
        );
        self.send(&[fund], signer, &[]).map(|_| ps)
    }

    /// `fund_prize` for a Pool whose stores may be full: the record and the system program travel
    /// as remaining accounts and the authority pays the record's rent.
    fn fund_prize_overflow(&mut self, signer: &Keypair, season: u32) -> Result<APk, Failed> {
        let ps = self.prize_source(season);
        let id =
            tesoro_core::instructions::overflow::route_overflow_id(season, &pda(&[NATIVE_SEED]));
        let record = overflow_address(&self.pool_account(), OVERFLOW_ROUTE, &id).0;
        let fund = tix(
            accounts::FundSeasonPrizeNative {
                authority: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                custody: pda(&[NATIVE_SEED]),
                pool: self.pool,
                price_feed: pda(&[PRICE_SEED, SIM_SOL_MINT.as_ref()]),
                pool_account: self.pool_account(),
                pool_basket: basket_address(&self.pool_account()).0,
                pool_spill: spill_address(&self.pool_account()).0,
                prize_source: ps,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::FundSeasonPrizeNative { season },
            vec![
                rem(record, true),
                rem(anchor_lang::system_program::ID, false),
            ],
        );
        self.send(&[fund], signer, &[]).map(|_| ps)
    }

    fn record_season(
        &mut self,
        signer: &Keypair,
        number: u32,
        ranked: &[(&Person, u64)],
    ) -> Result<(), Failed> {
        let mut remaining: Vec<AccountMeta> =
            ranked.iter().map(|(p, _)| rem(p.account, false)).collect();
        remaining.push(rem(pda(&[NATIVE_SEED]), false));
        let record = tix(
            accounts::RecordSeason {
                authority: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                pool_account: self.pool_account(),
                pool_basket: basket_address(&self.pool_account()).0,
                pool_spill: spill_address(&self.pool_account()).0,
                reservations: pda(&[POOL_RESERVATIONS_SEED]),
                season: pda(&[SEASON_SEED, &number.to_le_bytes()]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::RecordSeason {
                number,
                points: ranked.iter().map(|(_, pts)| *pts).collect(),
            },
            remaining,
        );
        self.send(&[record], signer, &[])
    }

    fn pay_rank(
        &mut self,
        signer: &Keypair,
        season: u32,
        rank: u8,
        line: u8,
        winner: &Person,
        prize_source: APk,
    ) -> Result<(), Failed> {
        let pay = tix(
            accounts::PaySeasonRank {
                authority: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                season: pda(&[SEASON_SEED, &season.to_le_bytes()]),
                reservations: pda(&[POOL_RESERVATIONS_SEED]),
                pool_account: self.pool_account(),
                pool_basket: basket_address(&self.pool_account()).0,
                pool_spill: spill_address(&self.pool_account()).0,
                winner_account: winner.account,
                winner_basket: self.basket(winner),
                winner_spill: self.spill(winner),
                prize_source,
            },
            instruction::PaySeasonRank { rank, line },
            vec![],
        );
        self.send(&[pay], signer, &[])
    }

    /// A payout whose winner's stores may be full: the record and the system program travel as
    /// remaining accounts, and the authority pays the record's rent.
    fn pay_rank_overflow(
        &mut self,
        signer: &Keypair,
        (season, rank, line): (u32, u8, u8),
        winner: &Person,
        prize_source: APk,
    ) -> Result<(), Failed> {
        let id = tesoro_core::instructions::overflow::season_overflow_id(season, rank, line);
        let record = overflow_address(&winner.account, OVERFLOW_SEASON, &id).0;
        let pay = tix(
            accounts::PaySeasonRank {
                authority: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                season: pda(&[SEASON_SEED, &season.to_le_bytes()]),
                reservations: pda(&[POOL_RESERVATIONS_SEED]),
                pool_account: self.pool_account(),
                pool_basket: basket_address(&self.pool_account()).0,
                pool_spill: spill_address(&self.pool_account()).0,
                winner_account: winner.account,
                winner_basket: self.basket(winner),
                winner_spill: self.spill(winner),
                prize_source,
            },
            instruction::PaySeasonRank { rank, line },
            vec![
                rem(record, true),
                rem(anchor_lang::system_program::ID, false),
            ],
        );
        self.send(&[pay], signer, &[])
    }

    fn redeem_prize(&mut self, p: &Person, prize_source: APk, amount: u64) -> Result<(), Failed> {
        let pos = Pos {
            position: APk::default(),
            custody: pda(&[NATIVE_SEED]),
            vault: pda(&[NATIVE_VAULT_SEED]),
        };
        let redeem = tix(
            accounts::RedeemPrize {
                holder_authority: p.key,
                holder_account: p.account,
                basket: self.basket(p),
                spill: self.spill(p),
                prize_source,
            },
            instruction::RedeemPrize { amount },
            self.kind_paying(pos, p.token),
        );
        self.send(&[redeem], &p.kp, &[])
    }

    fn pool_prize_gemas(&self, prize_source: APk) -> u64 {
        gemas_in(&self.svm, self.pool_account(), prize_source)
    }
}

/// Alice's Advance pays a Leaderboard Fee (forged as settlement will cut it), the fee is
/// harvested into the escrow as it repays, her Unlock realises the Pool's half of the Yield Fee,
/// and after the Season ends the keeper funds the prize, records the Season with a frozen budget
/// and pays two ranks, who redeem their prize Gemas for the shares held for them.
#[test]
fn a_season_is_funded_recorded_and_paid_from_the_escrow() {
    let mut env = Env::with_start(SEASON_1_START + 10);
    env.init_pool();
    let keeper = env.person();
    env.keeper_economy(keeper.key);
    let alice = env.staker();
    let bob = env.staker();
    let carol = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 12).unwrap();
    econ::fee_cut(
        &mut env.svm,
        source,
        alice.account,
        CLASS_GENERAL,
        0,
        2,
        400,
    );

    // The escrow ships off: nothing is harvested, funded or moved until the admin switches it on.
    env.advance(2 * MONTH);
    let payer = env.person();
    let err = env.harvest(&payer.kp, pos, source).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::PrizeEscrowOff));
    env.set_escrow(true);

    // Two months repay the 400 Leaderboard Gemas (class 2 is paid before the Advance's own).
    env.harvest(&payer.kp, pos, source).expect("harvest");
    let counter = econ::counter(&env.svm, source, 2).expect("counter");
    assert_eq!(
        counter.amount, 0,
        "every ready Gema of the counter was cashed in"
    );
    let route = env.route();
    assert!(route.escrow_unissued > 0);
    assert_eq!(route.escrow_unissued, route.escrow_total());
    let harvested = route.escrow_unissued;
    // A second harvest finds nothing to cash in.
    assert!(env.harvest(&payer.kp, pos, source).is_err());

    // Alice repays everything and unlocks: the Yield Fee is realised, half owed to the Pool.
    env.advance(10 * MONTH + 1);
    env.unlock(&alice, pos).unwrap();
    let pool_owed = env.route().pool_owed;
    assert!(pool_owed > 0);

    // Season 1 must have ended; funding before that is refused.
    env.set_price(PRICE).unwrap();
    let err = env.fund_prize(&keeper.kp, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::SeasonNotEnded));
    env.set_time(SEASON_1_START + SEASON_SECS + 5);
    env.set_price(PRICE).unwrap();
    // Only the admin or the Season keeper fund.
    let mallory = env.person();
    let err = env.fund_prize(&mallory.kp, 1).unwrap_err();
    assert_eq!(code(&err), 6000);
    let prize = env.fund_prize(&keeper.kp, 1).expect("fund");
    // A prize Source is fully covered and has no fee counters: cash-in cannot name it.
    let platform = env.platform_person();
    let err = env
        .cash_in(&payer.kp, pos, prize, 0, &platform)
        .unwrap_err();
    assert_eq!(code(&err), ACCOUNT_DISCRIMINATOR_MISMATCH);
    let route = env.route();
    assert_eq!((route.pool_owed, route.escrow_unissued), (0, 0));
    assert_eq!(route.escrow_backing, harvested + pool_owed);
    let ps = env.load::<PrizeSourceState>(prize);
    assert_eq!(ps.inner.shares, harvested + pool_owed);
    assert!(ps.inner.gemas > 0);
    assert_eq!(
        env.pool_prize_gemas(prize),
        ps.inner.gemas,
        "the Pool's basket holds the prize"
    );
    // Once per Season per route.
    env.advance(1);
    let err = env.fund_prize(&keeper.kp, 1).unwrap_err();
    assert!(matches!(
        err.err,
        solana_sdk::transaction::TransactionError::InstructionError(_, _)
    ));

    // A basket that was full when the prize arrived keeps it in the spill: it is part of the
    // budget all the same.
    let pool = env.pool_account();
    let grow = tix(
        accounts::GrowStore {
            payer: a(keeper.kp.pubkey()),
            account: pool,
            basket: basket_address(&pool).0,
            spill: spill_address(&pool).0,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::GrowStore {
            which: tesoro_core::StoreKind::Spill,
            extra_lines: 4,
        },
        vec![],
    );
    env.send(&[grow], &keeper.kp, &[])
        .expect("grow the Pool's spill");
    econ::move_lines_to_spill(&mut env.svm, pool);
    assert_eq!(econ::read_lines(&env.svm, basket_address(&pool).0).len(), 0);

    // Record: the ranking and a frozen budget; one line (the prize Source).
    env.record_season(&keeper.kp, 1, &[(&bob, 20), (&carol, 10)])
        .expect("record");
    let season = env.load::<SeasonState>(pda(&[SEASON_SEED, &1u32.to_le_bytes()]));
    assert_eq!(season.inner.count, 2);
    assert_eq!(season.inner.lines.len(), 1);
    let budget = season.inner.lines[0].amount;
    assert_eq!(budget, ps.inner.gemas);
    let reservations = env.load::<PoolReservationsState>(pda(&[POOL_RESERVATIONS_SEED]));
    assert_eq!(reservations.entries.len(), 1);
    assert_eq!(reservations.entries[0].amount, budget);

    // The 48-hour window: nobody is paid, and a voided rank never is.
    let err = env.pay_rank(&keeper.kp, 1, 0, 0, &bob, prize).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::PayoutWindowOpen));
    env.advance(48 * 3600 + 1);
    // A step out of order, to the wrong winner, or by a stranger is refused.
    let err = env.pay_rank(&keeper.kp, 1, 0, 1, &bob, prize).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::BudgetStep));
    assert!(env.pay_rank(&keeper.kp, 1, 0, 0, &carol, prize).is_err());
    assert!(env.pay_rank(&mallory.kp, 1, 0, 0, &bob, prize).is_err());
    env.pay_rank(&keeper.kp, 1, 0, 0, &bob, prize)
        .expect("rank 1");
    env.pay_rank(&keeper.kp, 1, 1, 0, &carol, prize)
        .expect("rank 2");
    let first = (budget as u128 * 2_500 / 10_000) as u64;
    let second = (budget as u128 * 1_800 / 10_000) as u64;
    assert_eq!(gemas_in(&env.svm, bob.account, prize), first);
    assert_eq!(gemas_in(&env.svm, carol.account, prize), second);
    // Once: the same step again is refused.
    let err = env.pay_rank(&keeper.kp, 1, 0, 0, &bob, prize).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::BudgetStep));
    assert_eq!(env.pool_prize_gemas(prize), budget - first - second);

    // Prize Redeem pays the shares held for the Gemas, at once, and only the holder's own.
    let supply = env.supply();
    let before = env.token_balance(bob.token);
    env.redeem_prize(&bob, prize, first).expect("redeem prize");
    let paid = env.token_balance(bob.token) - before;
    let expected = (ps.inner.shares * first as u128 / ps.inner.gemas as u128) as u64;
    assert_eq!(paid, expected);
    assert_eq!(env.supply() - supply, paid);
    let after = env.load::<PrizeSourceState>(prize);
    assert_eq!(after.inner.gemas, ps.inner.gemas - first);
    assert_eq!(after.inner.shares, ps.inner.shares - expected as u128);
    assert_eq!(env.route().escrow_backing, after.inner.shares);
    let err = env.redeem_prize(&bob, prize, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::LineMismatch));
    // Every other Redeem path refuses a prize Source: it has no book to ask.
    assert!(env.redeem_prize(&carol, prize, second + 1).is_err());
    env.redeem_prize(&carol, prize, second)
        .expect("carol redeems");
}

/// Funding that arrives while a Season is being paid never changes what that Season recorded.
#[test]
fn funding_arriving_mid_payout_does_not_change_a_recorded_budget() {
    let mut env = Env::with_start(SEASON_1_START + 10);
    env.init_pool();
    env.set_escrow(true);
    let admin = env.admin.insecure_clone();
    let alice = env.staker();
    let bob = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH + 1);
    // The Pool's share of a Yield Fee comes from a cash-out (ticket 31): the Advance is redeemed.
    let all = env.gemas(&alice, source);
    env.redeem(&alice, pos, source, all).unwrap();
    env.unlock(&alice, pos).unwrap();
    env.set_time(SEASON_1_START + SEASON_SECS + 5);
    env.set_price(PRICE).unwrap();
    let prize1 = env.fund_prize(&admin, 1).expect("fund 1");
    env.record_season(&admin, 1, &[(&bob, 5)])
        .expect("record 1");
    let recorded = env
        .load::<SeasonState>(pda(&[SEASON_SEED, &1u32.to_le_bytes()]))
        .inner
        .lines[0];
    // A second Position's fee arrives and Season 2 is funded before Season 1 is paid.
    let carol = env.staker();
    env.set_time(SEASON_1_START + SEASON_SECS + 10);
    env.set_price(PRICE).unwrap();
    let pos2 = env.open(&carol, 10 * SOL).unwrap();
    let carol_source = env.advance_native(&carol, pos2, 1).unwrap();
    env.advance(MONTH + 1);
    // The Pool's share of a Yield Fee comes from a cash-out (ticket 31): the Advance is redeemed.
    let all = env.gemas(&carol, carol_source);
    env.redeem(&carol, pos2, carol_source, all).unwrap();
    env.unlock(&carol, pos2).unwrap();
    env.set_time(SEASON_1_START + 2 * SEASON_SECS + 5);
    env.set_price(PRICE).unwrap();
    let prize2 = env.fund_prize(&admin, 2).expect("fund 2");
    let new_gemas = env.pool_prize_gemas(prize2);
    assert!(new_gemas > 0);
    // Season 1 pays out of its frozen budget: rank 1 takes 25% of the recorded line, not of the
    // Pool as it now stands, and the new Season's prize is untouched.
    env.pay_rank(&admin, 1, 0, 0, &bob, prize1).expect("pay");
    assert_eq!(
        gemas_in(&env.svm, bob.account, prize1),
        (recorded.amount as u128 * 2_500 / 10_000) as u64
    );
    assert_eq!(env.pool_prize_gemas(prize2), new_gemas);
    let _ = source;
}

/// A voided rank is never paid and its share rolls into the next Season once the Season closes.
#[test]
fn a_voided_rank_is_not_paid_and_closing_releases_the_rest() {
    let mut env = Env::with_start(SEASON_1_START + 10);
    env.init_pool();
    env.set_escrow(true);
    let admin = env.admin.insecure_clone();
    let alice = env.staker();
    let bob = env.staker();
    let carol = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let alice_source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH + 1);
    // The Pool's share of a Yield Fee comes from a cash-out (ticket 31): the Advance is redeemed.
    let all = env.gemas(&alice, alice_source);
    env.redeem(&alice, pos, alice_source, all).unwrap();
    env.unlock(&alice, pos).unwrap();
    env.set_time(SEASON_1_START + SEASON_SECS + 5);
    env.set_price(PRICE).unwrap();
    let prize = env.fund_prize(&admin, 1).unwrap();
    env.record_season(&admin, 1, &[(&bob, 9), (&carol, 4)])
        .unwrap();
    let void = tix(
        accounts::VoidSeasonRank {
            admin: a(admin.pubkey()),
            config: pda(&[CONFIG_SEED]),
            season: pda(&[SEASON_SEED, &1u32.to_le_bytes()]),
        },
        instruction::VoidSeasonRank { rank: 0 },
        vec![],
    );
    env.send(&[void], &admin, &[]).expect("void");
    env.advance(48 * 3600 + 1);
    let err = env.pay_rank(&admin, 1, 0, 0, &bob, prize).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::RankVoided));
    env.pay_rank(&admin, 1, 1, 0, &carol, prize).unwrap();
    // Not closable while rank 1 (index 0) is neither paid nor voided... it is voided, so the
    // Season is finished once the window has passed.
    let close = tix(
        accounts::CloseSeason {
            season: pda(&[SEASON_SEED, &1u32.to_le_bytes()]),
            reservations: pda(&[POOL_RESERVATIONS_SEED]),
        },
        instruction::CloseSeason {},
        vec![],
    );
    env.send(&[close], &admin, &[]).expect("close");
    let res = env.load::<PoolReservationsState>(pda(&[POOL_RESERVATIONS_SEED]));
    assert!(
        res.entries.is_empty(),
        "nothing stays promised after the Season closes"
    );
    assert!(
        env.pool_prize_gemas(prize) > 0,
        "the voided share stays in the Pool"
    );
}

/// A ranked winner whose stores are completely full still gets the prize: the line goes to an
/// overflow record the keeper's transaction creates, and a claim moves it after room is made.
#[test]
fn a_season_prize_for_a_winner_with_full_stores_lands_in_an_overflow_record() {
    let mut env = Env::with_start(SEASON_1_START + 10);
    env.init_pool();
    let keeper = env.person();
    env.keeper_economy(keeper.key);
    env.set_escrow(true);
    let alice = env.staker();
    let bob = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let alice_source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH + 1);
    // The Pool's share of a Yield Fee comes from a cash-out (ticket 31): the Advance is redeemed.
    let all = env.gemas(&alice, alice_source);
    env.redeem(&alice, pos, alice_source, all).unwrap();
    env.unlock(&alice, pos).unwrap();
    env.set_time(SEASON_1_START + SEASON_SECS + 5);
    env.set_price(PRICE).unwrap();
    let prize = env.fund_prize(&keeper.kp, 1).expect("fund");
    env.record_season(&keeper.kp, 1, &[(&bob, 20)])
        .expect("record");
    env.advance(48 * 3600 + 1);
    // Bob's basket and spill are full to the last slot
    let (basket, spill) = (env.basket(&bob), env.spill(&bob));
    econ::fill_with_dust(&mut env.svm, basket);
    econ::fill_with_dust(&mut env.svm, spill);
    // without a record the payout still fails as before, nothing changed
    let err = env.pay_rank(&keeper.kp, 1, 0, 0, &bob, prize).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::SpillFull));
    let keeper_before = env.svm.get_balance(&keeper.kp.pubkey()).unwrap_or(0);
    env.pay_rank_overflow(&keeper.kp, (1, 0, 0), &bob, prize)
        .expect("the prize lands in an overflow record");
    let id = tesoro_core::instructions::overflow::season_overflow_id(1, 0, 0);
    let record = overflow_address(&bob.account, OVERFLOW_SEASON, &id).0;
    let rent = env.svm.get_balance(&s(record)).unwrap_or(0);
    assert!(rent > 0);
    assert!(keeper_before > env.svm.get_balance(&keeper.kp.pubkey()).unwrap_or(0));
    let data = env.svm.get_account(&s(record)).expect("record").data;
    let held: Vec<_> = tesoro_core::ledger::line_store::LineStore::new(&data[OVERFLOW_STORE_AT..])
        .expect("store")
        .lines()
        .collect();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].source, prize.to_bytes());
    let amount = held[0].amount;
    assert!(amount > 0);
    // the step is paid once; the Pool gave the line up
    let err = env.pay_rank(&keeper.kp, 1, 0, 0, &bob, prize).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::BudgetStep));
    // a claim with no room moves nothing; after a grow it lands and the rent goes to the keeper
    let claim = |env: &Env| {
        tix(
            accounts::ClaimOverflow {
                account: bob.account,
                basket: env.basket(&bob),
                spill: env.spill(&bob),
                record,
                payer: a(keeper.kp.pubkey()),
            },
            instruction::ClaimOverflow { max: 4 },
            vec![],
        )
    };
    let c = claim(&env);
    env.send(&[c], &keeper.kp, &[]).expect("claim, no room");
    assert!(env.svm.get_account(&s(record)).is_some());
    let grow = tix(
        accounts::GrowStore {
            payer: a(keeper.kp.pubkey()),
            account: bob.account,
            basket: env.basket(&bob),
            spill: env.spill(&bob),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::GrowStore {
            which: tesoro_core::StoreKind::Spill,
            extra_lines: 1,
        },
        vec![],
    );
    env.send(&[grow], &keeper.kp, &[]).expect("grow");
    let c = claim(&env);
    env.send(&[c], &keeper.kp, &[]).expect("claim");
    assert!(env.svm.get_account(&s(record)).is_none());
    assert_eq!(gemas_in(&env.svm, bob.account, prize), amount);
}

/// The Pool at its maximum still receives a Season's prize: the funding goes to an overflow record.
#[test]
fn funding_a_prize_into_a_full_pool_lands_in_an_overflow_record() {
    let mut env = Env::with_start(SEASON_1_START + 10);
    env.init_pool();
    let keeper = env.person();
    env.keeper_economy(keeper.key);
    env.set_escrow(true);
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let alice_source = env.advance_native(&alice, pos, 1).unwrap();
    env.advance(MONTH + 1);
    // The Pool's share of a Yield Fee comes from a cash-out (ticket 31): the Advance is redeemed.
    let all = env.gemas(&alice, alice_source);
    env.redeem(&alice, pos, alice_source, all).unwrap();
    env.unlock(&alice, pos).unwrap();
    env.set_time(SEASON_1_START + SEASON_SECS + 5);
    env.set_price(PRICE).unwrap();
    let pool = env.pool_account();
    econ::fill_with_dust(&mut env.svm, basket_address(&pool).0);
    econ::fill_with_dust(&mut env.svm, spill_address(&pool).0);
    let err = env.fund_prize(&keeper.kp, 1).unwrap_err();
    assert_eq!(code(&err), core_code(ledger::CoreError::SpillFull));
    let prize = env.fund_prize_overflow(&keeper.kp, 1).expect("fund");
    let id = tesoro_core::instructions::overflow::route_overflow_id(1, &pda(&[NATIVE_SEED]));
    let record = overflow_address(&pool, OVERFLOW_ROUTE, &id).0;
    let data = env.svm.get_account(&s(record)).expect("record").data;
    let held: Vec<_> = tesoro_core::ledger::line_store::LineStore::new(&data[OVERFLOW_STORE_AT..])
        .expect("store")
        .lines()
        .collect();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].source, prize.to_bytes());
    assert_eq!(
        held[0].amount,
        env.load::<PrizeSourceState>(prize).inner.gemas
    );
    assert_eq!(
        env.pool_prize_gemas(prize),
        0,
        "not in the Pool's stores yet"
    );
}

/// Red-team 31 #2: Return Own then Unlock splits the fee on the released yield at the Pool share the
/// Advance snapshotted, not the share in force at Unlock.
#[test]
fn return_then_unlock_uses_the_snapshotted_pool_share() {
    let mut env = Env::with_start(SEASON_1_START + 10);
    let alice = env.staker();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 1).unwrap();
    assert_eq!(env.stored(source).pool_bps, 5_000);
    // The admin announces a Pool share of 0 from Season 2.
    let admin = env.admin.insecure_clone();
    let set = tix(
        accounts::SetPrizeShare {
            admin: a(admin.pubkey()),
            config: pda(&[CONFIG_SEED]),
            economy: pda(&[ECONOMY_SEED]),
        },
        instruction::SetPrizeShare {
            from_season: 2,
            bps: 0,
        },
        vec![],
    );
    env.send(&[set], &admin, &[])
        .expect("announce a 0% Pool share");
    env.set_time(SEASON_1_START + SEASON_SECS + 10);
    env.set_price(PRICE).unwrap();
    let all = env.gemas(&alice, source);
    env.return_own(&alice, pos, source, all).expect("return");
    let free = (env.position(pos).free_shares >> 32) as u64;
    env.unlock(&alice, pos).expect("unlock");
    let fee = u128::from(free - free * 8_000 / 10_000);
    let route = env.route();
    assert!(route.treasury_shares >= fee && route.treasury_shares <= fee + 1);
    assert_eq!(
        route.pool_owed,
        route.treasury_shares / 2,
        "the Advance's 50%, not the live 0%"
    );
}

/// The ready part of an Instant Redeem is an ordinary Redeem (red-team 31 #5): the seller gets
/// exactly floor(80%) of the shares redeemed, the Treasury the rest, at the request and at the fill.
#[test]
fn the_ready_part_of_an_instant_redeem_pays_the_yield_fee() {
    let mut env = Env::new();
    let alice = env.staker();
    let bob = env.staker();
    env.fund_treasury(5 * SOL).unwrap();
    let pos = env.open(&alice, 10 * SOL).unwrap();
    let source = env.advance_native(&alice, pos, 12).unwrap();
    env.give_won(&alice, &bob, source, 2_000);
    env.advance(3 * MONTH);
    let before = env.token_balance(bob.token);
    let route = env.route();
    let order = env.request(&bob, pos, source, 1_000, 1).expect("request");
    let got = u128::from(env.token_balance(bob.token) - before);
    let fee = env.route().treasury_shares - route.treasury_shares;
    assert!(got > 0, "part of the line was ready");
    assert_eq!(got, (got + fee) * 8_000 / 10_000, "seller {got}, fee {fee}");
    assert_eq!(env.route().pool_owed - route.pool_owed, fee / 2);
    // More repays while the order waits; the fill Redeems that part first, with the same fee.
    env.advance(3 * MONTH);
    let before = env.token_balance(bob.token);
    let route = env.route();
    env.fill(&bob, pos, source, 1, 100).expect("fill");
    let state = env.load::<InstantOrderState>(order);
    assert!(state.redeemed_while_open > 0, "part repaid while it waited");
    let ready = u128::from(env.token_balance(bob.token) - before) - state.paid_shares;
    let fee = env.route().treasury_shares + state.paid_shares - route.treasury_shares;
    assert!(ready > 0);
    assert_eq!(
        ready,
        (ready + fee) * 8_000 / 10_000,
        "seller {ready}, fee {fee}"
    );
    env.check_invariants(&[pos]);
}

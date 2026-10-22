//! Source authorities (the cross-chain bridge signer): LiteSVM tests against the built program
//! (`pnpm build:programs` first).
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::instruction::Instruction;
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use tesoro_core::ledger::SourceChain;
use tesoro_core::state::*;
use tesoro_core::{accounts, instruction};

mod common;

const SOL: u64 = 1_000_000_000;
type Failed = litesvm::types::FailedTransactionMetadata;

fn a(p: Pk) -> APk {
    APk::new_from_array(p.to_bytes())
}
fn s(p: APk) -> Pk {
    Pk::new_from_array(p.to_bytes())
}
fn pda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &tesoro_core::ID).0
}
fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id: s(tesoro_core::ID),
        accounts: accounts
            .to_account_metas(None)
            .into_iter()
            .map(|m| solana_sdk::instruction::AccountMeta {
                pubkey: s(m.pubkey),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
        data: data.data(),
    }
}
fn custom_code(err: &Failed) -> u32 {
    use solana_sdk::instruction::InstructionError;
    use solana_sdk::transaction::TransactionError;
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => *c,
        other => panic!("unexpected error {other:?}\n{:?}", err.meta.logs),
    }
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    oracle: Keypair,
    bridge: Keypair,
    owner: Keypair,
    owner_account: APk,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../target/deploy/tesoro_core.so"
        );
        svm.add_program_from_file(s(tesoro_core::ID), so)
            .expect("build the program first: pnpm build:programs");
        let mut env = Self {
            svm,
            admin: Keypair::new(),
            oracle: Keypair::new(),
            bridge: Keypair::new(),
            owner: Keypair::new(),
            owner_account: APk::default(),
        };
        for k in [&env.admin, &env.oracle, &env.bridge, &env.owner] {
            env.svm.airdrop(&k.pubkey(), 100 * SOL).expect("airdrop");
        }
        let admin = env.admin.insecure_clone();
        let platform = env.create_account(&admin);
        env.send(
            &[ix(
                accounts::InitializeConfig {
                    admin: a(admin.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    platform_recipient: platform,
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::InitializeConfig {
                    oracle_authority: a(env.oracle.pubkey()),
                    platform_bps: 200,
                },
            )],
            &admin,
        )
        .expect("init config");
        common::put_sim_sol_mint(&mut env.svm);
        env.send(
            &[common::init_treasury_ix(a(admin.pubkey()), 0, 3_500)],
            &admin,
        )
        .expect("init treasury");
        let owner = env.owner.insecure_clone();
        env.owner_account = env.create_account(&owner);
        env
    }

    fn send(&mut self, ixs: &[Instruction], payer: &Keypair) -> Result<(), Failed> {
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&payer.pubkey()),
            &[payer],
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).map(|_| ())
    }

    fn send2(
        &mut self,
        ixs: &[Instruction],
        payer: &Keypair,
        other: &Keypair,
    ) -> Result<(), Failed> {
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&payer.pubkey()),
            &[payer, other],
            self.svm.latest_blockhash(),
        );
        let r = self.svm.send_transaction(tx);
        LAST_CU.store(
            match &r {
                Ok(m) => m.compute_units_consumed,
                Err(e) => e.meta.compute_units_consumed,
            },
            std::sync::atomic::Ordering::Relaxed,
        );
        r.map(|_| ())
    }

    fn create_account(&mut self, kp: &Keypair) -> APk {
        let key = a(kp.pubkey());
        let account = pda(&[ACCOUNT_SEED, key.as_ref()]);
        self.send(
            &[ix(
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
            )],
            kp,
        )
        .expect("create account");
        account
    }

    fn load<T: AccountDeserialize>(&self, k: APk) -> T {
        let acct = self.svm.get_account(&s(k)).expect("account exists");
        T::try_deserialize(&mut acct.data.as_slice()).expect("deserialize")
    }

    fn set_authority(
        &mut self,
        signer: &Keypair,
        chain: SourceChain,
        authority: APk,
    ) -> Result<(), Failed> {
        let byte = chain_byte(chain);
        self.send(
            &[ix(
                accounts::SetSourceAuthority {
                    admin: a(signer.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    source_authority: pda(&[SOURCE_AUTHORITY_SEED, &[byte]]),
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::SetSourceAuthority { chain, authority },
            )],
            signer,
        )
    }

    fn open(
        &mut self,
        signer: &Keypair,
        chain: SourceChain,
        id: [u8; 32],
        authority_chain: SourceChain,
    ) -> Result<(), Failed> {
        let payer = self.owner.insecure_clone();
        let open = ix(
            accounts::OpenPositionFromSource {
                payer: a(payer.pubkey()),
                source_signer: a(signer.pubkey()),
                source_authority: pda(&[SOURCE_AUTHORITY_SEED, &[chain_byte(authority_chain)]]),
                owner_account: self.owner_account,
                position: pda(&[POSITION_SEED, &[chain_byte(chain)], &id]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::OpenPositionFromSource {
                source_chain: chain,
                position_id: id,
                source_asset: APk::new_unique(),
                decimals: 18,
                principal: 2 * SOL,
                rate_bps: 500,
            },
        );
        self.send2(&[open], &payer, signer)
    }

    fn yield_from(
        &mut self,
        signer: &Keypair,
        position: APk,
        seq: u64,
        cumulative: u64,
    ) -> Result<(), Failed> {
        let payer = self.owner.insecure_clone();
        let apply = ix(
            accounts::ApplyYieldFromSource {
                source_signer: a(signer.pubkey()),
                source_authority: pda(&[
                    SOURCE_AUTHORITY_SEED,
                    &[chain_byte(
                        self.load::<PositionState>(position).inner.source_chain,
                    )],
                ]),
                position,
                source: None,
            },
            instruction::ApplyYieldFromSource { seq, cumulative },
        );
        self.send2(&[apply], &payer, signer)
    }
}

fn chain_byte(chain: SourceChain) -> u8 {
    match chain {
        SourceChain::Solana => 0,
        SourceChain::Ethereum => 1,
        SourceChain::HyperEvm => 2,
    }
}

const ID: [u8; 32] = [7; 32];

static LAST_CU: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[test]
fn only_the_admin_registers_a_source_authority_and_never_for_solana() {
    let mut env = Env::new();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    let bridge = a(env.bridge.pubkey());
    let err = env
        .set_authority(&stranger, SourceChain::Ethereum, bridge)
        .expect_err("non-admin refused");
    assert_eq!(
        custom_code(&err),
        6000 // Unauthorized
    );
    let admin = env.admin.insecure_clone();
    env.set_authority(&admin, SourceChain::Solana, bridge)
        .expect_err("Solana Positions do not use a source authority");
    env.set_authority(&admin, SourceChain::Ethereum, bridge)
        .expect("admin registers");
    let entry: SourceAuthority = env.load(pda(&[SOURCE_AUTHORITY_SEED, &[1]]));
    assert_eq!(entry.authority, bridge);
    assert_eq!(entry.chain, SourceChain::Ethereum);
    // Replaceable.
    let other = APk::new_unique();
    env.set_authority(&admin, SourceChain::Ethereum, other)
        .expect("replace");
    let entry: SourceAuthority = env.load(pda(&[SOURCE_AUTHORITY_SEED, &[1]]));
    assert_eq!(entry.authority, other);
}

#[test]
fn the_source_authority_opens_and_updates_positions_of_its_chain_only() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let bridge = env.bridge.insecure_clone();
    env.set_authority(&admin, SourceChain::Ethereum, a(bridge.pubkey()))
        .expect("register");

    // Unregistered chain: no authority account exists.
    env.open(&bridge, SourceChain::HyperEvm, ID, SourceChain::HyperEvm)
        .expect_err("HyperEVM has no authority yet");
    // A signer that is not the registered one is refused.
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    let err = env
        .open(&stranger, SourceChain::Ethereum, ID, SourceChain::Ethereum)
        .expect_err("stranger refused");
    assert_eq!(custom_code(&err), 6000);
    // The Ethereum authority cannot open a HyperEVM Position by presenting its own entry.
    env.open(&bridge, SourceChain::HyperEvm, ID, SourceChain::Ethereum)
        .expect_err("authority is bound to its chain");

    env.open(&bridge, SourceChain::Ethereum, ID, SourceChain::Ethereum)
        .expect("bridge opens an Ethereum Position");
    let position = pda(&[POSITION_SEED, &[1], &ID]);
    let state: PositionState = env.load(position);
    assert_eq!(state.inner.owner, env.owner_account.to_bytes());
    assert_eq!(state.inner.principal, 2 * SOL);
    assert_eq!(state.inner.source_chain, SourceChain::Ethereum);
    env.open(&bridge, SourceChain::Ethereum, ID, SourceChain::Ethereum)
        .expect_err("a Position opens once");

    // Yield: idempotent by seq, monotonic cumulative.
    env.yield_from(&bridge, position, 2, 1_000).expect("yield");
    env.yield_from(&bridge, position, 2, 5_000)
        .expect("replayed seq is a no-op");
    let state: PositionState = env.load(position);
    assert_eq!(state.inner.cumulative_yield, 1_000);
    assert_eq!(state.inner.last_seq, 2);
    env.yield_from(&stranger, position, 3, 2_000)
        .expect_err("stranger cannot report yield");
    // The oracle key is not a source authority.
    let oracle = env.oracle.insecure_clone();
    env.yield_from(&oracle, position, 3, 2_000)
        .expect_err("the oracle signs only the oracle instructions");
    env.yield_from(&bridge, position, 3, 900)
        .expect_err("cumulative cannot decrease");
}

#[test]
fn the_oracle_path_still_works_and_a_removed_authority_is_refused() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let bridge = env.bridge.insecure_clone();
    env.set_authority(&admin, SourceChain::Ethereum, a(bridge.pubkey()))
        .expect("register");

    // Oracle-signed open_position (unchanged) for an Ethereum Position.
    let oracle = env.oracle.insecure_clone();
    let id = [9u8; 32];
    let open = ix(
        accounts::OpenPosition {
            oracle: a(oracle.pubkey()),
            config: pda(&[CONFIG_SEED]),
            owner_account: env.owner_account,
            position: pda(&[POSITION_SEED, &[1], &id]),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::OpenPosition {
            source_chain: SourceChain::Ethereum,
            position_id: id,
            source_asset: APk::new_unique(),
            decimals: 18,
            principal: SOL,
            rate_bps: 500,
        },
    );
    env.send(&[open], &oracle).expect("oracle path unchanged");

    let remove = ix(
        accounts::RemoveSourceAuthority {
            admin: a(admin.pubkey()),
            config: pda(&[CONFIG_SEED]),
            source_authority: pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
        },
        instruction::RemoveSourceAuthority {
            chain: SourceChain::Ethereum,
        },
    );
    env.send(&[remove], &admin).expect("admin removes");
    env.open(&bridge, SourceChain::Ethereum, ID, SourceChain::Ethereum)
        .expect_err("removed authority is refused");
}

/// CU readings for `apply_yield_from_source` (run with `--nocapture`).
#[test]
fn cu_profile_apply_yield_from_source() {
    use std::sync::atomic::Ordering::Relaxed;
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let bridge = env.bridge.insecure_clone();
    env.set_authority(&admin, SourceChain::Ethereum, a(bridge.pubkey()))
        .expect("register");
    env.open(&bridge, SourceChain::Ethereum, ID, SourceChain::Ethereum)
        .expect("open");
    let position = pda(&[POSITION_SEED, &[1], &ID]);
    env.yield_from(&bridge, position, 1, 1_000)
        .expect("free yield");
    let no_advance = LAST_CU.load(Relaxed);

    let oracle = env.oracle.insecure_clone();
    let owner = env.owner.insecure_clone();
    let source = pda(&[SOURCE_SEED, position.as_ref(), &0u32.to_le_bytes()]);
    let mut advance = ix(
        accounts::TakeAdvance {
            oracle: a(oracle.pubkey()),
            owner_authority: a(owner.pubkey()),
            config: pda(&[CONFIG_SEED]),
            treasury: common::treasury(),
            owner_account: env.owner_account,
            protections: pda(&[PROTECTIONS_SEED, env.owner_account.as_ref()]),
            position,
            source,
            book: tesoro_core::storage::book_address(&source).0,
            basket: tesoro_core::storage::basket_address(&env.owner_account).0,
            spill: tesoro_core::storage::spill_address(&env.owner_account).0,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::TakeAdvance {
            horizon_months: 3,
            price_micro_usd: 1_000_000_000_000_000,
        },
    );
    let asset = {
        let acct = env.svm.get_account(&s(position)).expect("position");
        PositionState::try_deserialize(&mut acct.data.as_slice())
            .expect("position")
            .inner
            .source_asset
    };
    advance
        .accounts
        .push(solana_sdk::instruction::AccountMeta::new_readonly(
            s(pda(&[ONCHAIN_PRICE_SEED, &asset])),
            false,
        ));
    env.send2(&[advance], &oracle, &owner).expect("advance");
    let payer = env.owner.insecure_clone();
    // The pages a landing that repays the Advance writes its closed segment to.
    for class in [1u8, 3] {
        let init = ix(
            accounts::InitCkptPage {
                payer: a(payer.pubkey()),
                book: tesoro_core::storage::book_address(&source).0,
                page: tesoro_core::storage::ckpt_address(&source, class, 0).0,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitCkptPage { class, page_no: 0 },
        );
        env.send(&[init], &payer).expect("page");
    }
    let mut apply = ix(
        accounts::ApplyYieldFromSource {
            source_signer: a(bridge.pubkey()),
            source_authority: pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
            position,
            source: Some(source),
        },
        instruction::ApplyYieldFromSource {
            seq: 2,
            cumulative: 30_000_000_000,
        },
    );
    for k in [
        tesoro_core::storage::book_address(&source).0,
        tesoro_core::storage::ckpt_address(&source, 1, 0).0,
        tesoro_core::storage::ckpt_address(&source, 3, 0).0,
    ] {
        apply
            .accounts
            .push(solana_sdk::instruction::AccountMeta::new(s(k), false));
    }
    env.send2(&[apply], &payer, &bridge).expect("repay debt");
    println!(
        "CU apply_yield_from_source: no open Advance {no_advance}; with open Advance {}",
        LAST_CU.load(Relaxed)
    );
}

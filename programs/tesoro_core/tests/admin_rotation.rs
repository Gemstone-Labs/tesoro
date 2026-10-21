//! `set_admin`: rotation gated on the program's upgrade authority, not the current admin.
//! LiteSVM tests against the built program (`pnpm build:programs` first).
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

const SOL: u64 = 1_000_000_000;
const UNAUTHORIZED: u32 = 6000;
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

const LOADER: &str = "BPFLoaderUpgradeab1e11111111111111111111111";

/// `add_program` deploys through the upgradeable loader with no upgrade authority; records one.
fn deploy_with_authority(svm: &mut LiteSVM, program_id: Pk, so: &str, authority: Pk) -> Pk {
    svm.add_program_from_file(program_id, so)
        .expect("build the program first: pnpm build:programs");
    let loader: Pk = LOADER.parse().expect("loader id");
    let programdata = Pk::find_program_address(&[program_id.as_ref()], &loader).0;
    let mut account = svm.get_account(&programdata).expect("programdata");
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(programdata, account).expect("set account");
    programdata
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    upgrade_authority: Keypair,
    programdata: Pk,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let upgrade_authority = Keypair::new();
        let programdata = deploy_with_authority(
            &mut svm,
            s(tesoro_core::ID),
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../target/deploy/tesoro_core.so"
            ),
            upgrade_authority.pubkey(),
        );
        let mut env = Self {
            svm,
            admin: Keypair::new(),
            upgrade_authority,
            programdata,
        };
        for k in [&env.admin, &env.upgrade_authority] {
            env.svm.airdrop(&k.pubkey(), 100 * SOL).expect("airdrop");
        }
        let admin = env.admin.insecure_clone();
        let key = a(admin.pubkey());
        let platform = pda(&[ACCOUNT_SEED, key.as_ref()]);
        env.send(
            &[ix(
                accounts::CreateAccount {
                    authority: key,
                    account: platform,
                    basket: tesoro_core::storage::basket_address(&platform).0,
                    spill: tesoro_core::storage::spill_address(&platform).0,
                    invite_gate: invite_gate_pda(),
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::CreateAccount {
                    evm_address: [0; 20],
                },
            )],
            &admin,
        )
        .expect("create account");
        env.send(
            &[ix(
                accounts::InitializeConfig {
                    admin: key,
                    config: pda(&[CONFIG_SEED]),
                    platform_recipient: platform,
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::InitializeConfig {
                    oracle_authority: APk::new_unique(),
                    platform_bps: 200,
                },
            )],
            &admin,
        )
        .expect("init config");
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

    fn set_admin(&mut self, signer: &Keypair, new_admin: APk) -> Result<(), Failed> {
        self.send(
            &[ix(
                accounts::SetAdmin {
                    authority: a(signer.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    program: tesoro_core::ID,
                    program_data: a(self.programdata),
                },
                instruction::SetAdmin { new_admin },
            )],
            signer,
        )
    }

    /// An admin-only action: registers the bridge source authority.
    fn set_source_authority(&mut self, signer: &Keypair) -> Result<(), Failed> {
        self.send(
            &[ix(
                accounts::SetSourceAuthority {
                    admin: a(signer.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    source_authority: pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::SetSourceAuthority {
                    chain: SourceChain::Ethereum,
                    authority: APk::new_unique(),
                },
            )],
            signer,
        )
    }

    fn config_admin(&self) -> APk {
        let acct = self
            .svm
            .get_account(&s(pda(&[CONFIG_SEED])))
            .expect("config");
        Config::try_deserialize(&mut acct.data.as_slice())
            .expect("deserialize")
            .admin
    }
}

#[test]
fn upgrade_authority_rotates_the_admin_and_the_new_admin_acts() {
    let mut env = Env::new();
    let old_admin = env.admin.insecure_clone();
    let new_admin = Keypair::new();
    env.svm
        .airdrop(&new_admin.pubkey(), 10 * SOL)
        .expect("airdrop");
    let authority = env.upgrade_authority.insecure_clone();
    env.set_admin(&authority, a(new_admin.pubkey()))
        .expect("rotate");
    assert_eq!(env.config_admin(), a(new_admin.pubkey()));
    let err = env.set_source_authority(&old_admin).expect_err("old admin");
    assert_eq!(custom_code(&err), UNAUTHORIZED);
    env.set_source_authority(&new_admin)
        .expect("new admin acts");
}

#[test]
fn the_current_admin_cannot_rotate_unless_it_is_the_upgrade_authority() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let err = env
        .set_admin(&admin, APk::new_unique())
        .expect_err("admin is not the upgrade authority");
    assert_eq!(custom_code(&err), UNAUTHORIZED);
    assert_eq!(env.config_admin(), a(admin.pubkey()));
}

#[test]
fn a_random_signer_cannot_rotate() {
    let mut env = Env::new();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    let err = env
        .set_admin(&stranger, a(stranger.pubkey()))
        .expect_err("stranger");
    assert_eq!(custom_code(&err), UNAUTHORIZED);
    assert_eq!(env.config_admin(), a(env.admin.pubkey()));
}

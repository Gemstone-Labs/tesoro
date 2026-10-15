//! The Invite gate (ADR 0011): while on, `create_account` needs the Invite key's co-signature.
//! LiteSVM tests against the built program (`pnpm build:programs` first).
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::instruction::Instruction;
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use tesoro_core::state::*;
use tesoro_core::{accounts, instruction};

const SOL: u64 = 1_000_000_000;
const UNAUTHORIZED: u32 = 6000;
const INVITE_REQUIRED: u32 = 6024;
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
    invite: Keypair,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        deploy_with_authority(
            &mut svm,
            s(tesoro_core::ID),
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../target/deploy/tesoro_core.so"
            ),
            Pk::new_unique(),
        );
        let mut env = Self {
            svm,
            admin: Keypair::new(),
            invite: Keypair::new(),
        };
        env.svm
            .airdrop(&env.admin.pubkey(), 100 * SOL)
            .expect("airdrop");
        let admin = env.admin.insecure_clone();
        let key = a(admin.pubkey());
        let platform = pda(&[ACCOUNT_SEED, key.as_ref()]);
        env.send(&[create_account(key, None)], &[&admin])
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
            &[&admin],
        )
        .expect("init config");
        env
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), Failed> {
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&signers[0].pubkey()),
            signers,
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).map(|_| ())
    }

    fn set_gate(&mut self, signer: &Keypair, required: bool, key: APk) -> Result<(), Failed> {
        self.send(
            &[ix(
                accounts::SetInviteGate {
                    admin: a(signer.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    invite_gate: invite_gate_pda(),
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::SetInviteGate { required, key },
            )],
            &[signer],
        )
    }

    fn player(&mut self) -> Keypair {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10 * SOL).expect("airdrop");
        kp
    }

    fn has_account(&self, kp: &Keypair) -> bool {
        let k = a(kp.pubkey());
        self.svm
            .get_account(&s(pda(&[ACCOUNT_SEED, k.as_ref()])))
            .is_some()
    }
}

/// `create_account`; with `invite` the key is added as the first extra (signer) account.
fn create_account(authority: APk, invite: Option<APk>) -> Instruction {
    let mut i = ix(
        accounts::CreateAccount {
            authority,
            account: pda(&[ACCOUNT_SEED, authority.as_ref()]),
            invite_gate: invite_gate_pda(),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::CreateAccount {
            evm_address: [0; 20],
        },
    );
    if let Some(k) = invite {
        i.accounts
            .push(solana_sdk::instruction::AccountMeta::new_readonly(
                s(k),
                true,
            ));
    }
    i
}

#[test]
fn gate_off_by_default_anyone_creates_an_account() {
    let mut env = Env::new();
    let p = env.player();
    env.send(&[create_account(a(p.pubkey()), None)], &[&p])
        .expect("no gate set");
    assert!(env.has_account(&p));
}

#[test]
fn gate_on_refuses_without_the_invite_key_and_accepts_with_it() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let invite = env.invite.insecure_clone();
    env.set_gate(&admin, true, a(invite.pubkey()))
        .expect("gate on");

    let p = env.player();
    let err = env
        .send(&[create_account(a(p.pubkey()), None)], &[&p])
        .expect_err("no co-sign");
    assert_eq!(custom_code(&err), INVITE_REQUIRED);

    let stranger = Keypair::new();
    let err = env
        .send(
            &[create_account(a(p.pubkey()), Some(a(stranger.pubkey())))],
            &[&p, &stranger],
        )
        .expect_err("wrong key");
    assert_eq!(custom_code(&err), INVITE_REQUIRED);
    assert!(!env.has_account(&p));

    env.send(
        &[create_account(a(p.pubkey()), Some(a(invite.pubkey())))],
        &[&p, &invite],
    )
    .expect("co-signed");
    assert!(env.has_account(&p));
}

#[test]
fn gate_off_again_needs_no_co_sign() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    env.set_gate(&admin, true, a(env.invite.pubkey()))
        .expect("on");
    env.set_gate(&admin, false, APk::default()).expect("off");
    let p = env.player();
    env.send(&[create_account(a(p.pubkey()), None)], &[&p])
        .expect("gate off");
    assert!(env.has_account(&p));
}

#[test]
fn only_the_admin_sets_the_gate_and_it_needs_a_key() {
    let mut env = Env::new();
    let p = env.player();
    let err = env
        .set_gate(&p, true, a(env.invite.pubkey()))
        .expect_err("not admin");
    assert_eq!(custom_code(&err), UNAUTHORIZED);
    let admin = env.admin.insecure_clone();
    let err = env
        .set_gate(&admin, true, APk::default())
        .expect_err("no key");
    assert_eq!(custom_code(&err), INVITE_REQUIRED + 1);
}

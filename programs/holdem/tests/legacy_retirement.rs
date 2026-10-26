//! The admin retire of old per-Match `Hole` records, run against the real SBF in LiteSVM on bytes
//! copied from finalized devnet (tests/fixtures/legacy). Needs `target/deploy/holdem.so` (build the programs first).
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{AccountSerialize, Discriminator, InstructionData, ToAccountMetas};
use holdem::state::{TableConfig, CONFIG_SEED, LEGACY_HOLE_LENGTHS};
use holdem::{accounts, instruction, HoldemError, Hole, ID};
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction, InstructionError},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};

const FIXTURES: [&str; 2] = ["hole76", "hole80"];

fn ap(key: Pubkey) -> APk {
    APk::new_from_array(key.to_bytes())
}
fn sp(key: APk) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
}
fn config_key() -> APk {
    APk::find_program_address(&[CONFIG_SEED], &ID).0
}
fn fixture(name: &str) -> (Pubkey, Vec<u8>) {
    // Line 1: devnet address. Line 2: the account's data, hex, copied from finalized devnet.
    let path = format!(
        "{}/tests/fixtures/legacy/{name}.txt",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(path).expect("fixture");
    let mut lines = text.lines();
    let key = lines.next().expect("address").parse().expect("key");
    let hex = lines.next().expect("data").as_bytes();
    let data = hex
        .chunks(2)
        .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
        .collect();
    (key, data)
}
fn code(e: HoldemError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

struct Env {
    svm: LiteSVM,
    operator: Keypair,
}
impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(
            sp(ID),
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/holdem.so"),
        )
        .expect("fresh SBF");
        let operator = Keypair::new();
        svm.airdrop(&operator.pubkey(), 1_000_000_000)
            .expect("operator");
        let mut config = Vec::new();
        TableConfig {
            bump: APk::find_program_address(&[CONFIG_SEED], &ID).1,
            operator: ap(operator.pubkey()),
            generation: 1,
            max_tables: 2,
        }
        .try_serialize(&mut config)
        .expect("config");
        let mut env = Self { svm, operator };
        env.put(sp(config_key()), ID, config);
        env
    }
    fn put(&mut self, key: Pubkey, owner: APk, data: Vec<u8>) {
        self.svm
            .set_account(
                key,
                Account {
                    lamports: 7_000_000,
                    data,
                    owner: sp(owner),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("account");
    }
    fn retire(&mut self, signer: &Keypair, account: Pubkey) -> Result<(), u32> {
        self.svm.expire_blockhash();
        let metas = accounts::RetireLegacyAccount {
            operator: ap(signer.pubkey()),
            config: config_key(),
            account: ap(account),
        };
        let ix = Instruction {
            program_id: sp(ID),
            accounts: metas
                .to_account_metas(None)
                .into_iter()
                .map(|m| AccountMeta {
                    pubkey: sp(m.pubkey),
                    is_signer: m.is_signer,
                    is_writable: m.is_writable,
                })
                .collect(),
            data: instruction::RetireLegacyAccount {}.data(),
        };
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&signer.pubkey()),
            &[signer],
            self.svm.latest_blockhash(),
        );
        match self.svm.send_transaction(tx) {
            Ok(_) => Ok(()),
            Err(e) => match e.err {
                TransactionError::InstructionError(_, InstructionError::Custom(c)) => Err(c),
                other => panic!("{other:?}: {:?}", e.meta.logs),
            },
        }
    }
    fn untouched(&self, key: Pubkey, before: &Account) {
        assert_eq!(&self.svm.get_account(&key).expect("still there"), before);
    }
}

#[test]
fn real_devnet_records_retire_and_the_rent_goes_to_the_operator() {
    for name in FIXTURES {
        let mut env = Env::new();
        let (key, data) = fixture(name);
        assert_eq!(&data[..8], Hole::DISCRIMINATOR, "{name}");
        assert!(LEGACY_HOLE_LENGTHS.contains(&data.len()), "{name}");
        env.put(key, ID, data);
        let operator = env.operator.insecure_clone();
        let before = env.svm.get_balance(&operator.pubkey()).unwrap();
        env.retire(&operator, key).expect(name);
        let after = env.svm.get_balance(&operator.pubkey()).unwrap();
        // The operator also pays the 5,000 lamport fee.
        assert_eq!(after, before + 7_000_000 - 5_000, "{name}");
        assert!(
            env.svm
                .get_account(&key)
                .is_none_or(|a| a.data.is_empty() && a.lamports == 0),
            "{name}"
        );
    }
}

#[test]
fn only_the_operator_retires() {
    let mut env = Env::new();
    let (key, data) = fixture(FIXTURES[0]);
    env.put(key, ID, data);
    let before = env.svm.get_account(&key).unwrap();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    assert_eq!(
        env.retire(&stranger, key),
        Err(code(HoldemError::NotOperator))
    );
    env.untouched(key, &before);
}

#[test]
fn a_current_layout_record_never_closes() {
    let mut env = Env::new();
    let (key, legacy) = fixture(FIXTURES[0]);
    let mut current = Hole::DISCRIMINATOR.to_vec();
    current.resize(8 + <Hole as anchor_lang::Space>::INIT_SPACE, 0);
    assert!(!LEGACY_HOLE_LENGTHS.contains(&current.len()));
    let _ = legacy;
    env.put(key, ID, current);
    let before = env.svm.get_account(&key).unwrap();
    let operator = env.operator.insecure_clone();
    assert_eq!(
        env.retire(&operator, key),
        Err(code(HoldemError::NotLegacy))
    );
    env.untouched(key, &before);
}

#[test]
fn another_type_or_owner_or_the_config_never_closes() {
    let mut env = Env::new();
    let operator = env.operator.insecure_clone();
    let (key, data) = fixture(FIXTURES[0]);

    // The legacy length under another discriminator.
    let mut other = data.clone();
    other[0] ^= 0xff;
    env.put(key, ID, other);
    let before = env.svm.get_account(&key).unwrap();
    assert_eq!(
        env.retire(&operator, key),
        Err(code(HoldemError::NotLegacy))
    );
    env.untouched(key, &before);

    // The exact legacy bytes owned by the delegation program (an account delegated to a rollup) or the system program.
    for owner in [
        table_kit::DELEGATION_PROGRAM,
        anchor_lang::system_program::ID,
    ] {
        env.put(key, owner, data.clone());
        let before = env.svm.get_account(&key).unwrap();
        assert_eq!(
            env.retire(&operator, key),
            Err(code(HoldemError::NotLegacy))
        );
        env.untouched(key, &before);
    }

    // The Game's own config and the operator's wallet.
    let config = sp(config_key());
    let before = env.svm.get_account(&config).unwrap();
    assert_eq!(
        env.retire(&operator, config),
        Err(code(HoldemError::NotLegacy))
    );
    env.untouched(config, &before);
    assert_eq!(
        env.retire(&operator, operator.pubkey()),
        Err(code(HoldemError::NotLegacy))
    );
}

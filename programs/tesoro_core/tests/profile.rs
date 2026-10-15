//! Profiles: LiteSVM tests against the built program (`pnpm build:programs` first).
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::instruction::Instruction;
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use tesoro_core::state::*;
use tesoro_core::{accounts, instruction};

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
        Self { svm }
    }

    fn player(&mut self) -> (Keypair, APk) {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10 * SOL).expect("airdrop");
        let key = a(kp.pubkey());
        let account = pda(&[ACCOUNT_SEED, key.as_ref()]);
        self.send(
            &[ix(
                accounts::CreateAccount {
                    authority: key,
                    account,
                    invite_gate: invite_gate_pda(),
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::CreateAccount {
                    evm_address: [0; 20],
                },
            )],
            &kp,
        )
        .expect("create account");
        (kp, account)
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

    fn set_profile(
        &mut self,
        signer: &Keypair,
        account: APk,
        name: &str,
        avatar: AvatarChoice,
    ) -> Result<(), Failed> {
        let profile = pda(&[PROFILE_SEED, account.as_ref()]);
        self.send(
            &[ix(
                accounts::SetProfile {
                    authority: a(signer.pubkey()),
                    account,
                    profile,
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::SetProfile {
                    name: name.to_string(),
                    avatar,
                },
            )],
            signer,
        )
    }

    fn send_signed(
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
        self.svm.send_transaction(tx).map(|_| ())
    }

    fn set_name_wallet(
        &mut self,
        signer: &Keypair,
        account: APk,
        wallet: Option<&Keypair>,
    ) -> Result<(), Failed> {
        let profile = pda(&[PROFILE_SEED, account.as_ref()]);
        let instruction = ix(
            accounts::SetNameWallet {
                authority: a(signer.pubkey()),
                account,
                profile,
                wallet: wallet.map(|w| a(w.pubkey())),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetNameWallet {},
        );
        match wallet {
            Some(w) => self.send_signed(&[instruction], signer, w),
            None => self.send(&[instruction], signer),
        }
    }

    /// Plants a bridge `EvmLink` the way `link_evm` writes it.
    fn plant_link(&mut self, evm: [u8; 20], account: APk, owner: APk) -> APk {
        let (key, bump) = APk::find_program_address(&[EVM_LINK_SEED, &evm], &BRIDGE_PROGRAM_ID);
        let mut data = vec![0u8; 8 + 20 + 32 + 32 + 1];
        data[8..28].copy_from_slice(&evm);
        data[28..60].copy_from_slice(&account.to_bytes());
        data[60..92].copy_from_slice(&[7u8; 32]);
        data[92] = bump;
        self.svm
            .set_account(
                s(key),
                solana_sdk::account::Account {
                    lamports: 10_000_000,
                    data,
                    owner: s(owner),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("plant link");
        key
    }

    fn set_name_evm(
        &mut self,
        signer: &Keypair,
        account: APk,
        evm: [u8; 20],
        link: Option<APk>,
    ) -> Result<(), Failed> {
        let profile = pda(&[PROFILE_SEED, account.as_ref()]);
        self.send(
            &[ix(
                accounts::SetNameEvm {
                    authority: a(signer.pubkey()),
                    account,
                    profile,
                    evm_link: link,
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::SetNameEvm { evm_address: evm },
            )],
            signer,
        )
    }

    fn profile(&self, account: APk) -> Profile {
        let key = pda(&[PROFILE_SEED, account.as_ref()]);
        let acct = self.svm.get_account(&s(key)).expect("profile exists");
        assert_eq!(acct.owner, s(tesoro_core::ID));
        assert_eq!(acct.data.len(), Profile::SPACE);
        Profile::try_deserialize(&mut acct.data.as_slice()).expect("deserialize")
    }
}

fn name_of(p: &Profile) -> &str {
    std::str::from_utf8(&p.name[..p.name_len as usize]).expect("utf8")
}

#[test]
fn first_call_creates_and_later_calls_overwrite() {
    let mut env = Env::new();
    let (kp, account) = env.player();
    env.set_profile(&kp, account, "Ana Maria", AvatarChoice::Animal(3))
        .expect("create");
    let p = env.profile(account);
    assert_eq!(name_of(&p), "Ana Maria");
    assert_eq!(p.avatar, AvatarChoice::Animal(3));
    assert_eq!(p.account, account);
    let (_, bump) = APk::find_program_address(&[PROFILE_SEED, account.as_ref()], &tesoro_core::ID);
    assert_eq!(p.bump, bump);

    env.set_profile(&kp, account, "ana.eth-fan", AvatarChoice::NameService)
        .expect("overwrite");
    let p = env.profile(account);
    assert_eq!(name_of(&p), "ana.eth-fan");
    assert_eq!(p.avatar, AvatarChoice::NameService);
    // A shorter name leaves no remnant of the longer one.
    env.set_profile(&kp, account, "Zed", AvatarChoice::Default)
        .expect("shorten");
    let p = env.profile(account);
    assert_eq!(name_of(&p), "Zed");
    assert!(p.name[3..].iter().all(|b| *b == 0));
}

#[test]
fn rejects_bad_names_and_avatars() {
    let mut env = Env::new();
    let (kp, account) = env.player();
    let long = "x".repeat(21);
    for bad in ["", "ab", " abc", "abc ", "a@b", "ça va", long.as_str()] {
        let err = env
            .set_profile(&kp, account, bad, AvatarChoice::Default)
            .expect_err(bad);
        assert_eq!(custom_code(&err), 6000 + 13, "{bad:?}");
    }
    let err = env
        .set_profile(&kp, account, "Fine", AvatarChoice::Animal(12))
        .expect_err("avatar out of range");
    assert_eq!(custom_code(&err), 6000 + 14);
    // Nothing was created by the failed calls.
    assert!(env
        .svm
        .get_account(&s(pda(&[PROFILE_SEED, account.as_ref()])))
        .is_none());
}

#[test]
fn only_the_authority_sets_its_own_profile() {
    let mut env = Env::new();
    let (_owner, account) = env.player();
    let (mallory, _) = env.player();
    // Mallory signs for Alice's Account: the Account PDA does not derive from Mallory's key.
    assert!(env
        .set_profile(&mallory, account, "Hacked", AvatarChoice::Default)
        .is_err());
    // Mallory's own Account with Alice's Profile address: the Profile seeds do not match.
    let (kp2, account2) = env.player();
    let wrong_profile = pda(&[PROFILE_SEED, account.as_ref()]);
    let err = env.send(
        &[ix(
            accounts::SetProfile {
                authority: a(kp2.pubkey()),
                account: account2,
                profile: wrong_profile,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetProfile {
                name: "Hacked".to_string(),
                avatar: AvatarChoice::Default,
            },
        )],
        &kp2,
    );
    assert!(err.is_err());
    assert!(env.svm.get_account(&s(wrong_profile)).is_none());
}

#[test]
fn profile_does_not_change_the_account() {
    let mut env = Env::new();
    let (kp, account) = env.player();
    let before = env.svm.get_account(&s(account)).expect("account").data;
    env.set_profile(&kp, account, "Quiet", AvatarChoice::Default)
        .expect("set");
    let after = env.svm.get_account(&s(account)).expect("account").data;
    assert_eq!(before, after);
}

#[test]
fn name_wallet_needs_the_wallets_signature_and_survives_set_profile() {
    let mut env = Env::new();
    let (kp, account) = env.player();
    let wallet = Keypair::new();
    env.set_name_wallet(&kp, account, Some(&wallet))
        .expect("link");
    let p = env.profile(account);
    assert_eq!(p.name_wallet, a(wallet.pubkey()));
    assert_eq!(p.name_len, 0);
    assert_eq!(p.avatar, AvatarChoice::Default);

    env.set_profile(&kp, account, "Ana", AvatarChoice::NameService)
        .expect("name");
    assert_eq!(env.profile(account).name_wallet, a(wallet.pubkey()));

    env.set_name_wallet(&kp, account, None).expect("clear");
    let p = env.profile(account);
    assert_eq!(p.name_wallet, APk::default());
    assert_eq!(name_of(&p), "Ana");
}

#[test]
fn name_wallet_rejects_a_wallet_that_did_not_sign() {
    let mut env = Env::new();
    let (kp, account) = env.player();
    let wallet = Keypair::new();
    let profile = pda(&[PROFILE_SEED, account.as_ref()]);
    let mut instruction = ix(
        accounts::SetNameWallet {
            authority: a(kp.pubkey()),
            account,
            profile,
            wallet: Some(a(wallet.pubkey())),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::SetNameWallet {},
    );
    for m in instruction.accounts.iter_mut() {
        if m.pubkey == wallet.pubkey() {
            m.is_signer = false;
        }
    }
    assert!(env.send(&[instruction], &kp).is_err());
    assert!(env.svm.get_account(&s(profile)).is_none());
}

#[test]
fn name_evm_needs_a_bridge_link_to_this_account() {
    let mut env = Env::new();
    let (kp, account) = env.player();
    let (_other, other_account) = env.player();
    let evm = [0xAB; 20];

    // No link account at all.
    let err = env
        .set_name_evm(&kp, account, evm, None)
        .expect_err("no link");
    assert_eq!(custom_code(&err), 6000 + 15);

    // A link that belongs to another Account.
    let theirs = env.plant_link(evm, other_account, BRIDGE_PROGRAM_ID);
    let err = env
        .set_name_evm(&kp, account, evm, Some(theirs))
        .expect_err("other account");
    assert_eq!(custom_code(&err), 6000 + 15);

    // A look-alike owned by some other program.
    let (key, _) = APk::find_program_address(&[EVM_LINK_SEED, &[0xCD; 20]], &BRIDGE_PROGRAM_ID);
    let fake = env.plant_link([0xCD; 20], account, anchor_lang::system_program::ID);
    assert_eq!(fake, key);
    let err = env
        .set_name_evm(&kp, account, [0xCD; 20], Some(fake))
        .expect_err("wrong owner");
    assert_eq!(custom_code(&err), 6000 + 15);

    // The link for a different address than the one claimed.
    let err = env
        .set_name_evm(&kp, account, [0xEF; 20], Some(theirs))
        .expect_err("wrong address");
    assert_eq!(custom_code(&err), 6000 + 15);
    assert!(env
        .svm
        .get_account(&s(pda(&[PROFILE_SEED, account.as_ref()])))
        .is_none());

    // The real thing.
    let mine = env.plant_link([0x11; 20], account, BRIDGE_PROGRAM_ID);
    env.set_name_evm(&kp, account, [0x11; 20], Some(mine))
        .expect("linked");
    assert_eq!(env.profile(account).name_evm, [0x11; 20]);

    // Clearing needs no link.
    env.set_name_evm(&kp, account, [0; 20], None)
        .expect("clear");
    assert_eq!(env.profile(account).name_evm, [0; 20]);
}

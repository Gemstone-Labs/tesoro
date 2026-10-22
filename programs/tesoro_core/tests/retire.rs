//! Retiring the old world's money accounts (ticket 11): old-layout accounts are written raw into
//! LiteSVM, then closed by the admin; nothing of the current layout can be. Needs the built
//! program (`pnpm build:programs` first).
#![allow(clippy::result_large_err)]

mod common;

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountSerialize, Discriminator, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{spl_token, ID as TOKEN_PROGRAM_ID};
use litesvm::LiteSVM;
use solana_sdk::account::Account;
use solana_sdk::clock::Clock;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use tesoro_core::ledger::{self, Offer, OfferKind, OfferStatus, Request, RequestStatus, Source};
use tesoro_core::state::*;
use tesoro_core::{accounts, instruction};

const SOL: u64 = 1_000_000_000;
const UNAUTHORIZED: u32 = 6000;
const NOT_OLD_WORLD: u32 = 6030;
const OLD_POSITION_LEN: usize = 159;
const OLD_CUSTODY_LEN: usize = 210;
const OLD_TREASURY_LEN: usize = 103;
const OLD_OFFER_LEN: usize = 553;
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
            .map(|m| AccountMeta {
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

struct Env {
    svm: LiteSVM,
    admin: Keypair,
}

fn put(svm: &mut LiteSVM, key: APk, owner: APk, data: Vec<u8>) {
    svm.set_account(
        s(key),
        Account {
            lamports: 10_000_000,
            data,
            owner: s(owner),
            executable: false,
            rent_epoch: 0,
        },
    )
    .expect("set account");
}

fn with_disc(disc: &[u8], len: usize) -> Vec<u8> {
    let mut d = vec![0u8; len];
    d[..8].copy_from_slice(disc);
    d
}

fn serialized<T: AccountSerialize>(v: &T, len: usize) -> Vec<u8> {
    let mut d = Vec::new();
    v.try_serialize(&mut d).expect("serialize");
    d.resize(len, 0);
    d
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(
            s(tesoro_core::ID),
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../target/deploy/tesoro_core.so"
            ),
        )
        .expect("build the program first: pnpm build:programs");
        let _ = LOADER;
        common::put_sim_sol_mint(&mut svm);
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 100 * SOL).expect("airdrop");
        let mut env = Self { svm, admin };
        let key = a(env.admin.pubkey());
        let platform = pda(&[ACCOUNT_SEED, key.as_ref()]);
        env.put_account(key);
        let admin = env.admin.insecure_clone();
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

    fn gone(&self, key: APk) -> bool {
        self.svm
            .get_account(&s(key))
            .map(|x| x.data.is_empty() && x.lamports == 0)
            .unwrap_or(true)
    }

    fn put_account(&mut self, authority: APk) -> APk {
        let key = pda(&[ACCOUNT_SEED, authority.as_ref()]);
        let acct = TesoroAccount {
            bump: APk::find_program_address(&[ACCOUNT_SEED, authority.as_ref()], &tesoro_core::ID)
                .1,
            authority,
            evm_address: [0; 20],
        };
        put(
            &mut self.svm,
            key,
            tesoro_core::ID,
            serialized(&acct, TesoroAccount::SPACE),
        );
        key
    }

    fn put_token(&mut self, key: APk, owner: APk, amount: u64) {
        let mut data = vec![0u8; spl_token::state::Account::LEN];
        spl_token::state::Account {
            mint: SIM_SOL_MINT,
            owner,
            amount,
            state: spl_token::state::AccountState::Initialized,
            ..Default::default()
        }
        .pack_into_slice(&mut data);
        put(&mut self.svm, key, TOKEN_PROGRAM_ID, data);
    }

    fn token_amount(&self, key: APk) -> u64 {
        let data = self.svm.get_account(&s(key)).expect("token").data;
        spl_token::state::Account::unpack(&data)
            .expect("unpack")
            .amount
    }

    /// An old per-Position custody `["native", position]`, its vault holding `shares`, and the
    /// owner's ATA (when `with_ata`).
    fn old_custody(
        &mut self,
        position: APk,
        owner: APk,
        shares: u64,
        with_ata: bool,
    ) -> (APk, APk) {
        let (custody, bump) =
            APk::find_program_address(&[NATIVE_SEED, position.as_ref()], &tesoro_core::ID);
        let (vault, vault_bump) =
            APk::find_program_address(&[NATIVE_VAULT_SEED, position.as_ref()], &tesoro_core::ID);
        let mut d = with_disc(NativeCustody::DISCRIMINATOR, OLD_CUSTODY_LEN);
        d[8] = bump;
        d[9] = vault_bump;
        d[10..42].copy_from_slice(position.as_ref());
        d[42..74].copy_from_slice(owner.as_ref());
        d[106..138].copy_from_slice(SIM_SOL_MINT.as_ref());
        d[138..170].copy_from_slice(vault.as_ref());
        put(&mut self.svm, custody, tesoro_core::ID, d);
        self.put_token(vault, custody, shares);
        if with_ata {
            self.put_token(
                get_associated_token_address(&owner, &SIM_SOL_MINT),
                owner,
                5,
            );
        }
        (custody, vault)
    }

    fn retire_custody(
        &mut self,
        signer: &Keypair,
        custody: APk,
        vault: APk,
        owner: APk,
    ) -> Result<(), Failed> {
        self.send(
            &[ix(
                accounts::RetireNativeCustody {
                    admin: a(signer.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    custody,
                    vault,
                    owner,
                    owner_token: get_associated_token_address(&owner, &SIM_SOL_MINT),
                    mint: SIM_SOL_MINT,
                    token_program: TOKEN_PROGRAM_ID,
                    associated_token_program: anchor_spl::associated_token::ID,
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::RetireNativeCustody {},
            )],
            &[signer],
        )
    }

    fn retire_position(&mut self, signer: &Keypair, position: APk) -> Result<(), Failed> {
        self.send(
            &[ix(
                accounts::RetirePosition {
                    admin: a(signer.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    position,
                },
                instruction::RetirePosition {},
            )],
            &[signer],
        )
    }

    fn retire_source(&mut self, source: APk, position: APk) -> Result<(), Failed> {
        let admin = self.admin.insecure_clone();
        self.send(
            &[ix(
                accounts::RetireSource {
                    admin: a(admin.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    source,
                    position,
                },
                instruction::RetireSource {},
            )],
            &[&admin],
        )
    }

    fn retire_holding(&mut self, holding: APk, source: APk) -> Result<(), Failed> {
        let admin = self.admin.insecure_clone();
        self.send(
            &[ix(
                accounts::RetireHolding {
                    admin: a(admin.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    holding,
                    source,
                },
                instruction::RetireHolding {},
            )],
            &[&admin],
        )
    }

    fn retire_offer(&mut self, offer: APk) -> Result<(), Failed> {
        let admin = self.admin.insecure_clone();
        let i = ix(
            accounts::RetireOffer {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                offer,
            },
            instruction::RetireOffer {},
        );
        self.send(&[i], &[&admin])
    }

    fn retire_request(&mut self, request: APk) -> Result<(), Failed> {
        let admin = self.admin.insecure_clone();
        self.send(
            &[ix(
                accounts::RetireRequest {
                    admin: a(admin.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    request,
                },
                instruction::RetireRequest {},
            )],
            &[&admin],
        )
    }

    fn retire_treasury(&mut self) -> Result<(), Failed> {
        let admin = self.admin.insecure_clone();
        self.send(
            &[ix(
                accounts::RetireTreasury {
                    admin: a(admin.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    treasury: common::treasury(),
                },
                instruction::RetireTreasury {},
            )],
            &[&admin],
        )
    }
}

fn source_for(position: APk, owner: APk) -> SourceState {
    SourceState {
        bump: 255,
        inner: Source {
            position: position.to_bytes(),
            owner: owner.to_bytes(),
            index: 0,
            horizon_months: 1,
            unit_num: 1,
            unit_den: 1,
            issued: 100,
            returned: 0,
            redeemed: 0,
            yield_units: 0,
            redeemed_units: 0,
            due_at: 0,
        },
    }
}

/// The bytes of a Holding of the retired world: `disc(8) bump(1) account(32) source(32)` and its
/// amounts. The program no longer has the type; the wipe reads these raw bytes.
fn holding_for(account: APk, source: APk) -> Vec<u8> {
    let mut data =
        anchor_lang::solana_program::hash::hash(b"account:HoldingState").to_bytes()[..8].to_vec();
    data.push(255);
    data.extend_from_slice(account.as_ref());
    data.extend_from_slice(source.as_ref());
    data.resize(90, 0);
    data
}

#[test]
fn custody_returns_simsol_to_the_owner_and_closes_vault_and_custody() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let (position, owner) = (APk::new_unique(), APk::new_unique());
    let (custody, vault) = env.old_custody(position, owner, 7_000, true);
    let ata = get_associated_token_address(&owner, &SIM_SOL_MINT);
    env.retire_custody(&admin, custody, vault, owner)
        .expect("retire");
    assert_eq!(env.token_amount(ata), 7_005);
    assert!(env.gone(custody) && env.gone(vault));
    let err = env
        .retire_custody(&admin, custody, vault, owner)
        .expect_err("twice");
    drop(err);
}

#[test]
fn custody_creates_the_owner_token_account_when_it_is_gone() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let (position, owner) = (APk::new_unique(), APk::new_unique());
    let (custody, vault) = env.old_custody(position, owner, 42, false);
    env.retire_custody(&admin, custody, vault, owner)
        .expect("retire");
    assert_eq!(
        env.token_amount(get_associated_token_address(&owner, &SIM_SOL_MINT)),
        42
    );
    assert!(env.gone(custody) && env.gone(vault));
}

#[test]
fn only_the_admin_retires() {
    let mut env = Env::new();
    let stranger = Keypair::new();
    env.svm
        .airdrop(&stranger.pubkey(), 10 * SOL)
        .expect("airdrop");
    let (position, owner) = (APk::new_unique(), APk::new_unique());
    let (custody, vault) = env.old_custody(position, owner, 1, true);
    let err = env
        .retire_custody(&stranger, custody, vault, owner)
        .expect_err("stranger");
    assert_eq!(custom_code(&err), UNAUTHORIZED);
    let pos = APk::new_unique();
    put(
        &mut env.svm,
        pos,
        tesoro_core::ID,
        with_disc(PositionState::DISCRIMINATOR, OLD_POSITION_LEN),
    );
    let err = env.retire_position(&stranger, pos).expect_err("stranger");
    assert_eq!(custom_code(&err), UNAUTHORIZED);
    assert!(!env.gone(pos) && !env.gone(custody));
}

#[test]
fn a_current_custody_is_refused() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let (position, owner) = (APk::new_unique(), APk::new_unique());
    let (custody, vault) = env.old_custody(position, owner, 1, true);
    let mut acct = env.svm.get_account(&s(custody)).expect("custody");
    acct.data.resize(NativeCustody::SPACE, 0);
    env.svm.set_account(s(custody), acct).expect("set");
    let err = env
        .retire_custody(&admin, custody, vault, owner)
        .expect_err("current size");
    assert_eq!(custom_code(&err), NOT_OLD_WORLD);
}

#[test]
fn a_custody_must_match_its_position_seeds_and_owner() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let (position, owner) = (APk::new_unique(), APk::new_unique());
    let (custody, vault) = env.old_custody(position, owner, 1, true);
    let other = APk::new_unique();
    env.put_token(
        get_associated_token_address(&other, &SIM_SOL_MINT),
        other,
        0,
    );
    assert!(env.retire_custody(&admin, custody, vault, other).is_err());
    assert!(!env.gone(custody));
}

#[test]
fn positions_retire_only_when_stale_and_only_once() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let old = APk::new_unique();
    let current = APk::new_unique();
    put(
        &mut env.svm,
        old,
        tesoro_core::ID,
        with_disc(PositionState::DISCRIMINATOR, OLD_POSITION_LEN),
    );
    put(
        &mut env.svm,
        current,
        tesoro_core::ID,
        with_disc(PositionState::DISCRIMINATOR, PositionState::SPACE),
    );
    let before = env.svm.get_balance(&admin.pubkey()).expect("balance");
    env.retire_position(&admin, old).expect("old position");
    assert!(env.svm.get_balance(&admin.pubkey()).expect("balance") > before - 10_000);
    assert!(env.gone(old));
    let err = env.retire_position(&admin, current).expect_err("current");
    assert_eq!(custom_code(&err), NOT_OLD_WORLD);
    assert!(!env.gone(current));
    let err = env.retire_position(&admin, old).expect_err("twice");
    assert_eq!(custom_code(&err), NOT_OLD_WORLD);
}

#[test]
fn sources_and_holdings_follow_their_position() {
    let mut env = Env::new();
    let owner = APk::new_unique();
    let position = APk::new_unique();
    let source = APk::new_unique();
    let holding = APk::new_unique();
    let acct = env.put_account(owner);
    put(
        &mut env.svm,
        position,
        tesoro_core::ID,
        with_disc(PositionState::DISCRIMINATOR, OLD_POSITION_LEN),
    );
    put(
        &mut env.svm,
        source,
        tesoro_core::ID,
        serialized(&source_for(position, acct), SourceState::SPACE),
    );
    put(
        &mut env.svm,
        holding,
        tesoro_core::ID,
        holding_for(acct, source),
    );
    let own2 = APk::new_unique();
    put(
        &mut env.svm,
        own2,
        tesoro_core::ID,
        holding_for(acct, source),
    );

    let err = env
        .retire_holding(holding, source)
        .expect_err("source still there");
    assert_eq!(custom_code(&err), NOT_OLD_WORLD);
    env.retire_source(source, position)
        .expect("source of a stale position");
    assert!(env.gone(source));
    env.retire_holding(holding, source).expect("holding");
    env.retire_holding(own2, source).expect("won holding");
    assert!(env.gone(holding) && env.gone(own2));
    assert!(env.retire_holding(holding, source).is_err(), "twice");
}

#[test]
fn a_source_of_a_current_position_is_refused_and_so_are_its_holdings() {
    let mut env = Env::new();
    let owner = APk::new_unique();
    let position = APk::new_unique();
    let source = APk::new_unique();
    let holding = APk::new_unique();
    let acct = env.put_account(owner);
    put(
        &mut env.svm,
        position,
        tesoro_core::ID,
        with_disc(PositionState::DISCRIMINATOR, PositionState::SPACE),
    );
    put(
        &mut env.svm,
        source,
        tesoro_core::ID,
        serialized(&source_for(position, acct), SourceState::SPACE),
    );
    put(
        &mut env.svm,
        holding,
        tesoro_core::ID,
        holding_for(acct, source),
    );
    let err = env
        .retire_source(source, position)
        .expect_err("current position");
    assert_eq!(custom_code(&err), NOT_OLD_WORLD);
    let err = env
        .retire_holding(holding, source)
        .expect_err("live source");
    assert_eq!(custom_code(&err), NOT_OLD_WORLD);
    let other = APk::new_unique();
    assert!(
        env.retire_source(source, other).is_err(),
        "wrong position address"
    );
    assert!(!env.gone(holding));
}

#[test]
fn offers_retire_when_old_sized_and_only_then() {
    let mut env = Env::new();
    let stale = APk::new_unique();
    put(
        &mut env.svm,
        stale,
        tesoro_core::ID,
        with_disc(OfferState::DISCRIMINATOR, OLD_OFFER_LEN),
    );
    env.retire_offer(stale).expect("old-sized offer");
    assert!(env.gone(stale));

    // the layout that carried reserved lines
    let long = APk::new_unique();
    put(
        &mut env.svm,
        long,
        tesoro_core::ID,
        with_disc(OfferState::DISCRIMINATOR, 799),
    );
    env.retire_offer(long).expect("offer with reserved lines");
    assert!(env.gone(long));

    // a live Offer of the current layout is not the old world
    let live = APk::new_unique();
    let state = OfferState {
        bump: 255,
        nonce: 1,
        inner: Offer {
            backer: [1; 32],
            game: [2; 32],
            entry: 500,
            player_share_bps: 0,
            kind: OfferKind::Public,
            status: OfferStatus::Open,
            expires_at: 0,
            use_by: 0,
            player: None,
            request: None,
            applicants: vec![],
            ticket_open: false,
        },
    };
    put(
        &mut env.svm,
        live,
        tesoro_core::ID,
        serialized(&state, OfferState::SPACE),
    );
    let err = env
        .retire_offer(live)
        .expect_err("nothing proves it is old");
    assert_eq!(custom_code(&err), NOT_OLD_WORLD);
}

#[test]
fn requests_retire_only_after_their_whole_life() {
    let mut env = Env::new();
    let request = APk::new_unique();
    let state = RequestState {
        bump: 255,
        nonce: 1,
        inner: Request {
            player: [1; 32],
            game: [2; 32],
            entry: 500,
            expires_at: 1_000,
            status: RequestStatus::Accepted,
        },
    };
    put(
        &mut env.svm,
        request,
        tesoro_core::ID,
        serialized(&state, RequestState::SPACE),
    );
    let set_time = |env: &mut Env, t: i64| {
        env.svm.set_sysvar(&Clock {
            unix_timestamp: t,
            ..Clock::default()
        });
    };
    set_time(&mut env, 1_000 + ledger::BACKING_TTL_SECS);
    let err = env
        .retire_request(request)
        .expect_err("an accepted Backing may still be used");
    assert_eq!(custom_code(&err), NOT_OLD_WORLD);
    set_time(&mut env, 1_001 + ledger::BACKING_TTL_SECS);
    env.retire_request(request).expect("dead");
    assert!(env.gone(request));
}

#[test]
fn requests_of_the_new_world_never_retire() {
    let mut env = Env::new();
    let request = APk::new_unique();
    let expires_at = tesoro_core::instructions::retire::RETIRE_REQUESTS_BEFORE;
    let state = RequestState {
        bump: 255,
        nonce: 1,
        inner: Request {
            player: [1; 32],
            game: [2; 32],
            entry: 500,
            expires_at,
            status: RequestStatus::Open,
        },
    };
    put(
        &mut env.svm,
        request,
        tesoro_core::ID,
        serialized(&state, RequestState::SPACE),
    );
    env.svm.set_sysvar(&Clock {
        unix_timestamp: expires_at + 10 * ledger::BACKING_TTL_SECS,
        ..Clock::default()
    });
    let err = env
        .retire_request(request)
        .expect_err("opened after the reset");
    assert_eq!(custom_code(&err), NOT_OLD_WORLD);
}

#[test]
fn only_an_old_treasury_closes_and_init_treasury_recreates_it() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let key = a(admin.pubkey());
    put(
        &mut env.svm,
        common::treasury(),
        tesoro_core::ID,
        with_disc(Treasury::DISCRIMINATOR, OLD_TREASURY_LEN),
    );
    env.retire_treasury().expect("old treasury");
    assert!(env.gone(common::treasury()));
    env.send(&[common::init_treasury_ix(key, 2000, 2500)], &[&admin])
        .expect("init after retire");
    let err = env.retire_treasury().expect_err("current treasury");
    assert_eq!(custom_code(&err), NOT_OLD_WORLD);
    assert!(!env.gone(common::treasury()));
}

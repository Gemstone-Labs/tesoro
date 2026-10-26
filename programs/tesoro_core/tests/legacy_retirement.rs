//! Legacy-account retirement boundaries (devnet state is disposable), exercised against the actual SBF in LiteSVM.
//! Counters and balances inside a legacy account never block its retirement; owner, discriminator,
//! exact historical length, canonical address and parent links always do.
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{Discriminator, InstructionData, ToAccountMetas};
use litesvm::{types::FailedTransactionMetadata, LiteSVM};
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction, InstructionError},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};
use tesoro_core::{accounts, instruction, state::*, LegacyKind};

const NOT_OLD_WORLD: u32 = 6030;
const INVALID_ACCOUNT: u32 = 6003;
const LEGACY_SOURCE_LEN: usize = 142;
const LEGACY_HOLDING_LEN: usize = 90;

fn ap(key: Pubkey) -> APk {
    APk::new_from_array(key.to_bytes())
}
fn sp(key: APk) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
}
fn pda(seeds: &[&[u8]]) -> (APk, u8) {
    APk::find_program_address(seeds, &tesoro_core::ID)
}
fn ix(metas: impl ToAccountMetas, args: impl InstructionData) -> Instruction {
    Instruction {
        program_id: sp(tesoro_core::ID),
        accounts: metas
            .to_account_metas(None)
            .into_iter()
            .map(|m| AccountMeta {
                pubkey: sp(m.pubkey),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
        data: args.data(),
    }
}
fn code(e: FailedTransactionMetadata) -> u32 {
    match e.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => c,
        other => panic!("{other:?}: {:?}", e.meta.logs),
    }
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    payer: Keypair,
}
impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(
            sp(tesoro_core::ID),
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../target/deploy/tesoro_core.so"
            ),
        )
        .expect("fresh SBF");
        let admin = Keypair::new();
        let payer = Keypair::new();
        svm.airdrop(&admin.pubkey(), 1_000_000_000).expect("admin");
        svm.airdrop(&payer.pubkey(), 1_000_000_000).expect("payer");
        let mut env = Self { svm, admin, payer };
        let admin = ap(env.admin.pubkey());
        let platform = pda(&[ACCOUNT_SEED, admin.as_ref()]).0;
        // Initialization only requires an existing, correctly owned platform identity.
        let mut identity = TesoroAccount::DISCRIMINATOR.to_vec();
        identity.push(pda(&[ACCOUNT_SEED, admin.as_ref()]).1);
        identity.extend_from_slice(admin.as_ref());
        identity.extend_from_slice(&[0; 20]);
        env.put(platform, tesoro_core::ID, identity);
        env.send(
            ix(
                accounts::InitializeConfig {
                    admin,
                    config: pda(&[CONFIG_SEED]).0,
                    platform_recipient: platform,
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::InitializeConfig {
                    oracle_authority: APk::new_unique(),
                    platform_bps: 200,
                },
            ),
            true,
        )
        .expect("Config");
        env
    }
    fn put(&mut self, key: APk, owner: APk, data: Vec<u8>) {
        self.svm
            .set_account(
                sp(key),
                Account {
                    lamports: 10_000_000,
                    data,
                    owner: sp(owner),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("fixture");
    }
    fn is_gone(&self, key: APk) -> bool {
        self.get(key)
            .is_none_or(|a| a.data.is_empty() && a.lamports == 0)
    }
    fn get(&self, key: APk) -> Option<Account> {
        self.svm.get_account(&sp(key))
    }
    fn source(&mut self, position: APk, counters: [u64; 5]) -> APk {
        let (key, bump) = pda(&[SOURCE_SEED, position.as_ref(), &0u32.to_le_bytes()]);
        let mut data = SourceState::DISCRIMINATOR.to_vec();
        data.push(bump);
        data.extend_from_slice(position.as_ref());
        data.extend_from_slice(APk::new_unique().as_ref());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.push(1);
        data.extend_from_slice(&1u128.to_le_bytes());
        data.extend_from_slice(&1u64.to_le_bytes());
        for value in counters {
            data.extend_from_slice(&value.to_le_bytes());
        }
        assert_eq!(data.len(), LEGACY_SOURCE_LEN);
        self.put(key, tesoro_core::ID, data);
        key
    }
    fn holding(&mut self, source: APk, amount: u64, reserved: u64) -> APk {
        let account = APk::new_unique();
        let (key, bump) = pda(&[b"holding", account.as_ref(), source.as_ref()]);
        let mut data = anchor_lang::solana_program::hash::hash(b"account:HoldingState").to_bytes()
            [..8]
            .to_vec();
        data.push(bump);
        data.extend_from_slice(account.as_ref());
        data.extend_from_slice(source.as_ref());
        data.push(1);
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&reserved.to_le_bytes());
        assert_eq!(data.len(), LEGACY_HOLDING_LEN);
        self.put(key, tesoro_core::ID, data);
        key
    }
    fn source_ix(&self, source: APk, position: APk) -> Instruction {
        ix(
            accounts::RetireSource {
                admin: ap(self.admin.pubkey()),
                config: pda(&[CONFIG_SEED]).0,
                source,
                position,
            },
            instruction::RetireSource {},
        )
    }
    fn holding_ix(&self, holding: APk, source: APk) -> Instruction {
        ix(
            accounts::RetireHolding {
                admin: ap(self.admin.pubkey()),
                config: pda(&[CONFIG_SEED]).0,
                holding,
                source,
            },
            instruction::RetireHolding {},
        )
    }
    fn send(
        &mut self,
        instruction: Instruction,
        admin_signs: bool,
    ) -> Result<(), FailedTransactionMetadata> {
        self.svm.expire_blockhash();
        let mut signers = vec![&self.payer];
        if admin_signs {
            signers.push(&self.admin);
        }
        let tx = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&self.payer.pubkey()),
            &signers,
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).map(|_| ())
    }
    fn refused(&mut self, ix: Instruction, error: u32, protected: &[APk]) {
        // A separate fee payer makes it possible to prove no rent moved to the admin on refusal.
        let before: Vec<_> = protected.iter().map(|k| self.get(*k)).collect();
        let admin = self.svm.get_balance(&self.admin.pubkey());
        assert_eq!(
            code(self.send(ix, true).expect_err("retirement must refuse")),
            error
        );
        assert_eq!(admin, self.svm.get_balance(&self.admin.pubkey()));
        for (key, previous) in protected.iter().zip(before) {
            assert_eq!(self.get(*key), previous, "preserve {key}");
        }
    }
}

#[test]
fn legacy_sources_and_holdings_retire_whatever_they_counted() {
    let mut env = Env::new();
    for counters in [
        [100, 0, 20, 25, 20],
        [100, 100, 0, 0, 0],
        [0, 1, 0, 0, 0],
        [u64::MAX, u64::MAX, u64::MAX, 0, 0],
    ] {
        let position = APk::new_unique();
        let source = env.source(position, counters);
        let holding = env.holding(source, 80, 5);
        env.refused(
            env.holding_ix(holding, source),
            NOT_OLD_WORLD,
            &[source, holding],
        );
        let rent = env.get(source).expect("Source").lamports;
        let admin = env.svm.get_balance(&env.admin.pubkey()).expect("admin");
        env.send(env.source_ix(source, position), true)
            .expect("legacy Source");
        assert!(env.is_gone(source));
        assert_eq!(env.svm.get_balance(&env.admin.pubkey()), Some(admin + rent));
        let rent = env.get(holding).expect("Holding").lamports;
        let admin = env.svm.get_balance(&env.admin.pubkey()).expect("admin");
        env.send(env.holding_ix(holding, source), true)
            .expect("legacy Holding with Gemas");
        assert!(env.is_gone(holding));
        assert_eq!(env.svm.get_balance(&env.admin.pubkey()), Some(admin + rent));
        assert!(env.send(env.source_ix(source, position), true).is_err());
        assert!(env.send(env.holding_ix(holding, source), true).is_err());
    }
}

#[test]
fn holding_stays_while_its_source_exists() {
    let mut env = Env::new();
    for (amount, reserved) in [(0, 0), (1, 0), (u64::MAX, u64::MAX)] {
        let source = env.source(APk::new_unique(), [0; 5]);
        let holding = env.holding(source, amount, reserved);
        env.refused(
            env.holding_ix(holding, source),
            NOT_OLD_WORLD,
            &[holding, source],
        );
    }
}

#[test]
fn source_requires_exact_historical_layout_program_owner_canonical_pda_and_bump() {
    let mut env = Env::new();
    for len in [
        0,
        8,
        9,
        41,
        73,
        94,
        141,
        143,
        150,
        SourceState::SPACE,
        SourceState::SPACE + 1,
    ] {
        let position = APk::new_unique();
        let source = env.source(position, [0; 5]);
        let mut data = env.get(source).expect("Source").data;
        data.resize(len, 0);
        env.put(source, tesoro_core::ID, data);
        env.refused(env.source_ix(source, position), NOT_OLD_WORLD, &[source]);
    }
    for offset in [0, 8, 73] {
        let position = APk::new_unique();
        let source = env.source(position, [0; 5]);
        let mut data = env.get(source).expect("Source").data;
        data[offset] ^= 1;
        env.put(source, tesoro_core::ID, data);
        env.refused(
            env.source_ix(source, position),
            if offset == 0 {
                NOT_OLD_WORLD
            } else {
                INVALID_ACCOUNT
            },
            &[source],
        );
    }
    let position = APk::new_unique();
    let source = env.source(position, [0; 5]);
    let data = env.get(source).expect("Source").data;
    let impostor = APk::new_unique();
    env.put(impostor, tesoro_core::ID, data.clone());
    env.refused(
        env.source_ix(impostor, position),
        INVALID_ACCOUNT,
        &[source, impostor],
    );
    env.put(source, APk::new_unique(), data);
    env.refused(env.source_ix(source, position), NOT_OLD_WORLD, &[source]);
}

#[test]
fn source_refuses_wrong_parent_and_every_existing_position_layout() {
    let mut env = Env::new();
    let position = APk::new_unique();
    let source = env.source(position, [0; 5]);
    env.refused(
        env.source_ix(source, APk::new_unique()),
        INVALID_ACCOUNT,
        &[source, position],
    );
    for len in [0, 8, 159, 193, PositionState::SPACE] {
        let mut data = PositionState::DISCRIMINATOR.to_vec();
        data.resize(len, 0);
        env.put(position, tesoro_core::ID, data);
        env.refused(
            env.source_ix(source, position),
            NOT_OLD_WORLD,
            &[source, position],
        );
    }
    env.put(position, anchor_lang::system_program::ID, vec![1]);
    env.refused(
        env.source_ix(source, position),
        NOT_OLD_WORLD,
        &[source, position],
    );
    env.put(position, APk::new_unique(), vec![]);
    env.refused(
        env.source_ix(source, position),
        NOT_OLD_WORLD,
        &[source, position],
    );
}

#[test]
fn source_refuses_malformed_historical_owner_horizon_and_price() {
    let mut env = Env::new();
    for (start, end, value) in [
        (41, 73, 0),
        (77, 78, 0),
        (77, 78, 13),
        (78, 94, 0),
        (94, 102, 0),
    ] {
        let position = APk::new_unique();
        let source = env.source(position, [0; 5]);
        let mut data = env.get(source).expect("Source").data;
        data[start..end].fill(value);
        env.put(source, tesoro_core::ID, data);
        env.refused(env.source_ix(source, position), NOT_OLD_WORLD, &[source]);
    }
}

#[test]
fn aliases_and_forged_config_cannot_authorize_closure() {
    let mut env = Env::new();
    let position = APk::new_unique();
    let source = env.source(position, [0; 5]);
    let holding = env.holding(APk::new_unique(), 0, 0);
    env.refused(env.source_ix(source, source), INVALID_ACCOUNT, &[source]);
    env.refused(
        env.holding_ix(holding, holding),
        INVALID_ACCOUNT,
        &[holding],
    );
    let config = pda(&[CONFIG_SEED]).0;
    let impostor = APk::new_unique();
    env.put(
        impostor,
        tesoro_core::ID,
        env.get(config).expect("Config").data,
    );
    let mut instruction = env.source_ix(source, position);
    instruction.accounts[1].pubkey = sp(impostor);
    env.refused(instruction, 2006, &[config, impostor, source]);
}

#[test]
fn holding_requires_exact_historical_layout_program_owner_links_pda_bump_and_bool() {
    let mut env = Env::new();
    let source = APk::new_unique();
    for len in [0, 8, 41, 73, 74, 82, 89, 91, 100] {
        let holding = env.holding(source, 0, 0);
        let mut data = env.get(holding).expect("Holding").data;
        data.resize(len, 0);
        env.put(holding, tesoro_core::ID, data);
        env.refused(
            env.holding_ix(holding, source),
            NOT_OLD_WORLD,
            &[holding, source],
        );
    }
    for offset in [0, 8, 9, 73] {
        let holding = env.holding(source, 0, 0);
        let mut data = env.get(holding).expect("Holding").data;
        data[offset] = if offset == 73 { 2 } else { data[offset] ^ 1 };
        env.put(holding, tesoro_core::ID, data);
        env.refused(
            env.holding_ix(holding, source),
            if offset == 0 || offset == 73 {
                NOT_OLD_WORLD
            } else {
                INVALID_ACCOUNT
            },
            &[holding],
        );
    }
    let holding = env.holding(source, 0, 0);
    env.refused(
        env.holding_ix(holding, APk::new_unique()),
        INVALID_ACCOUNT,
        &[holding],
    );
    let data = env.get(holding).expect("Holding").data;
    let impostor = APk::new_unique();
    env.put(impostor, tesoro_core::ID, data.clone());
    env.refused(
        env.holding_ix(impostor, source),
        INVALID_ACCOUNT,
        &[holding, impostor],
    );
    env.put(holding, APk::new_unique(), data);
    env.refused(env.holding_ix(holding, source), NOT_OLD_WORLD, &[holding]);
}

#[test]
fn source_and_holding_require_the_real_admin_and_a_signer() {
    let mut env = Env::new();
    let position = APk::new_unique();
    let source = env.source(position, [0; 5]);
    let holding = env.holding(APk::new_unique(), 0, 0);
    let parent = APk::new_from_array(
        env.get(holding).expect("Holding").data[41..73]
            .try_into()
            .expect("key"),
    );
    for mut i in [
        env.source_ix(source, position),
        env.holding_ix(holding, parent),
    ] {
        let before = (env.get(source), env.get(holding));
        i.accounts[0].pubkey = env.payer.pubkey();
        assert_eq!(code(env.send(i, false).expect_err("wrong admin")), 6000);
        assert_eq!(before, (env.get(source), env.get(holding)));
    }
    for mut i in [
        env.source_ix(source, position),
        env.holding_ix(holding, parent),
    ] {
        i.accounts[0].is_signer = false;
        assert_eq!(code(env.send(i, false).expect_err("missing signer")), 3010);
    }
}

// --- copied real devnet bytes ---------------------------------------------------------------

fn fixture(name: &str) -> (APk, Vec<u8>) {
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
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).expect("utf8"), 16).expect("hex"))
        .collect();
    (key, data)
}

impl Env {
    fn legacy_ix(&self, account: APk, kind: LegacyKind) -> Instruction {
        ix(
            accounts::RetireLegacyAccount {
                admin: ap(self.admin.pubkey()),
                config: pda(&[CONFIG_SEED]).0,
                account,
            },
            instruction::RetireLegacyAccount { kind },
        )
    }
}

#[test]
fn copied_devnet_source_and_holding_retire() {
    let mut env = Env::new();
    let (source, source_data) = fixture("source");
    let (holding, holding_data) = fixture("holding");
    let position = APk::new_from_array(source_data[9..41].try_into().expect("position"));
    env.put(source, tesoro_core::ID, source_data);
    env.send(env.source_ix(source, position), true)
        .expect("real legacy Source");
    assert!(env.is_gone(source));
    let parent = APk::new_from_array(holding_data[41..73].try_into().expect("source"));
    env.put(holding, tesoro_core::ID, holding_data);
    env.send(env.holding_ix(holding, parent), true)
        .expect("real legacy Holding");
    assert!(env.is_gone(holding));
}

#[test]
fn copied_devnet_matches_and_season_retire_and_only_to_their_kind() {
    let mut env = Env::new();
    for (name, kind, wrong) in [
        ("match435", LegacyKind::Match, LegacyKind::Season),
        ("match915", LegacyKind::Match, LegacyKind::Season),
        ("season", LegacyKind::Season, LegacyKind::Match),
    ] {
        let (key, data) = fixture(name);
        env.put(key, tesoro_core::ID, data);
        env.refused(env.legacy_ix(key, wrong), NOT_OLD_WORLD, &[key]);
        let rent = env.get(key).expect("account").lamports;
        let admin = env.svm.get_balance(&env.admin.pubkey()).expect("admin");
        env.send(env.legacy_ix(key, kind), true).expect(name);
        assert!(env.is_gone(key));
        assert_eq!(env.svm.get_balance(&env.admin.pubkey()), Some(admin + rent));
        assert!(env.send(env.legacy_ix(key, kind), true).is_err(), "twice");
    }
}

#[test]
fn current_matches_seasons_and_lookalikes_are_never_closable() {
    let mut env = Env::new();
    let (_, match_data) = fixture("match435");
    let (_, season_data) = fixture("season");
    for (kind, data, lens) in [
        (
            LegacyKind::Match,
            match_data,
            [0, 8, 434, 436, MatchState::SPACE],
        ),
        (
            LegacyKind::Season,
            season_data,
            [0, 8, 503, 505, SeasonState::SPACE],
        ),
    ] {
        for len in lens {
            let key = APk::new_unique();
            let mut resized = data.clone();
            resized.resize(len, 0);
            env.put(key, tesoro_core::ID, resized);
            env.refused(env.legacy_ix(key, kind), NOT_OLD_WORLD, &[key]);
        }
        let key = APk::new_unique();
        let mut wrong_disc = data.clone();
        wrong_disc[0] ^= 1;
        env.put(key, tesoro_core::ID, wrong_disc);
        env.refused(env.legacy_ix(key, kind), NOT_OLD_WORLD, &[key]);
        let key = APk::new_unique();
        env.put(key, APk::new_unique(), data.clone());
        env.refused(env.legacy_ix(key, kind), NOT_OLD_WORLD, &[key]);
    }
}

#[test]
fn legacy_accounts_need_the_real_admin() {
    let mut env = Env::new();
    let (key, data) = fixture("season");
    env.put(key, tesoro_core::ID, data);
    let mut i = env.legacy_ix(key, LegacyKind::Season);
    i.accounts[0].pubkey = env.payer.pubkey();
    assert_eq!(code(env.send(i, false).expect_err("wrong admin")), 6000);
    let mut i = env.legacy_ix(key, LegacyKind::Season);
    i.accounts[0].is_signer = false;
    assert_eq!(code(env.send(i, false).expect_err("no signer")), 3010);
    assert!(!env.is_gone(key));
}

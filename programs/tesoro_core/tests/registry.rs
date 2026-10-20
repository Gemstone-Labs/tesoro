//! The Game registry: proof of control, changes after a delay, recipient rules.
//! Every test is an attempt to register or change a Game without controlling its program.
//! LiteSVM against the built program (`pnpm build:programs` first). The immutable-program PDA
//! signature cannot be produced from a transaction (only the Game program can sign for it), so
//! its acceptance is covered by the unit tests in `src/registry.rs`; here an immutable program
//! refuses every key.
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::account::Account;
use solana_sdk::clock::Clock;
use solana_sdk::instruction::Instruction;
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use tesoro_core::error::TesoroError;
use tesoro_core::state::*;
use tesoro_core::{accounts, instruction};

mod common;

const SOL: u64 = 1_000_000_000;
const T0: i64 = 1_000_000;
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
fn account_pda(authority: APk) -> APk {
    pda(&[ACCOUNT_SEED, authority.as_ref()])
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
fn code(err: &Failed) -> u32 {
    use solana_sdk::instruction::InstructionError;
    use solana_sdk::transaction::TransactionError;
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => *c,
        other => panic!("unexpected error {other:?}\n{:?}", err.meta.logs),
    }
}
fn anchor(e: TesoroError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    /// A Game program whose upgrade authority is `owner`.
    game: Pk,
    owner: Keypair,
    studio: APk,
    studio_kp: Keypair,
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
        svm.set_sysvar(&Clock {
            unix_timestamp: T0,
            ..Clock::default()
        });
        let mut env = Self {
            svm,
            admin: Keypair::new(),
            game: Pk::new_unique(),
            owner: Keypair::new(),
            studio: APk::default(),
            studio_kp: Keypair::new(),
        };
        let admin = env.admin.insecure_clone();
        env.svm
            .airdrop(&admin.pubkey(), 1_000 * SOL)
            .expect("airdrop");
        env.svm
            .airdrop(&env.owner.pubkey(), 100 * SOL)
            .expect("airdrop");
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
                    oracle_authority: APk::new_unique(),
                    platform_bps: 200,
                },
            )],
            &admin,
            &[],
        )
        .expect("init config");
        common::put_sim_sol_mint(&mut env.svm);
        env.send(
            &[common::init_treasury_ix(a(admin.pubkey()), 0, 3_500)],
            &admin,
            &[],
        )
        .expect("init treasury");
        env.send(
            &[ix(
                accounts::InitLeaderboard {
                    admin: a(admin.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    pool_authority: pda(&[LEADERBOARD_SEED]),
                    pool_account: account_pda(pda(&[LEADERBOARD_SEED])),
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::InitLeaderboard {
                    leaderboard_bps: 100,
                },
            )],
            &admin,
            &[],
        )
        .expect("init leaderboard");
        let studio_kp = env.studio_kp.insecure_clone();
        env.studio = env.create_account(&studio_kp);
        common::forge_upgradeable_program(&mut env.svm, env.game, Some(env.owner.pubkey()), 50);
        env
    }

    fn create_account(&mut self, kp: &Keypair) -> APk {
        self.svm.airdrop(&kp.pubkey(), 10 * SOL).expect("airdrop");
        let account = account_pda(a(kp.pubkey()));
        self.send(
            &[ix(
                accounts::CreateAccount {
                    authority: a(kp.pubkey()),
                    account,
                    invite_gate: invite_gate_pda(),
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::CreateAccount {
                    evm_address: [0; 20],
                },
            )],
            kp,
            &[],
        )
        .expect("create account");
        account
    }

    fn send(
        &mut self,
        ixs: &[Instruction],
        payer: &Keypair,
        extra: &[&Keypair],
    ) -> Result<(), Failed> {
        self.svm.expire_blockhash();
        let mut signers = vec![payer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&payer.pubkey()),
            &signers,
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).map(|_| ())
    }

    fn load<T: AccountDeserialize>(&self, k: APk) -> T {
        let acct = self.svm.get_account(&s(k)).expect("account exists");
        T::try_deserialize(&mut acct.data.as_slice()).expect("deserialize")
    }

    fn set_time(&mut self, t: i64) {
        self.svm.set_sysvar(&Clock {
            unix_timestamp: t,
            ..Clock::default()
        });
    }

    fn record(&self, game: Pk) -> GameRecord {
        self.load(common::game_record(a(game)))
    }

    /// `register_game` for `game`, with explicit program accounts so a test can lie about them.
    #[allow(clippy::too_many_arguments)]
    fn register(
        &mut self,
        control: &Keypair,
        game: Pk,
        program_data: Pk,
        settle_authority: APk,
        studio_bps: u16,
        recipient: APk,
    ) -> Result<(), Failed> {
        let admin = self.admin.insecure_clone();
        let i = ix(
            accounts::RegisterGame {
                payer: a(admin.pubkey()),
                control: a(control.pubkey()),
                config: pda(&[CONFIG_SEED]),
                game_program: a(game),
                program_data: a(program_data),
                studio_recipient: recipient,
                game_record: common::game_record(a(game)),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::RegisterGame {
                settle_authority,
                studio_bps,
            },
        );
        self.send(&[i], &admin, &[control])
    }

    fn register_ok(&mut self) {
        let owner = self.owner.insecure_clone();
        let (game, studio) = (self.game, self.studio);
        self.register(
            &owner,
            game,
            common::program_data_address(game),
            a(Pk::new_unique()),
            300,
            studio,
        )
        .expect("register");
    }

    fn propose(
        &mut self,
        control: &Keypair,
        settle_authority: APk,
        studio_bps: u16,
        recipient: APk,
    ) -> Result<(), Failed> {
        let i = ix(
            accounts::ChangeGame {
                control: a(control.pubkey()),
                config: pda(&[CONFIG_SEED]),
                game_program: a(self.game),
                program_data: a(common::program_data_address(self.game)),
                game_record: common::game_record(a(self.game)),
                studio_recipient: recipient,
            },
            instruction::ProposeGameChange {
                settle_authority,
                studio_bps,
            },
        );
        self.send(&[i], control, &[])
    }

    fn apply(&mut self, control: &Keypair) -> Result<(), Failed> {
        let mut pending = self.record(self.game).pending_studio_recipient;
        if pending == APk::default() {
            pending = self.studio;
        }
        let i = ix(
            accounts::ApplyGameChange {
                control: a(control.pubkey()),
                config: pda(&[CONFIG_SEED]),
                game_program: a(self.game),
                program_data: a(common::program_data_address(self.game)),
                game_record: common::game_record(a(self.game)),
                studio_recipient: pending,
            },
            instruction::ApplyGameChange {},
        );
        self.send(&[i], control, &[])
    }

    fn cancel(&mut self, control: &Keypair) -> Result<(), Failed> {
        let i = ix(
            accounts::CancelGameChange {
                control: a(control.pubkey()),
                game_program: a(self.game),
                program_data: a(common::program_data_address(self.game)),
                game_record: common::game_record(a(self.game)),
            },
            instruction::CancelGameChange {},
        );
        self.send(&[i], control, &[])
    }
}

const WEEK: i64 = 7 * 24 * 60 * 60;

#[test]
fn the_upgrade_authority_registers_its_game_with_the_terms_it_names() {
    let mut e = Env::new();
    e.register_ok();
    let r = e.record(e.game);
    assert_eq!(r.game, a(e.game));
    assert_eq!(r.studio_bps, 300);
    assert_eq!(r.studio_recipient, e.studio);
    assert_eq!((r.listed_until, r.approved_slot, r.pending_at), (0, 0, 0));
    assert!(!r.is_listed(T0, Some(0)), "registering never lists");
}

#[test]
fn nobody_registers_a_game_they_do_not_control() {
    let mut e = Env::new();
    let thief = Keypair::new();
    e.svm.airdrop(&thief.pubkey(), SOL).expect("airdrop");
    let (game, studio) = (e.game, e.studio);
    let pd = common::program_data_address(game);
    let err = e
        .register(&thief, game, pd, a(thief.pubkey()), 300, studio)
        .unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::NotGameControl));
    // The admin does not control other people's programs either.
    let admin = e.admin.insecure_clone();
    let err = e
        .register(&admin, game, pd, a(admin.pubkey()), 300, studio)
        .unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::NotGameControl));
    // The program id itself is not a signer.
    assert!(e
        .svm
        .get_account(&s(common::game_record(a(game))))
        .is_none());
}

#[test]
fn a_game_cannot_be_registered_twice() {
    let mut e = Env::new();
    e.register_ok();
    let owner = e.owner.insecure_clone();
    let (game, studio) = (e.game, e.studio);
    let pd = common::program_data_address(game);
    let before = e.record(game).settle_authority;
    // Same authority, different terms: the only way to change a record is propose + apply.
    assert!(e
        .register(&owner, game, pd, a(Pk::new_unique()), 100, studio)
        .is_err());
    assert_eq!(e.record(game).settle_authority, before);
    assert_eq!(e.record(game).studio_bps, 300);
}

#[test]
fn a_fake_program_data_is_refused() {
    let mut e = Env::new();
    let attacker = Keypair::new();
    e.svm.airdrop(&attacker.pubkey(), SOL).expect("airdrop");
    let (game, studio) = (e.game, e.studio);
    let real = common::program_data_address(game);

    // 1. The right bytes (naming the attacker as authority) at an address the loader never uses.
    let fake = Pk::new_unique();
    let mut fake_acct = e.svm.get_account(&real).expect("real program data");
    fake_acct.data[12] = 1;
    fake_acct.data[13..45].copy_from_slice(attacker.pubkey().as_ref());
    e.svm.set_account(fake, fake_acct).expect("fake");
    let err = e
        .register(&attacker, game, fake, a(attacker.pubkey()), 300, studio)
        .unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::GameProofInvalid));

    // 2. The same, owned by the attacker's own program instead of the loader.
    let mut owned = e.svm.get_account(&real).expect("real program data");
    owned.data[12] = 1;
    owned.data[13..45].copy_from_slice(attacker.pubkey().as_ref());
    owned.owner = Pk::new_unique();
    e.svm.set_account(real, owned).expect("overwrite");
    let err = e
        .register(&attacker, game, real, a(attacker.pubkey()), 300, studio)
        .unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::GameProofInvalid));

    // 3. The attacker's own, genuine program and ProgramData, offered for the victim's program.
    let mine = Pk::new_unique();
    common::forge_upgradeable_program(&mut e.svm, mine, Some(attacker.pubkey()), 5);
    let err = e
        .register(
            &attacker,
            game,
            common::program_data_address(mine),
            a(attacker.pubkey()),
            300,
            studio,
        )
        .unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::GameProofInvalid));
    assert!(e
        .svm
        .get_account(&s(common::game_record(a(game))))
        .is_none());
}

#[test]
fn the_wrong_loader_or_a_non_program_is_refused() {
    let mut e = Env::new();
    let (game, studio) = (e.game, e.studio);
    let owner = e.owner.insecure_clone();
    let pd = common::program_data_address(game);
    // Not executable.
    let mut acct = e.svm.get_account(&game).expect("program");
    acct.executable = false;
    e.svm.set_account(game, acct.clone()).expect("set");
    let err = e
        .register(&owner, game, pd, a(owner.pubkey()), 300, studio)
        .unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::GameProofInvalid));
    // Owned by something that is not a loader, executable or not: never a Game.
    for loader in [anchor_lang::system_program::ID, APk::new_unique()] {
        let mut wrong = acct.clone();
        wrong.owner = s(loader);
        e.svm.set_account(game, wrong).expect("set");
        let err = e
            .register(&owner, game, pd, a(owner.pubkey()), 300, studio)
            .unwrap_err();
        assert_eq!(code(&err), anchor(TesoroError::GameProofInvalid));
    }
    // A built-in program (the system program belongs to the native loader).
    let err = e
        .register(
            &owner,
            s(anchor_lang::system_program::ID),
            pd,
            a(owner.pubkey()),
            300,
            studio,
        )
        .unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::GameProofInvalid));
    // A real deployed program offered with another program's ProgramData (the token program, whose own ProgramData is not supplied).
    let err = e
        .register(
            &owner,
            s(anchor_spl::token::ID),
            pd,
            a(owner.pubkey()),
            300,
            studio,
        )
        .unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::GameProofInvalid));
    // A wallet is not a program.
    let wallet = Keypair::new();
    e.svm.airdrop(&wallet.pubkey(), SOL).expect("airdrop");
    let err = e
        .register(
            &wallet,
            wallet.pubkey(),
            pd,
            a(wallet.pubkey()),
            300,
            studio,
        )
        .unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::GameProofInvalid));
}

#[test]
fn a_closed_program_cannot_register_or_change() {
    let mut e = Env::new();
    let (game, studio) = (e.game, e.studio);
    let owner = e.owner.insecure_clone();
    let pd = common::program_data_address(game);
    // Closed before registering: ProgramData is gone.
    let kept = e.svm.get_account(&pd).expect("program data");
    e.svm.set_account(pd, Account::default()).expect("close");
    let err = e
        .register(&owner, game, pd, a(owner.pubkey()), 300, studio)
        .unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::GameProofInvalid));
    // Closed after registering and proposing: nothing can be applied any more.
    e.svm.set_account(pd, kept).expect("restore");
    e.register_ok();
    e.propose(&owner, a(Pk::new_unique()), 100, studio)
        .expect("propose");
    e.svm.set_account(pd, Account::default()).expect("close");
    e.set_time(T0 + WEEK + 1);
    let err = e.apply(&owner).unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::GameProofInvalid));
}

#[test]
fn a_studio_fee_above_ten_percent_is_refused() {
    let mut e = Env::new();
    let (game, studio) = (e.game, e.studio);
    let owner = e.owner.insecure_clone();
    let pd = common::program_data_address(game);
    for bps in [1_001, 2_000, 5_000, u16::MAX] {
        let err = e
            .register(&owner, game, pd, a(owner.pubkey()), bps, studio)
            .unwrap_err();
        assert_eq!(code(&err), anchor(TesoroError::StudioFeeTooHigh));
    }
    e.register(&owner, game, pd, a(owner.pubkey()), 1_000, studio)
        .expect("10% is the cap");
    assert_eq!(e.record(game).studio_bps, 1_000);
    let err = e
        .propose(&owner, a(owner.pubkey()), 1_001, studio)
        .unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::StudioFeeTooHigh));
}

#[test]
fn the_studio_recipient_may_not_be_the_pool_the_treasury_or_the_platform() {
    let mut e = Env::new();
    let (game, owner) = (e.game, e.owner.insecure_clone());
    let pd = common::program_data_address(game);
    let cfg = e.load::<Config>(pda(&[CONFIG_SEED]));
    let pool = account_pda(pda(&[LEADERBOARD_SEED]));
    let treasury = common::treasury_account();
    assert_eq!(cfg.pool_account, pool);
    for reserved in [pool, treasury, cfg.platform_recipient] {
        let err = e
            .register(&owner, game, pd, a(owner.pubkey()), 300, reserved)
            .unwrap_err();
        assert_eq!(code(&err), anchor(TesoroError::StudioRecipientReserved));
    }
    // Also when changing an existing record.
    e.register_ok();
    for reserved in [pool, treasury, cfg.platform_recipient] {
        let err = e
            .propose(&owner, a(owner.pubkey()), 300, reserved)
            .unwrap_err();
        assert_eq!(code(&err), anchor(TesoroError::StudioRecipientReserved));
    }
    assert_eq!(e.record(game).pending_at, 0);
}

#[test]
fn a_recipient_that_became_reserved_during_the_wait_cannot_be_applied() {
    let mut e = Env::new();
    e.register_ok();
    let owner = e.owner.insecure_clone();
    // A second Account, proposed as the new recipient, then made the platform recipient.
    let other_kp = Keypair::new();
    let other = e.create_account(&other_kp);
    e.propose(&owner, a(owner.pubkey()), 300, other)
        .expect("propose");
    let admin = e.admin.insecure_clone();
    e.send(
        &[ix(
            accounts::UpdateConfig {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                platform_recipient: other,
            },
            instruction::UpdateConfig {
                oracle_authority: APk::new_unique(),
                platform_bps: 200,
            },
        )],
        &admin,
        &[],
    )
    .expect("update config");
    e.set_time(T0 + WEEK + 1);
    let err = e.apply(&owner).unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::StudioRecipientReserved));
}

#[test]
fn a_change_waits_seven_days_and_only_its_authority_makes_it() {
    let mut e = Env::new();
    e.register_ok();
    let owner = e.owner.insecure_clone();
    let thief = Keypair::new();
    e.svm.airdrop(&thief.pubkey(), SOL).expect("airdrop");
    let new_auth = a(Pk::new_unique());
    let studio = e.studio;

    let err = e
        .propose(&thief, a(thief.pubkey()), 300, studio)
        .unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::NotGameControl));
    let err = e.apply(&owner).unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::NoPendingChange));

    e.propose(&owner, new_auth, 250, studio).expect("propose");
    let old_auth = e.record(e.game).settle_authority;
    assert_ne!(old_auth, new_auth);
    for t in [T0, T0 + WEEK - 1] {
        e.set_time(t);
        let err = e.apply(&owner).unwrap_err();
        assert_eq!(code(&err), anchor(TesoroError::ChangeDelayNotElapsed));
    }
    e.set_time(T0 + WEEK);
    let err = e.apply(&thief).unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::NotGameControl));
    e.apply(&owner).expect("apply after 7 days");
    let r = e.record(e.game);
    assert_eq!((r.settle_authority, r.studio_bps), (new_auth, 250));
    assert_eq!(r.pending_at, 0);
    let err = e.apply(&owner).unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::NoPendingChange));
}

#[test]
fn a_proposal_can_be_cancelled_and_a_new_one_restarts_the_wait() {
    let mut e = Env::new();
    e.register_ok();
    let owner = e.owner.insecure_clone();
    let studio = e.studio;
    e.propose(&owner, a(Pk::new_unique()), 100, studio)
        .expect("one");
    e.cancel(&owner).expect("cancel");
    assert_eq!(e.record(e.game).pending_at, 0);
    e.propose(&owner, a(Pk::new_unique()), 100, studio)
        .expect("two");
    e.set_time(T0 + WEEK - 10);
    let second = a(Pk::new_unique());
    e.propose(&owner, second, 120, studio).expect("replace");
    e.set_time(T0 + WEEK + 1);
    let err = e.apply(&owner).unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::ChangeDelayNotElapsed));
    e.set_time(T0 + 2 * WEEK - 10);
    e.apply(&owner).expect("apply the second proposal");
    assert_eq!(e.record(e.game).settle_authority, second);
}

#[test]
fn an_authority_that_changes_hands_during_the_wait_cannot_apply_the_old_proposal() {
    let mut e = Env::new();
    e.register_ok();
    let owner = e.owner.insecure_clone();
    let studio = e.studio;
    let attacker_auth = a(Pk::new_unique());
    e.propose(&owner, attacker_auth, 300, studio)
        .expect("propose");
    // The upgrade authority moves to someone else halfway through the wait.
    let buyer = Keypair::new();
    e.svm.airdrop(&buyer.pubkey(), SOL).expect("airdrop");
    common::set_program_data(&mut e.svm, e.game, Some(buyer.pubkey()), 50);
    e.set_time(T0 + WEEK + 1);
    // The old holder no longer controls the program; the new one never proposed this.
    let err = e.apply(&owner).unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::NotGameControl));
    let err = e.apply(&buyer).unwrap_err();
    assert_eq!(code(&err), anchor(TesoroError::NotGameControl));
    assert_ne!(e.record(e.game).settle_authority, attacker_auth);
    // The old holder cannot start or cancel anything either; the new one starts over.
    assert_eq!(
        code(&e.propose(&owner, attacker_auth, 300, studio).unwrap_err()),
        anchor(TesoroError::NotGameControl)
    );
    assert_eq!(
        code(&e.cancel(&owner).unwrap_err()),
        anchor(TesoroError::NotGameControl)
    );
    let mine = a(Pk::new_unique());
    e.propose(&buyer, mine, 300, studio)
        .expect("new holder proposes");
    e.set_time(T0 + 2 * WEEK + 2);
    e.apply(&buyer).expect("and applies after its own wait");
    assert_eq!(e.record(e.game).settle_authority, mine);
}

#[test]
fn an_immutable_program_accepts_no_key() {
    let mut e = Env::new();
    let (game, studio) = (e.game, e.studio);
    let owner = e.owner.insecure_clone();
    e.register_ok();
    // The authority makes the program immutable.
    common::set_program_data(&mut e.svm, game, None, 50);
    let pd = common::program_data_address(game);
    let thief = Keypair::new();
    e.svm.airdrop(&thief.pubkey(), SOL).expect("airdrop");
    for key in [&owner, &thief] {
        let err = e.propose(key, a(key.pubkey()), 300, studio).unwrap_err();
        assert_eq!(code(&err), anchor(TesoroError::NotGameControl));
        let err = e.cancel(key).unwrap_err();
        assert_eq!(code(&err), anchor(TesoroError::NotGameControl));
    }
    // A fresh immutable program: neither its former authority nor anyone else can register it.
    let frozen = Pk::new_unique();
    common::forge_upgradeable_program(&mut e.svm, frozen, None, 9);
    for key in [&owner, &thief] {
        let err = e
            .register(
                key,
                frozen,
                common::program_data_address(frozen),
                a(key.pubkey()),
                300,
                studio,
            )
            .unwrap_err();
        assert_eq!(code(&err), anchor(TesoroError::NotGameControl));
    }
    let _ = pd;
}

#[test]
fn the_settle_authority_may_not_be_empty() {
    let mut e = Env::new();
    let (game, studio) = (e.game, e.studio);
    let owner = e.owner.insecure_clone();
    let err = e
        .register(
            &owner,
            game,
            common::program_data_address(game),
            APk::default(),
            300,
            studio,
        )
        .unwrap_err();
    assert_eq!(code(&err), 6000);
}

#[test]
fn the_upgrade_authority_can_register_and_pay_with_one_key() {
    let mut e = Env::new();
    let owner = e.owner.insecure_clone();
    let game = e.game;
    let i = ix(
        accounts::RegisterGame {
            payer: a(owner.pubkey()),
            control: a(owner.pubkey()),
            config: pda(&[CONFIG_SEED]),
            game_program: a(game),
            program_data: a(common::program_data_address(game)),
            studio_recipient: e.studio,
            game_record: common::game_record(a(game)),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::RegisterGame {
            settle_authority: a(owner.pubkey()),
            studio_bps: 300,
        },
    );
    e.send(&[i], &owner, &[]).expect("one key pays and signs");
    assert_eq!(e.record(game).settle_authority, a(owner.pubkey()));
}

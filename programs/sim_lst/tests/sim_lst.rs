use anchor_lang::{
    prelude::Pubkey as APk, system_program, AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::{
    associated_token::{get_associated_token_address, ID as ATA_PROGRAM_ID},
    token::{spl_token, ID as TOKEN_PROGRAM_ID},
};
use litesvm::LiteSVM;
use sim_lst::{accounts, instruction, Pool, DEFAULT_SPEEDUP, FAUCET_SEED, RATE_SCALE};
use solana_sdk::{
    clock::Clock,
    instruction::{AccountMeta, Instruction, InstructionError},
    pubkey::Pubkey as Pk,
    signature::Keypair,
    signer::Signer,
    transaction::{Transaction, TransactionError},
};

/// litesvm / solana-sdk 3 and Anchor 0.31 use different `Pubkey` types; bridge through bytes.
fn a(p: Pk) -> APk {
    APk::new_from_array(p.to_bytes())
}
fn s(p: APk) -> Pk {
    Pk::new_from_array(p.to_bytes())
}
fn key(kp: &Keypair) -> APk {
    a(kp.pubkey())
}

fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id: s(sim_lst::ID),
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

const T0: i64 = 1_000_000;
const SOL: u64 = 1_000_000_000;
const APY_BPS: u32 = 700;
const FAUCET_AMOUNT: u64 = 5 * SOL;
const COOLDOWN: i64 = 3_600;

const ERR_UNAUTHORIZED: u32 = 6000;
const ERR_PAUSED: u32 = 6001;
const ERR_INVALID_PARAMS: u32 = 6004;
const ERR_RESERVE: u32 = 6005;
const ERR_FAUCET_DISABLED: u32 = 6006;
const ERR_COOLDOWN: u32 = 6007;

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    pool: APk,
    mint: APk,
    vault: APk,
}

fn pda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &sim_lst::ID).0
}

fn set_time(svm: &mut LiteSVM, ts: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = ts;
    svm.set_sysvar(&clock);
}

fn advance(env: &mut Env, secs: i64) {
    let now = env.svm.get_sysvar::<Clock>().unix_timestamp;
    set_time(&mut env.svm, now + secs);
}

fn send(env: &mut Env, payer: &Keypair, ix: Instruction) -> Result<(), u32> {
    env.svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        env.svm.latest_blockhash(),
    );
    match env.svm.send_transaction(tx) {
        Ok(_) => Ok(()),
        Err(e) => match e.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) => Err(c),
            other => panic!("unexpected error: {other:?} logs: {:?}", e.meta.logs),
        },
    }
}

fn setup_with(faucet_amount: u64) -> Env {
    let mut svm = LiteSVM::new();
    let so = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/sim_lst.so"
    );
    svm.add_program_from_file(s(sim_lst::ID), so)
        .expect("run `pnpm build:programs` first");
    set_time(&mut svm, T0);
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 100 * SOL).unwrap();
    let pool = pda(&[b"pool"]);
    let mint = pda(&[b"mint"]);
    let vault = pda(&[b"vault"]);
    let mut env = Env {
        svm,
        admin: Keypair::new(),
        pool,
        mint,
        vault,
    };
    let init = ix(
        accounts::Initialize {
            admin: key(&admin),
            pool,
            mint,
            vault,
            token_program: TOKEN_PROGRAM_ID,
            system_program: system_program::ID,
        },
        instruction::Initialize {
            apy_bps: APY_BPS,
            speedup: DEFAULT_SPEEDUP,
            faucet_amount,
            faucet_cooldown: COOLDOWN,
        },
    );
    send(&mut env, &admin, init).unwrap();
    env.admin = admin;
    env
}

fn setup() -> Env {
    setup_with(FAUCET_AMOUNT)
}

fn user(env: &mut Env) -> Keypair {
    let kp = Keypair::new();
    env.svm.airdrop(&kp.pubkey(), 100 * SOL).unwrap();
    kp
}

fn ata(env: &Env, who: &Keypair) -> APk {
    get_associated_token_address(&key(who), &env.mint)
}

fn deposit(env: &mut Env, who: &Keypair, lamports: u64) -> Result<(), u32> {
    let deposit = ix(
        accounts::Deposit {
            user: key(who),
            pool: env.pool,
            mint: env.mint,
            user_ata: ata(env, who),
            vault: env.vault,
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        },
        instruction::Deposit { lamports },
    );
    send(env, who, deposit)
}

fn withdraw(env: &mut Env, who: &Keypair, shares: u64) -> Result<(), u32> {
    let withdraw = ix(
        accounts::Withdraw {
            user: key(who),
            pool: env.pool,
            mint: env.mint,
            user_ata: ata(env, who),
            vault: env.vault,
            token_program: TOKEN_PROGRAM_ID,
            system_program: system_program::ID,
        },
        instruction::Withdraw { shares },
    );
    send(env, who, withdraw)
}

fn faucet(env: &mut Env, who: &Keypair) -> Result<(), u32> {
    let faucet = ix(
        accounts::Faucet {
            user: key(who),
            pool: env.pool,
            mint: env.mint,
            user_ata: ata(env, who),
            claim: pda(&[FAUCET_SEED, key(who).as_ref()]),
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        },
        instruction::Faucet {},
    );
    send(env, who, faucet)
}

fn admin_ix(env: &Env, signer: &Pk, data: impl InstructionData) -> Instruction {
    ix(
        accounts::AdminOnly {
            admin: a(*signer),
            pool: env.pool,
        },
        data,
    )
}

fn fund_reserve(env: &mut Env, who: &Keypair, lamports: u64) -> Result<(), u32> {
    let fund = ix(
        accounts::FundReserve {
            admin: key(who),
            pool: env.pool,
            vault: env.vault,
            system_program: system_program::ID,
        },
        instruction::FundReserve { lamports },
    );
    send(env, who, fund)
}

fn pool_state(env: &Env) -> Pool {
    let acc = env.svm.get_account(&s(env.pool)).unwrap();
    Pool::try_deserialize(&mut acc.data.as_slice()).unwrap()
}

fn rate_now(env: &Env) -> u64 {
    sim_lst::current_rate(
        &pool_state(env),
        env.svm.get_sysvar::<Clock>().unix_timestamp,
    )
    .unwrap()
}

fn simsol_balance(env: &Env, who: &Pk) -> u64 {
    let ata = get_associated_token_address(&a(*who), &env.mint);
    match env.svm.get_account(&s(ata)) {
        Some(acc) => {
            use anchor_lang::solana_program::program_pack::Pack;
            spl_token::state::Account::unpack(&acc.data).unwrap().amount
        }
        None => 0,
    }
}

#[test]
fn rate_grows_on_accelerated_clock() {
    let mut env = setup();
    assert_eq!(rate_now(&env), RATE_SCALE);
    // 10 real minutes = 1 simulated month: 7% APY * 600s * 4320 / 1 year.
    advance(&mut env, 600);
    assert_eq!(rate_now(&env), 1_005_753_424);
    // Linear between checkpoints: 20 minutes doubles the growth.
    advance(&mut env, 600);
    assert_eq!(rate_now(&env), 1_011_506_849);
}

#[test]
fn get_rate_returns_current_rate_as_return_data() {
    let mut env = setup();
    advance(&mut env, 600);
    env.svm.expire_blockhash();
    let get_rate = ix(
        accounts::GetRate { pool: env.pool },
        instruction::GetRate {},
    );
    let payer = env.admin.insecure_clone();
    let tx = Transaction::new_signed_with_payer(
        &[get_rate],
        Some(&payer.pubkey()),
        &[&payer],
        env.svm.latest_blockhash(),
    );
    let meta = env.svm.send_transaction(tx).unwrap();
    let rate = u64::from_le_bytes(meta.return_data.data.as_slice().try_into().unwrap());
    assert_eq!(rate, 1_005_753_424);
}

#[test]
fn deposit_withdraw_round_trip_earns_yield_from_reserve() {
    let mut env = setup();
    let alice = user(&mut env);
    deposit(&mut env, &alice, 10 * SOL).unwrap();
    assert_eq!(simsol_balance(&env, &alice.pubkey()), 10 * SOL);

    let admin = env.admin.insecure_clone();
    fund_reserve(&mut env, &admin, 5 * SOL).unwrap();
    advance(&mut env, 600);
    let before = env.svm.get_balance(&alice.pubkey()).unwrap();
    withdraw(&mut env, &alice, 10 * SOL).unwrap();
    let after = env.svm.get_balance(&alice.pubkey()).unwrap();
    // 10 simSOL * 1.005753424 = 10.05753424 SOL (minus the tx fee).
    assert_eq!(after - before, 10_057_534_240 - 5_000);
    assert_eq!(simsol_balance(&env, &alice.pubkey()), 0);
}

#[test]
fn deposit_after_growth_mints_fewer_shares() {
    let mut env = setup();
    advance(&mut env, 600);
    let bob = user(&mut env);
    deposit(&mut env, &bob, SOL).unwrap();
    // 1e9 * 1e9 / 1_005_753_424 rounded down.
    assert_eq!(simsol_balance(&env, &bob.pubkey()), 994_279_488);
}

#[test]
fn withdraw_beyond_reserve_is_refused() {
    let mut env = setup();
    let alice = user(&mut env);
    deposit(&mut env, &alice, 10 * SOL).unwrap();
    advance(&mut env, 600);
    // Vault holds exactly the deposit; the accrued yield is unfunded.
    assert_eq!(withdraw(&mut env, &alice, 10 * SOL), Err(ERR_RESERVE));
    // Funding the reserve unblocks it.
    let admin = env.admin.insecure_clone();
    fund_reserve(&mut env, &admin, SOL).unwrap();
    withdraw(&mut env, &alice, 10 * SOL).unwrap();
}

#[test]
fn only_admin_can_change_params_pause_or_fund() {
    let mut env = setup();
    let mallory = user(&mut env);
    let set_params = instruction::SetParams {
        apy_bps: Some(1),
        speedup: None,
    };
    let ix = admin_ix(&env, &mallory.pubkey(), set_params);
    assert_eq!(send(&mut env, &mallory, ix), Err(ERR_UNAUTHORIZED));
    let ix = admin_ix(
        &env,
        &mallory.pubkey(),
        instruction::SetPaused { paused: true },
    );
    assert_eq!(send(&mut env, &mallory, ix), Err(ERR_UNAUTHORIZED));
    let ix = admin_ix(
        &env,
        &mallory.pubkey(),
        instruction::SetFaucet {
            amount: u64::MAX,
            cooldown: 0,
        },
    );
    assert_eq!(send(&mut env, &mallory, ix), Err(ERR_UNAUTHORIZED));
    assert_eq!(fund_reserve(&mut env, &mallory, SOL), Err(ERR_UNAUTHORIZED));
}

#[test]
fn set_params_rebases_and_keeps_accrued_rate() {
    let mut env = setup();
    advance(&mut env, 600);
    let admin = env.admin.insecure_clone();
    let ix = admin_ix(
        &env,
        &admin.pubkey(),
        instruction::SetParams {
            apy_bps: Some(1_400),
            speedup: None,
        },
    );
    send(&mut env, &admin, ix).unwrap();
    assert_eq!(rate_now(&env), 1_005_753_424);
    advance(&mut env, 600);
    // Second month at 14% compounds on the rebased 1.005753424.
    let expected = 1_005_753_424u64 + 1_005_753_424u64 * 1_400 * 2_592_000 / (10_000 * 31_536_000);
    assert_eq!(rate_now(&env), expected);
    assert_eq!(pool_state(&env).speedup, DEFAULT_SPEEDUP);
}

#[test]
fn invalid_params_are_rejected() {
    let mut env = setup();
    let admin = env.admin.insecure_clone();
    for (apy, speedup) in [(Some(1_000_000), None), (None, Some(0))] {
        let ix = admin_ix(
            &env,
            &admin.pubkey(),
            instruction::SetParams {
                apy_bps: apy,
                speedup,
            },
        );
        assert_eq!(send(&mut env, &admin, ix), Err(ERR_INVALID_PARAMS));
    }
}

#[test]
fn pause_blocks_deposit_withdraw_and_faucet() {
    let mut env = setup();
    let alice = user(&mut env);
    deposit(&mut env, &alice, SOL).unwrap();
    let admin = env.admin.insecure_clone();
    let ix = admin_ix(
        &env,
        &admin.pubkey(),
        instruction::SetPaused { paused: true },
    );
    send(&mut env, &admin, ix).unwrap();
    assert_eq!(deposit(&mut env, &alice, SOL), Err(ERR_PAUSED));
    assert_eq!(withdraw(&mut env, &alice, SOL), Err(ERR_PAUSED));
    assert_eq!(faucet(&mut env, &alice), Err(ERR_PAUSED));
}

#[test]
fn faucet_mints_fixed_amount_once_per_cooldown() {
    let mut env = setup();
    let alice = user(&mut env);
    faucet(&mut env, &alice).unwrap();
    assert_eq!(simsol_balance(&env, &alice.pubkey()), FAUCET_AMOUNT);
    assert_eq!(faucet(&mut env, &alice), Err(ERR_COOLDOWN));
    advance(&mut env, COOLDOWN - 1);
    assert_eq!(faucet(&mut env, &alice), Err(ERR_COOLDOWN));
    advance(&mut env, 1);
    faucet(&mut env, &alice).unwrap();
    assert_eq!(simsol_balance(&env, &alice.pubkey()), 2 * FAUCET_AMOUNT);
    // The limit is per user.
    let bob = user(&mut env);
    faucet(&mut env, &bob).unwrap();
    assert_eq!(simsol_balance(&env, &bob.pubkey()), FAUCET_AMOUNT);
}

#[test]
fn faucet_disabled_when_amount_is_zero() {
    let mut env = setup_with(0);
    let alice = user(&mut env);
    assert_eq!(faucet(&mut env, &alice), Err(ERR_FAUCET_DISABLED));
}

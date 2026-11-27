//! Guided simulation flows for `tesoro_core` + `sim_lst`:
//!
//! Full on-chain lifecycle executed against the real SBF binaries:
//!   1. Bootstrap `sim_lst` pool + yield authority, `tesoro_core` config, treasury, native custody,
//!      price feed ($150/SOL), economy config, treasury stores, and seeded Treasury buffer (0.12 simSOL).
//!   2. Alice opens a 10 simSOL native Position (`open_native_position`) and takes a 2-month Advance
//!      (`take_native_advance`), receiving 1,750 Gemas.
//!   3. Negative control (`early_unlock_rejected`): Alice attempts `unlock` before yield repays the
//!      Advance -> MUST REJECT (`DebtOutstanding`).
//!   4. Exogenous stress (`set_price_shock`): oracle updates SOL/USD by the swept `sol_price_drop_bps`
//!      (0..6000 bps).
//!   5. Alice requests an Instant Redeem of 1,000 Gemas (`request_instant_redeem`) and the admin
//!      executes a third-party fill (`fill_instant_redeem`) out of the seeded Treasury buffer.
//!   6. Clock advances past the 2-month horizon (1,201s at 4,380x speedup): Alice redeems her
//!      remaining Gemas (`redeem`) and unlocks her full 10 simSOL Principal (`unlock`).

#![allow(dead_code, clippy::too_many_lines)]

use std::str::FromStr;

use riptide_sim::anyhow::{anyhow, Result};
use riptide_sim::borsh::BorshSerialize;
use riptide_sim::solana_sdk::hash::hashv;
use riptide_sim::solana_sdk::instruction::{AccountMeta, Instruction};
use riptide_sim::solana_sdk::pubkey::Pubkey;
use riptide_sim::solana_sdk::signature::Keypair;
use riptide_sim::World;

use crate::types;
use crate::Simulation;

pub const SOL: u64 = 1_000_000_000;
pub const T0: i64 = 1_000_000;
pub const BASE_PRICE_MICRO_USD: u64 = 150_000_000; // $150/SOL
pub const MONTH_SECS: i64 = 600;
pub const DEPOSIT_SHARES: u64 = 10 * SOL;
pub const SEEDED_TREASURY_SHARES: u64 = 120_000_000; // 0.12 simSOL
pub const INSTANT_SELL_GEMAS: u64 = 1_000;
pub const TREASURY_UTILIZATION_RISK_LINE_BPS: f64 = 6000.0;

pub const SIM_LST_ID: &str = "WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F";
pub const TOKEN_PROGRAM_STR: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const ATA_PROGRAM_STR: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const SYSTEM_PROGRAM_STR: &str = "11111111111111111111111111111111";

fn sim_lst_id() -> Pubkey {
    Pubkey::from_str(SIM_LST_ID).expect("valid sim_lst id")
}
fn token_program_id() -> Pubkey {
    Pubkey::from_str(TOKEN_PROGRAM_STR).expect("valid token program")
}
fn ata_program_id() -> Pubkey {
    Pubkey::from_str(ATA_PROGRAM_STR).expect("valid ata program")
}
fn system_program_id() -> Pubkey {
    Pubkey::from_str(SYSTEM_PROGRAM_STR).expect("valid system program")
}

fn meta(pubkey: Pubkey, is_signer: bool, is_writable: bool) -> AccountMeta {
    AccountMeta {
        pubkey,
        is_signer,
        is_writable,
    }
}

fn pda(program_id: &Pubkey, seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, program_id).0
}

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    pda(
        &ata_program_id(),
        &[owner.as_ref(), token_program_id().as_ref(), mint.as_ref()],
    )
}

fn native_position_id(owner_authority: &Pubkey, nonce: u64) -> [u8; 32] {
    hashv(&[b"native", owner_authority.as_ref(), &nonce.to_le_bytes()]).to_bytes()
}

pub fn read_token_amount(world: &World, pk: &Pubkey) -> u64 {
    world
        .get_account(pk)
        .filter(|a| a.data.len() >= 72)
        .map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
        .unwrap_or(0)
}

pub fn read_mint_supply(world: &World, mint: &Pubkey) -> u64 {
    world
        .get_account(mint)
        .filter(|a| a.data.len() >= 44)
        .map(|a| u64::from_le_bytes(a.data[36..44].try_into().unwrap()))
        .unwrap_or(0)
}

fn read_source_due_at_and_issued(world: &World, source: &Pubkey) -> Result<(i64, u64)> {
    let acc = world
        .get_account(source)
        .ok_or_else(|| anyhow!("missing source account {source}"))?;
    if acc.data.len() < 150 {
        return Err(anyhow!("source account data too short: {}", acc.data.len()));
    }
    let issued = u64::from_le_bytes(acc.data[102..110].try_into().unwrap());
    let due_at = i64::from_le_bytes(acc.data[142..150].try_into().unwrap());
    Ok((due_at, issued))
}

pub struct CustodySnapshot {
    pub principal: u128,
    pub treasury_shares: u128,
    pub owed_shares: u128,
    pub pool_owed: u128,
    pub reserved: u128,
}

pub fn read_native_custody(world: &World, custody: &Pubkey) -> Result<CustodySnapshot> {
    let acc = world
        .get_account(custody)
        .ok_or_else(|| anyhow!("missing custody account {custody}"))?;
    if acc.data.len() < 242 {
        return Err(anyhow!("custody account too short: {}", acc.data.len()));
    }
    Ok(CustodySnapshot {
        principal: u128::from_le_bytes(acc.data[106..122].try_into().unwrap()),
        treasury_shares: u128::from_le_bytes(acc.data[178..194].try_into().unwrap()),
        owed_shares: u128::from_le_bytes(acc.data[194..210].try_into().unwrap()),
        pool_owed: u128::from_le_bytes(acc.data[210..226].try_into().unwrap()),
        reserved: u128::from_le_bytes(acc.data[226..242].try_into().unwrap()),
    })
}

#[derive(BorshSerialize)]
struct SimLstInitArgs {
    apy_bps: u32,
    speedup: u32,
    faucet_amount: u64,
    faucet_cooldown: i64,
}

#[derive(BorshSerialize)]
struct SimLstSetYieldAuthArgs {
    authority: Pubkey,
}

fn sim_lst_initialize_ix(admin: Pubkey) -> Instruction {
    let sim = sim_lst_id();
    let mut data = vec![175, 175, 109, 31, 13, 152, 155, 237];
    SimLstInitArgs {
        apy_bps: 700,
        speedup: 4_380,
        faucet_amount: 10 * SOL,
        faucet_cooldown: 3_600,
    }
    .serialize(&mut data)
    .expect("serialize sim_lst init");
    Instruction {
        program_id: sim,
        accounts: vec![
            meta(admin, true, true),
            meta(pda(&sim, &[b"pool"]), false, true),
            meta(pda(&sim, &[b"mint"]), false, true),
            meta(pda(&sim, &[b"vault"]), false, true),
            meta(token_program_id(), false, false),
            meta(system_program_id(), false, false),
        ],
        data,
    }
}

fn sim_lst_set_yield_auth_ix(admin: Pubkey, yield_authority: Pubkey) -> Instruction {
    let sim = sim_lst_id();
    let mut data = vec![222, 22, 50, 248, 215, 109, 74, 143];
    SimLstSetYieldAuthArgs {
        authority: yield_authority,
    }
    .serialize(&mut data)
    .expect("serialize set_yield_authority");
    Instruction {
        program_id: sim,
        accounts: vec![
            meta(admin, true, true),
            meta(pda(&sim, &[b"pool"]), false, false),
            meta(pda(&sim, &[b"yield_config"]), false, true),
            meta(system_program_id(), false, false),
        ],
        data,
    }
}

fn sim_lst_faucet_ix(user: Pubkey) -> Instruction {
    let sim = sim_lst_id();
    let mint = pda(&sim, &[b"mint"]);
    Instruction {
        program_id: sim,
        accounts: vec![
            meta(user, true, true),
            meta(pda(&sim, &[b"pool"]), false, false),
            meta(mint, false, true),
            meta(ata(&user, &mint), false, true),
            meta(pda(&sim, &[b"faucet", user.as_ref()]), false, true),
            meta(token_program_id(), false, false),
            meta(ata_program_id(), false, false),
            meta(system_program_id(), false, false),
        ],
        data: vec![0, 98, 59, 30, 144, 142, 113, 12],
    }
}

pub struct TesoroCtx {
    pub program_id: Pubkey,
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub alice: Pubkey,
    pub alice_account: Pubkey,
    pub alice_token: Pubkey,
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub custody: Pubkey,
    pub vault: Pubkey,
    pub treasury: Pubkey,
    pub treasury_vault: Pubkey,
    pub treasury_account: Pubkey,
    pub position: Pubkey,
    pub source: Pubkey,
    pub base_supply: u64,
    pub alice_before_unlock: u64,
    pub alice_after_unlock: u64,
    pub treasury_spent_shares: u64,
    pub treasury_utilization_bps: f64,
    pub vault_solvency_broken: bool,
    pub minted_yield_exceeded: bool,
    pub drop_bps: f64,
}

fn create_tesoro_account(world: &mut World, prog: Pubkey, user: Pubkey) -> Result<Pubkey> {
    let account = pda(&prog, &[b"account", user.as_ref()]);
    let ix = types::create_account(prog)
        .args(types::CreateAccountInstructionData {
            evm_address: [0u8; 20],
        })
        .accounts(types::CreateAccountInstructionAccounts {
            authority: meta(user, true, false),
            account: meta(account, false, true),
            basket: meta(pda(&prog, &[b"basket", account.as_ref()]), false, true),
            spill: meta(pda(&prog, &[b"spill", account.as_ref()]), false, true),
            invite_gate: meta(pda(&prog, &[b"invite_gate"]), false, false),
            system_program: meta(system_program_id(), false, false),
            payer: meta(user, true, true),
            sponsor: meta(prog, false, false), // Option::None
        })
        .instruction();
    world
        .transaction()
        .instruction(ix)
        .signer(user)
        .label("create_account")
        .expect_success()
        .send()?;
    Ok(account)
}

fn kind_paying_metas(prog: Pubkey, dest_token: Pubkey) -> Vec<AccountMeta> {
    let sim = sim_lst_id();
    vec![
        meta(pda(&prog, &[b"native"]), false, true),
        meta(pda(&prog, &[b"native_vault"]), false, true),
        meta(pda(&sim, &[b"pool"]), false, false),
        meta(dest_token, false, true),
        meta(pda(&sim, &[b"mint"]), false, true),
        meta(pda(&sim, &[b"yield_config"]), false, false),
        meta(pda(&prog, &[b"yield"]), false, false),
        meta(sim, false, false),
        meta(token_program_id(), false, false),
    ]
}

fn book_and_page_metas(world: &World, prog: Pubkey, source: Pubkey) -> Vec<AccountMeta> {
    let mut out = vec![meta(pda(&prog, &[b"book", source.as_ref()]), false, true)];
    for class in [1u8, 3u8] {
        let page = pda(
            &prog,
            &[b"ckpt", source.as_ref(), &[class], &0u32.to_le_bytes()],
        );
        if world.get_account(&page).is_some() {
            out.push(meta(page, false, true));
        }
    }
    out
}

fn check_vault_solvency(world: &World, ctx: &mut TesoroCtx) -> Result<()> {
    let cust = read_native_custody(world, &ctx.custody)?;
    let vault_bal = u128::from(read_token_amount(world, &ctx.vault));
    if vault_bal < cust.principal {
        ctx.vault_solvency_broken = true;
    }
    let claims = cust
        .owed_shares
        .saturating_add(cust.pool_owed)
        .saturating_add(cust.reserved);
    if claims > cust.treasury_shares {
        ctx.vault_solvency_broken = true;
    }
    Ok(())
}

pub fn init(sim: &mut Simulation) -> Result<()> {
    let prog = sim.world.program_id();
    let sim_lst = sim_lst_id();
    sim.world.warp_to_timestamp(T0);

    let admin = sim.world.register_keypair(Keypair::new());
    let oracle = sim.world.register_keypair(Keypair::new());
    let platform_owner = sim.world.register_keypair(Keypair::new());
    let alice = sim.world.register_keypair(Keypair::new());
    for pk in [admin, oracle, platform_owner, alice] {
        sim.world.airdrop(&pk, 2 * SOL)?;
    }
    sim.actors.push(alice);

    // 1. Initialize sim_lst pool & yield authority -> tesoro_core ["yield"] PDA
    sim.world
        .transaction()
        .instruction(sim_lst_initialize_ix(admin))
        .signer(admin)
        .label("sim_lst_initialize")
        .expect_success()
        .send()?;
    sim.world
        .transaction()
        .instruction(sim_lst_set_yield_auth_ix(admin, pda(&prog, &[b"yield"])))
        .signer(admin)
        .label("sim_lst_set_yield_authority")
        .expect_success()
        .send()?;

    // 2. Initialize tesoro_core config, treasury, native custody, price feed, economy, stores
    let platform_account = create_tesoro_account(&mut sim.world, prog, platform_owner)?;
    let pool = pda(&sim_lst, &[b"pool"]);
    let mint = pda(&sim_lst, &[b"mint"]);
    let config = pda(&prog, &[b"config"]);
    let treasury = pda(&prog, &[b"treasury"]);
    let treasury_account = pda(&prog, &[b"account", treasury.as_ref()]);
    let treasury_vault = pda(&prog, &[b"treasury_vault"]);
    let custody = pda(&prog, &[b"native"]);
    let vault = pda(&prog, &[b"native_vault"]);
    let economy = pda(&prog, &[b"economy"]);
    let price_feed = pda(&prog, &[b"price", mint.as_ref()]);

    let ix_cfg = types::initialize_config(prog)
        .args(types::InitializeConfigInstructionData {
            oracle_authority: oracle,
            platform_bps: 200,
        })
        .accounts(types::InitializeConfigInstructionAccounts {
            admin: meta(admin, true, true),
            config: meta(config, false, true),
            platform_recipient: meta(platform_account, false, false),
            system_program: meta(system_program_id(), false, false),
        })
        .instruction();
    sim.world
        .transaction()
        .instruction(ix_cfg)
        .signer(admin)
        .label("initialize_config")
        .expect_success()
        .send()?;

    let ix_treas = types::init_treasury(prog)
        .args(types::InitTreasuryInstructionData {
            yield_fee_bps: 2_000,
            instant_fee_bps: 3_500,
        })
        .accounts(types::InitTreasuryInstructionAccounts {
            admin: meta(admin, true, true),
            config: meta(config, false, false),
            treasury: meta(treasury, false, true),
            treasury_account: meta(treasury_account, false, true),
            mint: meta(mint, false, false),
            treasury_vault: meta(treasury_vault, false, true),
            token_program: meta(token_program_id(), false, false),
            system_program: meta(system_program_id(), false, false),
        })
        .instruction();
    sim.world
        .transaction()
        .instruction(ix_treas)
        .signer(admin)
        .label("init_treasury")
        .expect_success()
        .send()?;

    let ix_cust = types::init_native_custody(prog)
        .args(types::InitNativeCustodyInstructionData {})
        .accounts(types::InitNativeCustodyInstructionAccounts {
            admin: meta(admin, true, true),
            config: meta(config, false, false),
            pool: meta(pool, false, false),
            mint: meta(mint, false, false),
            custody: meta(custody, false, true),
            vault: meta(vault, false, true),
            token_program: meta(token_program_id(), false, false),
            system_program: meta(system_program_id(), false, false),
        })
        .instruction();
    sim.world
        .transaction()
        .instruction(ix_cust)
        .signer(admin)
        .label("init_native_custody")
        .expect_success()
        .send()?;

    let ix_price = types::set_price(prog)
        .args(types::SetPriceInstructionData {
            price_micro_usd: BASE_PRICE_MICRO_USD,
        })
        .accounts(types::SetPriceInstructionAccounts {
            oracle: meta(oracle, true, true),
            config: meta(config, false, false),
            price_feed: meta(price_feed, false, true),
            system_program: meta(system_program_id(), false, false),
        })
        .instruction();
    sim.world
        .transaction()
        .instruction(ix_price)
        .signer(oracle)
        .label("set_price_initial")
        .expect_success()
        .send()?;

    let ix_econ = types::set_economy(prog)
        .args(types::SetEconomyInstructionData {
            season_keeper: Pubkey::default(),
            fill_keeper: Pubkey::default(),
            keeper_fills: false,
            routes: [
                custody,
                Pubkey::default(),
                Pubkey::default(),
                Pubkey::default(),
            ],
        })
        .accounts(types::SetEconomyInstructionAccounts {
            admin: meta(admin, true, true),
            config: meta(config, false, false),
            economy: meta(economy, false, true),
            system_program: meta(system_program_id(), false, false),
        })
        .instruction();
    sim.world
        .transaction()
        .instruction(ix_econ)
        .signer(admin)
        .label("set_economy")
        .expect_success()
        .send()?;

    let ix_stores = types::init_stores(prog)
        .args(types::InitStoresInstructionData {})
        .accounts(types::InitStoresInstructionAccounts {
            payer: meta(admin, true, true),
            account: meta(treasury_account, false, false),
            basket: meta(pda(&prog, &[b"basket", treasury_account.as_ref()]), false, true),
            spill: meta(pda(&prog, &[b"spill", treasury_account.as_ref()]), false, true),
            system_program: meta(system_program_id(), false, false),
        })
        .instruction();
    sim.world
        .transaction()
        .instruction(ix_stores)
        .signer(admin)
        .label("init_treasury_stores")
        .expect_success()
        .send()?;

    // 3. Seed Treasury with 0.12 simSOL via sim_lst faucet + fund_treasury
    sim.world
        .transaction()
        .instruction(sim_lst_faucet_ix(admin))
        .signer(admin)
        .label("faucet_admin")
        .expect_success()
        .send()?;
    let ix_fund = types::fund_treasury(prog)
        .args(types::FundTreasuryInstructionData {
            shares: SEEDED_TREASURY_SHARES,
        })
        .accounts(types::FundTreasuryInstructionAccounts {
            admin: meta(admin, true, false),
            config: meta(config, false, false),
            treasury: meta(treasury, false, true),
            custody: meta(custody, false, true),
            treasury_vault: meta(treasury_vault, false, true),
            admin_token: meta(ata(&admin, &mint), false, true),
            token_program: meta(token_program_id(), false, false),
        })
        .instruction();
    sim.world
        .transaction()
        .instruction(ix_fund)
        .signer(admin)
        .label("fund_treasury")
        .expect_success()
        .send()?;

    // 4. Create Alice's account and give her 10 simSOL
    let alice_account = create_tesoro_account(&mut sim.world, prog, alice)?;
    sim.world
        .transaction()
        .instruction(sim_lst_faucet_ix(alice))
        .signer(alice)
        .label("faucet_alice")
        .expect_success()
        .send()?;

    // Record shared account addresses for adapter alignment
    sim.accounts.config.insert("config", config);
    sim.accounts.treasury.insert("treasury", treasury);
    sim.accounts.custody.insert("custody", custody);
    sim.accounts.economy.insert("economy", economy);
    sim.accounts.price_feed.insert("price_feed", price_feed);
    sim.accounts.pool.insert("pool", pool);
    sim.accounts.mint.insert("mint", mint);
    sim.accounts.vault.insert("vault", vault);

    let pos_id = native_position_id(&alice, 1);
    let position = pda(&prog, &[b"position", &[0u8], &pos_id]);
    let source = pda(&prog, &[b"source", position.as_ref(), &0u32.to_le_bytes()]);
    let base_supply = read_mint_supply(&sim.world, &mint);

    sim.ctx = Some(TesoroCtx {
        program_id: prog,
        admin,
        oracle,
        alice,
        alice_account,
        alice_token: ata(&alice, &mint),
        pool,
        mint,
        custody,
        vault,
        treasury,
        treasury_vault,
        treasury_account,
        position,
        source,
        base_supply,
        alice_before_unlock: 0,
        alice_after_unlock: 0,
        treasury_spent_shares: 0,
        treasury_utilization_bps: 0.0,
        vault_solvency_broken: false,
        minted_yield_exceeded: false,
        drop_bps: 0.0,
    });
    Ok(())
}

pub fn guided_flow(sim: &mut Simulation) -> Result<()> {
    if sim.lifecycle_done {
        return Ok(());
    }
    sim.lifecycle_done = true;

    let drop_bps = sim.world.sweep_value("sol_price_drop_bps").unwrap_or(0.0);
    sim.world.record_parameter("sol_price_drop_bps", drop_bps);

    let mut ctx = sim
        .ctx
        .take()
        .ok_or_else(|| anyhow!("TesoroCtx not initialized"))?;
    ctx.drop_bps = drop_bps;
    let prog = ctx.program_id;
    let config = pda(&prog, &[b"config"]);
    let economy = pda(&prog, &[b"economy"]);
    let price_feed = pda(&prog, &[b"price", ctx.mint.as_ref()]);
    let alice_basket = pda(&prog, &[b"basket", ctx.alice_account.as_ref()]);
    let alice_spill = pda(&prog, &[b"spill", ctx.alice_account.as_ref()]);
    let alice_protections = pda(&prog, &[b"protections", ctx.alice_account.as_ref()]);
    let book = pda(&prog, &[b"book", ctx.source.as_ref()]);

    // Step 1: Alice opens 10 simSOL native position
    let ix_open = types::open_native_position(prog)
        .args(types::OpenNativePositionInstructionData {
            nonce: 1,
            lst_amount: DEPOSIT_SHARES,
        })
        .accounts(types::OpenNativePositionInstructionAccounts {
            owner_authority: meta(ctx.alice, true, true),
            owner_account: meta(ctx.alice_account, false, false),
            pool: meta(ctx.pool, false, false),
            mint: meta(ctx.mint, false, false),
            owner_token: meta(ctx.alice_token, false, true),
            position: meta(ctx.position, false, true),
            treasury: meta(ctx.treasury, false, false),
            custody: meta(ctx.custody, false, true),
            vault: meta(ctx.vault, false, true),
            token_program: meta(token_program_id(), false, false),
            system_program: meta(system_program_id(), false, false),
        })
        .instruction();
    sim.world
        .transaction()
        .instruction(ix_open)
        .signer(ctx.alice)
        .label("open_native_position")
        .expect_success()
        .send()?;
    check_vault_solvency(&sim.world, &mut ctx)?;

    // Step 2: Alice takes a 2-month native yield Advance (1,750 Gemas at $150/SOL)
    let ix_adv = types::take_native_advance(prog)
        .args(types::TakeNativeAdvanceInstructionData {
            horizon_months: 2,
            min_gemas: 1,
        })
        .accounts(types::TakeNativeAdvanceInstructionAccounts {
            owner_authority: meta(ctx.alice, true, true),
            owner_account: meta(ctx.alice_account, false, false),
            protections: meta(alice_protections, false, false),
            position: meta(ctx.position, false, true),
            price_feed: meta(price_feed, false, false),
            pool: meta(ctx.pool, false, false),
            source: meta(ctx.source, false, true),
            book: meta(book, false, true),
            basket: meta(alice_basket, false, true),
            spill: meta(alice_spill, false, true),
            economy: meta(economy, false, false),
            system_program: meta(system_program_id(), false, false),
        })
        .instruction();
    sim.world
        .transaction()
        .instruction(ix_adv)
        .signer(ctx.alice)
        .label("take_native_advance")
        .expect_success()
        .send()?;

    // Initialize checkpoint pages for class 1 (Leaderboard) and class 3 (General)
    for class in [1u8, 3u8] {
        let page = pda(
            &prog,
            &[b"ckpt", ctx.source.as_ref(), &[class], &0u32.to_le_bytes()],
        );
        let ix_ckpt = types::init_ckpt_page(prog)
            .args(types::InitCkptPageInstructionData { class, page_no: 0 })
            .accounts(types::InitCkptPageInstructionAccounts {
                payer: meta(ctx.admin, true, true),
                book: meta(book, false, false),
                page: meta(page, false, true),
                system_program: meta(system_program_id(), false, false),
            })
            .instruction();
        sim.world
            .transaction()
            .instruction(ix_ckpt)
            .signer(ctx.admin)
            .label("init_ckpt_page")
            .expect_success()
            .send()?;
    }

    let (due_at, issued) = read_source_due_at_and_issued(&sim.world, &ctx.source)?;
    let line_ref = types::LineRef {
        side: 0, // SIDE_OWN
        due_at,
        class: 3, // CLASS_GENERAL
        tranche: 0,
    };

    // Step 3: Negative control — early Unlock before yield repays the Advance MUST REJECT
    // with exact CoreError::DebtOutstanding (CORE_ERROR_OFFSET 6100 + 10 = Custom(6110)).
    const EXPECTED_DEBT_OUTSTANDING_ERR: &str = "Custom(6110)";
    let mut early_unlock_ix = types::unlock(prog)
        .args(types::UnlockInstructionData {})
        .accounts(types::UnlockInstructionAccounts {
            owner_authority: meta(ctx.alice, true, false),
            owner_account: meta(ctx.alice_account, false, false),
            economy: meta(economy, false, false),
            position: meta(ctx.position, false, true),
        })
        .instruction();
    early_unlock_ix
        .accounts
        .extend(kind_paying_metas(prog, ctx.alice_token));
    early_unlock_ix.accounts.push(meta(ctx.source, false, false));
    early_unlock_ix
        .accounts
        .extend(book_and_page_metas(&sim.world, prog, ctx.source));
    let early_outcome = sim
        .world
        .transaction()
        .instruction(early_unlock_ix)
        .signer(ctx.alice)
        .label("early_unlock_rejected")
        .expect_error()
        .send()?;
    let early_err = early_outcome.error.as_deref().unwrap_or("");
    if !early_err.contains(EXPECTED_DEBT_OUTSTANDING_ERR) {
        return Err(anyhow!(
            "early_unlock_rejected failed with unexpected error `{early_err}` (expected `{EXPECTED_DEBT_OUTSTANDING_ERR}` / DebtOutstanding); logs: {:?}",
            early_outcome.logs
        ));
    }

    // Step 4: Exogenous SOL/USD price shock along the swept axis
    sim.world.expire_blockhash();
    let drop_u64 = (drop_bps as u64).min(9_000);
    let shocked_price = BASE_PRICE_MICRO_USD * (10_000 - drop_u64) / 10_000;
    let ix_shock = types::set_price(prog)
        .args(types::SetPriceInstructionData {
            price_micro_usd: shocked_price,
        })
        .accounts(types::SetPriceInstructionAccounts {
            oracle: meta(ctx.oracle, true, true),
            config: meta(config, false, false),
            price_feed: meta(price_feed, false, true),
            system_program: meta(system_program_id(), false, false),
        })
        .instruction();
    sim.world
        .transaction()
        .instruction(ix_shock)
        .signer(ctx.oracle)
        .label("set_price_shock")
        .expect_success()
        .send()?;

    // Step 5: Alice requests Instant Redeem for 1,000 unmatured Gemas; Admin fills from Treasury
    let order_nonce = 1u64;
    let order = pda(
        &prog,
        &[b"instant", ctx.alice_account.as_ref(), &order_nonce.to_le_bytes()],
    );
    let mut ix_req = types::request_instant_redeem(prog)
        .args(types::RequestInstantRedeemInstructionData {
            line: line_ref.clone(),
            sell: INSTANT_SELL_GEMAS,
            ttl_secs: 7 * 24 * 3_600,
            nonce: order_nonce,
        })
        .accounts(types::RequestInstantRedeemInstructionAccounts {
            payer: meta(ctx.alice, true, true),
            holder_authority: meta(ctx.alice, true, false),
            holder_account: meta(ctx.alice_account, false, false),
            basket: meta(alice_basket, false, true),
            spill: meta(alice_spill, false, true),
            position: meta(ctx.position, false, true),
            source: meta(ctx.source, false, true),
            order: meta(order, false, true),
            sponsor: meta(prog, false, false),
            system_program: meta(system_program_id(), false, false),
        })
        .instruction();
    ix_req
        .accounts
        .extend(kind_paying_metas(prog, ctx.alice_token));
    ix_req
        .accounts
        .extend(book_and_page_metas(&sim.world, prog, ctx.source));
    sim.world
        .transaction()
        .instruction(ix_req)
        .signer(ctx.alice)
        .label("request_instant_redeem")
        .expect_success()
        .send()?;

    let treasury_before = read_token_amount(&sim.world, &ctx.treasury_vault);
    let mut ix_fill = types::fill_instant_redeem(prog)
        .args(types::FillInstantRedeemInstructionData {
            gemas: INSTANT_SELL_GEMAS,
        })
        .accounts(types::FillInstantRedeemInstructionAccounts {
            filler: meta(ctx.admin, true, false),
            config: meta(config, false, false),
            economy: meta(economy, false, false),
            treasury: meta(ctx.treasury, false, false),
            treasury_account: meta(ctx.treasury_account, false, false),
            treasury_basket: meta(pda(&prog, &[b"basket", ctx.treasury_account.as_ref()]), false, true),
            treasury_spill: meta(pda(&prog, &[b"spill", ctx.treasury_account.as_ref()]), false, true),
            order: meta(order, false, true),
            owner_wallet: meta(ctx.alice, false, true),
            sponsor: meta(prog, false, false),
            position: meta(ctx.position, false, true),
            source: meta(ctx.source, false, true),
        })
        .instruction();
    ix_fill
        .accounts
        .extend(kind_paying_metas(prog, ctx.alice_token));
    ix_fill.accounts.push(meta(ctx.treasury_vault, false, true));
    ix_fill
        .accounts
        .extend(book_and_page_metas(&sim.world, prog, ctx.source));
    sim.world
        .transaction()
        .instruction(ix_fill)
        .signer(ctx.admin)
        .label("fill_instant_redeem")
        .expect_success()
        .send()?;
    check_vault_solvency(&sim.world, &mut ctx)?;

    let treasury_after = read_token_amount(&sim.world, &ctx.treasury_vault);
    ctx.treasury_spent_shares = treasury_before.saturating_sub(treasury_after);
    ctx.treasury_utilization_bps =
        (ctx.treasury_spent_shares as f64) * 10_000.0 / (SEEDED_TREASURY_SHARES as f64);

    // Step 6: Advance clock past 2-month horizon (1,201s); Alice redeems remaining Gemas & unlocks
    sim.world.advance_time(2 * MONTH_SECS + 1);
    let remaining_gemas = issued.saturating_sub(INSTANT_SELL_GEMAS);
    let mut ix_redeem = types::redeem(prog)
        .args(types::RedeemInstructionData {
            line: line_ref,
            amount: remaining_gemas,
        })
        .accounts(types::RedeemInstructionAccounts {
            holder_authority: meta(ctx.alice, true, false),
            holder_account: meta(ctx.alice_account, false, false),
            basket: meta(alice_basket, false, true),
            spill: meta(alice_spill, false, true),
            position: meta(ctx.position, false, true),
            source: meta(ctx.source, false, true),
        })
        .instruction();
    ix_redeem
        .accounts
        .extend(kind_paying_metas(prog, ctx.alice_token));
    ix_redeem
        .accounts
        .extend(book_and_page_metas(&sim.world, prog, ctx.source));
    sim.world
        .transaction()
        .instruction(ix_redeem)
        .signer(ctx.alice)
        .label("redeem")
        .expect_success()
        .send()?;
    check_vault_solvency(&sim.world, &mut ctx)?;

    ctx.alice_before_unlock = read_token_amount(&sim.world, &ctx.alice_token);
    let mut ix_unlock = types::unlock(prog)
        .args(types::UnlockInstructionData {})
        .accounts(types::UnlockInstructionAccounts {
            owner_authority: meta(ctx.alice, true, false),
            owner_account: meta(ctx.alice_account, false, false),
            economy: meta(economy, false, false),
            position: meta(ctx.position, false, true),
        })
        .instruction();
    ix_unlock
        .accounts
        .extend(kind_paying_metas(prog, ctx.alice_token));
    ix_unlock.accounts.push(meta(ctx.source, false, false));
    ix_unlock
        .accounts
        .extend(book_and_page_metas(&sim.world, prog, ctx.source));
    sim.world
        .transaction()
        .instruction(ix_unlock)
        .signer(ctx.alice)
        .label("unlock")
        .expect_success()
        .send()?;
    ctx.alice_after_unlock = read_token_amount(&sim.world, &ctx.alice_token);
    check_vault_solvency(&sim.world, &mut ctx)?;

    // Check minted yield bound: total newly minted simSOL <= accrued yield over 2 months + 1s
    // Accrued = 10 SOL * 700 / 10_000 * (1201 * 4380) / 31_536_000 ~= 116_763_888 lamports
    let supply_now = read_mint_supply(&sim.world, &ctx.mint);
    let minted = supply_now.saturating_sub(ctx.base_supply);
    let accrued_upper =
        (u128::from(DEPOSIT_SHARES) * 700 * 1_201 * 4_380) / (10_000 * 31_536_000) + 10;
    if u128::from(minted) > accrued_upper {
        ctx.minted_yield_exceeded = true;
    }

    sim.world.record_metric("shocked_price_micro_usd", shocked_price as f64);
    sim.world.record_metric("treasury_spent_shares", ctx.treasury_spent_shares as f64);
    sim.world.record_metric("treasury_utilization_bps", ctx.treasury_utilization_bps);
    sim.world.record_metric("minted_yield_shares", minted as f64);
    sim.world.record_metric(
        "principal_returned_shares",
        ctx.alice_after_unlock.saturating_sub(ctx.alice_before_unlock) as f64,
    );

    sim.ctx = Some(ctx);
    Ok(())
}

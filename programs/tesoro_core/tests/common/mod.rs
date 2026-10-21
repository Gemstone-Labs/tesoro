//! Treasury setup shared by the LiteSVM suites that do not load `sim_lst`.
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::token::{spl_token, ID as TOKEN_PROGRAM_ID};
use litesvm::LiteSVM;
use solana_sdk::account::Account;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey as Pk;
use tesoro_core::state::*;
use tesoro_core::{accounts, instruction};

fn s(p: APk) -> Pk {
    Pk::new_from_array(p.to_bytes())
}
fn pda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &tesoro_core::ID).0
}

pub fn treasury() -> APk {
    pda(&[TREASURY_SEED])
}

pub fn treasury_account() -> APk {
    pda(&[ACCOUNT_SEED, treasury().as_ref()])
}

/// A simSOL mint at `SIM_SOL_MINT`, so the Treasury's vault can be created without `sim_lst`.
pub fn put_sim_sol_mint(svm: &mut LiteSVM) {
    let mut data = vec![0u8; spl_token::state::Mint::LEN];
    spl_token::state::Mint {
        mint_authority: COption::None,
        supply: 0,
        decimals: 9,
        is_initialized: true,
        freeze_authority: COption::None,
    }
    .pack_into_slice(&mut data);
    svm.set_account(
        s(SIM_SOL_MINT),
        Account {
            lamports: 10_000_000,
            data,
            owner: s(TOKEN_PROGRAM_ID),
            executable: false,
            rent_epoch: 0,
        },
    )
    .expect("mint");
}

pub fn init_treasury_ix(admin: APk, yield_fee_bps: u16, instant_fee_bps: u16) -> Instruction {
    let accounts = accounts::InitTreasury {
        admin,
        config: pda(&[CONFIG_SEED]),
        treasury: treasury(),
        treasury_account: treasury_account(),
        mint: SIM_SOL_MINT,
        treasury_vault: pda(&[TREASURY_VAULT_SEED]),
        token_program: TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
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
        data: instruction::InitTreasury {
            yield_fee_bps,
            instant_fee_bps,
        }
        .data(),
    }
}

// ---- Game registry fixtures ----

pub const UPGRADEABLE_LOADER: &str = "BPFLoaderUpgradeab1e11111111111111111111111";

pub fn program_data_address(program: Pk) -> Pk {
    let loader: Pk = UPGRADEABLE_LOADER.parse().expect("loader id");
    Pk::find_program_address(&[program.as_ref()], &loader).0
}

/// Writes an upgradeable-loader Program account and its ProgramData, as the loader lays them out.
/// `authority: None` is a program that can no longer be upgraded.
pub fn forge_upgradeable_program(svm: &mut LiteSVM, program: Pk, authority: Option<Pk>, slot: u64) {
    let loader: Pk = UPGRADEABLE_LOADER.parse().expect("loader id");
    let pd = program_data_address(program);
    let mut prog = 2u32.to_le_bytes().to_vec();
    prog.extend_from_slice(pd.as_ref());
    svm.set_account(
        program,
        Account {
            lamports: 1_000_000_000,
            data: prog,
            owner: loader,
            executable: true,
            rent_epoch: 0,
        },
    )
    .expect("program");
    set_program_data(svm, program, authority, slot);
}

/// Rewrites the ProgramData of a forged program (an upgrade or an authority change).
pub fn set_program_data(svm: &mut LiteSVM, program: Pk, authority: Option<Pk>, slot: u64) {
    set_program_code(svm, program, authority, slot, &[0xAB; 64]);
}

/// ProgramData with these executable bytes after the 45-byte header.
pub fn set_program_code(
    svm: &mut LiteSVM,
    program: Pk,
    authority: Option<Pk>,
    slot: u64,
    code: &[u8],
) {
    let loader: Pk = UPGRADEABLE_LOADER.parse().expect("loader id");
    let mut data = 3u32.to_le_bytes().to_vec();
    data.extend_from_slice(&slot.to_le_bytes());
    match authority {
        Some(k) => {
            data.push(1);
            data.extend_from_slice(k.as_ref());
        }
        None => {
            data.push(0);
            data.extend_from_slice(&[0; 32]);
        }
    }
    data.extend_from_slice(code);
    svm.set_account(
        program_data_address(program),
        Account {
            lamports: 10_000_000_000,
            data,
            owner: loader,
            executable: false,
            rent_epoch: 0,
        },
    )
    .expect("program data");
}

/// What the loader's `ExtendProgram` does: appends zeros and moves the slot, nothing else.
pub fn extend_program(svm: &mut LiteSVM, program: Pk, slot: u64, extra: usize) {
    let pd = program_data_address(program);
    let mut acct = svm.get_account(&pd).expect("program data");
    acct.data[4..12].copy_from_slice(&slot.to_le_bytes());
    acct.data.extend(std::iter::repeat_n(0u8, extra));
    svm.set_account(pd, acct).expect("extend");
}

/// The admin's off-chain hash: SHA-256 of the executable bytes without trailing zeros.
pub fn code_hash(svm: &LiteSVM, program: Pk) -> [u8; 32] {
    let acct = svm
        .get_account(&program_data_address(program))
        .expect("program data");
    let code = &acct.data[45..];
    let end = code.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
    solana_sdk::hash::hash(&code[..end]).to_bytes()
}

pub fn game_record(game: APk) -> APk {
    pda(&[GAME_SEED, game.as_ref()])
}

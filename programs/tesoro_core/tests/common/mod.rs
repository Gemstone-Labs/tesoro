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

pub mod econ;

//! LiteSVM has no MagicBlock programs. `install` loads a program that accepts any instruction
//! at the magic program's address and at the permission program's, so an instruction that calls
//! them (a commit, a seat change) runs to its end and the Game's own state changes can be
//! asserted. That the calls happen is visible in the transaction logs (`invoke [2]` lines); what
//! the real programs do with them is devnet evidence.

use ephemeral_rollups_sdk::consts::{MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use litesvm::LiteSVM;
use solana_program_runtime::declare_process_instruction;
use solana_sdk::pubkey::Pubkey;

declare_process_instruction!(AcceptAnything, 1, |_invoke_context| { Ok(()) });

fn address(id: ephemeral_rollups_sdk::compat::Pubkey) -> Pubkey {
    Pubkey::new_from_array(id.to_bytes())
}

/// The address the stub is loaded at for the magic program.
pub fn magic_program() -> Pubkey {
    address(MAGIC_PROGRAM_ID)
}

/// The address the stub is loaded at for the permission program.
pub fn permission_program() -> Pubkey {
    address(PERMISSION_PROGRAM_ID)
}

/// Loads the stub at both program addresses.
pub fn install(svm: &mut LiteSVM) {
    for id in [magic_program(), permission_program()] {
        svm.add_builtin(id, AcceptAnything::vm);
        // `add_builtin` leaves the account owned by the BPF loader, but a builtin is owned by the native loader.
        svm.set_account(
            id,
            solana_sdk::account::Account {
                lamports: 1,
                data: b"accept_anything".to_vec(),
                owner: solana_sdk::native_loader::id(),
                executable: true,
                rent_epoch: 0,
            },
        )
        .expect("builtin account");
    }
}

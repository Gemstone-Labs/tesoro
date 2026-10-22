//! Hidden seat data: an ephemeral account (rollup-only, never committable) behind a private
//! permission whose only member is the seat's Player. The delegated table is the sponsor that
//! pays the rent, and gets it back when the seat is closed.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi},
        structs::{EphemeralMembersArgs, Member, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG},
    },
    ephemeral_accounts::EphemeralAccount,
};

/// What a seat's member may read: logs, the message and balances of transactions touching it.
pub const READ_FLAGS: u8 = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;

pub struct SeatAccounts<'a, 'info> {
    /// The delegated table: signs (as a PDA) and pays.
    pub table: &'a AccountInfo<'info>,
    pub seat: &'a AccountInfo<'info>,
    pub permission: &'a AccountInfo<'info>,
    pub vault: &'a AccountInfo<'info>,
    pub magic_program: &'a AccountInfo<'info>,
    pub permission_program: &'a AccountInfo<'info>,
}

/// Creates the seat account with `space` bytes and a private permission for `player`. The caller
/// writes the seat's data afterwards. `table_seeds` and `seat_seeds` include their bumps.
pub fn open_private_seat<'info>(
    a: &SeatAccounts<'_, 'info>,
    table_seeds: &[&[u8]],
    seat_seeds: &[&[u8]],
    space: u32,
    player: Pubkey,
) -> Result<()> {
    EphemeralAccount::new(a.table, a.seat, a.vault)
        .with_signer_seeds(&[table_seeds, seat_seeds])
        .create(space)?;
    CreateEphemeralPermissionCpi {
        payer: a.table.clone(),
        permissioned_account: a.seat.clone(),
        permission: a.permission.clone(),
        vault: a.vault.clone(),
        magic_program: a.magic_program.clone(),
        permission_program: a.permission_program.clone(),
        args: EphemeralMembersArgs {
            is_private: true,
            members: vec![Member {
                flags: READ_FLAGS,
                pubkey: player,
            }],
        },
    }
    .invoke_signed(&[table_seeds, seat_seeds])?;
    Ok(())
}

/// Closes the seat's permission and the seat account; the rent returns to the table.
pub fn close_private_seat<'info>(
    a: &SeatAccounts<'_, 'info>,
    table_seeds: &[&[u8]],
    seat_seeds: &[&[u8]],
) -> Result<()> {
    CloseEphemeralPermissionCpi {
        payer: a.table.clone(),
        permissioned_account: a.seat.clone(),
        permission: a.permission.clone(),
        authority: a.seat.clone(),
        vault: a.vault.clone(),
        magic_program: a.magic_program.clone(),
        permission_program: a.permission_program.clone(),
        authority_is_signer: false,
    }
    .invoke_signed(&[table_seeds, seat_seeds])?;
    EphemeralAccount::new(a.table, a.seat, a.vault)
        .with_signer_seeds(&[table_seeds])
        .close()?;
    Ok(())
}

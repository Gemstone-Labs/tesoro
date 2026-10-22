//! Hidden seat data: an ephemeral account (rollup-only, never committable) behind a private
//! permission whose only member is the seat's Player. The delegated table is the sponsor that
//! pays the rent, and gets it back when the seat is closed.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{
            CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
        },
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
    create_hidden_seat(a, table_seeds, seat_seeds, space, Some(player))
}

fn member_args(player: Option<Pubkey>) -> EphemeralMembersArgs {
    EphemeralMembersArgs {
        is_private: true,
        members: player
            .map(|pubkey| Member {
                flags: READ_FLAGS,
                pubkey,
            })
            .into_iter()
            .collect(),
    }
}

/// Creates a seat that lives as long as its table: the account and a private permission whose
/// only member is `player`, or nobody (`None`). Games with hidden information create their seats
/// once, with no member, and then move them between Players with [`swap_seat_members`]; a seat
/// is never closed while it may hold history that must stay private.
pub fn create_hidden_seat<'info>(
    a: &SeatAccounts<'_, 'info>,
    table_seeds: &[&[u8]],
    seat_seeds: &[&[u8]],
    space: u32,
    player: Option<Pubkey>,
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
        args: member_args(player),
    }
    .invoke_signed(&[table_seeds, seat_seeds])?;
    Ok(())
}

/// Replaces the seat's permission members in place: the seat stays private at every moment. The
/// caller has already zeroed the seat's data when it hands the seat on (zero the data, swap to
/// `None`, then swap to the next Player), so that nothing the old Player could read survives and
/// the permission never lapses. Visibility of a seat's past transactions follows its current
/// members, so a seat's past is never exposed by this call.
pub fn swap_seat_members<'info>(
    a: &SeatAccounts<'_, 'info>,
    table_seeds: &[&[u8]],
    seat_seeds: &[&[u8]],
    player: Option<Pubkey>,
) -> Result<()> {
    UpdateEphemeralPermissionCpi {
        payer: a.table.clone(),
        permissioned_account: a.seat.clone(),
        permission: a.permission.clone(),
        authority: a.seat.clone(),
        vault: a.vault.clone(),
        magic_program: a.magic_program.clone(),
        permission_program: a.permission_program.clone(),
        authority_is_signer: false,
        args: member_args(player),
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

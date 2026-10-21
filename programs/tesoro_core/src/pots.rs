//! Tickets and Pots on chain.
//!
//! One account is both: `["ticket", account, nonce]`. First it is an Entry or Backing Ticket, the
//! staging area of one entry (`ledger::draw::Ticket`); when `open_match` or `join_match` consumes
//! it, the same account is that side's Pot, and `settle` or `refund` empties it line by line. No
//! line is ever copied: the sorted line store lives in the account data, read and written in
//! place (see `crate::storage`).
//!
//! ```text
//! | 8 B discriminator | 160 B ticket head (below) | LineStore body: 128 B header + 144 B per line |
//! ```
//!
//! Head layout (little endian):
//!
//! | offset | field |
//! |---|---|
//! | 0 | version u8 |
//! | 1 | bump u8 |
//! | 2 | kind u8 (0 Entry, 1 Backing) |
//! | 3 | state u8 (0 Open, 1 Cancelling, 2 Closed, 3 Cancelled) |
//! | 4 | storage_reserved u8 |
//! | 8 | account [32] (whose basket the lines come from and return to) |
//! | 40 | game [32] |
//! | 72 | payer [32] (the rent comes back here) |
//! | 104 | nonce u64 |
//! | 112 | target u64 (entry size, or the Backing's amount) |
//! | 120 | expires_at i64 |
//! | 128 | line_cap u32 (lines the storage holds) |
//! | 132 | spill_room u32 (spill slots this Ticket holds in the Account's spill) |
//! | 136 | reserved_left u64 (Backing: reservation not yet staged) |
//! | 144 | sponsored_lamports u64 (rent the sponsor fronted, returned to it first) |

use crate::error::TesoroError;
use crate::ledger::draw::{PotBacking, PotPages, Ticket, TicketKind, TicketState};
use crate::ledger::line_store::{required_len, LineStore};
use crate::storage::DISC;
use anchor_lang::prelude::*;
use std::cell::RefMut;

pub const TICKET_VERSION: u8 = 1;
pub const TICKET_HEAD_LEN: usize = 160;
/// Where the Pot's line store starts in a Ticket account's data.
pub const POT_AT: usize = DISC + TICKET_HEAD_LEN;

/// The zero-copy head: a plain byte array (alignment 1, no padding) that gives Anchor the
/// discriminator and owner check.
#[account(zero_copy)]
pub struct TicketHead {
    pub raw: [u8; TICKET_HEAD_LEN],
}

const H_VERSION: usize = 0;
const H_BUMP: usize = 1;
const H_KIND: usize = 2;
const H_STATE: usize = 3;
const H_STORAGE: usize = 4;
const H_ACCOUNT: usize = 8;
const H_GAME: usize = 40;
const H_PAYER: usize = 72;
const H_NONCE: usize = 104;
const H_TARGET: usize = 112;
const H_EXPIRES: usize = 120;
const H_LINE_CAP: usize = 128;
const H_SPILL_ROOM: usize = 132;
const H_RESERVED_LEFT: usize = 136;
const H_SPONSORED: usize = 144;

/// Bytes of a Ticket account holding `lines` lines.
pub fn ticket_len(lines: usize) -> usize {
    POT_AT + required_len(lines)
}

pub fn ticket_address(account: &Pubkey, nonce: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            crate::state::TICKET_SEED,
            account.as_ref(),
            &nonce.to_le_bytes(),
        ],
        &crate::ID,
    )
}

/// What the head holds beyond the pure `Ticket`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TicketExtra {
    pub bump: u8,
    pub payer: Pubkey,
    pub spill_room: u32,
    pub sponsored_lamports: u64,
}

fn arr<const N: usize>(s: &[u8]) -> [u8; N] {
    let mut a = [0u8; N];
    a.copy_from_slice(s);
    a
}

fn kind_byte(k: TicketKind) -> u8 {
    match k {
        TicketKind::Entry => 0,
        TicketKind::Backing => 1,
    }
}

fn state_byte(s: TicketState) -> u8 {
    match s {
        TicketState::Open => 0,
        TicketState::Cancelling => 1,
        TicketState::Closed => 2,
        TicketState::Cancelled => 3,
    }
}

/// A window on an account's data that starts after the head: what the line store sees. It cannot
/// grow (an account is resized by an instruction that pays the rent first).
pub struct AccountWindow<'b, 'info> {
    data: RefMut<'b, &'info mut [u8]>,
    from: usize,
}

impl<'b, 'info> AccountWindow<'b, 'info> {
    pub fn open(info: &'b AccountInfo<'info>, from: usize) -> Result<Self> {
        Ok(AccountWindow {
            data: info.try_borrow_mut_data()?,
            from,
        })
    }

    pub fn head(&self) -> &[u8] {
        &self.data[DISC..DISC + TICKET_HEAD_LEN]
    }

    pub fn head_mut(&mut self) -> &mut [u8] {
        &mut self.data[DISC..DISC + TICKET_HEAD_LEN]
    }
}

impl AsRef<[u8]> for AccountWindow<'_, '_> {
    fn as_ref(&self) -> &[u8] {
        &self.data[self.from..]
    }
}

impl AsMut<[u8]> for AccountWindow<'_, '_> {
    fn as_mut(&mut self) -> &mut [u8] {
        &mut self.data[self.from..]
    }
}

impl PotBacking for AccountWindow<'_, '_> {
    fn grow_to(&mut self, len: usize) -> bool {
        self.data.len() - self.from >= len
    }
}

pub type OnchainTicket<'b, 'info> = Ticket<AccountWindow<'b, 'info>>;
pub type OnchainPot<'b, 'info> = PotPages<AccountWindow<'b, 'info>>;

/// Everything the head holds.
#[derive(Clone, Copy, Debug)]
pub struct HeadFields {
    pub kind: TicketKind,
    pub state: TicketState,
    pub storage_reserved: bool,
    pub account: [u8; 32],
    pub game: [u8; 32],
    pub nonce: u64,
    pub target: u64,
    pub expires_at: i64,
    pub line_cap: usize,
    pub reserved_left: u64,
}

impl HeadFields {
    pub fn of<T: PotBacking>(t: &Ticket<T>) -> Self {
        HeadFields {
            kind: t.kind,
            state: t.state,
            storage_reserved: t.storage_reserved,
            account: t.account,
            game: t.game,
            nonce: t.nonce,
            target: t.target,
            expires_at: t.expires_at,
            line_cap: t.line_cap,
            reserved_left: t.reserved_left,
        }
    }
}

pub(crate) fn write_head_fields(head: &mut [u8], f: &HeadFields, x: &TicketExtra) {
    head[H_BUMP] = x.bump;
    head[H_KIND] = kind_byte(f.kind);
    head[H_STATE] = state_byte(f.state);
    head[H_STORAGE] = f.storage_reserved as u8;
    head[H_ACCOUNT..H_ACCOUNT + 32].copy_from_slice(&f.account);
    head[H_GAME..H_GAME + 32].copy_from_slice(&f.game);
    head[H_PAYER..H_PAYER + 32].copy_from_slice(x.payer.as_ref());
    head[H_NONCE..H_NONCE + 8].copy_from_slice(&f.nonce.to_le_bytes());
    head[H_TARGET..H_TARGET + 8].copy_from_slice(&f.target.to_le_bytes());
    head[H_EXPIRES..H_EXPIRES + 8].copy_from_slice(&f.expires_at.to_le_bytes());
    head[H_LINE_CAP..H_LINE_CAP + 4].copy_from_slice(&(f.line_cap as u32).to_le_bytes());
    head[H_SPILL_ROOM..H_SPILL_ROOM + 4].copy_from_slice(&x.spill_room.to_le_bytes());
    head[H_RESERVED_LEFT..H_RESERVED_LEFT + 8].copy_from_slice(&f.reserved_left.to_le_bytes());
    head[H_SPONSORED..H_SPONSORED + 8].copy_from_slice(&x.sponsored_lamports.to_le_bytes());
}

/// Writes the head of a freshly created Ticket account: everything but the line store.
pub fn init_head(window: &mut AccountWindow, f: &HeadFields, extra: &TicketExtra) {
    let head = window.head_mut();
    head.fill(0);
    head[H_VERSION] = TICKET_VERSION;
    write_head_fields(head, f, extra);
}

/// Saves the Ticket's state back into its head (the line store was edited in place already).
pub fn save_ticket(t: &mut Ticket<AccountWindow>, x: &TicketExtra) {
    let mut head = [0u8; TICKET_HEAD_LEN];
    head.copy_from_slice(t.pages.bytes_mut().head());
    write_head_fields(&mut head, &HeadFields::of(t), x);
    t.pages.bytes_mut().head_mut().copy_from_slice(&head);
}

/// Loads a Ticket account: owner, discriminator, version and the PDA address are checked, and the
/// pure `Ticket` is rebuilt over the in-place line store.
pub fn load_ticket<'b, 'info>(
    info: &'b AccountInfo<'info>,
) -> Result<(OnchainTicket<'b, 'info>, TicketExtra)> {
    use anchor_lang::Discriminator;
    require_keys_eq!(*info.owner, crate::ID, TesoroError::InvalidAccount);
    require!(info.is_writable, TesoroError::NotWritable);
    {
        let data = info.try_borrow_data()?;
        require!(
            data.len() >= POT_AT + required_len(0) && data[..DISC] == *TicketHead::DISCRIMINATOR,
            TesoroError::InvalidAccount
        );
    }
    let window = AccountWindow::open(info, POT_AT)?;
    let head = window.head();
    require!(
        head[H_VERSION] == TICKET_VERSION,
        TesoroError::InvalidAccount
    );
    let account: [u8; 32] = arr(&head[H_ACCOUNT..H_ACCOUNT + 32]);
    let nonce = u64::from_le_bytes(arr(&head[H_NONCE..H_NONCE + 8]));
    let bump = head[H_BUMP];
    let expected = Pubkey::create_program_address(
        &[
            crate::state::TICKET_SEED,
            &account,
            &nonce.to_le_bytes(),
            &[bump],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(TesoroError::InvalidAccount))?;
    require_keys_eq!(expected, *info.key, TesoroError::InvalidAccount);
    let kind = match head[H_KIND] {
        0 => TicketKind::Entry,
        1 => TicketKind::Backing,
        _ => return err!(TesoroError::InvalidAccount),
    };
    let state = match head[H_STATE] {
        0 => TicketState::Open,
        1 => TicketState::Cancelling,
        2 => TicketState::Closed,
        3 => TicketState::Cancelled,
        _ => return err!(TesoroError::InvalidAccount),
    };
    let extra = TicketExtra {
        bump,
        payer: Pubkey::new_from_array(arr(&head[H_PAYER..H_PAYER + 32])),
        spill_room: u32::from_le_bytes(arr(&head[H_SPILL_ROOM..H_SPILL_ROOM + 4])),
        sponsored_lamports: u64::from_le_bytes(arr(&head[H_SPONSORED..H_SPONSORED + 8])),
    };
    let ticket_fields = (
        arr::<32>(&head[H_GAME..H_GAME + 32]),
        u64::from_le_bytes(arr(&head[H_TARGET..H_TARGET + 8])),
        i64::from_le_bytes(arr(&head[H_EXPIRES..H_EXPIRES + 8])),
        head[H_STORAGE] != 0,
        u32::from_le_bytes(arr(&head[H_LINE_CAP..H_LINE_CAP + 4])) as usize,
        u64::from_le_bytes(arr(&head[H_RESERVED_LEFT..H_RESERVED_LEFT + 8])),
    );
    let pages = PotPages::open(window).map_err(|_| error!(TesoroError::InvalidAccount))?;
    let (game, target, expires_at, storage_reserved, line_cap, reserved_left) = ticket_fields;
    Ok((
        Ticket {
            account,
            game,
            nonce,
            kind,
            state,
            target,
            expires_at,
            storage_reserved,
            line_cap,
            reserved_left,
            pages,
        },
        extra,
    ))
}

/// Opens the Pot of a Ticket account for settlement: only the line store, checked as a Ticket
/// that was consumed (state Closed) by the Match that names it.
pub fn load_pot<'b, 'info>(
    info: &'b AccountInfo<'info>,
) -> Result<(OnchainPot<'b, 'info>, TicketExtra)> {
    let (t, x) = load_ticket(info)?;
    require!(t.state == TicketState::Closed, TesoroError::InvalidAccount);
    Ok((t.pages, x))
}

/// An empty Pot store inside a fresh account, for a Ticket to stage into.
pub fn init_pot<'b, 'info>(
    info: &'b AccountInfo<'info>,
    account: &Pubkey,
    bump: u8,
) -> Result<OnchainPot<'b, 'info>> {
    let window = AccountWindow::open(info, POT_AT)?;
    PotPages::init(window, account.to_bytes(), bump)
        .map_err(|_| error!(TesoroError::InvalidAccount))
}

/// Total Gemas in a Ticket account's store, without loading it as a Ticket.
pub fn pot_total(info: &AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    let store = LineStore::new(&data[POT_AT..]).map_err(|_| error!(TesoroError::InvalidAccount))?;
    Ok(store
        .own_total()
        .saturating_add(store.won_total())
        .saturating_add(store.fee_total()))
}

/// Creates the account of a Pot for a direct draw: funded, allocated and assigned (so lamports
/// someone pre-sent to the address cannot block it), discriminator written. The caller formats the
/// line store and the head.
pub fn create_pot_account<'info>(
    pot: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    (funder, nonce, bump): (&Pubkey, u64, u8),
    lines: usize,
) -> Result<()> {
    use anchor_lang::system_program;
    use anchor_lang::Discriminator;
    let len = ticket_len(lines);
    let need = Rent::get()?
        .minimum_balance(len)
        .saturating_sub(pot.lamports());
    if need > 0 {
        system_program::transfer(
            CpiContext::new(
                system.clone(),
                system_program::Transfer {
                    from: payer.clone(),
                    to: pot.clone(),
                },
            ),
            need,
        )?;
    }
    let nonce_le = nonce.to_le_bytes();
    let seeds: &[&[&[u8]]] = &[&[
        crate::state::TICKET_SEED,
        funder.as_ref(),
        &nonce_le,
        &[bump],
    ]];
    system_program::allocate(
        CpiContext::new_with_signer(
            system.clone(),
            system_program::Allocate {
                account_to_allocate: pot.clone(),
            },
            seeds,
        ),
        len as u64,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(
            system.clone(),
            system_program::Assign {
                account_to_assign: pot.clone(),
            },
            seeds,
        ),
        &crate::ID,
    )?;
    let mut data = pot.try_borrow_mut_data()?;
    data[..DISC].copy_from_slice(TicketHead::DISCRIMINATOR);
    Ok(())
}

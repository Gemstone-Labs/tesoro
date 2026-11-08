//! Ticket 55: Positions gained `stake_rate_high` (235 -> 243 bytes). The admin rewrites every
//! 235-byte Position in place right after the upgrade, in one paused-keeper sweep (operator script
//! `keeper/scripts/migrate-positions-55.ts`). The new field starts at the opening rate, so a migrated Lock
//! is priced exactly as it was: nothing counts as priced that was not.

use crate::error::TesoroError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_lang::{system_program, AccountSerialize, Discriminator};

#[derive(Accounts)]
pub struct MigratePosition<'info> {
    /// Pays the rent of the 8 new bytes.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: a Position of this program, read from its raw bytes (owner, length and
    /// discriminator checked in the handler): a 235-byte one is rewritten, a 243-byte one is
    /// left alone.
    #[account(mut, owner = crate::ID @ TesoroError::InvalidAccount)]
    pub position: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn migrate_position(ctx: Context<MigratePosition>) -> Result<()> {
    let info = ctx.accounts.position.to_account_info();
    let migrated = {
        let data = info.try_borrow_data()?;
        require!(
            data.len() >= 8 && data[..8] == *PositionState::DISCRIMINATOR,
            TesoroError::InvalidAccount
        );
        match data.len() {
            PositionState::SPACE => return Ok(()),
            PositionStateV1::SPACE => PositionStateV1::decode(&data)?.upgrade(),
            _ => return err!(TesoroError::InvalidAccount),
        }
    };
    let rent = Rent::get()?
        .minimum_balance(PositionState::SPACE)
        .saturating_sub(info.lamports());
    if rent > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: info.clone(),
                },
            ),
            rent,
        )?;
    }
    info.resize(PositionState::SPACE)?;
    let mut data = info.try_borrow_mut_data()?;
    data.fill(0);
    let mut out: &mut [u8] = &mut data;
    migrated.try_serialize(&mut out)?;
    Ok(())
}

/// Counters gained `next_ticket` (25 -> 33 bytes). Anyone can grow an old counters account
/// (`grow_counters`, the payer pays the 8 bytes of rent), and a transaction that needs one
/// puts the grow in front of the instruction that reads it; the admin sweep (`migrate_counters`,
/// `keeper/scripts/migrate-counters.ts`) does the same for the ones nobody has touched. The new
/// field starts at `AccountCounters::LEGACY_TICKET_BASE`, above every nonce an old client picked,
/// so no old Ticket or Pot address can be made again (a start at zero would let one come back).
fn grow_counters_account<'info>(
    info: &AccountInfo<'info>,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    {
        let data = info.try_borrow_data()?;
        require!(
            data.len() >= 8 && data[..8] == *AccountCounters::DISCRIMINATOR,
            TesoroError::InvalidAccount
        );
        match data.len() {
            AccountCounters::SPACE => return Ok(()),
            AccountCounters::SPACE_V1 => {}
            _ => return err!(TesoroError::InvalidAccount),
        }
    }
    let rent = Rent::get()?
        .minimum_balance(AccountCounters::SPACE)
        .saturating_sub(info.lamports());
    if rent > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program.to_account_info(),
                system_program::Transfer {
                    from: payer.to_account_info(),
                    to: info.clone(),
                },
            ),
            rent,
        )?;
    }
    info.resize(AccountCounters::SPACE)?;
    let mut data = info.try_borrow_mut_data()?;
    data[AccountCounters::SPACE_V1..]
        .copy_from_slice(&AccountCounters::LEGACY_TICKET_BASE.to_le_bytes());
    Ok(())
}

/// Grows any old counters account. Nothing is read from the caller but the rent: the account
/// must be owned by this program and carry the `AccountCounters` discriminator at 25 bytes, which
/// only this program ever wrote, so no address check is needed and no value but the appended
/// field can change. A 33-byte account is left alone.
#[derive(Accounts)]
pub struct GrowCounters<'info> {
    /// Pays the rent of the 8 new bytes.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: owner, discriminator and length are checked in the handler.
    #[account(mut, owner = crate::ID @ TesoroError::InvalidAccount)]
    pub counters: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn grow_counters(ctx: Context<GrowCounters>) -> Result<()> {
    grow_counters_account(
        &ctx.accounts.counters.to_account_info(),
        &ctx.accounts.payer,
        &ctx.accounts.system_program,
    )
}

/// The admin sweep: the same growth, for the one counters account of `account` (its address is
/// checked), so a script can list the Accounts and grow what is still short.
#[derive(Accounts)]
pub struct MigrateCounters<'info> {
    /// Pays the rent of the 8 new bytes.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: the Account whose counters these are; only its key is used, for the address check.
    pub account: UncheckedAccount<'info>,
    /// CHECK: counters of this program, read from raw bytes (owner, address, length and
    /// discriminator checked in the handler): a 25-byte one is grown, a 33-byte one is left alone.
    #[account(mut, owner = crate::ID @ TesoroError::InvalidAccount)]
    pub counters: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn migrate_counters(ctx: Context<MigrateCounters>) -> Result<()> {
    let info = ctx.accounts.counters.to_account_info();
    {
        let data = info.try_borrow_data()?;
        require!(data.len() >= 9, TesoroError::InvalidAccount);
        let expected = Pubkey::create_program_address(
            &[
                COUNTERS_SEED,
                ctx.accounts.account.key().as_ref(),
                &[data[8]],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(TesoroError::InvalidAccount))?;
        require_keys_eq!(expected, info.key(), TesoroError::InvalidAccount);
    }
    grow_counters_account(&info, &ctx.accounts.admin, &ctx.accounts.system_program)
}

/// Railcar tickets 17 and 18: Offers gained `counted_in` and `ticket_nonce` (174 -> 191 bytes).
/// Anyone grows an old Offer (the payer pays the 17 bytes of rent); the sweep is
/// `keeper/scripts/grow-offers.ts`. The new fields are zero: the period an old Offer counted in
/// was never stored, so nothing is given back for it, and it names no Ticket. Only this program
/// wrote an `OfferState`, so owner, discriminator and length are the whole check; a 191-byte
/// Offer is left alone.
#[derive(Accounts)]
pub struct GrowOffer<'info> {
    /// Pays the rent of the 17 new bytes.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: owner, discriminator and length are checked in the handler.
    #[account(mut, owner = crate::ID @ TesoroError::InvalidAccount)]
    pub offer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn grow_offer(ctx: Context<GrowOffer>) -> Result<()> {
    let info = ctx.accounts.offer.to_account_info();
    {
        let data = info.try_borrow_data()?;
        require!(
            data.len() >= 8 && data[..8] == *OfferState::DISCRIMINATOR,
            TesoroError::InvalidAccount
        );
        match data.len() {
            OfferState::SPACE => return Ok(()),
            OfferState::SPACE_V1 => {}
            _ => return err!(TesoroError::InvalidAccount),
        }
    }
    let rent = Rent::get()?
        .minimum_balance(OfferState::SPACE)
        .saturating_sub(info.lamports());
    if rent > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: info.clone(),
                },
            ),
            rent,
        )?;
    }
    info.resize(OfferState::SPACE)?;
    info.try_borrow_mut_data()?[OfferState::SPACE_V1..].fill(0);
    Ok(())
}

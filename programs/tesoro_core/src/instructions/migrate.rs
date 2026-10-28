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

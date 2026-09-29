use crate::error::{core_err, TesoroError};
use crate::ledger::FeeTerms;
use crate::state::*;
use anchor_lang::prelude::*;

fn validate_fees(platform_bps: u16, studio_bps: u16) -> Result<()> {
    FeeTerms {
        platform_bps,
        studio_bps,
        platform_recipient: [0; 32],
        studio_recipient: [0; 32],
    }
    .validate()
    .map_err(core_err)
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = Config::SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [ACCOUNT_SEED, platform_recipient.authority.as_ref()],
        bump = platform_recipient.bump
    )]
    pub platform_recipient: Account<'info, TesoroAccount>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn initialize_config(
    ctx: Context<InitializeConfig>,
    oracle_authority: Pubkey,
    platform_bps: u16,
) -> Result<()> {
    validate_fees(platform_bps, 0)?;
    let config = &mut ctx.accounts.config;
    config.bump = ctx.bumps.config;
    config.admin = ctx.accounts.admin.key();
    config.oracle_authority = oracle_authority;
    config.platform_bps = platform_bps;
    config.platform_recipient = ctx.accounts.platform_recipient.key();
    config.games = Vec::new();
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [ACCOUNT_SEED, platform_recipient.authority.as_ref()],
        bump = platform_recipient.bump
    )]
    pub platform_recipient: Account<'info, TesoroAccount>,
}

/// Replaces the oracle authority and the Platform Fee terms. Matches already open keep the
/// fee terms they snapshotted.
pub(crate) fn update_config(
    ctx: Context<UpdateConfig>,
    oracle_authority: Pubkey,
    platform_bps: u16,
) -> Result<()> {
    let max_studio = ctx
        .accounts
        .config
        .games
        .iter()
        .map(|g| g.studio_bps)
        .max()
        .unwrap_or(0);
    validate_fees(platform_bps, max_studio)?;
    let config = &mut ctx.accounts.config;
    config.oracle_authority = oracle_authority;
    config.platform_bps = platform_bps;
    config.platform_recipient = ctx.accounts.platform_recipient.key();
    Ok(())
}

#[derive(Accounts)]
pub struct RegisterGame<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [ACCOUNT_SEED, studio_recipient.authority.as_ref()],
        bump = studio_recipient.bump
    )]
    pub studio_recipient: Account<'info, TesoroAccount>,
}

/// Registers a Game or replaces its entry.
pub(crate) fn register_game(
    ctx: Context<RegisterGame>,
    game: Pubkey,
    authority: Pubkey,
    studio_bps: u16,
) -> Result<()> {
    let platform_bps = ctx.accounts.config.platform_bps;
    validate_fees(platform_bps, studio_bps)?;
    let entry = GameEntry {
        game,
        authority,
        studio_bps,
        studio_recipient: ctx.accounts.studio_recipient.key(),
    };
    let games = &mut ctx.accounts.config.games;
    match games.iter_mut().find(|g| g.game == game) {
        Some(existing) => *existing = entry,
        None => {
            require!(games.len() < MAX_GAMES, TesoroError::GameRegistryFull);
            games.push(entry);
        }
    }
    Ok(())
}

pub(crate) fn remove_game(ctx: Context<RemoveGame>, game: Pubkey) -> Result<()> {
    ctx.accounts.config.games.retain(|g| g.game != game);
    Ok(())
}

#[derive(Accounts)]
pub struct RemoveGame<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
}

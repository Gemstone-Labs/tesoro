use crate::error::{core_err, TesoroError};
use crate::ledger::{FeeTerms, LeaderboardTerms};
use crate::state::*;
use anchor_lang::prelude::*;

fn validate_fees(platform_bps: u16, studio_bps: u16, leaderboard_bps: u16) -> Result<()> {
    let fees = FeeTerms {
        platform_bps,
        studio_bps,
        platform_recipient: [0; 32],
        studio_recipient: [0; 32],
    };
    fees.validate().map_err(core_err)?;
    LeaderboardTerms {
        bps: leaderboard_bps,
        recipient: [0; 32],
    }
    .validate(&fees)
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
    validate_fees(platform_bps, 0, 0)?;
    let config = &mut ctx.accounts.config;
    config.bump = ctx.bumps.config;
    config.admin = ctx.accounts.admin.key();
    config.oracle_authority = oracle_authority;
    config.platform_bps = platform_bps;
    config.platform_recipient = ctx.accounts.platform_recipient.key();
    config.games = Vec::new();
    config.leaderboard_bps = 0;
    config.pool_account = Pubkey::default();
    config.leaderboard_since = 0;
    config.entry_sizes = [0; crate::ledger::MAX_ENTRY_SIZES];
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
    validate_fees(
        platform_bps,
        max_studio,
        ctx.accounts.config.leaderboard_bps,
    )?;
    let config = &mut ctx.accounts.config;
    config.oracle_authority = oracle_authority;
    config.platform_bps = platform_bps;
    config.platform_recipient = ctx.accounts.platform_recipient.key();
    Ok(())
}

/// Rotates `Config.admin`. Gated on the program's upgrade authority rather than the current
/// admin, so a compromised admin key cannot call it (or block its own replacement).
#[derive(Accounts)]
pub struct SetAdmin<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ TesoroError::Unauthorized
    )]
    pub program: Program<'info, crate::program::TesoroCore>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key())
        @ TesoroError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
}

pub(crate) fn set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.admin = new_admin;
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
    let leaderboard_bps = ctx.accounts.config.leaderboard_bps;
    validate_fees(platform_bps, studio_bps, leaderboard_bps)?;
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

/// Sets up the Leaderboard on a Config that predates it, or changes its fee: extends the Config
/// account, creates the Leaderboard Pool Account (owned by the `["leaderboard"]` address, which
/// nobody can sign for, so only this program ever moves its Gemas) and sets the fee. Safe to
/// call again to change `leaderboard_bps`.
#[derive(Accounts)]
pub struct InitLeaderboard<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized,
        realloc = Config::SPACE,
        realloc::payer = admin,
        realloc::zero = true
    )]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: address only; the PDA that owns the pool Account.
    #[account(seeds = [LEADERBOARD_SEED], bump)]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        space = TesoroAccount::SPACE,
        seeds = [ACCOUNT_SEED, pool_authority.key().as_ref()],
        bump
    )]
    pub pool_account: Account<'info, TesoroAccount>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn init_leaderboard(ctx: Context<InitLeaderboard>, leaderboard_bps: u16) -> Result<()> {
    let pool = &mut ctx.accounts.pool_account;
    if pool.authority == Pubkey::default() {
        pool.bump = ctx.bumps.pool_account;
        pool.authority = ctx.accounts.pool_authority.key();
        pool.evm_address = [0; 20];
        pool.inner = Default::default();
    }
    let max_studio = ctx
        .accounts
        .config
        .games
        .iter()
        .map(|g| g.studio_bps)
        .max()
        .unwrap_or(0);
    validate_fees(
        ctx.accounts.config.platform_bps,
        max_studio,
        leaderboard_bps,
    )?;
    let pool_key = ctx.accounts.pool_account.key();
    let config = &mut ctx.accounts.config;
    config.leaderboard_bps = leaderboard_bps;
    config.pool_account = pool_key;
    if config.leaderboard_since == 0 {
        config.leaderboard_since = crate::util::now()?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct SetInviteGate<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = InviteGate::SPACE,
        seeds = [INVITE_GATE_SEED],
        bump
    )]
    pub invite_gate: Account<'info, InviteGate>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_invite_gate(
    ctx: Context<SetInviteGate>,
    required: bool,
    key: Pubkey,
) -> Result<()> {
    require!(
        !required || key != Pubkey::default(),
        TesoroError::InviteKeyMissing
    );
    let gate = &mut ctx.accounts.invite_gate;
    gate.bump = ctx.bumps.invite_gate;
    gate.required = required;
    gate.key = key;
    Ok(())
}

/// Sets the entry sizes (admin). Extends a Config that predates the field. Matches, Requests and
/// Offers already open keep the entry they were made with.
#[derive(Accounts)]
pub struct SetEntrySizes<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized,
        realloc = Config::SPACE,
        realloc::payer = admin,
        realloc::zero = true
    )]
    pub config: Box<Account<'info, Config>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_entry_sizes(ctx: Context<SetEntrySizes>, sizes: Vec<u64>) -> Result<()> {
    crate::ledger::validate_entry_sizes(&sizes).map_err(core_err)?;
    let mut padded = [0u64; crate::ledger::MAX_ENTRY_SIZES];
    padded[..sizes.len()].copy_from_slice(&sizes);
    ctx.accounts.config.entry_sizes = padded;
    Ok(())
}

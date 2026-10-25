//! The Game registry: one `["game", program_id]` record per Game (docs/adr/0013).
//!
//! Registering, and every later change, must be signed by whoever controls the Game program
//! (`registry::required_signer`). Changes wait `GAME_CHANGE_DELAY_SECS`. The admin never edits a
//! record: it only lists a Game (`list_game`), which gates Points, backed Matches and sponsored
//! transactions.

use crate::error::TesoroError;
use crate::instructions::admin::validate_fees;
use crate::registry::{self, Deploy, ProofError, View};
use crate::state::*;
use crate::util::now;
use anchor_lang::prelude::*;

/// Reads the program's deployment from the two loader accounts.
/// Runs `f` on views of the two loader accounts.
fn with_views<T>(
    game: &AccountInfo,
    program_data: &AccountInfo,
    f: impl FnOnce(&View, &View) -> std::result::Result<T, ProofError>,
) -> std::result::Result<T, ProofError> {
    let game_data = game
        .try_borrow_data()
        .map_err(|_| ProofError::NotAProgram)?;
    let pd_data = program_data
        .try_borrow_data()
        .map_err(|_| ProofError::BadProgramData)?;
    let program = View {
        key: *game.key,
        owner: *game.owner,
        executable: game.executable,
        data: &game_data,
    };
    let pd = View {
        key: *program_data.key,
        owner: *program_data.owner,
        executable: program_data.executable,
        data: &pd_data,
    };
    f(&program, &pd)
}

pub(crate) fn read_deploy(
    game: &AccountInfo,
    program_data: &AccountInfo,
) -> std::result::Result<Deploy, ProofError> {
    with_views(game, program_data, |program, pd| {
        registry::read_deploy(game.key, program, Some(pd))
    })
}

/// The loader state and the hash of the executable, read together.
fn read_build(game: &AccountInfo, program_data: &AccountInfo) -> Result<(Deploy, [u8; 32])> {
    with_views(game, program_data, |program, pd| {
        let deploy = registry::read_deploy(game.key, program, Some(pd))?;
        let hash = registry::code_hash(program, pd, &deploy)?;
        Ok((deploy, hash))
    })
    .map_err(|e| match e {
        ProofError::TooLarge => error!(TesoroError::ProgramTooLarge),
        _ => error!(TesoroError::GameProofInvalid),
    })
}

/// The signer must be whoever controls the program right now.
fn require_control(game: &AccountInfo, program_data: &AccountInfo, control: &Pubkey) -> Result<()> {
    let deploy =
        read_deploy(game, program_data).map_err(|_| error!(TesoroError::GameProofInvalid))?;
    require_keys_eq!(
        registry::required_signer(game.key, &deploy),
        *control,
        TesoroError::NotGameControl
    );
    Ok(())
}

fn check_terms(
    config: &Config,
    studio_bps: u16,
    recipient: &Account<TesoroAccount>,
    settle_authority: &Pubkey,
) -> Result<()> {
    require!(studio_bps <= MAX_STUDIO_BPS, TesoroError::StudioFeeTooHigh);
    require!(
        *settle_authority != Pubkey::default(),
        TesoroError::Unauthorized
    );
    validate_fees(config.platform_bps, studio_bps, config.leaderboard_bps)?;
    let reserved = |seed: &[u8]| Pubkey::find_program_address(&[seed], &crate::ID).0;
    require!(
        recipient.authority != reserved(TREASURY_SEED)
            && recipient.authority != reserved(LEADERBOARD_SEED)
            && recipient.key() != config.platform_recipient
            && recipient.key() != config.pool_account,
        TesoroError::StudioRecipientReserved
    );
    Ok(())
}

#[derive(Accounts)]
pub struct RegisterGame<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The upgrade authority, or the Game program's `["tesoro-register"]` PDA once it is immutable.
    pub control: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: read by `registry::read_deploy`: loader owner, executable flag and state tag.
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData; its address is derived and its state tag checked.
    pub program_data: UncheckedAccount<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, studio_recipient.authority.as_ref()],
        bump = studio_recipient.bump
    )]
    pub studio_recipient: Account<'info, TesoroAccount>,
    #[account(
        init,
        payer = payer,
        space = GameRecord::SPACE,
        seeds = [GAME_SEED, game_program.key().as_ref()],
        bump
    )]
    pub game_record: Account<'info, GameRecord>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn register_game(
    ctx: Context<RegisterGame>,
    settle_authority: Pubkey,
    studio_bps: u16,
) -> Result<()> {
    let a = &ctx.accounts;
    require_control(
        &a.game_program.to_account_info(),
        &a.program_data.to_account_info(),
        &a.control.key(),
    )?;
    check_terms(
        &a.config,
        studio_bps,
        &a.studio_recipient,
        &settle_authority,
    )?;
    let game = a.game_program.key();
    let recipient = a.studio_recipient.key();
    let r = &mut ctx.accounts.game_record;
    r.bump = ctx.bumps.game_record;
    r.game = game;
    r.settle_authority = settle_authority;
    r.studio_bps = studio_bps;
    r.studio_recipient = recipient;
    r.pending_at = 0;
    r.pending_by = Pubkey::default();
    r.pending_settle_authority = Pubkey::default();
    r.pending_studio_bps = 0;
    r.pending_studio_recipient = Pubkey::default();
    r.listed_until = 0;
    r.approved_slot = 0;
    r.approved_hash = [0; 32];
    r.listing_epoch = 0;
    Ok(())
}

#[derive(Accounts)]
pub struct ChangeGame<'info> {
    pub control: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: see `RegisterGame`.
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: see `RegisterGame`.
    pub program_data: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [GAME_SEED, game_program.key().as_ref()],
        bump = game_record.bump
    )]
    pub game_record: Account<'info, GameRecord>,
    #[account(
        seeds = [ACCOUNT_SEED, studio_recipient.authority.as_ref()],
        bump = studio_recipient.bump
    )]
    pub studio_recipient: Account<'info, TesoroAccount>,
}

/// Starts the wait. A second proposal replaces the first and restarts the wait.
pub(crate) fn propose_game_change(
    ctx: Context<ChangeGame>,
    settle_authority: Pubkey,
    studio_bps: u16,
) -> Result<()> {
    let a = &ctx.accounts;
    require_control(
        &a.game_program.to_account_info(),
        &a.program_data.to_account_info(),
        &a.control.key(),
    )?;
    check_terms(
        &a.config,
        studio_bps,
        &a.studio_recipient,
        &settle_authority,
    )?;
    let by = a.control.key();
    let recipient = a.studio_recipient.key();
    let at = now()?;
    let r = &mut ctx.accounts.game_record;
    r.pending_at = at;
    r.pending_by = by;
    r.pending_settle_authority = settle_authority;
    r.pending_studio_bps = studio_bps;
    r.pending_studio_recipient = recipient;
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyGameChange<'info> {
    pub control: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: see `RegisterGame`.
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: see `RegisterGame`.
    pub program_data: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [GAME_SEED, game_program.key().as_ref()],
        bump = game_record.bump
    )]
    pub game_record: Account<'info, GameRecord>,
    #[account(
        seeds = [ACCOUNT_SEED, studio_recipient.authority.as_ref()],
        bump = studio_recipient.bump
    )]
    pub studio_recipient: Account<'info, TesoroAccount>,
}

/// Applies the waiting change. The key that proposed it must still be the one in control: if the
/// upgrade authority moved during the wait, the new holder has to propose again.
pub(crate) fn apply_game_change(ctx: Context<ApplyGameChange>) -> Result<()> {
    let a = &ctx.accounts;
    let r = &a.game_record;
    require!(r.pending_at != 0, TesoroError::NoPendingChange);
    require_keys_eq!(
        a.studio_recipient.key(),
        r.pending_studio_recipient,
        TesoroError::InvalidAccount
    );
    require!(
        now()? >= r.pending_at.saturating_add(GAME_CHANGE_DELAY_SECS),
        TesoroError::ChangeDelayNotElapsed
    );
    require_control(
        &a.game_program.to_account_info(),
        &a.program_data.to_account_info(),
        &a.control.key(),
    )?;
    require_keys_eq!(a.control.key(), r.pending_by, TesoroError::NotGameControl);
    check_terms(
        &a.config,
        r.pending_studio_bps,
        &a.studio_recipient,
        &r.pending_settle_authority,
    )?;
    let r = &mut ctx.accounts.game_record;
    r.settle_authority = r.pending_settle_authority;
    r.studio_bps = r.pending_studio_bps;
    r.studio_recipient = r.pending_studio_recipient;
    r.pending_at = 0;
    r.pending_by = Pubkey::default();
    r.pending_settle_authority = Pubkey::default();
    r.pending_studio_bps = 0;
    r.pending_studio_recipient = Pubkey::default();
    Ok(())
}

#[derive(Accounts)]
pub struct CancelGameChange<'info> {
    pub control: Signer<'info>,
    /// CHECK: see `RegisterGame`.
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: see `RegisterGame`.
    pub program_data: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [GAME_SEED, game_program.key().as_ref()],
        bump = game_record.bump
    )]
    pub game_record: Account<'info, GameRecord>,
}

pub(crate) fn cancel_game_change(ctx: Context<CancelGameChange>) -> Result<()> {
    let a = &ctx.accounts;
    require_control(
        &a.game_program.to_account_info(),
        &a.program_data.to_account_info(),
        &a.control.key(),
    )?;
    let r = &mut ctx.accounts.game_record;
    r.pending_at = 0;
    r.pending_by = Pubkey::default();
    r.pending_settle_authority = Pubkey::default();
    r.pending_studio_bps = 0;
    r.pending_studio_recipient = Pubkey::default();
    Ok(())
}

#[derive(Accounts)]
pub struct ListGame<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [GAME_SEED, game_record.game.as_ref()],
        bump = game_record.bump
    )]
    pub game_record: Account<'info, GameRecord>,
    /// CHECK: the Game program; its loader state is read.
    #[account(address = game_record.game)]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData; its address is derived and its state tag checked.
    pub program_data: UncheckedAccount<'info>,
}

/// Admin: lists a Game until `listed_until` for the build it hashed off-chain, or unlists it
/// (`listed_until` 0, the program accounts are then not read). The program must hash to
/// `approved_hash` right now; its current deploy slot becomes the approved slot.
pub(crate) fn list_game(
    ctx: Context<ListGame>,
    listed_until: i64,
    approved_hash: [u8; 32],
) -> Result<()> {
    if listed_until <= 0 {
        let r = &mut ctx.accounts.game_record;
        r.listed_until = 0;
        return Ok(());
    }
    let (deploy, hash) = read_build(
        &ctx.accounts.game_program.to_account_info(),
        &ctx.accounts.program_data.to_account_info(),
    )?;
    require!(hash == approved_hash, TesoroError::CodeHashMismatch);
    let r = &mut ctx.accounts.game_record;
    if r.approved_hash != approved_hash {
        r.listing_epoch = r
            .listing_epoch
            .checked_add(1)
            .ok_or(TesoroError::InvalidAccount)?;
    }
    r.listed_until = listed_until;
    r.approved_slot = deploy.slot;
    r.approved_hash = approved_hash;
    Ok(())
}

#[derive(Accounts)]
pub struct RefreshListing<'info> {
    #[account(
        mut,
        seeds = [GAME_SEED, game_record.game.as_ref()],
        bump = game_record.bump
    )]
    pub game_record: Account<'info, GameRecord>,
    /// CHECK: the Game program; its loader state is read.
    #[account(address = game_record.game)]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData; its address is derived and its state tag checked.
    pub program_data: UncheckedAccount<'info>,
}

/// Anyone: after the deploy slot moved without the code changing (the loader's `ExtendProgram`
/// moves it and appends zeros), hashes the program again and, if it is the approved build, moves
/// the approved slot forward. A different build stays unlisted until the admin approves it.
pub(crate) fn refresh_listing(ctx: Context<RefreshListing>) -> Result<()> {
    let r = &ctx.accounts.game_record;
    require!(r.listed_until > now()?, TesoroError::NotListed);
    let (deploy, hash) = read_build(
        &ctx.accounts.game_program.to_account_info(),
        &ctx.accounts.program_data.to_account_info(),
    )?;
    require!(deploy.slot != r.approved_slot, TesoroError::ListingCurrent);
    require!(hash == r.approved_hash, TesoroError::CodeChanged);
    ctx.accounts.game_record.approved_slot = deploy.slot;
    Ok(())
}

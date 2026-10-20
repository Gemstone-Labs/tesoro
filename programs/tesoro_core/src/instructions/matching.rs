use crate::error::{core_err, TesoroError};
use crate::ledger::{self, MatchStatus, Outcome, Side};
use crate::state::*;
use crate::util::*;
use anchor_lang::prelude::*;

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize)]
pub enum MatchResult {
    /// The entrant who opened the Match wins.
    Opener,
    /// The entrant who joined wins.
    Joiner,
    Draw,
}

/// Whether the Game counts as listed right now, and its deploy slot (zero when unreadable). A
/// program that cannot be read (closed, wrong accounts) is unlisted, never an error: Matches on it
/// still open, they just earn no Points and cannot be backed.
fn listing(
    record: &GameRecord,
    game_program: &AccountInfo,
    program_data: &AccountInfo,
) -> Result<(bool, u64)> {
    let slot = crate::instructions::registry::read_deploy(game_program, program_data)
        .ok()
        .map(|d| d.slot);
    Ok((record.is_listed(now()?, slot), slot.unwrap_or(0)))
}

/// Counts a Match started by this opener-to-joiner pair.
fn record_pair(pair: &mut Account<PairState>, bump: u8, now: i64) -> Result<()> {
    if pair.window_start == 0 && pair.count == 0 {
        pair.bump = bump;
    }
    require!(pair.record(now), TesoroError::PairLimitReached);
    Ok(())
}

/// `remaining_accounts` are the entrant's Holdings, own-sourced first, then won, each ascending
/// by Source address (see docs/tesoro-core.md).
#[derive(Accounts)]
#[instruction(match_id: u64, game: Pubkey)]
pub struct OpenMatch<'info> {
    #[account(mut)]
    pub player_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [GAME_SEED, game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: the Game program; the loader state is read by `listing`.
    #[account(address = game)]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData; `listing` derives and checks it.
    pub program_data: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, player_authority.key().as_ref()],
        bump = player_account.bump
    )]
    pub player_account: Account<'info, TesoroAccount>,
    /// CHECK: the Player Account's Protections address; empty when none is set (see `count_entry`).
    #[account(
        mut,
        seeds = [PROTECTIONS_SEED, player_account.key().as_ref()],
        bump
    )]
    pub protections: UncheckedAccount<'info>,
    #[account(
        init,
        payer = player_authority,
        space = MatchState::SPACE,
        seeds = [MATCH_SEED, &match_id.to_le_bytes()],
        bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn open_match<'info>(
    ctx: Context<'_, '_, 'info, 'info, OpenMatch<'info>>,
    match_id: u64,
    game: Pubkey,
    entry: u64,
) -> Result<()> {
    let (fees, entries) = {
        let config = &ctx.accounts.config;
        (ctx.accounts.game_record.fee_terms(config), config.entries())
    };
    let (listed, deploy_slot) = listing(
        &ctx.accounts.game_record,
        &ctx.accounts.game_program.to_account_info(),
        &ctx.accounts.program_data.to_account_info(),
    )?;
    let player = ctx.accounts.player_account.key();
    count_entry(&ctx.accounts.protections.to_account_info(), entry)?;
    let mut holdings = load_holdings(&player, ctx.remaining_accounts)?;
    let acct = &mut ctx.accounts.player_account.inner;
    let lines = with_holdings(&mut holdings, |hs| ledger::draw_entry(acct, hs, entry))?;
    let side = Side {
        player: player.to_bytes(),
        funder: player.to_bytes(),
        share_bps: 0,
        lines,
    };
    let m = ledger::Match::open(game.to_bytes(), entry, &entries, fees, side, now()?)
        .map_err(core_err)?;
    let state = &mut ctx.accounts.match_state;
    state.bump = ctx.bumps.match_state;
    state.id = match_id;
    state.inner = m;
    state.listed = listed;
    state.deploy_slot = deploy_slot;
    Ok(())
}

#[derive(Accounts)]
pub struct JoinMatch<'info> {
    #[account(mut)]
    pub player_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, player_authority.key().as_ref()],
        bump = player_account.bump
    )]
    pub player_account: Account<'info, TesoroAccount>,
    /// CHECK: the Player Account's Protections address; empty when none is set (see `count_entry`).
    #[account(
        mut,
        seeds = [PROTECTIONS_SEED, player_account.key().as_ref()],
        bump
    )]
    pub protections: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [MATCH_SEED, &match_state.id.to_le_bytes()],
        bump = match_state.bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
    /// CHECK: the opener's Protections address; nobody joins a Match whose opener is away.
    #[account(
        seeds = [PROTECTIONS_SEED, match_state.inner.a.player.as_ref()],
        bump
    )]
    pub opener_protections: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = player_authority,
        space = PairState::SPACE,
        seeds = [PAIR_SEED, match_state.inner.a.player.as_ref(), player_account.key().as_ref()],
        bump
    )]
    pub pair: Account<'info, PairState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn join_match<'info>(
    ctx: Context<'_, '_, 'info, 'info, JoinMatch<'info>>,
) -> Result<()> {
    record_pair(&mut ctx.accounts.pair, ctx.bumps.pair, now()?)?;
    let player = ctx.accounts.player_account.key();
    let entry = ctx.accounts.match_state.inner.entry;
    require_can_play(&ctx.accounts.opener_protections.to_account_info())?;
    count_entry(&ctx.accounts.protections.to_account_info(), entry)?;
    let mut holdings = load_holdings(&player, ctx.remaining_accounts)?;
    let acct = &mut ctx.accounts.player_account.inner;
    let lines = with_holdings(&mut holdings, |hs| ledger::draw_entry(acct, hs, entry))?;
    let side = Side {
        player: player.to_bytes(),
        funder: player.to_bytes(),
        share_bps: 0,
        lines,
    };
    ctx.accounts
        .match_state
        .inner
        .join(side, now()?)
        .map_err(core_err)
}

/// Enters a Match with a Backer's Gemas (an accepted Offer). `remaining_accounts` are the
/// Backer's reserved Holdings, in the Offer's line order. The Player is never debited.
#[derive(Accounts)]
#[instruction(match_id: u64, game: Pubkey)]
pub struct OpenMatchBacked<'info> {
    #[account(mut)]
    pub player_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [GAME_SEED, game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: the Game program; the loader state is read by `listing`.
    #[account(address = game)]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData; `listing` derives and checks it.
    pub program_data: UncheckedAccount<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, player_authority.key().as_ref()],
        bump = player_account.bump
    )]
    pub player_account: Account<'info, TesoroAccount>,
    /// CHECK: the Player's Protections address; a Player who is away cannot be backed.
    #[account(
        seeds = [PROTECTIONS_SEED, player_account.key().as_ref()],
        bump
    )]
    pub protections: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [OFFER_SEED, offer.inner.backer.as_ref(), &offer.nonce.to_le_bytes()],
        bump = offer.bump
    )]
    pub offer: Box<Account<'info, OfferState>>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, backer_account.authority.as_ref()],
        bump = backer_account.bump,
        constraint = backer_account.key().to_bytes() == offer.inner.backer @ TesoroError::InvalidAccount
    )]
    pub backer_account: Account<'info, TesoroAccount>,
    /// CHECK: the Backer's Protections address; a Backer who is away cannot fund a Match.
    #[account(
        seeds = [PROTECTIONS_SEED, backer_account.key().as_ref()],
        bump
    )]
    pub backer_protections: UncheckedAccount<'info>,
    #[account(
        init,
        payer = player_authority,
        space = MatchState::SPACE,
        seeds = [MATCH_SEED, &match_id.to_le_bytes()],
        bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn open_match_backed<'info>(
    ctx: Context<'_, '_, 'info, 'info, OpenMatchBacked<'info>>,
    match_id: u64,
    game: Pubkey,
    entry: u64,
) -> Result<()> {
    let (fees, entries) = {
        let config = &ctx.accounts.config;
        (ctx.accounts.game_record.fee_terms(config), config.entries())
    };
    let (listed, deploy_slot) = listing(
        &ctx.accounts.game_record,
        &ctx.accounts.game_program.to_account_info(),
        &ctx.accounts.program_data.to_account_info(),
    )?;
    require!(listed, TesoroError::GameNotListed);
    require_can_play(&ctx.accounts.protections.to_account_info())?;
    require_can_play(&ctx.accounts.backer_protections.to_account_info())?;
    let side = consume_offer(
        &mut ctx.accounts.offer,
        &mut ctx.accounts.backer_account,
        ctx.accounts.player_account.key(),
        game,
        entry,
        ctx.remaining_accounts,
    )?;
    let m = ledger::Match::open(game.to_bytes(), entry, &entries, fees, side, now()?)
        .map_err(core_err)?;
    let state = &mut ctx.accounts.match_state;
    state.bump = ctx.bumps.match_state;
    state.id = match_id;
    state.inner = m;
    state.listed = listed;
    state.deploy_slot = deploy_slot;
    Ok(())
}

#[derive(Accounts)]
pub struct JoinMatchBacked<'info> {
    #[account(mut)]
    pub player_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, player_authority.key().as_ref()],
        bump = player_account.bump
    )]
    pub player_account: Account<'info, TesoroAccount>,
    /// CHECK: the Player's Protections address; a Player who is away cannot be backed.
    #[account(
        seeds = [PROTECTIONS_SEED, player_account.key().as_ref()],
        bump
    )]
    pub protections: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [OFFER_SEED, offer.inner.backer.as_ref(), &offer.nonce.to_le_bytes()],
        bump = offer.bump
    )]
    pub offer: Box<Account<'info, OfferState>>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, backer_account.authority.as_ref()],
        bump = backer_account.bump,
        constraint = backer_account.key().to_bytes() == offer.inner.backer @ TesoroError::InvalidAccount
    )]
    pub backer_account: Account<'info, TesoroAccount>,
    /// CHECK: the Backer's Protections address; a Backer who is away cannot fund a Match.
    #[account(
        seeds = [PROTECTIONS_SEED, backer_account.key().as_ref()],
        bump
    )]
    pub backer_protections: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [MATCH_SEED, &match_state.id.to_le_bytes()],
        bump = match_state.bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
    /// CHECK: the opener's Protections address; nobody joins a Match whose opener is away.
    #[account(
        seeds = [PROTECTIONS_SEED, match_state.inner.a.player.as_ref()],
        bump
    )]
    pub opener_protections: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = player_authority,
        space = PairState::SPACE,
        seeds = [PAIR_SEED, match_state.inner.a.player.as_ref(), player_account.key().as_ref()],
        bump
    )]
    pub pair: Account<'info, PairState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn join_match_backed<'info>(
    ctx: Context<'_, '_, 'info, 'info, JoinMatchBacked<'info>>,
) -> Result<()> {
    require!(ctx.accounts.match_state.listed, TesoroError::GameNotListed);
    record_pair(&mut ctx.accounts.pair, ctx.bumps.pair, now()?)?;
    let (game, entry) = {
        let m = &ctx.accounts.match_state.inner;
        (Pubkey::new_from_array(m.game), m.entry)
    };
    require_can_play(&ctx.accounts.opener_protections.to_account_info())?;
    require_can_play(&ctx.accounts.protections.to_account_info())?;
    require_can_play(&ctx.accounts.backer_protections.to_account_info())?;
    let side = consume_offer(
        &mut ctx.accounts.offer,
        &mut ctx.accounts.backer_account,
        ctx.accounts.player_account.key(),
        game,
        entry,
        ctx.remaining_accounts,
    )?;
    ctx.accounts
        .match_state
        .inner
        .join(side, now()?)
        .map_err(core_err)
}

fn consume_offer<'info>(
    offer: &mut Account<'info, OfferState>,
    backer: &mut Account<'info, TesoroAccount>,
    player: Pubkey,
    game: Pubkey,
    entry: u64,
    remaining: &'info [AccountInfo<'info>],
) -> Result<Side> {
    let mut holdings = load_holdings(&backer.key(), remaining)?;
    let now = now()?;
    let acct = &mut backer.inner;
    let offer_inner = &mut offer.inner;
    with_holdings(&mut holdings, |hs| {
        offer_inner.consume(player.to_bytes(), game.to_bytes(), entry, now, acct, hs)
    })
}

/// Only a registered Game authority may settle its Matches. `remaining_accounts`: per payout, in
/// the order the ledger sorts them (recipient, source): the recipient's `TesoroAccount`, then its
/// Holding of that Source (see docs/tesoro-core.md).
#[derive(Accounts)]
pub struct SettleMatch<'info> {
    pub game_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [GAME_SEED, match_state.inner.game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    #[account(
        mut,
        seeds = [MATCH_SEED, &match_state.id.to_le_bytes()],
        bump = match_state.bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
}

pub(crate) fn settle_match<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleMatch<'info>>,
    result: MatchResult,
) -> Result<()> {
    let game = Pubkey::new_from_array(ctx.accounts.match_state.inner.game);
    require_keys_eq!(
        ctx.accounts.game_record.settle_authority,
        ctx.accounts.game_authority.key(),
        TesoroError::Unauthorized
    );
    let outcome = match result {
        MatchResult::Opener => Outcome::Winner(0),
        MatchResult::Joiner => Outcome::Winner(1),
        MatchResult::Draw => Outcome::Draw,
    };
    let lb = ctx.accounts.config.leaderboard_terms();
    let payouts = ctx
        .accounts
        .match_state
        .inner
        .settle_with(outcome, &lb)
        .map_err(core_err)?;
    credit_payouts(&payouts, ctx.remaining_accounts)?;
    if let Outcome::Winner(i) = outcome {
        let m = &ctx.accounts.match_state.inner;
        let side = if i == 0 { Some(&m.a) } else { m.b.as_ref() };
        let other = if i == 0 { m.b.as_ref() } else { Some(&m.a) };
        if let Some(side) = side {
            let ts = now()?;
            emit!(MatchWon {
                match_id: ctx.accounts.match_state.id,
                game,
                entry: m.entry,
                player: Pubkey::new_from_array(side.player),
                funder: Pubkey::new_from_array(side.funder),
                points: if ctx.accounts.match_state.listed {
                    ledger::points_for_win(m.entry)
                } else {
                    0
                },
                pool_fee: m.leaderboard_due(&lb).map_err(core_err)?,
                season: ledger::season_at(ts).unwrap_or(0),
                ts,
                loser: Pubkey::new_from_array(other.map_or([0u8; 32], |o| o.player)),
            });
        }
    }
    emit!(MatchSettled {
        match_id: ctx.accounts.match_state.id,
        result: match result {
            MatchResult::Opener => 0,
            MatchResult::Joiner => 1,
            MatchResult::Draw => 2,
        },
    });
    Ok(())
}

/// Refunds both entries: abandonment, no-show or cancellation. The Game authority (or the
/// opener of a Match nobody joined) may do it at once; anybody may after the deadline.
/// `remaining_accounts` as for `settle_match`.
#[derive(Accounts)]
pub struct RefundMatch<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [GAME_SEED, match_state.inner.game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    #[account(
        mut,
        seeds = [MATCH_SEED, &match_state.id.to_le_bytes()],
        bump = match_state.bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
    /// CHECK: the opener's Protections address. Optional: when the opener of a Match nobody joined
    /// is on a Break or Self-Excluded, anyone may refund it at once.
    #[account(
        seeds = [PROTECTIONS_SEED, match_state.inner.a.player.as_ref()],
        bump
    )]
    pub opener_protections: Option<UncheckedAccount<'info>>,
}

pub(crate) fn refund_match<'info>(
    ctx: Context<'_, '_, 'info, 'info, RefundMatch<'info>>,
) -> Result<()> {
    let caller = ctx.accounts.caller.key();
    let m = &ctx.accounts.match_state.inner;
    let is_game = ctx.accounts.game_record.settle_authority == caller;
    let is_opener = m.status == MatchStatus::Open && {
        let (opener, _) =
            Pubkey::find_program_address(&[ACCOUNT_SEED, caller.as_ref()], &crate::ID);
        opener.to_bytes() == m.a.player
    };
    let opener_away = match (
        &ctx.accounts.opener_protections,
        m.status == MatchStatus::Open,
    ) {
        (Some(p), true) => is_away(&p.to_account_info())?,
        _ => false,
    };
    let payouts = ctx
        .accounts
        .match_state
        .inner
        .refund(now()?, is_game || is_opener || opener_away)
        .map_err(core_err)?;
    credit_payouts(&payouts, ctx.remaining_accounts)
}

/// A registered Game's authority pushes an Open or Active Match's refund deadline out, so an async
/// Game can outlast the default 1h window (an Open Match waits longer for an opponent too). Never moves it earlier; capped at `MAX_MATCH_EXTENSION_SECS`.
#[derive(Accounts)]
pub struct ExtendMatchDeadline<'info> {
    pub game_authority: Signer<'info>,
    #[account(seeds = [GAME_SEED, match_state.inner.game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    #[account(
        mut,
        seeds = [MATCH_SEED, &match_state.id.to_le_bytes()],
        bump = match_state.bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
}

pub(crate) fn extend_match_deadline(
    ctx: Context<ExtendMatchDeadline>,
    new_deadline: i64,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.game_record.settle_authority,
        ctx.accounts.game_authority.key(),
        TesoroError::Unauthorized
    );
    ctx.accounts
        .match_state
        .inner
        .extend_deadline(now()?, new_deadline)
        .map_err(core_err)
}

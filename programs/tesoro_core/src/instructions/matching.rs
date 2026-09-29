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

fn game_entry<'a>(config: &'a Config, game: &Pubkey) -> Result<&'a GameEntry> {
    config
        .game(game)
        .ok_or_else(|| error!(TesoroError::GameNotRegistered))
}

/// `remaining_accounts` are the entrant's Holdings, own-sourced first, then won, each ascending
/// by Source address (see docs/tesoro-core.md).
#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct OpenMatch<'info> {
    #[account(mut)]
    pub player_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, player_authority.key().as_ref()],
        bump = player_account.bump
    )]
    pub player_account: Account<'info, TesoroAccount>,
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
    let fees = {
        let config = &ctx.accounts.config;
        config.fee_terms(game_entry(config, &game)?)
    };
    let player = ctx.accounts.player_account.key();
    let mut holdings = load_holdings(&player, ctx.remaining_accounts)?;
    let acct = &mut ctx.accounts.player_account.inner;
    let lines = with_holdings(&mut holdings, |hs| ledger::draw_entry(acct, hs, entry))?;
    let side = Side {
        player: player.to_bytes(),
        funder: player.to_bytes(),
        share_bps: 0,
        lines,
    };
    let m = ledger::Match::open(game.to_bytes(), entry, fees, side, now()?).map_err(core_err)?;
    let state = &mut ctx.accounts.match_state;
    state.bump = ctx.bumps.match_state;
    state.id = match_id;
    state.inner = m;
    Ok(())
}

#[derive(Accounts)]
pub struct JoinMatch<'info> {
    pub player_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, player_authority.key().as_ref()],
        bump = player_account.bump
    )]
    pub player_account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [MATCH_SEED, &match_state.id.to_le_bytes()],
        bump = match_state.bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
}

pub(crate) fn join_match<'info>(
    ctx: Context<'_, '_, 'info, 'info, JoinMatch<'info>>,
) -> Result<()> {
    let player = ctx.accounts.player_account.key();
    let entry = ctx.accounts.match_state.inner.entry;
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
#[instruction(match_id: u64)]
pub struct OpenMatchBacked<'info> {
    #[account(mut)]
    pub player_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [ACCOUNT_SEED, player_authority.key().as_ref()],
        bump = player_account.bump
    )]
    pub player_account: Account<'info, TesoroAccount>,
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
    let fees = {
        let config = &ctx.accounts.config;
        config.fee_terms(game_entry(config, &game)?)
    };
    let side = consume_offer(
        &mut ctx.accounts.offer,
        &mut ctx.accounts.backer_account,
        ctx.accounts.player_account.key(),
        game,
        entry,
        ctx.remaining_accounts,
    )?;
    let m = ledger::Match::open(game.to_bytes(), entry, fees, side, now()?).map_err(core_err)?;
    let state = &mut ctx.accounts.match_state;
    state.bump = ctx.bumps.match_state;
    state.id = match_id;
    state.inner = m;
    Ok(())
}

#[derive(Accounts)]
pub struct JoinMatchBacked<'info> {
    pub player_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, player_authority.key().as_ref()],
        bump = player_account.bump
    )]
    pub player_account: Account<'info, TesoroAccount>,
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
    #[account(
        mut,
        seeds = [MATCH_SEED, &match_state.id.to_le_bytes()],
        bump = match_state.bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
}

pub(crate) fn join_match_backed<'info>(
    ctx: Context<'_, '_, 'info, 'info, JoinMatchBacked<'info>>,
) -> Result<()> {
    let (game, entry) = {
        let m = &ctx.accounts.match_state.inner;
        (Pubkey::new_from_array(m.game), m.entry)
    };
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
    let entry = game_entry(&ctx.accounts.config, &game)?;
    require_keys_eq!(
        entry.authority,
        ctx.accounts.game_authority.key(),
        TesoroError::Unauthorized
    );
    let outcome = match result {
        MatchResult::Opener => Outcome::Winner(0),
        MatchResult::Joiner => Outcome::Winner(1),
        MatchResult::Draw => Outcome::Draw,
    };
    let payouts = ctx
        .accounts
        .match_state
        .inner
        .settle(outcome)
        .map_err(core_err)?;
    credit_payouts(&payouts, ctx.remaining_accounts)?;
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
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [MATCH_SEED, &match_state.id.to_le_bytes()],
        bump = match_state.bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
}

pub(crate) fn refund_match<'info>(
    ctx: Context<'_, '_, 'info, 'info, RefundMatch<'info>>,
) -> Result<()> {
    let caller = ctx.accounts.caller.key();
    let m = &ctx.accounts.match_state.inner;
    let game = Pubkey::new_from_array(m.game);
    let is_game = ctx
        .accounts
        .config
        .game(&game)
        .is_some_and(|g| g.authority == caller);
    let is_opener = m.status == MatchStatus::Open && {
        let (opener, _) =
            Pubkey::find_program_address(&[ACCOUNT_SEED, caller.as_ref()], &crate::ID);
        opener.to_bytes() == m.a.player
    };
    let payouts = ctx
        .accounts
        .match_state
        .inner
        .refund(now()?, is_game || is_opener)
        .map_err(core_err)?;
    credit_payouts(&payouts, ctx.remaining_accounts)
}

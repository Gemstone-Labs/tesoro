use crate::error::{core_err, MatchError, TesoroError};
use crate::instructions::economy::with_pool;
use crate::instructions::ticket::ticket_err;
use crate::ledger::{self, OfferStatus};
use crate::state::*;
use crate::storage::*;
use crate::util::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(nonce: u64, game: Pubkey)]
pub struct CreateRequest<'info> {
    #[account(mut)]
    pub player_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [GAME_SEED, game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    #[account(
        seeds = [ACCOUNT_SEED, player_authority.key().as_ref()],
        bump = player_account.bump
    )]
    pub player_account: Account<'info, TesoroAccount>,
    /// CHECK: the Player's Protections address; a Player who is away cannot ask to be backed.
    #[account(
        seeds = [PROTECTIONS_SEED, player_account.key().as_ref()],
        bump
    )]
    pub protections: UncheckedAccount<'info>,
    #[account(
        init,
        payer = player_authority,
        space = RequestState::SPACE,
        seeds = [REQUEST_SEED, player_account.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub request: Account<'info, RequestState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn create_request(
    ctx: Context<CreateRequest>,
    nonce: u64,
    game: Pubkey,
    entry: u64,
) -> Result<()> {
    require_can_play(&ctx.accounts.protections.to_account_info())?;
    let request = &mut ctx.accounts.request;
    request.bump = ctx.bumps.request;
    request.nonce = nonce;
    request.inner = ledger::Request::new(
        ctx.accounts.player_account.key().to_bytes(),
        game.to_bytes(),
        entry,
        &ctx.accounts.config.entries(),
        now()?,
    )
    .map_err(core_err)?;
    Ok(())
}

#[derive(Accounts)]
pub struct CancelRequest<'info> {
    pub player_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, player_authority.key().as_ref()],
        bump = player_account.bump
    )]
    pub player_account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [REQUEST_SEED, request.inner.player.as_ref(), &request.nonce.to_le_bytes()],
        bump = request.bump,
        constraint = request.inner.player == player_account.key().to_bytes() @ TesoroError::Unauthorized
    )]
    pub request: Account<'info, RequestState>,
}

pub(crate) fn cancel_request(ctx: Context<CancelRequest>) -> Result<()> {
    ctx.accounts.request.inner.cancel().map_err(core_err)
}

/// Anyone withdraws an open Request of a Player who is on a Break or Self-Excluded.
#[derive(Accounts)]
pub struct ClearRequest<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [REQUEST_SEED, request.inner.player.as_ref(), &request.nonce.to_le_bytes()],
        bump = request.bump
    )]
    pub request: Account<'info, RequestState>,
    /// CHECK: the Request owner's Protections address.
    #[account(
        seeds = [PROTECTIONS_SEED, request.inner.player.as_ref()],
        bump
    )]
    pub protections: UncheckedAccount<'info>,
}

pub(crate) fn clear_request(ctx: Context<ClearRequest>) -> Result<()> {
    require!(
        is_away(&ctx.accounts.protections.to_account_info())?,
        TesoroError::Unauthorized
    );
    ctx.accounts.request.inner.cancel().map_err(core_err)
}

/// Creates an Offer on one live Request, for its game and entry, and reserves the Backer's entry:
/// an *amount* of Gemas held by the slowest lines of the Backer's basket and spill (nothing is
/// moved). Every Offer answers a Request; there are no public Offers.
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateOffer<'info> {
    #[account(mut)]
    pub backer_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [REQUEST_SEED, request.inner.player.as_ref(), &request.nonce.to_le_bytes()],
        bump = request.bump
    )]
    pub request: Box<Account<'info, RequestState>>,
    #[account(seeds = [GAME_SEED, request.inner.game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    #[account(
        seeds = [ACCOUNT_SEED, backer_authority.key().as_ref()],
        bump = backer_account.bump
    )]
    pub backer_account: Account<'info, TesoroAccount>,
    /// CHECK: the Backer's Protections address; empty when none is set (see `count_entry`).
    #[account(
        mut,
        seeds = [PROTECTIONS_SEED, backer_account.key().as_ref()],
        bump
    )]
    pub protections: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [BASKET_SEED, backer_account.key().as_ref()],
        bump = basket.load()?.raw[STORE_BUMP_AT]
    )]
    pub basket: AccountLoader<'info, BasketHead>,
    #[account(
        mut,
        seeds = [SPILL_SEED, backer_account.key().as_ref()],
        bump = spill.load()?.raw[STORE_BUMP_AT]
    )]
    pub spill: AccountLoader<'info, SpillHead>,
    #[account(
        init_if_needed,
        payer = backer_authority,
        space = AccountCounters::SPACE,
        seeds = [COUNTERS_SEED, backer_account.key().as_ref()],
        bump
    )]
    pub counters: Account<'info, AccountCounters>,
    #[account(
        init,
        payer = backer_authority,
        space = OfferState::SPACE,
        seeds = [OFFER_SEED, backer_account.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub offer: Box<Account<'info, OfferState>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn create_offer(
    ctx: Context<CreateOffer>,
    nonce: u64,
    player_share_bps: u16,
) -> Result<()> {
    let backer = ctx.accounts.backer_account.key();
    let created = ledger::Offer::create(
        backer.to_bytes(),
        &ctx.accounts.request.inner,
        ctx.accounts.request.key().to_bytes(),
        &ctx.accounts.config.entries(),
        player_share_bps,
        now()?,
    )
    .map_err(core_err)?;
    let entry = created.entry;
    count_entry(&ctx.accounts.protections.to_account_info(), entry)?;
    let counters = &mut ctx.accounts.counters;
    if counters.bump == 0 {
        counters.bump = ctx.bumps.counters;
    }
    let open = counters.open_offers;
    with_pool(
        &ctx.accounts.basket.to_account_info(),
        &ctx.accounts.spill.to_account_info(),
        |pool| pool.reserve_offer(entry, open).map_err(ticket_err),
    )?;
    counters.open_offers = open
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let offer = &mut ctx.accounts.offer;
    offer.bump = ctx.bumps.offer;
    offer.nonce = nonce;
    offer.inner = created;
    Ok(())
}

/// The Player accepts an Offer made on their Request.
#[derive(Accounts)]
pub struct AcceptOffer<'info> {
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
        seeds = [REQUEST_SEED, request.inner.player.as_ref(), &request.nonce.to_le_bytes()],
        bump = request.bump,
        constraint = request.inner.player == player_account.key().to_bytes() @ TesoroError::Unauthorized
    )]
    pub request: Account<'info, RequestState>,
    #[account(
        mut,
        seeds = [OFFER_SEED, offer.inner.backer.as_ref(), &offer.nonce.to_le_bytes()],
        bump = offer.bump
    )]
    pub offer: Box<Account<'info, OfferState>>,
}

pub(crate) fn accept_offer(ctx: Context<AcceptOffer>) -> Result<()> {
    require_can_play(&ctx.accounts.protections.to_account_info())?;
    let request_key = ctx.accounts.request.key();
    ctx.accounts
        .offer
        .inner
        .accept(
            &mut ctx.accounts.request.inner,
            request_key.to_bytes(),
            now()?,
        )
        .map_err(core_err)
}

/// The Backer withdraws an Offer that has not been used to start a Match; the reservation is
/// released. Refused while a Backing Ticket is staging its lines (cancel that first).
#[derive(Accounts)]
pub struct CancelOffer<'info> {
    pub backer_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, backer_authority.key().as_ref()],
        bump = backer_account.bump
    )]
    pub backer_account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [BASKET_SEED, backer_account.key().as_ref()],
        bump = basket.load()?.raw[STORE_BUMP_AT]
    )]
    pub basket: AccountLoader<'info, BasketHead>,
    #[account(
        mut,
        seeds = [SPILL_SEED, backer_account.key().as_ref()],
        bump = spill.load()?.raw[STORE_BUMP_AT]
    )]
    pub spill: AccountLoader<'info, SpillHead>,
    #[account(
        mut,
        seeds = [COUNTERS_SEED, backer_account.key().as_ref()],
        bump = counters.bump
    )]
    pub counters: Account<'info, AccountCounters>,
    #[account(
        mut,
        seeds = [OFFER_SEED, offer.inner.backer.as_ref(), &offer.nonce.to_le_bytes()],
        bump = offer.bump,
        constraint = offer.inner.backer == backer_account.key().to_bytes() @ TesoroError::Unauthorized
    )]
    pub offer: Box<Account<'info, OfferState>>,
    /// The Request the Offer had accepted, required exactly when it had one: it is listed again.
    #[account(
        mut,
        seeds = [REQUEST_SEED, request.inner.player.as_ref(), &request.nonce.to_le_bytes()],
        bump = request.bump
    )]
    pub request: Option<Account<'info, RequestState>>,
}

/// An Accepted Offer that ends unused hands its Request back: the Player would otherwise be left
/// with a Request that can never be answered again.
fn reopen_accepted_request(
    accepted: Option<ledger::Key>,
    request: &mut Option<Account<RequestState>>,
) -> Result<()> {
    let Some(expected) = accepted else {
        return Ok(());
    };
    let request = request
        .as_mut()
        .ok_or_else(|| error!(TesoroError::InvalidAccount))?;
    require!(
        request.key().to_bytes() == expected,
        TesoroError::InvalidAccount
    );
    request.inner.reopen();
    Ok(())
}

/// Releases the Offer's reserved amount and counts it closed.
fn release_offer(
    basket: &AccountInfo,
    spill: &AccountInfo,
    counters: &mut AccountCounters,
    entry: u64,
) -> Result<()> {
    with_pool(basket, spill, |pool| {
        pool.release_offer(entry).map_err(ticket_err)
    })?;
    counters.open_offers = counters.open_offers.saturating_sub(1);
    Ok(())
}

pub(crate) fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
    let offer = &mut ctx.accounts.offer.inner;
    require!(!offer.ticket_open, MatchError::OfferHasTicket);
    let accepted = (offer.status == OfferStatus::Accepted).then_some(offer.request);
    let entry = offer.entry;
    offer.cancel().map_err(core_err)?;
    release_offer(
        &ctx.accounts.basket.to_account_info(),
        &ctx.accounts.spill.to_account_info(),
        &mut ctx.accounts.counters,
        entry,
    )?;
    reopen_accepted_request(accepted, &mut ctx.accounts.request)
}

/// Anyone releases the reservation of an Offer nobody accepted, or nobody used, within 24h.
#[derive(Accounts)]
pub struct ExpireOffer<'info> {
    pub caller: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, backer_account.authority.as_ref()],
        bump = backer_account.bump,
        constraint = backer_account.key().to_bytes() == offer.inner.backer @ TesoroError::InvalidAccount
    )]
    pub backer_account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [BASKET_SEED, backer_account.key().as_ref()],
        bump = basket.load()?.raw[STORE_BUMP_AT]
    )]
    pub basket: AccountLoader<'info, BasketHead>,
    #[account(
        mut,
        seeds = [SPILL_SEED, backer_account.key().as_ref()],
        bump = spill.load()?.raw[STORE_BUMP_AT]
    )]
    pub spill: AccountLoader<'info, SpillHead>,
    #[account(
        mut,
        seeds = [COUNTERS_SEED, backer_account.key().as_ref()],
        bump = counters.bump
    )]
    pub counters: Account<'info, AccountCounters>,
    #[account(
        mut,
        seeds = [OFFER_SEED, offer.inner.backer.as_ref(), &offer.nonce.to_le_bytes()],
        bump = offer.bump
    )]
    pub offer: Box<Account<'info, OfferState>>,
    /// The Request the Offer had accepted, required exactly when it had one: it is listed again.
    #[account(
        mut,
        seeds = [REQUEST_SEED, request.inner.player.as_ref(), &request.nonce.to_le_bytes()],
        bump = request.bump
    )]
    pub request: Option<Account<'info, RequestState>>,
    /// CHECK: the Backer's Protections address. Optional: when the Backer is on a Break or
    /// Self-Excluded, anyone may withdraw their unused Offer at once.
    #[account(
        seeds = [PROTECTIONS_SEED, offer.inner.backer.as_ref()],
        bump
    )]
    pub backer_protections: Option<UncheckedAccount<'info>>,
}

pub(crate) fn expire_offer(ctx: Context<ExpireOffer>) -> Result<()> {
    let now = now()?;
    let offer = &mut ctx.accounts.offer.inner;
    require!(!offer.ticket_open, MatchError::OfferHasTicket);
    let accepted = (offer.status == OfferStatus::Accepted).then_some(offer.request);
    let backer_away = match &ctx.accounts.backer_protections {
        Some(p) => is_away(&p.to_account_info())?,
        None => false,
    };
    let entry = offer.entry;
    if backer_away {
        offer.cancel()
    } else {
        offer.expire(now)
    }
    .map_err(core_err)?;
    release_offer(
        &ctx.accounts.basket.to_account_info(),
        &ctx.accounts.spill.to_account_info(),
        &mut ctx.accounts.counters,
        entry,
    )?;
    reopen_accepted_request(accepted, &mut ctx.accounts.request)
}

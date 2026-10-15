use crate::error::{core_err, TesoroError};
use crate::ledger::{self, OfferKind, OfferStatus};
use crate::state::*;
use crate::util::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateRequest<'info> {
    #[account(mut)]
    pub player_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
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
    require!(
        ctx.accounts.config.game(&game).is_some(),
        TesoroError::GameNotRegistered
    );
    require_can_play(&ctx.accounts.protections.to_account_info())?;
    let request = &mut ctx.accounts.request;
    request.bump = ctx.bumps.request;
    request.nonce = nonce;
    request.inner = ledger::Request::new(
        ctx.accounts.player_account.key().to_bytes(),
        game.to_bytes(),
        entry,
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

/// Creates an Offer and reserves the Backer's entry. `remaining_accounts` are the Backer's
/// Holdings, own-sourced first, then won, each ascending by Source address.
/// `directed_request` makes it a directed Offer; `None` makes it public.
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateOffer<'info> {
    #[account(mut)]
    pub backer_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
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
        init,
        payer = backer_authority,
        space = OfferState::SPACE,
        seeds = [OFFER_SEED, backer_account.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub offer: Box<Account<'info, OfferState>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn create_offer<'info>(
    ctx: Context<'_, '_, 'info, 'info, CreateOffer<'info>>,
    nonce: u64,
    game: Pubkey,
    entry: u64,
    player_share_bps: u16,
    directed_request: Option<Pubkey>,
) -> Result<()> {
    require!(
        ctx.accounts.config.game(&game).is_some(),
        TesoroError::GameNotRegistered
    );
    let backer = ctx.accounts.backer_account.key();
    count_entry(&ctx.accounts.protections.to_account_info(), entry)?;
    let mut holdings = load_holdings(&backer, ctx.remaining_accounts)?;
    let kind = match directed_request {
        Some(r) => OfferKind::Directed(r.to_bytes()),
        None => OfferKind::Public,
    };
    let now = now()?;
    let acct = &mut ctx.accounts.backer_account.inner;
    let created = with_holdings(&mut holdings, |hs| {
        ledger::Offer::create(
            backer.to_bytes(),
            game.to_bytes(),
            entry,
            player_share_bps,
            kind,
            now,
            acct,
            hs,
        )
    })?;
    let offer = &mut ctx.accounts.offer;
    offer.bump = ctx.bumps.offer;
    offer.nonce = nonce;
    offer.inner = created;
    Ok(())
}

/// The Player accepts an Offer directed at their Request.
#[derive(Accounts)]
pub struct AcceptDirected<'info> {
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

pub(crate) fn accept_directed(ctx: Context<AcceptDirected>) -> Result<()> {
    require_can_play(&ctx.accounts.protections.to_account_info())?;
    let request_key = ctx.accounts.request.key();
    ctx.accounts
        .offer
        .inner
        .accept_directed(
            &mut ctx.accounts.request.inner,
            request_key.to_bytes(),
            now()?,
        )
        .map_err(core_err)
}

/// A Player applies to a public Offer with their Request.
#[derive(Accounts)]
pub struct ApplyOffer<'info> {
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

pub(crate) fn apply_offer(ctx: Context<ApplyOffer>) -> Result<()> {
    require_can_play(&ctx.accounts.protections.to_account_info())?;
    let request_key = ctx.accounts.request.key();
    ctx.accounts
        .offer
        .inner
        .apply(&ctx.accounts.request.inner, request_key.to_bytes(), now()?)
        .map_err(core_err)
}

/// The Backer accepts one applicant of their public Offer.
#[derive(Accounts)]
pub struct AcceptApplicant<'info> {
    pub backer_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, backer_authority.key().as_ref()],
        bump = backer_account.bump
    )]
    pub backer_account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [REQUEST_SEED, request.inner.player.as_ref(), &request.nonce.to_le_bytes()],
        bump = request.bump
    )]
    pub request: Account<'info, RequestState>,
    /// CHECK: the applicant Player's Protections address; a Player who is away cannot be backed.
    #[account(
        seeds = [PROTECTIONS_SEED, request.inner.player.as_ref()],
        bump
    )]
    pub player_protections: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [OFFER_SEED, offer.inner.backer.as_ref(), &offer.nonce.to_le_bytes()],
        bump = offer.bump,
        constraint = offer.inner.backer == backer_account.key().to_bytes() @ TesoroError::Unauthorized
    )]
    pub offer: Box<Account<'info, OfferState>>,
}

pub(crate) fn accept_applicant(ctx: Context<AcceptApplicant>) -> Result<()> {
    require_can_play(&ctx.accounts.player_protections.to_account_info())?;
    let request_key = ctx.accounts.request.key();
    ctx.accounts
        .offer
        .inner
        .accept_applicant(
            &mut ctx.accounts.request.inner,
            request_key.to_bytes(),
            now()?,
        )
        .map_err(core_err)
}

/// The Backer withdraws an Offer that has not been used to start a Match. `remaining_accounts`:
/// the Backer's reserved Holdings in the Offer's line order.
#[derive(Accounts)]
pub struct CancelOffer<'info> {
    pub backer_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, backer_authority.key().as_ref()],
        bump = backer_account.bump
    )]
    pub backer_account: Account<'info, TesoroAccount>,
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

pub(crate) fn cancel_offer<'info>(
    ctx: Context<'_, '_, 'info, 'info, CancelOffer<'info>>,
) -> Result<()> {
    let mut holdings = load_holdings(&ctx.accounts.backer_account.key(), ctx.remaining_accounts)?;
    let acct = &mut ctx.accounts.backer_account.inner;
    let offer = &mut ctx.accounts.offer.inner;
    let accepted = (offer.status == OfferStatus::Accepted)
        .then_some(offer.request)
        .flatten();
    with_holdings(&mut holdings, |hs| offer.cancel(acct, hs))?;
    reopen_accepted_request(accepted, &mut ctx.accounts.request)
}

/// Anyone releases the reservation of an Offer nobody accepted, or nobody used, within 24h.
#[derive(Accounts)]
pub struct ExpireOffer<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, backer_account.authority.as_ref()],
        bump = backer_account.bump,
        constraint = backer_account.key().to_bytes() == offer.inner.backer @ TesoroError::InvalidAccount
    )]
    pub backer_account: Account<'info, TesoroAccount>,
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

pub(crate) fn expire_offer<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExpireOffer<'info>>,
) -> Result<()> {
    let mut holdings = load_holdings(&ctx.accounts.backer_account.key(), ctx.remaining_accounts)?;
    let now = now()?;
    let acct = &mut ctx.accounts.backer_account.inner;
    let offer = &mut ctx.accounts.offer.inner;
    let accepted = (offer.status == OfferStatus::Accepted)
        .then_some(offer.request)
        .flatten();
    let backer_away = match &ctx.accounts.backer_protections {
        Some(p) => is_away(&p.to_account_info())?,
        None => false,
    };
    with_holdings(&mut holdings, |hs| {
        if backer_away {
            offer.cancel(acct, hs)
        } else {
            offer.expire(now, acct, hs)
        }
    })?;
    reopen_accepted_request(accepted, &mut ctx.accounts.request)
}

//! Backing: Request, Offer, acceptance by both sides, 24h expiries. An Offer reserves an *amount*
//! of the Backer's Gemas (`Pool::reserve_offer`, held by the slowest lines); the reservation is
//! made and released by the caller, so these types hold no Gemas. A Backing is an accepted Offer;
//! joining a Match consumes it (no revoke after that: the Gemas are already in the Pot). The
//! backed Player is never debited and never holds the Backer's Gemas outside of a settlement
//! payout.

use super::*;
use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum RequestStatus {
    Open,
    Accepted,
    Cancelled,
}

/// A Player's listing asking to be backed for a game and entry size. Carries no split.
#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Request {
    pub player: Key,
    pub game: Key,
    pub entry: u64,
    pub expires_at: i64,
    pub status: RequestStatus,
}

impl Request {
    pub fn new(player: Key, game: Key, entry: u64, sizes: &[u64], now: i64) -> CoreResult<Self> {
        if !is_ladder_entry(entry, sizes) {
            return Err(CoreError::InvalidEntry);
        }
        Ok(Self {
            player,
            game,
            entry,
            expires_at: now.checked_add(BACKING_TTL_SECS).ok_or(CoreError::Math)?,
            status: RequestStatus::Open,
        })
    }

    pub fn is_live(&self, now: i64) -> bool {
        self.status == RequestStatus::Open && now < self.expires_at
    }

    pub fn cancel(&mut self) -> CoreResult<()> {
        if self.status != RequestStatus::Open {
            return Err(CoreError::InvalidStatus);
        }
        self.status = RequestStatus::Cancelled;
        Ok(())
    }

    /// The Offer this Request accepted was cancelled or expired unused: the Request is listed again.
    pub fn reopen(&mut self) {
        if self.status == RequestStatus::Accepted {
            self.status = RequestStatus::Open;
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum OfferStatus {
    Open,
    /// Both sides agreed; waiting for the Player to enter a Match.
    Accepted,
    /// Used: the reservation moved into a Pot.
    Consumed,
    Cancelled,
    Expired,
}

#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Offer {
    pub backer: Key,
    pub game: Key,
    pub entry: u64,
    /// Player's share of the surplus, basis points. The Backer's max loss is `entry`.
    pub player_share_bps: u16,
    /// The Request this Offer answers. Every Offer is made on one Request; its Player accepts.
    pub request: Key,
    pub status: OfferStatus,
    /// Acceptance deadline for an Open Offer.
    pub expires_at: i64,
    /// Deadline to enter a Match once Accepted.
    pub use_by: i64,
    /// The Request's Player, once they accept.
    pub player: Option<Key>,
    /// A Backing Ticket is staging this Offer's lines: it cannot be cancelled or expired until
    /// the Ticket is cancelled or consumed.
    pub ticket_open: bool,
}

impl Offer {
    /// Creates an Offer on a live Request, for that Request's game and entry (still one of the
    /// allowed `sizes`). The Backer's `entry` is reserved by the caller (`Pool::reserve_offer`)
    /// before or with this.
    pub fn create(
        backer: Key,
        request: &Request,
        request_key: Key,
        sizes: &[u64],
        player_share_bps: u16,
        now: i64,
    ) -> CoreResult<Self> {
        if !is_ladder_entry(request.entry, sizes) {
            return Err(CoreError::InvalidEntry);
        }
        if player_share_bps as u128 > BPS {
            return Err(CoreError::InvalidBps);
        }
        let expires_at = now.checked_add(BACKING_TTL_SECS).ok_or(CoreError::Math)?;
        let offer = Self {
            backer,
            game: request.game,
            entry: request.entry,
            player_share_bps,
            request: request_key,
            status: OfferStatus::Open,
            expires_at,
            use_by: expires_at,
            player: None,
            ticket_open: false,
        };
        offer.check_request(request, now)?;
        Ok(offer)
    }

    fn check_request(&self, request: &Request, now: i64) -> CoreResult<()> {
        if request.game != self.game {
            return Err(CoreError::GameMismatch);
        }
        if request.entry != self.entry {
            return Err(CoreError::EntryMismatch);
        }
        if !request.is_live(now) {
            return Err(CoreError::Expired);
        }
        if request.player == self.backer {
            return Err(CoreError::SelfMatch);
        }
        Ok(())
    }

    fn open_live(&self, now: i64) -> CoreResult<()> {
        if self.status != OfferStatus::Open {
            return Err(CoreError::InvalidStatus);
        }
        if now >= self.expires_at {
            return Err(CoreError::Expired);
        }
        Ok(())
    }

    /// The Player accepts an Offer made on their Request.
    pub fn accept(&mut self, request: &mut Request, request_key: Key, now: i64) -> CoreResult<()> {
        self.open_live(now)?;
        if self.request != request_key {
            return Err(CoreError::WrongRequest);
        }
        self.check_request(request, now)?;
        self.use_by = now.checked_add(BACKING_TTL_SECS).ok_or(CoreError::Math)?;
        self.player = Some(request.player);
        self.status = OfferStatus::Accepted;
        request.status = RequestStatus::Accepted;
        Ok(())
    }

    /// The Backer withdraws the Offer before it is used; the caller releases the reservation.
    /// Not possible once a Match has started with it (`Consumed`).
    pub fn cancel(&mut self) -> CoreResult<()> {
        if self.ticket_open {
            return Err(CoreError::InvalidStatus);
        }
        if !matches!(self.status, OfferStatus::Open | OfferStatus::Accepted) {
            return Err(CoreError::InvalidStatus);
        }
        self.status = OfferStatus::Cancelled;
        Ok(())
    }

    /// Anyone expires an Offer nobody accepted, or nobody used, in time; the caller releases the
    /// reservation.
    pub fn expire(&mut self, now: i64) -> CoreResult<()> {
        if self.ticket_open {
            return Err(CoreError::InvalidStatus);
        }
        let deadline = match self.status {
            OfferStatus::Open => self.expires_at,
            OfferStatus::Accepted => self.use_by,
            _ => return Err(CoreError::InvalidStatus),
        };
        if now < deadline {
            return Err(CoreError::NotExpired);
        }
        self.status = OfferStatus::Expired;
        Ok(())
    }

    /// Whether `player` may enter a Match of `game` at `entry` with this Offer now.
    pub fn check_use(&self, player: Key, game: Key, entry: u64, now: i64) -> CoreResult<()> {
        if self.status != OfferStatus::Accepted {
            return Err(CoreError::InvalidStatus);
        }
        if self.player != Some(player) {
            return Err(CoreError::NotParty);
        }
        if now >= self.use_by {
            return Err(CoreError::Expired);
        }
        if self.game != game {
            return Err(CoreError::GameMismatch);
        }
        if self.entry != entry {
            return Err(CoreError::EntryMismatch);
        }
        Ok(())
    }

    /// The accepted Player enters a Match with the Backer's reservation: the Offer is spent. The
    /// caller draws the Backer's lines (`Pool::draw_backing_direct` or a Backing Ticket).
    pub fn consume(&mut self, player: Key, game: Key, entry: u64, now: i64) -> CoreResult<()> {
        self.check_use(player, game, entry, now)?;
        self.status = OfferStatus::Consumed;
        self.ticket_open = false;
        Ok(())
    }
}

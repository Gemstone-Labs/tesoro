//! Backing: Request, Offer, acceptance by both sides, 24h expiries, reservation of the Backer's
//! Gemas. A Backing is an accepted Offer; joining a Match consumes it (no revoke after that: the
//! Gemas are already in the Pot). The backed Player is never debited and never holds the Backer's
//! Gemas outside of a settlement payout.

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
    pub fn new(player: Key, game: Key, entry: u64, now: i64) -> CoreResult<Self> {
        if !is_ladder_entry(entry) {
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum OfferKind {
    /// Directed at one Request; that Player accepts.
    Directed(Key),
    /// Public: Players apply, the Backer accepts one.
    Public,
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
    pub kind: OfferKind,
    pub status: OfferStatus,
    /// Acceptance deadline for an Open Offer.
    pub expires_at: i64,
    /// Deadline to enter a Match once Accepted.
    pub use_by: i64,
    pub player: Option<Key>,
    pub request: Option<Key>,
    /// Request keys of applicants (public Offers).
    pub applicants: Vec<Key>,
    /// The Backer's reserved Gemas.
    pub lines: Vec<ReservedLine>,
}

impl Offer {
    /// Creates an Offer and reserves the Backer's entry.
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        backer: Key,
        game: Key,
        entry: u64,
        player_share_bps: u16,
        kind: OfferKind,
        now: i64,
        account: &mut Account,
        holdings: &mut [Holding],
    ) -> CoreResult<Self> {
        if !is_ladder_entry(entry) {
            return Err(CoreError::InvalidEntry);
        }
        if player_share_bps as u128 > BPS {
            return Err(CoreError::InvalidBps);
        }
        let expires_at = now.checked_add(BACKING_TTL_SECS).ok_or(CoreError::Math)?;
        let lines = reserve(account, holdings, entry)?;
        Ok(Self {
            backer,
            game,
            entry,
            player_share_bps,
            kind,
            status: OfferStatus::Open,
            expires_at,
            use_by: expires_at,
            player: None,
            request: None,
            applicants: Vec::new(),
            lines,
        })
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

    fn accept(&mut self, request: &mut Request, request_key: Key, now: i64) -> CoreResult<()> {
        self.use_by = now.checked_add(BACKING_TTL_SECS).ok_or(CoreError::Math)?;
        self.player = Some(request.player);
        self.request = Some(request_key);
        self.status = OfferStatus::Accepted;
        request.status = RequestStatus::Accepted;
        Ok(())
    }

    /// The Player accepts an Offer directed at their Request.
    pub fn accept_directed(
        &mut self,
        request: &mut Request,
        request_key: Key,
        now: i64,
    ) -> CoreResult<()> {
        self.open_live(now)?;
        if self.kind != OfferKind::Directed(request_key) {
            return Err(CoreError::NotApplicant);
        }
        self.check_request(request, now)?;
        self.accept(request, request_key, now)
    }

    /// A Player applies to a public Offer with their Request.
    pub fn apply(&mut self, request: &Request, request_key: Key, now: i64) -> CoreResult<()> {
        self.open_live(now)?;
        if self.kind != OfferKind::Public {
            return Err(CoreError::InvalidStatus);
        }
        self.check_request(request, now)?;
        if self.applicants.contains(&request_key) {
            return Err(CoreError::AlreadyApplied);
        }
        if self.applicants.len() >= MAX_APPLICANTS {
            return Err(CoreError::TooManyApplicants);
        }
        self.applicants.push(request_key);
        Ok(())
    }

    /// The Backer accepts one applicant of a public Offer.
    pub fn accept_applicant(
        &mut self,
        request: &mut Request,
        request_key: Key,
        now: i64,
    ) -> CoreResult<()> {
        self.open_live(now)?;
        if self.kind != OfferKind::Public || !self.applicants.contains(&request_key) {
            return Err(CoreError::NotApplicant);
        }
        self.check_request(request, now)?;
        self.accept(request, request_key, now)
    }

    /// The Backer withdraws the Offer before it is used; the reservation is released.
    /// Not possible once a Match has started with it (`Consumed`).
    pub fn cancel(&mut self, account: &mut Account, holdings: &mut [Holding]) -> CoreResult<()> {
        if !matches!(self.status, OfferStatus::Open | OfferStatus::Accepted) {
            return Err(CoreError::InvalidStatus);
        }
        release(account, holdings, &self.lines)?;
        self.status = OfferStatus::Cancelled;
        Ok(())
    }

    /// Anyone releases the reservation of an Offer nobody accepted, or nobody used, in time.
    pub fn expire(
        &mut self,
        now: i64,
        account: &mut Account,
        holdings: &mut [Holding],
    ) -> CoreResult<()> {
        let deadline = match self.status {
            OfferStatus::Open => self.expires_at,
            OfferStatus::Accepted => self.use_by,
            _ => return Err(CoreError::InvalidStatus),
        };
        if now < deadline {
            return Err(CoreError::NotExpired);
        }
        release(account, holdings, &self.lines)?;
        self.status = OfferStatus::Expired;
        Ok(())
    }

    /// The accepted Player enters a Match with the Backer's reservation. Returns the Side.
    pub fn consume(
        &mut self,
        player: Key,
        game: Key,
        entry: u64,
        now: i64,
        backer_account: &mut Account,
        backer_holdings: &mut [Holding],
    ) -> CoreResult<Side> {
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
        let lines = consume_reservation(backer_account, backer_holdings, &self.lines)?;
        self.status = OfferStatus::Consumed;
        Ok(Side {
            player,
            funder: self.backer,
            share_bps: self.player_share_bps,
            lines,
        })
    }
}

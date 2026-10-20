//! The entry draw, Entry Tickets and Offer reservations (spec "Ledger: basket").
//!
//! Pure Rust over [`LineStore`] baskets and [`SourceBook`]s: no accounts, no clock, no syscalls.
//! The instruction layer (ticket 09) supplies the account bytes, the Source books and the time.
//!
//! # The rules in one page
//!
//! * **Draw order.** A basket is sorted (side, `due_at`, ...), so its order *is* the draw order:
//!   own lines first, then won lines by earliest `due_at`. Fee-class lines and empty lines are
//!   skipped. The program picks the lines; nobody can choose which of their Gemas an entry uses.
//! * **Free Gemas.** `free = playable total - reserved_total - ticket_need`. The Offer
//!   reservation is an *amount* held by the slowest Gemas (the tail of the draw order), so an
//!   entry, which takes from the front, can use every free Gema and never touches the tail.
//!   A player whose free Gemas cover an entry can always enter: the draw takes the first
//!   `entry` Gemas of the order, and `free >= entry` is the only condition.
//! * **Direct draw** when the entry needs at most `max_lines` lines; otherwise an **Entry
//!   Ticket**. The Ticket moves the next lines of the order into its paged storage, `stage` by
//!   `stage`; while it is open the basket allows no other draw, no Offer reservation, and
//!   withdrawals must leave what the Ticket still needs. `consume` checks that no drawable
//!   playable basket line sorts before the Ticket's last staged line, then hands over the
//!   pages, which become that side's Pot pages. Faster Gemas that arrived meanwhile are staged
//!   in by `stage` (it returns the slowest staged lines to the basket first).
//! * **Cancel / expiry** put the lines back exactly, in chunks anyone may continue; a line that
//!   does not fit a full basket goes to the Ticket's own overflow record, claimable later.
//! * **Backing.** An Offer reserves an amount. When the backed Match opens, the Backer's lines
//!   are drawn by the same order (direct, or through a permissionless Backing Ticket); the
//!   reservation shrinks by exactly what was drawn.
//!
//! Lines move whole without touching a Source's book (a line is valid wherever it lies); only a
//! split line, or a merge into an existing line, goes through [`SourceBook::transfer`], which
//! brings both lines up to date and moves the ready part proportionally.

use std::collections::BTreeMap;

use super::book::checkpoint::{CheckpointStore, NoCheckpoints};
use super::book::{BookError, SourceBook};
use super::line_store::{
    required_len, Line, LineKey, LineStore, LineStoreError, CLASS_GENERAL, FLAG_TICKET_OPEN,
    HEADER_LEN, LINE_LEN,
};
use super::Key;

/// Lines in one Ticket / Pot page: as many as fit the 10,240-byte limit of creating an account
/// from a program, so a layout change of the line record resizes pages by itself.
pub const PAGE_LINES: usize = (10_240 - HEADER_LEN) / LINE_LEN;
/// Lines one transaction may move (draw or stage). Ticket 09 replaces this with the measured cap.
pub const MAX_DRAW_LINES: usize = 12;
/// Open Offers one Account may have.
pub const MAX_OPEN_OFFERS: u32 = 8;
/// Time an unconsumed Ticket has before anyone may cancel it.
pub const TICKET_WINDOW_SECS: i64 = 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrawError {
    /// The free Gemas do not cover the amount.
    InsufficientGemas,
    /// A Ticket is open: no other draw, reservation or second Ticket.
    TicketOpen,
    /// The Ticket is not open (consumed, cancelling, or none).
    NotOpen,
    /// Ticket does not belong to this basket, Game or entry size.
    Mismatch,
    /// Only the owner stages an Entry Ticket.
    NotOwner,
    /// The Ticket's storage rent was not reserved yet.
    StorageNotReserved,
    /// The Ticket has no room for another line.
    TicketStorageFull,
    /// The entry is not fully staged yet.
    NotComplete,
    /// A playable line sorts before the Ticket's last staged line: stage again.
    FasterGemasAvailable,
    /// The entry needs more lines than one transaction moves.
    NeedsTicket,
    /// Returning a staged line needs a free basket slot and there is none: grow the basket.
    BasketFull,
    /// The overflow record has no room (its rent was sized for the lines the draw can use).
    OverflowFull,
    /// Too many open Offers.
    TooManyOffers,
    /// Releasing or drawing more than is reserved.
    ReservationShort,
    /// The withdrawal would eat Gemas an open Ticket or an Offer reservation holds.
    WouldBreakReservation,
    /// Cancelling needs the owner, or the Ticket's deadline to have passed.
    NotExpired,
    ZeroAmount,
    Book(BookError),
    Store(LineStoreError),
}

impl From<BookError> for DrawError {
    fn from(e: BookError) -> Self {
        DrawError::Book(e)
    }
}

impl From<LineStoreError> for DrawError {
    fn from(e: LineStoreError) -> Self {
        DrawError::Store(e)
    }
}

pub type DrawResult<T> = Result<T, DrawError>;

/// Mutable bytes of a basket, Ticket page or overflow record body.
pub trait Bytes: AsRef<[u8]> + AsMut<[u8]> {}
impl<T: AsRef<[u8]> + AsMut<[u8]>> Bytes for T {}

/// The books of the Sources a transaction supplies. A draw needs a book only to split a line or
/// to merge into an existing one.
pub trait SourceBooks {
    fn book_mut(&mut self, source: &Key) -> DrawResult<&mut SourceBook>;

    /// The Source's book and the closed-segment records its lines may need to catch up (a draw
    /// only reads them: a transfer never closes a segment). The records of every Source whose
    /// line a transaction splits or merges must be supplied with it.
    fn book_with_history(
        &mut self,
        source: &Key,
    ) -> DrawResult<(&mut SourceBook, &dyn CheckpointStore)>;
}

/// Books without any history: lines of such a book can only be touched in the segment they were
/// last brought up to date in (enough for classes that never rotate).
impl SourceBooks for BTreeMap<Key, SourceBook> {
    fn book_mut(&mut self, source: &Key) -> DrawResult<&mut SourceBook> {
        self.get_mut(source)
            .ok_or(DrawError::Book(BookError::NoSuchClass))
    }

    fn book_with_history(
        &mut self,
        source: &Key,
    ) -> DrawResult<(&mut SourceBook, &dyn CheckpointStore)> {
        Ok((self.book_mut(source)?, &NoCheckpoints))
    }
}

// ---------------------------------------------------------------------------------------------
// Free Gemas, withdrawals, Offer reservations
// ---------------------------------------------------------------------------------------------

/// Playable Gemas in the basket (own + won; fee classes never count).
pub fn playable_total<B: AsRef<[u8]>>(b: &LineStore<B>) -> u64 {
    b.own_total().saturating_add(b.won_total())
}

/// Gemas an entry may draw now: playable, minus Offer reservations, minus what an open Entry
/// Ticket still needs.
pub fn free_gemas<B: AsRef<[u8]>>(b: &LineStore<B>) -> u64 {
    playable_total(b)
        .saturating_sub(b.reserved_total())
        .saturating_sub(b.ticket_need())
}

pub fn ticket_is_open<B: AsRef<[u8]>>(b: &LineStore<B>) -> bool {
    b.flags() & FLAG_TICKET_OPEN != 0
}

/// May `k` Gemas leave the basket (Redeem, `return_own`, Instant Redeem order, any withdrawal)?
/// They must leave the Offer reservations and an open Ticket's remaining need whole, so a Redeem
/// can never double-spend them.
pub fn check_withdraw<B: AsRef<[u8]>>(b: &LineStore<B>, k: u64) -> DrawResult<()> {
    if k == 0 {
        return Err(DrawError::ZeroAmount);
    }
    if k > free_gemas(b) {
        return Err(DrawError::WouldBreakReservation);
    }
    Ok(())
}

/// Reserve `amount` for a new Offer. Refused while a Ticket is open (a reservation made after
/// staging could hide faster Gemas from the draw).
pub fn reserve_offer<B: Bytes>(
    b: &mut LineStore<B>,
    amount: u64,
    open_offers: u32,
) -> DrawResult<()> {
    if amount == 0 {
        return Err(DrawError::ZeroAmount);
    }
    if ticket_is_open(b) {
        return Err(DrawError::TicketOpen);
    }
    if open_offers >= MAX_OPEN_OFFERS {
        return Err(DrawError::TooManyOffers);
    }
    if amount > free_gemas(b) {
        return Err(DrawError::InsufficientGemas);
    }
    let r = b
        .reserved_total()
        .checked_add(amount)
        .ok_or(DrawError::InsufficientGemas)?;
    b.set_reserved_total(r);
    Ok(())
}

/// Release `amount` of reservation (Offer cancelled, expired or declined). Always works.
pub fn release_offer<B: Bytes>(b: &mut LineStore<B>, amount: u64) -> DrawResult<()> {
    let r = b
        .reserved_total()
        .checked_sub(amount)
        .ok_or(DrawError::ReservationShort)?;
    b.set_reserved_total(r);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Pages: Ticket storage that becomes the Pot
// ---------------------------------------------------------------------------------------------

/// A side's lines in paged storage, ascending by key and dense. A Ticket's pages become the
/// side's Pot pages without copying a line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PotPages {
    pages: Vec<Vec<u8>>,
    owner: Key,
}

impl PotPages {
    pub fn new(owner: Key) -> PotPages {
        PotPages {
            pages: Vec::new(),
            owner,
        }
    }

    fn page(&self, i: usize) -> DrawResult<LineStore<&[u8]>> {
        Ok(LineStore::new(self.pages[i].as_slice())?)
    }

    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    pub fn len(&self) -> usize {
        self.pages
            .iter()
            .map(|p| LineStore::new(p.as_slice()).map_or(0, |s| s.len()))
            .sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Total Gemas.
    pub fn total(&self) -> u64 {
        self.pages
            .iter()
            .filter_map(|p| LineStore::new(p.as_slice()).ok())
            .map(|s| s.own_total() + s.won_total() + s.fee_total())
            .sum()
    }

    pub fn lines(&self) -> Vec<Line> {
        self.pages
            .iter()
            .filter_map(|p| LineStore::new(p.as_slice()).ok())
            .flat_map(|s| s.lines().collect::<Vec<_>>())
            .collect()
    }

    pub fn last_line(&self) -> Option<Line> {
        let p = self.pages.last()?;
        let s = LineStore::new(p.as_slice()).ok()?;
        s.get(s.len().checked_sub(1)?)
    }

    /// Append a line whose key is above every line so far.
    pub fn push(&mut self, line: &Line) -> DrawResult<()> {
        if self
            .last_line()
            .is_some_and(|l| l.key() >= line.key() || line.amount == 0)
        {
            return Err(DrawError::Store(LineStoreError::Unsorted));
        }
        let need_page = match self.pages.last() {
            None => true,
            Some(p) => {
                let s = LineStore::new(p.as_slice())?;
                s.len() == s.capacity()
            }
        };
        if need_page {
            self.pages.push(fresh_body(self.owner, PAGE_LINES)?);
        }
        let at = self.pages.len() - 1;
        let mut s = LineStore::new(self.pages[at].as_mut_slice())?;
        s.insert(line)?;
        Ok(())
    }

    /// Remove and return the last (slowest) line.
    pub fn pop_last(&mut self) -> DrawResult<Option<Line>> {
        let Some(at) = self.pages.len().checked_sub(1) else {
            return Ok(None);
        };
        let mut s = LineStore::new(self.pages[at].as_mut_slice())?;
        let n = s.len();
        let line = if n == 0 {
            None
        } else {
            Some(s.remove_at(n - 1)?)
        };
        if s.is_empty() {
            self.pages.pop();
        }
        Ok(line)
    }

    /// Integrity: every page valid, keys ascending across pages, pages dense.
    pub fn check(&self) -> DrawResult<()> {
        let mut prev: Option<LineKey> = None;
        for i in 0..self.pages.len() {
            let s = self.page(i)?;
            s.check()?;
            if s.is_empty() || (i + 1 < self.pages.len() && s.len() != s.capacity()) {
                return Err(DrawError::Store(LineStoreError::BadStore));
            }
            for l in s.lines() {
                if prev.is_some_and(|p| p >= l.key()) {
                    return Err(DrawError::Store(LineStoreError::Unsorted));
                }
                prev = Some(l.key());
            }
        }
        Ok(())
    }
}

fn fresh_body(owner: Key, capacity: usize) -> DrawResult<Vec<u8>> {
    let mut body = vec![0u8; required_len(capacity)];
    LineStore::init(body.as_mut_slice(), owner, 0)?;
    Ok(body)
}

// ---------------------------------------------------------------------------------------------
// Overflow record
// ---------------------------------------------------------------------------------------------

/// Lines that did not fit a full basket, claimable by the owner. Its rent is reserved before
/// anything is debited, sized to the lines it can ever receive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overflow {
    body: Vec<u8>,
}

impl Overflow {
    pub fn new(owner: Key, capacity: usize) -> DrawResult<Overflow> {
        Ok(Overflow {
            body: fresh_body(owner, capacity)?,
        })
    }

    fn grow(&mut self, capacity: usize) -> DrawResult<()> {
        if capacity > self.store()?.capacity() {
            self.body.resize(required_len(capacity), 0);
        }
        Ok(())
    }

    pub fn store(&self) -> DrawResult<LineStore<&[u8]>> {
        Ok(LineStore::new(self.body.as_slice())?)
    }

    pub fn len(&self) -> usize {
        self.store().map_or(0, |s| s.len())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn total(&self) -> u64 {
        self.store()
            .map_or(0, |s| s.own_total() + s.won_total() + s.fee_total())
    }

    pub fn lines(&self) -> Vec<Line> {
        self.store().map_or(Vec::new(), |s| s.lines().collect())
    }

    /// Put a line in, merging into one with the same key.
    pub fn credit(&mut self, books: &mut dyn SourceBooks, line: &Line) -> DrawResult<()> {
        let mut s = LineStore::new(self.body.as_mut_slice())?;
        if put_line(&mut s, books, line)? {
            Ok(())
        } else {
            Err(DrawError::OverflowFull)
        }
    }

    /// Move lines (the first ones, up to `max`) into the basket while it has room or a line to
    /// merge into. Returns how many moved.
    pub fn claim<B: Bytes>(
        &mut self,
        basket: &mut LineStore<B>,
        books: &mut dyn SourceBooks,
        max: usize,
    ) -> DrawResult<usize> {
        let mut moved = 0;
        while moved < max {
            let mut s = LineStore::new(self.body.as_mut_slice())?;
            let Some(line) = s.get(0) else { break };
            if !put_line(basket, books, &line)? {
                break;
            }
            s.remove_at(0)?;
            moved += 1;
        }
        Ok(moved)
    }
}

/// Place `line` in `dst`: merge into the line with the same key (through the Source's book) or
/// insert it. `Ok(false)` when there is no room; nothing changed then.
fn put_line<B: Bytes>(
    dst: &mut LineStore<B>,
    books: &mut dyn SourceBooks,
    line: &Line,
) -> DrawResult<bool> {
    match dst.find(&line.key()) {
        Ok(idx) => {
            let mut d = dst
                .get(idx)
                .ok_or(DrawError::Store(LineStoreError::NotFound))?;
            let mut s = *line;
            let (book, history) = books.book_with_history(&line.source)?;
            book.transfer(&mut s, &mut d, line.amount, history)?;
            dst.set_line(idx, &d)?;
            Ok(true)
        }
        Err(_) => {
            if dst.len() >= dst.capacity() {
                return Ok(false);
            }
            dst.insert(line)?;
            Ok(true)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------------------------

fn first_playable<B: AsRef<[u8]>>(b: &LineStore<B>) -> Option<(usize, Line)> {
    (0..b.len()).find_map(|i| {
        let l = b.get(i)?;
        (l.class >= CLASS_GENERAL && l.amount > 0).then_some((i, l))
    })
}

/// Move up to `cap` Gemas off the front of the order into a returned line (whole, or split).
fn take_front<B: Bytes>(
    b: &mut LineStore<B>,
    books: &mut dyn SourceBooks,
    cap: u64,
) -> DrawResult<Line> {
    let (idx, line) = first_playable(b).ok_or(DrawError::InsufficientGemas)?;
    let take = line.amount.min(cap);
    if take == 0 {
        return Err(DrawError::ZeroAmount);
    }
    if take == line.amount {
        b.remove_at(idx)?;
        return Ok(line);
    }
    let mut part = SourceBook::blank_line(
        line.side,
        line.due_at,
        line.source,
        line.class,
        line.tranche,
    );
    let mut rest = line;
    let (book, history) = books.book_with_history(&line.source)?;
    book.transfer(&mut rest, &mut part, take, history)?;
    b.set_line(idx, &rest)?;
    Ok(part)
}

/// The lines (and amounts taken from each) the draw of `amount` would use now, for the entry
/// preview and to decide direct draw versus Ticket. `limit` is the Gemas the draw may reach.
pub fn plan_draw<B: AsRef<[u8]>>(
    b: &LineStore<B>,
    amount: u64,
    limit: u64,
) -> DrawResult<Vec<(LineKey, u64)>> {
    if amount == 0 {
        return Err(DrawError::ZeroAmount);
    }
    if amount > limit {
        return Err(DrawError::InsufficientGemas);
    }
    let mut out = Vec::new();
    let mut left = amount;
    for l in b.lines() {
        if l.class < CLASS_GENERAL || l.amount == 0 {
            continue;
        }
        let t = l.amount.min(left);
        out.push((l.key(), t));
        left -= t;
        if left == 0 {
            break;
        }
    }
    Ok(out)
}

/// Draw an entry in one transaction. Fails with [`DrawError::NeedsTicket`] when it needs more
/// than `max_lines` lines; nothing changes then.
pub fn draw_direct<B: Bytes>(
    b: &mut LineStore<B>,
    books: &mut dyn SourceBooks,
    owner: Key,
    amount: u64,
    max_lines: usize,
) -> DrawResult<PotPages> {
    if ticket_is_open(b) {
        return Err(DrawError::TicketOpen);
    }
    let plan = plan_draw(b, amount, free_gemas(b))?;
    if plan.len() > max_lines {
        return Err(DrawError::NeedsTicket);
    }
    let mut pot = PotPages::new(owner);
    let mut left = amount;
    while left > 0 {
        let l = take_front(b, books, left)?;
        left -= l.amount;
        pot.push(&l)?;
    }
    Ok(pot)
}

/// Draw a Backer's reserved amount when the backed Match opens (direct). The reservation shrinks
/// by what is drawn. The draw may use the Gemas the Offer itself reserved, but never another
/// Offer's.
pub fn draw_backing_direct<B: Bytes>(
    b: &mut LineStore<B>,
    books: &mut dyn SourceBooks,
    owner: Key,
    amount: u64,
    max_lines: usize,
) -> DrawResult<PotPages> {
    if ticket_is_open(b) {
        return Err(DrawError::TicketOpen);
    }
    let reserved = b.reserved_total();
    if amount == 0 {
        return Err(DrawError::ZeroAmount);
    }
    if amount > reserved {
        return Err(DrawError::ReservationShort);
    }
    let limit = playable_total(b).saturating_sub(reserved - amount);
    let plan = plan_draw(b, amount, limit)?;
    if plan.len() > max_lines {
        return Err(DrawError::NeedsTicket);
    }
    let mut pot = PotPages::new(owner);
    let mut left = amount;
    while left > 0 {
        let l = take_front(b, books, left)?;
        left -= l.amount;
        pot.push(&l)?;
    }
    b.set_reserved_total(reserved - amount);
    Ok(pot)
}

// ---------------------------------------------------------------------------------------------
// Entry Tickets
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketKind {
    /// The Player's own entry: only the owner stages.
    Entry,
    /// A Backer's accepted Offer: anyone stages; the program fixes order and destination.
    Backing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketState {
    Open,
    /// One-way: lines are being returned in chunks.
    Cancelling,
    /// Consumed into a Match.
    Closed,
    /// Cancelled and every line returned.
    Cancelled,
}

/// What one `stage` call did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StageStep {
    pub pulled: usize,
    pub returned: usize,
    pub staged: u64,
    /// Fully staged and nothing faster waits: `consume` will pass.
    pub ready: bool,
}

/// What one cancel chunk did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CancelStep {
    pub lines_to_basket: usize,
    pub lines_to_overflow: usize,
    pub gemas_to_overflow: u64,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    pub account: Key,
    pub game: Key,
    pub nonce: u64,
    pub kind: TicketKind,
    pub state: TicketState,
    /// Entry size, or the Backing's amount.
    pub target: u64,
    pub expires_at: i64,
    /// The sponsor (or Player) paid for the paged storage and the overflow record.
    pub storage_reserved: bool,
    /// Most lines the reserved storage holds.
    pub line_cap: usize,
    /// Backing only: reservation not yet staged.
    pub reserved_left: u64,
    /// Backing only: reservation that could not come back (a returned line went to overflow).
    pub reservation_lost: u64,
    pub pages: PotPages,
    pub overflow: Overflow,
}

impl Ticket {
    fn begin<B: Bytes>(
        b: &mut LineStore<B>,
        kind: TicketKind,
        game: Key,
        nonce: u64,
        target: u64,
        expires_at: i64,
    ) -> DrawResult<Ticket> {
        let account = b.account();
        // storage for every line the draw can use, one split on each side, and a restage margin
        let line_cap = b.len().saturating_add(2);
        Ok(Ticket {
            account,
            game,
            nonce,
            kind,
            state: TicketState::Open,
            target,
            expires_at,
            storage_reserved: false,
            line_cap,
            reserved_left: 0,
            reservation_lost: 0,
            pages: PotPages::new(account),
            overflow: Overflow::new(account, line_cap)?,
        })
    }

    /// Open an Entry Ticket. The only condition is that the free Gemas cover the entry.
    pub fn open_entry<B: Bytes>(
        b: &mut LineStore<B>,
        game: Key,
        nonce: u64,
        entry: u64,
        expires_at: i64,
    ) -> DrawResult<Ticket> {
        if entry == 0 {
            return Err(DrawError::ZeroAmount);
        }
        if ticket_is_open(b) {
            return Err(DrawError::TicketOpen);
        }
        if entry > free_gemas(b) {
            return Err(DrawError::InsufficientGemas);
        }
        let t = Self::begin(b, TicketKind::Entry, game, nonce, entry, expires_at)?;
        b.set_flags(b.flags() | FLAG_TICKET_OPEN);
        b.set_ticket_need(entry);
        Ok(t)
    }

    /// Open a Backing Ticket for an accepted Offer of `amount` (already reserved).
    pub fn open_backing<B: Bytes>(
        b: &mut LineStore<B>,
        game: Key,
        nonce: u64,
        amount: u64,
        expires_at: i64,
    ) -> DrawResult<Ticket> {
        if amount == 0 {
            return Err(DrawError::ZeroAmount);
        }
        if ticket_is_open(b) {
            return Err(DrawError::TicketOpen);
        }
        if amount > b.reserved_total() {
            return Err(DrawError::ReservationShort);
        }
        let mut t = Self::begin(b, TicketKind::Backing, game, nonce, amount, expires_at)?;
        t.reserved_left = amount;
        b.set_flags(b.flags() | FLAG_TICKET_OPEN);
        Ok(t)
    }

    /// Lines the Ticket's paged storage and its overflow record are sized for.
    pub fn storage_lines(&self) -> usize {
        self.line_cap
    }

    /// The Player (or sponsor) paid rent for `extra` more lines of paged storage and overflow.
    pub fn grow_storage(&mut self, extra: usize) -> DrawResult<()> {
        self.line_cap = self.line_cap.saturating_add(extra);
        self.overflow.grow(self.line_cap)
    }

    /// The storage rent is reserved: staging may start.
    pub fn mark_storage_reserved(&mut self) {
        self.storage_reserved = true;
    }

    pub fn staged(&self) -> u64 {
        self.pages.total()
    }

    fn hold<B: AsRef<[u8]>>(&self, b: &LineStore<B>) -> u64 {
        match self.kind {
            TicketKind::Entry => b.reserved_total(),
            TicketKind::Backing => b.reserved_total().saturating_sub(self.reserved_left),
        }
    }

    /// Gemas this Ticket may still pull from the basket now.
    fn limit<B: AsRef<[u8]>>(&self, b: &LineStore<B>) -> u64 {
        playable_total(b).saturating_sub(self.hold(b))
    }

    /// Does a drawable basket line sort before the Ticket's last staged line?
    pub fn faster_waiting<B: AsRef<[u8]>>(&self, b: &LineStore<B>) -> bool {
        let Some(last) = self.pages.last_line() else {
            return false;
        };
        self.limit(b) > 0 && first_playable(b).is_some_and(|(_, f)| f.key() < last.key())
    }

    fn sync_header<B: Bytes>(&self, b: &mut LineStore<B>) {
        if self.kind == TicketKind::Entry {
            let need = if self.state == TicketState::Open {
                self.target.saturating_sub(self.staged())
            } else {
                0
            };
            b.set_ticket_need(need);
        }
    }

    /// Stage up to `max_ops` lines (each pull or return counts one). Pulls the next lines of the
    /// draw order into the Ticket; if faster Gemas arrived since, first returns the slowest
    /// staged lines to the basket so the Ticket is again a prefix of the order.
    pub fn stage<B: Bytes>(
        &mut self,
        b: &mut LineStore<B>,
        books: &mut dyn SourceBooks,
        max_ops: usize,
        signer_is_owner: bool,
    ) -> DrawResult<StageStep> {
        if self.state != TicketState::Open {
            return Err(DrawError::NotOpen);
        }
        if self.account != b.account() {
            return Err(DrawError::Mismatch);
        }
        if self.kind == TicketKind::Entry && !signer_is_owner {
            return Err(DrawError::NotOwner);
        }
        if !self.storage_reserved {
            return Err(DrawError::StorageNotReserved);
        }
        let mut step = StageStep::default();
        while step.pulled + step.returned < max_ops {
            if self.faster_waiting(b) {
                self.return_tail(b, books)?;
                step.returned += 1;
                continue;
            }
            let staged = self.staged();
            if staged >= self.target {
                break;
            }
            let cap = (self.target - staged).min(self.limit(b));
            if cap == 0 {
                return Err(DrawError::InsufficientGemas);
            }
            if self.pages.len() >= self.line_cap {
                return Err(DrawError::TicketStorageFull);
            }
            let mut line = take_front(b, books, cap)?;
            let pulled = line.amount;
            if let Some(mut last) = self.pages.last_line().filter(|l| l.key() == line.key()) {
                // the basket still held part of the line the Ticket ended on: join them
                let (book, history) = books.book_with_history(&line.source)?;
                book.transfer(&mut line, &mut last, pulled, history)?;
                self.pages.pop_last()?;
                line = last;
            }
            self.pages.push(&line)?;
            if self.kind == TicketKind::Backing {
                let r = b
                    .reserved_total()
                    .checked_sub(pulled)
                    .ok_or(DrawError::ReservationShort)?;
                b.set_reserved_total(r);
                self.reserved_left = self
                    .reserved_left
                    .checked_sub(pulled)
                    .ok_or(DrawError::ReservationShort)?;
            }
            step.pulled += 1;
            self.sync_header(b);
        }
        self.sync_header(b);
        step.staged = self.staged();
        step.ready = step.staged == self.target && !self.faster_waiting(b);
        Ok(step)
    }

    /// Put the slowest staged line back in the basket. Needs a slot (or a line to merge into).
    fn return_tail<B: Bytes>(
        &mut self,
        b: &mut LineStore<B>,
        books: &mut dyn SourceBooks,
    ) -> DrawResult<()> {
        let line = self.pages.last_line().ok_or(DrawError::NotComplete)?;
        if !put_line(b, books, &line)? {
            return Err(DrawError::BasketFull);
        }
        self.pages.pop_last()?;
        if self.kind == TicketKind::Backing {
            let r = b
                .reserved_total()
                .checked_add(line.amount)
                .ok_or(DrawError::ReservationShort)?;
            b.set_reserved_total(r);
            self.reserved_left = self
                .reserved_left
                .checked_add(line.amount)
                .ok_or(DrawError::ReservationShort)?;
        }
        self.sync_header(b);
        Ok(())
    }

    /// `open_match` / `join_match`: consume the complete Ticket. Its pages become the Pot pages.
    pub fn consume<B: Bytes>(
        &mut self,
        b: &mut LineStore<B>,
        game: &Key,
        entry: u64,
    ) -> DrawResult<PotPages> {
        if self.state != TicketState::Open {
            return Err(DrawError::NotOpen);
        }
        if self.account != b.account() || &self.game != game || self.target != entry {
            return Err(DrawError::Mismatch);
        }
        if self.staged() != self.target {
            return Err(DrawError::NotComplete);
        }
        if self.faster_waiting(b) {
            return Err(DrawError::FasterGemasAvailable);
        }
        self.state = TicketState::Closed;
        b.set_flags(b.flags() & !FLAG_TICKET_OPEN);
        b.set_ticket_need(0);
        Ok(core::mem::replace(
            &mut self.pages,
            PotPages::new(self.account),
        ))
    }

    /// Start cancelling: the owner at any time, anyone once the deadline passed. One-way.
    pub fn begin_cancel<B: Bytes>(
        &mut self,
        b: &mut LineStore<B>,
        now: i64,
        by_owner: bool,
    ) -> DrawResult<()> {
        if self.state == TicketState::Cancelling {
            return Ok(());
        }
        if self.state != TicketState::Open {
            return Err(DrawError::NotOpen);
        }
        if !by_owner && now < self.expires_at {
            return Err(DrawError::NotExpired);
        }
        self.state = TicketState::Cancelling;
        self.sync_header(b);
        Ok(())
    }

    /// Return up to `max_lines` staged lines, slowest first. A line goes back to the basket, or
    /// to the Ticket's overflow record when the basket is full. Idempotent: calling it with
    /// nothing left reports `done`.
    pub fn cancel_step<B: Bytes>(
        &mut self,
        b: &mut LineStore<B>,
        books: &mut dyn SourceBooks,
        max_lines: usize,
    ) -> DrawResult<CancelStep> {
        if self.state == TicketState::Cancelled {
            return Ok(CancelStep {
                done: true,
                ..CancelStep::default()
            });
        }
        if self.state != TicketState::Cancelling {
            return Err(DrawError::NotOpen);
        }
        let mut step = CancelStep::default();
        while step.lines_to_basket + step.lines_to_overflow < max_lines {
            let Some(line) = self.pages.last_line() else {
                break;
            };
            if put_line(b, books, &line)? {
                step.lines_to_basket += 1;
                if self.kind == TicketKind::Backing {
                    let r = b
                        .reserved_total()
                        .checked_add(line.amount)
                        .ok_or(DrawError::ReservationShort)?;
                    b.set_reserved_total(r);
                }
            } else {
                self.overflow.credit(books, &line)?;
                step.lines_to_overflow += 1;
                step.gemas_to_overflow = step.gemas_to_overflow.saturating_add(line.amount);
                if self.kind == TicketKind::Backing {
                    self.reservation_lost = self.reservation_lost.saturating_add(line.amount);
                }
            }
            self.pages.pop_last()?;
        }
        if self.pages.is_empty() {
            self.state = TicketState::Cancelled;
            b.set_flags(b.flags() & !FLAG_TICKET_OPEN);
            b.set_ticket_need(0);
            step.done = true;
        }
        Ok(step)
    }
}

#[cfg(test)]
mod tests;

//! The entry draw, Entry Tickets and Offer reservations (spec "Ledger: basket").
//!
//! Pure Rust over [`LineStore`] baskets and [`SourceBook`]s: no accounts, no clock, no syscalls.
//! The instruction layer (ticket 09) supplies the account bytes, the Source books and the time.
//!
//! # The rules in one page
//!
//! * **A Player's Gemas live in a [`Pool`]**: the basket plus its **spill**, a second sorted
//!   line store (one per Account) that takes every line that does not fit a full basket
//!   (settle, refund, Ticket return, claim). The draw order is the merged order of both, so a
//!   Gema in the spill is as free, and as drawable, as one in the basket. *Nothing has to be
//!   claimed before it can be played*: a full basket can never stop an entry.
//! * **Draw order.** Own lines first, then won lines by earliest `due_at`; fee-class and empty
//!   lines are skipped. The program picks the lines; nobody chooses which of their Gemas an
//!   entry uses.
//! * **Free Gemas.** `free = pool playable total - reserved_total - ticket_need`. The Offer
//!   reservation is an *amount* held by the slowest Gemas (the tail of the order), so an entry,
//!   which takes from the front, never touches it. A Player whose free Gemas cover an entry can
//!   always enter: the only condition is `free >= entry`.
//! * **Direct draw** when the entry needs at most `max_lines` lines; otherwise an **Entry
//!   Ticket**. The Ticket moves the next lines of the order into its paged storage, `stage` by
//!   `stage`; while it is open there is no other entry, no Offer reservation, and withdrawals
//!   must leave what it still needs. `consume` checks that no drawable playable line sorts
//!   before the Ticket's last staged line, then hands over the pages, which become that side's
//!   Pot pages. Faster Gemas that arrived meanwhile are staged in (`stage` returns the slowest
//!   staged lines first).
//! * **Cancel / expiry** put the lines back exactly, in chunks anyone may continue.
//! * **Backing.** An Offer reserves an amount. When the backed Match opens, the Backer's lines
//!   are drawn by the same order (direct, or through a Backing Ticket). A Backing Ticket has its
//!   own flag and never blocks the Backer's own entries: it only holds back new Offers until it
//!   finishes. Only the Backer can cancel it at once; anyone can once it expires.
//!
//! # Room
//!
//! A line that fits neither the basket nor the spill makes the operation fail with
//! [`DrawError::SpillFull`], changing nothing. The instruction layer grows the spill (sponsored,
//! refundable) and retries. The slots to reserve are bounded: a Ticket needs `storage_lines()`
//! (it reserves them before staging), a credit needs one per line it adds
//! ([`spill_slots_for_credit`]). So settle, refund, restage and cancel never strand a Player.
//!
//! Lines move whole without touching a Source's book; only a split line, or a merge into an
//! existing line, goes through [`SourceBook::transfer`], which brings both lines up to date and
//! moves the ready part proportionally.

use std::collections::BTreeMap;

use super::book::{BookError, SourceBook};
use super::line_store::{
    required_len, Line, LineKey, LineStore, LineStoreError, CLASS_GENERAL, FLAG_BACKING_OPEN,
    FLAG_TICKET_OPEN, HEADER_LEN, LINE_LEN,
};
use super::Key;

/// Lines in one Ticket / Pot page: as many as fit the 10,240-byte limit of creating an account
/// from a program, so a layout change of the line record resizes pages by itself.
pub const PAGE_LINES: usize = (10_240 - HEADER_LEN) / LINE_LEN;
/// Lines one transaction may move (draw or stage). Ticket 09 replaces this with the measured cap.
pub const MAX_DRAW_LINES: usize = 12;
/// Open Offers one Account may have.
pub const MAX_OPEN_OFFERS: u32 = 8;
/// Time an unconsumed Entry Ticket has before anyone may cancel it.
pub const TICKET_WINDOW_SECS: i64 = 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrawError {
    /// The free Gemas do not cover the amount.
    InsufficientGemas,
    /// A Ticket of this kind is open: no second one, and no Offer reservation.
    TicketOpen,
    /// The Ticket is not open (consumed, cancelling, or none).
    NotOpen,
    /// Ticket does not belong to this basket, Game or entry size.
    Mismatch,
    /// Only the owner stages an Entry Ticket.
    NotOwner,
    /// The Ticket's storage rent was not reserved yet.
    StorageNotReserved,
    /// The Ticket has no room for another line: grow its storage.
    TicketStorageFull,
    /// The entry is not fully staged yet.
    NotComplete,
    /// A playable line sorts before the Ticket's last staged line: stage again.
    FasterGemasAvailable,
    /// The entry needs more lines than one transaction moves.
    NeedsTicket,
    /// Neither the basket nor the spill has a slot for a line. Nothing changed; grow the spill
    /// (reserved rent) and retry.
    SpillFull,
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

/// Mutable bytes of a basket, spill, Ticket page or Pot page body.
pub trait Bytes: AsRef<[u8]> + AsMut<[u8]> {}
impl<T: AsRef<[u8]> + AsMut<[u8]>> Bytes for T {}

/// The books of the Sources a transaction supplies. A draw needs a book only to split a line or
/// to merge into an existing one.
pub trait SourceBooks {
    fn book_mut(&mut self, source: &Key) -> DrawResult<&mut SourceBook>;
}

impl SourceBooks for BTreeMap<Key, SourceBook> {
    fn book_mut(&mut self, source: &Key) -> DrawResult<&mut SourceBook> {
        self.get_mut(source)
            .ok_or(DrawError::Book(BookError::NoSuchClass))
    }
}

/// A fresh spill body with room for `capacity` lines.
pub fn spill_body(owner: Key, capacity: usize) -> DrawResult<Vec<u8>> {
    fresh_body(owner, capacity)
}

/// Grow a spill body (the instruction layer's `realloc`, rent already reserved).
pub fn grow_spill_body(body: &mut Vec<u8>, capacity: usize) {
    if body.len() < required_len(capacity) {
        body.resize(required_len(capacity), 0);
    }
}

/// Slots a credit of `lines` lines can need in the spill: one each, in the worst case.
pub fn spill_slots_for_credit(lines: usize) -> usize {
    lines
}

fn fresh_body(owner: Key, capacity: usize) -> DrawResult<Vec<u8>> {
    let mut body = vec![0u8; required_len(capacity)];
    LineStore::init(body.as_mut_slice(), owner, 0)?;
    Ok(body)
}

// ---------------------------------------------------------------------------------------------
// The pool: basket + spill
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placed {
    Basket,
    Spill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Where {
    Basket,
    Spill,
}

/// An Account's Gemas: its basket and its spill. The Offer reservation and the open Ticket's
/// need live in the basket header and count against both.
pub struct Pool<'a, B: Bytes, S: Bytes> {
    pub basket: &'a mut LineStore<B>,
    pub spill: &'a mut LineStore<S>,
}

impl<'a, B: Bytes, S: Bytes> Pool<'a, B, S> {
    pub fn new(basket: &'a mut LineStore<B>, spill: &'a mut LineStore<S>) -> Self {
        Pool { basket, spill }
    }

    /// Playable Gemas in the basket and the spill (fee classes never count).
    pub fn playable_total(&self) -> u64 {
        [
            self.basket.own_total(),
            self.basket.won_total(),
            self.spill.own_total(),
            self.spill.won_total(),
        ]
        .iter()
        .fold(0u64, |a, v| a.saturating_add(*v))
    }

    /// Gemas an entry may draw now: playable, minus Offer reservations, minus what an open Entry
    /// Ticket still needs.
    pub fn free(&self) -> u64 {
        self.playable_total()
            .saturating_sub(self.basket.reserved_total())
            .saturating_sub(self.basket.ticket_need())
    }

    pub fn entry_ticket_open(&self) -> bool {
        self.basket.flags() & FLAG_TICKET_OPEN != 0
    }

    pub fn backing_ticket_open(&self) -> bool {
        self.basket.flags() & FLAG_BACKING_OPEN != 0
    }

    /// May `k` Gemas leave (Redeem, `return_own`, Instant Redeem order, any withdrawal)? They
    /// must leave the Offer reservations and an open Entry Ticket's remaining need whole, so a
    /// Redeem can never double-spend them.
    pub fn check_withdraw(&self, k: u64) -> DrawResult<()> {
        if k == 0 {
            return Err(DrawError::ZeroAmount);
        }
        if k > self.free() {
            return Err(DrawError::WouldBreakReservation);
        }
        Ok(())
    }

    /// Reserve `amount` for a new Offer. Refused while any Ticket is open (a reservation made
    /// after staging could hide faster Gemas from the draw).
    pub fn reserve_offer(&mut self, amount: u64, open_offers: u32) -> DrawResult<()> {
        if amount == 0 {
            return Err(DrawError::ZeroAmount);
        }
        if self.entry_ticket_open() || self.backing_ticket_open() {
            return Err(DrawError::TicketOpen);
        }
        if open_offers >= MAX_OPEN_OFFERS {
            return Err(DrawError::TooManyOffers);
        }
        if amount > self.free() {
            return Err(DrawError::InsufficientGemas);
        }
        let r = self
            .basket
            .reserved_total()
            .checked_add(amount)
            .ok_or(DrawError::InsufficientGemas)?;
        self.basket.set_reserved_total(r);
        Ok(())
    }

    /// Release `amount` of reservation (Offer cancelled, expired or declined). Always works.
    pub fn release_offer(&mut self, amount: u64) -> DrawResult<()> {
        let r = self
            .basket
            .reserved_total()
            .checked_sub(amount)
            .ok_or(DrawError::ReservationShort)?;
        self.basket.set_reserved_total(r);
        Ok(())
    }

    fn first_in<T: AsRef<[u8]>>(s: &LineStore<T>) -> Option<(usize, Line)> {
        (0..s.len()).find_map(|i| {
            let l = s.get(i)?;
            (l.class >= CLASS_GENERAL && l.amount > 0).then_some((i, l))
        })
    }

    /// The front of the draw order: the smaller key of the two stores' first playable lines.
    fn first_playable(&self) -> Option<(Where, usize, Line)> {
        match (Self::first_in(self.basket), Self::first_in(self.spill)) {
            (Some((i, a)), Some((j, b))) => Some(if b.key() < a.key() {
                (Where::Spill, j, b)
            } else {
                (Where::Basket, i, a)
            }),
            (Some((i, a)), None) => Some((Where::Basket, i, a)),
            (None, Some((j, b))) => Some((Where::Spill, j, b)),
            (None, None) => None,
        }
    }

    /// Move up to `cap` Gemas off the front of the order into a returned line (whole, or split).
    fn take_front(&mut self, books: &mut dyn SourceBooks, cap: u64) -> DrawResult<Line> {
        let (at, idx, line) = self.first_playable().ok_or(DrawError::InsufficientGemas)?;
        let take = line.amount.min(cap);
        if take == 0 {
            return Err(DrawError::ZeroAmount);
        }
        if take == line.amount {
            match at {
                Where::Basket => self.basket.remove_at(idx)?,
                Where::Spill => self.spill.remove_at(idx)?,
            };
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
        books
            .book_mut(&line.source)?
            .transfer(&mut rest, &mut part, take)?;
        match at {
            Where::Basket => self.basket.set_line(idx, &rest)?,
            Where::Spill => self.spill.set_line(idx, &rest)?,
        }
        Ok(part)
    }

    /// Put a line back or credit it: merge into the basket line with the same key, else insert
    /// into the basket if it has room, else merge into / insert in the spill. `SpillFull` (and
    /// nothing changed) when there is no room anywhere.
    pub fn put(&mut self, books: &mut dyn SourceBooks, line: &Line) -> DrawResult<Placed> {
        if self.basket.find(&line.key()).is_ok() || self.basket.len() < self.basket.capacity() {
            put_line(self.basket, books, line)?;
            return Ok(Placed::Basket);
        }
        if put_line(self.spill, books, line)? {
            Ok(Placed::Spill)
        } else {
            Err(DrawError::SpillFull)
        }
    }

    /// Move up to `max` lines from the spill into the basket while it has room or a line to merge
    /// into (the Wallet's tidy-up; never needed to play). Returns how many moved.
    pub fn claim(&mut self, books: &mut dyn SourceBooks, max: usize) -> DrawResult<usize> {
        let mut moved = 0;
        while moved < max {
            let Some(line) = self.spill.get(0) else { break };
            if !put_line(self.basket, books, &line)? {
                break;
            }
            self.spill.remove_at(0)?;
            moved += 1;
        }
        Ok(moved)
    }

    /// The lines (and amounts taken from each) the draw of `amount` would use now, in the merged
    /// order, for the entry preview and to decide direct draw versus Ticket.
    pub fn plan_draw(&self, amount: u64, limit: u64) -> DrawResult<Vec<(LineKey, u64)>> {
        if amount == 0 {
            return Err(DrawError::ZeroAmount);
        }
        if amount > limit {
            return Err(DrawError::InsufficientGemas);
        }
        let mut a = self.basket.lines().peekable();
        let mut b = self.spill.lines().peekable();
        let mut out = Vec::new();
        let mut left = amount;
        while left > 0 {
            let next = match (a.peek(), b.peek()) {
                (Some(x), Some(y)) if y.key() < x.key() => b.next(),
                (Some(_), _) => a.next(),
                (None, Some(_)) => b.next(),
                (None, None) => break,
            };
            let Some(l) = next else { break };
            if l.class < CLASS_GENERAL || l.amount == 0 {
                continue;
            }
            let t = l.amount.min(left);
            out.push((l.key(), t));
            left -= t;
        }
        Ok(out)
    }

    /// Draw an entry in one transaction. Fails with [`DrawError::NeedsTicket`] when it needs
    /// more than `max_lines` lines; nothing changes then.
    pub fn draw_direct(
        &mut self,
        books: &mut dyn SourceBooks,
        owner: Key,
        amount: u64,
        max_lines: usize,
    ) -> DrawResult<PotPages> {
        if self.entry_ticket_open() {
            return Err(DrawError::TicketOpen);
        }
        let plan = self.plan_draw(amount, self.free())?;
        if plan.len() > max_lines {
            return Err(DrawError::NeedsTicket);
        }
        let mut pot = PotPages::new(owner);
        let mut left = amount;
        while left > 0 {
            let l = self.take_front(books, left)?;
            left -= l.amount;
            pot.push_joined(books, l)?;
        }
        Ok(pot)
    }

    /// Draw a Backer's reserved amount when the backed Match opens (direct). The reservation
    /// shrinks by what is drawn. The draw may use the Gemas the Offer itself reserved, never
    /// another Offer's.
    pub fn draw_backing_direct(
        &mut self,
        books: &mut dyn SourceBooks,
        owner: Key,
        amount: u64,
        max_lines: usize,
    ) -> DrawResult<PotPages> {
        if self.backing_ticket_open() {
            return Err(DrawError::TicketOpen);
        }
        let reserved = self.basket.reserved_total();
        if amount == 0 {
            return Err(DrawError::ZeroAmount);
        }
        if amount > reserved {
            return Err(DrawError::ReservationShort);
        }
        let limit = self.playable_total().saturating_sub(reserved - amount);
        let plan = self.plan_draw(amount, limit)?;
        if plan.len() > max_lines {
            return Err(DrawError::NeedsTicket);
        }
        let mut pot = PotPages::new(owner);
        let mut left = amount;
        while left > 0 {
            let l = self.take_front(books, left)?;
            left -= l.amount;
            pot.push_joined(books, l)?;
        }
        self.basket.set_reserved_total(reserved - amount);
        Ok(pot)
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
            books
                .book_mut(&line.source)?
                .transfer(&mut s, &mut d, line.amount)?;
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
            .map(|s| {
                s.own_total()
                    .saturating_add(s.won_total())
                    .saturating_add(s.fee_total())
            })
            .fold(0u64, |a, v| a.saturating_add(v))
    }

    pub fn lines(&self) -> Vec<Line> {
        self.pages
            .iter()
            .filter_map(|p| LineStore::new(p.as_slice()).ok())
            .flat_map(|s| s.lines().collect::<Vec<_>>())
            .collect()
    }

    /// The line at position `i` (pages are dense, so `i` maps to a page and a slot).
    pub fn get(&self, i: usize) -> Option<Line> {
        let page = self.pages.get(i / PAGE_LINES)?;
        LineStore::new(page.as_slice()).ok()?.get(i % PAGE_LINES)
    }

    /// Overwrite the line at position `i` with an updated copy of the same key (settlement
    /// shrinks lines in place; an emptied line keeps its slot so positions never move).
    pub fn set(&mut self, i: usize, line: &Line) -> DrawResult<()> {
        let page = self
            .pages
            .get_mut(i / PAGE_LINES)
            .ok_or(DrawError::Store(LineStoreError::NotFound))?;
        let mut s = LineStore::new(page.as_mut_slice())?;
        s.set_line(i % PAGE_LINES, line)?;
        Ok(())
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

    /// Append a line; if the last line has the same key (the pool held that line in two places,
    /// or part of the line the Ticket ended on), join them through the Source's book.
    pub fn push_joined(&mut self, books: &mut dyn SourceBooks, mut line: Line) -> DrawResult<()> {
        if let Some(mut last) = self.last_line().filter(|l| l.key() == line.key()) {
            let k = line.amount;
            books
                .book_mut(&line.source)?
                .transfer(&mut line, &mut last, k)?;
            self.pop_last()?;
            line = last;
        }
        self.push(&line)
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

// ---------------------------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketKind {
    /// The Player's own entry: only the owner stages.
    Entry,
    /// A Backer's accepted Offer: anyone stages; the program fixes order and destination. Only
    /// the Requester's signed Match open (the Offer it accepted) may open one, so a stranger
    /// cannot start one; the Backer can cancel it at once.
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
    pub lines_to_spill: usize,
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
    /// The sponsor (or Player) paid for the paged storage and the spill slots a return can need.
    pub storage_reserved: bool,
    /// Most lines the reserved storage holds; also the most spill slots a cancel or restage of
    /// this Ticket can need.
    pub line_cap: usize,
    /// Backing only: reservation not yet staged.
    pub reserved_left: u64,
    pub pages: PotPages,
}

impl Ticket {
    fn begin<B: Bytes, S: Bytes>(
        pool: &Pool<B, S>,
        kind: TicketKind,
        game: Key,
        nonce: u64,
        target: u64,
        expires_at: i64,
    ) -> Ticket {
        let account = pool.basket.account();
        let lines = pool.basket.len().saturating_add(pool.spill.len());
        Ticket {
            account,
            game,
            nonce,
            kind,
            state: TicketState::Open,
            target,
            expires_at,
            storage_reserved: false,
            line_cap: lines.saturating_add(2),
            reserved_left: 0,
            pages: PotPages::new(account),
        }
    }

    /// Open an Entry Ticket. The only condition is that the free Gemas cover the entry.
    pub fn open_entry<B: Bytes, S: Bytes>(
        pool: &mut Pool<B, S>,
        game: Key,
        nonce: u64,
        entry: u64,
        expires_at: i64,
    ) -> DrawResult<Ticket> {
        if entry == 0 {
            return Err(DrawError::ZeroAmount);
        }
        if pool.entry_ticket_open() {
            return Err(DrawError::TicketOpen);
        }
        if entry > pool.free() {
            return Err(DrawError::InsufficientGemas);
        }
        let t = Self::begin(pool, TicketKind::Entry, game, nonce, entry, expires_at);
        pool.basket
            .set_flags(pool.basket.flags() | FLAG_TICKET_OPEN);
        pool.basket.set_ticket_need(entry);
        Ok(t)
    }

    /// Open a Backing Ticket for an accepted Offer of `amount` (already reserved). It uses its
    /// own flag: the Backer's entries are not affected.
    pub fn open_backing<B: Bytes, S: Bytes>(
        pool: &mut Pool<B, S>,
        game: Key,
        nonce: u64,
        amount: u64,
        expires_at: i64,
    ) -> DrawResult<Ticket> {
        if amount == 0 {
            return Err(DrawError::ZeroAmount);
        }
        if pool.backing_ticket_open() {
            return Err(DrawError::TicketOpen);
        }
        if amount > pool.basket.reserved_total() {
            return Err(DrawError::ReservationShort);
        }
        let mut t = Self::begin(pool, TicketKind::Backing, game, nonce, amount, expires_at);
        t.reserved_left = amount;
        pool.basket
            .set_flags(pool.basket.flags() | FLAG_BACKING_OPEN);
        Ok(t)
    }

    fn flag(&self) -> u8 {
        match self.kind {
            TicketKind::Entry => FLAG_TICKET_OPEN,
            TicketKind::Backing => FLAG_BACKING_OPEN,
        }
    }

    /// Lines the Ticket's paged storage is sized for, and the most spill slots it can need.
    pub fn storage_lines(&self) -> usize {
        self.line_cap
    }

    /// The Player (or sponsor) paid rent for `extra` more lines of paged storage and spill room.
    pub fn grow_storage(&mut self, extra: usize) {
        self.line_cap = self.line_cap.saturating_add(extra);
    }

    /// The storage rent is reserved: staging may start.
    pub fn mark_storage_reserved(&mut self) {
        self.storage_reserved = true;
    }

    pub fn staged(&self) -> u64 {
        self.pages.total()
    }

    fn hold<B: Bytes, S: Bytes>(&self, pool: &Pool<B, S>) -> u64 {
        match self.kind {
            TicketKind::Entry => pool.basket.reserved_total(),
            TicketKind::Backing => pool
                .basket
                .reserved_total()
                .saturating_sub(self.reserved_left),
        }
    }

    /// Gemas this Ticket may still pull from the pool now.
    fn limit<B: Bytes, S: Bytes>(&self, pool: &Pool<B, S>) -> u64 {
        pool.playable_total().saturating_sub(self.hold(pool))
    }

    /// Does a drawable line sort before the Ticket's last staged line?
    pub fn faster_waiting<B: Bytes, S: Bytes>(&self, pool: &Pool<B, S>) -> bool {
        let Some(last) = self.pages.last_line() else {
            return false;
        };
        self.limit(pool) > 0
            && pool
                .first_playable()
                .is_some_and(|(_, _, f)| f.key() < last.key())
    }

    fn sync_header<B: Bytes, S: Bytes>(&self, pool: &mut Pool<B, S>) {
        if self.kind == TicketKind::Entry {
            let need = if self.state == TicketState::Open {
                self.target.saturating_sub(self.staged())
            } else {
                0
            };
            pool.basket.set_ticket_need(need);
        }
    }

    /// Stage up to `max_ops` lines (each pull or return counts one). Pulls the next lines of the
    /// draw order into the Ticket; if faster Gemas arrived since, first returns the slowest
    /// staged lines so the Ticket is again a prefix of the order. A returned line always has
    /// room (basket, else spill); `SpillFull` only if the reserved spill slots were not granted.
    pub fn stage<B: Bytes, S: Bytes>(
        &mut self,
        pool: &mut Pool<B, S>,
        books: &mut dyn SourceBooks,
        max_ops: usize,
        signer_is_owner: bool,
    ) -> DrawResult<StageStep> {
        if self.state != TicketState::Open {
            return Err(DrawError::NotOpen);
        }
        if self.account != pool.basket.account() {
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
            if self.faster_waiting(pool) {
                self.return_tail(pool, books)?;
                step.returned += 1;
                continue;
            }
            let staged = self.staged();
            if staged >= self.target {
                break;
            }
            let cap = (self.target - staged).min(self.limit(pool));
            if cap == 0 {
                return Err(DrawError::InsufficientGemas);
            }
            if self.pages.len() >= self.line_cap {
                return Err(DrawError::TicketStorageFull);
            }
            let line = pool.take_front(books, cap)?;
            let pulled = line.amount;
            self.pages.push_joined(books, line)?;
            if self.kind == TicketKind::Backing {
                let r = pool
                    .basket
                    .reserved_total()
                    .checked_sub(pulled)
                    .ok_or(DrawError::ReservationShort)?;
                pool.basket.set_reserved_total(r);
                self.reserved_left = self
                    .reserved_left
                    .checked_sub(pulled)
                    .ok_or(DrawError::ReservationShort)?;
            }
            step.pulled += 1;
            self.sync_header(pool);
        }
        self.sync_header(pool);
        step.staged = self.staged();
        step.ready = step.staged == self.target && !self.faster_waiting(pool);
        Ok(step)
    }

    /// Put the slowest staged line back in the pool.
    fn return_tail<B: Bytes, S: Bytes>(
        &mut self,
        pool: &mut Pool<B, S>,
        books: &mut dyn SourceBooks,
    ) -> DrawResult<()> {
        let line = self.pages.last_line().ok_or(DrawError::NotComplete)?;
        pool.put(books, &line)?;
        self.pages.pop_last()?;
        if self.kind == TicketKind::Backing {
            let r = pool
                .basket
                .reserved_total()
                .checked_add(line.amount)
                .ok_or(DrawError::ReservationShort)?;
            pool.basket.set_reserved_total(r);
            self.reserved_left = self
                .reserved_left
                .checked_add(line.amount)
                .ok_or(DrawError::ReservationShort)?;
        }
        self.sync_header(pool);
        Ok(())
    }

    /// `open_match` / `join_match`: consume the complete Ticket. Its pages become the Pot pages.
    pub fn consume<B: Bytes, S: Bytes>(
        &mut self,
        pool: &mut Pool<B, S>,
        game: &Key,
        entry: u64,
    ) -> DrawResult<PotPages> {
        if self.state != TicketState::Open {
            return Err(DrawError::NotOpen);
        }
        if self.account != pool.basket.account() || &self.game != game || self.target != entry {
            return Err(DrawError::Mismatch);
        }
        if self.staged() != self.target {
            return Err(DrawError::NotComplete);
        }
        if self.faster_waiting(pool) {
            return Err(DrawError::FasterGemasAvailable);
        }
        self.state = TicketState::Closed;
        pool.basket.set_flags(pool.basket.flags() & !self.flag());
        if self.kind == TicketKind::Entry {
            pool.basket.set_ticket_need(0);
        }
        Ok(core::mem::replace(
            &mut self.pages,
            PotPages::new(self.account),
        ))
    }

    /// Start cancelling: the owner at any time, anyone once the deadline passed. One-way.
    pub fn begin_cancel<B: Bytes, S: Bytes>(
        &mut self,
        pool: &mut Pool<B, S>,
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
        self.sync_header(pool);
        Ok(())
    }

    /// Return up to `max_lines` staged lines, slowest first, to the basket or the spill.
    /// Idempotent: calling it with nothing left reports `done`.
    pub fn cancel_step<B: Bytes, S: Bytes>(
        &mut self,
        pool: &mut Pool<B, S>,
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
        while step.lines_to_basket + step.lines_to_spill < max_lines {
            let Some(line) = self.pages.last_line() else {
                break;
            };
            match pool.put(books, &line)? {
                Placed::Basket => step.lines_to_basket += 1,
                Placed::Spill => step.lines_to_spill += 1,
            }
            if self.kind == TicketKind::Backing {
                let r = pool
                    .basket
                    .reserved_total()
                    .checked_add(line.amount)
                    .ok_or(DrawError::ReservationShort)?;
                pool.basket.set_reserved_total(r);
            }
            self.pages.pop_last()?;
        }
        if self.pages.is_empty() {
            self.state = TicketState::Cancelled;
            pool.basket.set_flags(pool.basket.flags() & !self.flag());
            if self.kind == TicketKind::Entry {
                pool.basket.set_ticket_need(0);
            }
            step.done = true;
        }
        Ok(step)
    }
}

#[cfg(test)]
mod tests;

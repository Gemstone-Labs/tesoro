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
//! [`DrawError::SpillFull`], changing nothing; the instruction layer makes room (a store grows)
//! and retries. Two rules keep that away from the Player:
//!
//! * **A whole line that leaves the pool frees a slot, and the slot is held for it.** The
//!   instruction layer adds [`Pool::freed`] to the holder's share and to `room_reserved` in the
//!   spill header; lines put back with [`Pool::set_hold`] use the share first (each new slot pays
//!   it and the header down). So a Ticket's cancel and restage, and a Match's refund, always find
//!   their slot, however full the stores are.
//! * **A plain credit may only use free slots beyond the held ones** (`free_slots > room_reserved`),
//!   so nobody else's credit can take them.
//!
//! A line split off a bigger one frees no slot, and needs none as long as the rest stays in the
//! pool: its key is there and the line merges back. If a later entry takes that rest whole, the
//! slot is *that* entry's hold, and both return the same key: the part that returns first finds
//! no hold and waits for room (or for its sibling) like any credit. A credit that brings a new key
//! (a win, a fee line) needs a slot of its own: [`spill_slots_for_credit`] bounds it, and the
//! instruction layer holds it where it can.
//!
//! Lines move whole without touching a Source's book; only a split line, or a merge into an
//! existing line, goes through [`SourceBook::transfer`], which brings both lines up to date and
//! moves the ready part proportionally.

use std::collections::BTreeMap;

use super::book::checkpoint::CheckpointStore;
use super::book::{BookError, SourceBook};
use super::line_store::{
    required_len, Line, LineKey, LineStore, LineStoreError, CLASS_GENERAL, FLAG_BACKING_OPEN,
    FLAG_TICKET_OPEN, HEADER_LEN, LINE_LEN,
};
use super::Key;

/// Lines in one Ticket / Pot page: as many as fit the 10,240-byte limit of creating an account
/// from a program, so a layout change of the line record resizes pages by itself.
pub const PAGE_LINES: usize = (10_240 - HEADER_LEN) / LINE_LEN;
/// Lines one transaction may move in the pure tests. The program's measured caps are
/// `instructions::matching::MAX_DIRECT_LINES` and `instructions::ticket::MAX_STAGE_OPS`.
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

/// The books of the Sources a transaction supplies, each with the closed-segment records its lines
/// may need to catch up (and room for new ones). A draw needs a book only to split a line or to
/// merge into an existing one; settlement also lands yield and cuts fees.
pub trait SourceBooks {
    fn book_mut(&mut self, source: &Key) -> DrawResult<&mut SourceBook>;

    /// The Source's book and its history. The records of every Source whose line a transaction
    /// edits must be supplied with it.
    fn book_with_history(
        &mut self,
        source: &Key,
    ) -> DrawResult<(&mut SourceBook, &mut dyn CheckpointStore)>;

    /// Remember the Source's book as it is, so a step that fails half way can undo what it did to
    /// it (`rollback`). Closed-segment records already written are not undone: writing a record
    /// is idempotent, so the retry writes the same one. The default does nothing, for books that
    /// only exist inside one step.
    fn snapshot(&mut self, _source: &Key) -> DrawResult<()> {
        Ok(())
    }

    /// Put the Source's book back as `snapshot` left it.
    fn rollback(&mut self, _source: &Key) -> DrawResult<()> {
        Ok(())
    }
}

/// Source books with their histories in memory (tests and off-chain code).
#[cfg(not(target_os = "solana"))]
#[derive(Default, Clone)]
pub struct MemBooks {
    pub map: BTreeMap<Key, SourceBook>,
    pub ck: BTreeMap<Key, super::book::checkpoint::MemCheckpoints>,
    saved: Option<(Key, SourceBook)>,
}

#[cfg(not(target_os = "solana"))]
impl MemBooks {
    pub fn insert(&mut self, source: Key, book: SourceBook) {
        self.map.insert(source, book);
        self.ck
            .insert(source, super::book::checkpoint::MemCheckpoints::new(source));
    }

    /// `SourceBook::issue` with this Source's history.
    pub fn issue(&mut self, source: &Key, line: &mut Line, k: u64) -> Result<(), BookError> {
        let ck = &self.ck[source];
        self.map.get_mut(source).expect("book").issue(line, k, ck)
    }

    /// `SourceBook::land` with this Source's history.
    pub fn land(&mut self, source: &Key, cum: u128, shares: u128) -> Result<(), BookError> {
        let ck = self.ck.get_mut(source).expect("history");
        self.map
            .get_mut(source)
            .expect("book")
            .land(cum, shares, ck)
            .map(drop)
    }
}

#[cfg(not(target_os = "solana"))]
impl core::ops::Deref for MemBooks {
    type Target = BTreeMap<Key, SourceBook>;
    fn deref(&self) -> &Self::Target {
        &self.map
    }
}

#[cfg(not(target_os = "solana"))]
impl core::ops::DerefMut for MemBooks {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.map
    }
}

#[cfg(not(target_os = "solana"))]
impl SourceBooks for MemBooks {
    fn book_mut(&mut self, source: &Key) -> DrawResult<&mut SourceBook> {
        self.map
            .get_mut(source)
            .ok_or(DrawError::Book(BookError::NoSuchClass))
    }

    fn book_with_history(
        &mut self,
        source: &Key,
    ) -> DrawResult<(&mut SourceBook, &mut dyn CheckpointStore)> {
        let book = self
            .map
            .get_mut(source)
            .ok_or(DrawError::Book(BookError::NoSuchClass))?;
        let ck = self
            .ck
            .get_mut(source)
            .ok_or(DrawError::Book(BookError::NoSuchClass))?;
        Ok((book, ck))
    }

    fn snapshot(&mut self, source: &Key) -> DrawResult<()> {
        let book = self
            .map
            .get(source)
            .ok_or(DrawError::Book(BookError::NoSuchClass))?;
        self.saved = Some((*source, book.clone()));
        Ok(())
    }

    fn rollback(&mut self, source: &Key) -> DrawResult<()> {
        match self.saved.take() {
            Some((k, book)) if k == *source => {
                self.map.insert(k, book);
                Ok(())
            }
            _ => Err(DrawError::Book(BookError::Corrupt(
                "rollback without snapshot",
            ))),
        }
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
    /// Slots of the spill header's `room_reserved` the caller may use for the lines it puts.
    hold_left: u32,
    /// Whole lines taken off the pool since `new`: each freed one slot.
    freed: u32,
    /// Lines `put` inserted into a new slot since `new`.
    used: u32,
}

impl<'a, B: Bytes, S: Bytes> Pool<'a, B, S> {
    pub fn new(basket: &'a mut LineStore<B>, spill: &'a mut LineStore<S>) -> Self {
        Pool {
            basket,
            spill,
            hold_left: 0,
            freed: 0,
            used: 0,
        }
    }

    /// Slots free in the basket and the spill together.
    pub fn free_slots(&self) -> usize {
        (self.basket.capacity() - self.basket.len()) + (self.spill.capacity() - self.spill.len())
    }

    /// Slots in `room_reserved` that no hold-user may take: free slots beyond them are the only
    /// ones a plain credit can use.
    pub fn held_slots(&self) -> usize {
        self.spill.room_reserved() as usize
    }

    /// Declare how many of the held slots the lines `put` next may use (the holder's own share of
    /// `room_reserved`). Every new slot such a line takes pays the hold, and the header, down.
    pub fn set_hold(&mut self, slots: u32) {
        self.hold_left = slots;
    }

    /// The holder's slots not used yet.
    pub fn hold_left(&self) -> u32 {
        self.hold_left
    }

    /// Whole lines the draw has taken off the pool since `new`: the slots they freed are free to
    /// hold for the Pot or Ticket they went into.
    pub fn freed(&self) -> u32 {
        self.freed
    }

    /// Lines `put` placed in a new slot since `new` (a merge into a line needs none).
    pub fn used(&self) -> u32 {
        self.used
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
            self.freed += 1;
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
        book.transfer(&mut rest, &mut part, take, &*history)?;
        match at {
            Where::Basket => self.basket.set_line(idx, &rest)?,
            Where::Spill => self.spill.set_line(idx, &rest)?,
        }
        Ok(part)
    }

    /// Put a line back or credit it: merge into the basket line with the same key, else insert
    /// into the basket if it has room, else merge into / insert in the spill. `SpillFull` (and
    /// nothing changed) when there is no room anywhere. Each store is searched once.
    pub fn put(&mut self, books: &mut dyn SourceBooks, line: &Line) -> DrawResult<Placed> {
        let key = line.key();
        let found = self.basket.find(&key);
        if let Ok(idx) = found {
            merge_into(self.basket, idx, books, line)?;
            return Ok(Placed::Basket);
        }
        let spill_found = self.spill.find(&key);
        if let (Err(at), Err(_)) = (&found, &spill_found) {
            // a new slot: the holder's own, else a free one that is not held for someone
            let free = self.free_slots();
            let held = self.held_slots();
            let mine = self.hold_left > 0 && free > 0;
            if !mine && free <= held {
                return Err(DrawError::SpillFull);
            }
            let to_basket = self.basket.len() < self.basket.capacity();
            if to_basket {
                self.basket.insert_at(*at, line)?;
            } else if let Err(at) = spill_found {
                self.spill.insert_at(at, line)?;
            }
            if mine {
                self.hold_left -= 1;
                let held = self.spill.room_reserved();
                self.spill.set_room_reserved(held.saturating_sub(1));
            }
            self.used += 1;
            return Ok(if to_basket {
                Placed::Basket
            } else {
                Placed::Spill
            });
        }
        if let Ok(idx) = spill_found {
            merge_into(self.spill, idx, books, line)?;
        }
        Ok(Placed::Spill)
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
        let mut pot = PotPages::new(owner);
        self.draw_direct_into(books, &mut pot, amount, max_lines)?;
        Ok(pot)
    }

    /// [`Pool::draw_direct`] into a Pot that already exists (an account's store, on chain).
    /// Nothing changes in the pool when it fails before the first line moves; a failure after
    /// that (a full Pot) fails the whole instruction, which the caller does not catch.
    pub fn draw_direct_into<T: PotBacking>(
        &mut self,
        books: &mut dyn SourceBooks,
        pot: &mut PotPages<T>,
        amount: u64,
        max_lines: usize,
    ) -> DrawResult<()> {
        if self.entry_ticket_open() {
            return Err(DrawError::TicketOpen);
        }
        let plan = self.plan_draw(amount, self.free())?;
        if plan.len() > max_lines {
            return Err(DrawError::NeedsTicket);
        }
        let mut left = amount;
        while left > 0 {
            let l = self.take_front(books, left)?;
            left -= l.amount;
            pot.push_joined(books, l)?;
        }
        Ok(())
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
        let mut pot = PotPages::new(owner);
        self.draw_backing_direct_into(books, &mut pot, amount, max_lines)?;
        Ok(pot)
    }

    /// [`Pool::draw_backing_direct`] into an existing Pot.
    pub fn draw_backing_direct_into<T: PotBacking>(
        &mut self,
        books: &mut dyn SourceBooks,
        pot: &mut PotPages<T>,
        amount: u64,
        max_lines: usize,
    ) -> DrawResult<()> {
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
        let mut left = amount;
        while left > 0 {
            let l = self.take_front(books, left)?;
            left -= l.amount;
            pot.push_joined(books, l)?;
        }
        self.basket.set_reserved_total(reserved - amount);
        Ok(())
    }
}

/// Merge `line` into the line at `idx` of `dst` (the same key) through the Source's book.
fn merge_into<B: Bytes>(
    dst: &mut LineStore<B>,
    idx: usize,
    books: &mut dyn SourceBooks,
    line: &Line,
) -> DrawResult<()> {
    let mut d = dst
        .get(idx)
        .ok_or(DrawError::Store(LineStoreError::NotFound))?;
    let mut s = *line;
    let (book, history) = books.book_with_history(&line.source)?;
    book.transfer(&mut s, &mut d, line.amount, &*history)?;
    dst.set_line(idx, &d)?;
    Ok(())
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
            merge_into(dst, idx, books, line)?;
            Ok(true)
        }
        Err(at) => {
            if dst.len() >= dst.capacity() {
                return Ok(false);
            }
            dst.insert_at(at, line)?;
            Ok(true)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Pots: Ticket storage that becomes the Pot
// ---------------------------------------------------------------------------------------------

/// Bytes a Pot can live in. A `Vec<u8>` grows by itself (tests, off-chain code); an account's data
/// cannot, so a push into a full Pot account fails with [`DrawError::TicketStorageFull`] and the
/// instruction layer grows the account (reserved rent) first.
pub trait PotBacking: Bytes {
    /// Make the buffer at least `len` bytes long. `false` when it cannot grow.
    fn grow_to(&mut self, len: usize) -> bool;
}

impl PotBacking for Vec<u8> {
    fn grow_to(&mut self, len: usize) -> bool {
        if self.len() < len {
            self.resize(len, 0);
        }
        true
    }
}

/// A side's lines in one sorted store, ascending by key. A Ticket's store becomes the side's Pot
/// without copying a line: the same account is first the Ticket's staging area, then the Pot, so
/// open and join stay one bounded transaction whatever the number of lines.
///
/// (The spec calls this paged storage. One growable account does the same job: account data is
/// mapped into the program, not copied, so a 4,096-line Pot costs no more to reach one line of
/// than a 10-line one. Growing it takes the same +10 KB steps pages would.)
pub struct PotPages<B: PotBacking = Vec<u8>> {
    store: LineStore<B>,
    owner: Key,
}

impl<B: PotBacking + Clone> Clone for PotPages<B> {
    fn clone(&self) -> Self {
        PotPages {
            store: LineStore::new(self.store.bytes().clone()).expect("a valid pot stays valid"),
            owner: self.owner,
        }
    }
}

impl<B: PotBacking> core::fmt::Debug for PotPages<B> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "PotPages({} lines, {} Gemas)", self.len(), self.total())
    }
}

impl<B: PotBacking + Clone> Eq for PotPages<B> {}

impl<B: PotBacking + Clone> PartialEq for PotPages<B> {
    fn eq(&self, other: &Self) -> bool {
        self.owner == other.owner && self.lines() == other.lines()
    }
}

impl PotPages<Vec<u8>> {
    /// An empty in-memory Pot that grows as lines are pushed.
    pub fn new(owner: Key) -> PotPages {
        PotPages {
            store: LineStore::new(fresh_body(owner, 0).expect("an empty body is valid"))
                .expect("fresh body"),
            owner,
        }
    }
}

impl<B: PotBacking> PotPages<B> {
    /// Wrap bytes that already hold a Pot.
    pub fn open(bytes: B) -> DrawResult<PotPages<B>> {
        let store = LineStore::new(bytes)?;
        let owner = store.account();
        Ok(PotPages { store, owner })
    }

    /// Format `bytes` as an empty Pot for `owner` and wrap it.
    pub fn init(bytes: B, owner: Key, bump: u8) -> DrawResult<PotPages<B>> {
        Ok(PotPages {
            store: LineStore::init(bytes, owner, bump)?,
            owner,
        })
    }

    pub fn owner(&self) -> Key {
        self.owner
    }

    /// Lines the buffer holds now.
    pub fn capacity(&self) -> usize {
        self.store.capacity()
    }

    pub fn store(&self) -> &LineStore<B> {
        &self.store
    }

    /// The underlying buffer (an account's data, on chain).
    pub fn bytes_mut(&mut self) -> &mut B {
        self.store.bytes_mut()
    }

    pub fn len(&self) -> usize {
        self.store.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Total Gemas.
    pub fn total(&self) -> u64 {
        self.store
            .own_total()
            .saturating_add(self.store.won_total())
            .saturating_add(self.store.fee_total())
    }

    pub fn lines(&self) -> Vec<Line> {
        self.store.lines().collect()
    }

    pub fn get(&self, i: usize) -> Option<Line> {
        self.store.get(i)
    }

    /// Overwrite the line at position `i` with an updated copy of the same key (settlement
    /// shrinks lines in place; an emptied line keeps its slot so positions never move).
    pub fn set(&mut self, i: usize, line: &Line) -> DrawResult<()> {
        self.store.set_line(i, line)?;
        Ok(())
    }

    pub fn last_line(&self) -> Option<Line> {
        self.store.get(self.store.len().checked_sub(1)?)
    }

    /// Append a line whose key is above every line so far.
    pub fn push(&mut self, line: &Line) -> DrawResult<()> {
        if self
            .last_line()
            .is_some_and(|l| l.key() >= line.key() || line.amount == 0)
        {
            return Err(DrawError::Store(LineStoreError::Unsorted));
        }
        if self.store.len() == self.store.capacity() {
            let want = required_len(self.store.capacity() + PAGE_LINES);
            if !self.store.bytes_mut().grow_to(want) || self.store.len() == self.store.capacity() {
                return Err(DrawError::TicketStorageFull);
            }
        }
        self.store.insert(line)?;
        Ok(())
    }

    /// Append a line; if the last line has the same key (the pool held that line in two places,
    /// or part of the line the Ticket ended on), join them through the Source's book.
    pub fn push_joined(&mut self, books: &mut dyn SourceBooks, mut line: Line) -> DrawResult<()> {
        if let Some(mut last) = self.last_line().filter(|l| l.key() == line.key()) {
            let k = line.amount;
            let (book, history) = books.book_with_history(&line.source)?;
            book.transfer(&mut line, &mut last, k, &*history)?;
            self.pop_last()?;
            line = last;
        }
        self.push(&line)
    }

    /// Remove and return the last (slowest) line.
    pub fn pop_last(&mut self) -> DrawResult<Option<Line>> {
        let Some(n) = self.store.len().checked_sub(1) else {
            return Ok(None);
        };
        Ok(Some(self.store.remove_at(n)?))
    }

    /// Integrity: valid store, keys ascending, header totals equal the lines.
    pub fn check(&self) -> DrawResult<()> {
        self.store.check()?;
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

pub struct Ticket<T: PotBacking = Vec<u8>> {
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
    pub pages: PotPages<T>,
}

impl<T: PotBacking + Clone> Clone for Ticket<T> {
    fn clone(&self) -> Self {
        Ticket {
            account: self.account,
            game: self.game,
            nonce: self.nonce,
            kind: self.kind,
            state: self.state,
            target: self.target,
            expires_at: self.expires_at,
            storage_reserved: self.storage_reserved,
            line_cap: self.line_cap,
            reserved_left: self.reserved_left,
            pages: self.pages.clone(),
        }
    }
}

impl<T: PotBacking> core::fmt::Debug for Ticket<T> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "Ticket({:?} {:?} target {} staged {})",
            self.kind,
            self.state,
            self.target,
            self.pages.total()
        )
    }
}

impl Ticket<Vec<u8>> {
    /// Open an Entry Ticket with in-memory storage.
    pub fn open_entry<B: Bytes, S: Bytes>(
        pool: &mut Pool<B, S>,
        game: Key,
        nonce: u64,
        entry: u64,
        expires_at: i64,
    ) -> DrawResult<Ticket> {
        let pages = PotPages::new(pool.basket.account());
        Self::open_entry_in(pool, game, nonce, entry, expires_at, pages)
    }

    /// Open a Backing Ticket with in-memory storage.
    pub fn open_backing<B: Bytes, S: Bytes>(
        pool: &mut Pool<B, S>,
        game: Key,
        nonce: u64,
        amount: u64,
        expires_at: i64,
    ) -> DrawResult<Ticket> {
        let pages = PotPages::new(pool.basket.account());
        Self::open_backing_in(pool, game, nonce, amount, expires_at, pages)
    }
}

impl<T: PotBacking> Ticket<T> {
    fn begin<B: Bytes, S: Bytes>(
        pool: &Pool<B, S>,
        kind: TicketKind,
        game: Key,
        nonce: u64,
        target: u64,
        expires_at: i64,
        pages: PotPages<T>,
    ) -> Ticket<T> {
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
            pages,
        }
    }

    /// Open an Entry Ticket staging into `pages`. The only condition is that the free Gemas cover
    /// the entry.
    pub fn open_entry_in<B: Bytes, S: Bytes>(
        pool: &mut Pool<B, S>,
        game: Key,
        nonce: u64,
        entry: u64,
        expires_at: i64,
        pages: PotPages<T>,
    ) -> DrawResult<Ticket<T>> {
        if entry == 0 {
            return Err(DrawError::ZeroAmount);
        }
        if pool.entry_ticket_open() {
            return Err(DrawError::TicketOpen);
        }
        if entry > pool.free() {
            return Err(DrawError::InsufficientGemas);
        }
        let t = Self::begin(
            pool,
            TicketKind::Entry,
            game,
            nonce,
            entry,
            expires_at,
            pages,
        );
        pool.basket
            .set_flags(pool.basket.flags() | FLAG_TICKET_OPEN);
        pool.basket.set_ticket_need(entry);
        Ok(t)
    }

    /// Open a Backing Ticket for an accepted Offer of `amount` (already reserved), staging into
    /// `pages`. It uses its own flag: the Backer's entries are not affected.
    pub fn open_backing_in<B: Bytes, S: Bytes>(
        pool: &mut Pool<B, S>,
        game: Key,
        nonce: u64,
        amount: u64,
        expires_at: i64,
        pages: PotPages<T>,
    ) -> DrawResult<Ticket<T>> {
        if amount == 0 {
            return Err(DrawError::ZeroAmount);
        }
        if pool.backing_ticket_open() {
            return Err(DrawError::TicketOpen);
        }
        if amount > pool.basket.reserved_total() {
            return Err(DrawError::ReservationShort);
        }
        let mut t = Self::begin(
            pool,
            TicketKind::Backing,
            game,
            nonce,
            amount,
            expires_at,
            pages,
        );
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

    /// `open_match` / `join_match`: consume the complete Ticket. Its store becomes the Pot
    /// (`into_pot` hands it over; nothing is copied).
    pub fn consume<B: Bytes, S: Bytes>(
        &mut self,
        pool: &mut Pool<B, S>,
        game: &Key,
        entry: u64,
    ) -> DrawResult<()> {
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
        Ok(())
    }

    /// The staged lines, once the Ticket is consumed.
    pub fn into_pot(self) -> PotPages<T> {
        self.pages
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

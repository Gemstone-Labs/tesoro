//! `LineStore`: the sorted, growable line array behind an Account's basket (spec "Ledger: basket").
//!
//! This type only inserts, removes, finds and merges lines and keeps the header totals in step
//! with them. It knows nothing about money rules, Sources or yield: the exact bookkeeping
//! (ticket 03) reads a line, brings it up to date, and writes it back through `set_line` or
//! `merge`. Everything is plain byte (de)serialisation, so no alignment or `unsafe` is involved
//! and the same code decodes a basket on a client or inside a program.
//!
//! The store works on the account *body*: the bytes after Anchor's 8-byte discriminator. It never
//! reallocates; the instruction layer resizes the account (`required_len`, `shrinkable_len`) and
//! wraps the new slice again.
//!
//! Body layout (all integers little endian), `HEADER_LEN` = 128:
//!
//! | offset | field |
//! |---|---|
//! | 0 | `version` u8 (`BASKET_VERSION`) |
//! | 1 | `bump` u8 |
//! | 2 | `flags` u8 (bit 0 = an Entry Ticket is open, bit 1 = a Backing Ticket is open) |
//! | 4 | `len` u32, used lines |
//! | 8 | `account` [u8; 32] |
//! | 40 | `own_total` u64, sum of `amount` of playable own lines |
//! | 48 | `won_total` u64, same for won lines |
//! | 56 | `fee_total` u64, sum of `amount` of fee-class lines (never playable) |
//! | 64 | `reserved_total` u64 (Offer reservations, set by the caller) |
//! | 72 | `sponsored_lamports` u64 (sponsored rent, set by the caller) |
//! | 80 | `ticket_need` u64 (Gemas the open Entry Ticket still has to stage, set by the draw module) |
//! | 88 | 40 reserved bytes, zero |
//!
//! Lines follow, `LINE_LEN` = 96 bytes each, sorted ascending by [`LineKey`]:
//! (side, `due_at`, source, class, tranche). See [`Line`] for the line layout.

use super::Key;

pub const BASKET_VERSION: u8 = 2;
pub const HEADER_LEN: usize = 128;
pub const LINE_LEN: usize = 96;

pub const SIDE_OWN: u8 = 0;
pub const SIDE_WON: u8 = 1;

/// Classes, in payout order. Classes below `CLASS_GENERAL` are fee classes: never playable,
/// never reserved, counted in `fee_total` instead of `own_total`/`won_total`.
pub const CLASS_PLATFORM: u8 = 0;
pub const CLASS_STUDIO: u8 = 1;
pub const CLASS_LEADERBOARD: u8 = 2;
pub const CLASS_GENERAL: u8 = 3;
/// Extension `n` (1..) has class `CLASS_GENERAL + n` and tranche `n`.
pub const CLASS_EXTENSION_BASE: u8 = 4;

pub const FLAG_TICKET_OPEN: u8 = 1;
/// A Backing Ticket is open. Separate from the Entry Ticket so a Backer's own entries never wait
/// for a Backing.
pub const FLAG_BACKING_OPEN: u8 = 2;

const H_VERSION: usize = 0;
const H_BUMP: usize = 1;
const H_FLAGS: usize = 2;
const H_LEN: usize = 4;
const H_ACCOUNT: usize = 8;
const H_OWN: usize = 40;
const H_WON: usize = 48;
const H_FEE: usize = 56;
const H_RESERVED_TOTAL: usize = 64;
const H_SPONSORED: usize = 72;
const H_TICKET_NEED: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineStoreError {
    /// Data shorter than the header, wrong version, or `len` beyond the capacity.
    BadStore,
    /// A line with an invalid side, or reserved bytes that are not zero where they must be.
    BadLine,
    /// No free slot. The caller grows the account first.
    Full,
    Duplicate,
    NotFound,
    /// `set_line` was given a line whose key differs from the stored one.
    KeyChanged,
    /// `merge` into a line whose index snapshot differs from the incoming line's.
    NotMaterialised,
    Overflow,
    /// Lines out of order or duplicated: the store is corrupt.
    Unsorted,
}

/// The sort key. Field order is the sort order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct LineKey {
    pub side: u8,
    pub due_at: i64,
    pub source: Key,
    pub class: u8,
    pub tranche: u8,
}

/// One basket line, 96 bytes. Every field is needed; the exact bookkeeping (`ledger::book`) reads
/// and writes them:
///
/// | offset | field | why |
/// |---|---|---|
/// | 0 | `side` u8 | own / won, first in the sort key |
/// | 1 | `class` u8 | which pool of the Source the Gemas are in (payout order) |
/// | 2 | `tranche` u8 | Extension number, part of the key so a recipient's tranches stay apart |
/// | 3 | `due_at` i64 | earliest planned repayment, the draw's fast-first key |
/// | 11 | `source` [u8; 32] | which Source's book to ask |
/// | 43 | `amount` u64 | whole Gemas of the line |
/// | 51 | `uncovered` u128 | unpaid part as of the snapshot, Gemas x 2^64 |
/// | 67 | `p` u128 | class index at the snapshot |
/// | 83 | `scale` u32, 87 `epoch` u32 | rest of the snapshot |
/// | 91 | 5 reserved bytes | zero |
///
/// Ready is not stored: it is `amount * 2^64 - uncovered` once the line is brought up to date, and
/// the shares behind it are a share of the class pool (see `ledger::book`). The key fields come
/// first so a binary search reads 43 bytes per probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Line {
    pub side: u8,
    pub class: u8,
    pub tranche: u8,
    pub due_at: i64,
    pub source: Key,
    pub amount: u64,
    pub uncovered: u128,
    pub p: u128,
    pub scale: u32,
    pub epoch: u32,
    pub reserved: [u8; 5],
}

impl Line {
    pub fn key(&self) -> LineKey {
        LineKey {
            side: self.side,
            due_at: self.due_at,
            source: self.source,
            class: self.class,
            tranche: self.tranche,
        }
    }

    /// Fee-class lines can't be played, reserved or moved.
    pub fn is_playable(&self) -> bool {
        self.class >= CLASS_GENERAL
    }

    /// Both lines were brought up to date at the same (`p`, `scale`, `epoch`).
    pub fn same_index(&self, other: &Line) -> bool {
        self.p == other.p && self.scale == other.scale && self.epoch == other.epoch
    }

    pub fn encode(&self, out: &mut [u8]) {
        out[..LINE_LEN].fill(0);
        out[0] = self.side;
        out[1] = self.class;
        out[2] = self.tranche;
        out[3..11].copy_from_slice(&self.due_at.to_le_bytes());
        out[11..43].copy_from_slice(&self.source);
        out[43..51].copy_from_slice(&self.amount.to_le_bytes());
        out[51..67].copy_from_slice(&self.uncovered.to_le_bytes());
        out[67..83].copy_from_slice(&self.p.to_le_bytes());
        out[83..87].copy_from_slice(&self.scale.to_le_bytes());
        out[87..91].copy_from_slice(&self.epoch.to_le_bytes());
        out[91..96].copy_from_slice(&self.reserved);
    }

    pub fn decode(raw: &[u8]) -> Line {
        let mut source = [0u8; 32];
        source.copy_from_slice(&raw[11..43]);
        let mut reserved = [0u8; 5];
        reserved.copy_from_slice(&raw[91..96]);
        Line {
            side: raw[0],
            class: raw[1],
            tranche: raw[2],
            due_at: i64::from_le_bytes(arr(&raw[3..11])),
            source,
            amount: u64::from_le_bytes(arr(&raw[43..51])),
            uncovered: u128::from_le_bytes(arr(&raw[51..67])),
            p: u128::from_le_bytes(arr(&raw[67..83])),
            scale: u32::from_le_bytes(arr(&raw[83..87])),
            epoch: u32::from_le_bytes(arr(&raw[87..91])),
            reserved,
        }
    }

    fn decode_key(raw: &[u8]) -> LineKey {
        let mut source = [0u8; 32];
        source.copy_from_slice(&raw[11..43]);
        LineKey {
            side: raw[0],
            due_at: i64::from_le_bytes(arr(&raw[3..11])),
            source,
            class: raw[1],
            tranche: raw[2],
        }
    }
}

fn arr<const N: usize>(s: &[u8]) -> [u8; N] {
    let mut a = [0u8; N];
    a.copy_from_slice(s);
    a
}

/// Bytes a body needs to hold `lines` lines.
pub fn required_len(lines: usize) -> usize {
    HEADER_LEN + lines * LINE_LEN
}

/// The sorted line array over a body slice. `T` is `&[u8]` for reads, `&mut [u8]` for edits.
pub struct LineStore<T> {
    data: T,
}

impl<T: AsRef<[u8]>> LineStore<T> {
    /// Wrap an existing basket body. O(1): checks the version and that `len` fits.
    pub fn new(data: T) -> Result<Self, LineStoreError> {
        let raw = data.as_ref();
        if raw.len() < HEADER_LEN || raw[H_VERSION] != BASKET_VERSION {
            return Err(LineStoreError::BadStore);
        }
        let store = LineStore { data };
        if store.len() > store.capacity() {
            return Err(LineStoreError::BadStore);
        }
        Ok(store)
    }

    fn raw(&self) -> &[u8] {
        self.data.as_ref()
    }

    fn u64_at(&self, at: usize) -> u64 {
        u64::from_le_bytes(arr(&self.raw()[at..at + 8]))
    }

    pub fn version(&self) -> u8 {
        self.raw()[H_VERSION]
    }
    pub fn bump(&self) -> u8 {
        self.raw()[H_BUMP]
    }
    pub fn flags(&self) -> u8 {
        self.raw()[H_FLAGS]
    }
    pub fn account(&self) -> Key {
        arr(&self.raw()[H_ACCOUNT..H_ACCOUNT + 32])
    }
    pub fn own_total(&self) -> u64 {
        self.u64_at(H_OWN)
    }
    pub fn won_total(&self) -> u64 {
        self.u64_at(H_WON)
    }
    pub fn fee_total(&self) -> u64 {
        self.u64_at(H_FEE)
    }
    pub fn reserved_total(&self) -> u64 {
        self.u64_at(H_RESERVED_TOTAL)
    }
    pub fn sponsored_lamports(&self) -> u64 {
        self.u64_at(H_SPONSORED)
    }
    /// Gemas the open Entry Ticket still has to stage from this basket (0 with no Ticket open).
    /// Withdrawals and Offer reservations must leave them, or the Ticket could never complete.
    pub fn ticket_need(&self) -> u64 {
        self.u64_at(H_TICKET_NEED)
    }

    /// Used lines.
    pub fn len(&self) -> usize {
        u32::from_le_bytes(arr(&self.raw()[H_LEN..H_LEN + 4])) as usize
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Lines the body can hold.
    pub fn capacity(&self) -> usize {
        (self.raw().len() - HEADER_LEN) / LINE_LEN
    }
    /// Body length that keeps every used line and drops all free slots (for `shrink_basket`).
    pub fn shrinkable_len(&self) -> usize {
        required_len(self.len())
    }

    fn line_raw(&self, idx: usize) -> &[u8] {
        let at = HEADER_LEN + idx * LINE_LEN;
        &self.raw()[at..at + LINE_LEN]
    }

    pub fn get(&self, idx: usize) -> Option<Line> {
        (idx < self.len()).then(|| Line::decode(self.line_raw(idx)))
    }

    pub fn key_at(&self, idx: usize) -> Option<LineKey> {
        (idx < self.len()).then(|| Line::decode_key(self.line_raw(idx)))
    }

    pub fn lines(&self) -> impl Iterator<Item = Line> + '_ {
        (0..self.len()).map(move |i| Line::decode(self.line_raw(i)))
    }

    /// Binary search. `Ok(index)` if the key exists, `Err(insert_index)` otherwise.
    pub fn find(&self, key: &LineKey) -> Result<usize, usize> {
        let (mut lo, mut hi) = (0usize, self.len());
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            match Line::decode_key(self.line_raw(mid)).cmp(key) {
                core::cmp::Ordering::Less => lo = mid + 1,
                core::cmp::Ordering::Greater => hi = mid,
                core::cmp::Ordering::Equal => return Ok(mid),
            }
        }
        Err(lo)
    }

    /// Index of the first line on `side` or later (`len()` if none). `first_of_side(SIDE_WON)`
    /// is where the won lines start; the entry draw scans from 0 (own) through the end (won).
    pub fn first_of_side(&self, side: u8) -> usize {
        let (mut lo, mut hi) = (0usize, self.len());
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if self.line_raw(mid)[0] < side {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    }

    /// O(n) integrity check: strictly ascending keys, valid sides, and the header totals equal
    /// the sums of the lines.
    pub fn check(&self) -> Result<(), LineStoreError> {
        let (mut own, mut won, mut fee) = (0u64, 0u64, 0u64);
        let mut prev: Option<LineKey> = None;
        for line in self.lines() {
            if line.side > SIDE_WON {
                return Err(LineStoreError::BadLine);
            }
            if prev.is_some_and(|p| p >= line.key()) {
                return Err(LineStoreError::Unsorted);
            }
            prev = Some(line.key());
            let bucket = if !line.is_playable() {
                &mut fee
            } else if line.side == SIDE_OWN {
                &mut own
            } else {
                &mut won
            };
            *bucket = bucket
                .checked_add(line.amount)
                .ok_or(LineStoreError::Overflow)?;
        }
        if (own, won, fee) != (self.own_total(), self.won_total(), self.fee_total()) {
            return Err(LineStoreError::BadStore);
        }
        Ok(())
    }
}

impl<T: AsRef<[u8]> + AsMut<[u8]>> LineStore<T> {
    /// Format a fresh body (all bytes zero beyond what is written here) as an empty basket.
    pub fn init(mut data: T, account: Key, bump: u8) -> Result<Self, LineStoreError> {
        let raw = data.as_mut();
        if raw.len() < HEADER_LEN {
            return Err(LineStoreError::BadStore);
        }
        raw[..HEADER_LEN].fill(0);
        raw[H_VERSION] = BASKET_VERSION;
        raw[H_BUMP] = bump;
        raw[H_ACCOUNT..H_ACCOUNT + 32].copy_from_slice(&account);
        LineStore::new(data)
    }

    fn raw_mut(&mut self) -> &mut [u8] {
        self.data.as_mut()
    }

    fn put_u64(&mut self, at: usize, v: u64) {
        self.raw_mut()[at..at + 8].copy_from_slice(&v.to_le_bytes());
    }

    fn set_len(&mut self, n: usize) {
        self.raw_mut()[H_LEN..H_LEN + 4].copy_from_slice(&(n as u32).to_le_bytes());
    }

    pub fn set_flags(&mut self, flags: u8) {
        self.raw_mut()[H_FLAGS] = flags;
    }
    pub fn set_reserved_total(&mut self, v: u64) {
        self.put_u64(H_RESERVED_TOTAL, v);
    }
    pub fn set_sponsored_lamports(&mut self, v: u64) {
        self.put_u64(H_SPONSORED, v);
    }
    pub fn set_ticket_need(&mut self, v: u64) {
        self.put_u64(H_TICKET_NEED, v);
    }

    fn bucket_at(line: &Line) -> usize {
        if !line.is_playable() {
            H_FEE
        } else if line.side == SIDE_OWN {
            H_OWN
        } else {
            H_WON
        }
    }

    fn check_line(line: &Line) -> Result<(), LineStoreError> {
        if line.side > SIDE_WON {
            return Err(LineStoreError::BadLine);
        }
        Ok(())
    }

    /// Insert a line at its sorted place and return its index.
    pub fn insert(&mut self, line: &Line) -> Result<usize, LineStoreError> {
        Self::check_line(line)?;
        let at = match self.find(&line.key()) {
            Ok(_) => return Err(LineStoreError::Duplicate),
            Err(at) => at,
        };
        let len = self.len();
        if len == self.capacity() {
            return Err(LineStoreError::Full);
        }
        let bucket = Self::bucket_at(line);
        let total = self
            .u64_at(bucket)
            .checked_add(line.amount)
            .ok_or(LineStoreError::Overflow)?;
        let from = HEADER_LEN + at * LINE_LEN;
        let end = HEADER_LEN + len * LINE_LEN;
        self.raw_mut().copy_within(from..end, from + LINE_LEN);
        line.encode(&mut self.raw_mut()[from..from + LINE_LEN]);
        self.set_len(len + 1);
        self.put_u64(bucket, total);
        Ok(at)
    }

    /// Remove and return the line at `idx`; later lines shift down.
    pub fn remove_at(&mut self, idx: usize) -> Result<Line, LineStoreError> {
        let line = self.get(idx).ok_or(LineStoreError::NotFound)?;
        let bucket = Self::bucket_at(&line);
        let total = self
            .u64_at(bucket)
            .checked_sub(line.amount)
            .ok_or(LineStoreError::BadStore)?;
        let len = self.len();
        let from = HEADER_LEN + idx * LINE_LEN;
        let end = HEADER_LEN + len * LINE_LEN;
        self.raw_mut().copy_within(from + LINE_LEN..end, from);
        self.raw_mut()[end - LINE_LEN..end].fill(0);
        self.set_len(len - 1);
        self.put_u64(bucket, total);
        Ok(line)
    }

    pub fn remove(&mut self, key: &LineKey) -> Result<Line, LineStoreError> {
        let idx = self.find(key).map_err(|_| LineStoreError::NotFound)?;
        self.remove_at(idx)
    }

    /// Overwrite the line at `idx` with an updated copy. The key must not change (so the order
    /// can't break); `amount` may, and the header totals follow.
    pub fn set_line(&mut self, idx: usize, line: &Line) -> Result<(), LineStoreError> {
        Self::check_line(line)?;
        let old = self.get(idx).ok_or(LineStoreError::NotFound)?;
        if old.key() != line.key() {
            return Err(LineStoreError::KeyChanged);
        }
        let bucket = Self::bucket_at(line);
        let total = self
            .u64_at(bucket)
            .checked_sub(old.amount)
            .ok_or(LineStoreError::BadStore)?
            .checked_add(line.amount)
            .ok_or(LineStoreError::Overflow)?;
        let from = HEADER_LEN + idx * LINE_LEN;
        line.encode(&mut self.raw_mut()[from..from + LINE_LEN]);
        self.put_u64(bucket, total);
        Ok(())
    }

    /// Add `incoming` to the line with the same key, or insert it if there is none. Both lines
    /// must already be materialised at the same index snapshot (the caller brings the stored
    /// line up to date first, then merges). `amount` and `uncovered` add; the stored line keeps
    /// its reserved bytes, and `incoming.reserved` must be zero.
    /// Returns the line's index. On `Err` nothing changed.
    pub fn merge(&mut self, incoming: &Line) -> Result<usize, LineStoreError> {
        Self::check_line(incoming)?;
        if incoming.reserved != [0u8; 5] {
            return Err(LineStoreError::BadLine);
        }
        let idx = match self.find(&incoming.key()) {
            Err(_) => return self.insert(incoming),
            Ok(idx) => idx,
        };
        let mut line = self.get(idx).ok_or(LineStoreError::NotFound)?;
        if !line.same_index(incoming) {
            return Err(LineStoreError::NotMaterialised);
        }
        line.amount = line
            .amount
            .checked_add(incoming.amount)
            .ok_or(LineStoreError::Overflow)?;
        line.uncovered = line
            .uncovered
            .checked_add(incoming.uncovered)
            .ok_or(LineStoreError::Overflow)?;
        self.set_line(idx, &line)?;
        Ok(idx)
    }
}

#[cfg(test)]
mod tests;

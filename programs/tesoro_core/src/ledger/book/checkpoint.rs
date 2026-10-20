//! Checkpoint records: the closed segments of a class's share-sum index.
//!
//! A class's share sum `S` restarts at zero whenever its index changes scale or a new epoch
//! begins. The value it ended on is what a line that was last brought up to date in that segment
//! needs to finish catching up, and a dormant holder can need it arbitrarily late. So every
//! closed segment is written once, never changed and never dropped, to an append-only list per
//! class. The list lives outside the Source (paged accounts), the party that causes the
//! rotation pays the rent, and nothing here wraps or forgets.
//!
//! A class's segments are numbered `0, 1, 2, ...` in the order they closed (`ClassState::ck`
//! counts them). A line records the number of the segment it was brought up to date in; its
//! catch-up reads that segment's record and the following ones, and stops at the first record
//! that ends an epoch, so a holder who slept through a thousand later epochs reads only the
//! records of its own.
//!
//! # Bytes
//!
//! One record is [`RECORD_LEN`] = 48 bytes, little endian:
//!
//! | offset | field |
//! |---|---|
//! | 0 | `epoch` u32 |
//! | 4 | `scale` u32 (the scale the segment ran at) |
//! | 8 | `flags` u8 (bit 0 = this segment ended its epoch) |
//! | 9 | 7 zero bytes |
//! | 16 | `s_end` 32 bytes, the segment's final share sum (u256) |
//!
//! A page holds [`PAGE_RECORDS`] = 32 records after a [`PAGE_HEADER_LEN`] = 40 byte header
//! (`version` u8, `class` u8, `count` u16, `page_no` u32, `source` 32 bytes): 1,576 bytes. The
//! page of record `i` is `i / PAGE_RECORDS`, at slot `i % PAGE_RECORDS`; the page address is
//! derived from (source, class, page number) by the instruction layer.

use super::wide::U256;
use super::{BookError, BookResult};
use crate::ledger::Key;

pub const CHECKPOINT_VERSION: u8 = 1;
pub const RECORD_LEN: usize = 48;
pub const PAGE_HEADER_LEN: usize = 40;
pub const PAGE_RECORDS: u32 = 32;
pub const PAGE_LEN: usize = PAGE_HEADER_LEN + PAGE_RECORDS as usize * RECORD_LEN;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Checkpoint {
    pub epoch: u32,
    pub scale: u32,
    pub ends_epoch: bool,
    pub s_end: U256,
}

impl Checkpoint {
    pub fn encode(&self, out: &mut [u8]) {
        out[..RECORD_LEN].fill(0);
        out[0..4].copy_from_slice(&self.epoch.to_le_bytes());
        out[4..8].copy_from_slice(&self.scale.to_le_bytes());
        out[8] = u8::from(self.ends_epoch);
        out[16..48].copy_from_slice(&self.s_end.to_le_bytes());
    }

    pub fn decode(raw: &[u8]) -> BookResult<Checkpoint> {
        if raw.len() < RECORD_LEN || raw[8] > 1 || raw[9..16].iter().any(|b| *b != 0) {
            return Err(BookError::BadCheckpoint);
        }
        let mut s = [0u8; 32];
        s.copy_from_slice(&raw[16..48]);
        let mut e = [0u8; 4];
        e.copy_from_slice(&raw[0..4]);
        let mut c = [0u8; 4];
        c.copy_from_slice(&raw[4..8]);
        Ok(Checkpoint {
            epoch: u32::from_le_bytes(e),
            scale: u32::from_le_bytes(c),
            ends_epoch: raw[8] == 1,
            s_end: U256::from_le_bytes(&s),
        })
    }
}

/// Where closed segments are kept. `get` is a read of an earlier record; `push` appends the
/// record the ledger numbers `idx` (always the next one for that class). Implementations over
/// accounts return an error from `push` when the page is full or not supplied; the transaction
/// then fails as a whole.
pub trait CheckpointStore {
    fn get(&self, class: u8, idx: u32) -> Option<Checkpoint>;
    fn push(&mut self, class: u8, idx: u32, rec: Checkpoint) -> BookResult<()>;
}

/// A store with no history, for code paths that never rotate (and for lines that cannot be
/// stale). Reading from it finds nothing; writing is refused.
pub struct NoCheckpoints;

impl CheckpointStore for NoCheckpoints {
    fn get(&self, _class: u8, _idx: u32) -> Option<Checkpoint> {
        None
    }
    fn push(&mut self, _class: u8, _idx: u32, _rec: Checkpoint) -> BookResult<()> {
        Err(BookError::MissingCheckpoint)
    }
}

/// Read a page body.
pub struct PageView<'a>(pub &'a [u8]);

impl<'a> PageView<'a> {
    pub fn new(raw: &'a [u8], source: &Key, class: u8, page_no: u32) -> BookResult<Self> {
        if raw.len() < PAGE_LEN
            || raw[0] != CHECKPOINT_VERSION
            || raw[1] != class
            || raw[4..8] != page_no.to_le_bytes()
            || raw[8..40] != source[..]
        {
            return Err(BookError::BadCheckpoint);
        }
        let v = PageView(raw);
        if v.count() > PAGE_RECORDS {
            return Err(BookError::BadCheckpoint);
        }
        Ok(v)
    }
    pub fn count(&self) -> u32 {
        u16::from_le_bytes([self.0[2], self.0[3]]) as u32
    }
    /// The record in slot `slot` of this page, if written.
    pub fn get(&self, slot: u32) -> BookResult<Option<Checkpoint>> {
        if slot >= self.count() {
            return Ok(None);
        }
        let at = PAGE_HEADER_LEN + slot as usize * RECORD_LEN;
        Checkpoint::decode(&self.0[at..at + RECORD_LEN]).map(Some)
    }
}

/// Format and append to a page body.
pub struct PageViewMut<'a>(pub &'a mut [u8]);

impl<'a> PageViewMut<'a> {
    pub fn init(raw: &'a mut [u8], source: &Key, class: u8, page_no: u32) -> BookResult<Self> {
        if raw.len() < PAGE_LEN {
            return Err(BookError::BadCheckpoint);
        }
        raw[..PAGE_LEN].fill(0);
        raw[0] = CHECKPOINT_VERSION;
        raw[1] = class;
        raw[4..8].copy_from_slice(&page_no.to_le_bytes());
        raw[8..40].copy_from_slice(source);
        Ok(PageViewMut(raw))
    }
    pub fn count(&self) -> u32 {
        u16::from_le_bytes([self.0[2], self.0[3]]) as u32
    }
    /// Append at `slot`, which must be the next free one.
    pub fn push(&mut self, slot: u32, rec: &Checkpoint) -> BookResult<()> {
        if slot != self.count() || slot >= PAGE_RECORDS {
            return Err(BookError::BadCheckpoint);
        }
        let at = PAGE_HEADER_LEN + slot as usize * RECORD_LEN;
        rec.encode(&mut self.0[at..at + RECORD_LEN]);
        self.0[2..4].copy_from_slice(&((slot + 1) as u16).to_le_bytes());
        Ok(())
    }
}

/// An in-memory store made of real page bytes, so tests exercise the byte format.
#[cfg(not(target_os = "solana"))]
#[derive(Default, Clone)]
pub struct MemCheckpoints {
    pub source: Key,
    pub pages: std::collections::BTreeMap<(u8, u32), Vec<u8>>,
    pub reads: std::cell::Cell<u64>,
}

#[cfg(not(target_os = "solana"))]
impl MemCheckpoints {
    pub fn new(source: Key) -> Self {
        MemCheckpoints {
            source,
            ..Self::default()
        }
    }
    /// Records written for `class`.
    pub fn len(&self, class: u8) -> u32 {
        self.pages
            .iter()
            .filter(|((c, _), _)| *c == class)
            .map(|(_, p)| u16::from_le_bytes([p[2], p[3]]) as u32)
            .sum()
    }
    pub fn is_empty(&self) -> bool {
        self.pages.is_empty()
    }
}

#[cfg(not(target_os = "solana"))]
impl CheckpointStore for MemCheckpoints {
    fn get(&self, class: u8, idx: u32) -> Option<Checkpoint> {
        self.reads.set(self.reads.get() + 1);
        let page = self.pages.get(&(class, idx / PAGE_RECORDS))?;
        let view = PageView::new(page, &self.source, class, idx / PAGE_RECORDS).ok()?;
        view.get(idx % PAGE_RECORDS).ok()?
    }
    fn push(&mut self, class: u8, idx: u32, rec: Checkpoint) -> BookResult<()> {
        let page_no = idx / PAGE_RECORDS;
        let source = self.source;
        let page = self.pages.entry((class, page_no)).or_insert_with(|| {
            let mut raw = vec![0u8; PAGE_LEN];
            PageViewMut::init(&mut raw, &source, class, page_no).ok();
            raw
        });
        PageViewMut(&mut page[..]).push(idx % PAGE_RECORDS, &rec)
    }
}

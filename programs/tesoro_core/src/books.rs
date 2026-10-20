//! The Source books a transaction supplies, as the ledger's `SourceBooks`.
//!
//! An instruction that edits lines of several Sources (a claim now; settle, refund and Ticket
//! chunks in tickets 09 and 11) passes each Source's book account and the checkpoint pages its
//! lines may need in `remaining_accounts`, in any order. [`OnchainBooks::load`] checks every one
//! (owner, discriminator, PDA address, writable) and decodes a book only when a line needs its
//! Source: one boxed `SourceBook` at a time, written back to its account when another Source is
//! asked for. Heap use is therefore constant (about 2 KB), and the number of distinct Sources a
//! transaction handles is limited by its size and compute budget. [`OnchainBooks::flush`] writes
//! the last one back; call it only after the ledger operation succeeded. A failed instruction
//! reverts every account anyway.

use crate::error::BasketError;
use crate::ledger::book::checkpoint::{
    Checkpoint, CheckpointStore, PageView, PageViewMut, PAGE_LEN, PAGE_RECORDS,
};
use crate::ledger::book::{BookError, BookResult, SourceBook};
use crate::ledger::draw::{DrawError, DrawResult, SourceBooks};
use crate::ledger::line_store as ledger_line;
use crate::ledger::Key;
use crate::storage::*;
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

/// One checkpoint page account supplied with a Source.
struct PageRef<'a, 'info> {
    class: u8,
    page_no: u32,
    info: &'a AccountInfo<'info>,
}

/// A Source's closed-segment records, read and appended in place in the supplied page accounts.
pub struct PageSet<'a, 'info> {
    source: Key,
    pages: Vec<PageRef<'a, 'info>>,
}

impl<'a, 'info> PageSet<'a, 'info> {
    fn find(&self, class: u8, page_no: u32) -> Option<&PageRef<'a, 'info>> {
        self.pages
            .iter()
            .find(|p| p.class == class && p.page_no == page_no)
    }
}

impl CheckpointStore for PageSet<'_, '_> {
    fn get(&self, class: u8, idx: u32) -> Option<Checkpoint> {
        let page_no = idx / PAGE_RECORDS;
        let page = self.find(class, page_no)?;
        let data = page.info.try_borrow_data().ok()?;
        let view = PageView::new(&data[CKPT_PAGE_AT..], &self.source, class, page_no).ok()?;
        view.get(idx % PAGE_RECORDS).ok()?
    }

    fn push(&mut self, class: u8, idx: u32, rec: Checkpoint) -> BookResult<()> {
        let page_no = idx / PAGE_RECORDS;
        let page = self
            .find(class, page_no)
            .ok_or(BookError::MissingCheckpoint)?;
        let mut data = page
            .info
            .try_borrow_mut_data()
            .map_err(|_| BookError::BadCheckpoint)?;
        // checked on load, but a page that was not writable must not reach here half way
        let mut view = PageViewMut(&mut data[CKPT_PAGE_AT..CKPT_PAGE_AT + PAGE_LEN]);
        view.push(idx % PAGE_RECORDS, &rec)
    }
}

struct Entry<'a, 'info> {
    source: Key,
    info: &'a AccountInfo<'info>,
    history: PageSet<'a, 'info>,
}

/// The books (and histories) supplied to one instruction.
///
/// The account bytes are the source of truth. At most ONE book is decoded at a time (one boxed
/// `SourceBook`, 2 KB of heap whatever the number of Sources); asking for another Source first
/// writes the current one back to its account. So the number of distinct Sources in a transaction
/// is limited by the transaction's size and compute budget, never by the 32 KB heap. A chunk that
/// handles lines grouped by Source swaps rarely; one that alternates pays an encode and a decode
/// (a few thousand CU) per swap.
pub struct OnchainBooks<'a, 'info> {
    entries: Vec<Entry<'a, 'info>>,
    /// The one decoded book, allocated once and decoded over for every swap: the on-chain heap
    /// is a bump allocator that never frees, so a fresh `Box` per swap would leak 2 KB each.
    book: Option<Box<SourceBook>>,
    current: Option<usize>,
}

fn check_writable(info: &AccountInfo) -> Result<()> {
    require!(info.is_writable, BasketError::AccountNotWritable);
    Ok(())
}

fn book_err(_: BookError) -> DrawError {
    DrawError::Book(BookError::Corrupt("source book account"))
}

impl<'a, 'info> OnchainBooks<'a, 'info> {
    /// No books: for instructions that only move whole lines.
    pub fn empty() -> Self {
        OnchainBooks {
            entries: Vec::new(),
            book: None,
            current: None,
        }
    }

    /// Check the supplied accounts. Every account must be a Source book or a checkpoint page of
    /// one of the supplied books, owned by this program, at its PDA address, and writable.
    /// Nothing is decoded until a line needs its Source.
    pub fn load(accounts: &'a [AccountInfo<'info>]) -> Result<Self> {
        let mut entries: Vec<Entry<'a, 'info>> = Vec::new();
        for info in accounts {
            if !is_book(info) {
                continue;
            }
            check_writable(info)?;
            let data = info.try_borrow_data()?;
            let head: &SourceBookHead = bytemuck_head(&data)?;
            require!(
                head.version == SOURCE_BOOK_VERSION,
                BasketError::BadSourceBook
            );
            let source = head.source;
            let address =
                Pubkey::create_program_address(&[BOOK_SEED, &source, &[head.bump]], &crate::ID)
                    .map_err(|_| BasketError::BadSourceBook)?;
            require_keys_eq!(address, *info.key, BasketError::BadSourceBook);
            require!(
                !entries.iter().any(|e| e.source == source),
                BasketError::DuplicateBook
            );
            require!(data.len() >= BOOK_AT, BasketError::BadSourceBook);
            drop(data);
            entries.push(Entry {
                source,
                info,
                history: PageSet {
                    source,
                    pages: Vec::new(),
                },
            });
        }
        for info in accounts {
            if !is_page(info) {
                continue;
            }
            check_writable(info)?;
            let data = info.try_borrow_data()?;
            let head: &CkptHead = bytemuck_head(&data)?;
            let page = &data[CKPT_PAGE_AT..];
            require!(page.len() >= PAGE_LEN, BasketError::BadCheckpointPage);
            let class = page[1];
            let mut page_no = [0u8; 4];
            page_no.copy_from_slice(&page[4..8]);
            let page_no = u32::from_le_bytes(page_no);
            let mut source = [0u8; 32];
            source.copy_from_slice(&page[8..40]);
            let address = Pubkey::create_program_address(
                &[
                    CKPT_SEED,
                    &source,
                    &[class],
                    &page_no.to_le_bytes(),
                    &[head.bump],
                ],
                &crate::ID,
            )
            .map_err(|_| BasketError::BadCheckpointPage)?;
            require_keys_eq!(address, *info.key, BasketError::BadCheckpointPage);
            let entry = entries
                .iter_mut()
                .find(|e| e.source == source)
                .ok_or(BasketError::BookMissing)?;
            require!(
                entry.history.find(class, page_no).is_none(),
                BasketError::DuplicateBook
            );
            entry.history.pages.push(PageRef {
                class,
                page_no,
                info,
            });
        }
        Ok(OnchainBooks {
            entries,
            book: None,
            current: None,
        })
    }

    fn write_back(&mut self) -> DrawResult<()> {
        if let (Some(idx), Some(book)) = (self.current.take(), self.book.as_ref()) {
            let mut data = self.entries[idx]
                .info
                .try_borrow_mut_data()
                .map_err(|_| DrawError::Book(BookError::Corrupt("source book account")))?;
            book.encode(&mut data[BOOK_AT..]).map_err(book_err)?;
        }
        Ok(())
    }

    /// The Source's fee counter of `class` (Platform, Studio or Leaderboard), if one was credited.
    pub fn counter(&self, source: &Key, class: u8) -> Option<ledger_line::Line> {
        let e = self.entries.iter().find(|e| e.source == *source)?;
        let data = e.info.try_borrow_data().ok()?;
        counter_get(&data, class)
    }

    /// Writes the Source's fee counter of `class` back into its book account.
    pub fn set_counter(&mut self, source: &Key, class: u8, line: &ledger_line::Line) -> bool {
        let Some(e) = self.entries.iter().find(|e| e.source == *source) else {
            return false;
        };
        let Ok(mut data) = e.info.try_borrow_mut_data() else {
            return false;
        };
        counter_put(&mut data, class, line)
    }

    /// Write the decoded book back into its account. Call after the ledger operations succeeded.
    pub fn flush(mut self) -> Result<()> {
        self.write_back().map_err(|_| BasketError::BadSourceBook)?;
        Ok(())
    }

    fn entry(&mut self, source: &Key) -> DrawResult<(&mut SourceBook, &mut PageSet<'a, 'info>)> {
        let idx = self
            .entries
            .iter()
            .position(|e| e.source == *source)
            .ok_or(DrawError::Book(BookError::NoSuchClass))?;
        if self.current != Some(idx) {
            self.write_back()?;
            let book = self.book.get_or_insert_with(|| Box::new(SourceBook::new()));
            let data = self.entries[idx]
                .info
                .try_borrow_data()
                .map_err(|_| DrawError::Book(BookError::Corrupt("source book account")))?;
            book.decode_into(&data[BOOK_AT..]).map_err(book_err)?;
            self.current = Some(idx);
        }
        let book = &mut **self.book.as_mut().expect("decoded above");
        Ok((book, &mut self.entries[idx].history))
    }
}

impl SourceBooks for OnchainBooks<'_, '_> {
    fn book_mut(&mut self, source: &Key) -> DrawResult<&mut SourceBook> {
        Ok(self.entry(source)?.0)
    }

    fn book_with_history(
        &mut self,
        source: &Key,
    ) -> DrawResult<(&mut SourceBook, &mut dyn CheckpointStore)> {
        let (book, history) = self.entry(source)?;
        Ok((book, history))
    }
}

fn is_book(info: &AccountInfo) -> bool {
    has_discriminator(info, SourceBookHead::DISCRIMINATOR)
}

fn is_page(info: &AccountInfo) -> bool {
    has_discriminator(info, CkptHead::DISCRIMINATOR)
}

fn has_discriminator(info: &AccountInfo, disc: &[u8]) -> bool {
    info.owner == &crate::ID
        && info
            .try_borrow_data()
            .map(|d| d.len() >= DISC && &d[..DISC] == disc)
            .unwrap_or(false)
}

/// The zero-copy head after the discriminator.
fn bytemuck_head<T: anchor_lang::__private::bytemuck::Pod>(data: &[u8]) -> Result<&T> {
    let size = core::mem::size_of::<T>();
    let raw = data
        .get(DISC..DISC + size)
        .ok_or(BasketError::BadSourceBook)?;
    anchor_lang::__private::bytemuck::try_from_bytes(raw)
        .map_err(|_| BasketError::BadSourceBook.into())
}

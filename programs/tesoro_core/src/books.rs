//! The Source books a transaction supplies, as the ledger's `SourceBooks`.
//!
//! An instruction that edits lines of several Sources (a claim now; settle, refund and Ticket
//! chunks in tickets 09 and 11) passes each Source's book account and the checkpoint pages its
//! lines may need in `remaining_accounts`, in any order. [`OnchainBooks::load`] checks every one
//! (owner, discriminator, PDA address, writable), decodes each book **once** into a boxed
//! `SourceBook` (2 KB of heap per distinct Source: the in-memory book does not fit a 4 KB stack
//! frame, and `BookBytes` cannot sit behind the `SourceBooks` trait), and hands the ledger
//! `(book, history)` pairs. [`OnchainBooks::flush`] writes the books back; call it only after
//! the ledger operation succeeded. A failed instruction reverts every account anyway.

use crate::error::BasketError;
use crate::ledger::book::checkpoint::{
    Checkpoint, CheckpointStore, PageView, PageViewMut, PAGE_LEN, PAGE_RECORDS,
};
use crate::ledger::book::{BookError, BookResult, SourceBook};
use crate::ledger::draw::{DrawError, DrawResult, SourceBooks};
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
    book: Box<SourceBook>,
    history: PageSet<'a, 'info>,
}

/// The books (and histories) supplied to one instruction.
pub struct OnchainBooks<'a, 'info> {
    entries: Vec<Entry<'a, 'info>>,
}

fn check_writable(info: &AccountInfo) -> Result<()> {
    require!(info.is_writable, BasketError::AccountNotWritable);
    Ok(())
}

impl<'a, 'info> OnchainBooks<'a, 'info> {
    /// No books: for instructions that only move whole lines.
    pub fn empty() -> Self {
        OnchainBooks {
            entries: Vec::new(),
        }
    }

    /// Check and decode the supplied accounts. Every account must be a Source book or a
    /// checkpoint page of one of the supplied books, owned by this program, at its PDA address,
    /// and writable. Anything else fails: a stray account is a client bug.
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
            let mut book = Box::new(SourceBook::new());
            book.decode_into(&data[BOOK_AT..])
                .map_err(|_| BasketError::BadSourceBook)?;
            drop(data);
            entries.push(Entry {
                source,
                info,
                book,
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
        Ok(OnchainBooks { entries })
    }

    /// Write every book back into its account.
    pub fn flush(self) -> Result<()> {
        for e in self.entries {
            let mut data = e.info.try_borrow_mut_data()?;
            e.book
                .encode(&mut data[BOOK_AT..])
                .map_err(|_| BasketError::BadSourceBook)?;
        }
        Ok(())
    }

    fn entry(&mut self, source: &Key) -> DrawResult<&mut Entry<'a, 'info>> {
        self.entries
            .iter_mut()
            .find(|e| e.source == *source)
            .ok_or(DrawError::Book(BookError::NoSuchClass))
    }
}

impl SourceBooks for OnchainBooks<'_, '_> {
    fn book_mut(&mut self, source: &Key) -> DrawResult<&mut SourceBook> {
        Ok(&mut *self.entry(source)?.book)
    }

    fn book_with_history(
        &mut self,
        source: &Key,
    ) -> DrawResult<(&mut SourceBook, &mut dyn CheckpointStore)> {
        let e = self.entry(source)?;
        Ok((&mut *e.book, &mut e.history))
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

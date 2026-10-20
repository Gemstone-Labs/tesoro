//! Helpers shared by the economy suites (ticket 11): reading baskets, books and pages straight
//! from the LiteSVM, and forging what a Match settlement will do (moving Gemas between baskets).
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey as APk;
use litesvm::LiteSVM;
use solana_sdk::instruction::AccountMeta;
use solana_sdk::pubkey::Pubkey as Pk;
use tesoro_core::ledger::book::checkpoint::{
    Checkpoint, CheckpointStore, PageView, PAGE_RECORDS,
};
use tesoro_core::ledger::book::{BookError, BookResult, SourceBook};
use tesoro_core::ledger::line_store::{Line, LineKey, LineStore, SIDE_OWN, SIDE_WON};
use tesoro_core::storage::*;

pub fn a(p: Pk) -> APk {
    APk::new_from_array(p.to_bytes())
}
pub fn s(p: APk) -> Pk {
    Pk::new_from_array(p.to_bytes())
}

pub fn meta(k: APk, writable: bool) -> AccountMeta {
    if writable {
        AccountMeta::new(s(k), false)
    } else {
        AccountMeta::new_readonly(s(k), false)
    }
}

/// Checkpoint pages read from the chain (read only: a `push` is refused).
pub struct SvmPages<'a> {
    pub svm: &'a LiteSVM,
    pub source: APk,
}

impl CheckpointStore for SvmPages<'_> {
    fn get(&self, class: u8, idx: u32) -> Option<Checkpoint> {
        let page_no = idx / PAGE_RECORDS;
        let acc = self
            .svm
            .get_account(&s(ckpt_address(&self.source, class, page_no).0))?;
        let view = PageView::new(
            &acc.data[CKPT_PAGE_AT..],
            &self.source.to_bytes(),
            class,
            page_no,
        )
        .ok()?;
        view.get(idx % PAGE_RECORDS).ok()?
    }

    fn push(&mut self, _class: u8, _idx: u32, _rec: Checkpoint) -> BookResult<()> {
        Err(BookError::MissingCheckpoint)
    }
}

pub fn read_book(svm: &LiteSVM, source: APk) -> SourceBook {
    let acc = svm
        .get_account(&s(book_address(&source).0))
        .expect("book account");
    SourceBook::decode(&acc.data[BOOK_AT..]).expect("book")
}

pub fn write_book(svm: &mut LiteSVM, source: APk, book: &SourceBook) {
    let addr = s(book_address(&source).0);
    let mut acc = svm.get_account(&addr).expect("book account");
    book.encode(&mut acc.data[BOOK_AT..]).expect("encode");
    svm.set_account(addr, acc).expect("set book");
}

/// Every checkpoint page of `source` that exists, as writable remaining accounts.
pub fn page_metas(svm: &LiteSVM, source: APk) -> Vec<AccountMeta> {
    let mut out = vec![];
    for class in 0..15u8 {
        for page_no in 0..4u32 {
            let k = ckpt_address(&source, class, page_no).0;
            if svm.get_account(&s(k)).is_some() {
                out.push(meta(k, true));
            }
        }
    }
    out
}

/// The Source's book and its pages: the tail of a Source-touching instruction.
pub fn book_metas(svm: &LiteSVM, source: APk) -> Vec<AccountMeta> {
    let mut v = vec![meta(book_address(&source).0, true)];
    v.extend(page_metas(svm, source));
    v
}

pub fn read_lines(svm: &LiteSVM, store: APk) -> Vec<Line> {
    let acc = svm.get_account(&s(store)).expect("store");
    LineStore::new(&acc.data[DISC..])
        .expect("store")
        .lines()
        .collect()
}

/// The line of `account` (basket first, then spill) for a Source, side, class and tranche.
pub fn find_line(
    svm: &LiteSVM,
    account: APk,
    source: APk,
    side: u8,
    class: u8,
    tranche: u8,
) -> Option<Line> {
    [basket_address(&account).0, spill_address(&account).0]
        .into_iter()
        .flat_map(|st| read_lines(svm, st))
        .find(|l| {
            l.source == source.to_bytes() && l.side == side && l.class == class && l.tranche == tranche
        })
}

/// Total Gemas of a Source in a store.
pub fn gemas_in(svm: &LiteSVM, account: APk, source: APk) -> u64 {
    [basket_address(&account).0, spill_address(&account).0]
        .into_iter()
        .flat_map(|st| read_lines(svm, st))
        .filter(|l| l.source == source.to_bytes())
        .map(|l| l.amount)
        .sum()
}

/// The fee counter of `class` in a Source's book account, if it was ever credited.
pub fn counter(svm: &LiteSVM, source: APk, class: u8) -> Option<Line> {
    let acc = svm.get_account(&s(book_address(&source).0))?;
    counter_get(&acc.data, class)
}

fn write_store(svm: &mut LiteSVM, store: APk, f: impl FnOnce(&mut LineStore<&mut [u8]>)) {
    let addr = s(store);
    let mut acc = svm.get_account(&addr).expect("store");
    {
        let mut st = LineStore::new(&mut acc.data[DISC..]).expect("store");
        f(&mut st);
    }
    svm.set_account(addr, acc).expect("set store");
}

/// What a won Match does to the baskets: moves `k` Gemas of `source` (own side, `class`,
/// `tranche`) from `from` to `to` as won Gemas, with their proportional repaid part, through the
/// book. (Settlement in ticket 09 does exactly this through `transfer`.)
pub fn win(
    svm: &mut LiteSVM,
    source: APk,
    from: APk,
    to: APk,
    class: u8,
    tranche: u8,
    k: u64,
) {
    let mut book = read_book(svm, source);
    let from_basket = basket_address(&from).0;
    let to_basket = basket_address(&to).0;
    let mut src = find_line(svm, from, source, SIDE_OWN, class, tranche)
        .or_else(|| find_line(svm, from, source, SIDE_WON, class, tranche))
        .expect("source line");
    let from_store = if read_lines(svm, from_basket)
        .iter()
        .any(|l| l.key() == src.key())
    {
        from_basket
    } else {
        spill_address(&from).0
    };
    let mut dst = SourceBook::blank_line(SIDE_WON, src.due_at, src.source, src.class, src.tranche);
    let existing = read_lines(svm, to_basket)
        .into_iter()
        .find(|l| l.key() == dst.key());
    if let Some(l) = existing {
        dst = l;
    }
    {
        let pages = SvmPages { svm, source };
        book.transfer(&mut src, &mut dst, k, &pages).expect("transfer");
    }
    let key: LineKey = src.key();
    write_store(svm, from_store, |st| {
        let idx = st.find(&key).expect("line");
        if src.amount == 0 {
            st.remove_at(idx).unwrap();
        } else {
            st.set_line(idx, &src).unwrap();
        }
    });
    write_store(svm, to_basket, |st| match st.find(&dst.key()) {
        Ok(i) => st.set_line(i, &dst).unwrap(),
        Err(_) => {
            st.insert(&dst).unwrap();
        }
    });
    write_book(svm, source, &book);
}

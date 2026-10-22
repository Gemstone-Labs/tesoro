//! On-chain storage of the economy ledger: baskets, spills, the sponsor, Source books and their
//! checkpoint pages (spec "Ledger: basket", tickets 02-04b).
//!
//! The pure ledger (`ledger::line_store`, `ledger::book`, `ledger::draw`) works on plain byte
//! slices, so on chain every one of these accounts is **read and written in place**: the account
//! data is wrapped (`LineStore::new(&mut data[8..])`, `BookBytes::open`, `PageView`) and never
//! deserialised onto the 4 KB stack or the 32 KB heap. Anchor sees only a fixed zero-copy *head*
//! (a plain byte array, so `align_of == 1` and no padding) that carries the discriminator and the
//! owner check; the lines and the book follow it in the same account.
//!
//! | account | seeds | data after the 8-byte discriminator |
//! |---|---|---|
//! | basket | `["basket", account]` | `LineStore` body: 128 B header + `LINE_LEN` per slot |
//! | spill | `["spill", account]` | same format, second store (overflow, see `ledger::draw`) |
//! | sponsor | `["sponsor"]` | Borsh [`SponsorState`] (rent the program pays for Players) |
//! | source book | `["book", source]` | 40 B head, 3 fee-counter slots, `BookBytes` |
//! | checkpoint page | `["ckpt", source, class, page_no_le]` | 8 B head, one 1,576 B page |
//!
//! Account creation by CPI is limited to 10,240 bytes and one instruction can grow an account by
//! at most 10,240 bytes, so a basket starts small and grows by `grow_store` calls.

use crate::ledger::book::checkpoint::PAGE_LEN;
use crate::ledger::book::encoded_len;
use crate::ledger::line_store::{
    required_len, Line, CLASS_LEADERBOARD, CLASS_PLATFORM, CLASS_STUDIO, HEADER_LEN, LINE_LEN,
};
use crate::ledger::Key;
use anchor_lang::prelude::*;

pub const BASKET_SEED: &[u8] = b"basket";
pub const SPILL_SEED: &[u8] = b"spill";
pub const SPONSOR_SEED: &[u8] = b"sponsor";
pub const BOOK_SEED: &[u8] = b"book";
pub const CKPT_SEED: &[u8] = b"ckpt";
pub const OVERFLOW_SEED: &[u8] = b"overflow";

/// Anchor's discriminator length.
pub const DISC: usize = 8;

/// Slots a new basket starts with (the Player pays the rent of these).
pub const INITIAL_BASKET_LINES: usize = 4;
/// Largest basket and largest spill, in lines (about 3.1 MB each, 22 SOL of rent at full size).
/// An Account at both maximums holds 65,536 distinct lines; no entry needs a free slot (see
/// `instructions::ticket`, "Room"), so only credits of more new lines than that can wait. A chunk
/// that credits five Accounts loads ten stores, 31 MB, within the 64 MB a transaction may load.
pub const MAX_BASKET_LINES: usize = 32_768;
pub const MAX_SPILL_LINES: usize = 32_768;
/// Largest Ticket (and so Pot), in lines.
pub const MAX_TICKET_LINES: usize = 4_096;
/// The runtime lets one instruction grow an account by at most this many bytes.
pub const MAX_GROW_BYTES: usize = 10_240;
/// Slots one `grow_store` call can add.
pub const MAX_GROW_LINES: usize = MAX_GROW_BYTES / LINE_LEN;
const _: () = assert!(MAX_GROW_LINES >= 70 && MAX_GROW_LINES * LINE_LEN <= MAX_GROW_BYTES);

/// Bytes of a basket or spill account with `lines` slots.
pub fn store_len(lines: usize) -> usize {
    DISC + required_len(lines)
}

/// Head of a basket account: the `LineStore` header (`HEADER_LEN` bytes, byte 1 is the bump). The
/// lines follow in the same account.
#[account(zero_copy)]
pub struct BasketHead {
    pub raw: [u8; HEADER_LEN],
}

/// Head of a spill account, same format as [`BasketHead`].
#[account(zero_copy)]
pub struct SpillHead {
    pub raw: [u8; HEADER_LEN],
}

/// Byte of the `LineStore` header that holds the bump.
pub const STORE_BUMP_AT: usize = 1;

/// What an overflow record was made for. The kind and the 40-byte id are part of its address:
/// `["overflow", owner, kind, id[..32], id[32..]]` (a seed is at most 32 bytes).
pub const OVERFLOW_MATCH: u8 = 0;
/// A Season prize (id: the Season number, 8 bytes LE, then the rank, then zeros).
pub const OVERFLOW_SEASON: u8 = 1;
/// A prize route's line (id: the route's prize escrow key, then zeros).
pub const OVERFLOW_ROUTE: u8 = 2;

/// Head of an overflow record: lines a credit found no room for in the owner's stores
/// (`instructions::overflow`). The `LineStore` body (same format as a basket, the owner in its
/// header) follows the head. The record keeps its rent until its last line is claimed.
#[account(zero_copy)]
pub struct OverflowHead {
    /// Who paid the rent; it goes back there when the record is empty.
    pub payer: [u8; 32],
    pub kind: u8,
    pub id: [u8; 40],
}

/// Where the `LineStore` body of an overflow record starts.
pub const OVERFLOW_STORE_AT: usize = DISC + 32 + 1 + 40;

/// Bytes of an overflow record with `lines` slots.
pub fn overflow_len(lines: usize) -> usize {
    OVERFLOW_STORE_AT + required_len(lines)
}

/// Most lines an overflow record can be created (or grown) with in one instruction.
pub const MAX_OVERFLOW_LINES: usize = (MAX_GROW_BYTES - OVERFLOW_STORE_AT - HEADER_LEN) / LINE_LEN;

/// Head of a Source's book account.
#[account(zero_copy)]
pub struct SourceBookHead {
    pub bump: u8,
    pub version: u8,
    pub _pad: [u8; 6],
    /// The `SourceState` address this book belongs to.
    pub source: [u8; 32],
}

pub const SOURCE_BOOK_VERSION: u8 = 1;
pub const BOOK_HEAD_LEN: usize = 40;
/// Slots for the fee counters of classes Platform, Studio and Leaderboard (index = class).
pub const COUNTER_SLOTS: usize = 3;
/// Offset (from the start of the account data) of the first counter slot.
pub const COUNTERS_AT: usize = DISC + BOOK_HEAD_LEN;
/// Offset of the `BookBytes` region, which is last so an Extension can grow the account.
pub const BOOK_AT: usize = COUNTERS_AT + COUNTER_SLOTS * LINE_LEN;
/// Account length with no Extension.
pub const SOURCE_BOOK_LEN: usize = BOOK_AT + encoded_len(0);

/// Head of one page of a class's checkpoint records. The bump is here so the page address can be
/// checked with `create_program_address`; the page (`PAGE_LEN` bytes) follows.
#[account(zero_copy)]
pub struct CkptHead {
    pub bump: u8,
    pub _pad: [u8; 7],
}

pub const CKPT_PAGE_AT: usize = DISC + 8;
pub const CKPT_ACCOUNT_LEN: usize = CKPT_PAGE_AT + PAGE_LEN;

/// What the program pays for Players and Sources, and the limits on it (spec "Capacity and
/// sponsored rent"). The account also holds the lamports it pays out: anyone may send SOL to it.
#[account]
pub struct SponsorState {
    pub bump: u8,
    /// Only this key's signature authorises sponsored growth and sponsored pages.
    pub relayer: Pubkey,
    /// While set, nothing is sponsored (Players pay for themselves).
    pub paused: bool,
    /// Most sponsored (refundable) rent one Account's basket and spill may hold together.
    pub per_account_cap: u64,
    /// Most sponsored refundable rent outstanding over all Accounts.
    pub total_cap: u64,
    /// Sponsored refundable rent outstanding now (all baskets and spills).
    pub outstanding: u64,
    /// Most the sponsor may spend, over time, on checkpoint pages (never refunded).
    pub pages_cap: u64,
    pub pages_spent: u64,
}

impl SponsorState {
    pub const SPACE: usize = DISC + 1 + 32 + 1 + 5 * 8;
}

pub fn basket_address(account: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[BASKET_SEED, account.as_ref()], &crate::ID)
}

pub fn spill_address(account: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SPILL_SEED, account.as_ref()], &crate::ID)
}

pub fn sponsor_address() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SPONSOR_SEED], &crate::ID)
}

pub fn overflow_address(owner: &Pubkey, kind: u8, id: &[u8; 40]) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[OVERFLOW_SEED, owner.as_ref(), &[kind], &id[..32], &id[32..]],
        &crate::ID,
    )
}

pub fn book_address(source: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[BOOK_SEED, source.as_ref()], &crate::ID)
}

pub fn ckpt_address(source: &Pubkey, class: u8, page_no: u32) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[CKPT_SEED, source.as_ref(), &[class], &page_no.to_le_bytes()],
        &crate::ID,
    )
}

// ---------------------------------------------------------------------------------------------
// Fee counters: exactly one Platform and one Leaderboard line per Source
// ---------------------------------------------------------------------------------------------

/// Where a fee of `class` is credited. Platform and Leaderboard are single-holder pooled classes
/// (`ledger::book`'s precondition): their only line lives in the Source's book account, one slot
/// per class, so a second one cannot exist. A Studio Fee is a counter slot for Tesoro's own and a
/// fee line in the recipient's basket for an outside studio.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeDestination {
    Counter(usize),
    Basket,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeError {
    /// The class is not a fee class.
    NotFeeClass,
    /// A Platform or Leaderboard Fee names a recipient basket: only the counter may hold them.
    CounterOnly,
}

/// Resolve a fee's destination. `outside_studio` is the recipient of a Studio Fee when the Game's
/// studio is not Tesoro itself.
pub fn fee_destination(
    class: u8,
    outside_studio: bool,
) -> core::result::Result<FeeDestination, FeeError> {
    match class {
        CLASS_PLATFORM | CLASS_LEADERBOARD if outside_studio => Err(FeeError::CounterOnly),
        CLASS_PLATFORM | CLASS_LEADERBOARD => Ok(FeeDestination::Counter(class as usize)),
        CLASS_STUDIO if outside_studio => Ok(FeeDestination::Basket),
        CLASS_STUDIO => Ok(FeeDestination::Counter(CLASS_STUDIO as usize)),
        _ => Err(FeeError::NotFeeClass),
    }
}

/// A basket or spill must never hold a Platform or Leaderboard line: those classes have one
/// holder, the Source's counter. Checked on every credit into a basket or spill.
pub fn basket_may_hold(line: &Line) -> bool {
    line.class != CLASS_PLATFORM && line.class != CLASS_LEADERBOARD
}

/// The one key a counter line has: own side, due 0, tranche 0, of the book's Source.
pub fn counter_line_ok(source: &Key, class: u8, line: &Line) -> bool {
    (class as usize) < COUNTER_SLOTS
        && line.class == class
        && line.side == crate::ledger::line_store::SIDE_OWN
        && line.due_at == 0
        && line.tranche == 0
        && line.source == *source
        && line.reserved == [0; 1]
}

fn counter_range(class: u8) -> Option<core::ops::Range<usize>> {
    ((class as usize) < COUNTER_SLOTS).then(|| {
        let at = COUNTERS_AT + class as usize * LINE_LEN;
        at..at + LINE_LEN
    })
}

/// The counter line of `class` in a Source book account's data, if one was ever credited.
pub fn counter_get(data: &[u8], class: u8) -> Option<Line> {
    let line = Line::decode(data.get(counter_range(class)?)?);
    (line.p != 0).then_some(line)
}

/// Write the counter line of `class`. The caller has checked [`counter_line_ok`].
pub fn counter_put(data: &mut [u8], class: u8, line: &Line) -> bool {
    match counter_range(class).and_then(|r| data.get_mut(r)) {
        Some(slot) => {
            line.encode(slot);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::book::SourceBook;
    use crate::ledger::line_store::{CLASS_GENERAL, SIDE_OWN, SIDE_WON};
    use core::mem::{align_of, size_of};

    #[test]
    fn the_heads_have_no_alignment_or_padding() {
        assert_eq!(size_of::<BasketHead>(), HEADER_LEN);
        assert_eq!(size_of::<SpillHead>(), HEADER_LEN);
        assert_eq!(size_of::<SourceBookHead>(), BOOK_HEAD_LEN);
        assert_eq!(size_of::<CkptHead>(), 8);
        for a in [
            align_of::<BasketHead>(),
            align_of::<SpillHead>(),
            align_of::<SourceBookHead>(),
            align_of::<CkptHead>(),
        ] {
            assert_eq!(
                a, 1,
                "heads are plain bytes, whatever the platform tools do to u128"
            );
        }
    }

    #[test]
    fn offsets_of_the_source_book_head() {
        use core::mem::offset_of;
        assert_eq!(offset_of!(SourceBookHead, bump), 0);
        assert_eq!(offset_of!(SourceBookHead, version), 1);
        assert_eq!(offset_of!(SourceBookHead, source), 8);
        assert_eq!(offset_of!(CkptHead, bump), 0);
    }

    #[test]
    fn the_account_regions_follow_each_other() {
        assert_eq!(COUNTERS_AT, 48);
        assert_eq!(BOOK_AT, 48 + 3 * LINE_LEN);
        assert_eq!(SOURCE_BOOK_LEN, BOOK_AT + 594);
        assert_eq!(CKPT_ACCOUNT_LEN, 8 + 8 + 1_576);
        assert_eq!(store_len(0), 8 + 128);
    }

    #[test]
    fn what_a_cpi_creates_fits_the_10240_limit() {
        for (name, size) in [
            ("new basket", store_len(INITIAL_BASKET_LINES)),
            ("new spill", store_len(0)),
            ("sponsor", SponsorState::SPACE),
            ("source book", SOURCE_BOOK_LEN),
            ("checkpoint page", CKPT_ACCOUNT_LEN),
        ] {
            assert!(size <= 10_240, "{name} is {size} bytes");
        }
    }

    #[test]
    fn the_largest_stores_fit_the_account_size_limit() {
        assert!(store_len(MAX_BASKET_LINES) <= 10 * 1024 * 1024);
        assert!(store_len(MAX_SPILL_LINES) <= 10 * 1024 * 1024);
    }

    #[test]
    fn fee_classes_resolve_to_the_counter_or_a_studio_basket() {
        use FeeDestination::*;
        assert_eq!(fee_destination(CLASS_PLATFORM, false), Ok(Counter(0)));
        assert_eq!(fee_destination(CLASS_LEADERBOARD, false), Ok(Counter(2)));
        assert_eq!(fee_destination(CLASS_STUDIO, false), Ok(Counter(1)));
        assert_eq!(fee_destination(CLASS_STUDIO, true), Ok(Basket));
        // a second Platform or Leaderboard holder is refused
        assert_eq!(
            fee_destination(CLASS_PLATFORM, true),
            Err(FeeError::CounterOnly)
        );
        assert_eq!(
            fee_destination(CLASS_LEADERBOARD, true),
            Err(FeeError::CounterOnly)
        );
        assert_eq!(
            fee_destination(CLASS_GENERAL, false),
            Err(FeeError::NotFeeClass)
        );
    }

    #[test]
    fn baskets_never_hold_platform_or_leaderboard_lines() {
        let src = [7u8; 32];
        for (class, ok) in [
            (CLASS_PLATFORM, false),
            (CLASS_STUDIO, true),
            (CLASS_LEADERBOARD, false),
            (CLASS_GENERAL, true),
            (CLASS_GENERAL + 2, true),
        ] {
            let line = SourceBook::blank_line(SIDE_WON, 5, src, class, 0);
            assert_eq!(basket_may_hold(&line), ok, "class {class}");
        }
    }

    #[test]
    fn a_counter_line_has_exactly_one_key() {
        let src = [7u8; 32];
        let good = SourceBook::blank_line(SIDE_OWN, 0, src, CLASS_PLATFORM, 0);
        assert!(counter_line_ok(&src, CLASS_PLATFORM, &good));
        assert!(!counter_line_ok(&src, CLASS_LEADERBOARD, &good));
        assert!(!counter_line_ok(&[8; 32], CLASS_PLATFORM, &good));
        let mut won = good;
        won.side = SIDE_WON;
        assert!(!counter_line_ok(&src, CLASS_PLATFORM, &won));
        let mut late = good;
        late.due_at = 1;
        assert!(!counter_line_ok(&src, CLASS_PLATFORM, &late));
        let general = SourceBook::blank_line(SIDE_OWN, 0, src, CLASS_GENERAL, 0);
        assert!(!counter_line_ok(&src, CLASS_GENERAL, &general));
    }

    #[test]
    fn counter_slots_round_trip_and_start_empty() {
        let src = [7u8; 32];
        let mut data = vec![0u8; SOURCE_BOOK_LEN];
        for class in 0..3 {
            assert_eq!(counter_get(&data, class), None);
        }
        let mut line = SourceBook::blank_line(SIDE_OWN, 0, src, CLASS_STUDIO, 0);
        line.amount = 12;
        assert!(counter_put(&mut data, CLASS_STUDIO, &line));
        assert_eq!(counter_get(&data, CLASS_STUDIO), Some(line));
        assert_eq!(counter_get(&data, CLASS_PLATFORM), None);
        assert_eq!(counter_get(&data, CLASS_LEADERBOARD), None);
        assert_eq!(counter_get(&data, CLASS_GENERAL), None);
        assert!(!counter_put(&mut data, CLASS_GENERAL, &line));
    }
}

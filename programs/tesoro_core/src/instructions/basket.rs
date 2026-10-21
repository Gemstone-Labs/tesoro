//! Baskets and spills (grow, shrink, claim), the sponsor, Source books and checkpoint pages.
//!
//! * **Growth.** Anyone may grow a basket or spill with their own lamports (`grow_store`): the rent
//!   is a gift to the owner. The sponsor grows one from the program's own SOL
//!   (`grow_store_sponsored`) and only with the relayer's signature, within a per-Account and a
//!   total cap; the amount is recorded in the store's header and in the sponsor.
//! * **Shrink.** The owner (`shrink_store`) drops empty slots. The freed rent goes back to the
//!   sponsor first, up to what it paid for this Account, and the rest to the owner.
//! * **Claim.** `claim_spill` (anyone) moves spill lines into the basket while it has room. Never
//!   needed to play: the draw already spans both.
//!
//! All stores are read and written in place; see `crate::storage`.

use crate::books::OnchainBooks;
use crate::error::{core_err, BasketError, TesoroError};
use crate::ledger::book::{BookBytes, CLASS_LEN};
use crate::ledger::draw::{DrawError, Pool};
use crate::ledger::line_store::{LineStore, LineStoreError};
use crate::state::*;
use crate::storage::*;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

/// Which of an Account's two stores an instruction acts on.
#[derive(Clone, Copy, PartialEq, Eq, Debug, AnchorSerialize, AnchorDeserialize)]
pub enum StoreKind {
    Basket,
    Spill,
}

impl StoreKind {
    fn max_lines(self) -> usize {
        match self {
            StoreKind::Basket => MAX_BASKET_LINES,
            StoreKind::Spill => MAX_SPILL_LINES,
        }
    }
}

fn store_err(_: LineStoreError) -> Error {
    BasketError::BadStore.into()
}

fn ledger_err(e: DrawError) -> Error {
    match e {
        DrawError::Book(b) => core_err(b.into()),
        other => {
            msg!("draw refused: {:?}", other);
            BasketError::Ledger.into()
        }
    }
}

/// Lamports a store must receive to be rent exempt at `new_len` bytes.
pub(crate) fn top_up(info: &AccountInfo, new_len: usize) -> Result<u64> {
    Ok(Rent::get()?
        .minimum_balance(new_len)
        .saturating_sub(info.lamports()))
}

pub(crate) fn move_lamports(from: &AccountInfo, to: &AccountInfo, n: u64) -> Result<()> {
    let f = from
        .lamports()
        .checked_sub(n)
        .ok_or(BasketError::SponsorShort)?;
    let t = to
        .lamports()
        .checked_add(n)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    **from.try_borrow_mut_lamports()? = f;
    **to.try_borrow_mut_lamports()? = t;
    Ok(())
}

/// Sponsored rent one store holds.
fn sponsored_of(info: &AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    Ok(LineStore::new(&data[DISC..])
        .map_err(store_err)?
        .sponsored_lamports())
}

/// Format the fresh basket and spill of `account`: header only, bump and owner key. The
/// discriminators are written by Anchor when the loaders exit.
pub(crate) fn format_stores(
    basket: &AccountInfo,
    spill: &AccountInfo,
    account: &Pubkey,
    bumps: (u8, u8),
) -> Result<()> {
    let mut data = basket.try_borrow_mut_data()?;
    LineStore::init(&mut data[DISC..], account.to_bytes(), bumps.0).map_err(store_err)?;
    drop(data);
    let mut data = spill.try_borrow_mut_data()?;
    LineStore::init(&mut data[DISC..], account.to_bytes(), bumps.1).map_err(store_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Stores for an Account that already exists (Pool, Treasury, devnet Accounts)
// ---------------------------------------------------------------------------------------------

/// Creates the basket and spill of an existing Account. Anyone may pay. (`create_account` does
/// this itself for new Accounts.)
#[derive(Accounts)]
pub struct InitStores<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, account.authority.as_ref()],
        bump = account.bump
    )]
    pub account: Account<'info, TesoroAccount>,
    #[account(
        init,
        payer = payer,
        space = store_len(INITIAL_BASKET_LINES),
        seeds = [BASKET_SEED, account.key().as_ref()],
        bump
    )]
    pub basket: AccountLoader<'info, BasketHead>,
    #[account(
        init,
        payer = payer,
        space = store_len(0),
        seeds = [SPILL_SEED, account.key().as_ref()],
        bump
    )]
    pub spill: AccountLoader<'info, SpillHead>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn init_stores(ctx: Context<InitStores>) -> Result<()> {
    let account = ctx.accounts.account.key();
    format_stores(
        &ctx.accounts.basket.to_account_info(),
        &ctx.accounts.spill.to_account_info(),
        &account,
        (ctx.bumps.basket, ctx.bumps.spill),
    )
}

// ---------------------------------------------------------------------------------------------
// The sponsor
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitSponsor<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = admin,
        space = SponsorState::SPACE,
        seeds = [SPONSOR_SEED],
        bump
    )]
    pub sponsor: Account<'info, SponsorState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn init_sponsor(
    ctx: Context<InitSponsor>,
    relayer: Pubkey,
    per_account_cap: u64,
    total_cap: u64,
    pages_cap: u64,
) -> Result<()> {
    let sponsor = &mut ctx.accounts.sponsor;
    sponsor.bump = ctx.bumps.sponsor;
    sponsor.relayer = relayer;
    sponsor.paused = false;
    sponsor.per_account_cap = per_account_cap;
    sponsor.total_cap = total_cap;
    sponsor.outstanding = 0;
    sponsor.pages_cap = pages_cap;
    sponsor.pages_spent = 0;
    Ok(())
}

#[derive(Accounts)]
pub struct SetSponsor<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, SponsorState>,
}

pub(crate) fn set_sponsor(
    ctx: Context<SetSponsor>,
    relayer: Pubkey,
    paused: bool,
    per_account_cap: u64,
    total_cap: u64,
    pages_cap: u64,
) -> Result<()> {
    let sponsor = &mut ctx.accounts.sponsor;
    require!(
        total_cap >= sponsor.outstanding && pages_cap >= sponsor.pages_spent,
        BasketError::CapBelowOutstanding
    );
    sponsor.relayer = relayer;
    sponsor.paused = paused;
    sponsor.per_account_cap = per_account_cap;
    sponsor.total_cap = total_cap;
    sponsor.pages_cap = pages_cap;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Grow
// ---------------------------------------------------------------------------------------------

/// Slots and bytes after adding `extra` slots to `info`.
fn grow_target(info: &AccountInfo, which: StoreKind, extra: u32) -> Result<usize> {
    require!(extra > 0, BasketError::NothingToResize);
    require!(extra as usize <= MAX_GROW_LINES, BasketError::GrowTooLarge);
    let data = info.try_borrow_data()?;
    let capacity = LineStore::new(&data[DISC..]).map_err(store_err)?.capacity();
    let lines = capacity + extra as usize;
    require!(lines <= which.max_lines(), BasketError::StoreAtMaximum);
    Ok(lines)
}

fn resize(info: &AccountInfo, lines: usize) -> Result<()> {
    info.resize(store_len(lines))?;
    Ok(())
}

/// Grow your own or anyone's basket or spill with your own lamports: a gift to its owner.
#[derive(Accounts)]
pub struct GrowStore<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, account.authority.as_ref()],
        bump = account.bump
    )]
    pub account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [BASKET_SEED, account.key().as_ref()],
        bump = basket.load()?.raw[STORE_BUMP_AT]
    )]
    pub basket: AccountLoader<'info, BasketHead>,
    #[account(
        mut,
        seeds = [SPILL_SEED, account.key().as_ref()],
        bump = spill.load()?.raw[STORE_BUMP_AT]
    )]
    pub spill: AccountLoader<'info, SpillHead>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn grow_store(
    ctx: Context<GrowStore>,
    which: StoreKind,
    extra_lines: u32,
) -> Result<()> {
    let info = match which {
        StoreKind::Basket => ctx.accounts.basket.to_account_info(),
        StoreKind::Spill => ctx.accounts.spill.to_account_info(),
    };
    let lines = grow_target(&info, which, extra_lines)?;
    let delta = top_up(&info, store_len(lines))?;
    if delta > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: info.clone(),
                },
            ),
            delta,
        )?;
    }
    resize(&info, lines)
}

/// Grow a store with the sponsor's SOL. Needs the relayer's signature (the server decides who
/// deserves it: Accounts that hold Gemas, within its own per-day limits) and stays within the
/// per-Account cap (basket and spill together) and the total cap.
#[derive(Accounts)]
pub struct GrowStoreSponsored<'info> {
    pub relayer: Signer<'info>,
    #[account(
        mut,
        seeds = [SPONSOR_SEED],
        bump = sponsor.bump,
        constraint = sponsor.relayer == relayer.key() @ BasketError::NotSponsorRelayer
    )]
    pub sponsor: Account<'info, SponsorState>,
    #[account(
        seeds = [ACCOUNT_SEED, account.authority.as_ref()],
        bump = account.bump
    )]
    pub account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [BASKET_SEED, account.key().as_ref()],
        bump = basket.load()?.raw[STORE_BUMP_AT]
    )]
    pub basket: AccountLoader<'info, BasketHead>,
    #[account(
        mut,
        seeds = [SPILL_SEED, account.key().as_ref()],
        bump = spill.load()?.raw[STORE_BUMP_AT]
    )]
    pub spill: AccountLoader<'info, SpillHead>,
}

pub(crate) fn grow_store_sponsored(
    ctx: Context<GrowStoreSponsored>,
    which: StoreKind,
    extra_lines: u32,
) -> Result<()> {
    let basket = ctx.accounts.basket.to_account_info();
    let spill = ctx.accounts.spill.to_account_info();
    let info = match which {
        StoreKind::Basket => &basket,
        StoreKind::Spill => &spill,
    };
    let sponsor_info = ctx.accounts.sponsor.to_account_info();
    let sponsor = &mut ctx.accounts.sponsor;
    require!(!sponsor.paused, BasketError::SponsorPaused);
    let lines = grow_target(info, which, extra_lines)?;
    let delta = top_up(info, store_len(lines))?;
    let held = sponsored_of(&basket)?
        .checked_add(sponsored_of(&spill)?)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    require!(
        held.checked_add(delta)
            .is_some_and(|v| v <= sponsor.per_account_cap),
        BasketError::AccountSponsorCap
    );
    let outstanding = sponsor
        .outstanding
        .checked_add(delta)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    require!(
        outstanding <= sponsor.total_cap,
        BasketError::TotalSponsorCap
    );
    let keep = Rent::get()?.minimum_balance(sponsor_info.data_len());
    require!(
        sponsor_info.lamports().saturating_sub(delta) >= keep && sponsor_info.lamports() >= delta,
        BasketError::SponsorShort
    );
    move_lamports(&sponsor_info, info, delta)?;
    sponsor.outstanding = outstanding;
    resize(info, lines)?;
    let mut data = info.try_borrow_mut_data()?;
    let mut store = LineStore::new(&mut data[DISC..]).map_err(store_err)?;
    let now = store.sponsored_lamports();
    store.set_sponsored_lamports(
        now.checked_add(delta)
            .ok_or(ProgramError::ArithmeticOverflow)?,
    );
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Shrink
// ---------------------------------------------------------------------------------------------

/// The owner drops the free slots of a store, keeping `keep_free` of them. A spill also keeps the
/// slots reserved for Matches in flight. The rent freed goes to the sponsor first (up to what it
/// paid for this Account), then to the owner.
#[derive(Accounts)]
pub struct ShrinkStore<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, authority.key().as_ref()],
        bump = account.bump
    )]
    pub account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [BASKET_SEED, account.key().as_ref()],
        bump = basket.load()?.raw[STORE_BUMP_AT]
    )]
    pub basket: AccountLoader<'info, BasketHead>,
    #[account(
        mut,
        seeds = [SPILL_SEED, account.key().as_ref()],
        bump = spill.load()?.raw[STORE_BUMP_AT]
    )]
    pub spill: AccountLoader<'info, SpillHead>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, SponsorState>,
}

pub(crate) fn shrink_store(
    ctx: Context<ShrinkStore>,
    which: StoreKind,
    keep_free: u32,
) -> Result<()> {
    let info = match which {
        StoreKind::Basket => ctx.accounts.basket.to_account_info(),
        StoreKind::Spill => ctx.accounts.spill.to_account_info(),
    };
    let (lines, sponsored) = {
        let data = info.try_borrow_data()?;
        let store = LineStore::new(&data[DISC..]).map_err(store_err)?;
        let held_back = match which {
            StoreKind::Basket => 0,
            StoreKind::Spill => store.room_reserved() as usize,
        };
        let keep = store
            .len()
            .checked_add(held_back)
            .and_then(|n| n.checked_add(keep_free as usize))
            .ok_or(ProgramError::ArithmeticOverflow)?;
        require!(keep < store.capacity(), BasketError::NothingToResize);
        (keep, store.sponsored_lamports())
    };
    resize(&info, lines)?;
    let freed = info
        .lamports()
        .saturating_sub(Rent::get()?.minimum_balance(store_len(lines)));
    let refund = freed.min(sponsored);
    if refund > 0 {
        move_lamports(&info, &ctx.accounts.sponsor.to_account_info(), refund)?;
        let sponsor = &mut ctx.accounts.sponsor;
        sponsor.outstanding = sponsor.outstanding.saturating_sub(refund);
        let mut data = info.try_borrow_mut_data()?;
        let mut store = LineStore::new(&mut data[DISC..]).map_err(store_err)?;
        store.set_sponsored_lamports(sponsored - refund);
    }
    let rest = freed - refund;
    if rest > 0 {
        move_lamports(&info, &ctx.accounts.authority.to_account_info(), rest)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------------------------

/// Moves up to `max` lines from the spill into the basket, in the spill's order, while the basket
/// has room or a line to merge into. Anyone may call it. The Source books (and the checkpoint
/// pages their lines may need) of lines that merge are passed as remaining accounts.
#[derive(Accounts)]
pub struct ClaimSpill<'info> {
    #[account(
        seeds = [ACCOUNT_SEED, account.authority.as_ref()],
        bump = account.bump
    )]
    pub account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [BASKET_SEED, account.key().as_ref()],
        bump = basket.load()?.raw[STORE_BUMP_AT]
    )]
    pub basket: AccountLoader<'info, BasketHead>,
    #[account(
        mut,
        seeds = [SPILL_SEED, account.key().as_ref()],
        bump = spill.load()?.raw[STORE_BUMP_AT]
    )]
    pub spill: AccountLoader<'info, SpillHead>,
}

pub(crate) fn claim_spill<'info>(
    ctx: Context<'_, '_, 'info, 'info, ClaimSpill<'info>>,
    max: u8,
) -> Result<()> {
    let mut books = OnchainBooks::load(ctx.remaining_accounts)?;
    let basket_info = ctx.accounts.basket.to_account_info();
    let spill_info = ctx.accounts.spill.to_account_info();
    let mut basket_data = basket_info.try_borrow_mut_data()?;
    let mut spill_data = spill_info.try_borrow_mut_data()?;
    let mut basket = LineStore::new(&mut basket_data[DISC..]).map_err(store_err)?;
    let mut spill = LineStore::new(&mut spill_data[DISC..]).map_err(store_err)?;
    let mut pool = Pool::new(&mut basket, &mut spill);
    for _ in 0..max {
        let Some(line) = pool.spill.get(0) else { break };
        require!(basket_may_hold(&line), BasketError::FeeCounterOnly);
        if pool.claim(&mut books, 1).map_err(ledger_err)? == 0 {
            break;
        }
    }
    drop((basket_data, spill_data));
    books.flush()
}

// ---------------------------------------------------------------------------------------------
// Source books and checkpoint pages
// ---------------------------------------------------------------------------------------------

/// Creates the book account of a Source: the exact bookkeeping (`BookBytes`, no Extension) and
/// the slots of the Platform, Studio and Leaderboard counters. Anyone may pay.
#[derive(Accounts)]
pub struct InitSourceBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [SOURCE_SEED, source.inner.position.as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump
    )]
    pub source: Account<'info, SourceState>,
    #[account(
        init,
        payer = payer,
        space = SOURCE_BOOK_LEN,
        seeds = [BOOK_SEED, source.key().as_ref()],
        bump
    )]
    pub book: AccountLoader<'info, SourceBookHead>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn init_source_book(ctx: Context<InitSourceBook>) -> Result<()> {
    let source = ctx.accounts.source.key();
    {
        let mut head = ctx.accounts.book.load_init()?;
        head.bump = ctx.bumps.book;
        head.version = SOURCE_BOOK_VERSION;
        head.source = source.to_bytes();
    }
    let info = ctx.accounts.book.to_account_info();
    let mut data = info.try_borrow_mut_data()?;
    BookBytes::init(&mut data[BOOK_AT..]).map_err(|e| core_err(e.into()))?;
    Ok(())
}

/// The current number of closed segments (`ck`) of `class` in a Source book, or `None` if the
/// book has no such class.
fn class_ck(book: &[u8], class: u8) -> Option<u32> {
    let raw = book.get(BOOK_AT..)?;
    if raw.len() < crate::ledger::book::BOOK_FIXED_LEN {
        return None;
    }
    let n_classes = crate::ledger::line_store::CLASS_EXTENSION_BASE as usize
        + raw[crate::ledger::book::BOOK_FIXED_LEN - 1] as usize;
    if class as usize >= n_classes {
        return None;
    }
    let at = crate::ledger::book::BOOK_FIXED_LEN + class as usize * CLASS_LEN + 120;
    let mut ck = [0u8; 4];
    ck.copy_from_slice(raw.get(at..at + 4)?);
    Some(u32::from_le_bytes(ck))
}

/// Which pages may be created now for `class`: the one being filled and the next. Platform and
/// Leaderboard write no records.
fn page_allowed(book: &[u8], class: u8, page_no: u32) -> bool {
    use crate::ledger::book::checkpoint::PAGE_RECORDS;
    use crate::ledger::line_store::{CLASS_LEADERBOARD, CLASS_PLATFORM};
    if class == CLASS_PLATFORM || class == CLASS_LEADERBOARD {
        return false;
    }
    class_ck(book, class).is_some_and(|ck| {
        let current = ck / PAGE_RECORDS;
        page_no == current || page_no == current + 1
    })
}

/// Funds, allocates and assigns the page PDA (so a page someone pre-funded cannot block it).
fn create_page<'info>(
    page: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    (source, class, page_no, bump): (&Pubkey, u8, u32, u8),
) -> Result<()> {
    use crate::ledger::book::checkpoint::PageViewMut;
    let signer: &[&[&[u8]]] = &[&[
        CKPT_SEED,
        source.as_ref(),
        &[class],
        &page_no.to_le_bytes(),
        &[bump],
    ]];
    system_program::allocate(
        CpiContext::new_with_signer(
            system.clone(),
            system_program::Allocate {
                account_to_allocate: page.clone(),
            },
            signer,
        ),
        CKPT_ACCOUNT_LEN as u64,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(
            system.clone(),
            system_program::Assign {
                account_to_assign: page.clone(),
            },
            signer,
        ),
        &crate::ID,
    )?;
    let mut data = page.try_borrow_mut_data()?;
    data[..DISC].copy_from_slice(<CkptHead as anchor_lang::Discriminator>::DISCRIMINATOR);
    data[DISC] = bump;
    PageViewMut::init(
        &mut data[CKPT_PAGE_AT..],
        &source.to_bytes(),
        class,
        page_no,
    )
    .map_err(|e| core_err(e.into()))?;
    Ok(())
}

/// A page of a class's checkpoint records, paid for by `payer` (the party whose operation closes
/// segments pays; nothing is ever refunded, records are never dropped).
#[derive(Accounts)]
#[instruction(class: u8, page_no: u32)]
pub struct InitCkptPage<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [BOOK_SEED, book.load()?.source.as_ref()],
        bump = book.load()?.bump
    )]
    pub book: AccountLoader<'info, SourceBookHead>,
    /// CHECK: the page PDA, created here and checked against its seeds.
    #[account(mut)]
    pub page: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

fn page_seeds_check(
    book: &AccountLoader<SourceBookHead>,
    page: &AccountInfo,
    class: u8,
    page_no: u32,
) -> Result<(Pubkey, u8)> {
    let source = Pubkey::new_from_array(book.load()?.source);
    let (address, bump) = ckpt_address(&source, class, page_no);
    require_keys_eq!(address, *page.key, BasketError::BadCheckpointPage);
    require!(page.data_is_empty(), BasketError::BookExists);
    let data = book.to_account_info();
    let data = data.try_borrow_data()?;
    require!(page_allowed(&data, class, page_no), BasketError::WrongPage);
    Ok((source, bump))
}

pub(crate) fn init_ckpt_page(ctx: Context<InitCkptPage>, class: u8, page_no: u32) -> Result<()> {
    let (source, bump) = page_seeds_check(
        &ctx.accounts.book,
        &ctx.accounts.page.to_account_info(),
        class,
        page_no,
    )?;
    let page = ctx.accounts.page.to_account_info();
    let delta = top_up(&page, CKPT_ACCOUNT_LEN)?;
    if delta > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: page.clone(),
                },
            ),
            delta,
        )?;
    }
    create_page(
        &page,
        &ctx.accounts.system_program.to_account_info(),
        (&source, class, page_no, bump),
    )
}

/// The same page, paid by the sponsor within its pages cap; needs the relayer's signature.
#[derive(Accounts)]
#[instruction(class: u8, page_no: u32)]
pub struct InitCkptPageSponsored<'info> {
    /// Fronts the rent through the system program, and is made whole from the sponsor at once
    /// (the runtime does not let a program credit a system account and then allocate it).
    #[account(mut)]
    pub relayer: Signer<'info>,
    #[account(
        mut,
        seeds = [SPONSOR_SEED],
        bump = sponsor.bump,
        constraint = sponsor.relayer == relayer.key() @ BasketError::NotSponsorRelayer
    )]
    pub sponsor: Account<'info, SponsorState>,
    #[account(
        seeds = [BOOK_SEED, book.load()?.source.as_ref()],
        bump = book.load()?.bump
    )]
    pub book: AccountLoader<'info, SourceBookHead>,
    /// CHECK: the page PDA, created here and checked against its seeds.
    #[account(mut)]
    pub page: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn init_ckpt_page_sponsored(
    ctx: Context<InitCkptPageSponsored>,
    class: u8,
    page_no: u32,
) -> Result<()> {
    require!(!ctx.accounts.sponsor.paused, BasketError::SponsorPaused);
    let (source, bump) = page_seeds_check(
        &ctx.accounts.book,
        &ctx.accounts.page.to_account_info(),
        class,
        page_no,
    )?;
    let page = ctx.accounts.page.to_account_info();
    let sponsor_info = ctx.accounts.sponsor.to_account_info();
    let delta = top_up(&page, CKPT_ACCOUNT_LEN)?;
    let spent = ctx
        .accounts
        .sponsor
        .pages_spent
        .checked_add(delta)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    require!(
        spent <= ctx.accounts.sponsor.pages_cap,
        BasketError::TotalSponsorCap
    );
    let keep = Rent::get()?.minimum_balance(sponsor_info.data_len());
    require!(
        sponsor_info.lamports() >= delta && sponsor_info.lamports() - delta >= keep,
        BasketError::SponsorShort
    );
    if delta > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.relayer.to_account_info(),
                    to: page.clone(),
                },
            ),
            delta,
        )?;
    }
    create_page(
        &page,
        &ctx.accounts.system_program.to_account_info(),
        (&source, class, page_no, bump),
    )?;
    move_lamports(
        &sponsor_info,
        &ctx.accounts.relayer.to_account_info(),
        delta,
    )?;
    ctx.accounts.sponsor.pages_spent = spent;
    Ok(())
}

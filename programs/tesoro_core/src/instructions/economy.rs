//! What every instruction that touches a Source shares (economy upgrade, ticket 11): the rate of
//! the moment per kind of Position, the custody's route, how a payout leaves it, and the glue
//! between a Source's book, the checkpoint pages and an Account's basket.
//!
//! # Remaining accounts of a Source-touching instruction
//!
//! ```text
//! [ the kind's accounts ][ book of the Source, then its checkpoint pages (any order) ]
//! ```
//!
//! The kind's accounts depend on the Position (`KindCtx::load`):
//!
//! | kind | not paying | paying |
//! |---|---|---|
//! | native | `[custody, pool]` | `[custody, vault, pool, destination, mint, yield_config, yield_authority, sim_lst_program, token_program]` |
//! | stake | `[custody, stake_pool]` | `[custody, stake_pool, vault, destination, token_program]` |
//! | reported | none | none |
//!
//! The book of the Source and the pages its lines may need follow (`OnchainBooks`). Every
//! instruction syncs the Source first (lands what it has earned) so the figures it acts on are
//! current.

use crate::books::OnchainBooks;
use crate::error::{core_err, BasketError, TesoroError};
use crate::ledger::draw::{DrawError, Pool, SourceBooks};
use crate::ledger::line_store::{LineKey, LineStore, LineStoreError};
use crate::ledger::{
    self, native, parse_stake_pool, CoreError, CustodyKind, Position, RouteLedger, ShareRate,
    StakePoolRead,
};
use crate::state::*;
use crate::storage::*;
use crate::util::now;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, TokenAccount};
use sim_lst::Pool as SimPool;

/// Names one line of a Source in an Account's basket or spill: the rest of its key is the Source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct LineRef {
    /// 0 = the owner's own Gemas, 1 = won Gemas.
    pub side: u8,
    pub due_at: i64,
    pub class: u8,
    pub tranche: u8,
}

impl LineRef {
    pub fn key(&self, source: &Pubkey) -> LineKey {
        LineKey {
            side: self.side,
            due_at: self.due_at,
            source: source.to_bytes(),
            class: self.class,
            tranche: self.tranche,
        }
    }
}

pub(crate) fn store_err(_: LineStoreError) -> Error {
    BasketError::BadStore.into()
}

pub(crate) fn draw_err(e: DrawError) -> Error {
    match e {
        DrawError::Book(b) => core_err(b.into()),
        DrawError::SpillFull => core_err(CoreError::SpillFull),
        DrawError::WouldBreakReservation => core_err(CoreError::ReservedGemas),
        DrawError::InsufficientGemas => core_err(CoreError::InsufficientGemas),
        DrawError::ZeroAmount => core_err(CoreError::ZeroAmount),
        other => {
            msg!("draw refused: {:?}", other);
            BasketError::Ledger.into()
        }
    }
}

pub(crate) fn book_err(e: ledger::book::BookError) -> Error {
    core_err(e.into())
}

/// Runs `f` over the Account's basket and spill, read and written in place.
pub(crate) fn with_pool<R>(
    basket: &AccountInfo,
    spill: &AccountInfo,
    f: impl FnOnce(&mut Pool<&mut [u8], &mut [u8]>) -> Result<R>,
) -> Result<R> {
    let mut b = basket.try_borrow_mut_data()?;
    let mut s = spill.try_borrow_mut_data()?;
    let mut basket = LineStore::new(&mut b[DISC..]).map_err(store_err)?;
    let mut spill = LineStore::new(&mut s[DISC..]).map_err(store_err)?;
    let mut pool = Pool::new(&mut basket, &mut spill);
    f(&mut pool)
}

/// [`with_pool`] for a holder of slots (an Entry Ticket, a Match): `hold` is its share of the
/// spill header's `room_reserved`. The lines `f` puts back may use it, each new slot paying it
/// down; every whole line `f` takes off the pool frees a slot, which becomes part of the hold (the
/// header grows by the same number), so what left the pool can always come back.
pub(crate) fn with_pool_hold<R>(
    basket: &AccountInfo,
    spill: &AccountInfo,
    hold: &mut u32,
    f: impl FnOnce(&mut Pool<&mut [u8], &mut [u8]>) -> Result<R>,
) -> Result<R> {
    with_pool(basket, spill, |pool| {
        pool.set_hold(*hold);
        let out = f(pool)?;
        let freed = pool.freed_to_hold();
        let held = pool.spill.room_reserved();
        pool.spill.set_room_reserved(
            held.checked_add(freed)
                .ok_or(ProgramError::ArithmeticOverflow)?,
        );
        *hold = pool
            .hold_left()
            .checked_add(freed)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        Ok(out)
    })
}

// ---------------------------------------------------------------------------------------------
// The rate of the moment
// ---------------------------------------------------------------------------------------------

/// Everything the ledger needs to know about the moment, by kind of Position.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Rates {
    /// Net Accrued Yield of the Position, source-asset units.
    pub net: u64,
    /// The Position's Yield Fee on its Accrued Yield, units.
    pub fee_units: u64,
    pub rate: ShareRate,
    /// How much faster the planned-repayment clock runs than the wall clock.
    pub speedup: u32,
}

pub(crate) fn native_rates(position: &Position, pool: &SimPool) -> Result<Rates> {
    let ts = now()?;
    let a = native::position_accrued(position, pool.speedup, ts).map_err(core_err)?;
    let rate = sim_lst::current_rate(pool, ts)?;
    Ok(Rates {
        net: a.net,
        fee_units: a.fee,
        rate: ShareRate::native(rate).map_err(core_err)?,
        speedup: pool.speedup,
    })
}

pub(crate) fn stake_rates(position: &Position, rate: u64) -> Result<Rates> {
    let a = ledger::stake_position_accrued(position, rate).map_err(core_err)?;
    Ok(Rates {
        net: a.net,
        fee_units: a.fee,
        rate: ShareRate::stake(rate).map_err(core_err)?,
        speedup: 1,
    })
}

/// Reported Positions: yield is the cumulative figure of the latest applied Yield Report, a share
/// is one unit of the Source asset.
pub(crate) fn reported_rates(position: &Position) -> Rates {
    Rates {
        net: position.cumulative_yield,
        fee_units: 0,
        rate: ShareRate::reported(),
        speedup: 1,
    }
}

pub(crate) fn kind_of(position: &Position) -> CustodyKind {
    if super::native::is_native(position) {
        CustodyKind::Native
    } else if super::native::is_stake(position) {
        CustodyKind::Stake
    } else {
        CustodyKind::Reported
    }
}

// ---------------------------------------------------------------------------------------------
// Kind accounts
// ---------------------------------------------------------------------------------------------

/// Where a payout goes.
#[derive(Clone, Copy)]
pub(crate) enum PayTo<'a> {
    /// The instruction pays nothing (return_own, Extend, an Advance, harvest): the shorter layout.
    Nobody,
    /// A wallet's token account (its owner must be this wallet).
    Wallet(&'a Pubkey),
    /// One fixed token account (the Treasury's vault).
    Vault(&'a Pubkey),
}

pub(crate) struct NativePay<'info> {
    pub vault: &'info AccountInfo<'info>,
    pub y: super::native::YieldMint<'info>,
}

pub(crate) struct StakePay<'info> {
    pub vault: &'info AccountInfo<'info>,
    pub destination: Account<'info, TokenAccount>,
    pub token_program: &'info AccountInfo<'info>,
}

#[allow(clippy::large_enum_variant)]
pub(crate) enum KindCtx<'info> {
    Native {
        custody: Account<'info, NativeCustody>,
        pool: Account<'info, SimPool>,
        pay: Option<NativePay<'info>>,
    },
    Stake {
        custody: Account<'info, StakeCustody>,
        rate: u64,
        pay: Option<StakePay<'info>>,
    },
    Reported,
}

/// A stake pool account checked against its custody and not stale.
pub(crate) fn read_pool(info: &AccountInfo, custody: &StakeCustody) -> Result<StakePoolRead> {
    require_keys_eq!(*info.key, custody.pool, TesoroError::BadStakePoolAccount);
    require!(
        super::stake::STAKE_POOL_PROGRAMS.contains(info.owner),
        TesoroError::BadStakePoolAccount
    );
    let read = parse_stake_pool(&info.try_borrow_data()?).map_err(core_err)?;
    require!(
        read.pool_mint == custody.mint.to_bytes(),
        TesoroError::BadStakePoolAccount
    );
    read.require_fresh(Clock::get()?.epoch).map_err(core_err)?;
    Ok(read)
}

pub(crate) fn load_stake_custody<'info>(
    info: &'info AccountInfo<'info>,
) -> Result<Account<'info, StakeCustody>> {
    require!(info.is_writable, TesoroError::NotWritable);
    let custody = Account::<StakeCustody>::try_from(info)?;
    let expected = Pubkey::create_program_address(
        &[STAKE_CUSTODY_SEED, custody.mint.as_ref(), &[custody.bump]],
        &crate::ID,
    )
    .map_err(|_| error!(TesoroError::InvalidAccount))?;
    require_keys_eq!(expected, *info.key, TesoroError::InvalidAccount);
    Ok(custody)
}

pub(crate) fn wallet_token<'info>(
    info: &'info AccountInfo<'info>,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Result<Account<'info, TokenAccount>> {
    require!(info.is_writable, TesoroError::NotWritable);
    let t = Account::<TokenAccount>::try_from(info)?;
    require_keys_eq!(t.mint, *mint, TesoroError::InvalidMint);
    require_keys_eq!(t.owner, *owner, TesoroError::InvalidAccount);
    Ok(t)
}

impl<'info> KindCtx<'info> {
    /// Splits `remaining` into the kind's accounts (see the module docs) and the rest, checks them
    /// and reads the rate. `pay` says whether the instruction pays out and to whom.
    pub fn load(
        position: &Position,
        remaining: &'info [AccountInfo<'info>],
        pay: PayTo,
    ) -> Result<(Self, &'info [AccountInfo<'info>])> {
        match kind_of(position) {
            CustodyKind::Reported => Ok((Self::Reported, remaining)),
            CustodyKind::Native => Self::load_native(remaining, pay),
            CustodyKind::Stake => {
                let (kind, rest) = Self::load_stake(remaining, pay)?;
                if let Self::Stake { custody, .. } = &kind {
                    require!(
                        custody.mint.to_bytes() == position.source_asset,
                        TesoroError::InvalidMint
                    );
                }
                Ok((kind, rest))
            }
        }
    }

    /// For instructions that have no Position (prize Redeem, funding): the first remaining
    /// account is the custody, whose type decides the layout.
    pub fn load_route(
        remaining: &'info [AccountInfo<'info>],
        pay: PayTo,
    ) -> Result<(Self, &'info [AccountInfo<'info>])> {
        use anchor_lang::Discriminator;
        let first = remaining
            .first()
            .ok_or_else(|| error!(TesoroError::BadRemainingAccounts))?;
        let data = first.try_borrow_data()?;
        let disc = data.get(..8).unwrap_or(&[]);
        let native = disc == NativeCustody::DISCRIMINATOR;
        let stake = disc == StakeCustody::DISCRIMINATOR;
        drop(data);
        if native {
            Self::load_native(remaining, pay)
        } else if stake {
            Self::load_stake(remaining, pay)
        } else {
            err!(TesoroError::InvalidAccount)
        }
    }

    fn load_native(
        remaining: &'info [AccountInfo<'info>],
        pay: PayTo,
    ) -> Result<(Self, &'info [AccountInfo<'info>])> {
        use super::native::{
            load_custody as load_native_custody, load_pool, load_yield_mint, Payee,
            YIELD_MINT_ACCOUNTS,
        };
        let paying = !matches!(pay, PayTo::Nobody);
        let n = if paying { 2 + YIELD_MINT_ACCOUNTS } else { 2 };
        require!(remaining.len() >= n, TesoroError::BadRemainingAccounts);
        let (head, rest) = remaining.split_at(n);
        let custody = load_native_custody(&head[0])?;
        if !paying {
            let pool = load_pool(&head[1])?;
            require_keys_eq!(custody.pool, pool.key(), TesoroError::InvalidPool);
            return Ok((
                Self::Native {
                    custody,
                    pool,
                    pay: None,
                },
                rest,
            ));
        }
        let vault = &head[1];
        require_keys_eq!(*vault.key, custody.vault, TesoroError::InvalidAccount);
        require!(vault.is_writable, TesoroError::NotWritable);
        let payee = match pay {
            PayTo::Wallet(w) => Payee::Wallet(w),
            PayTo::Vault(v) => Payee::Vault(v),
            PayTo::Nobody => return err!(TesoroError::BadRemainingAccounts),
        };
        let y = load_yield_mint(&head[2..], payee)?;
        require_keys_eq!(y.pool.key(), custody.pool, TesoroError::InvalidPool);
        let pool = load_pool(&head[2])?;
        Ok((
            Self::Native {
                custody,
                pool,
                pay: Some(NativePay { vault, y }),
            },
            rest,
        ))
    }

    fn load_stake(
        remaining: &'info [AccountInfo<'info>],
        pay: PayTo,
    ) -> Result<(Self, &'info [AccountInfo<'info>])> {
        let paying = !matches!(pay, PayTo::Nobody);
        let n = if paying { 5 } else { 2 };
        require!(remaining.len() >= n, TesoroError::BadRemainingAccounts);
        let (head, rest) = remaining.split_at(n);
        let custody = load_stake_custody(&head[0])?;
        let read = read_pool(&head[1], &custody)?;
        let rate = read.rate().map_err(core_err)?;
        let pay = match pay {
            PayTo::Nobody => None,
            PayTo::Wallet(w) => Some(stake_pay(&custody, head, Some(w), None)?),
            PayTo::Vault(v) => Some(stake_pay(&custody, head, None, Some(v))?),
        };
        Ok((Self::Stake { custody, rate, pay }, rest))
    }

    pub fn custody_kind(&self) -> CustodyKind {
        match self {
            Self::Native { .. } => CustodyKind::Native,
            Self::Stake { .. } => CustodyKind::Stake,
            Self::Reported => CustodyKind::Reported,
        }
    }

    /// The rates of this moment for `position`.
    pub fn rates(&self, position: &Position) -> Result<Rates> {
        match self {
            Self::Native { pool, .. } => native_rates(position, pool),
            Self::Stake { rate, .. } => stake_rates(position, *rate),
            Self::Reported => Ok(reported_rates(position)),
        }
    }

    pub fn route(&self) -> Option<&RouteLedger> {
        match self {
            Self::Native { custody, .. } => Some(&custody.route),
            Self::Stake { custody, .. } => Some(&custody.route),
            Self::Reported => None,
        }
    }

    pub fn route_mut(&mut self) -> Option<&mut RouteLedger> {
        match self {
            Self::Native { custody, .. } => Some(&mut custody.route),
            Self::Stake { custody, .. } => Some(&mut custody.route),
            Self::Reported => None,
        }
    }

    pub fn custody_key(&self) -> Option<Pubkey> {
        match self {
            Self::Native { custody, .. } => Some(custody.key()),
            Self::Stake { custody, .. } => Some(custody.key()),
            Self::Reported => None,
        }
    }

    /// Sends `shares` to the payee: simSOL minted at payout (native) or tokens out of the custody
    /// vault (stake). Reported Sources are paid by the bridge, never here.
    pub fn pay_shares(&self, position: &Pubkey, shares: u64, code: u8) -> Result<()> {
        if shares == 0 {
            return Ok(());
        }
        match self {
            Self::Native { pay: Some(p), .. } => p.y.pay_shares(position, shares, code),
            Self::Stake {
                custody,
                pay: Some(p),
                rate,
            } => {
                super::stake::pay_tokens(
                    custody,
                    p.vault,
                    &p.destination.to_account_info(),
                    p.token_program,
                    shares,
                )?;
                emit!(StakePayout {
                    position: *position,
                    to: p.destination.key(),
                    shares,
                    sol_units: ledger::units_for_tokens(shares, *rate).unwrap_or(0),
                    kind: code,
                });
                Ok(())
            }
            // A Position the oracle reports on Solana (test mode) is paid off chain: the Gemas are
            // burned and `Redeemed` is the seam. EVM Sources are redeemed through the bridge.
            Self::Reported => Ok(()),
            _ => err!(TesoroError::BadRemainingAccounts),
        }
    }

    /// Returns custody shares (Principal at Unlock) from the vault to the payee.
    pub fn pay_custody(&self, position: &Pubkey, shares: u64) -> Result<()> {
        if shares == 0 {
            return Ok(());
        }
        match self {
            Self::Native {
                custody,
                pay: Some(p),
                ..
            } => p.y.transfer_from_vault(p.vault, custody, shares, position),
            Self::Stake { .. } => self.pay_shares(position, shares, 1),
            _ => err!(TesoroError::BadRemainingAccounts),
        }
    }

    /// Writes the custody (and with it the route) back.
    pub fn exit(&self) -> Result<()> {
        match self {
            Self::Native { custody, .. } => custody.exit(&crate::ID),
            Self::Stake { custody, .. } => custody.exit(&crate::ID),
            Self::Reported => Ok(()),
        }
    }
}

fn stake_pay<'info>(
    custody: &StakeCustody,
    head: &'info [AccountInfo<'info>],
    wallet: Option<&Pubkey>,
    vault_token: Option<&Pubkey>,
) -> Result<StakePay<'info>> {
    let vault = &head[2];
    require_keys_eq!(*vault.key, custody.vault, TesoroError::InvalidAccount);
    require!(vault.is_writable, TesoroError::NotWritable);
    require_keys_eq!(*head[4].key, token::ID, TesoroError::InvalidAccount);
    let destination = match (wallet, vault_token) {
        (Some(w), _) => wallet_token(&head[3], &custody.mint, w)?,
        (None, Some(v)) => {
            require_keys_eq!(*head[3].key, *v, TesoroError::InvalidAccount);
            require!(head[3].is_writable, TesoroError::NotWritable);
            let t = Account::<TokenAccount>::try_from(&head[3])?;
            require_keys_eq!(t.mint, custody.mint, TesoroError::InvalidMint);
            t
        }
        (None, None) => return err!(TesoroError::BadRemainingAccounts),
    };
    Ok(StakePay {
        vault,
        destination,
        token_program: &head[4],
    })
}

// ---------------------------------------------------------------------------------------------
// Source, book, line
// ---------------------------------------------------------------------------------------------

/// A Source of `position` at its PDA (not necessarily writable): used where it is only read.
pub(crate) fn read_source<'info>(
    info: &'info AccountInfo<'info>,
    position: &Pubkey,
    index: u32,
) -> Result<Account<'info, SourceState>> {
    let source = Account::<SourceState>::try_from(info)?;
    let expected = Pubkey::create_program_address(
        &[
            SOURCE_SEED,
            position.as_ref(),
            &index.to_le_bytes(),
            &[source.bump],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(TesoroError::InvalidAccount))?;
    require_keys_eq!(expected, *info.key, TesoroError::InvalidAccount);
    require_eq!(source.inner.index, index, TesoroError::InvalidAccount);
    require!(
        source.inner.position == position.to_bytes(),
        TesoroError::InvalidAccount
    );
    Ok(source)
}

/// Lands what the Position's open Advance has earned, in `source`'s book.
pub(crate) fn sync_in_books<'a, 'info>(
    books: &mut OnchainBooks<'a, 'info>,
    position: &mut PositionState,
    source: &SourceState,
    source_key: &Pubkey,
    rates: &Rates,
) -> Result<()> {
    let (book, ck) = books
        .book_with_history(&source_key.to_bytes())
        .map_err(draw_err)?;
    ledger::economy::sync_source(
        &mut position.inner,
        &source.inner,
        book,
        rates.net,
        &rates.rate,
        ck,
    )
    .map_err(core_err)?;
    Ok(())
}

/// Where a line is: the basket or the spill.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Where {
    Basket,
    Spill,
}

pub(crate) fn find_line<B: ledger::draw::Bytes, S: ledger::draw::Bytes>(
    pool: &Pool<B, S>,
    key: &LineKey,
) -> Option<(Where, usize, ledger::line_store::Line)> {
    if let Ok(i) = pool.basket.find(key) {
        return pool.basket.get(i).map(|l| (Where::Basket, i, l));
    }
    if let Ok(i) = pool.spill.find(key) {
        return pool.spill.get(i).map(|l| (Where::Spill, i, l));
    }
    None
}

/// Writes `line` back where it was found, removing it when it is empty. Never needs room.
pub(crate) fn store_line<B: ledger::draw::Bytes, S: ledger::draw::Bytes>(
    pool: &mut Pool<B, S>,
    at: Where,
    idx: usize,
    line: &ledger::line_store::Line,
) -> Result<()> {
    let r = match (at, line.amount == 0) {
        (Where::Basket, true) => pool.basket.remove_at(idx).map(drop),
        (Where::Basket, false) => pool.basket.set_line(idx, line),
        (Where::Spill, true) => pool.spill.remove_at(idx).map(drop),
        (Where::Spill, false) => pool.spill.set_line(idx, line),
    };
    r.map_err(store_err)
}

/// What a Redeem of one line did.
pub(crate) struct RedeemOut {
    pub gemas: u64,
    pub shares: u64,
    pub units: u64,
}

/// Redeems `k` ready Gemas of the line `key` from `pool`: syncs the Source, takes the Gemas out of
/// the line and accounts the shares they are paid (the Position's held shares while it is Locked,
/// the route's owed shares once Unlocked). The caller pays the shares out.
#[allow(clippy::too_many_arguments)]
pub(crate) fn redeem_line<'a, 'info>(
    pool: &mut Pool<&mut [u8], &mut [u8]>,
    books: &mut OnchainBooks<'a, 'info>,
    kind: &mut KindCtx<'info>,
    position: &mut PositionState,
    source: &mut SourceState,
    source_key: &Pubkey,
    key: &LineKey,
    k: u64,
) -> Result<RedeemOut> {
    let rates = kind.rates(&position.inner)?;
    sync_in_books(books, position, source, source_key, &rates)?;
    let (at, idx, mut line) =
        find_line(pool, key).ok_or_else(|| core_err(CoreError::HoldingMismatch))?;
    if k > line.amount {
        return Err(core_err(CoreError::InsufficientGemas));
    }
    if line.is_playable() {
        pool.check_withdraw(k).map_err(draw_err)?;
    }
    let (book, ck) = books
        .book_with_history(&source_key.to_bytes())
        .map_err(draw_err)?;
    let r = book.redeem(&mut line, k, &*ck).map_err(book_err)?;
    store_line(pool, at, idx, &line)?;
    let paid = u64::try_from(r.shares).map_err(|_| core_err(CoreError::Math))?;
    let kind_tag = kind.custody_kind();
    ledger::economy::debit_paid_shares(&mut position.inner, kind_tag, kind.route_mut(), paid)
        .map_err(core_err)?;
    let units = u64::try_from(
        rates
            .rate
            .units_for_shares(u128::from(paid))
            .map_err(core_err)?,
    )
    .map_err(|_| core_err(CoreError::Math))?;
    source.inner.redeemed = source
        .inner
        .redeemed
        .checked_add(k)
        .ok_or_else(|| core_err(CoreError::Math))?;
    source.inner.redeemed_units = source
        .inner
        .redeemed_units
        .checked_add(units)
        .ok_or_else(|| core_err(CoreError::Math))?;
    Ok(RedeemOut {
        gemas: k,
        shares: paid,
        units,
    })
}

// ---------------------------------------------------------------------------------------------
// A new Advance
// ---------------------------------------------------------------------------------------------

/// A Source's book that only exists in this transaction: a new Advance's line is credited to the
/// owner's basket without reading any account.
pub(crate) struct NewBook<'a> {
    pub book: &'a mut ledger::book::SourceBook,
    pub ck: ledger::book::checkpoint::NoCheckpoints,
}

impl SourceBooks for NewBook<'_> {
    fn book_mut(
        &mut self,
        _source: &ledger::Key,
    ) -> ledger::draw::DrawResult<&mut ledger::book::SourceBook> {
        Ok(self.book)
    }

    fn book_with_history(
        &mut self,
        _source: &ledger::Key,
    ) -> ledger::draw::DrawResult<(
        &mut ledger::book::SourceBook,
        &mut dyn ledger::book::checkpoint::CheckpointStore,
    )> {
        Ok((&mut *self.book, &mut self.ck))
    }
}

pub(crate) struct NewAdvance<'a, 'info> {
    pub position: &'a mut Account<'info, PositionState>,
    pub source: &'a mut Account<'info, SourceState>,
    pub source_bump: u8,
    pub book: &'a AccountLoader<'info, SourceBookHead>,
    pub book_bump: u8,
    pub basket: &'a AccountInfo<'info>,
    pub spill: &'a AccountInfo<'info>,
}

/// Opens the Position's Advance: first closes the previous one (its Debt must be zero; its
/// Source, book and pages are the first remaining accounts) or banks the idle yield, then creates
/// the Source's book and credits the new Gemas, as one General line, to the owner's basket.
pub(crate) fn begin_advance<'a, 'info>(
    a: NewAdvance<'a, 'info>,
    rates: &Rates,
    books_tail: &'info [AccountInfo<'info>],
    horizon_months: u8,
    price_micro_usd: u64,
    yield_fee_bps: u16,
) -> Result<()> {
    use ledger::book::checkpoint::NoCheckpoints;
    use ledger::book::{ClassArray, SourceBook};
    let position_key = a.position.key();
    match a.position.inner.open_advance {
        Some(index) => {
            let [prev_info, rest @ ..] = books_tail else {
                return err!(TesoroError::SourceRequired);
            };
            let prev = read_source(prev_info, &position_key, index)?;
            let prev_key = prev.key();
            let mut books = OnchainBooks::load(rest)?;
            {
                let (book, ck) = books
                    .book_with_history(&prev_key.to_bytes())
                    .map_err(draw_err)?;
                ledger::economy::prepare_advance(
                    &mut a.position.inner,
                    Some((&prev.inner, book, ck)),
                    rates.net,
                    &rates.rate,
                )
                .map_err(core_err)?;
            }
            books.flush()?;
        }
        None => ledger::economy::prepare_advance::<ClassArray, NoCheckpoints>(
            &mut a.position.inner,
            None,
            rates.net,
            &rates.rate,
        )
        .map_err(core_err)?,
    }
    let mut src = a
        .position
        .inner
        .open_advance(
            position_key.to_bytes(),
            horizon_months,
            price_micro_usd,
            yield_fee_bps,
        )
        .map_err(core_err)?;
    src.due_at =
        ledger::economy::planned_due_at(now()?, horizon_months, rates.speedup).map_err(core_err)?;
    let source_key = a.source.key();
    let mut book = Box::new(SourceBook::new());
    let line =
        ledger::economy::advance_line(&mut *book, source_key.to_bytes(), &src, &NoCheckpoints)
            .map_err(core_err)?;
    {
        let mut head = a.book.load_init()?;
        head.bump = a.book_bump;
        head.version = SOURCE_BOOK_VERSION;
        head.source = source_key.to_bytes();
    }
    {
        let info = a.book.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        book.encode(&mut data[BOOK_AT..]).map_err(book_err)?;
    }
    with_pool(a.basket, a.spill, |pool| {
        pool.put(
            &mut NewBook {
                book: &mut book,
                ck: NoCheckpoints,
            },
            &line,
        )
        .map(drop)
        .map_err(draw_err)
    })?;
    let gemas = src.issued;
    a.source.bump = a.source_bump;
    a.source.inner = src;
    emit!(AdvanceIssued {
        position: position_key,
        source: source_key,
        gemas,
        horizon_months,
        price_micro_usd,
    });
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Extend
// ---------------------------------------------------------------------------------------------

pub(crate) struct ExtendAccounts<'a, 'info> {
    pub position: &'a mut Account<'info, PositionState>,
    pub source: &'a mut Account<'info, SourceState>,
    pub payer: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
    pub basket: AccountInfo<'info>,
    pub spill: AccountInfo<'info>,
}

/// Grows the Source's book account by one class (rent from `payer`) before an Extension starts.
fn grow_book_for_extension<'info>(
    books: &'info [AccountInfo<'info>],
    source_key: &Pubkey,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
) -> Result<()> {
    let (address, _) = book_address(source_key);
    let info = books
        .iter()
        .find(|i| *i.key == address)
        .ok_or_else(|| error!(BasketError::BookMissing))?;
    require!(info.is_writable, BasketError::AccountNotWritable);
    let n_ext = {
        let data = info.try_borrow_data()?;
        require!(
            data.len() > BOOK_AT + ledger::book::BOOK_FIXED_LEN,
            BasketError::BadSourceBook
        );
        data[BOOK_AT + ledger::book::BOOK_FIXED_LEN - 1]
    };
    let new_len = BOOK_AT + ledger::book::encoded_len(n_ext.saturating_add(1));
    if new_len <= info.data_len() {
        return Ok(());
    }
    let delta = Rent::get()?
        .minimum_balance(new_len)
        .saturating_sub(info.lamports());
    if delta > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                system_program.clone(),
                anchor_lang::system_program::Transfer {
                    from: payer.clone(),
                    to: info.clone(),
                },
            ),
            delta,
        )?;
    }
    info.resize(new_len)?;
    Ok(())
}

/// Extends the open Advance: lands what it has earned, starts the next Extension tranche and
/// credits its Gemas to the owner's basket.
pub(crate) fn extend_open_advance<'a, 'info>(
    a: ExtendAccounts<'a, 'info>,
    rates: &Rates,
    books_all: &'info [AccountInfo<'info>],
    extra_months: u8,
    yield_fee_bps: u16,
) -> Result<()> {
    let position_key = a.position.key();
    let source_key = a.source.key();
    require!(
        a.position.inner.open_advance == Some(a.source.inner.index),
        TesoroError::InvalidAccount
    );
    let mut books = OnchainBooks::load(books_all)?;
    let (line, minted) = {
        let (book, ck) = books
            .book_with_history(&source_key.to_bytes())
            .map_err(draw_err)?;
        ledger::economy::extend_source(
            &mut a.position.inner,
            &mut a.source.inner,
            source_key.to_bytes(),
            book,
            extra_months,
            yield_fee_bps,
            rates.speedup,
            rates.net,
            &rates.rate,
            ck,
        )
        .map_err(core_err)?
    };
    with_pool(&a.basket, &a.spill, |pool| {
        pool.put(&mut books, &line).map(drop).map_err(draw_err)
    })?;
    // The book gains one class: the account grows (rent from the payer) before it is written back.
    grow_book_for_extension(books_all, &source_key, &a.payer, &a.system_program)?;
    books.flush()?;
    emit!(AdvanceExtended {
        position: position_key,
        source: source_key,
        gemas: minted,
        extra_months,
        horizon_months: a.source.inner.horizon_months,
    });
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// return_own
// ---------------------------------------------------------------------------------------------

/// `return_own` of `k` of the owner's own Gemas on line `key`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn return_own_line<'a, 'info>(
    pool: &mut Pool<&mut [u8], &mut [u8]>,
    books: &mut OnchainBooks<'a, 'info>,
    position: &mut PositionState,
    source: &mut SourceState,
    source_key: &Pubkey,
    key: &LineKey,
    k: u64,
    rates: &Rates,
) -> Result<()> {
    let (at, idx, mut line) =
        find_line(pool, key).ok_or_else(|| core_err(CoreError::HoldingMismatch))?;
    if k > line.amount {
        return Err(core_err(CoreError::InsufficientGemas));
    }
    pool.check_withdraw(k).map_err(draw_err)?;
    let (book, ck) = books
        .book_with_history(&source_key.to_bytes())
        .map_err(draw_err)?;
    ledger::economy::return_own_source(
        &mut position.inner,
        &mut source.inner,
        book,
        &mut line,
        k,
        rates.net,
        &rates.rate,
        ck,
    )
    .map_err(core_err)?;
    store_line(pool, at, idx, &line)
}

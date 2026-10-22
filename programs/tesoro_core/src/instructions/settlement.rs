//! The accounts a settle or refund chunk reaches, as the lifecycle's `Settlement`.
//!
//! A chunk finds everything it needs in `remaining_accounts`, in any order, by what each account
//! is (its discriminator and address), never by position:
//!
//! * the baskets and spills of the Accounts that are credited (the winner, the loser's funder, a
//!   Backer, an outside studio): a basket and its spill are paired by their owner;
//! * the book of every Source a line touches, and its checkpoint pages (`OnchainBooks`);
//! * for every Source a fee is cut from: its `SourceState` and its Position, and, when the
//!   Source is the Position's open Advance, the custody and rate account of the Position's kind
//!   (native: the custody and the `sim_lst` pool; staking token: the custody and the stake pool).
//!
//! A missing account blocks the step (nothing changes) and the chunk reports it; whoever calls
//! next supplies it. Nothing is ever skipped.

use crate::books::OnchainBooks;
use crate::instructions::economy::{
    kind_of, native_rates, read_pool, reported_rates, stake_rates, sync_in_books, Rates,
};
use crate::ledger::book::SourceBook;
use crate::ledger::draw::{DrawError, Placed, Pool, SourceBooks};
use crate::ledger::lifecycle::{LcResult, LifecycleError, Settlement};
use crate::ledger::line_store::{Line, LineStore, SIDE_OWN};
use crate::ledger::{CustodyKind, Key};
use crate::state::*;
use crate::storage::*;
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use sim_lst::Pool as SimPool;

struct OwnerStores<'info> {
    owner: Key,
    basket: &'info AccountInfo<'info>,
    spill: &'info AccountInfo<'info>,
}

pub struct ChainSettlement<'info> {
    infos: &'info [AccountInfo<'info>],
    books: OnchainBooks<'info, 'info>,
    stores: Vec<OwnerStores<'info>>,
    synced: Vec<Key>,
    /// Slots held for the Match's credits, per Account (`MatchState::room`).
    holds: Vec<(Key, u32)>,
}

fn disc_is(info: &AccountInfo, disc: &[u8]) -> bool {
    info.owner == &crate::ID
        && info
            .try_borrow_data()
            .map(|d| d.len() >= DISC && &d[..DISC] == disc)
            .unwrap_or(false)
}

/// The owner key and bump a store keeps in its header.
fn store_owner(info: &AccountInfo) -> Option<(Key, u8)> {
    let data = info.try_borrow_data().ok()?;
    let store = LineStore::new(&data[DISC..]).ok()?;
    Some((store.account(), store.bump()))
}

fn lc(_: Error) -> LifecycleError {
    LifecycleError::MissingAccount
}

impl<'info> ChainSettlement<'info> {
    pub fn load(infos: &'info [AccountInfo<'info>]) -> Result<Self> {
        let books = OnchainBooks::load(infos)?;
        let mut baskets: Vec<(Key, &'info AccountInfo<'info>)> = Vec::new();
        let mut spills: Vec<(Key, &'info AccountInfo<'info>)> = Vec::new();
        for info in infos {
            let is_basket = disc_is(info, BasketHead::DISCRIMINATOR);
            let is_spill = disc_is(info, SpillHead::DISCRIMINATOR);
            if !is_basket && !is_spill {
                continue;
            }
            require!(
                info.is_writable,
                crate::error::BasketError::AccountNotWritable
            );
            let (owner, bump) =
                store_owner(info).ok_or_else(|| error!(crate::error::BasketError::BadStore))?;
            let seed = if is_basket { BASKET_SEED } else { SPILL_SEED };
            let address = Pubkey::create_program_address(&[seed, &owner, &[bump]], &crate::ID)
                .map_err(|_| crate::error::BasketError::BadStore)?;
            require_keys_eq!(address, *info.key, crate::error::BasketError::BadStore);
            let list = if is_basket { &mut baskets } else { &mut spills };
            require!(
                !list.iter().any(|(o, _)| *o == owner),
                crate::error::BasketError::DuplicateBook
            );
            list.push((owner, info));
        }
        let mut stores = Vec::new();
        for (owner, basket) in baskets {
            if let Some((_, spill)) = spills.iter().find(|(o, _)| *o == owner) {
                stores.push(OwnerStores {
                    owner,
                    basket,
                    spill,
                });
            }
        }
        Ok(ChainSettlement {
            infos,
            books,
            stores,
            synced: Vec::new(),
            holds: Vec::new(),
        })
    }

    /// The slots the Match holds in each Account's stores: a credit that needs a new slot uses
    /// its Account's share first.
    pub fn set_holds(&mut self, room: &[RoomHold]) {
        self.holds = room
            .iter()
            .filter(|h| h.account != [0u8; 32])
            .map(|h| (h.account, h.left))
            .collect();
    }

    /// What is left of the Account's share.
    pub fn hold_of(&self, account: &Key) -> Option<u32> {
        self.holds
            .iter()
            .find(|(k, _)| k == account)
            .map(|(_, l)| *l)
    }

    /// Writes the last decoded book back. Call after the run's chunk succeeded.
    pub fn finish(self) -> Result<()> {
        self.books.flush()
    }

    fn find(&self, key: &Pubkey) -> Option<&'info AccountInfo<'info>> {
        self.infos.iter().find(|i| i.key == key)
    }

    /// The rates of the moment for `position`, from the kind's accounts among the supplied ones.
    fn rates(&self, position: &crate::ledger::Position) -> Result<Rates> {
        match kind_of(position) {
            CustodyKind::Reported => Ok(reported_rates(position)),
            CustodyKind::Native => {
                let (custody_key, _) = Pubkey::find_program_address(&[NATIVE_SEED], &crate::ID);
                let custody_info = self
                    .find(&custody_key)
                    .ok_or_else(|| error!(crate::error::MatchError::AccountMissing))?;
                let custody = Account::<NativeCustody>::try_from(custody_info)?;
                let pool_info = self
                    .find(&custody.pool)
                    .ok_or_else(|| error!(crate::error::MatchError::AccountMissing))?;
                let pool = Account::<SimPool>::try_from(pool_info)?;
                require_keys_eq!(
                    pool.mint,
                    SIM_SOL_MINT,
                    crate::error::TesoroError::InvalidPool
                );
                native_rates(position, &pool)
            }
            CustodyKind::Stake => {
                let mint = Pubkey::new_from_array(position.source_asset);
                let (custody_key, _) =
                    Pubkey::find_program_address(&[STAKE_CUSTODY_SEED, mint.as_ref()], &crate::ID);
                let custody_info = self
                    .find(&custody_key)
                    .ok_or_else(|| error!(crate::error::MatchError::AccountMissing))?;
                let custody = Account::<StakeCustody>::try_from(custody_info)?;
                let pool_info = self
                    .find(&custody.pool)
                    .ok_or_else(|| error!(crate::error::MatchError::AccountMissing))?;
                let read = read_pool(pool_info, &custody)?;
                let rate = read.rate().map_err(crate::error::core_err)?;
                stake_rates(position, rate)
            }
        }
    }
}

impl<'info> Settlement for ChainSettlement<'info> {
    fn books(&mut self) -> &mut dyn SourceBooks {
        &mut self.books
    }

    fn sync_source(&mut self, source: &Key) -> LcResult<()> {
        if self.synced.contains(source) {
            return Ok(());
        }
        let source_key = Pubkey::new_from_array(*source);
        let source_info = self
            .find(&source_key)
            .ok_or(LifecycleError::MissingAccount)?;
        let state = Account::<SourceState>::try_from(source_info).map_err(lc)?;
        let position_key = Pubkey::new_from_array(state.inner.position);
        let position_info = self
            .find(&position_key)
            .ok_or(LifecycleError::MissingAccount)?;
        let mut position = Account::<PositionState>::try_from(position_info).map_err(lc)?;
        if position.inner.open_advance == Some(state.inner.index) {
            let rates = self.rates(&position.inner).map_err(lc)?;
            sync_in_books(&mut self.books, &mut position, &state, &source_key, &rates)
                .map_err(lc)?;
            position.exit(&crate::ID).map_err(lc)?;
        }
        self.synced.push(*source);
        Ok(())
    }

    fn credit(&mut self, owner: &Key, line: &Line) -> LcResult<Placed> {
        if !basket_may_hold(line) {
            return Err(LifecycleError::Inconsistent(
                "a Platform or Leaderboard line has no basket",
            ));
        }
        let st = self
            .stores
            .iter()
            .find(|s| s.owner == *owner)
            .ok_or(LifecycleError::MissingAccount)?;
        let mut b = st
            .basket
            .try_borrow_mut_data()
            .map_err(|_| LifecycleError::MissingAccount)?;
        let mut s = st
            .spill
            .try_borrow_mut_data()
            .map_err(|_| LifecycleError::MissingAccount)?;
        let mut basket = LineStore::new(&mut b[DISC..])?;
        let mut spill = LineStore::new(&mut s[DISC..])?;
        let mut pool = Pool::new(&mut basket, &mut spill);
        let share = self.holds.iter_mut().find(|(k, _)| k == owner);
        pool.set_hold(share.as_ref().map_or(0, |(_, l)| *l));
        let placed = pool.put(&mut self.books, line)?;
        if let Some((_, left)) = share {
            *left = pool.hold_left();
        }
        Ok(placed)
    }

    fn credit_fee(&mut self, class: u8, owner: Option<&Key>, line: &Line) -> LcResult<()> {
        match owner {
            Some(o) => {
                // an outside studio's Studio Fee: a fee line in its basket
                if fee_destination(class, true) != Ok(FeeDestination::Basket) {
                    return Err(LifecycleError::Inconsistent(
                        "only a Studio Fee has a basket",
                    ));
                }
                self.credit(o, line).map(drop)
            }
            None => {
                let Ok(FeeDestination::Counter(slot)) = fee_destination(class, false) else {
                    return Err(LifecycleError::Inconsistent("not a fee class"));
                };
                let blank = SourceBook::blank_line(SIDE_OWN, 0, line.source, class, 0);
                let mut counter = self
                    .books
                    .counter(&line.source, slot as u8)
                    .unwrap_or(blank);
                if !counter_line_ok(&line.source, class, &counter) {
                    return Err(LifecycleError::Inconsistent("malformed fee counter"));
                }
                let mut moving = *line;
                {
                    let (book, history) = self.books.book_with_history(&line.source)?;
                    book.transfer(&mut moving, &mut counter, line.amount, &*history)?;
                }
                if !self.books.set_counter(&line.source, slot as u8, &counter) {
                    return Err(LifecycleError::Draw(DrawError::Book(
                        crate::ledger::book::BookError::NoSuchClass,
                    )));
                }
                Ok(())
            }
        }
    }
}

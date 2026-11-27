//! Stateful property-based sequence fuzzing over the full pure-Rust ledger economy:
//! deposit -> yield tick (growth & slash) -> advance / extend -> match win/loss ->
//! instant redeem (request / partial & full fill / cancel / expire) -> normal & treasury redeem ->
//! treasury fund / withdraw -> unlock.
//!
//! Asserts exact Gemas conservation, SourceBook consistency, vault share/backing conservation,
//! RouteLedger solvency, and InstantOrder accounting after every single transition.

use super::*;
use crate::ledger::book::checkpoint::{CheckpointStore, MemCheckpoints};
use crate::ledger::book::SourceBook;
use crate::ledger::draw::{spill_body, DrawResult, Pool, SourceBooks};
use crate::ledger::instant::{
    cancel_instant_redeem, expire_instant_redeem, fill_instant_redeem, request_instant_redeem,
    FillAuthority, FillTerms, InstantOrder, PayMode, Rate, DEFAULT_ORDER_TTL_SECS,
    INSTANT_REDEEM_FEE_BPS,
};
use crate::ledger::line_store::{required_len, Line, LineStore, CLASS_GENERAL, SIDE_WON};
use crate::ledger::prize::SourceKind;
use crate::ledger::yield_fee::{cash_out, exit_terms, treasury_cash_out};
use crate::ledger::{principal_for_shares, stake_position_counted, Key, SourceChain, BPS};
use proptest::prelude::*;

const ALICE: Key = [1; 32];
const BOB: Key = [2; 32];
const TREASURY_KEY: Key = [3; 32];
const ADMIN: Key = [4; 32];
const POSITION: Key = [5; 32];
const SOL: u64 = 1_000_000_000;
const R0: u64 = 1_300_000_000_000;
const FEE_BPS: u16 = 2_000;
const POOL_BPS: u16 = 5_000;
const PRICE: u64 = 150_000_000;
const T0: i64 = 1_800_000_000;

type Store = LineStore<Vec<u8>>;

fn source_key(i: usize) -> Key {
    let mut k = [42; 32];
    k[0] = i as u8;
    k
}

fn new_basket(owner: Key) -> Store {
    LineStore::init(vec![0u8; required_len(32)], owner, 255).unwrap()
}

fn new_spill(owner: Key) -> Store {
    LineStore::new(spill_body(owner, 64).unwrap()).unwrap()
}

struct ActorPool {
    basket: Store,
    spill: Store,
}

impl Clone for ActorPool {
    fn clone(&self) -> Self {
        Self {
            basket: LineStore::new(self.basket.bytes().clone()).unwrap(),
            spill: LineStore::new(self.spill.bytes().clone()).unwrap(),
        }
    }
}

impl ActorPool {
    fn new(owner: Key) -> Self {
        Self {
            basket: new_basket(owner),
            spill: new_spill(owner),
        }
    }

    fn all_lines(&self) -> Vec<Line> {
        self.basket.lines().chain(self.spill.lines()).collect()
    }

    fn check(&self) {
        self.basket.check().unwrap();
        self.spill.check().unwrap();
    }
}

struct SingleBook<'a>(&'a mut SourceBook, &'a mut MemCheckpoints);

impl SourceBooks for SingleBook<'_> {
    fn book_mut(&mut self, _source: &Key) -> DrawResult<&mut SourceBook> {
        Ok(self.0)
    }

    fn book_with_history(
        &mut self,
        _source: &Key,
    ) -> DrawResult<(&mut SourceBook, &mut dyn CheckpointStore)> {
        Ok((&mut *self.0, &mut *self.1))
    }
}

#[derive(Clone)]
struct EconomyWorld {
    pos: Position,
    srcs: Vec<Source>,
    books: Vec<SourceBook>,
    cks: Vec<MemCheckpoints>,
    alice: ActorPool,
    bob: ActorPool,
    treasury: ActorPool,
    orders: Vec<(usize, InstantOrder)>,
    route: RouteLedger,
    rate: u64,
    now: i64,
    /// Ghost accounting (all in whole staking-token shares).
    total_shares_in: u128,
    shares_paid_to_users: u128,
    treasury_withdrawn: u128,
    paid_post: u64,
    unlocked: Option<UnlockPayout>,
    /// Ghost Pool liability in shares (`pool_owed` / `pool_realised_total`), matching
    /// holder Yield Fee splits, Treasury `treasury_cash_out` + `owe_pool`, and Unlock free-yield fees.
    ghost_pool_owed: u128,
    /// Ghost per-Source unit counters mirroring production `account_cash_out`.
    ghost_source_redeemed_units: Vec<u64>,
    ghost_source_fee_units: Vec<u64>,
    ghost_source_pool_units: Vec<u64>,
}

impl EconomyWorld {
    fn new(shares: u64) -> Self {
        let principal = principal_for_shares(shares, R0).unwrap();
        let mut pos =
            Position::new(ALICE, SourceChain::Solana, [7; 32], 9, principal, 500).unwrap();
        pos.stake_rate_open = R0;
        pos.stake_rate_high = R0;
        pos.yield_fee_bps = FEE_BPS;
        pos.custody_shares = shares;
        let route = RouteLedger {
            escrow_enabled: true,
            ..RouteLedger::default()
        };
        Self {
            pos,
            srcs: vec![],
            books: vec![],
            cks: vec![],
            alice: ActorPool::new(ALICE),
            bob: ActorPool::new(BOB),
            treasury: ActorPool::new(TREASURY_KEY),
            orders: vec![],
            route,
            rate: R0,
            now: T0,
            total_shares_in: u128::from(shares),
            shares_paid_to_users: 0,
            treasury_withdrawn: 0,
            paid_post: 0,
            unlocked: None,
            ghost_pool_owed: 0,
            ghost_source_redeemed_units: vec![],
            ghost_source_fee_units: vec![],
            ghost_source_pool_units: vec![],
        }
    }

    fn share_rate(&self) -> ShareRate {
        ShareRate::stake(self.rate).unwrap()
    }

    fn net(&self) -> u64 {
        stake_position_counted(&self.pos, self.rate).unwrap()
    }

    fn source_index(&self, key: &Key) -> usize {
        self.srcs
            .iter()
            .enumerate()
            .find(|(i, _)| source_key(*i) == *key)
            .map(|(i, _)| i)
            .expect("known source")
    }

    fn sync_source_idx(&mut self, s: usize) -> CoreResult<()> {
        let (net, rate) = (self.net(), self.share_rate());
        sync_source(
            &mut self.pos,
            &self.srcs[s],
            &mut self.books[s],
            net,
            &rate,
            &mut self.cks[s],
        )
        .map(drop)
    }

    fn advance(&mut self, months: u8) -> CoreResult<()> {
        if self.srcs.len() >= 4 {
            return Ok(());
        }
        let net = self.net();
        let rate = self.share_rate();
        let mut pos = self.pos.clone();
        if let Some(i) = pos.open_advance.map(|i| i as usize) {
            let mut book2 = self.books[i].clone();
            let mut ck2 = self.cks[i].clone();
            prepare_advance(
                &mut pos,
                Some((&self.srcs[i], &mut book2, &mut ck2)),
                net,
                &rate,
            )?;
            self.books[i] = book2;
            self.cks[i] = ck2;
        } else {
            prepare_advance::<crate::ledger::book::ClassArray, MemCheckpoints>(
                &mut pos, None, net, &rate,
            )?;
        }
        let mut src = pos.open_advance(POSITION, months, PRICE)?;
        check_stake_issuance(&pos, &rate, &src)?;
        src.due_at = planned_due_at(self.now, months, 1)?;
        src.yield_fee_bps = FEE_BPS;
        src.pool_bps = POOL_BPS;
        let s = self.srcs.len();
        let mut book = SourceBook::new();
        let mut ck = MemCheckpoints::new(source_key(s));
        let line = advance_line(&mut book, source_key(s), &src, &ck)?;
        let mut pool = Pool::new(&mut self.alice.basket, &mut self.alice.spill);
        pool.put(&mut SingleBook(&mut book, &mut ck), &line)
            .map_err(|_| CoreError::SpillFull)?;
        self.pos = pos;
        self.srcs.push(src);
        self.books.push(book);
        self.cks.push(ck);
        self.ghost_source_redeemed_units.push(0);
        self.ghost_source_fee_units.push(0);
        self.ghost_source_pool_units.push(0);
        Ok(())
    }

    fn extend(&mut self, months: u8) -> CoreResult<()> {
        let Some(open) = self.pos.open_advance else {
            return Err(CoreError::NoOpenAdvance);
        };
        let s = open as usize;
        let (net, rate) = (self.net(), self.share_rate());
        let (line, _) = extend_source(
            &mut self.pos,
            &mut self.srcs[s],
            source_key(s),
            &mut self.books[s],
            months,
            1,
            net,
            &rate,
            &mut self.cks[s],
        )?;
        let mut pool = Pool::new(&mut self.alice.basket, &mut self.alice.spill);
        pool.put(&mut SingleBook(&mut self.books[s], &mut self.cks[s]), &line)
            .map_err(|_| CoreError::SpillFull)?;
        Ok(())
    }

    fn settle_redeemed_shares(
        &mut self,
        s: usize,
        class: u8,
        k: u64,
        shares: u128,
        to_treasury: bool,
    ) -> CoreResult<()> {
        let paid = u64::try_from(shares).map_err(|_| CoreError::Math)?;
        let unlocked = self.pos.status == PositionStatus::Unlocked;
        debit_paid_shares(
            &mut self.pos,
            CustodyKind::Stake,
            unlocked.then_some(&mut self.route),
            paid,
        )?;
        if unlocked {
            self.paid_post = self.paid_post.checked_add(paid).ok_or(CoreError::Math)?;
        }

        // Mirror production `instructions::economy::account_cash_out` verbatim:
        // - Holder: `cash_out` + `route.realise_yield_fee(split.fee, pool_bps)`
        // - Treasury: exempt for fee classes (< CLASS_GENERAL), else `treasury_cash_out`
        //   (Yield Fee half + 1/5th of Instant Redeem Fee), then `route.receive(paid)` +
        //   `route.owe_pool(split.pool)`.
        let (yf, pool_bps) = exit_terms(&self.srcs[s], class);
        let split = if to_treasury {
            if class < CLASS_GENERAL {
                cash_out(u128::from(paid), 0, 0)?
            } else {
                treasury_cash_out(u128::from(paid), yf, pool_bps, INSTANT_REDEEM_FEE_BPS)?
            }
        } else {
            cash_out(u128::from(paid), yf, pool_bps)?
        };
        if to_treasury {
            self.route.receive(u128::from(paid))?;
            self.route.owe_pool(split.pool)?;
        } else {
            self.route.realise_yield_fee(split.fee, pool_bps)?;
            self.shares_paid_to_users = self
                .shares_paid_to_users
                .checked_add(split.payout)
                .ok_or(CoreError::Math)?;
        }

        let rate = self.share_rate();
        let units_of = |sh: u128| -> CoreResult<u64> {
            u64::try_from(rate.units_for_shares(sh)?).map_err(|_| CoreError::Math)
        };
        let units = units_of(u128::from(paid))?;
        let fee_units = units
            .checked_sub(units_of(split.payout)?)
            .ok_or(CoreError::Math)?;
        let pool_units = units_of(split.pool)?;

        let src = &mut self.srcs[s];
        src.redeemed = src.redeemed.checked_add(k).ok_or(CoreError::Math)?;
        src.redeemed_units = src
            .redeemed_units
            .checked_add(units)
            .ok_or(CoreError::Math)?;
        src.fee_units = src
            .fee_units
            .checked_add(fee_units)
            .ok_or(CoreError::Math)?;
        src.pool_units = src
            .pool_units
            .checked_add(pool_units)
            .ok_or(CoreError::Math)?;

        self.ghost_pool_owed = self
            .ghost_pool_owed
            .checked_add(split.pool)
            .ok_or(CoreError::Math)?;
        self.ghost_source_redeemed_units[s] = self.ghost_source_redeemed_units[s]
            .checked_add(units)
            .ok_or(CoreError::Math)?;
        self.ghost_source_fee_units[s] = self.ghost_source_fee_units[s]
            .checked_add(fee_units)
            .ok_or(CoreError::Math)?;
        self.ghost_source_pool_units[s] = self.ghost_source_pool_units[s]
            .checked_add(pool_units)
            .ok_or(CoreError::Math)?;
        Ok(())
    }

    fn match_transfer(&mut self, winner_is_bob: bool, line_pick: u8, pct: u8) -> CoreResult<()> {
        let lines = if winner_is_bob {
            self.alice.all_lines()
        } else {
            self.bob.all_lines()
        };
        if lines.is_empty() {
            return Ok(());
        }
        let chosen = lines[usize::from(line_pick) % lines.len()];
        let s = self.source_index(&chosen.source);
        let k = (chosen.amount * u64::from(pct) / 100)
            .max(1)
            .min(chosen.amount);
        self.sync_source_idx(s)?;

        let (loser, winner) = if winner_is_bob {
            (&mut self.alice, &mut self.bob)
        } else {
            (&mut self.bob, &mut self.alice)
        };
        let (in_spill, idx) = match loser.basket.find(&chosen.key()) {
            Ok(i) => (false, i),
            Err(_) => (
                true,
                loser
                    .spill
                    .find(&chosen.key())
                    .map_err(|_| CoreError::LineMismatch)?,
            ),
        };
        let mut src_line = if in_spill {
            loser.spill.get(idx)
        } else {
            loser.basket.get(idx)
        }
        .ok_or(CoreError::LineMismatch)?;
        let mut dst_line = SourceBook::blank_line(
            SIDE_WON,
            src_line.due_at,
            src_line.source,
            src_line.class,
            src_line.tranche,
        );
        self.books[s].transfer(&mut src_line, &mut dst_line, k, &self.cks[s])?;
        if in_spill {
            if src_line.amount == 0 {
                loser
                    .spill
                    .remove_at(idx)
                    .map_err(|_| CoreError::BookInconsistent)?;
            } else {
                loser
                    .spill
                    .set_line(idx, &src_line)
                    .map_err(|_| CoreError::BookInconsistent)?;
            }
        } else if src_line.amount == 0 {
            loser
                .basket
                .remove_at(idx)
                .map_err(|_| CoreError::BookInconsistent)?;
        } else {
            loser
                .basket
                .set_line(idx, &src_line)
                .map_err(|_| CoreError::BookInconsistent)?;
        }
        let mut wpool = Pool::new(&mut winner.basket, &mut winner.spill);
        wpool
            .put(
                &mut SingleBook(&mut self.books[s], &mut self.cks[s]),
                &dst_line,
            )
            .map_err(|_| CoreError::SpillFull)?;
        Ok(())
    }

    fn request_instant(
        &mut self,
        actor_is_bob: bool,
        line_pick: u8,
        pct: u8,
        ttl_hours: u8,
    ) -> CoreResult<()> {
        if self.orders.len() >= 6 {
            return Ok(());
        }
        let (owner, lines) = if actor_is_bob {
            (BOB, self.bob.all_lines())
        } else {
            (ALICE, self.alice.all_lines())
        };
        if lines.is_empty() {
            return Ok(());
        }
        let chosen = lines[usize::from(line_pick) % lines.len()];
        let s = self.source_index(&chosen.source);
        self.sync_source_idx(s)?;
        let key = chosen.key();
        let ready = self.books[s].redeemable(&chosen)?.min(chosen.amount);
        let remaining = chosen.amount.saturating_sub(ready);
        if remaining == 0 {
            return Ok(());
        }
        let sell = (remaining * u64::from(pct) / 100).max(1).min(remaining);
        let ttl = i64::from(ttl_hours.clamp(1, 72)) * 3_600;
        let actor = if actor_is_bob {
            &mut self.bob
        } else {
            &mut self.alice
        };
        let mut pool = Pool::new(&mut actor.basket, &mut actor.spill);
        let req = request_instant_redeem(
            SourceKind::Yield,
            &mut self.books[s],
            &mut self.cks[s],
            &mut pool,
            &key,
            owner,
            sell,
            self.now,
            ttl,
        )?;
        if let Some(red) = req.redeemed {
            self.settle_redeemed_shares(s, chosen.class, red.gemas, red.shares, false)?;
        }
        self.orders.push((s, req.order));
        Ok(())
    }

    fn fill_instant(&mut self, order_pick: u8, pct: u8) -> CoreResult<()> {
        if self.orders.is_empty() {
            return Ok(());
        }
        let oi = usize::from(order_pick) % self.orders.len();
        let s = self.orders[oi].0;
        self.sync_source_idx(s)?;
        let rate = self.share_rate();
        let src = &self.srcs[s];
        // Shares 1_000 Gemas are worth at the live rate.
        let sample_gemas = 1_000u64;
        let sample_units = u128::from(sample_gemas) * src.unit_num / u128::from(src.unit_den);
        let sample_units_u64 = u64::try_from(sample_units.max(1)).map_err(|_| CoreError::Math)?;
        let sample_shares = rate.whole_shares_for_units(sample_units_u64)?;
        let terms = FillTerms {
            rate: Rate {
                shares: u128::from(sample_shares.max(1)),
                gemas: sample_gemas,
            },
            yield_fee_bps: src.yield_fee_bps,
            fees_outstanding: 0,
            outstanding: u128::from(src.issued),
            pay: PayMode::Now,
        };
        let auth = FillAuthority {
            admin: ADMIN,
            keeper: [0; 32],
            keeper_fills: false,
        };
        let max_k = self.orders[oi]
            .1
            .max_fill(&self.books[s], self.route.spendable(), &terms)?;
        if max_k == 0 {
            return Ok(());
        }
        let k = (max_k * u64::from(pct) / 100).max(1).min(max_k);
        let class = self.orders[oi].1.line.class;
        let mut tpool = Pool::new(&mut self.treasury.basket, &mut self.treasury.spill);
        let filled = fill_instant_redeem(
            &auth,
            &ADMIN,
            &mut self.route,
            &mut self.books[s],
            &mut self.cks[s],
            &mut self.orders[oi].1,
            &mut tpool,
            k,
            &terms,
            self.now,
        )?;
        self.shares_paid_to_users = self
            .shares_paid_to_users
            .checked_add(filled.payout_shares)
            .ok_or(CoreError::Math)?;
        if let Some(red) = filled.redeemed {
            self.settle_redeemed_shares(s, class, red.gemas, red.shares, false)?;
        }
        if !self.orders[oi].1.is_open() {
            self.orders.remove(oi);
        }
        Ok(())
    }

    fn cancel_or_expire_instant(&mut self, order_pick: u8, by_expiry: bool) -> CoreResult<()> {
        if self.orders.is_empty() {
            return Ok(());
        }
        let oi = usize::from(order_pick) % self.orders.len();
        let s = self.orders[oi].0;
        let owner = self.orders[oi].1.owner;
        let actor = if owner == BOB {
            &mut self.bob
        } else {
            &mut self.alice
        };
        let mut pool = Pool::new(&mut actor.basket, &mut actor.spill);
        if by_expiry {
            expire_instant_redeem(
                self.now,
                &mut self.books[s],
                &mut self.cks[s],
                &mut self.orders[oi].1,
                &mut pool,
            )?;
        } else {
            cancel_instant_redeem(
                &owner,
                &mut self.books[s],
                &mut self.cks[s],
                &mut self.orders[oi].1,
                &mut pool,
            )?;
        }
        self.orders.remove(oi);
        Ok(())
    }

    fn redeem(&mut self, holder: u8, line_pick: u8, pct: u8) -> CoreResult<()> {
        let holder = holder % 3;
        let lines = match holder {
            0 => self.alice.all_lines(),
            1 => self.bob.all_lines(),
            _ => self.treasury.all_lines(),
        };
        if lines.is_empty() {
            return Ok(());
        }
        let chosen = lines[usize::from(line_pick) % lines.len()];
        let s = self.source_index(&chosen.source);
        self.sync_source_idx(s)?;
        let can = self.books[s].redeemable(&chosen)?.min(chosen.amount);
        let k = can * u64::from(pct) / 100;
        if k == 0 {
            return Ok(());
        }
        let actor = match holder {
            0 => &mut self.alice,
            1 => &mut self.bob,
            _ => &mut self.treasury,
        };
        let (in_spill, idx) = match actor.basket.find(&chosen.key()) {
            Ok(i) => (false, i),
            Err(_) => (
                true,
                actor
                    .spill
                    .find(&chosen.key())
                    .map_err(|_| CoreError::LineMismatch)?,
            ),
        };
        let mut line = if in_spill {
            actor.spill.get(idx)
        } else {
            actor.basket.get(idx)
        }
        .ok_or(CoreError::LineMismatch)?;
        let red = self.books[s].redeem(&mut line, k, &self.cks[s])?;
        if in_spill {
            if line.amount == 0 {
                actor
                    .spill
                    .remove_at(idx)
                    .map_err(|_| CoreError::BookInconsistent)?;
            } else {
                actor
                    .spill
                    .set_line(idx, &line)
                    .map_err(|_| CoreError::BookInconsistent)?;
            }
        } else if line.amount == 0 {
            actor
                .basket
                .remove_at(idx)
                .map_err(|_| CoreError::BookInconsistent)?;
        } else {
            actor
                .basket
                .set_line(idx, &line)
                .map_err(|_| CoreError::BookInconsistent)?;
        }
        self.settle_redeemed_shares(s, line.class, red.gemas, red.shares, holder == 2)?;
        Ok(())
    }

    fn treasury_fund(&mut self, shares: u64) -> CoreResult<()> {
        let s = u128::from(shares);
        self.route.receive(s)?;
        self.total_shares_in = self.total_shares_in.checked_add(s).ok_or(CoreError::Math)?;
        Ok(())
    }

    fn treasury_withdraw(&mut self, pct: u8) -> CoreResult<()> {
        let spendable = self.route.spendable();
        let amt = spendable * u128::from(pct) / 100;
        if amt == 0 {
            return Ok(());
        }
        self.route.spend(amt)?;
        self.treasury_withdrawn = self
            .treasury_withdrawn
            .checked_add(amt)
            .ok_or(CoreError::Math)?;
        Ok(())
    }

    fn unlock(&mut self) -> CoreResult<()> {
        if self.unlocked.is_some() {
            return Ok(());
        }
        let net = self.net();
        let rate = self.share_rate();
        let mut pos = self.pos.clone();
        if let Some(i) = pos.open_advance.map(|i| i as usize) {
            let mut book = self.books[i].clone();
            let mut ck = self.cks[i].clone();
            close_advance(&mut pos, &self.srcs[i], &mut book, net, &rate, &mut ck)?;
            self.books[i] = book;
            self.cks[i] = ck;
        } else {
            bank_free_yield(&mut pos, net, &rate)?;
        }
        let mut payout = settle_unlock(&mut pos, CustodyKind::Stake, &rate)?;
        let mut route = self.route.clone();
        route_after_unlock(&mut route, &mut payout, POOL_BPS)?;
        let unlock_pool = u128::from(payout.fee_shares) * u128::from(POOL_BPS) / BPS;
        self.pos = pos;
        self.route = route;
        self.ghost_pool_owed = self
            .ghost_pool_owed
            .checked_add(unlock_pool)
            .ok_or(CoreError::Math)?;
        self.shares_paid_to_users = self
            .shares_paid_to_users
            .checked_add(u128::from(payout.owner_shares))
            .ok_or(CoreError::Math)?;
        self.unlocked = Some(payout);
        Ok(())
    }

    fn check_invariants(&self) {
        self.alice.check();
        self.bob.check();
        self.treasury.check();
        self.route.check(&[]).expect("route invariants");

        let mut held_in_books = 0u128;
        for (s, book) in self.books.iter().enumerate() {
            let sk = source_key(s);
            let mut lines: Vec<Line> = self
                .alice
                .all_lines()
                .into_iter()
                .chain(self.bob.all_lines())
                .chain(self.treasury.all_lines())
                .chain(
                    self.orders
                        .iter()
                        .filter(|(si, _)| *si == s)
                        .map(|(_, o)| o.line),
                )
                .filter(|l| l.source == sk)
                .collect();
            book.check(self.srcs[s].redeemed, lines.iter())
                .unwrap_or_else(|e| panic!("source {s} book invariant: {e}"));
            let live_gemas: u64 = lines.drain(..).map(|l| l.amount).sum();
            assert_eq!(
                live_gemas + self.srcs[s].redeemed + self.srcs[s].returned,
                self.srcs[s].issued,
                "exact Gemas conservation on source {s}"
            );
            assert_eq!(
                self.srcs[s].redeemed_units, self.ghost_source_redeemed_units[s],
                "source {s} redeemed_units matches production accounting"
            );
            assert_eq!(
                self.srcs[s].fee_units, self.ghost_source_fee_units[s],
                "source {s} fee_units matches production accounting"
            );
            assert_eq!(
                self.srcs[s].pool_units, self.ghost_source_pool_units[s],
                "source {s} pool_units matches production accounting"
            );
            assert!(
                self.srcs[s].fee_units <= self.srcs[s].redeemed_units,
                "source {s} fee_units never exceeds redeemed_units"
            );
            assert!(
                self.srcs[s].pool_units <= self.srcs[s].redeemed_units,
                "source {s} pool_units never exceeds redeemed_units"
            );
            held_in_books += book_shares(book);
        }

        for (_, order) in &self.orders {
            assert!(order.is_open());
            assert_eq!(
                order.sold + order.redeemed_while_open + order.line.amount,
                order.requested,
                "instant order Gemas conservation"
            );
        }

        if self.pos.status == PositionStatus::Locked {
            assert_eq!(
                self.pos.held_shares, held_in_books,
                "position held_shares == sum(book shares)"
            );
            assert!(
                (u128::from(self.pos.custody_shares - self.pos.paid_shares) << SHARE_BITS)
                    >= self.pos.held_shares,
                "custody covers all landed holder shares"
            );
        }

        let custody_left = if self.pos.status == PositionStatus::Locked {
            u128::from(self.pos.custody_shares - self.pos.paid_shares)
        } else {
            0
        };
        assert_eq!(
            self.total_shares_in,
            self.shares_paid_to_users
                + self.treasury_withdrawn
                + custody_left
                + self.route.treasury_shares,
            "exact vault + treasury share conservation"
        );

        assert_eq!(
            self.route.pool_owed, self.ghost_pool_owed,
            "route pool_owed matches exact Pool liability across holder, Treasury owe_pool, and Unlock cash-outs"
        );
        assert_eq!(
            self.route.pool_realised_total, self.ghost_pool_owed,
            "route pool_realised_total matches cumulative Pool liability"
        );
        assert_eq!(
            self.route.spendable(),
            self.route.treasury_shares
                - self.route.owed_shares
                - self.route.pool_owed
                - self.route.reserved,
            "route spendable excludes owed_shares, pool_owed, and reserved"
        );

        if let Some(p) = &self.unlocked {
            assert_eq!(
                u64::try_from(self.route.owed_shares).unwrap() + self.paid_post,
                p.owed_shares,
                "post-unlock owed shares only leave via payouts"
            );
        }
    }
}

#[derive(Clone, Debug)]
enum EconomyOp {
    RateTick {
        bps: i32,
        dt_hours: u8,
    },
    Advance(u8),
    Extend(u8),
    MatchTransfer {
        winner_is_bob: bool,
        line_pick: u8,
        pct: u8,
    },
    RequestInstant {
        actor_is_bob: bool,
        line_pick: u8,
        pct: u8,
        ttl_hours: u8,
    },
    FillInstant {
        order_pick: u8,
        pct: u8,
    },
    CancelOrExpireInstant {
        order_pick: u8,
        by_expiry: bool,
    },
    Redeem {
        holder: u8,
        line_pick: u8,
        pct: u8,
    },
    TreasuryFund(u64),
    TreasuryWithdraw(u8),
    Unlock,
}

fn economy_op() -> impl Strategy<Value = EconomyOp> {
    prop_oneof![
        7 => (-250i32..450, 1u8..=12).prop_map(|(bps, dt_hours)| EconomyOp::RateTick { bps, dt_hours }),
        2 => (1u8..=12).prop_map(EconomyOp::Advance),
        1 => (1u8..=6).prop_map(EconomyOp::Extend),
        4 => (any::<bool>(), 0u8..8, 1u8..=100).prop_map(|(winner_is_bob, line_pick, pct)| EconomyOp::MatchTransfer { winner_is_bob, line_pick, pct }),
        3 => (any::<bool>(), 0u8..8, 1u8..=100, 1u8..=48).prop_map(|(actor_is_bob, line_pick, pct, ttl_hours)| EconomyOp::RequestInstant { actor_is_bob, line_pick, pct, ttl_hours }),
        4 => (0u8..6, 1u8..=100).prop_map(|(order_pick, pct)| EconomyOp::FillInstant { order_pick, pct }),
        2 => (0u8..6, any::<bool>()).prop_map(|(order_pick, by_expiry)| EconomyOp::CancelOrExpireInstant { order_pick, by_expiry }),
        5 => (0u8..3, 0u8..8, 1u8..=100).prop_map(|(holder, line_pick, pct)| EconomyOp::Redeem { holder, line_pick, pct }),
        2 => (1u64..=2 * SOL).prop_map(EconomyOp::TreasuryFund),
        2 => (1u8..=100).prop_map(EconomyOp::TreasuryWithdraw),
        1 => Just(EconomyOp::Unlock),
    ]
}

fn apply_op(w: &mut EconomyWorld, op: &EconomyOp) -> CoreResult<()> {
    match op {
        EconomyOp::RateTick { bps, dt_hours } => {
            w.rate = (w.rate as i128 + w.rate as i128 * i128::from(*bps) / 10_000).max(1) as u64;
            w.now = w
                .now
                .checked_add(i64::from(*dt_hours) * 3_600)
                .unwrap_or(w.now + DEFAULT_ORDER_TTL_SECS);
            Ok(())
        }
        EconomyOp::Advance(m) => w.advance(*m),
        EconomyOp::Extend(m) => w.extend(*m),
        EconomyOp::MatchTransfer {
            winner_is_bob,
            line_pick,
            pct,
        } => w.match_transfer(*winner_is_bob, *line_pick, *pct),
        EconomyOp::RequestInstant {
            actor_is_bob,
            line_pick,
            pct,
            ttl_hours,
        } => w.request_instant(*actor_is_bob, *line_pick, *pct, *ttl_hours),
        EconomyOp::FillInstant { order_pick, pct } => w.fill_instant(*order_pick, *pct),
        EconomyOp::CancelOrExpireInstant {
            order_pick,
            by_expiry,
        } => w.cancel_or_expire_instant(*order_pick, *by_expiry),
        EconomyOp::Redeem {
            holder,
            line_pick,
            pct,
        } => w.redeem(*holder, *line_pick, *pct),
        EconomyOp::TreasuryFund(shares) => w.treasury_fund(*shares),
        EconomyOp::TreasuryWithdraw(pct) => w.treasury_withdraw(*pct),
        EconomyOp::Unlock => w.unlock(),
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    #[test]
    fn full_economy_sequence_conserves_gemas_shares_and_route_backing(
        deposit_sol in 1u64..=20,
        init_months in 1u8..=12,
        ops in proptest::collection::vec(economy_op(), 1..48),
    ) {
        let mut w = EconomyWorld::new(deposit_sol * SOL);
        w.advance(init_months).unwrap();
        w.check_invariants();

        for op in &ops {
            let snap = w.clone();
            if apply_op(&mut w, op).is_err() {
                w = snap;
            }
            w.check_invariants();
        }
    }
}

#[test]
fn treasury_redeem_accrues_yield_fee_and_instant_pool_liability() {
    let mut w = EconomyWorld::new(10 * SOL);
    w.advance(2).unwrap();
    w.treasury_fund(2 * SOL).unwrap();

    // Alice requests an Instant Redeem for 50% of her unmatured General line and Admin fills it.
    w.request_instant(false, 0, 50, 24).unwrap();
    w.fill_instant(0, 100).unwrap();
    assert!(
        !w.treasury.all_lines().is_empty(),
        "treasury acquired bought Gemas"
    );
    w.check_invariants();

    // Rate rises so the 2-month Advance matures completely.
    w.rate = R0 + (R0 * 2_000 / 10_000);
    let pool_before = w.route.pool_owed;
    let fee_units_before = w.srcs[0].fee_units;
    let pool_units_before = w.srcs[0].pool_units;
    let redeemed_units_before = w.srcs[0].redeemed_units;

    // Treasury redeems 100% of its bought Gemas via the production treasury_cash_out + owe_pool path.
    w.redeem(2, 0, 100).unwrap();
    w.check_invariants();

    assert!(
        w.route.pool_owed > pool_before,
        "Treasury redeem must accrue Pool liability via route.owe_pool"
    );
    assert!(
        w.srcs[0].redeemed_units > redeemed_units_before,
        "Treasury redeem must increment source.redeemed_units"
    );
    assert!(
        w.srcs[0].fee_units > fee_units_before,
        "Treasury redeem must increment source.fee_units"
    );
    assert!(
        w.srcs[0].pool_units > pool_units_before,
        "Treasury redeem must increment source.pool_units"
    );

    // Withdrawing 100% of spendable must leave pool_owed completely intact in treasury_shares.
    let owed_after = w.route.pool_owed;
    w.treasury_withdraw(100).unwrap();
    w.check_invariants();
    assert_eq!(w.route.pool_owed, owed_after);
    assert_eq!(w.route.spendable(), 0);
    assert!(w.route.treasury_shares >= owed_after);
}

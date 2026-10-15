//! Property tests: a model world of Accounts, Positions, Sources, Holdings, Matches and Backings
//! driven by random operation sequences, with the ledger invariants checked after every step.

use super::*;
use proptest::prelude::*;
use std::collections::BTreeMap;

const N: usize = 6;
const PLAYERS: usize = 4;
const PLATFORM: usize = 4;
const STUDIO: usize = 5;
const GAME: Key = [9; 32];

fn akey(i: usize) -> Key {
    [i as u8 + 1; 32]
}
fn pkey(p: usize) -> Key {
    [50 + p as u8; 32]
}
fn rkey(r: usize) -> Key {
    [100 + r as u8; 32]
}
fn skey(p: usize, idx: u32) -> Key {
    let mut k = [0u8; 32];
    k[0] = ((p * 37 + idx as usize * 11) % 251) as u8;
    k[1] = p as u8;
    k[2] = idx as u8;
    k
}
fn acct_of(k: &Key) -> usize {
    k[0] as usize - 1
}
fn fees() -> FeeTerms {
    FeeTerms {
        platform_bps: 200,
        studio_bps: 300,
        platform_recipient: akey(PLATFORM),
        studio_recipient: akey(STUDIO),
    }
}

#[derive(Clone, Debug, PartialEq)]
struct World {
    positions: Vec<Position>,
    principals: Vec<u64>,
    sources: Vec<Source>,
    accounts: Vec<Account>,
    holdings: BTreeMap<(usize, usize), Holding>,
    matches: Vec<Match>,
    requests: Vec<Request>,
    offers: Vec<Offer>,
    now: i64,
}

#[derive(Clone, Debug)]
enum Op {
    Advance {
        a: usize,
        horizon: u8,
        price: u64,
    },
    Extend {
        a: usize,
        extra: u8,
    },
    Yield {
        a: usize,
        pct: u16,
    },
    Return {
        a: usize,
        pct: u8,
    },
    ReturnForeign {
        a: usize,
        s: usize,
    },
    Redeem {
        a: usize,
        s: usize,
        pct: u8,
    },
    OpenMatch {
        a: usize,
        e: usize,
    },
    JoinMatch {
        a: usize,
        m: usize,
    },
    Settle {
        m: usize,
        outcome: u8,
    },
    Refund {
        m: usize,
        force: bool,
    },
    Time {
        dt: i64,
    },
    Request {
        a: usize,
        e: usize,
    },
    Offer {
        a: usize,
        e: usize,
        share: u16,
        directed: Option<usize>,
    },
    AcceptDirected {
        o: usize,
    },
    Apply {
        o: usize,
        r: usize,
    },
    AcceptApplicant {
        o: usize,
        r: usize,
    },
    CancelOffer {
        o: usize,
    },
    ExpireOffer {
        o: usize,
    },
    Backed {
        o: usize,
    },
    BackedFlow {
        player: usize,
        backer: usize,
        e: usize,
        share: u16,
        opp: usize,
        outcome: u8,
    },
}

fn op_strategy() -> impl Strategy<Value = Op> {
    let a = 0..PLAYERS;
    prop_oneof![
        3 => (a.clone(), 1u8..=12, 1_000_000u64..400_000_000).prop_map(|(a, horizon, price)| Op::Advance { a, horizon, price }),
        2 => (a.clone(), 1u8..=11).prop_map(|(a, extra)| Op::Extend { a, extra }),
        4 => (a.clone(), 0u16..400).prop_map(|(a, pct)| Op::Yield { a, pct }),
        2 => (a.clone(), 1u8..=100).prop_map(|(a, pct)| Op::Return { a, pct }),
        1 => (a.clone(), 0usize..16).prop_map(|(a, s)| Op::ReturnForeign { a, s }),
        3 => (a.clone(), 0usize..16, 1u8..=100).prop_map(|(a, s, pct)| Op::Redeem { a, s, pct }),
        4 => (a.clone(), 0usize..3).prop_map(|(a, e)| Op::OpenMatch { a, e }),
        4 => (a.clone(), 0usize..8).prop_map(|(a, m)| Op::JoinMatch { a, m }),
        5 => (0usize..8, 0u8..3).prop_map(|(m, outcome)| Op::Settle { m, outcome }),
        2 => (0usize..8, any::<bool>()).prop_map(|(m, force)| Op::Refund { m, force }),
        1 => (0i64..(2 * 86_400)).prop_map(|dt| Op::Time { dt }),
        2 => (a.clone(), 0usize..3).prop_map(|(a, e)| Op::Request { a, e }),
        3 => (a.clone(), 0usize..3, 0u16..=10_000, prop::option::of(0usize..12))
            .prop_map(|(a, e, share, directed)| Op::Offer { a, e, share, directed }),
        2 => (0usize..6).prop_map(|o| Op::AcceptDirected { o }),
        2 => (0usize..6, 0usize..6).prop_map(|(o, r)| Op::Apply { o, r }),
        2 => (0usize..6, 0usize..6).prop_map(|(o, r)| Op::AcceptApplicant { o, r }),
        1 => (0usize..6).prop_map(|o| Op::CancelOffer { o }),
        1 => (0usize..6).prop_map(|o| Op::ExpireOffer { o }),
        4 => (0usize..6).prop_map(|o| Op::Backed { o }),
        6 => (a.clone(), a.clone(), 0usize..3, 0u16..=10_000, a.clone(), 0u8..3)
            .prop_map(|(player, backer, e, share, opp, outcome)| Op::BackedFlow { player, backer, e, share, opp, outcome }),
    ]
}

fn world_strategy() -> impl Strategy<Value = World> {
    prop::collection::vec(
        (1_000_000_000u64..1_000_000_000_000, 6u8..=9, 200u16..3_000),
        PLAYERS,
    )
    .prop_map(|params| {
        let mut positions = Vec::new();
        let mut principals = Vec::new();
        for (i, (principal, decimals, rate)) in params.into_iter().enumerate() {
            let p = Position::new(
                akey(i),
                SourceChain::Solana,
                [7; 32],
                decimals,
                principal,
                rate,
            )
            .expect("valid position");
            principals.push(principal);
            positions.push(p);
        }
        World {
            positions,
            principals,
            sources: Vec::new(),
            accounts: vec![Account::default(); N],
            holdings: BTreeMap::new(),
            matches: Vec::new(),
            requests: Vec::new(),
            offers: Vec::new(),
            now: 1_000,
        }
    })
}

impl World {
    fn source_index(&self, key: &Key) -> usize {
        self.sources
            .iter()
            .position(|s| skey(acct_of(&s.owner), s.index) == *key)
            .expect("known source")
    }

    fn credit(&mut self, acct: usize, si: usize, n: u64) {
        let own = self.sources[si].owner == akey(acct);
        let key = skey(acct_of(&self.sources[si].owner), self.sources[si].index);
        let h = self
            .holdings
            .entry((acct, si))
            .or_insert_with(|| Holding::new(key, own));
        h.credit(&mut self.accounts[acct], n).expect("credit");
    }

    fn apply_payouts(&mut self, payouts: &[Payout]) {
        for p in payouts {
            let si = self.source_index(&p.source);
            self.credit(acct_of(&p.recipient), si, p.amount);
        }
    }

    fn open_source(&self, p: usize) -> Option<usize> {
        let idx = self.positions[p].open_advance?;
        self.sources
            .iter()
            .position(|s| s.owner == akey(p) && s.index == idx)
    }

    /// Canonical draw list for an entry: own class first, then won, ascending by Source key.
    fn draw_list(&self, a: usize, entry: u64) -> Option<Vec<usize>> {
        let acct = &self.accounts[a];
        let own_need = entry.min(acct.own_free());
        let won_need = entry - own_need;
        if won_need > acct.won_free() {
            return None;
        }
        let mut own = Vec::new();
        let mut won = Vec::new();
        for ((ha, si), h) in &self.holdings {
            if *ha == a && h.free() > 0 {
                let target = if h.is_own { &mut own } else { &mut won };
                target.push((h.source, *si, h.free()));
            }
        }
        own.sort();
        won.sort();
        let mut out = Vec::new();
        for (list, mut need) in [(own, own_need), (won, won_need)] {
            for (_, si, free) in list {
                if need == 0 {
                    break;
                }
                out.push(si);
                need -= need.min(free);
            }
        }
        (out.len() <= MAX_ENTRY_SOURCES).then_some(out)
    }

    fn with_holdings<R>(
        &mut self,
        a: usize,
        sis: &[usize],
        f: impl FnOnce(&mut Account, &mut [Holding]) -> CoreResult<R>,
    ) -> CoreResult<R> {
        let mut hs: Vec<Holding> = sis
            .iter()
            .map(|si| self.holdings.remove(&(a, *si)).expect("holding"))
            .collect();
        let r = f(&mut self.accounts[a], &mut hs);
        for (si, h) in sis.iter().zip(hs) {
            self.holdings.insert((a, *si), h);
        }
        r
    }

    fn draw(&mut self, a: usize, entry: u64) -> Option<Vec<Line>> {
        let sis = self.draw_list(a, entry)?;
        self.with_holdings(a, &sis, |acct, hs| draw_entry(acct, hs, entry))
            .ok()
    }

    fn wealth(&self, a: usize) -> u64 {
        let held: u64 = self
            .holdings
            .iter()
            .filter(|((x, _), _)| *x == a)
            .map(|(_, h)| h.amount)
            .sum();
        let pots: u64 = self
            .matches
            .iter()
            .filter(|m| matches!(m.status, MatchStatus::Open | MatchStatus::Active))
            .flat_map(|m| std::iter::once(&m.a).chain(m.b.iter()))
            .filter(|s| s.funder == akey(a))
            .map(|s| s.total().expect("total"))
            .sum();
        held + pots
    }

    fn debts(&self) -> Vec<u64> {
        self.sources.iter().map(Source::debt).collect()
    }

    /// Applies one op. `Err(())` means it did not apply (a rejection or an unavailable target);
    /// the caller restores the snapshot, as a failed transaction would.
    fn apply(&mut self, op: &Op) -> Result<(), ()> {
        match *op {
            Op::Advance { a, horizon, price } => {
                let mut pos = self.positions[a].clone();
                let src = pos
                    .open_advance(pkey(a), horizon, price, 0)
                    .map_err(|_| ())?;
                let issued = src.issued;
                self.positions[a] = pos;
                self.sources.push(src);
                let si = self.sources.len() - 1;
                self.credit(a, si, issued);
            }
            Op::Extend { a, extra } => {
                let si = self.open_source(a).ok_or(())?;
                let mut pos = self.positions[a].clone();
                let before = self.sources[si].clone();
                let minted = pos
                    .extend_advance(&mut self.sources[si], extra, 0)
                    .map_err(|_| ())?;
                self.positions[a] = pos;
                let src = &self.sources[si];
                assert_eq!(src.issued, before.issued + minted);
                assert_eq!(src.horizon_months, before.horizon_months + extra);
                assert_eq!(src.debt(), before.debt() + minted);
                self.credit(a, si, minted);
            }
            Op::Yield { a, pct } => {
                let si = self.open_source(a);
                let need = si.map_or(1_000, |i| self.sources[i].units_to_repay_pub());
                let delta = need.saturating_mul(pct as u64) / 100 + 1;
                let cumulative = self.positions[a].cumulative_yield + delta;
                let seq = self.positions[a].last_seq + 1;
                let before = self.positions[a].clone();
                let src_before = si.map(|i| self.sources[i].clone());
                let applied = {
                    let (positions, sources) = (&mut self.positions, &mut self.sources);
                    positions[a]
                        .apply_yield(si.map(|i| &mut sources[i]), seq, cumulative)
                        .map_err(|_| ())?
                };
                assert!(applied);
                // Idempotent replay: no change at all.
                let snap = (
                    self.positions[a].clone(),
                    si.map(|i| self.sources[i].clone()),
                );
                let (positions, sources) = (&mut self.positions, &mut self.sources);
                let again = positions[a].apply_yield(si.map(|i| &mut sources[i]), seq, cumulative);
                assert_eq!(again, Ok(false));
                assert_eq!(
                    snap,
                    (
                        self.positions[a].clone(),
                        si.map(|i| self.sources[i].clone())
                    )
                );
                // Decreasing cumulative is rejected.
                let stale = self.positions[a].apply_yield(None, seq + 1, cumulative - 1);
                assert_eq!(stale, Err(CoreError::CumulativeDecreased));
                assert!(self.positions[a].cumulative_yield >= before.cumulative_yield);
                if let (Some(i), Some(sb)) = (si, src_before) {
                    assert!(self.sources[i].debt() <= sb.debt());
                }
            }
            Op::Return { a, pct } => {
                let si = self
                    .sources
                    .iter()
                    .position(|s| s.owner == akey(a) && s.debt() > 0)
                    .ok_or(())?;
                let h = self.holdings.get(&(a, si)).ok_or(())?;
                let amount = (h.free().min(self.sources[si].debt()) * pct as u64 / 100).max(1);
                let debt_before = self.sources[si].debt();
                let (positions, sources, accounts, holdings) = (
                    &mut self.positions,
                    &mut self.sources,
                    &mut self.accounts,
                    &mut self.holdings,
                );
                let h = holdings.get_mut(&(a, si)).ok_or(())?;
                return_own(
                    &mut positions[a],
                    &mut sources[si],
                    &mut accounts[a],
                    h,
                    amount,
                )
                .map_err(|_| ())?;
                assert_eq!(self.sources[si].debt(), debt_before - amount);
            }
            Op::ReturnForeign { a, s } => {
                // Returning Gemas of somebody else's Source never touches that Source's Debt.
                let keys: Vec<(usize, usize)> = self
                    .holdings
                    .iter()
                    .filter(|((x, _), h)| *x == a && !h.is_own)
                    .map(|(k, _)| *k)
                    .collect();
                let (_, si) = *keys.get(s % keys.len().max(1)).ok_or(())?;
                let owner = acct_of(&self.sources[si].owner);
                let before = self.clone();
                let (positions, sources, accounts, holdings) = (
                    &mut self.positions,
                    &mut self.sources,
                    &mut self.accounts,
                    &mut self.holdings,
                );
                let h = holdings.get_mut(&(a, si)).ok_or(())?;
                let r = return_own(
                    &mut positions[owner],
                    &mut sources[si],
                    &mut accounts[a],
                    h,
                    1,
                );
                assert_eq!(r, Err(CoreError::NotOwnSource));
                assert_eq!(before, *self);
                return Err(());
            }
            Op::Redeem { a, s, pct } => {
                let keys: Vec<(usize, usize)> = self
                    .holdings
                    .keys()
                    .filter(|(x, _)| *x == a)
                    .copied()
                    .collect();
                let (_, si) = *keys.get(s % keys.len().max(1)).ok_or(())?;
                let h = self.holdings.get(&(a, si)).ok_or(())?;
                let allowed = self.sources[si].redeemable_for(h.free());
                let amount = (allowed * pct as u64 / 100).max(1);
                let over = self.sources[si].redeemable_for(h.free()) + 1;
                let (sources, accounts, holdings) =
                    (&mut self.sources, &mut self.accounts, &mut self.holdings);
                let h = holdings.get_mut(&(a, si)).ok_or(())?;
                // Anything above what the Source has accrued is refused.
                if over <= h.free() {
                    let snap = (sources[si].clone(), accounts[a].clone(), h.clone());
                    assert_eq!(
                        redeem(&mut sources[si], &mut accounts[a], h, over),
                        Err(CoreError::ExceedsRedeemable)
                    );
                    assert_eq!(snap, (sources[si].clone(), accounts[a].clone(), h.clone()));
                }
                redeem(&mut sources[si], &mut accounts[a], h, amount).map_err(|_| ())?;
            }
            Op::OpenMatch { a, e } => {
                let entry = LADDER[e];
                let lines = self.draw(a, entry).ok_or(())?;
                let side = Side {
                    player: akey(a),
                    funder: akey(a),
                    share_bps: 0,
                    lines,
                };
                let m = Match::open(GAME, entry, fees(), side, self.now).map_err(|_| ())?;
                self.matches.push(m);
            }
            Op::JoinMatch { a, m } => {
                let m = self.pick(m, |w| {
                    w.matches
                        .iter()
                        .enumerate()
                        .filter(|(_, x)| x.status == MatchStatus::Open)
                        .map(|(i, _)| i)
                        .collect()
                })?;
                let entry = self.matches[m].entry;
                let lines = self.draw(a, entry).ok_or(())?;
                let side = Side {
                    player: akey(a),
                    funder: akey(a),
                    share_bps: 0,
                    lines,
                };
                let now = self.now;
                self.matches[m].join(side, now).map_err(|_| ())?;
            }
            Op::Settle { m, outcome } => {
                let m = self.pick(m, |w| {
                    w.matches
                        .iter()
                        .enumerate()
                        .filter(|(_, x)| x.status == MatchStatus::Active)
                        .map(|(i, _)| i)
                        .collect()
                })?;
                self.settle(m, outcome);
            }
            Op::Refund { m, force } => {
                let m = self.pick(m, |w| {
                    w.matches
                        .iter()
                        .enumerate()
                        .filter(|(_, x)| {
                            matches!(x.status, MatchStatus::Open | MatchStatus::Active)
                        })
                        .map(|(i, _)| i)
                        .collect()
                })?;
                let now = self.now;
                let mut mt = self.matches[m].clone();
                let payouts = mt.refund(now, force).map_err(|_| ())?;
                let total: u64 = payouts.iter().map(|p| p.amount).sum();
                let expect =
                    mt.a.total().unwrap() + mt.b.as_ref().map_or(0, |b| b.total().unwrap());
                assert_eq!(total, expect);
                self.matches[m] = mt;
                self.apply_payouts(&payouts);
                self.assert_final(m);
            }
            Op::Time { dt } => self.now += dt,
            Op::Request { a, e } => {
                let r = Request::new(akey(a), GAME, LADDER[e], self.now).map_err(|_| ())?;
                if self.requests.len() >= 12 {
                    return Err(());
                }
                self.requests.push(r);
            }
            Op::Offer {
                a,
                e,
                share,
                directed,
            } => {
                if self.offers.len() >= 12 {
                    return Err(());
                }
                let entry = LADDER[e];
                let sis = self.draw_list(a, entry).ok_or(())?;
                let kind = match directed {
                    Some(r) => OfferKind::Directed(rkey(r)),
                    None => OfferKind::Public,
                };
                let now = self.now;
                let offer = self
                    .with_holdings(a, &sis, |acct, hs| {
                        Offer::create(akey(a), GAME, entry, share, kind, now, acct, hs)
                    })
                    .map_err(|_| ())?;
                self.offers.push(offer);
            }
            Op::AcceptDirected { o } => {
                let o = self.pick(o, |w| (0..w.offers.len()).collect())?;
                let OfferKind::Directed(rk) = self.offers[o].kind else {
                    return Err(());
                };
                let r = (rk[0] - 100) as usize;
                let now = self.now;
                let req = self.requests.get_mut(r).ok_or(())?;
                self.offers[o]
                    .accept_directed(req, rk, now)
                    .map_err(|_| ())?;
            }
            Op::Apply { o, r } => {
                let o = self.pick(o, |w| (0..w.offers.len()).collect())?;
                let r = self.pick(r, |w| (0..w.requests.len()).collect())?;
                let now = self.now;
                self.offers[o]
                    .apply(&self.requests[r], rkey(r), now)
                    .map_err(|_| ())?;
            }
            Op::AcceptApplicant { o, r } => {
                let o = self.pick(o, |w| (0..w.offers.len()).collect())?;
                let r = self.pick(r, |w| (0..w.requests.len()).collect())?;
                let now = self.now;
                let req = &mut self.requests[r];
                self.offers[o]
                    .accept_applicant(req, rkey(r), now)
                    .map_err(|_| ())?;
            }
            Op::CancelOffer { o } => {
                let o = self.pick(o, |w| (0..w.offers.len()).collect())?;
                let b = acct_of(&self.offers[o].backer);
                let sis = self.line_sources(o);
                let mut offer = self.offers[o].clone();
                self.with_holdings(b, &sis, |acct, hs| offer.cancel(acct, hs))
                    .map_err(|_| ())?;
                self.offers[o] = offer;
            }
            Op::ExpireOffer { o } => {
                let o = self.pick(o, |w| (0..w.offers.len()).collect())?;
                let b = acct_of(&self.offers[o].backer);
                let sis = self.line_sources(o);
                let now = self.now;
                let mut offer = self.offers[o].clone();
                self.with_holdings(b, &sis, |acct, hs| offer.expire(now, acct, hs))
                    .map_err(|_| ())?;
                self.offers[o] = offer;
            }
            Op::BackedFlow {
                player,
                backer,
                e,
                share,
                opp,
                outcome,
            } => {
                // Request, directed Offer, acceptance, backed entry, an opponent joins, settle.
                let r = self.requests.len();
                let o = self.offers.len();
                self.apply(&Op::Request { a: player, e })?;
                self.apply(&Op::Offer {
                    a: backer,
                    e,
                    share,
                    directed: Some(r),
                })?;
                self.apply(&Op::AcceptDirected { o })?;
                self.apply(&Op::Backed { o })?;
                self.apply(&Op::JoinMatch { a: opp, m: 0 })?;
                self.apply(&Op::Settle { m: 0, outcome })?;
            }
            Op::Backed { o } => {
                let o = self.pick(o, |w| (0..w.offers.len()).collect())?;
                let offer = self.offers[o].clone();
                let player = acct_of(&offer.player.ok_or(())?);
                let b = acct_of(&offer.backer);
                let sis = self.line_sources(o);
                let now = self.now;
                let mut offer_mut = offer.clone();
                let side = self
                    .with_holdings(b, &sis, |acct, hs| {
                        offer_mut.consume(akey(player), GAME, offer.entry, now, acct, hs)
                    })
                    .map_err(|_| ())?;
                self.offers[o] = offer_mut;
                let open = self
                    .matches
                    .iter()
                    .position(|m| m.status == MatchStatus::Open && m.entry == offer.entry);
                match open {
                    Some(i) => self.matches[i].join(side, now).map_err(|_| ())?,
                    None => {
                        let m =
                            Match::open(GAME, offer.entry, fees(), side, now).map_err(|_| ())?;
                        self.matches.push(m);
                    }
                }
            }
        }
        Ok(())
    }

    fn pick(&self, i: usize, f: impl Fn(&World) -> Vec<usize>) -> Result<usize, ()> {
        let v = f(self);
        if v.is_empty() {
            return Err(());
        }
        Ok(v[i % v.len()])
    }

    fn line_sources(&self, o: usize) -> Vec<usize> {
        self.offers[o]
            .lines
            .iter()
            .map(|l| self.source_index(&l.source))
            .collect()
    }

    fn assert_final(&mut self, m: usize) {
        let frozen = self.matches[m].clone();
        assert!(matches!(
            frozen.status,
            MatchStatus::Settled | MatchStatus::Refunded
        ));
        for outcome in [Outcome::Draw, Outcome::Winner(0), Outcome::Winner(1)] {
            assert!(self.matches[m].settle(outcome).is_err());
        }
        assert!(self.matches[m].refund(i64::MAX, true).is_err());
        assert_eq!(frozen, self.matches[m]);
    }

    fn settle(&mut self, m: usize, outcome: u8) {
        let mt = self.matches[m].clone();
        let entry = mt.entry;
        let b = mt.b.clone().expect("active");
        let funders = [mt.a.funder, b.funder];
        let before: Vec<u64> = funders.iter().map(|k| self.wealth(acct_of(k))).collect();
        let outcome = match outcome {
            0 => Outcome::Winner(0),
            1 => Outcome::Winner(1),
            _ => Outcome::Draw,
        };
        let debts = self.debts();
        let payouts = self.matches[m]
            .settle(outcome)
            .expect("active match settles");
        // Pot conservation: winner + fees == both entries.
        let total: u64 = payouts.iter().map(|p| p.amount).sum();
        assert_eq!(total, entry * 2);
        let (platform, studio) = mt.fees_due().unwrap();
        let paid_to = |k: Key| -> u64 {
            payouts
                .iter()
                .filter(|p| p.recipient == k)
                .map(|p| p.amount)
                .sum()
        };
        if let Outcome::Winner(_) = outcome {
            assert_eq!(paid_to(akey(PLATFORM)), platform);
            assert_eq!(paid_to(akey(STUDIO)), studio);
            let winner = if matches!(outcome, Outcome::Winner(0)) {
                &mt.a
            } else {
                &b
            };
            let others: u64 = payouts
                .iter()
                .filter(|p| p.recipient != akey(PLATFORM) && p.recipient != akey(STUDIO))
                .map(|p| p.amount)
                .sum();
            assert_eq!(others + platform + studio, entry * 2);
            if winner.is_backed() {
                // Backer's entry comes back first.
                assert!(paid_to(winner.funder) >= entry);
            }
        } else {
            for s in [&mt.a, &b] {
                assert_eq!(paid_to(s.funder), entry);
            }
        }
        // Settled at most once: nothing further is possible.
        self.apply_payouts(&payouts);
        self.assert_final(m);
        // Backer never charged beyond the Offer; entering never creates Debt.
        for (k, w) in funders.iter().zip(before.iter().copied()) {
            let after = self.wealth(acct_of(k));
            assert!(after + entry >= w, "loss beyond entry");
        }
        for (side, funder_before) in [(&mt.a, 0), (&b, 1)] {
            let won = matches!(outcome, Outcome::Winner(i) if (i == 0) == (funder_before == 0));
            if side.is_backed() && won {
                assert!(self.wealth(acct_of(&side.funder)) >= before[funder_before]);
            }
        }
        assert_eq!(debts, self.debts());
    }

    fn check(&self) {
        for (si, s) in self.sources.iter().enumerate() {
            let held: u64 = self
                .holdings
                .iter()
                .filter(|((_, x), _)| *x == si)
                .map(|(_, h)| h.amount)
                .sum();
            let key = skey(acct_of(&s.owner), s.index);
            let pots: u64 = self
                .matches
                .iter()
                .filter(|m| matches!(m.status, MatchStatus::Open | MatchStatus::Active))
                .flat_map(|m| std::iter::once(&m.a).chain(m.b.iter()))
                .flat_map(|side| side.lines.iter())
                .filter(|l| l.source == key)
                .map(|l| l.amount)
                .sum();
            // Per-Source conservation.
            assert_eq!(
                held + pots,
                s.outstanding(),
                "held + escrowed == outstanding"
            );
            assert_eq!(s.outstanding() + s.redeemed + s.returned, s.issued);
            // Redemption never exceeds what accrued yield covers.
            assert!(s.redeemed <= s.covered());
            assert!(s.redeemed_units <= s.yield_units);
            assert!(s.covered() <= s.issued - s.returned);
            assert!(s.debt() + s.covered() + s.returned == s.issued);
        }
        for (i, p) in self.positions.iter().enumerate() {
            assert_eq!(p.principal, self.principals[i]);
            if let Some(idx) = p.open_advance {
                let s = self
                    .sources
                    .iter()
                    .find(|s| s.owner == akey(i) && s.index == idx)
                    .expect("source");
                assert!(s.debt() > 0);
            }
            // At most one open Advance: every other Source of the Position has no Debt.
            let with_debt = self
                .sources
                .iter()
                .filter(|s| s.owner == akey(i) && s.debt() > 0)
                .count();
            assert!(with_debt <= 1);
        }
        for (a, acct) in self.accounts.iter().enumerate() {
            let mut t = [0u64; 4];
            for ((x, _), h) in &self.holdings {
                if *x == a {
                    assert!(h.reserved <= h.amount);
                    let (tot, res) = if h.is_own { (0, 2) } else { (1, 3) };
                    t[tot] += h.amount;
                    t[res] += h.reserved;
                }
            }
            assert_eq!(
                [
                    acct.own_total,
                    acct.won_total,
                    acct.own_reserved,
                    acct.won_reserved
                ],
                t
            );
        }
    }
}

trait SourceExt {
    fn units_to_repay_pub(&self) -> u64;
}
impl SourceExt for Source {
    fn units_to_repay_pub(&self) -> u64 {
        self.debt_units().unwrap_or(0)
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 300, ..ProptestConfig::default() })]

    #[test]
    fn ledger_invariants(mut w in world_strategy(), ops in prop::collection::vec(op_strategy(), 1..80)) {
        // Every account starts with an Advance so there is something to play with.
        for a in 0..PLAYERS {
            let _ = w.apply(&Op::Advance { a, horizon: 12, price: 150_000_000 });
        }
        w.check();
        for op in ops {
            let snap = w.clone();
            let debts = w.debts();
            match w.apply(&op) {
                Err(()) => w = snap,
                Ok(()) => {
                    // Only yield, a Position's own returns and new Advances move Debt; Principal never does.
                    if !matches!(op, Op::Yield { .. } | Op::Return { .. } | Op::Advance { .. } | Op::Extend { .. }) {
                        prop_assert_eq!(&debts[..], &w.debts()[..debts.len()]);
                    }
                }
            }
            w.check();
        }
    }
}

// --- Deterministic edge cases --------------------------------------------------------------

fn locked_position() -> Position {
    // 100 SOL-like (9 decimals) at 10% APR.
    Position::new(
        akey(0),
        SourceChain::Solana,
        [7; 32],
        9,
        100_000_000_000,
        1_000,
    )
    .unwrap()
}

#[test]
fn advance_sizing_matches_glossary() {
    let mut p = locked_position();
    // Projected yield over 6 months: 5 SOL. At $150 => $750 => 75_000 Gemas.
    let s = p.open_advance(pkey(0), 6, 150_000_000, 0).unwrap();
    assert_eq!(s.issued, 75_000);
    assert_eq!(p.open_advance, Some(0));
    assert_eq!(
        p.open_advance(pkey(0), 6, 150_000_000, 0),
        Err(CoreError::AdvanceAlreadyOpen)
    );
    assert_eq!(
        locked_position().open_advance(pkey(0), 0, 1, 0),
        Err(CoreError::InvalidHorizon)
    );
    assert_eq!(
        locked_position().open_advance(pkey(0), 13, 1, 0),
        Err(CoreError::InvalidHorizon)
    );
    assert_eq!(
        locked_position().open_advance(pkey(0), 6, 0, 0),
        Err(CoreError::InvalidPrice)
    );
}

#[test]
fn extend_mints_the_added_months_at_the_source_price() {
    let mut p = locked_position();
    let mut s = p.open_advance(pkey(0), 6, 150_000_000, 0).unwrap();
    // The Player lost everything; yield has barely started.
    assert!(p.apply_yield(Some(&mut s), 1, 500_000_000).unwrap());
    let debt = s.debt();
    // 3 more months = half of the 6-month Advance: 37_500 Gemas at the same $150.
    let minted = p.extend_advance(&mut s, 3, 0).unwrap();
    assert_eq!(minted, 37_500);
    assert_eq!((s.issued, s.horizon_months), (112_500, 9));
    assert_eq!(s.debt(), debt + 37_500);
    assert_eq!(s.unit_den, 150_000_000);
    assert_eq!(p.open_advance, Some(0));
    // Extending to the cap works, one more month does not.
    assert_eq!(
        p.extend_advance(&mut s, 4, 0),
        Err(CoreError::InvalidHorizon)
    );
    assert!(p.extend_advance(&mut s, 3, 0).is_ok());
    assert_eq!(s.horizon_months, 12);
    assert_eq!(
        p.extend_advance(&mut s, 1, 0),
        Err(CoreError::InvalidHorizon)
    );
}

#[test]
fn extend_is_net_of_the_yield_fee_and_matches_a_single_longer_advance() {
    let mut a = locked_position();
    let mut sa = a.open_advance(pkey(0), 4, 150_000_000, 2_000).unwrap();
    a.extend_advance(&mut sa, 5, 2_000).unwrap();
    let mut b = locked_position();
    let sb = b.open_advance(pkey(0), 9, 150_000_000, 2_000).unwrap();
    assert_eq!(sa.issued, sb.issued);
}

#[test]
fn extend_after_the_yield_fee_changed_mints_the_added_months_at_the_current_fee() {
    let mut p = locked_position();
    let mut s = p.open_advance(pkey(0), 6, 150_000_000, 0).unwrap();
    assert_eq!(s.issued, 75_000);
    // The fee rises to 20% after the Advance: 3 more months are 20% smaller, not an error.
    let minted = p.extend_advance(&mut s, 3, 2_000).unwrap();
    assert_eq!(minted, 30_000);
    assert_eq!((s.issued, s.horizon_months), (105_000, 9));
    // The fee falls back to 0: the added months are full size, never a negative mint.
    let mut q = locked_position();
    let mut t = q.open_advance(pkey(0), 6, 150_000_000, 2_000).unwrap();
    assert_eq!(t.issued, 60_000);
    assert_eq!(q.extend_advance(&mut t, 3, 0).unwrap(), 37_500);
}

#[test]
fn extend_refuses_without_an_open_advance_other_sources_zero_debt_and_zero_months() {
    let mut p = locked_position();
    let mut s = p.open_advance(pkey(0), 3, 150_000_000, 0).unwrap();
    assert_eq!(
        p.extend_advance(&mut s, 0, 0),
        Err(CoreError::InvalidHorizon)
    );
    let mut other = s.clone();
    other.index = 7;
    assert_eq!(
        p.extend_advance(&mut other, 1, 0),
        Err(CoreError::SourceMismatch)
    );
    let before = (p.clone(), s.clone());
    assert_eq!(
        p.extend_advance(&mut s, 1, 20_000),
        Err(CoreError::InvalidBps)
    );
    assert_eq!(before, (p.clone(), s.clone()));
    // Repaid: the Advance closes and Extend has nothing to extend.
    assert!(p.apply_yield(Some(&mut s), 1, 9_000_000_000).unwrap());
    assert_eq!(s.debt(), 0);
    assert_eq!(
        p.extend_advance(&mut s, 1, 0),
        Err(CoreError::NoOpenAdvance)
    );
    // A Position that never took an Advance.
    let mut fresh = locked_position();
    let mut s2 = s.clone();
    s2.index = 0;
    assert_eq!(
        fresh.extend_advance(&mut s2, 1, 0),
        Err(CoreError::NoOpenAdvance)
    );
    // Unlocked Positions refuse.
    let mut q = locked_position();
    let mut sq = q.open_advance(pkey(0), 3, 150_000_000, 0).unwrap();
    q.status = PositionStatus::Unlocked;
    assert_eq!(
        q.extend_advance(&mut sq, 1, 0),
        Err(CoreError::PositionNotLocked)
    );
}

#[test]
fn extend_with_debt_zero_but_open_is_refused() {
    let mut p = locked_position();
    let mut s = p.open_advance(pkey(0), 3, 150_000_000, 0).unwrap();
    s.returned = s.issued;
    assert_eq!(s.debt(), 0);
    assert_eq!(
        p.extend_advance(&mut s, 1, 0),
        Err(CoreError::AdvanceRepaid)
    );
}

#[test]
fn yield_repays_debt_then_unlocks_and_new_advance_needs_zero_debt() {
    let mut p = locked_position();
    let mut s = p.open_advance(pkey(0), 6, 150_000_000, 0).unwrap();
    assert!(p.apply_yield(Some(&mut s), 1, 2_500_000_000).unwrap());
    assert_eq!(s.debt(), 37_500);
    assert_eq!(
        p.open_advance(pkey(0), 3, 150_000_000, 0),
        Err(CoreError::AdvanceAlreadyOpen)
    );
    assert_eq!(p.unlock(), Err(CoreError::DebtOutstanding));
    assert!(p.apply_yield(Some(&mut s), 2, 9_000_000_000).unwrap());
    assert_eq!(s.debt(), 0);
    assert_eq!(p.free_yield, 4_000_000_000);
    assert_eq!(p.open_advance, None);
    assert!(p.unlock().is_ok());
    // Replays and out-of-order messages are no-ops.
    assert_eq!(p.apply_yield(None, 2, 9_000_000_000), Ok(false));
    assert_eq!(p.apply_yield(None, 1, 1), Ok(false));
}

#[test]
fn own_first_entry_draw_and_ordering() {
    let mut acct = Account::default();
    let mut own = Holding::new([5; 32], true);
    let mut won = Holding::new([1; 32], false);
    own.credit(&mut acct, 300).unwrap();
    won.credit(&mut acct, 400).unwrap();
    // Won-first ordering is not canonical.
    let mut hs = [won.clone(), own.clone()];
    assert_eq!(
        draw_entry(&mut acct.clone(), &mut hs, 500),
        Err(CoreError::NonCanonicalDraw)
    );
    let mut hs = [own, won];
    let lines = draw_entry(&mut acct, &mut hs, 500).unwrap();
    assert_eq!(
        lines,
        vec![
            Line {
                source: [5; 32],
                amount: 300
            },
            Line {
                source: [1; 32],
                amount: 200
            }
        ]
    );
    assert_eq!((acct.own_total, acct.won_total), (0, 200));
}

fn side(player: Key, funder: Key, share: u16, lines: &[(u8, u64)]) -> Side {
    Side {
        player,
        funder,
        share_bps: share,
        lines: lines
            .iter()
            .map(|(s, a)| Line {
                source: [*s; 32],
                amount: *a,
            })
            .collect(),
    }
}

#[test]
fn match_settles_once_and_pays_fees_in_gemas() {
    let mut m = Match::open(
        GAME,
        1_000,
        fees(),
        side(akey(0), akey(0), 0, &[(1, 1_000)]),
        0,
    )
    .unwrap();
    m.join(side(akey(1), akey(1), 0, &[(2, 600), (3, 400)]), 10)
        .unwrap();
    let payouts = m.settle(Outcome::Winner(0)).unwrap();
    let to = |k: Key| {
        payouts
            .iter()
            .filter(|p| p.recipient == k)
            .map(|p| p.amount)
            .sum::<u64>()
    };
    assert_eq!(to(akey(PLATFORM)), 40);
    assert_eq!(to(akey(STUDIO)), 60);
    assert_eq!(to(akey(0)), 1_000 + 900);
    assert_eq!(m.settle(Outcome::Winner(1)), Err(CoreError::InvalidStatus));
    assert_eq!(m.refund(i64::MAX, true), Err(CoreError::InvalidStatus));
}

#[test]
fn backing_win_returns_entry_then_splits_and_loss_costs_the_entry() {
    let mk = || {
        let mut m = Match::open(
            GAME,
            500,
            fees(),
            side(akey(0), akey(2), 4_000, &[(8, 500)]),
            0,
        )
        .unwrap();
        m.join(side(akey(1), akey(1), 0, &[(9, 500)]), 1).unwrap();
        m
    };
    // Backed Player (0) wins: surplus = 500 - 20 - 30 = 450; Player gets 40% = 180.
    let payouts = mk().settle(Outcome::Winner(0)).unwrap();
    let to = |k: Key| {
        payouts
            .iter()
            .filter(|p| p.recipient == k)
            .map(|p| p.amount)
            .sum::<u64>()
    };
    assert_eq!(to(akey(2)), 500 + 270);
    assert_eq!(to(akey(0)), 180);
    // Backed Player loses: Backer's Gemas go to the other side, minus fees.
    let payouts = mk().settle(Outcome::Winner(1)).unwrap();
    let to = |k: Key| {
        payouts
            .iter()
            .filter(|p| p.recipient == k)
            .map(|p| p.amount)
            .sum::<u64>()
    };
    assert_eq!(to(akey(2)), 0);
    assert_eq!(to(akey(0)), 0);
    assert_eq!(to(akey(1)), 500 + 450);
}

#[test]
fn offers_expire_and_cannot_be_revoked_after_match_start() {
    let mut acct = Account::default();
    let mut h = Holding::new([3; 32], true);
    h.credit(&mut acct, 2_500).unwrap();
    let mut hs = [h];
    let mut offer = Offer::create(
        akey(2),
        GAME,
        500,
        5_000,
        OfferKind::Public,
        0,
        &mut acct,
        &mut hs,
    )
    .unwrap();
    assert_eq!((hs[0].reserved, acct.own_reserved), (500, 500));
    let mut req = Request::new(akey(0), GAME, 500, 0).unwrap();
    offer.apply(&req, rkey(0), 10).unwrap();
    assert_eq!(
        offer.apply(&req, rkey(0), 11),
        Err(CoreError::AlreadyApplied)
    );
    offer.accept_applicant(&mut req, rkey(0), 20).unwrap();
    // Wrong Player cannot use it.
    assert_eq!(
        offer
            .consume(akey(1), GAME, 500, 30, &mut acct, &mut hs)
            .unwrap_err(),
        CoreError::NotParty
    );
    let side = offer
        .consume(akey(0), GAME, 500, 30, &mut acct, &mut hs)
        .unwrap();
    assert_eq!(side.funder, akey(2));
    assert_eq!(
        (hs[0].amount, hs[0].reserved, acct.own_total),
        (2_000, 0, 2_000)
    );
    assert_eq!(
        offer.cancel(&mut acct, &mut hs),
        Err(CoreError::InvalidStatus)
    );
    // A fresh Offer expires after 24h and releases.
    let mut o2 = Offer::create(
        akey(2),
        GAME,
        500,
        5_000,
        OfferKind::Public,
        0,
        &mut acct,
        &mut hs,
    )
    .unwrap();
    assert_eq!(
        o2.expire(BACKING_TTL_SECS - 1, &mut acct, &mut hs),
        Err(CoreError::NotExpired)
    );
    o2.expire(BACKING_TTL_SECS, &mut acct, &mut hs).unwrap();
    assert_eq!(hs[0].reserved, 0);
    assert_eq!(
        o2.accept_applicant(&mut req, rkey(0), BACKING_TTL_SECS + 1),
        Err(CoreError::InvalidStatus)
    );
}

// --- Many-Source entries -------------------------------------------------------------------

/// A holder with the given own and won balances, one Holding per Source (distinct keys from
/// `base`; won Sources sort after own ones within one holder).
fn holder(own: &[u64], won: &[u64], base: u8) -> (Account, Vec<Holding>) {
    let mut acct = Account::default();
    let mut hs = Vec::new();
    for (i, n) in own.iter().enumerate() {
        let mut h = Holding::new([base + i as u8; 32], true);
        h.credit(&mut acct, *n).unwrap();
        hs.push(h);
    }
    for (i, n) in won.iter().enumerate() {
        let mut h = Holding::new([base + 20 + i as u8; 32], false);
        h.credit(&mut acct, *n).unwrap();
        hs.push(h);
    }
    (acct, hs)
}

/// The smallest canonical set of Holdings covering `entry` (what the client picks): own class
/// first (all of it when the entry needs every own Gema), then a minimal cover of the won class,
/// each class ascending by Source. `None` if the Account cannot cover the entry.
fn minimal_set(acct: &Account, hs: &[Holding], entry: u64) -> Option<Vec<usize>> {
    let own_need = entry.min(acct.own_free());
    let won_need = entry - own_need;
    if won_need > acct.won_free() {
        return None;
    }
    let mut picked = Vec::new();
    for (is_own, need) in [(true, own_need), (false, won_need)] {
        let mut class: Vec<usize> = (0..hs.len())
            .filter(|i| hs[*i].is_own == is_own && hs[*i].free() > 0)
            .collect();
        let class_free: u64 = class.iter().map(|i| hs[*i].free()).sum();
        let mut chosen: Vec<usize> = if need == class_free {
            class.clone()
        } else {
            class.sort_by(|x, y| hs[*y].free().cmp(&hs[*x].free()));
            let mut left = need;
            let mut out = Vec::new();
            for i in class {
                if left == 0 {
                    break;
                }
                out.push(i);
                left -= left.min(hs[i].free());
            }
            out
        };
        chosen.sort_by_key(|i| hs[*i].source);
        picked.extend(chosen);
    }
    Some(picked)
}

fn draw_picked(
    acct: &mut Account,
    hs: &[Holding],
    pick: &[usize],
    entry: u64,
) -> (CoreResult<Vec<Line>>, Vec<Holding>) {
    let mut chosen: Vec<Holding> = pick.iter().map(|i| hs[*i].clone()).collect();
    let r = draw_entry(acct, &mut chosen, entry);
    (r, chosen)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, ..ProptestConfig::default() })]

    /// An Account spread over many Sources enters with the minimal canonical set whenever that set
    /// fits the cap; the Pot conserves, and settlement stays bounded and deterministic.
    #[test]
    fn many_source_entries_conserve_and_settle_bounded(
        a_own in prop::collection::vec(1u64..400, 0..9),
        a_won in prop::collection::vec(1u64..400, 0..9),
        b_own in prop::collection::vec(1u64..400, 0..9),
        b_won in prop::collection::vec(1u64..400, 0..9),
        entry_ix in 0usize..3,
        opener_wins in any::<bool>(),
    ) {
        let entry = LADDER[entry_ix];
        let (mut a_acct, mut a_hs) = holder(&a_own, &a_won, 1);
        let (mut b_acct, mut b_hs) = holder(&b_own, &b_won, 60);
        let a_total = a_acct.own_total + a_acct.won_total;
        let b_total = b_acct.own_total + b_acct.won_total;
        let (Some(a_pick), Some(b_pick)) = (
            minimal_set(&a_acct, &a_hs, entry),
            minimal_set(&b_acct, &b_hs, entry),
        ) else {
            // Not enough Gemas: any set is refused.
            let (acct, hs) = if minimal_set(&a_acct, &a_hs, entry).is_none() { (&mut a_acct, &mut a_hs) } else { (&mut b_acct, &mut b_hs) };
            let r = draw_entry(acct, hs, entry);
            prop_assert!(r.is_err());
            return Ok(());
        };
        let (a_lines, a_chosen) = draw_picked(&mut a_acct, &a_hs, &a_pick, entry);
        if a_pick.len() > MAX_ENTRY_SOURCES {
            prop_assert_eq!(a_lines, Err(CoreError::TooManySources));
            return Ok(());
        }
        let a_lines = a_lines.expect("minimal canonical set is accepted");
        let (b_lines, b_chosen) = draw_picked(&mut b_acct, &b_hs, &b_pick, entry);
        if b_pick.len() > MAX_ENTRY_SOURCES {
            prop_assert_eq!(b_lines, Err(CoreError::TooManySources));
            return Ok(());
        }
        let b_lines = b_lines.expect("minimal canonical set is accepted");

        // The entry left the Holdings exactly, line by line.
        for (lines, chosen) in [(&a_lines, &a_chosen), (&b_lines, &b_chosen)] {
            prop_assert_eq!(lines.iter().map(|l| l.amount).sum::<u64>(), entry);
            prop_assert!(lines.len() <= MAX_ENTRY_SOURCES);
            prop_assert_eq!(chosen.len(), lines.len());
        }
        prop_assert_eq!(a_acct.own_total + a_acct.won_total, a_total - entry);
        prop_assert_eq!(b_acct.own_total + b_acct.won_total, b_total - entry);

        let a_side = Side { player: akey(0), funder: akey(0), share_bps: 0, lines: a_lines };
        let b_side = Side { player: akey(1), funder: akey(1), share_bps: 0, lines: b_lines };
        let mut m = Match::open(GAME, entry, fees(), a_side.clone(), 0).unwrap();
        m.join(b_side.clone(), 1).unwrap();
        let outcome = if opener_wins { Outcome::Winner(0) } else { Outcome::Winner(1) };
        let payouts = m.settle(outcome).unwrap();
        // Everything in the Pot is paid out, none invented, per Source too.
        prop_assert_eq!(payouts.iter().map(|p| p.amount).sum::<u64>(), entry * 2);
        let mut per_source: BTreeMap<Key, u64> = BTreeMap::new();
        for l in a_side.lines.iter().chain(b_side.lines.iter()) {
            *per_source.entry(l.source).or_default() += l.amount;
        }
        let mut paid: BTreeMap<Key, u64> = BTreeMap::new();
        for p in &payouts {
            *paid.entry(p.source).or_default() += p.amount;
        }
        prop_assert_eq!(per_source, paid);
        // Deterministic order, merged, and bounded: winner's lines plus the loser's lines cut at
        // most twice by the two fees.
        prop_assert!(payouts.windows(2).all(|w| (w[0].recipient, w[0].source) < (w[1].recipient, w[1].source)));
        prop_assert!(payouts.len() <= 2 * MAX_ENTRY_SOURCES + 2);
    }
}

#[test]
fn eight_holdings_enter_and_a_ninth_is_refused() {
    let own = [70u64; 9];
    let (mut acct, hs) = holder(&own, &[], 1);
    let mut nine = hs.clone();
    assert_eq!(
        draw_entry(&mut acct.clone(), &mut nine, 500),
        Err(CoreError::TooManySources)
    );
    // 8 x 70 = 560 covers 500: seven drained, the eighth partly.
    let mut eight = hs[..8].to_vec();
    let lines = draw_entry(&mut acct, &mut eight, 500).unwrap();
    assert_eq!(lines.len(), 8);
    assert_eq!(lines[7].amount, 10);
    assert_eq!(acct.own_total, 9 * 70 - 500);
    // Skipping a Holding is allowed when the rest covers the entry (the client's minimal set).
    let (mut acct, hs) = holder(&[10, 300, 10, 300], &[], 1);
    let mut pick = vec![hs[1].clone(), hs[3].clone()];
    // own_free = 620 > 500, so 300 + 200 from the two big ones; the small ones stay.
    let lines = draw_entry(&mut acct, &mut pick, 500).unwrap();
    assert_eq!(lines.iter().map(|l| l.amount).sum::<u64>(), 500);
}

#[test]
fn a_backed_entry_over_eight_sources_settles_with_bounded_payouts() {
    let (mut acct, mut hs) = holder(&[63; 8], &[], 1);
    let mut offer = Offer::create(
        akey(2),
        GAME,
        500,
        4_000,
        OfferKind::Public,
        0,
        &mut acct,
        &mut hs,
    )
    .unwrap();
    assert_eq!(hs.iter().filter(|h| h.reserved > 0).count(), 8);
    let mut req = Request::new(akey(0), GAME, 500, 0).unwrap();
    offer.apply(&req, rkey(0), 10).unwrap();
    offer.accept_applicant(&mut req, rkey(0), 20).unwrap();
    let a_side = offer
        .consume(akey(0), GAME, 500, 30, &mut acct, &mut hs)
        .unwrap();
    assert_eq!(a_side.lines.len(), 8);
    let mut m = Match::open(GAME, 500, fees(), a_side, 30).unwrap();
    let b = side(
        akey(1),
        akey(1),
        0,
        &[
            (80, 60),
            (81, 60),
            (82, 60),
            (83, 60),
            (84, 60),
            (85, 60),
            (86, 60),
            (87, 80),
        ],
    );
    m.join(b, 31).unwrap();
    let payouts = m.settle(Outcome::Winner(0)).unwrap();
    assert_eq!(payouts.iter().map(|p| p.amount).sum::<u64>(), 1_000);
    assert!(payouts.len() <= 2 * MAX_ENTRY_SOURCES + 3);
}

const POOL: usize = 3;

fn lb() -> LeaderboardTerms {
    LeaderboardTerms {
        bps: 100,
        recipient: akey(POOL),
    }
}

#[test]
fn leaderboard_fee_comes_from_the_loser_after_platform_and_studio() {
    let mk = |backed: bool| {
        let funder = if backed { akey(2) } else { akey(0) };
        let mut m = Match::open(
            GAME,
            1_000,
            fees(),
            side(akey(0), funder, 4_000, &[(1, 1_000)]),
            0,
        )
        .unwrap();
        m.join(side(akey(1), akey(1), 0, &[(2, 30), (3, 970)]), 10)
            .unwrap();
        m
    };
    // Pot 2_000: platform 40, studio 60, pool 20; the winner nets 1_000 + 880.
    let mut m = mk(false);
    assert_eq!(m.leaderboard_due(&lb()).unwrap(), 20);
    let payouts = m.settle_with(Outcome::Winner(0), &lb()).unwrap();
    let to = |k: Key| {
        payouts
            .iter()
            .filter(|p| p.recipient == k)
            .map(|p| p.amount)
            .sum::<u64>()
    };
    assert_eq!(to(akey(PLATFORM)), 40);
    assert_eq!(to(akey(STUDIO)), 60);
    assert_eq!(to(akey(POOL)), 20);
    assert_eq!(to(akey(0)), 1_000 + 880);
    let total: u64 = payouts.iter().map(|p| p.amount).sum();
    assert_eq!(total, 2_000);
    // Backed: the Backer's entry back, then the Offer's split of the surplus after all fees.
    let payouts = mk(true).settle_with(Outcome::Winner(0), &lb()).unwrap();
    let to = |k: Key| {
        payouts
            .iter()
            .filter(|p| p.recipient == k)
            .map(|p| p.amount)
            .sum::<u64>()
    };
    assert_eq!(to(akey(POOL)), 20);
    assert_eq!(to(akey(0)), 352);
    assert_eq!(to(akey(2)), 1_000 + 528);
    // Without terms nothing is taken, a draw never pays it.
    let payouts = mk(false).settle(Outcome::Winner(0)).unwrap();
    assert!(payouts.iter().all(|p| p.recipient != akey(POOL)));
    let payouts = mk(false).settle_with(Outcome::Draw, &lb()).unwrap();
    assert!(payouts.iter().all(|p| p.recipient != akey(POOL)));
    assert_eq!(payouts.iter().map(|p| p.amount).sum::<u64>(), 2_000);
}

#[test]
fn all_fees_together_stay_under_the_cap() {
    let mut m = Match::open(GAME, 500, fees(), side(akey(0), akey(0), 0, &[(1, 500)]), 0).unwrap();
    m.join(side(akey(1), akey(1), 0, &[(2, 500)]), 1).unwrap();
    let hot = LeaderboardTerms {
        bps: MAX_TOTAL_FEE_BPS,
        recipient: akey(POOL),
    };
    assert_eq!(
        m.settle_with(Outcome::Winner(0), &hot),
        Err(CoreError::FeeTooHigh)
    );
    assert_eq!(m.status, MatchStatus::Active);
}

#[test]
fn seasons_are_weeks_from_a_monday() {
    assert_eq!(season_at(SEASON_EPOCH - 1), Err(CoreError::SeasonInvalid));
    assert_eq!(season_at(SEASON_EPOCH), Ok(1));
    assert_eq!(season_at(SEASON_EPOCH + SEASON_SECS - 1), Ok(1));
    assert_eq!(season_at(SEASON_EPOCH + SEASON_SECS), Ok(2));
    assert_eq!(season_start(2), Ok(SEASON_EPOCH + SEASON_SECS));
    assert_eq!(season_end(1), season_start(2));
    assert_eq!(season_start(0), Err(CoreError::SeasonInvalid));
    // 1970-01-01 was a Thursday: the epoch is a whole number of days from a Monday.
    assert_eq!(((SEASON_EPOCH / 86_400) + 3) % 7, 0);
    assert_eq!(PRIZE_BPS.iter().map(|b| *b as u32).sum::<u32>(), 10_000);
    assert_eq!([500u64, 1_000, 2_500].map(points_for_win), [5, 10, 25]);
}

fn ranked(points: &[u64]) -> Vec<Ranked> {
    points
        .iter()
        .enumerate()
        .map(|(i, p)| Ranked {
            account: akey(i),
            points: *p,
        })
        .collect()
}

#[test]
fn a_season_pays_the_scale_and_unfilled_ranks_roll_over() {
    let end = season_end(1).unwrap();
    assert_eq!(
        Season::record(1, end - 1, 10_000, &ranked(&[5])),
        Err(CoreError::SeasonNotEnded)
    );
    let mut s = Season::record(1, end, 10_000, &ranked(&[50, 40, 40, 5])).unwrap();
    assert_eq!(s.count, 4);
    assert_eq!(s.amounts[..5], [2_500, 1_800, 1_300, 1_000, 0]);
    // Only 66% of the pool is allocated; the rest stays for the next season.
    assert_eq!(s.amounts.iter().sum::<u64>(), 6_600);
    assert_eq!(s.pay(0), Ok(2_500));
    assert_eq!(s.pay(0), Err(CoreError::AlreadyPaid));
    assert_eq!(s.pay(4), Err(CoreError::SeasonInvalid));
    assert!(s.paid(0) && !s.paid(1));

    // Amounts are floored: never more than the pool.
    let full = ranked(&[10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    let s = Season::record(1, end, 12_345, &full).unwrap();
    assert!(s.amounts.iter().sum::<u64>() <= 12_345);
    assert_eq!(s.amounts[0], 3_086);
}

#[test]
fn a_ranking_must_be_ordered_distinct_and_at_most_ten() {
    let end = season_end(3).unwrap();
    let bad = |r: Vec<Ranked>| Season::record(3, end, 1_000, &r);
    assert_eq!(bad(ranked(&[5, 6])), Err(CoreError::SeasonInvalid));
    assert_eq!(bad(ranked(&[5, 0])), Err(CoreError::SeasonInvalid));
    assert_eq!(bad(ranked(&[1; 11])), Err(CoreError::SeasonInvalid));
    let mut dup = ranked(&[5, 4]);
    dup[1].account = dup[0].account;
    assert_eq!(bad(dup), Err(CoreError::SeasonInvalid));
    assert!(bad(vec![]).is_ok());
}

#[test]
fn a_prize_drains_pool_holdings_in_source_order() {
    let h = |s: u8, amount: u64| {
        let mut h = Holding::new([s; 32], false);
        h.amount = amount;
        h
    };
    assert_eq!(plan_prize(&[h(1, 50), h(2, 100)], 120), Ok(vec![50, 70]));
    assert_eq!(plan_prize(&[h(1, 500)], 120), Ok(vec![120]));
    // Not enough supplied, an extra one, empty ones and unordered ones are refused.
    assert_eq!(
        plan_prize(&[h(1, 50), h(2, 10)], 120),
        Err(CoreError::PrizeShortfall)
    );
    assert_eq!(
        plan_prize(&[h(1, 500), h(2, 10)], 120),
        Err(CoreError::NonCanonicalPrize)
    );
    assert_eq!(
        plan_prize(&[h(1, 0), h(2, 500)], 120),
        Err(CoreError::NonCanonicalPrize)
    );
    assert_eq!(
        plan_prize(&[h(2, 50), h(1, 500)], 120),
        Err(CoreError::NonCanonicalPrize)
    );
}

// --- Yield Fee and Instant Redeem -------------------------------------------------------------

#[test]
fn advance_is_net_of_the_yield_fee_and_repaid_at_the_horizon() {
    let mut p = locked_position();
    // Gross yield over 6 months: 5 SOL; net of the 20% Yield Fee: 4 SOL. At $150 => 60_000 Gemas.
    let mut s = p.open_advance(pkey(0), 6, 150_000_000, 2_000).unwrap();
    assert_eq!(s.issued, 60_000);
    // The Position earns 80% of its gross yield; at the Horizon it has earned exactly the Advance.
    let gross_at_horizon = 5_000_000_000u64;
    let (net, fee) = split_yield_fee(gross_at_horizon, 2_000).unwrap();
    assert_eq!((net, fee), (4_000_000_000, 1_000_000_000));
    let (half, _) = split_yield_fee(gross_at_horizon / 2, 2_000).unwrap();
    assert!(p.apply_yield(Some(&mut s), 1, half).unwrap());
    assert_eq!(s.debt(), 30_000, "half the Horizon repays half the Advance");
    assert!(p.apply_yield(Some(&mut s), 2, net).unwrap());
    assert_eq!(s.debt(), 0);
    assert_eq!(p.free_yield, 0, "nothing left over at the Horizon");
    assert_eq!(p.open_advance, None);
    assert_eq!(
        locked_position().open_advance(pkey(0), 6, 150_000_000, MAX_YIELD_FEE_BPS + 1),
        Err(CoreError::InvalidBps)
    );
}

#[test]
fn yield_fee_split_floors_the_fee() {
    assert_eq!(split_yield_fee(9, 2_000).unwrap(), (8, 1));
    assert_eq!(split_yield_fee(4, 2_000).unwrap(), (4, 0));
    assert_eq!(split_yield_fee(1_000, 0).unwrap(), (1_000, 0));
    assert_eq!(split_yield_fee(1, 5_001), Err(CoreError::InvalidBps));
}

#[test]
fn instant_redeem_moves_won_gemas_to_the_treasury_and_pays_65_percent() {
    let mut p = locked_position();
    let mut s = p.open_advance(pkey(0), 6, 150_000_000, 2_000).unwrap();
    let mut holder = Account::default();
    let mut won = Holding::new(skey(0, 0), false);
    won.credit(&mut holder, 1_000).unwrap();
    let mut treasury = Account::default();
    let mut bought = Holding::new(skey(0, 0), false);
    let before = s.clone();

    let (units, payout) = instant_redeem(
        &s,
        &mut holder,
        &mut won,
        &mut treasury,
        &mut bought,
        1_000,
        3_500,
    )
    .unwrap();
    // 1,000 Gemas at $150/SOL = $10 = 0.0666... SOL; 65% of it now.
    assert_eq!(units, s.units_for(1_000).unwrap());
    assert_eq!(payout, units * 6_500 / 10_000);
    assert_eq!((won.amount, holder.won_total), (0, 0));
    assert_eq!((bought.amount, treasury.won_total), (1_000, 1_000));
    assert_eq!(s, before, "the Source's counts are untouched");

    // The Treasury redeems at full value once the yield lands.
    assert!(p.apply_yield(Some(&mut s), 1, 4_000_000_000).unwrap());
    let free = bought.free();
    let full = redeem(&mut s, &mut treasury, &mut bought, free).unwrap();
    assert_eq!(full, units);
    assert!(full > payout);
}

#[test]
fn instant_redeem_sells_only_gemas_whose_yield_has_not_landed() {
    let mut p = locked_position();
    let mut s = p.open_advance(pkey(0), 6, 150_000_000, 2_000).unwrap();
    let issued = s.outstanding();
    let mut holder = Account::default();
    let mut won = Holding::new(skey(0, 0), false);
    won.credit(&mut holder, issued).unwrap();
    let mut treasury = Account::default();
    let mut bought = Holding::new(skey(0, 0), false);

    // Half the Horizon's yield lands: half the holding is redeemable in full, half is pending.
    let (net, _) = split_yield_fee(2_500_000_000, 2_000).unwrap();
    assert!(p.apply_yield(Some(&mut s), 1, net).unwrap());
    let landed = s.redeemable_for(won.free());
    let pending = won.free() - landed;
    assert!(landed > 0 && pending > 0);
    assert_eq!(
        instant_redeem(
            &s,
            &mut holder,
            &mut won,
            &mut treasury,
            &mut bought,
            pending + 1,
            3_500
        ),
        Err(CoreError::ExceedsPending)
    );
    assert_eq!(bought.amount, 0, "nothing moves on failure");

    // Redeem the landed part in full first, then sell what is still pending.
    redeem(&mut s, &mut holder, &mut won, landed).unwrap();
    let rest = won.free();
    assert_eq!(
        s.redeemable_for(rest),
        0,
        "a sole holder has nothing landed left"
    );
    instant_redeem(
        &s,
        &mut holder,
        &mut won,
        &mut treasury,
        &mut bought,
        rest,
        3_500,
    )
    .unwrap();
    assert_eq!((won.amount, bought.amount), (0, rest));
}

#[test]
fn instant_redeem_refuses_own_gemas_reserved_gemas_and_zero_payouts() {
    let p = &mut locked_position();
    let s = p.open_advance(pkey(0), 6, 150_000_000, 2_000).unwrap();
    let mut holder = Account::default();
    let mut own = Holding::new(skey(0, 0), true);
    own.credit(&mut holder, 500).unwrap();
    let mut treasury = Account::default();
    let mut bought = Holding::new(skey(0, 0), false);
    assert_eq!(
        instant_redeem(
            &s,
            &mut holder,
            &mut own,
            &mut treasury,
            &mut bought,
            100,
            3_500
        ),
        Err(CoreError::NotWonGemas)
    );

    let mut won = Holding::new(skey(0, 0), false);
    won.credit(&mut holder, 100).unwrap();
    won.reserved = 60;
    holder.won_reserved = 60;
    assert_eq!(
        instant_redeem(
            &s,
            &mut holder,
            &mut won,
            &mut treasury,
            &mut bought,
            50,
            3_500
        ),
        Err(CoreError::InsufficientGemas)
    );
    assert_eq!(bought.amount, 0, "nothing moves on failure");
    assert_eq!(
        instant_redeem(
            &s,
            &mut holder,
            &mut won,
            &mut treasury,
            &mut bought,
            0,
            3_500
        ),
        Err(CoreError::ZeroAmount)
    );
    let mut other = Holding::new(skey(1, 0), false);
    assert_eq!(
        instant_redeem(
            &s,
            &mut holder,
            &mut won,
            &mut treasury,
            &mut other,
            10,
            3_500
        ),
        Err(CoreError::HoldingMismatch)
    );
    assert_eq!(
        instant_redeem(
            &s,
            &mut holder,
            &mut won,
            &mut treasury,
            &mut bought,
            10,
            5_001
        ),
        Err(CoreError::InvalidBps)
    );
}

// --- Extend Limit ------------------------------------------------------------------------------

const T: i64 = 1_800_000_000;
const DAY: i64 = 24 * 60 * 60;

#[test]
fn a_fresh_extend_limit_is_three_months() {
    let l = ExtendLimit::default();
    assert_eq!(l.effective(T), 3);
    assert_eq!(l.window_months, 0);
}

#[test]
fn extends_are_recorded_against_the_limit_until_it_is_reached() {
    let mut l = ExtendLimit::default();
    l.record_extend(T, 2).unwrap();
    // Inside 24 h of the last Extend: refused, and nothing changes.
    assert_eq!(
        l.record_extend(T + DAY - 1, 1),
        Err(CoreError::ExtendCoolingDown)
    );
    assert_eq!(l.window_months, 2);
    // Exactly 24 h later it is allowed; the third month fills the limit.
    l.record_extend(T + DAY, 1).unwrap();
    assert_eq!(l.window_months, 3);
    assert_eq!(l.last_extend_at, T + DAY);
    // Past the wait but over the limit.
    assert_eq!(
        l.record_extend(T + 3 * DAY, 1),
        Err(CoreError::ExtendLimitReached)
    );
    assert_eq!(l.window_months, 3);
}

#[test]
fn an_extend_larger_than_the_limit_is_refused_at_once() {
    let mut l = ExtendLimit::default();
    assert_eq!(l.record_extend(T, 4), Err(CoreError::ExtendLimitReached));
    assert_eq!(l, ExtendLimit::default());
}

#[test]
fn the_period_resets_exactly_thirty_days_after_it_began() {
    let mut l = ExtendLimit::default();
    l.record_extend(T, 3).unwrap();
    assert_eq!(
        l.record_extend(T + 30 * DAY - 1, 1),
        Err(CoreError::ExtendLimitReached)
    );
    l.record_extend(T + 30 * DAY, 3).unwrap();
    assert_eq!((l.window_start, l.window_months), (T + 30 * DAY, 3));
}

#[test]
fn a_limit_of_zero_blocks_extend() {
    let mut l = ExtendLimit::default();
    l.set_limit(T, 0).unwrap();
    assert_eq!(l.effective(T), 0);
    assert_eq!(l.record_extend(T, 1), Err(CoreError::ExtendLimitReached));
}

#[test]
fn lowering_the_limit_works_at_once_and_a_raise_waits_a_day() {
    let mut l = ExtendLimit::default();
    l.set_limit(T, 1).unwrap();
    assert_eq!(l.effective(T), 1);
    l.set_limit(T, 5).unwrap();
    assert_eq!(l.effective(T), 1);
    assert_eq!(l.effective(T + DAY - 1), 1);
    assert_eq!(l.effective(T + DAY), 5);
    // The raise is in force for an Extend after its day.
    l.record_extend(T + DAY, 5).unwrap();
}

#[test]
fn lowering_below_a_pending_raise_cancels_it() {
    let mut l = ExtendLimit::default();
    l.set_limit(T, 6).unwrap();
    l.set_limit(T + 10, 2).unwrap();
    assert_eq!(l.effective(T + 10 * DAY), 2);
    // Setting the limit already in force while a raise waits cancels it too.
    let mut m = ExtendLimit::default();
    m.set_limit(T, 6).unwrap();
    m.set_limit(T + 10, 3).unwrap();
    assert_eq!(m.effective(T + 10 * DAY), 3);
}

#[test]
fn setting_the_pending_raise_again_keeps_its_timer() {
    let mut l = ExtendLimit::default();
    l.set_limit(T, 6).unwrap();
    let before = l;
    l.set_limit(T + 100, 6).unwrap();
    assert_eq!(l, before);
    assert_eq!(l.effective(T + DAY), 6);
}

#[test]
fn setting_the_limit_in_force_with_no_raise_pending_changes_nothing() {
    let mut l = ExtendLimit::default();
    let before = l;
    l.set_limit(T, DEFAULT_EXTEND_LIMIT).unwrap();
    assert_eq!(l, before);
}

#[test]
fn a_due_raise_is_settled_before_the_next_change() {
    let mut l = ExtendLimit::default();
    l.set_limit(T, 6).unwrap();
    // After its day the raise is the limit; lowering from there is a lowering.
    l.set_limit(T + 2 * DAY, 4).unwrap();
    assert_eq!(l.effective(T + 2 * DAY), 4);
}

#[test]
fn the_limit_is_at_most_eleven_months() {
    let mut l = ExtendLimit::default();
    assert_eq!(l.set_limit(T, 12), Err(CoreError::InvalidExtendLimit));
    l.set_limit(T, 11).unwrap();
    assert_eq!(l.effective(T + DAY), 11);
}

#[test]
fn the_twelve_month_horizon_still_caps_an_extend_inside_the_limit() {
    let mut p = locked_position();
    let mut s = p.open_advance(pkey(0), 6, 150_000_000, 0).unwrap();
    p.apply_yield(Some(&mut s), 1, 500_000_000).unwrap();
    let mut l = ExtendLimit::default();
    l.set_limit(T, 11).unwrap();
    l.record_extend(T + DAY, 7).unwrap();
    assert_eq!(
        p.extend_advance(&mut s, 7, 0),
        Err(CoreError::InvalidHorizon)
    );
}

// --- Entry Limit -------------------------------------------------------------------------------

const WEEK: i64 = 7 * DAY;

#[test]
fn no_entry_limit_counts_nothing_and_refuses_nothing() {
    let mut l = EntryLimit::default();
    l.record_entry(T, 2_500).unwrap();
    assert_eq!(l, EntryLimit::default());
    assert_eq!(l.effective(T), 0);
}

#[test]
fn entries_count_in_a_period_until_the_limit_is_reached() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 1_500).unwrap();
    assert_eq!(l.effective(T), 1_500);
    l.record_entry(T, 500).unwrap();
    l.record_entry(T + DAY, 1_000).unwrap();
    assert_eq!(l.used(T + DAY), 1_500);
    assert_eq!(
        l.record_entry(T + 2 * DAY, 500),
        Err(CoreError::EntryLimitReached)
    );
    assert_eq!(l.used(T + 2 * DAY), 1_500);
}

#[test]
fn an_entry_over_the_limit_changes_nothing() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 1_000).unwrap();
    let before = l;
    assert_eq!(l.record_entry(T, 2_500), Err(CoreError::EntryLimitReached));
    assert_eq!(l, before);
}

#[test]
fn the_period_resets_exactly_seven_days_after_it_began() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 1_000).unwrap();
    l.record_entry(T, 1_000).unwrap();
    assert_eq!(
        l.record_entry(T + WEEK - 1, 500),
        Err(CoreError::EntryLimitReached)
    );
    assert_eq!(l.used(T + WEEK - 1), 1_000);
    assert_eq!(l.used(T + WEEK), 0);
    l.record_entry(T + WEEK, 1_000).unwrap();
    assert_eq!((l.window_start, l.window_used), (T + WEEK, 1_000));
}

#[test]
fn lowering_the_entry_limit_works_at_once_even_below_what_is_used() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 2_500).unwrap();
    l.record_entry(T, 1_000).unwrap();
    l.set_limit(T + 1, 500).unwrap();
    assert_eq!(l.effective(T + 1), 500);
    assert_eq!(
        l.record_entry(T + 2, 500),
        Err(CoreError::EntryLimitReached)
    );
}

#[test]
fn a_raised_entry_limit_waits_a_day() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 500).unwrap();
    l.set_limit(T + 10, 2_500).unwrap();
    assert_eq!(l.effective(T + 10), 500);
    assert_eq!(l.effective(T + 10 + DAY - 1), 500);
    assert_eq!(l.effective(T + 10 + DAY), 2_500);
    assert_eq!(
        l.record_entry(T + 10 + DAY - 1, 1_000),
        Err(CoreError::EntryLimitReached)
    );
    l.record_entry(T + 10 + DAY, 1_000).unwrap();
}

#[test]
fn removing_the_entry_limit_is_a_raise_and_waits_a_day() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 500).unwrap();
    l.set_limit(T, 0).unwrap();
    assert_eq!(l.effective(T + DAY - 1), 500);
    assert_eq!(l.effective(T + DAY), 0);
    l.record_entry(T + DAY, 2_500).unwrap();
    l.record_entry(T + DAY + 1, 2_500).unwrap();
}

#[test]
fn setting_a_first_limit_applies_at_once() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 1_000).unwrap();
    assert_eq!(l.effective(T), 1_000);
    assert_eq!(l.pending_at, 0);
}

#[test]
fn lowering_or_restating_the_limit_cancels_a_pending_raise() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 1_000).unwrap();
    l.set_limit(T + 10, 2_500).unwrap();
    l.set_limit(T + 20, 500).unwrap();
    assert_eq!((l.pending_at, l.effective(T + 9 * DAY)), (0, 500));
    let mut m = EntryLimit::default();
    m.set_limit(T, 1_000).unwrap();
    m.set_limit(T + 10, 2_500).unwrap();
    m.set_limit(T + 20, 1_000).unwrap();
    assert_eq!((m.pending_at, m.effective(T + 9 * DAY)), (0, 1_000));
}

#[test]
fn setting_the_pending_entry_raise_again_keeps_its_timer() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 500).unwrap();
    l.set_limit(T + 5, 1_000).unwrap();
    let before = l;
    l.set_limit(T + 100, 1_000).unwrap();
    assert_eq!(l, before);
}

#[test]
fn a_due_entry_raise_is_settled_before_the_next_change() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 500).unwrap();
    l.set_limit(T, 2_500).unwrap();
    l.set_limit(T + 2 * DAY, 1_000).unwrap();
    assert_eq!((l.effective(T + 2 * DAY), l.pending_at), (1_000, 0));
}

#[test]
fn lowering_a_removed_limit_is_a_lowering() {
    let mut l = EntryLimit::default();
    l.set_limit(T, 500).unwrap();
    l.set_limit(T, 0).unwrap();
    l.set_limit(T + 2 * DAY, 1_000).unwrap();
    assert_eq!((l.effective(T + 2 * DAY), l.pending_at), (1_000, 0));
}

#[test]
fn protections_keep_a_fixed_size_with_room_for_break_and_self_exclusion() {
    use anchor_lang::prelude::AnchorSerialize;
    let p = Protections::default();
    assert_eq!(p.try_to_vec().unwrap().len(), Protections::SPACE);
    assert_eq!((p.break_until, p.self_exclusion_until), (0, 0));
}

#[test]
fn a_rank_is_paid_only_after_the_window_and_can_be_voided_inside_it() {
    let end = season_end(1).unwrap();
    let season = Season::record(1, end, 10_000, &ranked(&[50, 40, 30])).unwrap();
    let mut w = SeasonWindow::new(1, end + 60);
    let opens = end + 60 + PAYOUT_WINDOW_SECS;
    assert_eq!(PAYOUT_WINDOW_SECS, 172_800);
    assert_eq!(w.check_pay(0, opens - 1), Err(CoreError::PayoutWindowOpen));
    assert_eq!(w.check_pay(0, opens), Ok(()));

    assert_eq!(w.void(&season, 3, end + 61), Err(CoreError::SeasonInvalid));
    assert_eq!(w.void(&season, 1, end + 61), Ok(()));
    assert_eq!(w.void(&season, 1, end + 62), Err(CoreError::RankVoided));
    assert!(w.voided(1) && !w.voided(0) && !w.voided(2));
    // Nobody moves up: rank 2 keeps its own slot and amount.
    assert_eq!(season.amounts[..3], [2_500, 1_800, 1_300]);
    assert_eq!(w.check_pay(1, opens), Err(CoreError::RankVoided));
    assert_eq!(w.check_pay(2, opens), Ok(()));

    // Too late once the window has passed; a paid rank cannot be voided.
    assert_eq!(w.void(&season, 0, opens), Err(CoreError::PayoutWindowClosed));
    let mut paid = season.clone();
    paid.pay(2).unwrap();
    assert_eq!(w.void(&paid, 2, end + 70), Err(CoreError::AlreadyPaid));
}

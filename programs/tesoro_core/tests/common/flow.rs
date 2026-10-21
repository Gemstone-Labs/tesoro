//! A Match on tesoro_core as the Game suites drive it: open, join, run the settlement chunks,
//! close. Shared by the four Game test crates (`#[path]` include), so none of them repeats the
//! account lists of the economy-upgrade instructions.
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::types::FailedTransactionMetadata;
use litesvm::LiteSVM;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use tesoro_core::ledger::draw::PotPages;
use tesoro_core::ledger::lifecycle::{Pots, Stage};
use tesoro_core::state::*;
use tesoro_core::storage::*;

pub type Failed = FailedTransactionMetadata;

fn a(p: Pk) -> APk {
    APk::new_from_array(p.to_bytes())
}
fn s(p: APk) -> Pk {
    Pk::new_from_array(p.to_bytes())
}
fn pda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &tesoro_core::ID).0
}

fn ix(
    accounts: impl ToAccountMetas,
    data: impl InstructionData,
    remaining: Vec<AccountMeta>,
) -> Instruction {
    let mut metas: Vec<AccountMeta> = accounts
        .to_account_metas(None)
        .into_iter()
        .map(|m| AccountMeta {
            pubkey: s(m.pubkey),
            is_signer: m.is_signer,
            is_writable: m.is_writable,
        })
        .collect();
    metas.extend(remaining);
    Instruction {
        program_id: s(tesoro_core::ID),
        accounts: metas,
        data: data.data(),
    }
}

fn send(svm: &mut LiteSVM, payer: &Keypair, ixs: &[Instruction]) -> Result<(), Failed> {
    svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        ixs,
        Some(&payer.pubkey()),
        &[payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).map(drop)
}

/// A Match, as the Game suites hold it.
#[derive(Clone, Copy, Debug)]
pub struct MatchRef {
    pub key: APk,
    pub opener: APk,
    pub n: u64,
}

pub fn account_of(authority: APk) -> APk {
    pda(&[ACCOUNT_SEED, authority.as_ref()])
}

pub fn game_record(game: APk) -> APk {
    pda(&[GAME_SEED, game.as_ref()])
}

pub fn program_data(game: APk) -> APk {
    APk::find_program_address(
        &[game.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    )
    .0
}

pub fn load<T: AccountDeserialize>(svm: &LiteSVM, k: APk) -> T {
    let acct = svm.get_account(&s(k)).expect("account exists");
    T::try_deserialize(&mut acct.data.as_slice()).expect("deserialize")
}

pub fn match_state(svm: &LiteSVM, m: &MatchRef) -> MatchState {
    load(svm, m.key)
}

pub fn stage(svm: &LiteSVM, m: &MatchRef) -> Stage {
    match_state(svm, m).inner.stage()
}

/// Playable Gemas in the Account's basket and spill.
pub fn gemas(svm: &LiteSVM, account: APk) -> u64 {
    [basket_address(&account).0, spill_address(&account).0]
        .into_iter()
        .map(|st| {
            let d = svm.get_account(&s(st)).expect("store").data;
            let store = tesoro_core::ledger::line_store::LineStore::new(&d[DISC..]).expect("store");
            store.own_total() + store.won_total()
        })
        .sum()
}

fn spill_free(svm: &LiteSVM, account: APk) -> usize {
    let d = svm
        .get_account(&s(spill_address(&account).0))
        .expect("spill")
        .data;
    let st = tesoro_core::ledger::line_store::LineStore::new(&d[DISC..]).expect("spill");
    st.capacity() - st.len() - st.room_reserved() as usize
}

/// Anyone may grow an Account's spill; the match room (`lines + 2` slots for each side's credits)
/// has to be there before opening or joining.
pub fn ensure_spill(svm: &mut LiteSVM, payer: &Keypair, account: APk, free: usize) {
    let have = spill_free(svm, account);
    if have >= free {
        return;
    }
    let mut need = free - have;
    while need > 0 {
        let n = need.min(MAX_GROW_LINES);
        let grow = ix(
            tesoro_core::accounts::GrowStore {
                payer: a(payer.pubkey()),
                account,
                basket: basket_address(&account).0,
                spill: spill_address(&account).0,
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::GrowStore {
                which: tesoro_core::StoreKind::Spill,
                extra_lines: n as u32,
            },
            vec![],
        );
        send(svm, payer, &[grow]).expect("grow spill");
        need -= n;
    }
}

fn sources_in(svm: &LiteSVM, account: APk) -> Vec<APk> {
    let mut out: Vec<APk> = vec![];
    for store in [basket_address(&account).0, spill_address(&account).0] {
        let d = svm.get_account(&s(store)).expect("store").data;
        let st = tesoro_core::ledger::line_store::LineStore::new(&d[DISC..]).expect("store");
        for l in st.lines() {
            let k = APk::new_from_array(l.source);
            if !out.contains(&k) {
                out.push(k);
            }
        }
    }
    out
}

fn book_metas(svm: &LiteSVM, source: APk) -> Vec<AccountMeta> {
    let mut v = vec![AccountMeta::new(s(book_address(&source).0), false)];
    for class in 0..15u8 {
        for page_no in 0..4u32 {
            let k = ckpt_address(&source, class, page_no).0;
            if svm.get_account(&s(k)).is_some() {
                v.push(AccountMeta::new(s(k), false));
            }
        }
    }
    v
}

fn books_of(svm: &LiteSVM, account: APk) -> Vec<AccountMeta> {
    sources_in(svm, account)
        .into_iter()
        .take(4)
        .flat_map(|src| book_metas(svm, src))
        .collect()
}

fn counters_next(svm: &LiteSVM, account: APk) -> u64 {
    svm.get_account(&s(pda(&[COUNTERS_SEED, account.as_ref()])))
        .map_or(0, |acc| {
            AccountCounters::try_deserialize(&mut acc.data.as_slice())
                .expect("counters")
                .next_match
        })
}

/// Opens a Match for `game` with a direct draw into a fresh Pot at `["ticket", account, pot_nonce]`.
pub fn open_match(
    svm: &mut LiteSVM,
    player: &Keypair,
    game: APk,
    entry: u64,
    pot_nonce: u64,
    challenge: bool,
    asset: u8,
) -> Result<MatchRef, Failed> {
    let authority = a(player.pubkey());
    let account = account_of(authority);
    let n = counters_next(svm, account);
    let key = pda(&[MATCH_SEED, account.as_ref(), &n.to_le_bytes()]);
    ensure_spill(svm, player, account, 24);
    let remaining = books_of(svm, account);
    let open = ix(
        tesoro_core::accounts::OpenMatch {
            payer: authority,
            player_authority: authority,
            config: pda(&[CONFIG_SEED]),
            game_record: game_record(game),
            game_program: game,
            program_data: program_data(game),
            player_account: account,
            counters: pda(&[COUNTERS_SEED, account.as_ref()]),
            protections: pda(&[PROTECTIONS_SEED, account.as_ref()]),
            basket: basket_address(&account).0,
            spill: spill_address(&account).0,
            pot: pda(&[TICKET_SEED, account.as_ref(), &pot_nonce.to_le_bytes()]),
            match_state: key,
            offer: None,
            backer_account: None,
            backer_counters: None,
            backer_protections: None,
            backer_basket: None,
            backer_spill: None,
            system_program: anchor_lang::system_program::ID,
        },
        tesoro_core::instruction::OpenMatch {
            game,
            entry,
            n,
            pot_nonce,
            challenge,
            asset,
            pot_lines: 4,
        },
        remaining,
    );
    send(svm, player, &[open])?;
    Ok(MatchRef {
        key,
        opener: account,
        n,
    })
}

/// Joins `m` with a direct draw into a fresh Pot.
pub fn join_match(
    svm: &mut LiteSVM,
    player: &Keypair,
    m: &MatchRef,
    game: APk,
    pot_nonce: u64,
) -> Result<(), Failed> {
    let authority = a(player.pubkey());
    let account = account_of(authority);
    let state = match_state(svm, m);
    let opener = APk::new_from_array(state.inner.a.player);
    let opener_funder = APk::new_from_array(state.inner.a.funder);
    for who in [account, opener, opener_funder] {
        ensure_spill(svm, player, who, 24);
    }
    let remaining = books_of(svm, account);
    let join = ix(
        tesoro_core::accounts::JoinMatch {
            payer: authority,
            player_authority: authority,
            player_account: account,
            counters: pda(&[COUNTERS_SEED, account.as_ref()]),
            protections: pda(&[PROTECTIONS_SEED, account.as_ref()]),
            basket: basket_address(&account).0,
            spill: spill_address(&account).0,
            pot: pda(&[TICKET_SEED, account.as_ref(), &pot_nonce.to_le_bytes()]),
            match_state: m.key,
            opener_protections: pda(&[PROTECTIONS_SEED, opener.as_ref()]),
            opener_spill: spill_address(&opener).0,
            opener_funder_spill: spill_address(&opener_funder).0,
            pair: pda(&[PAIR_SEED, opener.as_ref(), account.as_ref()]),
            game_record: game_record(game),
            game_program: game,
            program_data: program_data(game),
            offer: None,
            backer_account: None,
            backer_counters: None,
            backer_protections: None,
            backer_basket: None,
            backer_spill: None,
            system_program: anchor_lang::system_program::ID,
        },
        tesoro_core::instruction::JoinMatch {
            pot_nonce,
            pot_lines: 4,
        },
        remaining,
    );
    send(svm, player, &[join])
}

fn owners(svm: &LiteSVM, m: &MatchRef) -> Vec<APk> {
    let r = match_state(svm, m).inner;
    let mut out: Vec<APk> = vec![];
    let mut add = |k: [u8; 32]| {
        let k = APk::new_from_array(k);
        if !out.contains(&k) {
            out.push(k);
        }
    };
    add(r.a.player);
    add(r.a.funder);
    if let Some(b) = r.b {
        add(b.player);
        add(b.funder);
    }
    if let Some(st) = r.terms.studio_owner {
        add(st);
    }
    out
}

fn chunk_ix(svm: &LiteSVM, caller: APk, m: &MatchRef, steps: u8) -> Instruction {
    let st = match_state(svm, m);
    let pots: Pots = [0, 1].map(|side| {
        (st.pots[side] != APk::default()).then(|| {
            let d = svm.get_account(&s(st.pots[side])).expect("pot").data;
            PotPages::open(d[tesoro_core::pots::POT_AT..].to_vec()).expect("pot")
        })
    });
    let mut remaining = vec![];
    for o in owners(svm, m) {
        remaining.push(AccountMeta::new(s(basket_address(&o).0), false));
        remaining.push(AccountMeta::new(s(spill_address(&o).0), false));
    }
    for src in st.inner.sources_ahead(&pots, steps as usize) {
        let src = APk::new_from_array(src);
        remaining.extend(book_metas(svm, src));
        remaining.push(AccountMeta::new_readonly(s(src), false));
        let position = APk::new_from_array(load::<SourceState>(svm, src).inner.position);
        remaining.push(AccountMeta::new(s(position), false));
    }
    ix(
        tesoro_core::accounts::MatchChunk {
            caller,
            match_state: m.key,
            pot_a: st.pots[0],
            pot_b: (st.pots[1] != APk::default()).then_some(st.pots[1]),
            event_authority: pda(&[b"__event_authority"]),
            program: tesoro_core::ID,
        },
        tesoro_core::instruction::MatchChunk { max_steps: steps },
        remaining,
    )
}

/// Runs the chunks of a Settling or Refunding Match until its run is complete.
pub fn run_chunks(svm: &mut LiteSVM, caller: &Keypair, m: &MatchRef) {
    for _ in 0..200 {
        if stage(svm, m) == Stage::Closed {
            return;
        }
        let i = chunk_ix(svm, a(caller.pubkey()), m, 4);
        send(svm, caller, &[i]).expect("chunk");
    }
    panic!("the run never finished");
}

/// Closes a finished Match (rents back, counters down).
pub fn close_match(svm: &mut LiteSVM, caller: &Keypair, m: &MatchRef) -> Result<(), Failed> {
    let st = match_state(svm, m);
    let payer_of = |svm: &LiteSVM, pot: APk| -> APk {
        let d = svm.get_account(&s(pot)).expect("pot").data;
        APk::new_from_array(d[8 + 72..8 + 104].try_into().unwrap())
    };
    let mut remaining = vec![];
    for o in owners(svm, m) {
        remaining.push(AccountMeta::new(s(spill_address(&o).0), false));
    }
    remaining.push(AccountMeta::new(
        s(pda(&[
            COUNTERS_SEED,
            APk::new_from_array(st.inner.a.player).as_ref(),
        ])),
        false,
    ));
    if let Some(b) = st.inner.b {
        remaining.push(AccountMeta::new(
            s(pda(&[
                COUNTERS_SEED,
                APk::new_from_array(b.player).as_ref(),
            ])),
            false,
        ));
    }
    let close = ix(
        tesoro_core::accounts::CloseMatch {
            caller: a(caller.pubkey()),
            match_state: m.key,
            match_payer: st.payer,
            pot_a: st.pots[0],
            pot_a_payer: payer_of(svm, st.pots[0]),
            pot_b: (st.pots[1] != APk::default()).then_some(st.pots[1]),
            pot_b_payer: (st.pots[1] != APk::default()).then(|| payer_of(svm, st.pots[1])),
            sponsor: None,
        },
        tesoro_core::instruction::CloseMatch {},
        remaining,
    );
    send(svm, caller, &[close])
}

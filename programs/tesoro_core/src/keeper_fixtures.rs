//! Account and event bytes the keeper (TypeScript) decodes by hand or through the IDL, produced by
//! the program's own code. `keeper/fixtures/core-layouts.json` holds them; `keeper/src/layouts.test.ts`
//! decodes them. This test fails when the program's bytes change and the file was not regenerated:
//! run it with `UPDATE_KEEPER_FIXTURES=1` and commit the file.

use crate::ledger::line_store::{Line, LineStore, CLASS_GENERAL, CLASS_STUDIO, SIDE_OWN, SIDE_WON};
use crate::ledger::{BudgetLine, PrizeSeason, SeasonWindow, PRIZE_PLACES};
use crate::pots::{write_head_fields, HeadFields, TicketExtra, POT_AT, TICKET_HEAD_LEN};
use crate::state::*;
use crate::storage::*;
use anchor_lang::prelude::*;
use anchor_lang::{AccountSerialize, Discriminator, Event};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn key(n: u8) -> [u8; 32] {
    let mut k = [n; 32];
    k[0] = n.wrapping_mul(3).wrapping_add(1);
    k
}

fn line(side: u8, class: u8, due: i64, source: u8, amount: u64) -> Line {
    let mut l = crate::ledger::book::SourceBook::blank_line(side, due, key(source), class, 0);
    l.amount = amount;
    l
}

fn with_disc(disc: &[u8], body: Vec<u8>) -> Vec<u8> {
    let mut v = disc.to_vec();
    v.extend(body);
    v
}

fn store(account: u8, lines: &[Line], capacity: usize, reserved: u32, drop_first: bool) -> Vec<u8> {
    let mut body = vec![0u8; crate::ledger::line_store::required_len(capacity)];
    let mut s = LineStore::init(&mut body[..], key(account), 254).unwrap();
    for l in lines {
        s.insert(l).unwrap();
    }
    if drop_first {
        s.remove_at(0).unwrap();
    }
    s.set_room_reserved(reserved);
    body
}

#[test]
fn keeper_fixtures_match_the_program() {
    let mut out: Vec<(String, String)> = Vec::new();

    // Basket: three lines, the first one removed (first > 0 or compacted), room reserved.
    let lines = [
        line(SIDE_OWN, CLASS_GENERAL, 100, 1, 11),
        line(SIDE_WON, CLASS_GENERAL, 50, 2, 22),
        line(SIDE_WON, CLASS_STUDIO + 0, 70, 3, 33),
    ];
    let basket = with_disc(BasketHead::DISCRIMINATOR, store(9, &lines, 5, 4, true));
    out.push(("basket".into(), hex(&basket)));
    let spill = with_disc(SpillHead::DISCRIMINATOR, store(8, &lines[..2], 3, 2, false));
    out.push(("spill".into(), hex(&spill)));

    // Ticket: head written by the program's own writer, then a Pot store.
    let mut ticket = vec![0u8; POT_AT + crate::ledger::line_store::required_len(3)];
    ticket[..8].copy_from_slice(crate::pots::TicketHead::DISCRIMINATOR);
    ticket[8] = crate::pots::TICKET_VERSION;
    let fields = HeadFields {
        kind: crate::ledger::draw::TicketKind::Backing,
        state: crate::ledger::draw::TicketState::Cancelling,
        storage_reserved: true,
        account: key(5),
        game: key(6),
        nonce: 77,
        target: 5000,
        expires_at: 1_800_000_000,
        line_cap: 3,
        reserved_left: 12,
    };
    let extra = TicketExtra {
        bump: 250,
        payer: Pubkey::new_from_array(key(7)),
        spill_room: 6,
        sponsored_lamports: 99,
    };
    write_head_fields(&mut ticket[8..8 + TICKET_HEAD_LEN], &fields, &extra);
    {
        let mut s = LineStore::init(&mut ticket[POT_AT..], key(5), 250).unwrap();
        s.insert(&lines[0]).unwrap();
        s.insert(&lines[1]).unwrap();
    }
    out.push(("ticket".into(), hex(&ticket)));

    // Source book: counters for Platform, Studio, Leaderboard and one Extension with 3 closed segments.
    let mut book = vec![0u8; BOOK_AT + crate::ledger::book::encoded_len(1)];
    book[..8].copy_from_slice(SourceBookHead::DISCRIMINATOR);
    book[8] = 251;
    book[9] = SOURCE_BOOK_VERSION;
    book[16..48].copy_from_slice(&key(4));
    for (class, amount) in [(0u8, 1001u64), (1, 2002), (2, 3003)] {
        let mut l = crate::ledger::book::SourceBook::blank_line(SIDE_OWN, 0, key(4), class, 0);
        l.amount = amount;
        assert!(counter_put(&mut book, class, &l));
    }
    let mut b = crate::ledger::book::SourceBook::new();
    b.start_extension().unwrap();
    for c in 0..b.class_count() {
        b.classes[c].ck = 10 + c as u32;
    }
    b.encode(&mut book[BOOK_AT..]).unwrap();
    out.push(("book".into(), hex(&book)));

    // Instant Redeem order.
    let order = InstantOrderState {
        bump: 249,
        nonce: 5,
        account: Pubkey::new_from_array(key(10)),
        owner: Pubkey::new_from_array(key(11)),
        line: {
            let mut raw = [0u8; crate::ledger::LINE_LEN];
            line(SIDE_WON, CLASS_GENERAL, 200, 12, 4444).encode(&mut raw);
            raw
        },
        requested: 4444,
        created_at: 1_790_000_000,
        expires_at: 1_790_086_400,
        sold: 10,
        redeemed_while_open: 0,
        paid_shares: 0,
        payer: Pubkey::new_from_array(key(13)),
        sponsored_lamports: 0,
    };
    let mut raw = Vec::new();
    order.try_serialize(&mut raw).unwrap();
    out.push(("order".into(), hex(&raw)));

    // Season record with two budget lines.
    let mut winners = [[0u8; 32]; PRIZE_PLACES];
    let mut points = [0u64; PRIZE_PLACES];
    for i in 0..3 {
        winners[i] = key(20 + i as u8);
        points[i] = 100 - i as u64;
    }
    let mut cursor = [0u8; PRIZE_PLACES];
    cursor[0] = 1;
    let season = SeasonState {
        bump: 248,
        inner: PrizeSeason {
            number: 4,
            window: SeasonWindow {
                number: 4,
                recorded_at: 1_795_000_000,
                voided_mask: 0b10,
            },
            count: 3,
            winners,
            points,
            lines: vec![
                BudgetLine {
                    side: 0,
                    class: 3,
                    tranche: 0,
                    due_at: 5,
                    source: key(30),
                    amount: 1000,
                    paid: 250,
                },
                BudgetLine {
                    side: 1,
                    class: 3,
                    tranche: 0,
                    due_at: 6,
                    source: key(31),
                    amount: 2000,
                    paid: 0,
                },
            ],
            cursor,
            closed: false,
        },
    };
    let mut raw = Vec::new();
    season.try_serialize(&mut raw).unwrap();
    out.push(("season".into(), hex(&raw)));

    // Event-CPI payloads (the data after the 8-byte event tag).
    let started = MatchRunStarted {
        opener: Pubkey::new_from_array(key(40)),
        n: 12,
        game: Pubkey::new_from_array(key(41)),
        kind: 0,
        winner: 1,
        entry: 500,
        fees: [10, 15, 5],
        a_player: Pubkey::new_from_array(key(42)),
        a_funder: Pubkey::new_from_array(key(43)),
        b_player: Pubkey::new_from_array(key(44)),
        b_funder: Pubkey::new_from_array(key(45)),
        challenge: true,
        asset: 1,
        opened_at: 1_790_000_000,
        ts: 1_790_000_900,
        a_share_bps: 2500,
        b_share_bps: 0,
    };
    out.push(("matchRunStarted".into(), hex(&started.data())));
    let won = MatchWon {
        opener: Pubkey::new_from_array(key(40)),
        n: 12,
        game: Pubkey::new_from_array(key(41)),
        entry: 500,
        player: Pubkey::new_from_array(key(44)),
        funder: Pubkey::new_from_array(key(45)),
        points: 5,
        pool_fee: 5,
        season: 4,
        ts: 1_790_000_900,
        loser: Pubkey::new_from_array(key(42)),
        challenge: true,
        asset: 1,
        opened_at: 1_790_000_000,
    };
    out.push(("matchWon".into(), hex(&won.data())));

    let json = format!(
        "{{\n{}\n}}\n",
        out.iter()
            .map(|(k, v)| format!("  \"{k}\": \"{v}\""))
            .collect::<Vec<_>>()
            .join(",\n")
    );
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../keeper/fixtures/core-layouts.json"
    );
    if std::env::var("UPDATE_KEEPER_FIXTURES").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        std::fs::write(path, &json).unwrap();
    }
    let on_disk = std::fs::read_to_string(path).unwrap_or_default();
    assert_eq!(
        on_disk, json,
        "keeper/fixtures/core-layouts.json is stale: run with UPDATE_KEEPER_FIXTURES=1"
    );
}

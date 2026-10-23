//! Account bytes the app and the keeper (TypeScript) decode through the program's IDL, produced by the
//! program's own serializer. `keeper/fixtures/trading-duel-layouts.json` holds them; `keeper/src/layouts.test.ts`
//! and `app/src/games/trading-duel/layouts.test.ts` decode them. This test fails when the program's bytes change
//! and the file was not regenerated: run it with `UPDATE_KEEPER_FIXTURES=1` and commit the file.

use crate::state::*;
use anchor_lang::prelude::*;
use anchor_lang::AccountSerialize;
use table_kit::{Slot, OUTCOME_WIN1, SLOT_DONE, SLOT_RESERVED};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn key(n: u8) -> Pubkey {
    let mut k = [n; 32];
    k[0] = n.wrapping_mul(3).wrapping_add(1);
    Pubkey::new_from_array(k)
}

fn bytes<T: AccountSerialize>(a: &T) -> String {
    let mut v = Vec::new();
    a.try_serialize(&mut v).unwrap();
    hex(&v)
}

#[test]
fn trading_duel_fixtures_match_the_program() {
    // A live table in epoch 7: a Done result (seat 1 won) and a Reserved slot in the ring, picks revealed, a partly filled line.
    let mut table = Table::new(254, 1, 3);
    table.epoch = 7;
    table.phase = PHASE_LIVE;
    table.seats_open = true;
    table.dirty = true;
    table.tesoro_match = key(2);
    table.slot = 3;
    table.players = [key(3), key(4)];
    table.asset = ASSET_ETH;
    table.start_deadline = 1_300;
    table.checked_in = [true, true];
    table.starts_at = 1_000;
    table.grid_at = 1_030;
    table.ends_at = 1_150;
    table.over_at = 1_151;
    table.anchor = 300_000_000_000;
    table.step = 60_000_000;
    table.last_tick = 1_001;
    for c in 0..COLUMNS {
        table.track.lo[c] = c as u64 + 1;
        table.track.hi[c] = c as u64 + 10;
    }
    table.track.seen = 0b101;
    table.track.last = 305_000_000_000;
    table.track.last_col = 2;
    table.revealed[0][0] = 3;
    table.revealed[1][0] = -5;
    table.revealed[1][4] = 7;
    table.scores = [100, 200];
    table.winner = 1;
    table.ring.slots[1] = Slot {
        state: SLOT_DONE,
        match_key: key(9),
        epoch: 6,
        outcome: OUTCOME_WIN1,
        at: 1_200,
    };
    table.ring.slots[3] = Slot {
        state: SLOT_RESERVED,
        match_key: key(2),
        epoch: 7,
        outcome: 0,
        at: 0,
    };
    let idle = Table::new(253, 0, 0);

    let assignment = Assignment {
        bump: 252,
        tesoro_match: key(2),
        generation: 1,
        index: 3,
        epoch: 7,
        players: [key(3), key(4)],
        asset: ASSET_ETH,
        start_deadline: 1_300,
        payer: key(8),
    };

    let mut book = Book::new(251, key(1), key(4), 1);
    book.picks[2] = 6;
    book.picks[11] = -3;
    book.pick_count = 2;

    let config = TableConfig {
        bump: 250,
        operator: key(5),
        generation: 1,
        max_tables: 4,
    };

    let out = [
        ("table", bytes(&table)),
        ("idle_table", bytes(&idle)),
        ("assignment", bytes(&assignment)),
        ("book", bytes(&book)),
        ("table_config", bytes(&config)),
    ];
    let json = format!(
        "{{\n{}\n}}\n",
        out.iter()
            .map(|(k, v)| format!("  \"{k}\": \"{v}\""))
            .collect::<Vec<_>>()
            .join(",\n")
    );
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../keeper/fixtures/trading-duel-layouts.json"
    );
    if std::env::var("UPDATE_KEEPER_FIXTURES").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        std::fs::write(path, &json).unwrap();
    }
    let on_disk = std::fs::read_to_string(path).unwrap_or_default();
    assert_eq!(
        on_disk, json,
        "keeper/fixtures/trading-duel-layouts.json is stale: run with UPDATE_KEEPER_FIXTURES=1"
    );
}

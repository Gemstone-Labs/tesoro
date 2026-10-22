//! Account bytes the app (TypeScript) decodes through the program's IDL, produced by the program's own serializer.
//! `keeper/fixtures/block-puzzle-layouts.json` holds them; `app/src/games/block-puzzle/layouts.test.ts` and
//! `keeper/src/layouts.test.ts` decode them. This test fails when the program's bytes change and the file was not
//! regenerated: run it with `UPDATE_KEEPER_FIXTURES=1` and commit the file.

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
fn block_puzzle_fixtures_match_the_program() {
    // A running table in epoch 7 with a Done result and a Reserved slot in the ring.
    let mut table = Table::new(254, 1, 3);
    table.epoch = 7;
    table.phase = TABLE_GET_READY;
    table.seats_created = true;
    table.seats_open = true;
    table.tesoro_match = key(2);
    table.slot = 3;
    table.start_deadline = 1_300;
    table.players = [key(3), key(4)];
    table.checked_in = [true, true];
    table.assigned_slot = 50_000;
    table.assigned_ts = 1_000;
    table.seeding_slot = 50_400;
    table.vrf_nonce = 12;
    table.req_nonce = 11;
    table.req_epoch = 7;
    table.req_slot = 50_410;
    table.req_count = 1;
    table.seed_ready = true;
    table.ready_slot = 50_900;
    table.ready_ts = 1_009;
    table.start_slot = 51_900;
    table.shown_score = [37, 12];
    table.shown_moves = [14, 6];
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
    let done = &mut table.logs[1];
    done.engine_version = ENGINE_VERSION;
    done.seed = 0x1122_3344_5566_7788;
    done.seed_hash = [7; 32];
    done.start_slot = 40_000;
    done.reason = REASON_PLAYED;
    done.scores = [18, 77];
    done.counts = [3, 4];
    done.moves[0] = 0b01_010_011;
    done.moves[120] = 0b10_111_000;
    done.offsets[0] = 0x2c;
    done.offsets[1] = 0x01;
    done.offsets[240] = 0x90;
    done.offsets[241] = 0x1f;

    let idle = Table::new(253, 0, 0);
    let mut closed = Table::new(252, 2, 1);
    closed.phase = TABLE_CLOSED;
    closed.dirty = true;
    closed.reason = REASON_ABSENT;
    closed.outcome = table_kit::OUTCOME_WIN0;
    closed.final_scores = [0, 0];

    let assignment = Assignment {
        bump: 252,
        tesoro_match: key(2),
        generation: 1,
        index: 3,
        epoch: 7,
        players: [key(3), key(4)],
        start_deadline: 1_300,
        payer: key(8),
    };

    let mut board = Board::blank(251, key(1), 1);
    board.player = key(4);
    board.tesoro_match = key(2);
    board.epoch = 7;
    board.began = true;
    board.seed = 0x1122_3344_5566_7788;
    board.occ = 0x0000_00ff_00ff_0000;
    board.score = 77;
    board.moves = 4;
    board.used = 1;
    board.last_slot = 52_000;
    board.last_ts = 1_011;
    board.log[0] = 0b10_111_000;
    board.offsets[0] = 0x90;
    board.offsets[1] = 0x1f;
    let mut vault = Vault::blank(250, key(1));
    vault.ready = true;
    vault.seed = 0x1122_3344_5566_7788;

    let config = TableConfig {
        bump: 249,
        operator: key(5),
        generation: 1,
        max_tables: 4,
    };

    let out = [
        ("table", bytes(&table)),
        ("idle_table", bytes(&idle)),
        ("closed_table", bytes(&closed)),
        ("assignment", bytes(&assignment)),
        ("board", bytes(&board)),
        ("vault", bytes(&vault)),
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
        "/../../keeper/fixtures/block-puzzle-layouts.json"
    );
    if std::env::var("UPDATE_KEEPER_FIXTURES").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        std::fs::write(path, &json).unwrap();
    }
    let on_disk = std::fs::read_to_string(path).unwrap_or_default();
    assert_eq!(
        on_disk, json,
        "keeper/fixtures/block-puzzle-layouts.json is stale: run with UPDATE_KEEPER_FIXTURES=1"
    );
}

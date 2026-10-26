//! Account bytes the app (TypeScript) decodes through the program's IDL, produced by the program's own serializer.
//! `keeper/fixtures/holdem-layouts.json` holds them; `app/src/games/holdem/layouts.test.ts` decodes them. This test fails
//! when the program's bytes change and the file was not regenerated: run it with `UPDATE_KEEPER_FIXTURES=1` and commit
//! the file.

use crate::state::*;
use anchor_lang::prelude::*;
use anchor_lang::AccountSerialize;
use table_kit::{Slot, OUTCOME_WIN1, SLOT_DONE, SLOT_RESERVED};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The retire-only record lengths as little-endian u16 pairs, so the keeper plans the retire from the program's constant.
fn legacy_lengths(lengths: &[usize]) -> String {
    hex(&lengths
        .iter()
        .flat_map(|l| (*l as u16).to_le_bytes())
        .collect::<Vec<u8>>())
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
fn holdem_fixtures_match_the_program() {
    // A live table in epoch 7, hand 3 past the flop, a request answered, a Done result and a Reserved slot in the ring.
    let mut table = Table::new(254, 1, 3);
    table.epoch = 7;
    table.phase = TABLE_LIVE;
    table.seats_created = true;
    table.seats_open = true;
    table.dirty = true;
    table.tesoro_match = key(2);
    table.slot = 3;
    table.start_deadline = 1_300;
    table.checked_in = [true, true];
    table.over_at = 1_151;
    table.vrf_nonce = 12;
    table.req_nonce = 11;
    table.req_pending = false;
    table.req_epoch = 7;
    table.req_hand = 3;
    table.req_at = 1_100;
    table.vrf_ready = true;
    table.game = GameMatch {
        players: [key(3), key(4)],
        speed: SPEED_TURBO,
        status: STATUS_LIVE,
        winner: NO_WINNER,
        no_show: false,
        hand_no: 3,
        dealer: 0,
        phase: PHASE_FLOP,
        small_blind: 100,
        big_blind: 200,
        stacks: [1_300, 1_500],
        bets: [0, 200],
        committed: [100, 400],
        to_act: 1,
        acted: [true, false],
        last_raise: 200,
        board: [11, 18, 33, NO_CARD, NO_CARD],
        deadline: 2_000,
        extensions: 1,
        missed: [0, 1],
        last_hand_no: 2,
        last_result: SPLIT,
        last_pot: 1_000,
        last_showdown: true,
        last_shown: [[51, 49], [12, 25]],
        last_board: [1, 2, 3, 4, 5],
    };
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
        speed: SPEED_TURBO,
        start_deadline: 1_300,
        payer: key(8),
    };

    let mut hole = Hole::blank(251, key(1), 1);
    hole.player = key(4);
    hole.hand_no = 3;
    hole.dealt = true;
    hole.cards = [51, 49];
    hole.shares = [1, 2, 3, 4, 5];
    hole.contributed = true;

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
        ("hole", bytes(&hole)),
        ("table_config", bytes(&config)),
        ("legacy_lengths_u16le", legacy_lengths(&LEGACY_HOLE_LENGTHS)),
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
        "/../../keeper/fixtures/holdem-layouts.json"
    );
    if std::env::var("UPDATE_KEEPER_FIXTURES").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        std::fs::write(path, &json).unwrap();
    }
    let on_disk = std::fs::read_to_string(path).unwrap_or_default();
    assert_eq!(
        on_disk, json,
        "keeper/fixtures/holdem-layouts.json is stale: run with UPDATE_KEEPER_FIXTURES=1"
    );
}

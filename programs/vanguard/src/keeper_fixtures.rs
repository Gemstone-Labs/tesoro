//! Account bytes the app (TypeScript) decodes through the program's IDL, produced by the program's own serializer.
//! `keeper/fixtures/vanguard-layouts.json` holds them; `app/src/games/vanguard/layouts.test.ts` decodes them. This test
//! fails when the program's bytes change and the file was not regenerated: run it with `UPDATE_KEEPER_FIXTURES=1` and
//! commit the file. (The Battle is zero-copy and has its own golden test, `tests/golden.rs`.)

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
fn vanguard_fixtures_match_the_program() {
    // A live table in epoch 7 whose Match asked for its randomness, a Done result and a Reserved slot in the ring.
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
    table.req_made = true;
    table.req_epoch = 7;
    table.req_at = 1_100;
    table.vrf_ready = true;
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
        start_deadline: 1_300,
        payer: key(8),
    };

    // A seat that has contributed and is waiting for the oracle: the secret is in, nothing is dealt.
    let mut waiting = Army::blank(251, key(1), 1);
    waiting.player = key(4);
    waiting.contributed = true;
    waiting.secret = [0x5a; 32];

    // A dealt seat: ranks, key and its storm share, secrets spent.
    let mut dealt = Army::blank(250, key(1), 0);
    dealt.player = key(3);
    dealt.side = 0;
    dealt.ranks[0] = 7;
    dealt.reserved = [0xA0; 32];
    dealt.dealt = true;
    dealt.storm_at = 0x0A0B;
    dealt.storm_seed = 0x0C0D_0E0F;

    let config = TableConfig {
        bump: 249,
        operator: key(5),
        generation: 1,
        max_tables: 4,
    };

    let out = [
        ("table", bytes(&table)),
        ("idle_table", bytes(&idle)),
        ("assignment", bytes(&assignment)),
        ("army_waiting", bytes(&waiting)),
        ("army_dealt", bytes(&dealt)),
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
        "/../../keeper/fixtures/vanguard-layouts.json"
    );
    if std::env::var("UPDATE_KEEPER_FIXTURES").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        std::fs::write(path, &json).unwrap();
    }
    let on_disk = std::fs::read_to_string(path).unwrap_or_default();
    assert_eq!(
        on_disk, json,
        "keeper/fixtures/vanguard-layouts.json is stale: run with UPDATE_KEEPER_FIXTURES=1"
    );
}

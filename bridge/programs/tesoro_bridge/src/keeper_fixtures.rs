//! Bridge account bytes the keeper (`keeper/src/bridge-ix.ts`) decodes by hand, written by the
//! program's own serializer. `keeper/fixtures/bridge-layouts.json` holds them; `keeper/src/layouts.test.ts`
//! decodes them. Regenerate with `UPDATE_KEEPER_FIXTURES=1 cargo test keeper_fixtures`.

use crate::msg_codec::MAX_BATCH_ENTRIES;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_lang::AccountSerialize;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn key(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}

fn bytes<T: AccountSerialize>(a: &T) -> String {
    let mut v = Vec::new();
    a.try_serialize(&mut v).unwrap();
    hex(&v)
}

#[test]
fn keeper_fixtures_match_the_program() {
    let route = VaultRoute {
        eid: 40_449,
        peer_address: [3; 32],
        bump: 255,
        asset: [4; 32],
        escrow_enabled: true,
        min_batch_units: 1_000,
        last_batch_id: 7,
        last_payout_id: 9,
        escrow_shares: 11,
        escrow_units: 12,
        issued_shares: 13,
        issued_units: 14,
        last_funded_season: 15,
        pending_payout_shares: 16,
        paid_payout_shares: 17,
    };
    let mut entries = [BatchEntry::default(); MAX_BATCH_ENTRIES];
    entries[0] = BatchEntry { vault_position_id: 1, source: key(8), units: 50, paid: 20 };
    entries[1] = BatchEntry { vault_position_id: 2, source: key(9), units: 70, paid: 0 };
    let batch = Batch {
        eid: 40_449,
        peer_address: [3; 32],
        id: 21,
        bump: 254,
        rent_payer: key(5),
        kind: 1,
        state: BATCH_SEALED,
        recipient: [6; 20],
        count: 2,
        entries,
        total_units: 120,
        paid_units: 20,
        sends: 3,
    };
    let payout = PayoutRecord {
        eid: 40_449,
        peer_address: [3; 32],
        id: 22,
        bump: 253,
        rent_payer: key(5),
        state: PAYOUT_PENDING,
        holder_account: key(10),
        recipient: [11; 20],
        prize_source: key(12),
        asset: [4; 32],
        gemas: 345,
        shares: 6789,
        sends: 2,
    };
    let claim = Claim {
        holder_account: key(13),
        source: key(14),
        position: key(15),
        gemas_total: 100,
        units_total: 200,
        units_sent: 50,
        bump: 252,
    };
    let instant = InstantClaim {
        holder_account: key(16),
        source: key(17),
        position: key(18),
        gemas_total: 101,
        units_total: 201,
        units_sent: 51,
        bump: 251,
    };
    let out = [
        ("route", bytes(&route)),
        ("batch", bytes(&batch)),
        ("payout", bytes(&payout)),
        ("claim", bytes(&claim)),
        ("instantClaim", bytes(&instant)),
    ];
    let json = format!(
        "{{\n{}\n}}\n",
        out.iter().map(|(k, v)| format!("  \"{k}\": \"{v}\"")).collect::<Vec<_>>().join(",\n")
    );
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../keeper/fixtures/bridge-layouts.json");
    if std::env::var("UPDATE_KEEPER_FIXTURES").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        std::fs::write(path, &json).unwrap();
    }
    let on_disk = std::fs::read_to_string(path).unwrap_or_default();
    assert_eq!(on_disk, json, "keeper/fixtures/bridge-layouts.json is stale: run with UPDATE_KEEPER_FIXTURES=1");
}

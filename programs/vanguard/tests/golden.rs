//! Golden account bytes for the app's decoders.
//!
//! The app reads the Battle and the Army at fixed byte offsets. This test writes, from the real Rust layout:
//! - `chain-layout.json`: the offsets table the app's decoders are driven by;
//! - `fixtures/golden.json`: account bytes (hex) of a probe Battle and a probe Army plus the encoded event
//!   records, each with the values they hold, so the app checks its decoders against bytes the program wrote.
//!
//! `WRITE_GOLDEN=1 cargo test -p vanguard --test golden` rewrites both. Without it the test fails when a file is
//! stale, so a layout change cannot reach the app unnoticed.

#![recursion_limit = "512"]

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountSerialize, Discriminator};
use serde_json::{json, Map, Value};
use std::mem::offset_of;
use std::path::PathBuf;
use vanguard::engine::{
    Army as Side, EndReason, Event, Outcome, Record, Shift, Winner, MAX_SHIFTS, NO_PIECE,
    PIECE_SLOTS,
};
use vanguard::{Army, Battle, RingRecord, Secret, NO_SQ, RECORD_DATA, RING, STATUS_LIVE};

fn app_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../app/src/games/vanguard")
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn pk(seed: u8) -> Pubkey {
    Pubkey::new_from_array([seed; 32])
}

macro_rules! offsets {
    ($t:ty; $($field:ident => $name:literal),+ $(,)?) => {{
        let mut m = Map::new();
        $(m.insert($name.to_string(), json!(8 + offset_of!($t, $field)));)+
        Value::Object(m)
    }};
}

fn layout() -> Value {
    let battle = offsets!(Battle;
        match_id => "matchId", moved => "moved", start_deadline => "startDeadline",
        entropy_deadline => "entropyDeadline", deadline => "deadline", started_at => "startedAt",
        event_seq => "eventSeq", turn_no => "turnNo", moves => "moves", ring => "ring",
        tesoro_match => "tesoroMatch", players => "players", sq => "sq", shown => "shown",
        trail => "trail", trail_len => "trailLen", bump => "bump", authority_bump => "authorityBump",
        us_seat => "usSeat", status => "status", finalized => "finalized", permissioned => "permissioned",
        winner => "winner", reason => "reason", turn => "turn", steps_left => "stepsLeft",
        two_step_active => "twoStepActive", storm_done => "stormDone", two_step => "twoStep",
        timeouts => "timeouts", depot_claimed => "depotClaimed",
        layout_version => "layoutVersion", rules_version => "rulesVersion",
        setup_deadline => "setupDeadline", cap_deadline => "capDeadline", payer => "payer",
        oracle_queue => "oracleQueue", move_cap => "moveCap", cap_secs => "capSecs",
        turn_secs => "turnSecs", grace_secs => "graceSecs", opening_grace_secs => "openingGraceSecs", resolve_slack_secs => "resolveSlackSecs",
        storm_from => "stormFrom", storm_to => "stormTo", pending_kind => "pendingKind",
        pending_piece => "pendingPiece", pending_to => "pendingTo", pending_seat => "pendingSeat",
        action_seq => "actionSeq", pending_slot => "pendingSlot", pending_time => "pendingTime",
        deal_slot => "dealSlot", pad_a => "padA", reserved => "reserved",
    );
    // The Army is Borsh, so its fields follow each other with no padding: offset = 8 + the sizes before it.
    let fields: [(&str, usize); 8] = [
        ("bump", 1),
        ("battle", 32),
        ("seat", 1),
        ("player", 32),
        ("side", 1),
        ("ranks", 30),
        ("fuel", 1),
        ("truckTurn", 4),
    ];
    let mut army = Map::new();
    let mut at = 8usize;
    for (name, len) in fields {
        army.insert(name.to_string(), json!(at));
        at += len;
    }
    army.insert("moves".to_string(), json!(at));
    // the sealing key: the 32 reserved bytes right after the u16 move count
    army.insert("reserved".to_string(), json!(at + 2));
    json!({
        "battle": {
            "size": 8 + std::mem::size_of::<Battle>(),
            "offsets": battle,
            "pieceSlots": PIECE_SLOTS,
            "trailWidth": 6,
            "ring": { "slots": RING, "stride": std::mem::size_of::<RingRecord>(),
                      "seq": offset_of!(RingRecord, seq), "kind": offset_of!(RingRecord, kind),
                      "data": offset_of!(RingRecord, data), "dataLen": RECORD_DATA },
            "noSquare": NO_SQ,
        },
        "army": { "size": 8 + <Army as anchor_lang::Space>::INIT_SPACE, "offsets": Value::Object(army) },
    })
}

fn square(s: u8) -> Value {
    json!({ "r": s / 10, "c": s % 10 })
}

fn army_name(a: Side) -> &'static str {
    a.name()
}

/// The event as the app's `GameEventBody` shape, written from the engine value (not from the bytes).
fn expected_event(e: &Event) -> Value {
    match *e {
        Event::Move { id, from, to } => {
            json!({ "kind": "move", "id": id, "from": square(from), "to": square(to) })
        }
        Event::Attack {
            att,
            def,
            from,
            to,
            outcome,
            flash,
        } => {
            let name = match outcome {
                Outcome::Win => "win",
                Outcome::Lose => "lose",
                Outcome::Tie => "tie",
                Outcome::Mine => "mine",
                Outcome::Defuse => "defuse",
                Outcome::Truck => "truck",
            };
            let flash: Vec<u8> = flash.iter().copied().filter(|f| *f != NO_PIECE).collect();
            json!({ "kind": "attack", "att": att, "def": def, "from": square(from), "to": square(to),
                    "outcome": name, "flash": flash })
        }
        Event::Spotted { id } => json!({ "kind": "spotted", "id": id }),
        Event::Raid { army, at } => {
            json!({ "kind": "raid", "army": army_name(army), "at": square(at) })
        }
        Event::Storm {
            col,
            index,
            dir,
            n,
            shifts,
        } => {
            let shifts: Vec<Value> = shifts
                .iter()
                .take(n as usize)
                .map(|s| json!({ "id": s.id, "from": square(s.from), "to": square(s.to) }))
                .collect();
            json!({ "kind": "storm", "axis": if col { "col" } else { "row" }, "index": index, "dir": dir, "shifts": shifts })
        }
        // The powers' events (rules version 6).
        Event::Blast { id, at, n, shown } => {
            let rank = |r: u8| match r {
                11 => "B".to_string(),
                12 => "F".to_string(),
                n => n.to_string(),
            };
            let shown: Vec<Value> = shown
                .iter()
                .take(n as usize)
                .map(|(id, r)| json!({ "id": id, "rank": rank(*r) }))
                .collect();
            json!({ "kind": "blast", "id": id, "at": square(at), "shown": shown })
        }
        Event::Rescue {
            colonel,
            truck,
            from,
            to,
        } => {
            json!({ "kind": "rescue", "colonel": colonel, "truck": truck, "from": square(from), "to": square(to) })
        }
        Event::DugIn { army, id } => {
            json!({ "kind": "dug_in", "army": army_name(army), "id": id })
        }
        Event::Pass { army } => json!({ "kind": "pass", "army": army_name(army) }),
        Event::Switched { id } => json!({ "kind": "switched", "id": id }),
        Event::Turn { turn, timed_out } => {
            json!({ "kind": "turn", "turn": army_name(turn), "timedOut": timed_out })
        }
        Event::End { winner, reason } => {
            let w = match winner {
                Winner::Draw => "draw",
                Winner::Army(a) => army_name(a),
            };
            let r = match reason {
                EndReason::Truck => "truck",
                EndReason::Stuck => "stuck",
                EndReason::Timeouts => "timeouts",
                EndReason::Cap => "cap",
            };
            json!({ "kind": "end", "winner": w, "reason": r })
        }
    }
}

fn events() -> Vec<Value> {
    let mut shifts = [Shift::default(); MAX_SHIFTS];
    shifts[0] = Shift {
        id: 41,
        from: 54,
        to: 64,
    };
    shifts[1] = Shift {
        id: 7,
        from: 24,
        to: 34,
    };
    shifts[2] = Shift {
        id: 59,
        from: 94,
        to: 95,
    };
    let list = [
        Event::Move {
            id: 33,
            from: 73,
            to: 63,
        },
        Event::Attack {
            att: 41,
            def: 12,
            from: 53,
            to: 43,
            outcome: Outcome::Win,
            flash: [12, NO_PIECE],
        },
        Event::Attack {
            att: 47,
            def: 5,
            from: 54,
            to: 44,
            outcome: Outcome::Tie,
            flash: [47, 5],
        },
        Event::Attack {
            att: 36,
            def: 9,
            from: 61,
            to: 51,
            outcome: Outcome::Mine,
            flash: [9, 36],
        },
        Event::Spotted { id: 52 },
        Event::Raid {
            army: Side::It,
            at: 85,
        },
        Event::Storm {
            col: true,
            index: 4,
            dir: -1,
            n: 3,
            shifts,
        },
        Event::Blast {
            id: 33,
            at: 73,
            n: 3,
            shown: [
                (5, 9),
                (41, 11),
                (12, 2),
                (0, 0),
                (0, 0),
                (0, 0),
                (0, 0),
                (0, 0),
            ],
        },
        Event::Blast {
            id: 14,
            at: 5,
            n: 0,
            shown: [(0, 0); 8],
        },
        Event::Rescue {
            colonel: 38,
            truck: 44,
            from: 96,
            to: 72,
        },
        Event::DugIn {
            army: Side::It,
            id: 17,
        },
        Event::Pass { army: Side::Us },
        Event::Switched { id: 55 },
        Event::Turn {
            turn: Side::It,
            timed_out: true,
        },
        Event::End {
            winner: Winner::Army(Side::Us),
            reason: EndReason::Truck,
        },
        Event::End {
            winner: Winner::Draw,
            reason: EndReason::Cap,
        },
    ];
    list.iter()
        .enumerate()
        .map(|(i, e)| {
            let seq = 1000 + i as u32;
            let rec = RingRecord::encode(&Record { seq, event: *e });
            let bytes = anchor_lang::__private::bytemuck::bytes_of(&rec);
            json!({ "bytes": hex(bytes), "seq": seq, "event": expected_event(e) })
        })
        .collect()
}

fn probe_battle() -> Battle {
    let mut b: Battle = anchor_lang::__private::bytemuck::Zeroable::zeroed();
    b.match_id = 0x0102_0304_0506_0708;
    b.moved = 0b1010_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0100;
    b.start_deadline = 1_760_000_100;
    b.entropy_deadline = 1_760_000_160;
    b.deadline = 1_760_000_999;
    b.started_at = 1_760_000_200;
    b.event_seq = 21;
    b.turn_no = 17;
    b.moves = 33;
    for seq in 5u32..=20 {
        let e = Event::Move {
            id: (seq % 60) as u8,
            from: (seq % 100) as u8,
            to: ((seq + 10) % 100) as u8,
        };
        b.ring[(seq as usize) % RING] = RingRecord::encode(&Record { seq, event: e });
    }
    b.tesoro_match = pk(0xa1);
    b.players = [pk(0xb2), pk(0xc3)];
    b.sq = [NO_SQ; PIECE_SLOTS];
    for i in 0..PIECE_SLOTS {
        b.sq[i] = if i % 7 == 3 {
            NO_SQ
        } else {
            ((i * 13) % 100) as u8
        };
        b.shown[i] = if i % 5 == 0 { (i % 12 + 1) as u8 } else { 0 };
        b.trail_len[i] = (i % 7) as u8;
        for k in 0..6 {
            b.trail[i][k] = ((i + k * 11) % 100) as u8;
        }
    }
    b.bump = 254;
    b.authority_bump = 253;
    b.us_seat = 1;
    b.status = STATUS_LIVE;
    b.finalized = 0;
    b.permissioned = 1;
    b.winner = 255;
    b.reason = 255;
    b.turn = 1;
    b.steps_left = 2;
    b.two_step_active = 1;
    b.storm_done = 1;
    b.two_step = [1, 2];
    b.timeouts = [0, 2];
    b.depot_claimed = [1, 0];
    b.layout_version = 2;
    b.rules_version = 4;
    b.setup_deadline = 1_760_000_480;
    b.cap_deadline = 1_760_001_100;
    b.payer = pk(0xd4);
    b.oracle_queue = pk(0xe5);
    b.move_cap = 200;
    b.cap_secs = 900;
    b.turn_secs = 5;
    b.grace_secs = 1;
    b.opening_grace_secs = 10;
    b.resolve_slack_secs = 2;
    b.storm_from = 10;
    b.storm_to = 18;
    b.pending_kind = 1;
    b.pending_piece = 41;
    b.pending_to = 53;
    b.pending_seat = 1;
    b.pad_a[0] = 0x5C;
    // the end mask: pieces 0, 5, 31 and 55 changed rank
    b.reserved[..8].copy_from_slice(&((1u64 << 55) | (1 << 31) | (1 << 5) | 1).to_le_bytes());
    b.action_seq = 77;
    b.pending_slot = 0x0102_0304_0506;
    b.pending_time = 1_760_000_222;
    b.deal_slot = 0x0A0B_0C0D;
    b
}

fn battle_golden() -> Value {
    let b = probe_battle();
    let mut bytes = <Battle as Discriminator>::DISCRIMINATOR.to_vec();
    bytes.extend_from_slice(anchor_lang::__private::bytemuck::bytes_of(&b));
    let ring: Vec<Value> = (0..RING)
        .map(|i| json!({ "seq": b.ring[i].seq, "kind": b.ring[i].kind, "data": hex(&b.ring[i].data) }))
        .collect();
    let trail: Vec<String> = b.trail.iter().map(|t| hex(t)).collect();
    json!({
        "bytes": hex(&bytes),
        "expected": {
            "matchId": b.match_id.to_string(),
            "moved": b.moved.to_string(),
            "startDeadline": b.start_deadline,
            "entropyDeadline": b.entropy_deadline,
            "deadline": b.deadline,
            "startedAt": b.started_at,
            "eventSeq": b.event_seq,
            "turnNo": b.turn_no,
            "moves": b.moves,
            "ring": ring,
            "tesoroMatch": hex(b.tesoro_match.as_ref()),
            "players": [hex(b.players[0].as_ref()), hex(b.players[1].as_ref())],
            "sq": hex(&b.sq),
            "shown": hex(&b.shown),
            "trail": trail,
            "trailLen": hex(&b.trail_len),
            "bump": b.bump,
            "authorityBump": b.authority_bump,
            "usSeat": b.us_seat,
            "status": b.status,
            "finalized": b.finalized,
            "permissioned": b.permissioned,
            "winner": b.winner,
            "reason": b.reason,
            "turn": b.turn,
            "stepsLeft": b.steps_left,
            "twoStepActive": b.two_step_active,
            "stormDone": b.storm_done,
            "twoStep": b.two_step,
            "timeouts": b.timeouts,
            "depotClaimed": b.depot_claimed,
            "layoutVersion": b.layout_version,
            "rulesVersion": b.rules_version,
            "setupDeadline": b.setup_deadline,
            "capDeadline": b.cap_deadline,
            "payer": hex(b.payer.as_ref()),
            "oracleQueue": hex(b.oracle_queue.as_ref()),
            "moveCap": b.move_cap,
            "capSecs": b.cap_secs,
            "turnSecs": b.turn_secs,
            "graceSecs": b.grace_secs,
            "openingGraceSecs": b.opening_grace_secs,
            "resolveSlackSecs": b.resolve_slack_secs,
            "stormFrom": b.storm_from,
            "stormTo": b.storm_to,
            "pendingKind": b.pending_kind,
            "pendingPiece": b.pending_piece,
            "pendingTo": b.pending_to,
            "pendingSeat": b.pending_seat,
            "actionSeq": b.action_seq,
            "pendingSlot": b.pending_slot.to_string(),
            "pendingTime": b.pending_time,
            "dealSlot": b.deal_slot.to_string(),
            "padA": hex(&b.pad_a),
            "reserved": hex(&b.reserved),
            "endMask": u64::from_le_bytes(b.reserved[..8].try_into().expect("8 bytes")).to_string(),
        }
    })
}

/// A Battle with a pending Blast (4), Rescue (5) or pass (6) as `record_pending` leaves it: for a pass the sealed Dig in
/// slot byte sits in `pending_piece`, and each kind carries a sealed switch byte in `pad_a[0]`.
fn pending_golden() -> Vec<Value> {
    [
        (vanguard::PENDING_BLAST, 33u8, 0u8, 0xE1u8),
        (vanguard::PENDING_RESCUE, 38, 0, 0x07),
        (vanguard::PENDING_PASS, 0xD9, 0, 0xFE),
    ]
    .iter()
    .map(|(kind, piece, to, sealed)| {
        let mut b = probe_battle();
        b.record_pending(
            *kind,
            vanguard::Intent {
                piece: *piece,
                to: *to,
                sealed_switch: *sealed,
            },
            1,
            0x0102_0304_0506,
            1_760_000_222,
        );
        let mut bytes = <Battle as Discriminator>::DISCRIMINATOR.to_vec();
        bytes.extend_from_slice(anchor_lang::__private::bytemuck::bytes_of(&b));
        json!({
            "bytes": hex(&bytes),
            "expected": {
                "pendingKind": b.pending_kind, "pendingPiece": b.pending_piece, "pendingTo": b.pending_to,
                "pendingSeat": b.pending_seat, "actionSeq": b.action_seq, "padA": hex(&b.pad_a),
                "pendingSlot": b.pending_slot.to_string(), "pendingTime": b.pending_time,
            }
        })
    })
    .collect()
}

fn army_golden() -> Value {
    let mut ranks = [0u8; 30];
    for (i, r) in ranks.iter_mut().enumerate() {
        *r = (i % 12 + 1) as u8;
    }
    // the private change codes: a dug-in Major and a switched General of the Army
    ranks[3] = vanguard::engine::DUG_IN;
    ranks[4] = vanguard::engine::SWITCHED;
    let key: [u8; 32] = std::array::from_fn(|i| 0xA0 + i as u8);
    let a = Army {
        bump: 250,
        battle: pk(0x11),
        seat: 1,
        player: pk(0x22),
        side: 0,
        ranks,
        fuel: 2,
        truck_turn: -9,
        moves: 513,
        reserved: key,
    };
    let mut bytes = Vec::new();
    a.try_serialize(&mut bytes).expect("serialize army");
    json!({
        "bytes": hex(&bytes),
        "expected": {
            "bump": a.bump, "battle": hex(a.battle.as_ref()), "seat": a.seat, "player": hex(a.player.as_ref()),
            "side": a.side, "ranks": hex(&a.ranks), "fuel": a.fuel, "truckTurn": a.truck_turn, "moves": a.moves,
            "reserved": hex(&a.reserved),
        }
    })
}

fn secret_size() -> usize {
    8 + <Secret as anchor_lang::Space>::INIT_SPACE
}

fn write_or_check(path: PathBuf, value: &Value) {
    let text = serde_json::to_string_pretty(value).expect("json") + "\n";
    if std::env::var("WRITE_GOLDEN").is_ok() {
        std::fs::create_dir_all(path.parent().expect("dir")).expect("mkdir");
        std::fs::write(&path, text).expect("write");
        return;
    }
    let have = std::fs::read_to_string(&path).unwrap_or_default();
    assert_eq!(
        have,
        text,
        "{} is stale: run WRITE_GOLDEN=1 cargo test -p vanguard --test golden",
        path.display()
    );
}

#[test]
fn the_layout_the_app_reads_is_what_the_program_writes() {
    assert_eq!(
        secret_size(),
        116,
        "the Secret is private; the app never reads it"
    );
    let mut l = layout();
    // the probe Army must sit exactly where the offsets table says
    let g = army_golden();
    let bytes = g["bytes"].as_str().expect("hex");
    let off = &l["army"]["offsets"];
    let at = |name: &str| off[name].as_u64().expect("offset") as usize * 2;
    assert_eq!(
        &bytes[at("battle")..at("battle") + 64],
        hex(pk(0x11).as_ref())
    );
    assert_eq!(
        &bytes[at("player")..at("player") + 64],
        hex(pk(0x22).as_ref())
    );
    assert_eq!(&bytes[at("moves")..at("moves") + 4], "0102");
    let key: [u8; 32] = std::array::from_fn(|i| 0xA0 + i as u8);
    assert_eq!(&bytes[at("reserved")..at("reserved") + 64], hex(&key));
    assert_eq!(bytes.len(), at("reserved") + 64, "the key ends the Army");
    assert_eq!(
        l["army"]["size"].as_u64().expect("size") as usize * 2,
        bytes.len()
    );
    l["generated"] = json!(
        "by programs/vanguard/tests/golden.rs; WRITE_GOLDEN=1 cargo test -p vanguard --test golden"
    );
    write_or_check(app_dir().join("chain-layout.json"), &l);
}

#[test]
fn golden_account_bytes_match_the_program() {
    let v = json!({
        "generated": "by programs/vanguard/tests/golden.rs; WRITE_GOLDEN=1 cargo test -p vanguard --test golden",
        "battle": battle_golden(),
        "army": army_golden(),
        "pending": pending_golden(),
        "events": events(),
    });
    write_or_check(app_dir().join("fixtures/golden.json"), &v);
}

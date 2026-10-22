//! Replays the recordings made from the app's TypeScript rules (`app/src/games/vanguard/recordings.ts`).
//! Every action must give the same public board and events, or the same refusal, and a refusal must change nothing.

use serde_json::{json, Value};
use vanguard::engine::*;

const FILE: &str = include_str!("fixtures/recordings.json");

fn winner_name(w: Winner) -> &'static str {
    match w {
        Winner::Army(a) => a.name(),
        Winner::Draw => "draw",
    }
}

fn sq(s: u8) -> Value {
    json!({ "r": row(s), "c": col(s) })
}

fn rank_name(r: u8) -> String {
    match r {
        BOMB => "B".to_string(),
        TRUCK => "F".to_string(),
        n => n.to_string(),
    }
}

fn event_json(r: &Record) -> Value {
    let seq = r.seq;
    match r.event {
        Event::Move { id, from, to } => {
            json!({ "kind": "move", "id": id, "from": sq(from), "to": sq(to), "seq": seq })
        }
        Event::Attack {
            att,
            def,
            from,
            to,
            outcome,
            flash,
        } => {
            let flash: Vec<u8> = flash.iter().copied().filter(|&f| f != NO_PIECE).collect();
            json!({ "kind": "attack", "att": att, "def": def, "from": sq(from), "to": sq(to), "outcome": outcome.name(), "flash": flash, "seq": seq })
        }
        Event::Spotted { id } => json!({ "kind": "spotted", "id": id, "seq": seq }),
        Event::Raid { army, at } => {
            json!({ "kind": "raid", "army": army.name(), "at": sq(at), "seq": seq })
        }
        Event::Storm {
            col,
            index,
            dir,
            n,
            shifts,
        } => {
            let shifts: Vec<Value> = shifts[..n as usize]
                .iter()
                .map(|s| json!({ "id": s.id, "from": sq(s.from), "to": sq(s.to) }))
                .collect();
            json!({ "kind": "storm", "axis": if col { "col" } else { "row" }, "index": index, "dir": dir, "shifts": shifts, "seq": seq })
        }
        Event::Blast { id, at, n, shown } => {
            let shown: Vec<Value> = shown[..n as usize]
                .iter()
                .map(|(id, rank)| json!({ "id": id, "rank": rank_name(*rank) }))
                .collect();
            json!({ "kind": "blast", "id": id, "at": sq(at), "shown": shown, "seq": seq })
        }
        Event::Rescue {
            colonel,
            truck,
            from,
            to,
        } => {
            json!({ "kind": "rescue", "colonel": colonel, "truck": truck, "from": sq(from), "to": sq(to), "seq": seq })
        }
        Event::DugIn { army, id } => {
            json!({ "kind": "dug_in", "army": army.name(), "id": id, "seq": seq })
        }
        Event::Pass { army } => json!({ "kind": "pass", "army": army.name(), "seq": seq }),
        Event::Switched { id } => json!({ "kind": "switched", "id": id, "seq": seq }),
        Event::Turn { turn, timed_out } => {
            json!({ "kind": "turn", "turn": turn.name(), "timedOut": timed_out, "seq": seq })
        }
        Event::End { winner, reason } => {
            json!({ "kind": "end", "winner": winner_name(winner), "reason": reason.name(), "seq": seq })
        }
    }
}

/// What the public state leaves out: the pieces whose rank changed (dead ones too) and the private code of those still
/// on the board.
fn secret_json(g: &Game) -> Value {
    let changed: Vec<usize> = (0..PIECE_SLOTS)
        .filter(|id| g.changed >> id & 1 == 1)
        .collect();
    let codes: Vec<String> = g
        .pieces
        .iter()
        .enumerate()
        .filter(|(_, p)| p.rank == DUG_IN || p.rank == SWITCHED)
        .map(|(id, p)| format!("{id}:{}", if p.rank == DUG_IN { "dug" } else { "spy" }))
        .collect();
    json!({ "changed": changed, "codes": codes })
}

fn state_json(g: &Game) -> Value {
    // a face-up piece shows the rank it plays as
    let rank = |r: u8| rank_name(eff(r));
    let board: Vec<String> = g
        .pieces
        .iter()
        .enumerate()
        .filter(|(_, p)| p.rank != 0)
        .map(|(id, p)| {
            format!(
                "{}{}{}{}={}",
                id,
                if p.army == Army::Us { "u" } else { "i" },
                row(p.sq),
                col(p.sq),
                if p.known {
                    rank(p.rank)
                } else {
                    "?".to_string()
                }
            )
        })
        .collect();
    json!({
        "turn": g.turn.name(),
        "turnNo": g.turn_no,
        "moves": g.moves,
        "twoStep": [g.two_step[0], g.two_step[1]],
        "stepsLeft": g.steps_left,
        "twoStepActive": g.two_step_active,
        "timeouts": [g.timeouts[0], g.timeouts[1]],
        "deadline": g.deadline,
        "stormDone": g.storm_done,
        "eventSeq": g.event_seq,
        "winner": g.winner.map(winner_name),
        "reason": g.reason.map(|r| r.name()),
        "depots": [g.depot_claimed[0], g.depot_claimed[1]],
        "board": board.join(","),
    })
}

fn rank_of(s: &str) -> u8 {
    match s {
        "B" => BOMB,
        "F" => TRUCK,
        n => n.parse().expect("rank"),
    }
}

/// Put a piece anywhere: `<army>:<rank>:<row>:<col>:<piece number>:<known 0|1>:<fuel>`.
fn put(g: &mut Game, s: &str, code: Option<u8>, trail: Option<&Value>) {
    let p: Vec<&str> = s.split(':').collect();
    let sq = p[2].parse::<u8>().expect("row") * 10 + p[3].parse::<u8>().expect("col");
    let id: usize = p[4].parse().expect("piece number");
    let trail_sqs: Vec<u8> = match trail {
        Some(t) => t
            .as_array()
            .expect("trail")
            .iter()
            .map(|q| {
                let q: Vec<&str> = q.as_str().expect("square").split(',').collect();
                q[0].parse::<u8>().expect("row") * 10 + q[1].parse::<u8>().expect("col")
            })
            .collect(),
        None => vec![sq],
    };
    let mut trail = [0u8; 6];
    trail[..trail_sqs.len()].copy_from_slice(&trail_sqs);
    g.pieces[id] = Piece {
        rank: code.unwrap_or_else(|| rank_of(p[1])),
        army: army_of(p[0]),
        sq,
        known: p[5] == "1",
        fuel: p[6].parse().expect("fuel"),
        trail,
        trail_len: trail_sqs.len() as u8,
    };
    g.cells[sq as usize] = id as u8 + 1;
}

fn army_of(s: &str) -> Army {
    if s == "us" {
        Army::Us
    } else {
        Army::It
    }
}

fn start(meta: &Value) -> Game {
    let mut g = Game::start(
        &[],
        army_of(meta["first"].as_str().expect("first")),
        meta["stormAt"].as_u64().expect("stormAt") as u16,
        meta["stormSeed"].as_u64().expect("stormSeed") as u32,
        meta["startedAt"].as_i64().expect("startedAt"),
        CHAIN_CLOCK,
    )
    .expect("an empty start");
    g.version = meta["version"].as_u64().expect("version") as u8;
    for s in meta["layout"].as_array().expect("layout") {
        put(&mut g, s.as_str().expect("piece"), None, None);
    }
    g
}

fn refusal(name: &str) -> Refusal {
    [
        Refusal::MatchOver,
        Refusal::CapPassed,
        Refusal::TurnExpired,
        Refusal::TurnNotExpired,
        Refusal::NotYourTurn,
        Refusal::NoSuchPiece,
        Refusal::IllegalMove,
        Refusal::NoTwoStep,
    ]
    .into_iter()
    .find(|r| r.name() == name)
    .expect("a known refusal")
}

fn parse() -> Value {
    serde_json::from_str(FILE).expect("recordings.json")
}

#[test]
fn constants_match_the_recordings() {
    let c = &parse()["constants"];
    assert_eq!(c["SIZE"], SIZE);
    assert_eq!(c["TURN_SECS"], TURN_SECS);
    assert_eq!(c["GRACE_SECS"], GRACE_SECS);
    assert_eq!(c["OPENING_GRACE_SECS"], OPENING_GRACE_SECS);
    assert_eq!(c["RESOLVE_SLACK_SECS"], RESOLVE_SLACK_SECS);
    assert_eq!(c["RULES_VERSION"], RULES_VERSION);
    assert_eq!(c["CAP_SECS"], CAP_SECS);
    assert_eq!(c["MOVE_CAP"], MOVE_CAP);
    assert_eq!(c["TIMEOUTS_TO_LOSE"], TIMEOUTS_TO_LOSE);
    assert_eq!(c["TRUCK_FUEL"], TRUCK_FUEL);
    assert_eq!(c["STORM_FROM"], STORM_FROM);
    assert_eq!(c["STORM_TO"], STORM_TO);
    let roster: Vec<String> = ROSTER
        .iter()
        .map(|(r, n)| {
            format!(
                "{}x{}",
                if *r == BOMB {
                    "B".into()
                } else if *r == TRUCK {
                    "F".into()
                } else {
                    r.to_string()
                },
                n
            )
        })
        .collect();
    assert_eq!(c["ROSTER"], json!(roster));
    let depots = [
        format!("us:{}:{}", row(DEPOT_SQ[0]), col(DEPOT_SQ[0])),
        format!("it:{}:{}", row(DEPOT_SQ[1]), col(DEPOT_SQ[1])),
    ];
    assert_eq!(c["DEPOTS"], json!(depots));
    let wadis: Vec<String> = (0..SQUARES as u8)
        .filter(|&s| is_wadi(s))
        .map(|s| format!("{}:{}", row(s), col(s)))
        .collect();
    assert_eq!(c["WADIS"], json!(wadis));
}

#[test]
fn the_engine_replays_every_recorded_action() {
    let file = parse();
    let recordings = file["recordings"].as_array().expect("recordings");
    assert!(recordings.len() > 100);
    let mut actions = 0;
    for rec in recordings {
        let meta = &rec["meta"];
        let name = meta["name"].as_str().expect("name");
        let mut g = start(meta);
        for (i, a) in rec["actions"]
            .as_array()
            .expect("actions")
            .iter()
            .enumerate()
        {
            let at = a["at"].as_i64().expect("at");
            let mut out = Events::new();
            let before = state_json(&g);
            let switch = a["switch"].as_bool().unwrap_or(false);
            let id = a["id"].as_u64().unwrap_or(255) as u8;
            let res = match a["kind"].as_str().expect("kind") {
                "move" => {
                    let to = a["to"].as_array().expect("to");
                    g.move_piece(
                        id,
                        (to[0].as_u64().expect("r") * 10 + to[1].as_u64().expect("c")) as u8,
                        at,
                        switch,
                        &mut out,
                    )
                }
                "blast" => g.blast(id, at, switch, &mut out),
                "rescue" => g.rescue(id, at, switch, &mut out),
                "pass" => g.pass(
                    at,
                    a["digIn"].as_u64().map_or(NO_PIECE, |n| n as u8),
                    switch,
                    &mut out,
                ),
                "two_step" => g.start_two_step(at),
                _ => g.timeout(at, &mut out),
            };
            let expect = &a["expect"];
            match res {
                Ok(()) => {
                    assert_eq!(
                        expect["ok"], true,
                        "{name} #{i}: engine accepted what the app refused ({})",
                        expect["reason"]
                    );
                    let events: Vec<Value> = if a["kind"] == "two_step" {
                        vec![]
                    } else {
                        out.as_slice().iter().map(event_json).collect()
                    };
                    assert_eq!(json!(events), expect["events"], "{name} #{i}: events");
                    assert_eq!(state_json(&g), expect["state"], "{name} #{i}: state");
                    assert_eq!(secret_json(&g), expect["secret"], "{name} #{i}: secret");
                }
                Err(r) => {
                    assert_eq!(
                        expect["ok"],
                        false,
                        "{name} #{i}: engine refused ({}) what the app accepted",
                        r.name()
                    );
                    assert_eq!(
                        r,
                        refusal(expect["reason"].as_str().expect("reason")),
                        "{name} #{i}: refusal"
                    );
                    assert_eq!(
                        state_json(&g),
                        before,
                        "{name} #{i}: a refusal must change nothing"
                    );
                }
            }
            actions += 1;
        }
    }
    assert!(actions > 3000, "{actions}");
}

/// A position with the targets the TypeScript rules give: every legal `(piece, square)`, `has_action` and `has_step`.
#[test]
fn the_engine_gives_every_recorded_position_the_same_targets() {
    let file = parse();
    let positions = file["positions"].as_array().expect("positions");
    assert!(positions.len() >= 200);
    let mut checked = 0;
    for pos in positions {
        let name = pos["name"].as_str().expect("name");
        let turn = army_of(pos["turn"].as_str().expect("turn"));
        let mut g = Game::start(&[], turn, 999, 1, 0, CHAIN_CLOCK).expect("start");
        g.version = pos["version"].as_u64().expect("version") as u8;
        g.turn_no = pos["turnNo"].as_u64().expect("turnNo") as u16;
        g.two_step_active = pos["twoStepActive"].as_bool().expect("twoStepActive");
        g.moved = pos["moved"]
            .as_array()
            .expect("moved")
            .iter()
            .fold(0u64, |m, id| m | 1 << id.as_u64().expect("id"));
        g.truck_turn = [
            pos["truckTurn"][0].as_i64().expect("us") as i32,
            pos["truckTurn"][1].as_i64().expect("it") as i32,
        ];
        for s in pos["pieces"].as_array().expect("pieces") {
            let s = s.as_str().expect("piece");
            let id = s.split(':').nth(4).expect("id");
            let code = match pos["changed"][id].as_str() {
                Some("dug") => Some(DUG_IN),
                Some("spy") => Some(SWITCHED),
                _ => None,
            };
            if code.is_some() {
                g.changed |= 1 << id.parse::<u32>().expect("id");
            }
            put(&mut g, s, code, pos["trails"].get(id));
        }
        let mut any_legal = false;
        for (id, legal) in pos["expect"]["targets"].as_object().expect("targets") {
            let id: u8 = id.parse().expect("id");
            let legal: Vec<u8> = legal
                .as_array()
                .expect("squares")
                .iter()
                .map(|q| {
                    let q: Vec<&str> = q.as_str().expect("square").split(',').collect();
                    q[0].parse::<u8>().expect("row") * 10 + q[1].parse::<u8>().expect("col")
                })
                .collect();
            any_legal |= !legal.is_empty();
            for to in 0..SQUARES as u8 {
                let want = legal.contains(&to);
                assert_eq!(
                    g.probe(turn, g.moved, g.two_step_active, id, to),
                    want,
                    "{name}: piece {id} to {to}"
                );
                // the public declare check admits every move some rank could make
                if want {
                    assert_eq!(
                        g.check_declared_move(id, to, 0),
                        Ok(()),
                        "{name}: declare {id} to {to}"
                    );
                }
                checked += 1;
            }
        }
        assert_eq!(
            g.any_move(turn, g.moved, g.two_step_active),
            any_legal,
            "{name}: any_move"
        );
        let expect = &pos["expect"];
        for army in [Army::Us, Army::It] {
            assert_eq!(
                g.has_action(army),
                expect["hasAction"][army.idx()]
                    .as_bool()
                    .expect("hasAction"),
                "{name}: has_action {army:?}"
            );
            assert_eq!(
                g.has_step(army),
                expect["hasStep"][army.idx()].as_bool().expect("hasStep"),
                "{name}: has_step {army:?}"
            );
        }
    }
    assert!(checked > 100_000, "{checked}");
}

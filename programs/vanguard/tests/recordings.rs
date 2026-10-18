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
        Event::Turn { turn, timed_out } => {
            json!({ "kind": "turn", "turn": turn.name(), "timedOut": timed_out, "seq": seq })
        }
        Event::End { winner, reason } => {
            json!({ "kind": "end", "winner": winner_name(winner), "reason": reason.name(), "seq": seq })
        }
    }
}

fn state_json(g: &Game) -> Value {
    let rank = |r: u8| match r {
        BOMB => "B".to_string(),
        TRUCK => "F".to_string(),
        n => n.to_string(),
    };
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

fn army_of(s: &str) -> Army {
    if s == "us" {
        Army::Us
    } else {
        Army::It
    }
}

fn start(meta: &Value) -> Game {
    let layout: Vec<LayoutPiece> = meta["layout"]
        .as_array()
        .expect("layout")
        .iter()
        .map(|s| {
            let p: Vec<&str> = s.as_str().expect("piece").split(':').collect();
            LayoutPiece {
                army: army_of(p[0]),
                rank: rank_of(p[1]),
                sq: (p[2].parse::<u8>().expect("row")) * 10 + p[3].parse::<u8>().expect("col"),
            }
        })
        .collect();
    Game::start(
        &layout,
        army_of(meta["first"].as_str().expect("first")),
        meta["stormAt"].as_u64().expect("stormAt") as u16,
        meta["stormSeed"].as_u64().expect("stormSeed") as u32,
        meta["startedAt"].as_i64().expect("startedAt"),
        CHAIN_CLOCK,
    )
    .expect("a recorded layout is a legal start")
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
            let res = match a["kind"].as_str().expect("kind") {
                "move" => {
                    let to = a["to"].as_array().expect("to");
                    g.move_piece(
                        a["id"].as_u64().expect("id") as u8,
                        (to[0].as_u64().expect("r") * 10 + to[1].as_u64().expect("c")) as u8,
                        at,
                        &mut out,
                    )
                }
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

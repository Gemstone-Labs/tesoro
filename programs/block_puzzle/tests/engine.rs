//! Property tests plus generation of the shared TS/Rust parity vectors.
//!
//! `tests/vectors.json` is regenerated with `WRITE_VECTORS=1 cargo test -p
//! block_puzzle --test engine`; without the variable the test fails if the
//! committed file differs from what the engine now produces.

use block_puzzle::engine::{piece_at, replay, Error, Move, State, HAND, SIZE};
use proptest::prelude::*;

fn splitmix(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Every legal move from `st` with the points it would score.
fn legal(st: &State) -> Vec<(Move, u32)> {
    let base = st.hand_base();
    let mut out = Vec::new();
    for n in 0..HAND {
        for y in 0..SIZE {
            for x in 0..SIZE {
                let mv = Move {
                    piece: (base + n) as u16,
                    x,
                    y,
                };
                let mut t = *st;
                if let Ok(r) = t.apply(mv) {
                    out.push((mv, r.gained));
                }
            }
        }
    }
    out
}

/// Plays a bot: greedy on points, with `random_pct`% random legal moves.
fn play(seed: u64, random_pct: u64, max: usize, rng: &mut u64) -> Vec<Move> {
    let mut st = State::new(seed);
    let mut moves = Vec::new();
    while !st.over && moves.len() < max {
        let options = legal(&st);
        assert!(!options.is_empty(), "not over but no legal move");
        let pick = if splitmix(rng) % 100 < random_pct {
            options[(splitmix(rng) % options.len() as u64) as usize].0
        } else {
            options
                .iter()
                .max_by_key(|(_, g)| *g)
                .map(|(m, _)| *m)
                .unwrap()
        };
        st.apply(pick).unwrap();
        moves.push(pick);
    }
    moves
}

fn moves_json(moves: &[Move]) -> String {
    let parts: Vec<String> = moves
        .iter()
        .map(|m| format!("[{},{},{}]", m.piece, m.x, m.y))
        .collect();
    format!("[{}]", parts.join(","))
}

fn build_vectors() -> (String, usize) {
    let mut rng = 0xC0FFEE_u64;
    let mut seeds: Vec<u64> = vec![0, 1, 2, 42, u64::MAX, 1 << 63, 0xDEAD_BEEF_CAFE_F00D];
    while seeds.len() < 40 {
        seeds.push(splitmix(&mut rng));
    }

    let mut pieces = Vec::new();
    for s in &seeds[..12] {
        let list: Vec<String> = (0..12)
            .map(|i| {
                let p = piece_at(*s, i);
                format!("[{},{}]", p.kind, p.gem.map_or(-1, i32::from))
            })
            .collect();
        pieces.push(format!(
            "{{\"seed\":\"{s}\",\"pieces\":[{}]}}",
            list.join(",")
        ));
    }

    let mut games = Vec::new();
    let mut gem_games = 0;
    for (i, s) in seeds.iter().enumerate() {
        let random_pct = [0, 15, 60, 100][i % 4];
        let max = if i % 5 == 0 { 25 } else { 200 };
        let moves = play(*s, random_pct, max, &mut rng);
        let st = replay(*s, &moves).unwrap();
        // Count gem clears to prove the vectors exercise the multiplier.
        let mut chk = State::new(*s);
        let mut hit = false;
        for m in &moves {
            hit |= chk.apply(*m).unwrap().gems > 0;
        }
        gem_games += usize::from(hit);
        games.push(format!(
            "{{\"seed\":\"{s}\",\"moves\":{},\"ok\":true,\"score\":{},\"count\":{},\"over\":{},\"occ\":\"{:016x}\",\"gems\":\"{:016x}\"}}",
            moves_json(&moves), st.score, st.moves, st.over, st.occ, st.gems
        ));
    }

    // Rejected runs: a valid prefix then one bad move.
    let mut rejects = Vec::new();
    for (i, s) in seeds.iter().take(24).enumerate() {
        let mut prefix = play(*s, 30, 4 + i % 5, &mut rng);
        let st = replay(*s, &prefix).unwrap();
        if st.over {
            continue;
        }
        let base = st.hand_base() as u16;
        let bad = match i % 4 {
            0 => Move {
                piece: base + 3,
                x: 0,
                y: 0,
            },
            1 => match (0..3u16).find(|n| st.used >> n & 1 == 1) {
                Some(n) => Move {
                    piece: base + n,
                    x: 0,
                    y: 0,
                },
                None => Move {
                    piece: base + 5,
                    x: 0,
                    y: 0,
                },
            },
            2 => Move {
                piece: base,
                x: 8,
                y: 0,
            },
            _ => {
                // Re-place onto an occupied cell if one exists, else out of bounds.
                let mut m = Move {
                    piece: base,
                    x: 0,
                    y: 8,
                };
                'f: for y in 0..SIZE {
                    for x in 0..SIZE {
                        let cand = Move { piece: base, x, y };
                        let mut t = st;
                        if t.apply(cand) == Err(Error::Occupied) {
                            m = cand;
                            break 'f;
                        }
                    }
                }
                m
            }
        };
        let mut all = prefix.clone();
        all.push(bad);
        match replay(*s, &all) {
            Err((at, e)) => {
                assert_eq!(at, prefix.len());
                rejects.push(format!(
                    "{{\"seed\":\"{s}\",\"moves\":{},\"ok\":false,\"error\":\"{}\",\"at\":{at}}}",
                    moves_json(&all),
                    e.name()
                ));
            }
            Ok(_) => {
                prefix.clear(); // bad move happened to be legal; skip this case
            }
        }
    }
    // A move after the game ended.
    let s = 7u64;
    let mut moves = play(s, 100, 200, &mut rng);
    let over = replay(s, &moves).unwrap();
    assert!(over.over);
    moves.push(Move {
        piece: 0,
        x: 0,
        y: 0,
    });
    let (at, e) = replay(s, &moves).unwrap_err();
    rejects.push(format!(
        "{{\"seed\":\"{s}\",\"moves\":{},\"ok\":false,\"error\":\"{}\",\"at\":{at}}}",
        moves_json(&moves),
        e.name()
    ));

    let json = format!(
        "{{\n\"pieces\":[\n{}\n],\n\"games\":[\n{}\n],\n\"rejects\":[\n{}\n]\n}}\n",
        pieces.join(",\n"),
        games.join(",\n"),
        rejects.join(",\n")
    );
    (json, gem_games)
}

#[test]
fn vectors_match_committed_file() {
    let (json, gem_games) = build_vectors();
    assert!(gem_games >= 8, "only {gem_games} vectors clear a gem");
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors.json");
    if std::env::var("WRITE_VECTORS").is_ok() {
        std::fs::write(path, &json).unwrap();
    } else {
        let on_disk =
            std::fs::read_to_string(path).expect("vectors.json missing; run with WRITE_VECTORS=1");
        assert_eq!(
            on_disk, json,
            "vectors.json is stale; rerun with WRITE_VECTORS=1"
        );
    }
}

proptest! {
    #[test]
    fn replay_is_deterministic(seed in any::<u64>(), pct in 0u64..100, rs in any::<u64>()) {
        let mut rng = rs;
        let moves = play(seed, pct, 60, &mut rng);
        let a = replay(seed, &moves).unwrap();
        let b = replay(seed, &moves).unwrap();
        prop_assert_eq!(a, b);
        prop_assert_eq!(a.moves as usize, moves.len());
        prop_assert_eq!(a.gems & !a.occ, 0);
    }

    #[test]
    fn arbitrary_moves_never_panic_and_are_deterministic(
        seed in any::<u64>(),
        raw in proptest::collection::vec((0u16..9, 0u8..10, 0u8..10), 0..40),
    ) {
        let moves: Vec<Move> = raw.iter().map(|&(piece, x, y)| Move { piece, x, y }).collect();
        prop_assert_eq!(replay(seed, &moves), replay(seed, &moves));
    }

    #[test]
    fn invalid_moves_are_rejected(seed in any::<u64>(), rs in any::<u64>(), pick in 0usize..4) {
        let mut rng = rs;
        let prefix = play(seed, 40, 6, &mut rng);
        let st = replay(seed, &prefix).unwrap();
        prop_assume!(!st.over);
        let base = st.hand_base() as u16;
        let (bad, want) = match pick {
            0 => (Move { piece: base + 3, x: 0, y: 0 }, Error::BadPiece),
            1 => (Move { piece: base, x: 8, y: 8 }, Error::OutOfBounds),
            2 => (Move { piece: base, x: 255, y: 0 }, Error::OutOfBounds),
            _ => (Move { piece: base + 100, x: 0, y: 0 }, Error::BadPiece),
        };
        let mut t = st;
        prop_assert_eq!(t.apply(bad), Err(want));
        prop_assert_eq!(t, st, "a rejected move must not change state");
    }

    #[test]
    fn occupied_and_reused_pieces_are_rejected(seed in any::<u64>(), rs in any::<u64>()) {
        let mut rng = rs;
        let prefix = play(seed, 40, 1, &mut rng);
        prop_assume!(prefix.len() == 1);
        let mut st = replay(seed, &prefix).unwrap();
        prop_assume!(!st.over && st.moves == 1);
        let again = Move { piece: prefix[0].piece, x: prefix[0].x, y: prefix[0].y };
        prop_assert_eq!(st.apply(again), Err(Error::PieceUsed));
        let other = st.hand_base() as u16 + if prefix[0].piece == 0 { 1 } else { 0 };
        let (w, _) = block_puzzle::engine::dims(piece_at(seed, u32::from(other)));
        // Placing on top of the first piece's anchor overlaps unless it clears.
        let mut t = st;
        if let Err(e) = t.apply(Move { piece: other, x: prefix[0].x.min(SIZE - w), y: prefix[0].y }) {
            prop_assert!(matches!(e, Error::Occupied | Error::OutOfBounds));
        }
    }
}

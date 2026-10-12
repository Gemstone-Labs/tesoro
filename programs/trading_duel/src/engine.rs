//! The price-grid rules. `app/src/games/trading-duel/grid.ts` is the TypeScript twin: both are
//! tested against `tests/fixtures/grid-vectors.json`, so change them together.
//!
//! Times are seconds since the Match started. Prices are 1e-8 USD.

use crate::state::*;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum EngineError {
    BadColumn,
    BadRow,
    Locked,
}

/// Row height from the anchor: `anchor * ppm / 1e6`, at least 1.
pub fn step_for(anchor: u64, ppm: u64) -> u64 {
    let s = (u128::from(anchor) * u128::from(ppm) / 1_000_000).min(u128::from(u64::MAX));
    (s as u64).max(1)
}

/// Row 0 is the bottom, row 7 the top; the outer two are open-ended.
pub fn row_of(price: u64, anchor: u64, step: u64) -> u8 {
    let r = (i128::from(price) - i128::from(anchor)).div_euclid(i128::from(step)) + 4;
    r.clamp(0, i128::from(ROWS) - 1) as u8
}

pub fn column_start(c: usize) -> i64 {
    HEAD_START_SECS + COLUMN_SECS * c as i64
}

pub fn column_end(c: usize) -> i64 {
    column_start(c) + COLUMN_SECS
}

pub fn lock_at(c: usize) -> i64 {
    column_start(c) - LOCK_AHEAD_SECS
}

/// Picks for a column are accepted while it is not locked.
pub fn can_pick(c: usize, t: i64) -> bool {
    c < COLUMNS && t < lock_at(c)
}

/// The column a time falls in, or `None` during the head start and after the last column.
pub fn column_at(t: i64) -> Option<usize> {
    if !(HEAD_START_SECS..MATCH_SECS).contains(&t) {
        return None;
    }
    Some(((t - HEAD_START_SECS) / COLUMN_SECS) as usize)
}

/// Columns whose window has fully passed at `t` (all of them once the window is over).
pub fn columns_done(t: i64) -> usize {
    if t >= MATCH_SECS {
        COLUMNS
    } else if t < HEAD_START_SECS {
        0
    } else {
        ((t - HEAD_START_SECS) / COLUMN_SECS) as usize
    }
}

/// Validates a pick (`NO_PICK` clears) made at time `t`.
pub fn check_pick(column: usize, row: u8, t: i64) -> Result<(), EngineError> {
    if column >= COLUMNS {
        return Err(EngineError::BadColumn);
    }
    if row != NO_PICK && row >= ROWS {
        return Err(EngineError::BadRow);
    }
    if !can_pick(column, t) {
        return Err(EngineError::Locked);
    }
    Ok(())
}

impl Track {
    fn has(&self, c: usize) -> bool {
        self.seen & (1 << c) != 0
    }

    fn extend(&mut self, c: usize, price: u64) {
        if !self.has(c) {
            self.lo[c] = price;
            self.hi[c] = price;
            self.seen |= 1 << c;
        } else {
            self.lo[c] = self.lo[c].min(price);
            self.hi[c] = self.hi[c].max(price);
        }
    }

    /// Records a price sample at time `t`. A sample inside column `c` first gives every column that
    /// got no sample of its own (and has a line to carry) the last price recorded before it, then
    /// starts `c` from that price (the line enters the column there) and extends it. Samples during
    /// the head start only set the carried price; samples at or after the end are ignored.
    pub fn record(&mut self, t: i64, price: u64) {
        if t >= MATCH_SECS {
            return;
        }
        let c = column_at(t);
        if let Some(c) = c {
            if self.last != 0 {
                let from = (i32::from(self.last_col) + 1).max(0) as usize;
                for k in from..c {
                    if !self.has(k) {
                        self.extend(k, self.last);
                    }
                }
                if !self.has(c) {
                    self.extend(c, self.last);
                }
            }
            self.extend(c, price);
        }
        self.last = price;
        self.last_col = c.map_or(-1, |c| c as i8);
    }

    /// Closes the window: every column without data of its own takes the last price recorded.
    /// No end price is added, so the result is the same whoever ends the Match and when.
    pub fn finish(&mut self) {
        if self.last == 0 {
            return;
        }
        let from = (i32::from(self.last_col) + 1).max(0) as usize;
        for k in from..COLUMNS {
            if !self.has(k) {
                self.extend(k, self.last);
            }
        }
    }

    /// True when `row` lies within the rows the line crossed in column `c`.
    pub fn hits(&self, c: usize, row: u8, anchor: u64, step: u64) -> bool {
        if c >= COLUMNS || row >= ROWS || !self.has(c) {
            return false;
        }
        row_of(self.lo[c], anchor, step) <= row && row <= row_of(self.hi[c], anchor, step)
    }
}

/// Points per seat from the first `upto` columns, from the picks `revealed` so far.
pub fn score(
    track: &Track,
    picks: &[[u8; COLUMNS]; 2],
    anchor: u64,
    step: u64,
    upto: usize,
) -> [u32; 2] {
    let mut scores = [0u32; 2];
    for (seat, p) in picks.iter().enumerate() {
        for (c, &row) in p.iter().enumerate().take(upto) {
            if row != NO_PICK && track.hits(c, row, anchor, step) {
                scores[seat] += HIT_POINTS;
            }
        }
    }
    scores
}

pub fn winner(scores: [u32; 2]) -> u8 {
    match scores[0].cmp(&scores[1]) {
        core::cmp::Ordering::Greater => 0,
        core::cmp::Ordering::Less => 1,
        core::cmp::Ordering::Equal => DRAW,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn num(v: &Value) -> u64 {
        v.as_str().expect("string").parse().expect("number")
    }

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/grid-vectors.json")).expect("json")
    }

    #[test]
    fn constants_match_the_fixture() {
        let f = fixture();
        let c = &f["constants"];
        assert_eq!(c["COLUMNS"], COLUMNS);
        assert_eq!(c["ROWS"], ROWS);
        assert_eq!(c["COLUMN_SECS"], COLUMN_SECS);
        assert_eq!(c["HEAD_START_SECS"], HEAD_START_SECS);
        assert_eq!(c["LOCK_AHEAD_SECS"], LOCK_AHEAD_SECS);
        assert_eq!(c["HIT_POINTS"], HIT_POINTS);
        assert_eq!(c["NO_PICK"], NO_PICK);
        assert_eq!(c["MATCH_SECS"], MATCH_SECS);
        for (i, asset) in ["SOL", "ETH", "HYPE"].iter().enumerate() {
            assert_eq!(c["STEP_PPM"][asset], STEP_PPM[i], "{asset}");
        }
    }

    #[test]
    fn rows_at_the_edges() {
        for r in fixture()["rows"].as_array().expect("rows") {
            let (anchor, step, price) = (num(&r["anchor"]), num(&r["step"]), num(&r["price"]));
            assert_eq!(
                u64::from(row_of(price, anchor, step)),
                r["row"].as_u64().expect("row"),
                "price {price} anchor {anchor} step {step}"
            );
        }
    }

    #[test]
    fn locks_follow_the_fixture() {
        for l in fixture()["locks"].as_array().expect("locks") {
            let c = l["column"].as_u64().expect("column") as usize;
            assert_eq!(column_start(c), l["columnStart"].as_i64().expect("start"));
            assert_eq!(column_end(c), l["columnEnd"].as_i64().expect("end"));
            assert_eq!(lock_at(c), l["lockAt"].as_i64().expect("lock"));
        }
    }

    #[test]
    fn shared_vectors() {
        let f = fixture();
        for v in f["vectors"].as_array().expect("vectors") {
            let name = v["name"].as_str().expect("name");
            let (anchor, step) = (num(&v["anchor"]), num(&v["step"]));
            let ppm = v["stepPpm"].as_u64().expect("ppm");
            assert_eq!(step_for(anchor, ppm), step, "{name}: step");
            let mut tr = Track::default();
            for s in v["samples"].as_array().expect("samples") {
                tr.record(s[0].as_i64().expect("t"), num(&s[1]));
            }
            tr.finish();
            let e = &v["expected"];
            for c in 0..COLUMNS {
                let (lo, hi) = (&e["lo"][c], &e["hi"][c]);
                if lo.is_null() {
                    assert!(!tr.has(c), "{name}: column {c} should have no data");
                } else {
                    assert_eq!(
                        (tr.lo[c], tr.hi[c]),
                        (num(lo), num(hi)),
                        "{name}: column {c}"
                    );
                }
            }
            let mut picks = [[NO_PICK; COLUMNS]; 2];
            for seat in 0..2 {
                for c in 0..COLUMNS {
                    picks[seat][c] = v["picks"][seat][c].as_u64().expect("pick") as u8;
                }
            }
            for seat in 0..2 {
                for c in 0..COLUMNS {
                    let hit = picks[seat][c] != NO_PICK && tr.hits(c, picks[seat][c], anchor, step);
                    assert_eq!(
                        hit,
                        e["hits"][seat][c].as_bool().expect("hit"),
                        "{name}: seat {seat} column {c}"
                    );
                }
            }
            let scores = score(&tr, &picks, anchor, step, COLUMNS);
            let want: Vec<u64> = e["scores"]
                .as_array()
                .expect("scores")
                .iter()
                .map(|x| x.as_u64().expect("n"))
                .collect();
            assert_eq!(scores.map(u64::from).to_vec(), want, "{name}: scores");
            let w = match &e["winner"] {
                Value::String(_) => DRAW,
                n => n.as_u64().expect("winner") as u8,
            };
            assert_eq!(winner(scores), w, "{name}: winner");
        }
    }

    #[test]
    fn samples_after_the_end_and_a_clean_track() {
        let mut tr = Track::default();
        tr.record(30, 100);
        tr.record(150, 5_000);
        assert_eq!(tr.hi[11], 0);
        assert_eq!(tr.last, 100);
        assert_eq!(tr.last_col, 0);
    }

    #[test]
    fn picks_close_ten_seconds_before_the_column() {
        assert!(check_pick(0, 3, 19).is_ok());
        assert_eq!(check_pick(0, 3, 20), Err(EngineError::Locked));
        assert_eq!(check_pick(0, NO_PICK, 20), Err(EngineError::Locked));
        assert_eq!(check_pick(12, 3, 0), Err(EngineError::BadColumn));
        assert_eq!(check_pick(0, 8, 0), Err(EngineError::BadRow));
        assert!(check_pick(11, 7, 129).is_ok());
    }

    #[test]
    fn columns_done_counts_whole_windows() {
        assert_eq!(columns_done(0), 0);
        assert_eq!(columns_done(39), 0);
        assert_eq!(columns_done(40), 1);
        assert_eq!(columns_done(149), 11);
        assert_eq!(columns_done(150), 12);
    }
}

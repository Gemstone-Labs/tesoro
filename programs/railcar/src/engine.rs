//! Pure Railcar rules: everything is a function of the 32-byte VRF output, the
//! Brake presses and the entry. Integer math only; the TypeScript engine in
//! `app/src/games/railcar/engine.ts` matches it bit for bit (`tests/vectors.json`).
//!
//! Units: times are milliseconds, track positions are milliseconds at full
//! speed ("track ms"). Full speed advances one track ms per real ms; while a
//! Brake is active, half of one.

/// Fastest a ride can end, in track ms.
pub const MIN_CRASH_MS: u32 = 10_000;
/// Slowest a ride can end, in track ms.
pub const MAX_CRASH_MS: u32 = 120_000;
/// Median of the exponential part, in ms.
pub const MEDIAN_MS: u64 = 30_000;
/// One Brake slows the car for this long (real ms).
pub const BRAKE_MS: u32 = 5_000;
/// A ride ends no later than this in real time.
pub const RIDE_CAP_MS: u32 = 600_000;

pub const SCREW_LEAD: (u32, u32) = (20_000, 40_000);
pub const BOLT_LEAD: (u32, u32) = (8_000, 15_000);
pub const SPARK_LEAD: (u32, u32) = (3_000, 8_000);
pub const MAX_FALSE_SCREWS: usize = 4;
const FALSE_SCREW_FROM_MS: u32 = 2_000;
const FALSE_SCREW_SPAN_MS: u32 = 16_000;
const FALSE_SCREW_GAP_MS: u32 = 1_000;

/// Everything the 32 random bytes decide for one ride.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ride {
    pub crash_ms: u32,
    pub screw_lead_ms: u32,
    pub bolt_lead_ms: u32,
    pub spark_lead_ms: u32,
    pub screw_at_ms: u32,
    pub bolt_at_ms: u32,
    pub spark_at_ms: u32,
    false_screws: [u32; MAX_FALSE_SCREWS],
    false_len: u8,
}

impl Ride {
    /// Positions of the false screws, ascending, all before the real screws.
    pub fn false_screws(&self) -> &[u32] {
        self.false_screws
            .get(..usize::from(self.false_len))
            .unwrap_or(&self.false_screws)
    }
}

fn word(draw: &[u8; 32], i: usize) -> u64 {
    let start = i.saturating_mul(8);
    let end = start.saturating_add(8);
    let mut b = [0u8; 8];
    if let Some(slice) = draw.get(start..end) {
        b.copy_from_slice(slice);
    }
    u64::from_le_bytes(b)
}

fn splitmix(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// `-log2(U)` in Q32 for `U = (w + 1) / 2^64`, so the result is in `[0, 64]`.
/// 32 squaring steps; deterministic integer arithmetic only.
fn neg_log2_q32(w: u64) -> u64 {
    let v = u128::from(w).saturating_add(1); // 1..=2^64
    let k = 127u32.saturating_sub(v.leading_zeros()); // floor(log2 v), 0..=64
    let mut frac = 0u64;
    if v != 1u128 << k {
        let mut m = v << (63u32.saturating_sub(k)); // mantissa in [2^63, 2^64)
        for _ in 0..32 {
            m = m.saturating_mul(m) >> 63;
            frac <<= 1;
            if m >= 1u128 << 64 {
                frac |= 1;
                m >>= 1;
            }
        }
    }
    (64u64 << 32).saturating_sub((u64::from(k) << 32).saturating_add(frac))
}

/// Crash point in track ms from the first word of the draw.
fn crash_from(w: u64) -> u32 {
    let extra = MEDIAN_MS.saturating_mul(neg_log2_q32(w)) >> 32;
    let clamped = u64::from(MIN_CRASH_MS)
        .saturating_add(extra)
        .min(u64::from(MAX_CRASH_MS));
    u32::try_from(clamped).unwrap_or(MAX_CRASH_MS)
}

fn lead(w: u64, (lo, hi): (u32, u32)) -> u32 {
    let span = u64::from(hi.saturating_sub(lo)).saturating_add(1);
    let offset = w.checked_rem(span).unwrap_or(0);
    lo.saturating_add(u32::try_from(offset).unwrap_or(0))
}

/// Derive the whole ride from the VRF output.
pub fn ride(draw: &[u8; 32]) -> Ride {
    let (w0, w1, w2, w3) = (word(draw, 0), word(draw, 1), word(draw, 2), word(draw, 3));
    let crash_ms = crash_from(w0);
    let screw_lead_ms = lead(w1, SCREW_LEAD);
    let bolt_lead_ms = lead(w2, BOLT_LEAD);
    let spark_lead_ms = lead(w3, SPARK_LEAD);
    let at = |l: u32| crash_ms.saturating_sub(l);
    let screw_at_ms = at(screw_lead_ms);

    let mut s = w1 ^ w2.rotate_left(21) ^ w3.rotate_left(42) ^ w0.rotate_left(7);
    let count =
        usize::from(u8::try_from(splitmix(&mut s).checked_rem(3).unwrap_or(0)).unwrap_or(0))
            .saturating_add(2);
    let span = u64::from(FALSE_SCREW_SPAN_MS).saturating_add(1);
    let mut candidates = [0u32; MAX_FALSE_SCREWS];
    for c in candidates.iter_mut().take(count) {
        let offset = splitmix(&mut s).checked_rem(span).unwrap_or(0);
        *c = FALSE_SCREW_FROM_MS.saturating_add(u32::try_from(offset).unwrap_or(0));
    }
    let slice = match candidates.get_mut(..count) {
        Some(s) => s,
        None => &mut candidates[..],
    };
    slice.sort_unstable();
    let mut false_screws = [0u32; MAX_FALSE_SCREWS];
    let mut false_len = 0u8;
    for &c in slice.iter() {
        if c.saturating_add(FALSE_SCREW_GAP_MS) <= screw_at_ms {
            if let Some(slot) = false_screws.get_mut(usize::from(false_len)) {
                *slot = c;
                false_len = false_len.saturating_add(1);
            }
        }
    }

    Ride {
        crash_ms,
        screw_lead_ms,
        bolt_lead_ms,
        spark_lead_ms,
        screw_at_ms,
        bolt_at_ms: at(bolt_lead_ms),
        spark_at_ms: at(spark_lead_ms),
        false_screws,
        false_len,
    }
}

/// Slow periods `[start, end)` in real ms from Brake presses (ascending times,
/// real ms since departure). A press during a slow period extends it by 5 s.
fn slow_periods(brakes: &[u32]) -> Vec<(u32, u32)> {
    let mut out: Vec<(u32, u32)> = Vec::new();
    for &p in brakes {
        match out.last_mut() {
            Some(last) if p < last.1 => last.1 = last.1.saturating_add(BRAKE_MS),
            _ => out.push((p, p.saturating_add(BRAKE_MS))),
        }
    }
    out
}

/// Track position (track ms, rounded down) after `t` real ms.
pub fn position_ms(brakes: &[u32], t: u32) -> u32 {
    let slowed: u64 = slow_periods(brakes)
        .iter()
        .map(|&(s, e)| u64::from(e.min(t).saturating_sub(s.min(t))))
        .sum();
    let half = u64::from(t).saturating_mul(2).saturating_sub(slowed) >> 1;
    u32::try_from(half).unwrap_or(u32::MAX)
}

/// First real ms at which the car has travelled `crash_ms` track ms, capped at
/// the ten-minute ride limit.
pub fn impact_ms(brakes: &[u32], crash_ms: u32) -> u32 {
    // Half track ms: fast advances 2 per real ms, slow 1.
    let mut remaining = u64::from(crash_ms).saturating_mul(2);
    let mut cursor = 0u64;
    let mut t = None;
    for (s, e) in slow_periods(brakes) {
        let (s, e) = (u64::from(s), u64::from(e));
        let fast = s.saturating_sub(cursor).saturating_mul(2);
        if remaining <= fast {
            t = Some(cursor.saturating_add(remaining.div_ceil(2)));
            break;
        }
        remaining = remaining.saturating_sub(fast);
        let slow_span = e.saturating_sub(s);
        if remaining <= slow_span {
            t = Some(s.saturating_add(remaining));
            break;
        }
        remaining = remaining.saturating_sub(slow_span);
        cursor = e;
    }
    let t = t.unwrap_or_else(|| cursor.saturating_add(remaining.div_ceil(2)));
    u32::try_from(t.min(u64::from(RIDE_CAP_MS))).unwrap_or(RIDE_CAP_MS)
}

/// Early-jump refund in percent of the entry, by track position (track ms).
pub fn refund_pct(position_ms: u32) -> u32 {
    match position_ms {
        0..=19_999 => 80,
        20_000..=89_999 => {
            let step = position_ms
                .saturating_sub(20_000)
                .checked_div(10_000)
                .unwrap_or(0);
            70u32.saturating_sub(step.saturating_mul(10))
        }
        90_000..=99_999 => 5,
        _ => 0,
    }
}

/// Gemas returned to a Player who Jumps at `position_ms`.
pub fn refund(entry: u64, position_ms: u32) -> u64 {
    let scaled = u128::from(entry)
        .saturating_mul(u128::from(refund_pct(position_ms)))
        .checked_div(100)
        .unwrap_or(0);
    u64::try_from(scaled).unwrap_or(u64::MAX)
}

/// Refund for a Jump at real time `t` under the Brake presses.
pub fn refund_at(entry: u64, brakes: &[u32], t: u32) -> u64 {
    refund(entry, position_ms(brakes, t))
}

/// Place shares in basis points, last Player off first.
pub fn place_shares_bps(placed: usize) -> [u32; 3] {
    match placed {
        0 => [0, 0, 0],
        1 => [10_000, 0, 0],
        2 => [7_000, 3_000, 0],
        _ => [6_000, 2_500, 1_500],
    }
}

/// Split `amount` between the placed Players; the rounding remainder goes to
/// the top share.
pub fn split(amount: u64, placed: usize) -> [u64; 3] {
    let bps = place_shares_bps(placed.min(3));
    let mut out = [0u64; 3];
    for (slot, &share) in out.iter_mut().zip(bps.iter()) {
        let part = u128::from(amount)
            .saturating_mul(u128::from(share))
            .checked_div(10_000)
            .unwrap_or(0);
        *slot = u64::try_from(part).unwrap_or(u64::MAX);
    }
    if bps[0] != 0 {
        let sum: u64 = out.iter().sum();
        out[0] = out[0].saturating_add(amount.saturating_sub(sum));
    }
    out
}

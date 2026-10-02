//! Pure trading rules: fills with a spread, one position at a time, liquidation, marking.
//! No clocks, accounts or syscalls. Prices are the oracle's, in 1e-8 USD; money is Chips.

use crate::state::*;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum EngineError {
    Overflow,
    BadPrice,
    InvalidLeverage,
    MarginTooSmall,
    NotEnoughChips,
    PositionOpen,
    NoPosition,
    InvalidSide,
}

type Result<T> = core::result::Result<T, EngineError>;

const BPS: u128 = 10_000;

/// The price a fill executes at: the oracle price moved against the Player by the spread. Buying
/// (opening a long, closing a short) pays more, selling receives less.
pub fn fill_price(mid: u64, buying: bool) -> Result<u64> {
    if mid == 0 {
        return Err(EngineError::BadPrice);
    }
    let mid = u128::from(mid);
    let spread = u128::from(SPREAD_BPS);
    let price = if buying {
        // Rounded up.
        mid.checked_mul(BPS + spread)
            .and_then(|v| v.checked_add(BPS - 1))
            .ok_or(EngineError::Overflow)?
            / BPS
    } else {
        mid.checked_mul(BPS - spread).ok_or(EngineError::Overflow)? / BPS
    };
    u64::try_from(price).map_err(|_| EngineError::Overflow)
}

/// Realised or unrealised PnL in Chips at `exit`, rounded down (a loss rounds away from zero).
pub fn pnl(side: u8, notional: u64, entry: u64, exit: u64) -> Result<i64> {
    if entry == 0 {
        return Err(EngineError::BadPrice);
    }
    let diff = match side {
        SIDE_LONG => i128::from(exit).checked_sub(i128::from(entry)),
        SIDE_SHORT => i128::from(entry).checked_sub(i128::from(exit)),
        _ => return Err(EngineError::InvalidSide),
    }
    .ok_or(EngineError::Overflow)?;
    let num = i128::from(notional)
        .checked_mul(diff)
        .ok_or(EngineError::Overflow)?;
    i64::try_from(num.div_euclid(i128::from(entry))).map_err(|_| EngineError::Overflow)
}

/// Margin plus PnL of the open position when closed at `mid`, floored at zero.
fn position_value(book: &Book, mid: u64) -> Result<u64> {
    if book.side == SIDE_FLAT {
        return Ok(0);
    }
    let exit = fill_price(mid, book.side == SIDE_SHORT)?;
    let p = pnl(book.side, book.notional, book.entry, exit)?;
    let value = i128::from(book.margin)
        .checked_add(i128::from(p))
        .ok_or(EngineError::Overflow)?;
    u64::try_from(value.max(0)).map_err(|_| EngineError::Overflow)
}

/// Cash plus the open position's value if it were closed at `mid`.
pub fn equity(book: &Book, mid: u64) -> Result<u64> {
    book.cash
        .checked_add(position_value(book, mid)?)
        .ok_or(EngineError::Overflow)
}

fn push_fill(book: &mut Book, fill: Fill) -> Result<()> {
    let idx = (book.fill_count as usize) % FILL_LOG;
    book.fills[idx] = fill;
    book.fill_count = book
        .fill_count
        .checked_add(1)
        .ok_or(EngineError::Overflow)?;
    Ok(())
}

/// Opens a position of `margin` Chips at `leverage`. Only from flat.
pub fn open(book: &mut Book, side: u8, margin: u64, leverage: u8, mid: u64, t: u32) -> Result<()> {
    if side != SIDE_LONG && side != SIDE_SHORT {
        return Err(EngineError::InvalidSide);
    }
    if !(MIN_LEVERAGE..=MAX_LEVERAGE).contains(&leverage) {
        return Err(EngineError::InvalidLeverage);
    }
    if book.side != SIDE_FLAT {
        return Err(EngineError::PositionOpen);
    }
    if margin < MIN_MARGIN {
        return Err(EngineError::MarginTooSmall);
    }
    if margin > book.cash {
        return Err(EngineError::NotEnoughChips);
    }
    let price = fill_price(mid, side == SIDE_LONG)?;
    let notional = margin
        .checked_mul(u64::from(leverage))
        .ok_or(EngineError::Overflow)?;
    book.cash = book
        .cash
        .checked_sub(margin)
        .ok_or(EngineError::NotEnoughChips)?;
    book.side = side;
    book.margin = margin;
    book.notional = notional;
    book.leverage = leverage;
    book.entry = price;
    book.trades = book.trades.checked_add(1).ok_or(EngineError::Overflow)?;
    let equity = equity(book, mid)?;
    push_fill(
        book,
        Fill {
            t,
            kind: FILL_OPEN,
            side,
            price,
            notional,
            margin,
            pnl: 0,
            equity,
        },
    )
}

/// Closes the open position at `mid` as a `kind` fill and returns its PnL.
pub fn close(book: &mut Book, mid: u64, t: u32, kind: u8) -> Result<i64> {
    if book.side == SIDE_FLAT {
        return Err(EngineError::NoPosition);
    }
    let side = book.side;
    let price = fill_price(mid, side == SIDE_SHORT)?;
    let p = pnl(side, book.notional, book.entry, price)?;
    let value = i128::from(book.margin)
        .checked_add(i128::from(p))
        .ok_or(EngineError::Overflow)?;
    let value = u64::try_from(value.max(0)).map_err(|_| EngineError::Overflow)?;
    let (notional, margin) = (book.notional, book.margin);
    book.cash = book.cash.checked_add(value).ok_or(EngineError::Overflow)?;
    book.side = SIDE_FLAT;
    book.margin = 0;
    book.notional = 0;
    book.leverage = 0;
    book.entry = 0;
    if kind == FILL_LIQUIDATED {
        book.liquidations = book
            .liquidations
            .checked_add(1)
            .ok_or(EngineError::Overflow)?;
    }
    let equity = book.cash;
    push_fill(
        book,
        Fill {
            t,
            kind,
            side,
            price,
            notional,
            margin,
            pnl: p,
            equity,
        },
    )?;
    Ok(p)
}

/// Liquidates the position when its margin plus PnL is at or below the maintenance margin.
pub fn liquidate_if_due(book: &mut Book, mid: u64, t: u32) -> Result<bool> {
    if book.side == SIDE_FLAT {
        return Ok(false);
    }
    let value = position_value(book, mid)?;
    let maintenance = u64::try_from(
        u128::from(book.notional)
            .checked_mul(u128::from(MAINTENANCE_BPS))
            .ok_or(EngineError::Overflow)?
            / BPS,
    )
    .map_err(|_| EngineError::Overflow)?;
    if value > maintenance {
        return Ok(false);
    }
    close(book, mid, t, FILL_LIQUIDATED)?;
    Ok(true)
}

/// The coarse lead shown to the opponent and to spectators.
pub fn lead(equity: [u64; 2]) -> u8 {
    let (a, b) = (equity[0], equity[1]);
    if a.abs_diff(b) < LEVEL_BAND {
        LEAD_LEVEL
    } else if a > b {
        LEAD_SEAT_0
    } else {
        LEAD_SEAT_1
    }
}

/// Winning seat of two final equities, or `DRAW` when they are equal.
pub fn winner(equity: [u64; 2]) -> u8 {
    match equity[0].cmp(&equity[1]) {
        core::cmp::Ordering::Greater => 0,
        core::cmp::Ordering::Less => 1,
        core::cmp::Ordering::Equal => DRAW,
    }
}

/// Liquidation price of the open position in oracle (mid) terms, for display and tests. `None`
/// when flat or when the position cannot be liquidated by price alone.
pub fn liquidation_mid(book: &Book) -> Option<u64> {
    if book.side == SIDE_FLAT || book.notional == 0 {
        return None;
    }
    // value(p) = margin + notional*(exit-entry)/entry (long) <= maintenance
    // => exit moves by (margin - maintenance) / notional of entry.
    let maintenance = u128::from(book.notional)
        .checked_mul(u128::from(MAINTENANCE_BPS))?
        .checked_div(BPS)?;
    let room = u128::from(book.margin).checked_sub(maintenance)?;
    let entry = u128::from(book.entry);
    let delta = room
        .checked_mul(entry)?
        .checked_div(u128::from(book.notional))?;
    let exit = if book.side == SIDE_LONG {
        entry.checked_sub(delta)?
    } else {
        entry.checked_add(delta)?
    };
    // Undo the closing spread.
    let spread = u128::from(SPREAD_BPS);
    let mid = if book.side == SIDE_LONG {
        exit.checked_mul(BPS)?.checked_div(BPS - spread)?
    } else {
        exit.checked_mul(BPS)?.checked_div(BPS + spread)?
    };
    u64::try_from(mid).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: u64 = 100_00000000; // $100

    fn book() -> Book {
        Book::default()
    }

    #[test]
    fn spread_moves_fills_against_the_player() {
        assert_eq!(fill_price(P, true).unwrap(), P + P * 5 / 10_000);
        assert_eq!(fill_price(P, false).unwrap(), P - P * 5 / 10_000);
        assert_eq!(fill_price(0, true), Err(EngineError::BadPrice));
        // buying rounds up, selling rounds down
        assert_eq!(fill_price(3, true).unwrap(), 4);
        assert_eq!(fill_price(3, false).unwrap(), 2);
        assert!(fill_price(u64::MAX, true).is_err());
    }

    #[test]
    fn a_round_trip_at_a_flat_price_costs_the_spread() {
        let mut b = book();
        open(&mut b, SIDE_LONG, 1_000, 10, P, 1).unwrap();
        assert_eq!(b.cash, 9_000);
        assert_eq!(b.notional, 10_000);
        let p = close(&mut b, P, 2, FILL_CLOSE).unwrap();
        assert!(p < 0);
        // 10 bps of a 10,000 notional is 10 Chips, rounded away from zero
        assert_eq!(p, -10);
        assert_eq!(b.cash, 9_990);
        assert_eq!(b.side, SIDE_FLAT);
    }

    #[test]
    fn long_gains_and_short_loses_when_price_rises() {
        let mut l = book();
        let mut s = book();
        open(&mut l, SIDE_LONG, 2_000, 5, P, 0).unwrap();
        open(&mut s, SIDE_SHORT, 2_000, 5, P, 0).unwrap();
        let up = P + P / 100; // +1%
        let pl = close(&mut l, up, 1, FILL_CLOSE).unwrap();
        let ps = close(&mut s, up, 1, FILL_CLOSE).unwrap();
        assert!(pl > 0 && ps < 0);
        // 10,000 notional * ~0.9% = ~90 either way (spread shaves both)
        assert!((80..100).contains(&pl), "{pl}");
        assert!((-120..-100).contains(&ps), "{ps}");
    }

    #[test]
    fn leverage_and_margin_bounds() {
        let mut b = book();
        assert_eq!(
            open(&mut b, SIDE_LONG, 1_000, 0, P, 0),
            Err(EngineError::InvalidLeverage)
        );
        assert_eq!(
            open(&mut b, SIDE_LONG, 1_000, 21, P, 0),
            Err(EngineError::InvalidLeverage)
        );
        assert_eq!(
            open(&mut b, SIDE_LONG, 99, 5, P, 0),
            Err(EngineError::MarginTooSmall)
        );
        assert_eq!(
            open(&mut b, SIDE_LONG, 10_001, 5, P, 0),
            Err(EngineError::NotEnoughChips)
        );
        assert_eq!(
            open(&mut b, 0, 1_000, 5, P, 0),
            Err(EngineError::InvalidSide)
        );
        assert_eq!(
            open(&mut b, 3, 1_000, 5, P, 0),
            Err(EngineError::InvalidSide)
        );
        open(&mut b, SIDE_LONG, 10_000, 20, P, 0).unwrap();
        assert_eq!(b.notional, 200_000);
        assert_eq!(b.cash, 0);
        assert_eq!(
            open(&mut b, SIDE_SHORT, 100, 1, P, 0),
            Err(EngineError::PositionOpen)
        );
        assert_eq!(b.trades, 1);
    }

    #[test]
    fn closing_nothing_is_an_error() {
        assert_eq!(
            close(&mut book(), P, 0, FILL_CLOSE),
            Err(EngineError::NoPosition)
        );
    }

    #[test]
    fn liquidation_triggers_at_maintenance_and_caps_the_loss() {
        let mut b = book();
        open(&mut b, SIDE_LONG, 1_000, 20, P, 0).unwrap();
        // 20x: margin 1,000 on 20,000 notional, maintenance 100. Down 4% -> pnl -800, value 200.
        assert!(!liquidate_if_due(&mut b, P * 96 / 100, 1).unwrap());
        // Down 4.6% -> value well under maintenance.
        let crash = P * 954 / 1000;
        assert!(liquidate_if_due(&mut b, crash, 2).unwrap());
        assert_eq!(b.side, SIDE_FLAT);
        assert_eq!(b.liquidations, 1);
        assert!(b.cash < 9_000 + 100 && b.cash >= 9_000);
        let last = b.fills[(b.fill_count as usize - 1) % FILL_LOG];
        assert_eq!(last.kind, FILL_LIQUIDATED);
        // A gap far past zero equity loses the margin and no more.
        let mut g = book();
        open(&mut g, SIDE_LONG, 1_000, 20, P, 0).unwrap();
        assert!(liquidate_if_due(&mut g, P / 2, 1).unwrap());
        assert_eq!(g.cash, 9_000);
    }

    #[test]
    fn short_liquidates_on_a_rise() {
        let mut b = book();
        open(&mut b, SIDE_SHORT, 500, 10, P, 0).unwrap();
        assert!(!liquidate_if_due(&mut b, P * 105 / 100, 1).unwrap());
        assert!(liquidate_if_due(&mut b, P * 1_100 / 1_000, 2).unwrap());
    }

    #[test]
    fn liquidation_mid_matches_the_trigger() {
        for (side, lev) in [
            (SIDE_LONG, 20u8),
            (SIDE_LONG, 5),
            (SIDE_SHORT, 10),
            (SIDE_SHORT, 2),
        ] {
            let mut b = book();
            open(&mut b, side, 1_000, lev, P, 0).unwrap();
            let liq = liquidation_mid(&b).unwrap();
            let mut at = b.clone();
            let mut just_safe = b.clone();
            // a hair beyond the liquidation price liquidates, a hair inside does not
            let (beyond, inside) = if side == SIDE_LONG {
                (liq - liq / 1000, liq + liq / 1000)
            } else {
                (liq + liq / 1000, liq - liq / 1000)
            };
            assert!(
                liquidate_if_due(&mut at, beyond, 1).unwrap(),
                "{side} {lev}"
            );
            assert!(
                !liquidate_if_due(&mut just_safe, inside, 1).unwrap(),
                "{side} {lev}"
            );
        }
        assert!(liquidation_mid(&book()).is_none());
    }

    #[test]
    fn equity_marks_the_open_position_with_the_closing_spread() {
        let mut b = book();
        assert_eq!(equity(&b, P).unwrap(), START_CHIPS);
        open(&mut b, SIDE_LONG, 1_000, 10, P, 0).unwrap();
        // entry 5 bps above, mark 5 bps below: 10 bps of 10,000 notional
        assert_eq!(equity(&b, P).unwrap(), 9_990);
        let up = equity(&b, P + P / 10).unwrap();
        assert!(up > 10_900 && up < 11_000, "{up}");
    }

    #[test]
    fn lead_has_a_level_band() {
        assert_eq!(lead([10_000, 10_000]), LEAD_LEVEL);
        assert_eq!(lead([10_049, 10_000]), LEAD_LEVEL);
        assert_eq!(lead([10_050, 10_000]), LEAD_SEAT_0);
        assert_eq!(lead([10_000, 10_500]), LEAD_SEAT_1);
    }

    #[test]
    fn winner_is_the_higher_equity_and_equal_is_a_draw() {
        assert_eq!(winner([10_001, 10_000]), 0);
        assert_eq!(winner([9_000, 10_000]), 1);
        assert_eq!(winner([10_000, 10_000]), DRAW);
    }

    #[test]
    fn the_fill_log_wraps_but_counts_everything() {
        let mut b = book();
        for i in 0..(FILL_LOG as u32 + 10) {
            open(&mut b, SIDE_LONG, 100, 1, P, i).unwrap();
            close(&mut b, P, i, FILL_CLOSE).unwrap();
        }
        assert_eq!(b.fill_count as usize, 2 * (FILL_LOG + 10));
        assert_eq!(b.trades as usize, FILL_LOG + 10);
    }

    #[test]
    fn extreme_values_fail_instead_of_wrapping() {
        let mut b = book();
        b.cash = u64::MAX;
        assert!(open(&mut b, SIDE_LONG, u64::MAX, 20, P, 0).is_err());
        assert!(pnl(SIDE_LONG, u64::MAX, 1, u64::MAX).is_err());
    }
}

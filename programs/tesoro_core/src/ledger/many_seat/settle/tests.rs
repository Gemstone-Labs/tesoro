use super::*;
use crate::ledger::lifecycle::Terms;

/// Railcar's terms: Platform 2%, Studio 3% (Tesoro's own, a senior class).
fn terms(platform_bps: u16, studio_bps: u16) -> Terms {
    Terms {
        platform_bps,
        studio_bps,
        studio_owner: None,
        studio_priority: true,
    }
}

const LB: u16 = 100;

#[test]
fn the_worked_example_pays_to_the_gema() {
    // Ana refunded 350 of 500; Dee, Ben, Cy placed 60/25/15; Eve aboard at Impact.
    let p = plan_payout(500, 5, &[6000, 2500, 1500], 350, &terms(200, 300), LB).unwrap();
    assert_eq!(p.fees.iter().sum::<u64>(), 129);
    assert_eq!(p.fees, [44, 64, 21]);
    assert_eq!(p.forfeited, 650);
    assert_eq!(&p.won[..3], &[313, 130, 78]);
    assert!(p.won[3..].iter().all(|w| *w == 0));
    assert!(!p.fees_capped);
}

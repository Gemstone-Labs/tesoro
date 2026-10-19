use crate::*;

/// Solana's mirror of one vault's Treasury (`["treasury", eid, vault]`).
///
/// The vault Treasury balance rises with fees and refills and falls with Instant Redeem payouts and
/// withdrawals, so no only-growing number bounds it. Each Yield Report carries the balance, the
/// vault's cumulative Instant payouts (`paid_at_report`) and the block time (`report_time`), all read
/// at the same block. Payouts Solana has recorded (`instant_recorded`) that the vault had not paid yet
/// at that block are still to come out of that balance:
/// `available = balance - (instant_recorded - paid_at_report)`. A payout the vault cannot cover
/// reverts and waits, so a stale report can only delay a payout, never lose one.
#[account]
#[derive(InitSpace)]
pub struct VaultTreasury {
    pub eid: u32,
    pub peer_address: [u8; 32],
    /// Treasury balance from the newest Yield Report applied.
    pub balance: u128,
    /// The vault's cumulative Instant payouts carried by that same report.
    pub paid_at_report: u128,
    /// Instant Redeem payouts recorded on Solana for this vault, cumulative.
    pub instant_recorded: u128,
    /// Vault block time of that same report; 0 = none applied yet.
    pub report_time: u64,
    pub bump: u8,
}

impl VaultTreasury {
    pub fn available(&self) -> u128 {
        self.balance
            .saturating_sub(self.instant_recorded.saturating_sub(self.paid_at_report))
    }

    /// Takes a Yield Report's snapshot when it is not older than the one held, ordering by the vault's
    /// block time and then by cumulative Instant payouts (which only grow). Anyone can hand in any
    /// Position's stored snapshot (`sync_treasury`), so without this order an old snapshot could be
    /// replayed over a newer one. A Position that has no report (`report_time` 0) changes nothing.
    /// The same snapshot again is accepted and changes nothing.
    pub fn apply_report(&mut self, balance: u128, instant_paid: u128, report_time: u64) {
        if report_time == 0 {
            return;
        }
        if (report_time, instant_paid) >= (self.report_time, self.paid_at_report) {
            self.balance = balance;
            self.paid_at_report = instant_paid;
            self.report_time = report_time;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn treasury() -> VaultTreasury {
        VaultTreasury {
            eid: 1,
            peer_address: [0; 32],
            balance: 0,
            paid_at_report: 0,
            instant_recorded: 0,
            report_time: 0,
            bump: 0,
        }
    }

    #[test]
    fn available_is_the_balance_less_payouts_the_vault_has_not_paid_yet() {
        let mut t = treasury();
        t.apply_report(1_000, 0, 10);
        assert_eq!(t.available(), 1_000);
        t.instant_recorded = 400; // recorded on Solana, not paid by the vault yet
        assert_eq!(t.available(), 600);
        // The vault pays 400 and reports: balance 600, paid 400, nothing outstanding.
        t.apply_report(600, 400, 20);
        assert_eq!(t.available(), 600);
        t.instant_recorded = 500; // 100 more recorded
        assert_eq!(t.available(), 500);
    }

    #[test]
    fn an_older_report_delivered_late_is_ignored() {
        let mut t = treasury();
        t.apply_report(600, 400, 20);
        t.apply_report(1_000, 0, 10); // older time and lower paid
        t.apply_report(1_000, 450, 15); // older time, higher paid: still older
        assert_eq!((t.balance, t.paid_at_report, t.report_time), (600, 400, 20));
    }

    #[test]
    fn a_withdrawal_report_is_taken_at_a_later_time_with_the_same_paid() {
        let mut t = treasury();
        t.apply_report(1_000, 0, 10);
        t.apply_report(300, 0, 20); // withdrawTreasury: lower balance, same instantPaid
        assert_eq!(t.available(), 300);
    }

    #[test]
    fn replaying_an_old_snapshot_over_a_fresh_one_is_refused() {
        let mut t = treasury();
        t.apply_report(0, 0, 10); // an old Position snapshot: empty Treasury
        t.apply_report(5_000, 0, 30); // fresh, after a refill
        for _ in 0..3 {
            t.apply_report(0, 0, 10); // replayed again and again
        }
        assert_eq!(t.available(), 5_000);
        // And the reverse after a withdrawal.
        t.apply_report(100, 0, 40);
        t.apply_report(5_000, 0, 30);
        assert_eq!(t.available(), 100);
    }

    #[test]
    fn a_position_with_no_report_never_changes_the_mirror() {
        let mut t = treasury();
        t.apply_report(700, 50, 10);
        t.apply_report(0, 0, 0);
        assert_eq!((t.balance, t.paid_at_report, t.report_time), (700, 50, 10));
    }

    #[test]
    fn the_same_snapshot_again_is_idempotent() {
        let mut t = treasury();
        t.apply_report(700, 50, 10);
        t.apply_report(700, 50, 10);
        assert_eq!((t.balance, t.paid_at_report, t.report_time), (700, 50, 10));
    }

    #[test]
    fn outstanding_payouts_never_underflow() {
        let mut t = treasury();
        t.apply_report(100, 50, 10);
        t.instant_recorded = 20; // below paid_at_report (a fresh mirror of an older vault)
        assert_eq!(t.available(), 100);
        t.instant_recorded = 500;
        assert_eq!(t.available(), 0);
    }
}

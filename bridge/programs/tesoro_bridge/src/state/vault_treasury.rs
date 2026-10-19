use crate::*;

/// Solana's mirror of one vault's Treasury (`["treasury", eid, vault]`).
///
/// The vault Treasury balance rises with fees and refills and falls with Instant Redeem payouts and
/// withdrawals, so no only-growing number bounds it. Each Yield Report carries the balance and the
/// vault's cumulative Instant payouts (`paid_at_report`) read at the same block. Payouts Solana has
/// recorded (`instant_recorded`) that the vault had not paid yet at that block are still to come out of
/// that balance: `available = balance - (instant_recorded - paid_at_report)`. A payout the vault
/// cannot cover reverts and waits, so a stale report can only delay a payout, never lose one.
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
    pub bump: u8,
}

impl VaultTreasury {
    pub fn available(&self) -> u128 {
        self.balance
            .saturating_sub(self.instant_recorded.saturating_sub(self.paid_at_report))
    }

    /// Takes a Yield Report's pair when it is not older than the one held. The vault's cumulative
    /// Instant payouts only grow, so a lower `instant_paid` is an older report; at equal
    /// `instant_paid` the later arrival wins (a withdrawal or a refill moves the balance).
    pub fn apply_report(&mut self, balance: u128, instant_paid: u128) {
        if instant_paid >= self.paid_at_report {
            self.balance = balance;
            self.paid_at_report = instant_paid;
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
            bump: 0,
        }
    }

    #[test]
    fn available_is_the_balance_less_payouts_the_vault_has_not_paid_yet() {
        let mut t = treasury();
        t.apply_report(1_000, 0);
        assert_eq!(t.available(), 1_000);
        t.instant_recorded = 400; // recorded on Solana, not paid by the vault yet
        assert_eq!(t.available(), 600);
        // The vault pays 400 and reports: balance 600, paid 400, nothing outstanding.
        t.apply_report(600, 400);
        assert_eq!(t.available(), 600);
        t.instant_recorded = 500; // 100 more recorded
        assert_eq!(t.available(), 500);
    }

    #[test]
    fn a_report_with_lower_instant_paid_is_ignored() {
        let mut t = treasury();
        t.apply_report(600, 400);
        t.apply_report(1_000, 0); // older report, delivered late
        assert_eq!((t.balance, t.paid_at_report), (600, 400));
    }

    #[test]
    fn a_withdrawal_lowers_availability_at_equal_instant_paid() {
        let mut t = treasury();
        t.apply_report(1_000, 0);
        t.apply_report(300, 0); // withdrawTreasury: lower balance, same instantPaid
        assert_eq!(t.available(), 300);
    }

    #[test]
    fn outstanding_payouts_never_underflow() {
        let mut t = treasury();
        t.apply_report(100, 50);
        t.instant_recorded = 20; // below paid_at_report (a fresh mirror of an older vault)
        assert_eq!(t.available(), 100);
        t.instant_recorded = 500;
        assert_eq!(t.available(), 0);
    }
}

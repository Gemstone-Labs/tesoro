use crate::*;

/// Solana's mirror of one vault's treasury (`["treasury", eid, vault]`). `reported_in` is the
/// highest cumulative treasury credit the vault reported in a YieldAccrued message; it only grows
/// and can only lag the vault, and nothing but Instant Redeem spends the vault's treasury. So an
/// Instant Redeem is accepted only while `instant_recorded + payout <= reported_in`: the vault can
/// then always pay it, whatever order the messages arrive in.
#[account]
#[derive(InitSpace)]
pub struct VaultTreasury {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub reported_in: u128,
    /// Instant Redeem payouts recorded on Solana for this vault, cumulative.
    pub instant_recorded: u128,
    pub bump: u8,
}

impl VaultTreasury {
    pub fn available(&self) -> u128 {
        self.reported_in.saturating_sub(self.instant_recorded)
    }

    pub fn raise(&mut self, reported: u128) {
        self.reported_in = self.reported_in.max(reported);
    }
}

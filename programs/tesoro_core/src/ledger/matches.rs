//! Fee terms of a Match: what each Game snapshots when a Match opens (platform, Studio, Leaderboard).

use super::*;
use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct FeeTerms {
    pub platform_bps: u16,
    pub studio_bps: u16,
    pub platform_recipient: Key,
    pub studio_recipient: Key,
}

impl FeeTerms {
    pub fn validate(&self) -> CoreResult<()> {
        let total = (self.platform_bps as u32) + (self.studio_bps as u32);
        if total > MAX_TOTAL_FEE_BPS as u32 {
            return Err(CoreError::FeeTooHigh);
        }
        Ok(())
    }
}

/// The Leaderboard Fee: a share of the Pot of every Match, paid into the pool Account. Read from
/// `Config` when the Match settles (not snapshotted in the Match, whose layout is fixed), so a
/// rate of 0 or no pool means no fee. Taken after the Platform and Studio Fees.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LeaderboardTerms {
    pub bps: u16,
    pub recipient: Key,
}

impl LeaderboardTerms {
    /// All three fees together may not exceed `MAX_TOTAL_FEE_BPS` of the Pot.
    pub fn validate(&self, fees: &FeeTerms) -> CoreResult<()> {
        let total = (fees.platform_bps as u32) + (fees.studio_bps as u32) + (self.bps as u32);
        if total > MAX_TOTAL_FEE_BPS as u32 {
            return Err(CoreError::FeeTooHigh);
        }
        Ok(())
    }
}

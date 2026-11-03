use crate::*;

/// The most of a payout any Delivery Fee may take, in basis points. A program constant: no admin
/// setting can raise it, so an admin can never take more than a tenth of what a Player receives.
pub const DELIVERY_CEILING_BPS: u16 = 1_000;
const BPS: u128 = 10_000;

/// A vault's Delivery Fee terms (`["delivery", eid, vault]`). The fee is flat, in the vault's base
/// units, and pays for the LayerZero send the sponsor relayer makes in SOL. It is snapshotted at
/// redeem time (`Claim.delivery_fee`), so a change here reaches new Redeems only.
#[account]
#[derive(InitSpace)]
pub struct DeliveryTerms {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub bump: u8,
    /// The flat fee charged per message.
    pub delivery_fee: u128,
    /// Absolute cap on the fee.
    pub max_abs: u128,
    /// Smallest Redeem (vault units) that is accepted, so a fee always leaves the Player a share.
    pub min_redeem: u128,
    /// Percentage cap for Unlock and PayInstant.
    pub max_bps_unlock: u16,
    /// Percentage cap for PayYield.
    pub max_bps_yield: u16,
    /// Smallest prize cash-out in Gemas (the prize's vault value is only known on the vault).
    pub min_prize_gemas: u64,
}

impl DeliveryTerms {
    /// The fee for a payout of `payout` vault units: the flat fee, held under the absolute cap and
    /// under `bps` of the payout (never above the program ceiling).
    pub fn fee_for(&self, payout: u128, bps: u16) -> u128 {
        let bps = u128::from(bps.min(DELIVERY_CEILING_BPS));
        let relative = payout.saturating_mul(bps) / BPS;
        self.delivery_fee.min(self.max_abs).min(relative)
    }

    pub fn require_min_redeem(&self, vault_units: u128) -> Result<()> {
        require!(vault_units >= self.min_redeem, BridgeError::BelowMinimumRedeem);
        Ok(())
    }

    pub fn require_min_prize(&self, gemas: u64) -> Result<()> {
        require!(gemas >= self.min_prize_gemas, BridgeError::BelowMinimumRedeem);
        Ok(())
    }

    /// Settings an admin may store: caps within the ceiling, and a minimum Redeem large enough
    /// that the flat fee fits under both percentage caps.
    pub fn validate(&self) -> Result<()> {
        require!(
            self.max_bps_unlock <= DELIVERY_CEILING_BPS && self.max_bps_yield <= DELIVERY_CEILING_BPS,
            BridgeError::DeliveryTermsInvalid
        );
        require!(self.delivery_fee <= self.max_abs, BridgeError::DeliveryTermsInvalid);
        if self.delivery_fee > 0 {
            for bps in [self.max_bps_unlock, self.max_bps_yield] {
                require!(bps > 0, BridgeError::DeliveryTermsInvalid);
                let fits = self.min_redeem.checked_mul(u128::from(bps)).is_some_and(|v| {
                    v / BPS >= self.delivery_fee
                });
                require!(fits, BridgeError::DeliveryTermsInvalid);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 0.0000153 ETH flat, 3 USD-ish cap, 2% / 10%, minimum Redeem 0.001 ETH.
    fn terms() -> DeliveryTerms {
        DeliveryTerms {
            eid: 40449,
            peer_address: [1; 32],
            bump: 255,
            delivery_fee: 15_300_000_000_000,
            max_abs: 1_000_000_000_000_000,
            min_redeem: 1_000_000_000_000_000,
            max_bps_unlock: 200,
            max_bps_yield: 1_000,
            min_prize_gemas: 5_000,
        }
    }

    #[test]
    fn ana_redeeming_one_eth_of_yield_pays_the_flat_fee() {
        assert_eq!(terms().fee_for(10u128.pow(18), 1_000), 15_300_000_000_000);
    }

    #[test]
    fn a_small_payout_shrinks_the_fee_to_its_percentage_cap() {
        // 0.0001 ETH at 2%: 0.000002 ETH, below the flat fee.
        assert_eq!(terms().fee_for(100_000_000_000_000, 200), 2_000_000_000_000);
    }

    #[test]
    fn the_absolute_cap_holds_the_fee_down() {
        let mut t = terms();
        t.max_abs = 1_000;
        t.delivery_fee = 1_000;
        t.min_redeem = 0;
        assert_eq!(t.fee_for(10u128.pow(18), 200), 1_000);
        t.delivery_fee = 5_000; // raised past the cap in a bad write
        assert_eq!(t.fee_for(10u128.pow(18), 200), 1_000);
    }

    #[test]
    fn no_setting_gets_past_the_program_ceiling() {
        let mut t = terms();
        t.delivery_fee = u128::MAX;
        t.max_abs = u128::MAX;
        // An admin bps of 100% is read as the 10% ceiling.
        assert_eq!(t.fee_for(1_000_000, 10_000), 100_000);
    }

    #[test]
    fn a_huge_payout_does_not_overflow() {
        assert_eq!(terms().fee_for(u128::MAX, 1_000), terms().delivery_fee);
    }

    #[test]
    fn a_redeem_below_the_minimum_is_refused() {
        let t = terms();
        assert!(t.require_min_redeem(t.min_redeem - 1).is_err());
        assert!(t.require_min_redeem(t.min_redeem).is_ok());
        assert!(t.require_min_prize(4_999).is_err());
        assert!(t.require_min_prize(5_000).is_ok());
    }

    #[test]
    fn stored_terms_must_sit_under_the_ceiling_and_leave_the_player_a_share() {
        assert!(terms().validate().is_ok());
        let mut t = terms();
        t.max_bps_yield = 1_001;
        assert!(t.validate().is_err(), "above the ceiling");
        let mut t = terms();
        t.min_redeem = 1_000_000_000_000; // 0.000001 ETH: 2% is below the fee
        assert!(t.validate().is_err(), "the fee would be clamped on the smallest Redeem");
        let mut t = terms();
        t.delivery_fee = t.max_abs + 1;
        assert!(t.validate().is_err(), "fee above its own cap");
        let mut t = terms();
        t.delivery_fee = 0;
        t.min_redeem = 0;
        assert!(t.validate().is_ok(), "a free delivery is allowed");
    }
}

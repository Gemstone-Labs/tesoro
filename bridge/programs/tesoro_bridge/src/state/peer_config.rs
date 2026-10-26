use crate::*;

pub const ENFORCED_OPTIONS_SEND_MAX_LEN: usize = 256;

/// Decimals tesoro_core sees for every bridged asset. Vaults speak in the asset's own base unit
/// (wei, 18 decimals); the bridge turns that into 9-decimal units for core (floor) and back
/// (exact multiply), so no EVM amount can pass `u64` (about 18.4 billion tokens in 9 decimals).
pub const CORE_DECIMALS: u8 = 9;

/// One PeerConfig per (remote eid, vault address): the only senders accepted from that chain,
/// the per-vault asset terms used when a Position is opened, and the enforced send options used
/// when sending to it. Its existence authorises the vault.
#[account]
#[derive(InitSpace)]
pub struct PeerConfig {
    pub peer_address: [u8; 32],
    /// Decimals of the vault's source asset (the underlying unit reported in messages). Fixed once
    /// set: `set_peer_config` refuses to change it, because every unit conversion derives from it.
    pub decimals: u8,
    /// Provider annual rate in basis points, used to size an Advance (`open_position` input).
    pub rate_bps: u16,
    #[max_len(ENFORCED_OPTIONS_SEND_MAX_LEN)]
    pub enforced_send_options: Vec<u8>,
    pub bump: u8,
}

impl PeerConfig {
    /// Decimals tesoro_core uses for this vault's amounts: the asset's own when it has 9 or fewer.
    pub fn core_decimals(&self) -> u8 {
        self.decimals.min(CORE_DECIMALS)
    }

    /// Vault base units per core unit: `10^(decimals - core_decimals)`.
    pub fn scale(&self) -> Result<u128> {
        10u128
            .checked_pow(u32::from(self.decimals - self.core_decimals()))
            .ok_or_else(|| error!(BridgeError::AmountOverflow))
    }

    /// A vault amount in core units, rounded down: the Player is credited at most what the vault
    /// reported, and a cumulative figure stays monotonic.
    pub fn to_units(&self, vault_amount: u128) -> Result<u128> {
        Ok(vault_amount / self.scale()?)
    }

    /// `to_units` for amounts core holds as `u64`; fails past `u64::MAX` core units.
    pub fn to_core_u64(&self, vault_amount: u128) -> Result<u64> {
        u64::try_from(self.to_units(vault_amount)?).map_err(|_| error!(BridgeError::AmountOverflow))
    }

    /// Core units as vault base units, exact: what the vault is told to pay.
    pub fn to_vault(&self, units: u64) -> Result<u128> {
        u128::from(units)
            .checked_mul(self.scale()?)
            .ok_or_else(|| error!(BridgeError::AmountOverflow))
    }

    pub fn combine_options(&self, extra_options: &[u8]) -> Result<Vec<u8>> {
        oapp::options::combine_options(self.enforced_send_options.clone(), &extra_options.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(decimals: u8) -> PeerConfig {
        PeerConfig {
            peer_address: [1; 32],
            decimals,
            rate_bps: 500,
            enforced_send_options: vec![],
            bump: 255,
        }
    }

    const GWEI: u128 = 1_000_000_000;
    /// The recorded devnet P2 accrued yield that overflowed u64 (wei).
    const P2_ACCRUED: u128 = 24_330_777_777_777_777_778;

    #[test]
    fn an_18_decimal_vault_reaches_core_as_9_decimal_units() {
        let p = peer(18);
        assert_eq!((p.core_decimals(), p.scale().unwrap()), (9, GWEI));
        assert_eq!(peer(9).scale().unwrap(), 1);
        assert_eq!(peer(6).scale().unwrap(), 1);
        assert_eq!((peer(6).core_decimals(), peer(9).core_decimals()), (6, 9));
    }

    #[test]
    fn the_wei_figures_that_overflowed_u64_now_fit() {
        let p = peer(18);
        let max = u128::from(u64::MAX);
        for wei in [max - 1, max, max + 1, P2_ACCRUED, 1_000 * 10u128.pow(18)] {
            let units = p.to_core_u64(wei).expect("fits core's u64");
            assert_eq!(u128::from(units), wei / GWEI);
        }
        assert_eq!(p.to_core_u64(max + 1).unwrap(), 18_446_744_073);
        assert_eq!(p.to_core_u64(P2_ACCRUED).unwrap(), 24_330_777_777);
        assert_eq!(p.to_core_u64(1_000 * 10u128.pow(18)).unwrap(), 1_000_000_000_000);
    }

    #[test]
    fn rounding_never_credits_more_than_the_vault_reported() {
        let p = peer(18);
        for wei in [0, 1, GWEI - 1, GWEI, GWEI + 1, 3 * GWEI - 1, P2_ACCRUED] {
            let units = p.to_core_u64(wei).unwrap();
            let back = p.to_vault(units).unwrap();
            assert!(back <= wei, "{wei}: paying {back} back is more than reported");
            assert!(wei - back < GWEI, "{wei}: at most one unit of dust stays in the vault");
        }
        // Whole units come back exactly: what the vault is asked to pay is what core owes.
        for units in [0u64, 1, 667, u64::MAX] {
            assert_eq!(p.to_core_u64(p.to_vault(units).unwrap()).unwrap(), units);
        }
    }

    #[test]
    fn a_cumulative_report_never_goes_down_when_the_vault_figure_grows() {
        let p = peer(18);
        let mut last = 0;
        for wei in (0..5_000u128).map(|i| i * 777_777_777) {
            let units = p.to_core_u64(wei).unwrap();
            assert!(units >= last);
            last = units;
        }
    }

    #[test]
    fn what_cannot_fit_core_is_refused_not_truncated() {
        let p = peer(18);
        let too_big = (u128::from(u64::MAX) + 1) * GWEI;
        assert!(p.to_core_u64(too_big).is_err());
        assert!(p.to_core_u64(too_big - 1).is_ok());
        assert!(peer(9).to_core_u64(u128::from(u64::MAX) + 1).is_err());
        assert!(peer(18).to_vault(u64::MAX).is_ok());
    }

    #[test]
    fn fee_and_pool_keep_their_ratio_to_the_amount_when_scaled() {
        let p = peer(18);
        // 20% Yield Fee on 3,333 units: core's remainder rule gives the vault fee 667.
        let (amount, fee, pool) = (3_333u64, 667u64, 333u64);
        let (a, f, q) =
            (p.to_vault(amount).unwrap(), p.to_vault(fee).unwrap(), p.to_vault(pool).unwrap());
        assert_eq!(f * 10_000 > a * 2_000, fee * 10_000 > amount * 2_000);
        assert!(q <= a);
        assert_eq!(a - f, p.to_vault(amount - fee).unwrap());
    }
}

//! Reads a USD price from a Pyth `PriceUpdateV2` account (ADR 0011): the sponsored push feeds the
//! Pyth receiver program owns on Solana mainnet (shard 0). Pure over bytes so it is unit tested.
//!
//! Layout (Borsh, after the 8-byte Anchor discriminator): `write_authority` 32, `verification_level`
//! (`Full` = tag 1, one byte; `Partial` = tag 0 + one byte), then the `PriceFeedMessage`: `feed_id`
//! 32, `price` i64, `conf` u64, `exponent` i32, `publish_time` i64, `prev_publish_time` i64,
//! `ema_price` i64, `ema_conf` u64, then `posted_slot` u64. A fully verified account is 134 bytes.

use anchor_lang::prelude::*;

/// The Pyth receiver program that owns `PriceUpdateV2` accounts.
pub const PYTH_RECEIVER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/// Anchor discriminator of `PriceUpdateV2`.
pub const PRICE_UPDATE_V2: [u8; 8] = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];
/// Length of a `PriceUpdateV2` with `VerificationLevel::Full`.
pub const PRICE_UPDATE_V2_LEN: usize = 134;
/// The oldest an Advance price may be, however the admin sets the feed's own limit.
pub const MAX_ONCHAIN_PRICE_AGE_SECS: u32 = 120;
/// The widest confidence interval an Advance price may carry, share of the price in basis points.
pub const MAX_ONCHAIN_CONF_BPS: u16 = 500;
/// A feed time this far ahead of the cluster clock is tolerated (clock skew), no further.
pub const MAX_FUTURE_SECS: i64 = 10;

#[derive(Debug, PartialEq, Eq)]
pub enum PythError {
    /// Wrong length, discriminator, verification level, feed id or exponent.
    BadFeed,
    Stale,
    LowConfidence,
}

/// USD per whole unit of the asset in micro-USD, floored, from the account image `data`.
/// `feed_id` is the id the admin mapped to the asset; `max_age_secs` and `max_conf_bps` are
/// clamped to the program's own limits.
pub fn read_micro_usd(
    data: &[u8],
    feed_id: &[u8; 32],
    now: i64,
    max_age_secs: u32,
    max_conf_bps: u16,
) -> core::result::Result<u64, PythError> {
    if data.len() != PRICE_UPDATE_V2_LEN
        || data[0..8] != PRICE_UPDATE_V2
        || data[40] != 1
        || data[41..73] != feed_id[..]
    {
        return Err(PythError::BadFeed);
    }
    let price = i64::from_le_bytes(data[73..81].try_into().map_err(|_| PythError::BadFeed)?);
    let conf = u64::from_le_bytes(data[81..89].try_into().map_err(|_| PythError::BadFeed)?);
    let exponent = i32::from_le_bytes(data[89..93].try_into().map_err(|_| PythError::BadFeed)?);
    let published = i64::from_le_bytes(data[93..101].try_into().map_err(|_| PythError::BadFeed)?);
    if price <= 0 || !(-12..=0).contains(&exponent) {
        return Err(PythError::BadFeed);
    }
    let price = price as u64;
    let max_age = max_age_secs.min(MAX_ONCHAIN_PRICE_AGE_SECS) as i64;
    let age = now.checked_sub(published).ok_or(PythError::Stale)?;
    if !(-MAX_FUTURE_SECS..=max_age).contains(&age) {
        return Err(PythError::Stale);
    }
    let max_conf = max_conf_bps.min(MAX_ONCHAIN_CONF_BPS) as u128;
    if (conf as u128) * 10_000 > (price as u128) * max_conf {
        return Err(PythError::LowConfidence);
    }
    // price * 10^exponent USD = price * 10^(exponent + 6) micro-USD.
    let shift = exponent + 6;
    let micro = if shift >= 0 {
        (price as u128).checked_mul(10u128.pow(shift as u32))
    } else {
        Some(price as u128 / 10u128.pow((-shift) as u32))
    }
    .and_then(|v| u64::try_from(v).ok())
    .ok_or(PythError::BadFeed)?;
    if micro == 0 {
        return Err(PythError::BadFeed);
    }
    Ok(micro)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: [u8; 32] = [7; 32];

    fn image(price: i64, conf: u64, expo: i32, published: i64) -> Vec<u8> {
        let mut d = vec![0u8; PRICE_UPDATE_V2_LEN];
        d[0..8].copy_from_slice(&PRICE_UPDATE_V2);
        d[40] = 1;
        d[41..73].copy_from_slice(&ID);
        d[73..81].copy_from_slice(&price.to_le_bytes());
        d[81..89].copy_from_slice(&conf.to_le_bytes());
        d[89..93].copy_from_slice(&expo.to_le_bytes());
        d[93..101].copy_from_slice(&published.to_le_bytes());
        d
    }

    #[test]
    fn converts_the_exponent_to_micro_usd() {
        // $103.22918088 with exponent -8 is 103,229,180 micro-USD, floored.
        let d = image(10_322_918_088, 3_356_136, -8, 1_000);
        assert_eq!(read_micro_usd(&d, &ID, 1_050, 120, 100), Ok(103_229_180));
        let d = image(150, 0, 0, 1_000);
        assert_eq!(read_micro_usd(&d, &ID, 1_000, 120, 100), Ok(150_000_000));
        let d = image(1_500_000_000_000, 0, -10, 1_000);
        assert_eq!(read_micro_usd(&d, &ID, 1_000, 120, 100), Ok(150_000_000));
    }

    #[test]
    fn refuses_what_is_not_a_fresh_confident_full_update() {
        let ok = image(10_000_000_000, 1_000_000, -8, 1_000);
        assert!(read_micro_usd(&ok, &ID, 1_060, 120, 100).is_ok());
        assert_eq!(
            read_micro_usd(&ok, &ID, 1_121, 120, 100),
            Err(PythError::Stale)
        );
        assert_eq!(
            read_micro_usd(&ok, &ID, 1_061, 60, 100),
            Err(PythError::Stale)
        );
        // The program's own cap wins over a looser admin setting.
        assert_eq!(
            read_micro_usd(&ok, &ID, 1_200, u32::MAX, 100),
            Err(PythError::Stale)
        );
        assert_eq!(
            read_micro_usd(&ok, &ID, 980, 120, 100),
            Err(PythError::Stale)
        );
        assert_eq!(
            read_micro_usd(&ok, &[8; 32], 1_000, 120, 100),
            Err(PythError::BadFeed)
        );
        let wide = image(10_000_000_000, 200_000_001, -8, 1_000);
        assert_eq!(
            read_micro_usd(&wide, &ID, 1_000, 120, 200),
            Err(PythError::LowConfidence)
        );
        assert!(read_micro_usd(&wide, &ID, 1_000, 120, 300).is_ok());
        let mut partial = ok.clone();
        partial[40] = 0;
        assert_eq!(
            read_micro_usd(&partial, &ID, 1_000, 120, 100),
            Err(PythError::BadFeed)
        );
        assert_eq!(
            read_micro_usd(&ok[..133], &ID, 1_000, 120, 100),
            Err(PythError::BadFeed)
        );
        assert_eq!(
            read_micro_usd(&image(0, 0, -8, 1_000), &ID, 1_000, 120, 100),
            Err(PythError::BadFeed)
        );
        assert_eq!(
            read_micro_usd(&image(-5, 0, -8, 1_000), &ID, 1_000, 120, 100),
            Err(PythError::BadFeed)
        );
    }
}

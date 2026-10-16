//! Reading an SPL stake pool account (jitoSOL and its kin): the pure helpers ticket 41 builds the
//! mainnet Staking Rate on. Not wired to any instruction yet.

use super::*;

/// The `StakePool` account type byte of the SPL stake pool program.
pub const STAKE_POOL_ACCOUNT_TYPE: u8 = 1;
/// Byte offsets in a `StakePool` account (borsh layout, no discriminator): the type byte, five
/// keys and a bump byte come before `pool_mint`; `total_lamports` and `pool_token_supply` follow
/// the manager fee account and the token program id.
const POOL_MINT_OFFSET: usize = 1 + 32 * 3 + 1 + 32 * 2;
const TOTAL_LAMPORTS_OFFSET: usize = POOL_MINT_OFFSET + 32 * 3;
const POOL_SUPPLY_OFFSET: usize = TOTAL_LAMPORTS_OFFSET + 8;
const STAKE_POOL_MIN_LEN: usize = POOL_SUPPLY_OFFSET + 8;

/// What a Position needs from a stake pool account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StakePoolRead {
    pub pool_mint: Key,
    pub total_lamports: u64,
    pub pool_token_supply: u64,
}

/// Reads the pool mint, the lamports under management and the pool token supply out of the data of
/// an initialised `StakePool` account.
pub fn parse_stake_pool(data: &[u8]) -> CoreResult<StakePoolRead> {
    if data.len() < STAKE_POOL_MIN_LEN || data[0] != STAKE_POOL_ACCOUNT_TYPE {
        return Err(CoreError::BadStakePool);
    }
    let key = |at: usize| -> Key { data[at..at + 32].try_into().expect("32 bytes") };
    let word = |at: usize| u64::from_le_bytes(data[at..at + 8].try_into().expect("8 bytes"));
    Ok(StakePoolRead {
        pool_mint: key(POOL_MINT_OFFSET),
        total_lamports: word(TOTAL_LAMPORTS_OFFSET),
        pool_token_supply: word(POOL_SUPPLY_OFFSET),
    })
}

/// SOL base units per pool token, 1e9 fixed point (`RATE_SCALE`), rounded down: the pool's
/// exchange rate `total_lamports / pool_token_supply`. A pool with no tokens or no lamports has no
/// rate.
pub fn stake_pool_rate(total_lamports: u64, pool_token_supply: u64) -> CoreResult<u64> {
    if pool_token_supply == 0 || total_lamports == 0 {
        return Err(CoreError::BadStakePool);
    }
    let rate = to_u64(mul_div_floor(
        total_lamports as u128,
        RATE_SCALE,
        pool_token_supply as u128,
    )?)?;
    if rate == 0 {
        return Err(CoreError::BadStakePool);
    }
    Ok(rate)
}

#[cfg(test)]
mod stake_pool_tests {
    use super::*;

    /// A `StakePool` account's bytes with the fields the program reads set.
    pub fn pool_bytes(mint: Key, total: u64, supply: u64) -> Vec<u8> {
        let mut data = vec![0u8; 400];
        data[0] = STAKE_POOL_ACCOUNT_TYPE;
        data[POOL_MINT_OFFSET..POOL_MINT_OFFSET + 32].copy_from_slice(&mint);
        data[TOTAL_LAMPORTS_OFFSET..TOTAL_LAMPORTS_OFFSET + 8]
            .copy_from_slice(&total.to_le_bytes());
        data[POOL_SUPPLY_OFFSET..POOL_SUPPLY_OFFSET + 8].copy_from_slice(&supply.to_le_bytes());
        data
    }

    #[test]
    fn the_layout_offsets_match_the_spl_stake_pool_account() {
        // type(1) manager staker deposit_authority(3x32) bump(1) validator_list reserve(2x32)
        // pool_mint(32) manager_fee token_program(2x32) total_lamports(8) supply(8).
        assert_eq!(POOL_MINT_OFFSET, 162);
        assert_eq!(TOTAL_LAMPORTS_OFFSET, 258);
        assert_eq!(POOL_SUPPLY_OFFSET, 266);
    }

    #[test]
    fn a_stake_pool_account_is_read_for_its_mint_and_balances() {
        let read = parse_stake_pool(&pool_bytes([7; 32], 1_300, 1_000)).unwrap();
        assert_eq!(
            read,
            StakePoolRead {
                pool_mint: [7; 32],
                total_lamports: 1_300,
                pool_token_supply: 1_000
            }
        );
    }

    #[test]
    fn data_that_is_not_an_initialised_stake_pool_is_refused() {
        let mut data = pool_bytes([7; 32], 1, 1);
        data[0] = 2; // a validator list
        assert_eq!(parse_stake_pool(&data), Err(CoreError::BadStakePool));
        data[0] = 0;
        assert_eq!(parse_stake_pool(&data), Err(CoreError::BadStakePool));
        assert_eq!(parse_stake_pool(&data[..200]), Err(CoreError::BadStakePool));
    }

    #[test]
    fn the_rate_is_lamports_per_pool_token_and_needs_both_sides() {
        assert_eq!(
            stake_pool_rate(1_300_000_000, 1_000_000_000),
            Ok(1_300_000_000)
        );
        assert_eq!(stake_pool_rate(5, 3), Ok(1_666_666_666));
        assert_eq!(stake_pool_rate(5, 0), Err(CoreError::BadStakePool));
        assert_eq!(stake_pool_rate(0, 5), Err(CoreError::BadStakePool));
    }
}

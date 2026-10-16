//! Reading an SPL stake pool account (jitoSOL and its kin): the mainnet Staking Rate of ADR 0011
//! comes from here. The account is read inside each instruction that needs a Position's growth,
//! so nothing is cranked or published.

use super::*;

/// The `StakePool` account type byte of the SPL stake pool program.
pub const STAKE_POOL_ACCOUNT_TYPE: u8 = 1;
/// Byte offsets in a `StakePool` account (borsh layout, no discriminator): the type byte, five
/// keys and a bump byte come before `pool_mint`; `total_lamports`, `pool_token_supply` and
/// `last_update_epoch` follow the manager fee account and the token program id.
const POOL_MINT_OFFSET: usize = 1 + 32 * 3 + 1 + 32 * 2;
const TOTAL_LAMPORTS_OFFSET: usize = POOL_MINT_OFFSET + 32 * 3;
const POOL_SUPPLY_OFFSET: usize = TOTAL_LAMPORTS_OFFSET + 8;
const LAST_UPDATE_EPOCH_OFFSET: usize = POOL_SUPPLY_OFFSET + 8;
/// `lockup` (i64, u64, key) then `epoch_fee` (two u64); the optional fields start after.
const AFTER_EPOCH_FEE: usize = LAST_UPDATE_EPOCH_OFFSET + 8 + 48 + 16;

/// What a Position needs from a stake pool account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StakePoolRead {
    pub pool_mint: Key,
    pub total_lamports: u64,
    pub pool_token_supply: u64,
    /// Epoch of the last `UpdateStakePoolBalance`: how fresh `total_lamports` is.
    pub last_update_epoch: u64,
    /// The pool's totals as of the update before the latest one: with the current totals they give
    /// one epoch of growth. Zero for a pool that has not yet rolled an epoch.
    pub last_epoch_total_lamports: u64,
    pub last_epoch_pool_token_supply: u64,
}

/// A bounds-checked cursor over the borsh bytes.
struct Cursor<'a> {
    data: &'a [u8],
    at: usize,
}

impl Cursor<'_> {
    fn take(&mut self, n: usize) -> CoreResult<&[u8]> {
        let end = self.at.checked_add(n).ok_or(CoreError::BadStakePool)?;
        let out = self.data.get(self.at..end).ok_or(CoreError::BadStakePool)?;
        self.at = end;
        Ok(out)
    }
    fn byte(&mut self) -> CoreResult<u8> {
        Ok(self.take(1)?[0])
    }
    fn word(&mut self) -> CoreResult<u64> {
        Ok(u64::from_le_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| CoreError::BadStakePool)?,
        ))
    }
    /// An `Option<Pubkey>`: a tag byte, then 32 bytes when set.
    fn skip_option_key(&mut self) -> CoreResult<()> {
        match self.byte()? {
            0 => Ok(()),
            1 => self.take(32).map(|_| ()),
            _ => Err(CoreError::BadStakePool),
        }
    }
    /// A `FutureEpoch<Fee>`: tag 0 (none), or 1 / 2 followed by a 16-byte fee.
    fn skip_future_fee(&mut self) -> CoreResult<()> {
        match self.byte()? {
            0 => Ok(()),
            1 | 2 => self.take(16).map(|_| ()),
            _ => Err(CoreError::BadStakePool),
        }
    }
}

/// Reads the pool mint, the lamports under management, the pool token supply, the update epoch
/// and the previous epoch's totals out of the data of an initialised `StakePool` account. The
/// fields between `epoch_fee` and the previous epoch's totals hold optional values, so they are
/// walked rather than addressed.
pub fn parse_stake_pool(data: &[u8]) -> CoreResult<StakePoolRead> {
    if data.len() < AFTER_EPOCH_FEE || data[0] != STAKE_POOL_ACCOUNT_TYPE {
        return Err(CoreError::BadStakePool);
    }
    let key = |at: usize| -> Key { data[at..at + 32].try_into().expect("32 bytes") };
    let word = |at: usize| u64::from_le_bytes(data[at..at + 8].try_into().expect("8 bytes"));
    let mut c = Cursor {
        data,
        at: AFTER_EPOCH_FEE,
    };
    c.skip_future_fee()?; // next_epoch_fee
    c.skip_option_key()?; // preferred_deposit_validator_vote_address
    c.skip_option_key()?; // preferred_withdraw_validator_vote_address
    c.take(32)?; // stake_deposit_fee, stake_withdrawal_fee
    c.skip_future_fee()?; // next_stake_withdrawal_fee
    c.take(1)?; // stake_referral_fee
    c.skip_option_key()?; // sol_deposit_authority
    c.take(17)?; // sol_deposit_fee, sol_referral_fee
    c.skip_option_key()?; // sol_withdraw_authority
    c.take(16)?; // sol_withdrawal_fee
    c.skip_future_fee()?; // next_sol_withdrawal_fee
    let last_epoch_pool_token_supply = c.word()?;
    let last_epoch_total_lamports = c.word()?;
    Ok(StakePoolRead {
        pool_mint: key(POOL_MINT_OFFSET),
        total_lamports: word(TOTAL_LAMPORTS_OFFSET),
        pool_token_supply: word(POOL_SUPPLY_OFFSET),
        last_update_epoch: word(LAST_UPDATE_EPOCH_OFFSET),
        last_epoch_total_lamports,
        last_epoch_pool_token_supply,
    })
}

#[cfg(test)]
mod stake_pool_tests {
    use super::*;

    const JITO_POOL: &[u8] = include_bytes!("../../tests/fixtures/jito_pool.bin");
    const JITO_MINT: &str = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

    /// A `StakePool` account's bytes with the fields the program reads set, every optional unset.
    pub fn pool_bytes(mint: Key, total: u64, supply: u64) -> Vec<u8> {
        let mut data = vec![0u8; 611];
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
        // pool_mint(32) manager_fee token_program(2x32) total_lamports(8) supply(8) epoch(8).
        assert_eq!(POOL_MINT_OFFSET, 162);
        assert_eq!(TOTAL_LAMPORTS_OFFSET, 258);
        assert_eq!(POOL_SUPPLY_OFFSET, 266);
        assert_eq!(LAST_UPDATE_EPOCH_OFFSET, 274);
    }

    #[test]
    fn the_live_jitosol_pool_is_read_in_full() {
        let read = parse_stake_pool(JITO_POOL).unwrap();
        let mint = bs58_decode(JITO_MINT);
        assert_eq!(read.pool_mint, mint);
        assert_eq!(read.total_lamports, 10_475_185_838_136_915);
        assert_eq!(read.pool_token_supply, 8_018_218_559_544_148);
        assert_eq!(read.last_update_epoch, 1058);
        assert_eq!(read.last_epoch_pool_token_supply, 8_013_714_481_593_944);
        assert_eq!(read.last_epoch_total_lamports, 10_467_917_186_112_723);
    }

    fn bs58_decode(s: &str) -> Key {
        // Minimal base58 for the test: 32-byte keys only.
        const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        let mut out = [0u8; 32];
        for ch in s.bytes() {
            let mut carry = ALPHABET.iter().position(|c| *c == ch).unwrap() as u32;
            for b in out.iter_mut().rev() {
                carry += (*b as u32) * 58;
                *b = (carry & 0xff) as u8;
                carry >>= 8;
            }
            assert_eq!(carry, 0);
        }
        out
    }

    #[test]
    fn a_stake_pool_account_is_read_for_its_mint_and_balances() {
        let read = parse_stake_pool(&pool_bytes([7; 32], 1_300, 1_000)).unwrap();
        assert_eq!(read.pool_mint, [7; 32]);
        assert_eq!(
            (read.total_lamports, read.pool_token_supply),
            (1_300, 1_000)
        );
        assert_eq!(read.last_epoch_total_lamports, 0);
    }

    #[test]
    fn optional_fields_move_the_previous_epoch_totals() {
        // A next epoch fee (tag 1 + 16), a preferred deposit validator (tag 1 + 32), a sol deposit
        // authority and a next sol withdrawal fee all widen the walk.
        let mut d = pool_bytes([7; 32], 1_300, 1_000);
        let mut tail = Vec::new();
        tail.push(1);
        tail.extend([0u8; 16]); // next_epoch_fee
        tail.push(1);
        tail.extend([5u8; 32]); // preferred deposit
        tail.push(0); // preferred withdraw
        tail.extend([0u8; 32]); // stake fees
        tail.push(2);
        tail.extend([0u8; 16]); // next_stake_withdrawal_fee
        tail.push(0); // referral
        tail.push(1);
        tail.extend([6u8; 32]); // sol deposit authority
        tail.extend([0u8; 17]); // sol deposit fee + referral
        tail.push(0); // sol withdraw authority
        tail.extend([0u8; 16]); // sol withdrawal fee
        tail.push(1);
        tail.extend([0u8; 16]); // next sol withdrawal fee
        tail.extend(900u64.to_le_bytes());
        tail.extend(1_150u64.to_le_bytes());
        d.truncate(AFTER_EPOCH_FEE);
        d.extend(tail);
        let read = parse_stake_pool(&d).unwrap();
        assert_eq!(read.last_epoch_pool_token_supply, 900);
        assert_eq!(read.last_epoch_total_lamports, 1_150);
        assert_eq!(read.total_lamports, 1_300);
    }

    #[test]
    fn data_that_is_not_an_initialised_stake_pool_is_refused() {
        let mut data = pool_bytes([7; 32], 1, 1);
        data[0] = 2; // a validator list
        assert_eq!(parse_stake_pool(&data), Err(CoreError::BadStakePool));
        data[0] = 0;
        assert_eq!(parse_stake_pool(&data), Err(CoreError::BadStakePool));
        assert_eq!(parse_stake_pool(&data[..200]), Err(CoreError::BadStakePool));
        // Cut inside the optional walk.
        let good = pool_bytes([7; 32], 1, 1);
        assert_eq!(
            parse_stake_pool(&good[..AFTER_EPOCH_FEE + 60]),
            Err(CoreError::BadStakePool)
        );
        // A bad option tag.
        let mut bad = pool_bytes([7; 32], 1, 1);
        bad[AFTER_EPOCH_FEE] = 9;
        assert_eq!(parse_stake_pool(&bad), Err(CoreError::BadStakePool));
    }
}

use anchor_lang::prelude::*;

use crate::errors::BridgeError;

// Fixed-width wire format shared with `PositionVaultOApp.sol` (`abi.encodePacked`, big-endian).
//
// Header (45 bytes):
//   msg_type     u8
//   source_chain u32   LayerZero eid of the chain the Position lives on
//   position_id  [u8; 32]   vault address (20 bytes) | vault position id u64 BE | 4 zero bytes
//   seq          u64   monotonic per Position and direction, starts at 1
//
// Bodies:
//   1 PositionLocked (EVM -> Solana): owner [32] | asset [32] | principal u128 | horizon u8
//   2 YieldAccrued   (EVM -> Solana): cumulative u128 | treasury_balance u128 | instant_paid u128 | report_time u64
//   3 Unlock         (Solana -> EVM): amount u128 (always 0)
//   4 PayYield       (Solana -> EVM): to [32] | amount u128
//   5 PayInstant     (Solana -> EVM): to [32] | amount u128   paid from the vault's treasury
//
// `cumulative` is the Position's accrued yield net of the Yield Fee; `treasury_balance` is what the
// vault's treasury can pay now (it falls with Instant Redeem payouts and withdrawals); `instant_paid`
// is the vault's cumulative Instant Redeem payouts at that same block; `report_time` is that block's
// timestamp, which orders snapshots of the vault Treasury.
pub const HEADER_LEN: usize = 1 + 4 + 32 + 8;
pub const LOCKED_LEN: usize = HEADER_LEN + 32 + 32 + 16 + 1;
pub const YIELD_LEN: usize = HEADER_LEN + 16 + 16 + 16 + 8;
pub const UNLOCK_LEN: usize = HEADER_LEN + 16;
pub const PAY_YIELD_LEN: usize = HEADER_LEN + 32 + 16;
pub const PAY_INSTANT_LEN: usize = PAY_YIELD_LEN;

pub const MSG_POSITION_LOCKED: u8 = 1;
pub const MSG_YIELD_ACCRUED: u8 = 2;
pub const MSG_UNLOCK: u8 = 3;
pub const MSG_PAY_YIELD: u8 = 4;
pub const MSG_PAY_INSTANT: u8 = 5;

#[derive(Debug, PartialEq, Eq)]
pub struct Header {
    pub msg_type: u8,
    pub source_chain: u32,
    pub position_id: [u8; 32],
    pub seq: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Inbound {
    Locked { owner: [u8; 32], asset: [u8; 32], principal: u128, horizon: u8 },
    Yield { cumulative: u128, treasury_balance: u128, instant_paid: u128, report_time: u64 },
}

pub fn encode_header(h: &Header, buf: &mut Vec<u8>) {
    buf.push(h.msg_type);
    buf.extend_from_slice(&h.source_chain.to_be_bytes());
    buf.extend_from_slice(&h.position_id);
    buf.extend_from_slice(&h.seq.to_be_bytes());
}

pub fn encode_unlock(source_chain: u32, position_id: [u8; 32], seq: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(UNLOCK_LEN);
    encode_header(&Header { msg_type: MSG_UNLOCK, source_chain, position_id, seq }, &mut buf);
    buf.extend_from_slice(&0u128.to_be_bytes());
    buf
}

pub fn encode_pay_yield(
    source_chain: u32,
    position_id: [u8; 32],
    seq: u64,
    to: [u8; 32],
    amount: u128,
) -> Vec<u8> {
    encode_payment(MSG_PAY_YIELD, source_chain, position_id, seq, to, amount)
}

pub fn encode_pay_instant(
    source_chain: u32,
    position_id: [u8; 32],
    seq: u64,
    to: [u8; 32],
    amount: u128,
) -> Vec<u8> {
    encode_payment(MSG_PAY_INSTANT, source_chain, position_id, seq, to, amount)
}

fn encode_payment(
    msg_type: u8,
    source_chain: u32,
    position_id: [u8; 32],
    seq: u64,
    to: [u8; 32],
    amount: u128,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(PAY_YIELD_LEN);
    encode_header(&Header { msg_type, source_chain, position_id, seq }, &mut buf);
    buf.extend_from_slice(&to);
    buf.extend_from_slice(&amount.to_be_bytes());
    buf
}

/// Left-pads a 20-byte EVM address into a 32-byte word.
pub fn pad_address(address: &[u8; 20]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(address);
    out
}

/// The 20-byte address in a 32-byte word, or `None` when the upper 12 bytes are not zero.
pub fn unpad_address(word: &[u8; 32]) -> Option<[u8; 20]> {
    if word[..12].iter().any(|b| *b != 0) {
        return None;
    }
    let mut out = [0u8; 20];
    out.copy_from_slice(&word[12..]);
    Some(out)
}

pub fn decode_inbound(buf: &[u8]) -> Result<(Header, Inbound)> {
    require!(buf.len() >= HEADER_LEN, BridgeError::InvalidMessageLength);
    let header = Header {
        msg_type: buf[0],
        source_chain: u32::from_be_bytes(read(buf, 1)?),
        position_id: read(buf, 5)?,
        seq: u64::from_be_bytes(read(buf, 37)?),
    };
    require!(header.seq > 0, BridgeError::InvalidSeq);
    let body = match header.msg_type {
        MSG_POSITION_LOCKED => {
            require!(buf.len() == LOCKED_LEN, BridgeError::InvalidMessageLength);
            Inbound::Locked {
                owner: read(buf, HEADER_LEN)?,
                asset: read(buf, HEADER_LEN + 32)?,
                principal: u128::from_be_bytes(read(buf, HEADER_LEN + 64)?),
                horizon: buf[HEADER_LEN + 80],
            }
        },
        MSG_YIELD_ACCRUED => {
            require!(buf.len() == YIELD_LEN, BridgeError::InvalidMessageLength);
            Inbound::Yield {
                cumulative: u128::from_be_bytes(read(buf, HEADER_LEN)?),
                treasury_balance: u128::from_be_bytes(read(buf, HEADER_LEN + 16)?),
                instant_paid: u128::from_be_bytes(read(buf, HEADER_LEN + 32)?),
                report_time: u64::from_be_bytes(read(buf, HEADER_LEN + 48)?),
            }
        },
        _ => return err!(BridgeError::InvalidMessageType),
    };
    Ok((header, body))
}

// Used in account seed constraints, which cannot return a decode error: short messages map to
// zeros here and are rejected by `decode_inbound` before any state changes.
pub fn position_id_or_zero(buf: &[u8]) -> [u8; 32] {
    read(buf, 5).unwrap_or([0u8; 32])
}

fn read<const N: usize>(buf: &[u8], offset: usize) -> Result<[u8; N]> {
    let end = offset.checked_add(N).ok_or(BridgeError::InvalidMessageLength)?;
    buf.get(offset..end)
        .and_then(|s| <[u8; N]>::try_from(s).ok())
        .ok_or_else(|| BridgeError::InvalidMessageLength.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locked(seq: u64) -> Vec<u8> {
        let mut buf = Vec::new();
        encode_header(
            &Header {
                msg_type: MSG_POSITION_LOCKED,
                source_chain: 40449,
                position_id: [7u8; 32],
                seq,
            },
            &mut buf,
        );
        buf.extend_from_slice(&pad_address(&[0xAA; 20]));
        buf.extend_from_slice(&pad_address(&[0xBB; 20]));
        buf.extend_from_slice(&1_000_000_000_000_000_000u128.to_be_bytes());
        buf.push(3);
        buf
    }

    #[test]
    fn decodes_position_locked() {
        let bytes = locked(1);
        assert_eq!(bytes.len(), LOCKED_LEN);
        let (h, body) = decode_inbound(&bytes).unwrap();
        assert_eq!(h.source_chain, 40449);
        assert_eq!(h.seq, 1);
        assert_eq!(h.position_id, [7u8; 32]);
        assert_eq!(
            body,
            Inbound::Locked {
                owner: pad_address(&[0xAA; 20]),
                asset: pad_address(&[0xBB; 20]),
                principal: 1_000_000_000_000_000_000,
                horizon: 3
            }
        );
    }

    #[test]
    fn decodes_yield_accrued() {
        let mut buf = Vec::new();
        encode_header(
            &Header {
                msg_type: MSG_YIELD_ACCRUED,
                source_chain: 40362,
                position_id: [1; 32],
                seq: 9,
            },
            &mut buf,
        );
        buf.extend_from_slice(&123_456_789u128.to_be_bytes());
        buf.extend_from_slice(&42_000u128.to_be_bytes());
        buf.extend_from_slice(&7_000u128.to_be_bytes());
        buf.extend_from_slice(&1_760_000_000u64.to_be_bytes());
        assert_eq!(buf.len(), YIELD_LEN);
        assert_eq!(YIELD_LEN, 101);
        let (h, body) = decode_inbound(&buf).unwrap();
        assert_eq!(h.seq, 9);
        assert_eq!(
            body,
            Inbound::Yield {
                cumulative: 123_456_789,
                treasury_balance: 42_000,
                instant_paid: 7_000,
                report_time: 1_760_000_000
            }
        );
        // The 61-, 77- and 93-byte messages of older vaults are refused.
        assert!(decode_inbound(&buf[..HEADER_LEN + 16]).is_err());
        assert!(decode_inbound(&buf[..HEADER_LEN + 32]).is_err());
        assert!(decode_inbound(&buf[..HEADER_LEN + 48]).is_err());
    }

    #[test]
    fn rejects_bad_lengths_types_and_zero_seq() {
        assert!(decode_inbound(&[0u8; 10]).is_err());
        let mut b = locked(1);
        b.push(0);
        assert!(decode_inbound(&b).is_err());
        b.truncate(LOCKED_LEN - 1);
        assert!(decode_inbound(&b).is_err());
        assert!(decode_inbound(&locked(0)).is_err());
        let mut unlock = encode_unlock(40449, [1; 32], 1);
        assert_eq!(unlock.len(), UNLOCK_LEN);
        assert!(decode_inbound(&unlock).is_err(), "outbound types are not inbound");
        unlock[0] = 9;
        assert!(decode_inbound(&unlock).is_err());
    }

    #[test]
    fn outbound_layout_matches_the_solidity_side() {
        let pay = encode_pay_yield(40449, [2; 32], 5, pad_address(&[0xCC; 20]), 42);
        assert_eq!(pay.len(), PAY_YIELD_LEN);
        assert_eq!(pay[0], MSG_PAY_YIELD);
        assert_eq!(&pay[1..5], &40449u32.to_be_bytes());
        assert_eq!(&pay[37..45], &5u64.to_be_bytes());
        assert_eq!(&pay[45..77], &pad_address(&[0xCC; 20]));
        assert_eq!(&pay[77..93], &42u128.to_be_bytes());
    }

    #[test]
    fn pay_instant_layout_matches_the_solidity_side() {
        let pay = encode_pay_instant(40362, [3; 32], 7, pad_address(&[0xDD; 20]), 65);
        assert_eq!(pay.len(), PAY_INSTANT_LEN);
        assert_eq!(PAY_INSTANT_LEN, 93);
        assert_eq!(pay[0], MSG_PAY_INSTANT);
        assert_eq!(&pay[1..5], &40362u32.to_be_bytes());
        assert_eq!(&pay[5..37], &[3; 32]);
        assert_eq!(&pay[37..45], &7u64.to_be_bytes());
        assert_eq!(&pay[45..77], &pad_address(&[0xDD; 20]));
        assert_eq!(&pay[77..93], &65u128.to_be_bytes());
        // Outbound only: never accepted inbound.
        assert!(decode_inbound(&pay).is_err());
    }

    #[test]
    fn address_padding_roundtrips_and_rejects_dirty_words() {
        let a = [0x11u8; 20];
        assert_eq!(unpad_address(&pad_address(&a)), Some(a));
        let mut dirty = pad_address(&a);
        dirty[0] = 1;
        assert_eq!(unpad_address(&dirty), None);
    }
}

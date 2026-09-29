use anchor_lang::prelude::*;

use crate::errors::LzOAppError;

// Fixed-width wire format shared with the EVM side (`abi.encodePacked`):
//
//   msg_type     u8        1 = PositionLocked, 2 = YieldAccrued (EVM -> Solana)
//                          3 = Unlock, 4 = PayYield (Solana -> EVM)
//   source_chain u32 (BE)  LayerZero eid of the chain the Position lives on
//   position_id  bytes32
//   seq          u64 (BE)  monotonic per (source_chain, position_id, direction), starts at 1
//   amount       u128 (BE) source-asset units
pub const MESSAGE_LEN: usize = 1 + 4 + 32 + 8 + 16;

pub const MSG_POSITION_LOCKED: u8 = 1;
pub const MSG_YIELD_ACCRUED: u8 = 2;
pub const MSG_UNLOCK: u8 = 3;
pub const MSG_PAY_YIELD: u8 = 4;

pub struct PositionMessage {
    pub msg_type: u8,
    pub source_chain: u32,
    pub position_id: [u8; 32],
    pub seq: u64,
    pub amount: u128,
}

impl PositionMessage {
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(MESSAGE_LEN);
        buf.push(self.msg_type);
        buf.extend_from_slice(&self.source_chain.to_be_bytes());
        buf.extend_from_slice(&self.position_id);
        buf.extend_from_slice(&self.seq.to_be_bytes());
        buf.extend_from_slice(&self.amount.to_be_bytes());
        buf
    }

    pub fn decode(buf: &[u8]) -> Result<Self> {
        require!(buf.len() == MESSAGE_LEN, LzOAppError::InvalidMessageLength);
        let msg_type = buf[0];
        let source_chain = u32::from_be_bytes(read(buf, 1)?);
        let position_id: [u8; 32] = read(buf, 5)?;
        let seq = u64::from_be_bytes(read(buf, 37)?);
        let amount = u128::from_be_bytes(read(buf, 45)?);
        require!(seq > 0, LzOAppError::InvalidSeq);
        Ok(Self { msg_type, source_chain, position_id, seq, amount })
    }
}

// Used in account seed constraints, which cannot return a decode error: short messages map to
// zeros here and are rejected by `decode` before any state changes.
pub fn position_id_or_zero(buf: &[u8]) -> [u8; 32] {
    read(buf, 5).unwrap_or([0u8; 32])
}

fn read<const N: usize>(buf: &[u8], offset: usize) -> Result<[u8; N]> {
    let end = offset.checked_add(N).ok_or(LzOAppError::InvalidMessageLength)?;
    buf.get(offset..end)
        .and_then(|s| <[u8; N]>::try_from(s).ok())
        .ok_or_else(|| LzOAppError::InvalidMessageLength.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let m = PositionMessage {
            msg_type: MSG_YIELD_ACCRUED,
            source_chain: 40362,
            position_id: [7u8; 32],
            seq: 9,
            amount: 123_456_789_000_000_000_000,
        };
        let bytes = m.encode();
        assert_eq!(bytes.len(), MESSAGE_LEN);
        let d = PositionMessage::decode(&bytes).unwrap();
        assert_eq!(d.msg_type, m.msg_type);
        assert_eq!(d.source_chain, m.source_chain);
        assert_eq!(d.position_id, m.position_id);
        assert_eq!(d.seq, m.seq);
        assert_eq!(d.amount, m.amount);
    }

    #[test]
    fn rejects_bad_length_and_zero_seq() {
        assert!(PositionMessage::decode(&[0u8; 60]).is_err());
        assert!(PositionMessage::decode(&[0u8; 62]).is_err());
        assert!(PositionMessage::decode(&[0u8; MESSAGE_LEN]).is_err());
    }
}

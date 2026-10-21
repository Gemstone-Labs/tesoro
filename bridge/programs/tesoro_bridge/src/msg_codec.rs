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
// Route messages (6-9) concern the vault, not one Position. Their header is the same 45 bytes with
// `position_id` = the vault address (20 bytes) | 12 zero bytes and `seq` = the batch id (6, 8) or
// the payout id (7, 9), unique per vault; the vault keeps one persistent receipt per id.
//   6 CashInBatch    (Solana -> EVM): kind u8 | recipient [32] | n u8 | n x (vault position id u64 | units u128)
//   7 PayPrize       (Solana -> EVM): asset [32] | prize_source [32] | recipient [32] | shares u128
//   8 BatchResult    (EVM -> Solana): n u8 | n x paid_units u128 (cumulative per entry) | escrowed_shares u128 | escrowed_units u128
//   9 PayPrizeResult (EVM -> Solana): status u8 (1 paid, 2 rejected) | shares u128
// See economy-notes/bridge-messages.md for what the vault must guarantee for each.
//
// `cumulative` is the Position's accrued yield net of the Yield Fee; `treasury_balance` is what the
// vault's treasury can pay now (it falls with Instant Redeem payouts and withdrawals); `instant_paid`
// is the vault's cumulative Instant Redeem payouts at that same block; `report_time` is that block's
// timestamp, which orders snapshots of the vault Treasury.
pub const HEADER_LEN: usize = 1 + 4 + 32 + 8;
pub const LOCKED_LEN: usize = HEADER_LEN + 32 + 32 + 16 + 1;
/// The Yield Report of vaults without a prize escrow.
pub const YIELD_LEN_V1: usize = HEADER_LEN + 16 + 16 + 16 + 8;
/// The Yield Report of vaults with a prize escrow: V1 plus the escrow's cumulative inflow in
/// shares and in the Source asset's units at the time each share arrived.
pub const YIELD_LEN: usize = YIELD_LEN_V1 + 16 + 16;
pub const UNLOCK_LEN: usize = HEADER_LEN + 16;
pub const PAY_YIELD_LEN: usize = HEADER_LEN + 32 + 16;
pub const PAY_INSTANT_LEN: usize = PAY_YIELD_LEN;

pub const MSG_POSITION_LOCKED: u8 = 1;
pub const MSG_YIELD_ACCRUED: u8 = 2;
pub const MSG_UNLOCK: u8 = 3;
pub const MSG_PAY_YIELD: u8 = 4;
pub const MSG_PAY_INSTANT: u8 = 5;
pub const MSG_CASH_IN_BATCH: u8 = 6;
pub const MSG_PAY_PRIZE: u8 = 7;
pub const MSG_BATCH_RESULT: u8 = 8;
pub const MSG_PAY_PRIZE_RESULT: u8 = 9;

/// What a cash-in batch pays (`CashInBatch.kind`, also the core fee class).
#[cfg(test)]
pub const KIND_PLATFORM: u8 = 0;
pub const KIND_STUDIO: u8 = 1;
pub const KIND_LEADERBOARD: u8 = 2;
/// Entries per batch: bounds the message and the vault's gas.
pub const MAX_BATCH_ENTRIES: usize = 8;
pub const BATCH_FIXED_LEN: usize = HEADER_LEN + 1 + 32 + 1;
pub const BATCH_ENTRY_LEN: usize = 8 + 16;
pub const PAY_PRIZE_LEN: usize = HEADER_LEN + 32 + 32 + 32 + 16;
pub const PAY_PRIZE_RESULT_LEN: usize = HEADER_LEN + 1 + 16;
pub const PRIZE_PAID: u8 = 1;
pub const PRIZE_REJECTED: u8 = 2;

#[derive(Debug, PartialEq, Eq)]
pub struct Header {
    pub msg_type: u8,
    pub source_chain: u32,
    pub position_id: [u8; 32],
    pub seq: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Inbound {
    Locked {
        owner: [u8; 32],
        asset: [u8; 32],
        principal: u128,
        horizon: u8,
    },
    Yield {
        cumulative: u128,
        treasury_balance: u128,
        instant_paid: u128,
        report_time: u64,
        /// Zero from vaults without a prize escrow.
        escrowed_shares: u128,
        escrowed_units: u128,
    },
    BatchResult {
        paid: Vec<u128>,
        escrowed_shares: u128,
        escrowed_units: u128,
    },
    PayPrizeResult {
        status: u8,
        shares: u128,
    },
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

/// The header word of route messages: the vault address (20 bytes) then 12 zero bytes, the shape
/// of a Position id whose vault id and trailing bytes are all zero.
pub fn route_word(peer_address: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..20].copy_from_slice(&peer_address[12..]);
    out
}

pub struct BatchEntryWire {
    pub vault_position_id: u64,
    pub units: u128,
}

pub fn encode_cash_in_batch(
    source_chain: u32,
    peer_address: &[u8; 32],
    batch_id: u64,
    kind: u8,
    recipient: [u8; 32],
    entries: &[BatchEntryWire],
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(BATCH_FIXED_LEN + BATCH_ENTRY_LEN * entries.len());
    encode_header(
        &Header {
            msg_type: MSG_CASH_IN_BATCH,
            source_chain,
            position_id: route_word(peer_address),
            seq: batch_id,
        },
        &mut buf,
    );
    buf.push(kind);
    buf.extend_from_slice(&recipient);
    buf.push(entries.len() as u8);
    for e in entries {
        buf.extend_from_slice(&e.vault_position_id.to_be_bytes());
        buf.extend_from_slice(&e.units.to_be_bytes());
    }
    buf
}

#[allow(clippy::too_many_arguments)]
pub fn encode_pay_prize(
    source_chain: u32,
    peer_address: &[u8; 32],
    payout_id: u64,
    asset: [u8; 32],
    prize_source: [u8; 32],
    recipient: [u8; 32],
    shares: u128,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(PAY_PRIZE_LEN);
    encode_header(
        &Header {
            msg_type: MSG_PAY_PRIZE,
            source_chain,
            position_id: route_word(peer_address),
            seq: payout_id,
        },
        &mut buf,
    );
    buf.extend_from_slice(&asset);
    buf.extend_from_slice(&prize_source);
    buf.extend_from_slice(&recipient);
    buf.extend_from_slice(&shares.to_be_bytes());
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
            require!(
                buf.len() == YIELD_LEN || buf.len() == YIELD_LEN_V1,
                BridgeError::InvalidMessageLength
            );
            let with_escrow = buf.len() == YIELD_LEN;
            Inbound::Yield {
                cumulative: u128::from_be_bytes(read(buf, HEADER_LEN)?),
                treasury_balance: u128::from_be_bytes(read(buf, HEADER_LEN + 16)?),
                instant_paid: u128::from_be_bytes(read(buf, HEADER_LEN + 32)?),
                report_time: u64::from_be_bytes(read(buf, HEADER_LEN + 48)?),
                escrowed_shares: if with_escrow {
                    u128::from_be_bytes(read(buf, YIELD_LEN_V1)?)
                } else {
                    0
                },
                escrowed_units: if with_escrow {
                    u128::from_be_bytes(read(buf, YIELD_LEN_V1 + 16)?)
                } else {
                    0
                },
            }
        },
        MSG_BATCH_RESULT => {
            let n = usize::from(*buf.get(HEADER_LEN).ok_or(BridgeError::InvalidMessageLength)?);
            require!(
                (1..=MAX_BATCH_ENTRIES).contains(&n) && buf.len() == HEADER_LEN + 1 + 16 * n + 32,
                BridgeError::InvalidMessageLength
            );
            let mut paid = Vec::with_capacity(n);
            for i in 0..n {
                paid.push(u128::from_be_bytes(read(buf, HEADER_LEN + 1 + 16 * i)?));
            }
            let tail = HEADER_LEN + 1 + 16 * n;
            Inbound::BatchResult {
                paid,
                escrowed_shares: u128::from_be_bytes(read(buf, tail)?),
                escrowed_units: u128::from_be_bytes(read(buf, tail + 16)?),
            }
        },
        MSG_PAY_PRIZE_RESULT => {
            require!(buf.len() == PAY_PRIZE_RESULT_LEN, BridgeError::InvalidMessageLength);
            let status = buf[HEADER_LEN];
            require!(
                status == PRIZE_PAID || status == PRIZE_REJECTED,
                BridgeError::InvalidMessageType
            );
            Inbound::PayPrizeResult {
                status,
                shares: u128::from_be_bytes(read(buf, HEADER_LEN + 1)?),
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

    fn yield_report(seq: u64, escrow: Option<(u128, u128)>) -> Vec<u8> {
        let mut buf = Vec::new();
        encode_header(
            &Header { msg_type: MSG_YIELD_ACCRUED, source_chain: 40362, position_id: [1; 32], seq },
            &mut buf,
        );
        buf.extend_from_slice(&123_456_789u128.to_be_bytes());
        buf.extend_from_slice(&42_000u128.to_be_bytes());
        buf.extend_from_slice(&7_000u128.to_be_bytes());
        buf.extend_from_slice(&1_760_000_000u64.to_be_bytes());
        if let Some((shares, units)) = escrow {
            buf.extend_from_slice(&shares.to_be_bytes());
            buf.extend_from_slice(&units.to_be_bytes());
        }
        buf
    }

    #[test]
    fn decodes_yield_accrued_with_and_without_the_escrow_figures() {
        let old = yield_report(9, None);
        assert_eq!(old.len(), YIELD_LEN_V1);
        assert_eq!(YIELD_LEN_V1, 101);
        let (h, body) = decode_inbound(&old).unwrap();
        assert_eq!(h.seq, 9);
        assert_eq!(
            body,
            Inbound::Yield {
                cumulative: 123_456_789,
                treasury_balance: 42_000,
                instant_paid: 7_000,
                report_time: 1_760_000_000,
                escrowed_shares: 0,
                escrowed_units: 0,
            }
        );
        let new = yield_report(10, Some((5_000, 6_000)));
        assert_eq!(new.len(), YIELD_LEN);
        assert_eq!(YIELD_LEN, 133);
        let (_, body) = decode_inbound(&new).unwrap();
        assert_eq!(
            body,
            Inbound::Yield {
                cumulative: 123_456_789,
                treasury_balance: 42_000,
                instant_paid: 7_000,
                report_time: 1_760_000_000,
                escrowed_shares: 5_000,
                escrowed_units: 6_000,
            }
        );
        // The 61-, 77- and 93-byte messages of the oldest vaults, and a half-written escrow, are refused.
        assert!(decode_inbound(&old[..HEADER_LEN + 16]).is_err());
        assert!(decode_inbound(&old[..HEADER_LEN + 32]).is_err());
        assert!(decode_inbound(&old[..HEADER_LEN + 48]).is_err());
        assert!(decode_inbound(&new[..YIELD_LEN_V1 + 16]).is_err());
    }

    fn batch_result(id: u64, paid: &[u128], shares: u128, units: u128) -> Vec<u8> {
        let mut buf = Vec::new();
        encode_header(
            &Header {
                msg_type: MSG_BATCH_RESULT,
                source_chain: 40449,
                position_id: route_word(&pad_address(&[0x5b; 20])),
                seq: id,
            },
            &mut buf,
        );
        buf.push(paid.len() as u8);
        for p in paid {
            buf.extend_from_slice(&p.to_be_bytes());
        }
        buf.extend_from_slice(&shares.to_be_bytes());
        buf.extend_from_slice(&units.to_be_bytes());
        buf
    }

    #[test]
    fn decodes_batch_results_and_refuses_wrong_entry_counts() {
        let ok = batch_result(7, &[10, 0, 33], 900, 1_000);
        let (h, body) = decode_inbound(&ok).unwrap();
        assert_eq!(h.seq, 7);
        assert_eq!(
            body,
            Inbound::BatchResult {
                paid: vec![10, 0, 33],
                escrowed_shares: 900,
                escrowed_units: 1_000
            }
        );
        assert!(decode_inbound(&ok[..ok.len() - 1]).is_err(), "short");
        let mut long = ok.clone();
        long.push(0);
        assert!(decode_inbound(&long).is_err(), "long");
        let mut none = batch_result(7, &[1], 0, 0);
        none[HEADER_LEN] = 0;
        assert!(decode_inbound(&none).is_err(), "no entries");
        let many = batch_result(7, &[0; MAX_BATCH_ENTRIES + 1], 0, 0);
        assert!(decode_inbound(&many).is_err(), "more than a batch holds");
    }

    #[test]
    fn decodes_prize_results_and_refuses_unknown_statuses() {
        let mut buf = Vec::new();
        encode_header(
            &Header {
                msg_type: MSG_PAY_PRIZE_RESULT,
                source_chain: 40449,
                position_id: route_word(&pad_address(&[0x5b; 20])),
                seq: 3,
            },
            &mut buf,
        );
        buf.push(PRIZE_PAID);
        buf.extend_from_slice(&77u128.to_be_bytes());
        assert_eq!(buf.len(), PAY_PRIZE_RESULT_LEN);
        assert_eq!(
            decode_inbound(&buf).unwrap().1,
            Inbound::PayPrizeResult { status: PRIZE_PAID, shares: 77 }
        );
        buf[HEADER_LEN] = 0;
        assert!(decode_inbound(&buf).is_err());
        buf[HEADER_LEN] = 3;
        assert!(decode_inbound(&buf).is_err());
    }

    #[test]
    fn route_messages_match_the_solidity_side() {
        let vault = pad_address(&[0x5b; 20]);
        let word = route_word(&vault);
        assert_eq!(&word[..20], &[0x5b; 20]);
        assert!(word[20..].iter().all(|b| *b == 0));
        let batch = encode_cash_in_batch(
            40449,
            &vault,
            12,
            KIND_LEADERBOARD,
            [0; 32],
            &[
                BatchEntryWire { vault_position_id: 3, units: 500 },
                BatchEntryWire { vault_position_id: 9, units: 7 },
            ],
        );
        assert_eq!(batch.len(), BATCH_FIXED_LEN + 2 * BATCH_ENTRY_LEN);
        assert_eq!(batch[0], MSG_CASH_IN_BATCH);
        assert_eq!(&batch[1..5], &40449u32.to_be_bytes());
        assert_eq!(&batch[5..37], &word);
        assert_eq!(&batch[37..45], &12u64.to_be_bytes());
        assert_eq!(batch[45], KIND_LEADERBOARD);
        assert_eq!(batch[78], 2);
        assert_eq!(&batch[79..87], &3u64.to_be_bytes());
        assert_eq!(&batch[87..103], &500u128.to_be_bytes());
        assert_eq!(&batch[103..111], &9u64.to_be_bytes());
        let prize = encode_pay_prize(
            40449,
            &vault,
            4,
            pad_address(&[0xAB; 20]),
            [0x11; 32],
            pad_address(&[0xCC; 20]),
            42,
        );
        assert_eq!(prize.len(), PAY_PRIZE_LEN);
        assert_eq!(PAY_PRIZE_LEN, 157);
        assert_eq!(prize[0], MSG_PAY_PRIZE);
        assert_eq!(&prize[37..45], &4u64.to_be_bytes());
        assert_eq!(&prize[45..77], &pad_address(&[0xAB; 20]));
        assert_eq!(&prize[77..109], &[0x11; 32]);
        assert_eq!(&prize[109..141], &pad_address(&[0xCC; 20]));
        assert_eq!(&prize[141..157], &42u128.to_be_bytes());
        // Outbound only: never accepted inbound.
        assert!(decode_inbound(&batch).is_err());
        assert!(decode_inbound(&prize).is_err());
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

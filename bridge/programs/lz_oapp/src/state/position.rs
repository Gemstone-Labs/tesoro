use crate::*;

// One record per (home chain eid, position id). Inbound and outbound sequences are tracked
// independently so a handler can ignore replays and stale (out-of-order) messages.
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub source_chain: u32,
    pub position_id: [u8; 32],
    pub last_in_seq: u64,
    pub last_in_type: u8,
    pub last_in_amount: u128,
    pub last_out_seq: u64,
    pub last_out_type: u8,
    pub last_out_amount: u128,
    pub bump: u8,
}

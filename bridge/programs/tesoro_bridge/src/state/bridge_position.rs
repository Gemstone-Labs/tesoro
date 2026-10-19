use crate::*;

/// One record per (source chain eid, position id). It holds the inbound facts until they are
/// applied to tesoro_core (`apply_locked`, `apply_yield`) and the outbound sequence and flags that
/// stop a message from being sent twice. The record must exist before the first message: the
/// default Executors cap the native drop to Solana at 0, so nobody can fund rent inside
/// `lz_receive` (see `init_position`).
#[account]
#[derive(InitSpace)]
pub struct BridgePosition {
    pub eid: u32,
    pub position_id: [u8; 32],
    pub bump: u8,
    /// Highest inbound seq seen, informational.
    pub last_in_seq: u64,
    /// Seq of the PositionLocked message that filled the fields below; 0 = none yet.
    pub locked_seq: u64,
    pub owner_evm: [u8; 20],
    pub asset: [u8; 32],
    /// Principal in the vault's underlying units (wei).
    pub principal: u128,
    pub horizon_months: u8,
    /// True once tesoro_core has the Position.
    pub opened: bool,
    /// Latest YieldAccrued received (highest seq) and its cumulative amount (net of the Yield Fee).
    pub last_yield_seq: u64,
    pub yield_cumulative: u128,
    /// Seq of the YieldAccrued most recently applied to tesoro_core.
    pub applied_yield_seq: u64,
    /// Last outbound seq (Unlock and PayYield share one counter).
    pub out_seq: u64,
    pub unlock_sent: bool,
    /// The vault Treasury balance reported with the latest YieldAccrued.
    pub treasury_balance: u128,
    /// The vault's cumulative Instant payouts, reported with that same YieldAccrued.
    pub instant_paid: u128,
    /// Vault block time of that same YieldAccrued; 0 = no report yet. Last field.
    pub report_time: u64,
}

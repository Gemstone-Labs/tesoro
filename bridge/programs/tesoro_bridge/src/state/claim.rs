use crate::*;

/// A holder's redemption of Gemas of one bridged Source, recorded by `redeem_to_evm`. Seeds
/// `["claim", holder_account, source]`. `units_sent` follows `units_total` when `send_pay_yield`
/// sends the difference, so each redeemed unit is paid once.
#[account]
#[derive(InitSpace)]
pub struct Claim {
    pub holder_account: Pubkey,
    pub source: Pubkey,
    pub position: Pubkey,
    pub gemas_total: u64,
    /// Source-asset units redeemed through the bridge.
    pub units_total: u64,
    /// Source-asset units already sent in PayYield messages.
    pub units_sent: u64,
    pub bump: u8,
}

/// A holder's Instant Redeems of Gemas of one bridged Source, recorded by `instant_redeem_to_evm`.
/// Seeds `["instant", holder_account, source]`. Paid by the vault's treasury through
/// `send_pay_instant`; `units_sent` follows `units_total` so each unit is paid once.
#[account]
#[derive(InitSpace)]
pub struct InstantClaim {
    pub holder_account: Pubkey,
    pub source: Pubkey,
    pub position: Pubkey,
    pub gemas_total: u64,
    /// Source-asset units owed now (the Gemas' value less the Instant Redeem Fee).
    pub units_total: u64,
    pub units_sent: u64,
    pub bump: u8,
}

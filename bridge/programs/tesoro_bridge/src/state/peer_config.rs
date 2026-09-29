use crate::*;

pub const ENFORCED_OPTIONS_SEND_MAX_LEN: usize = 256;

/// One PeerConfig per (remote eid, vault address): the only senders accepted from that chain,
/// the per-vault asset terms used when a Position is opened, and the enforced send options used
/// when sending to it. Its existence authorises the vault.
#[account]
#[derive(InitSpace)]
pub struct PeerConfig {
    pub peer_address: [u8; 32],
    /// Decimals of the vault's source asset (the underlying unit reported in messages).
    pub decimals: u8,
    /// Provider annual rate in basis points, used to size an Advance (`open_position` input).
    pub rate_bps: u16,
    #[max_len(ENFORCED_OPTIONS_SEND_MAX_LEN)]
    pub enforced_send_options: Vec<u8>,
    pub bump: u8,
}

impl PeerConfig {
    pub fn combine_options(&self, extra_options: &[u8]) -> Result<Vec<u8>> {
        oapp::options::combine_options(self.enforced_send_options.clone(), &extra_options.to_vec())
    }
}

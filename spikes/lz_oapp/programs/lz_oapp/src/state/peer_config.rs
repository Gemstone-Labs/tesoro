use crate::*;

pub const ENFORCED_OPTIONS_SEND_MAX_LEN: usize = 256;

#[account]
#[derive(InitSpace)]
pub struct PeerConfig {
    pub peer_address: [u8; 32],
    #[max_len(ENFORCED_OPTIONS_SEND_MAX_LEN)]
    pub enforced_send_options: Vec<u8>,
    pub bump: u8,
}

impl PeerConfig {
    pub fn combine_options(&self, extra_options: &[u8]) -> Result<Vec<u8>> {
        oapp::options::combine_options(self.enforced_send_options.clone(), &extra_options.to_vec())
    }
}

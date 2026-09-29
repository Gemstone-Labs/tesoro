use crate::*;
use oapp::endpoint::{instructions::SendParams as EndpointSendParams, ID as ENDPOINT_ID};

/// Fee limits for one outbound message plus the Position it concerns.
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SendParams {
    pub eid: u32,
    pub position_id: [u8; 32],
    /// Extra options combined with the peer's enforced options (usually empty).
    pub options: Vec<u8>,
    pub native_fee: u64,
    pub lz_token_fee: u64,
}

/// Sends `message` to the vault `peer` through the LayerZero endpoint, signed by the Store PDA.
/// `remaining` are the endpoint's send accounts (payer at index 0, the Store at index 1).
pub fn lz_send(
    store: &Account<Store>,
    peer: &PeerConfig,
    remaining: &[AccountInfo],
    params: &SendParams,
    message: Vec<u8>,
) -> Result<()> {
    let seeds: &[&[u8]] = &[STORE_SEED, &[store.bump]];
    oapp::endpoint_cpi::send(
        ENDPOINT_ID,
        store.key(),
        remaining,
        seeds,
        EndpointSendParams {
            dst_eid: params.eid,
            receiver: peer.peer_address,
            message,
            options: peer.combine_options(&params.options)?,
            native_fee: params.native_fee,
            lz_token_fee: params.lz_token_fee,
        },
    )?;
    Ok(())
}

/// The next outbound seq for a Position.
pub fn next_out_seq(position: &mut BridgePosition) -> Result<u64> {
    let seq = position.out_seq.checked_add(1).ok_or(BridgeError::SeqOverflow)?;
    position.out_seq = seq;
    Ok(seq)
}

#[event]
pub struct MessageSent {
    pub dst_eid: u32,
    pub position_id: [u8; 32],
    pub msg_type: u8,
    pub seq: u64,
    pub amount: u128,
}

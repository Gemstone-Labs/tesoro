mod errors;
mod evm_sig;
mod instructions;
mod msg_codec;
mod state;

use anchor_lang::prelude::*;
use errors::BridgeError;
use instructions::*;
use oapp::{
    endpoint::MessagingFee,
    lz_receive_types_v2::{LzReceiveTypesV2Accounts, LzReceiveTypesV2Result},
    LzReceiveParams,
};
use state::*;

declare_id!("5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ");

// The Executor derives the LzReceiveTypes PDA with this exact seed.
const LZ_RECEIVE_TYPES_SEED: &[u8] = b"LzReceiveTypes";
const STORE_SEED: &[u8] = b"Store";
const PEER_SEED: &[u8] = b"Peer";
const POSITION_SEED: &[u8] = b"Position";
const AUTHORITY_SEED: &[u8] = b"authority";
const EVM_LINK_SEED: &[u8] = b"evm";
const CLAIM_SEED: &[u8] = b"claim";

/// LayerZero V2 testnet endpoint ids of the source chains, and the tesoro_core chain each maps to.
pub const EID_HOODI: u32 = 40449;
pub const EID_HYPEREVM_TESTNET: u32 = 40362;

/// Position ids carry the vault address in their first 20 bytes and 4 trailing zero bytes.
pub fn valid_position_id(id: &[u8; 32]) -> bool {
    id[28..].iter().all(|b| *b == 0)
}

/// The peer (vault) address on the source chain that owns a Position id, as a 32-byte word.
pub fn vault_of(id: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(&id[..20]);
    out
}

pub fn core_chain(eid: u32) -> Result<tesoro_core::ledger::SourceChain> {
    match eid {
        EID_HOODI => Ok(tesoro_core::ledger::SourceChain::Ethereum),
        EID_HYPEREVM_TESTNET => Ok(tesoro_core::ledger::SourceChain::HyperEvm),
        _ => err!(BridgeError::UnsupportedChain),
    }
}

/// The byte tesoro_core puts in Position PDA seeds for a chain.
pub fn core_chain_byte(eid: u32) -> Result<u8> {
    Ok(match core_chain(eid)? {
        tesoro_core::ledger::SourceChain::Solana => 0,
        tesoro_core::ledger::SourceChain::Ethereum => 1,
        tesoro_core::ledger::SourceChain::HyperEvm => 2,
    })
}

#[program]
pub mod tesoro_bridge {
    use super::*;

    // --- Admin ------------------------------------------------------------------------------

    pub fn init_store(mut ctx: Context<InitStore>, params: InitStoreParams) -> Result<()> {
        InitStore::apply(&mut ctx, &params)
    }

    pub fn set_peer_config(
        mut ctx: Context<SetPeerConfig>,
        params: SetPeerConfigParams,
    ) -> Result<()> {
        SetPeerConfig::apply(&mut ctx, &params)
    }

    // --- Identity ---------------------------------------------------------------------------

    pub fn link_evm(mut ctx: Context<LinkEvm>, params: LinkEvmParams) -> Result<()> {
        LinkEvm::apply(&mut ctx, &params)
    }

    // --- Inbound (source chain to tesoro_core) -----------------------------------------------

    pub fn init_position(mut ctx: Context<InitPosition>, params: PositionRef) -> Result<()> {
        InitPosition::apply(&mut ctx, &params)
    }

    pub fn lz_receive(mut ctx: Context<LzReceive>, params: LzReceiveParams) -> Result<()> {
        LzReceive::apply(&mut ctx, &params)
    }

    pub fn apply_locked(mut ctx: Context<ApplyLocked>, params: PositionRef) -> Result<()> {
        ApplyLocked::apply(&mut ctx, &params)
    }

    pub fn apply_yield(mut ctx: Context<ApplyYield>, params: PositionRef) -> Result<()> {
        ApplyYield::apply(&mut ctx, &params)
    }

    // --- Outbound (tesoro_core to source chain) ----------------------------------------------

    pub fn quote_send(ctx: Context<QuoteSend>, params: QuoteSendParams) -> Result<MessagingFee> {
        QuoteSend::apply(&ctx, &params)
    }

    pub fn send_unlock(mut ctx: Context<SendUnlock>, params: SendParams) -> Result<()> {
        SendUnlock::apply(&mut ctx, &params)
    }

    pub fn redeem_to_evm(mut ctx: Context<RedeemToEvm>, gemas: u64) -> Result<()> {
        RedeemToEvm::apply(&mut ctx, gemas)
    }

    pub fn send_pay_yield(mut ctx: Context<SendPayYield>, params: SendParams) -> Result<()> {
        SendPayYield::apply(&mut ctx, &params)
    }

    // --- Executor discovery ------------------------------------------------------------------

    pub fn lz_receive_types_v2(
        ctx: Context<LzReceiveTypesV2>,
        params: LzReceiveParams,
    ) -> Result<LzReceiveTypesV2Result> {
        LzReceiveTypesV2::apply(&ctx, &params)
    }

    pub fn lz_receive_types_info(
        ctx: Context<LzReceiveTypesInfo>,
        params: LzReceiveParams,
    ) -> Result<(u8, LzReceiveTypesV2Accounts)> {
        LzReceiveTypesInfo::apply(&ctx, &params)
    }
}

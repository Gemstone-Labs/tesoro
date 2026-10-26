mod errors;
mod evm_sig;
mod instructions;
mod msg_codec;
mod state;

#[cfg(test)]
mod flow_tests;
#[cfg(test)]
mod keeper_fixtures;

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
const INSTANT_SEED: &[u8] = b"instant";
const TREASURY_SEED: &[u8] = b"treasury";
const ROUTE_SEED: &[u8] = b"route";
const BATCH_SEED: &[u8] = b"batch";
const PAYOUT_SEED: &[u8] = b"payout";

/// LayerZero V2 endpoint ids of the source chains. The testnet ids serve test mode (Hoodi,
/// HyperEVM testnet), the mainnet ids the mainnet vaults; one bridge deployment only ever has the
/// vaults of its own cluster registered (`set_peer_config` is admin-only).
pub const EID_HOODI: u32 = 40449;
pub const EID_HYPEREVM_TESTNET: u32 = 40362;
pub const EID_ETHEREUM: u32 = 30101;
pub const EID_HYPEREVM: u32 = 30367;

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
        EID_HOODI | EID_ETHEREUM => Ok(tesoro_core::ledger::SourceChain::Ethereum),
        EID_HYPEREVM_TESTNET | EID_HYPEREVM => Ok(tesoro_core::ledger::SourceChain::HyperEvm),
        _ => err!(BridgeError::UnsupportedChain),
    }
}

/// tesoro_core's Treasury Account: its Gemas are paid into the vault's own treasury.
pub fn core_treasury_account() -> Pubkey {
    let treasury =
        Pubkey::find_program_address(&[tesoro_core::state::TREASURY_SEED], &tesoro_core::ID).0;
    Pubkey::find_program_address(
        &[tesoro_core::state::ACCOUNT_SEED, treasury.as_ref()],
        &tesoro_core::ID,
    )
    .0
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

    pub fn set_admin(mut ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
        SetAdmin::apply(&mut ctx, new_admin)
    }

    pub fn set_peer_config(
        mut ctx: Context<SetPeerConfig>,
        params: SetPeerConfigParams,
    ) -> Result<()> {
        SetPeerConfig::apply(&mut ctx, &params)
    }

    pub fn set_route(mut ctx: Context<SetRoute>, params: SetRouteParams) -> Result<()> {
        SetRoute::apply(&mut ctx, &params)
    }

    // --- Identity ---------------------------------------------------------------------------

    pub fn link_evm(mut ctx: Context<LinkEvm>, params: LinkEvmParams) -> Result<()> {
        LinkEvm::apply(&mut ctx, &params)
    }

    // --- Inbound (source chain to tesoro_core) -----------------------------------------------

    pub fn init_position(mut ctx: Context<InitPosition>, params: PositionRef) -> Result<()> {
        InitPosition::apply(&mut ctx, &params)
    }

    pub fn lz_receive<'info>(
        mut ctx: Context<'_, '_, '_, 'info, LzReceive<'info>>,
        params: LzReceiveParams,
    ) -> Result<()> {
        LzReceive::apply(&mut ctx, &params)
    }

    pub fn apply_locked(mut ctx: Context<ApplyLocked>, params: PositionRef) -> Result<()> {
        ApplyLocked::apply(&mut ctx, &params)
    }

    pub fn apply_yield<'info>(
        mut ctx: Context<'_, '_, '_, 'info, ApplyYield<'info>>,
        params: PositionRef,
    ) -> Result<()> {
        ApplyYield::apply(&mut ctx, &params)
    }

    pub fn sync_treasury(mut ctx: Context<SyncTreasury>, params: PositionRef) -> Result<()> {
        SyncTreasury::apply(&mut ctx, &params)
    }

    // --- Outbound (tesoro_core to source chain) ----------------------------------------------

    pub fn quote_send(ctx: Context<QuoteSend>, params: QuoteSendParams) -> Result<MessagingFee> {
        QuoteSend::apply(&ctx, &params)
    }

    pub fn send_unlock(mut ctx: Context<SendUnlock>, params: SendParams) -> Result<()> {
        SendUnlock::apply(&mut ctx, &params)
    }

    pub fn redeem_to_evm<'info>(
        mut ctx: Context<'_, '_, '_, 'info, RedeemToEvm<'info>>,
        line: tesoro_core::LineRef,
        gemas: u64,
    ) -> Result<()> {
        RedeemToEvm::apply(&mut ctx, line, gemas)
    }

    pub fn send_pay_yield(mut ctx: Context<SendPayYield>, params: SendParams) -> Result<()> {
        SendPayYield::apply(&mut ctx, &params)
    }

    pub fn instant_redeem_to_evm<'info>(
        mut ctx: Context<'_, '_, '_, 'info, InstantRedeemToEvm<'info>>,
        gemas: u64,
    ) -> Result<()> {
        InstantRedeemToEvm::apply(&mut ctx, gemas)
    }

    pub fn send_pay_instant(mut ctx: Context<SendPayInstant>, params: SendParams) -> Result<()> {
        SendPayInstant::apply(&mut ctx, &params)
    }

    pub fn redeem_treasury_to_evm<'info>(
        mut ctx: Context<'_, '_, '_, 'info, RedeemTreasuryToEvm<'info>>,
        line: tesoro_core::LineRef,
        gemas: u64,
    ) -> Result<()> {
        RedeemTreasuryToEvm::apply(&mut ctx, line, gemas)
    }

    /// Admin: closes a record of a layout the current code cannot read (exact old lengths only).
    pub fn retire_legacy_account(
        mut ctx: Context<RetireLegacyAccount>,
        kind: LegacyKind,
    ) -> Result<()> {
        RetireLegacyAccount::apply(&mut ctx, kind)
    }

    // --- Cash-in batches (Platform, Studio and Leaderboard fees of ETH/HYPE Sources) ---------

    pub fn open_batch(mut ctx: Context<OpenBatch>, params: OpenBatchParams) -> Result<()> {
        OpenBatch::apply(&mut ctx, &params)
    }

    pub fn add_to_batch<'info>(
        mut ctx: Context<'_, '_, '_, 'info, AddToBatch<'info>>,
    ) -> Result<()> {
        AddToBatch::apply(&mut ctx)
    }

    pub fn seal_batch(mut ctx: Context<SealBatch>) -> Result<()> {
        SealBatch::apply(&mut ctx)
    }

    pub fn send_batch(mut ctx: Context<SendBatch>, params: SendBatchParams) -> Result<()> {
        SendBatch::apply(&mut ctx, &params)
    }

    pub fn close_batch(mut ctx: Context<CloseBatch>) -> Result<()> {
        CloseBatch::apply(&mut ctx)
    }

    // --- Prize escrow (Leaderboard prize on ETH/HYPE routes) -----------------------------------

    pub fn fund_season_prize_evm<'info>(
        mut ctx: Context<'_, '_, '_, 'info, FundSeasonPrizeEvm<'info>>,
        params: FundSeasonPrizeEvmParams,
    ) -> Result<()> {
        FundSeasonPrizeEvm::apply(&mut ctx, &params)
    }

    pub fn redeem_prize_to_evm(mut ctx: Context<RedeemPrizeToEvm>, gemas: u64) -> Result<()> {
        RedeemPrizeToEvm::apply(&mut ctx, gemas)
    }

    pub fn send_pay_prize(
        mut ctx: Context<SendPayPrize>,
        params: SendPayPrizeParams,
    ) -> Result<()> {
        SendPayPrize::apply(&mut ctx, &params)
    }

    pub fn refund_prize_payout(mut ctx: Context<RefundPrizePayout>) -> Result<()> {
        RefundPrizePayout::apply(&mut ctx)
    }

    pub fn close_payout(mut ctx: Context<ClosePayout>) -> Result<()> {
        ClosePayout::apply(&mut ctx)
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

#[cfg(test)]
mod predeploy_layouts;

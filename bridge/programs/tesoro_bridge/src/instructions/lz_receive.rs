use crate::*;
use msg_codec::{decode_inbound, Inbound};
use oapp::{
    endpoint::{
        cpi::accounts::Clear, instructions::ClearParams, ConstructCPIContext, ID as ENDPOINT_ID,
    },
    LzReceiveParams,
};

// Account order is a contract with `lz_receive_types_v2`: payer, store, peer, target, route,
// system_program, then the Endpoint::clear accounts as remaining accounts. `target` is the record
// the message is about: the BridgePosition of a Position message, the Batch of a BatchResult, the
// PayoutRecord of a PayPrizeResult.
#[derive(Accounts)]
#[instruction(params: LzReceiveParams)]
pub struct LzReceive<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    // Emitter authentication: the sender must be a registered vault of this src_eid. The PDA is
    // derived from the sender itself, so an unregistered sender fails account deserialization.
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.src_eid.to_be_bytes(), &params.sender],
        bump = peer.bump,
        constraint = params.sender == peer.peer_address @ BridgeError::UnknownPeer
    )]
    pub peer: Account<'info, PeerConfig>,
    /// CHECK: must already exist (the default Executor on Hoodi/HyperEVM caps the native drop to
    /// Solana at 0, so nobody can fund rent for an account created inside lz_receive); its address
    /// and type are checked against the message below.
    #[account(mut)]
    pub target: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [ROUTE_SEED, &params.src_eid.to_be_bytes(), &params.sender],
        bump = route.bump
    )]
    pub route: Account<'info, VaultRoute>,
    pub system_program: Program<'info, System>,
}

// The target is read and written by hand: its type depends on the message, and the account is
// checked against the address the message names before it is trusted.
fn load<T: AccountDeserialize>(target: &AccountInfo) -> Result<T> {
    require_keys_eq!(*target.owner, crate::ID, BridgeError::InvalidAccount);
    let data = target.try_borrow_data()?;
    T::try_deserialize(&mut &data[..])
}

fn save<T: AccountSerialize>(target: &AccountInfo, value: &T) -> Result<()> {
    let mut data = target.try_borrow_mut_data()?;
    value.try_serialize(&mut &mut data[..])
}

fn expect_address(target: &AccountInfo, seeds: &[&[u8]]) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(seeds, &crate::ID);
    require_keys_eq!(*target.key, expected, BridgeError::InvalidAccount);
    Ok(())
}

impl LzReceive<'_> {
    pub fn apply<'info>(
        ctx: &mut Context<'_, '_, '_, 'info, LzReceive<'info>>,
        params: &LzReceiveParams,
    ) -> Result<()> {
        let (header, body) = decode_inbound(&params.message)?;
        require!(header.source_chain == params.src_eid, BridgeError::InvalidSourceChain);
        // A vault can only speak for its own Positions and its own route: the id embeds the vault
        // address.
        require!(valid_position_id(&header.position_id), BridgeError::InvalidPositionId);
        require!(vault_of(&header.position_id) == params.sender, BridgeError::InvalidPositionId);
        // Endpoint::clear burns the nonce: the transport-level replay protection.
        let seeds: &[&[u8]] = &[STORE_SEED, &[ctx.accounts.store.bump]];
        let accounts_for_clear = ctx
            .remaining_accounts
            .get(..Clear::MIN_ACCOUNTS_LEN)
            .ok_or(ProgramError::NotEnoughAccountKeys)?;
        oapp::endpoint_cpi::clear(
            ENDPOINT_ID,
            ctx.accounts.store.key(),
            accounts_for_clear,
            seeds,
            ClearParams {
                receiver: ctx.accounts.store.key(),
                src_eid: params.src_eid,
                sender: params.sender,
                nonce: params.nonce,
                guid: params.guid,
                message: params.message.clone(),
            },
        )?;
        let target = ctx.accounts.target.to_account_info();
        let eid = params.src_eid;
        // Application-level idempotency: duplicates and stale messages are consumed as no-ops.
        let applied = match body {
            Inbound::Locked { .. } | Inbound::Yield { .. } => {
                expect_address(&target, &[POSITION_SEED, &eid.to_be_bytes(), &header.position_id])?;
                let mut position: BridgePosition = load(&target)?;
                let applied =
                    Self::apply_position(&mut position, &header, body, &mut ctx.accounts.route)?;
                save(&target, &position)?;
                applied
            },
            Inbound::BatchResult { paid, escrowed_shares, escrowed_units } => {
                expect_address(
                    &target,
                    &[BATCH_SEED, &eid.to_be_bytes(), &params.sender, &header.seq.to_be_bytes()],
                )?;
                let mut batch: Batch = load(&target)?;
                require!(
                    batch.eid == eid
                        && batch.peer_address == params.sender
                        && batch.id == header.seq,
                    BridgeError::BatchMismatch
                );
                let changed = batch.apply_result(&paid)?;
                // The vault's escrow snapshot is valid whatever the batch paid.
                ctx.accounts.route.note_escrow(escrowed_shares, escrowed_units);
                save(&target, &batch)?;
                emit!(BatchAcknowledged {
                    eid,
                    peer_address: params.sender,
                    batch_id: header.seq,
                    paid_units: batch.paid_units,
                    owed_units: batch.owed_units(),
                });
                changed
            },
            Inbound::PayPrizeResult { status, shares } => {
                expect_address(
                    &target,
                    &[PAYOUT_SEED, &eid.to_be_bytes(), &params.sender, &header.seq.to_be_bytes()],
                )?;
                let mut payout: PayoutRecord = load(&target)?;
                require!(
                    payout.eid == eid
                        && payout.peer_address == params.sender
                        && payout.id == header.seq,
                    BridgeError::PayoutMismatch
                );
                let changed = payout.apply_result(status, shares)?;
                if changed && status == msg_codec::PRIZE_PAID {
                    ctx.accounts.route.finish_payout(payout.shares)?;
                }
                save(&target, &payout)?;
                changed
            },
        };
        emit!(MessageReceived {
            src_eid: params.src_eid,
            position_id: header.position_id,
            msg_type: header.msg_type,
            seq: header.seq,
            applied,
        });
        Ok(())
    }

    // PositionLocked and YieldAccrued are tracked separately so a yield report that overtakes its
    // PositionLocked cannot make the Position unopenable.
    fn apply_position(
        position: &mut BridgePosition,
        header: &msg_codec::Header,
        body: Inbound,
        route: &mut VaultRoute,
    ) -> Result<bool> {
        require!(
            position.position_id == header.position_id && position.eid == header.source_chain,
            BridgeError::PositionMismatch
        );
        let applied = match body {
            Inbound::Locked { owner, asset, principal, horizon } => {
                if position.locked_seq == 0 {
                    position.owner_evm =
                        msg_codec::unpad_address(&owner).ok_or(BridgeError::InvalidMessageType)?;
                    position.asset = asset;
                    position.principal = principal;
                    position.horizon_months = horizon;
                    position.locked_seq = header.seq;
                    true
                } else {
                    false
                }
            },
            Inbound::Yield {
                cumulative,
                treasury_balance,
                instant_paid,
                report_time,
                escrowed_shares,
                escrowed_units,
            } => {
                // The escrow figures are the vault's, not the Position's: they only grow, so any
                // report may carry them whatever its seq.
                route.note_escrow(escrowed_shares, escrowed_units);
                if header.seq > position.last_yield_seq {
                    position.last_yield_seq = header.seq;
                    position.yield_cumulative = cumulative;
                    position.treasury_balance = treasury_balance;
                    position.instant_paid = instant_paid;
                    position.report_time = report_time;
                    true
                } else {
                    false
                }
            },
            _ => return err!(BridgeError::InvalidMessageType),
        };
        position.last_in_seq = position.last_in_seq.max(header.seq);
        Ok(applied)
    }
}

#[event]
pub struct MessageReceived {
    pub src_eid: u32,
    pub position_id: [u8; 32],
    pub msg_type: u8,
    pub seq: u64,
    pub applied: bool,
}

#[event]
pub struct BatchAcknowledged {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub batch_id: u64,
    pub paid_units: u128,
    pub owed_units: u128,
}

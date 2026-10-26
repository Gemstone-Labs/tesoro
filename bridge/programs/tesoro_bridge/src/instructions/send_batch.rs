use crate::*;
use msg_codec::{encode_cash_in_batch, route_word, BatchEntryWire, MSG_CASH_IN_BATCH};

// Sends (or sends again) a sealed batch to its vault. The message is a pure function of the batch,
// so a retry carries the same batch id and the same entries; the vault pays each entry at most once
// and answers with its receipt. Nothing here ever releases the debited units: until the
// acknowledgements add up to the batch, the rest stays owed by the vault. Permissionless; the
// payer funds the LayerZero fee.
#[derive(Accounts)]
#[instruction(params: SendBatchParams)]
pub struct SendBatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.eid.to_be_bytes(), &params.peer_address],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(
        mut,
        seeds = [BATCH_SEED, &params.eid.to_be_bytes(), &params.peer_address, &params.batch_id.to_be_bytes()],
        bump = batch.bump
    )]
    pub batch: Box<Account<'info, Batch>>,
    pub system_program: Program<'info, System>,
}

impl SendBatch<'_> {
    pub fn apply(ctx: &mut Context<SendBatch>, params: &SendBatchParams) -> Result<()> {
        let batch = &mut ctx.accounts.batch;
        require!(batch.state == BATCH_SEALED, BridgeError::BatchNotSealed);
        // Entries are core units (9 decimals); the vault is asked in its own base unit, exactly.
        let peer = &ctx.accounts.peer;
        let entries = batch
            .entries()
            .iter()
            .map(|e| {
                Ok(BatchEntryWire {
                    vault_position_id: e.vault_position_id,
                    units: peer.to_vault(e.units)?,
                })
            })
            .collect::<Result<Vec<BatchEntryWire>>>()?;
        let message = encode_cash_in_batch(
            batch.eid,
            &batch.peer_address,
            batch.id,
            batch.kind,
            msg_codec::pad_address(&batch.recipient),
            &entries,
        );
        batch.sends = batch.sends.saturating_add(1);
        let send = SendParams {
            eid: params.eid,
            position_id: route_word(&params.peer_address),
            options: params.options.clone(),
            native_fee: params.native_fee,
            lz_token_fee: params.lz_token_fee,
        };
        lz_send(&ctx.accounts.store, &ctx.accounts.peer, ctx.remaining_accounts, &send, message)?;
        emit!(MessageSent {
            dst_eid: params.eid,
            position_id: route_word(&params.peer_address),
            msg_type: MSG_CASH_IN_BATCH,
            seq: params.batch_id,
            amount: ctx.accounts.batch.total_units,
        });
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SendBatchParams {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub batch_id: u64,
    pub options: Vec<u8>,
    pub native_fee: u64,
    pub lz_token_fee: u64,
}

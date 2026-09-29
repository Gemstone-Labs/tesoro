use crate::*;
use anchor_lang::solana_program::system_program;
use msg_codec::PositionMessage;
use oapp::{
    common::{compact_accounts_with_alts, AccountMetaRef, AddressLocator, EXECUTION_CONTEXT_VERSION_1},
    endpoint::ID as ENDPOINT_ID,
    lz_receive_types_v2::{get_accounts_for_clear, Instruction, LzReceiveTypesV2Result},
    LzReceiveParams,
};

#[derive(Accounts)]
#[instruction(params: LzReceiveParams)]
pub struct LzReceiveTypesV2<'info> {
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
}

impl LzReceiveTypesV2<'_> {
    // The accounts lz_receive needs (peer, position) are derived from src_eid and the message
    // body, so the message is decoded here too. Order must match `LzReceive`.
    pub fn apply(
        ctx: &Context<LzReceiveTypesV2>,
        params: &LzReceiveParams,
    ) -> Result<LzReceiveTypesV2Result> {
        let msg = PositionMessage::decode(&params.message)?;
        let store_key = ctx.accounts.store.key();

        let (peer, _) = Pubkey::find_program_address(
            &[PEER_SEED, store_key.as_ref(), &params.src_eid.to_be_bytes()],
            ctx.program_id,
        );
        let (position, _) = Pubkey::find_program_address(
            &[POSITION_SEED, &params.src_eid.to_be_bytes(), &msg.position_id],
            ctx.program_id,
        );

        let mut accounts = vec![
            AccountMetaRef { pubkey: AddressLocator::Payer, is_writable: true },
            AccountMetaRef { pubkey: store_key.into(), is_writable: false },
            AccountMetaRef { pubkey: peer.into(), is_writable: false },
            AccountMetaRef { pubkey: position.into(), is_writable: true },
            AccountMetaRef { pubkey: system_program::ID.into(), is_writable: false },
        ];
        accounts.extend(get_accounts_for_clear(
            ENDPOINT_ID,
            &store_key,
            params.src_eid,
            &params.sender,
            params.nonce,
        ));

        Ok(LzReceiveTypesV2Result {
            context_version: EXECUTION_CONTEXT_VERSION_1,
            alts: ctx.remaining_accounts.iter().map(|alt| alt.key()).collect(),
            instructions: vec![Instruction::LzReceive {
                accounts: compact_accounts_with_alts(ctx.remaining_accounts, accounts)?,
            }],
        })
    }
}

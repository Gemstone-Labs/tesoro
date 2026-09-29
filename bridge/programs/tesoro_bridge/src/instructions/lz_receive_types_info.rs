use crate::*;
use oapp::{
    lz_receive_types_v2::{LzReceiveTypesV2Accounts, LZ_RECEIVE_TYPES_VERSION},
    LzReceiveParams,
};

// Version discovery for the Executor: returns the accounts it must pass to lz_receive_types_v2
// (the store, plus the ALT when one was registered at init).
#[derive(Accounts)]
pub struct LzReceiveTypesInfo<'info> {
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        seeds = [LZ_RECEIVE_TYPES_SEED, &store.key().to_bytes()],
        bump = lz_receive_types_accounts.bump
    )]
    pub lz_receive_types_accounts: Account<'info, LzReceiveTypesAccounts>,
}

impl LzReceiveTypesInfo<'_> {
    pub fn apply(
        ctx: &Context<LzReceiveTypesInfo>,
        _params: &LzReceiveParams,
    ) -> Result<(u8, LzReceiveTypesV2Accounts)> {
        let types = &ctx.accounts.lz_receive_types_accounts;
        let accounts = if types.alt == Pubkey::default() {
            vec![types.store]
        } else {
            vec![types.store, types.alt]
        };
        Ok((LZ_RECEIVE_TYPES_VERSION, LzReceiveTypesV2Accounts { accounts }))
    }
}

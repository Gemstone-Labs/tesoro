use crate::*;
use anchor_lang::solana_program::address_lookup_table::program::ID as ALT_PROGRAM_ID;
use oapp::endpoint::{instructions::RegisterOAppParams, ID as ENDPOINT_ID};

#[derive(Accounts)]
#[instruction(params: InitStoreParams)]
pub struct InitStore<'info> {
    #[account(mut, address = params.admin)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Store::INIT_SPACE,
        seeds = [STORE_SEED],
        bump
    )]
    pub store: Account<'info, Store>,
    #[account(
        init,
        payer = payer,
        space = 8 + LzReceiveTypesAccounts::INIT_SPACE,
        seeds = [LZ_RECEIVE_TYPES_SEED, &store.key().to_bytes()],
        bump
    )]
    pub lz_receive_types_accounts: Account<'info, LzReceiveTypesAccounts>,
    #[account(owner = ALT_PROGRAM_ID)]
    pub alt: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

impl InitStore<'_> {
    pub fn apply(ctx: &mut Context<InitStore>, params: &InitStoreParams) -> Result<()> {
        require_keys_eq!(params.endpoint, ENDPOINT_ID, BridgeError::InvalidEndpoint);
        let (_, authority_bump) = Pubkey::find_program_address(&[AUTHORITY_SEED], ctx.program_id);
        let store = &mut ctx.accounts.store;
        store.admin = params.admin;
        store.bump = ctx.bumps.store;
        store.authority_bump = authority_bump;
        store.endpoint_program = params.endpoint;

        let types = &mut ctx.accounts.lz_receive_types_accounts;
        types.store = store.key();
        types.alt = ctx.accounts.alt.as_ref().map(|a| a.key()).unwrap_or_default();
        types.bump = ctx.bumps.lz_receive_types_accounts;

        let seeds: &[&[u8]] = &[STORE_SEED, &[store.bump]];
        oapp::endpoint_cpi::register_oapp(
            ENDPOINT_ID,
            store.key(),
            ctx.remaining_accounts,
            seeds,
            RegisterOAppParams { delegate: store.admin },
        )?;
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct InitStoreParams {
    pub admin: Pubkey,
    pub endpoint: Pubkey,
}

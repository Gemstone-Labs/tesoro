use crate::*;
use oapp::endpoint::instructions::SetDelegateParams;

// Rotates the admin and the LayerZero endpoint delegate. Gated on the program's upgrade
// authority rather than the current admin, so a compromised admin key cannot call it.
// `remaining_accounts` are the endpoint's set_delegate CPI accounts, in order:
// [endpoint program, store, oapp registry PDA, endpoint event authority, endpoint program].
#[derive(Accounts)]
pub struct SetAdmin<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ BridgeError::Unauthorized
    )]
    pub program: Program<'info, crate::program::TesoroBridge>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ BridgeError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
}

impl SetAdmin<'_> {
    pub fn apply(ctx: &mut Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
        let store = &mut ctx.accounts.store;
        store.admin = new_admin;

        let seeds: &[&[u8]] = &[STORE_SEED, &[store.bump]];
        oapp::endpoint_cpi::set_delegate(
            store.endpoint_program,
            store.key(),
            ctx.remaining_accounts,
            seeds,
            SetDelegateParams { delegate: new_admin },
        )?;
        Ok(())
    }
}

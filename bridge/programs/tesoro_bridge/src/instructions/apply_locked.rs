use crate::*;
use tesoro_core::{
    cpi::accounts::OpenPositionFromSource,
    program::TesoroCore,
    state::{
        SourceAuthority, TesoroAccount, POSITION_SEED as CORE_POSITION_SEED, SOURCE_AUTHORITY_SEED,
    },
};

// Applies a received `PositionLocked` to tesoro_core: opens the Position for the Account linked
// to the owner's EVM address, signed by the bridge authority PDA (registered in tesoro_core as
// the Ethereum / HyperEVM source authority). Permissionless: the payer only funds rent.
#[derive(Accounts)]
#[instruction(params: PositionRef)]
pub struct ApplyLocked<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.eid.to_be_bytes(), &vault_of(&params.position_id)],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &params.eid.to_be_bytes(), &params.position_id],
        bump = bridge_position.bump
    )]
    pub bridge_position: Account<'info, BridgePosition>,
    /// CHECK: PDA that signs into tesoro_core; address fixed by seeds and the stored bump.
    #[account(seeds = [AUTHORITY_SEED], bump = store.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        seeds = [EVM_LINK_SEED, &bridge_position.owner_evm],
        bump = evm_link.bump
    )]
    pub evm_link: Account<'info, EvmLink>,
    #[account(
        constraint = owner_account.key() == evm_link.account @ BridgeError::InvalidAccount
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[core_chain_byte(params.eid).unwrap_or(u8::MAX)]],
        bump = core_source_authority.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_source_authority: Account<'info, SourceAuthority>,
    /// CHECK: created by tesoro_core (`init`); its address is fixed here by tesoro_core's seeds.
    #[account(
        mut,
        seeds = [CORE_POSITION_SEED, &[core_chain_byte(params.eid).unwrap_or(u8::MAX)], &params.position_id],
        bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_position: UncheckedAccount<'info>,
    pub core_program: Program<'info, TesoroCore>,
    pub system_program: Program<'info, System>,
}

impl ApplyLocked<'_> {
    pub fn apply(ctx: &mut Context<ApplyLocked>, params: &PositionRef) -> Result<()> {
        let chain = core_chain(params.eid)?;
        let position = &mut ctx.accounts.bridge_position;
        require!(position.locked_seq > 0, BridgeError::NotLocked);
        require!(!position.opened, BridgeError::AlreadyOpened);
        let principal =
            u64::try_from(position.principal).map_err(|_| error!(BridgeError::AmountOverflow))?;

        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &[ctx.accounts.store.authority_bump]]];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.core_program.to_account_info(),
            OpenPositionFromSource {
                payer: ctx.accounts.payer.to_account_info(),
                source_signer: ctx.accounts.authority.to_account_info(),
                source_authority: ctx.accounts.core_source_authority.to_account_info(),
                owner_account: ctx.accounts.owner_account.to_account_info(),
                position: ctx.accounts.core_position.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            signer_seeds,
        );
        tesoro_core::cpi::open_position_from_source(
            cpi,
            chain,
            params.position_id,
            Pubkey::new_from_array(position.asset),
            ctx.accounts.peer.decimals,
            principal,
            ctx.accounts.peer.rate_bps,
        )?;
        position.opened = true;
        Ok(())
    }
}

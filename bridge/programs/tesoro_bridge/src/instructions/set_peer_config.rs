use crate::*;

// One PeerConfig PDA per (remote eid, vault address). Registering it authorises that vault to
// send Positions into Tesoro and fixes its asset terms.
#[derive(Accounts)]
#[instruction(params: SetPeerConfigParams)]
pub struct SetPeerConfig<'info> {
    #[account(mut, address = store.admin)]
    pub admin: Signer<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + PeerConfig::INIT_SPACE,
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.remote_eid.to_be_bytes(), &params.peer_address],
        bump
    )]
    pub peer: Account<'info, PeerConfig>,
    /// The mirror of the vault's treasury that caps Instant Redeems on it.
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + VaultTreasury::INIT_SPACE,
        seeds = [TREASURY_SEED, &params.remote_eid.to_be_bytes(), &params.peer_address],
        bump
    )]
    pub vault_treasury: Account<'info, VaultTreasury>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    pub system_program: Program<'info, System>,
}

impl SetPeerConfig<'_> {
    pub fn apply(ctx: &mut Context<SetPeerConfig>, params: &SetPeerConfigParams) -> Result<()> {
        core_chain(params.remote_eid)?;
        oapp::options::assert_type_3(&params.enforced_send_options)?;
        let peer = &mut ctx.accounts.peer;
        peer.peer_address = params.peer_address;
        peer.decimals = params.decimals;
        peer.rate_bps = params.rate_bps;
        peer.enforced_send_options = params.enforced_send_options.clone();
        peer.bump = ctx.bumps.peer;
        let treasury = &mut ctx.accounts.vault_treasury;
        treasury.eid = params.remote_eid;
        treasury.peer_address = params.peer_address;
        treasury.bump = ctx.bumps.vault_treasury;
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SetPeerConfigParams {
    pub remote_eid: u32,
    pub peer_address: [u8; 32],
    pub decimals: u8,
    pub rate_bps: u16,
    pub enforced_send_options: Vec<u8>,
}

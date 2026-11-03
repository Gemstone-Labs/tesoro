use crate::*;

// Admin: a vault's Delivery Fee terms. The terms are checked against the program ceiling
// (`DeliveryTerms::validate`), so no setting can take more than a tenth of a payout. The fee is
// snapshotted into each Redeem when it is made, so a change reaches new Redeems only.
#[derive(Accounts)]
#[instruction(params: SetDeliveryTermsParams)]
pub struct SetDeliveryTerms<'info> {
    #[account(mut, address = store.admin @ BridgeError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    /// The vault must be a registered peer.
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.eid.to_be_bytes(), &params.peer_address],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + DeliveryTerms::INIT_SPACE,
        seeds = [DELIVERY_SEED, &params.eid.to_be_bytes(), &params.peer_address],
        bump
    )]
    pub delivery_terms: Account<'info, DeliveryTerms>,
    pub system_program: Program<'info, System>,
}

impl SetDeliveryTerms<'_> {
    pub fn apply(ctx: &mut Context<SetDeliveryTerms>, params: &SetDeliveryTermsParams) -> Result<()> {
        let terms = &mut ctx.accounts.delivery_terms;
        terms.eid = params.eid;
        terms.peer_address = params.peer_address;
        terms.bump = ctx.bumps.delivery_terms;
        terms.delivery_fee = params.delivery_fee;
        terms.max_abs = params.max_abs;
        terms.min_redeem = params.min_redeem;
        terms.max_bps_unlock = params.max_bps_unlock;
        terms.max_bps_yield = params.max_bps_yield;
        terms.min_prize_gemas = params.min_prize_gemas;
        terms.validate()
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SetDeliveryTermsParams {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub delivery_fee: u128,
    pub max_abs: u128,
    pub min_redeem: u128,
    pub max_bps_unlock: u16,
    pub max_bps_yield: u16,
    pub min_prize_gemas: u64,
}

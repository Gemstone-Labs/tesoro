use anchor_lang::prelude::*;
pub mod ledger;

declare_id!("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");

#[program]
pub mod tesoro_core {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}

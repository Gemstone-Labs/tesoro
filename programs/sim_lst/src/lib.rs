use anchor_lang::prelude::*;

declare_id!("WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F");

#[program]
pub mod sim_lst {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}

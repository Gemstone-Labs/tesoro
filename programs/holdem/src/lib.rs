use anchor_lang::prelude::*;

declare_id!("CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE");

#[program]
pub mod holdem {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}

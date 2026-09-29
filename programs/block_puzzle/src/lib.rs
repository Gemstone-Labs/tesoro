pub mod engine;

use anchor_lang::prelude::*;

declare_id!("5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj");

#[program]
pub mod block_puzzle {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}

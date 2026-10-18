//! Vanguard (blitz Stratego) as a Tesoro Game.
//!
//! `engine` is the referee: pure rules over fixed-size arrays, no accounts, proven identical to the app's
//! rules by the shared recordings in `tests/fixtures/recordings.json`. The instructions and accounts that
//! drive it on the chain are added by the next ticket.

pub mod engine;

use anchor_lang::prelude::*;

declare_id!("TS3iowavNFV2pMUrHcbmGNC9SW2Vv54i52DqjKebYKH");

#[program]
pub mod vanguard {
    use super::*;

    /// Placeholder until the Match instructions land: reports the rules version.
    pub fn rules_version(_ctx: Context<RulesVersion>) -> Result<()> {
        msg!("vanguard rules {}", engine::RULES_VERSION);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct RulesVersion {}

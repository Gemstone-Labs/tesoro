use riptide_sim::anyhow::{anyhow, Result};

use crate::flows::{DEPOSIT_SHARES, TREASURY_UTILIZATION_RISK_LINE_BPS};
use crate::Simulation;

pub fn check(sim: &mut Simulation) -> Result<()> {
    let Some(ctx) = &sim.ctx else {
        return Ok(());
    };

    let mut hard_failures: Vec<&'static str> = Vec::new();

    // Hard protocol safety invariants (MUST HOLD across the entire 0..60% shock sweep;
    // any violation records the firing AND fails the iteration by returning Err).
    if ctx.vault_solvency_broken {
        sim.world.record_invariant_fire("vault_principal_solvency");
        hard_failures.push("vault_principal_solvency");
    }
    if ctx.minted_yield_exceeded {
        sim.world.record_invariant_fire("minted_yield_bounded");
        hard_failures.push("minted_yield_bounded");
    }
    let returned = ctx
        .alice_after_unlock
        .saturating_sub(ctx.alice_before_unlock);
    if returned < DEPOSIT_SHARES {
        sim.world.record_invariant_fire("principal_returned_exact");
        hard_failures.push("principal_returned_exact");
    }

    // Economic risk-line signal (Treasury buffer utilization crosses 60% under SOL price drop)
    if ctx.treasury_utilization_bps >= TREASURY_UTILIZATION_RISK_LINE_BPS {
        sim.world
            .record_invariant_fire("treasury_buffer_utilization_high");
    }

    if !hard_failures.is_empty() {
        return Err(anyhow!(
            "hard protocol safety/solvency invariant failed: {}",
            hard_failures.join(", ")
        ));
    }

    Ok(())
}

//! Account sizes for the required deployment preflight (host tests only).
mod probe {
    include!("../../../scripts/predeploy-probe.rs");
}
use anchor_lang::Space;
use probe::fixed;

#[test]
fn emit_layouts() {
    println!("TESORO_PROGRAM {}", crate::ID);
    fixed::<crate::Pool>("Pool", 8 + crate::Pool::INIT_SPACE);
    fixed::<crate::YieldConfig>("YieldConfig", 8 + crate::YieldConfig::INIT_SPACE);
    fixed::<crate::FaucetClaim>("FaucetClaim", 8 + crate::FaucetClaim::INIT_SPACE);
}

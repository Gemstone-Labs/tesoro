//! Account sizes for the required deployment preflight (host tests only).
mod probe {
    include!("../../../../scripts/predeploy-probe.rs");
}
use anchor_lang::Space;
use probe::fixed;

#[test]
fn emit_layouts() {
    println!("TESORO_PROGRAM {}", crate::ID);
    fixed::<crate::state::Batch>("Batch", 8 + crate::state::Batch::INIT_SPACE);
    fixed::<crate::state::BridgePosition>(
        "BridgePosition",
        8 + crate::state::BridgePosition::INIT_SPACE,
    );
    fixed::<crate::state::Claim>("Claim", 8 + crate::state::Claim::INIT_SPACE);
    fixed::<crate::state::InstantClaim>("InstantClaim", 8 + crate::state::InstantClaim::INIT_SPACE);
    fixed::<crate::state::EvmLink>("EvmLink", 8 + crate::state::EvmLink::INIT_SPACE);
    fixed::<crate::state::PayoutRecord>("PayoutRecord", 8 + crate::state::PayoutRecord::INIT_SPACE);
    fixed::<crate::state::PeerConfig>("PeerConfig", 8 + crate::state::PeerConfig::INIT_SPACE);
    fixed::<crate::state::VaultRoute>("VaultRoute", 8 + crate::state::VaultRoute::INIT_SPACE);
    fixed::<crate::state::Store>("Store", 8 + crate::state::Store::INIT_SPACE);
    fixed::<crate::state::LzReceiveTypesAccounts>(
        "LzReceiveTypesAccounts",
        8 + crate::state::LzReceiveTypesAccounts::INIT_SPACE,
    );
    fixed::<crate::state::VaultTreasury>(
        "VaultTreasury",
        8 + crate::state::VaultTreasury::INIT_SPACE,
    );
    probe::decode_report();
}

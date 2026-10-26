//! Account sizes for the required deployment preflight (host tests only).
mod probe {
    include!("../../../scripts/predeploy-probe.rs");
}
use anchor_lang::Space;
use probe::fixed;

#[test]
fn emit_layouts() {
    println!("TESORO_PROGRAM {}", crate::ID);
    fixed::<crate::state::VanguardConfig>(
        "VanguardConfig",
        8 + crate::state::VanguardConfig::INIT_SPACE,
    );
    fixed::<crate::state::Battle>("Battle", 8 + core::mem::size_of::<crate::state::Battle>());
    fixed::<crate::state::Army>("Army", 8 + crate::state::Army::INIT_SPACE);
    fixed::<crate::state::TableConfig>("TableConfig", 8 + crate::state::TableConfig::INIT_SPACE);
    fixed::<crate::state::Sponsor>("Sponsor", 8 + crate::state::Sponsor::INIT_SPACE);
    fixed::<crate::state::Fuel>("Fuel", 8 + crate::state::Fuel::INIT_SPACE);
    fixed::<crate::state::Assignment>("Assignment", 8 + crate::state::Assignment::INIT_SPACE);
    fixed::<crate::state::Table>("Table", 8 + crate::state::Table::INIT_SPACE);
    probe::retired("Army", &crate::state::LEGACY_ARMY_LENGTHS);
    probe::decode_report();
}

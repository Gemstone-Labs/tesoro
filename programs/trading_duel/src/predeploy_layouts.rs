//! Account sizes for the required deployment preflight (host tests only).
mod probe {
    include!("../../../scripts/predeploy-probe.rs");
}
use anchor_lang::Space;
use probe::fixed;

#[test]
fn emit_layouts() {
    println!("TESORO_PROGRAM {}", crate::ID);
    fixed::<crate::state::TableConfig>("TableConfig", 8 + crate::state::TableConfig::INIT_SPACE);
    fixed::<crate::state::Sponsor>("Sponsor", 8 + crate::state::Sponsor::INIT_SPACE);
    fixed::<crate::state::Fuel>("Fuel", 8 + crate::state::Fuel::INIT_SPACE);
    fixed::<crate::state::Assignment>("Assignment", 8 + crate::state::Assignment::INIT_SPACE);
    fixed::<crate::state::Table>("Table", 8 + crate::state::Table::INIT_SPACE);
    fixed::<crate::state::Book>("Book", 8 + crate::state::Book::INIT_SPACE);
}

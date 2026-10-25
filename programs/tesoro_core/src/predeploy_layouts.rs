//! Account sizes for the required deployment preflight (host tests only).
mod probe {
    include!("../../../scripts/predeploy-probe.rs");
}
use anchor_lang::{AccountDeserialize, Discriminator};
use probe::fixed;

#[test]
fn emit_layouts() {
    println!("TESORO_PROGRAM {}", crate::ID);
    variable::<crate::pots::TicketHead>(
        "TicketHead",
        crate::pots::ticket_len(0),
        crate::ledger::line_store::LINE_LEN,
        crate::storage::MAX_TICKET_LINES,
        &[
            (8, crate::pots::TICKET_VERSION),
            (
                crate::pots::POT_AT,
                crate::ledger::line_store::BASKET_VERSION,
            ),
        ],
    );
    fixed::<crate::state::InviteGate>("InviteGate", crate::state::InviteGate::SPACE);
    fixed::<crate::state::GameRecord>("GameRecord", crate::state::GameRecord::SPACE);
    fixed::<crate::state::PairState>("PairState", crate::state::PairState::SPACE);
    fixed::<crate::state::Config>("Config", crate::state::Config::SPACE);
    fixed::<crate::state::SeasonState>("SeasonState", crate::state::SeasonState::SPACE);
    fixed::<crate::state::SourceAuthority>("SourceAuthority", crate::state::SourceAuthority::SPACE);
    fixed::<crate::state::TesoroAccount>("TesoroAccount", crate::state::TesoroAccount::SPACE);
    fixed::<crate::state::PositionState>("PositionState", crate::state::PositionState::SPACE);
    fixed::<crate::state::SourceState>("SourceState", crate::state::SourceState::SPACE);
    fixed::<crate::state::AccountCounters>("AccountCounters", crate::state::AccountCounters::SPACE);
    fixed::<crate::state::MatchState>("MatchState", crate::state::MatchState::SPACE);
    fixed::<crate::state::SettlementReceipt>(
        "SettlementReceipt",
        crate::state::SettlementReceipt::SPACE,
    );
    fixed::<crate::state::RequestState>("RequestState", crate::state::RequestState::SPACE);
    fixed::<crate::state::OfferState>("OfferState", crate::state::OfferState::SPACE);
    fixed::<crate::state::NativeCustody>("NativeCustody", crate::state::NativeCustody::SPACE);
    fixed::<crate::state::StakeConfig>("StakeConfig", crate::state::StakeConfig::SPACE);
    fixed::<crate::state::StakeCustody>("StakeCustody", crate::state::StakeCustody::SPACE);
    fixed::<crate::state::Treasury>("Treasury", crate::state::Treasury::SPACE);
    fixed::<crate::state::PriceFeed>("PriceFeed", crate::state::PriceFeed::SPACE);
    fixed::<crate::state::OnchainPrice>("OnchainPrice", crate::state::OnchainPrice::SPACE);
    fixed::<crate::state::EconomyConfig>("EconomyConfig", crate::state::EconomyConfig::SPACE);
    fixed::<crate::state::InstantOrderState>(
        "InstantOrderState",
        crate::state::InstantOrderState::SPACE,
    );
    fixed::<crate::state::PrizeSourceState>(
        "PrizeSourceState",
        crate::state::PrizeSourceState::SPACE,
    );
    fixed::<crate::state::PoolReservationsState>(
        "PoolReservationsState",
        crate::state::PoolReservationsState::SPACE,
    );
    fixed::<crate::state::ExtendLimitState>(
        "ExtendLimitState",
        crate::state::ExtendLimitState::SPACE,
    );
    fixed::<crate::state::ProtectionsState>(
        "ProtectionsState",
        crate::state::ProtectionsState::SPACE,
    );
    fixed::<crate::state::Profile>("Profile", crate::state::Profile::SPACE);
    variable::<crate::storage::BasketHead>(
        "BasketHead",
        crate::storage::store_len(0),
        crate::ledger::line_store::LINE_LEN,
        crate::storage::MAX_BASKET_LINES,
        &[(8, crate::ledger::line_store::BASKET_VERSION)],
    );
    variable::<crate::storage::SpillHead>(
        "SpillHead",
        crate::storage::store_len(0),
        crate::ledger::line_store::LINE_LEN,
        crate::storage::MAX_SPILL_LINES,
        &[(8, crate::ledger::line_store::BASKET_VERSION)],
    );
    variable::<crate::storage::OverflowHead>(
        "OverflowHead",
        crate::storage::overflow_len(0),
        crate::ledger::line_store::LINE_LEN,
        crate::storage::MAX_BASKET_LINES,
        &[(
            crate::storage::OVERFLOW_STORE_AT,
            crate::ledger::line_store::BASKET_VERSION,
        )],
    );
    variable::<crate::storage::SourceBookHead>(
        "SourceBookHead",
        crate::storage::SOURCE_BOOK_LEN,
        crate::ledger::book::CLASS_LEN,
        crate::ledger::book::MAX_EXTENSIONS as usize,
        &[
            (9, crate::storage::SOURCE_BOOK_VERSION),
            (crate::storage::BOOK_AT, crate::ledger::book::BOOK_VERSION),
        ],
    );
    fixed::<crate::storage::CkptHead>("CkptHead", crate::storage::CKPT_ACCOUNT_LEN);
    fixed::<crate::storage::SponsorState>("SponsorState", crate::storage::SponsorState::SPACE);
}

/// Regression fixture for the real 178 -> 327 custody mismatch; written and read through LiteSVM.
#[test]
fn native_custody_old_and_new_sizes() {
    use crate::state::NativeCustody;
    use litesvm::LiteSVM;
    use solana_sdk::{account::Account, pubkey::Pubkey};
    let mut svm = LiteSVM::new();
    for size in [178, NativeCustody::SPACE] {
        let address = Pubkey::new_unique();
        let mut data = vec![0; size];
        data[..8].copy_from_slice(NativeCustody::DISCRIMINATOR);
        svm.set_account(
            address,
            Account {
                lamports: 10_000_000,
                data,
                owner: Pubkey::new_from_array(crate::ID.to_bytes()),
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("fixture account");
        let read = svm.get_account(&address).expect("read fixture");
        assert_eq!(
            NativeCustody::try_deserialize(&mut read.data.as_slice()).is_ok(),
            size == NativeCustody::SPACE
        );
        println!(
            "TESORO_LAYOUT_FIXTURE {{\"address\":\"{}\",\"data\":{:?}}}",
            address, read.data
        );
    }
}

pub fn variable<T: Discriminator>(
    name: &str,
    base: usize,
    stride: usize,
    max_extra: usize,
    versions: &[(usize, u8)],
) {
    let versions = versions
        .iter()
        .map(|(at, v)| format!("[{},{}]", at, v))
        .collect::<Vec<_>>()
        .join(",");
    println!("TESORO_LAYOUT {{\"type\":\"{}\",\"discriminator\":{:?},\"base\":{},\"stride\":{},\"maxExtra\":{},\"versions\":[{}]}}", name, T::DISCRIMINATOR, base, stride, max_extra, versions);
}

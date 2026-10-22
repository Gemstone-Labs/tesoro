//! LiteSVM tests of the bridge's tesoro_core-facing instructions against the built programs
//! (`cargo build-sbf` here and `pnpm build:programs` at the repo root first). The endpoint
//! program is not loaded, so `lz_receive` and the send instructions are covered on devnet; the
//! inbox they fill is written directly with the bytes `lz_receive` would produce.
#![allow(clippy::result_large_err)]

use crate::*;
use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey as Pk,
    signature::Keypair,
    signer::Signer,
    transaction::Transaction,
};
use tesoro_core::{
    ledger::{
        line_store::{SIDE_OWN, SIDE_WON},
        SourceChain,
    },
    state::{
        PositionState, PrizeSourceState, SourceState, TesoroAccount, ACCOUNT_SEED, CONFIG_SEED,
        ECONOMY_SEED, INSTANT_ORDER_SEED, LEADERBOARD_SEED, ONCHAIN_PRICE_SEED, PRIZE_SOURCE_SEED,
        PROTECTIONS_SEED, SOURCE_AUTHORITY_SEED, SOURCE_SEED,
    },
    storage::{basket_address, book_address, ckpt_address, spill_address},
    LineRef,
};

// The economy suites' helpers: reading baskets and books, and forging what a settled Match does.
#[path = "../../../../programs/tesoro_core/tests/common/econ.rs"]
#[allow(dead_code)]
#[rustfmt::skip]
mod econ;

type Failed = litesvm::types::FailedTransactionMetadata;
/// Vault block time of the test Yield Reports: this plus the message seq.
const REPORT_EPOCH: u64 = 1_760_000_000;
const SOL: u64 = 1_000_000_000;
const ETH: u128 = 1_000_000_000_000_000_000;

// Anvil account 0: the EVM wallet that owns the Position and signs the link.
const EVM_ADDRESS: [u8; 20] = [
    0xf3, 0x9F, 0xd6, 0xe5, 0x1a, 0xad, 0x88, 0xF6, 0xF4, 0xce, 0x6a, 0xB8, 0x82, 0x72, 0x79, 0xcf,
    0xfF, 0xb9, 0x22, 0x66,
];
// `cast wallet sign --private-key <anvil 0> "<link message for OWNER_ACCOUNT>"`
const LINK_SIGNATURE: &str = "4eea9b6d0a869481ca89acfd3c80de21ee3d843dd9f1156b2026672905d043eb12245b421f8f445e9df6eca436f5db9a5e15a62721226a1e8d1f60aeaf5555a31b";
const VAULT: [u8; 20] = [0x5b; 20];
/// The EVM addresses Tesoro's Platform and Studio Accounts are paid at.
const PLATFORM_EVM: [u8; 20] = [0xA1; 20];
const STUDIO_EVM: [u8; 20] = [0xB2; 20];
/// The vault's Source asset as the Positions' `PositionLocked` names it.
const ASSET: [u8; 20] = [0xAB; 20];

fn a(p: Pk) -> Pubkey {
    Pubkey::new_from_array(p.to_bytes())
}
fn s(p: Pubkey) -> Pk {
    Pk::new_from_array(p.to_bytes())
}
fn hex(h: &str) -> Vec<u8> {
    (0..h.len() / 2)
        .map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap_or(0))
        .collect()
}
fn core_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &tesoro_core::ID).0
}
fn bridge_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &crate::ID).0
}
fn position_id(id: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..20].copy_from_slice(&VAULT);
    out[20..28].copy_from_slice(&id.to_be_bytes());
    out
}

fn ix(program: Pubkey, accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id: s(program),
        accounts: accounts
            .to_account_metas(None)
            .into_iter()
            .map(|m| AccountMeta {
                pubkey: s(m.pubkey),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
        data: data.data(),
    }
}

fn custom_code(err: &Failed) -> Option<u32> {
    use solana_sdk::instruction::InstructionError;
    use solana_sdk::transaction::TransactionError;
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
        _ => None,
    }
}

fn bridge_err(e: BridgeError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    oracle: Keypair,
    owner: Keypair,
    owner_account: Pubkey,
    store: Pubkey,
    authority: Pubkey,
    upgrade_authority: Keypair,
    programdata: Pubkey,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let core_so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../target/deploy/tesoro_core.so");
        let bridge_so =
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/tesoro_bridge.so");
        svm.add_program_from_file(s(tesoro_core::ID), core_so)
            .expect("build tesoro_core first: pnpm build:programs");
        svm.add_program_from_file(s(crate::ID), bridge_so)
            .expect("build the bridge first: cargo build-sbf");
        // The LayerZero endpoint is a test double: it accepts `clear` and `send` and logs what it
        // was given, so the real `lz_receive` and the send instructions run end to end.
        let endpoint_so =
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/mock_endpoint.so");
        svm.add_program_from_file(s(oapp::endpoint::ID), endpoint_so)
            .expect("build the bridge first: cargo build-sbf");
        // `add_program` deploys with no upgrade authority; record one for the `set_admin` gate.
        let upgrade_authority = Keypair::new();
        let programdata = Pubkey::find_program_address(
            &[crate::ID.as_ref()],
            &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        )
        .0;
        let mut pd = svm.get_account(&s(programdata)).expect("programdata");
        pd.data[12] = 1;
        pd.data[13..45].copy_from_slice(upgrade_authority.pubkey().as_ref());
        svm.set_account(s(programdata), pd).expect("set programdata");
        let owner = Keypair::new_from_array([42u8; 32]);
        let store = bridge_pda(&[STORE_SEED]);
        let authority = bridge_pda(&[AUTHORITY_SEED]);
        let mut env = Self {
            svm,
            admin: Keypair::new(),
            oracle: Keypair::new(),
            owner_account: core_pda(&[ACCOUNT_SEED, a(owner.pubkey()).as_ref()]),
            owner,
            store,
            authority,
            upgrade_authority,
            programdata,
        };
        for k in [&env.admin, &env.oracle, &env.owner, &env.upgrade_authority] {
            env.svm.airdrop(&k.pubkey(), 1_000 * SOL).expect("airdrop");
        }
        let (_, authority_bump) = Pubkey::find_program_address(&[AUTHORITY_SEED], &crate::ID);
        let (_, store_bump) = Pubkey::find_program_address(&[STORE_SEED], &crate::ID);
        env.put(
            store,
            crate::ID,
            &Store {
                admin: a(env.admin.pubkey()),
                endpoint_program: Pubkey::new_unique(),
                bump: store_bump,
                authority_bump,
            },
        );
        // Core: platform Account, the owner's Account with the EVM address, config, authority.
        let admin = env.admin.insecure_clone();
        let platform = env.create_core_account(&admin, PLATFORM_EVM);
        let owner = env.owner.insecure_clone();
        env.create_core_account(&owner, EVM_ADDRESS);
        env.send(
            &[ix(
                tesoro_core::ID,
                tesoro_core::accounts::InitializeConfig {
                    admin: a(admin.pubkey()),
                    config: core_pda(&[CONFIG_SEED]),
                    platform_recipient: platform,
                    system_program: anchor_lang::system_program::ID,
                },
                tesoro_core::instruction::InitializeConfig {
                    oracle_authority: a(env.oracle.pubkey()),
                    platform_bps: 200,
                },
            )],
            &admin,
            &[],
        )
        .expect("init config");
        env.send(
            &[ix(
                tesoro_core::ID,
                tesoro_core::accounts::SetSourceAuthority {
                    admin: a(admin.pubkey()),
                    config: core_pda(&[CONFIG_SEED]),
                    source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                    system_program: anchor_lang::system_program::ID,
                },
                tesoro_core::instruction::SetSourceAuthority {
                    chain: SourceChain::Ethereum,
                    authority,
                },
            )],
            &admin,
            &[],
        )
        .expect("register the bridge authority");
        env.init_core_treasury(&admin);
        env.init_core_economy(&admin);
        env.put(
            env.route(),
            crate::ID,
            &VaultRoute {
                eid: EID_HOODI,
                peer_address: msg_codec::pad_address(&VAULT),
                bump: Pubkey::find_program_address(
                    &[ROUTE_SEED, &EID_HOODI.to_be_bytes(), &msg_codec::pad_address(&VAULT)],
                    &crate::ID,
                )
                .1,
                asset: msg_codec::pad_address(&ASSET),
                escrow_enabled: false,
                min_batch_units: 0,
                last_batch_id: 0,
                last_payout_id: 0,
                escrow_shares: 0,
                escrow_units: 0,
                issued_shares: 0,
                issued_units: 0,
                last_funded_season: 0,
                pending_payout_shares: 0,
                paid_payout_shares: 0,
            },
        );
        env.put(
            env.vault_treasury(),
            crate::ID,
            &VaultTreasury {
                eid: EID_HOODI,
                peer_address: msg_codec::pad_address(&VAULT),
                balance: 0,
                paid_at_report: 0,
                instant_recorded: 0,
                report_time: 0,
                bump: Pubkey::find_program_address(
                    &[TREASURY_SEED, &EID_HOODI.to_be_bytes(), &msg_codec::pad_address(&VAULT)],
                    &crate::ID,
                )
                .1,
            },
        );
        env.put(
            env.peer(),
            crate::ID,
            &PeerConfig {
                peer_address: msg_codec::pad_address(&VAULT),
                decimals: 18,
                rate_bps: 500,
                enforced_send_options: vec![],
                bump: Pubkey::find_program_address(
                    &[
                        PEER_SEED,
                        store.as_ref(),
                        &EID_HOODI.to_be_bytes(),
                        &msg_codec::pad_address(&VAULT),
                    ],
                    &crate::ID,
                )
                .1,
            },
        );
        env
    }

    fn vault_treasury(&self) -> Pubkey {
        bridge_pda(&[TREASURY_SEED, &EID_HOODI.to_be_bytes(), &msg_codec::pad_address(&VAULT)])
    }

    /// tesoro_core's Treasury at the launch rates (20% Yield Fee, 35% Instant Redeem Fee), with a
    /// stand-in simSOL mint for its vault.
    fn init_core_treasury(&mut self, admin: &Keypair) {
        use anchor_lang::solana_program::{program_option::COption, program_pack::Pack};
        use anchor_spl::token::{spl_token, ID as TOKEN_PROGRAM_ID};
        let mut data = vec![0u8; spl_token::state::Mint::LEN];
        spl_token::state::Mint {
            mint_authority: COption::None,
            supply: 0,
            decimals: 9,
            is_initialized: true,
            freeze_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        self.svm
            .set_account(
                s(tesoro_core::state::SIM_SOL_MINT),
                solana_sdk::account::Account {
                    lamports: 10_000_000,
                    data,
                    owner: s(TOKEN_PROGRAM_ID),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("mint");
        self.send(
            &[ix(
                tesoro_core::ID,
                tesoro_core::accounts::InitTreasury {
                    admin: a(admin.pubkey()),
                    config: core_pda(&[CONFIG_SEED]),
                    treasury: core_pda(&[TREASURY_SEED]),
                    treasury_account: core_treasury_account(),
                    mint: tesoro_core::state::SIM_SOL_MINT,
                    treasury_vault: core_pda(&[tesoro_core::state::TREASURY_VAULT_SEED]),
                    token_program: TOKEN_PROGRAM_ID,
                    system_program: anchor_lang::system_program::ID,
                },
                tesoro_core::instruction::InitTreasury {
                    yield_fee_bps: 2_000,
                    instant_fee_bps: 3_500,
                },
            )],
            admin,
            &[],
        )
        .expect("init treasury");
        self.send(
            &[ix(
                tesoro_core::ID,
                tesoro_core::accounts::InitStores {
                    payer: a(admin.pubkey()),
                    account: core_treasury_account(),
                    basket: basket_address(&core_treasury_account()).0,
                    spill: spill_address(&core_treasury_account()).0,
                    system_program: anchor_lang::system_program::ID,
                },
                tesoro_core::instruction::InitStores {},
            )],
            admin,
            &[],
        )
        .expect("treasury stores");
    }

    fn peer(&self) -> Pubkey {
        bridge_pda(&[
            PEER_SEED,
            self.store.as_ref(),
            &EID_HOODI.to_be_bytes(),
            &msg_codec::pad_address(&VAULT),
        ])
    }

    fn put<T: AccountSerialize>(&mut self, key: Pubkey, owner: Pubkey, account: &T) {
        let mut data = Vec::new();
        account.try_serialize(&mut data).expect("serialize");
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                s(key),
                solana_sdk::account::Account {
                    lamports,
                    data,
                    owner: s(owner),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("set account");
    }

    fn send(
        &mut self,
        ixs: &[Instruction],
        payer: &Keypair,
        extra: &[&Keypair],
    ) -> std::result::Result<(), Failed> {
        self.send_logs(ixs, payer, extra).map(|_| ())
    }

    /// Sends a transaction and returns its logs.
    fn send_logs(
        &mut self,
        ixs: &[Instruction],
        payer: &Keypair,
        extra: &[&Keypair],
    ) -> std::result::Result<Vec<String>, Failed> {
        self.svm.expire_blockhash();
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&payer.pubkey()),
            &signers,
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).map(|meta| meta.logs)
    }

    fn create_core_account(&mut self, kp: &Keypair, evm_address: [u8; 20]) -> Pubkey {
        let key = a(kp.pubkey());
        let account = core_pda(&[ACCOUNT_SEED, key.as_ref()]);
        self.send(
            &[ix(
                tesoro_core::ID,
                tesoro_core::accounts::CreateAccount {
                    authority: key,
                    account,
                    basket: tesoro_core::storage::basket_address(&account).0,
                    spill: tesoro_core::storage::spill_address(&account).0,
                    invite_gate: tesoro_core::state::invite_gate_pda(),
                    system_program: anchor_lang::system_program::ID,
                    payer: key,
                    sponsor: None,
                },
                tesoro_core::instruction::CreateAccount { evm_address },
            )],
            kp,
            &[],
        )
        .expect("create account");
        account
    }

    fn load<T: anchor_lang::AccountDeserialize>(&self, key: Pubkey) -> T {
        let acct = self.svm.get_account(&s(key)).expect("account exists");
        T::try_deserialize(&mut acct.data.as_slice()).expect("deserialize")
    }

    fn bridge_position(&self, id: u64) -> Pubkey {
        bridge_pda(&[POSITION_SEED, &EID_HOODI.to_be_bytes(), &position_id(id)])
    }

    fn core_position(&self, id: u64) -> Pubkey {
        core_pda(&[tesoro_core::state::POSITION_SEED, &[1], &position_id(id)])
    }

    fn evm_link(&self) -> Pubkey {
        bridge_pda(&[EVM_LINK_SEED, &EVM_ADDRESS])
    }

    /// The inbox as `lz_receive` leaves it after a PositionLocked (seq 1).
    fn receive_locked(&mut self, id: u64, principal: u128) {
        let key = self.bridge_position(id);
        let bump = Pubkey::find_program_address(
            &[POSITION_SEED, &EID_HOODI.to_be_bytes(), &position_id(id)],
            &crate::ID,
        )
        .1;
        self.put(
            key,
            crate::ID,
            &BridgePosition {
                eid: EID_HOODI,
                position_id: position_id(id),
                bump,
                last_in_seq: 1,
                locked_seq: 1,
                owner_evm: EVM_ADDRESS,
                asset: msg_codec::pad_address(&[0xAB; 20]),
                principal,
                horizon_months: 3,
                opened: false,
                last_yield_seq: 0,
                yield_cumulative: 0,
                applied_yield_seq: 0,
                out_seq: 0,
                unlock_sent: false,
                treasury_balance: 0,
                instant_paid: 0,
                report_time: 0,
            },
        );
    }

    /// The inbox after a YieldAccrued with `seq`, `cumulative`, the vault's Treasury balance and its
    /// cumulative Instant payouts.
    fn receive_yield(
        &mut self,
        id: u64,
        seq: u64,
        cumulative: u128,
        treasury_balance: u128,
        instant_paid: u128,
    ) {
        let key = self.bridge_position(id);
        let mut p: BridgePosition = self.load(key);
        p.last_yield_seq = seq;
        p.yield_cumulative = cumulative;
        p.treasury_balance = treasury_balance;
        p.instant_paid = instant_paid;
        p.report_time = REPORT_EPOCH + seq; // one second per seq
        p.last_in_seq = p.last_in_seq.max(seq);
        self.put(key, crate::ID, &p);
    }

    /// `link_evm` with another wallet (`payer`, a relayer) paying the rent and the fee; the owner only signs.
    fn link_paid_by(
        &mut self,
        payer: &Keypair,
        signature: &[u8],
    ) -> std::result::Result<(), Failed> {
        let owner = self.owner.insecure_clone();
        let mut sig = [0u8; 65];
        sig.copy_from_slice(&signature[..65]);
        let link = ix(
            crate::ID,
            crate::accounts::LinkEvm {
                authority: a(owner.pubkey()),
                owner_account: self.owner_account,
                evm_link: bridge_pda(&[EVM_LINK_SEED, &EVM_ADDRESS]),
                system_program: anchor_lang::system_program::ID,
                payer: a(payer.pubkey()),
            },
            crate::instruction::LinkEvm {
                params: LinkEvmParams { evm_address: EVM_ADDRESS, signature: sig },
            },
        );
        self.send(&[link], payer, &[&owner])
    }

    fn link(&mut self, evm_address: [u8; 20], signature: &[u8]) -> std::result::Result<(), Failed> {
        let owner = self.owner.insecure_clone();
        let mut sig = [0u8; 65];
        sig.copy_from_slice(&signature[..65]);
        let link = ix(
            crate::ID,
            crate::accounts::LinkEvm {
                authority: a(owner.pubkey()),
                owner_account: self.owner_account,
                evm_link: bridge_pda(&[EVM_LINK_SEED, &evm_address]),
                system_program: anchor_lang::system_program::ID,
                payer: a(owner.pubkey()),
            },
            crate::instruction::LinkEvm { params: LinkEvmParams { evm_address, signature: sig } },
        );
        self.send(&[link], &owner, &[])
    }

    fn apply_locked(&mut self, id: u64) -> std::result::Result<(), Failed> {
        let payer = self.admin.insecure_clone();
        let apply = ix(
            crate::ID,
            crate::accounts::ApplyLocked {
                payer: a(payer.pubkey()),
                store: self.store,
                peer: self.peer(),
                bridge_position: self.bridge_position(id),
                authority: self.authority,
                evm_link: self.evm_link(),
                owner_account: self.owner_account,
                core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                core_position: self.core_position(id),
                core_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::ApplyLocked {
                params: PositionRef { eid: EID_HOODI, position_id: position_id(id) },
            },
        );
        self.send(&[apply], &payer, &[])
    }

    fn take_advance(&mut self, id: u64) {
        let oracle = self.oracle.insecure_clone();
        let owner = self.owner.insecure_clone();
        let position = self.core_position(id);
        let source = core_pda(&[SOURCE_SEED, position.as_ref(), &0u32.to_le_bytes()]);
        let mut advance = ix(
            tesoro_core::ID,
            tesoro_core::accounts::TakeAdvance {
                oracle: a(oracle.pubkey()),
                owner_authority: a(owner.pubkey()),
                config: core_pda(&[CONFIG_SEED]),
                treasury: core_pda(&[TREASURY_SEED]),
                owner_account: self.owner_account,
                position,
                source,
                book: book_address(&source).0,
                basket: basket_address(&self.owner_account).0,
                spill: spill_address(&self.owner_account).0,
                protections: core_pda(&[PROTECTIONS_SEED, self.owner_account.as_ref()]),
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::TakeAdvance {
                horizon_months: 3,
                price_micro_usd: 3_000_000_000,
                min_gemas: 1,
            },
        );
        // The asset's `OnchainPrice` address: `take_advance` fails when that account exists.
        advance.accounts.push(AccountMeta {
            pubkey: s(core_pda(&[ONCHAIN_PRICE_SEED, &msg_codec::pad_address(&[0xAB; 20])])),
            is_signer: false,
            is_writable: false,
        });
        self.send(&[advance], &oracle, &[&owner]).expect("advance");
        self.ensure_pages(source);
    }

    /// Creates page 0 of every class of the Source that writes checkpoint records (anyone pays),
    /// so a landing that closes a segment finds somewhere to write it.
    fn ensure_pages(&mut self, source: Pubkey) {
        let n_ext = econ::read_book(&self.svm, source).n_ext;
        let payer = self.admin.insecure_clone();
        for class in std::iter::once(1u8).chain(3..4 + n_ext) {
            let page = ckpt_address(&source, class, 0).0;
            if self.svm.get_account(&s(page)).is_some() {
                continue;
            }
            let init = ix(
                tesoro_core::ID,
                tesoro_core::accounts::InitCkptPage {
                    payer: a(payer.pubkey()),
                    book: book_address(&source).0,
                    page,
                    system_program: anchor_lang::system_program::ID,
                },
                tesoro_core::instruction::InitCkptPage { class, page_no: 0 },
            );
            self.send(&[init], &payer, &[]).expect("checkpoint page");
        }
    }

    /// Gemas of the Source still to be repaid, as the Source's book counts them.
    fn debt(&self, source: Pubkey) -> u64 {
        tesoro_core::ledger::book::fp_ceil(econ::read_book(&self.svm, source).uncovered_total())
            as u64
    }

    /// Whole Gemas the first-Advance line of `account` can Redeem now.
    fn redeemable(&self, account: Pubkey, source: Pubkey, side: u8) -> u64 {
        let book = econ::read_book(&self.svm, source);
        let line = econ::find_line(&self.svm, account, source, side, 3, 0).expect("line");
        let pages = econ::SvmPages { svm: &self.svm, source };
        book.redeemable(&book.peek(&line, &pages).expect("peek")).expect("redeemable")
    }

    fn source_of(&self, id: u64) -> Pubkey {
        core_pda(&[SOURCE_SEED, self.core_position(id).as_ref(), &0u32.to_le_bytes()])
    }

    /// The first-Advance line of `account` on `side` (General class, first tranche).
    fn line_ref(&self, account: Pubkey, source: Pubkey, side: u8) -> LineRef {
        let l = econ::find_line(&self.svm, account, source, side, 3, 0).expect("line");
        LineRef { side, due_at: l.due_at, class: 3, tranche: 0 }
    }

    fn apply_yield(&mut self, id: u64, with_source: bool) -> std::result::Result<(), Failed> {
        let payer = self.admin.insecure_clone();
        let position = self.core_position(id);
        let source = core_pda(&[SOURCE_SEED, position.as_ref(), &0u32.to_le_bytes()]);
        let mut apply = ix(
            crate::ID,
            crate::accounts::ApplyYield {
                store: self.store,
                bridge_position: self.bridge_position(id),
                vault_treasury: self.vault_treasury(),
                authority: self.authority,
                core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                core_position: position,
                core_source: with_source.then_some(source),
                core_program: tesoro_core::ID,
            },
            crate::instruction::ApplyYield {
                params: PositionRef { eid: EID_HOODI, position_id: position_id(id) },
            },
        );
        if with_source {
            apply.accounts.extend(econ::book_metas(&self.svm, source));
        }
        self.send(&[apply], &payer, &[])
    }
}

#[test]
fn link_evm_needs_the_accounts_address_and_the_wallets_signature() {
    let mut env = Env::new();
    let sig = hex(LINK_SIGNATURE);
    env.link(EVM_ADDRESS, &[0u8; 65]).expect_err("garbage signature");
    let err = env.link([9u8; 20], &sig).expect_err("address not on the Account");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::EvmAddressMismatch)));
    env.link(EVM_ADDRESS, &sig).expect("valid proof links the address");
    let link: EvmLink = env.load(env.evm_link());
    assert_eq!(link.account, env.owner_account);
    assert_eq!(link.evm_address, EVM_ADDRESS);
}

#[test]
fn link_evm_can_be_paid_by_a_relayer_for_an_owner_with_no_lamports() {
    let mut env = Env::new();
    let relayer = Keypair::new();
    env.svm.airdrop(&relayer.pubkey(), 5_000_000_000).unwrap();
    let owner = env.owner.pubkey();
    let owner_before = env.svm.get_balance(&owner).unwrap_or(0);
    let before = env.svm.get_balance(&relayer.pubkey()).unwrap();
    env.link_paid_by(&relayer, &hex(LINK_SIGNATURE)).expect("the relayer pays");
    let link: EvmLink = env.load(env.evm_link());
    assert_eq!(link.authority, a(owner));
    assert_eq!(env.svm.get_balance(&owner).unwrap_or(0), owner_before, "the owner paid nothing");
    assert!(
        before - env.svm.get_balance(&relayer.pubkey()).unwrap() > 1_000_000,
        "the relayer paid the rent"
    );
}

#[test]
fn positions_open_yield_repays_debt_and_redemption_is_recorded_once_per_unit() {
    let mut env = Env::new();
    let id = 1;
    env.receive_locked(id, ETH);

    // Not linked yet: the owner cannot be resolved.
    env.apply_locked(id).expect_err("no EvmLink");
    env.link(EVM_ADDRESS, &hex(LINK_SIGNATURE)).expect("link");

    env.apply_locked(id)
        .expect("bridge opens the Position through the source authority");
    let position: PositionState = env.load(env.core_position(id));
    assert_eq!(position.inner.owner, env.owner_account.to_bytes());
    assert_eq!(position.inner.source_chain, SourceChain::Ethereum);
    assert_eq!(position.inner.principal, 1_000_000_000_000_000_000);
    assert_eq!(position.inner.decimals, 18);
    assert_eq!(position.inner.rate_bps, 500);
    assert!(env.load::<BridgePosition>(env.bridge_position(id)).opened);
    let err = env.apply_locked(id).expect_err("a Position opens once");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::AlreadyOpened)));

    // Advance (oracle price): 5% of 1 ETH over 3 months = 0.0125 ETH, 80% of it after the Yield
    // Fee = 0.01 ETH = $30 = 3,000 Gemas.
    env.take_advance(id);
    let source_key = core_pda(&[SOURCE_SEED, env.core_position(id).as_ref(), &0u32.to_le_bytes()]);
    assert_eq!(econ::gemas_in(&env.svm, env.owner_account, source_key), 3_000);
    assert_eq!(env.debt(source_key), 3_000);

    // No yield reported yet.
    let err = env.apply_yield(id, true).expect_err("nothing to apply");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::NothingToApply)));

    // Half of the projected net yield arrives (the vault reports yield after its Yield Fee): Debt
    // halves.
    env.receive_yield(id, 2, 5_000_000_000_000_000, 0, 0);
    env.apply_yield(id, false).expect_err("the open Advance's Source is required");
    env.apply_yield(id, true).expect("apply yield");
    assert_eq!(env.debt(source_key), 1_500);
    assert_eq!(env.redeemable(env.owner_account, source_key, SIDE_OWN), 1_500);
    let err = env.apply_yield(id, true).expect_err("applied once");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::NothingToApply)));

    // F-07: plain `redeem` on tesoro_core would burn the Gemas with no payout recorded; it is refused.
    {
        let mut plain = ix(
            tesoro_core::ID,
            tesoro_core::accounts::Redeem {
                holder_authority: a(env.owner.pubkey()),
                holder_account: env.owner_account,
                basket: basket_address(&env.owner_account).0,
                spill: spill_address(&env.owner_account).0,
                position: env.core_position(id),
                source: source_key,
            },
            tesoro_core::instruction::Redeem {
                line: env.line_ref(env.owner_account, source_key, SIDE_OWN),
                amount: 1_000,
            },
        );
        plain.accounts.extend(econ::book_metas(&env.svm, source_key));
        let owner = env.owner.insecure_clone();
        let err = env.send(&[plain], &owner, &[]).expect_err("plain redeem is refused");
        assert_eq!(custom_code(&err), Some(6012), "BridgedSource");
        assert_eq!(
            econ::gemas_in(&env.svm, env.owner_account, source_key),
            3_000,
            "nothing was burned"
        );
    }

    // Redeem 1,000 Gemas through the bridge: recorded as a claim of source units.
    let owner = env.owner.insecure_clone();
    let redeem = |env: &mut Env, gemas: u64| {
        let position = env.core_position(id);
        let claim = bridge_pda(&[CLAIM_SEED, env.owner_account.as_ref(), source_key.as_ref()]);
        let mut redeem = ix(
            crate::ID,
            crate::accounts::RedeemToEvm {
                holder_authority: a(owner.pubkey()),
                store: env.store,
                authority: env.authority,
                core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                holder_account: env.owner_account,
                core_position: position,
                core_source: source_key,
                core_basket: basket_address(&env.owner_account).0,
                core_spill: spill_address(&env.owner_account).0,
                claim,
                core_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::RedeemToEvm {
                line: env.line_ref(env.owner_account, source_key, SIDE_OWN),
                gemas,
            },
        );
        redeem.accounts.extend(econ::book_metas(&env.svm, source_key));
        env.send(&[redeem], &owner, &[])
    };
    redeem(&mut env, 1_000).expect("redeem");
    let claim_key = bridge_pda(&[CLAIM_SEED, env.owner_account.as_ref(), source_key.as_ref()]);
    let claim: Claim = env.load(claim_key);
    let source: SourceState = env.load(source_key);
    assert_eq!(claim.gemas_total, 1_000);
    assert_eq!(claim.units_total, source.inner.redeemed_units);
    // 1,000 Gemas at $3,000 per ETH = $10 = 0.003333... ETH, floored to whole wei.
    assert_eq!(claim.units_total, 3_333_333_333_333_333);
    assert_eq!(claim.units_sent, 0);
    assert_eq!(claim.position, env.core_position(id));

    redeem(&mut env, 500).expect("redeem the rest of what is redeemable");
    let claim: Claim = env.load(claim_key);
    assert_eq!(claim.gemas_total, 1_500);
    redeem(&mut env, 1).expect_err("nothing redeemable beyond accrued yield");

    // Gemas holders are credited nothing on Solana: the Gemas are burned by the redeem.
    assert_eq!(econ::gemas_in(&env.svm, env.owner_account, source_key), 3_000 - 1_500);
}

#[test]
fn a_position_too_large_for_tesoro_core_is_refused_not_truncated() {
    let mut env = Env::new();
    env.receive_locked(2, u128::from(u64::MAX) + 1);
    env.link(EVM_ADDRESS, &hex(LINK_SIGNATURE)).expect("link");
    let err = env.apply_locked(2).expect_err("principal exceeds u64");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::AmountOverflow)));
}

fn set_admin_ix(env: &Env, signer: &Keypair, new_admin: Pubkey) -> Instruction {
    ix(
        crate::ID,
        crate::accounts::SetAdmin {
            authority: a(signer.pubkey()),
            store: env.store,
            program: crate::ID,
            program_data: env.programdata,
        },
        crate::instruction::SetAdmin { new_admin },
    )
}

fn store_admin(env: &Env) -> Pubkey {
    let acct = env.svm.get_account(&s(env.store)).expect("store");
    Store::try_deserialize(&mut acct.data.as_slice()).expect("deserialize").admin
}

// Registers a second vault, so the PeerConfig PDA is created with the real account size.
fn peer_ix(env: &Env, admin: &Keypair) -> Instruction {
    let vault = msg_codec::pad_address(&[0x6c; 20]);
    let peer = bridge_pda(&[PEER_SEED, env.store.as_ref(), &EID_HOODI.to_be_bytes(), &vault]);
    ix(
        crate::ID,
        crate::accounts::SetPeerConfig {
            admin: a(admin.pubkey()),
            peer,
            vault_treasury: bridge_pda(&[TREASURY_SEED, &EID_HOODI.to_be_bytes(), &vault]),
            route: bridge_pda(&[ROUTE_SEED, &EID_HOODI.to_be_bytes(), &vault]),
            store: env.store,
            system_program: anchor_lang::system_program::ID,
        },
        crate::instruction::SetPeerConfig {
            params: SetPeerConfigParams {
                remote_eid: EID_HOODI,
                peer_address: vault,
                decimals: 18,
                rate_bps: 500,
                enforced_send_options: vec![0, 3],
            },
        },
    )
}

// Audit 2026-10-16 B-3. The bridge knew only the testnet LayerZero ids, so on mainnet
// `set_peer_config` refused every vault (Ethereum 30101, HyperEVM 30367) and nothing could open.
#[test]
fn vaults_on_the_mainnet_layerzero_ids_register() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    for (eid, vault) in [(30_101u32, [0x11; 20]), (30_367u32, [0x22; 20])] {
        let vault = msg_codec::pad_address(&vault);
        let ixn = ix(
            crate::ID,
            crate::accounts::SetPeerConfig {
                admin: a(admin.pubkey()),
                peer: bridge_pda(&[PEER_SEED, env.store.as_ref(), &eid.to_be_bytes(), &vault]),
                vault_treasury: bridge_pda(&[TREASURY_SEED, &eid.to_be_bytes(), &vault]),
                route: bridge_pda(&[ROUTE_SEED, &eid.to_be_bytes(), &vault]),
                store: env.store,
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::SetPeerConfig {
                params: SetPeerConfigParams {
                    remote_eid: eid,
                    peer_address: vault,
                    decimals: 18,
                    rate_bps: 500,
                    enforced_send_options: vec![0, 3],
                },
            },
        );
        env.send(&[ixn], &admin, &[])
            .unwrap_or_else(|e| panic!("eid {eid} must register: {:?}", e.meta.logs));
    }
    assert!(matches!(core_chain(30_101), Ok(SourceChain::Ethereum)));
    assert!(matches!(core_chain(30_367), Ok(SourceChain::HyperEvm)));
    assert!(core_chain(30_168).is_err(), "Solana's own id is not a source chain");
}

#[test]
fn only_the_upgrade_authority_may_rotate_the_bridge_admin() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let err = env
        .send(&[set_admin_ix(&env, &admin, a(admin.pubkey()))], &admin, &[])
        .expect_err("the admin is not the upgrade authority");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::Unauthorized)));
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    let err = env
        .send(&[set_admin_ix(&env, &stranger, a(stranger.pubkey()))], &stranger, &[])
        .expect_err("a stranger");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::Unauthorized)));
    assert_eq!(store_admin(&env), a(admin.pubkey()));
}

// Needs the LayerZero endpoint binary (`solana program dump 76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6
// endpoint.so`); set LZ_ENDPOINT_SO to its path.
#[test]
fn rotation_moves_the_store_admin_and_the_endpoint_delegate() {
    let Ok(endpoint_so) = std::env::var("LZ_ENDPOINT_SO") else {
        eprintln!("skipped: LZ_ENDPOINT_SO not set");
        return;
    };
    let mut env = Env::new();
    let endpoint = oapp::endpoint::ID;
    env.svm
        .add_program_from_file(s(endpoint), endpoint_so)
        .expect("load the endpoint");
    let (_, store_bump) = Pubkey::find_program_address(&[STORE_SEED], &crate::ID);
    let (_, authority_bump) = Pubkey::find_program_address(&[AUTHORITY_SEED], &crate::ID);
    let old_admin = a(env.admin.pubkey());
    env.put(
        env.store,
        crate::ID,
        &Store { admin: old_admin, endpoint_program: endpoint, bump: store_bump, authority_bump },
    );
    // The OApp registry `register_oapp` created at init_store: [delegate, bump] after the
    // Anchor discriminator.
    let (registry, registry_bump) =
        Pubkey::find_program_address(&[b"OApp", env.store.as_ref()], &endpoint);
    let mut data =
        anchor_lang::solana_program::hash::hash(b"account:OAppRegistry").to_bytes()[..8].to_vec();
    data.extend_from_slice(old_admin.as_ref());
    data.push(registry_bump);
    env.svm
        .set_account(
            s(registry),
            solana_sdk::account::Account {
                lamports: 10_000_000,
                data,
                owner: s(endpoint),
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("set registry");
    let (event_authority, _) = Pubkey::find_program_address(&[b"__event_authority"], &endpoint);

    let new_admin = Keypair::new();
    env.svm.airdrop(&new_admin.pubkey(), SOL).expect("airdrop");
    let authority = env.upgrade_authority.insecure_clone();
    let mut rotate = set_admin_ix(&env, &authority, a(new_admin.pubkey()));
    rotate.accounts.extend([
        AccountMeta::new_readonly(s(endpoint), false),
        AccountMeta::new_readonly(s(env.store), false),
        AccountMeta::new(s(registry), false),
        AccountMeta::new_readonly(s(event_authority), false),
        AccountMeta::new_readonly(s(endpoint), false),
    ]);
    env.send(&[rotate], &authority, &[]).expect("rotate");

    assert_eq!(store_admin(&env), a(new_admin.pubkey()));
    let reg = env.svm.get_account(&s(registry)).expect("registry");
    assert_eq!(&reg.data[8..40], a(new_admin.pubkey()).as_ref());

    let old = env.admin.insecure_clone();
    assert!(env.send(&[peer_ix(&env, &old)], &old, &[]).is_err());
    env.send(&[peer_ix(&env, &new_admin)], &new_admin, &[])
        .expect("the new admin acts");
}

// --- Instant Redeem and the Treasury (ADR 0007) ----------------------------------------------

impl Env {
    /// An Account with an EVM address that holds `n` of the owner's Gemas of Position `id`'s first
    /// Source as won Gemas (as after a Match; settlement is covered in tesoro_core).
    fn winner_with(&mut self, id: u64, n: u64) -> (Keypair, Pubkey, Pubkey) {
        let winner = Keypair::new();
        self.svm.airdrop(&winner.pubkey(), 10 * SOL).expect("airdrop");
        let account = self.create_core_account(&winner, [0x77; 20]);
        let source = self.source_of(id);
        econ::win(&mut self.svm, source, self.owner_account, account, 3, 0, n);
        (winner, account, source)
    }

    fn order_address(&self, account: Pubkey, nonce: u64) -> Pubkey {
        core_pda(&[INSTANT_ORDER_SEED, account.as_ref(), &nonce.to_le_bytes()])
    }

    /// The seller puts `gemas` of their won Gemas into an order on tesoro_core.
    fn request_instant(
        &mut self,
        id: u64,
        holder: &Keypair,
        account: Pubkey,
        source: Pubkey,
        gemas: u64,
        nonce: u64,
    ) -> std::result::Result<(), Failed> {
        self.request_instant_line(id, holder, account, source, gemas, nonce, SIDE_WON)
    }

    #[allow(clippy::too_many_arguments)]
    fn request_instant_line(
        &mut self,
        id: u64,
        holder: &Keypair,
        account: Pubkey,
        source: Pubkey,
        gemas: u64,
        nonce: u64,
        side: u8,
    ) -> std::result::Result<(), Failed> {
        let mut request = ix(
            tesoro_core::ID,
            tesoro_core::accounts::RequestInstantRedeem {
                payer: a(holder.pubkey()),
                holder_authority: a(holder.pubkey()),
                holder_account: account,
                basket: basket_address(&account).0,
                spill: spill_address(&account).0,
                position: self.core_position(id),
                source,
                order: self.order_address(account, nonce),
                sponsor: None,
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::RequestInstantRedeem {
                line: self.line_ref(account, source, side),
                sell: gemas,
                ttl_secs: 7 * 86_400,
                nonce,
            },
        );
        request.accounts.extend(econ::book_metas(&self.svm, source));
        self.send(&[request], holder, &[])
    }

    /// Tesoro (the bridge's store admin) fills `gemas` of an order, within the vault treasury's
    /// mirror.
    fn fill_instant(
        &mut self,
        id: u64,
        owner: &Keypair,
        account: Pubkey,
        source: Pubkey,
        nonce: u64,
        gemas: u64,
    ) -> std::result::Result<(), Failed> {
        let filler = self.admin.insecure_clone();
        self.fill_instant_as(id, owner, account, source, nonce, gemas, &filler)
    }

    #[allow(clippy::too_many_arguments)]
    fn fill_instant_as(
        &mut self,
        id: u64,
        owner: &Keypair,
        account: Pubkey,
        source: Pubkey,
        nonce: u64,
        gemas: u64,
        filler: &Keypair,
    ) -> std::result::Result<(), Failed> {
        let mut fill = ix(
            crate::ID,
            crate::accounts::InstantRedeemToEvm {
                filler: a(filler.pubkey()),
                store: self.store,
                authority: self.authority,
                core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                core_order: self.order_address(account, nonce),
                owner_wallet: a(owner.pubkey()),
                holder_account: account,
                core_position: self.core_position(id),
                core_source: source,
                core_treasury: core_pda(&[TREASURY_SEED]),
                core_treasury_account: core_treasury_account(),
                core_treasury_basket: basket_address(&core_treasury_account()).0,
                core_treasury_spill: spill_address(&core_treasury_account()).0,
                vault_treasury: self.vault_treasury(),
                instant_claim: bridge_pda(&[INSTANT_SEED, account.as_ref(), source.as_ref()]),
                core_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::InstantRedeemToEvm { gemas },
        );
        fill.accounts.extend(econ::book_metas(&self.svm, source));
        self.send(&[fill], filler, &[])
    }

    fn sync_treasury(&mut self, id: u64) -> std::result::Result<(), Failed> {
        let payer = self.admin.insecure_clone();
        let sync = ix(
            crate::ID,
            crate::accounts::SyncTreasury {
                bridge_position: self.bridge_position(id),
                vault_treasury: self.vault_treasury(),
            },
            crate::instruction::SyncTreasury {
                params: PositionRef { eid: EID_HOODI, position_id: position_id(id) },
            },
        );
        self.send(&[sync], &payer, &[])
    }

    /// An opened Position `id` with its 3,000-Gema Advance.
    fn opened_with_advance(&mut self, id: u64) {
        self.receive_locked(id, ETH);
        self.link(EVM_ADDRESS, &hex(LINK_SIGNATURE)).expect("link");
        self.apply_locked(id).expect("open");
        self.take_advance(id);
    }
}

/// What a filled order pays: the Gemas' value in source units less the Instant Redeem Fee.
fn instant_payout(units: u64) -> u64 {
    (u128::from(units) * u128::from(10_000 - tesoro_core::ledger::INSTANT_REDEEM_FEE_BPS) / 10_000)
        as u64
}

#[test]
fn instant_redeem_is_capped_by_the_mirror_of_the_vault_treasury() {
    let mut env = Env::new();
    let id = 1;
    env.opened_with_advance(id);
    let (bob, bob_account, source) = env.winner_with(id, 1_000);
    // 1,000 Gemas at $3,000/ETH are worth 0.003333... ETH; the Instant Redeem Fee comes off it.
    let units: u64 = 3_333_333_333_333_333;
    let payout = instant_payout(units);
    env.request_instant(id, &bob, bob_account, source, 1_000, 1).expect("order");
    assert_eq!(econ::gemas_in(&env.svm, bob_account, source), 0, "the order holds the Gemas");

    // The vault has reported no treasury yet: refused, and nothing moved.
    env.fill_instant(id, &bob, bob_account, source, 1, 1_000).expect_err("empty");
    assert_eq!(econ::gemas_in(&env.svm, core_treasury_account(), source), 0);

    // A yield report carries a treasury just short of the payout: still refused.
    env.receive_yield(id, 2, 1_000_000_000_000_000, u128::from(payout) - 1, 0);
    env.sync_treasury(id).expect("sync");
    assert_eq!(env.load::<VaultTreasury>(env.vault_treasury()).balance, u128::from(payout) - 1);
    env.fill_instant(id, &bob, bob_account, source, 1, 1_000).expect_err("short");
    assert_eq!(econ::gemas_in(&env.svm, core_treasury_account(), source), 0);

    // A later report (synced without applying) covers it: accepted and recorded.
    env.receive_yield(id, 3, 1_000_000_000_000_000, u128::from(payout) + 100, 0);
    env.sync_treasury(id).expect("sync");
    env.fill_instant(id, &bob, bob_account, source, 1, 1_000).expect("fill");
    let treasury: VaultTreasury = env.load(env.vault_treasury());
    assert_eq!(treasury.instant_recorded, u128::from(payout));
    assert_eq!(treasury.available(), 100);
    let claim: InstantClaim =
        env.load(bridge_pda(&[INSTANT_SEED, bob_account.as_ref(), source.as_ref()]));
    assert_eq!((claim.gemas_total, claim.units_total, claim.units_sent), (1_000, payout, 0));
    assert_eq!(claim.position, env.core_position(id));
    assert_eq!(econ::gemas_in(&env.svm, core_treasury_account(), source), 1_000);
    assert!(
        econ::find_line(&env.svm, core_treasury_account(), source, SIDE_WON, 3, 0).is_some(),
        "the Treasury took the Gemas as won Gemas"
    );
    let source_state: SourceState = env.load(source);
    assert_eq!(source_state.inner.redeemed, 0, "the Source's counts are untouched");
    assert!(env.svm.get_account(&s(env.order_address(bob_account, 1))).is_none(), "order closed");

    // The rest of the treasury cannot pay another 1,000.
    let (carol, carol_account, _) = env.winner_with(id, 1_000);
    env.request_instant(id, &carol, carol_account, source, 1_000, 1).expect("order");
    env.fill_instant(id, &carol, carol_account, source, 1, 1_000)
        .expect_err("spent");

    // Once the vault has paid and reports its new balance (100 left, payout paid), nothing is outstanding.
    env.receive_yield(id, 4, 1_000_000_000_000_000, 100, u128::from(payout));
    env.sync_treasury(id).expect("sync");
    assert_eq!(env.load::<VaultTreasury>(env.vault_treasury()).available(), 100);

    // Only the filler (the store admin) may fill.
    let err = env
        .fill_instant_as(id, &carol, carol_account, source, 1, 10, &carol)
        .expect_err("not admin");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::Unauthorized)));

    // The owner's own Gemas never redeem instantly.
    let owner = env.owner.insecure_clone();
    let owner_account = env.owner_account;
    env.request_instant_line(id, &owner, owner_account, source, 10, 9, SIDE_OWN)
        .expect_err("own Gemas");
}

#[test]
fn the_treasury_redeems_what_it_bought_into_a_claim_paid_to_the_vault() {
    let mut env = Env::new();
    let id = 1;
    env.opened_with_advance(id);
    let (bob, bob_account, source) = env.winner_with(id, 1_000);
    env.receive_yield(id, 2, 0, ETH, 0);
    env.sync_treasury(id).expect("sync");
    env.request_instant(id, &bob, bob_account, source, 1_000, 1).expect("order");
    env.fill_instant(id, &bob, bob_account, source, 1, 1_000).expect("fill");

    let payer = env.admin.insecure_clone();
    let treasury_account = core_treasury_account();
    let claim_key = bridge_pda(&[CLAIM_SEED, treasury_account.as_ref(), source.as_ref()]);
    let redeem = |env: &mut Env, gemas: u64| {
        let mut redeem = ix(
            crate::ID,
            crate::accounts::RedeemTreasuryToEvm {
                payer: a(payer.pubkey()),
                store: env.store,
                authority: env.authority,
                core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                core_treasury: core_pda(&[TREASURY_SEED]),
                core_treasury_account: treasury_account,
                core_treasury_basket: basket_address(&treasury_account).0,
                core_treasury_spill: spill_address(&treasury_account).0,
                core_position: env.core_position(id),
                core_source: source,
                claim: claim_key,
                core_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::RedeemTreasuryToEvm {
                line: env.line_ref(treasury_account, source, SIDE_WON),
                gemas,
            },
        );
        redeem.accounts.extend(econ::book_metas(&env.svm, source));
        env.send(&[redeem], &payer, &[])
    };
    // Nothing has accrued: the Treasury waits like every other holder.
    redeem(&mut env, 1).expect_err("not redeemable yet");

    // All the net yield lands: the Treasury redeems its 1,000 Gemas at full value.
    env.receive_yield(id, 3, 10_000_000_000_000_000, ETH, 0);
    env.apply_yield(id, true).expect("apply yield");
    redeem(&mut env, 1_000).expect("treasury redeems");
    let claim: Claim = env.load(claim_key);
    assert_eq!(claim.holder_account, treasury_account);
    assert_eq!(claim.units_total, 3_333_333_333_333_333, "full value, not 75%");
    assert_eq!(econ::gemas_in(&env.svm, treasury_account, source), 0);
    // The Treasury Account is the one whose PayYield goes to the vault itself.
    let treasury_state: TesoroAccount = env.load(treasury_account);
    assert_eq!(treasury_state.authority, core_pda(&[TREASURY_SEED]));
    assert_eq!(core_treasury_account(), treasury_account);
}

#[test]
fn normal_redeem_through_the_bridge_is_unchanged_by_instant_redeems() {
    let mut env = Env::new();
    let id = 1;
    env.opened_with_advance(id);
    let (bob, bob_account, source) = env.winner_with(id, 1_000);
    // Only Gemas whose yield has not landed can be redeemed instantly: the Report's Treasury is
    // mirrored first and the yield is applied afterwards.
    env.receive_yield(id, 2, 10_000_000_000_000_000, ETH, 0);
    env.sync_treasury(id).expect("sync");
    env.request_instant(id, &bob, bob_account, source, 400, 1).expect("order");
    env.fill_instant(id, &bob, bob_account, source, 1, 400).expect("fill 400");
    env.apply_yield(id, true).expect("apply yield");
    // Bob redeems his other 600 at full value through the normal path.
    let claim = bridge_pda(&[CLAIM_SEED, bob_account.as_ref(), source.as_ref()]);
    let mut redeem = ix(
        crate::ID,
        crate::accounts::RedeemToEvm {
            holder_authority: a(bob.pubkey()),
            store: env.store,
            authority: env.authority,
            core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
            holder_account: bob_account,
            core_position: env.core_position(id),
            core_source: source,
            core_basket: basket_address(&bob_account).0,
            core_spill: spill_address(&bob_account).0,
            claim,
            core_program: tesoro_core::ID,
            system_program: anchor_lang::system_program::ID,
        },
        crate::instruction::RedeemToEvm {
            line: env.line_ref(bob_account, source, SIDE_WON),
            gemas: 600,
        },
    );
    redeem.accounts.extend(econ::book_metas(&env.svm, source));
    env.send(&[redeem], &bob, &[]).expect("normal redeem");
    let claim: Claim = env.load(claim);
    // 600 Gemas at $3,000/ETH = $6 = 0.002 ETH; the book pays whole shares, so a unit may fall
    // short of the exact figure by one but never exceed it.
    assert!(
        (1_999_999_999_999_999..=2_000_000_000_000_000).contains(&claim.units_total),
        "paid {}",
        claim.units_total
    );
}

#[test]
fn an_order_with_repaid_gemas_is_not_filled_through_the_bridge() {
    let mut env = Env::new();
    let id = 1;
    env.opened_with_advance(id);
    let (bob, bob_account, source) = env.winner_with(id, 1_000);
    env.request_instant(id, &bob, bob_account, source, 1_000, 1).expect("order");
    // The yield lands while the order is open: its Gemas are now repaid. A fill would Redeem them
    // at full value, a payout only `redeem_to_evm` records, so the fill is refused whole.
    env.receive_yield(id, 2, 5_000_000_000_000_000, ETH, 0);
    env.sync_treasury(id).expect("sync");
    env.apply_yield(id, true).expect("apply yield");
    let err = env.fill_instant(id, &bob, bob_account, source, 1, 100).expect_err("ready");
    assert_eq!(custom_code(&err), Some(6012), "BridgedSource");
    assert_eq!(env.load::<VaultTreasury>(env.vault_treasury()).instant_recorded, 0);
    assert!(env.svm.get_account(&s(env.order_address(bob_account, 1))).is_some(), "order open");
    assert_eq!(econ::gemas_in(&env.svm, core_treasury_account(), source), 0);
}

// --- Cash-in batches, the prize escrow and the messages around them (ticket 16) --------------

fn b64_decode(text: &str) -> Vec<u8> {
    let value = |c: u8| -> u32 {
        match c {
            b'A'..=b'Z' => u32::from(c - b'A'),
            b'a'..=b'z' => u32::from(c - b'a') + 26,
            b'0'..=b'9' => u32::from(c - b'0') + 52,
            b'+' => 62,
            _ => 63,
        }
    };
    let bytes: Vec<u8> = text.bytes().filter(|c| *c != b'=').collect();
    let mut out = Vec::new();
    for chunk in bytes.chunks(4) {
        let mut acc = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            acc |= value(*c) << (18 - 6 * i as u32);
        }
        out.push((acc >> 16) as u8);
        if chunk.len() > 2 {
            out.push((acc >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(acc as u8);
        }
    }
    out
}

/// The message the bridge handed the (mock) endpoint's `send`: the mock logs the instruction data
/// (`Program data:`), which is the 8-byte discriminator, then `SendParams`.
fn sent_messages(logs: &[String]) -> Vec<Vec<u8>> {
    let disc = anchor_lang::solana_program::hash::hash(b"global:send").to_bytes();
    logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .map(b64_decode)
        .filter(|d| d.len() > 48 && d[..8] == disc[..8])
        .map(|d| {
            // dst_eid u32 | receiver [32] | message: u32 length + bytes
            let len = u32::from_le_bytes(d[44..48].try_into().expect("length")) as usize;
            d[48..48 + len].to_vec()
        })
        .collect()
}

fn vault_word() -> [u8; 32] {
    msg_codec::pad_address(&VAULT)
}

fn yield_message(id: u64, seq: u64, cumulative: u128, escrow: Option<(u128, u128)>) -> Vec<u8> {
    let mut buf = Vec::new();
    msg_codec::encode_header(
        &msg_codec::Header {
            msg_type: msg_codec::MSG_YIELD_ACCRUED,
            source_chain: EID_HOODI,
            position_id: position_id(id),
            seq,
        },
        &mut buf,
    );
    buf.extend_from_slice(&cumulative.to_be_bytes());
    buf.extend_from_slice(&0u128.to_be_bytes());
    buf.extend_from_slice(&0u128.to_be_bytes());
    buf.extend_from_slice(&(REPORT_EPOCH + seq).to_be_bytes());
    if let Some((shares, units)) = escrow {
        buf.extend_from_slice(&shares.to_be_bytes());
        buf.extend_from_slice(&units.to_be_bytes());
    }
    buf
}

fn route_header(msg_type: u8, id: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    msg_codec::encode_header(
        &msg_codec::Header {
            msg_type,
            source_chain: EID_HOODI,
            position_id: msg_codec::route_word(&vault_word()),
            seq: id,
        },
        &mut buf,
    );
    buf
}

fn batch_result(batch_id: u64, paid: &[u128], shares: u128, units: u128) -> Vec<u8> {
    let mut buf = route_header(msg_codec::MSG_BATCH_RESULT, batch_id);
    buf.push(paid.len() as u8);
    for p in paid {
        buf.extend_from_slice(&p.to_be_bytes());
    }
    buf.extend_from_slice(&shares.to_be_bytes());
    buf.extend_from_slice(&units.to_be_bytes());
    buf
}

fn prize_result(payout_id: u64, status: u8, shares: u128) -> Vec<u8> {
    let mut buf = route_header(msg_codec::MSG_PAY_PRIZE_RESULT, payout_id);
    buf.push(status);
    buf.extend_from_slice(&shares.to_be_bytes());
    buf
}

const SEASON_1_END: i64 = tesoro_core::ledger::SEASON_EPOCH + tesoro_core::ledger::SEASON_SECS;

impl Env {
    fn route(&self) -> Pubkey {
        bridge_pda(&[ROUTE_SEED, &EID_HOODI.to_be_bytes(), &vault_word()])
    }

    fn batch_address(&self, id: u64) -> Pubkey {
        bridge_pda(&[BATCH_SEED, &EID_HOODI.to_be_bytes(), &vault_word(), &id.to_be_bytes()])
    }

    fn payout_address(&self, id: u64) -> Pubkey {
        bridge_pda(&[PAYOUT_SEED, &EID_HOODI.to_be_bytes(), &vault_word(), &id.to_be_bytes()])
    }

    fn pool_account(&self) -> Pubkey {
        core_pda(&[ACCOUNT_SEED, core_pda(&[LEADERBOARD_SEED]).as_ref()])
    }

    fn platform_account(&self) -> Pubkey {
        core_pda(&[ACCOUNT_SEED, a(self.admin.pubkey()).as_ref()])
    }

    /// The economy settings (needed by every cash-in) and the Pool's Account with its stores.
    fn init_core_economy(&mut self, admin: &Keypair) {
        self.send(
            &[ix(
                tesoro_core::ID,
                tesoro_core::accounts::SetEconomy {
                    admin: a(admin.pubkey()),
                    config: core_pda(&[CONFIG_SEED]),
                    economy: core_pda(&[ECONOMY_SEED]),
                    system_program: anchor_lang::system_program::ID,
                },
                tesoro_core::instruction::SetEconomy {
                    season_keeper: Pubkey::default(),
                    fill_keeper: Pubkey::default(),
                    keeper_fills: false,
                    routes: [Pubkey::default(); 4],
                },
            )],
            admin,
            &[],
        )
        .expect("set economy");
        self.send(
            &[ix(
                tesoro_core::ID,
                tesoro_core::accounts::InitLeaderboard {
                    admin: a(admin.pubkey()),
                    config: core_pda(&[CONFIG_SEED]),
                    pool_authority: core_pda(&[LEADERBOARD_SEED]),
                    pool_account: self.pool_account(),
                    system_program: anchor_lang::system_program::ID,
                },
                tesoro_core::instruction::InitLeaderboard { leaderboard_bps: 100 },
            )],
            admin,
            &[],
        )
        .expect("init leaderboard");
        let pool = self.pool_account();
        self.send(
            &[ix(
                tesoro_core::ID,
                tesoro_core::accounts::InitStores {
                    payer: a(admin.pubkey()),
                    account: pool,
                    basket: basket_address(&pool).0,
                    spill: spill_address(&pool).0,
                    system_program: anchor_lang::system_program::ID,
                },
                tesoro_core::instruction::InitStores {},
            )],
            admin,
            &[],
        )
        .expect("pool stores");
    }

    fn set_clock(&mut self, unix_timestamp: i64) {
        use solana_sdk::clock::Clock;
        self.svm.set_sysvar(&Clock { unix_timestamp, ..Clock::default() });
    }

    fn set_route(
        &mut self,
        signer: &Keypair,
        escrow_enabled: bool,
        min_batch_units: u64,
    ) -> std::result::Result<(), Failed> {
        let set = ix(
            crate::ID,
            crate::accounts::SetRoute {
                admin: a(signer.pubkey()),
                store: self.store,
                route: self.route(),
            },
            crate::instruction::SetRoute {
                params: SetRouteParams {
                    eid: EID_HOODI,
                    peer_address: vault_word(),
                    asset: msg_codec::pad_address(&ASSET),
                    escrow_enabled,
                    min_batch_units,
                },
            },
        );
        self.send(&[set], signer, &[])
    }

    /// A funded Account with an EVM address, the way Tesoro's Studio recipient is registered.
    fn studio_account(&mut self) -> (Keypair, Pubkey) {
        let studio = Keypair::new();
        self.svm.airdrop(&studio.pubkey(), 10 * SOL).expect("airdrop");
        let account = self.create_core_account(&studio, STUDIO_EVM);
        let admin = self.admin.insecure_clone();
        self.send(
            &[ix(
                tesoro_core::ID,
                tesoro_core::accounts::SetTesoroStudio {
                    admin: a(admin.pubkey()),
                    config: core_pda(&[CONFIG_SEED]),
                    economy: core_pda(&[ECONOMY_SEED]),
                    recipient_account: account,
                },
                tesoro_core::instruction::SetTesoroStudio {},
            )],
            &admin,
            &[],
        )
        .expect("set the Studio recipient");
        (studio, account)
    }

    /// Opens the route's next batch of `kind`; returns its id.
    fn open_batch(&mut self, kind: u8) -> std::result::Result<u64, Failed> {
        let payer = self.admin.insecure_clone();
        let id = self.load::<VaultRoute>(self.route()).last_batch_id + 1;
        let open = ix(
            crate::ID,
            crate::accounts::OpenBatch {
                payer: a(payer.pubkey()),
                store: self.store,
                peer: self.peer(),
                route: self.route(),
                batch: self.batch_address(id),
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::OpenBatch {
                params: OpenBatchParams { eid: EID_HOODI, peer_address: vault_word(), kind },
            },
        );
        self.send(&[open], &payer, &[]).map(|_| id)
    }

    fn add_to_batch_for(
        &mut self,
        batch_id: u64,
        position: u64,
        recipient_account: Pubkey,
    ) -> std::result::Result<(), Failed> {
        let payer = self.admin.insecure_clone();
        let source = self.source_of(position);
        let mut add = ix(
            crate::ID,
            crate::accounts::AddToBatch {
                store: self.store,
                authority: self.authority,
                batch: self.batch_address(batch_id),
                core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                core_config: core_pda(&[CONFIG_SEED]),
                core_economy: core_pda(&[ECONOMY_SEED]),
                recipient_account,
                core_position: self.core_position(position),
                core_source: source,
                core_program: tesoro_core::ID,
            },
            crate::instruction::AddToBatch {},
        );
        add.accounts.extend(econ::book_metas(&self.svm, source));
        self.send(&[add], &payer, &[])
    }

    fn add_to_batch(&mut self, batch_id: u64, position: u64) -> std::result::Result<(), Failed> {
        let kind = self.load::<Batch>(self.batch_address(batch_id)).kind;
        let recipient = match kind {
            0 => self.platform_account(),
            1 => self.studio_recipient(),
            _ => self.pool_account(),
        };
        self.add_to_batch_for(batch_id, position, recipient)
    }

    /// The Studio recipient Account, read back from the economy settings.
    fn studio_recipient(&self) -> Pubkey {
        let economy: tesoro_core::state::EconomyConfig = self.load(core_pda(&[ECONOMY_SEED]));
        economy.tesoro_studio
    }

    fn seal_batch(&mut self, batch_id: u64) -> std::result::Result<(), Failed> {
        let payer = self.admin.insecure_clone();
        let seal = ix(
            crate::ID,
            crate::accounts::SealBatch { route: self.route(), batch: self.batch_address(batch_id) },
            crate::instruction::SealBatch {},
        );
        self.send(&[seal], &payer, &[])
    }

    /// The accounts the endpoint's `send` takes after the program: the Store as sender and the
    /// library accounts, which the test double ignores.
    fn endpoint_send_accounts(&self) -> Vec<AccountMeta> {
        let mut metas = vec![
            AccountMeta::new_readonly(s(oapp::endpoint::ID), false),
            AccountMeta::new_readonly(s(self.store), false),
        ];
        metas.extend((0..8).map(|_| AccountMeta::new(Pk::new_unique(), false)));
        metas
    }

    /// Sends the sealed batch again; returns the message handed to the endpoint.
    fn send_batch(&mut self, batch_id: u64) -> std::result::Result<Vec<u8>, Failed> {
        let payer = self.admin.insecure_clone();
        let mut send = ix(
            crate::ID,
            crate::accounts::SendBatch {
                payer: a(payer.pubkey()),
                store: self.store,
                peer: self.peer(),
                batch: self.batch_address(batch_id),
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::SendBatch {
                params: SendBatchParams {
                    eid: EID_HOODI,
                    peer_address: vault_word(),
                    batch_id,
                    options: vec![],
                    native_fee: 0,
                    lz_token_fee: 0,
                },
            },
        );
        send.accounts.extend(self.endpoint_send_accounts());
        let logs = self.send_logs(&[send], &payer, &[])?;
        let mut sent = sent_messages(&logs);
        assert_eq!(sent.len(), 1, "one message per send");
        Ok(sent.remove(0))
    }

    /// Runs the real `lz_receive` for a message the vault sent, through the endpoint test double.
    fn lz_receive(&mut self, message: Vec<u8>, nonce: u64) -> std::result::Result<(), Failed> {
        self.lz_receive_from(message, nonce, vault_word())
    }

    fn lz_receive_from(
        &mut self,
        message: Vec<u8>,
        nonce: u64,
        sender: [u8; 32],
    ) -> std::result::Result<(), Failed> {
        let (header, body) = msg_codec::decode_inbound(&message).expect("a decodable message");
        let target = match body {
            msg_codec::Inbound::Locked { .. } | msg_codec::Inbound::Yield { .. } => {
                bridge_pda(&[POSITION_SEED, &EID_HOODI.to_be_bytes(), &header.position_id])
            },
            msg_codec::Inbound::BatchResult { .. } => self.batch_address(header.seq),
            msg_codec::Inbound::PayPrizeResult { .. } => self.payout_address(header.seq),
        };
        let payer = self.admin.insecure_clone();
        let mut receive = ix(
            crate::ID,
            crate::accounts::LzReceive {
                payer: a(payer.pubkey()),
                store: self.store,
                peer: bridge_pda(&[
                    PEER_SEED,
                    self.store.as_ref(),
                    &EID_HOODI.to_be_bytes(),
                    &sender,
                ]),
                target,
                route: bridge_pda(&[ROUTE_SEED, &EID_HOODI.to_be_bytes(), &sender]),
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::LzReceive {
                params: LzReceiveParams {
                    src_eid: EID_HOODI,
                    sender,
                    nonce,
                    guid: [0u8; 32],
                    message,
                    extra_data: vec![],
                },
            },
        );
        receive.accounts.extend(
            oapp::endpoint_cpi::get_accounts_for_clear(
                oapp::endpoint::ID,
                &self.store,
                EID_HOODI,
                &sender,
                nonce,
            )
            .into_iter()
            .map(|acc| AccountMeta {
                pubkey: s(acc.pubkey),
                is_signer: false,
                is_writable: acc.is_writable,
            }),
        );
        self.send(&[receive], &payer, &[])
    }

    /// Position `id` opened with its Advance, the Platform fee counter carrying `fee` Gemas cut out
    /// of the owner's own Gemas, and yield reported that covers more than the counter.
    fn position_with_fee_counter(&mut self, id: u64, fee_class: u8, fee: u64) -> Pubkey {
        self.opened_with_advance(id);
        let source = self.source_of(id);
        econ::fee_cut(&mut self.svm, source, self.owner_account, 3, 0, fee_class, fee);
        self.receive_yield(id, 2, 5_000_000_000_000_000, 0, 0);
        self.apply_yield(id, true).expect("apply yield");
        source
    }

    fn close_batch(&mut self, batch_id: u64, receiver: Pubkey) -> std::result::Result<(), Failed> {
        let payer = self.admin.insecure_clone();
        let close = ix(
            crate::ID,
            crate::accounts::CloseBatch {
                batch: self.batch_address(batch_id),
                rent_receiver: receiver,
            },
            crate::instruction::CloseBatch {},
        );
        self.send(&[close], &payer, &[])
    }

    fn close_payout(
        &mut self,
        payout_id: u64,
        receiver: Pubkey,
    ) -> std::result::Result<(), Failed> {
        let payer = self.admin.insecure_clone();
        let close = ix(
            crate::ID,
            crate::accounts::ClosePayout {
                payout: self.payout_address(payout_id),
                rent_receiver: receiver,
            },
            crate::instruction::ClosePayout {},
        );
        self.send(&[close], &payer, &[])
    }

    fn lamports(&self, key: Pubkey) -> u64 {
        self.svm.get_account(&s(key)).map(|acc| acc.lamports).unwrap_or(0)
    }

    fn exists(&self, key: Pubkey) -> bool {
        self.svm.get_account(&s(key)).is_some_and(|acc| acc.lamports > 0)
    }

    fn batch(&self, id: u64) -> Batch {
        self.load(self.batch_address(id))
    }

    fn route_state(&self) -> VaultRoute {
        self.load(self.route())
    }
}

fn wire_entries(message: &[u8]) -> Vec<(u64, u128)> {
    let n = usize::from(message[msg_codec::BATCH_FIXED_LEN - 1]);
    (0..n)
        .map(|i| {
            let at = msg_codec::BATCH_FIXED_LEN + i * msg_codec::BATCH_ENTRY_LEN;
            (
                u64::from_be_bytes(message[at..at + 8].try_into().expect("id")),
                u128::from_be_bytes(message[at + 8..at + 24].try_into().expect("units")),
            )
        })
        .collect()
}

#[test]
fn a_platform_fee_batch_is_paid_once_across_retries_duplicates_and_partial_results() {
    let mut env = Env::new();
    let id = 1;
    let source = env.position_with_fee_counter(id, 0, 300);
    let redeemed_before = env.load::<SourceState>(source).inner.redeemed_units;

    let batch_id = env.open_batch(0).expect("open");
    assert_eq!(batch_id, 1, "ids are route-scoped and start at 1");
    env.add_to_batch(batch_id, id)
        .expect("the covered Platform fee enters the batch");
    let batch = env.batch(batch_id);
    let units = batch.entries()[0].units;
    assert!(units > 0);
    assert_eq!(
        (batch.count, batch.total_units, batch.recipient),
        (1, u128::from(units), PLATFORM_EVM)
    );
    assert_eq!(
        env.load::<SourceState>(source).inner.redeemed_units,
        redeemed_before + units,
        "core debited the counter and recorded the units"
    );

    // The same counter cannot enter a batch twice: nothing is left to cash in.
    env.add_to_batch(batch_id, id).expect_err("the counter is empty");
    assert_eq!(env.batch(batch_id).total_units, u128::from(units));

    // An unsealed batch is not sent, and a sealed one takes no more entries.
    let err = env.send_batch(batch_id).expect_err("not sealed yet");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::BatchNotSealed)));
    env.seal_batch(batch_id).expect("seal");
    let err = env.add_to_batch(batch_id, id).expect_err("sealed");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::BatchNotOpen)));

    // The message names the batch, the kind, the registered recipient and the Position.
    let first = env.send_batch(batch_id).expect("send");
    assert_eq!(first[0], msg_codec::MSG_CASH_IN_BATCH);
    assert_eq!(&first[1..5], &EID_HOODI.to_be_bytes());
    assert_eq!(&first[5..37], &msg_codec::route_word(&vault_word()));
    assert_eq!(&first[37..45], &batch_id.to_be_bytes());
    assert_eq!(first[45], msg_codec::KIND_PLATFORM);
    assert_eq!(&first[46..78], &msg_codec::pad_address(&PLATFORM_EVM));
    assert_eq!(wire_entries(&first), vec![(id, u128::from(units))]);

    // Retry by batch id: the same bytes again.
    assert_eq!(env.send_batch(batch_id).expect("retry"), first);
    assert_eq!(env.batch(batch_id).sends, 2);

    // The vault paid half (partial execution) and acknowledged.
    let half = u128::from(units) / 2;
    env.lz_receive(batch_result(batch_id, &[half], 0, 0), 1).expect("ack");
    let b = env.batch(batch_id);
    assert_eq!(
        (b.paid_units, b.owed_units(), b.state),
        (half, u128::from(units) - half, BATCH_SEALED)
    );
    // The same acknowledgement again, and an older one delivered late, change nothing.
    env.lz_receive(batch_result(batch_id, &[half], 0, 0), 2).expect("duplicate");
    env.lz_receive(batch_result(batch_id, &[half / 2], 0, 0), 3)
        .expect("late and older");
    assert_eq!(env.batch(batch_id).paid_units, half);
    // Still owed: the retry carries the same batch id and entries.
    assert_eq!(env.send_batch(batch_id).expect("retry after a partial result"), first);

    // The vault tops up and acknowledges everything; an over-large claim is capped at the request.
    env.lz_receive(batch_result(batch_id, &[u128::from(units) * 2], 0, 0), 4)
        .expect("final");
    let b = env.batch(batch_id);
    assert_eq!((b.paid_units, b.owed_units(), b.state), (u128::from(units), 0, BATCH_DONE));
    let err = env.send_batch(batch_id).expect_err("done");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::BatchNotSealed)));
    env.lz_receive(batch_result(batch_id, &[half], 0, 0), 5)
        .expect("a stale one after Done");
    assert_eq!(env.batch(batch_id).paid_units, u128::from(units));

    // Throughout, core counted the units once.
    assert_eq!(env.load::<SourceState>(source).inner.redeemed_units, redeemed_before + units);
}

#[test]
fn a_batch_whose_acknowledgement_never_arrives_stays_owed_and_is_never_released() {
    let mut env = Env::new();
    let id = 1;
    let source = env.position_with_fee_counter(id, 0, 300);
    let batch_id = env.open_batch(0).expect("open");
    env.add_to_batch(batch_id, id).expect("add");
    env.seal_batch(batch_id).expect("seal");
    let message = env.send_batch(batch_id).expect("send");
    let units = env.batch(batch_id).total_units;
    let redeemed = env.load::<SourceState>(source).inner.redeemed_units;

    // A year passes with no answer.
    env.set_clock(SEASON_1_END + 365 * 86_400);
    assert_eq!(env.batch(batch_id).owed_units(), units);
    assert_eq!(env.batch(batch_id).state, BATCH_SEALED, "no timeout moves it");
    assert_eq!(env.send_batch(batch_id).expect("it can still be retried"), message);
    // The counter is not credited back and cannot be cashed in again.
    let another = env.open_batch(0).expect("another batch");
    env.add_to_batch(another, id).expect_err("the counter stays debited");
    assert_eq!(env.load::<SourceState>(source).inner.redeemed_units, redeemed);
}

#[test]
fn batches_need_a_minimum_size_and_only_the_admin_sets_it() {
    let mut env = Env::new();
    let id = 1;
    env.position_with_fee_counter(id, 0, 300);
    let batch_id = env.open_batch(0).expect("open");
    env.add_to_batch(batch_id, id).expect("add");
    let units = env.batch(batch_id).total_units;

    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    env.set_route(&stranger, false, 1).expect_err("not the admin");

    let admin = env.admin.insecure_clone();
    env.set_route(&admin, false, u64::try_from(units).expect("fits") + 1)
        .expect("set the minimum");
    let err = env.seal_batch(batch_id).expect_err("below the minimum");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::BatchBelowMinimum)));
    env.set_route(&admin, false, u64::try_from(units).expect("fits"))
        .expect("lower it");
    env.seal_batch(batch_id).expect("at the minimum");
}

#[test]
fn an_empty_batch_is_not_sealed_and_a_foreign_recipient_cannot_enter() {
    let mut env = Env::new();
    let id = 1;
    env.position_with_fee_counter(id, 0, 300);
    let batch_id = env.open_batch(0).expect("open");
    let err = env.seal_batch(batch_id).expect_err("empty");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::BatchEmpty)));

    // The Studio Account is not the Platform recipient: core refuses, nothing is debited.
    let (_studio, studio_account) = env.studio_account();
    env.add_to_batch_for(batch_id, id, studio_account)
        .expect_err("wrong recipient for a Platform batch");
    // A Platform recipient without an EVM address cannot be paid on the vault.
    let admin = env.admin.insecure_clone();
    env.send(
        &[ix(
            tesoro_core::ID,
            tesoro_core::accounts::SetEvmAddress {
                authority: a(admin.pubkey()),
                account: env.platform_account(),
            },
            tesoro_core::instruction::SetEvmAddress { evm_address: [0; 20] },
        )],
        &admin,
        &[],
    )
    .expect("clear the address");
    env.add_to_batch(batch_id, id).expect_err("no registered EVM recipient");
    assert_eq!(env.batch(batch_id).count, 0);
    // Both refusals were about the recipient: with the address back, the same entry goes in.
    env.send(
        &[ix(
            tesoro_core::ID,
            tesoro_core::accounts::SetEvmAddress {
                authority: a(admin.pubkey()),
                account: env.platform_account(),
            },
            tesoro_core::instruction::SetEvmAddress { evm_address: PLATFORM_EVM },
        )],
        &admin,
        &[],
    )
    .expect("register the address again");
    env.add_to_batch(batch_id, id).expect("now it enters");
    assert_eq!(env.batch(batch_id).count, 1);
}

#[test]
fn a_studio_batch_pays_the_registered_studio_recipient() {
    let mut env = Env::new();
    let id = 1;
    let (_studio, studio_account) = env.studio_account();
    env.position_with_fee_counter(id, 1, 200);
    let batch_id = env.open_batch(1).expect("open");
    env.add_to_batch_for(batch_id, id, studio_account).expect("add");
    env.seal_batch(batch_id).expect("seal");
    let message = env.send_batch(batch_id).expect("send");
    assert_eq!(message[45], msg_codec::KIND_STUDIO);
    assert_eq!(&message[46..78], &msg_codec::pad_address(&STUDIO_EVM));
}

#[test]
fn a_batch_only_takes_positions_of_its_own_vault() {
    let mut env = Env::new();
    let id = 1;
    env.position_with_fee_counter(id, 0, 300);
    // A second vault on the same chain, with its own route.
    let admin = env.admin.insecure_clone();
    env.send(&[peer_ix(&env, &admin)], &admin, &[]).expect("second vault");
    let other = msg_codec::pad_address(&[0x6c; 20]);
    let open = ix(
        crate::ID,
        crate::accounts::OpenBatch {
            payer: a(admin.pubkey()),
            store: env.store,
            peer: bridge_pda(&[PEER_SEED, env.store.as_ref(), &EID_HOODI.to_be_bytes(), &other]),
            route: bridge_pda(&[ROUTE_SEED, &EID_HOODI.to_be_bytes(), &other]),
            batch: bridge_pda(&[BATCH_SEED, &EID_HOODI.to_be_bytes(), &other, &1u64.to_be_bytes()]),
            system_program: anchor_lang::system_program::ID,
        },
        crate::instruction::OpenBatch {
            params: OpenBatchParams { eid: EID_HOODI, peer_address: other, kind: 0 },
        },
    );
    env.send(&[open], &admin, &[]).expect("open the other vault's batch");
    let source = env.source_of(id);
    let mut add = ix(
        crate::ID,
        crate::accounts::AddToBatch {
            store: env.store,
            authority: env.authority,
            batch: bridge_pda(&[BATCH_SEED, &EID_HOODI.to_be_bytes(), &other, &1u64.to_be_bytes()]),
            core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
            core_config: core_pda(&[CONFIG_SEED]),
            core_economy: core_pda(&[ECONOMY_SEED]),
            recipient_account: env.platform_account(),
            core_position: env.core_position(id),
            core_source: source,
            core_program: tesoro_core::ID,
        },
        crate::instruction::AddToBatch {},
    );
    add.accounts.extend(econ::book_metas(&env.svm, source));
    let err = env.send(&[add], &admin, &[]).expect_err("another vault's Position");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::WrongRoute)));
}

// Prize Gemas of `route`'s prize Source for Season 1, funded from an escrow of `shares` shares
// that were worth `units` of the asset when they arrived.
const ESCROW_SHARES: u128 = 280_000_000_000_000;
const ESCROW_UNITS: u128 = 300_000_000_000_000;

impl Env {
    fn prize_source_address(&self, season: u32) -> Pubkey {
        core_pda(&[PRIZE_SOURCE_SEED, self.route().as_ref(), &season.to_le_bytes()])
    }

    /// The escrow switched on, a Leaderboard fee batch cashed in and acknowledged by the vault with
    /// `ESCROW_SHARES` / `ESCROW_UNITS` in its escrow: the state prize issuance starts from.
    fn escrow_confirmed(&mut self, id: u64) {
        self.position_with_fee_counter(id, 2, 300);
        let admin = self.admin.insecure_clone();
        self.set_route(&admin, true, 0).expect("switch the escrow on");
        let batch_id = self.open_batch(2).expect("open a Leaderboard batch");
        self.add_to_batch(batch_id, id).expect("add");
        self.seal_batch(batch_id).expect("seal");
        self.send_batch(batch_id).expect("send");
        let units = u128::from(self.batch(batch_id).entries()[0].units);
        self.lz_receive(batch_result(batch_id, &[units], ESCROW_SHARES, ESCROW_UNITS), 1)
            .expect("the vault's acknowledgement");
    }

    fn fund_prize(
        &mut self,
        season: u32,
        season_authority: &Keypair,
        oracle: Option<&Keypair>,
    ) -> std::result::Result<(), Failed> {
        let payer = self.admin.insecure_clone();
        let pool = self.pool_account();
        let asset = msg_codec::pad_address(&ASSET);
        let mut fund = ix(
            crate::ID,
            crate::accounts::FundSeasonPrizeEvm {
                payer: a(payer.pubkey()),
                season_authority: a(season_authority.pubkey()),
                oracle: oracle.map(|o| a(o.pubkey())),
                store: self.store,
                authority: self.authority,
                peer: self.peer(),
                route: self.route(),
                core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                core_config: core_pda(&[CONFIG_SEED]),
                core_economy: core_pda(&[ECONOMY_SEED]),
                pool_account: pool,
                pool_basket: basket_address(&pool).0,
                pool_spill: spill_address(&pool).0,
                prize_source: self.prize_source_address(season),
                core_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::FundSeasonPrizeEvm {
                params: FundSeasonPrizeEvmParams {
                    eid: EID_HOODI,
                    peer_address: vault_word(),
                    season,
                    price_micro_usd: 3_000_000_000,
                },
            },
        );
        // No Pyth feed for the asset: the marker account must not exist.
        fund.accounts
            .push(AccountMeta::new_readonly(s(core_pda(&[ONCHAIN_PRICE_SEED, &asset])), false));
        let mut extra: Vec<&Keypair> = vec![season_authority];
        if let Some(o) = oracle {
            extra.push(o);
        }
        self.send(&[fund], &payer, &extra)
    }

    fn pool_prize_gemas(&self, season: u32) -> u64 {
        let key = ps_line_key(&self.prize_source_address(season));
        econ::read_lines(&self.svm, basket_address(&self.pool_account()).0)
            .into_iter()
            .filter(|l| l.key() == key)
            .map(|l| l.amount)
            .sum()
    }
}

fn ps_line_key(prize_source: &Pubkey) -> tesoro_core::ledger::line_store::LineKey {
    tesoro_core::prize_line_key(prize_source)
}

#[test]
fn the_leaderboard_batch_needs_the_escrow_and_the_vaults_snapshots_only_move_forward() {
    let mut env = Env::new();
    let id = 1;
    env.position_with_fee_counter(id, 2, 300);
    let err = env.open_batch(2).expect_err("the escrow ships switched off");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::EscrowOff)));
    let admin = env.admin.insecure_clone();
    env.set_route(&admin, true, 0).expect("switch on");
    let batch_id = env.open_batch(2).expect("open");
    // The Pool's Account stands in as the recipient; no EVM address is needed or sent.
    env.add_to_batch(batch_id, id).expect("add");
    env.seal_batch(batch_id).expect("seal");
    let message = env.send_batch(batch_id).expect("send");
    assert_eq!(message[45], msg_codec::KIND_LEADERBOARD);
    assert_eq!(&message[46..78], &[0u8; 32]);
    assert_eq!(env.route_state().escrow_shares, 0, "nothing is confirmed by sending");

    let units = u128::from(env.batch(batch_id).entries()[0].units);
    env.lz_receive(batch_result(batch_id, &[units], 900, 1_000), 1).expect("ack");
    let r = env.route_state();
    assert_eq!((r.escrow_shares, r.escrow_units), (900, 1_000));
    // An older acknowledgement (a duplicate of an earlier retry) cannot lower the figures.
    env.lz_receive(batch_result(batch_id, &[units], 500, 600), 2).expect("older");
    let r = env.route_state();
    assert_eq!((r.escrow_shares, r.escrow_units), (900, 1_000));
    // A Yield Report of a vault with an escrow carries the cumulative figures too; one of a vault
    // without it (101 bytes) changes only what it always did.
    env.lz_receive(yield_message(id, 5, 6_000_000_000_000_000, Some((1_500, 1_800))), 3)
        .expect("report");
    let r = env.route_state();
    assert_eq!((r.escrow_shares, r.escrow_units), (1_500, 1_800));
    env.lz_receive(yield_message(id, 6, 7_000_000_000_000_000, None), 4)
        .expect("old format");
    assert_eq!(env.route_state().escrow_shares, 1_500);
    // A stale report (lower seq) is consumed; its older escrow snapshot cannot lower the mirror.
    env.lz_receive(yield_message(id, 3, 1, Some((100, 100))), 5).expect("stale");
    assert_eq!(env.route_state().escrow_shares, 1_500);
    let position: BridgePosition = env.load(env.bridge_position(id));
    assert_eq!((position.last_yield_seq, position.yield_cumulative), (6, 7_000_000_000_000_000));
}

#[test]
fn prize_gemas_are_issued_only_for_confirmed_escrow_once_per_ended_season() {
    let mut env = Env::new();
    let id = 1;
    env.escrow_confirmed(id);
    let admin = env.admin.insecure_clone();
    let oracle = env.oracle.insecure_clone();

    // The Season has not ended.
    env.set_clock(SEASON_1_END - 10);
    env.fund_prize(1, &admin, Some(&oracle)).expect_err("Season 1 is still running");
    env.set_clock(SEASON_1_END + 10);
    // Only the Season authority (admin or keeper) funds; the oracle prices.
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    env.fund_prize(1, &stranger, Some(&oracle))
        .expect_err("not the Season authority");
    env.fund_prize(1, &admin, None).expect_err("no Pyth feed and no oracle price");
    let switched_off = env.route_state();
    assert_eq!(switched_off.issued_shares, 0);

    env.fund_prize(1, &admin, Some(&oracle)).expect("fund Season 1");
    let prize: PrizeSourceState = env.load(env.prize_source_address(1));
    assert_eq!(prize.route, env.route());
    assert_eq!(prize.season, 1);
    assert_eq!(prize.inner.shares, ESCROW_SHARES);
    // 0.0003 ETH at $3,000 is $0.90 = 90 Gemas.
    assert_eq!(prize.inner.gemas, 90);
    assert_eq!(env.pool_prize_gemas(1), 90, "credited to the Pool's basket");
    let r = env.route_state();
    assert_eq!(
        (r.issued_shares, r.issued_units, r.last_funded_season),
        (ESCROW_SHARES, ESCROW_UNITS, 1)
    );

    // Nothing left to issue, and Season 1 cannot be funded twice.
    let err = env.fund_prize(1, &admin, Some(&oracle)).expect_err("funded");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::SeasonAlreadyFunded)));
    let err = env.fund_prize(2, &admin, Some(&oracle)).expect_err("no new escrow");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::NothingToIssue)));

    // More escrow arrives; the next Season issues exactly the difference.
    env.lz_receive(
        yield_message(
            id,
            7,
            6_000_000_000_000_000,
            Some((ESCROW_SHARES + 140_000_000_000_000, ESCROW_UNITS + 150_000_000_000_000)),
        ),
        2,
    )
    .expect("report");
    env.set_clock(SEASON_1_END + 7 * 86_400 + 10);
    env.fund_prize(2, &admin, Some(&oracle)).expect("Season 2");
    let prize2: PrizeSourceState = env.load(env.prize_source_address(2));
    assert_eq!(prize2.inner.shares, 140_000_000_000_000);
    assert_eq!(prize2.inner.gemas, 45);
    let r = env.route_state();
    assert_eq!(r.issued_shares, r.escrow_shares, "issued never exceeds confirmed");
}

#[test]
fn prize_issuance_is_off_while_the_escrow_is_off() {
    let mut env = Env::new();
    let id = 1;
    env.escrow_confirmed(id);
    let admin = env.admin.insecure_clone();
    let oracle = env.oracle.insecure_clone();
    env.set_route(&admin, false, 0).expect("switch off");
    env.set_clock(SEASON_1_END + 10);
    let err = env.fund_prize(1, &admin, Some(&oracle)).expect_err("off");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::EscrowOff)));
}

impl Env {
    /// Season 1 funded and `gemas` of its prize paid to the Position owner, who has proven the EVM
    /// address (the Season payout itself is covered in tesoro_core).
    fn prize_to_owner(&mut self, id: u64, gemas: u64) {
        self.escrow_confirmed(id);
        let admin = self.admin.insecure_clone();
        let oracle = self.oracle.insecure_clone();
        self.set_clock(SEASON_1_END + 10);
        self.fund_prize(1, &admin, Some(&oracle)).expect("fund Season 1");
        let key = ps_line_key(&self.prize_source_address(1));
        let (pool, owner) = (self.pool_account(), self.owner_account);
        econ::move_prize(&mut self.svm, &key, pool, owner, gemas);
    }

    fn redeem_prize(&mut self, gemas: u64) -> std::result::Result<u64, Failed> {
        let owner = self.owner.insecure_clone();
        let payout_id = self.route_state().last_payout_id + 1;
        let redeem = ix(
            crate::ID,
            crate::accounts::RedeemPrizeToEvm {
                holder_authority: a(owner.pubkey()),
                store: self.store,
                authority: self.authority,
                route: self.route(),
                core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                holder_account: self.owner_account,
                evm_link: self.evm_link(),
                core_basket: basket_address(&self.owner_account).0,
                core_spill: spill_address(&self.owner_account).0,
                prize_source: self.prize_source_address(1),
                payout: self.payout_address(payout_id),
                core_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::RedeemPrizeToEvm { gemas },
        );
        self.send(&[redeem], &owner, &[]).map(|_| payout_id)
    }

    fn send_pay_prize(&mut self, payout_id: u64) -> std::result::Result<Vec<u8>, Failed> {
        let payer = self.admin.insecure_clone();
        let mut send = ix(
            crate::ID,
            crate::accounts::SendPayPrize {
                payer: a(payer.pubkey()),
                store: self.store,
                peer: self.peer(),
                payout: self.payout_address(payout_id),
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::SendPayPrize {
                params: SendPayPrizeParams {
                    eid: EID_HOODI,
                    peer_address: vault_word(),
                    payout_id,
                    options: vec![],
                    native_fee: 0,
                    lz_token_fee: 0,
                },
            },
        );
        send.accounts.extend(self.endpoint_send_accounts());
        let logs = self.send_logs(&[send], &payer, &[])?;
        let mut sent = sent_messages(&logs);
        assert_eq!(sent.len(), 1);
        Ok(sent.remove(0))
    }

    fn refund_payout(&mut self, payout_id: u64) -> std::result::Result<(), Failed> {
        let payer = self.admin.insecure_clone();
        let refund = ix(
            crate::ID,
            crate::accounts::RefundPrizePayout {
                store: self.store,
                authority: self.authority,
                route: self.route(),
                payout: self.payout_address(payout_id),
                core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                holder_account: self.owner_account,
                core_basket: basket_address(&self.owner_account).0,
                core_spill: spill_address(&self.owner_account).0,
                prize_source: self.prize_source_address(1),
                core_program: tesoro_core::ID,
            },
            crate::instruction::RefundPrizePayout {},
        );
        self.send(&[refund], &payer, &[])
    }

    fn payout(&self, id: u64) -> PayoutRecord {
        self.load(self.payout_address(id))
    }

    fn prize_gemas_of_owner(&self) -> u64 {
        let key = ps_line_key(&self.prize_source_address(1));
        econ::read_lines(&self.svm, basket_address(&self.owner_account).0)
            .into_iter()
            .filter(|l| l.key() == key)
            .map(|l| l.amount)
            .sum()
    }

    /// The prize Source's shares plus the route's pending and paid payouts: always what was issued.
    fn prize_shares_accounted(&self) -> u128 {
        let prize: PrizeSourceState = self.load(self.prize_source_address(1));
        let r = self.route_state();
        prize.inner.shares + r.pending_payout_shares + r.paid_payout_shares
    }
}

#[test]
fn a_prize_payout_is_bound_reserved_and_paid_once_whatever_the_vault_repeats() {
    let mut env = Env::new();
    env.prize_to_owner(1, 60);
    assert_eq!(env.prize_gemas_of_owner(), 60);
    let issued = env.route_state().issued_shares;
    assert_eq!(env.prize_shares_accounted(), issued);

    // The owner redeems 30 of the 90 prize Gemas: they burn, a third of the shares are reserved.
    let payout_id = env.redeem_prize(30).expect("redeem");
    assert_eq!(payout_id, 1);
    assert_eq!(env.prize_gemas_of_owner(), 30);
    let shares = ESCROW_SHARES / 3;
    let p = env.payout(payout_id);
    assert_eq!(
        (p.shares, p.gemas, p.state, p.recipient),
        (shares, 30, PAYOUT_PENDING, EVM_ADDRESS)
    );
    assert_eq!(p.holder_account, env.owner_account);
    assert_eq!(p.prize_source, env.prize_source_address(1));
    let r = env.route_state();
    assert_eq!((r.pending_payout_shares, r.paid_payout_shares), (shares, 0));
    assert_eq!(env.prize_shares_accounted(), issued, "the shares are reserved, not lost");

    // PayPrize binds chain, vault, asset, prize Source, recipient, shares and the payout id.
    let message = env.send_pay_prize(payout_id).expect("send");
    assert_eq!(message.len(), msg_codec::PAY_PRIZE_LEN);
    assert_eq!(message[0], msg_codec::MSG_PAY_PRIZE);
    assert_eq!(&message[1..5], &EID_HOODI.to_be_bytes());
    assert_eq!(&message[5..37], &msg_codec::route_word(&vault_word()));
    assert_eq!(&message[37..45], &payout_id.to_be_bytes());
    assert_eq!(&message[45..77], &msg_codec::pad_address(&ASSET));
    assert_eq!(&message[77..109], env.prize_source_address(1).as_ref());
    assert_eq!(&message[109..141], &msg_codec::pad_address(&EVM_ADDRESS));
    assert_eq!(&message[141..157], &shares.to_be_bytes());
    assert_eq!(env.send_pay_prize(payout_id).expect("retry"), message, "same bytes on a retry");

    // Redeeming more than is held, or from a Source of another route, is refused.
    env.redeem_prize(31).expect_err("only 30 prize Gemas are left");

    // A payment of a different quantity is refused; the right one finishes the payout once.
    env.lz_receive(prize_result(payout_id, msg_codec::PRIZE_PAID, shares + 1), 10)
        .expect_err("the vault must pay exactly what was named");
    env.lz_receive(prize_result(payout_id, msg_codec::PRIZE_PAID, shares), 11)
        .expect("paid");
    let r = env.route_state();
    assert_eq!((r.pending_payout_shares, r.paid_payout_shares), (0, shares));
    assert_eq!(env.payout(payout_id).state, PAYOUT_PAID);
    // Repeats and a contradicting answer change nothing.
    env.lz_receive(prize_result(payout_id, msg_codec::PRIZE_PAID, shares), 12)
        .expect("duplicate");
    env.lz_receive(prize_result(payout_id, msg_codec::PRIZE_REJECTED, 0), 13)
        .expect("contradiction");
    let r = env.route_state();
    assert_eq!((r.pending_payout_shares, r.paid_payout_shares), (0, shares));
    assert_eq!(env.payout(payout_id).state, PAYOUT_PAID);
    env.refund_payout(payout_id).expect_err("a paid payout is never refunded");
    assert_eq!(env.prize_gemas_of_owner(), 30);
    assert_eq!(env.prize_shares_accounted(), issued);
}

#[test]
fn a_rejected_prize_payout_returns_the_gemas_and_the_shares_exactly_once() {
    let mut env = Env::new();
    env.prize_to_owner(1, 60);
    let issued = env.route_state().issued_shares;
    let payout_id = env.redeem_prize(20).expect("redeem");
    let shares = env.payout(payout_id).shares;

    // No timeout, no refund: the shares stay reserved while the vault has not answered.
    env.set_clock(SEASON_1_END + 400 * 86_400);
    let err = env.refund_payout(payout_id).expect_err("still pending");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::PayoutNotRejected)));
    assert_eq!(env.route_state().pending_payout_shares, shares);
    assert_eq!(env.prize_gemas_of_owner(), 40);

    // The vault's signed rejection allows the refund.
    env.lz_receive(prize_result(payout_id, msg_codec::PRIZE_REJECTED, 0), 20)
        .expect("rejected");
    assert_eq!(env.payout(payout_id).state, PAYOUT_REJECTED);
    assert_eq!(env.route_state().pending_payout_shares, shares, "reserved until refunded");
    assert_eq!(
        env.send_pay_prize(payout_id).err().map(|e| custom_code(&e)),
        Some(Some(bridge_err(BridgeError::PayoutNotPending)))
    );
    // A late PAID after the rejection cannot revive it.
    env.lz_receive(prize_result(payout_id, msg_codec::PRIZE_PAID, shares), 21)
        .expect("late paid");
    assert_eq!(env.payout(payout_id).state, PAYOUT_REJECTED);

    env.refund_payout(payout_id).expect("refund");
    assert_eq!(env.payout(payout_id).state, PAYOUT_REFUNDED);
    assert_eq!(env.prize_gemas_of_owner(), 60, "the Gemas are back");
    let r = env.route_state();
    assert_eq!((r.pending_payout_shares, r.paid_payout_shares), (0, 0));
    assert_eq!(env.prize_shares_accounted(), issued);
    env.refund_payout(payout_id).expect_err("refunded once");
    assert_eq!(env.prize_gemas_of_owner(), 60);

    // And the Gemas are redeemable again.
    let again = env.redeem_prize(60).expect("redeem them all");
    assert_eq!(again, 2);
    // 60 of the Source's 90 Gemas: two thirds of its shares, floored.
    assert_eq!(env.payout(again).shares, issued * 60 / 90);
    assert_eq!(env.prize_shares_accounted(), issued);
}

#[test]
fn prize_gemas_of_another_routes_source_cannot_be_redeemed_through_this_route() {
    let mut env = Env::new();
    env.prize_to_owner(1, 60);
    // A prize Source whose route is not this one: redeem_prize_to_evm checks the Source's route.
    let owner = env.owner.insecure_clone();
    let mut prize: PrizeSourceState = env.load(env.prize_source_address(1));
    prize.route = Pubkey::new_unique();
    env.put(env.prize_source_address(1), tesoro_core::ID, &prize);
    let err = env.redeem_prize(10).expect_err("another route's Source");
    assert!(custom_code(&err).is_some());
    let _ = owner;
}

#[test]
fn a_done_batch_closes_to_its_payer_and_its_replays_stay_harmless() {
    let mut env = Env::new();
    let source = env.position_with_fee_counter(1, 0, 300);
    let batch_id = env.open_batch(0).expect("open");
    env.add_to_batch(batch_id, 1).expect("add");
    let units = u128::from(env.batch(batch_id).entries()[0].units);
    let payer = a(env.admin.pubkey());
    let wrong = Pubkey::new_unique();
    let batch_key = env.batch_address(batch_id);

    // Not before the batch is Done: open, sealed and half-paid batches keep their record.
    let err = env.close_batch(batch_id, payer).expect_err("open");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::BatchNotDone)));
    env.seal_batch(batch_id).expect("seal");
    env.close_batch(batch_id, payer).expect_err("sealed");
    env.lz_receive(batch_result(batch_id, &[units / 2], 0, 0), 1).expect("half");
    env.close_batch(batch_id, payer).expect_err("half paid");
    env.lz_receive(batch_result(batch_id, &[units], 0, 0), 2).expect("all");
    assert_eq!(env.batch(batch_id).state, BATCH_DONE);

    // The rent goes to whoever paid it, to nobody else.
    let rent = env.lamports(batch_key);
    assert!(rent > 0);
    let err = env.close_batch(batch_id, wrong).expect_err("someone else");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::WrongRentReceiver)));
    let before = env.lamports(payer);
    env.close_batch(batch_id, payer).expect("close");
    assert!(!env.exists(batch_key), "the record is gone");
    assert_eq!(
        env.lamports(payer),
        before + rent - 5_000,
        "the rent is back (the payer also pays the fee)"
    );

    // The counter was debited once and stays debited; closing changed nothing else.
    let counted = env.load::<SourceState>(source).inner.redeemed_units;

    // A repeated or older acknowledgement for the closed id is consumed without effect, and the
    // vault's escrow snapshot in it is still taken.
    env.lz_receive(batch_result(batch_id, &[units], 0, 0), 3)
        .expect("duplicate after close");
    env.lz_receive(batch_result(batch_id, &[units / 2], 5, 7), 4)
        .expect("older after close");
    assert!(!env.exists(batch_key), "a late acknowledgement does not bring the record back");
    assert_eq!(env.route_state().escrow_shares, 5);
    assert_eq!(env.load::<SourceState>(source).inner.redeemed_units, counted);
    env.send_batch(batch_id).expect_err("a closed batch is not sent");
    env.close_batch(batch_id, payer).expect_err("closed once");

    // An acknowledgement for an id never handed out still fails, and ids are never reused.
    env.lz_receive(batch_result(batch_id + 1, &[1], 0, 0), 5)
        .expect_err("not opened yet");
    assert_eq!(env.open_batch(0).expect("next"), batch_id + 1);
    assert!(!env.exists(batch_key));
}

#[test]
fn a_prize_payout_closes_only_when_paid_or_refunded() {
    let mut env = Env::new();
    env.prize_to_owner(1, 60);
    let owner = a(env.owner.pubkey());
    let paid_id = env.redeem_prize(10).expect("redeem");
    let rejected_id = env.redeem_prize(10).expect("redeem again");
    let (paid_key, rejected_key) = (env.payout_address(paid_id), env.payout_address(rejected_id));
    let shares = env.payout(paid_id).shares;

    let err = env.close_payout(paid_id, owner).expect_err("pending");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::PayoutNotFinal)));
    env.lz_receive(prize_result(paid_id, msg_codec::PRIZE_PAID, shares), 1)
        .expect("paid");
    env.lz_receive(prize_result(rejected_id, msg_codec::PRIZE_REJECTED, 0), 2)
        .expect("rejected");
    env.close_payout(rejected_id, owner)
        .expect_err("rejected but not refunded: shares reserved");

    let rent = env.lamports(paid_key);
    env.close_payout(paid_id, Pubkey::new_unique()).expect_err("wrong receiver");
    let before = env.lamports(owner);
    env.close_payout(paid_id, owner).expect("close paid");
    assert!(!env.exists(paid_key));
    assert_eq!(env.lamports(owner), before + rent, "back to the holder who paid it");
    // A repeated PAID or a contradicting REJECTED for the closed id changes nothing.
    env.lz_receive(prize_result(paid_id, msg_codec::PRIZE_PAID, shares), 3)
        .expect("dup");
    env.lz_receive(prize_result(paid_id, msg_codec::PRIZE_REJECTED, 0), 4)
        .expect("contradiction");
    assert!(!env.exists(paid_key));
    let r = env.route_state();
    assert_eq!(r.paid_payout_shares, shares, "counted once");
    env.refund_payout(paid_id).expect_err("nothing to refund");

    env.refund_payout(rejected_id).expect("refund");
    env.close_payout(rejected_id, owner).expect("close refunded");
    assert!(!env.exists(rejected_key));
    env.lz_receive(prize_result(rejected_id, msg_codec::PRIZE_PAID, shares), 5)
        .expect("a late paid for a refunded, closed payout");
    assert!(!env.exists(rejected_key));
    assert_eq!(env.route_state().paid_payout_shares, shares);
    assert_eq!(env.prize_gemas_of_owner(), 50, "60 - 10 paid out; the refunded 10 are back");
    let next = env.redeem_prize(5).expect("redeem");
    assert_eq!(next, rejected_id + 1, "ids move on");
}

#[test]
fn lz_receive_applies_position_messages_once_and_refuses_anything_not_from_the_vault() {
    let mut env = Env::new();
    let id = 1;
    env.receive_locked(id, ETH);
    // The same Yield Report twice and an older one after it: applied once, consumed as no-ops.
    env.lz_receive(yield_message(id, 4, 4_000, None), 1).expect("report");
    env.lz_receive(yield_message(id, 4, 4_000, None), 2).expect("duplicate");
    env.lz_receive(yield_message(id, 3, 3_000, None), 3).expect("older");
    let p: BridgePosition = env.load(env.bridge_position(id));
    assert_eq!((p.last_yield_seq, p.yield_cumulative), (4, 4_000));
    env.lz_receive(yield_message(id, 5, 5_000, None), 4).expect("newer");
    assert_eq!(env.load::<BridgePosition>(env.bridge_position(id)).yield_cumulative, 5_000);

    // A sender that is not a registered vault of the chain.
    let stranger = msg_codec::pad_address(&[0x99; 20]);
    env.lz_receive_from(yield_message(id, 6, 6_000, None), 5, stranger)
        .expect_err("unregistered sender");
    // A registered vault speaking for another vault's Position or route.
    let admin = env.admin.insecure_clone();
    env.send(&[peer_ix(&env, &admin)], &admin, &[]).expect("second vault");
    env.lz_receive_from(yield_message(id, 6, 6_000, None), 6, msg_codec::pad_address(&[0x6c; 20]))
        .expect_err("a vault cannot report another vault's Position");
    assert_eq!(env.load::<BridgePosition>(env.bridge_position(id)).yield_cumulative, 5_000);
}

#[test]
fn acknowledgements_must_name_a_sealed_batch_of_the_sending_vault() {
    let mut env = Env::new();
    let id = 1;
    env.position_with_fee_counter(id, 0, 300);
    let batch_id = env.open_batch(0).expect("open");
    env.add_to_batch(batch_id, id).expect("add");
    // An acknowledgement before the batch was sealed (so before it could have been sent).
    env.lz_receive(batch_result(batch_id, &[1], 0, 0), 1).expect_err("not sealed");
    env.seal_batch(batch_id).expect("seal");
    // A batch id that does not exist, and a wrong entry count.
    env.lz_receive(batch_result(batch_id + 1, &[1], 0, 0), 2)
        .expect_err("no such batch");
    env.lz_receive(batch_result(batch_id, &[1, 1], 0, 0), 3)
        .expect_err("wrong entry count");
    assert_eq!(env.batch(batch_id).paid_units, 0);
    // A payout answer for a payout that was never made.
    env.lz_receive(prize_result(1, msg_codec::PRIZE_PAID, 1), 4)
        .expect_err("no such payout");
}

#[test]
fn tesoro_cores_evm_prize_hooks_only_answer_to_the_bridge() {
    let mut env = Env::new();
    env.prize_to_owner(1, 60);
    let owner = env.owner.insecure_clone();
    // The owner calls core's burn hook directly, signing as the "source authority" itself.
    let hook = ix(
        tesoro_core::ID,
        tesoro_core::accounts::BeginPrizePayoutFromSource {
            holder_authority: a(owner.pubkey()),
            source_signer: a(owner.pubkey()),
            source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
            holder_account: env.owner_account,
            basket: basket_address(&env.owner_account).0,
            spill: spill_address(&env.owner_account).0,
            prize_source: env.prize_source_address(1),
        },
        tesoro_core::instruction::BeginPrizePayoutFromSource {
            chain: SourceChain::Ethereum,
            amount: 10,
        },
    );
    env.send(&[hook], &owner, &[])
        .expect_err("only the registered authority may burn prize Gemas this way");
    assert_eq!(env.prize_gemas_of_owner(), 60);
    // Nor can the Season authority issue a prize Source alone.
    let admin = env.admin.insecure_clone();
    let oracle = env.oracle.insecure_clone();
    let pool = env.pool_account();
    let issue = ix(
        tesoro_core::ID,
        tesoro_core::accounts::IssuePrizeFromSource {
            payer: a(admin.pubkey()),
            authority: a(admin.pubkey()),
            source_signer: a(admin.pubkey()),
            source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
            config: core_pda(&[CONFIG_SEED]),
            economy: core_pda(&[ECONOMY_SEED]),
            oracle: Some(a(oracle.pubkey())),
            pool_account: pool,
            pool_basket: basket_address(&pool).0,
            pool_spill: spill_address(&pool).0,
            prize_source: core_pda(&[
                PRIZE_SOURCE_SEED,
                Pubkey::new_unique().as_ref(),
                &9u32.to_le_bytes(),
            ]),
            system_program: anchor_lang::system_program::ID,
        },
        tesoro_core::instruction::IssuePrizeFromSource {
            chain: SourceChain::Ethereum,
            season: 9,
            route: Pubkey::new_unique(),
            asset: Pubkey::new_from_array(msg_codec::pad_address(&ASSET)),
            decimals: 18,
            shares: 1,
            units: 1_000_000_000_000_000,
            price_micro_usd: 3_000_000_000,
        },
    );
    env.send(&[issue], &admin, &[&oracle])
        .expect_err("only the bridge may issue EVM prize Sources");
}

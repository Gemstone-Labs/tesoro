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
    ledger::SourceChain,
    state::{
        HoldingState, PositionState, SourceState, TesoroAccount, ACCOUNT_SEED, CONFIG_SEED,
        HOLDING_SEED, SOURCE_AUTHORITY_SEED, SOURCE_SEED,
    },
};

type Failed = litesvm::types::FailedTransactionMetadata;
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

fn a(p: Pk) -> Pubkey {
    Pubkey::new_from_array(p.to_bytes())
}
fn s(p: Pubkey) -> Pk {
    Pk::new_from_array(p.to_bytes())
}
fn hex(h: &str) -> Vec<u8> {
    (0..h.len() / 2).map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap_or(0)).collect()
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
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let core_so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../target/deploy/tesoro_core.so");
        let bridge_so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/tesoro_bridge.so");
        svm.add_program_from_file(s(tesoro_core::ID), core_so)
            .expect("build tesoro_core first: pnpm build:programs");
        svm.add_program_from_file(s(crate::ID), bridge_so)
            .expect("build the bridge first: cargo build-sbf");
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
        };
        for k in [&env.admin, &env.oracle, &env.owner] {
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
        let platform = env.create_core_account(&admin, [0; 20]);
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

    fn send(&mut self, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) -> std::result::Result<(), Failed> {
        self.svm.expire_blockhash();
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&payer.pubkey()),
            &signers,
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).map(|_| ())
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
                    system_program: anchor_lang::system_program::ID,
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
            },
        );
    }

    /// The inbox after a YieldAccrued with `seq` and `cumulative`.
    fn receive_yield(&mut self, id: u64, seq: u64, cumulative: u128) {
        let key = self.bridge_position(id);
        let mut p: BridgePosition = self.load(key);
        p.last_yield_seq = seq;
        p.yield_cumulative = cumulative;
        p.last_in_seq = p.last_in_seq.max(seq);
        self.put(key, crate::ID, &p);
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
            },
            crate::instruction::LinkEvm {
                params: LinkEvmParams { evm_address, signature: sig },
            },
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
        let advance = ix(
            tesoro_core::ID,
            tesoro_core::accounts::TakeAdvance {
                oracle: a(oracle.pubkey()),
                owner_authority: a(owner.pubkey()),
                config: core_pda(&[CONFIG_SEED]),
                owner_account: self.owner_account,
                position,
                source,
                holding: core_pda(&[HOLDING_SEED, self.owner_account.as_ref(), source.as_ref()]),
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::TakeAdvance { horizon_months: 3, price_micro_usd: 3_000_000_000 },
        );
        self.send(&[advance], &oracle, &[&owner]).expect("advance");
    }

    fn apply_yield(&mut self, id: u64, with_source: bool) -> std::result::Result<(), Failed> {
        let payer = self.admin.insecure_clone();
        let position = self.core_position(id);
        let source = core_pda(&[SOURCE_SEED, position.as_ref(), &0u32.to_le_bytes()]);
        let apply = ix(
            crate::ID,
            crate::accounts::ApplyYield {
                store: self.store,
                bridge_position: self.bridge_position(id),
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
fn positions_open_yield_repays_debt_and_redemption_is_recorded_once_per_unit() {
    let mut env = Env::new();
    let id = 1;
    env.receive_locked(id, ETH);

    // Not linked yet: the owner cannot be resolved.
    env.apply_locked(id).expect_err("no EvmLink");
    env.link(EVM_ADDRESS, &hex(LINK_SIGNATURE)).expect("link");

    env.apply_locked(id).expect("bridge opens the Position through the source authority");
    let position: PositionState = env.load(env.core_position(id));
    assert_eq!(position.inner.owner, env.owner_account.to_bytes());
    assert_eq!(position.inner.source_chain, SourceChain::Ethereum);
    assert_eq!(position.inner.principal, 1_000_000_000_000_000_000);
    assert_eq!(position.inner.decimals, 18);
    assert_eq!(position.inner.rate_bps, 500);
    assert!(env.load::<BridgePosition>(env.bridge_position(id)).opened);
    let err = env.apply_locked(id).expect_err("a Position opens once");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::AlreadyOpened)));

    // Advance (oracle price): 5% of 1 ETH over 3 months = 0.0125 ETH = $37.50 = 3,750 Gemas.
    env.take_advance(id);
    let source_key = core_pda(&[SOURCE_SEED, env.core_position(id).as_ref(), &0u32.to_le_bytes()]);
    let source: SourceState = env.load(source_key);
    assert_eq!(source.inner.issued, 3_750);
    assert_eq!(source.inner.debt(), 3_750);

    // No yield reported yet.
    let err = env.apply_yield(id, true).expect_err("nothing to apply");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::NothingToApply)));

    // Half of the projected yield arrives: Debt halves.
    env.receive_yield(id, 2, 6_250_000_000_000_000);
    env.apply_yield(id, false).expect_err("the open Advance's Source is required");
    env.apply_yield(id, true).expect("apply yield");
    let source: SourceState = env.load(source_key);
    assert_eq!(source.inner.debt(), 1_875);
    assert_eq!(source.inner.redeemable(), 1_875);
    let err = env.apply_yield(id, true).expect_err("applied once");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::NothingToApply)));

    // Redeem 1,000 Gemas through the bridge: recorded as a claim of source units.
    let owner = env.owner.insecure_clone();
    let redeem = |env: &mut Env, gemas: u64| {
        let position = env.core_position(id);
        let holding = core_pda(&[HOLDING_SEED, env.owner_account.as_ref(), source_key.as_ref()]);
        let claim = bridge_pda(&[CLAIM_SEED, env.owner_account.as_ref(), source_key.as_ref()]);
        let redeem = ix(
            crate::ID,
            crate::accounts::RedeemToEvm {
                holder_authority: a(owner.pubkey()),
                holder_account: env.owner_account,
                core_position: position,
                core_source: source_key,
                core_holding: holding,
                claim,
                core_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::RedeemToEvm { gemas },
        );
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

    redeem(&mut env, 875).expect("redeem the rest of what is redeemable");
    let claim: Claim = env.load(claim_key);
    assert_eq!(claim.gemas_total, 1_875);
    redeem(&mut env, 1).expect_err("nothing redeemable beyond accrued yield");

    // Gemas holders are credited nothing on Solana: the Gemas are burned by the redeem.
    let holding: HoldingState =
        env.load(core_pda(&[HOLDING_SEED, env.owner_account.as_ref(), source_key.as_ref()]));
    assert_eq!(holding.inner.amount, 3_750 - 1_875);
    let account: TesoroAccount = env.load(env.owner_account);
    assert_eq!(account.inner.own_total, 3_750 - 1_875);
}

#[test]
fn a_position_too_large_for_tesoro_core_is_refused_not_truncated() {
    let mut env = Env::new();
    env.receive_locked(2, u128::from(u64::MAX) + 1);
    env.link(EVM_ADDRESS, &hex(LINK_SIGNATURE)).expect("link");
    let err = env.apply_locked(2).expect_err("principal exceeds u64");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::AmountOverflow)));
}

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
        HOLDING_SEED, ONCHAIN_PRICE_SEED, PROTECTIONS_SEED, SOURCE_AUTHORITY_SEED, SOURCE_SEED,
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
        env.init_core_treasury(&admin);
        env.put(
            env.vault_treasury(),
            crate::ID,
            &VaultTreasury {
                eid: EID_HOODI,
                peer_address: msg_codec::pad_address(&VAULT),
                reported_in: 0,
                instant_recorded: 0,
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
                    invite_gate: tesoro_core::state::invite_gate_pda(),
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
                treasury_in: 0,
            },
        );
    }

    /// The inbox after a YieldAccrued with `seq`, `cumulative` and the vault's `treasury_in`.
    fn receive_yield(&mut self, id: u64, seq: u64, cumulative: u128, treasury_in: u128) {
        let key = self.bridge_position(id);
        let mut p: BridgePosition = self.load(key);
        p.last_yield_seq = seq;
        p.yield_cumulative = cumulative;
        p.treasury_in = treasury_in;
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
                holding: core_pda(&[HOLDING_SEED, self.owner_account.as_ref(), source.as_ref()]),
                protections: core_pda(&[PROTECTIONS_SEED, self.owner_account.as_ref()]),
                system_program: anchor_lang::system_program::ID,
            },
            tesoro_core::instruction::TakeAdvance {
                horizon_months: 3,
                price_micro_usd: 3_000_000_000,
            },
        );
        // The asset's `OnchainPrice` address: `take_advance` fails when that account exists.
        advance.accounts.push(AccountMeta {
            pubkey: s(core_pda(&[ONCHAIN_PRICE_SEED, &msg_codec::pad_address(&[0xAB; 20])])),
            is_signer: false,
            is_writable: false,
        });
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
    let source: SourceState = env.load(source_key);
    assert_eq!(source.inner.issued, 3_000);
    assert_eq!(source.inner.debt(), 3_000);

    // No yield reported yet.
    let err = env.apply_yield(id, true).expect_err("nothing to apply");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::NothingToApply)));

    // Half of the projected net yield arrives (the vault reports yield after its Yield Fee): Debt
    // halves.
    env.receive_yield(id, 2, 5_000_000_000_000_000, 0);
    env.apply_yield(id, false).expect_err("the open Advance's Source is required");
    env.apply_yield(id, true).expect("apply yield");
    let source: SourceState = env.load(source_key);
    assert_eq!(source.inner.debt(), 1_500);
    assert_eq!(source.inner.redeemable(), 1_500);
    let err = env.apply_yield(id, true).expect_err("applied once");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::NothingToApply)));

    // F-07: plain `redeem` on tesoro_core would burn the Gemas with no payout recorded; it is refused.
    {
        let holding = core_pda(&[HOLDING_SEED, env.owner_account.as_ref(), source_key.as_ref()]);
        let plain = ix(
            tesoro_core::ID,
            tesoro_core::accounts::Redeem {
                holder_authority: a(env.owner.pubkey()),
                holder_account: env.owner_account,
                position: env.core_position(id),
                source: source_key,
                holding,
            },
            tesoro_core::instruction::Redeem { amount: 1_000 },
        );
        let owner = env.owner.insecure_clone();
        let err = env.send(&[plain], &owner, &[]).expect_err("plain redeem is refused");
        assert_eq!(custom_code(&err), Some(6012), "BridgedSource");
        let holding: HoldingState = env.load(holding);
        assert_eq!(holding.inner.amount, 3_000, "nothing was burned");
    }

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
                store: env.store,
                authority: env.authority,
                core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
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

    redeem(&mut env, 500).expect("redeem the rest of what is redeemable");
    let claim: Claim = env.load(claim_key);
    assert_eq!(claim.gemas_total, 1_500);
    redeem(&mut env, 1).expect_err("nothing redeemable beyond accrued yield");

    // Gemas holders are credited nothing on Solana: the Gemas are burned by the redeem.
    let holding: HoldingState =
        env.load(core_pda(&[HOLDING_SEED, env.owner_account.as_ref(), source_key.as_ref()]));
    assert_eq!(holding.inner.amount, 3_000 - 1_500);
    let account: TesoroAccount = env.load(env.owner_account);
    assert_eq!(account.inner.own_total, 3_000 - 1_500);
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
        let source = core_pda(&[SOURCE_SEED, self.core_position(id).as_ref(), &0u32.to_le_bytes()]);
        let owner_holding_key =
            core_pda(&[HOLDING_SEED, self.owner_account.as_ref(), source.as_ref()]);
        let mut owner_account: TesoroAccount = self.load(self.owner_account);
        let mut owner_holding: HoldingState = self.load(owner_holding_key);
        owner_holding.inner.debit(&mut owner_account.inner, n).expect("debit");
        let mut winner_account: TesoroAccount = self.load(account);
        let holding_key = core_pda(&[HOLDING_SEED, account.as_ref(), source.as_ref()]);
        let mut holding = HoldingState {
            bump: Pubkey::find_program_address(
                &[HOLDING_SEED, account.as_ref(), source.as_ref()],
                &tesoro_core::ID,
            )
            .1,
            account,
            inner: tesoro_core::ledger::Holding::new(source.to_bytes(), false),
        };
        holding.inner.credit(&mut winner_account.inner, n).expect("credit");
        self.put_padded(self.owner_account, &owner_account, TesoroAccount::SPACE);
        self.put_padded(owner_holding_key, &owner_holding, HoldingState::SPACE);
        self.put_padded(account, &winner_account, TesoroAccount::SPACE);
        self.put_padded(holding_key, &holding, HoldingState::SPACE);
        (winner, account, source)
    }

    fn put_padded<T: AccountSerialize>(&mut self, key: Pubkey, account: &T, len: usize) {
        let mut data = Vec::new();
        account.try_serialize(&mut data).expect("serialize");
        data.resize(len, 0);
        let lamports = self.svm.minimum_balance_for_rent_exemption(len);
        self.svm
            .set_account(
                s(key),
                solana_sdk::account::Account {
                    lamports,
                    data,
                    owner: s(tesoro_core::ID),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("set account");
    }

    fn treasury_holding(&self, source: Pubkey) -> Pubkey {
        core_pda(&[HOLDING_SEED, core_treasury_account().as_ref(), source.as_ref()])
    }

    fn instant_redeem(
        &mut self,
        id: u64,
        holder: &Keypair,
        account: Pubkey,
        source: Pubkey,
        gemas: u64,
    ) -> std::result::Result<(), Failed> {
        let instant = ix(
            crate::ID,
            crate::accounts::InstantRedeemToEvm {
                holder_authority: a(holder.pubkey()),
                store: self.store,
                authority: self.authority,
                core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                holder_account: account,
                core_position: self.core_position(id),
                core_source: source,
                core_holding: core_pda(&[HOLDING_SEED, account.as_ref(), source.as_ref()]),
                core_treasury: core_pda(&[TREASURY_SEED]),
                core_treasury_account: core_treasury_account(),
                core_treasury_holding: self.treasury_holding(source),
                vault_treasury: self.vault_treasury(),
                instant_claim: bridge_pda(&[INSTANT_SEED, account.as_ref(), source.as_ref()]),
                core_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::InstantRedeemToEvm { gemas },
        );
        self.send(&[instant], holder, &[])
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

#[test]
fn instant_redeem_is_capped_by_the_mirror_of_the_vault_treasury() {
    let mut env = Env::new();
    let id = 1;
    env.opened_with_advance(id);
    let (bob, bob_account, source) = env.winner_with(id, 1_000);
    // 1,000 Gemas at $3,000/ETH are worth 0.003333... ETH; 65% of it is paid now.
    let units: u64 = 3_333_333_333_333_333;
    let payout = (u128::from(units) * 6_500 / 10_000) as u64;

    // The vault has reported no treasury yet: refused, and nothing moved.
    let err = env.instant_redeem(id, &bob, bob_account, source, 1_000).expect_err("empty");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::TreasuryShort)));
    let holding: HoldingState =
        env.load(core_pda(&[HOLDING_SEED, bob_account.as_ref(), source.as_ref()]));
    assert_eq!(holding.inner.amount, 1_000);
    assert!(env.svm.get_account(&s(env.treasury_holding(source))).is_none());

    // A yield report carries a treasury just short of the payout: still refused.
    env.receive_yield(id, 2, 1_000_000_000_000_000, u128::from(payout) - 1);
    env.sync_treasury(id).expect("sync");
    assert_eq!(env.load::<VaultTreasury>(env.vault_treasury()).reported_in, u128::from(payout) - 1);
    let err = env.instant_redeem(id, &bob, bob_account, source, 1_000).expect_err("short");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::TreasuryShort)));

    // A later report (synced without applying) covers it: accepted and recorded.
    env.receive_yield(id, 3, 1_000_000_000_000_000, u128::from(payout) + 100);
    env.sync_treasury(id).expect("sync");
    env.instant_redeem(id, &bob, bob_account, source, 1_000)
        .expect("instant redeem");
    let treasury: VaultTreasury = env.load(env.vault_treasury());
    assert_eq!(treasury.instant_recorded, u128::from(payout));
    assert_eq!(treasury.available(), 100);
    let claim: InstantClaim =
        env.load(bridge_pda(&[INSTANT_SEED, bob_account.as_ref(), source.as_ref()]));
    assert_eq!((claim.gemas_total, claim.units_total, claim.units_sent), (1_000, payout, 0));
    assert_eq!(claim.position, env.core_position(id));
    let bought: HoldingState = env.load(env.treasury_holding(source));
    assert_eq!((bought.inner.amount, bought.inner.is_own), (1_000, false));
    let source_state: SourceState = env.load(source);
    assert_eq!(source_state.inner.redeemed, 0, "the Source's counts are untouched");

    // The rest of the treasury cannot pay another 1,000; an older, smaller report cannot raise it.
    let (carol, carol_account, _) = env.winner_with(id, 1_000);
    let err = env.instant_redeem(id, &carol, carol_account, source, 1_000).expect_err("spent");
    assert_eq!(custom_code(&err), Some(bridge_err(BridgeError::TreasuryShort)));
    env.receive_yield(id, 4, 1_000_000_000_000_000, 5);
    env.sync_treasury(id).expect("sync");
    assert_eq!(
        env.load::<VaultTreasury>(env.vault_treasury()).reported_in,
        u128::from(payout) + 100
    );

    // The owner's own Gemas never redeem instantly.
    let owner = env.owner.insecure_clone();
    let owner_account = env.owner_account;
    let err = env
        .instant_redeem(id, &owner, owner_account, source, 10)
        .expect_err("own Gemas");
    assert_eq!(
        custom_code(&err),
        Some(
            tesoro_core::error::CORE_ERROR_OFFSET
                + tesoro_core::ledger::CoreError::NotWonGemas.code()
        )
    );
}

#[test]
fn the_treasury_redeems_what_it_bought_into_a_claim_paid_to_the_vault() {
    let mut env = Env::new();
    let id = 1;
    env.opened_with_advance(id);
    let (bob, bob_account, source) = env.winner_with(id, 1_000);
    env.receive_yield(id, 2, 0, ETH);
    env.sync_treasury(id).expect("sync");
    env.instant_redeem(id, &bob, bob_account, source, 1_000)
        .expect("instant redeem");

    let payer = env.admin.insecure_clone();
    let treasury_account = core_treasury_account();
    let claim_key = bridge_pda(&[CLAIM_SEED, treasury_account.as_ref(), source.as_ref()]);
    let redeem = |env: &mut Env, gemas: u64| {
        let redeem = ix(
            crate::ID,
            crate::accounts::RedeemTreasuryToEvm {
                payer: a(payer.pubkey()),
                store: env.store,
                authority: env.authority,
                core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                core_treasury: core_pda(&[TREASURY_SEED]),
                core_treasury_account: treasury_account,
                core_position: env.core_position(id),
                core_source: source,
                core_treasury_holding: env.treasury_holding(source),
                claim: claim_key,
                core_program: tesoro_core::ID,
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::RedeemTreasuryToEvm { gemas },
        );
        env.send(&[redeem], &payer, &[])
    };
    // Nothing has accrued: the Treasury waits like every other holder.
    redeem(&mut env, 1).expect_err("not redeemable yet");

    // All the net yield lands: the Treasury redeems its 1,000 Gemas at full value.
    env.receive_yield(id, 3, 10_000_000_000_000_000, ETH);
    env.apply_yield(id, true).expect("apply yield");
    redeem(&mut env, 1_000).expect("treasury redeems");
    let claim: Claim = env.load(claim_key);
    assert_eq!(claim.holder_account, treasury_account);
    assert_eq!(claim.units_total, 3_333_333_333_333_333, "full value, not 65%");
    assert_eq!(env.load::<HoldingState>(env.treasury_holding(source)).inner.amount, 0);
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
    env.receive_yield(id, 2, 10_000_000_000_000_000, ETH);
    env.sync_treasury(id).expect("sync");
    env.instant_redeem(id, &bob, bob_account, source, 400)
        .expect("instant redeem 400");
    env.apply_yield(id, true).expect("apply yield");
    // Bob redeems his other 600 at full value through the normal path.
    let claim = bridge_pda(&[CLAIM_SEED, bob_account.as_ref(), source.as_ref()]);
    let redeem = ix(
        crate::ID,
        crate::accounts::RedeemToEvm {
            holder_authority: a(bob.pubkey()),
            store: env.store,
            authority: env.authority,
            core_source_authority: core_pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
            holder_account: bob_account,
            core_position: env.core_position(id),
            core_source: source,
            core_holding: core_pda(&[HOLDING_SEED, bob_account.as_ref(), source.as_ref()]),
            claim,
            core_program: tesoro_core::ID,
            system_program: anchor_lang::system_program::ID,
        },
        crate::instruction::RedeemToEvm { gemas: 600 },
    );
    env.send(&[redeem], &bob, &[]).expect("normal redeem");
    let claim: Claim = env.load(claim);
    // 600 Gemas at $3,000/ETH = $6 = 0.002 ETH.
    assert_eq!(claim.units_total, 2_000_000_000_000_000);
}

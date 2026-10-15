//! LiteSVM integration tests against the built program (`pnpm build:programs` first).
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::clock::Clock;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use tesoro_core::instructions::MatchResult;
use tesoro_core::ledger::{CoreError, MatchStatus, Outcome, SourceChain};
use tesoro_core::state::*;
use tesoro_core::{accounts, instruction};

mod common;

const GAME: APk = APk::new_from_array([9; 32]);
const ENTRY: u64 = 1_000;
const SOL: u64 = 1_000_000_000;

fn a(p: Pk) -> APk {
    APk::new_from_array(p.to_bytes())
}
fn s(p: APk) -> Pk {
    Pk::new_from_array(p.to_bytes())
}
fn pda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &tesoro_core::ID).0
}
fn account_pda(auth: APk) -> APk {
    pda(&[ACCOUNT_SEED, auth.as_ref()])
}
fn position_pda(id: u8) -> APk {
    pda(&[POSITION_SEED, &[0], &[id; 32]])
}
fn source_pda(position: APk, index: u32) -> APk {
    pda(&[SOURCE_SEED, position.as_ref(), &index.to_le_bytes()])
}
fn holding_pda(account: APk, source: APk) -> APk {
    pda(&[HOLDING_SEED, account.as_ref(), source.as_ref()])
}
fn match_pda(id: u64) -> APk {
    pda(&[MATCH_SEED, &id.to_le_bytes()])
}
fn request_pda(account: APk, nonce: u64) -> APk {
    pda(&[REQUEST_SEED, account.as_ref(), &nonce.to_le_bytes()])
}
fn offer_pda(account: APk, nonce: u64) -> APk {
    pda(&[OFFER_SEED, account.as_ref(), &nonce.to_le_bytes()])
}
fn protections_pda(account: APk) -> APk {
    pda(&[PROTECTIONS_SEED, account.as_ref()])
}
fn core(e: CoreError) -> u32 {
    tesoro_core::error::CORE_ERROR_OFFSET + e.code()
}

fn ix(
    accounts: impl ToAccountMetas,
    data: impl InstructionData,
    remaining: Vec<AccountMeta>,
) -> Instruction {
    let mut metas: Vec<AccountMeta> = accounts
        .to_account_metas(None)
        .into_iter()
        .map(|m| AccountMeta {
            pubkey: s(m.pubkey),
            is_signer: m.is_signer,
            is_writable: m.is_writable,
        })
        .collect();
    metas.extend(remaining);
    Instruction {
        program_id: s(tesoro_core::ID),
        accounts: metas,
        data: data.data(),
    }
}

fn rem(k: APk) -> AccountMeta {
    AccountMeta::new(s(k), false)
}

struct Person {
    kp: Keypair,
    key: APk,
    account: APk,
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    oracle: Keypair,
    game_auth: Keypair,
    platform: Person,
    studio: Person,
    next_match: u64,
    last_cu: u64,
    /// Serialized size in bytes of the last transaction as a legacy transaction.
    last_size: usize,
    last_logs: Vec<String>,
}

fn custom_code(err: &litesvm::types::FailedTransactionMetadata) -> u32 {
    use solana_sdk::instruction::InstructionError;
    use solana_sdk::transaction::TransactionError;
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => *c,
        other => panic!("unexpected error {other:?}\n{:?}", err.meta.logs),
    }
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../target/deploy/tesoro_core.so"
        );
        assert!(
            std::path::Path::new(so).exists(),
            "build the program first: pnpm build:programs"
        );
        svm.add_program_from_file(s(tesoro_core::ID), so)
            .expect("load program");
        let admin = Keypair::new();
        let oracle = Keypair::new();
        let game_auth = Keypair::new();
        for k in [&admin, &oracle, &game_auth] {
            svm.airdrop(&k.pubkey(), 1_000 * SOL).expect("airdrop");
        }
        svm.set_sysvar(&Clock {
            unix_timestamp: 1_000_000,
            ..Clock::default()
        });
        let placeholder = |kp: Keypair| Person {
            key: a(kp.pubkey()),
            account: APk::default(),
            kp,
        };
        let mut env = Self {
            svm,
            admin,
            oracle,
            game_auth,
            platform: placeholder(Keypair::new()),
            studio: placeholder(Keypair::new()),
            next_match: 1,
            last_cu: 0,
            last_size: 0,
            last_logs: Vec::new(),
        };
        env.platform = env.person();
        env.studio = env.person();
        let platform = env.platform.account;
        let studio = env.studio.account;
        let config = pda(&[CONFIG_SEED]);
        let init = ix(
            accounts::InitializeConfig {
                admin: a(env.admin.pubkey()),
                config,
                platform_recipient: platform,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitializeConfig {
                oracle_authority: a(env.oracle.pubkey()),
                platform_bps: 200,
            },
            vec![],
        );
        let admin = env.admin.insecure_clone();
        env.send(&[init], &admin, &[]).expect("init config");
        // Oracle-reported yield is already net of the Yield Fee (the vault takes it at the
        // source); these suites size Advances without it.
        common::put_sim_sol_mint(&mut env.svm);
        let treasury = common::init_treasury_ix(a(admin.pubkey()), 0, 3_500);
        env.send(&[treasury], &admin, &[]).expect("init treasury");
        let register = ix(
            accounts::RegisterGame {
                admin: a(admin.pubkey()),
                config,
                studio_recipient: studio,
            },
            instruction::RegisterGame {
                game: GAME,
                authority: a(env.game_auth.pubkey()),
                studio_bps: 300,
            },
            vec![],
        );
        env.send(&[register], &admin, &[]).expect("register game");
        env
    }

    fn send(
        &mut self,
        ixs: &[Instruction],
        payer: &Keypair,
        extra: &[&Keypair],
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        self.svm.expire_blockhash();
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&payer.pubkey()),
            &signers,
            self.svm.latest_blockhash(),
        );
        self.last_size = tx.message.serialize().len() + 1 + 64 * tx.signatures.len();
        match self.svm.send_transaction(tx) {
            Ok(meta) => {
                self.last_cu = meta.compute_units_consumed;
                self.last_logs = meta.logs;
                Ok(())
            }
            Err(e) => {
                self.last_cu = e.meta.compute_units_consumed;
                Err(e)
            }
        }
    }

    fn person(&mut self) -> Person {
        let kp = Keypair::new();
        self.svm
            .airdrop(&kp.pubkey(), 1_000 * SOL)
            .expect("airdrop");
        let key = a(kp.pubkey());
        let account = account_pda(key);
        let create = ix(
            accounts::CreateAccount {
                authority: key,
                account,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::CreateAccount {
                evm_address: [0; 20],
            },
            vec![],
        );
        self.send(&[create], &kp, &[]).expect("create account");
        Person { kp, key, account }
    }

    fn load<T: AccountDeserialize>(&self, k: APk) -> T {
        let acct = self.svm.get_account(&s(k)).expect("account exists");
        T::try_deserialize(&mut acct.data.as_slice()).expect("deserialize")
    }

    fn set_time(&mut self, t: i64) {
        self.svm.set_sysvar(&Clock {
            unix_timestamp: t,
            ..Clock::default()
        });
    }
    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    /// Position + first Advance (6 months at $150): 100 tokens at 10% => 5 tokens => 75_000 Gemas.
    fn stake(&mut self, p: &Person, id: u8) -> (APk, APk, APk) {
        self.stake_principal(p, id, 100 * SOL)
    }

    /// Opens a Position of `principal` lamports and takes a 6-month Advance at $150: 750 Gemas
    /// per SOL of principal at the 10% rate used here.
    fn stake_principal(&mut self, p: &Person, id: u8, principal: u64) -> (APk, APk, APk) {
        let position = position_pda(id);
        let config = pda(&[CONFIG_SEED]);
        let open = ix(
            accounts::OpenPosition {
                oracle: a(self.oracle.pubkey()),
                config,
                owner_account: p.account,
                position,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::OpenPosition {
                source_chain: SourceChain::Solana,
                position_id: [id; 32],
                source_asset: APk::new_unique(),
                decimals: 9,
                principal,
                rate_bps: 1_000,
            },
            vec![],
        );
        let oracle = self.oracle.insecure_clone();
        self.send(&[open], &oracle, &[]).expect("open position");
        let source = source_pda(position, 0);
        let holding = holding_pda(p.account, source);
        self.take_advance(p, position, 0, 6, 150_000_000)
            .expect("advance");
        (position, source, holding)
    }

    fn take_advance(
        &mut self,
        p: &Person,
        position: APk,
        index: u32,
        horizon: u8,
        price: u64,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let source = source_pda(position, index);
        let advance = ix(
            accounts::TakeAdvance {
                oracle: a(self.oracle.pubkey()),
                owner_authority: p.key,
                config: pda(&[CONFIG_SEED]),
                treasury: common::treasury(),
                owner_account: p.account,
                protections: protections_pda(p.account),
                position,
                source,
                holding: holding_pda(p.account, source),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::TakeAdvance {
                horizon_months: horizon,
                price_micro_usd: price,
            },
            vec![],
        );
        let oracle = self.oracle.insecure_clone();
        self.send(&[advance], &oracle, &[&p.kp])
    }

    fn yield_to(
        &mut self,
        signer: &Keypair,
        position: APk,
        source: Option<APk>,
        seq: u64,
        cumulative: u64,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let apply = ix(
            accounts::ApplyYield {
                oracle: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                position,
                source,
            },
            instruction::ApplyYield { seq, cumulative },
            vec![],
        );
        self.send(&[apply], signer, &[])
    }

    fn holding_amount(&self, p: &Person, source: APk) -> u64 {
        self.svm
            .get_account(&s(holding_pda(p.account, source)))
            .map(|_| {
                self.load::<HoldingState>(holding_pda(p.account, source))
                    .inner
                    .amount
            })
            .unwrap_or(0)
    }

    fn open_holding(&mut self, account: APk, source: APk) {
        let holding = holding_pda(account, source);
        if self.svm.get_account(&s(holding)).is_some() {
            return;
        }
        let open = ix(
            accounts::OpenHolding {
                payer: a(self.admin.pubkey()),
                account,
                source,
                holding,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::OpenHolding {},
            vec![],
        );
        let admin = self.admin.insecure_clone();
        self.send(&[open], &admin, &[]).expect("open holding");
    }

    fn open_match(
        &mut self,
        p: &Person,
        entry: u64,
        holdings: &[APk],
    ) -> Result<u64, litesvm::types::FailedTransactionMetadata> {
        let id = self.next_match;
        self.next_match += 1;
        let open = ix(
            accounts::OpenMatch {
                player_authority: p.key,
                config: pda(&[CONFIG_SEED]),
                player_account: p.account,
                protections: protections_pda(p.account),
                match_state: match_pda(id),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::OpenMatch {
                match_id: id,
                game: GAME,
                entry,
            },
            holdings.iter().map(|h| rem(*h)).collect(),
        );
        self.send(&[open], &p.kp, &[]).map(|_| id)
    }

    fn set_entry_limit(
        &mut self,
        p: &Person,
        gemas: u64,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let set = ix(
            accounts::SetEntryLimit {
                owner_authority: p.key,
                owner_account: p.account,
                protections: protections_pda(p.account),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetEntryLimit { gemas },
            vec![],
        );
        self.send(&[set], &p.kp, &[])
    }

    fn set_break(
        &mut self,
        p: &Person,
        days: u16,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let set = ix(
            accounts::SetProtection {
                owner_authority: p.key,
                owner_account: p.account,
                protections: protections_pda(p.account),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetBreak { days },
            vec![],
        );
        self.send(&[set], &p.kp, &[])
    }

    fn set_self_exclusion(
        &mut self,
        p: &Person,
        months: u16,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let set = ix(
            accounts::SetProtection {
                owner_authority: p.key,
                owner_account: p.account,
                protections: protections_pda(p.account),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetSelfExclusion { months },
            vec![],
        );
        self.send(&[set], &p.kp, &[])
    }

    fn protections(&self, p: &Person) -> tesoro_core::ledger::Protections {
        self.load::<ProtectionsState>(protections_pda(p.account))
            .inner
    }

    fn entry_limit(&self, p: &Person) -> tesoro_core::ledger::EntryLimit {
        self.load::<ProtectionsState>(protections_pda(p.account))
            .inner
            .entry_limit
    }

    fn join_match(
        &mut self,
        p: &Person,
        id: u64,
        holdings: &[APk],
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let join = ix(
            accounts::JoinMatch {
                player_authority: p.key,
                player_account: p.account,
                protections: protections_pda(p.account),
                match_state: match_pda(id),
                opener_protections: protections_pda(self.opener_account(id)),
            },
            instruction::JoinMatch {},
            holdings.iter().map(|h| rem(*h)).collect(),
        );
        self.send(&[join], &p.kp, &[])
    }

    fn opener_account(&self, id: u64) -> APk {
        APk::new_from_array(self.load::<MatchState>(match_pda(id)).inner.a.player)
    }

    fn payout_accounts(&mut self, id: u64, result: MatchResult) -> Vec<AccountMeta> {
        let mut m = self.load::<MatchState>(match_pda(id)).inner;
        let outcome = match result {
            MatchResult::Opener => Outcome::Winner(0),
            MatchResult::Joiner => Outcome::Winner(1),
            MatchResult::Draw => Outcome::Draw,
        };
        let lb = self.load::<Config>(pda(&[CONFIG_SEED])).leaderboard_terms();
        let payouts = m.settle_with(outcome, &lb).expect("ledger settles");
        self.payout_metas(&payouts)
    }

    fn refund_accounts(&mut self, id: u64) -> Vec<AccountMeta> {
        let mut m = self.load::<MatchState>(match_pda(id)).inner;
        let payouts = m.refund(i64::MAX, true).expect("ledger refunds");
        self.payout_metas(&payouts)
    }

    fn payout_metas(&mut self, payouts: &[tesoro_core::ledger::Payout]) -> Vec<AccountMeta> {
        let mut metas = Vec::new();
        for p in payouts {
            let recipient = APk::new_from_array(p.recipient);
            let source = APk::new_from_array(p.source);
            self.open_holding(recipient, source);
            metas.push(rem(recipient));
            metas.push(rem(holding_pda(recipient, source)));
        }
        metas
    }

    fn settle(
        &mut self,
        signer: &Keypair,
        id: u64,
        result: MatchResult,
        remaining: Vec<AccountMeta>,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let settle = ix(
            accounts::SettleMatch {
                game_authority: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                match_state: match_pda(id),
            },
            instruction::SettleMatch { result },
            remaining,
        );
        self.send(&[settle], signer, &[])
    }

    fn refund(
        &mut self,
        caller: &Keypair,
        id: u64,
        remaining: Vec<AccountMeta>,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let refund = ix(
            accounts::RefundMatch {
                caller: a(caller.pubkey()),
                config: pda(&[CONFIG_SEED]),
                match_state: match_pda(id),
                opener_protections: Some(protections_pda(self.opener_account(id))),
            },
            instruction::RefundMatch {},
            remaining,
        );
        self.send(&[refund], caller, &[])
    }

    fn total_gemas(&self, p: &Person) -> u64 {
        let acct = self.load::<TesoroAccount>(p.account).inner;
        acct.own_total + acct.won_total
    }
}

/// Two stakers, alice and bob, each with 75_000 Gemas of their own Source.
struct Duel {
    env: Env,
    alice: Person,
    bob: Person,
    a_position: APk,
    a_source: APk,
    a_holding: APk,
    b_source: APk,
    b_holding: APk,
}

fn duel() -> Duel {
    let mut env = Env::new();
    let alice = env.person();
    let bob = env.person();
    let (a_position, a_source, a_holding) = env.stake(&alice, 1);
    let (_, b_source, b_holding) = env.stake(&bob, 2);
    Duel {
        env,
        alice,
        bob,
        a_position,
        a_source,
        a_holding,
        b_source,
        b_holding,
    }
}

#[test]
fn advance_is_100_percent_of_projected_yield_in_gemas() {
    let d = duel();
    let src = d.env.load::<SourceState>(d.a_source).inner;
    assert_eq!(src.issued, 75_000);
    assert_eq!(src.debt(), 75_000);
    assert_eq!(d.env.holding_amount(&d.alice, d.a_source), 75_000);
    let acct = d.env.load::<TesoroAccount>(d.alice.account).inner;
    assert_eq!((acct.own_total, acct.won_total), (75_000, 0));
}

#[test]
fn one_open_advance_per_position_and_horizon_bounds() {
    let mut d = duel();
    let err = d
        .env
        .take_advance(&d.alice, d.a_position, 1, 3, 150_000_000)
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::AdvanceAlreadyOpen));
    // Clear the Debt, then horizons outside 1..=12 are still refused.
    let src = Some(d.a_source);
    let oracle = d.env.oracle.insecure_clone();
    d.env
        .yield_to(&oracle, d.a_position, src, 1, 6 * SOL)
        .expect("yield");
    for bad in [0u8, 13] {
        let err = d
            .env
            .take_advance(&d.alice, d.a_position, 1, bad, 150_000_000)
            .unwrap_err();
        assert_eq!(custom_code(&err), core(CoreError::InvalidHorizon));
    }
    d.env
        .take_advance(&d.alice, d.a_position, 1, 12, 150_000_000)
        .expect("second advance");
    assert_eq!(
        d.env
            .load::<SourceState>(source_pda(d.a_position, 1))
            .inner
            .issued,
        150_000
    );
}

#[test]
fn only_the_oracle_authority_reports_yield_and_prices() {
    let mut d = duel();
    let intruder = d.alice.kp.insecure_clone();
    let err = d
        .env
        .yield_to(&intruder, d.a_position, Some(d.a_source), 1, SOL)
        .unwrap_err();
    assert_eq!(custom_code(&err), 6000);
    // The owner cannot pick their own price either: the oracle must co-sign.
    let mut env = Env::new();
    let carol = env.person();
    let open = ix(
        accounts::OpenPosition {
            oracle: carol.key,
            config: pda(&[CONFIG_SEED]),
            owner_account: carol.account,
            position: position_pda(3),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::OpenPosition {
            source_chain: SourceChain::Solana,
            position_id: [3; 32],
            source_asset: APk::new_unique(),
            decimals: 9,
            principal: SOL,
            rate_bps: 1_000,
        },
        vec![],
    );
    let err = env.send(&[open], &carol.kp, &[]).unwrap_err();
    assert_eq!(custom_code(&err), 6000);
}

#[test]
fn yield_repays_debt_and_redeem_stops_at_accrued() {
    let mut d = duel();
    let oracle = d.env.oracle.insecure_clone();
    // 2.5 tokens accrued = $375 = 37_500 Gemas repaid, half of the Advance.
    d.env
        .yield_to(&oracle, d.a_position, Some(d.a_source), 1, 5 * SOL / 2)
        .expect("yield");
    let src = d.env.load::<SourceState>(d.a_source).inner;
    assert_eq!(src.debt(), 37_500);
    assert_eq!(src.redeemable(), 37_500);

    // Replay of the same message and an older sequence change nothing.
    let before = d.env.load::<PositionState>(d.a_position).inner;
    d.env
        .yield_to(&oracle, d.a_position, Some(d.a_source), 1, 4 * SOL)
        .expect("replay is a no-op");
    d.env
        .yield_to(&oracle, d.a_position, Some(d.a_source), 0, 4 * SOL)
        .expect("stale is a no-op");
    assert_eq!(d.env.load::<PositionState>(d.a_position).inner, before);
    assert_eq!(d.env.load::<SourceState>(d.a_source).inner.debt(), 37_500);
    // Cumulative yield never goes backwards.
    let err = d
        .env
        .yield_to(&oracle, d.a_position, Some(d.a_source), 2, SOL)
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::CumulativeDecreased));

    let redeem = |d: &mut Duel, amount: u64| {
        let position = d.a_position;
        let ixn = ix(
            accounts::Redeem {
                holder_authority: d.alice.key,
                holder_account: d.alice.account,
                position,
                source: d.a_source,
                holding: d.a_holding,
            },
            instruction::Redeem { amount },
            vec![],
        );
        let alice = d.alice.kp.insecure_clone();
        d.env.send(&[ixn], &alice, &[])
    };
    let err = redeem(&mut d, 37_501).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::ExceedsRedeemable));
    redeem(&mut d, 37_500).expect("redeem accrued part");
    let src = d.env.load::<SourceState>(d.a_source).inner;
    assert_eq!((src.redeemed, src.redeemed_units), (37_500, 2_500_000_000));
    assert_eq!(d.env.holding_amount(&d.alice, d.a_source), 37_500);
    let err = redeem(&mut d, 1).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::ExceedsRedeemable));

    // Debt remains, so the Position stays locked and cannot unlock.
    let unlock = ix(
        accounts::Unlock {
            owner_authority: d.alice.key,
            owner_account: d.alice.account,
            position: d.a_position,
        },
        instruction::Unlock {},
        vec![],
    );
    let alice = d.alice.kp.insecure_clone();
    let err = d
        .env
        .send(std::slice::from_ref(&unlock), &alice, &[])
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::DebtOutstanding));
    d.env
        .yield_to(&oracle, d.a_position, Some(d.a_source), 3, 6 * SOL)
        .expect("more yield");
    assert_eq!(d.env.load::<SourceState>(d.a_source).inner.debt(), 0);
    d.env
        .send(&[unlock], &alice, &[])
        .expect("unlock at zero debt");
}

#[test]
fn return_own_cancels_debt_and_principal_never_does() {
    let mut d = duel();
    let return_ix = |d: &Duel, who: &Person, amount: u64| {
        ix(
            accounts::ReturnOwn {
                owner_authority: who.key,
                owner_account: who.account,
                position: d.a_position,
                source: d.a_source,
                holding: holding_pda(who.account, d.a_source),
            },
            instruction::ReturnOwn { amount },
            vec![],
        )
    };
    let alice = d.alice.kp.insecure_clone();
    d.env
        .send(&[return_ix(&d, &d.alice, 10_000)], &alice, &[])
        .expect("return own");
    let src = d.env.load::<SourceState>(d.a_source).inner;
    assert_eq!(
        (src.returned, src.debt(), src.outstanding()),
        (10_000, 65_000, 65_000)
    );
    assert_eq!(d.env.holding_amount(&d.alice, d.a_source), 65_000);
    // More than the Debt is refused.
    let err = d
        .env
        .send(&[return_ix(&d, &d.alice, 65_001)], &alice, &[])
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::ExceedsDebt));

    // Bob wins some of Alice's Gemas; returning them (or anything else) as Bob cannot cut her Debt.
    let bob = d.bob.kp.insecure_clone();
    let m = d
        .env
        .open_match(&d.alice, ENTRY, &[d.a_holding])
        .expect("open");
    d.env.join_match(&d.bob, m, &[d.b_holding]).expect("join");
    let game = d.env.game_auth.insecure_clone();
    let payouts = d.env.payout_accounts(m, MatchResult::Joiner);
    d.env
        .settle(&game, m, MatchResult::Joiner, payouts)
        .expect("settle");
    assert!(d.env.holding_amount(&d.bob, d.a_source) > 0);
    let debt = d.env.load::<SourceState>(d.a_source).inner.debt();
    // Bob is not the Position owner: the ownership constraint rejects it.
    assert!(d.env.send(&[return_ix(&d, &d.bob, 1)], &bob, &[]).is_err());
    assert_eq!(d.env.load::<SourceState>(d.a_source).inner.debt(), debt);
}

#[test]
fn match_settles_to_winner_minus_fees_exactly_once() {
    let mut d = duel();
    let m = d
        .env
        .open_match(&d.alice, ENTRY, &[d.a_holding])
        .expect("open");
    let game = d.env.game_auth.insecure_clone();
    // Not Active yet.
    let err = d
        .env
        .settle(&game, m, MatchResult::Opener, vec![])
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidStatus));
    d.env.join_match(&d.bob, m, &[d.b_holding]).expect("join");
    assert_eq!(d.env.holding_amount(&d.alice, d.a_source), 74_000);

    // Only the registered Game authority settles.
    let payouts = d.env.payout_accounts(m, MatchResult::Opener);
    let alice = d.alice.kp.insecure_clone();
    let err = d
        .env
        .settle(&alice, m, MatchResult::Opener, payouts.clone())
        .unwrap_err();
    assert_eq!(custom_code(&err), 6000);
    let stranger = Keypair::new();
    d.env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    let err = d
        .env
        .settle(&stranger, m, MatchResult::Opener, payouts.clone())
        .unwrap_err();
    assert_eq!(custom_code(&err), 6000);
    // Wrong or short payout accounts are refused.
    assert!(d.env.settle(&game, m, MatchResult::Opener, vec![]).is_err());

    d.env
        .settle(&game, m, MatchResult::Opener, payouts.clone())
        .expect("settle");
    // Pot 2_000: platform 2% = 40, studio 3% = 60, Alice 1_000 back + 900 won.
    assert_eq!(d.env.total_gemas(&d.env.platform), 40);
    assert_eq!(d.env.total_gemas(&d.env.studio), 60);
    assert_eq!(d.env.holding_amount(&d.alice, d.a_source), 74_000 + 1_000);
    assert_eq!(d.env.holding_amount(&d.alice, d.b_source), 900);
    assert_eq!(d.env.total_gemas(&d.alice), 75_000 + 900);
    assert_eq!(d.env.holding_amount(&d.bob, d.b_source), 74_000);
    assert_eq!(
        d.env.load::<MatchState>(match_pda(m)).inner.status,
        MatchStatus::Settled
    );
    // Won Gemas keep their Source: Bob's Debt is untouched and Alice's own Debt is too.
    assert_eq!(d.env.load::<SourceState>(d.b_source).inner.debt(), 75_000);

    // Exactly once.
    let err = d
        .env
        .settle(&game, m, MatchResult::Opener, payouts.clone())
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidStatus));
    let err = d
        .env
        .settle(&game, m, MatchResult::Joiner, payouts)
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidStatus));
    let err = d.env.refund(&game, m, vec![]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidStatus));

    // Per-Source conservation across every Holding.
    for src in [d.a_source, d.b_source] {
        let total: u64 = [&d.alice, &d.bob, &d.env.platform, &d.env.studio]
            .iter()
            .map(|p| d.env.holding_amount(p, src))
            .sum();
        assert_eq!(total, d.env.load::<SourceState>(src).inner.outstanding());
    }
}

#[test]
fn unregistered_game_cannot_settle_and_bad_entries_are_refused() {
    let mut d = duel();
    let err = d.env.open_match(&d.alice, 700, &[d.a_holding]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidEntry));
    let m = d
        .env
        .open_match(&d.alice, 500, &[d.a_holding])
        .expect("open");
    d.env.join_match(&d.bob, m, &[d.b_holding]).expect("join");
    // A Game removed from the registry can no longer settle.
    let remove = ix(
        accounts::RemoveGame {
            admin: a(d.env.admin.pubkey()),
            config: pda(&[CONFIG_SEED]),
        },
        instruction::RemoveGame { game: GAME },
        vec![],
    );
    let admin = d.env.admin.insecure_clone();
    d.env.send(&[remove], &admin, &[]).expect("remove");
    let game = d.env.game_auth.insecure_clone();
    let payouts = d.env.payout_accounts(m, MatchResult::Opener);
    let err = d
        .env
        .settle(&game, m, MatchResult::Opener, payouts)
        .unwrap_err();
    assert_eq!(custom_code(&err), 6001);
}

#[test]
fn entry_draws_own_sourced_gemas_first() {
    let mut d = duel();
    // Bob wins 900 of Alice's Gemas, then enters with own and won holdings supplied.
    let m = d
        .env
        .open_match(&d.alice, ENTRY, &[d.a_holding])
        .expect("open");
    d.env.join_match(&d.bob, m, &[d.b_holding]).expect("join");
    let game = d.env.game_auth.insecure_clone();
    let payouts = d.env.payout_accounts(m, MatchResult::Joiner);
    d.env
        .settle(&game, m, MatchResult::Joiner, payouts)
        .expect("settle");
    let won = holding_pda(d.bob.account, d.a_source);
    // A won holding that would contribute nothing is refused: the entry comes from own Gemas.
    let err = d
        .env
        .open_match(&d.bob, ENTRY, &[d.b_holding, won])
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NonCanonicalDraw));
    // Won-first ordering is refused, too.
    let err = d
        .env
        .open_match(&d.bob, ENTRY, &[won, d.b_holding])
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NonCanonicalDraw));
    // Someone else's Holding cannot fund the entry.
    let err = d.env.open_match(&d.bob, ENTRY, &[d.a_holding]).unwrap_err();
    assert_eq!(custom_code(&err), 6003);
    d.env
        .open_match(&d.bob, ENTRY, &[d.b_holding])
        .expect("own first");
}

#[test]
fn draw_and_no_show_refund_both_entries_once() {
    let mut d = duel();
    let m = d
        .env
        .open_match(&d.alice, ENTRY, &[d.a_holding])
        .expect("open");
    d.env.join_match(&d.bob, m, &[d.b_holding]).expect("join");
    let game = d.env.game_auth.insecure_clone();
    let payouts = d.env.payout_accounts(m, MatchResult::Draw);
    d.env
        .settle(&game, m, MatchResult::Draw, payouts)
        .expect("draw");
    assert_eq!(d.env.total_gemas(&d.alice), 75_000);
    assert_eq!(d.env.total_gemas(&d.bob), 75_000);
    assert_eq!(d.env.total_gemas(&d.env.platform), 0);

    // No-show: anybody refunds after the deadline, nobody before.
    let m = d
        .env
        .open_match(&d.alice, ENTRY, &[d.a_holding])
        .expect("open");
    d.env.join_match(&d.bob, m, &[d.b_holding]).expect("join");
    let stranger = Keypair::new();
    d.env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    let payouts = d.env.payout_accounts(m, MatchResult::Draw);
    let err = d.env.refund(&stranger, m, payouts.clone()).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NotExpired));
    let now = d.env.now();
    d.env.set_time(now + 3_601);
    d.env
        .refund(&stranger, m, payouts.clone())
        .expect("refund after timeout");
    assert_eq!(d.env.total_gemas(&d.alice), 75_000);
    assert_eq!(d.env.total_gemas(&d.bob), 75_000);
    let err = d.env.refund(&stranger, m, payouts).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidStatus));
    assert_eq!(
        d.env.load::<MatchState>(match_pda(m)).inner.status,
        MatchStatus::Refunded
    );
}

#[test]
fn only_the_game_authority_extends_a_deadline_forward_and_within_the_cap() {
    let mut d = duel();
    let m = d
        .env
        .open_match(&d.alice, ENTRY, &[d.a_holding])
        .expect("open");
    d.env.join_match(&d.bob, m, &[d.b_holding]).expect("join");
    let extend = |d: &mut Duel, signer: &Keypair, deadline: i64| {
        let i = ix(
            accounts::ExtendMatchDeadline {
                game_authority: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                match_state: match_pda(m),
            },
            instruction::ExtendMatchDeadline {
                new_deadline: deadline,
            },
            vec![],
        );
        d.env.send(&[i], signer, &[])
    };
    let now = d.env.now();
    let game = d.env.game_auth.insecure_clone();
    let alice = d.alice.kp.insecure_clone();
    let err = extend(&mut d, &alice, now + 86_400).unwrap_err();
    assert_eq!(custom_code(&err), 6000);
    let err = extend(&mut d, &game, now + 60).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidDeadline));
    let err = extend(&mut d, &game, now + 8 * 86_400).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidDeadline));
    extend(&mut d, &game, now + 86_400).expect("extend");
    assert_eq!(
        d.env.load::<MatchState>(match_pda(m)).inner.deadline,
        now + 86_400
    );

    // Nobody may refund at the old deadline any more.
    let stranger = Keypair::new();
    d.env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    d.env.set_time(now + 3_601);
    let payouts = d.env.payout_accounts(m, MatchResult::Draw);
    let err = d.env.refund(&stranger, m, payouts).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NotExpired));
}

/// Carol backs Dave (no Position, so no Debt) against Bob.
struct Backing {
    d: Duel,
    carol: Person,
    dave: Person,
    c_source: APk,
    c_holding: APk,
}

fn backing_setup() -> Backing {
    let mut d = duel();
    let carol = d.env.person();
    let dave = d.env.person();
    let (_, c_source, c_holding) = d.env.stake(&carol, 3);
    Backing {
        d,
        carol,
        dave,
        c_source,
        c_holding,
    }
}

impl Backing {
    fn request(&mut self, nonce: u64, entry: u64) -> APk {
        let request = request_pda(self.dave.account, nonce);
        let create = ix(
            accounts::CreateRequest {
                player_authority: self.dave.key,
                config: pda(&[CONFIG_SEED]),
                player_account: self.dave.account,
                protections: protections_pda(self.dave.account),
                request,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::CreateRequest {
                nonce,
                game: GAME,
                entry,
            },
            vec![],
        );
        let dave = self.dave.kp.insecure_clone();
        self.d.env.send(&[create], &dave, &[]).expect("request");
        request
    }

    fn offer(&mut self, nonce: u64, entry: u64, share: u16, directed: Option<APk>) -> APk {
        let offer = offer_pda(self.carol.account, nonce);
        let create = ix(
            accounts::CreateOffer {
                backer_authority: self.carol.key,
                config: pda(&[CONFIG_SEED]),
                backer_account: self.carol.account,
                protections: protections_pda(self.carol.account),
                offer,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::CreateOffer {
                nonce,
                game: GAME,
                entry,
                player_share_bps: share,
                directed_request: directed,
            },
            vec![rem(self.c_holding)],
        );
        let carol = self.carol.kp.insecure_clone();
        self.d.env.send(&[create], &carol, &[]).expect("offer");
        offer
    }

    fn accept_public(&mut self, offer: APk, request: APk) {
        let apply = ix(
            accounts::ApplyOffer {
                player_authority: self.dave.key,
                player_account: self.dave.account,
                protections: protections_pda(self.dave.account),
                request,
                offer,
            },
            instruction::ApplyOffer {},
            vec![],
        );
        let dave = self.dave.kp.insecure_clone();
        self.d.env.send(&[apply], &dave, &[]).expect("apply");
        let accept = ix(
            accounts::AcceptApplicant {
                backer_authority: self.carol.key,
                backer_account: self.carol.account,
                request,
                player_protections: protections_pda(self.dave.account),
                offer,
            },
            instruction::AcceptApplicant {},
            vec![],
        );
        let carol = self.carol.kp.insecure_clone();
        self.d.env.send(&[accept], &carol, &[]).expect("accept");
    }

    fn open_backed(
        &mut self,
        offer: APk,
        entry: u64,
        holdings: &[APk],
    ) -> Result<u64, litesvm::types::FailedTransactionMetadata> {
        let id = self.d.env.next_match;
        self.d.env.next_match += 1;
        let open = ix(
            accounts::OpenMatchBacked {
                player_authority: self.dave.key,
                config: pda(&[CONFIG_SEED]),
                player_account: self.dave.account,
                protections: protections_pda(self.dave.account),
                offer,
                backer_account: self.carol.account,
                backer_protections: protections_pda(self.carol.account),
                match_state: match_pda(id),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::OpenMatchBacked {
                match_id: id,
                game: GAME,
                entry,
            },
            holdings.iter().map(|h| rem(*h)).collect(),
        );
        let dave = self.dave.kp.insecure_clone();
        self.d.env.send(&[open], &dave, &[]).map(|_| id)
    }

    fn reserved(&self) -> u64 {
        self.d
            .env
            .load::<HoldingState>(self.c_holding)
            .inner
            .reserved
    }
}

#[test]
fn backing_win_returns_backer_entry_then_splits_and_player_has_no_debt() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 4_000, None);
    assert_eq!(b.reserved(), 500);
    b.accept_public(offer, request);
    let id = b
        .open_backed(offer, 500, &[b.c_holding])
        .expect("backed entry");
    assert_eq!(b.d.env.holding_amount(&b.carol, b.c_source), 75_000 - 500);
    b.d.env
        .join_match(&b.d.bob, id, &[b.d.b_holding])
        .map(|_| ())
        .expect("join");

    // Backed Player Dave wins: Pot 1_000, fees 20 + 30, surplus 450 => Dave 180, Carol 500 + 270.
    let game = b.d.env.game_auth.insecure_clone();
    let payouts = b.d.env.payout_accounts(id, MatchResult::Opener);
    b.d.env
        .settle(&game, id, MatchResult::Opener, payouts)
        .expect("settle");
    assert_eq!(b.d.env.total_gemas(&b.dave), 180);
    assert_eq!(
        b.d.env.holding_amount(&b.carol, b.c_source),
        75_000 - 500 + 500
    );
    assert_eq!(b.d.env.holding_amount(&b.carol, b.d.b_source), 270);
    assert_eq!(b.d.env.holding_amount(&b.dave, b.d.b_source), 180);
    // Dave never gained a Position or Debt, and none of Carol's Sources moved to him.
    assert!(b
        .d
        .env
        .svm
        .get_account(&s(holding_pda(b.dave.account, b.c_source)))
        .is_none());
    assert_eq!(b.d.env.load::<SourceState>(b.c_source).inner.debt(), 75_000);
    assert_eq!(
        b.d.env.load::<OfferState>(offer).inner.status,
        tesoro_core::ledger::OfferStatus::Consumed
    );
}

#[test]
fn backing_loss_costs_the_backer_the_entry_and_nothing_more() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 4_000, Some(request));
    let accept = ix(
        accounts::AcceptDirected {
            player_authority: b.dave.key,
            player_account: b.dave.account,
            protections: protections_pda(b.dave.account),
            request,
            offer,
        },
        instruction::AcceptDirected {},
        vec![],
    );
    let dave = b.dave.kp.insecure_clone();
    b.d.env
        .send(&[accept], &dave, &[])
        .expect("accept directed");
    let id = b
        .open_backed(offer, 500, &[b.c_holding])
        .expect("backed entry");
    b.d.env
        .join_match(&b.d.bob, id, &[b.d.b_holding])
        .expect("join");
    let game = b.d.env.game_auth.insecure_clone();
    let payouts = b.d.env.payout_accounts(id, MatchResult::Joiner);
    b.d.env
        .settle(&game, id, MatchResult::Joiner, payouts)
        .expect("settle");
    // Carol lost exactly 500 Gemas (75_000 -> 74_500); Bob got them minus the fees.
    assert_eq!(b.d.env.total_gemas(&b.carol), 74_500);
    assert_eq!(b.d.env.total_gemas(&b.dave), 0);
    assert_eq!(b.d.env.holding_amount(&b.d.bob, b.c_source), 450);
    assert_eq!(b.d.env.load::<SourceState>(b.c_source).inner.debt(), 75_000);
}

#[test]
fn backing_cannot_be_revoked_after_start_and_backed_player_cannot_move_backer_gemas() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    b.accept_public(offer, request);
    // Dave cannot enter a plain Match with Carol's Holding.
    let err =
        b.d.env
            .open_match(&b.dave, 500, &[b.c_holding])
            .unwrap_err();
    assert_eq!(custom_code(&err), 6003);
    let id = b
        .open_backed(offer, 500, &[b.c_holding])
        .expect("backed entry");
    // The Offer is Consumed once the Match started: it cannot be cancelled, reused or expired.
    let cancel = ix(
        accounts::CancelOffer {
            backer_authority: b.carol.key,
            backer_account: b.carol.account,
            offer,
            request: None,
        },
        instruction::CancelOffer {},
        vec![rem(b.c_holding)],
    );
    let carol = b.carol.kp.insecure_clone();
    let err = b.d.env.send(&[cancel], &carol, &[]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidStatus));
    let err = b.open_backed(offer, 500, &[b.c_holding]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidStatus));
    // A Match nobody joins refunds the Backer, not the Player.
    let now = b.d.env.now();
    b.d.env.set_time(now + 3_601);
    let stranger = b.d.env.admin.insecure_clone();
    let payouts = b.d.env.refund_accounts(id);
    b.d.env.refund(&stranger, id, payouts).expect("refund");
    assert_eq!(b.d.env.total_gemas(&b.carol), 75_000);
    assert_eq!(b.d.env.total_gemas(&b.dave), 0);
}

const DAY: i64 = 24 * 3_600;

#[test]
fn an_entry_limit_stops_opening_and_joining_over_it() {
    let mut d = duel();
    d.env.set_entry_limit(&d.alice, 1_000).unwrap();
    d.env.set_entry_limit(&d.bob, 500).unwrap();
    let m1 = d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap();
    let m2 = d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap();
    // The third entry of the period is over Alice's 1,000: refused, and no Gemas leave her.
    let free = d
        .env
        .load::<TesoroAccount>(d.alice.account)
        .inner
        .own_free();
    let err = d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
    assert_eq!(
        d.env
            .load::<TesoroAccount>(d.alice.account)
            .inner
            .own_free(),
        free
    );
    assert_eq!(d.env.entry_limit(&d.alice).window_used, 1_000);
    // Bob's 500 covers one join, not two.
    d.env.join_match(&d.bob, m1, &[d.b_holding]).unwrap();
    let err = d.env.join_match(&d.bob, m2, &[d.b_holding]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
    assert_eq!(d.env.entry_limit(&d.bob).window_used, 500);
    // A new period (7 days after the first entry) opens room again.
    let now = d.env.now();
    d.env.set_time(now + 7 * DAY - 1);
    let err = d.env.open_match(&d.bob, 500, &[d.b_holding]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
    d.env.set_time(now + 7 * DAY);
    d.env.open_match(&d.bob, 500, &[d.b_holding]).unwrap();
    assert_eq!(d.env.entry_limit(&d.bob).window_used, 500);
}

#[test]
fn a_raised_entry_limit_waits_a_day_and_a_lowered_one_applies_at_once() {
    let mut d = duel();
    d.env.set_entry_limit(&d.alice, 500).unwrap();
    d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap();
    d.env.set_entry_limit(&d.alice, 2_500).unwrap();
    let l = d.env.entry_limit(&d.alice);
    assert_eq!((l.gemas, l.pending_gemas), (500, 2_500));
    let err = d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
    let now = d.env.now();
    d.env.set_time(now + DAY);
    d.env.open_match(&d.alice, 1_000, &[d.a_holding]).unwrap();
    assert_eq!(d.env.entry_limit(&d.alice).gemas, 2_500);
    // Lowering below what is used applies at once.
    d.env.set_entry_limit(&d.alice, 500).unwrap();
    let err = d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
}

#[test]
fn removing_the_entry_limit_lifts_it_after_a_day() {
    let mut d = duel();
    d.env.set_entry_limit(&d.alice, 500).unwrap();
    d.env.set_entry_limit(&d.alice, 0).unwrap();
    let err = d
        .env
        .open_match(&d.alice, 1_000, &[d.a_holding])
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
    let now = d.env.now();
    d.env.set_time(now + DAY);
    d.env.open_match(&d.alice, 1_000, &[d.a_holding]).unwrap();
    d.env.open_match(&d.alice, 2_500, &[d.a_holding]).unwrap();
}

#[test]
fn funding_a_backing_counts_toward_the_backers_entry_limit() {
    let mut b = backing_setup();
    b.d.env.set_entry_limit(&b.carol, 500).unwrap();
    b.offer(1, 500, 5_000, None);
    assert_eq!(b.d.env.entry_limit(&b.carol).window_used, 500);
    // A second Offer would put 1,000 at risk in the period.
    let offer = offer_pda(b.carol.account, 2);
    let create = ix(
        accounts::CreateOffer {
            backer_authority: b.carol.key,
            config: pda(&[CONFIG_SEED]),
            backer_account: b.carol.account,
            protections: protections_pda(b.carol.account),
            offer,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::CreateOffer {
            nonce: 2,
            game: GAME,
            entry: 500,
            player_share_bps: 5_000,
            directed_request: None,
        },
        vec![rem(b.c_holding)],
    );
    let carol = b.carol.kp.insecure_clone();
    let err = b.d.env.send(&[create], &carol, &[]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
    assert_eq!(b.reserved(), 500);
}

#[test]
fn a_backed_player_playing_with_the_backers_gemas_is_not_counted() {
    let mut b = backing_setup();
    // Dave's limit is a single Gema, yet he can play a backed 500 entry: only Carol's limit counts.
    b.d.env.set_entry_limit(&b.dave, 1).unwrap();
    b.d.env.set_entry_limit(&b.carol, 500).unwrap();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    b.accept_public(offer, request);
    b.open_backed(offer, 500, &[b.c_holding]).expect("backed");
    assert_eq!(b.d.env.entry_limit(&b.dave).window_used, 0);
    // Using the Offer did not count Carol twice: it was counted when she funded it.
    assert_eq!(b.d.env.entry_limit(&b.carol).window_used, 500);
}

#[test]
fn a_player_with_no_entry_limit_set_is_not_limited() {
    let d = duel();
    assert!(d
        .env
        .svm
        .get_account(&s(protections_pda(d.alice.account)))
        .is_none());
}

#[test]
fn offers_and_requests_expire_after_24_hours() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    let expire = |b: &mut Backing| {
        let expire = ix(
            accounts::ExpireOffer {
                caller: a(b.d.env.admin.pubkey()),
                backer_account: b.carol.account,
                offer,
                request: None,
                backer_protections: None,
            },
            instruction::ExpireOffer {},
            vec![rem(b.c_holding)],
        );
        let admin = b.d.env.admin.insecure_clone();
        b.d.env.send(&[expire], &admin, &[])
    };
    let err = expire(&mut b).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NotExpired));
    assert_eq!(b.reserved(), 500);
    let now = b.d.env.now();
    b.d.env.set_time(now + 24 * 3_600 + 1);
    // Too late to apply or accept; anybody releases the reservation.
    let apply = ix(
        accounts::ApplyOffer {
            player_authority: b.dave.key,
            player_account: b.dave.account,
            protections: protections_pda(b.dave.account),
            request,
            offer,
        },
        instruction::ApplyOffer {},
        vec![],
    );
    let dave = b.dave.kp.insecure_clone();
    let err = b.d.env.send(&[apply], &dave, &[]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::Expired));
    expire(&mut b).expect("expire");
    assert_eq!(b.reserved(), 0);
    assert_eq!(b.d.env.total_gemas(&b.carol), 75_000);
}

#[test]
fn reserved_gemas_cannot_enter_other_matches() {
    let mut b = backing_setup();
    b.offer(1, 2_500, 5_000, None);
    // 75_000 held, 2_500 reserved: still plenty free, but reserved units are excluded.
    let acct = b.d.env.load::<TesoroAccount>(b.carol.account).inner;
    assert_eq!(
        (acct.own_total, acct.own_reserved, acct.own_free()),
        (75_000, 2_500, 72_500)
    );
    let h = b.d.env.load::<HoldingState>(b.c_holding).inner;
    assert_eq!(h.free(), 72_500);
}

/// CU readings for the matching hot path (run with `--nocapture`).
#[test]
fn cu_profile_matching() {
    let mut d = duel();
    let game = d.env.game_auth.insecure_clone();
    let m = d.env.open_match(&d.alice, ENTRY, &[d.a_holding]).unwrap();
    let open1 = d.env.last_cu;
    d.env.join_match(&d.bob, m, &[d.b_holding]).unwrap();
    let join1 = d.env.last_cu;
    let payouts = d.env.payout_accounts(m, MatchResult::Joiner);
    d.env
        .settle(&game, m, MatchResult::Joiner, payouts)
        .unwrap();
    let settle = d.env.last_cu;

    // Bob (Position owner) returns most of his own Gemas, leaving own < entry and won > 0, so the
    // next entry draws from two Holdings (own first, then won).
    let bob = d.bob.kp.insecure_clone();
    let b_position = position_pda(2);
    let ret = ix(
        accounts::ReturnOwn {
            owner_authority: d.bob.key,
            owner_account: d.bob.account,
            position: b_position,
            source: d.b_source,
            holding: d.b_holding,
        },
        instruction::ReturnOwn { amount: 74_800 },
        vec![],
    );
    d.env.send(&[ret], &bob, &[]).expect("return own");
    let won = holding_pda(d.bob.account, d.a_source);
    let m2 = d.env.open_match(&d.bob, 500, &[d.b_holding, won]).unwrap();
    let open2 = d.env.last_cu;
    d.env.join_match(&d.alice, m2, &[d.a_holding]).unwrap();
    let payouts = d.env.payout_accounts(m2, MatchResult::Opener);
    let n = payouts.len() / 2;
    d.env
        .settle(&game, m2, MatchResult::Opener, payouts)
        .unwrap();
    let settle2 = d.env.last_cu;
    println!(
        "CU open_match(1 holding) {open1}; join_match(1 holding) {join1}; settle_match({} payouts) {settle}; open_match(2 holdings) {open2}; settle_match({n} payouts) {settle2}",
        4
    );
    assert!(open2 < 200_000 && settle < 200_000 && settle2 < 200_000);
}

// --- F-07 -----------------------------------------------------------------------------------

const ERR_BRIDGED_SOURCE: u32 = 6012;

/// F-07. Plain `redeem` of an EVM-sourced Gema only burned it: the payout is recorded by the
/// bridge, so a wallet calling `redeem` destroyed the claim. Plain `redeem` now refuses these
/// Sources; `redeem_from_source` needs the chain's registered source authority as a co-signer.
#[test]
fn f07_plain_redeem_of_an_evm_sourced_gema_is_refused() {
    let mut env = Env::new();
    let alice = env.person();
    let bridge = Keypair::new();
    env.svm.airdrop(&bridge.pubkey(), SOL).expect("airdrop");
    let position = pda(&[POSITION_SEED, &[1], &[9u8; 32]]);
    let open = ix(
        accounts::OpenPosition {
            oracle: a(env.oracle.pubkey()),
            config: pda(&[CONFIG_SEED]),
            owner_account: alice.account,
            position,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::OpenPosition {
            source_chain: SourceChain::Ethereum,
            position_id: [9u8; 32],
            source_asset: APk::new_unique(),
            decimals: 9,
            principal: 100 * SOL,
            rate_bps: 1_000,
        },
        vec![],
    );
    let oracle = env.oracle.insecure_clone();
    env.send(&[open], &oracle, &[]).expect("open position");
    env.take_advance(&alice, position, 0, 6, 150_000_000)
        .expect("advance");
    let source = source_pda(position, 0);
    let holding = holding_pda(alice.account, source);
    env.yield_to(&oracle, position, Some(source), 1, 5 * SOL / 2)
        .expect("yield");

    let redeem = ix(
        accounts::Redeem {
            holder_authority: alice.key,
            holder_account: alice.account,
            position,
            source,
            holding,
        },
        instruction::Redeem { amount: 100 },
        vec![],
    );
    let err = env.send(&[redeem], &alice.kp, &[]).unwrap_err();
    assert_eq!(custom_code(&err), ERR_BRIDGED_SOURCE);
    assert_eq!(env.holding_amount(&alice, source), 75_000, "nothing burned");

    let register = ix(
        accounts::SetSourceAuthority {
            admin: a(env.admin.pubkey()),
            config: pda(&[CONFIG_SEED]),
            source_authority: pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::SetSourceAuthority {
            chain: SourceChain::Ethereum,
            authority: a(bridge.pubkey()),
        },
        vec![],
    );
    let admin = env.admin.insecure_clone();
    env.send(&[register], &admin, &[]).expect("register");
    let via_bridge = |signer: &Keypair| {
        ix(
            accounts::RedeemFromSource {
                holder_authority: alice.key,
                source_signer: a(signer.pubkey()),
                source_authority: pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                holder_account: alice.account,
                position,
                source,
                holding,
            },
            instruction::RedeemFromSource { amount: 100 },
            vec![],
        )
    };
    // Alice cannot stand in for the bridge.
    let err = env
        .send(&[via_bridge(&alice.kp)], &alice.kp, &[])
        .unwrap_err();
    assert_eq!(custom_code(&err), 6000);
    env.send(&[via_bridge(&bridge)], &alice.kp, &[&bridge])
        .expect("redeem through the bridge authority");
    assert_eq!(env.holding_amount(&alice, source), 74_900);
    assert_eq!(
        env.load::<SourceState>(source).inner.redeemed_units,
        6_666_666
    );
}

// --- F-12 -----------------------------------------------------------------------------------

/// F-12. A Request stayed `Accepted` for ever after its Offer was cancelled or expired unused, so
/// the Player had to create a new one. It now returns to Open, and can be answered again.
#[test]
fn f12_a_request_returns_to_open_when_its_accepted_offer_ends_unused() {
    use tesoro_core::ledger::RequestStatus;
    let request_status =
        |b: &Backing, request: APk| b.d.env.load::<RequestState>(request).inner.status;
    for expire in [false, true] {
        let mut b = backing_setup();
        let request = b.request(1, 500);
        let offer = b.offer(1, 500, 5_000, None);
        b.accept_public(offer, request);
        assert_eq!(request_status(&b, request), RequestStatus::Accepted);

        let end = |b: &mut Backing, request: Option<APk>| {
            let (ixn, signer) = if expire {
                let now = b.d.env.now();
                b.d.env.set_time(now + 2 * 24 * 3_600);
                (
                    ix(
                        accounts::ExpireOffer {
                            caller: a(b.d.env.admin.pubkey()),
                            backer_account: b.carol.account,
                            offer,
                            request,
                            backer_protections: None,
                        },
                        instruction::ExpireOffer {},
                        vec![rem(b.c_holding)],
                    ),
                    b.d.env.admin.insecure_clone(),
                )
            } else {
                (
                    ix(
                        accounts::CancelOffer {
                            backer_authority: b.carol.key,
                            backer_account: b.carol.account,
                            offer,
                            request,
                        },
                        instruction::CancelOffer {},
                        vec![rem(b.c_holding)],
                    ),
                    b.carol.kp.insecure_clone(),
                )
            };
            b.d.env.send(&[ixn], &signer, &[])
        };
        // The accepted Request has to come with the call.
        let err = end(&mut b, None).unwrap_err();
        assert_eq!(custom_code(&err), 6003);
        assert_eq!(request_status(&b, request), RequestStatus::Accepted);
        end(&mut b, Some(request)).expect("end the offer");
        if !expire {
            // Cancelling does not move time; the Request is live for a second Offer.
            assert_eq!(request_status(&b, request), RequestStatus::Open);
            let offer2 = b.offer(2, 500, 5_000, Some(request));
            let accept = ix(
                accounts::AcceptDirected {
                    player_authority: b.dave.key,
                    player_account: b.dave.account,
                    protections: protections_pda(b.dave.account),
                    request,
                    offer: offer2,
                },
                instruction::AcceptDirected {},
                vec![],
            );
            let dave = b.dave.kp.insecure_clone();
            b.d.env.send(&[accept], &dave, &[]).expect("answered again");
        } else {
            assert_eq!(request_status(&b, request), RequestStatus::Open);
        }
    }
}

// --- Entry fragmentation: up to MAX_ENTRY_SOURCES Holdings per entry -----------------------------

/// `n` Positions for `p`, each worth `gemas_each` Gemas of its own Source, returned as Holdings in
/// the canonical (ascending Source) order. `first_id` keeps Position ids unique across people.
fn fragment(env: &mut Env, p: &Person, first_id: u8, n: u8, gemas_each: u64) -> Vec<APk> {
    // 750 Gemas per SOL of principal (see `stake_principal`).
    let principal = gemas_each * SOL / 750;
    let mut sources: Vec<(APk, APk)> = (0..n)
        .map(|i| {
            let (_, source, holding) = env.stake_principal(p, first_id + i, principal);
            assert_eq!(env.holding_amount(p, source), gemas_each);
            (source, holding)
        })
        .collect();
    sources.sort_by_key(|(source, _)| source.to_bytes());
    sources.into_iter().map(|(_, holding)| holding).collect()
}

struct Fragmented {
    open_cu: u64,
    join_cu: u64,
    settle_cu: u64,
    settle_size: usize,
    payouts: usize,
}

/// Both Players hold `k` own Sources and enter a 500 Match drawing on all of them; the opener
/// wins. Checks conservation per Source and returns the CU and size readings.
fn fragmented_match(k: u8) -> Fragmented {
    // Every Holding is needed: the first k - 1 hold less than 500 together, all k at least 500.
    let gemas_each = if k == 8 { 63 } else { 600 / k as u64 };
    let held = gemas_each * k as u64;
    let mut env = Env::new();
    let alice = env.person();
    let bob = env.person();
    let a_holdings = fragment(&mut env, &alice, 10, k, gemas_each);
    let b_holdings = fragment(&mut env, &bob, 100, k, gemas_each);
    let game = env.game_auth.insecure_clone();

    let m = env.open_match(&alice, 500, &a_holdings).expect("open");
    let open_cu = env.last_cu;
    env.join_match(&bob, m, &b_holdings).expect("join");
    let join_cu = env.last_cu;
    let mm = env.load::<MatchState>(match_pda(m)).inner;
    assert_eq!(mm.a.lines.len(), k as usize);
    assert_eq!(mm.b.as_ref().expect("joined").lines.len(), k as usize);

    let payouts = env.payout_accounts(m, MatchResult::Opener);
    let n = payouts.len() / 2;
    env.settle(&game, m, MatchResult::Opener, payouts)
        .expect("settle");
    let (settle_cu, settle_size) = (env.last_cu, env.last_size);

    // Pot 1_000: platform 20 + studio 30 are taken from Bob's lines; Alice gets 500 back + 450.
    assert_eq!(env.total_gemas(&env.platform), 20);
    assert_eq!(env.total_gemas(&env.studio), 30);
    assert_eq!(env.total_gemas(&alice), held + 450);
    assert_eq!(env.total_gemas(&bob), held - 500);
    assert_eq!(
        env.load::<MatchState>(match_pda(m)).inner.status,
        MatchStatus::Settled
    );
    // Per-Source conservation across every Holding, for every Source involved.
    for i in 0..k {
        for first_id in [10u8, 100u8] {
            let source = source_pda(position_pda(first_id + i), 0);
            let total: u64 = [&alice, &bob, &env.platform, &env.studio]
                .iter()
                .map(|p| env.holding_amount(p, source))
                .sum();
            assert_eq!(total, env.load::<SourceState>(source).inner.outstanding());
        }
    }
    Fragmented {
        open_cu,
        join_cu,
        settle_cu,
        settle_size,
        payouts: n,
    }
}

#[test]
fn entries_draw_from_one_two_five_and_eight_holdings() {
    for k in [1u8, 2, 5, 8] {
        let f = fragmented_match(k);
        println!(
            "CU holdings={k}: open_match {} join_match {} settle_match({} payouts) {}; settle tx {} bytes",
            f.open_cu, f.join_cu, f.payouts, f.settle_cu, f.settle_size
        );
        assert!(f.settle_cu < 150_000, "settle stays under the CU target");
    }
}

#[test]
fn a_ninth_holding_is_refused() {
    let mut env = Env::new();
    let alice = env.person();
    let holdings = fragment(&mut env, &alice, 10, 9, 60);
    let err = env.open_match(&alice, 500, &holdings).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::TooManySources));
}

// --- Leaderboard ------------------------------------------------------------------------------

fn pool_pda() -> APk {
    account_pda(pda(&[LEADERBOARD_SEED]))
}
fn season_pda(n: u32) -> APk {
    pda(&[SEASON_SEED, &n.to_le_bytes()])
}

impl Env {
    /// Rewrites Config in the layout that predates the Leaderboard, then runs `init_leaderboard`.
    fn enable_leaderboard(&mut self, bps: u16) {
        let config = s(pda(&[CONFIG_SEED]));
        let mut acct = self.svm.get_account(&config).expect("config");
        acct.data.truncate(Config::LEGACY_SPACE);
        self.svm
            .set_account(config, acct)
            .expect("set legacy config");
        let legacy = self.load::<Config>(pda(&[CONFIG_SEED]));
        assert_eq!(
            (legacy.leaderboard_bps, legacy.pool_account),
            (0, APk::default())
        );
        assert_eq!(legacy.leaderboard_terms().bps, 0);
        let init = ix(
            accounts::InitLeaderboard {
                admin: a(self.admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                pool_authority: pda(&[LEADERBOARD_SEED]),
                pool_account: pool_pda(),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitLeaderboard {
                leaderboard_bps: bps,
            },
            vec![],
        );
        let admin = self.admin.insecure_clone();
        self.send(&[init], &admin, &[]).expect("init leaderboard");
    }

    fn record_season(
        &mut self,
        signer: &Keypair,
        n: u32,
        ranked: &[(&Person, u64)],
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let record = ix(
            accounts::RecordSeason {
                authority: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                pool_account: pool_pda(),
                season: season_pda(n),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::RecordSeason {
                number: n,
                points: ranked.iter().map(|(_, p)| *p).collect(),
            },
            ranked.iter().map(|(p, _)| rem(p.account)).collect(),
        );
        self.send(&[record], signer, &[])
    }

    /// Pool Holdings of `candidates` that hold Gemas, ascending by Source (the canonical order).
    fn pool_sources(&self, candidates: &[APk]) -> Vec<(APk, u64)> {
        let mut out: Vec<(APk, u64)> = candidates
            .iter()
            .filter(|src| {
                self.svm
                    .get_account(&s(holding_pda(pool_pda(), **src)))
                    .is_some()
            })
            .map(|src| {
                (
                    *src,
                    self.load::<HoldingState>(holding_pda(pool_pda(), *src))
                        .inner
                        .amount,
                )
            })
            .filter(|(_, n)| *n > 0)
            .collect();
        out.sort_by_key(|(src, _)| *src);
        out
    }

    fn pay_rank(
        &mut self,
        signer: &Keypair,
        n: u32,
        rank: u8,
        winner: &Person,
        sources: &[APk],
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let mut remaining: Vec<AccountMeta> = sources
            .iter()
            .map(|src| rem(holding_pda(pool_pda(), *src)))
            .collect();
        for src in sources {
            self.open_holding(winner.account, *src);
            remaining.push(rem(holding_pda(winner.account, *src)));
        }
        let pay = ix(
            accounts::PaySeasonRank {
                authority: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                season: season_pda(n),
                pool_account: pool_pda(),
                winner_account: winner.account,
            },
            instruction::PaySeasonRank { rank },
            remaining,
        );
        self.send(&[pay], signer, &[])
    }
}

#[test]
fn leaderboard_fee_fills_the_pool_and_a_season_pays_the_top_ranks() {
    use tesoro_core::ledger::{season_end, SEASON_EPOCH};
    let mut d = duel();
    d.env.enable_leaderboard(100);
    let cfg = d.env.load::<Config>(pda(&[CONFIG_SEED]));
    assert_eq!((cfg.leaderboard_bps, cfg.pool_account), (100, pool_pda()));
    assert_eq!(cfg.leaderboard_since, d.env.now());
    assert_eq!(
        d.env.load::<TesoroAccount>(pool_pda()).authority,
        pda(&[LEADERBOARD_SEED])
    );
    let game = d.env.game_auth.insecure_clone();
    d.env.set_time(SEASON_EPOCH + 3_600);

    // Alice wins 1,000: pot 2,000, the pool takes 1% = 20 of Bob's own Source.
    let m1 = d
        .env
        .open_match(&d.alice, ENTRY, &[d.a_holding])
        .expect("open");
    d.env.join_match(&d.bob, m1, &[d.b_holding]).expect("join");
    let payouts = d.env.payout_accounts(m1, MatchResult::Opener);
    d.env
        .settle(&game, m1, MatchResult::Opener, payouts)
        .expect("settle");
    let won_events = d
        .env
        .last_logs
        .iter()
        .filter(|l| l.starts_with("Program data:"))
        .count();
    assert_eq!(won_events, 2, "MatchSettled and MatchWon");
    let won: Vec<Vec<u8>> = d
        .env
        .last_logs
        .iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .map(decode_b64)
        .filter(|b| b.len() == 8 + 172)
        .collect();
    assert_eq!(won.len(), 1, "one MatchWon, layout with the loser last");
    assert_eq!(&won[0][8 + 48..8 + 80], d.alice.account.as_ref(), "player");
    assert_eq!(&won[0][8 + 140..], d.bob.account.as_ref(), "loser");
    assert_eq!(d.env.total_gemas(&d.env.platform), 40);
    assert_eq!(d.env.total_gemas(&d.env.studio), 60);
    let pool = d.env.load::<TesoroAccount>(pool_pda()).inner;
    assert_eq!(pool.won_total + pool.own_total, 20);
    // Alice nets 880 on top of her entry (1,000 pot share less 4 + 6 + 2 percent of the pot).
    assert_eq!(d.env.total_gemas(&d.alice), 75_000 + 880);

    // Bob wins 500 against Alice: Alice's own Source pays 10 into the pool.
    let m2 = d.env.open_match(&d.bob, 500, &[d.b_holding]).expect("open");
    d.env
        .join_match(&d.alice, m2, &[d.a_holding])
        .expect("join");
    let payouts = d.env.payout_accounts(m2, MatchResult::Opener);
    d.env
        .settle(&game, m2, MatchResult::Opener, payouts)
        .expect("settle");
    let pool = d.env.load::<TesoroAccount>(pool_pda()).inner;
    assert_eq!(pool.won_total + pool.own_total, 30);
    let sources = d.env.pool_sources(&[d.a_source, d.b_source]);
    assert_eq!(sources.len(), 2);

    // A draw never pays the pool.
    let m3 = d
        .env
        .open_match(&d.alice, 500, &[d.a_holding])
        .expect("open");
    d.env.join_match(&d.bob, m3, &[d.b_holding]).expect("join");
    let payouts = d.env.payout_accounts(m3, MatchResult::Draw);
    d.env
        .settle(&game, m3, MatchResult::Draw, payouts)
        .expect("draw");
    let pool = d.env.load::<TesoroAccount>(pool_pda()).inner;
    assert_eq!(pool.won_total + pool.own_total, 30);

    // The season is still running.
    let admin = d.env.admin.insecure_clone();
    let oracle = d.env.oracle.insecure_clone();
    let err = d
        .env
        .record_season(&admin, 1, &[(&d.alice, 10), (&d.bob, 5)])
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::SeasonNotEnded));
    d.env.set_time(season_end(1).unwrap() + 60);
    // Only the admin or the keeper records.
    let stranger = Keypair::new();
    d.env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    let err = d
        .env
        .record_season(&stranger, 1, &[(&d.alice, 10), (&d.bob, 5)])
        .unwrap_err();
    assert_eq!(custom_code(&err), 6000);
    // Ranks are ordered and distinct.
    let err = d
        .env
        .record_season(&oracle, 1, &[(&d.alice, 5), (&d.bob, 10)])
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::SeasonInvalid));
    d.env
        .record_season(&oracle, 1, &[(&d.alice, 10), (&d.bob, 5)])
        .expect("record");
    let season = d.env.load::<SeasonState>(season_pda(1)).inner;
    assert_eq!((season.pool_total, season.count), (30, 2));
    // 25% of 30 = 7, 18% of 30 = 5.
    assert_eq!(season.amounts[..3], [7, 5, 0]);
    // Recorded once.
    assert!(d.env.record_season(&admin, 1, &[(&d.alice, 10)]).is_err());

    // The wrong winner, the wrong Holding order and a stranger are refused.
    let all: Vec<APk> = sources.iter().map(|(src, _)| *src).collect();
    let err = d
        .env
        .pay_rank(&oracle, 1, 0, &d.bob, &all[..1])
        .unwrap_err();
    assert_eq!(custom_code(&err), 6003);
    let err = d
        .env
        .pay_rank(&stranger, 1, 0, &d.alice, &all[..1])
        .unwrap_err();
    assert_eq!(custom_code(&err), 6000);
    let rev: Vec<APk> = all.iter().rev().cloned().collect();
    let err = d.env.pay_rank(&oracle, 1, 0, &d.alice, &rev).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NonCanonicalPrize));
    let before = d.env.total_gemas(&d.alice);
    d.env
        .pay_rank(&oracle, 1, 0, &d.alice, &all[..1])
        .expect("pay 1st");
    assert_eq!(d.env.total_gemas(&d.alice), before + 7);
    let err = d
        .env
        .pay_rank(&oracle, 1, 0, &d.alice, &all[..1])
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::AlreadyPaid));
    // Rank 1 (5 Gemas) may span two Holdings, drained in Source order.
    let left_first = d.env.pool_sources(&[d.a_source, d.b_source])[0].1;
    let span: &[APk] = if left_first >= 5 { &all[..1] } else { &all };
    let before = d.env.total_gemas(&d.bob);
    d.env
        .pay_rank(&oracle, 1, 1, &d.bob, span)
        .expect("pay 2nd");
    assert_eq!(d.env.total_gemas(&d.bob), before + 5);
    // No rank 2 was recorded.
    assert!(d.env.pay_rank(&oracle, 1, 2, &d.alice, &all[..1]).is_err());

    // 30 - 12 stays in the pool: it rolls into the next season, Sources intact.
    let pool = d.env.load::<TesoroAccount>(pool_pda()).inner;
    assert_eq!(pool.won_total + pool.own_total, 18);
    assert_eq!(
        d.env
            .pool_sources(&[d.a_source, d.b_source])
            .iter()
            .map(|(_, n)| n)
            .sum::<u64>(),
        18
    );
    for src in [d.a_source, d.b_source] {
        let total: u64 = [&d.alice, &d.bob, &d.env.platform, &d.env.studio]
            .iter()
            .map(|p| d.env.holding_amount(p, src))
            .sum::<u64>()
            + d.env
                .svm
                .get_account(&s(holding_pda(pool_pda(), src)))
                .map(|_| {
                    d.env
                        .load::<HoldingState>(holding_pda(pool_pda(), src))
                        .inner
                        .amount
                })
                .unwrap_or(0);
        assert_eq!(total, d.env.load::<SourceState>(src).inner.outstanding());
    }
}

fn decode_b64(s: &str) -> Vec<u8> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        _ => 63,
    } as u32;
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes().take_while(|c| *c != b'=') {
        acc = (acc << 6) | val(c);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

// --- Break and Self-Exclusion ---------------------------------------------------------------------

#[test]
fn a_break_stops_opening_and_joining_matches_until_it_ends() {
    let mut d = duel();
    let open = d.env.open_match(&d.bob, 500, &[d.b_holding]).unwrap();
    d.env.set_break(&d.alice, 3).unwrap();
    let now = d.env.now();
    assert_eq!(d.env.protections(&d.alice).break_until, now + 3 * DAY);
    let free = d
        .env
        .load::<TesoroAccount>(d.alice.account)
        .inner
        .own_free();
    let err = d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::OnBreak));
    let err = d
        .env
        .join_match(&d.alice, open, &[d.a_holding])
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::OnBreak));
    assert_eq!(
        d.env
            .load::<TesoroAccount>(d.alice.account)
            .inner
            .own_free(),
        free
    );
    d.env.set_time(now + 3 * DAY);
    let later = d.env.open_match(&d.bob, 500, &[d.b_holding]).unwrap();
    d.env.join_match(&d.alice, later, &[d.a_holding]).unwrap();
    d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap();
}

#[test]
fn a_self_exclusion_stops_matches_too_and_lasts_months() {
    let mut d = duel();
    d.env.set_self_exclusion(&d.alice, 6).unwrap();
    let err = d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::SelfExcluded));
    let now = d.env.now();
    d.env.set_time(now + 6 * 30 * DAY - 1);
    let err = d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::SelfExcluded));
    d.env.set_time(now + 6 * 30 * DAY);
    d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap();
}

#[test]
fn a_break_or_self_exclusion_cannot_be_shortened_or_given_bad_lengths() {
    let mut d = duel();
    let err = d.env.set_break(&d.alice, 0).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidBreak));
    let err = d.env.set_break(&d.alice, 43).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidBreak));
    let err = d.env.set_self_exclusion(&d.alice, 5).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidSelfExclusion));
    let err = d.env.set_self_exclusion(&d.alice, 61).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidSelfExclusion));
    d.env.set_break(&d.alice, 30).unwrap();
    let until = d.env.protections(&d.alice).break_until;
    let err = d.env.set_break(&d.alice, 5).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::ProtectionCannotShorten));
    assert_eq!(d.env.protections(&d.alice).break_until, until);
    // A longer one extends it.
    d.env.set_break(&d.alice, 42).unwrap();
    assert!(d.env.protections(&d.alice).break_until > until);
    d.env.set_self_exclusion(&d.alice, 12).unwrap();
    let err = d.env.set_self_exclusion(&d.alice, 6).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::ProtectionCannotShorten));
    // Only the owner sets it: another Person's key cannot sign for the Account.
    let carol_less = d.env.set_break(&d.bob, 1);
    assert!(carol_less.is_ok());
    assert_eq!(d.env.protections(&d.alice).self_exclusion_until > 0, true);
}

#[test]
fn a_break_keeps_the_entry_limit_and_the_limit_keeps_counting() {
    let mut d = duel();
    d.env.set_entry_limit(&d.alice, 1_000).unwrap();
    d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap();
    d.env.set_break(&d.alice, 1).unwrap();
    let l = d.env.entry_limit(&d.alice);
    assert_eq!((l.gemas, l.window_used), (1_000, 500));
}

#[test]
fn matches_already_paired_play_out_during_a_break() {
    let mut d = duel();
    let id = d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap();
    d.env.join_match(&d.bob, id, &[d.b_holding]).unwrap();
    d.env.set_break(&d.alice, 7).unwrap();
    d.env.set_self_exclusion(&d.bob, 6).unwrap();
    let game = d.env.game_auth.insecure_clone();
    let payouts = d.env.payout_accounts(id, MatchResult::Opener);
    d.env
        .settle(&game, id, MatchResult::Opener, payouts)
        .expect("settles");
    assert_eq!(
        d.env.load::<MatchState>(match_pda(id)).inner.status,
        tesoro_core::ledger::MatchStatus::Settled
    );
}

#[test]
fn a_paired_match_refunds_during_a_break_but_only_by_the_usual_rules() {
    let mut d = duel();
    let id = d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap();
    d.env.join_match(&d.bob, id, &[d.b_holding]).unwrap();
    d.env.set_break(&d.alice, 7).unwrap();
    let stranger = d.env.admin.insecure_clone();
    let payouts = d.env.refund_accounts(id);
    let err = d.env.refund(&stranger, id, payouts.clone()).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NotExpired));
    let now = d.env.now();
    d.env.set_time(now + 3_601);
    d.env
        .refund(&stranger, id, payouts)
        .expect("after the deadline");
}

#[test]
fn nobody_joins_a_match_whose_opener_started_a_break_and_anyone_refunds_it() {
    let mut d = duel();
    let id = d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap();
    let before = d.env.total_gemas(&d.alice);
    d.env.set_break(&d.alice, 2).unwrap();
    let err = d.env.join_match(&d.bob, id, &[d.b_holding]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::OnBreak));
    // A stranger refunds the unpaired Match at once because its opener is away.
    let stranger = d.env.admin.insecure_clone();
    let payouts = d.env.refund_accounts(id);
    d.env
        .refund(&stranger, id, payouts)
        .expect("refund at once");
    assert_eq!(d.env.total_gemas(&d.alice), before + 500);
    assert_eq!(
        d.env.load::<MatchState>(match_pda(id)).inner.status,
        tesoro_core::ledger::MatchStatus::Refunded
    );
}

#[test]
fn a_stranger_cannot_refund_an_unpaired_match_of_a_player_who_is_not_away() {
    let mut d = duel();
    let id = d.env.open_match(&d.alice, 500, &[d.a_holding]).unwrap();
    let stranger = d.env.admin.insecure_clone();
    let payouts = d.env.refund_accounts(id);
    let err = d.env.refund(&stranger, id, payouts).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NotExpired));
}

#[test]
fn a_player_on_a_break_cannot_ask_to_be_backed_or_be_backed() {
    let mut b = backing_setup();
    // Dave's Request and Carol's Offer exist before the Break.
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    b.d.env.set_break(&b.dave, 5).unwrap();
    let create = |b: &mut Backing, nonce: u64| {
        let create = ix(
            accounts::CreateRequest {
                player_authority: b.dave.key,
                config: pda(&[CONFIG_SEED]),
                player_account: b.dave.account,
                protections: protections_pda(b.dave.account),
                request: request_pda(b.dave.account, nonce),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::CreateRequest {
                nonce,
                game: GAME,
                entry: 500,
            },
            vec![],
        );
        let dave = b.dave.kp.insecure_clone();
        b.d.env.send(&[create], &dave, &[])
    };
    let err = create(&mut b, 2).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::OnBreak));
    // Applying to a public Offer and accepting a directed one are refused.
    let apply = ix(
        accounts::ApplyOffer {
            player_authority: b.dave.key,
            player_account: b.dave.account,
            protections: protections_pda(b.dave.account),
            request,
            offer,
        },
        instruction::ApplyOffer {},
        vec![],
    );
    let dave = b.dave.kp.insecure_clone();
    let err = b.d.env.send(&[apply], &dave, &[]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::OnBreak));
    let directed = b.offer(2, 500, 5_000, Some(request));
    let accept = ix(
        accounts::AcceptDirected {
            player_authority: b.dave.key,
            player_account: b.dave.account,
            protections: protections_pda(b.dave.account),
            request,
            offer: directed,
        },
        instruction::AcceptDirected {},
        vec![],
    );
    let err = b.d.env.send(&[accept], &dave, &[]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::OnBreak));
}

#[test]
fn a_backer_cannot_accept_an_applicant_who_is_on_a_break() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    let apply = ix(
        accounts::ApplyOffer {
            player_authority: b.dave.key,
            player_account: b.dave.account,
            protections: protections_pda(b.dave.account),
            request,
            offer,
        },
        instruction::ApplyOffer {},
        vec![],
    );
    let dave = b.dave.kp.insecure_clone();
    b.d.env.send(&[apply], &dave, &[]).expect("applied");
    b.d.env.set_break(&b.dave, 5).unwrap();
    let accept = ix(
        accounts::AcceptApplicant {
            backer_authority: b.carol.key,
            backer_account: b.carol.account,
            request,
            player_protections: protections_pda(b.dave.account),
            offer,
        },
        instruction::AcceptApplicant {},
        vec![],
    );
    let carol = b.carol.kp.insecure_clone();
    let err = b.d.env.send(&[accept], &carol, &[]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::OnBreak));
}

#[test]
fn an_accepted_offer_cannot_start_a_match_once_the_player_or_backer_is_away() {
    for backer_away in [false, true] {
        let mut b = backing_setup();
        let request = b.request(1, 500);
        let offer = b.offer(1, 500, 5_000, None);
        b.accept_public(offer, request);
        let who = if backer_away {
            b.carol.account
        } else {
            b.dave.account
        };
        let _ = who;
        if backer_away {
            let carol = Person {
                kp: b.carol.kp.insecure_clone(),
                key: b.carol.key,
                account: b.carol.account,
            };
            b.d.env.set_break(&carol, 3).unwrap();
        } else {
            let dave = Person {
                kp: b.dave.kp.insecure_clone(),
                key: b.dave.key,
                account: b.dave.account,
            };
            b.d.env.set_self_exclusion(&dave, 6).unwrap();
        }
        let err = b.open_backed(offer, 500, &[b.c_holding]).unwrap_err();
        let code = custom_code(&err);
        assert!(
            code == core(CoreError::OnBreak) || code == core(CoreError::SelfExcluded),
            "{code}"
        );
        assert_eq!(b.reserved(), 500);
    }
}

#[test]
fn a_backed_match_cannot_be_joined_by_a_player_on_a_break() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    b.accept_public(offer, request);
    // Dave is backed into the Match Bob opened; Bob's Break stops the join through the opener check.
    let id = b.d.env.open_match(&b.d.bob, 500, &[b.d.b_holding]).unwrap();
    let bob = Person {
        kp: b.d.bob.kp.insecure_clone(),
        key: b.d.bob.key,
        account: b.d.bob.account,
    };
    b.d.env.set_break(&bob, 1).unwrap();
    let join = ix(
        accounts::JoinMatchBacked {
            player_authority: b.dave.key,
            player_account: b.dave.account,
            protections: protections_pda(b.dave.account),
            offer,
            backer_account: b.carol.account,
            backer_protections: protections_pda(b.carol.account),
            match_state: match_pda(id),
            opener_protections: protections_pda(b.d.bob.account),
        },
        instruction::JoinMatchBacked {},
        vec![rem(b.c_holding)],
    );
    let dave = b.dave.kp.insecure_clone();
    let err = b.d.env.send(&[join], &dave, &[]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::OnBreak));
    assert_eq!(b.reserved(), 500);
}

#[test]
fn a_backer_on_a_break_cannot_fund_an_offer() {
    let mut b = backing_setup();
    let carol = Person {
        kp: b.carol.kp.insecure_clone(),
        key: b.carol.key,
        account: b.carol.account,
    };
    b.d.env.set_break(&carol, 2).unwrap();
    let create = ix(
        accounts::CreateOffer {
            backer_authority: b.carol.key,
            config: pda(&[CONFIG_SEED]),
            backer_account: b.carol.account,
            protections: protections_pda(b.carol.account),
            offer: offer_pda(b.carol.account, 1),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::CreateOffer {
            nonce: 1,
            game: GAME,
            entry: 500,
            player_share_bps: 5_000,
            directed_request: None,
        },
        vec![rem(b.c_holding)],
    );
    let err = b.d.env.send(&[create], &carol.kp, &[]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::OnBreak));
    assert_eq!(b.reserved(), 0);
}

#[test]
fn anyone_withdraws_the_requests_and_offers_of_a_player_who_started_a_break() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    let stranger = b.d.env.admin.insecure_clone();
    let (dave_acct, carol_acct) = (b.dave.account, b.carol.account);
    let clear = |b: &mut Backing, request: APk, who: APk| {
        let clear = ix(
            accounts::ClearRequest {
                caller: a(stranger.pubkey()),
                request,
                protections: protections_pda(who),
            },
            instruction::ClearRequest {},
            vec![],
        );
        b.d.env.send(&[clear], &stranger, &[])
    };
    let expire = |b: &mut Backing, backer_protections: Option<APk>| {
        let expire = ix(
            accounts::ExpireOffer {
                caller: a(stranger.pubkey()),
                backer_account: b.carol.account,
                offer,
                request: None,
                backer_protections,
            },
            instruction::ExpireOffer {},
            vec![rem(b.c_holding)],
        );
        b.d.env.send(&[expire], &stranger, &[])
    };
    // Not away: nothing is withdrawn early.
    let err = clear(&mut b, request, dave_acct).unwrap_err();
    assert_eq!(custom_code(&err), 6000);
    let err = expire(&mut b, Some(protections_pda(carol_acct))).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NotExpired));
    let err = expire(&mut b, None).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NotExpired));
    for who in [b.dave.account, b.carol.account] {
        let p = if who == b.dave.account {
            Person {
                kp: b.dave.kp.insecure_clone(),
                key: b.dave.key,
                account: who,
            }
        } else {
            Person {
                kp: b.carol.kp.insecure_clone(),
                key: b.carol.key,
                account: who,
            }
        };
        b.d.env.set_break(&p, 1).unwrap();
    }
    // Somebody else's protections do not count for the Request's owner.
    let err = clear(&mut b, request, carol_acct).unwrap_err();
    assert!(err.err.to_string().len() > 0);
    clear(&mut b, request, dave_acct).expect("request withdrawn");
    assert_eq!(
        b.d.env.load::<RequestState>(request).inner.status,
        tesoro_core::ledger::RequestStatus::Cancelled
    );
    assert_eq!(b.reserved(), 500);
    expire(&mut b, Some(protections_pda(carol_acct))).expect("offer withdrawn");
    assert_eq!(b.reserved(), 0);
    assert_eq!(b.d.env.total_gemas(&b.carol), 75_000);
    assert_eq!(
        b.d.env.load::<OfferState>(offer).inner.status,
        tesoro_core::ledger::OfferStatus::Cancelled
    );
}

#[test]
fn a_withdrawn_accepted_offer_hands_its_request_back() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    b.accept_public(offer, request);
    let carol = Person {
        kp: b.carol.kp.insecure_clone(),
        key: b.carol.key,
        account: b.carol.account,
    };
    b.d.env.set_break(&carol, 1).unwrap();
    let stranger = b.d.env.admin.insecure_clone();
    let expire = ix(
        accounts::ExpireOffer {
            caller: a(stranger.pubkey()),
            backer_account: b.carol.account,
            offer,
            request: Some(request),
            backer_protections: Some(protections_pda(b.carol.account)),
        },
        instruction::ExpireOffer {},
        vec![rem(b.c_holding)],
    );
    b.d.env.send(&[expire], &stranger, &[]).expect("withdrawn");
    assert_eq!(
        b.d.env.load::<RequestState>(request).inner.status,
        tesoro_core::ledger::RequestStatus::Open
    );
}

#[test]
fn redeem_unlock_and_debt_repayment_still_work_under_a_self_exclusion() {
    let mut d = duel();
    d.env.set_self_exclusion(&d.alice, 60).unwrap();
    d.env.set_break(&d.alice, 42).unwrap();
    let oracle = d.env.oracle.insecure_clone();
    // Yield repays Debt, Redeem pays the accrued part, Unlock follows at zero Debt.
    d.env
        .yield_to(&oracle, d.a_position, Some(d.a_source), 1, 5 * SOL / 2)
        .expect("yield repays debt");
    let redeem = ix(
        accounts::Redeem {
            holder_authority: d.alice.key,
            holder_account: d.alice.account,
            position: d.a_position,
            source: d.a_source,
            holding: d.a_holding,
        },
        instruction::Redeem { amount: 37_500 },
        vec![],
    );
    let alice = d.alice.kp.insecure_clone();
    d.env.send(&[redeem], &alice, &[]).expect("redeem");
    assert_eq!(d.env.holding_amount(&d.alice, d.a_source), 37_500);
    d.env
        .yield_to(&oracle, d.a_position, Some(d.a_source), 2, 6 * SOL)
        .expect("more yield");
    let unlock = ix(
        accounts::Unlock {
            owner_authority: d.alice.key,
            owner_account: d.alice.account,
            position: d.a_position,
        },
        instruction::Unlock {},
        vec![],
    );
    d.env.send(&[unlock], &alice, &[]).expect("unlock");
}

#[test]
fn return_own_still_works_under_a_self_exclusion() {
    let mut d = duel();
    d.env.set_self_exclusion(&d.alice, 6).unwrap();
    let ret = ix(
        accounts::ReturnOwn {
            owner_authority: d.alice.key,
            owner_account: d.alice.account,
            position: d.a_position,
            source: d.a_source,
            holding: d.a_holding,
        },
        instruction::ReturnOwn { amount: 1_000 },
        vec![],
    );
    let alice = d.alice.kp.insecure_clone();
    d.env.send(&[ret], &alice, &[]).expect("return own gemas");
    assert_eq!(d.env.load::<SourceState>(d.a_source).inner.debt(), 74_000);
}

#[test]
fn an_evm_source_advance_is_blocked_by_a_self_exclusion_but_not_a_break() {
    let mut env = Env::new();
    let p = env.person();
    let position = pda(&[POSITION_SEED, &[1], &[5; 32]]);
    let open = ix(
        accounts::OpenPosition {
            oracle: a(env.oracle.pubkey()),
            config: pda(&[CONFIG_SEED]),
            owner_account: p.account,
            position,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::OpenPosition {
            source_chain: SourceChain::Ethereum,
            position_id: [5; 32],
            source_asset: APk::new_unique(),
            decimals: 9,
            principal: 100 * SOL,
            rate_bps: 1_000,
        },
        vec![],
    );
    let oracle = env.oracle.insecure_clone();
    env.send(&[open], &oracle, &[]).expect("open position");
    env.set_self_exclusion(&p, 6).unwrap();
    let err = env
        .take_advance(&p, position, 0, 6, 150_000_000)
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::SelfExcluded));
    let now = env.now();
    env.set_time(now + 6 * 30 * DAY);
    env.take_advance(&p, position, 0, 6, 150_000_000)
        .expect("allowed once it ends");

    let q = env.person();
    let position = pda(&[POSITION_SEED, &[1], &[6; 32]]);
    let open = ix(
        accounts::OpenPosition {
            oracle: a(env.oracle.pubkey()),
            config: pda(&[CONFIG_SEED]),
            owner_account: q.account,
            position,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::OpenPosition {
            source_chain: SourceChain::Ethereum,
            position_id: [6; 32],
            source_asset: APk::new_unique(),
            decimals: 9,
            principal: 100 * SOL,
            rate_bps: 1_000,
        },
        vec![],
    );
    env.send(&[open], &oracle, &[]).expect("open position");
    env.set_break(&q, 7).unwrap();
    env.take_advance(&q, position, 0, 6, 150_000_000)
        .expect("a Break leaves Advances open");
}

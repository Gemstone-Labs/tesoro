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
        self.svm.send_transaction(tx).map(|_| ())
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
                principal: 100 * SOL,
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
                owner_account: p.account,
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
                match_state: match_pda(id),
            },
            instruction::JoinMatch {},
            holdings.iter().map(|h| rem(*h)).collect(),
        );
        self.send(&[join], &p.kp, &[])
    }

    fn payout_accounts(&mut self, id: u64, result: MatchResult) -> Vec<AccountMeta> {
        let mut m = self.load::<MatchState>(match_pda(id)).inner;
        let outcome = match result {
            MatchResult::Opener => Outcome::Winner(0),
            MatchResult::Joiner => Outcome::Winner(1),
            MatchResult::Draw => Outcome::Draw,
        };
        let payouts = m.settle(outcome).expect("ledger settles");
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
                offer,
                backer_account: self.carol.account,
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

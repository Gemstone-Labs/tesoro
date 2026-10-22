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
use tesoro_core::ledger::book::fp_ceil;
use tesoro_core::ledger::line_store::{
    CLASS_GENERAL, CLASS_LEADERBOARD, CLASS_PLATFORM, CLASS_STUDIO, SIDE_OWN, SIDE_WON,
};
use tesoro_core::ledger::{CoreError, SourceChain};
use tesoro_core::state::*;
use tesoro_core::storage::*;
use tesoro_core::{accounts, instruction, LineRef};

mod common;
use common::econ::{book_metas, gemas_in, read_book};
use tesoro_core::ledger::lifecycle::Stage;

const GAME: APk = APk::new_from_array([9; 32]);
/// Slot the test Game was deployed in, and the slot the admin approves.
const GAME_SLOT: u64 = 100;
const LISTED_FOR_EVER: i64 = 4_000_000_000;
const ENTRY: u64 = 1_000;
const MATCH_NEEDS_TICKET: u32 = 6405;
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
fn counters_pda(account: APk) -> APk {
    pda(&[COUNTERS_SEED, account.as_ref()])
}
fn ticket_pda(account: APk, nonce: u64) -> APk {
    pda(&[TICKET_SEED, account.as_ref(), &nonce.to_le_bytes()])
}
fn receipt_pda(m: APk) -> APk {
    pda(&[RECEIPT_SEED, m.as_ref()])
}
fn event_authority() -> APk {
    pda(&[b"__event_authority"])
}

/// A Match as the tests hold it: the local id indexes `Env::matches`.
#[derive(Clone, Copy, Debug)]
struct MRef {
    key: APk,
    #[allow(dead_code)]
    opener: APk,
    #[allow(dead_code)]
    n: u64,
}
fn request_pda(account: APk, nonce: u64) -> APk {
    pda(&[REQUEST_SEED, account.as_ref(), &nonce.to_le_bytes()])
}
fn offer_pda(account: APk, nonce: u64) -> APk {
    pda(&[OFFER_SEED, account.as_ref(), &nonce.to_le_bytes()])
}
fn pair_pda(opener: APk, joiner: APk) -> APk {
    pda(&[PAIR_SEED, opener.as_ref(), joiner.as_ref()])
}
fn protections_pda(account: APk) -> APk {
    pda(&[PROTECTIONS_SEED, account.as_ref()])
}
fn anchor_code(e: tesoro_core::error::TesoroError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
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

fn bincode_len(tx: &solana_sdk::transaction::VersionedTransaction) -> usize {
    let t = tx.clone();
    t.message.serialize().len() + 1 + 64 * t.signatures.len()
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
    /// Upgrade authority of the test Game program.
    game_ctl: Keypair,
    platform: Person,
    studio: Person,
    matches: Vec<MRef>,
    pot_nonce: u64,
    person_seed: u8,
    /// Do not grow spills for the caller (to test the room check).
    skip_ensure: bool,
    /// Instructions the next join sends in the same transaction, before it.
    pre_ixs: Vec<Instruction>,
    /// Name the overflow records of every Account the Match can credit when joining.
    name_records: bool,
    /// Do not grow the Game's outside studio's spill when joining (to test a full studio).
    skip_studio_room: bool,
    last_cu: u64,
    /// Serialized size in bytes of the last transaction as a legacy transaction.
    last_size: usize,
    last_logs: Vec<String>,
    /// Event-CPI data of the last transaction, and of the last settlement start.
    last_events: Vec<Vec<u8>>,
    start_events: Vec<Vec<u8>>,
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
        let game_ctl = Keypair::new();
        for k in [&admin, &oracle, &game_auth, &game_ctl] {
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
            game_ctl,
            platform: placeholder(Keypair::new()),
            studio: placeholder(Keypair::new()),
            matches: Vec::new(),
            pot_nonce: 1_000,
            person_seed: 0,
            skip_ensure: false,
            name_records: false,
            skip_studio_room: false,
            pre_ixs: Vec::new(),
            last_cu: 0,
            last_size: 0,
            last_logs: Vec::new(),
            last_events: Vec::new(),
            start_events: Vec::new(),
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
        common::forge_upgradeable_program(
            &mut env.svm,
            s(GAME),
            Some(env.game_ctl.pubkey()),
            GAME_SLOT,
        );
        let game_ctl = env.game_ctl.insecure_clone();
        let register = env.register_game_ix(&game_ctl, a(env.game_auth.pubkey()), 300, studio);
        env.send(&[register], &admin, &[&game_ctl])
            .expect("register game");
        let list = env.list_game_ix(LISTED_FOR_EVER);
        env.send(&[list], &admin, &[]).expect("list game");
        let economy = ix(
            accounts::SetEconomy {
                admin: a(admin.pubkey()),
                config,
                economy: pda(&[ECONOMY_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetEconomy {
                season_keeper: APk::default(),
                fill_keeper: APk::default(),
                keeper_fills: false,
                routes: [APk::default(); MAX_ROUTES],
            },
            vec![],
        );
        env.send(&[economy], &admin, &[]).expect("economy");
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
                self.last_events = meta
                    .inner_instructions
                    .iter()
                    .flatten()
                    .map(|i| i.instruction.data.clone())
                    .collect();
                self.last_logs = meta.logs;
                Ok(())
            }
            Err(e) => {
                self.last_cu = e.meta.compute_units_consumed;
                Err(e)
            }
        }
    }

    fn game_accounts(&self) -> (APk, APk, APk) {
        (
            common::game_record(GAME),
            GAME,
            a(common::program_data_address(s(GAME))),
        )
    }

    fn register_game_ix(
        &self,
        control: &Keypair,
        settle_authority: APk,
        studio_bps: u16,
        studio_recipient: APk,
    ) -> Instruction {
        let (game_record, game_program, program_data) = self.game_accounts();
        ix(
            accounts::RegisterGame {
                payer: a(self.admin.pubkey()),
                control: a(control.pubkey()),
                config: pda(&[CONFIG_SEED]),
                game_program,
                program_data,
                studio_recipient,
                game_record,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::RegisterGame {
                settle_authority,
                studio_bps,
            },
            vec![],
        )
    }

    /// The admin lists the Game for the build on chain right now, hashed the way it would off-chain.
    fn list_game_ix(&self, listed_until: i64) -> Instruction {
        let (game_record, game_program, program_data) = self.game_accounts();
        ix(
            accounts::ListGame {
                admin: a(self.admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                game_record,
                game_program,
                program_data,
            },
            instruction::ListGame {
                listed_until,
                approved_hash: common::code_hash(&self.svm, s(GAME)),
            },
            vec![],
        )
    }

    fn person(&mut self) -> Person {
        // fixed keys, so the address derivations (and their compute cost) repeat run to run
        self.person_seed += 1;
        let kp = Keypair::new_from_array([self.person_seed; 32]);
        self.svm
            .airdrop(&kp.pubkey(), 1_000 * SOL)
            .expect("airdrop");
        let key = a(kp.pubkey());
        let account = account_pda(key);
        let create = ix(
            accounts::CreateAccount {
                authority: key,
                account,
                basket: tesoro_core::storage::basket_address(&account).0,
                spill: tesoro_core::storage::spill_address(&account).0,
                invite_gate: invite_gate_pda(),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::CreateAccount {
                evm_address: [0; 20],
            },
            vec![],
        );
        self.send(&[create], &kp, &[]).expect("create account");
        // Room for the Sources a Player collects: the tests below keep several at once.
        let grow = ix(
            accounts::GrowStore {
                payer: key,
                account,
                basket: basket_address(&account).0,
                spill: spill_address(&account).0,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::GrowStore {
                which: tesoro_core::StoreKind::Basket,
                extra_lines: 16,
            },
            vec![],
        );
        self.send(&[grow], &kp, &[]).expect("grow basket");
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
    fn stake(&mut self, p: &Person, id: u8) -> (APk, APk) {
        self.stake_principal(p, id, 100 * SOL)
    }

    /// Opens a Position of `principal` lamports and takes a 6-month Advance at $150: 750 Gemas
    /// per SOL of principal at the 10% rate used here.
    fn stake_principal(&mut self, p: &Person, id: u8, principal: u64) -> (APk, APk) {
        let position = self.open_position_only(p, id, principal);
        let source = source_pda(position, 0);
        self.take_advance(p, position, 0, 6, 150_000_000)
            .expect("advance");
        (position, source)
    }

    /// Opens a Position of `principal` lamports; the Advance is the caller's.
    fn open_position_only(&mut self, p: &Person, id: u8, principal: u64) -> APk {
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
        position
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
        let (asset, open_advance) = {
            let acct = self.svm.get_account(&s(position)).expect("position");
            let state =
                PositionState::try_deserialize(&mut acct.data.as_slice()).expect("position");
            (state.inner.source_asset, state.inner.open_advance)
        };
        let mut remaining = vec![AccountMeta::new_readonly(
            s(pda(&[ONCHAIN_PRICE_SEED, &asset])),
            false,
        )];
        if let Some(prev) = open_advance {
            let prev = source_pda(position, prev);
            remaining.push(AccountMeta::new_readonly(s(prev), false));
            remaining.extend(book_metas(&self.svm, prev));
        }
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
                book: book_address(&source).0,
                basket: basket_address(&p.account).0,
                spill: spill_address(&p.account).0,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::TakeAdvance {
                horizon_months: horizon,
                price_micro_usd: price,
                min_gemas: 1,
            },
            remaining,
        );
        let oracle = self.oracle.insecure_clone();
        self.send(&[advance], &oracle, &[&p.kp])?;
        self.ensure_pages(source);
        Ok(())
    }

    /// Creates page 0 of every class of the Source that writes checkpoint records.
    fn ensure_pages(&mut self, source: APk) {
        let n_ext = read_book(&self.svm, source).n_ext;
        let payer = Keypair::new();
        self.svm.airdrop(&payer.pubkey(), SOL).unwrap();
        for class in std::iter::once(1u8).chain(3..4 + n_ext) {
            let page = ckpt_address(&source, class, 0).0;
            if self.svm.get_account(&s(page)).is_some() {
                continue;
            }
            let init = ix(
                accounts::InitCkptPage {
                    payer: a(payer.pubkey()),
                    book: book_address(&source).0,
                    page,
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::InitCkptPage { class, page_no: 0 },
                vec![],
            );
            self.send(&[init], &payer, &[]).expect("checkpoint page");
        }
    }

    /// The owner's own General line of the Source, to name in Redeem and return_own.
    fn line(&self, source: APk, side: u8) -> LineRef {
        LineRef {
            side,
            due_at: self.load::<SourceState>(source).inner.due_at,
            class: CLASS_GENERAL,
            tranche: 0,
        }
    }

    fn yield_to(
        &mut self,
        signer: &Keypair,
        position: APk,
        source: Option<APk>,
        seq: u64,
        cumulative: u64,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let remaining = source.map_or(vec![], |src| book_metas(&self.svm, src));
        let apply = ix(
            accounts::ApplyYield {
                oracle: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                position,
                source,
            },
            instruction::ApplyYield { seq, cumulative },
            remaining,
        );
        self.send(&[apply], signer, &[])
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

    // --- Forged Sources and lines, for the budget tests -------------------------------------

    /// A Source with its Position and book, none of them reachable by an Advance: the lines issued
    /// from it behave like any other (the book is real), and a fee cut on them can sync.
    fn forge_source(&mut self, tag: u8, index: u32) -> APk {
        let position = pda(&[POSITION_SEED, &[7], &[tag; 32]]);
        let owner = [tag; 32];
        let mut pos = tesoro_core::ledger::Position::new(
            owner,
            SourceChain::Solana,
            [tag; 32],
            9,
            SOL,
            1_000,
        )
        .expect("position");
        pos.advances = index + 1;
        let state = PositionState {
            bump: 255,
            position_id: [tag; 32],
            inner: pos,
        };
        self.put_account(position, &state, PositionState::SPACE);
        let source = source_pda(position, index);
        let src_state = SourceState {
            bump: APk::find_program_address(
                &[SOURCE_SEED, position.as_ref(), &index.to_le_bytes()],
                &tesoro_core::ID,
            )
            .1,
            inner: tesoro_core::ledger::Source {
                position: position.to_bytes(),
                owner,
                index,
                horizon_months: 1,
                unit_num: 1,
                unit_den: 1,
                issued: 0,
                returned: 0,
                redeemed: 0,
                yield_units: 0,
                redeemed_units: 0,
                due_at: 0,
            },
        };
        self.put_account(source, &src_state, SourceState::SPACE);
        let payer = Keypair::new();
        self.svm.airdrop(&payer.pubkey(), 5 * SOL).unwrap();
        let init = ix(
            accounts::InitSourceBook {
                payer: a(payer.pubkey()),
                source,
                book: book_address(&source).0,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitSourceBook {},
            vec![],
        );
        self.send(&[init], &payer, &[]).expect("source book");
        // a fully cut line closes a segment, which writes a record: the first page must exist
        self.ensure_pages(source);
        source
    }

    fn put_account<T: anchor_lang::AccountSerialize>(&mut self, k: APk, v: &T, len: usize) {
        let mut buf = Vec::new();
        v.try_serialize(&mut buf).expect("serialize");
        buf.resize(len, 0);
        self.svm
            .set_account(
                s(k),
                solana_sdk::account::Account {
                    lamports: self.svm.minimum_balance_for_rent_exemption(len),
                    data: buf,
                    owner: s(tesoro_core::ID),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("set account");
    }

    /// Grows the Account's basket until it holds `lines` lines.
    fn grow_basket_to(&mut self, p: &Person, lines: usize) {
        loop {
            let d = self
                .svm
                .get_account(&s(basket_address(&p.account).0))
                .expect("basket")
                .data;
            let cap = tesoro_core::ledger::line_store::LineStore::new(&d[DISC..])
                .expect("basket")
                .capacity();
            if cap >= lines {
                return;
            }
            let n = (lines - cap).min(MAX_GROW_LINES);
            let grow = ix(
                accounts::GrowStore {
                    payer: p.key,
                    account: p.account,
                    basket: basket_address(&p.account).0,
                    spill: spill_address(&p.account).0,
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::GrowStore {
                    which: tesoro_core::StoreKind::Basket,
                    extra_lines: n as u32,
                },
                vec![],
            );
            self.send(&[grow], &p.kp, &[]).expect("grow basket");
        }
    }

    /// Issues `amount` Gemas of each Source as one own General line (due at `due(i)`) into the
    /// Player's basket, through the Source's real book.
    fn give_lines(&mut self, p: &Person, sources: &[APk], amount: u64, due: impl Fn(usize) -> i64) {
        use tesoro_core::ledger::book::checkpoint::NoCheckpoints;
        use tesoro_core::ledger::book::SourceBook;
        use tesoro_core::ledger::line_store::LineStore;
        for (i, src) in sources.iter().enumerate() {
            let mut book = read_book(&self.svm, *src);
            let mut line =
                SourceBook::blank_line(SIDE_OWN, due(i), src.to_bytes(), CLASS_GENERAL, 0);
            book.issue(&mut line, amount, &NoCheckpoints)
                .expect("issue");
            common::econ::write_book(&mut self.svm, *src, &book);
            let store = basket_address(&p.account).0;
            let mut acc = self.svm.get_account(&s(store)).expect("basket");
            LineStore::new(&mut acc.data[DISC..])
                .expect("basket")
                .insert(&line)
                .expect("room in the basket");
            self.svm.set_account(s(store), acc).expect("set basket");
        }
    }

    /// Sizes of `ix` sent alone as a legacy transaction and as a v0 transaction with a lookup
    /// table of every account that is not a signer: (legacy bytes, v0 bytes, accounts).
    fn tx_sizes(&self, ix: &Instruction, payer: &Keypair) -> (usize, usize, usize) {
        use solana_sdk::message::{v0, AddressLookupTableAccount, VersionedMessage};
        let legacy = Transaction::new_with_payer(std::slice::from_ref(ix), Some(&payer.pubkey()));
        let legacy_len = legacy.message.serialize().len() + 1 + 64;
        let table: Vec<Pk> = ix
            .accounts
            .iter()
            .filter(|m| !m.is_signer)
            .map(|m| m.pubkey)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let alt = AddressLookupTableAccount {
            key: Pk::new_unique(),
            addresses: table,
        };
        let msg = v0::Message::try_compile(
            &payer.pubkey(),
            std::slice::from_ref(ix),
            &[alt],
            self.svm.latest_blockhash(),
        )
        .expect("compile v0");
        let v0_len = VersionedMessage::V0(msg).serialize().len() + 1 + 64;
        (legacy_len, v0_len, ix.accounts.len())
    }

    /// Sends `ixs` as a v0 transaction whose lookup table holds every non-signer account (the
    /// way the relayer sends big chunks). Returns the transaction's size in bytes.
    fn send_v0(
        &mut self,
        ixs: &[Instruction],
        payer: &Keypair,
    ) -> Result<usize, litesvm::types::FailedTransactionMetadata> {
        use solana_sdk::message::{v0, AddressLookupTableAccount, VersionedMessage};
        use solana_sdk::transaction::VersionedTransaction;
        let table: Vec<Pk> = ixs
            .iter()
            .flat_map(|i| i.accounts.iter())
            .filter(|m| !m.is_signer)
            .map(|m| m.pubkey)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        // the account the runtime reads: 56 bytes of meta, then the addresses
        let alt_key = Pk::new_unique();
        let mut data = vec![0u8; 56];
        data[0..4].copy_from_slice(&1u32.to_le_bytes());
        data[4..12].copy_from_slice(&u64::MAX.to_le_bytes());
        for k in &table {
            data.extend_from_slice(k.as_ref());
        }
        self.svm
            .set_account(
                alt_key,
                solana_sdk::account::Account {
                    lamports: 10 * SOL,
                    data,
                    owner: "AddressLookupTab1e1111111111111111111111111"
                        .parse()
                        .expect("alt program"),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("lookup table");
        self.svm.warp_to_slot(10);
        self.svm.expire_blockhash();
        let alt = AddressLookupTableAccount {
            key: alt_key,
            addresses: table,
        };
        let msg =
            v0::Message::try_compile(&payer.pubkey(), ixs, &[alt], self.svm.latest_blockhash())
                .expect("compile v0");
        let tx =
            VersionedTransaction::try_new(VersionedMessage::V0(msg), &[payer]).expect("sign v0");
        let size = bincode_len(&tx);
        match self.svm.send_transaction(tx) {
            Ok(meta) => {
                self.last_cu = meta.compute_units_consumed;
                self.last_events = meta
                    .inner_instructions
                    .iter()
                    .flatten()
                    .map(|i| i.instruction.data.clone())
                    .collect();
                self.last_logs = meta.logs;
                Ok(size)
            }
            Err(e) => {
                self.last_cu = e.meta.compute_units_consumed;
                Err(e)
            }
        }
    }

    // --- Tickets -----------------------------------------------------------------------------

    /// Opens an Entry Ticket with room for `lines` lines (the spill gets the room first).
    fn open_ticket(
        &mut self,
        p: &Person,
        nonce: u64,
        entry: u64,
        lines: u32,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        self.ensure_spill(&p.kp, p.account, lines as usize);
        let open = ix(
            accounts::OpenTicket {
                payer: p.key,
                authority: p.key,
                requester: p.account,
                owner: p.account,
                basket: basket_address(&p.account).0,
                spill: spill_address(&p.account).0,
                ticket: ticket_pda(p.account, nonce),
                offer: None,
                sponsor: None,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::OpenTicket {
                nonce,
                kind: tesoro_core::TicketKindArg::Entry,
                game: GAME,
                target: entry,
                lines,
            },
            vec![],
        );
        self.send(&[open], &p.kp, &[])
    }

    /// A Backing Ticket for the accepted `offer`, opened by the Requester `req` on the Backer's
    /// basket.
    fn open_backing_ticket(
        &mut self,
        backer: &Person,
        req: &Person,
        offer: APk,
        nonce: u64,
        entry: u64,
        lines: u32,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        self.ensure_spill(&req.kp, backer.account, lines as usize);
        let open = ix(
            accounts::OpenTicket {
                payer: req.key,
                authority: req.key,
                requester: req.account,
                owner: backer.account,
                basket: basket_address(&backer.account).0,
                spill: spill_address(&backer.account).0,
                ticket: ticket_pda(backer.account, nonce),
                offer: Some(offer),
                sponsor: None,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::OpenTicket {
                nonce,
                kind: tesoro_core::TicketKindArg::Backing,
                game: GAME,
                target: entry,
                lines,
            },
            vec![],
        );
        self.send(&[open], &req.kp, &[])
    }

    fn cancel_backing_ticket(
        &mut self,
        signer: &Keypair,
        backer: &Person,
        nonce: u64,
        offer: Option<APk>,
        books: Vec<AccountMeta>,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let i = ix(
            accounts::CancelTicket {
                signer: a(signer.pubkey()),
                owner: backer.account,
                basket: basket_address(&backer.account).0,
                spill: spill_address(&backer.account).0,
                ticket: ticket_pda(backer.account, nonce),
                offer,
            },
            instruction::CancelTicket { max_lines: 32 },
            books,
        );
        self.send(&[i], signer, &[])
    }

    fn stage_with(
        &mut self,
        signer: &Keypair,
        owner: &Person,
        nonce: u64,
        max_ops: u8,
        books: Vec<AccountMeta>,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let i = ix(
            accounts::StageEntry {
                signer: a(signer.pubkey()),
                owner: owner.account,
                basket: basket_address(&owner.account).0,
                spill: spill_address(&owner.account).0,
                ticket: ticket_pda(owner.account, nonce),
            },
            instruction::StageEntry { max_ops },
            books,
        );
        self.send(&[i], signer, &[])
    }

    fn cancel_ticket_with(
        &mut self,
        signer: &Keypair,
        owner: &Person,
        nonce: u64,
        max_lines: u8,
        books: Vec<AccountMeta>,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let i = ix(
            accounts::CancelTicket {
                signer: a(signer.pubkey()),
                owner: owner.account,
                basket: basket_address(&owner.account).0,
                spill: spill_address(&owner.account).0,
                ticket: ticket_pda(owner.account, nonce),
                offer: None,
            },
            instruction::CancelTicket { max_lines },
            books,
        );
        self.send(&[i], signer, &[])
    }

    fn close_ticket(
        &mut self,
        caller: &Keypair,
        owner: &Person,
        nonce: u64,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let i = ix(
            accounts::CloseTicket {
                caller: a(caller.pubkey()),
                ticket: ticket_pda(owner.account, nonce),
                payer: owner.key,
                sponsor: None,
            },
            instruction::CloseTicket {},
            vec![],
        );
        self.send(&[i], caller, &[])
    }

    fn ticket_state(&self, owner: &Person, nonce: u64) -> tesoro_core::ledger::draw::TicketState {
        let d = self
            .svm
            .get_account(&s(ticket_pda(owner.account, nonce)))
            .expect("ticket")
            .data;
        match d[8 + 3] {
            0 => tesoro_core::ledger::draw::TicketState::Open,
            1 => tesoro_core::ledger::draw::TicketState::Cancelling,
            2 => tesoro_core::ledger::draw::TicketState::Closed,
            _ => tesoro_core::ledger::draw::TicketState::Cancelled,
        }
    }

    // --- Matches on baskets, Tickets and chunks ---------------------------------------------

    fn counters_next(&self, account: APk) -> u64 {
        self.svm
            .get_account(&s(counters_pda(account)))
            .map_or(0, |acc| {
                AccountCounters::try_deserialize(&mut acc.data.as_slice())
                    .expect("counters")
                    .next_match
            })
    }

    fn counters(&self, account: APk) -> AccountCounters {
        self.load::<AccountCounters>(counters_pda(account))
    }

    /// Every Source that has a line in the Account's basket or spill.
    fn sources_in(&self, account: APk) -> Vec<APk> {
        let mut out: Vec<APk> = Vec::new();
        for store in [basket_address(&account).0, spill_address(&account).0] {
            for l in common::econ::read_lines(&self.svm, store) {
                let k = APk::new_from_array(l.source);
                if !out.contains(&k) {
                    out.push(k);
                }
            }
        }
        out
    }

    /// The books (with pages) of the Sources the Account holds, as remaining accounts.
    fn books_of(&self, account: APk) -> Vec<AccountMeta> {
        let mut out = vec![];
        // a transaction locks at most 64 accounts; the tests that need more pass their own
        for src in self.sources_in(account).into_iter().take(6) {
            out.extend(book_metas(&self.svm, src));
        }
        out
    }

    /// Grows the Account's spill (anyone may pay) until `free` slots are neither used nor held.
    fn ensure_spill(&mut self, payer: &Keypair, account: APk, free: usize) {
        if self.skip_ensure {
            return;
        }
        let d = self
            .svm
            .get_account(&s(spill_address(&account).0))
            .expect("spill")
            .data;
        let store = tesoro_core::ledger::line_store::LineStore::new(&d[DISC..]).expect("spill");
        let have = store.capacity() - store.len() - store.room_reserved() as usize;
        if have >= free {
            return;
        }
        let mut need = free - have;
        while need > 0 {
            let n = need.min(MAX_GROW_LINES);
            let grow = ix(
                accounts::GrowStore {
                    payer: a(payer.pubkey()),
                    account,
                    basket: basket_address(&account).0,
                    spill: spill_address(&account).0,
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::GrowStore {
                    which: tesoro_core::StoreKind::Spill,
                    extra_lines: n as u32,
                },
                vec![],
            );
            self.send(&[grow], payer, &[]).expect("grow spill");
            need -= n;
        }
    }

    /// The overflow record of the Account for the Match, once it exists.
    fn record_of(&self, owner: APk, id: u64) -> Option<APk> {
        let seed = self.mstate(id).inner.id.seed();
        let key = overflow_address(&owner, OVERFLOW_MATCH, &seed).0;
        self.svm.get_account(&s(key)).map(|_| key)
    }

    fn mref(&self, id: u64) -> MRef {
        self.matches[id as usize]
    }

    /// The Match state of the local id `id`.
    /// Gemas the Entry Ticket has staged so far (its Pot store's totals).
    fn load_ticket_staged(&self, p: &Person, nonce: u64) -> u64 {
        let d = self
            .svm
            .get_account(&s(ticket_pda(p.account, nonce)))
            .expect("ticket")
            .data;
        let st = tesoro_core::ledger::line_store::LineStore::new(&d[tesoro_core::pots::POT_AT..])
            .expect("store");
        st.own_total() + st.won_total()
    }

    fn mstate(&self, id: u64) -> MatchState {
        self.load::<MatchState>(self.mref(id).key)
    }

    fn match_key(&self, id: u64) -> APk {
        self.mref(id).key
    }

    fn open_match(
        &mut self,
        p: &Person,
        entry: u64,
    ) -> Result<u64, litesvm::types::FailedTransactionMetadata> {
        self.open_match_with(p, entry, false, 0, 4)
    }

    /// A direct draw into a fresh Pot of `pot_lines` lines.
    fn open_match_with(
        &mut self,
        p: &Person,
        entry: u64,
        challenge: bool,
        asset: u8,
        pot_lines: u32,
    ) -> Result<u64, litesvm::types::FailedTransactionMetadata> {
        let n = self.counters_next(p.account);
        self.pot_nonce += 1;
        let nonce = self.pot_nonce;
        let pot = ticket_pda(p.account, nonce);
        let remaining = self.books_of(p.account);
        self.open_match_ix(
            p, entry, n, nonce, challenge, asset, pot_lines, pot, remaining, None,
        )
    }

    /// Opens with a complete Ticket as the Pot.
    fn open_match_ticket(
        &mut self,
        p: &Person,
        entry: u64,
        ticket_nonce: u64,
    ) -> Result<u64, litesvm::types::FailedTransactionMetadata> {
        let n = self.counters_next(p.account);
        let pot = ticket_pda(p.account, ticket_nonce);
        // consuming a complete Ticket moves no line: no book is needed
        self.open_match_ix(p, entry, n, ticket_nonce, false, 0, 1, pot, vec![], None)
    }

    #[allow(clippy::too_many_arguments)]
    fn open_match_ix(
        &mut self,
        p: &Person,
        entry: u64,
        n: u64,
        pot_nonce: u64,
        challenge: bool,
        asset: u8,
        pot_lines: u32,
        pot: APk,
        remaining: Vec<AccountMeta>,
        backing: Option<(APk, APk)>,
    ) -> Result<u64, litesvm::types::FailedTransactionMetadata> {
        self.open_match_game(
            p,
            entry,
            (n, pot_nonce, challenge, asset, pot_lines),
            pot,
            remaining,
            backing,
            None,
        )
    }

    /// `programs` overrides the Game: its id and the ProgramData account passed with it.
    #[allow(clippy::too_many_arguments)]
    fn open_match_game(
        &mut self,
        p: &Person,
        entry: u64,
        (n, pot_nonce, challenge, asset, pot_lines): (u64, u64, bool, u8, u32),
        pot: APk,
        remaining: Vec<AccountMeta>,
        backing: Option<(APk, APk)>,
        programs: Option<(APk, APk)>,
    ) -> Result<u64, litesvm::types::FailedTransactionMetadata> {
        let (game_record, game_program, program_data) = match programs {
            Some((game, pd)) => (common::game_record(game), game, pd),
            None => self.game_accounts(),
        };
        let key = pda(&[MATCH_SEED, p.account.as_ref(), &n.to_le_bytes()]);
        let backer = backing.map(|(_, b)| b);
        let mut remaining = remaining;
        if self.name_records {
            let seed = tesoro_core::ledger::lifecycle::MatchId {
                opener: p.account.to_bytes(),
                n,
            }
            .seed();
            remaining.push(rem(overflow_address(
                &backer.unwrap_or(p.account),
                OVERFLOW_MATCH,
                &seed,
            )
            .0));
        }
        let room = 16 + 2 * pot_lines as usize;
        self.ensure_spill(&p.kp, p.account, room);
        if let Some(b) = backer {
            self.ensure_spill(&p.kp, b, room);
        }
        let open = ix(
            accounts::OpenMatch {
                payer: p.key,
                player_authority: p.key,
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                game_record,
                game_program,
                program_data,
                player_account: p.account,
                counters: counters_pda(p.account),
                protections: protections_pda(p.account),
                basket: basket_address(&p.account).0,
                spill: spill_address(&p.account).0,
                pot,
                match_state: key,
                offer: backing.map(|(o, _)| o),
                backer_account: backer,
                backer_counters: backer.map(counters_pda),
                backer_protections: backer.map(protections_pda),
                backer_basket: backer.map(|b| basket_address(&b).0),
                backer_spill: backer.map(|b| spill_address(&b).0),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::OpenMatch {
                game: game_program,
                entry,
                n,
                pot_nonce,
                challenge,
                asset,
                pot_lines,
            },
            remaining,
        );
        self.send(&[open], &p.kp, &[])?;
        self.matches.push(MRef {
            key,
            opener: p.account,
            n,
        });
        Ok(self.matches.len() as u64 - 1)
    }

    fn join_match(
        &mut self,
        p: &Person,
        id: u64,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        self.pot_nonce += 1;
        let nonce = self.pot_nonce;
        let pot = ticket_pda(p.account, nonce);
        let remaining = self.books_of(p.account);
        self.join_match_ix(p, id, nonce, 4, pot, remaining, None)
    }

    #[allow(clippy::too_many_arguments)]
    fn join_match_ix(
        &mut self,
        p: &Person,
        id: u64,
        pot_nonce: u64,
        pot_lines: u32,
        pot: APk,
        remaining: Vec<AccountMeta>,
        backing: Option<(APk, APk)>,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let (game_record, game_program, program_data) = self.game_accounts();
        let backer = backing.map(|(_, b)| b);
        let m = self.mstate(id);
        let opener = APk::new_from_array(m.inner.a.player);
        let opener_funder = APk::new_from_array(m.inner.a.funder);
        let room = 16 + 2 * pot_lines as usize + 2 * m.inner.pot_lines[0] as usize;
        for who in [p.account, opener, opener_funder] {
            self.ensure_spill(&p.kp, who, room);
        }
        if let Some(b) = backer {
            self.ensure_spill(&p.kp, b, room);
        }
        // the Game's outside studio gets its room too (its fee lines land in its basket)
        let studio_owner = m
            .inner
            .terms
            .studio_owner
            .filter(|_| m.inner.terms.studio_bps > 0)
            .map(APk::new_from_array);
        if let Some(studio) = studio_owner.filter(|_| !self.skip_studio_room) {
            self.ensure_spill(&p.kp, studio, room);
        }
        let mut remaining = remaining;
        // a Game's outside studio is paid by a basket line: its stores travel with the join
        if let Some(studio) = m
            .inner
            .terms
            .studio_owner
            .filter(|_| m.inner.terms.studio_bps > 0)
        {
            let studio = APk::new_from_array(studio);
            remaining.push(rem(basket_address(&studio).0));
            remaining.push(rem(spill_address(&studio).0));
        }
        if self.name_records {
            let mut who = vec![p.account, opener, opener_funder];
            who.extend(backer);
            who.extend(m.inner.terms.studio_owner.map(APk::new_from_array));
            who.sort();
            who.dedup();
            let seed = m.inner.id.seed();
            for k in who {
                remaining.push(rem(overflow_address(&k, OVERFLOW_MATCH, &seed).0));
            }
        }
        let join = ix(
            accounts::JoinMatch {
                payer: p.key,
                player_authority: p.key,
                player_account: p.account,
                counters: counters_pda(p.account),
                protections: protections_pda(p.account),
                basket: basket_address(&p.account).0,
                spill: spill_address(&p.account).0,
                pot,
                match_state: self.match_key(id),
                opener_protections: protections_pda(opener),
                opener_basket: basket_address(&opener).0,
                opener_spill: spill_address(&opener).0,
                opener_funder_basket: basket_address(&opener_funder).0,
                opener_funder_spill: spill_address(&opener_funder).0,
                pair: pair_pda(opener, p.account),
                game_record,
                game_program,
                program_data,
                offer: backing.map(|(o, _)| o),
                backer_account: backer,
                backer_counters: backer.map(counters_pda),
                backer_protections: backer.map(protections_pda),
                backer_basket: backer.map(|b| basket_address(&b).0),
                backer_spill: backer.map(|b| spill_address(&b).0),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::JoinMatch {
                pot_nonce,
                pot_lines,
            },
            remaining,
        );
        let mut ixs = std::mem::take(&mut self.pre_ixs);
        ixs.push(join);
        self.send(&ixs, &p.kp, &[])
    }

    fn opener_account(&self, id: u64) -> APk {
        APk::new_from_array(self.mstate(id).inner.a.player)
    }

    /// Old suites passed payout accounts; settling now needs none.
    fn payout_accounts(&mut self, _id: u64, _result: MatchResult) -> Vec<AccountMeta> {
        vec![]
    }

    fn refund_accounts(&mut self, _id: u64) -> Vec<AccountMeta> {
        vec![]
    }

    /// Starts settling: freezes the outcome and fees, writes the receipt.
    fn settle_start(
        &mut self,
        signer: &Keypair,
        id: u64,
        result: MatchResult,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let (game_record, game_program, program_data) = self.game_accounts();
        let key = self.match_key(id);
        let settle = ix(
            accounts::SettleMatch {
                game_authority: a(signer.pubkey()),
                payer: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                game_record,
                game_program,
                program_data,
                match_state: key,
                receipt: receipt_pda(key),
                system_program: anchor_lang::system_program::ID,
                event_authority: event_authority(),
                program: tesoro_core::ID,
            },
            instruction::SettleMatch { result },
            vec![],
        );
        self.send(&[settle], signer, &[])?;
        self.start_events = self.last_events.clone();
        Ok(())
    }

    /// Starts settling and runs every chunk (the Match record stays, in stage Closed).
    fn settle_keep(
        &mut self,
        signer: &Keypair,
        id: u64,
        result: MatchResult,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        self.settle_start(signer, id, result)?;
        self.run_chunks(id);
        Ok(())
    }

    /// Starts settling, runs every chunk and closes the Match.
    fn settle(
        &mut self,
        signer: &Keypair,
        id: u64,
        result: MatchResult,
        _remaining: Vec<AccountMeta>,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        self.settle_start(signer, id, result)?;
        self.finish_run(id);
        Ok(())
    }

    fn refund_start(
        &mut self,
        caller: &Keypair,
        id: u64,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let (_, _, program_data) = self.game_accounts();
        self.refund_start_with(caller, id, program_data)
    }

    fn refund_start_with(
        &mut self,
        caller: &Keypair,
        id: u64,
        program_data: APk,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let (game_record, game_program, _) = self.game_accounts();
        let key = self.match_key(id);
        let refund = ix(
            accounts::RefundMatch {
                caller: a(caller.pubkey()),
                payer: a(caller.pubkey()),
                game_record,
                game_program,
                program_data,
                match_state: key,
                receipt: receipt_pda(key),
                opener_protections: Some(protections_pda(self.opener_account(id))),
                system_program: anchor_lang::system_program::ID,
                event_authority: event_authority(),
                program: tesoro_core::ID,
            },
            instruction::RefundMatch {},
            vec![],
        );
        self.send(&[refund], caller, &[])
    }

    /// Starts refunding and runs every chunk (the Match record stays, in stage Closed).
    fn refund_keep(
        &mut self,
        caller: &Keypair,
        id: u64,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        self.refund_start(caller, id)?;
        self.run_chunks(id);
        Ok(())
    }

    /// Starts refunding, runs every chunk and closes the Match.
    fn refund(
        &mut self,
        caller: &Keypair,
        id: u64,
        _remaining: Vec<AccountMeta>,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        self.refund_start(caller, id)?;
        self.finish_run(id);
        Ok(())
    }

    /// The Accounts a Match can credit: both sides' players and funders, and the studio.
    fn match_owners(&self, id: u64) -> Vec<APk> {
        let m = self.mstate(id).inner;
        let mut out: Vec<APk> = vec![];
        let mut add = |k: [u8; 32]| {
            let k = APk::new_from_array(k);
            if !out.contains(&k) {
                out.push(k);
            }
        };
        add(m.a.player);
        add(m.a.funder);
        if let Some(b) = m.b {
            add(b.player);
            add(b.funder);
        }
        if let Some(st) = m.terms.studio_owner {
            add(st);
        }
        out
    }

    /// Everything the next `steps` steps of this Match touch: the baskets and spills of the
    /// Accounts credited, and for the Sources those steps reach, the book (and pages), the
    /// Source and its Position. The client works this out with `MatchRecord::sources_ahead`.
    fn chunk_remaining(&self, id: u64, steps: u8) -> Vec<AccountMeta> {
        let mut out = vec![];
        for o in self.match_owners(id) {
            out.push(rem(basket_address(&o).0));
            out.push(rem(spill_address(&o).0));
            if let Some(r) = self.record_of(o, id) {
                out.push(rem(r));
            }
        }
        let m = self.mstate(id);
        let pots: tesoro_core::ledger::lifecycle::Pots = [0, 1].map(|side| {
            (m.pots[side] != APk::default()).then(|| {
                let d = self.svm.get_account(&s(m.pots[side])).expect("pot").data;
                tesoro_core::ledger::draw::PotPages::open(d[tesoro_core::pots::POT_AT..].to_vec())
                    .expect("pot")
            })
        });
        for src in m.inner.sources_ahead(&pots, steps as usize) {
            let src = APk::new_from_array(src);
            out.extend(book_metas(&self.svm, src));
            out.push(AccountMeta::new_readonly(s(src), false));
            let position = APk::new_from_array(self.load::<SourceState>(src).inner.position);
            out.push(rem(position));
        }
        out
    }

    fn chunk_ix(&self, caller: APk, id: u64, max_steps: u8) -> Instruction {
        let m = self.mstate(id);
        ix(
            accounts::MatchChunk {
                caller,
                match_state: self.match_key(id),
                pot_a: m.pots[0],
                pot_b: (m.pots[1] != APk::default()).then_some(m.pots[1]),
                event_authority: event_authority(),
                program: tesoro_core::ID,
            },
            instruction::MatchChunk { max_steps },
            self.chunk_remaining(id, max_steps),
        )
    }

    /// Runs one chunk of up to `steps` steps.
    fn chunk(
        &mut self,
        id: u64,
        steps: u8,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let payer = self.admin.insecure_clone();
        // a transaction locks at most 64 accounts: the client takes fewer steps when the next
        // ones reach many Sources (4 or 5 accounts each)
        let mut steps = steps;
        let mut i = self.chunk_ix(a(payer.pubkey()), id, steps);
        while i.accounts.len() > 60 && steps > 1 {
            steps -= 1;
            i = self.chunk_ix(a(payer.pubkey()), id, steps);
        }
        self.send_v0(&[i], &payer).map(drop)
    }

    fn stage_of(&self, id: u64) -> tesoro_core::ledger::lifecycle::Stage {
        self.mstate(id).inner.stage()
    }

    fn close_match_ix(&self, caller: APk, id: u64) -> Instruction {
        let m = self.mstate(id);
        let payer_of = |pot: APk| -> APk {
            let d = self.svm.get_account(&s(pot)).expect("pot").data;
            APk::new_from_array(d[8 + 72..8 + 104].try_into().unwrap())
        };
        let mut remaining = vec![];
        for o in self.match_owners(id) {
            remaining.push(rem(spill_address(&o).0));
        }
        let rec = &m.inner;
        remaining.push(rem(counters_pda(APk::new_from_array(rec.a.player))));
        if let Some(b) = rec.b {
            remaining.push(rem(counters_pda(APk::new_from_array(b.player))));
        }
        ix(
            accounts::CloseMatch {
                caller,
                match_state: self.match_key(id),
                match_payer: m.payer,
                pot_a: m.pots[0],
                pot_a_payer: payer_of(m.pots[0]),
                pot_b: (m.pots[1] != APk::default()).then_some(m.pots[1]),
                pot_b_payer: (m.pots[1] != APk::default()).then(|| payer_of(m.pots[1])),
                sponsor: None,
            },
            instruction::CloseMatch {},
            remaining,
        )
    }

    fn close_match(&mut self, id: u64) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let payer = self.admin.insecure_clone();
        let i = self.close_match_ix(a(payer.pubkey()), id);
        self.send(&[i], &payer, &[])
    }

    /// Runs chunks until the run is complete.
    fn run_chunks(&mut self, id: u64) {
        for _ in 0..200 {
            if self.stage_of(id) == Stage::Closed {
                break;
            }
            self.chunk(id, 12).expect("chunk");
        }
        assert_eq!(self.stage_of(id), Stage::Closed);
    }

    /// Runs chunks until the run is complete, then closes the Match.
    fn finish_run(&mut self, id: u64) {
        self.run_chunks(id);
        self.close_match(id).expect("close match");
    }

    /// Gemas of `source` the Account holds (basket and spill, all classes).
    fn gemas_of(&self, p: &Person, source: APk) -> u64 {
        gemas_in(&self.svm, p.account, source)
    }

    /// Playable Gemas (own and won) in the Account's basket and spill.
    fn total_gemas(&self, p: &Person) -> u64 {
        [basket_address(&p.account).0, spill_address(&p.account).0]
            .into_iter()
            .map(|st| {
                let d = self.svm.get_account(&s(st)).expect("store").data;
                let store =
                    tesoro_core::ledger::line_store::LineStore::new(&d[DISC..]).expect("store");
                store.own_total() + store.won_total()
            })
            .sum()
    }

    /// Fee-class Gemas (Studio Fee lines) in the Account's basket and spill.
    fn fee_gemas(&self, p: &Person) -> u64 {
        [basket_address(&p.account).0, spill_address(&p.account).0]
            .into_iter()
            .map(|st| {
                let d = self.svm.get_account(&s(st)).expect("store").data;
                tesoro_core::ledger::line_store::LineStore::new(&d[DISC..])
                    .expect("store")
                    .fee_total()
            })
            .sum()
    }

    /// What the Source's fee counter of `class` holds.
    fn counter_amount(&self, source: APk, class: u8) -> u64 {
        common::econ::counter(&self.svm, source, class).map_or(0, |l| l.amount)
    }
}

/// Two stakers, alice and bob, each with 75_000 Gemas of their own Source.
struct Duel {
    env: Env,
    alice: Person,
    bob: Person,
    a_position: APk,
    a_source: APk,
    b_source: APk,
}

fn duel() -> Duel {
    let mut env = Env::new();
    let alice = env.person();
    let bob = env.person();
    let (a_position, a_source) = env.stake(&alice, 1);
    let (_, b_source) = env.stake(&bob, 2);
    Duel {
        env,
        alice,
        bob,
        a_position,
        a_source,
        b_source,
    }
}

#[test]
fn advance_is_100_percent_of_projected_yield_in_gemas() {
    let d = duel();
    let src = d.env.load::<SourceState>(d.a_source).inner;
    assert_eq!(src.issued, 75_000);
    assert_eq!(src.debt(), 75_000);
    assert_eq!(d.env.gemas_of(&d.alice, d.a_source), 75_000);
    assert_eq!(d.env.total_gemas(&d.alice), 75_000);
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

impl Env {
    fn redeem_ix_reported(
        &self,
        p: &Person,
        position: APk,
        source: APk,
        side: u8,
        amount: u64,
    ) -> Instruction {
        ix(
            accounts::Redeem {
                holder_authority: p.key,
                holder_account: p.account,
                basket: basket_address(&p.account).0,
                spill: spill_address(&p.account).0,
                position,
                source,
            },
            instruction::Redeem {
                line: self.line(source, side),
                amount,
            },
            book_metas(&self.svm, source),
        )
    }

    fn unlock_ix_reported(&self, p: &Person, position: APk) -> Instruction {
        let mut remaining = vec![];
        let state = self.load::<PositionState>(position);
        if let Some(open) = state.inner.open_advance {
            let src = source_pda(position, open);
            remaining.push(rem(src));
            remaining.extend(book_metas(&self.svm, src));
        }
        ix(
            accounts::Unlock {
                owner_authority: p.key,
                owner_account: p.account,
                economy: pda(&[ECONOMY_SEED]),
                position,
            },
            instruction::Unlock {},
            remaining,
        )
    }

    fn return_own_ix_reported(
        &self,
        p: &Person,
        position: APk,
        source: APk,
        amount: u64,
    ) -> Instruction {
        ix(
            accounts::ReturnOwn {
                owner_authority: p.key,
                owner_account: p.account,
                basket: basket_address(&p.account).0,
                spill: spill_address(&p.account).0,
                position,
                source,
            },
            instruction::ReturnOwn {
                line: self.line(source, SIDE_OWN),
                amount,
            },
            book_metas(&self.svm, source),
        )
    }

    /// Left to pay back of a Source's book, in Gemas.
    fn debt_of(&self, source: APk) -> u64 {
        fp_ceil(read_book(&self.svm, source).uncovered_total()) as u64
    }
}

#[test]
fn yield_repays_debt_and_redeem_stops_at_accrued() {
    let mut d = duel();
    let oracle = d.env.oracle.insecure_clone();
    // 2.5 tokens accrued = $375 = 37_500 Gemas repaid, half of the Advance.
    d.env
        .yield_to(&oracle, d.a_position, Some(d.a_source), 1, 5 * SOL / 2)
        .expect("yield");
    assert_eq!(d.env.debt_of(d.a_source), 37_500);

    // Replay of the same message and an older sequence change nothing.
    let before = d.env.load::<PositionState>(d.a_position).inner;
    let book_before = read_book(&d.env.svm, d.a_source);
    d.env
        .yield_to(&oracle, d.a_position, Some(d.a_source), 1, 4 * SOL)
        .expect("replay is a no-op");
    d.env
        .yield_to(&oracle, d.a_position, Some(d.a_source), 0, 4 * SOL)
        .expect("stale is a no-op");
    assert_eq!(d.env.load::<PositionState>(d.a_position).inner, before);
    assert_eq!(read_book(&d.env.svm, d.a_source), book_before);
    assert_eq!(d.env.debt_of(d.a_source), 37_500);
    // Cumulative yield never goes backwards.
    let err = d
        .env
        .yield_to(&oracle, d.a_position, Some(d.a_source), 2, SOL)
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::CumulativeDecreased));

    let redeem = |d: &mut Duel, amount: u64| {
        let ixn = d
            .env
            .redeem_ix_reported(&d.alice, d.a_position, d.a_source, SIDE_OWN, amount);
        let alice = d.alice.kp.insecure_clone();
        d.env.send(&[ixn], &alice, &[])
    };
    let err = redeem(&mut d, 37_501).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::ExceedsRedeemable));
    redeem(&mut d, 37_500).expect("redeem accrued part");
    let src = d.env.load::<SourceState>(d.a_source).inner;
    // Whole shares round down: a lamport at most stays with the line.
    assert_eq!(src.redeemed, 37_500);
    assert!(
        (2_499_999_999..=2_500_000_000).contains(&src.redeemed_units),
        "{}",
        src.redeemed_units
    );
    assert_eq!(gemas_in(&d.env.svm, d.alice.account, d.a_source), 37_500);
    let err = redeem(&mut d, 1).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::ExceedsRedeemable));

    // Debt remains, so the Position stays locked and cannot unlock.
    let alice = d.alice.kp.insecure_clone();
    let unlock = d.env.unlock_ix_reported(&d.alice, d.a_position);
    let err = d.env.send(&[unlock], &alice, &[]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::DebtOutstanding));
    d.env
        .yield_to(&oracle, d.a_position, Some(d.a_source), 3, 6 * SOL)
        .expect("more yield");
    assert_eq!(d.env.debt_of(d.a_source), 0);
    let unlock = d.env.unlock_ix_reported(&d.alice, d.a_position);
    d.env
        .send(&[unlock], &alice, &[])
        .expect("unlock at zero debt");
}

#[test]
fn return_own_cancels_debt_and_principal_never_does() {
    let mut d = duel();
    let alice = d.alice.kp.insecure_clone();
    let ret = d
        .env
        .return_own_ix_reported(&d.alice, d.a_position, d.a_source, 10_000);
    d.env.send(&[ret], &alice, &[]).expect("return own");
    let src = d.env.load::<SourceState>(d.a_source).inner;
    assert_eq!((src.returned, src.outstanding()), (10_000, 65_000));
    assert_eq!(d.env.debt_of(d.a_source), 65_000);
    assert_eq!(gemas_in(&d.env.svm, d.alice.account, d.a_source), 65_000);
    // More Gemas than the line holds are refused.
    let ret = d
        .env
        .return_own_ix_reported(&d.alice, d.a_position, d.a_source, 65_001);
    let err = d.env.send(&[ret], &alice, &[]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InsufficientGemas));

    // Bob wins some of Alice's Gemas; returning them (or anything else) as Bob cannot cut her Debt.
    let bob = d.bob.kp.insecure_clone();
    let m = d.env.open_match(&d.alice, ENTRY).expect("open");
    d.env.join_match(&d.bob, m).expect("join");
    let game = d.env.game_auth.insecure_clone();
    let payouts = d.env.payout_accounts(m, MatchResult::Joiner);
    d.env
        .settle(&game, m, MatchResult::Joiner, payouts)
        .expect("settle");
    assert!(d.env.gemas_of(&d.bob, d.a_source) > 0);
    let debt = d.env.debt_of(d.a_source);
    // Bob is not the Position owner: the ownership constraint rejects it.
    let steal = d
        .env
        .return_own_ix_reported(&d.bob, d.a_position, d.a_source, 1);
    assert!(d.env.send(&[steal], &bob, &[]).is_err());
    assert_eq!(d.env.debt_of(d.a_source), debt);
}

#[test]
fn match_settles_to_winner_minus_fees_exactly_once() {
    let mut d = duel();
    let m = d.env.open_match(&d.alice, ENTRY).expect("open");
    let game = d.env.game_auth.insecure_clone();
    // Not Active yet.
    let err = d
        .env
        .settle_start(&game, m, MatchResult::Opener)
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidStatus));
    d.env.join_match(&d.bob, m).expect("join");
    assert_eq!(d.env.gemas_of(&d.alice, d.a_source), 74_000);

    // Only the registered Game authority settles.
    let alice = d.alice.kp.insecure_clone();
    let err = d
        .env
        .settle_start(&alice, m, MatchResult::Opener)
        .unwrap_err();
    assert_eq!(custom_code(&err), 6000);
    let stranger = Keypair::new();
    d.env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    let err = d
        .env
        .settle_start(&stranger, m, MatchResult::Opener)
        .unwrap_err();
    assert_eq!(custom_code(&err), 6000);

    d.env
        .settle_start(&game, m, MatchResult::Opener)
        .expect("settle starts");
    assert_eq!(d.env.stage_of(m), Stage::Settling);
    // Exactly once: the receipt exists, so neither a second start nor a refund can begin.
    assert!(d.env.settle_start(&game, m, MatchResult::Joiner).is_err());
    assert!(d.env.refund_start(&game, m).is_err());
    d.env.run_chunks(m);
    // Pot 2_000: platform 2% = 40, studio 3% = 60, Alice 1_000 back + 900 won.
    assert_eq!(d.env.counter_amount(d.b_source, CLASS_PLATFORM), 40);
    assert_eq!(d.env.fee_gemas(&d.env.studio), 60);
    assert_eq!(d.env.gemas_of(&d.alice, d.a_source), 74_000 + 1_000);
    assert_eq!(d.env.gemas_of(&d.alice, d.b_source), 900);
    assert_eq!(d.env.total_gemas(&d.alice), 75_000 + 900);
    assert_eq!(d.env.gemas_of(&d.bob, d.b_source), 74_000);
    assert_eq!(d.env.stage_of(m), Stage::Closed);
    // Won Gemas keep their Source: Bob's Debt is untouched and Alice's own Debt is too.
    assert_eq!(d.env.load::<SourceState>(d.b_source).inner.debt(), 75_000);

    // A finished run does nothing more.
    let before = d.env.mstate(m).inner.clone();
    d.env.chunk(m, 12).expect("a finished chunk is a no-op");
    assert_eq!(d.env.mstate(m).inner, before);

    // Per-Source conservation across every basket and the fee counters.
    for src in [d.a_source, d.b_source] {
        let held: u64 = [&d.alice, &d.bob, &d.env.platform, &d.env.studio]
            .iter()
            .map(|p| d.env.gemas_of(p, src))
            .sum();
        let counters: u64 = [CLASS_PLATFORM, CLASS_LEADERBOARD]
            .iter()
            .map(|c| d.env.counter_amount(src, *c))
            .sum();
        assert_eq!(
            held + counters,
            d.env.load::<SourceState>(src).inner.outstanding()
        );
    }

    // Closing returns the rent, and the Match is gone.
    d.env.close_match(m).expect("close");
    assert!(d.env.svm.get_account(&s(d.env.match_key(m))).is_none());
    assert_eq!(d.env.counters(d.alice.account).open_matches, 0);
}

#[test]
fn only_the_settle_authority_settles_and_bad_entries_are_refused() {
    let mut d = duel();
    let err = d.env.open_match(&d.alice, 700).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidEntry));
    let m = d.env.open_match(&d.alice, 500).expect("open");
    d.env.join_match(&d.bob, m).expect("join");
    // Only the Game's settle authority settles its Matches.
    let stranger = Keypair::new();
    d.env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    let payouts = d.env.payout_accounts(m, MatchResult::Opener);
    let err = d
        .env
        .settle(&stranger, m, MatchResult::Opener, payouts)
        .unwrap_err();
    assert_eq!(custom_code(&err), 6000);
}

#[test]
fn entry_draws_own_sourced_gemas_first() {
    let mut d = duel();
    // Bob wins 900 of Alice's Gemas; both kinds sit in his basket now.
    let m = d.env.open_match(&d.alice, ENTRY).expect("open");
    d.env.join_match(&d.bob, m).expect("join");
    let game = d.env.game_auth.insecure_clone();
    d.env
        .settle(&game, m, MatchResult::Joiner, vec![])
        .expect("settle");
    assert_eq!(d.env.gemas_of(&d.bob, d.a_source), 900);
    // The program chooses the lines: his own Gemas first, the won ones stay.
    d.env.open_match(&d.bob, ENTRY).expect("own first");
    assert_eq!(d.env.gemas_of(&d.bob, d.b_source), 75_000 - ENTRY);
    assert_eq!(d.env.gemas_of(&d.bob, d.a_source), 900);
    // Someone with no Gemas cannot enter, whatever they pass.
    let carol = d.env.person();
    let err = d.env.open_match(&carol, ENTRY).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InsufficientGemas));
}

#[test]
fn draw_and_no_show_refund_both_entries_once() {
    let mut d = duel();
    let m = d.env.open_match(&d.alice, ENTRY).expect("open");
    d.env.join_match(&d.bob, m).expect("join");
    let game = d.env.game_auth.insecure_clone();
    let payouts = d.env.payout_accounts(m, MatchResult::Draw);
    d.env
        .settle(&game, m, MatchResult::Draw, payouts)
        .expect("draw");
    assert_eq!(d.env.total_gemas(&d.alice), 75_000);
    assert_eq!(d.env.total_gemas(&d.bob), 75_000);
    assert_eq!(d.env.total_gemas(&d.env.platform), 0);

    // No-show: anybody refunds after the deadline, nobody before.
    let m = d.env.open_match(&d.alice, ENTRY).expect("open");
    d.env.join_match(&d.bob, m).expect("join");
    let stranger = Keypair::new();
    d.env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    let payouts = d.env.payout_accounts(m, MatchResult::Draw);
    let err = d.env.refund(&stranger, m, payouts.clone()).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NotExpired));
    let now = d.env.now();
    d.env.set_time(now + 3_601);
    d.env
        .refund_keep(&stranger, m)
        .expect("refund after timeout");
    assert_eq!(d.env.total_gemas(&d.alice), 75_000);
    assert_eq!(d.env.total_gemas(&d.bob), 75_000);
    assert!(d.env.refund_start(&stranger, m).is_err(), "a second start");
    assert_eq!(d.env.mstate(m).inner.stage(), Stage::Closed);
}

#[test]
fn only_the_game_authority_extends_a_deadline_forward_and_within_the_cap() {
    let mut d = duel();
    let m = d.env.open_match(&d.alice, ENTRY).expect("open");
    d.env.join_match(&d.bob, m).expect("join");
    let extend = |d: &mut Duel, signer: &Keypair, deadline: i64| {
        let i = ix(
            accounts::ExtendMatchDeadline {
                game_authority: a(signer.pubkey()),
                match_state: d.env.match_key(m),
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
    assert_eq!(d.env.mstate(m).inner.deadline, now + 86_400);

    // Nobody may refund at the old deadline any more.
    let stranger = Keypair::new();
    d.env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    d.env.set_time(now + 3_601);
    let payouts = d.env.payout_accounts(m, MatchResult::Draw);
    let err = d.env.refund(&stranger, m, payouts).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NotExpired));
}

#[test]
fn the_game_authority_extends_an_open_match_so_a_queue_entry_can_wait_a_day() {
    let mut d = duel();
    let m = d.env.open_match(&d.alice, ENTRY).expect("open");
    let opened = d.env.mstate(m).inner;
    assert_eq!(opened.stage(), Stage::Open);
    let now = d.env.now();
    assert_eq!(opened.deadline, now + 3_600);
    let game = d.env.game_auth.insecure_clone();
    let alice = d.alice.kp.insecure_clone();
    let extend = |d: &mut Duel, signer: &Keypair, deadline: i64| {
        let i = ix(
            accounts::ExtendMatchDeadline {
                game_authority: a(signer.pubkey()),
                match_state: d.env.match_key(m),
            },
            instruction::ExtendMatchDeadline {
                new_deadline: deadline,
            },
            vec![],
        );
        d.env.send(&[i], signer, &[])
    };
    let err = extend(&mut d, &alice, now + 86_400).unwrap_err();
    assert_eq!(custom_code(&err), 6000);
    extend(&mut d, &game, now + 86_400).expect("extend open");
    assert_eq!(d.env.mstate(m).inner.deadline, now + 86_400);

    // A stranger cannot refund at the old deadline; after 24 h anyone can.
    let stranger = Keypair::new();
    d.env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    d.env.set_time(now + 3_601);
    let payouts = d.env.refund_accounts(m);
    let err = d.env.refund(&stranger, m, payouts.clone()).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NotExpired));
    d.env.set_time(now + 86_401);
    d.env
        .refund(&stranger, m, payouts)
        .expect("refund after 24 h");
}

/// Carol backs Dave (no Position, so no Debt) against Bob.
struct Backing {
    d: Duel,
    carol: Person,
    dave: Person,
    c_source: APk,
}

fn backing_setup() -> Backing {
    let mut d = duel();
    let carol = d.env.person();
    let dave = d.env.person();
    let (_, c_source) = d.env.stake(&carol, 3);
    Backing {
        d,
        carol,
        dave,
        c_source,
    }
}

impl Backing {
    fn request(&mut self, nonce: u64, entry: u64) -> APk {
        let request = request_pda(self.dave.account, nonce);
        let create = ix(
            accounts::CreateRequest {
                player_authority: self.dave.key,
                config: pda(&[CONFIG_SEED]),
                game_record: common::game_record(GAME),
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
                game_record: common::game_record(GAME),
                backer_account: self.carol.account,
                protections: protections_pda(self.carol.account),
                basket: basket_address(&self.carol.account).0,
                spill: spill_address(&self.carol.account).0,
                counters: counters_pda(self.carol.account),
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
            vec![],
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
    ) -> Result<u64, litesvm::types::FailedTransactionMetadata> {
        let env = &mut self.d.env;
        let n = env.counters_next(self.dave.account);
        env.pot_nonce += 1;
        let nonce = env.pot_nonce;
        let pot = ticket_pda(self.carol.account, nonce);
        let remaining = env.books_of(self.carol.account);
        env.open_match_ix(
            &self.dave,
            entry,
            n,
            nonce,
            false,
            0,
            4,
            pot,
            remaining,
            Some((offer, self.carol.account)),
        )
    }

    fn join_backed(
        &mut self,
        offer: APk,
        id: u64,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let env = &mut self.d.env;
        env.pot_nonce += 1;
        let nonce = env.pot_nonce;
        let pot = ticket_pda(self.carol.account, nonce);
        let remaining = env.books_of(self.carol.account);
        env.join_match_ix(
            &self.dave,
            id,
            nonce,
            4,
            pot,
            remaining,
            Some((offer, self.carol.account)),
        )
    }

    /// Gemas of Carol's basket held back for her Offers.
    fn reserved(&self) -> u64 {
        let d = self
            .d
            .env
            .svm
            .get_account(&s(basket_address(&self.carol.account).0))
            .expect("basket")
            .data;
        tesoro_core::ledger::line_store::LineStore::new(&d[DISC..])
            .expect("store")
            .reserved_total()
    }
}

#[test]
fn backing_win_returns_backer_entry_then_splits_and_player_has_no_debt() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 4_000, None);
    assert_eq!(b.reserved(), 500);
    b.accept_public(offer, request);
    let id = b.open_backed(offer, 500).expect("backed entry");
    assert_eq!(b.d.env.gemas_of(&b.carol, b.c_source), 75_000 - 500);
    b.d.env.join_match(&b.d.bob, id).map(|_| ()).expect("join");

    // Backed Player Dave wins: Pot 1_000, fees 20 + 30, surplus 450 => Dave 180, Carol 500 + 270.
    let game = b.d.env.game_auth.insecure_clone();
    let payouts = b.d.env.payout_accounts(id, MatchResult::Opener);
    b.d.env
        .settle(&game, id, MatchResult::Opener, payouts)
        .expect("settle");
    assert_eq!(b.d.env.total_gemas(&b.dave), 180);
    assert_eq!(b.d.env.gemas_of(&b.carol, b.c_source), 75_000 - 500 + 500);
    assert_eq!(b.d.env.gemas_of(&b.carol, b.d.b_source), 270);
    assert_eq!(b.d.env.gemas_of(&b.dave, b.d.b_source), 180);
    // Dave never gained a Position or Debt, and none of Carol's Sources moved to him.
    assert_eq!(b.d.env.gemas_of(&b.dave, b.c_source), 0);
    assert_eq!(b.d.env.load::<SourceState>(b.c_source).inner.debt(), 75_000);
    assert_eq!(
        b.d.env.load::<OfferState>(offer).inner.status,
        tesoro_core::ledger::OfferStatus::Consumed
    );
}

#[test]
fn the_start_record_carries_both_sides_backing_shares_so_history_needs_no_match_state() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 4_000, None);
    b.accept_public(offer, request);
    let id = b.open_backed(offer, 500).expect("backed entry");
    b.d.env.join_match(&b.d.bob, id).map(|_| ()).expect("join");
    let game = b.d.env.game_auth.insecure_clone();
    b.d.env
        .settle_start(&game, id, MatchResult::Opener)
        .expect("start");
    let started: Vec<MatchRunStarted> =
        b.d.env
            .start_events
            .iter()
            .filter_map(|e| decode_event(e))
            .collect();
    assert_eq!(started.len(), 1);
    assert_eq!((started[0].a_share_bps, started[0].b_share_bps), (4_000, 0));
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
    let id = b.open_backed(offer, 500).expect("backed entry");
    b.d.env.join_match(&b.d.bob, id).expect("join");
    let game = b.d.env.game_auth.insecure_clone();
    let payouts = b.d.env.payout_accounts(id, MatchResult::Joiner);
    b.d.env
        .settle(&game, id, MatchResult::Joiner, payouts)
        .expect("settle");
    // Carol lost exactly 500 Gemas (75_000 -> 74_500); Bob got them minus the fees.
    assert_eq!(b.d.env.total_gemas(&b.carol), 74_500);
    assert_eq!(b.d.env.total_gemas(&b.dave), 0);
    assert_eq!(b.d.env.gemas_of(&b.d.bob, b.c_source), 450);
    assert_eq!(b.d.env.load::<SourceState>(b.c_source).inner.debt(), 75_000);
}

#[test]
fn backing_cannot_be_revoked_after_start_and_backed_player_cannot_move_backer_gemas() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    b.accept_public(offer, request);
    // Dave cannot enter a plain Match with Carol's Gemas.
    let err = b.d.env.open_match(&b.dave, 500).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InsufficientGemas));
    let id = b.open_backed(offer, 500).expect("backed entry");
    // The Offer is Consumed once the Match started: it cannot be cancelled, reused or expired.
    let cancel = ix(
        accounts::CancelOffer {
            backer_authority: b.carol.key,
            backer_account: b.carol.account,
            basket: basket_address(&b.carol.account).0,
            spill: spill_address(&b.carol.account).0,
            counters: counters_pda(b.carol.account),
            offer,
            request: None,
        },
        instruction::CancelOffer {},
        vec![],
    );
    let carol = b.carol.kp.insecure_clone();
    let err = b.d.env.send(&[cancel], &carol, &[]).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidStatus));
    let err = b.open_backed(offer, 500).unwrap_err();
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
    let m1 = d.env.open_match(&d.alice, 500).unwrap();
    let m2 = d.env.open_match(&d.alice, 500).unwrap();
    // The third entry of the period is over Alice's 1,000: refused, and no Gemas leave her.
    let free = d.env.total_gemas(&d.alice);
    let err = d.env.open_match(&d.alice, 500).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
    assert_eq!(d.env.total_gemas(&d.alice), free);
    assert_eq!(d.env.entry_limit(&d.alice).window_used, 1_000);
    // Bob's 500 covers one join, not two.
    d.env.join_match(&d.bob, m1).unwrap();
    let err = d.env.join_match(&d.bob, m2).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
    assert_eq!(d.env.entry_limit(&d.bob).window_used, 500);
    // A new period (7 days after the first entry) opens room again.
    let now = d.env.now();
    d.env.set_time(now + 7 * DAY - 1);
    let err = d.env.open_match(&d.bob, 500).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
    d.env.set_time(now + 7 * DAY);
    d.env.open_match(&d.bob, 500).unwrap();
    assert_eq!(d.env.entry_limit(&d.bob).window_used, 500);
}

#[test]
fn a_raised_entry_limit_waits_a_day_and_a_lowered_one_applies_at_once() {
    let mut d = duel();
    d.env.set_entry_limit(&d.alice, 500).unwrap();
    d.env.open_match(&d.alice, 500).unwrap();
    d.env.set_entry_limit(&d.alice, 2_500).unwrap();
    let l = d.env.entry_limit(&d.alice);
    assert_eq!((l.gemas, l.pending_gemas), (500, 2_500));
    let err = d.env.open_match(&d.alice, 500).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
    let now = d.env.now();
    d.env.set_time(now + DAY);
    d.env.open_match(&d.alice, 1_000).unwrap();
    assert_eq!(d.env.entry_limit(&d.alice).gemas, 2_500);
    // Lowering below what is used applies at once.
    d.env.set_entry_limit(&d.alice, 500).unwrap();
    let err = d.env.open_match(&d.alice, 500).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
}

#[test]
fn removing_the_entry_limit_lifts_it_after_a_day() {
    let mut d = duel();
    d.env.set_entry_limit(&d.alice, 500).unwrap();
    d.env.set_entry_limit(&d.alice, 0).unwrap();
    let err = d.env.open_match(&d.alice, 1_000).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::EntryLimitReached));
    let now = d.env.now();
    d.env.set_time(now + DAY);
    d.env.open_match(&d.alice, 1_000).unwrap();
    d.env.open_match(&d.alice, 2_500).unwrap();
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
            game_record: common::game_record(GAME),
            backer_account: b.carol.account,
            protections: protections_pda(b.carol.account),
            basket: basket_address(&b.carol.account).0,
            spill: spill_address(&b.carol.account).0,
            counters: counters_pda(b.carol.account),
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
        vec![],
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
    b.open_backed(offer, 500).expect("backed");
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
                basket: basket_address(&b.carol.account).0,
                spill: spill_address(&b.carol.account).0,
                counters: counters_pda(b.carol.account),
                offer,
                request: None,
                backer_protections: None,
            },
            instruction::ExpireOffer {},
            vec![],
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
    // Carol holds 3,000 Gemas only (4 SOL of principal), and reserves 2,500 of them for an Offer.
    b.carol = b.d.env.person();
    b.d.env.stake_principal(&b.carol, 9, 4 * SOL);
    assert_eq!(b.d.env.total_gemas(&b.carol), 3_000);
    b.offer(1, 2_500, 5_000, None);
    assert_eq!(b.reserved(), 2_500);
    let carol = Person {
        kp: b.carol.kp.insecure_clone(),
        key: b.carol.key,
        account: b.carol.account,
    };
    // Only 500 are free: a bigger entry is refused, one that fits goes through, and the
    // reservation is untouched either way.
    let err = b.d.env.open_match(&carol, 1_000).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InsufficientGemas));
    b.d.env
        .open_match(&carol, 500)
        .expect("the free part enters");
    assert_eq!(b.reserved(), 2_500);
    let err = b.d.env.open_match(&carol, 500).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InsufficientGemas));
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
    env.yield_to(&oracle, position, Some(source), 1, 5 * SOL / 2)
        .expect("yield");

    let redeem = env.redeem_ix_reported(&alice, position, source, SIDE_OWN, 100);
    let err = env.send(&[redeem], &alice.kp, &[]).unwrap_err();
    assert_eq!(custom_code(&err), ERR_BRIDGED_SOURCE);
    assert_eq!(
        gemas_in(&env.svm, alice.account, source),
        75_000,
        "nothing burned"
    );

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
    let bridge_line = env.line(source, SIDE_OWN);
    let bridge_books = book_metas(&env.svm, source);
    let via_bridge = |signer: &Keypair| {
        ix(
            accounts::RedeemFromSource {
                holder_authority: alice.key,
                source_signer: a(signer.pubkey()),
                source_authority: pda(&[SOURCE_AUTHORITY_SEED, &[1]]),
                holder_account: alice.account,
                basket: basket_address(&alice.account).0,
                spill: spill_address(&alice.account).0,
                position,
                source,
            },
            instruction::RedeemFromSource {
                line: bridge_line,
                amount: 100,
            },
            bridge_books.clone(),
        )
    };
    // Alice cannot stand in for the bridge.
    let err = env
        .send(&[via_bridge(&alice.kp)], &alice.kp, &[])
        .unwrap_err();
    assert_eq!(custom_code(&err), 6000);
    env.send(&[via_bridge(&bridge)], &alice.kp, &[&bridge])
        .expect("redeem through the bridge authority");
    assert_eq!(gemas_in(&env.svm, alice.account, source), 74_900);
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
                            basket: basket_address(&b.carol.account).0,
                            spill: spill_address(&b.carol.account).0,
                            counters: counters_pda(b.carol.account),
                            offer,
                            request,
                            backer_protections: None,
                        },
                        instruction::ExpireOffer {},
                        vec![],
                    ),
                    b.d.env.admin.insecure_clone(),
                )
            } else {
                (
                    ix(
                        accounts::CancelOffer {
                            backer_authority: b.carol.key,
                            backer_account: b.carol.account,
                            basket: basket_address(&b.carol.account).0,
                            spill: spill_address(&b.carol.account).0,
                            counters: counters_pda(b.carol.account),
                            offer,
                            request,
                        },
                        instruction::CancelOffer {},
                        vec![],
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

// --- Entry fragmentation: up to MAX_ENTRY_SOURCES lines per entry -----------------------------

/// `n` Positions for `p`, each worth `gemas_each` Gemas of its own Source, returned as Sources in
/// ascending order. `first_id` keeps Position ids unique across people.
#[allow(dead_code)]
fn fragment(env: &mut Env, p: &Person, first_id: u8, n: u8, gemas_each: u64) -> Vec<APk> {
    // 750 Gemas per SOL of principal (see `stake_principal`).
    let principal = gemas_each * SOL / 750;
    let mut sources: Vec<APk> = (0..n)
        .map(|i| {
            let (_, source) = env.stake_principal(p, first_id + i, principal);
            assert_eq!(env.gemas_of(p, source), gemas_each);
            source
        })
        .collect();
    sources.sort_by_key(|source| source.to_bytes());
    sources
}

// --- Leaderboard ------------------------------------------------------------------------------

fn pool_pda() -> APk {
    account_pda(pda(&[LEADERBOARD_SEED]))
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
}

#[test]
fn leaderboard_fee_fills_the_pool() {
    use tesoro_core::ledger::SEASON_EPOCH;
    let mut d = duel();
    d.env.enable_leaderboard(100);
    let cfg = d.env.load::<Config>(pda(&[CONFIG_SEED]));
    assert_eq!((cfg.leaderboard_bps, cfg.pool_account), (100, pool_pda()));
    assert_eq!(cfg.leaderboard_since, d.env.now());
    let game = d.env.game_auth.insecure_clone();
    d.env.set_time(SEASON_EPOCH + 3_600);

    // Alice wins 1,000: pot 2,000, the Leaderboard Fee takes 1% = 20 of Bob's own Source, into
    // that Source's Leaderboard counter.
    let m1 = d.env.open_match(&d.alice, ENTRY).expect("open");
    d.env.join_match(&d.bob, m1).expect("join");
    d.env
        .settle_start(&game, m1, MatchResult::Opener)
        .expect("settle starts");
    let won: Vec<MatchWon> = d
        .env
        .start_events
        .iter()
        .filter_map(|e| decode_event::<MatchWon>(e))
        .collect();
    assert_eq!(won.len(), 1, "one MatchWon, written by event-CPI");
    assert_eq!(won[0].player, d.alice.account);
    assert_eq!(won[0].loser, d.bob.account);
    assert_eq!(won[0].pool_fee, 20);
    d.env.run_chunks(m1);
    assert_eq!(d.env.counter_amount(d.b_source, CLASS_PLATFORM), 40);
    assert_eq!(d.env.fee_gemas(&d.env.studio), 60);
    assert_eq!(d.env.counter_amount(d.b_source, CLASS_LEADERBOARD), 20);
    // Alice nets 880 on top of her entry (1,000 pot share less 4 + 6 + 2 percent of the pot).
    assert_eq!(d.env.total_gemas(&d.alice), 75_000 + 880);

    // Bob wins 500 against Alice: Alice's own Source pays 10 into its counter.
    let m2 = d.env.open_match(&d.bob, 500).expect("open");
    d.env.join_match(&d.alice, m2).expect("join");
    d.env
        .settle(&game, m2, MatchResult::Opener, vec![])
        .expect("settle");
    assert_eq!(d.env.counter_amount(d.a_source, CLASS_LEADERBOARD), 10);

    // A draw never pays the Leaderboard.
    let m3 = d.env.open_match(&d.alice, 500).expect("open");
    d.env.join_match(&d.bob, m3).expect("join");
    d.env
        .settle(&game, m3, MatchResult::Draw, vec![])
        .expect("draw");
    assert_eq!(d.env.counter_amount(d.a_source, CLASS_LEADERBOARD), 10);
    assert_eq!(d.env.counter_amount(d.b_source, CLASS_LEADERBOARD), 20);
}

// --- Break and Self-Exclusion ---------------------------------------------------------------------

#[test]
fn a_break_stops_opening_and_joining_matches_until_it_ends() {
    let mut d = duel();
    let open = d.env.open_match(&d.bob, 500).unwrap();
    d.env.set_break(&d.alice, 3).unwrap();
    let now = d.env.now();
    assert_eq!(d.env.protections(&d.alice).break_until, now + 3 * DAY);
    let free = d.env.total_gemas(&d.alice);
    let err = d.env.open_match(&d.alice, 500).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::OnBreak));
    let err = d.env.join_match(&d.alice, open).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::OnBreak));
    assert_eq!(d.env.total_gemas(&d.alice), free);
    d.env.set_time(now + 3 * DAY);
    let later = d.env.open_match(&d.bob, 500).unwrap();
    d.env.join_match(&d.alice, later).unwrap();
    d.env.open_match(&d.alice, 500).unwrap();
}

#[test]
fn a_self_exclusion_stops_matches_too_and_lasts_months() {
    let mut d = duel();
    d.env.set_self_exclusion(&d.alice, 6).unwrap();
    let err = d.env.open_match(&d.alice, 500).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::SelfExcluded));
    let now = d.env.now();
    d.env.set_time(now + 6 * 30 * DAY - 1);
    let err = d.env.open_match(&d.alice, 500).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::SelfExcluded));
    d.env.set_time(now + 6 * 30 * DAY);
    d.env.open_match(&d.alice, 500).unwrap();
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
    assert!(d.env.protections(&d.alice).self_exclusion_until > 0);
}

#[test]
fn a_break_keeps_the_entry_limit_and_the_limit_keeps_counting() {
    let mut d = duel();
    d.env.set_entry_limit(&d.alice, 1_000).unwrap();
    d.env.open_match(&d.alice, 500).unwrap();
    d.env.set_break(&d.alice, 1).unwrap();
    let l = d.env.entry_limit(&d.alice);
    assert_eq!((l.gemas, l.window_used), (1_000, 500));
}

#[test]
fn matches_already_paired_play_out_during_a_break() {
    let mut d = duel();
    let id = d.env.open_match(&d.alice, 500).unwrap();
    d.env.join_match(&d.bob, id).unwrap();
    d.env.set_break(&d.alice, 7).unwrap();
    d.env.set_self_exclusion(&d.bob, 6).unwrap();
    let game = d.env.game_auth.insecure_clone();
    d.env
        .settle_keep(&game, id, MatchResult::Opener)
        .expect("settles");
    assert_eq!(d.env.mstate(id).inner.stage(), Stage::Closed);
}

#[test]
fn a_paired_match_refunds_during_a_break_but_only_by_the_usual_rules() {
    let mut d = duel();
    let id = d.env.open_match(&d.alice, 500).unwrap();
    d.env.join_match(&d.bob, id).unwrap();
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
    let id = d.env.open_match(&d.alice, 500).unwrap();
    let before = d.env.total_gemas(&d.alice);
    d.env.set_break(&d.alice, 2).unwrap();
    let err = d.env.join_match(&d.bob, id).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::OnBreak));
    // A stranger refunds the unpaired Match at once because its opener is away.
    let stranger = d.env.admin.insecure_clone();
    d.env.refund_keep(&stranger, id).expect("refund at once");
    assert_eq!(d.env.total_gemas(&d.alice), before + 500);
    assert_eq!(d.env.mstate(id).inner.stage(), Stage::Closed);
}

#[test]
fn a_stranger_cannot_refund_an_unpaired_match_of_a_player_who_is_not_away() {
    let mut d = duel();
    let id = d.env.open_match(&d.alice, 500).unwrap();
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
                game_record: common::game_record(GAME),
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
        let err = b.open_backed(offer, 500).unwrap_err();
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
    let id = b.d.env.open_match(&b.d.bob, 500).unwrap();
    let bob = Person {
        kp: b.d.bob.kp.insecure_clone(),
        key: b.d.bob.key,
        account: b.d.bob.account,
    };
    b.d.env.set_break(&bob, 1).unwrap();
    let err = b.join_backed(offer, id).unwrap_err();
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
            game_record: common::game_record(GAME),
            backer_account: b.carol.account,
            protections: protections_pda(b.carol.account),
            basket: basket_address(&b.carol.account).0,
            spill: spill_address(&b.carol.account).0,
            counters: counters_pda(b.carol.account),
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
        vec![],
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
                basket: basket_address(&b.carol.account).0,
                spill: spill_address(&b.carol.account).0,
                counters: counters_pda(b.carol.account),
                offer,
                request: None,
                backer_protections,
            },
            instruction::ExpireOffer {},
            vec![],
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
    assert!(!err.err.to_string().is_empty());
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
            basket: basket_address(&b.carol.account).0,
            spill: spill_address(&b.carol.account).0,
            counters: counters_pda(b.carol.account),
            offer,
            request: Some(request),
            backer_protections: Some(protections_pda(b.carol.account)),
        },
        instruction::ExpireOffer {},
        vec![],
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
    let redeem = d
        .env
        .redeem_ix_reported(&d.alice, d.a_position, d.a_source, SIDE_OWN, 37_500);
    let alice = d.alice.kp.insecure_clone();
    d.env.send(&[redeem], &alice, &[]).expect("redeem");
    assert_eq!(gemas_in(&d.env.svm, d.alice.account, d.a_source), 37_500);
    d.env
        .yield_to(&oracle, d.a_position, Some(d.a_source), 2, 6 * SOL)
        .expect("more yield");
    let unlock = d.env.unlock_ix_reported(&d.alice, d.a_position);
    d.env.send(&[unlock], &alice, &[]).expect("unlock");
}

#[test]
fn return_own_still_works_under_a_self_exclusion() {
    let mut d = duel();
    d.env.set_self_exclusion(&d.alice, 6).unwrap();
    let ret = d
        .env
        .return_own_ix_reported(&d.alice, d.a_position, d.a_source, 1_000);
    let alice = d.alice.kp.insecure_clone();
    d.env.send(&[ret], &alice, &[]).expect("return own gemas");
    assert_eq!(d.env.debt_of(d.a_source), 74_000);
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

// --- Entry sizes ------------------------------------------------------------------------------

impl Env {
    fn set_entry_sizes(
        &mut self,
        signer: &Keypair,
        sizes: &[u64],
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let set = ix(
            accounts::SetEntrySizes {
                admin: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetEntrySizes {
                sizes: sizes.to_vec(),
            },
            vec![],
        );
        self.send(&[set], signer, &[])
    }
}

#[test]
fn entry_sizes_default_to_the_ladder_even_on_a_config_that_predates_the_field() {
    let mut d = duel();
    // The layout before the Leaderboard fields has no room for the setting: it reads as zero.
    let config = s(pda(&[CONFIG_SEED]));
    let mut acct = d.env.svm.get_account(&config).expect("config");
    acct.data.truncate(Config::LEGACY_SPACE);
    d.env.svm.set_account(config, acct).expect("legacy config");
    assert_eq!(
        d.env.load::<Config>(pda(&[CONFIG_SEED])).entries(),
        vec![500, 1_000, 2_500]
    );
    let err = d.env.open_match(&d.alice, 100).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidEntry));
    d.env
        .open_match(&d.alice, 500)
        .expect("500 is a default size");
}

#[test]
fn admin_sets_entry_sizes_and_matches_outside_them_are_refused() {
    let mut d = duel();
    let admin = d.env.admin.insecure_clone();
    // Only the admin sets them.
    let outsider = d.alice.kp.insecure_clone();
    let err = d.env.set_entry_sizes(&outsider, &[100, 500]).unwrap_err();
    assert_eq!(
        custom_code(&err),
        u32::from(tesoro_core::error::TesoroError::Unauthorized)
    );
    // Not a multiple of 100, zero, duplicated, empty or more than four: refused.
    for bad in [
        vec![150],
        vec![0, 100],
        vec![100, 100],
        vec![],
        vec![100, 200, 300, 400, 500],
    ] {
        let err = d.env.set_entry_sizes(&admin, &bad).unwrap_err();
        assert_eq!(custom_code(&err), core(CoreError::InvalidEntry), "{bad:?}");
    }
    d.env
        .set_entry_sizes(&admin, &[100, 500, 1_000])
        .expect("mainnet sizes");
    assert_eq!(
        d.env.load::<Config>(pda(&[CONFIG_SEED])).entries(),
        vec![100, 500, 1_000]
    );
    // 100 now opens and 2,500 (a default size) no longer does.
    let err = d.env.open_match(&d.alice, 2_500).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidEntry));
    let m = d.env.open_match(&d.alice, 100).expect("100 is allowed");
    d.env.join_match(&d.bob, m).expect("join");
    d.env.open_match(&d.alice, 500).expect("500 stays allowed");
    // Setting them again replaces the list.
    d.env
        .set_entry_sizes(&admin, &[500, 1_000, 2_500])
        .expect("back");
    let err = d.env.open_match(&d.alice, 100).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidEntry));
}

// --- Oracle lock (audit 2026-10-16, C-1) --------------------------------------------------------

impl Env {
    fn set_oracle_lock(
        &mut self,
        signer: &Keypair,
        locked: bool,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let set = ix(
            accounts::SetOracleLock {
                admin: a(signer.pubkey()),
                config: pda(&[CONFIG_SEED]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::SetOracleLock { locked },
            vec![],
        );
        self.send(&[set], signer, &[])
    }

    fn oracle_open(
        &mut self,
        p: &Person,
        chain: SourceChain,
        id: u8,
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let chain_byte = match chain {
            SourceChain::Solana => 0u8,
            SourceChain::Ethereum => 1,
            SourceChain::HyperEvm => 2,
        };
        let open = ix(
            accounts::OpenPosition {
                oracle: a(self.oracle.pubkey()),
                config: pda(&[CONFIG_SEED]),
                owner_account: p.account,
                position: pda(&[POSITION_SEED, &[chain_byte], &[id; 32]]),
                system_program: anchor_lang::system_program::ID,
            },
            instruction::OpenPosition {
                source_chain: chain,
                position_id: [id; 32],
                source_asset: APk::new_unique(),
                decimals: 9,
                principal: 100 * SOL,
                rate_bps: 1_000,
            },
            vec![],
        );
        let oracle = self.oracle.insecure_clone();
        self.send(&[open], &oracle, &[])
    }
}

/// A stolen oracle key could register a Position that holds nothing, price an Advance against it
/// and mint Gemas nobody backs. Once the admin locks the oracle (mainnet), it can do none of it.
#[test]
fn a_locked_oracle_cannot_register_positions_report_yield_or_price_advances() {
    let mut env = Env::new();
    let p = env.person();
    let admin = env.admin.insecure_clone();
    let outsider = env.person();

    // Only the admin can lock.
    let err = env.set_oracle_lock(&outsider.kp, true).unwrap_err();
    assert_eq!(
        custom_code(&err),
        anchor_code(tesoro_core::error::TesoroError::Unauthorized)
    );

    // A Position that exists before the lock, with no Advance yet.
    env.oracle_open(&p, SourceChain::Solana, 1).expect("open");
    let position = position_pda(1);
    env.set_oracle_lock(&admin, true).expect("lock");

    let locked = anchor_code(tesoro_core::error::TesoroError::OracleLocked);
    let err = env.oracle_open(&p, SourceChain::Solana, 2).unwrap_err();
    assert_eq!(custom_code(&err), locked, "Solana Position");
    let err = env.oracle_open(&p, SourceChain::Ethereum, 3).unwrap_err();
    assert_eq!(custom_code(&err), locked, "Ethereum Position");
    let err = env
        .take_advance(&p, position, 0, 6, 150_000_000)
        .unwrap_err();
    assert_eq!(custom_code(&err), locked, "oracle-priced Advance");
    let oracle = env.oracle.insecure_clone();
    let err = env.yield_to(&oracle, position, None, 1, 1).unwrap_err();
    assert_eq!(custom_code(&err), locked, "reported yield");

    // The admin can unlock: test mode keeps working.
    env.set_oracle_lock(&admin, false).expect("unlock");
    env.take_advance(&p, position, 0, 6, 150_000_000)
        .expect("advance once unlocked");
}

// ---- Listing, upgrades and the pair limit ----

/// An event written by event-CPI, from the inner instructions of a transaction.
fn decode_event<T: anchor_lang::Event>(data: &[u8]) -> Option<T> {
    // Anchor's EVENT_IX_TAG_LE, then the event's discriminator, then its Borsh bytes
    const TAG: [u8; 8] = [228, 69, 165, 46, 81, 203, 154, 29];
    if data.len() < 16 || data[..8] != TAG || data[8..16] != *T::DISCRIMINATOR {
        return None;
    }
    T::try_from_slice(&data[16..]).ok()
}

/// The Points the last started settlement awarded (its one `MatchWon`).
fn won_points(env: &Env) -> u64 {
    let won: Vec<MatchWon> = env
        .start_events
        .iter()
        .filter_map(|d| decode_event::<MatchWon>(d))
        .collect();
    assert_eq!(won.len(), 1, "one MatchWon");
    won[0].points
}

fn play_a_win(d: &mut Duel, entry: u64) -> u64 {
    let game = d.env.game_auth.insecure_clone();
    let m = d.env.open_match(&d.alice, entry).expect("open");
    d.env.join_match(&d.bob, m).expect("join");
    d.env
        .settle_keep(&game, m, MatchResult::Opener)
        .expect("settle");
    m
}

#[test]
fn a_win_on_a_listed_game_earns_points() {
    let mut d = duel();
    let m = play_a_win(&mut d, ENTRY);
    let st = d.env.mstate(m);
    assert!(st.listed);
    assert_eq!(st.inner.deploy_slot, GAME_SLOT);
    assert_eq!(
        won_points(&d.env),
        tesoro_core::ledger::points_for_win(ENTRY)
    );
}

#[test]
fn upgrading_a_game_unlists_it_until_the_admin_approves_the_new_slot() {
    let mut d = duel();
    // The Game's authority upgrades the program: the ProgramData slot moves.
    common::set_program_data(
        &mut d.env.svm,
        s(GAME),
        Some(d.env.game_ctl.pubkey()),
        GAME_SLOT + 7,
    );
    let m = play_a_win(&mut d, ENTRY);
    let st = d.env.mstate(m);
    assert!(!st.listed, "an upgraded Game counts as unlisted");
    assert_eq!(st.inner.deploy_slot, GAME_SLOT + 7);
    assert_eq!(won_points(&d.env), 0, "no Points while unlisted");
    // Re-approval applies to Matches opened after it, not to the one already open.
    let admin = d.env.admin.insecure_clone();
    let list = d.env.list_game_ix(LISTED_FOR_EVER);
    d.env.send(&[list], &admin, &[]).expect("approve");
    let m2 = play_a_win(&mut d, ENTRY);
    assert!(d.env.mstate(m2).listed);
    assert!(won_points(&d.env) > 0);
    assert!(!d.env.mstate(m).listed);
}

#[test]
fn a_listing_that_ran_out_or_was_withdrawn_earns_no_points() {
    let mut d = duel();
    let now = d.env.now();
    let admin = d.env.admin.insecure_clone();
    let list = d.env.list_game_ix(now + 100);
    d.env.send(&[list], &admin, &[]).expect("list");
    d.env.set_time(now + 101);
    let m = play_a_win(&mut d, ENTRY);
    assert!(!d.env.mstate(m).listed);
    let list = d.env.list_game_ix(0);
    d.env.send(&[list], &admin, &[]).expect("unlist");
    let m = play_a_win(&mut d, ENTRY);
    assert!(!d.env.mstate(m).listed);
}

#[test]
fn only_the_admin_lists_a_game() {
    let mut d = duel();
    let stranger = Keypair::new();
    d.env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    let list = ix(
        accounts::ListGame {
            admin: a(stranger.pubkey()),
            config: pda(&[CONFIG_SEED]),
            game_record: common::game_record(GAME),
            game_program: GAME,
            program_data: a(common::program_data_address(s(GAME))),
        },
        instruction::ListGame {
            listed_until: LISTED_FOR_EVER,
            approved_hash: common::code_hash(&d.env.svm, s(GAME)),
        },
        vec![],
    );
    let err = d.env.send(&[list], &stranger, &[]).unwrap_err();
    assert_eq!(custom_code(&err), 6000);
    // Not even the Game's own authority can list itself.
    let ctl = d.env.game_ctl.insecure_clone();
    let list = ix(
        accounts::ListGame {
            admin: a(ctl.pubkey()),
            config: pda(&[CONFIG_SEED]),
            game_record: common::game_record(GAME),
            game_program: GAME,
            program_data: a(common::program_data_address(s(GAME))),
        },
        instruction::ListGame {
            listed_until: LISTED_FOR_EVER,
            approved_hash: common::code_hash(&d.env.svm, s(GAME)),
        },
        vec![],
    );
    let err = d.env.send(&[list], &ctl, &[]).unwrap_err();
    assert_eq!(custom_code(&err), 6000);
}

#[test]
fn a_backed_match_on_an_unlisted_game_is_refused_at_open() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 4_000, None);
    b.accept_public(offer, request);
    // The Game is upgraded after the Offer was made.
    common::set_program_data(
        &mut b.d.env.svm,
        s(GAME),
        Some(b.d.env.game_ctl.pubkey()),
        GAME_SLOT + 1,
    );
    let err = b.open_backed(offer, 500).unwrap_err();
    assert_eq!(
        custom_code(&err),
        anchor_code(tesoro_core::error::TesoroError::GameNotListed)
    );
    assert_eq!(b.reserved(), 500, "the Offer's Gemas stay reserved");
    // The admin approves the new slot: the same Offer opens.
    let admin = b.d.env.admin.insecure_clone();
    let list = b.d.env.list_game_ix(LISTED_FOR_EVER);
    b.d.env.send(&[list], &admin, &[]).expect("approve");
    b.open_backed(offer, 500).expect("opens once listed");
}

#[test]
fn an_unregistered_game_cannot_open_a_match_or_a_request() {
    let mut d = duel();
    let other = APk::new_unique();
    let alice = d.alice.kp.insecure_clone();
    let n = d.env.counters_next(d.alice.account);
    let pot = ticket_pda(d.alice.account, 77);
    let err = d
        .env
        .open_match_game(
            &Person {
                kp: alice.insecure_clone(),
                key: d.alice.key,
                account: d.alice.account,
            },
            ENTRY,
            (n, 77, false, 0, 4),
            pot,
            vec![],
            None,
            Some((other, a(common::program_data_address(s(other))))),
        )
        .unwrap_err();
    assert_eq!(
        custom_code(&err),
        3012,
        "no Game record: AccountNotInitialized"
    );
}

#[test]
fn a_pair_cannot_start_more_than_twenty_matches_a_day() {
    let mut d = duel();
    let game = d.env.game_auth.insecure_clone();
    for _ in 0..MAX_PAIR_MATCHES {
        let m = d.env.open_match(&d.alice, 500).expect("open");
        d.env.join_match(&d.bob, m).expect("join");
        // a Draw closes it, so the open-Match cap is never the thing being tested
        d.env
            .settle(&game, m, MatchResult::Draw, vec![])
            .expect("draw");
    }
    let m = d.env.open_match(&d.alice, 500).expect("open");
    let err = d.env.join_match(&d.bob, m).unwrap_err();
    assert_eq!(
        custom_code(&err),
        anchor_code(tesoro_core::error::TesoroError::PairLimitReached)
    );
    // The other direction is its own pair; a new day resets the count.
    let m2 = d.env.open_match(&d.bob, 500).expect("open");
    d.env.join_match(&d.alice, m2).expect("other direction");
    let now = d.env.now();
    d.env.set_time(now + PAIR_WINDOW_SECS + 1);
    let m3 = d.env.open_match(&d.alice, 500).expect("open next day");
    d.env.join_match(&d.bob, m3).expect("next day");
    let pair = d
        .env
        .load::<PairState>(pair_pda(d.alice.account, d.bob.account));
    assert_eq!(pair.count, 1);
}

#[test]
fn a_backed_join_is_refused_once_the_game_was_upgraded_after_the_match_opened() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    b.accept_public(offer, request);
    let id = b.d.env.open_match(&b.d.bob, 500).unwrap();
    assert!(b.d.env.mstate(id).listed);
    // The studio ships different code while the Match waits for an opponent.
    common::set_program_code(
        &mut b.d.env.svm,
        s(GAME),
        Some(b.d.env.game_ctl.pubkey()),
        GAME_SLOT + 3,
        &[0xCD; 64],
    );
    let err = b.join_backed(offer, id).unwrap_err();
    assert_eq!(
        custom_code(&err),
        anchor_code(tesoro_core::error::TesoroError::GameNotListed)
    );
    assert_eq!(b.reserved(), 500, "the Backer's Gemas stay reserved");
    // Even after the admin approves the new build, this Match was opened for the old one.
    let admin = b.d.env.admin.insecure_clone();
    let list = b.d.env.list_game_ix(LISTED_FOR_EVER);
    b.d.env.send(&[list], &admin, &[]).expect("approve");
    let err = b.join_backed(offer, id).unwrap_err();
    assert_eq!(
        custom_code(&err),
        anchor_code(tesoro_core::error::TesoroError::GameNotListed)
    );
}

#[test]
fn a_stranger_extending_the_program_cannot_block_a_pending_backed_join() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    b.accept_public(offer, request);
    let id = b.d.env.open_match(&b.d.bob, 500).unwrap();
    let stranger = Keypair::new();
    b.d.env
        .svm
        .airdrop(&stranger.pubkey(), SOL)
        .expect("airdrop");
    common::extend_program(&mut b.d.env.svm, s(GAME), GAME_SLOT + 4, 10_240);
    let err = b.join_backed(offer, id).unwrap_err();
    assert_eq!(
        custom_code(&err),
        anchor_code(tesoro_core::error::TesoroError::GameNotListed),
        "unlisted until someone refreshes"
    );
    refresh(&mut b.d.env, &stranger).expect("anyone refreshes");
    b.join_backed(offer, id)
        .expect("the same build counts as the same Game");
    assert_eq!(b.d.env.mstate(id).inner.stage(), Stage::Active);
}

#[test]
fn relisting_the_same_build_keeps_a_pending_backed_join_alive() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    b.accept_public(offer, request);
    let id = b.d.env.open_match(&b.d.bob, 500).unwrap();
    common::extend_program(&mut b.d.env.svm, s(GAME), GAME_SLOT + 4, 10_240);
    let admin = b.d.env.admin.insecure_clone();
    let list = b.d.env.list_game_ix(LISTED_FOR_EVER);
    b.d.env
        .send(&[list], &admin, &[])
        .expect("relist same bytes");
    b.join_backed(offer, id).expect("same hash, same epoch");
}

#[test]
fn a_backed_join_works_while_the_game_is_unchanged() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    b.accept_public(offer, request);
    let id = b.d.env.open_match(&b.d.bob, 500).unwrap();
    b.join_backed(offer, id).expect("join");
    assert_eq!(b.d.env.mstate(id).inner.stage(), Stage::Active);
}

#[test]
fn junk_program_accounts_cannot_strip_a_listed_match_of_its_points() {
    let mut d = duel();
    let junk = APk::new_unique();
    let open = |d: &mut Duel, program_data: APk| {
        let n = d.env.counters_next(d.alice.account);
        d.env.pot_nonce += 1;
        let nonce = d.env.pot_nonce;
        let pot = ticket_pda(d.alice.account, nonce);
        let remaining = d.env.books_of(d.alice.account);
        let alice = Person {
            kp: d.alice.kp.insecure_clone(),
            key: d.alice.key,
            account: d.alice.account,
        };
        d.env.open_match_game(
            &alice,
            ENTRY,
            (n, nonce, false, 0, 4),
            pot,
            remaining,
            None,
            Some((GAME, program_data)),
        )
    };
    // A real account that is not the Game's ProgramData, and an account that does not exist.
    for bogus in [junk, d.alice.account, a(d.env.admin.pubkey())] {
        let err = open(&mut d, bogus).unwrap_err();
        assert_eq!(
            custom_code(&err),
            anchor_code(tesoro_core::error::TesoroError::GameProofInvalid)
        );
    }
    // Once the admin has unlisted the Game, the same call opens an unlisted Match.
    let admin = d.env.admin.insecure_clone();
    let unlist = d.env.list_game_ix(0);
    d.env.send(&[unlist], &admin, &[]).expect("unlist");
    let id = open(&mut d, junk).expect("opens, unlisted");
    assert!(!d.env.mstate(id).listed);
}

#[test]
fn a_pair_counter_returns_its_rent_to_the_joiner_after_the_window() {
    let mut d = duel();
    let m = d.env.open_match(&d.alice, 500).expect("open");
    d.env.join_match(&d.bob, m).expect("join");
    let pair = pair_pda(d.alice.account, d.bob.account);
    let pair_rent = d.env.svm.get_balance(&s(pair)).expect("pair counter");
    let close = |d: &mut Duel, caller: &Keypair| {
        let i = ix(
            accounts::ClosePair {
                caller: a(caller.pubkey()),
                pair,
                payer: d.bob.key,
            },
            instruction::ClosePair {
                opener: d.alice.account,
                joiner: d.bob.account,
            },
            vec![],
        );
        d.env.send(&[i], caller, &[])
    };
    let stranger = Keypair::new();
    d.env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    let err = close(&mut d, &stranger).unwrap_err();
    assert_eq!(
        custom_code(&err),
        anchor_code(tesoro_core::error::TesoroError::PairWindowOpen)
    );
    let now = d.env.now();
    d.env.set_time(now + PAIR_WINDOW_SECS);
    // The rent can only go to the wallet that paid it.
    let wrong = ix(
        accounts::ClosePair {
            caller: a(stranger.pubkey()),
            pair,
            payer: a(stranger.pubkey()),
        },
        instruction::ClosePair {
            opener: d.alice.account,
            joiner: d.bob.account,
        },
        vec![],
    );
    assert!(d.env.send(&[wrong], &stranger, &[]).is_err());
    let before = d.env.svm.get_balance(&d.bob.kp.pubkey()).expect("balance");
    close(&mut d, &stranger).expect("anyone closes it after the window");
    assert!(d.env.svm.get_account(&s(pair)).is_none());
    let after = d.env.svm.get_balance(&d.bob.kp.pubkey()).expect("balance");
    assert_eq!(after, before + pair_rent, "the rent came back to Bob");
}

// ---- Code hash: the listing survives ExtendProgram, not a different build ----

fn refresh_ix(env: &Env) -> Instruction {
    let (game_record, game_program, program_data) = env.game_accounts();
    ix(
        accounts::RefreshListing {
            game_record,
            game_program,
            program_data,
        },
        instruction::RefreshListing {},
        vec![],
    )
}

fn refresh(env: &mut Env, by: &Keypair) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let i = refresh_ix(env);
    env.send(&[i], by, &[])
}

/// ComputeBudget `SetComputeUnitLimit`.
fn cu_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: "ComputeBudget111111111111111111111111111111"
            .parse()
            .expect("compute budget program"),
        accounts: vec![],
        data,
    }
}

fn error_code(e: tesoro_core::error::TesoroError) -> u32 {
    anchor_code(e)
}

#[test]
fn a_stranger_extending_the_program_unlists_it_and_refresh_restores_it() {
    let mut d = duel();
    let stranger = Keypair::new();
    d.env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    // ExtendProgram needs no authority on a loader without the checked variant: it appends zeros
    // and moves the slot, nothing else.
    common::extend_program(&mut d.env.svm, s(GAME), GAME_SLOT + 4, 10_240);
    let m = play_a_win(&mut d, ENTRY);
    assert!(!d.env.mstate(m).listed, "slot moved: unlisted");
    assert_eq!(won_points(&d.env), 0);

    refresh(&mut d.env, &stranger).expect("anyone refreshes: the bytes are the approved ones");
    let record = d.env.load::<GameRecord>(common::game_record(GAME));
    assert_eq!(record.approved_slot, GAME_SLOT + 4);
    let m2 = play_a_win(&mut d, ENTRY);
    assert!(d.env.mstate(m2).listed);
    assert!(won_points(&d.env) > 0);

    // Nothing left to refresh.
    let err = refresh(&mut d.env, &stranger).unwrap_err();
    assert_eq!(
        custom_code(&err),
        error_code(tesoro_core::error::TesoroError::ListingCurrent)
    );
}

#[test]
fn a_real_upgrade_is_not_restored_by_refresh_only_by_the_admin() {
    let mut d = duel();
    let stranger = Keypair::new();
    d.env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    // The studio ships different code (and an extension on top of it).
    let mut code = vec![0xCD; 64];
    code.extend_from_slice(&[0; 10_240]);
    common::set_program_code(
        &mut d.env.svm,
        s(GAME),
        Some(d.env.game_ctl.pubkey()),
        GAME_SLOT + 9,
        &code,
    );
    let err = refresh(&mut d.env, &stranger).unwrap_err();
    assert_eq!(
        custom_code(&err),
        error_code(tesoro_core::error::TesoroError::CodeChanged)
    );
    let m = play_a_win(&mut d, ENTRY);
    assert!(!d.env.mstate(m).listed);
    // A stranger cannot list it either; the admin approves the new build explicitly.
    let admin = d.env.admin.insecure_clone();
    let list = d.env.list_game_ix(LISTED_FOR_EVER);
    d.env
        .send(&[list], &admin, &[])
        .expect("admin approves the new build");
    let record = d.env.load::<GameRecord>(common::game_record(GAME));
    assert_eq!(record.approved_slot, GAME_SLOT + 9);
    assert_eq!(record.approved_hash, common::code_hash(&d.env.svm, s(GAME)));
    let m2 = play_a_win(&mut d, ENTRY);
    assert!(d.env.mstate(m2).listed);
}

#[test]
fn the_admin_cannot_approve_a_hash_that_is_not_the_program_on_chain() {
    let mut d = duel();
    let admin = d.env.admin.insecure_clone();
    let (game_record, game_program, program_data) = d.env.game_accounts();
    let list = |hash: [u8; 32]| {
        ix(
            accounts::ListGame {
                admin: a(admin.pubkey()),
                config: pda(&[CONFIG_SEED]),
                game_record,
                game_program,
                program_data,
            },
            instruction::ListGame {
                listed_until: LISTED_FOR_EVER,
                approved_hash: hash,
            },
            vec![],
        )
    };
    for bad in [[0u8; 32], [7u8; 32]] {
        let err = d.env.send(&[list(bad)], &admin, &[]).unwrap_err();
        assert_eq!(
            custom_code(&err),
            error_code(tesoro_core::error::TesoroError::CodeHashMismatch)
        );
    }
    // The program changes between the admin's off-chain hash and the transaction.
    let stale = common::code_hash(&d.env.svm, s(GAME));
    common::set_program_code(
        &mut d.env.svm,
        s(GAME),
        Some(d.env.game_ctl.pubkey()),
        GAME_SLOT + 1,
        &[0x11; 64],
    );
    let err = d.env.send(&[list(stale)], &admin, &[]).unwrap_err();
    assert_eq!(
        custom_code(&err),
        error_code(tesoro_core::error::TesoroError::CodeHashMismatch)
    );
}

#[test]
fn refresh_needs_a_listing_in_force() {
    let mut d = duel();
    let stranger = Keypair::new();
    d.env.svm.airdrop(&stranger.pubkey(), SOL).expect("airdrop");
    common::extend_program(&mut d.env.svm, s(GAME), GAME_SLOT + 2, 10_240);
    // Withdrawn by the admin: a refresh must not bring it back.
    let admin = d.env.admin.insecure_clone();
    let unlist = d.env.list_game_ix(0);
    d.env.send(&[unlist], &admin, &[]).expect("unlist");
    let err = refresh(&mut d.env, &stranger).unwrap_err();
    assert_eq!(
        custom_code(&err),
        error_code(tesoro_core::error::TesoroError::NotListed)
    );
    // Expired listing: same.
    let now = d.env.now();
    let list = d.env.list_game_ix(now + 50);
    d.env.send(&[list], &admin, &[]).expect("list");
    common::extend_program(&mut d.env.svm, s(GAME), GAME_SLOT + 3, 10_240);
    d.env.set_time(now + 51);
    let err = refresh(&mut d.env, &stranger).unwrap_err();
    assert_eq!(
        custom_code(&err),
        error_code(tesoro_core::error::TesoroError::NotListed)
    );
}

#[test]
fn hashing_the_largest_game_program_fits_one_transaction() {
    let mut d = duel();
    let admin = d.env.admin.insecure_clone();
    let so = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/vanguard.so"
    ))
    .expect("vanguard.so (pnpm build:programs)");
    assert!(so.len() > 700_000, "the largest game program");
    common::set_program_code(
        &mut d.env.svm,
        s(GAME),
        Some(d.env.game_ctl.pubkey()),
        GAME_SLOT + 1,
        &so,
    );
    let list = d.env.list_game_ix(LISTED_FOR_EVER);
    d.env
        .send(&[cu_limit(1_400_000), list], &admin, &[])
        .expect("list_game hashes the program");
    let list_cu = d.env.last_cu;
    // A stranger extends it by one page; refresh hashes it again.
    common::extend_program(&mut d.env.svm, s(GAME), GAME_SLOT + 2, 10_240);
    let i = refresh_ix(&d.env);
    d.env
        .send(&[cu_limit(1_400_000), i], &admin, &[])
        .expect("refresh_listing hashes the program");
    let refresh_cu = d.env.last_cu;
    eprintln!(
        "CU list_game {list_cu} refresh_listing {refresh_cu} for {} bytes",
        so.len()
    );
    assert!(list_cu < 1_000_000 && refresh_cu < 1_000_000);
    // Worst case the registry accepts: the whole cap is padding the scan must walk.
    common::extend_program(
        &mut d.env.svm,
        s(GAME),
        GAME_SLOT + 3,
        tesoro_core::registry::MAX_CODE_BYTES - so.len() - 45 - 10_240,
    );
    let i = refresh_ix(&d.env);
    d.env
        .send(&[cu_limit(1_400_000), i], &admin, &[])
        .expect("refresh at the size cap");
    eprintln!("CU refresh_listing at the size cap {}", d.env.last_cu);
    assert!(d.env.last_cu < 1_400_000);
}

// --- Budgets: what a line costs, and how many fit one transaction ---------------------------

fn person_with_lines(env: &mut Env, k: usize, tag: u8, entry: u64) -> (Person, Vec<APk>) {
    let p = env.person();
    env.grow_basket_to(&p, k + 4);
    let sources: Vec<APk> = (0..k)
        .map(|i| env.forge_source(tag.wrapping_add(i as u8), 0))
        .collect();
    env.give_lines(&p, &sources, entry / k as u64, |i| i as i64);
    (p, sources)
}

#[test]
fn the_per_transaction_line_cap_is_compute_not_accounts() {
    // Moving a line is in-place work: no account per line, so the transaction does not grow with
    // the number of lines, and the cap is set by compute alone (200,000 CU by default).
    println!("lines | open_match CU | stage CU | stage tx bytes");
    for k in [1usize, 2, 4, 5, 10, 20, 25, 50] {
        let mut env = Env::new();
        let (p, _) = person_with_lines(&mut env, k, 100, 2_500);
        env.open_ticket(&p, 5, 2_500, k as u32 + 1).expect("ticket");
        let kp = p.kp.insecure_clone();
        // a transaction stages at most MAX_STAGE_OPS lines; the rest follow in the next one
        let mut worst = 0;
        let mut size = 0;
        for _ in 0..3 {
            env.stage_with(&kp, &p, 5, 255, vec![]).expect("stage");
            worst = worst.max(env.last_cu);
            size = size.max(env.last_size);
            let t = env.load_ticket_staged(&p, 5);
            if t == 2_500 {
                break;
            }
        }
        let open_cu = if k <= 10 {
            let (q, _) = person_with_lines(&mut env, k, 160, 2_500);
            env.open_match_ix(
                &q,
                2_500,
                0,
                9_000,
                false,
                0,
                k as u32 + 1,
                ticket_pda(q.account, 9_000),
                vec![],
                None,
            )
            .expect("direct draw");
            env.last_cu
        } else {
            // more lines than one transaction draws: the program says so
            let (q, _) = person_with_lines(&mut env, k, 160, 2_500);
            let err = env
                .open_match_ix(
                    &q,
                    2_500,
                    0,
                    9_000,
                    false,
                    0,
                    18,
                    ticket_pda(q.account, 9_000),
                    vec![],
                    None,
                )
                .unwrap_err();
            assert_eq!(custom_code(&err), MATCH_NEEDS_TICKET, "{k} lines");
            0
        };
        println!("{k:>5} | {open_cu:>13} | {worst:>8} | {size}");
        assert!(
            worst < 130_000,
            "{k} lines: a staging transaction stays under budget"
        );
        assert!(
            open_cu < 120_000,
            "{k} lines: a direct draw stays under budget"
        );
        assert!(size < 400, "a staging transaction has no account per line");
    }
}

#[test]
fn a_chunk_of_twelve_steps_fits_one_transaction_with_a_lookup_table() {
    // Worst case: every credit merges into a line of the same Source (its book swaps in), and
    // the fee cuts sync Sources. The client loads only the Sources of the next steps.
    println!("sources | start CU | chunk CU (<=12 steps) | accounts | legacy bytes | v0 bytes");
    for k in [4usize, 5, 8, 10] {
        let mut env = Env::new();
        let alice = env.person();
        let bob = env.person();
        for p in [&alice, &bob] {
            env.grow_basket_to(p, 2 * k + 8);
        }
        let sources: Vec<APk> = (0..k).map(|i| env.forge_source(100 + i as u8, 0)).collect();
        env.give_lines(&alice, &sources, 1_000 / k as u64, |i| i as i64);
        env.give_lines(&bob, &sources, 1_000 / k as u64, |i| i as i64);
        env.give_lines(&bob, &sources, 4, |i| i as i64 + 1_000);
        env.give_lines(&alice, &sources, 4, |i| i as i64 + 1_000);
        let m = env
            .open_match_ix(
                &alice,
                1_000,
                0,
                9_001,
                false,
                0,
                k as u32 + 1,
                ticket_pda(alice.account, 9_001),
                env.books_of(alice.account),
                None,
            )
            .expect("open");
        env.join_match_ix(
            &bob,
            m,
            9_002,
            k as u32 + 1,
            ticket_pda(bob.account, 9_002),
            env.books_of(bob.account),
            None,
        )
        .expect("join");
        let game = env.game_auth.insecure_clone();
        env.settle_start(&game, m, MatchResult::Opener)
            .expect("start");
        let start_cu = env.last_cu;
        let mut worst = (0, 0, 0, 0);
        while env.stage_of(m) != Stage::Closed {
            let payer = env.admin.insecure_clone();
            let mut fit = 12u8;
            let mut probe = env.chunk_ix(a(payer.pubkey()), m, fit);
            while probe.accounts.len() > 60 && fit > 1 {
                fit -= 1;
                probe = env.chunk_ix(a(payer.pubkey()), m, fit);
            }
            let (legacy, v0, n) = env.tx_sizes(&probe, &payer);
            env.chunk(m, 12).expect("chunk");
            if env.last_cu > worst.0 {
                worst = (env.last_cu, n, legacy, v0);
            }
        }
        println!(
            "{k:>7} | {start_cu:>8} | {:>19} | {:>8} | {:>12} | {}",
            worst.0, worst.1, worst.2, worst.3
        );
        assert!(
            worst.0 < 140_000,
            "a 12-step chunk stays well under 200,000 CU"
        );
        assert!(worst.1 <= 64, "a chunk locks at most 64 accounts");
        assert!(
            worst.3 <= 1_232,
            "as a v0 transaction with a lookup table it fits"
        );
        assert!(start_cu < 80_000);
        env.close_match(m).expect("close");
    }
}

#[test]
fn a_thousand_line_basket_costs_within_ten_percent_of_eight_lines() {
    println!("basket lines | open CU | join CU | chunk CU (12 steps) | stage CU (8 lines)");
    let mut rows = vec![];
    for dust in [0usize, 992] {
        let mut env = Env::new();
        let alice = env.person();
        let bob = env.person();
        let k = 8usize;
        let sources: Vec<APk> = (0..k).map(|i| env.forge_source(100 + i as u8, 0)).collect();
        env.grow_basket_to(&alice, k + 4);
        env.grow_basket_to(&bob, k + 4);
        env.give_lines(&alice, &sources, 125, |i| i as i64);
        env.give_lines(&bob, &sources, 125, |i| i as i64);
        give_dust(&mut env, &alice, dust);
        env.open_ticket(&alice, 4, 1_000, 9).expect("ticket");
        env.stage_with(&alice.kp.insecure_clone(), &alice, 4, 20, vec![])
            .expect("stage");
        let stage_cu = env.last_cu;
        env.cancel_ticket_with(&alice.kp.insecure_clone(), &alice, 4, 20, vec![])
            .expect("cancel");
        let m = env
            .open_match_ix(
                &alice,
                1_000,
                0,
                9_001,
                false,
                0,
                9,
                ticket_pda(alice.account, 9_001),
                vec![],
                None,
            )
            .expect("open");
        let open_cu = env.last_cu;
        env.join_match_ix(
            &bob,
            m,
            9_002,
            9,
            ticket_pda(bob.account, 9_002),
            vec![],
            None,
        )
        .expect("join");
        let join_cu = env.last_cu;
        let game = env.game_auth.insecure_clone();
        env.settle_start(&game, m, MatchResult::Opener)
            .expect("start");
        env.chunk(m, 12).expect("chunk");
        let chunk_cu = env.last_cu;
        println!(
            "{:>12} | {open_cu:>7} | {join_cu:>7} | {chunk_cu:>19} | {stage_cu:>8}",
            dust + 8
        );
        rows.push([open_cu, join_cu, chunk_cu, stage_cu]);
    }
    for (i, what) in ["open", "join", "chunk", "stage"].iter().enumerate() {
        let (small, big) = (rows[0][i] as f64, rows[1][i] as f64);
        assert!(big <= small * 1.10, "{what}: {big} against {small}");
    }
}

/// `n` dust lines (1 Gema each, of Sources that do not exist) behind everything else in the basket
/// (due far in the future), standing in for a long-time Player's collection of old Advances.
fn give_dust(env: &mut Env, p: &Person, n: usize) {
    use tesoro_core::ledger::book::SourceBook;
    use tesoro_core::ledger::line_store::LineStore;
    env.grow_basket_to(p, n + 40);
    let store = basket_address(&p.account).0;
    let mut acc = env.svm.get_account(&s(store)).expect("basket");
    {
        let mut st = LineStore::new(&mut acc.data[DISC..]).expect("basket");
        for i in 0..n {
            let mut key = [0u8; 32];
            key[..8].copy_from_slice(&(i as u64 + 1).to_le_bytes());
            let mut line =
                SourceBook::blank_line(SIDE_OWN, 1_000_000 + i as i64, key, CLASS_GENERAL, 0);
            line.amount = 1;
            st.insert(&line).expect("room");
        }
    }
    env.svm.set_account(s(store), acc).expect("set basket");
}

// --- Tickets, attacks and the run's rules ------------------------------------------------------

const ERR_TICKET_NOT_COMPLETE: u32 = 6403;
const ERR_TICKET_NOT_EXPIRED: u32 = 6408;
const ERR_TICKET_OPEN: u32 = 6409;
const ERR_TOO_MANY_MATCHES: u32 = 6401;
const ERR_NOT_CLOSED: u32 = 6413;
const ERR_OFFER_HAS_TICKET: u32 = 6416;
const ERR_PAST_ABSOLUTE: u32 = 6417;
const ERR_GAME_UPGRADED: u32 = 6418;
const ERR_RECEIPT_NEW: u32 = 6422;
const ERR_OFFER_NOT_USABLE: u32 = 6425;
const ERR_TOO_MANY_OFFERS: u32 = 6426;

fn total_in_world(env: &Env, people: &[&Person], sources: &[APk]) -> u64 {
    let held: u64 = people
        .iter()
        .map(|p| sources.iter().map(|s| env.gemas_of(p, *s)).sum::<u64>())
        .sum();
    let counters: u64 = sources
        .iter()
        .map(|s| (0..3).map(|c| env.counter_amount(*s, c)).sum::<u64>())
        .sum();
    held + counters
}

#[test]
fn an_entry_ticket_stages_in_steps_then_becomes_the_pot() {
    let mut env = Env::new();
    // 50 lines of 50 Gemas: more than one transaction draws, so the entry goes through a Ticket
    let (alice, a_sources) = person_with_lines(&mut env, 50, 100, 2_500);
    let bob = env.person();
    let (_, b_source) = env.stake(&bob, 2);
    let all: Vec<APk> = a_sources.iter().copied().chain([b_source]).collect();
    let before = total_in_world(&env, &[&alice, &bob, &env.platform, &env.studio], &all);
    let err = env.open_match(&alice, 2_500).unwrap_err();
    assert_eq!(custom_code(&err), MATCH_NEEDS_TICKET);
    env.open_ticket(&alice, 5, 2_500, 51).expect("ticket");
    // while a Ticket is open nothing else draws
    let err = env.open_match(&alice, 2_500).unwrap_err();
    assert_eq!(custom_code(&err), ERR_TICKET_OPEN);
    let kp = alice.kp.insecure_clone();
    env.stage_with(&kp, &alice, 5, 255, vec![])
        .expect("first stage");
    assert!(env.load_ticket_staged(&alice, 5) < 2_500);
    let err = env.open_match_ticket(&alice, 2_500, 5).unwrap_err();
    assert_eq!(custom_code(&err), ERR_TICKET_NOT_COMPLETE);
    // only the owner stages an Entry Ticket
    let stranger = env.admin.insecure_clone();
    assert!(env.stage_with(&stranger, &alice, 5, 255, vec![]).is_err());
    env.stage_with(&kp, &alice, 5, 255, vec![])
        .expect("second stage");
    assert_eq!(env.load_ticket_staged(&alice, 5), 2_500);
    let m = env
        .open_match_ticket(&alice, 2_500, 5)
        .expect("open with the Ticket");
    assert_eq!(
        env.ticket_state(&alice, 5),
        tesoro_core::ledger::draw::TicketState::Closed
    );
    assert_eq!(env.mstate(m).pots[0], ticket_pda(alice.account, 5));
    assert_eq!(env.total_gemas(&alice), 0);
    env.join_match(&bob, m).expect("join");
    let game = env.game_auth.insecure_clone();
    env.settle_keep(&game, m, MatchResult::Joiner)
        .expect("settle");
    // Pot 5,000: platform 100, studio 150 off Alice's lines; Bob wins the rest
    let after = total_in_world(&env, &[&alice, &bob, &env.platform, &env.studio], &all);
    assert_eq!(before, after, "no Gema created or lost");
    assert_eq!(
        (0..3)
            .map(|c| a_sources
                .iter()
                .map(|s| env.counter_amount(*s, c))
                .sum::<u64>())
            .sum::<u64>()
            + env.fee_gemas(&env.studio),
        100 + 150
    );
    env.close_match(m).expect("close");
    assert!(
        env.svm
            .get_account(&s(ticket_pda(alice.account, 5)))
            .is_none(),
        "the Pot is closed"
    );
    assert!(env.svm.get_account(&s(env.match_key(m))).is_none());
    let spill = env
        .svm
        .get_account(&s(spill_address(&alice.account).0))
        .unwrap()
        .data;
    let st = tesoro_core::ledger::line_store::LineStore::new(&spill[DISC..]).unwrap();
    assert_eq!(st.room_reserved(), 0, "the room it held is released");
}

#[test]
fn a_ticket_returns_every_line_when_cancelled_or_expired_even_into_a_full_basket() {
    let mut env = Env::new();
    let (alice, _) = person_with_lines(&mut env, 50, 100, 2_500);
    let kp = alice.kp.insecure_clone();
    env.open_ticket(&alice, 5, 2_500, 51).expect("ticket");
    env.stage_with(&kp, &alice, 5, 255, vec![]).expect("stage");
    assert_eq!(
        env.total_gemas(&alice),
        2_500 - env.load_ticket_staged(&alice, 5)
    );
    // the basket fills up while the lines are away
    let spare = env.person();
    let _ = spare;
    let cap = {
        let d = env
            .svm
            .get_account(&s(basket_address(&alice.account).0))
            .unwrap()
            .data;
        let st = tesoro_core::ledger::line_store::LineStore::new(&d[DISC..]).unwrap();
        (st.capacity(), st.len())
    };
    let extra: Vec<APk> = (0..cap.0 - cap.1)
        .map(|i| env.forge_source(200 + i as u8, 0))
        .collect();
    env.give_lines(&alice, &extra, 1, |i| 10_000 + i as i64);
    let before = env.total_gemas(&alice) + env.load_ticket_staged(&alice, 5);
    // a stranger cannot cancel before the deadline, the owner can at once
    let stranger = env.admin.insecure_clone();
    let err = env
        .cancel_ticket_with(&stranger, &alice, 5, 8, vec![])
        .unwrap_err();
    assert_eq!(custom_code(&err), ERR_TICKET_NOT_EXPIRED);
    env.cancel_ticket_with(&kp, &alice, 5, 8, vec![])
        .expect("owner cancels, 8 lines");
    assert_eq!(
        env.ticket_state(&alice, 5),
        tesoro_core::ledger::draw::TicketState::Cancelling
    );
    // anyone may continue it
    for _ in 0..10 {
        if env.ticket_state(&alice, 5) == tesoro_core::ledger::draw::TicketState::Cancelled {
            break;
        }
        env.cancel_ticket_with(&stranger, &alice, 5, 8, vec![])
            .expect("continue");
    }
    assert_eq!(
        env.ticket_state(&alice, 5),
        tesoro_core::ledger::draw::TicketState::Cancelled
    );
    let spill_lines = common::econ::read_lines(&env.svm, spill_address(&alice.account).0).len();
    assert!(spill_lines > 0, "the full basket sent lines to the spill");
    assert_eq!(env.total_gemas(&alice), before, "every Gema came back");
    let bal = env.svm.get_balance(&alice.kp.pubkey()).unwrap();
    env.close_ticket(&stranger, &alice, 5).expect("close");
    assert!(
        env.svm.get_balance(&alice.kp.pubkey()).unwrap() > bal,
        "rent back to the payer"
    );

    // expiry: anyone cancels an untouched Ticket after the hour
    env.open_ticket(&alice, 6, 500, 12).expect("second ticket");
    let now = env.now();
    env.set_time(now + 3_601);
    env.cancel_ticket_with(&stranger, &alice, 6, 8, vec![])
        .expect("expired");
    assert_eq!(
        env.ticket_state(&alice, 6),
        tesoro_core::ledger::draw::TicketState::Cancelled
    );
}

#[test]
fn faster_gemas_arriving_after_staging_stop_the_ticket_from_opening() {
    let mut env = Env::new();
    let (alice, _) = person_with_lines(&mut env, 25, 100, 2_500);
    let kp = alice.kp.insecure_clone();
    env.open_ticket(&alice, 5, 2_500, 30).expect("ticket");
    env.stage_with(&kp, &alice, 5, 255, vec![])
        .expect("stage all 25");
    assert_eq!(env.load_ticket_staged(&alice, 5), 2_500);
    // a faster line (earlier due date) is credited to the basket meanwhile
    let fast = env.forge_source(230, 0);
    env.give_lines(&alice, &[fast], 7, |_| -1);
    let err = env.open_match_ticket(&alice, 2_500, 5).unwrap_err();
    assert_eq!(custom_code(&err), 6404, "FasterGemasAvailable");
    // staging again swaps the slowest staged Gemas for the faster ones, then it opens
    env.stage_with(
        &kp,
        &alice,
        5,
        255,
        vec![common::econ::book_metas(&env.svm, fast)[0].clone()],
    )
    .ok();
}

#[test]
fn a_deadline_cannot_be_extended_past_seven_days_from_the_open() {
    let mut d = duel();
    let m = d.env.open_match(&d.alice, ENTRY).unwrap();
    d.env.join_match(&d.bob, m).unwrap();
    let opened = d.env.mstate(m).inner.opened_at;
    let game = d.env.game_auth.insecure_clone();
    let extend = |d: &mut Duel, deadline: i64| {
        let i = ix(
            accounts::ExtendMatchDeadline {
                game_authority: a(game.pubkey()),
                match_state: d.env.match_key(m),
            },
            instruction::ExtendMatchDeadline {
                new_deadline: deadline,
            },
            vec![],
        );
        d.env.send(&[i], &game, &[])
    };
    // keep extending a day at a time, just before each deadline, until the cap
    let abs = opened + 7 * 86_400;
    loop {
        let deadline = d.env.mstate(m).inner.deadline;
        if deadline >= abs {
            break;
        }
        d.env.set_time(deadline - 100);
        let now = d.env.now();
        extend(&mut d, (now + 86_400).min(abs)).expect("within the cap");
    }
    assert_eq!(d.env.mstate(m).inner.deadline_abs, abs);
    d.env.set_time(abs - 1_000);
    let err = extend(&mut d, abs + 1).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::InvalidDeadline));
    // at the absolute deadline only a refund can start, and anyone may start it
    d.env.set_time(abs);
    let err = d
        .env
        .settle_start(&game, m, MatchResult::Opener)
        .unwrap_err();
    assert_eq!(custom_code(&err), ERR_PAST_ABSOLUTE);
    let stranger = d.env.admin.insecure_clone();
    d.env.refund(&stranger, m, vec![]).expect("refund");
}

#[test]
fn a_game_upgraded_since_the_open_can_only_refund() {
    let mut d = duel();
    let m = d.env.open_match(&d.alice, ENTRY).unwrap();
    d.env.join_match(&d.bob, m).unwrap();
    let game = d.env.game_auth.insecure_clone();
    // a stranger's ExtendProgram moves the slot, not the code: still the same build
    common::extend_program(&mut d.env.svm, s(GAME), GAME_SLOT + 3, 10_240);
    // a real upgrade changes the bytes
    common::set_program_code(
        &mut d.env.svm,
        s(GAME),
        Some(d.env.game_ctl.pubkey()),
        GAME_SLOT + 9,
        &[0xCD; 64],
    );
    let err = d
        .env
        .settle_start(&game, m, MatchResult::Opener)
        .unwrap_err();
    assert_eq!(custom_code(&err), ERR_GAME_UPGRADED);
    assert_eq!(d.env.stage_of(m), Stage::Active);
    // only a refund can start now, by anyone, at once
    let stranger = d.env.admin.insecure_clone();
    d.env.refund_keep(&stranger, m).expect("refund");
    assert_eq!(d.env.total_gemas(&d.alice), 75_000);
    assert_eq!(d.env.total_gemas(&d.bob), 75_000);
}

#[test]
fn an_account_has_at_most_eight_matches_open_and_closing_frees_one() {
    let mut d = duel();
    let mut ids = vec![];
    for _ in 0..MAX_OPEN {
        ids.push(d.env.open_match(&d.alice, 500).expect("open"));
    }
    let err = d.env.open_match(&d.alice, 500).unwrap_err();
    assert_eq!(custom_code(&err), ERR_TOO_MANY_MATCHES);
    let opener = d.alice.kp.insecure_clone();
    d.env
        .refund(&opener, ids[0], vec![])
        .expect("the opener cancels one");
    d.env
        .open_match(&d.alice, 500)
        .expect("a slot is free again");
    assert_eq!(d.env.counters(d.alice.account).open_matches, MAX_OPEN);
}
const MAX_OPEN: u32 = 8;

#[test]
fn a_backed_player_cannot_be_matched_against_their_own_backer() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    b.accept_public(offer, request);
    // Carol (the Backer) opens a Match; Dave, backed by Carol, may not join it
    let carol = Person {
        kp: b.carol.kp.insecure_clone(),
        key: b.carol.key,
        account: b.carol.account,
    };
    let id = b.d.env.open_match(&carol, 500).expect("carol opens");
    let err = b.join_backed(offer, id).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::SelfMatch));
}

#[test]
fn a_backing_ticket_needs_the_requesters_signature_and_blocks_cancelling_the_offer() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    b.accept_public(offer, request);
    let carol = Person {
        kp: b.carol.kp.insecure_clone(),
        key: b.carol.key,
        account: b.carol.account,
    };
    let dave = Person {
        kp: b.dave.kp.insecure_clone(),
        key: b.dave.key,
        account: b.dave.account,
    };
    let bob = Person {
        kp: b.d.bob.kp.insecure_clone(),
        key: b.d.bob.key,
        account: b.d.bob.account,
    };
    // nobody but the Requester the Offer was accepted for can open one
    let err =
        b.d.env
            .open_backing_ticket(&carol, &bob, offer, 9, 500, 4)
            .unwrap_err();
    assert_eq!(custom_code(&err), ERR_OFFER_NOT_USABLE);
    b.d.env
        .open_backing_ticket(&carol, &dave, offer, 9, 500, 4)
        .expect("backing ticket");
    // the Offer cannot be cancelled while it stages
    let cancel = ix(
        accounts::CancelOffer {
            backer_authority: carol.key,
            backer_account: carol.account,
            basket: basket_address(&carol.account).0,
            spill: spill_address(&carol.account).0,
            counters: counters_pda(carol.account),
            offer,
            request: None,
        },
        instruction::CancelOffer {},
        vec![],
    );
    let err = b.d.env.send(&[cancel], &carol.kp, &[]).unwrap_err();
    assert_eq!(custom_code(&err), ERR_OFFER_HAS_TICKET);
    // anyone stages it, nobody can pick other lines
    let stranger = b.d.env.admin.insecure_clone();
    let books = b.d.env.books_of(carol.account);
    b.d.env
        .stage_with(&stranger, &carol, 9, 20, books.clone())
        .expect("anyone stages");
    assert_eq!(b.d.env.load_ticket_staged(&carol, 9), 500);
    // the Requester opens the backed Match with it
    let n = b.d.env.counters_next(dave.account);
    let id =
        b.d.env
            .open_match_ix(
                &dave,
                500,
                n,
                9,
                false,
                0,
                1,
                ticket_pda(carol.account, 9),
                books,
                Some((offer, carol.account)),
            )
            .expect("backed open with the Ticket");
    assert_eq!(b.d.env.mstate(id).inner.a.funder, carol.account.to_bytes());
    assert_eq!(
        b.d.env.load::<OfferState>(offer).inner.status,
        tesoro_core::ledger::OfferStatus::Consumed
    );
    assert!(!b.d.env.load::<OfferState>(offer).inner.ticket_open);
}

#[test]
fn the_backer_cancels_a_backing_ticket_at_once_and_the_offer_is_free_again() {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 5_000, None);
    b.accept_public(offer, request);
    let carol = Person {
        kp: b.carol.kp.insecure_clone(),
        key: b.carol.key,
        account: b.carol.account,
    };
    let dave = Person {
        kp: b.dave.kp.insecure_clone(),
        key: b.dave.key,
        account: b.dave.account,
    };
    b.d.env
        .open_backing_ticket(&carol, &dave, offer, 9, 500, 4)
        .unwrap();
    let books = b.d.env.books_of(carol.account);
    b.d.env
        .stage_with(&dave.kp.insecure_clone(), &carol, 9, 20, books.clone())
        .unwrap();
    assert_eq!(
        b.reserved(),
        0,
        "staging moved the reservation into the Ticket"
    );
    let kp = carol.kp.insecure_clone();
    b.d.env
        .cancel_backing_ticket(&kp, &carol, 9, Some(offer), books)
        .expect("cancel");
    assert_eq!(b.reserved(), 500, "the reservation is whole again");
    assert!(!b.d.env.load::<OfferState>(offer).inner.ticket_open);
    assert_eq!(b.d.env.total_gemas(&carol), 75_000);
}

#[test]
fn only_eight_offers_are_open_at_once_and_the_reserved_part_costs_nothing_to_draw_around() {
    let mut b = backing_setup();
    let base = {
        let carol = Person {
            kp: b.carol.kp.insecure_clone(),
            key: b.carol.key,
            account: b.carol.account,
        };
        b.d.env.open_match(&carol, 500).unwrap();
        b.d.env.last_cu
    };
    let mut b = backing_setup();
    for n in 1..=8 {
        b.offer(n, 500, 5_000, None);
    }
    assert_eq!(b.reserved(), 4_000);
    let create = ix(
        accounts::CreateOffer {
            backer_authority: b.carol.key,
            config: pda(&[CONFIG_SEED]),
            game_record: common::game_record(GAME),
            backer_account: b.carol.account,
            protections: protections_pda(b.carol.account),
            basket: basket_address(&b.carol.account).0,
            spill: spill_address(&b.carol.account).0,
            counters: counters_pda(b.carol.account),
            offer: offer_pda(b.carol.account, 9),
            system_program: anchor_lang::system_program::ID,
        },
        instruction::CreateOffer {
            nonce: 9,
            game: GAME,
            entry: 500,
            player_share_bps: 5_000,
            directed_request: None,
        },
        vec![],
    );
    let carol = b.carol.kp.insecure_clone();
    let err = b.d.env.send(&[create], &carol, &[]).unwrap_err();
    assert_eq!(custom_code(&err), ERR_TOO_MANY_OFFERS);
    let carol = Person {
        kp: b.carol.kp.insecure_clone(),
        key: b.carol.key,
        account: b.carol.account,
    };
    b.d.env.open_match(&carol, 500).unwrap();
    let with_prefix = b.d.env.last_cu;
    println!("open_match: {base} CU plain, {with_prefix} CU with 8 Offers reserved");
    assert!(with_prefix as f64 <= base as f64 * 1.10);
}

#[test]
fn a_no_show_pays_the_platform_fee_from_each_side_and_returns_the_rest() {
    let mut d = duel();
    let m = d.env.open_match(&d.alice, ENTRY).unwrap();
    d.env.join_match(&d.bob, m).unwrap();
    let game = d.env.game_auth.insecure_clone();
    d.env
        .settle_keep(&game, m, MatchResult::NoShow)
        .expect("no-show");
    // 2% of each 1,000 entry
    let platform = d.env.counter_amount(d.a_source, CLASS_PLATFORM)
        + d.env.counter_amount(d.b_source, CLASS_PLATFORM);
    assert_eq!(platform, 40);
    assert_eq!(d.env.counter_amount(d.a_source, CLASS_PLATFORM), 20);
    assert_eq!(d.env.total_gemas(&d.alice), 75_000 - 20);
    assert_eq!(d.env.total_gemas(&d.bob), 75_000 - 20);
    assert_eq!(d.env.fee_gemas(&d.env.studio), 0);
}

#[test]
fn an_unlisted_games_studio_fee_is_ordinary_gemas_not_a_senior_fee() {
    let mut d = duel();
    common::set_program_data(
        &mut d.env.svm,
        s(GAME),
        Some(d.env.game_ctl.pubkey()),
        GAME_SLOT + 7,
    );
    let m = play_a_win(&mut d, ENTRY);
    assert!(!d.env.mstate(m).listed);
    assert_eq!(d.env.fee_gemas(&d.env.studio), 0);
    assert_eq!(
        d.env.total_gemas(&d.env.studio),
        60,
        "won Gemas in the studio's basket"
    );
    assert_eq!(d.env.counter_amount(d.b_source, CLASS_PLATFORM), 40);
}

/// Names the Account that receives the Studio Fee of Tesoro's own Games.
fn set_tesoro_studio(env: &mut Env, recipient: APk) {
    let admin = env.admin.insecure_clone();
    let set = ix(
        accounts::SetTesoroStudio {
            admin: a(admin.pubkey()),
            config: pda(&[CONFIG_SEED]),
            economy: pda(&[ECONOMY_SEED]),
            recipient_account: recipient,
        },
        instruction::SetTesoroStudio {},
        vec![],
    );
    env.send(&[set], &admin, &[]).expect("set tesoro studio");
}

#[test]
fn a_listed_tesoro_game_pays_its_studio_fee_into_the_source_counter_and_cash_in_pays_tesoro_studio()
{
    let mut d = duel();
    let studio = d.env.studio.account;
    set_tesoro_studio(&mut d.env, studio);
    let m = play_a_win(&mut d, ENTRY);
    assert!(d.env.mstate(m).listed);
    // 3% of the 2,000 Pot comes off Bob's lines into his Source's Studio counter, no basket line
    assert_eq!(d.env.counter_amount(d.b_source, CLASS_STUDIO), 60);
    assert_eq!(d.env.counter_amount(d.b_source, CLASS_PLATFORM), 40);
    assert_eq!(d.env.fee_gemas(&d.env.studio), 0);
    assert_eq!(d.env.total_gemas(&d.env.studio), 0);
    // conservation: every Gema of Bob's Source is somewhere
    let held: u64 = [&d.alice, &d.bob, &d.env.platform, &d.env.studio]
        .iter()
        .map(|p| d.env.gemas_of(p, d.b_source))
        .sum::<u64>()
        + d.env.counter_amount(d.b_source, CLASS_STUDIO)
        + d.env.counter_amount(d.b_source, CLASS_PLATFORM);
    assert_eq!(held, 75_000);
    // yield covers the counter, anyone cashes it in, and only to the Tesoro studio
    let oracle = d.env.oracle.insecure_clone();
    let b_position = position_pda(2);
    d.env
        .yield_to(&oracle, b_position, Some(d.b_source), 1, 6 * SOL)
        .expect("yield");
    let cash = |d: &Duel, to: APk| {
        let remaining = book_metas(&d.env.svm, d.b_source);
        ix(
            accounts::CashInFee {
                config: pda(&[CONFIG_SEED]),
                economy: pda(&[ECONOMY_SEED]),
                recipient_account: to,
                position: b_position,
                source: d.b_source,
            },
            instruction::CashInFee {
                class: CLASS_STUDIO,
            },
            remaining,
        )
    };
    let bob = d.bob.kp.insecure_clone();
    let wrong = cash(&d, d.alice.account);
    assert!(d.env.send(&[wrong], &bob, &[]).is_err());
    let right = cash(&d, studio);
    d.env.send(&[right], &bob, &[]).expect("cash in");
    assert_eq!(
        d.env.counter_amount(d.b_source, CLASS_STUDIO),
        0,
        "paid out in full"
    );
}

#[test]
fn a_listed_outside_studios_fee_stays_a_studio_class_line_in_its_basket() {
    let mut d = duel();
    // the admin names someone else as Tesoro's studio: this Game's studio is an outside one
    let other = d.env.platform.account;
    set_tesoro_studio(&mut d.env, other);
    let m = play_a_win(&mut d, ENTRY);
    assert!(d.env.mstate(m).listed);
    assert_eq!(d.env.counter_amount(d.b_source, CLASS_STUDIO), 0);
    assert_eq!(d.env.fee_gemas(&d.env.studio), 60);
}

#[test]
fn junk_program_data_cannot_make_anyone_refund_an_active_match_as_upgraded() {
    let mut d = duel();
    let m = d.env.open_match(&d.alice, ENTRY).unwrap();
    d.env.join_match(&d.bob, m).unwrap();
    let stranger = d.env.person();
    let kp = stranger.kp.insecure_clone();
    for junk in [APk::new_unique(), d.alice.account, game_record_of_game()] {
        assert!(
            d.env.refund_start_with(&kp, m, junk).is_err(),
            "a healthy Active Match is not refundable by a stranger"
        );
        assert_eq!(d.env.stage_of(m), Stage::Active);
    }
}

fn game_record_of_game() -> APk {
    common::game_record(GAME)
}

#[test]
fn the_run_writes_start_chunk_and_completion_records_by_event_cpi() {
    let mut d = duel();
    let m = d.env.open_match(&d.alice, ENTRY).unwrap();
    d.env.join_match(&d.bob, m).unwrap();
    let game = d.env.game_auth.insecure_clone();
    d.env.settle_start(&game, m, MatchResult::Opener).unwrap();
    let started: Vec<MatchRunStarted> = d
        .env
        .start_events
        .iter()
        .filter_map(|e| decode_event(e))
        .collect();
    assert_eq!(started.len(), 1);
    assert_eq!((started[0].entry, started[0].fees), (ENTRY, [40, 60, 0]));
    assert_eq!(
        (started[0].kind, started[0].winner, started[0].n),
        (0, 0, 0)
    );
    assert_eq!(started[0].a_player, d.alice.account);
    let receipt = d
        .env
        .load::<SettlementReceipt>(receipt_pda(d.env.match_key(m)));
    assert_eq!(receipt.receipt.id.n, 0);
    let mut chunks = 0u32;
    let mut done = false;
    while !done {
        d.env.chunk(m, 3).unwrap();
        for e in &d.env.last_events {
            if let Some(c) = decode_event::<MatchChunkDone>(e) {
                chunks += 1;
                assert_eq!(c.chunk_no, chunks);
                done = c.done;
            }
            if decode_event::<MatchSettled>(e).is_some() {
                assert!(done, "the completion record comes with the last chunk");
            }
        }
    }
    assert!(chunks >= 2, "a small step budget takes several chunks");
    // a chunk after the end changes nothing and says it is done
    d.env.chunk(m, 3).unwrap();
}

#[test]
fn a_match_cannot_close_before_its_run_is_done_and_the_receipt_waits_two_weeks() {
    let mut d = duel();
    let m = d.env.open_match(&d.alice, ENTRY).unwrap();
    d.env.join_match(&d.bob, m).unwrap();
    let err = d.env.close_match(m).unwrap_err();
    assert_eq!(custom_code(&err), ERR_NOT_CLOSED);
    let game = d.env.game_auth.insecure_clone();
    d.env.settle_start(&game, m, MatchResult::Draw).unwrap();
    let err = d.env.close_match(m).unwrap_err();
    assert_eq!(custom_code(&err), ERR_NOT_CLOSED);
    d.env.run_chunks(m);
    let key = d.env.match_key(m);
    d.env.close_match(m).unwrap();
    let close = |env: &mut Env| {
        let caller = env.admin.insecure_clone();
        let i = ix(
            accounts::CloseReceipt {
                caller: a(caller.pubkey()),
                receipt: receipt_pda(key),
                payer: a(game.pubkey()),
            },
            instruction::CloseReceipt {},
            vec![],
        );
        env.send(&[i], &caller, &[])
    };
    let err = close(&mut d.env).unwrap_err();
    assert_eq!(custom_code(&err), ERR_RECEIPT_NEW);
    let now = d.env.now();
    d.env.set_time(now + 14 * 86_400 + 1);
    close(&mut d.env).expect("after two weeks");
    assert!(d.env.svm.get_account(&s(receipt_pda(key))).is_none());
}

// --- Ticket 09b: a covered entry never needs room -------------------------------------------------

impl Env {
    /// (used lines, capacity, slots held) of the Account's basket or spill.
    fn store_stats(&self, p: &Person, spill: bool) -> (usize, usize, u32) {
        let key = if spill {
            spill_address(&p.account).0
        } else {
            basket_address(&p.account).0
        };
        let d = self.svm.get_account(&s(key)).expect("store").data;
        let st = tesoro_core::ledger::line_store::LineStore::new(&d[DISC..]).expect("store");
        (st.len(), st.capacity(), st.room_reserved())
    }

    /// Makes the Account's basket (or spill) `capacity` slots long and fills it with dust (one
    /// Gema each, won, due far away, from Sources no book exists for) until `free` slots are
    /// left. Dust is never drawn while the Account has other Gemas: it only takes room.
    fn fill_store(&mut self, p: &Person, spill: bool, capacity: usize, free: usize) {
        use tesoro_core::ledger::book::SourceBook;
        use tesoro_core::ledger::line_store::{LineStore, SIDE_WON};
        let key = if spill {
            spill_address(&p.account).0
        } else {
            basket_address(&p.account).0
        };
        let mut acc = self.svm.get_account(&s(key)).expect("store");
        acc.data.resize(store_len(capacity), 0);
        acc.lamports = self.svm.minimum_balance_for_rent_exemption(acc.data.len());
        {
            let mut st = LineStore::new(&mut acc.data[DISC..]).expect("store");
            let mut i = st.len() as u64;
            while st.len() < capacity - free {
                i += 1;
                let mut src = [0xEEu8; 32];
                src[..8].copy_from_slice(&i.to_le_bytes());
                let mut line =
                    SourceBook::blank_line(SIDE_WON, 10_000_000 + i as i64, src, CLASS_GENERAL, 0);
                line.amount = 1;
                st.insert(&line).expect("room for dust");
            }
        }
        self.svm.set_account(s(key), acc).expect("set store");
    }

    /// A grow of the Account's spill by `lines`, paid by `payer`, as an instruction (anyone may
    /// pay, the owner is not needed).
    fn grow_spill_ix(&self, payer: APk, account: APk, lines: u32) -> Instruction {
        ix(
            accounts::GrowStore {
                payer,
                account,
                basket: basket_address(&account).0,
                spill: spill_address(&account).0,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::GrowStore {
                which: tesoro_core::StoreKind::Spill,
                extra_lines: lines,
            },
            vec![],
        )
    }
}

/// Alice (two own lines of 500, so an entry of 1,000 takes both whole) with a basket and a spill
/// of `cap` slots each, both completely full.
fn full_alice(env: &mut Env, cap: usize) -> Person {
    let alice = env.person();
    env.grow_basket_to(&alice, 8);
    let sources: Vec<APk> = (0..2).map(|i| env.forge_source(100 + i, 0)).collect();
    env.give_lines(&alice, &sources, 500, |i| i as i64);
    env.fill_store(&alice, false, cap, 0);
    env.fill_store(&alice, true, cap, 0);
    assert_eq!(env.store_stats(&alice, false).0, cap);
    assert_eq!(env.store_stats(&alice, true).0, cap);
    alice
}

#[test]
fn a_player_with_full_stores_enters_and_gets_the_lines_back_with_no_room_and_no_help() {
    let mut env = Env::new();
    let alice = full_alice(&mut env, 40);
    env.skip_ensure = true;
    let before = env.total_gemas(&alice);
    let m = env
        .open_match(&alice, 1_000)
        .expect("a covered entry always opens");
    // the two whole lines left: two slots are free, and both are held for them
    assert_eq!(
        env.store_stats(&alice, false).0 + env.store_stats(&alice, true).0,
        78
    );
    assert_eq!(env.store_stats(&alice, true).2, 2);
    let room = env.mstate(m).room;
    assert_eq!(
        (room[0].account, room[0].left),
        (alice.account.to_bytes(), 2)
    );
    // nobody asked for room: nothing grew
    assert_eq!(env.store_stats(&alice, false).1, 40);
    assert_eq!(env.store_stats(&alice, true).1, 40);
    // the opener of an unjoined Match refunds it at once, and the lines come back by themselves
    let kp = alice.kp.insecure_clone();
    env.refund(&kp, m, vec![]).expect("refund and close");
    assert_eq!(env.total_gemas(&alice), before);
    assert_eq!(
        env.store_stats(&alice, false).0 + env.store_stats(&alice, true).0,
        80
    );
    assert_eq!(
        env.store_stats(&alice, true).2,
        0,
        "the hold is handed back at close"
    );
    assert_eq!(env.store_stats(&alice, false).1, 40);
    assert_eq!(env.store_stats(&alice, true).1, 40);
}

#[test]
fn a_player_with_both_stores_at_the_absolute_maximum_still_enters_and_refunds() {
    let mut env = Env::new();
    let alice = full_alice(&mut env, MAX_BASKET_LINES);
    env.skip_ensure = true;
    let before = env.total_gemas(&alice);
    let m = env
        .open_match(&alice, 1_000)
        .expect("a covered entry always opens");
    println!("open_match at the maximum: {} CU", env.last_cu);
    let kp = alice.kp.insecure_clone();
    env.refund(&kp, m, vec![]).expect("refund and close");
    assert_eq!(env.total_gemas(&alice), before);
    assert_eq!(env.store_stats(&alice, true).2, 0);
}

#[test]
fn a_full_opener_is_made_room_for_in_the_joiners_own_transaction_and_both_outcomes_settle_alone() {
    for result in [MatchResult::Opener, MatchResult::Joiner] {
        let mut env = Env::new();
        let alice = full_alice(&mut env, 40);
        let bob = env.person();
        let b_sources: Vec<APk> = (0..2).map(|i| env.forge_source(200 + i, 0)).collect();
        env.grow_basket_to(&bob, 8);
        env.give_lines(&bob, &b_sources, 500, |i| i as i64);
        env.skip_ensure = true;
        let m = env.open_match(&alice, 1_000).expect("open");
        // the joiner's lines (2) and the two extra lines a split can add need room in Alice's
        // stores on top of her own freed slots; the joiner's transaction grows her spill first
        let a_before = env.total_gemas(&alice);
        let b_before = env.total_gemas(&bob);
        let grow = env.grow_spill_ix(a(bob.kp.pubkey()), alice.account, 4);
        env.pre_ixs.push(grow);
        env.pot_nonce += 1;
        let nonce = env.pot_nonce;
        env.join_match_ix(
            &bob,
            m,
            nonce,
            4,
            ticket_pda(bob.account, nonce),
            env.books_of(bob.account),
            None,
        )
        .expect("join");
        let held: u32 = env
            .mstate(m)
            .room
            .iter()
            .filter(|h| h.account == alice.account.to_bytes())
            .map(|h| h.left)
            .sum();
        assert_eq!(
            held, 6,
            "her whole bound is held: 2 + 2 lines and 2 for splits"
        );
        assert_eq!(env.store_stats(&alice, true).2, 6);
        // no more help from anybody: the game settles, a stranger runs the chunks, the Match closes
        let game = env.game_auth.insecure_clone();
        env.settle(&game, m, result, vec![]).expect("settles alone");
        assert_eq!(env.store_stats(&alice, true).2, 0);
        assert_eq!(env.store_stats(&bob, true).2, 0);
        let (a_after, b_after) = (env.total_gemas(&alice), env.total_gemas(&bob));
        // Alice staked 1,000 before `a_before`; Bob staked his 1,000 at the join (inside `b_before`)
        match result {
            MatchResult::Opener => {
                assert!(
                    a_after > a_before + 1_700,
                    "her entry back and his, less the fees"
                );
                assert_eq!(b_after, b_before - 1_000);
            }
            _ => {
                assert_eq!(a_after, a_before);
                assert!(
                    b_after > b_before + 700,
                    "his entry back and hers, less the fees"
                );
            }
        }
        let fees = a_before + b_before + 1_000 - (a_after + b_after);
        assert!(
            (1..=300).contains(&fees),
            "only the fees left the two Accounts: {fees}"
        );
    }
}

#[test]
fn another_credit_cannot_take_a_slot_held_for_a_match() {
    let mut env = Env::new();
    let alice = full_alice(&mut env, 40);
    env.skip_ensure = true;
    let m = env.open_match(&alice, 1_000).expect("open");
    // two slots are free and both are held: a new Advance (one new line) must wait
    env.open_position_only(&alice, 9, 100 * SOL);
    let err = env
        .take_advance(&alice, position_pda(9), 0, 6, 150_000_000)
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::SpillFull));
    // one more free slot beyond the held two is enough for it, and only for it
    let grow = env.grow_spill_ix(alice.key, alice.account, 1);
    env.send(&[grow], &alice.kp.insecure_clone(), &[])
        .expect("grow");
    env.take_advance(&alice, position_pda(9), 0, 6, 150_000_000)
        .expect("a free slot beyond the hold");
    env.open_position_only(&alice, 10, 100 * SOL);
    let err = env
        .take_advance(&alice, position_pda(10), 0, 6, 150_000_000)
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::SpillFull));
    // the lines of the Match still come home
    let kp = alice.kp.insecure_clone();
    env.refund(&kp, m, vec![]).expect("refund");
    assert_eq!(env.store_stats(&alice, true).2, 0);
}

#[test]
fn an_outside_studios_fee_line_has_its_slot_held_and_cannot_be_crowded_out() {
    let mut d = duel();
    // the admin names someone else as Tesoro's studio: this Game's studio is an outside one
    let other = d.env.platform.account;
    set_tesoro_studio(&mut d.env, other);
    let studio = d.env.studio.account;
    let studio_person = Person {
        kp: d.env.studio.kp.insecure_clone(),
        key: d.env.studio.key,
        account: studio,
    };
    // the studio's stores have exactly the room the fee lines need, and nothing more
    let basket_cap = d.env.store_stats(&studio_person, false).1;
    d.env.fill_store(&studio_person, false, basket_cap, 0);
    d.env.fill_store(&studio_person, true, 4, 4);
    d.env.skip_studio_room = true;
    let m = d.env.open_match(&d.alice, ENTRY).expect("open");
    let mut remaining = d.env.books_of(d.bob.account);
    remaining.push(rem(basket_address(&studio).0));
    remaining.push(rem(spill_address(&studio).0));
    d.env.pot_nonce += 1;
    let nonce = d.env.pot_nonce;
    d.env
        .join_match_ix(
            &d.bob,
            m,
            nonce,
            4,
            ticket_pda(d.bob.account, nonce),
            remaining,
            None,
        )
        .expect("join");
    assert_eq!(
        d.env.store_stats(&studio_person, true).2,
        4,
        "the fee line's room is held"
    );
    // an Advance for the studio is one more line than the free room beyond the hold
    d.env.open_position_only(&studio_person, 21, 100 * SOL);
    let err = d
        .env
        .take_advance(&studio_person, position_pda(21), 0, 6, 150_000_000)
        .unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::SpillFull));
    let game = d.env.game_auth.insecure_clone();
    d.env
        .settle(&game, m, MatchResult::Opener, vec![])
        .expect("the fee line lands in its held slot");
    assert!(d.env.fee_gemas(&studio_person) > 0);
    assert_eq!(d.env.store_stats(&studio_person, true).2, 0);
}

// --- Ticket 09c: a credit that finds no room lands in an overflow record ----------------------------

impl Env {
    /// `closing` names the Match account: a Match's record is only closed once that Match is gone.
    fn claim_overflow_ix(
        &self,
        owner: APk,
        record: APk,
        payer: APk,
        max: u8,
        closing: Option<u64>,
    ) -> Instruction {
        ix(
            accounts::ClaimOverflow {
                account: owner,
                basket: basket_address(&owner).0,
                spill: spill_address(&owner).0,
                record,
                payer,
            },
            instruction::ClaimOverflow { max },
            closing
                .map(|id| rem(self.match_key(id)))
                .into_iter()
                .collect(),
        )
    }

    /// The lines of an overflow record.
    fn record_lines(&self, record: APk) -> Vec<tesoro_core::ledger::line_store::Line> {
        self.svm.get_account(&s(record)).map_or(vec![], |acc| {
            tesoro_core::ledger::line_store::LineStore::new(&acc.data[OVERFLOW_STORE_AT..])
                .expect("record")
                .lines()
                .collect()
        })
    }

    fn lamports(&self, k: APk) -> u64 {
        self.svm.get_account(&s(k)).map_or(0, |acc| acc.lamports)
    }
}

#[test]
fn an_outside_studio_at_its_maximum_gets_its_fee_line_in_an_overflow_record_and_claims_it_after_a_grow(
) {
    let mut d = duel();
    // the admin names someone else as Tesoro's studio: this Game's studio is an outside one
    let other = d.env.platform.account;
    set_tesoro_studio(&mut d.env, other);
    let studio = d.env.studio.account;
    let studio_person = Person {
        kp: d.env.studio.kp.insecure_clone(),
        key: d.env.studio.key,
        account: studio,
    };
    // the studio's stores are completely full and stay so
    let basket_cap = d.env.store_stats(&studio_person, false).1;
    d.env.fill_store(&studio_person, false, basket_cap, 0);
    d.env.fill_store(&studio_person, true, 4, 0);
    d.env.name_records = true;
    d.env.skip_studio_room = true;
    let m = d.env.open_match(&d.alice, ENTRY).expect("open");
    let bob_before = d.env.lamports(d.bob.key);
    d.env.join_match(&d.bob, m).expect("join");
    let seed = d.env.mstate(m).inner.id.seed();
    let record = overflow_address(&studio, OVERFLOW_MATCH, &seed).0;
    let rent = d.env.lamports(record);
    assert!(rent > 0, "the record exists, its rent paid by the joiner");
    assert!(
        bob_before - d.env.lamports(d.bob.key) >= rent,
        "the joiner paid it"
    );
    // nobody can close the empty record while the Match is open (the studio's guarantee)
    let early = d
        .env
        .claim_overflow_ix(studio, record, d.bob.key, 0, Some(m));
    let griefer = d.env.admin.insecure_clone();
    d.env.send(&[early], &griefer, &[]).expect("early claim");
    assert!(
        d.env.svm.get_account(&s(record)).is_some(),
        "an open Match keeps its record"
    );
    // the Match settles and closes with nobody's help: the studio's fee lands in the record
    let game = d.env.game_auth.insecure_clone();
    d.env
        .settle(&game, m, MatchResult::Opener, vec![])
        .expect("settles although the studio is full");
    assert_eq!(
        d.env.fee_gemas(&studio_person),
        0,
        "nothing fit in its stores"
    );
    let lines = d.env.record_lines(record);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].class, CLASS_STUDIO);
    assert_eq!(lines[0].amount, 60, "3% of the 2,000 Pot");
    // no room yet: a claim moves nothing and the record stays
    let caller = d.env.admin.insecure_clone();
    let claim = d
        .env
        .claim_overflow_ix(studio, record, d.bob.key, 4, Some(m));
    d.env
        .send(&[claim], &caller, &[])
        .expect("claim, nothing fits");
    assert_eq!(d.env.record_lines(record).len(), 1);
    // one more slot and the next claim moves the line and returns the rent to the joiner
    let grow = d.env.grow_spill_ix(a(caller.pubkey()), studio, 1);
    d.env.send(&[grow], &caller, &[]).expect("grow");
    let bob_mid = d.env.lamports(d.bob.key);
    let claim = d
        .env
        .claim_overflow_ix(studio, record, d.bob.key, 4, Some(m));
    d.env.send(&[claim], &caller, &[]).expect("claim");
    assert_eq!(d.env.fee_gemas(&studio_person), 60);
    assert!(
        d.env.svm.get_account(&s(record)).is_none(),
        "the record is closed"
    );
    assert_eq!(
        d.env.lamports(d.bob.key) - bob_mid,
        rent,
        "the rent is back"
    );
}

#[test]
fn a_backers_share_with_no_hold_and_full_stores_lands_in_an_overflow_record() {
    let mut b = backing_setup();
    // Carol's stores are full: her entry draws from one big line, so no slot is freed for it
    let carol = Person {
        kp: b.carol.kp.insecure_clone(),
        key: b.carol.key,
        account: b.carol.account,
    };
    let cap = b.d.env.store_stats(&carol, false).1;
    b.d.env.fill_store(&carol, false, cap.max(8), 0);
    b.d.env.fill_store(&carol, true, 4, 0);
    b.d.env.name_records = true;
    b.d.env.skip_ensure = true;
    let request = b.request(1, 500);
    let offer = b.offer(1, 500, 4_000, None);
    b.accept_public(offer, request);
    let id = b.open_backed(offer, 500).expect("backed entry");
    b.d.env.join_match(&b.d.bob, id).expect("join");
    let seed = b.d.env.mstate(id).inner.id.seed();
    let record = overflow_address(&carol.account, OVERFLOW_MATCH, &seed).0;
    assert!(b.d.env.lamports(record) > 0, "reserved at the join");
    let game = b.d.env.game_auth.insecure_clone();
    b.d.env
        .settle(&game, id, MatchResult::Opener, vec![])
        .expect("settles although the Backer is full");
    // Dave got his 180 in his own stores; Carol's 270 of Bob's Source is waiting in the record
    assert_eq!(b.d.env.total_gemas(&b.dave), 180);
    let lines = b.d.env.record_lines(record);
    assert_eq!(lines.iter().map(|l| l.amount).sum::<u64>(), 270);
    let caller = b.d.env.admin.insecure_clone();
    let grow = b.d.env.grow_spill_ix(a(caller.pubkey()), carol.account, 1);
    b.d.env.send(&[grow], &caller, &[]).expect("grow");
    let claim =
        b.d.env
            .claim_overflow_ix(carol.account, record, b.dave.key, 4, Some(id));
    // the line has its own Source: the claim needs no book unless it merges
    b.d.env.send(&[claim], &caller, &[]).expect("claim");
    assert_eq!(b.d.env.gemas_of(&b.carol, b.d.b_source), 270);
    assert!(b.d.env.svm.get_account(&s(record)).is_none());
}

#[test]
fn a_ticket_cancel_that_finds_no_room_for_a_split_line_keeps_it_in_the_ticket_until_room_is_made() {
    let mut env = Env::new();
    let alice = env.person();
    env.grow_basket_to(&alice, 8);
    let sources: Vec<APk> = (0..2).map(|i| env.forge_source(100 + i, 0)).collect();
    env.give_lines(&alice, &sources, 500, |i| i as i64);
    env.fill_store(&alice, false, 40, 0);
    env.fill_store(&alice, true, 40, 0);
    env.skip_ensure = true;
    let books: Vec<AccountMeta> = sources
        .iter()
        .flat_map(|src| book_metas(&env.svm, *src))
        .collect();
    // an Entry Ticket of 600 takes the first line whole (its slot is held) and 100 of the second
    env.open_ticket(&alice, 4, 600, 3)
        .expect("a ticket opens on full stores");
    let kp = alice.kp.insecure_clone();
    env.stage_with(&kp, &alice, 4, 20, books.clone())
        .expect("stage");
    assert_eq!(env.load_ticket_staged(&alice, 4), 600);
    // another entry then takes the rest of that second line whole and the freed slot is filled
    // by someone else's credit: the split part has nowhere to go
    {
        use tesoro_core::ledger::line_store::LineStore;
        let store = basket_address(&alice.account).0;
        let mut acc = env.svm.get_account(&s(store)).expect("basket");
        {
            let mut st = LineStore::new(&mut acc.data[DISC..]).expect("basket");
            let idx = st
                .lines()
                .position(|l| l.source == sources[1].to_bytes())
                .expect("the rest of the second line");
            st.remove_at(idx).expect("removed");
            // someone else's credit takes the freed slot
            let mut dust = tesoro_core::ledger::book::SourceBook::blank_line(
                SIDE_WON,
                99_999_999,
                [0xDD; 32],
                CLASS_GENERAL,
                0,
            );
            dust.amount = 1;
            st.insert(&dust).expect("the freed slot");
        }
        env.svm.set_account(s(store), acc).expect("set basket");
    }
    // the cancel returns the slowest line (the split part) into the held slot and keeps the next
    // one in the Ticket, without an error
    env.cancel_ticket_with(&kp, &alice, 4, 20, books.clone())
        .expect("a cancel never fails for room");
    assert_eq!(
        env.ticket_state(&alice, 4),
        tesoro_core::ledger::draw::TicketState::Cancelling
    );
    assert_eq!(
        env.load_ticket_staged(&alice, 4),
        500,
        "the other line waits in the Ticket"
    );
    assert_eq!(
        env.gemas_of(&alice, sources[1]),
        100,
        "the split part came home"
    );
    // one more slot and the next cancel finishes; the Ticket closes
    let grow = env.grow_spill_ix(alice.key, alice.account, 1);
    env.send(&[grow], &kp, &[]).expect("grow");
    env.cancel_ticket_with(&kp, &alice, 4, 20, books)
        .expect("cancel");
    assert_eq!(
        env.ticket_state(&alice, 4),
        tesoro_core::ledger::draw::TicketState::Cancelled
    );
    assert_eq!(env.gemas_of(&alice, sources[0]), 500);
    env.close_ticket(&kp, &alice, 4).expect("close");
}

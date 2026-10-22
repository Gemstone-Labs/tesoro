//! Baskets, spills, the sponsor, Source books and checkpoint pages (ticket 08), driven through
//! the built program in LiteSVM (`pnpm build:programs` first).
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey as APk;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::account::Account;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey as Pk;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use tesoro_core::ledger::book::checkpoint::NoCheckpoints;
use tesoro_core::ledger::book::SourceBook;
use tesoro_core::ledger::line_store::{
    Line, LineStore, CLASS_GENERAL, CLASS_LEADERBOARD, CLASS_PLATFORM, CLASS_STUDIO, LINE_LEN,
    SIDE_OWN, SIDE_WON,
};
use tesoro_core::ledger::Source;
use tesoro_core::state::*;
use tesoro_core::storage::*;
use tesoro_core::{accounts, instruction, StoreKind};

const SOL: u64 = 1_000_000_000;
type Failed = litesvm::types::FailedTransactionMetadata;

// error codes
const UNAUTHORIZED: u32 = 6000;
const NOTHING_TO_RESIZE: u32 = 6300;
const STORE_AT_MAXIMUM: u32 = 6301;
const GROW_TOO_LARGE: u32 = 6302;
const SPONSOR_PAUSED: u32 = 6303;
const NOT_SPONSOR_RELAYER: u32 = 6304;
const ACCOUNT_SPONSOR_CAP: u32 = 6305;
const TOTAL_SPONSOR_CAP: u32 = 6306;
const SPONSOR_SHORT: u32 = 6307;
const CAP_BELOW_OUTSTANDING: u32 = 6308;
const FEE_COUNTER_ONLY: u32 = 6310;
const DUPLICATE_BOOK: u32 = 6313;
const ACCOUNT_NOT_WRITABLE: u32 = 6315;
const WRONG_PAGE: u32 = 6316;
const CONSTRAINT_SEEDS: u32 = 2006;
const MISSING_SIGNER: u32 = 3010;

fn a(p: Pk) -> APk {
    APk::new_from_array(p.to_bytes())
}
fn s(p: APk) -> Pk {
    Pk::new_from_array(p.to_bytes())
}
fn pda(seeds: &[&[u8]]) -> APk {
    APk::find_program_address(seeds, &tesoro_core::ID).0
}
fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id: s(tesoro_core::ID),
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
fn custom_code(err: &Failed) -> u32 {
    use solana_sdk::instruction::InstructionError;
    use solana_sdk::transaction::TransactionError;
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => *c,
        other => panic!("unexpected error {other:?}\n{:?}", err.meta.logs),
    }
}

const LOADER: &str = "BPFLoaderUpgradeab1e11111111111111111111111";

fn deploy_with_authority(svm: &mut LiteSVM, program_id: Pk, so: &str, authority: Pk) {
    svm.add_program_from_file(program_id, so)
        .expect("build the program first: pnpm build:programs");
    let loader: Pk = LOADER.parse().expect("loader id");
    let programdata = Pk::find_program_address(&[program_id.as_ref()], &loader).0;
    let mut account = svm.get_account(&programdata).expect("programdata");
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(programdata, account).expect("set account");
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    relayer: Keypair,
    last_cu: u64,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        deploy_with_authority(
            &mut svm,
            s(tesoro_core::ID),
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../target/deploy/tesoro_core.so"
            ),
            Pk::new_unique(),
        );
        let mut env = Self {
            svm,
            admin: Keypair::new(),
            relayer: Keypair::new(),
            last_cu: 0,
        };
        env.svm.airdrop(&env.admin.pubkey(), 100 * SOL).unwrap();
        env.svm.airdrop(&env.relayer.pubkey(), 10 * SOL).unwrap();
        let admin = env.admin.insecure_clone();
        let platform = env.create_account(&admin);
        env.send(
            &[ix(
                accounts::InitializeConfig {
                    admin: a(admin.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    platform_recipient: platform,
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::InitializeConfig {
                    oracle_authority: APk::new_unique(),
                    platform_bps: 200,
                },
            )],
            &[&admin],
        )
        .expect("init config");
        env
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), Failed> {
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&signers[0].pubkey()),
            signers,
            self.svm.latest_blockhash(),
        );
        let meta = self.svm.send_transaction(tx)?;
        self.last_cu = meta.compute_units_consumed;
        Ok(())
    }

    /// A funded Person with an Account (basket and spill included).
    fn person(&mut self) -> (Keypair, APk) {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 20 * SOL).unwrap();
        let account = self.create_account(&kp);
        (kp, account)
    }

    fn create_account(&mut self, kp: &Keypair) -> APk {
        let authority = a(kp.pubkey());
        let account = pda(&[ACCOUNT_SEED, authority.as_ref()]);
        self.send(
            &[ix(
                accounts::CreateAccount {
                    authority,
                    account,
                    basket: basket_address(&account).0,
                    spill: spill_address(&account).0,
                    invite_gate: invite_gate_pda(),
                    system_program: anchor_lang::system_program::ID,
                    payer: authority,
                    sponsor: None,
                },
                instruction::CreateAccount {
                    evm_address: [0; 20],
                },
            )],
            &[kp],
        )
        .expect("create account");
        account
    }

    fn init_sponsor(&mut self, per_account: u64, total: u64, pages: u64, fund: u64) {
        let admin = self.admin.insecure_clone();
        self.send(
            &[ix(
                accounts::InitSponsor {
                    admin: a(admin.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    sponsor: sponsor_address().0,
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::InitSponsor {
                    relayer: a(self.relayer.pubkey()),
                    per_account_cap: per_account,
                    total_cap: total,
                    pages_cap: pages,
                },
            )],
            &[&admin],
        )
        .expect("init sponsor");
        self.svm.airdrop(&s(sponsor_address().0), fund).unwrap();
    }

    fn set_sponsor(
        &mut self,
        signer: &Keypair,
        paused: bool,
        per_account: u64,
        total: u64,
        pages: u64,
    ) -> Result<(), Failed> {
        self.send(
            &[ix(
                accounts::SetSponsor {
                    admin: a(signer.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    sponsor: sponsor_address().0,
                },
                instruction::SetSponsor {
                    relayer: a(self.relayer.pubkey()),
                    paused,
                    per_account_cap: per_account,
                    total_cap: total,
                    pages_cap: pages,
                },
            )],
            &[signer],
        )
    }

    fn grow(
        &mut self,
        payer: &Keypair,
        account: APk,
        which: StoreKind,
        n: u32,
    ) -> Result<(), Failed> {
        self.send(&[grow_ix(payer.pubkey(), account, which, n)], &[payer])
    }

    fn grow_sponsored(
        &mut self,
        relayer: &Keypair,
        account: APk,
        which: StoreKind,
        n: u32,
    ) -> Result<(), Failed> {
        self.send(
            &[grow_sponsored_ix(relayer.pubkey(), account, which, n)],
            &[relayer],
        )
    }

    fn shrink(
        &mut self,
        owner: &Keypair,
        account: APk,
        which: StoreKind,
        keep_free: u32,
    ) -> Result<(), Failed> {
        self.send(
            &[ix(
                accounts::ShrinkStore {
                    authority: a(owner.pubkey()),
                    account,
                    basket: basket_address(&account).0,
                    spill: spill_address(&account).0,
                    sponsor: sponsor_address().0,
                },
                instruction::ShrinkStore { which, keep_free },
            )],
            &[owner],
        )
    }

    fn lamports(&self, k: APk) -> u64 {
        self.svm.get_account(&s(k)).map_or(0, |acc| acc.lamports)
    }

    fn data(&self, k: APk) -> Vec<u8> {
        self.svm.get_account(&s(k)).expect("account").data
    }

    fn sponsor(&self) -> SponsorState {
        SponsorState::try_deserialize(&mut &self.data(sponsor_address().0)[..]).expect("sponsor")
    }

    fn capacity(&self, store: APk) -> usize {
        let d = self.data(store);
        LineStore::new(&d[DISC..]).expect("store").capacity()
    }

    fn sponsored(&self, store: APk) -> u64 {
        let d = self.data(store);
        LineStore::new(&d[DISC..])
            .expect("store")
            .sponsored_lamports()
    }

    /// Insert forged lines straight into a store (what settle and refund will do in ticket 09).
    fn put_lines(&mut self, store: APk, lines: &[Line]) {
        let mut acc = self.svm.get_account(&s(store)).expect("store");
        {
            let mut st = LineStore::new(&mut acc.data[DISC..]).expect("store");
            for l in lines {
                st.insert(l).expect("room for the forged line");
            }
        }
        self.svm.set_account(s(store), acc).unwrap();
    }

    fn lines(&self, store: APk) -> Vec<Line> {
        let d = self.data(store);
        LineStore::new(&d[DISC..]).expect("store").lines().collect()
    }

    fn claim(&mut self, account: APk, max: u8, books: Vec<APk>) -> Result<(), Failed> {
        let payer = Keypair::new();
        self.svm.airdrop(&payer.pubkey(), SOL).unwrap();
        let mut i = ix(
            accounts::ClaimSpill {
                account,
                basket: basket_address(&account).0,
                spill: spill_address(&account).0,
            },
            instruction::ClaimSpill { max },
        );
        for b in books {
            i.accounts.push(AccountMeta::new(s(b), false));
        }
        self.send(&[i], &[&payer])
    }

    /// A Source account that exists on chain (forged), and its book.
    fn source_with_book(&mut self, index: u32) -> (APk, APk) {
        let position = [9u8; 32];
        let source_key = pda(&[SOURCE_SEED, &position, &index.to_le_bytes()]);
        let (_, bump) = APk::find_program_address(
            &[SOURCE_SEED, &position, &index.to_le_bytes()],
            &tesoro_core::ID,
        );
        let state = SourceState {
            bump,
            inner: Source {
                position,
                owner: [1; 32],
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
        let mut data = Vec::new();
        state.try_serialize(&mut data).unwrap();
        self.svm
            .set_account(
                s(source_key),
                Account {
                    lamports: self.svm.minimum_balance_for_rent_exemption(data.len()),
                    data,
                    owner: s(tesoro_core::ID),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let payer = Keypair::new();
        self.svm.airdrop(&payer.pubkey(), 5 * SOL).unwrap();
        let book = book_address(&source_key).0;
        self.send(
            &[ix(
                accounts::InitSourceBook {
                    payer: a(payer.pubkey()),
                    source: source_key,
                    book,
                    system_program: anchor_lang::system_program::ID,
                },
                instruction::InitSourceBook {},
            )],
            &[&payer],
        )
        .expect("init source book");
        (source_key, book)
    }
}

fn grow_ix(payer: Pk, account: APk, which: StoreKind, n: u32) -> Instruction {
    ix(
        accounts::GrowStore {
            payer: a(payer),
            account,
            basket: basket_address(&account).0,
            spill: spill_address(&account).0,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::GrowStore {
            which,
            extra_lines: n,
        },
    )
}

fn grow_sponsored_ix(relayer: Pk, account: APk, which: StoreKind, n: u32) -> Instruction {
    ix(
        accounts::GrowStoreSponsored {
            relayer: a(relayer),
            sponsor: sponsor_address().0,
            account,
            basket: basket_address(&account).0,
            spill: spill_address(&account).0,
        },
        instruction::GrowStoreSponsored {
            which,
            extra_lines: n,
        },
    )
}

fn won(source: [u8; 32], due: i64, class: u8, amount: u64) -> Line {
    let mut l = SourceBook::blank_line(SIDE_WON, due, source, class, 0);
    l.amount = amount;
    l
}

fn own(source: [u8; 32], class: u8, amount: u64) -> Line {
    let mut l = SourceBook::blank_line(SIDE_OWN, 0, source, class, 0);
    l.amount = amount;
    l
}

fn rent(env: &Env, len: usize) -> u64 {
    env.svm.minimum_balance_for_rent_exemption(len)
}

// ---------------------------------------------------------------------------------------------
// create_account
// ---------------------------------------------------------------------------------------------

#[test]
fn create_account_makes_the_basket_and_the_spill() {
    let mut env = Env::new();
    let (kp, account) = env.person();
    let basket = basket_address(&account).0;
    let spill = spill_address(&account).0;
    for (store, lines, seed_bump) in [
        (basket, INITIAL_BASKET_LINES, basket_address(&account).1),
        (spill, 0, spill_address(&account).1),
    ] {
        let acc = env.svm.get_account(&s(store)).expect("store exists");
        assert_eq!(acc.owner, s(tesoro_core::ID));
        assert_eq!(acc.data.len(), store_len(lines));
        assert_eq!(
            acc.lamports,
            rent(&env, acc.data.len()),
            "rent exempt, no more"
        );
        let st = LineStore::new(&acc.data[DISC..]).expect("formatted");
        assert_eq!(st.bump(), seed_bump);
        assert_eq!(st.account(), account.to_bytes());
        assert_eq!((st.len(), st.capacity()), (0, lines));
        assert_eq!(st.sponsored_lamports(), 0);
    }
    // the discriminators are Anchor's, so a stray account of this program cannot pass for a store
    let d = env.data(basket);
    assert_eq!(
        &d[..DISC],
        <BasketHead as anchor_lang::Discriminator>::DISCRIMINATOR
    );
    let d = env.data(spill);
    assert_eq!(
        &d[..DISC],
        <SpillHead as anchor_lang::Discriminator>::DISCRIMINATOR
    );
    // creating twice fails (the stores exist)
    let again = env.send(
        &[ix(
            accounts::InitStores {
                payer: a(kp.pubkey()),
                account,
                basket,
                spill,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitStores {},
        )],
        &[&kp],
    );
    assert!(again.is_err());
}

#[test]
fn init_stores_gives_an_existing_account_its_baskets() {
    // The Pool and the Treasury are TesoroAccounts created without a basket: forge one.
    let mut env = Env::new();
    let payer = Keypair::new();
    env.svm.airdrop(&payer.pubkey(), 5 * SOL).unwrap();
    let authority = APk::new_unique();
    let (account, bump) =
        APk::find_program_address(&[ACCOUNT_SEED, authority.as_ref()], &tesoro_core::ID);
    let state = TesoroAccount {
        bump,
        authority,
        evm_address: [0; 20],
    };
    let mut data = Vec::new();
    state.try_serialize(&mut data).unwrap();
    env.svm
        .set_account(
            s(account),
            Account {
                lamports: rent(&env, data.len()),
                data,
                owner: s(tesoro_core::ID),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    env.send(
        &[ix(
            accounts::InitStores {
                payer: a(payer.pubkey()),
                account,
                basket: basket_address(&account).0,
                spill: spill_address(&account).0,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitStores {},
        )],
        &[&payer],
    )
    .expect("init stores");
    assert_eq!(
        env.capacity(basket_address(&account).0),
        INITIAL_BASKET_LINES
    );
    assert_eq!(env.capacity(spill_address(&account).0), 0);
}

// ---------------------------------------------------------------------------------------------
// grow with your own lamports
// ---------------------------------------------------------------------------------------------

#[test]
fn anyone_can_grow_a_basket_and_the_rent_is_a_gift() {
    let mut env = Env::new();
    let (_owner, account) = env.person();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 5 * SOL).unwrap();
    let basket = basket_address(&account).0;
    let before = env.svm.get_balance(&stranger.pubkey()).unwrap();
    env.grow(&stranger, account, StoreKind::Basket, 20).unwrap();
    let after = env.svm.get_balance(&stranger.pubkey()).unwrap();
    let want = rent(&env, store_len(INITIAL_BASKET_LINES + 20))
        - rent(&env, store_len(INITIAL_BASKET_LINES));
    assert_eq!(
        before - after - 5_000,
        want,
        "the stranger paid exactly the rent of 20 lines"
    );
    assert_eq!(env.capacity(basket), INITIAL_BASKET_LINES + 20);
    assert_eq!(
        env.lamports(basket),
        rent(&env, store_len(INITIAL_BASKET_LINES + 20))
    );
    assert_eq!(env.sponsored(basket), 0, "a gift is not sponsored rent");
    // the spill grows the same way
    env.grow(&stranger, account, StoreKind::Spill, 3).unwrap();
    assert_eq!(env.capacity(spill_address(&account).0), 3);
}

#[test]
fn growing_has_limits() {
    let mut env = Env::new();
    let (kp, account) = env.person();
    let e = env.grow(&kp, account, StoreKind::Basket, 0).unwrap_err();
    assert_eq!(custom_code(&e), NOTHING_TO_RESIZE);
    let e = env
        .grow(&kp, account, StoreKind::Basket, MAX_GROW_LINES as u32 + 1)
        .unwrap_err();
    assert_eq!(custom_code(&e), GROW_TOO_LARGE);
    // another Account's basket does not pass for this Account's
    let (_o2, other) = env.person();
    let mut i = grow_ix(kp.pubkey(), account, StoreKind::Basket, 1);
    i.accounts[2] = AccountMeta::new(s(basket_address(&other).0), false);
    let e = env.send(&[i], &[&kp]).unwrap_err();
    assert_eq!(custom_code(&e), CONSTRAINT_SEEDS);
}

#[test]
fn a_store_stops_at_its_maximum() {
    let mut env = Env::new();
    let (kp, account) = env.person();
    env.svm.airdrop(&kp.pubkey(), 1_000 * SOL).unwrap();
    let basket = basket_address(&account).0;
    let mut have = INITIAL_BASKET_LINES;
    while have + MAX_GROW_LINES <= MAX_BASKET_LINES {
        env.grow(&kp, account, StoreKind::Basket, MAX_GROW_LINES as u32)
            .unwrap();
        have += MAX_GROW_LINES;
    }
    let rest = (MAX_BASKET_LINES - have) as u32;
    if rest > 0 {
        env.grow(&kp, account, StoreKind::Basket, rest).unwrap();
    }
    assert_eq!(env.capacity(basket), MAX_BASKET_LINES);
    let e = env.grow(&kp, account, StoreKind::Basket, 1).unwrap_err();
    assert_eq!(custom_code(&e), STORE_AT_MAXIMUM);
}

// ---------------------------------------------------------------------------------------------
// sponsored growth
// ---------------------------------------------------------------------------------------------

fn line_rent(env: &Env, from: usize, to: usize) -> u64 {
    rent(env, store_len(to)) - rent(env, store_len(from))
}

#[test]
fn sponsored_growth_needs_the_relayers_signature() {
    let mut env = Env::new();
    let (_kp, account) = env.person();
    env.init_sponsor(10 * SOL, 100 * SOL, SOL, 50 * SOL);
    let basket = basket_address(&account).0;

    // a stranger signing in the relayer's place is refused
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let e = env
        .grow_sponsored(&stranger, account, StoreKind::Basket, 10)
        .unwrap_err();
    assert_eq!(custom_code(&e), NOT_SPONSOR_RELAYER);

    // the relayer's key without its signature is refused too
    let mut i = grow_sponsored_ix(env.relayer.pubkey(), account, StoreKind::Basket, 10);
    i.accounts[0].is_signer = false;
    let e = env.send(&[i], &[&stranger]).unwrap_err();
    assert_eq!(custom_code(&e), MISSING_SIGNER);
    assert_eq!(env.capacity(basket), INITIAL_BASKET_LINES, "nothing grew");

    // the relayer's signature grows it from the sponsor's SOL, and it is recorded twice
    let relayer = env.relayer.insecure_clone();
    let sponsor_before = env.lamports(sponsor_address().0);
    let relayer_before = env.svm.get_balance(&relayer.pubkey()).unwrap();
    env.grow_sponsored(&relayer, account, StoreKind::Basket, 10)
        .unwrap();
    let paid = line_rent(&env, INITIAL_BASKET_LINES, INITIAL_BASKET_LINES + 10);
    assert_eq!(env.capacity(basket), INITIAL_BASKET_LINES + 10);
    assert_eq!(env.sponsored(basket), paid);
    assert_eq!(env.sponsor().outstanding, paid);
    assert_eq!(sponsor_before - env.lamports(sponsor_address().0), paid);
    assert_eq!(
        relayer_before - env.svm.get_balance(&relayer.pubkey()).unwrap(),
        5_000,
        "the relayer only paid the transaction fee"
    );
    assert_eq!(
        env.lamports(basket),
        rent(&env, store_len(INITIAL_BASKET_LINES + 10))
    );
}

#[test]
fn sponsored_growth_respects_pause_and_both_caps() {
    let mut env = Env::new();
    let (_k1, one) = env.person();
    let (_k2, two) = env.person();
    let relayer = env.relayer.insecure_clone();
    let ten = line_rent(&env, INITIAL_BASKET_LINES, INITIAL_BASKET_LINES + 10);
    // per Account: room for 10 lines; total: room for 15 lines
    let per = ten;
    let total = line_rent(&env, INITIAL_BASKET_LINES, INITIAL_BASKET_LINES + 15);
    env.init_sponsor(per, total, SOL, 50 * SOL);

    env.grow_sponsored(&relayer, one, StoreKind::Basket, 10)
        .unwrap();
    // the per-Account cap spans basket and spill together
    let e = env
        .grow_sponsored(&relayer, one, StoreKind::Spill, 1)
        .unwrap_err();
    assert_eq!(custom_code(&e), ACCOUNT_SPONSOR_CAP);
    let e = env
        .grow_sponsored(&relayer, one, StoreKind::Basket, 1)
        .unwrap_err();
    assert_eq!(custom_code(&e), ACCOUNT_SPONSOR_CAP);
    // total cap: another Account may take 5 more lines but not 6
    let e = env
        .grow_sponsored(&relayer, two, StoreKind::Basket, 6)
        .unwrap_err();
    assert_eq!(custom_code(&e), TOTAL_SPONSOR_CAP);
    env.grow_sponsored(&relayer, two, StoreKind::Basket, 5)
        .unwrap();
    let e = env
        .grow_sponsored(&relayer, two, StoreKind::Basket, 1)
        .unwrap_err();
    assert_eq!(custom_code(&e), TOTAL_SPONSOR_CAP);

    // pause: nothing is sponsored; only the admin changes it
    let admin = env.admin.insecure_clone();
    let (outsider, _) = env.person();
    let e = env
        .set_sponsor(&outsider, true, per, total, SOL)
        .unwrap_err();
    assert_eq!(custom_code(&e), UNAUTHORIZED);
    env.set_sponsor(&admin, true, per * 10, total * 10, SOL)
        .unwrap();
    let e = env
        .grow_sponsored(&relayer, two, StoreKind::Basket, 1)
        .unwrap_err();
    assert_eq!(custom_code(&e), SPONSOR_PAUSED);
    // a Player with SOL can always grow for themselves while sponsoring is paused
    env.grow(&outsider, two, StoreKind::Basket, 1).unwrap();
    // caps cannot be set below what is outstanding
    let e = env.set_sponsor(&admin, false, per, 1, SOL).unwrap_err();
    assert_eq!(custom_code(&e), CAP_BELOW_OUTSTANDING);
}

#[test]
fn the_sponsor_never_spends_its_own_rent_or_more_than_it_holds() {
    let mut env = Env::new();
    let (_k, account) = env.person();
    let relayer = env.relayer.insecure_clone();
    env.init_sponsor(100 * SOL, 100 * SOL, SOL, 0);
    // funded with less than 10 lines cost
    let ten = line_rent(&env, INITIAL_BASKET_LINES, INITIAL_BASKET_LINES + 10);
    env.svm.airdrop(&s(sponsor_address().0), ten - 1).unwrap();
    let e = env
        .grow_sponsored(&relayer, account, StoreKind::Basket, 10)
        .unwrap_err();
    assert_eq!(custom_code(&e), SPONSOR_SHORT);
    env.svm.airdrop(&s(sponsor_address().0), 1).unwrap();
    env.grow_sponsored(&relayer, account, StoreKind::Basket, 10)
        .unwrap();
    assert!(
        env.lamports(sponsor_address().0) >= rent(&env, SponsorState::SPACE),
        "the sponsor account stays rent exempt"
    );
}

// ---------------------------------------------------------------------------------------------
// shrink
// ---------------------------------------------------------------------------------------------

#[test]
fn shrink_refunds_the_sponsor_first_and_the_owner_gets_the_rest() {
    let mut env = Env::new();
    let (owner, account) = env.person();
    let relayer = env.relayer.insecure_clone();
    env.init_sponsor(100 * SOL, 100 * SOL, SOL, 50 * SOL);
    let basket = basket_address(&account).0;

    // the sponsor paid for 10 lines, the owner then added 10 of their own
    env.grow_sponsored(&relayer, account, StoreKind::Basket, 10)
        .unwrap();
    env.grow(&owner, account, StoreKind::Basket, 10).unwrap();
    let sponsored = env.sponsored(basket);
    assert!(sponsored > 0);
    assert_eq!(env.sponsor().outstanding, sponsored);

    // keep 2 free slots: 18 slots are freed, worth more than the sponsor's 10
    let sponsor_before = env.lamports(sponsor_address().0);
    let owner_before = env.svm.get_balance(&owner.pubkey()).unwrap();
    env.shrink(&owner, account, StoreKind::Basket, 2).unwrap();
    assert_eq!(env.capacity(basket), 2);
    let freed = rent(&env, store_len(INITIAL_BASKET_LINES + 20)) - rent(&env, store_len(2));
    assert_eq!(
        env.lamports(sponsor_address().0) - sponsor_before,
        sponsored,
        "the sponsor got back everything it paid"
    );
    assert_eq!(
        env.svm.get_balance(&owner.pubkey()).unwrap() - owner_before + 5_000,
        freed - sponsored,
        "the owner got the rest"
    );
    assert_eq!(env.sponsored(basket), 0);
    assert_eq!(env.sponsor().outstanding, 0);
    assert_eq!(env.lamports(basket), rent(&env, store_len(2)));
}

#[test]
fn shrink_refunds_only_what_is_freed_when_that_is_less_than_the_sponsor_paid() {
    let mut env = Env::new();
    let (owner, account) = env.person();
    let relayer = env.relayer.insecure_clone();
    env.init_sponsor(100 * SOL, 100 * SOL, SOL, 50 * SOL);
    let basket = basket_address(&account).0;
    env.grow_sponsored(&relayer, account, StoreKind::Basket, 20)
        .unwrap();
    let sponsored = env.sponsored(basket);
    // free only 5 of the 24 slots
    env.shrink(&owner, account, StoreKind::Basket, 19).unwrap();
    let freed = rent(&env, store_len(INITIAL_BASKET_LINES + 20)) - rent(&env, store_len(19));
    assert!(freed < sponsored);
    assert_eq!(env.sponsored(basket), sponsored - freed);
    assert_eq!(env.sponsor().outstanding, sponsored - freed);
    // nothing left to free
    let e = env
        .shrink(&owner, account, StoreKind::Basket, 19)
        .unwrap_err();
    assert_eq!(custom_code(&e), NOTHING_TO_RESIZE);
}

#[test]
fn only_the_owner_shrinks_and_used_lines_stay() {
    let mut env = Env::new();
    let (owner, account) = env.person();
    let (thief, _their) = env.person();
    env.init_sponsor(100 * SOL, 100 * SOL, SOL, 50 * SOL);
    env.grow(&owner, account, StoreKind::Basket, 6).unwrap();
    let basket = basket_address(&account).0;
    env.put_lines(
        basket,
        &[
            own([1; 32], CLASS_GENERAL, 10),
            won([2; 32], 5, CLASS_GENERAL, 7),
        ],
    );
    // the thief names the owner's Account but signs as themselves
    let mut i = ix(
        accounts::ShrinkStore {
            authority: a(thief.pubkey()),
            account,
            basket,
            spill: spill_address(&account).0,
            sponsor: sponsor_address().0,
        },
        instruction::ShrinkStore {
            which: StoreKind::Basket,
            keep_free: 0,
        },
    );
    i.accounts[0] = AccountMeta::new(s(a(thief.pubkey())), true);
    let e = env.send(&[i], &[&thief]).unwrap_err();
    assert_eq!(custom_code(&e), CONSTRAINT_SEEDS);
    // the owner's shrink keeps both lines
    env.shrink(&owner, account, StoreKind::Basket, 0).unwrap();
    assert_eq!(env.capacity(basket), 2);
    assert_eq!(env.lines(basket).len(), 2);
}

#[test]
fn a_spill_keeps_the_room_reserved_for_matches() {
    let mut env = Env::new();
    let (owner, account) = env.person();
    env.init_sponsor(100 * SOL, 100 * SOL, SOL, 50 * SOL);
    let spill = spill_address(&account).0;
    env.grow(&owner, account, StoreKind::Spill, 12).unwrap();
    // a Match in flight reserved 5 slots (ticket 09 sets this through the same header field)
    let mut acc = env.svm.get_account(&s(spill)).unwrap();
    LineStore::new(&mut acc.data[DISC..])
        .unwrap()
        .set_room_reserved(5);
    env.svm.set_account(s(spill), acc).unwrap();
    env.shrink(&owner, account, StoreKind::Spill, 0).unwrap();
    // the held slots are those of the basket and the spill together: the basket's 4 free slots
    // count, so the spill keeps only the fifth
    assert_eq!(
        env.capacity(spill),
        1,
        "the slots the basket cannot cover stayed"
    );
    // and the basket may not give up the free slots the hold relies on
    let basket = basket_address(&account).0;
    let e = env
        .shrink(&owner, account, StoreKind::Basket, 0)
        .unwrap_err();
    assert_eq!(custom_code(&e), NOTHING_TO_RESIZE);
    assert_eq!(env.capacity(basket), 4);
}

// ---------------------------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------------------------

#[test]
fn claim_moves_spill_lines_into_the_basket_while_it_has_room() {
    let mut env = Env::new();
    let (owner, account) = env.person();
    let basket = basket_address(&account).0;
    let spill = spill_address(&account).0;
    env.grow(&owner, account, StoreKind::Spill, 4).unwrap();
    env.put_lines(
        spill,
        &[
            won([3; 32], 10, CLASS_GENERAL, 5),
            won([4; 32], 20, CLASS_GENERAL, 6),
            won([5; 32], 30, CLASS_GENERAL, 7),
        ],
    );
    // two claimed
    env.claim(account, 2, vec![]).unwrap();
    assert_eq!(env.lines(basket).len(), 2);
    assert_eq!(env.lines(spill).len(), 1);
    // the rest; the basket total follows the lines
    env.claim(account, 10, vec![]).unwrap();
    assert!(env.lines(spill).is_empty());
    let d = env.data(basket);
    let st = LineStore::new(&d[DISC..]).unwrap();
    assert_eq!(st.won_total(), 18);
    st.check().unwrap();
    let keys: Vec<_> = st.lines().map(|l| l.due_at).collect();
    assert_eq!(keys, vec![10, 20, 30], "sorted");
}

#[test]
fn claim_stops_quietly_when_the_basket_is_full() {
    let mut env = Env::new();
    let (owner, account) = env.person();
    let basket = basket_address(&account).0;
    let spill = spill_address(&account).0;
    let fill: Vec<Line> = (0..INITIAL_BASKET_LINES as u8)
        .map(|i| won([10 + i; 32], 1, CLASS_GENERAL, 1))
        .collect();
    env.put_lines(basket, &fill);
    env.grow(&owner, account, StoreKind::Spill, 1).unwrap();
    env.put_lines(spill, &[won([99; 32], 1, CLASS_GENERAL, 4)]);
    env.claim(account, 5, vec![]).unwrap();
    assert_eq!(env.lines(basket).len(), INITIAL_BASKET_LINES);
    assert_eq!(
        env.lines(spill).len(),
        1,
        "still in the spill, still playable"
    );
    // growing the basket lets it through
    env.grow(&owner, account, StoreKind::Basket, 1).unwrap();
    env.claim(account, 5, vec![]).unwrap();
    assert!(env.lines(spill).is_empty());
}

#[test]
fn claim_merges_a_line_into_the_basket_line_with_the_same_key_through_the_book() {
    let mut env = Env::new();
    let (owner, account) = env.person();
    let basket = basket_address(&account).0;
    let spill = spill_address(&account).0;
    let (source_key, book_key) = env.source_with_book(1);
    let source = source_key.to_bytes();

    // two lines of one key, issued by one book so both sit at the class's current index
    let mut book = SourceBook::new();
    let mut in_basket = won(source, 50, CLASS_GENERAL, 0);
    book.issue(&mut in_basket, 10, &NoCheckpoints).unwrap();
    let mut in_spill = won(source, 50, CLASS_GENERAL, 0);
    book.issue(&mut in_spill, 5, &NoCheckpoints).unwrap();
    let mut acc = env.svm.get_account(&s(book_key)).unwrap();
    book.encode(&mut acc.data[BOOK_AT..]).unwrap();
    env.svm.set_account(s(book_key), acc).unwrap();
    env.put_lines(basket, &[in_basket]);
    env.grow(&owner, account, StoreKind::Spill, 1).unwrap();
    env.put_lines(spill, &[in_spill]);

    // without the Source's book the merge cannot happen
    let e = env.claim(account, 1, vec![]).unwrap_err();
    assert!(matches!(custom_code(&e), 6100..=6299), "{:?}", e.meta.logs);
    assert_eq!(env.lines(spill).len(), 1, "nothing moved");

    env.claim(account, 1, vec![book_key]).unwrap();
    assert!(env.lines(spill).is_empty());
    let lines = env.lines(basket);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].amount, 15);
    // the book was written back and still holds (identity E for the lines it knows)
    let d = env.data(book_key);
    let after = SourceBook::decode(&d[BOOK_AT..]).unwrap();
    assert_eq!(after.uncovered_total(), book.uncovered_total());

    // a read-only book account is refused rather than silently not saved
    env.put_lines(spill, &[won(source, 50, CLASS_GENERAL, 1)]);
    let payer = Keypair::new();
    env.svm.airdrop(&payer.pubkey(), SOL).unwrap();
    let mut i = ix(
        accounts::ClaimSpill {
            account,
            basket,
            spill,
        },
        instruction::ClaimSpill { max: 1 },
    );
    i.accounts
        .push(AccountMeta::new_readonly(s(book_key), false));
    let e = env.send(&[i], &[&payer]).unwrap_err();
    assert_eq!(custom_code(&e), ACCOUNT_NOT_WRITABLE);
}

#[test]
fn claim_handles_sixteen_sources_in_one_instruction() {
    let mut env = Env::new();
    let (owner, account) = env.person();
    let basket = basket_address(&account).0;
    let spill = spill_address(&account).0;
    env.grow(&owner, account, StoreKind::Basket, 36).unwrap();
    env.grow(&owner, account, StoreKind::Spill, 34).unwrap();
    // 16 Sources, two lines each (due 10 and 20) in both the basket and the spill, so the claim
    // visits every Source twice and swaps the decoded book 32 times
    let mut books = Vec::new();
    let (mut in_basket, mut in_spill) = (Vec::new(), Vec::new());
    for i in 0..16u32 {
        let (source_key, book_key) = env.source_with_book(100 + i);
        let source = source_key.to_bytes();
        let mut book = SourceBook::new();
        for due in [10, 20] {
            let mut b = won(source, due, CLASS_GENERAL, 0);
            book.issue(&mut b, 10, &NoCheckpoints).unwrap();
            let mut sp = won(source, due, CLASS_GENERAL, 0);
            book.issue(&mut sp, 5, &NoCheckpoints).unwrap();
            in_basket.push(b);
            in_spill.push(sp);
        }
        let mut acc = env.svm.get_account(&s(book_key)).unwrap();
        book.encode(&mut acc.data[BOOK_AT..]).unwrap();
        env.svm.set_account(s(book_key), acc).unwrap();
        books.push(book_key);
    }
    env.put_lines(basket, &in_basket);
    env.put_lines(spill, &in_spill);
    env.claim(account, 32, books).unwrap();
    eprintln!(
        "MEASURE CU claim_spill, 32 merges over 16 Sources (32 book swaps): {}",
        env.last_cu
    );
    assert!(env.lines(spill).is_empty());
    let lines = env.lines(basket);
    assert_eq!(lines.len(), 32);
    assert!(lines.iter().all(|l| l.amount == 15));
}

#[test]
fn claim_refuses_a_platform_or_leaderboard_line_in_a_spill() {
    let mut env = Env::new();
    let (owner, account) = env.person();
    let spill = spill_address(&account).0;
    env.grow(&owner, account, StoreKind::Spill, 3).unwrap();
    for class in [CLASS_PLATFORM, CLASS_LEADERBOARD] {
        env.put_lines(spill, &[own([8; 32], class, 3)]);
        let e = env.claim(account, 1, vec![]).unwrap_err();
        assert_eq!(custom_code(&e), FEE_COUNTER_ONLY, "class {class}");
        let mut acc = env.svm.get_account(&s(spill)).unwrap();
        LineStore::new(&mut acc.data[DISC..])
            .unwrap()
            .remove_at(0)
            .unwrap();
        env.svm.set_account(s(spill), acc).unwrap();
    }
    // a Studio fee line (an outside studio's) is an ordinary line of a basket
    env.put_lines(spill, &[own([8; 32], CLASS_STUDIO, 3)]);
    env.claim(account, 1, vec![]).unwrap();
    assert_eq!(env.lines(basket_address(&account).0).len(), 1);
}

#[test]
fn books_must_be_real_and_not_repeated() {
    let mut env = Env::new();
    let (_owner, account) = env.person();
    let (_s, book_key) = env.source_with_book(2);
    // a basket passed where a book belongs is not a book
    let stray = basket_address(&account).0;
    env.claim(account, 1, vec![stray])
        .expect("a non-book account is ignored when unused");
    // the same book twice is refused
    let e = env.claim(account, 1, vec![book_key, book_key]).unwrap_err();
    assert_eq!(custom_code(&e), DUPLICATE_BOOK);
}

// ---------------------------------------------------------------------------------------------
// Source books and checkpoint pages
// ---------------------------------------------------------------------------------------------

#[test]
fn a_source_book_starts_empty_with_room_for_its_counters() {
    let mut env = Env::new();
    let (source_key, book_key) = env.source_with_book(3);
    let acc = env.svm.get_account(&s(book_key)).unwrap();
    assert_eq!(acc.data.len(), SOURCE_BOOK_LEN);
    assert_eq!(acc.owner, s(tesoro_core::ID));
    assert_eq!(
        &acc.data[..DISC],
        <SourceBookHead as anchor_lang::Discriminator>::DISCRIMINATOR
    );
    assert_eq!(&acc.data[DISC + 8..DISC + 40], source_key.as_ref());
    for class in 0..3u8 {
        assert!(counter_get(&acc.data, class).is_none());
    }
    let book = SourceBook::decode(&acc.data[BOOK_AT..]).unwrap();
    assert_eq!(book.class_count(), 4);
    // one book per Source
    let payer = Keypair::new();
    env.svm.airdrop(&payer.pubkey(), SOL).unwrap();
    let again = env.send(
        &[ix(
            accounts::InitSourceBook {
                payer: a(payer.pubkey()),
                source: source_key,
                book: book_key,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitSourceBook {},
        )],
        &[&payer],
    );
    assert!(again.is_err());
}

fn page_ix(payer: APk, book: APk, source: APk, class: u8, page_no: u32) -> Instruction {
    ix(
        accounts::InitCkptPage {
            payer,
            book,
            page: ckpt_address(&source, class, page_no).0,
            system_program: anchor_lang::system_program::ID,
        },
        instruction::InitCkptPage { class, page_no },
    )
}

#[test]
fn checkpoint_pages_are_created_in_order_by_their_payer() {
    let mut env = Env::new();
    let (source, book) = env.source_with_book(4);
    let payer = Keypair::new();
    env.svm.airdrop(&payer.pubkey(), 5 * SOL).unwrap();
    let page = ckpt_address(&source, CLASS_GENERAL, 0).0;
    let before = env.svm.get_balance(&payer.pubkey()).unwrap();
    env.send(
        &[page_ix(a(payer.pubkey()), book, source, CLASS_GENERAL, 0)],
        &[&payer],
    )
    .unwrap();
    assert_eq!(
        before - env.svm.get_balance(&payer.pubkey()).unwrap() - 5_000,
        rent(&env, CKPT_ACCOUNT_LEN)
    );
    let acc = env.svm.get_account(&s(page)).unwrap();
    assert_eq!(acc.owner, s(tesoro_core::ID));
    assert_eq!(acc.data.len(), CKPT_ACCOUNT_LEN);
    // the page is a valid, empty page of that Source and class
    let view = tesoro_core::ledger::book::checkpoint::PageView::new(
        &acc.data[CKPT_PAGE_AT..],
        &source.to_bytes(),
        CLASS_GENERAL,
        0,
    )
    .unwrap();
    assert_eq!(view.count(), 0);
    assert_eq!(acc.data[DISC], ckpt_address(&source, CLASS_GENERAL, 0).1);
    // the same page twice is refused; page 2 is too early; Platform and Leaderboard write none
    for (class, no, want) in [
        (CLASS_GENERAL, 0, 0),
        (CLASS_GENERAL, 2, WRONG_PAGE),
        (CLASS_PLATFORM, 0, WRONG_PAGE),
        (CLASS_LEADERBOARD, 0, WRONG_PAGE),
        (9, 0, WRONG_PAGE),
    ] {
        let r = env.send(
            &[page_ix(a(payer.pubkey()), book, source, class, no)],
            &[&payer],
        );
        let e = r.unwrap_err();
        if want != 0 {
            assert_eq!(custom_code(&e), want, "class {class} page {no}");
        }
    }
    // the next page may be made ahead
    env.send(
        &[page_ix(a(payer.pubkey()), book, source, CLASS_GENERAL, 1)],
        &[&payer],
    )
    .unwrap();
}

#[test]
fn a_pre_funded_page_address_cannot_block_the_page() {
    let mut env = Env::new();
    let (source, book) = env.source_with_book(5);
    let payer = Keypair::new();
    env.svm.airdrop(&payer.pubkey(), 5 * SOL).unwrap();
    env.svm
        .airdrop(&s(ckpt_address(&source, CLASS_STUDIO, 0).0), rent(&env, 0))
        .unwrap();
    env.send(
        &[page_ix(a(payer.pubkey()), book, source, CLASS_STUDIO, 0)],
        &[&payer],
    )
    .unwrap();
    assert_eq!(
        env.capacity_of_page(source, CLASS_STUDIO, 0),
        CKPT_ACCOUNT_LEN
    );
}

impl Env {
    fn capacity_of_page(&self, source: APk, class: u8, no: u32) -> usize {
        self.data(ckpt_address(&source, class, no).0).len()
    }
}

#[test]
fn sponsored_pages_need_the_relayer_and_stay_within_the_pages_cap() {
    let mut env = Env::new();
    let (source, book) = env.source_with_book(6);
    let page_rent = rent(&env, CKPT_ACCOUNT_LEN);
    env.init_sponsor(SOL, SOL, page_rent, 10 * SOL);
    let relayer = env.relayer.insecure_clone();
    let sponsored_page = |relayer: Pk, no: u32| {
        ix(
            accounts::InitCkptPageSponsored {
                relayer: a(relayer),
                sponsor: sponsor_address().0,
                book,
                page: ckpt_address(&source, CLASS_GENERAL, no).0,
                system_program: anchor_lang::system_program::ID,
            },
            instruction::InitCkptPageSponsored {
                class: CLASS_GENERAL,
                page_no: no,
            },
        )
    };
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let e = env
        .send(&[sponsored_page(stranger.pubkey(), 0)], &[&stranger])
        .unwrap_err();
    assert_eq!(custom_code(&e), NOT_SPONSOR_RELAYER);
    let before = env.lamports(sponsor_address().0);
    env.send(&[sponsored_page(relayer.pubkey(), 0)], &[&relayer])
        .unwrap();
    assert_eq!(before - env.lamports(sponsor_address().0), page_rent);
    assert_eq!(env.sponsor().pages_spent, page_rent);
    // the cap is one page
    let e = env
        .send(&[sponsored_page(relayer.pubkey(), 1)], &[&relayer])
        .unwrap_err();
    assert_eq!(custom_code(&e), TOTAL_SPONSOR_CAP);
}

// ---------------------------------------------------------------------------------------------
// numbers for the next tickets
// ---------------------------------------------------------------------------------------------

#[test]
fn measured_rent_and_compute_units() {
    let mut env = Env::new();
    let (owner, account) = env.person();
    let relayer = env.relayer.insecure_clone();
    env.init_sponsor(100 * SOL, 100 * SOL, SOL, 50 * SOL);
    let basket = basket_address(&account).0;

    let per_line = rent(&env, store_len(1_000)) - rent(&env, store_len(999));
    eprintln!("MEASURE rent per line: {per_line} lamports ({LINE_LEN} B)");
    eprintln!(
        "MEASURE rent of a new basket ({INITIAL_BASKET_LINES} lines) {} + spill {} lamports",
        rent(&env, store_len(INITIAL_BASKET_LINES)),
        rent(&env, store_len(0))
    );
    eprintln!(
        "MEASURE rent of a checkpoint page {} lamports",
        rent(&env, CKPT_ACCOUNT_LEN)
    );
    eprintln!(
        "MEASURE rent of a source book {} lamports",
        rent(&env, SOURCE_BOOK_LEN)
    );

    let cu = |name: &str, env: &Env| eprintln!("MEASURE CU {name}: {}", env.last_cu);
    env.grow(&owner, account, StoreKind::Basket, MAX_GROW_LINES as u32)
        .unwrap();
    cu("grow_store basket +71 (own lamports)", &env);
    env.grow_sponsored(&relayer, account, StoreKind::Basket, MAX_GROW_LINES as u32)
        .unwrap();
    cu("grow_store_sponsored basket +71", &env);
    env.grow(&owner, account, StoreKind::Spill, 10).unwrap();
    cu("grow_store spill +10", &env);
    env.shrink(&owner, account, StoreKind::Basket, 0).unwrap();
    cu("shrink_store basket (empty, 142 -> 0 slots)", &env);
    env.grow(&owner, account, StoreKind::Basket, MAX_GROW_LINES as u32)
        .unwrap();
    env.grow(&owner, account, StoreKind::Basket, MAX_GROW_LINES as u32)
        .unwrap();
    // a 142 line basket
    let lines: Vec<Line> = (0..140u8)
        .map(|i| won([i + 1; 32], i64::from(i), CLASS_GENERAL, 1))
        .collect();
    env.put_lines(basket, &lines);
    env.claim(account, 1, vec![]).unwrap();
    cu("claim_spill, empty spill, 140-line basket", &env);
    let (_, b) = (0, env.source_with_book(8).1);
    cu("init_source_book", &env);
    let _ = b;
    let (_o2, other) = env.person();
    cu("create_account (basket + spill)", &env);
    let _ = other;
}

// ---------------------------------------------------------------------------------------------
// sponsored create_account (ticket 18c)
// ---------------------------------------------------------------------------------------------

const ACCOUNTS_SPONSOR_CAP: u32 = 6319;
const PAYER_NEEDS_SPONSOR: u32 = 6320;

fn create_account_ix(authority: Pk, payer: Pk, sponsored: bool) -> Instruction {
    let account = pda(&[ACCOUNT_SEED, a(authority).as_ref()]);
    ix(
        accounts::CreateAccount {
            authority: a(authority),
            account,
            basket: basket_address(&account).0,
            spill: spill_address(&account).0,
            invite_gate: invite_gate_pda(),
            system_program: anchor_lang::system_program::ID,
            payer: a(payer),
            sponsor: sponsored.then(|| sponsor_address().0),
        },
        instruction::CreateAccount {
            evm_address: [0; 20],
        },
    )
}

impl Env {
    fn set_accounts_cap(&mut self, cap: u64) {
        let admin = self.admin.insecure_clone();
        self.send(
            &[ix(
                accounts::SetSponsor {
                    admin: a(admin.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    sponsor: sponsor_address().0,
                },
                instruction::SetAccountsCap { accounts_cap: cap },
            )],
            &[&admin],
        )
        .expect("set accounts cap");
    }

    /// The relayer fronts the rent and pays the fee; `wallet` only signs.
    fn create_sponsored(&mut self, wallet: &Keypair) -> Result<(), Failed> {
        let relayer = self.relayer.insecure_clone();
        self.send(
            &[create_account_ix(wallet.pubkey(), relayer.pubkey(), true)],
            &[&relayer, wallet],
        )
    }
}

/// What a sponsored `create_account` costs, split the way the program splits it.
fn account_rents(env: &Env) -> (u64, u64) {
    let total = rent(env, TesoroAccount::SPACE)
        + rent(env, store_len(INITIAL_BASKET_LINES))
        + rent(env, store_len(0));
    let refundable = rent(env, store_len(INITIAL_BASKET_LINES)) - rent(env, store_len(0));
    (refundable, total - refundable)
}

#[test]
fn a_wallet_with_no_lamports_gets_an_account_through_the_sponsor() {
    let mut env = Env::new();
    env.init_sponsor(10 * SOL, 100 * SOL, SOL, 50 * SOL);
    env.set_accounts_cap(SOL);
    let (refundable, permanent) = account_rents(&env);
    let wallet = Keypair::new();
    let account = pda(&[ACCOUNT_SEED, a(wallet.pubkey()).as_ref()]);
    let sponsor_before = env.lamports(sponsor_address().0);
    let relayer_before = env.svm.get_balance(&env.relayer.pubkey()).unwrap();

    env.create_sponsored(&wallet).expect("sponsored create");

    assert_eq!(env.svm.get_balance(&wallet.pubkey()).unwrap_or(0), 0);
    let acc = TesoroAccount::try_deserialize(&mut &env.data(account)[..]).expect("account");
    assert_eq!(acc.authority, a(wallet.pubkey()));
    // the sponsor paid all of it, the relayer only the fee (two signatures)
    assert_eq!(
        sponsor_before - env.lamports(sponsor_address().0),
        refundable + permanent
    );
    assert_eq!(
        relayer_before - env.svm.get_balance(&env.relayer.pubkey()).unwrap(),
        10_000
    );
    // recorded: the lines of the basket come back to the sponsor, the rest never does
    let basket = basket_address(&account).0;
    assert_eq!(env.sponsored(basket), refundable);
    assert_eq!(env.sponsored(spill_address(&account).0), 0);
    assert_eq!(env.sponsor().outstanding, refundable);
    assert_eq!(env.sponsor().accounts_spent, permanent);
    assert_eq!(
        env.lamports(basket),
        rent(&env, store_len(INITIAL_BASKET_LINES)),
        "rent exempt, no more"
    );

    // shrinking the basket's lines hands the refundable rent back to the sponsor
    env.send(
        &[ix(
            accounts::ShrinkStore {
                authority: a(wallet.pubkey()),
                account,
                basket,
                spill: spill_address(&account).0,
                sponsor: sponsor_address().0,
            },
            instruction::ShrinkStore {
                which: StoreKind::Basket,
                keep_free: 0,
            },
        )],
        &[&env.relayer.insecure_clone(), &wallet],
    )
    .expect("shrink");
    assert_eq!(
        env.sponsor().outstanding,
        0,
        "the sponsor got the lines back"
    );
    assert_eq!(
        env.sponsor().accounts_spent,
        permanent,
        "the rest is never returned"
    );
    assert_eq!(env.sponsored(basket), 0);
    assert_eq!(
        sponsor_before - env.lamports(sponsor_address().0),
        permanent,
        "the sponsor is out only the rent that never returns"
    );
}

#[test]
fn a_sponsored_account_is_refused_without_the_sponsor_or_past_a_cap() {
    let mut env = Env::new();
    env.init_sponsor(10 * SOL, 100 * SOL, SOL, 50 * SOL);
    let relayer = env.relayer.insecure_clone();
    let (refundable, permanent) = account_rents(&env);

    // a payer who is not the wallet needs the sponsor account: the relayer is never left holding rent
    let wallet = Keypair::new();
    let e = env
        .send(
            &[create_account_ix(wallet.pubkey(), relayer.pubkey(), false)],
            &[&relayer, &wallet],
        )
        .unwrap_err();
    assert_eq!(custom_code(&e), PAYER_NEEDS_SPONSOR);

    // the admin has not opened the cap for rent that never returns
    let e = env.create_sponsored(&wallet).unwrap_err();
    assert_eq!(custom_code(&e), ACCOUNTS_SPONSOR_CAP);

    // room for exactly one
    env.set_accounts_cap(permanent);
    env.create_sponsored(&wallet).unwrap();
    let second = Keypair::new();
    let e = env.create_sponsored(&second).unwrap_err();
    assert_eq!(custom_code(&e), ACCOUNTS_SPONSOR_CAP);

    // the cap cannot drop below what was spent
    let admin = env.admin.insecure_clone();
    let e = env
        .send(
            &[ix(
                accounts::SetSponsor {
                    admin: a(admin.pubkey()),
                    config: pda(&[CONFIG_SEED]),
                    sponsor: sponsor_address().0,
                },
                instruction::SetAccountsCap { accounts_cap: 1 },
            )],
            &[&admin],
        )
        .unwrap_err();
    assert_eq!(custom_code(&e), CAP_BELOW_OUTSTANDING);

    // a stranger cannot be the payer of a sponsored Account
    env.set_accounts_cap(10 * permanent);
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let e = env
        .send(
            &[create_account_ix(second.pubkey(), stranger.pubkey(), true)],
            &[&stranger, &second],
        )
        .unwrap_err();
    assert_eq!(custom_code(&e), NOT_SPONSOR_RELAYER);

    // the per-Account and total caps count the refundable part, and the pause stops it
    env.set_sponsor(&admin, true, 10 * SOL, 100 * SOL, SOL)
        .unwrap();
    let e = env.create_sponsored(&second).unwrap_err();
    assert_eq!(custom_code(&e), SPONSOR_PAUSED);
    env.set_sponsor(&admin, false, refundable - 1, 100 * SOL, SOL)
        .unwrap();
    let e = env.create_sponsored(&second).unwrap_err();
    assert_eq!(custom_code(&e), ACCOUNT_SPONSOR_CAP);
    env.set_sponsor(&admin, false, 10 * SOL, refundable + 1, SOL)
        .unwrap();
    let e = env.create_sponsored(&second).unwrap_err();
    assert_eq!(custom_code(&e), TOTAL_SPONSOR_CAP);
}

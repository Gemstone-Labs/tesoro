//! Seat keys (seat-keys ticket 02): an entry names a key that co-signs it; that key, the wallet
//! and nobody else act for the entry's Match side or Entry Ticket (`util::acts_for`).

use super::*;
use tesoro_core::ledger::draw::TicketState;
use tesoro_core::ledger::lifecycle::Stage;

const WALLET_ONLY_NOT_EXPIRED: u32 = ERR_TICKET_NOT_EXPIRED;
const NOT_TICKET_OWNER: u32 = 6400 + tesoro_core::error::MatchError::NotTicketOwner as u32;

impl Env {
    /// A funded key that is nobody's wallet: a seat key, or a stranger.
    fn fresh_key(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 10 * SOL).expect("airdrop");
        k
    }

    /// The next entries (Match or Ticket) name `k` as their seat key and it co-signs them.
    fn name_seat(&mut self, k: &Keypair) {
        self.seat_key = Some(k.insecure_clone());
    }

    fn no_seat(&mut self) {
        self.seat_key = None;
    }

    fn ticket_signer(&self, owner: &Person, nonce: u64) -> APk {
        let d = self
            .svm
            .get_account(&s(ticket_pda(owner.account, nonce)))
            .expect("ticket")
            .data;
        let at = tesoro_core::pots::SIGNER_AT;
        APk::new_from_array(d[8 + at..8 + at + 32].try_into().unwrap())
    }
}

fn key_of(k: &Keypair) -> APk {
    a(k.pubkey())
}

#[test]
fn a_match_side_records_the_seat_key_that_co_signed_or_the_wallet_that_named_none() {
    let mut d = duel();
    let ana_key = d.env.fresh_key();
    let ben_key = d.env.fresh_key();
    d.env.name_seat(&ana_key);
    let id = d
        .env
        .open_match(&d.alice, 500)
        .expect("open with a seat key");
    assert_eq!(d.env.mstate(id).inner.a.signer, key_of(&ana_key).to_bytes());
    assert_eq!(d.env.mstate(id).inner.a.player, d.alice.account.to_bytes());
    d.env.name_seat(&ben_key);
    d.env.join_match(&d.bob, id).expect("join with a seat key");
    let b = d.env.mstate(id).inner.b.expect("joined");
    assert_eq!(b.signer, key_of(&ben_key).to_bytes());
    assert_eq!(b.player, d.bob.account.to_bytes());

    // a wallet that wants no seat key names itself, on both entry paths
    d.env.no_seat();
    let (carol, _) = person_with_lines(&mut d.env, 2, 150, 1_000);
    let (dan, _) = person_with_lines(&mut d.env, 2, 160, 1_000);
    let id2 = d.env.open_match(&carol, 500).expect("open");
    assert_eq!(d.env.mstate(id2).inner.a.signer, carol.key.to_bytes());
    d.env.join_match(&dan, id2).expect("join");
    assert_eq!(
        d.env.mstate(id2).inner.b.unwrap().signer,
        dan.key.to_bytes()
    );
}

#[test]
fn a_seat_signer_that_did_not_sign_is_refused_on_every_entry_path() {
    let mut d = duel();
    let not_signing = Keypair::new();
    // open_ticket
    let nonce = d.env.next_ticket(d.alice.account);
    d.env
        .ensure_spill(&d.alice.kp.insecure_clone(), d.alice.account, 4);
    let open = open_ticket_ix(&d.alice, nonce, 500, 4, key_of(&not_signing));
    let alice = d.alice.kp.insecure_clone();
    d.env.seat_unsigned = true;
    assert!(d.env.send(&[open], &alice, &[]).is_err());
    d.env.seat_unsigned = false;
    // open_match and join_match: the named key has to sign, wherever it is named
    d.env.seat_key = Some(not_signing.insecure_clone());
    d.env.seat_unsigned = true;
    assert!(d.env.open_match(&d.alice, 500).is_err());
    d.env.seat_unsigned = false;
    d.env.no_seat();
    let id = d.env.open_match(&d.alice, 500).expect("open");
    d.env.seat_key = Some(not_signing);
    d.env.seat_unsigned = true;
    assert!(d.env.join_match(&d.bob, id).is_err());
    assert_eq!(d.env.mstate(id).inner.stage(), Stage::Open);
}

#[test]
fn the_seat_key_the_ticket_names_stages_and_cancels_it_and_nobody_else_does() {
    let mut d = duel();
    let ana_key = d.env.fresh_key();
    let other_key = d.env.fresh_key();
    let stranger = d.env.fresh_key();
    // another Player's Ticket, with another seat key
    d.env.name_seat(&other_key);
    d.env.open_ticket(&d.bob, 5, 500, 6).expect("bob's ticket");
    d.env.name_seat(&ana_key);
    let (alice, bob) = (
        Person {
            kp: d.alice.kp.insecure_clone(),
            key: d.alice.key,
            account: d.alice.account,
        },
        Person {
            kp: d.bob.kp.insecure_clone(),
            key: d.bob.key,
            account: d.bob.account,
        },
    );
    d.env.open_ticket(&alice, 5, 500, 6).expect("ana's ticket");
    assert_eq!(d.env.ticket_signer(&alice, 5), key_of(&ana_key));
    let books = d.env.books_of(alice.account);

    // staging an Entry Ticket: the owner's wallet and its seat key; a stranger and another
    // Player's seat key are refused
    for wrong in [&stranger, &other_key] {
        let err = d
            .env
            .stage_with(wrong, &alice, 5, 20, books.clone())
            .unwrap_err();
        assert_eq!(custom_code(&err), NOT_TICKET_OWNER);
    }
    d.env
        .stage_with(&ana_key, &alice, 5, 20, books.clone())
        .expect("the seat key stages");
    assert_eq!(d.env.load_ticket_staged(&alice, 5), 500);

    // cancelling: a stranger and another Player's key wait for the deadline, the seat key does
    // not
    for wrong in [&stranger, &other_key] {
        let err = d
            .env
            .cancel_ticket_with(wrong, &alice, 5, 8, books.clone())
            .unwrap_err();
        assert_eq!(custom_code(&err), WALLET_ONLY_NOT_EXPIRED);
    }
    assert_eq!(d.env.ticket_state(&alice, 5), TicketState::Open);
    d.env
        .cancel_ticket_with(&ana_key, &alice, 5, 8, books.clone())
        .expect("the seat key cancels at once");
    while d.env.ticket_state(&alice, 5) != TicketState::Cancelled {
        d.env
            .cancel_ticket_with(&stranger, &alice, 5, 8, books.clone())
            .expect("anyone continues");
    }

    // a Ticket whose seat key is the wallet itself works as before: the wallet stages and cancels
    d.env.no_seat();
    d.env.open_ticket(&alice, 6, 500, 6).expect("wallet ticket");
    assert_eq!(d.env.ticket_signer(&alice, 6), alice.key);
    let wallet = alice.kp.insecure_clone();
    let err = d
        .env
        .stage_with(&ana_key, &alice, 6, 20, books.clone())
        .unwrap_err();
    assert_eq!(custom_code(&err), NOT_TICKET_OWNER);
    d.env
        .stage_with(&wallet, &alice, 6, 20, books.clone())
        .expect("wallet stages");
    d.env
        .cancel_ticket_with(&wallet, &alice, 6, 8, books.clone())
        .expect("wallet cancels");
    // the other Player's key still does nothing to Bob's Ticket by being Ana's
    let err = d
        .env
        .cancel_ticket_with(&ana_key, &bob, 5, 8, books)
        .unwrap_err();
    assert_eq!(custom_code(&err), WALLET_ONLY_NOT_EXPIRED);
}

#[test]
fn the_requesters_seat_key_is_named_by_a_backed_entry_but_only_the_backer_cancels_the_backing_ticket(
) {
    let mut b = backing_setup();
    let request = b.request(1, 500);
    let offer = b.offer(1, request, 5_000);
    b.accept(offer, request);
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
    let dave_key = b.d.env.fresh_key();
    b.d.env.name_seat(&dave_key);
    b.d.env
        .open_backing_ticket(&carol, &dave, offer, 9, 500, 4)
        .expect("backing ticket with the requester's seat key");
    let books = b.d.env.books_of(carol.account);
    // staging stays open to anyone
    let stranger = b.d.env.fresh_key();
    b.d.env
        .stage_with(&stranger, &carol, 9, 20, books.clone())
        .expect("anyone stages a Backing Ticket");
    // the Requester's key does not cancel the Backer's Ticket: that is the Backer's, or anyone
    // after the deadline
    let err =
        b.d.env
            .cancel_backing_ticket(&dave_key, &carol, 9, Some(offer), books.clone())
            .unwrap_err();
    assert_eq!(custom_code(&err), WALLET_ONLY_NOT_EXPIRED);
    // the backed entry names the Requester's seat key
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
            .expect("backed open");
    let side = b.d.env.mstate(id).inner.a;
    assert_eq!(side.signer, key_of(&dave_key).to_bytes());
    assert_eq!(side.player, dave.account.to_bytes());
    assert_eq!(side.funder, carol.account.to_bytes());
}

#[test]
fn only_the_wallet_or_the_named_seat_key_cancels_an_open_match_at_once() {
    let mut d = duel();
    let ana_key = d.env.fresh_key();
    let ben_key = d.env.fresh_key();
    let stranger = d.env.fresh_key();
    let alice = d.alice.kp.insecure_clone();
    d.env.name_seat(&ana_key);
    let id = d.env.open_match(&d.alice, 500).expect("ana opens");
    d.env.name_seat(&ben_key);
    let ben_open = d.env.open_match(&d.bob, 500).expect("ben opens");

    // a stranger and another Match's seat key are refused
    for wrong in [&stranger, &ben_key] {
        let err = d.env.refund_start(wrong, id).unwrap_err();
        assert_eq!(custom_code(&err), core(CoreError::NotExpired));
    }
    assert_eq!(d.env.mstate(id).inner.stage(), Stage::Open);
    // the seat key refunds Ana's Match at once; Ben's stays
    d.env.refund_keep(&ana_key, id).expect("seat key cancels");
    assert_eq!(d.env.mstate(id).inner.stage(), Stage::Closed);
    assert_eq!(d.env.mstate(ben_open).inner.stage(), Stage::Open);

    // the wallet does it too, with or without a seat key named
    d.env.no_seat();
    let id2 = d.env.open_match(&d.alice, 500).expect("wallet-only open");
    d.env.refund_keep(&alice, id2).expect("wallet cancels");
    d.env.name_seat(&ana_key);
    let id3 = d.env.open_match(&d.alice, 500).expect("named open");
    d.env
        .refund_keep(&alice, id3)
        .expect("wallet cancels a seat-keyed Match");
    assert_eq!(d.env.mstate(id3).inner.stage(), Stage::Closed);
}

#[test]
fn a_joiners_seat_key_cannot_refund_the_match_it_joined_before_the_deadline() {
    let mut d = duel();
    let ben_key = d.env.fresh_key();
    let id = d.env.open_match(&d.alice, 500).expect("open");
    d.env.name_seat(&ben_key);
    d.env.join_match(&d.bob, id).expect("join");
    let err = d.env.refund_start(&ben_key, id).unwrap_err();
    assert_eq!(custom_code(&err), core(CoreError::NotExpired));
    assert_eq!(d.env.mstate(id).inner.stage(), Stage::Active);
}

// --- Everything in code-map §5 stays wallet-only --------------------------------------------------

/// Instructions that move value out of the Account, create debt, loosen Protections or rebind
/// identity and payout addresses. Each takes the Player's wallet as a signer and derives the
/// Player's Account from it (`seeds = [ACCOUNT_SEED, <signer>]`), so a seat key, which is nobody's
/// wallet, has no Account to act for. Not in the list: `cancel_instant_redeem` (compares the
/// signer with the order's owner wallet, `instant.rs`) and `create_account` (a key can only create
/// the Account derived from itself).
const WALLET_ONLY: &[&str] = &[
    "redeem",
    "unlock",
    "redeem_prize",
    "begin_prize_payout_from_source",
    "request_instant_redeem",
    "return_own",
    "claim_free_yield",
    "open_native_position",
    "open_stake_position",
    "take_native_advance",
    "take_stake_advance",
    "take_advance",
    "extend_native_advance",
    "extend_stake_advance",
    "create_offer",
    "accept_offer",
    "create_request",
    "cancel_request",
    "cancel_offer",
    "set_entry_limit",
    "set_break",
    "set_self_exclusion",
    "set_extend_limit",
    "set_evm_address",
    "set_name_evm",
    "set_name_wallet",
    "set_profile",
    "shrink_store",
];

/// Instructions whose Accounts-struct checks other (admin, Source or Game) accounts before the
/// Player's Account, and those accounts do not exist in this setup: the seat key is still refused
/// (the transaction fails), but not on the Player's Account, so only the refusal is asserted.
const PRECEDED: &[&str] = &[
    "begin_prize_payout_from_source",
    "take_advance",
    "create_offer",
    "create_request",
];

fn core_idl() -> serde_json::Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/idl/tesoro_core.json");
    serde_json::from_slice(&std::fs::read(path).expect("build the IDL: pnpm build:programs"))
        .expect("idl")
}

/// Builds `name` from the IDL with `holder` in the Player's signer slot and every account the
/// seeds can derive from it derived; other accounts are fresh addresses (they do not exist). The
/// name of the account derived from the signer is returned with it.
fn wallet_slot_ix(name: &str, holder: APk, other_signer: APk) -> (Instruction, String) {
    let idl = core_idl();
    let item = idl["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == name)
        .unwrap_or_else(|| panic!("{name} is not in the IDL"));
    let accs = item["accounts"].as_array().unwrap();
    let signers: Vec<&str> = accs
        .iter()
        .filter(|x| x["signer"] == true)
        .map(|x| x["name"].as_str().unwrap())
        .collect();
    let seed_path = |x: &serde_json::Value| -> Vec<String> {
        x["pda"]["seeds"]
            .as_array()
            .map(|v| {
                v.iter()
                    .filter(|sd| sd["kind"] == "account")
                    .map(|sd| sd["path"].as_str().unwrap().split('.').next().unwrap().to_string())
                    .collect()
            })
            .unwrap_or_default()
    };
    let player_signer = accs
        .iter()
        .flat_map(seed_path)
        .find(|p| signers.contains(&p.as_str()))
        .unwrap_or_else(|| panic!("{name}: no account is derived from a signer"));
    let mut keys: std::collections::BTreeMap<String, APk> = Default::default();
    let mut bound = String::new();
    let mut metas = vec![];
    for x in accs {
        let n = x["name"].as_str().unwrap().to_string();
        let key = if n == player_signer {
            holder
        } else if x["signer"] == true {
            other_signer
        } else if let Some(addr) = x["address"].as_str() {
            addr.parse().unwrap()
        } else if x["pda"].is_object()
            && x["pda"]["seeds"].as_array().unwrap().iter().all(|sd| {
                sd["kind"] == "const"
                    || (sd["kind"] == "account"
                        && keys.contains_key(sd["path"].as_str().unwrap()))
            })
        {
            let seeds: Vec<Vec<u8>> = x["pda"]["seeds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|sd| {
                    if sd["kind"] == "const" {
                        sd["value"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|b| b.as_u64().unwrap() as u8)
                            .collect()
                    } else {
                        keys[sd["path"].as_str().unwrap()].to_bytes().to_vec()
                    }
                })
                .collect();
            let refs: Vec<&[u8]> = seeds.iter().map(|v| v.as_slice()).collect();
            let k = APk::find_program_address(&refs, &tesoro_core::ID).0;
            if seed_path(x).contains(&player_signer) && bound.is_empty() {
                bound = n.clone();
            }
            k
        } else {
            APk::new_unique()
        };
        keys.insert(n.clone(), key);
        let optional = x["optional"] == true;
        metas.push(AccountMeta {
            pubkey: s(if optional && !x["signer"].as_bool().unwrap_or(false) && x["pda"].is_null() && x["address"].is_null() { tesoro_core::ID } else { key }),
            is_signer: x["signer"] == true,
            is_writable: x["writable"] == true,
        });
    }
    let disc: Vec<u8> = item["discriminator"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect();
    let mut data = disc;
    data.extend(vec![0u8; 2048]);
    (
        Instruction {
            program_id: s(tesoro_core::ID),
            accounts: metas,
            data,
        },
        bound,
    )
}

fn error_account(err: &litesvm::types::FailedTransactionMetadata) -> Option<String> {
    err.meta.logs.iter().find_map(|l| {
        l.split("caused by account: ")
            .nth(1)
            .map(|r| r.split('.').next().unwrap().trim().to_string())
    })
}

#[test]
fn every_wallet_only_instruction_is_refused_for_a_seat_key_that_an_open_match_names() {
    let mut d = duel();
    let ana_key = d.env.fresh_key();
    let payer = d.env.fresh_key();
    d.env.name_seat(&ana_key);
    let id = d.env.open_match(&d.alice, 500).expect("ana opens with her seat key");
    assert_eq!(d.env.mstate(id).inner.a.signer, key_of(&ana_key).to_bytes());
    let wallet = d.alice.kp.insecure_clone();
    for name in WALLET_ONLY {
        // the seat key in the wallet slot: the Account derived from it does not exist
        let (ix_k, bound) = wallet_slot_ix(name, key_of(&ana_key), key_of(&payer));
        let err = d
            .env
            .send(&[ix_k], &payer, &[&ana_key])
            .expect_err(&format!("{name} must refuse a seat key"));
        if !PRECEDED.contains(name) {
            assert_eq!(
                error_account(&err).as_deref(),
                Some(bound.as_str()),
                "{name}: refused on the Account derived from the signer, not for another reason\n{:?}",
                err.meta.logs
            );
        }
        // the control: the wallet that has an Account is not stopped at that account
        let (ix_w, _) = wallet_slot_ix(name, d.alice.key, key_of(&payer));
        let outcome = d.env.send(&[ix_w], &payer, &[&wallet]);
        if let Err(e) = outcome {
            assert_ne!(
                error_account(&e).as_deref(),
                Some(bound.as_str()),
                "{name}: the wallet's own Account was refused too\n{:?}",
                e.meta.logs
            );
        }
    }
}

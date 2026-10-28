//! Stake Position images for the app and keeper decoder tests (ticket 55), written by the program:
//! `app/src/lib/chain/position-stake.fixtures.json`. The 243-byte ones are the accounts LiteSVM
//! holds after a real Advance (Some) and after that Advance closes (None, with the stale tail the
//! shorter `None` leaves). The 235-byte ones are the same states in the layout before ticket 55,
//! serialised the way the old program wrote them (a None over a Some keeps the Some's tail).
//!
//! Each fixture's `expect` is the program's own decode of its bytes. Regenerate after a layout
//! change: `TESORO_WRITE_STAKE_FIXTURES=1 cargo test -p tesoro_core --test stake stake_fixtures`.

use super::growth_only::set_rate;
use super::migrate::{legacy_image, migrate, set_raw, ANCHOR_DID_NOT_DESERIALIZE};
use super::*;

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../app/src/lib/chain/position-stake.fixtures.json"
);
const NAMES: [&str; 4] = [
    "stake243Some",
    "stake243NoneStale",
    "stake235Some",
    "stake235NoneStale",
];

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn b58(k: &[u8; 32]) -> String {
    APk::new_from_array(*k).to_string()
}

/// The program's decode of a Position image: the current layout for 243 bytes, the old one for
/// 235 (which has no `stake_rate_high`).
fn decode(data: &[u8]) -> (ledger::Position, Option<u64>) {
    if data.len() == PositionState::SPACE {
        let state = PositionState::try_deserialize(&mut &data[..]).expect("a current Position");
        let high = state.inner.stake_rate_high;
        (state.inner, Some(high))
    } else {
        assert_eq!(data.len(), PositionStateV1::SPACE);
        (PositionStateV1::decode(data).unwrap().upgrade().inner, None)
    }
}

/// `expect` as JSON: u64/u128 as decimal strings (JavaScript numbers cannot hold them).
fn expect_json(data: &[u8], keys: bool) -> String {
    let (p, high) = decode(data);
    let mut f: Vec<(&str, String)> = vec![];
    if keys {
        f.push(("owner", format!("\"{}\"", b58(&p.owner))));
        f.push(("sourceAsset", format!("\"{}\"", b58(&p.source_asset))));
        f.push(("openedAt", format!("\"{}\"", p.opened_at)));
    }
    let q = |v: u128| format!("\"{v}\"");
    f.extend([
        ("bytes", data.len().to_string()),
        (
            "openAdvance",
            p.open_advance.map_or("null".into(), |i| i.to_string()),
        ),
        ("decimals", p.decimals.to_string()),
        ("principal", q(p.principal.into())),
        ("rateBps", p.rate_bps.to_string()),
        ("advances", p.advances.to_string()),
        ("lastSeq", q(p.last_seq.into())),
        ("cumulativeYield", q(p.cumulative_yield.into())),
        ("freeYield", q(p.free_yield.into())),
        ("freeYieldClaimed", q(p.free_yield_claimed.into())),
        ("appliedNet", q(p.applied_net.into())),
        ("custodyShares", q(p.custody_shares.into())),
        ("yieldFeeBps", p.yield_fee_bps.to_string()),
        ("stakeRateOpen", q(p.stake_rate_open.into())),
        ("heldShares", q(p.held_shares)),
        ("freeShares", q(p.free_shares)),
        ("paidShares", q(p.paid_shares.into())),
        ("poolBps", p.pool_bps.to_string()),
        ("stakeRateHigh", high.map_or("null".into(), |h| q(h.into()))),
    ]);
    let body: Vec<String> = f
        .iter()
        .map(|(k, v)| format!("      \"{k}\": {v}"))
        .collect();
    format!("{{\n{}\n    }}", body.join(",\n"))
}

fn render(fixtures: &[(String, Vec<u8>)], keys: bool) -> String {
    let items: Vec<String> = NAMES
        .iter()
        .zip(fixtures)
        .map(|(name, (key, data))| {
            let head = if keys {
                format!(
                    "    \"key\": \"{key}\",\n    \"data\": \"{}\",\n",
                    hex(data)
                )
            } else {
                String::new()
            };
            format!(
                "  \"{name}\": {{\n{head}    \"expect\": {}\n  }}",
                expect_json(data, keys)
            )
        })
        .collect();
    format!(
        "{{\n  \"_note\": \"Stake Position images written by tesoro_core in LiteSVM (tests/stake_audit/fixtures.rs); expect = the program's own decode. Regenerate: TESORO_WRITE_STAKE_FIXTURES=1 cargo test -p tesoro_core --test stake stake_fixtures\",\n{}\n}}\n",
        items.join(",\n")
    )
}

/// The committed fixtures: (key, bytes) per name, read back from the file `render` wrote.
fn committed() -> Vec<(String, Vec<u8>)> {
    let text =
        std::fs::read_to_string(PATH).expect("fixtures file (regenerate it, see the module doc)");
    let field = |from: usize, name: &str| {
        let tag = format!("\"{name}\": \"");
        let at = from + text[from..].find(&tag).unwrap() + tag.len();
        text[at..at + text[at..].find('"').unwrap()].to_string()
    };
    NAMES
        .iter()
        .map(|name| {
            let at = text.find(&format!("\"{name}\": {{")).unwrap();
            (field(at, "key"), unhex(&field(at, "data")))
        })
        .collect()
}

fn raw(env: &Env, key: APk) -> Vec<u8> {
    env.svm.get_account(&s(key)).unwrap().data
}

/// Ana's 10 jitoSOL Lock at 1.20 with a 12-month Advance landed at 1.32 (Some, high 1.32), then
/// the Advance closed by returning her last own Gemas after a fall to 1.25 (None, high 1.32).
fn generate() -> Vec<(String, Vec<u8>)> {
    let mut env = at_open_rate();
    let ana = env.holder(10 * SOL);
    let pos = env.open(&ana, 10 * SOL).unwrap();
    let source = env.advance_stake(&ana, pos, 12).unwrap();
    env.set_total(HIGH_RATE);
    env.redeem(&ana, pos, source, 17_990).unwrap();
    let some = env.load::<PositionState>(pos.position);
    let some_bytes = raw(&env, pos.position);
    assert_eq!(some.inner.stake_rate_high, HIGH_RATE);
    set_rate(&mut env, LOW_RATE);
    env.return_own(&ana, pos, source, 10).unwrap();
    let none = env.load::<PositionState>(pos.position);
    let none_bytes = raw(&env, pos.position);
    assert_eq!(none.inner.open_advance, None);
    assert!(
        none_bytes[239..].iter().any(|b| *b != 0),
        "the program leaves the Some's tail after a shorter None"
    );
    let key = pos.position.to_string();
    vec![
        (key.clone(), some_bytes),
        (key.clone(), none_bytes),
        (key.clone(), legacy_image(&[&some])),
        (key, legacy_image(&[&some, &none])),
    ]
}

#[test]
fn stake_fixtures_are_what_the_program_writes() {
    let generated = generate();
    assert!(
        generated[3].1[231..].iter().any(|b| *b != 0),
        "the 235-byte None keeps the stale tail of its Some"
    );
    if std::env::var("TESORO_WRITE_STAKE_FIXTURES").is_ok() {
        std::fs::write(PATH, render(&generated, true)).unwrap();
    }
    let file = committed();
    assert_eq!(
        std::fs::read_to_string(PATH).unwrap(),
        render(&file, true),
        "each fixture's expect is the program's decode of its bytes"
    );
    assert_eq!(
        render(&file, false),
        render(&generated, false),
        "the committed fixtures are what the current program writes (regenerate, see the module doc)"
    );
}

#[test]
fn stake_fixtures_of_235_bytes_are_refused_until_migrated_with_the_log_the_app_reads() {
    for (_, data) in committed().into_iter().filter(|(_, d)| d.len() == 235) {
        let mut env = at_open_rate();
        let ana = env.holder(0);
        let key = a(Keypair::new().pubkey());
        set_raw(&mut env, key, data.clone());
        let unlock = tix(
            accounts::Unlock {
                owner_authority: ana.key,
                owner_account: ana.account,
                economy: pda(&[ECONOMY_SEED]),
                position: key,
            },
            instruction::Unlock {},
            vec![],
        );
        let err = env.send(&[unlock], &ana.kp, &[]).unwrap_err();
        assert_eq!(code(&err), ANCHOR_DID_NOT_DESERIALIZE);
        assert!(
            err.meta.logs.iter().any(|l| l.contains(
                "AnchorError caused by account: position. Error Code: AccountDidNotDeserialize."
            )),
            "app/src/lib/errors.ts UPDATING_PATTERN reads this line: {:?}",
            err.meta.logs
        );
        migrate(&mut env, Pos { position: key }).unwrap();
        let after = raw(&env, key);
        assert_eq!(after.len(), 243);
        let want = PositionStateV1::decode(&data).unwrap().upgrade();
        assert_eq!(
            PositionState::try_deserialize(&mut &after[..])
                .unwrap()
                .inner,
            want.inner
        );
        assert_eq!(want.inner.stake_rate_high, want.inner.stake_rate_open);
        assert!(want.inner.stake_rate_open > 0);
    }
}

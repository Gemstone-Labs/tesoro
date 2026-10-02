# End-to-end QA, HyperEVM and cross-chain paths (2026-10-02)

Live pass of the HYPE lane (HyperEVM testnet, chain 998, eid 40362) and the cross-chain Matches, Backing and Redeem paths through Solana devnet, on main `85c377d` plus the fixes of this branch. `NEXT_PUBLIC_DEV_WALLET=1 next dev -p 3152` from a worktree of main, Playwright Chromium (two profiles per Match: 1440 px and 390 px), the keeper already running from main (not touched). Hoodi (eid 40449) was used only for the ETH-Sourced side of the cross-chain Matches. Times are UTC, Oct 2.

Drivers (kept in `app/scripts/`): `qa-hype.mjs` (open a Position per chain), `qa-act.mjs` (press a Wallet button, log the tracker), `qa-match.mjs` (Block Puzzle / Hold'em Challenge between two dev wallets), `qa-backing.mjs`, `qa-chain.mjs` (balances, LayerZero Scan timings), `qa-pending.mjs`, `qa-peek.mjs`, `qa-send.mjs`, `qa-cancel.mjs`, `qa-drip2.mjs`. Dev keys are throwaway, kept outside the repo.

Accounts (dev wallets):

| Dev | EVM | Account key | Role |
|---|---|---|---|
| qh1 | `0x44b7f483DdFc32907038cDAf1DDAb1911e69c09F` | | 1 simHYPE, 1 month HYPE Position (vault id 8): journey 1 |
| qh2 | `0x5bF1eD27532bdD7D9Edbd1f761409662469bf953` | | 10 simHYPE, 3 months (id 9): Backer |
| qh3 | `0x5cEdBBDf65722AEa84d437B65a25525514152c5D` | | 10 simHYPE, 3 months: HYPE-Sourced loser, tracker leave-and-return |
| qs3 | `0x8486D922Cf7FED3E42A5881FeC1Ac00f1EA67FB6` | | native 5 simSOL / 3 months: SOL-Sourced winner |
| qe2 | `0xb7E9110502282C50f6989209BfE94eca75522fB2` | | 1 simETH / 1 month (Hoodi id 8): ETH-Sourced winner |
| qb1 | `0x02685439b99D06df688768476aB8a743C02aD875` | `2wWiKZzeyoiCWankQrm1UUKVXhBt2jS6mJ7H85e36AeE` | backed Player, no Gemas |
| qs1 | `0x2B329f84eF65840565BA4a886D9a61F416eEA464` | | all three chains on one Account (SOL 5 simSOL/3 mo, ETH id 9, HYPE id 11) |

Screens: `app/docs/screens/qa-2026-10-02-hype-*.png` (97 files). Solana signatures are shortened to `first10…last8` (pre-commit hook); EVM hashes are full.

## Results

| # | Journey | Result | Evidence |
|---|---|---|---|
| 1a | Fresh tester, HYPE tab: top-up drip | PASS | qh1 0.0000 → 0.0300 HYPE in 15 to 17 s warm (87 s on the first request after a cold dev compile). Screens `qh1-1-before-drip`, `qh1-2-after-drip` |
| 1b | Second request in a day refused | PASS | qh1 sent 0.0065 HYPE back to the relayer (`0x9d3a39cd21d025031796616ff0fdc16b362cb8f898fe9d016f2abcdcf4cda529`) to get under 0.02, the button reappeared, tapping it: "Test HYPE limit reached. Each wallet gets one top-up per day." (`drip2-before`, `drip2-refused`) |
| 1c | simHYPE faucet | PASS | 10 simHYPE in 17 to 28 s, then "Faucet cooling down" |
| 1d | Open over LayerZero, tracker, Advance | PASS after retries (bug 1) | qh1 id 8: 1.2034 HYPE Principal, 45 Gemas, HyperEVM tx `0x033408ed84809b7f708ed6cbf09c992f025df24e68088c26a922c1e563b6817e`, delivered in 87 s, tracker complete 201 s after the tap. qh2 id 9 (1,372 Gemas): 39 s, 164 s total. qh3 (1,388 Gemas): 35 s, 128 s total. qs1 id 11: 41 s, 188 s total |
| 1e | Leave the tracker and come back | PASS | qh3: left at "Position recorded: Waiting", Lobby for 25 s, back on `/wallet/opening` with no `?op=`: it resumed at "LayerZero delivered, Position recorded: Confirmed" and finished. A different browser profile shows "No ETH or HYPE Position is opening in this browser" (the op lives in that browser's localStorage, by design). Screens `qh3-4b/4c/4d` |
| 1f | Keeper yield report, Debt falls | PASS | qh1: Debt 45 → 32 → 0 in 15 min with no tap (keeper reports, HyperEVM→Solana 39 s and 35 s, `0x95d9a0ec…7777e35`) |
| 1g | Redeem | PASS | qh1 13 Gemas: tile Redeem → tracker "Redeemed on Solana, LayerZero message sent, simHYPE on HyperEVM", Solana→HyperEVM 93 s (`37dcoDAiiC…htWiDzxw`); balance 45 → 32 |
| 1h | Return own Gemas | PASS | qs1 HYPE Position: Return sheet, "Returned 48", Debt 48 → 0 (`qs1-return-gemas-*`) |
| 1i | Unlock delivered back on HyperEVM | PASS | qh1: Unlock at Debt 0, `send_unlock` `5QxLJq4VQf…DWtZr6sx` delivered in 69 s, vault id 8 `unlocked = true`, simHYPE 9.995 (Principal minus the reserve for outstanding Gemas). qs1 id 11: 50 s, `unlocked = true`. qh2 id 9: 57 s |
| 2a | Block Puzzle, SOL-Sourced vs HYPE-Sourced | PASS | Challenge `3581883986817` (500): qs3 (SOL) 277, qh3 (HYPE) 16, `settle` `4sR1uuehjR…`. Winner "+450, Pending · redeemable as their yield lands"; loser "−500". qs3's Wallet, Pending by Source: `SOL Your Position 2,474 (26% of yield accrued)` and `HYPE EM5t…V625's Position 450 (0%)` |
| 2b | Hold'em, HYPE-Sourced vs ETH-Sourced | PASS | Challenge `3581885447553` (500): qe2 (ETH) all-in, qh3 (HYPE) call, ETH won +450, HYPE −500. qe2's Pending by Source: `HYPE EM5t…V625's Position`, 99% accrued when read (the 3-month Position's yield had landed) |
| 2c | Winner redeems won foreign-Source Gemas | PASS after fix (bug 2) | qe2 (ETH Player): one Redeem, 2,940 ETH-Sourced → simETH on Hoodi (141 s) and 450 HYPE-Sourced → 0.0395 simHYPE on HyperEVM (77 s, `2sesgB2D3M…9U5qwYgX`). qs3 (SOL Player, no EVM address): 450 HYPE-Sourced → 0.0398 simHYPE (97 s, `4gLyBkJr9k…wpPfzvHo`), only after the fix: before it the sheet ended with raw `NoEvmAddress` |
| 3 | Backing: HYPE-Sourced Backer, SOL-Sourced opponent | PASS | qb1 (no Gemas) Request 500; qh2 (HYPE) Offer 40%; accept; backed Challenge `3581891276307`: qb1 242, qs3 (SOL) 29, `settle` `2AuwKuK9Zr…`. Result split: Backer's 500 back, fees 50, surplus 450, Player +180 (40%), Backer +270 (60%), "You never owe anything". Redeem: qb1 180 into simSOL; qh2 845 HYPE-Sourced → simHYPE on HyperEVM (56 s) and 270 SOL-Sourced → simSOL. Screens `backing-*`, `backed-bp-result-*` |
| 4a | Advance at different Horizons | PARTIAL | 1 and 3 months driven (45/47 vs 1,372/1,388 Gemas for 1 vs 10 simHYPE); 6 and 12 months only as form quotes were not driven live |
| 4b | Unlock refused while Debt > 0 | PASS (UI) | qh2 with Debt 1,276: Unlock disabled for the whole wait. Not tried at program level |
| 4c | Drip refuses when the relayer would drop under 0.08 | PASS (unit) | `hype-topup.test.ts` 7 tests (floor is 0.05 left after the 0.03 drip). Not drained |
| 5 | Wallet with all three chains, totals, mobile | PASS | qs1: Total 5,344 = Redeemable 4,045 + Pending 1,299; Pending by Source rows `ETH Your Position` and `HYPE Your Position`; SOL, ETH and HYPE tiles with their own Debt, Unlock Estimate and buttons; `scrollWidth − clientWidth = 0` at 390 and 1440 (`wallet-three-chains-390/1440`) |

LayerZero timings (Scan, source block to destination block): HyperEVM→Solana `openPosition` 87, 39, 35, 41 s. Solana→HyperEVM Redeem payout 56 to 97 s (93, 77, 97, 56), Unlock 69, 50, 57 s. Hoodi payouts for the ETH side 141 to 189 s. Whole open (tap to Advance): 128 to 201 s on HyperEVM, 166 to 282 s on Hoodi.

## Bugs

1. **HyperEVM public RPC rate-limits and times out; the app shows raw viem text and the open fails.** Four opens and a faucet tap ended with "The request took too long to respond.", "Request exceeds defined limit." (RPC code -32005 "rate limited") or "An unknown RPC error occurred." A tracker plus the Wallet page sent 560 to 740 POSTs in 3 to 7 minutes, mostly retries of rate-limited calls (an idle Wallet page sends 8 a minute). The machine was loaded (load average 60 at times) and the keeper, the other QA agent and I share the IP, so this is partly environmental, but a judge on a shared network will see it. Fixed on this branch: reads and the dev wallet's sends go through one `evmTransport` (batched, 30 s timeout, 4 retries at 800 ms; `src/lib/chain/eth.ts:132`) and `ethError` turns these messages into "The network is busy right now. Wait a few seconds and try again." (`src/lib/chain/eth-flow.ts:72`, test `eth-flow.test.ts`). With it a retry of the same open took 86 POSTs instead of 744 and completed. **Not fixed:** the server relay has no retry for its own reads (`src/server/eth-bridge.ts:185`, `nextPositionId`); a rate-limited batch there surfaces as `500 "Ethereum Position step failed."` (`src/app/api/eth-bridge/route.ts:20`), which also says "Ethereum" for a HYPE Position. Recommendation: a dedicated HyperEVM testnet RPC in `NEXT_PUBLIC_HYPEREVM_RPC` and `TESORO_HYPEREVM_RPC` for the demo, and a short retry in the server's reads. The Privy embedded-wallet path was not driven (see below), so the transport fix covers the dev wallet and the shared read client only.
2. **A Player without a linked EVM address cannot redeem ETH/HYPE-Sourced Gemas they won.** `redeem_to_evm` fails with raw `NoEvmAddress`, after the native part already redeemed. Repro: win a Match against a HYPE- or ETH-Sourced Player with an Account that never opened an EVM Position, Wallet > Redeem. Fixed: `redeemEthHoldings` links the address first (`ensureEvmLinked`, one signature, idempotent), `src/app/wallet/EthPositions.tsx:663`. Verified live with qs3 (450 HYPE-Sourced → simHYPE, 97 s). No unit test (needs a wallet and chain); covered by the live run.
3. **The HYPE quote showed the fixed $40 fallback while the Advance used the live price.** The form said "20 / 21 Gemas" for 1 simHYPE / 1 month, the Position got 47 to 48. The server's Coinbase fetch has a 4 s timeout and this machine needs 2 to 5 s, so the price fell back (`live: false`) and the fallback was cached for 60 s (`src/server/eth-bridge.ts:392`). Fixed: 10 s timeout, and a failed refresh keeps the last live price for 10 minutes (test `asset-price.test.ts`, fails on the old code). **Still open:** the form (`src/app/wallet/EthPositions.tsx:233`) quotes the fallback as if it were real when `live` is false; it should say "price unavailable" instead of a Gemas figure.
4. **Contradictory "not enough Gemas".** qs3 had just opened a Position (header 3,357 Gemas) and `/play/queue` said "You do not have enough Gemas for this entry" at a 1,000 entry. Probably stale Holdings from the gpa cache right after the open (it worked a minute later) but not confirmed; repro: open a Position and tap Play now at once. Also the header Gema chip read 0 on the "Your Position is open" screen right after the Advance (list cache), cosmetic.
5. **Redeem can open the offline mock sheet.** Once, a header Redeem tapped within seconds of page load showed the mock `RedeemSheet` (`src/app/wallet/MoneySheets.tsx:13`: "13 → 0.003 HYPE" at the fixed $40, a confirm button that only flips a local flag). `src/app/wallet/page.tsx:64` picks it when `onChain` is false. Not reproducible after the account had loaded (3 later attempts opened the real sheet). Suggest ignoring the tap while auth is loading, or deleting the mock sheet for signed-in sessions.
6. Queue pairing is contested when other players (the other QA agent) use the same entry: two Queue attempts at 500 paired with strangers and ended 0 to 0 draws, or never paired. Challenge links were deterministic and are what I used for every Match above. Not an app bug, but it affects a live demo at the default entry.

Doc nits: `app/docs/hype-test-guide.md` says the drip refuses when the relayer is under 0.08, the code keeps 0.05 after the drip (same thing); it says the drip takes 10 to 25 s, true warm, 87 s on the first call of a cold `next dev`.

## Fixes committed on `qa/app-e2e-hype-02-10-2026`

- `fix(app): batch and retry public EVM RPC calls, plain message for rate limits`
- `fix(app): link the EVM address before redeeming ETH/HYPE-Sourced Gemas won by a Player without one`
- `fix(app): treat viem's unknown RPC error as a busy network`
- `fix(app): keep the last live HYPE/ETH price for 10 minutes when a refresh fails`
- `fix(app): give the Coinbase price fetch 10 s`

Verified on the branch: `tsc --noEmit` clean, eslint clean on the touched folders, vitest 255 tests pass (3 new test files/cases: `eth-flow.test.ts`, `asset-price.test.ts`). `pnpm build:app` not run.

## Not driven

- Privy embedded wallet on chain 998 (needs the Privy dashboard step and an inbox); every run used dev wallets.
- A Backer with HYPE-Sourced Gemas backing a Player against an ETH-Sourced opponent (the ETH side had redeemed its Gemas by then); Backing was driven with a SOL-Sourced opponent.
- Advance at 6 and 12 months live; Unlock refusal at program level.
- A drip refusal because the relayer is under 0.08 (unit test only, not drained).
- Browser-level tracker for ETH leave-and-return (HYPE only).

## Balances and leftovers

- Relayer EVM `0x0aa6F8bB9c163730951f457b5B210bAe8b4997f8`: HYPE 2.22 → 2.0765 (about 0.14 spent: 5 drips of 0.03 and relay gas, minus 0.0065 returned by qh1); Hoodi ETH 0.1458 (no baseline taken; 4 ETH drips of about 0.0059 plus relay gas by me). Deployer key not used.
- Relayer Solana `G7zDD6KfwB…cTYP`: 3.54 SOL at the end (no baseline; it also serves the other QA agent).
- Dev wallets: all testnet, nothing else spent.
- Leftovers on chain: `qs1`/`qs2` two waiting 1,000 Block Puzzle Matches (`3581881090874`, paired with each other, never played; they expire/refund by deadline), qh2's waiting 500 Match was cancelled and refunded, qb1's and qh3's other open Requests none. HYPE Positions ids 8, 9, 11 are Unlocked; qh3's (3 months, 388 own Gemas) is still Active.

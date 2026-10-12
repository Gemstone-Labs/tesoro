# Tesoro

**Play now with yield you haven't earned yet.**

Tesoro lets stakers play head-to-head skill games with their future staking yield:

1. Lock a **Position**: a SOL or ETH liquid staking token.
2. Take an **Advance** of 80% of the Position's projected yield (100% minus Tesoro's 20% **Yield Fee**) over a 1–12 month **Horizon**. It is issued as **Gemas**, worth $0.01 each at issuance.
3. Play **Matches**: async Block Puzzle, real-time heads-up Hold'em, or Trading Duel (a real-time trading Match on a live oracle price).

The **Principal is never played** and never pays Debt. Accrued yield repays the Advance automatically, and winners Redeem the Gemas they won as the loser's yield actually accrues, or **Instant Redeem** them now for 65% of their value (Tesoro's Treasury pays and waits for the yield; ADR 0007). Tesoro earns the Platform Fee on Matches, the Yield Fee and the Instant Redeem Fee; nothing is ever charged on Principal.

> **Status: testnets only.** Solana devnet and Ethereum Hoodi. Yield is **Simulated** (1 month = about 10 minutes). Nothing has value. The security review is internal, not an external audit.

[PLACEHOLDER: pitch video URL] · [PLACEHOLDER: demo video URL] · [PLACEHOLDER: hosted app URL, if any]

---

## What's real and what's simulated

| Real (on testnets) | Simulated, stand-in or not done |
|---|---|
| Six Solana programs on devnet: the `tesoro_core` ledger, the `block_puzzle`, `holdem` and `trading_duel` Game programs, the `tesoro_bridge` LayerZero OApp, and `sim_lst` | **Yield is Simulated.** `sim_lst` (simSOL, 7% APY) and the Hoodi `SimLST` (simETH, 5% APY) run a 4,380× clock: 1 month of yield every 10 minutes. Their faucets mint unbacked test tokens. |
| Matches settled on chain from a **MagicBlock Private Ephemeral Rollup** (Intel TDX TEE). The deck, the hole cards, the Block Puzzle Seed and each Player's moves stay private until settlement. | **Prices come from a trusted oracle key.** The SOL/USD issuance price is an on-chain devnet `PriceFeed` that the keeper writes with the oracle key (median of CoinGecko and Coinbase spot). The ETH issuance price is signed by the same key. Reading Pyth on chain is planned. |
| ETH Positions on **Ethereum Hoodi**, carried to the Solana ledger by **LayerZero V2**: open, Advance, yield report, Redeem to Hoodi and Unlock, all tested end to end | The full ETH round trip ran on the previous Hoodi vault. The current vault (redeployed 2026-10-01 for SP-01) was smoke-tested for open and yield, not for Redeem and Unlock. |
| HYPE Positions on **HyperEVM testnet** over the same bridge: open, Advance, yield report and Redeem payout (Solana to HyperEVM) delivered on chain; opened from the Wallet's HYPE tab | **Simulated** simHYPE (1 month = 10 min). Unlock was not run on HyperEVM, and a wallet needs its own testnet HYPE (no faucet to relay). |
| A Hoodi vault for Lido's real **wstETH**, deployed and wired | Not run end to end, and not offered in the app (there is no wstETH faucet). |
| Backing (Request → Offer → backed Match → split), played in the browser on devnet | Backed Hold'em has not been played. Only backed Block Puzzle has. |
| A keeper that writes the price, cranks yield, relays bridge messages, expires Offers and settles or refunds stalled Matches | **Demo funding routes.** The app server tops up devnet SOL for fees, and Hoodi ETH for gas plus test simETH, from low-balance relayer keys. simSOL comes from the `sim_lst` on-chain faucet. These exist only for the demo. |
| Privy sign-in (email, Solana wallets, Ethereum wallets) and embedded wallets are integrated; Player profiles (name, picture, `.sol` / `.eth` names) are in the app and in `tesoro_core` but not yet deployed | The demo was driven with a dev-only local wallet (`NEXT_PUBLIC_DEV_WALLET=1`). Privy has not been run end to end. |
| | **No external audit.** An internal security review and an internal implementation review were done (see [Security](#security)). |

## How it works

- **Position → Advance → Gemas.** Advance = Principal × APY × months ÷ 12. It is priced once at issuance and floored to whole Gemas. Example from QA: 1.3149 SOL × 7% ÷ 12 × $150 = $1.15, so **115 Gemas**. After issuance, each Gema is fixed as an amount of its **Source** asset.
- **Debt repays itself.** All accrued yield on a Position with Debt repays it. On devnet, Debt went 447 → 264 → 19 → 0 Gemas over one simulated month (about 10 minutes). The Principal never pays Debt, and a direct top-up to the vault is ignored (security review F-05).
- **Matches.** Entries are 500, 1,000 or 2,500 Gemas. The winner receives the loser's actual Gemas, each keeping its Source, minus a **Platform Fee**, a **Studio Fee** and a **Leaderboard Fee**. On devnet these are placeholders of 200 + 300 + 100 bps of the Pot, taken from the loser. A 500-entry Match pays the winner **+440**. The Leaderboard Fee fills a weekly prize pool (below).
- **Leaderboard.** Each won Match earns its Player points (entry ÷ 100: 5, 10 or 25, the same in every game). Every Monday 00:00 UTC a Season ends and the Leaderboard Pool pays the top ten on a sliding scale (25 / 18 / 13 / 10 / 8 / 7 / 6 / 5 / 4 / 4%); with fewer than ten Players the rest rolls over. Standings are recomputed from on-chain `MatchWon` events by the keeper, which records and pays each Season (ADR 0006); the page is `/leaderboard`.
- **Redeem.** A holder can Redeem at most `held × (covered − redeemed) ÷ outstanding` for each Source, so winnings become redeemable only as the loser's yield lands.
- **Backing.** A Backer funds a Player's whole entry. On a win the Backer's entry comes back first and the surplus is split by the Offer. On a loss the Backer bears it: the Player loses 0 Gemas and gains no Debt.

Design records: `CONTEXT.md` (glossary; its terms are used verbatim everywhere) and `docs/adr/` (0001 Gemas are claims on accrued Source yield, 0002 LayerZero V2, 0003 Games as programs in Private Ephemeral Rollups, 0004 PvP only, 0005 per-Position simulated yield, 0006 Leaderboard Pool). Ledger details: `docs/tesoro-core.md`. Cross-chain flow: `docs/cross-chain.md`.

Longer explainers live in the app's Docs (`app/src/app/(docs)/docs`, served at `/docs`): [How Tesoro works](app/src/app/(docs)/docs/how-it-works/page.tsx) for players, and for developers the architecture, program addresses, settlement, rollups, cross-chain, simulated yield, security and local-run pages under `/docs/developers`. Run the app and open `/docs`.

## Deployed addresses

Checked on chain on 2026-10-01 (`solana program show`, account reads, `cast code` / `cast call` on Hoodi). Signatures for every deploy, upgrade and setup step: `docs/deployments.md`.

### Solana devnet

Base-layer RPC: `https://rpc.magicblock.app/devnet` (the public `api.devnet.solana.com` rate-limits).

**Upgrade authority of all five programs and admin of `tesoro_core`, `sim_lst` and `tesoro_bridge`** (also the LayerZero OApp delegate): `7zr1j185zT8r6jcysC4LyrdSEJ13Up3xq4TFu6KQqh7M`. It replaced a compromised key on 2026-10-01; see [Key compromise](#key-compromise-2026-10-01).

| Program / account | Address |
|---|---|
| `tesoro_core` | [`AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh`](https://explorer.solana.com/address/AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh?cluster=devnet) |
| `tesoro_core` Config | `Che6m7vayXRFRn4Sti9FH4V4usE5bPEyPUvkiHP6hDgZ` |
| Platform and Studio Fee recipient (a Tesoro Account, authority `7zr1…qh7M`) | `GXQse6RG4hqY57fhRJX3W7yzhkwmaqZUHxaJArJWrMGK` |
| Oracle (trusted price and ETH issuance signer) | `6bpAyMvaHF5QdghrxnPRmdvHqCiLbigdXVroe4zDRApA` |
| `block_puzzle` | [`5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj`](https://explorer.solana.com/address/5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj?cluster=devnet) |
| `block_puzzle` Game authority PDA (registered in `tesoro_core`, Studio Fee 300 bps) | `7HTncQ9Gc2gamBqce5C7sz95SU6RnR9CoDt1D3o2U4nx` |
| `holdem` | [`CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE`](https://explorer.solana.com/address/CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE?cluster=devnet) |
| `holdem` Game authority PDA (registered in `tesoro_core`, Studio Fee 300 bps) | `Eu2RtadRsFCV9Xe2A7v7GivS9W5Trbrz6tCagNRUCwtn` |
| `holdem` delegation ProgramConfig (TEE validator whitelist) | `CVBjwJ8LaJS37zokHDjgkWASNPW9X5oWxmCHT2DvVKL3` |
| `trading_duel` | [`CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj`](https://explorer.solana.com/address/CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj?cluster=devnet) |
| `trading_duel` Game authority PDA (registered in `tesoro_core`, Studio Fee 300 bps) | `mPXSGjpEeSeJnmrBw3CKCoLbbftAsjsbiP1eE3wHcoe` |
| `trading_duel` delegation ProgramConfig (TEE validator whitelist) | `43amrCapYPLYz9tGPcdxw84A3Hby9j4kSTmDTCmu7xZb` |
| MagicBlock TEE validator (the only validator allowed to receive delegations) | `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |
| `sim_lst` (**Simulated** LST) | [`WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F`](https://explorer.solana.com/address/WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F?cluster=devnet) |
| `sim_lst` Pool PDA (7% APY, 4,380× speedup) | `Fc9UUnGEDapkBDM3mPayjqVDLYHokKCPwSLdbvKBUvPL` |
| simSOL mint PDA (9 decimals) | `3Q2VRPmdAZHutWNhE2Rof9Pdg6MnTMotXucmoD5cgAZJ` |
| `sim_lst` vault / reserve PDA | `2fQyEVMJNzGmaccxpbzhqMRFSpx9mf1kjsZRAMMRNKDm` |
| `tesoro_bridge` (LayerZero V2 OApp) | [`5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ`](https://explorer.solana.com/address/5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ?cluster=devnet) |
| OApp Store PDA (the EVM vaults' peer) | `7WQLHW8EuyV1V8tWNh8DQGu7mVRgaHGgLU7fi8G91rVw` = `0x60ae58df1215bf45cc054e633b49c92a3b1309f76075bac72b26e0c6e1c0c792` |
| Bridge authority PDA (`tesoro_core` source authority for Ethereum and HyperEVM) | `FEgxs5f7zavRaR7tZJBNZzrYeCMGegMpMWFiHjvyvaLg` |

### Ethereum Hoodi (chain 560048, LayerZero eid 40449)

Both vaults are owned by the EVM deployer `0x96137cB99Fe2878299b672Ac967e88279f479d1C` and peered to the Solana OApp Store above. They are not upgradeable. Earlier vaults are retired, and Positions on them were not migrated (`docs/deployments.md`).

| Contract | Address | Notes |
|---|---|---|
| `PositionVaultOApp`, SimLST (simETH, **Simulated**) | [`0x8B099AbfC204E1a07D6CA686D302CE6cbC07a3A3`](https://hoodi.etherscan.io/address/0x8B099AbfC204E1a07D6CA686D302CE6cbC07a3A3) | The vault the app uses. Redeployed 2026-10-03 for per-Position yield (`docs/yield-model.md`). |
| `PositionVaultOApp`, real Lido wstETH | [`0x61B46f64CDB75930a87955487aAb8A7711F757b5`](https://hoodi.etherscan.io/address/0x61B46f64CDB75930a87955487aAb8A7711F757b5) | Deployed and wired, not run end to end. Redeployed 2026-10-01. |
| SimLST (simETH, **Simulated**, 5% APY) | [`0xD82840623A7a00C37b0883d221Fa84e39ddA2a28`](https://hoodi.etherscan.io/address/0xD82840623A7a00C37b0883d221Fa84e39ddA2a28) | |
| `WstETHRateAdapter` | [`0x9C5fc1098a33Ec14a9c5a73c2cBa1CbcDD65AB37`](https://hoodi.etherscan.io/address/0x9C5fc1098a33Ec14a9c5a73c2cBa1CbcDD65AB37) | The wstETH vault's rate source. Reads wstETH `stEthPerToken()`. |
| LayerZero EndpointV2 (external) | `0x3aCAAf60502791D199a5a5F0B173D78229eBFe32` | |
| Lido stETH / wstETH (external) | `0x3508A952176b3c15387C97BE809eaffB1982176a` / `0x7E99eE3C66636DE415D2d7C880938F2f40f94De4` | |

### HyperEVM testnet (chain 998, eid 40362)

Owned by the same EVM deployer and peered to the same Solana OApp Store. Deployed 2026-10-02 (not upgradeable); wired on Solana at 500 bps. Transactions and the smoke test (every LayerZero message DELIVERED) are in `docs/deployments.md`; the flow is in `docs/cross-chain.md`.

| Contract | Address | Notes |
|---|---|---|
| `PositionVaultOApp`, SimLST (simHYPE, **Simulated**) | `0xf70dafE2788881F6ae54Bea7342dcb3D9b92A316` | The vault the app uses for HYPE Positions (redeployed 2026-10-03). |
| SimLST (simHYPE, **Simulated**, 5% APY) | `0xC8A9AccD25ABDCF3FCBDE7123Cef8239B5bE7eF3` | Unbacked faucet, 1 month = 10 min. |
| LayerZero EndpointV2 (external) | `0xf9e1815f151024bde4b7c10bac10e8ba9f6b53e1` | Explorer: `https://testnet.purrsec.com`. |

## Evidence (selected)

| What | Where |
|---|---|
| Native Position lifecycle: open + Advance (447 Gemas), yield (Debt 447 → 264 → 19 → 0), Redeem, Unlock | `docs/deployments.md` → "tesoro_core upgrade: Solana-native Positions"; e.g. open `5FnLCAT7…zQXo9xrL`, unlock `HZWYkvfh…4hdjzsGK` |
| ETH Position over LayerZero, full round trip in the browser on the previous vault: open on Hoodi → Advance on Solana → yield → Redeem to Hoodi → Unlock | `docs/qa/2026-09-30.md` → "Journey 7"; e.g. send_unlock on LayerZero Scan `5i86kToB…xYWN3Hk7` |
| ETH Position on the current vault: open → `apply_locked`, `reportYield` → `apply_yield` | `docs/deployments.md` → "SP-01 / PR-01 replacement vaults"; [openPosition](https://testnet.layerzeroscan.com/tx/0x1c886400dd75ccb703abf18fc92a3f9abbf4180a3d42711d084d455bfc90df62), [reportYield](https://testnet.layerzeroscan.com/tx/0x36b25666d10e4c8558836fa5d2a16f9628105bfc1a6f800dcbfb2c1af5dd3de3) |
| Block Puzzle async Match: private Seed and moves, settled by CPI | `docs/games/block-puzzle.md`; settle `KK3MY8Dj…Rfz7gVss` |
| Hold'em Match in the browser: 4 hands, a timeout claim, a showdown, finalize | `docs/games/holdem.md`; finalize `4uBFPi6V…ki6v1cNc` |
| Backed Match: the Backer's entry back first, a 60/40 split, the Player owes 0 | `docs/games/backing.md`; settle `576rrHvz…wmJ4nfDa` |
| End-to-end QA in the browser (8 journeys, 7 bugs found and fixed) | `docs/qa/2026-09-30.md`, screens in `app/docs/screens/qa-*.png` |
| Security review: 14 findings, with fixes deployed | `docs/security/audit-2026-09-30.md` (internal, not an external audit) |

Signatures are shortened here; the linked docs list them in full. TEE (rollup) transactions are private and have no public explorer page. Their signatures are in the `evidence.json` files next to each Game's scripts (`programs/block_puzzle/scripts/`, `programs/holdem/scripts/`).

## Run it

Requirements:

- Node 22 (Next.js 16 needs at least 20.9) and pnpm 10.
- For the programs: Rust 1.91.1 (pinned by `rust-toolchain.toml`), Anchor 0.31.1, and Solana platform tools v1.54, which the build script requests.
- For the contracts: Foundry.

All commands run from the repo root after `pnpm install`.

### App

```bash
pnpm install
NEXT_PUBLIC_DEV_WALLET=1 pnpm dev    # http://localhost:3000 (landing; the app starts at /lobby), with a dev-only local wallet
```

Every RPC defaults to `https://rpc.magicblock.app/devnet`, so no configuration is needed. To use your own endpoints, create `app/.env.local` with only the variables you set. `app/.env.example` lists them. Leave unset variables out instead of copying them blank, because an empty value overrides the default.

| Variable | Side | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_RPC` | browser | single-account reads, sends, confirmations (ships to the browser: use a domain-restricted key) |
| `TESORO_BASE_RPC` | server | reads and sends in API routes |
| `TESORO_GPA_RPC` | server | `getProgramAccounts` list queries behind `/api/chain/accounts` |
| `KEEPER_RPC`, `KEEPER_GPA_RPC` | keeper | the keeper's sends and list queries (it reads `app/.env.local` for anything its own env leaves unset) |
| `NEXT_PUBLIC_DEV_WALLET=1` | browser | dev-only local wallet instead of Privy (compiled out of production builds) |
| `NEXT_PUBLIC_PRIVY_APP_ID` | browser | Privy sign-in. Without it the app runs signed-out. |
| `TESORO_SOL_MAINNET_RPC`, `TESORO_ETH_MAINNET_RPC` | server | Mainnet endpoints for `.sol` / `.eth` name lookups (`/api/names`); public endpoints by default. |
| `NEXT_PUBLIC_HOODI_RPC` | browser | Hoodi RPC (default `https://ethereum-hoodi-rpc.publicnode.com`) |
| `NEXT_PUBLIC_SITE_URL` | build | canonical URL for metadata |
| `TESORO_RELAYER_KEYPAIR`, `TESORO_RELAYER_EVM_ENV` | server | low-balance relayer keys for the demo funding routes (default `~/.config/tesoro/relayer.json`, `relayer-evm.env`). Without them those routes answer `503 not-configured`. |

What to try:

- `?dev=<name>` (for example `/?dev=alice`) picks a named dev wallet, so two browser windows can be two Accounts that play each other.
- In **Wallet**: "Get test simSOL" → **Open a Position** (amount, Horizon). The Gemas arrive in one transaction.
- In **Lobby**: pick an entry → **Play now**. Block Puzzle lets you play before an opponent is paired.

Storybook: every screen, component, asset and animation on fixtures, offline (see `app/docs/storybook.md`).

```bash
pnpm --filter @tesoro/app storybook   # http://localhost:6006
```

Checks:

```bash
pnpm build:app                                      # production build (also generates Next's route types)
pnpm --filter @tesoro/app exec tsc --noEmit         # needs the route types: run after build:app or `next typegen`
pnpm --filter @tesoro/app exec eslint src
pnpm --filter @tesoro/app test                      # vitest
```

### Programs

```bash
pnpm build:programs     # scripts/build-programs.sh: Anchor 0.31.1 with platform tools v1.54 (plain `anchor build` fails)
cargo test --workspace  # ledger property tests and LiteSVM integration tests
```

The bridge is its own Anchor workspace because of its LayerZero git dependency. It needs the same platform tools: `cd bridge && anchor build --no-idl -- --tools-version v1.54`.

Program IDs are fixed by `declare_id!` and the deploy keypairs, which are not in the repo. A build without them produces the same programs, but you cannot deploy them over these IDs.

### Contracts

```bash
pnpm build:contracts    # forge build
pnpm test:contracts     # forge test
```

Deploy scripts: `contracts/script/deploy-oapp.sh <hoodi|hyperevm> <sim|wsteth>` and `contracts/script/oapp.sh` (peer). Bridge wiring: `pnpm lz wire …` in `bridge/` (see `docs/cross-chain.md`).

### Keeper

```bash
pnpm --filter @tesoro/keeper start --once --dry-run   # one pass that prints what it would do and sends nothing
pnpm --filter @tesoro/keeper start                    # loop every 20 s
pnpm --filter @tesoro/keeper test
pnpm --filter @tesoro/keeper typecheck
```

The keeper uses a payer at `~/.config/tesoro/keeper.json`, which it creates on first run. Fund it yourself, or set `KEEPER_FUNDER` to a keypair path to top it up. Some jobs need keys that only the team holds: the oracle key signs `set_price`, and the EVM key `~/.config/tesoro/evm-deployer.env` sends `reportYield`. Without those keys, the other jobs still run. Jobs, flags and limits: `keeper/README.md`.

## Security

Two internal reviews, no external audit.

**Security review (2026-09-30)**, `docs/security/audit-2026-09-30.md`. It covers the on-chain code: `tesoro_core`, both Game programs, `sim_lst`, `tesoro_bridge` and the EVM contracts. It found 14 findings (Critical 1, High 3, Medium 3, Low 6, Info 1), each with a failing proof test first.

| Status | Findings |
|---|---|
| Fixed and deployed | F-01 (Critical: delegation not pinned to the TEE validator, so a Player could commit a forged result), F-02 (High: spoofable privacy permission), F-03 (High: a Hold'em Match could be refunded mid-play after 1 h), F-04 (High: out-of-order LayerZero delivery could strand Principal; the vaults were redeployed), F-05 (top-up to a vault repaid Debt), F-06, F-07, F-09 (except `match_id` squatting), F-12 |
| Mitigated | F-13 (an oversized PayYield reverts and is retried once yield catches up) |
| Accepted for devnet | F-08 and F-11 (simulated faucets), F-10 (first-caller Config init; already initialised), F-14 (informational) |

**Implementation review (2026-09-30 to 2026-10-01)**, internal and not in the repo. It covers the app, keeper, server routes, contracts and programs: 29 findings (P1 2, P2 14, P3 13). The table shows the status on 2026-10-01.

| Status | Findings |
|---|---|
| Fixed on `main` | SP-01 (P1: the EVM vault underpaid yield after an earlier payout; vaults redeployed), ST-01 (P1: a faucet quota rollback could be bypassed), PR-01 (Principal above `u64` locked for good; vaults redeployed), SP-02, SP-03 (ETH redemption tracked against the wrong Source or holder), OC-01 (stale price re-stamped as fresh; keeper side), OC-02 (the web server held admin keys; now low-balance relayer keys), OC-05 (one hung RPC stalled every keeper job) |
| Fixed on review branches, not yet merged | OC-03, OC-08, OC-09, OC-10 (app side): server route hardening. OC-04: a duplicate Match on a join timeout. SP-04: Return own Gemas in the Wallet. P2B-01 to P2B-07: Match history and results, labels. ST-02, ST-03: simulation labels, Pending by Source |
| Open | SP-05 (undelegated Hold'em no-show refund delay), OC-06, OC-07, OC-10 (keeper side), OC-11: keeper fixes in progress. PR-02 (no-show can turn a forfeit win into a refund), PR-03 (an Advance can be priced from a feed up to 24 h old), on-chain bounds for `set_price`: these need a program upgrade. |

**Residual risks**, from the security review:

- The oracle key and price feed are trusted. A wrong price mints the wrong number of Gemas.
- Privacy depends on MagicBlock's TEE attestation. Cross-chain messages depend on the LayerZero DVN set.
- One admin key holds every admin power and can upgrade every program.

### Key compromise (2026-10-01)

At 05:26 UTC on 2026-10-01, the original devnet deployer key `AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV` sent its whole balance, 24.63 devnet SOL, to [`888Hn7eBJFUcAvLPYQhgva9jSk1eG21QSsTRiCN5EkwE`](https://explorer.solana.com/address/888Hn7eBJFUcAvLPYQhgva9jSk1eG21QSsTRiCN5EkwE?cluster=devnet) (tx `2WbwBf9X…FgYqiMWR`). The team treated the key as compromised. It held testnet funds only. That key was the upgrade authority of every program, the admin of `tesoro_core`, `sim_lst` and `tesoro_bridge`, the LayerZero OApp delegate, and the owner of the fee recipient. [PLACEHOLDER: founder to state how the key leaked, if known.]

Response, the same day:

- **Upgrade authority** of all five programs moved to `7zr1j185zT8r6jcysC4LyrdSEJ13Up3xq4TFu6KQqh7M`.
- **Admin rotation.** A `set_admin` instruction, gated on the upgrade authority, was added to `tesoro_core`, `sim_lst` and `tesoro_bridge`. It rotated the Config, Pool and Store admins and the LayerZero delegate to the new key.
- **Fee recipient** moved to the new Account `GXQse6RG4hqY57fhRJX3W7yzhkwmaqZUHxaJArJWrMGK`. Fees the old fee Account had already collected stay under the old key.
- **Other keys.** The web routes now sign with separate low-balance relayer keys. A pre-commit secret scanner was added to the repo. The oracle, keeper and EVM deployer keys were not changed.

Signatures: `docs/deployments.md` → "Key compromise response".

## Repo layout

| Path | Contents |
|---|---|
| `programs/` | Anchor workspace: `tesoro_core`, `block_puzzle`, `holdem`, `trading_duel`, `sim_lst` |
| `bridge/` | `tesoro_bridge` and the LayerZero scripts |
| `contracts/` | Foundry: `PositionVaultOApp`, `SimLST`, `WstETHRateAdapter` |
| `app/` | Next.js 16 |
| `keeper/` | the keeper |
| `docs/` | ADRs, per-component docs, deployments, QA, security |

## Built during the hackathon

The current codebase was started from scratch on 2026-09-30, inside the Crypto World's Fair window (Sep 14 – Oct 12, 2026). [PLACEHOLDER: disclose earlier Tesoro work from Aug–Sep 2026, which lives in a separate, archived codebase, as the rules require.]

## Team

[PLACEHOLDER: names, roles, one verified credential each, team location]

## License

[PLACEHOLDER: choose a license. The repo has none yet, and open source is one of the judging criteria.]

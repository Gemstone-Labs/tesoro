# Deployments

Testnets only. SimLST is SIMULATED (accelerated yield clock, default 1 month per 10 minutes at 5% APY). `MockEndpoint` stands in for LayerZero until the OApp lands.

## Ethereum Hoodi (chain 560048, Tesoro chain tag / LayerZero eid 40449)

Deployed 2026-09-30 by the deployer in `~/.config/tesoro/evm-deployer.env` via `contracts/script/Deploy.s.sol`.

| Contract | Address | Deploy tx |
|---|---|---|
| SimLST (simETH) | `0x23B17A4c55867406E7CD5602c664E1447400c4a3` | `0x46c8c1f13414846312321303a52600ff153d2e6847d11e17384682200e1957dc` |
| MockEndpoint | `0xf6a7F770bCA297414d11BDF7F5e580a54DAa3F89` | `0xf085ffa3e0001372053457d18f4f17d39c1050019b353886e0ddfd9bc3baa28e` |
| PositionVault (SimLST) | `0x5b0bF0a1dFf3DbE665Ef45175Dd72AcF1a541db9` | `0xebfeaae8203201e527d70b39049d3d68616f0db4e282077742e9258f82d12e21` |
| SimLST reserve funding (0.05 ETH) | to SimLST | `0xc0cafd62c302ad2301ee6d7a08933d2816fde83187ecbb1157a3c1c0ef97c124` |
| WstETHRateAdapter | `0x9C5fc1098a33Ec14a9c5a73c2cBa1CbcDD65AB37` | `0xb3c25015f35fea38336ed26a75e5752da3fda2db43f82802b9787ec4581ce22f` |
| PositionVault (real wstETH) | `0xf3cfE452C3E4cc9A6cbC0A66D41671D2A2C9c647` | `0x6ee1a120b18b3090216289125c180b9c0554c5c972bee05dc424f63653795232` |

External (Lido on Hoodi): stETH `0x3508A952176b3c15387C97BE809eaffB1982176a`, wstETH `0x7E99eE3C66636DE415D2d7C880938F2f40f94De4`.

Verified on chain: `WstETHRateAdapter.underlyingPerShare()` returns wstETH `stEthPerToken()` = 1.032056972493021269e18.

## HyperEVM testnet (chain 998, eid 40362)

Not deployed: the deployer has no HYPE. The same script handles it (`--rpc-url https://rpc.hyperliquid-testnet.xyz/evm`): SimLST + MockEndpoint + PositionVault (SimLST only). Enable big blocks first (`{"type":"evmUserModify","usingBigBlocks":true}`) if any contract exceeds the 3M small-block gas limit.

## Solana devnet

Deployed 2026-09-30 from the deployer `AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV` (upgrade authority) via `https://rpc.magicblock.app/devnet`.

| Program | ID | Deploy tx |
|---|---|---|
| tesoro_core | `AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh` | `t2kA9H15c7MfyZUR7HvaFDYMHw1FWzTk4DSXjzSVsiJWAJGhwL5zDXEhQPro5S8mfH3tAocmqAuadECuB9w3WWm` |
| block_puzzle | `5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj` | `5ok3zXTJv3FmBQGMYRjuGVa2gcp6MmAgvGi8NdKouxRT7SeEMBHCR4oPGjbe5xRDwFXCGT6mbHRZWLvrQhjpRYUP` |
| holdem (S1) | `CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE` | see docs/spikes/S1.md |

tesoro_core setup (idempotent, `programs/block_puzzle/scripts/devnet-match.ts`):

| Step | Signature |
|---|---|
| `initialize_config` (admin = deployer, oracle = `~/.config/tesoro/oracle.json`, platform fee 200 bps) | `54xsxnDE8yTvKogmT7n4g2KvJFhe8wedikbtBkhLaAQh67sY9f7ecpza7ocCWJXinaftgf27m7s1g4nPMEt5761B` |
| `register_game` (block_puzzle, authority = PDA `["authority"]` of block_puzzle, studio fee 300 bps, studio recipient = the deployer's Account) | `4TAsGBsX8j3t3LRKfiecBJThnYsQ25Gx1Hvg7pXS82ybLZis2EAtt3XgLrXfYj3xG4ubW7iU3pkNYK8pbo7nP3FH` |

Block Puzzle end-to-end Match (two test wallets, devnet TEE, settled through tesoro_core by CPI): see `docs/games/block-puzzle.md`; settle tx `221GKqoz6TyUcGQ9CCCxmgRxLsLyWhQwmKGFKnCZMkYDsKxGD6xBujYSRkVecu4kndzQmpPiwFRYh7pjJHmJGsRg`.

The oracle and test-wallet keys are in `~/.config/tesoro/` (`oracle.json`, `block-puzzle-testers.json`), not in the repo. The tesoro_core on devnet includes `extend_match_deadline`.

### sim_lst (SIMULATED liquid staking token — "Simulated yield · 1 month = 10 min")

| Item | Address |
|---|---|
| Program | `WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F` |
| Pool PDA (`["pool"]`) | `Fc9UUnGEDapkBDM3mPayjqVDLYHokKCPwSLdbvKBUvPL` |
| simSOL mint PDA (`["mint"]`, 9 decimals, authority = pool) | `3Q2VRPmdAZHutWNhE2Rof9Pdg6MnTMotXucmoD5cgAZJ` |
| Vault / reserve PDA (`["vault"]`, system-owned SOL) | `2fQyEVMJNzGmaccxpbzhqMRFSpx9mf1kjsZRAMMRNKDm` |
| Admin / deployer | `AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV` |

Config: APY 7% (700 bps), speedup 4,320 (1 month of yield per 10 minutes), faucet 10 simSOL per user per hour.

Rate (SOL per simSOL, 1e9 fixed point): `base_rate + base_rate * apy_bps * ((now - base_ts) * speedup) / (10_000 * 31_536_000)`.
Linear between checkpoints; `set_params` rebases first, so changes compound. Read it from the `Pool` account
(`base_rate`, `base_ts`, `apy_bps`, `speedup`) or via the `get_rate` instruction return data. Yield is paid from the
admin-funded reserve; withdrawals beyond the vault balance are refused. The faucet mints unbacked simSOL.

Helpers: `scripts/sim-lst` (`pnpm rate`, `pnpm faucet`, `pnpm tsx src/cli.ts init | fund <sol>`).

Deploy status (2026-09-30, via `https://rpc.magicblock.app/devnet`):

| Step | Signature |
|---|---|
| deploy | `4Ttfse8f3Ktji6tzk4uweLGBcxngSUFx85rhtzdwmiSpwv43oHPPjvUWA4Kj72BSMmh7otza16PYo8zvYogQmgJ3` |
| init (7% APY, 4,320× speedup, faucet 10 simSOL/h) | `3nVnaaBRmEtm34yTjzrcaYyotuhHpzTaBJqftRkRQBW95LbZppmc3wpFv1TCTgUheB4Bp6xYDp9d3S9YxeLqwRaV` |
| fund reserve 20 SOL | `4bvoXZ8zfe6LVUPTfzVFTdKpx8Bz2LPQEoXJUj3G2HPTLyHUshm4jmLwRfNr4nzET4mhDrEZkmDe9EnfMKCCvH2r` |

### tesoro_core upgrade: Solana-native Positions (2026-09-30)

Backward-compatible upgrade of `AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh` via `https://rpc.magicblock.app/devnet` (adds `open_native_position`, `take_native_advance`, `accrue_native_yield`, `sweep_native_surplus`, `set_price`; `redeem`/`unlock` pay from the vault for native Positions). See `docs/tesoro-core.md`. SIMULATED yield.

| Step | Signature |
|---|---|
| upgrade | `5PSa6jL4QUxVy1iWyrzJ5XBvzaGAxWdyC68MnAHqniBAup253bzp1FqSx9RXvx7kbWuzEoCipdfydstsDiLwf2VZ` |
| `set_price` ($150, oracle) | `49aXJZc4fBySnmuRQTfsgghVEDsQRM8sq4oz92Zj1ZXSKr5yNQpMQR2vP3Chzf113UDa5QTUpsVrX1VpqRbpPDCy` |
| sim_lst `faucet` (10 simSOL) | `63RaEhuZkmgJybUCyeXGFRxPZxokjhMncuerw4CmKdqgSgiyVYBSo4XfLkY6z3dJ7YHhKwPmLcHm7C7Pcy8yzori` |
| `open_native_position` 5 simSOL + `take_native_advance` 1 month (447 Gemas), one tx | `5FnLCAT71P5UQg5vKsbtwoXM9g3fPpFfdLAMUrth7kowZVszJpZWMesThS1gfVWp3TSgRnv8xK3BdZw9zQXo9xrL` |
| `accrue_native_yield` at ~4 min (Debt 447 -> 264) | `5mfF6GnN93FrtLr8fFoPC9Li2fiXhgNS6JpAzNsN4xyiTrKBrJXoFCX3MrhHCaq8Nir36FCixVupK5Ei6Q12Q2uy` |
| `accrue_native_yield` at ~10 min (Debt to 19) | `5oqgvsFQ4CevNEEfDCUkv8p89ZiPniwYQUppoZFjwaWAXsLJ3YdtAeHJy79hpWKaF8DPXqQ18JGLnmrbLKU7RyPj` |
| `redeem` 428 Gemas (simSOL paid from the vault) | `YYXanf8Bzdbmhmoy9W5wAF29aMs77yvxgkfqqS8pkvxTrxynQQkLCVBxHhrQcqKHJEQT3nUkZHaYZUAxjnT23yd` |
| `accrue_native_yield` (Debt 0) | `4biN5G5P9XzgcbmN9REvxC7fpaxE2rZ6FgNkpziAftvQHF6ae4sZ1rNrjTZBSBG31VEGdpXihKobDapWY1SZ7XpS` |
| `redeem` last 19 Gemas | `2gw9L6164ismaXA7bFjNTt9tqmkzxyHJMUxwR5vj2PNpmacLhMfHTpkN3XQBVJ4tMM4jyENXbeLjCo5KxoHSsPRg` |
| `unlock` (Principal simSOL returned; wallet 9.999999999 simSOL) | `HZWYkvfhVTFZWGqNkMJEvUTaKoR2z84kh5MmgD2v48RP8MXENPrQ9k1tLKXVqHPmzdyTK2jzqTxP6Xg4hdjzsGK` |

Position `2QxKeDKJfWvGa6uNwXG6533ZpNTazyoUEXj4ALRj2Zb6` (owner wallet = the deployer, nonce 1). One month of Horizon takes about 10.1 min because sim_lst accrues per 30-day month while the Advance projects 1/12 of a year. Helper: `scripts/native-position` (`RPC_URL=https://rpc.magicblock.app/devnet pnpm cli status`).

### Web app native Position flow (2026-09-30, dev wallet `?dev=nat2`, browser at 390 px)

Driven from the Wallet screen (`app/src/app/wallet/NativePositions.tsx`) on `https://rpc.magicblock.app/devnet`. SIMULATED yield (1 month = ~10 min). Screens: `app/docs/screens/wallet-native-*.png`.

| Step | Signature |
|---|---|
| Get test simSOL (sim_lst `faucet`, 10 simSOL) | `3Gsq3WZUBRM7sT8fX6vw1Zx8UXpkMMX8G4rgW2mNo31hTfPUyid4aNfpdRSRevw8sbpoCoXyp4WJ7GqQQapY7nyC` |
| Open Position 1 simSOL + Advance 1 month (91 Gemas), one tx | `5gjwktyyVu4wYctqNkZRQuypj4SKfcMn3WeQbvnpYE369eWB2dbtiD8vPmCkNkVvG7TyADaDJRq184waPSDobpBz` |
| Refresh yield (`accrue_native_yield`) at ~6 min: Debt 91 -> 36 | `4eBamEVAi7cCE2bitWhohJD98fohQV4uDwpU8dPNbZE8RUaD1kseJji9bB8Mn8LuGJxq6AyriFzJD8pQbm2q5Xt7` |
| Redeem 55 Gemas into simSOL | `t6jQBVFxhtPkLxFKsMJQ5iaVurCmNhThcAbxvUQyi1sd6GrnkVDqyF7JMVEmR1uoUTsdWcgxRa1fn2hQYTpJQMj` |
| Unlock (crank + unlock in one tx, Debt zero) | `3A6xCokh9aXY865yce2e6VySjZFxRgKhfUj4cMUQUwwvfJebgTG6SAAJzJ5T5Ps8nruEpj4LzmrxQaKEhzaLkMBn` |
| Sweep surplus | `31d4VuHdRfEDrhQhdtwrJkyS9dDX8pzPDJpVxWDcxZcvkWsPLEzzPdT5o8sk7Kf2rdKCcwd7XJN1VnfxPjLEVtQM` |

Keeper (`pnpm --filter @tesoro/keeper once`): `set_price` from Coinbase spot ($119.58, devnet price feed; Pyth Hermes now answers 401 and CoinGecko 403 from this host, so the chain falls through), `3PptTaJC7hNopa2tunYxB5ukXNWBe1pLwEMpEmbKDE195997S4Vg7SwzuuQCrfZ5R58eEV68DytsHU6hoFcWNSmF`; `accrue_native_yield` for both native Positions with Debt, `5k4rDPR62rU3uZsuV9eNfk39835yHiw6ozwJZqqsKUEZEuTWYHoDZUHi9DPqoshuUGpNuq1m9KrJayCTXwMHzmTE` and `5yLS3dT9ZAiz2YPnyEKgKqVSK985sbBUwqWa9eMME4FrgUqmFvAu9DqD51MkGxdz1NLr8xWFhXhMEQRNou1N7Ywh`.

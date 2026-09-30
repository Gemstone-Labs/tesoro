# Deployments

Testnets only. SimLST is SIMULATED (accelerated yield clock, default 1 month per 10 minutes at 5% APY). `MockEndpoint` stands in for LayerZero until the OApp lands.

## Security remediation redeploy (2026-09-30)

All from the deployer `AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV` via `https://rpc.magicblock.app/devnet`. Findings: `docs/security/audit-2026-09-30.md`.

| Step | Signature / tx |
|---|---|
| tesoro_core upgrade (F-05, F-07, F-12; extended by 40,000 bytes first) | `fduJkqPr9Z9X7qhioKS751ec4Hijd3jJ4mLyLPM38VypvzavJg4boVDju6bVh4vLasRbUt1MJzuRwiwtLYjCfy2` |
| `migrate_native_custody` x3 (existing native Positions `EyAHqa5j...`, `4bf37rTh...`, `2QxKeDKJ...`; `keeper/scripts/migrate-custody.ts`) | `4uX2R8BBYf92cdFy7Zp8RKcXXb6Gk8dczQh4vjrZ8Tkta2gs3A6ybzeeUnJujNTptEWtAvHwbkNzfKMwNo1iJua9`, `3A3ANsEGaXkGsgzQkX3QjsFbzZGqq5YNGbyYSVi6Wa9hT2edA7xF1BNQtqoQj7TAHZ6ydUHPZeqmKiAqoEoT3NTy`, `3hmyr3ErKFbfXGpQJrXs7Vh6uGL9faeJqBcVd58oVXg8rfRv7o1di8VkhfDiA3qHf7s1jhKKDvXu54XeeWgLgwmG` |
| block_puzzle upgrade (F-01, F-02, F-06, F-09; extended by 20,000 bytes first) | `32dytQEvMcmH5ubvCwNe7oND9HfSYL89ocT8divxgEFCNpkEXKKyK2BA5kdX4WWNHmE4XYJCqX2BsQuQVyzNrLtw` |
| holdem upgrade (F-01, F-02, F-03) | `4qxWDa6wpiPja8ESAA2fkfced9trcuNPt32Dg9Yha6d5vDv2xVEeHVemHZXXyLfdW1mBJwe3G8jTcagyAnKGrifB` |
| tesoro_bridge upgrade (F-07: `redeem_to_evm` signs `redeem_from_source`) | `2YKqDbwKDEtZ8tYXCRVq6Lqrnr6aUpzG4mBZwL6eh4PNZR9i2wJbEN5L7uLeAny6cYfPDCkDXjcyDS68qesPh3Rh` |
| F-01 whitelist: only the TEE validator `MTEWGuqx...` approved for block_puzzle (`keeper/scripts/whitelist-tee.ts`) | `4D4NCmU4ZN54inag7P7U6QAbCYSPuzGkYeauzkCKodmyokbWrdKN86dFrC9ofr68vBZuMJnD75wRSEKrXmk6FmGQ` |
| F-01 whitelist for holdem (ProgramConfig `CVBjwJ8LaJS37zokHDjgkWASNPW9X5oWxmCHT2DvVKL3`) | `2vrazH11i4L1PKx9AdvdkwLqntnCTEhfDm4GetY36cS8JMbziFd3oHjzzR3S53N8VkjNV9t1h4Q3gYMcrJinw1VC` |

The delegation program keeps a per-program `ProgramConfig` (`["p-conf", program]`); once it exists, only its `approved_validators` may receive that program's delegations. Both configs read back `[MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo]`. The Game programs also pin the validator themselves. Proof on devnet: `delegate_opener` naming a random validator fails with `InvalidValidator` (custom 6020) and leaves the Board owned by block_puzzle (checks in `programs/block_puzzle/scripts/evidence.json`); the DLP-level refusal cannot be reached separately because the Game refuses first.

### Smoke run (2026-09-30, after the redeploy)

| Step | Signature |
|---|---|
| Native Positions for both test wallets (10 simSOL, 3-month Advance, 3,415 Gemas each; `open+advance` p0 / p1) | `FyVcD8R9JsM2j2bUkh5ydWd7iCA1fhQMr3k8HG9j93rLP97aPHEQZMMNu2DZadHWUk4hdXmYcNSC1Ec7P48QJAo`, `5jqWFRRHSM2jKJwxm7G7zeBPBcL8ARQnfn2ftAAGFtRD3X23Ypxkw8JuzhKpwGPVoU2girwMN5xQmyrgr5qdbvRD` |
| Block Puzzle Match `1790749508250` (`NATIVE=1 pnpm match`): open_match + open_session | `7pz29gLARKPV67FJaxtBsDxLC3rfFJqhXvH67YfkhKSdzDTpMU5pLhbjQiLtfcTaUamYLTfFimigxyuEDxdSgxA` |
| non-TEE `delegate_opener` refused (6020) | `2RbP7waLWj6jp9yKU8ZtN4VG3rwaHoPvdDp4vzRSH2rtJJHNnhtzpzyiWhTAP17PRfUme74kaLC4tZojdWHFW3vV` (failed tx) |
| join_match + join_session | `4zGn8q2XE6Vm3z5igiukqVRhwRvZaVH21dbecpbo5u1D7i3w6hBhrtLzqz7aay4qmFvq1qqtCwmTWHya39dj124F` |
| commit on base layer | `2awAddd61o2N1P8ZR9xUx3eLJcubveArLM84UAe3vMomce3Hu9mS4ou8XsoRdTMVN823x9hemJc7Fy6D6upX6FxF` |
| settle (scores 178 to 53, opener wins 900 net) | `2r5t8JbmA7XURh1HFTjWfG62hsiQAwt6QjJh8ewRmkDSJmXe4pQT18SvLAX99gSJHcQsB5b7tpA5cyxVHUmywv2g` |
| Hold'em Match `1790749624337` (3 hands, 500 entry; oracle-signed stand-in Positions): create_match | `3qzo33nzGj99sSASCrSTWagsrD3hwo2NRcKA5kiRAnXGxwUTySvP4tiPFE2Fq9YsNY8v9cxwHQBd25sM66xV4LW` |
| Hold'em finalize (settled through tesoro_core by CPI, winner 950) | `5NUhPsUv5oq8iQrCe9X8S8LvP6ipcWqovdzYzotqLPThwE7YY8soqNbor957ySFmujMfHj797xYRuRw622UVCsSx` |
| ETH: `init_position` (Solana, new vault id 1) | `qjM8xsWmJFwK4D1yFqSXWEaoHMYNNwaR3AWG3owRZjacTHagWEeuiW9wrEEtpu2Yo8LA9m6d9Nx4wSN5d8hRhSQ` |
| ETH: `openPosition` 1 simETH on the new vault (Hoodi) | [`0x0b5ee0c63e3e8e0328660f7108218146dc611acf8b7cda96ae06e97ac22d2671`](https://testnet.layerzeroscan.com/tx/0x0b5ee0c63e3e8e0328660f7108218146dc611acf8b7cda96ae06e97ac22d2671): DELIVERED, `lz_receive` `2tMfASvBzwUDTapJ7jH8Ec4GW5QL8qRFEfNX1iVZvwDZ5N6mS2dLsJThoDxqZnz7CzG32ZohxRw7SbzmakkwfB6A` |
| ETH: `apply_locked` on Solana (Position `CUg7tLkma7UcjKmgvx7535RpGW4izxXbrtzXdmp93PMu` exists, principal 1.2659 ETH) | `4Xb58Szqcya3QfwUTShLuoc2Bdq1nvhsvnsvZYg4ACJ4CA6cSUyys3EFED5xF78jwuRv68SrPF7Y73uTomB7H9pU` |
| ETH: `take_advance`, `reportYield` (DELIVERED), `apply_yield` | `5qAnsrgwt6CNFnj1rLMxi5PVHrUzsuEVCKtzbhHthK73AwqNA7ubD1zA6xPrGyk1ygWNm12XwdJiJcES7DuHE7WQ`, Hoodi `0xf5af84b679a8d6f561ae05b90b533442ab12af6b6d1b69c3626e527c61055dd4`, `2F3ByKXwS6iA2cACN2BnGaLJ89Nniriiaw56uWQHuqvHfXfeWEwyEe9aKqdv48Z5euwDkj1GCbaUTp2dFKXxq4eC` |
| ETH: `redeem_to_evm` 100 Gemas through the changed bridge instruction (F-07) | `tXeFQ19rHTeB3ZSed45Rxh3xccMbNjcBoiWLVnaXZ4CTS6yGgRcFC489Myb2nF1BLtDHJsmp9ujvw59dRuzqSNm` |

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

## Cross-chain bridge (LayerZero V2), 2026-09-30

Details, flow and every proof tx with LayerZero Scan links: `docs/cross-chain.md`.

| Item | Value |
|---|---|
| `tesoro_bridge` program (Solana devnet) | `5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ`, deploy tx `4nQnHMsK1Y3S8zTUhjLiRvp1fAYcSLNoqfK2NRUZwbUdwtpFYqWQw7kCLXhyuVwTASwozjm36ZsrEmeMeVW32sEZ`, upgrade authority = deployer, keypair `~/.config/tesoro/deploy-keys/tesoro_bridge-keypair.json` |
| OApp address (Store PDA, EVM peer) | `7WQLHW8EuyV1V8tWNh8DQGu7mVRgaHGgLU7fi8G91rVw` = `0x60ae58df1215bf45cc054e633b49c92a3b1309f76075bac72b26e0c6e1c0c792`; `init_store` `3bHFM3Rh6KrU98UQGsovRc7Ht6xnoEUV45TcXiWmAxpwDrRTkMmhzTrZY1aFe7nH9pZAqnX564fSLWmbRHaiK2kb` |
| Bridge authority PDA (`["authority"]`, tesoro_core source authority for Ethereum and HyperEVM) | `FEgxs5f7zavRaR7tZJBNZzrYeCMGegMpMWFiHjvyvaLg`, `set_source_authority` `3JUc3Vd7CZ27rgAFcrbNi35k9nRbPsvpmWW29iMRB81cU1MhDqJQiqGMrEbfqXyku3DoQLqCeHP5mQLm3k7qkNkb` |
| tesoro_core upgrade (adds source authorities; includes the native-Position instructions already on devnet) | `bpyct2A3AuopZvJUtW3RiQVjqtKp4ZJKTXtNeUtV1D97DFYzpNi927ZSFUYa8cRNN1p9hia2W9s1dWXSmpkgFsG` (extended by 60,000 bytes first; built from `integ/core-source-native-30-09-2026` = native branch + the source-authority commits) |
| **RETIRED (F-04, replaced 2026-09-30, see below)** Hoodi `PositionVaultOApp` (SimLST, simETH, SIMULATED) | `0x8289fa2e5A7a57618A93B93fc720B85eF3E87b7c`, deploy `0x1abcc8cdbe7c185655ee163bde3316ddbc5bc839c607f6881c6b3cfb69e9c0f9`, `setPeer` `0xff68a61d706539d72ee6faeabc2ae9568d9b9530d55c3f18a894500b2427a1e6` |
| **RETIRED (F-04)** Hoodi `PositionVaultOApp` (real Lido wstETH) | `0x214A695C1F9F0136D87c459fa542878da1128DeD`, `setPeer` `0x0f9531f634fab3c48c66b3f7c9706aaecb6fe85a7a53dd74d4227876080e53f6`; wired on Solana with 300 bps, not exercised end to end |
| Solana `set_peer_config` + pathway init | SimLST vault: `5aGWx8kEJVmsjbwHkUxbBv1qPVEh1qrTHE8Q7a1EehomDP1T8eiHdqKuS7AojouSMCE5GXcnz7iL7HEBwiFH4mV8`; wstETH vault: `3avujqcnk7d9ZdsRTRabKc8c28AN4tWK7fmkcAUbkzTpqTGPb5JLp1UWTPqsn43k9doi25RAwV6diveMecEREbrz` |
| HyperEVM | not deployed (no HYPE); Solana pathway for 40362 wired. See `docs/cross-chain.md` |

The vaults deployed earlier with `MockEndpoint` (table above) are superseded by these.

### F-04 replacement vaults (2026-09-30)

The fixed `PositionVault` (per-seq idempotency) is not upgradeable, so the two LayerZero vaults were redeployed with the same constructor arguments (`contracts/script/deploy-oapp.sh hoodi sim|wsteth`). The old vaults stay on chain but are retired: the app, keeper and scripts point at the new ones, and the old ones keep the old ordering bug, so nothing new should be opened there. Test Positions stranded on the old SimLST vault (owner deployer / dev wallets, ids 1 to 4 in `docs/cross-chain.md`, all unlocked or test-only) are not migrated; the Solana `PeerConfig`s for the old vaults are left registered but unused.

| Item | Value |
|---|---|
| Hoodi `PositionVaultOApp` (SimLST, simETH, SIMULATED) | `0x6c836b96464B5D1b55536d5a34D023528eaEe4bD`, deploy `0xa43b133c433e7a19093f3f5d708cf727d2aaa53dafe9ba67990bc70b3a6ec334`, `setPeer` `0x6e56407fe0823262b6aaa54b27ec566c057aecb269279e412903a702904e664a` |
| Hoodi `PositionVaultOApp` (real Lido wstETH, not exercised end to end) | `0x50f5f66994554ca582136b5C00B9Ce0951B314BF`, deploy `0x453dfe52bc0a945e4f10293da1f83f5d16bf6f3a736332d30fb38e3a066524d9`, `setPeer` `0x39becb431fdeb48859cbd146d58381aaa64a92b154df91dd737a2cf10f01bed1` |
| Solana `set_peer_config` + pathway init, SimLST vault (500 bps) | `dVMHkD46hwqQtwyyTgwuwpmkK77yuNQ3WiY43ZixFxsPtDSLx4WiGRWS7SSoa9U3riBuj8gWUNofEgciMRCMg1u`, `5LmAiyaJt9eKvc2FHK8sdsdQxJ7aGTXcD1nuXopVMS8FzE3vCc7z74PXQcJEwKuh2GaZF5qpC2KAicijKgvwvfYX` |
| Solana `set_peer_config` + pathway init, wstETH vault (300 bps) | `2YgxL9cmcLKhhQrssLW3SxyCcZNmshRyKDpNsZrPHah2fAZgRQUMnVKwaEoVAeVjYNd5TXVh4vAvFWTtCQbc3BCW`, `213Yyc7BvtzVGAnhgVg64Y5gW2TXAm86iwfbo5xmE8JYzd1t1ZjbgRuRT24zEBpUoEB5DacRSdkgdKG7Aohng2TT` |
| HyperEVM | prepared only (no HYPE): same two commands with `hyperevm`, then `setPeer` and `pnpm lz wire 40362 <vault> 18 500` |

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

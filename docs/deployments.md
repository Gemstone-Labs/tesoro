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

## Cross-chain bridge (LayerZero V2), 2026-09-30

Details, flow and every proof tx with LayerZero Scan links: `docs/cross-chain.md`.

| Item | Value |
|---|---|
| `tesoro_bridge` program (Solana devnet) | `5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ`, deploy tx `4nQnHMsK1Y3S8zTUhjLiRvp1fAYcSLNoqfK2NRUZwbUdwtpFYqWQw7kCLXhyuVwTASwozjm36ZsrEmeMeVW32sEZ`, upgrade authority = deployer, keypair `~/.config/tesoro/deploy-keys/tesoro_bridge-keypair.json` |
| OApp address (Store PDA, EVM peer) | `7WQLHW8EuyV1V8tWNh8DQGu7mVRgaHGgLU7fi8G91rVw` = `0x60ae58df1215bf45cc054e633b49c92a3b1309f76075bac72b26e0c6e1c0c792`; `init_store` `3bHFM3Rh6KrU98UQGsovRc7Ht6xnoEUV45TcXiWmAxpwDrRTkMmhzTrZY1aFe7nH9pZAqnX564fSLWmbRHaiK2kb` |
| Bridge authority PDA (`["authority"]`, tesoro_core source authority for Ethereum and HyperEVM) | `FEgxs5f7zavRaR7tZJBNZzrYeCMGegMpMWFiHjvyvaLg`, `set_source_authority` `3JUc3Vd7CZ27rgAFcrbNi35k9nRbPsvpmWW29iMRB81cU1MhDqJQiqGMrEbfqXyku3DoQLqCeHP5mQLm3k7qkNkb` |
| tesoro_core upgrade (adds source authorities; includes the native-Position instructions already on devnet) | `bpyct2A3AuopZvJUtW3RiQVjqtKp4ZJKTXtNeUtV1D97DFYzpNi927ZSFUYa8cRNN1p9hia2W9s1dWXSmpkgFsG` (extended by 60,000 bytes first; built from `integ/core-source-native-30-09-2026` = native branch + the source-authority commits) |
| Hoodi `PositionVaultOApp` (SimLST, simETH, SIMULATED) | `0x8289fa2e5A7a57618A93B93fc720B85eF3E87b7c`, deploy `0x1abcc8cdbe7c185655ee163bde3316ddbc5bc839c607f6881c6b3cfb69e9c0f9`, `setPeer` `0xff68a61d706539d72ee6faeabc2ae9568d9b9530d55c3f18a894500b2427a1e6` |
| Hoodi `PositionVaultOApp` (real Lido wstETH) | `0x214A695C1F9F0136D87c459fa542878da1128DeD`, `setPeer` `0x0f9531f634fab3c48c66b3f7c9706aaecb6fe85a7a53dd74d4227876080e53f6`; wired on Solana with 300 bps, not exercised end to end |
| Solana `set_peer_config` + pathway init | SimLST vault: `5aGWx8kEJVmsjbwHkUxbBv1qPVEh1qrTHE8Q7a1EehomDP1T8eiHdqKuS7AojouSMCE5GXcnz7iL7HEBwiFH4mV8`; wstETH vault: `3avujqcnk7d9ZdsRTRabKc8c28AN4tWK7fmkcAUbkzTpqTGPb5JLp1UWTPqsn43k9doi25RAwV6diveMecEREbrz` |
| HyperEVM | not deployed (no HYPE); Solana pathway for 40362 wired. See `docs/cross-chain.md` |

The vaults deployed earlier with `MockEndpoint` (table above) are superseded by these.

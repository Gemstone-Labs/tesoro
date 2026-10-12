# Deployments

Testnets only. SimLST is SIMULATED (accelerated yield clock, default 1 month per 10 minutes at 5% APY). `MockEndpoint` stands in for LayerZero until the OApp lands.

## Yield Fee and Instant Redeem (2026-10-12)

ADR 0007. Deployer / upgrade authority `7zr1j185zT8r6jcysC4LyrdSEJ13Up3xq4TFu6KQqh7M` via `https://rpc.magicblock.app/devnet`; EVM deployer `0x96137cB99Fe2878299b672Ac967e88279f479d1C`. Runbook: `.scratch/yield-fees/runbook.md`. The previous SimLST vaults (Hoodi `0x8B099AbfC204E1a07D6CA686D302CE6cbC07a3A3`, HyperEVM `0xf70dafE2788881F6ae54Bea7342dcb3D9b92A316`) are abandoned with their Positions: they speak the 61-byte `YieldAccrued`, which the new bridge refuses, and their SimLSTs now mint only for the new vaults.

The HyperEVM vault no longer fits a small block (deploy gas about 3.37M, limit 3M): the deployer was switched to big blocks for the deploy (`evmUserModify usingBigBlocks`, Hyperliquid Python SDK) and back right after.

| Item | Hoodi (560048) | HyperEVM (998) |
|---|---|---|
| New simETH / simHYPE vault | `0x191700BA53C9437F3a31E082bcfd8bB85C865d26`, deploy `0x921295122a4dd56a874b1a1418fb4ec3bbfb41421f4aa20a66ddc7c82a69e359` | `0x61B46f64CDB75930a87955487aAb8A7711F757b5`, deploy `0xfba9e35df6a831512ca17e7392ee12dfb27974be789b6b22f790d9d477eab046` |
| `SimLST.setMinter(vault)` | `0x41dfb907190fe0858c35081cf8d0eadc194d2169cef9d266ca4e396d1bb386e9` | `0x413987063e62dd4be10f9bc2b25b5f379b02b56d8cfdd8b86f6e44e0ee7bad9c` |
| `setPeer(40168, Store)` | `0x437ef4e42572a1ba45d4dbc7de4dd82c1a705a8eba68483846f19bbb67d3cf3c` | `0x7f460c8a1c549b9b4ac99a9218b41b4cb9d4bdeeed8e5f2db40e08573a070b32` |
| Solana `set_peer_config` (also creates the `VaultTreasury`) | `dJkyavEX…AErKria` (VaultTreasury `4HdiKXa9ATujkaKeVuMLdXYtPaSNbqf6g2x5SikXxRs2`) | `56rLGBi8…kHHQ2RAW5` (VaultTreasury `3ZF8wmVAtudd8psmVPcGRJk7L4HXesrho3U35rNFi7j5`) |
| Solana `endpoint_init_oapp_pathway` | `22cK2a58…TJ7pBPejm2` | `4Mkbzojb…hLkfx8d8N3p` |
| `fundTreasury` | 2 simETH `0x7bf714ae434612153de8ba2ecbb3f321f61e27fe32017a289b72d002bd798705` | 7 simHYPE `0xb8e1d189fa3e8fd692dcf6cc7e0727036dda8b49b90abf0859e37d21206126fb` |

| Item (Solana) | Tx |
|---|---|
| `tesoro_core` extend +140,000 bytes, upgrade (1,292,656-byte .so; program data 1,298,360) | `g1cJa2qd…VR16sUgxoFKx` (slot 510206563) |
| `init_treasury(2000, 3500)` (Treasury `BuWgG4Q7DYND13twkfu5gHVGpoK78GbWJzAeEgv6aDQr`, vault `7XLRyApCUdeTRyh7c7mLHh2zKE6X1ej1SFJ7F6hgrsU4`, Treasury Account `71hCesb8eED3yoFjgxDG8fSfqgZV4Ngfnr2sX3jHL5Yg`) | `5sNUnoUs…pTkDRvoqCyzno7` |
| `fund_treasury` 10 simSOL | `5s3pjNU3…AC73DTYjLkx8` |
| `tesoro_bridge` extend +115,000 bytes, upgrade (797,920-byte .so; program data 801,648) | `31dA5GFe…GixU4FGWVekv6m` (slot 510206833) |

Smoke tests (2026-10-12, after the app deploy `tesoro-j8cgfb7g7` from main `8592b20` and the keeper restart):

| Check | Result |
|---|---|
| SOL Advance at 80% | fresh wallet `8r8ZQX7H…Ty4RRv`, Position `7KJau2ahc1RwVgLJSHtVEyi7azjKbFA1dr1HXKonM2Nc` (5 simSOL, Principal 19.749 SOL, 1 month, $112.28): 1,034 Gemas (100% would be 1,293); open + advance `5QS2KjXb…4s9mndk`; the keeper's crank repaid the Debt about 10 min after open (`3E3Pn6PA…CYJ4zmgG`) |
| SOL Yield Fee 20% | over the first cranks the Position's vault gained 3,461,109 shares and the treasury vault 865,275: 20.0% |
| SOL Instant Redeem | QA wallet `qeE` (`3DCcK3Yy…ToK9k3J`) sold 1,000 won Gemas of Source `2PmMbYg9…HR4GcT3`: `4QnzaQ1N…u1ayWwft`, paid 13,507,452 simSOL base units (65%) from the treasury vault in the same tx; the Treasury Account took the 1,000 Gemas |
| SOL treasury refill | the keeper's next pass ran `redeem_treasury` 1,000 Gemas (`2aTzP8Zp…49Wo4Zsy`): treasury vault +20,780,696 (the full value) |
| HYPE Position | vault Position 1 (1 simHYPE): `openPosition` `0x50a0d3f750971cd44f2b7dc0423209ffc95864d7254362fc85f70b56d942ea9d`, `apply_locked` by the keeper, Advance 1 month at $25: 8 Gemas (100%: 10) `4DY94wVJ…KimQrMFkKX` |
| HYPE YieldAccrued (77 bytes) and mirror | `reportYield` `0xab2271532185fb61f7b4717b8b392211a6f6956129a5dfeb1114a9e557f94f49` (vault treasury +1.444e14 = 20% of gross); keeper `apply_yield` `5sjZQKWj…24AVyzBJd`: Debt 8 to 7, `VaultTreasury.reported_in` = 7,000,144,444,444,444,444 = the vault's `treasuryIn` |
| ETH Position | vault Position 1 (1 simETH): `openPosition` `0xc0d06d604aaafa476c072e8c5433f34a59639f1112a6d86ee8b357770b998e8c`, Advance 1 month at $3,000: 999 Gemas (100%: 1,249) `5c8edw6U…fBLXsnDCn` |
| ETH YieldAccrued and mirror | `reportYield` `0x3b4ee2af3f195e2cefc070f10fea03de3716732ad4688e1c95585b47cc3d93ac` then the keeper's: at 768 s the vault minted 5.333e15 wei gross, 4.267e15 to the Position, 1.067e15 to its treasury; `apply_yield` `5NGg8Gah…h21qzA`; Debt 999 to 0; `reported_in` = 2,001,066,666,666,666,666 = `treasuryIn` |

Not exercised live: Instant Redeem of ETH/HYPE-Sourced Gemas (`instant_redeem_to_evm` + `send_pay_instant`) and an EVM treasury refill. No won Gemas of a new-vault Source exist yet (they need a Match); both paths are covered by the bridge LiteSVM tests and the vault forge tests. The keeper's first Hoodi `reportYield` ran out of gas at an exact estimate (`0xcd1641050b384c82a75052fdddfdd6a0ecd1f048634331d3e312083adce8ddf7`): fixed with 30% headroom (`f82ed5e`, `c3be669`).

## Per-Position yield: EVM redeploy (2026-10-03)

Model: `docs/yield-model.md`, ADR 0005. `SimLST` now has a constant rate and a `minter`; `PositionVaultOApp` takes a fifth constructor argument `yieldMinter` (the SimLST) and mints `principalUnderlying * apyBps * simElapsed / (BPS * YEAR)` into itself on `reportYield` / `accrue` / Unlock / PayYield. Deployer `0x96137cB99Fe2878299b672Ac967e88279f479d1C`, Store PDA peer `0x60ae58df…c792`, 500 bps on Solana, same deploy commands as before (`script/deploy-oapp.sh`, now passing `yieldMinter`).

| Item | Hoodi (560048) | HyperEVM (998) |
|---|---|---|
| SimLST (**Simulated**) | `0xD82840623A7a00C37b0883d221Fa84e39ddA2a28`, deploy `0xde18ca5904b25407bdcad080c1ba6a240ec978e2a5081388a4ece3a33d577c31` | `0xC8A9AccD25ABDCF3FCBDE7123Cef8239B5bE7eF3`, deploy `0x215a433889e322be574802b4fc08979bfcec827ac42a9c01894055bac83cb46e` |
| Reserve funding | 0.1 ETH `0xe7f8bf5cdd9df3505eb88a8c71371dcf7e666ebea67b3aaef1288e30462c1a20` | 0.3 HYPE `0x0bfcce65a2b9a6a151884a9ac1ff6dfc0259f37b18f396cda129d6d26c54726e` |
| `PositionVaultOApp` | `0x8B099AbfC204E1a07D6CA686D302CE6cbC07a3A3`, deploy `0x4e31e2538621101284950f85795d13e4b32c60eafb71985d66b0010ece45c972` | `0xf70dafE2788881F6ae54Bea7342dcb3D9b92A316`, deploy `0xdde9888b9c73e42273978652e06a0e44efc36d3a836d6ba28d1080782049eddf` |
| `SimLST.setMinter(vault)` | `0xb8ebb284586719159683da4afc22b0096e110c7a2c61815095039188949cadf3` | `0x5b6854e7ba8ea02e5007d9e5a751d78cc8fa75c1175b7a08045f9b234fe58325` |
| `setPeer(40168, Store)` | `0xd7b78a78427d9e4e61021ceb6e9206745c4aad3f8fca8219bba4477e6236d825` | `0xe243ebefe1f8d821e10b05d26292e4e04cd46b573956c996f1b21d9d3082dba1` |
| Solana `set_peer_config` | `1dTDC8wo…V9CQ` | `3navPnLt…VT5yNb` |
| Solana `endpoint_init_oapp_pathway` | `2H4CwGbR…UD2gV` | `27kVbj7x…6RGiqYi` |

The wstETH vault on Hoodi (`0x61B46f64CDB75930a87955487aAb8A7711F757b5`) is not redeployed: it uses real wstETH yield (`yieldMinter = address(0)` behaves exactly like the old contract). **Abandoned** (not migrated, they keep the old rate model): the previous Hoodi simETH vault `0xF3F2361432e5066588B96c9A9acF0b7b2907AE0a` (SimLST `0x23B17A4c55867406E7CD5602c664E1447400c4a3`) and the previous HyperEVM simHYPE vault `0x23B17A4c55867406E7CD5602c664E1447400c4a3` (SimLST `0x4FF730663d88457990eAF47b23E19737E39BB238`), with every test Position opened on them. Their Solana `PeerConfig`s stay registered but unused; the keeper reports only Positions that exist on Solana, so those Positions keep getting reports until Debt 0 or are ignored if the vault is no longer readable.

Smoke test (2026-10-03, Position id 1 on each new vault, owner = deployer EVM address, linked to the bridge demo Account; 1 simETH / 1 simHYPE, 1-month Advance): Hoodi `init_position` `284QUqky…bZXHfz`, `openPosition` `0xb26e75db776d82719f2c3935a9a1160cb631840b5fd05cd5048bedcad9ddbc7a` (04:57:14 UTC), `take_advance` `4vR37YC6…zTKxzD` (1,249 Gemas at $3,000/ETH), `reportYield` `0x9f684805db8cd7990117c31c0114cc4ad23cb6e0dbf14011a19c9f795a87a116` (05:12:49, accrued 6.4932e15 wei = 1 ETH x 5% x 4,320 x 932 s / year), `apply_yield` `5LemYigo…zqXgvfy3XRA`: Debt 1,249 to 0. HyperEVM: `init_position` `5CwEtVH9…A7gN7y`, `openPosition` `0x86c6414820bbc6b368cad7e9cc2fe05a5d4bc127e0404e62336ccd37ce13aae0` (04:57:37), `take_advance` `4XKNjquW…rGh13` (10 Gemas at $0.025/HYPE), `reportYield` `0xce978d901e8e095d58ce5d0cc5d5f2d477ac03dae5ff82699ee5b2af5a3fd1cc`, Debt 0. The Advance is repaid when yield since OPEN reaches `principal x 5% / 12` (4.1667e15 wei), about 10.1 min after open at the then speedup of 4,320 (30-day month against 1/12 year); both messages DELIVERED. Both SimLSTs were then set to speedup 4,380 (`setRateParams(500, 4380)`: Hoodi `0xd8bfcbf86fae61c0e821c79aabeec9079366e10654b0ebb84df18ccf7df50f64`, HyperEVM `0x8adb35f2ae8d55f745caca260b0fbe99dd19bf9b1ac69e60c2e80e8e6587da6c`) so a month is exactly 10 minutes. Redeem/Unlock were not re-run on the new vaults.

## Per-Position yield: Solana cutover (2026-10-03)

Model: `docs/yield-model.md`, ADR 0005. Deployer `7zr1j185zT8r6jcysC4LyrdSEJ13Up3xq4TFu6KQqh7M` via `https://rpc.magicblock.app/devnet`. Scripts: `keeper/scripts/yield-cutover.ts`, `migrate-custody.ts`, `yield-smoke.ts`, `yield-crank.ts`.

| Step | Signature |
|---|---|
| Borrowed 2.9 SOL (bridge-demo-owner) and 2.95 SOL (relayer) to the deployer for buffer rent | `4D6ioZJz...L34crH`, `2TnbUCtw...QezVm8` |
| `yield-cutover pre`: old `set_params` rebases `base_rate` at the then-current rate and sets speedup 4,380 | `3N161p7U...DzPgCF` |
| `sim_lst` extend +25,000 bytes, upgrade (401,160 bytes) | `43FhC7xy...mggq3F` |
| `tesoro_core` extend +20,000 bytes, upgrade (1,015,664 bytes) | `4SBAtHDT...6BhVMC` |
| `set_yield_authority` (tesoro_core `["yield"]` PDA `C9zdFERGijamSQVQ1D4hE3iabc99g1XcurKCnS6CuSAf`, config `EwAQxNE81ifE8r5vu9p1X5eGmPoNBucj2n9ooETL8BtY`) | `agMKcMqC...meoN2L` |
| `fund_reserve` 2 SOL | `2faitCFh...XW8BLe` |
| `migrate_native_custody` x45 (all custodies, 194/202 to 210 bytes, `last_accrual_ts` = migration time) | see `migrate-custody` output; second run reports 0 legacy |
| Repaid borrowed SOL: relayer first (2.95), then bridge-demo-owner (2.9) | `2uN6Pppc...Ei1Ym3`, `2FxEzc1e...TYhSze` |

Smoke test: a fresh wallet (`6QrYEa7NhAqz2DcTpiHrxvzq6Gz5VYWUcPxEUjTr3ARG`) opened Position `Eu2m8cLkAgzyijDz1Hjasm6eAJjGHQMmfVpkgdPKqVAy` (5 simSOL, 1-month Advance, open tx `MnqT2BNP...cni49s`). Cranking every ~21 s took Debt 1,377 to 0 in about 10 minutes (about 50 per crank, linear); last crank `3MoVzhk8...9YRurm` (open Advance cleared). The Wallet quote reads 1 month about 10 min, 3 months about 30 min, 12 months about 120 min.

## Trading Duel (2026-10-03)

Deployer / upgrade authority `7zr1j185zT8r6jcysC4LyrdSEJ13Up3xq4TFu6KQqh7M` (`~/.config/solana/dev-2026-10.json`) via `https://rpc.magicblock.app/devnet`. Design and rules: `docs/games/trading-duel.md`.

| Step | Value |
|---|---|
| Program `trading_duel` (575,752 bytes) | `CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj` |
| Deploy | `616jDmGR...V3Xmgp` |
| Upgrade: `close_unstarted` added, crate built with `opt-level = "s"` (525,392 bytes, fits the allocated 575,752) | `ffTeUmYv...M2ti` |
| Upgrade: end price pinned (`END_GRACE_SECS` 4, last-mid fallback in `Duel.final_price`), `MAX_STALE_SECS` 2, checked arithmetic in the engine (526,152 bytes, layout unchanged) | `4gXAxxgD...mt8De` |
| `register_game` (authority PDA `["authority"]`, Studio Fee 300 bps) | authority `mPXSGjpEeSeJnmrBw3CKCoLbbftAsjsbiP1eE3wHcoe`, tx `2qEAdKkQ...JxjST2` |
| TEE validator whitelist (ProgramConfig `43amrCapYPLYz9tGPcdxw84A3Hby9j4kSTmDTCmu7xZb`) | `58oD5t2o...XveMXU` |
| Oracle feeds (MagicBlock real-time pricing, owner `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`) | SOL `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu`, ETH `5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG`, HYPE `CxEkVoCUwSAprvAhdWRPH63JeioQVNDtyZYEMRXuLu6x`: read live on the devnet rollup and the TEE |

## Entry cap 8 (2026-09-30)

Deployer `AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV` via `https://rpc.magicblock.app/devnet`. `MAX_ENTRY_SOURCES` 2 to 8 in tesoro_core only (no CPI account change, so block_puzzle and holdem are not redeployed; program data already large enough, no extend). Layouts unchanged.

| Step | Signature |
|---|---|
| tesoro_core upgrade (buffer `3Nuy5y6u...`, own failed buffer `8aNweMCG...` closed) | `4LCYAMBa...o3JJh7` |
| Proof (`FRAGMENT=8 ENTRY=500 pnpm match` in `programs/block_puzzle/scripts`; two Accounts each with 8 Sources of 63 Gemas, entry 500 draws on all 8 Holdings per side, client `planEntry`): Match `1790759763687`, `open_match + open_session` (78,679 CU) | `3L2awzaM...1LJLpa` |
| `join_match + join_session` (74,747 CU) | `4NFr82Rd...aRXTCE` |
| `seal + commit_boards` (TEE), commit on base layer | `2XVcsjq3...VKh2nQ`, `t4QD2wLB...8kJJPq` |
| `settle` via CPI, 18 payout lines, 135,734 CU, 1,091 bytes (504 to 954 Gemas for the winner, 504 to 4 for the loser: entry 500, fees 50) | `3gH52EYA...yHLiHn` |

## Security remediation redeploy (2026-09-30)

All from the deployer `AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV` via `https://rpc.magicblock.app/devnet`. Findings: `docs/security/audit-2026-09-30.md`.

| Step | Signature / tx |
|---|---|
| tesoro_core upgrade (F-05, F-07, F-12; extended by 40,000 bytes first) | `fduJkqPr...YjCfy2` |
| `migrate_native_custody` x3 (existing native Positions `EyAHqa5j...`, `4bf37rTh...`, `2QxKeDKJ...`; `keeper/scripts/migrate-custody.ts`) | `4uX2R8BB...1iJua9`, `3A3ANsEG...oT3NTy`, `3hmyr3Er...gLgwmG` |
| block_puzzle upgrade (F-01, F-02, F-06, F-09; extended by 20,000 bytes first) | `32dytQEv...zNrLtw` |
| holdem upgrade (F-01, F-02, F-03) | `4qxWDa6w...KGrifB` |
| tesoro_bridge upgrade (F-07: `redeem_to_evm` signs `redeem_from_source`) | `2YKqDbwK...sPh3Rh` |
| F-01 whitelist: only the TEE validator `MTEWGuqx...` approved for block_puzzle (`keeper/scripts/whitelist-tee.ts`) | `4D4NCmU4...k6FmGQ` |
| F-01 whitelist for holdem (ProgramConfig `CVBjwJ8LaJS37zokHDjgkWASNPW9X5oWxmCHT2DvVKL3`) | `2vrazH11...inw1VC` |

The delegation program keeps a per-program `ProgramConfig` (`["p-conf", program]`); once it exists, only its `approved_validators` may receive that program's delegations. Both configs read back `[MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo]`. The Game programs also pin the validator themselves. Proof on devnet: `delegate_opener` naming a random validator fails with `InvalidValidator` (custom 6020) and leaves the Board owned by block_puzzle (checks in `programs/block_puzzle/scripts/evidence.json`); the DLP-level refusal cannot be reached separately because the Game refuses first.

### Smoke run (2026-09-30, after the redeploy)

| Step | Signature |
|---|---|
| Native Positions for both test wallets (10 simSOL, 3-month Advance, 3,415 Gemas each; `open+advance` p0 / p1) | `FyVcD8R9...48QJAo`, `5jqWFRRH...qdbvRD` |
| Block Puzzle Match `1790749508250` (`NATIVE=1 pnpm match`): open_match + open_session | `7pz29gLA...xdSgxA` |
| non-TEE `delegate_opener` refused (6020) | `2RbP7waL...HFW3vV` (failed tx) |
| join_match + join_session | `4zGn8q2X...dj124F` |
| commit on base layer | `2awAddd6...pX6FxF` |
| settle (scores 178 to 53, opener wins 900 net) | `2r5t8Jbm...mywv2g` |
| Hold'em Match `1790749624337` (3 hands, 500 entry; oracle-signed stand-in Positions): create_match | `3qzo33nz...6xV4LW` |
| Hold'em finalize (settled through tesoro_core by CPI, winner 950) | `5NUhPsUv...UVCsSx` |
| ETH: `init_position` (Solana, new vault id 1) | `qjM8xsWm...8hRhSQ` |
| ETH: `openPosition` 1 simETH on the new vault (Hoodi) | [`0x0b5ee0c63e3e8e0328660f7108218146dc611acf8b7cda96ae06e97ac22d2671`](https://testnet.layerzeroscan.com/tx/0x0b5ee0c63e3e8e0328660f7108218146dc611acf8b7cda96ae06e97ac22d2671): DELIVERED, `lz_receive` `2tMfASvB...kwfB6A` |
| ETH: `apply_locked` on Solana (Position `CUg7tLkma7UcjKmgvx7535RpGW4izxXbrtzXdmp93PMu` exists, principal 1.2659 ETH) | `4Xb58Szq...B7H9pU` |
| ETH: `take_advance`, `reportYield` (DELIVERED), `apply_yield` | `5qAnsrgw...uHE7WQ`, Hoodi `0xf5af84b679a8d6f561ae05b90b533442ab12af6b6d1b69c3626e527c61055dd4`, `2F3ByKXw...Xxq4eC` |
| ETH: `redeem_to_evm` 100 Gemas through the changed bridge instruction (F-07) | `tXeFQ19r...uzqSNm` |

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

Deployed 2026-10-02 from the EVM deployer `0x96137cB99Fe2878299b672Ac967e88279f479d1C` (the same key as Hoodi) through `https://rpc.hyperliquid-testnet.xyz/evm`, at 0.1 gwei. Small blocks were enough: no big-block switch was needed (SimLST and the vault each deploy well under the 3,000,000 gas small-block limit). Explorer: `https://testnet.purrsec.com`. Wired on Solana with 500 bps like the Hoodi SimLST vault. **Simulated yield** (simHYPE, 1 month = 10 min, unbacked faucet), the same `SimLST` contract as Hoodi with a configurable name and symbol (`"Simulated Staked HYPE"`, `simHYPE`).

| Item | Value |
|---|---|
| SimLST (simHYPE, **Simulated**, 5% APY) | `0x4FF730663d88457990eAF47b23E19737E39BB238`, deploy `0x31fab59a369662592dd30722fbdc85337f1f2958dcc8f4d9c3d9180375483f1f` |
| SimLST reserve funding (0.1 HYPE sent to the contract, backs accrued yield) | `0x9a21481390e9fa6cb7cde245528e74eaf2a52d4e725ec72babb6235cde644c32` |
| `PositionVaultOApp` (SimLST, simHYPE, **SIMULATED**) | `0x23B17A4c55867406E7CD5602c664E1447400c4a3`, deploy `0x3cf932210cf1bb06cac6469061c6356159c778f716a3c15ffcae68ba05944620`, endpoint `0xf9e1815f151024bde4b7c10bac10e8ba9f6b53e1`, delegate and owner = the deployer |
| `setPeer(40168, 0x60ae58df…c792)` (Store PDA) | `0x04e7ce9768e7e1a9363e49f0a7aa83c1f9e3ddc7e6281374eb38ae437d82574c` |
| Solana `set_peer_config` (eid 40362, decimals 18, 500 bps) | `2Q9TDYySiJ…TMpJQfp4` |
| Solana `endpoint_init_oapp_pathway` (eid 40362) | `3rPDZnMRVZ…DU2MaAqY` |

The SimLST address equals the one the spike OApp would have used (deployer nonce 0 on HyperEVM); the vault equals the address of the Hoodi SimLST (nonce 1). The Solana peer registered by the spike for that old address is inert.

Solana signatures below are abbreviated (first 10 and last 8 characters; the repo's pre-commit scanner treats a full 88-character signature as a possible secret key). The full values are in the branch report.

Smoke test, 2026-10-02, Position id 1 (owner = the deployer's EVM address, linked to the bridge demo Account `5LL7EmptMRWSroaQuK8CxzQpSeBwC1EQEnmc4cRhho8k`): every LayerZero message was DELIVERED, in both directions. The open S2 risk (a live executor and DVN on 40362) is closed.

| Step | Tx | LayerZero Scan |
|---|---|---|
| `init_position` (Solana, id 1) | `oA4LENWWEx…H9EPtiyZ` | |
| simHYPE `faucet` (10), `approve` (HyperEVM) | `0xf9cdb25f052fe58c6702ec270d7f4ff897388bda52caf124b4fcad1a6a641fb2`, `0x7fa086c6bb83947253c8ae611f172df2a27ec12c854e9fffa9048f209f5a2000` | |
| `openPosition` 1 simHYPE, 1 month (HyperEVM to Solana) | `0x3ef381ea4e1b16dec2ea719db2b7d0dbaf900eec568ff5b0192f96fdea36a797` | [scan](https://testnet.layerzeroscan.com/tx/0x3ef381ea4e1b16dec2ea719db2b7d0dbaf900eec568ff5b0192f96fdea36a797): DELIVERED, GUID `0x886fac03e42a1b4311b443e03a2a04f122750f90c39fe9e700fd682eb573fe91`, `lz_receive` `52j4BBioRz…xbDJrjkc` |
| `apply_locked` (principal 1.001178 HYPE, tesoro_core Position `BHVeYiAZxNzsFj5PrSSTHaCmFZehyKJtwofqEwZFtNZY`, chain byte 2) | `3W7MLK4ZuF…SiWUgFQk` | |
| `take_advance` (oracle price $25, 1 month): 10 Gemas | `4Utxa6gh8x…3PsjFJqt` | |
| `reportYield` (HyperEVM, 0.00239 HYPE accrued) | `0x9034cb00fa265504bbb7dd5628b659c231e935696b7f4a4d8a0b26410f0fa324` | [scan](https://testnet.layerzeroscan.com/tx/0x9034cb00fa265504bbb7dd5628b659c231e935696b7f4a4d8a0b26410f0fa324): DELIVERED, GUID `0xa112cd50811d3575a48ed8b72fe7c190c0ccd6e409887caa9b2877162a31bc89`, `lz_receive` `GjwsF5K4qj…7321nGfZ` |
| `apply_yield`: Debt 10 to 4 Gemas | `3Dh7F6QhZY…Bge7Q5MQ` | |
| `redeem_to_evm` 6 Gemas | `4FsXmoeWRf…4MHSNBhs` | |
| `send_pay_yield` (Solana to HyperEVM) | `wQnnoSEzND…EiqRii82` (fee 312,102 lamports) | [scan](https://testnet.layerzeroscan.com/tx/wQnnoSEzND…EiqRii82): DELIVERED, GUID `0xd6f9c67be43c9eec0dd1062db4b2d8fa04979620c8c3f6eff2811ee65b0ce7b3`, HyperEVM tx `0xad3c7dfbc25a18dbb833d93e1d99bc55cd822d13d4d3496618339b5fe4ddf3a5` (status 1) |

Driven from the web app (2026-10-02, dev wallet `?dev=hype1` on `next dev`, 390 px, Wallet HYPE tab; EVM `0x6446CB65Af52036EE31e65f14A49104b74d22160` funded with 0.05 HYPE by the deployer, `0xb8ddf6c8d47a8eb2b1fb57d9a4532a1fbb40f19226f199372782ef1dbefc30d4`): simHYPE faucet, link, approve, `init_position`, `openPosition` (Position id 2, 1.0118 HYPE, Advance 37 Gemas at Coinbase HYPE-USD), `apply_locked` and the Advance by the app, Report yield (`reportYield` `0x250532e5a1cde1f1d98c2f3e55be386ee842cfaaef5a6c23eff805670b79d947`, then `apply_yield`), Redeem 8 Gemas (`redeem_to_evm` `9X9pCrsi7A…sddtwCnm`, `send_pay_yield` `3s8ZUbZo83…acEdgE37`, "simHYPE arrived on HyperEVM"; Scan DELIVERED, HyperEVM tx `0x6ab42dab0cd86ca1f6ff8f26952a1df31bcbfefd319370f509b80464976dad11`, vault `paidUnderlying` 9.006e14). Open tx `0x23c866a74bcce9ce193e41554228ca92673b9347f85510e77ba4e9deb3b088be`. Screen: `app/docs/screens/hype-wallet.png`.

Latency (source block time to destination block time, from Scan): `openPosition` 38 s, `reportYield` 37 s, `send_pay_yield` 78 s. Fees: `quotePositionLocked` 0.0074039 HYPE and `quoteYieldAccrued` 0.0074011 HYPE (the caller pays quote + 20%, excess refunded); gas is negligible at 0.1 gwei. `send_unlock` is proven below.

### HyperEVM: top-up, Unlock and Backing (2026-10-02, dev wallets on `next dev`, Solana devnet + chain 998)

**HYPE top-up.** The server relayer EVM key `0x0aa6F8bB9c163730951f457b5B210bAe8b4997f8` was funded with 0.4 HYPE by the deployer (`0x6792089e896c1bcc03387e1efdb9fe456a6aa324b405f563b8db63ecd1fa7180`). `POST /api/eth-bridge` step `fund-hype` (0.03 HYPE to a wallet under 0.02, once a day per EVM address / Account / Privy user, `TESORO_HYPE_TOPUP_MAX_PER_HOUR` = 5 an hour in total, refuses when the relayer would drop under 0.05 HYPE) dripped to six fresh dev wallets from the Wallet HYPE tab "Get test HYPE" button; each arrived in 10 to 25 s. Guards are unit tested (`app/src/server/hype-topup.test.ts`).

**Unlock.** Dev wallet `hypeA` (Solana `2z2Z...BUFd`, EVM `0x0597E1c2D721Ac3499ffe143225Ff3482Dbca788`), vault Position 5: 1 simHYPE, 1 month, Principal 1.0415 HYPE, Advance 38 Gemas, opened 04:16 UTC.

| Step | Tx | LayerZero Scan |
|---|---|---|
| `reportYield` (keeper, seq 2) then manual `reportYield` (seq 3, deployer, accrued 0.0093 HYPE) | `0x70dcb59361fe10eff2e222fe15ccd5c410bd4ca0ec71f7d661697b0ed5a5e736` | [scan](https://testnet.layerzeroscan.com/tx/0x70dcb59361fe10eff2e222fe15ccd5c410bd4ca0ec71f7d661697b0ed5a5e736): DELIVERED, GUID `0x840e42c268c0198c80ff80de9cf1f005785e9a532e602754799d31d27caf9f40` |
| `apply_yield` seq 2 and seq 3 (keeper): Debt 38 to 0 | `2CF3wxJF...wEFNob4H`, `2MfgQ6v4...Byk3yjQi` | |
| `tesoro_core::unlock` (the app, Wallet "Unlock") | `2Mv7J7oq8h...bRRaZBaP` | |
| `send_unlock` (the app via the relay, 04:44:25 UTC) | `UUpeGz425j...NR6cUcvG` | [scan](https://testnet.layerzeroscan.com/tx/UUpeGz425j…NR6cUcvG): DELIVERED in 65 s, GUID `0xe12aaaae4f87008172fabd6cf648ff43335a726cb3222e83c2b4d75790930e84`, HyperEVM tx `0xbebc93139f75c6a5240d1ba922c184f7449149984de85ffbca0df59c000e11c9`; vault Position 5 `unlocked = true` |

**Backing with HYPE-Sourced Gemas.** Backer `hypeB3` (EVM `0x88b961c49D11e3b9A781FD6ABD948B53C80511C7`): 10 simHYPE, 3 months, 1,156 Gemas, all HYPE-Sourced. Player `hypeP` (a SOL-Sourced Account) posted a 500 Request; the Backer answered with a 40% Offer (500 reserved from the HYPE Gemas); the Player accepted and entered the Queue; opponent `hypeH` (its own HYPE Position, 1,190 Gemas) queued at 500. Block Puzzle Match `3581836887530`: Player 366, opponent 0 (the opponent's run idles), `settle` `5CbCE8SQqV...6gRopKmJ`. Result: entry 500 back to the Backer first, fee 50, surplus 450 split 180 Player / 270 Backer. The Player's Wallet then lists the winnings under "Pending by Source" as `HYPE · D3jj...Exb9's Position` (154 Gemas pending at 14% of that Position's yield accrued, the rest redeemable), the Backer's as the same Source (231 pending); both are paid in simHYPE on HyperEVM by `redeem_to_evm` + `send_pay_yield` as soon as the yield lands. With a SOL-Sourced opponent (Match `3581835206452`, settle `4RWNQiC3Ss...LzaMaLCJ`) the same +180 shows under the loser's SOL Source instead, so the Source follows whose Gemas were lost, not the Backer's. Two Matches in which the run was missed ended 0 to 0: the Match settled as a Draw and the entry returned to the Backer (nothing owed by the Player). Screens: `app/docs/screens/hype-backing2-*.png`, `hype-backing-*-wallet-390.png`.

**Redeem (Backer's HYPE Gemas).** `hypeB3` redeemed 1,158 HYPE-Sourced Gemas through the Wallet Redeem sheet: `redeem_to_evm` `5eXyXXfvHR...`, `send_pay_yield` `23oN4gstiL...gxF4SJsy`, Scan DELIVERED, GUID `0xaac813187c453ca631a27d9384c79c1a150b0170058378b0c025f0d93773cf7e`, HyperEVM tx `0x135610de92135a993842008c07a61f44f0600b3999f53b49dbb49dc5d4172ea8`.

Keeper note: its `KEEPER_MAX_HYPE_PER_HOUR` of 0.03 was exhausted by two Positions an hour; the Unlock run reported seq 3 by hand from the deployer (Debt reached 0 after about 2.2 simulated months, 22 min).

## Solana devnet

Deployed 2026-09-30 from the deployer `AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV` (upgrade authority) via `https://rpc.magicblock.app/devnet`.

| Program | ID | Deploy tx |
|---|---|---|
| tesoro_core | `AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh` | `t2kA9H15...9w3WWm` |
| block_puzzle | `5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj` | `5ok3zXTJ...jpRYUP` |
| holdem (S1) | `CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE` | see docs/spikes/S1.md |

tesoro_core setup (idempotent, `programs/block_puzzle/scripts/devnet-match.ts`):

| Step | Signature |
|---|---|
| `initialize_config` (admin = deployer, oracle = `~/.config/tesoro/oracle.json`, platform fee 200 bps) | `54xsxnDE...t5761B` |
| `register_game` (block_puzzle, authority = PDA `["authority"]` of block_puzzle, studio fee 300 bps, studio recipient = the deployer's Account) | `4TAsGBsX...7nP3FH` |

Block Puzzle end-to-end Match (two test wallets, devnet TEE, settled through tesoro_core by CPI): see `docs/games/block-puzzle.md`; settle tx `221GKqoz...mJGsRg`.

The oracle and test-wallet keys are in `~/.config/tesoro/` (`oracle.json`, `block-puzzle-testers.json`), not in the repo. The tesoro_core on devnet includes `extend_match_deadline`.

### sim_lst (SIMULATED liquid staking token — "Simulated yield · 1 month = 10 min")

| Item | Address |
|---|---|
| Program | `WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F` |
| Pool PDA (`["pool"]`) | `Fc9UUnGEDapkBDM3mPayjqVDLYHokKCPwSLdbvKBUvPL` |
| simSOL mint PDA (`["mint"]`, 9 decimals, authority = pool) | `3Q2VRPmdAZHutWNhE2Rof9Pdg6MnTMotXucmoD5cgAZJ` |
| Vault / reserve PDA (`["vault"]`, system-owned SOL) | `2fQyEVMJNzGmaccxpbzhqMRFSpx9mf1kjsZRAMMRNKDm` |
| Admin / deployer | `AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV` |

Config: APY 7% (700 bps), speedup 4,380 (1 month = 1/12 year of yield per 10 minutes; was 4,320 until the per-Position yield model), faucet 10 simSOL per user per hour.

Rate (SOL per simSOL, 1e9 fixed point): `base_rate + base_rate * apy_bps * ((now - base_ts) * speedup) / (10_000 * 31_536_000)`.
Linear between checkpoints; `set_params` rebases first, so changes compound. Read it from the `Pool` account
(`base_rate`, `base_ts`, `apy_bps`, `speedup`) or via the `get_rate` instruction return data. Yield is paid from the
admin-funded reserve; withdrawals beyond the vault balance are refused. The faucet mints unbacked simSOL.

Helpers: `scripts/sim-lst` (`pnpm rate`, `pnpm faucet`, `pnpm tsx src/cli.ts init | fund <sol>`).

Deploy status (2026-09-30, via `https://rpc.magicblock.app/devnet`):

| Step | Signature |
|---|---|
| deploy | `4Ttfse8f...gQmgJ3` |
| init (7% APY, 4,320× speedup, faucet 10 simSOL/h) | `3nVnaaBR...LqwRaV` |
| fund reserve 20 SOL | `4bvoXZ8z...CCvH2r` |

### tesoro_core upgrade: Solana-native Positions (2026-09-30)

Backward-compatible upgrade of `AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh` via `https://rpc.magicblock.app/devnet` (adds `open_native_position`, `take_native_advance`, `accrue_native_yield`, `sweep_native_surplus`, `set_price`; `redeem`/`unlock` pay from the vault for native Positions). See `docs/tesoro-core.md`. SIMULATED yield.

| Step | Signature |
|---|---|
| upgrade | `5PSa6jL4...Lwf2VZ` |
| `set_price` ($150, oracle) | `49aXJZc4...bpPDCy` |
| sim_lst `faucet` (10 simSOL) | `63RaEhuZ...8yzori` |
| `open_native_position` 5 simSOL + `take_native_advance` 1 month (447 Gemas), one tx | `5FnLCAT7...Xo9xrL` |
| `accrue_native_yield` at ~4 min (Debt 447 -> 264) | `5mfF6GnN...12Q2uy` |
| `accrue_native_yield` at ~10 min (Debt to 19) | `5oqgvsFQ...U7RyPj` |
| `redeem` 428 Gemas (simSOL paid from the vault) | `YYXanf8B...nT23yd` |
| `accrue_native_yield` (Debt 0) | `4biN5G5P...SZ7XpS` |
| `redeem` last 19 Gemas | `2gw9L616...HSsPRg` |
| `unlock` (Principal simSOL returned; wallet 9.999999999 simSOL) | `HZWYkvfh...djzsGK` |

Position `2QxKeDKJfWvGa6uNwXG6533ZpNTazyoUEXj4ALRj2Zb6` (owner wallet = the deployer, nonce 1). One month of Horizon takes about 10.1 min because sim_lst accrues per 30-day month while the Advance projects 1/12 of a year. Helper: `scripts/native-position` (`RPC_URL=https://rpc.magicblock.app/devnet pnpm cli status`).

## Cross-chain bridge (LayerZero V2), 2026-09-30

Details, flow and every proof tx with LayerZero Scan links: `docs/cross-chain.md`.

| Item | Value |
|---|---|
| `tesoro_bridge` program (Solana devnet) | `5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ`, deploy tx `4nQnHMsK...W32sEZ`, upgrade authority = deployer, keypair `~/.config/tesoro/deploy-keys/tesoro_bridge-keypair.json` |
| OApp address (Store PDA, EVM peer) | `7WQLHW8EuyV1V8tWNh8DQGu7mVRgaHGgLU7fi8G91rVw` = `0x60ae58df1215bf45cc054e633b49c92a3b1309f76075bac72b26e0c6e1c0c792`; `init_store` `3bHFM3Rh...aiK2kb` |
| Bridge authority PDA (`["authority"]`, tesoro_core source authority for Ethereum and HyperEVM) | `FEgxs5f7zavRaR7tZJBNZzrYeCMGegMpMWFiHjvyvaLg`, `set_source_authority` `3JUc3Vd7...7qkNkb` |
| tesoro_core upgrade (adds source authorities; includes the native-Position instructions already on devnet) | `bpyct2A3...pkgFsG` (extended by 60,000 bytes first; built from `integ/core-source-native-30-09-2026` = native branch + the source-authority commits) |
| **RETIRED (F-04, replaced 2026-09-30, see below)** Hoodi `PositionVaultOApp` (SimLST, simETH, SIMULATED) | `0x8289fa2e5A7a57618A93B93fc720B85eF3E87b7c`, deploy `0x1abcc8cdbe7c185655ee163bde3316ddbc5bc839c607f6881c6b3cfb69e9c0f9`, `setPeer` `0xff68a61d706539d72ee6faeabc2ae9568d9b9530d55c3f18a894500b2427a1e6` |
| **RETIRED (F-04)** Hoodi `PositionVaultOApp` (real Lido wstETH) | `0x214A695C1F9F0136D87c459fa542878da1128DeD`, `setPeer` `0x0f9531f634fab3c48c66b3f7c9706aaecb6fe85a7a53dd74d4227876080e53f6`; wired on Solana with 300 bps, not exercised end to end |
| Solana `set_peer_config` + pathway init | SimLST vault: `5aGWx8kE...FH4mV8`; wstETH vault: `3avujqcn...EREbrz` |
| HyperEVM | deployed 2026-10-02: see the HyperEVM testnet section above |

The vaults deployed earlier with `MockEndpoint` (table above) are superseded by these.

### F-04 replacement vaults (2026-09-30)

The fixed `PositionVault` (per-seq idempotency) is not upgradeable, so the two LayerZero vaults were redeployed with the same constructor arguments (`contracts/script/deploy-oapp.sh hoodi sim|wsteth`). The old vaults stay on chain but are retired: the app, keeper and scripts point at the new ones, and the old ones keep the old ordering bug, so nothing new should be opened there. Test Positions stranded on the old SimLST vault (owner deployer / dev wallets, ids 1 to 4 in `docs/cross-chain.md`, all unlocked or test-only) are not migrated; the Solana `PeerConfig`s for the old vaults are left registered but unused.

| Item | Value |
|---|---|
| Hoodi `PositionVaultOApp` (SimLST, simETH, SIMULATED) | `0x6c836b96464B5D1b55536d5a34D023528eaEe4bD`, deploy `0xa43b133c433e7a19093f3f5d708cf727d2aaa53dafe9ba67990bc70b3a6ec334`, `setPeer` `0x6e56407fe0823262b6aaa54b27ec566c057aecb269279e412903a702904e664a` |
| Hoodi `PositionVaultOApp` (real Lido wstETH, not exercised end to end) | `0x50f5f66994554ca582136b5C00B9Ce0951B314BF`, deploy `0x453dfe52bc0a945e4f10293da1f83f5d16bf6f3a736332d30fb38e3a066524d9`, `setPeer` `0x39becb431fdeb48859cbd146d58381aaa64a92b154df91dd737a2cf10f01bed1` |
| Solana `set_peer_config` + pathway init, SimLST vault (500 bps) | `dVMHkD46...RCMg1u`, `5LmAiyaJ...vwvfYX` |
| Solana `set_peer_config` + pathway init, wstETH vault (300 bps) | `2YgxL9cm...bc3BCW`, `213Yyc7B...hng2TT` |
| HyperEVM | deployed 2026-10-02 (the same commands with `hyperevm`): see the HyperEVM testnet section |

### SP-01 / PR-01 replacement vaults (2026-10-01)

The implementation review found that `PositionVault` kept accruing yield on shares it had already paid out, so a later PayYield silently paid less than the claim (SP-01), and that it accepted a Principal too large for `u64`, which could never open on Solana or unlock (PR-01). Fixed in `3197c8a`; the vaults are not upgradeable, so both were redeployed from it with the same constructor arguments (`contracts/script/deploy-oapp.sh hoodi sim|wsteth`, then `oapp.sh peer` and `pnpm lz wire 40449 <vault> 18 <bps>` in `bridge/`). The F-04 vaults above are retired: the app points at the new SimLST vault, and Positions on the old vaults are not migrated (they keep SP-01).

| Item | Value |
|---|---|
| Hoodi `PositionVaultOApp` (SimLST, simETH, SIMULATED) | `0xF3F2361432e5066588B96c9A9acF0b7b2907AE0a`, deploy `0x0d45cdf7fbe8ecc1cd82155e72d33aed6206544fb48947b80fbedf600a1b8cee`, `setPeer` `0x9d352078192aa312f274bb9732a5d8066377f3945021e11484c5b59f2417464f` |
| Hoodi `PositionVaultOApp` (real Lido wstETH, not exercised end to end) | `0x61B46f64CDB75930a87955487aAb8A7711F757b5`, deploy `0x502a8297eade0c53b12ae39ef78b3fd1ea40b69185fc598796f9331a4f3dff5f`, `setPeer` `0x70a76b37918f2fe42508fe5c8fc50623dfc5299b8bb6e6281502a8595d19596e` |
| Solana `set_peer_config` + pathway init, SimLST vault (500 bps) | `5sGQ9UzB...kL3YoY`, `2EjWCc2u...GRbkNE` |
| Solana `set_peer_config` + pathway init, wstETH vault (300 bps) | `vFB47JQR...eQCjtB`, `Ao364P96...X3PPwf` |
| Smoke: `init_position` id 1 (Solana) | `yYape2rm...1EFQkN` |
| Smoke: `openPosition` 0.01 simETH, 1 month (Hoodi) | `0x1c886400dd75ccb703abf18fc92a3f9abbf4180a3d42711d084d455bfc90df62`: delivered in about 80 s; `apply_locked` by the keeper (tesoro_core Position `En4vexXm5uWeyT3WroGnGR6rcToHb3Mee4ED4C4A7UbQ` Locked, principal 17,120,273,972,602,739 wei) |
| Smoke: `reportYield` id 1 (Hoodi) | `0x36b25666d10e4c8558836fa5d2a16f9628105bfc1a6f800dcbfb2c1af5dd3de3`: SUCCEEDED in about 90 s, `lz_receive` `2xeKYZwG...f5XaQ5`; applied (tesoro_core cumulative 8,219,178,082,191 wei, seq 2) |

### Web app native Position flow (2026-09-30, dev wallet `?dev=nat2`, browser at 390 px)

Driven from the Wallet screen (`app/src/app/wallet/NativePositions.tsx`) on `https://rpc.magicblock.app/devnet`. SIMULATED yield (1 month = ~10 min). Screens: `app/docs/screens/wallet-native-*.png`.

| Step | Signature |
|---|---|
| Get test simSOL (sim_lst `faucet`, 10 simSOL) | `3Gsq3WZU...pY7nyC` |
| Open Position 1 simSOL + Advance 1 month (91 Gemas), one tx | `5gjwktyy...DobpBz` |
| Refresh yield (`accrue_native_yield`) at ~6 min: Debt 91 -> 36 | `4eBamEVA...2q5Xt7` |
| Redeem 55 Gemas into simSOL | `t6jQBVFx...TpJQMj` |
| Unlock (crank + unlock in one tx, Debt zero) | `3A6xCokh...aLkMBn` |
| Sweep surplus | `31d4VuHd...LEVtQM` |

Keeper (`pnpm --filter @tesoro/keeper once`): `set_price` from Coinbase spot ($119.58, devnet price feed; Pyth Hermes now answers 401 and CoinGecko 403 from this host, so the chain falls through), `3PptTaJC...cWNSmF`; `accrue_native_yield` for both native Positions with Debt, `5k4rDPR6...MHzmTE` and `5yLS3dT9...1N7Ywh`.

## Key compromise response (2026-10-01)

The Solana key `AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV` (`~/.config/solana/id.json`; upgrade authority, `tesoro_core` / `tesoro_bridge` / `sim_lst` admin, LayerZero OApp delegate, owner of the fee-recipient Account) was compromised: its 24.63 SOL were swept at 05:26 UTC (`2WbwBf9X…FgYqiMWR`). Everything it controlled now belongs to `7zr1j185zT8r6jcysC4LyrdSEJ13Up3xq4TFu6KQqh7M` (`~/.config/solana/dev-2026-10.json`), the default key path in this repo's scripts and `Anchor.toml`.

| Step | Value |
|---|---|
| Upgrade authority of all 5 Tesoro programs (and the founder's other 43 devnet programs) | `7zr1...qh7M`; 4 deploy buffers closed to it (8.09 SOL recovered) |
| `set_admin`, gated on the upgrade authority, added by upgrade (tesoro_core +60,000 bytes extend, sim_lst +70,000) | tesoro_core `4yrLnfVc…iQGeidxk`, sim_lst `66NvN38u…dm5S6KtU`, tesoro_bridge `FmpLYriy…zxuBrKC2` |
| `set_admin` tesoro_core Config / sim_lst Pool / tesoro_bridge Store + LayerZero delegate | `2oxRxRfp…WQKzQixe`, `2uPwCUCH…cH2n56bQ`, `5Mgm7mhW…c2J6PWHu` |
| Platform and Studio Fee recipient moved from `CbyA8Pk3...NnDA` (owned by the compromised key) to `GXQse6RG4hqY57fhRJX3W7yzhkwmaqZUHxaJArJWrMGK` (oracle and fee rates unchanged) | `create_account` `4m37su2j...`, `update_config` `acUHJjy3...`, `register_game` `2sndMr7y...`, `3HaoAfku...` |

Gemas the old fee Account already held stay under the compromised key. The web routes use relayer keys (`~/.config/tesoro/relayer.json`, `relayer-evm.env`); the oracle, keeper and EVM deployer keys are unchanged.


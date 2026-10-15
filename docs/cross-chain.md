# Cross-chain: Ethereum Positions on the Solana ledger (LayerZero V2)

Testnets only (Solana devnet, Ethereum Hoodi; HyperEVM prepared). SimLST yield is SIMULATED ("Simulated yield · 1 month = 10 min", per Position, linear on its Principal). Decision: ADR 0002. Spike background: `docs/spikes/S2-S3.md`.

## Pieces

| Piece | Where | Role |
|---|---|---|
| `PositionVaultOApp` | `contracts/src/PositionVaultOApp.sol` | `PositionVault` as a LayerZero OApp. `openPosition` sends `PositionLocked`, `reportYield` sends `YieldAccrued`; `_lzReceive` feeds `Unlock` and `PayYield` into the vault's `_receive` |
| `tesoro_bridge` | `bridge/` (own Anchor workspace, program `5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ`) | Solana OApp. Inbox for inbound facts, permissionless CPIs into `tesoro_core`, permissionless outbound sends |
| `SourceAuthority` | `tesoro_core` (additive) | Per source chain, the signer allowed to report `PositionLocked` / `YieldAccrued`. The bridge PDA `["authority"]` is registered for Ethereum and HyperEVM |

Wire format (identical in Solidity and Rust, `abi.encodePacked`, big-endian): header `msgType u8 | sourceChain u32 (eid) | positionId bytes32 | seq u64` (45 bytes), then `1 PositionLocked`: `owner bytes32 | lst bytes32 | principalUnderlying u128 | horizon u8` (126 bytes); `2 YieldAccrued`: `cumulative u128 | treasuryIn u128` (77, was 61 before ADR 0007); `3 Unlock`: `0 u128` (61); `4 PayYield`: `to bytes32 | amount u128` (93); `5 PayInstant`: `to bytes32 | amount u128` (93, Instant Redeem payout from the vault treasury). `positionId` = vault address (20 bytes) | vault position id (u64) | 4 zero bytes, so two vaults on one chain never collide and a vault can only speak for its own Positions (the bridge checks the id against the LayerZero sender).

## Flow and who pays

1. **App, once per user:** `create_account(evm_address)` in `tesoro_core` (or `set_evm_address`), then link the address: the EVM wallet signs (EIP-191 `personal_sign`) the text `Tesoro: link EVM address to Account <TesoroAccount PDA>` and the Solana wallet calls `tesoro_bridge::link_evm(evm_address, signature)`. The bridge recovers the signer on chain (`secp256k1_recover`), so nobody can claim someone else's address and receive their Positions or payouts. Inbound Positions and outbound payouts resolve the Account through the `EvmLink` PDA `["evm", address]`.
2. **Before `openPosition`:** anyone creates the inbox record with `init_position(eid, positionId)` (about 0.003 SOL). It has to exist before the message: the default executors on Hoodi and HyperEVM cap the native drop to Solana at 0, so rent cannot be paid inside `lz_receive`. The app reads `vault.nextPositionId()` and creates the record for `next + 1` (a keeper can pre-create a few ahead). If the record is missing `lz_receive` fails and stays retryable.
3. **`openPosition(lstAmount, months)` on the vault** (approve the LST first). **The caller pays the LayerZero fee** in the chain's native token: read `quotePositionLocked()` and send it plus about 20% as `msg.value` (excess refunded to the caller). About 0.0001 ETH on Hoodi. Delivery to Solana took about 2 minutes.
4. **`apply_locked(eid, positionId)`** (permissionless, payer funds rent): the bridge CPIs `tesoro_core::open_position_from_source`, signed by its PDA, for the Account linked to the owner's EVM address. `PeerConfig` (per vault, admin-set) supplies `decimals` and `rate_bps`. Principal is the vault's `principalUnderlying` in wei (must fit `u64`, so up to about 18 ETH: `openPosition` reverts `PrincipalTooLarge` above it, and `apply_locked` refuses rather than truncates).
5. **Advance:** unchanged oracle path (`take_advance`, oracle price plus owner signature).
6. **`reportYield(id)`** on the vault (anyone, the caller pays the fee; `quoteYieldAccrued()`), then **`apply_yield(eid, positionId)`** on Solana (permissionless; pass the Position's open Source account when it has one). Debt falls automatically.
7. **Redeem ETH-Sourced Gemas:** the holder calls `tesoro_bridge::redeem_to_evm(gemas)` instead of `tesoro_core::redeem` (it CPIs `redeem` and records the units in a `Claim` PDA). Calling `redeem` directly for a non-Solana Source burns the Gemas without recording a payout. Then anyone calls `send_pay_yield(eid, positionId)`: it sends `PayYield(to = holder Account's EVM address, amount = units not yet sent)` and advances `claim.units_sent` in the same transaction, so a unit is paid once. The vault pays the LST shares worth that amount and refuses more than accrued yield.
8. **Unlock:** when Debt is zero the owner calls `tesoro_core::unlock`, then anyone calls `send_unlock(eid, positionId)` (guarded by `unlock_sent` and the out seq). The vault releases Principal to the EVM owner; yield owed to redeemers stays in the vault. Solana sends are paid by the caller in SOL (about 0.0003 SOL); delivery to Hoodi took about 4 to 5 minutes.

The inbox is deliberate: `lz_receive` only records the fact (no CPI), because its account list is derived from the message alone and cannot include the Account, the open Source or rent-funded accounts. Applying is a second, permissionless transaction the app or keeper sends right after delivery (poll LayerZero Scan, then call `apply_locked` / `apply_yield`).

Replays and reordering: `Endpoint::clear` burns the nonce; `PositionLocked` applies once (`locked_seq`), `YieldAccrued` keeps the highest seq (`last_yield_seq`), `tesoro_core` is idempotent by seq. On the vault, seq must strictly increase, so an `Unlock` (seq n) delivered after a later `PayYield` (seq n+1) would be ignored; send them minutes apart, never both in one block.

## `tesoro_core` changes (additive)

New `SourceAuthority` PDA (`["source_auth", chain_byte]`, `chain`, `authority`) and instructions `set_source_authority(chain, authority)` / `remove_source_authority(chain)` (admin), `open_position_from_source(...)` and `apply_yield_from_source(seq, cumulative)`: the same bodies as `open_position` / `apply_yield` but signed by the registered authority of the Position's chain (an Ethereum authority cannot touch a HyperEVM Position). `oracle_authority` and every existing instruction, account layout and signature are unchanged; the oracle still supplies the issuance price in `take_advance`. Tests: `programs/tesoro_core/tests/source_authority.rs`.

## Vault redeploy (2026-10-03, per-Position yield)

The SimLST vaults were redeployed because the yield model changed (`docs/yield-model.md`): the SimLST rate no longer grows; the vault mints each Position's linear yield into itself (`PositionVaultOApp` takes a `yieldMinter` constructor argument, `SimLST.setMinter(vault)` authorises it). Hoodi simETH vault `0x8B099AbfC204E1a07D6CA686D302CE6cbC07a3A3`, HyperEVM simHYPE vault `0xf70dafE2788881F6ae54Bea7342dcb3D9b92A316` (wiring in `docs/deployments.md`). The wire format, flow and Solana side are unchanged. `reportYield` accrues first, so the reported cumulative yield includes everything earned up to that block. Positions on the earlier vaults below are abandoned.

## Vault redeploy (2026-10-01, implementation review SP-01 and PR-01)

The Hoodi vaults were redeployed again so accrued yield counts only the shares still held (a later PayYield could silently underpay) and `openPosition` refuses a Principal above `u64`: SimLST vault `0xF3F2361432e5066588B96c9A9acF0b7b2907AE0a`, wstETH vault `0x61B46f64CDB75930a87955487aAb8A7711F757b5` (txs and Solana wiring in `docs/deployments.md`). The F-04 vaults below are retired the same way.

## Vault redeploy (2026-09-30, security review F-04)

The Hoodi vaults were redeployed with per-seq idempotency: SimLST vault `0x6c836b96464B5D1b55536d5a34D023528eaEe4bD`, wstETH vault `0x50f5f66994554ca582136b5C00B9Ce0951B314BF` (addresses, txs and Solana wiring in `docs/deployments.md`). The vault addresses in the "Proven" tables below are the RETIRED ones (`0x8289...87b7c`, `0x214A...8DeD`); the flow was repeated on the new SimLST vault (Position id 1: `openPosition`, `apply_locked`, `take_advance`, `reportYield`, `apply_yield`, `redeem_to_evm`; signatures in `docs/deployments.md`). `redeem_to_evm` now takes `store`, `authority` and `core_source_authority` and signs `tesoro_core::redeem_from_source` as the bridge authority, because plain `redeem` refuses EVM-sourced Sources (F-07).

## Proven on testnets (2026-09-30, on the retired vault)

Position: SimLST vault `0x8289fa2e5A7a57618A93B93fc720B85eF3E87b7c`, id 1, owner `0x96137cB99Fe2878299b672Ac967e88279f479d1C`, Solana Account `5LL7EmptMRWSroaQuK8CxzQpSeBwC1EQEnmc4cRhho8k`, principal 1.0749 ETH (1 simETH share at the accrued rate), Advance 1 month at $3,000/ETH = 1,343 Gemas.

| Step | Tx | LayerZero Scan |
|---|---|---|
| faucet simETH, approve | `0x182a0610dcb245e5b494b4ddf69304268385c03ca6b698134894f66ac42b7ed8`, `0xf34a69a05dca1ed8d2ec4dfef4b28e2403cf0f3991607a27ca125928565c142d` | |
| `init_position` (Solana) | `4ciMVT4QDQPWGGsXURPGEw8uqYbAg2ttXUJLQSELeEQnZQNsfL6ANGifyG7KgGFvrKUJ5GmJU53j2Wtf8rsmMDVT` | |
| `openPosition` (Hoodi) | `0xc9702af81aeb8549d3cbaa3303cb7c0c7e558e417f87614a989f20103f3c68ee` | [scan](https://testnet.layerzeroscan.com/tx/0xc9702af81aeb8549d3cbaa3303cb7c0c7e558e417f87614a989f20103f3c68ee): DELIVERED, `lz_receive` `4qcaZkvYLYXhF1AsaCgerLntVYWtxRbZ3rBBLUDswC5TrDLojBEDt5J2CrzBpA3VCVCx9DJgvRh42BubDVMpVEV7` |
| `apply_locked`: Position exists for the Account | `45K38PACkyYWjw2XnFCR9tUxTTphcQ1Xd85HxGpKZXwXQcJt3fxBsmdYc7pE4uAhFKwW5GL89dbezC161hVqTrxY` | |
| `take_advance` (oracle price): 1,343 Gemas | `5WV5VZFTe6AVYs9ephXKwvJPEWvuUyexpSJMgSu5T3ZYwkh3Sf1RRXNnTNMQRyyVwtyKvHNUzYEonyVmbgpsx2gx` | |
| `reportYield` #1 (0.001068 ETH accrued) | `0x6393581bcae73fcd42559e92ac2259825a369428f4953e21b0ac68a8d1c504a1` | [scan](https://testnet.layerzeroscan.com/tx/0x6393581bcae73fcd42559e92ac2259825a369428f4953e21b0ac68a8d1c504a1): DELIVERED, `lz_receive` `2zZWKxk98y3PLM9jwsjSZYcziF4T2Cv6hJt2KAPnGGmgVzXvrAo8vJrn5orS9u9bDdiWyZSgtZbAnUxZF4ZXyg63` |
| `apply_yield`: Debt 1,343 to 1,023 | `5yFYx9JA67RJmYT69shzPiE7tuLmnEi6wwT3ZEfWP4f8Dok3sKWjA3wN2yp6RLB5CijjgQf6oqy2Bs1Rfbuj7NRG` | |
| `redeem_to_evm` 300 Gemas (claim 0.001 ETH) | `41KFQJA4goJoTe2wgEQMdx8FMxF1owoSLzceRJhdDsijjZ51ecFD4VyhWg7XzxYbNcNYF6Ns4qrdwVwTnwtr3Qem` | |
| `send_pay_yield` (Solana) to Hoodi | `5ziR5eYyeR2JKj4YjeComqxpGn2Zu3MQK6ZfcZQXuYC2ZXAU1AmPRzrwcor6Ee6qaL28XqqKhhcdjbEK5Qm5skav` | [scan](https://testnet.layerzeroscan.com/tx/5ziR5eYyeR2JKj4YjeComqxpGn2Zu3MQK6ZfcZQXuYC2ZXAU1AmPRzrwcor6Ee6qaL28XqqKhhcdjbEK5Qm5skav): DELIVERED, Hoodi `0xd2c7c736ed2c04de8cb262d97478d55d15616f637e6cea422490c8f0258cbb3f` (vault `paidUnderlying` = 1e15) |
| `reportYield` #2 (0.004849 ETH accrued) | `0x7ca23e7f5f3d8bc3c5ae600582276c12a50564ccd41fad96e41ef0de73360727` | [scan](https://testnet.layerzeroscan.com/tx/0x7ca23e7f5f3d8bc3c5ae600582276c12a50564ccd41fad96e41ef0de73360727): DELIVERED, `lz_receive` `4yRePUByG3NkM9isZXeaibbDxGHPobGExwNBGkdfKC2jsafExZVcXm1c3EmykARUASKivc9urSbEoUQLevzwGTZ5` |
| `apply_yield`: Debt 0, open Advance closed | `uQgZfyPcBzifMhJN3VxSapkxegMDSuio3EDeHSZxNfVjGnNgCsGy4qdVhNW2RjxL2nBuPV7QR95Bm2demRbkCr3` | |
| `tesoro_core::unlock` (owner) | `5QqUm4RgtVYSuecCYhTZbsDehW2R1wtx3g44fcmsSGT3HNp835J32Udj9zgMUYoDZ2KhWU9fjCmeZgrUHoiGYdEc` | |
| `send_unlock` (Solana) to Hoodi | `2umJvv9FhNxsoDZnkF7kEaborfiiAeLQGyaN31jDmoNDU5KySFxMgHQQv2Y2DacTbpWUQLgup625QgAnccarfLVj` | [scan](https://testnet.layerzeroscan.com/tx/2umJvv9FhNxsoDZnkF7kEaborfiiAeLQGyaN31jDmoNDU5KySFxMgHQQv2Y2DacTbpWUQLgup625QgAnccarfLVj): DELIVERED, Hoodi `0x1ebe3ccee65faeda8cb371b8ca6aa8eda1c3f80bdeb682cbfd56dfbb5126dc31`; vault Position `unlocked = true`, Principal shares released to the owner |

Fees seen: about 0.000115 ETH per Hoodi send (quote), 295,626 lamports per Solana send. Latency: Hoodi to Solana about 2 minutes, Solana to Hoodi about 4 to 5 minutes.

## Driven from the web app (2026-09-30, dev-wallet Account, browser at 390 px)

The Wallet's "Ethereum Positions · Hoodi" flow (`app/src/app/wallet/EthPositions.tsx`) run end to end with a dev-wallet Account: Solana `FKXAFiKnHnMiy7G8yx4Afid1fVnJbRSMLSdw6phE49EE`, Account `AwTngQ6nqDUUugthtZzmEgpEyCPPfCXuhhQs4vbTubn8`, EVM `0x8a83fe86e4236d79e1fdcf83384708242f496a14`, SimLST vault `0x8289...87b7c` Position id 4, principal 1.1078 ETH (1 simETH share), Advance 1 month at the oracle's $2,678/ETH = 1,235 Gemas.

| Step | Tx | LayerZero Scan |
|---|---|---|
| Hoodi ETH top-up (server, from the deployer) and simETH faucet (Simulated) | faucet `0x06b0ba0568528ccf05f82ffd9652ac843140d32dddc680b5b323136826e83360` | |
| `create_account` | `66UFffe1j4x1CPnVsX4oQTR5XK9tCA6tm4LgLrgYUHkin3Yi1aFSBKnkDKuKi5fr8x9q2exb6iw3BDpHFCsRS5Nyu` | |
| `set_evm_address` + `link_evm` (EIP-191 signature by the EVM wallet, one Solana tx) | `Qu6qrbm1D9atXNiGjwGQ5o4vJHPkPptyi1y94gqgFdyy2kc5sWahHRaXYxSaXorG3mg8kDDp7VMphehP82HwNQB` | |
| `init_position` (server, deployer pays), approve, `openPosition` (Hoodi) | open `0xe84648cc15a8138e9a81d126330b1478a540c3f469348e43994a3a60a05549ce` | [scan](https://testnet.layerzeroscan.com/tx/0xe84648cc15a8138e9a81d126330b1478a540c3f469348e43994a3a60a05549ce): DELIVERED, `lz_receive` `3amG3cFtsyuaKo9YWvNbKqCko8tYh5fuMLRFh7N3VNjpA21g79rzHQbApVrA2yvUSjdjfH6tURSC7P8WY7paMkLc` |
| `apply_locked` (the app, via the relay) | `5Q39kQMW149KgsryLAvLv31H6yKfVftMvZ5xWjVoHyfZargDM5iBxCpoyQyNGP5NkovnrEowyJsfiWFRfKnLyAKa` | |
| `take_advance` (oracle-signed, Account co-signs): 1,235 Gemas | `83y2cDxe3UeftshRX2mWBnFTJcVMi6Sw4o23RaZDndrGzrxTBnoEMGAZZv3odb5yv7mMMTuTWcn2FvHWXQz8YGz` | |
| Report yield #1 (Hoodi) | `0xaf9b052f8e3043d0bc5ab344283ed41518f6126e7477c69e2e5dfc9724178333` | [scan](https://testnet.layerzeroscan.com/tx/0xaf9b052f8e3043d0bc5ab344283ed41518f6126e7477c69e2e5dfc9724178333): DELIVERED, `lz_receive` `5UYNGy8ohe8mq3q4MuppehhS6CUaWfSrnhCnnMDkpYtnLGQYfyAVPdcFXLdEuu63AVdojQdQ7C3LXKB8jBjRrzK8` |
| `apply_yield`: Debt 1,235 to 400 | `2RyQoszZ7zVpDQ6wvxvVis91CQFEtDf6zykPi9VJ6wAtiPHALFCbiiMwVj4xmHmmXh9zSRrKMFRcePUdbPRhDGPL` | |
| `redeem_to_evm` 835 Gemas | `4tUayEAURNquJmK5bcyYFggGmQM1EomWDcvRgprHs4FmRpfGkjmoNBccbAannfXt8kkYBEqj5SizJkhWaKn6Pn8w` | |
| `send_pay_yield` (the app, via the relay): 0.00312 simETH to Hoodi | `4CXz1RfNMFLyGEy1hLKYjSQu5e7SDFvLPtgRSr8PzZV6msFtDzzaqNFVFWijhV5qUQB3cQFw7yj9wDxFFxny9uzg` | [scan](https://testnet.layerzeroscan.com/tx/4CXz1RfNMFLyGEy1hLKYjSQu5e7SDFvLPtgRSr8PzZV6msFtDzzaqNFVFWijhV5qUQB3cQFw7yj9wDxFFxny9uzg): DELIVERED, Hoodi `0xddcc27be8adeda59b1e159b1a64e20c0aad6bde6cc4fd22673948188ec2dbf32` |
| Report yield #2 (Hoodi) | `0xbf1e6835732eff7acfb91ffb7e0c0d384845fc9390c4c510ffb4ab014a361863` | [scan](https://testnet.layerzeroscan.com/tx/0xbf1e6835732eff7acfb91ffb7e0c0d384845fc9390c4c510ffb4ab014a361863): DELIVERED |
| `apply_yield`: Debt 400 to 0 | `2u1oRwfycPeb6cNVP8d4RFAa8kR6JC16fQFua4SS8qVcpt66aJCHm6tstjriJFk9RYY48gfi8ZQLfAnhGZsonD8T` | |
| `redeem_to_evm` 400 Gemas (through the Wallet Redeem sheet), then `send_pay_yield` | `2uvhDMycdkAorUv53jsf2ya2qdW6UABHBkmBVJAj5x1VwjLAp5z7Rsk34UGViTb2p5VVoNE1Poss1hheWGgUXXpj`, `5nqH76Xa9QhJhExq9faerhMb5kCoBDWUstLJraqv1sRW3t7rUi1QmoCpKbcXV1rFVH4xubWNhkHLFVDNE5eH4RM3` | [scan](https://testnet.layerzeroscan.com/tx/5nqH76Xa9QhJhExq9faerhMb5kCoBDWUstLJraqv1sRW3t7rUi1QmoCpKbcXV1rFVH4xubWNhkHLFVDNE5eH4RM3): DELIVERED, Hoodi `0x851b2b41850056060c88713b66fe826606cec6db64c39ba93105eb96eb959d7e` |
| `tesoro_core::unlock` (owner), then `send_unlock` | `2r9Vs7yvR3MemZVezmUi4yHWyzPnE5PumsNEsmyFgdnn9QsvkJaT2g4erWrXm5Dj8a2GACdCwVT9W4dnbSpGpmJV`, `5n236wgBW8k57CyRFncco9TE8p3QX1MqTQBAUQPB6CmwvAwPeb7Smd2i6NH45ghunXsrSpt5b1vy9g9qTykge7Tt` | [scan](https://testnet.layerzeroscan.com/tx/5n236wgBW8k57CyRFncco9TE8p3QX1MqTQBAUQPB6CmwvAwPeb7Smd2i6NH45ghunXsrSpt5b1vy9g9qTykge7Tt): still INFLIGHT in Scan's index when the vault already showed `unlocked = true` (Principal shares released to the owner); the app tracks the vault, not Scan |

Observed: the Advance appears about 2 to 3 minutes after `openPosition` (delivery, then the app's `apply_locked` and Advance); redeem and unlock deliveries to Hoodi took about 4 to 5 minutes each. The app sent `send_pay_yield` and `send_unlock` more than a minute apart, which the vault's old strictly increasing seq guard required. That guard dropped messages delivered out of order and was replaced by per-seq idempotency (audit F-04); spacing sends is no longer needed on a redeployed vault.

## Driving it (scripts)

- `bridge/scripts/flow.ts` (`pnpm flow <cmd>` in `bridge/`, `SOLANA_RPC=https://rpc.magicblock.app/devnet`): `create-account`, `link-message`, `link`, `init-position`, `state`, `apply-locked`, `advance`, `apply-yield`, `unlock`, `send-unlock`, `redeem`, `send-pay-yield`. Owner key `~/.config/tesoro/bridge-demo-owner.json`, oracle `~/.config/tesoro/oracle.json`, payer `~/.config/solana/id.json`.
- `bridge/scripts/lz.ts`: `init`, `wire <eid> <vault> <decimals> <rateBps>` (PeerConfig + endpoint pathway), `quote`, `defaults`, `config`, `set-uln`. `bridge/scripts/scan.sh <txHash>` polls LayerZero Scan. `bridge/scripts/upload.ts`: paced buffer upload.
- `contracts/script/deploy-oapp.sh`, `contracts/script/oapp.sh` (peer, quotes, faucet, approve, open, report, position, sign).

## HyperEVM (eid 40362): deployed and proven (2026-10-02)

Same flow, contracts and Solana accounts as Hoodi; only the vault, the `PeerConfig` (eid 40362, 18 decimals, 500 bps) and the tesoro_core chain byte (HyperEVM = 2, source authority already registered for the bridge PDA) differ. SimLST vault `0x23B17A4c55867406E7CD5602c664E1447400c4a3` (simHYPE, **Simulated**, 1 month = 10 min), SimLST `0x4FF730663d88457990eAF47b23E19737E39BB238`. Position ids are `vault | id | 0` as on Hoodi, so Hoodi and HyperEVM Positions never collide.

Deployed with `contracts/script/deploy-oapp.sh hyperevm sim <SimLST>` after `forge create src/SimLST.sol:SimLST --constructor-args <owner> "Simulated Staked HYPE" simHYPE` (SimLST takes its name and symbol since this change), then `contracts/script/oapp.sh hyperevm <vault> peer 0x60ae...c792` and `pnpm lz wire 40362 <vault> 18 500` in `bridge/`. No big blocks were needed. Gas is about 0.1 gwei; the LayerZero fee is about 0.0074 HYPE per message, so a wallet needs roughly 0.02 HYPE per open or report. **There is no HYPE faucet to relay** (testnet HYPE needs a mainnet balance), so the app tells the user to send HYPE to their EVM address instead of topping it up.

Proven on testnets with Position id 1 (transactions and Scan links in `docs/deployments.md`): `init_position`, `openPosition` (delivered in 38 s), `apply_locked`, `take_advance`, `reportYield` (37 s), `apply_yield` (Debt 10 to 4 Gemas), `redeem_to_evm`, `send_pay_yield` to HyperEVM (78 s, vault tx status 1). Every message DELIVERED. The unlock path (`send_unlock`) was not run on HyperEVM because the test Position still has Debt; it shares the Solana to EVM send code with `send_pay_yield`. The earlier risk (no live executor and DVN traffic on 40362, spike S2) did not materialize.

Unlock on HyperEVM (2026-10-02): Position 5, Debt 38 to 0 after two `apply_yield`, `tesoro_core::unlock`, `send_unlock` DELIVERED in 65 s, vault `unlocked = true`; a Backing Offer funded with HYPE-Sourced Gemas settled with a winner whose Wallet lists the HYPE Source as pending; HYPE-Sourced Redeem and the server HYPE top-up are proven too. Transactions: `docs/deployments.md` (HyperEVM: top-up, Unlock and Backing).

The app opens HYPE Positions from the Wallet's HYPE tab and tracks them like ETH Positions; the keeper reports yield for them with its own HYPE budget (`keeper/README.md`).

## Yield Fee, Instant Redeem and the vault Treasury (2026-10-12, ADR 0007)

**EVM vault** (SimLST vaults only): `yieldFeeBps = 2000` (cap 5000, admin setter). On accrue, 20% of the minted shares go to `treasuryShares` (`treasuryIn += value`) and 80% to the Position. `fundTreasury(shares)` is the owner's top-up; there is no withdrawal, because Solana's cap relies on `treasuryIn` only growing. `reportYield` sends `YieldAccrued(cumulative, treasuryIn)`. `MSG_PAY_INSTANT` pays the holder from the treasury; `InsufficientTreasury` reverts (retryable) and each (id, seq) pays once. A `PayYield` whose `to == address(this)` books into the treasury (the refill). New vaults come from `script/deploy-oapp.sh`, then `SimLST.setMinter(newVault)`; the constructor is unchanged. Vaults from before ADR 0007 speak the 61-byte message and are abandoned.

**`tesoro_bridge` state**
- `BridgePosition` gains `treasury_in: u128` at the end (after `unlock_sent`), taken from the latest yield message. Old accounts no longer decode.
- `VaultTreasury`, PDA `["treasury", eid u32 BE, vault bytes32]`: `eid`, `peer_address`, `reported_in`, `instant_recorded`, `bump`. Created by `set_peer_config` (`vault_treasury` is a new account after `peer`). Available for Instant Redeem on a vault = `reported_in - instant_recorded`.

**`tesoro_bridge` instructions**
- `apply_yield` now takes `vault_treasury (mut)` after `bridge_position` and raises `reported_in` to the Position's `treasury_in` (max, monotonic).
- `sync_treasury(PositionRef)` (permissionless): accounts `bridge_position`, `vault_treasury`; raises `reported_in` without applying yield.
- `instant_redeem_to_evm(gemas)` (payout = value less tesoro_core's `instant_fee_bps`, currently 2,500 bps, so 75%; vaults have no Instant Redeem rate of their own): the holder signs. CPIs `tesoro_core::instant_redeem_from_source` (bridge PDA co-signs as source authority), refuses `TreasuryShort` unless `instant_recorded + payout <= reported_in`, adds the payout to `instant_recorded` and records it in an `InstantClaim` PDA `["instant", holder_account, core_source]` (`init_if_needed`). The cap is safe because `treasuryIn` is monotonic and only Instant Redeem spends the vault treasury.
- `send_pay_instant(SendParams)`: like `send_pay_yield` but reads the `InstantClaim`, sends `PayInstant(to = holder's EVM address, amount = units not yet sent)` and advances the claim in the same transaction.
- `redeem_treasury_to_evm(gemas)` (permissionless): the Treasury Account redeems its Gemas of an EVM Source (`redeem_treasury_from_source`) and records a normal `Claim`.
- `send_pay_yield`: `evm_link` is now optional. When the claim's holder is the Treasury Account the `PayYield` goes to the vault's own address, which books it into its treasury.
- `quote_send` accepts message type 5.

**Loop.** Yield Fee accrues in the vault, `reportYield` tells Solana (`treasuryIn`), a holder Instant Redeems on Solana (capped by `reported_in - instant_recorded`), `PayInstant` pays them from the vault. When the Source's yield lands, `redeem_treasury_to_evm` + `send_pay_yield` refill the vault treasury at full value.

## Ethereum mainnet wstETH vault (ADR 0010, not deployed)

`contracts/script/DeployMainnetWstETH.s.sol`: `WstETHRateAdapter` plus `PositionVaultOApp` on real Lido wstETH (`0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0`), no yield minter, LayerZero V2 endpoint `0x1a44076050125825900e736c501f859c50fE728c`, eids Ethereum 30101 and Solana 30168 (LayerZero metadata API, checked 2026-10-15). Yield is the growth of `stEthPerToken()` on the Position's shares; `_accrue` moves `yieldFeeBps` (20%) of new growth from the Position to the Treasury at the source (high-water mark per Position, so a rate dip is not charged twice), and `reportYield` sends the same 77-byte `YieldAccrued`. On the mainnet cluster the Player pays gas and the LayerZero fee (`app/src/lib/chain/eth-fee.ts`, shown in the open form); the relayer top-up and faucet steps refuse. Optional fork test: `ETH_MAINNET_RPC=<url> forge test --match-contract WstETHMainnetForkTest`.

## HyperEVM mainnet kHYPE vault (ADR 0010, not deployed)

`contracts/script/DeployMainnetKHype.s.sol`: `KHypeRateAdapter` plus `PositionVaultOApp` on Kinetiq kHYPE (`0xfD739d4e423301CE9385c1fb8850539D657C296D`, 18 decimals), no yield minter, chain id 999, LayerZero V2 endpoint `0x3A73033C0b1407574C76BdBAc67f126f6b4a9AA9`, eids HyperEVM 30367 and Solana 30168 (LayerZero metadata API, checked 2026-10-15; the endpoint's `eid()` reads 30367 on chain). The rate is the StakingAccountant's (`0x9209648Ec9D448EF57116B73A2f081835643dc7A`) `kHYPEToHYPE(1e18)` (1.0265 HYPE per kHYPE on 2026-10-15). Both addresses come from kinetiq.xyz/docs/contracts-and-audits and were read on chain. The rate rises with validator rewards and can fall: the accountant tracks `totalSlashing`, so a slashing lowers it. The vault's high-water mark charges the 20% Yield Fee only on new highs, the same behaviour as wstETH (tested with a mock that drops the rate). Kinetiq takes its own 10% of staking rewards before the rate, so the Player's APY is net of both fees. The Yield Fee and the 77-byte `YieldAccrued` are unchanged.

Deploy (orchestrator only): the vault needs about 3.37M gas, above HyperEVM's small-block limit, so switch the deployer to big blocks first (`evmUserModify usingBigBlocks`, as in `docs/deployments.md`), run `forge script script/DeployMainnetKHype.s.sol --rpc-url hyperevm --broadcast --slow` (`HYPEREVM_MAINNET_RPC`, `VAULT_OWNER` = multisig, `EVM_DEPLOYER_PRIVATE_KEY`), then switch big blocks off. `contracts/script/deploy-oapp.sh hyperevm-mainnet khype <adapter>` is the manual equivalent. Afterwards `setPeer(30168, <Store PDA>)` from the owner, wire the pathway (`bridge/scripts/lz.ts`), register the vault with `set_peer_config` (eid 30367, 18 decimals), and set `NEXT_PUBLIC_KHYPE_VAULT` so the app lists it.

App: on the mainnet cluster the HYPE tab uses the same Player-pays path as ETH (quote of gas and LayerZero fee before signing, no relayer top-up, no faucet card); the HyperEVM eid, explorer and LayerZero Scan links follow the cluster. Optional fork test: `HYPEREVM_MAINNET_RPC=https://rpc.hyperliquid.xyz/evm forge test --match-contract KHypeMainnetForkTest`.

## Opening with plain ETH or HYPE (ADR 0010, ticket 16, not deployed)

`contracts/src/StakeZap.sol`: `LidoZap` and `KinetiqZap` stake the Player's coin through the provider and lock the result in the vault for the Player in one transaction (`openWithNative(stakeAmount, minLst, horizonMonths)`, `msg.value = stakeAmount + LayerZero fee`). No DEX swap. The vault gained `openPositionFor(owner, lstAmount, horizon)` (the zap pulls the LST it just received; the Position and the 45-byte `PositionLocked` owner are the Player, not the zap). The endpoint refunds the unused fee to the zap, which forwards it to the Player; the zap keeps no funds or state. A revert anywhere (provider paused or over its limit, stake under the minimum, `minLst` missed, short LayerZero fee) unwinds the stake too, so the coin stays in the wallet.

- **ETH -> wstETH:** the zap sends ETH to wstETH `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0`, whose `receive()` runs `stETH.submit` and mints wstETH (docs.lido.fi/contracts/wsteth). Lido's own stake limit and pause apply.
- **HYPE -> kHYPE:** the zap calls `stake()` (payable) on Kinetiq's kHYPE StakingManager `0x393D0B87Ed38fc779FD9611144aE649BA6082109` (kinetiq.xyz/docs/contracts-and-audits). kHYPE is minted at once, no queue. `minStakeAmount()` reads 5 HYPE on 2026-10-15 (below it `stake()` reverts `0x860b82a9`); the app reads `KinetiqZap.minStake()` and says so before signing. Verified by a fork test on the public HyperEVM RPC.
- **Limit:** the vault caps Principal at u64 wei (about 18.4 ETH or HYPE per Position), so the form refuses more.
- **Deploy (orchestrator):** after each vault, deploy `new LidoZap(vault, wstETH)` / `new KinetiqZap(vault, kHYPE, stakingManager)`; set `NEXT_PUBLIC_KINETIQ_ZAP` / `NEXT_PUBLIC_LIDO_ZAP`. On the mainnet cluster the app lists only these real-token vaults (`NEXT_PUBLIC_WSTETH_VAULT` on Ethereum, `NEXT_PUBLIC_KHYPE_VAULT` on HyperEVM), each hidden with a plain note while its address is unset; no SimLST vault shows. Until the trailing APY (ticket 11) is published the open form shows the APY as "—". The zap needs no LayerZero wiring: it is a plain caller of the vault.
- **App:** `lib/chain/eth-native.ts` (choices ETH/wstETH and HYPE/kHYPE, quote of the token received with 0.5% slippage floor), `openEthPosition(..., native)` and the Wallet open form's "Open with" choice; the form shows the token received, the stake minimum, gas and the LayerZero fee before signing.
- **Tests:** `contracts/test/StakeZap.t.sol` (mocks, incl. reverts that leave the coin), `StakeZapFork.t.sol` (`ETH_MAINNET_RPC`, `HYPEREVM_MAINNET_RPC`), `app/src/lib/chain/eth-native.test.ts`, `eth-flow-mainnet.test.ts`.

## Mainnet wiring (Ethereum and HyperEVM to Solana mainnet, ticket 17, not run)

Nothing here has been sent on any chain. `bridge/scripts/lz-mainnet.ts` plans one pathway at a time and is a dry run unless `--execute` is given (Solana steps only, signed by the delegate keypair; the EVM steps are printed as calldata for the vault owner and never sent by the script). `--verify` reads the pathway back (Solana through the LayerZero SDK, EVM through `cast call`) and exits non-zero on any mismatch. It needs `cast` (Foundry) on the path.

```
cd bridge && pnpm install --frozen-lockfile --ignore-workspace
pnpm lz-mainnet --pathway ethereum|hyperevm --vault 0x<vault> --safe 0x<vault owner Safe> \
  --delegate <Solana delegate pubkey> --decimals 18 --rate-bps <bps> \
  [--program-id <tesoro_bridge mainnet id>] [--dvns layerzero-labs,nethermind] [--safe-json batch.json] \
  [--rpc <solana mainnet url>] [--evm-rpc <url>] [--verify] [--execute --keypair <delegate keypair>]
```

### Run order

1. **Deploy the vault** (`script/DeployMainnetWstETH.s.sol` or `DeployMainnetKHype.s.sol`) with `VAULT_OWNER` = the chain's Safe. The vault owner is also its LayerZero delegate, so every EVM step below is a Safe transaction. Record the vault address.
2. **Deploy or upgrade `tesoro_bridge`** on Solana mainnet (orchestrator; ticket 26). The Store PDA is `["Store"]` under the program id, so the peer address on EVM (`0x60ae58df...c792` for `5bzDVZ...vTQ`) is known before the deploy; pass `--program-id` if the mainnet id differs.
3. **Wire.** Per pathway: run the script as a dry run and read every address against the table below; run `--execute` for Solana (first pathway also runs `init_store`; the delegate key is the deployer until step 5); send the printed EVM calls from the Safe (`--safe-json` writes a Safe Transaction Builder batch). The Solana `set_peer_config` also creates the `VaultTreasury`.
4. **Verify.** Run again with `--verify --rpc ... ` and require "All checks passed". Then `SOLANA_RPC=<mainnet url> SOLANA_KEYPAIR=<any funded key> pnpm lz quote <eid> <vault> 3` (bridge outbound fee) and the EVM `quotePositionLocked()` / `quoteYieldAccrued()`, and send one small real message each way before opening to players: `init_position`, then `openPosition` of a minimal amount, `apply_locked`, `reportYield`, `apply_yield`; check LayerZero Scan (`layerzeroscan.com`) shows DELIVERED.
5. **Hand over** per `docs/mainnet-keys.md`: `tesoro_bridge.set_admin(<Squads vault>)` (moves `Store.admin` and the endpoint delegate in one call), program upgrade authority, and on EVM nothing further if the vault was deployed with the Safe as owner (otherwise `setDelegate` then `transferOwnership`). After this, any pathway change (including a new vault's `set_peer_config`) is a Squads proposal or Safe transaction. Finally set `NEXT_PUBLIC_WSTETH_VAULT` / `NEXT_PUBLIC_KHYPE_VAULT` so the app lists the vault.

### Endpoint ids and addresses

Source: LayerZero metadata API (`https://metadata.layerzero-api.com/v1/metadata` and `/v1/metadata/dvns`), read 2026-10-15, and cross-checked on chain (`endpoint.eid()`, `defaultSendLibrary`, `getUlnConfig`, `getExecutorConfig`; Solana through `getDefault*ConfigState`).

| | Ethereum | HyperEVM | Solana |
|---|---|---|---|
| eid | 30101 | 30367 | 30168 |
| EndpointV2 | `0x1a44076050125825900e736c501f859c50fE728c` | `0x3A73033C0b1407574C76BdBAc67f126f6b4a9AA9` | `76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6` |
| SendUln302 | `0xbB2Ea70C9E858123480642Cf96acbcCE1372dCe1` | `0xfd76d9CB0Bac839725aB79127E7411fe71b1e3CA` | `7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH` (send and receive) |
| ReceiveUln302 | `0xc02Ab410f0734EFa3F14628780e6e695156024C2` | `0x7cacBe439EaD55fa1c22790330b12835c6884a91` | same program |
| Default executor | `0x173272739Bd7Aa6e4e214714048a9fE699453059` | `0x41Bdb4aa4A63a5b2Efc531858d3118392B1A1C3d` | PDA `AwrbHeCyniXaQhiJZkLhgWdUCteeWSGaSN1sTfLiY7xK` |
| DVN: LayerZero Labs | `0x589dEDbD617e0CBcB916A9223F4d1300c294236b` | `0xc097ab8CD7b053326DFe9fB3E3a31a0CCe3B526f` | `4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb` |
| DVN: Nethermind | `0xa59BA433ac34D2927232918Ef5B2eaAfcF130BA5` | `0x8E49eF1DfAe17e547CA0E7526FfDA81FbaCA810A` | `GPjyWr8vCotGuFubDpTxDxy9Vj1ZeEN4F2dwRmFiaGab` |
| DVN: Canary (optional add) | `0xa4fE5A5B9A846458a70Cd0748228aED3bF65c2cd` | `0x83342EC538dF0460e730a8F543Fe63063e2D44C4` | `7jMeX5mzXnSSKYd8DxBDP4xMnkNFZZZm5W28FWUTbwU3` |
| DVN: Horizen (optional add) | `0x380275805876Ff19055EA900CDb2B46a94ecF20D` | `0xBB83Ecf372CbB6daa629ea9A9A53BEC6d601F229` | `HR9NQKK1ynW9NzgdM37dU5CBtqRHTukmbMKS7qkwSkHX` |

The list of production DVNs that exist on all three chains has 20 entries (the metadata `dvns` of `ethereum`, `hyperliquid` and `solana` intersected), among them LayerZero Labs, Nethermind, Canary, Horizen Labs, P2P, Luganodes, Nansen, Fidelity, Deutsche Telekom and USDT0.

### Configuration chosen

| Setting | Value | Why |
|---|---|---|
| Libraries | Pinned to SendUln302 / ReceiveUln302 (Solana: ULN program) on both sides, grace period 0 | Equal to today's defaults, but an explicit choice so a later change of the endpoint default cannot move the pathway. |
| Required DVNs | **LayerZero Labs + Nethermind**, 2 required, 0 optional, on both directions and all three chains | The ticket asks for LayerZero Labs plus one other production DVN available on all three chains. Nethermind is a long-running DVN and is in the default set on every one of the three chains. Testnet used the single LayerZero Labs default. |
| Confirmations Ethereum -> Solana | 15 (set on the Ethereum send config, mirrored on the Solana receive config) | LayerZero's default for 30101 -> 30168, read on both sides. |
| Confirmations Solana -> Ethereum | 32 (Solana send config, mirrored on the Ethereum receive config) | LayerZero's default, read on both sides. |
| Confirmations HyperEVM -> Solana | 1 (HyperEVM send, Solana receive) | LayerZero's default for 30367 (HyperEVM's consensus finalises per block; not independently checked). Raise with `--send-confirmations` if the founders want a margin. |
| Confirmations Solana -> HyperEVM | 32 | LayerZero's default. |
| Executor | The default executor of each chain, max message size 200 B (EVM send) and 10,000 B (Solana send) | Same as the defaults. Our largest message is 126 B (`PositionLocked`). |
| EVM -> Solana receive gas | Set by the vault per message: `solanaReceiveCu` = 200,000 compute units, native drop 0 (`PositionVaultOApp._options`) | Same as testnet. Observed use was about 57,000. The executor caps the native drop to Solana at 0, so rent is paid by `init_position` beforehand (see "Flow and who pays"). |
| Solana -> EVM receive gas | Enforced options in `PeerConfig`: type-3 `lzReceive` gas 250,000, value 0 (`--evm-receive-gas`) | Same as the testnet default in `bridge/scripts/lz.ts` (`0x0003010011010000000000000000000000000003d090` on the live devnet peers). |

**Trade-off to decide:** LayerZero's own defaults on all three mainnet pathways are 4 required DVNs (LayerZero Labs, Nethermind, Canary, Horizen), read on chain on 2026-10-15. Two required is faster and has fewer liveness dependencies, but a forged message needs only two DVNs to collude or be compromised instead of four. A message mints Gemas against a Position, so the founders should decide whether 2, 3 (`--dvns layerzero-labs,nethermind,canary`) or the default 4 fits. The script takes any subset of the four listed; the verify step checks exactly the set given.

### Dry run (placeholders: vault `0x1111...1111`, Safe `0x2222...2222`, delegate = the devnet deployer pubkey, mainnet program id assumed equal to the devnet id)

```
pnpm lz-mainnet --pathway ethereum --vault 0x1111111111111111111111111111111111111111 \
  --safe 0x2222222222222222222222222222222222222222 --delegate 7zr1j185zT8r6jcysC4LyrdSEJ13Up3xq4TFu6KQqh7M \
  --decimals 18 --rate-bps 300
```

```
MODE: DRY RUN (nothing is sent; --execute would send the Solana steps)
pathway   Ethereum (eid 30101) <-> Solana mainnet (eid 30168)
bridge    program 5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ  Store PDA 7WQLHW8EuyV1V8tWNh8DQGu7mVRgaHGgLU7fi8G91rVw  (0x60ae58df1215bf45cc054e633b49c92a3b1309f76075bac72b26e0c6e1c0c792)
DVNs      layerzero-labs + nethermind (all required, none optional)   confirmations: Ethereum->Solana 15, Solana->Ethereum 32

== SOLANA (signed by the delegate key until set_admin moves it to the multisig)
S1. tesoro_bridge init_store (once for the whole bridge, skip on the second pathway)
S2. tesoro_bridge set_peer_config eid 30101
    vault 0x1111...1111, decimals 18, rate 300 bps, enforced send options type-3 lzReceive gas 250000 (0x0003010011010000000000000000000000000003d090); also creates VaultTreasury 6gJxmie4naZykwGETsHkjtNNcVHW7PHHTMAw8qKRYMYV
S3. endpoint pathway init (nonce, send library, receive library) for eid 30101
S4. ULN config init for eid 30101
S5. pin send and receive library to ULN 302 for eid 30101
S6. executor, send ULN and receive ULN config for eid 30101
    executor AwrbHeCy... max message 10000 B; required DVNs layerzero-labs + nethermind (4VDjp6XQ..., GPjyWr8v...); send confirmations 32 (Solana -> Ethereum); receive confirmations 15 (Ethereum -> Solana)

== EVM (calls from the vault owner / delegate Safe; not sent by this script)
E1. vault setPeer(30168, Store PDA)
    cast send 0x1111...1111 "setPeer(uint32,bytes32)" "30168" "0x60ae58df...c792"
E2. endpoint setSendLibrary(vault, 30168, SendUln302)      0x1a44...E728c <- 0xbB2Ea70C...dCe1
E3. endpoint setReceiveLibrary(vault, 30168, ReceiveUln302, grace 0)   <- 0xc02Ab410...24C2
E4. endpoint setConfig on SendUln302: executor + send ULN
    executor 0x1732...3059 max 200 B; DVNs layerzero-labs + nethermind; confirmations 15 (Ethereum -> Solana)
E5. endpoint setConfig on ReceiveUln302: receive ULN
    DVNs layerzero-labs + nethermind; confirmations 32 (Solana -> Ethereum)
```

The real output also prints each Solana instruction (program, account count, data) and the full `cast send` line and calldata for every EVM call. The HyperEVM pathway is the same command with `--pathway hyperevm` (eid 30367, send confirmations 1, Solana-to-HyperEVM 32, `--rate-bps 500` for kHYPE as an example; the real rate comes from the APY ceiling work, ticket 11). Read-back against a vault that is not deployed reports `FAIL vault ... has code` and `FAIL Store ... exists`, which is the expected state before step 1.

### What the script does not do

- Create the Safes, deploy the vault or the bridge, hold any key, or send an EVM transaction.
- Set `rate_bps` or `decimals` for you: both are required arguments (18 decimals for wstETH and kHYPE).
- Check that a Safe exists on HyperEVM mainnet (open item in `docs/mainnet-keys.md`).

# Cross-chain: Ethereum Positions on the Solana ledger (LayerZero V2)

Testnets only (Solana devnet, Ethereum Hoodi; HyperEVM prepared). SimLST yield is SIMULATED ("Simulated yield · 1 month = 10 min", per Position, linear on its Principal). Decision: ADR 0002. Spike background: `docs/spikes/S2-S3.md`.

## Pieces

| Piece | Where | Role |
|---|---|---|
| `PositionVaultOApp` | `contracts/src/PositionVaultOApp.sol` | `PositionVault` as a LayerZero OApp. `openPosition` sends `PositionLocked`, `reportYield` sends `YieldAccrued`; `_lzReceive` feeds `Unlock` and `PayYield` into the vault's `_receive` |
| `tesoro_bridge` | `bridge/` (own Anchor workspace, program `5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ`) | Solana OApp. Inbox for inbound facts, permissionless CPIs into `tesoro_core`, permissionless outbound sends |
| `SourceAuthority` | `tesoro_core` (additive) | Per source chain, the signer allowed to report `PositionLocked` / `YieldAccrued`. The bridge PDA `["authority"]` is registered for Ethereum and HyperEVM |

Wire format (identical in Solidity and Rust, `abi.encodePacked`, big-endian): header `msgType u8 | sourceChain u32 (eid) | positionId bytes32 | seq u64` (45 bytes), then `1 PositionLocked`: `owner bytes32 | lst bytes32 | principalUnderlying u128 | horizon u8` (126 bytes); `2 YieldAccrued`: `cumulative u128 | treasuryBalance u128` (77; the second field is what the vault Treasury can pay now, it falls with Instant Redeems and withdrawals, ADR 0010); `6 InstantRefund` (EVM to Solana): `refusedSeq u64 | amount u128` (69); `3 Unlock`: `0 u128` (61); `4 PayYield`: `to bytes32 | amount u128` (93); `5 PayInstant`: `to bytes32 | amount u128` (93, Instant Redeem payout from the vault treasury). `positionId` = vault address (20 bytes) | vault position id (u64) | 4 zero bytes, so two vaults on one chain never collide and a vault can only speak for its own Positions (the bridge checks the id against the LayerZero sender).

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

**EVM vault** (ADR 0010, computed never cranked): a Position's Accrued Yield is `Principal x (growth since open - 1)` minus the Yield Fee (`feeBps` fixed per Position at open, default 2000, cap 5000, admin setter for new Positions). SimLST: growth = `1 + apyBps x elapsed x speedup / year` with `apyBps`/`speedup` read at open; the SimLST rate stays flat and shares are minted only when a payout needs them (PayYield, PayInstant, `withdrawTreasury`). Real LST: gross = held shares x rate + paid out - Principal, so shares already paid out stop earning; the Treasury claim uses the same share totals (O(1)). The Treasury is a running claim computed from vault totals (`treasuryBalance()` = open Positions' fees + realised fees at Unlock + funding and refills - withdrawals - Instant payouts); `withdrawTreasury(amount, to)` is owner-only. `reportYield(id)` is permissionless and sends `YieldAccrued(cumulative, treasuryBalance)` at that block. `MSG_PAY_INSTANT` pays the holder from the Treasury; one the Treasury cannot cover is recorded (`refusedInstant[id][seq]`, event `InstantRefused`, no revert) and anyone calls `refundInstant(id, seq)` to send `InstantRefund(refusedSeq, amount)`, which Solana must answer by refunding the Gemas once per (id, refusedSeq). A `PayYield` whose `to == address(this)` books into the Treasury (the refill). New vaults come from `script/deploy-oapp.sh`, then `SimLST.setMinter(newVault)`; the constructor is unchanged. Older vaults are abandoned.

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

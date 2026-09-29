# Cross-chain: Ethereum Positions on the Solana ledger (LayerZero V2)

Testnets only (Solana devnet, Ethereum Hoodi; HyperEVM prepared). SimLST yield is SIMULATED ("Simulated yield · 1 month = 10 min"). Decision: ADR 0002. Spike background: `docs/spikes/S2-S3.md`.

## Pieces

| Piece | Where | Role |
|---|---|---|
| `PositionVaultOApp` | `contracts/src/PositionVaultOApp.sol` | `PositionVault` as a LayerZero OApp. `openPosition` sends `PositionLocked`, `reportYield` sends `YieldAccrued`; `_lzReceive` feeds `Unlock` and `PayYield` into the vault's `_receive` |
| `tesoro_bridge` | `bridge/` (own Anchor workspace, program `5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ`) | Solana OApp. Inbox for inbound facts, permissionless CPIs into `tesoro_core`, permissionless outbound sends |
| `SourceAuthority` | `tesoro_core` (additive) | Per source chain, the signer allowed to report `PositionLocked` / `YieldAccrued`. The bridge PDA `["authority"]` is registered for Ethereum and HyperEVM |

Wire format (identical in Solidity and Rust, `abi.encodePacked`, big-endian): header `msgType u8 | sourceChain u32 (eid) | positionId bytes32 | seq u64` (45 bytes), then `1 PositionLocked`: `owner bytes32 | lst bytes32 | principalUnderlying u128 | horizon u8` (126 bytes); `2 YieldAccrued`: `cumulative u128` (61); `3 Unlock`: `0 u128` (61); `4 PayYield`: `to bytes32 | amount u128` (93). `positionId` = vault address (20 bytes) | vault position id (u64) | 4 zero bytes, so two vaults on one chain never collide and a vault can only speak for its own Positions (the bridge checks the id against the LayerZero sender).

## Flow and who pays

1. **App, once per user:** `create_account(evm_address)` in `tesoro_core` (or `set_evm_address`), then link the address: the EVM wallet signs (EIP-191 `personal_sign`) the text `Tesoro: link EVM address to Account <TesoroAccount PDA>` and the Solana wallet calls `tesoro_bridge::link_evm(evm_address, signature)`. The bridge recovers the signer on chain (`secp256k1_recover`), so nobody can claim someone else's address and receive their Positions or payouts. Inbound Positions and outbound payouts resolve the Account through the `EvmLink` PDA `["evm", address]`.
2. **Before `openPosition`:** anyone creates the inbox record with `init_position(eid, positionId)` (about 0.003 SOL). It has to exist before the message: the default executors on Hoodi and HyperEVM cap the native drop to Solana at 0, so rent cannot be paid inside `lz_receive`. The app reads `vault.nextPositionId()` and creates the record for `next + 1` (a keeper can pre-create a few ahead). If the record is missing `lz_receive` fails and stays retryable.
3. **`openPosition(lstAmount, months)` on the vault** (approve the LST first). **The caller pays the LayerZero fee** in the chain's native token: read `quotePositionLocked()` and send it plus about 20% as `msg.value` (excess refunded to the caller). About 0.0001 ETH on Hoodi. Delivery to Solana took about 2 minutes.
4. **`apply_locked(eid, positionId)`** (permissionless, payer funds rent): the bridge CPIs `tesoro_core::open_position_from_source`, signed by its PDA, for the Account linked to the owner's EVM address. `PeerConfig` (per vault, admin-set) supplies `decimals` and `rate_bps`. Principal is the vault's `principalUnderlying` in wei (must fit `u64`, so up to about 18 ETH; larger is refused, not truncated).
5. **Advance:** unchanged oracle path (`take_advance`, oracle price plus owner signature).
6. **`reportYield(id)`** on the vault (anyone, the caller pays the fee; `quoteYieldAccrued()`), then **`apply_yield(eid, positionId)`** on Solana (permissionless; pass the Position's open Source account when it has one). Debt falls automatically.
7. **Redeem ETH-Sourced Gemas:** the holder calls `tesoro_bridge::redeem_to_evm(gemas)` instead of `tesoro_core::redeem` (it CPIs `redeem` and records the units in a `Claim` PDA). Calling `redeem` directly for a non-Solana Source burns the Gemas without recording a payout. Then anyone calls `send_pay_yield(eid, positionId)`: it sends `PayYield(to = holder Account's EVM address, amount = units not yet sent)` and advances `claim.units_sent` in the same transaction, so a unit is paid once. The vault pays the LST shares worth that amount and refuses more than accrued yield.
8. **Unlock:** when Debt is zero the owner calls `tesoro_core::unlock`, then anyone calls `send_unlock(eid, positionId)` (guarded by `unlock_sent` and the out seq). The vault releases Principal to the EVM owner; yield owed to redeemers stays in the vault. Solana sends are paid by the caller in SOL (about 0.0003 SOL); delivery to Hoodi took about 4 to 5 minutes.

The inbox is deliberate: `lz_receive` only records the fact (no CPI), because its account list is derived from the message alone and cannot include the Account, the open Source or rent-funded accounts. Applying is a second, permissionless transaction the app or keeper sends right after delivery (poll LayerZero Scan, then call `apply_locked` / `apply_yield`).

Replays and reordering: `Endpoint::clear` burns the nonce; `PositionLocked` applies once (`locked_seq`), `YieldAccrued` keeps the highest seq (`last_yield_seq`), `tesoro_core` is idempotent by seq. On the vault, seq must strictly increase, so an `Unlock` (seq n) delivered after a later `PayYield` (seq n+1) would be ignored; send them minutes apart, never both in one block.

## `tesoro_core` changes (additive)

New `SourceAuthority` PDA (`["source_auth", chain_byte]`, `chain`, `authority`) and instructions `set_source_authority(chain, authority)` / `remove_source_authority(chain)` (admin), `open_position_from_source(...)` and `apply_yield_from_source(seq, cumulative)`: the same bodies as `open_position` / `apply_yield` but signed by the registered authority of the Position's chain (an Ethereum authority cannot touch a HyperEVM Position). `oracle_authority` and every existing instruction, account layout and signature are unchanged; the oracle still supplies the issuance price in `take_advance`. Tests: `programs/tesoro_core/tests/source_authority.rs`.

## Proven on testnets (2026-09-30)

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

## Driving it (scripts)

- `bridge/scripts/flow.ts` (`pnpm flow <cmd>` in `bridge/`, `SOLANA_RPC=https://rpc.magicblock.app/devnet`): `create-account`, `link-message`, `link`, `init-position`, `state`, `apply-locked`, `advance`, `apply-yield`, `unlock`, `send-unlock`, `redeem`, `send-pay-yield`. Owner key `~/.config/tesoro/bridge-demo-owner.json`, oracle `~/.config/tesoro/oracle.json`, payer `~/.config/solana/id.json`.
- `bridge/scripts/lz.ts`: `init`, `wire <eid> <vault> <decimals> <rateBps>` (PeerConfig + endpoint pathway), `quote`, `defaults`, `config`, `set-uln`. `bridge/scripts/scan.sh <txHash>` polls LayerZero Scan. `bridge/scripts/upload.ts`: paced buffer upload.
- `contracts/script/deploy-oapp.sh`, `contracts/script/oapp.sh` (peer, quotes, faucet, approve, open, report, position, sign).

## HyperEVM (eid 40362): prepared, not deployed (no HYPE)

The pathway is wired on Solana (endpoint nonce, libraries and ULN config for 40362 exist from the spike and this run). To finish once the deployer has HYPE (about 0.1 is ample; `PositionVaultOApp` deploys for about 2.5M gas, under the 3M small-block limit): deploy SimLST with `script/Deploy.s.sol` (its MockEndpoint and plain vault are unused), then `contracts/script/deploy-oapp.sh hyperevm sim <SimLST>`; `script/oapp.sh hyperevm <vault> peer 0x60ae58df1215bf45cc054e633b49c92a3b1309f76075bac72b26e0c6e1c0c792`; then `pnpm lz wire 40362 <vault> 18 500` in `bridge/`. A PeerConfig for 40362 was registered by mistake for `0x8289...87b7c` (the Hoodi vault address); it is inert unless that address is deployed by the same deployer on HyperEVM. Fees there are about 0.0074 HYPE per send. Delivery on 40362 remains the unproven risk.

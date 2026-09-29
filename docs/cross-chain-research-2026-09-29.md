# Tesoro cross-chain transport and testnet staking-asset research

Date: 2026-09-29. Verified by pulling live data (LayerZero metadata API, Chainlink lanes API, Wormhole SDK source + Wormholescan testnet API, Hyperlane registry, RPC calls to Hoodi / Solana devnet / HyperEVM testnet). Items marked UNVERIFIED could not be confirmed.

## 1. Support matrix (testnet, today)

| | Solana devnet | Ethereum Sepolia | Ethereum Hoodi | HyperEVM testnet (998) | Auto-relay on all legs? |
|---|---|---|---|---|---|
| LayerZero V2 | YES (eid 40168) | YES (40161) | YES (40449) | YES (40362) | YES: executor + LayerZero Labs DVN listed on all four |
| Wormhole | YES (core 3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5) | YES (id 10002) | NO (SDK has Sepolia + Holesky only) | Core YES (id 47), Executor NO | NO: HyperEVM testnet has no Executor, must self-relay |
| Chainlink CCIP | YES | YES | Hoodi has lanes only to Sepolia/Monad/Sei, none to Solana or HyperEVM | YES | Yes, CCIP is fully managed; Solana lanes force out-of-order |
| Hyperlane | YES (`solanadevnet`, domain 1399811151) | YES (`sepolia`) | NO (no `hoodi` in registry) | YES (`hyperliquidevmtestnet`, domain 998) | UNVERIFIED (relayer/validator liveness on these testnet pairs not checked) |

Disqualification check: LayerZero V2 and CCIP reach Solana devnet + an Ethereum testnet + HyperEVM testnet. Wormhole reaches all three but needs a self-relayer for HyperEVM. Hyperlane has the chain configs but liveness is unverified.

## 2. LayerZero V2 (primary)

### Addresses (source: https://metadata.layerzero-api.com/v1/metadata/deployments, the JSON behind https://docs.layerzero.network/v2/deployments/deployed-contracts)

| Chain | eid | EndpointV2 | Executor | SendUln302 / ReceiveUln302 | LZ Labs DVN |
|---|---|---|---|---|---|
| Solana devnet (metadata key `solana-testnet`, nativeChainId 103) | 40168 | 76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6 | 6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn (PDA AwrbHeCyniXaQhiJZkLhgWdUCteeWSGaSN1sTfLiY7xK) | ULN 7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH (one program for both) | HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW (LZ Labs id in dvns list: 4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb; the two differ in the metadata, confirm via `lz:oapp:config:get:default`) |
| Sepolia (11155111) | 40161 | 0x6edce65403992e310a62460808c4b910d972f10f | 0x718b92b5cb0a5552039b593faf724d182a881eda | Send 0xcc1ae8cf5d3904cef3360a9532b477529b177cce, Recv 0xdaf00f5ee2158dd58e0d3857851c432e34a3a851 | 0x8eebf8b423b73bfca51a1db4b7354aa0bfca9193 |
| Hoodi (560048) | 40449 | 0x3acaaf60502791d199a5a5f0b173d78229ebfe32 | 0x701f3927871efcea1235db722f9e608ae120d243 | Send 0x45841dd1ca50265da7614fc43a361e526c0e6160, Recv 0xd682ecf100f6f4284138aa925348633b0611ae21 | 0xa78a78a13074ed93ad447a26ec57121f29e8fec2 |
| HyperEVM testnet (998) | 40362 | 0xf9e1815f151024bde4b7c10bac10e8ba9f6b53e1 | 0x72e34f44eb09058bddaf1aeeebdec062f1844b00 | Send 0x43e505ba192aac7babdc1a796c87844171011684, Recv 0x012f6eae2a0bf5916f48b5f37c62bcfb7c1ffda1 | 0x91e698871030d0e1b6c9268c20bb57e2720618dd |

Liveness evidence: LayerZero Scan testnet API (https://scan-testnet.layerzero-api.com/v1/messages/latest) showed Sepolia(40161) -> Solana devnet(40168) messages DELIVERED on 2026-09-29 (multiple within the hour). HyperEVM (40362) traffic was not found in the sample: UNVERIFIED that executor is actively delivering on 40362, and the default pathway config for Solana<->HyperEVM is UNVERIFIED (you will wire explicitly with LZ Labs DVN, which exists on both).

### Solana integration
- Reference: https://github.com/LayerZero-Labs/devtools/tree/main/examples/oapp-solana (README verified; string-passing OApp, Solana devnet <-> EVM testnets; repo pushed 2026-07-21). Docs: https://docs.layerzero.network/v2/developers/solana/oapp/overview. Also `docs/ordered-execution-part-1/2` in the example dir.
- Requirements from the example README: Rust 1.84.1, Anchor 0.31.1, Solana CLI 2.2.20, Docker (verifiable build). Anchor 0.31.1 is a hard pin: check compatibility with Tesoro's main program; put the OApp in its own program or CPI-compose.
- Model: OApp Store PDA (this, not program id, is the peer address), Peer PDA per src eid (emitter authentication), LzReceiveTypes PDA. Docs describe `lz_receive_types_info` / `lz_receive_types_v2` (ALT-based account discovery), and executor prepends `pre_execute` and appends `post_execute`. Must call `Endpoint::clear` first (burns nonce = replay protection).
- Pitfalls: all accounts for lz_receive must be listed up front (your Match/Debt/Position PDAs must be derivable from the message payload); tx limit 1232 bytes so use ALTs; `init-config` needed per peer (SendConfig/ReceiveConfig accounts); executor pays rent for accounts created in lz_receive only if you set the `value` option; programs must be deployed with priority fees on devnet; devnet SOL for program deploy (~5 SOL suggested by README).
- Ordering: LayerZero nonces are per pathway; ordered execution is opt-in via an ordered-execution option and nonce checks in the OApp (see the docs above). Recoverability: failed/stuck messages can be retried (`lzReceive` permissionless), skipped, nilified or burned via Endpoint.
- Not verified in detail: exact CU for lz_receive; default executor gas on Solana testnet.

### EVM side
Standard `OApp` / `OAppReceiver` Solidity (create-lz-oapp scaffold). Peers set via `setPeer(eid, bytes32)`; `_lzReceive` is only callable by endpoint and origin sender checked against peer (emitter authentication). Roughly a day of work incl. options encoding. HyperEVM: contracts over the small-block gas limit (3M) need big blocks (30M) via `{"type":"evmUserModify","usingBigBlocks":true}` (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture).

### Fees / latency
Testnet fees paid in native token (SOL / ETH / HYPE) via `quote()`. Typical testnet delivery is minutes (DVN confirmations on Sepolia dominate). Exact HyperEVM/Hoodi latency UNVERIFIED.

## 3. Wormhole

- Chain IDs (https://github.com/wormhole-foundation/wormhole-sdk-ts, `core/base/src/constants/chains.ts`): Solana 1, HyperEVM 47 (same id on testnet network), Sepolia 10002, Holesky 10006. No Hoodi. So Ethereum leg must use Sepolia.
- Testnet core contracts (SDK `constants/contracts/core.ts`): Solana devnet 3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5; Sepolia 0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78; HyperEVM 0xBB73cB66C26740F31d1FabDC6b7A46a038A300dd. Also on https://wormhole.com/docs/reference/contract-addresses/.
- Guardians do attest HyperEVM testnet: Wormholescan testnet API returned VAAs for emitter chain 47 (40 messages total, latest 2026-09-02), so it is alive but low traffic. (https://api.testnet.wormholescan.io/api/v1/vaas/47)
- Executor (the current relaying model; standard relayer being migrated, https://wormhole.com/docs/protocol/infrastructure/relayers/executor-framework/): SDK executor.ts testnet list has Solana (execXUrAsMnqMmTHj5m7N1YQgsDz3cwGLYCYyuDRciV) and Sepolia (0xD0fb39f5a3361F21457653cB70F9D0C9bD86B66B) but NOT HyperEVM (HyperEVM is only in the mainnet list). Executor quoter on testnet: Sepolia, Solana, few L2 Sepolias; no HyperEVM. => any leg touching HyperEVM testnet needs our own relayer script (fetch VAA from Wormholescan, submit). Trivial for ~3 message types but is code we own.
- Solana integration: legacy `post_message` (rent account per message) or the newer emission shim (https://wormhole.com/docs/products/messaging/guides/solana-shims/sol-emission/, mainnet shim id EtZMZM22ViKMo4r5y4Anovs3wKQ2owUmDpjygnMMcdEX; testnet shim address and testnet guardian observation of it UNVERIFIED, so use legacy post_message). Receive on Solana: `verify_signatures` + `post_vaa` (PostedVAA account keyed by hash = replay protection, but you still need your own consumed/sequence tracking for ordering), multiple txs; wormholelabs-xyz/executor-helpers `svm/post-vaa-relay` (pushed 2026-09-25) tries single-tx flow but docs thin.
- Examples are stale: wormhole-scaffolding hello_world (Anchor, pushed 2026-02-18); `wormhole-anchor-sdk` repo wormhole-foundation/wormhole-solana-anchor no longer resolves (404), so UNVERIFIED current SDK status.
- Ordering: none built in; VAAs carry a per-emitter sequence, you enforce it in the receiver (Solana) or contract (EVM).
- Finality: consistency levels; Solana finalized ~13 s, Sepolia finalized ~13+ min (use instant/safe on testnet).

## 4. Chainlink CCIP (surprise: reaches all three, via Sepolia only)

From the docs lanes API (https://docs.chain.link/api/ccip/v1/lanes?environment=testnet, 429 testnet lanes):
- Sepolia <-> Solana devnet: OK both directions (v1.6.0).
- Sepolia <-> HyperEVM testnet: OK both directions (v2.0.0, tokens: CCIP-BnM).
- HyperEVM testnet <-> Solana devnet: OK both directions (v1.6.0).
- Hoodi: lanes only to Sepolia, Monad Testnet, Sei Testnet. No Solana/HyperEVM.
- Routers: Sepolia 0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59 (selector 16015286601757825753); HyperEVM testnet 0xC1bfda59F0D6dD9f7D0A24c5a7AAfED3945A8ed6 (selector 4286062357653186312); Solana devnet router Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C (selector 16423721717087811551). (Directory pages: https://docs.chain.link/ccip/directory/testnet/chain/ethereum-testnet-sepolia, .../hyperliquid-testnet, .../solana-devnet.)
- Solana receiver: program implementing `ccip_receive` (Anchor name must be exactly that), account list passed in SVMExtraArgs (max 64 accounts), compute_units field; tutorial https://docs.chain.link/ccip/tutorials/svm/destination/arbitrary-messaging (EVM Sepolia -> Solana devnet data-only message).
- Big caveat: `allowOutOfOrderExecution` MUST be true for any lane where Solana is source or destination (lanes API shows `enforceOutOfOrder: true` on Solana onramp). So no ordered delivery; sequencing must be app-level. Replay protection is native (message id, executed once). Manual execution exists for stuck messages.
- Fees payable in LINK or native. Testnet finality/latency: EVM-source messages wait for finality (Sepolia ~15-20+ min typical; UNVERIFIED).
- Docs pages for SVM service limits (data length) could not be fetched: https://docs.chain.link/ccip/service-limits/svm (UNVERIFIED size limits).

## 5. Hyperlane (short)
Registry (https://github.com/hyperlane-xyz/hyperlane-registry) has `solanadevnet` (mailbox 5yM5YrrzHCrp4ZPLKN9Y2eUAqEWsTbBqaorgbngQcR54, domain 1399811151), `sepolia` (mailbox 0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766), `hyperliquidevmtestnet` (mailbox 0x589C201a07c26b4725A4A829d772f24423da480B, domain 998). No Hoodi. Note there is also a separate `solanatestnet` chain (Solana's testnet cluster, not devnet): use `solanadevnet`. Relayer and validator liveness for these pairs, and Sealevel recipient tooling maturity for arbitrary messages: UNVERIFIED. Not recommended at 12 days without confirmation.

## 6. Effort estimate (experienced dev + AI agents)

LayerZero V2, three message types, three chains: about 5-7 focused days.
- Day 1-2: scaffold oapp-solana, deploy Solana OApp + EVM OApps (Sepolia or Hoodi, HyperEVM), wire, get "hello" both ways.
- Day 2-4: replace string payload with typed messages (Position locked / Debt zero / Yield pay), Solana lz_receive account resolution to real Position/Match/Debt PDAs, EVM receiver actions (unlock, transfer yield).
- Day 4-6: ordered/retry handling, e2e tests, monitoring, per-pathway config for Solana<->HyperEVM.
Wormhole: 7-9 days (custom post_vaa flow on Solana, self-relayer for HyperEVM, sequence tracking). CCIP: 5-7 days but Sepolia-only and app-level ordering.

Top risks: (1) Anchor 0.31.1 / toolchain pin conflicts with main program; (2) Solana lz_receive account-list mistakes and ALT sizing; (3) HyperEVM testnet executor liveness/default pathway config unverified, plus big-block deploy quirk and 1 HYPE/day faucet; (4) devnet SOL for program deploys; (5) testnet congestion/rate limits; (6) DVN/executor delays on a low-traffic pathway.

## 7. Staking assets

### Ethereum: Lido on Hoodi (primary)
- Hoodi is the active Lido testnet (v4.0.1, chain id 560048): https://docs.lido.fi/deployed-contracts/hoodi/ (source md: lidofinance/docs `docs/deployed-contracts/hoodi.md`).
- stETH (proxy) 0x3508A952176b3c15387C97BE809eaffB1982176a; wstETH 0x7E99eE3C66636DE415D2d7C880938F2f40f94De4; Withdrawal Queue 0xfe56573178f1bcdf53F01A6E9977670dcBBD9186; AccountingOracle 0xcb883B1bD0a41512b42D2dB267F2A2cd919FB216; Lido Locator 0xe2EF9536DAAAEBFf5b1c130957AB3E80056b06D8. Docs note the previous "V3 testnet-2" deployment is deprecated, use these.
- Obtaining: `isStakingPaused()` = false and `getCurrentStakeLimit()` = 3000 ETH (my RPC calls today), so anyone can `submit()` Hoodi ETH to the stETH contract; wrap to wstETH via the wstETH contract. Hoodi ETH from https://faucet.hoodi.ethpandaops.io/ or https://hoodi-faucet.pk910.de/ (https://hoodi.ethpandaops.io/). No faucet for stETH itself found.
- Rate moves: YES. Decoded TokenRebased events on stETH: rebase every 86400 s at blocks 3699861, 3706203, 3712602, 3718864 (last ~6 h before check); each about +0.0053% (about 1.93-1.99% APR). wstETH.stEthPerToken() = 1.03206 today. Oracle keeps reporting daily.
- Sepolia: Lido deployment exists (stETH 0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af, wstETH 0xB82381A3fBD3FaFA77B3a7bE693342618240067b) but docs say fully deprecated (https://docs.lido.fi/deployed-contracts/sepolia/). Not usable for a moving rate.
- Consequence: choose Hoodi for the Ethereum leg if using Lido. That rules out Wormhole and CCIP (no Hoodi lanes to Solana/HyperEVM) and leaves LayerZero (Hoodi eid 40449 supported). With CCIP/Wormhole you would be on Sepolia and need a simulated LST.

### HyperEVM testnet
- No HYPE LST found on testnet. Kinetiq docs list mainnet only (https://kinetiq.xyz/docs/contracts-and-audits). No Valantis stHYPE or Hyperbeat testnet deployments found in search. A StakingRewards page lists an "stHYPE-TESTNET" asset with no data/contract (UNVERIFIED, probably a placeholder). Absence is not proven; treat as none. Plan: deploy a simulated LST (ERC-4626-style with an exchange-rate you can bump) on HyperEVM testnet.
- Testnet HYPE: Chainstack faucet, 1 HYPE per 24 h, needs Chainstack account + API key, no mainnet balance requirement (https://chainstack.com/hyperliquid-faucet/). chain id 998 confirmed via https://rpc.hyperliquid-testnet.xyz/evm.

### Solana devnet
- Jito devnet stake pool (SPL stake pool fork, current): program DPoo15wWDqpPJJtS2MUZ49aRxqz5ZaaJCJP4z8bLuib, pool JitoY5pcAxWX6iyP2QdFwTznGb8A99PRCUCVVxB46WZ, mint J1tos8mqbhdGcF3pgj4PCKyVjzWSURcpLZU7pPGHxSYi (addresses from Jito docs via search snippet https://www.jito.network/docs/jitosol/jitosol-liquid-staking/security/deployed-programs/, page itself returned 403 to me). I verified on devnet RPC: pool account exists, owner = that program, total_lamports 451,747,057,915, pool token supply 449,825,216,177 (rate 1.004272), last_update_epoch 1170 = current epoch. So a live pool with a non-trivial rate. Whether the rate rises every epoch and whether SOL deposits are permissionless: UNVERIFIED (my quick parse suggested no sol_deposit_authority, not trusted). Test with `spl-stake-pool deposit-sol`.
- The old SPL stake pool program SPoo1Ku8...NakuHy on devnet is stale (v0.6.4, not upgradable per the Jito doc); many test pools exist under it (getProgramAccounts returned many). Marinade program MarBmsSg... exists on devnet; state/rate UNVERIFIED. Sanctum devnet: UNVERIFIED (docs.sanctum.so returned 522).
- Fallback: create your own SPL stake pool on devnet (`spl-stake-pool create-pool`) and `update` it; rate moves only with real stake rewards, so for a demo simulate a rate in the Tesoro program.

## 8. Recommendation

Use LayerZero V2 for all three message types.
Reasons: only candidate that (a) supports Hoodi (needed for Lido, the one real Ethereum LST with a moving rate), (b) has an executor and LZ Labs DVN on Solana devnet, Hoodi/Sepolia and HyperEVM testnet, (c) has a maintained Solana OApp example (devtools, pushed 2026-07-21), (d) offers native ordered execution and retry/skip/nilify recovery, and (e) shows live Sepolia -> Solana devnet deliveries today.

Ethereum leg: Hoodi (Lido stETH/wstETH, daily rebase confirmed). HyperEVM leg: HyperEVM testnet with a simulated LST. Solana leg: devnet with Jito devnet pool if its rate cooperates, else simulated.

Fallbacks:
- If LayerZero HyperEVM<->Solana delivery does not work by ~day 4 (UNVERIFIED executor liveness there): route Solana <-> HyperEVM over CCIP (lane exists both ways) or Wormhole with a self-relay script for the HyperEVM leg. Wormhole self-relay is the most deterministic since guardians on chain 47 are confirmed live and we control delivery.
- If Hoodi wiring fails: use Sepolia for the Ethereum leg (LZ 40161 has confirmed live delivery to Solana devnet) with a simulated stETH.
- CCIP is a viable single-transport alternative only on Sepolia and only with app-level sequencing (Solana lanes force out-of-order).
- Whatever transport: keep a sequence number and Position id in every payload, make handlers idempotent, and treat the Solana program as the source of truth.

## Key sources
- https://metadata.layerzero-api.com/v1/metadata/deployments ; https://docs.layerzero.network/v2/deployments/deployed-contracts
- https://github.com/LayerZero-Labs/devtools/tree/main/examples/oapp-solana ; https://docs.layerzero.network/v2/developers/solana/oapp/overview
- https://scan-testnet.layerzero-api.com/v1/messages/latest
- https://github.com/wormhole-foundation/wormhole-sdk-ts (core/base/src/constants/{chains.ts,contracts/core.ts,contracts/executor.ts,contracts/executorQuoter.ts})
- https://api.testnet.wormholescan.io/api/v1/vaas/47
- https://wormhole.com/docs/products/messaging/guides/solana-shims/sol-emission/ ; https://wormhole.com/docs/products/messaging/reference/core-contract-solana/
- https://docs.chain.link/api/ccip/v1/lanes?environment=testnet ; https://docs.chain.link/ccip/directory/testnet
- https://github.com/hyperlane-xyz/hyperlane-registry
- https://docs.lido.fi/deployed-contracts/hoodi/ ; https://docs.lido.fi/deployed-contracts/sepolia/
- https://hoodi.ethpandaops.io/ ; https://chainstack.com/hyperliquid-faucet/
- https://kinetiq.xyz/docs/contracts-and-audits
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture

# Ethereum Positions (Hoodi) in the web app

Wallet: **Ethereum Positions · Hoodi** card, ETH Position cards, and one cross-chain tracker per operation in flight. SIMULATED: simETH is a test token (SimLST) whose yield runs 1 month = 10 min. The flow and its LayerZero facts are in `docs/cross-chain.md`; this file is the app side.

## Files

| Piece | File |
|---|---|
| Bridge PDAs, instruction encoders, Solana + Hoodi readers, Advance / Unlock Estimate math | `src/lib/chain/eth.ts` (tests: `eth.test.ts`) |
| Wallet actions: link, gas, faucet, approve + `openPosition`, `reportYield`, Advance, `redeem_to_evm`, Unlock | `src/lib/chain/eth-flow.ts` |
| Tracker stages from chain state (pure), LayerZero Scan status, persisted operations | `src/lib/chain/eth-track.ts` |
| UI: card, open sheet, trackers, Position card | `src/app/wallet/EthPositions.tsx` |
| Server relay (keys, LayerZero SDK): `POST /api/eth-bridge` | `src/server/eth-bridge.ts`, `src/app/api/eth-bridge/route.ts` |
| EVM wallet (`useAuth().evm`) | `src/lib/auth/AccountProvider.tsx` (Privy), `DevAccountProvider.tsx` (dev key) |

## The EVM wallet

`useAuth().evm` is a viem `WalletClient` for the Account's EVM address: the Privy embedded wallet (or a linked external wallet when there is none), switched to Hoodi before each transaction. With `NEXT_PUBLIC_DEV_WALLET=1` (never in production; the branch is compiled out) a second local key, `tesoro-dev-evm:<name>` in localStorage, stands in beside the dev Solana key. The Privy path type-checks and builds but was not exercised here (no inbox); it needs the Hoodi chain configured in the Privy dashboard (see `accounts.md`).

## First ETH action: link

`ensureEvmLinked` creates the Account if needed, then one Solana transaction: `tesoro_core::set_evm_address` (if the Account's stored address differs) + `tesoro_bridge::link_evm(evm, signature)` where the EVM wallet signed `Tesoro: link EVM address to Account <Account PDA>` (EIP-191). The bridge recovers the signer on chain. The Account sheet shows the address and whether it is linked.

## What the server does (`/api/eth-bridge`)

Requests are authenticated like the SOL top-up: the Solana wallet signs `tesoro-eth|<step>|<address>|<ts>` (5 minute window) and, with Privy configured, a Privy access token is required. Keys are read from disk inside `src/server/eth-bridge.ts` and never reach the client.

| Step | What | Paid by | Cap |
|---|---|---|---|
| `fund-evm` | Hoodi ETH top-up (0.006 ETH when the wallet has under 0.004) from the relayer key `~/.config/tesoro/relayer-evm.env` (override `TESORO_RELAYER_EVM_ENV`) | Relayer | 0.02 ETH per EVM address and per Account per 24 h, 0.3 ETH total per 24 h; refuses if the relayer would drop under 0.01 ETH |
| `init-position` | inbox record for the vault position id, before `openPosition` | Relayer (about 0.003 SOL) | relay cap below |
| `apply-locked`, `apply-yield`, `send-unlock`, `send-pay-yield` | the permissionless bridge steps; each is simulated first and skipped when a keeper already did it | Relayer (`~/.config/tesoro/relayer.json`, `TESORO_RELAYER_KEYPAIR`) | 60 per Account, 600 total per 24 h |
| `advance` | `take_advance` signed by the oracle at the ETH price (Coinbase ETH-USD spot, a devnet price feed; refused while no live price is available), returned for the Account to co-sign; only for the Position's owner, only with no open Advance | Oracle | 10 per Account per 24 h |

`GET /api/eth-bridge` returns the Advance price for the open form. Limits are in memory, per server process.

## Trackers

`CrossChainProgress` takes custom `steps`. Every tracker reads its stage from chain state (never a timer), so pending never shows success early and a reload continues where it was (operations persist in localStorage per Solana address).

| Operation | Steps | Driven by |
|---|---|---|
| Open | Hoodi confirmed, LayerZero delivered, Position opened (`apply_locked`), Advance taken, Gemas available | the app calls `apply-locked` once the inbox shows the message, then the Advance |
| Report yield | Hoodi confirmed, LayerZero delivered, Debt updated (`apply_yield`) | the app calls `apply-yield` |
| Redeem | Redeemed on Solana (`redeem_to_evm`), LayerZero message sent (`send_pay_yield`), simETH on Hoodi | the app calls `send-pay-yield` for the redeemed Source; done when `YieldPaid` events to the holder's EVM address cover the redemption |
| Unlock | Unlocked on Solana, message sent (`send_unlock`), Principal on Hoodi | the app calls `send-unlock`; done when the vault position is `unlocked` |

Each card shows the Hoodi tx, LayerZero Scan link and the Scan status.

## Not done

- The real-Lido wstETH vault (`0x214A...8DeD`) is not listed: there is no wstETH faucet. Add it as a second entry in `ETH_VAULTS` once a funded wstETH source exists.
- Won ETH-Sourced Gemas redeem through the Wallet Redeem sheet (the same `redeem_to_evm`); only the own-Position path was driven end to end.

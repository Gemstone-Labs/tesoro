# Funding an Account (Simulated · native Positions)

**Default path: a real Solana-native Position.** On the Wallet: "Get test simSOL" (the sim_lst faucet, SIMULATED: 10 simSOL per hour; a new wallet first gets the SOL top-up, then `create_account` rides in the same transaction as the faucet, so it signs once) -> "Open a Position" (amount of simSOL, Horizon 1-12) -> one transaction `open_native_position` + `take_native_advance`. The Gemas are priced from the on-chain `PriceFeed` (a **devnet price feed** the keeper refreshes hourly), and yield runs on the sim_lst clock: 1 month = ~10 min. Refresh yield (`accrue_native_yield`, permissionless; the keeper also cranks every pass) lowers Debt; Redeem pays simSOL; Unlock returns the Principal once Debt is zero; Sweep surplus follows Unlock. Code: `src/lib/chain/native.ts` (instructions, PDAs, math), `native-flow.ts` (wallet actions), `src/app/wallet/NativePositions.tsx` (UI). Instruction accounts follow `scripts/native-position`.

## The one server route that stays: fee top-up

`POST /api/demo-advance` with `step: "fund"` gives the embedded wallet devnet SOL for fees and rent (nothing else in the native flow needs a server key). If the wallet has under 0.05 SOL, the relayer sends 0.1 SOL. Cap 0.3 SOL per address and per Privy user per 24 h, 20 SOL total per 24 h; refuses if the relayer would drop under 0.5 SOL.

### Authentication

The wallet signs (ed25519) `tesoro-demo|<step>|<address>|<ts>|<nonce>|<fields>`, where `<nonce>` is 16 random bytes in hex and `<fields>` is the JSON array of `evm`, `vault`, `id`, `months`, `position`, `sourceIndex` (null when absent); `/api/eth-bridge` uses `tesoro-eth`. Client and server build it with `signedMessage` (`src/lib/chain/signed-request.ts`), and the server checks it in `src/server/request-auth.ts`:

- a body field outside that list is a 400, so the signature covers the whole request;
- the timestamp must be within 5 minutes and each nonce is accepted once in that window;
- with Privy configured a Privy access token is required (verified against the app's public JWKS with `jose`), and its `sub` gets its own quota next to the wallet's. In production the routes answer `503 not-configured` when `NEXT_PUBLIC_PRIVY_APP_ID` is unset. Only the local dev wallet (`NEXT_PUBLIC_DEV_WALLET=1`, never in production) skips the token.

Nonces and limits are in memory, per server process.

### Devnet only

At server start (`src/instrumentation.ts`) the server checks that `TESORO_BASE_RPC` has the devnet genesis hash and that the Hoodi RPC is chain 560048, and logs `[cluster] …`. Every request to `/api/demo-advance` and `/api/eth-bridge` waits on the same check (`src/server/cluster.ts`) and answers `503 wrong-cluster` on any other cluster; an unreachable RPC is refused and checked again on the next request.

## Dev-only: the old demo Advance

The oracle-signed "Simulated · demo Advance" (a fake 10 SOL Position, 7,500 Gemas) is off by default. To test with it locally set `TESORO_DEMO_ADVANCE=1` (server; the `advance` and `accrue` steps answer 410 otherwise) and `NEXT_PUBLIC_DEMO_ADVANCE=1` (client; the button is compiled out of production builds). Its Positions are not native: Redeem and Unlock do not work for them. Files: `src/server/demo-advance.ts`, `src/lib/chain/demo-client.ts`, `wallet/DemoAdvanceSheet.tsx`; delete them once nothing needs the fake Position.

## Configuration (server env only)

Each key is read from its secret variable when set (the hosted path, `app/docs/hosting.md`), else from the file variable, else from the default file (`src/server/keys.ts`).

| Secret variable | File variable | Default file |
|---|---|---|
| `TESORO_ORACLE_SECRET_KEY` | `TESORO_ORACLE_KEYPAIR` | `~/.config/tesoro/oracle.json` (ETH Advance and the dev demo Advance) |
| `TESORO_RELAYER_SECRET_KEY` | `TESORO_RELAYER_KEYPAIR` | `~/.config/tesoro/relayer.json` (fee top-up and the ETH relay's fee payer; a low-balance key with no program authority) |
| `TESORO_RELAYER_EVM_PRIVATE_KEY` | `TESORO_RELAYER_EVM_ENV` | `~/.config/tesoro/relayer-evm.env` (`RELAYER_EVM_PRIVATE_KEY`; Hoodi ETH top-up; owns no contract) |

| Variable | Default |
|---|---|
| `TESORO_BASE_RPC` | `https://rpc.magicblock.app/devnet` |
| `TESORO_DEMO_ADVANCE` | unset (dev-only demo Advance off) |

The web server never loads the deployer key (program upgrade authority, `tesoro_core` admin) or the EVM deployer key (contract owner): a server compromise can spend only the relayer balances. The oracle key is still loaded for the Advance routes. Keys are read inside `src/server/` and never leave the server: nothing in `src/lib` or a client component imports it. Do not commit keypairs or `.env` files. On a host without those files (for example Vercel), set the secret variables or the route answers `503 not-configured`.

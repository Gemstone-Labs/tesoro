# Funding an Account (Simulated · native Positions)

**Default path: a real Solana-native Position.** On the Wallet: "Get test simSOL" (the sim_lst faucet, SIMULATED: 10 simSOL per hour) -> "Open a Position" (amount of simSOL, Horizon 1-12) -> one transaction `open_native_position` + `take_native_advance`. The Gemas are priced from the on-chain `PriceFeed` (a **devnet price feed** the keeper refreshes hourly), and yield runs on the sim_lst clock: 1 month = ~10 min. Refresh yield (`accrue_native_yield`, permissionless; the keeper also cranks every pass) lowers Debt; Redeem pays simSOL; Unlock returns the Principal once Debt is zero; Sweep surplus follows Unlock. Code: `src/lib/chain/native.ts` (instructions, PDAs, math), `native-flow.ts` (wallet actions), `src/app/wallet/NativePositions.tsx` (UI). Instruction accounts follow `scripts/native-position`.

## The one server route that stays: fee top-up

`POST /api/demo-advance` with `step: "fund"` gives the embedded wallet devnet SOL for fees and rent (nothing else in the native flow needs a server key). If the wallet has under 0.05 SOL, the deployer sends 0.1 SOL. Cap 0.3 SOL per address per 24 h, 20 SOL total per 24 h; refuses if the deployer is under 1 SOL.

Authentication: the wallet signs `tesoro-demo|<step>|<address>|<timestamp>` (5 minute window; ed25519). With Privy configured a Privy access token is also required (verified against the app's public JWKS with `jose`). Limits are in memory, per server process.

## Dev-only: the old demo Advance

The oracle-signed "Simulated · demo Advance" (a fake 10 SOL Position, 7,500 Gemas) is off by default. To test with it locally set `TESORO_DEMO_ADVANCE=1` (server; the `advance` and `accrue` steps answer 410 otherwise) and `NEXT_PUBLIC_DEMO_ADVANCE=1` (client; the button is compiled out of production builds). Its Positions are not native: Redeem and Unlock do not work for them. Files: `src/server/demo-advance.ts`, `src/lib/chain/demo-client.ts`, `wallet/DemoAdvanceSheet.tsx`; delete them once nothing needs the fake Position.

## Configuration (server env only)

| Variable | Default |
|---|---|
| `TESORO_ORACLE_KEYPAIR` | `~/.config/tesoro/oracle.json` (dev demo Advance only) |
| `TESORO_DEPLOYER_KEYPAIR` | `~/.config/solana/id.json` (fee top-up) |
| `TESORO_BASE_RPC` | `https://rpc.magicblock.app/devnet` |
| `TESORO_DEMO_ADVANCE` | unset (dev-only demo Advance off) |

Keys are read from disk inside `src/server/demo-advance.ts` and never leave the server: nothing in `src/lib` or a client component imports it. Do not commit keypairs or `.env` files. On a host without those files (for example Vercel), mount the keys and set the variables or the route answers `503 not-configured`.

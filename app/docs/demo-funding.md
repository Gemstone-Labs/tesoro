# Demo funding (Simulated · demo Advance)

**Temporary stopgap.** Solana-native Position custody is not built yet, so nothing can lock a real Position and issue a real Advance. Until it is, `POST /api/demo-advance` gives a signed-in Account Gemas by opening a **simulated** Position with the oracle key. The UI labels it "Simulated · demo Advance". Replace it with real Position deposits, then delete the route, `src/server/demo-advance.ts`, `src/lib/chain/demo-client.ts` and `wallet/DemoAdvanceSheet.tsx`.

## What it does

`src/app/api/demo-advance/route.ts` -> `src/server/demo-advance.ts` (server only, `import "server-only"`). Three steps, each request authenticated:

| Step | Effect |
|---|---|
| `fund` | If the wallet has under 0.05 SOL, the deployer sends 0.1 SOL for fees and rent. Cap 0.3 SOL per address per 24 h, 20 SOL total per 24 h; refuses if the deployer is under 1 SOL. |
| `advance` | Needs an existing TesoroAccount (the client creates it). The oracle signs `open_position` (simulated 10 SOL at 10% APY) and sends it, then returns the `take_advance` transaction (6-month Horizon, SOL at $150) already signed by the oracle. The Account signs and sends it: 7,500 Gemas. |
| `accrue` | The oracle calls `apply_yield` once per Position for 20% of the Advance's repayment, so 1,500 Gemas are redeemable and 6,000 pending (a real split on the Wallet screen). |

The oracle is the registered `Config.oracle_authority`, the same trusted seam tesoro_core documents. `take_advance` needs both signatures; the fee payer is the oracle.

## Authentication and limits

- The wallet signs `tesoro-demo|<step>|<address>|<timestamp>` (5 minute window; verified with ed25519). This proves control of the address.
- With Privy configured, a Privy access token is also required (`Authorization: Bearer`, verified against the app's public JWKS with `jose`), so only signed-in Accounts qualify. No Privy secret is needed.
- Limits (in-memory, per server process): 3 Advances per address per 24 h, 5 per Privy user, 300 globally. A redeploy resets them; the SOL caps bound the cost.

## Configuration (server env only)

| Variable | Default |
|---|---|
| `TESORO_ORACLE_KEYPAIR` | `~/.config/tesoro/oracle.json` |
| `TESORO_DEPLOYER_KEYPAIR` | `~/.config/solana/id.json` |
| `TESORO_BASE_RPC` | `https://rpc.magicblock.app/devnet` |

Keys are read from disk inside `src/server/demo-advance.ts` and never leave the server: nothing in `src/lib` or a client component imports it (checked: the client bundle contains no key path or variable). Do not commit keypairs or `.env` files. On a host without those files (for example Vercel), mount the keys and set the variables or the route answers `503 not-configured`.

## Not covered

Redeem, Return and real Debt repayment are not wired on chain; the Wallet disables Redeem for on-chain Accounts and says why.

# RPC roles

Free-tier keys (Alchemy) serve normal RPC but reject `getProgramAccounts`; the public devnet RPC serves it but rate-limits per client. So the app splits the work by role.

| Var | Where | Used for | Default |
|---|---|---|---|
| `NEXT_PUBLIC_SOLANA_RPC` | browser | single-account reads (`getAccountInfo`, `getMultipleAccounts`), sends, confirmations | `https://rpc.magicblock.app/devnet` |
| `TESORO_BASE_RPC` | server | reads and sends in API routes | same |
| `TESORO_GPA_RPC` | server only | list queries (`getProgramAccounts`) | `https://api.devnet.solana.com` (later a Helius key) |
| `KEEPER_RPC` | keeper | sends and reads | `TESORO_BASE_RPC`, then the default above |
| `KEEPER_GPA_RPC` | keeper | list queries | `https://api.devnet.solana.com` |

The keeper loads `app/.env.local` for any variable its own environment leaves unset, so keys live in one file. `NEXT_PUBLIC_*` values ship to the browser: restrict that key by domain. Copy `app/.env.example` to `app/.env.local`; never commit it.

## List route

`GET /api/chain/accounts?program=<id>&filter=s:<dataSize>&filter=m:<offset>:<base58>&slice=<offset>:<length>`

- `program` must be one of our programs (addresses come from the IDLs, `SIM_LST_ID`, and the bridge). At most 4 filters. Anything else is a 400.
- The server calls `getProgramAccounts` on `TESORO_GPA_RPC` and returns the raw `[{ pubkey, account: { data: [base64, "base64"], ... } }]`.
- One in-process cache per query: fresh for 4s, then stale-while-revalidate for 2 min, a single in-flight upstream call per query, and exponential backoff (4s to 64s) after an upstream 429 (stale data keeps being served; 503 with `Retry-After` when there is none). So upstream load is at most about 15 calls per minute per distinct query, however many tabs are open. Each upstream call logs `[gpa] upstream #n`.
- The cache is per server instance. On serverless hosting each instance has its own; run a single instance for the demo.

Browser code does not call the route by hand: `getChain().base` is a `SplitConnection` (`src/lib/chain/split-connection.ts`) whose `getProgramAccounts` calls it, so Anchor's `program.account.x.all()` works unchanged. Identical queries within 1.5s share one fetch.

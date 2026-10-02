# RPC roles

Free-tier keys (Alchemy) serve normal RPC but reject `getProgramAccounts`; the public devnet RPC serves it but rate-limits per client. So the app splits the work by role.

| Var | Where | Used for | Default |
|---|---|---|---|
| `NEXT_PUBLIC_SOLANA_RPC` | browser | single-account reads (`getAccountInfo`, `getMultipleAccounts`), sends, confirmations | `https://rpc.magicblock.app/devnet` |
| `TESORO_BASE_RPC` | server | reads and sends in API routes | same |
| `TESORO_GPA_RPC` | server only | list queries (`getProgramAccounts`) | `https://rpc.magicblock.app/devnet` (the public `api.devnet.solana.com` rate-limits under a few tabs) |
| `KEEPER_RPC` | keeper | sends and reads | `TESORO_BASE_RPC`, then the default above |
| `KEEPER_GPA_RPC` | keeper | list queries | `https://rpc.magicblock.app/devnet` |

The keeper loads `app/.env.local` for any variable its own environment leaves unset, so keys live in one file. `NEXT_PUBLIC_*` values ship to the browser: restrict that key by domain. Copy `app/.env.example` to `app/.env.local`; never commit it.

## List route

`GET /api/chain/accounts?program=<tesoro_core>&filter=m:0:<discriminator>[&filter=m:<offset>:<owner>]`

- Only the queries the app makes are accepted (Anchor `.all()` in `src/lib/chain/read.ts`, `recent.ts`, `backing.ts`): `MatchState`, `RequestState` and `OfferState` by discriminator, `HoldingState` by owner at offset 9 and `PositionState` by owner at offset 41. Anything else (other programs, `dataSize`, `slice`, other offsets) is a 400. Add the shape to `LISTS` in `src/server/gpa.ts` when the app needs a new list.
- A Player's Account (`/account/<key>`, `fetchAccountMatches` and `fetchLiveRequests`) adds no list shape: it takes `MatchState` and `RequestState` whole and cuts them in the browser, then reads the Sessions and Hold'em tables of that Account's Matches with `getMultipleAccounts` (100 per call). A finished Match's Session or table is kept in memory for the tab, so each 30 s poll costs the two cached lists and nothing else.
- The server calls `getProgramAccounts` on `TESORO_GPA_RPC` with the discriminator filter only and returns the raw `[{ pubkey, account: { data: [base64, "base64"], ... } }]`. Owner-filtered queries are cut from that list in-process, so the upstream sees at most one query per account type, whatever the owner.
- One in-process cache per list: fresh for 4s, then stale-while-revalidate for 2 min, and a single in-flight upstream call that every concurrent request shares. After an upstream 429 the server backs off (4s to 64s). During the backoff, or when a refresh fails, cached rows are served however old; a list never fetched answers 503 with `Retry-After`. Each upstream call logs `[gpa] upstream #n`.
- 600 requests per minute per client IP (`x-forwarded-for`, set by the host), then 429.
- The cache is per server instance. On serverless hosting each instance has its own; run a single instance for the demo.

Browser code does not call the route by hand: `getChain().base` is a `SplitConnection` (`src/lib/chain/split-connection.ts`) whose `getProgramAccounts` calls it, so Anchor's `program.account.x.all()` works unchanged. Identical queries within 1.5s share one fetch.

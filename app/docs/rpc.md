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

## Account route

`GET /api/account/<authority>[?fresh=1]`

- The signed-in Account's state (Gemas, Holdings, Positions with their simSOL custody, the simSOL market, SOL balance) assembled on the server, so a page load costs the browser one request instead of several RPC round trips. Matches are not in it: they stay a separate read (`fetchAccountMatches`).
- `src/server/snapshot.ts` runs the same `readAccountState` (`src/lib/chain/account-state.ts`) as the browser's own read, with the Holding and Position lists from the list cache above (no HTTP hop) and the rest from `TESORO_BASE_RPC`: round 1 the lists with the Account, the market and the balance; round 2 one `getMultipleAccountsInfo` (100 keys a call) of every listed Holding, held Source, Position, open Source, custody, vault and latest Source; round 3, only when a listed Position took an Advance since the list was cached (its new latest Source) and, in the same round, when the Account holds Gemas won from another Account's Position (those Positions with their custody and vault). A snapshot with nothing new or foreign is two rounds.
- Answers JSON where bigints are `{ "$big": "<decimal>" }` and keys `{ "$key": "<base58>" }` (`src/lib/chain/snapshot-wire.ts`). Same per-client limit as the list route (600 a minute), then 429.
- The browser (`fetchAccountState`) asks the route first and reads the chain itself when it answers an error, a bad body or nothing within 15 s, so the route is an optimisation, never a dependency.
- Freshness: Holdings and Positions are re-read from the chain on every snapshot, but a Holding or Position created since the list was cached is missing for up to 2 min. After a transaction this app sent, `refresh()` asks with `?fresh=1`, which never touches the shared lists: for that Account the server runs one filtered `getProgramAccounts` per list (discriminator + owner memcmp) and merges those rows over the cached ones for this response only (if that read fails, the cached rows answer). Fresh reads are limited to 4 a minute per client IP and Account; beyond that the request is served from the cache as if `fresh` were absent. The cache is per server instance, so the flag travels with the request rather than being stored.

Browser code does not call the route by hand: `getChain().base` is a `SplitConnection` (`src/lib/chain/split-connection.ts`) whose `getProgramAccounts` calls it, so Anchor's `program.account.x.all()` works unchanged. Identical queries within 1.5s share one fetch.

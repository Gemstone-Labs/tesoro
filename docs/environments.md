# Environments

Tesoro runs as separate deployments, each with its own env. Nothing is shared between them except the repo.

| Deployment | Host | Cluster | Notes |
|---|---|---|---|
| Local | `localhost:3000` | test (default) | `app/.env.local`; the keeper reads it too |
| Test host | `test.playtesoro.com` | test: devnet, Hoodi, HyperEVM testnet, simulated yield | its own Vercel project (or environment); noindex |
| Mainnet | `www.playtesoro.com` (apex redirects) | mainnet: Solana mainnet-beta, Ethereum, HyperEVM mainnet, real yield | switched on launch day; the only indexable host |
| Keeper (test) | VPS user service | test | one keeper per cluster, each with its own keys |
| Keeper (mainnet) | VPS user service | mainnet | separate unit, separate env file, separate keys |

Until launch day `www` keeps serving test mode; set `NEXT_PUBLIC_SITE_URL` on it explicitly (it is the indexable host either way).

## How the app picks its behaviour

- **Cluster.** `TESORO_CLUSTER` (server, keeper) or `NEXT_PUBLIC_TESORO_CLUSTER` (browser), `test` or `mainnet`, default `test`; any other value throws. Set both on a Vercel project (the public one is inlined at build time, so changing it needs a redeploy). All per-cluster values live in `app/src/lib/cluster-settings.ts`.
- **RPC rules.** Test mode has public defaults. Mainnet has none: an unset RPC var throws at boot or at the first use (`app/src/lib/chain/rpc-config.ts`, `app/src/lib/chains.ts`, `app/src/lib/solana-network.ts`, `keeper/src/env.ts`). The server also checks each RPC's genesis hash or chain id against the cluster before any route spends from a server key (`app/src/server/cluster.ts`), so a devnet URL on a mainnet deployment refuses instead of spending.
- **Site URL.** `app/src/lib/site.ts`: `NEXT_PUBLIC_SITE_URL`, else the Vercel production domain, else (production build) `https://test.playtesoro.com` on the test cluster or `https://www.playtesoro.com` on mainnet, else `localhost:3000`. It feeds `metadataBase` (so canonical and Open Graph URLs follow the host), the verify link in emails and the share links. Set it explicitly on every deployment.
- **Indexing.** Only `www.playtesoro.com` is indexable. Any other host serves `robots.txt` with `Disallow: /` and a `noindex, nofollow` robots meta on every page. Share pages (`/spot`, `/win`) are noindex everywhere.
- **Launch stage labels.** The "test mode" footer lines follow the cluster; `NEXT_PUBLIC_LAUNCH_STAGE` (`testnet` or `mainnet`) overrides it, e.g. a mainnet build that is still pre-launch.

## Env matrix

Legend: **R** required, **O** optional, **-** not read. Visibility: **public** ships to the browser (restrict keys by domain or origin), **secret** is server-only. Example shapes only; never commit values.

### Cluster and site

| Var | Visibility | Local | Test host | Mainnet www | Example shape |
|---|---|---|---|---|---|
| `TESORO_CLUSTER` | server | O (`test`) | R `test` | R `mainnet` | `mainnet` |
| `NEXT_PUBLIC_TESORO_CLUSTER` | public | O | R `test` | R `mainnet` | `mainnet` |
| `NEXT_PUBLIC_SITE_URL` | public | O | R | R | `https://test.playtesoro.com` |
| `NEXT_PUBLIC_LAUNCH_STAGE` | public | O | O | O (default follows cluster) | `mainnet` |
| `NEXT_PUBLIC_APP_URL` | public | O | O | O (prefix for links into the app if it moves to its own host) | `https://app.example.com` |
| `NEXT_PUBLIC_DOCS_URL`, `NEXT_PUBLIC_GITHUB_URL`, `NEXT_PUBLIC_X_URL` | public | O | O | O | outbound links, default to `/docs`, the GitHub repo, none |
| `NEXT_PUBLIC_EXTEND_ADVANCE` | public | O | O (`1` once the program has Extend) | O | `1` |
| `NEXT_PUBLIC_DEV_WALLET` | public | O (`1` for the dev wallet) | O (QA only) | must be unset | `1` |
| `VERCEL_PROJECT_PRODUCTION_URL` | set by Vercel | - | automatic | automatic | `tesoro-test.vercel.app` |

### RPC

| Var | Visibility | Local | Test host | Mainnet www | Example shape |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_SOLANA_RPC` | public | O (MagicBlock devnet) | O (default devnet) | R Helius, key restricted to the host | `https://mainnet.helius-rpc.com/?api-key=<key>` |
| `TESORO_BASE_RPC` | secret | O | O | R Helius (server key) | `https://mainnet.helius-rpc.com/?api-key=<key>` |
| `TESORO_GPA_RPC` | secret | O | O | R Helius (must serve `getProgramAccounts`) | same shape |
| `NEXT_PUBLIC_HOODI_RPC` | public | O | O (default publicnode) | - | `https://ethereum-hoodi-rpc.publicnode.com` |
| `NEXT_PUBLIC_ETHEREUM_RPC` | public | - | - | R Alchemy, key restricted to the host | `https://eth-mainnet.g.alchemy.com/v2/<key>` |
| `NEXT_PUBLIC_HYPEREVM_RPC` | public | O (testnet default) | O | R Alchemy HyperEVM | `https://hyperliquid-mainnet.g.alchemy.com/v2/<key>` |
| `TESORO_SOL_MAINNET_RPC`, `TESORO_ETH_MAINNET_RPC` | secret | O | O | O | name lookups (`.sol`, `.eth`) read mainnet in every deployment; default to public RPCs |
| `TESORO_HLN_API`, `TESORO_HLN_API_KEY` | secret | O | O | O (own key) | Hyperliquid Names lookup |

### Sign-in, data, email, CAPTCHA

| Var | Visibility | Local | Test host | Mainnet www | Example shape |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID` | public | O (sign-in off without it) | R | R (its own Privy app, or the same app with both origins allowed) | `cl...` |
| `SUPABASE_URL` | secret | O (waitlist, notify off) | R | R | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | O | R | R | `eyJ...` |
| `RESEND_API_KEY` | secret | O | R for email | R | `re_...` |
| `NOTIFY_FROM` | secret | O | R for email | R | `Tesoro <hello@mail.playtesoro.com>` |
| `NOTIFY_SECRET` | secret | O | R for email | R (shared with that cluster's keeper) | 32+ random bytes, hex |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | public | O (empty: skipped) | R | R | `0x4AAAAAAA...` |
| `TURNSTILE_SECRET_KEY` | secret | O | R | R | `0x4AAAAAAA...` |

Turnstile is enforced only when both keys are set. Use one Turnstile widget per hostname.

### Server keys (web routes)

Each is the keypair file's JSON array (Solana) or a 0x hex key (EVM). Locally the key files under `~/.config/tesoro/` are the fallback (`TESORO_ORACLE_KEYPAIR`, `TESORO_RELAYER_KEYPAIR`, `TESORO_RELAYER_EVM_ENV` name other file paths); hosts without those files set the secret.

| Var | Visibility | Test host | Mainnet www | Notes |
|---|---|---|---|---|
| `TESORO_RELAYER_SECRET_KEY` | secret | R | R | fee payer of web routes; low balance, no program authority |
| `TESORO_ORACLE_SECRET_KEY` | secret | R | R only if a route needs it | test mode oracle; mainnet reads on-chain feeds |
| `TESORO_RELAYER_EVM_PRIVATE_KEY` | secret | R | R only for relay routes | EVM relayer; the mainnet cluster refuses the top-up and faucet steps |
| `TESORO_HYPE_TOPUP_MAX_PER_HOUR` | secret | O | - | test-mode HYPE drip cap |

Never reuse a test key on mainnet. The single-purpose mainnet keys are ticket 36.

### Keeper

The keeper loads `app/.env.local` for any variable its own env leaves unset (local only). On the VPS each unit has its own env file (mode 600).

| Var | Test | Mainnet | Example shape / default |
|---|---|---|---|
| `TESORO_CLUSTER` | R `test` | R `mainnet` | `mainnet` |
| `KEEPER_RPC` (falls back to `TESORO_BASE_RPC`) | O (MagicBlock devnet) | R Helius | `https://mainnet.helius-rpc.com/?api-key=<key>` |
| `KEEPER_GPA_RPC` | O | R Helius | same shape |
| `KEEPER_HOODI_RPC` | O (publicnode) | R: the Ethereum RPC (Alchemy) | `https://eth-mainnet.g.alchemy.com/v2/<key>` |
| `KEEPER_HYPEREVM_RPC` | O (testnet) | R: HyperEVM mainnet (Alchemy) | `https://hyperliquid-mainnet.g.alchemy.com/v2/<key>` |
| `KEEPER_SECRET_KEY` (or `KEEPER_KEYPAIR` file) | R | R | keypair JSON array |
| `KEEPER_ORACLE_SECRET_KEY` (or `KEEPER_ORACLE` file) | R | R for Seasons | keypair JSON array |
| `KEEPER_EVM_PRIVATE_KEY` (or `KEEPER_EVM_ENV` file) | R | R | 0x hex |
| `KEEPER_KEYS_FROM_ENV` | `1` on hosted | `1` | refuse key files |
| `KEEPER_FUNDER` | O | O | funder keypair file (test top-ups) |
| `NOTIFY_URL` | R for email | R for email | the same deployment's `https://<host>/api/notify/` (trailing slash); test keeper points at the test host, mainnet keeper at www |
| `NOTIFY_SECRET` | R for email | R for email | equal to that deployment's `NOTIFY_SECRET` |
| `KEEPER_DIGEST_HOUR_UTC` | O (8) | O (8) | `8` |
| `KEEPER_HEALTH_HOST`, `KEEPER_HEALTH_PORT` | O | O | `127.0.0.1`, `8787` (one keeper per host or a second port) |
| `KEEPER_STATE_DIR` | O | R: separate dir per cluster | `~/.local/state/tesoro-keeper-mainnet` |
| `KEEPER_INTERVAL_SECS`, `KEEPER_WATCHDOG_SECS`, `KEEPER_JOB_LIMIT_SECS`, `KEEPER_RPC_TIMEOUT_MS` | O | O | loop timing |
| `KEEPER_MAX_SOL_PER_HOUR`, `KEEPER_MAX_LZ_FEE_SOL`, `KEEPER_MAX_LZ_SOL_PER_HOUR`, `KEEPER_MAX_ETH_PER_HOUR`, `KEEPER_MAX_HYPE_PER_HOUR`, `KEEPER_YIELD_BUDGET_SHARE` | O | review before launch | spend caps |
| `KEEPER_YIELD_*`, `KEEPER_ETH_YIELD_MINS`, `KEEPER_TREASURY_*`, `KEEPER_PRICE_REFRESH_SECS`, `KEEPER_SEASON_GRACE_SECS`, `KEEPER_DUEL_END_GRACE_SECS` | O | O | job tuning |

### Tooling

| Var | Used by | Notes |
|---|---|---|
| `ETH_MAINNET_RPC` | `forge test --match-contract WstETHMainnetForkTest` (`contracts/foundry.toml`) | any Ethereum mainnet archive-capable RPC; local only |
| `TESORO_IDL_DIR`, `TESORO_CORE_ID` | scripts and tests | not deployment settings |

## Boot checks

- `TESORO_CLUSTER=mainnet` with `NEXT_PUBLIC_SOLANA_RPC`, `NEXT_PUBLIC_ETHEREUM_RPC` or `NEXT_PUBLIC_HYPEREVM_RPC` unset fails the build or first page load with `<NAME> is not set; mainnet has no default RPC`.
- `TESORO_BASE_RPC` / `TESORO_GPA_RPC` are read per request on the server; unset on mainnet they throw `... mainnet has no default RPC` on the first call.
- On start the server logs `[cluster] ... is Solana mainnet-beta` or refuses spending routes with the genesis it found.

## Hand-off: what the founder does

Agents never touch Vercel, DNS or provider dashboards. The order below keeps `www` untouched until the last step.

1. **Vercel, test host.** Create a second project from the same repo (`Gemstone-Labs/tesoro`, root directory `app`, Node 22), named for example `tesoro-test`, in team `gemstone-labs`. Production branch `main`, so every push to `main` also updates it. Set its env from the Test host column (cluster `test` for both cluster vars, `NEXT_PUBLIC_SITE_URL=https://test.playtesoro.com`, Privy, Supabase, relayer/oracle keys, Resend, Turnstile). Add domain `test.playtesoro.com`. Copy `.vercelignore` behaviour as is.
2. **DNS at GoDaddy (the partner adds it).** Add a `CNAME` record: host `test`, value as shown by Vercel's Domains page for the new project (typically `cname.vercel-dns.com`). No change to `www` or the apex. Vercel issues the certificate once the record resolves.
3. **Supabase.** Decide whether the test host shares the `tesoro-waitlist` database. Recommended: a separate Supabase project for mainnet so test sign-ups and mainnet waitlist/notification data never mix; apply `app/supabase/migrations` to each.
4. **Helius.** Create a mainnet key for the server (`TESORO_BASE_RPC`, `TESORO_GPA_RPC`, `KEEPER_RPC`, `KEEPER_GPA_RPC`; confirm the plan serves `getProgramAccounts`) and a separate browser key (`NEXT_PUBLIC_SOLANA_RPC`) restricted to `www.playtesoro.com`. Keep the keeper's key separate from the web's so rate limits do not couple.
5. **Alchemy.** One app for Ethereum mainnet and one for HyperEVM mainnet (or one app with both networks). Browser keys (`NEXT_PUBLIC_ETHEREUM_RPC`, `NEXT_PUBLIC_HYPEREVM_RPC`) restricted by allowed domain to `www.playtesoro.com`; a server/keeper key for `KEEPER_HOODI_RPC` and `KEEPER_HYPEREVM_RPC`. Any key tied to your own fork test goes in `ETH_MAINNET_RPC` locally only.
6. **Privy.** In the Privy dashboard add `https://test.playtesoro.com` to Allowed origins (and keep `localhost`). Enable Solana mainnet and Ethereum (chain 1) and HyperEVM (999) for the app that serves `www` before launch. Prefer a separate Privy app for mainnet so test accounts do not carry over; its app id goes in the mainnet project's `NEXT_PUBLIC_PRIVY_APP_ID`.
7. **Turnstile.** Add `test.playtesoro.com` (and `www`) as hostnames on the widget, or create one widget per host.
8. **Keeper units.** Start a second keeper unit for mainnet with its own env file and state dir; point each keeper's `NOTIFY_URL` at its own deployment. Keep exactly one keeper per cluster.
9. **Launch day, www to mainnet.**
   1. Programs and mainnet accounts are deployed and initialised (runbook, ticket 37).
   2. In the project that serves `www` set `TESORO_CLUSTER=mainnet`, `NEXT_PUBLIC_TESORO_CLUSTER=mainnet`, the three RPC groups above, mainnet-only keys, `NEXT_PUBLIC_SITE_URL=https://www.playtesoro.com`, and remove `NEXT_PUBLIC_DEV_WALLET`.
   3. Redeploy (the public vars are inlined at build time), then smoke: `/robots.txt` allows crawling, `/lobby` shows no test-mode footer, server log says `is Solana mainnet-beta`.
   4. Start the mainnet keeper, stop nothing on the test keeper.
   5. Send test-host users a note: their devnet Gemas stay on `test.playtesoro.com`.

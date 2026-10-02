# Hosting runbook (judges' demo)

The app runs on **Vercel** and the keeper runs on **Fly.io** as one always-on Machine. Both use Solana devnet and Ethereum Hoodi only. Nothing here is deployed yet: the founder runs these steps.

Keys never go into the repo or the image. Each server key is read from an env secret first, then from the key file under `~/.config/tesoro/` (the local fallback). The app's loaders are in `src/server/keys.ts` and the keeper's in `keeper/src/keys.ts`. A Solana secret holds the key file's contents (the JSON array of 64 bytes). An EVM secret holds `0x` plus 64 hex digits. Both loaders refuse the compromised `AXwY…` key.

## 0. Before you start

1. **Stop the local keeper** (`pnpm --filter @tesoro/keeper start` on this machine) before the hosted one starts. Two keepers would both send every crank and `reportYield`.
2. Log in to both CLIs: `vercel login` and `fly auth login`.
3. Check the balances the demo spends from. Top up anything that is low.

   ```bash
   RPC=https://rpc.magicblock.app/devnet
   solana balance "$(solana-keygen pubkey ~/.config/tesoro/relayer.json)" --url $RPC   # SOL fee top-ups + ETH relay fees; keeps a 0.5 SOL floor
   solana balance "$(solana-keygen pubkey ~/.config/tesoro/keeper.json)"  --url $RPC   # keeper payer; at least 1 SOL
   solana balance "$(solana-keygen pubkey ~/.config/tesoro/oracle.json)"  --url $RPC   # set_price and ETH Advance fees
   cast balance "$(cast wallet address --private-key "$(sed -n 's/^RELAYER_EVM_PRIVATE_KEY=//p' ~/.config/tesoro/relayer-evm.env)")" \
     --rpc-url https://ethereum-hoodi-rpc.publicnode.com --ether                    # Hoodi ETH top-ups
   cast balance "$(cast wallet address --private-key "$(sed -n 's/^RELAYER_EVM_PRIVATE_KEY=//p' ~/.config/tesoro/relayer-evm.env)")" \
     --rpc-url https://rpc.hyperliquid-testnet.xyz/evm --ether                      # HyperEVM HYPE top-ups: at least 0.2, refuses under 0.08
   ```

4. Optional: a keyed devnet RPC (Helius). The public endpoints rate-limit under load. `rpc.magicblock.app/devnet` is the default for every role and served `getProgramAccounts` in QA.

## 1. App on Vercel

### Environment variables (Production)

`NEXT_PUBLIC_*` values are inlined into the browser bundle at build time, so they are public. Set them **before** you deploy, and redeploy after you change one.

| Variable | Public / secret | Needed | Value |
|---|---|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID` | public | **yes** | Privy app ID (same as `app/.env.local`). Production has no dev wallet, so without it nobody can sign in, and the funding routes refuse every request. |
| `NEXT_PUBLIC_SOLANA_RPC` | public | no | Browser reads and sends. Default `https://rpc.magicblock.app/devnet`. A keyed URL here is visible to everyone, so restrict that key to the Vercel domain. |
| `NEXT_PUBLIC_HOODI_RPC` | public | no | Default `https://ethereum-hoodi-rpc.publicnode.com`. |
| `NEXT_PUBLIC_SITE_URL` | public | no | Base URL for Open Graph images. Vercel sets `VERCEL_PROJECT_PRODUCTION_URL` itself; set this only for a custom domain (`https://…`). |
| `TESORO_BASE_RPC` | secret if keyed | no | Server reads and sends. Default `https://rpc.magicblock.app/devnet`. The server refuses to spend unless this RPC is devnet. |
| `TESORO_GPA_RPC` | secret if keyed | no | Server `getProgramAccounts`. Default `https://rpc.magicblock.app/devnet`. The RPC must allow `getProgramAccounts` (most free tiers do not). |
| `TESORO_RELAYER_SECRET_KEY` | **secret** | **yes** | Contents of `~/.config/tesoro/relayer.json`. Pays the fee top-up (`/api/demo-advance` `fund`) and the ETH relay steps. It is low-balance and has no program authority. |
| `TESORO_RELAYER_EVM_PRIVATE_KEY` | **secret** | for ETH | The `RELAYER_EVM_PRIVATE_KEY` value from `~/.config/tesoro/relayer-evm.env`. Funds the Hoodi ETH top-up and the HyperEVM HYPE top-up (it needs HYPE on chain 998 too: `fund-hype` refuses under 0.08 HYPE) and owns no contract. |
| `TESORO_ORACLE_SECRET_KEY` | **secret** | for ETH | Contents of `~/.config/tesoro/oracle.json`. Co-signs the ETH Advance (`/api/eth-bridge` `advance`). Without it the ETH Advance answers 503 and native Positions still work. **This is the price oracle key**, so read *Known limits*. |
| `TESORO_HYPE_TOPUP_MAX_PER_HOUR` | plain | no | Global cap on HYPE top-ups (0.03 HYPE each) per rolling hour. Default 5 (0.15 HYPE/h). Per wallet, per Account and per Privy user the cap is one top-up per 24 h, fixed. |

**Never set these in production:**

- `NEXT_PUBLIC_DEV_WALLET`, `NEXT_PUBLIC_DEMO_ADVANCE`: compiled out of production builds anyway.
- `TESORO_DEMO_ADVANCE`: not gated on `NODE_ENV`, so setting it would turn the oracle-signed fake Advance back on.
- `TESORO_*_KEYPAIR`, `TESORO_RELAYER_EVM_ENV`: these are file paths and are not used on Vercel.

`NEXT_PUBLIC_APP_URL` does not exist in the code, so don't set it.

### Commands

Run these from the repo root. `.vercelignore` is an allowlist: the upload holds only the pnpm workspace files, `app/`, the `keeper/` manifest and one test vector. No `.env*`, no `target/`, no keys.

```bash
cd ~/Work/gemstone-labs/tesoro/tesoro

vercel link
#   Set up? yes · scope: yours · link to existing project? no · name: tesoro
#   "In which directory is your code located?" -> ./app   (framework: Next.js, detected)
# Then in Project Settings > General: Node.js Version 22.x. Keep "Include files outside the Root Directory" on (default).

# Public values
printf %s "$(sed -n 's/^NEXT_PUBLIC_PRIVY_APP_ID=//p' app/.env.local)" | vercel env add NEXT_PUBLIC_PRIVY_APP_ID production

# Secrets: read from the key files, never typed or echoed
vercel env add TESORO_RELAYER_SECRET_KEY production --sensitive < ~/.config/tesoro/relayer.json
vercel env add TESORO_ORACLE_SECRET_KEY  production --sensitive < ~/.config/tesoro/oracle.json
printf %s "$(sed -n 's/^RELAYER_EVM_PRIVATE_KEY=//p' ~/.config/tesoro/relayer-evm.env)" \
  | vercel env add TESORO_RELAYER_EVM_PRIVATE_KEY production --sensitive
# Optional keyed RPCs: printf %s "$URL" | vercel env add TESORO_BASE_RPC production --sensitive  (same for TESORO_GPA_RPC)

vercel env ls production      # names only; sensitive values are not shown
vercel deploy --prod          # prints the production URL
```

Rollback: `vercel rollback` (previous production deployment). The production domain is public. Vercel's default Deployment Protection covers previews only.

## 2. Privy dashboard (dashboard.privy.io)

These settings live in the dashboard, so code can't stand in for them. Full list and reasons: `app/docs/accounts.md`.

1. **Allowed origins** (Configuration > App settings > Domains): add the Vercel production URL from `vercel deploy --prod` (`https://<project>.vercel.app`) and any custom domain. Keep `http://localhost:3000`. Sign-in fails with an origin error until you do this.
2. **Login methods**: Email on.
3. **Embedded wallets**: Ethereum and Solana both on, "Create on login" for all users.
4. **External wallets / linking**: wallet linking on for Ethereum and Solana.
5. **Chains**: add Ethereum Hoodi (560048, `https://ethereum-hoodi-rpc.publicnode.com`) and HyperEVM testnet (998, `https://rpc.hyperliquid-testnet.xyz/evm`) as custom EVM chains, and enable Solana devnet.
6. **Test account** (Configuration > Test accounts): create one so judges can sign in without an inbox. Put its email and code in the submission notes.

## 3. Keeper on Fly.io

The keeper runs as **one Machine with no public services**, so it can't be reached from the internet. It runs `keeper/Dockerfile` (Node 22, `tsx`, the app's chain clients). The image has no keys. `KEEPER_KEYS_FROM_ENV=1` makes a missing `KEEPER_SECRET_KEY` fatal, so the keeper never mints a throwaway payer.

Liveness works like this:

- Each pass logs `keeper - alive pass=<n> took=<s>`.
- A watchdog exits the process when no pass finishes in 20 min (`KEEPER_WATCHDOG_SECS`). Fly's `[[restart]] policy = "always"` then restarts it.
- `GET :8080/healthz` returns 200 while the loop is alive and 503 once it is stale. The `alive` check in `keeper/fly.toml` reports it. Fly doesn't restart on a failing check; the watchdog handles restarts.
- If the RPC is unreachable at startup, the process exits and is restarted too.

Size: the keeper uses ~415 MiB RSS (measured), so the VM is `shared-cpu-1x` with 1 GB (about $6/month). The image is ~1.7 GB because it includes the app's runtime dependencies.

### Secrets

| Secret | Needed | Value |
|---|---|---|
| `KEEPER_SECRET_KEY` | **yes** | Contents of `~/.config/tesoro/keeper.json` (payer `9X8L…yVit`). |
| `KEEPER_ORACLE_SECRET_KEY` | **yes** | Contents of `~/.config/tesoro/oracle.json`. Publishes `set_price` at least hourly; Advances stop after 24 h without it. |
| `KEEPER_EVM_PRIVATE_KEY` | for ETH | A **dedicated** Hoodi key for the permissionless `reportYield`. Don't use the EVM deployer: it owns the contracts. |
| `KEEPER_RPC`, `KEEPER_GPA_RPC` | no | Keyed devnet RPCs. Default `https://rpc.magicblock.app/devnet`. |

Optional tuning (as plain secrets or `[env]`): `KEEPER_INTERVAL_SECS` (20), `KEEPER_MAX_SOL_PER_HOUR` (0.5), `KEEPER_MAX_ETH_PER_HOUR` (0.005), `KEEPER_WATCHDOG_SECS` (1200). See `keeper/README.md`.

### Commands

```bash
cd ~/Work/gemstone-labs/tesoro/tesoro

# One-time: a dedicated Hoodi key for the keeper's reportYield, funded with a little Hoodi ETH
( umask 077; cast wallet new --json | jq -r '"EVM_DEPLOYER_PRIVATE_KEY=" + .[0].private_key' > ~/.config/tesoro/keeper-evm.env )
KEEPER_EVM_ADDR=$(cast wallet address --private-key "$(sed -n 's/^EVM_DEPLOYER_PRIVATE_KEY=//p' ~/.config/tesoro/keeper-evm.env)")
cast send "$KEEPER_EVM_ADDR" --value 0.05ether --rpc-url https://ethereum-hoodi-rpc.publicnode.com \
  --private-key "$(sed -n 's/^EVM_DEPLOYER_PRIVATE_KEY=//p' ~/.config/tesoro/evm-deployer.env)"

# App + secrets (staged: nothing runs until the deploy)
fly apps create tesoro-keeper        # if the name is taken, pick another and change `app =` in keeper/fly.toml
{
  printf 'KEEPER_SECRET_KEY=%s\n'        "$(cat ~/.config/tesoro/keeper.json)"
  printf 'KEEPER_ORACLE_SECRET_KEY=%s\n' "$(cat ~/.config/tesoro/oracle.json)"
  printf 'KEEPER_EVM_PRIVATE_KEY=%s\n'   "$(sed -n 's/^EVM_DEPLOYER_PRIVATE_KEY=//p' ~/.config/tesoro/keeper-evm.env)"
} | fly secrets import -a tesoro-keeper --stage
fly secrets list -a tesoro-keeper    # names and digests only

# Deploy: build context is the repo root. --ha=false keeps it to one Machine.
fly deploy . -c keeper/fly.toml --dockerfile keeper/Dockerfile --ha=false
fly scale count 1 -a tesoro-keeper --yes
fly logs -a tesoro-keeper            # expect: start cluster/payer line, then "alive pass=1 …"
fly checks list -a tesoro-keeper     # alive: passing
```

Stop: `fly scale count 0 -a tesoro-keeper --yes`. Restart: `fly machine restart -a tesoro-keeper`. Rotate a key: `fly secrets set` / `import` (this restarts the Machine). To test the image locally, from the repo root:

```bash
docker build -f keeper/Dockerfile -t tesoro-keeper .
KEEPER_SECRET_KEY="$(cat ~/.config/tesoro/keeper.json)" KEEPER_ORACLE_SECRET_KEY="$(cat ~/.config/tesoro/oracle.json)" \
  docker run --rm -e KEEPER_SECRET_KEY -e KEEPER_ORACLE_SECRET_KEY tesoro-keeper tsx src/index.ts --once --dry-run
```

## 4. Post-deploy smoke test

Run it in a fresh browser profile against the production URL.

1. **Load `/`.** The Lobby renders with no console errors about Privy origins. In `vercel logs <url>` the server logs `[cluster] TESORO_BASE_RPC is Solana devnet` (once the cluster check from the server-hardening branch is merged).
2. **Sign in with email.** Use "Sign in", enter the test account's email (or a real inbox), then the code. The header shows the Gema balance and the Account button. The Account sheet shows a Solana and an EVM address.
3. **Open a native Position.** On the Wallet, use "Get test simSOL", then "Open a Position" (any amount, Horizon 1–12), and sign. The Position appears with Principal, Debt and Gemas, labelled simulated. The first action also tops up devnet SOL for fees through `/api/demo-advance`. If it answers `503 not-configured`, `TESORO_RELAYER_SECRET_KEY` is missing or malformed: check `vercel logs` for `[keys] …`.
4. **Queue a Match.** In the Lobby, Enter Block Puzzle. The Match opens and the Gemas entry leaves the balance. From a second profile (a second Account), Enter the same game; both land in the same Match. Play it out, or leave it for the keeper.
5. **Keeper.** `fly logs -a tesoro-keeper` shows `alive` lines every ~20 s, `price … ok devnet price feed` (or a `set_price` DONE), and `yield …` cranks once a Position has Debt.
6. **ETH path (if configured).** Wallet > Ethereum: the Hoodi ETH top-up and an ETH Position open, then the Advance step completes. A 503 here points at `TESORO_RELAYER_EVM_PRIVATE_KEY` / `TESORO_ORACLE_SECRET_KEY`. The HYPE tab needs no extra secret: a tester under 0.02 HYPE gets **Get test HYPE** (0.03 HYPE from the relayer's EVM key, once a day per wallet; a 503 `faucet-empty` means the relayer is under 0.08 HYPE on 998, refill it from the deployer); the keeper reports HYPE yield with `KEEPER_HYPEREVM_RPC` (default public) and `KEEPER_MAX_HYPE_PER_HOUR`.

## Known limits

- **HYPE is scarce.** Testnet HYPE needs a mainnet balance, so the whole supply is what the deployer and the relayer hold. The keeper pays `reportYield` (about 0.0074 HYPE per message) from the deployer key, and its default `KEEPER_MAX_HYPE_PER_HOUR` of 0.03 allows only about four reports an hour across all HYPE Positions, so with two or more Positions with Debt some wait for the next hour. Raise it (0.1) while testers are active, and keep at least 0.3 HYPE on the deployer. Each tester drip is 0.03 HYPE: an open plus a couple of Report yield sends.

- **Serverless state is per instance.** Rate limits, request nonces (single-use within 5 min) and the `getProgramAccounts` cache live in memory, one copy per Vercel instance. With the light traffic of a judges' demo, Fluid compute mostly reuses one instance. Under load, though, the quotas multiply and a nonce could be replayed once on another instance. A shared store (Upstash/Vercel KV) would fix this. It is not done.
- **The oracle key is on two hosts.** The oracle publishes the devnet price feed (`set_price`) and co-signs Advances. On Vercel it is only needed for the ETH Advance. Leave `TESORO_ORACLE_SECRET_KEY` unset to keep it only on the keeper, at the cost of the ETH Advance.
- **Keeper state is ephemeral.** The keeper's state directory (`/tmp/tesoro-keeper`, the last `reportYield` per Position) is lost on restart. The next pass may then re-send one `reportYield` per ETH Position. `KEEPER_MAX_ETH_PER_HOUR` bounds the cost.
- **`keeper/fly.toml` is untested against Fly.** It parses as TOML, but `fly config validate` needs a login and wasn't run. The first `fly deploy` validates it.

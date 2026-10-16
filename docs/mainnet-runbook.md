# Mainnet launch runbook

Status: plan (ticket 37 of the mainnet launch). **Nothing in this document has been run.** No program is deployed on mainnet, no vault exists, no admin call has been sent, no account at any provider has been created. Every command below is written from the code and docs of the integrated branch and has not been executed against a mainnet cluster; read each one against the file it points to before you run it. The founders run this runbook. Agents never run any step (no deploy, no upgrade, no admin call, no Vercel or DNS change).

Target: waitlist access on mainnet on **Dec 1, 2026**, latest **Dec 15**. "T-14" means Nov 17, "T-7" Nov 24, "T-1" Nov 30 for a Dec 1 launch. If the date moves, move every day with it; the only fixed gaps are the ones named under "Waits" below.

What the founders get at the end: a mainnet Tesoro where only waitlist members with an Invite can create an Account (ADR 0012), Positions open on jitoSOL, wstETH and kHYPE (ADR 0011), yield is computed and nothing is cranked (ADR 0010), and every authority sits behind the multisig (`docs/mainnet-keys.md`).

## Read first

| Topic | Doc |
|---|---|
| Keys, multisig, hand-over order | `docs/mainnet-keys.md` |
| Every env var per deployment, Vercel and DNS hand-off | `docs/environments.md` |
| Vaults, zaps, LayerZero wiring and DVN set | `docs/cross-chain.md` ("Mainnet vaults", "Opening with plain ETH or HYPE", "Mainnet wiring") |
| Staking token, Pyth mapping, Invite gate, entry sizes, Season window | `docs/tesoro-core.md`, ADR 0010, 0011, 0012 |
| Keeper jobs, alerts, hosting | `keeper/README.md` |
| Invite emails | `docs/invites.md` |
| How the devnet upgrade of the same programs was planned (same shape: drain, order, smoke) | `docs/deployments.md` ("Mainnet-launch branch: devnet upgrade") |

Roles used below: **F** = a founder with a Squads member hardware wallet; **F+F** = two founders approving a Squads proposal or Safe transaction; **Deployer** = the throwaway single-purpose Solana key that deploys programs (it holds SOL for buffers and nothing else after the hand-over); **Partner** = whoever owns DNS at GoDaddy.

## Decisions needed before T-14

Settle these first. The runbook marks the step each one blocks. The full list with a recommendation is at the end ("Open decisions").

1. Program IDs: reuse the devnet IDs or generate new ones (blocks T-7 step 1).
2. LayerZero required DVNs: 2, 3 or 4 (blocks T-7 step 5).
3. Safe owner on HyperEVM mainnet, if no Safe exists there (blocks T-14 step 1).
4. Studio recipient per Game and the company wallet that receives Treasury withdrawals (block T-7 init).
5. Whether MagicBlock mainnet endpoints are ready for the three Games (see "Blockers found while writing this", item 1). Without them the Games cannot run on mainnet at all.

## Waits you cannot compress

- Provider accounts that need review (Helius plan, Privy production app, Resend domain verification, Turnstile) take days: start them at T-14 or earlier.
- DNS records for the Resend sending domain need the Partner; allow a few days for verification.
- The Squads time lock you choose is a wait on every admin step below (10 to 15 minutes recommended in `docs/mainnet-keys.md`); budget it into the init day.
- jitoSOL's stake pool must have updated in the current epoch for any stake instruction to work (about every 2 days). Plan the smoke steps inside one epoch.

---

## T-14 days: accounts, keys, funding

Do these before anything is deployed. Check each one off before moving on.

### 1. Multisig, Safes and hot keys (F, F+F)

Follow `docs/mainnet-keys.md` ("The multisig", "Order of operations" steps 1 and 2).

1. Create a Squads v4 multisig, 2-of-3, on Solana mainnet-beta in the Squads app. Members: the two founders' hardware wallets and an offline backup hardware wallet in a different place. Config authority: none. Time lock: 10 to 15 minutes (shorter than the 48 h Season window by a wide margin).
   Check: the multisig page lists three members and threshold 2; copy the vault address (`["multisig", multisig, "vault", 0]`, vault index 0).
2. Prove the signers: send 0.001 SOL to the vault, then move it out with a proposal that both founders approve and execute.
   Check: the SOL arrived at the destination and the proposal shows Executed.
3. Create a Safe on Ethereum mainnet and a Safe on HyperEVM mainnet with the same three signers (Safe app).
   Check: both Safe addresses recorded; each shows 2 of 3. If HyperEVM has no usable Safe, record the weaker owner you chose in `docs/mainnet-keys.md` (decision 3).
4. Generate the hot keys on their hosts: `keeper` (Solana), `oracle` (Solana), `invite` (Solana), `keeper-evm` (EVM). Never reuse a devnet key; never the compromised `AXwY...` key. Note the public keys.
   Check: four distinct public keys, none equal to the deployer, the vault or a Safe.
5. Generate a fresh Deployer Solana key and a throwaway EVM deployer key, offline or on a clean machine.
   Check: neither is `7zr1j185...qh7M` (the devnet deployer is not reused on mainnet).

### 2. Funding (F)

Amounts are estimates from the devnet rent formula (6,960 lamports per byte incl. header) and the sizes in `docs/deployments.md`; re-check against the final `.so` sizes. At the exact size the five programs need about 29 SOL of rent (`tesoro_core` 1.60 MB, `tesoro_bridge` 0.80 MB, `block_puzzle` 0.62 MB, `holdem` 0.65 MB, `trading_duel` 0.53 MB). Deploying with `--max-len` headroom for later upgrades costs more (25% headroom is about 36 SOL); the alternative is `solana program extend` later, as was done on devnet.

| Wallet | Fund with | Why |
|---|---|---|
| Deployer (Solana) | 40 SOL | Rent of five programs plus buffers and fees; the buffer rent becomes the program's rent. |
| Squads vault | 0.5 SOL | Rent for its Tesoro Account, the Treasury's and Stake accounts it creates, buffers it pays. |
| `keeper` | 2 SOL | Cranks, rent, LayerZero fees (cap `KEEPER_MAX_SOL_PER_HOUR`, `KEEPER_MAX_LZ_SOL_PER_HOUR`). |
| `oracle` | 1 SOL | Seasons: Season account rent, rank payments, winner Holdings (under 0.04 SOL in a busy week). |
| `invite` | 0.1 SOL | Probably only signs; confirm the Player pays rent (the redeem route makes the Player the fee payer). |
| EVM deployer, Ethereum | 0.15 ETH | Gas for the adapter, vault and zap deploys. |
| EVM deployer, HyperEVM | 10 HYPE | Gas, and the vault is about 3.37M gas on big blocks. |
| `keeper-evm`, Ethereum and HyperEVM | 0.05 ETH, 2 HYPE | Gas plus LayerZero fee for Yield Reports. |
| Real test funds | 0.5 SOL, 0.02 ETH, 6 HYPE on a Player wallet | Smoke at T-7 and T-1 (kHYPE zap minimum stake is 5 HYPE). |

Check: each balance read with `solana balance <addr> --url <mainnet rpc>` / `cast balance <addr> --rpc-url <rpc>`.

### 3. Providers (F; Partner for DNS)

Follow `docs/environments.md` "Hand-off: what the founder does".

1. **Helius** (mainnet): one server key (`TESORO_BASE_RPC`, `TESORO_GPA_RPC`, serves `getProgramAccounts`), one separate keeper key (`KEEPER_RPC`, `KEEPER_GPA_RPC`), one browser key restricted to `www.playtesoro.com` (`NEXT_PUBLIC_SOLANA_RPC`).
   Check: `curl -s -X POST <server url> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}'` returns `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`; `getProgramAccounts` on any small program answers.
2. **Alchemy**: Ethereum mainnet and HyperEVM mainnet; browser keys restricted to `www.playtesoro.com` (`NEXT_PUBLIC_ETHEREUM_RPC`, `NEXT_PUBLIC_HYPEREVM_RPC`), server/keeper keys for `KEEPER_HOODI_RPC` (it is the Ethereum RPC on mainnet, the name is historical) and `KEEPER_HYPEREVM_RPC`.
   Check: `cast chain-id --rpc-url <url>` prints 1 and 999.
3. **Vercel**. Two projects, per `docs/environments.md`: the existing `tesoro` project keeps serving `www` in test mode until launch day; create a second project from the same repo (root `app`, Node 22) named for the test host, and move test mode to `test.playtesoro.com` (Partner adds the `test` CNAME). Then **mainnet env is prepared on a preview, not on the live `www` project** (see T-1).
   - Important: the existing `tesoro` project carries the test-mode relayer and oracle secrets (`TESORO_RELAYER_SECRET_KEY`, `TESORO_ORACLE_SECRET_KEY`, `TESORO_RELAYER_EVM_PRIVATE_KEY`). `docs/mainnet-keys.md` requires that the mainnet web project does NOT carry them. Plan to delete those three before the mainnet redeploy (launch day step 1), or build the mainnet env on a fresh project and move the `www` domain to it instead (cleaner; decide now).
   Check: the test host loads in test mode with its own env and `robots.txt` has `Disallow: /`.
4. **Supabase**: a separate mainnet project (recommended in `docs/environments.md`). Apply `app/supabase/migrations/0001` to `0005` in order, and any later `000N` that exists on the launch commit: `ls app/supabase/migrations` and apply every file. Each runs once.
   Check: tables `waitlist`, `notify_settings`, `notify_events`, `invites`, `age_confirmations` exist, `invites.sent_at` exists, RLS is on (the anon role has no access).
5. **Waitlist migration decision**: the waitlist is the source of Invite recipients. Copy the real waitlist rows from the current `tesoro-waitlist` project into the mainnet project's `waitlist` table (founders: SQL export/import), or point `send-invites.ts` at the project that holds the waitlist. Decide which; `send-invites.ts` reads `SUPABASE_URL` and the `waitlist` and `invites` tables of one project.
   Check: `select count(*) from waitlist` in the project the script will use matches the expected sign-ups; `invites` is empty.
6. **Privy**: a separate mainnet app (recommended). Allowed origins `https://www.playtesoro.com`; Solana mainnet, Ethereum (1) and HyperEVM (999) enabled. App id goes into `NEXT_PUBLIC_PRIVY_APP_ID` of the mainnet env.
   Check: a sign-in from a preview deployed with the new id succeeds with an external wallet.
7. **Resend**: verify the sending subdomain of `playtesoro.com` (Partner adds the DNS records). `NOTIFY_FROM` like `Tesoro <hello@mail.playtesoro.com>`.
   Check: Resend shows the domain Verified; a test send from the dashboard reaches a founder inbox.
8. **Turnstile**: a widget with `www.playtesoro.com` (and the test host) as hostnames; both keys set on the project or enforcement stays off.
   Check: the waitlist form on a preview rejects a request with a bad token and accepts a real one.
9. **Secrets for the web project** (generate now, store in the password manager; set on launch day): `NOTIFY_SECRET` (32+ random bytes hex, also on the keeper), `ALERT_EMAILS`, `ADMIN_WALLETS`, `INVITE_SECRET_KEY` (the `invite` key), `SUPABASE_*`, `RESEND_API_KEY`.

### 4. Legal and access gate (F)

Before real money is open to anyone: Terms and Privacy for Gemstone Labs, Inc. read by counsel for the markets you allow (ticket 28 shipped the pages; the legal read is a decision, see "Open decisions"). Decide US availability and any geoblock now: the code has no geoblock (see "Blockers found while writing this"). Check: a written decision exists.

---

## T-7 days: deploy and initialise

Order matters. Do these on one working day with both founders available; the Squads time lock sits inside it. Nothing here opens the app to players.

### 1. Solana programs (F, Deployer)

**Decision first: program IDs.** The app, keeper and IDL copies hard-code the devnet IDs (`CLAUDE.md` table), and the bridge's EVM peer address (`0x60ae58df...c792`, derived from the Store PDA under `5bzDVZ...vTQ`) is already computed for them (`docs/cross-chain.md`). Reusing the IDs needs the existing program keypairs from `~/.config/tesoro/deploy-keys/` and no code change. New IDs need a code change (`declare_id!`, IDL copies, app/keeper constants, the bridge peer) and a rebuild and re-test before deploy. Recommendation: reuse the IDs, copy the program keypairs once to the clean deploy machine, and destroy the copies after the deploy (the upgrade authority, not the program keypair, controls the program afterwards). The program keypairs have lived on a laptop that also held the key that leaked on 2026-10-01; if the founders do not accept that, generate new IDs and budget a day for the change and re-test.

1. Build from the tagged launch commit on a clean machine: `export TMPDIR=$HOME/.cache/tesoro-tmp` then `pnpm build:programs` (platform tools v1.54, see `CLAUDE.md`). Prefer a verifiable build; record the sha256 of each `.so`.
   Check: `sha256sum target/deploy/*.so` recorded; `cargo test --workspace` green on the same commit; the IDL copies in `app/src/lib/chain/idl/` equal `target/idl` (`cmp`).
2. Deploy each program with the Deployer key to the Helius mainnet RPC: `solana program write-buffer target/deploy/<name>.so --url <rpc> --keypair <deployer>` then `solana program deploy --program-id <program keypair> --buffer <buffer> --max-len <len> --upgrade-authority <deployer> --url <rpc> --keypair <deployer>`. Order: `tesoro_core`, `block_puzzle`, `holdem`, `trading_duel`, `tesoro_bridge`. Do not deploy `sim_lst` (test mode only).
   Check: `solana program show <ID> --url <rpc>` for each shows the Deployer as upgrade authority and the expected ProgramData length; `solana program close --buffers` leaves no buffers.
3. **Initialise `tesoro_core` immediately after its deploy, before anything else.** `initialize_config(oracle_authority, platform_bps)` is signed by whoever calls first and that signer becomes `Config.admin`; it is not restricted to the upgrade authority (`programs/tesoro_core/src/instructions/admin.rs`). Anyone watching the chain could front-run the gap between the deploy and the call. Call it within the same session, then read `Config` and confirm `admin` is the Deployer (if it is anyone else, `set_admin` signed by the upgrade authority takes the admin back, `docs/mainnet-keys.md` "Rotation steps").
   Needs first: the fee recipient Account (see step 6). There is no mainnet script for `initialize_config` (see gaps).

### 2. Ethereum and HyperEVM vaults and zaps (F+F for the Safe; EVM deployer)

Follow `docs/cross-chain.md` "Mainnet vaults on the formula vault" and "Opening with plain ETH or HYPE".

1. Ethereum: `forge script script/DeployMainnetWstETH.s.sol --rpc-url <ethereum rpc> --broadcast --slow` from `contracts/` with `VAULT_OWNER` = the Ethereum Safe and the EVM deployer key in the env variable the script reads (check the script header; do not paste keys into the shell history). Then deploy `LidoZap(vault, wstETH)`.
2. HyperEVM: switch the EVM deployer to big blocks (`evmUserModify usingBigBlocks`, as in `docs/deployments.md`), then `forge script script/DeployMainnetKHype.s.sol --rpc-url <hyperevm rpc> --broadcast --slow` with `VAULT_OWNER` = the HyperEVM Safe, then big blocks off. Then deploy `KinetiqZap(vault, kHYPE, stakingManager)`.
3. **Verify the token addresses on chain before deploying**, do not trust the docs alone: wstETH `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` on Ethereum (`cast call <addr> "stEthPerToken()(uint256)"` returns about 1.2 or more, and `symbol()` is `wstETH`); kHYPE `0xfD739d4e423301CE9385c1fb8850539D657C296D`, StakingAccountant `0x9209648Ec9D448EF57116B73A2f081835643dc7A` (`kHYPEToHYPE(1e18)`), Kinetiq StakingManager `0x393D0B87Ed38fc779FD9611144aE649BA6082109` on HyperEVM. The fork tests (`ETH_MAINNET_RPC=... HYPEREVM_MAINNET_RPC=... forge test --match-contract Fork`) must pass on the launch commit.
   Check: each deploy prints its addresses; `cast call <vault> "owner()(address)"` returns the Safe; the endpoint's `delegates(vault)` returns the Safe; the adapter returns a rate; both fork suites green. Record the vault and zap addresses.
4. Do not deploy `SimLST` or any sim vault on mainnet.

### 3. LayerZero wiring (F for Solana, F+F for the Safes)

Follow `docs/cross-chain.md` "Mainnet wiring" run order exactly; this section only adds the decisions.

1. **Decision: DVN count** (open decision 1). The script default is LayerZero Labs + Nethermind (2 required); LayerZero's own default on all three pathways is 4 required (adds Canary, Horizen). A message mints Gemas, so use 3 or 4. Pass the chosen set as `--dvns layerzero-labs,nethermind,canary[,horizen]`; `--verify` checks exactly that set.
2. Decide the Solana delegate: the Deployer until `tesoro_bridge.set_admin` moves it to the vault (step 5 below).
3. Dry run each pathway, read every address against the table in `docs/cross-chain.md`, then execute the Solana half: `cd bridge && pnpm install --frozen-lockfile --ignore-workspace && pnpm lz-mainnet --pathway ethereum --vault 0x<vault> --safe 0x<Ethereum Safe> --delegate <Deployer pubkey> --decimals 18 --rate-bps <bps> --dvns <set> --program-id <tesoro_bridge ID> --rpc <helius> --evm-rpc <ethereum rpc>` (add `--execute --keypair <deployer file>` to send the Solana steps). Same for `--pathway hyperevm`. The first run also does `init_store`.
   `--rate-bps` is what every Advance on that vault is sized on: compute it from the adapter's recent growth (`docs/cross-chain.md` "APY on the form"), `growth x 365 / 7 x 10,000`.
4. F+F send the printed EVM calls from the Safe (`--safe-json batch.json` writes a Safe Transaction Builder batch): `setPeer(30168, Store PDA)`, libraries, executor, ULN config.
5. Verify: `pnpm lz-mainnet ... --verify --rpc <helius>` must end with "All checks passed" for both pathways. Then `SOLANA_RPC=<helius> SOLANA_KEYPAIR=<funded key> pnpm lz quote <eid> <vault> 3` and, on EVM, `quotePositionLocked()` and `quoteYieldAccrued()` return a fee.
6. **One small real message each way, each pathway, before anything else depends on it** (`docs/cross-chain.md` run order step 4): `init_position`, then `openPosition` of a minimal amount through the vault (or the zap), `apply_locked`, `reportYield`, `apply_yield`, then a Solana-to-EVM message (Unlock or `PayYield`). Needs the Solana core init to be done (step 5 of this section) so `apply_locked` can run.
   Check: LayerZero Scan (`layerzeroscan.com`) shows DELIVERED for every message, in both directions, on both pathways; the Position appears on the Solana side with the right Principal. Budget: the vault-to-Solana leg took about 2 minutes on testnet.

### 4. Pyth feed addresses and ids (F)

`set_onchain_price` needs, per asset, the Pyth sponsored push feed account (owned by the Pyth receiver program, shard 0) and its 32-byte feed id; the program refuses a feed whose account does not carry that id, so a wrong id fails the transaction instead of mapping a wrong feed.

| Asset | Feed account (from ticket 12) | Feed id |
|---|---|---|
| jitoSOL (SOL/USD) | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` | SOL/USD id from Pyth's price feed list (starts `ef0d8b6f...`); copy the full id from the feed account's data bytes 41 to 72 |
| ETH Source | `42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC` | ETH/USD id from Pyth's list |
| HYPE Source | `6usXZCEM4kf1KHGDTzgQLAWtDMNdzLjfAUYSwGKJm19Y` | HYPE/USD id from Pyth's list |

Check each account before the proposal: `solana account <feed> --url <rpc>` shows owner `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` (Pyth Solana receiver) and 134 bytes. Parameters: max age 90 s, confidence 100 bps (1%). Suggested; ADR 0011 says "tighter limits, 90 s and 1% at launch". The `asset` key for the ETH and HYPE mappings is the Source's asset key the bridge uses (ticket 12 comment calls it the "ETH source key"); the docs do not state how to derive it (see gaps), so read it from a test Position's `source_asset`.

### 5. `tesoro_core` init calls, in this order (F, then F+F once the vault is admin)

Order comes from ticket 41 (superseding the earlier trailing-APY and keeper-published-APY notes) and `docs/mainnet-keys.md`. There is no print-mode script for any of these yet (see gaps): the instruction builders exist in `app/src/lib/chain/stake.ts` (`initTreasuryStakeIx`, `setStakeTokenIx`, `setStakeApyCeilingIx`) and `keeper/src/mainnet-keys.ts` (`setInviteGateIx`) but need a small admin script or a Squads proposal builder. Write that script and its test before this day; agents write it, founders run it.

Do the calls with the Deployer (still `Config.admin`) in 5a to 5k where noted, then hand over (step 6). The vault becomes admin at step 6, so any call after that is a Squads proposal.

a. **Fee recipient Account**: `create_account` with the vault as authority, via a Squads proposal (the vault is a PDA and cannot sign a normal transaction). It does not need `Config`. Needs the vault funded. Do this before `initialize_config`.
   Check: account `["account", vault]` exists on `tesoro_core`.
b. **`initialize_config(oracle_pubkey, platform_bps)`** with the fee recipient Account from (a) (see step 1.3). `platform_bps`: 200 is the devnet placeholder (`docs/tesoro-core.md`); confirm the final Platform Fee, because `Studio Fee + Platform Fee + Leaderboard Fee` are capped at 50% together.
   Check: read `Config`: admin = Deployer, oracle = the `oracle` key, recipient = the vault's Account.
c. **`init_treasury_stake(2000, 2500)`**: Yield Fee 20%, Instant Redeem Fee 25% (75% paid). Do NOT use `init_treasury` on mainnet (it needs the simSOL mint). Create the Treasury before any Position: its Yield Fee is copied onto each Position at open.
   Check: Treasury account exists; fees read 2000 and 2500.
d. **`set_stake_token()`** with mint jitoSOL `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn` and stake pool `Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb`.
   Check: `StakeCustody` `["stake_custody", mint]` has `pool` equal to the pool above; the pool account is owned by `SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy` (`solana account <pool> --url <rpc>`); `StakeConfig.active_mint` = jitoSOL. Verify the jitoSOL mint and pool addresses on a block explorer against Jito's published addresses before sending (they are only in the docs and tests today).
e. **`set_stake_apy_ceiling(800)`** (8%; allowed range 1 to 2,000 bps). Without it no Advance is sized (`StakeCeilingNotSet`). There is no way to set it back to zero (see rollback).
   Check: `StakeConfig.apy_ceiling_bps` = 800.
f. **`set_onchain_price`** for jitoSOL, ETH and HYPE (section 4).
   Check: `OnchainPrice` `["onchain_price", asset]` exists for each, with the feed and limits you set.
g. **`set_entry_sizes([100, 500, 1000])`** (1 to 4 distinct non-zero multiples of 100). Unset means the test ladder 500 / 1,000 / 2,500, so this call is required on mainnet; the app mirrors it in `cluster-settings.ts` and a mismatch breaks entry.
   Check: read `Config.entry_sizes`.
h. **`register_game`** for `block_puzzle`, `holdem`, `trading_duel` with each Studio Fee (300 bps on devnet; confirm) and each Studio recipient Account (a new Account on mainnet; devnet's is the deployer's). Existing script `keeper/scripts/register-game.ts` hard-codes the devnet RPC default, the devnet core ID and the devnet deployer key path: do not run it as is on mainnet.
   Check: the Game registry lists three Games with the fee and recipient.
i. **`init_leaderboard(100)`** (Leaderboard Fee 1%). The same hard-coded-devnet caveat applies to `keeper/scripts/init-leaderboard.ts`. Season 1 starts at the program's fixed epoch (Monday 2026-10-05 00:00 UTC), so the first mainnet Season is whichever week the clock is in; the first Season is partial.
   Check: `Config` has a pool Account and `leaderboard_bps` 100.
j. **`set_treasury_company(company)`** before any `withdraw_treasury_stake` (the company wallet is a founder decision).
k. **`init_native_custody`**: not needed on mainnet (jitoSOL uses `StakeCustody`); skip unless a test path needs simSOL, which mainnet does not have.
l. **Source authorities** for ETH and HYPE (`set_source_authority`) and the bridge's `set_peer_config` for each vault, with `rate_bps` as in the wiring step. Without them `apply_locked` cannot run (verify against `docs/cross-chain.md` "`tesoro_core` changes").
   Check: reading the `SourceAuthority` PDAs for chain bytes Ethereum and HyperEVM shows the bridge's signer; `PeerConfig` for eids 30101 and 30367 exists.
m. **Whitelist the TEE validator** for each Game program in MagicBlock's delegation program (`keeper/scripts/whitelist-tee.ts` hard-codes the devnet TEE pubkey, RPC and deployer key; see blockers).

### 6. Hand-over to the multisig (F, then F+F)

Follow `docs/mainnet-keys.md` "Order of operations" steps 5 to 6 exactly. Use the dry run first:

`pnpm --filter @tesoro/keeper exec tsx scripts/mainnet-keys.ts --vault <VAULT> --current <DEPLOYER> --oracle <ORACLE> --platform-bps <bps> --invite <INVITE> --program tesoro_core=<ID> --program block_puzzle=<ID> ...`

(read the script header for the full flag list; `--include-sim-lst` is not used on mainnet). Read every account and the order, then `--execute --rpc <helius> --keypair <deployer file>`. The order is fixed: `update_config` (oracle and fee recipient), `set_admin` on `tesoro_core` and `tesoro_bridge`, the Invite gate step, upgrade authority of each program last, then `setDelegate`/`transferOwnership` on the vaults if they were not deployed with the Safe as owner (printed `cast` commands).

**Careful:** `mainnet-keys.ts` with `--invite` also plans `set_invite_gate` (gate ON). Create the vault's own Account first (step 5a, already done) so the gate cannot lock the vault out; keep the gate step AFTER everything that needs `create_account`. A `create_account` for another Account (Squads test, founder wallets) must therefore also happen before the gate is on, or use the Invite flow.

Check, for every program: `solana program show <ID>` shows the vault as upgrade authority; `Config.admin` and `Store.admin` equal the vault; the LayerZero delegate on each endpoint equals the vault / Safe; make one no-op vault proposal (`update_config` with the same values) and watch it execute. Only then retire the Deployer: leave a dust balance and never use it again.

### 7. The mainnet keeper (F)

The first draft of this runbook said to start the keeper 7 days early so a trailing APY could publish (ticket 11); that is superseded. Mainnet SOL needs no keeper job for yield (ADR 0010, ticket 41). Start the keeper at T-7 anyway: its other jobs (Match hygiene, Seasons, bridge relays, Treasury redeems, away, alerts) should be proven for a week before real players arrive, and a first Season record needs it.

1. On the VPS create a second systemd user unit, separate from the test keeper, with its own env file (mode 600) and its own state dir (`KEEPER_STATE_DIR`): `TESORO_CLUSTER=mainnet`, `KEEPER_RPC`, `KEEPER_GPA_RPC`, `KEEPER_HOODI_RPC` (Ethereum), `KEEPER_HYPEREVM_RPC`, `KEEPER_SECRET_KEY`, `KEEPER_ORACLE_SECRET_KEY`, `KEEPER_EVM_PRIVATE_KEY` (the dedicated `keeper-evm` key; on mainnet the keeper never reads the deployer file), `KEEPER_KEYS_FROM_ENV=1`, `NOTIFY_URL=https://www.playtesoro.com/api/notify/`, `NOTIFY_SECRET`, `KEEPER_HEALTH_PORT` a second port (the test keeper holds 8787) and `KEEPER_HEALTH_HOST=127.0.0.1`, `ALERT_ORACLE_SOL_ADDRESS`, `ALERT_KEEPER_EVM_ADDRESS`, plus `KEEPER_MAX_*` caps reviewed. Full list: `docs/environments.md` "Keeper". Exactly one keeper per cluster; the test keeper stays on test.
   Until launch the keeper's `NOTIFY_URL` target (www) is still test-mode: alert mails go through the test web project. Either point `NOTIFY_URL` at the mainnet preview host that already has `NOTIFY_SECRET` and `ALERT_EMAILS`, or leave notify off until launch day and accept no alerts for the week. Decide.
2. Start it: `systemctl --user enable --now tesoro-keeper-mainnet`, `journalctl --user -u tesoro-keeper-mainnet -f -o cat`, `curl -s 127.0.0.1:<port>/healthz`.
   Check: the log says the RPC is Solana mainnet-beta (genesis check), every job runs a pass without error, `healthz` is 200, no job raises an alert for two days, the keeper's payer and `keeper-evm` balances are above the alert thresholds.

---

## T-1 day: smoke on a preview with mainnet env

Deploy a Vercel **preview** (not production) of the launch commit with the full mainnet env (`docs/environments.md` matrix, "Mainnet www" column): both cluster vars `mainnet`, three RPC groups, `NEXT_PUBLIC_WSTETH_VAULT`, `NEXT_PUBLIC_KHYPE_VAULT`, `NEXT_PUBLIC_LIDO_ZAP`, `NEXT_PUBLIC_KINETIQ_ZAP`, Privy, Supabase, Resend, `NOTIFY_*`, `ALERT_EMAILS`, `ADMIN_WALLETS`, Turnstile, `INVITE_SECRET_KEY`, `NEXT_PUBLIC_SITE_URL`, and none of: `NEXT_PUBLIC_DEV_WALLET`, `TESORO_RELAYER_*`, `TESORO_ORACLE_SECRET_KEY`. Previews do not inherit production env: set them for the Preview environment of the mainnet-prepared project.

Smoke with small real funds (a Player wallet funded in T-14; amounts of the order of 0.01 SOL-worth). Each line is pass or stop.

1. Preview boots: server log says `[cluster] ... is Solana mainnet-beta`; `/lobby` shows no test-mode footer or simulated labels; ETH and HYPE tabs list the vaults (not "not available yet").
2. Invite: with the gate on (T-7), a wallet without an Invite cannot create an Account; create one test Invite (`send-invites.ts` dry run, then a single `--limit 1 --send` to a founder email, see `docs/invites.md`); redeem it from that wallet; the Account is created and the Invite's email is the notification email.
3. Open a Position with **jitoSOL** and with **plain SOL** (`DepositSol` in the same transaction): Principal recorded, Position visible.
4. Take an **Advance**: priced from Pyth (the stake pool is not stale; the pool's `last_update_epoch` within one epoch), Gemas minted, Unlock Estimate shown.
5. **Match**: two wallets, one entry at 100 Gemas, a Game of each kind that is enabled; settle; Points and the Pool fee; Match emails and the digest.
6. **Redeem** the won Gemas: pays jitoSOL.
7. **Instant Redeem**: with an empty Treasury it must show as unavailable (Treasuries start empty); after a Yield Fee has accrued or the Treasury holds enough, it pays 75%. If no yield has accrued yet, only the "unavailable" half can be shown on day one; say so in the sign-off.
8. **ETH open via the Lido zap** and **HYPE open via the Kinetiq zap** (stake of at least 5 HYPE): the form shows the token received, gas and LayerZero fee before signing; the Position appears on Solana after about 2 minutes; Advance on it; an EVM Redeem or Unlock completes after its Yield Report lands.
9. **Unlock** a SOL Position after repaying (or on a fresh Position with no Advance): pays the jitoSOL; Principal returns.
10. **Emails**: a Match-settled email, a Delayed email (leave a Match unsettled past its deadline on a test Game, or use the keeper dry run), and the daily digest reach a founder inbox once each.
11. **Alerts**: stop the mainnet keeper's `season` job or set `ALERT_JOB_FAILS=1` on a staging copy; the founders get one alert mail and one "recovered" mail.
12. `/admin/review` opens for a wallet in `ADMIN_WALLETS` and refuses another.
13. Season window: the keeper records a Season at its end (`season_window` created); `pay_season_rank` before 48 h fails with `PayoutWindowOpen`; `void_season_rank` works from the vault (Squads proposal).
14. Wallet and Lobby at 1440 and 390 px, signed out and signed in, no console errors.

Sign off: write the result of each line (with transaction signatures) into `docs/deployments.md` under a new "Mainnet" section, as was done for every earlier network. If any line fails, do not launch; fix, redeploy the preview, and repeat only the affected lines plus 1 and 2.

---

## Launch day

1. **Switch www to the mainnet env** (F). In the project that serves `www` (decision made at T-14: edit the existing project, or move the domain to the prepared one): set `TESORO_CLUSTER=mainnet`, `NEXT_PUBLIC_TESORO_CLUSTER=mainnet`, the RPC groups, vault and zap addresses, the mainnet Privy, Supabase, Resend and Turnstile values, `NEXT_PUBLIC_SITE_URL=https://www.playtesoro.com`, `INVITE_SECRET_KEY`. Delete `TESORO_RELAYER_SECRET_KEY`, `TESORO_ORACLE_SECRET_KEY`, `TESORO_RELAYER_EVM_PRIVATE_KEY`, `NEXT_PUBLIC_DEV_WALLET`, and anything test-only. A push to `main` deploys production by itself (`CLAUDE.md`), so redeploy the **launch commit** explicitly (`vercel redeploy` / deploy from a clean worktree), because the public vars are inlined at build time.
   Check: `/robots.txt` allows crawling; `/lobby` shows no test-mode footer; the server log says `is Solana mainnet-beta`; `/api/` routes that need relayer or oracle answer "not configured" (they must).
2. **Test host in place** (F, Partner): the old devnet app is served on `test.playtesoro.com` with its own keeper (unchanged). Post a note: devnet Gemas stay on the test host (`docs/environments.md` launch step 5).
3. **Run the smoke list** against production (T-1 lines 1, 2, 3, 4 at minimum, with a fresh Invite).
4. **Confirm the gate is on**: read `InviteGate` (`required = true`), and try `create_account` from a wallet with no Invite on the site: it must fail.
5. **Send the first Invite batch** (F): `pnpm --filter @tesoro/keeper exec tsx ../app/scripts/send-invites.ts --limit 20` (dry run; read who gets it and the email text), then the same with `--send`. Members go oldest sign-up first. Exports: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `NOTIFY_FROM` of the mainnet project, and `INVITE_SITE_URL` if the origin differs (`docs/invites.md`). Start small (20), then widen after an hour. Exit code 1 means some sends failed: run it again to retry only those members.
   Check: the first recipient redeems and creates an Account; `invites` rows show `sent_at` and `used_by_authority`.
6. **Watch** for at least the first two hours, then every 4 hours for the first week: the mainnet keeper journal and `healthz`, the alert mails, the Treasury balance, the `keeper`/`oracle`/`keeper-evm` balances, LayerZero Scan for any message not DELIVERED, Squads proposals pending, `/admin/review` for suspicious play, Helius and Alchemy rate usage, and the daily digest.
7. After the first batch behaves for a day, keep sending Invite batches (docs/invites.md); the public launch is ~January 2027 and is `set_invite_gate(false)` by the vault.

---

## Rollback: what can be undone, and how

Be precise: many things cannot be undone. This lists only levers that exist in the code today.

| Situation | Lever that exists | What it does | What it does not do |
|---|---|---|---|
| Too many Accounts, or a bug found right after Invites | Stop sending Invites; keep `InviteGate.required = true` (do nothing). `set_invite_gate(required, key)` by the vault can also set a new Invite key. | New Accounts cannot be created without an Invite. | Does not touch existing Accounts, Positions or Matches. There is no instruction that closes or freezes an Account. |
| Bad Invite key (leaked `invite` key) | Vault `set_invite_gate(true, new_key)`; replace `INVITE_SECRET_KEY` on the web project; redeploy. | Old key stops working. | Accounts already created stay. Void abusers' Season payouts through the suspicious-play page. |
| Cheating or abuse in a Season | `void_season_rank(rank)` by the admin (vault) inside the 48 h window; unpaid share rolls over. | Stops that rank's payment. | Once paid, nothing claws it back. |
| A Game misbehaves | `remove_game(game)` by the admin. | Stops new Matches/Requests/Offers for that Game (the Game lookup fails with `GameNotRegistered`, `matching.rs`, `backing.rs`). | Whether in-flight Matches of a removed Game can still settle was not checked while writing this. Do not rely on it. Existing Matches refund through `refund_match` after their deadline. |
| New Advances on one ETH/HYPE vault | Bridge `set_peer_config` with `rate_bps = 0` for that vault (the app shows "APY -" and sizes no Advance). | Stops new Advances on that vault. | Does not stop opens (Locks) or Redeems; open Positions keep the rate they opened with. |
| New Advances on SOL | None. `set_stake_apy_ceiling` accepts 1 to 2,000 only; zero is not settable. Lowering it to 1 bps shrinks Advances to almost nothing but does not stop them. | Lowers the size of new Advances. | No pause. |
| Open Matches / entries | `set_entry_sizes` accepts only 1 to 4 non-zero sizes. | Changes the ladder for new Matches (open ones keep theirs). | No pause: there is no instruction that stops entries, Position opens or Redeems in `tesoro_core`. A pause for entries needs a program change, or `remove_game` for each Game. |
| ETH/HYPE vaults | No pause in `PositionVaultOApp`. Safe-owned settings: `setPeer`, `setSolanaReceiveCu`, `setYieldFeeBps`. | Clearing the peer (`setPeer`) or the pathway stops messages. | Stopping the pathway blocks Unlock and Redeem for ETH/HYPE Positions, i.e. it traps Players' funds; only do it to stop a forged-message attack, and plan the recovery first. |
| Keeper misbehaves | `systemctl --user stop tesoro-keeper-mainnet`. | Stops cranks. Player-signed paths still work; Matches settle by the Player clients and by the deadlines (`refund_match` after 1 h/24 h). | Seasons stop recording; emails and alerts stop. Restart after the fix. |
| Leaked hot key | Rotation in `docs/mainnet-keys.md`. | Per key. | A leaked `oracle` key can sign a bad Season until the vault's `update_config` executes (min. the Squads time lock). |
| Bad program code | Upgrade to the previous `.so` through a Squads upgrade proposal. Dump the live program BEFORE each upgrade: `solana program dump <ID> prev-<name>.so --url <rpc>`. | Replaces code. | Programs cannot be downgraded in place except by redeploying the old binary through the same authority; data written by new instructions stays, and a layout change (for example `Board` 597 to 845 bytes) is not compatible with the old code. |
| Everything is wrong | Hand-off to public RPC and a notice on the site; put `www` back on the test project; stop sending Invites. | The app stops pointing at mainnet. | On-chain state is untouched and still reachable by anyone who calls the programs directly; the programs have no emergency stop. |

Say it plainly to the team: **there is no global pause in `tesoro_core`, `tesoro_bridge` or the vaults.** The strongest controls are the Invite gate (creation), `remove_game`, the 48 h Season void and a program upgrade (which needs the time lock plus two signers).

---

## Open decisions

For each: what is blocked, and a recommendation (founders decide).

1. **LayerZero required DVNs: 2, 3 or 4.** Script default 2 (LayerZero Labs + Nethermind); LayerZero default 4 (+ Canary, Horizen). Blocks: T-7 step 3. Recommendation: 3 or 4; a message mints Gemas, so a forged one is the largest single risk. Cost: more liveness dependencies.
2. **Entry Limit: fixed period or rolling 7 days.** The built rule is fixed-period accounting (`docs/tesoro-core.md`: refunds and cancelled Offers do not give room back). Blocks: nothing technical today, but it changes the Player-facing rule and a program change. Decide before the audit freezes the code.
3. **EVM rate-dip policy.** Built: growth below the open rate counts as zero, `reportYield` reverts `YieldBelowReported`, `PayYield` retries (`docs/cross-chain.md` "Rate dip"). Open follow-up named there: yield already applied to Debt is not taken back on Solana after a sustained slashing. Decide whether to accept this at launch or add a Solana-side adjustment first.
4. **Program IDs: reuse devnet IDs or new.** See T-7 step 1. Recommendation: reuse, with the keypair-handling note.
5. **Staking partners: Sanctum vs Jito, Lido, Kinetiq.** Built for jitoSOL, wstETH, kHYPE (ADR 0011). The stake pool program allowlist already includes Sanctum's programs. Blocks: the token choice at T-7 step 5d (a second token can be added later; Positions keep their token). No signed partner deal is needed for the code to work, but confirm no contractual or branding issue with using the names.
6. **Safe on HyperEVM mainnet.** Not checked (docs). If absent: another contract wallet or a hardware-wallet owner; the weaker choice must be recorded.
7. **Squads time lock length** and the upgrade policy (verifiable build, who builds). Recommendation: 10 to 15 minutes.
8. **Studio recipient per Game, Platform Fee, Studio Fee (300 bps now), company wallet for Treasury withdrawals.** Blocks T-7 step 5b, 5h, 5j.
9. **Legal review and US availability.** Real-money skill gaming with Gemas backed by yield. Terms and Privacy exist; a legal read for the permitted markets and a decision on blocking the US is not made. The code has no geoblock. Blocks: opening to real money at all; allow time for counsel before T-14.
10. **Whether MagicBlock mainnet is ready for the three Games** (rollup and TEE endpoints, the validator pubkey to whitelist, the delegation program, Pyth Lazer for Trading Duel). Blocks: all Game play on mainnet. See below.
11. **Waitlist data location.** Copy the waitlist rows to the mainnet Supabase project or run the script against the old project (T-14 step 5).
12. **Which Vercel project serves `www` on mainnet** (edit the existing one and strip test secrets, or fresh project and move the domain). Recommendation: fresh project for mainnet; the secret-leak risk of editing disappears.
13. **Alert mails during the pre-launch week** (T-7 keeper `NOTIFY_URL`).
14. **Instant Redeem availability at launch.** Treasuries start empty and fill only from the Yield Fee; day-one Instant Redeem will read "unavailable" for everyone. Confirm the copy is acceptable, or seed a Treasury (ADR 0011 says nobody seeds it).

---

## Blockers found while writing this (not fixed here)

These are gaps between the docs and the code; nothing was changed. Each needs a ticket before the date it blocks.

1. **The Games hard-code devnet MagicBlock endpoints.** `app/src/games/block-puzzle/chain.ts` (`TEE_RPC`, `TEE_WS`, `BASE_RPC`), `holdem/chain.ts` (`BASE_RPC`, `TEE_RPC`) and `trading-duel/chain.ts` (`ER_RPC`, `ER_WS`) point at devnet; `keeper/scripts/whitelist-tee.ts` hard-codes the devnet TEE validator pubkey; there is no cluster switch for them in `cluster-settings.ts`. Without a mainnet change the Games cannot run on mainnet. The mainnet MagicBlock endpoints, the mainnet TEE validator and the delegation setup have not been checked. Blocks T-7 step 5m and T-1 smoke step 5.
2. **No script for several mainnet admin calls.** `initialize_config`, `init_treasury_stake`, `set_stake_token`, `set_stake_apy_ceiling`, `set_onchain_price`, `set_entry_sizes`, `set_treasury_company` for stake, and the Source-authority calls have no keeper script. The builders for four of them are in `app/src/lib/chain/stake.ts` and `keeper/src/mainnet-keys.ts`; the existing scripts (`register-game.ts`, `init-leaderboard.ts`, `fund-treasury.ts`, `withdraw-treasury.ts`, `whitelist-tee.ts`) hard-code the devnet RPC default, the devnet `tesoro_core` ID and the devnet deployer key path, and `fund-treasury.ts` uses simSOL `init_treasury`. `docs/mainnet-keys.md` already notes the need for a print mode.
3. **`initialize_config` can be front-run.** It takes any signer as the admin (the account list has no upgrade-authority check), so an attacker who sees the deploy could initialise the Config first. Recoverable (`set_admin` by the upgrade authority) but would force a messy recovery. Mitigated only by doing it in the same session; a program fix (require the upgrade authority) is the proper answer and belongs in the audit window.
4. **Chicken and egg for the fee recipient.** `initialize_config` needs the recipient Account to exist, which for the vault means a Squads proposal before Config exists; handled above, but it is easy to get wrong.
5. **`mainnet-keys.ts` and the Invite gate.** The script turns the gate on in the same run as the hand-over; any `create_account` still needed (founder test wallets, the Squads proof, the vault's own Account) must be done before it.
6. **The ETH and HYPE `set_onchain_price` asset keys are not documented** (only "the ETH source key" in the ticket comment), and the full Pyth feed ids are not in the docs (SOL/USD is truncated to `ef0d8b6f...`).
7. **Existing `tesoro` Vercel project holds test-mode secrets** that the mainnet policy forbids; removal is a manual step easy to miss. The keeper-alerts `NOTIFY_URL` for the pre-launch week points at a host that is still test-mode.
8. **Config and Treasury state on mainnet have never been exercised.** The `Config` layout on a fresh deploy (entry sizes, Leaderboard) is new; the first mainnet `initialize_config` + `init_leaderboard` + `set_entry_sizes` sequence should be rehearsed on devnet or a local validator with the same script before the day.
9. **No gas or fee measurement on mainnet** (ticket comment: "gas allowance measurement"). The kHYPE vault needs big blocks to deploy (3.37M gas); the LayerZero quote for each pathway and the keeper's caps (`KEEPER_MAX_LZ_FEE_SOL` 0.005, `KEEPER_MAX_ETH_PER_HOUR` 0.005) are testnet values. Measure on the T-7 real messages and set the caps from that.
10. **Mainnet Solana wallet sign-in** (ticket 39) is not covered by any step here beyond the smoke: confirm in T-1 step 1 and 3 that an external wallet, not only the Privy embedded one, signs on mainnet.

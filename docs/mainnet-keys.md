# Mainnet keys and the multisig

Status: plan (ticket 36 of the mainnet launch). Nothing here has been run on any cluster. ADR 0011 sets the rule: program upgrades, admin and fees sit behind a 2-of-3 Squads v4 multisig; the keeper, oracle and Invite keys are separate single-purpose hot keys.

Today (test mode) one devnet key, `7zr1j185zT8r6jcysC4LyrdSEJ13Up3xq4TFu6KQqh7M`, is the upgrade authority of every program, the `tesoro_core` / `tesoro_bridge` / `sim_lst` admin, the LayerZero delegate, the owner of the fee-recipient Account and the Treasury admin. An earlier key (`AXwY...`) leaked on 2026-10-01 and swept its balance. On mainnet that single point of failure goes away.

## The multisig

- **Squads v4** (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`), **2-of-3**, created in the Squads app on Solana mainnet-beta.
- Members: the founder's hardware wallet, the co-founder's hardware wallet, and an **offline backup** hardware wallet kept in a different place (never on a networked machine, never used to sign day to day). No member key is ever a hot key.
- Config authority: none (the multisig changes itself only by its own proposal), so no one can add a member alone.
- Time lock: set one (Squads' own guidance: shorter, 10 to 15 minutes, for program upgrades; longer for treasury moves). Keep it far below the 48-hour Season payout window (ADR 0012) so a void is always possible in time.
- Approve and execute as separate steps; simulate each proposal and read the BPFLoaderUpgradeable "New authority" line before approving.
- The **vault** is the PDA `["multisig", multisig, "vault", 0]`. It is the address every script below takes as `--vault`. It holds no SOL for fees by itself: fund it with a little SOL (rent for its Tesoro Account and for buffers it pays).
- Squads signs by CPI, so the vault is a PDA that cannot sign a normal transaction. That is why authority transfers use the unchecked `SetAuthority` (see Order of operations).

## Keys and roles

"Multisig" means the Squads vault. "Hot" means a single key on a server.

### Solana

| Role | Holder on mainnet | What it can do | Stored |
|---|---|---|---|
| Upgrade authority of `tesoro_core`, `block_puzzle`, `holdem`, `trading_duel`, `tesoro_bridge` (and `sim_lst` in test mode only) | Multisig | Replace a program's code, close it, or move the authority. Everything below follows from it, because `set_admin` on `tesoro_core` and on `tesoro_bridge` is gated on the upgrade authority, not on the admin. | Hardware wallets |
| `tesoro_core` `Config.admin` | Multisig | `update_config` (oracle key, Platform Fee, fee recipient), `list_game` (which Games count as listed; the admin cannot edit or remove a Game record), `init_leaderboard`, `init_treasury` and `fund_treasury` (Yield Fee and Instant Redeem rates, Treasury funding), `set_source_authority` / `remove_source_authority` (who may report a Position's facts for a chain), and as ADR 0011/0011 land: the active Source token and APY ceiling, the Invite key and gate switch, voiding a Player in the Season window. It can also run a Season (`record_season`, `pay_season_rank` accept admin or oracle). | Hardware wallets |
| Fee recipient (`Config.platform_recipient`) | A Tesoro Account whose authority is the multisig vault, `["account", vault]` | Receives the Platform Fee as Gemas of the Sources they came from. To turn them into cash the vault redeems them like any holder (a Squads proposal). | Hardware wallets |
| Game program upgrade authority | The key that deployed the Game | Signs `register_game` and every `propose_game_change` / `apply_game_change` for its Game (tesoro_core reads it from ProgramData). Changes wait 7 days. | Hardware wallet or multisig |
| Studio recipient per Game | A Tesoro Account chosen at `register_game` (founder decision: the vault, or a separate studio wallet per Game) | Receives the Studio Fee. | Hardware wallets or the studio's own custody |
| Treasury | Held by program-controlled accounts; filled from the Yield Fee, nobody seeds it (ADR 0011). `init_treasury` / `fund_treasury` are admin-only. | The admin can change the two fee rates and top up. There is no admin withdrawal. | n/a |
| `tesoro_bridge` `Store.admin` and LayerZero delegate (Solana side) | Multisig | Register a vault peer (`set_peer_config`), and as the LayerZero delegate, change the pathway: send/receive libraries, DVN set, executor. A wrong DVN or peer lets a forged message through, so this is as strong as an upgrade. | Hardware wallets |
| Oracle (`Config.oracle_authority`) | **Hot key `oracle`**, its own keypair | Today: `set_price` (test mode), the price and the Position facts in `take_advance` / `open_position` / `apply_yield`, and `record_season` / `pay_season_rank`. After tickets 11, 12 and 19 to 21: publishes the trailing APY (capped by the admin's ceiling) and records and pays Seasons. It cannot move a Player's Gemas or Principal and cannot upgrade or change settings. | Env secret on the keeper host only |
| Keeper payer | **Hot key `keeper`**, its own keypair | Pays fees and rent for the permissionless cranks (yield accrual, settlement, refunds, treasury redeem, bridge `apply_*` and `send_*`). It has no authority on any program. It also relays MagicBlock commits. Spend is capped by `KEEPER_MAX_SOL_PER_HOUR` and the LayerZero caps. | Env secret on the keeper host only |
| Invite key (ADR 0012) | **Hot key `invite`**, its own keypair | Co-signs `create_account` while the gate is on. It cannot touch funds or any existing Account. | Env secret on the web host (the server signs after checking the code) |
| Relayer | Not used on mainnet (ADR 0011: Players pay their own gas and LayerZero fee) | In test mode it is a low-balance fee payer and faucet. Do not set `TESORO_RELAYER_SECRET_KEY` or `TESORO_RELAYER_EVM_PRIVATE_KEY` on the mainnet host. | Not provisioned |

### Ethereum and HyperEVM

| Role | Holder on mainnet | What it can do | Stored |
|---|---|---|---|
| `PositionVaultOApp` owner (also vault admin) on Ethereum (wstETH vault) and on HyperEVM (kHYPE vault) | A **Safe** on each chain, deployed with the vault: `VAULT_OWNER` in `contracts/script/DeployMainnetWstETH.s.sol` is "the multisig: owner and LayerZero delegate". Same three signers as the Squads. | `setPeer`, `setSolanaReceiveCu`, `setYieldFeeBps` (capped at 50%), `fundTreasury` (no withdrawal exists), `transferOwnership`. | Hardware wallets |
| LayerZero delegate of each vault | The same Safe (the OApp sets it to the owner at construction) | Change the vault's pathway on the endpoint (libraries, DVNs, executor). | Hardware wallets |
| EVM deployer | Any throwaway key, used once to deploy, holding gas only | Nothing after the deploy, if the vault was deployed with the Safe as `VAULT_OWNER`. Destroy it or empty it. | Not kept |
| Keeper EVM key | **Hot key `keeper-evm`**, its own key, not the deployer | Pays gas and the LayerZero fee for `reportYield` (permissionless on the vault; the excess is refunded). Spend is capped by `KEEPER_MAX_ETH_PER_HOUR` and `KEEPER_MAX_HYPE_PER_HOUR`. | Env secret on the keeper host only |
| `SimLST` owner and the sim vaults | Test mode only | Not deployed on mainnet. | n/a |

Whether a Safe exists on HyperEVM mainnet was not checked while writing this plan. If it does not, the founders must choose between another contract wallet and a hardware-wallet account as owner, and record the weaker option here.

## Hot keys: how they are stored

- Each hot key is generated on the host that uses it, or generated offline and loaded once. One key per job: `keeper`, `oracle`, `invite`, `keeper-evm`. The same key never appears on two hosts.
- Keeper host (the VPS): `~/.config/tesoro-keeper.env`, mode 600, owned by the service user, read by the systemd user unit. It holds `KEEPER_SECRET_KEY`, `KEEPER_ORACLE_SECRET_KEY` and `KEEPER_EVM_PRIVATE_KEY`. On mainnet the keeper refuses to read the deployer env file for the EVM key (`keeper/src/eth.ts`).
- Web host (Vercel): only `invite` (name to be fixed in ticket 19), as a Production-only env secret. The oracle and relayer keys are **not** set on the mainnet project.
- Never in the repo, never in a log, never pasted into a chat or a shell history. The repo's pre-commit secret scanner stays on. `keeper/src/keys.ts` already refuses the compromised `AXwY...` key.
- Balances: keep each hot key near what its caps allow for a few days. Top up by hand; the keeper never funds itself.
- A lost hot key is replaced by rotation (below), not recovered.

## What a leaked hot key can and cannot do

| Key | Can | Cannot | Response |
|---|---|---|---|
| `keeper` | Spend its SOL balance (bounded by what you left in it); send permissionless cranks, which are idempotent and validated by the programs. | Change any setting, move Gemas or Principal, upgrade anything, mint. | Rotate: new key, new env, drain the old one. No on-chain step. |
| `keeper-evm` | Spend its gas balance on `reportYield`. | Own or configure a vault, move funds. | Rotate: new key, drain the old one. No on-chain step. |
| `oracle` | Today (before ticket 12): sign a wrong issuance price and wrong Position facts, which mint the wrong number of Gemas (SECURITY.md "known risks"). After tickets 11, 12, 19 to 21: publish an APY up to the admin's ceiling, and record or pay a bad Season, which the 48-hour window lets the admin void. | Upgrade, change settings, take Principal, redeem for anyone. | Multisig `update_config` to the new oracle key, then pause the keeper's Season job until done. Tell the founders at once: the damage window is until the proposal executes. |
| `invite` | Let bots create Accounts while the gate is on (not funds). | Anything else. | Multisig sets a new Invite key (or switches the gate to a code-only check). Void abused Accounts through the suspicious-play page (ticket 32). |
| Squads member (one of three) | Nothing alone: 2 of 3 are needed. | Upgrade or change settings alone. | Squads config change by the other two to remove it and add a new member; do it fast, a second leak is the failure case. |
| Old deployer | Nothing, once every authority has moved and the check step below passes. | | Leave it empty. |

## Rotation steps

- **Oracle (on chain).** Multisig proposal: `tesoro_core.update_config(new_oracle, platform_bps, platform_recipient)`. All three values are replaced together, so read the current Config first and repeat the other two. Update the keeper env, restart, confirm the next Season/APY job signs.
- **Admin.** `tesoro_core.set_admin(new_admin)` signed by the upgrade authority (see `programs/tesoro_core/tests/admin_rotation.rs`: the admin cannot rotate itself, so a compromised admin cannot block its replacement). With the multisig as upgrade authority this is a proposal; a new multisig is: old multisig proposes `set_admin` and the program authority transfer to the new vault, in that order.
- **Bridge admin and LayerZero delegate (Solana).** `tesoro_bridge.set_admin(new_admin)`, also signed by the upgrade authority; it moves `Store.admin` and the endpoint delegate in one call.
- **Upgrade authority.** `SetAuthority` from the vault to the new address (proposal).
- **EVM vault.** The Safe calls `setDelegate(new)` first, then `transferOwnership(new)` (`setDelegate` is `onlyOwner`).
- **Keeper, keeper-evm, invite.** Generate, fund, swap the env value, restart the service, check `healthz`, then drain the old key.
- **A Squads member.** Config transaction by the other two.

## Order of operations (founders)

1. Create the Squads and the Safes; check the signers by sending 0.001 SOL to the vault and moving it out by a proposal. Record the vault address.
2. Generate the hot keys on their hosts. Note the public keys.
3. Wire everything that still needs the single key first: LayerZero pathways (`bridge/scripts/lz.ts`), then the `tesoro_core` init calls with `keeper/scripts/launch-admin.ts` (`register_game`, `init_treasury_stake`, `init_leaderboard`, Source authorities, prices; runbook T-7 step 5). These sign with the deployer file; after the hand-over they become Squads proposals.
4. Create the vault's Tesoro Account (`create_account`, signed by the vault) before the Invite gate is on.
5. Run `keeper/scripts/mainnet-keys.ts` in dry run, read every account and the order, then run it with `--execute` on the single key's steps (or run the printed `solana` commands). Its order is fixed on purpose:
   1. `update_config`: oracle key and fee recipient Account (while the old key is still admin).
   2. `tesoro_core.set_admin` to the vault, and `tesoro_bridge.set_admin` to the vault (both need the old upgrade authority).
   3. The Invite key (when ticket 19's instruction exists).
   4. Upgrade authority of each program to the vault. This is last because it ends the old key's power.
   5. The EVM vault `setDelegate` then `transferOwnership`, by the current owner, with `cast` (the script only prints these).
6. Check: `solana program show <ID>` for each program shows the vault; read Config and Store; make one no-op vault proposal (for example `update_config` with the same values) and see it execute. Only then retire the old key.
7. Program upgrades from then on: build from a tagged commit, write the buffer from any funded key, `solana program set-buffer-authority <BUFFER> --new-buffer-authority <VAULT>`, create the upgrade proposal in Squads, verify the buffer matches the verifiable build, approve, execute.

## Where one key holds two roles today

Found while writing this plan:

1. **Keeper EVM key is the EVM deployer key.** `keeper/src/eth.ts` falls back to `EVM_DEPLOYER_PRIVATE_KEY` in `~/.config/tesoro/evm-deployer.env`, the same key that deploys and owns the vaults. Fixed for mainnet (config only): on the mainnet cluster the keeper reads `KEEPER_EVM_PRIVATE_KEY` and nothing else. Test mode is unchanged. The VPS needs the dedicated key in its env before launch.
2. **One deployer key is upgrade authority, admin, LayerZero delegate, fee-recipient owner and Treasury admin.** Split by the plan above. `keeper/scripts/launch-admin.ts` prints every launch init call (ticket 44) and the older helper scripts take `--keypair`, `--rpc`, `--cluster`; after the hand-over each admin call is a Squads proposal, which `launch-admin.ts --admin <VAULT>` prints as such.
3. **The oracle key is loaded on two hosts** (`TESORO_ORACLE_SECRET_KEY` for the web demo/bridge routes in `app/src/server/demo-advance.ts` and `eth-bridge.ts`, `KEEPER_ORACLE_SECRET_KEY` for the keeper). The cluster guard allows those routes on mainnet, so on mainnet the web project must simply not have the oracle or relayer secrets; those routes then answer "not configured".
4. **The oracle does price, Position facts and Seasons with one key.** `Config.oracle_authority` is a single field; `require_season_authority` accepts admin or oracle. Splitting the Season signer from the APY/price signer needs a program change (a second field), not config. Ticket 12 removes the price from the oracle's powers; the 48-hour void bounds the Season role.
5. **Admin is not independent of the upgrade authority.** `set_admin` is signed by the upgrade authority, so whoever holds the upgrade authority can always reassign the admin. This is why both sit behind the same multisig.
6. **Devnet fee recipient and Studio recipient are the deployer's Account.** Mainnet needs new Accounts (above); `register_game`'s studio recipient for each Game is a founder decision.
7. **Chicken and egg with the Invite gate.** The vault's own Account needs `create_account`, which will require the Invite signature once the gate is on. Create it first.
8. **The oracle can mint Gemas until it is locked.** `open_position`, `apply_yield` and the oracle-priced `take_advance` are test-mode paths that let the oracle key register a Position that holds nothing and issue Gemas against it. The admin turns them off with `set_oracle_lock(true)` (audit 2026-10-16, C-1): do it in the same proposal batch that moves the admin to the multisig, before the Invite gate opens. With the lock on, ETH and HYPE Positions come only from the bridge and Advances are priced from Pyth, and the oracle keeps only Season recording/payment and the `take_advance_onchain` co-signature. The keeper's mainnet start-up check should read `Config.oracle_locked` and refuse to run when it is false.

## Founders only

- Create the Squads multisig and the Safes; choose the three signers and where the backup lives.
- Sign every authority transfer and every proposal. The agents never hold a member key and never send.
- Decide the Squads time lock, the HyperEVM owner (if no Safe), and the Studio recipient per Game.
- Fund the vault, the hot keys, and the deployer's buffer SOL (a program deploy needs buffer rent of several SOL on mainnet).
- Put `KEEPER_SECRET_KEY`, `KEEPER_ORACLE_SECRET_KEY`, `KEEPER_EVM_PRIVATE_KEY` on the VPS and the Invite secret on the web host.
- Run the dry run, review it, and run `--execute` (or the commands) themselves.

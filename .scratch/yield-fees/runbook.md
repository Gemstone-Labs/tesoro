# Deploy runbook: Yield Fee and Instant Redeem (feat/yield-fees-12-10-2026)

Orchestrator only. Every step is a real deploy; nothing here was run by the build agents.
`export TMPDIR=$HOME/.cache/tesoro-tmp` first. Solana RPC `R=https://rpc.magicblock.app/devnet`.
Deployer / upgrade authority `~/.config/solana/dev-2026-10.json` (`7zr1j185...qh7M`); EVM deployer `~/.config/tesoro/evm-deployer.env` (`0x9613...1C`).

## Why this order (differs from the brief on purpose)
- `lz.ts wire` calls `set_peer_config`, whose account list changed (it now creates the `VaultTreasury`): it must run **after** the bridge upgrade.
- From the `tesoro_core` upgrade until the new app is live, the prod app's Advance and yield-crank transactions fail (they lack the Treasury account), and the keeper's accrue fails until `init_treasury` runs. Keep that window short: stop the keeper first, upgrade, `init_treasury`, deploy the app, restart the keeper.
- EVM vault deploys touch nothing live (the old vaults keep working until `setMinter` moves to the new ones), so they go first.
- The "relayer" is the app's server route (`/api/eth-bridge`, keys in Vercel env); it restarts with the app deploy.

## 0. Pre-flight
```bash
cd ~/Work/gemstone-labs/tesoro/tesoro   # or a clean detached worktree of the merged main
pgrep -A -fa "solana program"          # nobody else (Dungeons & Moles) mid-upgrade on the shared key
solana balance -k ~/.config/solana/dev-2026-10.json --url $R
solana program show --buffers -k ~/.config/solana/dev-2026-10.json --url $R   # reclaim stray buffers first
```
SOL needed (serial upgrades, buffers refunded after each deploy):
- extend `tesoro_core` +140,000 B ≈ 0.98 SOL (kept as rent), buffer ≈ 9.0 SOL (refunded)
- extend `tesoro_bridge` +115,000 B ≈ 0.81 SOL (kept), buffer ≈ 5.6 SOL (refunded)
- peak ≈ 10 SOL with fees. Borrow from the relayer / bridge-demo-owner as on 2026-10-03; repay the relayer first.

Build from the merged commit: `pnpm build:programs` (root) and `cd bridge && anchor build --no-idl -- --tools-version v1.54`.
Sizes on this branch: `tesoro_core.so` 1,292,656 B (deployed program data 1,158,360 B → **extend needed**, ≥ 134,296 B); `tesoro_bridge.so` 797,920 B (deployed 686,648 B → **extend needed**, ≥ 111,272 B).

## 1. EVM: deploy the two new SimLST vaults
```bash
cd contracts
HOODI_SIMLST=0xD82840623A7a00C37b0883d221Fa84e39ddA2a28
HYPE_SIMLST=0xC8A9AccD25ABDCF3FCBDE7123Cef8239B5bE7eF3
script/deploy-oapp.sh hoodi sim $HOODI_SIMLST      # note "Deployed to: 0x..." -> NEW_HOODI_VAULT
script/deploy-oapp.sh hyperevm sim $HYPE_SIMLST    # -> NEW_HYPE_VAULT
```
Check: `cast call $NEW_HOODI_VAULT "yieldFeeBps()(uint16)" --rpc-url https://ethereum-hoodi-rpc.publicnode.com` = 2000 (same for HyperEVM, `--rpc-url https://rpc.hyperliquid-testnet.xyz/evm`).

## 2. EVM: point the SimLSTs at the new vaults (this retires the old vaults' yield)
```bash
source ~/.config/tesoro/evm-deployer.env
cast send $HOODI_SIMLST "setMinter(address)" $NEW_HOODI_VAULT --rpc-url https://ethereum-hoodi-rpc.publicnode.com --private-key $EVM_DEPLOYER_PRIVATE_KEY
cast send $HYPE_SIMLST "setMinter(address)" $NEW_HYPE_VAULT --rpc-url https://rpc.hyperliquid-testnet.xyz/evm --private-key $EVM_DEPLOYER_PRIVATE_KEY
```

## 3. EVM: setPeer to the bridge Store PDA
```bash
STORE=0x60ae58df1215bf45cc054e633b49c92a3b1309f76075bac72b26e0c6e1c0c792
script/oapp.sh hoodi $NEW_HOODI_VAULT peer $STORE
script/oapp.sh hyperevm $NEW_HYPE_VAULT peer $STORE
```

## 4. Stop the keeper
```bash
pgrep -A -fa keeper-loop   # kill the keeper-loop.sh PID, then its tsx child (never pkill -f from Bash)
```

## 5. Upgrade tesoro_core
```bash
cd ~/Work/gemstone-labs/tesoro/tesoro
solana program extend AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh 140000 -k ~/.config/solana/dev-2026-10.json --url $R
solana program write-buffer target/deploy/tesoro_core.so -k ~/.config/solana/dev-2026-10.json --url $R   # -> BUF
solana program deploy --buffer <BUF> --program-id ~/.config/tesoro/deploy-keys/tesoro_core-keypair.json -k ~/.config/solana/dev-2026-10.json --url $R
```
(If write-buffer 429s: `bridge/scripts/upload.ts` paced upload, as before.)

## 6. Treasury on Solana: init + fund (immediately after 5)
```bash
pnpm --filter @tesoro/keeper exec tsx scripts/fund-treasury.ts --dry-run
pnpm --filter @tesoro/keeper exec tsx scripts/fund-treasury.ts      # init_treasury(2000, 3500) + fund_treasury
```
Suggested SOL funding: **10 simSOL** (one faucet claim to the admin). A 2,500-Gema win at $150/SOL is 0.167 SOL; Instant Redeem pays 65% ≈ 0.108 simSOL, so 10 simSOL covers ~90 of the biggest wins before any Yield Fee lands. Yield Fees then refill it (20% of every native Position's minted yield).

## 7. Upgrade tesoro_bridge
```bash
cd bridge
solana program extend 5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ 115000 -k ~/.config/solana/dev-2026-10.json --url $R
solana program write-buffer target/deploy/tesoro_bridge.so -k ~/.config/solana/dev-2026-10.json --url $R   # -> BUF
solana program deploy --buffer <BUF> --program-id ~/.config/tesoro/deploy-keys/tesoro_bridge-keypair.json -k ~/.config/solana/dev-2026-10.json --url $R
```

## 8. Wire the new vaults on Solana (PeerConfig + VaultTreasury + endpoint pathway)
```bash
cd bridge
SOLANA_RPC=$R pnpm lz wire 40449 $NEW_HOODI_VAULT 18 500
SOLANA_RPC=$R pnpm lz wire 40362 $NEW_HYPE_VAULT 18 500
SOLANA_RPC=$R pnpm flow treasury 40449 $NEW_HOODI_VAULT   # VaultTreasury exists, reported_in 0
```

## 9. EVM treasury funding
```bash
cd contracts
# simETH: two faucet claims are an hour apart; one claim (10 simETH) is plenty
script/oapp.sh hoodi $NEW_HOODI_VAULT faucet
cast send $HOODI_SIMLST "approve(address,uint256)" $NEW_HOODI_VAULT $(cast max-uint) --rpc-url https://ethereum-hoodi-rpc.publicnode.com --private-key $EVM_DEPLOYER_PRIVATE_KEY
cast send $NEW_HOODI_VAULT "fundTreasury(uint256)" 2000000000000000000 --rpc-url https://ethereum-hoodi-rpc.publicnode.com --private-key $EVM_DEPLOYER_PRIVATE_KEY
script/oapp.sh hyperevm $NEW_HYPE_VAULT faucet
cast send $HYPE_SIMLST "approve(address,uint256)" $NEW_HYPE_VAULT $(cast max-uint) --rpc-url https://rpc.hyperliquid-testnet.xyz/evm --private-key $EVM_DEPLOYER_PRIVATE_KEY
cast send $NEW_HYPE_VAULT "fundTreasury(uint256)" 10000000000000000000 --rpc-url https://rpc.hyperliquid-testnet.xyz/evm --private-key $EVM_DEPLOYER_PRIVATE_KEY
```
Suggested: **2 simETH** (a 2,500-Gema win at ~$3,000/ETH is 0.0083 ETH, 65% ≈ 0.0054: ~370 of the biggest wins) and **10 simHYPE** (at ~$25/HYPE a 2,500-Gema win is 1 HYPE, 65% = 0.65: ~15 of the biggest wins; fund another 10 after an hour if HYPE demand shows up).
**The Solana cap only sees funding once a yield report carries it**: `treasuryIn` rides in `YieldAccrued`. After funding, any `reportYield` on that vault (the smoke Position below, or the keeper's next report) plus `apply_yield` / `sync_treasury` raises the mirror. Until then Instant Redeem on that asset is refused cleanly (`TreasuryShort`), never over-promised.

## 10. App (and relayer route): new vault addresses, then deploy
The app learns the vaults in ONE place: `app/src/lib/chain/eth.ts` `SIM_VAULT_ADDRESSES` (`hoodi.vault`, `hyperevm.vault`; the `lst` entries stay). The keeper reads vaults off Position ids and needs no edit. Also update the displayed addresses in `app/src/app/(docs)/docs/developers/programs/page.tsx` (two `Addr` rows) and `README.md` (two table rows).
```bash
sed -i "s/0x8B099AbfC204E1a07D6CA686D302CE6cbC07a3A3/$NEW_HOODI_VAULT/g; s/0xf70dafE2788881F6ae54Bea7342dcb3D9b92A316/$NEW_HYPE_VAULT/g" \
  app/src/lib/chain/eth.ts "app/src/app/(docs)/docs/developers/programs/page.tsx" README.md
pnpm --filter @tesoro/app exec vitest run && pnpm build:app
git commit -m "chore: point the app at the Yield Fee vaults" -- app/src/lib/chain/eth.ts "app/src/app/(docs)/docs/developers/programs/page.tsx" README.md
```
Deploy from a clean detached worktree of main (`.vercel/project.json` copied): `vercel deploy --prod --scope gemstone-labs` (a push to `origin/main` also deploys prod). Smoke: `/`, `/wallet`, `/lobby`, `/docs/fees` → 200.

## 11. Restart the keeper (new code)
```bash
cd ~/Work/gemstone-labs/tesoro/tesoro   # at the merged main
setsid nohup ~/.cache/tesoro-tmp/keeper-loop.sh >> ~/.cache/tesoro-tmp/keeper-main.log 2>&1 &
pgrep -A -fa keeper-loop; tail -f ~/.cache/tesoro-tmp/keeper-main.log   # alive pass=1, yield + treasury jobs run
```

## 12. Smoke tests (one per asset)
- **SOL**: fresh dev wallet opens a 5 simSOL Position with a 1-month Advance: Gemas = 80% of the old quote (e.g. 5 SOL × 7% / 12 × 0.8 at $150 ≈ 349 Gemas); after one crank the treasury vault grew by 20% of the minted yield (`SOLANA_RPC=$R pnpm flow` / Solana explorer on the `["treasury_vault"]` PDA); Debt reaches 0 at ~10 min. Give a second wallet won Gemas through a 500 Match, then "Redeem now" in the Redeem sheet: wallet gains 65% in simSOL in one tx; Treasury Account holds the Gemas; after the Source's yield lands the keeper's `redeem_treasury` refills the treasury vault.
- **ETH (Hoodi)**: open 1 simETH, 1 month on NEW_HOODI_VAULT from the Wallet; Advance = 80%; `reportYield` (keeper or `script/oapp.sh hoodi $NEW_HOODI_VAULT report 1`) delivers a 77-byte YieldAccrued (LayerZero Scan DELIVERED), `apply_yield` lowers Debt and raises `VaultTreasury.reported_in` to the funded 2e18 + fees. A won-Gemas holder "Redeem now": `instant_redeem_to_evm` + `send_pay_instant` → Scan DELIVERED, vault `instantPaid` up, holder's simETH up by 65%.
- **HYPE (HyperEVM)**: same as ETH on NEW_HYPE_VAULT (needs ~0.02 HYPE per message on the payer).

## 13. Record
Fill the "Yield Fee and Instant Redeem (2026-10-12)" table at the top of `docs/deployments.md` (addresses, tx hashes, abbreviated Solana signatures); repay borrowed SOL (relayer first); `solana program close --buffers` for any leftover buffer.

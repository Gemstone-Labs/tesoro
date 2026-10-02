# Testing HYPE Positions locally (HyperEVM testnet)

A HYPE Position locks **simHYPE** (a Simulated test token, yield 1 month = 10 min) on Hyperliquid's testnet EVM (chain 998), and the Solana ledger gives you Gemas against it over LayerZero. Testnets only; nothing here touches mainnet.

## Before you start

1. `pnpm dev` in `app/` (http://localhost:3000). `app/.env.local` needs `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_SOLANA_RPC` and `TESORO_BASE_RPC` (devnet). The server keys come from `~/.config/tesoro/` (`relayer.json`, `relayer-evm.env`, `oracle.json`), no extra setup on this machine.
2. A keeper must be running (`pnpm --filter @tesoro/keeper start`): it applies LayerZero messages on Solana, reports HYPE yield every 10 min and cranks the bridge. Without it the open, the Debt reduction and the Unlock still work but you press the buttons yourself (the app does `apply_locked`, `apply_yield` and `send_unlock` for you while the page is open).
3. Pick how you sign in.
   - **Dev wallet (no inbox, no Privy dashboard).** Add `NEXT_PUBLIC_DEV_WALLET=1` to `app/.env.local`, restart `pnpm dev`, open `http://localhost:3000/wallet?dev=hype1`. The name after `dev=` picks a wallet; its Solana and EVM keys live in that browser's localStorage, so use the same browser profile every time (a new profile is a new, empty wallet) and never clear site data while a Position is open. Throwaway keys, testnets only.
   - **Privy (real sign-in).** Email + code. The **Privy dashboard step is yours**, for the embedded wallet to sign on HyperEVM (dashboard.privy.io, your app):
     1. Configuration, App settings, Domains: allow `http://localhost:3000`.
     2. Wallets, Embedded wallets: enable Ethereum and Solana.
     3. Wallets, Chains (custom EVM chains): add **HyperEVM Testnet**, chain ID **998**, RPC `https://rpc.hyperliquid-testnet.xyz/evm`, currency symbol HYPE, block explorer `https://testnet.purrsec.com`. Hoodi (560048, `https://ethereum-hoodi-rpc.publicnode.com`) too if you also test ETH.
     Without chain 998 in Privy the app's "switch network" request is refused and the open or Report yield step ends with a network error. The Privy path is the one not exercised end to end here (no inbox); everything below was driven with dev wallets.

## The walk

Wallet, **Open a Position**, tab **HYPE**. The card shows your EVM address, your HYPE (gas) and your simHYPE.

| Step | What you do | What you should see | Time |
|---|---|---|---|
| 1. Gas | HYPE balance reads 0 or under 0.02: tap **Get test HYPE** (neutral button, "Simulated test HYPE for gas and the LayerZero fee, once a day per wallet") | "Getting test HYPE…", then `0.0300 HYPE` | 10 to 25 s |
| 2. Test token | **Get test simHYPE** | 10 simHYPE, then "Faucet cooling down" (10 an hour) | 15 to 40 s (HyperEVM block time) |
| 3. Open | Amount 1 to 10, horizon 1 to 3 months. The button shows the Gemas you will get ("Open a HYPE Position · 38 Gemas") and the Unlock Estimate (about 10 min per month). Tap it | Tracker: linking your EVM address (one Solana tx the first time), checking gas, approving simHYPE, opening on HyperEVM | 1 to 2 min |
| 4. Advance | Stay on the page (or open the Wallet) | "HyperEVM confirmed", "LayerZero delivered", "Position recorded", "Gemas available". The Gemas show in the header | LayerZero 40 to 80 s, the whole Advance 2 to 4 min |
| 5. Yield | Wait. The keeper reports yield every 10 min; or tap **Report yield** on the card (a HYPE LayerZero fee, about 0.0075) | Tracker "Debt updated"; Debt falls toward 0 | 40 to 80 s per report |
| 6. Redeem | Once part of the Gemas are redeemable, **Redeem** | Tracker: Redeemed on Solana, LayerZero message sent, "simHYPE on HyperEVM"; the simHYPE balance rises | 60 to 90 s |
| 7. Unlock | When Debt reads 0 ("Debt is zero"), **Unlock** | Tracker: Unlocked on Solana, LayerZero message sent, "Principal on HyperEVM"; the card turns Unlocked | about 1 min |

Debt hits zero after roughly (Gemas / yield per month) simulated months; for 1 simHYPE and a 1-month Advance that was about 22 minutes. Larger horizons take proportionally longer: the form's Unlock Estimate is the guide.

Each tracker links the Solana tx, the HyperEVM tx on `https://testnet.purrsec.com` and the LayerZero Scan page. A stage never shows done until the chain state says so, and a reload resumes it.

## When something looks stuck

- **"Get test HYPE" says limit reached**: one drip per wallet per day, five an hour in total. Send yourself HYPE from any funded testnet wallet instead.
- **"The test HYPE faucet is empty"**: the relayer EVM key (`0x0aa6…97f8`) is under 0.08 HYPE; refill it from the deployer.
- **Report yield does nothing for a while**: the keeper's `KEEPER_MAX_HYPE_PER_HOUR` (0.03 by default) is spent; tap Report yield yourself or raise the cap.
- **Slow LayerZero**: the Scan link on the tracker shows INFLIGHT, then DELIVERED; Solana-to-HyperEVM took 65 to 80 s in testing, HyperEVM-to-Solana 37 to 60 s.
- **Backing with HYPE Gemas**: the entries are 500, 1,000 and 2,500 Gemas, so open at least about 10 simHYPE for 3 months (about 1,150 Gemas). Winnings from a HYPE-Sourced loser appear under "Pending by Source" as `HYPE · <Position>` and become redeemable as that Position's yield lands.

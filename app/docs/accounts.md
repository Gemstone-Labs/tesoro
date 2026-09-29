# Accounts (Privy)

An **Account** is one person's single Tesoro identity: one embedded Solana address and one embedded EVM address, plus any external wallets they link. Sign-in is email + one-time code through Privy (`@privy-io/react-auth` 3.x, headless email flow rendered in Tesoro's own sheet).

## Where things live

| Piece | File |
|---|---|
| Provider, Privy config, gate, wallet creation fallback | `src/lib/auth/AccountProvider.tsx` |
| Auth context (`useAuth`), types | `src/lib/auth/context.ts`, `types.ts` |
| Session-backed `useAccount()` seam (Positions, Gemas, Matches read from tesoro_core on devnet; mock only when signed out) | `src/lib/account.ts`, `src/lib/chain/` |
| Chains (Hoodi 560048, HyperEVM testnet 998, Solana devnet RPC) | `src/lib/chains.ts` |
| Sign-in sheet / Account sheet | `src/components/shell/SignInSheet.tsx`, `AccountSheet.tsx` |

Behavior:

- Browsing the Lobby needs no sign-in. `auth.gate(reason, action)` runs the action if signed in, otherwise opens the sign-in sheet and runs it after sign-in. Gated: Enter (Block Puzzle, Hold'em), Make an Offer / New public Offer, Take an Advance, Return, Redeem. The Wallet page shows a sign-in prompt while signed out.
- Without `NEXT_PUBLIC_PRIVY_APP_ID` the app runs unauthenticated: no Privy provider, gates let actions through, no Account UI. The build does not fail.
- The header shows "Sign in" when signed out, and the Gema balance plus an Account button when signed in.

## Configured in code

- `loginMethods: ["email"]`.
- `embeddedWallets.ethereum.createOnLogin` and `embeddedWallets.solana.createOnLogin` = `"all-users"`. A fallback effect also calls `createWallet()` for any signed-in user missing either wallet.
- `externalWallets.solana.connectors = toSolanaWalletConnectors()` (wallet-standard: Phantom, Backpack). External EVM (MetaMask) is detected by default.
- `supportedChains` = Hoodi (560048, default) and HyperEVM testnet (998, RPC `https://rpc.hyperliquid-testnet.xyz/evm`).
- `solana.rpcs["solana:devnet"]` = `https://api.devnet.solana.com` (HTTP + WS). Swap for a Helius devnet URL if the public RPC rate-limits.
- Dark theme, neutral accent (emerald is reserved for Gemas moving).

## Founder must configure in the Privy dashboard (dashboard.privy.io)

Code cannot substitute for these; the dashboard is the source of truth for the server-side app settings.

1. **App ID** in `app/.env.local` as `NEXT_PUBLIC_PRIVY_APP_ID` (gitignored). Set the same variable in the hosting environment (Vercel) for deploys.
2. **Allowed origins** (Configuration > App settings > Clients/Domains): add `http://localhost:3000`, the hosted preview URL(s) and the production URL. Login fails with an origin error otherwise.
3. **Login methods**: enable **Email**. Other methods can stay off; the UI only offers email.
4. **Wallets > Embedded wallets**: enable embedded wallets for **both Ethereum (EVM) and Solana**. Dashboard "Create on login" should be on for both (the code requests it too).
5. **Wallets > External wallets / Wallet login & linking**: enable **wallet linking** for **Ethereum** and **Solana**, otherwise "Link Solana wallet" / "Link EVM wallet" show no options.
6. **Chains** (Wallets > Chains, or Networks): add **Ethereum Hoodi (560048)** and **HyperEVM testnet (998)** as custom EVM chains with the RPCs above, and Solana **devnet**. Privy only allows RPC calls for chains configured here.
7. **Email delivery**: default Privy email sender works for testing. For the demo, consider a custom sender or Privy **test accounts** (Configuration > Test accounts) so judges and screen recordings do not depend on an inbox.

## Not verified here

The sign-in sheet renders against the real Privy app (see `docs/screens/accounts-sign-in-390.png`), but the full email-code login, embedded wallet creation and wallet linking need a live inbox and browser wallets, so they were not exercised end to end. Do that once after the dashboard settings above. The Account sheet screenshot (`accounts-account-sheet-390.png`) uses sample addresses from the `/design` page.

## Signing on Solana

`useAuth().signer` is a `ChainSigner` over the embedded Solana wallet: `signTransaction` (Privy `useSignTransaction`, `showWalletUIs: false` so Match moves do not open a modal) and `signMessage` (the MagicBlock TEE auth token and the demo route). `getAccessToken` gives the Privy token the demo route verifies. Match flows use it through `src/lib/chain/`. Not verified against a real Privy login here (no inbox); driven with the dev wallet below. EVM sending is still not wired.

## Dev-only wallet (`NEXT_PUBLIC_DEV_WALLET=1`)

For driving the on-chain flow without an inbox. Put `NEXT_PUBLIC_DEV_WALLET=1` in `app/.env.local` and run `pnpm dev`. The app then skips Privy and signs in automatically with a Keypair kept in the browser's `localStorage`; `?dev=<name>` (for example `/?dev=alice`) picks a named wallet, remembered for the tab, so two browser sessions can be two Accounts. The address shows in the Account sheet; Sign out mints a fresh key. It is gated by `NODE_ENV !== "production"` (constant-folded at build), the component also refuses to render in production, and the demo route skips the Privy token only outside production. Never use it with anything of value.

# Accounts (Privy)

An **Account** is one person's single Tesoro identity: one embedded Solana address and one embedded EVM address, plus any external wallets they link. Sign-in is a wallet or an email through Privy (`@privy-io/react-auth` 3.x): the email code flow is headless in Tesoro's own sheet, the wallet picker is Privy's modal (opened from two cards in that sheet).

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

- `loginMethods: ["email", "wallet"]`; `appearance.walletList` = detected Solana wallets, detected Ethereum wallets, Phantom, MetaMask, Coinbase, WalletConnect. The Sign in sheet opens the picker filtered to Solana (`walletChainType: "solana-only"`) or Ethereum.
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

`useAuth().signer` is a `ChainSigner` over the embedded Solana wallet: `signTransaction` (Privy `useSignTransaction`, `showWalletUIs: false` so Match moves do not open a modal) and `signMessage` (the MagicBlock TEE auth token and the demo route). `getAccessToken` gives the Privy token the demo route verifies. Match flows use it through `src/lib/chain/`. Not verified against a real Privy login here (no inbox); driven with the dev wallet below. EVM signing (`useAuth().evm`, a viem client on Hoodi) and the Ethereum Position flow are in `eth-positions.md`; the dev wallet also holds a local EVM key (`tesoro-dev-evm:<name>`).

## Dev-only wallet (`NEXT_PUBLIC_DEV_WALLET=1`)

For driving the on-chain flow without an inbox. Put `NEXT_PUBLIC_DEV_WALLET=1` in `app/.env.local` and run `pnpm dev`. The app then skips Privy and signs in automatically with a Keypair kept in the browser's `localStorage`; `?dev=<name>` (for example `/?dev=alice`) picks a named wallet, remembered for the tab, so two browser sessions can be two Accounts. The address shows in the Account sheet; Sign out mints a fresh key. It is gated by `NODE_ENV !== "production"` (constant-folded at build), the component also refuses to render in production, and the demo route skips the Privy token only outside production. Never use it with anything of value.

## Sign in with a wallet

Whichever way a person signs in, the **Account is backed by the Privy embedded wallets** (one Solana, one EVM, created for every sign-in method). A wallet used to sign in is linked to the same Privy user and proves who the person is; the next sign-in with it lands on the same Account. Phantom, Solflare, Backpack, MetaMask or Rabby never sign Match moves, on purpose: a Block Puzzle run sends a signed batch every second or so, Hold'em and Trading Duel sign every action, and an extension wallet would open an approval popup for each one. The embedded wallet signs those silently (`showWalletUIs: false`), so every flow (Matches, Positions, Advances, Backing, ETH and HYPE bridge steps, the `/api/demo-advance` and `/api/eth-bridge` routes, which check a Solana message signature plus the Privy token and so work for any sign-in method) behaves exactly as with email.

The connected external wallets are exposed as `useAuth().externalSolana` (a `ChainSigner`) and `externalEvm` (an `EvmSigner`). They are used only for the identity steps below, where a wallet approval is the point.

## Profiles and names

- `tesoro_core` has a `Profile` PDA per Account (`["profile", account]`): name (3 to 20 of letters, digits, space, `.`, `_`, `-`, no space at either end), picture (`AvatarChoice`: `Default`, `NameService`, `Animal(0..11)`), an optional attached Solana wallet and an optional attached EVM address.
  - `set_profile(name, avatar)`: signed by the Account authority; the first call creates the Profile (authority pays rent), later calls overwrite name and picture and keep the attached wallets.
  - `set_name_wallet()`: the attached Solana wallet must co-sign the same transaction (so nobody shows a name they do not control). Without the optional `wallet` account it clears the link.
  - `set_name_evm(evm_address)`: the address must already have a bridge `EvmLink` pointing at this Account (the bridge's `link_evm` checks an EIP-191 signature of the Account key on chain); `set_name_evm` re-verifies owner, address, contents. All zeros clears it.
- Reading: `lib/identity/store.ts` batches every Player on screen into one read of Profiles and Accounts (two `getMultipleAccounts` calls) and one POST to `/api/names`, which resolves the primary `.sol` name (Bonfida SNS `getMultiplePrimaryDomains`, mainnet, owner-checked) and the primary `.eth` name (viem `getEnsName`, then a forward `getEnsAddress` that must return the same address, plus `getEnsAvatar`) and caches answers in memory (10 min found, 3 min none, 30 s failed). Image URLs are https only; `.sol` names carry no picture (SDK 4.x reads records under `.sns` only), `.eth` names do. Env: `TESORO_SOL_MAINNET_RPC` (default the public mainnet RPC) and `TESORO_ETH_MAINNET_RPC` (default publicnode); set private endpoints on the host for the demo.
- Which wallets are looked up for a Player: the attached Solana wallet, then the Account authority; the attached EVM address, then the Account's own `evm_address`.
- Display rule (everywhere): Profile name, else `.sol`, else `.eth`, else short key; `.sol` / `.eth` carry a verified mark. See DESIGN.md.
- If the deployed program has no profile instructions, `profilesAvailable()` (an unsigned simulation of `set_profile`; Anchor answers 101 for an unknown instruction) is false and the Edit profile sheet says "Profiles are coming soon" instead of Save. Reads work either way: missing Profile accounts just mean "no profile".

### Privy dashboard for wallet sign-in

1. Login methods: turn on **Wallet** (external wallets) next to **Email**.
2. Wallets > External wallets: enable **Solana** and **Ethereum** wallet login and linking; leave WalletConnect on (Privy supplies the WalletConnect project, no secret is needed in this repo).
3. Wallets > Embedded wallets: keep **Ethereum and Solana** on, "Create on login" for all users (wallet logins also get embedded wallets, which is what signs Matches).
4. Chains: Hoodi 560048 and HyperEVM testnet 998 as custom EVM chains and Solana devnet, as above. Ethereum mainnet does not need adding: ENS and SNS are read by the server, not through Privy.
5. Allowed origins: every host the app runs on (localhost, the Vercel URLs).

### Not verified here

A real wallet sign-in (the Privy picker with a Phantom or MetaMask extension) and an attach-a-wallet approval need a browser extension and the Privy dashboard settings above, so they were not exercised. Name resolution was run against the real mainnet registries; saving a Profile on devnet waits for the `tesoro_core` upgrade.

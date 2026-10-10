import type { Metadata } from "next";
import Link from "next/link";
import { Callout, Code, DataTable, DocPage, H2, H3 } from "@/components/docs/prose";

export const metadata: Metadata = { title: "Run it locally", alternates: { canonical: "/docs/developers/run" } };

export default function Page() {
  return (
    <DocPage href="/docs/developers/run">
      <H2 id="requirements">Requirements</H2>
      <ul>
        <li>Node 22 (Next.js 16 needs 20.9 or newer) and pnpm 10.</li>
        <li>For the programs: Rust 1.91.1 (pinned by <code>rust-toolchain.toml</code>), Anchor 0.31.1, and Solana platform tools v1.54, which the build script requests.</li>
        <li>For the contracts: Foundry.</li>
      </ul>

      <H2 id="app">The app</H2>
      <Code label="bash">{`pnpm install
NEXT_PUBLIC_DEV_WALLET=1 pnpm dev    # http://localhost:3000, with a dev-only local wallet`}</Code>
      <p>
        Every RPC defaults to <code>https://rpc.magicblock.app/devnet</code>, so no configuration is needed. To use your own endpoints, create <code>app/.env.local</code> with only
        the variables you set (<code>app/.env.example</code> lists them) and leave unset variables out: an empty value overrides the default.
      </p>
      <DataTable
        head={["Variable", "Side", "Purpose"]}
        rows={[
          [<code key="1">NEXT_PUBLIC_SOLANA_RPC</code>, "browser", "Single-account reads, sends and confirmations. Ships to the browser: use a domain-restricted key."],
          [<code key="2">TESORO_BASE_RPC</code>, "server", "Reads and sends in API routes."],
          [<code key="3">TESORO_GPA_RPC</code>, "server", "getProgramAccounts list queries behind /api/chain/accounts."],
          [<code key="4">NEXT_PUBLIC_DEV_WALLET=1</code>, "browser", "Dev-only local wallet instead of Privy. Compiled out of production builds."],
          [<code key="5">NEXT_PUBLIC_PRIVY_APP_ID</code>, "browser", "Privy sign-in. Without it the app runs signed out."],
          [<code key="6">TESORO_RELAYER_*</code>, "server", "Low-balance relayer keys for the demo funding routes. Without them those routes answer 503."],
        ]}
        caption="A selection; README.md has the full table"
      />
      <p>
        With the dev wallet on, <code>?dev=&lt;name&gt;</code> (for example <code>/lobby?dev=alice</code>) picks a named wallet, so two browser windows can be two Accounts that play
        each other. In the Wallet, &ldquo;Get test simSOL&rdquo; then &ldquo;Open a Position&rdquo;; in the Lobby, pick an entry and Play now.
      </p>

      <H3 id="checks">Checks</H3>
      <Code label="bash">{`pnpm build:app                                      # production build; also generates Next's route types
pnpm --filter @tesoro/app exec tsc --noEmit         # run after build:app or \`next typegen\`
pnpm --filter @tesoro/app exec eslint src
pnpm --filter @tesoro/app test                      # vitest`}</Code>

      <H2 id="programs">Programs</H2>
      <Code label="bash">{`export TMPDIR=$HOME/.cache/tesoro-tmp   # /tmp is a small shared tmpfs on some machines
pnpm build:programs     # Anchor 0.31.1 with platform tools v1.54 (plain \`anchor build\` fails)
cargo test --workspace  # ledger property tests and LiteSVM integration tests`}</Code>
      <p>
        The bridge is its own Anchor workspace because of its LayerZero git dependency: <code>cd bridge &amp;&amp; anchor build --no-idl -- --tools-version v1.54</code>. Program IDs are
        fixed by <code>declare_id!</code> and deploy keypairs that are not in the repository, so a local build produces the same programs but cannot be deployed over these IDs.
      </p>

      <H2 id="contracts">Contracts</H2>
      <Code label="bash">{`pnpm build:contracts    # forge build
pnpm test:contracts     # forge test`}</Code>
      <p>
        Deploy scripts: <code>contracts/script/deploy-oapp.sh &lt;hoodi|hyperevm&gt; &lt;sim|wsteth&gt;</code> and <code>contracts/script/oapp.sh</code>. Bridge wiring: <code>pnpm lz wire …</code> in{" "}
        <code>bridge/</code>.
      </p>

      <H2 id="keeper">Keeper</H2>
      <Code label="bash">{`pnpm --filter @tesoro/keeper start --once --dry-run   # one pass that prints what it would do, sends nothing
pnpm --filter @tesoro/keeper start                    # loop every 20 s
pnpm --filter @tesoro/keeper test`}</Code>
      <p>
        The keeper uses a payer at <code>~/.config/tesoro/keeper.json</code>, created on first run and never funded by itself. At startup it checks the genesis hash of its RPCs and refuses
        to run unless they are Solana devnet. Some jobs need keys only the team holds: the oracle key signs <code>set_price</code> and the EVM key sends <code>reportYield</code>; without
        them the other jobs still run. Every job is permissionless on chain, so anyone can send the same transactions. Jobs, flags and limits: <code>keeper/README.md</code>.
      </p>

      <H2 id="tour">Where to start reading</H2>
      <ul>
        <li><code>CONTEXT.md</code>: the domain language, used verbatim in code and copy.</li>
        <li><code>docs/adr/</code>: the five decisions that bind the build.</li>
        <li><code>docs/tesoro-core.md</code>, <code>docs/games/</code>, <code>docs/cross-chain.md</code>, <code>docs/yield-model.md</code>, <code>docs/deployments.md</code>.</li>
      </ul>

      <Callout kind="note" title="Status">
        <p>
          Everything runs against test networks and uses simulated yield. For addresses to check against, see <Link href="/docs/developers/programs">Programs and addresses</Link>.
        </p>
      </Callout>
    </DocPage>
  );
}

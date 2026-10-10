import type { Metadata } from "next";
import Link from "next/link";
import { Callout, Code, DataTable, DocPage, H2, Sim } from "@/components/docs/prose";

export const metadata: Metadata = { title: "Simulated yield", alternates: { canonical: "/docs/developers/simulated-yield" } };

export default function Page() {
  return (
    <DocPage href="/docs/developers/simulated-yield">
      <Callout kind="sim" title="The label">
        <p>
          Every screen, doc and video that shows yield says <Sim>Simulated yield · 1 month = 10 min</Sim>. The test staking tokens are not backed by anything and
          their faucets mint freely. This page says exactly what they do.
        </p>
      </Callout>

      <H2 id="rule">The rule</H2>
      <p>
        Every Position earns, from the moment it opens, linear yield on its own Principal (no compounding), on every chain:
      </p>
      <Code label="yield model">{`yield(t) = principal * apy * simulated_elapsed(t) / year
simulated_elapsed = real_elapsed * speedup        // speedup = 4,380`}</Code>
      <p>
        <code>apy</code> is the Position&apos;s own <code>rate_bps</code>, set at open from the pool. A speedup of 4,380 makes one simulated month (1/12 year) take exactly 600
        real seconds, and an Advance of <code>N</code> months, which is <code>principal * apy * N / 12</code>, is repaid in exactly <code>N * 10</code> minutes for every
        Position. The decision and the rejected alternatives (a compounding rate would reach about 7,000 SOL per simSOL by 12 October and overflow <code>u64</code> within
        weeks) are in ADR 0005 and <code>docs/yield-model.md</code>.
      </p>
      <DataTable
        head={["Token", "Chain", "Yearly rate", "Speedup"]}
        rows={[
          ["simSOL (sim_lst)", "Solana devnet", "7%", "4,380x"],
          ["simETH (SimLST)", "Ethereum Hoodi", "5%", "4,380x"],
          ["simHYPE (SimLST)", "HyperEVM testnet", "5%", "4,380x"],
        ]}
      />

      <H2 id="minting">How yield becomes real tokens</H2>
      <p>The exchange rate of the LST is <b>constant</b>. Yield is minted into each Position&apos;s vault instead of read off a growing rate.</p>
      <ul>
        <li>
          <b>Solana.</b> <code>accrue_native_yield</code> (permissionless; the keeper cranks it) computes{" "}
          <code>principal * apy_bps * dt * speedup / (10_000 * 31_536_000)</code> SOL units since the custody&apos;s <code>last_accrual_ts</code>, converts to shares at the constant rate, and
          CPIs <code>sim_lst::mint_yield</code>. That instruction can be called only by the recorded yield authority, the tesoro_core PDA <code>[&quot;yield&quot;]</code>, which the sim_lst admin
          registered once. If the floor gives zero shares, the timestamp does not advance, so time carries over. Accrual stops at Unlock.
        </li>
        <li>
          <b>EVM.</b> <code>SimLST</code> has a frozen rate and a <code>minter</code> (the vault). The vault&apos;s <code>accrue(id)</code> runs at the start of <code>reportYield</code> and mints the
          same formula into itself. The real-wstETH vault has no minter and keeps real wstETH yield.
        </li>
      </ul>
      <p>
        Custody accounting is unchanged: <code>accrued = vault_shares * rate - principal + redeemed</code>. Because the rate is constant, accrued grows only through minting, so every
        unit of accrued yield is a share in the vault and a Redeem is always covered. Tokens sent straight into a vault are not yield (audit F-05).
      </p>

      <H2 id="reserve">The reserve</H2>
      <p>
        Minted yield shares are not backed by deposited SOL or ETH. Withdrawals are paid from a reserve the team funds (<code>fund_reserve</code> on Solana, ETH sent to{" "}
        <code>SimLST</code>). While Debt is outstanding, a Position&apos;s total reserve claim is bounded by <code>principal * apy * horizon_months / 12</code>; at 7% and a one-month Advance
        that is 0.58% of Principal. A Position that stays Locked after its Debt reaches zero keeps accruing, and that free yield is drawn from the reserve only if the owner withdraws it.
        Faucets mint unbacked test tokens at 10 per hour per address.
      </p>

      <H2 id="where-in-code">Where it lives</H2>
      <ul>
        <li>One function in the app, <code>app/src/lib/chain/yield.ts</code>, gives accrued yield from <code>(principal, rateBps, elapsed, speedup)</code>. The quote, Unlock Estimate, projected Debt and charts all use it.</li>
        <li><code>programs/sim_lst</code>, <code>programs/tesoro_core/src/ledger/native.rs</code>, <code>contracts/src/SimLST.sol</code>, <code>contracts/src/PositionVault.sol</code>.</li>
      </ul>
      <p>
        The security consequences (faucet sybils, reserve drain, admin-set rates) are accepted for testnets and listed in <Link href="/docs/developers/security">Security</Link>.
      </p>
    </DocPage>
  );
}

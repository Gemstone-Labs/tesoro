import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2, H3 } from "@/components/docs/prose";
import { Diagram, Stats } from "@/components/docs/visual";

export const metadata: Metadata = { title: "Security", alternates: { canonical: "/docs/developers/security" } };

export default function Page() {
  return (
    <DocPage href="/docs/developers/security" hero={<Diagram label="Security review at a glance" caption="Two internal reviews and one contained key incident. No external audit.">
  <Stats items={[{ value: "14", label: "findings, review 1" }, { value: "29", label: "findings, review 2" }, { value: "2", label: "internal reviews" }, { value: "0", label: "external audits" }, { value: "1", label: "key incident, test funds" }]} />
</Diagram>}>
      <Callout kind="warn" title="Internal reviews, not an external audit">
        <p>
          Both reviews below were done internally, before submission. Neither is an independent audit, and neither is a guarantee. Every
          deployment is on a test network.
        </p>
      </Callout>

      <H2 id="review-1">Security review, 30 September 2026</H2>
      <p>
        Scope: <code>tesoro_core</code>, both Game programs that existed then, <code>sim_lst</code>, <code>tesoro_bridge</code> and the EVM contracts. It found 14 findings
        (1 Critical, 3 High, 3 Medium, 6 Low, 1 Info). For each, a failing proof test was written first. The full table and fix commits are in{" "}
        <code>docs/security/audit-2026-09-30.md</code> in the repository.
      </p>
      <DataTable
        head={["Finding", "Severity", "Issue", "Status"]}
        rows={[
          ["F-01", "Critical", "A Game's state could be delegated to a validator the attacker controls, committing a forged result.", "Fixed and deployed: delegation pinned to the TEE validator via ProgramConfig and in the Game programs."],
          ["F-02", "High", "A pre-funded permission address could skip privacy.", "Fixed and deployed."],
          ["F-03", "High", "A losing Hold'em Player could stall to the one-hour refund.", "Fixed and deployed: the refund deadline is extended when the table is created."],
          ["F-04", "High", "Out-of-order LayerZero delivery could strand Unlock or PayYield on an EVM vault.", "Fixed: per-sequence idempotency; vaults redeployed."],
          ["F-05", "Medium", "Sending simSOL straight to a vault repaid Debt.", "Fixed and deployed: custody counts its own shares."],
          ["F-06, F-07, F-09, F-12", "Medium and Low", "Last-second join forfeit; plain redeem burning an EVM-sourced Gema; joining before a Session exists; a Request stuck as Accepted.", "Fixed and deployed (F-09 except match_id squatting)."],
          ["F-13", "Low", "A PayYield above accrued yield reverts while Solana has counted it.", "Mitigated: LayerZero retries once yield catches up."],
          ["F-08, F-10, F-11, F-14", "Low and Info", "Unbacked faucets and reserve; first-caller Config init; faucet griefing; rounding dust and notes.", "Accepted for testnets."],
        ]}
      />

      <H2 id="review-2">Implementation review, 30 September to 1 October 2026</H2>
      <p>
        Scope: the app, keeper, server routes, contracts and programs. It found 29 findings (P1: 2, P2: 14, P3: 13). The two P1s were an EVM vault underpaying yield after an
        earlier payout (SP-01, fixed with redeployed vaults) and a faucet quota rollback that could be bypassed (ST-01, fixed). Other fixes include Principal above <code>u64</code>{" "}
        locking a deposit for good (PR-01), ETH redemption tracked against the wrong Source (SP-02, SP-03), a stale price re-stamped as fresh (OC-01), the web server holding
        admin keys (OC-02, now low-balance relayer keys), and one hung RPC stalling every keeper job (OC-05). The status table is in the repository&apos;s README.
      </p>
      <p>
        Items that need a program upgrade were open at the last status update: a no-show turning a forfeit win into a refund (PR-02), an Advance priced from a feed up to 24
        hours old (PR-03), and on-chain bounds on <code>set_price</code>.
      </p>

      {/* TODO(verify-after-merge): README still has a placeholder for how the key leaked; add it here if the founder states it. */}
      <H2 id="incident">Key compromise, 1 October 2026</H2>
      <p>
        At 05:26 UTC the original devnet deployer key <code>AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV</code> sent its whole balance, 24.63 devnet SOL, to another address
        (transaction <code>2WbwBf9X…FgYqiMWR</code>). The key held only testnet funds, but it was the upgrade authority of every program, the admin of{" "}
        <code>tesoro_core</code>, <code>sim_lst</code> and <code>tesoro_bridge</code>, the LayerZero OApp delegate, and the owner of the fee recipient. The team treated it as compromised.
      </p>
      <H3 id="response">Response, the same day</H3>
      <ul>
        <li>Upgrade authority of all programs moved to <code>7zr1j185zT8r6jcysC4LyrdSEJ13Up3xq4TFu6KQqh7M</code> (verified on chain on 10 October 2026).</li>
        <li>
          A <code>set_admin</code> instruction, gated on the upgrade authority, was added to tesoro_core, sim_lst and tesoro_bridge, and used to rotate the Config, Pool and Store
          admins and the LayerZero delegate.
        </li>
        <li>The Platform and Studio Fee recipient moved to a new Account. Fees the old Account had already collected stay under the old key.</li>
        <li>The web routes now sign with separate low-balance relayer keys, and a pre-commit secret scanner was added to the repository.</li>
      </ul>
      <p>Signatures are in <code>docs/deployments.md</code>, under &ldquo;Key compromise response&rdquo;.</p>

      <H2 id="residual">Residual risk and trust assumptions</H2>
      <ul>
        <li>The oracle key and price feed are trusted. A wrong price mints the wrong number of Gemas.</li>
        <li>Privacy depends on MagicBlock&apos;s TEE attestation and operator. Cross-chain messages depend on the LayerZero DVN set (default: LayerZero Labs).</li>
        <li>One admin key holds every admin power and can upgrade every program. There is no multisig and no timelock.</li>
        <li>Faucets mint unbacked test tokens and withdrawals draw on an admin-funded reserve; admins can change rate parameters.</li>
      </ul>
      <p>
        Not reviewed: the MagicBlock, LayerZero and Pyth programs themselves. The player-facing summary is on <Link href="/docs/risks">Risks and limits</Link>.
      </p>

      <H2 id="reporting">Reporting a problem</H2>
      {/* TODO(verify-after-merge): no security contact is documented in the repo; add one if the founder provides it. */}
      <p>No dedicated security contact is published yet.</p>
    </DocPage>
  );
}

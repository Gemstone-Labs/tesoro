import type { Metadata } from "next";
import Link from "next/link";
import { DataTable, DocPage, H2, H3 } from "@/components/docs/prose";
import { Architecture } from "@/components/docs/visual";

export const metadata: Metadata = { title: "Architecture", alternates: { canonical: "/docs/developers" } };

export default function Page() {
  return (
    <DocPage href="/docs/developers" hero={<Architecture />}>
      <p>
        One ledger on Solana, Games as on-chain programs that run their hidden state inside MagicBlock Private Ephemeral Rollups, Positions on their
        home chains, and LayerZero V2 carrying four messages between them. There are no game servers in the settlement path.
      </p>

      <H2 id="components">Components</H2>
      <DataTable
        head={["Piece", "Role", "Where"]}
        rows={[
          [<code key="a">tesoro_core</code>, "The money rules. A pure, property-tested accounting core wrapped by thin Anchor instructions: Accounts, Positions, Sources, Holdings, Matches and Pots, Fees, Backing, the Game registry and the price feed.", <code key="a2">programs/tesoro_core</code>],
          [<><code>block_puzzle</code>, <code>holdem</code>, <code>trading_duel</code></>, "Game programs. Each keeps its Match state in a rollup, computes the result itself, and settles by CPI into tesoro_core signed by its own authority PDA.", <code key="b2">programs/*</code>],
          [<code key="c">sim_lst</code>, "The liquid staking token behind SOL Positions (simSOL).", <code key="c2">programs/sim_lst</code>],
          [<code key="d">tesoro_bridge</code>, "Solana side of the LayerZero V2 OApp. Records inbound facts, applies them to tesoro_core as the registered source authority, and sends Unlock and PayYield out.", <code key="d2">bridge/</code>],
          [<code key="e">PositionVaultOApp</code>, "EVM vault that locks the staking token and speaks LayerZero. Releases Principal only on Unlock and pays at most the accrued yield.", <code key="e2">contracts/src</code>],
          ["Keeper", "Off-chain liveness: price feed, yield cranks, bridge relays, expiries, stalled-Match settlement. A fee payer only; every job is permissionless.", <code key="f2">keeper/</code>],
          ["App", "Next.js 16, desktop first. Reads chain state directly and signs with Privy embedded or linked wallets. A few server routes cover small fees and relay Ethereum steps.", <code key="g2">app/</code>],
        ]}
      />

      <H2 id="principles">Design rules the code enforces</H2>
      <ul>
        <li>
          <b>Principal is never played and never pays Debt.</b> No ledger function reads Principal after an Advance is sized. The only paths that lower
          Debt are the Position&apos;s own yield and the owner returning their own Gemas. Property-tested.
        </li>
        <li>
          <b>A Gema is a claim on its Source.</b> The dollar price is used once, at issuance. Debt is kept in Gemas and converted to the Source asset on
          demand. See ADR 0001.
        </li>
        <li>
          <b>Games are programs, not services.</b> A Studio integrates by shipping a program and registering it, not by running a server (ADR 0003).
        </li>
        <li>
          <b>One transport.</b> LayerZero V2 carries every cross-chain message; every payload carries a sequence number and a Position id and every
          handler is idempotent (ADR 0002).
        </li>
        <li>
          <b>PvP only.</b> Gemas are spent only on zero-sum contests between Players, never on purchases (ADR 0004).
        </li>
      </ul>

      <H2 id="trust-boundaries">Trust boundaries</H2>
      <DataTable
        head={["Boundary", "Trusted for", "Where it is checked"]}
        rows={[
          ["Registered Game authority", "Declaring a Match result.", "tesoro_core `settle_match` accepts only the signer registered for that Game. The authority is a PDA of the Game program."],
          ["Oracle key", "Oracle-reported Positions and, in test mode, the issuance price (Solana: the on-chain `PriceFeed`, at most 24 h old; Ethereum: signed with the Advance). On mainnet Advances read Pyth's price feeds on chain and the oracle names no price.", "Single key today. Pyth is planned as a replacement for the source, not for the instruction."],
          ["MagicBlock TEE validator", "Keeping hidden state private; running the Game programs' rollup logic.", "Delegation is pinned to one approved validator per Game program."],
          ["LayerZero DVNs", "Truthful delivery of the four messages.", "Default pathway config. Handlers are idempotent per sequence; the vault caps a payout at its accrued yield."],
          ["Admin key", "Registering Games, fees, source authorities, program upgrades.", "One key. No multisig or timelock."],
        ]}
      />

      <H3 id="read-more">Read next</H3>
      <ul>
        <li><Link href="/docs/developers/programs">Programs and addresses</Link> for IDs and explorer links.</li>
        <li><Link href="/docs/developers/settlement">How settlement works</Link> for the Game-to-ledger interface.</li>
      </ul>
    </DocPage>
  );
}

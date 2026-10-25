import type { Metadata } from "next";
import { DataTable, DocPage, H2 } from "@/components/docs/prose";
import { ChainPath } from "@/components/docs/visual";
import { INSTANT_PAYOUT_PCT } from "@/lib/chain/yield";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: "Cross-chain with LayerZero V2", alternates: { canonical: "/docs/developers/cross-chain" } };

export default function Page() {
  return (
    <DocPage href="/docs/developers/cross-chain" hero={<ChainPath detail />}>
      <p>
        Locks stay on their home chains while Gemas, Advances, Matches and Backings live on Solana, so four messages cross chains. They travel over
        LayerZero V2, which reaches all three chains with managed relaying, rather than a relayer run by {BRAND.name}.
      </p>

      <H2 id="messages">The four messages</H2>
      <DataTable
        head={["#", "Message", "Direction", "Effect"]}
        rows={[
          ["1", <code key="1">PositionLocked</code>, "EVM vault to Solana", "A Lock (the on-chain Position) now exists: owner, LST, locked amount, length. The bridge applies it to tesoro_core."],
          ["2", <code key="2">YieldAccrued(cumulative)</code>, "EVM vault to Solana", "Cumulative yield. tesoro_core pays back the Advance first; the rest is free yield. Applied once per sequence."],
          ["3", <code key="3">Unlock</code>, "Solana to EVM vault", "Nothing is left to pay back and the owner unlocked: the vault releases the locked amount to the owner."],
          ["4", <code key="4">PayYield(to, amount)</code>, "Solana to EVM vault", "A holder redeemed Gemas from this Lock: the vault pays that amount in LST shares, never more than accrued yield."],
        ]}
      />
      <p>
        Wire format (identical in Solidity and Rust, <code>abi.encodePacked</code>, big-endian): header <code>msgType u8 | sourceChain u32 (eid) | positionId
        bytes32 | seq u64</code> (45 bytes), then the body. The <code>positionId</code> is the vault address (20 bytes), the vault&apos;s Lock id (u64) and 4 zero
        bytes, so two vaults on one chain never collide and a vault can speak only for its own Locks. Every handler is idempotent per sequence number.
      </p>

      <H2 id="pieces">Pieces</H2>
      <DataTable
        head={["Piece", "Role"]}
        rows={[
          [<code key="1">PositionVaultOApp</code>, "A PositionVault that is a LayerZero OApp. openPosition sends PositionLocked, reportYield sends YieldAccrued (cumulative yield and the vault Treasury's cumulative credits, 77 bytes), and _lzReceive feeds Unlock, PayYield and PayInstant to the vault. The vault reports and pays the whole yield; Solana works out the Yield Fee for each cash-out and names the split in the PayYield message."],
          [<code key="2">tesoro_bridge</code>, "Solana OApp: an inbox for inbound facts, permissionless CPIs into tesoro_core, permissionless outbound sends."],
          [<code key="3">SourceAuthority</code>, "A tesoro_core PDA per source chain naming the signer allowed to report PositionLocked and YieldAccrued. The bridge authority PDA is registered for Ethereum and HyperEVM, so an Ethereum authority cannot touch a HyperEVM Lock."],
        ]}
      />

      <H2 id="flow">Flow and who pays</H2>
      <ol>
        <li>
          <b>Link, once.</b> The Account&apos;s Solana wallet calls <code>tesoro_bridge::link_evm</code> with an EIP-191 signature from the EVM wallet over{" "}
          <code>Tesoro: link EVM address to Account &lt;TesoroAccount PDA&gt;</code>. The bridge recovers the signer on chain with <code>secp256k1_recover</code>, so nobody
          can claim someone else&apos;s address.
        </li>
        <li>
          <b>Inbox record.</b> Anyone creates the record with <code>init_position(eid, positionId)</code> before the message (about 0.003 SOL), because the default
          executors cap the native drop to Solana at 0 and rent cannot be paid inside <code>lz_receive</code>.
        </li>
        <li>
          <b>openPosition(lstAmount, months).</b> The caller pays the LayerZero fee in the chain&apos;s native coin (the app reads <code>quotePositionLocked()</code> and adds about
          20%; the excess is refunded).
        </li>
        <li>
          <b>apply_locked.</b> Permissionless: the bridge CPIs <code>open_position_from_source</code>, signed by its PDA. <code>PeerConfig</code> per vault supplies decimals and rate.
          The locked amount must fit <code>u64</code>, so up to about 18 ETH; the vault refuses larger deposits.
        </li>
        <li><b>Advance.</b> The oracle path in tesoro_core: the owner and the oracle co-sign, the oracle supplies the issuance price.</li>
        <li>
          <b>reportYield, then apply_yield, only when an action needs it.</b> Nothing reports in the background. Redeem, Redeem now and Unlock first ask the vault for a report (the app does it for the Player; anyone may), wait until <code>apply_yield</code> has applied it on Solana, then continue. The vault computes its Accrued Yield on the spot, so the figure includes everything earned up to that block.
        </li>
        <li>
          <b>Redeem.</b> The holder calls <code>tesoro_bridge::redeem_to_evm</code>, which CPIs <code>redeem_from_source</code> and records the units in a <code>Claim</code>.
          Anyone then calls <code>send_pay_yield</code>, which advances <code>units_sent</code> in the same transaction so a unit is paid once. Plain <code>redeem</code> refuses
          EVM-sourced Sources.
        </li>
        <li>
          <b>Redeem now.</b> The holder calls <code>tesoro_bridge::instant_redeem_to_evm</code>, which moves their won Gemas to {BRAND.name}&apos;s Treasury Account and
          pays {INSTANT_PAYOUT_PCT}% of their value (after the Yield Fee and the Instant Redeem Fee). The bridge keeps a mirror of each vault&apos;s Treasury (<code>VaultTreasury</code>) and refuses a payout the vault has not reported
          funds for (the vault&apos;s balance at its latest report, less payouts recorded since). Anyone then calls <code>send_pay_instant</code> (message type 5), and the vault pays from its Treasury. To refill, the Treasury Account redeems the
          Gemas it bought as the yield lands (<code>redeem_treasury_to_evm</code>) and a <code>PayYield</code> to the vault&apos;s own address books the proceeds into its Treasury.
        </li>
        <li>
          <b>Unlock.</b> After <code>tesoro_core::unlock</code>, anyone calls <code>send_unlock</code>. Yield still owed to redeemers stays in the vault.
        </li>
      </ol>
      <p>
        <code>lz_receive</code> deliberately only records the fact: its account list is derived from the message alone and cannot include the Account, the open Source or
        rent-funded accounts. Applying is a second, permissionless transaction.
      </p>

      <H2 id="endpoints">Endpoints and latency</H2>
      <DataTable
        head={["Chain", "Chain id", "LayerZero eid", "Observed delivery"]}
        rows={[
          ["Solana", "n/a", "40168", "Solana to Ethereum about 4 to 5 minutes"],
          ["Ethereum", "560048", "40449", "Ethereum to Solana about 2 minutes"],
          ["HyperEVM", "998", "40362", "Both directions delivered in roughly 40 to 80 seconds"],
        ]}
        caption="Observed delivery times; not guarantees"
      />
      <p>
        The default pathway configuration uses LayerZero Labs as the single required DVN. Fees seen: about 0.0001 ETH per Ethereum send, about 0.0074 HYPE per HyperEVM
        send (so a wallet needs roughly 0.02 HYPE to open a Lock), and about 0.0003 SOL per Solana send.
      </p>

      <H2 id="failure">Failure behaviour</H2>
      <ul>
        <li>Vaults record each sequence as handled, so messages can arrive in any order without stranding an Unlock or PayYield.</li>
        <li>A PayYield larger than the vault&apos;s accrued yield reverts, and a reverted receive rolls back its handled mark, so LayerZero can retry it once yield catches up.</li>
        <li>The vault always caps a payout at its own accrued yield, so a lying DVN could report false yield but could not drain the locked amount through PayYield.</li>
      </ul>
    </DocPage>
  );
}

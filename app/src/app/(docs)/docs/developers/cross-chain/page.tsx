import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DataTable, DocPage, H2, H3, Sim } from "@/components/docs/prose";

export const metadata: Metadata = { title: "Cross-chain with LayerZero V2", alternates: { canonical: "/docs/developers/cross-chain" } };

export default function Page() {
  return (
    <DocPage href="/docs/developers/cross-chain">
      <p>
        Positions stay on their home chains while Gemas, Debt, Matches and Backings live on Solana, so four messages cross chains. ADR 0002 picks
        LayerZero V2 on Solana devnet, Ethereum Hoodi and HyperEVM testnet: the only transport verified to reach all three with managed relaying. A trusted
        Tesoro relayer was rejected in favour of real infrastructure.
      </p>

      <H2 id="messages">The four messages</H2>
      <DataTable
        head={["#", "Message", "Direction", "Effect"]}
        rows={[
          ["1", <code key="1">PositionLocked</code>, "EVM vault to Solana", "A Position now exists: owner, LST, Principal, Horizon. The bridge applies it to tesoro_core."],
          ["2", <code key="2">YieldAccrued(cumulative)</code>, "EVM vault to Solana", "Cumulative yield. tesoro_core repays Debt first; the rest is free yield. Applied once per sequence."],
          ["3", <code key="3">Unlock</code>, "Solana to EVM vault", "Debt is zero and the owner unlocked: the vault releases Principal to the owner."],
          ["4", <code key="4">PayYield(to, amount)</code>, "Solana to EVM vault", "A holder redeemed Gemas Sourced from this Position: the vault pays that amount in LST shares, never more than accrued yield."],
        ]}
      />
      <p>
        Wire format (identical in Solidity and Rust, <code>abi.encodePacked</code>, big-endian): header <code>msgType u8 | sourceChain u32 (eid) | positionId
        bytes32 | seq u64</code> (45 bytes), then the body. The <code>positionId</code> is the vault address (20 bytes), the vault&apos;s Position id (u64) and 4 zero
        bytes, so two vaults on one chain never collide and a vault can speak only for its own Positions. Every handler is idempotent per sequence number.
      </p>

      <H2 id="pieces">Pieces</H2>
      <DataTable
        head={["Piece", "Role"]}
        rows={[
          [<code key="1">PositionVaultOApp</code>, "A PositionVault that is a LayerZero OApp. openPosition sends PositionLocked, reportYield sends YieldAccrued, and _lzReceive feeds Unlock and PayYield to the vault."],
          [<code key="2">tesoro_bridge</code>, "Solana OApp: an inbox for inbound facts, permissionless CPIs into tesoro_core, permissionless outbound sends."],
          [<code key="3">SourceAuthority</code>, "A tesoro_core PDA per source chain naming the signer allowed to report PositionLocked and YieldAccrued. The bridge authority PDA is registered for Ethereum and HyperEVM, so an Ethereum authority cannot touch a HyperEVM Position."],
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
          Principal must fit <code>u64</code>, so up to about 18 ETH; the vault refuses larger deposits.
        </li>
        <li><b>Advance.</b> The oracle path in tesoro_core: the owner and the oracle co-sign, the oracle supplies the issuance price.</li>
        <li>
          <b>reportYield, then apply_yield.</b> The vault accrues first, so the cumulative figure includes everything earned up to that block. Debt falls automatically.
        </li>
        <li>
          <b>Redeem.</b> The holder calls <code>tesoro_bridge::redeem_to_evm</code>, which CPIs <code>redeem_from_source</code> and records the units in a <code>Claim</code>.
          Anyone then calls <code>send_pay_yield</code>, which advances <code>units_sent</code> in the same transaction so a unit is paid once. Plain <code>redeem</code> refuses
          EVM-sourced Sources (audit F-07).
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
          ["Solana devnet", "n/a", "40168", "Solana to Hoodi about 4 to 5 minutes"],
          ["Ethereum Hoodi", "560048", "40449", "Hoodi to Solana about 2 minutes"],
          ["HyperEVM testnet", "998", "40362", "Both directions delivered in roughly 40 to 80 seconds"],
        ]}
        caption="Measured during the build; not guarantees"
      />
      <p>
        The default pathway configuration uses LayerZero Labs as the single required DVN. Fees seen: about 0.0001 ETH per Hoodi send, about 0.0074 HYPE per HyperEVM
        send (so a wallet needs roughly 0.02 HYPE to open a Position), and about 0.0003 SOL per Solana send.
      </p>

      <H3 id="hyperevm-gas">HyperEVM testnet gas</H3>
      <p>
        There is no HYPE faucet to relay, so the app server sends a small top-up (0.03 HYPE if the wallet holds under 0.02, once a day per wallet, with a global hourly limit)
        from a low-balance relayer key.
      </p>

      <H2 id="failure">Failure behaviour</H2>
      <ul>
        <li>An out-of-order delivery could once strand an Unlock or PayYield (audit F-04). Vaults now record each sequence as handled, so order does not matter, and the vaults were redeployed.</li>
        <li>A PayYield larger than the vault&apos;s accrued yield reverts, and a reverted receive rolls back its handled mark, so LayerZero can retry it once yield catches up (F-13).</li>
        <li>The vault always caps a payout at its own accrued yield, so a lying DVN could report false yield but could not drain Principal through PayYield.</li>
      </ul>

      <Callout kind="sim" title="Simulated tokens">
        <p>
          The vaults the app uses hold <Sim>simETH</Sim> and <Sim>simHYPE</Sim> with simulated yield. A vault for Lido&apos;s real wstETH is deployed on Hoodi with a rate adapter
          that reads wstETH&apos;s <code>stEthPerToken()</code>, but it has not been run end to end. See <Link href="/docs/developers/simulated-yield">Simulated yield</Link>.
        </p>
      </Callout>
    </DocPage>
  );
}

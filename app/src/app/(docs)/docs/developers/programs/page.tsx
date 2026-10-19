import type { Metadata } from "next";
import { Addr, DataTable, DocPage, H2, H3, explorer, hoodi, purrsec } from "@/components/docs/prose";
import { CopyButton } from "@/components/docs/CopyButton";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: "Programs and addresses", alternates: { canonical: "/docs/developers/programs" } };

function ProgramId({ id }: { id: string }) {
  return (
    <span className="docs-pid">
      <code>{id}</code>
      <CopyButton value={id} label={`Copy ${id}`} />
      <a className="docs-ext" href={explorer(id)} rel="noopener noreferrer" target="_blank">Explorer</a>
    </span>
  );
}

export default function Page() {
  return (
    <DocPage href="/docs/developers/programs">
      <H2 id="solana">Solana</H2>
      <DataTable
        head={["Program", "ID"]}
        rows={[
          [<code key="1">tesoro_core</code>, <ProgramId key="1a" id="AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh" />],
          [<code key="2">block_puzzle</code>, <ProgramId key="2a" id="5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj" />],
          [<code key="3">holdem</code>, <ProgramId key="3a" id="CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE" />],
          [<code key="4">trading_duel</code>, <ProgramId key="4a" id="CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj" />],
          [<code key="4v">vanguard</code>, <ProgramId key="4va" id="TS3iowavNFV2pMUrHcbmGNC9SW2Vv54i52DqjKebYKH" />],
          [<code key="5">sim_lst</code>, <ProgramId key="5a" id="WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F" />],
          [<code key="6">tesoro_bridge</code>, <ProgramId key="6a" id="5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ" />],
        ]}
        caption="Copy an ID or open it in Solana Explorer"
      />

      <H3 id="solana-accounts">Accounts and authorities</H3>
      <Addr label="Upgrade authority of all six programs; admin of tesoro_core, sim_lst and tesoro_bridge; LayerZero OApp delegate" value="7zr1j185zT8r6jcysC4LyrdSEJ13Up3xq4TFu6KQqh7M" href={explorer("7zr1j185zT8r6jcysC4LyrdSEJ13Up3xq4TFu6KQqh7M")} />
      <Addr label="tesoro_core Config PDA (seeds: config)" value="Che6m7vayXRFRn4Sti9FH4V4usE5bPEyPUvkiHP6hDgZ" href={explorer("Che6m7vayXRFRn4Sti9FH4V4usE5bPEyPUvkiHP6hDgZ")} note="Platform Fee 200 bps; registered Games with Studio Fee 300 bps each. Read on 10 October 2026." />
      <Addr label="Oracle (price and Ethereum issuance signer)" value="6bpAyMvaHF5QdghrxnPRmdvHqCiLbigdXVroe4zDRApA" href={explorer("6bpAyMvaHF5QdghrxnPRmdvHqCiLbigdXVroe4zDRApA")} />
      <Addr label={`Platform and Studio Fee recipient (a ${BRAND.name} Account)`} value="GXQse6RG4hqY57fhRJX3W7yzhkwmaqZUHxaJArJWrMGK" href={explorer("GXQse6RG4hqY57fhRJX3W7yzhkwmaqZUHxaJArJWrMGK")} />
      <Addr label="Treasury PDA (seeds: treasury): Yield Fee and Instant Redeem Fee rates" value="BuWgG4Q7DYND13twkfu5gHVGpoK78GbWJzAeEgv6aDQr" href={explorer("BuWgG4Q7DYND13twkfu5gHVGpoK78GbWJzAeEgv6aDQr")} />
      <Addr label="Treasury simSOL vault (seeds: treasury_vault): collects the Yield Fee, pays Instant Redeems" value="7XLRyApCUdeTRyh7c7mLHh2zKE6X1ej1SFJ7F6hgrsU4" href={explorer("7XLRyApCUdeTRyh7c7mLHh2zKE6X1ej1SFJ7F6hgrsU4")} />
      <Addr label="Treasury Account (holds the Gemas bought by Instant Redeem)" value="71hCesb8eED3yoFjgxDG8fSfqgZV4Ngfnr2sX3jHL5Yg" href={explorer("71hCesb8eED3yoFjgxDG8fSfqgZV4Ngfnr2sX3jHL5Yg")} />
      <Addr label="block_puzzle Game authority PDA (seeds: authority)" value="7HTncQ9Gc2gamBqce5C7sz95SU6RnR9CoDt1D3o2U4nx" href={explorer("7HTncQ9Gc2gamBqce5C7sz95SU6RnR9CoDt1D3o2U4nx")} />
      <Addr label="holdem Game authority PDA" value="Eu2RtadRsFCV9Xe2A7v7GivS9W5Trbrz6tCagNRUCwtn" href={explorer("Eu2RtadRsFCV9Xe2A7v7GivS9W5Trbrz6tCagNRUCwtn")} />
      <Addr label="trading_duel Game authority PDA" value="mPXSGjpEeSeJnmrBw3CKCoLbbftAsjsbiP1eE3wHcoe" href={explorer("mPXSGjpEeSeJnmrBw3CKCoLbbftAsjsbiP1eE3wHcoe")} />
      <Addr label="MagicBlock TEE validator (the only validator allowed to receive delegations)" value="MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo" href={explorer("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo")} />
      <Addr label="holdem delegation ProgramConfig (validator whitelist)" value="CVBjwJ8LaJS37zokHDjgkWASNPW9X5oWxmCHT2DvVKL3" href={explorer("CVBjwJ8LaJS37zokHDjgkWASNPW9X5oWxmCHT2DvVKL3")} />
      <Addr label="trading_duel delegation ProgramConfig (validator whitelist)" value="43amrCapYPLYz9tGPcdxw84A3Hby9j4kSTmDTCmu7xZb" href={explorer("43amrCapYPLYz9tGPcdxw84A3Hby9j4kSTmDTCmu7xZb")} />

      <H3 id="sim-lst">sim_lst</H3>
      <Addr label="Pool PDA (seeds: pool)" value="Fc9UUnGEDapkBDM3mPayjqVDLYHokKCPwSLdbvKBUvPL" href={explorer("Fc9UUnGEDapkBDM3mPayjqVDLYHokKCPwSLdbvKBUvPL")} note="7% APY, 4,380x speedup." />
      <Addr label="simSOL mint PDA (seeds: mint, 9 decimals)" value="3Q2VRPmdAZHutWNhE2Rof9Pdg6MnTMotXucmoD5cgAZJ" href={explorer("3Q2VRPmdAZHutWNhE2Rof9Pdg6MnTMotXucmoD5cgAZJ")} />
      <Addr label="Vault / reserve PDA (seeds: vault)" value="2fQyEVMJNzGmaccxpbzhqMRFSpx9mf1kjsZRAMMRNKDm" href={explorer("2fQyEVMJNzGmaccxpbzhqMRFSpx9mf1kjsZRAMMRNKDm")} />
      <Addr label="Yield authority: tesoro_core PDA (seeds: yield)" value="C9zdFERGijamSQVQ1D4hE3iabc99g1XcurKCnS6CuSAf" href={explorer("C9zdFERGijamSQVQ1D4hE3iabc99g1XcurKCnS6CuSAf")} note="The only signer allowed to call sim_lst::mint_yield." />

      <H3 id="bridge">tesoro_bridge</H3>
      <Addr label="OApp Store PDA (the EVM vaults' LayerZero peer)" value="7WQLHW8EuyV1V8tWNh8DQGu7mVRgaHGgLU7fi8G91rVw" href={explorer("7WQLHW8EuyV1V8tWNh8DQGu7mVRgaHGgLU7fi8G91rVw")} note="As bytes32: 0x60ae58df1215bf45cc054e633b49c92a3b1309f76075bac72b26e0c6e1c0c792" />
      <Addr label="Bridge authority PDA (tesoro_core source authority for Ethereum and HyperEVM)" value="FEgxs5f7zavRaR7tZJBNZzrYeCMGegMpMWFiHjvyvaLg" href={explorer("FEgxs5f7zavRaR7tZJBNZzrYeCMGegMpMWFiHjvyvaLg")} />

      <H3 id="price-feeds">Trading Duel price feeds</H3>
      <p>
        MagicBlock&apos;s real-time pricing program <code>PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd</code> (Pyth Lazer prices pushed into rollup
        accounts). The accounts are read on the rollup and in the TEE; on the base layer they are delegated accounts.
      </p>
      <Addr label="SOL/USD" value="ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu" />
      <Addr label="ETH/USD" value="5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG" />
      <Addr label="HYPE/USD" value="CxEkVoCUwSAprvAhdWRPH63JeioQVNDtyZYEMRXuLu6x" />

      <H2 id="ethereum">Ethereum (chain 560048, LayerZero eid 40449)</H2>
      <p>
        Vaults are not upgradeable. They are owned by the EVM deployer <code>0x96137cB99Fe2878299b672Ac967e88279f479d1C</code> and peered to the Solana
        OApp Store above. Solana&apos;s LayerZero eid is 40168.
      </p>
      <Addr label="PositionVaultOApp for SimLST (simETH). The vault the app uses." value="0x191700BA53C9437F3a31E082bcfd8bB85C865d26" href={hoodi("0x191700BA53C9437F3a31E082bcfd8bB85C865d26")} />
      <Addr label="SimLST (simETH, 5% APY)" value="0xD82840623A7a00C37b0883d221Fa84e39ddA2a28" href={hoodi("0xD82840623A7a00C37b0883d221Fa84e39ddA2a28")} />
      <Addr label="PositionVaultOApp for real Lido wstETH" value="0x61B46f64CDB75930a87955487aAb8A7711F757b5" href={hoodi("0x61B46f64CDB75930a87955487aAb8A7711F757b5")} />
      <Addr label="WstETHRateAdapter" value="0x9C5fc1098a33Ec14a9c5a73c2cBa1CbcDD65AB37" href={hoodi("0x9C5fc1098a33Ec14a9c5a73c2cBa1CbcDD65AB37")} />
      <Addr label="LayerZero EndpointV2 (external)" value="0x3aCAAf60502791D199a5a5F0B173D78229eBFe32" href={hoodi("0x3aCAAf60502791D199a5a5F0B173D78229eBFe32")} />

      <H2 id="hyperevm">HyperEVM (chain 998, LayerZero eid 40362)</H2>
      <p>Same owner and the same Solana peer. Explorer: <code>testnet.purrsec.com</code>.</p>
      <Addr label="PositionVaultOApp for SimLST (simHYPE). The vault the app uses." value="0x61B46f64CDB75930a87955487aAb8A7711F757b5" href={purrsec("0x61B46f64CDB75930a87955487aAb8A7711F757b5")} />
      <Addr label="SimLST (simHYPE, 5% APY)" value="0xC8A9AccD25ABDCF3FCBDE7123Cef8239B5bE7eF3" href={purrsec("0xC8A9AccD25ABDCF3FCBDE7123Cef8239B5bE7eF3")} />
      <Addr label="LayerZero EndpointV2 (external)" value="0xf9e1815f151024bde4b7c10bac10e8ba9f6b53e1" href={purrsec("0xf9e1815f151024bde4b7c10bac10e8ba9f6b53e1")} />

      <H2 id="verify">How to verify</H2>
      <ul>
        <li>
          <b>Programs.</b> <code>solana program show &lt;id&gt; --url https://rpc.magicblock.app/devnet</code> prints the upgrade authority and the last deploy
          slot.
        </li>
        <li>
          <b>Fees.</b> Read the Config account (PDA seed <code>config</code> of tesoro_core). The Platform Fee is a u16 after the admin and oracle keys;
          each registered Game carries its own Studio Fee in basis points. The Yield Fee and the Instant Redeem Fee are on the Treasury account
          (PDA seed <code>treasury</code>); each EVM vault reports its own <code>yieldFeeBps()</code> and treasury balance.
        </li>
        <li>
          <b>Matches.</b> Every Match is a tesoro_core account and its settlement is an ordinary Solana transaction. Rollup (TEE) transactions are
          private and have no public explorer page.
        </li>
        <li>
          <b>Cross-chain.</b> Follow a message on <a href="https://testnet.layerzeroscan.com" rel="noopener noreferrer" target="_blank">LayerZero Scan</a>{" "}
          by its source transaction hash.
        </li>
      </ul>
    </DocPage>
  );
}

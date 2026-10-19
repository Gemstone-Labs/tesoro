# Deployed addresses

All networks are testnets. Signatures for every deploy, upgrade and setup step are in [`deployments.md`](deployments.md).

## Solana devnet

Base-layer RPC: `https://rpc.magicblock.app/devnet` (the public `api.devnet.solana.com` rate-limits).

**Upgrade authority of all five programs and admin of `tesoro_core`, `sim_lst` and `tesoro_bridge`** (also the LayerZero OApp delegate): `7zr1j185zT8r6jcysC4LyrdSEJ13Up3xq4TFu6KQqh7M`. It replaced a compromised key on 2026-10-01; see [SECURITY.md](../SECURITY.md#key-compromise-2026-10-01).

| Program / account | Address |
|---|---|
| `tesoro_core` | [`AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh`](https://explorer.solana.com/address/AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh?cluster=devnet) |
| `tesoro_core` Config | `Che6m7vayXRFRn4Sti9FH4V4usE5bPEyPUvkiHP6hDgZ` |
| Platform and Studio Fee recipient (a Tesoro Account, authority `7zr1…qh7M`) | `GXQse6RG4hqY57fhRJX3W7yzhkwmaqZUHxaJArJWrMGK` |
| Oracle (trusted price and ETH issuance signer) | `6bpAyMvaHF5QdghrxnPRmdvHqCiLbigdXVroe4zDRApA` |
| `block_puzzle` | [`5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj`](https://explorer.solana.com/address/5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj?cluster=devnet) |
| `block_puzzle` Game authority PDA (registered in `tesoro_core`, Studio Fee 300 bps) | `7HTncQ9Gc2gamBqce5C7sz95SU6RnR9CoDt1D3o2U4nx` |
| `holdem` | [`CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE`](https://explorer.solana.com/address/CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE?cluster=devnet) |
| `holdem` Game authority PDA (registered in `tesoro_core`, Studio Fee 300 bps) | `Eu2RtadRsFCV9Xe2A7v7GivS9W5Trbrz6tCagNRUCwtn` |
| `holdem` delegation ProgramConfig (TEE validator whitelist) | `CVBjwJ8LaJS37zokHDjgkWASNPW9X5oWxmCHT2DvVKL3` |
| `trading_duel` | [`CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj`](https://explorer.solana.com/address/CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj?cluster=devnet) |
| `trading_duel` Game authority PDA (registered in `tesoro_core`, Studio Fee 300 bps) | `mPXSGjpEeSeJnmrBw3CKCoLbbftAsjsbiP1eE3wHcoe` |
| `trading_duel` delegation ProgramConfig (TEE validator whitelist) | `43amrCapYPLYz9tGPcdxw84A3Hby9j4kSTmDTCmu7xZb` |
| MagicBlock TEE validator (the only validator allowed to receive delegations) | `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |
| `sim_lst` (**Simulated** LST) | [`WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F`](https://explorer.solana.com/address/WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F?cluster=devnet) |
| `sim_lst` Pool PDA (7% APY, 4,380× speedup) | `Fc9UUnGEDapkBDM3mPayjqVDLYHokKCPwSLdbvKBUvPL` |
| simSOL mint PDA (9 decimals) | `3Q2VRPmdAZHutWNhE2Rof9Pdg6MnTMotXucmoD5cgAZJ` |
| `sim_lst` vault / reserve PDA | `2fQyEVMJNzGmaccxpbzhqMRFSpx9mf1kjsZRAMMRNKDm` |
| `tesoro_bridge` (LayerZero V2 OApp) | [`5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ`](https://explorer.solana.com/address/5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ?cluster=devnet) |
| OApp Store PDA (the EVM vaults' peer) | `7WQLHW8EuyV1V8tWNh8DQGu7mVRgaHGgLU7fi8G91rVw` = `0x60ae58df1215bf45cc054e633b49c92a3b1309f76075bac72b26e0c6e1c0c792` |
| Bridge authority PDA (`tesoro_core` source authority for Ethereum and HyperEVM) | `FEgxs5f7zavRaR7tZJBNZzrYeCMGegMpMWFiHjvyvaLg` |

## Ethereum Hoodi (chain 560048, LayerZero eid 40449)

Both vaults are owned by the EVM deployer `0x96137cB99Fe2878299b672Ac967e88279f479d1C` and peered to the Solana OApp Store above. They are not upgradeable. Earlier vaults are retired, and Positions on them were not migrated (`docs/deployments.md`).

| Contract | Address | Notes |
|---|---|---|
| `PositionVaultOApp`, SimLST (simETH, **Simulated**) | [`0xd545886F5CC70A6F9fa69D104e8f438e3a0F48Dc`](https://hoodi.etherscan.io/address/0xd545886F5CC70A6F9fa69D104e8f438e3a0F48Dc) | The vault the app uses. Redeployed 2026-10-19 for the on-demand Yield Report (ADR 0010). The 2026-10-12 vault `0x191700BA53C9437F3a31E082bcfd8bB85C865d26` is abandoned. |
| `PositionVaultOApp`, real Lido wstETH | [`0x61B46f64CDB75930a87955487aAb8A7711F757b5`](https://hoodi.etherscan.io/address/0x61B46f64CDB75930a87955487aAb8A7711F757b5) | Deployed and wired, not run end to end. Redeployed 2026-10-01. |
| SimLST (simETH, **Simulated**, 5% APY) | [`0xD82840623A7a00C37b0883d221Fa84e39ddA2a28`](https://hoodi.etherscan.io/address/0xD82840623A7a00C37b0883d221Fa84e39ddA2a28) | |
| `WstETHRateAdapter` | [`0x9C5fc1098a33Ec14a9c5a73c2cBa1CbcDD65AB37`](https://hoodi.etherscan.io/address/0x9C5fc1098a33Ec14a9c5a73c2cBa1CbcDD65AB37) | The wstETH vault's rate source. Reads wstETH `stEthPerToken()`. |
| LayerZero EndpointV2 (external) | `0x3aCAAf60502791D199a5a5F0B173D78229eBFe32` | |
| Lido stETH / wstETH (external) | `0x3508A952176b3c15387C97BE809eaffB1982176a` / `0x7E99eE3C66636DE415D2d7C880938F2f40f94De4` | |

## HyperEVM testnet (chain 998, eid 40362)

Owned by the same EVM deployer and peered to the same Solana OApp Store. Deployed 2026-10-02 (not upgradeable); wired on Solana at 500 bps. Transactions and the smoke test (every LayerZero message DELIVERED) are in `docs/deployments.md`; the flow is in `docs/cross-chain.md`.

| Contract | Address | Notes |
|---|---|---|
| `PositionVaultOApp`, SimLST (simHYPE, **Simulated**) | `0xfBc91D795d12Df73Cadc1fE217F587cC0484eD23` | The vault the app uses for HYPE Positions. Redeployed 2026-10-19 (ADR 0010); the 2026-10-12 vault `0x61B46f64CDB75930a87955487aAb8A7711F757b5` is abandoned. |
| SimLST (simHYPE, **Simulated**, 5% APY) | `0xC8A9AccD25ABDCF3FCBDE7123Cef8239B5bE7eF3` | Unbacked faucet, 1 month = 10 min. |
| LayerZero EndpointV2 (external) | `0xf9e1815f151024bde4b7c10bac10e8ba9f6b53e1` | Explorer: `https://testnet.purrsec.com`. |


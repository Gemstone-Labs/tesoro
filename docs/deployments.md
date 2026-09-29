# Deployments

Testnets only. SimLST is SIMULATED (accelerated yield clock, default 1 month per 10 minutes at 5% APY). `MockEndpoint` stands in for LayerZero until the OApp lands.

## Ethereum Hoodi (chain 560048, Tesoro chain tag / LayerZero eid 40449)

Deployed 2026-09-30 by the deployer in `~/.config/tesoro/evm-deployer.env` via `contracts/script/Deploy.s.sol`.

| Contract | Address | Deploy tx |
|---|---|---|
| SimLST (simETH) | `0x23B17A4c55867406E7CD5602c664E1447400c4a3` | `0x46c8c1f13414846312321303a52600ff153d2e6847d11e17384682200e1957dc` |
| MockEndpoint | `0xf6a7F770bCA297414d11BDF7F5e580a54DAa3F89` | `0xf085ffa3e0001372053457d18f4f17d39c1050019b353886e0ddfd9bc3baa28e` |
| PositionVault (SimLST) | `0x5b0bF0a1dFf3DbE665Ef45175Dd72AcF1a541db9` | `0xebfeaae8203201e527d70b39049d3d68616f0db4e282077742e9258f82d12e21` |
| SimLST reserve funding (0.05 ETH) | to SimLST | `0xc0cafd62c302ad2301ee6d7a08933d2816fde83187ecbb1157a3c1c0ef97c124` |
| WstETHRateAdapter | `0x9C5fc1098a33Ec14a9c5a73c2cBa1CbcDD65AB37` | `0xb3c25015f35fea38336ed26a75e5752da3fda2db43f82802b9787ec4581ce22f` |
| PositionVault (real wstETH) | `0xf3cfE452C3E4cc9A6cbC0A66D41671D2A2C9c647` | `0x6ee1a120b18b3090216289125c180b9c0554c5c972bee05dc424f63653795232` |

External (Lido on Hoodi): stETH `0x3508A952176b3c15387C97BE809eaffB1982176a`, wstETH `0x7E99eE3C66636DE415D2d7C880938F2f40f94De4`.

Verified on chain: `WstETHRateAdapter.underlyingPerShare()` returns wstETH `stEthPerToken()` = 1.032056972493021269e18.

## HyperEVM testnet (chain 998, eid 40362)

Not deployed: the deployer has no HYPE. The same script handles it (`--rpc-url https://rpc.hyperliquid-testnet.xyz/evm`): SimLST + MockEndpoint + PositionVault (SimLST only). Enable big blocks first (`{"type":"evmUserModify","usingBigBlocks":true}`) if any contract exceeds the 3M small-block gas limit.

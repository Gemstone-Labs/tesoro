# LayerZero V2 carries all cross-chain messages

Positions stay on their home chains while Gemas, Debt, Matches and Backings live on Solana, so four messages cross chains: issue Advance (source → Solana), report accrued yield (source → Solana, which drives automatic Debt repayment and redeemability), unlock (Solana → source), pay yield (Solana → source). Decided (2026-09-29): LayerZero V2 on Solana devnet, Ethereum Hoodi and HyperEVM testnet — the only transport verified to reach all three with managed relaying (Wormhole lacks Hoodi and an HyperEVM testnet executor; CCIP reaches Ethereum only via Sepolia and forces out-of-order delivery on Solana lanes). See `docs/cross-chain-research-2026-09-29.md`.

## Consequences

The Solana↔HyperEVM pathway is wired and proven first, since no live traffic was observed on it. If it is not carrying messages by build day 4, HyperEVM alone falls back to Wormhole with self-relay. Every payload carries a sequence number and Position id and every handler is idempotent, so a transport swap never changes program logic. A trusted Tesoro relayer was rejected in favour of real infrastructure.

# Games run as on-chain programs in MagicBlock Private Ephemeral Rollups

A Match's result must reach the Solana settlement program. Rather than trusting a Studio server's signature, each Game is a Solana program whose Match state is delegated to a MagicBlock Private Ephemeral Rollup (Intel TDX TEE): hidden state (hole cards, the deck, an async Player's moves until both finish) is readable only by permitted members, and Tesoro settles a Pot only from a registered Game program. Decided 2026-09-29: no game servers, a stronger trust boundary, and a Studio integrates by shipping a program, not a service.

## Consequences

Day 1–2 spike must prove (1) a deck neither Player can read, shuffled with randomness nobody can predict (a public VRF value would expose it), and (2) a private-rollup Match that settles its Pot on base-layer Solana alongside LayerZero accounts. If either fails by end of day 2, Hold'em falls back to a server signing results under a registered Game key; the puzzle stays on-chain. Turn clocks and no-shows rely on on-chain cranks.

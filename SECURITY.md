# Security

Tesoro runs on testnets only (Solana devnet, Ethereum Hoodi, HyperEVM testnet). Nothing in it holds real value.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue. We aim to reply within a few days.

## Reviews

Two internal reviews. **No external audit.**

**Security review (2026-09-30).** On-chain code: `tesoro_core`, the Game programs, `sim_lst`, `tesoro_bridge` and the EVM contracts. 14 findings (Critical 1, High 3, Medium 3, Low 6, Info 1), each with a failing proof test first.

| Status | Findings |
|---|---|
| Fixed and deployed | F-01 (Critical: delegation not pinned to the TEE validator, so a Player could commit a forged result), F-02 (High: spoofable privacy permission), F-03 (High: a Hold'em Match could be refunded mid-play after 1 h), F-04 (High: out-of-order LayerZero delivery could strand Principal; the vaults were redeployed), F-05 (top-up to a vault repaid Debt), F-06, F-07, F-09 (except `match_id` squatting), F-12 |
| Mitigated | F-13 (an oversized PayYield reverts and is retried once yield catches up) |
| Accepted for devnet | F-08 and F-11 (simulated faucets), F-10 (first-caller Config init; already initialised), F-14 (informational) |

**Implementation review (2026-09-30 to 2026-10-01).** App, keeper, server routes, contracts and programs: 29 findings (P1 2, P2 14, P3 13). Both P1s (an EVM vault yield underpayment and a faucet quota bypass) are fixed and the vaults redeployed.

## Known risks

- The oracle key and price feed are trusted. A wrong price mints the wrong number of Gemas.
- Privacy depends on MagicBlock's TEE attestation. Cross-chain messages depend on the LayerZero DVN set.
- One admin key holds every admin power and can upgrade every program.
  The mainnet plan (2-of-3 Squads multisig, separate hot keys): [`docs/mainnet-keys.md`](docs/mainnet-keys.md).

## Key compromise (2026-10-01)

The original devnet deployer key `AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV` sent its whole balance (24.63 devnet SOL) to an unknown address. It held testnet funds only. The same day, upgrade authority, every admin role (via a new `set_admin` instruction), the LayerZero delegate and the fee recipient moved to `7zr1j185zT8r6jcysC4LyrdSEJ13Up3xq4TFu6KQqh7M`; web routes moved to separate low-balance relayer keys, and a pre-commit secret scanner was added. Signatures: [`docs/deployments.md`](docs/deployments.md#key-compromise-response-2026-10-01).

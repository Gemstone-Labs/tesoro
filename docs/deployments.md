# Deployments

## Solana devnet

### sim_lst (SIMULATED liquid staking token — "Simulated yield · 1 month = 10 min")

| Item | Address |
|---|---|
| Program | `WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F` |
| Pool PDA (`["pool"]`) | `Fc9UUnGEDapkBDM3mPayjqVDLYHokKCPwSLdbvKBUvPL` |
| simSOL mint PDA (`["mint"]`, 9 decimals, authority = pool) | `3Q2VRPmdAZHutWNhE2Rof9Pdg6MnTMotXucmoD5cgAZJ` |
| Vault / reserve PDA (`["vault"]`, system-owned SOL) | `2fQyEVMJNzGmaccxpbzhqMRFSpx9mf1kjsZRAMMRNKDm` |
| Admin / deployer | `AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV` |

Config: APY 7% (700 bps), speedup 4,320 (1 month of yield per 10 minutes), faucet 10 simSOL per user per hour.

Rate (SOL per simSOL, 1e9 fixed point): `base_rate + base_rate * apy_bps * ((now - base_ts) * speedup) / (10_000 * 31_536_000)`.
Linear between checkpoints; `set_params` rebases first, so changes compound. Read it from the `Pool` account
(`base_rate`, `base_ts`, `apy_bps`, `speedup`) or via the `get_rate` instruction return data. Yield is paid from the
admin-funded reserve; withdrawals beyond the vault balance are refused. The faucet mints unbacked simSOL.

Helpers: `scripts/sim-lst` (`pnpm rate`, `pnpm faucet`, `pnpm tsx src/cli.ts init | fund <sol>`).

Deploy status: see the bottom of this file.

# Extend is limited per Player: once a day, and a monthly cap the Player sets

Proposed (agent, Oct 14, 2026; the founder can change the numbers before the program is deployed). Extend (ADR 0008) lets a Player who lost the Gemas of an Advance commit more of the Position's future yield at once. Nothing slowed that down: a Player on a losing streak could Extend again minutes later, up to 12 months. The guardrails are enforced by `tesoro_core`, so a direct transaction cannot skip them.

## How it is built

- An `ExtendLimit` account per Player Account, seeds `["extend_limit", account]`, paid by the owner. It holds the limit in force, a pending raise (months and the time it applies), the start and months of the current period, and the time of the last Extend. Its rules are pure ledger code (`ledger/extend_limit.rs`).
- **Wait:** an Extend is refused (`ExtendCoolingDown`) within 24 hours of the Player's last Extend, across all their Positions. Exactly 24 hours later it is allowed.
- **Limit:** the months Extend adds in a 30-day period, across all Positions, may not exceed the Player's Extend Limit (`ExtendLimitReached`). The default is 3 months. The period starts at the first Extend after the previous period ended, and ends 30 days later to the second.
- **Setting it:** `set_extend_limit(months)`, 0 to 11 (`InvalidExtendLimit` above). Lowering applies at once and drops a pending raise. Raising is pending for 24 hours. Setting a value no higher than the one in force cancels a pending raise.
- `extend_native_advance` takes the `ExtendLimit` account (created at the default when missing, the owner pays the rent) and the system program, and counts the Extend before it mints. This changes its account list, which is safe because Extend is not deployed yet.
- New errors are appended at the end of the ledger errors; event `ExtendLimitSet`.
- **Wall-clock time:** all of it uses the cluster clock (`Clock::unix_timestamp`), not the simulated yield clock that makes a devnet month last 10 minutes. A day is a real day.

## Considered Options

- **A fixed protocol limit, no Player setting:** rejected. The Player deciding in a calm moment is the point; the default covers those who never set it.
- **Raising takes effect at once:** rejected. A Player could raise it in the heat of a losing streak.
- **Counting per Position:** rejected. Opening another Position would get around it.
- **A rolling 30-day window:** rejected for a fixed period from the first Extend: one counter and one date to show ("resets on ..."), no per-Extend history to store.

## Consequences

- The deploy that turns on Extend (ADR 0008) also carries this; the app shows the limit view behind `NEXT_PUBLIC_EXTEND_ADVANCE`.
- The defaults (24 h, 3 months, 30 days, raise delay 24 h, maximum 11) are constants in `ledger/extend_limit.rs`.
- A Player who never sets a limit pays the small rent of the `ExtendLimit` account with their first Extend.

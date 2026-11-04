# 0015: The keeper does only what no Player transaction can carry

Status: accepted (founder, 2026-11-02), keeper-diet ticket 20. Narrows ADR 0003's line that the keeper cranks Tables and Matches.

## Context

The keeper ran 22 jobs in one 20-second loop plus a 1-second fast lane. Most passes found nothing to do, and each pass cost RPC credits. At the Helius Developer plan (10M credits a month) the zero-Player loop on mainnet would have spent about 25M a month before a single Match.

## Decision

1. **Keeper rule.** A step belongs in the keeper only if no Player transaction can carry it. A step a Player can carry goes into that Player's next transaction (join and Table assignment, finalize, `match_chunk`, `close_match`, `begin_match` that cleans its Table, the Lock that lands on Solana, Sponsor release, Hold'em timeout). A step nobody can carry runs on a schedule, and does one pass and exits.
2. **What the keeper is.** Four scheduled runs plus a heartbeat, each a systemd timer under `keeper/deploy/`:
   - Season run (Monday, Wednesday, hourly retry): settle, redeem, harvest, batches, pools, record, pay;
   - safety sweep (every 5 minutes): finishes a Match a Player left after 10 minutes, refunds a Backer-funded Match nobody joined;
   - janitor (daily): closes spent tickets, receipts, pair records and Assignments, refreshes Listings;
   - table-pool repair (every 15 minutes): republishes each Table's live epoch to `table_pool`;
   - the delayed-notification cron (every 5 minutes) calls the app's `/api/cron/notify`.
   Admin work (Table, Sponsor and Fuel creation, fee cash-in, Instant Redeem fills, Sponsor refills, fee batches) is `admin-cli`, run by hand.
3. **Devnet extras.** The one process left that loops is the devnet price writer (`src/index.ts`): Advances need a price, and test mode has no Pyth feed. It exits at once on mainnet.
4. **The Table operator is not the keeper key.** `KEEPER_OPERATOR_KEYPAIR` signs the Games' operator-only instructions (Tables, Sponsor, Fuel, assignment). The app's sponsor server holds the same operator key to assign a Table in the join transaction, so the keeper key never goes to Vercel.
5. **Cheap scans only.** Every keeper RPC call goes through one metered connection that counts calls by method and converts them to Helius credits (`getProgramAccounts` 10, anything else 1). The connection refuses a plain `getProgramAccounts` on mainnet; a scan must use `getProgramAccountsV2` with a `dataSlice` and a filter. A new chain scan therefore has to be written to the budget.
6. **Budget.** Zero Players: under 300,000 credits a month for the keeper, the webhook and its catch-up together. 1,000 Matches a day: under 1,000,000. Each run logs its credits.

## Consequences

- Code a removed job used stays where a Player flow, a script or a run calls it; only code with no caller was deleted.
- A first Match for a Source with no checkpoint pages is finished by the safety sweep (10 minutes), not by the page: the page stops on `needs-page` and does not create them. Later Matches of that Source are finished by the page.
- An Active Match whose Table never began is no longer refunded by a loop. The page of a Player who is present can cancel it; the sweep does not yet refund it (open item).
- Helius webhook delivery replaces the keeper's history scan; the webhook catch-up (every 15 minutes) needs a caller (open item, see keeper README).

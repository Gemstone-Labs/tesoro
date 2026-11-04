/**
 * Preloaded by `pnpm test` (node --import): the tests start from an empty keeper environment. A shell that had sourced
 * ~/.config/tesoro-keeper.env (KEEPER_SECRET_KEY, KEEPER_WEBHOOK_HISTORY, Supabase and notify settings) made three tests fail.
 */
for (const name of Object.keys(process.env)) {
  if (/^(KEEPER_|SWEEP_|SEASON_|JANITOR_|POOL_|NOTIFY_|CRON_|SUPABASE_|HELIUS_|TESORO_)/.test(name)) delete process.env[name];
}

-- The relayer's sponsor limits and exit reserve (ticket 18). Counters live in Postgres so every server instance sees the
-- same limits. Server (service role) only.
create table public.sponsor_usage (
  key text primary key,
  window_start timestamptz not null,
  used bigint not null default 0
);

create table public.sponsor_hold (
  key text primary key,
  lamports bigint not null check (lamports >= 0),
  created_at timestamptz not null default now()
);

alter table public.sponsor_usage enable row level security;
alter table public.sponsor_hold enable row level security;
revoke all on public.sponsor_usage, public.sponsor_hold from anon, authenticated;

-- Adds p_cost to the window of p_key when it stays within p_max (p_max null: always; a negative cost gives back, never below 0).
-- p_window_ms null keeps the current window (refunds). Returns the new total, or -1 when refused.
create function public.sponsor_take(p_key text, p_cost bigint, p_max bigint, p_window_ms bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  row public.sponsor_usage;
  window_len interval := make_interval(secs => coalesce(p_window_ms, 0) / 1000.0);
begin
  insert into public.sponsor_usage (key, window_start, used) values (p_key, now(), 0)
    on conflict (key) do nothing;
  select * into row from public.sponsor_usage where key = p_key for update;
  if p_window_ms is not null and row.window_start + window_len <= now() then
    row.window_start := now();
    row.used := 0;
  end if;
  if p_max is not null and row.used + p_cost > p_max then
    return -1;
  end if;
  update public.sponsor_usage set window_start = row.window_start, used = greatest(0, row.used + p_cost) where key = p_key;
  return greatest(0, row.used + p_cost);
end $$;

revoke all on function public.sponsor_take(text, bigint, bigint, bigint) from public, anon, authenticated;

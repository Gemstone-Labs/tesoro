-- 18+ confirmation at a Player's first Match entry (ticket 29). One row per Account (authority), asked once.
-- Server (service role) only.
create table public.age_confirmations (
  authority text primary key,
  confirmed_at timestamptz not null default now()
);

alter table public.age_confirmations enable row level security;
revoke all on public.age_confirmations from anon, authenticated;

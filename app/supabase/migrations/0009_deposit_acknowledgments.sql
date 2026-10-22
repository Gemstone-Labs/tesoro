-- What a Player confirmed before their first deposit (beginner packs). One row per Account and wording version;
-- a new version asks again. Server (service role) only.
create table public.deposit_acknowledgments (
  authority text not null,
  version text not null,
  acknowledged_at timestamptz not null default now(),
  primary key (authority, version)
);

alter table public.deposit_acknowledgments enable row level security;
revoke all on public.deposit_acknowledgments from anon, authenticated;

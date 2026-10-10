create extension if not exists citext;

create table public.waitlist (
  id bigint generated always as identity primary key,
  email citext not null unique,
  created_at timestamptz not null default now(),
  source text,
  referrer text
);

-- Only the server (service role) touches this table: RLS on, no policies.
alter table public.waitlist enable row level security;

revoke all on public.waitlist from anon, authenticated;

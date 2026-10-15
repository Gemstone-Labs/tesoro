-- Invite codes (ADR 0011). Only the SHA-256 of a code is stored. The email becomes the Account's verified
-- notification email when the code is redeemed. Server (service role) only.
create extension if not exists citext;

create table public.invites (
  code_hash text primary key,
  email citext not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  used_by_authority text
);

create index invites_used_by_idx on public.invites (used_by_authority);

alter table public.invites enable row level security;
revoke all on public.invites from anon, authenticated;

-- Private email notifications. Emails never go on chain; keyed by the Player's authority (wallet address).
create extension if not exists citext;

create table public.notify_settings (
  authority text primary key,
  email citext not null,
  verified boolean not null default false,
  enabled boolean not null default true,
  verify_token text unique,
  verify_sent_at timestamptz,
  -- UTC day (YYYY-MM-DD) the counter below belongs to, the emails sent that day and the events held for a digest.
  sent_day text,
  sent_today integer not null default 0,
  digest jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per notified event: the primary key is what makes each event send at most once.
create table public.notify_events (
  event_id text primary key,
  authority text not null,
  created_at timestamptz not null default now()
);

-- Only the server (service role) touches these tables: RLS on, no policies.
alter table public.notify_settings enable row level security;
alter table public.notify_events enable row level security;

revoke all on public.notify_settings from anon, authenticated;
revoke all on public.notify_events from anon, authenticated;

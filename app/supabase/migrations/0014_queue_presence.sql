-- Block Burst Queue presence: the opener of an open Queue Match touches its row every 15 s while the page is open.
-- Lists and counts skip Matches whose row is older than 30 s. Server (service role) only.
create table public.queue_presence (
  match_key text primary key,
  seen_at timestamptz not null default now()
);

alter table public.queue_presence enable row level security;
revoke all on public.queue_presence from anon, authenticated;

-- When the Invite email went out (ticket 30). Null until sent.
alter table public.invites add column sent_at timestamptz;

-- What a waitlist member says they are (player, staker, studio), optional, several allowed.
alter table public.waitlist
  add column roles text[] not null default '{}',
  add column studio text;

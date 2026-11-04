-- Final boards captured from the Helius webhook (keeper diet ticket 23). Apply by hand, after 0013 and 0023.
-- A Match whose board could not be kept (base's Table already belongs to a later Match, or the read failed for good) gets a
-- marker instead of a guess. The marker never blocks a board: a later capture replaces it, and record_end_state clears it.
create table public.match_end_missing (
  match_address text primary key,
  game text not null,
  reason text not null,
  checked_at timestamptz not null default now()
);

alter table public.match_end_missing enable row level security;
revoke all on public.match_end_missing from anon, authenticated;

-- p = { match_address, game, reason }. False when a board is already stored (the marker is not written).
create function public.record_end_missing(p jsonb) returns boolean
language plpgsql as $$
begin
  if exists (select 1 from public.match_end_states where match_address = p->>'match_address') then
    return false;
  end if;
  insert into public.match_end_missing (match_address, game, reason)
  values (p->>'match_address', p->>'game', p->>'reason')
  on conflict (match_address) do update set reason = excluded.reason, checked_at = now();
  return true;
end $$;

-- { game, reason, checked_at } or null.
create function public.end_missing_of(p_match text) returns jsonb
language sql stable as $$
  select jsonb_build_object('game', m.game, 'reason', m.reason, 'checked_at', m.checked_at)
  from public.match_end_missing m where m.match_address = p_match
$$;

create or replace function public.record_end_state(p jsonb) returns boolean
language plpgsql as $$
begin
  insert into public.match_end_states (match_address, game, epoch, state)
  values (p->>'match_address', p->>'game', (p->>'epoch')::bigint, p->'state')
  on conflict (match_address) do nothing;
  if found then
    delete from public.match_end_missing where match_address = p->>'match_address';
    return true;
  end if;
  return false;
end $$;

revoke all on function public.record_end_missing(jsonb), public.end_missing_of(text) from public, anon, authenticated;

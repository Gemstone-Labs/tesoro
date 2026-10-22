-- The public end state of a finished table Match (ticket 33 of the economy upgrade).
-- A persistent table is reused: the next Match's commit replaces the final board on base, and the table's reset wipes it in
-- the rollup. The keeper copies the PUBLIC end state here after the Match's commit and before the table's reset
-- (the reset waits for this write). Hidden seat data never goes in.
--
-- Keyed by the tesoro_core Match address, which is what a result screen has in hand. Write-once: the first capture wins.
-- Only the server (service role) touches this table and these functions: RLS on, no policies, no grants.

create table public.match_end_states (
  match_address text primary key,
  game text not null,
  -- The table epoch the Match ran in, so a repeat from a later epoch cannot be mistaken for it.
  epoch bigint not null,
  state jsonb not null,
  captured_at timestamptz not null default now()
);

alter table public.match_end_states enable row level security;
revoke all on public.match_end_states from anon, authenticated;

-- p = { match_address, game, epoch, state }. Returns true when this call stored it (false: already captured).
create function public.record_end_state(p jsonb) returns boolean
language plpgsql as $$
begin
  insert into public.match_end_states (match_address, game, epoch, state)
  values (p->>'match_address', p->>'game', (p->>'epoch')::bigint, p->'state')
  on conflict (match_address) do nothing;
  return found;
end $$;

-- The stored end state of a Match, { game, epoch, state }, or null when none was captured.
create function public.end_state_of(p_match text) returns jsonb
language sql stable as $$
  select jsonb_build_object('game', e.game, 'epoch', e.epoch, 'state', e.state)
  from public.match_end_states e where e.match_address = p_match
$$;

revoke all on function public.record_end_state(jsonb), public.end_state_of(text) from public, anon, authenticated;

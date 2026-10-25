-- Core MatchChunkDone.chunk_no is 1-based. Preserve the append-only records and all financial fields.
-- REQUIRED: quiesce history writers/backfills and drain in-flight RPCs before this transaction.
-- Execute this whole migration in one transaction (for example psql --single-transaction -f ...).
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table public.match_events, public.match_history in share row exclusive mode;

-- Do not silently reinterpret malformed or mixed counter conventions.
do $$ begin
  if exists (
    select 1 from public.match_events
    where type = 'chunk' and (chunk_no is null or chunk_no < 1 or (payload->>'chunk_no') is null or chunk_no <> (payload->>'chunk_no')::integer)
       or type = 'settled' and ((payload->>'chunks') is null or (payload->>'chunks')::integer < 0)
  ) then raise exception 'Invalid Match chunk counters; inspect retained evidence before repair'; end if;
  if exists (
    select opener, n from public.match_events where type = 'settled'
    group by opener, n having min((payload->>'chunks')::integer) <> max((payload->>'chunks')::integer)
  ) then raise exception 'Conflicting final Match chunk counters; inspect retained evidence'; end if;
  if exists (
    select 1 from public.match_events c join public.match_events e using (opener, n)
    where c.type = 'chunk' and e.type = 'settled' and c.chunk_no > (e.payload->>'chunks')::integer
  ) then raise exception 'Chunk exceeds final counter; inspect retained evidence'; end if;
end $$;
create or replace function public.ingest_match_event(p jsonb) returns boolean
language plpgsql as $$
declare
  t text := p->>'type';
  o text := p->>'opener';
  k bigint := (p->>'n')::bigint;
  party jsonb;
begin
  if t not in ('start', 'won', 'chunk', 'settled') then
    raise exception 'unknown match record type %', t;
  end if;
  insert into public.match_events (event_id, opener, n, type, chunk_no, signature, slot, payload)
  values (p->>'event_id', o, k, t, (p->>'chunk_no')::integer, p->>'signature', (p->>'slot')::bigint, p)
  on conflict (event_id) do nothing;
  if not found then
    return false;
  end if;

  insert into public.match_history (opener, n) values (o, k) on conflict do nothing;

  if t = 'start' then
    update public.match_history set
      game = p->>'game',
      entry = (p->>'entry')::bigint,
      challenge = (p->>'challenge')::boolean,
      asset = (p->>'asset')::smallint,
      opened_at = public.mh_ts((p->>'opened_at')::bigint),
      kind = (p->>'kind')::smallint,
      winner_side = (p->>'winner_side')::smallint,
      a_player = p->>'a_player',
      a_funder = p->>'a_funder',
      b_player = p->>'b_player',
      b_funder = p->>'b_funder',
      platform_fee = (p->'fees'->>0)::bigint,
      studio_fee = (p->'fees'->>1)::bigint,
      leaderboard_fee = (p->'fees'->>2)::bigint,
      started_at = public.mh_ts((p->>'ts')::bigint),
      scores = coalesce(p->'scores', scores),
      status = case
        when status in ('settled', 'refunded') then status
        when (p->>'kind')::smallint in (0, 2) then 'settling'
        else 'refunding'
      end
    where opener = o and n = k;
    delete from public.match_parties where opener = o and n = k;
    for party in select * from jsonb_array_elements(coalesce(p->'parties', '[]'::jsonb)) loop
      insert into public.match_parties (opener, n, account, role, side, result, delta, backing_other, share_bps)
      values (o, k, party->>'account', party->>'role', (party->>'side')::smallint, party->>'result',
              (party->>'delta')::bigint, party->>'backing_other', (party->>'share_bps')::integer);
    end loop;
  elsif t = 'won' then
    update public.match_history set
      game = coalesce(game, p->>'game'),
      entry = coalesce(entry, (p->>'entry')::bigint),
      challenge = coalesce(challenge, (p->>'challenge')::boolean),
      asset = coalesce(asset, (p->>'asset')::smallint),
      opened_at = coalesce(opened_at, public.mh_ts((p->>'opened_at')::bigint)),
      winner = p->>'winner',
      loser = p->>'loser',
      points = (p->>'points')::bigint,
      pool_fee = (p->>'pool_fee')::bigint,
      season = (p->>'season')::integer,
      won_at = public.mh_ts((p->>'ts')::bigint)
    where opener = o and n = k;
  elsif t = 'chunk' then
    update public.match_history set chunks = greatest(chunks, (p->>'chunk_no')::integer)
    where opener = o and n = k;
  else
    update public.match_history set
      chunks = greatest(chunks, (p->>'chunks')::integer),
      settled_at = public.mh_ts((p->>'ts')::bigint),
      kind = coalesce(kind, (p->>'kind')::smallint),
      status = case when (p->>'kind')::smallint in (0, 2) then 'settled' else 'refunded' end
    where opener = o and n = k;
  end if;
  return true;
end $$;

-- Rebuild only the derived count from the authenticated records already retained by the writer.
update public.match_history h set chunks = r.chunks
from (
  select opener, n, greatest(
    coalesce(max(chunk_no) filter (where type = 'chunk'), 0),
    coalesce(max((payload->>'chunks')::integer) filter (where type = 'settled'), 0)
  ) as chunks
  from public.match_events
  where type in ('chunk', 'settled')
  group by opener, n
) r
where h.opener = r.opener and h.n = r.n and h.chunks <> r.chunks;

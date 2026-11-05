-- Railcar rides in the Match history (Railcar ticket 12). A ride is a many-seat Match: one party row per seat (Player, and
-- the Backer who funded a backed seat), `side` is the core seat index (0-99). The ride itself (the draw, every Brake, every
-- seat's Jump and refund, core's places and fees) is kept whole in `match_history.ride` so anyone can replay it; each
-- party row carries its own part of it in `match_parties.ride` ({ kind, place?, jumpMs? }).
-- Head-to-head Matches are unchanged: their `ride` columns stay null and their rows read exactly as before.

alter table public.match_history add column ride jsonb;
alter table public.match_parties add column ride jsonb;
alter table public.match_parties drop constraint match_parties_side_check;
alter table public.match_parties add constraint match_parties_side_check check (side between 0 and 99);

-- 0015's function, plus `ride` on the start record and on each party.
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
      ride = coalesce(p->'ride', ride),
      status = case
        when status in ('settled', 'refunded') then status
        when (p->>'kind')::smallint in (0, 2) then 'settling'
        else 'refunding'
      end
    where opener = o and n = k;
    delete from public.match_parties where opener = o and n = k;
    for party in select * from jsonb_array_elements(coalesce(p->'parties', '[]'::jsonb)) loop
      insert into public.match_parties (opener, n, account, role, side, result, delta, backing_other, share_bps, ride)
      values (o, k, party->>'account', party->>'role', (party->>'side')::smallint, party->>'result',
              (party->>'delta')::bigint, party->>'backing_other', (party->>'share_bps')::integer, party->'ride');
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

-- 0010's row, plus `ride` ({ seated, kind, place?, jumpMs? }) on a ride's rows only.
create or replace function public.mh_row(m public.match_history, pt public.match_parties) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', m.match_key,
    'game', m.game,
    'entry', m.entry,
    'role', pt.role,
    'result', pt.result,
    'delta', pt.delta,
    'backing', case when pt.backing_other is null then null
      else jsonb_build_object('other', pt.backing_other, 'shareBps', coalesce(pt.share_bps, 0)) end,
    'scores', case when m.scores is null then null
      when pt.side = 0 then m.scores else jsonb_build_array(m.scores->1, m.scores->0) end,
    'opp', case when m.ride is not null then null when pt.side = 0 then m.b_player else m.a_player end,
    'at', (extract(epoch from m.opened_at) * 1000)::bigint,
    'asset', case when m.game = 'trading-duel' then m.asset else null end,
    'backerDelta', case when pt.role = 'player' and pt.backing_other is not null then
      (select b.delta from public.match_parties b where b.opener = pt.opener and b.n = pt.n and b.role = 'backer' and b.side = pt.side limit 1) else null end
  ) || case when m.ride is null then '{}'::jsonb
    else jsonb_build_object('ride', jsonb_build_object('seated', jsonb_array_length(m.ride->'seats')) || coalesce(pt.ride, '{}'::jsonb)) end
$$;

-- 0010's Match page, plus the whole ride for a ride.
create or replace function public.match_record(p_opener text, p_n bigint) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', m.match_key, 'game', m.game, 'entry', m.entry, 'status', m.status, 'kind', m.kind,
    'challenge', m.challenge, 'asset', m.asset, 'openedAt', (extract(epoch from m.opened_at) * 1000)::bigint,
    'settledAt', (extract(epoch from m.settled_at) * 1000)::bigint,
    'sides', jsonb_build_array(
      jsonb_build_object('player', m.a_player, 'funder', m.a_funder),
      case when m.b_player is null then null else jsonb_build_object('player', m.b_player, 'funder', m.b_funder) end),
    'winnerSide', m.winner_side, 'winner', m.winner, 'loser', m.loser, 'points', m.points, 'season', m.season,
    'fees', jsonb_build_object('platform', m.platform_fee, 'studio', m.studio_fee, 'leaderboard', m.leaderboard_fee),
    'chunks', m.chunks, 'scores', m.scores,
    'parties', coalesce((select jsonb_agg(jsonb_build_object('account', pt.account, 'role', pt.role, 'side', pt.side,
      'result', pt.result, 'delta', pt.delta, 'backingOther', pt.backing_other, 'shareBps', pt.share_bps)
      order by pt.side, pt.role) from public.match_parties pt where pt.opener = m.opener and pt.n = m.n), '[]'::jsonb)
  ) || case when m.ride is null then '{}'::jsonb else jsonb_build_object('ride', m.ride) end
  from public.match_history m where m.opener = p_opener and m.n = p_n and m.game is not null
$$;

-- 0010's card; a ride's card is its last Player off (first place), and carries the ride.
create or replace function public.win_card(p_opener text, p_n bigint) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', m.match_key, 'game', m.game, 'entry', m.entry, 'winner', pt.account, 'gemas', greatest(pt.delta, 0))
    || case when m.ride is null then '{}'::jsonb else jsonb_build_object('ride', m.ride) end
  from public.match_history m
  join public.match_parties pt on pt.opener = m.opener and pt.n = m.n and pt.role = 'player' and pt.result = 'won'
    and (m.ride is null or pt.side = (m.ride->'places'->0->>'seat')::smallint)
  where m.opener = p_opener and m.n = p_n and m.status = 'settled' and m.kind = 0
$$;

-- 0010's ticker; a ride pays its winner their entry and first place's winnings.
create or replace function public.recent_wins(p_game text, p_since bigint, p_limit integer) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(w order by oa desc, n desc), '[]'::jsonb) from (
    select m.opened_at as oa, m.n, jsonb_build_object(
      'id', m.match_key, 'game', m.game, 'entry', m.entry, 'winner', m.winner,
      'payout', case when m.ride is not null then m.entry + coalesce((m.ride->'places'->0->>'won')::bigint, 0)
        else m.entry * 2 - coalesce(m.platform_fee, 0) - coalesce(m.studio_fee, 0) - coalesce(m.leaderboard_fee, 0) end,
      'scores', case when m.scores is null then null when m.winner_side = 0 then m.scores
        else jsonb_build_array(m.scores->1, m.scores->0) end,
      'at', (extract(epoch from m.opened_at) * 1000)::bigint) as w
    from public.match_history m
    where m.status = 'settled' and m.kind = 0 and m.winner is not null
      and (p_game is null or m.game = p_game)
      and (p_since is null or m.opened_at >= to_timestamp(p_since / 1000.0))
    order by m.opened_at desc, m.n desc
    limit p_limit
  ) s
$$;

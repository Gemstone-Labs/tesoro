-- Railcar rides in the Match history (Railcar ticket 12; design .scratch/railcar/12-history-decision.md).
--
-- A ride is a many-seat Match. Its history arrives in pieces, in separate transactions and in any order, each keyed by
-- the core Match id (opener, n) and stored once in match_events:
--   start  core's ManySeatRunStarted (+ ManySeatPlaced, MatchWon's open time): the run kind, fees and the paid places;
--   ride   Railcar's RideRevealed (reveal_ride, before finalize): the draw, every Brake, every seat with its Player,
--          Backer, Offer share, Jump and refund;
--   chunk  core's ManySeatChunkDone: for a refund run, which Account each seat's entry went home to.
-- Each piece is folded into match_history; mh_rebuild_seats then rebuilds the parties from whatever is there, under the
-- match row's lock, so the last piece to land always sees the others. One party row per seat (Player, and the Backer
-- of a backed seat); `side` is the core seat index (0-99). Head-to-head Matches are unchanged.
-- A third role, `funder`: the Account that paid a seat's entry when nothing says whether it rode or backed the seat (a
-- car core refunded before anyone revealed its ride). Its row claims no ride, so nothing counts it as a Match played.

alter table public.match_history add column many_seat boolean not null default false;
alter table public.match_history add column ride jsonb;
alter table public.match_history add column places jsonb;
alter table public.match_parties add column ride jsonb;
alter table public.match_parties drop constraint match_parties_role_check;
alter table public.match_parties add constraint match_parties_role_check check (role in ('player', 'backer', 'funder'));
alter table public.match_parties drop constraint match_parties_side_check;
alter table public.match_parties add constraint match_parties_side_check check (side between 0 and 99);
alter table public.match_events drop constraint match_events_type_check;
alter table public.match_events add constraint match_events_type_check check (type in ('start', 'won', 'chunk', 'settled', 'ride'));

-- The parties of a many-seat Match from its pieces:
--   refund run (kind 4, 5, 6): every seat Refunded, delta 0. With the ride, each Player and each Backer; without it,
--     whoever core's refund lines paid each seat's entry back to, as its `funder` (the Player, or the Backer of a backed
--     seat: core's lines do not say which, and no event names a backed seat's Player, who then has no row).
--   win (kind 0), once the ride is in: a place gets its entry back and its winnings (a backed place: the Player keeps
--     floor(won x share), the Backer the rest); an early Jump gets its refund back (backed: the Player 0, the Backer
--     refund - entry); aboard at Impact loses the entry (backed: the Player 0, the Backer -entry).
create function public.mh_rebuild_seats(o text, k bigint) returns void
language plpgsql as $$
declare
  m public.match_history;
  s jsonb;
  pl jsonb;
  backed boolean;
  backer text;
  share integer;
  kind text;
  result text;
  gain bigint;
  mine bigint;
  role jsonb;
begin
  select * into m from public.match_history where opener = o and n = k for update;
  if not found or not m.many_seat then
    return;
  end if;
  delete from public.match_parties where opener = o and n = k;
  if m.kind is null then
    return;
  end if;
  if m.kind in (4, 5, 6) then
    if m.ride is not null then
      for s in select * from jsonb_array_elements(m.ride->'seats') loop
        backed := s->>'funder' <> s->>'player';
        insert into public.match_parties (opener, n, account, role, side, result, delta, backing_other, share_bps, ride)
        values (o, k, s->>'player', 'player', (s->>'seat')::smallint, 'refunded', 0,
                case when backed then s->>'funder' end, case when backed then (s->>'shareBps')::integer end, '{"kind":"refund"}');
        if backed then
          insert into public.match_parties (opener, n, account, role, side, result, delta, backing_other, share_bps, ride)
          values (o, k, s->>'funder', 'backer', (s->>'seat')::smallint, 'refunded', 0, s->>'player', (s->>'shareBps')::integer, '{"kind":"refund"}');
        end if;
      end loop;
    else
      insert into public.match_parties (opener, n, account, role, side, result, delta, backing_other, share_bps, ride)
      select distinct on (seat) o, k, recipient, 'funder', seat, 'refunded', 0, null, null, '{"kind":"refund"}'::jsonb
      from (
        select (l->>'seat')::smallint as seat, l->>'recipient' as recipient
        from public.match_events e, jsonb_array_elements(coalesce(e.payload->'seat_lines', '[]'::jsonb)) l
        where e.opener = o and e.n = k and e.type = 'chunk' and (l->>'purpose')::integer in (3, 5)
      ) lines
      order by seat
      on conflict do nothing;
    end if;
    return;
  end if;
  if m.kind <> 0 or m.ride is null or m.places is null then
    return;
  end if;
  for s in select * from jsonb_array_elements(m.ride->'seats') loop
    backed := s->>'funder' <> s->>'player';
    backer := case when backed then s->>'funder' end;
    share := case when backed then (s->>'shareBps')::integer end;
    pl := (select x.value from jsonb_array_elements(m.places) x where (x.value->>'seat')::integer = (s->>'seat')::integer limit 1);
    if pl is not null then
      gain := (pl->>'won')::bigint;
      mine := case when backed then gain * share / 10000 else gain end;
      result := 'won';
      role := jsonb_build_object('kind', 'place', 'place', (pl->>'place')::integer, 'jumpMs', (s->>'jumpMs')::integer);
    elsif (s->>'order')::integer <> 0 then
      gain := (s->>'refund')::bigint - m.entry;
      mine := case when backed then 0 else gain end;
      result := 'lost';
      role := jsonb_build_object('kind', 'early', 'jumpMs', (s->>'jumpMs')::integer);
    else
      gain := -m.entry;
      mine := case when backed then 0 else gain end;
      result := 'lost';
      role := '{"kind":"aboard"}'::jsonb;
    end if;
    insert into public.match_parties (opener, n, account, role, side, result, delta, backing_other, share_bps, ride)
    values (o, k, s->>'player', 'player', (s->>'seat')::smallint, result, mine, backer, share, role);
    if backed then
      insert into public.match_parties (opener, n, account, role, side, result, delta, backing_other, share_bps, ride)
      values (o, k, backer, 'backer', (s->>'seat')::smallint, result, gain - mine, s->>'player', share, role);
    end if;
  end loop;
end $$;

-- 0015's function, plus the ride piece, the many-seat start (places, no parties of its own) and the rebuild.
create or replace function public.ingest_match_event(p jsonb) returns boolean
language plpgsql as $$
declare
  t text := p->>'type';
  o text := p->>'opener';
  k bigint := (p->>'n')::bigint;
  party jsonb;
  seats boolean := coalesce((p->>'many_seat')::boolean, false) or t = 'ride';
begin
  if t not in ('start', 'won', 'chunk', 'settled', 'ride') then
    raise exception 'unknown match record type %', t;
  end if;
  insert into public.match_events (event_id, opener, n, type, chunk_no, signature, slot, payload)
  values (p->>'event_id', o, k, t, (p->>'chunk_no')::integer, p->>'signature', (p->>'slot')::bigint, p)
  on conflict (event_id) do nothing;
  if not found then
    return false;
  end if;

  insert into public.match_history (opener, n) values (o, k) on conflict do nothing;
  if seats then
    update public.match_history set many_seat = true where opener = o and n = k;
  end if;

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
      places = coalesce(p->'places', places),
      status = case
        when status in ('settled', 'refunded') then status
        when (p->>'kind')::smallint in (0, 2) then 'settling'
        else 'refunding'
      end
    where opener = o and n = k;
    if not seats then
      delete from public.match_parties where opener = o and n = k;
      for party in select * from jsonb_array_elements(coalesce(p->'parties', '[]'::jsonb)) loop
        insert into public.match_parties (opener, n, account, role, side, result, delta, backing_other, share_bps)
        values (o, k, party->>'account', party->>'role', (party->>'side')::smallint, party->>'result',
                (party->>'delta')::bigint, party->>'backing_other', (party->>'share_bps')::integer);
      end loop;
    end if;
  elsif t = 'ride' then
    update public.match_history set ride = p->'ride', game = coalesce(game, 'railcar') where opener = o and n = k;
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
  perform public.mh_rebuild_seats(o, k);
  return true;
end $$;

-- A ride as the page and the card read it: the revealed ride with core's places and fees.
create function public.mh_ride(m public.match_history) returns jsonb
language sql stable as $$
  select case when m.ride is null then null else m.ride || jsonb_build_object(
    'places', coalesce(m.places, '[]'::jsonb),
    'fees', jsonb_build_array(coalesce(m.platform_fee, 0), coalesce(m.studio_fee, 0), coalesce(m.leaderboard_fee, 0))) end
$$;

-- 0010's row, plus `ride` ({ seated, kind, place?, jumpMs? }) on a many-seat Match's rows only.
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
    'opp', case when m.many_seat then null when pt.side = 0 then m.b_player else m.a_player end,
    'at', (extract(epoch from m.opened_at) * 1000)::bigint,
    'asset', case when m.game = 'trading-duel' then m.asset else null end,
    'backerDelta', case when pt.role = 'player' and pt.backing_other is not null then
      (select b.delta from public.match_parties b where b.opener = pt.opener and b.n = pt.n and b.role = 'backer' and b.side = pt.side limit 1) else null end
  ) || case when not m.many_seat then '{}'::jsonb
    else jsonb_build_object('ride', jsonb_build_object('seated', coalesce(jsonb_array_length(m.ride->'seats'),
      (select count(distinct x.side) from public.match_parties x where x.opener = m.opener and x.n = m.n)::integer)) || coalesce(pt.ride, '{}'::jsonb)) end
$$;

-- 0010's Match page, plus the ride.
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
  ) || case when m.ride is null then '{}'::jsonb else jsonb_build_object('ride', public.mh_ride(m)) end
  from public.match_history m where m.opener = p_opener and m.n = p_n and m.game is not null
$$;

-- 0010's card; a ride's card is its last Player off (first place), and carries the ride.
create or replace function public.win_card(p_opener text, p_n bigint) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', m.match_key, 'game', m.game, 'entry', m.entry, 'winner', pt.account, 'gemas', greatest(pt.delta, 0))
    || case when m.ride is null then '{}'::jsonb else jsonb_build_object('ride', public.mh_ride(m)) end
  from public.match_history m
  join public.match_parties pt on pt.opener = m.opener and pt.n = m.n and pt.role = 'player' and pt.result = 'won'
    and (not m.many_seat or pt.side = (m.places->0->>'seat')::smallint)
  where m.opener = p_opener and m.n = p_n and m.status = 'settled' and m.kind = 0
$$;

-- 0010's ticker; a ride pays its winner their entry and first place's winnings.
create or replace function public.recent_wins(p_game text, p_since bigint, p_limit integer) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(w order by oa desc, n desc), '[]'::jsonb) from (
    select m.opened_at as oa, m.n, jsonb_build_object(
      'id', m.match_key, 'game', m.game, 'entry', m.entry, 'winner', m.winner,
      'payout', case when m.many_seat then m.entry + coalesce((m.places->0->>'won')::bigint, 0)
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

revoke all on function public.mh_rebuild_seats(text, bigint), public.mh_ride(public.match_history) from public, anon, authenticated;

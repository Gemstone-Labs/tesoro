-- Match history, written from tesoro_core's event-CPI records (ticket 20 of the economy upgrade).
-- A MatchState closes once a Match is paid out, so finished Matches are read from here, not from the chain.
-- A Match id is the opener's Account plus its counter: `match_key` = '<opener>-<n>'.
--
-- Only the server (service role) touches these tables and functions: RLS on, no policies, no grants.
-- The keeper calls ingest_match_event for every record it reads from a transaction; the app server
-- reads through the functions below, which return jsonb shaped like the app's types.

create table public.match_history (
  opener text not null,
  n bigint not null,
  match_key text generated always as (opener || '-' || n::text) stored,
  game text,
  entry bigint,
  challenge boolean,
  asset smallint,
  opened_at timestamptz,
  -- MatchRunStarted.kind: 0 win, 1 no-show, 2 draw, 3 cancelled, 4 abandoned, 5 game upgraded, 6 refunded by game.
  kind smallint,
  -- 'seen' until a start record arrives, then settling or refunding, then settled (win, draw) or refunded.
  status text not null default 'seen' check (status in ('seen', 'settling', 'refunding', 'settled', 'refunded')),
  winner_side smallint,
  a_player text,
  a_funder text,
  b_player text,
  b_funder text,
  platform_fee bigint,
  studio_fee bigint,
  leaderboard_fee bigint,
  -- MatchWon: the winning Player, the losing Account, points, the Pool's cut, the Season, the settle time.
  winner text,
  loser text,
  points bigint,
  pool_fee bigint,
  season integer,
  won_at timestamptz,
  started_at timestamptz,
  settled_at timestamptz,
  chunks integer not null default 0,
  -- Block Burst only: [side A score, side B score], as read from the Session by whoever ingests.
  scores jsonb,
  primary key (opener, n),
  unique (match_key)
);

-- One row per Account in a finished Match: the Player or the Backer who funded the entry.
create table public.match_parties (
  opener text not null,
  n bigint not null,
  account text not null,
  role text not null check (role in ('player', 'backer')),
  side smallint not null check (side in (0, 1)),
  result text not null check (result in ('won', 'lost', 'draw', 'refunded')),
  -- Gemas gained (+) or lost (-) after Fees. A backed Player never goes below 0.
  delta bigint not null,
  -- The other party of a Backing and the Player's share of the surplus, when the entry was backed.
  backing_other text,
  share_bps integer,
  primary key (opener, n, account, role),
  foreign key (opener, n) references public.match_history (opener, n) on delete cascade
);
create index match_parties_account on public.match_parties (account);

-- Every record ever ingested; the primary key is what makes each one count at most once.
create table public.match_events (
  event_id text primary key,
  opener text not null,
  n bigint not null,
  type text not null check (type in ('start', 'won', 'chunk', 'settled')),
  chunk_no integer,
  signature text,
  slot bigint,
  payload jsonb not null,
  ingested_at timestamptz not null default now()
);
create index match_events_match on public.match_events (opener, n);

create index match_history_recent on public.match_history (opened_at desc) where status = 'settled' and kind = 0;
create index match_history_season on public.match_history (season) where kind = 0 and winner is not null;

alter table public.match_history enable row level security;
alter table public.match_parties enable row level security;
alter table public.match_events enable row level security;
revoke all on public.match_history from anon, authenticated;
revoke all on public.match_parties from anon, authenticated;
revoke all on public.match_events from anon, authenticated;

-- Seconds since the epoch to a timestamp; null stays null.
create function public.mh_ts(secs bigint) returns timestamptz
language sql immutable as $$ select to_timestamp(secs) $$;

-- Applies one record. p = { type, event_id, opener, n, signature?, slot?, ...fields }:
--   start   { game, entry, kind, winner_side, parties[], fees[3], a_player, a_funder, b_player, b_funder,
--             challenge, asset, opened_at, ts, scores? }     parties[] = { account, role, side, result, delta, backing_other, share_bps }
--   won     { game, entry, winner, loser, points, pool_fee, season, ts, challenge, asset, opened_at }
--   chunk   { chunk_no }
--   settled { kind, chunks, ts }
-- Records may arrive in any order and any number of times. Returns true when the record was new.
create function public.ingest_match_event(p jsonb) returns boolean
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
    update public.match_history set chunks = greatest(chunks, (p->>'chunk_no')::integer + 1)
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

-- A row of an Account's history, in the app's HistoryRow shape. `at` is in milliseconds.
create function public.mh_row(m public.match_history, pt public.match_parties) returns jsonb
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
    'opp', case when pt.side = 0 then m.b_player else m.a_player end,
    'at', (extract(epoch from m.opened_at) * 1000)::bigint,
    'asset', case when m.game = 'trading-duel' then m.asset else null end,
    -- what the Backer of this Player's side gained or lost (null when the Player funded their own entry)
    'backerDelta', case when pt.role = 'player' and pt.backing_other is not null then
      (select b.delta from public.match_parties b where b.opener = pt.opener and b.n = pt.n and b.role = 'backer' and b.side = pt.side limit 1) else null end
  )
$$;

-- One page of an Account's finished Matches (played and funded), newest first, optionally one Game (its program key). Page is 1-based and clamped.
create function public.history_page(p_account text, p_page integer, p_size integer, p_game text default null) returns jsonb
language plpgsql stable as $$
declare
  total integer;
  pages integer;
  pg integer;
  rows_json jsonb;
begin
  select count(*) into total
  from public.match_parties pt join public.match_history m using (opener, n)
  where pt.account = p_account and m.status in ('settled', 'refunded') and (p_game is null or m.game = p_game);
  pages := greatest(1, ceil(total::numeric / greatest(p_size, 1))::integer);
  pg := least(greatest(1, coalesce(p_page, 1)), pages);
  select coalesce(jsonb_agg(public.mh_row(x.mm, x.pp) order by (x.mm).opened_at desc, (x.mm).n desc, (x.pp).role), '[]'::jsonb) into rows_json
  from (
    select m as mm, pt as pp
    from public.match_parties pt join public.match_history m on m.opener = pt.opener and m.n = pt.n
    where pt.account = p_account and m.status in ('settled', 'refunded') and (p_game is null or m.game = p_game)
    order by m.opened_at desc, m.n desc, pt.role
    limit p_size offset (pg - 1) * p_size
  ) x;
  return jsonb_build_object('rows', rows_json, 'page', pg, 'pages', pages, 'total', total);
end $$;

-- The Match page of a finished or finishing Match, or null when it is unknown.
create function public.match_record(p_opener text, p_n bigint) returns jsonb
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
  )
  from public.match_history m where m.opener = p_opener and m.n = p_n and m.game is not null
$$;

-- What the win card shows: the settled Match, its winning Player and what they gained. Null for any Match without a winner.
create function public.win_card(p_opener text, p_n bigint) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', m.match_key, 'game', m.game, 'entry', m.entry, 'winner', pt.account, 'gemas', greatest(pt.delta, 0))
  from public.match_history m
  join public.match_parties pt on pt.opener = m.opener and pt.n = m.n and pt.role = 'player' and pt.result = 'won'
  where m.opener = p_opener and m.n = p_n and m.status = 'settled' and m.kind = 0
$$;

-- The Lobby ticker: settled Matches with a winner, newest first. p_since is in milliseconds, p_game is optional.
create function public.recent_wins(p_game text, p_since bigint, p_limit integer) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(w order by oa desc, n desc), '[]'::jsonb) from (
    select m.opened_at as oa, m.n, jsonb_build_object(
      'id', m.match_key, 'game', m.game, 'entry', m.entry, 'winner', m.winner,
      'payout', m.entry * 2 - coalesce(m.platform_fee, 0) - coalesce(m.studio_fee, 0) - coalesce(m.leaderboard_fee, 0),
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

-- Backing Requests show each Player's real record: Matches with a winner, wins, and the Gema change of each, oldest first.
create function public.player_forms(p_accounts text[]) returns jsonb
language sql stable as $$
  select coalesce(jsonb_object_agg(account, form), '{}'::jsonb) from (
    select pt.account, jsonb_build_object(
      'matches', count(*), 'wins', count(*) filter (where pt.result = 'won'),
      'pnl', jsonb_agg(pt.delta order by m.opened_at, m.n)) as form
    from public.match_parties pt join public.match_history m using (opener, n)
    where pt.account = any (p_accounts) and pt.role = 'player' and pt.result in ('won', 'lost')
      and m.status = 'settled' and m.kind = 0
    group by pt.account
  ) f
$$;

-- A Season's wins for the Leaderboard: one row per MatchWon record, oldest first.
create function public.season_wins(p_season integer) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('player', m.winner, 'points', m.points,
    'ts', extract(epoch from m.won_at)::bigint, 'matchId', m.match_key, 'loser', m.loser) order by m.won_at, m.n), '[]'::jsonb)
  from public.match_history m where m.season = p_season and m.winner is not null
$$;

revoke all on function public.ingest_match_event(jsonb), public.history_page(text, integer, integer, text),
  public.match_record(text, bigint), public.win_card(text, bigint), public.recent_wins(text, bigint, integer),
  public.player_forms(text[]), public.season_wins(integer), public.mh_row(public.match_history, public.match_parties),
  public.mh_ts(bigint) from public, anon, authenticated;

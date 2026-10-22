-- Checks the Friends functions of migration 0007_friends.sql on a scratch database (never prod):
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0007_friends.sql -f supabase/tests/0007_friends.test.sql
-- Each block raises an exception on the first wrong answer. Same rules as src/server/friends/routes.test.ts.

create or replace function pg_temp.eq(got text, want text, what text) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception '% : got %, want %', what, got, want; end if;
end $$;

do $$
declare
  t0 timestamptz := '2027-01-01T00:00:00Z';
  r text;
begin
  -- Request, then accept: Friends, the sender has not seen it yet, the request is gone.
  r := public.friends_request('A', 'B', t0, 500, 50);
  perform pg_temp.eq(split_part(r, ':', 1), 'requested', 'new request');
  perform pg_temp.eq(public.friends_request('A', 'B', t0, 500, 50), 'sent', 'repeat request');
  perform pg_temp.eq(public.friends_request('A', 'A', t0, 500, 50), 'self', 'self');
  perform pg_temp.eq(public.friends_accept('B', 'A', t0, 500), 'friends', 'accept');
  perform pg_temp.eq((select a_seen::text || b_seen::text from public.friendships where a = 'A' and b = 'B'), 'falsetrue', 'seen flags');
  perform pg_temp.eq((select count(*)::text from public.friend_requests where from_account in ('A', 'B')), '0', 'requests cleared');
  perform pg_temp.eq(public.friends_request('B', 'A', t0, 500, 50), 'already-friends', 'already friends');

  -- Crossing requests.
  perform public.friends_request('C', 'D', t0, 500, 50);
  perform pg_temp.eq(public.friends_request('D', 'C', t0, 500, 50), 'friends', 'crossing');

  -- Decline is silent; 30-day cooldown; a declined request can't be accepted or crossed.
  perform public.friends_request('E', 'F', t0, 500, 50);
  perform public.friends_decline('F', 'E', t0);
  perform pg_temp.eq(public.friends_request('E', 'F', t0 + interval '1 day', 500, 50), 'sent', 'cooldown says sent');
  perform pg_temp.eq(public.friends_accept('F', 'E', t0, 500), 'gone', 'declined not acceptable');
  perform pg_temp.eq(split_part(public.friends_request('F', 'E', t0, 500, 50), ':', 1), 'requested', 'declined does not cross');
  perform pg_temp.eq(public.friends_accept('E', 'F', t0, 500), 'friends', 'other way round works');
  perform public.friends_remove('E', 'F');
  perform public.friends_request('E', 'F', t0, 500, 50);
  perform public.friends_decline('F', 'E', t0);
  perform pg_temp.eq(split_part(public.friends_request('E', 'F', t0 + interval '31 days', 500, 50), ':', 1), 'requested', 'after cooldown');

  -- Expiry.
  perform public.friends_request('G', 'H', t0, 500, 50);
  perform pg_temp.eq(public.friends_accept('H', 'G', t0 + interval '31 days', 500), 'gone', 'expired');

  -- Remove clears the friendship and any declines.
  perform public.friends_request('I', 'J', t0, 500, 50);
  perform public.friends_accept('J', 'I', t0, 500);
  perform public.friends_remove('J', 'I');
  perform pg_temp.eq(public.friends_are('I', 'J')::text, 'false', 'removed');
  perform pg_temp.eq(split_part(public.friends_request('I', 'J', t0, 500, 50), ':', 1), 'requested', 're-request after remove');

  -- Caps: 2 waiting requests and 2 Friends for this check.
  perform public.friends_request('K', 'K1', t0, 2, 2);
  perform public.friends_request('K', 'K2', t0, 2, 2);
  perform pg_temp.eq(public.friends_request('K', 'K3', t0, 2, 2), 'request-cap', 'request cap');
  perform public.friends_accept('K1', 'K', t0, 2);
  perform public.friends_accept('K2', 'K', t0, 2);
  perform pg_temp.eq(public.friends_request('K', 'K3', t0, 2, 2), 'friend-cap', 'friend cap');
  perform public.friends_request('K3', 'K', t0, 2, 2);
  perform pg_temp.eq(public.friends_accept('K', 'K3', t0, 2), 'friend-cap', 'accept at cap');
  perform pg_temp.eq(public.friends_accept('K3', 'K', t0, 2), 'gone', 'no request that way');

  -- Friend links.
  insert into public.friend_links (account, code) values ('L', 'Lcode12345');
  perform pg_temp.eq(public.friends_redeem('L', 'Lcode12345', t0, 500), 'own', 'own link');
  perform pg_temp.eq(public.friends_redeem('M', 'Lcode12345', t0, 500), 'friends', 'redeem');
  perform pg_temp.eq(public.friends_redeem('M', 'Lcode12345', t0, 500), 'already-friends', 'redeem twice');
  perform pg_temp.eq(public.friends_redeem('M', 'nope000000', t0, 500), 'gone', 'unknown code');
  perform pg_temp.eq((select (case when a = 'L' then a_seen else b_seen end)::text from public.friendships where a = 'L' and b = 'M'), 'false', 'owner sees New');

  -- Challenges.
  perform pg_temp.eq(public.friends_challenge('A', 'Z', '11', t0, 10), 'not-friends', 'challenge stranger');
  perform pg_temp.eq(public.friends_challenge('A', 'B', '11', t0, 2), 'recorded:1', 'challenge');
  perform pg_temp.eq(public.friends_challenge('A', 'B', '11', t0, 2), 'duplicate', 'same match');
  perform pg_temp.eq(public.friends_challenge('A', 'B', '13', t0, 2), 'recorded:2', 'second today');
  perform pg_temp.eq(public.friends_challenge('A', 'B', '15', t0, 2), 'challenge-cap', 'daily cap');
  perform pg_temp.eq(public.friends_challenge('A', 'B', '15', t0 + interval '2 days', 2), 'recorded:1', 'next day');
end $$;

-- Functions are not callable by the anon or signed-in API roles.
do $$
begin
  if has_function_privilege('anon', 'public.friends_request(text, text, timestamptz, integer, integer)', 'execute') then
    raise exception 'anon can call friends_request';
  end if;
  if has_table_privilege('anon', 'public.friendships', 'select') then raise exception 'anon can read friendships'; end if;
end $$;

select 'friends sql ok' as result;

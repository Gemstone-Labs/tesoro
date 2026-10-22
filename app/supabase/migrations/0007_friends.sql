-- Friends: a private, two-way friend list (.scratch/friends/spec.md). Keyed by Account key (the tesoro_core
-- Account address), never by wallet. Server (service role) only: RLS on, no policies, functions not public.
-- Every change runs in one function that locks both Accounts, so caps and accept/remove races hold.

create table public.friend_requests (
  id uuid not null default gen_random_uuid(),
  from_account text not null,
  to_account text not null,
  created_at timestamptz not null,
  declined_at timestamptz,
  primary key (from_account, to_account),
  check (from_account <> to_account)
);
create index friend_requests_to_idx on public.friend_requests (to_account);

create table public.friendships (
  a text not null,
  b text not null,
  created_at timestamptz not null,
  a_seen boolean not null default true,
  b_seen boolean not null default true,
  primary key (a, b),
  check (a < b)
);
create index friendships_b_idx on public.friendships (b);

create table public.friend_links (
  account text primary key,
  code text not null unique,
  created_at timestamptz not null default now()
);

create table public.friend_challenges (
  match_id text primary key,
  from_account text not null,
  to_account text not null,
  created_at timestamptz not null
);
create index friend_challenges_to_idx on public.friend_challenges (to_account);
create index friend_challenges_from_idx on public.friend_challenges (from_account, created_at);

-- One row per Friends session. The cookie holds a random token; only its SHA-256 is stored.
create table public.friend_sessions (
  token_hash text primary key,
  account text not null,
  authority text not null,
  privy_sub text,
  nonce text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index friend_sessions_account_idx on public.friend_sessions (account);

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.friend_links enable row level security;
alter table public.friend_challenges enable row level security;
alter table public.friend_sessions enable row level security;
revoke all on public.friend_requests, public.friendships, public.friend_links, public.friend_challenges, public.friend_sessions from anon, authenticated;

-- Locks both Accounts (in a fixed order, so two calls never deadlock) until the transaction ends.
create function public.friends_lock(x text, y text) returns void language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('friends:' || least(x, y)));
  perform pg_advisory_xact_lock(hashtext('friends:' || greatest(x, y)));
end $$;

create function public.friends_count(acct text) returns integer language sql stable as $$
  select count(*)::integer from public.friendships where a = acct or b = acct
$$;

create function public.friends_are(x text, y text) returns boolean language sql stable as $$
  select exists (select 1 from public.friendships where a = least(x, y) and b = greatest(x, y))
$$;

-- A request is waiting while it is not declined and is younger than 30 days.
create function public.friends_waiting(r public.friend_requests, now_at timestamptz) returns boolean language sql immutable as $$
  select r.declined_at is null and r.created_at > now_at - interval '30 days'
$$;

-- Makes x and y Friends (the side that acted has seen it) and clears every request between them.
create function public.friends_make(actor text, other text, now_at timestamptz) returns void language plpgsql as $$
begin
  insert into public.friendships (a, b, created_at, a_seen, b_seen)
  values (least(actor, other), greatest(actor, other), now_at, least(actor, other) = actor, greatest(actor, other) = actor)
  on conflict (a, b) do nothing;
  delete from public.friend_requests
  where (from_account = actor and to_account = other) or (from_account = other and to_account = actor);
end $$;

-- Result: requested:<request id> (a new request) | sent (one already waiting, or declined: said the same way)
-- | friends | already-friends | self | friend-cap | their-cap | request-cap
create function public.friends_request(p_from text, p_to text, p_now timestamptz, p_max_friends integer, p_max_out integer)
returns text language plpgsql as $$
declare
  mine public.friend_requests;
  theirs public.friend_requests;
  new_id uuid := gen_random_uuid();
begin
  if p_from = p_to then return 'self'; end if;
  perform public.friends_lock(p_from, p_to);
  if public.friends_are(p_from, p_to) then return 'already-friends'; end if;
  select * into theirs from public.friend_requests where from_account = p_to and to_account = p_from;
  if found and public.friends_waiting(theirs, p_now) then
    if public.friends_count(p_from) >= p_max_friends then return 'friend-cap'; end if;
    if public.friends_count(p_to) >= p_max_friends then return 'their-cap'; end if;
    perform public.friends_make(p_from, p_to, p_now);
    return 'friends';
  end if;
  select * into mine from public.friend_requests where from_account = p_from and to_account = p_to;
  if found and public.friends_waiting(mine, p_now) then return 'sent'; end if;
  -- Declined within 30 days: say nothing, change nothing (a decline is silent).
  if found and mine.declined_at is not null and mine.declined_at > p_now - interval '30 days' then return 'sent'; end if;
  if public.friends_count(p_from) >= p_max_friends then return 'friend-cap'; end if;
  if (select count(*) from public.friend_requests r where r.from_account = p_from and public.friends_waiting(r, p_now)) >= p_max_out then
    return 'request-cap';
  end if;
  insert into public.friend_requests (id, from_account, to_account, created_at, declined_at)
  values (new_id, p_from, p_to, p_now, null)
  on conflict (from_account, to_account) do update set id = excluded.id, created_at = excluded.created_at, declined_at = null;
  return 'requested:' || new_id;
end $$;

-- Result: friends | gone | friend-cap | their-cap
create function public.friends_accept(p_me text, p_from text, p_now timestamptz, p_max_friends integer)
returns text language plpgsql as $$
declare
  r public.friend_requests;
begin
  perform public.friends_lock(p_me, p_from);
  if public.friends_are(p_me, p_from) then return 'friends'; end if;
  select * into r from public.friend_requests where from_account = p_from and to_account = p_me;
  if not found or not public.friends_waiting(r, p_now) then return 'gone'; end if;
  if public.friends_count(p_me) >= p_max_friends then return 'friend-cap'; end if;
  if public.friends_count(p_from) >= p_max_friends then return 'their-cap'; end if;
  perform public.friends_make(p_me, p_from, p_now);
  return 'friends';
end $$;

create function public.friends_decline(p_me text, p_from text, p_now timestamptz) returns text language plpgsql as $$
begin
  perform public.friends_lock(p_me, p_from);
  update public.friend_requests r set declined_at = p_now
  where r.from_account = p_from and r.to_account = p_me and public.friends_waiting(r, p_now);
  return 'declined';
end $$;

create function public.friends_remove(p_me text, p_other text) returns text language plpgsql as $$
begin
  perform public.friends_lock(p_me, p_other);
  delete from public.friendships where a = least(p_me, p_other) and b = greatest(p_me, p_other);
  delete from public.friend_requests
  where (from_account = p_me and to_account = p_other) or (from_account = p_other and to_account = p_me);
  return 'removed';
end $$;

-- Result: friends | already-friends | own | gone | friend-cap | their-cap
create function public.friends_redeem(p_me text, p_code text, p_now timestamptz, p_max_friends integer)
returns text language plpgsql as $$
declare
  owner text;
begin
  select account into owner from public.friend_links where code = p_code;
  if owner is null then return 'gone'; end if;
  if owner = p_me then return 'own'; end if;
  perform public.friends_lock(p_me, owner);
  if public.friends_are(p_me, owner) then return 'already-friends'; end if;
  if public.friends_count(p_me) >= p_max_friends then return 'friend-cap'; end if;
  if public.friends_count(owner) >= p_max_friends then return 'their-cap'; end if;
  perform public.friends_make(p_me, owner, p_now);
  return 'friends';
end $$;

-- Result: recorded:<friend Challenges from p_from to p_to in the last day, this one included> | not-friends | challenge-cap | duplicate
create function public.friends_challenge(p_from text, p_to text, p_match text, p_now timestamptz, p_max_per_day integer)
returns text language plpgsql as $$
begin
  perform public.friends_lock(p_from, p_to);
  if not public.friends_are(p_from, p_to) then return 'not-friends'; end if;
  delete from public.friend_challenges where from_account = p_from and created_at < p_now - interval '7 days';
  if (select count(*) from public.friend_challenges where from_account = p_from and created_at > p_now - interval '1 day') >= p_max_per_day then
    return 'challenge-cap';
  end if;
  insert into public.friend_challenges (match_id, from_account, to_account, created_at) values (p_match, p_from, p_to, p_now)
  on conflict (match_id) do nothing;
  if not found then return 'duplicate'; end if;
  return 'recorded:' || (select count(*) from public.friend_challenges
    where from_account = p_from and to_account = p_to and created_at > p_now - interval '1 day');
end $$;

revoke execute on function
  public.friends_lock(text, text), public.friends_count(text), public.friends_are(text, text),
  public.friends_waiting(public.friend_requests, timestamptz), public.friends_make(text, text, timestamptz),
  public.friends_request(text, text, timestamptz, integer, integer), public.friends_accept(text, text, timestamptz, integer),
  public.friends_decline(text, text, timestamptz), public.friends_remove(text, text),
  public.friends_redeem(text, text, timestamptz, integer), public.friends_challenge(text, text, text, timestamptz, integer)
from public, anon, authenticated;

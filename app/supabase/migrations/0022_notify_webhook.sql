-- Emails from the Helius webhook (keeper-diet ticket 13). Not applied by the ticket: an orchestrator step. Additive.
--
-- 1. webhook_tx gains the "emails sent" state, kept apart from "decoded": a row is claimed for a lease while one worker
--    reads it, so the webhook's after-response work and the cron never email the same transaction twice at once.
-- 2. open_match keeps the Matches that are open or being played, with the Players' wallets and the refund deadline, filled
--    from the open_match / join_match / extend_match_deadline instructions. The "Delayed" cron reads only this table.

alter table public.webhook_tx
  add column notified_at timestamptz,
  add column notify_lease_until timestamptz,
  add column notify_attempts integer not null default 0,
  add column notify_error text;
create index webhook_tx_to_notify on public.webhook_tx (slot, signature) where finalized and notified_at is null and notify_error is null;

-- Takes up to p_limit finalized rows whose emails are not sent, oldest first, and holds them for p_lease_secs.
create function public.webhook_claim_notify(p_limit integer, p_lease_secs integer) returns jsonb
language sql security definer set search_path = public as $$
  with c as (
    select signature from public.webhook_tx
    where finalized and notified_at is null and notify_error is null and (notify_lease_until is null or notify_lease_until < now())
    order by slot, signature limit greatest(p_limit, 0) for update skip locked
  ), u as (
    update public.webhook_tx t set notify_lease_until = now() + make_interval(secs => greatest(p_lease_secs, 1))
    from c where t.signature = c.signature
    returning t.signature, t.slot, t.block_time, t.body
  )
  select coalesce(jsonb_agg(jsonb_build_object('signature', u.signature, 'slot', u.slot, 'blockTime', u.block_time, 'body', u.body) order by u.slot, u.signature), '[]'::jsonb) from u
$$;

-- Ends the claim. p_error null: done. Otherwise the attempt is counted, the row is offered again, and after 5 attempts it is
-- left with the error for a person (clear notify_error and notify_attempts to retry).
create function public.webhook_notify_done(p_signature text, p_error text) returns void
language sql security definer set search_path = public as $$
  update public.webhook_tx set
    notified_at = case when p_error is null then now() else null end,
    notify_lease_until = null,
    notify_attempts = case when p_error is null then notify_attempts else notify_attempts + 1 end,
    notify_error = case when p_error is not null and notify_attempts + 1 >= 5 then p_error else null end
  where signature = p_signature
$$;

-- A Match from open to settled or refunded, keyed by its Match account. `players` is [{account, authority}] (opener first).
create table public.open_match (
  match_state text primary key,
  match_key text not null,
  game text not null,
  entry bigint not null,
  players jsonb not null,
  -- unix seconds; null until a second Player joins
  deadline bigint,
  delayed_told boolean not null default false,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);
create index open_match_live on public.open_match (match_state) where closed_at is null and deadline is not null and not delayed_told;
alter table public.open_match enable row level security;
revoke all on public.open_match from public, anon, authenticated, service_role;

create function public.open_match_open(p jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.open_match(match_state, match_key, game, entry, players)
    values (p->>'matchState', p->>'matchKey', p->>'game', (p->>'entry')::bigint, jsonb_build_array(p->'opener'))
    on conflict (match_state) do nothing
$$;

-- The second Player joined: the refund deadline is set. A repeat changes nothing.
create function public.open_match_join(p jsonb) returns void
language sql security definer set search_path = public as $$
  update public.open_match set
    players = case when players @> jsonb_build_array(p->'joiner') then players else players || jsonb_build_array(p->'joiner') end,
    deadline = coalesce(deadline, (p->>'deadline')::bigint)
  where match_state = p->>'matchState' and closed_at is null
$$;

create function public.open_match_extend(p_match_state text, p_deadline bigint) returns void
language sql security definer set search_path = public as $$
  update public.open_match set deadline = p_deadline where match_state = p_match_state and closed_at is null
$$;

create function public.open_match_get(p_match_state text) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(m) - 'created_at' - 'closed_at' from public.open_match m where match_state = p_match_state
$$;

create function public.open_match_close(p_match_state text) returns void
language sql security definer set search_path = public as $$
  update public.open_match set closed_at = now() where match_state = p_match_state and closed_at is null
$$;

-- Joined Matches that are not closed and whose Delayed email was not sent.
create function public.open_match_to_check() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(m) - 'created_at' - 'closed_at'), '[]'::jsonb)
  from public.open_match m where closed_at is null and deadline is not null and not delayed_told
$$;

create function public.open_match_delayed_told(p_match_state text) returns void
language sql security definer set search_path = public as $$
  update public.open_match set delayed_told = true where match_state = p_match_state
$$;

-- Drops closed rows older than p_closed_days and open ones whose deadline passed more than p_stale_days ago.
create function public.open_match_prune(p_now bigint, p_closed_days integer, p_stale_days integer) returns integer
language sql security definer set search_path = public as $$
  with d as (
    delete from public.open_match
    where (closed_at is not null and closed_at < now() - make_interval(days => p_closed_days))
       or (deadline is not null and deadline < p_now - p_stale_days * 86400)
    returning 1
  ) select count(*)::integer from d
$$;

revoke all on function public.webhook_claim_notify(integer, integer), public.webhook_notify_done(text, text),
  public.open_match_open(jsonb), public.open_match_join(jsonb), public.open_match_extend(text, bigint), public.open_match_get(text),
  public.open_match_close(text), public.open_match_to_check(), public.open_match_delayed_told(text), public.open_match_prune(bigint, integer, integer)
  from public, anon, authenticated;

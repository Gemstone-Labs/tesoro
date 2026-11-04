-- Transactions of tesoro_core delivered by the Helius raw webhook (ticket keeper-diet 12), kept by signature.
-- The route stores the raw transaction and answers; decoding into the Match history tables happens afterwards.
-- `finalized` is true once the chain has finalized the transaction: only finalized rows are decoded, because
-- Source-line records are immutable. Additive.
create table public.webhook_tx (
  signature text primary key,
  slot bigint not null,
  block_time bigint,
  body jsonb not null,
  finalized boolean not null default false,
  received_at timestamptz not null default now(),
  decoded_at timestamptz,
  decode_error text
);
create index webhook_tx_slot on public.webhook_tx (slot desc);
create index webhook_tx_to_decode on public.webhook_tx (slot, signature) where finalized and decoded_at is null and decode_error is null;
create index webhook_tx_unfinalized on public.webhook_tx (slot) where not finalized;
alter table public.webhook_tx enable row level security;
revoke all on public.webhook_tx from public, anon, authenticated, service_role;

-- Stores one transaction; false when the signature was already stored (a later finalized delivery still marks it finalized).
create function public.webhook_store_tx(p jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.webhook_tx(signature, slot, block_time, body, finalized)
    values (p->>'signature', (p->>'slot')::bigint, (p->>'blockTime')::bigint, p->'body', coalesce((p->>'finalized')::boolean, false))
    on conflict (signature) do nothing;
  get diagnostics n = row_count;
  if n = 0 and coalesce((p->>'finalized')::boolean, false) then
    update public.webhook_tx set finalized = true where signature = p->>'signature' and not finalized;
  end if;
  return n = 1;
end $$;

-- Finalized rows not decoded yet, oldest first. A row with a decode error waits for a person (clear decode_error to retry).
create function public.webhook_to_decode(p_limit integer) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('signature', t.signature, 'slot', t.slot, 'blockTime', t.block_time, 'body', t.body) order by t.slot, t.signature), '[]'::jsonb)
  from (select * from public.webhook_tx where finalized and decoded_at is null and decode_error is null order by slot, signature limit greatest(p_limit, 0)) t
$$;

-- Marks a row decoded; `p_error` keeps why a row could not be (it stays undecoded-visible for a person to read).
create function public.webhook_mark_decoded(p_signature text, p_error text) returns void
language sql security definer set search_path = public as $$
  update public.webhook_tx set decoded_at = case when p_error is null then now() else null end, decode_error = p_error where signature = p_signature
$$;

-- Signatures stored but not yet known to be finalized, oldest first.
create function public.webhook_unfinalized(p_limit integer) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(t.signature order by t.slot), '[]'::jsonb)
  from (select signature, slot from public.webhook_tx where not finalized order by slot limit greatest(p_limit, 0)) t
$$;

create function public.webhook_mark_finalized(p_signatures jsonb) returns integer
language sql security definer set search_path = public as $$
  with u as (update public.webhook_tx set finalized = true where not finalized and signature in (select jsonb_array_elements_text(p_signatures)) returning 1)
  select count(*)::integer from u
$$;

-- Deletes unfinalized rows the chain no longer knows (the catch-up passes only those) once they are older than p_age_secs.
-- History is rebuilt from chain, so a dropped row is not flagged, it is removed.
create function public.webhook_drop_stale(p_signatures jsonb, p_age_secs integer) returns integer
language sql security definer set search_path = public as $$
  with d as (
    delete from public.webhook_tx
    where not finalized and received_at < now() - make_interval(secs => greatest(p_age_secs, 0))
      and signature in (select jsonb_array_elements_text(p_signatures))
    returning 1)
  select count(*)::integer from d
$$;

-- Where the catch-up scan stands: the newest signature up to which every transaction of core is stored.
-- A webhook delivery never moves it, so a delivery Helius dropped in the middle is still found by the next scan.
create table public.webhook_cursor (
  id boolean primary key default true check (id),
  signature text not null,
  updated_at timestamptz not null default now()
);
alter table public.webhook_cursor enable row level security;
revoke all on public.webhook_cursor from public, anon, authenticated, service_role;

create function public.webhook_cursor_get() returns text
language sql stable security definer set search_path = public as $$
  select signature from public.webhook_cursor
$$;

create function public.webhook_cursor_set(p_signature text) returns void
language sql security definer set search_path = public as $$
  insert into public.webhook_cursor(signature) values (p_signature)
    on conflict (id) do update set signature = excluded.signature, updated_at = now()
$$;

revoke all on function public.webhook_store_tx(jsonb), public.webhook_to_decode(integer), public.webhook_mark_decoded(text, text),
  public.webhook_unfinalized(integer), public.webhook_mark_finalized(jsonb), public.webhook_drop_stale(jsonb, integer), public.webhook_cursor_get(), public.webhook_cursor_set(text) from public, anon, authenticated;

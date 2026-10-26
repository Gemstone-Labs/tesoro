-- Additive, versioned core event stream. Never infer completeness for pre-manifest Matches.
-- Keep raw 144-byte Line snapshots lossless; only finalized transactions may be ingested.
create table public.match_line_events (
  opener text not null,
  n numeric(20, 0) not null check (n >= 0 and n <= 18446744073709551615),
  event_id text not null,
  payload jsonb not null,
  primary key (opener, n, event_id)
);
alter table public.match_line_events enable row level security;
revoke all on public.match_line_events from public, anon, authenticated;

create function public.ingest_match_line_event(p jsonb) returns boolean
language plpgsql as $$
declare
  o text := p->>'opener';
  k numeric := (p->>'n')::numeric;
  eid text := p->>'event_id';
  old jsonb;
  body jsonb := p - 'signature' - 'slot';
begin
  if coalesce((p->>'finalized')::boolean, false) is not true or (p->>'version')::integer is distinct from 1 then
    raise exception 'Source-line records require finalized version 1 events';
  end if;
  if o is null or k is null or k <> trunc(k) or eid is null then raise exception 'Invalid line event identity'; end if;
  if p->>'type' = 'lines-start' then
    if (eid <> 'manifest' or jsonb_array_length(p->'pot_lines') <> 2
      or (p->'pot_lines'->>0)::bigint < 0 or (p->'pot_lines'->>1)::bigint < 0) is not false
      or not (p ? 'studio_owner') or jsonb_typeof(p->'studio_priority') is distinct from 'boolean'
      then raise exception 'Invalid line manifest'; end if;
  elsif p->>'type' = 'line-step' then
    if (eid <> 'step:' || (p->>'step') or coalesce((p->>'step')::bigint, 0) < 1
      or coalesce((p->>'chunk_no')::bigint, 0) < 1
      or (p->>'pot_side')::integer not in (0, 1) or coalesce((p->>'pot_index')::bigint, -1) < 0
      or (p->>'purpose')::integer not between 0 and 4 or (p->>'recipient_kind')::integer not in (0, 1)
      or (p->>'placement')::integer not in (0, 1, 2, 3, 255)
      or octet_length(decode(p->>'incoming', 'base64')) is distinct from 144
      or octet_length(decode(p->>'outgoing', 'base64')) is distinct from 144
      or p->>'recipient' is null) is not false then raise exception 'Invalid Source-line step'; end if;
  elsif p->>'type' = 'lines-progress' then
    if (eid <> 'progress:' || (p->>'chunk_no') or coalesce((p->>'chunk_no')::bigint, 0) < 1
      or coalesce((p->>'cumulative_steps')::bigint, -1) < 0 or jsonb_typeof(p->'done') is distinct from 'boolean'
      ) is not false then raise exception 'Invalid line progress'; end if;
  else raise exception 'Unknown Source-line event';
  end if;
  -- Serialize competing duplicate writers. A conflicting replay must stop the cursor, not overwrite evidence.
  perform pg_advisory_xact_lock(hashtextextended(o || ':' || k::text || ':' || eid, 0));
  select payload into old from public.match_line_events where opener = o and n = k and event_id = eid;
  if found then
    if old - 'signature' - 'slot' is distinct from body then raise exception 'Conflicting Source-line replay'; end if;
    return false;
  end if;
  insert into public.match_line_events values (o, k, eid, p);
  return true;
end $$;

-- Raw events are returned separately from the derived Match row. The server verifies manifest,
-- contiguous numeric steps, every original Pot slot, completion, fees and conservation before labelling complete.
create function public.match_source_line_events(p_opener text, p_n text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'header', (select payload from public.match_events where opener = p_opener and n::numeric = p_n::numeric and type = 'start' limit 1),
    'settled', (select payload from public.match_events where opener = p_opener and n::numeric = p_n::numeric and type = 'settled' limit 1),
    'won', (select payload from public.match_events where opener = p_opener and n::numeric = p_n::numeric and type = 'won' limit 1),
    'records', coalesce((select jsonb_agg(payload order by event_id) from public.match_line_events where opener = p_opener and n = p_n::numeric), '[]'::jsonb)
  )
$$;
revoke all on function public.ingest_match_line_event(jsonb), public.match_source_line_events(text, text) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on public.match_line_events from service_role;
    grant select, insert on public.match_line_events to service_role;
    grant execute on function public.ingest_match_line_event(jsonb), public.match_source_line_events(text, text) to service_role;
  end if;
end $$;

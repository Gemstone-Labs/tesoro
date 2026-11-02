-- A sponsored hold records where its address comes from (kind, Account, number), so the server can tell at its next admission
-- that the address was created and closed: Core makes a Match, Ticket or Pot only at the Account's next counter value, so an
-- address that is absent while the counter is past its number can never exist again (ADR 0014).
-- Additive. Holds made before this migration have no seed and stay with the reservation observer.
alter table public.sponsor_hold add column seed_kind text check (seed_kind in ('match', 'ticket'));
alter table public.sponsor_hold add column seed_account text;
alter table public.sponsor_hold add column seed_n numeric(20, 0) check (seed_n >= 0);
alter table public.sponsor_hold add column closure_checked_at timestamptz;
alter table public.sponsor_hold add constraint sponsor_hold_seed_whole
  check ((seed_kind is null) = (seed_account is null) and (seed_kind is null) = (seed_n is null));

-- 0017's function, now keeping the seed of each reservation it acquires.
create or replace function public.sponsor_prepare_completion(p_input jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  sig text := p_input->>'signature';
  prior public.sponsor_completion;
  h public.sponsor_hold;
  k text;
  seed jsonb;
  acquired jsonb := '[]';
  closing jsonb := '[]';
begin
  perform pg_advisory_xact_lock(40, 17);
  select * into prior from public.sponsor_completion where signature = sig;
  if found then
    if prior.input <> p_input or prior.state = 'failed' then
      raise exception 'Conflicting or failed sponsor transaction';
    end if;
    update public.sponsor_completion set retried = true where signature = sig;
    return false;
  end if;
  if sig is null or p_input->>'raw' is null or (p_input->>'reserve')::bigint < 0 then
    raise exception 'Invalid sponsor journal';
  end if;
  for k in select distinct value from jsonb_array_elements_text((p_input->'creates') || (p_input->'ensures')) loop
    select * into h from public.sponsor_hold where key = k;
    if found then
      if (p_input->'creates') ? k then raise exception 'Reservation already exists; reconcile its close before reuse'; end if;
      if exists (select 1 from public.sponsor_completion j where j.state = 'pending' and
        (j.signature = h.origin_signature or j.closes @> jsonb_build_array(jsonb_build_object('key', k, 'generation', h.generation)))) then
        raise exception 'Reservation has an unresolved transaction';
      end if;
    else
      seed := p_input->'seeds'->k;
      insert into public.sponsor_hold(key, lamports, origin_signature, seed_kind, seed_account, seed_n)
        values (k, (p_input->>'reserve')::bigint, sig, seed->>'kind', seed->>'account', (seed->>'n')::numeric)
        returning * into h;
      acquired := acquired || jsonb_build_array(jsonb_build_object('key', k, 'generation', h.generation));
    end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('key', key, 'generation', generation)), '[]') into closing
    from public.sponsor_hold where key in (select jsonb_array_elements_text(p_input->'closes'));
  insert into public.sponsor_completion(signature, input, acquired, closes) values (sig, p_input, acquired, closing);
  return true;
end $$;

create function public.sponsor_closure_candidates(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  perform pg_advisory_xact_lock(40, 17);
  with picked as (
    select key from public.sponsor_hold where seed_kind is not null
    order by closure_checked_at nulls first, created_at, key limit greatest(1, least(p_limit, 50)) for update
  ), touched as (
    update public.sponsor_hold h set closure_checked_at = clock_timestamp() from picked p where h.key = p.key returning h.*
  ) select coalesce(jsonb_agg(jsonb_build_object('key', key, 'generation', generation,
      'seed', jsonb_build_object('kind', seed_kind, 'account', seed_account, 'n', seed_n::text))), '[]') into result from touched;
  return result;
end $$;

-- Compare-and-delete by generation: a newer hold on the same address is never touched.
create function public.sponsor_release_closed(p_ref jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare released integer;
begin
  perform pg_advisory_xact_lock(40, 17);
  delete from public.sponsor_hold where key = p_ref->>'key' and generation = (p_ref->>'generation')::uuid and seed_kind is not null;
  get diagnostics released = row_count;
  return released > 0;
end $$;

revoke all on function public.sponsor_closure_candidates(integer), public.sponsor_release_closed(jsonb) from public, anon, authenticated;
grant execute on function public.sponsor_closure_candidates(integer), public.sponsor_release_closed(jsonb) to service_role;

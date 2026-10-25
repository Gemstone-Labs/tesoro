-- Drain old sponsor writers before applying, then deploy app and keeper together.
-- 0015/0016 belong to history. This migration preserves every existing reserve and counter.
alter table public.sponsor_hold add column generation uuid not null default gen_random_uuid();
alter table public.sponsor_hold add column origin_signature text;

create table public.sponsor_completion (
  signature text primary key,
  input jsonb not null,
  acquired jsonb not null,
  closes jsonb not null,
  state text not null default 'pending' check (state in ('pending', 'succeeded', 'failed')),
  retried boolean not null default false,
  created_at timestamptz not null default now(),
  checked_at timestamptz
);
create index sponsor_completion_pending on public.sponsor_completion (checked_at nulls first) where state = 'pending';
alter table public.sponsor_completion enable row level security;
revoke all on public.sponsor_completion from public, anon, authenticated, service_role;
-- An old app's address-only DELETE/UPSERT must fail closed during a mixed-version rollout.
revoke insert, update, delete, truncate on public.sponsor_hold from public, anon, authenticated, service_role;
grant select on public.sponsor_hold to service_role;

create function public.sponsor_prepare_completion(p_input jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  sig text := p_input->>'signature';
  prior public.sponsor_completion;
  h public.sponsor_hold;
  k text;
  acquired jsonb := '[]';
  closing jsonb := '[]';
begin
  -- All journal mutations use this lock: the generation snapshot and its fence are indivisible.
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
      insert into public.sponsor_hold(key, lamports, origin_signature) values (k, (p_input->>'reserve')::bigint, sig) returning * into h;
      acquired := acquired || jsonb_build_array(jsonb_build_object('key', k, 'generation', h.generation));
    end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('key', key, 'generation', generation)), '[]') into closing
    from public.sponsor_hold where key in (select jsonb_array_elements_text(p_input->'closes'));
  insert into public.sponsor_completion(signature, input, acquired, closes) values (sig, p_input, acquired, closing);
  return true;
end $$;

create function public.sponsor_finish_completion(p_signature text, p_success boolean, p_preflight boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare j public.sponsor_completion;
begin
  perform pg_advisory_xact_lock(40, 17);
  select * into j from public.sponsor_completion where signature = p_signature;
  if not found then raise exception 'Unknown sponsor transaction'; end if;
  if j.state <> 'pending' then return; end if;
  -- A concurrent submit/recovery may have broadcast identical bytes. One sender's preflight no longer proves absence.
  if p_preflight and j.retried then return; end if;
  delete from public.sponsor_hold h using jsonb_to_recordset(case when p_success then j.closes else j.acquired end) as r(key text, generation uuid)
    where h.key = r.key and h.generation = r.generation;
  update public.sponsor_completion set state = case when p_success then 'succeeded' else 'failed' end where signature = p_signature;
end $$;

create function public.sponsor_pending_completions(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  perform pg_advisory_xact_lock(40, 17);
  -- Rotate unresolved/archivally unavailable transactions so one old unknown cannot starve newer closes.
  with picked as (
    select signature from public.sponsor_completion where state = 'pending'
      order by checked_at nulls first, created_at, signature limit greatest(1, least(p_limit, 200)) for update skip locked
  ), touched as (
    update public.sponsor_completion j set checked_at = clock_timestamp(), retried = true from picked p where j.signature = p.signature returning j.*
  ) select coalesce(jsonb_agg((input - 'closes') || jsonb_build_object('acquired', acquired, 'closes', closes, 'state', state)), '[]') into result from touched;
  return result;
end $$;

revoke all on function public.sponsor_prepare_completion(jsonb), public.sponsor_finish_completion(text, boolean, boolean), public.sponsor_pending_completions(integer) from public, anon, authenticated;
grant execute on function public.sponsor_prepare_completion(jsonb), public.sponsor_finish_completion(text, boolean, boolean), public.sponsor_pending_completions(integer) to service_role;

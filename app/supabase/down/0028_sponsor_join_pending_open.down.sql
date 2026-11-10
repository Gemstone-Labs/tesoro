-- Restores 0019's sponsor_prepare_completion verbatim.
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

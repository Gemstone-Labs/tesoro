-- Join and assign in one transaction (keeper diet ticket 07). Server (service role) and keeper only; apply by hand.
--
-- table_pool: the tables that can take a Match right now, written by the keeper every pass (it alone can read a table's live
-- epoch in the rollup). table_lease: which of them a sponsor-server build holds, so two joins at once pick different tables.
create table public.table_pool (
  game text not null,
  generation int not null check (generation >= 0),
  idx int not null check (idx >= 0),
  epoch numeric(20, 0) not null check (epoch >= 0),
  updated_at timestamptz not null default now(),
  primary key (game, generation, idx)
);

-- A lease is for one Game, table and epoch: a table that went through a Match has a new epoch and is free at once.
create table public.table_lease (
  key text primary key,
  holder text not null,
  until timestamptz not null
);

alter table public.table_pool enable row level security;
alter table public.table_lease enable row level security;
revoke all on public.table_pool, public.table_lease from anon, authenticated;

-- Takes the lease when it is free or expired. False when another holder has it.
create function public.take_table_lease(p_key text, p_holder text, p_ttl_ms bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  taken int;
begin
  delete from public.table_lease where until < now() - interval '1 hour';
  insert into public.table_lease (key, holder, until) values (p_key, p_holder, now() + make_interval(secs => p_ttl_ms / 1000.0))
    on conflict (key) do update set holder = excluded.holder, until = excluded.until
    where public.table_lease.until <= now();
  get diagnostics taken = row_count;
  return taken = 1;
end $$;

-- Holds the lease for the holder until now + p_ttl_ms (the join was sent).
create function public.extend_table_lease(p_key text, p_holder text, p_ttl_ms bigint)
returns void language sql security definer set search_path = public as $$
  insert into public.table_lease (key, holder, until) values (p_key, p_holder, now() + make_interval(secs => p_ttl_ms / 1000.0))
    on conflict (key) do update set holder = excluded.holder, until = excluded.until;
$$;

create function public.release_table_lease(p_key text, p_holder text)
returns void language sql security definer set search_path = public as $$
  delete from public.table_lease where key = p_key and holder = p_holder;
$$;

revoke all on function public.take_table_lease(text, text, bigint), public.extend_table_lease(text, text, bigint), public.release_table_lease(text, text) from public, anon, authenticated;

-- The keeper replaces a Game's pool each pass with the tables ready for a Match (an empty list clears it).
create function public.publish_table_pool(p_game text, p_tables jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.table_pool where game = p_game;
  insert into public.table_pool (game, generation, idx, epoch)
    select p_game, (t->>'generation')::int, (t->>'index')::int, (t->>'epoch')::numeric from jsonb_array_elements(p_tables) t;
end $$;

revoke all on function public.publish_table_pool(text, jsonb) from public, anon, authenticated;

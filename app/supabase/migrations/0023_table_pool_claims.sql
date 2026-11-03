-- The table pool without a keeper loop (keeper diet ticket 24). Server and keeper only (service role); apply by hand, after 0021.
--
-- table_pool.epoch is now the epoch the NEXT Match on that table will have, kept by whoever moves a table:
--   * the sponsor server claims a table when it sends a join with its assign_match (claim_table);
--   * the step that sees the Match settle frees it (free_table): a Match that ran moved the table one epoch on;
--   * a rollup read (the keeper's pool repair) republishes the truth and corrects any drift (publish_table_pool).
alter table public.table_pool
  add column claimed_match text,
  add column claimed_at timestamptz,
  -- false when a Match ended without proof that it ran: the table's epoch is then unknown, and the table stays out of the pool until a rollup read.
  add column epoch_known boolean not null default true;

create index table_pool_claimed_match on public.table_pool (claimed_match) where claimed_match is not null;

-- Takes the table for a Match, at the epoch the pool holds. False when it is claimed, at another epoch, or not in the pool.
create function public.claim_table(p_game text, p_generation int, p_idx int, p_epoch numeric, p_match text)
returns boolean language sql security definer set search_path = public as $$
  with u as (
    update public.table_pool set claimed_match = p_match, claimed_at = now()
      where game = p_game and generation = p_generation and idx = p_idx and epoch = p_epoch and epoch_known
        and (claimed_match is null or claimed_match = p_match)
      returning 1
  ) select exists (select 1 from u);
$$;

-- The Match settled: its table is free again. `p_advanced` is true when the Match ran (the table moved one epoch on).
-- Otherwise the epoch is unknown and the table waits for a rollup read. False when the Match held no table.
create function public.free_table(p_match text, p_advanced boolean)
returns boolean language sql security definer set search_path = public as $$
  with u as (
    update public.table_pool set
        claimed_match = null, claimed_at = null,
        epoch = epoch + case when p_advanced then 1 else 0 end,
        epoch_known = p_advanced
      where claimed_match = p_match
      returning 1
  ) select exists (select 1 from u);
$$;

revoke all on function public.claim_table(text, int, int, numeric, text), public.free_table(text, boolean) from public, anon, authenticated;

-- The truth from a rollup read taken at `p_read_at`: the tables that can take a Match. They are added or corrected; a claim
-- is cleared only when it is older than a few minutes at the time of the read (a join sent just before the read is not yet
-- an Assignment on base). A claimed table the read does not list stays claimed; a table of unknown epoch it does not list is dropped.
drop function public.publish_table_pool(text, jsonb);
create function public.publish_table_pool(p_game text, p_tables jsonb, p_read_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare
  settled timestamptz := p_read_at - interval '3 minutes';
begin
  insert into public.table_pool (game, generation, idx, epoch)
    select p_game, (t->>'generation')::int, (t->>'index')::int, (t->>'epoch')::numeric from jsonb_array_elements(p_tables) t
  on conflict (game, generation, idx) do update set
    epoch = excluded.epoch,
    epoch_known = true,
    updated_at = now(),
    claimed_match = case when public.table_pool.claimed_at > settled then public.table_pool.claimed_match end,
    claimed_at = case when public.table_pool.claimed_at > settled then public.table_pool.claimed_at end;
  delete from public.table_pool p
    where p.game = p_game and p.claimed_match is null and not p.epoch_known
      and not exists (select 1 from jsonb_array_elements(p_tables) t where (t->>'generation')::int = p.generation and (t->>'index')::int = p.idx);
end $$;

revoke all on function public.publish_table_pool(text, jsonb, timestamptz) from public, anon, authenticated;

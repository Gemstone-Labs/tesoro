-- The table pool never keeps a dead row (keeper diet ticket 28). Server and keeper only (service role); apply by hand, after 0023.
--
-- Two kinds of row used to stay in table_pool forever and break joins:
--   * rows of a retired table generation (a program upgrade bumped config.generation): assign_match refuses them with BadTableSlot;
--   * a table that finished a Match stays Over at its old epoch: the keeper now lists such a table at epoch + 1 (as begin_match
--     resets it), but a settle that arrived after the claim was cleared found no claim and left the row one epoch behind.
--
-- The rules of publish_table_pool, on top of 0023's:
--   * an unclaimed row the read does not list is deleted, whatever its generation or epoch (the read is the truth: a table that is
--     not listed cannot take a Match). A row that claim_table or free_table touched after the read is left alone, and a listed
--     table returns at the next read;
--   * a claimed row keeps its epoch while the claim stands: free_table moves it one epoch on when the Match settles, and a read
--     that already shows the table one epoch on must not make that count twice. Once the claim is cleared the read's epoch wins.
create or replace function public.publish_table_pool(p_game text, p_tables jsonb, p_read_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare
  settled timestamptz := p_read_at - interval '3 minutes';
begin
  insert into public.table_pool (game, generation, idx, epoch)
    select p_game, (t->>'generation')::int, (t->>'index')::int, (t->>'epoch')::numeric from jsonb_array_elements(p_tables) t
  on conflict (game, generation, idx) do update set
    epoch = case
      when public.table_pool.updated_at > p_read_at or public.table_pool.claimed_at > settled then public.table_pool.epoch
      when public.table_pool.epoch_known then greatest(public.table_pool.epoch, excluded.epoch)
      else excluded.epoch end,
    epoch_known = case when public.table_pool.updated_at > p_read_at then public.table_pool.epoch_known else true end,
    claimed_match = case when public.table_pool.updated_at > p_read_at or public.table_pool.claimed_at > settled then public.table_pool.claimed_match end,
    claimed_at = case when public.table_pool.updated_at > p_read_at or public.table_pool.claimed_at > settled then public.table_pool.claimed_at end,
    updated_at = case when public.table_pool.updated_at > p_read_at then public.table_pool.updated_at else now() end;
  delete from public.table_pool p
    where p.game = p_game and p.claimed_match is null and p.updated_at <= p_read_at
      and not exists (select 1 from jsonb_array_elements(p_tables) t where (t->>'generation')::int = p.generation and (t->>'index')::int = p.idx);
end $$;

revoke all on function public.publish_table_pool(text, jsonb, timestamptz) from public, anon, authenticated;

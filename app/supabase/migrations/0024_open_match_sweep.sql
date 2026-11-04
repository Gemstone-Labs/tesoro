-- Safety sweep reads its candidates here (keeper-diet ticket 26). Not applied by the ticket: an orchestrator step. Additive.
--
-- open_match.closed_at is set when a Match STARTS settling (it ends the Delayed email), so it cannot say "the account still
-- exists". The sweep needs exactly that: a Settling Match still has chunks and close_match to go. `account_gone_at` is set by
-- the sweep when it reads a Match address and the account is not there any more.

alter table public.open_match add column account_gone_at timestamptz;
create index open_match_account_live on public.open_match (match_state) where account_gone_at is null;

-- Match accounts that may still exist and were opened in the last 30 days, as a jsonb array of addresses.
create function public.open_match_sweep_candidates() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(match_state order by created_at), '[]'::jsonb)
  from public.open_match where account_gone_at is null and created_at > now() - interval '30 days'
$$;

create function public.open_match_account_gone(p_match_states text[]) returns void
language sql security definer set search_path = public as $$
  update public.open_match set account_gone_at = now() where match_state = any(p_match_states) and account_gone_at is null
$$;

revoke all on function public.open_match_sweep_candidates(), public.open_match_account_gone(text[]) from public, anon, authenticated;

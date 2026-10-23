-- Studio listing (ticket 23): free to apply, accepted by an admin, then $500 a year. The on-chain listing (tesoro_core
-- list_game: listed_until, approved build hash) is written separately by the admin; this table is the paperwork.
-- Server (service role) only. NOT applied to production by the ticket: run it with the ticket 24 deploy.
create table public.studio_applications (
  id bigint generated always as identity primary key,
  program_id text not null check (program_id ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  studio text not null check (char_length(studio) between 1 and 80),
  game_name text not null check (char_length(game_name) between 1 and 60),
  contact_email text not null check (char_length(contact_email) between 3 and 200 and contact_email like '%_@_%.__%'),
  site text check (site is null or char_length(site) <= 200),
  blurb text not null default '' check (char_length(blurb) <= 600),
  status text not null default 'applied' check (status in ('applied', 'accepted', 'rejected')),
  featured boolean not null default false,
  note text check (note is null or char_length(note) <= 600),
  paid_until timestamptz,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
-- One live application per Game program; a rejected one can be re-filed.
create unique index studio_applications_open_program on public.studio_applications (program_id) where status <> 'rejected';

create table public.studio_payments (
  id bigint generated always as identity primary key,
  application_id bigint not null references public.studio_applications (id),
  kind text not null check (kind in ('chain', 'invoice')),
  -- A transaction signature for 'chain', an invoice number for 'invoice'. Unique so one payment is not recorded twice.
  reference text not null check (char_length(reference) between 1 and 120),
  amount_usd numeric(12, 2) not null check (amount_usd >= 0),
  years integer not null default 1 check (years between 1 and 5),
  period_start timestamptz not null,
  period_end timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (kind, reference)
);

alter table public.studio_applications enable row level security;
alter table public.studio_payments enable row level security;
revoke all on public.studio_applications, public.studio_payments from anon, authenticated;

-- Free to apply. Returns the application id, or -1 when this Game program already has a live application.
create function public.studio_apply(p_program_id text, p_studio text, p_game_name text, p_contact_email text, p_site text, p_blurb text)
returns bigint language plpgsql security definer set search_path = public as $$
declare new_id bigint;
begin
  insert into public.studio_applications (program_id, studio, game_name, contact_email, site, blurb)
    values (p_program_id, p_studio, p_game_name, p_contact_email, nullif(p_site, ''), coalesce(p_blurb, ''))
    on conflict (program_id) where status <> 'rejected' do nothing
    returning id into new_id;
  return coalesce(new_id, -1);
end $$;

-- Every application with its payments, newest first (admin page).
create function public.studio_list()
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(row order by (row->>'id')::bigint desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', a.id, 'programId', a.program_id, 'studio', a.studio, 'gameName', a.game_name, 'contactEmail', a.contact_email,
      'site', a.site, 'blurb', a.blurb, 'status', a.status, 'featured', a.featured, 'note', a.note,
      'paidUntil', extract(epoch from a.paid_until)::bigint, 'createdAt', extract(epoch from a.created_at)::bigint,
      'payments', coalesce((select jsonb_agg(jsonb_build_object('kind', p.kind, 'reference', p.reference, 'amountUsd', p.amount_usd,
        'years', p.years, 'periodEnd', extract(epoch from p.period_end)::bigint) order by p.id) from public.studio_payments p where p.application_id = a.id), '[]'::jsonb)
    ) as row from public.studio_applications a
  ) t
$$;

-- Accept or reject. Only an 'applied' application can be decided; returns false when it was not.
create function public.studio_decide(p_id bigint, p_status text, p_note text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('accepted', 'rejected') then raise exception 'bad status'; end if;
  update public.studio_applications set status = p_status, note = nullif(p_note, ''), decided_at = now()
    where id = p_id and status = 'applied';
  return found;
end $$;

-- Records one payment and extends paid_until by whole years from the later of now and the current paid_until.
-- Returns the new paid_until (epoch seconds), or -1 when the application is not accepted, -2 when the reference was already recorded.
create function public.studio_pay(p_id bigint, p_kind text, p_reference text, p_amount_usd numeric, p_years integer)
returns bigint language plpgsql security definer set search_path = public as $$
declare cur timestamptz; start_at timestamptz; end_at timestamptz;
begin
  select paid_until into cur from public.studio_applications where id = p_id and status = 'accepted' for update;
  if not found then return -1; end if;
  if exists (select 1 from public.studio_payments where kind = p_kind and reference = p_reference) then return -2; end if;
  start_at := greatest(now(), coalesce(cur, now()));
  end_at := start_at + make_interval(years => p_years);
  insert into public.studio_payments (application_id, kind, reference, amount_usd, years, period_start, period_end)
    values (p_id, p_kind, p_reference, p_amount_usd, p_years, start_at, end_at);
  update public.studio_applications set paid_until = end_at where id = p_id;
  return extract(epoch from end_at)::bigint;
end $$;

create function public.studio_set_featured(p_id bigint, p_featured boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.studio_applications set featured = p_featured where id = p_id and status = 'accepted';
  return found;
end $$;

-- What the public catalogue may show: accepted, paid up, featured. No contact details.
create function public.studio_featured()
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('programId', program_id, 'studio', studio, 'gameName', game_name, 'site', site,
    'paidUntil', extract(epoch from paid_until)::bigint) order by id), '[]'::jsonb)
  from public.studio_applications where status = 'accepted' and featured and paid_until > now()
$$;

revoke all on function public.studio_apply, public.studio_list, public.studio_decide, public.studio_pay, public.studio_set_featured, public.studio_featured from public, anon, authenticated;

-- ============================================================
-- Migrazione: Timeline periodi di validità dei calendari
-- Esegui questo file in Supabase → SQL Editor → New query → Run.
-- ============================================================

-- 1) Tabella per tracciare i periodi di validità dei calendari
create table if not exists calendar_periods (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  calendar_id uuid not null references calendars(id) on delete cascade,
  start_date date not null,
  created_at timestamptz default now()
);

-- Indice per velocizzare la ricerca del calendario attivo per data
create index if not exists idx_calendar_periods_ws_date
  on calendar_periods (workspace_id, start_date desc);

-- 2) RLS per calendar_periods
alter table calendar_periods enable row level security;

drop policy if exists cp_select on calendar_periods;
create policy cp_select on calendar_periods for select using (is_member(workspace_id));

drop policy if exists cp_insert on calendar_periods;
create policy cp_insert on calendar_periods for insert with check (my_role_in(workspace_id) = 'admin');

drop policy if exists cp_update on calendar_periods;
create policy cp_update on calendar_periods for update using (my_role_in(workspace_id) = 'admin');

drop policy if exists cp_delete on calendar_periods;
create policy cp_delete on calendar_periods for delete using (my_role_in(workspace_id) = 'admin');

-- 3) Inizializzazione retroattiva: crea il periodo iniziale per tutti gli spazi esistenti
insert into calendar_periods (workspace_id, calendar_id, start_date)
select w.id, w.active_calendar_id, '2000-01-01'::date
from workspaces w
where w.active_calendar_id is not null
  and not exists (
    select 1 from calendar_periods cp where cp.workspace_id = w.id
  );

-- 4) Se uno spazio aveva un cambio calendario programmato, aggiungilo come periodo futuro
insert into calendar_periods (workspace_id, calendar_id, start_date)
select w.id, w.scheduled_calendar_id, w.scheduled_calendar_date
from workspaces w
where w.scheduled_calendar_id is not null
  and w.scheduled_calendar_date is not null
  and not exists (
    select 1 from calendar_periods cp
    where cp.workspace_id = w.id
      and cp.calendar_id = w.scheduled_calendar_id
      and cp.start_date = w.scheduled_calendar_date
  );

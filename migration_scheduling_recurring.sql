-- ============================================================
-- Migrazione: cambio calendario programmato + presenza ricorrente + assenza esplicita
-- Esegui questo file in Supabase → SQL Editor → New query → Run.
-- ============================================================

-- 1) cambio calendario programmato: lo spazio può avere un calendario "in coda"
--    che diventa attivo da solo a una data futura (controllato lato client all'apertura app).
alter table workspaces add column if not exists scheduled_calendar_id uuid references calendars(id) on delete set null;
alter table workspaces add column if not exists scheduled_calendar_date date;

-- 2) presenza ricorrente: un istruttore può marcare un orario settimanale come
--    "presente di default ogni settimana", senza doverlo spuntare ogni volta.
create table if not exists recurring_presence (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references slots(id) on delete cascade,
  instructor_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz default now(),
  unique (slot_id, instructor_id)
);

alter table recurring_presence enable row level security;

drop policy if exists rp_select on recurring_presence;
create policy rp_select on recurring_presence for select using (
  exists (select 1 from slots s join calendars c on c.id = s.calendar_id where s.id = recurring_presence.slot_id and is_member(c.workspace_id))
);
drop policy if exists rp_ins_self on recurring_presence;
create policy rp_ins_self on recurring_presence for insert with check (is_my_profile(instructor_id));
drop policy if exists rp_del_self on recurring_presence;
create policy rp_del_self on recurring_presence for delete using (
  is_my_profile(instructor_id)
  or exists (select 1 from slots s join calendars c on c.id = s.calendar_id where s.id = recurring_presence.slot_id and my_role_in(c.workspace_id) = 'admin')
);

-- 3) l'assenza esplicita ("assente") esisteva già come valore di status ma non era
--    mai usata dall'app: nessuna modifica di schema necessaria, solo lato client.

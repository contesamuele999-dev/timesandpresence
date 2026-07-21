-- ============================================================
-- Migrazione: REGISTRO LEZIONE (lesson_logs)
-- Ogni istruttore può scrivere cosa ha fatto in una lezione (su una data precisa).
-- Una voce per istruttore + lezione + data. Tutti i membri leggono; ognuno modifica solo le proprie.
-- Esegui in Supabase → SQL Editor → New query → Run (una tantum).
-- ============================================================

create table if not exists lesson_logs (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid references slots(id) on delete cascade,
  extra_slot_id uuid references extra_slots(id) on delete cascade,
  instructor_id uuid not null references profiles(id) on delete cascade,
  date date not null,
  content text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint ll_one_slot_ref check (
    (slot_id is not null and extra_slot_id is null) or
    (slot_id is null and extra_slot_id is not null)
  )
);

-- una sola voce per (lezione ricorrente | lezione extra) + istruttore + data
create unique index if not exists lesson_logs_unique_slot
  on lesson_logs (slot_id, instructor_id, date) where slot_id is not null;
create unique index if not exists lesson_logs_unique_extra
  on lesson_logs (extra_slot_id, instructor_id, date) where extra_slot_id is not null;

-- ---------- RLS ----------
alter table lesson_logs enable row level security;

-- lettura: qualunque membro dello spazio (via slot/extra_slot -> calendario)
create policy ll_select on lesson_logs for select using (
  exists (select 1 from slots s join calendars c on c.id = s.calendar_id
          where s.id = lesson_logs.slot_id and is_member(c.workspace_id))
  or exists (select 1 from extra_slots e join calendars c on c.id = e.calendar_id
             where e.id = lesson_logs.extra_slot_id and is_member(c.workspace_id))
);

-- scrittura: ogni istruttore tocca solo le proprie voci (delete anche all'admin dello spazio)
create policy ll_ins_self on lesson_logs for insert with check (is_my_profile(instructor_id));
create policy ll_upd_self on lesson_logs for update using (is_my_profile(instructor_id));
create policy ll_del_self on lesson_logs for delete using (
  is_my_profile(instructor_id)
  or exists (select 1 from slots s join calendars c on c.id = s.calendar_id
             where s.id = lesson_logs.slot_id and my_role_in(c.workspace_id) = 'admin')
  or exists (select 1 from extra_slots e join calendars c on c.id = e.calendar_id
             where e.id = lesson_logs.extra_slot_id and my_role_in(c.workspace_id) = 'admin')
);

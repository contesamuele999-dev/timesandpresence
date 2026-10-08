-- ============================================================
-- Presencer — conteggio ore e compensi, richieste di assenza,
-- lezioni annullate in una data precisa.
-- Esegui in Supabase → SQL Editor → New query → Run, DOPO migration_notifications.sql.
-- Rieseguibile: non modifica né cancella presenze o profili esistenti.
-- ============================================================

begin;

-- ---------- GRADO (il "maestro caposcuola" incassa per intero le lezioni a cui partecipa) ----------
alter table profiles add column if not exists grade text not null default 'istruttore';
alter table profiles drop constraint if exists profiles_grade_check;
alter table profiles add constraint profiles_grade_check check (grade in ('istruttore','maestro'));

-- Ruolo e grado decidono permessi e compensi: li cambia solo un amministratore.
-- (pr_update_self consente a ognuno di modificare la propria riga, foto e nome inclusi.)
create or replace function guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and (new.role is distinct from old.role or new.grade is distinct from old.grade)
     and coalesce(my_role_in(old.workspace_id), '') <> 'admin' then
    raise exception 'Solo un amministratore può cambiare ruolo o grado' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_profile_privileges on profiles;
create trigger guard_profile_privileges before update on profiles
  for each row execute function guard_profile_privileges();

-- ---------- PRESENZA NON RETRIBUITA (l'istruttore c'è ma la lezione non entra nei compensi) ----------
alter table attendance add column if not exists unpaid boolean not null default false;

-- ---------- REGOLE COMPENSI (una riga per spazio) ----------
create table if not exists pay_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  default_rate numeric(10,2) not null default 0,         -- €/ora per i tipi di lezione senza tariffa
  rates jsonb not null default '{}'::jsonb,               -- {"corso adulti": 25, ...} chiave = etichetta in minuscolo
  copresence_factor numeric(6,4) not null default 0.6667, -- quota della tariffa a testa quando gli istruttori sono più d'uno
  master_takes_all boolean not null default true,         -- con un maestro presente il compenso va solo al maestro
  updated_at timestamptz not null default now()
);

alter table pay_settings enable row level security;
drop policy if exists ps_select on pay_settings;
create policy ps_select on pay_settings for select using (is_member(workspace_id));
drop policy if exists ps_insert on pay_settings;
create policy ps_insert on pay_settings for insert with check (my_role_in(workspace_id) = 'admin');
drop policy if exists ps_update on pay_settings;
create policy ps_update on pay_settings for update using (my_role_in(workspace_id) = 'admin');
grant select, insert, update on pay_settings to authenticated;

-- ---------- PRESENZE RICORRENTI CON STORICO ----------
-- Prima la ricorrenza valeva solo dalla settimana corrente in avanti, quindi le
-- settimane passate tornavano vuote e le ore non si potevano contare. Ora vale
-- dalla settimana in cui è stata creata fino a ended_on (escluso).
alter table recurring_presence add column if not exists ended_on date;
alter table recurring_presence drop constraint if exists recurring_presence_slot_id_instructor_id_key;
create unique index if not exists recurring_presence_one_active
  on recurring_presence (slot_id, instructor_id) where ended_on is null;

drop policy if exists rp_upd_self on recurring_presence;
create policy rp_upd_self on recurring_presence for update using (is_my_profile(instructor_id));

-- ---------- LEZIONI ANNULLATE (una lezione settimanale tolta in una data precisa) ----------
create table if not exists lesson_cancellations (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references slots(id) on delete cascade,
  date date not null,
  reason text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz default now(),
  unique (slot_id, date)
);

alter table lesson_cancellations enable row level security;
drop policy if exists lc_select on lesson_cancellations;
create policy lc_select on lesson_cancellations for select using (
  exists (select 1 from slots s join calendars c on c.id = s.calendar_id
          where s.id = lesson_cancellations.slot_id and is_member(c.workspace_id))
);
drop policy if exists lc_insert on lesson_cancellations;
create policy lc_insert on lesson_cancellations for insert with check (
  exists (select 1 from slots s join calendars c on c.id = s.calendar_id
          where s.id = slot_id and my_role_in(c.workspace_id) = 'admin')
);
drop policy if exists lc_delete on lesson_cancellations;
create policy lc_delete on lesson_cancellations for delete using (
  exists (select 1 from slots s join calendars c on c.id = s.calendar_id
          where s.id = lesson_cancellations.slot_id and my_role_in(c.workspace_id) = 'admin')
);
grant select on lesson_cancellations to anon;
grant select, insert, delete on lesson_cancellations to authenticated;

-- ---------- RICHIESTE DI ASSENZA ----------
create table if not exists absence_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  slot_id uuid references slots(id) on delete cascade,
  extra_slot_id uuid references extra_slots(id) on delete cascade,
  instructor_id uuid not null references profiles(id) on delete cascade,
  date date not null,
  reason text,
  status text not null default 'in_attesa' check (status in ('in_attesa','approvata','rifiutata')),
  decided_by uuid references profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz default now(),
  constraint ar_one_slot_ref check (
    (slot_id is not null and extra_slot_id is null) or
    (slot_id is null and extra_slot_id is not null)
  )
);
create unique index if not exists absence_requests_one_pending
  on absence_requests (coalesce(slot_id, extra_slot_id), instructor_id, date) where status = 'in_attesa';
create index if not exists idx_absence_requests_ws_date on absence_requests (workspace_id, date);

alter table absence_requests enable row level security;
drop policy if exists ar_select on absence_requests;
create policy ar_select on absence_requests for select using (is_member(workspace_id));
drop policy if exists ar_insert on absence_requests;
create policy ar_insert on absence_requests for insert with check (
  status = 'in_attesa'
  and exists (select 1 from profiles p where p.id = instructor_id
              and p.user_id = auth.uid() and p.workspace_id = absence_requests.workspace_id)
  and (
    exists (select 1 from slots s join calendars c on c.id = s.calendar_id
            where s.id = slot_id and c.workspace_id = absence_requests.workspace_id)
    or exists (select 1 from extra_slots e join calendars c on c.id = e.calendar_id
               where e.id = extra_slot_id and c.workspace_id = absence_requests.workspace_id)
  )
);
drop policy if exists ar_update_admin on absence_requests;
create policy ar_update_admin on absence_requests for update using (my_role_in(workspace_id) = 'admin');
drop policy if exists ar_delete on absence_requests;
create policy ar_delete on absence_requests for delete using (
  is_my_profile(instructor_id) or my_role_in(workspace_id) = 'admin'
);
grant select, insert, update, delete on absence_requests to authenticated;

-- Approvata = l'istruttore risulta assente in quella lezione. Le presenze sono
-- scrivibili solo dal diretto interessato, quindi lo fa il database.
create or replace function apply_approved_absence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update attendance set status = 'assente'
    where instructor_id = new.instructor_id and date = new.date
      and slot_id is not distinct from new.slot_id
      and extra_slot_id is not distinct from new.extra_slot_id;
  if not found then
    insert into attendance (slot_id, extra_slot_id, instructor_id, date, status)
      values (new.slot_id, new.extra_slot_id, new.instructor_id, new.date, 'assente');
  end if;
  return new;
end;
$$;

drop trigger if exists apply_approved_absence on absence_requests;
create trigger apply_approved_absence after update of status on absence_requests
  for each row when (new.status = 'approvata' and old.status is distinct from 'approvata')
  execute function apply_approved_absence();

-- ---------- NOTIFICHE ----------
alter table notification_preferences add column if not exists absence boolean not null default true;
alter table app_events drop constraint if exists app_events_category_check;
alter table app_events add constraint app_events_category_check check (category in (
  'attendance','recurring','schedule','calendar','lesson_log','members','absence'
));

create or replace function record_presencer_event_extra()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  row_data record;
  ws_id uuid;
  actor_id uuid;
  actor_name text;
  target_name text;
  lesson text;
  event_category text;
  event_title text;
  event_body text;
begin
  if tg_op = 'DELETE' then row_data := old; else row_data := new; end if;
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_table_name = 'lesson_cancellations' then
    select c.workspace_id, s.label || ' ' || to_char(s.start_time, 'HH24:MI') into ws_id, lesson
      from slots s join calendars c on c.id = s.calendar_id where s.id = row_data.slot_id;
    event_category := 'schedule';
    event_title := case tg_op when 'DELETE' then 'Lezione ripristinata' else 'Lezione annullata' end;
    event_body := coalesce(lesson, 'Lezione') || ' · ' || to_char(row_data.date, 'DD/MM/YYYY');
  else
    if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
    ws_id := row_data.workspace_id;
    if row_data.slot_id is not null then
      select label || ' ' || to_char(start_time, 'HH24:MI') into lesson from slots where id = row_data.slot_id;
    else
      select label || ' ' || to_char(start_time, 'HH24:MI') into lesson from extra_slots where id = row_data.extra_slot_id;
    end if;
    select name into target_name from profiles where id = row_data.instructor_id;
    event_category := 'absence';
    event_title := case
      when tg_op = 'INSERT' then 'Richiesta di assenza'
      when tg_op = 'DELETE' then 'Richiesta di assenza ritirata'
      when row_data.status = 'approvata' then 'Assenza approvata'
      when row_data.status = 'rifiutata' then 'Assenza rifiutata'
      else 'Richiesta di assenza riaperta' end;
    event_body := coalesce(target_name, 'Un membro') || ' · ' || coalesce(lesson, 'lezione') || ' · ' ||
      to_char(row_data.date, 'DD/MM/YYYY') ||
      case when tg_op = 'INSERT' and coalesce(row_data.reason, '') <> '' then ' · ' || row_data.reason else '' end;
  end if;

  if ws_id is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  select id, name into actor_id, actor_name
    from profiles where workspace_id = ws_id and user_id = auth.uid() limit 1;

  insert into app_events (workspace_id, actor_profile_id, category, action, title, body, metadata)
  values (ws_id, actor_id, event_category, lower(tg_op), event_title, event_body,
    jsonb_build_object('table', tg_table_name, 'record_id', row_data.id, 'actor_name', actor_name));

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists notify_absence_changes on absence_requests;
create trigger notify_absence_changes after insert or update or delete on absence_requests
  for each row execute function record_presencer_event_extra();

drop trigger if exists notify_cancellation_changes on lesson_cancellations;
create trigger notify_cancellation_changes after insert or delete on lesson_cancellations
  for each row execute function record_presencer_event_extra();

commit;

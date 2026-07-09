-- ============================================================
-- Times & Presence — schema Supabase
-- Esegui tutto questo file in Supabase → SQL Editor → New query → Run
-- (per installazioni già esistenti, usa invece i file migration_*.sql)
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- WORKSPACES (palestra / azienda / famiglia) ----------
create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text unique not null,
  active_calendar_id uuid,
  scheduled_calendar_id uuid,
  scheduled_calendar_date date,
  created_at timestamptz default now()
);

-- ---------- PROFILES (un utente può avere un profilo per ogni spazio a cui appartiene) ----------
create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  name text not null,
  role text not null check (role in ('admin','instructor')) default 'instructor',
  color text default '#E86B00',
  avatar_url text,
  created_at timestamptz default now(),
  unique (user_id, workspace_id)
);

-- ---------- CALENDARS (periodi: estate / inverno / extra / personalizzato) ----------
create table if not exists calendars (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  period text not null default 'personalizzato', -- estate | inverno | extra | personalizzato
  created_at timestamptz default now()
);

alter table workspaces
  add constraint fk_active_calendar foreign key (active_calendar_id) references calendars(id) on delete set null;
alter table workspaces
  add constraint fk_scheduled_calendar foreign key (scheduled_calendar_id) references calendars(id) on delete set null;

-- ---------- SLOTS (orari settimanali ricorrenti di un calendario) ----------
create table if not exists slots (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references calendars(id) on delete cascade,
  weekday int not null check (weekday between 0 and 6), -- 0=lunedì .. 6=domenica
  start_time time not null,
  end_time time not null,
  label text not null default 'Lezione',
  created_at timestamptz default now()
);

-- ---------- EXTRA SLOTS (lezioni extra one-off, es. private, su una data precisa) ----------
create table if not exists extra_slots (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references calendars(id) on delete cascade,
  date date not null,
  start_time time not null,
  end_time time not null,
  label text not null default 'Lezione privata',
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz default now()
);

-- ---------- GUEST LINKS (accessi "usa e getta") ----------
create table if not exists guest_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  token text unique not null,
  label text default 'Accesso rapido',
  expires_at timestamptz not null,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz default now()
);

-- ---------- ATTENDANCE (presenze: sia per istruttori registrati, sia per ospiti) ----------
create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid references slots(id) on delete cascade,
  extra_slot_id uuid references extra_slots(id) on delete cascade,
  instructor_id uuid references profiles(id) on delete cascade,
  guest_token text references guest_links(token) on delete cascade,
  guest_name text,
  date date not null,
  status text not null check (status in ('presente','assente')) default 'presente',
  note text,
  created_at timestamptz default now(),
  constraint one_slot_ref check (
    (slot_id is not null and extra_slot_id is null) or
    (slot_id is null and extra_slot_id is not null)
  ),
  constraint one_who_ref check (
    (instructor_id is not null and guest_token is null) or
    (instructor_id is null and guest_token is not null)
  )
);

create unique index if not exists attendance_unique_reg
  on attendance (slot_id, extra_slot_id, instructor_id, date)
  where instructor_id is not null;

create unique index if not exists attendance_unique_guest
  on attendance (slot_id, extra_slot_id, guest_token, date)
  where guest_token is not null;

-- ---------- RECURRING PRESENCE (un istruttore segna un orario come "presente ogni settimana") ----------
create table if not exists recurring_presence (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references slots(id) on delete cascade,
  instructor_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'presente' check (status in ('presente','assente')),
  created_at timestamptz default now(),
  unique (slot_id, instructor_id)
);

-- ============================================================
-- RLS
-- ============================================================
alter table workspaces enable row level security;
alter table profiles enable row level security;
alter table calendars enable row level security;
alter table slots enable row level security;
alter table extra_slots enable row level security;
alter table guest_links enable row level security;
alter table attendance enable row level security;
alter table recurring_presence enable row level security;

-- helper: l'utente loggato è membro dello spazio indicato?
create or replace function is_member(ws uuid) returns boolean
language sql security definer stable as $$
  select exists(select 1 from profiles where user_id = auth.uid() and workspace_id = ws)
$$;

-- helper: ruolo dell'utente loggato nello spazio indicato ('admin'/'instructor'/null)
create or replace function my_role_in(ws uuid) returns text
language sql security definer stable as $$
  select role from profiles where user_id = auth.uid() and workspace_id = ws limit 1
$$;

-- helper: la riga profiles indicata appartiene all'utente loggato? (un utente ha un profilo per spazio)
create or replace function is_my_profile(pid uuid) returns boolean
language sql security definer stable as $$
  select exists(select 1 from profiles p where p.id = pid and p.user_id = auth.uid())
$$;

-- workspaces: leggibile da chi ne è membro; creabile da chiunque loggato (un account può creare più spazi)
create policy ws_select on workspaces for select using (is_member(id));
create policy ws_insert on workspaces for insert with check (auth.uid() is not null);
create policy ws_update on workspaces for update using (my_role_in(id) = 'admin');
create policy ws_delete on workspaces for delete using (my_role_in(id) = 'admin');
-- lettura pubblica minimale per validare un invite_code in fase di join (filtrata lato client)
create policy ws_select_by_code on workspaces for select using (true);

-- profiles: leggibili da chi è membro dello stesso workspace; ognuno modifica se stesso, admin modifica tutti
create policy pr_select on profiles for select using (is_member(workspace_id));
-- lettura pubblica per gli accessi rapidi (anon): serve a mostrare i nomi degli istruttori nella
-- vista "presenze di tutti" anche a chi entra con un link usa-e-getta (stesso livello di apertura
-- già usato per workspaces/guest_links)
create policy pr_select_anon on profiles for select to anon using (true);
create policy pr_insert on profiles for insert with check (user_id = auth.uid());
create policy pr_update_self on profiles for update using (user_id = auth.uid());
create policy pr_update_admin on profiles for update using (my_role_in(workspace_id) = 'admin');
create policy pr_delete_admin on profiles for delete using (my_role_in(workspace_id) = 'admin');

-- calendars: lettura per membri, scrittura solo admin dello spazio
create policy cal_select on calendars for select using (is_member(workspace_id));
create policy cal_write on calendars for insert with check (my_role_in(workspace_id) = 'admin');
create policy cal_update on calendars for update using (my_role_in(workspace_id) = 'admin');
create policy cal_delete on calendars for delete using (my_role_in(workspace_id) = 'admin');

-- slots: lettura per chiunque membro (via join calendars), scrittura solo admin
create policy slot_select on slots for select using (
  exists (select 1 from calendars c where c.id = slots.calendar_id and is_member(c.workspace_id))
);
create policy slot_write on slots for insert with check (
  exists (select 1 from calendars c where c.id = calendar_id and my_role_in(c.workspace_id) = 'admin')
);
create policy slot_update on slots for update using (
  exists (select 1 from calendars c where c.id = slots.calendar_id and my_role_in(c.workspace_id) = 'admin')
);
create policy slot_delete on slots for delete using (
  exists (select 1 from calendars c where c.id = slots.calendar_id and my_role_in(c.workspace_id) = 'admin')
);

-- extra_slots: lettura per membri, scrittura per chiunque membro (istruttori possono aggiungere lezioni extra/private)
create policy ex_select on extra_slots for select using (
  exists (select 1 from calendars c where c.id = extra_slots.calendar_id and is_member(c.workspace_id))
);
create policy ex_insert on extra_slots for insert with check (
  exists (select 1 from calendars c where c.id = calendar_id and is_member(c.workspace_id))
);
-- accesso ospite (anon): può aggiungere lezioni extra solo in spazi con un link usa-e-getta ancora valido
create policy ex_insert_anon on extra_slots for insert to anon with check (
  exists (
    select 1 from calendars c join guest_links g on g.workspace_id = c.workspace_id
    where c.id = calendar_id and g.expires_at > now()
  )
);
create policy ex_delete on extra_slots for delete using (
  exists (select 1 from calendars c where c.id = extra_slots.calendar_id and (
    is_my_profile(extra_slots.created_by) or my_role_in(c.workspace_id) = 'admin'
  ))
);

-- guest_links: gestiti da admin; lettura pubblica per validare il token (accesso anonimo)
create policy gl_select_public on guest_links for select using (true);
create policy gl_insert on guest_links for insert with check (my_role_in(workspace_id) = 'admin');
create policy gl_delete on guest_links for delete using (my_role_in(workspace_id) = 'admin');

-- attendance: lettura per chiunque membro (join su slot/extra_slot->calendar)
create policy att_select on attendance for select using (
  exists (
    select 1 from slots s join calendars c on c.id = s.calendar_id
    where s.id = attendance.slot_id and is_member(c.workspace_id)
  )
  or exists (
    select 1 from extra_slots e join calendars c on c.id = e.calendar_id
    where e.id = attendance.extra_slot_id and is_member(c.workspace_id)
  )
);

-- insert/update/delete: un istruttore registrato tocca solo le proprie righe (o l'admo dello spazio in delete)
create policy att_ins_self on attendance for insert with check (
  is_my_profile(instructor_id)
);
create policy att_upd_self on attendance for update using (
  is_my_profile(instructor_id)
);
create policy att_del_self on attendance for delete using (
  is_my_profile(instructor_id)
  or exists (select 1 from slots s join calendars c on c.id = s.calendar_id where s.id = attendance.slot_id and my_role_in(c.workspace_id) = 'admin')
  or exists (select 1 from extra_slots e join calendars c on c.id = e.calendar_id where e.id = attendance.extra_slot_id and my_role_in(c.workspace_id) = 'admin')
);

-- insert/update/delete per accesso ospite: valido solo se il token esiste e non è scaduto (accesso anon)
create policy att_ins_guest on attendance for insert with check (
  guest_token is not null and exists (
    select 1 from guest_links g where g.token = attendance.guest_token and g.expires_at > now()
  )
);
create policy att_upd_guest on attendance for update using (
  guest_token is not null and exists (
    select 1 from guest_links g where g.token = attendance.guest_token and g.expires_at > now()
  )
);
create policy att_del_guest on attendance for delete using (
  guest_token is not null and exists (
    select 1 from guest_links g where g.token = attendance.guest_token and g.expires_at > now()
  )
);

-- recurring_presence: lettura per membri, scrittura solo per sé stessi (o admin in delete)
create policy rp_select on recurring_presence for select using (
  exists (select 1 from slots s join calendars c on c.id = s.calendar_id where s.id = recurring_presence.slot_id and is_member(c.workspace_id))
);
create policy rp_ins_self on recurring_presence for insert with check (is_my_profile(instructor_id));
create policy rp_del_self on recurring_presence for delete using (
  is_my_profile(instructor_id)
  or exists (select 1 from slots s join calendars c on c.id = s.calendar_id where s.id = recurring_presence.slot_id and my_role_in(c.workspace_id) = 'admin')
);

-- consente anche al ruolo anon (non loggato) di leggere/scrivere le tabelle necessarie al flusso ospite
grant select on guest_links, calendars, slots, extra_slots, attendance, workspaces, profiles to anon;
grant insert, update, delete on attendance to anon;
grant insert on extra_slots to anon;

-- ============================================================
-- STORAGE: foto profilo (solo account registrati)
-- ============================================================
insert into storage.buckets (id, name, public) values ('avatars','avatars', true)
  on conflict (id) do nothing;

create policy avatars_public_read on storage.objects for select using (bucket_id = 'avatars');
create policy avatars_owner_write on storage.objects for insert to authenticated with check (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
);
create policy avatars_owner_update on storage.objects for update to authenticated using (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
);
create policy avatars_owner_delete on storage.objects for delete to authenticated using (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
);

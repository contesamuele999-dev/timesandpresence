-- ============================================================
-- Migrazione: un account può appartenere/gestire più spazi (workspace)
-- Esegui questo file in Supabase → SQL Editor → New query → Run.
-- Sicuro da eseguire anche se avevi già lanciato migration_guest_shared_view.sql.
-- ============================================================

-- 1) profiles: prima un utente aveva un solo profilo (id = auth.uid()).
--    Ora un utente può avere un profilo per ogni spazio: aggiungiamo user_id,
--    ripopoliamo dai dati esistenti, e rendiamo id indipendente da auth.users.
alter table profiles add column if not exists user_id uuid references auth.users(id) on delete cascade;
update profiles set user_id = id where user_id is null;
alter table profiles alter column user_id set not null;

alter table profiles drop constraint if exists profiles_id_fkey;
alter table profiles alter column id set default gen_random_uuid();

alter table profiles drop constraint if exists profiles_user_id_workspace_id_key;
alter table profiles add constraint profiles_user_id_workspace_id_key unique (user_id, workspace_id);

-- 2) nuove funzioni RLS basate su user_id (sostituiscono my_workspace()/is_admin())
create or replace function is_member(ws uuid) returns boolean
language sql security definer stable as $$
  select exists(select 1 from profiles where user_id = auth.uid() and workspace_id = ws)
$$;

create or replace function my_role_in(ws uuid) returns text
language sql security definer stable as $$
  select role from profiles where user_id = auth.uid() and workspace_id = ws limit 1
$$;

create or replace function is_my_profile(pid uuid) returns boolean
language sql security definer stable as $$
  select exists(select 1 from profiles p where p.id = pid and p.user_id = auth.uid())
$$;

-- 3) ricrea le policy che usavano le vecchie funzioni a workspace-singolo
drop policy if exists ws_select on workspaces;
create policy ws_select on workspaces for select using (is_member(id));
drop policy if exists ws_update on workspaces;
create policy ws_update on workspaces for update using (my_role_in(id) = 'admin');

drop policy if exists pr_select on profiles;
create policy pr_select on profiles for select using (is_member(workspace_id));
drop policy if exists pr_select_anon on profiles;
create policy pr_select_anon on profiles for select to anon using (true);
drop policy if exists pr_insert on profiles;
create policy pr_insert on profiles for insert with check (user_id = auth.uid());
drop policy if exists pr_update_self on profiles;
create policy pr_update_self on profiles for update using (user_id = auth.uid());
drop policy if exists pr_update_admin on profiles;
create policy pr_update_admin on profiles for update using (my_role_in(workspace_id) = 'admin');
drop policy if exists pr_delete_admin on profiles;
create policy pr_delete_admin on profiles for delete using (my_role_in(workspace_id) = 'admin');

drop policy if exists cal_select on calendars;
create policy cal_select on calendars for select using (is_member(workspace_id));
drop policy if exists cal_write on calendars;
create policy cal_write on calendars for insert with check (my_role_in(workspace_id) = 'admin');
drop policy if exists cal_update on calendars;
create policy cal_update on calendars for update using (my_role_in(workspace_id) = 'admin');
drop policy if exists cal_delete on calendars;
create policy cal_delete on calendars for delete using (my_role_in(workspace_id) = 'admin');

drop policy if exists slot_select on slots;
create policy slot_select on slots for select using (
  exists (select 1 from calendars c where c.id = slots.calendar_id and is_member(c.workspace_id))
);
drop policy if exists slot_write on slots;
create policy slot_write on slots for insert with check (
  exists (select 1 from calendars c where c.id = calendar_id and my_role_in(c.workspace_id) = 'admin')
);
drop policy if exists slot_update on slots;
create policy slot_update on slots for update using (
  exists (select 1 from calendars c where c.id = slots.calendar_id and my_role_in(c.workspace_id) = 'admin')
);
drop policy if exists slot_delete on slots;
create policy slot_delete on slots for delete using (
  exists (select 1 from calendars c where c.id = slots.calendar_id and my_role_in(c.workspace_id) = 'admin')
);

drop policy if exists ex_select on extra_slots;
create policy ex_select on extra_slots for select using (
  exists (select 1 from calendars c where c.id = extra_slots.calendar_id and is_member(c.workspace_id))
);
drop policy if exists ex_insert on extra_slots;
create policy ex_insert on extra_slots for insert with check (
  exists (select 1 from calendars c where c.id = calendar_id and is_member(c.workspace_id))
);
drop policy if exists ex_insert_anon on extra_slots;
create policy ex_insert_anon on extra_slots for insert to anon with check (
  exists (
    select 1 from calendars c join guest_links g on g.workspace_id = c.workspace_id
    where c.id = calendar_id and g.expires_at > now()
  )
);
drop policy if exists ex_delete on extra_slots;
create policy ex_delete on extra_slots for delete using (
  exists (select 1 from calendars c where c.id = extra_slots.calendar_id and (
    is_my_profile(extra_slots.created_by) or my_role_in(c.workspace_id) = 'admin'
  ))
);

drop policy if exists gl_insert on guest_links;
create policy gl_insert on guest_links for insert with check (my_role_in(workspace_id) = 'admin');
drop policy if exists gl_delete on guest_links;
create policy gl_delete on guest_links for delete using (my_role_in(workspace_id) = 'admin');

drop policy if exists att_select on attendance;
create policy att_select on attendance for select using (
  exists (select 1 from slots s join calendars c on c.id = s.calendar_id where s.id = attendance.slot_id and is_member(c.workspace_id))
  or exists (select 1 from extra_slots e join calendars c on c.id = e.calendar_id where e.id = attendance.extra_slot_id and is_member(c.workspace_id))
);
drop policy if exists att_ins_self on attendance;
create policy att_ins_self on attendance for insert with check (is_my_profile(instructor_id));
drop policy if exists att_upd_self on attendance;
create policy att_upd_self on attendance for update using (is_my_profile(instructor_id));
drop policy if exists att_del_self on attendance;
create policy att_del_self on attendance for delete using (
  is_my_profile(instructor_id)
  or exists (select 1 from slots s join calendars c on c.id = s.calendar_id where s.id = attendance.slot_id and my_role_in(c.workspace_id) = 'admin')
  or exists (select 1 from extra_slots e join calendars c on c.id = e.calendar_id where e.id = attendance.extra_slot_id and my_role_in(c.workspace_id) = 'admin')
);

-- 4) le vecchie funzioni a workspace-singolo non servono più
drop function if exists my_workspace();
drop function if exists is_admin();

-- 5) garantisce che gli accessi rapidi (anon) possano leggere i profili (nomi istruttori)
grant select on profiles to anon;

-- ============================================================
-- Presencer — sostituzioni nelle richieste di assenza e rettifiche dei compensi.
-- Esegui in Supabase → SQL Editor → New query → Run, DOPO migration_ore_compensi.sql
-- (rieseguila anche lei: la funzione delle notifiche ora racconta le sostituzioni).
-- Rieseguibile: non modifica né cancella dati esistenti.
-- ============================================================

begin;

-- ---------- SOSTITUZIONI ----------
-- Chi chiede un'assenza può proporre un collega. Il collega accetta o rifiuta;
-- se accetta, il database lo segna presente a quella lezione.
alter table absence_requests add column if not exists substitute_id uuid references profiles(id) on delete set null;
alter table absence_requests add column if not exists substitute_status text;
alter table absence_requests drop constraint if exists ar_substitute_status_check;
alter table absence_requests add constraint ar_substitute_status_check check (
  (substitute_id is null and substitute_status is null)
  or (substitute_id is not null and substitute_status in ('proposta','accettata','rifiutata'))
);

-- Il sostituto può toccare la riga, ma solo per rispondere.
drop policy if exists ar_update_substitute on absence_requests;
create policy ar_update_substitute on absence_requests for update using (is_my_profile(substitute_id));

create or replace function guard_absence_substitute()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.substitute_id is not null then
    if new.substitute_id = new.instructor_id
       or not exists (select 1 from profiles p where p.id = new.substitute_id and p.workspace_id = new.workspace_id) then
      raise exception 'Il sostituto deve essere un altro membro dello spazio' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'INSERT' then
    if new.substitute_id is not null then new.substitute_status := 'proposta'; end if;
    return new;
  end if;
  if auth.uid() is not null and coalesce(my_role_in(old.workspace_id), '') <> 'admin'
     and not is_my_profile(old.instructor_id) then
    -- il sostituto cambia solo la propria risposta
    if (to_jsonb(new) - 'substitute_status') is distinct from (to_jsonb(old) - 'substitute_status')
       or new.substitute_status not in ('accettata','rifiutata') then
      raise exception 'Il sostituto può solo accettare o rifiutare' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_absence_substitute on absence_requests;
create trigger guard_absence_substitute before insert or update on absence_requests
  for each row execute function guard_absence_substitute();

-- Accettata = il sostituto risulta presente. Le presenze sono scrivibili solo dal
-- diretto interessato, quindi lo fa il database (come per l'assenza approvata).
create or replace function apply_accepted_substitute()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update attendance set status = 'presente'
    where instructor_id = new.substitute_id and date = new.date
      and slot_id is not distinct from new.slot_id
      and extra_slot_id is not distinct from new.extra_slot_id;
  if not found then
    insert into attendance (slot_id, extra_slot_id, instructor_id, date, status)
      values (new.slot_id, new.extra_slot_id, new.substitute_id, new.date, 'presente');
  end if;
  return new;
end;
$$;

drop trigger if exists apply_accepted_substitute on absence_requests;
create trigger apply_accepted_substitute after update of substitute_status on absence_requests
  for each row when (new.substitute_status = 'accettata' and old.substitute_status is distinct from 'accettata')
  execute function apply_accepted_substitute();

-- ---------- RETTIFICHE DEI COMPENSI ----------
-- Bonus, rimborsi o trattenute una tantum (importo negativo), scritti da un admin.
create table if not exists pay_adjustments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  date date not null,
  amount numeric(10,2) not null,
  note text not null,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz default now()
);
create index if not exists idx_pay_adjustments_ws_date on pay_adjustments (workspace_id, date);

alter table pay_adjustments enable row level security;
drop policy if exists pa_select on pay_adjustments;
create policy pa_select on pay_adjustments for select using (
  is_my_profile(profile_id) or my_role_in(workspace_id) = 'admin'
);
drop policy if exists pa_insert on pay_adjustments;
create policy pa_insert on pay_adjustments for insert with check (
  my_role_in(workspace_id) = 'admin'
  and exists (select 1 from profiles p where p.id = profile_id and p.workspace_id = pay_adjustments.workspace_id)
);
drop policy if exists pa_delete on pay_adjustments;
create policy pa_delete on pay_adjustments for delete using (my_role_in(workspace_id) = 'admin');
grant select, insert, delete on pay_adjustments to authenticated;

commit;

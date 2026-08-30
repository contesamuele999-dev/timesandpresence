-- ============================================================================
--  NOTIFICHE PUSH AD APP CHIUSA
--  Da eseguire in Supabase → SQL Editor DOPO migration_notifications.sql.
--
--  Cosa fa:
--   1. crea device_tokens: il "recapito" di ogni telefono (token FCM)
--   2. crea la funzione che, a ogni nuovo app_events, chiama la Edge Function
--      "send-push" che spedisce le notifiche
--
--  Tutto quello che serve sta nei piani gratuiti (Firebase Spark + Supabase Free).
-- ============================================================================

begin;

-- ---------- DEVICE TOKENS (un telefono può avere un token per ogni profilo) ----------
create table if not exists device_tokens (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null,
  platform text not null default 'android' check (platform in ('android','ios','web')),
  updated_at timestamptz not null default now(),
  unique (profile_id, token)
);

create index if not exists idx_device_tokens_profile on device_tokens (profile_id);

alter table device_tokens enable row level security;

-- Ognuno gestisce solo i propri dispositivi. La Edge Function li legge tutti
-- perché usa la service_role key, che ignora le policy.
drop policy if exists dt_select_self on device_tokens;
create policy dt_select_self on device_tokens for select
  using (user_id = auth.uid());

drop policy if exists dt_insert_self on device_tokens;
create policy dt_insert_self on device_tokens for insert
  with check (user_id = auth.uid() and is_my_profile(profile_id));

drop policy if exists dt_update_self on device_tokens;
create policy dt_update_self on device_tokens for update
  using (user_id = auth.uid());

drop policy if exists dt_delete_self on device_tokens;
create policy dt_delete_self on device_tokens for delete
  using (user_id = auth.uid());

grant select, insert, update, delete on device_tokens to authenticated;

-- ---------- CHIAMATA ALLA EDGE FUNCTION A OGNI NUOVO EVENTO ----------
-- pg_net invia la richiesta in modo asincrono: il trigger non rallenta mai
-- la scrittura che lo ha generato (salvare una presenza resta immediato).
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault cascade;

-- I due valori stanno nel Vault di Supabase, non in impostazioni del database:
-- su Supabase gestito il ruolo postgres non è superuser e "alter database ... set"
-- viene rifiutato con "permission denied to set parameter".
-- Vanno inseriti una volta sola, vedi la coda di questo file.
create or replace function notify_push_on_event()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  functions_url text;
  service_key   text;
begin
  select decrypted_secret into functions_url
    from vault.decrypted_secrets where name = 'push_functions_url';
  select decrypted_secret into service_key
    from vault.decrypted_secrets where name = 'push_service_role_key';

  -- Se i segreti non ci sono, l'app continua a funzionare senza push.
  if functions_url is null or service_key is null then
    return new;
  end if;

  perform net.http_post(
    url     := functions_url || '/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body    := jsonb_build_object('event_id', new.id),
    timeout_milliseconds := 5000
  );
  return new;
end;
$$;

drop trigger if exists trg_notify_push_on_event on app_events;
create trigger trg_notify_push_on_event
  after insert on app_events
  for each row execute function notify_push_on_event();

commit;

-- ============================================================================
--  DA ESEGUIRE A PARTE, UNA VOLTA SOLA
--  Sostituisci <SERVICE_ROLE_KEY> con la chiave presa da
--  Project Settings → API → service_role (quella lunga, "secret").
--
--  Rilanciare questo blocco è sicuro: cancella i valori vecchi e li riscrive.
-- ============================================================================
--
-- delete from vault.secrets where name in ('push_functions_url','push_service_role_key');
--
-- select vault.create_secret(
--   'https://xuhrhliwiocxrglhvfcj.supabase.co/functions/v1',
--   'push_functions_url',
--   'Indirizzo delle Edge Function per le notifiche push');
--
-- select vault.create_secret(
--   '<SERVICE_ROLE_KEY>',
--   'push_service_role_key',
--   'Chiave con cui il trigger chiama send-push');
--
--  Verifica (deve elencare entrambi i nomi):
--   select name from vault.secrets where name like 'push_%';

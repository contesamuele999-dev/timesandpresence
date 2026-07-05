-- ============================================================
-- Migrazione: rinomina/elimina spazi + foto profilo (account registrati)
-- Esegui questo file in Supabase → SQL Editor → New query → Run.
-- ============================================================

-- 1) mancava la policy di eliminazione per gli spazi (solo l'admin dello spazio può farlo)
drop policy if exists ws_delete on workspaces;
create policy ws_delete on workspaces for delete using (my_role_in(id) = 'admin');

-- 2) foto profilo
alter table profiles add column if not exists avatar_url text;

insert into storage.buckets (id, name, public) values ('avatars','avatars', true)
  on conflict (id) do nothing;

drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read on storage.objects for select using (bucket_id = 'avatars');
drop policy if exists avatars_owner_write on storage.objects;
create policy avatars_owner_write on storage.objects for insert to authenticated with check (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists avatars_owner_update on storage.objects;
create policy avatars_owner_update on storage.objects for update to authenticated using (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists avatars_owner_delete on storage.objects;
create policy avatars_owner_delete on storage.objects for delete to authenticated using (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
);

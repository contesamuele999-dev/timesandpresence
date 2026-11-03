-- ============================================================
-- Presencer — presenza ricorrente NON RETRIBUITA.
-- La ricorrenza può valere "presente ma fuori dai compensi" ogni settimana.
-- Esegui in Supabase → SQL Editor → New query → Run, DOPO migration_ore_compensi.sql.
-- Rieseguibile: non modifica né cancella dati esistenti.
-- ============================================================

alter table recurring_presence add column if not exists unpaid boolean not null default false;

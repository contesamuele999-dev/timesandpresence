-- ============================================================
-- Presencer — COMPENSO PIENO in compresenza.
-- Una presenza (di un giorno o ricorrente) può valere la tariffa intera anche
-- quando alla lezione ci sono altri istruttori o il maestro caposcuola.
-- Esegui in Supabase → SQL Editor → New query → Run, DOPO migration_recurring_unpaid.sql.
-- Rieseguibile: non modifica né cancella dati esistenti.
-- ============================================================

alter table attendance add column if not exists full_pay boolean not null default false;
alter table recurring_presence add column if not exists full_pay boolean not null default false;

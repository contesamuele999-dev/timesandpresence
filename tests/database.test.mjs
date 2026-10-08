import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const sqlFile = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const ids = {
  user: '00000000-0000-4000-8000-000000000001',
  other: '00000000-0000-4000-8000-000000000002',
  ws: '00000000-0000-4000-8000-000000000003',
  profile: '00000000-0000-4000-8000-000000000004',
  admin: '00000000-0000-4000-8000-000000000005',
  cal: '00000000-0000-4000-8000-000000000006',
  slot: '00000000-0000-4000-8000-000000000007',
};

test('schema, notifiche e permessi delle presenze su PostgreSQL', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  // Solo gli oggetti forniti dalla piattaforma sono sostituiti: tabelle, RLS e
  // trigger dell'app sono eseguiti dai veri file SQL su PostgreSQL in memoria.
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean);
    create table storage.objects (id uuid, bucket_id text, name text);
    create function storage.foldername(name text) returns text[] language sql as $$
      select string_to_array(name, '/')
    $$;
  `);
  await db.exec((await sqlFile('schema.sql')).replace('create extension if not exists pgcrypto;', ''));
  await db.exec(`
    grant usage on schema public, auth to authenticated, anon;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    insert into auth.users values ('${ids.user}'), ('${ids.other}');
    insert into workspaces (id, name, invite_code) values ('${ids.ws}', 'Test', 'TEST');
    insert into profiles (id, user_id, workspace_id, name, role) values
      ('${ids.profile}', '${ids.user}', '${ids.ws}', 'Istruttore test', 'instructor'),
      ('${ids.admin}', '${ids.other}', '${ids.ws}', 'Admin test', 'admin');
    insert into calendars (id, workspace_id, name) values ('${ids.cal}', '${ids.ws}', 'Test');
    insert into slots (id, calendar_id, weekday, start_time, end_time)
      values ('${ids.slot}', '${ids.cal}', 0, '09:00', '10:00');
  `);
  await db.exec(await sqlFile('migration_notifications.sql'));
  // L'aggiornamento è riapplicabile anche su un database già configurato.
  await db.exec(await sqlFile('migration_notifications.sql'));
  await db.exec(await sqlFile('migration_ore_compensi.sql'));
  await db.exec(await sqlFile('migration_ore_compensi.sql'));

  async function scenario(name, fn) {
    await t.test(name, async () => {
      await db.exec('begin');
      try { await fn(); } finally { await db.exec('rollback'); }
    });
  }
  async function asUser(user = ids.user) {
    await db.exec(`set local role authenticated; set local request.jwt.claim.sub = '${user}';`);
  }
  // Un errore atteso non deve invalidare il resto della transazione del caso.
  async function fails(sql, pattern) {
    await db.exec('savepoint atteso');
    await assert.rejects(db.query(sql), pattern);
    await db.exec('rollback to savepoint atteso');
  }
  const insertPresence = () => db.query(`
    insert into attendance (slot_id, instructor_id, date)
    values ($1, $2, '2026-08-24') returning *
  `, [ids.slot, ids.profile]);

  for (const promoted of [false, true]) {
    await scenario(`un ${promoted ? 'admin appena promosso' : 'istruttore'} salva, modifica e rimuove la propria presenza`, async () => {
      if (promoted) await db.exec(`update profiles set role = 'admin' where id = '${ids.profile}'`);
      await asUser();
      const { rows: [row] } = await insertPresence();
      const { rows: [updated] } = await db.query("update attendance set status = 'assente' where id = $1 returning *", [row.id]);
      assert.equal(updated.status, 'assente');
      const deleted = await db.query('delete from attendance where id = $1 returning id', [row.id]);
      assert.equal(deleted.rows.length, 1);
      const { rows } = await db.query("select action, actor_profile_id from app_events where category = 'attendance' order by id");
      assert.deepEqual(rows.map(event => event.action), ['insert', 'update', 'delete']);
      assert.ok(rows.every(event => event.actor_profile_id === ids.profile));
    });
  }

  await scenario('il ruolo admin non concede la modifica delle presenze altrui', async () => {
    const { rows: [row] } = await insertPresence();
    await asUser(ids.other);
    const result = await db.query("update attendance set status = 'assente' where id = $1 returning id", [row.id]);
    assert.equal(result.rows.length, 0);
  });

  await scenario('orari settimanali, lezioni extra, ricorrenze e registri generano notifiche', async () => {
    await db.exec(`set local request.jwt.claim.sub = '${ids.other}'`);
    await db.exec(`
      insert into slots (calendar_id, weekday, start_time, end_time) values ('${ids.cal}', 1, '18:30', '19:30');
      insert into extra_slots (calendar_id, date, start_time, end_time) values ('${ids.cal}', '2026-08-24', '10:15', '11:15');
      insert into recurring_presence (slot_id, instructor_id) values ('${ids.slot}', '${ids.profile}');
      insert into lesson_logs (slot_id, instructor_id, date, content) values ('${ids.slot}', '${ids.profile}', '2026-08-24', 'Test');
    `);
    const { rows } = await db.query('select category, body from app_events order by id');
    assert.deepEqual(rows.map(event => event.category), ['schedule', 'schedule', 'recurring', 'lesson_log']);
    assert.match(rows[0].body, /18:30$/);
    assert.match(rows[1].body, /10:15$/);
  });

  await scenario('la sola foto profilo non genera notifiche sui membri', async () => {
    await db.exec(`update profiles set avatar_url = 'https://example.test/avatar.png' where id = '${ids.profile}'`);
    assert.equal((await db.query('select * from app_events')).rows.length, 0);
  });

  await scenario('un istruttore non può darsi ruolo admin o grado maestro', async () => {
    await asUser();
    await fails(`update profiles set role = 'admin' where id = '${ids.profile}'`, /amministratore/);
    await fails(`update profiles set grade = 'maestro' where id = '${ids.profile}'`, /amministratore/);
    await db.query(`update profiles set name = 'Nuovo nome' where id = '${ids.profile}'`);
  });

  await scenario('forfait: importo riservato, modo deciso solo da un admin', async () => {
    await asUser();
    await fails(`update profiles set pay_mode = 'forfait' where id = '${ids.profile}'`, /amministratore/);
    await fails(`insert into pay_forfaits (profile_id, workspace_id, monthly_amount) values ('${ids.profile}', '${ids.ws}', 500)`, /row-level security/);
    await asUser(ids.other);
    await db.query(`update profiles set pay_mode = 'forfait' where id = '${ids.profile}'`);
    await db.query(`insert into pay_forfaits (profile_id, workspace_id, monthly_amount) values ('${ids.profile}', '${ids.ws}', 500), ('${ids.admin}', '${ids.ws}', 900)`);
    await asUser();
    const { rows } = await db.query('select profile_id, monthly_amount from pay_forfaits');
    assert.deepEqual(rows.map(r => r.profile_id), [ids.profile]);
  });

  await scenario('un admin assegna il grado maestro', async () => {
    await asUser(ids.other);
    const { rows } = await db.query(`update profiles set grade = 'maestro' where id = '${ids.profile}' returning grade`);
    assert.equal(rows[0].grade, 'maestro');
  });

  await scenario('richiesta di assenza: avvisa tutti e, approvata, segna assente', async () => {
    await asUser();
    const { rows: [request] } = await db.query(`
      insert into absence_requests (workspace_id, slot_id, instructor_id, date, reason)
      values ($1, $2, $3, '2026-08-24', 'Visita medica') returning *`, [ids.ws, ids.slot, ids.profile]);
    // l'istruttore non può approvarsi da solo
    const self = await db.query("update absence_requests set status = 'approvata' where id = $1 returning id", [request.id]);
    assert.equal(self.rows.length, 0);
    await asUser(ids.other);
    await db.query("update absence_requests set status = 'approvata', decided_by = $2 where id = $1", [request.id, ids.admin]);
    const { rows: [presence] } = await db.query('select status from attendance where instructor_id = $1', [ids.profile]);
    assert.equal(presence.status, 'assente');
    const { rows } = await db.query("select category, title from app_events order by id");
    assert.deepEqual(rows.map(e => e.title), ['Richiesta di assenza', 'Assenza approvata']);
    assert.ok(rows.every(e => e.category === 'absence'));
  });

  await scenario('solo un admin annulla una lezione in una data', async () => {
    await asUser();
    await fails(`insert into lesson_cancellations (slot_id, date) values ('${ids.slot}', '2026-08-24')`, /row-level security/);
    await asUser(ids.other);
    await db.query(`insert into lesson_cancellations (slot_id, date) values ('${ids.slot}', '2026-08-24')`);
    const { rows } = await db.query('select title from app_events');
    assert.deepEqual(rows.map(e => e.title), ['Lezione annullata']);
  });

  await scenario('una ricorrenza chiusa resta nello storico e se ne può aprire una nuova', async () => {
    await asUser();
    await db.exec(`
      insert into recurring_presence (slot_id, instructor_id) values ('${ids.slot}', '${ids.profile}');
      update recurring_presence set ended_on = '2026-08-24';
      insert into recurring_presence (slot_id, instructor_id) values ('${ids.slot}', '${ids.profile}');
    `);
    assert.equal((await db.query('select * from recurring_presence')).rows.length, 2);
    await fails(`insert into recurring_presence (slot_id, instructor_id) values ('${ids.slot}', '${ids.profile}')`, /duplicate key/);
  });

  await scenario('gli altri trigger funzionano anche in UPDATE e DELETE', async () => {
    await db.exec(`
      insert into recurring_presence (slot_id, instructor_id) values ('${ids.slot}', '${ids.profile}');
      update recurring_presence set status = 'assente';
      delete from recurring_presence;
      insert into lesson_logs (slot_id, instructor_id, date, content) values ('${ids.slot}', '${ids.profile}', '2026-08-24', 'Prima');
      update lesson_logs set content = 'Dopo';
      delete from lesson_logs;
      insert into extra_slots (calendar_id, date, start_time, end_time) values ('${ids.cal}', '2026-08-24', '10:15', '11:15');
      update extra_slots set label = 'Extra modificata';
      delete from extra_slots;
      insert into calendar_periods (workspace_id, calendar_id, start_date) values ('${ids.ws}', '${ids.cal}', '2026-08-24');
      update calendar_periods set start_date = '2026-08-25';
      delete from calendar_periods;
      update slots set label = 'Orario modificato';
      delete from slots;
      update calendars set name = 'Calendario modificato';
      delete from calendars;
    `);
    const { rows } = await db.query('select category, action from app_events order by id');
    assert.equal(rows.length, 16);
    assert.equal(rows.filter(event => event.action === 'delete').length, 6);
  });
});

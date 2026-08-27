import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { mockClient } from './helpers/mock-client.mjs';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const profile = { id: 'profile', user_id: 'auth-user', workspace_id: 'ws', name: 'Test', role: 'instructor' };
const slot = { id: 'slot', calendar_id: 'cal', weekday: 0, start_time: '09:00', end_time: '10:00', label: 'Test' };
const ref = { slot_id: slot.id };
const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function appWith(respond = () => ({ data: [] })) {
  const calls = [];
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const app = vm.createContext({
    document: { getElementById: () => ({}), addEventListener() {}, visibilityState: 'visible' },
    window: { addEventListener() {} }, navigator: { onLine: true },
    localStorage: storage, sessionStorage: storage, setTimeout: () => 0,
    console: { error() {}, warn() {} }, URLSearchParams, Date,
    mock: mockClient(request => { calls.push(request); return respond(request); }),
  });
  vm.runInContext(source.replace(/boot\(\);\s*$/, '') + '\nrender = ()=>{}; sb = mock;', app);
  const S = vm.runInContext('S', app);
  Object.assign(S, {
    view: 'app', session: { user: { id: 'auth-user' } }, profile: { ...profile },
    myProfiles: [{ ...profile }], workspace: { id: 'ws', active_calendar_id: 'cal' },
    calendars: [{ id: 'cal', name: 'Test' }], slots: [slot],
  });
  return { app, S, calls, date: app.toISO(app.mondayOf(0)) };
}

test('un doppio tocco invia un solo INSERT e non usa UUID temporanei', async () => {
  const pending = deferred();
  const { app, S, calls, date } = appWith(() => pending.promise);
  const first = app.cycleAttendance(ref, date);
  const second = app.cycleAttendance(ref, date);
  await flush();
  assert.equal(S.presenceSaving, true);
  assert.equal(S.attendance.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'insert');
  assert.equal(calls[0].payload.instructor_id, 'profile');
  pending.resolve({ data: { id: 'saved', ...calls[0].payload } });
  await Promise.all([first, second]);
  assert.equal(S.attendance[0].id, 'saved');
  assert.equal(S.presenceSaving, false);
});

test('ciclo completo: non segnato → presente → assente → non segnato', async () => {
  const { app, S, calls, date } = appWith(request => ({ data: { id: 'saved', ...request.payload, slot_id: 'slot', instructor_id: 'profile', date } }));
  await app.cycleAttendance(ref, date);
  assert.equal(app.myAttendanceState(ref, date), 'presente');
  await app.cycleAttendance(ref, date);
  assert.equal(app.myAttendanceState(ref, date), 'assente');
  await app.cycleAttendance(ref, date);
  assert.equal(S.attendance.length, 0);
  assert.deepEqual(calls.map(q => q.operation), ['insert', 'update', 'delete']);
  assert.ok(calls.every(q => q.single));
});

test('UPDATE senza riga restituita non viene mostrato come salvato', async () => {
  const { app, S, calls, date } = appWith(() => ({ data: null }));
  S.attendance = [{ id: 'saved', ...ref, instructor_id: 'profile', date, status: 'presente' }];
  assert.equal(await app.cycleAttendance(ref, date), false);
  assert.equal(S.attendance[0].status, 'presente');
  assert.equal(S.dataError.code, 'PGRST116');
  assert.equal(S.presenceNeedsRefresh, true);
  await app.cycleAttendance(ref, date);
  assert.equal(calls.length, 1, 'serve una rilettura prima di riprovare');
});

test('errore del trigger: messaggio specifico e nessuna modifica locale', async () => {
  const { app, S, date } = appWith(() => ({ error: { code: '42703', message: 'record "new" has no field "name"' } }));
  await app.cycleAttendance(ref, date);
  assert.equal(S.attendance.length, 0);
  assert.match(S.dataError.message, /migration_notifications.sql/);
  assert.equal(S.presenceSaving, false);
});

test('rete interrotta: la richiesta rifiutata non lascia il salvataggio bloccato', async () => {
  const { app, S, date } = appWith(() => { throw new TypeError('Failed to fetch'); });
  await app.cycleAttendance(ref, date);
  assert.equal(S.presenceSaving, false);
  assert.equal(S.presenceNeedsRefresh, true);
  assert.match(S.dataError.message, /Connessione/);
});

test('offline e link ospite scaduto sono fermati prima della scrittura', async () => {
  for (const guest of [false, true]) {
    const { app, S, calls, date } = appWith();
    if (guest) S.guest = { token: 'test-token', expires_at: '2020-01-01' };
    else app.navigator.onLine = false;
    await app.cycleAttendance(ref, date);
    assert.equal(calls.length, 0);
    assert.match(S.dataError.message, guest ? /scaduto/ : /Connessione/);
  }
});

test('ricorrenza ed eccezione mantengono lo stato precedente fino alla conferma', async () => {
  const pending = deferred();
  const { app, S, calls, date } = appWith(() => pending.promise);
  S.recurring = [{ id: 'rec', slot_id: 'slot', instructor_id: 'profile', status: 'presente' }];
  const saving = app.toggleRecurring(ref, 'slot', date);
  await app.cycleAttendance(ref, date);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(S.recurring.length, 1);
  pending.resolve({ data: { id: 'rec' } });
  await saving;
  assert.equal(S.recurring.length, 0);
});

test('una scrittura completata dopo un cambio spazio non contamina il nuovo spazio', async () => {
  const pending = deferred();
  const { app, S, date } = appWith(() => pending.promise);
  const saving = app.cycleAttendance(ref, date);
  S.workspace = { id: 'another-workspace' };
  pending.resolve({ data: { id: 'saved', ...ref, date, status: 'presente' } });
  await saving;
  assert.equal(S.attendance.length, 0);
});

test('caricamenti sovrapposti: vince l’ultima settimana richiesta', async () => {
  const firstSlots = deferred();
  let slotReads = 0;
  const { app, S } = appWith(request => {
    if (request.table === 'slots') return ++slotReads === 1 ? firstSlots.promise : { data: [{ ...slot, id: 'latest' }] };
    return { data: [] };
  });
  const first = app.refreshWeekData();
  await flush();
  S.weekOffset++;
  await app.refreshWeekData();
  firstSlots.resolve({ data: [{ ...slot, id: 'stale' }] });
  await first;
  assert.equal(S.slots[0].id, 'latest');
  assert.equal(S.weekLoading, false);
});

test('un errore di lettura non trasforma presenze esistenti in una settimana vuota', async () => {
  const { app, S } = appWith(request => request.table === 'slots' ? { error: { code: '42501' } } : { data: [] });
  S.attendance = [{ id: 'existing' }];
  assert.equal(await app.refreshWeekData(), false);
  assert.equal(S.attendance[0].id, 'existing');
  assert.equal(S.weekLoadFailed, true);
  assert.equal(app.presenceControlsDisabled(), true);
});

test('promozione e revoca aggiornano il profilo attivo e le schede disponibili', async () => {
  let role = 'admin';
  const { app, S } = appWith(() => ({ data: [{ ...profile, role }] }));
  await app.loadInstructors();
  assert.equal(app.isAdmin(), true);
  assert.equal(S.myProfiles[0].role, 'admin');
  S.tab = 'calendari';
  role = 'instructor';
  await app.loadInstructors();
  assert.equal(app.isAdmin(), false);
  assert.equal(S.tab, 'presenze');
});

test('una promozione negata da RLS non annuncia il successo', async () => {
  const { app, S } = appWith(() => ({ data: null }));
  S.profile.role = 'admin';
  await app.setInstructorRole('other', 'admin');
  assert.equal(S.toast, '');
  assert.equal(S.dataError.action, 'Cambio ruolo');
});

test('Aggiorna dati recupera ruolo e presenze e sblocca una scrittura fallita', async () => {
  const { app, S } = appWith(request => ({ data: request.table === 'profiles' ? [{ ...profile, role: 'admin' }] : request.table === 'calendars' ? [{ id: 'cal' }] : request.table === 'slots' ? [slot] : [] }));
  S.presenceNeedsRefresh = true;
  S.dataError = { code: '23505' };
  await app.refreshCurrentData();
  assert.equal(S.profile.role, 'admin');
  assert.equal(S.presenceNeedsRefresh, false);
  assert.equal(S.dataError, null);
  assert.equal(app.presenceControlsDisabled(), false);
});

test('una lezione extra altrui non viene eliminata da un istruttore', async () => {
  const { app, S, calls } = appWith();
  S.extraSlots = [{ id: 'extra', created_by: 'other' }];
  assert.equal(await app.deleteExtraSlot('extra'), false);
  assert.equal(calls.length, 0);
  assert.equal(S.extraSlots.length, 1);
});

test('la cancellazione di una lezione extra è applicata solo dopo conferma del server', async () => {
  const { app, S } = appWith(() => ({ data: { id: 'extra' } }));
  S.extraSlots = [{ id: 'extra', created_by: 'profile' }];
  S.attendance = [{ id: 'presence', extra_slot_id: 'extra' }, { id: 'other', slot_id: 'slot' }];
  await app.deleteExtraSlot('extra');
  assert.equal(S.extraSlots.length, 0);
  assert.equal(S.attendance.length, 1);
  assert.equal(S.attendance[0].id, 'other');
});

import { mockClient } from './helpers/mock-client.mjs';

const profile = { id: 'profile-test', user_id: 'user-test', workspace_id: 'ws-test', name: 'Utente di prova', role: 'instructor' };
const db = {
  profiles: [profile, { id: 'other-test', user_id: 'other-user', workspace_id: 'ws-test', name: 'Secondo istruttore', role: 'admin' }],
  workspaces: [{ id: 'ws-test', name: 'Spazio di prova · dati fittizi', active_calendar_id: 'cal-test' }],
  calendars: [{ id: 'cal-test', workspace_id: 'ws-test', name: 'Calendario di prova', period: 'estate' }],
  slots: [0, 2, 4].map(weekday => ({ id: `slot-${weekday}`, calendar_id: 'cal-test', weekday, start_time: '18:00', end_time: '19:00', label: 'Lezione di prova' })),
  attendance: [], recurring_presence: [], extra_slots: [], lesson_logs: [],
  calendar_periods: [], notification_preferences: [], app_events: [],
};
let failNextWrite = false;
let eventListener;
const client = mockClient(async request => {
  if (request.operation !== 'select') {
    await new Promise(resolve => setTimeout(resolve, 1200));
    if (failNextWrite) {
      failNextWrite = false;
      return { error: { code: '42703', message: 'record "new" has no field "name"' } };
    }
  }
  const rows = db[request.table] || [];
  const selected = rows.filter(row => request.filters.every(({ operator, column, value }) => {
    if (operator === 'eq') return row[column] === value;
    if (operator === 'in') return value.includes(row[column]);
    if (operator === 'gte') return row[column] >= value;
    if (operator === 'lte') return row[column] <= value;
    return row[column] > value;
  }));
  let result = selected;
  if (request.operation === 'insert') {
    const row = { id: crypto.randomUUID(), ...request.payload };
    rows.push(row);
    result = [row];
  }
  if (request.operation === 'update') selected.forEach(row => Object.assign(row, request.payload));
  if (request.operation === 'delete') db[request.table] = rows.filter(row => !selected.includes(row));
  if (request.single && result.length !== 1) return { error: { code: 'PGRST116' } };
  return { data: structuredClone(request.single || request.maybeSingle ? result[0] || null : result) };
});
client.auth = {
  onAuthStateChange() {},
  getSession: async () => ({ data: { session: { user: { id: 'user-test', email: 'test@example.invalid' } } } }),
};
client.channel = () => ({
  on(_type, _options, listener) { eventListener = listener; return this; },
  subscribe() { return this; },
});
client.removeChannel = async () => {};
window.SUPABASE_URL = 'https://example.invalid';
window.SUPABASE_ANON_KEY = 'only-a-test';
window.supabase = { createClient: () => client };

const controls = document.createElement('aside');
controls.style.cssText = 'position:sticky;top:0;z-index:100;background:#fff9dd;padding:10px;display:flex;gap:12px;flex-wrap:wrap';
controls.innerHTML = '<b>TEST LOCALE · nessun dato reale</b><button id="fail-test">Simula errore al prossimo salvataggio</button><button id="role-test">Simula promozione ad admin</button>';
document.body.prepend(controls);
controls.querySelector('#fail-test').onclick = () => { failNextWrite = true; };
controls.querySelector('#role-test').onclick = () => {
  profile.role = 'admin';
  eventListener?.({ new: { id: 1, workspace_id: 'ws-test', category: 'members', metadata: { record_id: profile.id }, actor_profile_id: 'other-test' } });
};
const script = document.createElement('script');
script.src = '/app.js';
document.body.appendChild(script);

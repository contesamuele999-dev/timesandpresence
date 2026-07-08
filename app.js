/* ============================================================
   Presencer — app.js
   App single-tenant-per-workspace, generica (palestra/azienda/famiglia).
   Nessun framework: stato globale S + render() che ridisegna #app.
   ============================================================ */

const APP = document.getElementById('app');
const WEEKDAYS = ['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
const MONTHS = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
const PERIOD_LABEL = {estate:'Estate', inverno:'Inverno', extra:'Extra', personalizzato:'Personalizzato'};

let sb = null;
const S = {
  view: 'loading',      // loading | setup | auth | guestname | app
  authTab: 'login',     // login | register | join
  authErr: '',
  busy: false,

  session: null,
  profile: null,        // {id, user_id, workspace_id, name, role, color} — profilo nello spazio ATTIVO
  workspace: null,      // {id, name, invite_code, active_calendar_id}
  myProfiles: [],       // tutti i profili (uno per spazio) dell'utente loggato
  myWorkspaces: [],     // {id,name} degli spazi corrispondenti a myProfiles

  guest: null,          // {token, name, workspace_id, expires_at} quando accesso rapido
  pendingGuestToken: null,

  tab: 'presenze',      // presenze | calendari | istruttori | profilo
  calendars: [],
  selectedCalendarId: null,
  weekOffset: 0,
  navDir: null,          // 'next' | 'prev' | null — direzione per l'animazione di cambio settimana
  slots: [],
  extraSlots: [],
  attendance: [],
  recurring: [],
  showAllMatrix: false,

  instructors: [],
  guestLinks: [],

  modal: null,          // {type, ...data}
  toast: '',
};

function toast(msg){
  S.toast = msg;
  render();
  setTimeout(()=>{ if(S.toast===msg){ S.toast=''; render(); } }, 2600);
}

function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function genCode(len){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out=''; for(let i=0;i<len;i++) out+=chars[Math.floor(Math.random()*chars.length)];
  return out;
}
function colorFor(str){
  let h=0; for(let i=0;i<str.length;i++) h = (h*31 + str.charCodeAt(i))|0;
  return `hsl(${Math.abs(h)%360} 62% 45%)`;
}
function genToken(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g,'');
  return genCode(10)+Date.now().toString(36);
}

/* ---------------- date helpers ---------------- */
function pad2(n){ return String(n).padStart(2,'0'); }
function toISO(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function mondayOf(offsetWeeks){
  const now = new Date();
  const monIdx = (now.getDay()+6)%7; // 0=lun
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate()-monIdx + offsetWeeks*7);
  return mon;
}
function weekDates(monday){
  const out=[];
  for(let i=0;i<7;i++){ const d=new Date(monday); d.setDate(monday.getDate()+i); out.push(d); }
  return out;
}
function fmtDayShort(d){ return `${d.getDate()} ${MONTHS[d.getMonth()]}`; }
function fmtRange(monday){
  const sun = new Date(monday); sun.setDate(monday.getDate()+6);
  return `${monday.getDate()} ${MONTHS[monday.getMonth()]} – ${sun.getDate()} ${MONTHS[sun.getMonth()]}`;
}
function todayISO(){ return toISO(new Date()); }
function fmtHM(t){ return t ? t.slice(0,5) : ''; }

/* ---------------- boot ---------------- */
function boot(){
  if(!window.SUPABASE_URL || window.SUPABASE_URL.indexOf('INCOLLA_QUI') === 0){
    S.view='setup'; render(); return;
  }
  sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  const params = new URLSearchParams(location.search);
  const g = params.get('g');
  if(g){
    S.pendingGuestToken = g;
    const saved = localStorage.getItem('guest_'+g);
    if(saved){
      try{ S.guest = JSON.parse(saved); enterGuestApp(); return; }catch(e){}
    }
    S.view='guestname';
    validateGuestToken(g);
    return;
  }

  sb.auth.onAuthStateChange((event, session)=>{
    if(event==='TOKEN_REFRESHED' || event==='USER_UPDATED') { S.session=session; return; }
    if(event==='SIGNED_OUT'){ S.session=null; S.profile=null; S.workspace=null; S.view='auth'; render(); return; }
    if(session && (!S.session || S.session.user.id!==session.user.id)){
      S.session=session; handleSignedIn();
    }
  });

  sb.auth.getSession().then(({data})=>{
    if(data.session){ S.session=data.session; handleSignedIn(); }
    else { S.view='auth'; render(); }
  });
}

async function handleSignedIn(){
  try{
    const uid = S.session.user.id;
    await loadMyProfiles();
    if(!S.myProfiles.length){ S.view='auth'; S.authErr='Profilo non trovato. Contatta chi gestisce lo spazio.'; render(); return; }
    const remembered = localStorage.getItem('activeWs_'+uid);
    const chosen = S.myProfiles.find(p=>p.workspace_id===remembered) || S.myProfiles[0];
    await activateProfile(chosen, 'login');
  }catch(err){
    console.error(err);
    S.view='auth'; S.authErr='Errore di caricamento. Riprova.'; render();
  }
}

async function loadMyProfiles(){
  const uid = S.session.user.id;
  const {data:profs, error} = await sb.from('profiles').select('*').eq('user_id', uid).order('created_at');
  if(error) throw error;
  S.myProfiles = profs || [];
  if(S.myProfiles.length){
    const ids = S.myProfiles.map(p=>p.workspace_id);
    const {data:wss} = await sb.from('workspaces').select('id,name').in('id', ids);
    S.myWorkspaces = wss || [];
  } else {
    S.myWorkspaces = [];
  }
}

async function activateProfile(prof, reason){
  S.profile = prof;
  const {data:ws, error} = await sb.from('workspaces').select('*').eq('id', prof.workspace_id).maybeSingle();
  if(error){ toast('Errore caricamento spazio.'); return; }
  S.workspace = ws;
  S.selectedCalendarId = ws.active_calendar_id || null;
  S.weekOffset = 0;
  S.tab = 'presenze';
  S.calendars = []; S.slots = []; S.extraSlots = []; S.attendance = []; S.recurring = []; S.instructors = []; S.guestLinks = [];
  localStorage.setItem('activeWs_'+S.session.user.id, prof.workspace_id);
  S.view='app';
  render();
  await loadCalendars();
  await applyScheduledCalendarIfDue();
  if(!S.selectedCalendarId && S.calendars.length) S.selectedCalendarId = S.calendars[0].id;
  await loadInstructors();
  await refreshWeekData();
  if(reason==='login' && S.myProfiles.length>1) toast(`Sei in "${ws.name}" — tocca il nome in alto per cambiare spazio.`);
  else if(reason==='switch') toast(`Passato a "${ws.name}".`);
  else if(reason==='created') toast(`Nuovo spazio "${ws.name}" creato.`);
  else if(reason==='joined') toast(`Sei entrato in "${ws.name}".`);
}

/* ---------------- guest flow ---------------- */
async function validateGuestToken(token){
  render();
  const {data, error} = await sb.from('guest_links').select('*').eq('token', token).maybeSingle();
  if(error || !data || new Date(data.expires_at) < new Date()){
    S.view='setup';
    S.setupMsg = 'Questo link di accesso rapido non è valido o è scaduto. Chiedi un nuovo link a chi gestisce lo spazio.';
    render();
    return;
  }
  S._guestLinkRow = data;
  render();
}

function submitGuestName(name){
  name = name.trim();
  if(!name) return;
  const row = S._guestLinkRow;
  S.guest = {token: row.token, name, workspace_id: row.workspace_id, expires_at: row.expires_at};
  localStorage.setItem('guest_'+row.token, JSON.stringify(S.guest));
  enterGuestApp();
}

async function enterGuestApp(){
  const {data:ws} = await sb.from('workspaces').select('*').eq('id', S.guest.workspace_id).maybeSingle();
  S.workspace = ws;
  S.selectedCalendarId = ws ? ws.active_calendar_id : null;
  S.view='app'; S.tab='presenze';
  render();
  await loadCalendars();
  if(!S.selectedCalendarId && S.calendars.length) S.selectedCalendarId = S.calendars[0].id;
  await loadInstructors();
  await refreshWeekData();
}

function guestLogout(){
  localStorage.removeItem('guest_'+S.guest.token);
  location.href = location.pathname;
}

/* ---------------- auth actions ---------------- */
async function doLogin(email, password){
  S.busy=true; S.authErr=''; render();
  const {error} = await sb.auth.signInWithPassword({email, password});
  S.busy=false;
  if(error){ S.authErr = 'Accesso non riuscito: controlla email e password.'; render(); }
}

async function doRegisterWorkspace(name, wsName, email, password){
  S.busy=true; S.authErr=''; render();
  const {data, error} = await sb.auth.signUp({email, password});
  if(error){ S.busy=false; S.authErr = error.message.includes('already') ? 'Email già registrata.' : 'Registrazione non riuscita.'; render(); return; }
  if(!data.session){
    S.busy=false;
    S.authTab='login';
    S.authErr = 'Account creato! Se richiesta, conferma la mail poi accedi. Se il tuo spazio richiede conferma email, chiedi all\'amministratore di disattivarla nelle impostazioni Supabase per un accesso più semplice.';
    render(); return;
  }
  S.session = data.session;
  const code = genCode(6);
  const {data:ws, error:e2} = await sb.from('workspaces').insert({name: wsName, invite_code: code}).select().single();
  if(e2){ S.busy=false; S.authErr='Errore creazione spazio.'; render(); return; }
  const {error:e3} = await sb.from('profiles').insert({user_id: data.session.user.id, workspace_id: ws.id, name, role:'admin'});
  S.busy=false;
  if(e3){ S.authErr='Errore creazione profilo.'; render(); return; }
  await handleSignedIn();
}

async function doJoin(name, code, email, password){
  S.busy=true; S.authErr=''; render();
  const {data:ws, error:e1} = await sb.from('workspaces').select('*').eq('invite_code', code.trim().toUpperCase()).maybeSingle();
  if(e1 || !ws){ S.busy=false; S.authErr='Codice invito non valido.'; render(); return; }
  const {data, error} = await sb.auth.signUp({email, password});
  if(error){ S.busy=false; S.authErr = error.message.includes('already') ? 'Email già registrata.' : 'Registrazione non riuscita.'; render(); return; }
  if(!data.session){
    S.busy=false; S.authTab='login';
    S.authErr = 'Account creato! Conferma la mail (se richiesto) poi accedi.';
    render(); return;
  }
  S.session = data.session;
  const {error:e3} = await sb.from('profiles').insert({user_id: data.session.user.id, workspace_id: ws.id, name, role:'instructor'});
  S.busy=false;
  if(e3){ S.authErr='Errore creazione profilo.'; render(); return; }
  await handleSignedIn();
}

/* ---------------- gestione più spazi per lo stesso account ---------------- */
async function createAdditionalWorkspace(name){
  if(!name){ toast('Inserisci un nome.'); return; }
  const code = genCode(6);
  const {data:ws, error} = await sb.from('workspaces').insert({name, invite_code:code}).select().single();
  if(error){ toast('Errore creazione spazio.'); return; }
  const {error:e2} = await sb.from('profiles').insert({user_id:S.session.user.id, workspace_id:ws.id, name:S.profile.name, role:'admin'});
  if(e2){ toast('Errore creazione profilo.'); return; }
  const {data:prof, error:e3} = await sb.from('profiles').select('*').eq('user_id', S.session.user.id).eq('workspace_id', ws.id).single();
  if(e3){ toast('Errore lettura profilo.'); return; }
  S.myProfiles.push(prof);
  S.myWorkspaces.push({id:ws.id, name:ws.name});
  closeModal();
  await activateProfile(prof, 'created');
}

async function joinAdditionalWorkspace(code){
  if(!code){ toast('Inserisci un codice.'); return; }
  const {data:ws, error:e1} = await sb.from('workspaces').select('*').eq('invite_code', code.trim().toUpperCase()).maybeSingle();
  if(e1 || !ws){ toast('Codice invito non valido.'); return; }
  const already = S.myProfiles.find(p=>p.workspace_id===ws.id);
  if(already){ closeModal(); await activateProfile(already, 'switch'); return; }
  const {error:e2} = await sb.from('profiles').insert({user_id:S.session.user.id, workspace_id:ws.id, name:S.profile.name, role:'instructor'});
  if(e2){ toast('Errore.'); return; }
  const {data:prof, error:e3} = await sb.from('profiles').select('*').eq('user_id', S.session.user.id).eq('workspace_id', ws.id).single();
  if(e3){ toast('Errore lettura profilo.'); return; }
  S.myProfiles.push(prof);
  S.myWorkspaces.push({id:ws.id, name:ws.name});
  closeModal();
  await activateProfile(prof, 'joined');
}

async function uploadAvatar(file){
  if(!file.type.startsWith('image/')){ toast('Scegli un\'immagine.'); return; }
  if(file.size > 5*1024*1024){ toast('Immagine troppo grande (max 5MB).'); return; }
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${S.session.user.id}/avatar.${ext}`;
  toast('Caricamento foto...');
  const {error} = await sb.storage.from('avatars').upload(path, file, {upsert:true, cacheControl:'3600'});
  if(error){ toast('Errore caricamento foto.'); return; }
  const {data} = sb.storage.from('avatars').getPublicUrl(path);
  const url = data.publicUrl + '?t=' + Date.now();
  const {error:e2} = await sb.from('profiles').update({avatar_url:url}).eq('user_id', S.session.user.id);
  if(e2){ toast('Errore salvataggio foto.'); return; }
  S.profile.avatar_url = url;
  S.myProfiles.forEach(p=>{ if(p.user_id===S.session.user.id) p.avatar_url = url; });
  if(S.instructors.length){
    const me = S.instructors.find(p=>p.id===S.profile.id);
    if(me) me.avatar_url = url;
  }
  toast('Foto profilo aggiornata.');
  render();
}

async function doChangeEmail(newEmail){
  if(!newEmail){ toast('Inserisci una nuova email.'); return; }
  const {error} = await sb.auth.updateUser({email: newEmail});
  if(error){ toast('Errore: '+error.message); return; }
  toast('Email aggiornata (controlla la posta se ti viene chiesta una conferma).');
}

async function doChangePassword(pass1, pass2){
  if(!pass1 || pass1.length<6){ toast('La password deve avere almeno 6 caratteri.'); return; }
  if(pass1!==pass2){ toast('Le due password non coincidono.'); return; }
  const {error} = await sb.auth.updateUser({password: pass1});
  if(error){ toast('Errore: '+error.message); return; }
  toast('Password aggiornata.');
}

async function doLogout(){
  await sb.auth.signOut();
  S.profile=null; S.workspace=null; S.view='auth'; S.tab='presenze';
  render();
}

/* ---------------- data loaders ---------------- */
async function loadCalendars(){
  const wsId = S.workspace.id;
  const {data} = await sb.from('calendars').select('*').eq('workspace_id', wsId).order('created_at');
  S.calendars = data || [];
  render();
}

async function loadSlots(){
  if(!S.selectedCalendarId){ S.slots=[]; return; }
  const {data} = await sb.from('slots').select('*').eq('calendar_id', S.selectedCalendarId).order('weekday').order('start_time');
  S.slots = data || [];
}

async function loadExtraForWeek(monday){
  if(!S.selectedCalendarId){ S.extraSlots=[]; return; }
  const dates = weekDates(monday);
  const from = toISO(dates[0]), to = toISO(dates[6]);
  const {data} = await sb.from('extra_slots').select('*').eq('calendar_id', S.selectedCalendarId).gte('date', from).lte('date', to).order('date').order('start_time');
  S.extraSlots = data || [];
}

async function loadAttendanceForWeek(monday){
  const dates = weekDates(monday);
  const from = toISO(dates[0]), to = toISO(dates[6]);
  const slotIds = S.slots.map(s=>s.id);
  const extraIds = S.extraSlots.map(s=>s.id);
  let rows = [];
  if(slotIds.length){
    const {data} = await sb.from('attendance').select('*').in('slot_id', slotIds).gte('date', from).lte('date', to);
    rows = rows.concat(data||[]);
  }
  if(extraIds.length){
    const {data} = await sb.from('attendance').select('*').in('extra_slot_id', extraIds).gte('date', from).lte('date', to);
    rows = rows.concat(data||[]);
  }
  S.attendance = rows;
}

async function loadRecurring(){
  const slotIds = S.slots.map(s=>s.id);
  if(!slotIds.length || isGuest()){ S.recurring = []; return; }
  const {data} = await sb.from('recurring_presence').select('*').in('slot_id', slotIds);
  S.recurring = data || [];
}

async function refreshWeekData(){
  await loadSlots();
  await loadRecurring();
  const monday = mondayOf(S.weekOffset);
  await loadExtraForWeek(monday);
  await loadAttendanceForWeek(monday);
  render();
}

async function loadInstructors(){
  const {data} = await sb.from('profiles').select('*').eq('workspace_id', S.workspace.id).order('role').order('name');
  S.instructors = data || [];
  render();
}

async function loadGuestLinks(){
  const {data} = await sb.from('guest_links').select('*').eq('workspace_id', S.workspace.id).order('created_at', {ascending:false});
  S.guestLinks = (data||[]).filter(g => new Date(g.expires_at) > new Date());
  render();
}

/* ---------------- who am I (per attendance) ---------------- */
function isGuest(){ return !!S.guest; }
function myProfileId(){ return S.profile ? S.profile.id : null; }
function whoMatches(a){
  if(isGuest()) return a.guest_token === S.guest.token;
  return a.instructor_id === myProfileId();
}
function myName(){ return isGuest() ? S.guest.name : (S.profile ? S.profile.name : ''); }
function isAdmin(){ return !isGuest() && S.profile && S.profile.role==='admin'; }

/* ---------------- attendance actions ---------------- */
function findMyAttendance(ref, dateStr){
  return S.attendance.find(a=>{
    const sameSlot = ref.slot_id ? a.slot_id===ref.slot_id : a.extra_slot_id===ref.extra_slot_id;
    return sameSlot && a.date===dateStr && whoMatches(a);
  });
}

function isRecurringFor(slotId, instructorId){
  return S.recurring.some(r=>r.slot_id===slotId && r.instructor_id===instructorId);
}
function isMyRecurring(slotId){ return !isGuest() && isRecurringFor(slotId, myProfileId()); }

// stato "effettivo" per me su uno slot/data: riga esplicita se c'è, altrimenti presenza
// implicita se lo slot è marcato come ricorrente, altrimenti nessuno stato (non segnato).
function myAttendanceState(ref, dateStr){
  const row = findMyAttendance(ref, dateStr);
  if(row) return row.status; // 'presente' | 'assente'
  if(ref.slot_id && isMyRecurring(ref.slot_id)) return 'ricorrente';
  return null;
}

async function setAttendanceStatus(ref, dateStr, status){
  const existing = findMyAttendance(ref, dateStr);
  if(existing){
    S.attendance = S.attendance.map(a=> a.id===existing.id ? Object.assign({}, a, {status}) : a);
    render();
    const {error} = await sb.from('attendance').update({status}).eq('id', existing.id);
    if(error){ toast('Errore, riprova.'); await refreshWeekData(); }
  } else {
    const tempId = 'tmp_'+Math.random();
    const payload = Object.assign({date:dateStr, status}, ref,
      isGuest() ? {guest_token:S.guest.token, guest_name:S.guest.name} : {instructor_id:myProfileId()});
    S.attendance.push(Object.assign({id:tempId}, payload));
    render();
    const {data, error} = await sb.from('attendance').insert(payload).select().single();
    if(error){
      S.attendance = S.attendance.filter(a=>a.id!==tempId);
      toast('Errore, riprova.');
      render();
    } else {
      const idx = S.attendance.findIndex(a=>a.id===tempId);
      if(idx>=0) S.attendance[idx]=data;
    }
  }
}

async function clearAttendance(ref, dateStr){
  const existing = findMyAttendance(ref, dateStr);
  if(!existing) return;
  S.attendance = S.attendance.filter(a=>a.id!==existing.id);
  render();
  const {error} = await sb.from('attendance').delete().eq('id', existing.id);
  if(error){ toast('Errore, riprova.'); await refreshWeekData(); }
}

// ciclo al tocco: senza ricorrenza → non segnato → presente → assente → non segnato.
// con ricorrenza → presente (implicito) → assente (eccezione) → torna al ricorrente.
async function cycleAttendance(ref, dateStr){
  const state = myAttendanceState(ref, dateStr);
  if(state===null) return setAttendanceStatus(ref, dateStr, 'presente');
  if(state==='presente') return setAttendanceStatus(ref, dateStr, 'assente');
  if(state==='assente') return clearAttendance(ref, dateStr);
  if(state==='ricorrente') return setAttendanceStatus(ref, dateStr, 'assente');
}

async function toggleRecurring(slotId){
  if(isGuest()) return;
  const existing = S.recurring.find(r=>r.slot_id===slotId && r.instructor_id===myProfileId());
  if(existing){
    S.recurring = S.recurring.filter(r=>r.id!==existing.id);
    render();
    const {error} = await sb.from('recurring_presence').delete().eq('id', existing.id);
    if(error){ toast('Errore, riprova.'); await refreshWeekData(); }
    else toast('Presenza ricorrente disattivata.');
  } else {
    const tempId = 'tmp_'+Math.random();
    S.recurring.push({id:tempId, slot_id:slotId, instructor_id:myProfileId()});
    render();
    const {data, error} = await sb.from('recurring_presence').insert({slot_id:slotId, instructor_id:myProfileId()}).select().single();
    if(error){
      S.recurring = S.recurring.filter(r=>r.id!==tempId);
      toast('Errore, riprova.');
      render();
    } else {
      const idx = S.recurring.findIndex(r=>r.id===tempId);
      if(idx>=0) S.recurring[idx]=data;
      toast('Presenza ricorrente attivata: segnato "presente" ogni settimana su questo orario.');
    }
  }
}

async function addExtraSlot({date, start_time, end_time, label}){
  const payload = {calendar_id:S.selectedCalendarId, date, start_time, end_time, label: label||'Lezione extra'};
  if(!isGuest()) payload.created_by = myProfileId();
  const {error} = await sb.from('extra_slots').insert(payload);
  if(error){ toast('Errore aggiunta lezione extra.'); return; }
  closeModal();
  await refreshWeekData();
}

async function deleteExtraSlot(id){
  const {error} = await sb.from('extra_slots').delete().eq('id', id);
  if(error){ toast('Errore eliminazione.'); return; }
  await refreshWeekData();
}

/* ---------------- calendar/slot management (admin) ---------------- */
async function createCalendar(name, period){
  const {data, error} = await sb.from('calendars').insert({workspace_id:S.workspace.id, name, period}).select().single();
  if(error){ toast('Errore creazione calendario.'); return; }
  closeModal();
  await loadCalendars();
  S.selectedCalendarId = data.id;
  await refreshWeekData();
}

async function setActiveCalendar(id){
  const {error} = await sb.from('workspaces').update({active_calendar_id:id}).eq('id', S.workspace.id);
  if(error){ toast('Errore.'); return; }
  S.workspace.active_calendar_id = id;
  toast('Calendario impostato come attivo.');
  render();
}

async function scheduleCalendarChange(calendarId, date){
  if(!calendarId || !date){ toast('Scegli calendario e data.'); return; }
  const {error} = await sb.from('workspaces').update({scheduled_calendar_id:calendarId, scheduled_calendar_date:date}).eq('id', S.workspace.id);
  if(error){ toast('Errore programmazione.'); return; }
  S.workspace.scheduled_calendar_id = calendarId;
  S.workspace.scheduled_calendar_date = date;
  closeModal();
  toast('Cambio calendario programmato.');
  render();
}

async function cancelScheduledCalendarChange(){
  const {error} = await sb.from('workspaces').update({scheduled_calendar_id:null, scheduled_calendar_date:null}).eq('id', S.workspace.id);
  if(error){ toast('Errore.'); return; }
  S.workspace.scheduled_calendar_id = null;
  S.workspace.scheduled_calendar_date = null;
  toast('Programmazione annullata.');
  render();
}

// se una data programmata è arrivata (oggi o passata), attiva il calendario in coda.
// controllato lato client all'apertura dell'app (non c'è un backend con cron).
async function applyScheduledCalendarIfDue(){
  const ws = S.workspace;
  if(!ws || !ws.scheduled_calendar_id || !ws.scheduled_calendar_date) return;
  if(ws.scheduled_calendar_date > todayISO()) return;
  const targetId = ws.scheduled_calendar_id;
  const {error} = await sb.from('workspaces').update({active_calendar_id:targetId, scheduled_calendar_id:null, scheduled_calendar_date:null}).eq('id', ws.id);
  if(error) return;
  ws.active_calendar_id = targetId;
  ws.scheduled_calendar_id = null;
  ws.scheduled_calendar_date = null;
  S.selectedCalendarId = targetId;
  const cal = S.calendars.find(c=>c.id===targetId);
  toast(`Calendario cambiato automaticamente in "${cal ? cal.name : ''}".`);
}

async function deleteCalendar(id){
  const {error} = await sb.from('calendars').delete().eq('id', id);
  if(error){ toast('Errore eliminazione calendario.'); return; }
  if(S.selectedCalendarId===id) S.selectedCalendarId = null;
  await loadCalendars();
  if(!S.selectedCalendarId && S.calendars.length) S.selectedCalendarId = S.calendars[0].id;
  await refreshWeekData();
}

async function addSlot(calendarId, {weekday, start_time, end_time, label}){
  const {error} = await sb.from('slots').insert({calendar_id:calendarId, weekday:+weekday, start_time, end_time, label: label||'Lezione'});
  if(error){ toast('Errore aggiunta orario.'); return; }
  render.editingCalendarSlots = null;
  await loadSlotsForEditor(calendarId);
}
async function deleteSlot(id, calendarId){
  const {error} = await sb.from('slots').delete().eq('id', id);
  if(error){ toast('Errore.'); return; }
  await loadSlotsForEditor(calendarId);
}
async function loadSlotsForEditor(calendarId){
  const {data} = await sb.from('slots').select('*').eq('calendar_id', calendarId).order('weekday').order('start_time');
  S.modal.editSlots = data || [];
  if(calendarId===S.selectedCalendarId){
    await loadSlots();
    await loadExtraForWeek(mondayOf(S.weekOffset));
    await loadAttendanceForWeek(mondayOf(S.weekOffset));
  }
  render();
}

/* ---------------- instructors / invite / guest links (admin) ---------------- */
async function renameWorkspace(newName){
  const {error} = await sb.from('workspaces').update({name:newName}).eq('id', S.workspace.id);
  if(error){ toast('Errore rinomina spazio.'); return; }
  S.workspace.name = newName;
  const mw = S.myWorkspaces.find(w=>w.id===S.workspace.id);
  if(mw) mw.name = newName;
  toast('Spazio rinominato.');
  render();
}

async function deleteWorkspace(){
  const wsId = S.workspace.id;
  const {error} = await sb.from('workspaces').delete().eq('id', wsId);
  if(error){ toast('Errore eliminazione spazio.'); return; }
  S.myProfiles = S.myProfiles.filter(p=>p.workspace_id!==wsId);
  S.myWorkspaces = S.myWorkspaces.filter(w=>w.id!==wsId);
  if(S.myProfiles.length){
    await activateProfile(S.myProfiles[0], 'switch');
  } else {
    S.profile=null; S.workspace=null; S.view='no-workspace'; render();
  }
}

async function createFirstWorkspaceAfterOrphan(personName, wsName){
  if(!personName || !wsName){ toast('Inserisci nome e spazio.'); return; }
  const code = genCode(6);
  const {data:ws, error} = await sb.from('workspaces').insert({name:wsName, invite_code:code}).select().single();
  if(error){ toast('Errore creazione spazio.'); return; }
  const {error:e2} = await sb.from('profiles').insert({user_id:S.session.user.id, workspace_id:ws.id, name:personName, role:'admin'});
  if(e2){ toast('Errore creazione profilo.'); return; }
  const {data:prof, error:e3} = await sb.from('profiles').select('*').eq('user_id', S.session.user.id).eq('workspace_id', ws.id).single();
  if(e3){ toast('Errore lettura profilo.'); return; }
  S.myProfiles = [prof];
  S.myWorkspaces = [{id:ws.id, name:ws.name}];
  await activateProfile(prof, 'created');
}

async function regenerateInviteCode(){
  const code = genCode(6);
  const {error} = await sb.from('workspaces').update({invite_code:code}).eq('id', S.workspace.id);
  if(error){ toast('Errore.'); return; }
  S.workspace.invite_code = code;
  toast('Nuovo codice invito generato.');
  render();
}

async function removeInstructor(id){
  const {error} = await sb.from('profiles').delete().eq('id', id);
  if(error){ toast('Errore rimozione.'); return; }
  await loadInstructors();
}

async function setInstructorRole(id, role){
  const {error} = await sb.from('profiles').update({role}).eq('id', id);
  if(error){ toast('Errore.'); return; }
  toast(role==='admin' ? 'Ora è amministratore.' : 'Ora è istruttore.');
  await loadInstructors();
}

async function createGuestLink(label, hours){
  const token = genToken();
  const expires = new Date(Date.now() + hours*3600*1000).toISOString();
  const {error} = await sb.from('guest_links').insert({workspace_id:S.workspace.id, token, label, expires_at:expires, created_by: myProfileId()});
  if(error){ toast('Errore creazione link.'); return; }
  closeModal();
  await loadGuestLinks();
  const url = location.origin + location.pathname + '?g=' + token;
  openModal({type:'guestlink-created', url});
}

async function revokeGuestLink(id){
  const {error} = await sb.from('guest_links').delete().eq('id', id);
  if(error){ toast('Errore.'); return; }
  await loadGuestLinks();
}

/* ---------------- modal helpers ---------------- */
function openModal(m){ S.modal = m; render(); }
function closeModal(){ S.modal = null; render(); }

/* ================= RENDER ================= */
function render(){
  APP.innerHTML = '';
  if(S.view==='loading'){ APP.innerHTML = '<div class="spinner"></div>'; return; }
  if(S.view==='setup'){ APP.appendChild(renderSetup()); return; }
  if(S.view==='guestname'){ APP.appendChild(renderGuestName()); return; }
  if(S.view==='auth'){ APP.appendChild(renderAuth()); return; }
  if(S.view==='no-workspace'){ APP.appendChild(renderNoWorkspace()); return; }
  if(S.view==='app'){ APP.appendChild(renderShell()); return; }
}

function renderNoWorkspace(){
  const d = document.createElement('div');
  d.className = 'authwrap';
  d.innerHTML = `
    <div class="authbox">
      <div class="logo"><div class="mark">📋</div><h1>Nessuno spazio</h1><p>Crea un nuovo spazio per continuare a usare l'app.</p></div>
      <div class="card">
        <label class="field"><span>Il tuo nome</span><input type="text" id="nw_name2"></label>
        <label class="field"><span>Nome dello spazio</span><input type="text" id="nw_ws2"></label>
        <button class="btn block" id="nw_go2">Crea</button>
        <button class="btn ghost block" id="nw_out2" style="margin-top:8px">Esci</button>
      </div>
    </div>`;
  d.querySelector('#nw_go2').onclick = ()=> createFirstWorkspaceAfterOrphan(
    d.querySelector('#nw_name2').value.trim(), d.querySelector('#nw_ws2').value.trim());
  d.querySelector('#nw_out2').onclick = doLogout;
  return d;
}

function renderSetup(){
  const d = document.createElement('div');
  d.className = 'authwrap';
  d.innerHTML = `
    <div class="authbox card">
      <div class="logo"><div class="mark">📋</div><h1>Presencer</h1></div>
      <p>${S.setupMsg ? esc(S.setupMsg) : 'Per avviare l\'app, apri il file <b>config.js</b> e incolla URL e chiave anon del tuo progetto Supabase (vedi README.md per la guida passo passo).'}</p>
    </div>`;
  return d;
}

function renderGuestName(){
  const d = document.createElement('div');
  d.className = 'authwrap';
  const ready = !!S._guestLinkRow;
  d.innerHTML = `
    <div class="authbox">
      <div class="logo"><div class="mark">⚡</div><h1>Accesso rapido</h1><p>${ready ? esc(S._guestLinkRow.label||'Accesso rapido') : 'Verifica link in corso...'}</p></div>
      <div class="card">
        ${ready ? `
          <label class="field"><span>Come ti chiami?</span>
            <input type="text" id="gname" placeholder="Il tuo nome" autofocus>
          </label>
          <button class="btn block" id="gEnter">Entra</button>
          <p class="hint">Accesso temporaneo, senza password. Valido fino al ${new Date(S._guestLinkRow.expires_at).toLocaleString('it-IT')}.</p>
        ` : '<div class="spinner"></div>'}
      </div>
    </div>`;
  if(ready){
    d.querySelector('#gEnter').onclick = ()=> submitGuestName(d.querySelector('#gname').value);
    d.querySelector('#gname').addEventListener('keydown', e=>{ if(e.key==='Enter') submitGuestName(d.querySelector('#gname').value); });
  }
  return d;
}

function renderAuth(){
  const d = document.createElement('div');
  d.className = 'authwrap';
  const tab = S.authTab;
  d.innerHTML = `
    <div class="authbox">
      <div class="logo"><div class="mark">📋</div><h1>Presencer</h1><p>Organizza le presenze, in un attimo.</p></div>
      <div class="card">
        <div class="authtabs">
          <button data-t="login" class="${tab==='login'?'active':''}">Accedi</button>
          <button data-t="register" class="${tab==='register'?'active':''}">Crea spazio</button>
          <button data-t="join" class="${tab==='join'?'active':''}">Ho un codice</button>
        </div>
        ${S.authErr ? `<div class="errbox">${esc(S.authErr)}</div>` : ''}
        <div id="authform"></div>
      </div>
    </div>`;
  d.querySelectorAll('.authtabs button').forEach(b=> b.onclick = ()=>{ S.authTab=b.dataset.t; S.authErr=''; render(); });

  const form = d.querySelector('#authform');
  if(tab==='login'){
    form.innerHTML = `
      <label class="field"><span>Email</span><input type="email" id="a_email"></label>
      <label class="field"><span>Password</span><input type="password" id="a_pass"></label>
      <button class="btn block" id="a_go" ${S.busy?'disabled':''}>${S.busy?'Attendere...':'Accedi'}</button>`;
    form.querySelector('#a_go').onclick = ()=> doLogin(form.querySelector('#a_email').value.trim(), form.querySelector('#a_pass').value);
  } else if(tab==='register'){
    form.innerHTML = `
      <label class="field"><span>Il tuo nome</span><input type="text" id="a_name"></label>
      <label class="field"><span>Nome dello spazio (palestra, azienda, famiglia...)</span><input type="text" id="a_ws"></label>
      <label class="field"><span>Email</span><input type="email" id="a_email"></label>
      <label class="field"><span>Password</span><input type="password" id="a_pass"></label>
      <button class="btn block" id="a_go" ${S.busy?'disabled':''}>${S.busy?'Attendere...':'Crea il mio spazio'}</button>
      <p class="hint">Diventerai amministratore e potrai invitare gli altri con un codice.</p>`;
    form.querySelector('#a_go').onclick = ()=> doRegisterWorkspace(
      form.querySelector('#a_name').value.trim(), form.querySelector('#a_ws').value.trim(),
      form.querySelector('#a_email').value.trim(), form.querySelector('#a_pass').value);
  } else {
    form.innerHTML = `
      <label class="field"><span>Il tuo nome</span><input type="text" id="a_name"></label>
      <label class="field"><span>Codice invito</span><input type="text" id="a_code" style="text-transform:uppercase"></label>
      <label class="field"><span>Email</span><input type="email" id="a_email"></label>
      <label class="field"><span>Password</span><input type="password" id="a_pass"></label>
      <button class="btn block" id="a_go" ${S.busy?'disabled':''}>${S.busy?'Attendere...':'Entra nello spazio'}</button>`;
    form.querySelector('#a_go').onclick = ()=> doJoin(
      form.querySelector('#a_name').value.trim(), form.querySelector('#a_code').value.trim(),
      form.querySelector('#a_email').value.trim(), form.querySelector('#a_pass').value);
  }
  return d;
}

function renderShell(){
  const wrap = document.createElement('div');

  // topbar
  const top = document.createElement('header');
  top.className = 'topbar';
  const initials = (myName()||'?').trim().slice(0,1).toUpperCase();
  const myAvatar = !isGuest() && S.profile && S.profile.avatar_url;
  top.innerHTML = `
    <div class="avatar">${myAvatar ? `<img src="${esc(myAvatar)}" alt="">` : esc(initials)}</div>
    <div class="brand">${esc(S.workspace ? S.workspace.name : '')}${!isGuest() ? ' <span style="opacity:.6">▾</span>' : ''}
      <small>${isGuest() ? 'Accesso rapido · '+esc(S.guest.name) : esc(myName())+(isAdmin()?' · Admin':'')}</small>
    </div>`;
  if(!isGuest()){
    const brandEl = top.querySelector('.brand');
    brandEl.style.cursor = 'pointer';
    brandEl.onclick = ()=> openModal({type:'my-workspaces'});
  }
  wrap.appendChild(top);

  // main
  const main = document.createElement('main');
  if(S.tab==='presenze') main.appendChild(renderPresenze());
  if(S.tab==='calendari') main.appendChild(renderCalendari());
  if(S.tab==='istruttori') main.appendChild(renderIstruttori());
  if(S.tab==='profilo') main.appendChild(renderProfilo());
  wrap.appendChild(main);

  // tabbar
  const nav = document.createElement('nav');
  nav.className = 'tabbar';
  const tabs = [['presenze','✅','Presenze']];
  if(!isGuest() && isAdmin()) tabs.push(['calendari','🗓️','Calendari']);
  if(!isGuest() && isAdmin()) tabs.push(['istruttori','👥','Istruttori']);
  tabs.push(['profilo','👤', isGuest()?'Esci':'Profilo']);
  nav.innerHTML = tabs.map(([id,ic,lb])=>`<button data-tab="${id}" class="${S.tab===id?'active':''}"><span class="ic">${ic}</span>${lb}</button>`).join('');
  nav.querySelectorAll('button').forEach(b=> b.onclick = ()=>{
    S.tab=b.dataset.tab;
    if(S.tab==='istruttori'){ loadInstructors(); loadGuestLinks(); }
    render();
  });
  wrap.appendChild(nav);

  if(S.modal) wrap.appendChild(renderModal());
  if(S.toast){ const t=document.createElement('div'); t.className='toast'; t.textContent=S.toast; wrap.appendChild(t); }

  return wrap;
}

/* -------- Presenze tab -------- */
function renderPresenze(){
  const d = document.createElement('div');
  const monday = mondayOf(S.weekOffset);

  const calSelect = S.calendars.length ? `
    <select class="calpick" id="calpick">
      ${S.calendars.map(c=>`<option value="${c.id}" ${c.id===S.selectedCalendarId?'selected':''}>${esc(c.name)}</option>`).join('')}
    </select>` : '';

  d.innerHTML = `
    <div class="row between" style="margin-bottom:12px">
      <h1 style="margin:0">Presenze</h1>
      ${calSelect}
    </div>
    ${S.calendars.length===0 ? `
      <div class="card empty"><div class="big">🗓️</div>
        ${isAdmin() ? 'Nessun calendario ancora. Vai su <b>Calendari</b> per crearne uno.' : 'Nessun calendario è stato ancora creato per questo spazio.'}
      </div>` : `
      <div class="weeknav">
        <button class="arrow" id="wkPrev">‹</button>
        <div class="wk${S.navDir==='next'?' wk-in-right':S.navDir==='prev'?' wk-in-left':''}">${fmtRange(monday)}<small>${S.weekOffset===0?'Questa settimana':(S.weekOffset>0?'Tra '+S.weekOffset+' settiman'+(S.weekOffset>1?'e':'a'):S.weekOffset+' settimane fa')}</small></div>
        <button class="arrow" id="wkNext">›</button>
      </div>
      <div class="row" style="margin-bottom:14px">
        <button class="btn secondary sm" id="wkToday">Oggi</button>
        <button class="btn secondary sm" id="addExtraBtn">+ Lezione extra</button>
        <div class="segbtns" id="viewSeg">
          <button data-v="mine" class="${!S.showAllMatrix?'on':''}">Personale</button>
          <button data-v="all" class="${S.showAllMatrix?'on':''}">Tutti</button>
        </div>
      </div>
      <div id="daysHost"></div>
    `}
  `;

  if(S.calendars.length===0) return d;

  if(calSelect){
    d.querySelector('#calpick').onchange = async (e)=>{
      S.selectedCalendarId = e.target.value;
      await refreshWeekData();
    };
  }
  d.querySelector('#wkPrev').onclick = async ()=>{ S.weekOffset--; S.navDir='prev'; await refreshWeekData(); };
  d.querySelector('#wkNext').onclick = async ()=>{ S.weekOffset++; S.navDir='next'; await refreshWeekData(); };
  d.querySelector('#wkToday').onclick = async ()=>{
    S.navDir = S.weekOffset>0 ? 'prev' : S.weekOffset<0 ? 'next' : null;
    S.weekOffset=0; await refreshWeekData();
  };
  d.querySelector('#addExtraBtn').onclick = ()=> openModal({type:'add-extra', date: todayISO()});
  d.querySelectorAll('#viewSeg button').forEach(b=> b.onclick = async ()=>{
    const wantAll = b.dataset.v==='all';
    if(wantAll===S.showAllMatrix) return;
    S.showAllMatrix = wantAll;
    if(S.showAllMatrix && S.instructors.length===0) await loadInstructors();
    render();
  });

  const host = d.querySelector('#daysHost');
  const dates = weekDates(monday);
  dates.forEach(dt=>{
    host.appendChild(S.showAllMatrix ? renderDayMatrix(dt) : renderDayList(dt));
  });
  if(S.navDir==='next') host.classList.add('wk-in-right');
  else if(S.navDir==='prev') host.classList.add('wk-in-left');
  S.navDir = null;
  attachSwipeWeekNav(host);
  return d;
}

function attachSwipeWeekNav(el){
  let sx=null, sy=null, skip=false;
  el.addEventListener('touchstart', e=>{
    skip = !!e.target.closest('.matrixwrap');
    if(skip) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, {passive:true});
  el.addEventListener('touchend', e=>{
    if(skip || sx===null) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if(Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)*1.5){
      const forward = dx < 0;
      S.weekOffset += forward ? 1 : -1;
      S.navDir = forward ? 'next' : 'prev';
      refreshWeekData();
    }
  }, {passive:true});
}

function slotsForDate(dt){
  const wd = (dt.getDay()+6)%7;
  const dateStr = toISO(dt);
  const weekly = S.slots.filter(s=>s.weekday===wd).map(s=>({ref:{slot_id:s.id}, label:s.label, start:s.start_time, end:s.end_time, extra:false, id:s.id}));
  const extras = S.extraSlots.filter(e=>e.date===dateStr).map(e=>({ref:{extra_slot_id:e.id}, label:e.label, start:e.start_time, end:e.end_time, extra:true, id:e.id}));
  return weekly.concat(extras).sort((a,b)=> a.start.localeCompare(b.start));
}

function renderDayList(dt){
  const day = document.createElement('div');
  day.className = 'day';
  const dateStr = toISO(dt);
  const items = slotsForDate(dt);
  const isToday = dateStr===todayISO();
  day.innerHTML = `<h3 class="dayhead">${WEEKDAYS[(dt.getDay()+6)%7]} <span class="d">${fmtDayShort(dt)}${isToday?' · oggi':''}</span></h3>`;
  if(items.length===0){
    day.innerHTML += `<p class="hint" style="margin-bottom:12px">Nessuna lezione.</p>`;
    return day;
  }
  items.forEach(it=>{
    const state = myAttendanceState(it.ref, dateStr);
    const btnClass = state==='presente' ? 'on' : state==='assente' ? 'off' : state==='ricorrente' ? 'on rec' : '';
    const btnLabel = state==='presente' ? '✅ Presente' : state==='assente' ? '❌ Assente' : state==='ricorrente' ? '✅ Presente 🔁' : 'Segna presenza';
    const canRecur = !it.extra && !isGuest();
    const recurOn = canRecur && isMyRecurring(it.id);
    const row = document.createElement('div');
    row.className = 'slot' + (it.extra ? ' extra' : '');
    row.innerHTML = `
      <div class="time">${fmtHM(it.start)}<br>${fmtHM(it.end)}</div>
      <div class="info"><div class="lbl">${esc(it.label)}</div><div class="sub">${it.extra?'Lezione extra':'Ricorrente'}</div></div>
      ${canRecur ? `<button class="btn ghost sm recurbtn ${recurOn?'on':''}" title="Presente ogni settimana su questo orario">🔁</button>` : ''}
      <button class="togglebtn ${btnClass}">${btnLabel}</button>
      ${it.extra && (isAdmin() || S.profile) ? `<button class="btn ghost sm" data-del="${it.id}">✕</button>` : ''}
    `;
    row.querySelector('.togglebtn').onclick = ()=> cycleAttendance(it.ref, dateStr);
    const recurBtn = row.querySelector('.recurbtn');
    if(recurBtn) recurBtn.onclick = ()=> toggleRecurring(it.id);
    const delBtn = row.querySelector('[data-del]');
    if(delBtn) delBtn.onclick = ()=>{ if(confirm('Eliminare questa lezione extra?')) deleteExtraSlot(it.id); };
    day.appendChild(row);
  });
  return day;
}

function renderDayMatrix(dt){
  const day = document.createElement('div');
  day.className = 'day';
  const dateStr = toISO(dt);
  const items = slotsForDate(dt);
  const isToday = dateStr===todayISO();
  day.innerHTML = `<h3 class="dayhead">${WEEKDAYS[(dt.getDay()+6)%7]} <span class="d">${fmtDayShort(dt)}${isToday?' · oggi':''}</span></h3>`;
  if(items.length===0){ day.innerHTML += `<p class="hint" style="margin-bottom:12px">Nessuna lezione.</p>`; return day; }

  const people = (S.instructors.length ? S.instructors : [S.profile].filter(Boolean))
    .map(p=>({key:'p_'+p.id, name:p.name, avatar:p.avatar_url, guestCol:false, instructorId:p.id, match:a=>a.instructor_id===p.id}));
  const guestMap = new Map();
  S.attendance.forEach(a=>{ if(a.guest_token && !guestMap.has(a.guest_token)) guestMap.set(a.guest_token, a.guest_name||'Ospite'); });
  const guests = Array.from(guestMap, ([token,name])=>({key:'g_'+token, name, guestCol:true, match:a=>a.guest_token===token}));
  const cols = people.concat(guests);

  const wrapT = document.createElement('div'); wrapT.className='matrixwrap card';
  const colHead = c=>{
    const first = c.name.split(' ')[0] || '?';
    const avatarInner = c.avatar ? `<img src="${esc(c.avatar)}" alt="">` : esc(first.slice(0,1).toUpperCase());
    return `<th><div class="mhead-person"><span class="mavatar${c.guestCol?' guest':''}" style="background:${colorFor(c.key)}">${avatarInner}</span><span class="mname">${esc(first)}</span></div></th>`;
  };
  let html = `<table class="matrix"><thead><tr><th>Orario</th>${cols.map(colHead).join('')}</tr></thead><tbody>`;
  items.forEach(it=>{
    html += `<tr><td>${fmtHM(it.start)} ${esc(it.label)}</td>`;
    cols.forEach(c=>{
      const row = S.attendance.find(a=>{
        const sameSlot = it.ref.slot_id ? a.slot_id===it.ref.slot_id : a.extra_slot_id===it.ref.extra_slot_id;
        return sameSlot && a.date===dateStr && c.match(a);
      });
      let state = row ? row.status : null;
      if(!state && !c.guestCol && !it.extra && isRecurringFor(it.id, c.instructorId)) state = 'ricorrente';
      const cls = state==='presente' ? 'on' : state==='ricorrente' ? 'on rec' : state==='assente' ? 'off' : '';
      html += `<td><span class="mchip ${cls}"></span></td>`;
    });
    html += `</tr>`;
  });
  html += `</tbody></table>`;
  wrapT.innerHTML = html;
  if(cols.length>3){
    const hint = document.createElement('div');
    hint.className = 'matrixhint';
    hint.textContent = '← scorri per vedere tutti →';
    day.appendChild(hint);
  }
  day.appendChild(wrapT);
  return day;
}

/* -------- Calendari tab (admin) -------- */
function renderCalendari(){
  const d = document.createElement('div');
  d.innerHTML = `<div class="row between" style="margin-bottom:16px"><h1 style="margin:0">Calendari</h1><button class="btn sm" id="newCal">+ Nuovo</button></div>`;
  d.querySelector('#newCal').onclick = ()=> openModal({type:'new-calendar'});

  if(S.calendars.length===0){
    const empty = document.createElement('div');
    empty.className = 'card empty';
    empty.innerHTML = `<div class="big">🗓️</div>Crea il tuo primo calendario (es. Estate, Inverno, Extra).`;
    d.appendChild(empty);
    return d;
  }
  if(S.workspace.scheduled_calendar_id && S.workspace.scheduled_calendar_date){
    const target = S.calendars.find(c=>c.id===S.workspace.scheduled_calendar_id);
    const banner = document.createElement('div');
    banner.className = 'card';
    banner.style.background = '#FFF1E4';
    banner.innerHTML = `
      <div class="row between">
        <div><b>Cambio programmato</b><div class="hint" style="margin-top:2px">Il calendario attivo passerà a <b>${esc(target?target.name:'')}</b> il ${new Date(S.workspace.scheduled_calendar_date).toLocaleDateString('it-IT')}.</div></div>
        <button class="btn ghost sm" id="cancelSched">Annulla</button>
      </div>`;
    banner.querySelector('#cancelSched').onclick = ()=>{ if(confirm('Annullare il cambio calendario programmato?')) cancelScheduledCalendarChange(); };
    d.appendChild(banner);
  }
  S.calendars.forEach(c=>{
    const card = document.createElement('div');
    card.className = 'card';
    const active = S.workspace.active_calendar_id===c.id;
    card.innerHTML = `
      <div class="row between">
        <div><b>${esc(c.name)}</b> <span class="tag ${c.period}">${PERIOD_LABEL[c.period]||c.period}</span> ${active?'<span class="pill ok">Attivo</span>':''}</div>
      </div>
      <div class="row" style="margin-top:10px">
        ${!active?`<button class="btn secondary sm" data-act="mkactive">Rendi attivo</button>`:''}
        ${!active?`<button class="btn secondary sm" data-act="sched">Programma cambio</button>`:''}
        <button class="btn secondary sm" data-act="edit">Modifica orari</button>
        <button class="btn ghost sm" data-act="del">Elimina</button>
      </div>`;
    card.querySelector('[data-act="edit"]').onclick = ()=> openCalendarEditor(c);
    if(!active){
      card.querySelector('[data-act="mkactive"]').onclick = ()=> setActiveCalendar(c.id);
      card.querySelector('[data-act="sched"]').onclick = ()=> openModal({type:'schedule-calendar', calendarId:c.id});
    }
    card.querySelector('[data-act="del"]').onclick = ()=>{ if(confirm(`Eliminare "${c.name}" e tutti i suoi orari?`)) deleteCalendar(c.id); };
    d.appendChild(card);
  });
  return d;
}

async function openCalendarEditor(cal){
  S.modal = {type:'edit-calendar', calendar:cal, editSlots:[]};
  await loadSlotsForEditor(cal.id);
}

/* -------- Istruttori tab (admin) -------- */
function renderIstruttori(){
  const d = document.createElement('div');
  d.innerHTML = `<h1>Istruttori</h1>`;

  const nameCard = document.createElement('div');
  nameCard.className = 'card';
  nameCard.innerHTML = `
    <h3>Nome dello spazio</h3>
    <label class="field"><input type="text" id="wsNameInput" value="${esc(S.workspace.name)}"></label>
    <button class="btn secondary sm" id="wsNameSave">Salva nome</button>`;
  nameCard.querySelector('#wsNameSave').onclick = ()=>{
    const v = nameCard.querySelector('#wsNameInput').value.trim();
    if(!v) return toast('Il nome non può essere vuoto.');
    renameWorkspace(v);
  };
  d.appendChild(nameCard);

  const wsCard = document.createElement('div');
  wsCard.className = 'card';
  wsCard.innerHTML = `
    <h3>Codice invito</h3>
    <div class="copybox"><span id="codeTxt">${esc(S.workspace.invite_code)}</span></div>
    <div class="row" style="margin-top:10px">
      <button class="btn secondary sm" id="copyCode">Copia</button>
      <button class="btn ghost sm" id="regenCode">Genera nuovo codice</button>
    </div>
    <p class="hint">Chi vuole unirsi come istruttore inserisce questo codice nella scheda "Ho un codice" al primo accesso.</p>`;
  wsCard.querySelector('#copyCode').onclick = ()=>{ navigator.clipboard.writeText(S.workspace.invite_code); toast('Codice copiato.'); };
  wsCard.querySelector('#regenCode').onclick = ()=>{ if(confirm('Il vecchio codice smetterà di funzionare. Continuare?')) regenerateInviteCode(); };
  d.appendChild(wsCard);

  const listCard = document.createElement('div');
  listCard.className = 'card';
  listCard.innerHTML = `<h3>Membri (${S.instructors.length})</h3>`;
  S.instructors.forEach(p=>{
    const row = document.createElement('div');
    row.className = 'listrow';
    const av = p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="">` : esc((p.name||'?').trim().slice(0,1).toUpperCase());
    row.innerHTML = `<div class="avatar" style="width:36px;height:36px">${av}</div>
      <div class="main"><div class="t">${esc(p.name)}</div><div class="s">${p.role==='admin'?'Amministratore':'Istruttore'}</div></div>
      ${p.id!==S.profile.id ? `<button class="btn ghost sm" data-role>${p.role==='admin'?'Rendi istruttore':'Rendi admin'}</button>` : ''}
      ${(p.id!==S.profile.id && p.role!=='admin') ? `<button class="btn ghost sm" data-rm>Rimuovi</button>` : ''}`;
    const roleBtn = row.querySelector('[data-role]');
    if(roleBtn) roleBtn.onclick = ()=>{
      const next = p.role==='admin' ? 'instructor' : 'admin';
      const msg = next==='admin' ? `Rendere ${p.name} amministratore? Potrà modificare calendari, orari e membri.` : `Togliere i permessi di amministratore a ${p.name}?`;
      if(confirm(msg)) setInstructorRole(p.id, next);
    };
    const rm = row.querySelector('[data-rm]');
    if(rm) rm.onclick = ()=>{ if(confirm(`Rimuovere ${p.name} dallo spazio?`)) removeInstructor(p.id); };
    listCard.appendChild(row);
  });
  d.appendChild(listCard);

  const guestCard = document.createElement('div');
  guestCard.className = 'card';
  guestCard.innerHTML = `<div class="row between"><h3 style="margin:0">Accessi rapidi (usa e getta)</h3><button class="btn sm" id="newGuest">+ Genera link</button></div>`;
  guestCard.querySelector('#newGuest').onclick = ()=> openModal({type:'new-guestlink'});
  if(S.guestLinks.length===0){
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Nessun link attivo. Genera un link temporaneo per far segnare la presenza a qualcuno senza creargli un account.';
    guestCard.appendChild(hint);
  } else {
    S.guestLinks.forEach(g=>{
      const row = document.createElement('div');
      row.className = 'listrow';
      row.innerHTML = `<div class="main"><div class="t">${esc(g.label||'Accesso rapido')}</div><div class="s">Scade il ${new Date(g.expires_at).toLocaleString('it-IT')}</div></div>
        <button class="btn secondary sm" data-copy>Copia link</button>
        <button class="btn ghost sm" data-rv>Revoca</button>`;
      row.querySelector('[data-copy]').onclick = ()=>{ navigator.clipboard.writeText(location.origin+location.pathname+'?g='+g.token); toast('Link copiato.'); };
      row.querySelector('[data-rv]').onclick = ()=>{ if(confirm('Revocare questo link?')) revokeGuestLink(g.id); };
      guestCard.appendChild(row);
    });
  }
  d.appendChild(guestCard);

  const dangerCard = document.createElement('div');
  dangerCard.className = 'card';
  dangerCard.innerHTML = `
    <h3 style="color:var(--danger)">Zona pericolosa</h3>
    <p class="hint">Elimina definitivamente questo spazio: calendari, orari, presenze e accessi rapidi di tutti i membri andranno persi per sempre. Non si può annullare.</p>
    <button class="btn danger block" id="delWs">Elimina spazio "${esc(S.workspace.name)}"</button>`;
  dangerCard.querySelector('#delWs').onclick = ()=>{
    const typed = prompt(`Per confermare, scrivi esattamente il nome dello spazio: "${S.workspace.name}"`);
    if(typed === S.workspace.name) deleteWorkspace();
    else if(typed !== null) toast('Nome non corrispondente, spazio non eliminato.');
  };
  d.appendChild(dangerCard);
  return d;
}

/* -------- Profilo tab -------- */
function renderProfilo(){
  const d = document.createElement('div');
  if(isGuest()){
    d.innerHTML = `
      <h1>Accesso rapido</h1>
      <div class="card">
        <p><b>${esc(S.guest.name)}</b></p>
        <p class="hint">Accesso temporaneo su "${esc(S.workspace.name)}", valido fino al ${new Date(S.guest.expires_at).toLocaleString('it-IT')}.</p>
        <button class="btn danger block" id="out">Esci</button>
      </div>`;
    d.querySelector('#out').onclick = guestLogout;
    return d;
  }
  const email = S.session && S.session.user ? S.session.user.email : '';
  const avInner = S.profile.avatar_url ? `<img src="${esc(S.profile.avatar_url)}" alt="">` : esc((S.profile.name||'?').trim().slice(0,1).toUpperCase());
  d.innerHTML = `
    <h1>Profilo</h1>
    <div class="card">
      <div class="row" style="margin-bottom:14px">
        <div class="avatar" style="width:64px;height:64px;font-size:24px">${avInner}</div>
        <div class="col" style="gap:6px">
          <button class="btn secondary sm" id="p_avatar_go">Cambia foto</button>
          <input type="file" id="p_avatar_file" accept="image/*" class="hidden">
        </div>
      </div>
      <p><b>${esc(S.profile.name)}</b></p>
      <p class="hint">${S.profile.role==='admin'?'Amministratore':'Istruttore'} · ${esc(S.workspace.name)}</p>
      <button class="btn danger block" id="out" style="margin-top:14px">Esci</button>
    </div>
    <div class="card">
      <h3>I tuoi spazi</h3>
      <p class="hint">Puoi gestire più spazi (es. più palestre/aziende/famiglie) con lo stesso account.</p>
      <button class="btn secondary block" id="p_ws">Cambia o aggiungi spazio</button>
    </div>
    <div class="card">
      <h3>Cambia email</h3>
      <p class="hint" style="margin:0 0 10px">Attuale: ${esc(email)}</p>
      <label class="field"><span>Nuova email</span><input type="email" id="p_email"></label>
      <button class="btn secondary block" id="p_email_go">Aggiorna email</button>
      <p class="hint">Potrebbe arrivarti un’email di conferma prima che il cambio sia effettivo.</p>
    </div>
    <div class="card">
      <h3>Cambia password</h3>
      <label class="field"><span>Nuova password</span><input type="password" id="p_pass1"></label>
      <label class="field"><span>Conferma nuova password</span><input type="password" id="p_pass2"></label>
      <button class="btn secondary block" id="p_pass_go">Aggiorna password</button>
    </div>`;
  d.querySelector('#out').onclick = doLogout;
  d.querySelector('#p_ws').onclick = ()=> openModal({type:'my-workspaces'});
  d.querySelector('#p_avatar_go').onclick = ()=> d.querySelector('#p_avatar_file').click();
  d.querySelector('#p_avatar_file').onchange = e=>{
    const file = e.target.files[0];
    if(file) uploadAvatar(file);
  };
  d.querySelector('#p_email_go').onclick = ()=> doChangeEmail(d.querySelector('#p_email').value.trim());
  d.querySelector('#p_pass_go').onclick = ()=> doChangePassword(d.querySelector('#p_pass1').value, d.querySelector('#p_pass2').value);
  return d;
}

/* -------- Modal -------- */
function renderModal(){
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.onclick = (e)=>{ if(e.target===bg) closeModal(); };
  const box = document.createElement('div');
  box.className = 'modal';
  bg.appendChild(box);

  const m = S.modal;
  if(m.type==='add-extra'){
    box.innerHTML = `
      <div class="mhead"><h2>Lezione extra</h2><button id="x">✕</button></div>
      <label class="field"><span>Data</span><input type="date" id="m_date" value="${m.date}"></label>
      <label class="field"><span>Etichetta</span><input type="text" id="m_label" placeholder="Es. Lezione privata"></label>
      <div class="row">
        <label class="field grow"><span>Inizio</span><input type="time" id="m_start" value="18:00"></label>
        <label class="field grow"><span>Fine</span><input type="time" id="m_end" value="19:00"></label>
      </div>
      <button class="btn block" id="m_save">Aggiungi</button>`;
    box.querySelector('#m_save').onclick = ()=> addExtraSlot({
      date: box.querySelector('#m_date').value,
      label: box.querySelector('#m_label').value,
      start_time: box.querySelector('#m_start').value,
      end_time: box.querySelector('#m_end').value,
    });
  }

  else if(m.type==='new-calendar'){
    box.innerHTML = `
      <div class="mhead"><h2>Nuovo calendario</h2><button id="x">✕</button></div>
      <label class="field"><span>Nome</span><input type="text" id="m_name" placeholder="Es. Estate 2026"></label>
      <label class="field"><span>Periodo</span>
        <select id="m_period">
          <option value="estate">Estate</option>
          <option value="inverno">Inverno</option>
          <option value="extra">Extra</option>
          <option value="personalizzato" selected>Personalizzato</option>
        </select>
      </label>
      <button class="btn block" id="m_save">Crea</button>`;
    box.querySelector('#m_save').onclick = ()=>{
      const name = box.querySelector('#m_name').value.trim();
      if(!name) return toast('Inserisci un nome.');
      createCalendar(name, box.querySelector('#m_period').value);
    };
  }

  else if(m.type==='schedule-calendar'){
    box.innerHTML = `
      <div class="mhead"><h2>Programma cambio calendario</h2><button id="x">✕</button></div>
      <p class="hint" style="margin:0 0 12px">Alla data scelta, questo calendario diventerà automaticamente quello attivo (al primo accesso all'app di un membro dello spazio da quella data in poi).</p>
      <label class="field"><span>Data del cambio</span><input type="date" id="s_date" value="${todayISO()}"></label>
      <button class="btn block" id="s_save">Programma</button>`;
    box.querySelector('#s_save').onclick = ()=> scheduleCalendarChange(m.calendarId, box.querySelector('#s_date').value);
  }

  else if(m.type==='edit-calendar'){
    const cal = m.calendar;
    box.innerHTML = `
      <div class="mhead"><h2>${esc(cal.name)}</h2><button id="x">✕</button></div>
      <h3>Orari settimanali</h3>
      <div id="slotList" class="col" style="margin-bottom:14px"></div>
      <div class="row">
        <select id="ns_day">${WEEKDAYS.map((w,i)=>`<option value="${i}">${w}</option>`).join('')}</select>
        <input type="time" id="ns_start" value="18:00" style="max-width:110px">
        <input type="time" id="ns_end" value="19:00" style="max-width:110px">
      </div>
      <label class="field" style="margin-top:8px"><span>Etichetta</span><input type="text" id="ns_label" placeholder="Es. Corso adulti"></label>
      <button class="btn block" id="ns_add">+ Aggiungi orario</button>`;
    const list = box.querySelector('#slotList');
    (m.editSlots||[]).forEach(s=>{
      const row = document.createElement('div');
      row.className = 'listrow';
      row.innerHTML = `<div class="main"><div class="t">${WEEKDAYS[s.weekday]} ${fmtHM(s.start_time)}–${fmtHM(s.end_time)}</div><div class="s">${esc(s.label)}</div></div>
        <button class="btn ghost sm" data-del>✕</button>`;
      row.querySelector('[data-del]').onclick = ()=> deleteSlot(s.id, cal.id);
      list.appendChild(row);
    });
    if(!(m.editSlots||[]).length) list.innerHTML = `<p class="hint">Nessun orario ancora.</p>`;
    box.querySelector('#ns_add').onclick = ()=> addSlot(cal.id, {
      weekday: box.querySelector('#ns_day').value,
      start_time: box.querySelector('#ns_start').value,
      end_time: box.querySelector('#ns_end').value,
      label: box.querySelector('#ns_label').value,
    });
  }

  else if(m.type==='new-guestlink'){
    box.innerHTML = `
      <div class="mhead"><h2>Nuovo accesso rapido</h2><button id="x">✕</button></div>
      <label class="field"><span>Etichetta (facoltativa)</span><input type="text" id="g_label" placeholder="Es. Sostituto di martedì"></label>
      <label class="field"><span>Valido per</span>
        <div class="segbtns" id="g_dur">
          <button data-h="24" class="on">1 giorno</button>
          <button data-h="72">3 giorni</button>
          <button data-h="168">7 giorni</button>
        </div>
      </label>
      <button class="btn block" id="g_save">Genera link</button>`;
    let hours = 24;
    box.querySelectorAll('#g_dur button').forEach(b=> b.onclick = ()=>{
      box.querySelectorAll('#g_dur button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on'); hours = +b.dataset.h;
    });
    box.querySelector('#g_save').onclick = ()=> createGuestLink(box.querySelector('#g_label').value.trim(), hours);
  }

  else if(m.type==='guestlink-created'){
    box.innerHTML = `
      <div class="mhead"><h2>Link pronto ✅</h2><button id="x">✕</button></div>
      <p class="hint">Condividi questo link: chi lo apre inserisce il proprio nome ed entra subito, senza account.</p>
      <div class="copybox">${esc(m.url)}</div>
      <button class="btn block" id="cp" style="margin-top:12px">Copia link</button>`;
    box.querySelector('#cp').onclick = ()=>{ navigator.clipboard.writeText(m.url); toast('Link copiato.'); };
  }

  else if(m.type==='my-workspaces'){
    const wsName = id => (S.myWorkspaces.find(w=>w.id===id)||{}).name || '...';
    box.innerHTML = `
      <div class="mhead"><h2>I tuoi spazi</h2><button id="x">✕</button></div>
      <div id="wsList" class="col" style="margin-bottom:16px"></div>
      <div class="row">
        <button class="btn secondary sm" id="wsNew">+ Crea nuovo spazio</button>
        <button class="btn secondary sm" id="wsJoin">Entra con un codice</button>
      </div>`;
    const list = box.querySelector('#wsList');
    S.myProfiles.forEach(p=>{
      const row = document.createElement('div');
      row.className = 'listrow';
      const active = S.profile && p.id===S.profile.id;
      row.innerHTML = `<div class="main"><div class="t">${esc(wsName(p.workspace_id))} ${active?'<span class="pill ok">Attivo</span>':''}</div><div class="s">${p.role==='admin'?'Amministratore':'Istruttore'}</div></div>
        ${!active?'<button class="btn secondary sm" data-sw>Entra</button>':''}`;
      const sw = row.querySelector('[data-sw]');
      if(sw) sw.onclick = ()=>{ closeModal(); activateProfile(p, 'switch'); };
      list.appendChild(row);
    });
    box.querySelector('#wsNew').onclick = ()=> openModal({type:'new-workspace'});
    box.querySelector('#wsJoin').onclick = ()=> openModal({type:'join-workspace'});
  }

  else if(m.type==='new-workspace'){
    box.innerHTML = `
      <div class="mhead"><h2>Nuovo spazio</h2><button id="x">✕</button></div>
      <label class="field"><span>Nome dello spazio</span><input type="text" id="nw_name" placeholder="Es. Palestra Sud"></label>
      <button class="btn block" id="nw_go">Crea</button>
      <p class="hint">Diventerai amministratore di questo nuovo spazio, in aggiunta a quelli che hai già.</p>`;
    box.querySelector('#nw_go').onclick = ()=> createAdditionalWorkspace(box.querySelector('#nw_name').value.trim());
  }

  else if(m.type==='join-workspace'){
    box.innerHTML = `
      <div class="mhead"><h2>Entra con un codice</h2><button id="x">✕</button></div>
      <label class="field"><span>Codice invito</span><input type="text" id="jw_code" style="text-transform:uppercase"></label>
      <button class="btn block" id="jw_go">Entra</button>`;
    box.querySelector('#jw_go').onclick = ()=> joinAdditionalWorkspace(box.querySelector('#jw_code').value.trim());
  }

  box.querySelector('#x').onclick = closeModal;
  return bg;
}

boot();
